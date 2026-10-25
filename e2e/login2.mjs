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
  assert.equal((await fetch(`${piBase}/api/sessions`)).status, 401);
  const piRootResponse = await fetch(piBase, { redirect: "manual" });
  assert.equal(new URL(piRootResponse.headers.get("location"), piBase).pathname, "/login");
  piRecord("Original unauthenticated redirect and API protection unchanged");

  piBrowser = await chromium.launch({ headless: true });
  const { piContext, piNewPage } = await piOpen({ viewport: { width: 1440, height: 1000 } });
  piPage = piNewPage;
  await piPage.goto(`${piBase}/login`);
  await piPage.locator("#web-login-password").waitFor();
  await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=desktop")}`);
  await piPage.locator('[data-pi-phase="intro"]').waitFor();
  await piPage.screenshot({ path: join(piArtifacts, "intro.png") });
  await piPage.locator("#pi-access-password").waitFor();
  assert.equal(await piPage.locator("iframe").count(), 0);
  await piPage.screenshot({ path: join(piArtifacts, "password-desktop.png") });
  await piDelay(1000);
  assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1);
  assert.ok((await piPage.locator('a[href^="/login?"]').getAttribute("href")).includes("pi-login2-e2e"));
  piRecord("React opening/wash/password sequence; password phase never advances itself");

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
  piRecord("Wrong password, real 429 throttle, Enter submit and spaces in passwords");

  let piPosts = 0;
  await piPage.route("**/api/web-auth", async (piRoute) => {
    if (piRoute.request().method() === "POST") { piPosts++; await piDelay(500); }
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
  await piPage.locator('[data-pi-phase="welcome"]').waitFor();
  await piDelay(1400);
  await piPage.screenshot({ path: join(piArtifacts, "welcome.png") });
  await piPage.waitForURL(`${piBase}/?pi-login2-e2e=desktop`, { timeout: 60000 });
  await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=existing")}`);
  await piPage.waitForURL(`${piBase}/?pi-login2-e2e=existing`);
  piRecord("Single in-flight login, real HttpOnly cookie, success sequence, next and existing-session shortcut");

  const { piContext: piMobileContext, piNewPage: piMobile } = await piOpen({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  piPage = piMobile;
  await piMobile.goto(`${piBase}/login2?next=${encodeURIComponent("//evil.example")}`);
  await piMobile.locator("#pi-access-password").waitFor();
  assert.equal(await piMobile.locator('[data-pi-phase="password"]').count(), 1);
  await piMobile.screenshot({ path: join(piArtifacts, "password-mobile.png") });
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

  const { piNewPage: piAudioPage } = await piOpen({ viewport: { width: 1280, height: 900 } });
  piPage = piAudioPage;
  await piAudioPage.route("**/login2/assets/*.mp3", (piRoute) => piRoute.abort());
  await piAudioPage.goto(`${piBase}/login2`);
  await piAudioPage.locator("#pi-access-password").waitFor();
  const piAudioButton = piAudioPage.getByRole("button", { name: "开启中文播报" });
  await piAudioButton.click();
  await piDelay(300);
  assert.equal(await piAudioButton.getAttribute("aria-pressed"), "false");
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
