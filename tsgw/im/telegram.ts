import { setTimeout as delay } from "node:timers/promises";
import type { ImDriver, ImDriverOptions, ImInbound } from "./types";
import { credentialFetch } from "./credential-fetch";

// Protocol/routing reference: xmanrui/dsh-im v5.10.0, telegram-runtime.mjs
// and telegram-api.mjs (MIT, Copyright (c) 2026 xmanrui).
interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string };
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
  reply_to_message?: { from?: TelegramUser };
  message_thread_id?: number;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function callApi<T>(
  token: string,
  method: "getMe" | "getUpdates" | "sendMessage",
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(method === "getUpdates" ? 35_000 : 15_000);
  try {
    const response = await credentialFetch(fetchImpl, `https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body?.ok !== true || body.result === undefined) throw new Error();
    return body.result as T;
  } catch {
    // Neither provider descriptions nor fetch errors are safe: either can contain
    // the credential-bearing URL. Do not attach the original error as a cause.
    throw new Error(`Telegram ${method} failed`);
  }
}

async function getIdentity(token: string, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const user = await callApi<TelegramUser>(token, "getMe", {}, fetchImpl, signal);
  if (!user || !Number.isSafeInteger(user.id) || user.is_bot !== true
    || typeof user.username !== "string" || !/^[a-z0-9_]+$/i.test(user.username)) {
    throw new Error("Telegram getMe returned an invalid bot identity");
  }
  return { id: user.id, username: user.username };
}

export async function verifyTelegramToken(
  token: string, fetchImpl: typeof fetch = fetch,
): Promise<{ username: string }> {
  const { username } = await getIdentity(token, fetchImpl);
  return { username };
}

function inbound(
  update: TelegramUpdate, options: ImDriverOptions, identity: { id: number; username: string },
): ImInbound | null {
  const message = update.message;
  if (!message?.from || message.from.is_bot || typeof message.text !== "string") return null;
  const senderId = String(message.from.id);
  const chatId = String(message.chat.id);
  if (!options.bot.allowedUserIds.includes(senderId)) return null;
  if (options.bot.allowedChatIds.length && !options.bot.allowedChatIds.includes(chatId)) return null;
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isGroup && message.chat.type !== "private") return null;

  const username = identity.username.toLowerCase();
  const originalText = message.text;
  const mentions = (message.entities ?? []).filter((entity) => entity.type === "mention"
    && Number.isInteger(entity.offset) && entity.offset >= 0
    && Number.isInteger(entity.length) && entity.length > 0
    && originalText.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`);
  let text = originalText;
  for (const entity of mentions.sort((a, b) => b.offset - a.offset)) {
    text = text.slice(0, entity.offset) + text.slice(entity.offset + entity.length);
  }
  text = text.trim();
  const command = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  if (command?.[2] && command[2].toLowerCase() !== username) return null;
  const addressed = mentions.length > 0 || command?.[2]?.toLowerCase() === username
    || message.reply_to_message?.from?.id === identity.id;
  if (isGroup && !addressed) return null;
  if (command?.[2]) text = text.replace(/^\/([a-z0-9_]+)@[a-z0-9_]+/i, "/$1");
  if (!text) return null;
  return {
    id: String(update.update_id), messageId: String(message.message_id), chatId, senderId, text, isGroup,
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
    ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
  };
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 4096, text.length);
    // Stay within the limit even in UTF-16 and preserve supplementary characters.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function createTelegramDriver(options: ImDriverOptions): ImDriver {
  if (options.bot.channel !== "telegram" || !("username" in options.bot.credentials)) {
    throw new Error("Telegram credentials required");
  }
  const { token } = options.bot.credentials;
  const fetchImpl = options.fetchImpl ?? fetch;
  let checkpoint = { ...options.checkpoint };
  let offset = Number.isSafeInteger(checkpoint.offset) && (checkpoint.offset as number) >= 0
    ? checkpoint.offset as number : 0;
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;

  async function reconnect(signal: AbortSignal) {
    try {
      await delay(1_000, undefined, { signal });
    } catch {
      return;
    }
    if (!signal.aborted) options.onStatus({ state: "connecting" });
  }

  async function accept(update: TelegramUpdate, identity: { id: number; username: string }, signal: AbortSignal) {
    const message = inbound(update, options, identity);
    let accepted = !message;
    while (!signal.aborted) {
      try {
        if (message && !accepted) {
          await options.onMessage(message);
          accepted = true;
        }
        // onMessage means runtime admission, not model completion. Persist only
        // after admission, before acknowledging via the next getUpdates offset.
        // On save failure retain admission in memory and retry only persistence.
        const next = { ...checkpoint, offset: update.update_id + 1 };
        await options.saveCheckpoint(next);
        checkpoint = next;
        offset = next.offset;
        if (!signal.aborted) options.onStatus({ state: "connected" });
        return;
      } catch {
        if (signal.aborted) return;
        options.onStatus({ state: "error", error: accepted
          ? "Telegram checkpoint save failed" : "Telegram message admission failed" });
        await reconnect(signal);
      }
    }
  }

  async function run(signal: AbortSignal) {
    let identity: { id: number; username: string } | undefined;
    try {
      while (!signal.aborted) {
        try {
          identity ??= await getIdentity(token, fetchImpl, signal);
          if (signal.aborted) break;
          options.onStatus({ state: "connected" });
          const updates = await callApi<TelegramUpdate[]>(token, "getUpdates", {
            offset, timeout: 25, limit: 100, allowed_updates: ["message"],
          }, fetchImpl, signal);
          if (signal.aborted) break;
          if (!Array.isArray(updates)) throw new Error();
          for (const update of updates) {
            if (signal.aborted) break;
            if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Error();
            if (update.update_id < offset) continue;
            await accept(update, identity, signal);
          }
        } catch {
          if (signal.aborted) break;
          options.onStatus({ state: "error", error: "Telegram polling failed" });
          await reconnect(signal);
        }
      }
    } finally {
      options.onStatus({ state: "stopped" });
    }
  }

  return {
    start() {
      if (task) return;
      if (!options.bot.enabled) {
        options.onStatus({ state: "stopped" });
        return;
      }
      controller = new AbortController();
      options.onStatus({ state: "connecting" });
      task = run(controller.signal).finally(() => { task = undefined; controller = undefined; });
    },
    async stop() {
      controller?.abort();
      if (task) await task;
      else options.onStatus({ state: "stopped" });
    },
    async send(message, text) {
      const signal = controller?.signal;
      if (!signal || signal.aborted) throw new Error("Telegram driver is stopped");
      if (!text.trim()) return;
      for (const chunk of splitText(text)) {
        if (signal.aborted) throw new Error("Telegram driver is stopped");
        // Sending is never retried: an ambiguous response may already be delivered.
        await callApi(token, "sendMessage", {
          chat_id: message.chatId, text: chunk,
          ...(message.threadId === undefined ? {} : { message_thread_id: Number(message.threadId) }),
        }, fetchImpl, signal);
      }
    },
  };
}
