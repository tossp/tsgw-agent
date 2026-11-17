import type { WakeupTask } from "./types";

/** Only durable terminal or explicitly closed records can be removed. */
export function canClearWakeup(task: Pick<WakeupTask, "status" | "unsaved">): boolean {
  return !task.unsaved && (task.status === "run_settled" || task.status === "run_aborted"
    || task.status === "delivery_failed" || task.status === "cancelled" || task.status === "closed");
}

/** Normal completion, cancellation and investigated closure need no acknowledgement. */
export function canAutoClearWakeup(task: Pick<WakeupTask, "status" | "unsaved">): boolean {
  return !task.unsaved && (task.status === "run_settled" || task.status === "cancelled" || task.status === "closed");
}
