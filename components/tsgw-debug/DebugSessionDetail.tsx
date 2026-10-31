"use client";

import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { DebugSessionDetail as DebugSessionDetailData } from "@/lib/debug-types";
import { MCP_SESSION_STATE_KEYS } from "../mcp-config-helpers";
import {
  DEBUG_RUN_STATUS_KEYS,
  barFraction,
  formatAgo,
  formatBytes,
  formatCountdown,
  joinParts,
  mcpServerTone,
  shortDebugId,
  translateDebugCode,
  type DebugServerClock,
  type DebugTitleOf,
  type DebugTone,
  type Translate,
} from "../debug-panel-state";
import { debugPageText, type DebugPageKey } from "./messages";
import styles from "./DebugPageView.module.css";

export interface DebugSessionDetailViewProps {
  /** The server's answer about the session one row opened; never another session's. */
  detail: DebugSessionDetailData;
  /** Server times read on the server's clock (the answer's `now` plus the time since it arrived). */
  clock: DebugServerClock;
  titleOf: DebugTitleOf;
  t: Translate;
  locale: Locale;
  /** The element's id: the row's `aria-controls` while it is open. */
  id: string;
  /** The row's name, the region's accessible name. */
  name: string;
}

/** A dot in a tone: filled for a settled state, a ring while something is still connecting. */
function Dot({ tone, ring = false }: { tone: DebugTone; ring?: boolean }) {
  return <span className={`${styles.dot} ${styles[`dot_${tone}`] ?? ""}${ring ? ` ${styles.dotRing}` : ""}`} aria-hidden="true" />;
}

function Chip({ tone, children }: { tone: "dim" | "accent" | "warning"; children: ReactNode }) {
  return <span className={`${styles.chip} ${styles[`chip_${tone}`] ?? ""}`}>{children}</span>;
}

/** One entry of a block: a name, then the tooltip's lines as its own dim rows. */
function Entry({ name, lines, tone }: { name: string; lines: readonly (string | false | null | undefined)[]; tone?: string }) {
  const text = joinParts(lines);
  return (
    <div className={`${styles.entry}${tone ? ` ${tone}` : ""}`} title={text}>
      <span className={styles.entryName}>{name}</span>
      {text && <span className={styles.entryLine}>{text}</span>}
    </div>
  );
}

function Block({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>
        <span>{title}</span>
        {extra}
      </h3>
      {children}
    </section>
  );
}

/**
 * What the server holds for one session, under the row that opened it: its wrapper's state, the run
 * it is in and what it waits on, the process history, its event streams with their pages, the
 * liveness providers (asked only for this session), its subagents and its MCP host. Pure: every
 * time comes from the answer and the page's `now`, and nothing here asks the server anything.
 */
export function DebugSessionDetailView({ detail, clock, titleOf, t, locale, id, name }: DebugSessionDetailViewProps) {
  const text = (key: DebugPageKey, params?: Record<string, string | number>) => debugPageText(locale, key, params);
  const ago = (at: number) => formatAgo(clock.age(at), t);
  const wrapper = detail.wrapper;
  const live = wrapper !== null && !wrapper.stale;
  const lifecycle = detail.lifecycle;
  const run = wrapper?.run ?? null;
  const pending = [
    run?.pendingPrompts ? t("debug.run.pending", { count: run.pendingPrompts }) : null,
    run?.retrying && t("debug.run.retrying"),
    run?.waitingForMcp && t("debug.run.waitingForMcp"),
    wrapper?.awaitingInput && wrapper.pendingUiRequests > 0 ? t("debug.server.uiRequests", { count: wrapper.pendingUiRequests }) : null,
    wrapper?.awaitingInput && wrapper.customUis > 0 ? t("debug.server.customUis", { count: wrapper.customUis }) : null,
  ].filter((chip): chip is string => Boolean(chip));
  const doing = [
    run?.streaming && t("debug.run.streaming"),
    run?.promptRunning && t("debug.run.prompt"),
    run?.bashRunning && t("debug.run.bash"),
    run?.compacting && t("debug.run.compacting"),
    run?.queuedMessages ? t("debug.run.queued", { count: run.queuedMessages }) : null,
    run?.runningTools ? t("debug.run.tools", { count: run.runningTools }) : null,
    run?.mutatingCommands ? t("debug.run.mutating", { count: run.mutatingCommands }) : null,
    run?.replacement && t("debug.run.replacement", { kind: run.replacement }),
  ].filter((chip): chip is string => Boolean(chip));
  const activity = wrapper
    ? joinParts([
      wrapper.startedAt !== null && `${t("debug.server.started")} ${ago(wrapper.startedAt)}`,
      live && wrapper.lastEvent && `${t("debug.server.lastEvent")} ${wrapper.lastEvent.type} ${ago(wrapper.lastEvent.at)}`,
      live && wrapper.lastCommand && `${t("debug.server.lastCommand")} ${wrapper.lastCommand.type} ${ago(wrapper.lastCommand.at)}`,
    ])
    : "";
  const subagents = detail.subagents;
  const mcp = detail.mcp;
  const mcpRelease = mcp && mcp.idleReleaseAt !== null && mcp.idleMs > 0 ? clock.remaining(mcp.idleReleaseAt) : null;

  return (
    <div className={styles.detail} id={id} role="group" aria-label={name}>
      <div className={styles.detailMeta}>
        <span className={styles.detailId}>{shortDebugId(detail.sessionId)}</span>
        {!wrapper && <span className={styles.faint}>{t(detail.starting ? "debug.server.starting" : "debug.server.noWrapper")}</span>}
        {wrapper?.state === "closing" && (
          <Chip tone="warning">{wrapper.closingAt !== null ? t("debug.server.closingSince", { time: ago(wrapper.closingAt) }) : t("debug.state.closing")}</Chip>
        )}
        {live && wrapper.extensions === "failed" && <Chip tone="warning">{`${t("debug.server.extensions")} ${t("debug.server.extensions.failed")}`}</Chip>}
        {wrapper?.chatOnly && <Chip tone="dim">{t("debug.server.chatOnly")}</Chip>}
        {wrapper?.subagent && <Chip tone="dim">{t("debug.server.subagent")}</Chip>}
        {wrapper?.stale && <Chip tone="warning">{t("debug.server.stale")}</Chip>}
        {doing.map((chip) => <Chip key={chip} tone="dim">{chip}</Chip>)}
        {pending.map((chip) => <Chip key={chip} tone="warning">{chip}</Chip>)}
        {activity && <span className={styles.entryLine}>{activity}</span>}
      </div>

      <div className={styles.detailGrid}>
        {lifecycle && (
          <Block title={text("detail.history")}>
            <Entry
              name={t("debug.overlay.starts", { count: lifecycle.starts })}
              lines={[
                text("detail.firstStart", { time: ago(lifecycle.firstStartedAt) }),
                t("debug.server.lastStart", { time: ago(lifecycle.lastStartedAt) }),
                lifecycle.lastClosedAt !== null && t("debug.server.lastClosed", { time: ago(lifecycle.lastClosedAt) }),
              ]}
            />
          </Block>
        )}

        <Block title={text("detail.streams")}>
          {detail.eventStreams.length === 0 && <p className={styles.faint}>{t("debug.none")}</p>}
          {detail.eventStreams.map((stream, index) => (
            <Entry
              key={`${stream.holder ?? ""}:${stream.openedAt}:${index}`}
              name={stream.holder === null ? t("debug.holder.none") : shortDebugId(stream.holder)}
              lines={[
                stream.client,
                stream.address,
                stream.connectedAt !== null
                  ? t("debug.server.streamConnected", { time: ago(stream.connectedAt) })
                  : t("debug.server.streamStarting"),
                stream.lastWriteAt !== null && t("debug.server.lastWrite", { time: ago(stream.lastWriteAt) }),
                stream.droppedEvents > 0 && t("debug.server.dropped", { count: stream.droppedEvents }),
                stream.queuedBytes > 0 && t("debug.server.queued", { size: formatBytes(stream.queuedBytes) }),
              ]}
            />
          ))}
        </Block>

        <Block title={t("debug.server.providers")}>
          {detail.providers === null && <p className={styles.faint}>{t("debug.server.providersUnknown")}</p>}
          {detail.providers?.length === 0 && <p className={styles.faint}>{t("debug.none")}</p>}
          {detail.providers?.map((provider, index) => (
            <div key={`${provider.name}:${index}`} className={styles.entry}>
              <span className={styles.entryName}>
                <Dot tone={provider.active === "error" ? "error" : provider.active ? "muted" : "dim"} ring={!provider.active} />
                {provider.name}
              </span>
              <span className={styles.entryLine}>
                {joinParts([
                  t(provider.active === "error"
                    ? "debug.server.providerError"
                    : provider.active ? "debug.server.providerActive" : "debug.server.providerInactive"),
                  provider.byFile && t("debug.server.byFile"),
                ])}
              </span>
            </div>
          ))}
        </Block>

        {(subagents.active || subagents.runs.length > 0 || subagents.notifications.length > 0) && (
          <Block
            title={t("debug.server.subagents")}
            extra={subagents.active ? <Chip tone="accent">{t("debug.server.subagentsActive")}</Chip> : null}
          >
            {subagents.runs.map((subagentRun, index) => (
              <Entry
                key={`${subagentRun.sessionId}:${index}`}
                name={titleOf(subagentRun.sessionId) ?? subagentRun.profile ?? shortDebugId(subagentRun.sessionId)}
                lines={[
                  translateDebugCode(subagentRun.status, DEBUG_RUN_STATUS_KEYS, t),
                  subagentRun.background && t("debug.server.background"),
                  subagentRun.resumed && t("debug.server.resumed"),
                  subagentRun.dispatchedAt !== null && ago(subagentRun.dispatchedAt),
                  subagentRun.abortRequested && t("debug.server.abortRequested"),
                  subagentRun.mcpWaiting && t("debug.run.waitingForMcp"),
                ]}
              />
            ))}
            {subagents.notifications.map((notification, index) => (
              <div key={`${notification.sessionId}:${index}`} className={`${styles.entryLine} ${styles.warnText}`}>
                {joinParts([
                  t("debug.server.notifying", { parent: shortDebugId(notification.parentSessionId) }),
                  notification.since !== null && ago(notification.since),
                ])}
              </div>
            ))}
          </Block>
        )}

        {mcp && (mcp.servers.length > 0 || mcp.problems > 0 || mcp.disposed) && (
          <Block
            title="MCP"
            extra={(
              <>
                {mcp.problems > 0 && <Chip tone="warning">{t("debug.server.mcpProblems", { count: mcp.problems })}</Chip>}
                {mcp.disposed && <Chip tone="dim">{t("debug.server.mcpDisposed")}</Chip>}
              </>
            )}
          >
            {mcp.servers.map((server, index) => {
              const { tone, filled } = mcpServerTone(server);
              const stateWord = translateDebugCode(server.state, MCP_SESSION_STATE_KEYS, t);
              return (
                <div
                  key={`${server.scope}:${server.name}:${index}`}
                  className={styles.entry}
                  title={joinParts([
                    `${server.name} (${server.scope})`,
                    stateWord,
                    server.released && t("debug.server.mcpReleased"),
                    server.hasError && t("debug.server.mcpError"),
                  ])}
                >
                  <span className={styles.entryName}>
                    <Dot tone={tone} ring={!filled} />
                    <span className={server.released ? styles.faint : undefined}>{server.name}</span>
                  </span>
                  {(server.state !== "connected" || server.hasError) && (
                    <span className={styles.entryLine}>{server.hasError && server.state === "connected" ? t("debug.server.mcpError") : stateWord}</span>
                  )}
                </div>
              );
            })}
            {mcpRelease !== null && (
              <div className={styles.idleRow}>
                <span className={styles.idleTrack} aria-hidden="true">
                  <span style={{ width: `${(barFraction(mcpRelease, mcp.idleMs) ?? 0) * 100}%` }} />
                </span>
                <span className={styles.entryLine}>{t("debug.server.mcpRelease", { time: formatCountdown(mcpRelease, t) })}</span>
              </div>
            )}
          </Block>
        )}
      </div>
    </div>
  );
}
