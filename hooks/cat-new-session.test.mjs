import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import Sentry from "@sentry/nextjs";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
const events = [];
Sentry.init({
  dsn: "https://public@example.com/10", defaultIntegrations: [], sendClientReports: false,
  beforeSend(event) { events.push(event); return null; },
});
after(() => Sentry.close(2000));
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

for (const status of ["network", 502, 400]) {
  test(`new-session startup reports ${status} without changing failed-send behavior`, async () => {
    events.length = 0;
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    let created = false;
    globalThis.fetch = async (url) => {
      if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
      assert.equal(url, "/api/agent/new");
      if (status === "network") throw new TypeError("CAT test connection reset");
      return Response.json({ error: "CAT test unavailable" }, { status });
    };
    console.error = () => {};
    const hook = renderHook(useAgentSession, {
      session: null, newSessionCwd: "/project", newSessionDraftKey: "new:cat-test",
      onSessionCreated: () => { created = true; },
    });
    try {
      await settle();
      hook.flush();
      await hook.result.handleSend("first message");
      await settle();
      hook.flush();
      assert.equal(created, false);
      assert.equal(hook.result.agentRunning, false);
      assert.equal(events.length, status === 400 ? 0 : 1);
      if (events.length) {
        assert.equal(events[0].tags.source, "agent-new-request");
        assert.equal(events[0].exception.values[0].value, status === "network" ? "CAT test connection reset" : "CAT test unavailable");
      }
    } finally {
      hook.unmount();
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  });
}
