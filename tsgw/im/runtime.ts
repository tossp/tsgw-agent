import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sessionDirectoryKey } from "../session-management";
import { getDocumentMime, getImageMime } from "../../lib/file-types";
import { reportImError } from "./telemetry";
import type { ImSessionHost } from "./host-types";
import type { ImReplyHandle } from "./notification";
import type { ImStore } from "./store";
import { WeixinError } from "./weixin-transport";
import type { ImBot, ImDriver, ImDriverOptions, ImDriverStatus, ImInbound, ImRecipient, ImSendItem, ImSnapshot, WeixinCredentials } from "./types";

export type ImDriverFactory = (options: ImDriverOptions) => ImDriver;
interface RunningBot {
  bot: ImBot;
  driver: ImDriver;
  controller: AbortController;
  status: ImDriverStatus;
  deliveryError?: string;
}

export function conversationKey(botId: string, message: Pick<ImInbound, "chatId" | "threadId">): string {
  return JSON.stringify([botId, message.chatId, message.threadId ?? null]);
}

export class ImRuntime {
  private running = new Map<string, RunningBot>();
  private queues = new Map<string, Promise<void>>();
  private chatWork = new Map<string, AbortController>();

  constructor(readonly store: ImStore, readonly host: ImSessionHost, private createDriver: ImDriverFactory) {}

  async start(): Promise<void> {
    const { bots } = await this.store.read();
    for (const bot of bots) if (bot.enabled && bot.channel === "weixin") await this.restart(bot.id);
  }

  async restart(botId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.stop(botId);
    const state = await this.store.read();
    signal?.throwIfAborted();
    const bot = state.bots.find((entry) => entry.id === botId);
    if (!bot?.enabled || bot.channel !== "weixin") return;
    const controller = new AbortController();
    const entry: RunningBot = {
      bot, controller, status: { state: "connecting" },
      driver: this.createDriver({
        bot,
        checkpoint: state.checkpoints[bot.id] ?? {},
        saveCheckpoint: async (checkpoint) => {
          if (controller.signal.aborted) return;
          await this.store.update((data) => {
            if (!controller.signal.aborted && data.bots.some((item) => item.id === bot.id)) data.checkpoints[bot.id] = checkpoint;
          });
        },
        onStatus: (status) => {
          if (controller.signal.aborted) return;
          entry.status = status;
          if (status.state === "error") reportImError("receive", { channel: bot.channel, botId: bot.id }, status.error);
        },
        onMessage: (message, prepare) => this.accept(entry, message, prepare),
      }),
    };
    this.running.set(bot.id, entry);
    entry.driver.start();
  }

  async stop(botId?: string): Promise<void> {
    const entries = botId ? [this.running.get(botId)].filter((item) => item !== undefined) : [...this.running.values()];
    for (const entry of entries) {
      entry.controller.abort();
      this.running.delete(entry.bot.id);
      await entry.driver.stop();
    }
  }

  async snapshot(): Promise<ImSnapshot> {
    const state = await this.store.read();
    const bots = state.bots.filter((bot) => bot.channel === "weixin");
    const ids = new Set(bots.map((bot) => bot.id));
    return {
      bots: bots.map(({ id, channel, name, cwd, enabled, allowedUserIds, allowedChatIds }) => ({
        id, channel, name, cwd, enabled, allowedUserIds, allowedChatIds,
        status: this.running.get(id)?.status ?? { state: "stopped" },
        deliveryError: this.running.get(id)?.deliveryError,
      })),
      conversations: Object.values(state.conversations).filter((item) => ids.has(item.botId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }

  async bind(key: string, sessionId: string | null): Promise<void> {
    const state = await this.store.read();
    const conversation = state.conversations[key];
    if (!conversation || !state.bots.some((bot) => bot.id === conversation.botId && bot.channel === "weixin")) {
      throw new Error("微信对话不存在，请先给机器人发送一条消息。");
    }
    if (sessionId !== null && !await this.host.exists(sessionId, conversation.cwd)) {
      throw new Error("只能绑定当前项目内已有的普通会话。");
    }
    await this.store.update((data) => {
      if (this.queues.has(key)) throw new Error("该对话正在提交消息，请稍后再切换会话。");
      data.conversations[key].sessionId = sessionId;
      data.conversations[key].updatedAt = new Date().toISOString();
    });
  }

  async send(cwd: string, destination: { handle: ImReplyHandle } | { bot: string }, items: ImSendItem[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const entry = await this.resolveDestination(cwd, destination);
    const recipient = { chatId: (entry.bot.credentials as WeixinCredentials).ownerUserId };
    const results: { index: number; type: ImSendItem["type"]; status: "sent" | "failed" | "not_attempted"; error?: string }[] = [];
    let failed = false;
    for (const [index, item] of items.entries()) {
      const record = { index, type: item.type };
      if (failed || signal?.aborted || entry.controller.signal.aborted) {
        failed = true;
        results.push({ ...record, status: "not_attempted" });
        continue;
      }
      try {
        await this.sendItem(entry, recipient, cwd, item, signal);
        results.push({ ...record, status: "sent" });
      } catch (error) {
        failed = true;
        this.sendFailed(entry, error);
        // A transport failure may occur after WeChat has accepted all or part of this item.
        results.push({ ...record, status: "failed", error: error instanceof WeixinError ? error.message : "微信发送失败。" });
      }
    }
    if (!failed) entry.deliveryError = undefined;
    return { success: !failed, results };
  }

  private async resolveDestination(cwd: string, destination: { handle: ImReplyHandle } | { bot: string }): Promise<RunningBot> {
    const project = sessionDirectoryKey(cwd);
    const { bots } = await this.store.read();
    const weixin = bots.filter((bot) => bot.channel === "weixin" && sessionDirectoryKey(bot.cwd) === project);
    let id: string | undefined;
    if ("handle" in destination) {
      id = weixin.find((bot) => bot.id === destination.handle.botId
        && (bot.credentials as WeixinCredentials).ownerUserId === destination.handle.chatId)?.id;
    } else {
      const exact = weixin.find((bot) => bot.id === destination.bot);
      if (exact) id = exact.id;
      else {
        const names = weixin.filter((bot) => bot.name === destination.bot);
        if (names.length > 1) throw new Error("微信机器人名称重复，请指定机器人 ID。");
        id = names[0]?.id;
      }
    }
    const entry = id && this.running.get(id);
    if (!entry || ("handle" in destination && (entry.bot.credentials as WeixinCredentials).ownerUserId !== destination.handle.chatId)) {
      throw new Error("当前项目找不到该可用的微信机器人或回复地址。");
    }
    return entry;
  }

  private async sendItem(entry: RunningBot, recipient: ImRecipient, cwd: string, item: ImSendItem, signal?: AbortSignal): Promise<void> {
    if (item.type === "text") return this.sendText(entry, recipient, item.text, signal);
    const path = resolve(cwd, item.path);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new WeixinError("file", "微信附件文件无效或无法读取。");
    const imageMime = getImageMime(path);
    if (item.type === "image" && !imageMime) throw new WeixinError("file", "图片须使用 PNG、JPEG、GIF 或 WebP 文件。");
    if (!entry.driver.sendAttachment) throw new WeixinError("file", "微信附件发送不可用。");
    await entry.driver.sendAttachment(recipient, {
      type: item.type, path, name: basename(path), mimeType: imageMime ?? getDocumentMime(path) ?? "application/octet-stream",
    }, signal);
  }

  private async accept(entry: RunningBot, message: ImInbound, prepare?: (signal: AbortSignal) => Promise<ImInbound>): Promise<void> {
    const botSignal = entry.controller.signal;
    if (botSignal.aborted) return;
    const key = conversationKey(entry.bot.id, message);
    const fresh = await this.store.update((state) => {
      if (botSignal.aborted) return false;
      const seen = state.seen[entry.bot.id] ?? [];
      const id = JSON.stringify([message.chatId, message.id]);
      if (seen.includes(id)) return false;
      state.seen[entry.bot.id] = [...seen, id].slice(-500);
      const receivedAt = new Date().toISOString();
      const conversation = state.conversations[key] ??= {
        key, botId: entry.bot.id, chatId: message.chatId, threadId: message.threadId,
        title: message.chatTitle || message.chatId, sessionId: null,
        cwd: entry.bot.cwd, updatedAt: receivedAt,
      };
      conversation.updatedAt = receivedAt;
      return true;
    });
    if (!fresh || botSignal.aborted) return;
    if (!this.queues.has(key)) entry.driver.setTyping?.(message, true);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let task: Promise<void>;
    let work: AbortController | undefined;
    if (/^\/stop(?:\s|$)/i.test(message.text)) {
      this.chatWork.get(key)?.abort();
      this.chatWork.delete(key);
      const stopping = this.stopConversation(key, botSignal).then((text) => this.sendNotice(entry, message, text, botSignal))
        .catch((error) => this.inboundFailed(entry, message, botSignal, error));
      // New input waits for Stop as well as a cancelled creation/preparation to unwind.
      task = Promise.all([previous, stopping]).then(() => undefined);
    } else {
      work = this.chatWork.get(key) ?? new AbortController();
      this.chatWork.set(key, work);
      const signal = AbortSignal.any([botSignal, work.signal]);
      task = previous.then(async () => {
        if (signal.aborted) return;
        try {
          const input = prepare ? await prepare(signal) : message;
          signal.throwIfAborted();
          await this.process(entry, key, message, input, signal);
        } catch (error) {
          await this.inboundFailed(entry, message, signal, error);
        }
      });
    }
    const settled = task.catch((error) => this.inboundFailed(entry, message, botSignal, error)).finally(() => {
      if (this.queues.get(key) === settled) {
        this.queues.delete(key);
        if (this.chatWork.get(key) === work) this.chatWork.delete(key);
        entry.driver.setTyping?.(message, false);
      }
    });
    this.queues.set(key, settled);
  }

  private sendText(entry: RunningBot, recipient: ImRecipient, text: string, signal?: AbortSignal) {
    if (!text.trim()) throw new WeixinError("text", "文字消息不能为空。");
    return entry.driver.send(recipient, text, signal);
  }

  private sendFailed(entry: RunningBot, error: unknown) {
    if (entry.controller.signal.aborted || error instanceof Error && error.name === "AbortError") return;
    reportImError("send", { channel: entry.bot.channel, botId: entry.bot.id });
    entry.deliveryError = "消息发送失败，请检查微信连接状态。";
  }

  private async sendNotice(entry: RunningBot, recipient: ImRecipient, text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      await this.sendText(entry, recipient, text, signal);
      entry.deliveryError = undefined;
    } catch (error) { this.sendFailed(entry, error); }
  }

  private async inboundFailed(entry: RunningBot, message: ImInbound, signal: AbortSignal, error: unknown): Promise<void> {
    if (signal.aborted || error instanceof Error && error.name === "AbortError") return;
    reportImError("process", { channel: entry.bot.channel, botId: entry.bot.id });
    await this.sendNotice(entry, message, "微信通知处理失败，请在 Web 会话中查看。", signal);
  }

  private async stopConversation(key: string, signal: AbortSignal): Promise<string> {
    const conversation = (await this.store.read()).conversations[key];
    signal.throwIfAborted();
    if (!conversation?.sessionId) return "当前对话还没有关联会话。";
    await this.host.stop(conversation.sessionId);
    return "已请求停止当前会话。";
  }

  private async process(entry: RunningBot, key: string, message: ImInbound, input: ImInbound, signal: AbortSignal): Promise<void> {
    if (input.preparationError) return this.sendNotice(entry, message, input.preparationError, signal);
    const { bot } = entry;
    const [command, argument] = input.text.trim().split(/\s+/, 2);
    if (["/help", "/start"].includes(command.toLowerCase())) {
      return this.sendNotice(entry, message, "直接发送文字继续当前项目会话。\n/status 查看关联\n/new 新建会话\n/sessions 列出项目会话\n/bind 会话ID 关联已有会话\n/stop 停止当前会话", signal);
    }
    if (command === "/new") {
      await this.updateBinding(key, null, signal);
      return this.sendNotice(entry, message, "已解除原会话关联，下一条消息将在当前项目中新建会话。", signal);
    }
    if (command === "/sessions") {
      const sessions = await this.host.list(bot.cwd);
      return this.sendNotice(entry, message, sessions.length ? sessions.map((item) => `${item.title}\n${item.id}`).join("\n\n")
        : "当前项目还没有会话，直接发送消息即可新建。", signal);
    }
    if (command === "/bind") {
      if (!argument || !await this.host.exists(argument, bot.cwd)) {
        return this.sendNotice(entry, message, "请使用 /bind 会话ID 关联当前项目的普通会话。", signal);
      }
      await this.updateBinding(key, argument, signal);
      return this.sendNotice(entry, message, `已关联会话 ${argument}`, signal);
    }
    let { sessionId } = (await this.store.read()).conversations[key];
    signal.throwIfAborted();
    if (command === "/status") return this.sendNotice(entry, message, `项目：${bot.cwd}\n会话：${sessionId ?? "下一条消息时新建"}`, signal);
    if (!sessionId || !await this.host.exists(sessionId, bot.cwd)) {
      signal.throwIfAborted();
      sessionId = await this.host.create(bot.cwd);
      await this.updateBinding(key, sessionId, signal);
    }
    const handle = { id: randomUUID(), sessionId, botId: bot.id, chatId: message.chatId };
    signal.throwIfAborted();
    const { completion } = await this.host.notify(handle, bot.cwd, input, signal);
    void completion.catch((error) => this.inboundFailed(entry, message, signal, error)).catch(() => {});
  }

  private async updateBinding(key: string, sessionId: string | null, signal: AbortSignal): Promise<void> {
    await this.store.update((state) => {
      signal.throwIfAborted();
      state.conversations[key].sessionId = sessionId;
      state.conversations[key].updatedAt = new Date().toISOString();
    });
  }
}
