// Only loaded by the acceptance process, never by the installed product itself.
/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { join } = require("node:path");

const port = Number(process.env.TSGW_SMOKE_CAT_PORT);
const directory = process.env.TSGW_SMOKE_CAT_DIRECTORY;
if (!directory || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CAT acceptance preload requires a local collector");
}
appendFileSync(join(directory, "pids"), `${process.pid}\n`, { mode: 0o600 });
const isCat = (host) => /^cat\.tossp\.com\.?$/i.test(host) || /\.cat\.tossp\.com\.?$/i.test(host);
const nativeRequest = http.request;

for (const httpModule of [http, https]) {
  const original = httpModule.request;
  httpModule.request = function (input, options, callback) {
    const urlInput = typeof input === "string" || input instanceof URL;
    const url = urlInput ? new URL(input) : null;
    const settings = urlInput ? (typeof options === "object" ? options : {}) : input;
    const host = settings.hostname || settings.host || url?.hostname || "localhost";
    if (!isCat(host)) return original.apply(this, arguments);
    const local = {
      ...settings, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1",
      port, agent: false, createConnection: undefined, socketPath: undefined,
      path: `/node${settings.path || (url ? url.pathname + url.search : "/")}`,
    };
    return nativeRequest(local, typeof options === "function" ? options : callback);
  };
  httpModule.get = function () {
    const request = httpModule.request.apply(this, arguments);
    request.end();
    return request;
  };
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!isCat(url.hostname)) return nativeFetch(input, options);
  const target = `http://127.0.0.1:${port}/node${url.pathname}${url.search}`;
  const request = new Request(input, options);
  return nativeFetch(new Request(target, request));
};

// A new transport bypassing the known native HTTP/fetch paths must fail closed,
// not silently report success. No CAT name is allowed to reach the resolver.
function guard(original) {
  return function (host) {
    if (isCat(host)) {
      appendFileSync(join(directory, "violations"), "CAT DNS bypass\n", { mode: 0o600 });
      throw new Error("CAT acceptance isolation: unhandled transport attempted DNS");
    }
    return original.apply(this, arguments);
  };
}
for (const key of Object.keys(dns)) {
  if ((key === "lookup" || key.startsWith("resolve")) && typeof dns[key] === "function") dns[key] = guard(dns[key]);
}
for (const key of Object.keys(dns.promises)) {
  if (key === "lookup" || key.startsWith("resolve")) dns.promises[key] = guard(dns.promises[key]);
}
syncBuiltinESMExports();
