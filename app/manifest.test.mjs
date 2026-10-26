import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import manifest, { dynamic } from "./manifest.ts";

const readAsset = (path) => readFileSync(new URL(`../public/icons/${path}`, import.meta.url));

test("manifest uses the existing scalable Pi icon", () => {
  assert.deepEqual(manifest().icons, [{
    src: "/icons/pi-blocks.svg",
    sizes: "any",
    type: "image/svg+xml",
    purpose: "any",
  }]);
  assert.match(readAsset("pi-blocks.svg").toString(), /viewBox="0 0 64 64"/);
});

test("Apple Touch Icon uses a separate transparent 180px PNG", () => {
  const png = readAsset("pi-blocks-180.png");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  assert.equal(png[25], 6, "RGBA preserves the SVG's transparent background");

  const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
  const iconMetadata = layout.slice(layout.indexOf("  icons: {"), layout.indexOf("  appleWebApp:"));
  const apple = iconMetadata.slice(iconMetadata.indexOf("    apple:"));
  assert.match(iconMetadata, /url: "\/icons\/pi-blocks\.svg",\s+sizes: "any",\s+type: "image\/svg\+xml"/);
  assert.match(apple, /url: "\/icons\/pi-blocks-180\.png",\s+sizes: "180x180",\s+type: "image\/png"/);
  assert.doesNotMatch(apple, /\.svg/);
});

test("manifest reads the app name at runtime without changing other metadata", () => {
  const original = process.env.PI_WEB_APP_NAME;
  try {
    assert.equal(dynamic, "force-dynamic");
    delete process.env.PI_WEB_APP_NAME;
    const defaults = manifest();
    assert.equal(defaults.name, "Pi Web");
    assert.equal(defaults.short_name, "Pi Web");

    // Reuse the same imported function: the environment must not be captured
    // at module load time (or baked into a statically generated manifest).
    for (const [value, expected] of [
      ["", "Pi Web"],
      [" \t\n ", "Pi Web"],
      ["Work Pi", "Work Pi"],
      ["  工作 Pi 🚀 \n", "工作 Pi 🚀"],
      ["Another Pi", "Another Pi"],
    ]) {
      process.env.PI_WEB_APP_NAME = value;
      assert.deepEqual(manifest(), {
        ...defaults,
        name: expected,
        short_name: expected,
      });
    }
  } finally {
    if (original === undefined) delete process.env.PI_WEB_APP_NAME;
    else process.env.PI_WEB_APP_NAME = original;
  }
});
