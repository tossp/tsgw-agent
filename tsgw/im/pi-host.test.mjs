import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createPiSessionHost } = await jiti.import("./pi-host.ts");
const { PiAnswerCollector } = await jiti.import("./pi-host-run.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const marker = "[IM request test]";
const user = (text = marker, type = "message_end") => ({ type, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text, stopReason = "stop", extra = {}) => ({
  type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra },
});
const row = (id, extra = {}) => ({ id, cwd: process.cwd(), firstMessage: id, ...extra });

function fixture(rows = [row("main")]) {
  const listeners = new Set();
  const calls = [];
  const starts = [];
  const sources = [];
  let running = false;
  let alive = true;
  let onSend = () => null;
  const wrapper = {
    isRunning: () => running,
    isAlive: () => alive,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    send(command) { calls.push(command); return Promise.resolve(onSend(command)); },
  };
  const access = {
    list: async () => rows,
    get: async () => wrapper,
    start: async (...args) => { starts.push(args); return { session: wrapper, realSessionId: args[0].startsWith("__new__") ? "new" : args[0] }; },
    resolvePath: async () => "/session.jsonl",
    allowRoot: async () => {},
    invalidateList: async () => {},
    registerSource(_wrapper, source) { sources.push(source); return () => sources.splice(sources.indexOf(source), 1); },
  };
  const emit = (event) => { for (const fn of listeners) fn(event); };
  const begin = () => {
    onSend = (command) => {
      if (command.type !== "prompt") return;
      running = true;
      emit(user(command.message, "message_start"));
      emit(user(command.message));
    };
  };
  const finish = (text = "final") => {
    emit(assistant(text));
    emit({ type: "agent_end" });
    emit({ type: "agent_settled", aborted: false });
    running = false;
    emit({ type: "prompt_done" });
  };
  return { access, wrapper, listeners, calls, starts, sources, emit, begin, finish,
    host: createPiSessionHost(access), setRunning: (value) => { running = value; },
    setAlive: (value) => { alive = value; }, setSend: (fn) => { onSend = fn; } };
}

const signal = () => new AbortController().signal;
const inputSource = { channel: "telegram", botId: "bot", botName: "TG", chatId: "42", senderId: "42", messageId: "1" };

test("source registration begins only after the shared Web run is idle, and is released after the reply", async () => {
  const f = fixture();
  f.setRunning(true);
  f.begin();
  const pending = f.host.prompt("main", "IM input", signal(), inputSource);
  await tick();
  assert.equal(f.sources.length, 0);
  f.setRunning(false);
  f.emit({ type: "agent_settled" });
  await tick();
  assert.equal(f.sources.length, 1);
  assert.equal(f.sources[0].chatId, "42");
  assert.match(f.sources[0].requestId, /^[0-9a-f-]{36}$/);
  f.finish();
  assert.equal(await pending, "final");
  assert.equal(f.sources.length, 0);
});

test("busy refusals and cancelled IM requests release their temporary source registration", async () => {
  const refused = fixture();
  refused.setSend(() => Promise.reject(new Error("private error")));
  await assert.rejects(refused.host.prompt("main", "input", signal(), inputSource), /暂时无法接收/);
  assert.equal(refused.sources.length, 0);
  const cancelled = fixture();
  cancelled.begin();
  const controller = new AbortController();
  const pending = cancelled.host.prompt("main", "input", controller.signal, inputSource);
  await tick();
  assert.equal(cancelled.sources.length, 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled.sources.length, 0);
});

test("catalogue and exists restrict the cwd and ordinary sessions, preserving forks", async () => {
  const f = fixture([
    row("main", { name: "Named" }), row("fork", { relation: { kind: "fork" }, parentSessionId: "main" }),
    row("subagent", { relation: { kind: "subagent" } }), row("side", { relation: { kind: "side" } }),
    row("other", { cwd: "/another-project" }), row("pending", { detailsPending: true }),
  ]);
  assert.deepEqual((await f.host.list(`${process.cwd()}/.`)).map((value) => value.id), ["main", "fork"]);
  assert.equal((await f.host.list(process.cwd()))[0].title, "Named");
  assert.equal(await f.host.exists("fork", process.cwd()), true);
  for (const id of ["subagent", "side", "other", "pending", "missing"]) {
    assert.equal(await f.host.exists(id, process.cwd()), false);
  }
  assert.equal(f.starts.length, 0);
});

test("create uses unique new-session keys, allows the cwd and leaves naming to extensions", async () => {
  const f = fixture();
  const allowed = [];
  let invalidations = 0;
  f.access.allowRoot = async (cwd) => { allowed.push(cwd); };
  f.access.invalidateList = async () => { invalidations++; };
  assert.equal(await f.host.create(process.cwd(), "IM title"), "new");
  await f.host.create(process.cwd(), "IM title");
  assert.match(f.starts[0][0], /^__new__[0-9a-f-]{36}$/);
  assert.notEqual(f.starts[0][0], f.starts[1][0]);
  assert.equal(f.starts[0][1], "");
  assert.deepEqual(allowed, [process.cwd(), process.cwd()]);
  assert.equal(invalidations, 2);
  assert.deepEqual(f.calls, []);
});

test("collector replaces pre-tool process text with only the final assistant answer", () => {
  const c = new PiAnswerCollector(marker);
  c.accept(assistant("unrelated previous Web reply"));
  c.accept(user(marker, "message_start"));
  c.accept(user());
  c.accept(assistant("I will run a tool", "toolUse", { content: [{ type: "text", text: "process" }, { type: "toolCall", id: "tool" }] }));
  c.accept({ type: "message_end", message: { role: "toolResult", content: "tool output" } });
  c.accept({ type: "message_end", message: { role: "custom", customType: "subagent-notification", content: "child text" } });
  c.accept(assistant("Final answer", "stop", { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Final answer" }] }));
  c.accept({ type: "agent_end" });
  assert.equal(c.result(true), undefined, "agent_end is not final; a retry may follow");
  c.accept({ type: "agent_settled" });
  assert.equal(c.result(false), undefined);
  assert.equal(c.result(true), "Final answer");
});

test("collector waits for subagents and returns the parent's settled answer", () => {
  const c = new PiAnswerCollector(marker);
  c.accept(user());
  c.accept(assistant("waiting"));
  c.accept({ type: "agent_settled", subagentsActive: true });
  c.accept({ type: "prompt_done", subagentsActive: true });
  assert.equal(c.result(true), undefined);
  c.accept({ type: "message_end", message: { role: "custom", content: "child report" } });
  c.accept({ type: "agent_start" });
  c.accept(assistant("parent final"));
  c.accept({ type: "agent_settled", subagentsActive: false });
  assert.equal(c.result(true), "parent final");
  const noReply = new PiAnswerCollector(marker);
  noReply.accept(user()); noReply.accept(assistant("waiting for children"));
  noReply.accept({ type: "agent_settled", subagentsActive: true });
  noReply.accept({ type: "agent_start" });
  noReply.accept({ type: "agent_settled", subagentsActive: false });
  assert.throws(() => noReply.result(true), /最终/);
});

test("collector refuses foreign users, rewritten input and incomplete terminal messages", () => {
  for (const foreign of [user("Web", "message_start"), user("Web")]) {
    const c = new PiAnswerCollector(marker);
    c.accept(user()); c.accept(assistant("own")); c.accept(foreign);
    c.accept(assistant("Web answer")); c.accept({ type: "prompt_done" });
    assert.throws(() => c.result(true), /其他消息/);
  }
  const rewritten = new PiAnswerCollector(marker);
  rewritten.accept({ type: "prompt_done" });
  assert.throws(() => rewritten.result(true), /未能确认/);
  for (const reason of ["toolUse", "length", "aborted", "error"]) {
    const c = new PiAnswerCollector(marker);
    c.accept(user()); c.accept(assistant("partial", reason, { errorMessage: "secret credential" }));
    c.accept({ type: "prompt_done" });
    assert.throws(() => c.result(true), (error) => !error.message.includes("secret"));
  }
});

test("prompt preflight is not completion and events emitted synchronously by send are retained", async () => {
  const f = fixture(); f.begin();
  let complete = false;
  const reply = f.host.prompt("main", "hello", signal()).then((value) => { complete = true; return value; });
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].streamingBehavior, undefined);
  assert.match(f.calls[0].message, /^\[IM request [0-9a-f-]+\]\nhello$/);
  assert.equal(complete, false);
  f.emit(assistant("tool process", "toolUse"));
  f.finish("only final");
  assert.equal(await reply, "only final");
  assert.equal(f.listeners.size, 0);
});

test("an existing Web run is waited out and never attributed to IM", async () => {
  const f = fixture(); f.setRunning(true); f.begin();
  const reply = f.host.prompt("main", "IM text", signal());
  await tick();
  assert.equal(f.calls.length, 0);
  f.finish("Web reply");
  await tick();
  assert.equal(f.calls.length, 1);
  f.finish("IM reply");
  assert.equal(await reply, "IM reply");
});

test("same-session prompts across host instances serialize even when their texts match", async () => {
  const f = fixture(); f.begin();
  const otherHost = createPiSessionHost(f.access);
  const first = f.host.prompt("main", "same text", signal());
  const second = otherHost.prompt("main", "same text", signal());
  await tick(); assert.equal(f.calls.length, 1);
  f.finish("first"); assert.equal(await first, "first");
  await tick(); assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].message, f.calls[1].message);
  f.finish("second"); assert.equal(await second, "second");
});

test("foreign Web messages during an IM run fail closed without aborting the shared task", async () => {
  const f = fixture(); f.begin();
  const reply = f.host.prompt("main", "IM", signal());
  const rejected = assert.rejects(reply, /其他消息/);
  await tick();
  f.emit(user("Web follow-up", "message_start"));
  f.finish("mixed answer");
  await rejected;
  assert.deepEqual(f.calls.map((command) => command.type), ["prompt"]);
  assert.equal(f.listeners.size, 0);
});

test("signal abort cancels idle/queue/answer waits and never sends abort to Web", async () => {
  for (const phase of ["idle", "answer", "queue"]) {
    const f = fixture(); f.begin();
    if (phase === "idle") f.setRunning(true);
    let first;
    if (phase === "queue") first = f.host.prompt("main", "first", signal());
    const controller = new AbortController();
    const pending = f.host.prompt("main", "cancelled", controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await tick(); controller.abort(); await rejected;
    if (first) { f.finish("first"); await first; }
    assert.ok(f.calls.every((command) => command.type === "prompt"));
    assert.equal(f.listeners.size, 0);
  }
});

test("reopening uses the exact mapped id/path; no latest-project fallback", async () => {
  const f = fixture(); f.begin();
  f.access.get = async () => undefined;
  const reply = f.host.prompt("main", "resume", signal());
  await tick();
  assert.deepEqual(f.starts, [["main", "/session.jsonl"]]);
  f.finish(); await reply;
  await assert.rejects(f.host.prompt("missing", "text", signal()), /不存在/);
  assert.equal(f.starts.length, 1);
});

test("stop sends wrapper abort only to an already live ordinary session", async () => {
  const f = fixture();
  await f.host.stop("main");
  assert.deepEqual(f.calls, [{ type: "abort" }]);
  f.setAlive(false); await f.host.stop("main");
  assert.equal(f.calls.length, 1); assert.equal(f.starts.length, 0);
  const child = fixture([row("child", { relation: { kind: "subagent" } })]);
  await assert.rejects(child.host.stop("child"), /普通/);
  assert.equal(child.calls.length, 0);
});

test("busy/send failures and asynchronous errors never expose provider secrets", async () => {
  const f = fixture();
  f.wrapper.send = async () => { throw new Error("token=secret-password"); };
  await assert.rejects(f.host.prompt("main", "text", signal()), (error) => !error.message.includes("secret"));
  assert.equal(f.listeners.size, 0);
  const g = fixture(); g.begin();
  const pending = g.host.prompt("main", "text", signal());
  const rejected = assert.rejects(pending, (error) => !error.message.includes("secret"));
  await tick(); g.emit({ type: "prompt_error", errorMessage: "token=secret-password" });
  await rejected; assert.equal(g.listeners.size, 0);
});

test("cancelling a queued caller does not allow its successor to overtake the active call", async () => {
  const f = fixture(); f.begin();
  const first = f.host.prompt("main", "first", signal());
  const controller = new AbortController();
  const cancelled = f.host.prompt("main", "cancelled", controller.signal);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  const third = f.host.prompt("main", "third", signal());
  await tick(); controller.abort(); await rejected;
  await tick(); assert.equal(f.calls.length, 1);
  f.finish("first"); await first;
  await tick(); assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].message.endsWith("\nthird"));
  f.finish("third"); assert.equal(await third, "third");
});

test("real wrapper preflight returns while the host still awaits this prompt's terminal events", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
  let emit;
  let finishRun;
  const inner = {
    sessionId: "real-wrapper-im", sessionFile: "", isStreaming: false, isCompacting: false, isBashRunning: false,
    model: { provider: "test", id: "test" }, agent: { state: { thinkingLevel: "low" } }, systemPrompt: "",
    sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined, getEntries: () => [], getBranch: () => [] },
    extensionRunner: {}, bindExtensions: async () => {},
    subscribe(fn) { emit = fn; return () => {}; },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    prompt: async (text, options) => {
      inner.isStreaming = true;
      emit({ type: "agent_start" });
      emit(user(text, "message_start")); emit(user(text));
      options.preflightResult("started");
      await new Promise((resolve) => { finishRun = resolve; });
      emit(assistant("real final")); emit({ type: "agent_end" });
      inner.isStreaming = false;
      emit({ type: "agent_settled", aborted: false });
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start(); wrapper.beginExtensionBinding();
  t.after(() => wrapper.destroy());
  const f = fixture([row("real-wrapper-im")]);
  f.access.get = async () => wrapper;
  let completed = false;
  const reply = f.host.prompt("real-wrapper-im", "hello", signal()).then((text) => { completed = true; return text; });
  await tick(); await tick();
  assert.equal(typeof finishRun, "function");
  assert.equal(completed, false);
  finishRun();
  assert.equal(await reply, "real final");
});
