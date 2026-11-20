import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isOrdinarySession, listSessionCatalog, projectSessions, sessionDirectoryKey, withNotificationAdmission, type NotificationWrapper } from "../session-management";
import type { AgentSessionWrapper } from "../../lib/rpc-manager";
import type { SessionInfo } from "../../lib/types";
import type { ImSessionHost } from "./host-types";
import { makeImNotification, type ImReplyHandle } from "./notification";

type Wrapper = NotificationWrapper & Pick<AgentSessionWrapper, "send">
  & { inner: Pick<AgentSession, "sendCustomMessage"> };

export interface PiHostAccess {
  list(): Promise<SessionInfo[]>;
  get(id: string): Promise<Wrapper | undefined>;
  start(id: string, file: string, cwd?: string): Promise<{ session: Wrapper; realSessionId: string }>;
  resolvePath(id: string): Promise<string | null>;
  allowRoot(cwd: string): Promise<void>;
  invalidateList(): Promise<void>;
}

const defaultAccess: PiHostAccess = {
  list: listSessionCatalog,
  async get(id) { return (await import("../../lib/rpc-manager")).getRpcSession(id); },
  async start(id, file, cwd) {
    return (await import("../../lib/rpc-manager")).startRpcSession(id, file, cwd,
      file ? { requireExistingSession: true } : {});
  },
  async resolvePath(id) { return (await import("../../lib/session-reader")).resolveSessionPath(id); },
  async allowRoot(cwd) { (await import("../../lib/file-access")).allowFileRoot(cwd); },
  async invalidateList() { (await import("../../lib/session-reader")).invalidateSessionListCache(); },
};

export function createPiSessionHost(access: PiHostAccess = defaultAccess): ImSessionHost {
  const find = async (id: string, cwd: string) => projectSessions(await access.list(), cwd).find((session) => session.id === id);

  return {
    async list(cwd) {
      return projectSessions(await access.list(), cwd)
        .map((session) => ({ id: session.id, title: session.name || session.firstMessage || session.id, cwd: session.cwd }));
    },
    async exists(id, cwd) { return Boolean(await find(id, cwd)); },
    async create(cwd) {
      const path = sessionDirectoryKey(cwd);
      if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error("项目目录不存在或不可用。");
      await access.allowRoot(path);
      const started = await access.start(`__new__${randomUUID()}`, "", path);
      await access.invalidateList();
      return started.realSessionId;
    },
    async notify(handle: ImReplyHandle, cwd, input, signal) {
      const id = handle.sessionId;
      if (!await find(id, cwd)) throw new Error("Pi 普通会话不存在或不属于当前项目。");
      const notification = await makeImNotification(handle, input, signal);
      let wrapper = await access.get(id);
      if (!wrapper?.isAlive()) {
        const file = await access.resolvePath(id);
        if (!file) throw new Error("Pi 会话不存在或尚未保存。");
        signal.throwIfAborted();
        const started = await access.start(id, file);
        if (started.realSessionId !== id) throw new Error("无法恢复原 Pi 会话。");
        wrapper = started.session;
      }
      const target = wrapper;
      // While idle completion covers the run. The IM queue only waits for submission.
      return withNotificationAdmission(target, { signal }, () => ({
        completion: target.inner.sendCustomMessage(notification, { triggerTurn: true, deliverAs: "followUp" }),
      }));
    },
    async stop(id) {
      const wrapper = await access.get(id);
      if (!wrapper?.isAlive() || !(await access.list()).some((session) => session.id === id && isOrdinarySession(session))) return;
      await wrapper.send({ type: "abort" });
    },
  };
}
