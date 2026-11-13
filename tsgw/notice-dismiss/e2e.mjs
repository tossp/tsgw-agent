// Standalone Chromium regression: node tsgw/notice-dismiss/e2e.mjs
// Cards come from the real extension notify path (ctx.ui.notify -> extension_ui_request
// -> existing addNotice), so nothing here depends on the usage module or a model turn.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startCatCapture } from "../release/smoke-cat.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const lockPath = join(root, ".next/dev/lock");
assert.ok(!existsSync(lockPath), "Use this worktree without another next dev instance");
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  assert.ok(!existsSync(join(root, file)), `Refusing to load potentially real credentials from ${file}`);
}
const artifacts = join(root, "test-results/notice-dismiss");
mkdirSync(artifacts, { recursive: true });
const runLog = createWriteStream(join(artifacts, "run.log"));
const serverLog = createWriteStream(join(artifacts, "server.log"));
const report = (text) => { console.log(text); runLog.write(`${text}\n`); };

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-notice-dismiss-"));
const project = join(agentDir, "project");
const sessionDir = join(agentDir, "sessions", "notice-dismiss");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(project);
mkdirSync(sessionDir, { recursive: true });
// The fixture is a real extension command: it runs inside the SDK command
// dispatcher (no provider request) and emits the same notify request that the
// TUI forwards to the web notice shelf.
writeFileSync(join(agentDir, "extensions", "e2e-notices.js"), `export default function (pi) {
  pi.registerCommand("e2e-notices", {
    description: "Emit synthetic notice-shelf cards for the notice-dismiss regression",
    handler: async (args, ctx) => {
      const [count, tag] = String(args ?? "").trim().split(/\\s+/);
      for (let i = 1; i <= Number(count); i++) ctx.ui.notify("E2E " + tag + " notice " + i);
    },
  });
}`);
const SESSION = "notice-dismiss-fixture";
const epoch = Date.parse("2026-10-25T00:00:00.000Z");
const entry = (id, parentId, role, content, offset) => ({
  type: "message", id, parentId, timestamp: new Date(epoch + offset).toISOString(),
  message: { role, content: [{ type: "text", text: content }], timestamp: epoch + offset },
});
const transcript = [
  { type: "session", version: 3, id: SESSION, timestamp: new Date(epoch).toISOString(), cwd: project },
  entry("user", null, "user", "Notice dismissal fixture", 0),
  entry("answer", "user", "assistant", "Fixture answer", 1_000),
].map((item) => JSON.stringify(item)).join("\n") + "\n";
const sessionFile = join(sessionDir, `2026-10-25T00-00-00-000Z_${SESSION}.jsonl`);
writeFileSync(sessionFile, transcript);

let server, serverExited, browser, context, page, serverError, port, capture;
const errors = [];
const forbidden = [];
const external = [];
const requests = [];
const interrupt = () => { process.exitCode = 1; server?.kill("SIGTERM"); void browser?.close().catch(() => {}); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

/** Bounded wait: a stuck browser or dev server must not hang the regression. */
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          process.exitCode = 1;
          report(`ERROR: ${label} did not finish within ${ms}ms`);
          resolve();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function portFree() {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    return true;
  } catch {
    return false;
  }
}
const cardsText = async () => (await page.locator(".notice-shelf-item > span[tabindex='0']").allTextContents()).map((text) => text.trim());
const card = (index) => page.locator(".notice-shelf-item").nth(index);
const closeOf = (index) => card(index).getByRole("button", { name: "Close", exact: true });
async function waitCards(expected, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await cardsText();
    if (seen.length === expected.length && seen.every((text, index) => text === expected[index])) return;
    await delay(100);
  }
  assert.fail(`notice shelf ${JSON.stringify(seen)} != ${JSON.stringify(expected)}`);
}
async function notify(count, tag) {
  await page.locator("textarea").last().fill(`/e2e-notices ${count} ${tag}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function assertCloseTargets(count) {
  for (let index = 0; index < count; index++) {
    const button = closeOf(index);
    assert.equal(await button.getAttribute("title"), "Close", "localized Close tooltip");
    assert.equal(await button.getAttribute("aria-label"), "Close", "localized Close accessible name");
    const box = await button.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, `card ${index + 1} Close is a 44px target`);
  }
}
const settled = ["E2E D notice 3", "E2E D notice 4", "E2E D notice 5", "E2E D notice 6", "E2E D notice 7"];

try {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Node-side CAT is redirected to a local collector and fails closed on any
  // transport bypass; browser CAT is also captured by the same fixture below.
  capture = await startCatCapture(agentDir);
  report(`Starting owned next dev in ${root} at ${base}; synthetic PI_CODING_AGENT_DIR=${agentDir}`);
  // Do not pass provider credentials, Pi agent markers or a real HOME to Next.
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: agentDir, TMPDIR: tmpdir(), LANG: "C.UTF-8", CI: "1",
      PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", PI_WEB_SKIP_VERSION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1",
      ...capture.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.once("error", (error) => { serverError = error; });
  serverExited = once(server, "exit").catch(() => {});
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see server.log");
    assert.equal(server.signalCode, null, "Server was signalled before readiness; see server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (response?.ok) {
      assert.deepEqual((await response.json()).sessions.map((item) => item.id), [SESSION], "only the synthetic session is visible");
      break;
    }
    assert.ok(Date.now() < deadline, "Server readiness timeout; see server.log");
    await delay(250);
  }
  report("PASS: isolated read-only fixture API (one synthetic session)");
  // Real ensure-session path before any browser prompt: this starts the fixture
  // wrapper and lists its commands. The extension command must be registered so
  // the notify fixture is dispatched by the SDK, never by a model turn.
  const ensured = await fetch(`${base}/api/agent/${SESSION}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "get_commands" }), signal: AbortSignal.timeout(60_000),
  });
  assert.equal(ensured.status, 200, "the fixture session ensures a real wrapper");
  const ensuredBody = await ensured.json();
  assert.equal(ensuredBody.success, true);
  assert.ok(ensuredBody.data?.commands?.some((command) => command.name === "e2e-notices" && command.source === "extension"),
    "the fixture extension command is registered before any browser prompt");
  assert.ok(readFileSync(sessionFile, "utf8").startsWith(transcript), "ensuring the wrapper appends no synthetic messages");
  report("PASS: real ensure-session/get_commands preflight; e2e-notices is a registered extension command (no model)");

  browser = await chromium.launch();
  report(`Chromium ${browser.version()}`);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    const mobile = viewport.width === 375;
    context = await browser.newContext({ viewport, hasTouch: mobile, locale: "en-US", timezoneId: "UTC" });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) {
        external.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      const type = request.method() === "POST" && /^\/api\/agent\/[^/]+$/.test(url.pathname) ? request.postDataJSON()?.type : undefined;
      requests.push(`${request.method()} ${url.pathname}${type ? ` ${type}` : ""}`);
      if (url.pathname === "/api/agent/new" || /\/fork$/.test(url.pathname) || ["steer", "follow_up", "fork", "fork_branch", "clone", "new_session"].includes(type)) {
        forbidden.push(`${request.method()} ${url.pathname} ${type ?? ""}`);
        return route.abort();
      }
      return route.continue();
    });
    // Registered last so it wins over the catch-all for cat.tossp.com requests.
    await capture.routeBrowser(context);
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
    page.on("response", (response) => { if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Fixture answer", { exact: true }).first().waitFor();

    if (!mobile) {
      await notify(7, "D");
      await waitCards(settled);
      report("PASS desktop: seven notify requests keep the newest MAX_NOTICES=5 cards; queued cards fill in as older ones leave");
      await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
      await delay(250); // Let the last card's entrance animation finish before measuring it.
      await assertCloseTargets(5);
      report("PASS desktop: every card exposes the localized Close label with a 44px target");

      await delay(2_500);
      const hovered = await card(0).boundingBox();
      assert.ok(hovered);
      await page.mouse.move(hovered.x + 8, hovered.y + hovered.height / 2);
      await delay(3_500);
      await waitCards(settled);
      report("PASS desktop: hovering a card pauses auto-expiry past the 5s window");
      const resumeAt = Date.now();
      await page.mouse.move(2, 2);
      await page.waitForFunction(() => document.querySelectorAll(".notice-shelf-item").length === 4, undefined, { timeout: 7_000 });
      const resumedMs = Date.now() - resumeAt;
      assert.ok(resumedMs < 4_600, `expiry resumed from the remaining time, not a restarted 5s (${resumedMs}ms)`);
      await waitCards(settled.slice(1));
      report(`PASS desktop: leaving the card resumes expiry after ${resumedMs}ms (remaining time, not a reset)`);

      await card(0).locator("span[tabindex='0']").focus();
      await delay(6_000);
      await waitCards(settled.slice(1));
      report("PASS desktop: keyboard focus also pauses auto-expiry");
      await page.keyboard.press("Tab");
      assert.deepEqual(await page.evaluate(() => ({
        className: document.activeElement?.className ?? "",
        ownCard: document.activeElement?.closest(".notice-shelf-item") === document.querySelector(".notice-shelf-item"),
      })), { className: "notice-shelf-dismiss", ownCard: true }, "Tab reaches the Close button of the focused card");
      await page.keyboard.press("Space");
      await waitCards(settled.slice(2));
      report("PASS desktop: Tab + Space dismisses exactly the focused card");

      await closeOf(1).click();
      await waitCards([settled[2], settled[4]]);
      report("PASS desktop: clicking a middle card removes only that card");
      await closeOf(1).click();
      await waitCards([settled[2]]);
      await closeOf(0).click();
      await waitCards([]);
      report("PASS desktop: each remaining card closes independently");
    } else {
      await notify(2, "M");
      await waitCards(["E2E M notice 1", "E2E M notice 2"]);
      await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
      await delay(250); // Let the last card's entrance animation finish before measuring it.
      await assertCloseTargets(2);
      const bounds = await card(0).boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "notice fits the 375px viewport");
      await closeOf(0).tap();
      await waitCards(["E2E M notice 2"]);
      await closeOf(0).tap();
      await waitCards([]);
      report("PASS mobile: 44px Close targets fit the viewport; tap closes only the tapped card");
    }
    assert.deepEqual(errors, [], `no browser errors at ${viewport.width}px`);
    await context.tracing.stop({ path: join(artifacts, `${viewport.width}-trace.zip`) });
    await context.close();
    context = page = undefined;
  }
  assert.deepEqual(forbidden, [], "no fork, clone or new-session commands");
  assert.deepEqual(external, [], "no model provider or third-party requests");
  assert.ok(readFileSync(sessionFile, "utf8").startsWith(transcript), "original synthetic transcript remains unchanged");
  report("PASS: extension-notify fixture only; no model request, fork or extra session");
} catch (error) {
  console.error(error);
  runLog.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
} finally {
  writeFileSync(join(artifacts, "requests.json"), JSON.stringify({ requests, forbidden, external, errors }, null, 2));
  if (context) await bounded(context.tracing.stop({ path: join(artifacts, "last-trace.zip") }).catch(() => {}), 15_000, "trace stop");
  const closing = browser?.close().catch(() => {});
  await bounded(closing ?? Promise.resolve(), 20_000, "browser close");
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await bounded(serverExited, 15_000, "next dev exit");
    clearTimeout(forceKill);
  }
  if (capture) {
    try {
      capture.assertClean();
      report("PASS: no CAT transport bypassed the local capture");
    } catch (error) {
      process.exitCode = 1;
      report(`ERROR: ${error.message}`);
    }
    await bounded(capture.close(), 10_000, "CAT capture close");
  }
  if (port) {
    let free = false;
    for (let attempt = 0; attempt < 100 && !free; attempt++) {
      free = await portFree();
      if (!free) await delay(100);
    }
    if (!free) {
      process.exitCode = 1;
      report(`ERROR: owned port ${port} is still bound after shutdown`);
    } else {
      report(`PASS: owned server stopped and port ${port} is released`);
    }
  }
  // This Next version can leave its metadata file after a graceful exit.
  // Remove only this run's lock after verifying its recorded process is dead.
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lock.appUrl === `http://127.0.0.1:${port}`) {
        const alive = () => { try { process.kill(lock.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
        for (let retry = 0; retry < 50 && alive(); retry++) await delay(100);
        if (!alive()) rmSync(lockPath);
        else { process.exitCode = 1; report(`ERROR: owned Next worker ${lock.pid} did not stop; lock preserved.`); }
      }
    } catch (error) {
      process.exitCode = 1;
      report(`ERROR: could not inspect the Next dev lock: ${error}`);
    }
  }
  rmSync(agentDir, { recursive: true, force: true });
  report(`Cleanup: synthetic agent directory removed (${!existsSync(agentDir)}).`);
  serverLog.end();
  runLog.end();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
