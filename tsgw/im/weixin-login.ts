import type { WeixinCredentials } from "./types";
import { WEIXIN_QR_BASE, WeixinError, weixinAbort, weixinRequest, weixinString, weixinUrl } from "./weixin-transport";

export interface WeixinQrResult {
  state: "waiting" | "scanned" | "connected" | "expired";
  credentials?: WeixinCredentials;
}

interface WeixinLoginOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function serverBase(value: unknown, fallback: string): string {
  const raw = weixinString(value);
  return weixinUrl(raw ? (raw.includes("://") ? raw : `https://${raw}`) : fallback);
}

/** Stateful because scaned_but_redirect changes the host for later polls. */
export async function createWeixinLogin({ fetchImpl = fetch, signal }: WeixinLoginOptions = {}): Promise<{
  qrUrl: string;
  poll(): Promise<WeixinQrResult>;
}> {
  const qr = await weixinRequest({
    fetchImpl, baseUrl: WEIXIN_QR_BASE,
    endpoint: "ilink/bot/get_bot_qrcode?bot_type=3",
    body: { local_token_list: [] }, signal, timeoutMs: 10_000,
  });
  const qrcode = weixinString(qr.qrcode);
  const qrUrl = weixinString(qr.qrcode_img_content);
  if (!qrcode || !qrUrl) throw new WeixinError("qr", "微信服务未返回完整二维码。");
  // Validate the QR origin without rewriting its path or authorization query.
  weixinUrl(qrUrl);
  let baseUrl = WEIXIN_QR_BASE;
  const expiresAt = Date.now() + 5 * 60_000;
  let terminal: WeixinQrResult | undefined;
  let inFlight: Promise<WeixinQrResult> | undefined;

  async function pollOnce(): Promise<WeixinQrResult> {
    if (signal?.aborted) throw weixinAbort();
    if (terminal) return terminal;
    if (Date.now() >= expiresAt) return terminal = { state: "expired" };
    let response: Record<string, unknown>;
    try {
      response = await weixinRequest({
        fetchImpl, baseUrl,
        endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        signal, timeoutMs: 35_000,
      });
    } catch (error) {
      if (error instanceof WeixinError && error.code === "timeout") return { state: "waiting" };
      throw error;
    }
    switch (response.status) {
      case "wait": return { state: "waiting" };
      case "scaned": return { state: "scanned" };
      case "scaned_but_redirect":
        baseUrl = serverBase(response.redirect_host, baseUrl);
        return { state: "scanned" };
      case "expired": return terminal = { state: "expired" };
      case "confirmed": {
        const token = weixinString(response.bot_token);
        const accountId = weixinString(response.ilink_bot_id);
        const ownerUserId = weixinString(response.ilink_user_id);
        if (!token || !accountId || !ownerUserId) {
          throw new WeixinError("credentials", "微信登录返回的凭据不完整。");
        }
        return terminal = {
          state: "connected",
          credentials: { token, accountId, ownerUserId, baseUrl: serverBase(response.baseurl, baseUrl) },
        };
      }
      case "binded_redirect":
        throw new WeixinError("bound", "微信账号已绑定，请使用已有机器人或解除绑定后重新扫码。");
      case "verify_code_blocked":
        throw new WeixinError("verification", "微信配对验证受限，请重新扫码。");
      default:
        if (weixinString(response.status).includes("need_verifycode")) {
          throw new WeixinError("verification", "微信要求输入配对码，当前扫码流程暂不支持。");
        }
        throw new WeixinError("qr-state", "微信服务返回了未知扫码状态。");
    }
  }

  return {
    qrUrl,
    poll() {
      // Concurrent browser polls must share the same host transition.
      return inFlight ??= pollOnce().finally(() => { inFlight = undefined; });
    },
  };
}
