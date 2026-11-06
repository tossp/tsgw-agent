import type { DebugPageVisibility } from "@/lib/debug-types";
import type { Locale } from "@/lib/i18n/types";
import {
  barFraction, DEBUG_POLL_MS, DEBUG_POLL_TIMEOUT_MS, formatAgo, formatDebugSeconds, sparkHeight,
  type DebugServerReading, type Translate,
} from "@/components/debug-panel-state";
import type { CatalogTelemetry } from "./page-observer";
import { CATALOG_REFRESH_MS } from "./page-observer";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

type PollSample = { at: number; ms: number; failed?: boolean };
export interface ObserverTelemetry {
  samples: PollSample[];
  inFlightSince: number | null;
  nextDebugCheckAt?: number | null;
  catalog?: CatalogTelemetry;
  protocol: string | null;
  visibility?: DebugPageVisibility;
}

/** Only this observer's two existing GET polls. No claims about another page's connection pool. */
export function ObserverPanel({ server, telemetry, now, hidden = false, t, locale }: {
  server: DebugServerReading; telemetry?: ObserverTelemetry; now: number; hidden?: boolean; t: Translate; locale: Locale;
}) {
  const text = (key: Parameters<typeof debugPageText>[1]) => debugPageText(locale, key);
  const catalog = telemetry?.catalog;
  const values = [
    [text("board.rtt"), server.roundTripMs === null ? "—" : `${server.roundTripMs} ms`],
    [text("board.lastSuccess"), server.receivedAt === null ? "—" : formatAgo(now - server.receivedAt, t)],
    [text("board.inFlight"), telemetry?.inFlightSince == null ? text("board.no") : `${Math.max(0, now - telemetry.inFlightSince)} ms`],
    [text("board.requests"), server.requests], [text("board.failures"), server.failures], [text("board.consecutive"), server.consecutiveFailures],
    [text("board.protocol"), telemetry?.protocol || "—"],
    [text("board.visibility"), telemetry?.visibility?.state ?? "—"],
    [text("board.visibilityChanges"), telemetry?.visibility?.hiddenCount ?? "—"],
    ...([ ["board.visibilitySince", telemetry?.visibility?.trackingSince], ["board.lastHidden", telemetry?.visibility?.lastHiddenAt], ["board.lastVisible", telemetry?.visibility?.lastVisibleAt] ] as const).map(([key, at]) => [text(key), at == null ? "—" : formatAgo(now - at, t)]),
  ];
  return <section className={styles.panel} aria-label={text("board.observer")}>
    <h2 className={styles.sectionTitle}>{text("board.observer")}</h2>
    <PollLine label={text("dense.pollDebug")} now={now} hidden={hidden} locale={locale} t={t}
      startedAt={telemetry?.inFlightSince ?? null} nextAt={telemetry?.nextDebugCheckAt ?? null} intervalMs={DEBUG_POLL_MS}
      lastMs={server.failure ? null : server.roundTripMs} failed={server.failure !== null} requests={server.requests} failures={server.failures} consecutive={server.consecutiveFailures} samples={telemetry?.samples ?? []} />
    <PollLine label={text("dense.pollCatalog")} now={now} hidden={hidden} locale={locale} t={t}
      startedAt={catalog?.inFlightSince ?? null} nextAt={catalog?.nextCheckAt ?? null} intervalMs={CATALOG_REFRESH_MS}
      lastMs={catalog?.roundTripMs ?? null} failed={catalog?.failed ?? false} requests={catalog?.requests ?? 0} failures={catalog?.failures ?? 0} consecutive={catalog?.consecutiveFailures ?? 0} samples={catalog?.samples ?? []} />
    <details className={styles.measureMore}><summary>{text("dense.more")}</summary><p className={styles.scopeNote}>{text("board.observerScope")}</p><dl className={styles.pollFacts}>{values.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>
  </section>;
}

function PollLine({ label, now, hidden, locale, t, startedAt, nextAt, intervalMs, lastMs, failed, requests, failures, consecutive, samples }: {
  label: string; now: number; hidden: boolean; locale: Locale; t: Translate; startedAt: number | null; nextAt: number | null; intervalMs: number;
  lastMs: number | null; failed: boolean; requests: number; failures: number; consecutive: number; samples: readonly PollSample[];
}) {
  const text = (key: Parameters<typeof debugPageText>[1], params?: Parameters<typeof debugPageText>[2]) => debugPageText(locale, key, params);
  const elapsed = startedAt === null ? null : Math.max(0, now - startedAt);
  const slow = elapsed !== null ? elapsed >= DEBUG_POLL_MS : !failed && lastMs !== null && lastMs >= DEBUG_POLL_MS;
  const tone = hidden ? "dim" : elapsed !== null ? slow ? "warning" : "accent" : failed ? "error" : requests === 0 ? "dim" : slow ? "warning" : "ok";
  const state = hidden ? text("dense.paused") : elapsed !== null ? text(slow ? "dense.slow" : "dense.inFlight") : failed ? text("dense.failed") : requests === 0 ? text("board.waiting") : text(slow ? "dense.slow" : "dense.ok");
  const fraction = elapsed !== null ? barFraction(elapsed, DEBUG_POLL_TIMEOUT_MS) : nextAt === null ? 0 : barFraction(nextAt - now, intervalMs);
  return <div className={styles.pollLine} data-poll={intervalMs === DEBUG_POLL_MS ? "debug" : "catalog"}>
    <div className={styles.pollHeading}><strong>{label}</strong><span className={`${styles.chip} ${styles[`tone_${tone}`]}`}>{state}</span><span className={styles.factValue}>{elapsed !== null ? `${elapsed} ms` : lastMs === null ? "—" : `${lastMs} ms`}</span></div>
    <div className={`${styles.pollScale} ${styles[`tone_${tone}`]}`}><span className={styles.progress} aria-hidden="true"><span style={{ width: `${(fraction ?? 0) * 100}%` }} /></span><span>{hidden ? text("dense.paused") : elapsed !== null ? `${text("dense.inFlight")} / 5s` : nextAt === null ? "—" : `${text("dense.nextPoll")} ${nextAt <= now ? text("dense.pollDue") : formatDebugSeconds(nextAt - now, t, "ceil")}`}</span></div>
    <svg className={styles.sparkline} viewBox="0 0 240 26" role="img" aria-label={text("dense.pollChart")}>
      <path d="M0 25H240" fill="none" stroke="currentColor" opacity=".15" />
      {samples.slice(-24).map((sample, index) => {
        const height = sample.failed ? 23 : Math.max(2, sparkHeight(sample.ms) * 23);
        return <rect key={`${sample.at}:${index}`} x={index * 10 + 1} y={25 - height} width="7" height={height} rx="1" className={sample.failed ? styles.sampleFailed : sample.ms >= DEBUG_POLL_MS ? styles.sampleSlow : styles.sampleOk}><title>{`${new Date(sample.at).toLocaleTimeString(locale)} · ${sample.failed ? text("dense.failed") : `${sample.ms} ms`}`}</title></rect>;
      })}
    </svg>
    <p className={styles.scopeNote}>{text("dense.pollStats", { requests, failures, consecutive })}</p>
  </div>;
}
