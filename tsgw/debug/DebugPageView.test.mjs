import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
import { SECOND, MINUTE, LOCAL, SERVER, summary, reply, catalog, server } from "./fixtures.mjs";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DebugPageView } = await jiti.import("./DebugPageView.tsx");
const { EMPTY_DEBUG_SERVER_READING } = await jiti.import("@/components/debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const viewSource = await readFile(new URL("./DebugPageView.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("./DebugSessionDetail.tsx", import.meta.url), "utf8");
const t = (key, params) => {
  assert.equal(typeof enLocale.messages[key], "string", `missing translation ${key}`);
  return interpolateMessage(enLocale.messages[key], params);
};
const decode = html => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rowNames = html => [...html.matchAll(/<span class="nameText">([^<]*)<\/span>/g)].map(match => match[1]);
const titles = html => [...html.matchAll(/ title="([^"]*)"/g)].map(match => match[1]);
function render(props = {}) {
  return decode(renderToStaticMarkup(React.createElement(DebugPageView, {
    server: server(), now: LOCAL, hidden: false, sessions: catalog, catalogError: false,
    selectedSessionId: null, onToggleSession() {}, onCopy() {}, copied: false, t, locale: "en", ...props,
  })));
}

test("task dashboard retains server totals, pages, session families and countdowns", () => {
  const html = render();
  const text = visibleText(html);
  assert.match(html, /<h1 class="heading">Task control<\/h1>/);
  assert.match(text, /Uptime 2h 00m/);
  assert.match(text, /2 alive · 0 closing · 1 starting/);
  assert.match(text, /SSE 4/);
  assert.match(text, /File watches 1/);
  assert.match(text, /Terminals 1/);
  assert.match(text, /Connected pages · 2/);
  for (const value of ["Chrome · macOS", "127.0.0.1", "page-a-1", "unknown browser", "Agent 1 · Terminal 1 · File watch 0", "Terminal streams", "Detached shells", "Exited shells", "Next cleanup"]) assert.ok(text.includes(value), value);
  assert.deepEqual(rowNames(html), ["Weekly plan", "Current chat", "explore the repo"]);
  assert.doesNotMatch(html, /aria-expanded="true"|class="detail"/);
  assert.match(text, /Provider 1/);
  assert.match(text, /8m 20s/);
  assert.match(text, /Checks cover this snapshot and the expanded session/);
});

test("one expanded row, matching aria-controls, no stale detail from another session", () => {
  const html = render({ selectedSessionId: "notes-1" });
  assert.equal(html.split('aria-expanded="true"').length - 1, 1);
  assert.equal(html.split('aria-expanded="false"').length - 1, 2);
  assert.match(html, /aria-controls="debug-session-notes-1"/);
  assert.doesNotMatch(html, /class="detail"/);
  assert.match(html, /id="debug-session-notes-1">Waiting for the server's answer/);
  assert.doesNotMatch(html, /aria-controls="debug-session-s1"/);
  const open = render({ selectedSessionId: "s1" });
  assert.equal(open.split('class="detail"').length - 1, 1);
  assert.match(open, /id="debug-session-s1" role="group" aria-label="Current chat"/);
});

test("details retain all blocks and add visible idle, extension and listener information", () => {
  const text = visibleText(render({ selectedSessionId: "s1" }));
  for (const value of ["Started 6m 10s ago", "Last event agent_end", "Process history", "Event streams", "Liveness providers", "Subagents", "MCP", "started 2×", "first 30m 10s ago", "last 6m 10s ago", "closed 7m 10s ago", "connected 5m 10s ago", "keepalive-ext", "active · by file", "a run is unsettled", "explore", "background", "files", "jira", "Did not connect", "1 problems", "idle release in 1m 50s", "Extensions bound", "Event listeners: 1", "Last idle reset 1m 40s ago", "Next idle check in 8m 20s", "Request opened 5m 10s ago", "Host active: yes · run active: no"]) assert.ok(text.includes(value), value);
});

test("binding, failed and disposed states are visible without hover", () => {
  const answer = reply();
  answer.session.wrapper.extensions = "binding";
  answer.session.mcp.disposed = true;
  answer.session.mcp.servers[0].released = true;
  let text = visibleText(render({ server: server({ reply: answer }), selectedSessionId: "s1" }));
  assert.match(text, /Extensions binding/);
  assert.match(text, /disposed/);
  assert.match(text, /released/);
  answer.session.wrapper.extensions = "failed";
  text = visibleText(render({ server: server({ reply: answer }), selectedSessionId: "s1" }));
  assert.match(text, /Extension binding failed/);
});

test("failed polls keep the last answer with its age and consecutive failures", () => {
  const html = render({ server: server({ receivedAt: LOCAL - 70 * SECOND, failure: { kind: "timeout", status: null, at: LOCAL - SECOND }, consecutiveFailures: 3 }) });
  assert.match(visibleText(html), /Not the latest answer: .* Showing the answer from 1m 10s ago/);
  assert.match(visibleText(html), /3 failures in a row/);
  assert.match(visibleText(html), /Snapshot stale/);
  assert.match(visibleText(html), /Connected pages · 2/);
  assert.deepEqual(rowNames(html), ["Weekly plan", "Current chat", "explore the repo"]);
});

test("initial and failed-first observations never assert runtime zero or task completion", () => {
  const html = render({ server: EMPTY_DEBUG_SERVER_READING });
  assert.match(visibleText(html), /Waiting for data/);
  assert.match(visibleText(html), /Catalog · runtime state unknown/);
  assert.doesNotMatch(visibleText(html), /Snapshot current/);
  const failed = render({ server: { ...EMPTY_DEBUG_SERVER_READING, failure: { kind: "network", status: null, at: LOCAL - SECOND }, requests: 1, failures: 1, consecutiveFailures: 1 } });
  assert.match(visibleText(failed), /The request failed \(network or server down\)/);
  assert.doesNotMatch(failed, /Showing the answer from/);
});

test("unloaded catalog is unknown, successful empty catalog is zero, later failures keep the known count", () => {
  const count = html => html.match(/Catalog only<\/span><strong class="metricNumber">([^<]+)/)?.[1];
  assert.equal(count(render({ catalogReceivedAt: null, catalogError: true })), "—");
  assert.equal(count(render({ catalogReceivedAt: LOCAL, sessions: [] })), "0");
  assert.equal(count(render({ catalogReceivedAt: LOCAL, catalogError: true, sessions: [...catalog, { ...catalog[0], id: "saved" }] })), "1");
});

test("selected session retains its collapse control before detail arrives even when no longer listed", () => {
  const html = render({ server: server({ reply: { ...reply(), sessions: [], session: null } }), selectedSessionId: "absent", sessions: [] });
  assert.match(html, /class="row rowOpen residual" aria-expanded="true" aria-controls="debug-session-absent"/);
  assert.match(html, /id="debug-session-absent">Waiting for the server's answer/);
});

test("hidden state and catalog failures preserve observed data and identify the problem", () => {
  const text = visibleText(render({ hidden: true, catalogError: true }));
  assert.match(text, /Paused while the page is hidden/);
  assert.match(text, /session list could not be read/);
  assert.match(text, /Connected pages · 2/);
});

test("residual selected detail stays visible and closable above the groups", () => {
  const answer = reply();
  answer.sessions = answer.sessions.filter(entry => entry.sessionId !== "s1");
  const html = render({ server: server({ reply: answer }), selectedSessionId: "s1", sessions: catalog.filter(entry => entry.id !== "s1") });
  assert.match(html, /class="row rowOpen residual" aria-expanded="true" aria-controls="debug-session-s1"/);
  assert.match(visibleText(html), /The last answer still holds this session, but its list has no row/);
  assert.equal(html.split('class="detail"').length - 1, 1);
  assert.ok(html.indexOf('class="row rowOpen residual"') < html.indexOf('class="group"'));
});

test("selection does not reorder families; server-clock countdown retains forced-Stop warning", () => {
  assert.deepEqual(rowNames(render()), rowNames(render({ selectedSessionId: "s1" })));
  const answer = reply();
  answer.sessions = [summary("s1", { forcedByStop: true, nextIdleCheckAt: SERVER + 4 * MINUTE })];
  const html = render({ server: server({ reply: answer }) });
  assert.ok(titles(html).some(title => title.startsWith("Reap countdown 3m 50s · timeout 10m 00s · Stopped:")));
  assert.match(html, /aria-label="closes in 3m 50s \(after Stop\)"/);
  assert.match(visibleText(render({ now: LOCAL + MINUTE })), /7m 20s/);
});

test("catalog-only sessions are visible but never claimed completed; real parent and assignment are shown", () => {
  const child = { ...catalog[1], id: "old-child", name: "Historical subagent", relation: { ...catalog[1].relation, status: "completed" } };
  const answer = reply();
  answer.session.sessionId = child.id;
  answer.session.wrapper = null;
  const html = render({ sessions: [...catalog, child], selectedSessionId: child.id, server: server({ reply: answer }) });
  const text = visibleText(html);
  assert.match(text, /Catalog · runtime state unknown/);
  assert.match(text, /not a task completion record/);
  assert.match(text, /Parent: Current chat/);
  assert.match(text, /Assignment: Inspect source/);
  assert.match(text, /complete timeline of ordinary execution rounds is not/);
  assert.match(text, /existing APIs do not expose the global active wakeup queue/);
});

test("observer measurements are labeled, measured and not confused with other chat pages", () => {
  const html = render({ telemetry: { samples: [{ at: LOCAL - 1000, ms: 21 }, { at: LOCAL, ms: 42 }], inFlightSince: LOCAL - 500, protocol: "h2" } });
  const text = visibleText(html);
  assert.match(text, /Observer telemetry/);
  assert.match(text, /not another chat page's network/);
  assert.match(text, /Last round trip 42 ms/);
  assert.match(text, /Request in flight 500 ms/);
  assert.match(text, /HTTP protocol h2/);
  assert.match(html, /<polyline points="8,29 272,10"/);
});

test("view is read-only and timer-free; controls are native and SVG is decorative", () => {
  for (const source of [viewSource, detailSource]) {
    assert.doesNotMatch(source, /fetch\(|EventSource|\/lease|useAgentSession|XMLHttpRequest|setInterval|setTimeout/);
  }
  const html = render({ selectedSessionId: "s1" });
  assert.match(html, /<button type="button" class="row rowOpen"/);
  assert.doesNotMatch(html, /role="button"|tabindex="0"/);
  assert.match(html, /<svg[^>]+aria-hidden="true"/);
  assert.match(html, /type="search"/);
});
