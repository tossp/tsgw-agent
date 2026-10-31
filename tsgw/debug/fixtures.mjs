export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const LOCAL = 50_000;
export const SERVER = 9_000_000;

export function summary(sessionId, extra = {}) {
  return { sessionId, state: "alive", running: false, awaitingInput: false, subagent: false, eventStreams: 0, providers: 0, nextIdleCheckAt: null, forcedByStop: false, starts: 1, ...extra };
}

export function wrapper(extra = {}) {
  return {
    sessionId: "s1", state: "alive", stale: false, subagent: false, chatOnly: false,
    createdAt: SERVER - 6 * MINUTE, startedAt: SERVER - 6 * MINUTE, closingAt: null, extensions: "bound",
    run: { running: false, streaming: false, promptRunning: false, pendingPrompts: 0, bashRunning: false, compacting: false, retrying: false, queuedMessages: 0, waitingForMcp: false, runningTools: 0, mutatingCommands: 0, replacement: null },
    idle: { timeoutMs: 10 * MINUTE, nextCheckAt: SERVER + 8 * MINUTE + 30 * SECOND, lastResetAt: SERVER - 90 * SECOND, forcedByStop: false },
    awaitingInput: false, pendingUiRequests: 0, customUis: 0, eventListeners: 1,
    lastEvent: { type: "agent_end", at: SERVER - 90 * SECOND }, lastCommand: { type: "prompt", at: SERVER - 2 * MINUTE },
    ...extra,
  };
}

export function reply() {
  return {
    now: SERVER,
    server: {
      startedAt: SERVER - 120 * MINUTE, idleTimeoutMs: 10 * MINUTE, heartbeatMs: 15 * SECOND,
      wrappers: { alive: 2, closing: 0, starting: 1 }, eventStreams: { total: 2 }, sseTotal: 4,
      pages: [
        { holder: "page-a-1111", address: "127.0.0.1", client: "Chrome · macOS", agent: 1, terminal: 1, fileWatch: 0 },
        { holder: null, address: null, client: null, agent: 1, terminal: 0, fileWatch: 1 },
      ],
      fileWatches: 1, terminals: { count: 1, listeners: 1, detached: 0, exited: 0, nextCleanupAt: SERVER + 5 * MINUTE },
    },
    sessions: [
      summary("s1", { eventStreams: 1, providers: 1, nextIdleCheckAt: SERVER + 8 * MINUTE + 30 * SECOND, starts: 2 }),
      summary("sub-xyz-789", { subagent: true, running: true, eventStreams: 1 }),
      summary("notes-1", { awaitingInput: true, state: "closing" }),
    ],
    session: {
      sessionId: "s1", wrapper: wrapper(), lifecycle: { starts: 2, firstStartedAt: SERVER - 30 * MINUTE, lastStartedAt: SERVER - 6 * MINUTE, lastClosedAt: SERVER - 7 * MINUTE },
      starting: false, providers: [{ name: "keepalive-ext", active: true, byFile: true }],
      eventStreams: [{ holder: "page-a-1111", address: "127.0.0.1", client: "Chrome · macOS", openedAt: SERVER - 5 * MINUTE, connectedAt: SERVER - 5 * MINUTE, lastWriteAt: SERVER - 3 * SECOND, droppedEvents: 0, queuedBytes: 0 }],
      subagents: {
        active: true,
        runs: [{ sessionId: "sub-xyz-789", parentSessionId: "s1", status: "running", profile: "explore", background: true, resumed: false, dispatchedAt: SERVER - 4 * MINUTE, abortRequested: false, mcpWaiting: false }],
        notifications: [],
      },
      mcp: { active: true, disposed: false, runActive: false, idleMs: 5 * MINUTE, idleReleaseAt: SERVER + 2 * MINUTE, servers: [
        { name: "files", scope: "global", state: "connected", hasError: false, released: false },
        { name: "jira", scope: "project", state: "failed", hasError: true, released: false },
      ], problems: 1 },
    },
  };
}

export const catalog = [
  { id: "s1", name: "Current chat", path: "", cwd: "/work/app", projectRoot: "/work/app", created: "", modified: "2026-10-01T00:00:00Z", messageCount: 2, firstMessage: "" },
  { id: "sub-xyz-789", name: "", path: "", cwd: "/work/app", projectRoot: "/work/app", created: "", modified: "2026-10-02T00:00:00Z", messageCount: 1, firstMessage: "explore the repo", relation: { kind: "subagent", parentSessionId: "s1", profile: "explore", description: "Inspect source", status: "running" } },
  { id: "notes-1", name: "Weekly plan", path: "", cwd: "/work/notes", projectRoot: "/work/notes", created: "", modified: "2026-10-09T00:00:00Z", messageCount: 3, firstMessage: "" },
];

export function server(extra = {}) {
  return { sessionId: null, reply: reply(), receivedAt: LOCAL - 10 * SECOND, roundTripMs: 42, failure: null, requests: 3, failures: 0, consecutiveFailures: 0, ...extra };
}
