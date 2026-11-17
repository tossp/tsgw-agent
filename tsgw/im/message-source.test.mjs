import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installImRequestContextProjection, registerImMessageSource, withLiveImMessageSource } = await jiti.import("./message-source.ts");
const { IM_MESSAGE_SOURCE_TYPE, imMessageSources, readImMessageSource, withImMessageSource } = await jiti.import("./message-data.ts");
const source = {
  requestId: "10000000-0000-0000-0000-000000000001", channel: "telegram", botId: "bot-one",
  botName: "private bot name", chatId: "private chat ID", threadId: "7", senderId: "42", messageId: "100",
};
const message = (text = "original input", id = source.requestId) => ({
  role: "user", content: [{ type: "text", text: `[IM request ${id}]\n${text}` }], timestamp: Date.now(),
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function managerFor(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-meta-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return SessionManager.create(directory, directory);
}

test("real manager records one source against the exact user entry, while live projection preserves the SDK object", async (t) => {
  const manager = await managerFor(t);
  const release = registerImMessageSource(manager, source);
  t.after(release);
  const raw = message();
  const event = { type: "message_start", message: raw };
  const visibleStart = withLiveImMessageSource(event, manager);
  assert.equal(visibleStart.message.imSource.channel, "telegram");
  assert.equal(visibleStart.message.content[0].text, "original input");
  assert.equal(event.message, raw);
  assert.equal(raw.imSource, undefined);
  assert.match(raw.content[0].text, /^\[IM request /);
  assert.equal(manager.getEntries().length, 0);

  const end = { type: "message_end", message: raw };
  const visibleEnd = withLiveImMessageSource(end, manager);
  const id = manager.appendMessage(raw); // The real SDK appends synchronously after emitting message_end.
  await tick();
  assert.deepEqual(visibleEnd.message.imSource, source);
  const entries = manager.getEntries();
  const records = entries.filter((entry) => entry.customType === IM_MESSAGE_SOURCE_TYPE);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].data, { version: 1, messageEntryId: id, source });
  assert.equal(imMessageSources(entries).get(id).messageId, "100");
  assert.ok(!JSON.stringify(manager.buildSessionContext()).includes(source.botName));
  assert.ok(!JSON.stringify(manager.buildSessionContext()).includes(source.chatId));
  const persisted = (await readFile(manager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(persisted.find((entry) => entry.type === "message").message.imSource, undefined);
  assert.deepEqual(persisted.find((entry) => entry.type === "custom").data.source, source);
  withLiveImMessageSource(end, manager);
  await tick();
  assert.equal(manager.getEntries().filter((entry) => entry.type === "custom").length, 1);
});

test("normal Web inputs, foreign request markers and assistant events never acquire pending IM routing", async (t) => {
  const manager = await managerFor(t);
  const release = registerImMessageSource(manager, source);
  for (const raw of [
    { role: "user", content: "original input", timestamp: Date.now() },
    message("original input", "20000000-0000-0000-0000-000000000002"),
    { ...message(), role: "assistant" },
  ]) {
    const event = { type: "message_start", message: raw };
    assert.equal(withLiveImMessageSource(event, manager), event);
  }
  release();
  const later = { type: "message_start", message: message() };
  assert.equal(withLiveImMessageSource(later, manager), later);
  assert.equal(manager.getEntries().length, 0);
});

test("two channels and managers keep independent source registrations and disposal", async (t) => {
  const first = await managerFor(t);
  const second = await managerFor(t);
  const weixin = { ...source, channel: "weixin", botId: "weixin-bot", threadId: undefined };
  const removeFirst = registerImMessageSource(first, source);
  const removeSecond = registerImMessageSource(second, weixin);
  const event = { type: "message_start", message: message() };
  assert.equal(withLiveImMessageSource(event, first).message.imSource.botId, "bot-one");
  assert.equal(withLiveImMessageSource(event, second).message.imSource.botId, "weixin-bot");
  removeFirst();
  assert.equal(withLiveImMessageSource(event, first), event);
  assert.equal(withLiveImMessageSource(event, second).message.imSource.channel, "weixin");
  removeSecond();
});

test("request projection preserves other transforms and tracks the latest input through custom continuations and disposal", async (t) => {
  const manager = await managerFor(t);
  const head = { role: "system", content: "existing extension instructions", timestamp: Date.now() };
  const messages = [head, message()];
  const agent = { transformContext: async (input) => input.map((item) => item.role === "user" ? { ...item, content: "extension-trimmed user" } : item) };
  installImRequestContextProjection({ agent, sessionManager: manager });
  const project = (input = messages) => agent.transformContext(input);
  const parse = (result) => JSON.parse(/<im_request_context>\s*([\s\S]*?)\s*<\/im_request_context>/.exec(result[0].content)[1]);
  const release = registerImMessageSource(manager, { ...source, isGroup: true });
  t.after(release);
  const result = await project();
  assert.ok(result[0].content.startsWith(head.content));
  assert.deepEqual(parse(result), { channel: "telegram", conversation: "topic", replyCapabilities: { text: true, attachments: false } });
  assert.equal(result[1].content, "extension-trimmed user", "the existing context extension keeps control of the user projection");
  assert.ok(!result[0].content.includes(source.chatId));
  assert.ok(!result[0].content.includes(source.botName));
  assert.equal(head.content, "existing extension instructions", "the canonical prompt is never mutated");
  const continuation = { role: "custom", customType: "subagent-notification", content: "child finished", timestamp: Date.now() };
  assert.deepEqual(parse(await project([...messages, continuation])), parse(result));
  release();
  assert.equal((await project())[0], head);
  assert.equal((await project([...messages, continuation]))[0], head);
  const releaseGroup = registerImMessageSource(manager, { ...source, threadId: undefined, isGroup: true }, { attachments: true });
  t.after(releaseGroup);
  assert.deepEqual(parse(await project()), { channel: "telegram", conversation: "group", replyCapabilities: { text: true, attachments: true } });
  assert.equal((await project([...messages, { role: "user", content: "new Web task" }, continuation]))[0], head,
    "a later Web input prevents an older request from claiming custom continuations");
});

test("persisted source validation projects only documented routing fields and hides only its matching prefix", () => {
  const data = { version: 1, messageEntryId: "entry", source: { ...source, token: "must-not-leave-file" } };
  assert.deepEqual(readImMessageSource(data).source, source);
  for (const invalid of [null, [], {}, { ...data, version: 2 }, { ...data, source: { ...source, channel: "unknown" } },
    { ...data, source: { ...source, requestId: undefined } }, { ...data, source: { ...source, threadId: 7 } },
    { ...data, source: { ...source, isGroup: "false" } }]) {
    assert.equal(readImMessageSource(invalid), undefined);
  }
  assert.equal(readImMessageSource({ ...data, source: { ...source, isGroup: false } }).source.isGroup, false);
  assert.equal(withImMessageSource({ role: "user", content: "untouched Web text" }, source).content, "untouched Web text");
  const assistant = { role: "assistant", content: "answer" };
  assert.equal(withImMessageSource(assistant, source), assistant);
});
