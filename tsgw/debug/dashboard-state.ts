import type { DebugSessionDetail, DebugSessionSummary, DebugSnapshotResponse } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { projectNameOf } from "@/lib/session-tree";
import { sessionRowTitle } from "@/components/SessionTree";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { groupDebugSessions, type DebugServerReading, type DebugSessionGroup, type DebugSessionRow } from "@/components/debug-panel-state";

export type TaskFilter = "all" | "held" | "running" | "awaiting" | "subagents" | "catalog";
export type TaskSort = "recent" | "name";

/**
 * Runtime totals for the board's summary strip. `held`/`running`/`awaiting`/`subagents`/`catalog`/
 * `total` keep their published meaning; the role fields split the runtime snapshot further so
 * non-subagent sessions (including side chats) and subagents are counted apart. A fork is a top-level session, never a
 * delegation. A context parent is not resident, so it is in none of the activity counts.
 */
export interface DashboardCounts {
  /** Wrapper summaries: the sessions the server holds right now. */
  held: number;
  /** Held sessions executing (running, not awaiting input), both roles. */
  running: number;
  /** Held sessions waiting for the user, both roles. */
  awaiting: number;
  /** Held sessions with the summary flag, excluding catalog-confirmed side chats. */
  subagents: number;
  /** Catalog entries with no wrapper summary: saved history, runtime state unknown. */
  catalog: number;
  /** The union of held and catalog ids. */
  total: number;
  /** Held non-subagent sessions; forks and side chats included. */
  ordinary: number;
  /** Held ordinary sessions executing. */
  ordinaryRunning: number;
  /** Held subagents by role (summary flag or catalog subagent relation): `ordinary + this === held`. */
  subagentResident: number;
  /** Held subagents executing. */
  subagentRunning: number;
  /**
   * Non-resident parents kept only as context because a resident subagent needs its family root.
   * They are placeholders: not held, not running, and they hide no resident subagent.
   */
  contextParents: number;
}
export interface DashboardIssue {
  id: string;
  tone: "error" | "warning";
  kind: "listeners" | "extensions" | "provider" | "mcp" | "mcpConfig" | "dropped" | "slowPoll";
  name: string;
  count?: number;
}

/** Only what the returned detail actually proves; no fabricated browser state or task verdict. */
export function dashboardIssues(detail: DebugSessionDetail | null): DashboardIssue[] {
  if (!detail) return [];
  const issues: DashboardIssue[] = [];
  const wrapper = detail.wrapper;
  if (wrapper && !wrapper.stale) {
    if (detail.eventStreams.every(stream => stream.connectedAt !== null) && wrapper.eventListeners !== detail.eventStreams.length) {
      issues.push({ id: "listeners", kind: "listeners", tone: "warning", name: "", count: wrapper.eventListeners });
    }
    if (wrapper.extensions === "failed") issues.push({ id: "extensions", kind: "extensions", tone: "error", name: "" });
  }
  for (const provider of detail.providers ?? []) {
    if (provider.active === "error") issues.push({ id: `provider:${provider.name}`, kind: "provider", tone: "error", name: provider.name });
  }
  if (detail.mcp && detail.mcp.problems > 0) issues.push({ id: "mcp-config", kind: "mcpConfig", tone: "warning", name: "", count: detail.mcp.problems });
  for (const server of detail.mcp?.servers ?? []) {
    if (server.hasError || server.state === "failed" || server.state === "conflict") issues.push({ id: `mcp:${server.scope}:${server.name}`, kind: "mcp", tone: "error", name: server.name });
  }
  detail.eventStreams.forEach((stream, index) => {
    if (stream.droppedEvents > 0) issues.push({ id: `dropped:${index}`, kind: "dropped", tone: "warning", name: stream.holder ?? "—", count: stream.droppedEvents });
    // Queued bytes are an observation, not proof that the browser is stalled.
  });
  return issues;
}

/** Keep runtime families intact. Catalog-only rows are explicitly separate, not synthetic summaries. */
export function dashboardGroups(reply: DebugSnapshotResponse | null, catalog: readonly SessionInfo[]): DebugSessionGroup[] {
  const byId = new Map(catalog.map(info => [info.id, info]));
  // The host groups only delegated subagents. Side chats remain independent roots in their
  // project, with their source shown by the board; a copied chat is not a delegated task.
  const groups = reply ? groupDebugSessions(reply.sessions, byId, null) : [];
  const listed = new Set(groups.flatMap(group => group.rows.map(row => row.id)));
  const catalogGroups = new Map<string, DebugSessionGroup>();
  for (const info of catalog) {
    if (listed.has(info.id)) continue;
    const key = `catalog:${workspaceKeyOf(info)}`;
    let group = catalogGroups.get(key);
    if (!group) {
      group = { key, name: projectNameOf(info.projectRoot ?? info.cwd), rows: [] };
      catalogGroups.set(key, group);
    }
    group.rows.push({ id: info.id, info, summary: null, depth: 0, placeholder: false, current: false });
  }
  return [...groups, ...catalogGroups.values()];
}

export function filterDashboardGroups(groups: readonly DebugSessionGroup[], filter: TaskFilter, query: string, project: string, sort: TaskSort): DebugSessionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (row: DebugSessionRow, projectName: string | null) => {
    const summary = row.summary;
    const child = dashboardRole(summary, row.info) === "subagent";
    if (filter === "held" && !summary) return false;
    if (filter === "running" && (!summary?.running || summary.awaitingInput)) return false;
    if (filter === "awaiting" && !summary?.awaitingInput) return false;
    if (filter === "subagents" && (!summary || !child)) return false;
    if (filter === "catalog" && summary) return false;
    if (!needle) return true;
    return [row.id, row.info?.name, row.info?.cwd, row.info?.projectRoot, projectName, row.info?.firstMessage, row.info?.relation?.kind === "subagent" ? row.info.relation.description : undefined].some(value => value?.toLocaleLowerCase().includes(needle));
  };
  return groups.filter(group => !project || group.key.replace(/^catalog:/, "") === project).map(group => {
    const families: DebugSessionRow[][] = [];
    for (const row of group.rows) {
      if (row.depth === 0 || families.length === 0) families.push([]);
      families[families.length - 1].push(row);
    }
    const selected = families.map(family => {
      const matching = family.filter(row => matches(row, group.name));
      if (matching.length === 0) return [];
      if (filter === "catalog") return matching.map(row => ({ ...row, depth: 0 as const, placeholder: false }));
      // Keep a runtime parent as context; never sort a matching child away from its family.
      return family[0].depth === 0 && !matching.includes(family[0]) ? [family[0], ...matching] : matching;
    }).filter(family => family.length > 0);
    if (sort === "name") selected.sort((a, b) => (a[0].info ? sessionRowTitle(a[0].info) : a[0].id).localeCompare(b[0].info ? sessionRowTitle(b[0].info) : b[0].id));
    return { ...group, rows: selected.flat() };
  }).filter(group => group.rows.length > 0);
}

const executing = (summary: DebugSessionSummary): boolean => summary.running && !summary.awaitingInput;

export type DashboardRole = "ordinary" | "subagent" | "side" | "unknown";

/** The upstream flag means suppressed completion notifications, shared by side chats and subagents.
 * Only the existing catalog relation distinguishes a side chat; never infer one from its name.
 */
export function dashboardRole(summary: { subagent: boolean } | null | undefined, info?: SessionInfo | null): DashboardRole {
  if (info?.relation?.kind === "side") return "side";
  if (summary?.subagent || info?.relation?.kind === "subagent") return "subagent";
  return summary || info ? "ordinary" : "unknown";
}

export const DASHBOARD_ROLE_KEYS = {
  ordinary: "dense.main", subagent: "dense.child", side: "dense.side", unknown: "board.unknown",
} as const;

/** `groups` let a caller that already has this snapshot's families skip grouping them again. */
export function dashboardCounts(
  reply: DebugSnapshotResponse | null,
  catalog: readonly SessionInfo[],
  groups: readonly DebugSessionGroup[] = dashboardGroups(reply, catalog),
): DashboardCounts {
  const summaries = reply?.sessions ?? [];
  const byId = new Map(catalog.map(info => [info.id, info]));
  const held = new Set(summaries.map(summary => summary.sessionId));
  let ordinary = 0;
  let ordinaryRunning = 0;
  let subagentResident = 0;
  let subagentRunning = 0;
  for (const summary of summaries) {
    if (dashboardRole(summary, byId.get(summary.sessionId)) === "subagent") {
      subagentResident += 1;
      if (executing(summary)) subagentRunning += 1;
    } else {
      ordinary += 1;
      if (executing(summary)) ordinaryRunning += 1;
    }
  }
  // A placeholder is exactly a family root the server holds no summary for; it exists because a
  // resident subagent pointed at it. Catalog-only groups and unlisted rows are never placeholders.
  const contextParents = groups.reduce((count, group) => count + group.rows.filter(row => row.placeholder).length, 0);
  return {
    held: summaries.length,
    running: summaries.filter(executing).length,
    awaiting: summaries.filter(summary => summary.awaitingInput).length,
    subagents: summaries.filter(summary => summary.subagent && byId.get(summary.sessionId)?.relation?.kind !== "side").length,
    catalog: catalog.filter(info => !held.has(info.id)).length,
    total: new Set([...catalog.map(info => info.id), ...held]).size,
    ordinary,
    ordinaryRunning,
    subagentResident,
    subagentRunning,
    contextParents,
  };
}

export function dashboardFreshness(server: DebugServerReading, now: number, hidden: boolean): "waiting" | "stale" | "hidden" | "current" {
  if (server.failure) return "stale";
  if (hidden) return "hidden";
  if (!server.reply || server.receivedAt === null) return "waiting";
  return now - server.receivedAt > 6000 ? "stale" : "current";
}
