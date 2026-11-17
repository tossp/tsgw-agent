import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-im-request-context-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("../../lib/rpc-manager.ts");
const { createPiSessionHost } = await jiti.import("./pi-host.ts");
const { installImRequestContextProjection, registerImMessageSource } = await jiti.import("./message-source.ts");
const source = {
  channel: "weixin", botId: "fixture", botName: "fixture", chatId: "fixture",
  senderId: "fixture", messageId: "fixture", isGroup: false,
};

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the local SDK fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function requestContext(request) {
  const match = /<im_request_context>\s*([\s\S]*?)\s*<\/im_request_context>/.exec(request.system);
  return match ? JSON.parse(match[1]) : undefined;
}

// Same in-memory SDK/faux-provider setup as rpc-manager's tool-exposure and stop-queue
// integration tests. Only host discovery is stubbed; submission, queueing, collection,
// source registration and the provider's final request projection all run for real.
async function setup(t, extensionFactories = []) {
  const faux = fauxProvider({ models: [{ id: "im-request-context" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "absent-auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
  const resourceLoader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager,
    extensionFactories,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: agentDir, agentDir, modelRuntime, model: faux.getModel("im-request-context"),
    sessionManager: SessionManager.inMemory(agentDir), settingsManager, resourceLoader,
  });
  installImRequestContextProjection(session);
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.shutdown());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const host = createPiSessionHost({
    list: async () => [{ id: session.sessionId, cwd: agentDir, firstMessage: "fixture" }],
    get: async () => wrapper,
    registerSource(_wrapper, inputSource, capabilities) {
      return registerImMessageSource(session.sessionManager, inputSource, capabilities);
    },
  });
  const requests = [];
  const observe = (context) => {
    // Capture at the model boundary, after all extension and SDK projections.
    requests.push({
      system: context.messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n"),
      tools: getCurrentTools(context.messages).map((tool) => tool.name),
      users: context.messages.filter((message) => message.role === "user").map((message) =>
        typeof message.content === "string" ? message.content
          : message.content.filter((block) => block.type === "text").map((block) => block.text).join("")),
    });
  };
  return {
    faux, wrapper, requests, observe,
    respond(message) { return (context) => { observe(context); return message; }; },
    idle: () => until(() => !wrapper.isRunning() && session.isIdle),
    promptIm: (text) => host.prompt(session.sessionId, text, new AbortController().signal,
      source, undefined, { attachments: true }),
  };
}

test("Web and IM preserve every system text block supplied by context_with_system", { timeout: 15_000 }, async (t) => {
  const originalPrompts = [];
  const extensionTexts = ["Report the fixture record revision.", "Keep the fixture record units in the answer."];
  const textBlockExtension = {
    name: "request-context-text-block-fixture",
    factory(pi) {
      pi.on("context_with_system", (event) => {
        const [head, ...rest] = event.messages;
        const originalPrompt = getSystemMessageText(head);
        originalPrompts.push(originalPrompt);
        return { messages: [{
          ...head,
          // Represent the existing prompt and both extension instructions as legal SDK text blocks.
          sections: undefined,
          content: [originalPrompt, ...extensionTexts].map((text) => ({ type: "text", text })),
        }, ...rest] };
      });
    },
  };
  const f = await setup(t, [textBlockExtension]);
  f.faux.setResponses([f.respond(fauxAssistantMessage("Web answer")), f.respond(fauxAssistantMessage("IM answer"))]);
  await f.wrapper.send({ type: "prompt", message: "Web task" });
  await f.idle();
  await f.promptIm("IM task");
  await f.idle();
  assert.equal(f.requests.length, 2);
  assert.equal(originalPrompts.length, 2);
  for (const [index, channel] of ["Web", "IM"].entries()) {
    assert.ok(originalPrompts[index].length > 0);
    for (const text of [originalPrompts[index], ...extensionTexts]) {
      assert.ok(f.requests[index].system.includes(text), `${channel}: every original system text block must reach the model`);
    }
    assert.ok(!f.requests[index].system.includes("[object Object]"), `${channel}: system text blocks must not be stringified as objects`);
  }
  assert.equal(requestContext(f.requests[0]), undefined);
  assert.equal(requestContext(f.requests[1])?.channel, "weixin");
});

const LATE_SNIPPET = "Inspect the requested fixture record";
const LATE_GUIDELINE = "Include the fixture record revision when reporting its value";
const activatingExtension = {
  name: "request-context-tool-fixture",
  factory(pi) {
    pi.registerTool({
      name: "inspect_fixture", label: "inspect_fixture", description: "Inspect a fixture record",
      parameters: { type: "object", properties: {} }, defaultActive: false,
      promptSnippet: LATE_SNIPPET, promptGuidelines: [LATE_GUIDELINE],
      async execute() { return { content: [{ type: "text", text: "value: 42, revision: 1" }], details: undefined }; },
    });
    pi.registerTool({
      name: "activate_fixture", label: "activate_fixture", description: "Activate the fixture inspection tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        pi.setActiveTools([...pi.getActiveTools(), "inspect_fixture"]);
        return { content: [{ type: "text", text: "inspection tool activated" }], details: undefined };
      },
    });
  },
};

const toolPromptState = (request) => ({
  declared: request.tools.includes("inspect_fixture"),
  snippet: request.system.includes(LATE_SNIPPET),
  guideline: request.system.includes(LATE_GUIDELINE),
});

test("IM requests refresh a newly activated tool's declaration, snippet and guidelines together", { timeout: 15_000 }, async (t) => {
  // The Web control establishes the SDK's normal per-turn tool prompt refresh.
  for (const channel of ["Web", "IM"]) {
    const f = await setup(t, [activatingExtension]);
    f.faux.setResponses([
      f.respond(fauxAssistantMessage([fauxToolCall("activate_fixture", {})], { stopReason: "toolUse" })),
      f.respond(fauxAssistantMessage("done")),
    ]);
    if (channel === "IM") await f.promptIm("activate the fixture inspection tool");
    else await f.wrapper.send({ type: "prompt", message: "activate the fixture inspection tool" });
    await f.idle();
    assert.equal(f.requests.length, 2, `${channel}: tool execution must lead to another model request`);
    assert.deepEqual(toolPromptState(f.requests[0]), { declared: false, snippet: false, guideline: false });
    if (channel === "IM") assert.equal(requestContext(f.requests[0])?.channel, "weixin");
    assert.deepEqual(toolPromptState(f.requests[1]), { declared: true, snippet: true, guideline: true },
      `${channel}: the activated tool's prompt guidance must accompany its declaration`);
  }
});

for (const streamingBehavior of ["steer", "followUp"]) {
  test(`Web ${streamingBehavior} during an IM run reaches the model without IM request context`, { timeout: 15_000 }, async (t) => {
    let releaseFirstResponse;
    const firstResponse = new Promise((resolve) => { releaseFirstResponse = resolve; });
    // Release before fixture shutdown even if admission or an assertion fails.
    t.after(() => releaseFirstResponse());
    const f = await setup(t);
    f.faux.setResponses([
      async (context) => {
        f.observe(context);
        await firstResponse;
        return fauxAssistantMessage("IM partial answer");
      },
      f.respond(fauxAssistantMessage("Web answer")),
    ]);
    // Handle rejection immediately: the host correctly refuses mixed-origin replies.
    const outcome = f.promptIm("IM task").then(() => "unexpected delivery", (error) => error.message);
    await until(() => f.requests.length === 1);
    await f.wrapper.send({ type: "prompt", message: "Web task", streamingBehavior });
    releaseFirstResponse();
    assert.match(await outcome, /其他消息/, "the shared run must not be delivered as an IM reply");
    await f.idle();
    assert.equal(f.requests.length, 2);
    assert.equal(requestContext(f.requests[0])?.channel, "weixin");
    assert.equal(f.requests[1].users.at(-1), "Web task", "inspect the request that actually consumes the queued Web input");
    assert.equal(requestContext(f.requests[1]), undefined,
      `Web ${streamingBehavior} must not inherit the previous IM channel or reply capabilities`);
  });
}
