import assert from "node:assert/strict";
import test from "node:test";

const { WakeupScheduler } = await import("./scheduler.ts");

const day = 86_400_000;
// The mock clock's origin; any instant works.
const start = 1_800_000_000_000;

function wakeup(overrides = {}) {
  return {
    wakeupId: "wakeup-1",
    sourceSessionId: "session-a",
    targetSessionId: "session-b",
    createdAt: new Date(start).toISOString(),
    scheduledAt: new Date(start + 60_000).toISOString(),
    message: "check the build",
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function armMockClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
}

test("a wakeup fires once at its scheduled time, out of the scheduler before its callback", (t) => {
  armMockClock(t);
  const seen = [];
  let scheduler;
  scheduler = new WakeupScheduler(async (fired) => {
    seen.push({ wakeup: fired, stillArmed: scheduler.has(fired.wakeupId) });
  });
  t.after(() => scheduler.dispose());

  const first = wakeup();
  scheduler.add(first);
  assert.equal(scheduler.has("wakeup-1"), true);
  assert.deepEqual(scheduler.list(), [first]);

  t.mock.timers.tick(59_999);
  assert.deepEqual(seen, [], "not before its scheduled time");

  t.mock.timers.tick(1);
  assert.deepEqual(seen, [{ wakeup: first, stillArmed: false }]);
  assert.equal(scheduler.has("wakeup-1"), false);
  assert.deepEqual(scheduler.list(), []);

  t.mock.timers.tick(10 * day);
  assert.equal(seen.length, 1, "a one-shot wakeup never fires twice");
});

test("cancel drops a wakeup that has not fired yet, and only once", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });
  t.after(() => scheduler.dispose());

  const cancelled = wakeup({ wakeupId: "wakeup-cancelled", scheduledAt: new Date(start + 10_000).toISOString() });
  const kept = wakeup({ wakeupId: "wakeup-kept", scheduledAt: new Date(start + 20_000).toISOString() });
  scheduler.add(cancelled);
  scheduler.add(kept);

  assert.deepEqual(scheduler.cancel("wakeup-cancelled"), cancelled);
  assert.equal(scheduler.has("wakeup-cancelled"), false);
  assert.deepEqual(scheduler.list(), [kept]);

  t.mock.timers.tick(10_000);
  assert.deepEqual(fired, [], "a cancelled wakeup never fires");
  t.mock.timers.tick(10_000);
  assert.deepEqual(fired, ["wakeup-kept"]);

  assert.equal(scheduler.cancel("wakeup-cancelled"), undefined, "it is gone already");
  assert.equal(scheduler.cancel("wakeup-kept"), undefined, "a fired wakeup is gone too");
});

test("a wakeup beyond setTimeout's 2^31-1 ms limit is not fired early", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });
  t.after(() => scheduler.dispose());

  // 50 days spans three steps of at most 2^31-1 ms.
  const far = wakeup({ scheduledAt: new Date(start + 50 * day).toISOString() });
  scheduler.add(far);

  t.mock.timers.tick(49 * day);
  assert.deepEqual(fired, []);
  assert.equal(scheduler.has("wakeup-1"), true, "still armed after two steps");

  t.mock.timers.tick(day - 1);
  assert.deepEqual(fired, [], "not a millisecond before its time");

  t.mock.timers.tick(1);
  assert.deepEqual(fired, ["wakeup-1"]);
  assert.deepEqual(scheduler.list(), []);
});

test("wakeups due at the same instant each fire once, in the order they were added", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });
  t.after(() => scheduler.dispose());

  for (const wakeupId of ["wakeup-a", "wakeup-b", "wakeup-c"]) scheduler.add(wakeup({ wakeupId }));

  t.mock.timers.tick(60_000);
  assert.deepEqual(fired, ["wakeup-a", "wakeup-b", "wakeup-c"]);
  t.mock.timers.tick(60_000);
  assert.equal(fired.length, 3);
  assert.deepEqual(scheduler.list(), []);
});

test("adding an id again replaces its wakeup instead of leaving a stray timer", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });
  t.after(() => scheduler.dispose());

  scheduler.add(wakeup({ scheduledAt: new Date(start + 1_000).toISOString(), message: "old" }));
  const replacement = wakeup({ scheduledAt: new Date(start + 2_000).toISOString(), message: "new" });
  scheduler.add(replacement);
  assert.deepEqual(scheduler.list(), [replacement]);

  t.mock.timers.tick(1_000);
  assert.deepEqual(fired, [], "the replaced timer is gone");
  t.mock.timers.tick(1_000);
  assert.deepEqual(fired, ["wakeup-1"]);
});

test("dispose drops every armed wakeup, including one part-way through a long wait", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });

  const far = wakeup({ wakeupId: "wakeup-far", scheduledAt: new Date(start + 50 * day).toISOString() });
  scheduler.add(far);
  // One step of the far wakeup's wait, so another step is armed.
  t.mock.timers.tick(25 * day);
  assert.deepEqual(fired, [], "a step of the wait is not its due time");
  const soon = wakeup({ wakeupId: "wakeup-soon", scheduledAt: new Date(Date.now() + 1_000).toISOString() });
  scheduler.add(soon);
  assert.deepEqual(scheduler.list(), [far, soon]);

  scheduler.dispose();
  assert.deepEqual(scheduler.list(), []);
  assert.equal(scheduler.has("wakeup-soon"), false);
  assert.equal(scheduler.has("wakeup-far"), false);

  t.mock.timers.tick(60 * day);
  assert.deepEqual(fired, []);
  assert.equal(scheduler.cancel("wakeup-far"), undefined);
});

test("a callback that rejects is logged once, not retried, and not an unhandled rejection", async (t) => {
  armMockClock(t);
  const error = new Error("target session is gone");
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    // Process warnings such as MODULE_TYPELESS_PACKAGE_JSON also land here.
    if (String(args[0]).startsWith("wakeup ")) logged.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  let calls = 0;
  const scheduler = new WakeupScheduler(async () => {
    calls += 1;
    throw error;
  });
  t.after(() => scheduler.dispose());

  scheduler.add(wakeup());
  t.mock.timers.tick(60_000);
  await flush();

  assert.equal(calls, 1);
  assert.deepEqual(logged, [["wakeup wakeup-1 failed", error]]);
  assert.deepEqual(unhandled, [], "the rejection was handled");

  t.mock.timers.tick(10 * day);
  await flush();
  assert.equal(calls, 1, "no retry");
  assert.equal(logged.length, 1);
});

test("a callback that throws synchronously is logged too, and the scheduler stays usable", async (t) => {
  armMockClock(t);
  const error = new Error("boom");
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => {
    if (String(args[0]).startsWith("wakeup ")) logged.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });

  const fired = [];
  const scheduler = new WakeupScheduler((wakeup) => {
    if (wakeup.wakeupId === "wakeup-1") throw error;
    fired.push(wakeup.wakeupId);
    return Promise.resolve();
  });
  t.after(() => scheduler.dispose());

  scheduler.add(wakeup({ scheduledAt: new Date(start + 1_000).toISOString() }));
  scheduler.add(wakeup({ wakeupId: "wakeup-next", scheduledAt: new Date(start + 2_000).toISOString() }));

  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(logged, [["wakeup wakeup-1 failed", error]]);

  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(fired, ["wakeup-next"]);
});

test("a wakeup whose time has already passed fires on the next tick", (t) => {
  armMockClock(t);
  const fired = [];
  const scheduler = new WakeupScheduler(async (wakeup) => {
    fired.push(wakeup.wakeupId);
  });
  t.after(() => scheduler.dispose());

  scheduler.add(wakeup({ scheduledAt: new Date(start - 60_000).toISOString() }));
  t.mock.timers.tick(1);
  assert.deepEqual(fired, ["wakeup-1"]);
  assert.deepEqual(scheduler.list(), []);
});
