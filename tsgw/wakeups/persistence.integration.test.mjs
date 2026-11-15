import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { createWakeupHost, getWakeupStateFile } = await jiti.import("./host.ts");
const { createWakeupExtension } = await jiti.import("./extension.ts");
const { createSessionOwnerAccess } = await jiti.import("./session-owner.ts");
const { resolveSessionPath } = await jiti.import("../../lib/session-reader.ts");
const { WAKEUP_NOTIFICATION_TYPE } = await jiti.import("./history.ts");
const runtimeKey = Symbol.for("pi-web.wakeupRuntime");
const answer = text => fauxAssistantMessage([fauxText(text)]);

async function eventually(check) {
  const until = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(10);
  } while (Date.now() < until);
  assert.fail("Timed out waiting for persistent SDK wakeup evidence");
}

// Uses the real persistent runtime, SDK sessions, wrapper observer/admission and
// follow-up queue. Only the provider and registry/reopen boundary are isolated.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "wakeup-persistent-sdk-"));
  const agentDir = join(directory, "agent"), sourceCwd = join(directory, "source"), targetCwd = join(directory, "target");
  await Promise.all([agentDir, sourceCwd, targetCwd].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(targetCwd, "AGENTS.md"), "# Target rules\nTARGET_PROJECT_RULE_9371\n");
  await writeFile(join(sourceCwd, "AGENTS.md"), "# Source rules\nSOURCE_PROJECT_RULE_4826\n");
  const previousDir = process.env.PI_CODING_AGENT_DIR, previousRuntime = globalThis[runtimeKey];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const stateFile = getWakeupStateFile();
  const faux = fauxProvider({ models: [{ id: "persistent-wakeup-fixture" }] });
  const registry = new Map(), wrappers = new Set(), runtimes = new Set(), releases = [];
  let runtime, modelInitializations = 0;
  t.mock.method(net.Socket.prototype, "connect", () => { throw new Error("isolated integration forbids network"); });
  t.mock.method(globalThis, "fetch", () => { throw new Error("isolated integration forbids fetch"); });
  const source = SessionManager.create(sourceCwd);
  source.appendMessage({ role: "user", content: [{ type: "text", text: "Source-only context" }], timestamp: Date.now() });
  const sourceId = source.getSessionId(), sourceFile = source.getSessionFile();
  const getSession = id => { const wrapper = registry.get(id); return wrapper?.isAlive() ? wrapper : undefined; };
  const open = async (id, file) => {
    modelInitializations++;
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const manager = SessionManager.open(file);
    assert.equal(manager.getSessionId(), id);
    const services = await createAgentSessionServices({
      cwd: manager.getCwd(), agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension({ models: false }) }, createWakeupExtension(runtime),
        ],
      },
    });
    const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("persistent-wakeup-fixture") });
    const wrapper = new AgentSessionWrapper(inner);
    registry.set(id, wrapper);
    wrappers.add(wrapper);
    wrapper.start();
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    return wrapper;
  };
  const access = { getSession, reopenSession: open, withSessionOwner: createSessionOwnerAccess(getSession, () => null) };
  const restart = async () => {
    runtime?.dispose();
    await eventually(() => !existsSync(join(dirname(stateFile), "owner.lock")));
    runtime = createWakeupHost(access, { stateFile });
    globalThis[runtimeKey] = runtime;
    runtimes.add(runtime);
    await runtime.ready();
    return runtime;
  };
  t.after(async () => {
    for (const item of runtimes) item.dispose();
    for (const release of releases) release();
    for (const wrapper of wrappers) await wrapper.inner.abort();
    for (const wrapper of wrappers) await wrapper.shutdown();
    await eventually(() => !existsSync(join(dirname(stateFile), "owner.lock")));
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  });
  await restart();
  return {
    sourceId, sourceFile, targetCwd, faux, stateFile, restart, open,
    get runtime() { return runtime; }, get modelInitializations() { return modelInitializations; },
    getSession, resolve: resolveSessionPath,
    async item(id) { return (await runtime.query({ wakeup_id: id })).items[0]; },
    hold() {
      let release;
      const gate = { entered: false, promise: new Promise(resolve => { release = resolve; }) };
      gate.release = release;
      gate.response = async () => { gate.entered = true; await gate.promise; return answer("original run"); };
      releases.push(release);
      return gate;
    },
  };
}

test("project schedule persists before any model initialization, then records real notification/run evidence", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const originalSource = await readFile(f.sourceFile);
  f.faux.setResponses([answer("target handled handoff")]);
  const task = await f.runtime.schedule(f.sourceId, { cwd: f.targetCwd, title: "Target handoff", after_seconds: 0.08, message: "Read target project rules" });
  assert.equal(f.modelInitializations, 0);
  const targetFile = await f.resolve(task.targetSessionId);
  assert.ok(targetFile && existsSync(targetFile));
  const initial = SessionManager.open(targetFile);
  assert.equal(initial.getHeader().parentSession, undefined);
  assert.equal(initial.getCwd(), f.targetCwd);
  assert.equal(initial.getSessionName(), "Target handoff");
  assert.equal(initial.getEntries().some(entry => entry.type === "message" || entry.type === "custom_message"), false);
  await eventually(async () => (await f.item(task.wakeupId)).status === "run_settled");
  const result = await f.item(task.wakeupId), target = f.getSession(task.targetSessionId);
  assert.equal(f.modelInitializations, 1);
  assert.equal(f.faux.state.callCount, 1);
  assert.ok(target.inner.systemPrompt.includes("TARGET_PROJECT_RULE_9371"));
  assert.equal(target.inner.systemPrompt.includes("SOURCE_PROJECT_RULE_4826"), false);
  assert.ok(result.submittedAt && result.receivedAt && result.settledAt && result.runId);
  assert.ok(result.notificationEntryId && result.branchLeafId);
  const entries = target.inner.sessionManager.getEntries();
  assert.ok(entries.some(entry => entry.id === result.notificationEntryId && entry.type === "custom_message"));
  assert.ok(result.responseEntryIds.length > 0);
  assert.ok(result.responseEntryIds.every(id => entries.some(entry => entry.id === id && entry.type === "message" && entry.message.role === "assistant")));
  assert.deepEqual(await readFile(f.sourceFile), originalSource);
});

test("real model codemode calls can create by cwd and query status; cancellation keeps the unstarted target", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const source = await f.open(f.sourceId, f.sourceFile);
  const input = { cwd: f.targetCwd, title: "Scheduled from model", after_seconds: 60, message: "Later handoff" };
  const code = `const scheduled = await tools.schedule_wakeup(${JSON.stringify(input)}); return { scheduled, status: await tools.query_wakeups({ wakeup_id: scheduled.wakeupId, status: "pending" }) };`;
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), answer("scheduled"),
  ]);
  await source.inner.prompt("Arrange a handoff in the target project and inspect its status");
  const result = source.inner.agent.state.messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
  assert.equal(result?.isError, false);
  const [task] = f.runtime.list();
  assert.ok(task);
  assert.notEqual(task.targetSessionId, f.sourceId);
  const targetFile = await f.resolve(task.targetSessionId);
  assert.equal(f.modelInitializations, 1, "only the source has an agent runtime");
  assert.equal(f.getSession(task.targetSessionId), undefined);
  await f.runtime.cancel(task.wakeupId);
  assert.equal((await f.item(task.wakeupId)).status, "cancelled");
  assert.equal(existsSync(targetFile), true);
  assert.equal(SessionManager.open(targetFile).getSessionName(), "Scheduled from model");
});

test("persistent host restores an overdue pending target and never replays its settled delivery", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const task = await f.runtime.schedule(f.sourceId, { cwd: f.targetCwd, after_seconds: 0.06, message: "Resume after downtime" });
  f.runtime.dispose();
  await delay(100);
  assert.equal(f.modelInitializations, 0);
  f.faux.setResponses([answer("resumed")]);
  await f.restart();
  await eventually(async () => (await f.item(task.wakeupId)).status === "run_settled");
  assert.ok((await f.item(task.wakeupId)).recoveredAt);
  assert.equal(f.faux.state.callCount, 1);
  await f.restart();
  await delay(80);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await f.item(task.wakeupId)).status, "run_settled");
});

test("Stop on a real busy target leaves a cleared notification unknown and never resubmits it", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const source = await f.open(f.sourceId, f.sourceFile), held = f.hold();
  f.faux.setResponses([held.response, answer("must not run")]);
  await source.send({ type: "prompt", message: "held ordinary run" });
  await eventually(() => held.entered);
  const task = await f.runtime.schedule(f.sourceId, { after_seconds: 0.02, message: "queued wakeup" });
  await eventually(async () => (await f.item(task.wakeupId)).status === "submitted");
  const stopped = source.send({ type: "abort" });
  held.release();
  await stopped;
  await eventually(() => !source.isRunning());
  assert.equal((await f.item(task.wakeupId)).status, "unknown");
  assert.equal(source.inner.sessionManager.getEntries().some(entry => entry.type === "custom_message" && entry.customType === WAKEUP_NOTIFICATION_TYPE), false);
  assert.equal(f.faux.state.callCount, 1);
  await f.restart();
  await delay(80);
  assert.equal((await f.item(task.wakeupId)).status, "unknown");
  assert.equal(f.faux.state.callCount, 1);
});
