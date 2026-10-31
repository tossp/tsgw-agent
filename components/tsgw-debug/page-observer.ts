import { createDebugPoller, type DebugPollerOptions } from "../debug-panel-state";
import type { SessionInfo } from "@/lib/types";

export const CATALOG_REFRESH_MS = 30_000;
const CATALOG_TIMEOUT_MS = 5000;

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

  const readCatalog = async () => {
    if (disposed || !options.isVisible() || catalogRequest || now() < catalogDueAt) return;
    const controller = new AbortController();
    catalogRequest = controller;
    const timer = startTimer(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await options.fetch("/api/sessions", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { sessions?: unknown };
      if (!body || !Array.isArray(body.sessions)) throw new Error("Invalid session catalog");
      if (!disposed && !controller.signal.aborted) options.onCatalog(body.sessions as SessionInfo[], false);
    } catch {
      if (!disposed) options.onCatalog(null, true);
    } finally {
      stopTimer(timer);
      catalogRequest = null;
      catalogDueAt = now() + CATALOG_REFRESH_MS;
    }
  };

  return {
    poll() {
      debug.poll();
      void readCatalog();
    },
    sync: () => debug.sync(),
    dispose() {
      disposed = true;
      debug.dispose();
      catalogRequest?.abort();
    },
  };
}
