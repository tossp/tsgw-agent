import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const { GET, dynamic } = await createJiti(import.meta.url).import("./manifest.webmanifest/route.ts");

const readAsset = (path) => readFileSync(new URL(`../public/icons/${path}`, import.meta.url));

test("manifest uses the existing scalable Pi icon", async () => {
  const manifest = await GET().json();
  assert.deepEqual(manifest.icons, [{
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

test("manifest route reads the app name at runtime without changing other metadata", async () => {
  const original = process.env.PI_WEB_APP_NAME;
  const getManifest = async () => {
    const response = GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/manifest+json");
    return response.json();
  };

  try {
    assert.equal(dynamic, "force-dynamic");
    delete process.env.PI_WEB_APP_NAME;
    const defaults = await getManifest();
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
      const expectedManifest = {
        ...defaults,
        name: expected,
        short_name: expected,
      };
      assert.deepEqual(await getManifest(), expectedManifest);
    }
  } finally {
    if (original === undefined) delete process.env.PI_WEB_APP_NAME;
    else process.env.PI_WEB_APP_NAME = original;
  }
});
