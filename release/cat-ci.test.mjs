import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const { version: sourceVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const configHref = new URL("../next.config.ts", import.meta.url).href;
const workflowText = readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8");
const workflow = load(workflowText);
const tsgwOnly = "github.ref == 'refs/heads/tsgw'";
const build = workflow.jobs.build.steps.find((step) => step.name === "Build");
const cat = workflow.jobs["cat-upload"];

// Drive the real SDK's webpack wrapper; no token, upload or network is needed.
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
const run = async (isServer, dev = false) => {
  const out = await config.webpack(stubConfig(), { dev, isServer, nextRuntime: "nodejs", buildId: "cat-ci-test", dir: process.cwd(), config, webpack: webpackStub });
  return { devtool: out.devtool ?? null, plugins: out.plugins.map((plugin) => plugin._name ?? plugin.constructor?.name) };
};
console.log(JSON.stringify({
  release: config.env._sentryRelease,
  appVersion: config.env.NEXT_PUBLIC_APP_VERSION,
  server: await run(true),
  client: await run(false),
  dev: await run(false, true),
}));
`;

const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("SENTRY_") && key !== "CAT_DEFER_UPLOAD"));

function readBuildConfig(env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: repositoryRoot, input: probe, encoding: "utf8", timeout: 120_000,
    env: { ...baseEnv, ...env },
  });
  if (result.status !== 0) return { ...result, config: undefined };
  return { ...result, config: JSON.parse(result.stdout.trim().split("\n").at(-1)) };
}

const previewVersion = `${sourceVersion}-dev.42.2.g0123456789ab`;

test("release triggers and the npm publish dependency remain unchanged", () => {
  assert.deepEqual(workflow.on.push.branches, ["tsgw"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  assert.match(workflow.jobs.build.if, /github\.repository == 'tossp\/tsgw-agent'/);
  assert.match(workflow.jobs.build.if, /github\.ref == 'refs\/heads\/tsgw'/);
  assert.match(workflow.jobs.build.if, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.equal(workflow.jobs.publish.needs, "build", "npm does not wait for CAT");
  assert.equal(workflow.jobs.publish.environment, "npm");
  assert.equal(workflow.jobs.build.environment, undefined);
});

test("only tsgw generates deferred maps; the build never receives a CAT token or contacts CAT", () => {
  for (const value of [build.env.SENTRY_RELEASE, build.env.CAT_DEFER_UPLOAD]) {
    assert.ok(value.includes(tsgwOnly));
    assert.match(value, /\|\|\s*''\s*\}\}$/);
  }
  assert.match(build.env.SENTRY_RELEASE, /format\('tsgw-agent@\{0\}', steps\.version\.outputs\.version\)/);
  assert.equal(build.env.SENTRY_AUTH_TOKEN, undefined);
  assert.equal(workflow.jobs.build.env?.SENTRY_AUTH_TOKEN, undefined);
  assert.ok(!workflow.jobs.build.steps.some((step) => /cat\.tossp\.com/.test(step.run ?? "")));
  assert.equal(cat.if, tsgwOnly);
  assert.equal(cat.needs, "build");
  assert.equal(cat["continue-on-error"], undefined, "a failed backfill stays visible and independently retryable");
  const upload = cat.steps.find((step) => step.name === "Upload the original artifacts to CAT");
  assert.equal(upload.env.SENTRY_AUTH_TOKEN, "${{ secrets.SENTRY_AUTH_TOKEN }}");
  assert.equal(upload.env.NODE_ENV, "production");
  assert.equal(workflowText.match(/SENTRY_AUTH_TOKEN/g).length, 2);
  assert.doesNotMatch(cat.steps.map((step) => step.run ?? "").join("\n"), /npm run build|release\/version\.mjs|npm publish/);
});

test("the original maps are archived to S3 before packing; CI never uses rclone", () => {
  const steps = workflow.jobs.build.steps;
  const archive = steps.find((step) => step.name === "Archive CAT build artifacts");
  const store = steps.find((step) => step.name === "Store CAT build artifacts on S3");
  const pack = steps.find((step) => step.name === "Pack");
  const remove = steps.find((step) => step.name === "Remove archived maps from the npm build");
  assert.equal(remove.if, tsgwOnly);
  assert.match(remove.run, /find \.next -type f -name '\*\.map' -delete/);
  assert.equal(archive.if, tsgwOnly);
  assert.equal(store.if, tsgwOnly);
  assert.ok(steps.indexOf(build) < steps.indexOf(archive));
  assert.ok(steps.indexOf(archive) < steps.indexOf(store));
  assert.ok(steps.indexOf(store) < steps.indexOf(remove), "never remove maps before S3 persistence succeeds");
  assert.ok(steps.indexOf(remove) < steps.indexOf(pack));
  const restore = cat.steps.find((step) => step.name === "Restore CAT build artifacts from S3");
  for (const step of [store, restore]) {
    assert.equal(step.env.AWS_ACCESS_KEY_ID, "${{ secrets.CAT_S3_ACCESS_KEY_ID }}");
    assert.equal(step.env.AWS_SECRET_ACCESS_KEY, "${{ secrets.CAT_S3_SECRET_ACCESS_KEY }}");
    assert.equal(step.env.AWS_DEFAULT_REGION, "us-north-1");
    assert.match(step.run, /aws --endpoint-url https:\/\/s3\.us-north-1\.qiniucs\.com s3 cp/);
    assert.match(step.run, /s3:\/\/tsoht\/tsgw-agent\/cat\/\$VERSION\//);
  }
  assert.match(restore.run, /sha256sum -c SHA256SUMS/);
  assert.doesNotMatch(workflowText, /\brclone\b/i);
});

test("only the independent backfill job routes CAT through mctx, with normal TLS", () => {
  const route = cat.steps.find((step) => step.name === "Route CAT uploads through mctx");
  const upload = cat.steps.find((step) => step.name === "Upload the original artifacts to CAT");
  assert.ok(cat.steps.indexOf(route) < cat.steps.indexOf(upload));
  assert.match(route.run, /1\.13\.102\.6 cat\.tossp\.com/);
  assert.match(route.run, /sudo tee -a \/etc\/hosts/);
  assert.match(route.run, /test "\$remote_ip" = "1\.13\.102\.6"/);
  assert.doesNotMatch(route.run, /--insecure|SENTRY_AUTH_TOKEN/);
});

test("ordinary local and tag builds still generate no maps without a token", () => {
  const { status, stderr, config } = readBuildConfig({ SENTRY_AUTH_TOKEN: "" });
  assert.equal(status, 0, stderr);
  assert.equal(config.release, `tsgw-agent@${sourceVersion}`);
  assert.equal(config.appVersion, sourceVersion);
  assert.equal(config.server.devtool, null);
  assert.equal(config.client.devtool, null);
});

test("deferred preview builds generate server/client maps without an upload token", () => {
  const { status, stderr, config } = readBuildConfig({
    CAT_DEFER_UPLOAD: "1", SENTRY_RELEASE: `tsgw-agent@${previewVersion}`, SENTRY_AUTH_TOKEN: "",
  });
  assert.equal(status, 0, stderr);
  assert.equal(config.release, `tsgw-agent@${previewVersion}`);
  assert.equal(config.appVersion, sourceVersion);
  assert.equal(config.server.devtool, "source-map");
  assert.equal(config.client.devtool, "hidden-source-map");
  assert.ok(config.server.plugins.includes("sentry-webpack-plugin"));
  assert.ok(config.client.plugins.includes("sentry-webpack-plugin"));
  assert.equal(config.dev.devtool, null, "deferred production maps do not change dev mode");
});

test("explicit local uploads retain the previous SDK map settings", () => {
  const { status, stderr, config } = readBuildConfig({ SENTRY_AUTH_TOKEN: "offline-test-token" });
  assert.equal(status, 0, stderr);
  assert.equal(config.server.devtool, "source-map");
  assert.equal(config.client.devtool, "hidden-source-map");
});
