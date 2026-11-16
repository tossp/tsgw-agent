// Wire shape/version: @xmanrui/dsh-im 5.10.0 weixin-api.mjs.
// Cross-check: Tencent/openclaw-weixin src/api/api.ts and src/auth/login-qr.ts.
// Both MIT; the main integration records the corresponding copyright notices.
import { randomBytes } from "node:crypto";
import { credentialFetch } from "./credential-fetch";

export const WEIXIN_QR_BASE = "https://ilinkai.weixin.qq.com/";
export const WEIXIN_VERSION = "2.4.6";
export const WEIXIN_BASE_INFO = { channel_version: WEIXIN_VERSION, bot_agent: "TSGW-Agent/0.1.0" };

export class WeixinError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WeixinError";
  }
}

export function weixinRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function weixinString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function weixinAbort(): DOMException {
  // Never propagate an external signal.reason, which may contain credentials.
  return new DOMException("微信请求已取消。", "AbortError");
}

export function weixinUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = host === "weixin.qq.com" || host.endsWith(".weixin.qq.com")
      || host === "wechat.com" || host.endsWith(".wechat.com");
    if (url.protocol !== "https:" || !trusted || (url.port && url.port !== "443")
      || url.username || url.password) throw new Error();
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  } catch {
    throw new WeixinError("address", "微信服务地址无效。");
  }
}

interface RequestOptions {
  fetchImpl: typeof fetch;
  baseUrl: string;
  endpoint: string;
  token?: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowEmptyResponse?: boolean;
}

export async function weixinRequest({
  fetchImpl, baseUrl, endpoint, token, body, signal, timeoutMs = 15_000, allowEmptyResponse = false,
}: RequestOptions): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw weixinAbort();
  const url = new URL(endpoint, weixinUrl(baseUrl));
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const headers: Record<string, string> = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 6),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.AuthorizationType = "ilink_bot_token";
    headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await credentialFetch(fetchImpl, url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      // Do not forward credentials to a Location supplied by an HTTP redirect.
      redirect: "error",
    });
    if (signal?.aborted) throw weixinAbort();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new WeixinError("login", "微信登录已失效，请重新扫码。");
      }
      throw new WeixinError("http", "微信服务请求失败。");
    }
    let value: unknown;
    try {
      const text = await response.text();
      value = allowEmptyResponse && !text.trim() ? {} : JSON.parse(text, (key, item, context?: { source?: string }) => {
        // iLink message IDs are uint64; Number rounding would merge distinct messages.
        if (["message_id", "msg_id", "svr_id"].includes(key) && typeof item === "number"
          && context?.source && /^\d+$/.test(context.source)) return context.source;
        return item;
      });
    } catch { throw new WeixinError("response", "微信服务响应无效。"); }
    if (signal?.aborted) throw weixinAbort();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WeixinError("response", "微信服务响应无效。");
    }
    const result = weixinRecord(value);
    for (const key of ["ret", "errcode"]) {
      const code = result[key];
      if (code === -14 || code === "-14") {
        throw new WeixinError("login", "微信登录已失效，请重新扫码。");
      }
      if (code !== undefined && code !== 0 && code !== "0") {
        throw new WeixinError("rejected", "微信服务拒绝了请求。");
      }
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw weixinAbort();
    if (timedOut) throw new WeixinError("timeout", "微信服务请求超时。");
    if (error instanceof WeixinError) throw error;
    // No cause, URL, provider message, response body, or request headers escape.
    throw new WeixinError("network", "暂时无法访问微信服务。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
