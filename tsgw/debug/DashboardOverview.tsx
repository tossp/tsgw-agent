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
    [`${t(DEBUG_SOURCE_KIND_KEYS.agent)} SSE`, global.eventStreams.total],
    [t("debug.global.fileWatches"), global.fileWatches],
  ];
  const terminalFacts = [
    [t("debug.global.terminals"), terminals.count],
    [text("board.terminalListeners"), terminals.listeners],
    [text("board.detached"), terminals.detached],
    [text("board.exited"), terminals.exited],
    [text("board.cleanup"), terminals.nextCleanupAt === null ? "—" : formatCountdown(clock.remaining(terminals.nextCleanupAt), t)],
  ];
  return (
    <>
      <section className={styles.panel} aria-label={t("debug.section.server")}>
        <h2 className={styles.sectionTitle}><span className={styles.sectionNumber}>02</span>{t("debug.section.server")}</h2>
        <dl className={styles.definitionList}>{facts.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <h3 className={styles.sectionTitle}>{text("board.timerSettings")}</h3>
        <p className={styles.entry}>{t("debug.global.timersValue", {
          idle: global.idleTimeoutMs > 0 ? formatDebugDuration(global.idleTimeoutMs, t) : t("debug.server.idleDisabled"),
          heartbeat: formatDebugDuration(global.heartbeatMs, t),
        })}</p>
      </section>
      <section className={styles.panel} aria-label={t("debug.pages.title")}>
        <h2 className={styles.sectionTitle}><span className={styles.sectionNumber}>03</span>{t("debug.pages.title")} · {global.pages.length}</h2>
        <div className={styles.facts}><span className={styles.factValue}>SSE {global.sseTotal}</span></div>
        {global.pages.length === 0 && <p className={styles.note}>{t("debug.none")}</p>}
        {global.pages.map((entry, index) => {
          const total = entry.agent + entry.terminal + entry.fileWatch;
          const kinds = joinParts([
            `${t(DEBUG_SOURCE_KIND_KEYS.agent)} ${entry.agent}`,
            `${t(DEBUG_SOURCE_KIND_KEYS.terminal)} ${entry.terminal}`,
            `${t(DEBUG_SOURCE_KIND_KEYS["file-watch"])} ${entry.fileWatch}`,
          ]);
          return (
            <article className={styles.entry} key={`${entry.holder ?? ""}:${index}`}>
              <div className={styles.entryLine}><strong>{entry.client ?? t("debug.pages.unknownClient")}</strong><span className={styles.badge}>SSE {total}</span></div>
              <div className={styles.entryLine}><span>{entry.address ?? "—"}</span><span title={entry.holder ?? undefined}>{entry.holder === null ? t("debug.holder.none") : shortDebugId(entry.holder)}</span></div>
              <p className={styles.note}>{kinds}</p>
            </article>
          );
        })}
      </section>
      <section className={styles.panel} aria-label={text("board.terminals")}>
        <h2 className={styles.sectionTitle}>{text("board.terminals")}</h2>
        <dl className={styles.definitionList}>{terminalFacts.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
    </>
  );
}
