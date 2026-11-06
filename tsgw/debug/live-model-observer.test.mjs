import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLiveModelObserver } = await jiti.import("./live-model-observer.ts");
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

function setup({ ignoreAbort = false } = {}) {
  const calls = [], reports = [], timers = new Map();
  let clock = 1000, visible = true;
  const observer = createLiveModelObserver({
    fetch(url, init) {
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      const request = { url, init, resolve, reject };
      calls.push(request);
      init.signal.addEventListener("abort", () => { if (!ignoreAbort) reject(new Error("abort")); }, { once: true });
      return promise;
    },
    onReading: value => reports.push(value), isVisible: () => visible, now: () => clock,
    setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { observer, calls, reports, timers, advance: ms => { clock += ms; }, hide: () => { visible = false; },
    async answer(data, index = calls.length - 1) { calls[index].resolve({ ok: true, status: 200, json: async () => data }); await flush(); },
  };
}

test("status reads use the existing no-system-prompt GET and keep each session's own model and thinking", async () => {
  const s = setup(); s.observer.retain(["one", "two"]);
  s.observer.poll("one");
  assert.equal(s.calls[0].url, "/api/agent/one?systemPrompt=0");
  assert.equal(s.calls[0].init.cache, "no-store");
  assert.equal(s.calls[0].init.method, undefined);
  await s.answer({ running: true, state: { model: { provider: "p", id: "alpha" }, thinkingLevel: "high" } });
  s.advance(2000); s.observer.poll("two");
  await s.answer({ running: true, state: { model: { provider: "q", id: "beta" }, thinkingLevel: "off" } });
  const values = s.reports.at(-1);
  assert.deepEqual(values.one, { model: { provider: "p", id: "alpha" }, thinkingLevel: "high", running: true, receivedAt: 1000, failed: false });
  assert.equal(values.two.model.id, "beta"); assert.equal(values.two.thinkingLevel, "off");
  assert.equal(values.two.receivedAt, 3000);
  s.observer.dispose();
});

test("slow status requests do not overlap or duplicate, and a queued session is served on the next poll", async () => {
  const s = setup(); s.observer.retain(["one", "two", "three"]);
  s.observer.poll("one"); s.observer.poll("one"); s.observer.poll("two"); s.observer.poll("three");
  assert.equal(s.calls.length, 1);
  await s.answer({ running: true, state: {} });
  assert.equal(s.calls.length, 1, "completion does not start an uncontrolled burst");
  s.observer.poll("one"); assert.equal(s.calls[1].url, "/api/agent/two?systemPrompt=0");
  await s.answer({ running: false });
  s.observer.poll("two"); assert.equal(s.calls[2].url, "/api/agent/three?systemPrompt=0");
  s.observer.dispose();
});

test("cold sessions and missing fields do not invent a default model or thinking level", async () => {
  const s = setup(); s.observer.retain(["one"]); s.observer.poll("one");
  await s.answer({ running: false });
  assert.equal(s.reports.at(-1).one.model, null); assert.equal(s.reports.at(-1).one.thinkingLevel, null);
  assert.equal(s.reports.at(-1).one.running, false);
  s.observer.poll("one"); await s.answer({ running: true, state: {} });
  assert.equal(s.reports.at(-1).one.thinkingLevel, null);
  s.observer.dispose();
});

test("failure and timeout preserve only that session's own sample and report failure", async () => {
  const s = setup(); s.observer.retain(["one", "two"]); s.observer.poll("one");
  await s.answer({ running: true, state: { model: { provider: "p", id: "alpha" }, thinkingLevel: "max" } });
  s.observer.poll("one"); s.calls.at(-1).resolve({ ok: false, status: 503 }); await flush();
  assert.equal(s.reports.at(-1).one.model.id, "alpha"); assert.equal(s.reports.at(-1).one.failed, true);
  s.observer.poll("two"); [...s.timers.values()][0](); await flush();
  assert.equal(s.reports.at(-1).two.failed, true); assert.equal(s.reports.at(-1).two.model, null);
  s.observer.dispose();
});

for (const outcome of ["success", "failure"]) test(`an exited then rejoined ID cannot accept the old request's late ${outcome}`, async () => {
  const s = setup({ ignoreAbort: true });
  s.observer.retain(["one"]); s.observer.poll("one");
  s.advance(2000); s.observer.retain([]);
  s.advance(2000); s.observer.retain(["one"]);
  if (outcome === "success") await s.answer({ running: true, state: { model: { provider: "p", id: "old" }, thinkingLevel: "high" } }, 0);
  else { s.calls[0].reject(new Error("old network failure")); await flush(); }
  assert.equal(s.reports.length, 0, "neither stale data nor an old failure belongs to the new residency");
  s.observer.poll("one");
  await s.answer({ running: true, state: { model: { provider: "p", id: "new" }, thinkingLevel: "max" } });
  assert.equal(s.reports.at(-1).one.model.id, "new");
  assert.equal(s.reports.at(-1).one.thinkingLevel, "max");
  assert.equal(s.reports.at(-1).one.failed, false);
  assert.equal(s.reports.at(-1).one.receivedAt, 5000);
  s.observer.dispose();
});

test("hidden/disposed readers do not fetch or report late replies; departed session data is removed", async () => {
  const s = setup(); s.observer.retain(["one", "two"]); s.observer.poll("one");
  s.observer.retain(["two"]); await s.answer({ running: false }); assert.equal(s.reports.length, 0);
  s.hide(); s.observer.poll("two"); assert.equal(s.calls.length, 1);
  s.observer.dispose(); s.observer.poll("two"); assert.equal(s.calls.length, 1);
  const x = setup(); x.observer.retain(["one"]); x.observer.poll("one"); x.observer.dispose();
  await flush(); assert.equal(x.reports.length, 0);
  const y = setup(); y.observer.retain(["one"]); y.observer.poll("one"); await y.answer({ running: false });
  y.observer.retain([]); assert.deepEqual(y.reports.at(-1), {}); y.observer.dispose();
});
