"use client";

import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { DebugSessionDetail as DebugSessionDetailData } from "@/lib/debug-types";
import { MCP_SESSION_STATE_KEYS } from "@/components/mcp-config-helpers";
import { translateMessage } from "@/lib/i18n/format";
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
} from "@/components/debug-panel-state";
import { debugPageText, type DebugPageKey } from "./messages";
import { dashboardRole, type DashboardRole } from "./dashboard-state";
import d from "./detail.module.css";

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
  /** Catalog-corrected role from the board, shared by summary and wrapper badges. */
  role?: DashboardRole;
}

/**
 * Words this detail alone needs, kept beside it so the page's own strings (messages.ts) stay one
 * file the layout owns. They are about how a compact row reads, not new server facts: the panel's
 * wording for states, countdowns and releases is reused through `t`.
 */
const DETAIL_EN = {
  "detail.idleWindow": "Idle window",
  "detail.streamRecords": "Stream records",
  "detail.runRecords": "Run records",
};

export type DebugDetailKey = keyof typeof DETAIL_EN;

/** Every locale carries every key of DETAIL_EN; no key shadows a global or a page string. */
export const DEBUG_DETAIL_MESSAGES: Record<Locale, Record<DebugDetailKey, string>> = {
  en: DETAIL_EN,
  "zh-CN": {
    "detail.idleWindow": "空闲窗口",
    "detail.streamRecords": "事件流记录",
    "detail.runRecords": "运行记录",
  },
  "zh-TW": {
    "detail.idleWindow": "閒置視窗",
    "detail.streamRecords": "事件串流紀錄",
    "detail.runRecords": "執行紀錄",
  },
};

const detailText = (locale: Locale, key: DebugDetailKey) => translateMessage(locale, key, DEBUG_DETAIL_MESSAGES);

/** How a lamp's ring is drawn: settled, still on its way there, or let go. */
type LampShape = "solid" | "dashed" | "dotted";

/**
 * A state lamp: an outer ring, a lit core and a faint halo. Its shape carries the kind of state
 * (solid: settled, dashed: connecting, dotted: released) and its colour the tone, so a red, an
 * amber and a let-go server never differ by hue alone. Only a state still on its way there
 * breathes, and the styles stop that under prefers-reduced-motion.
 */
function Lamp({ tone, shape = "solid", pulse = false }: { tone: DebugTone; shape?: LampShape; pulse?: boolean }) {
  return (
    <span className={d.lamp} data-tone={tone} data-shape={shape} data-pulse={pulse ? "on" : undefined} aria-hidden="true">
      <span className={d.lampCore} />
    </span>
  );
}

function Chip({ tone, children }: { tone: "dim" | "accent" | "warning" | "error"; children: ReactNode }) {
  return <span className={`${d.chip} ${d[`chip_${tone}`] ?? ""}`}>{children}</span>;
}

/** One server, stream, provider or run: a capsule whose tooltip carries the whole record. */
function Tag({ tone, shape, pulse, name, state, label, dim }: {
  tone: DebugTone;
  shape?: LampShape;
  pulse?: boolean;
  name: string;
  state?: string | null;
  /** The whole record, as the tooltip and the accessible name; defaults to name · state. */
  label?: string;
  dim?: boolean;
}) {
  const readable = label ?? joinParts([name, state]);
  return (
    <span className={`${d.tag}${dim ? ` ${d.tagDim}` : ""}`} role="img" aria-label={readable} title={readable}>
      <Lamp tone={tone} shape={shape} pulse={pulse} />
      <span className={d.tagName}>{name}</span>
      {state ? <span className={d.tagState}>{state}</span> : null}
    </span>
  );
}

function Block({ title, extra, children, kind }: { title: string; extra?: ReactNode; children: ReactNode; kind?: "timing" | "mcp" }) {
  return (
    <section className={d.block} data-kind={kind}>
      <h3 className={d.blockTitle}>
        <span className={d.blockTitleText}>{title}</span>
        {extra}
      </h3>
      {children}
    </section>
  );
}

/** One compact line per fact; the empty ones are left out. */
function Facts({ items }: { items: readonly (string | false | null | undefined)[] }) {
  const lines = items.filter((item): item is string => Boolean(item));
  if (lines.length === 0) return null;
  return (
    <div className={d.facts}>
      {lines.map((line, index) => <span key={`${line}:${index}`} className={d.fact}>{line}</span>)}
    </div>
  );
}

/** Long connection and run records, folded away so they never hold the default height. */
function Records({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={d.records}>
      <summary className={d.recordsTitle}>{title}</summary>
      <div className={d.recordsBody}>{children}</div>
    </details>
  );
}

const RUN_TONES: Partial<Record<string, DebugTone>> = {
  starting: "accent",
  running: "accent",
  completed: "ok",
  failed: "error",
  aborted: "warning",
  interrupted: "warning",
};

/** A subagent run's lamp: accent and breathing while it runs, then the status's own tone. */
function runLamp(status: string): { tone: DebugTone; shape: LampShape; pulse: boolean } {
  const tone = RUN_TONES[status] ?? "muted";
  const unsettled = status === "starting" || status === "running";
  return { tone, shape: unsettled ? "solid" : tone === "muted" ? "dashed" : "solid", pulse: unsettled };
}

/**
 * What the server holds for one session, under the row that opened it: its wrapper's state, the run
 * it is in and what it waits on, the process history, its event streams with their pages, the
 * liveness providers (asked only for this session), its subagents and its MCP host. States are
 * capsules and facts are one line each; the long records open on request. Pure: every time comes
 * from the answer and the page's `now`, and nothing here asks the server anything.
 */
export function DebugSessionDetailView({ detail, clock, titleOf, t, locale, id, name, role = dashboardRole(detail.wrapper) }: DebugSessionDetailViewProps) {
  const text = (key: DebugPageKey, params?: Record<string, string | number>) => debugPageText(locale, key, params);
  const local = (key: DebugDetailKey) => detailText(locale, key);
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
    <div className={d.detail} id={id} role="group" aria-label={name}>
      <div className={d.meta}>
        <span className={d.metaId}>{shortDebugId(detail.sessionId)}</span>
        {!wrapper && <span className={d.metaNote}>{t(detail.starting ? "debug.server.starting" : "debug.server.noWrapper")}</span>}
        {wrapper?.state === "closing" && (
          <Chip tone="warning">{wrapper.closingAt !== null ? t("debug.server.closingSince", { time: ago(wrapper.closingAt) }) : t("debug.state.closing")}</Chip>
        )}
        {live && <Chip tone={wrapper.extensions === "binding" || wrapper.extensions === "failed" ? "warning" : "dim"}>{`${t("debug.server.extensions")} ${t(`debug.server.extensions.${wrapper.extensions}`)}`}</Chip>}
        {wrapper?.chatOnly && <Chip tone="dim">{t("debug.server.chatOnly")}</Chip>}
        {role === "subagent" && <Chip tone="dim">{t("debug.server.subagent")}</Chip>}
        {role === "side" && <Chip tone="dim">{text("dense.side")}</Chip>}
        {wrapper?.stale && <Chip tone="warning">{t("debug.server.stale")}</Chip>}
        {doing.map((chip) => <Chip key={chip} tone="dim">{chip}</Chip>)}
        {pending.map((chip) => <Chip key={chip} tone="warning">{chip}</Chip>)}
        {activity && <span className={d.metaActivity}>{activity}</span>}
      </div>

      <div className={d.grid}>
        {live && (
          <Block title={text("board.timing")} kind="timing">
            <Facts items={[
              text("board.listeners", { count: wrapper.eventListeners }),
              wrapper.createdAt !== null && text("board.created", { time: ago(wrapper.createdAt) }),
              wrapper.idle.lastResetAt !== null && text("board.idleReset", { time: ago(wrapper.idle.lastResetAt) }),
              wrapper.idle.nextCheckAt !== null && text("board.nextCheck", { time: formatCountdown(clock.remaining(wrapper.idle.nextCheckAt), t) }),
              wrapper.idle.timeoutMs > 0 ? t("debug.server.idleTimeout", { time: formatCountdown(wrapper.idle.timeoutMs, t) }) : t("debug.server.idleDisabled"),
            ]} />
            {wrapper.idle.nextCheckAt === null && <p className={d.note}>{text("dense.noCheck")}</p>}
            {wrapper.idle.nextCheckAt !== null && <div className={d.release} title={text("dense.reapHint")}>
              {wrapper.idle.timeoutMs > 0 && <span className={d.meter} aria-hidden="true"><span className={d.meterFill} style={{ width: `${(barFraction(clock.remaining(wrapper.idle.nextCheckAt), wrapper.idle.timeoutMs) ?? 0) * 100}%` }} /></span>}
              <span className={d.releaseText}>{text("dense.reap")} · {formatCountdown(clock.remaining(wrapper.idle.nextCheckAt), t)}</span>
            </div>}
            {wrapper.idle.nextCheckAt !== null && <p className={d.note}>{text("dense.reapHint")}</p>}
            {wrapper.idle.forcedByStop && <p className={d.warnLine}>{t("debug.server.idleForced")}</p>}
            <Records title={local("detail.idleWindow")}>
              <Facts items={[t("debug.server.idleHint")]} />
            </Records>
          </Block>
        )}

        {mcp && (
          <Block
            title="MCP"
            kind="mcp"
            extra={(
              <>
                {mcp.problems > 0 && <Chip tone="warning">{t("debug.server.mcpProblems", { count: mcp.problems })}</Chip>}
                {mcp.disposed && <Chip tone="dim">{t("debug.server.mcpDisposed")}</Chip>}
              </>
            )}
          >
            <Facts items={[text("board.mcpState", { active: text(mcp.active ? "board.yes" : "board.no"), running: text(mcp.runActive ? "board.yes" : "board.no") })]} />
            <div className={d.tags}>
              {mcp.servers.map((server, index) => {
                const { tone, filled } = mcpServerTone(server);
                const stateWord = translateDebugCode(server.state, MCP_SESSION_STATE_KEYS, t);
                const label = joinParts([
                  `${server.name} (${server.scope})`,
                  stateWord,
                  server.released && t("debug.server.mcpReleased"),
                  server.hasError && t("debug.server.mcpError"),
                ]);
                // Anything but a settled connection says so in words beside the lamp; the scope
                // and the whole record stay in the tooltip and the accessible name.
                const word = joinParts([
                  server.state !== "connected" ? stateWord : null,
                  server.hasError && server.state !== "failed" && server.state !== "conflict" ? t("debug.server.mcpError") : null,
                  server.released && t("debug.server.mcpReleased"),
                ]);
                return (
                  <Tag
                    key={`${server.scope}:${server.name}:${index}`}
                    tone={tone}
                    shape={filled ? "solid" : tone === "dim" ? "dotted" : "dashed"}
                    pulse={!filled && tone !== "dim"}
                    name={server.name}
                    state={word || null}
                    label={label}
                    dim={server.released}
                  />
                );
              })}
            </div>
            {mcpRelease !== null && (
              <div className={d.release}>
                <span className={d.meter} aria-hidden="true">
                  <span className={d.meterFill} style={{ width: `${(barFraction(mcpRelease, mcp.idleMs) ?? 0) * 100}%` }} />
                </span>
                <span className={d.releaseText}>{t("debug.server.mcpRelease", { time: formatCountdown(mcpRelease, t) })}</span>
              </div>
            )}
          </Block>
        )}

        <Block title={text("detail.streams")}>
          {detail.eventStreams.length === 0 && <p className={d.empty}>{t("debug.none")}</p>}
          {detail.eventStreams.length > 0 && (
            <div className={d.tags}>
              {detail.eventStreams.map((stream, index) => {
                const starting = stream.connectedAt === null;
                const label = joinParts([
                  stream.holder === null ? t("debug.holder.none") : shortDebugId(stream.holder),
                  stream.client,
                  stream.address,
                  stream.connectedAt === null ? t("debug.server.streamStarting") : t("debug.server.streamConnected", { time: ago(stream.connectedAt) }),
                  stream.lastWriteAt !== null && t("debug.server.lastWrite", { time: ago(stream.lastWriteAt) }),
                  stream.droppedEvents > 0 && t("debug.server.dropped", { count: stream.droppedEvents }),
                  stream.queuedBytes > 0 && t("debug.server.queued", { size: formatBytes(stream.queuedBytes) }),
                ]);
                return (
                  <Tag
                    key={`${stream.holder ?? ""}:${stream.openedAt}:${index}`}
                    tone={starting || stream.droppedEvents > 0 ? "warning" : "ok"}
                    shape={starting ? "dashed" : "solid"}
                    pulse={starting}
                    name={stream.holder === null ? t("debug.holder.none") : shortDebugId(stream.holder)}
                    state={stream.connectedAt === null ? t("debug.server.streamStarting") : t("debug.server.streamConnected", { time: ago(stream.connectedAt) })}
                    label={label}
                  />
                );
              })}
            </div>
          )}
          {detail.eventStreams.length > 0 && (
            <Records title={local("detail.streamRecords")}>
              {detail.eventStreams.map((stream, index) => (
                <div key={`${stream.holder ?? ""}:${stream.openedAt}:${index}:record`} className={d.record}>
                  <span className={d.recordName}>
                    {joinParts([stream.holder === null ? t("debug.holder.none") : shortDebugId(stream.holder), stream.client, stream.address])}
                  </span>
                  <Facts items={[
                    text("board.streamOpened", { time: ago(stream.openedAt) }),
                    stream.connectedAt !== null ? t("debug.server.streamConnected", { time: ago(stream.connectedAt) }) : t("debug.server.streamStarting"),
                    stream.lastWriteAt !== null && t("debug.server.lastWrite", { time: ago(stream.lastWriteAt) }),
                    stream.droppedEvents > 0 && t("debug.server.dropped", { count: stream.droppedEvents }),
                    stream.queuedBytes > 0 && t("debug.server.queued", { size: formatBytes(stream.queuedBytes) }),
                  ]} />
                </div>
              ))}
            </Records>
          )}
        </Block>

        <Block title={t("debug.server.providers")}>
          {detail.providers === null && <p className={d.empty}>{t("debug.server.providersUnknown")}</p>}
          {detail.providers?.length === 0 && <p className={d.empty}>{t("debug.none")}</p>}
          {detail.providers && detail.providers.length > 0 && (
            <div className={d.tags}>
              {detail.providers.map((provider, index) => {
                const state = joinParts([
                  t(provider.active === "error"
                    ? "debug.server.providerError"
                    : provider.active ? "debug.server.providerActive" : "debug.server.providerInactive"),
                  provider.byFile && t("debug.server.byFile"),
                ]);
                return (
                  <Tag
                    key={`${provider.name}:${index}`}
                    tone={provider.active === "error" ? "error" : provider.active ? "ok" : "dim"}
                    shape={provider.active ? "solid" : "dotted"}
                    name={provider.name}
                    state={state}
                    label={joinParts([provider.name, state])}
                  />
                );
              })}
            </div>
          )}
        </Block>

        {(subagents.active || subagents.runs.length > 0 || subagents.notifications.length > 0) && (
          <Block
            title={t("debug.server.subagents")}
            extra={subagents.active ? <Chip tone="accent">{t("debug.server.subagentsActive")}</Chip> : null}
          >
            {subagents.runs.length > 0 && (
              <div className={d.tags}>
                {subagents.runs.map((subagentRun, index) => {
                  const lamp = runLamp(subagentRun.status);
                  // The parent and the rest of the run stay on the record; the capsule keeps the
                  // run's own name, status and the facts that change what it is doing.
                  const state = joinParts([
                    translateDebugCode(subagentRun.status, DEBUG_RUN_STATUS_KEYS, t),
                    subagentRun.profile,
                    subagentRun.background && t("debug.server.background"),
                    subagentRun.resumed && t("debug.server.resumed"),
                  ]);
                  const label = joinParts([
                    titleOf(subagentRun.sessionId) ?? subagentRun.profile ?? shortDebugId(subagentRun.sessionId),
                    translateDebugCode(subagentRun.status, DEBUG_RUN_STATUS_KEYS, t),
                    subagentRun.profile,
                    text("board.parent", { name: titleOf(subagentRun.parentSessionId) ?? shortDebugId(subagentRun.parentSessionId) }),
                    subagentRun.background && t("debug.server.background"),
                    subagentRun.resumed && t("debug.server.resumed"),
                    subagentRun.dispatchedAt !== null && ago(subagentRun.dispatchedAt),
                    subagentRun.abortRequested && t("debug.server.abortRequested"),
                    subagentRun.mcpWaiting && t("debug.run.waitingForMcp"),
                  ]);
                  return (
                    <Tag
                      key={`${subagentRun.sessionId}:${index}`}
                      tone={lamp.tone}
                      shape={lamp.shape}
                      pulse={lamp.pulse}
                      name={titleOf(subagentRun.sessionId) ?? subagentRun.profile ?? shortDebugId(subagentRun.sessionId)}
                      state={state}
                      label={label}
                    />
                  );
                })}
              </div>
            )}
            {subagents.runs.length > 0 && (
              <Records title={local("detail.runRecords")}>
                {subagents.runs.map((subagentRun, index) => (
                  <div key={`${subagentRun.sessionId}:${index}:record`} className={d.record}>
                    <span className={d.recordName}>
                      {titleOf(subagentRun.sessionId) ?? subagentRun.profile ?? shortDebugId(subagentRun.sessionId)}
                    </span>
                    <Facts items={[
                      translateDebugCode(subagentRun.status, DEBUG_RUN_STATUS_KEYS, t),
                      text("board.parent", { name: titleOf(subagentRun.parentSessionId) ?? shortDebugId(subagentRun.parentSessionId) }),
                      subagentRun.profile,
                      subagentRun.background && t("debug.server.background"),
                      subagentRun.resumed && t("debug.server.resumed"),
                      subagentRun.dispatchedAt !== null && ago(subagentRun.dispatchedAt),
                      subagentRun.abortRequested && t("debug.server.abortRequested"),
                      subagentRun.mcpWaiting && t("debug.run.waitingForMcp"),
                    ]} />
                  </div>
                ))}
              </Records>
            )}
            {subagents.notifications.map((notification, index) => (
              <p key={`${notification.sessionId}:${index}`} className={d.warnLine}>
                {joinParts([
                  titleOf(notification.sessionId) ?? shortDebugId(notification.sessionId),
                  t("debug.server.notifying", { parent: titleOf(notification.parentSessionId) ?? shortDebugId(notification.parentSessionId) }),
                  notification.since !== null && ago(notification.since),
                ])}
              </p>
            ))}
          </Block>
        )}

        {lifecycle && (
          <Block title={text("detail.history")}>
            <Facts items={[
              t("debug.overlay.starts", { count: lifecycle.starts }),
              text("detail.firstStart", { time: ago(lifecycle.firstStartedAt) }),
              t("debug.server.lastStart", { time: ago(lifecycle.lastStartedAt) }),
              lifecycle.lastClosedAt !== null && t("debug.server.lastClosed", { time: ago(lifecycle.lastClosedAt) }),
            ]} />
          </Block>
        )}
      </div>
    </div>
  );
}
