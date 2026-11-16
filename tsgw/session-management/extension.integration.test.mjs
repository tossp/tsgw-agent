import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, createCodemodeExtension,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionManagementExtension, SESSION_MANAGEMENT_TOOL_NAMES } = await jiti.import("./extension.ts");
const { AgentSessionWrapper, getRpcSession, getRpcStartingSessionIds } = await jiti.import("../../lib/rpc-manager.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../lib/session-reader.ts");
const { resetSessionUiStateCacheForTests } = await jiti.import("../../lib/session-ui-state.ts");

const NAMES = [...SESSION_MANAGEMENT_TOOL_NAMES];
const answer = (text = "done") => fauxAssistantMessage([fauxText(text)]);
const textOf = (message) => typeof message.content === "string"
  ? message.content
  : message.content.map((block) => block.text ?? "").join("");
const fileEntries = async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

/**
 * Real SDK sessions in a throwaway agent directory, a local faux provider and the
 * host's own wrapper registry. Only the fixture's script tool is synthetic: it is
 * how a codemode script reaches `ctx.executeTool` without a live model.
 */
async function withFixture(t, check) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-session-management-"));
  const sessionDir = join(dir, "sessions");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  const previousLocks = globalThis.__piStartLocks;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  globalThis.__piStartLocks = new Map();
  invalidateSessionListCache();
  resetSessionUiStateCacheForTests();

  const wrappers = new Set();
  let script = null;
  const scriptExtension = (pi) => pi.registerTool({
    name: "fixture_script", label: "fixture script", description: "Fixture-only nested tool dispatch",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      assert.ok(script, "the fixture script was not installed");
      const details = await script(ctx);
      return { content: [{ type: "text", text: JSON.stringify(details ?? null) }], details };
    },
  });
  const open = async (target, extraFactories) => {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(target.faux.provider);
    const services = await createAgentSessionServices({
      cwd: target.cwd, agentDir: dir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ defaultTools: ["+codemode"] }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension({ models: false }) },
          createSessionManagementExtension(), scriptExtension, ...extraFactories,
        ],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services, sessionManager: target.manager, model: target.faux.getModel("faux-model"),
    });
    const wrapper = new AgentSessionWrapper(session);
    wrappers.add(wrapper);
    target.wrapper = wrapper;
    wrapper.start();
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    globalThis.__piSessions.set(target.id, wrapper);
    return wrapper;
  };
  const create = async ({ live = true, cwd = join(dir, "project"), listeners = [] } = {}) => {
    await mkdir(cwd, { recursive: true });
    const manager = SessionManager.create(cwd, join(sessionDir, basename(cwd)));
    const id = manager.getSessionId();
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `fixture seed ${id}` }], timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture reply" }], timestamp: Date.now() });
    const faux = fauxProvider({ models: [{ id: "faux-model" }] });
    const target = { id, manager, faux, cwd, file: manager.getSessionFile() };
    if (live) await open(target, listeners);
    return target;
  };
  const lastResult = (target, toolName) => target.wrapper.inner.agent.state.messages
    .findLast((message) => message.role === "toolResult" && message.toolName === toolName);
  const runScript = async (target, body) => {
    script = body;
    target.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("fixture_script", {})], { stopReason: "toolUse" }), answer(),
    ]);
    await target.wrapper.inner.prompt("Run the fixture script");
    const result = lastResult(target, "fixture_script");
    assert.equal(result?.isError, false, result && textOf(result));
    return JSON.parse(textOf(result));
  };
  const runCodemode = async (target, code) => {
    target.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), answer(),
    ]);
    await target.wrapper.inner.prompt("Run a codemode script");
    const result = lastResult(target, "codemode");
    assert.equal(result?.isError, false, result && textOf(result));
    const text = textOf(result);
    const start = text.indexOf("Output:\n");
    return start < 0 ? text : JSON.parse(text.slice(start + "Output:\n".length));
  };
  try {
    await check({ dir, create, runScript, runCodemode });
  } finally {
    for (const wrapper of wrappers) {
      await wrapper.inner.abort().catch(() => undefined);
      wrapper.destroy();
    }
    for (const id of [...(globalThis.__piSessions?.keys() ?? [])]) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    resetSessionUiStateCacheForTests();
    globalThis.__piSessions = previousRegistry;
    globalThis.__piStartLocks = previousLocks;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}

test("session tools are codemode-only, discoverable, and return structured results when nested", { timeout: 40_000 }, async (t) => {
  await withFixture(t, async (f) => {
    const announced = [];
    const caller = await f.create({ listeners: [(pi) => pi.on("session_info_changed", (event) => announced.push(event.name))] });
    const idle = await f.create({ live: false, cwd: join(f.dir, "other-project") });
    const session = caller.wrapper.inner;

    assert.deepEqual([...NAMES].sort(), ["archive_session", "list_sessions", "read_session", "rename_session"]);
    for (const name of NAMES) {
      assert.equal(session.getAllTools().find((tool) => tool.name === name)?.exposure, "codemode", name);
      assert.equal(session.getActiveToolNames().includes(name), false, `${name} must not be declared directly`);
      assert.ok(session.getCallableToolNames().includes(name), `${name} must stay callable through codemode`);
    }

    let declared = [];
    caller.faux.setResponses([(context) => {
      declared = getCurrentTools(context.messages).map((tool) => tool.name);
      return answer("inspected");
    }]);
    await session.prompt("Inspect the declared tools");
    for (const name of NAMES) assert.equal(declared.includes(name), false, `${name} in the model request`);
    assert.ok(declared.includes("codemode"));

    caller.faux.setResponses([
      fauxAssistantMessage(NAMES.map((name) => fauxToolCall(name, {})), { stopReason: "toolUse" }), answer(),
    ]);
    await session.prompt("Call the codemode-only tools directly");
    const refused = session.agent.state.messages.filter((message) => message.role === "toolResult");
    assert.deepEqual(refused.map((message) => message.toolName), NAMES);
    for (const message of refused) assert.equal(message.isError, true, message.toolName);

    const discovery = await f.runCodemode(caller, `
      const found = await searchTools("session", { limit: 20 });
      return {
        names: found.map((tool) => tool.name),
        described: [await describeTool("read_session") !== undefined, await describeTool("archive_session") !== undefined],
      };
    `);
    for (const name of NAMES) assert.ok(discovery.names.includes(name), `${name} must be discoverable`);
    assert.deepEqual(discovery.described, [true, true]);

    const listed = await f.runCodemode(caller, "return await tools.list_sessions({});");
    assert.deepEqual(listed.sessions.map((row) => row.sessionId).sort(), [caller.id, idle.id].sort());

    const outcomes = await f.runScript(caller, async (ctx) => {
      const rows = [];
      for (const [name, args] of [["list_sessions", {}], ["read_session", {}], ["archive_session", { archived: false }]]) {
        rows.push({ name, ...(await ctx.executeTool(name, args)) });
      }
      const leafBefore = ctx.sessionManager.getLeafId();
      rows.push({ name: "rename_session", leafBefore, ...(await ctx.executeTool("rename_session", { title: "Renamed through the SDK" })) });
      return { currentSessionId: ctx.sessionManager.getSessionId(), rows };
    });

    assert.equal(outcomes.currentSessionId, caller.id);
    for (const row of outcomes.rows) {
      assert.equal(row.isError, false, row.name);
      assert.deepEqual(row.result.structuredContent, row.result.details, row.name);
      assert.deepEqual(JSON.parse(textOf(row.result)), row.result.structuredContent, row.name);
    }
    const [list, read, archive, rename] = outcomes.rows.map((row) => ({ ...row, data: row.result.structuredContent }));

    assert.equal(list.name, "list_sessions");
    assert.deepEqual(list.data.sessions.map((row) => row.sessionId).sort(), [caller.id, idle.id].sort());
    const callerRow = list.data.sessions.find((row) => row.sessionId === caller.id);
    assert.equal(callerRow.running, true, "the calling session is reported as running");
    assert.equal(list.data.sessions.find((row) => row.sessionId === idle.id).running, false);
    assert.equal(read.name, "read_session");
    assert.equal(read.data.sessionId, caller.id, "an omitted ID reads the current session");
    assert.equal(read.data.cwd, caller.cwd);
    assert.ok(read.data.leafId);
    assert.ok(read.data.messages.some((message) => message.role === "user" && message.text.includes(caller.id)));
    assert.ok(read.data.messages.some((message) => message.role === "assistant" && message.text === "fixture reply"));
    assert.equal(read.data.nextBefore, null);
    assert.equal(archive.name, "archive_session");
    assert.equal(archive.data.sessionId, caller.id, "an omitted ID archives the current session");
    assert.equal(archive.data.familySessionId, caller.id);
    assert.equal(archive.data.requestedArchived, false);
    assert.equal(rename.name, "rename_session");
    assert.equal(rename.data.sessionId, caller.id, "an omitted ID renames the current session");
    assert.equal(rename.data.title, "Renamed through the SDK");
    assert.equal(rename.data.changed, true);
    assert.equal(session.sessionManager.getSessionName(), "Renamed through the SDK");
    assert.deepEqual(announced, ["Renamed through the SDK"]);
    assert.equal(getRpcSession(caller.id), caller.wrapper, "the live session was renamed in place");

    const info = (await fileEntries(caller.file)).filter((entry) => entry.type === "session_info");
    assert.equal(info.length, 1);
    assert.equal(info[0].name, "Renamed through the SDK");
    assert.equal(info[0].parentId, rename.leafBefore, "the entry hangs off the leaf current at the call");

    const same = await f.runScript(caller, async (ctx) => (await ctx.executeTool("rename_session", { title: "Renamed through the SDK" })).result.structuredContent);
    assert.equal(same.changed, false, "an identical title is a no-op");
    assert.equal((await fileEntries(caller.file)).filter((entry) => entry.type === "session_info").length, 1);
  });
});

test("reads never start a wrapper or rewrite a session file; rename writes through a live session", { timeout: 40_000 }, async (t) => {
  await withFixture(t, async (f) => {
    const caller = await f.create();
    const idle = await f.create({ live: false, cwd: join(f.dir, "idle-project") });
    const idleBefore = await readFile(idle.file);
    const idleMtime = (await stat(idle.file)).mtimeMs;

    const readIdle = await f.runScript(caller, async (ctx) => (await ctx.executeTool("read_session", { session_id: idle.id })).result.structuredContent);
    assert.equal(readIdle.sessionId, idle.id);
    assert.deepEqual(readIdle.messages.map((message) => message.role), ["user", "assistant"]);
    assert.ok(readIdle.messages[0].text.includes(idle.id));
    assert.equal(readIdle.nextBefore, null);
    assert.equal(getRpcSession(idle.id), undefined, "reading must not start the target");
    assert.deepEqual(getRpcStartingSessionIds(), []);
    assert.deepEqual([...globalThis.__piSessions.keys()], [caller.id]);
    assert.deepEqual(await readFile(idle.file), idleBefore, "reading must not rewrite the old JSONL");
    assert.equal((await stat(idle.file)).mtimeMs, idleMtime);
    assert.equal(idle.faux.state.callCount, 0);

    const announced = [];
    const target = await f.create({ listeners: [(pi) => pi.on("session_info_changed", (event) => announced.push(event.name))] });
    const tip = target.wrapper.inner.sessionManager.getLeafId();
    const targetBefore = await readFile(target.file);
    const targetMtime = (await stat(target.file)).mtimeMs;
    const readLive = await f.runScript(caller, async (ctx) => (await ctx.executeTool("read_session", { session_id: target.id })).result.structuredContent);
    assert.equal(readLive.sessionId, target.id);
    assert.ok(readLive.messages.some((message) => message.text === "fixture reply"));
    assert.deepEqual(await readFile(target.file), targetBefore, "reading a live session does not write its file");
    assert.equal((await stat(target.file)).mtimeMs, targetMtime);

    const renamed = await f.runScript(caller, async (ctx) => (await ctx.executeTool("rename_session", { session_id: target.id, title: "Retitled live target" })).result.structuredContent);
    assert.equal(renamed.sessionId, target.id);
    assert.equal(renamed.title, "Retitled live target");
    assert.equal(renamed.changed, true);
    assert.notEqual(renamed.previousTitle, renamed.title);
    assert.equal(target.wrapper.inner.sessionManager.getSessionName(), "Retitled live target", "the live AgentSession learned the name");
    assert.deepEqual(announced, ["Retitled live target"], "extensions got session_info_changed");
    assert.equal(getRpcSession(target.id), target.wrapper, "rename reuses the live wrapper");

    const entries = await fileEntries(target.file);
    const info = entries.filter((entry) => entry.type === "session_info");
    assert.equal(info.length, 1);
    assert.equal(info[0].name, "Retitled live target");
    assert.equal(info[0].parentId, tip, "appended at the live target's current leaf");
    assert.equal(target.wrapper.inner.sessionManager.getLeafId(), info[0].id);
    assert.equal(entries.at(-1).id, info[0].id);
  });
});

test("archive_session targets the sidebar family and reports requested and effective state", { timeout: 40_000 }, async (t) => {
  await withFixture(t, async (f) => {
    const caller = await f.create();
    const idle = await f.create({ live: false, cwd: join(f.dir, "archive-project") });

    const running = await f.runScript(caller, async (ctx) => (await ctx.executeTool("archive_session", { archived: true })).result.structuredContent);
    assert.equal(running.sessionId, caller.id);
    assert.equal(running.requestedArchived, true);
    assert.equal(running.archived, false, "a running family stays visible under the Web rules");

    const archived = await f.runScript(caller, async (ctx) => (await ctx.executeTool("archive_session", { session_id: idle.id, archived: true })).result.structuredContent);
    assert.equal(archived.sessionId, idle.id);
    assert.equal(archived.familySessionId, idle.id);
    assert.equal(archived.requestedArchived, true);
    assert.equal(archived.archived, true);

    const hidden = await f.runScript(caller, async (ctx) => (await ctx.executeTool("list_sessions", { archived: true })).result.structuredContent);
    assert.ok(hidden.sessions.some((row) => row.sessionId === idle.id && row.archived === true));
    assert.equal(hidden.sessions.some((row) => row.sessionId === caller.id), false);

    const restored = await f.runScript(caller, async (ctx) => (await ctx.executeTool("archive_session", { session_id: idle.id, archived: false })).result.structuredContent);
    assert.equal(restored.requestedArchived, false);
    assert.equal(restored.archived, false);
    const visible = await f.runScript(caller, async (ctx) => (await ctx.executeTool("list_sessions", { archived: false })).result.structuredContent);
    assert.ok(visible.sessions.some((row) => row.sessionId === idle.id));
  });
});
