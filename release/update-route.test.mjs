import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });

test("web updates reject mismatched registry metadata without caching it", async (t) => {
  const previous = { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION, PI_WEB_SKIP_VERSION_CHECK: process.env.PI_WEB_SKIP_VERSION_CHECK };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.NEXT_PUBLIC_APP_VERSION = "0.1.0";
  process.env.PI_WEB_SKIP_VERSION_CHECK = "0";
  const { GET } = await jiti.import("../app/api/app-update/route.ts");
  globalThis.__piWebAppUpdateCache = undefined;
  t.after(() => { globalThis.__piWebAppUpdateCache = undefined; });
  let body = { name: "@agegr/pi-web", version: "99.0.0" };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(decodeURIComponent(new URL(url).pathname));
    return Response.json(body);
  });
  assert.equal((await GET()).status, 502);
  body = { name: "@tossp/tsgw-agent", version: "0.2.0" };
  assert.equal((await GET()).status, 502);
  body = { name: "tsgw-agent", version: "0.1.0-dev.2.1.g0123456789ab" };
  assert.equal((await GET()).status, 502);
  body = { name: "tsgw-agent", version: "0.2.0" };
  const accepted = await GET();
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), {
    currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true,
    releaseUrl: "https://github.com/tossp/tsgw-agent/tree/v0.2.0",
  });
  assert.equal((await GET()).status, 200);
  assert.deepEqual(requests, Array(4).fill("/tsgw-agent/latest"));
});
