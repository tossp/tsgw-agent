import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImAction, ImBot, ImSnapshot, WeixinCredentials, WeixinLoginResult } from "./types";
import type { ImRuntime } from "./runtime";
import { reportImError } from "./telemetry";

export interface ImLoginConnection {
  qrUrl: string;
  poll(): Promise<{ state: "waiting" | "scanned" | "connected" | "expired"; credentials?: WeixinCredentials }>;
}

interface LoginAttempt {
  id: string;
  name: string;
  cwd: string;
  expiresAt: number;
  connection: ImLoginConnection;
  controller: AbortController;
  view: WeixinLoginResult;
  pending?: Promise<WeixinLoginResult>;
  committing?: boolean;
}

export interface ImServiceDependencies {
  verifyTelegram(token: string): Promise<{ username: string }>;
  createWeixinLogin(signal: AbortSignal): Promise<ImLoginConnection>;
  qrImage(url: string): Promise<string>;
}

export class ImService {
  private logins = new Map<string, LoginAttempt>();
  private changes: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private closing?: Promise<void>;

  constructor(readonly runtime: ImRuntime, private dependencies: ImServiceDependencies) {}

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    for (const attempt of this.logins.values()) attempt.controller.abort();
    this.logins.clear();
    // Drain management already admitted before the final stop; no late restart can escape it.
    return this.closing = this.changes.then(() => this.runtime.stop());
  }

  private ensureOpen(): void {
    if (this.lifetime.signal.aborted) throw new Error("IM 服务已关闭。");
  }

  private enqueue<T>(change: () => Promise<T>): Promise<T> {
    const result = this.changes.then(() => {
      this.ensureOpen();
      return change();
    });
    this.changes = result.catch(() => undefined);
    return result;
  }

  async action(action: ImAction): Promise<ImSnapshot | WeixinLoginResult> {
    this.ensureOpen();
    if (action.action === "login-weixin") return this.login(action);
    if (action.action === "poll-weixin") return this.poll(action.loginId);
    if (action.action === "cancel-weixin") {
      const attempt = this.logins.get(action.loginId);
      if (attempt?.committing) throw new Error("微信授权已确认，正在完成绑定，请稍候");
      attempt?.controller.abort();
      this.logins.delete(action.loginId);
      return this.runtime.snapshot();
    }
    // User management operations commit in order; poll cursors use the store's same owner.
    return this.enqueue(() => this.change(action));
  }

  private async change(action: Exclude<ImAction, { action: "login-weixin" | "poll-weixin" | "cancel-weixin" }>): Promise<ImSnapshot> {
    if (action.action === "add-telegram") {
      const cwd = await projectDirectory(action.cwd);
      if (!action.allowedUserIds.length) throw new Error("请至少填写一个允许使用 Telegram 的用户 ID。");
      const identity = await this.dependencies.verifyTelegram(action.token);
      const bot: ImBot = {
        id: randomUUID(), channel: "telegram", name: action.name || identity.username,
        cwd, enabled: true, allowedUserIds: action.allowedUserIds, allowedChatIds: action.allowedChatIds,
        credentials: { token: action.token, username: identity.username },
      };
      await this.runtime.store.update((state) => {
        this.ensureOpen();
        if (state.bots.some((item) => item.channel === "telegram" && item.credentials.token === action.token)) {
          throw new Error("这个 Telegram 机器人已经添加。");
        }
        state.bots.push(bot);
      });
      await this.runtime.restart(bot.id, this.lifetime.signal);
    } else if (action.action === "bind") {
      await this.runtime.bind(action.conversationKey, action.sessionId);
    } else {
      const state = await this.runtime.store.read();
      const bot = state.bots.find((item) => item.id === action.botId);
      if (!bot) throw new Error("机器人不存在。");
      if (action.action === "remove-bot") {
        await this.runtime.stop(bot.id);
        await this.runtime.store.update((data) => {
          data.bots = data.bots.filter((item) => item.id !== bot.id);
          delete data.checkpoints[bot.id];
          delete data.seen[bot.id];
          for (const [key, conversation] of Object.entries(data.conversations)) {
            if (conversation.botId === bot.id) delete data.conversations[key];
          }
        });
      } else {
        const cwd = await projectDirectory(action.cwd);
        if (bot.channel === "telegram" && !action.allowedUserIds.length) {
          throw new Error("请至少填写一个允许使用 Telegram 的用户 ID。");
        }
        await this.runtime.stop(bot.id);
        await this.runtime.store.update((data) => {
          const target = data.bots.find((item) => item.id === bot.id)!;
          Object.assign(target, {
            name: action.name || bot.name, cwd, enabled: action.enabled,
            allowedUserIds: bot.channel === "telegram" ? action.allowedUserIds : bot.allowedUserIds,
            allowedChatIds: action.allowedChatIds,
          });
          // The new project must never inherit a conversation's old-project session.
          if (cwd !== bot.cwd) for (const conversation of Object.values(data.conversations)) {
            if (conversation.botId === bot.id) Object.assign(conversation, { cwd, sessionId: null });
          }
        });
        await this.runtime.restart(bot.id, this.lifetime.signal);
      }
    }
    return this.runtime.snapshot();
  }

  private async login(action: Extract<ImAction, { action: "login-weixin" }>): Promise<WeixinLoginResult> {
    const cwd = await projectDirectory(action.cwd);
    for (const [id, attempt] of this.logins) {
      if (attempt.expiresAt < Date.now()) {
        attempt.controller.abort();
        this.logins.delete(id);
      }
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    signal.throwIfAborted();
    try {
      const connection = await this.dependencies.createWeixinLogin(signal);
      signal.throwIfAborted();
      const id = randomUUID();
      const view: WeixinLoginResult = {
        id, state: "waiting", qrUrl: connection.qrUrl,
        qrImage: await this.dependencies.qrImage(connection.qrUrl),
      };
      signal.throwIfAborted();
      this.logins.set(id, { id, name: action.name || "微信", cwd, expiresAt: Date.now() + 5 * 60_000, connection, controller, view });
      return view;
    } catch (error) {
      if (!signal.aborted) reportImError("login-start", { channel: "weixin" });
      throw error;
    }
  }

  private async poll(id: string): Promise<WeixinLoginResult> {
    const attempt = this.logins.get(id);
    if (!attempt) throw new Error("扫码请求不存在或服务已重启，请重新生成二维码。");
    if (attempt.expiresAt < Date.now()) {
      attempt.controller.abort();
      return { id, state: "expired" };
    }
    if (["connected", "expired", "error"].includes(attempt.view.state)) return attempt.view;
    if (attempt.pending) return attempt.pending;
    attempt.pending = this.completeLogin(attempt).finally(() => { attempt.pending = undefined; });
    return attempt.pending;
  }

  private async completeLogin(attempt: LoginAttempt): Promise<WeixinLoginResult> {
    try {
      const result = await attempt.connection.poll();
      attempt.controller.signal.throwIfAborted();
      if (result.state !== "connected") {
        attempt.view = { ...attempt.view, state: result.state };
        return attempt.view;
      }
      if (!result.credentials) throw new Error("微信授权返回的凭据不完整。");
      const credentials = result.credentials;
      const id = await this.enqueue(async () => {
        const signal = AbortSignal.any([attempt.controller.signal, this.lifetime.signal]);
        signal.throwIfAborted();
        const botId = await this.runtime.store.update((state) => {
          signal.throwIfAborted();
          // Once credentials may persist, cancellation cannot promise to discard this binding.
          attempt.committing = true;
          const existing = state.bots.find((item) => item.channel === "weixin" && "accountId" in item.credentials && item.credentials.accountId === credentials.accountId);
          if (existing) {
            existing.credentials = credentials;
            existing.allowedUserIds = [credentials.ownerUserId];
            existing.enabled = true;
            return existing.id;
          }
          const bot: ImBot = {
            id: randomUUID(), channel: "weixin", name: attempt.name, cwd: attempt.cwd, enabled: true,
            credentials, allowedUserIds: [credentials.ownerUserId], allowedChatIds: [],
          };
          state.bots.push(bot);
          return bot.id;
        });
        await this.runtime.restart(botId, signal);
        return botId;
      });
      attempt.view = { id: attempt.id, state: "connected", botId: id };
    } catch {
      if (!attempt.controller.signal.aborted && !this.lifetime.signal.aborted) {
        reportImError("login-complete", { channel: "weixin" });
      }
      attempt.view = { id: attempt.id, state: "error", error: "微信绑定失败，请重新扫码或检查网络。" };
    }
    return attempt.view;
  }
}

export async function projectDirectory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error("项目目录必须是绝对路径。");
  try {
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch {
    throw new Error("项目目录不存在或无法访问。");
  }
}
