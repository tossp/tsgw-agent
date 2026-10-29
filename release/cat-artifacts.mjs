import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const roots = [".next/server", ".next/static"];
const scriptPattern = /\.(?:js|mjs|cjs)$/;
const excluded = (name) => /^(?:node_modules|cache|route-cache|\.env(?:\..*)?)$/.test(name);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pairKey = (file) => `${file.path.split("/")[1]}:${file.debugId}`;

function mapDebugId(bytes, path) {
  const map = JSON.parse(bytes.toString("utf8"));
  if (map.debug_id !== undefined && map.debugId !== undefined) {
    assert.equal(map.debug_id, map.debugId, `Conflicting Debug IDs: ${path}`);
  }
  const id = map.debug_id ?? map.debugId;
  if (id === undefined) return undefined;
  assert.ok(typeof id === "string" && id.trim(), `Invalid Debug ID: ${path}`);
  return id;
}

function scriptDebugId(bytes, path, hasMap) {
  const source = bytes.toString("utf8");
  // Match the SDK's determineDebugIdFromBundleSource and last standard comment.
  const runtimeId = source.match(/sentry-dbid-([0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12})/)?.[1];
  if (!hasMap) return runtimeId; // Next can emit runtime-instrumented chunks without maps.
  const commentId = source.match(/\/\/# debugId=([a-fA-F0-9-]+)(?![\s\S]*\/\/# debugId=)/m)?.[1];
  assert.ok(runtimeId, `Missing or invalid Sentry runtime marker: ${path}`);
  assert.ok(commentId, `Missing or invalid Debug ID comment: ${path}`);
  assert.equal(commentId, runtimeId, `Debug ID mismatch: ${path}`);
  return runtimeId;
}

function validateManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, "Unsupported CAT artifact schema");
  assert.ok(typeof manifest.version === "string" && manifest.version.trim(), "Missing version");
  assert.equal(manifest.release, `tsgw-agent@${manifest.version}`, "Release/version mismatch");
  for (const key of ["commit", "buildId"]) {
    assert.ok(typeof manifest[key] === "string" && manifest[key].trim(), `Missing ${key}`);
  }
  assert.ok(Array.isArray(manifest.files), "Missing files");
  const files = new Map();
  for (const file of manifest.files) {
    const path = file.path;
    assert.ok(typeof path === "string" && roots.some((root) => path.startsWith(`${root}/`))
      && posix.normalize(path) === path && !path.includes("\\")
      && !path.split("/").some((part) => part === ".." || excluded(part))
      && /\.(?:js|mjs|cjs)(?:\.map)?$/.test(path), `Invalid artifact path: ${path}`);
    assert.ok(!files.has(path), `Duplicate artifact path: ${path}`);
    assert.match(file.sha256, /^[a-f0-9]{64}$/, `Invalid SHA256: ${path}`);
    if (file.debugId !== undefined || path.endsWith(".map")) {
      assert.ok(typeof file.debugId === "string" && file.debugId.trim(), `Missing Debug ID: ${path}`);
    }
    files.set(path, file);
  }
  const scriptIds = new Set(manifest.files.filter((file) => !file.path.endsWith(".map")).map(pairKey));
  for (const file of files.values()) {
    if (!file.path.endsWith(".map")) continue;
    // Next renames proxy.js to middleware.js but retains proxy.js.map; IDs, not names, link them.
    assert.ok(scriptIds.has(pairKey(file)), `Missing JS/map pair for Debug ID: ${file.path}`);
  }
  for (const root of roots) {
    assert.ok(manifest.files.some((file) => file.path.startsWith(`${root}/`) && file.path.endsWith(".map")),
      `Missing Debug ID pair in ${root}`);
  }
}

export function verifyCatArtifacts(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  validateManifest(manifest);
  const maps = manifest.files.filter((file) => file.path.endsWith(".map"));
  const mappedIds = new Set(maps.map(pairKey));
  const mapPaths = new Set(maps.map((file) => file.path));
  for (const file of manifest.files) {
    const bytes = readFileSync(resolve(directory, file.path));
    assert.equal(sha256(bytes), file.sha256, `SHA256 mismatch: ${file.path}`);
    if (file.path.endsWith(".map")) {
      assert.equal(mapDebugId(bytes, file.path), file.debugId, `Debug ID mismatch: ${file.path}`);
    } else {
      assert.equal(scriptDebugId(bytes, file.path, mapPaths.has(`${file.path}.map`) || mappedIds.has(pairKey(file))), file.debugId, `Debug ID mismatch: ${file.path}`);
    }
  }
  return manifest;
}

export function packCatArtifacts(destination, root = process.cwd()) {
  assert.ok(destination, "Usage: node release/cat-artifacts.mjs <destination>");
  const out = resolve(destination);
  mkdirSync(out, { recursive: true });
  assert.deepEqual(readdirSync(out), [], "Use an empty artifact directory; never mix releases");
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const manifest = {
    schemaVersion: 1,
    version,
    release: `tsgw-agent@${version}`,
    commit: process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    buildId: readFileSync(resolve(root, ".next/BUILD_ID"), "utf8").trim(),
    files: [],
  };
  // Stage precisely the bytes we hash; neither the build nor its maps are rewritten.
  const stage = mkdtempSync(join(tmpdir(), "cat-artifacts-"));
  try {
    function collect(directory) {
      if (!existsSync(resolve(root, directory))) return;
      const entries = readdirSync(resolve(root, directory), { withFileTypes: true });
      for (const entry of entries) {
        if (excluded(entry.name)) continue;
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          collect(path);
        } else if (entry.isFile() && (scriptPattern.test(entry.name) || /\.(?:js|mjs|cjs)\.map$/.test(entry.name))) {
          const bytes = readFileSync(resolve(root, path));
          const debugId = path.endsWith(".map") ? mapDebugId(bytes, path)
            : scriptDebugId(bytes, path, false);
          mkdirSync(dirname(resolve(stage, path)), { recursive: true });
          writeFileSync(resolve(stage, path), bytes);
          manifest.files.push({ path, sha256: sha256(bytes), ...(debugId === undefined ? {} : { debugId }) });
        }
      }
    }
    for (const directory of roots) collect(directory);
    manifest.files.sort((a, b) => a.path.localeCompare(b.path));
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(resolve(stage, "manifest.json"), json);
    verifyCatArtifacts(stage);
    // A NUL-delimited file list avoids shell quoting and command-line length limits.
    execFileSync("tar", ["-czf", resolve(out, "artifacts.tar.gz"), "-C", stage, "--null", "-T", "-"], {
      input: ["manifest.json", ...manifest.files.map((file) => file.path)].join("\0") + "\0",
    });
    writeFileSync(resolve(out, "manifest.json"), json);
    const sums = ["artifacts.tar.gz", "manifest.json"].map((name) => `${sha256(readFileSync(resolve(out, name)))}  ${name}\n`);
    writeFileSync(resolve(out, "SHA256SUMS"), sums.join(""));
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(packCatArtifacts(process.argv[2]), null, 2));
}
