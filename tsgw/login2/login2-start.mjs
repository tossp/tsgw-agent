import assert from "node:assert/strict";
import { setTimeout as piDelay } from "node:timers/promises";

export async function assertPiAccessWaiting(piPage, piPhase = "ready") {
  assert.equal(await piPage.locator(`[data-pi-phase="${piPhase}"]`).count(), 1);
  assert.equal(await piPage.locator("#pi-access-password, [data-pi-existing-session]").count(), 0,
    "Loading/ready must not expose credentials or enter the animation before an explicit start");
  assert.equal(await piPage.locator("audio").evaluateAll((piAudios) => piAudios.every((piAudio) => piAudio.paused)), true,
    "Loading/ready must not play any voice");
  if (piPhase === "ready") {
    const piStart = piPage.locator("[data-pi-start]");
    assert.equal(await piStart.isVisible(), true);
    assert.equal(await piStart.isEnabled(), true);
  } else {
    assert.equal(await piPage.locator("[data-pi-start]").isVisible(), false);
  }
}

export async function waitPiAccessReady(piPage, { piChinese = false, piQuietMs = 150 } = {}) {
  await piPage.locator('[data-pi-phase="ready"]').waitFor({ timeout: 20000 });
  await assertPiAccessWaiting(piPage);
  if (piChinese) assert.equal((await piPage.locator("[data-pi-start]").textContent()).trim(), "点击或按任意键开始");
  // Catch an automatic intro/password transition, including the reduced-motion path.
  await piDelay(piQuietMs);
  await assertPiAccessWaiting(piPage);
}

export async function startPiAccess(piPage, { piGesture = "click", ...piReadyOptions } = {}) {
  await waitPiAccessReady(piPage, piReadyOptions);
  if (piGesture === "keyboard") await piPage.keyboard.press("a");
  else if (piGesture === "touch") await piPage.locator("[data-pi-start]").tap();
  else await piPage.locator("[data-pi-start]").click();
  await piPage.locator('[data-pi-phase="ready"]').waitFor({ state: "detached" });
}
