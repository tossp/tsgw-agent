import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { proxy, config } = await jiti.import("../../proxy.ts");
const { createWebSessionToken } = await jiti.import("../../lib/web-auth.ts");

test("fork /debug route is protected and login returns to the same standalone page", () => {
  const password = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "debug-test-password";
  try {
    assert.ok(config.matcher.includes("/debug"));
    const request = (headers = {}) => new NextRequest("http://localhost/debug", { headers: { Host: "localhost", ...headers } });
    const response = proxy(request());
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost/login2?next=%2Fdebug");
    const token = createWebSessionToken("debug-test-password");
    assert.equal(proxy(request({ Cookie: `pi_web_session=${token}` })).status, 200);
    delete process.env.PI_WEB_PASSWORD;
    assert.equal(proxy(request()).status, 200);
  } finally {
    if (password === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = password;
  }
});

test("standalone route mounts only fork observer UI, not chat or upstream DebugPanel", async () => {
  const route = await readFile(new URL("../../app/debug/page.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("./DebugPage.tsx", import.meta.url), "utf8");
  const observer = await readFile(new URL("./page-observer.ts", import.meta.url), "utf8");
  assert.match(route, /tsgw\/debug\/DebugPage/);
  assert.doesNotMatch(route + client + observer, /AppShell|ChatWindow|useAgentSession|new EventSource|sendAgentCommand|\/lease|\/api\/agent\/running|searchParams|localStorage/);
  assert.match(client, /selectedRef\.current === id \? null : id/);
});
