"use client";

import { useMemo } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { SessionInfo } from "@/lib/types";
import { sessionRowTitle } from "@/components/SessionTree";
import {
  DEBUG_POLL_FAILURE_KEYS, debugServerClock, formatAgo, shortDebugId,
  type DebugServerReading, type DebugTitleOf, type Translate,
} from "@/components/debug-panel-state";
import { ResourceBoard } from "./ResourceBoard";
import type { ResourceReadings } from "./resource-observer";
import type { LiveModelReadings } from "./live-model-observer";
import { DashboardArt } from "./DashboardArt";
import { DashboardOverview } from "./DashboardOverview";
import { ObserverPanel, type ObserverTelemetry } from "./ObserverPanel";
import { dashboardCounts, dashboardFreshness, dashboardGroups, dashboardIssues, filterDashboardGroups } from "./dashboard-state";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

export interface DebugPageViewProps {
  server: DebugServerReading;
  now: number;
  hidden: boolean;
  sessions: readonly SessionInfo[];
  onCopy(): void;
  copied: boolean;
  t: Translate;
  locale: Locale;
  telemetry?: ObserverTelemetry;
  resources?: ResourceReadings;
  liveModels?: LiveModelReadings;
}

/** Only resident families render resources; the session directory supplies metadata. */
export function DebugPageView({ server, now, hidden, sessions, onCopy, copied, t, locale, telemetry, resources = {}, liveModels = {} }: DebugPageViewProps) {
  const reply = server.reply;
  const clock = reply !== null && server.receivedAt !== null ? debugServerClock(reply.now, server.receivedAt, now) : null;
  const byId = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
  const titleOf = useMemo<DebugTitleOf>(() => id => { const info = byId.get(id); return info ? sessionRowTitle(info) : null; }, [byId]);
  const allGroups = useMemo(() => dashboardGroups(reply, sessions), [reply, sessions]);
  const groups = useMemo(() => filterDashboardGroups(allGroups, "held", "", "", "recent"), [allGroups]);
  const resident = new Set(reply?.sessions.map(session => session.sessionId));
  const issues = Object.entries(resources).filter(([id]) => resident.has(id)).flatMap(([id, reading]) => dashboardIssues(reading.reply?.session?.sessionId === id ? reading.reply.session : null).map(issue => ({ ...issue, id: `${id}:${issue.id}`, source: titleOf(id) ?? shortDebugId(id) })));
  if (!server.failure && telemetry?.inFlightSince != null && now - telemetry.inFlightSince >= 2000) issues.push({ id: "slow-poll", kind: "slowPoll", tone: "warning", name: "", count: now - telemetry.inFlightSince, source: "" });
  const counts = dashboardCounts(reply, sessions, allGroups);
  const freshness = dashboardFreshness(server, now, hidden);
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const verdict = freshness === "current" ? issues.some(issue => issue.tone === "error") ? "error" : issues.length > 0 ? "warning" : "ok" : freshness === "waiting" ? "waiting" : "warning";
  const notices: { tone: "warning" | "error" | "dim"; text: string }[] = [];
  if (server.failure) {
    const reason = t(DEBUG_POLL_FAILURE_KEYS[server.failure.kind], { status: server.failure.status ?? "?" });
    notices.push({ tone: server.failure.kind === "timeout" ? "warning" : "error", text: server.receivedAt === null ? reason : text("page.stale", { reason, time: formatAgo(now - server.receivedAt, t) }) });
    if (server.consecutiveFailures > 1) notices.push({ tone: "warning", text: text("page.staleCount", { count: server.consecutiveFailures }) });
  }
  if (hidden) notices.push({ tone: "dim", text: t("debug.poll.hidden") });
  if (telemetry?.catalog?.failed) notices.push({ tone: "warning", text: text("page.catalogFailed") });
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
      <aside className={styles.overview}>
        <section className={`${styles.panel} ${styles.signals}`} aria-label={text("board.issues")} title={text("resource.scope")}>
          <div className={styles.panelHead}><h2 className={styles.sectionTitle}>{text("board.issues")}</h2><span className={styles.catalogBadge}>{issues.length + notices.length}</span></div>
          <ul className={styles.issueList} aria-live="polite">{notices.map((notice, index) => <li key={`notice:${index}`} className={`${styles.notice} ${styles[`notice_${notice.tone}`]}`}>{notice.text}</li>)}{issues.map(issue => <li key={issue.id} className={`${styles.issue} ${styles[`issue_${issue.tone}`]}`}>{issue.source && <strong>{issue.source} · </strong>}{text(`board.issue.${issue.kind}`, { name: issue.name, count: issue.count ?? 0 })}</li>)}</ul>
        </section>
        <ObserverPanel server={server} telemetry={telemetry} now={now} hidden={hidden} t={t} locale={locale} />
        {reply !== null && clock !== null && <DashboardOverview reply={reply} clock={clock} t={t} locale={locale} />}
      </aside>
      <ResourceBoard groups={groups} residentIds={resident} resources={resources} liveModels={liveModels} now={now} summaryClock={clock} idleTimeoutMs={reply?.server.idleTimeoutMs ?? 0} titleOf={titleOf} t={t} locale={locale} />
    </div>
    <footer className={styles.footer}><span>PI / OPERATIONS · {text("board.footer")}</span></footer>
  </section>;
}
