import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createWeixinDriver } = await jiti.import("./weixin.ts");
const { ImRuntime } = await jiti.import("./runtime.ts");
const { ImStore } = await jiti.import("./store.ts");
const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXYAAAAASUVORK5CYII=", "base64");
const document = Buffer.from("微信文件测试：原始字节保持不变\n");
const encrypt = (bytes) => { const c = createCipheriv("aes-128-ecb", key, null); return Buffer.concat([c.update(bytes), c.final()]); };
const json = (value) => new Response(JSON.stringify(value));
const owner = "owner@im.wechat";
const incoming = {
  message_id: "9223372036854775809", from_user_id: owner, to_user_id: "bot@im.bot", message_type: 1,
  context_token: "private-context", item_list: [
    { type: 1, text_item: { text: "分析并回传" }, ref_msg: { message_item: { type: 1, text_item: { text: "此前的要求" } } } },
    { type: 2, image_item: { aeskey: key.toString("hex"), media: { encrypt_query_param: "private-image-ticket" } } },
    { type: 4, file_item: { file_name: "图文资料.txt", media: { encrypt_query_param: "private-file-ticket", aes_key: key.toString("base64") } } },
    { type: 3, voice_item: { text: "语音补充要求" } },
  ],
};
function blocked(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
async function until(check) {
  const end = Date.now() + 3500;
  while (!check()) { if (Date.now() > end) assert.fail("IM pipeline did not settle"); await delay(5); }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-weixin-media-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ImStore.open(join(directory, "state.json"));
  const bot = { id: "wx", channel: "weixin", name: "WX", cwd: directory, enabled: true, allowedUserIds: [], allowedChatIds: [],
    credentials: { token: "private-token", accountId: "bot@im.bot", ownerUserId: owner, baseUrl: "https://ilinkai.weixin.qq.com/" } };
  await store.update((state) => state.bots.push(bot));
  const prompts = [], sent = [], uploads = [], calls = [], stopped = [];
  let polls = 0, pushUpdate, uploadSignal, sending;
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, headers: new Headers(init.headers) });
    if (url.pathname.endsWith("getupdates")) {
      if (++polls === 1) return json({ msgs: [incoming], get_updates_buf: "first-cursor" });
      if (polls === 2) return new Promise((resolve, reject) => {
        pushUpdate = (message) => resolve(json({ msgs: [message], get_updates_buf: "second-cursor" }));
        init.signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
      });
      return blocked(init.signal);
    }
    if (url.hostname.endsWith("cdn.weixin.qq.com")) {
      assert.equal(new Headers(init.headers).get("authorization"), null);
      assert.equal(init.redirect, "error");
      if (init.method === "GET") {
        const ticket = url.searchParams.get("encrypted_query_param");
        return new Response(encrypt(ticket === "private-image-ticket" ? image : document));
      }
      uploadSignal = init.signal;
      if (options.blockUpload) return blocked(init.signal);
      uploads.at(-1).encrypted = Buffer.from(init.body);
      return new Response(null, { headers: { "x-encrypted-param": `download-${uploads.length}` } });
    }
    const body = JSON.parse(init.body);
    if (url.pathname.endsWith("getconfig")) return json({ typing_ticket: "private-typing-ticket" });
    if (url.pathname.endsWith("sendtyping")) return new Response(null);
    if (url.pathname.endsWith("getuploadurl")) { uploads.push(body); return json({ upload_param: `upload-${uploads.length}` }); }
    if (url.pathname.endsWith("sendmessage")) { sent.push(body.msg); return json({ ret: 0 }); }
    throw new Error("unexpected endpoint");
  };
  const host = {
    async list() { return []; }, async exists(id) { return id === "session"; }, async create() { return "session"; },
    async stop(id) { stopped.push(id); sending?.abort(); },
    async notify(handle, _cwd, input) {
      prompts.push({ handle, ...input });
      sending = new AbortController();
      const completion = (async () => {
        for (const attachment of input.attachments) assert.deepEqual(await readFile(attachment.path), attachment.type === "image" ? image : document);
        const items = [{ type: "text", text: "已完成" }, ...input.attachments.map(({ type, path }) => ({ type, path }))];
        await runtime.send(directory, { handle }, items, sending.signal);
      })();
      return { completion };
    },
  };
  const runtime = new ImRuntime(store, host, (config) => createWeixinDriver({ ...config, fetchImpl, mediaDirectory: join(directory, "media") }));
  t.after(() => runtime.stop());
  await runtime.start();
  return { runtime, directory, prompts, sent, uploads, calls, stopped, getUploadSignal: () => uploadSignal,
    push: (message) => pushUpdate(message) };
}

test("real runtime and Weixin driver decrypt inbound media, retain quote/transcript and send explicit tool attachments to the same chat", async (t) => {
  const f = await fixture(t);
  await until(() => f.sent.length === 3);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].id, incoming.message_id);
  assert.equal(f.prompts[0].handle.chatId, owner);
  assert.match(f.prompts[0].text, /语音补充要求/);
  assert.match(f.prompts[0].quotedText, /此前的要求/);
  assert.deepEqual(f.prompts[0].attachments.map((item) => item.type), ["image", "file"]);
  assert.deepEqual(f.sent.map((message) => message.item_list[0].type), [1, 2, 4]);
  assert.ok(f.sent.every((message) => message.to_user_id === owner && message.context_token === "private-context"));
  assert.doesNotMatch(f.sent[0].item_list[0].text_item.text, /pi-weixin-media-integration|\/media\//);
  assert.equal(new Set(f.sent.map((message) => message.client_id)).size, 3);
  for (let index = 0; index < 2; index++) {
    const upload = f.uploads[index];
    const plain = index === 0 ? image : document;
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
    assert.deepEqual(Buffer.concat([decipher.update(upload.encrypted), decipher.final()]), plain);
    assert.equal(upload.rawsize, plain.length);
    assert.equal(upload.filesize, upload.encrypted.length);
    assert.equal(upload.media_type, index === 0 ? 1 : 3);
  }
  assert.equal(f.sent[2].item_list[0].file_item.file_name, "图文资料.txt");
  assert.equal(f.sent[2].item_list[0].file_item.len, String(document.length));
  const persisted = await readFile(join(f.directory, "state.json"), "utf8");
  assert.doesNotMatch(persisted, /private-image-ticket|private-file-ticket|private-typing-ticket|0011223344556677/);
  assert.equal((await f.runtime.snapshot()).bots[0].status.state, "connected");
});

test("a Stop received while CDN upload is pending aborts the upload and prevents a late attachment send", async (t) => {
  const f = await fixture(t, { blockUpload: true });
  await until(() => f.getUploadSignal());
  f.push({ ...incoming, message_id: "stop", item_list: [{ type: 1, text_item: { text: "/stop" } }] });
  await until(() => f.stopped.length === 1 && f.sent.length === 2);
  assert.ok(f.getUploadSignal().aborted);
  assert.equal(f.sent.filter((message) => message.item_list[0].type !== 1).length, 0);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal((await f.runtime.snapshot()).bots[0].status.state, "connected");
});
