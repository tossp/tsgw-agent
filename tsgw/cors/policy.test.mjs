import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { getAllowedCorsOrigin, mergeCorsAllowedHosts } from "./index.ts";

const keys = ["TSGW_ALLOWED_ORIGINS", "PI_WEB_ALLOWED_HOSTS", "PI_WEB_HOSTNAME"];
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of keys) delete process.env[key]; });
after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) },
  moduleCache: false,
});
const { isApiRequestAllowed } = await jiti.import("../../lib/request-security.ts");
const request = (origin, host = "localhost:30141") => new Request("http://localhost:30141/api/home", {
  headers: { host, origin, "sec-fetch-site": "cross-site" },
});

test("unset or empty configuration leaves the existing environment unchanged", () => {
  for (const env of [{}, { PI_WEB_ALLOWED_HOSTS: "legacy.example" }, { TSGW_ALLOWED_ORIGINS: " , " }]) {
    const before = { ...env };
    mergeCorsAllowedHosts(env);
    assert.deepEqual(env, before);
  }
});

test("merges exact hostnames and HTTP(S) origins without losing existing hosts", () => {
  const env = {
    PI_WEB_ALLOWED_HOSTS: "legacy.example,Panel.Example:8443,::1",
    TSGW_ALLOWED_ORIGINS: "https://PANEL.example:443/,panel.example,100.64.170.247,http://[::1]:30141",
  };
  mergeCorsAllowedHosts(env);
  assert.equal(env.PI_WEB_ALLOWED_HOSTS, "legacy.example,Panel.Example:8443,::1,100.64.170.247");
  const merged = env.PI_WEB_ALLOWED_HOSTS;
  mergeCorsAllowedHosts(env);
  assert.equal(env.PI_WEB_ALLOWED_HOSTS, merged);
  assert.equal(env.TSGW_ALLOWED_ORIGINS, "https://PANEL.example:443/,panel.example,100.64.170.247,http://[::1]:30141");
});

test("matches the entire hostname while ignoring scheme and port", () => {
  process.env.TSGW_ALLOWED_ORIGINS = "https://panel.example:8443,100.64.170.247,[::1]";
  for (const origin of [
    "https://panel.example", "http://panel.example:30141", "https://PANEL.example:9443",
    "http://100.64.170.247:30141", "http://[::1]:8080",
  ]) {
    assert.equal(getAllowedCorsOrigin(request(origin)), origin);
  }
});

test("normalizes bare IPv6 addresses exactly like browser origins and derived Hosts", () => {
  process.env.TSGW_ALLOWED_ORIGINS = "0:0:0:0:0:0:0:1,::ffff:127.0.0.1,2001:0db8::1";
  mergeCorsAllowedHosts();
  assert.equal(process.env.PI_WEB_ALLOWED_HOSTS, "::1,::ffff:7f00:1,2001:db8::1");
  for (const origin of ["http://[::1]:8080", "http://[::ffff:7f00:1]:1234", "https://[2001:db8::1]:9443"]) {
    assert.equal(getAllowedCorsOrigin(request(origin)), origin);
  }
});

test("does not implicitly trust subdomains, hostname suffixes or opaque origins", () => {
  process.env.TSGW_ALLOWED_ORIGINS = "panel.example";
  for (const origin of [
    "https://sub.panel.example", "https://panel.example.attacker.test", "https://evilpanel.example",
    "null", "file:///panel.example", "data:text/plain,panel.example", "blob:https://panel.example/id",
    "https://user@panel.example", "https://panel.example/path", "https://panel.example?query=1",
  ]) {
    assert.equal(getAllowedCorsOrigin(request(origin)), null, origin);
  }
  assert.equal(getAllowedCorsOrigin(new Request("http://localhost/api/home")), null);
});

test("rejects unsupported configuration before partially modifying the environment", () => {
  for (const invalid of ["*", "https://*.example", "https://%2A.example", "https://panel.example%2Cevil.example", "ftp://panel.example", "https://user@panel.example", "https://panel.example/path"]) {
    const env = { PI_WEB_ALLOWED_HOSTS: "legacy.example", TSGW_ALLOWED_ORIGINS: `panel.example,${invalid}` };
    assert.throws(() => mergeCorsAllowedHosts(env), /TSGW_ALLOWED_ORIGINS/);
    assert.equal(env.PI_WEB_ALLOWED_HOSTS, "legacy.example");
  }
});

test("the shared request guard accepts trusted cross-site origins but still checks the target Host", () => {
  process.env.TSGW_ALLOWED_ORIGINS = "https://panel.example";
  assert.equal(isApiRequestAllowed(request("http://panel.example:8080")), true);
  assert.equal(isApiRequestAllowed(request("http://panel.example:8080", "unconfigured.example")), false);
  assert.equal(isApiRequestAllowed(request("https://attacker.example")), false);
});

test("startup merging makes the derived hostname available to the existing Host guard", () => {
  process.env.TSGW_ALLOWED_ORIGINS = "https://panel.example:8443";
  const incoming = request("http://panel.example:8080", "panel.example:30141");
  assert.equal(isApiRequestAllowed(incoming), false);
  mergeCorsAllowedHosts();
  assert.equal(process.env.PI_WEB_ALLOWED_HOSTS, "panel.example");
  assert.equal(isApiRequestAllowed(incoming), true);
});

test("the old Host allow-list never becomes a cross-origin allow-list", () => {
  process.env.PI_WEB_ALLOWED_HOSTS = "panel.example";
  const incoming = request("https://panel.example");
  assert.equal(getAllowedCorsOrigin(incoming), null);
  assert.equal(isApiRequestAllowed(incoming), false);
});
