import { dirname } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { WakeupScheduler, type Wakeup } from "./scheduler";
import { wakeupHistory, type WakeupEvent, type WakeupRecord } from "./history";
import { WakeupStore } from "./store";
import { acquireWakeupOwnership } from "./ownership";
import { projectWakeups, validateWakeupQuery } from "./query";
import { canClearWakeup } from "./cleanup";
import type { WakeupHealth, WakeupObservation, WakeupQuery, WakeupResult, WakeupTask } from "./types";

export interface WakeupSessionStore {
  assertTarget(sessionId: string): Promise<void | { cwd: string }>;
  append(record: WakeupRecord, assertCanAppend: () => void): Promise<void>;
  read(sessionId: string): Promise<Parameters<typeof wakeupHistory>[0]>;
  create?(cwd: string, title?: string): Promise<{ sessionId: string; cwd: string }>;
  receipt?(task: WakeupTask): Promise<{ receivedAt: string; notificationEntryId?: string; branchLeafId?: string } | null>;
}
export interface ScheduleWakeupInput {
  session_id?: string;
  cwd?: string;
  title?: string;
  after_seconds?: number;
  at?: string;
  message: string;
}
export interface WakeupDeliveryContext {
  signal: AbortSignal;
  assertCanSubmit(): void;
}
export interface WakeupRuntimeOptions {
  stateFile?: string;
  store?: WakeupStore;
  acquireOwnership?: typeof acquireWakeupOwnership;
}
export class WakeupOperationError extends Error {
  constructor(message: string, readonly details: { code: string; scheduled?: false; targetSessionId?: string; cancellationConfirmed?: false }) {
    super(message);
  }
}

/** The persistent task state owns recovery; session metadata is an audit mirror. */
export class WakeupRuntime {
  private readonly scheduler: WakeupScheduler;
  private readonly store?: WakeupStore;
  private readonly stateDirectory?: string;
  private tasks = new Map<string, WakeupTask>();
  private readonly unsaved = new Map<string, WakeupTask>();
  private readonly submissions = new Map<string, { target: string; controller: AbortController }>();
  private health: WakeupHealth;
  private owner?: Awaited<ReturnType<typeof acquireWakeupOwnership>>;
  private readonly initialized: Promise<void>;
  private disposed = false;

  constructor(private readonly sessions: WakeupSessionStore, deliver: (wakeup: Wakeup, context: WakeupDeliveryContext) => Promise<void>, options: WakeupRuntimeOptions = {}) {
    this.store = options.store ?? (options.stateFile ? new WakeupStore(options.stateFile) : undefined);
    if (this.store && !options.stateFile) throw new Error("stateFile is required with a persistent wakeup store");
    this.stateDirectory = options.stateFile ? dirname(options.stateFile) : undefined;
    this.health = { state: this.store ? "starting" : "ready", isOwner: !this.store };
    this.scheduler = new WakeupScheduler(wakeup => this.fire(wakeup, deliver));
    this.initialized = this.store
      ? this.restore(options.acquireOwnership ?? acquireWakeupOwnership)
      : Promise.resolve();
  }

  ready(): Promise<void> { return this.initialized; }

  async schedule(sourceSessionId: string, input: ScheduleWakeupInput): Promise<WakeupResult> {
    const now = Date.now();
    const scheduledAt = wakeupTime(input, now);
    const message = input.message.trim();
    if (!message) throw new Error("Wakeup message must not be empty");
    if (input.cwd !== undefined && input.session_id !== undefined) throw new Error("cwd and session_id are mutually exclusive");
    if (input.title !== undefined && (!input.cwd || !input.title.trim())) throw new Error("title requires cwd and must not be empty");
    const targetId = input.session_id === undefined ? sourceSessionId : input.session_id.trim();
    if (!targetId || (input.cwd !== undefined && !input.cwd.trim())) throw new Error("Target must not be empty");
    await this.ready();
    this.assertWritable();
    let targetSessionId = targetId;
    let cwd: string | undefined;
    let created = false;
    if (input.cwd !== undefined) {
      if (!this.sessions.create) throw new Error("Creating a wakeup session is unavailable");
      const target = await this.sessions.create(input.cwd, input.title?.trim());
      targetSessionId = target.sessionId;
      cwd = target.cwd;
      created = true;
    }
    try {
      const target = await this.sessions.assertTarget(targetSessionId);
      cwd ??= target?.cwd;
      this.assertWritable();
      const wakeup: Wakeup = { wakeupId: uuidv7(), sourceSessionId, targetSessionId, createdAt: new Date(now).toISOString(), scheduledAt, message };
      this.save({ ...wakeup, ...(cwd ? { cwd } : {}), status: "pending", updatedAt: new Date().toISOString() });
      this.scheduler.add(wakeup);
      const diagnostics = await this.audit(wakeup, "created");
      return diagnostics ? { ...wakeup, diagnostics } : wakeup;
    } catch (error) {
      if (created) throw new WakeupOperationError(`Session ${targetSessionId} was created, but its wakeup was not scheduled: ${errorText(error)}`, {
        code: "session_created_wakeup_not_scheduled", scheduled: false, targetSessionId,
      });
      throw error;
    }
  }

  list(): Wakeup[] { return this.scheduler.list(); }

  async cancel(wakeupId: string): Promise<WakeupResult> {
    await this.ready();
    this.assertWritable();
    const task = this.tasks.get(wakeupId);
    if (!task || task.status !== "pending" || !this.scheduler.has(wakeupId)) throw new Error("Wakeup is not pending in this server process");
    try {
      this.save({ ...task, status: "cancelled", cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    } catch (error) {
      throw new WakeupOperationError(errorText(error), { code: "wakeup_cancel_not_saved", cancellationConfirmed: false });
    }
    const wakeup = this.scheduler.cancel(wakeupId)!;
    const diagnostics = await this.audit(wakeup, "cancelled");
    return diagnostics ? { ...wakeup, diagnostics } : wakeup;
  }

  /** Remove only the manifest record; never touch the target session or its audit. */
  clear(wakeupId: string): { wakeupId: string } {
    this.assertWritable();
    const task = this.unsaved.get(wakeupId) ?? this.tasks.get(wakeupId);
    if (!task) throw new WakeupOperationError("Wakeup not found", { code: "wakeup_not_found" });
    // Delivery may still save submittedAt after a settled observation has arrived.
    if (!canClearWakeup(task) || this.submissions.has(wakeupId)) {
      throw new WakeupOperationError("Wakeup is not ready to be cleared", { code: "wakeup_not_clearable" });
    }
    const next = new Map(this.tasks);
    next.delete(wakeupId);
    this.saveTasks(next);
    return { wakeupId };
  }

  async history(sessionId: string) { return wakeupHistory(await this.sessions.read(sessionId), this.list(), sessionId); }

  async query(input: WakeupQuery = {}) {
    validateWakeupQuery(input);
    // Read-only inspection must stay available while another process holds the lock.
    if (!this.store) await this.ready();
    let tasks = [...this.tasks.values()];
    if (this.store) {
      try { tasks = this.store.read(); }
      catch (error) {
        this.pause("storage_error", errorText(error));
      }
    }
    const merged = new Map(tasks.map(task => [task.wakeupId, task]));
    for (const [id, task] of this.unsaved) merged.set(id, task);
    return projectWakeups([...merged.values()], input, this.health, new Set(this.list().map(task => task.wakeupId)));
  }

  observe(value: WakeupObservation): void {
    const task = this.unsaved.get(value.wakeupId) ?? this.tasks.get(value.wakeupId);
    if (!task || task.status === "cancelled" || task.status === "delivery_failed") return;
    if (value.type === "settled" && task.runId && task.runId !== value.runId) return;
    if (value.type === "uncertain" && task.settledAt) return;
    const next: WakeupTask = { ...task, updatedAt: new Date().toISOString() };
    if (value.notificationEntryId) next.notificationEntryId = value.notificationEntryId;
    if (value.branchLeafId) next.branchLeafId = value.branchLeafId;
    if (value.responseEntryIds) next.responseEntryIds = value.responseEntryIds;
    if (value.type === "received") {
      next.receivedAt ??= value.at;
      if (value.runId) next.runId = value.runId;
      next.status = next.settledAt ? (next.aborted ? "run_aborted" : "run_settled") : "received";
      delete next.error;
    } else if (value.type === "settled") {
      next.settledAt = value.at;
      next.aborted = value.aborted === true;
      next.status = next.aborted ? "run_aborted" : "run_settled";
      if (value.responseEntryIds) next.responseEntryIds = value.responseEntryIds;
    } else {
      next.status = "unknown";
      next.error = value.reason ?? "Observation interrupted; delivery will not be repeated";
    }
    if (this.health.state !== "ready" || !this.isOwner()) {
      this.unsaved.set(next.wakeupId, { ...next, unsaved: true });
      return;
    }
    try {
      this.save(next);
      void this.audit(next, value.type === "received" ? "received" : value.type === "settled" ? next.status as WakeupEvent : "unknown");
    } catch {
      this.unsaved.set(next.wakeupId, { ...next, unsaved: true });
    }
  }

  stopSession(sessionId: string): void {
    for (const submission of this.submissions.values()) if (submission.target === sessionId) submission.controller.abort(new Error("Wakeup preparation stopped"));
    for (const task of this.tasks.values()) {
      if (task.targetSessionId === sessionId && (task.submittedAt || task.receivedAt) && !task.settledAt) {
        this.observe({ type: "uncertain", wakeupId: task.wakeupId, at: new Date().toISOString(), reason: "Stop or Recall occurred; individual queued notifications cannot be confirmed as withdrawn" });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pause("paused", "Wakeup runtime closed");
    if (this.owner) void this.owner.release().catch(error => console.error("[pi-web] wakeup ownership release failed", error));
  }

  private async restore(acquire: typeof acquireWakeupOwnership): Promise<void> {
    try {
      this.owner = await acquire(this.stateDirectory!, error => this.pause("paused", `Wakeup ownership lost: ${errorText(error)}`));
      if (this.disposed) { await this.owner.release(); return; }
      const tasks = this.store!.read();
      this.tasks = new Map(tasks.map(task => [task.wakeupId, task]));
      this.health = { state: "ready", isOwner: true };
      for (const task of tasks) {
        if (task.status === "pending") {
          if (Date.parse(task.scheduledAt) <= Date.now()) this.tasks.set(task.wakeupId, { ...task, recoveredAt: new Date().toISOString() });
          this.scheduler.add(task);
        } else if (!task.settledAt && !["cancelled", "delivery_failed"].includes(task.status)) {
          const receipt = await this.sessions.receipt?.(task).catch(() => null);
          this.assertWritable();
          this.save({ ...task, ...(receipt ?? {}), status: "unknown", updatedAt: new Date().toISOString(), error: "Server restarted after dispatch began; not automatically resubmitted" });
        }
      }
    } catch (error) {
      this.pause((error as NodeJS.ErrnoException).code === "ELOCKED" ? "read_only" : "storage_error", errorText(error));
    }
  }

  private isOwner(): boolean { return !this.disposed && (this.owner?.isOwner() ?? !this.store); }
  private assertWritable(): void {
    if (this.health.state !== "ready" || !this.isOwner()) throw new Error(this.health.reason ?? "Wakeup state is managed by another instance or is unavailable");
  }
  private pause(state: WakeupHealth["state"], reason: string): void {
    this.health = { state, isOwner: this.isOwner(), reason };
    this.scheduler.dispose();
    for (const submission of this.submissions.values()) submission.controller.abort(new Error(reason));
  }
  private save(task: WakeupTask): void {
    this.saveTasks(new Map(this.tasks).set(task.wakeupId, task));
    this.unsaved.delete(task.wakeupId);
  }
  private saveTasks(next: Map<string, WakeupTask>): void {
    this.assertWritable();
    try { this.store?.save([...next.values()]); }
    catch (error) { this.pause("storage_error", errorText(error)); throw error; }
    this.tasks = next;
  }

  private async fire(wakeup: Wakeup, deliver: (wakeup: Wakeup, context: WakeupDeliveryContext) => Promise<void>): Promise<void> {
    const task = this.tasks.get(wakeup.wakeupId);
    if (this.health.state !== "ready" || task?.status !== "pending") return;
    const at = new Date().toISOString();
    this.save({ ...task, status: "dispatching", dispatchingAt: at, updatedAt: at });
    const controller = new AbortController();
    this.submissions.set(wakeup.wakeupId, { target: wakeup.targetSessionId, controller });
    let accepted = false;
    try {
      await deliver(wakeup, { signal: controller.signal, assertCanSubmit: () => { controller.signal.throwIfAborted(); this.assertWritable(); } });
      accepted = true;
      const current = this.unsaved.get(wakeup.wakeupId) ?? this.tasks.get(wakeup.wakeupId)!;
      const submittedAt = new Date().toISOString();
      const next: WakeupTask = { ...current, submittedAt, updatedAt: submittedAt, status: current.status === "dispatching" ? "submitted" : current.status };
      try { this.save(next); }
      catch { this.unsaved.set(next.wakeupId, { ...next, unsaved: true }); }
      await this.audit(wakeup, "submitted");
    } catch (error) {
      if (accepted) return;
      const current = this.unsaved.get(wakeup.wakeupId) ?? this.tasks.get(wakeup.wakeupId)!;
      if (current.receivedAt) return;
      const next: WakeupTask = { ...current, status: "delivery_failed", updatedAt: new Date().toISOString(), error: errorText(error) };
      if (this.health.state === "ready" && this.isOwner()) {
        try { this.save(next); await this.audit(wakeup, "failed", next.error); }
        catch { this.unsaved.set(next.wakeupId, { ...next, status: "unknown", unsaved: true }); }
      } else this.unsaved.set(next.wakeupId, { ...next, status: "unknown", unsaved: true });
    } finally { this.submissions.delete(wakeup.wakeupId); }
  }

  private async audit(wakeup: Wakeup, event: WakeupEvent, error?: string) {
    try {
      if (this.store && !this.isOwner()) return [{ code: "wakeup_audit_not_saved", message: "Wakeup ownership was lost; audit not written" }];
      await this.sessions.append({ ...wakeup, version: 1, event, recordedAt: new Date().toISOString(), ...(error ? { error } : {}) }, () => {
        if (this.store && !this.isOwner()) throw new Error("Wakeup ownership lost before audit append");
      });
      return undefined;
    } catch (failure) {
      console.error(`[pi-web] wakeup ${wakeup.wakeupId} ${event} audit could not be written`, failure);
      return [{ code: "wakeup_audit_not_saved", message: errorText(failure) }];
    }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Validate once before creating a target or changing persistent state. */
function wakeupTime(input: ScheduleWakeupInput, now: number): string {
  if ((input.after_seconds === undefined) === (input.at === undefined)) throw new Error("Specify exactly one of after_seconds or at");
  let timestamp: number;
  if (input.after_seconds !== undefined) {
    if (!Number.isFinite(input.after_seconds) || input.after_seconds <= 0) throw new Error("after_seconds must be a positive finite number");
    timestamp = now + input.after_seconds * 1000;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at!)) throw new Error("at must be an ISO 8601 timestamp with an explicit timezone");
    const date = input.at!.slice(0, 10);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new Error("at contains an invalid calendar date");
    timestamp = Date.parse(input.at!);
  }
  timestamp = Math.trunc(timestamp);
  if (!Number.isFinite(timestamp) || timestamp > 8_640_000_000_000_000 || timestamp <= now) throw new Error("Wakeup time must be a valid future time");
  return new Date(timestamp).toISOString();
}
