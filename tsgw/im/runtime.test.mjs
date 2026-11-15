import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ImStore } = await jiti.import("./store.ts");
const { ImRuntime, conversationKey } = await jiti.import("./runtime.ts");
const { ImService } = await jiti.import("./service.ts");
const { parseImAction } = await jiti.import("./actions.ts");
const { createPiSessionHost } = await jiti.import("./pi-host.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "im.json");
  const store = await ImStore.open(file);
  const sent = [], prompts = [], creates = [], stopped = [];
  const sessions = new Map([["existing", directory], ["foreign", "/other-project"]]);
  const host = {
    async list(cwd) { return [...sessions].filter(([, path]) => path === cwd).map(([id]) => ({ id, cwd, title: id })); },
    async exists(id, cwd) { return sessions.get(id) === cwd; },
    async create(cwd) {
      const id = `new-${creates.length}`;
      creates.push(id);
      await options.create?.();
      sessions.set(id, cwd);
      return id;
    },
    async prompt(id, text, signal, source) { prompts.push({ id, text, signal, source }); return options.prompt ? options.prompt(id, text, signal) : "回答"; },
    async stop(id) { stopped.push(id); options.stop?.(); },
  };
  const drivers = new Map();
  const factory = (config) => {
    drivers.set(config.bot.id, config);
    return { start() { config.onStatus({ state: "connected" }); }, async stop() {}, async send(message, text) { sent.push({ botId: config.bot.id, message, text }); } };
  };
  const runtime = new ImRuntime(store, host, { telegram: factory, weixin: factory });
  t.after(() => runtime.stop());
  const bot = {
    id: "bot", channel: "telegram", name: "TG", cwd: directory, enabled: true,
    allowedUserIds: ["42"], allowedChatIds: [], credentials: { token: "123:secret", username: "test_bot" },
  };
  await store.update((state) => { state.bots.push(bot); });
  await runtime.start();
  const message = (id, text, chatId = "42", threadId) => ({ id, text, chatId, threadId, senderId: "42", isGroup: chatId !== "42" });
  const receive = (value, botId = "bot") => drivers.get(botId).onMessage(value);
  return { directory, file, store, runtime, host, sent, prompts, creates, stopped, drivers, bot, message, receive };
}

async function eventually(check) {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) assert.fail("operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("project chat creates once, resumes its own binding after restart, and deduplicates input", async (t) => {
  const f = await fixture(t);
  await f.receive({ ...f.message("1", "hello"), messageId: "native-123" });
  await eventually(() => f.sent.length === 1);
  await f.receive(f.message("1", "hello"));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].text, "hello");
  assert.deepEqual(f.prompts[0].source, {
    channel: "telegram", botId: "bot", botName: "TG", chatId: "42", senderId: "42", messageId: "native-123",
  });
  const snapshot = await f.runtime.snapshot();
  assert.equal(snapshot.conversations[0].cwd, f.directory);
  assert.equal(snapshot.conversations[0].sessionId, "new-0");
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  await f.runtime.stop();
  const reopened = await ImStore.open(f.file);
  const next = new ImRuntime(reopened, f.host, {
    telegram(config) { f.drivers.set("bot", config); return { start() {}, async stop() {}, async send() {} }; },
    weixin() { throw new Error("unused"); },
  });
  t.after(() => next.stop());
  await next.start();
  await f.receive(f.message("2", "continue"));
  await eventually(() => f.prompts.length === 2);
  assert.equal(f.prompts[1].id, "new-0");
  assert.equal(f.creates.length, 1);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});

test("private chats, group Topics and bot instances have independent bindings", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => { state.bots.push({ ...f.bot, id: "second" }); });
  await f.runtime.restart("second");
  await f.receive(f.message("1", "private"));
  await f.receive(f.message("2", "topic A", "-100", "10"));
  await f.receive(f.message("3", "topic B", "-100", "20"));
  await f.receive(f.message("1", "other bot"), "second");
  await eventually(() => f.sent.length === 4);
  assert.equal(new Set(f.prompts.map((call) => call.id)).size, 4);
  assert.equal((await f.runtime.snapshot()).conversations.length, 4);
});

test("WeChat and Telegram sharing one Pi session reply only to their own original chat and Topic", async (t) => {
  const f = await fixture(t);
  await f.store.update((state) => state.bots.push({
    ...f.bot, id: "wx", channel: "weixin", name: "WX",
    credentials: { token: "wx-secret", baseUrl: "https://example.invalid", accountId: "wx", ownerUserId: "42" },
  }));
  await f.runtime.restart("wx");
  const tg = f.message("tg-status", "/status", "-100", "7");
  const wx = f.message("wx-status", "/status", "wx-owner");
  await f.receive(tg);
  await f.receive(wx, "wx");
  await eventually(() => f.sent.length === 2);
  await f.runtime.bind(conversationKey("bot", tg), "existing");
  await f.runtime.bind(conversationKey("wx", wx), "existing");
  f.sent.length = 0;
  await f.receive({ ...tg, id: "tg-input", text: "same input" });
  await eventually(() => f.sent.length === 1);
  await f.receive({ ...wx, id: "wx-input", text: "same input" }, "wx");
  await eventually(() => f.sent.length === 2);
  assert.deepEqual(f.prompts.map(({ id, text, source }) => [id, text, source.channel]), [
    ["existing", "same input", "telegram"], ["existing", "same input", "weixin"],
  ]);
  assert.deepEqual(f.sent.map(({ botId, message }) => [botId, message.chatId, message.threadId]), [
    ["bot", "-100", "7"], ["wx", "wx-owner", undefined],
  ]);
  assert.ok(!JSON.stringify(f.prompts.map(({ source }) => source)).includes("secret"));
  assert.equal(f.creates.length, 0);
});

test("manual binding uses only a session in the selected project; new unbinds without deleting it", async (t) => {
  const f = await fixture(t);
  await f.receive(f.message("1", "/status"));
  await eventually(() => f.sent.length === 1);
  const key = conversationKey("bot", f.message("1", ""));
  await f.runtime.bind(key, "existing");
  await assert.rejects(f.runtime.bind(key, "foreign"), /项目/);
  await f.receive(f.message("2", "continue existing"));
  await eventually(() => f.sent.length === 2);
  assert.equal(f.prompts[0].id, "existing");
  assert.equal(f.creates.length, 0);
  await f.receive(f.message("3", "/new"));
  await eventually(() => f.sent.length === 3);
  await f.receive(f.message("4", "new task"));
  await eventually(() => f.sent.length === 4);
  assert.equal(f.prompts[1].id, "new-0");
  assert.equal(await f.host.exists("existing", f.directory), true);
});

test("stop bypasses an active prompt and withdraws older queued chat inputs", async (t) => {
  let finish;
  const f = await fixture(t, {
    prompt: () => new Promise((resolve) => { finish = resolve; }),
    stop: () => finish("已停止"),
  });
  await f.receive(f.message("1", "long task"));
  await eventually(() => f.prompts.length === 1);
  await f.receive(f.message("2", "queued task"));
  await f.receive(f.message("3", "/stop"));
  await eventually(() => f.stopped.length === 1 && f.sent.length === 1);
  assert.equal(f.prompts[0].signal.aborted, true);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.stopped[0], "new-0");
});

test("stop during creation cancels the current and queued requests but accepts later input", async (t) => {
  const creation = deferred();
  const f = await fixture(t, { create: () => creation.promise });
  await f.receive(f.message("1", "first"));
  await eventually(() => f.creates.length === 1);
  await f.receive(f.message("2", "queued"));
  await f.receive(f.message("3", "/stop"));
  await eventually(() => f.sent.length === 1);
  creation.resolve();
  await f.receive(f.message("4", "/status"));
  await eventually(() => f.sent.length === 2);
  assert.equal((await f.runtime.snapshot()).conversations[0].sessionId, null);
  assert.equal(f.prompts.length, 0);
  await f.receive(f.message("5", "after stop"));
  await eventually(() => f.sent.length === 3);
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0].text, /after stop$/);
});

for (const operation of ["project", "disable", "remove"]) {
  test(`${operation} during creation cannot restore an old binding or submit a prompt`, async (t) => {
    const creation = deferred();
    const f = await fixture(t, { create: () => creation.promise });
    await f.receive(f.message("1", "first"));
    await eventually(() => f.creates.length === 1);
    const service = new ImService(f.runtime, {});
    await service.action(operation === "remove" ? { action: "remove-bot", botId: "bot" } : {
      action: "update-bot", botId: "bot", name: "TG", cwd: operation === "project" ? tmpdir() : f.directory,
      enabled: operation === "project", allowedUserIds: ["42"], allowedChatIds: [],
    });
    creation.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const view = await f.runtime.snapshot();
    assert.equal(f.prompts.length, 0);
    assert.equal(f.sent.length, 0);
    if (operation === "remove") assert.deepEqual(view.conversations, []);
    else {
      assert.equal(view.conversations[0].sessionId, null);
      assert.equal(view.conversations[0].cwd, operation === "project" ? tmpdir() : f.directory);
    }
  });
}

test("cancellation is rechecked inside a queued binding write", async (t) => {
  const f = await fixture(t);
  const reachedWrite = deferred(), releaseWrite = deferred();
  const update = f.store.update.bind(f.store);
  let held = false;
  f.store.update = (change) => {
    if (f.creates.length && !held) {
      held = true;
      reachedWrite.resolve();
      return releaseWrite.promise.then(() => update(change));
    }
    return update(change);
  };
  await f.receive(f.message("1", "first"));
  await reachedWrite.promise;
  await f.runtime.stop("bot");
  releaseWrite.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.runtime.snapshot()).conversations[0].sessionId, null);
  assert.equal(f.prompts.length, 0);
});

test("stop cancels an IM request waiting for a shared Web run before aborting that run", async (t) => {
  const f = await fixture(t);
  await f.receive(f.message("1", "/status"));
  await eventually(() => f.sent.length === 1);
  await f.runtime.bind(conversationKey("bot", f.message("1", "")), "existing");
  const listeners = new Set(), commands = [];
  let running = true;
  const wrapper = {
    isAlive: () => true, isRunning: () => running,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async send(command) {
      commands.push(command.type);
      if (command.type === "abort") {
        running = false;
        for (const listener of listeners) listener({ type: "prompt_done", aborted: true });
      }
    },
  };
  const host = createPiSessionHost({
    list: async () => [{ id: "existing", cwd: f.directory, firstMessage: "Web" }],
    get: async () => wrapper,
  });
  f.host.prompt = host.prompt;
  f.host.stop = host.stop;
  await f.receive(f.message("2", "must not submit"));
  await eventually(() => listeners.size > 0);
  await f.receive(f.message("3", "/stop"));
  await eventually(() => f.sent.length === 2);
  await f.receive(f.message("4", "/status"));
  await eventually(() => f.sent.length === 3);
  assert.deepEqual(commands, ["abort"]);
  assert.equal(listeners.size, 0);
});

test("changing bot project clears old bindings, disabling it stops its driver", async (t) => {
  const f = await fixture(t);
  await f.receive(f.message("1", "hi"));
  await eventually(() => f.sent.length === 1);
  const other = await mkdtemp(join(tmpdir(), "pi-im-project-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const service = new ImService(f.runtime, {});
  await service.action({ action: "update-bot", botId: "bot", name: "TG", cwd: other, enabled: false, allowedUserIds: ["42"], allowedChatIds: [] });
  const view = await f.runtime.snapshot();
  assert.equal(view.bots[0].status.state, "stopped");
  assert.equal(view.conversations[0].cwd, other);
  assert.equal(view.conversations[0].sessionId, null);
  assert.equal(await f.host.exists("new-0", f.directory), true);
});

test("concurrent store updates persist together and corrupt files are never replaced", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    f.store.update((state) => { state.checkpoints.bot = { offset: 5 }; }),
    f.store.update((state) => { state.seen.bot = ["accepted"]; }),
  ]);
  const data = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(data.checkpoints.bot.offset, 5);
  assert.deepEqual(data.seen.bot, ["accepted"]);
  const invalid = join(f.directory, "invalid.json");
  await writeFile(invalid, '{"token":"secret"');
  await assert.rejects(ImStore.open(invalid), (error) => /格式无效/.test(error.message) && !error.message.includes("secret"));
  assert.equal(await readFile(invalid, "utf8"), '{"token":"secret"');
});

test("management input rejects token URL injection, non-ID allowlists and ambiguous bind values", () => {
  assert.throws(() => parseImAction({ action: "add-telegram", token: "https://token", cwd: "/tmp" }), /Token/);
  assert.throws(() => parseImAction({ action: "update-bot", botId: "b", cwd: "/tmp", enabled: true, allowedUserIds: [42] }), /数组/);
  assert.throws(() => parseImAction({ action: "bind", conversationKey: "c" }), /sessionId/);
  assert.deepEqual(parseImAction({ action: "bind", conversationKey: "c", sessionId: null }), { action: "bind", conversationKey: "c", sessionId: null });
});
