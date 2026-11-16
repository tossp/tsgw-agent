import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listManagedSessions, readManagedSession, renameManagedSession, archiveManagedSession, projectSessions } = await jiti.import("./index.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../lib/session-reader.ts");
const { readSessionUiState } = await jiti.import("../../lib/session-ui-state.ts");
const { createSideSession } = await jiti.import("../../lib/session-fork.ts");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-session-management-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  const previousLocks = globalThis.__piStartLocks;
  process.env.PI_CODING_AGENT_DIR = directory;
  globalThis.__piSessions = new Map();
  globalThis.__piStartLocks = new Map();
  invalidateSessionListCache();
  const paths = [];
  t.after(async () => {
    for (const id of paths) invalidateSessionPathCache(id);
    globalThis.__piSessions = previousRegistry;
    globalThis.__piStartLocks = previousLocks;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    invalidateSessionListCache();
    await rm(directory, { recursive: true, force: true });
  });
  const create = async (project, title, text = "fixture task") => {
    const cwd = join(directory, project);
    await mkdir(cwd, { recursive: true });
    const manager = SessionManager.create(cwd);
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture response" }], timestamp: Date.now() });
    if (title) manager.appendSessionInfo(title);
    cacheSessionPath(manager.getSessionId(), manager.getSessionFile());
    paths.push(manager.getSessionId());
    invalidateSessionListCache();
    return { manager, cwd, id: manager.getSessionId(), file: manager.getSessionFile() };
  };
  return { directory, create, register(id, file) { cacheSessionPath(id, file); paths.push(id); } };
}

test("shared project lookup canonicalizes aliases, retains forks and excludes side/subagent/summary rows", async t => {
  const f = await fixture(t);
  const cwd = join(f.directory, "project"), alias = join(f.directory, "alias");
  await mkdir(cwd);
  await symlink(cwd, alias);
  const row = (id, patch = {}) => ({ id, cwd, ...patch });
  const rows = [row("main"), row("fork", { relation: { kind: "fork" } }), row("side", { relation: { kind: "side" } }), row("child", { relation: { kind: "subagent" } }), row("summary", { detailsPending: true }), row("other", { cwd: f.directory })];
  assert.deepEqual(projectSessions(rows, alias).map(item => item.id), ["main", "fork"]);
});

test("catalogue searches titles and body, scopes projects, and shares the Web archive state", async t => {
  const f = await fixture(t);
  const first = await f.create("one", "当前标题", "早先讨论的特别主题");
  const second = await f.create("two", "另一个目标");
  assert.deepEqual(new Set((await listManagedSessions()).sessions.map(item => item.sessionId)), new Set([first.id, second.id]));
  const title = await listManagedSessions({ query: "当前标题" });
  assert.deepEqual(title.sessions.map(item => item.sessionId), [first.id]);
  const content = await listManagedSessions({ cwd: first.cwd, query: "特别主题" });
  assert.deepEqual(content.sessions.map(item => item.sessionId), [first.id]);
  assert.ok(content.sessions[0].matchEntryId);
  assert.equal((await listManagedSessions({ cwd: second.cwd, query: "特别主题" })).sessions.length, 0);
  assert.deepEqual(await archiveManagedSession(first.id, true), { sessionId: first.id, familySessionId: first.id, requestedArchived: true, archived: true });
  assert.ok(readSessionUiState().sessions[first.id].archivedAt);
  assert.deepEqual((await listManagedSessions({ archived: true })).sessions.map(item => item.sessionId), [first.id]);
  assert.deepEqual((await listManagedSessions({ archived: false })).sessions.map(item => item.sessionId), [second.id]);
  assert.equal((await archiveManagedSession(first.id, false)).archived, false);
  assert.equal(readSessionUiState().sessions[first.id], undefined);
  assert.equal(existsSync(first.file), true);
  assert.equal(globalThis.__piSessions.size, 0, "observation and archiving must not start a wrapper");
});

test("read paginates the actual branch without rewriting old files or exposing media and thinking", async t => {
  const f = await fixture(t);
  const original = await f.create("old", "历史会话");
  const entries = [{ type: "session", version: 2, id: original.id, cwd: original.cwd, timestamp: new Date().toISOString() }];
  for (let i = 0; i < 75; i++) entries.push({
    type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: new Date().toISOString(),
    message: i % 2 ? { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THINKING" }, { type: "text", text: `answer ${i}` }], timestamp: Date.now() }
      : { role: "user", content: [{ type: "text", text: `question ${i}\u2028line` }, { type: "image", data: "BASE64_SECRET", mimeType: "image/png" }], timestamp: Date.now() },
  });
  // A different branch appears in the same file but is not an ancestor of the current tip.
  entries.splice(40, 0, { type: "message", id: "other", parentId: "e0", timestamp: new Date().toISOString(), message: { role: "user", content: "UNSELECTED BRANCH", timestamp: Date.now() } });
  await writeFile(original.file, entries.map(entry => JSON.stringify(entry)).join("\n") + '\n{"torn":');
  const beforeBytes = await readFile(original.file), beforeStat = await stat(original.file);
  const page = await readManagedSession(original.id);
  assert.equal(page.messages.length, 50);
  assert.equal(page.messages[0].entryId, "e25");
  assert.equal(page.leafId, "e74");
  assert.equal(page.nextBefore, "e25");
  const prior = await readManagedSession(original.id, page.nextBefore);
  assert.equal(prior.messages.length, 25);
  assert.equal(prior.nextBefore, null);
  assert.ok(page.messages.every(message => !prior.messages.some(previous => previous.entryId === message.entryId)));
  assert.ok(!JSON.stringify([page, prior]).includes("PRIVATE THINKING"));
  assert.ok(!JSON.stringify([page, prior]).includes("BASE64_SECRET"));
  assert.ok(!JSON.stringify([page, prior]).includes("UNSELECTED BRANCH"));
  assert.ok(prior.messages[0].text.includes("\u2028"));
  await assert.rejects(readManagedSession(original.id, "missing"), /Pagination entry/);
  assert.deepEqual(await readFile(original.file), beforeBytes);
  assert.equal((await stat(original.file)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(globalThis.__piSessions.size, 0);
});

test("v1 sessions keep stable pagination IDs through repeated in-memory migration", async t => {
  const f = await fixture(t);
  const original = await f.create("v1", "旧格式");
  const entries = [{ type: "session", id: original.id, cwd: original.cwd, timestamp: new Date().toISOString() }];
  for (let i = 0; i < 70; i++) entries.push({
    type: "message", timestamp: new Date().toISOString(),
    message: { role: "user", content: `legacy ${i}`, timestamp: Date.now() },
  });
  entries.splice(40, 0, { type: "compaction", summary: "legacy compaction", firstKeptEntryIndex: 10, tokensBefore: 1000, timestamp: new Date().toISOString() });
  await writeFile(original.file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const beforeBytes = await readFile(original.file), beforeStat = await stat(original.file);
  const latest = await readManagedSession(original.id);
  assert.equal(latest.messages.length, 50);
  assert.ok(latest.nextBefore);
  const earlier = await readManagedSession(original.id, latest.nextBefore);
  assert.equal(earlier.messages.length, 21);
  assert.equal(earlier.nextBefore, null);
  assert.equal(earlier.messages[0].text, "legacy 0");
  assert.equal(latest.messages.at(-1).text, "legacy 69");
  assert.equal(new Set([...earlier.messages, ...latest.messages].map(message => message.entryId)).size, 71);
  assert.ok(latest.messages.some(message => message.text.includes("legacy compaction")));
  assert.deepEqual(await readManagedSession(original.id), latest);
  assert.deepEqual(await readFile(original.file), beforeBytes);
  assert.equal((await stat(original.file)).mtimeMs, beforeStat.mtimeMs);
});

test("rename reports the title normalized by the SDK and repeated multiline input is a no-op", async t => {
  const f = await fixture(t);
  const target = await f.create("multiline", "old");
  const input = "  目标A\r\n\n目标B  ";
  const renamed = await renameManagedSession(target.id, input);
  assert.equal(renamed.title, "目标A 目标B");
  assert.equal((await readManagedSession(target.id)).title, renamed.title);
  const saved = await readFile(target.file);
  assert.equal((await renameManagedSession(target.id, input)).changed, false);
  assert.deepEqual(await readFile(target.file), saved);
});

test("offline rename uses the existing mutation path, trims names, refreshes lookup and treats identical names as no-op", async t => {
  const f = await fixture(t);
  const target = await f.create("rename", "旧目标");
  const bytes = await readFile(target.file);
  await assert.rejects(renameManagedSession(target.id, " \n "), /must not be empty/);
  assert.deepEqual(await readFile(target.file), bytes);
  assert.deepEqual(await renameManagedSession(target.id, "  当前目标  "), { sessionId: target.id, previousTitle: "旧目标", title: "当前目标", changed: true });
  assert.equal((await readManagedSession(target.id)).title, "当前目标");
  assert.equal((await listManagedSessions({ cwd: target.cwd })).sessions[0].title, "当前目标");
  const renamedBytes = await readFile(target.file);
  assert.equal((await renameManagedSession(target.id, "当前目标")).changed, false);
  assert.deepEqual(await readFile(target.file), renamedBytes);
  await assert.rejects(renameManagedSession("missing", "new"), /not found/);
});

test("read retains tool failures and empty provider error responses for outcome verification", async t => {
  const f = await fixture(t);
  const target = await f.create("errors", "失败核实");
  target.manager.appendMessage({ role: "toolResult", toolCallId: "fixture-call", toolName: "write", content: [{ type: "text", text: "write refused" }], isError: true, timestamp: Date.now() });
  target.manager.appendMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "fixture provider failure", timestamp: Date.now() });
  const read = await readManagedSession(target.id);
  assert.equal(read.messages.find(message => message.role === "toolResult").isError, true);
  assert.equal(read.messages.find(message => message.role === "toolResult").toolName, "write");
  assert.equal(read.messages.at(-1).stopReason, "error");
  assert.equal(read.messages.at(-1).errorMessage, "fixture provider failure");
});

test("archiving a side session updates the existing family root and preserves session files", async t => {
  const f = await fixture(t);
  const root = await f.create("family", "家族根");
  const copy = createSideSession(root.file);
  const side = { id: copy.sessionId, file: copy.path };
  f.register(side.id, side.file);
  invalidateSessionListCache();
  const before = await readFile(side.file);
  const result = await archiveManagedSession(side.id, true);
  assert.equal(result.familySessionId, root.id);
  assert.equal(result.archived, true);
  assert.ok(readSessionUiState().sessions[root.id].archivedAt);
  assert.equal(readSessionUiState().sessions[side.id], undefined);
  assert.deepEqual((await listManagedSessions({ cwd: root.cwd })).sessions.map(item => item.sessionId), [root.id]);
  assert.deepEqual(await readFile(side.file), before);
  assert.equal((await archiveManagedSession(side.id, false)).archived, false);
});

test("archive retains Web family behavior for new activity", async t => {
  const f = await fixture(t);
  const target = await f.create("active", "活动会话");
  assert.equal((await archiveManagedSession(target.id, true)).archived, true);
  target.manager.appendMessage({ role: "user", content: "new activity", timestamp: Date.now() + 60_000 });
  target.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "new response" }], timestamp: Date.now() + 60_000 });
  invalidateSessionListCache();
  assert.equal((await listManagedSessions({ cwd: target.cwd })).sessions[0].archived, false);
  await assert.rejects(archiveManagedSession("missing", true), /not found/);
});
