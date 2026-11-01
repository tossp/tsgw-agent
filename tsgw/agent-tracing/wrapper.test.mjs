import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import {
  Sentry, markEnvelopes, settleSpans,
  assistantMessage, streamFunction, makeModel, attrs, spansSince,
  agentSpans, modelSpans, toolSpans, errorEventsSince,
} from "./tracer-fixture.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
after(async () => { await Sentry.close(2000); });

function host(final) {
  const manager = SessionManager.inMemory(process.cwd());
  let listener;
  let disposed = false;
  const original = streamFunction(final);
  const inner = {
    sessionId: manager.getSessionId(), sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: {}, streamFunction: original }, extensionRunner: {},
    subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    dispose() { disposed = true; },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  return { inner, wrapper, original, emit: (event) => listener(event), isDisposed: () => disposed };
}

test("wrapper traces raw nested tools with zero browsers; reconnect replay does not duplicate spans", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage();
  const { inner, wrapper, original, emit, isDisposed } = host(final);
  try {
    emit({ type: "agent_start" });
    const stream = inner.agent.streamFunction(makeModel(), { messages: [] }, {});
    await stream.result();
    emit({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode", args: {} });
    emit({ type: "tool_execution_start", toolCallId: "outer/1", toolName: "mcp__test", parentToolCallId: "outer", args: {} });
    const seen = [];
    const disconnect = wrapper.onEvent((event) => seen.push(event.type));
    const second = wrapper.onEvent(() => {});
    assert.deepEqual(seen, ["tool_execution_start"], "only the outer tool is replayed to a page");
    emit({ type: "tool_execution_end", toolCallId: "outer/1", parentToolCallId: "outer", isError: false });
    emit({ type: "tool_execution_end", toolCallId: "outer", isError: false });
    emit({ type: "agent_end" });
    emit({ type: "agent_settled", aborted: false });
    disconnect(); second();
    await settleSpans();
    const spans = spansSince(mark);
    assert.equal(agentSpans(spans).length, 1);
    assert.equal(modelSpans(spans).length, 1);
    const tools = toolSpans(spans);
    assert.equal(tools.length, 2);
    const outer = tools.find((span) => attrs(span)["tsgw.tool.call_id"] === "outer");
    const nested = tools.find((span) => attrs(span)["tsgw.tool.call_id"] === "outer/1");
    assert.equal(nested.parent_span_id, outer.span_id);
  } finally { wrapper.destroy(); }
  assert.equal(inner.agent.streamFunction, original);
  assert.equal(isDisposed(), true);
});

test("existing wrapper provider capture is emitted once and linked to model span without browsers", async () => {
  const mark = markEnvelopes();
  const final = assistantMessage({ stopReason: "error", errorMessage: "existing provider error" });
  const { inner, wrapper, emit } = host(final);
  try {
    emit({ type: "agent_start" });
    await inner.agent.streamFunction(makeModel(), { messages: [] }, {}).result();
    emit({ type: "message_end", message: final });
    emit({ type: "agent_end" });
    emit({ type: "agent_settled", aborted: false });
    await settleSpans();
    const events = errorEventsSince(mark);
    assert.equal(events.length, 1);
    assert.equal(events[0].exception.values[0].value, "existing provider error");
    const [model] = modelSpans(spansSince(mark));
    assert.equal(events[0].contexts.trace.trace_id, model.trace_id);
    assert.equal(events[0].contexts.trace.span_id, model.span_id);
  } finally { wrapper.destroy(); }
});
