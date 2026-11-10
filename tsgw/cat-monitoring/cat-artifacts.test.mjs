import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packCatArtifacts, verifyCatArtifacts } from "./cat-artifacts.mjs";

const cli = fileURLToPath(new URL("./cat-artifacts.mjs", import.meta.url));
const version = "0.1.0-dev.42.1.g0123456789ab";
const server = ".next/server/app/page.js", client = ".next/static/chunks/client.mjs", common = ".next/server/chunks/common.cjs";
const serverId = "11111111-1111-4111-8111-111111111111", clientId = "22222222-2222-4222-8222-222222222222";
const unmapped = ".next/server/chunks/1174.js", unmappedId = "b2f412a2-dc25-46e5-8612-7830b701ff41";
// Captured from a real Next build: runtime marker, no map and no debugId comment.
const nextChunk = '"use strict";!function(){try{var a="u">typeof globalThis?globalThis:"u">typeof window?window:"u">typeof global?global:"u">typeof self?self:{},b=(new a.Error).stack;b&&(a._sentryDebugIds=a._sentryDebugIds||{},a._sentryDebugIds[b]="b2f412a2-dc25-46e5-8612-7830b701ff41",a._sentryDebugIdIdentifier="sentry-dbid-b2f412a2-dc25-46e5-8612-7830b701ff41")}catch(a){}}(),exports.id=1174,exports.ids=[1174],exports.modules={18793:(a,b,c)=>{c.d(b,{createWardleyServices:()=>d.J});var d=c(96381);c(12844)}};';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function pair(root, path, id, key = "debug_id") {
  put(root, path, `try { const stack = new Error().stack; globalThis._sentryDebugIds = { [stack]: "${id}" }; globalThis._sentryDebugIdIdentifier = "sentry-dbid-${id}"; } catch {}\nconsole.log('fixture');\n//# debugId=${id}\n`);
  put(root, `${path}.map`, `{\r\n  "version": 3, "${key}": "${id}",\r\n  "sources": ["source.ts"], "sourcesContent": ["// 原始源码\\n"], "mappings": ""\r\n}\r\n`);
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "cat-artifacts-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "build"), out = join(base, "archive"), extracted = join(base, "extracted");
  put(root, "package.json", JSON.stringify({ version }));
  put(root, ".next/BUILD_ID", "fixture-build-id\n");
  pair(root, server, serverId); pair(root, client, clientId, "debugId"); pair(root, common, serverId);
  put(root, unmapped, nextChunk);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("add", "package.json");
  git("-c", "user.name=CAT Test", "-c", "user.email=cat-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const unpack = () => {
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", join(out, "artifacts.tar.gz"), "-C", extracted]);
    return verifyCatArtifacts(extracted);
  };
  return { root, out, extracted, commit: git("rev-parse", "HEAD"), unpack };
}
function rewriteManifest(directory, change) {
  const path = join(directory, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest); writeFileSync(path, JSON.stringify(manifest));
}

test("CLI archives all JS and generated maps byte-for-byte, including real mapless Next chunks", (t) => {
  const f = fixture(t);
  for (const path of [".env", ".next/cache/ignored.js", "node_modules/ignored.js", ".next/server/cache/ignored.js",
    ".next/server/node_modules/ignored.js", ".next/server/.env.local/ignored.js"]) pair(f.root, path, serverId);
  const plain = [".next/server/manifest.js", ".next/static/plain.mjs", ".next/static/plain.cjs"];
  for (const path of plain) put(f.root, path, "self.__manifest = {};\n");
  put(f.root, ".next/static/style.css", "body {}\n");
  const paths = [...[server, client, common].flatMap((path) => [path, `${path}.map`]), unmapped, ...plain];
  const before = paths.map((path) => ({ path, bytes: readFileSync(join(f.root, path)), mtime: statSync(join(f.root, path)).mtimeMs }));
  const result = JSON.parse(execFileSync(process.execPath, [cli, f.out], { cwd: f.root, encoding: "utf8", env: { ...process.env, GITHUB_SHA: "" } }));
  const manifest = f.unpack();
  assert.deepEqual(manifest, result);
  assert.deepEqual({ ...manifest, files: [] }, { schemaVersion: 1, version, release: `tsgw-agent@${version}`, commit: f.commit, buildId: "fixture-build-id", files: [] });
  assert.deepEqual(readdirSync(f.out).sort(), ["SHA256SUMS", "artifacts.tar.gz", "manifest.json"]);
  const members = execFileSync("tar", ["-tzf", join(f.out, "artifacts.tar.gz")], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(members.sort(), ["manifest.json", ...paths].sort());
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), paths.sort());
  assert.deepEqual(readFileSync(join(f.out, "manifest.json")), readFileSync(join(f.extracted, "manifest.json")));
  for (const { path, bytes, mtime } of before) {
    assert.deepEqual(readFileSync(join(f.extracted, path)), bytes);
    assert.deepEqual(readFileSync(join(f.root, path)), bytes);
    assert.equal(statSync(join(f.root, path)).mtimeMs, mtime);
    const debugId = path === unmapped ? unmappedId : path.startsWith(".next/static/") ? clientId : serverId;
    assert.deepEqual(manifest.files.find((file) => file.path === path), { path, sha256: hash(bytes), ...(plain.includes(path) ? {} : { debugId }) });
  }
  assert.equal(readFileSync(join(f.out, "SHA256SUMS"), "utf8"), ["artifacts.tar.gz", "manifest.json"].map((name) => `${hash(readFileSync(join(f.out, name)))}  ${name}\n`).join(""));
});
test("Next middleware.js retains its original proxy.js.map association by Debug ID", (t) => {
  const f = fixture(t);
  const script = ".next/server/middleware.js", map = ".next/server/proxy.js.map";
  const proxyId = "33333333-3333-4333-8333-333333333333";
  pair(f.root, script, proxyId);
  put(f.root, script, readFileSync(join(f.root, script), "utf8") + "//# sourceMappingURL=proxy.js.map\n");
  put(f.root, map, readFileSync(join(f.root, `${script}.map`)));
  rmSync(join(f.root, `${script}.map`));
  const manifest = packCatArtifacts(f.out, f.root);
  assert.deepEqual(f.unpack(), manifest);
  for (const path of [script, map]) {
    assert.deepEqual(readFileSync(join(f.extracted, path)), readFileSync(join(f.root, path)));
    assert.equal(manifest.files.find((file) => file.path === path).debugId, proxyId);
  }
});

test("GITHUB_SHA takes precedence over git HEAD", (t) => {
  const f = fixture(t), commit = "a".repeat(40);
  execFileSync(process.execPath, [cli, f.out], { cwd: f.root, env: { ...process.env, GITHUB_SHA: commit } });
  assert.equal(f.unpack().commit, commit);
});
for (const category of ["server", "static"]) {
  test(`pack and verify require a ${category} JS/map pair, not merely JS`, (t) => {
    const f = fixture(t);
    packCatArtifacts(f.out, f.root); f.unpack();
    rewriteManifest(f.extracted, (m) => { m.files = m.files.filter((file) => !(file.path.startsWith(`.next/${category}/`) && file.path.endsWith(".map"))); });
    assert.throws(() => verifyCatArtifacts(f.extracted), /Missing Debug ID pair/);
    for (const path of category === "server" ? [server, common] : [client]) rmSync(join(f.root, `${path}.map`));
    assert.throws(() => packCatArtifacts(join(f.out, "retry"), f.root), /Missing Debug ID pair/);
  });
}
const brokenPairs = [
  ["missing map ID", `${server}.map`, () => '{"version":3}', /Missing Debug ID:|Debug ID mismatch/],
  ["missing comment", server, (s) => s.replace(/\/\/# debugId=.*\n/, ""), /Missing or invalid Debug ID comment/],
  ["missing runtime", server, (s) => s.replace(`sentry-dbid-${serverId}`, serverId), /Missing or invalid Sentry runtime marker|Debug ID mismatch/],
  ["plain JS with generated map", server, () => "console.log('plain');\n", /Missing or invalid Sentry runtime marker|Debug ID mismatch/],
  ["bare UUID is not a marker", server, () => `globalThis.id = "${serverId}";\n`, /Missing or invalid Sentry runtime marker|Debug ID mismatch/],
  ["malformed runtime UUID", server, (s) => s.replace(`sentry-dbid-${serverId}`, "sentry-dbid-invalid"), /Missing or invalid Sentry runtime marker|Debug ID mismatch/],
  ["mismatched comment", server, (s) => s.replace(`//# debugId=${serverId}`, `//# debugId=${clientId}`), /Debug ID mismatch/],
  ["mismatched map ID", `${server}.map`, (s) => s.replaceAll(serverId, clientId), /Missing JS\/map pair|Debug ID mismatch/],
];
for (const [label, path, change, error] of brokenPairs) {
  for (const mode of ["pack", "verify"]) {
    test(`${mode} rejects ${label} despite other valid server/static pairs`, (t) => {
      const f = fixture(t);
      if (mode === "verify") { packCatArtifacts(f.out, f.root); f.unpack(); }
      const directory = mode === "pack" ? f.root : f.extracted;
      const bytes = change(readFileSync(join(directory, path), "utf8"));
      put(directory, path, bytes);
      if (mode === "verify") rewriteManifest(directory, (m) => { m.files.find((file) => file.path === path).sha256 = hash(bytes); });
      assert.throws(() => mode === "pack" ? packCatArtifacts(f.out, f.root) : verifyCatArtifacts(directory), error);
      assert.equal(readFileSync(join(directory, path), "utf8"), bytes);
      if (mode === "pack") assert.deepEqual(readdirSync(f.out), []);
    });
  }
}
test("mapless JS is retained; its runtime ID must still match the manifest", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, `${server}.map`));
  const manifest = packCatArtifacts(f.out, f.root);
  assert.deepEqual(f.unpack(), manifest);
  assert.ok(manifest.files.some((file) => file.path === server));
  assert.ok(!manifest.files.some((file) => file.path === `${server}.map`));
  rewriteManifest(f.extracted, (m) => { delete m.files.find((file) => file.path === unmapped).debugId; });
  assert.throws(() => verifyCatArtifacts(f.extracted), /Debug ID mismatch/);
  rewriteManifest(f.extracted, (m) => { m.files.find((file) => file.path === unmapped).debugId = clientId; });
  assert.throws(() => verifyCatArtifacts(f.extracted), /Debug ID mismatch/);
});
test("generated orphan maps fail rather than being silently skipped", (t) => {
  const f = fixture(t);
  put(f.root, ".next/static/orphan.js.map", JSON.stringify({ debug_id: serverId }));
  assert.throws(() => packCatArtifacts(f.out, f.root), /Missing JS\/map pair/);
});
test("verify detects changed bytes and missing archived files", (t) => {
  const f = fixture(t);
  packCatArtifacts(f.out, f.root); f.unpack();
  put(f.extracted, unmapped, "tampered\n");
  assert.throws(() => verifyCatArtifacts(f.extracted), /SHA256 mismatch/);
  rmSync(join(f.extracted, `${server}.map`));
  assert.throws(() => verifyCatArtifacts(f.extracted), /ENOENT/);
});
test("verify rejects inconsistent metadata, unsafe paths, and orphan or inconsistent entries", (t) => {
  const f = fixture(t);
  packCatArtifacts(f.out, f.root); f.unpack();
  const original = readFileSync(join(f.extracted, "manifest.json"));
  const cases = [
    [(m) => { m.release = "tsgw-agent@other"; }, /Release\/version mismatch/],
    [(m) => { m.schemaVersion = 2; }, /Unsupported CAT artifact schema/],
    [(m) => { m.files[0].path = "package.json"; }, /Invalid artifact path/],
    [(m) => { m.files[0].path = ".next/server/../../outside.js"; }, /Invalid artifact path/],
    [(m) => { m.files[0].path = ".next/server/node_modules/secret.js"; }, /Invalid artifact path/],
    [(m) => { m.files = m.files.filter((file) => ![server, common].includes(file.path)); }, /Missing JS\/map pair/],
    [(m) => { m.files.find((file) => file.path === server).debugId = clientId; }, /Debug ID mismatch/],
    [(m) => { m.files.push(m.files[0]); }, /Duplicate artifact path/],
  ];
  for (const [change, message] of cases) {
    put(f.extracted, "manifest.json", original); rewriteManifest(f.extracted, change);
    assert.throws(() => verifyCatArtifacts(f.extracted), message);
  }
});
test("pack refuses a nonempty destination without overwriting", (t) => {
  const f = fixture(t);
  put(f.out, "manifest.json", "existing release");
  assert.throws(() => packCatArtifacts(f.out, f.root), /empty artifact directory/);
  assert.equal(readFileSync(join(f.out, "manifest.json"), "utf8"), "existing release");
});
