import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentSessionEvent as AgentEvent, SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import { WAKEUP_NOTIFICATION_TYPE } from "./history";
import type { WakeupObservation } from "./types";

type ReadonlySessionManager = Pick<SessionManager, "getEntries" | "getLeafId">;

type Tracked = {
  wakeupId: string;
  receivedAt: string;
  notificationEntryId?: string;
  branchLeafId?: string;
  responseEntryIds: string[];
  responses: Set<unknown>;
};

function notificationId(value: { customType: string; details?: unknown }, sessionId: string): string | undefined {
  if (value.customType !== WAKEUP_NOTIFICATION_TYPE) return;
  const details = value.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  const { wakeupId, targetSessionId } = details as Record<string, unknown>;
  if (targetSessionId === sessionId && typeof wakeupId === "string" && wakeupId.trim()) return wakeupId;
}

/** Observes the original SDK stream; it owns no subscription or queued-message state. */
export function createWakeupObserver(
  sessionId: string,
  manager: Pick<ReadonlySessionManager, "getEntries" | "getLeafId">,
  onObservation: (value: WakeupObservation) => void,
): { onEvent(event: AgentEvent): void; onStop(): void; dispose(): void } {
  let runId: string | undefined;
  let disposed = false;
  let refreshQueued = false;
  const tracked = new Map<string, Tracked>();

  const observation = (item: Tracked, type: WakeupObservation["type"], at: string): WakeupObservation => ({
    type, wakeupId: item.wakeupId, at, runId,
    ...(item.notificationEntryId ? { notificationEntryId: item.notificationEntryId } : {}),
    ...(item.branchLeafId ? { branchLeafId: item.branchLeafId } : {}),
    ...(item.responseEntryIds.length ? { responseEntryIds: [...item.responseEntryIds] } : {}),
  });

  function refresh(emit: boolean): void {
    if (!tracked.size) return;
    const entries = manager.getEntries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const leafId = manager.getLeafId();
    const descendsFrom = (id: string, ancestor: string): boolean => {
      const visited = new Set<string>();
      let cursor: string | null = id;
      while (cursor && !visited.has(cursor)) {
        if (cursor === ancestor) return true;
        visited.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return false;
    };
    const notifications = new Map<string, SessionEntry>();
    for (const entry of entries) {
      if (entry.type !== "custom_message") continue;
      const id = notificationId(entry, sessionId);
      if (id) notifications.set(id, entry);
    }
    for (const item of tracked.values()) {
      const before = JSON.stringify([item.notificationEntryId, item.branchLeafId, item.responseEntryIds]);
      const notification = notifications.get(item.wakeupId);
      if (notification) item.notificationEntryId = notification.id;
      if (item.notificationEntryId) {
        // Keep the first proven leaf as a stable branch anchor. Audit appends
        // triggered by our callback must not cause an endless receipt/update loop.
        if (!item.branchLeafId && leafId && descendsFrom(leafId, item.notificationEntryId)) item.branchLeafId = leafId;
        for (const entry of entries) {
          if (entry.type === "message" && item.responses.has(entry.message) &&
            descendsFrom(entry.id, item.notificationEntryId) && !item.responseEntryIds.includes(entry.id)) {
            item.responseEntryIds.push(entry.id);
          }
        }
      }
      if (emit && before !== JSON.stringify([item.notificationEntryId, item.branchLeafId, item.responseEntryIds])) {
        // Evidence can arrive after message_start. Keep the original receipt time.
        onObservation(observation(item, "received", item.receivedAt));
      }
    }
  }

  function refreshLater(): void {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!disposed) refresh(true);
    });
  }

  function uncertain(reason: string): void {
    refresh(false);
    const at = new Date().toISOString();
    for (const item of tracked.values()) onObservation({ ...observation(item, "uncertain", at), reason });
  }

  return {
    onEvent(event) {
      if (disposed) return;
      if (event.type === "agent_start") {
        // Retries and extension continuations may start core agents repeatedly.
        runId ??= uuidv7();
      }
      if (event.type === "message_start" && event.message.role === "custom") {
        const wakeupId = notificationId(event.message, sessionId);
        if (wakeupId && !tracked.has(wakeupId)) {
          runId ??= uuidv7();
          const item: Tracked = { wakeupId, receivedAt: new Date().toISOString(), responseEntryIds: [], responses: new Set() };
          tracked.set(wakeupId, item);
          refresh(false);
          onObservation(observation(item, "received", item.receivedAt));
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        for (const item of tracked.values()) item.responses.add(event.message);
      }
      if (event.type === "agent_settled") {
        refresh(false);
        const at = new Date().toISOString();
        for (const item of tracked.values()) {
          onObservation({ ...observation(item, "settled", at), aborted: event.aborted });
        }
        tracked.clear();
        runId = undefined;
      } else if (tracked.size && (event.type === "message_start" || event.type === "message_end" ||
        event.type === "entry_appended" || event.type === "turn_end" || event.type === "agent_end" || event.type === "agent_start")) {
        // Do not rescan transcript entries for token/tool streaming updates.
        refresh(true);
        // SDK message_end is emitted before its ordinary append; no entry_appended
        // is promised for that path. This read runs after the synchronous append.
        if (event.type === "message_end" || event.type === "entry_appended") refreshLater();
      }
    },
    onStop() {
      if (!disposed) uncertain("Stop/Recall interrupted observation; per-message queue removal is unknown");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { uncertain("Observer disposed before agent_settled"); }
      finally { tracked.clear(); runId = undefined; }
    },
  };
}
