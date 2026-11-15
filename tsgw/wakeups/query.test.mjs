import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { WakeupStore } = await jiti.import("./store.ts");
const { getWakeupStateFile } = await jiti.import("./host.ts");
const { readWakeupQuery } = await jiti.import("./server-query.ts");
const { GET: list } = await jiti.import("../../app/api/tsgw/wakeups/route.ts");
const { GET: detail } = await jiti.import("../../app/api/tsgw/wakeups/[wakeupId]/route.ts");
const runtimeKey = Symbol.for("pi-web.wakeupRuntime");
const task = (wakeupId, fields = {}) => ({
  wakeupId, sourceSessionId: "source", targetSessionId: "target", cwd: "/project",
  createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
  scheduledAt: "2026-11-16T00:00:00.000Z", message: "Summary\nprivate handoff body", status: "pending", ...fields,
});

function fixture(t, tasks) {
  const agentDir = mkdtempSync(join(tmpdir(), "wakeup-query-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR, previousRuntime = globalThis[runtimeKey];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete globalThis[runtimeKey];
  const stateFile = getWakeupStateFile();
  if (tasks) new WakeupStore(stateFile).save(tasks);
  t.mock.method(ModelRuntime, "create", () => assert.fail("read-only route must not initialize a model runtime"));
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousRuntime === undefined) delete globalThis[runtimeKey]; else globalThis[runtimeKey] = previousRuntime;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return { stateFile, agentDir };
}

const request = params => new Request(`http://localhost/api/tsgw/wakeups?${new URLSearchParams(params)}`);

test("source/target/project/status filters and pagination are read-only and omit full bodies", async t => {
  const f = fixture(t, [task("a"), task("b", { status: "cancelled" }), task("c", { sourceSessionId: "another", targetSessionId: "elsewhere", cwd: "/elsewhere" })]);
  const before = readFileSync(f.stateFile), beforeStat = statSync(f.stateFile);
  const response = await list(request({ session_id: "source", limit: "1" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const first = await response.json();
  assert.deepEqual(first.items.map(item => item.wakeupId), ["b"]);
  assert.equal(first.items[0].message, undefined);
  assert.equal(first.items[0].summary, "Summary");
  assert.equal(first.items[0].armed, false);
  assert.equal(first.health.state, "read_only");
  const second = await (await list(request({ session_id: "source", limit: "1", cursor: first.nextCursor }))).json();
  assert.deepEqual(second.items.map(item => item.wakeupId), ["a"]);
  assert.equal(second.nextCursor, null);
  const filtered = await (await list(request({ target_session_id: "target", cwd: "/project", status: "pending" }))).json();
  assert.deepEqual(filtered.items.map(item => item.wakeupId), ["a"]);
  assert.deepEqual(readFileSync(f.stateFile), before);
  assert.equal(statSync(f.stateFile).mtimeMs, beforeStat.mtimeMs);
  assert.equal(existsSync(join(dirname(f.stateFile), "owner")), false);
  assert.equal(globalThis[runtimeKey], undefined);
});

test("task detail returns its body without returning unrelated handoffs", async t => {
  fixture(t, [task("a"), task("b", { message: "unrelated content" })]);
  const response = await detail(request({}), { params: Promise.resolve({ wakeupId: "a" }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].message, "Summary\nprivate handoff body");
  assert.equal(result.items[0].wakeupId, "a");
  assert.equal(JSON.stringify(result).includes("unrelated content"), false);
});

test("invalid filters and cursor return client errors, not a false storage failure", async t => {
  const f = fixture(t, [task("a")]);
  const before = readFileSync(f.stateFile);
  for (const params of [{ limit: "0" }, { limit: "NaN" }, { limit: "101" }, { status: "not-a-status" }, { session_id: "" }, { cursor: "not-present" }]) {
    const response = await list(request(params));
    assert.equal(response.status, 400, JSON.stringify(params));
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.deepEqual(readFileSync(f.stateFile), before);
});

test("unknown store version stays untouched and exposes unhealthy read-only status", async t => {
  const f = fixture(t, [task("a")]);
  writeFileSync(f.stateFile, JSON.stringify({ version: 2, tasks: [] }));
  const before = readFileSync(f.stateFile);
  const result = await (await list(request({ session_id: "source" }))).json();
  assert.deepEqual(result.items, []);
  assert.equal(result.health.state, "storage_error");
  assert.equal(result.health.isOwner, false);
  assert.deepEqual(readFileSync(f.stateFile), before);
});

test("reading an unused integration does not create state or a runtime", async t => {
  const f = fixture(t);
  const result = await readWakeupQuery({ session_id: "source" });
  assert.deepEqual(result.items, []);
  assert.equal(result.health.isOwner, false);
  assert.equal(existsSync(f.stateFile), false);
  assert.equal(existsSync(join(f.agentDir, "integrations")), false);
  assert.equal(globalThis[runtimeKey], undefined);
});
