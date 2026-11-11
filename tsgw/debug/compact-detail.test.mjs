import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
import { SECOND, MINUTE, LOCAL, SERVER, reply, catalog } from "./fixtures.mjs";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DebugSessionDetailView, DEBUG_DETAIL_MESSAGES } = await jiti.import("./DebugSessionDetail.tsx");
const { debugServerClock, barFraction } = await jiti.import("@/components/debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const { DEBUG_PAGE_MESSAGES } = await jiti.import("./messages.ts");
const css = await readFile(new URL("./detail.module.css", import.meta.url), "utf8");
const locales = { en: enLocale, "zh-CN": zhCNLocale, "zh-TW": zhTWLocale };
const translator = locale => (key, params) => {
  assert.equal(typeof locales[locale].messages[key], "string", `missing translation ${key}`);
  return interpolateMessage(locales[locale].messages[key], params);
};
const decode = html => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const titleOf = id => catalog.find(entry => entry.id === id)?.name || catalog.find(entry => entry.id === id)?.firstMessage || null;
const clockAt = now => debugServerClock(SERVER, LOCAL - 10 * SECOND, now);
function render({ detail = reply().session, now = LOCAL, locale = "en", ...rest } = {}) {
  return decode(renderToStaticMarkup(React.createElement(DebugSessionDetailView, {
    detail, clock: clockAt(now), titleOf, t: translator(locale), locale, id: "debug-session-s1", name: "Current chat", ...rest,
  })));
}

test("MCP lamps form a compact row; errors and release states remain visible", () => {
  const detail = reply().session;
  detail.mcp.servers.push(
    { name: "idle", scope: "global", state: "connected", hasError: false, released: true },
    { name: "dialing", scope: "project", state: "connecting", hasError: false, released: false },
    { name: "released-error", scope: "project", state: "connected", hasError: true, released: true },
  );
  const html = render({ detail });
  const text = visibleText(html);
  assert.match(text, /files/);
  assert.match(text, /jira Did not connect/);
  assert.match(text, /idle released/);
  assert.match(text, /dialing Connecting/);
  assert.match(text, /released-error error · released/);
  assert.match(html, /class="tag"[^>]*data-tone="error"[^>]*><span class="lamp"/);
  assert.match(text, /Host Execution/);
  assert.doesNotMatch(text, /Host active:|run active:/);
  assert.match(text, /1 problems/);
  assert.match(html, /aria-label="files \(global\) · Connected"/);
  assert.match(html, /data-shape="dotted"/);
  assert.match(html, /data-shape="dashed" data-pulse="on"/);
  assert.match(css, /\.lamp\s*\{[^}]*border: 1px solid currentColor/);
  assert.match(css, /\.lampCore\s*\{[^}]*0 0 5px 1px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
});

test("MCP host and execution use independent lamp tags with localized tooltips", () => {
  for (const [locale, hostName, executionName, hostPrefix, executionPrefix, yes, no] of [
    ["en", "Host", "Execution", "MCP host active: ", "Agent run active: ", "yes", "no"],
    ["zh-CN", "宿主", "执行", "MCP 宿主活跃：", "Agent 执行活跃：", "是", "否"],
    ["zh-TW", "宿主", "執行", "MCP 宿主活躍：", "Agent 執行活躍：", "是", "否"],
  ]) for (const active of [false, true]) for (const runActive of [false, true]) {
    const detail = reply().session;
    Object.assign(detail.mcp, { active, runActive });
    const html = render({ detail, locale });
    const tags = [...html.matchAll(/<span class="tag" role="img" aria-label="([^"]+)" title="([^"]+)" data-tone="([^"]+)"><span class="lamp" data-tone="([^"]+)" data-shape="([^"]+)"/g)];
    for (const [prefix, enabled] of [[hostPrefix, active], [executionPrefix, runActive]]) {
      const matches = tags.filter(tag => tag[1].startsWith(prefix));
      assert.equal(matches.length, 1, prefix);
      const [, label, tip, tone, lampTone, shape] = matches[0];
      assert.ok(label.startsWith(prefix + (enabled ? yes : no)));
      assert.equal(tip, label, "accessible label and tooltip describe the same state");
      assert.equal(tone, enabled ? "ok" : "dim");
      assert.equal(lampTone, tone);
      assert.equal(shape, enabled ? "solid" : "dotted", "state is not conveyed by color alone");
    }
    assert.ok(visibleText(html).includes(hostName + " " + executionName));
    assert.ok(!visibleText(html).includes(hostPrefix));
    assert.ok(!visibleText(html).includes(executionPrefix));
  }
});

test("MCP release and reap check each keep one real countdown and a moving bar", () => {
  const detail = reply().session;
  const first = render({ detail }), later = render({ detail, now: LOCAL + 30 * SECOND });
  assert.match(visibleText(first), /idle release in 1m 50s/);
  assert.match(visibleText(later), /idle release in 1m 20s/);
  const width = (remaining, total) => `width:${barFraction(remaining, total) * 100}%`;
  assert.ok(first.includes(width(110 * SECOND, 5 * MINUTE)));
  assert.ok(later.includes(width(80 * SECOND, 5 * MINUTE)));
  assert.ok(first.includes(width(500 * SECOND, 10 * MINUTE)));
  assert.ok(later.includes(width(470 * SECOND, 10 * MINUTE)));
  assert.equal(visibleText(first).split("in 8m 20s").length - 1, 1, "no duplicate reap countdown");
  assert.doesNotMatch(visibleText(first), /Next idle check|Reset|timeout|threshold/i);
  assert.doesNotMatch(first, /lastResetAt|idleTimeout|idleReset|idleHint/);
  detail.wrapper.idle.nextCheckAt = null;
  assert.match(visibleText(render({ detail })), /No check scheduled/);
  detail.wrapper.idle.timeoutMs = 0;
  detail.wrapper.idle.nextCheckAt = SERVER + MINUTE;
  detail.wrapper.idle.forcedByStop = true;
  assert.match(visibleText(render({ detail })), /Stopped: the session closes/);
  assert.doesNotMatch(visibleText(render({ detail })), /disabled|timeout|threshold/i);
});

test("SSE groups only non-null equal holders; every connection time and anomaly is visible", () => {
  const detail = reply().session;
  const stream = detail.eventStreams[0];
  detail.eventStreams = [
    stream,
    { ...stream, connectedAt: SERVER - MINUTE, droppedEvents: 4, queuedBytes: 2048 },
    { ...stream, connectedAt: null, client: "Firefox · Linux", address: "10.0.0.2" },
    { ...stream, holder: null }, { ...stream, holder: null },
    { ...stream, holder: "another-holder", client: "Safari · iOS" },
  ];
  const html = render({ detail }), text = visibleText(html);
  assert.equal((html.match(/class="streamGroup"/g) ?? []).length, 4);
  assert.equal((html.match(/class="streamRecord"/g) ?? []).length, 6);
  assert.equal(text.split("SSE ×3").length - 1, 1);
  assert.equal(text.split("SSE ×1").length - 1, 3, "null holders are not a fake shared page");
  for (const fact of ["Chrome · macOS", "Firefox · Linux", "10.0.0.2", "127.0.0.1", "Safari · iOS", "open / connected 5m 10s ago", "connected 1m 10s ago", "write 13s ago", "starting the session", "4 dropped", "2.0 KB queued"]) assert.ok(text.includes(fact), fact);
  assert.match(html, /class="streamGroup" data-holder="page-a-1111" data-tone="warning"/);
  assert.equal((html.match(/class="streamRecord" data-tone="warning"/g) ?? []).length, 2, "healthy streams cannot hide anomalous peers");
  // No duplicate normal capsule plus a second hidden record.
  assert.doesNotMatch(html, /<details|<summary/);
});

test("same-holder equal sources appear once, but each connection has its own times", () => {
  const detail = reply().session;
  const stream = detail.eventStreams[0];
  detail.eventStreams = [stream, { ...stream, openedAt: SERVER - MINUTE, connectedAt: SERVER - MINUTE }];
  const text = visibleText(render({ detail }));
  assert.equal(text.split("Chrome · macOS").length - 1, 1);
  assert.equal(text.split("127.0.0.1").length - 1, 1);
  assert.match(text, /SSE ×2/);
  assert.match(text, /#1 open \/ connected 5m 10s ago write 13s ago #2 open \/ connected 1m 10s ago write 13s ago/);
});

test("subagents are aligned task rows with all run/notification facts, optionally family-owned", () => {
  const detail = reply().session;
  Object.assign(detail.subagents.runs[0], { resumed: true, abortRequested: true, mcpWaiting: true });
  detail.subagents.runs.push({ ...detail.subagents.runs[0], sessionId: "notes-1", parentSessionId: "sub-xyz-789", status: "failed", profile: "auditor", background: false });
  detail.subagents.notifications = [{ sessionId: "notes-1", parentSessionId: "sub-xyz-789", since: SERVER - MINUTE }];
  const html = render({ detail }), text = visibleText(html);
  for (const value of ["explore the repo", "Running", "explore", "background", "resumed", "4m 10s ago", "Parent: Current chat", "abort requested", "waiting for MCP", "Weekly plan", "auditor", "Parent: explore the repo", "notifying explore the repo", "1m 10s ago"]) assert.ok(text.includes(value), value);
  assert.equal((html.match(/class="runRow"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="tag"[^>]*aria-label="explore the repo/);
  const familyOwned = render({ detail, showSubagents: false });
  assert.doesNotMatch(familyOwned, /class="runRow"|notifying|abort requested|data-kind="subagents"/);
  assert.match(familyOwned, /SSE ×1/);
});

test("all wrapper, process and provider facts still render, including empty/unknown cases", () => {
  const text = visibleText(render());
  for (const value of ["Started 6m 10s ago", "Last event agent_end", "Last command prompt", "Event listeners: 1", "Created 6m 10s ago", "Extensions bound", "Process history", "started 2×", "first 30m 10s ago", "last 6m 10s ago", "closed 7m 10s ago", "Event streams", "Liveness providers", "keepalive-ext", "active · by file", "Subagents", "a run is unsettled"]) assert.ok(text.includes(value), value);
  const detail = reply().session;
  detail.lifecycle = null; detail.providers = []; detail.eventStreams = []; detail.mcp.servers = [];
  let empty = render({ detail });
  assert.match(empty, /data-kind="providers"[^]*?class="empty">none/);
  assert.match(empty, /data-kind="history"[^]*?class="empty">none/);
  detail.providers = null;
  empty = visibleText(render({ detail }));
  assert.match(empty, /cannot be listed/);
  detail.providers = [{ name: "bad-provider", active: "error", byFile: true }, { name: "off", active: false, byFile: false }];
  detail.wrapper.state = "closing"; detail.wrapper.closingAt = SERVER; detail.wrapper.extensions = "failed";
  const abnormal = visibleText(render({ detail }));
  assert.match(abnormal, /bad-provider error · by file/);
  assert.match(abnormal, /off inactive/);
  assert.match(abnormal, /closing 10s ago/);
  assert.match(abnormal, /Extensions failed/);
  detail.wrapper.stale = true;
  assert.doesNotMatch(render({ detail }), /data-kind="timing"/);
  detail.wrapper = null; detail.starting = true;
  assert.match(visibleText(render({ detail })), /starting/);
});

test("execution and waiting fields are not lost in the compact metadata", () => {
  const detail = reply().session;
  Object.assign(detail.wrapper.run, { running: true, streaming: true, promptRunning: true, pendingPrompts: 2, bashRunning: true, compacting: true, retrying: true, queuedMessages: 3, waitingForMcp: true, runningTools: 4, mutatingCommands: 5, replacement: "fork" });
  Object.assign(detail.wrapper, { awaitingInput: true, pendingUiRequests: 2, customUis: 3, chatOnly: true, subagent: true });
  const text = visibleText(render({ detail }));
  for (const key of ["debug.run.streaming", "debug.run.prompt", "debug.run.bash", "debug.run.compacting", "debug.run.retrying", "debug.run.waitingForMcp", "debug.overlay.awaiting", "debug.server.chatOnly", "debug.server.subagent"]) assert.ok(text.includes(translator("en")(key)), key);
  for (const [key, params] of [["debug.run.pending", { count: 2 }], ["debug.run.queued", { count: 3 }], ["debug.run.tools", { count: 4 }], ["debug.run.mutating", { count: 5 }], ["debug.run.replacement", { kind: "fork" }], ["debug.server.uiRequests", { count: 2 }], ["debug.server.customUis", { count: 3 }]]) assert.ok(text.includes(translator("en")(key, params)), key);
});

test("local words exist in all locales and do not shadow page/global dictionaries", () => {
  const keys = Object.keys(DEBUG_DETAIL_MESSAGES.en).sort();
  const names = message => [...message.matchAll(/\{([\w.-]+)\}/g)].map(match => match[1]).sort();
  for (const locale of Object.keys(locales)) {
    assert.deepEqual(Object.keys(DEBUG_DETAIL_MESSAGES[locale]).sort(), keys);
    for (const key of keys) {
      const value = DEBUG_DETAIL_MESSAGES[locale][key];
      assert.ok(value.trim());
      assert.deepEqual(names(value), names(DEBUG_DETAIL_MESSAGES.en[key]));
      assert.equal(locales[locale].messages[key], undefined);
      assert.equal(DEBUG_PAGE_MESSAGES[locale][key], undefined);
    }
    assert.doesNotMatch(visibleText(render({ locale })), /detail\.[\w]+/);
  }
});
