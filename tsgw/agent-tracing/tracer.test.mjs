import assert from "node:assert/strict";
import test, { after } from "node:test";
import net from "node:net";
import { hostname } from "node:os";
import {
  AgentTracer, Sentry, markEnvelopes, settleSpans,
  makeSession, makeModel, pricedModel, usage, assistantMessage, streamFunction,
  createAssistantMessageEventStream, tick, spansSince, errorEventsSince,
  attrs, agentSpans, modelSpans, toolSpans, durationMs,
} from "./tracer-fixture.mjs";

// Fail closed: neither a provider nor a telemetry transport may reach the network.
const connect = net.Socket.prototype.connect;
const fetch = globalThis.fetch;
net.Socket.prototype.connect = function () { throw new Error("offline test: network forbidden"); };
globalThis.fetch = () => { throw new Error("offline test: fetch forbidden"); };
after(async () => {
  await Sentry.close(2000);
  net.Socket.prototype.connect = connect;
  globalThis.fetch = fetch;
});

function start(tracer) { tracer.onEvent({ type: "agent_start" }); }
function settle(tracer, extra = {}) { tracer.onEvent({ type: "agent_settled", ...extra }); }
function toolStart(tracer, toolCallId, toolName = "read", extra = {}) {
  tracer.onEvent({ type: "tool_execution_start", toolCallId, toolName, ...extra });
}
function toolEnd(tracer, toolCallId, extra = {}) {
  tracer.onEvent({ type: "tool_execution_end", toolCallId, ...extra });
}
async function request(session, message = assistantMessage(), model = pricedModel(), options = {}) {
  const stream = await session.agent.streamFunction(model, { messages: [] }, options);
  assert.equal(await stream.result(), message);
  await tick();
  return stream;
}
function childOf(child, parent) {
  assert.equal(child.trace_id, parent.trace_id);
  assert.equal(child.parent_span_id, parent.span_id);
}
function outcome(span, expected) {
  assert.equal(attrs(span)["tsgw.outcome"], expected);
  // SDK 11.9 streamed spans encode the native `cancelled` status as `ok`;
  // cancellation remains explicit in outcome/error.type (checked below).
  assert.equal(span.status, ["success", "cancelled"].includes(expected) ? "ok" : "error");
}

// Every assertion below reads the actual transport envelopes, not mocked spans.
test("run hierarchy, cached usage and model duration exclude tool time; agent_end is not settled", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ usage: usage({ input: 11, output: 7, cacheRead: 5, cacheWrite: 3,
    cost: { total: 0.0123 } }) });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session, { parentSessionId: "parent-session", agentName: "worker" });
  try {
    start(tracer);
    await request(session, final);
    toolStart(tracer, "tool-a");
    await tick(60);
    toolEnd(tracer, "tool-a");
    tracer.onEvent({ type: "agent_end" });
    start(tracer); // low-level retry/continuation must not create a second root
    settle(tracer);
    await settleSpans();
    const spans = spansSince(mark);
    const [root] = agentSpans(spans);
    const [model] = modelSpans(spans);
    const [tool] = toolSpans(spans);
    assert.equal(spans.length, 3);
    assert.equal(agentSpans(spans).length, 1);
    assert.equal(root.name, "invoke_agent worker");
    assert.equal(model.name, "chat faux-model");
    assert.equal(tool.name, "execute_tool read");
    for (const span of spans) {
      assert.equal(attrs(span)["sentry.segment.name"], root.name);
      assert.equal(attrs(span).instance, hostname());
    }
    childOf(model, root); childOf(tool, root);
    assert.notEqual(tool.parent_span_id, model.span_id);
    assert.ok(model.end_timestamp <= tool.start_timestamp);
    assert.ok(durationMs(tool) >= 45);
    assert.ok(durationMs(root) - durationMs(model) >= 45);
    assert.equal(attrs(root)["tsgw.parent_session_id"], "parent-session");
    assert.equal(attrs(root)["gen_ai.agent.name"], "worker");
    assert.equal(attrs(model)["tsgw.run.id"], attrs(root)["tsgw.run.id"]);
    for (const [key, value] of Object.entries({ input_tokens: 19, output_tokens: 7, total_tokens: 26,
      "cache_read.input_tokens": 5, "cache_creation.input_tokens": 3 })) {
      assert.equal(attrs(model)[`gen_ai.usage.${key}`], value);
    }
    assert.equal(attrs(model)["gen_ai.cost.total_tokens"], 0.0123);
    for (const span of spans) outcome(span, "success");
  } finally { tracer.dispose(); }
});

test("stream receiver/parameters/identity/iteration and repeated result retain SDK semantics", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const stream = createAssistantMessageEventStream();
  const originalResult = stream.result.bind(stream);
  const originalIterator = stream[Symbol.asyncIterator].bind(stream);
  let resultCalls = 0;
  let iterations = 0;
  stream.result = () => { resultCalls++; return originalResult(); };
  stream[Symbol.asyncIterator] = () => { iterations++; return originalIterator(); };
  const model = makeModel();
  const context = { messages: [{ role: "user", content: "prompt" }] };
  const options = { headers: { "x-test": "header" }, temperature: 0.4 };
  const session = makeSession(function (...args) {
    assert.equal(this, session.agent);
    assert.deepEqual(args, [model, context, options]);
    assert.equal(args[0], model); assert.equal(args[1], context); assert.equal(args[2], options);
    return stream;
  });
  const tracer = new AgentTracer(session);
  try {
    start(tracer);
    const returned = session.agent.streamFunction(model, context, options);
    assert.equal(returned, stream);
    assert.equal(iterations, 0, "tracer must not consume stream");
    assert.equal(resultCalls, 1, "one observation of the original result");
    const event = { type: "text_delta", contentIndex: 0, delta: "hello", partial: final };
    stream.push(event); stream.end(final);
    const seen = [];
    for await (const entry of returned) seen.push(entry);
    assert.deepEqual(seen, [event]);
    assert.equal(await returned.result(), final);
    assert.equal(await returned.result(), final);
    assert.equal(iterations, 1);
    await tick(); settle(tracer); await settleSpans();
    assert.equal(modelSpans(spansSince(mark)).length, 1);
  } finally { tracer.dispose(); }
});

test("async stream factories preserve returned stream and finish once", async () => {
  const mark = markEnvelopes();
  const stream = createAssistantMessageEventStream();
  const final = assistantMessage();
  const session = makeSession(async () => stream);
  const tracer = new AgentTracer(session);
  try {
    start(tracer);
    assert.equal(await session.agent.streamFunction(makeModel(), { messages: [] }, {}), stream);
    stream.end(final);
    assert.equal(await stream.result(), final);
    await tick(); settle(tracer); await settleSpans();
    assert.equal(modelSpans(spansSince(mark)).length, 1);
  } finally { tracer.dispose(); }
});

test("concurrent sessions are isolated even under an ambient span", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
  const sessions = streams.map((stream, index) => makeSession(() => stream, `concurrent-${index}`));
  const tracers = sessions.map((session) => new AgentTracer(session));
  const ambient = Sentry.startInactiveSpan({ name: "ambient", op: "http.server" });
  try {
    await Sentry.withActiveSpan(ambient, async () => {
      tracers.forEach(start);
      sessions.forEach((session) => session.agent.streamFunction(makeModel(), { messages: [] }, {}));
      toolStart(tracers[0], "a"); toolStart(tracers[1], "b");
      streams[1].end(final); streams[0].end(final);
      await tick();
      toolEnd(tracers[1], "b"); toolEnd(tracers[0], "a");
      tracers.forEach((tracer) => settle(tracer));
    });
    ambient.end(); await settleSpans();
    const spans = spansSince(mark);
    const roots = agentSpans(spans);
    assert.equal(roots.length, 2);
    assert.notEqual(roots[0].trace_id, roots[1].trace_id);
    for (const root of roots) {
      assert.equal(root.parent_span_id, undefined);
      assert.notEqual(root.trace_id, ambient.spanContext().traceId);
      const own = spans.filter((span) => attrs(span)["gen_ai.conversation.id"] === attrs(root)["gen_ai.conversation.id"]);
      assert.equal(own.length, 3);
      own.filter((span) => span !== root).forEach((span) => childOf(span, root));
    }
  } finally { tracers.forEach((tracer) => tracer.dispose()); }
});

test("multiple logical turns keep conversation id but use distinct traces and run ids", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const session = makeSession(streamFunction(final), "same-conversation");
  const tracer = new AgentTracer(session);
  try {
    for (let turn = 0; turn < 2; turn++) {
      start(tracer); await request(session, final); settle(tracer);
    }
    await settleSpans();
    const spans = spansSince(mark);
    const roots = agentSpans(spans);
    assert.equal(roots.length, 2);
    assert.equal(new Set(roots.map((span) => span.trace_id)).size, 2);
    assert.equal(new Set(roots.map((span) => attrs(span)["tsgw.run.id"])).size, 2);
    for (const root of roots) {
      assert.equal(attrs(root)["gen_ai.conversation.id"], "same-conversation");
      const models = modelSpans(spans).filter((span) => span.trace_id === root.trace_id);
      assert.equal(models.length, 1); childOf(models[0], root);
    }
  } finally { tracer.dispose(); }
});

test("retry failure remains visible while recovered logical run succeeds", async () => {
  const mark = markEnvelopes();
  const failed = assistantMessage({ stopReason: "error", errorMessage: "retryable failure" });
  const recovered = assistantMessage();
  let next = failed;
  const session = makeSession((...args) => streamFunction(next)(...args));
  const tracer = new AgentTracer(session);
  try {
    start(tracer); await request(session, failed);
    tracer.onEvent({ type: "message_end", message: failed });
    tracer.onEvent({ type: "agent_end" });
    tracer.onEvent({ type: "auto_retry_start" });
    start(tracer); next = recovered; await request(session, recovered);
    tracer.onEvent({ type: "message_end", message: recovered });
    settle(tracer); await settleSpans();
    const spans = spansSince(mark);
    assert.equal(agentSpans(spans).length, 1);
    const [root] = agentSpans(spans);
    outcome(root, "success"); assert.equal(attrs(root)["tsgw.retry.count"], 1);
    assert.equal(modelSpans(spans).length, 2);
    outcome(modelSpans(spans)[0], "error"); outcome(modelSpans(spans)[1], "success");
    modelSpans(spans).forEach((span) => childOf(span, root));
  } finally { tracer.dispose(); }
});

test("stopReason failure and top-level tool isError determine final span outcomes", async () => {
  const mark = markEnvelopes();
  const failed = assistantMessage({ stopReason: "error" });
  const session = makeSession(streamFunction(failed));
  const tracer = new AgentTracer(session);
  try {
    start(tracer);
    await request(session, failed);
    tracer.onEvent({ type: "message_end", message: failed });
    toolStart(tracer, "bad", "read");
    toolEnd(tracer, "bad", { isError: true, result: { isError: false } });
    toolStart(tracer, "good", "read");
    toolEnd(tracer, "good", { isError: false, result: { isError: true } });
    settle(tracer); await settleSpans();
    const spans = spansSince(mark);
    outcome(agentSpans(spans)[0], "error"); outcome(modelSpans(spans)[0], "error");
    const tools = toolSpans(spans);
    outcome(tools.find((span) => attrs(span)["tsgw.tool.call_id"] === "bad"), "error");
    outcome(tools.find((span) => attrs(span)["tsgw.tool.call_id"] === "good"), "success");
  } finally { tracer.dispose(); }
});

test("cancelled result and explicit aborted settlement produce cancelled status", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ stopReason: "aborted" });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  try {
    start(tracer); await request(session, final);
    tracer.onEvent({ type: "message_end", message: final });
    settle(tracer, { aborted: true }); await settleSpans();
    const spans = spansSince(mark);
    assert.equal(spans.length, 2);
    spans.forEach((span) => { outcome(span, "cancelled"); assert.equal(attrs(span)["error.type"], "cancelled"); });
  } finally { tracer.dispose(); }
});

test("dispose interrupts pending model/tool/run once and restores original without overwriting later extensions", async () => {
  const mark = markEnvelopes();
  const stream = createAssistantMessageEventStream();
  const original = () => stream;
  const session = makeSession(original);
  const tracer = new AgentTracer(session);
  start(tracer);
  session.agent.streamFunction(makeModel(), { messages: [] }, {});
  toolStart(tracer, "pending");
  tracer.dispose(); tracer.dispose();
  assert.equal(session.agent.streamFunction, original);
  stream.end(assistantMessage()); await tick();
  start(tracer); settle(tracer); await settleSpans();
  const spans = spansSince(mark);
  assert.equal(spans.length, 3);
  spans.forEach((span) => outcome(span, "interrupted"));
  const second = new AgentTracer(session);
  const extension = () => stream;
  session.agent.streamFunction = extension; second.dispose();
  assert.equal(session.agent.streamFunction, extension);
});

test("out-of-run summary/compaction request is a fresh root, not ambient HTTP or previous run", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  const ambient = Sentry.startInactiveSpan({ name: "ambient summary", op: "http.server" });
  try {
    start(tracer); settle(tracer);
    tracer.onEvent({ type: "compaction_start" });
    await Sentry.withActiveSpan(ambient, () => request(session, final, pricedModel(), {
      sessionId: `${session.sessionId}-compaction`,
    }));
    tracer.onEvent({ type: "compaction_end" });
    ambient.end(); await settleSpans();
    const spans = spansSince(mark);
    const [summary] = modelSpans(spans);
    assert.equal(summary.parent_span_id, undefined);
    assert.equal(summary.is_segment, true);
    assert.equal(summary.name, "chat faux-model");
    assert.equal(attrs(summary)["sentry.segment.name"], summary.name);
    assert.equal(attrs(summary)["tsgw.request.kind"], "auxiliary");
    assert.equal(attrs(summary)["tsgw.run.id"], undefined);
    assert.notEqual(summary.trace_id, ambient.spanContext().traceId);
    assert.notEqual(summary.trace_id, agentSpans(spans)[0].trace_id);
  } finally { tracer.dispose(); }
});

test("nested tools use parentToolCallId, independent siblings and missing-parent fallback", async () => {
  const mark = markEnvelopes();
  const tracer = new AgentTracer(makeSession(() => createAssistantMessageEventStream()));
  try {
    start(tracer); toolStart(tracer, "outer", "codemode");
    toolStart(tracer, "inner", "read", { parentToolCallId: "outer" });
    toolStart(tracer, "sibling", "write");
    toolStart(tracer, "orphan", "read", { parentToolCallId: "missing" });
    for (const id of ["inner", "orphan", "sibling", "outer"]) toolEnd(tracer, id);
    settle(tracer); await settleSpans();
    const spans = spansSince(mark);
    const tools = Object.fromEntries(toolSpans(spans).map((span) => [attrs(span)["tsgw.tool.call_id"], span]));
    assert.equal(toolSpans(spans).length, 4);
    childOf(tools.inner, tools.outer);
    for (const id of ["outer", "sibling", "orphan"]) childOf(tools[id], agentSpans(spans)[0]);
  } finally { tracer.dispose(); }
});

test("unknown zero prices omit cost instead of advertising free, known zero cost remains valid", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ usage: usage({ input: 4, output: 2 }) });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  try {
    start(tracer); await request(session, final, makeModel());
    await request(session, final, pricedModel()); settle(tracer); await settleSpans();
    const models = modelSpans(spansSince(mark));
    assert.equal(models.length, 2);
    assert.equal(attrs(models[0])["gen_ai.cost.total_tokens"], undefined);
    assert.equal(attrs(models[0])["gen_ai.usage.total_tokens"], 6);
    assert.equal(attrs(models[1])["gen_ai.cost.total_tokens"], 0);
  } finally { tracer.dispose(); }
});

test("withScope links existing error capture to request span (even after settle) and restores ambient scope", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ stopReason: "error" });
  const session = makeSession(streamFunction(final));
  const tracer = new AgentTracer(session);
  try {
    start(tracer); await request(session, final);
    tracer.onEvent({ type: "message_end", message: final }); settle(tracer);
    const returned = tracer.withScope(() => {
      Sentry.captureException(new Error("existing captured failure")); return 42;
    }, { type: "message_end", message: final });
    assert.equal(returned, 42);
    assert.equal(Sentry.getActiveSpan(), undefined);
    await settleSpans();
    const [error] = errorEventsSince(mark);
    const [model] = modelSpans(spansSince(mark));
    assert.ok(error);
    assert.equal(error.contexts.trace.trace_id, model.trace_id);
    assert.equal(error.contexts.trace.span_id, model.span_id);
    assert.equal(error.exception.values[0].value, "existing captured failure");
  } finally { tracer.dispose(); }
});

test("sync factory throw, async factory rejection and result rejection finish one failed request each", async () => {
  for (const mode of ["sync", "async", "result"]) {
    const mark = markEnvelopes();
    const error = new Error(`provider failure ${mode}`);
    const stream = createAssistantMessageEventStream();
    if (mode === "result") stream.result = () => Promise.reject(error);
    const original = mode === "sync" ? () => { throw error; }
      : mode === "async" ? async () => { throw error; } : () => stream;
    const session = makeSession(original);
    const tracer = new AgentTracer(session);
    try {
      start(tracer);
      if (mode === "sync") {
        assert.throws(() => session.agent.streamFunction(makeModel(), { messages: [] }, {}),
          (caught) => caught === error);
      } else if (mode === "async") {
        await assert.rejects(session.agent.streamFunction(makeModel(), { messages: [] }, {}),
          (caught) => caught === error);
      } else {
        assert.equal(session.agent.streamFunction(makeModel(), { messages: [] }, {}), stream);
      }
      await tick();
      // A rejected factory/result does not necessarily emit an assistant message_end.
      settle(tracer); tracer.dispose(); await settleSpans();
      const spans = spansSince(mark);
      assert.equal(modelSpans(spans).length, 1, mode);
      assert.equal(agentSpans(spans).length, 1, mode);
      spans.forEach((span) => outcome(span, "error"));
    } finally { tracer.dispose(); }
  }
});

test("withScope falls back to active run, preserves callback errors, and never activates provider IO", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const session = makeSession((...args) => {
    assert.equal(Sentry.getActiveSpan(), undefined);
    return streamFunction(final)(...args);
  });
  const tracer = new AgentTracer(session);
  try {
    start(tracer);
    const error = new Error("callback failure");
    let capturedContext;
    assert.throws(() => tracer.withScope(() => {
      capturedContext = Sentry.getActiveSpan().spanContext();
      throw error;
    }), (caught) => caught === error);
    assert.equal(Sentry.getActiveSpan(), undefined);
    await request(session, final); settle(tracer); await settleSpans();
    const [root] = agentSpans(spansSince(mark));
    assert.equal(capturedContext.spanId, root.span_id);
    assert.equal(capturedContext.traceId, root.trace_id);
    assert.equal(tracer.withScope(() => Sentry.getActiveSpan()), undefined);
  } finally { tracer.dispose(); }
});

test("tracing starts by default without configuring an environment variable", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const original = streamFunction(final);
  const session = makeSession(original);
  const tracer = new AgentTracer(session);
  try {
    assert.notEqual(session.agent.streamFunction, original);
    start(tracer); toolStart(tracer, "default");
    await request(session, final); toolEnd(tracer, "default"); settle(tracer);
    assert.equal(tracer.withScope(() => "unchanged"), "unchanged");
    tracer.dispose(); await settleSpans();
    assert.equal(session.agent.streamFunction, original);
    const spans = spansSince(mark);
    assert.equal(spans.length, 3);
    assert.equal(agentSpans(spans).length, 1);
    assert.equal(modelSpans(spans).length, 1);
    assert.equal(toolSpans(spans).length, 1);
  } finally { tracer.dispose(); }
});
