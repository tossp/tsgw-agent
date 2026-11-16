import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentSessionWrapper } from "../../lib/rpc-manager";

export type PiPromptWrapper = Pick<AgentSessionWrapper, "send" | "onEvent" | "isAlive" | "isRunning">;
const unavailable = () => new Error("Pi 会话已关闭，请重试。");
const interrupted = () => new Error("会话收到其他消息，无法安全确认本次回复；请查看 Pi 会话后重试。");
const cancelled = () => new DOMException("IM host stopped", "AbortError");

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Observe the existing wrapper; cancellation never aborts its shared Web task. */
export function waitForPiIdle(wrapper: PiPromptWrapper, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(cancelled());
    const check = () => {
      if (signal.aborted) finish(cancelled());
      else if (!wrapper.isAlive()) finish(unavailable());
      else if (!wrapper.isRunning()) finish();
    };
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = wrapper.onEvent(() => queueMicrotask(check));
    const timer = setInterval(check, 100);
    check();
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((value) => {
    const block = record(value);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}

/** A request's last complete assistant message, never concatenated tool-step prose. */
export class PiAnswerCollector {
  private owned = false;
  private ownUserEnded = false;
  private answer: Record<string, unknown> | undefined;
  private settled = false;
  private awaitingChildren = false;
  private done = false;
  private failure: Error | undefined;

  constructor(private readonly marker: string) {}

  accept(event: AgentEvent): void {
    if (this.done || this.failure) return;
    const message = record(event.message);
    if ((event.type === "message_start" || event.type === "message_end") && message?.role === "user") {
      const source = record(message.imSource);
      const ours = source ? `[IM request ${source.requestId}]` === this.marker
        : contentText(message.content).includes(this.marker);
      if (!ours || (this.owned && (event.type === "message_start" || this.ownUserEnded))) {
        this.failure = interrupted();
        return;
      }
      this.owned = true;
      if (event.type === "message_end") this.ownUserEnded = true;
    }
    if (event.type === "session_ended") this.failure = unavailable();
    // Errors may contain provider URLs or credentials. Return a fixed host error only.
    if (event.type === "prompt_error") this.failure = new Error("Pi 请求失败，请查看 Pi 会话。");
    if (!this.owned) {
      if (event.type === "prompt_done") this.failure = new Error("未能确认 IM 入站消息；扩展可能已处理或改写输入，请查看 Pi 会话。");
      return;
    }
    if (event.type === "agent_start" && this.settled && !this.awaitingChildren) {
      this.failure = interrupted();
      return;
    }
    if (event.type === "agent_start") {
      this.settled = false;
      this.answer = undefined;
    }
    if (event.type === "message_end" && message?.role === "assistant" && !this.settled) {
      this.answer = message;
    }
    if (event.type === "agent_settled" || event.type === "prompt_done") {
      if (event.aborted === true) {
        this.failure = new DOMException("Pi 任务已停止。", "AbortError");
        return;
      }
      this.settled = true;
      this.awaitingChildren = event.subagentsActive === true;
      // prompt_done can trail agent_settled. Keep listening until the wrapper is idle.
      this.done = event.type === "prompt_done" && !this.awaitingChildren;
    }
  }

  result(idle: boolean): string | undefined {
    if (this.failure) throw this.failure;
    if (!idle || !this.owned || !this.settled || this.awaitingChildren) return undefined;
    const answer = this.answer;
    if (answer?.stopReason === "aborted") throw new DOMException("Pi 任务已停止。", "AbortError");
    if (!answer || answer.stopReason === "error"
      || answer.stopReason === "length" || answer.stopReason === "toolUse" || (Array.isArray(answer.content)
        && answer.content.some((block) => record(block)?.type === "toolCall"))) {
      throw new Error("Pi 未产生完整的最终文本回复，请查看 Pi 会话。");
    }
    const text = contentText(answer.content).trim();
    if (!text) throw new Error("Pi 未产生最终文本回复，请查看 Pi 会话。");
    return text;
  }
}

/** Subscribe before dispatch: synchronous user/message events must not be missed. */
export function sendPiPrompt(wrapper: PiPromptWrapper, text: string, marker: string, signal: AbortSignal, images?: ImageContent[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const collector = new PiAnswerCollector(marker);
    let unsubscribe = () => {};
    let finished = false;
    let accepted = false;
    const finish = (error?: Error, answer = "") => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(answer);
    };
    const abort = () => finish(cancelled());
    const check = () => {
      if (finished) return;
      if (signal.aborted) return abort();
      if (!wrapper.isAlive()) return finish(unavailable());
      try {
        const answer = collector.result(accepted && !wrapper.isRunning());
        if (answer !== undefined) finish(undefined, answer);
      } catch (error) {
        finish(error as Error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = wrapper.onEvent((event) => {
      collector.accept(event);
      queueMicrotask(check);
    });
    const timer = setInterval(check, 100);
    check();
    if (finished) return;
    // No streamingBehavior: a Web prompt winning admission must cause a busy refusal.
    void wrapper.send({ type: "prompt", message: text, ...(images?.length ? { images } : {}) }).then(() => {
      accepted = true;
      check();
    }, () => finish(new Error("Pi 暂时无法接收请求；请查看会话状态后重试。")));
  });
}
