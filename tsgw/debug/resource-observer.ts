import {
  DEBUG_POLL_MS,
  EMPTY_DEBUG_SERVER_READING,
  type DebugPollerOptions,
  type DebugServerReading,
} from "@/components/debug-panel-state";
import type { SessionInfo } from "@/lib/types";
import { createDebugPageObserver } from "./page-observer";

export type ResourceReadings = Readonly<Record<string, DebugServerReading>>;

export interface ResourcePageObserverOptions extends Omit<DebugPollerOptions, "sessionId"> {
  onCatalog(sessions: SessionInfo[] | null, failed: boolean): void;
  onResources(readings: ResourceReadings): void;
}

/**
 * One existing debug GET per visible check slot, not one GET per session. The initial null
 * query discovers the resident roster; subsequent polls rotate through every resident ID.
 * With N stable residents and a 2 s caller tick, each detail is sampled every 2*N seconds
 * (longer for slow requests and hidden pages). No history/selection or additional timers.
 * onReading keeps the last good global summary/time across failures, always with session=null.
 * onResources holds each resident's own detail/time/failure; roster exits remove its cache.
 */
export function createResourcePageObserver(options: ResourcePageObserverOptions) {
  const now = options.now ?? Date.now;
  let disposed = false;
  // A rotating cursor. Preserve its order when the server reorders or changes the roster.
  let cursor: string[] = [];
  let target: string | null = null;
  let lastCheckSlot: number | null = null;
  let readings: ResourceReadings = {};
  let lastGoodGlobal: Pick<DebugServerReading, "reply" | "receivedAt" | "roundTripMs"> | null = null;

  const observer = createDebugPageObserver({
    ...options,
    // Keep the target fixed until this GET finishes; overlapping ticks cannot abort it.
    sessionId: () => target,
    onReading(reading) {
      if (disposed) return;
      if (!reading.failure && reading.reply) {
        lastGoodGlobal = {
          reply: { ...reading.reply, session: null },
          receivedAt: reading.receivedAt,
          roundTripMs: reading.roundTripMs,
        };
        const residents = [...new Set(reading.reply.sessions.map((session) => session.sessionId))];
        const keep = new Set(residents);
        cursor = cursor.filter((id) => keep.has(id));
        const queued = new Set(cursor);
        cursor.push(...residents.filter((id) => !queued.has(id)));
        // Only the successful global roster decides residency, never catalog/history or the
        // requested detail. Even a late detail about an exited ID must not recreate its cache.
        readings = Object.fromEntries(residents.map((id) => [id, Object.hasOwn(readings, id)
          ? readings[id] : { ...EMPTY_DEBUG_SERVER_READING, sessionId: id }]));
      }
      const sessionId = reading.sessionId;
      if (sessionId !== null && Object.hasOwn(readings, sessionId)) {
        const previous = readings[sessionId];
        // The base poller validates the envelope, not that its detail matches the query.
        // Never attach another session's detail (or its retained reply on failure) to this ID.
        const failure = reading.failure ?? (reading.reply?.session?.sessionId === sessionId
          ? null : { kind: "invalid" as const, status: null, at: now() });
        readings = {
          ...readings,
          [sessionId]: {
            sessionId,
            reply: failure ? previous.reply : reading.reply,
            receivedAt: failure ? previous.receivedAt : reading.receivedAt,
            roundTripMs: failure ? previous.roundTripMs : reading.roundTripMs,
            failure,
            requests: previous.requests + 1,
            failures: previous.failures + Number(failure !== null),
            consecutiveFailures: failure ? previous.consecutiveFailures + 1 : 0,
          },
        };
      }
      // A failed target switch may drop the base poller's reply. Preserve global totals/roster
      // and their original success time, never the detail of this or a previously exited ID.
      options.onReading(lastGoodGlobal ? { ...reading, ...lastGoodGlobal } : reading);
      if (!disposed) options.onResources(readings);
    },
  });

  return {
    poll(nextScheduledCheckAt = now() + DEBUG_POLL_MS) {
      if (disposed || !options.isVisible()) return;
      if (observer.inFlightSince() === null) {
        // Visibility catch-up can share the caller's next check slot; do not read it twice.
        const checkSlot = Math.floor(nextScheduledCheckAt / DEBUG_POLL_MS);
        if (lastCheckSlot === checkSlot) return;
        lastCheckSlot = checkSlot;
        target = cursor.shift() ?? null;
        if (target !== null) cursor.push(target);
      }
      observer.poll(nextScheduledCheckAt);
    },
    inFlightSince: () => observer.inFlightSince(),
    nextDebugCheckAt: () => observer.nextDebugCheckAt(),
    catalogTelemetry: () => observer.catalogTelemetry(),
    dispose() {
      disposed = true;
      observer.dispose();
    },
  };
}
