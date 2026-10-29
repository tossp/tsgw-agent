// Standalone CAT regression: fixed DSN, host identity and real browser SDK envelopes.
// Browser envelopes stay local unless CAT_E2E_LIVE=1 explicitly enables live receipt checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = process.env.CAT_E2E_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(["dev", "start"].includes(mode));
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");
const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const marker = `cat-e2e-${Date.now()}`;
const live = process.env.CAT_E2E_LIVE === "1";
const events = [];
const itemTypes = [];

function parseEnvelope(body) {
  const lines = body.toString().split("\n");
  for (let index = 1; index + 1 < lines.length; index += 2) {
    const header = JSON.parse(lines[index]);
    itemTypes.push(header.type);
    if (header.type === "event") events.push(JSON.parse(lines[index + 1]));
  }
}

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-cat-e2e-"));
const password = `local-${marker}`;
const authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
const log = createWriteStream(join(artifacts, `cat-${mode}.log`));
const child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: password,
    SENTRY_DSN: "", SENTRY_ENVIRONMENT: "test", SENTRY_INSTANCE: "must-not-override-hostname",
    SENTRY_RELEASE: "", SENTRY_AUTH_TOKEN: "", NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(child, "exit");
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
let browser;

try {
  const deadline = Date.now() + 120_000;
  let config;
  while (!config) {
    assert.equal(child.exitCode, null, "Server exited before readiness");
    const response = await fetch(`${base}/api/cat-config`).catch(() => null);
    if (response?.ok) {
      config = await response.json();
      assert.equal(config.dsn, "https://24d86d19be5d513074e45febd5b004b8@cat.tossp.com/10");
      assert.equal(config.initialScope.tags.instance, hostname());
      assert.equal(config.environment, "test");
      assert.equal(config.dataCollection.userInfo, true);
      assert.match(config.release, /^tsgw-agent@/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      break;
    }
    assert.ok(Date.now() < deadline, "Server readiness timeout");
    await delay(200);
  }
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/api/cat-config`, { headers: { origin: "https://evil.example" } })).status, 403);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const transmissions = [];
  await page.route("https://cat.tossp.com/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      assert.ok(request.url().startsWith("https://cat.tossp.com/api/10/envelope/"));
      parseEnvelope(request.postDataBuffer());
      if (live) {
        const response = await route.fetch();
        assert.ok(response.ok(), `CAT upload returned HTTP ${response.status()}`);
        transmissions.push(response.status());
        await route.fulfill({ response });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  page.on("pageerror", () => {}); // The exception below is deliberately uncaught.
  await page.goto(`${base}/login`);
  await page.waitForFunction(() => Object.values(window.__SENTRY__ || {}).some((carrier) => carrier?.defaultCurrentScope?.getClient?.()));
  const message = `TSGW CAT fixed configuration ${mode} ${marker}`;
  await page.evaluate((text) => { setTimeout(() => { throw new Error(text); }, 0); }, message);
  const receiptDeadline = Date.now() + 30_000;
  while (!events.some((event) => event.exception?.values?.some((value) => value.value === message)) || (live && transmissions.length === 0)) {
    assert.ok(Date.now() < receiptDeadline, "Timed out waiting for browser error envelope");
    await delay(100);
  }
  for (const event of events) {
    assert.equal(event.tags.instance, hostname());
    assert.equal(event.environment, "test");
    assert.equal(event.release, config.release);
    assert.equal(event.sdk.settings.infer_ip, "auto");
  }
  if (live) {
    // Live mode also sends one server-side error; receipt must be confirmed via ts_tool → cat.
    const failed = await page.request.post(`${base}/api/agent/new`, {
      headers: { authorization }, data: { cwd: root, type: "ensure_session", provider: "cat-e2e" },
    });
    assert.equal(failed.status(), 500);
    await delay(2000);
  }
  assert.ok(!itemTypes.some((type) => ["transaction", "span", "profile", "log", "trace_metric", "replay_event", "replay_recording"].includes(type)));
  const evidence = { mode, live, marker, instance: hostname(), release: config.release, eventIds: events.map((event) => event.event_id), itemTypes };
  writeFileSync(join(artifacts, `cat-${mode}-evidence.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  console.log(live ? "CAT transport: PASS; verify browser/server receipt and source frames through ts_tool → cat" : "CAT fixed config and intercepted browser SDK envelope: PASS (no live receipt verification)");
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timeout);
  log.end();
  rmSync(agentDir, { recursive: true, force: true });
}
