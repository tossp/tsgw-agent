import assert from "node:assert/strict";
import test from "node:test";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { reportCatError } = await jiti.import("./cat-monitoring.ts");
const { reportCatAgentEvent } = await jiti.import("./cat-agent-events.ts");
const { getCatConfig } = await jiti.import("./cat-config.ts");

test("runtime config is disabled without a DSN and exposes only SDK settings", () => {
  assert.equal(getCatConfig({}).dsn, "");
  const config = getCatConfig({
    SENTRY_DSN: "https://public@example.com/10", SENTRY_ENVIRONMENT: "test",
    SENTRY_INSTANCE: "hq-dev", SENTRY_AUTH_TOKEN: "never-public",
  });
  assert.equal(config.dsn, "https://public@example.com/10");
  assert.equal(config.environment, "test");
  assert.equal(config.tracesSampleRate, 0);
  assert.equal(config.initialScope.tags.instance, "hq-dev");
  assert.match(config.release, /^tsgw-agent@/);
  assert.ok(!JSON.stringify(config).includes("never-public"));
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
