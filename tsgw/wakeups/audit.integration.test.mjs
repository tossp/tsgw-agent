import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWakeupHost } = await jiti.import("./host.ts");
const { createWakeupSession } = await jiti.import("./new-session.ts");

// Real SDK append callbacks delayed at the session-owner boundary. The injected
// ownership handle lets loss occur after audit admission but before actual write.
for (const owned of [true, false]) test(`waiting ${owned ? "owned" : "unowned"} audit cannot append after scheduling ownership is lost`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "wakeup-audit-owner-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const target = createWakeupSession(cwd, "audit target", join(directory, "sessions"));
  const manager = SessionManager.open(target.file);
  const wrapper = { inner: { sessionManager: manager }, sessionFile: target.file, isAlive: () => true };
  let release, lose, waiting = false;
  const gate = new Promise(resolve => { release = resolve; });
  const errors = t.mock.method(console, "error", () => {});
  const runtime = createWakeupHost({
    getSession: () => owned ? wrapper : undefined,
    resolvePath: async () => target.file,
    reopenSession: async () => assert.fail("audit must not start a wrapper"),
    async withSessionOwner(_id, onOwned, onUnowned) {
      waiting = true;
      await gate;
      return owned ? onOwned(wrapper) : onUnowned();
    },
  }, {
    stateFile: join(directory, "wakeup-state", "state.json"),
    async acquireOwnership(_directory, onLost) {
      let owner = true;
      lose = () => { owner = false; onLost(new Error("ownership lost during audit wait")); };
      return { isOwner: () => owner, async release() { owner = false; } };
    },
  });
  t.after(async () => { release(); runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
  const before = await readFile(target.file), beforeStat = await stat(target.file);
  const scheduling = runtime.schedule("source", { session_id: target.sessionId, after_seconds: 60, message: "deferred handoff" });
  const until = Date.now() + 5000;
  while (!waiting && Date.now() < until) await delay(5);
  assert.equal(waiting, true);
  lose();
  release();
  const task = await scheduling;
  assert.equal(task.diagnostics[0].code, "wakeup_audit_not_saved");
  const result = await runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(result.health.state, "paused");
  assert.equal(result.health.isOwner, false);
  assert.equal(result.items[0].armed, false);
  assert.equal(result.items[0].status, "pending");
  assert.deepEqual(await readFile(target.file), before);
  assert.equal((await stat(target.file)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(manager.getEntries().length, 1, "only the original title remains in the SDK manager");
  assert.equal(errors.mock.calls.length, 1);
});
