import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { createJiti } from "jiti";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });

const shim = fileURLToPath(new URL("../../hooks/__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, {
  alias: { "react/jsx-runtime": fileURLToPath(import.meta.resolve("react/jsx-runtime")), react: shim },
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
});
const { renderHook } = await import(shim);
const { useImSettings, imRequest } = await jiti.import("./useImSettings.ts");
const { parseImIds, imCopy } = await jiti.import("./im-ui.ts");
const { ImConversations } = await jiti.import("./ImBotDetail.tsx");
const snapshot = { bots: [], conversations: [] };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const settle = async (hook) => { for (let i = 0; i < 12; i++) { await Promise.resolve(); hook?.flush(); } };

function environment(t, fetch) {
  const intervals = new Map();
  const timeouts = new Map();
  let id = 0;
  t.mock.method(globalThis, "fetch", fetch);
  t.mock.method(globalThis, "setInterval", (fn, delay) => { intervals.set(++id, { fn, delay }); return id; });
  t.mock.method(globalThis, "clearInterval", (key) => intervals.delete(key));
  t.mock.method(globalThis, "setTimeout", (fn, delay) => { timeouts.set(++id, { fn, delay }); return id; });
  t.mock.method(globalThis, "clearTimeout", (key) => timeouts.delete(key));
  return { intervals, timeouts };
}

test("ID input preserves string IDs and deduplicates comma/newline lists", () => {
  assert.deepEqual(parseImIds("123, -100002\n123，00456\n"), ["123", "-100002", "00456"]);
});

test("GET uses the project query without creating a bot; API refusals retain their message", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return response({ error: "Directory does not exist" }, 400); });
  await assert.rejects(imRequest(new AbortController().signal, undefined, "/work/a b"), /Directory does not exist/);
  assert.equal(calls[0][0], "/api/tsgw/im?cwd=%2Fwork%2Fa%20b");
  assert.equal(calls[0][1].method, undefined);
  assert.equal(calls[0][1].body, undefined);
});

test("mount only reads, polls every five seconds and aborts pending reads on unmount", async (t) => {
  const calls = [];
  const { intervals } = environment(t, async (...args) => { calls.push(args); return response(snapshot); });
  const hook = renderHook(useImSettings);
  await settle(hook);
  assert.deepEqual(hook.result.snapshot, snapshot);
  assert.equal(calls.length, 1);
  const interval = [...intervals.values()][0];
  assert.equal(interval.delay, 5000);
  interval.fn();
  await settle(hook);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, init]) => !init.method));
  hook.unmount();
  assert.equal(intervals.size, 0);
  assert.ok(calls.every(([, init]) => init.signal.aborted));
});

test("mutations post the exact action then refresh; bind null explicitly requests a new session", async (t) => {
  const calls = [];
  environment(t, async (...args) => { calls.push(args); return response(snapshot); });
  const hook = renderHook(useImSettings);
  await settle(hook);
  const action = { action: "bind", conversationKey: "telegram/bot/chat/topic", sessionId: null };
  assert.equal(await hook.result.act(action), true);
  await settle(hook);
  assert.equal(calls[1][1].method, "POST");
  assert.equal(calls[1][1].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1][1].body), action);
  assert.equal(calls[2][1].method, undefined);
  hook.unmount();
});

test("WeChat polls every two seconds, retains the PNG and refreshes on connection", async (t) => {
  const calls = [];
  const { timeouts } = environment(t, async (url, init) => {
    calls.push([url, init]);
    const action = init.body && JSON.parse(init.body);
    if (action?.action === "login-weixin") return response({ id: "login", state: "waiting", qrImage: "data:image/png;base64,AA==" });
    if (action?.action === "poll-weixin") return response({ id: "login", state: "connected", botId: "bot" });
    return response(snapshot);
  });
  const hook = renderHook(useImSettings);
  await settle(hook);
  await hook.result.act({ action: "login-weixin", name: "WeChat", cwd: "/work" });
  await settle(hook);
  const timer = [...timeouts.values()][0];
  assert.equal(timer.delay, 2000);
  await timer.fn();
  await settle(hook);
  assert.equal(hook.result.login.state, "connected");
  assert.equal(hook.result.login.qrImage, "data:image/png;base64,AA==");
  assert.equal(calls.at(-1)[1].method, undefined);
  hook.unmount();
  assert.ok(calls.every(([, init]) => init.signal.aborted));
});

test("cancel posts to the server, then aborts an in-flight poll and ignores its late confirmation", async (t) => {
  const calls = [];
  let finishPoll;
  let finishCancel;
  const { timeouts } = environment(t, async (url, init) => {
    calls.push([url, init]);
    const action = init.body && JSON.parse(init.body);
    if (action?.action === "login-weixin") return response({ id: "login", state: "waiting" });
    if (action?.action === "poll-weixin") return new Promise((resolve) => { finishPoll = resolve; });
    if (action?.action === "cancel-weixin") return new Promise((resolve) => { finishCancel = resolve; });
    return response(snapshot);
  });
  const hook = renderHook(useImSettings);
  await settle(hook);
  await hook.result.act({ action: "login-weixin", name: "WeChat", cwd: "/work" });
  await settle(hook);
  const polling = [...timeouts.values()][0].fn();
  const pollSignal = calls.at(-1)[1].signal;
  const canceling = hook.result.cancelLogin();
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { action: "cancel-weixin", loginId: "login" });
  hook.flush();
  assert.equal(hook.result.login.id, "login", "keep the login until the server acknowledges cancellation");
  finishCancel(response(snapshot));
  assert.equal(await canceling, true);
  await settle(hook);
  assert.equal(hook.result.login, null);
  assert.equal(pollSignal.aborted, true);
  assert.equal(timeouts.size, 0);
  finishPoll(response({ id: "login", state: "connected", botId: "late-bot" }));
  await polling;
  await settle(hook);
  assert.equal(hook.result.login, null);
  assert.equal(timeouts.size, 0);
  hook.unmount();
});

test("a refused cancellation stays visible and can be retried", async (t) => {
  let refused = true;
  environment(t, async (_url, init) => {
    const action = init.body && JSON.parse(init.body);
    if (action?.action === "login-weixin") return response({ id: "login", state: "waiting" });
    if (action?.action === "cancel-weixin" && refused) return response({ error: "Cancellation failed" }, 500);
    return response(snapshot);
  });
  const hook = renderHook(useImSettings);
  await settle(hook);
  await hook.result.act({ action: "login-weixin", name: "WeChat", cwd: "/work" });
  await settle(hook);
  assert.equal(await hook.result.cancelLogin(), false);
  await settle(hook);
  assert.equal(hook.result.login.id, "login");
  assert.equal(hook.result.error, "Cancellation failed");
  refused = false;
  assert.equal(await hook.result.cancelLogin(), true);
  await settle(hook);
  assert.equal(hook.result.login, null);
  hook.unmount();
});

test("session choices preserve the server's canonical project paths", async (t) => {
  const sessions = [
    { id: "symlink", title: "Symlink project", cwd: "/real/project" },
    { id: "windows", title: "Windows project", cwd: "C:\\PROJECT" },
  ];
  t.mock.method(globalThis, "fetch", async () => response({ sessions }));
  const hook = renderHook(() => ImConversations({
    bot: { cwd: "/linked/project" }, conversations: [{ key: "conversation", cwd: "/linked/project", sessionId: null }],
    copy: imCopy("en"), busy: false, act: async () => true,
  }));
  await settle(hook);
  const findOptions = (node) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(findOptions);
    if (node.type === "option") return [node.props.value];
    return findOptions(node.props?.children);
  };
  assert.deepEqual(findOptions(hook.result), ["", "symlink", "windows"]);
  hook.unmount();
});

test("an aborted late snapshot cannot update an unmounted panel", async (t) => {
  let resolve;
  environment(t, () => new Promise((done) => { resolve = done; }));
  const hook = renderHook(useImSettings);
  hook.unmount();
  resolve(response(snapshot));
  await settle(hook);
  assert.equal(hook.result.snapshot, null);
});
