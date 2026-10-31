import type { DebugSnapshotResponse } from "@/lib/debug-types";
import type { Locale } from "@/lib/i18n/types";
import { DEBUG_SOURCE_KIND_KEYS, formatCountdown, formatDebugDuration, joinParts, shortDebugId, type DebugServerClock, type Translate } from "@/components/debug-panel-state";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

export function DashboardOverview({ reply, clock, t, locale }: { reply: DebugSnapshotResponse; clock: DebugServerClock; t: Translate; locale: Locale }) {
  const global = reply.server;
  const terminals = global.terminals;
  const text = (key: Parameters<typeof debugPageText>[1]) => debugPageText(locale, key);
  const facts = [
    [t("debug.global.uptime"), formatDebugDuration(clock.age(global.startedAt), t)],
    [text("board.wrappers"), t("debug.global.wrappersValue", { ...global.wrappers })],
    [text("board.timerSettings"), t("debug.global.timersValue", { idle: global.idleTimeoutMs > 0 ? formatDebugDuration(global.idleTimeoutMs, t) : t("debug.server.idleDisabled"), heartbeat: formatDebugDuration(global.heartbeatMs, t) })],
  ];
  const terminalFacts = [
    [t("debug.global.terminals"), terminals.count], [text("board.terminalListeners"), terminals.listeners],
    [text("board.detached"), terminals.detached], [text("board.exited"), terminals.exited],
    [text("board.cleanup"), terminals.nextCleanupAt === null ? "—" : formatCountdown(clock.remaining(terminals.nextCleanupAt), t)],
  ];
  return <section className={styles.panel} aria-label={t("debug.section.server")}>
    <div className={styles.panelHead}><h2 className={styles.sectionTitle}>{t("debug.section.server")}</h2><span className={styles.badge}>SSE {global.sseTotal}</span></div>
    <div className={styles.resourceTags}><span className={styles.badge}>{t(DEBUG_SOURCE_KIND_KEYS.agent)} SSE {global.eventStreams.total}</span><span className={styles.badge}>{t("debug.global.fileWatches")} {global.fileWatches}</span><span className={styles.badge}>{t("debug.global.terminals")} {terminals.count}</span></div>
    <dl className={styles.definitionList}>{facts.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <details className={styles.measureMore}><summary>{text("board.terminals")} · {terminals.count}{terminals.nextCleanupAt !== null ? ` · ${text("board.cleanup")} ${formatCountdown(clock.remaining(terminals.nextCleanupAt), t)}` : ""}</summary><dl className={styles.definitionList}>{terminalFacts.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
    <details className={styles.measureMore}>
      <summary>{t("debug.pages.title")} · {global.pages.length}</summary>
      {global.pages.length === 0 && <p className={styles.note}>{t("debug.none")}</p>}
      {global.pages.map((entry, index) => {
        const total = entry.agent + entry.terminal + entry.fileWatch;
        const kinds = joinParts([`${t(DEBUG_SOURCE_KIND_KEYS.agent)} ${entry.agent}`, `${t(DEBUG_SOURCE_KIND_KEYS.terminal)} ${entry.terminal}`, `${t(DEBUG_SOURCE_KIND_KEYS["file-watch"])} ${entry.fileWatch}`]);
        return <article className={styles.pageRow} key={`${entry.holder ?? ""}:${index}`}>
          <strong className={styles.pageClient}>{entry.client ?? t("debug.pages.unknownClient")}</strong><span className={styles.badge}>SSE {total}</span>
          <span className={styles.pageAddress}>{entry.address ?? "—"}</span><span className={styles.pageHolder} title={entry.holder ?? undefined}>{entry.holder === null ? t("debug.holder.none") : shortDebugId(entry.holder)}</span><span className={styles.pageKinds}>{kinds}</span>
        </article>;
      })}
    </details>
  </section>;
}
