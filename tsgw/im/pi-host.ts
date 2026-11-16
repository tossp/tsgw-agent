import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isOrdinarySession as ordinary, listSessionCatalog, projectSessions, sessionDirectoryKey as directoryKey } from "../session-management";
import type { AgentSessionWrapper } from "../../lib/rpc-manager";
import type { SessionInfo } from "../../lib/types";
import type { ImSessionHost } from "./host-types";
import { abortable, sendPiPrompt, waitForPiIdle } from "./pi-host-run";
import { registerImMessageSource } from "./message-source";
import type { ImMessageSource } from "./message-data";
import { collectWeixinReply, preparePiAttachments, WEIXIN_MEDIA_PROMPT } from "./pi-media";

type Wrapper = Pick<AgentSessionWrapper, "send" | "onEvent" | "isAlive" | "isRunning">;

/** Narrow I/O seam; tests exercise the real attribution/queue logic with scripted events. */
export interface PiHostAccess {
  list(): Promise<SessionInfo[]>;
  get(id: string): Promise<Wrapper | undefined>;
  start(id: string, file: string, cwd?: string): Promise<{ session: Wrapper; realSessionId: string }>;
  resolvePath(id: string): Promise<string | null>;
  allowRoot(cwd: string): Promise<void>;
  invalidateList(): Promise<void>;
  registerSource(wrapper: Wrapper, source: ImMessageSource): () => void;
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
  registerSource(wrapper, source) {
    // defaultAccess returns real wrappers; scripted tests use the narrow I/O seam.
    return registerImMessageSource((wrapper as AgentSessionWrapper).inner.sessionManager, source);
  },
};

// Only IM submissions are serialized here. Wrapper/SDK retain ownership of the actual session.
const QUEUES_KEY = Symbol.for("pi-web.im.host-session-queues");
// SAFETY: this private global symbol is only assigned the IM queue Map below; its
// entries contain completion promises, never AgentSession objects or message text.
const queues = ((globalThis as unknown as Record<symbol, Map<string, Promise<void>>>)[QUEUES_KEY] ??= new Map());

async function inSession<T>(id: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(id, tail);
  try {
    await abortable(previous, signal);
    signal.throwIfAborted();
    return await action();
  } finally {
    release();
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
  }
}

export function createPiSessionHost(access: PiHostAccess = defaultAccess): ImSessionHost {
  const find = async (id: string, cwd?: string) => (await access.list()).find((session) =>
    session.id === id && ordinary(session) && (cwd === undefined || directoryKey(session.cwd) === directoryKey(cwd)));

  return {
    async list(cwd) {
      return projectSessions(await access.list(), cwd)
        .map((session) => ({ id: session.id, title: session.name || session.firstMessage || session.id, cwd: session.cwd }));
    },
    async exists(id, cwd) { return Boolean(await find(id, cwd)); },
    async create(cwd) {
      // Preserve pi-autoname: a fixed /name here would disable normal automatic titles.
      const path = directoryKey(cwd);
      try {
        if (!statSync(path).isDirectory()) throw new Error();
      } catch { throw new Error("项目目录不存在或不可用。"); }
      let started;
      try { started = await access.start(`__new__${randomUUID()}`, "", path); }
      catch { throw new Error("无法创建 Pi 会话，请检查项目与模型配置。"); }
      await access.allowRoot(path);
      await access.invalidateList();
      return started.realSessionId;
    },
    async prompt(id, text, signal, source, attachments) {
      return inSession(id, signal, async () => {
        const info = await abortable(find(id), signal);
        if (!info) throw new Error("Pi 普通会话不存在或不可用，请重新绑定。");
        let wrapper = await abortable(access.get(id), signal);
        if (!wrapper?.isAlive()) {
          const file = await abortable(access.resolvePath(id), signal);
          if (!file) throw new Error("Pi 会话不存在或尚未保存，请重新绑定。");
          try {
            const started = await abortable(access.start(id, file), signal);
            if (started.realSessionId !== id) throw new Error();
            wrapper = started.session;
          } catch {
            signal.throwIfAborted();
            throw new Error("无法恢复 Pi 会话，请重新绑定或查看 Pi 会话。");
          }
        }
        await waitForPiIdle(wrapper, signal);
        const media = attachments?.length ? await abortable(preparePiAttachments(attachments, signal), signal) : undefined;
        if (media) {
          text += `\n\n${media.links}`;
          await waitForPiIdle(wrapper, signal);
        }
        if (source?.channel === "weixin") text += `\n\n${WEIXIN_MEDIA_PROMPT}`;
        // The marker belongs to this submission, even when two chats send identical text.
        // Prefixing also prevents IM text from executing extension slash commands.
        const requestId = randomUUID();
        const marker = `[IM request ${requestId}]`;
        const releaseSource = source ? access.registerSource(wrapper, { ...source, requestId }) : () => {};
        try {
          const answer = await sendPiPrompt(wrapper, `${marker}\n${text}`, marker, signal, media?.images);
          return source?.channel === "weixin"
            ? await abortable(collectWeixinReply(answer, info.cwd, signal), signal) : answer;
        } finally {
          releaseSource();
        }
      });
    },
    async stop(id) {
      const wrapper = await access.get(id);
      if (!wrapper?.isAlive()) return;
      if (!await find(id)) throw new Error("只能停止普通 Pi 会话。");
      try { await wrapper.send({ type: "abort" }); }
      catch { throw new Error("无法停止 Pi 会话，请查看会话状态。"); }
    },
  };
}
