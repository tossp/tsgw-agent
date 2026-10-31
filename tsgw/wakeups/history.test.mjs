import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { WAKEUP_META_TYPE, WAKEUP_NOTIFICATION_TYPE, wakeupHistory, readWakeupSessionFile } =
  await jiti.import("./history.ts");

const SESSION = "target-session";
const HEADER = { type: "session", version: 3, id: SESSION, cwd: "/project" };
const timer = (overrides = {}) => ({
  wakeupId: "timer-1",
  sourceSessionId: "source-session",
  targetSessionId: SESSION,
  createdAt: "2026-10-30T10:00:00.000Z",
  scheduledAt: "2026-10-30T11:00:00.000Z",
  message: "Check the background task",
  ...overrides,
});
const record = (event = "created", overrides = {}) => ({
  ...timer(), version: 1, event, recordedAt: "2026-10-30T10:00:00.000Z", ...overrides,
});
const meta = (data = record(), overrides = {}) => ({
  type: "custom", customType: WAKEUP_META_TYPE, data, ...overrides,
});

async function fixture(t, lines) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-wakeup-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  if (lines) {
    await writeFile(path, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
  }
  return path;
}

test("exports stable metadata and notification custom types", () => {
  assert.equal(WAKEUP_META_TYPE, "pi-web:wakeup");
  assert.equal(WAKEUP_NOTIFICATION_TYPE, "pi-web:wakeup-notification");
});

test("valid v1 metadata aggregates without mutating inputs; memory-only timers do not invent history", () => {
  const data = Object.freeze(record());
  const entries = Object.freeze([Object.freeze(meta(data))]);
  const active = Object.freeze([Object.freeze(timer()), Object.freeze(timer({ wakeupId: "not-recorded" }))]);
  const result = wakeupHistory(entries, active, SESSION);
  assert.deepEqual(result, [{ ...timer(), status: "created", active: true, events: [data] }]);
  assert.deepEqual(wakeupHistory([], active, SESSION), []);
});

test("invalid/unknown-version metadata is skipped without losing valid surrounding events", () => {
  const bad = [null, undefined, [], "text", 1, {}, record("created", { version: 2 }),
    record("created", { version: "1" }), record("delivered"), record("unknown"),
    record("created", { error: 4 })];
  for (const field of ["wakeupId", "sourceSessionId", "targetSessionId", "createdAt", "scheduledAt", "recordedAt", "message"]) {
    const missing = record();
    delete missing[field];
    bad.push(missing, record("created", { [field]: 42 }));
  }
  for (const field of ["wakeupId", "sourceSessionId", "targetSessionId"]) {
    bad.push(record("created", { [field]: "  " }));
  }
  for (const field of ["createdAt", "scheduledAt", "recordedAt"]) {
    bad.push(record("created", { [field]: "not-a-date" }));
  }
  const created = record();
  const submitted = record("submitted");
  assert.deepEqual(wakeupHistory([meta(created), ...bad.map((data) => ({ ...meta(), data })), meta(submitted)], [], SESSION), [
    { ...timer(), status: "submitted", active: false, events: [created, submitted] },
  ]);
});

test("unrelated custom types and notifications never inspect or validate their data", () => {
  const unreadable = { get data() { throw new Error("unrelated data inspected"); } };
  const entries = [
    { type: "custom", customType: "pi-web:subagent" },
    { type: "custom", customType: WAKEUP_NOTIFICATION_TYPE },
    { type: "message", customType: WAKEUP_META_TYPE },
  ];
  for (const entry of entries) Object.defineProperty(entry, "data", Object.getOwnPropertyDescriptor(unreadable, "data"));
  assert.deepEqual(wakeupHistory(entries, [], SESSION), []);
  let reads = 0;
  const matching = { type: "custom", customType: WAKEUP_META_TYPE, get data() { reads++; return record(); } };
  assert.equal(wakeupHistory([matching], [], SESSION).length, 1);
  assert.equal(reads, 1);
});

test("all branches participate and file order, not recordedAt or leaf, decides the last event", () => {
  const created = record();
  const cancelled = record("cancelled", { recordedAt: "2026-10-30T09:00:00.000Z" });
  const other = record("created", { wakeupId: "timer-2" });
  const entries = [
    meta(created, { id: "a", parentId: null }),
    meta(cancelled, { id: "b", parentId: "a" }),
    meta(other, { id: "c", parentId: "a" }),
    { type: "message", id: "selected-leaf", parentId: "c" },
  ];
  const result = wakeupHistory(entries, [timer({ wakeupId: "timer-2" })], SESSION);
  assert.deepEqual(result.map(({ wakeupId, status, active }) => ({ wakeupId, status, active })), [
    { wakeupId: "timer-1", status: "cancelled", active: false },
    { wakeupId: "timer-2", status: "created", active: true },
  ]);
  assert.deepEqual(result[0].events, [created, cancelled]);
});

for (const event of ["cancelled", "submitted", "failed"]) {
  test(`${event} is terminal even if a stale active snapshot contains the ID`, () => {
    const final = record(event, { error: event === "failed" ? "SDK rejected the submission" : undefined });
    const [item] = wakeupHistory([meta(), meta(final)], [timer()], SESSION);
    assert.equal(item.status, event);
    assert.equal(item.active, false);
    assert.equal(item.events.length, 2);
    assert.equal(item.events[1].error, final.error);
  });
}

test("restart leaves created history inactive, never cancelled, submitted or failed", () => {
  const [item] = wakeupHistory([meta()], [], SESSION);
  assert.equal(item.status, "inactive");
  assert.equal(item.active, false);
  assert.equal(item.events[0].event, "created");
});

test("fork-inherited history is visible but inactive while the original timer is active", () => {
  const entries = [meta()];
  const armed = [timer()];
  assert.equal(wakeupHistory(entries, armed, SESSION)[0].active, true);
  const [inherited] = wakeupHistory(entries, armed, "fork-session");
  assert.equal(inherited.status, "inactive");
  assert.equal(inherited.active, false);
  assert.equal(inherited.targetSessionId, SESSION);
  assert.equal(inherited.events.length, 1);
});

test("active matching requires both wakeupId and targetSessionId", () => {
  const entries = [meta()];
  for (const active of [[timer({ targetSessionId: "other-session" })], [timer({ wakeupId: "other-id" })]]) {
    assert.equal(wakeupHistory(entries, active, SESSION)[0].active, false);
  }
  assert.equal(wakeupHistory(entries, [timer({ targetSessionId: "other-session" }), timer()], SESSION)[0].active, true);
});

test("reader returns every top-level custom entry, not messages or nested custom objects; source bytes/mtime stay unchanged", async (t) => {
  const path = await fixture(t, [HEADER,
    { type: "message", message: { role: "user", content: "hello", nested: meta() } },
    meta(),
    { type: "custom", customType: "pi-web:subagent", data: { parentSessionId: "parent" } },
    { type: "custom", customType: "extension:other", data: [1, 2] },
    { type: "custom", customType: WAKEUP_NOTIFICATION_TYPE, data: { content: "notification" } },
    { type: "custom_message", customType: WAKEUP_NOTIFICATION_TYPE, content: "not metadata" },
  ]);
  const before = await readFile(path);
  const beforeStat = await stat(path, { bigint: true });
  const result = await readWakeupSessionFile(path);
  assert.deepEqual(result.header, { id: SESSION, cwd: "/project" });
  assert.deepEqual(result.entries, [meta(),
    { type: "custom", customType: "pi-web:subagent", data: { parentSessionId: "parent" } },
    { type: "custom", customType: "extension:other", data: [1, 2] },
    { type: "custom", customType: WAKEUP_NOTIFICATION_TYPE, data: { content: "notification" } },
  ]);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
});

test("reader keeps old session versions read-only, including metadata on every branch", async (t) => {
  const path = await fixture(t, [
    { ...HEADER, version: 1 },
    meta(record(), { id: "old-branch", parentId: null }),
    meta(record("cancelled"), { id: "cancel-branch", parentId: "old-branch" }),
    meta(record("created", { wakeupId: "other-branch" }), { id: "new-leaf", parentId: "old-branch" }),
  ]);
  const before = await readFile(path);
  const beforeStat = await stat(path, { bigint: true });
  const { header, entries } = await readWakeupSessionFile(path);
  assert.equal(header.id, SESSION);
  assert.equal(entries.length, 3);
  assert.deepEqual(wakeupHistory(entries, [], SESSION).map((item) => item.status), ["cancelled", "inactive"]);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
  assert.equal(JSON.parse((await readFile(path, "utf8")).split("\n")[0]).version, 1);
});

test("custom candidate filtering accepts whitespace, key reordering, escaped keys and CRLF", async (t) => {
  const path = await fixture(t, [HEADER,
    ` \t{ "type" \t: \t"custom", "customType": "first", "data": 1 }\r`,
    '{ "data": {"type":"message", "text":"escaped \\\" quote"}, "customType": "second", "type" : "custom" }',
    '{ "ty\\u0070e" : "cu\\u0073tom", "customType": "third" }',
    '{"data":[{"type":"custom"}],"type":"message"}',
    '{"type":"custom","customType":"fourth","data":null}',
  ]);
  const { entries } = await readWakeupSessionFile(path);
  assert.deepEqual(entries.map((entry) => entry.customType), ["first", "second", "third", "fourth"]);
  assert.equal(entries[3].data, null);
});

test("huge irrelevant image messages are not JSON-parsed or retained", async (t) => {
  const image = "A".repeat(8 * 1024 * 1024);
  const path = await fixture(t, [HEADER,
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "image", data: image }] } }),
    // Nested custom-looking data is still just a normal SDK message.
    JSON.stringify({ type: "message", message: { data: image, nested: { type: "custom" } } }),
    meta(),
  ]);
  const parse = JSON.parse;
  let largeParses = 0;
  JSON.parse = function (value, ...args) {
    if (typeof value === "string" && value.length > 1024 * 1024) largeParses++;
    return parse(value, ...args);
  };
  try {
    const result = await readWakeupSessionFile(path);
    assert.deepEqual(result.entries, [meta()]);
    assert.equal(largeParses, 0);
    assert.ok(JSON.stringify(result).length < 1024);
  } finally {
    JSON.parse = parse;
  }
});

test("reader preserves raw Unicode line separators inside JSON strings", async (t) => {
  const message = "before\u2028middle\u2029after";
  const path = await fixture(t, [HEADER, meta(record("created", { message }))]);
  const { entries } = await readWakeupSessionFile(path);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.message, message);
});

test("malformed non-header lines do not discard valid metadata before or after them", async (t) => {
  const path = await fixture(t, [HEADER, meta(), '{"type":"custom", broken', "", "not json",
    meta(record("submitted")), '{"type":"custom","data":']);
  const { entries } = await readWakeupSessionFile(path);
  assert.equal(entries.length, 2);
  assert.equal(wakeupHistory(entries, [], SESSION)[0].status, "submitted");
});

test("missing file throws ENOENT and is never created", async (t) => {
  const path = await fixture(t);
  await assert.rejects(readWakeupSessionFile(path), { code: "ENOENT" });
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("empty or invalid first-line headers fail clearly rather than searching later lines", async (t) => {
  const invalid = ["", "not json", "null", "[]", "{}", JSON.stringify(meta()),
    JSON.stringify({ ...HEADER, id: " " }), JSON.stringify({ ...HEADER, cwd: 1 }),
    JSON.stringify({ ...HEADER, cwd: "" }), JSON.stringify({ ...HEADER, id: 1 })];
  for (const first of invalid) {
    const path = await fixture(t, [first, HEADER, meta()]);
    await assert.rejects(readWakeupSessionFile(path), /Invalid session header.*first line/);
  }
  const empty = await fixture(t, []);
  await writeFile(empty, "");
  await assert.rejects(readWakeupSessionFile(empty), /Invalid session header/);
});
