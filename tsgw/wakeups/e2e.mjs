// Run explicitly: node tsgw/wakeups/e2e.mjs
// Real AppShell/session catalogue + synthetic wakeup reads; no agent SSE, leases or models reach the server.
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
assert.ok(!existsSync(join(root, ".next/dev/lock")), "This worktree must have no active dev server");
for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
  assert.ok(!existsSync(join(root, file)), `Refusing potentially real configuration: ${file}`);
}
const artifacts = join(root, "test-results/wakeups");
mkdirSync(artifacts, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), "pi-wakeup-panel-"));
const stateDirectory = join(agentDir, "integrations", "wakeups");
mkdirSync(stateDirectory, { recursive: true });
const httpTasks = ["pending", "run_settled", "cancelled", "closed", "run_aborted", "delivery_failed", "unknown"].map(status => ({
  wakeupId: `http-${status}`, sourceSessionId: "unrelated-http-source", targetSessionId: "wakeup-panel-main", message: `HTTP fixture ${status}`,
  status, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", scheduledAt: "2099-01-01T00:00:00.000Z",
  ...(["run_settled", "run_aborted"].includes(status) ? { settledAt: "2026-11-01T00:01:00.000Z" } : {}),
}));
writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({ version: 1, tasks: httpTasks }));
const project = join(agentDir, "project");
const sessionsDir = join(agentDir, "sessions", "fixture");
mkdirSync(project);
mkdirSync(sessionsDir, { recursive: true });
const timestamp = "2026-11-01T00:00:00.000Z";
const mainId = "wakeup-panel-main", childId = "wakeup-panel-child", sideId = "wakeup-panel-side";
const originals = new Map();
for (const [id, kind, title] of [[mainId, null, "Wakeup fixture main"], [childId, "subagent", "Fixture child"], [sideId, "side", "Fixture side"]]) {
  const rows = [{ type: "session", version: 3, id, timestamp, cwd: project,
    ...(kind ? { parentSession: join(sessionsDir, `${mainId}.jsonl`) } : {}),
  }];
  let parentId = null;
  const append = (type, fields) => {
    const entry = { type, id: `${id}-${rows.length}`, parentId, timestamp, ...fields };
    rows.push(entry); parentId = entry.id;
  };
  if (kind) append("custom", { customType: `pi-web:${kind}`, data: {
    version: 1, parentSessionId: mainId, createdAt: timestamp,
    ...(kind === "subagent" ? { parentSessionPath: join(sessionsDir, `${mainId}.jsonl`), profile: "fixture", description: title } : {}),
  } });
  append("session_info", { name: title });
  append("message", { message: { role: "user", content: title, timestamp: Date.parse(timestamp) } });
  append("message", { message: { role: "assistant", content: [{ type: "text", text: `Answer ${id}` }], timestamp: Date.parse(timestamp),
    model: "fixture", provider: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
  if (kind === "subagent") append("custom", { customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: timestamp } });
  const text = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const file = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(file, text); originals.set(file, text);
}
const items = ["pending", "received", "run_settled"].map((status, i) => ({
  wakeupId: `fixture-${i}`, sourceSessionId: status === "run_settled" ? "unrelated-source" : mainId, targetSessionId: mainId, cwd: project,
  summary: `Handoff ${status}`, scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: timestamp, updatedAt: timestamp,
  status, armed: status === "pending", ...(status === "run_settled" ? { responseEntryIds: [`${mainId}-3`] } : {}),
}));
const wakeups = { items, nextCursor: null, health: { state: "ready", isOwner: true } };
let server, serverExited, browser, page, capture;
const log = createWriteStream(join(artifacts, "server.log"));
try {
  capture = await startCatCapture(agentDir);
  const probe = createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: agentDir, TMPDIR: tmpdir(), LANG: "C.UTF-8", CI: "1", NODE_ENV: "development",
      PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", PI_WEB_SKIP_VERSION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1", ...capture.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverExited = once(server, "exit");
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 120000;
  while (true) {
    assert.equal(server.exitCode, null, "dev server exited; see server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) {
      const catalogue = (await response.json()).sessions;
      assert.deepEqual(catalogue.map(s => s.id).sort(), [mainId, childId, sideId].sort());
      assert.equal(catalogue.find(s => s.id === childId).relation?.kind, "subagent");
      assert.equal(catalogue.find(s => s.id === sideId).relation?.kind, "side");
      break;
    }
    assert.ok(Date.now() < deadline, "dev server readiness timeout");
    await delay(250);
  }
  const globalState = await (await fetch(`${base}/api/tsgw/wakeups`)).json();
  assert.equal(globalState.health.state, "ready");
  assert.deepEqual(globalState.items.map(task => task.wakeupId).sort(), ["http-delivery_failed", "http-pending", "http-run_aborted", "http-unknown"], "owner clears normal terminal records and preserves exceptions");
  for (const [id, status] of [["http-run_settled", 404], ["http-pending", 409], ["http-cancelled", 404], ["http-closed", 404], ["http-unknown", 409], ["http-run_aborted", 200], ["http-delivery_failed", 200]]) {
    const response = await fetch(`${base}/api/tsgw/wakeups/${id}`, { method: "DELETE" });
    assert.equal(response.status, status, `${id}: ${await response.text()}`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const remaining = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8"));
  assert.deepEqual(remaining.tasks.map(task => task.wakeupId), ["http-pending", "http-unknown"]);
  console.log("PASS real HTTP automatic cleanup keeps exceptions visible; failures/interruptions allow manual cleanup; active/unknown rejected; manifest only");
  browser = await chromium.launch({ headless: true });
  for (const [width, locale, wakeupTitle, agentsTitle] of [[1280, "en", "Wakeups", "Agents"], [320, "en", "Wakeups", "Agents"], [390, "zh-CN", "唤醒", "代理"], [320, "zh-TW", "喚醒", "代理"]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(value => localStorage.setItem("pi-locale", value), locale);
    const external = [], errors = [], unsafe = [], wakeupRequests = [];
    const contextItems = items.map(item => ({ ...item }));
    let statsRequests = 0;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith("/api/agent/")) {
        if (url.pathname === "/api/agent/running") return route.fulfill({ json: { runningSessionIds: [], awaitingInputSessionIds: [] } });
        if (url.pathname.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"connected","isStreaming":false}\n\n' });
        return route.fulfill({ json: { isStreaming: false, isCompacting: false, running: false, awaitingInput: false, subagentsActive: false } });
      }
      if (url.pathname === "/api/sessions/stats") {
        statsRequests++;
        return route.fulfill({ json: { stats: {} } });
      }
      if (url.pathname.startsWith("/api/tsgw/wakeups")) {
        wakeupRequests.push({ method: request.method(), path: url.pathname, query: url.search });
        assert.equal(url.searchParams.has("session_id"), false, "panel queries global state");
        const index = contextItems.findIndex(item => url.pathname.endsWith(`/${item.wakeupId}`));
        if (request.method() === "DELETE") {
          assert.equal(contextItems[index]?.status, "run_settled");
          const [removed] = contextItems.splice(index, 1);
          return route.fulfill({ json: { wakeupId: removed.wakeupId } });
        }
        assert.equal(request.method(), "GET");
        const item = contextItems[index];
        return route.fulfill({ json: { ...wakeups, items: item ? [{ ...item, message: "Synthetic handoff body" }] : contextItems } });
      }
      if (request.method() !== "GET" && url.pathname !== "/api/sessions/stats") {
        // Block unrelated initialization writes too, including preferences and leases.
        unsafe.push(url.pathname);
        return route.fulfill({ json: {} });
      }
      return route.continue();
    });
    await capture.routeBrowser(context);
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", error => errors.push(error.message));
    if (width === 1280) {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: new RegExp(`^${wakeupTitle} · 3`) }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has("session"), false, "global entry is available without selecting a session");
      await page.getByRole("button", { name: new RegExp(`^${wakeupTitle} · 3`) }).click();
      await page.getByRole("region", { name: new RegExp(`^${wakeupTitle}`) }).getByText("Handoff run_settled", { exact: true }).waitFor();
    }
    await page.goto(`${base}/?session=${mainId}`, { waitUntil: "domcontentloaded" });
    await page.getByText(`Answer ${mainId}`, { exact: true }).waitFor();
    const trigger = page.getByRole("button", { name: new RegExp(`^${wakeupTitle} · 3`) });
    await trigger.waitFor();
    assert.ok((await trigger.getAttribute("aria-label")).includes("2"), "entry describes the active records");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    const agents = width <= 480 ? page.locator('[data-mobile-toolbar-action="agents"]') : page.getByRole("button", { name: agentsTitle, exact: true });
    await trigger.click();
    const panel = page.getByRole("region", { name: new RegExp(`^${wakeupTitle}`) });
    await panel.waitFor();
    await panel.getByText("Handoff run_settled", { exact: true }).waitFor();
    assert.equal(await page.locator("dialog").count(), 0);
    assert.equal(statsRequests, 0, "opening global wakeups does not request usage statistics");
    const triggerBox = await trigger.boundingBox(), panelBox = await panel.boundingBox();
    assert.ok(panelBox.y >= triggerBox.y + triggerBox.height - 1, "panel opens below the toolbar");
    assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= width + 1, "panel fits the chat/viewport");
    assert.equal(await panel.evaluate(node => node.scrollWidth > node.clientWidth), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(artifacts, `panel-${width}-${locale}.png`) });
    await trigger.click();
    assert.equal(await panel.count(), 0, "same button collapses its panel");
    await trigger.click();
    await page.keyboard.press("Escape");
    assert.equal(await panel.count(), 0);
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await trigger.click();
    await agents.click();
    assert.equal(await panel.count(), 0);
    const agentPanel = page.getByRole("listbox");
    await agentPanel.waitFor();
    await agentPanel.getByText("Fixture child", { exact: true }).waitFor();
    await agentPanel.getByText("Fixture side", { exact: true }).waitFor();
    await trigger.click();
    await panel.waitFor();
    assert.equal(await agentPanel.count(), 0, "opening wakeups replaces Agents");
    if (width <= 480) {
      for (const button of [agents, page.locator('[data-mobile-toolbar-more="true"]'), page.locator('[data-mobile-toolbar-stats="true"]'), page.locator('[data-mobile-toolbar-file="true"]')]) {
        assert.equal(await button.count(), 1);
        assert.equal(await button.isVisible(), true);
        const box = await button.boundingBox();
        assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1, "original toolbar control remains visible");
      }
      await page.locator('[data-mobile-toolbar-stats="true"]').click();
      assert.equal(await panel.count(), 0, "session stats replace wakeups");
      await trigger.click();
      await panel.waitFor();
      await page.locator('[data-mobile-toolbar-more="true"]').click();
      assert.equal(await panel.count(), 0, "More is mutually exclusive too");
      await trigger.click();
      assert.equal(await page.locator('[data-mobile-toolbar-actions="true"]').count(), 0, "wakeup closes More");
    }
    await panel.waitFor();
    await page.screenshot({ path: join(artifacts, `mutual-${width}-${locale}.png`) });
    const finished = panel.locator('[data-wakeup-id="fixture-2"]');
    await finished.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifacts, `cleanup-ready-${width}-${locale}.png`) });
    await finished.getByRole("button", { name: locale === "en" ? "Clear" : "清理", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-wakeup-id="fixture-2"]'));
    await page.getByRole("button", { name: new RegExp(`^${wakeupTitle} · 2`) }).waitFor();
    assert.equal(await panel.locator("li").count(), 2);
    assert.equal(wakeupRequests.filter(request => request.method === "DELETE").length, 1);
    await page.screenshot({ path: join(artifacts, `cleared-${width}-${locale}.png`) });
    assert.ok(wakeupRequests.length > 0 && wakeupRequests.every(r => ["GET", "DELETE"].includes(r.method)));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.ok(!unsafe.some(path => path.includes("/wakeups")), "only explicit fixture cleanup mutates wakeups");
    await context.close();
    console.log(`PASS ${width}px ${locale}: actual AppShell, status/count, toggle/Escape, Agents/side rows, More, bounds; intercepted agent I/O`);
  }
  for (const [file, original] of originals) assert.equal(readFileSync(file, "utf8"), original, "fixture sessions remain unchanged");
  capture.assertClean();
  console.log("PASS fixture session bytes unchanged; CAT captured locally");
} catch (error) {
  console.error(error); process.exitCode = 1;
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 10000);
    await serverExited; clearTimeout(force);
  }
  log.end(); await capture?.close();
  rmSync(agentDir, { recursive: true, force: true });
}
