import { randomUUID } from "node:crypto";
import type { ImAction, ImBot, ImBotView } from "./types";
import type { ImRuntime } from "./runtime";

export interface TelegramSetupDependencies {
  verifyTelegram(token: string): Promise<{ username: string }>;
}

type TelegramAccess = Pick<ImBot, "allowedUserIds" | "allowedChatIds">;

export function telegramAccess(action: TelegramAccess): TelegramAccess {
  if (!action.allowedUserIds.length) throw new Error("请至少填写一个允许使用 Telegram 的用户 ID。");
  return { allowedUserIds: action.allowedUserIds, allowedChatIds: action.allowedChatIds };
}

export function describeTelegramBot(bot: ImBot): Pick<ImBotView, "username"> {
  return bot.channel === "telegram" && "username" in bot.credentials
    ? { username: bot.credentials.username } : {};
}

export async function addTelegramBot(
  runtime: ImRuntime,
  action: Extract<ImAction, { action: "add-telegram" }>,
  dependencies: TelegramSetupDependencies,
  signal: AbortSignal,
): Promise<void> {
  const access = telegramAccess(action);
  const identity = await dependencies.verifyTelegram(action.token);
  const bot: ImBot = {
    id: randomUUID(), channel: "telegram", name: action.name || identity.username,
    cwd: action.cwd, enabled: true, ...access,
    credentials: { token: action.token, username: identity.username },
  };
  await runtime.store.update((state) => {
    signal.throwIfAborted();
    if (state.bots.some((item) => item.channel === "telegram" && item.credentials.token === action.token)) {
      throw new Error("这个 Telegram 机器人已经添加。");
    }
    state.bots.push(bot);
  });
  await runtime.restart(bot.id, signal);
}
