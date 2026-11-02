import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as Sentry from "@sentry/node";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startRpcSession, getRpcSession } = await jiti.import("../../lib/rpc-manager.ts");
const { createSideSession } = await jiti.import("../../lib/session-fork.ts");
const { createWebPushNotifier } = await jiti.import("../../lib/web-push.ts");
const { createWakeupHost } = await jiti.import("./host.ts");
const { createSessionOwnerAccess } = await jiti.import("./session-owner.ts");
const { WAKEUP_TOOL_NAMES } = await jiti.import("./extension.ts");
const { WAKEUP_NOTIFICATION_TYPE } = await jiti.import("./history.ts");
const answer = (text = "done") => fauxAssistantMessage([fauxText(text)]);
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const runtimeKey = Symbol.for("pi-web.wakeupRuntime");

async function eventually(check) {
  const until = Date.now() + 5_000;
  do {
    if (await check()) return;
    await delay(10);
  } while (Date.now() < until);
  assert.fail("Timed out waiting for real side-session wakeup state");
}

// Real RPC registry, SDK sessions, side fork, tool dispatch and host delivery. Only
// provider construction, scratch path lookup and the push transport are isolated.
async function withFixture(t, check) {
  assert.equal(Sentry.getClient(), undefined, "no CAT client/transport may be initialized");
  const dir = await mkdtemp(join(tmpdir(), "pi-web-side-wakeup-"));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project"), sessionDir = join(dir, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const network = t.mock.method(net.Socket.prototype, "connect", () => { throw new Error("offline integration: network forbidden"); });
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("offline integration: fetch forbidden"); });
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousRuntime = globalThis[runtimeKey];
  const previousNotifier = globalThis.__piWebPushNotifier;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const faux = fauxProvider({ models: [{ id: "side-wakeup-fixture" }] });
  const originalCreate = ModelRuntime.create;
  const providerPatch = t.mock.method(ModelRuntime, "create", async function (options) {
    const runtime = await originalCreate.call(this, { ...options, authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    return runtime;
  });
  const pushes = [];
  // Keep the production completion callback and notifier, but never send a push.
  globalThis.__piWebPushNotifier = Promise.resolve(createWebPushNotifier({
    loadState: () => ({ vapidKeys: { publicKey: "fixture", privateKey: "fixture" },
      subscriptions: [{ endpoint: "https://fixture.invalid", keys: { p256dh: "fixture", auth: "fixture" }, locale: "en" }] }),
    saveState: () => assert.fail("fixture push state must not be written"),
    generateVapidKeys: () => assert.fail("fixture already has keys"),
    send: async (_subscription, payload) => { pushes.push(JSON.parse(payload)); },
  }));
  const paths = new Map(), wrappers = new Set(), reopened = [], reopenErrors = [];
  let beforeReopen;
  const open = async (id, file, strict = false) => {
    const { session } = await startRpcSession(id, file, undefined, { requireExistingSession: strict });
    wrappers.add(session);
    await session.waitUntilReady();
    // The persisted model is restored using the injected native provider. Fail
    // closed before any prompt if model selection ever falls back to a real one.
    assert.equal(session.inner.model?.provider, faux.provider.id);
    assert.equal(session.inner.model?.id, "side-wakeup-fixture");
    return session;
  };
  const runtime = createWakeupHost({
    getSession: getRpcSession,
    resolvePath: async (id) => paths.get(id) ?? null,
    withSessionOwner: createSessionOwnerAccess(getRpcSession, () => null),
    reopenSession: async (id, file) => {
      reopened.push(id);
      if (beforeReopen) await beforeReopen(id, file);
      try { return await open(id, file, true); }
      catch (error) { reopenErrors.push(error); throw error; }
    },
  });
  globalThis[runtimeKey] = runtime;
  try {
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendModelChange(faux.provider.id, "side-wakeup-fixture");
    manager.appendMessage({ role: "system", content: "Isolated side/wakeup regression", timestamp: Date.now(),
      toolsAdded: ["read", "bash", "edit", "write"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })) });
    manager.appendMessage({ role: "user", content: "parent fixture", timestamp: Date.now() });
    manager.appendMessage(answer("parent reply"));
    paths.set(manager.getSessionId(), manager.getSessionFile());
    const source = await open(manager.getSessionId(), manager.getSessionFile());
    const side = async () => {
      const copy = createSideSession(source.sessionFile);
      paths.set(copy.sessionId, copy.path);
      return { ...copy, wrapper: await open(copy.sessionId, copy.path) };
    };
    await check({ source, side, faux, runtime, paths, pushes, reopened, reopenErrors, sessionDir,
      deleteAtReopen: (callback) => { beforeReopen = callback; } });
  } finally {
    runtime.dispose();
    for (const wrapper of wrappers) await wrapper.inner.abort();
    for (const wrapper of wrappers) await wrapper.shutdown();
    providerPatch.mock.restore();
    network.mock.restore();
    fetch.mock.restore();
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    if (previousNotifier === undefined) delete globalThis.__piWebPushNotifier; else globalThis.__piWebPushNotifier = previousNotifier;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
}

function assertRestricted(wrapper) {
  assert.deepEqual(wrapper.inner.getAllTools().map((tool) => tool.name).sort(), ["bash", "read"]);
  for (const name of WAKEUP_TOOL_NAMES) {
    assert.equal(wrapper.inner.getActiveToolNames().includes(name), false, name);
    assert.equal(wrapper.inner.getCallableToolNames().includes(name), false, name);
  }
}

async function rejectWakeupCalls(f, wrapper) {
  const args = [{ after_seconds: 60, message: "must not schedule" }, {}, { wakeup_id: "missing" }, { session_id: wrapper.sessionId }];
  f.faux.setResponses([
    (context) => {
      const declared = getCurrentTools(context.messages).map((tool) => tool.name);
      for (const name of WAKEUP_TOOL_NAMES) assert.equal(declared.includes(name), false, name);
      return fauxAssistantMessage(WAKEUP_TOOL_NAMES.map((name, i) => fauxToolCall(name, args[i])), { stopReason: "toolUse" });
    }, answer("unavailable tools refused"),
  ]);
  const previous = wrapper.inner.agent.state.messages.length;
  await wrapper.inner.prompt("Try the four unavailable wakeup tools");
  const results = wrapper.inner.agent.state.messages.slice(previous).filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((result) => result.toolName).sort(), [...WAKEUP_TOOL_NAMES].sort());
  for (const result of results) {
    assert.equal(result.isError, true, result.toolName);
    assert.match(JSON.stringify(result.content), /not found|unknown|not available/i);
  }
  assert.deepEqual(f.runtime.list(), []);
  assertRestricted(wrapper);
}

async function scheduleFromModel(f, targetId, message) {
  f.faux.setResponses([call("schedule_wakeup", { session_id: targetId, after_seconds: 0.15, message }), answer("scheduled"), answer("side received handoff")]);
  const before = f.source.inner.agent.state.messages.length;
  await f.source.inner.prompt("Schedule the handoff to the existing side chat");
  const result = f.source.inner.agent.state.messages.slice(before).find((item) => item.role === "toolResult" && item.toolName === "schedule_wakeup");
  assert.equal(result?.isError, false, JSON.stringify(result));
  assert.equal(result.details.targetSessionId, targetId);
  assert.equal(result.details.sourceSessionId, f.source.sessionId);
  return result.details;
}

async function delivered(f, target, timer, message) {
  await eventually(async () => (await f.runtime.history(target.sessionId)).find((item) => item.wakeupId === timer.wakeupId)?.status === "submitted");
  const wrapper = getRpcSession(target.sessionId);
  await eventually(() => !wrapper.isRunning());
  const notification = wrapper.inner.sessionManager.getEntries().find((entry) => entry.type === "custom_message"
    && entry.customType === WAKEUP_NOTIFICATION_TYPE && entry.details.wakeupId === timer.wakeupId);
  assert.equal(notification.details.sourceSessionId, f.source.sessionId);
  assert.ok(notification.content.includes(message));
  assert.ok(wrapper.inner.agent.state.messages.some((item) => item.role === "assistant"
    && item.content.some((block) => block.text === "side received handoff")));
  assertRestricted(wrapper);
  return wrapper;
}

test("ordinary model can target live and reclaimed sides; strict reopen preserves denied wakeup tools and silent completion", { timeout: 25_000 }, async (t) => {
  await withFixture(t, async (f) => {
    const target = await f.side();
    for (const name of WAKEUP_TOOL_NAMES) assert.ok(f.source.inner.getCallableToolNames().includes(name), name);
    assertRestricted(target.wrapper);
    await rejectWakeupCalls(f, target.wrapper);
    const first = await scheduleFromModel(f, target.sessionId, "live-side handoff");
    const live = await delivered(f, target, first, "live-side handoff");
    assert.equal(live, target.wrapper);
    assert.deepEqual(f.reopened, []);
    await live.shutdown(); // Same real lifecycle as idle reclamation; no fake registry.
    assert.equal(getRpcSession(target.sessionId), undefined);
    const second = await scheduleFromModel(f, target.sessionId, "reopened-side handoff");
    const reopened = await delivered(f, target, second, "reopened-side handoff");
    assert.notEqual(reopened, live);
    assert.deepEqual(f.reopened, [target.sessionId]);
    await rejectWakeupCalls(f, reopened);
    await eventually(() => f.pushes.filter((push) => push.tag === `pi-session-complete:${f.source.sessionId}`).length === 2);
    assert.equal(f.pushes.some((push) => push.tag === `pi-session-complete:${target.sessionId}`), false,
      "settled side turns, including wakeups after reopen, must not notify completion");
    assert.deepEqual((await f.runtime.history(target.sessionId)).map((item) => item.status), ["submitted", "submitted"]);
  });
});

test("deleted side is never recreated, including deletion after host snapshot before real strict RPC reopen", { timeout: 25_000 }, async (t) => {
  await withFixture(t, async (f) => {
    for (const race of [false, true]) {
      const target = await f.side();
      await target.wrapper.shutdown();
      const previousReopens = f.reopened.length;
      if (race) f.deleteAtReopen(async (id, file) => {
        assert.equal(id, target.sessionId);
        assert.equal(file, target.path);
        await rm(file);
      });
      const files = await readdir(f.sessionDir);
      const calls = f.faux.state.callCount;
      const timer = await f.runtime.schedule(f.source.sessionId, { session_id: target.sessionId, after_seconds: 0.08, message: "deleted side" });
      if (!race) await rm(target.path);
      await eventually(() => f.runtime.list().length === 0);
      if (race) {
        await eventually(() => f.reopenErrors.length === 1);
        assert.match(f.reopenErrors[0].message, /Existing session not found or ID changed|ENOENT/);
      }
      await delay(80); // Let the unrecordable failed-history append settle too.
      assert.equal(existsSync(target.path), false);
      assert.equal(getRpcSession(target.sessionId), undefined);
      assert.equal(f.reopened.length, previousReopens + Number(race));
      assert.equal(f.faux.state.callCount, calls);
      assert.deepEqual((await readdir(f.sessionDir)).sort(), files.filter((file) => file !== target.path.split("/").at(-1)).sort());
      await assert.rejects(startRpcSession(target.sessionId, target.path, undefined, { requireExistingSession: true }), /not found|ID changed|ENOENT/);
      await assert.rejects(f.runtime.schedule(f.source.sessionId, { session_id: target.sessionId, after_seconds: 1, message: timer.message }));
      assert.equal(existsSync(target.path), false);
    }
  });
});
