import type { WakeupTask } from "./types";

/** Only durable, conclusive terminal records can be removed from the manifest. */
export function canClearWakeup(task: Pick<WakeupTask, "status" | "unsaved">): boolean {
  return !task.unsaved && (task.status === "run_settled" || task.status === "run_aborted"
    || task.status === "delivery_failed" || task.status === "cancelled");
}
