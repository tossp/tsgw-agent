import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { readPiAccessAuth, submitPiAccessPassword } from "./pi-access-auth.ts";
import { getPiAccessCopy } from "./pi-access-copy.ts";

const piSignal = () => new AbortController().signal;
const piResponse = (piBody, piStatus = 200, piHeaders = {}) => new Response(JSON.stringify(piBody), {
  status: piStatus, headers: { "Content-Type": "application/json", ...piHeaders },
});

function mockPiFetch(piContext, ...piReplies) {
  const piRequests = [];
  piContext.mock.method(globalThis, "fetch", async (piUrl, piOptions) => {
    piRequests.push({ url: piUrl, options: piOptions });
    const piReply = piReplies.shift();
    if (piReply instanceof Error) throw piReply;
    assert.ok(piReply, "Unexpected extra authentication request");
    return piReply;
  });
  return piRequests;
}

test("Pi login verifies the existing API and session cookie before continuing", async (piContext) => {
  const piRequests = mockPiFetch(piContext, piResponse({ ok: true }), piResponse({ enabled: true, authenticated: true }));
  assert.deepEqual(await submitPiAccessPassword("fixture password", piSignal()), { ok: true });
  assert.deepEqual(piRequests.map((piItem) => piItem.url), ["/api/web-auth", "/api/web-auth"]);
  assert.equal(piRequests[0].options.method, "POST");
  assert.equal(piRequests[0].options.body, JSON.stringify({ password: "fixture password" }));
  assert.equal(piRequests[0].options.credentials, "same-origin");
  assert.equal(piRequests[0].options.redirect, "error");
});

test("Pi login never treats missing session cookies as authentication", async (piContext) => {
  mockPiFetch(piContext, piResponse({ ok: true }), piResponse({ enabled: true, authenticated: false }));
  assert.deepEqual(await submitPiAccessPassword("fixture", piSignal()), { ok: false, failure: { kind: "failed" } });
});

test("Pi password failure and rate limiting retain their distinct API meanings", async (piContext) => {
  const piRequests = mockPiFetch(piContext, piResponse({}, 401), piResponse({}, 429, { "Retry-After": "3" }), piResponse({}, 429, { "Retry-After": "no" }));
  assert.deepEqual(await submitPiAccessPassword("wrong", piSignal()), { ok: false, failure: { kind: "invalid" } });
  assert.deepEqual(await submitPiAccessPassword("wrong", piSignal()), { ok: false, failure: { kind: "throttled", seconds: 3 } });
  assert.deepEqual(await submitPiAccessPassword("wrong", piSignal()), { ok: false, failure: { kind: "throttled", seconds: 1 } });
  assert.equal(piRequests.length, 3);
});

test("Pi login rejects unexpected responses rather than advancing the animation", async (piContext) => {
  mockPiFetch(piContext, piResponse({}, 500), piResponse({ ok: false }), piResponse({ enabled: true }));
  assert.equal((await submitPiAccessPassword("fixture", piSignal())).ok, false);
  assert.equal((await submitPiAccessPassword("fixture", piSignal())).ok, false);
  await assert.rejects(readPiAccessAuth(piSignal()), /Unexpected/);
});

test("Pi auth state supports an existing session and disabled passwords", async (piContext) => {
  mockPiFetch(piContext, piResponse({ enabled: true, authenticated: true }), piResponse({ enabled: false, authenticated: true }), piResponse({ enabled: true, authenticated: false }));
  assert.equal(await readPiAccessAuth(piSignal()), true);
  assert.equal(await readPiAccessAuth(piSignal()), true);
  assert.equal(await readPiAccessAuth(piSignal()), false);
});

test("Pi login reads display-only source IP without an extra request or changing auth", async (piContext) => {
  const piRequests = mockPiFetch(piContext, piResponse({ enabled: true, authenticated: false }, 200, { "X-Pi-Source-IP": "203.0.113.42" }));
  let piIp = "";
  assert.equal(await readPiAccessAuth(piSignal(), (piValue) => { piIp = piValue; }), false);
  assert.equal(piIp, "203.0.113.42");
  assert.equal(piRequests.length, 1);
});

test("Pi login still works when display-only IP metadata is unavailable", async (piContext) => {
  mockPiFetch(piContext, piResponse({ enabled: true, authenticated: false }));
  let piIp = "previous value";
  assert.equal(await readPiAccessAuth(piSignal(), (piValue) => { piIp = piValue; }), false);
  assert.equal(piIp, "");
});

test("Pi visual copy covers every phase in each supported locale", () => {
  for (const piLocale of ["en", "zh-CN", "zh-TW"]) {
    for (const piPhase of ["checking", "intro", "wash", "permission", "password", "request", "read", "verified", "welcome", "handoff"]) {
      const piCopy = getPiAccessCopy(piLocale, piPhase);
      for (const piValue of Object.values(piCopy)) assert.ok(typeof piValue === "string" && piValue.length > 0);
    }
  }
});

test("Pi identity card keeps the original three fields and uses the existing password credential", () => {
  const piCopy = getPiAccessCopy("zh-CN", "password");
  assert.equal(piCopy.identityToken, "身份令牌");
  assert.equal(piCopy.identityNumber, "身份编号");
  assert.equal(piCopy.accessLevel, "权限等级");
  const piPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(piPage, /const PI_ACCESS_IDENTITY_ID = "9527"/);
  assert.doesNotMatch(piPage, /getRandomValues|Math\.random/);
  assert.match(piPage, /type="password"/);
  assert.match(piPage, /data-pi-identity-row><span>\{piCopy.accessLevel\}<\/span><b>3<\/b>/);
});

test("Pi login links to the project fork without granting the new tab an opener", () => {
  const piScene = readFileSync(new URL("./PiAccessScene.tsx", import.meta.url), "utf8");
  assert.match(piScene, /href="https:\/\/github\.com\/tossp\/tsgw-agent"/);
  assert.match(piScene, /target="_blank"/);
  assert.match(piScene, /rel="noopener noreferrer"/);
});

test("Pi login is a React route without legacy runtime or embedded scripts", () => {
  const piDirectory = new URL("./", import.meta.url);
  for (const piFile of readdirSync(piDirectory).filter((piName) => /\.(tsx?|css)$/.test(piName))) {
    const piSource = readFileSync(new URL(piFile, piDirectory), "utf8");
    assert.doesNotMatch(piSource, /\b(?:dsh|dsu)[-_A-Za-z0-9]*\b|<iframe|innerHTML|createElement\(/i, piFile);
  }
  assert.deepEqual(readdirSync(new URL("../../public/login2/", piDirectory)), ["assets"]);
});
