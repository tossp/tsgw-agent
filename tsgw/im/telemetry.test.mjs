import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { after } from "node:test";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { reportImError } = await jiti.import("./telemetry.ts");
const { reportCatError } = await jiti.import("../cat-monitoring/index.ts");
const { ImStore } = await jiti.import("./store.ts");
const { ImRuntime } = await jiti.import("./runtime.ts");
const { ImService } = await jiti.import("./service.ts");
const { createWeixinDriver } = await jiti.import("./weixin.ts");
const { WeixinError } = await jiti.import("./weixin-transport.ts");
const { imRequest } = await jiti.import("./useImSettings.ts");
const envelopes = [];
Sentry.init({
  dsn: "https://public@telemetry.invalid/10",
  release: "tsgw-agent@test",
  initialScope: { tags: { instance: "test-host" } },
  defaultIntegrations: [Sentry.requestDataIntegration()],
  transport: () => ({ send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); }, flush: () => Promise.resolve(true) }),
});
after(() => Sentry.close(1000));
const events = () => envelopes.flatMap(([, items]) => items.flatMap(([header, payload]) => header.type === "event" ? [payload] : []));
const flush = async () => { await Sentry.flush(1000); return events(); };
const message = { id: "1", chatId: "owner", senderId: "owner", text: "private-chat-text", isGroup: false };

async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("operation did not settle");
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-cat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ImStore.open(join(directory, "state.json"));
  const bot = {
    id: "bot", channel: "weixin", name: "WX", cwd: directory, enabled: true,
    allowedUserIds: ["owner"], allowedChatIds: [],
    credentials: { token: "private-token", accountId: "account", ownerUserId: "owner", baseUrl: "https://ilinkai.weixin.qq.com/" },
  };
  await store.update((state) => { state.bots.push(bot); });
  let config;
  let sendCount = 0;
  const host = {
    async exists() { return true; }, async create() { return "session"; }, async list() { return []; }, async stop() {},
    async notify(...args) { return { completion: options.notify ? options.notify(...args) : Promise.resolve() }; },
  };
  const factory = (value) => {
    config = value;
    return options.driver ? options.driver(value) : {
      start() {}, async stop() {}, async send() { sendCount++; await options.send?.(); },
    };
  };
  const runtime = new ImRuntime(store, host, factory);
  t.after(() => runtime.stop());
  await runtime.start();
  return { runtime, config, directory, sendCount: () => sendCount };
}

test("IM events exclude inherited credential requests and chat context; other CAT events retain standard collection", async () => {
  envelopes.length = 0;
  Sentry.withScope((scope) => {
    scope.setSDKProcessingMetadata({ normalizedRequest: {
      method: "POST", url: "https://example.invalid/api/tsgw/im", data: { token: "private-token" },
      headers: { "user-agent": "CAT regression" },
    } });
    scope.setContext("chat", { text: "private-chat-text" });
    scope.addBreadcrumb({ message: "private-qr-ticket" });
    reportImError("receive", { channel: "weixin", botId: "bot" });
    reportCatError(new Error("ordinary control"), { source: "control" });
  });
  const all = await flush();
  const im = all.find((event) => event.tags?.source === "im");
  const control = all.find((event) => event.tags?.source === "control");
  assert.ok(im);
  assert.deepEqual(im.tags, { instance: "test-host", source: "im", operation: "receive", channel: "weixin", botId: "bot" });
  assert.equal(im.release, "tsgw-agent@test");
  for (const secret of ["private-token", "private-chat-text", "private-qr-ticket"]) {
    assert.ok(!JSON.stringify(im).includes(secret));
    assert.ok(JSON.stringify(control).includes(secret), "negative control must retain inherited data");
  }
});

test("handled task and send failures report their owning stage once without raw errors or message text", async (t) => {
  for (const operation of ["process", "send"]) {
    await t.test(operation, async (t) => {
      envelopes.length = 0;
      const fail = async () => { throw new Error("private-token private-chat-text private-response-body"); };
      const f = await fixture(t, operation === "process" ? { notify: fail } : { send: fail });
      if (operation === "process") {
        await f.config.onMessage(message);
        await eventually(() => f.sendCount() === 1);
      } else {
        const result = await f.runtime.send(f.directory, { bot: "WX" }, [{ type: "text", text: message.text }]);
        assert.equal(result.success, false);
      }
      const all = await flush();
      assert.equal(all.length, 1);
      assert.equal(all[0].tags.operation, operation);
      assert.equal(all[0].tags.channel, "weixin");
      for (const secret of ["private-token", "private-chat-text", "private-response-body"]) assert.ok(!JSON.stringify(all).includes(secret));
    });
  }
});

test("real WeChat long-poll timeouts and intentional stop remain quiet; a connection failure is captured", async (t) => {
  envelopes.length = 0;
  let polls = 0;
  const f = await fixture(t, { driver: (config) => createWeixinDriver({
    ...config,
    fetchImpl: async (_url, init) => {
      polls++;
      if (polls === 1) throw new WeixinError("timeout", "微信服务请求超时。");
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("stop", "AbortError")), { once: true }));
    },
  }) });
  await eventually(() => polls === 2);
  await f.runtime.stop();
  assert.equal((await flush()).length, 0);
  const failed = await fixture(t, { driver: (config) => createWeixinDriver({
    ...config, bot: { ...config.bot, credentials: { ...config.bot.credentials, token: "" } },
  }) });
  await eventually(() => events().length > 0);
  assert.equal((await flush()).length, 1);
  assert.equal(events()[0].tags.operation, "receive");
  await failed.runtime.stop();
});

test("a stopped driver ignores late notification failures", async (t) => {
  envelopes.length = 0;
  let started = false;
  const { promise, reject } = Promise.withResolvers();
  const f = await fixture(t, { notify: () => { started = true; return promise; } });
  await f.config.onMessage(message);
  await eventually(() => started);
  await f.runtime.stop();
  reject(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await flush()).length, 0);
});

test("a cancelled Pi notification produces no failure or fallback message", async (t) => {
  envelopes.length = 0;
  let called = false;
  const f = await fixture(t, { notify: async () => { called = true; throw new DOMException("cancelled", "AbortError"); } });
  await f.config.onMessage(message);
  await eventually(() => called);
  assert.equal(f.sendCount(), 0);
  assert.equal((await flush()).length, 0);
});

test("failed WeChat binding is captured but cancellation and normal QR expiration are not", async (t) => {
  const f = await fixture(t);
  for (const mode of ["failure", "cancel", "expired"]) {
    envelopes.length = 0;
    let release;
    const service = new ImService(f.runtime, {
      async qrImage() { return "data:image/png;base64,AA=="; },
      async createWeixinLogin() {
        return { qrUrl: "https://example.invalid/qr", async poll() {
          if (mode === "cancel") await new Promise((resolve) => { release = resolve; });
          if (mode === "expired") return { state: "expired" };
          throw new Error("private-qr-ticket private-token");
        } };
      },
    });
    const login = await service.action({ action: "login-weixin", name: "WX", cwd: f.directory });
    const pending = service.action({ action: "poll-weixin", loginId: login.id });
    if (mode === "cancel") {
      await service.action({ action: "cancel-weixin", loginId: login.id });
      release();
    }
    await pending;
    const all = await flush();
    assert.equal(all.length, mode === "failure" ? 1 : 0);
    if (all.length) {
      assert.equal(all[0].tags.operation, "login-complete");
      assert.ok(!JSON.stringify(all).includes("private-qr-ticket"));
    }
    await service.close();
  }
});

test("QR creation and image generation failures are captured while project validation stays quiet", async (t) => {
  const f = await fixture(t);
  for (const stage of ["create", "image", "validation"]) {
    envelopes.length = 0;
    const failure = new Error("private-qr-ticket");
    const service = new ImService(f.runtime, {
      async createWeixinLogin() {
        if (stage === "create") throw failure;
        return { qrUrl: "https://example.invalid/qr", async poll() { return { state: "waiting" }; } };
      },
      async qrImage() { throw failure; },
    });
    await assert.rejects(service.action({ action: "login-weixin", name: "WX", cwd: stage === "validation" ? "relative" : f.directory }));
    const all = await flush();
    assert.equal(all.length, stage === "validation" ? 0 : 1);
    if (all.length) assert.equal(all[0].tags.operation, "login-start");
    assert.ok(!JSON.stringify(all).includes("private-qr-ticket"));
    await service.close();
  }
});

test("settings failures distinguish request purpose and response receipt without exposing payloads; reporting boundaries stay unchanged", async (t) => {
  const action = { action: "login-weixin", name: "private-token", cwd: "/work" };
  const scope = new AbortController();
  let online = false;
  t.mock.getter(globalThis, "navigator", () => ({ onLine: online }));
  const network = new TypeError("private-token private-response-body", { cause: new Error("private-cause") });
  network.name = "private-error-name";
  const mock = t.mock.method(globalThis, "fetch", async () => { throw network; });
  for (const [input, cwd, request, method] of [
    [undefined, undefined, "status", "GET"],
    [undefined, "/private-project/path", "sessions", "GET"],
    [action, undefined, "login-weixin", "POST"],
    [{ action: "poll-weixin", loginId: "private-qr-ticket" }, undefined, "poll-weixin", "POST"],
  ]) {
    envelopes.length = 0;
    await assert.rejects(imRequest(scope.signal, input, cwd), (error) => error === network);
    const all = await flush();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].tags, {
      instance: "test-host", source: "im", operation: "settings-request",
      request, method, responseReceived: false, errorType: "TypeError", online: false,
    });
    for (const secret of ["private-token", "private-response-body", "private-cause", "private-error-name", "private-qr-ticket", "/private-project/path"]) {
      assert.ok(!JSON.stringify(all).includes(secret));
    }
  }
  online = true;
  for (const status of [200, 500]) {
    envelopes.length = 0;
    const invalidJson = new SyntaxError("private-response-body");
    mock.mock.mockImplementation(async () => ({ ok: status < 400, status, json: async () => { throw invalidJson; } }));
    await assert.rejects(imRequest(scope.signal, action), (error) => error === invalidJson);
    const all = await flush();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].tags, {
      instance: "test-host", source: "im", operation: "settings-response",
      request: "login-weixin", method: "POST", responseReceived: true, status, errorType: "SyntaxError", online: true,
    });
    assert.ok(!JSON.stringify(all).includes("private-response-body"));
  }
  envelopes.length = 0;
  for (const status of [400, 500]) {
    mock.mock.mockImplementation(async () => ({ ok: false, status, json: async () => ({ error: "server-reported failure" }) }));
    await assert.rejects(imRequest(scope.signal, action), /server-reported failure/);
  }
  for (const status of [401, 429]) {
    mock.mock.mockImplementation(async () => ({ ok: false, status, json: async () => { throw new SyntaxError("plain text response"); } }));
    await assert.rejects(imRequest(scope.signal, action));
  }
  mock.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ bots: [], conversations: [] }) }));
  assert.deepEqual(await imRequest(scope.signal), { bots: [], conversations: [] });
  assert.equal((await flush()).length, 0);
  scope.abort();
  mock.mock.mockImplementation(async () => { throw network; });
  await assert.rejects(imRequest(scope.signal, action), (error) => error === network);
  assert.equal((await flush()).length, 0);
});

test("initialization and management failures retain API responses and each produce one event", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-cat-init-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "integrations/im"), { recursive: true });
  await writeFile(join(directory, "integrations/im/state.json"), '{"token":"private-token" broken');
  const script = `
    import assert from 'node:assert/strict';
    import Sentry from '@sentry/nextjs';
    import { createJiti } from 'jiti';
    import { mkdir, rm, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const events = [];
    Sentry.init({ dsn: 'https://public@telemetry.invalid/10', defaultIntegrations: [], beforeSend(event) { events.push(event); return null; } });
    const { handleImGet, handleImPost, getImService } = await createJiti(import.meta.url).import('./tsgw/im/server.ts');
    const response = await handleImGet(new Request('http://localhost/api/tsgw/im'));
    assert.equal(response.status, 500);
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].tags.operation, 'initialize');
    assert.ok(!JSON.stringify(events).includes('private-token'));
    events.length = 0;
    const directory = process.env.PI_CODING_AGENT_DIR;
    const file = join(directory, 'integrations/im/state.json');
    const bot = { id: 'bot', channel: 'weixin', cwd: directory, enabled: false, allowedUserIds: ['chat'], allowedChatIds: [],
      credentials: { token: 'private-token', accountId: 'account', ownerUserId: 'chat', baseUrl: 'https://ilinkai.weixin.qq.com/' } };
    await writeFile(file, JSON.stringify({ version: 1, bots: [bot], checkpoints: {}, seen: {}, conversations: {
      test: { key: 'test', botId: 'bot', chatId: 'chat', title: 'chat', cwd: directory, sessionId: null, updatedAt: new Date().toISOString() },
    } }));
    assert.equal((await handleImGet(new Request('http://localhost/api/tsgw/im'))).status, 200);
    const service = await getImService();
    await rm(file);
    await mkdir(file);
    const write = await handleImPost(new Request('http://localhost/api/tsgw/im', {
      method: 'POST', body: JSON.stringify({ action: 'bind', conversationKey: 'test', sessionId: null }),
    }));
    assert.equal(write.status, 400);
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].tags.operation, 'settings-action');
    events.length = 0;
    service.runtime.host.list = async () => { throw new Error('private-token'); };
    assert.equal((await handleImGet(new Request('http://localhost/api/tsgw/im?cwd=' + encodeURIComponent(directory)))).status, 500);
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].tags.operation, 'settings-read');
    assert.ok(!JSON.stringify(events).includes('private-token'));
    await service.close();
    await Sentry.close(1000);
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: directory }, timeout: 30_000,
  });
});
