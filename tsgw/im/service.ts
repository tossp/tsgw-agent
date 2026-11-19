import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ImAction, ImSnapshot, WeixinLoginResult } from "./types";
import type { ImRuntime } from "./runtime";
import { WeixinSetup, type WeixinSetupDependencies } from "./weixin-setup";

export class ImService {
  private weixin: WeixinSetup;
  private changes: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private closing?: Promise<void>;

  constructor(readonly runtime: ImRuntime, dependencies: WeixinSetupDependencies) {
    this.weixin = new WeixinSetup(runtime, dependencies, this.lifetime.signal, (change) => this.enqueue(change));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.weixin.close();
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
    if (action.action === "login-weixin") {
      return this.weixin.login({ ...action, cwd: await projectDirectory(action.cwd) });
    }
    if (action.action === "poll-weixin") return this.weixin.poll(action.loginId);
    if (action.action === "cancel-weixin") {
      this.weixin.cancel(action.loginId);
      return this.runtime.snapshot();
    }
    // User management operations commit in order; poll cursors use the store's same owner.
    return this.enqueue(() => this.change(action));
  }

  private async change(action: Exclude<ImAction, { action: "login-weixin" | "poll-weixin" | "cancel-weixin" }>): Promise<ImSnapshot> {
    if (action.action === "bind") {
      await this.runtime.bind(action.conversationKey, action.sessionId);
    } else {
      const state = await this.runtime.store.read();
      const bot = state.bots.find((item) => item.id === action.botId);
      if (!bot || bot.channel !== "weixin") throw new Error("微信机器人不存在。");
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
        await this.runtime.stop(bot.id);
        await this.runtime.store.update((data) => {
          const target = data.bots.find((item) => item.id === bot.id)!;
          Object.assign(target, {
            name: action.name || bot.name, cwd, enabled: action.enabled,
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
