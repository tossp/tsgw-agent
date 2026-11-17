import { randomUUID } from "node:crypto";
import type { ImAction, ImBot, WeixinCredentials, WeixinLoginResult } from "./types";
import type { ImRuntime } from "./runtime";
import { reportImError } from "./telemetry";

export interface ImLoginConnection {
  qrUrl: string;
  poll(): Promise<{ state: "waiting" | "scanned" | "connected" | "expired"; credentials?: WeixinCredentials }>;
}

export interface WeixinSetupDependencies {
  createWeixinLogin(signal: AbortSignal): Promise<ImLoginConnection>;
  qrImage(url: string): Promise<string>;
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

export class WeixinSetup {
  private logins = new Map<string, LoginAttempt>();

  constructor(
    private runtime: ImRuntime,
    private dependencies: WeixinSetupDependencies,
    private lifetime: AbortSignal,
    private enqueue: <T>(change: () => Promise<T>) => Promise<T>,
  ) {}

  close(): void {
    for (const attempt of this.logins.values()) attempt.controller.abort();
    this.logins.clear();
  }

  cancel(id: string): void {
    const attempt = this.logins.get(id);
    if (attempt?.committing) throw new Error("微信授权已确认，正在完成绑定，请稍候");
    attempt?.controller.abort();
    this.logins.delete(id);
  }

  async login(action: Extract<ImAction, { action: "login-weixin" }>): Promise<WeixinLoginResult> {
    for (const [id, attempt] of this.logins) {
      if (attempt.expiresAt < Date.now()) {
        attempt.controller.abort();
        this.logins.delete(id);
      }
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime]);
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
      this.logins.set(id, { id, name: action.name || "微信", cwd: action.cwd, expiresAt: Date.now() + 5 * 60_000, connection, controller, view });
      return view;
    } catch (error) {
      if (!signal.aborted) reportImError("login-start", { channel: "weixin" });
      throw error;
    }
  }

  async poll(id: string): Promise<WeixinLoginResult> {
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
        const signal = AbortSignal.any([attempt.controller.signal, this.lifetime]);
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
      if (!attempt.controller.signal.aborted && !this.lifetime.aborted) {
        reportImError("login-complete", { channel: "weixin" });
      }
      attempt.view = { id: attempt.id, state: "error", error: "微信绑定失败，请重新扫码或检查网络。" };
    }
    return attempt.view;
  }
}
