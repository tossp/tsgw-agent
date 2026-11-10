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
const { DebugSessionDetailView } = await jiti.import("./DebugSessionDetail.tsx");
const { dashboardRole } = await jiti.import("./dashboard-state.ts");
const { debugServerClock, EMPTY_DEBUG_SERVER_READING } = await jiti.import("@/components/debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const t = (key, params) => {
  assert.equal(typeof enLocale.messages[key], "string", `missing translation ${key}`);
  return interpolateMessage(enLocale.messages[key], params);
};
const decode = html => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const resource = (html, id) => html.match(new RegExp(`<article[^>]+data-session-id="${id}"[^>]*>([\\s\\S]*?)<\\/article>`))?.[1] ?? "";
const ids = html => [...html.matchAll(/data-session-id="([^"]+)"/g)].map(match => match[1]);
function render(props = {}) {
  const snapshot = props.server ?? server();
  const initialResources = snapshot.reply?.session ? { [snapshot.reply.session.sessionId]: snapshot } : {};
  return decode(renderToStaticMarkup(React.createElement(DebugPageView, {
    server: snapshot, now: LOCAL, hidden: false, sessions: catalog,
    resources: initialResources, onCopy() {}, copied: false, t, locale: "en", ...props,
  })));
}
function reading(id, age = 10 * SECOND) {
  const answer = reply(); answer.session.sessionId = id; answer.session.wrapper.sessionId = id;
  answer.session.subagents = { active: false, runs: [], notifications: [] };
  answer.session.mcp.servers = [{ name: `mcp-${id}`, scope: "global", state: "connected", released: false, hasError: false }];
  return server({ sessionId: id, reply: answer, receivedAt: LOCAL - age });
}

test("running ordinary and subagent sessions retain text beside a decorative activity ring", () => {
  const answer = reply();
  answer.sessions = [summary("s1", { running: true }), summary("sub-xyz-789", { subagent: true, running: true })];
  const html = render({ server: server({ reply: answer }) });
  for (const id of ["s1", "sub-xyz-789"]) {
    const row = resource(html, id);
    assert.match(row, /<span class="status" data-state="running"><svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.match(row, /class="runningRing"/);
    assert.match(visibleText(row), /running/i);
  }
});

test("awaiting, idle, closing and nonresident context never show an activity ring", () => {
  const answer = reply();
  answer.sessions = [
    summary("sub-xyz-789", { subagent: true, running: true }),
    summary("notes-1", { running: true, awaitingInput: true }),
    summary("idle-id"), summary("closing-id", { state: "closing" }),
  ];
  const html = render({ server: server({ reply: answer }) });
  for (const id of ["s1", "notes-1", "idle-id", "closing-id"]) assert.doesNotMatch(resource(html, id), /class="runningRing"/);
  for (const [id, state] of [["notes-1", "awaiting"], ["idle-id", "alive"], ["closing-id", "closing"]]) assert.match(resource(html, id), new RegExp(`data-state="${state}"`));
  assert.match(visibleText(resource(html, "s1")), /Parent context · not resident/);
});

test("runtime resources replace the task landscape; observation panels precede the wide resource area", () => {
  const html = render(), text = visibleText(html);
  assert.match(html, /<h1 class="heading">Task control<\/h1>/);
  assert.doesNotMatch(html, /aria-label="Task landscape"|type="search"|Saved directory|Clear focus|Focused session/);
  assert.ok(html.indexOf("<aside") < html.indexOf('aria-label="Session resources"'), "DOM order follows left observation, right resources");
  assert.deepEqual(ids(html).sort(), ["notes-1", "s1", "sub-xyz-789"].sort());
  for (const value of ["Uptime 2h 00m", "2 alive · 0 closing · 1 starting", "SSE 4", "File watches 1", "Terminals 1", "Connected pages · 2", "Chrome · macOS", "127.0.0.1", "page-a-1", "unknown browser", "Agent 1 · Terminal 1 · File watch 0", "Terminal streams", "Detached shells", "Exited shells", "Next cleanup", "8m 20s"]) assert.ok(text.includes(value), value);
});

test("200 historical entries do not replace or expand the runtime resource surface", () => {
  const history = Array.from({ length: 200 }, (_, index) => ({ ...catalog[0], id: `saved-${index}`, name: `Saved record ${index}` }));
  const html = render({ sessions: [...catalog, ...history] });
  assert.deepEqual(ids(html).sort(), ["notes-1", "s1", "sub-xyz-789"].sort());
  assert.doesNotMatch(html, /Saved record|data-session-id="saved-|Catalog · runtime state unknown/);
});

test("multiple resident sessions show their own resources without selection", () => {
  const resources = { s1: reading("s1"), "notes-1": reading("notes-1", 20 * SECOND), "sub-xyz-789": reading("sub-xyz-789") };
  const html = render({ resources });
  assert.equal([...html.matchAll(/class="detail"/g)].length, 3);
  assert.match(visibleText(resource(html, "s1")), /mcp-s1/);
  assert.doesNotMatch(visibleText(resource(html, "s1")), /mcp-notes-1/);
  assert.match(visibleText(resource(html, "notes-1")), /mcp-notes-1/);
  assert.match(visibleText(resource(html, "s1")), /Sample 10s ago/);
  assert.match(visibleText(resource(html, "notes-1")), /Sample 20s ago/);
});

test("each detail uses its own server clock; missing details are not copied across rows", () => {
  const html = render({ resources: { s1: reading("s1"), "notes-1": reading("notes-1", MINUTE) } });
  assert.match(visibleText(resource(html, "s1")), /8m 20s/);
  assert.match(visibleText(resource(html, "notes-1")), /7m 30s/);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /Resources not sampled yet/);
  assert.doesNotMatch(resource(html, "sub-xyz-789"), /mcp-s1|mcp-notes-1/);
  assert.match(visibleText(html), /Resources sampled 2\/3/);
});

test("unsampled residents keep their own summary countdown and forced Stop without borrowing detail", () => {
  const answer = reply();
  answer.sessions = [summary("s1", { nextIdleCheckAt: SERVER + 4 * MINUTE, forcedByStop: true }), summary("notes-1")];
  const html = render({ server: server({ reply: answer }), resources: {} });
  assert.match(visibleText(resource(html, "s1")), /3m 50s/);
  assert.match(visibleText(resource(html, "s1")), /Stop/);
  assert.match(resource(html, "s1"), /class="meterFill"/);
  assert.doesNotMatch(visibleText(resource(html, "notes-1")), /3m 50s/);
  assert.equal([...resource(html, "s1").matchAll(/data-kind="timing"/g)].length, 1);
});

test("sampled detail replaces the summary countdown rather than duplicating it", () => {
  const answer = reply(); answer.sessions = [summary("s1", { nextIdleCheckAt: SERVER + 4 * MINUTE })];
  const html = render({ server: server({ reply: answer }), resources: { s1: reading("s1") } });
  assert.match(visibleText(resource(html, "s1")), /8m 20s/);
  assert.doesNotMatch(visibleText(resource(html, "s1")), /3m 50s/);
  assert.equal([...resource(html, "s1").matchAll(/data-kind="timing"/g)].length, 1);
});

test("model, provider, exact thinking level and age belong to each resident, never defaulted", () => {
  const liveModels = {
    s1: { model: { provider: "p", id: "alpha" }, thinkingLevel: "max", running: true, receivedAt: LOCAL - SECOND, failed: false },
    "notes-1": { model: { provider: "q", id: "beta" }, thinkingLevel: "off", running: true, receivedAt: LOCAL - 5 * SECOND, failed: true },
  };
  const html = render({ liveModels });
  assert.match(visibleText(resource(html, "s1")), /Model p\/alpha Thinking max Model 1s ago/);
  assert.doesNotMatch(resource(html, "s1"), /beta|Thinking off/);
  assert.match(visibleText(resource(html, "notes-1")), /Model q\/beta Thinking off/);
  assert.match(visibleText(resource(html, "notes-1")), /Model read failed/);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /Model Not read Thinking Not read/);
});

test("detail facts remain visible without the three redundant idle messages or boundary prose", () => {
  const html = render(), text = visibleText(html);
  for (const value of ["Started 6m 10s ago", "Last event agent_end", "Process history", "Event streams", "Liveness providers", "MCP", "started 2×", "first 30m 10s ago", "last 6m 10s ago", "closed 7m 10s ago", "connected 5m 10s ago", "keepalive-ext", "active · by file", "a run is unsettled", "explore", "background", "files", "jira", "Did not connect", "1 problems", "idle release in 1m 50s", "Extensions bound", "Event listeners: 1", "Host Execution"]) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /Last idle reset|Next idle check in|Idle timeout|Observability limits|existing APIs do not expose the global active wakeup/);
  assert.match(text, /Reap check/);
  assert.doesNotMatch(html, /data-kind="subagents"/);
});

test("resident subagents retain profile, assignment, direct parent and explicitly recorded directory status", () => {
  const html = render();
  assert.match(resource(html, "sub-xyz-789"), /class="profile">explore/);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /Inspect source/);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /Parent: Current chat/);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /Catalog subagent status: running/i);
  assert.match(visibleText(resource(html, "sub-xyz-789")), /background/);
  const info = catalog.map(item => item.id === "sub-xyz-789" ? { ...item, relation: { ...item.relation, status: "failed" } } : item);
  assert.match(visibleText(resource(render({ sessions: info }), "sub-xyz-789")), /Catalog subagent status: failed/i);
});

test("binding, failed, disposed, released and resource read failures stay visible", () => {
  const answer = reply(); answer.session.wrapper.extensions = "binding"; answer.session.mcp.disposed = true; answer.session.mcp.servers[0].released = true;
  let text = visibleText(render({ server: server({ reply: answer }) }));
  assert.match(text, /Extensions binding/); assert.match(text, /disposed/); assert.match(text, /released/);
  answer.session.wrapper.extensions = "failed";
  text = visibleText(render({ server: server({ reply: answer }) })); assert.match(text, /Extension binding failed/);
  const failed = reading("notes-1"); failed.failure = { kind: "timeout", status: null, at: LOCAL };
  const html = render({ resources: { "notes-1": failed } });
  assert.match(visibleText(resource(html, "notes-1")), /Resource read failed/);
  assert.doesNotMatch(visibleText(resource(html, "s1")), /Resource read failed/);
  const firstFailure = render({ resources: { "notes-1": { ...failed, reply: null, receivedAt: null } } });
  assert.match(visibleText(resource(firstFailure, "notes-1")), /Resource read failed/);
  assert.doesNotMatch(visibleText(resource(firstFailure, "notes-1")), /last sample|Sample .*ago/);
});

test("global failures preserve data, original age and consecutive failure counts", () => {
  const html = render({ server: server({ receivedAt: LOCAL - 70 * SECOND, failure: { kind: "timeout", status: null, at: LOCAL - SECOND }, consecutiveFailures: 3 }) });
  assert.match(visibleText(html), /Not the latest answer: .* Showing the answer from 1m 10s ago/);
  assert.match(visibleText(html), /3 failures in a row/);
  assert.match(visibleText(html), /Snapshot stale/);
  assert.match(visibleText(html), /Connected pages · 2/);
  assert.deepEqual(ids(html).sort(), ["notes-1", "s1", "sub-xyz-789"].sort());
});

test("first observation failure never asserts runtime zero, task completion or a current snapshot", () => {
  const html = render({ server: EMPTY_DEBUG_SERVER_READING });
  assert.match(visibleText(html), /Waiting for data/);
  assert.deepEqual(ids(html), []);
  assert.equal([...html.matchAll(/class="metricNumber">—/g)].length, 6);
  assert.doesNotMatch(visibleText(html), /Snapshot current|Resources sampled 0\/0|No runtime sessions/i);
  assert.match(visibleText(html), /Resources sampled —\/—/);
  const failed = render({ server: { ...EMPTY_DEBUG_SERVER_READING, failure: { kind: "network", status: null, at: LOCAL - SECOND }, requests: 1, failures: 1, consecutiveFailures: 1 } });
  assert.match(visibleText(failed), /The request failed \(network or server down\)/);
  assert.doesNotMatch(failed, /Showing the answer from|Resources sampled 0\/0|No runtime sessions/i);
  assert.match(visibleText(failed), /Resources sampled —\/—/);
});

test("a successful empty snapshot may report known zero resources even with saved metadata", () => {
  const answer = reply(); answer.sessions = []; answer.session = null;
  const html = render({ server: server({ reply: answer }), resources: {} });
  assert.match(visibleText(html), /Resources sampled 0\/0/);
  assert.match(visibleText(html), /No runtime sessions/i);
  assert.doesNotMatch(visibleText(html), /Resources sampled —\/—|Resources not sampled yet/);
});

test("hidden pages and failed metadata retain resources and explain the current failure", () => {
  const telemetry = { samples: [], inFlightSince: null, protocol: null, catalog: { inFlightSince: null, nextCheckAt: LOCAL + SECOND, receivedAt: LOCAL - SECOND, roundTripMs: null, requests: 2, failures: 1, consecutiveFailures: 1, failed: true, samples: [] } };
  const text = visibleText(render({ hidden: true, telemetry }));
  assert.match(text, /Paused while the page is hidden/); assert.match(text, /session list could not be read/);
  assert.match(text, /Connected pages · 2/);
});

test("exited parents are context only: no old detail, model, pending sample or resource countdown", () => {
  const answer = reply(); answer.sessions = [summary("sub-xyz-789", { subagent: true, running: true, nextIdleCheckAt: SERVER + MINUTE })];
  const html = render({ server: server({ reply: answer }), resources: { s1: reading("s1") }, liveModels: { s1: { model: { provider: "old", id: "parent" }, thinkingLevel: "max", running: true, receivedAt: LOCAL, failed: false } } });
  assert.match(visibleText(html), /Parent context · not resident/);
  assert.match(visibleText(html), /Subagents executing 1/);
  assert.match(visibleText(html), /explore the repo/);
  assert.doesNotMatch(resource(html, "s1"), /class="detail"|mcp-s1|old\/parent|Resources not sampled|class="modelLine"/);
  assert.doesNotMatch(visibleText(html), /Weekly plan/);
});

test("exited ordinary sessions and purely historical subagents never acquire resource rows", () => {
  const historical = { ...catalog[1], id: "old-child", name: "Historical subagent", relation: { ...catalog[1].relation, status: "failed" } };
  const answer = reply(); answer.sessions = [];
  const html = render({ sessions: [...catalog, historical], server: server({ reply: answer }), resources: { "old-child": reading("old-child") } });
  assert.deepEqual(ids(html), []);
  assert.doesNotMatch(visibleText(html), /Historical subagent|Catalog subagent status: failed|Resources not sampled/);
});

test("observer retains real latency, slow/failure markers, next checks and visibility", () => {
  const telemetry = { samples: [{ at: LOCAL, ms: 20 }, { at: LOCAL + 1, ms: 0, failed: true }], inFlightSince: LOCAL - 2500, nextDebugCheckAt: LOCAL + SECOND, protocol: "h2",
    catalog: { inFlightSince: null, nextCheckAt: LOCAL + 20 * SECOND, receivedAt: LOCAL - SECOND, roundTripMs: 120, requests: 3, failures: 1, consecutiveFailures: 0, failed: false, samples: [{ at: LOCAL, ms: 120 }] } };
  const html = render({ telemetry });
  assert.match(visibleText(html), /Runtime snapshot Slow 2500 ms/);
  assert.match(visibleText(html), /Session directory Answered 120 ms Next poll check 20s/);
  assert.match(html, /height="23" rx="1" class="sampleFailed"/);
  assert.match(visibleText(html), /HTTP protocol h2/);
  const failed = render({ telemetry: { ...telemetry, inFlightSince: null }, server: server({ failure: { kind: "timeout", status: null, at: LOCAL } }) });
  assert.match(visibleText(failed), /Runtime snapshot Failed —/);
  assert.match(visibleText(render({ telemetry, hidden: true })), /Runtime snapshot Paused/);
});

test("all runtime roles and states remain; a fork is not relabeled as a child", () => {
  const answer = reply();
  answer.sessions.push(summary("fork-id", { running: true }), summary("orphan", { subagent: true }));
  const fork = { ...catalog[0], id: "fork-id", name: "Forked work", relation: { kind: "fork", originSessionId: "s1" } };
  const html = render({ server: server({ reply: answer }), sessions: [...catalog, fork] });
  assert.deepEqual(ids(html).sort(), ["notes-1", "s1", "sub-xyz-789", "fork-id", "orphan"].sort());
  assert.match(visibleText(resource(html, "fork-id")), /Main/);
  assert.match(visibleText(resource(html, "fork-id")), /Fork source: Current chat/);
  assert.match(visibleText(resource(html, "orphan")), /Subagent/);
  assert.match(visibleText(resource(html, "notes-1")), /awaiting input/i);
});

test("resources omitted or explicitly empty cannot repopulate a cache from the global snapshot", () => {
  const html = render({ resources: {} });
  assert.equal([...html.matchAll(/class="detail"/g)].length, 0);
  assert.doesNotMatch(html, /mcp-s1|name="files"/);
  const omitted = render({ resources: undefined });
  assert.equal([...omitted.matchAll(/class="detail"/g)].length, 0);
});

test("side chat resources, wrapper details and totals never present it as a subagent", () => {
  const side = { ...catalog[0], id: "side-1", name: "Side investigation", relation: { kind: "side", parentSessionId: "s1" } };
  const answer = reply();
  answer.sessions.push(summary(side.id, { subagent: true, running: true }));
  const sideReading = reading(side.id);
  sideReading.reply.session.wrapper.subagent = true;
  const childReading = reading("sub-xyz-789");
  childReading.reply.session.wrapper.subagent = true;
  const props = { sessions: [...catalog, side], server: server({ reply: answer }), resources: { [side.id]: sideReading, "sub-xyz-789": childReading } };
  const html = render(props), sideRow = resource(html, side.id), childRow = resource(html, "sub-xyz-789");
  assert.ok(sideRow);
  assert.match(sideRow, /class="role">Side chat/);
  assert.doesNotMatch(sideRow, /Subagent|class="child"|subsession/);
  assert.match(visibleText(sideRow), /Side chat from: Current chat/);
  assert.match(sideRow, /id="debug-session-side-1" role="group" aria-label="Side investigation"/);
  const wrapper = sideRow.slice(sideRow.indexOf('id="debug-session-side-1"'));
  assert.match(wrapper, />Side chat<\/span>/, "the wrapper suppression flag must use the catalog-corrected role");
  assert.doesNotMatch(wrapper, /subagent/i);
  assert.match(childRow, /class="child">Subagent/);
  assert.match(childRow.slice(childRow.indexOf('id="debug-session-sub-xyz-789"')), />subagent<\/span>/i);
  assert.match(visibleText(childRow), /Parent: Current chat/);
  assert.match(visibleText(html), /Runtime subagents 1 Subagents executing 1/);
  assert.match(visibleText(html), /Ordinary sessions 3 Main \/ side executing 1/);
  // Automatic resources replace the old residual-selection pane: exited side chats cannot
  // linger as details, models, or pending resources even when both caches still contain them.
  answer.sessions = answer.sessions.filter(entry => entry.sessionId !== side.id);
  const residual = render({ ...props, liveModels: { [side.id]: { model: { provider: "old", id: "side-model" }, thinkingLevel: "max", running: true, receivedAt: LOCAL, failed: false } } });
  assert.equal(resource(residual, side.id), "");
  assert.doesNotMatch(residual, /Side investigation|old\/side-model|debug-session-side-1/);
  assert.match(visibleText(residual), /Runtime subagents 1 Subagents executing 1/);
  assert.match(visibleText(residual), /Ordinary sessions 2 Main \/ side executing 0/);
});

test("side chats with non-resident or missing sources stay independent roots before sampling", () => {
  for (const parentSessionId of ["s1", "missing-parent"]) {
    const side = { ...catalog[0], id: "saved-side", name: "Saved side", relation: { kind: "side", parentSessionId } };
    const sessions = [...catalog, side];
    const answer = reply(); answer.sessions = [summary(side.id, { subagent: true, running: true })];
    const props = { sessions, server: server({ reply: answer }), resources: {} };
    const html = render(props), sideRow = resource(html, side.id);
    assert.deepEqual(ids(html), [side.id], "a side source creates no parent placeholder");
    assert.match(sideRow, /class="role">Side chat/);
    assert.doesNotMatch(sideRow, /Subagent|class="child"|Parent context|Parent:/);
    assert.match(visibleText(sideRow), /Resources not sampled yet/);
    assert.match(visibleText(sideRow), new RegExp(`Side chat from: ${parentSessionId === "s1" ? "Current chat" : "missing-"}`));
    assert.match(visibleText(html), /Ordinary sessions 1 Main \/ side executing 1/);
    assert.match(visibleText(html), /Runtime subagents 0 Subagents executing 0/);
    answer.sessions = [];
    const saved = render(props);
    assert.deepEqual(ids(saved), [], "saved side chats remain outside automatic runtime resources");
    assert.doesNotMatch(saved, /Saved side|Side chat from:|Resources not sampled yet/);
  }
});

test("side wrapper identity remains catalog-corrected without a summary and with family-owned subagents", () => {
  const detail = reading("side-1").reply.session;
  detail.wrapper.subagent = true;
  detail.subagents = reply().session.subagents;
  const info = { ...catalog[0], id: detail.sessionId, relation: { kind: "side", parentSessionId: "s1" } };
  const html = decode(renderToStaticMarkup(React.createElement(DebugSessionDetailView, {
    detail, role: dashboardRole(detail.wrapper, info), showSubagents: false,
    clock: debugServerClock(SERVER, LOCAL - SECOND, LOCAL), titleOf: () => null,
    t, locale: "en", id: "side-wrapper", name: "Side investigation",
  })));
  assert.match(html, />Side chat<\/span>/);
  assert.doesNotMatch(html, /subagent|data-kind="subagents"|class="runRow"/i);
  for (const value of ["SSE ×1", "Process history", "MCP", "Reap check"]) assert.ok(visibleText(html).includes(value), value);
});

test("rendered family cells are independent of project grouping and contain their own children", () => {
  const answer = reply();
  answer.sessions.push(summary("other", { running: true }));
  const other = { ...catalog[0], id: "other", name: "Parallel work" };
  const html = render({ server: server({ reply: answer }), sessions: [...catalog, other] });
  const cells = [...html.matchAll(/data-family-id="([^"]+)"/g)];
  assert.deepEqual(cells.map(match => match[1]).sort(), ["notes-1", "other", "s1"].sort());
  const root = cells.findIndex(match => match[1] === "s1");
  const family = html.slice(cells[root].index, cells[root + 1]?.index ?? html.length);
  assert.match(family, /data-session-id="s1"/);
  assert.match(family, /data-session-id="sub-xyz-789"/);
  assert.doesNotMatch(family, /data-session-id="other"|data-session-id="notes-1"/);
  assert.match(family, /<h3 id="family-s1">Current chat<\/h3>/);
  assert.match(family, /Executing 1/);
  assert.match(family, /2 resident/);
  assert.doesNotMatch(resource(html, "s1"), /<strong class="name">Current chat/);
});

test("family totals exclude the context root and keep awaiting input distinct from execution", () => {
  const answer = reply();
  answer.sessions = [summary("sub-xyz-789", { subagent: true, running: true, awaitingInput: true })];
  const html = render({ server: server({ reply: answer }), resources: {} });
  const start = html.indexOf('data-family-id="s1"');
  const header = html.slice(start, html.indexOf("</header>", start));
  assert.match(header, /Awaiting input 1/);
  assert.match(header, /1 resident/);
  assert.doesNotMatch(header, /Executing|2 resident/);
  assert.match(visibleText(resource(html, "s1")), /Parent context · not resident/);
  assert.doesNotMatch(resource(html, "s1"), /Resources not sampled|Model/);
});

test("read-only views own no timers, commands, event streams or historical activation controls", async () => {
  for (const name of ["DebugPageView.tsx", "DebugSessionDetail.tsx", "ResourceBoard.tsx"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.doesNotMatch(source, /fetch\(|EventSource|\/lease|useAgentSession|XMLHttpRequest|setInterval|setTimeout/);
  }
  const html = render();
  assert.match(html, /<button type="button" class="copy"/);
  assert.doesNotMatch(html, /role="button"|tabindex="0"|aria-controls="resource-|type="search"/);
  assert.match(html, /<svg[^>]+aria-hidden="true"/);
});
