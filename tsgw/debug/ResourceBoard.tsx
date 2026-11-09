"use client";

import type { Locale } from "@/lib/i18n/types";
import type { DebugSessionSummary, DebugSubagentRun } from "@/lib/debug-types";
import { sessionRowTitle } from "@/components/SessionTree";
import {
  DEBUG_RUN_STATUS_KEYS, DEBUG_STATUS_KEYS, barFraction, debugServerClock, debugStatusState,
  formatAgo, formatCountdown, shortDebugId, translateDebugCode,
  type DebugServerClock, type DebugSessionGroup, type DebugSessionRow, type DebugTitleOf, type Translate,
} from "@/components/debug-panel-state";
import { DebugSessionDetailView } from "./DebugSessionDetail";
import { dashboardRole, DASHBOARD_ROLE_KEYS } from "./dashboard-state";
import { resourceFamilies } from "./resource-families";
import { debugPageText } from "./messages";
import type { ResourceReadings } from "./resource-observer";
import type { LiveModelReadings } from "./live-model-observer";
import styles from "./resources.module.css";
import d from "./detail.module.css";

interface Props {
  groups: readonly DebugSessionGroup[];
  residentIds: ReadonlySet<string>;
  resources: ResourceReadings;
  liveModels: LiveModelReadings;
  now: number;
  summaryClock: DebugServerClock | null;
  idleTimeoutMs: number;
  titleOf: DebugTitleOf;
  t: Translate;
  locale: Locale;
}

type SampledRun = { run: DebugSubagentRun; sourceId: string; at: number; receivedAt: number };

/** Resident families share one surface. Non-resident roots supply relationship context only. */
export function ResourceBoard({ groups, residentIds, resources, liveModels, now, summaryClock, idleTimeoutMs, titleOf, t, locale }: Props) {
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const runs = new Map<string, SampledRun>();
  for (const [sourceId, reading] of Object.entries(resources)) {
    if (!residentIds.has(sourceId) || reading.reply?.session?.sessionId !== sourceId || reading.receivedAt === null) continue;
    for (const run of reading.reply.session.subagents.runs) {
      const previous = runs.get(run.sessionId);
      if (!previous || reading.receivedAt > previous.receivedAt) runs.set(run.sessionId, { run, sourceId, at: reading.reply.now, receivedAt: reading.receivedAt });
    }
  }
  const families = resourceFamilies(groups, residentIds);
  const rows = families.flatMap(family => family.rows).filter(row => row.summary && residentIds.has(row.id));
  const observed = rows.filter(row => resources[row.id]?.receivedAt != null && resources[row.id]?.reply?.session?.sessionId === row.id).length;
  const rowProps = { residentIds, resources, liveModels, now, summaryClock, idleTimeoutMs, titleOf, t, locale, runs };
  return <section className={styles.panel} aria-label={text("dense.inspect")}>
    <div className={styles.heading} title={text("resource.sampling")}><h2>{text("resource.heading")}</h2><span>{text("resource.coverage", { observed: summaryClock ? observed : "—", total: summaryClock ? rows.length : "—" })}</span></div>
    <div className={styles.body}>
      {families.length === 0 && <p className={styles.empty}>{text(summaryClock ? "dense.noRuntime" : "board.waiting")}</p>}
      <div className={styles.grid}>
        {families.map(family => {
          const root = family.rows[0];
          const name = root.info ? sessionRowTitle(root.info) : titleOf(root.id) ?? shortDebugId(root.id);
          const members = family.rows.flatMap(row => row.summary && residentIds.has(row.id) ? [row.summary] : []);
          const running = members.filter(summary => summary.running && !summary.awaitingInput).length;
          const awaiting = members.filter(summary => summary.awaitingInput).length;
          return <section className={styles.family} key={family.id} data-family-id={family.id} aria-labelledby={`family-${family.id}`}>
            <header className={styles.familyHead}>
              <div className={styles.familyTitle}><h3 id={`family-${family.id}`}>{name}</h3><span className={styles.projectName}>{family.project ?? t("debug.sessions.unlisted")}</span></div>
              <div className={styles.familyCounts}>
                {running > 0 && <span className={styles.executing}>{text("resource.familyRunning", { count: running })}</span>}
                {awaiting > 0 && <span className={styles.warning}>{text("resource.familyAwaiting", { count: awaiting })}</span>}
                <span>{text("resource.familyResidents", { count: members.length })}</span>
              </div>
            </header>
            {family.rows.map(row => {
              const reading = row.summary && residentIds.has(row.id) ? resources[row.id] : undefined;
              const detail = reading?.receivedAt != null && reading.reply?.session?.sessionId === row.id ? reading.reply.session : null;
              return <div key={row.id}>
                <ResourceRow {...rowProps} row={row} familyRoot={row.id === family.id} />
                {detail?.subagents.runs.filter(run => !residentIds.has(run.sessionId)).map((run, index) => <div className={styles.runRecord} key={`${run.sessionId}:${index}`}>
                  <span className={styles.child}>{text("dense.child")}</span><strong>{titleOf(run.sessionId) ?? shortDebugId(run.sessionId)}</strong><span>{run.profile}</span><span>{translateDebugCode(run.status, DEBUG_RUN_STATUS_KEYS, t)}</span>
                  <span>{text("resource.runRecord")}</span><span>{text("board.parent", { name: titleOf(run.parentSessionId) ?? shortDebugId(run.parentSessionId) })}</span>
                  <RunFacts run={run} sourceId={row.id} now={now} at={reading!.reply!.now} receivedAt={reading!.receivedAt!} titleOf={titleOf} t={t} locale={locale} />
                </div>)}
              </div>;
            })}
          </section>;
        })}
      </div>
    </div>
  </section>;
}

function RunFacts({ run, sourceId, now, at, receivedAt, titleOf, t, locale }: SampledRun & Pick<Props, "now" | "titleOf" | "t" | "locale">) {
  const clock = debugServerClock(at, receivedAt, now);
  return <>
    <span title={sourceId}>{debugPageText(locale, "resource.session")}: {titleOf(sourceId) ?? shortDebugId(sourceId)} · {debugPageText(locale, "resource.sampled", { time: formatAgo(now - receivedAt, t) })}</span>
    {run.background && <span>{t("debug.server.background")}</span>}
    {run.resumed && <span>{t("debug.server.resumed")}</span>}
    {run.dispatchedAt !== null && <span>{formatAgo(clock.age(run.dispatchedAt), t)}</span>}
    {run.abortRequested && <span className={styles.warning}>{t("debug.server.abortRequested")}</span>}
    {run.mcpWaiting && <span className={styles.warning}>{t("debug.run.waitingForMcp")}</span>}
  </>;
}

function ResourceRow({ row, familyRoot, residentIds, resources, liveModels, now, summaryClock, idleTimeoutMs, titleOf, t, locale, runs }: Omit<Props, "groups"> & { row: DebugSessionRow; familyRoot: boolean; runs: ReadonlyMap<string, SampledRun> }) {
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const resident = row.summary !== null && residentIds.has(row.id);
  // A cached answer never turns a relationship-only parent back into a resource row.
  const reading = resident ? resources[row.id] : undefined;
  const detail = reading?.receivedAt != null && reading.reply?.session?.sessionId === row.id ? reading.reply.session : null;
  const clock = detail && reading?.reply && reading.receivedAt !== null ? debugServerClock(reading.reply.now, reading.receivedAt, now) : null;
  const name = row.info ? sessionRowTitle(row.info) : titleOf(row.id) ?? shortDebugId(row.id);
  const relation = row.info?.relation;
  const role = dashboardRole(row.summary ?? detail?.wrapper, row.info);
  const run = resident && role === "subagent" ? runs.get(row.id) : undefined;
  const child = role === "subagent";
  const state = resident && row.summary ? debugStatusState(row.summary) : null;
  const model = resident ? liveModels[row.id] : undefined;
  return <article className={`${styles.session}${row.depth === 1 ? ` ${styles.subsession}` : ""}${resident ? "" : ` ${styles.context}`}`} id={`resource-${row.id}`} data-session-id={row.id}>
    <header className={styles.sessionHead}>
      {!familyRoot && <div className={styles.titleLine}>
        <strong className={styles.name} title={name}>{name}</strong>
        {detail && reading?.receivedAt != null && <span className={styles.age}>{text("resource.sampled", { time: formatAgo(now - reading.receivedAt, t) })}</span>}
      </div>}
      <div className={styles.sessionMeta}>
        <span className={child ? styles.child : styles.role}>{text(DASHBOARD_ROLE_KEYS[role])}</span>
        {(relation?.kind === "subagent" || run) && <span className={styles.profile}>{relation?.kind === "subagent" ? relation.profile : run?.run.profile}</span>}
        <span className={styles.status} data-state={state}>
          {state === "running" && <svg className={styles.runningRing} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2" opacity=".22" />
            <path d="M17.5 10A7.5 7.5 0 1 1 10 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>}
          {state ? t(DEBUG_STATUS_KEYS[state]) : text("dense.context")}
        </span>
        {relation?.kind === "fork" && <span className={styles.role}>{text("dense.fork")}</span>}
        {row.summary && row.summary.starts > 1 && <span className={styles.summaryFact}>↻{row.summary.starts}</span>}
        {row.summary && row.summary.eventStreams > 0 && <span className={styles.summaryFact}>SSE {row.summary.eventStreams}</span>}
        {row.summary && row.summary.providers > 0 && <span className={styles.summaryFact}>{t("debug.box.provider")} {row.summary.providers}</span>}
        {detail?.subagents.active && <span className={styles.child}>{t("debug.server.subagentsActive")}</span>}
        {resident && relation?.kind === "subagent" && <span className={styles.recordedStatus}>{text("board.recordedStatus", { status: translateDebugCode(relation.status, DEBUG_RUN_STATUS_KEYS, t) })}</span>}
        {familyRoot && detail && reading?.receivedAt != null && <span className={styles.age}>{text("resource.sampled", { time: formatAgo(now - reading.receivedAt, t) })}</span>}
      </div>
    </header>
    {relation?.kind === "subagent" && <div className={styles.assignment}><span>{relation.description}</span><span>{text("board.parent", { name: titleOf(relation.parentSessionId) ?? shortDebugId(relation.parentSessionId) })}</span></div>}
    {relation?.kind === "fork" && <p className={styles.assignment}>{text("board.fork", { name: titleOf(relation.originSessionId ?? row.info?.parentSessionId ?? "—") ?? shortDebugId(relation.originSessionId ?? row.info?.parentSessionId ?? "—") })}</p>}
    {relation?.kind === "side" && <p className={styles.assignment}>{text("dense.sideSource", { name: titleOf(relation.parentSessionId) ?? shortDebugId(relation.parentSessionId) })}</p>}
    {run && role === "subagent" && relation?.kind !== "subagent" && <div className={styles.assignment}>{text("board.parent", { name: titleOf(run.run.parentSessionId) ?? shortDebugId(run.run.parentSessionId) })}</div>}
    {resident && <>
      <div className={styles.modelLine}>
        <span>{text("resource.model")} <strong>{model?.model ? `${model.model.provider}/${model.model.id}` : text("resource.modelUnknown")}</strong></span>
        <span>{text("resource.thinking")} <strong>{model?.thinkingLevel ?? text("resource.modelUnknown")}</strong></span>
        {model?.receivedAt != null && <span>{text("resource.modelSample", { time: formatAgo(now - model.receivedAt, t) })}</span>}
        {model?.failed && <span className={styles.warning}>{text("resource.modelFailed")}</span>}
        {model?.running === false && <span>{text("resource.modelInactive")}</span>}
        {row.info?.cwd && <span className={styles.cwd} title={row.info.cwd}>{row.info.cwd}{row.info.branch ? ` · ${row.info.branch}` : ""}</span>}
      </div>
      {run && <div className={styles.runFacts}><span>{t("debug.server.subagents")}: {translateDebugCode(run.run.status, DEBUG_RUN_STATUS_KEYS, t)}</span><RunFacts {...run} now={now} titleOf={titleOf} t={t} locale={locale} /></div>}
      {reading?.failure && <p className={styles.warning}>{text("resource.failed")}</p>}
      {detail && clock ? <DebugSessionDetailView detail={detail} clock={clock} titleOf={titleOf} t={t} locale={locale} id={`debug-session-${row.id}`} name={name} role={role} showSubagents={false} /> : <div className={styles.pending} id={`debug-session-${row.id}`}>
        {row.summary && <SummaryIdle summary={row.summary} clock={summaryClock} idleTimeoutMs={idleTimeoutMs} t={t} locale={locale} />}
        <p className={styles.unread}>{text("resource.unread")}</p>
      </div>}
      {detail?.subagents.notifications.map((notification, index) => <p className={styles.warning} key={`${notification.sessionId}:${index}`}>
        {titleOf(notification.sessionId) ?? shortDebugId(notification.sessionId)} · {t("debug.server.notifying", { parent: titleOf(notification.parentSessionId) ?? shortDebugId(notification.parentSessionId) })}
        {notification.since !== null && clock ? ` · ${formatAgo(clock.age(notification.since), t)}` : ""}
      </p>)}
    </>}
  </article>;
}

/** Until its first detail arrives, a resident still has its own summary's real idle check. */
function SummaryIdle({ summary, clock, idleTimeoutMs, t, locale }: { summary: DebugSessionSummary; clock: DebugServerClock | null } & Pick<Props, "idleTimeoutMs" | "t" | "locale">) {
  const label = debugPageText(locale, "dense.reap");
  const remaining = summary.nextIdleCheckAt !== null && clock != null ? clock.remaining(summary.nextIdleCheckAt) : null;
  return <section className={d.row} data-kind="timing" aria-label={label} title={debugPageText(locale, "dense.reapHint")}>
    <h3 className={d.rowLabel}>{label}</h3><div className={d.rowBody}>
      {remaining === null ? <span className={d.note}>{summary.nextIdleCheckAt === null ? debugPageText(locale, "dense.noCheck") : "—"}</span> : <span className={d.release}>
        <span className={d.releaseText}>{formatCountdown(remaining, t)}</span>
        {idleTimeoutMs > 0 && <span className={d.meter} aria-hidden="true"><span className={d.meterFill} style={{ width: `${(barFraction(remaining, idleTimeoutMs) ?? 0) * 100}%` }} /></span>}
      </span>}
      {summary.forcedByStop && <span className={d.warnLine}>{t("debug.server.idleForced")}</span>}
    </div>
  </section>;
}
