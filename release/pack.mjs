import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getReleaseChannel, isReleaseVersion } from "../bin/tsgw-release.js";

export function verifyPack(manifest, files) {
  assert.equal(manifest.name, "@tossp/tsgw-agent");
  assert.ok(isReleaseVersion(manifest.version), "Invalid package version");
  assert.deepEqual(manifest.bin, { "tsgw-agent": "bin/pi-web.js" });
  assert.equal(manifest.repository.url, "git+https://github.com/tossp/tsgw-agent.git");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.publishConfig.registry, "https://registry.npmjs.org/");
  const paths = new Set(files.map((file) => typeof file === "string" ? file : file.path));
  for (const path of [
    "package.json", "LICENSE", "README.md", "next.config.ts",
    "bin/pi-web.js", "bin/tsgw-release.js", "bin/prepare-terminal.js", ".next/BUILD_ID",
    ".next/server/app/login2/page.js", "docs/login2.md", "docs/tsgw-release.md",
    "public/login2/assets/emblem.webp", "public/login2/assets/pi-reference-license.txt",
    ...["permission", "password", "read", "verified", "welcome"].map((name) => `public/login2/assets/pi-${name}.mp3`),
  ]) assert.ok(paths.has(path), `Missing published file: ${path}`);
  for (const path of paths) {
    assert.doesNotMatch(path, /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.git\/|node_modules\/|test-results\/)/, `Unsafe file: ${path}`);
    assert.doesNotMatch(path, /^\.next\/(?:dev\/|cache\/|server\/route-cache\/)/, `Stale build data: ${path}`);
    assert.doesNotMatch(path, /\.(?:log|js\.map)$/, `Unnecessary published data: ${path}`);
    assert.doesNotMatch(path, /\.(?:pem|key|p12|pfx)$/i, `Private key material: ${path}`);
    assert.doesNotMatch(path, /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|auth\.json|service[-_]account(?:[-_]key)?\.json|\.ssh|\.aws)(?:\/|$)/i, `Credential file: ${path}`);
  }
  return { version: manifest.version, tag: getReleaseChannel(manifest.version), files: paths.size };
}

export function readPackResult(result) {
  // npm 11 returns an array; npm 12 returns an object keyed by package name.
  const entries = Array.isArray(result) ? result : Object.values(result);
  assert.equal(entries.length, 1, "Expected one npm pack result");
  assert.ok(Array.isArray(entries[0].files), "Missing npm pack file list");
  return entries[0];
}

export function packRelease(destination, root = process.cwd()) {
  assert.ok(destination, "Usage: node release/pack.mjs <artifact-directory>");
  const out = resolve(destination);
  mkdirSync(out, { recursive: true });
  assert.deepEqual(readdirSync(out), [], "Use an empty artifact directory; never mix releases");
  assert.ok(existsSync(resolve(root, ".next/BUILD_ID")), "Run a production build in a clean checkout first");
  assert.ok(!existsSync(resolve(root, ".next/dev/lock")), "Never pack a running development checkout");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const npm = (...args) => JSON.parse(execFileSync("npm", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024,
  }));
  const preview = readPackResult(npm("pack", "--dry-run", "--json", "--ignore-scripts"));
  const metadata = verifyPack(manifest, preview.files);
  const packed = readPackResult(npm("pack", "--json", "--ignore-scripts", "--pack-destination", out));
  verifyPack(manifest, packed.files);
  assert.equal(packed.filename, `tossp-tsgw-agent-${manifest.version}.tgz`);
  const tarball = resolve(out, packed.filename);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(resolve(out, "SHA256SUMS"), `${digest}  ${packed.filename}\n`);
  writeFileSync(resolve(out, "release.json"), `${JSON.stringify({ ...metadata, filename: packed.filename }, null, 2)}\n`);
  return { ...metadata, tarball, sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(packRelease(process.argv[2]), null, 2));
}
