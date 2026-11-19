import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createPiSessionHost } = await createJiti(import.meta.url).import("./pi-host.ts");
const row = (id, extra = {}) => ({ id, cwd: process.cwd(), firstMessage: id, ...extra });

function fixture(rows = [row("main")]) {
  const starts = [], calls = [], notifications = [];
  const wrapper = {
    isAlive: () => true,
    async send(value) { calls.push(value); },
    beginCustomMessageSubmission: () => () => {},
    acquirePromptAdmission: async () => () => {},
    prepareMcpForRun: async () => true,
    shellRunning: false,
    inner: { isCompacting: false, isStreaming: false, async sendCustomMessage(notification, options) { notifications.push({ notification, options }); } },
  };
  const access = {
    async list() { return rows; }, async get() { return wrapper; },
    async start(...args) { starts.push(args); return { session: wrapper, realSessionId: args[0].startsWith("__new__") ? "new" : args[0] }; },
    async resolvePath() { return "/session.jsonl"; }, async allowRoot() {}, async invalidateList() {},
  };
  return { access, host: createPiSessionHost(access), wrapper, starts, calls, notifications };
}

test("catalogue and exists restrict the cwd and ordinary sessions, preserving forks", async () => {
  const f = fixture([
    row("main", { name: "Named" }), row("fork", { relation: { kind: "fork" }, parentSessionId: "main" }),
    row("subagent", { relation: { kind: "subagent" } }), row("side", { relation: { kind: "side" } }),
    row("other", { cwd: "/another-project" }), row("pending", { detailsPending: true }),
  ]);
  assert.deepEqual((await f.host.list(`${process.cwd()}/.`)).map(({ id }) => id), ["main", "fork"]);
  assert.equal((await f.host.list(process.cwd()))[0].title, "Named");
  assert.equal(await f.host.exists("fork", process.cwd()), true);
  for (const id of ["subagent", "side", "other", "pending", "missing"]) assert.equal(await f.host.exists(id, process.cwd()), false);
  assert.deepEqual(f.starts, []);
});

test("create allows the project and leaves naming and notification delivery to Pi", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "im-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const f = fixture();
  const allowed = [];
  f.access.allowRoot = async (cwd) => { allowed.push(cwd); };
  assert.equal(await f.host.create(cwd), "new");
  await f.host.create(cwd);
  assert.match(f.starts[0][0], /^__new__[0-9a-f-]{36}$/);
  assert.notEqual(f.starts[0][0], f.starts[1][0]);
  assert.deepEqual(f.starts[0].slice(1), ["", cwd]);
  assert.deepEqual(allowed, [cwd, cwd]);
  assert.deepEqual(f.notifications, []);
});

test("a stopped wrapper resumes the exact stored session and submits a native follow-up", async () => {
  const f = fixture();
  f.access.get = async () => undefined;
  const signal = new AbortController().signal;
  const address = { id: "handle", sessionId: "main", botId: "wx", chatId: "42" };
  const input = { id: "1", text: "hello", chatId: "42", senderId: "42", isGroup: false };
  const { completion } = await f.host.notify(address, process.cwd(), input, signal);
  await completion;
  assert.deepEqual(f.starts, [["main", "/session.jsonl"]]);
  assert.deepEqual(f.notifications[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(f.notifications[0].notification.details, address);
  assert.match(f.notifications[0].notification.content[0].text, /hello/);
  f.access.resolvePath = async () => null;
  await assert.rejects(f.host.notify(address, process.cwd(), input, signal), /会话不存在/);
  assert.equal(f.starts.length, 1);
});
