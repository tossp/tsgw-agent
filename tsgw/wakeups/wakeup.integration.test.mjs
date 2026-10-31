import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, Type } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWakeupHost } = await jiti.import("./host.ts");
const { createWakeupExtension, WAKEUP_TOOL_NAMES } = await jiti.import("./extension.ts");
const { WAKEUP_META_TYPE, WAKEUP_NOTIFICATION_TYPE } = await jiti.import("./history.ts");
const { createSessionOwnerAccess } = await jiti.import("./session-owner.ts");
const { AgentSessionWrapper, startRpcSession, getRpcSession, getRpcStartingSessionIds } = await jiti.import("../../lib/rpc-manager.ts");
const answer = (text = "done") => fauxAssistantMessage([fauxText(text)]);
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const textOf = (message) => message.content.map((block) => block.text ?? "").join("");
const notifications = (manager) => manager.getEntries().filter((entry) =>
  entry.type === "custom_message" && entry.customType === WAKEUP_NOTIFICATION_TYPE);
const records = (manager) => manager.getEntries().filter((entry) =>
  entry.type === "custom" && entry.customType === WAKEUP_META_TYPE);

async function eventually(check) {
  const end = Date.now() + 5_000;
  do {
    if (await check()) return;
    await delay(10);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for SDK wakeup state");
}

// Only the host registry/reopen/MCP boundary is substituted. Every transcript, tool
// dispatch, follow-up queue and model turn below uses the real SDK and a local faux provider.
async function withFixture(check) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-wakeup-sdk-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const registry = new Map(), targets = new Map(), wrappers = new Set(), runtimes = new Set(), releases = [];
  const reopened = [];
  let runtime;
  const access = {
    getSession: (id) => registry.get(id),
    resolvePath: async (id) => targets.get(id)?.file ?? null,
    withSessionOwner: createSessionOwnerAccess((id) => registry.get(id), () => null),
    async reopenSession(id, file) {
      reopened.push(id);
      assert.equal(file, targets.get(id).file);
      assert.ok(existsSync(file), "reopen must never let SessionManager create a replacement session");
      const manager = SessionManager.open(file);
      assert.equal(manager.getSessionId(), id);
      return open(targets.get(id), manager);
    },
  };
  const restart = () => {
    runtime?.dispose();
    runtime = createWakeupHost(access);
    runtimes.add(runtime);
    return runtime;
  };
  const open = async (target, manager = target.manager, extensionFactories = []) => {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(target.faux.provider);
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [createWakeupExtension(runtime), ...extensionFactories],
      },
    });
    const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: manager, model: target.faux.getModel("faux-model") });
    const wrapper = new AgentSessionWrapper(inner, { mcpHost: target.mcpHost });
    wrappers.add(wrapper);
    wrapper.start();
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    target.wrapper = wrapper;
    registry.set(target.id, wrapper);
    return wrapper;
  };
  const create = async ({ live = true, forkOf, extensions = [], mcpHost } = {}) => {
    const manager = forkOf ? SessionManager.forkFrom(forkOf.file, dir, join(dir, "sessions"))
      : SessionManager.create(dir, join(dir, "sessions"));
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "Isolated SDK fixture" }], timestamp: Date.now() });
    const target = { manager, file: manager.getSessionFile(), id: manager.getSessionId(), mcpHost,
      faux: fauxProvider({ models: [{ id: "faux-model" }] }) };
    assert.ok(existsSync(target.file));
    targets.set(target.id, target);
    if (live) await open(target, manager, extensions);
    return target;
  };
  const hold = () => {
    let release;
    const gate = { entered: false, promise: new Promise((resolve) => { release = resolve; }) };
    gate.release = release;
    gate.response = async () => { gate.entered = true; await gate.promise; return answer("released"); };
    releases.push(release);
    return gate;
  };
  try {
    restart();
    await check({ create, hold, restart, access, dir, registry, reopened, get runtime() { return runtime; } });
  } finally {
    for (const item of runtimes) item.dispose();
    for (const release of releases) release();
    await Promise.all([...wrappers].map((wrapper) => wrapper.inner.abort()));
    await Promise.all([...wrappers].map((wrapper) => wrapper.shutdown()));
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}

async function invoke(target, name, args) {
  target.faux.setResponses([call(name, args), answer()]);
  await target.wrapper.inner.prompt(`Call ${name}`);
  const result = target.wrapper.inner.agent.state.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  assert.equal(result?.isError, false, result && textOf(result));
  // AgentSession's persisted toolResult omits structuredContent. Check the model's
  // text/details here; the nested SDK dispatcher below checks structuredContent itself.
  assert.deepEqual(JSON.parse(textOf(result)), result.details);
  return result.details;
}

test("four wakeup tools work directly and via ctx.executeTool with structured results, without waiting", { timeout: 20_000 }, async () => {
  const outcomes = [];
  const script = (pi) => pi.registerTool({
    name: "script", label: "script", description: "Exercise nested tool dispatch", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const run = async (name, args) => {
        const outcome = await ctx.executeTool(name, args);
        outcomes.push({ name, ...outcome });
        return outcome.result.structuredContent;
      };
      const timer = await run("schedule_wakeup", { after_seconds: 60, message: "nested reminder" });
      await run("list_wakeups", {});
      await run("list_session_wakeups", { session_id: timer.targetSessionId });
      await run("cancel_wakeup", { wakeup_id: timer.wakeupId });
      return { content: [{ type: "text", text: "script done" }], details: undefined };
    },
  });
  await withFixture(async (f) => {
    const source = await f.create({ extensions: [script] });
    const session = source.wrapper.inner;
    for (const name of WAKEUP_TOOL_NAMES) {
      assert.ok(session.getActiveToolNames().includes(name), name);
      assert.ok(session.getCallableToolNames().includes(name), name);
    }
    const timer = await invoke(source, "schedule_wakeup", { after_seconds: 60, message: "self reminder" });
    assert.match(timer.wakeupId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(timer.sourceSessionId, source.id);
    assert.equal(timer.targetSessionId, source.id);
    assert.ok(Date.now() < Date.parse(timer.scheduledAt), "the model finished before the timer was due");
    assert.equal(records(source.manager)[0].data.event, "created");
    assert.deepEqual(await invoke(source, "list_wakeups", {}), [timer]);
    assert.equal((await invoke(source, "list_session_wakeups", { session_id: source.id }))[0].active, true);
    assert.deepEqual(await invoke(source, "cancel_wakeup", { wakeup_id: timer.wakeupId }), timer);
    let declared;
    source.faux.setResponses([(context) => {
      declared = getCurrentTools(context.messages).map((tool) => tool.name);
      return call("script", {});
    }, answer()]);
    await session.prompt("Exercise all nested calls");
    for (const name of WAKEUP_TOOL_NAMES) assert.ok(declared.includes(name), name);
    assert.deepEqual(outcomes.map((item) => item.name), ["schedule_wakeup", "list_wakeups", "list_session_wakeups", "cancel_wakeup"]);
    for (const item of outcomes) {
      assert.equal(item.isError, false, item.name);
      assert.deepEqual(item.result.structuredContent, item.result.details);
      assert.deepEqual(JSON.parse(textOf(item.result)), item.result.structuredContent);
    }
    assert.deepEqual(f.runtime.list(), []);
    assert.equal(notifications(source.manager).length, 0);
  });
});

test("model-scheduled self wakeup follows the current turn and keeps metadata on the live branch", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const source = await f.create();
    const first = f.hold(), second = f.hold();
    source.faux.setResponses([
      call("schedule_wakeup", { after_seconds: 0.05, message: "continue my own task later" }),
      first.response, second.response,
    ]);
    const running = source.wrapper.inner.prompt("Schedule a self wakeup, then finish this turn");
    await eventually(() => first.entered);
    await eventually(async () => (await f.runtime.history(source.id))[0]?.status === "submitted");
    assert.equal(second.entered, false);
    assert.equal(source.faux.state.callCount, 2, "the wakeup must not interrupt the current answer");
    first.release();
    await eventually(() => second.entered);
    assert.equal(notifications(source.manager)[0].details.targetSessionId, source.id);
    second.release();
    await running;
    const branchIds = new Set(source.manager.getBranch().map((entry) => entry.id));
    for (const entry of [...records(source.manager), ...notifications(source.manager)]) {
      assert.ok(branchIds.has(entry.id), "timer metadata and notification must not become a dead branch");
    }
    assert.deepEqual(records(source.manager).map((entry) => entry.data.event), ["created", "submitted"]);
    assert.deepEqual(f.runtime.list(), []);
  });
});

test("busy target queues a followUp without interruption; submitted is acceptance, not task completion", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const source = await f.create(), target = await f.create();
    const first = f.hold(), second = f.hold();
    const requests = [];
    target.manager.appendCustomEntry(WAKEUP_META_TYPE, { privateMarker: "NOT_MODEL_CONTEXT" });
    target.faux.setResponses([(context) => { requests.push(context); return first.response(); },
      (context) => { requests.push(context); return second.response(); }]);
    const running = target.wrapper.inner.prompt("Finish this work before handling follow-ups");
    await eventually(() => first.entered);
    const timer = await invoke(source, "schedule_wakeup", { session_id: target.id, after_seconds: 0.05, message: "cross-session handoff" });
    await eventually(async () => (await f.runtime.history(target.id))[0]?.status === "submitted");
    assert.equal(first.entered, true);
    assert.equal(second.entered, false, "followUp must not steer or interrupt the busy turn");
    assert.equal(target.faux.state.callCount, 1);
    assert.equal(target.wrapper.inner.isStreaming, true);
    assert.equal(notifications(target.manager).length, 0, "queue acceptance is not delivery to the transcript yet");
    assert.equal(records(source.manager).length, 0, "cross-session metadata belongs only to the target");
    assert.equal(records(target.manager).find((entry) => entry.data.event === "created").data.sourceSessionId, source.id);
    first.release();
    await eventually(() => second.entered);
    const notification = notifications(target.manager)[0];
    assert.equal(notification.customType, WAKEUP_NOTIFICATION_TYPE);
    assert.equal(notification.details.wakeupId, timer.wakeupId);
    assert.equal(notification.details.sourceSessionId, source.id);
    assert.equal(notification.display, true);
    assert.match(notification.content, /cross-session handoff/);
    assert.match(notification.content, /not a new message from the user/);
    assert.equal((await f.runtime.history(target.id))[0].status, "submitted");
    assert.equal(target.wrapper.inner.isStreaming, true, "submitted cannot mean the gated model task completed");
    assert.ok(!JSON.stringify(requests).includes("NOT_MODEL_CONTEXT"), "custom metadata must never enter model requests");
    assert.ok(!JSON.stringify(requests).includes(WAKEUP_META_TYPE));
    assert.ok(JSON.stringify(requests[1]).includes("cross-session handoff"), "custom_message is model-visible");
    second.release();
    await running;
    assert.equal(target.wrapper.inner.agent.state.messages.filter((message) => message.role === "assistant").every((message) => message.stopReason !== "aborted"), true);
    assert.equal(f.reopened.length, 0);
  });
});

test("idle and closed ordinary forks receive custom_message; subagent metadata refuses scheduling and reopen", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const source = await f.create();
    for (const closed of [false, true]) {
      const target = await f.create({ forkOf: source });
      assert.equal(target.manager.getHeader().parentSession, source.file);
      if (closed) {
        await target.wrapper.shutdown();
        f.registry.delete(target.id);
      }
      const gate = f.hold();
      target.faux.setResponses([gate.response]);
      const when = closed ? { at: new Date(Date.now() + 40).toISOString() } : { after_seconds: 0.03 };
      const timer = await f.runtime.schedule(source.id, { session_id: target.id, ...when, message: "wake the ordinary fork" });
      await eventually(async () => gate.entered && (await f.runtime.history(target.id))[0]?.status === "submitted");
      const manager = target.wrapper.inner.sessionManager;
      assert.equal(notifications(manager)[0].details.wakeupId, timer.wakeupId);
      assert.equal(target.wrapper.inner.isStreaming, true, "idle admission must not wait for model completion");
      assert.equal(f.reopened.includes(target.id), closed);
      gate.release();
      await eventually(() => !target.wrapper.inner.isStreaming);
      assert.equal(JSON.parse((await readFile(target.file, "utf8")).trim().split("\n").find((line) => JSON.parse(line).type === "custom_message")).customType, WAKEUP_NOTIFICATION_TYPE);
    }
    const child = await f.create({ live: false });
    child.manager.appendCustomEntry("pi-web:subagent", {}); // Presence is sufficient; no parentSession header needed.
    const before = await readFile(child.file);
    await assert.rejects(f.runtime.schedule(source.id, { session_id: child.id, after_seconds: 0.01, message: "forbidden" }), /subagent/i);
    assert.deepEqual(await readFile(child.file), before);
    assert.ok(!f.reopened.includes(child.id));
    // Re-check at delivery too: a pending target that later acquires subagent metadata must not reopen.
    const changed = await f.create({ live: false });
    await f.runtime.schedule(source.id, { session_id: changed.id, after_seconds: 0.03, message: "now forbidden" });
    SessionManager.open(changed.file).appendCustomEntry("pi-web:subagent", {});
    await eventually(() => f.runtime.list().length === 0);
    await delay(80);
    assert.ok(!f.reopened.includes(changed.id));
    assert.equal(notifications(SessionManager.open(changed.file)).length, 0);
  });
});

test("cancel and runtime rebuild never replay timers; history reads preserve bytes/mtime and never start targets", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const source = await f.create(), target = await f.create({ live: false });
    const cancelled = await f.runtime.schedule(source.id, { session_id: target.id, after_seconds: 0.05, message: "cancel me" });
    await f.runtime.cancel(cancelled.wakeupId);
    await delay(100); // Verify cancellation on the original runtime, not hidden by disposing it.
    assert.deepEqual(f.reopened, []);
    assert.equal(target.faux.state.callCount, 0);
    assert.deepEqual(f.runtime.list(), []);
    await f.runtime.schedule(source.id, { session_id: target.id, after_seconds: 0.15, message: "lost on restart" });
    const before = await readFile(target.file), mtime = (await stat(target.file)).mtimeMs;
    const fromTool = await invoke(source, "list_session_wakeups", { session_id: target.id });
    assert.deepEqual(fromTool.map((item) => [item.status, item.active]), [["cancelled", false], ["created", true]]);
    assert.deepEqual(await readFile(target.file), before);
    assert.equal((await stat(target.file)).mtimeMs, mtime);
    assert.deepEqual(f.reopened, []);
    const rebuilt = f.restart();
    assert.deepEqual(rebuilt.list(), []);
    const history = await rebuilt.history(target.id);
    assert.deepEqual(history.map((item) => [item.status, item.active]), [["cancelled", false], ["inactive", false]]);
    await delay(220);
    assert.deepEqual(await rebuilt.history(target.id), history);
    assert.deepEqual(await readFile(target.file), before);
    assert.equal((await stat(target.file)).mtimeMs, mtime);
    assert.deepEqual(f.reopened, []);
    assert.equal(f.registry.has(target.id), false);
    assert.equal(target.faux.state.callCount, 0);
    await assert.rejects(rebuilt.cancel(cancelled.wakeupId), /not pending/i);
  });
});

test("deleted target is never recreated or reopened when its timer fires", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const source = await f.create(), target = await f.create({ live: false });
    await f.runtime.schedule(source.id, { session_id: target.id, after_seconds: 0.04, message: "do not recreate" });
    await rm(target.file);
    await eventually(() => f.runtime.list().length === 0);
    await delay(50); // Let delivery's failed-history append settle too (the deleted file cannot record it).
    assert.equal(existsSync(target.file), false);
    assert.deepEqual(f.reopened, []);
    assert.equal(target.faux.state.callCount, 0);
    await assert.rejects(f.runtime.schedule(source.id, { session_id: target.id, after_seconds: 1, message: "still missing" }));
    assert.equal(existsSync(target.file), false);
  });
});

test("wakeups and ordinary prompts share real wrapper admission, not an entire model turn", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const connection = f.hold(), model = f.hold();
    let active = 0, maxActive = 0, preparations = 0, attempts = 0;
    const target = await f.create({ mcpHost: {
      async prepareForPrompt(signal) {
        preparations++;
        maxActive = Math.max(maxActive, ++active);
        try { await connection.promise; signal.throwIfAborted(); } finally { active--; }
      },
      dispose() {},
    } });
    const wrapper = target.wrapper;
    const acquire = wrapper.acquirePromptAdmission.bind(wrapper);
    wrapper.acquirePromptAdmission = () => { attempts++; return acquire(); }; // Observe, never replace, the real lock.
    target.faux.setResponses([model.response, answer("second wakeup"), answer("ordinary follow-up")]);
    await f.runtime.schedule(target.id, { after_seconds: 0.01, message: "first concurrent wakeup" });
    await f.runtime.schedule(target.id, { after_seconds: 0.01, message: "second concurrent wakeup" });
    await eventually(() => attempts === 2);
    assert.equal(active, 1);
    assert.equal(preparations, 1, "the second wakeup cannot overwrite the first MCP cancellation handle");
    let ordinaryAccepted = false;
    const ordinary = wrapper.send({ type: "prompt", message: "ordinary queued prompt", streamingBehavior: "followUp" })
      .then(() => { ordinaryAccepted = true; });
    await eventually(() => attempts === 3);
    assert.equal(ordinaryAccepted, false, "ordinary send must join the same admission queue");
    connection.release();
    await eventually(async () => model.entered && ordinaryAccepted
      && (await f.runtime.history(target.id)).every((item) => item.status === "submitted"));
    assert.equal(maxActive, 1);
    assert.equal(preparations, 1, "streaming follow-ups reuse the ready MCP host");
    assert.equal(target.faux.state.callCount, 1, "all admissions finish while the first model response is still held");
    assert.equal(wrapper.inner.isStreaming, true);
    model.release();
    await ordinary;
    await eventually(() => !wrapper.isRunning());
    assert.equal(notifications(target.manager).length, 2);
    assert.ok(wrapper.inner.agent.state.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("ordinary queued prompt")));
  });
});

test("deletion after a valid snapshot is rejected by real strict start before opening or creating services", { timeout: 20_000 }, async (t) => {
  await withFixture(async (f) => {
    const target = await f.create({ live: false });
    const starting = getRpcStartingSessionIds();
    assert.equal(getRpcSession(target.id), undefined);
    let rejection, opened, services;
    f.access.reopenSession = async (id, file) => {
      f.reopened.push(id); // Reaching here proves the host already read a valid snapshot.
      await rm(file);
      // Tripwires, not a fake strict-start implementation: old code must fail without
      // creating a replacement ID, services, loading extensions, or reaching a provider.
      opened = t.mock.method(SessionManager, "open", () => assert.fail("strict start reached SessionManager.open on a deleted file"));
      services = t.mock.method(SettingsManager, "create", () => assert.fail("strict start reached services preparation"));
      try { return (await startRpcSession(id, file, undefined, { requireExistingSession: true })).session; }
      catch (error) { rejection = error; throw error; }
    };
    await f.runtime.schedule(target.id, { after_seconds: 0.03, message: "deleted between snapshot and reopen" });
    await eventually(() => rejection !== undefined);
    assert.match(rejection.message, /not found|deleted|exist|ENOENT/i);
    assert.equal(opened.mock.callCount(), 0);
    assert.equal(services.mock.callCount(), 0);
    assert.deepEqual(f.reopened, [target.id]);
    assert.equal(getRpcSession(target.id), undefined);
    assert.deepEqual(getRpcStartingSessionIds(), starting);
    assert.equal(existsSync(target.file), false);
    assert.equal(target.faux.state.callCount, 0);
    await delay(30); // Allow the non-recreating failed-history append to settle.
  });
});

test("host rejects a reopened wrapper whose actual session ID differs from the target", { timeout: 20_000 }, async () => {
  await withFixture(async (f) => {
    const target = await f.create({ live: false }), wrong = await f.create();
    f.access.reopenSession = async () => wrong.wrapper;
    await f.runtime.schedule(target.id, { after_seconds: 0.03, message: "must not reach the wrong session" });
    await eventually(async () => (await f.runtime.history(target.id))[0]?.status === "failed");
    const history = await f.runtime.history(target.id);
    assert.match(history[0].events.at(-1).error, /id|match/i);
    assert.equal(notifications(wrong.manager).length, 0);
    assert.equal(wrong.faux.state.callCount, 0);
    assert.equal(target.faux.state.callCount, 0);
    assert.equal(records(wrong.manager).length, 0);
  });
});
