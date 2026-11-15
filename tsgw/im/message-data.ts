export const IM_MESSAGE_SOURCE_TYPE = "pi-web:im-source";

/** Routing facts for one accepted IM input; never contains platform credentials. */
export interface ImMessageSource {
  requestId: string;
  channel: "weixin" | "telegram";
  botId: string;
  botName: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  messageId: string;
}

export type ImInputSource = Omit<ImMessageSource, "requestId">;

export interface ImMessageSourceRecord {
  version: 1;
  messageEntryId: string;
  source: ImMessageSource;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Validate persisted custom data once at the session-file boundary. */
export function readImMessageSource(value: unknown): ImMessageSourceRecord | undefined {
  const data = object(value);
  const source = object(data?.source);
  if (data?.version !== 1 || typeof data.messageEntryId !== "string" || !data.messageEntryId || !source
    || (source.channel !== "weixin" && source.channel !== "telegram")) return;
  for (const field of ["requestId", "botId", "botName", "chatId", "senderId", "messageId"]) {
    if (typeof source[field] !== "string" || !source[field]) return;
  }
  if (source.threadId !== undefined && typeof source.threadId !== "string") return;
  return {
    version: 1, messageEntryId: data.messageEntryId,
    source: {
      requestId: source.requestId as string, channel: source.channel,
      botId: source.botId as string, botName: source.botName as string,
      chatId: source.chatId as string, senderId: source.senderId as string,
      messageId: source.messageId as string,
      ...(source.threadId === undefined ? {} : { threadId: source.threadId as string }),
    },
  };
}

/** Inspect the complete entry set: a history page can end before its metadata. */
export function imMessageSources(entries: readonly { type: string; customType?: string; data?: unknown }[]): Map<string, ImMessageSource> {
  const sources = new Map<string, ImMessageSource>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== IM_MESSAGE_SOURCE_TYPE) continue;
    const data = readImMessageSource(entry.data);
    if (data) sources.set(data.messageEntryId, data.source);
  }
  return sources;
}

interface ImForkEntry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  message?: { role: string };
}

/** A fork ending on a user can cut off its following source metadata. */
export function missingImForkSources(
  sourceEntries: readonly ImForkEntry[],
  copiedEntries: readonly ImForkEntry[],
): ImMessageSourceRecord[] {
  const sources = imMessageSources(sourceEntries);
  const copiedSources = imMessageSources(copiedEntries);
  const missing: ImMessageSourceRecord[] = [];
  for (const entry of copiedEntries) {
    if (entry.type !== "message" || entry.message?.role !== "user" || copiedSources.has(entry.id)) continue;
    const source = sources.get(entry.id);
    if (source) missing.push({ version: 1, messageEntryId: entry.id, source });
  }
  return missing;
}

export function imRequestId(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.find((block) => object(block)?.type === "text")?.text : undefined;
  return typeof text === "string" ? /^\[IM request ([0-9a-f-]+)\]\n/.exec(text)?.[1] : undefined;
}

/** The SDK keeps its admission marker; only the Web projection omits it. */
export function withImMessageSource<T extends { role: string; content: unknown }>(message: T, source?: ImMessageSource): T {
  if (message.role !== "user" || !source) return message;
  const prefix = `[IM request ${source.requestId}]\n`;
  const clean = (text: string) => text.startsWith(prefix) ? text.slice(prefix.length) : text;
  let firstText = true;
  const content = typeof message.content === "string" ? clean(message.content)
    : Array.isArray(message.content) ? message.content.map((block: unknown) => {
      const value = object(block);
      if (!firstText || value?.type !== "text" || typeof value.text !== "string") return block;
      firstText = false;
      return { ...value, text: clean(value.text) };
    }) : message.content;
  return { ...message, content, imSource: source };
}
