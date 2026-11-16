import { WakeupStore } from "./store";
import { getWakeupStateFile, peekWakeupRuntime } from "./host";
import { projectWakeups, validateWakeupQuery } from "./query";
import type { WakeupQuery, WakeupQueryResult } from "./types";

/** Queries never create a runtime, acquire ownership or start a target session. */
export async function readWakeupQuery(input: WakeupQuery = {}): Promise<WakeupQueryResult> {
  validateWakeupQuery(input);
  const runtime = peekWakeupRuntime();
  if (runtime) return runtime.query(input);
  let tasks;
  try {
    tasks = new WakeupStore(getWakeupStateFile()).read();
  } catch (error) {
    return { items: [], nextCursor: null, health: { state: "storage_error", isOwner: false, reason: error instanceof Error ? error.message : String(error) } };
  }
  return projectWakeups(tasks, input, {
    state: "read_only", isOwner: false, reason: "Wakeup scheduler has not initialized in this server process",
  }, new Set());
}

/** Cleanup is available only through this process's existing writable owner. */
export function clearWakeupRecord(wakeupId: string): { wakeupId: string } {
  const runtime = peekWakeupRuntime();
  if (!runtime) throw new Error("Wakeup scheduler has not initialized in this server process");
  return runtime.clear(wakeupId);
}

export function wakeupQueryFromParams(params: URLSearchParams): WakeupQuery {
  const input: Record<string, unknown> = {};
  for (const key of ["wakeup_id", "session_id", "source_session_id", "target_session_id", "cwd", "status", "cursor"] as const) {
    if (params.has(key)) input[key] = params.get(key);
  }
  if (params.has("armed")) {
    const value = params.get("armed");
    input.armed = value === "true" ? true : value === "false" ? false : value;
  }
  if (params.has("limit")) input.limit = Number(params.get("limit"));
  return validateWakeupQuery(input as WakeupQuery);
}
