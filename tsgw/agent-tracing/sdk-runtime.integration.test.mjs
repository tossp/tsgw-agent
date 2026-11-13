import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { calculateCost, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Sentry, AgentTracer, markEnvelopes, settleSpans, spansSince, agentSpans, modelSpans, attrs } from "./tracer-fixture.mjs";

const { version } = JSON.parse(await readFile(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url), "utf8"));
assert.equal(version, "1.5.2", "this auth contract regression must run against the target SDK, not the old installation");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createTracingAgentSessionFromServices } = await jiti.import("./index.ts");
const fetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Network is forbidden in the tracing SDK regression"); };
test.after(async () => { await Sentry.close(2000); globalThis.fetch = fetch; });

async function fixture(t, { adapted = true, settings, models, tools = [], onSessionStart } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "tsgw-tracing-sdk15-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const faux = fauxProvider({
    models: models ?? [{ id: "faux-auth", cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } }],
    tokensPerSecond: 0,
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(faux.provider.id, async () => ({
    type: "oauth", access: "local-faux-token", refresh: "local-faux-refresh", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  // Real OAuth selection and request preparation, entirely local. Observe whether
  // a second pass overrides OAuth with an explicit key; do not emulate a vendor failure.
  const oauth = {
    name: "Local OAuth", login: async () => { throw new Error("No login in tests"); },
    refresh: async () => { throw new Error("No refresh in tests"); },
    toAuth: async (credential) => ({ apiKey: credential.access, headers: { "x-local-auth": "oauth" } }),
  };
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    auth: { oauth },
    streamSimple(model, context, options) {
      const stream = faux.provider.streamSimple(model, context, options);
      // Faux deliberately reports zero monetary usage. Simulate a billed provider
      // with Pi's real pricing function; keep its actual stream and token estimates.
      void stream.result().then((message) => calculateCost(model, message.usage));
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    retry: { enabled: false }, ...settings,
  });
  let created;
  const services = await createAgentSessionServices({
    cwd, agentDir: cwd, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      ...(onSessionStart ? { extensionFactories: [(pi) => {
        pi.on("session_start", () => onSessionStart(created));
      }] } : {}),
    },
  });
  const create = adapted ? createTracingAgentSessionFromServices : createAgentSessionFromServices;
  const { session } = await create({ services, model: faux.getModel(), sessionManager: SessionManager.inMemory(cwd), tools });
  created = session;
  t.after(() => session.dispose());
  const original = session.agent.streamFunction;
  const authCalls = [];
  const streamOptions = [];
  const getAuth = modelRuntime.getAuth.bind(modelRuntime);
  modelRuntime.getAuth = (...args) => { authCalls.push(args); return getAuth(...args); };
  const streamSimple = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (model, context, options) => {
    streamOptions.push({ model: model.id, ...options });
    return streamSimple(model, context, options);
  };
  const events = [];
  session.subscribe((event) => events.push(event));
  function trace() {
    const tracer = new AgentTracer(session);
    const unsubscribe = session.subscribe((event) => tracer.onEvent(event));
    t.after(() => { unsubscribe(); tracer.dispose(); });
    return tracer;
  }
  async function seed() {
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    await session.prompt("first question " + "context ".repeat(30));
    await session.prompt("second question");
    authCalls.length = 0;
    streamOptions.length = 0;
  }
  return { session, modelRuntime, faux, original, authCalls, streamOptions, events, trace, seed };
}

function assertRuntimeAuth(f) {
  assert.ok(f.streamOptions.length > 0);
  assert.equal(f.authCalls.length, f.streamOptions.length, "auth resolves once per request inside ModelRuntime, without pre-resolution");
  assert.ok(f.streamOptions.every((options) => options.apiKey === undefined), "OAuth must reach the runtime without becoming an explicit API key");
}

async function assertSummarySpans(f) {
  await settleSpans();
  const auxiliary = modelSpans(spansSince(0)).filter((span) =>
    attrs(span)["gen_ai.conversation.id"] === f.session.sessionId && attrs(span)["tsgw.request.kind"] === "auxiliary");
  const summaries = f.streamOptions.filter((options) => options.sessionId !== f.session.sessionId);
  assert.ok(summaries.length > 0);
  assert.equal(auxiliary.length, summaries.length, "every real SDK summary remains observable in the Sentry envelope");
  for (const span of auxiliary) {
    assert.equal(span.parent_span_id, undefined, "summaries are roots, not children of a completed or current run");
    assert.equal(attrs(span)["gen_ai.request.model"], f.session.model.id);
    assert.equal(attrs(span)["tsgw.outcome"], "success");
  }
}

test("SDK-created stream keeps OAuth auth for normal requests and manual compaction; dispose restores its identity", async (t) => {
  const f = await fixture(t);
  const tracer = f.trace();
  assert.notEqual(f.session.agent.streamFunction, f.original);
  f.faux.setResponses([fauxAssistantMessage("normal answer")]);
  await f.session.prompt("normal request");
  assertRuntimeAuth(f);
  await f.seed();
  f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("manual summary")));
  const compacted = await f.session.compact();
  assert.match(compacted.summary, /manual summary/);
  assertRuntimeAuth(f);
  await assertSummarySpans(f);
  assert.ok(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction" && !entry.fromHook));
  tracer.dispose();
  assert.equal(f.session.agent.streamFunction, f.original);
  // Restoring is functional, not just referential: subsequent requests keep SDK auth too.
  f.authCalls.length = 0;
  f.streamOptions.length = 0;
  f.faux.setResponses([fauxAssistantMessage("after dispose")]);
  await f.session.prompt("after dispose");
  assertRuntimeAuth(f);
});

test("real tree navigation generates a branch summary through the marked wrapper", async (t) => {
  const f = await fixture(t);
  f.trace();
  await f.seed();
  const target = f.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  f.faux.setResponses([fauxAssistantMessage("branch summary")]);
  const result = await f.session.navigateTree(target.id, { summarize: true });
  assert.equal(result.cancelled, false);
  assertRuntimeAuth(f);
  await assertSummarySpans(f);
  assert.ok(f.session.sessionManager.getEntries().some((entry) => entry.type === "branch_summary" && entry.summary.includes("branch summary")));
});

for (const reason of ["threshold", "overflow"]) {
  test(`${reason} auto-compaction uses the real SDK default summarizer and preserves OAuth`, async (t) => {
    const f = await fixture(t, { models: [{ id: `faux-${reason}`, contextWindow: reason === "threshold" ? 128000 : 200, maxTokens: 64 }] });
    f.trace();
    await f.seed();
    // Enable through public settings after real history exists. A large reserve
    // triggers threshold below the window; a small window exercises overflow.
    f.session.settingsManager.applyOverrides({
      compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: reason === "threshold" ? 127999 : 100 },
    });
    f.faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("automatic summary and answer")));
    await f.session.prompt("continue");
    assertRuntimeAuth(f);
    await assertSummarySpans(f);
    assert.ok(f.streamOptions.length >= 2);
    assert.ok(f.events.some((event) => event.type === "compaction_start" && event.reason === reason));
    assert.ok(!f.events.some((event) => event.type === "compaction_end" && event.errorMessage));
    assert.ok(f.session.sessionManager.getEntries().some((entry) => entry.type === "compaction" && !entry.fromHook));
  });
}

test("negative control: wrapping an unadapted SDK stream reproduces the OAuth summarization regression", async (t) => {
  const f = await fixture(t, { adapted: false });
  f.trace();
  await f.seed();
  f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("unadapted summary")));
  await f.session.compact();
  assert.equal(f.authCalls.length, f.streamOptions.length + 1);
  assert.ok(f.streamOptions.every((options) => options.apiKey === "local-faux-token"));
});

test("a custom stream replacing a trusted original is not registered, and disposal does not overwrite later replacements", async (t) => {
  const f = await fixture(t);
  const custom = function (...args) { return f.original.apply(this, args); };
  f.session.agent.streamFunction = custom;
  const tracer = f.trace();
  await f.seed();
  f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("custom stream summary")));
  await f.session.compact();
  assert.equal(f.authCalls.length, f.streamOptions.length + 1, "do not silently bless a custom stream as a runtime stream");
  assert.ok(f.streamOptions.every((options) => options.apiKey === "local-faux-token"));
  tracer.dispose();
  assert.equal(f.session.agent.streamFunction, custom);
  const again = f.trace();
  const later = (...args) => custom(...args);
  f.session.agent.streamFunction = later;
  again.dispose();
  assert.equal(f.session.agent.streamFunction, later);
});

test("an extension's session_start replacement stays unmarked and survives tracer disposal", async (t) => {
  let custom;
  const f = await fixture(t, { onSessionStart(session) {
    custom = function (...args) { return f.original.apply(this, args); };
    session.agent.streamFunction = custom;
  } });
  const tracer = f.trace();
  await f.session.bindExtensions({});
  assert.equal(f.session.agent.streamFunction, custom);
  await f.seed();
  f.faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("extension summary")));
  await f.session.compact();
  assert.equal(f.authCalls.length, f.streamOptions.length + 1);
  assert.ok(f.streamOptions.every((options) => options.apiKey === "local-faux-token"));
  tracer.dispose();
  assert.equal(f.session.agent.streamFunction, custom);
});

test("a real A-to-B model switch stays one run and records each request's model, usage and cost", async (t) => {
  const f = await fixture(t, {
    tools: ["ls"],
    models: [
      { id: "model-a", cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } },
      { id: "model-b", cost: { input: 3, output: 6, cacheRead: 3, cacheWrite: 3 } },
    ],
  });
  f.trace();
  const mark = markEnvelopes();
  f.faux.setResponses([
    async () => {
      await f.session.setModel(f.faux.getModel("model-b"));
      return fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("done from model B")]),
  ]);
  await f.session.prompt("list the directory and answer");
  await settleSpans();
  const spans = spansSince(mark).filter((span) => attrs(span)["gen_ai.conversation.id"] === f.session.sessionId);
  const runs = agentSpans(spans);
  assert.equal(runs.length, 1);
  const requests = modelSpans(spans);
  assert.deepEqual(requests.map((span) => attrs(span)["gen_ai.request.model"]), ["model-a", "model-b"]);
  assert.deepEqual(requests.map((span) => attrs(span)["gen_ai.response.model"]), ["model-a", "model-b"]);
  const answers = f.session.sessionManager.getEntries()
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message);
  assert.equal(answers.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(attrs(requests[i])["gen_ai.usage.output_tokens"], answers[i].usage.output);
    assert.equal(attrs(requests[i])["gen_ai.cost.total_tokens"], answers[i].usage.cost.total);
    assert.equal(requests[i].parent_span_id, runs[0].span_id);
  }
  assert.ok(answers.every((answer) => answer.usage.cost.total > 0));
  assert.ok(f.session.sessionManager.getEntries().some((entry) => entry.type === "model_change" && entry.modelId === "model-b"));
  assert.ok(f.events.some((event) => event.type === "agent_settled"));
  assert.equal(f.session.model.id, "model-b");
});
