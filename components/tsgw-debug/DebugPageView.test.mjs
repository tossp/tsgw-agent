import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

// A CSS module import is a class-name proxy here, as in ChatMinimap.test.mjs: the markup then holds
// the class names the stylesheet defines.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DebugPageView } = await jiti.import("./DebugPageView.tsx");
const { EMPTY_DEBUG_SERVER_READING } = await jiti.import("../debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const viewSource = await readFile(new URL("./DebugPageView.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("./DebugSessionDetail.tsx", import.meta.url), "utf8");

const h = React.createElement;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The panel's own words come from the app's English dictionary: a missing key fails here. */
const t = (key, params) => {
  assert.equal(typeof enLocale.messages[key], "string", `missing translation ${key}`);
  return interpolateMessage(enLocale.messages[key], params);
};

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** What a sighted reader sees: the text between tags. */
function visibleText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Every aria-label, in order. */
function ariaLabels(html) {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]);
}

/** Every title attribute, in order. */
function titles(html) {
  return [...html.matchAll(/ title="([^"]*)"/g)].map((match) => match[1]);
}

/** The names of the rows, in the order they are drawn. */
function rowNames(html) {
  return [...html.matchAll(/<span class="nameText">([^<]*)<\/span>/g)].map((match) => match[1]);
}

// The browser's clock is far from the server's: only the time since the answer counts.
const LOCAL = 50_000;
const SERVER = 9_000_000;

function summary(sessionId, extra = {}) {
  return {
    sessionId, state: "alive", running: false, awaitingInput: false, subagent: false,
    eventStreams: 0, providers: 0, nextIdleCheckAt: null, forcedByStop: false, starts: 1, ...extra,
  };
}

function wrapper(extra = {}) {
  return {
    sessionId: "s1", state: "alive", stale: false, subagent: false, chatOnly: false,
    createdAt: SERVER - 6 * MINUTE, startedAt: SERVER - 6 * MINUTE, closingAt: null, extensions: "bound",
    run: {
      running: false, streaming: false, promptRunning: false, pendingPrompts: 0, bashRunning: false,
      compacting: false, retrying: false, queuedMessages: 0, waitingForMcp: false, runningTools: 0,
      mutatingCommands: 0, replacement: null,
    },
    idle: { timeoutMs: 10 * MINUTE, nextCheckAt: SERVER + 8 * MINUTE + 30 * SECOND, lastResetAt: SERVER - 90 * SECOND, forcedByStop: false },
    awaitingInput: false, pendingUiRequests: 0, customUis: 0, eventListeners: 1,
    lastEvent: { type: "agent_end", at: SERVER - 90 * SECOND }, lastCommand: { type: "prompt", at: SERVER - 2 * MINUTE },
    ...extra,
  };
}

function reply() {
  return {
    now: SERVER,
    server: {
      startedAt: SERVER - 2 * 60 * MINUTE,
      idleTimeoutMs: 10 * MINUTE,
      heartbeatMs: 15 * SECOND,
      wrappers: { alive: 2, closing: 0, starting: 1 },
      eventStreams: { total: 2 },
      sseTotal: 4,
      pages: [
        { holder: "page-a-1111", address: "127.0.0.1", client: "Chrome · macOS", agent: 1, terminal: 1, fileWatch: 0 },
        { holder: null, address: null, client: null, agent: 1, terminal: 0, fileWatch: 1 },
      ],
      fileWatches: 1,
      terminals: { count: 1, listeners: 1, detached: 0, exited: 0, nextCleanupAt: SERVER + 5 * MINUTE },
    },
    sessions: [
      summary("s1", { eventStreams: 1, providers: 1, nextIdleCheckAt: SERVER + 8 * MINUTE + 30 * SECOND, starts: 2 }),
      summary("sub-xyz-789", { subagent: true, running: true, eventStreams: 1 }),
      summary("notes-1", { awaitingInput: true, state: "closing" }),
    ],
    session: {
      sessionId: "s1",
      wrapper: wrapper(),
      lifecycle: { starts: 2, firstStartedAt: SERVER - 30 * MINUTE, lastStartedAt: SERVER - 6 * MINUTE, lastClosedAt: SERVER - 7 * MINUTE },
      starting: false,
      providers: [{ name: "keepalive-ext", active: true, byFile: true }],
      eventStreams: [
        {
          holder: "page-a-1111", address: "127.0.0.1", client: "Chrome · macOS",
          openedAt: SERVER - 5 * MINUTE, connectedAt: SERVER - 5 * MINUTE, lastWriteAt: SERVER - 3 * SECOND,
          droppedEvents: 0, queuedBytes: 0,
        },
      ],
      subagents: {
        active: true,
        runs: [{ sessionId: "sub-xyz-789", parentSessionId: "s1", status: "running", profile: "explore", background: true, resumed: false, dispatchedAt: SERVER - 4 * MINUTE, abortRequested: false, mcpWaiting: false }],
        notifications: [],
      },
      mcp: {
        active: true, disposed: false, runActive: false, idleMs: 5 * MINUTE, idleReleaseAt: SERVER + 2 * MINUTE,
        servers: [
          { name: "files", scope: "global", state: "connected", hasError: false, released: false },
          { name: "jira", scope: "project", state: "failed", hasError: true, released: false },
        ],
        problems: 1,
      },
    },
  };
}

function server(extra = {}) {
  // Received 10 s (on the browser's clock) before the page was read.
  return { ...EMPTY_DEBUG_SERVER_READING, sessionId: null, reply: reply(), receivedAt: LOCAL - 10 * SECOND, roundTripMs: 42, requests: 3, ...extra };
}

const catalog = [
  { id: "s1", name: "Current chat", path: "", cwd: "/work/app", projectRoot: "/work/app", created: "", modified: "2026-10-01T00:00:00Z", messageCount: 2, firstMessage: "" },
  {
    id: "sub-xyz-789", name: "", path: "", cwd: "/work/app", projectRoot: "/work/app", created: "", modified: "2026-10-02T00:00:00Z", messageCount: 1,
    firstMessage: "explore the repo", relation: { kind: "subagent", parentSessionId: "s1", profile: "explore", description: "", status: "running" },
  },
  { id: "notes-1", name: "Weekly plan", path: "", cwd: "/work/notes", projectRoot: "/work/notes", created: "", modified: "2026-10-09T00:00:00Z", messageCount: 3, firstMessage: "" },
];

function render(props = {}) {
  return decode(renderToStaticMarkup(h(DebugPageView, {
    server: server(),
    now: LOCAL,
    hidden: false,
    sessions: catalog,
    catalogError: false,
    selectedSessionId: null,
    onToggleSession() {},
    onCopy() {},
    copied: false,
    t,
    locale: "en",
    ...props,
  })));
}

test("a quiet answer: totals, connected pages, groups and rows, and nothing open", () => {
  const html = render();
  assert.doesNotMatch(html, /class="notice/, "no notice while the poll answers");
  assert.match(html, /<h1 class="heading" title="Read-only: [^"]+">Debug<\/h1>/);
  assert.match(html, /<button type="button" class="copy" title="Copy this page's data as JSON">Copy JSON<\/button>/);
  const text = visibleText(html);
  // The server's totals, read on the server's clock: uptime, wrappers, SSE, watches, terminals.
  assert.ok(text.includes("Uptime 2h 00m"), text);
  assert.ok(text.includes("2 alive · 0 closing · 1 starting"));
  assert.ok(text.includes("SSE 4 total"));
  assert.ok(text.includes("File watches: 1"));
  assert.ok(text.includes("Terminals: 1"));
  // The pages holding streams: browser and system, address, page id, streams by kind.
  assert.ok(text.includes("Connected pages 2"));
  assert.ok(text.includes("Chrome · macOS"), text);
  assert.ok(text.includes("127.0.0.1"));
  assert.ok(text.includes("page-a-1"));
  assert.ok(text.includes("unknown browser"), "a page opened without a client still gets its row");
  assert.ok(titles(html).includes("no page id · Agent 1 · File watch 1 · SSE 2"), titles(html).join("\n"));
  // The groups are the sidebar's: projects, the family's subagent under its root, newest first
  // (the ordering never follows the open row: this page has no "current" session to put first).
  assert.deepEqual(rowNames(html), ["Weekly plan", "Current chat", "explore the repo"]);
  assert.ok(text.includes("app") && text.includes("notes"));
  // Nothing open: no details, no expanded row.
  assert.doesNotMatch(html, /aria-expanded="true"/);
  assert.doesNotMatch(html, /class="detail"/);
  // Two rows' badges and one reap countdown, which runs on the server's clock plus 10 s.
  assert.ok(text.includes("SSE 1"));
  assert.ok(text.includes("Provider 1"));
  assert.ok(text.includes("8m 20s"), text);
});

test("one row open at a time: aria-expanded, a matching aria-controls and one detail region", () => {
  const html = render({ selectedSessionId: "notes-1" });
  assert.equal(html.split('aria-expanded="true"').length - 1, 1);
  assert.equal(html.split('aria-expanded="false"').length - 1, 2);
  assert.match(html, /class="row rowOpen"[^>]*aria-expanded="true" aria-controls="debug-session-notes-1"/);
  // The answer is about s1, not the row opened: the details stay empty (the region keeps the id).
  assert.doesNotMatch(html, /class="detail"/);
  assert.match(html, /<p class="detailWaiting" id="debug-session-notes-1">Waiting for the server's answer about this session…<\/p>/);
  // A row that is not open controls nothing.
  assert.doesNotMatch(html, /aria-controls="debug-session-s1"/);

  const open = render({ selectedSessionId: "s1" });
  assert.equal(open.split('aria-expanded="true"').length - 1, 1);
  assert.equal(open.split('class="detail"').length - 1, 1);
  assert.match(open, /aria-controls="debug-session-s1"/);
  assert.match(open, /<div class="detail" id="debug-session-s1" role="group" aria-label="Current chat">/);
});

test("the open session's details: run, process history, streams, providers, subagents and MCP", () => {
  const html = render({ selectedSessionId: "s1" });
  const text = visibleText(html);
  // The wrapper's activity and its run's chips, then the blocks.
  assert.ok(text.includes("Started 6m 10s ago"));
  assert.ok(text.includes("Last event agent_end"));
  for (const title of ["Process history", "Event streams", "Liveness providers", "Subagents", "MCP"]) {
    assert.ok(text.includes(title), title);
  }
  assert.ok(text.includes("started 2×"));
  assert.ok(text.includes("first 30m 10s ago"));
  assert.ok(text.includes("last 6m 10s ago"));
  assert.ok(text.includes("closed 7m 10s ago"));
  // A stream says whose page holds it, its browser and address, and since when.
  assert.ok(text.includes("page-a-1"));
  assert.ok(text.includes("Chrome · macOS"));
  assert.ok(text.includes("connected 5m 10s ago"));
  // Providers are the detail's own: a summary never asks them, the detail does.
  assert.ok(text.includes("keepalive-ext"));
  assert.ok(text.includes("active · by file"));
  // The subagent its run keeps the session alive for.
  assert.ok(text.includes("a run is unsettled"));
  assert.ok(text.includes("explore"));
  assert.ok(text.includes("Running · background"));
  // MCP servers, their states in words, the problems and the idle release countdown.
  assert.ok(text.includes("files") && text.includes("jira"));
  assert.ok(text.includes("Did not connect"), "a state that is not connected is also in words");
  assert.ok(text.includes("1 problems"));
  assert.ok(text.includes("idle release in 1m 50s"), text);
});

test("a failed poll keeps the last answer but says so, how old it is and how many failed", () => {
  const html = render({
    server: server({ receivedAt: LOCAL - 70 * SECOND, failure: { kind: "timeout", status: null, at: LOCAL - SECOND }, consecutiveFailures: 3 }),
  });
  const notices = [...html.matchAll(/<li class="notice (notice_[a-z]+)">([^<]*)<\/li>/g)].map((match) => `${match[1]}: ${match[2]}`);
  assert.equal(notices.length, 2, notices.join("\n"));
  assert.match(notices[0], /^notice_warning: Not the latest answer: .* Showing the answer from 1m 10s ago\.$/);  assert.equal(notices[1], "notice_warning: 3 failures in a row");
  // The stale answer is still there, and it is named as stale, never shown as current.
  assert.ok(visibleText(html).includes("Connected pages 2"));
  assert.deepEqual(rowNames(html), ["Weekly plan", "Current chat", "explore the repo"]);
});

test("a first poll that failed: the reason alone, and the server's part waits", () => {
  const html = render({ server: EMPTY_DEBUG_SERVER_READING });
  assert.match(html, /<li class="notice notice_dim">Waiting for the server…<\/li>/);
  assert.equal(html.split('class="note">Waiting for the server…').length - 1, 2, "the overview and the sessions");
  const failed = render({
    server: { ...EMPTY_DEBUG_SERVER_READING, failure: { kind: "network", status: null, at: LOCAL - SECOND }, requests: 1, failures: 1, consecutiveFailures: 1 },
  });
  assert.match(failed, /<li class="notice notice_error">The request failed \(network or server down\)<\/li>/);
  assert.doesNotMatch(failed, /Showing the answer from/, "no answer to call stale");
  assert.doesNotMatch(failed, /class="row /);
});

test("a hidden page and an unreadable catalog are said in place, without hiding the answer", () => {
  const html = render({ hidden: true, catalogError: true });
  const notices = [...html.matchAll(/<li class="notice (notice_[a-z]+)">([^<]*)<\/li>/g)].map((match) => `${match[1]}: ${match[2]}`);
  assert.deepEqual(notices, [
    "notice_dim: Paused while the page is hidden",
    "notice_warning: The session list could not be read: sessions are shown by id.",
  ]);
  assert.ok(visibleText(html).includes("Connected pages 2"));
});

test("an open session the answer still has, though its list does not: a closable residual row", () => {
  const answer = reply();
  answer.sessions = answer.sessions.filter((entry) => entry.sessionId !== "s1");
  // Neither the answer's list nor the catalog holds the session: no row, not even a placeholder.
  const html = render({
    server: server({ reply: answer }),
    selectedSessionId: "s1",
    sessions: catalog.filter((entry) => entry.id !== "s1"),
  });
  assert.match(html, /class="row rowOpen residual" aria-expanded="true" aria-controls="debug-session-s1"/);
  assert.ok(visibleText(html).includes("The last answer still holds this session, but its list has no row for it."));
  assert.equal(html.split('class="detail"').length - 1, 1);
  // Above the groups: the row it lost is not looked for among them.
  assert.ok(html.indexOf('class="row rowOpen residual"') < html.indexOf('class="group"'));
});

test("opening a row never reorders the list, and the countdown to the reap check is to the second", () => {
  assert.deepEqual(rowNames(render()), rowNames(render({ selectedSessionId: "notes-1" })));
  assert.deepEqual(rowNames(render()), rowNames(render({ selectedSessionId: "s1" })));
  const html = render();
  // A Stop forced close says which: the square, and its tooltip's word.
  const forcedAnswer = reply();
  forcedAnswer.sessions = [summary("s1", { forcedByStop: true, nextIdleCheckAt: SERVER + 4 * MINUTE })];
  const forced = render({ server: server({ reply: forcedAnswer }) });
  assert.ok(titles(forced).some((title) => title.startsWith("Reap countdown 3m 50s · timeout 10m 00s · Stopped:")), titles(forced).join("\n"));
  assert.ok(ariaLabels(forced).includes("closes in 3m 50s (after Stop)"));
  // The browser's clock only counts time since the answer: the same answer a minute later reads less.
  const later = render({ now: LOCAL + MINUTE });
  assert.ok(visibleText(later).includes("7m 20s"), visibleText(later));
  assert.ok(!visibleText(html).includes("7m 20s"));
});

test("the view is pure: no request, no stream, no lease and no chat behind it", () => {
  for (const source of [viewSource, detailSource]) {
    assert.doesNotMatch(source, /fetch\(|EventSource|\/lease|useAgentSession|XMLHttpRequest/);
    assert.doesNotMatch(source, /setInterval|setTimeout/, "time comes from the page's now");
  }
  // Every row is a native button, and the details follow it.
  const html = render({ selectedSessionId: "s1" });
  assert.match(html, /<button type="button" class="row rowOpen"/);
  assert.doesNotMatch(html, /role="button"|tabindex="0"/);
});
