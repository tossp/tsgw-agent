import assert from "node:assert/strict";
import test, { after } from "node:test";
import net from "node:net";
import {
  AgentTracer, Sentry, markEnvelopes, settleSpans,
  makeSession, makeModel, usage, assistantMessage, streamFunction,
  createAssistantMessageEventStream, tick, spansSince, attrs, agentSpans, modelSpans,
} from "./tracer-fixture.mjs";

const connect = net.Socket.prototype.connect;
const fetch = globalThis.fetch;
net.Socket.prototype.connect = function () { throw new Error("offline test: network forbidden"); };
globalThis.fetch = () => { throw new Error("offline test: fetch forbidden"); };
after(async () => {
  await Sentry.close(2000);
  net.Socket.prototype.connect = connect;
  globalThis.fetch = fetch;
});

test("background naming overlaps main requests, finishes after settled, and never inherits a run or routing conversation", async () => {
  const mark = markEnvelopes();
  const id = "conversation-with-background-title";
  const routingId = `${id}-title`;
  const streams = Array.from({ length: 3 }, () => createAssistantMessageEventStream());
  const calls = [];
  const session = makeSession((_model, _context, options) => {
    calls.push(options);
    return streams[calls.length - 1];
  }, id);
  const tracer = new AgentTracer(session);
  const final = assistantMessage();
  try {
    tracer.onEvent({ type: "agent_start" });
    // Real SDK main routing ID, then its separate naming routing ID.
    assert.equal(session.agent.streamFunction(makeModel(), { messages: [] }, { sessionId: id }), streams[0]);
    assert.equal(session.agent.streamFunction(makeModel(), { messages: [] }, { sessionId: routingId }), streams[1]);
    // Legacy/extension calls without sessionId still belong to the active run,
    // even if a compaction event arrives while naming is pending.
    tracer.onEvent({ type: "compaction_start" });
    assert.equal(session.agent.streamFunction(makeModel(), { messages: [] }, {}), streams[2]);
    streams[0].end(final); streams[2].end(final);
    await Promise.all([streams[0].result(), streams[2].result()]);
    await tick();
    tracer.onEvent({ type: "message_end", message: final });
    tracer.onEvent({ type: "agent_settled" });
    await settleSpans();
    const beforeNamingEnds = spansSince(mark);
    assert.equal(agentSpans(beforeNamingEnds).length, 1);
    assert.equal(modelSpans(beforeNamingEnds).length, 2, "pending naming has not emitted a finished span");
    const [root] = agentSpans(beforeNamingEnds);
    assert.equal(root.parent_span_id, undefined);
    assert.equal(root.status, "ok");
    assert.equal(attrs(root)["tsgw.outcome"], "success");
    assert.ok(attrs(root)["tsgw.run.id"]);
    const mainModels = modelSpans(beforeNamingEnds);
    for (const span of mainModels) {
      assert.equal(span.parent_span_id, root.span_id);
      assert.equal(span.trace_id, root.trace_id);
      assert.equal(attrs(span)["tsgw.run.id"], attrs(root)["tsgw.run.id"]);
      assert.equal(attrs(span)["tsgw.request.kind"], "model");
    }
    await tick(10);
    // Late auxiliary failure cannot change the settled main run's success.
    const failedTitle = assistantMessage({ stopReason: "error" });
    streams[1].end(failedTitle);
    assert.equal(await streams[1].result(), failedTitle);
    await tick();
    tracer.onEvent({ type: "compaction_end" });
    await settleSpans();
    const spans = spansSince(mark);
    assert.equal(spans.length, 4);
    assert.equal(agentSpans(spans).length, 1);
    const auxiliary = modelSpans(spans).filter((span) => attrs(span)["tsgw.request.kind"] === "auxiliary");
    assert.equal(auxiliary.length, 1);
    const [naming] = auxiliary;
    assert.equal(naming.parent_span_id, undefined);
    assert.equal(naming.is_segment, true);
    assert.equal(root.name, "invoke_agent TSGW Agent");
    assert.equal(attrs(root)["sentry.segment.name"], root.name);
    assert.equal(naming.name, "chat faux-model");
    assert.equal(attrs(naming)["sentry.segment.name"], naming.name);
    for (const span of mainModels) assert.equal(attrs(span)["sentry.segment.name"], root.name);
    assert.notEqual(naming.trace_id, root.trace_id);
    assert.equal(attrs(naming)["tsgw.run.id"], undefined);
    assert.equal(attrs(naming)["tsgw.outcome"], "error");
    assert.equal(naming.status, "error");
    assert.ok(naming.start_timestamp <= root.end_timestamp);
    assert.ok(naming.end_timestamp > root.end_timestamp);
    for (const span of spans) assert.equal(attrs(span)["gen_ai.conversation.id"], id);
    assert.deepEqual(calls, [{ sessionId: id }, { sessionId: routingId }, {}]);
  } finally {
    streams.forEach((stream) => stream.end(final));
    tracer.dispose();
  }
});

test("tier-only nonzero rates preserve estimated cost; a nonzero tier threshold alone is not pricing", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ usage: usage({ input: 201, output: 9, cost: { total: 0.123 } }) });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  try {
    tracer.onEvent({ type: "agent_start" });
    for (const rates of [
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]) {
      const model = makeModel({ cost: { tiers: [{ inputTokensAbove: 200, ...rates }] } });
      const stream = session.agent.streamFunction(model, { messages: [] }, { sessionId: session.sessionId });
      await stream.result(); await tick();
    }
    tracer.onEvent({ type: "agent_settled" }); await settleSpans();
    const models = modelSpans(spansSince(mark));
    assert.equal(models.length, 2);
    assert.equal(attrs(models[0])["gen_ai.cost.total_tokens"], 0.123);
    assert.equal(attrs(models[1])["gen_ai.cost.total_tokens"], undefined);
    assert.equal(attrs(agentSpans(spansSince(mark))[0])["gen_ai.cost.total_tokens"], undefined);
  } finally { tracer.dispose(); }
});

test("reasoning and long-cache-write tokens are subsets, not additional usage", async () => {
  const mark = markEnvelopes();
  const messageUsage = usage({ input: 11, output: 17, cacheRead: 5, cacheWrite: 3,
    reasoning: 13, cacheWrite1h: 2, totalTokens: 36 });
  assert.equal(messageUsage.reasoning, 13, "fixture must preserve SDK optional usage fields");
  assert.equal(messageUsage.cacheWrite1h, 2);
  const final = assistantMessage({ usage: messageUsage });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  try {
    tracer.onEvent({ type: "agent_start" });
    await session.agent.streamFunction(makeModel(), { messages: [] }, {}).result();
    await tick(); tracer.onEvent({ type: "agent_settled" }); await settleSpans();
    const models = modelSpans(spansSince(mark));
    assert.equal(models.length, 1);
    const values = attrs(models[0]);
    assert.equal(values["gen_ai.usage.input_tokens"], 19);
    assert.equal(values["gen_ai.usage.output_tokens"], 17);
    assert.equal(values["gen_ai.usage.total_tokens"], 36);
    assert.equal(values["gen_ai.usage.cache_read.input_tokens"], 5);
    assert.equal(values["gen_ai.usage.cache_creation.input_tokens"], 3);
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
      assert.equal(attrs(agentSpans(spansSince(mark))[0])[`gen_ai.usage.${key}`], undefined);
    }
  } finally { tracer.dispose(); }
});
