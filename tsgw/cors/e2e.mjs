import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = process.env.CORS_E2E_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const production = process.env.CORS_E2E_MODE === "production";
const require = createRequire(import.meta.url);
const resultsDir = join(root, "test-results/cors");
await mkdir(resultsDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "tsgw-cors-"));
const password = randomUUID();
const authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
const frontend = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>CORS test</title><p>Static dashboard fixture</p>");
});
frontend.listen(0, "127.0.0.1");
await once(frontend, "listening");
const frontendPort = frontend.address().port;
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let serverLog = "";
let ready;
const started = new Promise(resolve => { ready = resolve; });
const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), production ? "start" : "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: production ? "production" : "development",
    NEXT_TELEMETRY_DISABLED: "1",
    PI_CODING_AGENT_DIR: temporary,
    PI_WEB_PASSWORD: password,
    PI_WEB_ALLOWED_HOSTS: "legacy.example",
    TSGW_ALLOWED_ORIGINS: "https://127.0.0.1:1,dashboard.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", chunk => {
    const text = chunk.toString();
    serverLog += text;
    if (/Ready in/.test(text)) ready();
  });
}
let browser;
const results = [];
try {
  let timeout;
  try {
    await Promise.race([
      started,
      once(server, "exit").then(([code]) => { throw new Error(`Next exited before ready: ${code}\n${serverLog}`); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Next startup timed out\n${serverLog}`)), 120_000); }),
    ]);
  } finally { clearTimeout(timeout); }

  const derivedHost = await requestWithHost("/api/web-auth", "dashboard.example");
  assert.equal(derivedHost.status, 200, "startup Host merge reaches both proxy and the route's secondary guard");
  assert.equal(JSON.parse(derivedHost.body).authenticated, true);
  results.push("startup-host-merge-and-secondary-route-guard");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const network = [];
  const methods = new Map();
  const cachedRequests = new Set();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => methods.set(requestId, request.method));
  cdp.on("Network.requestServedFromCache", ({ requestId }) => cachedRequests.add(requestId));
  cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
    if (response.url.startsWith(base)) network.push({ url: response.url, method: methods.get(requestId), status: response.status, type, cached: response.fromDiskCache || cachedRequests.has(requestId) });
  });
  const read = (headers, cache = "force-cache") => page.evaluate(async ({ base, headers, cache }) => {
    try {
      const response = await fetch(`${base}/api/home`, { headers, credentials: "omit", cache });
      return { status: response.status, body: await response.text(), challenge: response.headers.get("www-authenticate") };
    } catch (error) { return { error: error.name }; }
  }, { base, headers, cache });

  await page.goto(`http://127.0.0.1:${frontendPort}`);
  const authenticated = await read({ Authorization: authorization });
  assert.equal(authenticated.status, 200, JSON.stringify(authenticated));
  assert.ok(network.some(item => item.method === "OPTIONS" && item.status === 204), "real browser preflight succeeds");
  results.push("browser-basic-auth-preflight-and-scheme-port-independence");

  assert.equal((await read({ Authorization: authorization })).status, 200);
  assert.ok(network.some(item => item.cached && item.status === 200), "the authenticated response is actually cached before testing origin isolation");
  results.push("authenticated-response-really-enters-browser-cache");

  const missingPassword = await read({}, "no-store");
  assert.equal(missingPassword.status, 401, JSON.stringify(missingPassword));
  assert.match(missingPassword.challenge, /Basic/);
  results.push("browser-actual-request-still-requires-password");

  const cookieAuthenticated = await page.evaluate(async ({ base, password }) => {
    const login = await fetch(`${base}/api/web-auth`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const response = await fetch(`${base}/api/home`, { credentials: "include", cache: "no-store" });
    return { login: login.status, authenticated: response.status };
  }, { base, password });
  assert.deepEqual(cookieAuthenticated, { login: 200, authenticated: 200 });
  results.push("browser-json-login-and-same-host-cross-port-cookie-auth");
  await context.clearCookies();

  const headers = await fetch(`${base}/api/home`, {
    headers: { Authorization: authorization, Origin: `http://127.0.0.1:${frontendPort}` },
  });
  assert.equal(headers.headers.get("access-control-allow-origin"), `http://127.0.0.1:${frontendPort}`);
  assert.match(headers.headers.get("vary"), /Origin/i);
  results.push("real-route-response-keeps-proxy-cors-headers");

  await page.goto(`http://localhost:${frontendPort}`);
  const unlisted = await read({ Authorization: authorization });
  assert.equal(unlisted.error, "TypeError", JSON.stringify(unlisted));
  const cached = await read({});
  assert.equal(cached.error, "TypeError", "an unlisted origin cannot read a response using force-cache");
  results.push("unlisted-browser-origin-cannot-read-api-or-force-cache");

  const unrelatedHost = await requestWithHost("/api/home", "unconfigured.example");
  assert.equal(unrelatedHost.status, 403);
  results.push("target-host-check-remains-effective");

  await writeFile(join(resultsDir, "results.json"), JSON.stringify({ results, network }, null, 2));
  console.log(`PASS: ${results.length} real browser/HTTP checks`);
  console.log(results.join("\n"));
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const kill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    kill.unref();
    await exited;
    clearTimeout(kill);
  }
  await new Promise(resolve => frontend.close(resolve));
  await writeFile(join(resultsDir, production ? "production.log" : "dev.log"), serverLog);
  console.log(`Evidence: ${dirname(join(resultsDir, "results.json"))}`);
}

async function requestWithHost(path, host) {
  // Node's fetch drops a caller-supplied Host; use HTTP directly to test the
  // actual security boundary instead of silently sending the URL's hostname.
  const request = httpRequest(`${base}${path}`, {
    headers: { Host: host, Origin: `http://127.0.0.1:${frontendPort}`, Authorization: authorization },
  });
  const response = new Promise((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  request.end();
  const incoming = await response;
  let body = "";
  for await (const chunk of incoming) body += chunk;
  return { status: incoming.statusCode, body };
}
