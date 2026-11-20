import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { createPiSessionHost } = await jiti.import("./pi-host.ts");
const { createImExtension, installChatOnlyImReply } = await jiti.import("./extension.ts");
const { IM_NOTIFICATION_TYPE, resolveImReplyHandle } = await jiti.import("./notification.ts");
const { buildSessionContext } = await jiti.import("../../lib/session-reader.ts");
const { WAKEUP_NOTIFICATION_TYPE } = await jiti.import("../wakeups/history.ts");

async function setup(t, chatOnly) {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-sdk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = fauxProvider({ models: [{ id: "im-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(fake.provider);
  const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
  const sent = [];
  const getRuntime = async () => ({ async send(cwd, destination, items) { sent.push({ cwd, destination, items }); return { success: true, results: [] }; } });
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: chatOnly ? [] : [createImExtension(getRuntime)] });
  await resourceLoader.reload();
  const manager = SessionManager.create(directory, directory);
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, settingsManager, modelRuntime,
    model: fake.getModel("im-test"), sessionManager: manager, ...(chatOnly ? { tools: [] } : {}) });
  if (chatOnly) installChatOnlyImReply(session, getRuntime);
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.shutdown());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const access = {
    list: async () => [{ id: session.sessionId, cwd: directory }], get: async () => wrapper,
    async resolvePath() { assert.fail("live wrapper must be reused"); },
  };
  const host = createPiSessionHost(access);
  const handle = { id: "test-handle", sessionId: session.sessionId, botId: "test-bot", chatId: "private-owner" };
  const input = { chatId: handle.chatId, senderId: handle.chatId, id: "inbound", isGroup: false, text: "WeChat notification fixture" };
  return { session, wrapper, host, handle, input, sent, fake, directory };
}

function declared(context) {
  return getCurrentTools(context.messages).map(({ name }) => name);
}

const reply = (handle, text) => fauxAssistantMessage([fauxToolCall("im_send", {
  destination: { handle }, items: [{ type: "text", text }],
})], { stopReason: "toolUse" });

for (const chatOnly of [false, true]) {
  test(`native notification is processed as follow-up and sends only by tool in ${chatOnly ? "Chat only" : "ordinary"} mode`, { timeout: 15_000 }, async (t) => {
    const f = await setup(t, chatOnly);
    const first = Promise.withResolvers();
    const requested = Promise.withResolvers();
    const notified = Promise.withResolvers();
    let wakeupTools;
    f.fake.setResponses([
      (context) => { assert.equal(declared(context).includes("im_send"), !chatOnly); requested.resolve(); return first.promise; },
      (context) => {
        const serialized = JSON.stringify(context.messages);
        assert.match(serialized, /WeChat notification fixture/);
        assert.match(serialized, /test-handle/);
        assert.doesNotMatch(serialized, /private-owner/);
        assert.ok(declared(context).includes("im_send"));
        notified.resolve();
        return reply(f.handle.id, "actual reply");
      },
      () => fauxAssistantMessage("only Web transcript"),
      (context) => {
        wakeupTools = declared(context);
        return fauxAssistantMessage("independent wakeup reply");
      },
      (context) => { assert.equal(declared(context).includes("im_send"), !chatOnly); return fauxAssistantMessage("next Web reply"); },
    ]);
    t.after(first.resolve);
    await f.wrapper.send({ type: "prompt", message: "web first" });
    await requested.promise;
    const { completion } = await f.host.notify(f.handle, f.directory, f.input, new AbortController().signal);
    await completion;
    assert.deepEqual(f.sent, []);
    first.resolve(fauxAssistantMessage("Web reply"));
    await notified.promise;
    await f.session.waitForIdle();
    assert.deepEqual(f.sent, [{ cwd: f.directory, destination: { handle: f.handle }, items: [{ type: "text", text: "actual reply" }] }]);
    await f.session.sendCustomMessage({
      customType: WAKEUP_NOTIFICATION_TYPE, content: "independent wakeup fixture", display: true,
    }, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(wakeupTools?.includes("im_send"), !chatOnly);
    await f.session.prompt("next Web prompt");
    assert.equal(f.fake.state.callCount, 5);
    const entries = f.session.sessionManager.getEntries();
    assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 2);
    assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === IM_NOTIFICATION_TYPE).length, 1);
    assert.ok(buildSessionContext(entries).messages.some((message) => message.role === "custom" && message.customType === IM_NOTIFICATION_TYPE));
    const reopened = SessionManager.open(f.session.sessionFile);
    assert.deepEqual(resolveImReplyHandle(reopened, f.handle.id), f.handle);
    const branched = SessionManager.open(f.session.sessionFile);
    branched.createBranchedSession(branched.getLeafId());
    assert.equal(resolveImReplyHandle(branched, f.handle.id), undefined);
    assert.equal(f.sent.length, 1);
  });
}

test("the first native notice starts an idle empty session and an explicit Web push uses the configured bot", { timeout: 15_000 }, async (t) => {
  const f = await setup(t, false);
  f.fake.setResponses([
    () => reply(f.handle.id, "reply"), () => fauxAssistantMessage("done"),
    () => fauxAssistantMessage([fauxToolCall("im_send", { destination: { bot: "named-bot" }, items: [{ type: "text", text: "push" }] })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("done"),
  ]);
  const { completion } = await f.host.notify(f.handle, f.directory, f.input, new AbortController().signal);
  await completion;
  assert.ok(f.session.sessionFile);
  assert.deepEqual(f.sent[0].destination, { handle: f.handle });
  await f.session.prompt("push via named-bot");
  assert.deepEqual(f.sent[1].destination, { bot: "named-bot" });
});
