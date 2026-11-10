import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSmokeEnvironment } from "./smoke-environment.mjs";
import { assertSmokeSucceeded, trackSmokeServer, verifySmokeCleanup } from "./smoke-lifecycle.mjs";

function start(t, script) {
  const directory = mkdtempSync(join(tmpdir(), "tsgw-smoke-lifecycle-"));
  const failures = [];
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: directory, env: createSmokeEnvironment(directory), detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lifecycle = trackSmokeServer(child, failures);
  t.after(async () => {
    try { await lifecycle.stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { child, lifecycle, failures };
}
const serverScript = (exit) => `
  import { createServer } from 'node:http';
  const server = createServer((request, response) => {
    response.end('{}');
    ${exit || ''}
  });
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));
`;
async function address(child) {
  const [data] = await once(child.stdout, "data");
  return JSON.parse(data.toString());
}

test("smoke's final success gate rejects a real server exit after its last successful API check", async (t) => {
  const { child, lifecycle, failures } = start(t, serverScript("setTimeout(() => process.exit(23), 20);"));
  const { port } = await address(child);
  assert.equal((await fetch(`http://127.0.0.1:${port}/last-api`)).status, 200);
  await lifecycle.exited;
  await lifecycle.stop();
  await verifySmokeCleanup([child.pid], port, failures);
  assert.deepEqual(lifecycle.result, { code: 23, signal: null, requestedShutdown: false });
  assert.throws(() => assertSmokeSucceeded(failures), /exited unexpectedly \(code=23/);
});

test("smoke's requested TERM is recorded without reporting an unexpected exit", async (t) => {
  const { child, lifecycle, failures } = start(t, serverScript());
  const { port } = await address(child);
  assert.equal((await fetch(`http://127.0.0.1:${port}/last-api`)).status, 200);
  await lifecycle.stop();
  await verifySmokeCleanup([child.pid], port, failures);
  assert.equal(lifecycle.result.requestedShutdown, true);
  assert.ok(lifecycle.result.signal === "SIGTERM" || lifecycle.result.code === 0);
  assertSmokeSucceeded(failures);
});

test("owned group cleanup stops the real port-holder even after its leader exited", { skip: process.platform === "win32" }, async (t) => {
  const next = `
    const { createServer } = require('node:http');
    process.on('SIGTERM', () => {}); // Require the bounded KILL fallback.
    const server = createServer((request, response) => response.end('{}'));
    server.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ pid: process.pid, port: server.address().port }));
      process.send('ready');
    });
  `;
  const { child, lifecycle, failures } = start(t, `
    import { spawn } from 'node:child_process';
    const next = spawn(process.execPath, ['-e', ${JSON.stringify(next)}], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env,
    });
    next.once('message', () => process.exit(31));
  `);
  const { pid, port } = await address(child);
  await lifecycle.exited;
  assert.equal(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim()), child.pid);
  assert.equal((await fetch(`http://127.0.0.1:${port}/still-alive`)).status, 200);
  await lifecycle.stop();
  await verifySmokeCleanup([child.pid, pid], port, failures);
  assert.equal(failures.length, 1, "Cleanup must finish while preserving the original leader failure");
  assert.throws(() => assertSmokeSucceeded(failures), /exited unexpectedly \(code=31/);
});

test("cleanup still checks the port after a PID check fails", async (t) => {
  const { child, lifecycle, failures } = start(t, serverScript());
  const { port } = await address(child);
  // This known test PID is deliberately alive; checking it must not prevent
  // the independent bind check from observing the still-owned fixture port.
  await verifySmokeCleanup([process.pid], port, failures);
  assert.equal(failures.length, 2);
  assert.match(failures[0].message, /survived cleanup/);
  assert.equal(failures[1].code, "EADDRINUSE");
  await lifecycle.stop();
});

test("smoke records an unsolicited late signal instead of converting it to success", async (t) => {
  const { child, lifecycle, failures } = start(t, serverScript("setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20);"));
  const { port } = await address(child);
  assert.equal((await fetch(`http://127.0.0.1:${port}/last-api`)).status, 200);
  await lifecycle.exited;
  await lifecycle.stop();
  await verifySmokeCleanup([child.pid], port, failures);
  assert.deepEqual(lifecycle.result, { code: null, signal: "SIGTERM", requestedShutdown: false });
  assert.throws(() => assertSmokeSucceeded(failures), /signal=SIGTERM/);
});
