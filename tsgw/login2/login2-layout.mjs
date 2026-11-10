import assert from "node:assert/strict";
import { startPiAccess } from "./login2-start.mjs";

export async function checkPiIdentityCard(piPage) {
  const piRows = piPage.locator("[data-pi-identity-row]");
  assert.equal(await piRows.count(), 3);
  assert.equal(await piPage.locator('label[for="pi-access-password"]').textContent(), "身份令牌");
  assert.equal(await piRows.nth(1).locator("span").textContent(), "身份编号");
  assert.equal(await piRows.nth(2).locator("span").textContent(), "权限等级");
  assert.equal(await piRows.nth(2).locator("b").textContent(), "3");
  const piNumber = await piPage.locator("[data-pi-identity-number]").textContent();
  assert.equal(piNumber, "9527");
  const piExpectedHost = new URL(piPage.url()).hostname;
  assert.equal(await piPage.locator("[data-pi-hostname]").textContent(), piExpectedHost);
  assert.equal((await piPage.locator("[data-pi-host-readout] > div").last().textContent()).trim(), `· HOST : ${piExpectedHost}`);
  assert.equal((await piPage.locator("[data-pi-source-ip]").textContent()).trim(), "· SOURCE IP : 127.0.0.1");
  const piClock = piPage.locator("[data-pi-clock]");
  const piTime = await piClock.textContent();
  assert.match(piTime, /^\d{2}:\d{2}:\d{2}$/);
  await piPage.waitForFunction((piPrevious) => document.querySelector("[data-pi-clock]").textContent !== piPrevious, piTime);
  assert.equal(await piPage.locator("[data-pi-identity-number]").textContent(), piNumber,
    "Clock ticks and re-renders must preserve the fixed operator number");
  const piGeometry = await piPage.evaluate(() => {
    const piStatus = document.querySelector("[data-pi-status-text]").parentElement.getBoundingClientRect();
    const piAction = document.querySelector("[data-pi-action]").getBoundingClientRect();
    return { center: piStatus.y + piStatus.height / 2, action: piAction.top, height: innerHeight };
  });
  assert.ok(Math.abs(piGeometry.center - piGeometry.height * .47) < 2, JSON.stringify(piGeometry));
  assert.ok(Math.abs(piGeometry.action - piGeometry.height * .60) < 2, JSON.stringify(piGeometry));
  return piNumber;
}

export async function checkPiPasswordControls(piPage) {
  for (const piViewport of [{ width: 320, height: 720 }, { width: 320, height: 600 }, { width: 390, height: 540 },
    { width: 800, height: 720 }, { width: 800, height: 600 }, { width: 390, height: 320 }]) {
    await piPage.setViewportSize(piViewport);
    const piSubmit = piPage.locator('form button[type="submit"]');
    await piSubmit.scrollIntoViewIfNeeded();
    const piResult = await piSubmit.evaluate((piButton) => {
      const piBox = piButton.getBoundingClientRect();
      const piHit = document.elementFromPoint(piBox.x + piBox.width / 2, piBox.y + piBox.height / 2);
      const piReadout = document.querySelector("[data-pi-host-readout]");
      const piReadoutBox = piReadout.getBoundingClientRect();
      const piReadoutVisible = getComputedStyle(piReadout).display !== "none";
      const piScroll = document.querySelector("[data-pi-action]").parentElement.getBoundingClientRect();
      const piOverlaps = (piOther) => piReadoutVisible && piOther.left < piReadoutBox.right && piOther.right > piReadoutBox.left
        && Math.max(piOther.top, piScroll.top) < piReadoutBox.bottom
        && Math.min(piOther.bottom, piScroll.bottom) > piReadoutBox.top;
      return {
        buttonClickable: piHit === piButton || piButton.contains(piHit),
        overlapping: [...document.querySelectorAll("form input,form button,form [role=alert],[data-pi-status-text]")]
          .some((piElement) => piOverlaps(piElement.getBoundingClientRect())),
      };
    });
    assert.equal(piResult.buttonClickable, true, `Submit must remain clickable: ${JSON.stringify(piViewport)}`);
    assert.equal(piResult.overlapping, false, `Connection readout must not overlap text or controls: ${JSON.stringify(piViewport)}`);
  }
}

export async function checkPiReferenceRead(piPage) {
  await piPage.waitForFunction(() => {
    const piScene = document.querySelector('[data-pi-phase="read"]');
    return piScene && getComputedStyle(piScene.querySelector("[data-pi-scan]")).opacity === "0";
  });
  const piState = await piPage.locator('[data-pi-phase="read"]').evaluate((piScene) => ({
    logo: piScene.getAttribute("data-pi-logo"), reticle: piScene.getAttribute("data-pi-reticle"),
  }));
  assert.equal(piState.logo, "1", "The reference assembles its central mark during REQUEST and READ");
  assert.equal(piState.reticle, "0", "The reference does not show the scan rings during READ");
}

export async function runPiTranslatedLayoutChecks(piBrowser, piBase, piPassword) {
  for (const piLocale of ["en", "zh-TW"]) {
    const piContext = await piBrowser.newContext({ locale: piLocale, viewport: { width: 320, height: 720 }, reducedMotion: "reduce" });
    const piPage = await piContext.newPage();
    try {
      await piPage.goto(`${piBase}/login2`);
      await startPiAccess(piPage);
      await piPage.locator("#pi-access-password").waitFor();
      assert.equal(await piPage.locator("[data-pi-identity-row]").count(), 3);
      const piNumber = await piPage.locator("[data-pi-identity-number]").textContent();
      assert.equal(piNumber, "9527");
      const piCardFits = await piPage.locator("[data-pi-identity-card]").evaluate((piCard) => {
        const piBox = piCard.getBoundingClientRect();
        return piCard.scrollWidth <= piCard.clientWidth && piBox.x >= 0 && piBox.right <= innerWidth;
      });
      assert.equal(piCardFits, true, `${piLocale} identity fields must fit a 320px viewport`);
      await checkPiPasswordControls(piPage);
      await piPage.setViewportSize({ width: 320, height: 720 });
      await piPage.locator("#pi-access-password").fill(piPassword);
      await piPage.emulateMedia({ reducedMotion: "no-preference" });
      await piPage.locator("#pi-access-password").press("Enter");
      await piPage.locator('[data-pi-phase="verified"]').waitFor();
      await checkPiReferenceScan(piPage);
      await piPage.setViewportSize({ width: 320, height: 600 });
      await checkPiReferenceScan(piPage);
    } finally { await piContext.close(); }
  }
  console.log("✓ English/traditional-Chinese identity cards and scan masks fit 320px; height-only resize stays aligned");
}

export async function checkPiReferenceScan(piPage) {
  await piPage.waitForFunction(() => {
    const piSvg = document.querySelector("[data-pi-scan] svg");
    const piCutout = document.querySelector("[data-pi-scan-cutout]");
    const piFrame = piSvg.getBoundingClientRect();
    const piText = document.querySelector("[data-pi-status-text]").getBoundingClientRect();
    const piScale = piFrame.width / 400;
    const piLeft = piFrame.left + Number(piCutout.getAttribute("x")) * piScale;
    const piTop = piFrame.top + Number(piCutout.getAttribute("y")) * piScale;
    return piLeft < piText.left && piLeft + Number(piCutout.getAttribute("width")) * piScale > piText.right
      && piTop < piText.top && piTop + Number(piCutout.getAttribute("height")) * piScale > piText.bottom;
  });
  const piScan = await piPage.locator("[data-pi-scan] svg").evaluate((piSvg) => {
    const piStyle = (piName) => getComputedStyle(piSvg.querySelector(`[data-pi-rotor="${piName}"]`));
    const piSvgBounds = piSvg.getBoundingClientRect();
    const piText = document.querySelector("[data-pi-status-text]").getBoundingClientRect();
    const piMask = piSvg.querySelector("[data-pi-scan-cutout]");
    const piScale = piSvgBounds.width / 400;
    const piMaskBox = {
      left: piSvgBounds.left + Number(piMask.getAttribute("x")) * piScale,
      top: piSvgBounds.top + Number(piMask.getAttribute("y")) * piScale,
      width: Number(piMask.getAttribute("width")) * piScale,
      height: Number(piMask.getAttribute("height")) * piScale,
    };
    const piOuter = piStyle("outer"), piInner = piStyle("inner");
    return {
      paths: piSvg.querySelectorAll("path").length, dots: piSvg.querySelectorAll("circle").length,
      outerDuration: piOuter.animationDuration, innerDuration: piInner.animationDuration,
      innerDirection: piInner.animationDirection,
      outerStroke: getComputedStyle(piSvg.querySelector("path")).strokeWidth,
      innerStroke: getComputedStyle(piSvg.querySelector('[data-pi-rotor="inner"] path')).stroke,
      textLeft: piText.left, textRight: piText.right, textTop: piText.top, textBottom: piText.bottom,
      mask: piMaskBox, viewportWidth: innerWidth,
    };
  });
  assert.equal(piScan.paths, 4);
  assert.equal(piScan.dots, 5);
  assert.equal(piScan.outerDuration, "9s");
  assert.equal(piScan.innerDuration, "5.4s");
  assert.equal(piScan.innerDirection, "reverse");
  assert.equal(piScan.outerStroke, "6px");
  assert.equal(piScan.innerStroke, "rgb(255, 255, 255)");
  assert.ok(piScan.mask.left < piScan.textLeft && piScan.mask.left + piScan.mask.width > piScan.textRight,
    "The original ring geometry must leave the full translated text width clear");
  assert.ok(piScan.mask.top < piScan.textTop && piScan.mask.top + piScan.mask.height > piScan.textBottom,
    "The scan mask must include both the title and English subtitle");
  assert.ok(piScan.textLeft >= 0 && piScan.textRight <= piScan.viewportWidth,
    "Translated status text must fit inside the viewport");
}
