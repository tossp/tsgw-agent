import type { DebugSessionDetail, DebugSnapshotResponse } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { projectNameOf } from "@/lib/session-tree";
import { sessionRowTitle } from "@/components/SessionTree";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { groupDebugSessions, type DebugServerReading, type DebugSessionGroup, type DebugSessionRow } from "@/components/debug-panel-state";

export type TaskFilter = "all" | "held" | "running" | "awaiting" | "subagents" | "catalog";
export type TaskSort = "recent" | "name";
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
    const child = summary?.subagent || row.info?.relation?.kind === "subagent";
    if (filter === "held" && !summary) return false;
    if (filter === "running" && (!summary?.running || summary.awaitingInput)) return false;
    if (filter === "awaiting" && !summary?.awaitingInput) return false;
    if (filter === "subagents" && !child) return false;
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
      // Keep a runtime parent as context; never sort a matching child away from its family.
      return family[0].depth === 0 && !matching.includes(family[0]) ? [family[0], ...matching] : matching;
    }).filter(family => family.length > 0);
    if (sort === "name") selected.sort((a, b) => (a[0].info ? sessionRowTitle(a[0].info) : a[0].id).localeCompare(b[0].info ? sessionRowTitle(b[0].info) : b[0].id));
    return { ...group, rows: selected.flat() };
  }).filter(group => group.rows.length > 0);
}

export function dashboardCounts(reply: DebugSnapshotResponse | null, catalog: readonly SessionInfo[]) {
  const summaries = reply?.sessions ?? [];
  const held = new Set(summaries.map(summary => summary.sessionId));
  return {
    held: summaries.length,
    running: summaries.filter(summary => summary.running && !summary.awaitingInput).length,
    awaiting: summaries.filter(summary => summary.awaitingInput).length,
    subagents: summaries.filter(summary => summary.subagent).length,
    catalog: catalog.filter(info => !held.has(info.id)).length,
    total: new Set([...catalog.map(info => info.id), ...held]).size,
  };
}

export function dashboardFreshness(server: DebugServerReading, now: number, hidden: boolean): "waiting" | "stale" | "hidden" | "current" {
  if (server.failure) return "stale";
  if (hidden) return "hidden";
  if (!server.reply || server.receivedAt === null) return "waiting";
  return now - server.receivedAt > 6000 ? "stale" : "current";
}
