import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { WakeupRuntime } = await jiti.import("./runtime.ts");
const { WakeupStore } = await jiti.import("./store.ts");
const { writePrivateFileAtomicSync } = await jiti.import("../../lib/atomic-file.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));

// Real state files and runtime transitions; ownership is injected to control loss
// precisely. The ownership suite separately exercises proper-lockfile processes.
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 15) });
  t.mock.method(console, "error", () => {});
  const directory = mkdtempSync(join(tmpdir(), "wakeup-runtime-state-"));
  const stateFile = join(directory, "state.json");
  const audit = [], calls = [], runtimes = [];
  let failWrite = false, targetExists = true, lost;
  const stateStore = new WakeupStore(stateFile, { write(file, contents) {
    if (failWrite) throw new Error("injected state write failure");
    writePrivateFileAtomicSync(file, contents);
  } });
  const sessions = {
    async assertTarget() {
      if (!targetExists) throw new Error("target deleted");
      return { cwd: "/isolated/project" };
    },
    async append(value) {
      if (options.failAudit) throw new Error("injected audit failure");
      audit.push(value);
    },
    async read() { return []; },
    ...(options.create ? { create: options.create } : {}),
    ...(options.receipt ? { receipt: options.receipt } : {}),
  };
  const restart = () => {
    runtimes.at(-1)?.dispose();
    const runtime = new WakeupRuntime(sessions, async (task, context) => {
      if (!targetExists) throw new Error("target deleted");
      calls.push(task);
      if (options.deliver) await options.deliver(task, context, runtime);
    }, {
      stateFile, store: stateStore,
      async acquireOwnership(_directory, onLost) {
        let owner = true;
        lost = () => { owner = false; onLost(new Error("ownership lost")); };
        return { isOwner: () => owner, async release() { owner = false; } };
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(() => { for (const runtime of runtimes) runtime.dispose(); rmSync(directory, { recursive: true, force: true }); });
  return {
    stateFile, stateStore, restart, calls, audit, lose: () => lost(),
    failWrites: () => { failWrite = true; }, deleteTarget: () => { targetExists = false; },
    get runtime() { return runtimes.at(-1); },
    schedule: input => runtimes.at(-1).schedule("source", { after_seconds: 60, message: "handoff", ...input }),
    tick: async milliseconds => { t.mock.timers.tick(milliseconds); await flush(); },
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

test("pending state survives restart and an overdue task is submitted only once", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  assert.equal(f.state().tasks[0].status, "pending");
  f.runtime.dispose();
  await f.tick(120_000);
  assert.equal(f.calls.length, 0);
  await f.restart().ready();
  await f.tick(0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].wakeupId, task.wakeupId);
  assert.equal(f.state().tasks[0].status, "submitted");
  await f.restart().ready();
  await f.tick(120_000);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.runtime.query({ wakeup_id: task.wakeupId })).items[0].status, "unknown");
});

test("cancel is durable and cancelled state never restores a timer", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  await f.runtime.cancel(task.wakeupId);
  await f.restart().ready();
  await f.tick(120_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().tasks[0].status, "cancelled");
  assert.deepEqual(f.runtime.list(), []);
});

test("a target deleted before a restored pending task fires stays deleted", async t => {
  const f = fixture(t);
  f.restart();
  await f.schedule();
  f.deleteTarget();
  await f.restart().ready();
  await f.tick(60_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state().tasks[0].status, "delivery_failed");
  await f.restart().ready();
  await f.tick(60_000);
  assert.equal(f.calls.length, 0);
});

test("dispatching is saved before host delivery and a crash never replays it", async t => {
  let accepted = 0;
  const f = fixture(t, { deliver: async (_task, context) => {
    assert.equal(f.state().tasks[0].status, "dispatching");
    f.runtime.dispose();
    context.assertCanSubmit();
    accepted++;
  } });
  f.restart();
  await f.schedule();
  await f.tick(60_000);
  assert.equal(accepted, 0);
  await f.restart().ready();
  await f.tick(60_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state().tasks[0].status, "unknown");
});

test("state write failure before creation returns no schedule and arms no timer", async t => {
  const f = fixture(t);
  f.restart();
  await f.runtime.ready();
  f.failWrites();
  await assert.rejects(f.schedule(), /state write failure/);
  assert.equal(existsSync(f.stateFile), false);
  const query = await f.runtime.query();
  assert.equal(query.health.state, "storage_error");
  assert.deepEqual(f.runtime.list(), []);
  await f.tick(120_000);
  assert.equal(f.calls.length, 0);
});

test("failure to save dispatching pauses all timers and shows pending as unarmed", async t => {
  const f = fixture(t);
  f.restart();
  await f.schedule();
  await f.schedule({ after_seconds: 120 });
  f.failWrites();
  await f.tick(60_000);
  const query = await f.runtime.query();
  assert.equal(query.health.state, "storage_error");
  assert.ok(query.items.every(item => item.status === "pending" && !item.armed));
  assert.deepEqual(f.runtime.list(), []);
  await f.tick(120_000);
  assert.equal(f.calls.length, 0);
  assert.ok(f.state().tasks.every(item => item.status === "pending"));
});

test("accepted delivery whose state write fails stays accepted in memory, never delivery_failed", async t => {
  let accepted = 0;
  const f = fixture(t, { deliver: async () => { accepted++; f.failWrites(); } });
  f.restart();
  const task = await f.schedule();
  await f.tick(60_000);
  const query = await f.runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(query.health.state, "storage_error");
  assert.equal(query.items[0].status, "submitted");
  assert.equal(query.items[0].unsaved, true);
  assert.equal(f.state().tasks[0].status, "dispatching");
  assert.equal(f.audit.some(event => event.event === "failed"), false);
  await f.tick(120_000);
  assert.equal(accepted, 1);
});

test("failed cancellation save leaves durable pending but pauses its timer", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  f.failWrites();
  await assert.rejects(f.runtime.cancel(task.wakeupId), error => error.details.cancellationConfirmed === false);
  const query = await f.runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(query.items[0].status, "pending");
  assert.equal(query.items[0].armed, false);
  assert.equal(query.health.state, "storage_error");
  assert.equal(f.state().tasks[0].status, "pending");
});

test("audit failures do not undo a durable schedule or cancellation", async t => {
  const f = fixture(t, { failAudit: true });
  f.restart();
  const task = await f.schedule();
  assert.equal(task.diagnostics[0].code, "wakeup_audit_not_saved");
  const cancelled = await f.runtime.cancel(task.wakeupId);
  assert.equal(cancelled.diagnostics[0].code, "wakeup_audit_not_saved");
  assert.equal(f.state().tasks[0].status, "cancelled");
  assert.equal((await f.runtime.query()).health.state, "ready");
});

test("receipt and settled observed before send resolves cannot be downgraded by submitted", async t => {
  const f = fixture(t, { deliver: async (task, _context, runtime) => {
    const at = new Date().toISOString();
    runtime.observe({ wakeupId: task.wakeupId, type: "received", at, runId: "run", notificationEntryId: "notice" });
    runtime.observe({ wakeupId: task.wakeupId, type: "settled", at, runId: "run", aborted: false, responseEntryIds: ["response"] });
  } });
  f.restart();
  const task = await f.schedule();
  await f.tick(60_000);
  const item = (await f.runtime.query({ wakeup_id: task.wakeupId })).items[0];
  assert.equal(item.status, "run_settled");
  assert.ok(item.submittedAt && item.receivedAt && item.settledAt);
  assert.deepEqual(item.responseEntryIds, ["response"]);
  await f.restart().ready();
  assert.equal((await f.runtime.query({ wakeup_id: task.wakeupId })).items[0].status, "run_settled");
});

for (const failBeforeReceipt of [true, false]) test(`late acceptance preserves unsaved settled evidence (receipt saved: ${!failBeforeReceipt})`, async t => {
  const f = fixture(t, { deliver: async (task, _context, runtime) => {
    const at = new Date().toISOString();
    if (failBeforeReceipt) f.failWrites();
    runtime.observe({ wakeupId: task.wakeupId, type: "received", at, runId: "run", notificationEntryId: "notice" });
    f.failWrites();
    runtime.observe({ wakeupId: task.wakeupId, type: "settled", at, runId: "run", aborted: false, responseEntryIds: ["response"] });
  } });
  f.restart();
  const task = await f.schedule();
  await f.tick(60_000);
  const result = await f.runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(result.health.state, "storage_error");
  assert.equal(result.items[0].status, "run_settled");
  assert.equal(result.items[0].unsaved, true);
  assert.ok(result.items[0].receivedAt && result.items[0].settledAt && result.items[0].submittedAt);
  assert.deepEqual(result.items[0].responseEntryIds, ["response"]);
  assert.equal(f.state().tasks[0].status, failBeforeReceipt ? "dispatching" : "received");
});

test("Stop records uncertainty without claiming an individual queue removal", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  await f.tick(60_000);
  f.runtime.stopSession("source");
  let item = (await f.runtime.query({ wakeup_id: task.wakeupId })).items[0];
  assert.equal(item.status, "unknown");
  assert.equal(item.receivedAt, undefined);
  const at = new Date().toISOString();
  f.runtime.observe({ wakeupId: task.wakeupId, type: "received", at, runId: "run" });
  f.runtime.observe({ wakeupId: task.wakeupId, type: "settled", at, runId: "run", aborted: true });
  item = (await f.runtime.query({ wakeup_id: task.wakeupId })).items[0];
  assert.equal(item.status, "run_aborted");
  assert.equal(item.aborted, true);
});

test("ownership loss after preparation blocks the unsent host operation", async t => {
  let release, entered = false, submitted = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { deliver: async (_task, context) => {
    entered = true;
    await gate;
    context.assertCanSubmit();
    submitted++;
  } });
  f.restart();
  const task = await f.schedule();
  await f.tick(60_000);
  assert.equal(entered, true);
  f.lose();
  release();
  await flush();
  assert.equal(submitted, 0);
  const query = await f.runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(query.health.state, "paused");
  assert.equal(query.health.isOwner, false);
  assert.equal(query.items[0].status, "unknown");
  assert.equal(query.items[0].unsaved, true);
  assert.equal(f.state().tasks[0].status, "dispatching");
});

test("new session created before failed scheduling is returned as partial effect", async t => {
  let created = 0;
  const f = fixture(t, { create: async () => { created++; return { sessionId: "new-target", cwd: "/isolated/new-project" }; } });
  f.restart();
  await f.runtime.ready();
  f.failWrites();
  await assert.rejects(f.schedule({ cwd: "/isolated/new-project", title: "Later" }), error => {
    assert.equal(error.details.code, "session_created_wakeup_not_scheduled");
    assert.equal(error.details.targetSessionId, "new-target");
    assert.equal(error.details.scheduled, false);
    return true;
  });
  assert.equal(created, 1);
  assert.deepEqual(f.runtime.list(), []);
});

test("queries remain available while scheduler initialization waits for ownership", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const starting = new WakeupRuntime({}, async () => assert.fail("must not deliver"), {
    stateFile: f.stateFile,
    async acquireOwnership() { await gate; return { isOwner: () => true, async release() {} }; },
  });
  t.after(() => { release(); starting.dispose(); });
  const result = await Promise.race([starting.query({ wakeup_id: task.wakeupId }), flush().then(() => null)]);
  assert.ok(result, "query must not block on scheduler ownership acquisition");
  assert.equal(result.health.state, "starting");
  assert.equal(result.items[0].wakeupId, task.wakeupId);
  assert.equal(result.items[0].armed, false);
  release();
  await starting.ready();
});

test("read-only instance can inspect durable tasks but refuses scheduling and cancellation", async t => {
  const f = fixture(t);
  f.restart();
  const task = await f.schedule();
  const readOnly = new WakeupRuntime({}, async () => assert.fail("must not deliver"), {
    stateFile: f.stateFile,
    async acquireOwnership() { throw Object.assign(new Error("another owner"), { code: "ELOCKED" }); },
  });
  t.after(() => readOnly.dispose());
  await readOnly.ready();
  const result = await readOnly.query({ wakeup_id: task.wakeupId });
  assert.equal(result.health.state, "read_only");
  assert.equal(result.items[0].status, "pending");
  assert.equal(result.items[0].armed, false);
  await assert.rejects(readOnly.schedule("source", { after_seconds: 1, message: "task" }), /another owner/);
  await assert.rejects(readOnly.cancel(task.wakeupId), /another owner/);
});
