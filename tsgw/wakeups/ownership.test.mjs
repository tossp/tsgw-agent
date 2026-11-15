import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { acquireWakeupOwnership } = await createJiti(import.meta.url).import("./ownership.ts");
const fast = { retries: 0, stale: 2_000, update: 1_000 };
const cwd = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "wakeup-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return join(root, "wakeups");
}

async function acquire(t, directory, options = fast, onLost = assert.fail) {
  const owner = await acquireWakeupOwnership(directory, onLost, options);
  t.after(() => owner.release());
  return owner;
}

function child(t, directory, body) {
  const source = 'import { createJiti } from "jiti";' +
    'const { acquireWakeupOwnership } = await createJiti(process.cwd() + "/wakeup-probe.mjs").import("./tsgw/wakeups/ownership.ts");' +
    'const directory = process.argv[1];' + body;
  const processChild = spawn(process.execPath, ["--input-type=module", "-e", source, directory], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  processChild.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  processChild.exited = once(processChild, "exit");
  processChild.errors = () => stderr;
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL");
    await processChild.exited;
  });
  return processChild;
}

async function ready(processChild) {
  processChild.stdout.setEncoding("utf8");
  let output = "";
  for await (const data of processChild.stdout) {
    output += data;
    if (output.includes("ready")) return;
  }
  assert.fail("child did not acquire ownership: " + processChild.errors());
}

test("two owners compete on a stable directory and release permits takeover", async (t) => {
  const directory = fixture(t);
  const first = await acquire(t, directory);
  assert.equal(first.isOwner(), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(directory, "owner")).mode & 0o777, 0o700);
  }
  fs.writeFileSync(join(directory, "state.json"), "old");
  fs.writeFileSync(join(directory, "replacement"), "new");
  fs.renameSync(join(directory, "replacement"), join(directory, "state.json"));
  await assert.rejects(acquireWakeupOwnership(directory, assert.fail, fast), { code: "ELOCKED" });
  await Promise.all([first.release(), first.release()]);
  assert.equal(first.isOwner(), false);
  const next = await acquire(t, directory);
  await first.release();
  assert.equal(next.isOwner(), true);
  assert.equal(fs.existsSync(join(directory, "owner.lock")), true);
});

test("native fixed retry waits for a released owner and otherwise rejects ELOCKED", async (t) => {
  const directory = fixture(t);
  const first = await acquire(t, directory);
  const waiting = acquire(t, directory, { ...fast, retries: 2 });
  await delay(100);
  await first.release();
  const next = await waiting;
  assert.equal(next.isOwner(), true);
  await assert.rejects(acquireWakeupOwnership(directory, assert.fail, { ...fast, retries: 1 }), { code: "ELOCKED" });
});

test("actual heartbeat loss calls onLost once, never reacquires and cannot release a successor", async (t) => {
  const directory = fixture(t);
  let resolveLost;
  const lost = new Promise((resolve) => { resolveLost = resolve; });
  const errors = [];
  const first = await acquire(t, directory, fast, (error) => {
    assert.equal(first.isOwner(), false);
    errors.push(error);
    resolveLost(error);
  });
  fs.rmdirSync(join(directory, "owner.lock"));
  // The library heartbeat is unref'd; this deadline keeps the test alive while waiting.
  const deadline = setTimeout(() => resolveLost(new Error("heartbeat did not report loss")), 5_000);
  t.after(() => clearTimeout(deadline));
  const error = await lost;
  clearTimeout(deadline);
  assert.equal(error.code, "ECOMPROMISED");
  assert.equal(first.isOwner(), false);
  const next = await acquire(t, directory);
  await first.release();
  assert.equal(fs.existsSync(join(directory, "owner.lock")), true);
  await delay(1_100);
  assert.equal(errors.length, 1);
  assert.equal(first.isOwner(), false);
  assert.equal(next.isOwner(), true);
});

test("a child with an owned lock exits naturally without a heartbeat keeping it alive", { timeout: 10_000 }, async (t) => {
  const directory = fixture(t);
  const processChild = child(t, directory,
    'await acquireWakeupOwnership(directory, (error) => { throw error; }); console.log("ready");');
  const [code, signal] = await processChild.exited;
  assert.equal(code, 0, processChild.errors());
  assert.equal(signal, null);
  assert.equal(fs.existsSync(join(directory, "owner.lock")), false);
  assert.equal((await acquire(t, directory)).isOwner(), true);
});

test("SIGKILL then immediate child restart takes over the stale lock with native retries", { timeout: 15_000 }, async (t) => {
  const directory = fixture(t);
  const first = child(t, directory,
    'await acquireWakeupOwnership(directory, (error) => { throw error; }, { stale: 2000, update: 1000, retries: 0 });' +
    'console.log("ready"); setInterval(() => {}, 1000);');
  await ready(first);
  // A different process must be rejected while the heartbeat owner is alive.
  await assert.rejects(acquireWakeupOwnership(directory, assert.fail, fast), { code: "ELOCKED" });
  first.kill("SIGKILL");
  await first.exited;
  assert.equal(fs.existsSync(join(directory, "owner.lock")), true);
  const started = performance.now();
  const restarted = child(t, directory,
    'const owner = await acquireWakeupOwnership(directory, (error) => { throw error; }, { stale: 2000, update: 1000, retries: 6 });' +
    'console.log("ready"); await owner.release();');
  const [code, signal] = await restarted.exited;
  assert.equal(code, 0, restarted.errors());
  assert.equal(signal, null);
  t.diagnostic("crash/restart takeover including child startup: " + (performance.now() - started).toFixed(1) + " ms");
  assert.equal(fs.existsSync(join(directory, "owner.lock")), false);
});

test("retry budget cannot exceed thirty one-second retries", async (t) => {
  const directory = fixture(t);
  for (const retries of [-1, 31, 1.5, NaN]) {
    await assert.rejects(acquireWakeupOwnership(directory, assert.fail, { retries }), RangeError);
  }
  assert.equal(fs.existsSync(dirname(join(directory, "owner"))), false);
});
