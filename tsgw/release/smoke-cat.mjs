import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export async function startCatCapture(fixture) {
  const directory = join(fixture, "cat");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipts = [];
  const failures = [];
  function receive(channel, body) {
    // Default SDK JSON envelopes: keep payloads in memory only; never log them.
    const lines = body.toString().split("\n");
    const envelope = JSON.parse(lines[0]);
    const items = [];
    for (let index = 1; index + 1 < lines.length; index += 2) {
      if (!lines[index]) continue;
      items.push({ type: JSON.parse(lines[index]).type, payload: JSON.parse(lines[index + 1]) });
    }
    receipts.push({ channel, envelope, items });
  }
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.ok(request.url.startsWith("/node/"));
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      receive("node", request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    TSGW_SMOKE_CAT_PORT: String(server.address().port),
    TSGW_SMOKE_CAT_DIRECTORY: directory,
    // Inherited by the CLI's Next child, but never passed to npm/lifecycles.
    NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./smoke-cat-preload.cjs", import.meta.url)))}`,
  };
  return {
    env, receipts,
    async routeBrowser(context) {
      await context.route(/^https?:\/\/([^/]+\.)?cat\.tossp\.com(?::\d+)?\//i, async (route) => {
        try {
          const request = route.request();
          if (request.method() === "POST") receive("browser", request.postDataBuffer());
          await route.fulfill({ status: 200, contentType: "application/json", body: "{}",
            headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
        } catch (error) {
          failures.push(error);
          await route.abort();
        }
      });
    },
    assertClean() {
      assert.equal(existsSync(join(directory, "violations")), false, "CAT transport bypassed interception");
      assert.deepEqual(failures.map((error) => error.message), [], "Local CAT capture failed");
    },
    pids() {
      const path = join(directory, "pids");
      return existsSync(path) ? [...new Set(readFileSync(path, "utf8").trim().split("\n").map(Number))] : [];
    },
    summary() {
      return receipts.map(({ channel, items }) => ({ channel, types: items.map(({ type }) => type) }));
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
