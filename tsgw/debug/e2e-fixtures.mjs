export const info = (id, name, project = "project", extra = {}) => ({
  id, name, path: "", cwd: `/test/${project}`, projectRoot: `/test/${project}`,
  created: "2026-10-30T00:00:00Z", modified: "2026-10-30T00:00:10Z", messageCount: 2, firstMessage: "Fixture session", ...extra,
});
export function fixtures() {
  return {
    failure: false, catalogFailure: false, empty: false, attention: false,
    // Absolute deadlines belong to this load, not to each subsequent snapshot.
    loadedAt: Date.now(),
    catalog: [
      info("alpha", "Observation alpha", "project", { modified: "2026-10-30T00:00:30Z" }),
      info("beta", "Observation beta", "project", { modified: "2026-10-30T00:00:20Z" }),
      info("gamma", "Aardvark idle"), info("omega", "Other project", "other"),
      info("child", "Delegated inspector", "project", { parentSessionId: "alpha", relation: { kind: "subagent", parentSessionId: "alpha", profile: "auditor", description: "Trace fixture delegation chain", status: "running" } }),
      info("grandchild", "Nested inspector", "project", { parentSessionId: "child", relation: { kind: "subagent", parentSessionId: "child", profile: "explore", description: "Inspect nested fixture evidence", status: "running" } }),
      info("catalog", "Saved notebook", "archive"),
      info("history", "Historical child", "archive", { parentSessionId: "alpha", relation: { kind: "subagent", parentSessionId: "alpha", profile: "auditor", description: "Previously recorded assignment", status: "completed" } }),
      info("fork", "Saved fork", "archive", { parentSessionId: "alpha", relation: { kind: "fork", originSessionId: "alpha" } }),
    ],
    runtime: ["alpha", "beta", "gamma", "omega", "child", "grandchild"],
  };
}
export function snapshot(state, id) {
  const now = Date.now(), runtime = state.empty ? [] : state.runtime;
  const closing = key => state.closing?.includes(key) ?? false;
  const forced = key => state.forcedStop?.includes(key) ?? false;
  const running = key => !closing(key) && ["alpha", "beta", "child"].includes(key);
  // v0.14.1's wire flag is suppressCompletionNotifications, NOT a role:
  // side chats may carry subagent:true alongside real delegated children.
  const child = key => state.flaggedSubagents?.includes(key) || state.catalog.find(s => s.id === key)?.relation?.kind === "subagent";
  const held = runtime.includes(id), alert = state.attention && id === "alpha";
  const result = {
    now,
    server: {
      startedAt: now - 7200000, idleTimeoutMs: 600000, heartbeatMs: 30000,
      wrappers: { alive: runtime.filter(id => !closing(id)).length, closing: runtime.filter(closing).length, starting: 0 }, eventStreams: { total: runtime.length },
      sseTotal: runtime.length ? runtime.length + 1 : 0, fileWatches: runtime.length ? 1 : 0,
      pages: runtime.length ? [{ holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux", agent: runtime.length, terminal: 0, fileWatch: 1 }] : [],
      terminals: { count: 0, listeners: 0, detached: 0, exited: 0, nextCleanupAt: null },
    },
    sessions: runtime.map(key => ({
      sessionId: key, state: closing(key) ? "closing" : "alive", running: running(key), awaitingInput: key === "beta", subagent: child(key),
      eventStreams: 1, providers: 1, nextIdleCheckAt: state.loadedAt + 300000 + runtime.indexOf(key) * 20000, forcedByStop: forced(key), starts: 1,
    })),
    session: id === null ? null : {
      sessionId: id, starting: false,
      wrapper: !held ? null : {
        sessionId: id, state: closing(id) ? "closing" : "alive", stale: false, subagent: child(id), chatOnly: false,
        createdAt: now - 60000, startedAt: now - 60000, closingAt: closing(id) ? state.loadedAt - 500 : null, extensions: alert ? "failed" : "bound",
        run: {
          running: running(id), streaming: running(id), promptRunning: false, pendingPrompts: 0,
          bashRunning: false, compacting: false, retrying: false, queuedMessages: 0,
          waitingForMcp: false, runningTools: 0, mutatingCommands: 0, replacement: null,
        },
        idle: { timeoutMs: 600000, nextCheckAt: state.loadedAt + 300000 + runtime.indexOf(id) * 20000, lastResetAt: state.loadedAt - 300000, forcedByStop: forced(id) },
        awaitingInput: id === "beta", pendingUiRequests: id === "beta" ? 1 : 0, customUis: 0, eventListeners: alert ? 4 : 1,
        lastEvent: { type: "fixture_event", at: now - 1000 }, lastCommand: null,
      },
      lifecycle: !held ? null : { starts: 1, firstStartedAt: now - 60000, lastStartedAt: now - 60000, lastClosedAt: null },
      providers: !held ? [] : [{ name: "fixture-keepalive", active: alert ? "error" : true, byFile: false }],
      eventStreams: !held ? [] : [{
        holder: "fixture-browser", address: "127.0.0.1", client: "Chrome · Linux",
        openedAt: now - 60000, connectedAt: now - 59000, lastWriteAt: now - 1000, droppedEvents: alert ? 7 : 0, queuedBytes: 0,
      }],
      subagents: { active: id === "alpha", runs: id !== "alpha" ? [] : [{ sessionId: "child", parentSessionId: "alpha", status: "running", profile: "auditor", background: true, resumed: false, dispatchedAt: now - 20000, abortRequested: false, mcpWaiting: false }], notifications: [] },
      mcp: !held ? null : {
        active: true, disposed: false, runActive: false, idleMs: 300000, idleReleaseAt: state.loadedAt + 120000 + runtime.indexOf(id) * 15000,
        servers: [
          { name: "fixture-mcp", scope: "global", state: alert ? "failed" : "connected", hasError: alert, released: false },
          { name: "fixture-gitlab", scope: "global", state: "connected", hasError: false, released: false },
          { name: "fixture-calendar", scope: "project", state: "connecting", hasError: false, released: false },
          { name: "fixture-notes", scope: "global", state: "idle", hasError: false, released: true },
          { name: "fixture-browser-tools", scope: "project", state: "connected", hasError: false, released: false },
          { name: `mcp-${id}`, scope: "global", state: "connected", hasError: false, released: false },
        ], problems: alert ? 1 : 0,
      },
    },
  };
  if (result.session?.wrapper && state.compact) {
    result.session.mcp.servers = result.session.mcp.servers.filter(s => s.name === `mcp-${id}`);
    result.session.providers = [];
  }
  if (result.session?.wrapper && state.multiStreams) {
    const stream = result.session.eventStreams[0];
    result.session.eventStreams = [
      { ...stream, openedAt: now - 61000, connectedAt: now - 60000, lastWriteAt: now - 1000 },
      { ...stream, openedAt: now - 122000, connectedAt: null, lastWriteAt: null, droppedEvents: 3 },
      { ...stream, openedAt: now - 183000, connectedAt: now - 180000, lastWriteAt: now - 3000, queuedBytes: 2048 },
      { ...stream, holder: null }, { ...stream, holder: null },
    ];
  }
  return result;
}

export function modelStatus(state, id) {
  if (!state.runtime.includes(id) || state.coldStatus?.includes(id)) return { running: false };
  return { running: true, state: { model: { id: "model-" + id, provider: "provider-" + id }, thinkingLevel: thinking(id) } };
}
export function thinking(id) {
  return ({ alpha: "high", beta: "low", gamma: "off", omega: "minimal", child: "medium", grandchild: "xhigh" })[id] ?? "high";
}
export function densitySeed(count = 3) {
  const ids = Array.from({ length: count }, (_, i) => "main-" + String(i + 1).padStart(2, "0"));
  return { catalog: ids.map(id => info(id, "Main " + id.slice(5))), runtime: ids, compact: true };
}
export function sideSeed({ sourceResident = true, sourceMissing = false } = {}) {
  const source = "side-source", side = "side-live", delegated = "delegated-live";
  const catalog = [
    ...(!sourceMissing ? [info(source, "Side source", "origin")] : []),
    info(side, "Independent side", "side-project", { parentSessionId: source, relation: { kind: "side", parentSessionId: source } }),
    info(delegated, "Real delegated child", "origin", { parentSessionId: source, relation: { kind: "subagent", parentSessionId: source, profile: "auditor", description: "Real delegation alongside side chat", status: "running" } }),
    info("side-history", "Archived side", "archive", { parentSessionId: source, relation: { kind: "side", parentSessionId: source } }),
  ];
  return { catalog, runtime: [...(sourceResident && !sourceMissing ? [source] : []), side, delegated], flaggedSubagents: [side, delegated], compact: true };
}
export function familySeed() {
  const catalog = [], runtime = [];
  for (const id of ["alpha", "beta"]) {
    catalog.push(info(id, "Parent " + id)); runtime.push(id);
    for (const n of [1, 2]) {
      const child = id + "-child-" + n; runtime.push(child);
      catalog.push(info(child, "Child " + child, "project", { parentSessionId: id, relation: { kind: "subagent", parentSessionId: id, profile: "audit-" + n, description: "Assignment " + child, status: "running" } }));
    }
  }
  return { catalog, runtime, compact: true };
}
