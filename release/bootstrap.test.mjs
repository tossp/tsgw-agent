import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const text = readFileSync(new URL("../.github/workflows/tsgw-npm-bootstrap.yml", import.meta.url), "utf8");
const workflow = load(text);
const steps = workflow.jobs.stage.steps;
const configuration = steps.find((step) => step.id === "configuration");
const accepted = steps.find((step) => step.id === "accepted");
const artifact = steps.find((step) => step.name?.startsWith("Verify artifact identity"));
const stage = steps.find((step) => step.name?.startsWith("Stage once"));
const sha = "0123456789abcdef0123456789abcdef01234567";
const version = "0.1.0-dev.42.2.g0123456789ab";
const source = {
  name: "tsgw-agent", version: "0.1.0", bin: { "tsgw-agent": "bin/pi-web.js" },
  repository: { type: "git", url: "git+https://github.com/tossp/tsgw-agent.git" },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  license: "MIT", engines: { node: ">=22.19.0" },
};
const run = { id: 123, path: ".github/workflows/tsgw-npm.yml", head_branch: "tsgw", head_sha: sha,
  event: "push", run_number: 42, run_attempt: 2, conclusion: "failure" };
const job = { name: "Check, build, pack", head_sha: sha, status: "completed", conclusion: "success" };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tsgw-bootstrap-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "package.json"), JSON.stringify(source));
  return root;
}

function execute(root, script, env = {}) {
  // Deliberately do not inherit credentials or invoke a real gh/npm in these offline tests.
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], { cwd: root, encoding: "utf8", timeout: 10_000,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, GITHUB_OUTPUT: join(root, "output"),
      GITHUB_STEP_SUMMARY: join(root, "summary"), RUNNER_TEMP: root, ...env } });
}

function nodeBody(step) {
  return step.run.match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1];
}

function acceptedResult(root, overrides = {}, build = job, manifest = source) {
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env node
    import assert from "node:assert/strict";
    assert.equal(process.argv[2], "api");
    const endpoint = process.argv[3];
    const base = "repos/tossp/tsgw-agent/actions/runs/123";
    if (endpoint === base) console.log(JSON.stringify(${JSON.stringify({ ...run, ...overrides })}));
    else {
      assert.equal(endpoint, base + "/attempts/2/jobs?per_page=100");
      assert.deepEqual(process.argv.slice(4), ["--paginate", "--slurp"]);
      console.log(JSON.stringify([{ jobs: [${JSON.stringify(build)}] }]));
    }
  `, { mode: 0o700 });
  return execute(root, accepted.run, { BOOTSTRAP_RUN_ID: "123", GITHUB_REPOSITORY: "tossp/tsgw-agent", GITHUB_SHA: sha });
}

test("only bootstrap-path pushes on tsgw trigger; every later step observes the configuration gate", () => {
  assert.deepEqual(workflow.on, { push: { branches: ["tsgw"], paths: [".github/workflows/tsgw-npm-bootstrap.yml"] } });
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read", "id-token": "write" });
  assert.equal(workflow.jobs.stage.environment, "npm");
  assert.equal(steps[0], configuration);
  for (const step of steps.slice(1)) assert.equal(step.if, "steps.configuration.outputs.ready == 'true'");
  assert.equal(configuration.env.BOOTSTRAP_RUN_ID, "${{ vars.TSGW_NPM_BOOTSTRAP_RUN_ID }}");
  assert.equal(configuration.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_STAGE_TOKEN }}");
  assert.doesNotMatch(text, /40170008119|@tossp\/tsgw-agent|tossp-tsgw-agent-/);
  const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["run-id"], "${{ vars.TSGW_NPM_BOOTSTRAP_RUN_ID }}");
  assert.equal(download.with.name, "${{ steps.accepted.outputs.artifact }}");
  assert.equal(download.with["github-token"], "${{ github.token }}");
  assert.equal(accepted.env.GH_TOKEN, "${{ github.token }}");
});

for (const [id, token, ready] of [["", "", false], ["123", "", false], ["", "offline-secret", false], ["123", "offline-secret", true]]) {
  test(`configuration gate: run ${id || "missing"}, token ${token ? "present" : "missing"}`, (t) => {
    const root = fixture(t);
    const result = execute(root, configuration.run, { BOOTSTRAP_RUN_ID: id, NODE_AUTH_TOKEN: token });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "output"), "utf8"), `ready=${ready}\n`);
    assert.ok(!result.stdout.includes("offline-secret"));
    if (!ready) assert.match(readFileSync(join(root, "summary"), "utf8"), /waiting/);
  });
}

test("successful build permits the accepted attempt even when publish failed; derives exact preview identity", (t) => {
  const root = fixture(t);
  const result = acceptedResult(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, "output"), "utf8"), `version=${version}\nartifact=tsgw-npm-${version}\n`);
});

for (const [field, value] of [["path", "other.yml"], ["head_branch", "main"], ["head_sha", "a".repeat(40)],
  ["event", "workflow_dispatch"], ["run_number", 0], ["run_attempt", 0]]) {
  test(`accepted run rejects mismatched ${field}`, (t) => {
    assert.notEqual(acceptedResult(fixture(t), { [field]: value }).status, 0);
  });
}

for (const [name, build, manifest] of [
  ["failed build", { ...job, conclusion: "failure" }, source],
  ["wrong source package", job, { ...source, name: "@tossp/tsgw-agent" }],
  ["wrong source bin", job, { ...source, bin: { other: "bin/pi-web.js" } }],
  ["unstable source version", job, { ...source, version: "0.1.0-dev.1" }],
]) {
  test(`accepted run rejects ${name}`, (t) => {
    assert.notEqual(acceptedResult(fixture(t), {}, build, manifest).status, 0);
  });
}

function artifactResult(root, { manifest = {}, metadata = {}, status = 404, corrupt = false } = {}) {
  const directory = join(root, "tsgw-bootstrap");
  mkdirSync(join(directory, "package"), { recursive: true });
  writeFileSync(join(directory, "package/package.json"), JSON.stringify({ ...source, version, ...manifest }));
  const filename = `tsgw-agent-${version}.tgz`;
  execFileSync("tar", ["-czf", filename, "package/package.json"], { cwd: directory });
  const digest = createHash("sha256").update(readFileSync(join(directory, filename))).digest("hex");
  writeFileSync(join(directory, "SHA256SUMS"), `${corrupt ? "0".repeat(64) : digest}  ${filename}\n`);
  writeFileSync(join(directory, "release.json"), JSON.stringify({ version, tag: "next", filename, ...metadata }));
  const mock = `globalThis.fetch = async (url, options) => {
    if (url !== "https://registry.npmjs.org/tsgw-agent" || options.redirect !== "error") throw Error("unexpected registry request");
    return new Response(null, {status: ${status}});
  };\n`;
  return execute(root, `node --input-type=module <<'NODE'\n${mock}${nodeBody(artifact)}\nNODE`, { VERSION: version });
}

for (const [name, options, success] of [
  ["accepted tarball and registry 404", {}, true],
  ["old scoped tarball", { manifest: { name: "@tossp/tsgw-agent" } }, false],
  ["wrong bin", { manifest: { bin: { other: "bin/pi-web.js" } } }, false],
  ["wrong version", { manifest: { version: "0.1.0" } }, false],
  ["wrong repository", { manifest: { repository: { url: "https://example.invalid" } } }, false],
  ["wrong tag", { metadata: { tag: "latest" } }, false],
  ["wrong filename", { metadata: { filename: "old.tgz" } }, false],
  ["bad checksum", { corrupt: true }, false],
  ["existing package", { status: 200 }, false],
  ["registry failure", { status: 503 }, false],
]) {
  test(`artifact verification: ${name}`, (t) => {
    const result = artifactResult(fixture(t), options);
    assert.equal(result.status === 0, success, result.stderr);
  });
}

test("only stage publish is allowed; npmrc contains a placeholder, is private, and is removed even on failure", (t) => {
  assert.doesNotMatch(text, /\bnpm publish\s+["$]|\b(?:curl|wget)\b|npm login/);
  assert.equal((text.match(/\bnpm stage publish /g) || []).length, 1);
  assert.match(text, /npm install --global npm@11\.21\.1/);
  assert.match(stage.run, /--tag next.*--provenance/);
  assert.doesNotMatch(stage.run, /\bretry\b|\bwhile\b|\bfor\b/);
  assert.equal(stage.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_STAGE_TOKEN }}");
  assert.equal(stage.env.NPM_CONFIG_FETCH_RETRIES, "0");
  const root = fixture(t);
  const config = join(root, "stage.npmrc");
  writeFileSync(join(root, "bin/npm"), `#!/usr/bin/env node
    import assert from "node:assert/strict";
    import {readFileSync, statSync} from "node:fs";
    const config = process.env.NPM_CONFIG_USERCONFIG;
    assert.equal(readFileSync(config, "utf8"), '//registry.npmjs.org/:_authToken=\u0024{NODE_AUTH_TOKEN}\\n');
    assert.equal(statSync(config).mode & 0o777, 0o600);
    if (process.argv[2] === "whoami") console.log("tossp");
    else {
      assert.deepEqual(process.argv.slice(2), ["stage", "publish", process.env.RUNNER_TEMP + "/tsgw-bootstrap/tsgw-agent-" + process.env.VERSION + ".tgz",
        "--access", "public", "--tag", "next", "--registry=https://registry.npmjs.org/", "--provenance"]);
      process.exit(Number(process.env.STAGE_EXIT));
    }
  `, { mode: 0o700 });
  for (const exit of ["0", "7"]) {
    const result = execute(root, stage.run, { VERSION: version, NODE_AUTH_TOKEN: "offline-secret", NPM_CONFIG_USERCONFIG: config, STAGE_EXIT: exit });
    assert.equal(result.status, Number(exit), result.stderr);
    assert.equal(existsSync(config), false);
    assert.ok(!result.stdout.includes("offline-secret"));
  }
  const normal = readFileSync(new URL("../.github/workflows/tsgw-npm.yml", import.meta.url), "utf8");
  assert.doesNotMatch(normal, /NPM_STAGE_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|npm stage/);
});
