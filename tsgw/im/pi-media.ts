import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Definition, Nodes } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "../../lib/image-attachments";
import { resolveLocalFileHref } from "../../lib/file-links";
import { getDocumentMime, getImageMime } from "../../lib/file-types";
import type { ImAttachment, ImReply } from "./types";

const parser = unified().use(remarkParse);

/** Keep an exact file reference in the user message, including temp files outside cwd. */
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

export const WEIXIN_MEDIA_PROMPT = "微信附件交付约定：需要交付图片或文件时，请在最终答复中写明确的本地 Markdown 图片或文件链接，优先使用绝对路径。仅最终答复显式引用的附件会发送到本次聊天，无需调用额外发送工具，不会自动广播。";

type Replacement = { start: number; end: number; text: string };
const referenceKey = (identifier: string) => identifier.replace(/\s+/g, " ").toUpperCase();

/** Called only on the collector's owned final answer; never inspect tools or history. */
export async function collectWeixinReply(text: string, cwd: string, signal: AbortSignal): Promise<ImReply> {
  signal.throwIfAborted();
  const tree = parser.parse(text);
  const definitions = new Map<string, Definition>();
  const replacements: Replacement[] = [];
  const candidates: { node: Nodes; path: string }[] = [];
  const replace = (node: Nodes, value: string) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) replacements.push({ start, end, text: value });
  };
  const walk = (node: Nodes, visit: (node: Nodes) => boolean | void) => {
    if (visit(node) === false) return;
    if ("children" in node) for (const child of node.children) walk(child, visit);
  };
  walk(tree, (node) => {
    if (node.type !== "definition") return;
    const key = referenceKey(node.identifier);
    if (!definitions.has(key)) definitions.set(key, node);
    // Definitions are not deliveries themselves. Remove local destinations from IM text,
    // including unused definitions, while preserving code and remote links byte-for-byte.
    if (resolveLocalFileHref(node.url, cwd)) replace(node, "");
  });
  walk(tree, (node) => {
    let href: string | undefined;
    if (node.type === "link" || node.type === "image") href = node.url;
    if (node.type === "linkReference" || node.type === "imageReference") {
      href = definitions.get(referenceKey(node.identifier))?.url;
    }
    const path = resolveLocalFileHref(href, cwd);
    if (!path) return;
    candidates.push({ node, path });
    return false;
  });
  const attachments: ImAttachment[] = [];
  const sent = new Set<string>();
  for (const { node, path } of candidates) {
    signal.throwIfAborted();
    let canonical: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        replace(node, "[附件不可用，请在 Pi 会话中查看]");
        continue;
      }
      await access(path, constants.R_OK);
      canonical = await realpath(path);
    } catch (error) {
      signal.throwIfAborted();
      // A missing/unreadable local destination must not become a path leaked to Weixin.
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(code)) throw error;
      replace(node, "[附件不可用，请在 Pi 会话中查看]");
      continue;
    }
    signal.throwIfAborted();
    const name = basename(path);
    const imageMime = getImageMime(path);
    replace(node, `[${imageMime ? "图片" : "文件"}：${name}]`);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (sent.has(key)) continue;
    sent.add(key);
    attachments.push({ type: imageMime ? "image" : "file", path, name,
      mimeType: imageMime ?? getDocumentMime(path) ?? "application/octet-stream" });
  }
  signal.throwIfAborted();
  let adapted = text;
  for (const change of replacements.sort((a, b) => b.start - a.start)) {
    adapted = adapted.slice(0, change.start) + change.text + adapted.slice(change.end);
  }
  return { text: adapted, ...(attachments.length ? { attachments } : {}) };
}
