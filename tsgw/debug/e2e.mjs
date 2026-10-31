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
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
const requests = [], forbidden = [], blockedTelemetry = [], errors = [], consoleMessages = [], requestFailures = [], results = [];
let state, page, stage = "setup";
const info = (id, name, project = "project", extra = {}) => ({
  id, name, path: "", cwd: `/test/${project}`, projectRoot: `/test/${project}`,
  created: "2026-10-30T00:00:00Z", modified: "2026-10-30T00:00:10Z", messageCount: 2, firstMessage: "Fixture session", ...extra,
});
function fixtures() {
  return {
    failure: false, catalogFailure: false, empty: false, attention: false,
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
      eventStreams: 1, providers: 1, nextIdleCheckAt: now + 300000, forcedByStop: false, starts: 1,
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
        idle: { timeoutMs: 600000, nextCheckAt: now + 300000, lastResetAt: now - 300000, forcedByStop: false },
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
        active: true, disposed: false, runActive: false, idleMs: 300000, idleReleaseAt: now + 120000,
        servers: [{ name: "fixture-mcp", scope: "global", state: alert ? "failed" : "connected", hasError: alert, released: false }], problems: alert ? 1 : 0,
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
  const entry = { url: request.url(), method: request.method(), stage };
  if (url.pathname.startsWith("/api/")) {
    requests.push(entry);
    const debug = url.pathname === "/api/agent/debug";
    const validQuery = debug ? [...url.searchParams.keys()].every(key => key === "session") && url.searchParams.getAll("session").length <= 1 : !url.search;
    if (url.origin !== base || request.method() !== "GET" || !validQuery || !["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(url.pathname)) {
      forbidden.push(entry); return route.abort();
    }
    if (url.pathname === "/api/cat-config") return route.fulfill({ json: {} });
    // Delay is actual browser-observed RTT, not an injected telemetry sample.
    await new Promise(resolve => setTimeout(resolve, debug && url.searchParams.has("session") ? state.detailDelayMs ?? 80 : 80));
    if (debug) return route.fulfill({ status: state.failure ? 503 : 200, json: state.failure ? {} : snapshot(url.searchParams.get("session")) });
    return route.fulfill({ status: state.catalogFailure ? 503 : 200, json: state.catalogFailure ? {} : { sessions: state.empty ? [] : state.catalog } });
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
page.on("requestfailed", request => requestFailures.push({ stage, url: request.url(), error: request.failure()?.errorText }));
const rows = () => page.locator('section[class*="sessions"] button[aria-expanded]');
const row = name => rows().filter({ hasText: name });
const detail = id => page.locator(`#debug-session-${id}`);
const landscape = () => page.getByRole("region", { name: "Task landscape", exact: true });
const filters = () => page.getByRole("group", { name: "Task landscape", exact: true });
const search = () => page.getByRole("searchbox");
async function until(check, message = "condition", timeout = 7000) {
  const end = Date.now() + timeout;
  let last;
  do { try { await check(); return; } catch (error) { last = error; await page.waitForTimeout(60); } } while (Date.now() < end);
  throw new Error(`${message}: ${last?.message}`, { cause: last });
}
async function visible(locator) { await locator.waitFor({ state: "visible" }); }
async function shot(name) {
  const path = `${output}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  return path;
}
async function load(overrides = {}, locale = "en") {
  state = { ...fixtures(), ...overrides };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if (page.url().startsWith(base)) await page.evaluate(value => localStorage.setItem("pi-locale", value), locale);
  await page.goto(`${base}/debug`);
  await visible(page.getByRole("heading", { level: 1, name: locale === "en" ? "Task control" : locale === "zh-CN" ? "任务态势大盘" : "任務態勢大盤", exact: true }));
  if (!state.empty && !state.catalogFailure) await visible(row("Observation alpha"));
}
async function open(name, id) {
  await row(name).click();
  await visible(detail(id));
  if (state.runtime.includes(id)) await visible(detail(id).getByText(/fixture_event/));
}
async function metric(label, value) {
  const tile = page.locator('[class*="metricLabel"]').filter({ hasText: new RegExp(`^${label}$`) }).locator("..");
  await until(async () => assert.equal(await tile.locator("strong").innerText(), String(value)), `metric ${label}`);
}
async function filter(label, expected) {
  await filters().getByRole("button", { name: label, exact: true }).click();
  await until(async () => assert.deepEqual((await rows().locator('[class*="nameText"]').allTextContents()).sort(), [...expected].sort()), `filter ${label}`);
}
async function test(name, run) {
  stage = name;
  const start = Date.now();
  try { await run(); results.push({ name, passed: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) {
    const screenshot = await shot(`FAIL-${name}`).catch(() => null);
    results.push({ name, passed: false, ms: Date.now() - start, error: error.stack, screenshot });
    console.error(`FAIL ${name}: ${error.stack}\nScreenshot: ${screenshot}`);
  }
}
try {
  await test("desktop-metrics", async () => {
    await load();
    for (const [label, value] of [["Executing", 2], ["Awaiting input", 1], ["Runtime sessions", 6], ["Runtime subagents", 2], ["SSE connections", 7], ["Catalog only", 3]]) await metric(label, value);
    await visible(page.getByText("Not a completed-task count", { exact: true }));
    assert.equal(await rows().count(), 9);
    const header = await page.locator("header").boundingBox();
    const firstMetric = await page.locator('[class*="metricNumber"]').first().boundingBox();
    assert.ok(firstMetric.y >= header.y + header.height && firstMetric.y < 350, `first metric must follow header in first viewport: ${JSON.stringify({ header, firstMetric })}`);
    const firstTask = await rows().first().boundingBox();
    assert.ok(firstTask.y >= 0 && firstTask.y + firstTask.height < 1000, `first task must fit first viewport: ${JSON.stringify(firstTask)}`);
    const metricTops = await page.locator('[class*="metricNumber"]').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(metricTops.length, 6); assert.ok(Math.max(...metricTops) - Math.min(...metricTops) < 2, "six desktop metric columns");
    assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0);
    await shot("desktop"); await shot("EN");
  });
  await test("single-selection-keyboard-copy-url", async () => {
    await load(); await open("Observation alpha", "alpha");
    assert.equal(await row("Observation alpha").getAttribute("aria-expanded"), "true");
    await open("Observation beta", "beta");
    assert.equal(await row("Observation alpha").getAttribute("aria-expanded"), "false");
    assert.equal(await detail("alpha").count(), 0);
    assert.equal(await page.locator('button[aria-expanded="true"]').count(), 1);
    await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(copied.session.sessionId, "beta");
    assert.ok(copied.observation.samples.length > 0);
    assert.equal(copied.observation.hidden, false);
    await row("Observation beta").focus(); await page.keyboard.press("Enter");
    assert.equal(await row("Observation beta").getAttribute("aria-expanded"), "false");
    await page.keyboard.press("Space"); await visible(detail("beta").getByText(/fixture_event/));
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/debug");
    await page.reload(); await visible(row("Observation alpha"));
    assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0, "selection is page memory only");
  });
  await test("relations-and-catalog", async () => {
    await load(); await open("Delegated inspector", "child");
    await visible(landscape().getByText(/Parent: Observation alpha/));
    await visible(landscape().getByText("Assignment: Trace fixture delegation chain", { exact: true }));
    await open("Nested inspector", "grandchild");
    await visible(landscape().getByText(/Parent: Delegated inspector/));
    await visible(landscape().getByText("Assignment: Inspect nested fixture evidence", { exact: true }));
    await open("Saved notebook", "catalog");
    assert.equal(await row("Saved notebook").getByRole("img", { name: "Catalog · runtime state unknown", exact: true }).count(), 1);
    await visible(landscape().getByText(/A catalog entry is a saved session, not a task completion record/));
    await metric("Catalog only", 3); await metric("Executing", 2);
    await open("Saved fork", "fork");
    await visible(landscape().getByText("Fork source: Observation alpha", { exact: true }));
    await shot("catalog");
  });
  await test("filters-search-project-sort", async () => {
    await load();
    await filter("Executing", ["Observation alpha", "Delegated inspector"]);
    await filter("Awaiting input", ["Observation beta"]);
    await filter("Runtime", ["Observation alpha", "Observation beta", "Aardvark idle", "Other project", "Delegated inspector", "Nested inspector"]);
    await filter("Catalog only", ["Saved notebook", "Historical child", "Saved fork"]);
    await filter("Subagents", ["Observation alpha", "Delegated inspector", "Nested inspector", "Historical child"]);
    await filters().getByRole("button", { name: "All sessions", exact: true }).click();
    await search().fill("Trace fixture delegation chain");
    await until(async () => assert.deepEqual(await rows().locator('[class*="nameText"]').allTextContents(), ["Observation alpha", "Delegated inspector"]));
    await search().fill("absent-fixture-term"); await visible(page.getByText("No sessions match these filters.", { exact: true }));
    await search().fill("");
    const project = page.getByRole("combobox", { name: "Project", exact: true });
    const option = await project.locator("option").evaluateAll(nodes => nodes.find(node => node.textContent.includes("/test/project"))?.value);
    assert.ok(option, "project option exists"); await project.selectOption(option);
    await until(async () => assert.equal(await rows().count(), 5));
    assert.equal(await row("Other project").count(), 0); assert.equal(await row("Saved notebook").count(), 0);
    const before = await rows().locator('[class*="nameText"]').allTextContents();
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("name");
    await until(async () => assert.equal(await rows().first().locator('[class*="nameText"]').innerText(), "Aardvark idle"));
    assert.notDeepEqual(await rows().locator('[class*="nameText"]').allTextContents(), before, "name order differs from recent activity");
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("recent");
    assert.deepEqual(await rows().locator('[class*="nameText"]').allTextContents(), before);
    await project.selectOption(""); await search().fill("omega");
    await until(async () => assert.equal(await rows().count(), 1)); await visible(row("Other project"));
    await search().fill("/test/archive"); await until(async () => assert.equal(await rows().count(), 3));
    await shot("filters");
  });
  await test("filtered-detail-retention", async () => {
    await load(); await open("Observation alpha", "alpha");
    await search().fill("Saved notebook");
    await visible(page.getByText("The expanded session is kept here outside the current filters.", { exact: true }));
    await visible(detail("alpha").getByText(/fixture_event/));
    assert.equal(await page.locator('button[aria-expanded="true"]').count(), 1);
    await filters().getByRole("button", { name: "Catalog only", exact: true }).click();
    await visible(detail("alpha").getByText(/fixture_event/));
    await row("Observation alpha").click(); assert.equal(await detail("alpha").count(), 0);
    await shot("pinned-detail");
  });
  await test("pending-detail-filter-close", async () => {
    await load({ detailDelayMs: 1500 });
    await row("Observation alpha").click(); await search().fill("Saved notebook");
    await visible(page.getByText("The expanded session is kept here outside the current filters.", { exact: true }));
    await visible(detail("alpha").getByText("Waiting for the server's answer about this session…", { exact: true }));
    assert.equal(await row("Observation alpha").getAttribute("aria-expanded"), "true");
    await detail("alpha").scrollIntoViewIfNeeded(); await shot("pending-filtered-detail");
    await row("Observation alpha").click();
    assert.equal(await detail("alpha").count(), 0);
    await page.waitForTimeout(1600); assert.equal(await detail("alpha").count(), 0, "late reply cannot resurrect a closed selection");
  });
  await test("project-root-and-display-title", async () => {
    const seed = fixtures(); seed.catalog.find(session => session.id === "omega").projectRoot = "/test/shared-project-root";
    seed.catalog.push(info("zz-sort", "", "project", { firstMessage: "AAA display title" })); seed.runtime.push("zz-sort");
    await load(seed); await search().fill("/test/shared-project-root");
    await until(async () => assert.equal(await rows().count(), 1)); await visible(row("Other project"));
    await search().fill("");
    const project = page.getByRole("combobox", { name: "Project", exact: true });
    const option = await project.locator("option").evaluateAll(nodes => nodes.find(node => node.textContent.includes("/test/project"))?.value);
    assert.ok(option); await project.selectOption(option);
    await page.getByRole("combobox", { name: "Order", exact: true }).selectOption("name");
    await until(async () => assert.equal(await rows().first().locator('[class*="nameText"]').innerText(), "AAA display title"));
  });
  await test("attention-signals", async () => {
    await load({ attention: true }); await open("Observation alpha", "alpha");
    const signals = page.getByRole("region", { name: "Signals requiring attention", exact: true });
    for (const text of ["Listener count differs from connected streams: 4", "Extension binding failed", "Liveness provider failed: fixture-keepalive", "MCP error or conflict: fixture-mcp", "fixture-browser: 7 dropped events", "1 MCP configurations not registered or trusted"]) await visible(signals.getByText(text, { exact: true }));
    assert.equal(await signals.getByRole("listitem").count(), 6);
    await signals.scrollIntoViewIfNeeded(); await shot("attention");
  });
  await test("observer-telemetry", async () => {
    await load();
    const observer = page.getByRole("region", { name: "Observer telemetry", exact: true });
    await visible(observer.getByText("This dashboard's GET requests, not another chat page's network.", { exact: true }));
    const value = label => observer.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
    await until(async () => assert.ok(Number.parseInt(await value("Last round trip").innerText()) >= 60));
    assert.ok(Number(await value("Finished requests").innerText()) > 0);
    assert.equal(await value("Failed requests").innerText(), "0");
    await visible(observer.getByRole("img", { name: "Recent successful round trips" }));
    assert.ok(await observer.locator("polyline").getAttribute("points"));
    await observer.scrollIntoViewIfNeeded(); await shot("observer");
  });
  await test("poll-failure-recovery", async () => {
    await load(); await open("Observation beta", "beta"); state.failure = true;
    await visible(page.getByText(/Not the latest answer:/));
    assert.equal(await row("Observation beta").getAttribute("aria-expanded"), "true");
    await visible(detail("beta").getByText(/fixture_event/)); await shot("stale");
    state.failure = false; await page.getByText(/Not the latest answer:/).waitFor({ state: "detached" });
    await visible(page.getByRole("status").getByText("Snapshot current", { exact: true }));
  });
  await test("mobile-and-long-list", async () => {
    await load(); await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal page overflow");
    await shot("mobile");
    state.catalog.push(...Array.from({ length: 60 }, (_, i) => info(`overflow-${i}`, `Overflow ${i}`)));
    state.runtime.push(...Array.from({ length: 60 }, (_, i) => `overflow-${i}`));
    await page.reload(); await visible(row("Overflow 59"));
    const last = row("Overflow 59"), topBefore = await last.evaluate(element => element.getBoundingClientRect().top);
    assert.ok(topBefore > 844, "long list extends beyond viewport");
    await page.mouse.move(200, 700); await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => document.querySelector("section[aria-label]").scrollTop > 0);
    assert.ok(await last.evaluate(element => element.getBoundingClientRect().top) < topBefore, "wheel scroll reaches lower rows");
    await last.click(); await visible(detail("overflow-59").getByText(/fixture_event/));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("mobile-long-list");
  });
  await test("empty", async () => {
    await load({ empty: true }); await visible(page.getByText("No sessions observed yet", { exact: true }));
    assert.equal(await rows().count(), 0);
    for (const label of ["Executing", "Awaiting input", "Runtime sessions", "Runtime subagents", "SSE connections", "Catalog only"]) await metric(label, 0);
    await shot("empty");
  });
  await test("catalog-failure", async () => {
    await load({ catalogFailure: true });
    await visible(page.getByText("The session list could not be read. Previous metadata is retained if available.", { exact: true }));
    await until(async () => assert.equal(await rows().count(), 6));
    assert.equal(await row("Observation alpha").count(), 0, "no invented catalog metadata");
    await metric("Runtime sessions", 6); await metric("Catalog only", "—"); await shot("catalog-failure");
  });
  await test("failed-first-snapshot", async () => {
    await load({ failure: true }); await visible(page.getByRole("status").getByText("Snapshot stale", { exact: true }));
    assert.equal(await page.getByText(/Not the latest answer:/).count(), 0, "no fictional last good answer");
    await metric("Runtime sessions", "—"); await shot("initial-failure");
  });
  await test("locales-and-reduced-motion", async () => {
    for (const [locale, name] of [["zh-CN", "CN"], ["zh-TW", "TW"], ["en", "EN-switched"]]) {
      await load({}, locale); await shot(name);
      assert.equal(await page.locator("html").getAttribute("lang"), locale);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    const moving = await page.locator("section[aria-label]").first().evaluate(element => [...element.querySelectorAll("*")].filter(node => {
      const css = getComputedStyle(node); return css.animationName !== "none" && css.animationDuration.split(",").some(time => parseFloat(time) > 0);
    }).map(node => node.tagName));
    assert.deepEqual(moving, [], "reduced motion disables running and decorative animations");
    await open("Observation alpha", "alpha"); await shot("reduced-motion");
  });
  await test("hidden-pause-resume", async () => {
    await load();
    // Browser lifecycle fixture only; never impersonates another page or injects server telemetry.
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await visible(page.getByRole("status").getByText("Observation paused", { exact: true }));
    await page.waitForTimeout(150);
    const count = requests.filter(entry => entry.stage === stage && !entry.url.includes("cat-config")).length;
    await page.waitForTimeout(32000);
    assert.equal(requests.filter(entry => entry.stage === stage && !entry.url.includes("cat-config")).length, count, "hidden pauses BOTH debug and catalog GETs");
    await shot("hidden");
    const resumedCatalog = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sessions");
    await page.evaluate(() => { delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
    await (await resumedCatalog).finished(); await page.waitForTimeout(150);
    await until(async () => assert.ok(requests.filter(entry => entry.stage === stage && !entry.url.includes("cat-config")).length >= count + 2), "visible resumes both due requests");
    await visible(page.getByRole("status").getByText("Snapshot current", { exact: true }));
    await visible(page.getByRole("region", { name: "Observer telemetry", exact: true }).getByText("visible", { exact: true }));
    state.catalogFailure = true; await page.waitForTimeout(32000);
    await visible(page.getByText(/The session list could not be read/)); await visible(row("Observation alpha"));
    await page.waitForTimeout(150); state.catalogFailure = false; await page.waitForTimeout(32000);
    await page.getByText(/The session list could not be read/).waitFor({ state: "detached" });
    await shot("resumed");
  });
  await test("network-and-runtime-safety", async () => {
    assert.deepEqual(forbidden, [], "all unapproved APIs / commands / leases / SSE were blocked");
    assert.deepEqual(errors, [], "no browser runtime exceptions");
    assert.deepEqual(consoleMessages.filter(entry => entry.type === "error" && !/Failed to load resource:.*503/.test(entry.text)), [], "no unexpected console errors");
    assert.ok(requests.some(entry => new URL(entry.url).pathname === "/api/agent/debug"));
    assert.ok(requests.some(entry => new URL(entry.url).pathname === "/api/sessions"));
    assert.ok(requests.every(entry => entry.method === "GET" && ["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(new URL(entry.url).pathname)));
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/debug");
  });
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify({ base, results, requests, forbidden, blockedTelemetry, errors, consoleMessages, requestFailures }, null, 2));
  await browser.close();
}
const failed = results.filter(result => !result.passed);
console.log(`${results.length - failed.length}/${results.length} scenarios passed; ${requests.length} fixture GETs; ${forbidden.length} forbidden attempts; screenshots and results: ${output}/`);
if (failed.length) process.exitCode = 1;
