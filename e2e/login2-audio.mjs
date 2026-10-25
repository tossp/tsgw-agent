import assert from "node:assert/strict";

async function piOpenAudioFixture(piBrowser, piBase, piOptions = {}) {
  const { piAutoplay = false, ...piContextOptions } = piOptions;
  const piContext = await piBrowser.newContext({ locale: "zh-CN", reducedMotion: "reduce", ...piContextOptions });
  await piContext.addInitScript(({ piAutoplay }) => {
    const piPlaying = new WeakSet();
    const piState = window.piAudioFixture = {
      calls: [], allowed: piAutoplay, hidden: false, endedSource: null,
    };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => piState.hidden });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { get() { return !piPlaying.has(this); } });
    Object.defineProperty(HTMLMediaElement.prototype, "ended", { get() { return this.src === piState.endedSource; } });
    HTMLMediaElement.prototype.pause = function () { piPlaying.delete(this); };
    HTMLMediaElement.prototype.play = function () {
      const piEvent = window.event;
      const piGesture = piEvent?.isTrusted && ["click", "pointerup", "touchend", "keydown"].includes(piEvent.type);
      piState.calls.push({ source: this.src, gesture: piGesture ? piEvent.type : null });
      if (!piState.allowed && !piGesture) return Promise.reject(new DOMException("Autoplay blocked", "NotAllowedError"));
      piState.allowed = true;
      piPlaying.add(this);
      return Promise.resolve();
    };
  }, { piAutoplay });
  const piPage = await piContext.newPage();
  await piPage.goto(`${piBase}/login2`);
  await piPage.locator("#pi-access-password").waitFor();
  await piPage.waitForFunction(() => window.piAudioFixture.calls.length > 0);
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
      assert.equal(await piPage.evaluate(() => window.piAudioFixture.calls[0].gesture), null,
        "Audio must attempt autoplay before any interaction");
      const piInput = piPage.locator("#pi-access-password");
      if (piGesture === "touch") await piInput.tap();
      else if (piGesture === "keyboard") await piInput.press("a");
      else await piInput.click();
      await piPage.waitForFunction(() => !document.querySelector("audio").paused);
      assert.ok(await piPage.evaluate(() => window.piAudioFixture.calls.some((piCall) => piCall.gesture)),
        "Playback must be retried synchronously within the normal page interaction");

      if (piGesture === "click") {
        await piPage.evaluate(() => {
          window.piAudioFixture.hidden = true;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
        assert.equal(await piControl.getAttribute("aria-pressed"), "true");
        await piPage.evaluate(() => {
          window.piAudioFixture.hidden = false;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await piPage.waitForFunction(() => !document.querySelector("audio").paused);

        const piCallsBeforeMute = await piPage.evaluate(() => window.piAudioFixture.calls.length);
        await piControl.click();
        assert.equal(await piControl.getAttribute("aria-pressed"), "false");
        assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
        await piInput.click();
        await piInput.press("b");
        await piPage.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        assert.equal(await piPage.evaluate(() => window.piAudioFixture.calls.length), piCallsBeforeMute,
          "Mute and subsequent page interactions must not restart playback");
        await piControl.click();
        await piPage.waitForFunction(() => !document.querySelector("audio").paused);
        assert.equal(await piControl.getAttribute("aria-pressed"), "true");

        await piPage.evaluate(() => {
          const piAudio = document.querySelector("audio");
          window.piAudioFixture.endedSource = piAudio.src;
          piAudio.pause();
        });
        const piCallsAfterEnd = await piPage.evaluate(() => window.piAudioFixture.calls.length);
        await piInput.click();
        await piInput.press("c");
        assert.equal(await piPage.evaluate(() => window.piAudioFixture.calls.length), piCallsAfterEnd,
          "Normal interactions must not replay a completed cue");
      }
    } finally { await piContext.close(); }
  }

  const { piContext, piPage } = await piOpenAudioFixture(piBrowser, piBase, { piAutoplay: true });
  try {
    await piPage.waitForFunction(() => !document.querySelector("audio").paused);
    assert.equal(await piPage.evaluate(() => window.piAudioFixture.calls[0].gesture), null,
      "Browsers that allow autoplay need no gesture");
  } finally { await piContext.close(); }

  // Muting one phase must also silence the next phase, even after an autoplay rejection.
  const piPhaseContext = await piBrowser.newContext({ locale: "zh-CN" });
  const piPhasePage = await piPhaseContext.newPage();
  try {
    await piPhasePage.addInitScript(() => {
      window.piAudioCalls = 0;
      HTMLMediaElement.prototype.play = function () {
        window.piAudioCalls++;
        return Promise.reject(new DOMException("Autoplay blocked", "NotAllowedError"));
      };
    });
    await piPhasePage.goto(`${piBase}/login2`);
    await piPhasePage.locator('[data-pi-phase="permission"]').waitFor();
    await piPhasePage.waitForFunction(() => window.piAudioCalls > 0);
    await piPhasePage.locator("[data-pi-audio-control]").click();
    const piCalls = await piPhasePage.evaluate(() => window.piAudioCalls);
    await piPhasePage.locator("#pi-access-password").waitFor();
    await piPhasePage.locator("#pi-access-password").click();
    assert.equal(await piPhasePage.evaluate(() => window.piAudioCalls), piCalls);
    assert.equal(await piPhasePage.locator("[data-pi-audio-control]").getAttribute("aria-pressed"), "false");
  } finally { await piPhaseContext.close(); }
  console.log("✓ Automatic audio, click/touch/keyboard retry, explicit mute, visibility and completed-cue handling");
}
