import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionContext } = await jiti.import("../../lib/session-reader.ts");
const { IM_MESSAGE_SOURCE_TYPE } = await jiti.import("./message-data.ts");
const timestamp = "2026-11-15T00:00:00.000Z";
const requestId = "12345678-1234-1234-1234-123456789abc";

function source(channel, overrides = {}) {
  return {
    requestId, channel, botId: `${channel}-bot`, botName: `${channel} bot`,
    chatId: "chat-1", senderId: "sender-1", messageId: "message-1", ...overrides,
  };
}

function message(id, parentId, content, role = "user") {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

function metadata(id, parentId, messageEntryId, origin) {
  return {
    type: "custom", id, parentId, timestamp, customType: IM_MESSAGE_SOURCE_TYPE,
    data: { version: 1, messageEntryId, source: origin },
  };
}

function marked(text, id = requestId) {
  return `[IM request ${id}]\n${text}`;
}

for (const channel of ["weixin", "telegram"]) {
  test(`${channel} history projects source and removes only its matching marker`, () => {
    const origin = source(channel, channel === "telegram" ? { threadId: "topic-1" } : {});
    const entries = [
      message("u", null, marked("hello")), metadata("meta", "u", "u", origin),
      message("other", "meta", marked("keep", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
      metadata("other-meta", "other", "other", origin),
    ];
    const context = buildSessionContext(entries);
    assert.deepEqual(context.entryIds, ["u", "other"]);
    assert.deepEqual(context.messages[0], { role: "user", content: "hello", imSource: origin });
    assert.equal(context.messages[1].content, entries[2].message.content);
    assert.deepEqual(context.messages[1].imSource, origin);
  });
}

test("tail and excludeLeaf pages find metadata beyond the page and preserve entry alignment", () => {
  const origin = source("telegram");
  const entries = [
    message("old", null, "older web input"), message("im", "old", marked("hello")),
    metadata("meta", "im", "im", origin), message("web", "meta", "latest web input"),
  ];
  const recent = buildSessionContext(entries, "web", { tail: 1 });
  assert.deepEqual(recent.entryIds, ["web"]);
  assert.equal(recent.messages[0].imSource, undefined);
  const older = buildSessionContext(entries, recent.oldestEntryId, { tail: 1, excludeLeaf: true });
  assert.deepEqual(older.entryIds, ["im"]);
  assert.deepEqual(older.messages, [{ role: "user", content: "hello", imSource: origin }]);
  const atInput = buildSessionContext(entries, "im", { tail: 1 });
  assert.deepEqual(atInput.messages, older.messages);
  assert.deepEqual(atInput.entryIds, older.entryIds);
  const first = buildSessionContext(entries, older.oldestEntryId, { tail: 1, excludeLeaf: true });
  assert.deepEqual(first.entryIds, ["old"]);
  assert.equal(first.hasMore, false);
});

test("branches inherit shared input sources without mixing same-text message IDs", () => {
  const shared = source("weixin");
  const branch = source("telegram", { messageId: "branch-message" });
  const entries = [
    message("root", null, marked("same")), metadata("root-meta", "root", "root", shared),
    message("left", "root-meta", marked("same")), metadata("left-meta", "left", "left", branch),
    message("right", "root-meta", marked("same")),
  ];
  const left = buildSessionContext(entries, "left-meta");
  assert.deepEqual(left.entryIds, ["root", "left"]);
  assert.deepEqual(left.messages.map((m) => m.imSource), [shared, branch]);
  const right = buildSessionContext(entries, "right");
  assert.deepEqual(right.entryIds, ["root", "right"]);
  assert.deepEqual(right.messages.map((m) => m.imSource), [shared, undefined]);
  assert.equal(right.messages[1].content, marked("same"));
});

test("invalid or unrelated metadata leaves ordinary Web, assistant and bash messages unchanged", () => {
  const origin = source("telegram");
  const invalidData = [
    null, [], {}, { version: 2, messageEntryId: "web", source: origin },
    { version: 1, messageEntryId: "", source: origin },
    { version: 1, messageEntryId: "web", source: { ...origin, channel: "unknown" } },
    { version: 1, messageEntryId: "web", source: { ...origin, senderId: 7 } },
    { version: 1, messageEntryId: "web", source: { ...origin, threadId: {} } },
  ];
  for (const data of invalidData) {
    const entries = [message("web", null, marked("unchanged")), {
      ...metadata("bad", "web", "web", origin), data,
    }];
    assert.deepEqual(buildSessionContext(entries).messages, [entries[0].message]);
  }
  const entries = [
    message("web", null, "ordinary"), message("assistant", "web", [{ type: "text", text: marked("answer") }], "assistant"),
    metadata("assistant-meta", "assistant", "assistant", origin),
    { type: "message", id: "bash", parentId: "assistant-meta", timestamp,
      message: { role: "bashExecution", command: "pwd", output: "/tmp" } },
    metadata("bash-meta", "bash", "bash", origin),
    { ...metadata("unrelated", "bash-meta", "web", origin), customType: "other-extension" },
  ];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["web", "assistant", "bash"]);
  assert.deepEqual(context.messages, [entries[0].message, entries[1].message, entries[3].message]);
});

test("forked JSONL inherits metadata and projection preserves SDK messages, file bytes and mtime", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-im-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = source("weixin");
  const entries = [
    message("u", null, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "text", text: marked("hello") }, { type: "text", text: marked("keep later block") },
    ]), metadata("meta", "u", "u", origin),
  ];
  const parentFile = join(dir, "parent.jsonl");
  const forkFile = join(dir, "fork.jsonl");
  const header = { type: "session", version: 3, id: "parent", timestamp, cwd: dir };
  const encode = (h, es) => `${[h, ...es].map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(parentFile, encode(header, entries));
  writeFileSync(forkFile, encode({ ...header, id: "fork", parentSession: parentFile }, [
    ...entries, message("fork-web", "meta", "fork continuation"),
  ]));
  for (const file of [parentFile, forkFile]) {
    const before = readFileSync(file);
    const beforeStat = statSync(file, { bigint: true });
    // The observation path parses JSONL directly; it never opens an SDK session.
    const sdkEntries = before.toString().trim().split("\n").slice(1).map((line) => JSON.parse(line));
    const original = structuredClone(sdkEntries);
    const sdkMessage = sdkEntries[0].message;
    const context = buildSessionContext(sdkEntries);
    assert.deepEqual(context.messages[0].imSource, origin);
    assert.notEqual(context.messages[0], sdkMessage);
    assert.notEqual(context.messages[0].content, sdkMessage.content);
    assert.equal(context.messages[0].content[1].text, "hello");
    assert.equal(context.messages[0].content[2].text, marked("keep later block"));
    assert.deepEqual(context.entryIds, file === parentFile ? ["u"] : ["u", "fork-web"]);
    assert.deepEqual(sdkEntries, original);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(statSync(file, { bigint: true }).mtimeNs, beforeStat.mtimeNs);
  }
});
