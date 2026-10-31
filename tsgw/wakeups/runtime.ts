import { uuidv7 } from "@earendil-works/pi-ai";
import { WakeupScheduler, type Wakeup } from "./scheduler";
import { wakeupHistory, type WakeupEvent, type WakeupRecord } from "./history";

export interface WakeupSessionStore {
  assertTarget(sessionId: string): Promise<void>;
  append(record: WakeupRecord): Promise<void>;
  read(sessionId: string): Promise<Parameters<typeof wakeupHistory>[0]>;
}

export interface ScheduleWakeupInput {
  session_id?: string;
  after_seconds?: number;
  at?: string;
  message: string;
}

export class WakeupRuntime {
  private readonly scheduler: WakeupScheduler;

  constructor(private readonly sessions: WakeupSessionStore, deliver: (wakeup: Wakeup) => Promise<void>) {
    this.scheduler = new WakeupScheduler(async (wakeup) => {
      try {
        await deliver(wakeup);
      } catch (error) {
        await this.record(wakeup, "failed", error instanceof Error ? error.message : String(error));
        return;
      }
      // Submission already happened. An audit write failure must never imply delivery failed.
      try {
        await this.record(wakeup, "submitted");
      } catch (error) {
        console.error(`[pi-web] wakeup ${wakeup.wakeupId} was submitted but its history could not be written`, error);
      }
    });
  }

  async schedule(sourceSessionId: string, input: ScheduleWakeupInput): Promise<Wakeup> {
    const now = Date.now();
    const scheduledAt = wakeupTime(input, now);
    const message = input.message.trim();
    if (!message) throw new Error("Wakeup message must not be empty");
    const targetSessionId = input.session_id === undefined ? sourceSessionId : input.session_id.trim();
    if (!targetSessionId) throw new Error("Target session ID must not be empty");
    await this.sessions.assertTarget(targetSessionId);
    const wakeup: Wakeup = {
      wakeupId: uuidv7(), sourceSessionId, targetSessionId,
      createdAt: new Date(now).toISOString(), scheduledAt, message,
    };
    await this.record(wakeup, "created");
    this.scheduler.add(wakeup);
    return wakeup;
  }

  list(): Wakeup[] {
    return this.scheduler.list();
  }

  async cancel(wakeupId: string): Promise<Wakeup> {
    const wakeup = this.scheduler.cancel(wakeupId);
    if (!wakeup) throw new Error("Wakeup is not pending in this server process; it may have fired, been cancelled, or been lost on restart");
    try {
      await this.record(wakeup, "cancelled");
    } catch (error) {
      throw new Error(`Wakeup ${wakeupId} was cancelled in memory, but its history could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    return wakeup;
  }

  async history(sessionId: string) {
    const entries = await this.sessions.read(sessionId);
    return wakeupHistory(entries, this.list(), sessionId);
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  private record(wakeup: Wakeup, event: WakeupEvent, error?: string): Promise<void> {
    return this.sessions.append({
      ...wakeup, version: 1, event, recordedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    });
  }
}

/** Validate only at the model-tool boundary; the scheduler accepts normalized times. */
function wakeupTime(input: ScheduleWakeupInput, now: number): string {
  if ((input.after_seconds === undefined) === (input.at === undefined)) {
    throw new Error("Specify exactly one of after_seconds or at");
  }
  let timestamp: number;
  if (input.after_seconds !== undefined) {
    if (!Number.isFinite(input.after_seconds) || input.after_seconds <= 0) {
      throw new Error("after_seconds must be a positive finite number");
    }
    timestamp = now + input.after_seconds * 1000;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at!)) {
      throw new Error("at must be an ISO 8601 timestamp with an explicit timezone, e.g. 2026-11-01T09:00:00+08:00");
    }
    const date = input.at!.slice(0, 10);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
      throw new Error("at contains an invalid calendar date");
    }
    timestamp = Date.parse(input.at!);
  }
  timestamp = Math.trunc(timestamp);
  if (!Number.isFinite(timestamp) || timestamp > 8_640_000_000_000_000 || timestamp <= now) {
    throw new Error("Wakeup time must be a valid future time");
  }
  return new Date(timestamp).toISOString();
}
