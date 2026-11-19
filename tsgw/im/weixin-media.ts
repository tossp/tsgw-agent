// Protocol/crypto adapted from Tencent/openclaw-weixin (MIT), commit
// 0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e. See THIRD_PARTY_NOTICES.md.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAudioMime, getDocumentMime, getFileExt, getImageMime, getVideoMime } from "../../lib/file-types";
import { MAX_ATTACHED_IMAGE_BYTES } from "../../lib/image-attachments";
import { credentialFetch } from "./credential-fetch";
import type { ImAttachment, ImBot, ImInbound, WeixinCredentials } from "./types";
import { WEIXIN_BASE_INFO, weixinAbort, weixinRecord, weixinRequest, weixinString, WeixinError } from "./weixin-transport";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
// Client memory/storage bound; this is not a claimed Weixin platform limit.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;
const ERROR_MESSAGES = {
  address: "微信媒体地址无效。",
  response: "微信媒体响应无效。",
  size: "微信附件超过客户端大小上限。",
  decrypt: "微信附件解密失败。",
  file: "微信附件文件无效或无法读取。",
  http: "微信媒体服务请求失败。",
  timeout: "微信媒体传输超时。",
  network: "微信媒体传输失败。",
} as const;

class MediaError extends WeixinError {
  constructor(code: keyof typeof ERROR_MESSAGES) { super(code, ERROR_MESSAGES[code]); }
}

interface MediaOptions { bot: ImBot; fetchImpl: typeof fetch; signal: AbortSignal }

function check(signal: AbortSignal): void {
  if (signal.aborted) throw weixinAbort();
}

/** Deadline also settles a stalled fetch/body implementation that ignores its signal. */
async function mediaOperation<T>(external: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  check(external);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  external.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MEDIA_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(weixinAbort());
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run(controller.signal), cancelled]);
  } catch (error) {
    if (external.aborted) throw weixinAbort();
    if (timedOut) throw new MediaError("timeout");
    if (error instanceof MediaError) throw error;
    // Never preserve provider text, filenames, URL, signal.reason, or cause.
    throw new MediaError("network");
  } finally {
    clearTimeout(timer);
    external.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function cdnUrl(value: string): URL {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "cdn.weixin.qq.com" || host.endsWith(".cdn.weixin.qq.com"))
      || (url.port && url.port !== "443") || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw new MediaError("address"); }
}

function paddedSize(length: number): number { return (Math.floor(length / 16) + 1) * 16; }

function mediaKey(image: Record<string, unknown>, media: Record<string, unknown>, isImage: boolean): Buffer | undefined {
  if (isImage && image.aeskey !== undefined && image.aeskey !== "") {
    if (typeof image.aeskey !== "string" || !/^[a-f\d]{32}$/i.test(image.aeskey)) throw new MediaError("decrypt");
    return Buffer.from(image.aeskey, "hex");
  }
  const encoded = media.aes_key;
  if (encoded === undefined || encoded === "") {
    if (isImage) return undefined;
    throw new MediaError("decrypt");
  }
  if (typeof encoded !== "string" || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(encoded)) {
    throw new MediaError("decrypt");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString("utf8"))) return Buffer.from(decoded.toString("utf8"), "hex");
  throw new MediaError("decrypt");
}

async function cdnFetch(fetchImpl: typeof fetch, url: URL, signal: AbortSignal, body?: Buffer): Promise<Response> {
  check(signal);
  const response = await credentialFetch(fetchImpl, url, {
    method: body ? "POST" : "GET", signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    ...(body ? { headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) } : {}),
  });
  check(signal);
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    throw new MediaError("http");
  }
  return response;
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new MediaError("size");
  }
  if (!response.body) throw new MediaError("response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      check(signal);
      const { value, done } = await reader.read();
      check(signal);
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > limit) throw new MediaError("size");
      chunks.push(Buffer.from(value));
    }
    if (!bytes) throw new MediaError("response");
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function cleanName(value: unknown, fallback: string): string {
  const name = basename((typeof value === "string" ? value : "").replaceAll("\\", "/"))
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
  return !name || name === "." || name === ".." ? fallback : name;
}

function imageFormat(bytes: Buffer): { mime: string; ext: string } | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return { mime: "image/gif", ext: "gif" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (bytes.subarray(0, 2).toString() === "BM") return { mime: "image/bmp", ext: "bmp" };
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return { mime: "image/x-icon", ext: "ico" };
  if (bytes.subarray(4, 8).toString() === "ftyp" && /^(avif|avis)$/.test(bytes.subarray(8, 12).toString())) return { mime: "image/avif", ext: "avif" };
  return undefined;
}

function fileMime(name: string): string {
  const common: Record<string, string> = { txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", zip: "application/zip" };
  const ext = getFileExt(name);
  return getImageMime(name) ?? getDocumentMime(name) ?? getAudioMime(name) ?? getVideoMime(name)
    ?? (Object.hasOwn(common, ext) ? common[ext] : "application/octet-stream");
}

async function saveAttachment(
  bytes: Buffer, type: ImAttachment["type"], name: string, mimeType: string,
  options: MediaOptions & { mediaDirectory?: string }, signal: AbortSignal,
): Promise<ImAttachment> {
  // Bot IDs are internal identifiers, never a provider-supplied path segment.
  if (!/^[A-Za-z\d_-]+$/.test(options.bot.id)) throw new MediaError("file");
  const root = resolve(options.mediaDirectory ?? join(getAgentDir(), "integrations", "im", "media"));
  const parent = join(root, options.bot.id);
  const directory = join(parent, randomUUID());
  const path = join(directory, name);
  let created = false;
  try {
    check(signal);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    check(signal);
    await mkdir(directory, { mode: 0o700 });
    created = true;
    check(signal);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx", signal });
    check(signal);
    return { type, path, name, mimeType };
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Each item gets an independent directory; successful attachments remain for session history. */
export async function downloadWeixinAttachment(
  item: Record<string, unknown>, options: MediaOptions & { mediaDirectory?: string },
): Promise<ImAttachment> {
  return mediaOperation(options.signal, async (signal) => {
    const isImage = item.type === 2;
    if (!isImage && item.type !== 4) throw new MediaError("response");
    const part = weixinRecord(isImage ? item.image_item : item.file_item);
    const media = weixinRecord(part.media);
    const key = mediaKey(part, media, isImage);
    const full = weixinString(media.full_url);
    const param = weixinString(media.encrypt_query_param);
    if (!full && !param) throw new MediaError("response");
    const url = cdnUrl(full || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(param)}`);
    const limit = isImage ? MAX_ATTACHED_IMAGE_BYTES : MAX_FILE_BYTES;
    const response = await cdnFetch(options.fetchImpl, url, signal);
    let bytes = await readBody(response, key ? paddedSize(limit) : limit, signal);
    if (key) {
      try {
        const decipher = createDecipheriv("aes-128-ecb", key, null);
        bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
      } catch { throw new MediaError("decrypt"); }
    }
    check(signal);
    if (bytes.length > limit) throw new MediaError("size");
    const format = isImage ? imageFormat(bytes) : undefined;
    // An unknown image must not reach the model labelled with a guessed image MIME.
    if (isImage && !format) throw new MediaError("response");
    const name = format ? `image.${format.ext}` : cleanName(part.file_name, "file.bin");
    return saveAttachment(bytes, isImage ? "image" : "file", name, format?.mime ?? fileMime(name), options, signal);
  });
}

async function readAttachment(attachment: ImAttachment, limit: number, signal: AbortSignal): Promise<Buffer> {
  check(signal);
  const handle = await open(attachment.path, "r");
  try {
    check(signal);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new MediaError("file");
    if (stat.size > limit) throw new MediaError("size");
    const chunks: Buffer[] = [];
    let length = 0;
    // Bound reads even when the file grows after stat, and abort the underlying stream.
    const stream = handle.createReadStream({ signal, autoClose: false });
    for await (const chunk of stream) {
      check(signal);
      length += chunk.length;
      if (length > limit) throw new MediaError("size");
      chunks.push(chunk);
    }
    check(signal);
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

/** Returns a sendmessage item only. Never sends a chat message or retries a POST. */
export async function uploadWeixinAttachment(
  attachment: ImAttachment, message: Pick<ImInbound, "chatId">, options: MediaOptions,
): Promise<Record<string, unknown>> {
  return mediaOperation(options.signal, async (signal) => {
    if (attachment.type !== "image" && attachment.type !== "file") throw new MediaError("file");
    const isImage = attachment.type === "image";
    const bytes = await readAttachment(attachment, isImage ? MAX_ATTACHED_IMAGE_BYTES : MAX_FILE_BYTES, signal);
    if (isImage && !bytes.length) throw new MediaError("file");
    const key = randomBytes(16);
    const filekey = randomBytes(16).toString("hex");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    check(signal);
    const credentials = options.bot.credentials as WeixinCredentials;
    const result = await weixinRequest({
      fetchImpl: options.fetchImpl, baseUrl: credentials.baseUrl, token: credentials.token,
      endpoint: "ilink/bot/getuploadurl", signal,
      body: {
        filekey, media_type: isImage ? 1 : 3, to_user_id: message.chatId,
        rawsize: bytes.length, rawfilemd5: createHash("md5").update(bytes).digest("hex"),
        filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString("hex"),
        base_info: WEIXIN_BASE_INFO,
      },
    });
    check(signal);
    const full = weixinString(result.upload_full_url);
    const param = weixinString(result.upload_param);
    if (!full && !param) throw new MediaError("response");
    const url = cdnUrl(full || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`);
    const response = await cdnFetch(options.fetchImpl, url, signal, encrypted);
    const downloadParam = response.headers.get("x-encrypted-param")?.trim();
    void response.body?.cancel().catch(() => {});
    if (!downloadParam) throw new MediaError("response");
    check(signal);
    const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 };
    return isImage
      ? { type: 2, image_item: { media, mid_size: encrypted.length } }
      : { type: 4, file_item: { media, file_name: attachment.name, len: String(bytes.length) } };
  });
}
