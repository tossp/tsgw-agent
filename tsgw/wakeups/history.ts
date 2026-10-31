import { createReadStream } from "node:fs";
import type { Wakeup } from "./scheduler";

export const WAKEUP_META_TYPE = "pi-web:wakeup";
export const WAKEUP_NOTIFICATION_TYPE = "pi-web:wakeup-notification";

/** `submitted` means accepted/queued by the SDK, not persisted or executed. */
export type WakeupEvent = "created" | "cancelled" | "submitted" | "failed";

export type WakeupRecord = Wakeup & {
  version: 1;
  event: WakeupEvent;
  recordedAt: string;
  error?: string;
};

export type WakeupHistoryItem = Wakeup & {
  status: WakeupEvent | "inactive";
  active: boolean;
  events: WakeupRecord[];
};

type HistoryEntry = { type: string; customType?: string; data?: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is WakeupRecord {
  if (!isObject(value) || value.version !== 1) return false;
  if (!["created", "cancelled", "submitted", "failed"].includes(value.event as string)) return false;
  for (const field of ["wakeupId", "sourceSessionId", "targetSessionId"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) return false;
  }
  for (const field of ["createdAt", "scheduledAt", "recordedAt"] as const) {
    if (typeof value[field] !== "string" || !Number.isFinite(Date.parse(value[field]))) return false;
  }
  return typeof value.message === "string" && (value.error === undefined || typeof value.error === "string");
}

/**
 * Whole-file audit history, not the selected leaf's branch. File order decides
 * the last event (not its timestamp). Metadata never arms or restores a timer.
 * Only a still-created timer owned by this session can be active; inherited
 * fork metadata stays visible but cannot claim its original session's timer.
 */
export function wakeupHistory(
  entries: readonly HistoryEntry[],
  active: readonly Wakeup[],
  sessionId: string,
): WakeupHistoryItem[] {
  const groups = new Map<string, WakeupRecord[]>();
  for (const entry of entries) {
    // Do not inspect arbitrary extensions' data or custom chat notifications.
    if (entry.type !== "custom" || entry.customType !== WAKEUP_META_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data)) continue;
    const events = groups.get(data.wakeupId);
    if (events) events.push(data);
    else groups.set(data.wakeupId, [data]);
  }

  const armed = new Set(active.filter((item) => item.targetSessionId === sessionId).map((item) => item.wakeupId));
  return [...groups.values()].map((events) => {
    const last = events[events.length - 1];
    const isActive = last.event === "created" && last.targetSessionId === sessionId && armed.has(last.wakeupId);
    return {
      wakeupId: last.wakeupId,
      sourceSessionId: last.sourceSessionId,
      targetSessionId: last.targetSessionId,
      createdAt: last.createdAt,
      scheduledAt: last.scheduledAt,
      message: last.message,
      status: last.event === "created" && !isActive ? "inactive" : last.event,
      active: isActive,
      events,
    };
  });
}

/** Node 24's readline splits on U+2028/U+2029 inside valid JSON strings; pi uses LF. */
async function* sessionLines(input: ReturnType<typeof createReadStream>): AsyncGenerator<string> {
  let fragments: string[] = [];
  for await (const chunk of input) {
    const text = String(chunk);
    let start = 0;
    let end: number;
    while ((end = text.indexOf("\n", start)) !== -1) {
      fragments.push(text.slice(start, end));
      yield fragments.join("");
      fragments = [];
      start = end + 1;
    }
    if (start < text.length) fragments.push(text.slice(start));
  }
  if (fragments.length) yield fragments.join("");
}

/**
 * Read-only, streaming projection of all custom entries, including old branches.
 * Header versions are deliberately not migrated. Malformed non-header lines
 * (including an append in flight) are skipped; an invalid first line is fatal.
 */
export async function readWakeupSessionFile(path: string): Promise<{
  header: { id: string; cwd: string };
  entries: Array<HistoryEntry>;
}> {
  const input = createReadStream(path, { encoding: "utf8" });
  let header: { id: string; cwd: string } | undefined;
  const entries: HistoryEntry[] = [];
  const invalidHeader = () => new Error(`Invalid session header in ${path}: first line must contain type=session and non-empty id/cwd`);
  try {
    for await (const line of sessionLines(input)) {
      if (!header) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw invalidHeader();
        }
        if (!isObject(value) || value.type !== "session" ||
          typeof value.id !== "string" || !value.id.trim() ||
          typeof value.cwd !== "string" || !value.cwd.trim()) throw invalidHeader();
        header = { id: value.id, cwd: value.cwd };
        continue;
      }
      try {
        // Pi serializes type first. Skip normal messages (including large images) before
        // parsing; unusual key order or escaped property names use the native parser.
        const leadingType = /^\s*\{\s*"type"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line);
        if (leadingType && JSON.parse(leadingType[1]) !== "custom") continue;
        const entry: unknown = JSON.parse(line);
        if (!isObject(entry) || entry.type !== "custom") continue;
        entries.push({
          type: "custom",
          ...(typeof entry.customType === "string" ? { customType: entry.customType } : {}),
          ...(entry.data !== undefined ? { data: entry.data } : {}),
        });
      } catch {
        // A corrupt/torn entry does not hide valid metadata elsewhere in the file.
      }
    }
    if (!header) throw invalidHeader();
    return { header, entries };
  } finally {
    input.destroy();
  }
}
