import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { IM_MESSAGE_SOURCE_TYPE, imRequestId, withImMessageSource, type ImMessageSource } from "./message-data";

type Manager = Pick<SessionManager, "getLeafEntry" | "appendCustomEntry">;
interface PendingSource { source: ImMessageSource; recorded: boolean }
const KEY = Symbol.for("pi-web.im.messageSources");
type SourceGlobal = typeof globalThis & { [KEY]?: WeakMap<Manager, Map<string, PendingSource>> };
const pending = ((globalThis as SourceGlobal)[KEY] ??= new WeakMap());

/** This is the existing wrapper's manager, never a second owner of its file. */
export function registerImMessageSource(manager: Manager, source: ImMessageSource): () => void {
  let requests = pending.get(manager);
  if (!requests) pending.set(manager, requests = new Map());
  requests.set(source.requestId, { source, recorded: false });
  return () => {
    requests.delete(source.requestId);
    if (!requests.size) pending.delete(manager);
  };
}

/** Add Web-only fields without mutating the SDK message or extension event. */
export function withLiveImMessageSource<E extends { type: string; message?: unknown }>(event: E, manager: Manager): E {
  if (event.type !== "message_start" && event.type !== "message_end") return event;
  const message = event.message as { role?: string; content?: unknown } | undefined;
  if (message?.role !== "user") return event;
  const id = imRequestId(message.content);
  const request = id ? pending.get(manager)?.get(id) : undefined;
  if (!request) return event;
  if (event.type === "message_end" && !request.recorded) {
    request.recorded = true;
    // Pi 1.5 emits message_end BEFORE appendMessage, in the same synchronous stack.
    // The microtask runs after that append, before the next model/tool event.
    queueMicrotask(() => {
      try {
        const entry = manager.getLeafEntry();
        if (entry?.type !== "message" || entry.message !== message) {
          throw new Error("IM input was not appended at the current leaf");
        }
        manager.appendCustomEntry(IM_MESSAGE_SOURCE_TYPE, {
          version: 1, messageEntryId: entry.id, source: request.source,
        });
      } catch {
        // The prompt may already be accepted: a provenance failure must not invite a retry.
        console.error("[pi-web] IM input accepted but its source metadata could not be written.");
      }
    });
  }
  return { ...event, message: withImMessageSource({ ...message, role: "user", content: message.content }, request.source) };
}
