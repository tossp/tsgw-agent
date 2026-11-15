import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { readWakeupReceipt } = await createJiti(import.meta.url).import("./reconcile.ts");
const customType = "pi-web:wakeup-notification";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "wakeup-receipt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  return { dir, manager, file: manager.getSessionFile(), id: manager.getSessionId() };
}

test("a persisted SDK notification proves receipt without changing bytes/mtime or claiming settlement", async (t) => {
  const f = await fixture(t);
  const entryId = f.manager.appendCustomMessageEntry(customType, "handoff", true, { wakeupId: "w1", targetSessionId: f.id });
  f.manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now(), stopReason: "stop" });
  const before = await readFile(f.file), mtime = (await stat(f.file)).mtimeMs;
  const entry = f.manager.getEntry(entryId);
  const open = t.mock.method(SessionManager, "open", () => assert.fail("receipt reads must never open a manager"));
  assert.deepEqual(await readWakeupReceipt(f.file, "w1", f.id), {
    receivedAt: entry.timestamp, notificationEntryId: entryId, branchLeafId: entryId,
  });
  assert.equal(await readWakeupReceipt(f.file, "other", f.id), null);
  assert.deepEqual(await readFile(f.file), before);
  assert.equal((await stat(f.file)).mtimeMs, mtime);
  assert.equal(open.mock.callCount(), 0);
});

test("header and notification target must both match; fork inheritance is not receipt by the fork", async (t) => {
  const f = await fixture(t);
  f.manager.appendCustomMessageEntry(customType, "source only", true, { wakeupId: "inherited", targetSessionId: f.id });
  const fork = SessionManager.forkFrom(f.file, f.dir, join(f.dir, "fork"));
  assert.equal(await readWakeupReceipt(fork.getSessionFile(), "inherited", fork.getSessionId()), null);
  assert.equal(await readWakeupReceipt(fork.getSessionFile(), "inherited", f.id), null);
  f.manager.appendCustomMessageEntry(customType, "wrong target", true, { wakeupId: "wrong", targetSessionId: fork.getSessionId() });
  f.manager.appendCustomEntry(customType, { wakeupId: "meta", targetSessionId: f.id });
  f.manager.appendCustomMessageEntry("extension-notification", "other", true, { wakeupId: "other", targetSessionId: f.id });
  for (const id of ["wrong", "meta", "other"]) assert.equal(await readWakeupReceipt(f.file, id, f.id), null);
  const own = fork.appendCustomMessageEntry(customType, "fork's own receipt", true, { wakeupId: "own", targetSessionId: fork.getSessionId() });
  assert.equal((await readWakeupReceipt(fork.getSessionFile(), "own", fork.getSessionId())).notificationEntryId, own);
});

test("skip large ordinary messages before JSON decoding; preserve LF, Unicode, CRLF and unusual key order", async (t) => {
  const f = await fixture(t);
  f.manager.appendMessage({ role: "user", content: "x".repeat(2 * 1024 * 1024) + "\u2028\u2029", timestamp: Date.now() });
  const id = f.manager.appendCustomMessageEntry(customType, "unicode \u2028\u2029 handoff", true, { wakeupId: "unicode", targetSessionId: f.id });
  const lines = (await readFile(f.file, "utf8")).trimEnd().split("\n");
  const notification = JSON.parse(lines.pop());
  const { type, ...rest } = notification;
  // A partial append must not obscure a later complete notification.
  lines.push('{"type":"custom_message","details":', JSON.stringify({ ...rest, type }));
  await writeFile(f.file, lines.join("\r\n") + "\r\n");
  const parse = JSON.parse;
  const decoding = t.mock.method(JSON, "parse", (value, ...args) => {
    assert.ok(String(value).length < 100_000, "ordinary image/message payload was decoded");
    return parse(value, ...args);
  });
  try { assert.equal((await readWakeupReceipt(f.file, "unicode", f.id)).notificationEntryId, id); }
  finally { decoding.mock.restore(); }
});

test("invalid headers and incomplete or malformed receipts never invent evidence", async (t) => {
  const f = await fixture(t);
  assert.equal(await readWakeupReceipt(join(f.dir, "missing.jsonl"), "w", f.id), null);
  const corrupt = join(f.dir, "invalid.jsonl");
  for (const text of ["", "{}\n", "not json\n", '{"type":"custom_message","id":"x"}\n']) {
    await writeFile(corrupt, text);
    await assert.rejects(readWakeupReceipt(corrupt, "w", f.id), /header/i);
  }
  const invalid = { type: "custom_message", customType, id: "invalid", timestamp: "bad", details: { wakeupId: "w", targetSessionId: f.id } };
  await appendFile(f.file, JSON.stringify(invalid) + '\n{"type":"custom_message","customType":"pi-web:wakeup-notification"');
  assert.equal(await readWakeupReceipt(f.file, "w", f.id), null);
});
