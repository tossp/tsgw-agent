import assert from "node:assert/strict";
import { setTimeout as piDelay } from "node:timers/promises";
import { installPiMediaFixture, piVoicePaths } from "./login2-media.mjs";
import { assertPiAccessWaiting, startPiAccess, waitPiAccessReady } from "./login2-start.mjs";

async function piOpenFixture(piBrowser, piOptions = {}, piMediaOptions = {}) {
  const piContext = await piBrowser.newContext({ locale: "zh-CN", ...piOptions });
  await installPiMediaFixture(piContext, { piAutoEnd: true, ...piMediaOptions });
  const piPage = await piContext.newPage();
  piPage.setDefaultTimeout(30000);
  return { piContext, piPage };
}

async function piAssertNoPlayback(piPage) {
  assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.length), 0,
    "Preloading/loading/ready and excluded controls must not call play()");
}

async function piCheckLoadingGates(piBrowser, piBase, piLastGate) {
  const { piContext, piPage } = await piOpenFixture(piBrowser, {}, { piPreload: "manual" });
  let piReleaseAuth;
  const piAuthGate = new Promise((piResolve) => { piReleaseAuth = piResolve; });
  let piAuthRequested = false;
  try {
    await piPage.route("**/api/web-auth", async (piRoute) => {
      piAuthRequested = true;
      await piAuthGate;
      await piRoute.continue();
    });
    await piPage.goto(`${piBase}/login2`, { waitUntil: "domcontentloaded" });
    await piPage.locator('[data-pi-phase="checking"]').waitFor();
    await piPage.waitForFunction(() => window.piMediaFixture.preloads.length >= 6);
    assert.equal(piAuthRequested, true, "Session GET and all six preloads must run concurrently");
    const piPreloads = await piPage.evaluate(() => window.piMediaFixture.preloads.map((piAudio) => ({
      path: new URL(piAudio.src).pathname, preload: piAudio.preload,
    })));
    assert.deepEqual(piPreloads.map((piItem) => piItem.path).sort(), [...piVoicePaths].sort());
    assert.ok(piPreloads.every((piItem) => piItem.preload === "auto"));
    await assertPiAccessWaiting(piPage, "checking");
    await piAssertNoPlayback(piPage);
    // Early keys/clicks while checking are not a deferred start request.
    await piPage.keyboard.press("a");
    await piPage.mouse.click(20, 100);
    if (piLastGate === "audio") {
      piReleaseAuth();
      await piPage.evaluate(() => {
        for (let piIndex = 0; piIndex < 5; piIndex++) window.piMediaFixture.releasePreload(piIndex);
      });
    } else {
      await piPage.evaluate(() => {
        for (let piIndex = 0; piIndex < 6; piIndex++) window.piMediaFixture.releasePreload(piIndex);
      });
    }
    await piDelay(200);
    await assertPiAccessWaiting(piPage, "checking");
    await piAssertNoPlayback(piPage);
    if (piLastGate === "audio") await piPage.evaluate(() => window.piMediaFixture.releasePreload(5));
    else piReleaseAuth();
    await waitPiAccessReady(piPage, { piChinese: true, piQuietMs: 700 });
    await piAssertNoPlayback(piPage);
  } finally { piReleaseAuth(); await piContext.close(); }
}

async function piClickWithoutNavigating(piLink) {
  // Preserve real trusted input and event propagation without opening an external tab
  // or leaving the fixture. No application handler is replaced.
  await piLink.evaluate((piElement) => piElement.addEventListener("click", (piEvent) => piEvent.preventDefault()));
  await piLink.click();
}

async function piCheckStartGesture(piBrowser, piBase, piGesture) {
  const { piContext, piPage } = await piOpenFixture(piBrowser,
    piGesture === "touch" ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } : {});
  try {
    await piPage.goto(`${piBase}/login2`);
    await waitPiAccessReady(piPage, { piChinese: true });
    await piPage.locator("[data-pi-start]").evaluate((piButton) => piButton.click());
    await assertPiAccessWaiting(piPage);
    await piAssertNoPlayback(piPage);
    await piClickWithoutNavigating(piPage.getByRole("link", { name: "GitHub · tossp/tsgw-agent" }));
    await piClickWithoutNavigating(piPage.locator('a[href^="/login?"]'));
    const piAudioControl = piPage.locator("[data-pi-audio-control]");
    const piControlBox = await piAudioControl.boundingBox();
    assert.ok(piControlBox, "Audio control remains available on the ready screen");
    await piPage.mouse.click(piControlBox.x + piControlBox.width / 2, piControlBox.y + piControlBox.height / 2);
    await piDelay(150);
    await assertPiAccessWaiting(piPage);
    await piAssertNoPlayback(piPage);
    // If the ready control supports muting, restore it before testing the opening cue.
    if (await piAudioControl.getAttribute("aria-pressed") === "false") {
      await piPage.mouse.click(piControlBox.x + piControlBox.width / 2, piControlBox.y + piControlBox.height / 2);
    }
    if (piGesture === "ordinary-click") {
      await piPage.mouse.click(20, 100); // not the dedicated start button or any utility control
    } else {
      // Move focus away from the excluded link/control: a normal document key starts.
      await piPage.locator("[data-pi-start]").focus();
      await startPiAccess(piPage, { piGesture });
    }
    await piPage.locator('[data-pi-phase="intro"]').waitFor();
    const piConnected = await piPage.evaluate(() => window.piMediaFixture.calls.filter((piCall) => piCall.source.endsWith("/pi-connected.mp3")));
    assert.equal(piConnected.length, 1, "The first start plays connected exactly once");
    assert.ok(piConnected[0].gesture, "Normal-motion connected play() must run synchronously inside trusted input");
    assert.equal(await piPage.locator("audio").getAttribute("src"), "/login2/assets/pi-connected.mp3");
    await piPage.keyboard.press("b");
    await piPage.mouse.click(20, 100);
    await piPage.locator("#pi-access-password").waitFor();
    await piPage.locator("#pi-access-password").click();
    await piPage.keyboard.press("c");
    await piDelay(150);
    assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.filter((piCall) => piCall.source.endsWith("/pi-connected.mp3")).length), 1,
      "Repeated start input and later interactions must never replay the opening voice");
    assert.equal(await piPage.locator('[data-pi-phase="password"]').count(), 1);
  } finally { await piContext.close(); }
}

export async function runPiOpeningChecks(piBrowser, piBase) {
  for (const piLastGate of ["audio", "auth"]) await piCheckLoadingGates(piBrowser, piBase, piLastGate);
  for (const piGesture of ["ordinary-click", "click", "keyboard", "touch"]) await piCheckStartGesture(piBrowser, piBase, piGesture);
  for (const piPreload of ["error", "manual"]) {
    const { piContext, piPage } = await piOpenFixture(piBrowser, { reducedMotion: "reduce" }, { piPreload });
    try {
      await piPage.goto(`${piBase}/login2`, { waitUntil: "domcontentloaded" });
      if (piPreload === "manual") {
        await piPage.waitForFunction(() => window.piMediaFixture.preloads.length === 6);
        const piStarted = Date.now();
        await assertPiAccessWaiting(piPage, "checking");
        await waitPiAccessReady(piPage, { piChinese: true });
        const piElapsed = Date.now() - piStarted;
        assert.ok(piElapsed >= 6500 && piElapsed < 12000,
          `A stalled preload must settle near the bounded eight-second loading timeout, not skip loading: ${piElapsed}ms`);
      }
      await startPiAccess(piPage);
      await piPage.locator("#pi-access-password").waitFor();
      assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.some((piCall) => piCall.source.endsWith("/pi-connected.mp3"))), false,
        "Reduced motion starts only after ready input, skips intro, and must not backfill connected later");
    } finally { await piContext.close(); }
  }
  console.log("✓ Parallel session/six-audio loading gates, bounded preload failure, idle ready, excluded controls and one-shot click/key/touch start");
}
