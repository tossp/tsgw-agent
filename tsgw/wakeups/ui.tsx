"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { isPlainActivation, sessionDeepLink } from "@/lib/session-links";
import type { Locale } from "@/lib/i18n/types";
import type { WakeupHealth, WakeupQueryItem, WakeupQueryResult } from "./types";
import { mergeWakeupRows, showWakeupTrigger, wakeupCounts, wakeupStatusText, wakeupText, wakeupTime } from "./ui-view";
import styles from "./ui.module.css";

const POLL_MS = 2500;
const READ_TIMEOUT_MS = 10000;

async function readWakeups(url: string, signal: AbortSignal): Promise<WakeupQueryResult> {
  const response = await fetch(url, { method: "GET", cache: "no-store", signal });
  if (!response.ok) throw new Error("Wakeup read failed");
  const result: WakeupQueryResult = await response.json();
  if (!Array.isArray(result.items) || !result.health || !(result.nextCursor === null || typeof result.nextCursor === "string")) {
    throw new Error("Invalid wakeup response");
  }
  return result;
}

type ListState = { items: WakeupQueryItem[]; health?: WakeupHealth; nextCursor: string | null; loading: boolean; failed: boolean };

function useWakeupList(sessionId: string, refreshKey: string | number | undefined, open: boolean) {
  const [state, setState] = useState<ListState>({ items: [], nextCursor: null, loading: false, failed: false });
  const snapshot = useRef(state);
  const pageCount = useRef(1);
  const actions = useRef<{ read: (more?: boolean) => void; cancel: () => void } | null>(null);

  useEffect(() => {
    let alive = true;
    let current: AbortController | undefined;
    let busy = false;
    const cancel = () => { current?.abort(); current = undefined; busy = false; };
    const update = (patch: Partial<ListState>) => {
      if (!alive) return;
      snapshot.current = { ...snapshot.current, ...patch };
      setState(snapshot.current);
    };
    const read = async (more = false) => {
      if (busy || (more && !snapshot.current.nextCursor)) return;
      const controller = new AbortController();
      current = controller;
      busy = true;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
      update({ loading: true });
      try {
        const items: WakeupQueryItem[] = [];
        let cursor = more ? snapshot.current.nextCursor : null;
        let result: WakeupQueryResult;
        // Refresh all loaded pages, retaining the same rows and open details.
        const pages = more ? 1 : pageCount.current;
        for (let page = 0; page < pages; page++) {
          const query = new URLSearchParams({ session_id: sessionId, limit: "50" });
          if (cursor) query.set("cursor", cursor);
          result = await readWakeups(`/api/tsgw/wakeups?${query}`, controller.signal);
          if (!alive || current !== controller || controller.signal.aborted) return;
          items.push(...result.items);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (!alive || current !== controller || controller.signal.aborted) return;
        if (more) pageCount.current++;
        update({ items: mergeWakeupRows(snapshot.current.items, items), nextCursor: cursor, health: result!.health, failed: false });
      } catch {
        if (alive && current === controller && (!controller.signal.aborted || timedOut)) update({ failed: true });
      } finally {
        clearTimeout(timeout);
        if (alive && current === controller) { busy = false; current = undefined; update({ loading: false }); }
      }
    };
    actions.current = { read: (more) => { void read(more); }, cancel: () => { cancel(); update({ loading: false }); } };
    void read();
    return () => { alive = false; cancel(); actions.current = null; };
  }, [sessionId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(interval);
      if (document.visibilityState === "hidden") { actions.current?.cancel(); return; }
      actions.current?.read();
      interval = setInterval(() => actions.current?.read(), POLL_MS);
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      actions.current?.cancel();
    };
  }, [open, refreshKey]);

  return { ...state, refresh: () => actions.current?.read(), more: () => actions.current?.read(true) };
}

function Health({ health, locale }: { health: WakeupHealth; locale: Locale }) {
  return <div className={styles.health} data-alert={health.state !== "ready" || undefined}>
    <span>{wakeupText(locale, health.state)}</span>
    {health.reason && <details className={styles.diagnostics}>
      <summary>{wakeupText(locale, "diagnostics")}</summary>
      <p>{health.reason}</p>
    </details>}
  </div>;
}

type WakeupPanelProps = {
  sessionId: string; refreshKey?: string | number; compact?: boolean;
  open: boolean; onToggle: () => void; onClose: () => void; panelHost: HTMLElement | null;
  onOpenResponse?: (sessionId: string, entryId: string) => boolean;
};

function WakeupDetail({ item: current, locale }: { item: WakeupQueryItem; locale: Locale }) {
  const wakeupId = current.wakeupId;
  const [detail, setDetail] = useState<WakeupQueryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    readWakeups(`/api/tsgw/wakeups/${encodeURIComponent(wakeupId)}`, controller.signal).then(result => {
      if (alive && !controller.signal.aborted) { setDetail(result); setFailed(false); }
    }).catch(() => { if (alive) setFailed(true); }).finally(() => clearTimeout(timeout));
    return () => { alive = false; clearTimeout(timeout); controller.abort(); };
  }, [wakeupId, retry]);
  if (failed) return <p role="status">{wakeupText(locale, "detailFailed")} <button type="button" onClick={() => { setFailed(false); setRetry(value => value + 1); }}>{wakeupText(locale, "retry")}</button></p>;
  if (!detail) return <p role="status">{wakeupText(locale, "loading")}</p>;
  // Handoff text is immutable; observation facts come from the refreshed row.
  const item = detail.items[0] ? { ...current, message: detail.items[0].message } : undefined;
  if (!item) return <p>{wakeupText(locale, "missing")}</p>;
  return <div className={styles.detail}>
    <h4>{wakeupText(locale, "message")}</h4>
    <p className={styles.message}>{item.message ?? wakeupText(locale, "missing")}</p>
    <dl className={styles.facts}>
      {([ ["created", item.createdAt], ["received", item.receivedAt], ["settled", item.settledAt] ] as const).map(([label, at]) => at &&
        <div key={label}><dt>{wakeupText(locale, label)}</dt><dd><time dateTime={at}>{wakeupTime(locale, at)}</time></dd></div>)}
    </dl>
    {item.error && <p className={styles.notice}>{item.error}</p>}
  </div>;
}

/** A card's native details element keeps its disclosure and focus across list refreshes. */
export function WakeupRow({ item, locale, onOpenResponse, onNavigate }: {
  item: WakeupQueryItem; locale: Locale; onOpenResponse?: WakeupPanelProps["onOpenResponse"]; onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <li className={styles.row} data-wakeup-id={item.wakeupId}>
    <div className={styles.rowHeading}>
      <h3>{item.summary}</h3>
      <span className={styles.status} data-alert={["unknown", "delivery_failed", "run_aborted"].includes(item.status) || undefined}>{wakeupStatusText(locale, item.status)}</span>
    </div>
    <dl className={styles.facts}>
      <div><dt>{wakeupText(locale, "project")}</dt><dd>{item.cwd || wakeupText(locale, "noProject")}</dd></div>
      <div><dt>{wakeupText(locale, "scheduled")}</dt><dd><time dateTime={item.scheduledAt}>{wakeupTime(locale, item.scheduledAt)}</time></dd></div>
      <div><dt>{wakeupText(locale, "updated")}</dt><dd><time dateTime={item.updatedAt}>{wakeupTime(locale, item.updatedAt)}</time></dd></div>
    </dl>
    {item.status === "pending" && <p className={styles.notice} data-alert={!item.armed || undefined}>{wakeupText(locale, item.armed ? "armed" : "unarmed")}</p>}
    {item.unsaved && <p className={styles.notice} data-alert>{wakeupText(locale, "unsaved")}</p>}
    <div className={styles.links}>
      <a href={sessionDeepLink(item.sourceSessionId)}>{wakeupText(locale, "source")}</a>
      <a href={sessionDeepLink(item.targetSessionId)}>{wakeupText(locale, "target")}</a>
      {item.responseEntryIds?.map((entryId, index) => <a key={entryId} href={sessionDeepLink(item.targetSessionId)} onClick={event => {
        if (isPlainActivation(event) && onOpenResponse?.(item.targetSessionId, entryId)) {
          event.preventDefault(); onNavigate?.();
        }
      }}>{wakeupText(locale, "response")} {index + 1}</a>)}
    </div>
    <details className={styles.disclosure} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{wakeupText(locale, "details")}</summary>
      {expanded && <WakeupDetail item={item} locale={locale} />}
    </details>
  </li>;
}

function WakeupPanel({ sessionId, refreshKey, onOpenResponse, compact, open, onToggle, onClose, panelHost }: WakeupPanelProps) {
  const { locale } = useI18n();
  const data = useWakeupList(sessionId, refreshKey, open);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => {
    onClose();
    trigger.current?.focus({ preventScroll: true });
  }, [onClose]);

  useEffect(() => {
    if (!open || !panelHost) return;
    const node = panel.current;
    const opener = trigger.current;
    closeButton.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.composedPath().some(target => target === node || target === opener)) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      if ((document.activeElement === document.body || node?.contains(document.activeElement)) && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open, panelHost, close, onClose]);

  if (!open && !showWakeupTrigger(data.items, data.health, data.failed)) return null;
  const counts = wakeupCounts(data.items);
  const countLabel = [counts.active ? `${counts.active} ${wakeupText(locale, "active")}` : "", counts.unknown ? `${counts.unknown} ${wakeupText(locale, "verify")}` : ""].filter(Boolean).join(" · ");
  const hasAlert = data.failed || (data.health && data.health.state !== "ready") || data.items.some(item => item.unsaved || item.status === "unknown" || (item.status === "pending" && !item.armed));
  const quantity = `${data.items.length}${data.nextCursor ? "+" : ""}`;
  const label = `${wakeupText(locale, "title")} · ${quantity}${countLabel ? ` · ${countLabel}` : ""}${hasAlert ? " !" : ""}`;
  return <>
    <button type="button" ref={trigger} className={styles.trigger} aria-expanded={open} aria-controls={open ? id : undefined}
      aria-label={label} title={label} data-compact={compact || undefined} data-alert={hasAlert || undefined}
      data-active={counts.active > 0 || undefined} onClick={onToggle}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M8 2H4v4M16 2h4v4" /></svg>
      <span className={styles.triggerLabel}>{wakeupText(locale, "title")}</span>
      <span className={styles.badge} aria-hidden="true">{quantity}{hasAlert ? "!" : ""}</span>
    </button>
    {open && panelHost && createPortal(<section id={id} ref={panel} className={styles.panel} role="region" aria-labelledby={`${id}-title`}>
      <header className={styles.header}><h2 id={`${id}-title`}>{label}</h2>
        <button type="button" ref={closeButton} onClick={close}>{wakeupText(locale, "close")}</button>
      </header>
      <div className={styles.body}>
        {data.health && <Health health={data.health} locale={locale} />}
        <p className={styles.semantics}>{wakeupText(locale, "semantics")}</p>
        {data.failed && <p className={styles.notice} role="status">{wakeupText(locale, "readFailed")} <button type="button" onClick={data.refresh}>{wakeupText(locale, "retry")}</button></p>}
        {!data.items.length && !data.failed && <p role="status">{wakeupText(locale, data.loading ? "loading" : "empty")}</p>}
        <ul className={styles.list}>{data.items.map(item => <WakeupRow key={item.wakeupId} item={item} locale={locale} onOpenResponse={onOpenResponse} onNavigate={close} />)}</ul>
        {data.nextCursor && <button type="button" className={styles.more} disabled={data.loading} onClick={data.more}>{wakeupText(locale, data.loading ? "loading" : "loadMore")}</button>}
      </div>
    </section>, panelHost)}
  </>;
}

/** Mount once in the selected session's toolbar; refreshKey reuses the host's refresh opportunities. */
export function WakeupPanelTrigger(props: WakeupPanelProps) {
  return <WakeupPanel key={props.sessionId} {...props} />;
}
