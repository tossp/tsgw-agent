import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { createTelegramDriver, verifyTelegramToken } = await createJiti(import.meta.url).import("./telegram.ts");

const TOKEN = "123456:synthetic-test-token";
const identity = { id: 900, is_bot: true, username: "Unit_Bot" };
const ok = (result) => Response.json({ ok: true, result });
const deferred = () => Promise.withResolvers();
async function until(predicate) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for driver");
    await delay(5);
  }
}
function pending(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function update(id, message = {}) {
  return {
    update_id: id,
    message: {
      message_id: 1_000 + id, from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" }, text: `message ${id}`, ...message,
    },
  };
}
function fixture(t, { batches = [], bot = {}, checkpoint = {}, onMessage, saveCheckpoint, intercept } = {}) {
  const calls = [], messages = [], saves = [], statuses = [], events = [];
  const options = {
    bot: {
      id: "telegram-test", channel: "telegram", name: "Test", cwd: "/tmp", enabled: true,
      allowedUserIds: ["42"], allowedChatIds: [],
      credentials: { token: TOKEN, username: "outdated_bot" }, ...bot,
    },
    checkpoint,
    async onMessage(message) {
      events.push(`message:${message.id}`);
      if (onMessage) await onMessage(message);
      messages.push(message);
    },
    async saveCheckpoint(value) {
      events.push(`save:${value.offset}`);
      if (saveCheckpoint) await saveCheckpoint(value);
      saves.push(structuredClone(value));
    },
    onStatus(status) { statuses.push(status); },
    async fetchImpl(url, init) {
      const call = { url: String(url), method: String(url).split("/").at(-1), init, body: JSON.parse(init.body) };
      calls.push(call);
      const result = await intercept?.(call);
      if (result !== undefined) return result;
      if (call.method === "getMe") return ok(identity);
      if (call.method === "getUpdates") return batches.length ? ok(batches.shift()) : pending(init.signal);
      if (call.method === "sendMessage") return ok({ message_id: calls.length });
      assert.fail("unexpected API method");
    },
  };
  const driver = createTelegramDriver(options);
  t.after(() => driver.stop());
  return { driver, calls, messages, saves, statuses, events, options,
    polls: () => calls.filter((call) => call.method === "getUpdates"),
    sends: () => calls.filter((call) => call.method === "sendMessage"),
  };
}

test("getMe verifies identity using real HTTP structure and returns only username", async () => {
  let call;
  assert.deepEqual(await verifyTelegramToken(TOKEN, async (url, init) => {
    call = { url, init };
    return ok(identity);
  }), { username: "Unit_Bot" });
  assert.equal(call.url, `https://api.telegram.org/bot${TOKEN}/getMe`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body), {});
  assert.ok(call.init.signal instanceof AbortSignal);
});

test("verification never exposes credential-bearing URLs, provider text or causes", async () => {
  const leak = `https://api.telegram.org/bot${TOKEN}/getMe`;
  for (const fetchImpl of [
    async () => { throw new Error(leak); },
    async () => Response.json({ ok: false, description: leak }, { status: 401 }),
    async () => Response.json({ ok: false, description: leak }),
    async () => new Response(leak),
    async () => ok({ ...identity, is_bot: false }),
    async () => ok({ ...identity, username: "" }),
    async () => ok(null),
  ]) {
    await assert.rejects(verifyTelegramToken(TOKEN, fetchImpl), (error) => {
      assert.doesNotMatch(error.stack, /synthetic-test-token|https:/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("restores offset, preserves checkpoint fields and admits before persisting", async (t) => {
  const admission = deferred(), persistence = deferred();
  const checkpoint = { offset: 8, retained: "value" };
  const f = fixture(t, {
    checkpoint, batches: [[update(7), update(8)]],
    onMessage: () => admission.promise,
    saveCheckpoint: () => persistence.promise,
  });
  f.driver.start();
  f.driver.start();
  await until(() => f.events.length === 1);
  assert.deepEqual(f.events, ["message:8"]);
  assert.equal(f.polls().length, 1);
  assert.deepEqual(f.polls()[0].body, { offset: 8, timeout: 25, limit: 100, allowed_updates: ["message"] });
  admission.resolve();
  await until(() => f.events.length === 2);
  assert.deepEqual(f.events, ["message:8", "save:9"]);
  assert.equal(f.polls().length, 1);
  persistence.resolve();
  await until(() => f.polls().length === 2);
  assert.deepEqual(f.saves, [{ offset: 9, retained: "value" }]);
  assert.equal(f.polls()[1].body.offset, 9);
  assert.deepEqual(checkpoint, { offset: 8, retained: "value" });
  assert.equal(f.calls.filter((call) => call.method === "getMe").length, 1);
  assert.equal(f.statuses[0].state, "connecting");
  assert.ok(f.statuses.some((status) => status.state === "connected"));
});

test("empty allowed users deny all; optional chat allowlist narrows permitted users", async (t) => {
  for (const [bot, expected] of [
    [{ allowedUserIds: [] }, []],
    [{ allowedChatIds: [] }, ["1", "2"]],
    [{ allowedChatIds: ["77"] }, ["2"]],
  ]) {
    const f = fixture(t, { bot, batches: [[
      update(1), update(2, { chat: { id: 77, type: "private" } }),
      update(3, { from: { id: 99 } }), update(4, { from: { id: 42, is_bot: true } }),
      update(5, { text: " \n " }), update(6, { text: undefined }),
    ]] });
    f.driver.start();
    await until(() => f.saves.length === 6);
    assert.deepEqual(f.messages.map((message) => message.id), expected);
    assert.equal(f.saves.at(-1).offset, 7);
    await f.driver.stop();
  }
});

test("group routing uses entities, bot identity, authorized sender and explicit commands", async (t) => {
  const group = { id: -100, type: "supergroup", title: "Topic group" };
  const mention = (text, target = "@uNiT_bOt") => ({
    text, entities: [{ type: "mention", offset: text.indexOf(target), length: target.length }],
  });
  const toBot = { from: { id: 900, is_bot: true } };
  const entries = [
    { text: "ambient" },
    { text: "@Unit_Bot untrusted raw text" },
    mention("🙂 @uNiT_bOt hello"),
    { text: "reply", reply_to_message: toBot },
    { text: "wrong reply", reply_to_message: { from: { id: 901, is_bot: true } } },
    { text: "/stop@UNIT_BOT" },
    { text: "/stop@other_bot", reply_to_message: toBot },
    { text: "/stop" },
    { ...mention("/stop @uNiT_bOt") },
    { ...mention("@uNiT_bOt") },
    { ...mention("@uNiT_bOt /stop@other_bot") },
    { ...mention("@uNiT_bOt /new@Unit_Bot") },
    { text: "/stop", reply_to_message: toBot },
    { ...mention("@uNiT_bOt deny"), from: { id: 99 } },
    { ...mention("@uNiT_bOt bot"), from: { id: 42, is_bot: true } },
    { ...mention("@uNiT_bOt_extra", "@uNiT_bOt_extra") },
    { text: "@Unit_Bot embedded", entities: [{ type: "text_mention", offset: 0, length: 9 }] },
  ];
  const f = fixture(t, { batches: [entries.map((entry, index) => update(index + 1, {
    chat: group, message_thread_id: 321, ...entry,
  }))] });
  f.driver.start();
  await until(() => f.saves.length === entries.length);
  assert.deepEqual(f.messages.map(({ id, text }) => [id, text]), [
    ["3", "🙂  hello"], ["4", "reply"], ["6", "/stop"], ["9", "/stop"],
    ["12", "/new"], ["13", "/stop"],
  ]);
  assert.deepEqual(f.messages[0], {
    id: "3", messageId: "1003", chatId: "-100", senderId: "42", text: "🙂  hello", isGroup: true,
    threadId: "321", chatTitle: "Topic group",
  });
});

test("private commands pass to runtime and foreign bot commands are refused", async (t) => {
  const f = fixture(t, { batches: [[
    update(1, { text: "/stop" }), update(2, { text: "/new@Unit_Bot argument" }),
    update(3, { text: "/stop@other_bot" }),
  ]] });
  f.driver.start();
  await until(() => f.saves.length === 3);
  assert.deepEqual(f.messages.map((message) => message.text), ["/stop", "/new argument"]);
});

test("plain long replies split within 4096 preserving Unicode and Topic payloads", async (t) => {
  const f = fixture(t);
  f.driver.start();
  await until(() => f.polls().length === 1);
  const message = { id: "1", senderId: "42", chatId: "-100", isGroup: true, threadId: "321", text: "ask" };
  const text = "a".repeat(4095) + "🙂" + "<b>not HTML</b> *not markdown*".repeat(180);
  await f.driver.send(message, text);
  const chunks = f.sends().map((call) => call.body.text);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(""), text);
  assert.equal(chunks[0].length, 4095);
  for (const call of f.sends()) {
    assert.equal(call.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(Object.keys(call.body).sort(), ["chat_id", "message_thread_id", "text"]);
    assert.equal(call.body.chat_id, "-100");
    assert.equal(call.body.message_thread_id, 321);
    assert.ok(call.body.text.length <= 4096);
    assert.equal(call.body.text.isWellFormed(), true);
    assert.equal(call.init.signal.aborted, false);
  }
  await f.driver.send({ ...message, threadId: undefined, chatId: "42" }, "direct");
  assert.deepEqual(f.sends().at(-1).body, { chat_id: "42", text: "direct" });
  const count = f.sends().length;
  await f.driver.send(message, " \n ");
  assert.equal(f.sends().length, count);
});

test("save failure blocks further updates and retries save without duplicate admission", async (t) => {
  let attempts = 0;
  const gate = deferred();
  const f = fixture(t, { batches: [[update(1), update(2)]], saveCheckpoint: async () => {
    attempts++;
    if (attempts === 1) throw new Error(TOKEN);
    if (attempts === 2) await gate.promise;
  } });
  f.driver.start();
  await until(() => attempts === 2);
  assert.deepEqual(f.messages.map((message) => message.id), ["1"]);
  assert.equal(f.polls().length, 1);
  assert.deepEqual(f.saves, []);
  assert.ok(f.statuses.some((status) => status.error === "Telegram checkpoint save failed"));
  gate.resolve();
  await until(() => f.polls().length === 2);
  assert.deepEqual(f.events, ["message:1", "save:2", "save:2", "message:2", "save:3"]);
  assert.deepEqual(f.saves, [{ offset: 2 }, { offset: 3 }]);
  assert.equal(f.polls()[1].body.offset, 3);
  assert.doesNotMatch(JSON.stringify(f.statuses), /synthetic-test-token|https:/);
});

test("admission rejection does not advance cursor and retries before the next message", async (t) => {
  let attempts = 0;
  const f = fixture(t, { batches: [[update(1), update(2)]], onMessage: async () => {
    if (++attempts === 1) throw new Error(TOKEN);
  } });
  f.driver.start();
  await until(() => f.statuses.some((status) => status.state === "error"));
  assert.deepEqual(f.saves, []);
  assert.equal(f.polls().length, 1);
  await until(() => f.polls().length === 2);
  assert.deepEqual(f.events, ["message:1", "message:1", "save:2", "message:2", "save:3"]);
});

test("network failure reconnects with saved offset and sanitized statuses", async (t) => {
  let failed = false;
  const f = fixture(t, { checkpoint: { offset: 10 }, batches: [[update(10)]], intercept(call) {
    if (call.method === "getUpdates" && !failed) {
      failed = true;
      throw new Error(call.url);
    }
  } });
  f.driver.start();
  await until(() => f.polls().length === 3);
  assert.deepEqual(f.polls().map((call) => call.body.offset), [10, 10, 11]);
  assert.deepEqual(f.statuses.slice(0, 5).map((status) => status.state),
    ["connecting", "connected", "error", "connecting", "connected"]);
  assert.doesNotMatch(JSON.stringify(f.statuses), /synthetic-test-token|https:/);
});

test("stop aborts polling, prevents sends, and restart uses the persisted cursor", async (t) => {
  const first = fixture(t, { batches: [[update(40)]] });
  first.driver.start();
  await until(() => first.polls().length === 2);
  const signal = first.polls()[1].init.signal;
  await first.driver.stop();
  assert.equal(signal.aborted, true);
  assert.equal(first.statuses.at(-1).state, "stopped");
  assert.equal(first.sends().length, 0);
  await assert.rejects(first.driver.send(first.messages[0], "after stop"), /stopped/);
  first.driver.start();
  await until(() => first.polls().length === 3);
  assert.equal(first.polls()[2].body.offset, 41);
  await first.driver.stop();
  const restored = fixture(t, { checkpoint: first.saves.at(-1) });
  restored.driver.start();
  await until(() => restored.polls().length === 1);
  assert.equal(restored.polls()[0].body.offset, 41);
});

test("stop cancels getMe, backoff and in-flight send without sending shutdown messages", async (t) => {
  for (const method of ["getMe", "getUpdates", "sendMessage"]) {
    const f = fixture(t, { intercept(call) {
      if (call.method === method) return pending(call.init.signal);
    } });
    f.driver.start();
    await until(() => f.calls.some((call) => call.method === method) || method === "sendMessage" && f.polls().length);
    let sending;
    if (method === "sendMessage") {
      sending = assert.rejects(f.driver.send({ chatId: "42", text: "", id: "1", senderId: "42", isGroup: false }, "send"), /Telegram sendMessage failed/);
      await until(() => f.sends().length === 1);
    }
    await f.driver.stop();
    if (sending) await sending;
    assert.equal(f.calls.find((call) => call.method === method).init.signal.aborted, true);
    assert.equal(f.statuses.at(-1).state, "stopped");
    assert.equal(f.sends().length, method === "sendMessage" ? 1 : 0);
  }
  const f = fixture(t, { intercept() { throw new Error(TOKEN); } });
  f.driver.start();
  await until(() => f.statuses.some((status) => status.state === "error"));
  await f.driver.stop();
  assert.equal(f.calls.length, 1);
  assert.equal(f.statuses.at(-1).state, "stopped");
});

test("failed send is never retried and errors cannot expose the URL", async (t) => {
  const f = fixture(t, { intercept(call) {
    if (call.method === "sendMessage") throw new Error(call.url);
  } });
  f.driver.start();
  await until(() => f.polls().length === 1);
  await assert.rejects(f.driver.send({ chatId: "42", text: "", id: "1", senderId: "42", isGroup: false }, "a".repeat(9_000)), (error) => {
    assert.doesNotMatch(error.stack, /synthetic-test-token|https:/);
    return true;
  });
  assert.equal(f.sends().length, 1);
});

test("stopping after admission still persists that update before resolving stop", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = fixture(t, { batches: [[update(1), update(2)]], onMessage: () => gate.promise });
  f.driver.start();
  await until(() => f.events.length === 1);
  const stopping = f.driver.stop();
  gate.resolve();
  await stopping;
  assert.deepEqual(f.events, ["message:1", "save:2"]);
  assert.deepEqual(f.saves, [{ offset: 2 }]);
  assert.equal(f.statuses.at(-1).state, "stopped");
  assert.equal(f.polls().length, 1);
});

test("persistent save failure can be stopped without acknowledging or consuming further updates", async (t) => {
  const f = fixture(t, { checkpoint: { offset: 1 }, batches: [[update(1), update(2)]],
    saveCheckpoint: async () => { throw new Error(TOKEN); },
  });
  f.driver.start();
  await until(() => f.statuses.some((status) => status.state === "error"));
  await f.driver.stop();
  assert.deepEqual(f.events, ["message:1", "save:2"]);
  assert.deepEqual(f.saves, []);
  assert.equal(f.polls().length, 1);
  f.driver.start();
  await until(() => f.polls().length === 2);
  assert.equal(f.polls()[1].body.offset, 1);
  assert.doesNotMatch(JSON.stringify(f.statuses), /synthetic-test-token|https:/);
});

test("unsupported updates are checkpointed without dispatching", async (t) => {
  const f = fixture(t, { batches: [[{ update_id: 20, edited_message: update(20).message }]] });
  f.driver.start();
  await until(() => f.polls().length === 2);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.saves, [{ offset: 21 }]);
  assert.equal(f.polls()[1].body.offset, 21);
});

test("disabled bot never connects", async (t) => {
  const f = fixture(t, { bot: { enabled: false } });
  f.driver.start();
  assert.deepEqual(f.statuses, [{ state: "stopped" }]);
  assert.deepEqual(f.calls, []);
});
