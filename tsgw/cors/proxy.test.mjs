import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";
import { withCors } from "./index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root }, moduleCache: false });
const { proxy } = await jiti.import("../../proxy.ts");
const { POST: login } = await jiti.import("../../app/api/web-auth/route.ts");
const { createWebSessionToken } = await jiti.import("../../lib/web-auth.ts");
const { recordAuthSuccess, getAuthRetryAfterMs } = await import("../../lib/auth-throttle.ts");
const keys = ["TSGW_ALLOWED_ORIGINS", "PI_WEB_ALLOWED_HOSTS", "PI_WEB_HOSTNAME", "PI_WEB_PASSWORD"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const origin = "http://panel.example:8080";
const password = "cors-test-password";
const basic = value => `Basic ${Buffer.from(`pi:${value}`).toString("base64")}`;

beforeEach(() => {
  process.env.TSGW_ALLOWED_ORIGINS = "https://panel.example:443";
  process.env.PI_WEB_PASSWORD = password;
  delete process.env.PI_WEB_ALLOWED_HOSTS;
  delete process.env.PI_WEB_HOSTNAME;
  recordAuthSuccess();
});
after(() => {
  recordAuthSuccess();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(path = "/api/home", { headers, ...options } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    ...options,
    headers: { Host: "localhost", Origin: origin, "Sec-Fetch-Site": "cross-site", ...headers },
  });
}

function assertCors(response) {
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.match(response.headers.get("vary"), /(?:^|,\s*)Origin(?:,|$)/i);
}

test("trusted preflight needs no password but the following request still requires authentication", async () => {
  const response = proxy(request("/api/home", {
    method: "OPTIONS",
    headers: { "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" },
  }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assertCors(response);
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.ok(response.headers.get("access-control-allow-methods").split(/,\s*/).includes(method));
  }
  assert.match(response.headers.get("access-control-allow-headers"), /Authorization/i);
  assert.equal(getAuthRetryAfterMs(), 0);
  const actual = proxy(request());
  assert.equal(actual.status, 401);
  assertCors(actual);
  assert.match(actual.headers.get("www-authenticate"), /Basic/);
});

test("Basic authentication succeeds without relaxing the existing password check", () => {
  const denied = proxy(request("/api/home", { headers: { Authorization: basic("wrong") } }));
  assert.equal(denied.status, 401);
  assertCors(denied);
  recordAuthSuccess();
  const allowed = proxy(request("/api/home", { headers: { Authorization: basic(password) } }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("x-middleware-next"), "1");
  assertCors(allowed);
});

test("signed sessions still work and keep CORS credential support", () => {
  const token = createWebSessionToken(password);
  const response = proxy(request("/api/home", { headers: { Cookie: `pi_web_session=${token}` } }));
  assert.equal(response.status, 200);
  assertCors(response);
});

test("unlisted origins receive neither access nor permissive response headers", () => {
  for (const other of ["https://attacker.example", "https://sub.panel.example", "null"]) {
    const response = proxy(request("/api/home", { headers: { Origin: other, Authorization: basic(password) } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("vary"), /Origin/i);
  }
});

test("a trusted source cannot bypass the target Host check, including during preflight", () => {
  for (const method of ["GET", "OPTIONS"]) {
    const response = proxy(request("/api/home", {
      method,
      headers: { Host: "unconfigured.example", Authorization: basic(password), "Access-Control-Request-Method": "GET" },
    }));
    assert.equal(response.status, 403);
  }
});

test("authentication throttling is visible through CORS and unaffected by preflight", () => {
  proxy(request("/api/home", { headers: { Authorization: basic("wrong") } }));
  const blocked = proxy(request("/api/home", { headers: { Authorization: basic(password) } }));
  assert.equal(blocked.status, 429);
  assertCors(blocked);
  assert.ok(blocked.headers.has("retry-after"));
  assert.match(blocked.headers.get("access-control-expose-headers"), /Retry-After/);
  assert.equal(proxy(request("/api/home", {
    method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" },
  })).status, 204);
  assert.equal(proxy(request("/api/home", { headers: { Authorization: basic(password) } })).status, 429);
});

test("ordinary OPTIONS requests do not gain the preflight authentication exemption", () => {
  assert.equal(proxy(request("/api/home", { method: "OPTIONS" })).status, 401);
});

test("unset configuration preserves the original same-origin policy and response headers", () => {
  delete process.env.TSGW_ALLOWED_ORIGINS;
  const denied = proxy(request("/api/home", { headers: { Authorization: basic(password) } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  assert.equal(denied.headers.get("vary"), null);
  const sameOrigin = proxy(request("/api/home", {
    headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", Authorization: basic(password) },
  }));
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get("access-control-allow-origin"), null);
});

test("password-disabled mode and page redirects keep their original behavior", () => {
  const page = proxy(request("/"));
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  delete process.env.PI_WEB_PASSWORD;
  assert.equal(proxy(request()).status, 200);
  assert.equal(proxy(request("/api/home", { headers: { Origin: "https://attacker.example" } })).status, 403);
});

test("CORS preserves existing Vary values and never emits a wildcard allow-origin", () => {
  const response = withCors(request(), () => new Response("ok", { headers: { Vary: "Accept-Encoding" } }), () => true);
  assert.equal(response.headers.get("vary"), "Accept-Encoding, Origin");
  assertCors(response);
});

test("a route's secondary guard accepts the same trusted source without weakening JSON validation", async () => {
  const wrongType = await login(request("/api/web-auth", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ password }),
  }));
  assert.equal(wrongType.status, 415);
  const response = await login(request("/api/web-auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /pi_web_session=.*HttpOnly.*SameSite=lax/i);
});
