import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ImStore } = await jiti.import("./store.ts");
const { ImRuntime } = await jiti.import("./runtime.ts");
const { ImService } = await jiti.import("./service.ts");
const { describeTelegramBot } = await jiti.import("./telegram-setup.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}, driverHooks = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ImStore.open(join(directory, "state.json"));
  const configs = [], active = new Set();
  const factory = (config) => {
    configs.push(config);
    return {
      start() { active.add(config); driverHooks.start?.(config); },
      async stop() { await driverHooks.stop?.(config); active.delete(config); },
      async send() {},
    };
  };
  const runtime = new ImRuntime(store, { async exists() { return false; } }, { telegram: factory, weixin: factory },
    describeTelegramBot);
  let loginSignal;
  const dependencies = {
    async verifyTelegram() { return { username: "test_bot" }; },
    async createWeixinLogin(signal) {
      loginSignal = signal;
      return { qrUrl: "https://example.invalid/qr", async poll() { return { state: "waiting" }; } };
    },
    async qrImage() { return "data:image/png;base64,local"; },
    ...overrides,
  };
  const service = new ImService(runtime, dependencies);
  t.after(() => service.close());
  return { directory, store, runtime, service, configs, active, getLoginSignal: () => loginSignal };
}

const credentials = { token: "wx-secret", baseUrl: "https://example.invalid", accountId: "account", ownerUserId: "owner" };

test("Telegram validates project and owner before verification, rejects duplicates, and returns no token", async (t) => {
  let verifications = 0;
  const f = await fixture(t, { async verifyTelegram() { verifications++; return { username: "test_bot" }; } });
  const action = { action: "add-telegram", name: "TG", cwd: f.directory, token: "123:tg-secret", allowedUserIds: [], allowedChatIds: [] };
  await assert.rejects(f.service.action(action), /至少/);
  assert.equal(verifications, 0);
  const snapshot = await f.service.action({ ...action, allowedUserIds: ["42"] });
  assert.equal(snapshot.bots[0].cwd, f.directory);
  assert.equal(snapshot.bots[0].username, "test_bot");
  assert.ok(!JSON.stringify(snapshot).includes("tg-secret"));
  await assert.rejects(f.service.action({ ...action, allowedUserIds: ["42"] }), /已经添加/);
  assert.equal((await f.store.read()).bots.length, 1);
  const update = { ...action, action: "update-bot", botId: snapshot.bots[0].id, enabled: false };
  await assert.rejects(f.service.action(update), /至少/);
  assert.equal(f.active.size, 1, "invalid access changes must not stop the bot");
  const project = await mkdtemp(join(f.directory, "project-"));
  await f.store.update((state) => {
    state.conversations.key = { botId: update.botId, cwd: f.directory, sessionId: "retained-pi-session" };
  });
  const stopped = await f.service.action({ ...update, cwd: project, allowedUserIds: ["43"], allowedChatIds: ["chat"] });
  assert.equal((await f.store.read()).conversations.key.cwd, project);
  assert.equal((await f.store.read()).conversations.key.sessionId, null);
  assert.deepEqual(stopped.bots[0].allowedUserIds, ["43"]);
  assert.deepEqual(stopped.bots[0].allowedChatIds, ["chat"]);
  assert.equal(stopped.bots[0].status.state, "stopped");
  assert.equal(stopped.bots[0].username, "test_bot");
  assert.ok(!JSON.stringify(stopped).includes("tg-secret"));
});

test("WeChat confirmation installs one bot with project and owner, concurrent polls coalesce", async (t) => {
  let complete, polls = 0;
  const f = await fixture(t, {
    async createWeixinLogin() {
      return { qrUrl: "https://example.invalid/qr", poll() { polls++; return new Promise((resolve) => { complete = resolve; }); } };
    },
  });
  const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
  assert.equal(login.qrImage, "data:image/png;base64,local");
  const first = f.service.action({ action: "poll-weixin", loginId: login.id });
  const second = f.service.action({ action: "poll-weixin", loginId: login.id });
  complete({ state: "connected", credentials });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.botId, two.botId);
  assert.equal(polls, 1);
  const state = await f.store.read();
  assert.equal(state.bots.length, 1);
  assert.equal(state.bots[0].cwd, f.directory);
  assert.deepEqual(state.bots[0].allowedUserIds, ["owner"]);
  assert.ok(!JSON.stringify(await f.runtime.snapshot()).includes("wx-secret"));
  assert.ok(!JSON.stringify(one).includes("wx-secret"));
});

test("cancelling a QR request aborts pending login and prevents a late confirmation from adding a bot", async (t) => {
  let complete, signal;
  const f = await fixture(t, {
    async createWeixinLogin(value) {
      signal = value;
      return { qrUrl: "https://example.invalid/qr", poll() { return new Promise((resolve) => { complete = resolve; }); } };
    },
  });
  const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
  const pending = f.service.action({ action: "poll-weixin", loginId: login.id });
  await f.service.action({ action: "cancel-weixin", loginId: login.id });
  assert.equal(signal.aborted, true);
  complete({ state: "connected", credentials });
  await pending;
  assert.equal((await f.store.read()).bots.length, 0);
});

test("cancellation is refused after credentials commit while the old driver is stopping", async (t) => {
  const stopping = deferred(), release = deferred();
  t.after(() => release.resolve());
  let signal, hold = true;
  const rotated = { ...credentials, token: "rotated" };
  const f = await fixture(t, {
    async createWeixinLogin(value) {
      signal = value;
      return { qrUrl: "https://example.invalid/qr", async poll() { return { state: "connected", credentials: rotated }; } };
    },
  }, {
    async stop() { if (hold) { hold = false; stopping.resolve(); await release.promise; } },
  });
  await f.store.update((state) => {
    state.bots.push({
      id: "b", channel: "weixin", name: "WX", cwd: f.directory, enabled: true,
      allowedUserIds: ["owner"], allowedChatIds: [], credentials,
    });
    state.conversations.key = { botId: "b", cwd: f.directory, sessionId: "retained-pi-session" };
  });
  await f.runtime.start();
  const login = await f.service.action({ action: "login-weixin", name: "Replacement WX", cwd: tmpdir() });
  const pending = f.service.action({ action: "poll-weixin", loginId: login.id });
  await stopping.promise;
  const committed = (await f.store.read()).bots[0];
  assert.equal(committed.cwd, f.directory);
  assert.equal(committed.name, "WX");
  assert.equal((await f.store.read()).conversations.key.sessionId, "retained-pi-session");
  assert.equal(committed.enabled, true);
  assert.equal(committed.credentials.token, "rotated");
  await assert.rejects(f.service.action({ action: "cancel-weixin", loginId: login.id }),
    /微信授权已确认，正在完成绑定，请稍候/);
  assert.equal(signal.aborted, false);
  release.resolve();
  const result = await pending;
  assert.equal(result.state, "connected");
  assert.equal(result.botId, "b");
  assert.equal(f.active.size, 1);
  assert.equal([...f.active][0].bot.credentials.token, "rotated");
  assert.deepEqual(await f.service.action({ action: "poll-weixin", loginId: login.id }), result);
});

test("confirmed login queued behind management is still cancellable before commit", async (t) => {
  const verifying = deferred(), release = deferred();
  t.after(() => release.resolve());
  let signal;
  const f = await fixture(t, {
    async verifyTelegram() { verifying.resolve(); await release.promise; return { username: "test_bot" }; },
    async createWeixinLogin(value) {
      signal = value;
      return { qrUrl: "https://example.invalid/qr", async poll() { return { state: "connected", credentials }; } };
    },
  });
  const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
  const management = f.service.action({ action: "add-telegram", name: "TG", cwd: f.directory,
    token: "123:dummy", allowedUserIds: ["42"], allowedChatIds: [] });
  await verifying.promise;
  const pending = f.service.action({ action: "poll-weixin", loginId: login.id });
  await new Promise((resolve) => setImmediate(resolve));
  await f.service.action({ action: "cancel-weixin", loginId: login.id });
  assert.equal(signal.aborted, true);
  release.resolve();
  await Promise.all([management, pending]);
  assert.equal((await f.store.read()).bots.some((bot) => bot.channel === "weixin"), false);
  assert.equal(f.configs.some((config) => config.bot.channel === "weixin"), false);
});

test("login errors cannot disclose platform credentials and deleting a bot preserves Pi sessions", async (t) => {
  const f = await fixture(t, {
    async createWeixinLogin() {
      return { qrUrl: "https://example.invalid/qr", async poll() { throw new Error("wx-secret"); } };
    },
  });
  const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
  const failure = await f.service.action({ action: "poll-weixin", loginId: login.id });
  assert.equal(failure.state, "error");
  assert.ok(!failure.error.includes("wx-secret"));
  await f.store.update((state) => {
    state.bots.push({ id: "b", channel: "weixin", name: "WX", cwd: f.directory, enabled: false, allowedUserIds: ["owner"], allowedChatIds: [], credentials });
    state.checkpoints.b = { cursor: "secret" };
    state.seen.b = ["1"];
    state.conversations.key = { botId: "b", sessionId: "retained-pi-session" };
  });
  await f.service.action({ action: "remove-bot", botId: "b" });
  const state = await f.store.read();
  assert.equal(state.bots.length, 0);
  assert.deepEqual(state.conversations, {});
  assert.deepEqual(state.checkpoints, {});
  // The host seam exposes no deletion operation; removal touches only IM-owned state.
  assert.deepEqual(state.seen, {});
});

for (const operation of ["second-login", "disable", "remove", "close"]) {
  test(`confirmed login serializes with ${operation} while an old driver is stopping`, async (t) => {
    const stopping = deferred(), release = deferred();
    t.after(() => release.resolve());
    let hold = false, maximumActive = 0;
    const polls = [];
    const f = await fixture(t, {
      async createWeixinLogin() {
        return { qrUrl: "https://example.invalid/qr", poll() {
          const result = deferred(); polls.push(result); return result.promise;
        } };
      },
    }, {
      start() { maximumActive = Math.max(maximumActive, f.active.size); },
      async stop() { if (hold) { hold = false; stopping.resolve(); await release.promise; } },
    });
    await f.store.update((state) => state.bots.push({
      id: "b", channel: "weixin", name: "WX", cwd: f.directory, enabled: true,
      allowedUserIds: ["owner"], allowedChatIds: [], credentials,
    }));
    await f.runtime.start();
    const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
    const other = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
    hold = true;
    const first = f.service.action({ action: "poll-weixin", loginId: login.id });
    polls[0].resolve({ state: "connected", credentials });
    await stopping.promise;
    let next;
    if (operation === "second-login") {
      next = f.service.action({ action: "poll-weixin", loginId: other.id });
      assert.equal(polls.length, 2, "network polls are not held behind management");
      polls[1].resolve({ state: "connected", credentials: { ...credentials, token: "rotated" } });
    } else if (operation === "disable") {
      next = f.service.action({ action: "update-bot", botId: "b", name: "WX", cwd: f.directory,
        enabled: false, allowedUserIds: ["owner"], allowedChatIds: [] });
    } else if (operation === "remove") next = f.service.action({ action: "remove-bot", botId: "b" });
    else next = f.service.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.configs.length, 1, "no concurrent replacement driver may start");
    release.resolve();
    await Promise.all([first, next]);
    assert.equal(maximumActive, 1);
    assert.equal(f.active.size, operation === "second-login" ? 1 : 0);
    if (operation === "close") assert.equal(f.configs.length, 1, "closing during restart prevents its start");
    if (operation === "remove") assert.equal((await f.store.read()).bots.length, 0);
    await f.service.close();
    assert.equal(f.active.size, 0, "shutdown retains ownership of every driver");
  });
}

test("close drains in-flight management, rejects queued changes and ignores late login confirmation", async (t) => {
  const verifying = deferred(), verified = deferred(), confirmed = deferred();
  const f = await fixture(t, {
    async verifyTelegram() { verifying.resolve(); await verified.promise; return { username: "test_bot" }; },
    async createWeixinLogin() {
      return { qrUrl: "https://example.invalid/qr", poll: () => confirmed.promise };
    },
  });
  const login = await f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
  const poll = f.service.action({ action: "poll-weixin", loginId: login.id });
  const action = { action: "add-telegram", name: "TG", cwd: f.directory, token: "123:dummy", allowedUserIds: ["42"], allowedChatIds: [] };
  const rejected = assert.rejects(f.service.action(action));
  await verifying.promise;
  const queued = assert.rejects(f.service.action(action));
  let closed = false;
  const close = f.service.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  verified.resolve();
  await Promise.all([rejected, queued, close]);
  confirmed.resolve({ state: "connected", credentials });
  await poll;
  assert.equal(f.configs.length, 0);
  assert.equal((await f.store.read()).bots.length, 0);
  await assert.rejects(f.service.action(action), /关闭/);
});

test("close aborts a QR creation that has not yet entered the login map", async (t) => {
  const entered = deferred(), release = deferred();
  let signal;
  const f = await fixture(t, {
    async createWeixinLogin(value) {
      signal = value; entered.resolve(); await release.promise;
      return { qrUrl: "https://example.invalid/qr", async poll() { return { state: "waiting" }; } };
    },
  });
  const rejected = assert.rejects(f.service.action({ action: "login-weixin", name: "WX", cwd: f.directory }));
  await entered.promise;
  await f.service.close();
  assert.equal(signal.aborted, true);
  release.resolve();
  await rejected;
  assert.equal(f.configs.length, 0);
});
