import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { allowSmokeInstallScripts, createSmokeEnvironment } from "./smoke-environment.mjs";

// Inspect the npm actually selected by this test's PATH, not a new dependency
// or a reimplementation of its source-aware policy matcher.
const npmBin = process.env.PATH.split(delimiter).map((path) => join(path, "npm")).find(existsSync);
const npmRoot = dirname(dirname(realpathSync(npmBin)));
const npmRequire = createRequire(join(npmRoot, "package.json"));
const npmVersion = npmRequire("./package.json").version;
const ptyVersion = createRequire(import.meta.url)("../../package.json").dependencies["node-pty"];

test(`npm ${npmVersion} preserves the local tgz postinstall using only its applicable temporary policy`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tsgw-smoke-scripts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = createSmokeEnvironment(directory);
  const pkg = join(directory, "package");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tsgw-agent", version: "0.0.0-policy-fixture",
    scripts: { postinstall: "node postinstall.cjs" } }));
  writeFileSync(join(pkg, "postinstall.cjs"), "require('node:fs').writeFileSync('postinstall-ran', 'necessary lifecycle ran');");
  const tarball = join(directory, "tsgw-agent-0.0.0-policy-fixture.tgz");
  // Synthetic, dependency-free fixture only; never production pack/build/smoke.
  execFileSync("tar", ["-czf", tarball, "package"], { cwd: directory, env });
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  allowSmokeInstallScripts(env, npmVersion, tarball, ptyVersion);
  const config = readFileSync(env.npm_config_userconfig, "utf8");
  if (Number(npmVersion.split(".")[0]) >= 12) {
    assert.equal(config, `allow-scripts[]=file:${tarball}\nallow-scripts[]=node-pty@${ptyVersion}\n`);
    const matcher = npmRequire("@npmcli/arborist/lib/script-allowed.js");
    const npa = npmRequire("npm-package-arg");
    const file = { isRegistryDependency: false, resolved: npa(tarball).saveSpec,
      packageName: "tsgw-agent", version: "0.0.0-policy-fixture" };
    const policy = { [`file:${tarball}`]: true, [`node-pty@${ptyVersion}`]: true };
    assert.equal(matcher(file, { "tsgw-agent@0.0.0-policy-fixture": true }), null, "Manifest identity cannot approve file sources");
    assert.equal(matcher(file, policy), true);
    assert.equal(matcher({ ...file, resolved: `file:${directory}/different.tgz` }, policy), null);
    assert.equal(matcher({ isRegistryDependency: true,
      resolved: `https://registry.npmjs.org/node-pty/-/node-pty-${ptyVersion}.tgz` }, policy), true);
    assert.equal(matcher({ isRegistryDependency: true,
      resolved: "https://registry.npmjs.org/node-pty/-/node-pty-0.0.1.tgz" }, policy), null);
  } else {
    assert.equal(config, "", "npm 11 keeps its original lifecycle behavior without unsupported policy settings");
  }
  const prefix = join(directory, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, tarball, "--offline", "--no-audit", "--no-fund"], {
    cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  const installed = join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", "tsgw-agent");
  assert.equal(readFileSync(join(installed, "postinstall-ran"), "utf8"), "necessary lifecycle ran");
  assert.equal(createHash("sha256").update(readFileSync(tarball)).digest("hex"), digest, "Fixture tgz bytes are unchanged");
});
