import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createResourcePageObserver } = await jiti.import("./resource-observer.ts");
export const { createDebugPageObserver, CATALOG_REFRESH_MS } = await jiti.import("./page-observer.ts");
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function snapshot(ids = [], id = null, now = 1000) {
  return {
    now,
    server: {
      startedAt: 0, wrappers: { alive: ids.length, closing: 0, starting: 0 },
      eventStreams: { total: 0 }, sseTotal: 0, pages: [], terminals: {},
    },
    sessions: ids.map((sessionId) => ({
      sessionId, state: "alive", running: false, awaitingInput: false,
      subagent: sessionId.startsWith("child"), eventStreams: 0, providers: 0,
      nextIdleCheckAt: null, forcedByStop: false, starts: 1,
    })),
    session: id === null ? null : {
      sessionId: id, wrapper: null, lifecycle: null, providers: [], eventStreams: [],
      subagents: { active: false, runs: [], notifications: [] },
      mcp: { active: true, servers: [{ name: `mcp-${id}` }] },
    },
  };
}

export function harness({ factory = createResourcePageObserver, catalogRows = [{ id: "catalog-only" }], ignoreAbort = false } = {}) {
  const requests = [];
  const readings = [];
  const resources = [];
  const catalogs = [];
  const timers = new Map();
  let now = 0;
  let visible = true;
  let nextTimer = 0;
  let activeDebug = 0;
  let maxActiveDebug = 0;
  let catalogFailed = false;
  const options = {
    fetch(url, init) {
      if (url === "/api/sessions") {
        requests.push({ url, init, at: now });
        return Promise.resolve({ ok: !catalogFailed, status: catalogFailed ? 503 : 200, json: async () => ({ sessions: catalogRows }) });
      }
      return new Promise((resolve, reject) => {
        activeDebug++;
        maxActiveDebug = Math.max(maxActiveDebug, activeDebug);
        let finished = false;
        const finish = (callback, value) => {
          if (!finished) { finished = true; activeDebug--; callback(value); }
        };
        init.signal.addEventListener("abort", () => { if (!ignoreAbort) finish(reject, new Error("aborted")); });
        requests.push({ url, init, at: now, resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      });
    },
    isVisible: () => visible,
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    onReading: (reading) => readings.push(reading),
    onCatalog: (rows, failed) => catalogs.push({ rows, failed }),
    onResources: (value) => resources.push(value),
  };
  const observer = factory(factory === createDebugPageObserver ? { ...options, sessionId: () => null } : options);
  return {
    observer, requests, readings, resources, catalogs, timers,
    get cache() { return resources.at(-1) ?? {}; },
    get debug() { return requests.filter((request) => request.url.startsWith("/api/agent/debug")); },
    get maxActiveDebug() { return maxActiveDebug; },
    time: (value) => { now = value; },
    pollAt: (value) => { now = value; observer.poll(value + 2000); },
    visible: (value) => { visible = value; },
    failCatalog: (value) => { catalogFailed = value; },
  };
}

export function answer(request, body, status = 200) {
  request.resolve({ ok: status === 200, status, json: async () => body });
}

export function queriedId(request) {
  return new URL(request.url, "http://localhost").searchParams.get("session");
}

export async function bootstrap(h, ids = ["a", "b", "c"]) {
  h.pollAt(0);
  assert.equal(h.debug[0].url, "/api/agent/debug", "bootstrap discovers residents with a global query");
  answer(h.debug[0], snapshot(ids));
  await flush();
}

export async function tick(h, at, ids = ["a", "b", "c"], serverNow = at + 1000) {
  h.pollAt(at);
  const request = h.debug.at(-1);
  const id = queriedId(request);
  answer(request, snapshot(ids, id, serverNow));
  await flush();
  return id;
}
