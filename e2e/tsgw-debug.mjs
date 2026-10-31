import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// Fork-only UI check against an already running dev server; no extra server, session or model call.
const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const requests = [];
const errors = [];
let failure = false;
const sessions = ["alpha", "beta"].map((id, index) => ({
  id, name: `Observation ${id}`, path: "", cwd: "/test/project", projectRoot: "/test/project",
  created: "2026-10-30T00:00:00Z", modified: `2026-10-30T00:00:0${index}Z`,
  messageCount: 2, firstMessage: "",
}));

function snapshot(id) {
  const now = Date.now();
  return {
    now,
    server: {
      startedAt: now - 7200000, idleTimeoutMs: 600000, heartbeatMs: 30000,
      wrappers: { alive: sessions.length, closing: 0, starting: 0 }, eventStreams: { total: 2 },
      sseTotal: 3, fileWatches: 1,
      pages: [{ holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux", agent: 2, terminal: 0, fileWatch: 1 }],
      terminals: { count: 0, listeners: 0, detached: 0, exited: 0, nextCleanupAt: null },
    },
    sessions: sessions.map((s, i) => ({
      sessionId: s.id, state: "alive", running: i === 0, awaitingInput: false, subagent: false,
      eventStreams: 1, providers: 1, nextIdleCheckAt: now + 300000, forcedByStop: false, starts: 1,
    })),
    session: id === null ? null : {
      sessionId: id, starting: false,
      wrapper: {
        sessionId: id, state: "alive", stale: false, subagent: false, chatOnly: false,
        createdAt: now - 60000, startedAt: now - 60000, closingAt: null, extensions: "bound",
        run: {
          running: id === "alpha", streaming: id === "alpha", promptRunning: false,
          pendingPrompts: 0, bashRunning: false, compacting: false, retrying: false,
          queuedMessages: 0, waitingForMcp: false, runningTools: 0, mutatingCommands: 0, replacement: null,
        },
        idle: { timeoutMs: 600000, nextCheckAt: now + 300000, lastResetAt: now - 300000, forcedByStop: false },
        awaitingInput: false, pendingUiRequests: 0, customUis: 0, eventListeners: 1,
        lastEvent: { type: "fixture_event", at: now - 1000 }, lastCommand: null,
      },
      lifecycle: { starts: 1, firstStartedAt: now - 60000, lastStartedAt: now - 60000, lastClosedAt: null },
      providers: [{ name: "fixture-keepalive", active: true, byFile: false }],
      eventStreams: [{
        holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux",
        openedAt: now - 60000, connectedAt: now - 59000, lastWriteAt: now - 1000, droppedEvents: 0, queuedBytes: 0,
      }],
      subagents: { active: false, runs: [], notifications: [] },
      mcp: {
        active: true, disposed: false, runActive: false, idleMs: 300000, idleReleaseAt: now + 120000,
        servers: [{ name: "fixture-mcp", scope: "global", state: "connected", hasError: false, released: false }], problems: 0,
      },
    },
  };
}

try {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith("/api/")) requests.push({ url: request.url(), method: request.method() });
  });
  // Keep intentional failure fixtures out of the deployment's existing CAT collection.
  await context.route("**/api/cat-config", (route) => route.fulfill({ json: {} }));
  await context.route("https://cat.tossp.com/**", (route) => route.abort());
  await context.route("**/api/sessions", (route) => route.fulfill({ json: { sessions } }));
  await context.route("**/api/agent/debug**", (route) => route.fulfill({
    status: failure ? 503 : 200,
    json: failure ? {} : snapshot(new URL(route.request().url()).searchParams.get("session")),
  }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await page.goto(`${base}/debug`);
  await page.getByRole("button", { name: /Observation alpha/ }).waitFor();
  assert.deepEqual(errors, []);
  assert.ok(requests.some((r) => new URL(r.url).pathname === "/api/agent/debug"));
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0);

  const alpha = page.getByRole("button", { name: /Observation alpha/ });
  const beta = page.getByRole("button", { name: /Observation beta/ });
  await alpha.click();
  await page.locator("#debug-session-alpha").getByText("fixture_event", { exact: false }).waitFor();
  assert.equal(await alpha.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 1);
  await beta.click();
  await page.locator("#debug-session-beta").getByText("fixture_event", { exact: false }).waitFor();
  assert.equal(await alpha.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#debug-session-alpha").count(), 0);
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 1);
  assert.equal(new URL(page.url()).search, "");

  await page.getByRole("button", { name: "Copy JSON" }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.session.sessionId, "beta");
  await beta.focus();
  await page.keyboard.press("Enter");
  assert.equal(await beta.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Space");
  await page.locator("#debug-session-beta").getByText("fixture_event", { exact: false }).waitFor();

  await mkdir("test-results/tsgw-debug", { recursive: true });
  await page.screenshot({ path: "test-results/tsgw-debug/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal page overflow");
  await page.screenshot({ path: "test-results/tsgw-debug/mobile.png", fullPage: true });

  failure = true;
  await page.getByText(/Not the latest answer:/).waitFor({ timeout: 10000 });
  assert.equal(await beta.getAttribute("aria-expanded"), "true", "a failed poll keeps the last good detail");
  failure = false;
  await page.getByText(/Not the latest answer:/).waitFor({ state: "detached", timeout: 10000 });
  sessions.push(...Array.from({ length: 60 }, (_, i) => ({
    ...sessions[0], id: `overflow-${i}`, name: `Overflow ${i}`,
  })));
  await page.reload();
  const last = page.getByRole("button", { name: /Overflow 59/ });
  await last.waitFor({ timeout: 10000 });
  const topBefore = await last.evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(topBefore > 844, "long list extends beyond the viewport");
  await page.mouse.move(200, 700);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => document.querySelector("section[aria-label]").scrollTop > 0);
  assert.ok(await last.evaluate((element) => element.getBoundingClientRect().top) < topBefore, "wheel scroll reaches lower rows");
  await last.click();
  await page.locator("#debug-session-overflow-59").getByText("fixture_event", { exact: false }).waitFor();
  await page.reload();
  await alpha.waitFor();
  assert.equal(await page.locator('button[aria-expanded="true"]').count(), 0, "selection is page memory only");
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/debug");
  assert.deepEqual(errors, []);
  assert.ok(requests.every((r) => r.method === "GET"), JSON.stringify(requests));
  assert.ok(requests.every((r) => ["/api/agent/debug", "/api/sessions", "/api/cat-config"].includes(new URL(r.url).pathname)), JSON.stringify(requests));
  console.log(`PASS: fixed /debug URL, single expand/collapse, keyboard, copy JSON, mobile layout, long-list scrolling, failed-poll recovery; ${requests.length} GETs, no commands/leases/SSE.`);
} finally {
  await browser.close();
}
