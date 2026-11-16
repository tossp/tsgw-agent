import { samePath } from "../../lib/paths";
import type { WakeupHealth, WakeupQuery, WakeupQueryResult, WakeupStatus, WakeupTask } from "./types";

export const WAKEUP_STATUSES: readonly WakeupStatus[] = ["pending", "dispatching", "submitted", "received", "run_settled", "run_aborted", "delivery_failed", "cancelled", "unknown", "closed"];

export function validateWakeupQuery(input: WakeupQuery): WakeupQuery {
  for (const key of ["wakeup_id", "session_id", "source_session_id", "target_session_id", "cwd", "cursor"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key]!.trim())) throw new Error(`Invalid ${key}`);
  }
  if (input.status !== undefined && !WAKEUP_STATUSES.includes(input.status)) throw new Error("Invalid wakeup status");
  if (input.armed !== undefined && typeof input.armed !== "boolean") throw new Error("Invalid armed filter");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new Error("limit must be an integer between 1 and 100");
  return input;
}

export function projectWakeups(tasks: readonly WakeupTask[], input: WakeupQuery, health: WakeupHealth, armed: ReadonlySet<string>): WakeupQueryResult {
  const rows = tasks.filter(task =>
    (!input.wakeup_id || task.wakeupId === input.wakeup_id)
    && (!input.session_id || task.sourceSessionId === input.session_id || task.targetSessionId === input.session_id)
    && (!input.source_session_id || task.sourceSessionId === input.source_session_id)
    && (!input.target_session_id || task.targetSessionId === input.target_session_id)
    && (!input.cwd || (task.cwd !== undefined && samePath(task.cwd, input.cwd)))
    && (!input.status || task.status === input.status)
    && (input.armed === undefined || armed.has(task.wakeupId) === input.armed),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.wakeupId.localeCompare(a.wakeupId));
  const position = input.cursor ? rows.findIndex(task => task.wakeupId === input.cursor) : -1;
  if (input.cursor && position === -1) throw new Error("Wakeup cursor no longer matches this query");
  const start = position + 1;
  const page = rows.slice(start, start + (input.limit ?? 50));
  return {
    items: page.map(({ message, ...task }) => ({
      ...task, summary: message.split(/\r?\n/).find(line => line.trim())?.slice(0, 180) ?? "",
      ...(input.wakeup_id ? { message } : {}), armed: armed.has(task.wakeupId),
    })),
    nextCursor: start + page.length < rows.length ? page[page.length - 1].wakeupId : null,
    health: { ...health },
  };
}
