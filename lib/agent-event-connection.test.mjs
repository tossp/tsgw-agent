import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentEventConnection } = await jiti.import("./agent-event-connection.ts");

// The target is the event the SDK would send, captured in `beforeSend` and never
// transmitted; `defaultIntegrations: []` keeps Sentry from installing process-wide
// handlers into the test run.
const Sentry = (await import("@sentry/nextjs")).default;
const reportedEvents = [];
Sentry.init({
  dsn: "https://public@example.com/42",
  defaultIntegrations: [],
  tracesSampleRate: 0,
  sendClientReports: false,
  beforeSend(event) {
    reportedEvents.push(event);
    return null;
  },
});

function takeReportedEvents() {
  return reportedEvents.splice(0, reportedEvents.length);
}

function exceptionOf(event) {
  return event.exception?.values?.[0];
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource {
  readyState = CONNECTING;
  onmessage = null;
  onerror = null;
  closeCount = 0;

  open() { this.readyState = OPEN; }
  message(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  error() {
    this.readyState = CLOSED;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = CLOSED;
    this.closeCount += 1;
  }
}

function createHarness({ readinessTimeoutMs = 100, reconnectDelayMs = 5, staleAfterMs, createSource } = {}) {
  const sources = [];
  const events = [];
  const unexpectedErrors = [];
  let activeSession = "session-a";
  let demand = false;
  const connection = new AgentEventConnection({
    createSource(sessionId) {
      if (createSource) return createSource(sessionId);
      const source = new FakeEventSource();
      source.sessionId = sessionId;
      sources.push(source);
      return source;
    },
    onEvent(event) { events.push(event); },
    shouldMaintain: (sessionId) => demand && sessionId === activeSession,
    readinessTimeoutMs,
    reconnectDelayMs,
    staleAfterMs,
    onUnexpectedError(error) { unexpectedErrors.push(error); },
  });
  return {
    connection,
    sources,
    events,
    unexpectedErrors,
    setActiveSession(sessionId) { activeSession = sessionId; },
    setDemand(value) { demand = value; },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("shares one source and waits past the former transport deadline", async () => {
  const { connection, sources, events } = createHarness();
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  assert.equal(sources.length, 1);
  sources[0].open();
  await wait(20);
  sources[0].message({ type: "connected" });
  await Promise.all([first, second]);

  sources[0].message({ type: "agent_start" });
  assert.deepEqual(events.map((event) => event.type), ["connected", "agent_start"]);
});

test("times out all waiters and closes the stalled source", async () => {
  const { connection, sources } = createHarness({ readinessTimeoutMs: 10 });
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");

  await assert.rejects(first, (error) => error.status === "ready_timeout");
  await assert.rejects(second, (error) => error.status === "ready_timeout");
  assert.equal(sources[0].closeCount, 1);
});

test("manual close rejects waiters and isolates late events", async () => {
  const { connection, sources, events } = createHarness();
  const abandoned = connection.ensureConnected("session-a");
  const oldSource = sources[0];
  connection.close();
  await assert.rejects(abandoned, (error) => error.status === "closed");

  const replacement = connection.ensureConnected("session-a");
  oldSource.open();
  oldSource.message({ type: "connected" });
  await nextTurn();
  assert.deepEqual(events, []);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await replacement;
});

test("surfaces startup errors without retrying or dispatching them", async () => {
  const { connection, sources, events } = createHarness();
  const ready = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "startup_error", errorMessage: "broken config" });

  await assert.rejects(ready, (error) => (
    error.status === "startup_error" && error.message === "broken config"
  ));
  await wait(10);
  assert.equal(sources.length, 1);
  assert.deepEqual(events, []);
});

test("replaces a previously connected CONNECTING source only once", async () => {
  const { connection, sources } = createHarness();
  const initial = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await initial;

  sources[0].readyState = CONNECTING;
  const first = connection.ensureConnected("session-a");
  const second = connection.ensureConnected("session-a");
  await nextTurn();
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await Promise.all([first, second]);
});

test("a ready stream that closed without an error event is reported and replaced", async () => {
  takeReportedEvents();
  const { connection, sources } = createHarness();
  const initial = connection.ensureConnected("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await initial;

  sources[0].readyState = CLOSED;
  const reconnected = connection.ensureConnected("session-a");
  await nextTurn();
  assert.equal(sources.length, 2);
  sources[1].open();
  sources[1].message({ type: "connected" });
  await reconnected;
  connection.close();

  const [event] = takeReportedEvents();
  assert.equal(event.tags.source, "agent-events");
  assert.equal(event.tags.session_id, "session-a");
  assert.equal(event.tags.reason, "closed");
  assert.equal(exceptionOf(event).type, "AgentEventConnectionError");
});

test("passive maintenance retries a transient failure once", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();
  await wait(10);
  assert.equal(sources.length, 2);

  sources[1].open();
  sources[1].message({ type: "connected" });
  await wait(10);
  assert.equal(sources.length, 2);
});

test("an explicit startup error cancels a pending passive retry", async () => {
  const { connection, sources, setDemand } = createHarness();
  setDemand(true);
  connection.maintain("session-a");
  sources[0].error();

  const explicit = connection.ensureConnected("session-a");
  sources[1].open();
  sources[1].message({ type: "startup_error", errorMessage: "terminal" });
  await assert.rejects(explicit, (error) => error.status === "startup_error");
  await wait(10);
  assert.equal(sources.length, 2);
});

test("dropped demand, session switches, and close cannot revive an old retry", async () => {
  const first = createHarness();
  first.setDemand(true);
  first.connection.maintain("session-a");
  first.sources[0].error();
  first.setDemand(false);
  await wait(10);
  assert.equal(first.sources.length, 1);

  const second = createHarness();
  second.setDemand(true);
  second.connection.maintain("session-a");
  second.sources[0].error();
  second.setActiveSession("session-b");
  const ready = second.connection.ensureConnected("session-b");
  second.sources[1].open();
  second.sources[1].message({ type: "connected" });
  await ready;
  await wait(10);
  assert.equal(second.sources.length, 2);

  const closed = createHarness();
  closed.setDemand(true);
  closed.connection.maintain("session-a");
  closed.sources[0].error();
  closed.connection.close();
  await wait(10);
  assert.equal(closed.sources.length, 1);
});

test("a ready stream silent past staleAfterMs reconnects; heartbeats keep it and never reach onEvent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { connection, sources, events, setDemand } = createHarness({ readinessTimeoutMs: 60_000, staleAfterMs: 75_000 });
  setDemand(true);
  connection.maintain("session-a");
  sources[0].open();
  sources[0].message({ type: "connected" });
  await nextTurn();

  for (let beat = 0; beat < 4; beat += 1) {
    t.mock.timers.tick(30_000);
    sources[0].message({ type: "heartbeat" });
  }
  assert.equal(sources[0].closeCount, 0, "heartbeats every 30 s keep the stream");
  assert.deepEqual(events.map((event) => event.type), ["connected"]);

  // A half-open connection: nothing more arrives.
  t.mock.timers.tick(75_000);
  assert.equal(sources[0].closeCount, 0, "not before staleAfterMs has passed in full");
  t.mock.timers.tick(25_000);
  assert.equal(sources[0].closeCount, 1);
  t.mock.timers.tick(5);
  assert.equal(sources.length, 2, "reconnected after reconnectDelayMs");
  connection.close();
});

test("stream failures are reported with the session and reason the connection saw", async () => {
  takeReportedEvents();

  const startup = createHarness();
  const ready = startup.connection.ensureConnected("session-a");
  startup.sources[0].open();
  startup.sources[0].message({ type: "startup_error", errorMessage: "broken config" });
  await assert.rejects(ready, (error) => error.status === "startup_error");

  const timedOut = createHarness({ readinessTimeoutMs: 10 });
  await assert.rejects(timedOut.connection.ensureConnected("session-a"), (error) => error.status === "ready_timeout");

  const dropped = createHarness();
  dropped.setDemand(true);
  dropped.connection.maintain("session-a");
  dropped.sources[0].error();
  await wait(10);
  dropped.connection.close();

  const events = takeReportedEvents();
  assert.deepEqual(events.map((event) => event.tags.reason), ["startup_error", "ready_timeout", "closed"]);
  assert.deepEqual(events.map((event) => event.tags.session_id), ["session-a", "session-a", "session-a"]);
  assert.deepEqual(events.map((event) => event.tags.source), ["agent-events", "agent-events", "agent-events"]);
  assert.equal(exceptionOf(events[0]).type, "AgentEventConnectionError");
  assert.equal(exceptionOf(events[0]).value, "broken config");
  assert.equal(exceptionOf(events[1]).value, "Timed out starting the agent session. Please try again.");
  assert.equal(exceptionOf(events[2]).value, "Failed to connect to the agent event stream. Please try again.");
});

test("a manual close, a session switch and a released page are not failures", async () => {
  takeReportedEvents();

  const closed = createHarness();
  const abandoned = closed.connection.ensureConnected("session-a");
  closed.connection.close();
  await assert.rejects(abandoned, (error) => error.status === "closed");

  const switched = createHarness();
  const previous = switched.connection.ensureConnected("session-a");
  switched.setActiveSession("session-b");
  const next = switched.connection.ensureConnected("session-b");
  await assert.rejects(previous, (error) => error.status === "closed");
  switched.sources[1].open();
  switched.sources[1].message({ type: "connected" });
  await next;
  switched.connection.close();

  assert.deepEqual(takeReportedEvents(), []);
});

test("a source that cannot be created is reported as the connection's own failure", async () => {
  takeReportedEvents();

  const { connection } = createHarness({
    createSource() {
      throw new Error("EventSource is not available");
    },
  });
  await assert.rejects(
    connection.ensureConnected("session-a"),
    (error) => error.status === "closed" && error.message === "EventSource is not available",
  );

  const [event] = takeReportedEvents();
  assert.equal(event.tags.source, "agent-events");
  assert.equal(event.tags.session_id, "session-a");
  assert.equal(event.tags.reason, "closed");
  assert.equal(exceptionOf(event).type, "AgentEventConnectionError");
  assert.equal(exceptionOf(event).value, "EventSource is not available");
});

test("no watchdog without staleAfterMs, and none before the stream is ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const quiet = createHarness({ readinessTimeoutMs: 1_000_000 });
  quiet.setDemand(true);
  quiet.connection.maintain("session-a");
  quiet.sources[0].open();
  quiet.sources[0].message({ type: "connected" });
  await nextTurn();
  t.mock.timers.tick(600_000);
  assert.equal(quiet.sources[0].closeCount, 0);
  quiet.connection.close();

  const pending = createHarness({ readinessTimeoutMs: 1_000_000, staleAfterMs: 75_000 });
  pending.setDemand(true);
  pending.connection.maintain("session-a");
  pending.sources[0].open();
  t.mock.timers.tick(600_000);
  assert.equal(pending.sources[0].closeCount, 0, "the readiness timeout, not the watchdog, covers a stream not yet ready");
  pending.connection.close();
});
