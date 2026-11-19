"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ConfigButton, ConfigDetailStack, ConfigDetailTitle, ConfigField, ConfigNotice } from "@/components/SettingsUi";
import type { ImAction, ImBotView, ImConversation, ImSessionView } from "./types";
import { imRequest } from "./useImSettings";
import type { ImCopy } from "./im-ui";
import styles from "./im-settings.module.css";

export function ImTextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return <ConfigField label={<label htmlFor={id}>{label}</label>}>
    <input id={id} className={styles.input} type="text" value={value} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
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
  const [confirming, setConfirming] = useState(false);
  const valid = Boolean(name.trim() && cwd.trim());
  const changed = name.trim() !== bot.name || cwd.trim() !== bot.cwd;
  const reason = busy ? copy.saving : !valid ? copy.required : !changed ? copy.noChanges : "";
  return <ConfigDetailStack>
    <ConfigDetailTitle>{bot.name}</ConfigDetailTitle>
    <div role="status" className={styles.status}>{copy[bot.status.state]} · {copy.weixin}</div>
    {bot.status.error && <ConfigNotice><span role="alert">{bot.status.error}</span></ConfigNotice>}
    {bot.deliveryError && <ConfigNotice><span role="alert">{bot.deliveryError}</span></ConfigNotice>}
    <fieldset className={styles.fields} disabled={busy}>
      <ImTextField label={copy.name} value={name} onChange={setName} />
      <ImTextField label={copy.cwd} value={cwd} onChange={setCwd} />
      <p className={styles.hint}>{copy.ownerHint}</p>
    </fieldset>
    <ImFormActions busy={busy} reason={reason}>
      <ConfigButton variant="primary" disabled={busy || !valid || !changed} onClick={() => void act({
        action: "update-bot", botId: bot.id, name: name.trim(), cwd: cwd.trim(), enabled: bot.enabled,
      })}>{copy.save}</ConfigButton>
      <ConfigButton disabled={busy} onClick={() => void act({ action: "update-bot", botId: bot.id,
        name: bot.name, cwd: bot.cwd, enabled: !bot.enabled,
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
