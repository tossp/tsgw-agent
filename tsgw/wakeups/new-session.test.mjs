import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWakeupSession } = await jiti.import("./new-session.ts");
const { listAllSessions, resolveSessionPath } = await jiti.import("../../lib/session-reader.ts");
const { getAdditionalAllowedRoots } = await jiti.import("../../lib/allowed-roots.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "wakeup-new-session-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const roots = new Set(getAdditionalAllowedRoots());
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // These public constructors are forbidden on the lightweight creation path.
  t.mock.method(ModelRuntime, "create", () => assert.fail("new session must not load models"));
  t.mock.method(SettingsManager, "create", () => assert.fail("new session must not load settings/extensions"));
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    const allowed = getAdditionalAllowedRoots();
    allowed.clear();
    for (const root of roots) allowed.add(root);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, agentDir, cwd };
}

test("real SDK header/name persist with 0600 and reopen appends without rewriting or losing entries", async (t) => {
  const f = await fixture(t);
  const result = createWakeupSession(f.cwd, "  Wakeup target  ", join(f.dir, "sessions"));
  assert.equal(result.cwd, f.cwd);
  const before = await readFile(result.file, "utf8");
  const [header, info] = before.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(header.id, result.sessionId);
  assert.equal(header.cwd, f.cwd);
  assert.equal(header.parentSession, undefined);
  assert.equal(info.type, "session_info");
  assert.equal(info.name, "Wakeup target");
  assert.equal(info.parentId, null);
  assert.equal(before.trimEnd().split("\n").length, 2);
  if (process.platform !== "win32") assert.equal((await stat(result.file)).mode & 0o777, 0o600);
  const reopened = SessionManager.open(result.file);
  assert.equal(reopened.getSessionId(), result.sessionId);
  assert.equal(reopened.getSessionName(), "Wakeup target");
  const added = reopened.appendCustomEntry("test:append", { realSdk: true });
  const after = await readFile(result.file, "utf8");
  assert.ok(after.startsWith(before), "reopen must preserve the original header/name bytes");
  assert.equal(SessionManager.open(result.file).getEntry(added).data.realSdk, true);
  const listed = (await SessionManager.list(f.cwd, dirname(result.file))).find((item) => item.id === result.sessionId);
  assert.equal(listed.name, "Wakeup target");
  assert.equal(listed.messageCount, 0);
});

test("default SDK directory is immediately found by the real Web list/path and file-root helpers", async (t) => {
  const f = await fixture(t);
  const old = await listAllSessions({ force: true });
  const result = createWakeupSession(f.cwd, "Visible before any run");
  assert.ok(result.file.startsWith(join(f.agentDir, "sessions")));
  assert.ok(getAdditionalAllowedRoots().has(f.cwd));
  assert.equal(await resolveSessionPath(result.sessionId), result.file);
  assert.equal(old.some((item) => item.id === result.sessionId), false);
  const row = (await listAllSessions()).find((item) => item.id === result.sessionId);
  assert.ok(row, "a warm list cache must discover the new ordinary session");
  assert.equal(row.name, "Visible before any run");
  assert.equal(row.cwd, f.cwd);
  assert.equal(row.parentSessionPath, undefined);
});

test("untitled targets contain only a header; project symlinks use the physical absolute cwd", async (t) => {
  const f = await fixture(t);
  const link = join(f.dir, "project-link");
  await symlink(f.cwd, link, process.platform === "win32" ? "junction" : "dir");
  const result = createWakeupSession(link, undefined, join(f.dir, "sessions"));
  assert.equal(result.cwd, resolve(f.cwd));
  const entries = (await readFile(result.file, "utf8")).trimEnd().split("\n");
  assert.equal(entries.length, 1);
  const manager = SessionManager.open(result.file);
  assert.equal(manager.getSessionName(), undefined);
  assert.deepEqual(manager.getEntries(), []);
  assert.equal(manager.getHeader().parentSession, undefined);
});

test("invalid directories and arguments fail before allocating a target or creating a project", async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, "plain-file");
  await writeFile(file, "not a project");
  const missing = join(f.dir, "missing");
  for (const cwd of ["", ".", "relative/project", missing, file]) {
    assert.throws(() => createWakeupSession(cwd, undefined, join(f.dir, "sessions")));
  }
  assert.throws(() => createWakeupSession(f.cwd, undefined, "relative/sessions"));
  assert.throws(() => createWakeupSession(f.cwd, 12, join(f.dir, "sessions")));
  assert.deepEqual(await readdir(f.agentDir), []);
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await assert.rejects(stat(join(f.dir, "sessions")), { code: "ENOENT" });
});

test("exclusive creation refuses an existing file without replacing its bytes", async (t) => {
  const f = await fixture(t);
  const manager = SessionManager.create(f.cwd, join(f.dir, "sessions"));
  const file = manager.getSessionFile();
  await writeFile(file, "existing file must survive\n");
  t.mock.method(SessionManager, "create", () => manager);
  assert.throws(() => createWakeupSession(f.cwd), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), "existing file must survive\n");
});
