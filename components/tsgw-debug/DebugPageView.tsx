"use client";

import { Fragment, useMemo } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { DebugSnapshotResponse } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { FolderIcon, SpinnerIcon } from "../SidebarIcons";
import { sessionRowTitle } from "../SessionTree";
import {
  DEBUG_POLL_FAILURE_KEYS,
  DEBUG_SOURCE_KIND_KEYS,
  DEBUG_STATUS_KEYS,
  barFraction,
  debugServerClock,
  debugSessionTitle,
  debugStatusState,
  formatAgo,
  formatCountdown,
  formatDebugDuration,
  formatDebugSeconds,
  groupDebugSessions,
  joinParts,
  shortDebugId,
  type DebugServerClock,
  type DebugServerReading,
  type DebugSessionRow,
  type DebugStatusState,
  type DebugTitleOf,
  type Translate,
} from "../debug-panel-state";
import { DebugSessionDetailView } from "./DebugSessionDetail";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

export interface DebugPageViewProps {
  /** The page's poll of `GET /api/agent/debug`: its last answer, which may be kept through a failure. */
  server: DebugServerReading;
  /** The browser's clock now, read by the page; nothing here ticks on its own. */
  now: number;
  /** The page is hidden: the page's poll pauses until it comes back. */
  hidden: boolean;
  /** The session catalog, for names and project groups; empty when it could not be read. */
  sessions: readonly SessionInfo[];
  /** The catalog could not be read: sessions are named by id. */
  catalogError: boolean;
  /** The one session whose details are open, or null; it is also the session the poll asks about. */
  selectedSessionId: string | null;
  /** A row was clicked: open it, or close it when it is the open one. */
  onToggleSession(id: string): void;
  onCopy(): void;
  copied: boolean;
  /** The app's translator, for the panel's own words (countdowns, states, MCP). */
  t: Translate;
  /** For this page's own strings (components/tsgw-debug/messages.ts). */
  locale: Locale;
}

const DETAIL_ID_PREFIX = "debug-session-";

/** The element id of one row's details, the row's `aria-controls`. */
function detailElementId(sessionId: string): string {
  return `${DETAIL_ID_PREFIX}${sessionId}`;
}

/**
 * The standalone Debug page (`/debug`): what the server holds overall and for the sessions it holds
 * something for, one session's details at a time. It is a view only — the page's controller polls
 * `GET /api/agent/debug`, owns the clock and the catalog and keeps the URL's session out of the
 * address — so it renders what it is handed and reports clicks. Read-only: it shows the server's
 * report, never this browser's own stream or lease, and never another window's.
 */
export function DebugPageView({
  server, now, hidden, sessions, catalogError, selectedSessionId, onToggleSession, onCopy, copied, t, locale,
}: DebugPageViewProps) {
  const reply = server.reply;
  const clock = reply !== null && server.receivedAt !== null ? debugServerClock(reply.now, server.receivedAt, now) : null;
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const titleOf = useMemo<DebugTitleOf>(() => (sessionId) => {
    const info = byId.get(sessionId);
    return info ? sessionRowTitle(info) : null;
  }, [byId]);
  // The ordering never depends on the open row: `currentId` stays null, so expanding one row cannot
  // move it under the pointer (or start the list moving while the answers change).
  const groups = useMemo(() => (reply ? groupDebugSessions(reply.sessions, byId, null) : null), [reply, byId]);
  // Only the answer about the session this page opened. A kept answer about a session it left is
  // dropped rather than shown under the new row.
  const detail = reply?.session && selectedSessionId !== null && reply.session.sessionId === selectedSessionId ? reply.session : null;
  const shown = detail !== null && clock !== null ? detail : null;
  const listed = shown !== null && groups !== null && groups.some((group) => group.rows.some((row) => row.id === shown.sessionId));
  const failure = server.failure;
  const readOnlyTitle = debugPageText(locale, "page.readOnly");
  const sessionsTitle = debugPageText(locale, "sessions.title");
  const nameOf = (sessionId: string) => titleOf(sessionId) ?? shortDebugId(sessionId);

  const notices: { tone: "warning" | "error" | "dim"; text: string }[] = [];
  if (failure) {
    const reason = t(DEBUG_POLL_FAILURE_KEYS[failure.kind], { status: failure.status ?? "?" });
    notices.push({
      tone: failure.kind === "timeout" ? "warning" : "error",
      // An answer kept from before the failure says so: stale data is never shown as current.
      text: server.receivedAt !== null
        ? debugPageText(locale, "page.stale", { reason, time: formatAgo(now - server.receivedAt, t) })
        : reason,
    });
    if (server.consecutiveFailures > 1) {
      notices.push({ tone: "warning", text: debugPageText(locale, "page.staleCount", { count: server.consecutiveFailures }) });
    }
  }
  if (hidden) notices.push({ tone: "dim", text: t("debug.poll.hidden") });
  if (reply === null && !failure) notices.push({ tone: "dim", text: t("debug.poll.waiting") });
  if (catalogError) notices.push({ tone: "warning", text: debugPageText(locale, "page.catalogFailed") });

  return (
    <section className={styles.page} aria-label={debugPageText(locale, "page.label")}>
      <header className={styles.header}>
        <h1 className={styles.heading} title={readOnlyTitle}>{t("debug.title")}</h1>
        <button type="button" className={styles.copy} onClick={onCopy} title={debugPageText(locale, "page.copyTitle")}>
          {copied ? t("debug.copied") : t("debug.copyJson")}
        </button>
      </header>

      {notices.length > 0 && (
        <ul className={styles.notices}>
          {notices.map((notice, index) => (
            <li key={`${notice.tone}:${index}`} className={`${styles.notice} ${styles[`notice_${notice.tone}`] ?? ""}`}>{notice.text}</li>
          ))}
        </ul>
      )}

      <div className={styles.body}>
        <section className={styles.overview} aria-label={t("debug.section.server")}>
          <h2 className={styles.sectionTitle}>{t("debug.section.server")}</h2>
          {reply !== null && clock !== null
            ? <ServerOverview reply={reply} clock={clock} t={t} />
            : <p className={styles.note}>{t("debug.poll.waiting")}</p>}
        </section>

        <section className={styles.sessions} aria-label={sessionsTitle}>
          <h2 className={styles.sectionTitle}>{sessionsTitle}</h2>
          {/* The open session the last answer still has, though its list no longer holds a row for
              it: shown apart and closable, so the details are not lost with the row. */}
          {shown !== null && !listed && selectedSessionId !== null && clock !== null && (
            <>
              <button
                type="button"
                className={`${styles.row} ${styles.rowOpen} ${styles.residual}`}
                aria-expanded
                aria-controls={detailElementId(selectedSessionId)}
                onClick={() => onToggleSession(selectedSessionId)}
                title={debugPageText(locale, "page.collapse")}
              >
                <span className={styles.rowStatus} />
                <span className={styles.rowName}><span className={styles.nameText}>{nameOf(selectedSessionId)}</span></span>
              </button>
              <p className={styles.note}>{debugPageText(locale, "page.residual")}</p>
              <DebugSessionDetailView
                detail={shown}
                clock={clock}
                titleOf={titleOf}
                t={t}
                locale={locale}
                id={detailElementId(selectedSessionId)}
                name={nameOf(selectedSessionId)}
              />
            </>
          )}
          {groups === null && <p className={styles.note}>{t("debug.poll.waiting")}</p>}
          {groups !== null && groups.length === 0 && shown === null && <p className={styles.note}>{t("debug.none")}</p>}
          {groups?.map((group) => (
            <div key={group.key} className={styles.group}>
              <div className={styles.groupHead}>
                {group.name !== null && <FolderIcon size={11} />}
                <span className={styles.groupName}>{group.name ?? t("debug.sessions.unlisted")}</span>
                <span className={styles.groupCount}>{group.rows.filter((row) => row.summary !== null).length}</span>
              </div>
              {group.rows.map((row) => {
                const open = selectedSessionId === row.id;
                const rowDetail = open ? shown : null;
                return (
                  <Fragment key={row.id}>
                    <SessionRowButton
                      row={row}
                      open={open}
                      idleTimeoutMs={reply?.server.idleTimeoutMs ?? 0}
                      clock={clock}
                      titleOf={titleOf}
                      t={t}
                      locale={locale}
                      onToggle={onToggleSession}
                    />
                    {open && rowDetail !== null && clock !== null && (
                      <DebugSessionDetailView
                        detail={rowDetail}
                        clock={clock}
                        titleOf={titleOf}
                        t={t}
                        locale={locale}
                        id={detailElementId(row.id)}
                        name={nameOf(row.id)}
                      />
                    )}
                    {/* Opened, but this answer is not about it (yet): the region stays, so the row's
                        aria-controls never points at nothing. No request is made for it here. */}
                    {open && rowDetail === null && (
                      <p className={styles.detailWaiting} id={detailElementId(row.id)}>{debugPageText(locale, "detail.waiting")}</p>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}

/** The process as a whole: how long it has run, what it holds, and the pages connected to it. */
function ServerOverview({ reply, clock, t }: { reply: DebugSnapshotResponse; clock: DebugServerClock; t: Translate }) {
  const global = reply.server;
  const timers = joinParts([
    t("debug.global.timers"),
    t("debug.global.timersValue", {
      idle: global.idleTimeoutMs > 0 ? formatDebugDuration(global.idleTimeoutMs, t) : t("debug.server.idleDisabled"),
      heartbeat: formatDebugDuration(global.heartbeatMs, t),
    }),
  ]);
  const terminals = global.terminals;
  const terminalsTitle = joinParts([
    `${t("debug.global.terminals")}: ${t("debug.global.terminalsValue", {
      count: terminals.count,
      listeners: terminals.listeners,
      detached: terminals.detached,
      exited: terminals.exited,
    })}`,
    terminals.nextCleanupAt !== null && t("debug.global.cleanup", { time: formatCountdown(clock.remaining(terminals.nextCleanupAt), t) }),
  ]);
  return (
    <>
      <div className={styles.facts}>
        <span className={`${styles.fact} ${styles.factLead}`} title={timers}>
          <span className={styles.factLabel}>{t("debug.global.uptime")}</span>
          <span className={styles.factValue}>{formatDebugDuration(clock.age(global.startedAt), t)}</span>
        </span>
        <span className={styles.fact} title={timers}>
          <span className={styles.factValue}>{t("debug.global.wrappersValue", { ...global.wrappers })}</span>
        </span>
        <span className={styles.fact}>
          <span className={styles.factValue}>{`SSE ${t("debug.global.streamTotal", { count: global.sseTotal })}`}</span>
        </span>
        <span className={styles.fact}>
          <span className={styles.factValue}>{`${t("debug.global.fileWatches")}: ${global.fileWatches}`}</span>
        </span>
        <span className={styles.fact} title={terminalsTitle}>
          <span className={styles.factValue}>{`${t("debug.global.terminals")}: ${terminals.count}`}</span>
        </span>
      </div>
      <PagesTable reply={reply} t={t} />
    </>
  );
}

/**
 * The pages holding streams on the server, one row each: the browser and system it reports, its
 * address, its page id and its streams by kind, with the server's total in the head. Nothing here
 * says which row is this browser's: this page has no way to know another page's id is not its own.
 */
function PagesTable({ reply, t }: { reply: DebugSnapshotResponse; t: Translate }) {
  const { pages, sseTotal } = reply.server;
  if (pages.length === 0) return <p className={styles.note}>{t("debug.none")}</p>;
  return (
    <div className={styles.pages}>
      <div className={`${styles.pageRow} ${styles.pagesHead}`}>
        <span className={styles.pagesTitle}>{`${t("debug.pages.title")} ${pages.length}`}</span>
        <span className={styles.num}>{`SSE ${t("debug.global.streamTotal", { count: sseTotal })}`}</span>
      </div>
      {pages.map((entry, index) => {
        const total = entry.agent + entry.terminal + entry.fileWatch;
        const kinds = joinParts([
          entry.agent > 0 && `${t(DEBUG_SOURCE_KIND_KEYS.agent)} ${entry.agent}`,
          entry.terminal > 0 && `${t(DEBUG_SOURCE_KIND_KEYS.terminal)} ${entry.terminal}`,
          entry.fileWatch > 0 && `${t(DEBUG_SOURCE_KIND_KEYS["file-watch"])} ${entry.fileWatch}`,
        ]);
        const holder = entry.holder === null ? t("debug.holder.none") : shortDebugId(entry.holder);
        return (
          <div
            key={`${entry.holder ?? ""}:${index}`}
            className={styles.pageRow}
            title={joinParts([holder, entry.client, entry.address, kinds, `SSE ${total}`])}
          >
            <span className={`${styles.pageClient}${entry.client ? "" : ` ${styles.faint}`}`}>{entry.client ?? t("debug.pages.unknownClient")}</span>
            <span className={styles.pageAddress}>{entry.address ?? "—"}</span>
            <span className={styles.pageHolder}>{holder}</span>
            <span className={styles.pageKinds}>{kinds}</span>
            <span className={styles.num}>{total}</span>
          </div>
        );
      })}
    </div>
  );
}

const RING_CLASS: Record<Exclude<DebugStatusState, "running" | "awaiting">, string> = {
  alive: styles.ringAlive,
  closing: styles.ringClosing,
  none: styles.ringNone,
  starting: styles.ringStarting,
};

/** A row's status slot: the sidebar's spinner while it runs, its awaiting dot, else a ring by state. */
function StatusSlot({ state, label }: { state: DebugStatusState; label: string }) {
  if (state === "awaiting") {
    return <span className={styles.statusSlot}><span className="session-tree-awaiting" role="img" aria-label={label} title={label} /></span>;
  }
  if (state === "running") {
    return <span className={styles.statusSlot} title={label}><SpinnerIcon size={12} label={label} /></span>;
  }
  return (
    <span className={styles.statusSlot} role="img" aria-label={label} title={label}>
      <span className={`${styles.ring} ${RING_CLASS[state] ?? ""}`} />
    </span>
  );
}

/**
 * One session the server holds something for, as a native button: Enter and Space open it, and
 * `aria-expanded` says whether its details are below. A second click on the open row closes it.
 */
function SessionRowButton({ row, open, idleTimeoutMs, clock, titleOf, t, locale, onToggle }: {
  row: DebugSessionRow;
  open: boolean;
  /** `PI_WEB_IDLE_TIMEOUT_MS` in effect; 0 = disabled. */
  idleTimeoutMs: number;
  clock: DebugServerClock | null;
  titleOf: DebugTitleOf;
  t: Translate;
  locale: Locale;
  onToggle(id: string): void;
}) {
  const summary = row.summary;
  const name = row.info ? sessionRowTitle(row.info) : titleOf(row.id) ?? shortDebugId(row.id);
  const remaining = summary !== null && summary.nextIdleCheckAt !== null && clock !== null ? clock.remaining(summary.nextIdleCheckAt) : null;
  const state = summary ? debugStatusState(summary) : null;
  const idleTitle = summary && remaining !== null
    ? joinParts([
      `${t("debug.server.idle")} ${formatDebugSeconds(remaining, t)}`,
      idleTimeoutMs > 0 && t("debug.server.idleTimeout", { time: formatDebugDuration(idleTimeoutMs, t) }),
      t(summary.forcedByStop ? "debug.server.idleForced" : "debug.server.idleHint"),
    ])
    : undefined;
  const forcedLabel = remaining !== null ? t("debug.overlay.closesIn", { time: formatDebugSeconds(remaining, t) }) : "";
  const idleShown = summary !== null && remaining !== null && (idleTimeoutMs > 0 || summary.forcedByStop);
  return (
    <button
      type="button"
      className={`${styles.row}${open ? ` ${styles.rowOpen}` : ""}${row.depth === 1 ? ` ${styles.rowSub}` : ""}`}
      aria-expanded={open}
      {...(open ? { "aria-controls": detailElementId(row.id) } : {})}
      onClick={() => onToggle(row.id)}
      title={joinParts([
        debugPageText(locale, open ? "page.collapse" : "page.expand"),
        summary ? debugSessionTitle(summary, remaining, t) : name,
      ])}
    >
      <span className={styles.rowStatus}>
        {state !== null && <StatusSlot state={state} label={t(DEBUG_STATUS_KEYS[state])} />}
      </span>
      <span className={styles.rowName}>
        {row.depth === 1 && <span className={styles.rowBranch} aria-hidden="true" />}
        <span className={styles.nameText}>{name}</span>
        {summary !== null && summary.starts > 1 && <span className={styles.starts}>{`↻${summary.starts}`}</span>}
      </span>
      <span className={styles.rowBadges}>
        {summary !== null && summary.eventStreams > 0 && (
          <span className={styles.badge} title={t("debug.overlay.streams", { count: summary.eventStreams })}>{`SSE ${summary.eventStreams}`}</span>
        )}
        {summary !== null && summary.providers > 0 && (
          <span className={styles.badge} title={t("debug.overlay.providers", { count: summary.providers })}>
            {`${t("debug.box.provider")} ${summary.providers}`}
          </span>
        )}
      </span>
      <span className={styles.rowIdle} title={idleTitle}>
        {idleShown && remaining !== null && (
          <>
            {idleTimeoutMs > 0 && (
              <span className={styles.idleTrack} aria-hidden="true">
                <span style={{ width: `${(barFraction(remaining, idleTimeoutMs) ?? 0) * 100}%` }} />
              </span>
            )}
            {summary.forcedByStop && <span className={styles.forced} role="img" aria-label={forcedLabel} title={forcedLabel} />}
            <span className={styles.idleText}>{formatDebugSeconds(remaining, t)}</span>
          </>
        )}
      </span>
    </button>
  );
}
