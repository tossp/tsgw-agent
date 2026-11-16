import assert from "node:assert/strict";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const { createWeixinDriver } = await createJiti(import.meta.url).import("./weixin.ts");
const envelopes = [];
Sentry.init({
  dsn: "https://public@typing.invalid/10", defaultIntegrations: [],
  transport: () => ({ send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); }, flush: async () => true }),
});
after(() => Sentry.close(1000));
const events = () => envelopes.flatMap(([, items]) => items.filter(([header]) => header.type === "event").map(([, payload]) => payload));
const owner = "owner";
const input = { id: "1", chatId: owner, senderId: owner, text: "hello", isGroup: false };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const empty = () => new Response(null, { status: 200 });
function blocked(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("cancel", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
async function until(check, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("typing did not settle");
    await delay(5);
  }
}
async function fixture(t, override = () => undefined) {
  const calls = [], statuses = [], checkpoints = [];
  let polls = 0;
  const driver = createWeixinDriver({
    bot: { id: "wx", channel: "weixin", name: "WX", cwd: "/tmp", enabled: true, allowedUserIds: [], allowedChatIds: [],
      credentials: { token: "private-token", accountId: "bot", ownerUserId: owner, baseUrl: "https://ilinkai.weixin.qq.com/" } },
    checkpoint: {}, onStatus: (status) => statuses.push(status), onMessage: async () => {},
    saveCheckpoint: async (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    fetchImpl: async (url, init) => {
      const call = { path: new URL(url).pathname, body: JSON.parse(init.body), signal: init.signal };
      calls.push(call);
      if (call.path.endsWith("getupdates")) {
        if (++polls > 1) return blocked(init.signal);
        return json({ get_updates_buf: "cursor", msgs: [{ message_id: "1", from_user_id: owner, to_user_id: "bot", message_type: 1,
          context_token: "private-context", item_list: [{ type: 1, text_item: { text: "hello" } }] }] });
      }
      const overridden = override(call);
      if (overridden !== undefined) return overridden;
      if (call.path.endsWith("getconfig")) return json({ typing_ticket: "private-typing-ticket" });
      if (call.path.endsWith("sendtyping")) return empty();
      if (call.path.endsWith("sendmessage")) return json({ ret: 0 });
      throw new Error("Unexpected endpoint");
    },
  });
  t.after(() => driver.stop());
  driver.start();
  await until(() => polls === 2);
  const typing = () => calls.filter((call) => call.path.endsWith("sendtyping"));
  return { driver, calls, statuses, checkpoints, typing };
}

test("typing gets the private ticket, renews every five seconds, and cancels without blocking final replies", async (t) => {
  const f = await fixture(t);
  f.driver.setTyping({ ...input, senderId: "stranger" }, true);
  f.driver.setTyping({ ...input, chatId: "stranger" }, true);
  assert.equal(f.calls.filter((call) => call.path.endsWith("getconfig")).length, 0);
  f.driver.setTyping(input, true);
  f.driver.setTyping(input, true);
  await until(() => f.typing().length === 1);
  const config = f.calls.find((call) => call.path.endsWith("getconfig"));
  assert.deepEqual(config.body, { ilink_user_id: owner, context_token: "private-context", base_info: { channel_version: "2.4.6", bot_agent: "TSGW-Agent/0.1.0" } });
  assert.deepEqual(f.typing()[0].body, { ilink_user_id: owner, typing_ticket: "private-typing-ticket", status: 1, base_info: config.body.base_info });
  await f.driver.send(input, "final reply");
  assert.equal(f.calls.filter((call) => call.path.endsWith("sendmessage")).length, 1);
  await until(() => f.typing().length === 2, 6500);
  assert.deepEqual(f.typing().map((call) => call.body.status), [1, 1]);
  assert.equal(f.calls.filter((call) => call.path.endsWith("getconfig")).length, 1);
  f.driver.setTyping(input, false);
  await until(() => f.typing().length === 3);
  assert.deepEqual(f.typing().map((call) => call.body.status), [1, 1, 2]);
  assert.ok(!JSON.stringify(f.checkpoints).includes("private-typing-ticket"));
  await f.driver.stop();
  assert.equal(f.typing().length, 3);
});

test("stopping while the ticket is pending cancels it without late typing or error events", async (t) => {
  envelopes.length = 0;
  const f = await fixture(t, (call) => call.path.endsWith("getconfig") ? blocked(call.signal) : undefined);
  f.driver.setTyping(input, true);
  await until(() => f.calls.some((call) => call.path.endsWith("getconfig")));
  const request = f.calls.find((call) => call.path.endsWith("getconfig"));
  f.driver.setTyping(input, false);
  await f.driver.stop();
  assert.ok(request.signal.aborted);
  assert.equal(f.typing().length, 0);
  await Sentry.flush(1000);
  assert.equal(events().length, 0);
});

test("the next indicator waits for the previous cancellation to finish", async (t) => {
  let release;
  let cancellations = 0;
  const f = await fixture(t, (call) => {
    if (call.path.endsWith("sendtyping") && call.body.status === 2 && ++cancellations === 1) {
      return new Promise((resolve) => { release = () => resolve(empty()); });
    }
  });
  f.driver.setTyping(input, true);
  await until(() => f.typing().length === 1);
  f.driver.setTyping(input, false);
  f.driver.setTyping(input, true);
  await until(() => release);
  assert.deepEqual(f.typing().map((call) => call.body.status), [1, 2]);
  assert.equal(f.calls.filter((call) => call.path.endsWith("getconfig")).length, 1);
  release();
  await until(() => f.typing().length === 3);
  assert.deepEqual(f.typing().map((call) => call.body.status), [1, 2, 1]);
  await f.driver.stop();
  assert.deepEqual(f.typing().map((call) => call.body.status), [1, 2, 1, 2]);
});

test("driver stop aborts an in-flight start and sends a standalone cancellation", async (t) => {
  const f = await fixture(t, (call) => call.path.endsWith("sendtyping") && call.body.status === 1 ? blocked(call.signal) : undefined);
  f.driver.setTyping(input, true);
  await until(() => f.typing().length === 1);
  await f.driver.stop();
  assert.ok(f.typing()[0].signal.aborted);
  assert.equal(f.typing()[1].body.status, 2);
  assert.equal(f.typing()[1].signal.aborted, false);
  const count = f.calls.length;
  f.driver.setTyping(input, true);
  await delay(10);
  assert.equal(f.calls.length, count);
});

test("missing tickets are a quiet no-op", async (t) => {
  envelopes.length = 0;
  const f = await fixture(t, (call) => call.path.endsWith("getconfig") ? json({}) : undefined);
  f.driver.setTyping(input, true);
  await until(() => f.calls.some((call) => call.path.endsWith("getconfig")));
  await f.driver.stop();
  assert.equal(f.typing().length, 0);
  await Sentry.flush(1000);
  assert.equal(events().length, 0);
});

test("ticket, start and cancel failures report their stage without poisoning the connection or final replies", async (t) => {
  for (const stage of ["getconfig", "start", "cancel"]) {
    await t.test(stage, async (t) => {
      envelopes.length = 0;
      const f = await fixture(t, (call) => {
        if (stage === "getconfig" && call.path.endsWith("getconfig")) throw new Error("private-token private-context");
        if (call.path.endsWith("sendtyping") && ((stage === "start" && call.body.status === 1) || (stage === "cancel" && call.body.status === 2))) {
          return json({ ret: 1, errmsg: "private-typing-ticket private-chat-text" });
        }
      });
      f.driver.setTyping(input, true);
      if (stage === "cancel") {
        await until(() => f.typing().length === 1);
        f.driver.setTyping(input, false);
      }
      await until(() => events().length === 1);
      await f.driver.send(input, "final reply");
      await f.driver.stop();
      await Sentry.flush(1000);
      assert.equal(events().length, 1);
      assert.equal(events()[0].tags.operation, stage === "cancel" ? "typing-stop" : "typing");
      assert.equal(events()[0].tags.channel, "weixin");
      assert.equal(f.statuses.some((status) => status.state === "error"), false);
      assert.equal(f.calls.filter((call) => call.path.endsWith("sendmessage")).length, 1);
      for (const secret of ["private-token", "private-context", "private-typing-ticket", "private-chat-text"]) assert.ok(!JSON.stringify(events()).includes(secret));
    });
  }
});
