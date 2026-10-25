import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as piDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runPiAccessAudioChecks } from "./login2-audio.mjs";
import { checkPiIdentityCard, checkPiPasswordControls, checkPiReferenceRead, checkPiReferenceScan, runPiTranslatedLayoutChecks } from "./login2-layout.mjs";

const piRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const piArtifacts = join(piRoot, "test-results/login2");
const piAgentDir = mkdtempSync(join(tmpdir(), "pi-login2-e2e-"));
const piBase = "http://127.0.0.1:30141";
const piPassword = "pi login2 fixture";
assert.ok(!existsSync(join(piRoot, ".next/dev/lock")), "Reuse/stop the existing dev server; never start a second Next process");
const piProbe = createServer();
piProbe.listen(30141, "127.0.0.1");
await once(piProbe, "listening");
await new Promise((piResolve, piReject) => piProbe.close((piError) => piError ? piReject(piError) : piResolve()));
mkdirSync(piArtifacts, { recursive: true });
const piLog = createWriteStream(join(piArtifacts, "server.log"));
const piServer = spawn(process.execPath, [join(piRoot, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", "30141"], {
  cwd: piRoot,
  env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir, PI_WEB_PASSWORD: piPassword, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
piServer.stdout.pipe(piLog, { end: false });
piServer.stderr.pipe(piLog, { end: false });
const piExit = once(piServer, "exit");
let piBrowser;
let piPage;
const piErrors = [];
const piRecord = (piLabel) => console.log(`✓ ${piLabel}`);

async function piCheckProjectLink(piView) {
  const piLink = piView.getByRole("link", { name: "GitHub · tossp/tsgw-agent" });
  assert.equal(await piLink.getAttribute("href"), "https://github.com/tossp/tsgw-agent");
  assert.equal(await piLink.getAttribute("target"), "_blank");
  assert.equal(await piLink.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await piLink.isVisible(), true);
  const piAccessible = await piLink.evaluate((piElement) => {
    const piBounds = piElement.getBoundingClientRect();
    const piHit = document.elementFromPoint(piBounds.x + piBounds.width / 2, piBounds.y + piBounds.height / 2);
    return piBounds.x >= 0 && piBounds.right <= innerWidth && piBounds.y >= 0 && piBounds.bottom <= innerHeight
      && (piHit === piElement || piElement.contains(piHit));
  });
  assert.equal(piAccessible, true, "Project link must remain on-screen and unobstructed");
}

async function piOpen(piOptions = {}) {
  const piContext = await piBrowser.newContext({ locale: "zh-CN", ...piOptions });
  const piNewPage = await piContext.newPage();
  piNewPage.setDefaultTimeout(30000);
  piNewPage.on("pageerror", (piError) => piErrors.push(String(piError)));
  return { piContext, piNewPage };
}

try {
  const piDeadline = Date.now() + 120000;
  while (true) {
    assert.equal(piServer.exitCode, null, "Dev server exited; see server.log");
    const piResponse = await fetch(`${piBase}/api/web-auth`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (piResponse?.ok) break;
    assert.ok(Date.now() < piDeadline, "Dev readiness timed out");
    await piDelay(300);
  }
  const piIpStatus = await fetch(`${piBase}/api/web-auth`);
  assert.equal(piIpStatus.headers.get("X-Pi-Source-IP"), "127.0.0.1", "No forwarded header must use the real connection address");
  assert.deepEqual(await piIpStatus.json(), { enabled: true, authenticated: false });
  for (const piHeaders of [
    { "X-Real-IP": "203.0.113.42", "X-Forwarded-For": "203.0.113.43, 10.0.0.1" },
    { "X-Forwarded-For": "203.0.113.42, 10.0.0.1" },
  ]) {
    const piForwardedStatus = await fetch(`${piBase}/api/web-auth`, { headers: piHeaders });
    assert.equal(piForwardedStatus.headers.get("X-Pi-Source-IP"), "203.0.113.42");
    assert.deepEqual(await piForwardedStatus.json(), { enabled: true, authenticated: false });
  }
  piRecord("Display-only IP: HTTP headers first, real socket fallback, authentication response unchanged");
  assert.equal((await fetch(`${piBase}/api/sessions`)).status, 401);
  const piRootResponse = await fetch(piBase, { redirect: "manual" });
  assert.equal(new URL(piRootResponse.headers.get("location"), piBase).pathname, "/login2");
  piRecord("Default unauthenticated redirect uses login2; API protection unchanged");

  piBrowser = await chromium.launch({ headless: true });
  await runPiAccessAudioChecks(piBrowser, piBase);
  const { piContext, piNewPage } = await piOpen({ viewport: { width: 1440, height: 1000 } });
  piPage = piNewPage;
  await piPage.goto(`${piBase}/login`);
  await piPage.locator("#web-login-password").waitFor();
  await piPage.goto(`${piBase}/?pi-login2-e2e=desktop`);
  assert.equal(new URL(piPage.url()).pathname, "/login2");
  assert.equal(new URL(piPage.url()).searchParams.get("next"), "/?pi-login2-e2e=desktop");
  await piPage.locator('[data-pi-phase="intro"]').waitFor();
  await piCheckProjectLink(piPage);
  await piPage.screenshot({ path: join(piArtifacts, "intro.png") });
  await piPage.locator("#pi-access-password").waitFor();
  const piIdentityId = await checkPiIdentityCard(piPage);
  assert.equal(await piPage.locator("iframe").count(), 0);
  await piCheckProjectLink(piPage);
  await piPage.screenshot({ path: join(piArtifacts, "password-desktop.png") });
  await piDelay(1000);
  assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1);
  assert.ok((await piPage.locator('a[href^="/login?"]').getAttribute("href")).includes("pi-login2-e2e"));
  piRecord("React opening/wash/password sequence; password phase never advances itself");
  await piPage.locator("#pi-access-password").click();
  await piPage.waitForFunction(() => !document.querySelector("audio").paused);
  piRecord("Real generated audio starts after a normal password-field click");

  await piPage.locator("#pi-access-password").fill("wrong");
  await piPage.locator("#pi-access-password").press("Enter");
  await piPage.locator('[role="alert"]').filter({ hasText: /密码/ }).waitFor();
  assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1);
  await piPage.locator('form button[type="submit"]').click();
  await piPage.locator('[role="alert"]').filter({ hasText: /频繁|等待|秒后/ }).waitFor();
  await piDelay(1100);
  await piPage.locator("#pi-access-password").fill("pi");
  await piPage.locator("#pi-access-password").press("Space");
  await piPage.locator("#pi-access-password").pressSequentially("login2 fixture");
  assert.equal(await piPage.locator("#pi-access-password").inputValue(), piPassword);
  assert.equal(await piPage.locator("[data-pi-identity-number]").textContent(), piIdentityId);
  piRecord("Three-row identity card, fixed number 9527, level 3 and live clock; wrong password/429 unchanged");

  let piPosts = 0;
  let piGets = 0;
  await piPage.route("**/api/web-auth", async (piRoute) => {
    if (piRoute.request().method() === "GET") piGets++;
    if (piRoute.request().method() === "POST") {
      piPosts++;
      assert.deepEqual(Object.keys(piRoute.request().postDataJSON()), ["password"]);
      await piDelay(500);
    }
    await piRoute.continue();
  });
  await piPage.locator("form").evaluate((piForm) => {
    piForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    piForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await piPage.locator('form[aria-busy="true"]').waitFor();
  assert.equal(await piPage.locator("#pi-access-password").isDisabled(), true);
  await piPage.locator('[data-pi-phase="request"]').waitFor();
  assert.equal(piPosts, 1);
  const piCookie = (await piContext.cookies()).find((piItem) => piItem.name === "pi_web_session");
  assert.ok(piCookie?.httpOnly);
  assert.deepEqual(await (await piContext.request.get(`${piBase}/api/web-auth`)).json(), { enabled: true, authenticated: true });
  await piPage.locator('[data-pi-phase="read"]').waitFor();
  await checkPiReferenceRead(piPage);
  await piPage.screenshot({ path: join(piArtifacts, "reading-desktop.png") });
  await piPage.setViewportSize({ width: 390, height: 844 });
  await piPage.screenshot({ path: join(piArtifacts, "reading-mobile.png") });
  await piPage.setViewportSize({ width: 1440, height: 1000 });
  await piPage.locator('[data-pi-phase="verified"]').waitFor();
  await checkPiReferenceScan(piPage);
  await piDelay(600);
  await piPage.screenshot({ path: join(piArtifacts, "verified-desktop.png") });
  await piPage.setViewportSize({ width: 390, height: 844 });
  await checkPiReferenceScan(piPage);
  await piPage.screenshot({ path: join(piArtifacts, "verified-mobile.png") });
  await piPage.setViewportSize({ width: 1440, height: 1000 });
  piRecord("Reference phase layout and original two-tone rings; desktop/mobile translated text stays clear");
  await piPage.locator('[data-pi-phase="welcome"]').waitFor();
  await piDelay(650);
  await piPage.screenshot({ path: join(piArtifacts, "welcome.png") });
  await piDelay(2250);
  await piPage.screenshot({ path: join(piArtifacts, "welcome-after-flash.png") });
  await piPage.waitForURL(`${piBase}/?pi-login2-e2e=desktop`, { timeout: 60000 });
  piRecord("Single in-flight login, real HttpOnly cookie, success sequence and safe next destination");
  await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=existing")}`);
  for (const piPhase of ["intro", "wash", "permission", "password"]) {
    await piPage.locator(`[data-pi-phase="${piPhase}"]`).waitFor();
    assert.equal(new URL(piPage.url()).pathname, "/login2");
  }
  assert.equal(await piPage.locator("#pi-access-password").count(), 0);
  const piExistingFallback = piPage.getByRole("link", { name: "跳过动画 · 普通登录 ↗", exact: true });
  assert.equal(new URL(await piExistingFallback.getAttribute("href"), piBase).pathname, "/login");
  assert.equal(await piPage.locator("[data-pi-existing-session]").textContent(), "••••••••");
  assert.equal(await piPage.locator("[data-pi-identity-row]").first().locator("span").textContent(), "身份令牌");
  await piPage.screenshot({ path: join(piArtifacts, "existing-session-desktop.png") });
  assert.equal(await piPage.locator("audio").getAttribute("src"), null, "Existing sessions must not hear a request for a password");
  await checkPiPasswordControls(piPage);
  await piPage.setViewportSize({ width: 1440, height: 1000 });
  await piPage.emulateMedia({ reducedMotion: "reduce" });
  await piDelay(200);
  assert.equal(new URL(piPage.url()).pathname, "/login2", "Motion preference changes must not bypass click-to-enter");
  await piPage.emulateMedia({ reducedMotion: "no-preference" });
  await piDelay(1000);
  assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1, "Existing sessions wait for an explicit click");
  const piGetsBeforeEnter = piGets;
  await piPage.getByRole("button", { name: "点击进入", exact: true }).click();
  await piPage.locator('[data-pi-phase="request"]').waitFor();
  assert.equal(piGets, piGetsBeforeEnter + 1, "Existing-session entry checks the cookie with GET only");
  assert.equal(piPosts, 1, "The token mask must never be submitted as a password");
  for (const piPhase of ["request", "read", "verified", "welcome", "handoff"]) {
    await piPage.locator(`[data-pi-phase="${piPhase}"]`).waitFor();
    assert.equal(new URL(piPage.url()).pathname, "/login2", `${piPhase} must finish before navigating`);
    assert.equal(new URL(await piPage.getByRole("link", { name: "直接进入 Pi Web ↗", exact: true }).getAttribute("href"), piBase).href, `${piBase}/?pi-login2-e2e=existing`);
  }
  await piPage.waitForURL(`${piBase}/?pi-login2-e2e=existing`);
  assert.equal(piPosts, 1, "Click-to-enter must not submit the password again");
  await piPage.emulateMedia({ reducedMotion: "reduce" });
  await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=reduced-existing")}`);
  await piPage.getByRole("button", { name: "点击进入", exact: true }).waitFor();
  await piDelay(500);
  assert.equal(new URL(piPage.url()).pathname, "/login2");
  await piPage.getByRole("button", { name: "点击进入", exact: true }).click();
  await piPage.waitForURL(`${piBase}/?pi-login2-e2e=reduced-existing`);
  assert.equal(piPosts, 1);
  piRecord("Existing sessions wait for click-to-enter, replay the complete success animation and never resubmit a password");
  await piPage.goto(`${piBase}/login2`);
  await piPage.locator("[data-pi-existing-session]").waitFor();
  assert.equal((await piContext.request.delete(`${piBase}/api/web-auth`)).status(), 200);
  await piPage.getByRole("button", { name: "点击进入", exact: true }).click();
  await piPage.locator("#pi-access-password").waitFor();
  assert.equal(await piPage.locator("[data-pi-existing-session]").count(), 0);
  assert.equal(piPosts, 1);
  assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1);
  assert.equal(await piPage.locator("#pi-access-password").inputValue(), "");
  assert.equal(await piPage.locator("#pi-access-error").textContent(), "登录会话已失效，请重新填写身份令牌。");
  assert.equal(await piPage.locator('form button[type="submit"]').isDisabled(), true);
  await piPage.screenshot({ path: join(piArtifacts, "expired-session-password.png") });
  await piPage.locator("#pi-access-password").fill(piPassword);
  await piPage.locator("#pi-access-password").press("Enter");
  await piPage.waitForURL(`${piBase}/`);
  assert.equal(piPosts, 2, "A fresh password is posted only after the user reenters it");
  assert.deepEqual(await (await piContext.request.get(`${piBase}/api/web-auth`)).json(), { enabled: true, authenticated: true });
  await piPage.emulateMedia({ reducedMotion: "no-preference" });
  piRecord("Expired sessions clear the mask, request a fresh token and successfully log in again on the same page");
  assert.equal((await piContext.request.delete(`${piBase}/api/web-auth`)).status(), 200);
  await piPage.goto(`${piBase}/`);
  assert.equal(new URL(piPage.url()).pathname, "/login2");
  await piPage.locator("#pi-access-password").waitFor();
  piRecord("Logout clears the session and the next visit uses login2");

  const { piContext: piMobileContext, piNewPage: piMobile } = await piOpen({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  piPage = piMobile;
  await piMobile.goto(`${piBase}/login2?next=${encodeURIComponent("//evil.example")}`);
  await piMobile.locator("#pi-access-password").waitFor();
  assert.equal(await piMobile.locator('[data-pi-phase="password"]').count(), 1);
  await piCheckProjectLink(piMobile);
  await piMobile.screenshot({ path: join(piArtifacts, "password-mobile.png") });
  await checkPiPasswordControls(piMobile);
  piRecord("Connection metadata reserves its own space across narrow, medium-height and keyboard viewports");
  await piMobile.setViewportSize({ width: 390, height: 320 });
  await piMobile.locator('form button[type="submit"]').scrollIntoViewIfNeeded();
  const piBox = await piMobile.locator('form button[type="submit"]').boundingBox();
  assert.ok(piBox && piBox.y >= 0 && piBox.y + piBox.height <= 320, JSON.stringify(piBox));
  const piSubmitVisible = await piMobile.locator('form button[type="submit"]').evaluate((piButton) => {
    const piBounds = piButton.getBoundingClientRect();
    const piTop = document.elementFromPoint(piBounds.x + piBounds.width / 2, piBounds.y + piBounds.height / 2);
    return piTop === piButton || piButton.contains(piTop);
  });
  assert.equal(piSubmitVisible, true, "Short viewport controls must not be covered by decorations");
  await piCheckProjectLink(piMobile);
  piRecord("Project GitHub link is safe and accessible in dark, light, mobile and short viewports");
  await piMobile.screenshot({ path: join(piArtifacts, "password-keyboard.png") });
  await piMobile.route("**/api/web-auth", (piRoute) => piRoute.request().method() === "POST"
    ? piRoute.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }) : piRoute.continue());
  await piMobile.locator("#pi-access-password").fill(piPassword);
  await piMobile.locator("#pi-access-password").press("Enter");
  await piMobile.locator('[role="alert"]').filter({ hasText: /失败/ }).waitFor();
  assert.equal(await piMobile.locator('[data-pi-phase="password"]').count(), 1);
  await piMobile.unroute("**/api/web-auth");
  await piMobile.locator('form button[type="submit"]').click();
  await piMobile.waitForURL(`${piBase}/`, { timeout: 60000 });
  assert.ok((await piMobileContext.cookies()).some((piItem) => piItem.name === "pi_web_session"));
  piRecord("Mobile/short viewport, reduced motion, missing-cookie rejection and open-redirect rejection");
  await runPiTranslatedLayoutChecks(piBrowser, piBase, piPassword);

  const { piNewPage: piAudioPage } = await piOpen({ viewport: { width: 1280, height: 900 } });
  piPage = piAudioPage;
  await piAudioPage.route("**/login2/assets/*.mp3", (piRoute) => piRoute.abort());
  await piAudioPage.goto(`${piBase}/login2`);
  await piAudioPage.locator("#pi-access-password").waitFor();
  await piAudioPage.locator("#pi-access-password").click();
  await piDelay(300);
  assert.equal(await piAudioPage.locator("[data-pi-audio-control]").getAttribute("aria-pressed"), "true");
  assert.equal(await piAudioPage.locator('[data-pi-phase="password"]').count(), 1);
  await piAudioPage.locator('a[href^="/login?"]').click();
  await piAudioPage.locator("#web-login-password").waitFor();
  assert.equal(new URL(piAudioPage.url()).pathname, "/login");
  assert.deepEqual(piErrors, []);
  piRecord("Generated audio failure cannot advance auth or trap login; original-page fallback works");
  console.log(`Pi login2 browser checks passed; screenshots/log: ${piArtifacts}`);
} catch (piError) {
  await piPage?.screenshot({ path: join(piArtifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw piError;
} finally {
  await piBrowser?.close();
  piServer.kill("SIGTERM");
  await piExit;
  await new Promise((piResolve) => piLog.end(piResolve));
  rmSync(piAgentDir, { recursive: true, force: true });
}
