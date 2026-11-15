import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createWakeupObserver } = await createJiti(import.meta.url).import("./observer.ts");
const customType = "pi-web:wakeup-notification";
const answer = (text = "done") => fauxAssistantMessage([fauxText(text)]);
const message = (id, sessionId, overrides = {}) => ({
  customType, content: "Isolated wakeup", display: true,
  details: { wakeupId: id, targetSessionId: sessionId }, ...overrides,
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function eventually(check) {
  const end = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(5);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for SDK observation");
}

async function fixture(t, { extensions = [], retry = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wakeup-observer-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const gates = [];
  const hold = () => {
    let release;
    const gate = { entered: false, promise: new Promise((resolve) => { release = resolve; }) };
    gate.release = release;
    gate.response = async () => { gate.entered = true; await gate.promise; return answer("released"); };
    gates.push(gate);
    return gate;
  };
  const faux = fauxProvider({ models: [{ id: "observer-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extensions },
  });
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "saved isolated target", timestamp: Date.now() });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel("observer-model") });
  await session.bindExtensions({});
  const observations = [], events = [];
  const observer = createWakeupObserver(session.sessionId, manager, (value) => observations.push(value));
  const unsubscribe = session.subscribe((event) => { events.push(event); observer.onEvent(event); });
  t.after(async () => {
    observer.dispose();
    unsubscribe();
    for (const gate of gates) gate.release();
    await session.abort();
    session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, session, manager, faux, hold, observer, observations, events,
    send: (id, overrides) => session.sendCustomMessage(message(id, session.sessionId, overrides), { triggerTurn: true, deliverAs: "followUp" }),
  };
}

function assertEvidence(f, observation) {
  const notification = f.manager.getEntry(observation.notificationEntryId);
  assert.equal(notification.type, "custom_message");
  assert.equal(notification.customType, customType);
  assert.equal(notification.details.wakeupId, observation.wakeupId);
  assert.ok(f.manager.getEntry(observation.branchLeafId));
  assert.ok(observation.responseEntryIds?.length);
  for (const id of observation.responseEntryIds) {
    const entry = f.manager.getEntry(id);
    assert.equal(entry.type, "message");
    assert.equal(entry.message.role, "assistant");
  }
  assert.match(observation.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

test("idle receipt happens on message_start before persistence; later reads supply real IDs", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.hold();
  f.faux.setResponses([gate.response]);
  const running = f.send("idle");
  await eventually(() => gate.entered);
  const received = f.observations.filter((item) => item.type === "received");
  assert.ok(received.length);
  assert.equal(received[0].notificationEntryId, undefined, "SDK has not appended at message_start");
  assert.ok(received.some((item) => item.notificationEntryId), "later read must attach the real notification");
  assert.equal(f.observations.some((item) => item.type === "settled"), false);
  gate.release();
  await running;
  const settled = f.observations.find((item) => item.type === "settled");
  assert.equal(settled.aborted, false);
  assert.equal(settled.wakeupId, "idle");
  assert.equal(settled.runId, received[0].runId);
  assertEvidence(f, settled);
  assert.ok(received.every((item) => item.at === received[0].at));
});

test("busy follow-ups share one run and ordinary prompts do not create extra wakeup observations", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.hold();
  f.faux.setResponses([gate.response, answer("follow-ups")]);
  const running = f.session.prompt("ordinary initial prompt");
  await eventually(() => gate.entered);
  await f.send("one");
  await f.send("two");
  await f.session.prompt("ordinary queued follow-up", { streamingBehavior: "followUp" });
  assert.deepEqual(f.observations, [], "acceptance into the queue is not receipt");
  gate.release();
  await running;
  const settled = f.observations.filter((item) => item.type === "settled");
  assert.deepEqual(settled.map((item) => item.wakeupId).sort(), ["one", "two"]);
  assert.equal(new Set(settled.map((item) => item.runId)).size, 1);
  for (const item of settled) assertEvidence(f, item);
  assert.equal(settled[0].responseEntryIds.at(-1), settled[1].responseEntryIds.at(-1),
    "both receipts include the final response of their shared run");
  f.faux.setResponses([answer("new run")]);
  await f.send("three");
  const third = f.observations.find((item) => item.type === "settled" && item.wakeupId === "three");
  assert.notEqual(third.runId, settled[0].runId);
});

test("real automatic retry keeps the host runId across agent_end/agent_start until agent_settled", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { retry: true });
  f.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }), answer("retry recovered")]);
  await f.send("retry");
  assert.ok(f.events.filter((event) => event.type === "agent_start").length >= 2, "exercise actual SDK retry");
  assert.ok(f.events.some((event) => event.type === "auto_retry_start"));
  assert.equal(f.observations.filter((item) => item.type === "settled").length, 1);
  assert.equal(new Set(f.observations.map((item) => item.runId)).size, 1);
  const settled = f.observations.at(-1);
  assert.equal(settled.type, "settled");
  assert.equal(settled.aborted, false);
  assert.equal(settled.responseEntryIds.length, 2);
  assertEvidence(f, settled);
});

test("a final provider error is still a settled run, without a business-success inference", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" })]);
  await f.send("error");
  const settled = f.observations.find((item) => item.type === "settled");
  assert.equal(settled.aborted, false);
  assertEvidence(f, settled);
  assert.equal(f.manager.getEntry(settled.responseEntryIds[0]).message.stopReason, "error");
  assert.equal("success" in settled, false);
});

test("Recall of queued but unreceived notifications gives no fabricated per-message queue result", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.hold();
  f.faux.setResponses([gate.response]);
  const running = f.session.prompt("busy");
  await eventually(() => gate.entered);
  await f.send("queued");
  f.observer.onStop();
  f.session.clearQueue();
  assert.deepEqual(f.observations, []);
  gate.release();
  await running;
  assert.deepEqual(f.observations, []);
});

test("a dequeued notification delayed in turn_start may be received after Recall", { timeout: 15000 }, async (t) => {
  let entered = false, release;
  const boundary = new Promise((resolve) => { release = resolve; });
  let turns = 0;
  const f = await fixture(t, { extensions: [(pi) => pi.on("turn_start", async () => {
    if (++turns === 2) { entered = true; await boundary; }
  })] });
  t.after(() => release());
  const gate = f.hold();
  f.faux.setResponses([gate.response, answer("received despite recall")]);
  const running = f.session.prompt("busy before handoff");
  await eventually(() => gate.entered);
  await f.send("dequeued");
  gate.release();
  await eventually(() => entered);
  assert.equal(f.observations.some((item) => item.wakeupId === "dequeued"), false);
  f.observer.onStop();
  f.session.clearQueue();
  release();
  await running;
  assert.ok(f.observations.some((item) => item.type === "received" && item.wakeupId === "dequeued"));
  assert.ok(f.observations.some((item) => item.type === "settled" && item.wakeupId === "dequeued"));
});

test("Stop marks a received item uncertain while later persisted evidence and aborted settlement remain observable", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.hold();
  f.faux.setResponses([gate.response]);
  const running = f.send("stopped");
  await eventually(() => gate.entered);
  const runId = f.observations[0].runId;
  f.observer.onStop();
  assert.equal(f.observations.at(-1).type, "uncertain");
  const stopping = f.session.abort();
  gate.release();
  await stopping;
  await running;
  const settled = f.observations.find((item) => item.type === "settled");
  assert.equal(settled.aborted, true);
  assert.equal(settled.runId, runId);
  assertEvidence(f, settled);
  assert.ok(f.observations.some((item, index) => item.type === "received" && index > f.observations.findIndex((o) => o.type === "uncertain")));
});

test("dispose reports uncertainty once and releases tracking, ignoring subsequent events and Stop", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.hold();
  f.faux.setResponses([gate.response]);
  const running = f.send("disposed");
  await eventually(() => gate.entered);
  f.observer.dispose();
  const count = f.observations.length;
  assert.equal(f.observations.at(-1).type, "uncertain");
  f.observer.dispose();
  f.observer.onStop();
  gate.release();
  await running;
  await nextTurn();
  assert.equal(f.observations.length, count);
});

test("receipt evidence does not feed back indefinitely when the owner appends audit entries", () => {
  const manager = SessionManager.inMemory();
  const id = manager.getSessionId();
  const observations = [];
  let observer;
  observer = createWakeupObserver(id, manager, (item) => {
    observations.push(item);
    assert.ok(observations.length < 5, "audit appends caused recursive receipt updates");
    const audit = manager.appendCustomEntry("pi-web:wakeup", { event: item.type });
    observer.onEvent({ type: "entry_appended", entry: manager.getEntry(audit) });
  });
  observer.onEvent({ type: "agent_start" });
  observer.onEvent({ type: "message_start", message: { ...message("audited", id), role: "custom", timestamp: Date.now() } });
  const entry = manager.appendCustomMessageEntry(customType, "notification", true, { wakeupId: "audited", targetSessionId: id });
  observer.onEvent({ type: "entry_appended", entry: manager.getEntry(entry) });
  assert.equal(observations.length, 2, "initial receipt plus its real entry evidence");
  assert.equal(observations.at(-1).notificationEntryId, entry);
  assert.equal(observations.at(-1).branchLeafId, entry);
  observer.onEvent({ type: "agent_settled", aborted: false });
  assert.equal(observations.at(-1).type, "settled");
  observer.dispose();
});

test("only matching custom notifications count; entry_appended supplies evidence but never invents receipt", async () => {
  const manager = SessionManager.inMemory();
  const observations = [];
  const observer = createWakeupObserver(manager.getSessionId(), manager, (item) => observations.push(item));
  const id = manager.getSessionId();
  observer.onEvent({ type: "agent_start" });
  for (const value of [message("wrong", "another-session"), message("other", id, { customType: "extension" }), message("empty", id, { details: {} })]) {
    observer.onEvent({ type: "message_start", message: { ...value, role: "custom", timestamp: Date.now() } });
  }
  const old = manager.appendCustomMessageEntry(customType, "old", true, { wakeupId: "old", targetSessionId: id });
  observer.onEvent({ type: "entry_appended", entry: manager.getEntry(old) });
  assert.deepEqual(observations, []);
  observer.onEvent({ type: "message_start", message: { ...message("actual", id), role: "custom", timestamp: Date.now() } });
  assert.equal(observations[0].notificationEntryId, undefined);
  assert.equal(observations[0].branchLeafId, undefined, "a previous leaf is not this notification's branch");
  const actual = manager.appendCustomMessageEntry(customType, "actual", true, { wakeupId: "actual", targetSessionId: id });
  observer.onEvent({ type: "entry_appended", entry: manager.getEntry(actual) });
  assert.equal(observations.at(-1).notificationEntryId, actual);
  assert.equal(observations.at(-1).branchLeafId, actual);
  observer.onEvent({ type: "agent_settled", aborted: false });
  observer.dispose();
  assert.equal(observations.at(-1).type, "settled");
});
