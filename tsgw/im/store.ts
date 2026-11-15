import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImBot, ImConversation } from "./types";

export interface ImState {
  version: 1;
  bots: ImBot[];
  conversations: Record<string, ImConversation>;
  checkpoints: Record<string, Record<string, unknown>>;
  seen: Record<string, string[]>;
}

function emptyState(): ImState {
  return { version: 1, bots: [], conversations: {}, checkpoints: {}, seen: {} };
}

/** One owner serializes config, poll cursors and chat bindings into one protected file. */
export class ImStore {
  private state: ImState;
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(readonly file: string, state: ImState) {
    this.state = state;
  }

  static async open(file: string): Promise<ImStore> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ImStore(file, emptyState());
      throw new Error("无法读取 IM 配置文件，请检查文件权限。");
    }
    let data: ImState;
    try {
      data = JSON.parse(raw) as ImState;
      if (data.version !== 1 || !Array.isArray(data.bots)
        || !data.conversations || !data.checkpoints || !data.seen) throw new Error();
      for (const bot of data.bots) {
        if (!bot.id || !["weixin", "telegram"].includes(bot.channel) || typeof bot.cwd !== "string"
          || typeof bot.enabled !== "boolean" || !Array.isArray(bot.allowedUserIds)
          || !Array.isArray(bot.allowedChatIds) || !bot.credentials
          || typeof bot.credentials.token !== "string") throw new Error();
      }
    } catch {
      throw new Error("IM 配置文件格式无效；请修复原文件，系统不会覆盖它。");
    }
    return new ImStore(file, data);
  }

  async read(): Promise<ImState> {
    await this.writes;
    return structuredClone(this.state);
  }

  update<T>(change: (state: ImState) => T): Promise<T> {
    const write = this.writes.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, this.file);
      this.state = next;
      return result;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
