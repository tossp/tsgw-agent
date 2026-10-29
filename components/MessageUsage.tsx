"use client";

import { Fragment } from "react";
import { useI18n } from "@/hooks/useI18n";
import { averageOutputRate, formatUsageCost, formatUsageTokens, type MessageUsageSummary } from "@/lib/message-usage";
import { formatTurnDuration } from "@/lib/turn-duration";
import { UsageIcon, type UsageIconKind } from "./UsageIcon";
import type { AssistantMessage } from "@/lib/types";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type ResponseDetails = Pick<AssistantMessage, "model" | "provider" | "timestamp" | "durationMs" | "stopReason" | "errorMessage">;

function recordedTime(value: number | undefined, locale: string): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString(locale, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  });
}

/** Use only the response already loaded by MessageView, never current session settings. */
function responseDetailsText(response: ResponseDetails, t: Translate, locale: string): string[] {
  const lines: string[] = [];
  if (response.model) lines.push(`${t("chat.usageModel")}: ${response.model}`);
  if (response.provider) lines.push(`${t("chat.usageProvider")}: ${response.provider}`);
  const started = recordedTime(response.timestamp, locale);
  if (started) lines.push(`${t("chat.usageRequestStarted")}: ${started}`);
  const ms = response.durationMs;
  if (ms !== undefined && Number.isFinite(ms) && ms >= 0) {
    const ended = started ? recordedTime(response.timestamp! + ms, locale) : undefined;
    if (ended) lines.push(`${t("chat.usageResponseCompleted")}: ${ended}`);
  }
  if (response.stopReason) lines.push(`${t("chat.usageStopReason")}: ${response.stopReason}`);
  if (response.errorMessage) lines.push(`${t("chat.usageError")}: ${response.errorMessage}`);
  return lines;
}

/** Unabbreviated counts in the same scope as the clickable summary. */
export function usageDetailsText(summary: MessageUsageSummary, t: Translate, locale: string, response?: ResponseDetails): string {
  const { usage, scope, durationMs } = summary;
  const count = (value: number) => value.toLocaleString(locale);
  const lines = [
    t(scope === "turn" ? "chat.usageTurn" : "chat.usageResponse"),
    ...(["input", "output", "cacheRead", "cacheWrite"] as const)
      .filter((key) => key === "input" || key === "output" || usage[key] > 0)
      .map((key) => `${t(`session.${key}`)}: ${count(usage[key])}`),
    `${t("session.total")}: ${count(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)}`,
    `${t("session.cost")}: $${formatUsageCost(usage.cost?.total ?? 0)}`,
  ];
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const cost = usage.cost?.[key];
    if (typeof cost === "number" && Number.isFinite(cost)) {
      lines.push(`${t("chat.usageCostDetail", { kind: t(`session.${key}`) })}: $${formatUsageCost(cost)}`);
    }
  }
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
    lines.push(`${t("chat.usageDuration")}: ${(durationMs / 1_000).toLocaleString(locale, { maximumFractionDigits: 3 })}s`);
  }
  const rate = averageOutputRate(summary);
  if (rate !== undefined) {
    lines.push(`${t("chat.usageAverage")}: ${rate.toFixed(1)} t/s`, t("chat.usageAverageHint"));
  }
  if (!summary.complete) lines.push(t("chat.usageIncomplete"));
  if (response && scope === "response") lines.push(...responseDetailsText(response, t, locale));
  return lines.join("\n");
}

// Preserve the upstream footer's copied/read-aloud text without relying on
// font glyphs for the visible marks. Inline children keep each count on one line.
const USAGE_PREFIX: Record<UsageIconKind, string> = { input: "↑", output: "↓", cacheRead: "R", cacheWrite: "W" };

export function UsageDuration({ durationMs }: { durationMs: number }) {
  const { t } = useI18n();
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const time = formatTurnDuration(durationMs);
  const label = t("chat.turnDuration", { time });
  const index = label.indexOf(time);
  if (index < 0) return <span>{label}</span>;
  return (
    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
      <span style={{ fontSize: 0 }}>{label.slice(0, index)}</span>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: "inline", verticalAlign: "-0.1em", marginRight: 3 }}>
        <path d="M6 1.25a4.75 4.75 0 1 0 0 9.5 4.75 4.75 0 1 0 0-9.5M6 3.5V6l1.75 1" />
      </svg>
      {time}
      <span style={{ fontSize: 0 }}>{label.slice(index + time.length)}</span>
    </span>
  );
}

export function MessageUsage({ summary, response, onShowDetails }: {
  summary: MessageUsageSummary;
  response?: ResponseDetails;
  onShowDetails?: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const { usage, durationMs } = summary;
  const parts = (["input", "output", "cacheRead", "cacheWrite"] as UsageIconKind[])
    .filter((kind) => usage[kind] > 0)
    .map((kind) => (
      <span key={kind} title={t(`session.${kind}`)}>
        <span style={{ fontSize: 0 }}>{USAGE_PREFIX[kind]}</span>
        <UsageIcon kind={kind} style={{ display: "inline", verticalAlign: "-0.05em", marginRight: 3 }} />{formatUsageTokens(usage[kind])}
      </span>
    ));
  if (usage.cost?.total) parts.push(<span key="cost">${formatUsageCost(usage.cost.total)}</span>);
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
    parts.push(<UsageDuration key="duration" durationMs={durationMs} />);
  }
  const rate = averageOutputRate(summary);
  if (rate !== undefined) {
    parts.push(<span key="rate" title={t("chat.usageAverageHint")}>{rate.toFixed(1)} t/s</span>);
  }
  if (parts.length === 0) return null;
  const details = usageDetailsText(summary, t, locale, response);
  const Tag = onShowDetails ? "button" : "span";
  return (
    <Tag
      type={onShowDetails ? "button" : undefined}
      className="message-usage"
      title={details}
      aria-label={onShowDetails ? `${t("chat.usageDetails")}\n${details}` : undefined}
      onClick={onShowDetails ? () => onShowDetails(details) : undefined}
      style={{
        display: "inline-flex", alignItems: "center", flexWrap: "wrap", rowGap: 2, columnGap: 7,
        minWidth: 0, maxWidth: "100%", padding: "2px 0", border: "none", background: "none",
        font: "inherit", fontSize: 11, color: "var(--text-dim)", textAlign: "left",
        cursor: onShowDetails ? "pointer" : "default", fontVariantNumeric: "tabular-nums",
      }}
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && " "}
          {index > 0 && (part.key === "duration" || part.key === "rate") && <><span>·</span>{" "}</>}
          {part}
        </Fragment>
      ))}
    </Tag>
  );
}
