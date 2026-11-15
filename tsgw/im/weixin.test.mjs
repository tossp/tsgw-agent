import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWeixinDriver } = await jiti.import("./weixin.ts");
const { createWeixinLogin } = await jiti.import("./weixin-login.ts");
const { weixinRequest } = await jiti.import("./weixin-transport.ts");

const credentials = {
  token: "private-bot-token", accountId: "bot@im.bot", ownerUserId: "owner@im.wechat",
  baseUrl: "https://ilinkai.weixin.qq.com/",
};
const inbound = { id: "m1", chatId: credentials.ownerUserId, senderId: credentials.ownerUserId, text: "hello", isGroup: false };
const bot = { id: "wx", channel: "weixin", name: "test", cwd: "/tmp", enabled: true,
  allowedUserIds: [], allowedChatIds: [], credentials };
const qrPayload = { qrcode: "private-qr-token/&=", qrcode_img_content: "https://ilinkai.weixin.qq.com/qr?ticket=private" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const textItem = (text) => ({ type: 1, text_item: { text } });
const message = (overrides = {}) => ({
  message_id: "m1", from_user_id: credentials.ownerUserId, to_user_id: credentials.accountId,
  message_type: 1, context_token: "private-context", item_list: [textItem("hello")], ...overrides,
});
function blocked(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("fake abort", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
function fake(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: new URL(url), ...init, headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetchImpl, calls };
}
async function until(condition) {
  const end = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() >= end) assert.fail("timed out waiting for fake transport");
    await delay(5);
  }
}
function harness(fetchImpl, overrides = {}) {
  const received = [], statuses = [], checkpoints = [];
  const driver = createWeixinDriver({
    bot, checkpoint: {}, fetchImpl,
    onMessage: async (m) => { received.push(m); },
    onStatus: (s) => { statuses.push(s); },
    saveCheckpoint: async (c) => { checkpoints.push(structuredClone(c)); },
    ...overrides,
  });
  return { driver, received, statuses, checkpoints };
}
function checkHeaders(call, authenticated) {
  assert.equal(call.headers.get("ilink-app-id"), "bot");
  assert.equal(call.headers.get("ilink-app-clientversion"), "132102");
  assert.equal(call.headers.get("authorization"), authenticated ? `Bearer ${credentials.token}` : null);
  if (call.method === "POST") {
    assert.equal(call.headers.get("content-type"), "application/json");
    assert.equal(call.headers.get("authorizationtype"), "ilink_bot_token");
    const uin = Buffer.from(call.headers.get("x-wechat-uin"), "base64").toString();
    assert.match(uin, /^\d+$/);
    assert.ok(Number(uin) >= 0 && Number(uin) <= 0xffffffff);
  } else {
    assert.equal(call.headers.get("authorizationtype"), null);
    assert.equal(call.headers.get("x-wechat-uin"), null);
  }
  assert.equal(call.redirect, "error");
  assert.ok(call.signal instanceof AbortSignal);
}

test("QR uses POST/body/version, preserves redirect host, maps confirmed credentials", async () => {
  const responses = [qrPayload, { status: "wait" }, { status: "scaned" },
    { status: "scaned_but_redirect", redirect_host: "regional.weixin.qq.com" },
    { status: "confirmed", bot_token: credentials.token, ilink_bot_id: credentials.accountId,
      ilink_user_id: credentials.ownerUserId, baseurl: "https://regional.weixin.qq.com/" }];
  const f = fake(() => json(responses.shift()));
  const login = await createWeixinLogin(f);
  assert.deepEqual(Object.keys(login).sort(), ["poll", "qrUrl"]);
  assert.equal(login.qrUrl, qrPayload.qrcode_img_content);
  assert.equal((await login.poll()).state, "waiting");
  assert.equal((await login.poll()).state, "scanned");
  assert.equal((await login.poll()).state, "scanned");
  const connected = await login.poll();
  assert.deepEqual(connected, { state: "connected", credentials: { ...credentials, baseUrl: "https://regional.weixin.qq.com/" } });
  assert.deepEqual(await login.poll(), connected);
  assert.equal(f.calls.length, 5);
  const [initial, ...polls] = f.calls;
  assert.equal(initial.url.origin, "https://ilinkai.weixin.qq.com");
  assert.equal(initial.url.pathname, "/ilink/bot/get_bot_qrcode");
  assert.equal(initial.url.searchParams.get("bot_type"), "3");
  assert.deepEqual(initial.body, { local_token_list: [] });
  for (const call of f.calls) checkHeaders(call, false);
  for (const call of polls) {
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    assert.equal(call.url.pathname, "/ilink/bot/get_qrcode_status");
    assert.equal(call.url.searchParams.get("qrcode"), qrPayload.qrcode);
  }
  assert.equal(polls.at(-1).url.hostname, "regional.weixin.qq.com");
});

test("QR expiry and simultaneous polling have stable state", async () => {
  let release;
  const f = fake((_, count) => count === 1 ? json(qrPayload) : new Promise((r) => { release = r; }));
  const login = await createWeixinLogin(f);
  const one = login.poll(), two = login.poll();
  assert.equal(one, two);
  release(json({ status: "expired" }));
  assert.deepEqual(await one, { state: "expired" });
  assert.deepEqual(await login.poll(), { state: "expired" });
  assert.equal(f.calls.length, 2);
});

test("QR rejects incomplete credentials, unsafe redirect, verification and provider secrets", async () => {
  for (const response of [
    { status: "confirmed", bot_token: "leak" },
    { status: "scaned_but_redirect", redirect_host: "https://weixin.qq.com.evil.test/?leak" },
    { status: "need_verifycode" }, { status: "confirmed_but_need_verifycode" },
    { status: "verify_code_blocked" }, { status: "binded_redirect" },
    { ret: -1, errmsg: "leak" }, { status: "leak" },
  ]) {
    const f = fake((_, count) => json(count === 1 ? qrPayload : response));
    const login = await createWeixinLogin(f);
    await assert.rejects(login.poll(), (error) => {
      assert.doesNotMatch(String(error.stack), /leak|private|https:/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.calls.length, 2);
  }
});

test("QR cancellation aborts initial request and status poll without leaking reason", async () => {
  for (const afterInitial of [false, true]) {
    const controller = new AbortController();
    const f = fake((call, count) => afterInitial && count === 1 ? json(qrPayload) : blocked(call.signal));
    const opening = createWeixinLogin({ ...f, signal: controller.signal });
    const pending = afterInitial ? (await opening).poll() : opening;
    controller.abort(new Error("private-token https://secret.example"));
    await assert.rejects(pending, (e) => e.name === "AbortError" && !/private|https/.test(String(e.stack)));
    assert.ok(f.calls.at(-1).signal.aborted);
  }
});

test("real driver filters owner/type, persists private context and cursor, sends text chunks", async (t) => {
  const f = fake((call, count) => {
    if (call.url.pathname.endsWith("sendmessage")) return json({ ret: 0 });
    return count === 1 ? json({ ret: 0, get_updates_buf: "cursor-next", msgs: [
      message({ from_user_id: "stranger", message_id: "bad", context_token: "attacker" }),
      message({ message_type: 2, message_id: "echo" }),
      message({ to_user_id: "other-bot", message_id: "wrong-target" }),
      message({ message_id: "media", context_token: "older", item_list: [{ type: 2, image_item: {} }] }),
      message({ item_list: [textItem("hello"), { type: 3, voice_item: { text: "not text" } }, textItem("world")] }),
    ] }) : blocked(call.signal);
  });
  const h = harness(f.fetchImpl);
  t.after(() => h.driver.stop());
  h.driver.start(); h.driver.start();
  await until(() => f.calls.length === 2);
  assert.deepEqual(h.received, [{ ...inbound, text: "hello\nworld" }]);
  assert.doesNotMatch(JSON.stringify([h.received, h.statuses]), /private|context_token/);
  const saved = h.checkpoints.at(-1).weixin;
  assert.equal(saved.cursor, "cursor-next");
  assert.deepEqual(saved.contexts, { [credentials.ownerUserId]: "private-context" });
  assert.equal(f.calls[1].body.get_updates_buf, "cursor-next");
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(f.calls[0].body, { get_updates_buf: "", base_info: { channel_version: "2.4.6", bot_agent: "TSGW-Agent/0.1.0" } });
  const reply = "你".repeat(1750) + "\n" + "😀".repeat(1850) + " done";
  await h.driver.send(inbound, reply);
  const sends = f.calls.filter((c) => c.url.pathname.endsWith("sendmessage"));
  assert.equal(sends.length, 3);
  assert.equal(sends.map((s) => s.body.msg.item_list[0].text_item.text).join(""), reply);
  for (const call of f.calls) checkHeaders(call, true);
  for (const call of sends) {
    const msg = call.body.msg;
    assert.ok(Array.from(msg.item_list[0].text_item.text).length <= 1800);
    assert.equal(msg.context_token, "private-context");
    assert.equal(msg.to_user_id, credentials.ownerUserId);
    assert.equal(msg.from_user_id, "");
    assert.equal(msg.message_type, 2); assert.equal(msg.message_state, 2);
    assert.equal(msg.item_list[0].type, 1);
    assert.match(msg.client_id, /^tsgw-weixin-/);
  }
  assert.equal(new Set(sends.map((s) => s.body.msg.client_id)).size, sends.length);
  await assert.rejects(h.driver.send({ ...inbound, chatId: "stranger" }, "unsafe"), /接收者/);
  await assert.rejects(h.driver.send({ ...inbound, senderId: "stranger" }, "unsafe"), /接收者/);
  await h.driver.stop();
  assert.ok(f.calls[1].signal.aborted);
  assert.equal(h.statuses.at(-1).state, "stopped");
  await assert.rejects(h.driver.send(inbound, "late"), { name: "AbortError" });
});

test("uint64 message IDs remain distinct; replay cannot roll context or cursor back", async (t) => {
  const ids = ["9223372036854775808", "9223372036854775809"];
  const raw = JSON.stringify({ msgs: [
    message({ message_id: "HUGE1", context_token: "first-context" }),
    message({ message_id: "HUGE2", context_token: "latest-context", item_list: [textItem('literal {"message_id":9223372036854775808}')] }),
  ], get_updates_buf: "stable-cursor" }).replace('"HUGE1"', ids[0]).replace('"HUGE2"', ids[1]);
  const f = fake((call, count) => {
    if (call.url.pathname.endsWith("sendmessage")) return json({ ret: 0 });
    if (count === 1) return new Response(raw);
    if (count === 2) return json({ msgs: [message({ message_id: ids[0], context_token: "first-context" })], get_updates_buf: "" });
    return blocked(call.signal);
  });
  const h = harness(f.fetchImpl);
  h.driver.start();
  t.after(() => h.driver.stop());
  await until(() => f.calls.length === 3);
  assert.deepEqual(h.received.map((m) => m.id), ids);
  assert.equal(h.received[1].text, 'literal {"message_id":9223372036854775808}');
  assert.equal(f.calls[2].body.get_updates_buf, "stable-cursor");
  await h.driver.send(h.received[1], "reply");
  assert.equal(f.calls.at(-1).body.msg.context_token, "latest-context");
  await h.driver.stop();
});

test("checkpoint restores cursor/context/dedup; rotated login discards capabilities", async (t) => {
  const first = fake((call, count) => count === 1
    ? json({ msgs: [message()], get_updates_buf: "restored-cursor" }) : blocked(call.signal));
  const original = harness(first.fetchImpl);
  original.driver.start();
  t.after(() => original.driver.stop());
  await until(() => first.calls.length === 2);
  await original.driver.stop();
  const checkpoint = original.checkpoints.at(-1);
  for (const rotated of [false, true]) {
    const f = fake((call, count) => call.url.pathname.endsWith("sendmessage") ? json({ ret: 0 })
      : count === 1 ? json({ msgs: [message({ context_token: undefined })], get_updates_buf: "after" }) : blocked(call.signal));
    const h = harness(f.fetchImpl, { checkpoint, bot: rotated ? { ...bot, credentials: { ...credentials, token: "new-token" } } : bot });
    h.driver.start();
    t.after(() => h.driver.stop());
    await until(() => f.calls.length === 2);
    assert.equal(f.calls[0].body.get_updates_buf, rotated ? "" : "restored-cursor");
    assert.equal(h.received.length, rotated ? 1 : 0);
    if (rotated) await assert.rejects(h.driver.send(inbound, "reply"), /先向微信机器人/);
    else {
      await h.driver.send(inbound, "reply");
      assert.equal(f.calls.at(-1).body.msg.context_token, "private-context");
    }
    await h.driver.stop();
  }
});

test("cursor waits for receipt acknowledgement; checkpoint failures expose no secret", async (t) => {
  let accept;
  const f = fake((call, count) => count === 1 ? json({ msgs: [message()], get_updates_buf: "next" }) : blocked(call.signal));
  const h = harness(f.fetchImpl, { onMessage: () => new Promise((r) => { accept = r; }) });
  h.driver.start();
  t.after(() => h.driver.stop());
  await until(() => accept);
  assert.equal(h.checkpoints.at(-1).weixin.cursor, "");
  assert.equal(f.calls.length, 1);
  accept();
  await until(() => f.calls.length === 2);
  assert.equal(h.checkpoints.at(-1).weixin.cursor, "next");
  await h.driver.stop();
  const broken = harness(async () => json({ msgs: [message()], get_updates_buf: "never" }), {
    saveCheckpoint: async () => { throw new Error("private-context"); },
  });
  broken.driver.start();
  t.after(() => broken.driver.stop());
  await until(() => broken.statuses.some((s) => s.state === "error"));
  assert.doesNotMatch(JSON.stringify(broken.statuses), /private/);
  assert.equal(broken.received.length, 0);
  await broken.driver.stop();
});

test("stop cancels send and all queued chunks; restart gets a new live signal", async (t) => {
  const f = fake((call, count) => count === 1 ? json({ msgs: [message()], get_updates_buf: "ready" }) : blocked(call.signal));
  const h = harness(f.fetchImpl);
  h.driver.start();
  t.after(() => h.driver.stop());
  await until(() => f.calls.length === 2);
  const sending = h.driver.send(inbound, "x".repeat(3601));
  const queued = h.driver.send(inbound, "queued");
  const rejected = Promise.all([assert.rejects(sending, { name: "AbortError" }), assert.rejects(queued, { name: "AbortError" })]);
  await until(() => f.calls.length === 3);
  const stopping = h.driver.stop();
  assert.equal(h.driver.stop(), stopping);
  h.driver.start();
  await stopping; await rejected;
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.slice(1).every((c) => c.signal.aborted));
  h.driver.start();
  await until(() => f.calls.length === 4);
  assert.equal(f.calls[3].signal.aborted, false);
  await h.driver.stop();
});

test("network failures reconnect with status; stopping backoff prevents reconnection", async (t) => {
  for (const reconnect of [false, true]) {
    const f = fake((call, count) => {
      if (count === 1) throw new Error("https://secret.example private-token Authorization");
      return count === 2 ? json({ msgs: [], get_updates_buf: "after-reconnect" }) : blocked(call.signal);
    });
    const h = harness(f.fetchImpl);
    h.driver.start();
    t.after(() => h.driver.stop());
    await until(() => h.statuses.some((s) => s.state === "error"));
    assert.doesNotMatch(JSON.stringify(h.statuses), /https:|private|Authorization/);
    if (reconnect) {
      await until(() => f.calls.length === 3);
      assert.ok(h.statuses.some((s) => s.state === "connected"));
    }
    await h.driver.stop();
    assert.equal(f.calls.length, reconnect ? 3 : 1);
  }
});

test("invalid session halts polling; send rejection is not replayed", async (t) => {
  for (const failure of [json({ errcode: -14, errmsg: "private-token" }), json({}, 401)]) {
    const f = fake(() => failure);
    const h = harness(f.fetchImpl);
    h.driver.start();
    t.after(() => h.driver.stop());
    await until(() => h.statuses.at(-1)?.state === "error");
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(h.statuses), /private/);
    await h.driver.stop();
  }
  for (const sendResponse of [
    () => json({ ret: -1, errmsg: "private-token private-context" }),
    () => { throw new Error("private-token Authorization https://secret.example"); },
  ]) {
    const f = fake((call, count) => call.url.pathname.endsWith("sendmessage") ? sendResponse()
      : count === 1 ? json({ msgs: [message()], get_updates_buf: "ok" }) : blocked(call.signal));
    const h = harness(f.fetchImpl);
    h.driver.start();
    t.after(() => h.driver.stop());
    await until(() => f.calls.length === 2);
    await assert.rejects(h.driver.send(inbound, "x".repeat(3601)), (e) => !/private|https:|Authorization/.test(String(e.stack)));
    assert.equal(f.calls.filter((c) => c.url.pathname.endsWith("sendmessage")).length, 1);
    await h.driver.stop();
  }
});

test("transport has bounded cancellable timeout and redacts malformed JSON/network errors", async () => {
  for (const handler of [() => new Response("private-secret invalid json"), () => { throw new Error("private-secret"); }]) {
    const f = fake(handler);
    await assert.rejects(weixinRequest({ fetchImpl: f.fetchImpl, baseUrl: credentials.baseUrl, endpoint: "test" }),
      (e) => !/private-secret/.test(String(e.stack)) && e.cause === undefined);
  }
  const f = fake((call) => blocked(call.signal));
  await assert.rejects(weixinRequest({ fetchImpl: f.fetchImpl, baseUrl: credentials.baseUrl, endpoint: "test", timeoutMs: 5 }),
    (e) => e.code === "timeout");
  assert.ok(f.calls[0].signal.aborted);
});

test("disabled driver never polls", async () => {
  const f = fake(() => assert.fail("disabled driver fetched"));
  const h = harness(f.fetchImpl, { bot: { ...bot, enabled: false } });
  h.driver.start();
  await h.driver.stop();
  assert.equal(f.calls.length, 0);
});
