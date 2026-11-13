import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { createWakeupHost } = await jiti.import("./host.ts");
const { createSessionOwnerAccess } = await jiti.import("./session-owner.ts");
const { WAKEUP_NOTIFICATION_TYPE } = await jiti.import("./history.ts");
const answer = (text = "done") => fauxAssistantMessage([fauxText(text)]);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function eventually(check) {
  const until = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(10);
  } while (Date.now() < until);
  assert.fail("Timed out waiting for wakeup lifecycle");
}

async function fixture(t, { mcp = false, tool = false, shellExecution = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-wakeup-lifecycle-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const gates = [];
  const hold = () => {
    let release;
    const gate = { entered: false, promise: new Promise((resolve) => { release = resolve; }) };
    gate.release = release;
    gate.response = async () => { gate.entered = true; await gate.promise; return answer(); };
    gates.push(gate);
    return gate;
  };
  const shell = hold(), connection = hold(), toolGate = hold();
  let context, disposed = false;
  const extension = (pi) => {
    pi.on("session_start", (_event, ctx) => { context = ctx; });
    pi.on("user_bash", async () => {
      if (shellExecution) return { operations: {
        async exec(_command, _cwd, { onData }) {
          shell.entered = true;
          await shell.promise;
          onData(Buffer.from("isolated shell output"));
          return { exitCode: 0 };
        },
      } };
      shell.entered = true;
      await shell.promise;
      return { result: { output: "handled without spawning a shell", exitCode: 0, cancelled: false, truncated: false } };
    });
    if (tool) pi.registerTool({
      name: "hold", label: "hold", description: "wait for Stop", parameters: { type: "object", properties: {} },
      async execute(_id, _params, signal) {
        toolGate.entered = true;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { content: [{ type: "text", text: "stopped" }], details: undefined };
      },
    });
  };
  const faux = fauxProvider({ models: [{ id: "wakeup-lifecycle" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] },
  });
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "saved target" }], timestamp: Date.now() });
  const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("wakeup-lifecycle") });
  const wrapper = new AgentSessionWrapper(inner, mcp ? { mcpHost: {
    async prepareForPrompt(signal) { connection.entered = true; await connection.promise; signal.throwIfAborted(); },
    dispose() { disposed = true; },
  } } : {});
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const getSession = () => wrapper.isAlive() ? wrapper : undefined;
  const runtime = createWakeupHost({ getSession, resolvePath: async () => manager.getSessionFile(),
    reopenSession: () => assert.fail("this active target must not reopen"),
    withSessionOwner: createSessionOwnerAccess(getSession, () => null),
  });
  t.after(async () => {
    runtime.dispose();
    for (const gate of gates) gate.release();
    await inner.abort();
    await wrapper.shutdown();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  const history = () => runtime.history(inner.sessionId);
  const schedule = (message = "scheduled handoff", after_seconds = 0.01) => runtime.schedule(inner.sessionId, { message, after_seconds });
  return { wrapper, inner, manager, runtime, faux, shell, connection, toolGate, hold, history, schedule,
    shutdown: () => context.shutdown(), disposed: () => disposed,
    notifications: () => manager.getEntries().filter((e) => e.type === "custom_message" && e.customType === WAKEUP_NOTIFICATION_TYPE),
  };
}

test("a streaming wakeup queues beside SDK shell execution without blocking an ordinary follow-up", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { shellExecution: true });
  const model = f.hold();
  f.faux.setResponses([model.response, answer("wakeup"), answer("ordinary")]);
  await f.wrapper.send({ type: "prompt", message: "start" });
  await eventually(() => model.entered);
  const bash = f.wrapper.send({ type: "bash", command: "handled by extension" });
  await eventually(() => f.shell.entered);
  assert.equal(f.inner.isBashRunning, true, "real SDK executeBash is active on extension operations");
  const timer = await f.schedule();
  await eventually(async () => (await f.history())[0]?.status === "submitted");
  await f.wrapper.send({ type: "prompt", message: "ordinary queued follow-up", streamingBehavior: "followUp" });
  assert.equal(f.wrapper.shellRunning, true);
  assert.equal(f.faux.state.callCount, 1, "both submissions were accepted before the held model or shell finished");
  f.shell.release();
  await bash;
  model.release();
  await eventually(() => !f.wrapper.isRunning());
  assert.equal(f.notifications().filter((e) => e.details.wakeupId === timer.wakeupId).length, 1);
});

test("after MCP preparation a new wakeup run waits for an unfinished user_bash hook", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { mcp: true });
  f.faux.setResponses([answer()]);
  const bash = f.wrapper.send({ type: "bash", command: "slow user_bash handler" });
  await eventually(() => f.shell.entered);
  await f.schedule();
  await eventually(() => f.connection.entered);
  assert.equal(f.inner.isBashRunning, false);
  f.connection.release();
  await delay(120); // More than two host polling intervals: only userBashPending keeps it out.
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.notifications().length, 0);
  assert.equal((await f.history())[0].status, "inactive", "due but not yet submitted");
  f.shell.release();
  await bash;
  await eventually(async () => (await f.history())[0]?.status === "submitted");
  await eventually(() => !f.wrapper.isRunning());
  assert.equal(f.faux.state.callCount, 1);
});

test("wakeup preparation counts as pending and defers extension shutdown through acceptance", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { mcp: true });
  const model = f.hold();
  f.faux.setResponses([model.response]);
  const future = await f.schedule("future timer survives wrapper shutdown", 60);
  const due = await f.schedule();
  await eventually(() => f.connection.entered);
  assert.equal((await f.wrapper.send({ type: "get_state" })).isPromptRunning, true);
  await assert.rejects(f.wrapper.send({ type: "bash", command: "must not overtake MCP preparation" }), /busy/);
  f.shutdown();
  await nextTurn();
  assert.equal(f.wrapper.isAlive(), true);
  assert.equal(f.disposed(), false);
  f.connection.release();
  await eventually(async () => model.entered && (await f.history()).find((e) => e.wakeupId === due.wakeupId)?.status === "submitted");
  assert.equal(f.wrapper.isAlive(), true, "acceptance does not wait for the model, shutdown still does");
  model.release();
  await eventually(() => !f.wrapper.isAlive());
  assert.equal(await f.wrapper.waitUntilDisposed(2000), true);
  assert.deepEqual(f.runtime.list().map((e) => e.wakeupId), [future.wakeupId]);
});

test("Stop may clear an accepted queued wakeup without replaying or relabelling it failed", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { tool: true });
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }), answer("next run")]);
  await f.wrapper.send({ type: "prompt", message: "start tool" });
  await eventually(() => f.toolGate.entered);
  const timer = await f.schedule();
  await eventually(async () => (await f.history())[0]?.status === "submitted");
  await f.wrapper.send({ type: "abort" });
  await eventually(() => !f.wrapper.isRunning());
  assert.equal(f.notifications().length, 0, "SDK clearQueue drops queued custom follow-ups too");
  await f.wrapper.send({ type: "prompt", message: "next ordinary run" });
  await eventually(() => !f.wrapper.isRunning());
  assert.equal(f.notifications().length, 0);
  const history = await f.history();
  assert.equal(history[0].wakeupId, timer.wakeupId);
  assert.equal(history[0].status, "submitted");
  assert.deepEqual(history[0].events.map((e) => e.event), ["created", "submitted"]);
  assert.deepEqual(f.runtime.list(), []);
});
