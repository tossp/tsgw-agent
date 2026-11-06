import assert from "node:assert/strict";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chromium } from "playwright";
import { info, fixtures, snapshot, modelStatus } from "./e2e-fixtures.mjs";
import { resourceChecks } from "./e2e-resources.mjs";
import { gridChecks } from "./e2e-grid.mjs";

// Only this harness's fixtures reach /api; reuse the isolated, already-running dev server.
const configuredBase = URL.parse(process.env.E2E_BASE_URL ?? "http://127.0.0.1:30145");
assert.ok(configuredBase, "E2E_BASE_URL must be an absolute URL");
const base = configuredBase.origin;
assert.equal(base, "http://127.0.0.1:30145", "grid harness only uses its isolated loopback service, never 30144 or production");
const runId = (process.env.E2E_RUN_ID ?? new Date().toISOString()).replace(/[^a-zA-Z0-9_-]/g, "-");
const output = "test-results/tsgw-debug-grid/" + runId;
await mkdir(output, { recursive: true });
async function sourceHashes() {
  const files = [];
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await collect(path);
      // Documentation may be finalized concurrently; freeze executable source and scripts.
      else if (/\.(?:tsx?|mjs|css)$/.test(entry.name)) files.push(path);
    }
  }
  await collect("tsgw/debug"); await collect("app/debug");
  files.push("app/globals.css", "components/debug-panel-state.ts", "lib/debug-types.ts", "package.json");
  return Object.fromEntries(await Promise.all(files.sort().map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
}
const startedAt = new Date().toISOString(), beforeHashes = await sourceHashes();
await writeFile(output + "/hashes-before.json", JSON.stringify(beforeHashes, null, 2));
// Cold Turbopack compilation is readiness, not a polling timeout scenario.
const ready = await fetch(`${base}/debug`, { signal: AbortSignal.timeout(60000), redirect: "manual" });
assert.equal(ready.status, 200, `existing dev service not ready: HTTP ${ready.status}; do not restart it`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const requests = [], forbidden = [], blockedTelemetry = [], errors = [], consoleMessages = [], requestFailures = [], results = [];
const entriesByRequest = new WeakMap();
let state, page, stage = "setup";
await context.exposeBinding("__e2eBlocked", (_source, entry) => {
  (entry.kind === "EventSource" ? forbidden : blockedTelemetry).push({ ...entry, stage });
});
await context.addInitScript(() => {
  // Neutral between-fixture documents have no storage origin and run no app code.
  if (!["http:", "https:"].includes(location.protocol)) return;
  if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en");
  window.EventSource = class { constructor(url) { void window.__e2eBlocked({ kind: "EventSource", url: String(url) }); throw new Error("E2E forbids SSE"); } };
  navigator.sendBeacon = url => { void window.__e2eBlocked({ kind: "beacon", url: String(url) }); return false; };
});
// One broad guard, not a few permissive route globs: no unapproved API ever falls through.
await context.route("**/*", async route => {
  const request = route.request(), url = URL.parse(request.url());
  assert.ok(url, "browser supplied an absolute request URL");
  const entry = { url: request.url(), method: request.method(), stage, startedAt: Date.now() };
  if (url.pathname.startsWith("/api/")) {
    requests.push(entry); entriesByRequest.set(request, entry);
    const debug = url.pathname === "/api/agent/debug";
    const statusId = /^\/api\/agent\/([^/]+)$/.exec(url.pathname)?.[1];
    const status = !!statusId && !debug && !["running", "new"].includes(statusId);
    const validQuery = debug ? [...url.searchParams.keys()].every(key => key === "session") && url.searchParams.getAll("session").length <= 1
      : status ? url.searchParams.get("systemPrompt") === "0" && [...url.searchParams.keys()].length === 1 : !url.search;
    if (url.origin !== base || request.method() !== "GET" || !validQuery || !(status || ["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(url.pathname))) {
      forbidden.push(entry); return route.abort();
    }
    if (url.pathname === "/api/cat-config") return route.fulfill({ json: {} });
    const targetId = status ? decodeURIComponent(statusId) : debug ? url.searchParams.get("session") : null;
    if (targetId && (state.empty || !state.runtime.includes(targetId))) { forbidden.push({ ...entry, reason: "nonresident/history read" }); return route.abort(); }
    entry.kind = status ? "status" : debug ? "debug" : "catalog"; entry.targetId = targetId;
    if (status) { entry.status = state.modelFailure ? 503 : 200; return route.fulfill({ status: entry.status, json: state.modelFailure ? {} : modelStatus(state, targetId) }); }
    // Delay is actual browser-observed RTT, not an injected telemetry sample.
    const fixture = state;
    const delay = debug ? url.searchParams.has("session") ? fixture.detailDelayMs ?? fixture.debugDelayMs ?? 80 : fixture.debugDelayMs ?? 80 : fixture.catalogDelayMs ?? 80;
    const failed = debug ? fixture.failure : fixture.catalogFailure;
    await new Promise(resolve => setTimeout(resolve, delay));
    entry.elapsedMs = Date.now() - entry.startedAt;
    entry.status = failed ? 503 : 200;
    // Navigation may cancel an old request. Never answer it from the next load's state.
    if (fixture !== state) { entry.cancelled = "fixture replaced"; return route.abort("aborted").catch(() => {}); }
    return route.fulfill({ status: entry.status, json: failed ? {} : debug ? snapshot(fixture, url.searchParams.get("session")) : { sessions: fixture.empty ? [] : fixture.catalog } }).catch(() => {});
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
  const entry = entriesByRequest.get(request);
  const abortedAt = Date.now();
  if (entry) { entry.abortedAt = abortedAt; entry.abortElapsedMs = abortedAt - entry.startedAt; }
  requestFailures.push({ stage, url: request.url(), error: request.failure()?.errorText, abortElapsedMs: entry?.abortElapsedMs });
});
// Stable module surface: localized accessible names are still checked via the translated heading.
const resources = () => page.getByRole("region", { name: "Session resources", exact: true });
const observer = () => page.getByRole("region", { name: "Observer telemetry", exact: true });
const rows = () => resources().locator("article[data-session-id]").filter({ has: page.locator('[class*="modelLine"]') });
const detail = id => page.locator("#debug-session-" + id);
const poll = type => observer().locator('[data-poll="' + type + '"]');
async function until(check, message = "condition", timeout = 7000) {
  const end = Date.now() + timeout; let last;
  do { try { await check(); return; } catch (error) { last = error; await page.waitForTimeout(60); } } while (Date.now() < end);
  throw new Error(message + ": " + last?.message, { cause: last });
}
async function visible(locator) { await locator.waitFor({ state: "visible" }); }
async function shot(name) { const path = output + "/" + name + ".png"; await page.screenshot({ path, fullPage: true }); return path; }
async function load(overrides = {}, locale = "en", waitRuntime = true) {
  if (page.url().startsWith(base)) await page.evaluate(value => localStorage.setItem("pi-locale", value), locale);
  // Finish unloading the previous poller BEFORE switching fixture residency.
  // Otherwise its valid GET may be judged against the next scenario's roster.
  await page.goto("about:blank");
  state = { ...fixtures(), ...overrides, loadedAt: Date.now() };
  await page.setViewportSize({ width: 1440, height: 900 }); await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(base + "/debug");
  await visible(page.getByRole("heading", { level: 1, name: locale === "en" ? "Task control" : locale === "zh-CN" ? "任务态势大盘" : "任務態勢大盤", exact: true }));
  if (waitRuntime && !state.empty && !state.catalogFailure && !state.failure) await visible(resourceRow("alpha"));
}
const resourceRow = id => page.locator("#resource-" + id);
const resourceScroll = () => resources().locator(":scope > div").nth(1);
async function sampled(id) { await detail(id).getByText(/fixture_event/).waitFor({ state: "visible", timeout: state.runtime.length * 2300 + 7000 }); }
async function residentIds(expected) {
  await until(async () => assert.deepEqual((await rows().evaluateAll(nodes => nodes.map(n => n.dataset.sessionId))).sort(), [...expected].sort()), "only current resident resources");
}
async function copyJson(keyboard = false) {
  const button = page.getByRole("button", { name: "Copy JSON", exact: true });
  if (keyboard) { await button.focus(); await page.keyboard.press("Enter"); } else await button.click();
  await until(async () => assert.equal(await page.getByRole("button", { name: "Copied", exact: true }).count(), 1), "copy feedback");
  const payload = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(payload.session, null, "global snapshot never carries a session detail; details live only in resources");
  return payload;
}
async function metric(label, value) {
  const tile = page.locator('[class*="metricLabel"]').filter({ hasText: new RegExp("^" + label + "$") }).locator("..");
  await until(async () => assert.equal(await tile.locator("strong").innerText(), String(value)), "metric " + label);
}
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
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const aside = document.querySelector('aside[class*="overview"]'), resource = document.querySelector('[aria-label="Session resources"]');
    return { page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY }, header: rect("header"), body: rect('[class*="page"] > [class*="body"]'),
      aside: rect('aside[class*="overview"]'), resources: rect('[aria-label="Session resources"]'), asideBeforeResources: !!(aside.compareDocumentPosition(resource) & Node.DOCUMENT_POSITION_FOLLOWING), bodyColumns: aside.parentElement.children.length,
      scrollers: ['[aria-label="Session resources"] > div:nth-child(2)', 'aside[class*="overview"]'].map(selector => { const e = document.querySelector(selector); return { selector, overflow: getComputedStyle(e).overflowY, height: e.clientHeight, scrollHeight: e.scrollHeight }; }) };
  });
  assert.equal(geometry.bodyColumns, 2, "exactly TWO columns"); assert.ok(geometry.asideBeforeResources, "diagnostic aside precedes resources in DOM");
  assert.ok(geometry.aside.right <= geometry.resources.x && geometry.resources.width > geometry.aside.width, "left diagnostics and larger right resources: " + JSON.stringify(geometry));
  assert.ok(geometry.header.height <= 80, "header <=80px: " + JSON.stringify(geometry));
  assert.ok(geometry.body.bottom <= height + 1, "body inside viewport: " + JSON.stringify(geometry));
  assert.ok(geometry.page.height <= height + 1 && geometry.page.width <= width && geometry.page.scrollY === 0, "desktop outer page is one screen: " + JSON.stringify(geometry));
  for (const scroller of geometry.scrollers) assert.ok(["auto", "scroll"].includes(scroller.overflow) && scroller.height > 0, "independent scroller: " + JSON.stringify(scroller));
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
    return { viewport: { width: innerWidth, height: innerHeight }, surface: { scrollWidth: document.querySelector('section[class*="page"]').scrollWidth, ...box('section[class*="page"]') }, page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollY }, resources: box('[aria-label="Session resources"]'), overview: box('aside[class*="overview"]') };
  });
  results.push({ name: stage + "-mobile-geometry", evidence: geometry });
  assert.ok(geometry.page.width <= geometry.viewport.width && geometry.surface.scrollWidth <= geometry.viewport.width, "no mobile horizontal overflow including clipped content: " + JSON.stringify(geometry));
  assert.ok(geometry.overview.bottom <= geometry.resources.top + 1, "mobile diagnostic-first panels must not overlap: " + JSON.stringify(geometry));
}
async function unknownResources() {
  await visible(resources().getByText("Resources sampled —/—", { exact: true }));
  await visible(resources().getByText("Waiting for data", { exact: true }));
  assert.equal(await resources().getByText("Resources sampled 0/0", { exact: true }).count(), 0, "no empty-instance coverage before a valid snapshot");
  assert.equal(await resources().getByText("No runtime sessions in this snapshot", { exact: true }).count(), 0, "unknown is not an empty runtime");
}
async function stableResources() {
  await visible(page.locator('#debug-session-alpha [data-kind="mcp"]'));
  await visible(page.locator('[data-poll="catalog"] [class*="pollHeading"] > span[class*="tone_ok"]'));
}
async function traverseMobile(name) {
  const surface = page.locator('section[class*="page"]').first();
  await surface.evaluate(e => { e.scrollTop = 0; });
  await mobileGeometry(); await shot(name + "-top");
  const header = await page.locator("header").first().boundingBox();
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2); await page.mouse.wheel(0, 500);
  await until(async () => assert.ok(await surface.evaluate(e => e.scrollTop) > 0), "mobile page itself scrolls vertically");
  await resources().getByRole("heading", { name: "Runtime task families", exact: true }).scrollIntoViewIfNeeded(); await shot(name + "-resources");
  await observer().scrollIntoViewIfNeeded();
  const observerBox = await observer().boundingBox(); assert.ok(observerBox.y >= 0 && observerBox.y + observerBox.height <= page.viewportSize().height, "mobile diagnostic telemetry is reachable");
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
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return;
  stage = name; const start = Date.now();
  try { await run(); results.push({ name, passed: true, ms: Date.now() - start }); console.log("PASS " + name); }
  catch (error) { await writeFile(output + "/FAIL-" + name + ".html", await page.content()); const screenshot = await shot("FAIL-" + name).catch(() => null); results.push({ name, passed: false, ms: Date.now() - start, error: error.stack, screenshot }); console.error("FAIL " + name + ": " + error.stack + "\nScreenshot: " + screenshot); }
}
// Coverage mapping: old task filters/search/catalog focus -> runtime-only + 200-history
// invariance; selection keyboard -> copy keyboard; focus eviction -> exiting resident
// with last global detail; project sorting -> metadata title/path; 3 scrollers -> 2.
try {
  await test("desktop-two-columns-auto-inspection", async () => {
    await load(); await stableResources();
    assert.equal(await page.getByRole("searchbox").count(), 0); assert.equal(await page.getByRole("combobox").count(), 0);
    assert.equal(await page.locator('button[aria-controls^="resource-"]').count(), 0); assert.equal(await page.getByRole("button", { name: "Clear focus", exact: true }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "Task landscape", exact: true }).count(), 0);
    const palette = await page.locator('section[class*="page"]').evaluate(e => ({ background: getComputedStyle(e).backgroundColor }));
    assert.ok((palette.background.match(/\d+/g) ?? []).slice(0, 3).every(v => Number(v) < 100));
    for (const [label, value] of [["Ordinary sessions", 4], ["Executing", 2], ["Awaiting input", 1], ["Runtime sessions", 6], ["Runtime subagents", 2], ["SSE connections", 7]]) await metric(label, value);
    await residentIds(state.runtime);
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      const geometry = await desktopGeometry(width, height); results.push({ name: "geometry-" + width + "x" + height, passed: true, geometry });
      const mcp = detail("alpha").locator('[data-kind="mcp"]'); assert.equal(await mcp.getByRole("img").count(), 6);
      const boxes = await mcp.getByRole("img").evaluateAll(nodes => nodes.map(e => ({ height: e.getBoundingClientRect().height })));
      assert.ok(boxes.every(b => b.height <= 48), "compact MCP capsules");
      const box = await mcp.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= height, "default MCP visible without scroll");
      assert.equal(await mcp.locator('[data-shape="dashed"][data-pulse="on"]').count(), 1); assert.equal(await mcp.locator('[data-shape="dotted"]').count(), 1); await shot("desktop-" + width + "x" + height);
    }
  });
  await test("copy-keyboard-reload", async () => {
    await load(); await sampled("alpha"); await sampled("beta"); const copied = await copyJson(true);
    for (const id of ["alpha", "beta"]) assert.equal(copied.resources[id].reply.session.sessionId, id);
    assert.ok(copied.observation.samples.length > 0); assert.equal(copied.observation.hidden, false);
    await page.reload(); await stableResources(); await residentIds(state.runtime); await sampled("alpha");
  });
  await test("runtime-only-executing-awaiting-idle-closing", async () => {
    await load({ closing: ["omega"], forcedStop: ["gamma"] }); await residentIds(state.runtime);
    for (const [id, status] of [["alpha", "running"], ["beta", "awaiting input"], ["gamma", "alive"], ["omega", "closing"]]) await visible(resourceRow(id).locator("header").getByText(status, { exact: true }));
    await sampled("gamma"); await visible(detail("gamma").getByText(/Stop/)); await shot("runtime-states");
  });
  await test("two-hundred-history-never-resources-or-requests", async () => {
    const seed = fixtures(); seed.catalog = seed.catalog.filter(s => seed.runtime.includes(s.id)); seed.catalog.push(...Array.from({ length: 200 }, (_, i) => info("history-" + i, "History " + i, "archive")));
    await load(seed); await sampled("grandchild"); await residentIds(seed.runtime); await metric("Runtime sessions", 6);
    for (const id of seed.catalog.filter(item => !seed.runtime.includes(item.id)).map(item => item.id)) assert.equal(await resourceRow(id).count(), 0);
    const reads = requests.filter(e => e.stage === stage && !e.abortedAt).map(e => URL.parse(e.url));
    assert.ok(reads.some(url => url.pathname === "/api/sessions"));
    for (const url of reads) { const id = url.searchParams.get("session") ?? (url.searchParams.has("systemPrompt") ? decodeURIComponent(url.pathname.split("/").at(-1)) : null); if (id) assert.ok(seed.runtime.includes(id), "no history/parent activation read: " + url); }
    results.push({ name: "history-invariance", evidence: { history: 200, resources: await rows().count(), requestedIds: reads.filter(u => u.searchParams.has("session")).map(u => u.searchParams.get("session")) } }); await shot("history-excluded");
  });
  await test("relations-nonresident-parent-orphan-and-fork", async () => {
    const seed = fixtures(); seed.runtime = seed.runtime.filter(id => id !== "alpha"); seed.runtime.push("fork", "orphan");
    seed.catalog.push(info("orphan", "Orphan child", "project", { relation: { kind: "subagent", parentSessionId: "missing-parent", profile: "explore", description: "Orphan assignment", status: "running" } }));
    await load(seed); await residentIds(seed.runtime); await sampled("grandchild");
    for (const [id, parent, description] of [["child", "Observation alpha", "Trace fixture delegation chain"], ["grandchild", "Delegated inspector", "Inspect nested fixture evidence"], ["orphan", "missing-", "Orphan assignment"]]) {
      await visible(resourceRow(id).getByText(new RegExp("Parent: " + parent))); await visible(resourceRow(id).getByText(description, { exact: true }));
    }
    await visible(resources().getByText("Observation alpha", { exact: true }));
    for (const id of ["alpha", "missing-parent"]) { const context = resourceRow(id); assert.equal(await context.locator('[class*="modelLine"], [data-kind], [class*="unread"], [class*="age"]').count(), 0, "parent context has no model/resources/unread/sample"); assert.equal(await detail(id).count(), 0); }
    await visible(resourceRow("fork").getByText("Fork source: Observation alpha", { exact: true })); assert.equal(await resourceRow("fork").getByText("Subagent", { exact: true }).count(), 0);
    await metric("Runtime subagents", 3); await metric("Ordinary sessions", 4); await shot("relations");
  });
  await test("exiting-resource-last-global-detail-never-resurrects", async () => {
    await load({ runtime: ["alpha", "child"] }); await sampled("alpha");
    const initial = await copyJson(); assert.equal(initial.resources.alpha.reply.session.sessionId, "alpha");
    // Exit AFTER the guard accepts a resident query, not at Playwright's earlier
    // request event (which can run before context.route and falsely trip the guard).
    state.detailDelayMs = 1500; const after = Date.now();
    const response = page.waitForResponse(r => URL.parse(r.url()).searchParams.get("session") === "alpha" && r.status() === 200);
    await page.waitForRequest(r => URL.parse(r.url()).searchParams.get("session") === "alpha");
    await until(async () => assert.ok(requests.some(e => e.stage === stage && e.targetId === "alpha" && e.startedAt >= after)), "resident request accepted by fixture guard before exit");
    state.runtime = ["child"]; const answer = await response;
    const reply = await answer.json(); assert.equal(reply.session.sessionId, "alpha"); assert.ok(!reply.sessions.some(s => s.sessionId === "alpha"));
    await residentIds(["child"]); assert.equal(await detail("alpha").count(), 0);
    const copied = await copyJson(); assert.equal(copied.session, null, "late wire detail must never become the global published snapshot"); assert.ok(!copied.resources.alpha); assert.ok(!copied.liveModels.alpha);
    const removedAt = Date.now(); await page.waitForTimeout(2300); await residentIds(["child"]); assert.equal(await detail("alpha").count(), 0);
    assert.ok(!requests.some(e => e.stage === stage && e.startedAt >= removedAt && e.targetId === "alpha"), "exited parent gets no further detail/status reads");
    results.push({ name: "exited-cache-eviction", evidence: { wireDetail: reply.session.sessionId, publishedGlobalDetail: copied.session, resources: Object.keys(copied.resources), models: Object.keys(copied.liveModels) } });
    await visible(resources().getByText("Observation alpha", { exact: true })); await shot("exited-parent-context-only");
  });
  await test("slow-detail-replies-stay-with-own-id", async () => {
    await load({ runtime: ["alpha", "beta"], detailDelayMs: 1500 }); await visible(detail("alpha").getByText("Resources not sampled yet · queued for rotation", { exact: true }));
    await sampled("alpha"); await sampled("beta");
    for (const id of ["alpha", "beta"]) assert.equal(await detail(id).getByRole("img", { name: new RegExp("^mcp-" + id + " ") }).count(), 1); await shot("late-reply");
  });
  await test("metadata-title-directory-preserved", async () => {
    const seed = fixtures(); seed.catalog.find(s => s.id === "omega").projectRoot = "/test/shared-project-root"; seed.catalog.push(info("display", "", "metadata", { firstMessage: "AAA display title", branch: "feature/metadata" })); seed.runtime.push("display");
    await load(seed); await visible(resources().locator('[data-family-id="display"]').getByRole("heading", { name: "AAA display title", exact: true })); await visible(resourceRow("display").getByText(/\/test\/metadata/)); await visible(resourceRow("display").getByText(/feature\/metadata/));
  });
  await test("attention-signals", async () => {
    await load({ attention: true }); await sampled("alpha"); const signals = page.getByRole("region", { name: "Signals requiring attention", exact: true });
    for (const text of ["Listener count differs from connected streams: 4", "Extension binding failed", "Liveness provider failed: fixture-keepalive", "MCP error or conflict: fixture-mcp", "fixture-browser: 7 dropped events", "1 MCP configurations not registered or trusted"]) { const signal = signals.getByRole("listitem").filter({ hasText: text }); await visible(signal); assert.equal(await signal.count(), 1); assert.ok((await signal.innerText()).startsWith("Observation alpha · "), "signal names its own source"); }
    assert.equal(await signals.getByRole("listitem").count(), 6); await shot("attention");
  });
  await test("countdowns-change-across-real-polls", async () => {
    await load(); await sampled("alpha");
    const read = async () => ({ mcpText: await detail("alpha").locator('[data-kind="mcp"] [class*="releaseText"]').innerText(), mcpWidth: await detail("alpha").locator('[data-kind="mcp"] [class*="meterFill"]').getAttribute("style"), reapText: await detail("alpha").locator('[data-kind="timing"] [class*="releaseText"]').innerText(), reapWidth: await detail("alpha").locator('[data-kind="timing"] [class*="meterFill"]').getAttribute("style") });
    const before = await read(), count = requests.filter(e => e.stage === stage).length; await page.waitForTimeout(3200); const after = await read(); assert.ok(requests.filter(e => e.stage === stage).length > count);
    for (const key of Object.keys(before)) assert.notEqual(after[key], before[key], "countdown changes: " + key); results.push({ name: "countdown-evidence", passed: true, before, after }); await shot("countdowns");
  });
  await test("observer-real-slow-inflight-http-failure", async () => {
    // Both actual routed responses cross the 2s slow threshold, remaining below the 5s timeout.
    await load({ debugDelayMs: 3800, catalogDelayMs: 3800 }, "en", false);
    for (const type of ["debug", "catalog"]) await visible(poll(type).getByText("In flight", { exact: true }));
    await unknownResources();
    for (const type of ["debug", "catalog"]) await visible(poll(type).getByText("Slow", { exact: true })); await shot("observer-inflight-slow");
    state.debugDelayMs = 80; state.catalogDelayMs = 80;
    for (const type of ["debug", "catalog"]) { await until(async () => assert.ok(await poll(type).locator('rect[class*="sampleSlow"]').count() >= 1), "real slow sample " + type); assert.ok(await poll(type).locator('[class*="progress"] > span').count()); }
    await observer().getByText("Details & visibility", { exact: true }).click(); await visible(observer().getByText("visible", { exact: true }));
    assert.ok(requests.filter(e => e.stage === stage && e.elapsedMs >= 3700).length >= 2, "real delayed runtime and catalog GETs recorded");
    state.failure = true; await visible(poll("debug").getByText("Failed", { exact: true })); await until(async () => assert.ok(await poll("debug").locator('rect[class*="sampleFailed"]').count() > 0));
    await visible(page.getByText(/Not the latest answer:/)); await shot("observer-runtime-failure"); state.failure = false; await page.getByText(/Not the latest answer:/).waitFor({ state: "detached" });
    state.catalogFailure = true; await visibility(true); await page.waitForTimeout(30500); await visibility(false);
    await visible(poll("catalog").getByText("Failed", { exact: true })); await until(async () => assert.ok(await poll("catalog").locator('rect[class*="sampleFailed"]').count() > 0));
    await visible(resourceRow("alpha")); await visible(page.getByText(/The session list could not be read/));
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
    await visible(resourceRow("alpha"));
    assert.ok(await poll(type).locator('rect[class*="sampleFailed"]').count() > 0, "recovery retains actual timeout history");
    await shot("timeout-" + type + "-recovered");
  });
  await test("poll-failure-retains-all-cached-details", async () => {
    await load(); await sampled("beta"); state.failure = true; await visible(page.getByText(/Not the latest answer:/)); await visible(detail("alpha").getByText(/fixture_event/));
    await visible(detail("beta").getByText(/fixture_event/)); await shot("stale"); state.failure = false; await page.getByText(/Not the latest answer:/).waitFor({ state: "detached" }); await visible(page.getByRole("status").getByText("Snapshot current", { exact: true }));
  });
  await test("desktop-long-list-two-independent-scrolls", async () => {
    const seed = fixtures(); seed.catalog.push(...Array.from({ length: 60 }, (_, i) => info("overflow-" + i, "Overflow " + i))); seed.runtime.push(...Array.from({ length: 60 }, (_, i) => "overflow-" + i)); await load(seed); await sampled("alpha");
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      await desktopGeometry(width, height);
      // Native disclosure interaction only; no fabricated resource data or telemetry.
      for (const d of await resources().locator("details").all()) if (await d.getAttribute("open") === null) await d.locator("summary").click();
      await wheelOwn(resourceScroll()); const aside = page.locator('aside[class*="overview"]');
      for (const d of await aside.locator("details").all()) if (await d.getAttribute("open") === null) await d.locator("summary").click();
      await wheelOwn(aside); await desktopGeometry(width, height); await shot("long-list-" + width + "x" + height);
    }
    await resourceRow("overflow-59").scrollIntoViewIfNeeded(); await visible(resourceRow("overflow-59")); await desktopGeometry(1440, 900);
  });
  await test("mobile-long-list-scroll-and-bottom", async () => {
    const seed = fixtures(); seed.catalog.push(...Array.from({ length: 60 }, (_, i) => info("overflow-" + i, "Overflow " + i))); seed.runtime.push(...Array.from({ length: 60 }, (_, i) => "overflow-" + i));
    await load(seed); await sampled("alpha"); await page.setViewportSize({ width: 390, height: 844 });
    await mobileGeometry(); await resourceRow("overflow-59").scrollIntoViewIfNeeded(); await visible(resourceRow("overflow-59")); await shot("mobile-long-list");
    await traverseMobile("mobile-long-list");
  });
  await test("mobile-and-empty", async () => {
    await load(); await stableResources(); await page.setViewportSize({ width: 390, height: 844 }); await sampled("alpha"); await traverseMobile("mobile");
    await load({ empty: true }); await visible(resources().getByText("No runtime sessions in this snapshot", { exact: true })); assert.equal(await rows().count(), 0);
    for (const label of ["Ordinary sessions", "Executing", "Awaiting input", "Runtime sessions", "Runtime subagents", "SSE connections"]) await metric(label, 0); await shot("empty");
  });
  await test("catalog-failure-and-initial-snapshot-failure", async () => {
    await load({ catalogFailure: true }); await visible(page.getByText("The session list could not be read. Previous metadata is retained if available.", { exact: true })); await until(async () => assert.equal(await rows().count(), 6)); assert.equal(await resourceRow("alpha").getByText("Observation alpha", { exact: true }).count(), 0, "no invented catalog metadata"); await sampled("alpha"); await metric("Runtime sessions", 6); await shot("catalog-failure");
    await load({ failure: true }); await visible(page.getByRole("status").getByText("Snapshot stale", { exact: true })); await unknownResources(); assert.equal(await page.getByText(/Not the latest answer:/).count(), 0, "no fictional last good answer"); await metric("Runtime sessions", "—"); await metric("Ordinary sessions", "—"); assert.equal(await rows().count(), 0, "catalog is never promoted into resident summary"); await shot("initial-failure");
  });
  await test("locales-and-reduced-motion", async () => {
    for (const [locale, name] of [["zh-CN", "CN"], ["zh-TW", "TW"], ["en", "EN"]]) { await load({}, locale); await stableResources(); await shot(name); assert.equal(await page.locator("html").getAttribute("lang"), locale); }
    await sampled("alpha"); await page.emulateMedia({ reducedMotion: "reduce" }); assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    const moving = await page.locator("section[aria-label]").first().evaluate(element => [...element.querySelectorAll("*")].filter(node => { const css = getComputedStyle(node); return css.animationName !== "none" && css.animationDuration.split(",").some(t => parseFloat(t) > 0); }).map(node => node.tagName));
    assert.deepEqual(moving, [], "reduced motion disables status lamps, running and decorative animations"); await shot("reduced-motion");
  });
  await test("hidden-pause-resume", async () => {
    await load(); await sampled("alpha");
    // A browser lifecycle fixture only; never inject observer samples or impersonate another client.
    await visibility(true); await visible(page.getByRole("status").getByText("Observation paused", { exact: true })); await page.waitForTimeout(150);
    const count = requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length; await page.waitForTimeout(32000); assert.equal(requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length, count, "hidden pauses BOTH debug and catalog GETs"); await shot("hidden");
    const resumed = page.waitForResponse(r => new URL(r.url()).pathname === "/api/sessions"); await visibility(false); await (await resumed).finished(); await until(async () => assert.ok(requests.filter(e => e.stage === stage && !e.url.includes("cat-config")).length >= count + 2), "visible resumes both due GETs");
    await visible(page.getByRole("status").getByText("Snapshot current", { exact: true })); await observer().getByText("Details & visibility", { exact: true }).click(); await visible(observer().getByText("visible", { exact: true })); await shot("resumed");
  });
  const harness = { test, page, load, until, visible, shot, detail, copyJson, metric, sampled, resources, resourceRow, resourceScroll, desktopGeometry, mobileGeometry, wheelOwn, results, requests, getStage: () => stage, getState: () => state };
  await resourceChecks(harness);
  await gridChecks(harness);
  await test("network-and-runtime-safety", async () => {
    assert.deepEqual(forbidden, [], "all unapproved APIs / commands / leases / SSE blocked"); assert.deepEqual(errors, [], "no browser runtime exceptions"); assert.deepEqual(consoleMessages.filter(e => e.type === "error" && !/Failed to load resource:.*503/.test(e.text)), [], "no unexpected console errors");
    assert.ok(requests.some(e => new URL(e.url).pathname === "/api/agent/debug")); assert.ok(requests.some(e => new URL(e.url).pathname === "/api/sessions")); assert.ok(requests.every(e => e.method === "GET" && (["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(new URL(e.url).pathname) || /^\/api\/agent\/[^/]+$/.test(new URL(e.url).pathname)))); assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/debug");
    results.push({ name: "network-safety-summary", evidence: { fixtureGETs: requests.length, debug: requests.filter(r => r.kind === "debug").length, catalog: requests.filter(r => r.kind === "catalog").length, status: requests.filter(r => r.kind === "status").length, forbidden: forbidden.length, pageErrors: errors.length, blockedTelemetry: blockedTelemetry.length, requestFailures: requestFailures.length } });
  });
} finally {
  const afterHashes = await sourceHashes();
  await writeFile(output + "/hashes-after.json", JSON.stringify(afterHashes, null, 2));
  const unchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
  results.push({ name: "source-and-script-hashes-unchanged", passed: unchanged });
  await writeFile(output + "/results.json", JSON.stringify({ base, output, startedAt, finishedAt: new Date().toISOString(), scope: process.env.E2E_ONLY ? "focused-not-final" : "full-suite", filter: process.env.E2E_ONLY ?? null, unchanged, results, requests, forbidden, blockedTelemetry, errors, consoleMessages, requestFailures }, null, 2)); await browser.close();
}
const checks = results.filter(result => typeof result.passed === "boolean");
const failed = checks.filter(result => !result.passed); console.log((checks.length - failed.length) + "/" + checks.length + " checks passed; " + requests.length + " fixture GETs; " + forbidden.length + " forbidden attempts; screenshots and results: " + output + "/"); if (failed.length) process.exitCode = 1;
