import { abortable } from "./pi-host-run";
import type { ImSessionHost } from "./host-types";
import type { ImStore } from "./store";
import type { ImBot, ImDriver, ImDriverOptions, ImDriverStatus, ImInbound, ImSnapshot } from "./types";

export type ImDriverFactory = (options: ImDriverOptions) => ImDriver;
interface RunningBot {
  bot: ImBot;
  driver: ImDriver;
  controller: AbortController;
  status: ImDriverStatus;
}

export function conversationKey(botId: string, message: Pick<ImInbound, "chatId" | "threadId">): string {
  return JSON.stringify([botId, message.chatId, message.threadId ?? null]);
}

export class ImRuntime {
  private running = new Map<string, RunningBot>();
  private queues = new Map<string, Promise<void>>();
  private queueGeneration = new Map<string, number>();
  private active = new Map<string, AbortController>();

  constructor(
    readonly store: ImStore,
    readonly host: ImSessionHost,
    private factories: Record<ImBot["channel"], ImDriverFactory>,
  ) {}

  async start(): Promise<void> {
    const { bots } = await this.store.read();
    for (const bot of bots) if (bot.enabled) await this.restart(bot.id);
  }

  async restart(botId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.stop(botId);
    const state = await this.store.read();
    signal?.throwIfAborted();
    const bot = state.bots.find((entry) => entry.id === botId);
    if (!bot?.enabled) return;
    const controller = new AbortController();
    const entry: RunningBot = {
      bot, controller, status: { state: "connecting" },
      driver: this.factories[bot.channel]({
        bot,
        checkpoint: state.checkpoints[bot.id] ?? {},
        saveCheckpoint: async (checkpoint) => {
          if (controller.signal.aborted) return;
          await this.store.update((data) => {
            if (!controller.signal.aborted && data.bots.some((item) => item.id === bot.id)) data.checkpoints[bot.id] = checkpoint;
          });
        },
        onStatus: (status) => { if (!controller.signal.aborted) entry.status = status; },
        onMessage: (message) => this.accept(entry, message),
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
    return {
      bots: state.bots.map(({ credentials, ...bot }) => ({
        ...bot,
        ...(bot.channel === "telegram" && "username" in credentials ? { username: credentials.username } : {}),
        status: this.running.get(bot.id)?.status ?? { state: "stopped" },
      })),
      conversations: Object.values(state.conversations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }

  async bind(key: string, sessionId: string | null): Promise<void> {
    const conversation = (await this.store.read()).conversations[key];
    if (!conversation) throw new Error("对话不存在，请先给机器人发送一条消息。");
    if (this.queues.has(key)) throw new Error("该对话正在处理消息，请停止或等任务结束后再切换会话。");
    if (sessionId !== null && !await this.host.exists(sessionId, conversation.cwd)) {
      throw new Error("只能绑定当前项目内已有的普通会话。");
    }
    await this.store.update((state) => {
      state.conversations[key].sessionId = sessionId;
      state.conversations[key].updatedAt = new Date().toISOString();
    });
  }

  private async accept(entry: RunningBot, message: ImInbound): Promise<void> {
    if (entry.controller.signal.aborted) return;
    const key = conversationKey(entry.bot.id, message);
    const fresh = await this.store.update((state) => {
      if (entry.controller.signal.aborted) return false;
      const seen = state.seen[entry.bot.id] ?? [];
      const id = JSON.stringify([message.chatId, message.id]);
      if (seen.includes(id)) return false;
      state.seen[entry.bot.id] = [...seen, id].slice(-500);
      state.conversations[key] ??= {
        key, botId: entry.bot.id, chatId: message.chatId, threadId: message.threadId,
        title: message.chatTitle || message.chatId, sessionId: null,
        cwd: entry.bot.cwd, updatedAt: new Date().toISOString(),
      };
      return true;
    });
    if (!fresh || entry.controller.signal.aborted) return;
    // Stop must bypass the chat's queue: a long-running prompt must remain stoppable.
    let task: Promise<void>;
    if (/^\/stop(?:\s|$)/i.test(message.text)) {
      this.queueGeneration.set(key, (this.queueGeneration.get(key) ?? 0) + 1);
      this.active.get(key)?.abort();
      // Later inputs wait for Stop itself; older queued inputs retain their cancelled generation.
      task = this.deliver(entry, message, () => this.stopConversation(key, entry.controller.signal));
    } else {
      const generation = this.queueGeneration.get(key) ?? 0;
      const previous = this.queues.get(key) ?? Promise.resolve();
      task = previous.then(async () => {
        if (entry.controller.signal.aborted || generation !== (this.queueGeneration.get(key) ?? 0)) return;
        const controller = new AbortController();
        const signal = AbortSignal.any([entry.controller.signal, controller.signal]);
        this.active.set(key, controller);
        try {
          await this.deliver(entry, message,
            () => abortable(this.process(entry.bot, key, message, signal), signal), signal);
        } finally {
          if (this.active.get(key) === controller) this.active.delete(key);
        }
      });
    }
    const settled = task.catch(() => undefined).finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    this.queues.set(key, settled);
  }

  private async deliver(entry: RunningBot, message: ImInbound, respond: () => Promise<string>, signal = entry.controller.signal): Promise<void> {
    let text: string;
    try {
      text = await respond();
    } catch {
      text = "任务未完成，请在 Web 会话中查看详情；确认项目、模型与连接状态后再试。";
    }
    if (signal.aborted) return;
    try {
      await entry.driver.send(message, text);
    } catch {
      entry.status = { state: "error", error: "回复发送失败，请检查机器人连接状态。" };
    }
  }

  private async stopConversation(key: string, signal: AbortSignal): Promise<string> {
    const conversation = (await this.store.read()).conversations[key];
    signal.throwIfAborted();
    if (!conversation?.sessionId) return "当前对话还没有关联会话。";
    await this.host.stop(conversation.sessionId);
    return "已请求停止当前会话。";
  }

  private async process(bot: ImBot, key: string, message: ImInbound, signal: AbortSignal): Promise<string> {
    const text = message.text.trim();
    const [command, argument] = text.split(/\s+/, 2);
    if (["/help", "/start"].includes(command.toLowerCase())) {
      return "直接发送文字继续当前项目会话。\n/status 查看关联\n/new 新建会话\n/sessions 列出项目会话\n/bind 会话ID 关联已有会话\n/stop 停止当前会话";
    }
    if (command === "/new") {
      await this.store.update((state) => {
        signal.throwIfAborted();
        state.conversations[key].sessionId = null;
      });
      return "已解除原会话关联，下一条消息将在当前项目中新建会话。";
    }
    if (command === "/sessions") {
      const sessions = await this.host.list(bot.cwd);
      return sessions.length ? sessions.map((session) => `${session.title || "未命名"}\n${session.id}`).join("\n\n") : "当前项目还没有会话，直接发送消息即可新建。";
    }
    if (command === "/bind") {
      if (!argument) return "请使用 /bind 会话ID，或在 Web 的 IM 机器人设置中选择会话。";
      if (!await this.host.exists(argument, bot.cwd)) return "该会话不存在或不属于当前项目。";
      await this.store.update((state) => {
        signal.throwIfAborted();
        state.conversations[key].sessionId = argument;
      });
      return `已关联会话 ${argument}`;
    }
    let conversation = (await this.store.read()).conversations[key];
    signal.throwIfAborted();
    if (command === "/status") return `项目：${bot.cwd}\n会话：${conversation.sessionId ?? "下一条消息时新建"}`;
    if (!conversation.sessionId || !await this.host.exists(conversation.sessionId, bot.cwd)) {
      signal.throwIfAborted();
      const id = await this.host.create(bot.cwd, `${bot.name} · ${conversation.title}`);
      signal.throwIfAborted();
      await this.store.update((state) => {
        signal.throwIfAborted();
        state.conversations[key].sessionId = id;
        state.conversations[key].updatedAt = new Date().toISOString();
      });
      conversation = { ...conversation, sessionId: id };
    }
    signal.throwIfAborted();
    const reply = await this.host.prompt(conversation.sessionId!, message.text, signal, {
      channel: bot.channel, botId: bot.id, botName: bot.name,
      chatId: message.chatId, senderId: message.senderId, messageId: message.messageId ?? message.id,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    });
    signal.throwIfAborted();
    await this.store.update((state) => {
      signal.throwIfAborted();
      state.conversations[key].updatedAt = new Date().toISOString();
    });
    return reply || "本次任务已结束，没有文字回复，请在 Web 会话中查看结果。";
  }
}
