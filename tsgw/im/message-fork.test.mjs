import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { forkSessionBranch } = await jiti.import("../../lib/session-fork.ts");
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { buildSessionContext } = await jiti.import("../../lib/session-reader.ts");
const { IM_MESSAGE_SOURCE_TYPE } = await jiti.import("./message-data.ts");

function origin(channel, messageId = "1") {
  return {
    requestId: `12345678-1234-1234-1234-${messageId.padStart(12, "0")}`,
    channel, botId: channel, botName: `${channel} bot`, chatId: "chat", senderId: "sender", messageId,
    ...(channel === "telegram" ? { threadId: "topic" } : {}),
  };
}
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const marked = (source) => `[IM request ${source.requestId}]\nsame text`;
function appendIm(manager, source) {
  const id = manager.appendMessage(user(marked(source)));
  manager.appendCustomEntry(IM_MESSAGE_SOURCE_TYPE, { version: 1, messageEntryId: id, source });
  return id;
}

async function fixture(t, via) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-im-fork-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const sessionDir = join(root, "sessions");
  const manager = SessionManager.create(root, sessionDir);
  const f = { root, sessionDir, manager };
  if (via === "wrapper") f.wrapper = await realWrapper(t, f);
  return f;
}

async function realWrapper(t, f) {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const faux = fauxProvider({ models: [{ id: "im-fork-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: f.root, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: f.manager,
    settingsManager, resourceLoader, modelRuntime, model: faux.getModel("im-fork-test"), tools: [],
  });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  return wrapper;
}

async function snapshot(path) {
  return { bytes: await readFile(path), mtime: (await stat(path, { bigint: true })).mtimeNs };
}
async function entries(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
}
async function copiedPath(f, id) {
  const names = await readdir(f.sessionDir);
  const name = names.find((name) => name.endsWith(`_${id}.jsonl`));
  assert.ok(name);
  return join(f.sessionDir, name);
}
async function copy(t, f, via, entryId) {
  if (via === "sidebar") return forkSessionBranch(f.manager.getSessionFile(), entryId).path;
  const wrapper = f.wrapper ?? await realWrapper(t, f);
  const result = await wrapper.send({ type: "fork_branch", entryId });
  assert.equal(result.cancelled, false);
  return copiedPath(f, result.newSessionId);
}
function assertChain(all) {
  const [header, ...es] = all;
  assert.equal(header.type, "session");
  assert.equal(new Set(es.map((e) => e.id)).size, es.length);
  let parentId = null;
  for (const entry of es) {
    assert.equal(entry.parentId, parentId);
    parentId = entry.id;
  }
  return es;
}

for (const via of ["sidebar", "wrapper"]) {
  for (const channel of ["weixin", "telegram"]) {
    test(`${via} real fork at ${channel} user carries following metadata, excludes later input and preserves source`, async (t) => {
      const f = await fixture(t, via);
      const source = origin(channel);
      const kept = appendIm(f.manager, source);
      const excluded = appendIm(f.manager, origin(channel === "weixin" ? "telegram" : "weixin", "2"));
      f.manager.appendLabelChange(kept, "retained input");
      const sourcePath = f.manager.getSessionFile();
      const before = await snapshot(sourcePath);
      const originalEntries = structuredClone(f.manager.getEntries());
      const originalLeaf = f.manager.getLeafId();
      const path = await copy(t, f, via, kept);
      const all = await entries(path);
      const es = assertChain(all);
      assert.equal(all[0].parentSession, sourcePath);
      assert.deepEqual(es.filter((e) => e.type === "message").map((e) => e.id), [kept]);
      assert.ok(es.some((e) => e.type === "label" && e.targetId === kept));
      const meta = es.filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE);
      assert.deepEqual(meta.map((e) => e.data), [{ version: 1, messageEntryId: kept, source }]);
      assert.ok(!es.some((e) => e.data?.messageEntryId === excluded));
      const context = buildSessionContext(es);
      assert.deepEqual(context.entryIds, [kept]);
      assert.deepEqual(context.messages[0].imSource, source);
      assert.equal(context.messages[0].content, "same text");
      assert.equal(es.find((e) => e.id === kept).message.content, marked(source));
      assert.deepEqual(await snapshot(sourcePath), before);
      assert.deepEqual(f.manager.getEntries(), originalEntries);
      assert.equal(f.manager.getLeafId(), originalLeaf);

      // Opening the writable child to continue it must keep a new Web input untagged.
      const child = SessionManager.open(path, f.sessionDir);
      assert.equal(child.getBranch().length, es.length);
      assert.equal(child.getLeafId(), es.at(-1).id);
      const webId = child.appendMessage(user("same text"));
      const resumed = buildSessionContext(child.getEntries());
      assert.equal(resumed.entryIds.at(-1), webId);
      assert.equal(resumed.messages.at(-1).imSource, undefined);
      assert.equal(resumed.messages.at(-1).content, "same text");
      assert.deepEqual(await snapshot(sourcePath), before);
    });
  }

  test(`${via} real fork retains existing metadata once and finds shared input metadata outside its branch`, async (t) => {
    const f = await fixture(t, via);
    const source = origin("telegram");
    const shared = appendIm(f.manager, source);
    const metadataId = f.manager.getLeafId();
    const full = await copy(t, f, via, metadataId);
    assert.equal((await entries(full)).filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE).length, 1);
    f.manager.branch(shared);
    const web = f.manager.appendMessage(user("same text"));
    const before = await snapshot(f.manager.getSessionFile());
    const path = await copy(t, f, via, web);
    const es = assertChain(await entries(path));
    const context = buildSessionContext(es);
    assert.deepEqual(context.entryIds, [shared, web]);
    assert.deepEqual(context.messages.map((m) => m.imSource), [source, undefined]);
    assert.equal(es.filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE).length, 1);
    assert.deepEqual(await snapshot(f.manager.getSessionFile()), before);
  });

  test(`${via} real fork ignores malformed metadata and leaves ordinary Web input intact`, async (t) => {
    const f = await fixture(t, via);
    const web = f.manager.appendMessage(user("same text"));
    f.manager.appendCustomEntry(IM_MESSAGE_SOURCE_TYPE, { version: 2, messageEntryId: web, source: origin("weixin") });
    const path = await copy(t, f, via, web);
    const es = assertChain(await entries(path));
    assert.equal(es.filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE).length, 0);
    assert.deepEqual(buildSessionContext(es).messages, [f.manager.getEntry(web).message]);
  });
}

for (const type of ["fork", "clone"]) {
  for (const channel of ["weixin", "telegram"]) {
    test(`real wrapper ${type} retains ${channel} shared-ancestor metadata outside the copied branch`, async (t) => {
      const f = await fixture(t);
      const source = origin(channel);
      const shared = appendIm(f.manager, source);
      const excluded = appendIm(f.manager, origin(channel === "weixin" ? "telegram" : "weixin", "2"));
      f.manager.branch(shared);
      f.manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "reply" }], api: "test", provider: "test", model: "test",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      });
      const web = f.manager.appendMessage(user("same text"));
      const wrapper = await realWrapper(t, f);
      const sourcePath = f.manager.getSessionFile();
      const before = await snapshot(sourcePath);
      const originalEntries = structuredClone(f.manager.getEntries());
      const originalLeaf = f.manager.getLeafId();
      const result = await wrapper.send({ type, ...(type === "fork" ? { entryId: web } : {}) });
      assert.equal(result.cancelled, false);
      const all = await entries(await copiedPath(f, result.newSessionId));
      const es = assertChain(all);
      assert.equal(all[0].parentSession, sourcePath);
      assert.deepEqual(es.filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE).map((e) => e.data), [
        { version: 1, messageEntryId: shared, source },
      ]);
      assert.ok(!es.some((e) => e.id === excluded || e.data?.messageEntryId === excluded));
      const context = buildSessionContext(es);
      const inputs = context.messages.filter((m) => m.role === "user");
      assert.deepEqual(inputs.map((m) => m.imSource), type === "fork" ? [source] : [source, undefined]);
      assert.ok(inputs.every((m) => m.content === "same text"));
      assert.deepEqual(es.filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.id),
        type === "fork" ? [shared] : [shared, web]);
      assert.deepEqual(await snapshot(sourcePath), before);
      assert.deepEqual(f.manager.getEntries(), originalEntries);
      assert.equal(f.manager.getLeafId(), originalLeaf);
    });
  }
}

test("real wrapper fork-before-user excludes its source and a resubmitted Web draft has no IM source", async (t) => {
  const f = await fixture(t);
  const keptSource = origin("weixin");
  const kept = appendIm(f.manager, keptSource);
  const excluded = appendIm(f.manager, origin("telegram", "2"));
  const wrapper = await realWrapper(t, f);
  const before = await snapshot(f.manager.getSessionFile());
  const result = await wrapper.send({ type: "fork", entryId: excluded });
  assert.equal(result.cancelled, false);
  const path = await copiedPath(f, result.newSessionId);
  const es = assertChain(await entries(path));
  assert.deepEqual(es.filter((e) => e.type === "message").map((e) => e.id), [kept]);
  assert.deepEqual(es.filter((e) => e.customType === IM_MESSAGE_SOURCE_TYPE).map((e) => e.data.messageEntryId), [kept]);
  const child = SessionManager.open(path, f.sessionDir);
  const draftId = child.appendMessage(user("same text"));
  const context = buildSessionContext(child.getEntries());
  assert.deepEqual(context.entryIds, [kept, draftId]);
  assert.deepEqual(context.messages.map((m) => m.imSource), [keptSource, undefined]);
  assert.deepEqual(await snapshot(f.manager.getSessionFile()), before);
});
