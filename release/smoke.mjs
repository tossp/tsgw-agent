import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createTerminalOutput } from "./terminal-output.mjs";

const artifacts = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node release/smoke.mjs <artifact-directory>");
const tarballs = readdirSync(artifacts).filter((file) => file.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "Expected exactly one package");
const tarball = resolve(artifacts, tarballs[0]);
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
assert.equal(readFileSync(join(artifacts, "SHA256SUMS"), "utf8"), `${digest}  ${tarballs[0]}\n`);
const metadata = JSON.parse(readFileSync(join(artifacts, "release.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "tsgw-agent-smoke-"));
console.log(`Clean install fixture: ${fixture}`);
const prefix = join(fixture, "prefix");
const agent = join(fixture, "agent");
const workspace = join(fixture, "workspace");
const reports = resolve("test-results/tsgw-release");
mkdirSync(reports, { recursive: true });
mkdirSync(join(agent, "sessions", "smoke"), { recursive: true });
mkdirSync(workspace);
writeFileSync(join(fixture, "npmrc"), "");
const sessionId = randomUUID();
const timestamp = new Date().toISOString();
writeFileSync(join(agent, "sessions", "smoke", `${sessionId}.jsonl`), `${JSON.stringify({
  type: "session", version: 3, id: sessionId, cwd: workspace, timestamp,
})}\n`);
const env = {
  ...process.env, npm_config_userconfig: join(fixture, "npmrc"),
  PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: randomBytes(24).toString("hex"),
  PI_WEB_HOSTNAME: "127.0.0.1", PI_WEB_ALLOWED_HOSTS: "",
  PI_WEB_SKIP_VERSION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1",
  HISTFILE: process.platform === "win32" ? "NUL" : "/dev/null",
  SHELL: process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
};
let server;
let browser;
let serverExit;
let log;
let success = false;
try {
  // This is a real global-style installation, but only under our disposable
  // prefix. Do not alter the operator's global command or reuse source deps.
  execFileSync("npm", ["install", "--global", "--prefix", prefix, tarball,
    "--registry", "https://registry.npmjs.org/", "--no-audit", "--no-fund"], {
    env, stdio: "inherit", timeout: 180000,
  });
  const installed = join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "@tossp/tsgw-agent");
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.name, "@tossp/tsgw-agent");
  assert.equal(pkg.version, metadata.version);
  const cli = join(prefix, process.platform === "win32" ? "tsgw-agent.cmd" : "bin/tsgw-agent");
  assert.equal(execFileSync(cli, ["--version"], { env, encoding: "utf8" }).trim(), metadata.version);
  assert.match(execFileSync(cli, ["--help"], { env, encoding: "utf8" }), /Usage: tsgw-agent/);
  console.log("✓ Clean prefix install, CLI version and command name");

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  const base = `http://127.0.0.1:${port}`;
  log = createWriteStream(join(reports, "server.log"));
  server = spawn(process.execPath, [join(installed, pkg.bin["tsgw-agent"]), "--no-open", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  serverExit = once(server, "exit");
  const deadline = Date.now() + 60000;
  while (true) {
    assert.equal(server.exitCode, null, "Installed server exited; see test-results/tsgw-release/server.log");
    const response = await fetch(`${base}/api/web-auth`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Installed server readiness timed out");
    await delay(200);
  }
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  const redirect = await fetch(base, { redirect: "manual" });
  assert.equal(new URL(redirect.headers.get("location"), base).pathname, "/login");
  for (const name of ["emblem.webp", "pi-permission.mp3", "pi-password.mp3", "pi-read.mp3", "pi-verified.mp3", "pi-welcome.mp3"]) {
    const response = await fetch(`${base}/login2/assets/${name}`);
    assert.equal(response.status, 200, name);
    assert.ok((await response.arrayBuffer()).byteLength > 0, name);
  }
  console.log("✓ Installed production server, original auth boundary and generated assets");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/login2?next=${encodeURIComponent("/?tsgw-release-smoke=1")}`);
  await page.locator("#pi-access-password").fill(env.PI_WEB_PASSWORD);
  await page.locator("#pi-access-password").press("Enter");
  await page.waitForURL(`${base}/?tsgw-release-smoke=1`, { timeout: 60000 });
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "pi_web_session" && cookie.httpOnly));
  assert.deepEqual(await (await context.request.get(`${base}/api/web-auth`)).json(), { enabled: true, authenticated: true });
  const update = await (await context.request.get(`${base}/api/app-update`)).json();
  assert.equal(update.currentVersion, metadata.version, "Web build must embed this artifact's version");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(reports, "installed.png") });
  console.log("✓ Installed login2, real password/cookie, production chunks and safe handoff");

  const created = await context.request.post(`${base}/api/terminal`, { data: { cwd: workspace } });
  assert.equal(created.status(), 200, await created.text());
  const { id } = await created.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let reader;
  try {
    const response = await fetch(`${base}/api/terminal/${id}/events`, {
      headers: { Authorization: `Basic ${Buffer.from(`pi:${env.PI_WEB_PASSWORD}`).toString("base64")}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const input = await context.request.post(`${base}/api/terminal/${id}`, {
      data: { type: "input", data: "printf '%s%s\\n' 'TSGW_' 'SMOKE_OK'\r" },
    });
    assert.equal(input.status(), 200);
    const decoder = new TextDecoder();
    const readOutput = createTerminalOutput();
    let output = "";
    while (!output.includes("TSGW_SMOKE_OK")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Terminal ended without command output");
      output = readOutput(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    controller.abort();
    await context.request.delete(`${base}/api/terminal/${id}`);
  }
  console.log("✓ Installed native terminal, authenticated API and SSE command output");
  success = true;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    if (!(await Promise.race([serverExit.then(() => true), delay(10000).then(() => false)]))) {
      server.kill("SIGKILL");
      await serverExit;
    }
  }
  if (log) await new Promise((done) => log.end(done));
  if (success) rmSync(fixture, { recursive: true, force: true });
  else console.error(`Smoke failed; preserved ${fixture} and ${reports} for inspection`);
}
