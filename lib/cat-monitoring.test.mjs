import assert from "node:assert/strict";
import test from "node:test";
import { hostname } from "node:os";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { reportCatError } = await jiti.import("./cat-monitoring.ts");
const { reportCatAgentEvent } = await jiti.import("./cat-agent-events.ts");
const { getCatConfig } = await jiti.import("./cat-config.ts");

test("CAT is enabled by default with the fixed DSN, package release and machine hostname", () => {
  const config = getCatConfig({});
  assert.equal(config.dsn, "https://24d86d19be5d513074e45febd5b004b8@cat.tossp.com/10");
  assert.equal(config.initialScope.tags.instance, hostname());
  assert.equal(config.tracesSampleRate, 0);
  assert.equal(config.environment, "production");
  assert.match(config.release, /^tsgw-agent@/);

  const overridden = getCatConfig({
    SENTRY_DSN: "", SENTRY_INSTANCE: "not-the-hostname", SENTRY_RELEASE: "not-the-package",
    SENTRY_ENVIRONMENT: "test", SENTRY_AUTH_TOKEN: "never-public",
  });
  assert.equal(overridden.dsn, config.dsn);
  assert.equal(overridden.initialScope.tags.instance, hostname());
  assert.equal(overridden.release, config.release);
  assert.equal(overridden.environment, "test");
  assert.ok(!JSON.stringify(overridden).includes("never-public"));
});

test("reporting preserves actual exceptions and provider failures without adding content collection", async () => {
  const events = [];
  Sentry.init({
    dsn: "https://public@example.com/10", defaultIntegrations: [],
    transport: () => ({
      send(envelope) {
        for (const [header, event] of envelope[1]) if (header.type === "event") events.push(event);
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  });
  try {
    reportCatError(new Error("connection failed"), { source: "test", session_id: "session-a" });
    reportCatError(new DOMException("stopped", "AbortError"), { source: "test" });
    reportCatAgentEvent({ type: "message_end", message: {
      role: "assistant", stopReason: "error", errorMessage: "upstream timeout",
      provider: "test-provider", model: "test-model", content: [{ type: "text", text: "not-event-data" }],
    } }, "session-a");
    reportCatAgentEvent({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } }, "session-a");
    reportCatAgentEvent({ type: "message_end", message: { role: "toolResult", isError: true } }, "session-a");
    reportCatAgentEvent({ type: "prompt_error", errorMessage: "failed after acceptance" }, "session-a");
    reportCatAgentEvent({ type: "extension_error", error: "extension failed" }, "session-a");
    await Sentry.flush(2000);
    assert.equal(events.length, 4);
    assert.equal(events[0].exception.values[0].value, "connection failed");
    assert.equal(events[0].tags.session_id, "session-a");
    assert.equal(events[1].exception.values[0].value, "upstream timeout");
    assert.equal(events[1].tags.source, "provider");
    assert.equal(events[1].tags.provider, "test-provider");
    assert.equal(events[2].tags.source, "prompt_error");
    assert.equal(events[3].tags.source, "extension_error");
    assert.ok(!JSON.stringify(events).includes("not-event-data"));
  } finally { await Sentry.close(2000); }
});

test("reporting without an initialized client leaves business code usable", () => {
  assert.doesNotThrow(() => reportCatError(new Error("monitoring disabled"), { source: "test" }));
});
