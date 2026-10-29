import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCatArtifacts } from "./cat-artifacts.mjs";

// Use the public API of the plugin already pinned by @sentry/nextjs, including nested installs.
const sdkRequire = createRequire(import.meta.resolve("@sentry/nextjs/package.json"));
const { createSentryBuildPluginManager } = sdkRequire("@sentry/bundler-plugins/core");

export async function uploadCatArtifacts(directory, env = process.env) {
  const authToken = env.SENTRY_AUTH_TOKEN?.trim();
  assert.ok(authToken, "SENTRY_AUTH_TOKEN is required for CAT backfill");
  // The official plugin silently skips uploads in development mode.
  assert.notEqual(process.env.NODE_ENV, "development", "Run CAT backfill with NODE_ENV=production");
  const root = resolve(directory);
  const manifest = verifyCatArtifacts(root);
  if (env.VERSION) assert.equal(manifest.version, env.VERSION, "Archive version does not match the requested backfill");
  const manager = createSentryBuildPluginManager({
    authToken,
    url: env.SENTRY_URL || "https://cat.tossp.com",
    org: env.SENTRY_ORG || "av8d",
    project: env.SENTRY_PROJECT || "tsgw-agent",
    telemetry: false,
    errorHandler: (error) => { throw error; },
    release: { name: manifest.release, setCommits: false },
    sourcemaps: { assets: [resolve(root, ".next/server"), resolve(root, ".next/static")] },
  }, { buildTool: "nextjs", loggerPrefix: "[CAT backfill]" });

  await manager.createRelease();
  // Already stamped and verified: bypass the plugin's best-effort preparation, which can skip files.
  await manager.uploadSourcemaps([], { prepareArtifacts: false });
  console.log(`CAT backfill completed: ${manifest.release}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Usage: node release/cat-upload.mjs <extracted-artifact-directory>");
  await uploadCatArtifacts(process.argv[2]);
}
