import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { POST } = await jiti.import("../../app/api/agent/[id]/route.ts");

function capture(t) {
  const events = [];
  Sentry.init({
    dsn: "https://public@example.com/10", defaultIntegrations: [], sendClientReports: false,
    beforeSend(event) { events.push(event); return null; },
  });
  t.after(() => Sentry.close(2000));
  return events;
}

test("a real initial session_start error is captured once before notice conversion, never on replay", async (t) => {
  const events = capture(t);
  const dir = await mkdtemp(join(tmpdir(), "pi-web-cat-startup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: "cat-startup" }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => pi.on("session_start", () => { throw new Error("isolated startup hook failure"); })],
    },
  });
  const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("cat-startup") });
  // A constructor notice emits too: the tracer must already exist at that point.
  const wrapper = new AgentSessionWrapper(inner, { startupIssues: [{ type: "warning", message: "isolated loader diagnostic" }] });
  t.after(() => wrapper.shutdown());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  await Sentry.flush(2000);
  assert.equal(events.length, 1);
  assert.equal(events[0].tags.source, "extension_error");
  assert.equal(events[0].tags.session_id, inner.sessionId);
  assert.equal(events[0].exception.values[0].value, "isolated startup hook failure");

  const first = [], second = [];
  const stopFirst = wrapper.onEvent((event) => first.push(event));
  stopFirst();
  const stopSecond = wrapper.onEvent((event) => second.push(event));
  stopSecond();
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.ok(first.every((event) => event.type === "extension_ui_request" && event.method === "notify"));
  assert.match(first[1].message, /isolated startup hook failure/);
  await Sentry.flush(2000);
  assert.equal(events.length, 1, "replayed startup notices cannot capture the original error again");
});

for (const [thrownStatus, expectedStatus] of [[404, 404], [undefined, 500], [418, 500]]) {
  test(`agent route capture status matches its final HTTP status (${thrownStatus ?? "untyped"})`, async (t) => {
    const events = capture(t);
    const id = `cat-route-status-${expectedStatus}-${thrownStatus}`;
    const registry = globalThis.__piSessions ??= new Map();
    registry.set(id, {
      isAlive: () => true,
      async send() { throw Object.assign(new Error("isolated route failure"), { status: thrownStatus }); },
    });
    t.after(() => registry.delete(id));
    const response = await POST(new Request(`http://localhost/api/agent/${id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "prompt", message: "not accepted" }),
    }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), { error: "isolated route failure", code: "prompt_rejected", accepted: false });
    await Sentry.flush(2000);
    assert.equal(events.length, 1);
    assert.equal(events[0].tags.status, expectedStatus);
    assert.equal(events[0].tags.operation, "prompt");
    assert.equal(events[0].tags.session_id, id);
  });
}
