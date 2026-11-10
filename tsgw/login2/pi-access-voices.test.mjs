import assert from "node:assert/strict";
import test from "node:test";
import { PI_ACCESS_VOICE_NAMES, piAccessVoiceSource, preloadPiAccessVoices } from "./pi-access-voices.ts";

function piMockAudio(piContext) {
  const piPrevious = globalThis.Audio;
  const piClips = [];
  globalThis.Audio = class extends EventTarget {
    src = "";
    preload = "";
    loads = 0;
    constructor() { super(); piClips.push(this); }
    load() { this.loads++; }
    removeAttribute(piName) { if (piName === "src") this.src = ""; }
    play() { assert.fail("Loading must never play audio before the start gesture"); }
  };
  const piController = new AbortController();
  piContext.after(() => {
    piController.abort();
    if (piPrevious === undefined) delete globalThis.Audio;
    else globalThis.Audio = piPrevious;
  });
  return { piClips, piController };
}

test("Pi loading warms all six original-rate voices without playing them", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  const piLoading = preloadPiAccessVoices(piController.signal);
  assert.deepEqual(piClips.map((piClip) => piClip.src), PI_ACCESS_VOICE_NAMES.map(piAccessVoiceSource));
  for (const piClip of piClips) {
    assert.equal(piClip.preload, "auto");
    assert.equal(piClip.loads, 1);
    piClip.dispatchEvent(new Event("canplaythrough"));
  }
  await piLoading;
});

test("Pi loading waits for the last voice rather than the first loaded clip", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  let piComplete = false;
  const piLoading = preloadPiAccessVoices(piController.signal).then(() => { piComplete = true; });
  for (const piClip of piClips.slice(0, -1)) piClip.dispatchEvent(new Event("canplaythrough"));
  await Promise.resolve();
  assert.equal(piComplete, false);
  piClips.at(-1).dispatchEvent(new Event("canplaythrough"));
  await piLoading;
  assert.equal(piComplete, true);
});

test("Pi failed voices do not block entry or trigger playback", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  const piLoading = preloadPiAccessVoices(piController.signal);
  for (const piClip of piClips) piClip.dispatchEvent(new Event("error"));
  await piLoading;
});

test("Pi loading has a finite deadline and releases stalled media", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  await preloadPiAccessVoices(piController.signal, 10);
  assert.ok(piClips.every((piClip) => piClip.src === "" && piClip.loads === 2));
});

test("Pi loading cancels pending media when the page unmounts", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  const piLoading = preloadPiAccessVoices(piController.signal);
  piController.abort();
  await piLoading;
  assert.ok(piClips.every((piClip) => piClip.src === ""));
});

test("Pi already-aborted loading does not allocate media", async (piContext) => {
  const { piClips, piController } = piMockAudio(piContext);
  piController.abort();
  await preloadPiAccessVoices(piController.signal);
  assert.equal(piClips.length, 0);
});

test("Pi loading still permits entry when media construction is unavailable", async (piContext) => {
  const { piController } = piMockAudio(piContext);
  globalThis.Audio = class { constructor() { throw new Error("Media unavailable"); } };
  await preloadPiAccessVoices(piController.signal);
});
