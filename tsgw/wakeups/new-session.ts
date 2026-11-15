import { accessSync, constants, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { allowFileRoot } from "../../lib/allowed-roots";
import { cacheSessionPath, invalidateSessionListCache } from "../../lib/session-reader";

/** Persist an ordinary empty session without constructing any agent or loading project resources. */
export function createWakeupSession(cwd: string, title?: string, sessionDir?: string): { sessionId: string; file: string; cwd: string } {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("cwd must be an absolute directory path");
  if (sessionDir !== undefined && (typeof sessionDir !== "string" || !isAbsolute(sessionDir))) {
    throw new Error("sessionDir must be an absolute directory path");
  }
  if (title !== undefined && typeof title !== "string") throw new Error("title must be a string");
  const directory = realpathSync(cwd);
  if (!statSync(directory).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  accessSync(directory, constants.R_OK | constants.X_OK);

  const manager = SessionManager.create(directory, sessionDir);
  if (title?.trim()) manager.appendSessionInfo(title.trim());
  const header = manager.getHeader();
  const file = manager.getSessionFile();
  if (!header || !file) throw new Error("SDK did not create a session header and file path");
  const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  // The SDK manager still considers its initial buffer unflushed. Never return
  // or reuse it: the next owner must reopen this newly persisted file.
  const sessionId = manager.getSessionId();
  allowFileRoot(directory);
  cacheSessionPath(sessionId, file);
  invalidateSessionListCache();
  return { sessionId, file, cwd: directory };
}
