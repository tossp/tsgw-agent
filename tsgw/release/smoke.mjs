import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createTerminalOutput } from "./terminal-output.mjs";
import { startPiAccess } from "../login2/login2-start.mjs";
import { createSmokeEnvironment } from "./smoke-environment.mjs";
import { startCatCapture } from "./smoke-cat.mjs";

const artifacts = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node tsgw/release/smoke.mjs <artifact-directory>");
const tarballs = readdirSync(artifacts).filter((file) => file.endsWith(".tgz"));
assert.equal(tarballs.length, 1, "Expected exactly one package");
const tarball = resolve(artifacts, tarballs[0]);
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
assert.equal(readFileSync(join(artifacts, "SHA256SUMS"), "utf8"), `${digest}  ${tarballs[0]}\n`);
const metadata = JSON.parse(readFileSync(join(artifacts, "release.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "tsgw-agent-smoke-"));
console.log(`Clean install fixture: ${fixture}`);
const prefix = join(fixture, "prefix");
const env = createSmokeEnvironment(fixture);
const agent = env.PI_CODING_AGENT_DIR;
const password = randomBytes(24).toString("hex");
const workspace = join(fixture, "workspace");
const reports = mkdtempSync(join(tmpdir(), "tsgw-agent-smoke-reports-"));
mkdirSync(reports, { recursive: true });
mkdirSync(join(agent, "sessions", "smoke"), { recursive: true });
mkdirSync(workspace);
// Only exact native/install hooks are approved for npm 12; never inherit the
// operator's policy or disable script protection globally.
const npmVersion = execFileSync("npm", ["--version"], { env, encoding: "utf8" }).trim();
if (Number(npmVersion.split(".")[0]) >= 12) {
  const source = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  writeFileSync(env.npm_config_userconfig,
    `allow-scripts[]=tsgw-agent@${metadata.version}\nallow-scripts[]=node-pty@${source.dependencies["node-pty"]}\n`);
}
const sessionId = randomUUID();
const timestamp = new Date().toISOString();
writeFileSync(join(agent, "sessions", "smoke", `${sessionId}.jsonl`), `${JSON.stringify({
  type: "session", version: 3, id: sessionId, cwd: workspace, timestamp,
})}\n`);
const cat = await startCatCapture(fixture);
const serverEnv = { ...env, ...cat.env, PI_WEB_PASSWORD: password,
  PI_WEB_HOSTNAME: "127.0.0.1", PI_WEB_ALLOWED_HOSTS: "", PI_WEB_SKIP_VERSION_CHECK: "1" };
let server;
let browser;
let context;
let serverExit;
let port;
let log = "";
const secrets = [password, Buffer.from(`pi:${password}`).toString("base64")];
const failures = [];
const redact = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, "[test credential]"), text);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
async function assertStopped(pid) {
  const deadline = Date.now() + 5000;
  while (alive(pid) && Date.now() < deadline) await delay(50);
  assert.equal(alive(pid), false, `Acceptance PID ${pid} survived cleanup`);
}
try {
  // This is a real global-style installation, but only under our disposable
  // prefix. Do not alter the operator's global command or reuse source deps.
  execFileSync("npm", ["install", "--global", "--prefix", prefix, tarball,
    "--registry", "https://registry.npmjs.org/", "--no-audit", "--no-fund"], {
    env, stdio: "inherit", timeout: 180000,
  });
  const installed = join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "tsgw-agent");
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.name, "tsgw-agent");
  assert.equal(pkg.version, metadata.version);
  const cli = join(prefix, process.platform === "win32" ? "tsgw-agent.cmd" : "bin/tsgw-agent");
  assert.equal(execFileSync(cli, ["--version"], { env, encoding: "utf8" }).trim(), metadata.version);
  assert.match(execFileSync(cli, ["--help"], { env, encoding: "utf8" }), /Usage: tsgw-agent/);
  console.log("✓ Clean prefix install, CLI version and command name");

  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  port = probe.address().port;
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(installed, pkg.bin["tsgw-agent"]), "--no-open", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace, env: serverEnv, stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  serverExit = once(server, "exit");
  const deadline = Date.now() + 60000;
  while (true) {
    assert.equal(server.exitCode, null, `Installed server exited; see ${join(reports, "server.log")}`);
    const response = await fetch(`${base}/api/web-auth`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Installed server readiness timed out");
    await delay(200);
  }
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  const redirect = await fetch(base, { redirect: "manual" });
  assert.equal(redirect.status, 307);
  assert.equal(new URL(redirect.headers.get("location"), base).pathname, "/login2");
  assert.equal((await fetch(`${base}/login`)).status, 200, "Classic login must remain available");
  for (const name of ["emblem.webp", "pi-connected.mp3", "pi-permission.mp3", "pi-password.mp3", "pi-read.mp3", "pi-verified.mp3", "pi-welcome.mp3"]) {
    const response = await fetch(`${base}/login2/assets/${name}`);
    assert.equal(response.status, 200, name);
    assert.ok((await response.arrayBuffer()).byteLength > 0, name);
  }
  console.log("✓ Installed production server, original auth boundary and generated assets");

  browser = await chromium.launch({ headless: true, env });
  context = await browser.newContext({ locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
  await cat.routeBrowser(context);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?tsgw-release-smoke=1`);
  assert.equal(new URL(page.url()).pathname, "/login2");
  assert.equal(new URL(page.url()).searchParams.get("next"), "/?tsgw-release-smoke=1");
  await startPiAccess(page, { piChinese: true });
  await page.locator("#pi-access-password").fill(password);
  await page.locator("#pi-access-password").press("Enter");
  await page.waitForURL(`${base}/?tsgw-release-smoke=1`, { timeout: 60000 });
  const cookies = await context.cookies();
  secrets.push(...cookies.map((cookie) => cookie.value));
  assert.ok(cookies.some((cookie) => cookie.name === "pi_web_session" && cookie.httpOnly));
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
  let terminalPid;
  try {
    const response = await fetch(`${base}/api/terminal/${id}/events`, {
      headers: { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const input = await context.request.post(`${base}/api/terminal/${id}`, {
      data: { type: "input", data: "printf '%s%s\\n' 'TSGW_' 'SMOKE_OK'; printf 'TSGW_PTY_PID=%s\\n' \"$$\"\r" },
    });
    assert.equal(input.status(), 200);
    const decoder = new TextDecoder();
    const readOutput = createTerminalOutput();
    let output = "";
    while (!output.includes("TSGW_SMOKE_OK") || !/TSGW_PTY_PID=(\d+)/.test(output)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Terminal ended without command output");
      output = readOutput(decoder.decode(chunk.value, { stream: true }));
    }
    terminalPid = Number(output.match(/TSGW_PTY_PID=(\d+)/)[1]);
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    controller.abort();
    assert.equal((await context.request.delete(`${base}/api/terminal/${id}`)).status(), 200);
    assert.equal((await context.request.get(`${base}/api/terminal/${id}`)).status(), 404);
    if (terminalPid) await assertStopped(terminalPid);
  }
  assert.deepEqual(errors, []);
  console.log("✓ Installed native terminal, authenticated API and SSE command output");
} catch (error) {
  failures.push(error);
} finally {
  try {
    if (context) secrets.push(...(await context.cookies()).map((cookie) => cookie.value));
  } catch (error) { failures.push(error); }
  try { await browser?.close(); }
  catch (error) { failures.push(error); }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    if (!(await Promise.race([serverExit.then(() => true), delay(10000).then(() => false)]))) {
      if (process.platform === "win32") server.kill("SIGKILL");
      else process.kill(-server.pid, "SIGKILL");
      await serverExit;
    }
  }
  writeFileSync(join(reports, "server.log"), redact(log), { mode: 0o600 });
  try {
    cat.assertClean();
    for (const pid of cat.pids()) {
      await assertStopped(pid);
    }
    if (port) {
      const probe = createServer();
      probe.listen(port, "127.0.0.1");
      await once(probe, "listening");
      await new Promise((done) => probe.close(done));
    }
    writeFileSync(join(reports, "cat.json"), JSON.stringify(cat.summary(), null, 2));
  } catch (error) {
    failures.push(error);
  } finally {
    await cat.close();
    if (failures.length === 0) rmSync(fixture, { recursive: true, force: true });
    else console.error(`Smoke failed; preserved ${fixture} and ${reports} for inspection`);
    console.log(`Smoke reports: ${reports}`);
  }
}
if (failures.length) throw new Error(redact(failures.map((error) => error.stack || String(error)).join("\n")));
