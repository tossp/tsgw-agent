import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { getDefaultIntegrations } from "@sentry/node";
import { spanToJSON } from "@sentry/core";
import { hostname } from "node:os";
import { createServer, get } from "node:http";
import { once } from "node:events";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getAgentTracingOptions } = await jiti.import("./policy.ts");
const { getCatConfig } = await jiti.import("../../lib/cat-config.ts");
const { AgentTracer } = await jiti.import("./tracer.ts");

const marker = { "tsgw.agent_tracing": true };
const operations = ["gen_ai.invoke_agent", "gen_ai.chat", "gen_ai.execute_tool"];
const removedIntegrations = ["Anthropic_AI", "Google_GenAI", "Groq", "LangChain", "LangGraph", "Mastra",
  "McpServer", "Mistral", "OpenAI", "PiDurable", "TogetherAI", "VercelAI"];

// ProcessSession in 11.9 adds a beforeExit listener on every init without
// removing it on close. Remove only listeners introduced by each test fixture.
let beforeExitListeners;
beforeEach(() => { beforeExitListeners = new Set(process.listeners("beforeExit")); });
afterEach(() => {
  for (const listener of process.listeners("beforeExit")) {
    if (!beforeExitListeners.has(listener)) process.removeListener("beforeExit", listener);
  }
});

function init() {
  const envelopes = [];
  // No fallback/default transport: SDK output can only reach this in-memory array.
  Sentry.init({
    ...getCatConfig({ SENTRY_ENVIRONMENT: "test" }),
    ...getAgentTracingOptions(),
    dsn: "https://public@telemetry.invalid/10",
    tracePropagationTargets: [],
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    transport: () => ({
      send: (envelope) => { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); },
      flush: () => Promise.resolve(true),
    }),
  });
  return envelopes;
}

function spanEnvelopes(envelopes) {
  return envelopes.filter((envelope) => envelope[1].some(([header]) => header.type === "span"));
}

function spans(envelopes) {
  return spanEnvelopes(envelopes).flatMap((envelope) => envelope[1].flatMap(([header, payload]) =>
    header.type === "span" ? payload.items : []));
}

function errors(envelopes) {
  return envelopes.flatMap((envelope) => envelope[1].flatMap(([header, payload]) =>
    header.type === "event" ? [payload] : []));
}

function attributes(span) {
  return Object.fromEntries(Object.entries(span.attributes).map(([key, attr]) => [key, attr.value]));
}

function start(op, extra = {}) {
  return Sentry.startInactiveSpan({ name: "manual span", op, parentSpan: null, attributes: marker, ...extra });
}

test("policy surface is only sampling, streamed lifecycle and integration selection", () => {
  const options = getAgentTracingOptions();
  assert.deepEqual(Object.keys(options).sort(),
    ["integrations", "traceLifecycle", "tracesSampleRate", "tracesSampler"]);
  // No send-time span rewrite, attribute whitelist, DSC scrub or content switch.
  for (const key of ["beforeSendSpan", "beforeSendTransaction", "beforeSend", "beforeEnvelope",
    "ignoreSpans", "dataCollection"]) assert.equal(options[key], undefined, key);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.traceLifecycle, "stream");
  for (const operation of operations) {
    assert.equal(options.tracesSampler({ attributes: { ...marker, "sentry.op": operation } }), 1);
  }
  assert.equal(options.tracesSampler({ attributes: { ...marker, "sentry.op": "http.server" } }), 0);
  assert.equal(options.tracesSampler({ attributes: { "sentry.op": operations[0] } }), 0);
  assert.equal(options.tracesSampler({ attributes: { "tsgw.agent_tracing": "true", "sentry.op": operations[1] } }), 0);
  const shared = getCatConfig({});
  assert.equal(shared.tracesSampleRate, 0);
  assert.deepEqual(shared.dataCollection, { userInfo: true });
  assert.equal(shared.beforeSend, undefined);
});

test("integrations drop only overlapping AI/MCP auto-instrumentation and switch off automatic HTTP spans", async () => {
  init();
  try {
    const baseline = getDefaultIntegrations(getCatConfig({}));
    const configured = getAgentTracingOptions().integrations(baseline);
    const names = configured.map(({ name }) => name);
    assert.deepEqual(baseline.filter(({ name }) => !names.includes(name)).map(({ name }) => name).sort(),
      [...removedIntegrations].sort());
    assert.equal(names.filter((name) => name === "TsgwAgentTracingPolicy").length, 0);
    for (const name of ["Http", "NodeFetch"]) assert.ok(names.includes(name), name);
    for (const integration of baseline) {
      if (removedIntegrations.includes(integration.name)) continue;
      const selected = configured.find(({ name }) => name === integration.name);
      if (["Http", "NodeFetch"].includes(integration.name)) assert.notEqual(selected, integration);
      else assert.equal(selected, integration, integration.name);
    }
    const client = Sentry.getClient();
    const clientNames = client.getIntegrationNames();
    for (const name of removedIntegrations) assert.ok(!clientNames.includes(name), name);
    for (const name of ["Http", "NodeFetch", "RequestData"]) assert.ok(clientNames.includes(name), name);
    // SDK data collection defaults stay intact: no genAI/MCP inputs/outputs restriction.
    const collection = client.getDataCollectionOptions();
    assert.deepEqual(collection.genAI, { inputs: true, outputs: true });
    assert.deepEqual(collection.mcp, { inputs: true, outputs: true });
    assert.equal(collection.userInfo, true);
  } finally { await Sentry.close(2000); }
});

test("manual spans keep native names, root segment, status, links and every SDK attribute", async () => {
  const envelopes = init();
  const rootName = "invoke_agent TSGW Agent";
  const childName = "chat faux-model";
  const future = {
    "custom.future.field": "future-value",
    "sentry.future.flag": true,
    "gen_ai.request.stop_sequences": ["a", "b"],
    "gen_ai.usage.input_tokens": 7,
    "gen_ai.cost.total_tokens": 0.0125,
    // Content attributes an SDK/provider collector may add; the policy must not strip them.
    "gen_ai.input.messages": "sdk-provided input",
    "gen_ai.output.messages": "sdk-provided output",
    "gen_ai.system_instructions": "sdk-provided instructions",
    "mcp.arguments": "sdk-provided arguments",
    instance: "span-owner-host",
  };
  try {
    const root = Sentry.startInactiveSpan({
      name: rootName, op: "gen_ai.invoke_agent", parentSpan: null,
      attributes: { ...marker, "gen_ai.operation.name": "invoke_agent", "tsgw.run.id": "run-a" },
    });
    const rootSnapshot = spanToJSON(root);
    const child = Sentry.startInactiveSpan({
      name: childName, op: "gen_ai.chat", parentSpan: root,
      attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "faux-model", ...future },
    });
    const childSnapshot = spanToJSON(child);
    child.addLink({
      context: { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 },
      attributes: { "link.kind": "parent" },
    });
    child.setStatus({ code: 2, message: "provider failure" });
    child.end();
    root.end();
    await Sentry.flush(2000);

    const envelopesWithSpans = spanEnvelopes(envelopes);
    assert.equal(envelopesWithSpans.length, 1);
    const dsc = envelopesWithSpans[0][0].trace;
    // DSC is SDK-derived and no longer filtered: transaction survives.
    assert.equal(dsc.transaction, rootName);
    assert.equal(dsc.sample_rate, "1");
    assert.equal(dsc.sampled, "true");
    assert.ok(dsc.trace_id && dsc.public_key);

    const sent = spans(envelopes);
    assert.equal(sent.length, 2);
    const sentRoot = sent.find((span) => span.is_segment);
    const sentChild = sent.find((span) => !span.is_segment);
    assert.equal(sentRoot.name, rootName);
    assert.equal(sentRoot.status, "ok");
    assert.equal(sentChild.name, childName);
    assert.equal(sentChild.parent_span_id, sentRoot.span_id);
    assert.equal(sentChild.status, "error");
    assert.equal(sentChild.trace_id, sentRoot.trace_id);

    // Every attribute the SDK recorded is still present with the same value and type.
    for (const [span, snapshot] of [[sentRoot, rootSnapshot], [sentChild, childSnapshot]]) {
      for (const [key, value] of Object.entries(snapshot.attributes)) {
        assert.ok(key in span.attributes, `${span.name}: ${key}`);
        assert.deepEqual(attributes(span)[key], value, key);
      }
    }
    const sentChildAttributes = attributes(sentChild);
    for (const [key, value] of Object.entries(future)) {
      assert.deepEqual(sentChildAttributes[key], value, key);
    }
    assert.equal(sentChildAttributes.instance, "span-owner-host");
    assert.equal(sentChildAttributes["sentry.status.message"], "provider failure");
    assert.equal(sentChild.links.length, 1);
    assert.equal(sentChild.links[0].span_id, "b".repeat(16));
    assert.equal(sentChild.links[0].trace_id, "a".repeat(32));
    assert.equal(sentChild.links[0].attributes["link.kind"].value, "parent");
  } finally { await Sentry.close(2000); }
});

test("streamed children flush before their root ends with native segment and DSC names", async () => {
  const envelopes = init();
  const root = start("gen_ai.invoke_agent", { name: "invoke_agent main" });
  try {
    const child = start("gen_ai.execute_tool", { name: "execute_tool read", parentSpan: root });
    child.end();
    await Sentry.flush(2000);
    const sent = spans(envelopes);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].span_id, child.spanContext().spanId);
    assert.equal(sent[0].parent_span_id, root.spanContext().spanId);
    assert.equal(sent[0].name, "execute_tool read");
    assert.equal(attributes(sent[0])["sentry.segment.name"], "invoke_agent main");
    assert.equal(spanEnvelopes(envelopes)[0][0].trace.transaction, "invoke_agent main");
    root.end();
    await Sentry.flush(2000);
    assert.equal(spans(envelopes).length, 2);
  } finally { await Sentry.close(2000); }
});

test("unmarked manual children and explicit non-agent children are not filtered out", async () => {
  const envelopes = init();
  try {
    const root = start("gen_ai.invoke_agent");
    Sentry.startInactiveSpan({ name: "chat unmarked", op: "gen_ai.chat", parentSpan: root }).end();
    Sentry.startInactiveSpan({ name: "http child", op: "http.client", parentSpan: root }).end();
    Sentry.startInactiveSpan({ name: "no op child", parentSpan: root }).end();
    root.end();
    const orphan = Sentry.startInactiveSpan({ name: "orphan root", op: "gen_ai.chat", parentSpan: null });
    assert.equal(orphan.isRecording(), false);
    orphan.end();
    await Sentry.flush(2000);

    const sent = spans(envelopes);
    assert.deepEqual(sent.map((span) => span.name).sort(),
      ["chat unmarked", "http child", "manual span", "no op child"].sort());
    const sentRoot = sent.find((span) => attributes(span)["sentry.op"] === "gen_ai.invoke_agent");
    assert.ok(sentRoot);
    assert.equal(attributes(sentRoot)["tsgw.agent_tracing"], true);
    for (const span of sent.filter((item) => item !== sentRoot)) {
      assert.equal(attributes(span)["tsgw.agent_tracing"], undefined, span.name);
    }
    assert.equal(attributes(sent.find((span) => span.name === "http child"))["sentry.op"], "http.client");
    assert.ok(!sent.some((span) => span.name === "orphan root"));
  } finally { await Sentry.close(2000); }
});

test("default tracing collects every marked manual root at 100% and sends complete agent spans", async () => {
  const envelopes = init();
  try {
    for (let index = 0; index < 10; index++) {
      for (const op of operations) start(op, { name: `span ${op}` }).end();
    }
    start("http.server").end();
    await Sentry.flush(2000);
    const sent = spans(envelopes);
    assert.equal(sent.length, 30);
    assert.deepEqual(new Set(sent.map((span) => attributes(span)["sentry.op"])), new Set(operations));
    assert.ok(sent.every((span) => attributes(span)["tsgw.agent_tracing"] === true));
    assert.ok(sent.every((span) => span.is_segment === true));
    assert.ok(sent.every((span) => span.status === "ok"));
  } finally { await Sentry.close(2000); }
});

test("tracer-created spans carry the instance itself instead of a send-time rewrite", async () => {
  const envelopes = init();
  const calls = [];
  const session = {
    sessionId: "session-instance",
    agent: { streamFunction: () => { calls.push("stream"); throw new Error("must not be called"); } },
  };
  try {
    const tracer = new AgentTracer(session, { agentName: "main" });
    tracer.onEvent({ type: "agent_start" });
    tracer.onEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" });
    tracer.onEvent({ type: "tool_execution_end", toolCallId: "tool-1", isError: false });
    tracer.onEvent({ type: "agent_settled" });
    await Sentry.flush(2000);

    const sent = spans(envelopes);
    assert.deepEqual(sent.map((span) => span.name).sort(),
      ["execute_tool read", "invoke_agent main"].sort());
    for (const span of sent) {
      assert.equal(attributes(span).instance, hostname(), span.name);
      // Hostname is supplied by the tracer, not a policy rewrite.
      assert.equal(span.is_segment, span.name.startsWith("invoke_agent"), span.name);
    }
    assert.deepEqual(calls, []);
  } finally { await Sentry.close(2000); }
});

test("ordinary HTTP/fetch inside an active manual span emits no extra spans or propagation headers", async () => {
  const envelopes = init();
  const requests = [];
  const server = createServer((request, response) => { requests.push(request.headers); response.end("ok"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const root = start("gen_ai.invoke_agent");
    await Sentry.withActiveSpan(root, async () => {
      await new Promise((resolve, reject) => get(url, (response) => {
        response.resume(); response.on("end", resolve);
      }).on("error", reject));
      const response = await fetch(url);
      await response.text();
    });
    root.end();
    await Sentry.flush(2000);
    assert.equal(spans(envelopes).length, 1);
    assert.equal(requests.length, 2);
    for (const headers of requests) {
      assert.equal(headers["sentry-trace"], undefined);
      assert.equal(headers.baggage, undefined);
      assert.equal(headers.traceparent, undefined);
    }
  } finally {
    await Sentry.close(2000);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("default tracing leaves error payload, request context and userInfo policy unchanged", async () => {
  const envelopes = init();
  const secret = "PROMPT_ARGUMENT_RESULT_HEADER_SECRET";
  try {
    Sentry.withScope((scope) => {
      scope.setSDKProcessingMetadata({ normalizedRequest: {
        url: "https://pi.example.test/api/sessions?probe=1", method: "GET", query_string: "probe=1",
        headers: { "x-forwarded-for": "198.51.100.42", "user-agent": "CAT regression" },
      } });
      scope.setExtra("existing-error-context", secret);
      Sentry.captureException(new Error(secret));
    });
    await Sentry.flush(2000);
    const events = errors(envelopes);
    assert.equal(events.length, 1);
    assert.equal(events[0].exception.values[0].value, secret);
    assert.equal(events[0].extra["existing-error-context"], secret);
    assert.equal(events[0].user.ip_address, "198.51.100.42");
    assert.equal(events[0].request.headers["user-agent"], "CAT regression");
    assert.equal(events[0].request.query_string, "probe=1");
  } finally { await Sentry.close(2000); }
});
