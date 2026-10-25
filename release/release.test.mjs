import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveRelease, prepareVersion } from "./version.mjs";
import { readPackResult, verifyPack } from "./pack.mjs";
import { createTerminalOutput } from "./terminal-output.mjs";

const require = createRequire(import.meta.url);
const manifest = require("../package.json");
const lock = require("../package-lock.json");
const release = require("../bin/tsgw-release.js");
const { getInstallKind, runUpdate } = require("../bin/pi-web-update.js");
const records = require("../bin/run-records.js");
const sha = "0123456789abcdef0123456789abcdef01234567";
const input = { base: "0.1.0", ref: "refs/heads/tsgw", sha, run: "42", attempt: "1" };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "tsgw-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const files = [
  "package.json", "LICENSE", "README.md", "next.config.ts", "bin/pi-web.js",
  "bin/tsgw-release.js", "bin/prepare-terminal.js", ".next/BUILD_ID", ".next/server/app/login2/page.js",
  "docs/login2.md", "docs/tsgw-release.md", "public/login2/assets/emblem.webp",
  "public/login2/assets/pi-reference-license.txt",
  ...["permission", "password", "read", "verified", "welcome"].map((name) => `public/login2/assets/pi-${name}.mp3`),
];

test("fork identity, lockfile and CLI name are persisted in project source", () => {
  assert.equal(manifest.name, "tsgw-agent");
  assert.equal(manifest.repository.url, "git+https://github.com/tossp/tsgw-agent.git");
  assert.deepEqual(manifest.bin, { "tsgw-agent": "bin/pi-web.js" });
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].bin, manifest.bin);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
});

test("tsgw pushes derive unique next versions without changing latest", () => {
  assert.deepEqual(deriveRelease(input), { version: "0.1.0-dev.42.1.g0123456789ab", tag: "next" });
  assert.equal(deriveRelease({ ...input, attempt: "2" }).version, "0.1.0-dev.42.2.g0123456789ab");
  assert.equal(deriveRelease({ ...input, run: "43" }).version, "0.1.0-dev.43.1.g0123456789ab");
});

test("stable releases require a matching stable tag on the tsgw history", () => {
  assert.deepEqual(deriveRelease({ ...input, ref: "refs/tags/v0.1.0", onBranch: true }), { version: "0.1.0", tag: "latest" });
  for (const override of [
    { ref: "refs/heads/main" }, { ref: "refs/tags/v9.0.0", onBranch: true },
    { ref: "refs/tags/v0.1.0", onBranch: false }, { base: "0.1.0-beta.1" },
    { ref: "refs/tags/v0.1.0-rc.1", onBranch: true }, { run: "0" }, { attempt: "" }, { sha: "invalid" },
  ]) assert.throws(() => deriveRelease({ ...input, ...override }));
});

test("version preparation changes only release versions and verifies the actual git ancestry", (t) => {
  const root = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const source = { name: manifest.name, version: "0.1.0", bin: manifest.bin };
  const sourceLock = { name: source.name, version: source.version, packages: { "": { ...source } } };
  const reset = () => {
    writeFileSync(join(root, "package.json"), `${JSON.stringify(source, null, 2)}\n`);
    writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(sourceLock, null, 2)}\n`);
  };
  reset();
  git("init", "--initial-branch=tsgw");
  git("add", "package.json", "package-lock.json");
  git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/tsgw", "HEAD");
  const env = { GITHUB_REPOSITORY: "tossp/tsgw-agent", GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_REF: "refs/heads/tsgw", GITHUB_RUN_NUMBER: "9", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: join(root, "outputs") };
  const preview = prepareVersion(root, env);
  assert.equal(preview.tag, "next");
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /tag=next/);
  const actual = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(actual, { ...source, version: preview.version });
  const actualLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.deepEqual(actualLock, { ...sourceLock, version: preview.version, packages: { "": actual } });
  reset();
  assert.deepEqual(prepareVersion(root, { ...env, GITHUB_REF: "refs/tags/v0.1.0" }), { version: "0.1.0", tag: "latest" });
  assert.throws(() => prepareVersion(root, { ...env, GITHUB_REPOSITORY: "other/fork" }));
  assert.throws(() => prepareVersion(root, { ...env, GITHUB_SHA: sha }));
  git("checkout", "--orphan", "unrelated");
  git("-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-m", "unrelated");
  assert.throws(() => prepareVersion(root, { ...env, GITHUB_REF: "refs/tags/v0.1.0", GITHUB_SHA: git("rev-parse", "HEAD") }));
});

test("installed web and CLI updates stay on their own package and channel", () => {
  assert.equal(release.PACKAGE_NAME, manifest.name);
  assert.equal(release.COMMAND_NAME, "tsgw-agent");
  assert.equal(release.getReleaseChannel("0.1.0"), "latest");
  const preview = deriveRelease(input).version;
  assert.equal(release.getReleaseChannel(preview), "next");
  for (const [version, tag] of [["0.1.0", "latest"], [preview, "next"]]) {
    const url = new URL(release.getNpmLatestUrl(version));
    assert.equal(decodeURIComponent(url.pathname), `/tsgw-agent/${tag}`);
  }
  assert.equal(release.isNewerReleaseVersion("0.1.1", "0.1.0"), true);
  assert.equal(release.isNewerReleaseVersion("0.1.0-dev.43.1.g0123456789ab", preview), true);
  assert.equal(release.isNewerReleaseVersion("0.1.1", preview), false);
  assert.equal(release.isNewerReleaseVersion(preview, "0.1.0"), false);
  assert.equal(release.isNewerReleaseVersion("garbage", preview), false);
  assert.equal(release.getReleaseUrl("0.1.0"), "https://github.com/tossp/tsgw-agent/tree/v0.1.0");
  assert.equal(release.getReleaseUrl(preview), "https://github.com/tossp/tsgw-agent/tree/tsgw");
  assert.equal(release.getReleaseUrl("invalid"), null);
});

test("preview CLI checks next and refuses to install a stable or upstream package", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(decodeURIComponent(new URL(url).pathname));
    return Response.json({ name: manifest.name, version: "0.1.0-dev.43.1.g0123456789ab" });
  });
  const logs = [];
  const base = { currentVersion: deriveRelease(input).version, check: true, pkgDir: "/fixture",
    listRecords: () => [], formatRecord: () => "", log: (message) => logs.push(message), error: () => {} };
  assert.equal(await runUpdate(base), 0);
  assert.deepEqual(requests, ["/tsgw-agent/next"]);
  assert.match(logs[0], /^tsgw-agent .* is available/);
  let installed = false;
  await runUpdate({ ...base, check: false, fetchLatest: async () => "0.2.0", install: () => { installed = true; } });
  assert.equal(installed, false);
  assert.equal(getInstallKind({ pkgDir: "/npm/@agegr/pi-web", npmRoot: "/npm", realpath: (path) => path }), "other");
  assert.equal(getInstallKind({ pkgDir: "/npm/tsgw-agent", npmRoot: "/npm", realpath: (path) => path }), "global");
  assert.equal(getInstallKind({ pkgDir: "/npm/@tossp/tsgw-agent", npmRoot: "/npm", realpath: (path) => path }), "other");
  assert.equal(records.isRecordProcess(1, "launcher", { readCommand: () => "node /npm/bin/tsgw-agent" }), true);
});

test("update metadata rejects a different package, invalid versions and cross-channel responses", async (t) => {
  assert.equal(release.readReleaseVersion({ name: manifest.name, version: "0.2.0" }, "0.1.0"), "0.2.0");
  for (const metadata of [
    { name: "@agegr/pi-web", version: "99.0.0" }, { version: "0.2.0" },
    { name: "@tossp/tsgw-agent", version: "0.2.0" },
    { name: manifest.name, version: deriveRelease(input).version }, { name: manifest.name, version: "invalid" },
  ]) assert.throws(() => release.readReleaseVersion(metadata, "0.1.0"));
  t.mock.method(globalThis, "fetch", async () => Response.json({ name: "@agegr/pi-web", version: "99.0.0" }));
  const errors = [];
  let installed = false;
  const result = await runUpdate({ currentVersion: "0.1.0", pkgDir: "/npm/tsgw-agent",
    getNpmRoot: () => "/npm", listRecords: () => [], formatRecord: () => "", log: () => {}, error: (message) => errors.push(message),
    install: () => { installed = true; },
  });
  assert.equal(result, 1);
  assert.equal(installed, false);
  assert.match(errors[0], /unexpected package/);
});

test("terminal smoke reconstructs split SSE messages and PTY output without matching input echo", () => {
  const read = createTerminalOutput();
  const events = [
    ":\n\n",
    `data: ${JSON.stringify({ type: "output", data: "printf '%s%s\\n' 'TSGW_' 'SMOKE_OK'" })}\n\n`,
    `data: ${JSON.stringify({ type: "output", data: "TSGW_" })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "output", data: "SMOKE_OK" })}\n\n`,
  ];
  assert.equal(read(events[0] + events[1]).includes("TSGW_SMOKE_OK"), false);
  let output;
  for (const character of events.slice(2).join("")) output = read(character);
  assert.equal(output.includes("TSGW_SMOKE_OK"), true);
});

test("npm pack JSON accepts both npm 11 arrays and npm 12 keyed objects", () => {
  const result = { name: manifest.name, files: [] };
  assert.deepEqual(readPackResult([result]), result);
  assert.deepEqual(readPackResult({ [manifest.name]: result }), result);
  assert.throws(() => readPackResult([]));
  assert.throws(() => readPackResult({ first: result, second: result }));
});

test("packing requires login2 routes, generated assets and license without dev data", () => {
  assert.equal(verifyPack(manifest, files).tag, "latest");
  for (const path of [".env.local", ".npmrc", "public/.env", ".git/config", ".next/dev/server.js", ".next/cache/cache", ".next/server/route-cache/foo", ".next/server/chunks/page.js.map", ".next/build.log", "public/private.key", "public/id_rsa", "public/credentials.json", "public/service-account.json", "bin/.aws/config", "public/cert.p12"]) {
    assert.throws(() => verifyPack(manifest, [...files, path]), undefined, path);
  }
  assert.throws(() => verifyPack(manifest, files.filter((file) => !file.endsWith("pi-password.mp3"))));
  assert.throws(() => verifyPack({ ...manifest, name: "@agegr/pi-web" }, files));
  assert.throws(() => verifyPack({ ...manifest, name: "@tossp/tsgw-agent" }, files));
});
