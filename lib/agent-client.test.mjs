import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

// The monitoring target of these tests is the event the SDK would send, captured in
// `beforeSend` and never transmitted. `defaultIntegrations: []` keeps Sentry from
// installing process-wide handlers into the test run.
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

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("a prompt refused for a missing folder carries the folder (#1422)", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { cwdMissingError, cwdMissingBody, missingCwdFromBody } = await jiti.import("./missing-cwd.ts");
  const refusal = cwdMissingError("/old/app");
  assert.equal(refusal.message, "Directory does not exist: /old/app");
  // The route reads the thrown error by its fields, never its class.
  assert.equal(missingCwdFromBody(refusal), "/old/app");
  assert.equal(missingCwdFromBody(new Error("Directory does not exist: /old/app")), null);
  // The body the route answers with: the typed fields beside prompt_rejected.
  globalThis.fetch = async () => Response.json(
    { ...cwdMissingBody(refusal.cwd), code: "prompt_rejected", accepted: false },
    { status: 500 },
  );
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error.missingCwd, "/old/app");
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  // Any other refusal names no folder, even with a cwd field or the same text.
  globalThis.fetch = async () => Response.json(
    { error: "Directory does not exist: /old/app", cwd: "/old/app", code: "prompt_rejected", accepted: false },
    { status: 500 },
  );
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => error.missingCwd === undefined,
  );
  assert.equal(missingCwdFromBody({ reason: "cwd-missing", cwd: "" }), null);
  assert.equal(missingCwdFromBody(null), null);
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});

test("a failed command is reported with its operation, session and status, never its body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  takeReportedEvents();

  globalThis.fetch = async () => jsonResponse({ error: "upstream exploded" }, 502);
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "SECRET PROMPT TEXT" }),
    (error) => error instanceof AgentCommandError && error.status === 502,
  );

  const events = takeReportedEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.tags.source, "agent-command");
  assert.equal(event.tags.operation, "prompt");
  assert.equal(event.tags.session_id, "session-id");
  assert.equal(String(event.tags.status), "502");
  assert.equal(exceptionOf(event).type, "AgentCommandError");
  assert.equal(exceptionOf(event).value, "upstream exploded");
  assert.equal(JSON.stringify(event).includes("SECRET PROMPT TEXT"), false);
});

test("a network failure is reported and its original rejection is kept", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  takeReportedEvents();

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };
  await assert.rejects(
    sendAgentCommand("session-id", { type: "get_state" }),
    (error) => error === transportError,
  );

  const [event] = takeReportedEvents();
  assert.equal(event.tags.source, "agent-command");
  assert.equal(event.tags.operation, "get_state");
  assert.equal(event.tags.session_id, "session-id");
  assert.equal(event.tags.status, undefined);
  assert.equal(exceptionOf(event).type, "TypeError");
  assert.equal(exceptionOf(event).value, "connection reset");
});

test("a 2xx reply carrying an error is reported as one", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  takeReportedEvents();

  globalThis.fetch = async () => jsonResponse({ error: "no runtime", code: "prompt_rejected", accepted: false }, 200);
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => (
      error instanceof AgentCommandError
      && error.status === 200
      && error.code === "prompt_rejected"
      && error.accepted === false
    ),
  );

  const [event] = takeReportedEvents();
  assert.equal(event.tags.operation, "prompt");
  assert.equal(String(event.tags.status), "200");
  assert.equal(exceptionOf(event).type, "AgentCommandError");
});

test("a 2xx reply that is not JSON is reported while the command's answer is unchanged", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  takeReportedEvents();

  globalThis.fetch = async () => new Response("<html>proxy</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
  assert.equal(await sendAgentCommand("session-id", { type: "get_state" }), undefined);

  const [event] = takeReportedEvents();
  assert.equal(event.tags.source, "agent-command");
  assert.equal(event.tags.operation, "get_state");
  assert.equal(String(event.tags.status), "200");
  assert.equal(exceptionOf(event).type, "SyntaxError");
});

test("expected refusals and clean replies are not reported", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  takeReportedEvents();

  globalThis.fetch = async () => jsonResponse({ error: "Directory does not exist: /gone" }, 400);
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => error instanceof AgentCommandError && error.status === 400,
  );
  // A 5xx with a body that is not JSON is reported once, as its status.
  globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => error instanceof AgentCommandError && error.status === 502,
  );
  const failures = takeReportedEvents();
  assert.equal(failures.length, 1);
  assert.equal(String(failures[0].tags.status), "502");

  globalThis.fetch = async () => jsonResponse({ success: true, data: { isStreaming: false } }, 200);
  assert.deepEqual(await sendAgentCommand("session-id", { type: "get_state" }), { isStreaming: false });
  assert.deepEqual(takeReportedEvents(), []);
});
