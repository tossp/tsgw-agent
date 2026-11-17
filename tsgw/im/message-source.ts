import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImReplyCapabilities } from "./types";
import { IM_MESSAGE_SOURCE_TYPE, imRequestId, withImMessageSource, type ImMessageSource } from "./message-data";

type Manager = Pick<SessionManager, "getLeafEntry" | "appendCustomEntry">;
interface PendingSource { source: ImMessageSource; replyCapabilities: ImReplyCapabilities; recorded: boolean }
const KEY = Symbol.for("pi-web.im.messageSources");
type SourceGlobal = typeof globalThis & { [KEY]?: WeakMap<object, Map<string, PendingSource>> };
const pending = ((globalThis as SourceGlobal)[KEY] ??= new WeakMap());

/** This is the existing wrapper's manager, never a second owner of its file. */
export function registerImMessageSource(manager: Manager, source: ImMessageSource, replyCapabilities: ImReplyCapabilities = { attachments: false }): () => void {
  let requests = pending.get(manager);
  if (!requests) pending.set(manager, requests = new Map());
  requests.set(source.requestId, { source, replyCapabilities, recorded: false });
  return () => {
    requests.delete(source.requestId);
    if (!requests.size) pending.delete(manager);
  };
}

/** Project after Pi's transforms so exact prompts and dynamic tool instructions remain intact. */
export function installImRequestContextProjection(session: Pick<AgentSession, "agent" | "sessionManager">): void {
  const previous = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const transformed = previous ? await previous(messages, signal) : messages;
    const requests = pending.get(session.sessionManager);
    if (!requests) return transformed;
    // Use the untransformed current input: context extensions may trim its internal marker.
    const lastUser = messages.findLast((message) => message.role === "user");
    const requestId = lastUser?.role === "user" ? imRequestId(lastUser.content) : undefined;
    const request = requestId ? requests.get(requestId) : undefined;
    if (!request) return transformed;
    const { source, replyCapabilities } = request;
    let conversation = "unknown";
    if (source.threadId !== undefined) conversation = "topic";
    else if (source.isGroup !== undefined) conversation = source.isGroup ? "group" : "private";
    const context = {
      channel: source.channel, conversation,
      replyCapabilities: { text: true, attachments: replyCapabilities.attachments },
    };
    const instructions = [
      `<im_request_context>\n${JSON.stringify(context)}\n</im_request_context>`,
      "以上是本次请求的渠道与回复能力。最终答复由宿主回到发起请求的原聊天或 Topic，无需额外调用发送工具；同一 Pi 会话的其他消息可能来自 Web 或其他渠道，不自动广播。不要把渠道说明复述给用户。",
      replyCapabilities.attachments
        ? "需要交付图片或文件时，在最终答复中写明确的本地 Markdown 图片或文件链接，优先使用绝对路径。宿主仅发送最终答复显式引用的本地附件。"
        : "本次渠道仅支持最终文字回复，不能通过本地文件链接交付附件；需要交付文件时如实说明当前渠道限制。",
    ].join("\n\n");
    const head = transformed[0];
    const system = head?.role === "system"
      ? { ...head }
      : { role: "system" as const, content: "", timestamp: Date.now() };
    if (typeof system.content === "string") system.content = [system.content, instructions].filter(Boolean).join("\n\n");
    else system.content = [...system.content, { type: "text", text: `\n\n${instructions}` }];
    return [system, ...transformed.slice(head?.role === "system" ? 1 : 0)];
  };
}

/** Add Web-only fields without mutating the SDK message or extension event. */
export function withLiveImMessageSource<E extends { type: string; message?: unknown }>(event: E, manager: Manager): E {
  if (event.type !== "message_start" && event.type !== "message_end") return event;
  const message = event.message as { role?: string; content?: unknown } | undefined;
  if (message?.role !== "user") return event;
  const id = imRequestId(message.content);
  const request = id ? pending.get(manager)?.get(id) : undefined;
  if (!request) return event;
  if (event.type === "message_end" && !request.recorded) {
    request.recorded = true;
    // Pi 1.5 emits message_end BEFORE appendMessage, in the same synchronous stack.
    // The microtask runs after that append, before the next model/tool event.
    queueMicrotask(() => {
      try {
        const entry = manager.getLeafEntry();
        if (entry?.type !== "message" || entry.message !== message) {
          throw new Error("IM input was not appended at the current leaf");
        }
        manager.appendCustomEntry(IM_MESSAGE_SOURCE_TYPE, {
          version: 1, messageEntryId: entry.id, source: request.source,
        });
      } catch {
        // The prompt may already be accepted: a provenance failure must not invite a retry.
        console.error("[pi-web] IM input accepted but its source metadata could not be written.");
      }
    });
  }
  return { ...event, message: withImMessageSource({ ...message, role: "user", content: message.content }, request.source) };
}
