import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packCatArtifacts, verifyCatArtifacts } from "./cat-artifacts.mjs";
import { uploadCatArtifacts } from "./cat-upload.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cat-backfill-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0-dev.42.1.g0123456789ab" }));
  mkdirSync(join(root, ".next"));
  writeFileSync(join(root, ".next/BUILD_ID"), "original-build");
  for (const [path, id] of [
    [".next/server/app/route.js", "11111111-1111-4111-8111-111111111111"],
    [".next/static/chunks/app.js", "22222222-2222-4222-8222-222222222222"],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `globalThis._sentryDebugIds = { stack: "${id}" };\nglobalThis._sentryDebugIdIdentifier = "sentry-dbid-${id}";\nconsole.log('original');\n//# debugId=${id}\n`);
    writeFileSync(join(root, `${path}.map`), JSON.stringify({
      version: 3, debug_id: id, sources: ["source.ts"], sourcesContent: ["console.log('original');"], names: [], mappings: "AAAA",
    }));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["-c", "user.name=CAT Test", "-c", "user.email=cat-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: root });
  packCatArtifacts(join(root, "archive"), root);
  const restored = join(root, "restored");
  mkdirSync(restored);
  execFileSync("tar", ["-xzf", join(root, "archive/artifacts.tar.gz"), "-C", restored]);
  return restored;
}

test("backfill refuses missing credentials instead of silently skipping upload", async (t) => {
  await assert.rejects(uploadCatArtifacts(fixture(t), {}), /SENTRY_AUTH_TOKEN is required/);
});

test("backfill rejects an archive from a different requested version before contacting CAT", async (t) => {
  await assert.rejects(uploadCatArtifacts(fixture(t), {
    SENTRY_AUTH_TOKEN: "offline-test-token", VERSION: "0.1.0-dev.99.1.gabcdef123456",
  }), /Archive version does not match/);
});

for (const failAt of ["release", "sourcemaps"]) {
test(`real Sentry ${failAt} failure propagates, leaving original JS/map untouched`, async (t) => {
  const root = fixture(t);
  const manifest = verifyCatArtifacts(root);
  const bytes = manifest.files.map((file) => readFileSync(join(root, file.path)));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    const denied = failAt === "release" || request.url.includes("chunk-upload");
    response.writeHead(denied ? 403 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(denied ? { detail: "offline test denied" } : {
      id: "10", slug: "tsgw-agent", version: manifest.release,
      projects: [{ id: "10", slug: "tsgw-agent" }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // The CLI caches its instance/auth context; isolate the real SDK from local profiles.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SENTRY_")));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cat-upload.mjs", import.meta.url)), root], {
    env: {
      ...baseEnv, NODE_ENV: "production", SENTRY_CONFIG_DIR: join(root, "cli-config"),
      SENTRY_AUTH_TOKEN: "offline-test-token", SENTRY_URL: `http://127.0.0.1:${server.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(stderr, /403|denied|permission|forbidden/i);
  assert.ok(requests.length > 0);
  for (const request of requests) {
    // The SDK may validate the target organization/project before posting the release.
    assert.match(request.url, /^\/api\/0\//);
    assert.equal(request.authorization, "Bearer offline-test-token");
  }
  if (failAt === "sourcemaps") {
    assert.ok(requests.some((request) => request.method === "POST" && request.url.endsWith("/releases/")), "release was created");
    assert.ok(requests.some((request) => request.url.includes("chunk-upload")), "the original maps reached the upload stage");
  }
  assert.deepEqual(verifyCatArtifacts(root), manifest);
  manifest.files.forEach((file, index) => assert.deepEqual(readFileSync(join(root, file.path)), bytes[index]));
});
}
