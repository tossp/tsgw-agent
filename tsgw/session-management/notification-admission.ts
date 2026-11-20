import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "../../lib/rpc-manager";

export type NotificationWrapper = Pick<AgentSessionWrapper,
  "isAlive" | "beginCustomMessageSubmission" | "acquirePromptAdmission" | "prepareMcpForRun" | "shellRunning">
  & { inner: Pick<AgentSession, "isCompacting" | "isStreaming"> };

export async function withNotificationAdmission<T>(wrapper: NotificationWrapper, {
  signal,
  assertCanSubmit = () => signal.throwIfAborted(),
  beforeMcp,
}: { signal: AbortSignal; assertCanSubmit?(): void; beforeMcp?(): void }, submit: () => T | Promise<T>): Promise<T> {
  assertCanSubmit();
  const finishSubmission = wrapper.beginCustomMessageSubmission();
  try {
    const releaseAdmission = await wrapper.acquirePromptAdmission();
    try {
      assertCanSubmit();
      if (!wrapper.isAlive()) throw new Error("Session closed before notification delivery");
      beforeMcp?.();
      if (!await wrapper.prepareMcpForRun(signal)) throw new DOMException("Notification stopped while MCP servers were connecting", "AbortError");
      // A streaming follow-up can queue beside !bash. An idle submission needs the
      // shell and its hooks to finish. Never wait for parked prompts holding this lock.
      while (wrapper.isAlive() && (wrapper.inner.isCompacting || (!wrapper.inner.isStreaming && wrapper.shellRunning))) {
        await delay(50, undefined, { signal });
      }
      assertCanSubmit();
      if (!wrapper.isAlive()) throw new Error("Session closed before notification delivery");
      return await submit();
    } finally {
      releaseAdmission();
    }
  } finally {
    finishSubmission();
  }
}
