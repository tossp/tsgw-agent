/**
 * One-shot, in-memory wakeups. When a wakeup's scheduled time arrives, the
 * scheduler hands it to `onFire` exactly once and forgets it; a callback that
 * fails has already consumed its wakeup and is never retried. Nothing is
 * persisted: a process restart drops everything still armed. The session
 * runtime owns validation, persistence and what a fired wakeup means.
 */
export type Wakeup = {
  wakeupId: string;
  sourceSessionId: string;
  targetSessionId: string;
  createdAt: string;
  scheduledAt: string;
  message: string;
};

/**
 * `setTimeout` fires after 1 ms for a delay above 2^31-1 ms, so a far-off
 * wakeup is re-armed in steps of at most this (about 24.8 days) and re-reads
 * the clock on every step. Users may schedule as far out as they like.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ArmedWakeup {
  wakeup: Wakeup;
  timeout: ReturnType<typeof setTimeout>;
}

export class WakeupScheduler {
  private readonly onFire: (wakeup: Wakeup) => Promise<void>;
  private readonly armed = new Map<string, ArmedWakeup>();

  constructor(onFire: (wakeup: Wakeup) => Promise<void>) {
    this.onFire = onFire;
  }

  /** Arms a wakeup; adding an id that is already armed replaces its wakeup. */
  add(wakeup: Wakeup): void {
    this.clear(wakeup.wakeupId);
    this.arm(wakeup);
  }

  /** Drops a wakeup that has not fired yet; a fired one is already gone. */
  cancel(wakeupId: string): Wakeup | undefined {
    const armed = this.armed.get(wakeupId);
    if (!armed) return undefined;
    this.clear(wakeupId);
    return armed.wakeup;
  }

  list(): Wakeup[] {
    return [...this.armed.values()].map((armed) => armed.wakeup);
  }

  has(wakeupId: string): boolean {
    return this.armed.has(wakeupId);
  }

  /** Drops every armed wakeup: tests, and process exit. Not a session shutdown. */
  dispose(): void {
    for (const wakeupId of [...this.armed.keys()]) this.clear(wakeupId);
  }

  private clear(wakeupId: string): void {
    const armed = this.armed.get(wakeupId);
    if (!armed) return;
    clearTimeout(armed.timeout);
    this.armed.delete(wakeupId);
  }

  private arm(wakeup: Wakeup): void {
    const remaining = Date.parse(wakeup.scheduledAt) - Date.now();
    const timeout = setTimeout(() => {
      // A step of a chunked wait ended: the wakeup is due only once the clock
      // says so, and an early step (a clock that moved back included) waits again.
      if (Date.parse(wakeup.scheduledAt) - Date.now() > 0) {
        this.arm(wakeup);
        return;
      }
      // Out of the map before the callback: it is one call, and they cannot
      // cancel or re-find a wakeup that already fired.
      this.armed.delete(wakeup.wakeupId);
      this.fire(wakeup);
    }, Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)));
    // A wakeup belongs to no session: it must not hold a closing process open.
    timeout.unref();
    this.armed.set(wakeup.wakeupId, { wakeup, timeout });
  }

  private fire(wakeup: Wakeup): void {
    const failed = (error: unknown) => {
      console.error(`wakeup ${wakeup.wakeupId} failed`, error);
    };
    // A rejection is logged, not an unhandled rejection, and never retried.
    try {
      void Promise.resolve(this.onFire(wakeup)).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
