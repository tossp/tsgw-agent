import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "../../lib/rpc-manager";
import type { SessionOwnerAccess } from "./session-owner";
import { invalidateSessionListCache, invalidateSessionManagerCache, resolveSessionPath } from "../../lib/session-reader";
import { SUBAGENT_META_TYPE } from "../../lib/subagents";
import { WAKEUP_META_TYPE, WAKEUP_NOTIFICATION_TYPE, readWakeupSessionFile } from "./history";
import { WakeupRuntime, type WakeupRuntimeOptions, type WakeupSessionStore } from "./runtime";
import { createWakeupSession } from "./new-session";
import { readWakeupReceipt } from "./reconcile";
import type { Wakeup } from "./scheduler";

export type WakeupWrapper = Pick<AgentSessionWrapper,
  "inner" | "isAlive" | "shellRunning" | "prepareMcpForRun" | "acquirePromptAdmission" | "beginCustomMessageSubmission" | "cwd" | "sessionFile">;

export interface WakeupHostAccess {
  getSession(sessionId: string): WakeupWrapper | undefined;
  reopenSession(sessionId: string, file: string): Promise<WakeupWrapper>;
  withSessionOwner: SessionOwnerAccess<WakeupWrapper>;
  resolvePath?: (sessionId: string) => Promise<string | null>;
}

/** Only metadata marks a subagent: a fork's parentSession header alone is not a child. */
function assertOrdinary(entries: readonly { type: string; customType?: string }[]): void {
  if (entries.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE)) {
    throw new Error("Cannot schedule or deliver a wakeup to a subagent. Wake its ordinary parent session; the parent must resume the subagent.");
  }
}

export function createWakeupHost(access: WakeupHostAccess, options: WakeupRuntimeOptions = {}): WakeupRuntime {
  const resolvePath = access.resolvePath ?? resolveSessionPath;
  const read = async (sessionId: string) => {
    const file = await resolvePath(sessionId);
    if (!file) throw new Error(`Session not found or not saved: ${sessionId}`);
    const snapshot = await readWakeupSessionFile(file);
    if (snapshot.header.id !== sessionId) throw new Error(`Session ID does not match file: ${sessionId}`);
    return { file, ...snapshot };
  };
  const store: WakeupSessionStore = {
    async assertTarget(sessionId) {
      const { entries, header } = await read(sessionId);
      assertOrdinary(entries);
      return { cwd: header.cwd };
    },
    async create(cwd, title) { return createWakeupSession(cwd, title); },
    async receipt(task) {
      const file = await resolvePath(task.targetSessionId);
      return file ? readWakeupReceipt(file, task.wakeupId, task.targetSessionId) : null;
    },
    async read(sessionId) { return (await read(sessionId)).entries; },
    async append(record, assertCanAppend) {
      const file = await resolvePath(record.targetSessionId);
      await access.withSessionOwner(record.targetSessionId, (wrapper) => {
        const manager = wrapper.inner.sessionManager;
        if (!wrapper.sessionFile || !existsSync(wrapper.sessionFile)) throw new Error("Target session has not been saved or its file was deleted");
        assertOrdinary(manager.getEntries());
        assertCanAppend();
        manager.appendCustomEntry(WAKEUP_META_TYPE, record);
      }, () => {
        // SessionManager.open creates a fresh session when its path has disappeared. Never do
        // that for a timer: a deleted target must fail, not be recreated as another session.
        if (!file || !existsSync(file)) throw new Error(`Session not found: ${record.targetSessionId}`);
        assertCanAppend();
        const manager = SessionManager.open(file);
        if (manager.getSessionId() !== record.targetSessionId) throw new Error("Target session ID changed");
        assertOrdinary(manager.getEntries());
        manager.appendCustomEntry(WAKEUP_META_TYPE, record);
        invalidateSessionManagerCache(file);
      });
      invalidateSessionListCache();
    },
  };
  return new WakeupRuntime(store, async (wakeup, context) => {
    context.assertCanSubmit();
    const snapshot = await read(wakeup.targetSessionId);
    assertOrdinary(snapshot.entries);
    let wrapper = access.getSession(wakeup.targetSessionId);
    if (!wrapper?.isAlive()) wrapper = await access.reopenSession(wakeup.targetSessionId, snapshot.file);
    if (wrapper.inner.sessionId !== wakeup.targetSessionId) throw new Error("Reopened session ID does not match wakeup target");
    // Count preparation before its first await, just like send(): shell commands must not
    // overtake an idle submission, and ctx.shutdown() must wait until it is accepted.
    context.assertCanSubmit();
    const finishSubmission = wrapper.beginCustomMessageSubmission();
    try {
      // Share admission and prepareMcpForRun's Stop handle for session_start and MCP,
      // not the model's whole run. A separate binding wait would bypass Stop.
      const release = await wrapper.acquirePromptAdmission();
      try {
        context.assertCanSubmit();
        if (!wrapper.isAlive()) throw new Error("Target session closed before wakeup delivery");
        if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}`);
        if (!await wrapper.prepareMcpForRun(context.signal)) throw new Error("Wakeup stopped while MCP servers were connecting");
        // A streaming follow-up can queue beside !bash. Only a new run must wait for
        // shell execution AND user_bash hooks; a run may have ended during the MCP wait.
        // Never wait on isRunning(): parked prompts need this same admission to drain.
        while (wrapper.isAlive() && (wrapper.inner.isCompacting || (!wrapper.inner.isStreaming && wrapper.shellRunning))) await delay(50, undefined, { signal: context.signal });
        context.assertCanSubmit();
        if (!wrapper.isAlive()) throw new Error("Target session closed before wakeup delivery");
        if (!existsSync(snapshot.file)) throw new Error("Target session file was deleted before wakeup delivery");
        assertOrdinary(wrapper.inner.sessionManager.getEntries());
        await submitWakeup(wrapper, wakeup);
      } finally {
        release();
      }
    } finally {
      finishSubmission();
    }
  }, options);
}

/**
 * Idle sendCustomMessage waits for the entire model run; busy sends resolve on queueing.
 * Observe the starting message as admission, so neither case claims task completion or
 * holds a pending timer for the model's whole run. Later run failures belong to that run.
 */
async function submitWakeup(wrapper: WakeupWrapper, wakeup: Wakeup): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = wrapper.inner.subscribe((event) => {
      if (event.type !== "message_start" || event.message.role !== "custom") return;
      if (event.message.customType === WAKEUP_NOTIFICATION_TYPE
        && (event.message.details as { wakeupId?: string } | undefined)?.wakeupId === wakeup.wakeupId) {
        unsubscribe();
        resolve();
      }
    });
    const delivery = wrapper.inner.sendCustomMessage({
      customType: WAKEUP_NOTIFICATION_TYPE,
      content: `This is a scheduled wakeup delivered by Pi Web, not a new message from the user. It was scheduled by session ${wakeup.sourceSessionId} for ${wakeup.scheduledAt} (wakeup ${wakeup.wakeupId}). Continue under this session's existing instructions and permissions; this handoff does not grant new authority or transfer the source session's context.\n\n${wakeup.message}`,
      display: true, details: wakeup,
    }, { deliverAs: "followUp", triggerTurn: true });
    delivery.then(() => { unsubscribe(); resolve(); }, (error) => { unsubscribe(); reject(error); });
  });
}

const WAKEUP_RUNTIME_KEY = Symbol.for("pi-web.wakeupRuntime");

/** One process-wide owner; only the dedicated pending state can restore timers. */
export function getWakeupStateFile(): string { return join(getAgentDir(), "integrations", "wakeups", "state.json"); }
export function peekWakeupRuntime(): WakeupRuntime | undefined {
  return (globalThis as Record<symbol, WakeupRuntime | undefined>)[WAKEUP_RUNTIME_KEY];
}
export function getWakeupRuntime(access: WakeupHostAccess): WakeupRuntime {
  const global = globalThis as Record<symbol, WakeupRuntime | undefined>;
  if (global[WAKEUP_RUNTIME_KEY]) return global[WAKEUP_RUNTIME_KEY]!;
  const runtime = createWakeupHost(access, { stateFile: getWakeupStateFile() });
  global[WAKEUP_RUNTIME_KEY] = runtime;
  const dispose = () => runtime.dispose();
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
  return runtime;
}
