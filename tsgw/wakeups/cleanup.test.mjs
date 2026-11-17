import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { canClearWakeup } = await jiti.import("./cleanup.ts");
const { WakeupRuntime } = await jiti.import("./runtime.ts");
const { WakeupStore } = await jiti.import("./store.ts");
const { writePrivateFileAtomicSync } = await jiti.import("../../lib/atomic-file.ts");
const { getWakeupStateFile } = await jiti.import("./host.ts");
const { clearWakeupRecord } = await jiti.import("./server-query.ts");
const { DELETE: remove, GET: detail } = await jiti.import("../../app/api/tsgw/wakeups/[wakeupId]/route.ts");
const runtimeKey = Symbol.for("pi-web.wakeupRuntime");
const flush = () => new Promise(resolve => setImmediate(resolve));
const terminalStatuses = ["run_settled", "run_aborted", "delivery_failed", "cancelled", "closed"];
const task = (wakeupId, status = "cancelled") => ({
  wakeupId, sourceSessionId: "source", targetSessionId: "target", message: "handoff",
  createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
  scheduledAt: "2099-11-16T00:00:00.000Z", status,
  ...(["run_settled", "run_aborted"].includes(status) ? { settledAt: "2026-11-15T00:01:00.000Z" } : {}),
});

function fixture(t, tasks = [], options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wakeup-cleanup-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR, previousRuntime = globalThis[runtimeKey];
  process.env.PI_CODING_AGENT_DIR = directory;
  delete globalThis[runtimeKey];
  const stateFile = getWakeupStateFile();
  const disk = new WakeupStore(stateFile);
  disk.save(tasks);
  const runtimes = [], sessionCalls = [];
  let failWrite = false, lost;
  const store = new WakeupStore(stateFile, { write(file, contents) {
    if (failWrite) throw new Error("injected cleanup write failure");
    writePrivateFileAtomicSync(file, contents);
  } });
  // Every session operation is forbidden unless a delivery test explicitly needs it.
  const sessions = Object.fromEntries(["assertTarget", "append", "read", "create", "receipt"].map(key => [key, async () => {
    sessionCalls.push(key);
    assert.fail(`cleanup touched session ${key}`);
  }]));
  const restart = async () => {
    runtimes.at(-1)?.dispose();
    const runtime = new WakeupRuntime({ ...sessions, ...options.sessions }, options.deliver ?? (async () => assert.fail("cleanup must not deliver")), {
      stateFile, store,
      acquireOwnership: options.acquireOwnership ?? (async (_directory, onLost) => {
        let owner = true;
        lost = () => { owner = false; onLost(new Error("ownership lost")); };
        return { isOwner: () => owner, async release() { owner = false; } };
      }),
    });
    runtimes.push(runtime);
    globalThis[runtimeKey] = runtime;
    await runtime.ready();
    return runtime;
  };
  t.after(() => {
    for (const runtime of runtimes) runtime.dispose();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    rmSync(directory, { recursive: true, force: true });
    // Audit/receipt paths catch errors, so also detect calls whose failure was swallowed.
    assert.deepEqual(sessionCalls, [], "cleanup must not access session storage");
  });
  return { directory, stateFile, disk, restart, failWrites: (enabled = true) => { failWrite = enabled; }, lose: () => lost() };
}

const request = id => new Request(`http://localhost/api/tsgw/wakeups/${id}`, { method: "DELETE" });
const context = wakeupId => ({ params: Promise.resolve({ wakeupId }) });
const deleteRecord = id => remove(request(id), context(id));
async function expectStatus(id, status) {
  const response = await deleteRecord(id);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}

test("clearability permits only saved conclusive terminal states", () => {
  for (const status of [...terminalStatuses, "pending", "dispatching", "submitted", "received", "unknown"]) {
    assert.equal(canClearWakeup({ status }), terminalStatuses.includes(status), status);
    assert.equal(canClearWakeup({ status, unsaved: true }), false, `${status} unsaved`);
  }
});

test("startup clears completion/cancellation/closure, preserves failures and interruptions, and never touches sessions", async t => {
  const f = fixture(t, [...terminalStatuses.map(status => task(status, status)), task("keep", "pending")]);
  const sessionFile = join(f.directory, "target.jsonl");
  // The old audit remains on disk and must never rebuild cleared manifest tasks.
  writeFileSync(sessionFile, JSON.stringify({ type: "custom", customType: "pi-web:wakeup", data: task("cancelled") }) + "\n");
  const sessionBefore = readFileSync(sessionFile), sessionStat = statSync(sessionFile);
  let runtime = await f.restart();
  for (const status of ["run_settled", "cancelled", "closed"]) {
    await expectStatus(status, 404);
    runtime.observe({ type: "settled", wakeupId: status, at: new Date().toISOString() });
    assert.equal((await runtime.query({ wakeup_id: status })).items.length, 0);
  }
  assert.deepEqual(f.disk.read().map(item => item.wakeupId), ["run_aborted", "delivery_failed", "keep"]);
  runtime = await f.restart();
  assert.deepEqual((await runtime.query()).items.map(item => item.wakeupId).sort(), ["delivery_failed", "keep", "run_aborted"]);
  for (const status of ["run_aborted", "delivery_failed"]) {
    assert.equal((await runtime.query({ wakeup_id: status })).items[0].status, status);
    assert.deepEqual(await expectStatus(status, 200), { wakeupId: status });
  }
  runtime = await f.restart();
  assert.deepEqual((await runtime.query()).items.map(item => item.wakeupId), ["keep"]);
  assert.deepEqual(readFileSync(sessionFile), sessionBefore);
  assert.equal(statSync(sessionFile).mtimeMs, sessionStat.mtimeMs);
  await expectStatus("cancelled", 404);
  assert.throws(() => clearWakeupRecord("missing"), error => error.details.code === "wakeup_not_found");
});

for (const aborted of [false, true]) test(`settlement (aborted=${aborted}) ${aborted ? "retains the interruption" : "automatically clears completion"} and preserves audit`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 15) });
  const audit = [];
  const f = fixture(t, [], {
    sessions: { async assertTarget() {}, async append(record) { audit.push(record); } }, async deliver() {},
  });
  let runtime = await f.restart();
  const scheduled = await runtime.schedule("source", { after_seconds: 60, message: "handoff" });
  t.mock.timers.tick(60_000);
  await flush();
  const at = new Date().toISOString();
  runtime.observe({ type: "received", wakeupId: scheduled.wakeupId, at, runId: "run", notificationEntryId: "notice" });
  assert.equal(f.disk.read()[0].status, "received");
  runtime.observe({ type: "settled", wakeupId: scheduled.wakeupId, at, runId: "run", aborted, responseEntryIds: ["answer"] });
  if (aborted) {
    assert.equal((await runtime.query()).items[0].status, "run_aborted");
    assert.equal(f.disk.read()[0].status, "run_aborted");
  } else {
    assert.deepEqual((await runtime.query()).items, []);
    assert.deepEqual(f.disk.read(), []);
  }
  const settled = audit.find(record => record.event === (aborted ? "run_aborted" : "run_settled"));
  assert.equal(settled.notificationEntryId, "notice");
  assert.deepEqual(settled.responseEntryIds, ["answer"]);
  runtime = await f.restart();
  runtime.observe({ type: "received", wakeupId: scheduled.wakeupId, at, runId: "run" });
  if (aborted) {
    assert.equal((await runtime.query()).items[0].status, "run_aborted");
    await expectStatus(scheduled.wakeupId, 200);
  }
  assert.deepEqual((await runtime.query()).items, []);
});

test("automatic cleanup failure retains the saved settlement, pauses, then recovers on restart", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 15) });
  const f = fixture(t, [], {
    sessions: { async assertTarget() {}, async append(record) { if (record.event === "run_settled") f.failWrites(); } },
    async deliver() {},
  });
  let runtime = await f.restart();
  const scheduled = await runtime.schedule("source", { after_seconds: 60, message: "handoff" });
  t.mock.timers.tick(60_000);
  await flush();
  runtime.observe({ type: "settled", wakeupId: scheduled.wakeupId, at: new Date().toISOString() });
  const result = await runtime.query();
  assert.equal(result.health.state, "storage_error");
  assert.equal(result.items[0].status, "run_settled");
  assert.equal(result.items[0].unsaved, undefined);
  assert.equal(f.disk.read()[0].status, "run_settled");
  f.failWrites(false);
  runtime = await f.restart();
  assert.equal((await runtime.query()).health.state, "ready");
  assert.deepEqual(f.disk.read(), []);
});

test("startup cleanup failure keeps existing records and arms no pending timers", async t => {
  const f = fixture(t, [task("done", "run_settled"), task("pending", "pending")]);
  f.failWrites();
  const runtime = await f.restart();
  const result = await runtime.query();
  assert.equal(result.health.state, "storage_error");
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => !item.armed));
  assert.equal(f.disk.read().length, 2);
});

test("DELETE rejects pending and restored unknown tasks without changing the manifest", async t => {
  const statuses = ["pending", "dispatching", "submitted", "received", "unknown"];
  const f = fixture(t, statuses.map(status => task(status, status)), { sessions: { async receipt() { return null; } } });
  await f.restart();
  const before = readFileSync(f.stateFile);
  for (const id of statuses) await expectStatus(id, 409);
  assert.deepEqual(readFileSync(f.stateFile), before);
});

test("settled observations cannot clear a task while delivery still has a pending save", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 15) });
  let release, entered = false, runtime;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, [], {
    sessions: { async assertTarget() {}, async append() {} },
    async deliver() {
      entered = true;
      await gate;
    },
  });
  runtime = await f.restart();
  const scheduled = await runtime.schedule("source", { after_seconds: 60, message: "handoff" });
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(entered, true);
  assert.equal(f.disk.read()[0].status, "dispatching");
  await expectStatus(scheduled.wakeupId, 409);
  const at = new Date().toISOString();
  runtime.observe({ type: "received", wakeupId: scheduled.wakeupId, at, runId: "run" });
  assert.equal(f.disk.read()[0].status, "received");
  await expectStatus(scheduled.wakeupId, 409);
  runtime.observe({ type: "settled", wakeupId: scheduled.wakeupId, at, runId: "run" });
  assert.equal(f.disk.read()[0].status, "run_settled");
  await expectStatus(scheduled.wakeupId, 409);
  release();
  await flush();
  assert.deepEqual(f.disk.read(), []);
  await expectStatus(scheduled.wakeupId, 404);
  runtime.observe({ type: "received", wakeupId: scheduled.wakeupId, at, runId: "run" });
  assert.deepEqual((await runtime.query()).items, []);
});

test("DELETE rejects an accepted submitted task until a terminal observation arrives", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 10, 15) });
  const f = fixture(t, [], { sessions: { async assertTarget() {}, async append() {} }, async deliver() {} });
  const runtime = await f.restart();
  const scheduled = await runtime.schedule("source", { after_seconds: 60, message: "handoff" });
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(f.disk.read()[0].status, "submitted");
  await expectStatus(scheduled.wakeupId, 409);
  runtime.observe({ type: "settled", wakeupId: scheduled.wakeupId, at: new Date().toISOString(), aborted: true });
  assert.equal((await runtime.query()).items[0].status, "run_aborted");
  await expectStatus(scheduled.wakeupId, 200);
});

test("manual DELETE remains compatible while a cancellation audit is still finishing", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = fixture(t, [task("terminal", "pending")], {
    sessions: { async append(record) { if (record.event === "cancelled") await gate; } },
  });
  const runtime = await f.restart();
  const cancelling = runtime.cancel("terminal");
  await flush();
  assert.equal(f.disk.read()[0].status, "cancelled");
  assert.deepEqual(await expectStatus("terminal", 200), { wakeupId: "terminal" });
  release();
  await cancelling;
  assert.deepEqual(f.disk.read(), []);
});

test("failed cancellation cleanup retains the terminal record, pauses timers, and rejects subsequent writes", async t => {
  let before;
  const f = fixture(t, [task("terminal", "pending"), task("pending", "pending")], {
    sessions: { async append() { before = readFileSync(f.stateFile); f.failWrites(); } },
  });
  const runtime = await f.restart();
  assert.equal(runtime.list().length, 2);
  await runtime.cancel("terminal");
  const result = await runtime.query({ wakeup_id: "terminal" });
  assert.equal(result.health.state, "storage_error");
  assert.equal(result.items[0].status, "cancelled");
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.deepEqual(runtime.list(), []);
  await expectStatus("terminal", 503);
  assert.deepEqual(readFileSync(f.stateFile), before);
});

test("unsaved terminal observations are retained and cannot be cleared", async t => {
  const f = fixture(t, [task("observed", "unknown")], { sessions: { async receipt() { return null; } } });
  const runtime = await f.restart();
  const before = readFileSync(f.stateFile);
  f.failWrites();
  runtime.observe({ type: "settled", wakeupId: "observed", at: new Date().toISOString() });
  const item = (await runtime.query()).items[0];
  assert.equal(item.status, "run_settled");
  assert.equal(item.unsaved, true);
  assert.equal(canClearWakeup(item), false);
  await expectStatus("observed", 503);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal((await runtime.query()).items[0].unsaved, true);
});

test("DELETE without initialized runtime stays read-only and GET never acquires ownership", async t => {
  const f = fixture(t, [task("terminal")]);
  const before = readFileSync(f.stateFile), beforeStat = statSync(f.stateFile);
  await expectStatus("terminal", 503);
  assert.throws(() => clearWakeupRecord("terminal"), /not initialized/);
  const response = await detail(new Request("http://localhost/api/tsgw/wakeups/terminal"), context("terminal"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items[0].status, "cancelled");
  assert.equal(globalThis[runtimeKey], undefined);
  assert.equal(existsSync(join(dirname(f.stateFile), "owner")), false);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(statSync(f.stateFile).mtimeMs, beforeStat.mtimeMs);
});

test("DELETE refuses a starting runtime without waiting for or acquiring another owner", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, [task("terminal")], { async acquireOwnership() {
    await gate;
    return { isOwner: () => true, async release() {} };
  } });
  const starting = f.restart();
  try { await expectStatus("terminal", 503); }
  finally { release(); await starting; }
});

test("DELETE refuses a read-only instance and an owner that lost its lock", async t => {
  const f = fixture(t, [task("terminal")]);
  await f.restart();
  const before = readFileSync(f.stateFile);
  const readOnly = new WakeupRuntime({}, async () => assert.fail("must not deliver"), {
    stateFile: f.stateFile,
    async acquireOwnership() { throw Object.assign(new Error("another owner"), { code: "ELOCKED" }); },
  });
  t.after(() => readOnly.dispose());
  await readOnly.ready();
  globalThis[runtimeKey] = readOnly;
  await expectStatus("terminal", 503);
  globalThis[runtimeKey] = await f.restart();
  f.lose();
  await expectStatus("terminal", 503);
  assert.deepEqual(readFileSync(f.stateFile), before);
});
