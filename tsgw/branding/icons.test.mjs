import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { piMetadataIcons, piManifestIcons, PI_ICON_URL } = await jiti.import("./index.ts");
const { GET } = await jiti.import("../../app/manifest.webmanifest/route.ts");
const { FAVICON_BASE_ICON_URL } = await jiti.import("../../lib/favicon-badge.ts");
const readAsset = (name) => readFileSync(new URL(`../../public/icons/${name}`, import.meta.url));

test("manifest and favicon badge use the same scalable Pi icon", async () => {
  assert.deepEqual((await GET().json()).icons, piManifestIcons);
  assert.deepEqual(piManifestIcons, [{
    src: "/icons/pi-blocks.svg", sizes: "any", type: "image/svg+xml", purpose: "any",
  }]);
  assert.equal(FAVICON_BASE_ICON_URL, PI_ICON_URL);
  assert.equal(PI_ICON_URL, "/icons/pi-blocks.svg");
  assert.match(readAsset("pi-blocks.svg").toString(), /viewBox="0 0 64 64"/);
});

test("Apple Touch Icon uses a separate transparent 180px PNG", () => {
  const png = readAsset("pi-blocks-180.png");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  assert.equal(png[25], 6, "RGBA preserves the SVG's transparent background");
  assert.deepEqual(piMetadataIcons, {
    icon: [{ url: "/icons/pi-blocks.svg", sizes: "any", type: "image/svg+xml" }],
    apple: [{ url: "/icons/pi-blocks-180.png", sizes: "180x180", type: "image/png" }],
  });
  const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /icons: piMetadataIcons,/);
});
