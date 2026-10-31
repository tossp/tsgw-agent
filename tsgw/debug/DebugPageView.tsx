"use client";

import { useMemo, useState } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { SessionInfo } from "@/lib/types";
import { FolderIcon, SpinnerIcon } from "@/components/SidebarIcons";
import { sessionRowTitle } from "@/components/SessionTree";
import {
  DEBUG_POLL_FAILURE_KEYS, DEBUG_STATUS_KEYS, barFraction, debugServerClock, debugSessionTitle,
  debugStatusState, formatAgo, formatDebugSeconds, shortDebugId,
  type DebugServerClock, type DebugServerReading, type DebugSessionRow, type DebugStatusState, type DebugTitleOf, type Translate,
} from "@/components/debug-panel-state";
import { DebugSessionDetailView } from "./DebugSessionDetail";
import { DashboardArt } from "./DashboardArt";
import { DashboardOverview } from "./DashboardOverview";
import { ObserverPanel, type ObserverTelemetry } from "./ObserverPanel";
import { dashboardCounts, dashboardFreshness, dashboardGroups, dashboardIssues, filterDashboardGroups, type TaskFilter, type TaskSort } from "./dashboard-state";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

export interface DebugPageViewProps {
  server: DebugServerReading;
  now: number;
  hidden: boolean;
  sessions: readonly SessionInfo[];
  catalogError: boolean;
  catalogReceivedAt?: number | null;
  selectedSessionId: string | null;
  onToggleSession(id: string): void;
  onCopy(): void;
  copied: boolean;
  t: Translate;
  locale: Locale;
  telemetry?: ObserverTelemetry;
}

const FILTERS: TaskFilter[] = ["held", "running", "awaiting", "subagents"];
const detailElementId = (id: string) => `debug-session-${id}`;

/** Selection reads an existing debug query; it never activates a saved session. */
export function DebugPageView({ server, now, hidden, sessions, catalogError, selectedSessionId, onToggleSession, onCopy, copied, t, locale, telemetry, catalogReceivedAt }: DebugPageViewProps) {
  const [filter, setFilter] = useState<TaskFilter>("held");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [sort, setSort] = useState<TaskSort>("recent");
  const catalogMode = filter === "catalog";
  const reply = server.reply;
  const clock = reply !== null && server.receivedAt !== null ? debugServerClock(reply.now, server.receivedAt, now) : null;
  const byId = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
  const titleOf = useMemo<DebugTitleOf>(() => id => { const info = byId.get(id); return info ? sessionRowTitle(info) : null; }, [byId]);
  const allGroups = useMemo(() => dashboardGroups(reply, sessions), [reply, sessions]);
  const groups = useMemo(() => filterDashboardGroups(allGroups, filter, query, project, sort), [allGroups, filter, query, project, sort]);
  const projects = useMemo(() => [...new Map(allGroups.flatMap(group => {
    if (group.name === null) return [];
    const key = group.key.replace(/^catalog:/, "");
    const info = group.rows.find(row => row.info)?.info;
    return [[key, `${group.name} · ${info?.projectRoot ?? info?.cwd ?? key}`] as const];
  })).entries()].sort((a, b) => a[1].localeCompare(b[1])), [allGroups]);
  const detail = reply?.session?.sessionId === selectedSessionId ? reply.session : null;
  const shown = clock !== null ? detail : null;
  const selectedInfo = selectedSessionId === null ? null : byId.get(selectedSessionId);
  const selectedSummary = reply?.sessions.find(session => session.sessionId === selectedSessionId);
  const selectedRole = selectedSummary?.subagent || shown?.wrapper?.subagent || selectedInfo?.relation?.kind === "subagent"
    ? "dense.child" : selectedSummary || shown?.wrapper || selectedInfo ? "dense.main" : "board.unknown";
  const issues = dashboardIssues(shown);
  if (!server.failure && telemetry?.inFlightSince != null && now - telemetry.inFlightSince >= 2000) issues.push({ id: "slow-poll", kind: "slowPoll", tone: "warning", name: "", count: now - telemetry.inFlightSince });
  const counts = dashboardCounts(reply, sessions, allGroups);
  const freshness = dashboardFreshness(server, now, hidden);
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const verdict = freshness === "current" ? issues.some(issue => issue.tone === "error") ? "error" : issues.length > 0 ? "warning" : "ok" : freshness === "waiting" ? "waiting" : "warning";
  const nameOf = (id: string) => titleOf(id) ?? shortDebugId(id);
  const notices: { tone: "warning" | "error" | "dim"; text: string }[] = [];
  if (server.failure) {
    const reason = t(DEBUG_POLL_FAILURE_KEYS[server.failure.kind], { status: server.failure.status ?? "?" });
    notices.push({ tone: server.failure.kind === "timeout" ? "warning" : "error", text: server.receivedAt === null ? reason : text("page.stale", { reason, time: formatAgo(now - server.receivedAt, t) }) });
    if (server.consecutiveFailures > 1) notices.push({ tone: "warning", text: text("page.staleCount", { count: server.consecutiveFailures }) });
  }
  if (hidden) notices.push({ tone: "dim", text: t("debug.poll.hidden") });
  if (catalogError) notices.push({ tone: "warning", text: text("page.catalogFailed") });
  const metrics = [
    ["dense.ordinary", counts.ordinary, `${text("dense.ordinaryRunning")} ${counts.ordinaryRunning}`],
    ["board.subagents", counts.subagentResident, `${text("dense.childRunning")} ${counts.subagentRunning}`],
    ["board.running", counts.running, text("board.runtimeHint")], ["board.awaiting", counts.awaiting, text("board.runtimeHint")],
    ["board.held", counts.held, text("board.runtimeHint")], ["board.connections", reply?.server.sseTotal ?? null, text("board.runtimeHint")],
  ] as const;

  return <section className={styles.page} aria-label={text("board.title")}>
    <header className={styles.header}>
      <DashboardArt className={styles.art} />
      <div className={styles.brand}>
        <svg className={styles.brandMark} viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M8 18H56V24H47V49H40V24H25V39Q25 49 15 49H10V42H15Q18 42 18 38V24H8Z" fill="currentColor" /></svg>
        <div><span className={styles.eyebrow}>{text("board.brand")}</span><h1 className={styles.heading}>{text("board.title")}</h1></div>
        <span className={styles.catalogBadge}>{text("board.readOnly")}</span>
      </div>
      <div className={styles.headerMeta}>
        <span className={styles.clock}>{now > 0 ? new Date(now).toLocaleTimeString(locale, { hour12: false }) : "—"}</span>
        <span className={`${styles.verdict} ${styles[`verdict_${verdict}`]}`} role="status">{text(`board.${freshness}`)}{issues.length > 0 ? ` · ${text("board.attention", { count: issues.length })}` : ""}</span>
        <div className={styles.actions}><button type="button" className={styles.copy} onClick={onCopy} title={text("page.copyTitle")}>{copied ? t("debug.copied") : t("debug.copyJson")}</button><a className={styles.homeLink} href="/" target="_blank" rel="noopener noreferrer">{text("board.home")}</a></div>
      </div>
    </header>
    <div className={styles.metrics} aria-label={text("board.scope")}>
      {metrics.map(([label, value, hint], index) => <div className={`${styles.metric}${index === 0 ? ` ${styles.metricAccent}` : ""}`} key={label} title={reply ? hint : text("board.waiting")}>
        <span className={styles.metricLabel}>{text(label)}</span><strong className={styles.metricNumber}>{reply === null ? "—" : value ?? "—"}</strong>
        <span className={styles.metricHint}>{reply === null ? text("board.waiting") : hint}</span>
      </div>)}
    </div>
    <div className={styles.body}>
      <section className={styles.sessions} aria-label={text("board.tasks")}>
        <div className={styles.sessionHead}><h2 className={styles.sectionTitle}><span className={styles.sectionNumber}>01</span>{catalogMode ? text("dense.history") : text("board.tasks")}</h2><span className={styles.groupCount}>{text("board.shown", { count: groups.reduce((count, group) => count + group.rows.filter(row => !row.placeholder).length, 0) })}</span></div>
        <div className={styles.toolbar}>
          <input className={styles.search} type="search" aria-label={text("board.search")} placeholder={text("board.search")} value={query} onChange={event => setQuery(event.target.value)} />
          <select className={styles.select} aria-label={text("board.project")} value={project} onChange={event => setProject(event.target.value)}><option value="">{text("board.allProjects")}</option>{projects.map(([key, name]) => <option value={key} key={key}>{name}</option>)}</select>
          <select className={styles.select} aria-label={text("board.sort")} value={sort} onChange={event => setSort(event.target.value as TaskSort)}><option value="recent">{text("board.recent")}</option><option value="name">{text("board.byName")}</option></select>
          <div className={styles.filters} role="group" aria-label={text("board.tasks")}>{FILTERS.map(value => <button type="button" className={`${styles.filter}${filter === value ? ` ${styles.activeFilter}` : ""}`} aria-pressed={filter === value} onClick={() => setFilter(value)} key={value}>{text(`board.filter.${value}`)}</button>)}</div>
        </div>
        <div className={styles.taskScroll}>
          {groups.length === 0 && <p className={styles.noResults}>{reply === null ? t("debug.poll.waiting") : !catalogMode && counts.held === 0 ? text("dense.noRuntime") : text("board.noResults")}</p>}
          {groups.map(group => <div key={group.key} className={styles.group}>
            <div className={styles.groupHead}><FolderIcon size={12} /><span className={styles.groupName}>{group.name ?? t("debug.sessions.unlisted")}</span><span className={styles.groupCount}>{group.rows.filter(row => !row.placeholder).length}</span></div>
            <div className={styles.rowColumns} aria-hidden="true"><span>{text("board.tasks")}</span><span>{text("dense.reap")}</span></div>
            {group.rows.map(row => <SessionRowButton key={row.id} row={row} open={selectedSessionId === row.id} idleTimeoutMs={reply?.server.idleTimeoutMs ?? 0} clock={clock} titleOf={titleOf} t={t} locale={locale} onToggle={onToggleSession} />)}
          </div>)}
        </div>
        <div className={styles.catalogFooter}><button type="button" className={styles.filter} aria-pressed={catalogMode} onClick={() => { setFilter(catalogMode ? "held" : "catalog"); setQuery(""); }}>{catalogMode ? text("board.filter.held") : text("dense.history")} <span className={styles.catalogBadge}>{catalogReceivedAt == null ? "—" : counts.catalog}</span></button><span className={styles.scopeNote} title={text("dense.reapHint")}>{catalogMode ? text("board.catalogHint") : text("dense.reapHint")}</span></div>
      </section>
      <section className={styles.inspector} aria-label={text("dense.inspect")}>
        <div className={styles.sessionHead}><h2 className={styles.sectionTitle}><span className={styles.sectionNumber}>02</span>{text("dense.inspect")}</h2>{selectedSessionId !== null && <button className={styles.close} type="button" onClick={() => onToggleSession(selectedSessionId)} aria-label={text("dense.close")}>×</button>}</div>
        <div className={styles.inspectorScroll}>
          {selectedSessionId === null ? <p className={styles.noResults}>{text("dense.pick")}</p> : <>
            <div className={styles.inspectorName}><strong>{nameOf(selectedSessionId)}</strong><span className={styles.catalogBadge}>{text(selectedRole)}</span></div>
            {selectedInfo && <details className={styles.metadata}><summary>{selectedInfo.cwd}</summary><p className={styles.detailId}>{selectedInfo.id}</p><p className={styles.note}>{selectedInfo.branch}</p>
              {selectedInfo.relation?.kind === "subagent" && <><p className={styles.entryLine}>{text("board.parent", { name: nameOf(selectedInfo.relation.parentSessionId) })} · {selectedInfo.relation.profile} · {text("board.recordedStatus", { status: selectedInfo.relation.status })}</p><p className={styles.note}>{text("board.description", { text: selectedInfo.relation.description })}</p></>}
              {selectedInfo.relation?.kind === "fork" && <p className={styles.note}>{text("board.fork", { name: nameOf(selectedInfo.relation.originSessionId ?? selectedInfo.parentSessionId ?? "—") })}</p>}
              <p className={styles.note}>{text("board.modified", { time: new Date(selectedInfo.modified).toLocaleString(locale) })}</p>
            </details>}
            {!reply?.sessions.some(session => session.sessionId === selectedSessionId) && <p className={styles.scopeNote}>{text("board.catalogNote")}</p>}
            {shown !== null && clock !== null ? <DebugSessionDetailView detail={shown} clock={clock} titleOf={titleOf} t={t} locale={locale} id={detailElementId(selectedSessionId)} name={nameOf(selectedSessionId)} /> : <p className={styles.detailWaiting} id={detailElementId(selectedSessionId)}>{text("detail.waiting")}</p>}
          </>}
        </div>
      </section>
      <aside className={styles.overview}>
        <section className={`${styles.panel} ${styles.signals}`} aria-label={text("board.issues")}>
          <div className={styles.panelHead}><h2 className={styles.sectionTitle}>{text("board.issues")}</h2><span className={styles.catalogBadge}>{issues.length + notices.length}</span></div>
          <p className={styles.scopeNote}>{text("board.coverage")}</p>
          <ul className={styles.issueList} aria-live="polite">{notices.map((notice, index) => <li key={`notice:${index}`} className={`${styles.notice} ${styles[`notice_${notice.tone}`]}`}>{notice.text}</li>)}{issues.map(issue => <li key={issue.id} className={`${styles.issue} ${styles[`issue_${issue.tone}`]}`}>{text(`board.issue.${issue.kind}`, { name: issue.name, count: issue.count ?? 0 })}</li>)}</ul>
        </section>
        <ObserverPanel server={server} telemetry={telemetry} now={now} hidden={hidden} t={t} locale={locale} />
        {reply !== null && clock !== null && <DashboardOverview reply={reply} clock={clock} t={t} locale={locale} />}
        <details className={styles.limitations}><summary>{text("board.limits")}</summary><p>{text("board.limitClients")}</p><p>{text("board.limitTimers")}</p><p>{text("board.limitRuns")}</p></details>
      </aside>
    </div>
    <footer className={styles.footer}><span>PI / OPERATIONS · {text("board.footer")}</span><span title={text("board.catalogAge", { time: catalogReceivedAt == null ? "—" : formatAgo(now - catalogReceivedAt, t) })}>{text("dense.history")} {catalogReceivedAt == null ? "—" : formatAgo(now - catalogReceivedAt, t)}</span></footer>
  </section>;
}

const RING_CLASS: Record<Exclude<DebugStatusState, "running" | "awaiting">, string> = { alive: styles.ringAlive, closing: styles.ringClosing, none: styles.ringNone, starting: styles.ringStarting };

function SessionRowButton({ row, open, idleTimeoutMs, clock, titleOf, t, locale, onToggle }: {
  row: DebugSessionRow; open: boolean; idleTimeoutMs: number; clock: DebugServerClock | null; titleOf: DebugTitleOf; t: Translate; locale: Locale; onToggle(id: string): void;
}) {
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const summary = row.summary;
  const child = summary?.subagent || row.info?.relation?.kind === "subagent";
  const relation = row.info?.relation;
  const name = row.info ? sessionRowTitle(row.info) : titleOf(row.id) ?? shortDebugId(row.id);
  const remaining = summary?.nextIdleCheckAt != null && clock !== null ? clock.remaining(summary.nextIdleCheckAt) : null;
  const state = summary ? debugStatusState(summary) : null;
  const statusLabel = row.placeholder ? text("dense.context") : state ? t(DEBUG_STATUS_KEYS[state]) : text("board.catalogLabel");
  const checkLabel = remaining === null ? text("dense.noCheck") : remaining <= 0 ? text("dense.due") : formatDebugSeconds(remaining, t);
  return <button type="button" className={`${styles.row}${open ? ` ${styles.rowOpen}` : ""}${row.depth === 1 ? ` ${styles.rowSub}` : ""}${row.placeholder ? ` ${styles.contextRow}` : ""}`} aria-expanded={open} {...(open ? { "aria-controls": detailElementId(row.id) } : {})} onClick={() => onToggle(row.id)} title={summary ? debugSessionTitle(summary, remaining, t) : name}>
    <span className={styles.rowStatus}>{state === "running" ? <SpinnerIcon size={13} label={statusLabel} /> : state === "awaiting" ? <span className="session-tree-awaiting" role="img" aria-label={statusLabel} /> : <span className={`${styles.ring} ${state ? RING_CLASS[state] : styles.ringNone}`} role="img" aria-label={statusLabel} />}</span>
    <span className={styles.rowName}>
      <span className={styles.nameLine}>{row.depth === 1 && <span className={styles.rowBranch} aria-hidden="true" />}<span className={styles.nameText}>{name}</span>{summary !== null && summary.starts > 1 && <span className={styles.starts}>↻{summary.starts}</span>}</span>
      <span className={styles.rowBadges}><span className={`${styles.badge}${child ? ` ${styles.childBadge}` : ""}`}>{text(child ? "dense.child" : "dense.main")}</span><span className={styles.statusLabel}>{statusLabel}</span>{relation?.kind === "fork" && <span className={styles.badge}>{text("dense.fork")}</span>}{summary != null && summary.eventStreams > 0 && <span className={styles.badge}>SSE {summary.eventStreams}</span>}{summary != null && summary.providers > 0 && <span className={styles.badge}>{t("debug.box.provider")} {summary.providers}</span>}</span>
      {relation?.kind === "subagent" && <span className={styles.assignment} title={`${text("board.parent", { name: titleOf(relation.parentSessionId) ?? shortDebugId(relation.parentSessionId) })} · ${relation.description}`}>{relation.profile} · {relation.description} · {text("board.parent", { name: titleOf(relation.parentSessionId) ?? shortDebugId(relation.parentSessionId) })}</span>}
    </span>
    <span className={`${styles.rowIdle}${summary?.forcedByStop ? ` ${styles.forcedIdle}` : ""}`} title={text("dense.reapHint")}>
      <span className={styles.idleText}>{summary ? checkLabel : "—"}</span>
      {remaining !== null && idleTimeoutMs > 0 && <span className={styles.idleTrack} aria-hidden="true"><span style={{ width: `${(barFraction(remaining, idleTimeoutMs) ?? 0) * 100}%` }} /></span>}
      {summary?.forcedByStop && <span className={styles.forced} aria-label={t("debug.server.idleForced")}>Stop</span>}
    </span>
  </button>;
}
