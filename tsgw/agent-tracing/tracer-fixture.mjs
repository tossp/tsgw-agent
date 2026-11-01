// Test fixtures for tracer.test.mjs: real Sentry SDK with an in-memory transport,
// deterministic local assistant streams, and streamed-span envelope readers.
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
import * as Sentry from "@sentry/node";

const jiti = createJiti(import.meta.url);
export const { AgentTracer } = await jiti.import("./tracer.ts");
const { getAgentTracingOptions } = await jiti.import("./policy.ts");

const envelopes = [];
Sentry.init({
  ...getAgentTracingOptions(),
  dsn: "https://public@example.invalid/1",
  defaultIntegrations: [],
  tracePropagationTargets: [],
  sendClientReports: false,
  enableLogs: false,
  // No network: every envelope stays in this array.
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});

export { Sentry, createAssistantMessageEventStream };
export const markEnvelopes = () => envelopes.length;
export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flush the SDK's streamed span buffer so every ended span reaches memory. */
export async function settleSpans() {
  await tick(0);
  await Sentry.flush(3000);
  await tick(0);
  await Sentry.flush(3000);
}

export function makeSession(streamFunction, sessionId = randomUUID()) {
  return { sessionId, agent: { streamFunction } };
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function makeModel(overrides = {}) {
  const { cost, ...rest } = overrides;
  return {
    id: "faux-model",
    name: "Faux Model",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { ...zeroCost, ...cost },
    ...rest,
  };
}

export const pricedModel = (overrides = {}) =>
  makeModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, ...overrides });

/** @param {Partial<Omit<import("@earendil-works/pi-ai").Usage, "cost">> & { cost?: Partial<import("@earendil-works/pi-ai").Usage["cost"]> }} [values] */
export function usage({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, totalTokens, cost = {}, ...extra } = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: totalTokens ?? input + output,
    cost: { ...zeroCost, total: 0, ...cost },
    ...extra,
  };
}

export function assistantMessage({ text = "done", stopReason = "stop", usage: messageUsage = usage(), errorMessage } = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "faux",
    model: "faux-model",
    usage: messageUsage,
    stopReason,
    timestamp: Date.now(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

/** A real stream that terminates with `final` after `delay` ms. */
export function endingStream(final, delay = 0) {
  const stream = createAssistantMessageEventStream();
  const end = () => stream.end(final);
  if (delay) setTimeout(end, delay);
  else queueMicrotask(end);
  return stream;
}

export function streamFunction(final, { delay = 0, capture, events = [] } = {}) {
  return (model, context, options) => {
    capture?.push({ model, context, options });
    const stream = createAssistantMessageEventStream();
    if (delay) setTimeout(() => { for (const event of events) stream.push(event); stream.end(final); }, delay);
    else queueMicrotask(() => { for (const event of events) stream.push(event); stream.end(final); });
    return stream;
  };
}

function envelopeSpanItems(envelope) {
  const items = [];
  for (const [header, payload] of envelope[1] ?? []) {
    if (header.type === "span") items.push(...(payload.items ?? []));
    else if (header.type === "transaction") items.push(payload, ...(payload.spans ?? []));
  }
  return items;
}

export function spansSince(mark) {
  return envelopes.slice(mark).flatMap(envelopeSpanItems)
    .sort((left, right) => left.start_timestamp - right.start_timestamp);
}

export function errorEventsSince(mark) {
  const events = [];
  for (const envelope of envelopes.slice(mark)) {
    for (const [header, payload] of envelope[1] ?? []) {
      if (header.type === "event") events.push(payload);
    }
  }
  return events;
}

/** Envelope JSON as sent: the privacy check scans exactly this. */
export const envelopeText = () => JSON.stringify(envelopes);

export function attrs(span) {
  const values = {};
  for (const [key, attribute] of Object.entries(span.attributes ?? {})) {
    values[key] = attribute && typeof attribute === "object" && "value" in attribute ? attribute.value : attribute;
  }
  return values;
}

export const OP = { agent: "gen_ai.invoke_agent", model: "gen_ai.chat", tool: "gen_ai.execute_tool" };
export const operationOf = (span) => attrs(span)["sentry.op"];
export const spansWithOp = (list, op) => list.filter((span) => operationOf(span) === op);
export const agentSpans = (list) => spansWithOp(list, OP.agent);
export const modelSpans = (list) => spansWithOp(list, OP.model);
export const toolSpans = (list) => spansWithOp(list, OP.tool);
export const durationMs = (span) => (span.end_timestamp - span.start_timestamp) * 1000;
export const segmentSpans = (list) => list.filter((span) => span.is_segment);
