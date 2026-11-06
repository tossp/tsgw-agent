import { agentStatusUrl } from "@/lib/agent-client";
import type { DebugPollerOptions } from "@/components/debug-panel-state";

export interface LiveModelReading {
  model: { id: string; provider: string } | null;
  thinkingLevel: string | null;
  running: boolean | null;
  receivedAt: number | null;
  failed: boolean;
}
export type LiveModelReadings = Readonly<Record<string, LiveModelReading>>;

type Options = Pick<DebugPollerOptions, "fetch" | "isVisible" | "now" | "setTimeout" | "clearTimeout"> & {
  onReading(readings: LiveModelReadings): void;
};

/** One existing status GET per resource poll at most; no session starts or lease requests. */
export function createLiveModelObserver(options: Options) {
  const now = options.now ?? Date.now;
  const startTimer = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const stopTimer = options.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let disposed = false;
  let active: { id: string; controller: AbortController; valid: boolean } | null = null;
  let ids = new Set<string>();
  let queue: string[] = [];
  let readings: Record<string, LiveModelReading> = {};

  async function read(id: string) {
    const controller = new AbortController();
    const request = { id, controller, valid: true };
    active = request;
    const timer = startTimer(() => controller.abort(), 5000);
    let value: LiveModelReading;
    try {
      const response = await options.fetch(agentStatusUrl(id), { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { running?: unknown; state?: { model?: { id?: unknown; provider?: unknown }; thinkingLevel?: unknown } };
      if (typeof data?.running !== "boolean" || (data.running && !data.state)) throw new Error("Invalid agent status");
      const model = data.running ? data.state?.model : null;
      value = {
        model: model && typeof model.id === "string" && typeof model.provider === "string" ? { id: model.id, provider: model.provider } : null,
        thinkingLevel: data.running && typeof data.state?.thinkingLevel === "string" ? data.state.thinkingLevel : null,
        running: data.running, receivedAt: now(), failed: false,
      };
    } catch {
      value = { ...(readings[id] ?? { model: null, thinkingLevel: null, running: null, receivedAt: null }), failed: true };
    } finally {
      stopTimer(timer);
      if (active === request) active = null;
    }
    if (disposed || !request.valid || !ids.has(id)) return;
    readings = { ...readings, [id]: value };
    options.onReading(readings);
  }

  return {
    retain(sessionIds: readonly string[]) {
      ids = new Set(sessionIds);
      if (active && !ids.has(active.id)) {
        // The same ID can rejoin before this old request settles, even after abort.
        active.valid = false;
        active.controller.abort();
      }
      queue = queue.filter(id => ids.has(id));
      const kept = Object.fromEntries(Object.entries(readings).filter(([id]) => ids.has(id)));
      if (Object.keys(kept).length !== Object.keys(readings).length) {
        readings = kept;
        options.onReading(readings);
      }
    },
    poll(id: string) {
      if (disposed || !options.isVisible() || !ids.has(id)) return;
      if (active?.id !== id && !queue.includes(id)) queue.push(id);
      if (active) return;
      const next = queue.shift();
      if (next) void read(next);
    },
    dispose() {
      disposed = true;
      queue = [];
      active?.controller.abort();
    },
  };
}
