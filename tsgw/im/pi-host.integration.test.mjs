import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

function reply(response, text) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const choice of [
    { delta: { role: "assistant", content: text }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]) response.write(`data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 1, model: "im-test", choices: [{ index: 0, ...choice }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function requestContext(request) {
  const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const context = /<im_request_context>\s*([\s\S]*?)\s*<\/im_request_context>/.exec(system);
  return context ? JSON.parse(context[1]) : undefined;
}

async function until(check) {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) assert.fail("local model request did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real Pi wrapper preserves project binding and attributes only the IM reply after a Web run", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-im-sdk-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });
  const requests = [];
  let mediaAnswer = "IM RESULT";
  let finishWeb;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (requests.length === 1) finishWeb = () => reply(response, "WEB RESULT");
    else reply(response, mediaAnswer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();
  await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
    "im-local": { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-dummy", api: "openai-completions",
      models: [{ id: "im-test", name: "IM test", reasoning: false, input: ["text", "image"], contextWindow: 16000, maxTokens: 1000 }] },
  } }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    defaultProvider: "im-local", defaultModel: "im-test", enabledModels: ["im-local/im-test"], images: { autoResize: false },
  }));
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { createPiSessionHost } = await jiti.import("./pi-host.ts");
  const { getRpcSession, startRpcSession } = await jiti.import("../../lib/rpc-manager.ts");
  const { buildSessionContext } = await jiti.import("../../lib/session-reader.ts");
  const { IM_MESSAGE_SOURCE_TYPE } = await jiti.import("./message-data.ts");
  const host = createPiSessionHost();
  const id = await host.create(directory, "test");
  const wrapper = getRpcSession(id);
  t.after(() => wrapper.shutdown());
  const liveUsers = [];
  t.after(wrapper.onEvent((event) => {
    if (event.type === "message_end" && event.message?.role === "user") liveUsers.push(event.message);
  }));
  assert.equal(await host.exists(id, directory), true);
  assert.ok((await host.list(directory)).some((session) => session.id === id));
  await wrapper.send({ type: "prompt", message: "web-first" });
  await until(() => typeof finishWeb === "function");
  const telegram = { channel: "telegram", botId: "tg", botName: "private IM bot", chatId: "-100123", threadId: "7", isGroup: true, senderId: "42", messageId: "101" };
  const answer = host.prompt(id, "im-second", new AbortController().signal, telegram);
  assert.equal(requests.length, 1);
  finishWeb();
  assert.equal(await answer, "IM RESULT");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /im-second/);
  assert.equal(requestContext(requests[0]), undefined);
  assert.deepEqual(requestContext(requests[1]), { channel: "telegram", conversation: "topic", replyCapabilities: { text: true, attachments: false } });
  assert.equal(requests[1].messages.filter((message) => message.role === "user").at(-1).content.includes("附件交付约定"), false);
  assert.equal(wrapper.inner.messages.filter((message) => message.role === "user").length, 2);
  const answers = wrapper.inner.messages.filter((message) => message.role === "assistant");
  assert.equal(answers.length, 2);
  assert.equal(answers[0].content[0].text, "WEB RESULT");
  assert.equal(answers[1].content[0].text, "IM RESULT");
  assert.equal(liveUsers[0].imSource, undefined);
  assert.equal(liveUsers[1].imSource.channel, "telegram");
  assert.equal(liveUsers[1].imSource.threadId, "7");
  assert.equal(liveUsers[1].content[0].text, "im-second");
  assert.ok(!JSON.stringify(requests[1].messages).includes(telegram.botName), "route metadata stays out of provider messages");

  const weixin = { ...telegram, channel: "weixin", botId: "wx", chatId: "wx-user", threadId: undefined, isGroup: false, messageId: "102" };
  assert.deepEqual(await host.prompt(id, "im-second", new AbortController().signal, weixin, undefined, { attachments: true }), { text: "IM RESULT" });
  assert.deepEqual(requestContext(requests[2]), { channel: "weixin", conversation: "private", replyCapabilities: { text: true, attachments: true } });
  assert.equal(liveUsers[2].content[0].text, "im-second", "Web user text has no injected delivery instructions");
  assert.equal(liveUsers[2].imSource.channel, "weixin");
  const entries = (await readFile(wrapper.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  const metadata = entries.filter((entry) => entry.customType === IM_MESSAGE_SOURCE_TYPE);
  assert.equal(metadata.length, 2);
  assert.notEqual(metadata[0].data.messageEntryId, metadata[1].data.messageEntryId);
  const historical = buildSessionContext(entries).messages.filter((message) => message.role === "user");
  assert.equal(historical[0].imSource, undefined);
  assert.deepEqual(historical.slice(1).map((message) => message.imSource.channel), ["telegram", "weixin"]);
  assert.ok(historical.slice(1).every((message) => message.content[0].text.startsWith("im-second")));
  assert.ok(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")
    .every((entry) => entry.message.imSource === undefined), "only the projection has UI fields");

  const mediaDirectory = await mkdtemp(join(tmpdir(), "pi-im-sdk-media-"));
  t.after(() => rm(mediaDirectory, { recursive: true, force: true }));
  const imagePath = join(mediaDirectory, "图 (1).png");
  const filePath = join(mediaDirectory, "report (1).txt");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await writeFile(imagePath, Buffer.from(data, "base64"));
  await writeFile(filePath, "attachment-only sentinel body");
  mediaAnswer = `READY\n\n[report](<${encodeURI(filePath)}>)\n\n![image](<${encodeURI(imagePath)}>)`;
  const delivery = await host.prompt(id, "inspect incoming files", new AbortController().signal,
    { ...weixin, messageId: "103" }, [
      { type: "image", path: imagePath, name: "图 (1).png", mimeType: "image/png" },
      { type: "file", path: filePath, name: "report (1).txt", mimeType: "text/plain" },
    ], { attachments: true });
  assert.deepEqual(delivery.attachments.map((attachment) => attachment.path), [filePath, imagePath]);
  assert.ok(!delivery.text.includes(mediaDirectory));
  assert.equal(wrapper.inner.messages.filter((message) => message.role === "assistant").at(-1).content[0].text, mediaAnswer,
    "Web keeps the original assistant Markdown");
  const modelImages = requests.at(-1).messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === "image_url");
  assert.ok(modelImages.some((image) => image.image_url.url === `data:image/png;base64,${data}`), "original image bytes reach the model");
  assert.ok(!JSON.stringify(requests.at(-1).messages).includes("attachment-only sentinel body"));
  const refreshedEntries = (await readFile(wrapper.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  const mediaMeta = refreshedEntries.filter((entry) => entry.customType === IM_MESSAGE_SOURCE_TYPE);
  assert.equal(mediaMeta.length, 3);
  assert.ok(!JSON.stringify(mediaMeta).includes(data));
  assert.ok(!JSON.stringify(mediaMeta).includes(mediaDirectory));
  const refreshed = buildSessionContext(refreshedEntries).messages.filter((message) => message.role === "user").at(-1);
  assert.equal(refreshed.imSource.messageId, "103");
  assert.ok(refreshed.content.some((block) => block.type === "image" && block.data === data));
  const { isFilePathReferencedByEntries } = await jiti.import("../../lib/session-file-references-core.ts");
  assert.equal(isFilePathReferencedByEntries(imagePath, refreshedEntries), true);
  assert.equal(isFilePathReferencedByEntries(filePath, refreshedEntries), true);
  assert.ok(!JSON.stringify(refreshedEntries.filter((entry) => entry.type === "message")).includes("<im_request_context>"),
    "request-only instructions are not recorded as user or system history");
  await wrapper.send({ type: "prompt", message: "web-after-im" });
  await until(() => requests.length === 5 && !wrapper.isRunning());
  assert.equal(requestContext(requests[4]), undefined, "a later Web request does not inherit the IM context");

  const chatOnly = await startRpcSession("__new__im-context-chat-only", "", directory, { toolNames: [] });
  t.after(() => chatOnly.session.shutdown());
  await host.prompt(chatOnly.realSessionId, "chat-only IM", new AbortController().signal, weixin, undefined, { attachments: true });
  assert.deepEqual(requestContext(requests[5]), { channel: "weixin", conversation: "private", replyCapabilities: { text: true, attachments: true } });
  assert.equal(requests[5].tools?.length ?? 0, 0, "the IM context does not enable tools in Chat-only");
  await chatOnly.session.send({ type: "prompt", message: "chat-only Web" });
  await until(() => requests.length === 7 && !chatOnly.session.isRunning());
  assert.equal(requestContext(requests[6]), undefined, "Chat-only restores its original exact prompt for Web");
});
