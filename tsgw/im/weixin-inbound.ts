import type { ImAttachment, ImInbound } from "./types";
import { reportImError } from "./telemetry";
import { weixinRecord, weixinString } from "./weixin-transport";

/** Only the current message body is used for chat commands; quotes stay separate. */
export function weixinInputText(items: unknown[]): string {
  return items.map((raw) => {
    const item = weixinRecord(raw);
    if (item.type === 1) return weixinString(weixinRecord(item.text_item).text);
    if (item.type === 3) {
      const text = weixinString(weixinRecord(item.voice_item).text);
      return text ? `[语音转写]\n${text}` : "";
    }
    return "";
  }).filter(Boolean).join("\n").trim();
}

function quoteText(raw: unknown): string {
  const quote = weixinRecord(raw);
  const item = weixinRecord(quote.message_item);
  const body = weixinInputText([item]);
  const title = weixinString(quote.title);
  if (body) return title && title !== body ? `${title}\n${body}` : body;
  if (item.type === 2) return title || "[引用图片；平台未提供引用文字]";
  if (item.type === 4) return title || `[引用文件：${weixinString(weixinRecord(item.file_item).file_name) || "未命名"}]`;
  if (title) return title;
  const id = weixinString(quote.svr_id);
  return id ? `[引用消息 ${id}；平台未提供原文]` : "";
}

export async function prepareWeixinInput(
  message: ImInbound,
  items: unknown[],
  download: (item: Record<string, unknown>) => Promise<ImAttachment>,
  signal: AbortSignal,
  botId: string,
): Promise<ImInbound> {
  const attachments: ImAttachment[] = [];
  const quotes = items.map((raw) => quoteText(weixinRecord(raw).ref_msg)).filter(Boolean);
  try {
    for (const raw of items) {
      signal.throwIfAborted();
      const item = weixinRecord(raw);
      if (item.type === 2 || item.type === 4) attachments.push(await download(item));
      else if (item.type === 3 && !weixinString(weixinRecord(item.voice_item).text)) {
        return { ...message, preparationError: "这条语音没有转写文字，暂时无法处理；请改发文字。" };
      } else if (item.type === 5) {
        return { ...message, preparationError: "暂时无法处理微信视频；请改发图片、文件或文字。" };
      }
    }
    signal.throwIfAborted();
    return {
      ...message,
      ...(attachments.length ? { attachments } : {}),
      ...(quotes.length ? { quotedText: [...new Set(quotes)].join("\n\n") } : {}),
    };
  } catch {
    signal.throwIfAborted();
    reportImError("receive-media", { channel: "weixin", botId });
    return { ...message, preparationError: "微信附件下载或解密失败，请重新发送，或在 Web 会话上传附件。" };
  }
}
