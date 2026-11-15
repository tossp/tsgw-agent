import { createReadStream } from "node:fs";
import { WAKEUP_NOTIFICATION_TYPE } from "./history";

type Receipt = { receivedAt: string; notificationEntryId?: string; branchLeafId?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Kept local because history deliberately projects only custom metadata. Split
// on LF, not readline: U+2028/U+2029 are valid unescaped JSON string content.
async function* lines(input: ReturnType<typeof createReadStream>): AsyncGenerator<string> {
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

/** Recover only a receipt, never a run outcome, by reading the original target JSONL. */
export async function readWakeupReceipt(file: string, wakeupId: string, targetSessionId: string): Promise<Receipt | null> {
  const input = createReadStream(file, { encoding: "utf8" });
  let headerRead = false;
  try {
    for await (const line of lines(input)) {
      if (!headerRead) {
        let header: unknown;
        try { header = JSON.parse(line); } catch { throw new Error(`Invalid session header in ${file}`); }
        if (!isObject(header) || header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
          throw new Error(`Invalid session header in ${file}`);
        }
        if (header.id !== targetSessionId) return null;
        headerRead = true;
        continue;
      }
      try {
        // Standard SDK messages may contain multi-megabyte images. Only decode
        // their small leading type string; unusual key order uses JSON.parse.
        const leadingType = /^\s*\{\s*"type"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(line);
        if (leadingType && JSON.parse(leadingType[1]) !== "custom_message") continue;
        const entry: unknown = JSON.parse(line);
        if (!isObject(entry) || entry.type !== "custom_message" || entry.customType !== WAKEUP_NOTIFICATION_TYPE ||
          !isObject(entry.details) || entry.details.wakeupId !== wakeupId || entry.details.targetSessionId !== targetSessionId ||
          typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) continue;
        return {
          receivedAt: entry.timestamp,
          // The notification itself is a proven branch point. Later response
          // entries alone cannot prove that its host run ever settled.
          ...(typeof entry.id === "string" && entry.id ? { notificationEntryId: entry.id, branchLeafId: entry.id } : {}),
        };
      } catch {
        // Ignore corrupt/torn entries; no partial notification is evidence.
      }
    }
    if (!headerRead) throw new Error(`Invalid session header in ${file}`);
    return null;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return null;
    throw error;
  } finally {
    input.destroy();
  }
}
