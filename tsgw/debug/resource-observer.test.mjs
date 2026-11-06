import assert from "node:assert/strict";
import test from "node:test";
import { snapshot, harness, answer, queriedId, bootstrap, tick, flush, createDebugPageObserver, CATALOG_REFRESH_MS } from "./resource-observer-fixtures.mjs";

test("three resident IDs get their own detail, clocks and missing readings; repeat cycle is 6 s, not 2 s", async () => {
  const h = harness();
  await bootstrap(h);
  assert.deepEqual(Object.keys(h.cache), ["a", "b", "c"]);
  for (const [id, reading] of Object.entries(h.cache)) {
    assert.equal(reading.sessionId, id);
    assert.equal(reading.reply, null, "roster is not a detail observation");
    assert.equal(reading.receivedAt, null);
    assert.equal(reading.requests, 0);
    assert.equal(reading.failure, null);
  }
  const missing = h.cache;
  const sequence = [];
  for (let at = 2000; at <= 12000; at += 2000) sequence.push(await tick(h, at));
  assert.deepEqual(sequence, ["a", "b", "c", "a", "b", "c"]);
  for (const [index, id] of ["a", "b", "c"].entries()) {
    const reading = h.cache[id];
    assert.equal(reading.reply.session.sessionId, id);
    assert.equal(reading.reply.session.mcp.servers[0].name, `mcp-${id}`);
    assert.equal(reading.reply.now, 9000 + index * 2000);
    assert.equal(reading.receivedAt, 8000 + index * 2000);
    assert.equal(reading.requests, 2);
    const calls = h.debug.filter((request) => queriedId(request) === id);
    assert.equal(calls[1].at - calls[0].at, 6000);
  }
  assert.equal(missing.a.reply, null, "published cache snapshots are not later mutated");
  assert.equal(h.readings.at(-1).reply.session, null, "global summaries do not carry a single session detail");
  h.observer.dispose();
});

test("resident subagents are sampled themselves, without needing a parent detail", async () => {
  const h = harness();
  const roster = ["parent", "child-1", "child-2"];
  await bootstrap(h, roster);
  for (let at = 2000; at <= 6000; at += 2000) await tick(h, at, roster);
  for (const id of roster) assert.equal(h.cache[id].reply.session.sessionId, id);
  h.observer.dispose();
});

test("roster churn preserves the cursor, adds unobserved residents and removes exited cache", async () => {
  const h = harness();
  await bootstrap(h);
  assert.equal(await tick(h, 2000), "a");
  assert.equal(await tick(h, 4000, ["d", "c", "b"]), "b");
  assert.deepEqual(Object.keys(h.cache), ["d", "c", "b"]);
  assert.equal(h.cache.a, undefined);
  assert.equal(h.cache.d.reply, null);
  assert.equal(await tick(h, 6000, ["b", "d", "c"]), "c", "server reordering cannot reset the cursor");
  assert.equal(await tick(h, 8000, ["b", "c", "d"]), "b");
  assert.equal(await tick(h, 10000, ["b", "c", "d"]), "d");
  h.observer.dispose();
});

test("200 historical catalog rows cannot enter the resident cache or sampling ring", async () => {
  const catalogRows = Array.from({ length: 200 }, (_, index) => ({ id: `history-${index}` }));
  const h = harness({ catalogRows });
  await bootstrap(h);
  assert.deepEqual(h.catalogs, [{ rows: catalogRows, failed: false }]);
  for (let at = 2000; at <= 18000; at += 2000) await tick(h, at);
  assert.deepEqual(Object.keys(h.cache), ["a", "b", "c"]);
  assert.deepEqual(h.debug.map(queriedId), [null, "a", "b", "c", "a", "b", "c", "a", "b", "c"]);
  await tick(h, 20000, []);
  assert.deepEqual(h.cache, {}, "even cached residents disappear when the roster becomes empty");
  assert.equal(await tick(h, 22000, []), null, "history cannot become the fallback target");
  assert.equal(h.catalogs[0].rows.length, 200);
  h.observer.dispose();
});

test("a detail still in flight when its ID exits cannot revive that ID or an old global session", async () => {
  const h = harness();
  await bootstrap(h);
  await tick(h, 2000);
  const oldA = h.cache.a;
  h.pollAt(4000);
  const oldB = h.debug.at(-1);
  assert.equal(queriedId(oldB), "b");
  // The response has already captured B's detail, but its global roster now only contains C.
  answer(oldB, snapshot(["c"], "b", 5000));
  await flush();
  assert.deepEqual(Object.keys(h.cache), ["c"]);
  assert.equal(h.cache.a, undefined);
  assert.equal(h.cache.b, undefined);
  assert.equal(h.cache.c.reply, null);
  assert.equal(h.readings.at(-1).reply.session, null);
  assert.deepEqual(h.readings.at(-1).reply.sessions.map((row) => row.sessionId), ["c"]);

  h.pollAt(6000);
  assert.equal(queriedId(h.debug.at(-1)), "c");
  answer(h.debug.at(-1), {}, 503);
  await flush();
  assert.deepEqual(Object.keys(h.cache), ["c"], "failure cannot reconcile against an older roster");
  assert.equal(h.readings.at(-1).reply.session, null, "retained global data cannot reintroduce B's detail");
  assert.equal(h.readings.at(-1).reply.now, 5000);
  assert.equal(h.readings.at(-1).receivedAt, 4000);
  assert.equal(h.cache.c.failure.kind, "http");
  assert.equal(await tick(h, 8000, ["c"]), "c");
  assert.equal(await tick(h, 10000, ["a", "c"]), "c");
  assert.notEqual(h.cache.a, oldA, "a genuinely re-entered ID starts a new observation");
  assert.equal(h.cache.a.reply, null);
  assert.equal(h.cache.a.receivedAt, null);
  assert.equal(h.cache.a.requests, 0);
  assert.equal(oldA.reply.session.sessionId, "a", "published old readings remain immutable, not active");
  h.observer.dispose();
});

test("slow requests keep their target and never overlap or advance the cursor on busy ticks", async () => {
  const h = harness();
  await bootstrap(h);
  h.pollAt(2000);
  const request = h.debug.at(-1);
  assert.equal(queriedId(request), "a");
  h.pollAt(4000);
  h.pollAt(6000);
  assert.equal(h.debug.length, 2);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(h.observer.inFlightSince(), 2000);
  assert.equal(h.observer.nextDebugCheckAt(), 8000);
  h.time(6500);
  answer(request, snapshot(["a", "b", "c"], "a", 6500));
  await flush();
  assert.equal(h.cache.a.receivedAt, 6500);
  assert.equal(h.cache.a.roundTripMs, 4500);
  assert.equal(await tick(h, 8000), "b");
  assert.equal(await tick(h, 10000), "c");
  assert.equal(h.maxActiveDebug, 1);
  h.observer.dispose();
});

test("repeated completed polls in the same 2 s check slot cannot increase the GET rate", async () => {
  const h = harness();
  await bootstrap(h);
  for (const at of [1, 500, 1999]) { h.time(at); h.observer.poll(); }
  assert.equal(h.debug.length, 1);
  assert.equal(await tick(h, 2000), "a");
  h.pollAt(2000);
  h.time(2500);
  h.observer.poll(4000);
  h.observer.poll();
  assert.equal(h.debug.length, 2);
  assert.equal(h.observer.nextDebugCheckAt(), 4000);
  assert.equal(await tick(h, 4000), "b");
  h.observer.dispose();
});

test("hidden pages issue no GETs or cursor advances; visible catch-up preserves caller phase", async () => {
  const h = harness();
  h.visible(false);
  h.pollAt(0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.observer.nextDebugCheckAt(), null);
  h.visible(true);
  await bootstrap(h);
  await tick(h, 2000);
  const requests = h.requests.length;
  h.visible(false);
  h.pollAt(4000);
  h.pollAt(6000);
  assert.equal(h.requests.length, requests);
  assert.equal(h.observer.nextDebugCheckAt(), 4000);
  h.visible(true);
  h.time(7500);
  h.observer.poll(8000);
  assert.equal(queriedId(h.debug.at(-1)), "b");
  assert.equal(h.observer.nextDebugCheckAt(), 8000);
  answer(h.debug.at(-1), snapshot(["a", "b", "c"], "b"));
  await flush();
  h.observer.poll(8000);
  assert.equal(h.requests.length, requests + 1, "visibility events cannot duplicate a completed slot");
  assert.equal(await tick(h, 8000), "c", "hidden checks did not advance the cursor");
  h.observer.dispose();
});

test("dispose aborts and discards late detail/resources/catalog callbacks even if fetch ignores abort", async () => {
  const h = harness({ ignoreAbort: true });
  await bootstrap(h);
  h.pollAt(2000);
  const request = h.debug.at(-1);
  const before = [h.readings.length, h.resources.length, h.catalogs.length];
  h.observer.dispose();
  assert.equal(request.init.signal.aborted, true);
  answer(request, snapshot(["a", "b", "c"], "a"));
  await flush();
  h.pollAt(4000);
  assert.deepEqual([h.readings.length, h.resources.length, h.catalogs.length], before);
  assert.equal(h.debug.length, 2);
  assert.equal(h.timers.size, 0);
});

test("same tick schedule gives exactly the original GET volume and catalog telemetry, independent of roster size", async () => {
  const base = harness({ factory: createDebugPageObserver });
  const h = harness();
  const roster = Array.from({ length: 25 }, (_, index) => `s-${index}`);
  for (let at = 0; at <= 64000; at += 2000) {
    for (const current of [base, h]) {
      current.pollAt(at);
      const request = current.debug.at(-1);
      answer(request, snapshot(roster, queriedId(request), at + 1000));
    }
    await flush();
    assert.equal(h.requests.length, base.requests.length);
    assert.deepEqual(h.catalogs, base.catalogs);
    assert.deepEqual(h.observer.catalogTelemetry(), base.observer.catalogTelemetry());
  }
  assert.equal(h.debug.length, 33);
  assert.equal(h.requests.length - h.debug.length, 3);
  assert.equal(h.maxActiveDebug, 1);
  for (const { url, init } of h.requests) {
    assert.ok(url === "/api/sessions" || url.startsWith("/api/agent/debug"));
    assert.equal(init.method, undefined);
    assert.equal(init.body, undefined);
    assert.equal(init.cache, "no-store");
  }
  base.observer.dispose();
  h.observer.dispose();
});

test("empty roster continues global sampling and later discovers new residents without restarting", async () => {
  const h = harness();
  await bootstrap(h, []);
  assert.deepEqual(h.cache, {});
  assert.equal(await tick(h, 2000, []), null);
  assert.equal(await tick(h, 4000, ["new"]), null);
  assert.equal(h.cache.new.reply, null);
  assert.equal(await tick(h, 6000, ["new"]), "new");
  assert.equal(h.cache.new.receivedAt, 6000);
  h.observer.dispose();
});

test("immediate dispose suppresses late bootstrap and catalog results", async () => {
  const h = harness({ ignoreAbort: true });
  h.pollAt(0);
  h.observer.dispose();
  answer(h.debug.at(-1), snapshot(["a", "b", "c"]));
  await flush();
  assert.deepEqual(h.catalogs, []);
  assert.deepEqual(h.readings, []);
  assert.deepEqual(h.resources, []);
  assert.equal(h.timers.size, 0);
});

test("catalog failure remains separate from resource reading failures and retains telemetry", async () => {
  const h = harness();
  await bootstrap(h);
  h.failCatalog(true);
  await tick(h, CATALOG_REFRESH_MS);
  assert.deepEqual(h.catalogs.at(-1), { rows: null, failed: true });
  assert.equal(h.observer.catalogTelemetry().failures, 1);
  assert.equal(h.observer.catalogTelemetry().receivedAt, 0);
  assert.equal(h.cache.a.failure, null);
  h.observer.dispose();
});
