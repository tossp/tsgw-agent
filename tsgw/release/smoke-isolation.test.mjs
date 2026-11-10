import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSmokeEnvironment } from "./smoke-environment.mjs";
import { startCatCapture } from "./smoke-cat.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "tsgw-smoke-isolation-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function run(script, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const [code, signal] = await once(child, "exit");
    return { code, signal, stdout, stderr };
  } finally { clearTimeout(timeout); }
}
function hasError(cat, channel, message) {
  return cat.receipts.some((receipt) => receipt.channel === channel && receipt.items.some(({ type, payload }) =>
    type === "event" && payload.exception?.values?.some((value) => value.value === message)));
}

test("acceptance children have private HOME/agent/npm config and no inherited runtime or credentials", (t) => {
  const directory = fixture(t);
  const env = createSmokeEnvironment(directory, {
    PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NODE_ENV: "production", NEXT_RUNTIME: "nodejs", PI_WEB: "1", NODE_OPTIONS: "--bad-hook",
    npm_config_registry: "https://private.invalid", npm_config_omit: "dev", NPM_TOKEN: "private",
    HTTPS_PROXY: "https://proxy.invalid", SSH_AUTH_SOCK: "/private/agent", OPENAI_API_KEY: "private",
    PI_CODING_AGENT_DIR: "/private/agent", SENTRY_AUTH_TOKEN: "private", AWS_SECRET_ACCESS_KEY: "private",
  });
  for (const key of ["NODE_ENV", "NEXT_RUNTIME", "PI_WEB", "NODE_OPTIONS", "npm_config_registry", "npm_config_omit",
    "NPM_TOKEN", "HTTPS_PROXY", "SSH_AUTH_SOCK", "OPENAI_API_KEY", "SENTRY_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
    assert.equal(env[key], undefined, key);
  }
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "PI_CODING_AGENT_DIR",
    "npm_config_cache", "npm_config_userconfig", "npm_config_globalconfig"]) assert.ok(env[key].startsWith(directory), key);
  assert.equal(readFileSync(env.npm_config_userconfig, "utf8"), "");
  assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env, encoding: "utf8" }), env.HOME);
  const config = JSON.parse(execFileSync("npm", ["config", "list", "--json"], { cwd: directory, env, encoding: "utf8" }));
  assert.equal(config.cache, env.npm_config_cache);
  assert.equal(config.userconfig, env.npm_config_userconfig);
  assert.equal(config.globalconfig, env.npm_config_globalconfig);
  assert.equal(JSON.stringify(config["allow-scripts"] ?? []).includes("@opencode/cli"), false);
});

test("real Node SDK default native transport stays local, while an uncaught failure still exits nonzero", async (t) => {
  const directory = fixture(t);
  const cat = await startCatCapture(directory);
  t.after(() => cat.close());
  const env = { ...createSmokeEnvironment(directory), ...cat.env };
  const result = await run(`
    import assert from 'node:assert/strict';
    import Sentry from '@sentry/nextjs';
    import { createJiti } from 'jiti';
    const jiti = createJiti(import.meta.url, { fsCache: false });
    await jiti.import('./tsgw/cat-monitoring/server-init.ts');
    assert.equal(Sentry.getClient().getOptions().dsn, 'https://24d86d19be5d513074e45febd5b004b8@cat.tossp.com/10');
    Sentry.setExtra('largeNativeEnvelope', 'x'.repeat(40000)); // Exercise the SDK's native gzip path, too.
    setTimeout(() => { throw new Error('release-node-original-failure'); }, 0);
  `, env);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /release-node-original-failure/);
  assert.ok(hasError(cat, "node", "release-node-original-failure"), "Default SDK transport must deliver a real local envelope");
  assert.ok(cat.receipts.some(({ items }) => items.some(({ payload }) => payload.extra?.largeNativeEnvelope?.length === 40000)));
  cat.assertClean();
  assert.ok(cat.pids().length > 0);
  for (const pid of cat.pids()) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("Node fetch capture returns real local HTTP success and unknown transport fails closed", async (t) => {
  const directory = fixture(t);
  const cat = await startCatCapture(directory);
  t.after(() => cat.close());
  const env = { ...createSmokeEnvironment(directory), ...cat.env };
  const result = await run(`
    import assert from 'node:assert/strict';
    const body = '{}\\n{"type":"event"}\\n{"message":"fetch regression"}';
    const response = await fetch('https://cat.tossp.com/api/10/envelope/', { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{}');
  `, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(cat.receipts.length, 1);
  cat.assertClean();
  const bypass = await run("import dns from 'node:dns/promises'; await dns.lookup('cat.tossp.com');", env);
  assert.equal(bypass.code, 1);
  assert.match(bypass.stderr, /unhandled transport attempted DNS/);
  assert.throws(() => cat.assertClean(), /bypassed interception/);
});
