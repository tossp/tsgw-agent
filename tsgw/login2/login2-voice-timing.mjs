import assert from "node:assert/strict";
import { setTimeout as piDelay } from "node:timers/promises";
import { installPiMediaFixture, piVoicePaths } from "./login2-media.mjs";
import { startPiAccess } from "./login2-start.mjs";

async function piWaitForVoice(piPage, piName) {
  await piPage.waitForFunction((piName) => {
    const piAudio = document.querySelector("audio");
    return piAudio?.src.endsWith(`/pi-${piName}.mp3`) && !piAudio.paused
      && window.piMediaFixture.events.some((piEvent) => piEvent.type === "playing" && piEvent.source.endsWith(`/pi-${piName}.mp3`));
  }, piName);
}

async function piFinishVoice(piPage) {
  await piPage.evaluate(() => window.piMediaFixture.finish());
}

async function piSubmitPassword(piPage, piPassword) {
  await piPage.locator("#pi-access-password").waitFor({ timeout: 60000 });
  await piPage.locator("#pi-access-password").fill(piPassword);
  await piPage.locator("#pi-access-password").press("Enter");
}

async function piCheckSpeechCompletion(piBrowser, piBase, piPassword) {
  const piContext = await piBrowser.newContext({ locale: "zh-CN" });
  await installPiMediaFixture(piContext, {
    piAutoEnd: true, piManualVoices: ["connected", "permission", "verified", "welcome"],
    piPlayDelays: { verified: 5000 },
  });
  const piPage = await piContext.newPage();
  piPage.setDefaultTimeout(30000);
  try {
    const piDestination = `${piBase}/?pi-login2-e2e=voice-timing`;
    await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=voice-timing")}`);
    await startPiAccess(piPage);
    await piWaitForVoice(piPage, "connected");
    await piDelay(3700);
    assert.equal(await piPage.locator('[data-pi-phase="intro"]').count(), 1,
      "The 3.4-second intro timer must not cut off an already playing connected cue");
    await piFinishVoice(piPage);
    await piPage.locator('[data-pi-phase="permission"]').waitFor();
    await piWaitForVoice(piPage, "permission");
    await piDelay(2900);
    assert.equal(await piPage.locator('[data-pi-phase="permission"]').count(), 1,
      "The permission phase waits for its voice instead of cutting it off at 2.6 seconds");
    await piFinishVoice(piPage);
    await piSubmitPassword(piPage, piPassword);
    await piPage.locator('[data-pi-phase="verified"]').waitFor();
    await piPage.waitForFunction(() => window.piMediaFixture.calls.some((piCall) => piCall.source.endsWith("/pi-verified.mp3") && piCall.pending));
    assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), false,
      "Accepted play remains active while delayed loading keeps its promise pending");
    await piWaitForVoice(piPage, "verified");
    const piVerifiedStart = await piPage.evaluate(() => {
      const piState = window.piMediaFixture;
      return {
        called: piState.calls.find((piCall) => piCall.source.endsWith("/pi-verified.mp3")).at,
        playing: piState.events.find((piEvent) => piEvent.type === "playing" && piEvent.source.endsWith("/pi-verified.mp3")).at,
      };
    });
    assert.ok(piVerifiedStart.playing - piVerifiedStart.called >= 4800,
      "This regression must genuinely delay verified playback, not just lengthen an immediately started cue");
    await piDelay(1200);
    assert.equal(await piPage.locator('[data-pi-phase="verified"]').count(), 1,
      "Verified stays visible beyond both the old 3.55s and new 4.5s timers when voice starts five seconds late");
    assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), false);
    await piFinishVoice(piPage);
    await piPage.locator('[data-pi-phase="welcome"]').waitFor();
    await piWaitForVoice(piPage, "welcome");
    await piDelay(4200);
    assert.equal(await piPage.locator('[data-pi-phase="welcome"]').count(), 1,
      "Welcome cannot begin handoff while the started voice is still speaking");
    assert.equal(piPage.url().startsWith(`${piBase}/login2`), true);
    const piCalls = await piPage.evaluate(() => window.piMediaFixture.calls);
    assert.deepEqual([...new Set(piCalls.map((piCall) => piCall.source))].sort(), [...piVoicePaths].sort(),
      "All six cues retain their intended public paths");
    assert.equal(piCalls.filter((piCall) => piCall.source.endsWith("/pi-connected.mp3")).length, 1);
    await piFinishVoice(piPage);
    await piPage.waitForURL(piDestination, { timeout: 60000 });
    assert.deepEqual(await (await piContext.request.get(`${piBase}/api/web-auth`)).json(), { enabled: true, authenticated: true });
  } finally { await piContext.close(); }
}

async function piCheckDegradedSpeech(piBrowser, piBase, piPassword, piMode) {
  const piContext = await piBrowser.newContext({ locale: "zh-CN" });
  if (piMode !== "load-error") await installPiMediaFixture(piContext, {
    piAutoEnd: true, piRejectPlay: piMode === "blocked", piManualVoices: piMode === "muted" ? ["connected"] : [],
  });
  const piPage = await piContext.newPage();
  piPage.setDefaultTimeout(30000);
  try {
    if (piMode === "load-error") await piPage.route("**/login2/assets/*.mp3", (piRoute) => piRoute.abort());
    await piPage.goto(`${piBase}/login2?next=${encodeURIComponent(`/?pi-login2-e2e=${piMode}`)}`);
    await startPiAccess(piPage);
    if (piMode === "muted") {
      await piWaitForVoice(piPage, "connected");
      await piPage.locator("[data-pi-audio-control]").click();
      assert.equal(await piPage.locator("audio").evaluate((piAudio) => piAudio.paused), true);
    }
    await piSubmitPassword(piPage, piPassword);
    await piPage.locator('[data-pi-phase="welcome"]').waitFor({ timeout: 60000 });
    if (piMode === "muted") {
      assert.equal(await piPage.locator("[data-pi-audio-control]").getAttribute("aria-pressed"), "false");
      assert.equal(await piPage.evaluate(() => window.piMediaFixture.calls.length), 1,
        "Muting releases voice waiting without enabling/retrying later phase cues");
    }
    await piPage.waitForURL(`${piBase}/?pi-login2-e2e=${piMode}`, { timeout: 60000 });
    assert.deepEqual(await (await piContext.request.get(`${piBase}/api/web-auth`)).json(), { enabled: true, authenticated: true },
      `${piMode} speech cannot trap or bypass real password authentication`);
  } finally { await piContext.close(); }
}

async function piCheckBoundedSpeechWait(piBrowser, piBase, piPassword) {
  const piContext = await piBrowser.newContext({ locale: "zh-CN", reducedMotion: "reduce" });
  await installPiMediaFixture(piContext, { piAutoEnd: true, piManualVoices: ["verified"] });
  const piPage = await piContext.newPage();
  try {
    await piPage.goto(`${piBase}/login2?next=${encodeURIComponent("/?pi-login2-e2e=stalled-voice")}`);
    await startPiAccess(piPage);
    await piPage.locator("#pi-access-password").waitFor();
    await piPage.emulateMedia({ reducedMotion: "no-preference" });
    await piSubmitPassword(piPage, piPassword);
    await piPage.locator('[data-pi-phase="verified"]').waitFor();
    await piWaitForVoice(piPage, "verified");
    const piStarted = Date.now();
    // No ended/error event will arrive. The new 4.5s minimum plus at most 5s
    // extra waiting must release authentication without another gesture.
    await piPage.locator('[data-pi-phase="welcome"]').waitFor({ timeout: 15000 });
    const piElapsed = Date.now() - piStarted;
    assert.ok(piElapsed >= 8000 && piElapsed < 12000, `Stalled verified voice must respect the bounded 9.5s budget: ${piElapsed}ms`);
    assert.equal(await piPage.evaluate(() => window.piMediaFixture.events.some((piEvent) =>
      piEvent.type === "ended" && piEvent.source.endsWith("/pi-verified.mp3"))), false);
    await piPage.waitForURL(`${piBase}/?pi-login2-e2e=stalled-voice`, { timeout: 60000 });
  } finally { await piContext.close(); }
}

export async function runPiVoiceTimingChecks(piBrowser, piBase, piPassword) {
  await piCheckSpeechCompletion(piBrowser, piBase, piPassword);
  for (const piMode of ["muted", "blocked", "load-error"]) await piCheckDegradedSpeech(piBrowser, piBase, piPassword, piMode);
  await piCheckBoundedSpeechWait(piBrowser, piBase, piPassword);
  console.log("✓ Started speech finishes before stage changes, pending/delayed verified survives 4.5s, bounded 9.5s wait, mute/blocked/load-error authentication");
}
