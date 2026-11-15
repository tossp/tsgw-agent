import type { Wakeup } from "./scheduler";

export type WakeupStatus = "pending" | "dispatching" | "submitted" | "received" | "run_settled" | "run_aborted" | "delivery_failed" | "cancelled" | "unknown";
export interface WakeupTask extends Wakeup {
  cwd?: string;
  status: WakeupStatus;
  updatedAt: string;
  dispatchingAt?: string;
  submittedAt?: string;
  receivedAt?: string;
  settledAt?: string;
  cancelledAt?: string;
  recoveredAt?: string;
  runId?: string;
  notificationEntryId?: string;
  branchLeafId?: string;
  responseEntryIds?: string[];
  aborted?: boolean;
  error?: string;
  unsaved?: boolean;
}

export interface WakeupHealth {
  state: "ready" | "starting" | "read_only" | "paused" | "storage_error";
  isOwner: boolean;
  reason?: string;
}

export interface WakeupQuery {
  wakeup_id?: string;
  session_id?: string;
  source_session_id?: string;
  target_session_id?: string;
  cwd?: string;
  status?: WakeupStatus;
  limit?: number;
  cursor?: string;
}

export type WakeupQueryItem = Omit<WakeupTask, "message"> & {
  summary: string;
  message?: string;
  armed: boolean;
};
export interface WakeupQueryResult {
  items: WakeupQueryItem[];
  nextCursor: string | null;
  health: WakeupHealth;
}

export type WakeupObservation = {
  type: "received" | "settled" | "uncertain";
  wakeupId: string;
  at: string;
  runId?: string;
  notificationEntryId?: string;
  branchLeafId?: string;
  responseEntryIds?: string[];
  aborted?: boolean;
  reason?: string;
};

export interface WakeupDiagnostic { code: string; message: string }
export type WakeupResult = Wakeup & { diagnostics?: WakeupDiagnostic[] };
