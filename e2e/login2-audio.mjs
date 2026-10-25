import assert from "node:assert/strict";
import { installPiMediaFixture } from "./login2-media.mjs";
import { startPiAccess, waitPiAccessReady } from "./login2-start.mjs";

async function piOpenAudioFixture(piBrowser, piBase, piOptions = {}) {
  const { piAutoplay = false, ...piContextOptions } = piOptions;
  const piContext = await piBrowser.newContext({ locale: "zh-CN", reducedMotion: "reduce", ...piContextOptions });
  await installPiMediaFixture(piContext, { piAutoplay, piIgnoreStartGesture: true });
  const piPage = await piContext.newPage();
  await piPage.goto(`${piBase}/login2`);
  await waitPiAccessReady(piPage);
  assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.length), 0,
    "Reduced motion must also wait for explicit start without attempting audio");
  await startPiAccess(piPage);
  await piPage.locator("#pi-access-password").waitFor();
  await piPage.waitForFunction(() => window.piMediaFixture.calls.length > 0);
  const piCalls = await piPage.evaluate(() => window.piMediaFixture.calls);
  assert.ok(piCalls.every((piCall) => piCall.source.endsWith("/pi-password.mp3")),
    "Reduced motion must not play connected or backfill skipped opening cues");
  assert.equal(piCalls[0].gesture, null,
    "The password cue still attempts play from its effect, not inside the new start gesture");
  if (!piAutoplay) assert.equal(await piPage.evaluate(() => window.piMediaFixture.allowed), false,
    "The required start gesture must not contaminate the mock's blocked-autoplay state");
  return { piContext, piPage };
}

export async function runPiAccessAudioChecks(piBrowser, piBase) {
  for (const piGesture of ["click", "keyboard", "touch"]) {
    const { piContext, piPage } = await piOpenAudioFixture(piBrowser, piBase,
      piGesture === "touch" ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } } : {});
    try {
      const piControl = piPage.locator("[data-pi-audio-control]");
      assert.equal(await piControl.getAttribute("aria-pressed"), "true");
      assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
      const piInput = piPage.locator("#pi-access-password");
      if (piGesture === "touch") await piInput.tap();
      else if (piGesture === "keyboard") await piInput.press("a");
      else await piInput.click();
      await piPage.waitForFunction(() => !document.querySelector("audio").paused);
      assert.ok(await piPage.evaluate(() => window.piMediaFixture.calls.some((piCall) => piCall.gesture)),
        "Playback must be retried synchronously within the normal page interaction");

      if (piGesture === "click") {
        await piPage.evaluate(() => {
          window.piMediaFixture.hidden = true;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
        assert.equal(await piControl.getAttribute("aria-pressed"), "true");
        await piPage.evaluate(() => {
          window.piMediaFixture.hidden = false;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await piPage.waitForFunction(() => !document.querySelector("audio").paused);

        const piCallsBeforeMute = await piPage.evaluate(() => window.piMediaFixture.calls.length);
        await piControl.click();
        assert.equal(await piControl.getAttribute("aria-pressed"), "false");
        assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
        await piInput.click();
        await piInput.press("b");
        await piPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.length), piCallsBeforeMute,
          "Mute and subsequent page interactions must not restart playback");
        await piControl.click();
        await piPage.waitForFunction(() => !document.querySelector("audio").paused);
        assert.equal(await piControl.getAttribute("aria-pressed"), "true");

        await piPage.evaluate(() => window.piMediaFixture.finish());
        const piCallsAfterEnd = await piPage.evaluate(() => window.piMediaFixture.calls.length);
        await piInput.click();
        await piInput.press("c");
        assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.length), piCallsAfterEnd,
          "Normal interactions must not replay a completed cue");
      }
    } finally { await piContext.close(); }
  }

  const { piContext, piPage } = await piOpenAudioFixture(piBrowser, piBase, { piAutoplay: true });
  try {
    await piPage.waitForFunction(() => !document.querySelector("audio").paused);
    assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls[0].gesture), null,
      "Browsers that permit autoplay still play password from its effect after explicit start");
  } finally { await piContext.close(); }

  // Muting one phase must also silence the next phase, even after an autoplay rejection.
  const piPhaseContext = await piBrowser.newContext({ locale: "zh-CN" });
  await installPiMediaFixture(piPhaseContext, { piRejectPlay: true });
  const piPhasePage = await piPhaseContext.newPage();
  try {
    await piPhasePage.goto(`${piBase}/login2`);
    await startPiAccess(piPhasePage);
    await piPhasePage.locator('[data-pi-phase="permission"]').waitFor();
    await piPhasePage.waitForFunction(() => window.piMediaFixture.calls.some((piCall) => piCall.source.endsWith("/pi-permission.mp3")));
    await piPhasePage.locator("[data-pi-audio-control]").click();
    const piCalls = await piPhasePage.evaluate(() => window.piMediaFixture.calls.length);
    await piPhasePage.locator("#pi-access-password").waitFor();
    await piPhasePage.locator("#pi-access-password").click();
    assert.equal(await piPhasePage.evaluate(() => window.piMediaFixture.calls.length), piCalls);
    assert.equal(await piPhasePage.locator("[data-pi-audio-control]").getAttribute("aria-pressed"), "false");
  } finally { await piPhaseContext.close(); }
  console.log("✓ Effect-only reduced-motion audio, unpolluted autoplay rejection, click/touch/key retry, mute, visibility and completed-cue handling");
}
