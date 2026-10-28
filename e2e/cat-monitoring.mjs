// Standalone CAT regression: runtime DSN in a prebuilt package, real SDK envelopes,
// browser/server failures and disabled mode. No model calls or production sessions.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { chromium } from "playwright";

const root = process.env.CAT_E2E_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(["dev", "start"].includes(mode));
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");
const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const instance = `cat-e2e-${Date.now()}`;
const live = Boolean(process.env.CAT_E2E_DSN);
const received = [];
const itemTypes = [];
const browserEvents = [];
const fixtureDirs = [];

function parseEnvelope(body) {
  try {
    const lines = body.toString().split("\n");
    const events = [];
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const header = JSON.parse(lines[index]);
      itemTypes.push(header.type);
      if (header.type === "event") events.push(JSON.parse(lines[index + 1]));
    }
    return events;
  } catch (error) {
    assert.fail(`Malformed SDK envelope: ${error.message}`);
  }
}

async function waitFor(check, label) {
  const deadline = Date.now() + 90_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(100);
  }
}

const collector = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    received.push(...parseEnvelope(req.headers["content-encoding"] === "gzip" ? gunzipSync(data) : data));
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
collector.listen(0, "127.0.0.1");
await once(collector, "listening");
const dsn = process.env.CAT_E2E_DSN || `http://public@127.0.0.1:${collector.address().port}/10`;
const password = `local-${instance}`;
const authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
const browser = await chromium.launch({ headless: true });
let child;
let exited;
let log;

async function stopServer() {
  if (!child) return;
  const process = child;
  process.kill("SIGTERM");
  const timeout = setTimeout(() => process.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timeout);
  log.end();
  child = null;
}

async function startServer(enabled) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-cat-e2e-"));
  fixtureDirs.push(agentDir);
  const base = `http://127.0.0.1:${port}`;
  log = createWriteStream(join(artifacts, `cat-${mode}-${enabled ? "enabled" : "disabled"}.log`));
  child = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: password,
      SENTRY_DSN: enabled ? dsn : "", SENTRY_ENVIRONMENT: "test", SENTRY_INSTANCE: instance,
      SENTRY_AUTH_TOKEN: "", NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const deadline = Date.now() + 120_000;
  while (true) {
    assert.equal(child.exitCode, null, "Server exited before readiness");
    const response = await fetch(`${base}/api/cat-config`).catch(() => null);
    if (response?.ok) {
      const config = await response.json();
      assert.equal(config.dsn, enabled ? dsn : "");
      assert.equal(config.initialScope.tags.instance, instance);
      assert.equal(response.headers.get("cache-control"), "no-store");
      break;
    }
    assert.ok(Date.now() < deadline, "Server readiness timeout");
    await delay(200);
  }
  // Opening the config endpoint must not open business endpoints or weaken Origin checks.
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/api/cat-config`, { headers: { origin: "https://evil.example" } })).status, 403);
  return base;
}

try {
  for (const enabled of [true, false]) {
    const base = await startServer(enabled);
    const page = await browser.newPage();
    page.on("pageerror", () => {}); // The exception below is deliberately uncaught.
    const transmissions = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().startsWith(`${new URL(dsn).origin}/api/10/envelope/`)) {
        browserEvents.push(...parseEnvelope(req.postDataBuffer()));
        transmissions.push(req);
      }
    });
    const configResponse = page.waitForResponse((res) => res.url() === `${base}/api/cat-config`);
    await page.goto(`${base}/login`);
    await configResponse;
    if (enabled) {
      await page.waitForFunction(() => Object.values(window.__SENTRY__ || {}).some((carrier) => carrier?.defaultCurrentScope?.getClient?.()));
    }
    const before = received.length;
    const browserBefore = browserEvents.length;
    const message = `TSGW CAT ${mode} ${enabled ? "enabled" : "disabled"} browser check ${instance}`;
    await page.evaluate((text) => { setTimeout(() => { throw new Error(text); }, 0); }, message);
    const failed = await page.request.post(`${base}/api/agent/new`, {
      headers: { authorization }, data: { cwd: root, type: "ensure_session", provider: "cat-e2e" },
    });
    assert.equal(failed.status(), 500);
    if (enabled) {
      await waitFor(() => browserEvents.some((event) => event.exception?.values?.some((value) => value.value === message)), "browser error envelope");
      for (const request of transmissions) assert.ok((await request.response())?.ok(), "Browser transport must receive HTTP 2xx");
      if (!live) {
        await waitFor(() => received.some((event) => event.tags?.source === "agent-new"), "server error envelope");
        assert.ok(received.some((event) => event.exception?.values?.some((value) => value.value === message)));
      }
      for (const event of browserEvents) {
        assert.equal(event.tags.instance, instance);
        assert.equal(event.environment, "test");
        assert.match(event.release, /^tsgw-agent@/);
      }
    } else {
      await delay(500);
      assert.equal(browserEvents.length, browserBefore, "Disabled browser must not send envelopes");
      assert.equal(received.length, before, "Disabled server must not send envelopes");
    }
    await page.close();
    await stopServer();
  }
  assert.ok(!itemTypes.some((type) => ["transaction", "span", "profile", "log", "trace_metric", "replay_event", "replay_recording"].includes(type)));
  const evidence = { mode, live, instance, eventIds: browserEvents.map((event) => event.event_id), serverEventIds: received.filter((event) => event.tags?.source === "agent-new").map((event) => event.event_id), itemTypes };
  writeFileSync(join(artifacts, `cat-${mode}-evidence.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  console.log(live
    ? "CAT browser/runtime checks: PASS; verify server receipt through ts_tool → cat"
    : "CAT browser/server runtime configuration and disabled mode: PASS");
} finally {
  await stopServer();
  await browser.close();
  await new Promise((resolve) => collector.close(resolve));
  for (const directory of fixtureDirs) rmSync(directory, { recursive: true, force: true });
}
