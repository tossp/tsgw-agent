import type { SessionInfo } from "@/lib/types";

/** Subagents of a family that the sidebar's running poll lists. */
export function getRunningSubagents(
  subagents: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): SessionInfo[] {
  return subagents.filter((session) => session.relation?.kind === "subagent" && runningSessionIds.has(session.id));
}
