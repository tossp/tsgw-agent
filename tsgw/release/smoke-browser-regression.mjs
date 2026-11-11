import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright";
import { createSmokeEnvironment } from "./smoke-environment.mjs";
import { startCatCapture } from "./smoke-cat.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "tsgw-smoke-isolation-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function hasError(cat, channel, message) {
  return cat.receipts.some((receipt) => receipt.channel === channel && receipt.items.some(({ type, payload }) =>
    type === "event" && payload.exception?.values?.some((value) => value.value === message)));
}

test("real browser SDK sends locally fulfilled envelopes and does not hide the uncaught page error", async (t) => {
  const directory = fixture(t);
  const env = createSmokeEnvironment(directory);
  // Only bundle the existing browser initializer as a temporary test fixture.
  // This is not next build, does not write .next, and uses the real Next SDK.
  const { webpack } = require("next/dist/compiled/webpack/webpack");
  const compiler = webpack({
    mode: "development", target: "web", devtool: false,
    context: root, entry: join(root, "tsgw/cat-monitoring/browser-init.ts"),
    output: { path: directory, filename: "browser.js" },
    resolve: { conditionNames: ["browser", "import", "default"], fallback: { fs: false, stream: false, zlib: false } },
    module: { rules: [{ test: /\.m?js$/, resolve: { fullySpecified: false } }] },
    plugins: [
      new webpack.DefinePlugin({ "process.env": JSON.stringify({ NODE_ENV: "production" }), "process.browser": "true" }),
      new webpack.ProvidePlugin({ process: require.resolve("next/dist/build/polyfills/process") }),
    ],
  });
  const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
  await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
  const cat = await startCatCapture(directory);
  t.after(() => cat.close());
  const server = createServer((request, response) => {
    if (request.url === "/api/cat-config") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ dsn: "https://24d86d19be5d513074e45febd5b004b8@cat.tossp.com/10" }));
    } else if (request.url === "/browser.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(readFileSync(join(directory, "browser.js")));
    } else response.end('<!doctype html><script src="/browser.js"></script>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, env,
    args: ["--host-resolver-rules=MAP cat.tossp.com ~NOTFOUND"] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "block" });
  await cat.routeBrowser(context);
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", ({ response }) => {
    if (new URL(response.url).hostname === "cat.tossp.com") external.push(response.remoteIPAddress);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Object.values(window.__SENTRY__ || {}).some((carrier) => carrier?.defaultCurrentScope?.getClient?.()), null, { timeout: 5000 })
    .catch(() => assert.fail(`Browser initializer failed: ${JSON.stringify(errors)}`));
  await page.evaluate(() => { setTimeout(() => { throw new Error("release-browser-original-failure"); }, 0); });
  const deadline = Date.now() + 10000;
  while (!hasError(cat, "browser", "release-browser-original-failure")) {
    assert.ok(Date.now() < deadline, "Real browser SDK must reach local capture");
    await delay(50);
  }
  assert.deepEqual(errors, ["release-browser-original-failure"]);
  assert.ok(external.length > 0, "Observe the real SDK's fulfilled browser response");
  assert.ok(external.every((address) => !address), "Fulfilled CAT requests must have no remote IP");
  cat.assertClean();
});
