import type { DebugPageVisibility } from "@/lib/debug-types";
import type { Locale } from "@/lib/i18n/types";
import { formatAgo, type DebugServerReading, type Translate } from "@/components/debug-panel-state";
import { debugPageText } from "./messages";
import styles from "./DebugPageView.module.css";

export interface ObserverTelemetry {
  samples: { at: number; ms: number }[];
  inFlightSince: number | null;
  protocol: string | null;
  visibility?: DebugPageVisibility;
}

/** These measurements belong to this observer, not any of the chat pages being observed. */
export function ObserverPanel({ server, telemetry, now, t, locale }: {
  server: DebugServerReading; telemetry?: ObserverTelemetry; now: number; t: Translate; locale: Locale;
}) {
  const text = (key: Parameters<typeof debugPageText>[1]) => debugPageText(locale, key);
  const samples = telemetry?.samples ?? [];
  const max = Math.max(1, ...samples.map(sample => sample.ms));
  const points = samples.map((sample, index) => `${8 + index * 264 / Math.max(1, samples.length - 1)},${48 - sample.ms * 38 / max}`).join(" ");
  const values = [
    [text("board.rtt"), server.roundTripMs === null ? "—" : `${server.roundTripMs} ms`],
    [text("board.requests"), server.requests],
    [text("board.failures"), server.failures],
    [text("board.consecutive"), server.consecutiveFailures],
    [text("board.lastSuccess"), server.receivedAt === null ? "—" : formatAgo(now - server.receivedAt, t)],
    [text("board.inFlight"), telemetry?.inFlightSince == null ? text("board.no") : `${Math.max(0, now - telemetry.inFlightSince)} ms`],
    [text("board.protocol"), telemetry?.protocol || "—"],
    [text("board.visibility"), telemetry?.visibility?.state ?? "—"],
    [text("board.visibilityChanges"), telemetry?.visibility?.hiddenCount ?? "—"],
    ...([ ["board.visibilitySince", telemetry?.visibility?.trackingSince], ["board.lastHidden", telemetry?.visibility?.lastHiddenAt], ["board.lastVisible", telemetry?.visibility?.lastVisibleAt] ] as const).map(([key, at]) => [text(key), at == null ? "—" : formatAgo(now - at, t)]),
  ];
  return (
    <section className={styles.panel} aria-label={text("board.observer")}>
      <h2 className={styles.sectionTitle}><span className={styles.sectionNumber}>04</span>{text("board.observer")}</h2>
      <p className={styles.scopeNote}>{text("board.observerScope")}</p>
      <dl className={styles.pollFacts}>{values.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {samples.length > 0 ? (
        <svg className={styles.sparkline} viewBox="0 0 280 56" role="img" aria-label={text("board.samples")}>
          <title>{samples.map(sample => `${sample.ms} ms`).join(" · ")}</title>
          <path d="M8 48H272" fill="none" stroke="currentColor" opacity=".15" />
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
          {samples.map((sample, index) => <circle key={`${sample.at}:${index}`} cx={8 + index * 264 / Math.max(1, samples.length - 1)} cy={48 - sample.ms * 38 / max} r="2" fill="currentColor" />)}
        </svg>
      ) : <p className={styles.note}>{text("board.noSamples")}</p>}
    </section>
  );
}
