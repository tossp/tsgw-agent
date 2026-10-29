import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const { version: sourceVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const configHref = new URL("../next.config.ts", import.meta.url).href;
const workflow = load(readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8"));
const workflowText = readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8");

const tsgwOnly = "github.ref == 'refs/heads/tsgw'";
const build = workflow.jobs.build.steps.find((step) => step.name === "Build");

// The real next.config.ts is loaded in a child process: its Sentry options only reach
// the SDK, so the test drives the SDK's own webpack wrapper and reads back what the
// build would do (release name, source map generation). No upload, token or network.
const probe = String.raw`
const config = (await import(${JSON.stringify(configHref)})).default;
const webpackStub = {
  version: "5.99.0",
  DefinePlugin: class DefinePlugin { constructor(definitions) { this.definitions = definitions; } },
  NormalModuleReplacementPlugin: class NormalModuleReplacementPlugin {},
  sources: { ReplaceSource: class ReplaceSource { insert() {} } },
  Compilation: { PROCESS_ASSETS_STAGE_ADDITIONS: 100, PROCESS_ASSETS_STAGE_DEV_TOOLING: 500 },
};
const stubConfig = () => ({ module: { rules: [] }, plugins: [], resolve: { modules: ["node_modules"] }, output: {}, optimization: {}, entry: async () => ({}) });
const buildContext = (isServer) => ({ dev: false, isServer, nextRuntime: "nodejs", buildId: "cat-ci-test", dir: process.cwd(), config, webpack: webpackStub });
const run = async (isServer) => {
  const out = await config.webpack(stubConfig(), buildContext(isServer));
  return { devtool: out.devtool ?? null, plugins: out.plugins.map((plugin) => plugin._name ?? plugin.constructor?.name) };
};
console.log(JSON.stringify({
  release: config.env._sentryRelease,
  appVersion: config.env.NEXT_PUBLIC_APP_VERSION,
  server: await run(true),
  client: await run(false),
}));
`;

// Never inherit a developer's own SENTRY_* values: each case decides them itself.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SENTRY_")));

function readBuildConfig(env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: repositoryRoot, input: probe, encoding: "utf8", timeout: 120_000,
    env: { ...baseEnv, ...env },
  });
  if (result.status !== 0) return { ...result, config: undefined };
  return { ...result, config: JSON.parse(result.stdout.trim().split("\n").at(-1)) };
}

const previewVersion = `${sourceVersion}-dev.42.2.g0123456789ab`;

test("the release workflow still runs only for the tsgw branch and v* tags", () => {
  assert.deepEqual(workflow.on.push.branches, ["tsgw"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.deepEqual(Object.keys(workflow.on), ["push"], "no manual or extra trigger entry");
  assert.match(workflow.jobs.build.if, /github\.repository == 'tossp\/tsgw-agent'/);
  assert.match(workflow.jobs.build.if, /github\.ref == 'refs\/heads\/tsgw'/);
  assert.match(workflow.jobs.build.if, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

test("only the tsgw branch build receives the CAT release and upload token", () => {
  assert.ok(build, "the build job still has one Build step");
  const release = build.env.SENTRY_RELEASE;
  const token = build.env.SENTRY_AUTH_TOKEN;

  // Both values share the tsgw gate: a v* tag build gets an empty string, never a value.
  for (const value of [release, token]) {
    assert.ok(value.includes(tsgwOnly), `${value} is gated on the tsgw branch`);
    assert.match(value, /\|\|\s*''\s*\}\}$/, `${value} falls back to an empty value`);
  }
  assert.match(release, /format\('tsgw-agent@\{0\}', steps\.version\.outputs\.version\)/);
  assert.match(token, /secrets\.SENTRY_AUTH_TOKEN/);

  // The credential exists exactly once in the workflow, on that step.
  assert.equal(workflowText.match(/SENTRY_AUTH_TOKEN/g).length, 2, "one env key and one secret reference");
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (jobName === "build" && step.name === "Build") continue;
      assert.equal(step.env?.SENTRY_RELEASE, undefined, `${jobName}/${step.name} must not set SENTRY_RELEASE`);
      assert.equal(step.env?.SENTRY_AUTH_TOKEN, undefined, `${jobName}/${step.name} must not set SENTRY_AUTH_TOKEN`);
    }
    assert.equal(job.env?.SENTRY_RELEASE ?? undefined, undefined, `${jobName} must not set SENTRY_RELEASE`);
  }
  // Only the publish job declares the npm environment; the build job stays repo-level secrets only.
  assert.equal(workflow.jobs.build.environment, undefined);
  assert.equal(workflow.jobs.publish.environment, "npm");
});

test("a build without an upload token resolves the source version and uploads nothing", () => {
  const { status, stderr, config } = readBuildConfig({ SENTRY_AUTH_TOKEN: "" });
  assert.equal(status, 0, stderr);
  assert.equal(config.release, `tsgw-agent@${sourceVersion}`);
  assert.equal(config.appVersion, sourceVersion);
  // No source map generation means no upload: the SDK turns upload off with the token.
  assert.equal(config.server.devtool, null);
  assert.equal(config.client.devtool, null);
  assert.ok(config.server.plugins.includes("sentry-webpack-plugin"));
});

test("the tsgw CI release and token enable source map generation for upload", () => {
  const { status, stderr, config } = readBuildConfig({
    SENTRY_RELEASE: `tsgw-agent@${previewVersion}`,
    SENTRY_AUTH_TOKEN: "offline-test-token",
  });
  assert.equal(status, 0, stderr);
  assert.equal(config.release, `tsgw-agent@${previewVersion}`);
  // The app version still comes from package.json; CI only labels the build for CAT.
  assert.equal(config.appVersion, sourceVersion);
  assert.equal(config.server.devtool, "source-map");
  assert.equal(config.client.devtool, "hidden-source-map");
});
