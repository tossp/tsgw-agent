import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { listAllSessions, mergeSessionLists } from "../../lib/session-reader";
import type { SessionInfo } from "../../lib/types";

export function sessionDirectoryKey(cwd: string): string {
  let path = resolve(cwd);
  try { path = realpathSync(path); } catch { /* Deleted projects can retain readable sessions. */ }
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function isOrdinarySession(session: SessionInfo): boolean {
  return !session.detailsPending && session.relation?.kind !== "subagent" && session.relation?.kind !== "side";
}

export function projectSessions(sessions: SessionInfo[], cwd: string): SessionInfo[] {
  const key = sessionDirectoryKey(cwd);
  return sessions.filter(session => isOrdinarySession(session) && sessionDirectoryKey(session.cwd) === key);
}

/** Share the host's catalogue; never start another session manager or registry. */
export async function listSessionCatalog(): Promise<SessionInfo[]> {
  const { getRpcSessionInfos } = await import("../../lib/rpc-manager");
  return mergeSessionLists(await listAllSessions(), getRpcSessionInfos({ includeTransient: true }));
}
