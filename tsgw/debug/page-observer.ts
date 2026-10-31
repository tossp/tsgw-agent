import { createDebugPoller, DEBUG_POLL_MS, type DebugPollerOptions } from "@/components/debug-panel-state";
import type { SessionInfo } from "@/lib/types";

export const CATALOG_REFRESH_MS = 30_000;
const CATALOG_TIMEOUT_MS = 5000;

export interface CatalogTelemetry {
  inFlightSince: number | null;
  nextCheckAt: number | null;
  receivedAt: number | null;
  roundTripMs: number | null;
  requests: number;
  failures: number;
  consecutiveFailures: number;
  failed: boolean;
  samples: { at: number; ms: number; failed: boolean }[];
}

type Options = DebugPollerOptions & {
  onCatalog(sessions: SessionInfo[] | null, failed: boolean): void;
};

/** Fork-only observer. Both requests are GETs; selecting a row only changes the debug query. */
export function createDebugPageObserver(options: Options) {
  const debug = createDebugPoller(options);
  const now = options.now ?? Date.now;
  const startTimer = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const stopTimer = options.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  let catalogRequest: AbortController | null = null;
  let catalogDueAt = 0;
  let nextDebugCheckAt: number | null = null;
  let catalog: CatalogTelemetry = { inFlightSince: null, nextCheckAt: null, receivedAt: null, roundTripMs: null, requests: 0, failures: 0, consecutiveFailures: 0, failed: false, samples: [] };

  const readCatalog = async () => {
    if (disposed || !options.isVisible() || catalogRequest || now() < catalogDueAt) return;
    const controller = new AbortController();
    catalogRequest = controller;
    const startedAt = now();
    catalog = { ...catalog, inFlightSince: startedAt };
    let failed = false;
    const timer = startTimer(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await options.fetch("/api/sessions", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { sessions?: unknown };
      if (!body || !Array.isArray(body.sessions)) throw new Error("Invalid session catalog");
      if (!disposed && !controller.signal.aborted) options.onCatalog(body.sessions as SessionInfo[], false);
    } catch {
      failed = true;
      if (!disposed) options.onCatalog(null, true);
    } finally {
      stopTimer(timer);
      catalogRequest = null;
      const finishedAt = now();
      catalogDueAt = finishedAt + CATALOG_REFRESH_MS;
      if (!disposed) catalog = {
        inFlightSince: null, nextCheckAt: catalogDueAt,
        receivedAt: failed ? catalog.receivedAt : finishedAt,
        roundTripMs: Math.max(0, finishedAt - startedAt), requests: catalog.requests + 1,
        failures: catalog.failures + Number(failed), consecutiveFailures: failed ? catalog.consecutiveFailures + 1 : 0, failed,
        samples: [...catalog.samples, { at: finishedAt, ms: Math.max(0, finishedAt - startedAt), failed }].slice(-24),
      };
    }
  };

  return {
    poll(nextScheduledCheckAt = now() + DEBUG_POLL_MS) {
      if (!disposed && options.isVisible()) nextDebugCheckAt = nextScheduledCheckAt;
      debug.poll();
      void readCatalog();
    },
    sync: () => debug.sync(),
    inFlightSince: () => debug.inFlightSince(),
    nextDebugCheckAt: () => nextDebugCheckAt,
    catalogTelemetry: () => catalog,
    dispose() {
      disposed = true;
      debug.dispose();
      catalogRequest?.abort();
    },
  };
}
