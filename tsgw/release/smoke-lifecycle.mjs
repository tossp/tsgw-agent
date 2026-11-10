import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

function smokePidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function assertSmokePidStopped(pid) {
  const deadline = Date.now() + 5000;
  while (smokePidAlive(pid) && Date.now() < deadline) await delay(50);
  assert.equal(smokePidAlive(pid), false, `Acceptance PID ${pid} survived cleanup`);
}

// The caller spawns only its fixture CLI with detached:true on POSIX: PGID is
// that CLI's PID. bin/pi-web.js spawns Next without detached, so Next inherits
// this group. Never derive a group from the harness or a discovered service.
export function trackSmokeServer(server, failures) {
  let result;
  let closing = false;
  let forced = false;
  const exited = new Promise((resolve) => {
    server.once("error", (error) => { failures.push(error); resolve(); });
    server.once("exit", (code, signal) => {
      result = { code, signal, requestedShutdown: closing };
      const expected = closing && (code === 0 || code === 143 || signal === "SIGTERM" || (forced && signal === "SIGKILL"));
      if (!expected) failures.push(new Error(`Installed server exited unexpectedly (code=${code}, signal=${signal})`));
      resolve(result);
    });
  });
  function groupAlive() {
    if (!server.pid) return false;
    if (process.platform === "win32") return smokePidAlive(server.pid);
    try { process.kill(-server.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  }
  function signal(signal) {
    if (!server.pid) return;
    try {
      if (process.platform === "win32") server.kill(signal);
      else process.kill(-server.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  return {
    exited,
    get result() { return result; },
    async stop() {
      closing = true;
      // Signal the owned group even when its CLI leader already exited.
      signal("SIGTERM");
      const deadline = Date.now() + 10000;
      while (groupAlive() && Date.now() < deadline) await delay(50);
      if (groupAlive()) {
        forced = true;
        signal("SIGKILL");
        const killDeadline = Date.now() + 5000;
        while (groupAlive() && Date.now() < killDeadline) await delay(50);
      }
      assert.equal(groupAlive(), false, "Acceptance process group survived TERM/KILL");
      if (server.pid) await exited;
    },
  };
}

// Run every check, even if CAT, one PID or a prior API assertion already failed.
export async function verifySmokeCleanup(pids, port, failures) {
  for (const pid of new Set(pids)) {
    try { await assertSmokePidStopped(pid); }
    catch (error) { failures.push(error); }
  }
  if (port) {
    const probe = createServer();
    try {
      probe.listen(port, "127.0.0.1");
      await once(probe, "listening");
    } catch (error) { failures.push(error); }
    finally { if (probe.listening) await new Promise((done) => probe.close(done)); }
  }
}

export function assertSmokeSucceeded(failures, redact = (text) => text) {
  if (failures.length) throw new Error(redact(failures.map((error) => error.stack || String(error)).join("\n")));
}
