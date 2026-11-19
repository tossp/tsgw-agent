import type { ImAction } from "./types";

function text(data: Record<string, unknown>, key: string, optional = false): string {
  const value = data[key];
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || (!optional && !value.trim())) throw new Error(`缺少或无效的 ${key}。`);
  return value.trim();
}

export function parseImAction(value: unknown): ImAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效。");
  const data = value as Record<string, unknown>;
  switch (data.action) {
    case "login-weixin":
      return { action: data.action, name: text(data, "name", true), cwd: text(data, "cwd") };
    case "poll-weixin":
    case "cancel-weixin":
      return { action: data.action, loginId: text(data, "loginId") };
    case "update-bot":
      if (typeof data.enabled !== "boolean") throw new Error("enabled 必须为布尔值。");
      return { action: data.action, botId: text(data, "botId"), name: text(data, "name", true), cwd: text(data, "cwd"), enabled: data.enabled };
    case "remove-bot":
      return { action: data.action, botId: text(data, "botId") };
    case "bind":
      if (data.sessionId !== null && (typeof data.sessionId !== "string" || !data.sessionId.trim())) throw new Error("sessionId 无效。");
      return { action: data.action, conversationKey: text(data, "conversationKey"), sessionId: data.sessionId === null ? null : text(data, "sessionId") };
    default:
      throw new Error("不支持的 IM 管理操作。");
  }
}
