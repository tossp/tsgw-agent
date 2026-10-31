import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDebugPageObserver, CATALOG_REFRESH_MS } = await jiti.import("./page-observer.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function snapshot(id = null) {
  return {
    now: 1000,
    server: {
      startedAt: 0, wrappers: { alive: 0, closing: 0, starting: 0 },
      eventStreams: { total: 0 }, sseTotal: 0, pages: [], terminals: {},
    },
    sessions: [],
    session: id === null ? null : {
      sessionId: id, wrapper: null, lifecycle: null, providers: [], eventStreams: [],
      subagents: { active: false, runs: [], notifications: [] }, mcp: null,
    },
  };
}

function harness() {
  const requests = [];
  const readings = [];
  const catalogs = [];
  const timers = new Map();
  let now = 0;
  let selected = null;
  let visible = true;
  let nextTimer = 0;
  const observer = createDebugPageObserver({
    fetch(url, init) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        requests.push({ url, init, resolve, reject });
      });
    },
    sessionId: () => selected,
    isVisible: () => visible,
    now: () => now,
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    onReading: (reading) => readings.push(reading),
    onCatalog: (rows, failed) => catalogs.push({ rows, failed }),
  });
  return {
    observer, requests, readings, catalogs, timers,
    time: (value) => { now = value; },
    select: (value) => { selected = value; observer.sync(); },
    visible: (value) => { visible = value; },
  };
}

function answer(request, body, status = 200) {
  request.resolve({ ok: status === 200, status, json: async () => body });
}

test("only existing GET endpoints: global debug every poll, catalog at most every 30 s", async () => {
  const h = harness();
  h.observer.poll();
  assert.deepEqual(h.requests.map((r) => r.url), ["/api/agent/debug", "/api/sessions"]);
  answer(h.requests[0], snapshot());
  answer(h.requests[1], { sessions: [{ id: "s1" }] });
  await flush();
  assert.deepEqual(h.catalogs, [{ rows: [{ id: "s1" }], failed: false }]);
  h.time(2000);
  h.observer.poll();
  assert.equal(h.requests.length, 3);
  answer(h.requests[2], snapshot());
  await flush();
  h.time(CATALOG_REFRESH_MS);
  h.observer.poll();
  assert.equal(h.requests.at(-1).url, "/api/sessions");
  for (const { init } of h.requests) {
    assert.equal(init.method, undefined, "default GET, no mutating method");
    assert.equal(init.body, undefined);
    assert.equal(init.cache, "no-store");
  }
  h.observer.dispose();
});

test("single selection switches the existing debug query, aborts the old and ignores late replies", async () => {
  const h = harness();
  h.observer.poll();
  answer(h.requests[0], snapshot());
  answer(h.requests[1], { sessions: [] });
  await flush();
  h.select("a/b");
  const old = h.requests.at(-1);
  assert.equal(old.url, "/api/agent/debug?session=a%2Fb");
  h.select("second");
  assert.equal(old.init.signal.aborted, true);
  answer(old, snapshot("a/b"));
  answer(h.requests.at(-1), snapshot("second"));
  await flush();
  assert.equal(h.readings.at(-1).reply.session.sessionId, "second");
  assert.ok(!h.readings.some((r) => r.sessionId === "a/b"));
  h.select(null);
  assert.equal(h.requests.at(-1).url, "/api/agent/debug");
  answer(h.requests.at(-1), snapshot());
  await flush();
  assert.equal(h.readings.at(-1).reply.session, null);
  h.observer.dispose();
});

test("hidden pages start no requests; visible pages catch up; no overlapping polls", async () => {
  const h = harness();
  h.visible(false);
  h.observer.poll();
  assert.equal(h.requests.length, 0);
  h.visible(true);
  h.observer.poll();
  h.observer.poll();
  assert.equal(h.requests.length, 2);
  answer(h.requests[0], snapshot());
  answer(h.requests[1], { sessions: [] });
  await flush();
  h.observer.dispose();
});

test("failed catalog keeps prior rows with an explicit error; debug keeps its last successful snapshot", async () => {
  const h = harness();
  h.observer.poll();
  answer(h.requests[0], snapshot());
  answer(h.requests[1], { sessions: [{ id: "s1" }] });
  await flush();
  h.time(CATALOG_REFRESH_MS);
  h.observer.poll();
  answer(h.requests[2], {}, 500);
  answer(h.requests[3], {}, 500);
  await flush();
  assert.equal(h.readings.at(-1).failure.kind, "http");
  assert.deepEqual(h.readings.at(-1).reply, snapshot());
  assert.deepEqual(h.catalogs.at(-1), { rows: null, failed: true });
  h.observer.dispose();
});

test("5 s timeouts release requests; disposal aborts both without delivering updates", async () => {
  const h = harness();
  h.observer.poll();
  for (const callback of [...h.timers.values()]) callback();
  await flush();
  assert.equal(h.readings.at(-1).failure.kind, "timeout");
  assert.equal(h.catalogs.at(-1).failed, true);
  assert.equal(h.timers.size, 0);
  h.time(CATALOG_REFRESH_MS);
  h.observer.poll();
  const readings = h.readings.length;
  const catalogs = h.catalogs.length;
  h.observer.dispose();
  assert.ok(h.requests.every((r) => r.init.signal.aborted));
  await flush();
  assert.equal(h.readings.length, readings);
  assert.equal(h.catalogs.length, catalogs);
  assert.equal(h.timers.size, 0);
  h.observer.poll();
  assert.equal(h.requests.length, 4);
});
