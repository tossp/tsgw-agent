import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Only this harness's fixtures reach /api; reuse the isolated, already-running dev server.
const base = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:30143").origin;
const output = "test-results/tsgw-debug";
await mkdir(output, { recursive: true });
const ready = await fetch(`${base}/debug`, { signal: AbortSignal.timeout(10000), redirect: "manual" });
assert.equal(ready.status, 200, `existing dev service not ready: HTTP ${ready.status}; do not restart it`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const requests = [], forbidden = [], blockedTelemetry = [], errors = [], consoleMessages = [], requestFailures = [], results = [];
let state, page, stage = "setup";
const info = (id, name, project = "project", extra = {}) => ({
  id, name, path: "", cwd: `/test/${project}`, projectRoot: `/test/${project}`,
  created: "2026-10-30T00:00:00Z", modified: "2026-10-30T00:00:10Z", messageCount: 2, firstMessage: "Fixture session", ...extra,
});
function fixtures() {
  return {
    failure: false, catalogFailure: false, empty: false, attention: false,
    // Absolute deadlines belong to this load, not to each subsequent snapshot.
    loadedAt: Date.now(),
    catalog: [
      info("alpha", "Observation alpha", "project", { modified: "2026-10-30T00:00:30Z" }),
      info("beta", "Observation beta", "project", { modified: "2026-10-30T00:00:20Z" }),
      info("gamma", "Aardvark idle"), info("omega", "Other project", "other"),
      info("child", "Delegated inspector", "project", { parentSessionId: "alpha", relation: { kind: "subagent", parentSessionId: "alpha", profile: "auditor", description: "Trace fixture delegation chain", status: "running" } }),
      info("grandchild", "Nested inspector", "project", { parentSessionId: "child", relation: { kind: "subagent", parentSessionId: "child", profile: "explore", description: "Inspect nested fixture evidence", status: "running" } }),
      info("catalog", "Saved notebook", "archive"),
      info("history", "Historical child", "archive", { parentSessionId: "alpha", relation: { kind: "subagent", parentSessionId: "alpha", profile: "auditor", description: "Previously recorded assignment", status: "completed" } }),
      info("fork", "Saved fork", "archive", { parentSessionId: "alpha", relation: { kind: "fork", originSessionId: "alpha" } }),
    ],
    runtime: ["alpha", "beta", "gamma", "omega", "child", "grandchild"],
  };
}
function snapshot(id) {
  const now = Date.now(), runtime = state.empty ? [] : state.runtime;
  const running = key => ["alpha", "beta", "child"].includes(key);
  const child = key => ["child", "grandchild"].includes(key);
  const held = runtime.includes(id), alert = state.attention && id === "alpha";
  return {
    now,
    server: {
      startedAt: now - 7200000, idleTimeoutMs: 600000, heartbeatMs: 30000,
      wrappers: { alive: runtime.length, closing: 0, starting: 0 }, eventStreams: { total: runtime.length },
      sseTotal: runtime.length ? runtime.length + 1 : 0, fileWatches: runtime.length ? 1 : 0,
      pages: runtime.length ? [{ holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux", agent: runtime.length, terminal: 0, fileWatch: 1 }] : [],
      terminals: { count: 0, listeners: 0, detached: 0, exited: 0, nextCleanupAt: null },
    },
    sessions: runtime.map(key => ({
      sessionId: key, state: "alive", running: running(key), awaitingInput: key === "beta", subagent: child(key),
      eventStreams: 1, providers: 1, nextIdleCheckAt: state.loadedAt + 300000, forcedByStop: false, starts: 1,
    })),
    session: id === null ? null : {
      sessionId: id, starting: false,
      wrapper: !held ? null : {
        sessionId: id, state: "alive", stale: false, subagent: child(id), chatOnly: false,
        createdAt: now - 60000, startedAt: now - 60000, closingAt: null, extensions: alert ? "failed" : "bound",
        run: {
          running: running(id), streaming: running(id), promptRunning: false, pendingPrompts: 0,
          bashRunning: false, compacting: false, retrying: false, queuedMessages: 0,
          waitingForMcp: false, runningTools: 0, mutatingCommands: 0, replacement: null,
        },
        idle: { timeoutMs: 600000, nextCheckAt: state.loadedAt + 300000, lastResetAt: state.loadedAt - 300000, forcedByStop: false },
        awaitingInput: id === "beta", pendingUiRequests: id === "beta" ? 1 : 0, customUis: 0, eventListeners: alert ? 4 : 1,
        lastEvent: { type: "fixture_event", at: now - 1000 }, lastCommand: null,
      },
      lifecycle: !held ? null : { starts: 1, firstStartedAt: now - 60000, lastStartedAt: now - 60000, lastClosedAt: null },
      providers: !held ? [] : [{ name: "fixture-keepalive", active: alert ? "error" : true, byFile: false }],
      eventStreams: !held ? [] : [{
        holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux",
        openedAt: now - 60000, connectedAt: now - 59000, lastWriteAt: now - 1000, droppedEvents: alert ? 7 : 0, queuedBytes: 0,
      }],
      subagents: { active: id === "alpha", runs: id !== "alpha" ? [] : [{ sessionId: "child", parentSessionId: "alpha", status: "running", profile: "auditor", background: true, resumed: false, dispatchedAt: now - 20000, abortRequested: false, mcpWaiting: false }], notifications: [] },
      mcp: !held ? null : {
        active: true, disposed: false, runActive: false, idleMs: 300000, idleReleaseAt: state.loadedAt + 120000,
        servers: [
          { name: "fixture-mcp", scope: "global", state: alert ? "failed" : "connected", hasError: alert, released: false },
          { name: "fixture-gitlab", scope: "global", state: "connected", hasError: false, released: false },
          { name: "fixture-calendar", scope: "project", state: "connecting", hasError: false, released: false },
          { name: "fixture-notes", scope: "global", state: "idle", hasError: false, released: true },
          { name: "fixture-browser-tools", scope: "project", state: "connected", hasError: false, released: false },
          { name: "fixture-storage", scope: "global", state: "connected", hasError: false, released: false },
        ], problems: alert ? 1 : 0,
      },
    },
  };
}
await context.exposeBinding("__e2eBlocked", (_source, entry) => {
  (entry.kind === "EventSource" ? forbidden : blockedTelemetry).push({ ...entry, stage });
});
await context.addInitScript(() => {
  if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en");
  window.EventSource = class { constructor(url) { void window.__e2eBlocked({ kind: "EventSource", url: String(url) }); throw new Error("E2E forbids SSE"); } };
  navigator.sendBeacon = url => { void window.__e2eBlocked({ kind: "beacon", url: String(url) }); return false; };
});
// One broad guard, not a few permissive route globs: no unapproved API ever falls through.
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  const entry = { url: request.url(), method: request.method(), stage, startedAt: Date.now() };
  if (url.pathname.startsWith("/api/")) {
    requests.push(entry);
    const debug = url.pathname === "/api/agent/debug";
    const validQuery = debug ? [...url.searchParams.keys()].every(key => key === "session") && url.searchParams.getAll("session").length <= 1 : !url.search;
    if (url.origin !== base || request.method() !== "GET" || !validQuery || !["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(url.pathname)) {
      forbidden.push(entry); return route.abort();
    }
    if (url.pathname === "/api/cat-config") return route.fulfill({ json: {} });
    // Delay is actual browser-observed RTT, not an injected telemetry sample.
    const fixture = state;
    const delay = debug ? url.searchParams.has("session") ? fixture.detailDelayMs ?? fixture.debugDelayMs ?? 80 : fixture.debugDelayMs ?? 80 : fixture.catalogDelayMs ?? 80;
    const failed = debug ? fixture.failure : fixture.catalogFailure;
    await new Promise(resolve => setTimeout(resolve, delay));
    entry.elapsedMs = Date.now() - entry.startedAt;
    entry.status = failed ? 503 : 200;
    // Navigation/selection may cancel an old request. Never answer it from the next load's state.
    if (fixture !== state) { entry.cancelled = "fixture replaced"; return route.abort("aborted").catch(() => {}); }
    return route.fulfill({ status: entry.status, json: failed ? {} : debug ? snapshot(url.searchParams.get("session")) : { sessions: fixture.empty ? [] : fixture.catalog } }).catch(() => {});
  }
  if (url.origin !== base || /^\/(?:telemetry|monitoring|sentry)(?:\/|$)|\/envelope\/?$/i.test(url.pathname)) {
    blockedTelemetry.push(entry); return route.abort();
  }
  return route.continue();
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
page = await context.newPage();
page.setDefaultTimeout(7000);
page.on("pageerror", error => errors.push({ stage, message: error.message, stack: error.stack }));
page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleMessages.push({ stage, type: message.type(), text: message.text() }); });
page.on("requestfailed", request => {
  const entry = requests.findLast(e => e.url === request.url() && e.abortedAt === undefined);
  const abortedAt = Date.now();
  if (entry) { entry.abortedAt = abortedAt; entry.abortElapsedMs = abortedAt - entry.startedAt; }
  requestFailures.push({ stage, url: request.url(), error: request.failure()?.errorText, abortElapsedMs: entry?.abortElapsedMs });
});
// Stable module surface: localized accessible names are still checked via the translated heading.
const landscape = () => page.locator('section[class*="sessions"]');
const resources = () => page.getByRole("region", { name: "Session resources", exact: true });
const observer = () => page.getByRole("region", { name: "Observer telemetry", exact: true });
const rows = () => landscape().locator('button[aria-expanded]');
const row = name => rows().filter({ has: page.locator('[class*="nameText"]').filter({ hasText: new RegExp("^" + name + "$") }) });
const detail = id => page.locator("#debug-session-" + id);
const filters = () => page.getByRole("group", { name: "Task landscape", exact: true });
const search = () => page.getByRole("searchbox");
const poll = type => observer().locator('[data-poll="' + type + '"]');
async function until(check, message = "condition", timeout = 7000) {
  const end = Date.now() + timeout; let last;
  do { try { await check(); return; } catch (error) { last = error; await page.waitForTimeout(60); } } while (Date.now() < end);
  throw new Error(message + ": " + last?.message, { cause: last });
}
async function visible(locator) { await locator.waitFor({ state: "visible" }); }
async function shot(name) { const path = output + "/" + name + ".png"; await page.screenshot({ path, fullPage: true }); return path; }
async function load(overrides = {}, locale = "en", waitRuntime = true) {
  state = { ...fixtures(), ...overrides, loadedAt: Date.now() };
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ reducedMotion: "no-preference" });
  if (page.url().startsWith(base)) await page.evaluate(value => localStorage.setItem("pi-locale", value), locale);
  await page.goto(base + "/debug");
  await visible(page.getByRole("heading", { level: 1, name: locale === "en" ? "Task control" : locale === "zh-CN" ? "任务态势大盘" : "任務態勢大盤", exact: true }));
  if (waitRuntime && !state.empty && !state.catalogFailure && !state.failure) await visible(row("Observation alpha"));
}
async function open(name, id) {
  // The first snapshot automatically selects a resident; clicking an already selected row closes it.
  if (await row(name).getAttribute("aria-expanded") !== "true") await row(name).click();
  await visible(detail(id)); if (state.runtime.includes(id)) await visible(detail(id).getByText(/fixture_event/));
}
async function close() { await resources().getByRole("button", { name: "Close details", exact: true }).click(); }
async function metadata() { const d = resources().locator('details[class*="metadata"]'); if (await d.getAttribute("open") === null) await d.locator("summary").click(); }
async function catalog() { await landscape().getByRole("button", { name: /^Saved directory/ }).click(); }
async function names(expected) { await until(async () => assert.deepEqual((await rows().locator('[class*="nameText"]').allTextContents()).sort(), [...expected].sort()), "visible rows"); }
async function metric(label, value) {
  const tile = page.locator('[class*="metricLabel"]').filter({ hasText: new RegExp("^" + label + "$") }).locator("..");
  await until(async () => assert.equal(await tile.locator("strong").innerText(), String(value)), "metric " + label);
}
async function filter(label, expected) { await filters().getByRole("button", { name: label, exact: true }).click(); await names(expected); }
async function visibility(hidden) {
  await page.evaluate(hidden => {
    if (hidden) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    else delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
async function desktopGeometry(width, height) {
  await page.setViewportSize({ width, height });
  const geometry = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
    return { page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY }, header: rect("header"), body: rect('[class*="page"] > [class*="body"]'),
      scrollers: ['[class*="taskScroll"]', '[class*="inspectorScroll"]', 'aside[class*="overview"]'].map(selector => { const e = document.querySelector(selector); return { selector, overflow: getComputedStyle(e).overflowY, height: e.clientHeight, scrollHeight: e.scrollHeight }; }) };
  });
  assert.ok(geometry.header.height <= 80, "header <=80px: " + JSON.stringify(geometry));
  assert.ok(geometry.body.bottom <= height + 1, "body inside viewport: " + JSON.stringify(geometry));
  assert.ok(geometry.page.height <= height + 1 && geometry.page.width <= width && geometry.page.scrollY === 0, "desktop outer page is one screen: " + JSON.stringify(geometry));
  for (const s of geometry.scrollers) assert.ok(["auto", "scroll"].includes(s.overflow) && s.height > 0, "independent scroller: " + JSON.stringify(s));
  return geometry;
}
async function wheelOwn(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate(e => { e.scrollTop = 0; });
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, surface: document.querySelector('section[class*="page"]').scrollTop }));
  const box = await locator.boundingBox();
  const dimensions = await locator.evaluate(e => ({ height: e.clientHeight, scrollHeight: e.scrollHeight, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }));
  assert.ok(dimensions.scrollHeight > dimensions.height, "fixture must actually overflow its scroll area: " + JSON.stringify(dimensions));
  const viewport = page.viewportSize(), pointerY = Math.max(0, box.y) + Math.min(Math.min(box.y + box.height, viewport.height) - Math.max(0, box.y), 150) / 2;
  assert.ok(pointerY >= 0 && pointerY < viewport.height && box.y + box.height > 0, "scroller must intersect viewport: " + JSON.stringify({ box, viewport }));
  await page.mouse.move(box.x + box.width / 2, pointerY); await page.mouse.wheel(0, 500);
  await until(async () => assert.ok(await locator.evaluate(e => e.scrollTop) > 0), "wheel scrolls its own region " + JSON.stringify(dimensions));
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, surface: document.querySelector('section[class*="page"]').scrollTop })), before, "inner wheel never scrolls outer page");
}
async function mobileGeometry() {
  const geometry = await page.evaluate(() => {
    const box = selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }; };
    return { viewport: { width: innerWidth, height: innerHeight }, surface: { scrollWidth: document.querySelector('section[class*="page"]').scrollWidth, ...box('section[class*="page"]') }, page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY }, sessions: box('section[class*="sessions"]'), tasks: box('[class*="taskScroll"]'), resources: box('section[class*="inspector"]'), overview: box('aside[class*="overview"]') };
  });
  results.push({ name: stage + "-mobile-geometry", evidence: geometry });
  assert.ok(geometry.page.width <= geometry.viewport.width && geometry.surface.scrollWidth <= geometry.viewport.width, "no mobile horizontal overflow including clipped content: " + JSON.stringify(geometry));
  assert.ok(geometry.tasks.clientHeight >= 100 && geometry.tasks.top >= geometry.sessions.top && geometry.tasks.bottom <= geometry.sessions.bottom + 1, "mobile task scroller remains inside its panel: " + JSON.stringify(geometry));
  assert.ok(geometry.resources.top >= geometry.sessions.bottom - 1 && geometry.overview.top >= geometry.resources.bottom - 1, "mobile panels must not overlap: " + JSON.stringify(geometry));
}
async function stableResources() {
  await visible(page.locator('#debug-session-alpha [data-kind="mcp"]'));
  await visible(page.locator('[data-poll="catalog"] [class*="pollHeading"] > span[class*="tone_ok"]'));
}
async function traverseMobile(name) {
  const surface = page.locator('section[class*="page"]').first();
  await surface.evaluate(e => { e.scrollTop = 0; });
  await mobileGeometry(); await shot(name + "-top");
  const header = await page.locator("header").boundingBox();
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2); await page.mouse.wheel(0, 500);
  await until(async () => assert.ok(await surface.evaluate(e => e.scrollTop) > 0), "mobile page itself scrolls vertically");
  await resources().getByRole("heading", { name: /Session resources$/ }).scrollIntoViewIfNeeded(); await shot(name + "-resources");
  await observer().scrollIntoViewIfNeeded();
  const observerBox = await observer().boundingBox(); assert.ok(observerBox.y >= 0 && observerBox.y + observerBox.height <= page.viewportSize().height, "mobile right-column telemetry is reachable");
  await shot(name + "-observer");
  await page.locator("footer").scrollIntoViewIfNeeded();
  // scrollIntoViewIfNeeded may stop at a fractionally clipped last pixel; finish with a real
  // wheel on the footer and verify the actual scroll boundary, not only programmatic alignment.
  const footerBefore = await page.locator("footer").boundingBox();
  await page.mouse.move(footerBefore.x + footerBefore.width / 2, Math.min(page.viewportSize().height - 2, footerBefore.y + 10));
  await page.mouse.wheel(0, 500);
  await until(async () => assert.ok(await surface.evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 1)), "mobile page reaches its bottom boundary");
  const footer = await page.locator("footer").boundingBox(), metrics = await surface.evaluate(e => ({ scrollTop: e.scrollTop, height: e.clientHeight, scrollHeight: e.scrollHeight }));
  assert.ok(footer.y >= 0 && footer.y + footer.height <= page.viewportSize().height && metrics.scrollTop > 0, "mobile footer is reachable: " + JSON.stringify({ footer, metrics }));
  results.push({ name: stage + "-mobile-bottom", evidence: { footer, metrics } }); await shot(name + "-bottom");
}
async function test(name, run) {
  stage = name; const start = Date.now();
  try { await run(); results.push({ name, passed: true, ms: Date.now() - start }); console.log("PASS " + name); }
  catch (error) { const screenshot = await shot("FAIL-" + name).catch(() => null); results.push({ name, passed: false, ms: Date.now() - start, error: error.stack, screenshot }); console.error("FAIL " + name + ": " + error.stack + "\nScreenshot: " + screenshot); }
}
const runtimeNames = ["Observation alpha", "Observation beta", "Aardvark idle", "Other project", "Delegated inspector", "Nested inspector"];
try {
  await test("desktop-density-auto-inspection", async () => {
    await load(); await open("Observation alpha", "alpha"); await stableResources();
    const palette = await page.locator('section[class*="page"]').evaluate(e => {
      const css = getComputedStyle(e); return { paper: css.getPropertyValue("--dbg-paper").trim(), accent: css.getPropertyValue("--dbg-orange").trim(), background: css.backgroundColor, ink: css.color };
    });
    results.push({ name: "latest-palette", evidence: palette });
    assert.ok((palette.background.match(/\d+/g) ?? []).slice(0, 3).every(n => Number(n) < 100), "latest dark graphite palette: " + JSON.stringify(palette));
    for (const [label, value] of [["Ordinary sessions", 4], ["Executing", 2], ["Awaiting input", 1], ["Runtime sessions", 6], ["Runtime subagents", 2], ["SSE connections", 7]]) await metric(label, value);
    await names(runtimeNames); assert.equal(await filters().getByRole("button", { name: "Runtime", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await landscape().locator('[id^="debug-session-"]').count(), 0, "resources not inline in landscape");
    assert.equal(await resources().locator("#debug-session-alpha").count(), 1);
    assert.ok(requests.some(e => e.stage === stage && new URL(e.url).searchParams.get("session") === "alpha"), "automatic read-only detail GET");
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      const geometry = await desktopGeometry(width, height); results.push({ name: "geometry-" + width + "x" + height, passed: true, geometry });
      const mcp = detail("alpha").locator("section").filter({ has: page.getByRole("heading", { name: "MCP", exact: true }) });
      assert.equal(await mcp.getByRole("img").count(), 6, "multi-service capsules");
      const boxes = await mcp.getByRole("img").evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
      assert.ok(boxes.every(b => b.height <= 48), "compact capsules not long cards: " + JSON.stringify(boxes));
      const box = await mcp.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= height, "default MCP visible without scroll: " + JSON.stringify(box));
      assert.equal(await mcp.locator('[data-shape="dashed"][data-pulse="on"]').count(), 1); assert.equal(await mcp.locator('[data-shape="dotted"]').count(), 1);
      await shot("desktop-" + width + "x" + height);
    }
  });
  await test("selection-keyboard-copy-close-reload", async () => {
    await load(); await open("Observation alpha", "alpha"); await open("Observation beta", "beta");
    assert.equal(await row("Observation alpha").getAttribute("aria-expanded"), "false"); assert.equal(await detail("alpha").count(), 0); assert.equal(await landscape().locator('button[aria-expanded="true"]').count(), 1);
    await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())); assert.equal(copied.session.sessionId, "beta"); assert.ok(copied.observation.samples.length > 0); assert.equal(copied.observation.hidden, false);
    await close(); assert.equal(await detail("beta").count(), 0);
    await row("Observation beta").focus(); await page.keyboard.press("Enter"); await visible(detail("beta").getByText(/fixture_event/));
    await page.keyboard.press("Space"); assert.equal(await detail("beta").count(), 0);
    await page.reload(); await visible(row("Observation alpha")); await visible(detail("alpha").getByText(/fixture_event/));
    assert.equal(await row("Observation beta").getAttribute("aria-expanded"), "false", "reload inspects first resident instead of persisting beta");
  });
  await test("relations-and-catalog", async () => {
    await load(); await open("Delegated inspector", "child"); await metadata(); await visible(resources().getByText(/Parent: Observation alpha/)); await visible(resources().getByText("Assignment: Trace fixture delegation chain", { exact: true }));
    await open("Nested inspector", "grandchild"); await metadata(); await visible(resources().getByText(/Parent: Delegated inspector/)); await visible(resources().getByText("Assignment: Inspect nested fixture evidence", { exact: true }));
    await catalog(); await names(["Saved notebook", "Historical child", "Saved fork"]); await visible(landscape().getByText("Not a completed-task count", { exact: true }));
    await open("Saved notebook", "catalog"); assert.equal(await row("Saved notebook").getByRole("img", { name: "Catalog · runtime state unknown", exact: true }).count(), 1); await visible(resources().getByText(/A catalog entry is a saved session, not a task completion record/));
    await open("Saved fork", "fork"); await metadata(); await visible(resources().getByText("Fork source: Observation alpha", { exact: true })); assert.equal(await row("Saved fork").getByText("Subagent", { exact: true }).count(), 0); await shot("catalog");
  });
  await test("nonresident-parent-and-resident-fork", async () => {
    const seed = fixtures(); seed.runtime = ["beta", "gamma", "omega", "child", "grandchild", "fork"]; await load(seed);
    await names([...runtimeNames, "Saved fork"]); await visible(row("Observation alpha").getByText("Parent context · not resident", { exact: true }));
    await metric("Runtime sessions", 6); await metric("Ordinary sessions", 4); await metric("Runtime subagents", 2); assert.equal(await row("Saved fork").getByText("Subagent", { exact: true }).count(), 0);
    await open("Nested inspector", "grandchild"); await metadata(); await visible(resources().getByText(/Parent: Delegated inspector/));
    await open("Observation alpha", "alpha"); await visible(resources().getByText(/A catalog entry is a saved session/)); await shot("nonresident-parent");
  });
  await test("filters-search-project-sort", async () => {
    await load(); await filter("Executing", ["Observation alpha", "Delegated inspector"]); await filter("Awaiting input", ["Observation beta"]); await filter("Runtime", runtimeNames); await filter("Subagents", ["Observation alpha", "Delegated inspector", "Nested inspector"]);
    await filters().getByRole("button", { name: "Runtime", exact: true }).click(); await search().fill("Trace fixture delegation chain"); await names(["Observation alpha", "Delegated inspector"]);
    await search().fill("absent-fixture-term"); await visible(landscape().getByText("No sessions match these filters.", { exact: true })); await search().fill("");
    const project = page.getByRole("combobox", { name: "Project", exact: true }); const option = await project.locator("option").evaluateAll(nodes => nodes.find(n => n.textContent.includes("/test/project"))?.value); assert.ok(option); await project.selectOption(option);
    await names(runtimeNames.filter(n => n !== "Other project")); const before = await rows().locator('[class*="nameText"]').allTextContents();
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("name"); await until(async () => assert.equal(await rows().first().locator('[class*="nameText"]').innerText(), "Aardvark idle")); assert.notDeepEqual(await rows().locator('[class*="nameText"]').allTextContents(), before);
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("recent"); assert.deepEqual(await rows().locator('[class*="nameText"]').allTextContents(), before);
    await project.selectOption(""); await search().fill("omega"); await names(["Other project"]); await catalog(); await search().fill("/test/archive"); await names(["Saved notebook", "Historical child", "Saved fork"]); await shot("filters");
  });
  await test("filtered-and-removed-selection-retention", async () => {
    await load(); await open("Observation alpha", "alpha"); await search().fill("Other project"); await names(["Other project"]); await visible(detail("alpha").getByText(/fixture_event/)); assert.equal(await row("Observation alpha").count(), 0);
    await catalog(); await visible(detail("alpha").getByText(/fixture_event/)); state.runtime = state.runtime.filter(id => id !== "alpha"); state.catalog = state.catalog.filter(i => i.id !== "alpha"); await page.waitForTimeout(2300); await visible(detail("alpha")); await shot("retained-detail"); await close(); assert.equal(await detail("alpha").count(), 0);
  });
  await test("pending-close-and-late-reply-isolation", async () => {
    await load({ detailDelayMs: 1500 }); await visible(detail("alpha").getByText("Waiting for the server's answer about this session…", { exact: true })); await search().fill("Other project"); await names(["Other project"]); await close(); assert.equal(await detail("alpha").count(), 0);
    await page.waitForTimeout(1700); assert.equal(await detail("alpha").count(), 0, "late reply cannot resurrect closed selection");
    await search().fill(""); await row("Observation alpha").click(); await row("Observation beta").click(); assert.equal(await detail("alpha").count(), 0); await visible(detail("beta").getByText(/fixture_event/)); await page.waitForTimeout(1700); assert.equal(await detail("alpha").count(), 0, "late old answer cannot replace current beta"); await shot("late-reply");
  });
  await test("project-root-and-display-title", async () => {
    const seed = fixtures(); seed.catalog.find(s => s.id === "omega").projectRoot = "/test/shared-project-root"; seed.catalog.push(info("zz-sort", "", "project", { firstMessage: "AAA display title" })); seed.runtime.push("zz-sort"); await load(seed);
    await search().fill("/test/shared-project-root"); await names(["Other project"]); await search().fill(""); const project = page.getByRole("combobox", { name: "Project", exact: true }); const option = await project.locator("option").evaluateAll(nodes => nodes.find(n => n.textContent.includes("/test/project"))?.value); assert.ok(option); await project.selectOption(option);
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("name"); await until(async () => assert.equal(await rows().first().locator('[class*="nameText"]').innerText(), "AAA display title"));
  });
  await test("attention-signals", async () => {
    await load({ attention: true }); await open("Observation alpha", "alpha"); const signals = page.getByRole("region", { name: "Signals requiring attention", exact: true });
    for (const text of ["Listener count differs from connected streams: 4", "Extension binding failed", "Liveness provider failed: fixture-keepalive", "MCP error or conflict: fixture-mcp", "fixture-browser: 7 dropped events", "1 MCP configurations not registered or trusted"]) await visible(signals.getByText(text, { exact: true }));
    assert.equal(await signals.getByRole("listitem").count(), 6); await shot("attention");
  });
  await test("countdowns-change-across-real-polls", async () => {
    await load(); await open("Observation alpha", "alpha");
    const read = async () => ({ rowText: await row("Aardvark idle").locator('[class*="idleText"]').innerText(), rowWidth: await row("Aardvark idle").locator('[class*="idleTrack"] > span').getAttribute("style"), mcpText: await detail("alpha").locator('[data-kind="mcp"] [class*="releaseText"]').innerText(), mcpWidth: await detail("alpha").locator('[data-kind="mcp"] [class*="meterFill"]').getAttribute("style"), reapText: await detail("alpha").locator('[data-kind="timing"] [class*="releaseText"]').innerText(), reapWidth: await detail("alpha").locator('[data-kind="timing"] [class*="meterFill"]').getAttribute("style") });
    const before = await read(), count = requests.filter(e => e.stage === stage).length; await page.waitForTimeout(3200); const after = await read(); assert.ok(requests.filter(e => e.stage === stage).length > count);
    for (const key of Object.keys(before)) assert.notEqual(after[key], before[key], "countdown changes: " + key); results.push({ name: "countdown-evidence", passed: true, before, after }); await shot("countdowns");
  });
  await test("observer-real-slow-inflight-http-failure", async () => {
    // Both actual routed responses cross the 2s slow threshold, remaining below the 5s timeout.
    await load({ debugDelayMs: 3800, catalogDelayMs: 3800 }, "en", false);
    for (const type of ["debug", "catalog"]) await visible(poll(type).getByText("In flight", { exact: true }));
    for (const type of ["debug", "catalog"]) await visible(poll(type).getByText("Slow", { exact: true })); await shot("observer-inflight-slow");
    state.debugDelayMs = 80; state.catalogDelayMs = 80;
    for (const type of ["debug", "catalog"]) { await until(async () => assert.ok(await poll(type).locator('rect[class*="sampleSlow"]').count() >= 1), "real slow sample " + type); assert.ok(await poll(type).locator('[class*="progress"] > span').count()); }
    await observer().getByText("Details & visibility", { exact: true }).click(); await visible(observer().getByText("This dashboard's GET requests, not another chat page's network.", { exact: true }));
    assert.ok(requests.filter(e => e.stage === stage && e.elapsedMs >= 3700).length >= 2, "real delayed runtime and catalog GETs recorded");
    state.failure = true; await visible(poll("debug").getByText("Failed", { exact: true })); await until(async () => assert.ok(await poll("debug").locator('rect[class*="sampleFailed"]').count() > 0));
    await visible(page.getByText(/Not the latest answer:/)); await shot("observer-runtime-failure"); state.failure = false; await page.getByText(/Not the latest answer:/).waitFor({ state: "detached" });
    state.catalogFailure = true; await visibility(true); await page.waitForTimeout(30500); await visibility(false);
    await visible(poll("catalog").getByText("Failed", { exact: true })); await until(async () => assert.ok(await poll("catalog").locator('rect[class*="sampleFailed"]').count() > 0));
    await visible(row("Observation alpha")); await visible(page.getByText(/The session list could not be read/));
    assert.equal(await poll("catalog").locator('rect[class*="sampleFailed"]').getAttribute("height"), "23", "failure marker is not a fake RTT"); await shot("observer-catalog-failure");
    assert.ok(requests.some(e => e.stage === stage && new URL(e.url).pathname === "/api/sessions" && e.status === 503));
    state.catalogFailure = false; await visibility(true); await page.waitForTimeout(30500); await visibility(false);
    await page.getByText(/The session list could not be read/).waitFor({ state: "detached" }); await visible(poll("catalog").getByText("Answered", { exact: true })); await shot("observer-recovered");
  });
  for (const type of ["debug", "catalog"]) await test("real-5s-timeout-and-recovery-" + type, async () => {
    const key = type === "debug" ? "debugDelayMs" : "catalogDelayMs";
    await load({ [key]: 6500 }, "en", false);
    await visible(poll(type).getByText("In flight", { exact: true }));
    await visible(poll(type).getByText("Failed", { exact: true }));
    await until(async () => assert.ok(requestFailures.some(e => e.stage === stage && new URL(e.url).pathname === (type === "debug" ? "/api/agent/debug" : "/api/sessions") && e.abortElapsedMs >= 4800 && e.abortElapsedMs < 6200 && e.error === "net::ERR_ABORTED")), "real browser abort near 5s, before the 6500ms response");
    assert.ok(await poll(type).locator('rect[class*="sampleFailed"]').count() > 0, "timeout has a failure marker");
    const abort = requestFailures.findLast(e => e.stage === stage && e.abortElapsedMs >= 4800);
    results.push({ name: stage + "-timing", evidence: abort });
    await shot("timeout-" + type);
    state[key] = 80;
    if (type === "catalog") { await visibility(true); await page.waitForTimeout(30500); await visibility(false); }
    await visible(poll(type).getByText("Answered", { exact: true }));
    await stableResources();
    await visible(row("Observation alpha"));
    assert.ok(await poll(type).locator('rect[class*="sampleFailed"]').count() > 0, "recovery retains actual timeout history");
    await shot("timeout-" + type + "-recovered");
  });
  await test("poll-failure-retains-selected-detail", async () => {
    await load(); await open("Observation beta", "beta"); state.failure = true; await visible(page.getByText(/Not the latest answer:/)); assert.equal(await row("Observation beta").getAttribute("aria-expanded"), "true");
    await visible(detail("beta").getByText(/fixture_event/)); await shot("stale"); state.failure = false; await page.getByText(/Not the latest answer:/).waitFor({ state: "detached" }); await visible(page.getByRole("status").getByText("Snapshot current", { exact: true }));
  });
  await test("desktop-long-list-three-independent-scrolls", async () => {
    const seed = fixtures(); seed.catalog.push(...Array.from({ length: 60 }, (_, i) => info("overflow-" + i, "Overflow " + i))); seed.runtime.push(...Array.from({ length: 60 }, (_, i) => "overflow-" + i)); await load(seed); await open("Observation alpha", "alpha");
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      await desktopGeometry(width, height); await wheelOwn(landscape().locator('[class*="taskScroll"]'));
      // Native disclosure interaction only; no fabricated resource data or telemetry.
      for (const d of await resources().locator("details").all()) if (await d.getAttribute("open") === null) await d.locator("summary").click();
      await wheelOwn(resources().locator('[class*="inspectorScroll"]')); const aside = page.locator('aside[class*="overview"]');
      for (const d of await aside.locator("details").all()) if (await d.getAttribute("open") === null) await d.locator("summary").click();
      await wheelOwn(aside); await desktopGeometry(width, height); await shot("long-list-" + width + "x" + height);
    }
    await row("Overflow 59").click(); await visible(detail("overflow-59").getByText(/fixture_event/)); await desktopGeometry(1440, 900);
  });
  await test("mobile-long-list-scroll-and-bottom", async () => {
    const seed = fixtures(); seed.catalog.push(...Array.from({ length: 60 }, (_, i) => info("overflow-" + i, "Overflow " + i))); seed.runtime.push(...Array.from({ length: 60 }, (_, i) => "overflow-" + i));
    await load(seed); await open("Observation alpha", "alpha"); await page.setViewportSize({ width: 390, height: 844 });
    await mobileGeometry(); await wheelOwn(landscape().locator('[class*="taskScroll"]')); await shot("mobile-long-list");
    await row("Overflow 59").click(); await visible(detail("overflow-59").getByText(/fixture_event/));
    await traverseMobile("mobile-long-list");
  });
  await test("mobile-and-empty", async () => {
    await load(); await stableResources(); await page.setViewportSize({ width: 390, height: 844 }); await open("Observation alpha", "alpha"); await traverseMobile("mobile");
    await load({ empty: true }); await visible(landscape().getByText("No runtime sessions in this snapshot", { exact: true })); assert.equal(await rows().count(), 0);
    for (const label of ["Ordinary sessions", "Executing", "Awaiting input", "Runtime sessions", "Runtime subagents", "SSE connections"]) await metric(label, 0); await shot("empty");
  });
  await test("catalog-failure-and-initial-snapshot-failure", async () => {
    await load({ catalogFailure: true }); await visible(page.getByText("The session list could not be read. Previous metadata is retained if available.", { exact: true })); await until(async () => assert.equal(await rows().count(), 6)); assert.equal(await row("Observation alpha").count(), 0, "no invented catalog metadata"); await metric("Runtime sessions", 6); await shot("catalog-failure");
    await load({ failure: true }); await visible(page.getByRole("status").getByText("Snapshot stale", { exact: true })); assert.equal(await page.getByText(/Not the latest answer:/).count(), 0, "no fictional last good answer"); await metric("Runtime sessions", "—"); await metric("Ordinary sessions", "—"); assert.equal(await rows().count(), 0, "catalog is never promoted into resident summary"); await shot("initial-failure");
  });
  await test("locales-and-reduced-motion", async () => {
    for (const [locale, name] of [["zh-CN", "CN"], ["zh-TW", "TW"], ["en", "EN"]]) { await load({}, locale); await stableResources(); await shot(name); assert.equal(await page.locator("html").getAttribute("lang"), locale); }
    await open("Observation alpha", "alpha"); await page.emulateMedia({ reducedMotion: "reduce" }); assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    const moving = await page.locator("section[aria-label]").first().evaluate(element => [...element.querySelectorAll("*")].filter(node => { const css = getComputedStyle(node); return css.animationName !== "none" && css.animationDuration.split(",").some(t => parseFloat(t) > 0); }).map(node => node.tagName));
    assert.deepEqual(moving, [], "reduced motion disables status lamps, running and decorative animations"); await shot("reduced-motion");
  });
  await test("hidden-pause-resume", async () => {
    await load(); await open("Observation alpha", "alpha");
    // A browser lifecycle fixture only; never inject observer samples or impersonate another client.
    await visibility(true); await visible(page.getByRole("status").getByText("Observation paused", { exact: true })); await page.waitForTimeout(150);
    const count = requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length; await page.waitForTimeout(32000); assert.equal(requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length, count, "hidden pauses BOTH debug and catalog GETs"); await shot("hidden");
    const resumed = page.waitForResponse(r => new URL(r.url()).pathname === "/api/sessions"); await visibility(false); await (await resumed).finished(); await until(async () => assert.ok(requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length >= count + 2), "visible resumes both due GETs");
    await visible(page.getByRole("status").getByText("Snapshot current", { exact: true })); await observer().getByText("Details & visibility", { exact: true }).click(); await visible(observer().getByText("visible", { exact: true })); await shot("resumed");
  });
  await test("network-and-runtime-safety", async () => {
    assert.deepEqual(forbidden, [], "all unapproved APIs / commands / leases / SSE blocked"); assert.deepEqual(errors, [], "no browser runtime exceptions"); assert.deepEqual(consoleMessages.filter(e => e.type === "error" && !/Failed to load resource:.*503/.test(e.text)), [], "no unexpected console errors");
    assert.ok(requests.some(e => new URL(e.url).pathname === "/api/agent/debug")); assert.ok(requests.some(e => new URL(e.url).pathname === "/api/sessions")); assert.ok(requests.every(e => e.method === "GET" && ["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(new URL(e.url).pathname))); assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/debug");
  });
} finally {
  await writeFile(output + "/results.json", JSON.stringify({ base, results, requests, forbidden, blockedTelemetry, errors, consoleMessages, requestFailures }, null, 2)); await browser.close();
}
const checks = results.filter(result => typeof result.passed === "boolean");
const failed = checks.filter(result => !result.passed); console.log((checks.length - failed.length) + "/" + checks.length + " checks passed; " + requests.length + " fixture GETs; " + forbidden.length + " forbidden attempts; screenshots and results: " + output + "/"); if (failed.length) process.exitCode = 1;
