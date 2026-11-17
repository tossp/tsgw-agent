import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";
import { ImStore } from "./store";
import { ImRuntime } from "./runtime";
import { ImService, projectDirectory } from "./service";
import { parseImAction } from "./actions";
import { createTelegramDriver, verifyTelegramToken } from "./telegram";
import { describeTelegramBot } from "./telegram-setup";
import { createWeixinDriver } from "./weixin";
import { createWeixinLogin } from "./weixin-login";
import { createPiSessionHost } from "./pi-host";
import { reportImError } from "./telemetry";

const SERVICE_KEY = Symbol.for("pi-web.im.service");
type ServiceGlobal = typeof globalThis & { [SERVICE_KEY]?: Promise<ImService> };

async function createService(): Promise<ImService> {
  const store = await ImStore.open(join(getAgentDir(), "integrations", "im", "state.json"));
  const runtime = new ImRuntime(store, createPiSessionHost(), {
    telegram: createTelegramDriver,
    weixin: createWeixinDriver,
  }, describeTelegramBot);
  const service = new ImService(runtime, {
    verifyTelegram: (token) => verifyTelegramToken(token),
    createWeixinLogin: (signal) => createWeixinLogin({ signal }),
    qrImage: (url) => QRCode.toDataURL(url, { width: 280, margin: 2 }),
  });
  const shutdown = () => { void service.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.start();
  return service;
}

export function getImService(): Promise<ImService> {
  const root = globalThis as ServiceGlobal;
  if (!root[SERVICE_KEY]) {
    const pending = createService().catch((error) => {
      reportImError("initialize");
      if (root[SERVICE_KEY] === pending) delete root[SERVICE_KEY];
      throw error;
    });
    root[SERVICE_KEY] = pending;
  }
  return root[SERVICE_KEY];
}

export async function handleImGet(request: Request): Promise<Response> {
  let service: ImService | undefined;
  try {
    service = await getImService();
    const cwd = new URL(request.url).searchParams.get("cwd");
    return Response.json(cwd
      ? { sessions: await service.runtime.host.list(await projectDirectory(cwd)) }
      : await service.runtime.snapshot(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    if (service) reportImError("settings-read");
    return Response.json({ error: "无法读取 IM 配置或项目会话，请检查配置文件与目录权限。" }, { status: 500 });
  }
}

export async function handleImPost(request: Request): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "请求必须是有效的 JSON。" }, { status: 400 });
  }
  let action;
  try {
    action = parseImAction(input);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "请求格式无效。" }, { status: 400 });
  }
  try {
    const service = await getImService();
    return Response.json(await service.action(action), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Filesystem failures are internal, even though the existing management API returns 400.
    if (error instanceof Error && "syscall" in error) reportImError("settings-action");
    // Platform drivers return sanitized messages; never serialize request bodies or credentials.
    return Response.json({ error: error instanceof Error ? error.message : "IM 操作失败，请检查配置或网络。" }, { status: 400 });
  }
}
