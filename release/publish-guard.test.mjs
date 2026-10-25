import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const workflow = load(readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8"));
const step = workflow.jobs.publish.steps.find((item) => item.name === "Confirm the registry allows this publish");
const code = step.run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];

// Execute the actual CI guard with fetch mocked, without credentials, network
// access, npm commands or any publication side effects.
const scenarios = [
  { name: "first stable release after staged initialization", latest: "0.0.0-stage", ok: true },
  { name: "no package yet", packageStatus: 404, ok: true },
  { name: "no latest tag yet", ok: true },
  { name: "upgrade an older stable release", latest: "0.0.9", ok: true },
  { name: "do not downgrade an existing stable release", latest: "0.2.0", ok: false },
  { name: "reject malformed latest", latest: "unknown", ok: false },
  { name: "reject other prerelease latest", latest: "0.2.0-beta.1", ok: false },
  { name: "reject a similar but different placeholder", latest: "0.0.0-stage.2", ok: false },
  { name: "reject an existing exact version", exactStatus: 200, ok: false, reads: 1 },
  { name: "reject unauthorized exact-version lookup", exactStatus: 403, ok: false, reads: 1 },
  { name: "reject rate-limited exact-version lookup", exactStatus: 429, ok: false, reads: 1 },
  { name: "reject failed exact-version lookup", exactStatus: 503, ok: false, reads: 1 },
  { name: "reject failed package lookup", packageStatus: 503, ok: false },
  { name: "reject a failed network request", networkError: true, ok: false, reads: 1 },
  { name: "preview never reads or changes latest", tag: "next", latest: "99.0.0", ok: true, reads: 1 },
  { name: "preview cannot republish an existing version", tag: "next", exactStatus: 200, ok: false, reads: 1 },
];

for (const scenario of scenarios) {
  test(`publish preflight: ${scenario.name}`, () => {
    const tag = scenario.tag ?? "latest";
    const version = tag === "next" ? "0.1.0-dev.4.1.g0123456789ab" : "0.1.0";
    const mock = `
      import assert from "node:assert/strict";
      const scenario = ${JSON.stringify(scenario)};
      const fixtureBase = "https://registry.npmjs.org/tsgw-agent";
      let reads = 0;
      process.on("exit", () => console.log("reads=" + reads));
      globalThis.fetch = async (url, options) => {
        reads++;
        assert.equal(options.method, undefined, "Only read-only GET requests are allowed");
        assert.equal(options.headers.Authorization, undefined);
        assert.ok(options.signal instanceof AbortSignal);
        if (scenario.networkError) throw new Error("offline test network failure");
        if (reads === 1) {
          assert.equal(url, fixtureBase + "/" + process.env.PKG_VERSION);
          return Response.json({}, { status: scenario.exactStatus ?? 404 });
        }
        assert.equal(reads, 2, "No retry or extra registry requests");
        assert.equal(url, fixtureBase);
        return Response.json({ name: "tsgw-agent", "dist-tags": { latest: scenario.latest } },
          { status: scenario.packageStatus ?? 200 });
      };
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
      input: mock + code, encoding: "utf8", timeout: 5_000,
      env: { PKG_NAME: "tsgw-agent", PKG_VERSION: version, DIST_TAG: tag },
    });
    assert.equal(result.status, scenario.ok ? 0 : 1, result.stderr);
    assert.match(result.stdout, new RegExp(`reads=${scenario.reads ?? 2}(?:\\n|$)`));
    if (!scenario.ok) assert.match(result.stderr, /::error::/);
    if (tag === "next" && scenario.ok) assert.match(result.stdout, /latest is never touched/);
  });
}
