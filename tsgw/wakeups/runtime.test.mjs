import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { WakeupRuntime } = await createJiti(import.meta.url).import("./runtime.ts");

function fixture(t, options = {}) {
  const records = [];
  const calls = [];
  const store = {
    async assertTarget(id) { calls.push(id); if (id === "missing") throw new Error("Session not found"); },
    async append(record) { if (options.failWrite?.(record)) throw new Error("write failed"); records.push(record); },
    async read() { return records.map((data) => ({ type: "custom", customType: "pi-web:wakeup", data })); },
  };
  const runtime = new WakeupRuntime(store, options.deliver ?? (async () => {}));
  t.after(() => runtime.dispose());
  return { runtime, records, calls, store };
}

test("schedule normalizes time and UUIDv7, writes creation before arming, defaults target to source", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 30) });
  const { runtime, records } = fixture(t);
  const wakeup = await runtime.schedule("source", { after_seconds: 60, message: "  continue task  " });
  assert.match(wakeup.wakeupId, /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.equal(wakeup.sourceSessionId, "source");
  assert.equal(wakeup.targetSessionId, "source");
  assert.equal(wakeup.scheduledAt, "2026-10-30T00:01:00.000Z");
  assert.equal(wakeup.message, "continue task");
  assert.equal(records[0].event, "created");
  assert.deepEqual(runtime.list(), [wakeup]);
  const explicit = await runtime.schedule("source", { session_id: "target", at: "2026-10-31T09:00:00+08:00", message: "handoff" });
  assert.equal(explicit.scheduledAt, "2026-10-31T01:00:00.000Z");
  assert.equal(explicit.targetSessionId, "target");
});

test("invalid input fails before writing, target lookup or scheduling", async (t) => {
  const { runtime, records, calls } = fixture(t);
  for (const input of [
    {}, { after_seconds: 1, at: "2099-01-01T00:00:00Z" },
    { after_seconds: 0 }, { after_seconds: -1 }, { after_seconds: NaN }, { after_seconds: Infinity },
    { after_seconds: Number.MAX_VALUE }, { after_seconds: 0.00001 },
    { at: "2099-01-01T00:00:00" }, { at: "2000-01-01T00:00:00Z" },
    { at: "2099-02-30T00:00:00Z" }, { at: "2099-01-01T24:00:00Z" },
    { at: "2099-13-01T00:00:00Z" }, { at: "2099-01-01T00:00:00+99:00" },
    { after_seconds: 1, message: "  " }, { after_seconds: 1, session_id: " " },
  ]) await assert.rejects(runtime.schedule("source", { message: "task", ...input }));
  assert.equal(records.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(runtime.list(), []);
});

test("missing targets and failed creation writes never arm a timer", async (t) => {
  const missing = fixture(t);
  await assert.rejects(missing.runtime.schedule("source", { session_id: "missing", after_seconds: 60, message: "task" }), /not found/);
  assert.deepEqual(missing.runtime.list(), []);
  const failed = fixture(t, { failWrite: () => true });
  await assert.rejects(failed.runtime.schedule("source", { after_seconds: 60, message: "task" }), /write failed/);
  assert.deepEqual(failed.runtime.list(), []);
});

test("cancel appends a separate event and removes the live timer; cannot cancel twice", async (t) => {
  const { runtime, records } = fixture(t);
  const wakeup = await runtime.schedule("source", { after_seconds: 60, message: "task" });
  assert.deepEqual(await runtime.cancel(wakeup.wakeupId), wakeup);
  assert.deepEqual(records.map((record) => record.event), ["created", "cancelled"]);
  assert.deepEqual(runtime.list(), []);
  await assert.rejects(runtime.cancel(wakeup.wakeupId), /not pending/);
});

test("failed cancellation history reports that the in-memory cancellation already happened", async (t) => {
  const { runtime } = fixture(t, { failWrite: (record) => record.event === "cancelled" });
  const wakeup = await runtime.schedule("source", { after_seconds: 60, message: "task" });
  await assert.rejects(runtime.cancel(wakeup.wakeupId), /was cancelled in memory/);
  assert.deepEqual(runtime.list(), []);
});

test("trigger records acceptance or failure, consumes timer once, and never retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 30) });
  const submitted = fixture(t);
  const failed = fixture(t, { deliver: async () => { throw new Error("target deleted"); } });
  for (const { runtime } of [submitted, failed]) await runtime.schedule("source", { after_seconds: 1, message: "task" });
  t.mock.timers.tick(1000);
  // Drain asynchronous delivery and metadata writes, not a model run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted.records.map((r) => r.event), ["created", "submitted"]);
  assert.deepEqual(failed.records.map((r) => r.event), ["created", "failed"]);
  assert.equal(failed.records[1].error, "target deleted");
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.records.length, 2);
  assert.equal(failed.records.length, 2);
});

test("submitted audit write failure never records delivery failure or repeats the accepted message", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 30) });
  const logs = t.mock.method(console, "error", () => {});
  let accepted = 0;
  const { runtime, records } = fixture(t, {
    deliver: async () => { accepted++; },
    failWrite: (record) => record.event === "submitted",
  });
  await runtime.schedule("source", { after_seconds: 1, message: "task" });
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, 1);
  assert.deepEqual(records.map((r) => r.event), ["created"]);
  assert.equal(logs.mock.calls.length, 1);
  assert.match(logs.mock.calls[0].arguments[0], /was submitted but its history could not be written/);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, 1);
  assert.deepEqual(runtime.list(), []);
});

test("new runtime never restores timers from historical records", async (t) => {
  const original = fixture(t);
  await original.runtime.schedule("source", { after_seconds: 60, message: "task" });
  original.runtime.dispose();
  const restarted = new WakeupRuntime(original.store, async () => assert.fail("must not restore"));
  t.after(() => restarted.dispose());
  assert.deepEqual(restarted.list(), []);
  const history = await restarted.history("source");
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "inactive");
  assert.equal(history[0].active, false);
});
