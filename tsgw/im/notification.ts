import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripFrontmatter, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { preparePiAttachments } from "./pi-media";
import type { ImInbound } from "./types";

export const IM_NOTIFICATION_TYPE = "pi-web:im-notification";
const skillPath = join(process.cwd(), "tsgw/im/skills/tsgw-im-reply/SKILL.md");

export interface ImReplyHandle {
  id: string;
  sessionId: string;
  botId: string;
  chatId: string;
}

export async function makeImNotification(handle: ImReplyHandle, input: ImInbound, signal: AbortSignal) {
  const skill = stripFrontmatter(await readFile(skillPath, { encoding: "utf8", signal })).trim();
  const media = input.attachments?.length ? await preparePiAttachments(input.attachments, signal) : undefined;
  const text = [
    `微信消息通知，回复句柄：${handle.id}`,
    skill,
    `微信消息正文：\n${input.text || "请处理附件。"}`,
    input.quotedText && `引用内容：\n${input.quotedText}`,
    media?.links,
  ].filter(Boolean).join("\n\n");
  const images: ImageContent[] = media?.images ?? [];
  return { customType: IM_NOTIFICATION_TYPE, content: [{ type: "text" as const, text }, ...images], display: true, details: handle };
}

export function resolveImReplyHandle(manager: Pick<SessionManager, "getBranch" | "getSessionId">, id: string): ImReplyHandle | undefined {
  // Details are stored with the SDK notification. A copied branch keeps its
  // history but does not acquire the original session's ability to reply.
  const sessionId = manager.getSessionId();
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom_message" || entry.customType !== IM_NOTIFICATION_TYPE) continue;
    const handle = entry.details as Partial<ImReplyHandle> | undefined;
    if (handle?.id === id && handle.sessionId === sessionId
      && typeof handle.botId === "string" && typeof handle.chatId === "string") {
      return { id, sessionId, botId: handle.botId, chatId: handle.chatId };
    }
  }
}
