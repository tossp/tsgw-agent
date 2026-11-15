import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { WakeupStore } = await createJiti(import.meta.url).import("./store.ts");
const { writePrivateFileAtomicSync } = await createJiti(import.meta.url).import("../../lib/atomic-file.ts");

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "wakeup-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, "integrations", "wakeups", "state.json");
  return { root, file, store: new WakeupStore(file) };
}

function task(overrides = {}) {
  return {
    wakeupId: "wakeup-1", sourceSessionId: "source", targetSessionId: "target",
    createdAt: "2026-11-16T00:00:00.000Z", scheduledAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z", message: "交接正文\nsecond line",
    status: "pending", ...overrides,
  };
}

function writeRaw(file, value) {
  fs.mkdirSync(join(file, ".."), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("missing state is empty and read never creates directories", (t) => {
  const { root, store } = fixture(t);
  assert.deepEqual(store.read(), []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("real roundtrip retains every persisted field and reads disk afresh", (t) => {
  const { file, store } = fixture(t);
  const tasks = [task(), task({
    wakeupId: "wakeup-2", cwd: "/temporary/project", status: "run_aborted",
    dispatchingAt: "2026-11-17T00:00:00.000Z", submittedAt: "2026-11-17T00:00:01.000Z",
    receivedAt: "2026-11-17T00:00:02.000Z", settledAt: "2026-11-17T00:00:03.000Z",
    cancelledAt: "2026-11-17T00:00:04.000Z", recoveredAt: "2026-11-17T00:00:05.000Z",
    runId: "run-1", notificationEntryId: "entry-1", branchLeafId: "leaf-1",
    responseEntryIds: ["response-1", "response-2"], aborted: true, error: "stopped",
  })];
  store.save(tasks);
  const before = fs.statSync(file);
  assert.deepEqual(new WakeupStore(file).read(), tasks);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  const read = store.read();
  read[0].message = "mutated";
  read.push(task({ wakeupId: "extra" }));
  assert.deepEqual(store.read(), tasks);
  writeRaw(file, { version: 1, tasks: [] });
  assert.deepEqual(store.read(), []);
  fs.unlinkSync(file);
  assert.deepEqual(store.read(), []);
});

test("save omits unsaved observations without mutating its input", (t) => {
  const { file, store } = fixture(t);
  const input = Object.freeze([Object.freeze(task({ unsaved: true }))]);
  store.save(input);
  assert.equal(input[0].unsaved, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, tasks: [task()] });
  assert.deepEqual(store.read(), [task()]);
});

test("corrupt, unknown-version and invalid task files throw and preserve bytes/mtime", (t) => {
  const { file, store } = fixture(t);
  const invalid = [
    "{broken", null, [], {}, { version: 2, tasks: [] }, { version: "1", tasks: [] },
    { version: 1, tasks: {} }, { version: 1, tasks: [], extra: true },
    ...[
      null, [], {}, task({ wakeupId: "" }), task({ sourceSessionId: 3 }),
      task({ targetSessionId: null }), task({ message: [] }), task({ status: "done" }),
      task({ createdAt: "never" }), task({ scheduledAt: null }), task({ updatedAt: "" }),
      task({ cwd: 5 }), task({ receivedAt: "invalid" }), task({ aborted: "yes" }),
      task({ responseEntryIds: "entry" }), task({ responseEntryIds: [3] }),
      task({ responseEntryIds: [""] }), task({ unsaved: true }), task({ unexpected: true }),
    ].map((value) => ({ version: 1, tasks: [value] })),
    { version: 1, tasks: [task(), task()] },
  ];
  for (const value of invalid) {
    const contents = typeof value === "string" ? value : JSON.stringify(value);
    writeRaw(file, contents);
    const before = fs.statSync(file);
    assert.throws(() => store.read());
    assert.equal(fs.readFileSync(file, "utf8"), contents);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  }
});

test("read errors other than missing files propagate", (t) => {
  const { root } = fixture(t);
  assert.throws(() => new WakeupStore(root).read(), { code: "EISDIR" });
});

test("injected storage failure propagates and leaves the original readable", (t) => {
  const { file, store } = fixture(t);
  store.save([task()]);
  const before = fs.readFileSync(file, "utf8");
  const error = Object.assign(new Error("storage full"), { code: "ENOSPC" });
  const injected = new WakeupStore(file, { write: () => { throw error; } });
  assert.throws(() => injected.save([task({ message: "replacement" })]), error);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(store.read(), [task()]);
});

test("injected atomic-write failure preserves the original and cleans the temporary file", (t) => {
  const { file, store } = fixture(t);
  store.save([task()]);
  const before = fs.readFileSync(file, "utf8");
  const blocked = join(file, "..", "blocked");
  fs.mkdirSync(blocked);
  const injected = new WakeupStore(file, { write: (destination, contents) => {
    assert.equal(destination, file);
    // A directory cannot be replaced by a file: fail the helper's actual rename,
    // independently of how the TypeScript loader captures node:fs imports.
    writePrivateFileAtomicSync(blocked, contents);
  } });
  assert.throws(() => injected.save([task({ message: "replacement" })]),
    (error) => ["EISDIR", "EPERM", "EEXIST"].includes(error.code));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(join(file, "..")), ["blocked", "state.json"]);
  assert.deepEqual(store.read(), [task()]);
});

test("creates private directories and replaces even a permissive state file with mode 0600", (t) => {
  const { root, file, store } = fixture(t);
  store.save([task()]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(join(root, "integrations")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(root, "integrations", "wakeups")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  fs.chmodSync(file, 0o644);
  store.save([]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(join(file, "..")), ["state.json"]);
});
