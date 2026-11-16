import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { reportImError } from "./telemetry";
import type { ImAttachment, ImDriver, ImDriverOptions, ImInbound, WeixinCredentials } from "./types";
import { prepareWeixinInput, weixinInputText } from "./weixin-inbound";
import { downloadWeixinAttachment, uploadWeixinAttachment } from "./weixin-media";
import { WEIXIN_BASE_INFO, WeixinError, weixinAbort, weixinRecord, weixinRequest, weixinString, weixinUrl } from "./weixin-transport";

function chunks(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let end = Math.min(offset + 1800, chars.length);
    if (end < chars.length) {
      for (let i = end - 1; i >= offset + 900; i--) {
        if (/\s/.test(chars[i])) { end = i + 1; break; }
      }
    }
    result.push(chars.slice(offset, end).join(""));
    offset = end;
  }
  return result;
}

/** Only platform requests and the fixed IM callbacks; no Pi host imports. */
export function createWeixinDriver(options: ImDriverOptions): ImDriver {
  const { bot, fetchImpl = fetch, onMessage, onStatus, saveCheckpoint } = options;
  const credentials = bot.credentials as WeixinCredentials;
  const validCredentials = bot.channel === "weixin" && weixinString(credentials.token)
    && weixinString(credentials.accountId) && weixinString(credentials.ownerUserId);
  const identity = createHash("sha256").update(JSON.stringify([
    credentials.token, credentials.accountId, credentials.ownerUserId,
  ])).digest("hex");
  const stored = weixinRecord(options.checkpoint.weixin);
  const restored = stored.identity === identity ? stored : {};
  let cursor = typeof restored.cursor === "string" ? restored.cursor : "";
  const contexts = new Map<string, string>();
  const restoredToken = weixinRecord(restored.contexts)[credentials.ownerUserId];
  if (typeof restoredToken === "string" && restoredToken) contexts.set(credentials.ownerUserId, restoredToken);
  const seen = new Set<string>(Array.isArray(restored.seenIds)
    ? restored.seenIds.filter((id): id is string => typeof id === "string").slice(-200) : []);
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  let sendQueue = Promise.resolve();
  let stopping: Promise<void> | undefined;
  let typingController: AbortController | undefined;
  let typingTask = Promise.resolve();

  async function persist(nextCursor = cursor): Promise<void> {
    await saveCheckpoint({
      ...options.checkpoint,
      weixin: { identity, cursor: nextCursor, contexts: Object.fromEntries(contexts), seenIds: [...seen] },
    });
    cursor = nextCursor;
  }

  async function showTyping(signal: AbortSignal): Promise<void> {
    let ticket = "";
    const sendStatus = (status: 1 | 2, requestSignal?: AbortSignal) => weixinRequest({
      fetchImpl, baseUrl: credentials.baseUrl, endpoint: "ilink/bot/sendtyping",
      token: credentials.token, signal: requestSignal, timeoutMs: 10_000, allowEmptyResponse: true,
      body: { ilink_user_id: credentials.ownerUserId, typing_ticket: ticket, status, base_info: WEIXIN_BASE_INFO },
    });
    try {
      signal.throwIfAborted();
      const config = await weixinRequest({
        fetchImpl, baseUrl: credentials.baseUrl, endpoint: "ilink/bot/getconfig",
        token: credentials.token, signal, timeoutMs: 10_000,
        body: { ilink_user_id: credentials.ownerUserId, context_token: contexts.get(credentials.ownerUserId), base_info: WEIXIN_BASE_INFO },
      });
      ticket = weixinString(config.typing_ticket);
      if (!ticket) return;
      while (!signal.aborted) {
        await sendStatus(1, signal);
        await delay(5000, undefined, { signal });
      }
    } catch {
      if (!signal.aborted) reportImError("typing", { channel: "weixin", botId: bot.id });
    } finally {
      if (ticket) {
        try {
          // Cancellation must finish before the next indicator starts, including on driver stop.
          await sendStatus(2);
        } catch {
          reportImError("typing-stop", { channel: "weixin", botId: bot.id });
        }
      }
    }
  }

  async function accept(raw: unknown, signal: AbortSignal): Promise<void> {
    const msg = weixinRecord(raw);
    const senderId = msg.from_user_id;
    // Filter before touching context tokens or constructing an inbound message.
    if (senderId !== credentials.ownerUserId || msg.message_type !== 1
      || (msg.to_user_id !== undefined && msg.to_user_id !== credentials.accountId)) return;
    const id = typeof msg.message_id === "string" || typeof msg.message_id === "number"
      ? String(msg.message_id) : "";
    if (id && seen.has(id)) return;
    const token = weixinString(msg.context_token);
    if (token && contexts.get(senderId) !== token) {
      contexts.set(senderId, token);
      await persist();
    }
    if (signal.aborted || !id) return;
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    const text = weixinInputText(items);
    if (!text && !items.some((item) => [2, 3, 4, 5].includes(Number(weixinRecord(item).type)))) return;
    const input: ImInbound = { id, chatId: senderId, senderId, text, isGroup: false };
    // Admit before downloading so long-polling and /stop remain responsive.
    await onMessage(input, (taskSignal) => prepareWeixinInput(input, items, (item) => downloadWeixinAttachment(item, {
      bot, fetchImpl, signal: taskSignal, mediaDirectory: options.mediaDirectory,
    }), taskSignal, bot.id));
    seen.add(id);
    while (seen.size > 200) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    await persist();
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    try {
      if (!validCredentials) throw new WeixinError("credentials", "微信凭据不完整，请重新扫码。");
      weixinUrl(credentials.baseUrl);
      while (!signal.aborted) {
        try {
          const response = await weixinRequest({
            fetchImpl, baseUrl: credentials.baseUrl, endpoint: "ilink/bot/getupdates",
            token: credentials.token, signal, timeoutMs: 35_000,
            body: { get_updates_buf: cursor, base_info: WEIXIN_BASE_INFO },
          });
          if (signal.aborted) return;
          onStatus({ state: "connected" });
          const messages = response.msgs;
          if (messages !== undefined && !Array.isArray(messages)) {
            throw new WeixinError("response", "微信消息响应无效。");
          }
          for (const message of messages ?? []) {
            if (signal.aborted) return;
            await accept(message, signal);
          }
          if (signal.aborted) return;
          if (typeof response.get_updates_buf === "string" && response.get_updates_buf) {
            await persist(response.get_updates_buf);
          }
          failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          // An empty long-poll timeout is expected; keep the current cursor.
          if (error instanceof WeixinError && error.code === "timeout") continue;
          const safe = error instanceof WeixinError ? error.message : "微信消息接收失败。";
          onStatus({ state: "error", error: safe });
          if (error instanceof WeixinError && ["login", "address", "credentials"].includes(error.code)) return;
          await delay(Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000), undefined, { signal });
          if (!signal.aborted) onStatus({ state: "connecting" });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        onStatus({ state: "error", error: error instanceof WeixinError ? error.message : "微信连接失败。" });
      }
    }
  }

  function replyContext(message: ImInbound, signal?: AbortSignal): string {
    if (!signal || signal.aborted) throw weixinAbort();
    if (message.chatId !== credentials.ownerUserId || message.senderId !== credentials.ownerUserId
      || message.isGroup || message.threadId) throw new WeixinError("recipient", "微信消息接收者无效。");
    const token = contexts.get(message.chatId);
    if (!token) throw new WeixinError("context", "请先向微信机器人发送消息后再回复。");
    return token;
  }

  async function sendItem(message: ImInbound, item: Record<string, unknown>, contextToken: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // Never retry an uncertain send: iLink does not promise client_id deduplication.
    await weixinRequest({
      fetchImpl, baseUrl: credentials.baseUrl, endpoint: "ilink/bot/sendmessage",
      token: credentials.token, signal,
      body: {
        msg: {
          from_user_id: "", to_user_id: message.chatId, client_id: `tsgw-weixin-${randomUUID()}`,
          message_type: 2, message_state: 2, item_list: [item], context_token: contextToken,
        },
        base_info: WEIXIN_BASE_INFO,
      },
    });
  }

  async function sendNow(message: ImInbound, text: string, signal?: AbortSignal): Promise<void> {
    if (!signal || signal.aborted) throw weixinAbort();
    const contextToken = replyContext(message, signal);
    for (const part of chunks(text)) await sendItem(message, { type: 1, text_item: { text: part } }, contextToken, signal);
  }

  async function sendAttachmentNow(message: ImInbound, attachment: ImAttachment, signal?: AbortSignal): Promise<void> {
    if (!signal || signal.aborted) throw weixinAbort();
    const contextToken = replyContext(message, signal);
    const item = await uploadWeixinAttachment(attachment, message, { bot, fetchImpl, signal });
    await sendItem(message, item, contextToken, signal);
  }

  return {
    start() {
      if (task || stopping || !bot.enabled) return;
      controller = new AbortController();
      onStatus({ state: "connecting" });
      const current = controller;
      task = run(current.signal).finally(() => {
        if (controller === current) { current.abort(); controller = undefined; }
        task = undefined;
      });
    },
    stop() {
      if (stopping) return stopping;
      controller?.abort();
      typingController?.abort();
      typingController = undefined;
      stopping = Promise.allSettled([task, sendQueue, typingTask]).then(() => {
        controller = undefined;
        onStatus({ state: "stopped" });
      }).finally(() => { stopping = undefined; });
      return stopping;
    },
    setTyping(message, active) {
      if (message.chatId !== credentials.ownerUserId || message.senderId !== credentials.ownerUserId) return;
      if (!active) {
        typingController?.abort();
        typingController = undefined;
      } else if (controller && !controller.signal.aborted && !typingController) {
        typingController = new AbortController();
        const signal = AbortSignal.any([controller.signal, typingController.signal]);
        typingTask = typingTask.then(() => showTyping(signal));
      }
    },
    sendAttachment(message, attachment, requestSignal) {
      const driverSignal = controller?.signal;
      const signal = driverSignal && requestSignal ? AbortSignal.any([driverSignal, requestSignal]) : driverSignal;
      const result = sendQueue.then(() => sendAttachmentNow(message, attachment, signal));
      sendQueue = result.catch(() => undefined);
      return result;
    },
    send(message, text) {
      const signal = controller?.signal;
      const result = sendQueue.then(() => sendNow(message, text, signal));
      sendQueue = result.catch(() => undefined);
      return result;
    },
  };
}
