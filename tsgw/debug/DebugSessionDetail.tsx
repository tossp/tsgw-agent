"use client";

import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/types";
import type { DebugSessionDetail as DebugSessionDetailData, DebugEventStream } from "@/lib/debug-types";
import { MCP_SESSION_STATE_KEYS } from "@/components/mcp-config-helpers";
import { translateMessage } from "@/lib/i18n/format";
import {
  DEBUG_RUN_STATUS_KEYS, barFraction, formatAgo, formatBytes, formatCountdown, joinParts,
  mcpServerTone, shortDebugId, translateDebugCode,
  type DebugServerClock, type DebugTitleOf, type DebugTone, type Translate,
} from "@/components/debug-panel-state";
import { debugPageText, type DebugPageKey } from "./messages";
import { dashboardRole, type DashboardRole } from "./dashboard-state";
import d from "./detail.module.css";

export interface DebugSessionDetailViewProps {
  /** Only this session's answer; reading it starts or renews nothing. */
  detail: DebugSessionDetailData;
  clock: DebugServerClock;
  titleOf: DebugTitleOf;
  t: Translate;
  locale: Locale;
  id: string;
  name: string;
  /** Catalog-corrected role from the board, shared by summary and wrapper badges. */
  role?: DashboardRole;
  /** Family rows may render these same runs/notifications themselves. Defaults to true. */
  showSubagents?: boolean;
}

const DETAIL_EN = {
  "detail.created": "Created {time}",
  "detail.opened": "open {time}",
  "detail.openConnected": "open / connected {time}",
  "detail.write": "write {time}",
};
export type DebugDetailKey = keyof typeof DETAIL_EN;
export const DEBUG_DETAIL_MESSAGES: Record<Locale, Record<DebugDetailKey, string>> = {
  en: DETAIL_EN,
  "zh-CN": {
    "detail.created": "创建 {time}",
    "detail.opened": "打开 {time}",
    "detail.openConnected": "打开 / 连接 {time}",
    "detail.write": "写出 {time}",
  },
  "zh-TW": {
    "detail.created": "建立 {time}",
    "detail.opened": "開啟 {time}",
    "detail.openConnected": "開啟 / 連線 {time}",
    "detail.write": "寫出 {time}",
  },
};

type LampShape = "solid" | "dashed" | "dotted";
function Lamp({ tone, shape = "solid", pulse = false }: { tone: DebugTone; shape?: LampShape; pulse?: boolean }) {
  return <span className={d.lamp} data-tone={tone} data-shape={shape} data-pulse={pulse ? "on" : undefined} aria-hidden="true"><span className={d.lampCore} /></span>;
}
function Chip({ tone, children }: { tone: "dim" | "accent" | "warning" | "error"; children: ReactNode }) {
  return <span className={`${d.chip} ${d[`chip_${tone}`]}`}>{children}</span>;
}

/** Compact lamps; errors and release words are visible, never just tooltips. */
function Tag({ tone, shape, pulse, name, state, label, dim }: {
  tone: DebugTone; shape?: LampShape; pulse?: boolean; name: string;
  state?: string | null; label?: string; dim?: boolean;
}) {
  const readable = label ?? joinParts([name, state]);
  return <span className={`${d.tag}${dim ? ` ${d.tagDim}` : ""}`} role="img" aria-label={readable} title={readable} data-tone={tone}>
    <Lamp tone={tone} shape={shape} pulse={pulse} />
    <span className={d.tagName}>{name}</span>
    {state ? <span className={d.tagState}>{state}</span> : null}
  </span>;
}
function Row({ title, children, kind }: { title: string; children: ReactNode; kind?: string }) {
  return <section className={d.row} data-kind={kind} aria-label={title}>
    <h3 className={d.rowLabel}>{title}</h3><div className={d.rowBody}>{children}</div>
  </section>;
}
function Facts({ items }: { items: readonly (string | false | null | undefined)[] }) {
  return <span className={d.facts}>{items.filter((item): item is string => Boolean(item)).map((item, index) => <span className={d.fact} key={index}>{item}</span>)}</span>;
}
function Meter({ remaining, total, children }: { remaining: number; total: number; children: ReactNode }) {
  return <span className={d.release}><span className={d.releaseText}>{children}</span>
    {total > 0 && <span className={d.meter} aria-hidden="true"><span className={d.meterFill} style={{ width: `${(barFraction(remaining, total) ?? 0) * 100}%` }} /></span>}
  </span>;
}

/** A missing holder is not an identity: keep every legacy connection separate. */
function streamGroups(streams: DebugEventStream[]) {
  const groups: { holder: string | null; streams: DebugEventStream[] }[] = [];
  const identified = new Map<string, typeof groups[number]>();
  for (const stream of streams) {
    let group = stream.holder === null ? undefined : identified.get(stream.holder);
    if (!group) {
      group = { holder: stream.holder, streams: [] };
      groups.push(group);
      if (stream.holder !== null) identified.set(stream.holder, group);
    }
    group.streams.push(stream);
  }
  return groups;
}
const RUN_TONES: Partial<Record<string, DebugTone>> = {
  starting: "accent", running: "accent", completed: "ok", failed: "error", aborted: "warning", interrupted: "warning",
};

/** All records are readable by default; no disclosures, timers, requests or truncating heights. */
export function DebugSessionDetailView({ detail, clock, titleOf, t, locale, id, name, role = dashboardRole(detail.wrapper), showSubagents = true }: DebugSessionDetailViewProps) {
  const text = (key: DebugPageKey, params?: Record<string, string | number>) => debugPageText(locale, key, params);
  const local = (key: DebugDetailKey, params?: Record<string, string | number>) => translateMessage(locale, key, DEBUG_DETAIL_MESSAGES, params);
  const ago = (at: number) => formatAgo(clock.age(at), t);
  const wrapper = detail.wrapper;
  const live = wrapper !== null && !wrapper.stale;
  const lifecycle = detail.lifecycle;
  const run = wrapper?.run ?? null;
  const pending = [
    run?.pendingPrompts ? t("debug.run.pending", { count: run.pendingPrompts }) : null,
    run?.retrying && t("debug.run.retrying"), run?.waitingForMcp && t("debug.run.waitingForMcp"),
    wrapper?.awaitingInput && wrapper.pendingUiRequests > 0 ? t("debug.server.uiRequests", { count: wrapper.pendingUiRequests }) : null,
    wrapper?.awaitingInput && wrapper.customUis > 0 ? t("debug.server.customUis", { count: wrapper.customUis }) : null,
  ].filter((chip): chip is string => Boolean(chip));
  const doing = [
    run?.running && t("debug.overlay.running"),
    run?.streaming && t("debug.run.streaming"), run?.promptRunning && t("debug.run.prompt"),
    run?.bashRunning && t("debug.run.bash"), run?.compacting && t("debug.run.compacting"),
    run?.queuedMessages ? t("debug.run.queued", { count: run.queuedMessages }) : null,
    run?.runningTools ? t("debug.run.tools", { count: run.runningTools }) : null,
    run?.mutatingCommands ? t("debug.run.mutating", { count: run.mutatingCommands }) : null,
    run?.replacement && t("debug.run.replacement", { kind: run.replacement }),
    wrapper?.awaitingInput && t("debug.overlay.awaiting"),
  ].filter((chip): chip is string => Boolean(chip));
  const subagents = detail.subagents;
  const mcp = detail.mcp;
  const mcpRelease = mcp && mcp.idleReleaseAt !== null && mcp.idleMs > 0 ? clock.remaining(mcp.idleReleaseAt) : null;

  return <div className={d.detail} id={id} role="group" aria-label={name}>
    <div className={d.meta}>
      <span className={d.metaId}>{shortDebugId(detail.sessionId)}</span>
      {!wrapper && <span className={d.metaNote}>{t(detail.starting ? "debug.server.starting" : "debug.server.noWrapper")}</span>}
      {wrapper?.state === "closing" && <Chip tone="warning">{wrapper.closingAt !== null ? t("debug.server.closingSince", { time: ago(wrapper.closingAt) }) : t("debug.state.closing")}</Chip>}
      {live && <Chip tone={wrapper.extensions === "failed" ? "error" : wrapper.extensions === "binding" ? "warning" : "dim"}>{`${t("debug.server.extensions")} ${t(`debug.server.extensions.${wrapper.extensions}`)}`}</Chip>}
      {wrapper?.chatOnly && <Chip tone="dim">{t("debug.server.chatOnly")}</Chip>}
      {role === "subagent" && <Chip tone="dim">{t("debug.server.subagent")}</Chip>}
      {role === "side" && <Chip tone="dim">{text("dense.side")}</Chip>}
      {wrapper?.stale && <Chip tone="warning">{t("debug.server.stale")}</Chip>}
      {doing.map(chip => <Chip key={chip} tone="dim">{chip}</Chip>)}
      {pending.map(chip => <Chip key={chip} tone="warning">{chip}</Chip>)}
      <Facts items={[
        wrapper?.startedAt != null && `${t("debug.server.started")} ${ago(wrapper.startedAt)}`,
        live && wrapper.lastEvent && `${t("debug.server.lastEvent")} ${wrapper.lastEvent.type} ${ago(wrapper.lastEvent.at)}`,
        live && wrapper.lastCommand && `${t("debug.server.lastCommand")} ${wrapper.lastCommand.type} ${ago(wrapper.lastCommand.at)}`,
      ]} />
    </div>

    {live && <Row title={text("dense.reap")} kind="timing">
      {wrapper.idle.nextCheckAt !== null
        ? <Meter remaining={clock.remaining(wrapper.idle.nextCheckAt)} total={wrapper.idle.timeoutMs}>{formatCountdown(clock.remaining(wrapper.idle.nextCheckAt), t)}</Meter>
        : <span className={d.note}>{text("dense.noCheck")}</span>}
      <Facts items={[
        wrapper.createdAt !== null && local("detail.created", { time: ago(wrapper.createdAt) }),
        text("board.listeners", { count: wrapper.eventListeners }),
      ]} />
      {wrapper.idle.forcedByStop && <span className={d.warnLine}>{t("debug.server.idleForced")}</span>}
    </Row>}

    {mcp && <Row title="MCP" kind="mcp">
      <span className={d.tags}>{mcp.servers.map((server, index) => {
        const { tone, filled } = mcpServerTone(server);
        const stateWord = translateDebugCode(server.state, MCP_SESSION_STATE_KEYS, t);
        const word = joinParts([
          server.state !== "connected" ? stateWord : null,
          server.hasError && server.state !== "failed" && server.state !== "conflict" ? t("debug.server.mcpError") : null,
          server.released && t("debug.server.mcpReleased"),
        ]);
        return <Tag key={`${server.scope}:${server.name}:${index}`} tone={tone}
          shape={filled ? "solid" : tone === "dim" ? "dotted" : "dashed"} pulse={!filled && tone !== "dim"}
          name={server.name} state={word || null}
          label={joinParts([`${server.name} (${server.scope})`, stateWord, server.hasError && t("debug.server.mcpError"), server.released && t("debug.server.mcpReleased")])}
          dim={server.released && tone !== "error"} />;
      })}</span>
      {mcp.servers.length === 0 && <span className={d.empty}>{t("debug.none")}</span>}
      <span className={d.host}>
        <span className={d.fact}>{text("board.mcpState", { active: text(mcp.active ? "board.yes" : "board.no"), running: text(mcp.runActive ? "board.yes" : "board.no") })}</span>
        {mcpRelease !== null && <Meter remaining={mcpRelease} total={mcp.idleMs}>{t("debug.server.mcpRelease", { time: formatCountdown(mcpRelease, t) })}</Meter>}
        {mcp.problems > 0 && <Chip tone="warning">{t("debug.server.mcpProblems", { count: mcp.problems })}</Chip>}
        {mcp.disposed && <Chip tone="dim">{t("debug.server.mcpDisposed")}</Chip>}
      </span>
    </Row>}

    <Row title={text("detail.streams")} kind="streams">
      {detail.eventStreams.length === 0 && <span className={d.empty}>{t("debug.none")}</span>}
      {streamGroups(detail.eventStreams).map((group, groupIndex) => {
        const sameSource = group.streams.every(stream => stream.client === group.streams[0].client && stream.address === group.streams[0].address);
        const warning = group.streams.some(stream => stream.connectedAt === null || stream.droppedEvents > 0 || stream.queuedBytes > 0);
        return <div className={d.streamGroup} key={`${group.holder}:${groupIndex}`} data-holder={group.holder ?? undefined} data-tone={warning ? "warning" : "ok"}>
          <span className={d.streamSource}>
            <Lamp tone={warning ? "warning" : "ok"} />
            <strong>SSE ×{group.streams.length}</strong>
            <span>{group.holder === null ? `${t("debug.holder.none")} #${groupIndex + 1}` : shortDebugId(group.holder)}</span>
            {sameSource && <span>{joinParts([group.streams[0].client, group.streams[0].address])}</span>}
          </span>
          {group.streams.map((stream, index) => {
            const starting = stream.connectedAt === null;
            const unhealthy = starting || stream.droppedEvents > 0 || stream.queuedBytes > 0;
            return <span className={d.streamRecord} key={index} data-tone={unhealthy ? "warning" : "ok"}>
              <span className={d.connectionIndex}>#{index + 1}</span>
              {!sameSource && <span>{joinParts([stream.client, stream.address])}</span>}
              <Facts items={[
                stream.connectedAt === stream.openedAt ? local("detail.openConnected", { time: ago(stream.openedAt) }) : local("detail.opened", { time: ago(stream.openedAt) }),
                stream.connectedAt !== stream.openedAt && (starting ? t("debug.server.streamStarting") : t("debug.server.streamConnected", { time: ago(stream.connectedAt!) })),
                stream.lastWriteAt !== null && local("detail.write", { time: ago(stream.lastWriteAt) }),
              ]} />
              {stream.droppedEvents > 0 && <span className={d.warnLine}>{t("debug.server.dropped", { count: stream.droppedEvents })}</span>}
              {stream.queuedBytes > 0 && <span className={d.warnLine}>{t("debug.server.queued", { size: formatBytes(stream.queuedBytes) })}</span>}
            </span>;
          })}
        </div>;
      })}
    </Row>

    <div className={d.process}>
      <Row title={t("debug.server.providers")} kind="providers">
        {detail.providers === null && <span className={d.empty}>{t("debug.server.providersUnknown")}</span>}
        {detail.providers?.length === 0 && <span className={d.empty}>{t("debug.none")}</span>}
        {detail.providers?.map((provider, index) => <Tag key={`${provider.name}:${index}`}
          tone={provider.active === "error" ? "error" : provider.active ? "ok" : "dim"} shape={provider.active ? "solid" : "dotted"}
          name={provider.name} state={joinParts([
            t(provider.active === "error" ? "debug.server.providerError" : provider.active ? "debug.server.providerActive" : "debug.server.providerInactive"),
            provider.byFile && t("debug.server.byFile"),
          ])} />)}
      </Row>
      <Row title={text("detail.history")} kind="history">
        {lifecycle ? <Facts items={[
          t("debug.overlay.starts", { count: lifecycle.starts }),
          text("detail.firstStart", { time: ago(lifecycle.firstStartedAt) }),
          t("debug.server.lastStart", { time: ago(lifecycle.lastStartedAt) }),
          lifecycle.lastClosedAt !== null && t("debug.server.lastClosed", { time: ago(lifecycle.lastClosedAt) }),
        ]} /> : <span className={d.empty}>{t("debug.none")}</span>}
      </Row>
    </div>

    {showSubagents && (subagents.active || subagents.runs.length > 0 || subagents.notifications.length > 0) && <Row title={t("debug.server.subagents")} kind="subagents">
      {subagents.active && <span className={d.subagentNote}>{t("debug.server.subagentsActive")}</span>}
      <div className={d.runRows}>{subagents.runs.map((item, index) => {
        const tone = RUN_TONES[item.status] ?? "muted";
        return <div className={d.runRow} key={`${item.sessionId}:${index}`} data-tone={tone}>
          <span className={d.runName}><Lamp tone={tone} pulse={item.status === "running" || item.status === "starting"} />{titleOf(item.sessionId) ?? item.profile ?? shortDebugId(item.sessionId)}</span>
          <span>{translateDebugCode(item.status, DEBUG_RUN_STATUS_KEYS, t)}</span>
          <Facts items={[item.profile, item.background && t("debug.server.background"), item.resumed && t("debug.server.resumed")]} />
          <span className={d.fact}>{item.dispatchedAt !== null ? ago(item.dispatchedAt) : "—"}</span>
          <span className={d.fact}>{text("board.parent", { name: titleOf(item.parentSessionId) ?? shortDebugId(item.parentSessionId) })}</span>
          {(item.abortRequested || item.mcpWaiting) && <span className={d.runWarnings}>
            {item.abortRequested && <span className={d.warnLine}>{t("debug.server.abortRequested")}</span>}
            {item.mcpWaiting && <span className={d.warnLine}>{t("debug.run.waitingForMcp")}</span>}
          </span>}
        </div>;
      })}</div>
      {subagents.notifications.map((notification, index) => <span key={`${notification.sessionId}:${index}`} className={d.warnLine}>{joinParts([
        titleOf(notification.sessionId) ?? shortDebugId(notification.sessionId),
        t("debug.server.notifying", { parent: titleOf(notification.parentSessionId) ?? shortDebugId(notification.parentSessionId) }),
        notification.since !== null && ago(notification.since),
      ])}</span>)}
    </Row>}
  </div>;
}
