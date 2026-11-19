import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ImStore } = await jiti.import("./store.ts");
const { ImRuntime, conversationKey } = await jiti.import("./runtime.ts");
const { parseImAction } = await jiti.import("./actions.ts");

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail("IM queue did not settle");
}

async function setup(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-im-runtime-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const file = join(cwd, "state.json");
  const store = await ImStore.open(file);
  const bot = { id: "wx", channel: "weixin", name: "Robot", enabled: true, cwd, allowedUserIds: ["owner"], allowedChatIds: [],
    credentials: { token: "test-only", ownerUserId: "owner", accountId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" } };
  const legacy = { ...bot, id: "tg", channel: "telegram", credentials: { token: "legacy", username: "legacy" } };
  await store.update((s) => { s.bots.push(bot, legacy); });
  const sessions = new Set(["existing"]);
  const created = [], notifications = [], sent = [], stopped = [];
  let driver;
  const host = {
    async exists(id, project) { return cwd === project && sessions.has(id); },
    async create() { const id = `create-${created.length}`; created.push(id); await options.creating?.(); sessions.add(id); return id; },
    async notify(handle, _cwd, input, signal) {
      notifications.push({ handle, input, signal });
      return { completion: options.completion ?? Promise.resolve() };
    },
    async stop(id) { stopped.push(id); },
  };
  const runtime = new ImRuntime(store, host, (config) => {
    assert.equal(config.bot.channel, "weixin");
    driver = config;
    return {
      start() { config.onStatus({ state: "connected" }); }, async stop() {},
      async send(recipient, text) { sent.push({ recipient, text }); },
      async sendAttachment(recipient, attachment) { if (options.failMedia) throw new Error("sensitive"); sent.push({ recipient, attachment }); },
    };
  });
  t.after(() => runtime.stop());
  await runtime.start();
  const message = (id, text) => ({ id, text, chatId: "owner", senderId: "owner", isGroup: false });
  const receive = (id, text, prepare) => driver.onMessage(message(id, text), prepare);
  return { runtime, store, file, cwd, bot, receive, created, notifications, sent, stopped, key: conversationKey(bot.id, message()) };
}

test("two inbound messages reuse the first new binding without waiting for the model or sending an automatic reply", async (t) => {
  const f = await setup(t, { completion: new Promise(() => {}) });
  await Promise.all([f.receive("1", "first"), f.receive("2", "second"), f.receive("2", "duplicate")]);
  await until(() => f.notifications.length === 2);
  assert.deepEqual(f.created, ["create-0"]);
  assert.deepEqual(f.notifications.map(({ handle, input }) => [handle.sessionId, input.text]), [["create-0", "first"], ["create-0", "second"]]);
  assert.notEqual(f.notifications[0].handle.id, f.notifications[1].handle.id);
  assert.equal((await (await ImStore.open(f.file)).read()).conversations[f.key].sessionId, "create-0");
  assert.deepEqual(f.sent, []);
});

test("existing bindings, local commands, and retired Telegram configuration use their own paths", async (t) => {
  const f = await setup(t);
  await f.receive("1", "/status");
  await until(() => f.sent.length === 1);
  await assert.rejects(f.runtime.bind(f.key, "foreign"), /项目/);
  await f.runtime.bind(f.key, "existing");
  await f.receive("2", "hello");
  await until(() => f.notifications.length === 1);
  assert.equal(f.notifications[0].handle.sessionId, "existing");
  assert.deepEqual(f.created, []);
  assert.deepEqual((await f.runtime.snapshot()).bots.map(({ id }) => id), ["wx"]);
  assert.deepEqual((await f.store.read()).bots.map(({ id }) => id), ["wx", "tg"]);
  assert.throws(() => parseImAction({ action: "add-telegram" }), /不支持/);
});

test("Stop discards pending notices and permits the next input after a cancelled creation", async (t) => {
  const { promise, resolve } = Promise.withResolvers();
  t.after(resolve);
  const f = await setup(t, { creating: () => promise });
  await f.receive("1", "first");
  await until(() => f.created.length === 1);
  await f.receive("2", "second");
  await f.receive("3", "/stop");
  await until(() => f.sent.length === 1);
  await f.receive("4", "after stop");
  resolve();
  await until(() => f.notifications.length === 1);
  assert.deepEqual(f.notifications.map(({ input }) => input.text), ["after stop"]);
  assert.equal((await f.store.read()).conversations[f.key].sessionId, "create-1");
});

test("store preserves concurrent updates and refuses to replace corrupt files", async (t) => {
  const f = await setup(t);
  await Promise.all([
    f.store.update((state) => { state.checkpoints.wx = { cursor: "a" }; }),
    f.store.update((state) => { state.seen.wx = ["b"]; }),
  ]);
  const saved = await (await ImStore.open(f.file)).read();
  assert.deepEqual(saved.checkpoints.wx, { cursor: "a" });
  assert.deepEqual(saved.seen.wx, ["b"]);
  if (process.platform !== "win32") assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  await writeFile(f.file, "broken");
  await assert.rejects(ImStore.open(f.file), /格式无效/);
  assert.equal((await stat(f.file)).size, 6);
});

test("explicit text and media sends report partial failure, and later success clears the delivery error", async (t) => {
  const f = await setup(t, { failMedia: true });
  await f.receive("1", "hello");
  await until(() => f.notifications.length === 1);
  const destination = { handle: f.notifications[0].handle };
  await writeFile(join(f.cwd, "file.txt"), "fixture");
  const result = await f.runtime.send(f.cwd, destination, [{ type: "text", text: "one" }, { type: "file", path: "file.txt" }, { type: "text", text: "three" }]);
  assert.equal(result.success, false);
  assert.deepEqual(result.results.map(({ status }) => status), ["sent", "failed", "not_attempted"]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  const snapshot = await f.runtime.snapshot();
  assert.equal(snapshot.bots[0].status.state, "connected");
  assert.ok(snapshot.bots[0].deliveryError);
  await assert.rejects(f.runtime.send("/foreign", { bot: "wx" }, [{ type: "text", text: "out" }]), /找不到/);
  await assert.rejects(f.runtime.send(f.cwd, { handle: { ...destination.handle, chatId: "other" } }, [{ type: "text", text: "out" }]), /找不到/);
  assert.equal((await f.runtime.send(f.cwd, { bot: "Robot" }, [{ type: "text", text: "two" }])).success, true);
  assert.deepEqual(f.sent.map(({ text, recipient }) => [text, recipient.chatId]), [["one", "owner"], ["two", "owner"]]);
  assert.equal((await f.runtime.snapshot()).bots[0].deliveryError, undefined);
});
