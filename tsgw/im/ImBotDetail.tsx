"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ConfigButton, ConfigDetailStack, ConfigDetailTitle, ConfigField, ConfigNotice } from "@/components/SettingsUi";
import type { ImAction, ImBotView, ImConversation, ImSessionView } from "./types";
import { imRequest } from "./useImSettings";
import { parseImIds, type ImCopy } from "./im-ui";
import styles from "./im-settings.module.css";

export function ImTextField({ label, value, onChange, password = false, hint }: {
  label: string; value: string; onChange: (value: string) => void; password?: boolean; hint?: string;
}) {
  const id = useId();
  return <ConfigField label={<label htmlFor={id}>{label}</label>}>
    <input id={id} className={styles.input} type={password ? "password" : "text"} value={value}
      autoComplete="off" spellCheck={false} onChange={(event) => onChange(event.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
    {hint && <span id={`${id}-hint`} className={styles.hint}>{hint}</span>}
  </ConfigField>;
}

export function ImIdField({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint: string }) {
  const id = useId();
  return <ConfigField label={<label htmlFor={id}>{label}</label>}>
    <textarea id={id} className={styles.input} rows={2} value={value} spellCheck={false}
      onChange={(event) => onChange(event.target.value)} aria-describedby={`${id}-hint`} />
    <span id={`${id}-hint`} className={styles.hint}>{hint}</span>
  </ConfigField>;
}

export function ImFormActions({ reason, busy, children }: { reason?: string; busy: boolean; children: ReactNode }) {
  return <div className={styles.actions}>
    {children}
    {(busy || reason) && <span role="status" className={styles.hint}>{reason}</span>}
  </div>;
}

export function ImConversations({ bot, conversations, copy, busy, act }: {
  bot: ImBotView; conversations: ImConversation[]; copy: ImCopy; busy: boolean;
  act: (action: ImAction) => Promise<boolean>;
}) {
  const [sessions, setSessions] = useState<ImSessionView[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const scope = new AbortController();
    setSessions(null);
    setError("");
    void imRequest<{ sessions: ImSessionView[] }>(scope.signal, undefined, bot.cwd)
      .then((data) => { if (!scope.signal.aborted) setSessions(data.sessions); })
      .catch((cause) => { if (!scope.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => scope.abort();
  }, [bot.cwd, reload]);
  return <section className={styles.conversations}>
    <ConfigDetailTitle>{copy.conversations}</ConfigDetailTitle>
    <p className={styles.hint}>{copy.bindingHint}</p>
    {error && <ConfigNotice action={<ConfigButton size="small" onClick={() => setReload((value) => value + 1)}>{copy.retry}</ConfigButton>}>
      <span role="alert">{copy.sessionsFailed} {error}</span>
    </ConfigNotice>}
    {!error && !sessions && <p role="status" className={styles.hint}>{copy.loading}</p>}
    {!conversations.length && <p className={styles.hint}>{copy.noConversations}</p>}
    {conversations.map((conversation) => {
      const options = sessions ?? [];
      const current = options.find((session) => session.id === conversation.sessionId);
      return <div key={conversation.key} className={styles.conversation}>
        <strong>{conversation.title || conversation.chatId}</strong>
        <code className={styles.hint}>{conversation.chatId}{conversation.threadId ? ` / ${conversation.threadId}` : ""}</code>
        <label className={styles.hint}>{copy.session}
          <select className={styles.input} value={conversation.sessionId ?? ""} disabled={busy}
            onChange={(event) => void act({ action: "bind", conversationKey: conversation.key, sessionId: event.target.value || null })}>
            <option value="">{copy.newSession}</option>
            {conversation.sessionId && !current && <option value={conversation.sessionId}>{copy.currentSession}: {conversation.sessionId}</option>}
            {options.map((session) => <option key={session.id} value={session.id}>{session.title || session.id}</option>)}
          </select>
        </label>
      </div>;
    })}
    {busy && <p role="status" className={styles.hint}>{copy.saving}</p>}
  </section>;
}

export function ImBotDetail({ bot, conversations, copy, busy, act, onRemoved }: {
  bot: ImBotView; conversations: ImConversation[]; copy: ImCopy; busy: boolean;
  act: (action: ImAction) => Promise<boolean>; onRemoved: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [cwd, setCwd] = useState(bot.cwd);
  const [users, setUsers] = useState(bot.allowedUserIds.join(", "));
  const [chats, setChats] = useState(bot.allowedChatIds.join(", "));
  const [confirming, setConfirming] = useState(false);
  const allowedUserIds = parseImIds(users);
  const allowedChatIds = parseImIds(chats);
  const valid = Boolean(name.trim() && cwd.trim() && (bot.channel !== "telegram" || allowedUserIds.length));
  const changed = name.trim() !== bot.name || cwd.trim() !== bot.cwd
    || JSON.stringify(allowedUserIds) !== JSON.stringify(bot.allowedUserIds)
    || JSON.stringify(allowedChatIds) !== JSON.stringify(bot.allowedChatIds);
  const reason = busy ? copy.saving : !name.trim() || !cwd.trim() ? copy.required
    : !valid ? copy.tokenRequired : !changed ? copy.noChanges : "";
  return <ConfigDetailStack>
    <ConfigDetailTitle>{bot.name}</ConfigDetailTitle>
    <div role="status" className={styles.status}>{copy[bot.status.state]} · {bot.channel === "weixin" ? copy.weixin : copy.telegram}{bot.username ? ` · @${bot.username}` : ""}</div>
    {bot.status.error && <ConfigNotice><span role="alert">{bot.status.error}</span></ConfigNotice>}
    <fieldset className={styles.fields} disabled={busy}>
      <ImTextField label={copy.name} value={name} onChange={setName} />
      <ImTextField label={copy.cwd} value={cwd} onChange={setCwd} />
      {bot.channel === "telegram" ? <>
        <ImIdField label={copy.users} value={users} onChange={setUsers} hint={copy.idsHint} />
        <ImIdField label={copy.chats} value={chats} onChange={setChats} hint={copy.chatsHint} />
      </> : <p className={styles.hint}>{copy.ownerHint}</p>}
    </fieldset>
    <ImFormActions busy={busy} reason={reason}>
      <ConfigButton variant="primary" disabled={busy || !valid || !changed} onClick={() => void act({
        action: "update-bot", botId: bot.id, name: name.trim(), cwd: cwd.trim(), enabled: bot.enabled, allowedUserIds, allowedChatIds,
      })}>{copy.save}</ConfigButton>
      <ConfigButton disabled={busy} onClick={() => void act({ action: "update-bot", botId: bot.id,
        name: bot.name, cwd: bot.cwd, enabled: !bot.enabled, allowedUserIds: bot.allowedUserIds, allowedChatIds: bot.allowedChatIds,
      })}>{bot.enabled ? copy.stop : copy.start}</ConfigButton>
      <ConfigButton variant="danger" disabled={busy} onClick={() => setConfirming(true)}>{copy.remove}</ConfigButton>
    </ImFormActions>
    {confirming && <ConfigNotice action={<div className={styles.actions}>
      <ConfigButton variant="danger" disabled={busy} onClick={async () => { if (await act({ action: "remove-bot", botId: bot.id })) onRemoved(); }}>{copy.remove}</ConfigButton>
      <ConfigButton disabled={busy} onClick={() => setConfirming(false)}>{copy.cancel}</ConfigButton>
    </div>}>{copy.confirmRemove}</ConfigNotice>}
    {cwd.trim() !== bot.cwd && <p className={styles.hint}>{copy.projectChanged}</p>}
    <ImConversations key={bot.cwd} bot={bot} conversations={conversations} copy={copy} busy={busy} act={act} />
  </ConfigDetailStack>;
}
