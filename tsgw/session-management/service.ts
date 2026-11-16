import { existsSync, readFileSync } from "node:fs";
import {
  migrateSessionEntries, parseSessionEntries, type SessionEntry as PiSessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext, invalidateSessionListCache, invalidateSessionManagerCache,
  openSessionManager, resolveSessionPath,
} from "../../lib/session-reader";
import { listSessionFamilies, getSessionFamily } from "../../lib/session-family";
import { isFamilyArchived } from "../../lib/session-tree";
import { readSessionUiState, updateSessionUiState } from "../../lib/session-ui-state";
import { searchSessionContents } from "../../lib/session-search";
import type { AgentMessage, SessionEntry } from "../../lib/types";
import { isOrdinarySession, listSessionCatalog, projectSessions } from "./catalog";

export interface SessionListInput { cwd?: string; query?: string; archived?: boolean }

export async function listManagedSessions(input: SessionListInput = {}, signal?: AbortSignal) {
  const rpc = await import("../../lib/rpc-manager");
  const catalog = await listSessionCatalog();
  const state = readSessionUiState();
  const running = new Set(rpc.getRunningRpcSessionIds());
  const archived = new Map(listSessionFamilies(catalog).map(family => [family.root.id, isFamilyArchived(family, state, running)]));
  let sessions = input.cwd ? projectSessions(catalog, input.cwd) : catalog.filter(isOrdinarySession);
  sessions = sessions.filter(session => input.archived === undefined || archived.get(session.id) === input.archived);
  const search = input.query?.trim() ? await searchSessionContents(sessions, input.query, signal) : null;
  if (search) sessions = search.results.map(hit => hit.session);
  return {
    sessions: sessions.map(session => ({
      sessionId: session.id, title: session.name || session.firstMessage || session.id,
      cwd: session.cwd, modified: session.modified, archived: archived.get(session.id) ?? false,
      running: running.has(session.id), transient: session.transient === true,
      ...(session.relation ? { relation: session.relation } : {}),
      ...(search ? { matchEntryId: search.results.find(hit => hit.session.id === session.id)?.entryId } : {}),
    })),
    truncated: search?.truncated ?? false,
  };
}

/** SDK parsing/migration is in memory: observation must never rewrite an old JSONL. */
async function sessionSnapshot(sessionId: string) {
  const { getRpcSession } = await import("../../lib/rpc-manager");
  const wrapper = getRpcSession(sessionId);
  if (wrapper?.isAlive()) {
    const manager = wrapper.inner.sessionManager;
    return { entries: manager.getEntries(), leafId: manager.getLeafId(), title: manager.getSessionName() ?? "", cwd: manager.getCwd() };
  }
  const path = await resolveSessionPath(sessionId);
  if (!path) throw new Error("Session not found");
  const parsed = parseSessionEntries(readFileSync(path, "utf8"));
  const header = parsed[0];
  if (header?.type !== "session" || header.id !== sessionId) throw new Error("Session header does not match target ID");
  const legacy = (header.version ?? 1) < 2;
  migrateSessionEntries(parsed);
  const entries = parsed.filter((entry): entry is PiSessionEntry => entry.type !== "session");
  if (legacy) stabilizeLegacyIds(entries);
  const title = entries.findLast(entry => entry.type === "session_info")?.name ?? "";
  return { entries, leafId: entries.at(-1)?.id ?? null, title, cwd: header.cwd };
}

export async function readManagedSession(sessionId: string, before?: string) {
  const snapshot = await sessionSnapshot(sessionId);
  if (before && !snapshot.entries.some(entry => entry.id === before)) throw new Error("Pagination entry not found in session");
  const context = buildSessionContext(snapshot.entries as SessionEntry[], before ?? snapshot.leafId, {
    tail: 50, excludeLeaf: Boolean(before), deferThinking: true, deferToolResultImages: true, sessionId,
  });
  return {
    sessionId, title: snapshot.title, cwd: snapshot.cwd, leafId: snapshot.leafId,
    messages: context.messages.map((message, index) => ({
      entryId: context.entryIds[index], role: message.role, text: messageText(message),
      ...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}),
      ...(message.role === "assistant" ? { stopReason: message.stopReason, errorMessage: message.errorMessage } : {}),
    })),
    nextBefore: context.hasMore ? context.oldestEntryId : null,
  };
}

export async function renameManagedSession(sessionId: string, title: string) {
  const name = title.replace(/[\r\n]+/g, " ").trim();
  if (!name) throw new Error("Session title must not be empty");
  const snapshot = await sessionSnapshot(sessionId);
  if (snapshot.title === name) return { sessionId, previousTitle: snapshot.title, title: name, changed: false };
  const path = await resolveSessionPath(sessionId);
  const { renameRpcSession } = await import("../../lib/rpc-manager");
  const renamed = await renameRpcSession(sessionId, name, () => {
    if (!path || !existsSync(path)) return false;
    const manager = openSessionManager(path, { mutable: true });
    if (manager.getSessionId() !== sessionId) throw new Error("Session header does not match target ID");
    manager.appendSessionInfo(name);
    invalidateSessionManagerCache(path);
    invalidateSessionListCache();
    return true;
  });
  if (!renamed) throw new Error("Session not found");
  return { sessionId, previousTitle: snapshot.title, title: name, changed: true };
}

export async function archiveManagedSession(sessionId: string, archived: boolean) {
  const catalog = await listSessionCatalog();
  const family = getSessionFamily(catalog, sessionId);
  if (!family) throw new Error("Session not found in a sidebar family");
  const state = await updateSessionUiState({ action: "set", ids: [family.root.id], archived });
  const { getRunningRpcSessionIds } = await import("../../lib/rpc-manager");
  return {
    sessionId, familySessionId: family.root.id, requestedArchived: archived,
    archived: isFamilyArchived(family, state, new Set(getRunningRpcSessionIds())),
  };
}

// v1 has no entry IDs; SDK migration generates new ones on every read. File-order
// aliases keep read-only pagination stable without persisting a migration or cache.
function stabilizeLegacyIds(entries: PiSessionEntry[]): void {
  const aliases = new Map(entries.map((entry, index) => [entry.id, `v1-${index}`]));
  for (const entry of entries) {
    const parent = entry.parentId;
    entry.id = aliases.get(entry.id)!;
    entry.parentId = parent === null ? null : aliases.get(parent)!;
    if (entry.type === "compaction") entry.firstKeptEntryId = aliases.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId;
  }
}

function messageText(message: AgentMessage): string {
  if (message.role === "bashExecution") return `${message.command}\n${message.output}\nexitCode: ${message.exitCode ?? "unknown"}; cancelled: ${message.cancelled === true}`;
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap(block => {
    if (block.type === "text") return [block.text];
    if (block.type === "toolCall") return [`${block.toolName} ${JSON.stringify(block.input)}`];
    return [];
  }).join("\n");
}
