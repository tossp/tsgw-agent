import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "../../lib/image-attachments";
import type { ImAttachment } from "./types";

/** Keep an exact file reference in the notification, including temp files outside cwd. */
function attachmentLink(attachment: ImAttachment): string {
  const name = attachment.name.replace(/[\\[\]<>`\r\n]/g, "_");
  const ticks = "`".repeat(Math.max(0, ...(attachment.path.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  // The raw path also keeps session-reference authorization working when another
  // part of the message contains a literal percent sign (whole-string decoding fails).
  const label = `${name} · ${ticks} ${attachment.path} ${ticks}`;
  const href = encodeURI(attachment.path).replace(/[?#()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${label}](<${href}>)`;
}

/** Single inbound boundary: validate local images and pass their original bytes to Pi. */
export async function preparePiAttachments(
  attachments: ImAttachment[], signal: AbortSignal,
): Promise<{ links: string; images: ImageContent[] }> {
  signal.throwIfAborted();
  if (attachments.filter((attachment) => attachment.type === "image").length > MAX_ATTACHED_IMAGES) {
    throw new Error(`一条消息最多附加 ${MAX_ATTACHED_IMAGES} 张图片。`);
  }
  const links: string[] = [];
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    signal.throwIfAborted();
    if (!isAbsolute(attachment.path)) throw new Error("IM 附件必须使用绝对路径。");
    const info = await stat(attachment.path);
    signal.throwIfAborted();
    if (!info.isFile()) throw new Error("IM 附件不是普通文件。");
    if (attachment.type === "image") {
      if (info.size > MAX_ATTACHED_IMAGE_BYTES) throw new Error("每张图片不能超过 10MiB。");
      const bytes = await readFile(attachment.path, { signal });
      signal.throwIfAborted();
      if (bytes.length > MAX_ATTACHED_IMAGE_BYTES) throw new Error("每张图片不能超过 10MiB。");
      const data = bytes.toString("base64");
      // Pi's public header reader checks the signature and dimensions against the declared MIME.
      // No resize/conversion: model settings retain ownership of image normalization.
      const dimensions = getImageDimensions(data, attachment.mimeType);
      if (!dimensions || dimensions.widthPx <= 0 || dimensions.heightPx <= 0) {
        throw new Error("图片内容无效或与声明类型不符；请使用 PNG、JPEG、GIF 或 WebP。");
      }
      images.push({ type: "image", data, mimeType: attachment.mimeType });
    }
    links.push(attachmentLink(attachment));
  }
  return { links: `附件（本地文件）：\n${links.join("\n")}`, images };
}
