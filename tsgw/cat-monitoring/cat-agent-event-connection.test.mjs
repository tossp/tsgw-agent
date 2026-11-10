import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentEventConnection } = await jiti.import("../../lib/agent-event-connection.ts");

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
