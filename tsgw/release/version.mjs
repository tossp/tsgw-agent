import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

export function deriveRelease({ base, ref, sha, run, attempt, onBranch }) {
  assert.ok(semver.valid(base) === base && !semver.prerelease(base), "Source version must be stable SemVer");
  assert.match(sha, /^[a-f0-9]{40}$/, "Expected the full commit SHA");
  if (ref === "refs/heads/tsgw") {
    assert.match(run ?? "", /^[1-9][0-9]*$/, "Missing workflow run number");
    assert.match(attempt ?? "", /^[1-9][0-9]*$/, "Missing workflow run attempt");
    return { version: `${base}-dev.${run}.${attempt}.g${sha.slice(0, 12)}`, tag: "next" };
  }
  assert.equal(ref, `refs/tags/v${base}`, "Stable tag must equal the committed package version");
  assert.equal(onBranch, true, "Stable tag commit must belong to origin/tsgw history");
  return { version: base, tag: "latest" };
}

export function prepareVersion(root = process.cwd(), env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, "tossp/tsgw-agent", "Releases are restricted to the fork");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  assert.equal(manifest.name, "tsgw-agent");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git("rev-parse", "HEAD"), env.GITHUB_SHA, "Checkout must match the event commit");
  let onBranch = false;
  if (env.GITHUB_REF?.startsWith("refs/tags/")) {
    // A missing remote ref, unrelated tag or Git failure must block publishing.
    git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/tsgw");
    onBranch = true;
  }
  const release = deriveRelease({
    base: manifest.version, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
    run: env.GITHUB_RUN_NUMBER, attempt: env.GITHUB_RUN_ATTEMPT, onBranch,
  });
  // All identity/config changes live in source. Only an immutable preview
  // version is assigned to this clean CI checkout; never write back to Git.
  manifest.version = release.version;
  lock.version = release.version;
  lock.packages[""].version = release.version;
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(prepareVersion()));
}
