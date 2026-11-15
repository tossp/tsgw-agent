import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { uuidv7 } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { WakeupStore } = await jiti.import("./store.ts");
const { createWakeupSession } = await jiti.import("./new-session.ts");
const { getWakeupStateFile, peekWakeupRuntime } = await jiti.import("./host.ts");
const { registerNodeInstrumentation } = await jiti.import("../../instrumentation-node.ts");
const runtimeKey = Symbol.for("pi-web.wakeupRuntime");
const imKey = Symbol.for("pi-web.im.service");

async function eventually(check) {
  const until = Date.now() + 5000;
  do { if (check()) return; await delay(10); } while (Date.now() < until);
  assert.fail("Timed out waiting for startup wakeup restoration");
}

test("Node instrumentation restores pending without a browser request, session start or model runtime", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "wakeup-instrumentation-"));
  const agentDir = join(directory, "agent"), cwd = join(directory, "project");
  await mkdir(cwd);
  const previousDir = process.env.PI_CODING_AGENT_DIR, previousRuntime = globalThis[runtimeKey], previousIm = globalThis[imKey];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete globalThis[runtimeKey];
  delete globalThis[imKey];
  const target = createWakeupSession(cwd, "startup target");
  const stateFile = getWakeupStateFile();
  const at = new Date().toISOString();
  const task = {
    wakeupId: uuidv7(), sourceSessionId: target.sessionId, targetSessionId: target.sessionId, cwd,
    createdAt: at, updatedAt: at, scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    message: "isolated future task; never submitted", status: "pending",
  };
  new WakeupStore(stateFile).save([task]);
  const beforeState = await readFile(stateFile), beforeTarget = await readFile(target.file), beforeStat = await stat(target.file);
  const models = t.mock.method(ModelRuntime, "create", () => assert.fail("startup must not start an agent for a future timer"));
  t.mock.method(net.Socket.prototype, "connect", () => { throw new Error("startup fixture forbids network"); });
  t.after(async () => {
    peekWakeupRuntime()?.dispose();
    await eventually(() => !existsSync(join(dirname(stateFile), "owner.lock")));
    if (globalThis[imKey]) await (await globalThis[imKey]).close();
    if (previousIm === undefined) delete globalThis[imKey]; else globalThis[imKey] = previousIm;
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  });
  registerNodeInstrumentation();
  // Both startup imports must finish while the temporary agent directory is active.
  await eventually(() => !!globalThis[imKey]);
  await globalThis[imKey];
  await eventually(() => peekWakeupRuntime()?.list().some(item => item.wakeupId === task.wakeupId));
  const runtime = peekWakeupRuntime();
  const result = await runtime.query({ wakeup_id: task.wakeupId });
  assert.equal(result.health.state, "ready");
  assert.equal(result.items[0].armed, true);
  assert.equal(models.mock.calls.length, 0);
  assert.deepEqual(await readFile(stateFile), beforeState);
  assert.deepEqual(await readFile(target.file), beforeTarget);
  assert.equal((await stat(target.file)).mtimeMs, beforeStat.mtimeMs);
});
