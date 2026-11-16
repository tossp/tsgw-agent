import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Sentry from "@sentry/nextjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { downloadWeixinAttachment: download, uploadWeixinAttachment: upload } = await jiti.import("./weixin-media.ts");
const { MAX_ATTACHED_IMAGE_BYTES: IMAGE_LIMIT } = await jiti.import("../../lib/image-attachments.ts");
const { WEIXIN_BASE_INFO } = await jiti.import("./weixin-transport.ts");
const { getAgentTracingOptions } = await jiti.import("../agent-tracing/policy.ts");
const envelopes = [];
// Install the real async scope strategy before any suppressed or deliberately stalled fetch.
Sentry.init({
  dsn: "https://public@telemetry.invalid/10", ...getAgentTracingOptions(),
  tracePropagationTargets: [], beforeSendLog: () => null, beforeSendMetric: () => null,
  transport: () => ({ send(envelope) { envelopes.push(envelope); return Promise.resolve({ statusCode: 200 }); }, flush: () => Promise.resolve(true) }),
});
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
const bot = {
  id: "test-bot", channel: "weixin", name: "test", cwd: "/tmp", enabled: true,
  allowedUserIds: [], allowedChatIds: [],
  credentials: { token: "private-bot-token", baseUrl: "https://ilinkai.weixin.qq.com/", accountId: "bot", ownerUserId: "owner" },
};
const message = { id: "m1", chatId: "recipient", senderId: "owner", text: "", isGroup: false };
const capability = "private-capability&ticket=private-ticket";
const cdn = "https://novac2c.cdn.weixin.qq.com/c2c";
const safeFailure = (error) => {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(String(error), /private|https:|token|ticket|BODY|ENOENT|secret-name/);
  return true;
};
function encrypt(bytes, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function decrypt(bytes, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}
function item(type, media, extra = {}) {
  return { type, [type === 2 ? "image_item" : "file_item"]: { media, ...extra } };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "weixin-media-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function options(directory, fetchImpl, signal = new AbortController().signal) {
  return { bot, fetchImpl, signal, mediaDirectory: directory };
}
async function localAttachment(t, type = "file", bytes = Buffer.from("file BODY"), name = "原始 文件.txt") {
  const directory = await fixture(t);
  const path = join(directory, "source");
  await writeFile(path, bytes);
  return { type, path, name, mimeType: type === "image" ? "image/png" : "text/plain" };
}

test("encrypted images accept bare hex first and both base64 key encodings; plaintext is allowed", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  const variants = [
    { media: { aes_key: "intentionally invalid" }, extra: { aeskey: key.toString("hex") }, bytes: encrypt(png, key) },
    { media: { aes_key: key.toString("base64") }, bytes: encrypt(png, key) },
    { media: { aes_key: Buffer.from(key.toString("hex")).toString("base64") }, bytes: encrypt(png, key) },
    { media: {}, bytes: png },
  ];
  const results = [];
  for (const variant of variants) {
    const saved = await download(item(2, { encrypt_query_param: capability, ...variant.media }, variant.extra), options(directory, async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://novac2c.cdn.weixin.qq.com");
      assert.equal(url.pathname, "/c2c/download");
      assert.equal(url.searchParams.get("encrypted_query_param"), capability);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers, undefined);
      return new Response(variant.bytes);
    }));
    assert.deepEqual(await readFile(saved.path), png);
    assert.equal(saved.type, "image");
    assert.equal(saved.mimeType, "image/png");
    assert.equal(saved.name, "image.png");
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(saved.path))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, bot.id))).mode & 0o777, 0o700);
    results.push(saved.path);
  }
  assert.equal(new Set(results).size, 4);
});

test("files require keys, preserve names and MIME, isolate same-name files, and sanitize traversal/control characters", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  const bytes = Buffer.from("文件正文 BODY");
  const results = [];
  for (const encoded of [key.toString("base64"), Buffer.from(key.toString("hex")).toString("base64")]) {
    const saved = await download(item(4, { full_url: `${cdn}/download?ticket=private-ticket`, aes_key: encoded }, { file_name: "C:\\private\\..\\报告\u0000\n.txt" }), options(directory, async () => new Response(encrypt(bytes, key))));
    assert.equal(saved.name, "报告.txt");
    assert.equal(saved.mimeType, "text/plain");
    assert.deepEqual(await readFile(saved.path), bytes);
    assert.ok(saved.path.startsWith(join(directory, bot.id)));
    results.push(saved.path);
  }
  assert.notEqual(...results);
  const normal = await download(item(4, { encrypt_query_param: capability, aes_key: key.toString("base64") }, { file_name: "原始 名称.dat" }), options(directory, async () => new Response(encrypt(bytes, key))));
  assert.equal(normal.name, "原始 名称.dat");
  assert.equal(normal.mimeType, "application/octet-stream");
  for (const file_name of ["../..", "/tmp/../../", "\u0000"]) {
    const saved = await download(item(4, { encrypt_query_param: capability, aes_key: key.toString("base64") }, { file_name }), options(directory, async () => new Response(encrypt(bytes, key))));
    assert.equal(saved.name, "file.bin");
  }
  await assert.rejects(download(item(4, { encrypt_query_param: capability }), options(directory, () => assert.fail("missing key must fail before fetch"))), safeFailure);
});

test("full_url wins; arbitrary hosts, non-CDN official hosts, credentials, HTTP, IPs and unsafe redirects are rejected", async (t) => {
  const directory = await fixture(t);
  const full = `${cdn}/custom?ticket=private-ticket`;
  await download(item(2, { full_url: full, encrypt_query_param: "ignored" }), options(directory, async (input) => {
    assert.equal(String(input), full);
    return new Response(png);
  }));
  for (const full_url of [
    "http://novac2c.cdn.weixin.qq.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://example.org/x",
    "https://cdn.weixin.qq.com.evil.org/x", "https://evil-cdn.weixin.qq.com/x", "https://ilinkai.weixin.qq.com/x",
    "https://private:private@novac2c.cdn.weixin.qq.com/x", "https://novac2c.cdn.weixin.qq.com:444/x",
  ]) {
    await assert.rejects(download(item(2, { full_url }), options(directory, () => assert.fail("invalid target reached fetch"))), safeFailure);
  }
  let calls = 0;
  await assert.rejects(download(item(2, { full_url: full }), options(directory, async (_input, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    return new Response("private BODY", { status: 302, headers: { location: "https://evil.org/" } });
  })), safeFailure);
  assert.equal(calls, 1);
});

test("upload image/file fields and CDN encryption match official wire format without sending a message", async (t) => {
  for (const type of ["image", "file"]) {
    const bytes = type === "image" ? png : Buffer.from("文件 BODY");
    const attachment = await localAttachment(t, type, bytes);
    let metadata;
    let calls = 0;
    const result = await upload(attachment, message, options(undefined, async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      if (url.hostname === "ilinkai.weixin.qq.com") {
        assert.equal(url.pathname, "/ilink/bot/getuploadurl");
        assert.equal(init.headers.Authorization, `Bearer ${bot.credentials.token}`);
        assert.equal(init.headers.AuthorizationType, "ilink_bot_token");
        assert.equal(init.headers["iLink-App-Id"], "bot");
        assert.equal(init.headers["iLink-App-ClientVersion"], String((2 << 16) | (4 << 8) | 6));
        assert.match(Buffer.from(init.headers["X-WECHAT-UIN"], "base64").toString(), /^\d+$/);
        metadata = JSON.parse(init.body);
        assert.deepEqual(Object.keys(metadata).sort(), ["filekey", "media_type", "to_user_id", "rawsize", "rawfilemd5", "filesize", "no_need_thumb", "aeskey", "base_info"].sort());
        assert.equal(metadata.media_type, type === "image" ? 1 : 3);
        assert.equal(metadata.to_user_id, message.chatId);
        assert.equal(metadata.rawsize, bytes.length);
        assert.equal(metadata.rawfilemd5, createHash("md5").update(bytes).digest("hex"));
        assert.equal(metadata.filesize, (Math.floor(bytes.length / 16) + 1) * 16);
        assert.match(metadata.filekey, /^[a-f\d]{32}$/);
        assert.match(metadata.aeskey, /^[a-f\d]{32}$/);
        assert.equal(metadata.no_need_thumb, true);
        assert.deepEqual(metadata.base_info, WEIXIN_BASE_INFO);
        return Response.json({ ret: 0, upload_param: capability });
      }
      assert.equal(url.pathname, "/c2c/upload");
      assert.equal(url.searchParams.get("encrypted_query_param"), capability);
      assert.equal(url.searchParams.get("filekey"), metadata.filekey);
      assert.deepEqual(init.headers, { "Content-Type": "application/octet-stream" });
      assert.equal(init.credentials, "omit");
      assert.equal(init.body.length, metadata.filesize);
      assert.deepEqual(decrypt(Buffer.from(init.body), Buffer.from(metadata.aeskey, "hex")), bytes);
      return new Response(null, { headers: { "x-encrypted-param": "download-private-ticket" } });
    }));
    assert.equal(calls, 2);
    const part = result[type === "image" ? "image_item" : "file_item"];
    assert.deepEqual(part.media, { encrypt_query_param: "download-private-ticket", aes_key: Buffer.from(metadata.aeskey).toString("base64"), encrypt_type: 1 });
    assert.equal(result.type, type === "image" ? 2 : 4);
    if (type === "image") assert.equal(part.mid_size, metadata.filesize);
    else { assert.equal(part.file_name, attachment.name); assert.equal(part.len, String(bytes.length)); }
    // Roundtrip through the real download implementation, not a second test-only decoder.
    const directory = await fixture(t);
    const saved = await download(result, options(directory, async () => new Response(encrypt(bytes, Buffer.from(metadata.aeskey, "hex")))));
    assert.deepEqual(await readFile(saved.path), bytes);
  }
});

test("upload_full_url has priority and is restricted to official CDN", async (t) => {
  const attachment = await localAttachment(t);
  for (const full of [`${cdn}/special?ticket=private-ticket`, "https://evil.org/private-ticket"]) {
    let calls = 0;
    const pending = upload(attachment, message, options(undefined, async (input) => {
      calls++;
      if (calls === 1) return Response.json({ upload_full_url: full, upload_param: "ignored" });
      assert.equal(String(input), full);
      return new Response(null, { headers: { "x-encrypted-param": "param" } });
    }));
    if (full.startsWith(cdn)) { await pending; assert.equal(calls, 2); }
    else { await assert.rejects(pending, safeFailure); assert.equal(calls, 1); }
  }
});

test("unknown HTTP outcomes and invalid metadata/header are safe and never retried", async (t) => {
  const attachment = await localAttachment(t);
  for (const mode of ["network", 400, 500, "header", "metadata", "json"]) {
    let calls = 0;
    await assert.rejects(upload(attachment, message, options(undefined, async () => {
      calls++;
      if (calls === 1) {
        if (mode === "metadata") return Response.json({ ret: 0 });
        if (mode === "json") return new Response("private BODY");
        return Response.json({ upload_param: capability });
      }
      if (mode === "network") throw new Error("private-token https://private/BODY", { cause: new Error("private-ticket") });
      if (typeof mode === "number") return new Response("private BODY", { status: mode });
      return new Response(null);
    })), safeFailure);
    assert.equal(calls, mode === "metadata" || mode === "json" ? 1 : 2);
  }
});

test("empty/corrupt responses, invalid keys and unknown image data fail safely without partial files", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  for (const bytes of [Buffer.alloc(0), Buffer.from("private BODY"), encrypt(Buffer.alloc(0), key), Buffer.alloc(17)]) {
    await assert.rejects(download(item(2, { encrypt_query_param: capability, aes_key: key.toString("base64") }), options(directory, async () => new Response(bytes))), safeFailure);
  }
  await assert.rejects(download(item(2, { encrypt_query_param: capability }), options(directory, async () => new Response("not an image BODY"))), safeFailure);
  for (const aes_key of ["private-invalid", Buffer.from("z".repeat(32)).toString("base64"), "AA=="]) {
    await assert.rejects(download(item(4, { encrypt_query_param: capability, aes_key }), options(directory, () => assert.fail("invalid key reached fetch"))), safeFailure);
  }
  await assert.rejects(download(item(2, {}), options(directory, () => assert.fail("empty metadata reached fetch"))), safeFailure);
  await assert.rejects(download(item(2, { encrypt_query_param: capability }), options(directory, async () => new Response("private BODY", { status: 500 }))), safeFailure);
  assert.deepEqual(await readdir(directory), []);
});

test("streaming/encrypted image limits and client file limit reject before storage or upload", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  const large = Buffer.alloc(IMAGE_LIMIT + 1);
  for (const encrypted of [false, true]) {
    const bytes = encrypted ? encrypt(large, key) : large;
    await assert.rejects(download(item(2, { encrypt_query_param: capability, ...(encrypted ? { aes_key: key.toString("base64") } : {}) }), options(directory, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 200)); controller.enqueue(bytes.subarray(200)); controller.close(); },
    })))), /客户端大小上限/);
  }
  await assert.rejects(download(item(4, { encrypt_query_param: capability, aes_key: key.toString("base64") }), options(directory, async () => new Response("small", { headers: { "content-length": String(100 * 1024 * 1024 + 17) } }))), /客户端大小上限/);
  const attachment = await localAttachment(t);
  await truncate(attachment.path, 100 * 1024 * 1024 + 1);
  await assert.rejects(upload(attachment, message, options(undefined, () => assert.fail("oversize file reached fetch"))), /客户端大小上限/);
  assert.deepEqual(await readdir(directory), []);
});

test("upload refuses directories, missing files and empty images", { timeout: 2000 }, async (t) => {
  const directory = await fixture(t);
  for (const path of [directory, join(directory, "secret-name-missing")]) {
    await assert.rejects(upload({ type: "file", path, name: "secret-name", mimeType: "text/plain" }, message, options(undefined, () => assert.fail("invalid file reached fetch"))), safeFailure);
  }
  const emptyImage = await localAttachment(t, "image", Buffer.alloc(0), "empty.png");
  await assert.rejects(upload(emptyImage, message, options(undefined, () => assert.fail("empty image reached fetch"))), safeFailure);
});

test("empty ordinary files roundtrip through a full PKCS7 block with zero plaintext length", async (t) => {
  const attachment = await localAttachment(t, "file", Buffer.alloc(0), "empty.txt");
  let metadata, encrypted;
  const result = await upload(attachment, message, options(undefined, async (_input, init) => {
    if (!metadata) {
      metadata = JSON.parse(init.body);
      assert.equal(metadata.rawsize, 0);
      assert.equal(metadata.filesize, 16);
      assert.equal(metadata.rawfilemd5, createHash("md5").update(Buffer.alloc(0)).digest("hex"));
      return Response.json({ upload_param: capability });
    }
    encrypted = Buffer.from(init.body);
    assert.equal(encrypted.length, 16);
    return new Response(null, { headers: { "x-encrypted-param": "empty-download" } });
  }));
  assert.equal(result.file_item.len, "0");
  assert.equal(result.file_item.file_name, "empty.txt");
  const directory = await fixture(t);
  const downloaded = await download(result, options(directory, async () => new Response(encrypted)));
  assert.equal((await stat(downloaded.path)).size, 0);
  assert.deepEqual(await readFile(downloaded.path), Buffer.alloc(0));
});

test("upload allows a symlink pointing to an ordinary file", async (t) => {
  const attachment = await localAttachment(t);
  const link = join(dirname(attachment.path), "linked-file");
  await symlink(attachment.path, link);
  let calls = 0;
  const result = await upload({ ...attachment, path: link }, message, options(undefined, async () => {
    calls++;
    return calls === 1 ? Response.json({ upload_param: capability }) : new Response(null, { headers: { "x-encrypted-param": "param" } });
  }));
  assert.equal(calls, 2);
  assert.equal(result.file_item.file_name, attachment.name);
});

test("abort before/during fetch, body and upload drops unsafe reasons; stalled operations time out", async (t) => {
  const directory = await fixture(t);
  const controller = new AbortController();
  controller.abort("private-token");
  await assert.rejects(download(item(2, { encrypt_query_param: capability }), options(directory, () => assert.fail("pre-aborted fetch"), controller.signal)), (error) => safeFailure(error) && error.name === "AbortError");
  for (const phase of ["fetch", "body", "upload"]) {
    const pendingAbort = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const fetchImpl = async (input) => {
      if (phase === "upload" && String(input).includes("getuploadurl")) return Response.json({ upload_param: capability });
      started();
      if (phase === "body") return new Response(new ReadableStream({ start() {} }));
      return new Promise(() => {}); // Deliberately ignore AbortSignal.
    };
    const pending = phase === "upload"
      ? upload(await localAttachment(t), message, options(undefined, fetchImpl, pendingAbort.signal))
      : download(item(2, { encrypt_query_param: capability }), options(directory, fetchImpl, pendingAbort.signal));
    const rejected = assert.rejects(pending, (error) => safeFailure(error) && error.name === "AbortError");
    await ready;
    pendingAbort.abort(new Error("private-ticket BODY"));
    await rejected;
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = download(item(2, { encrypt_query_param: capability }), options(directory, () => new Promise(() => {})));
  const rejected = assert.rejects(stalled, (error) => safeFailure(error) && error.code === "timeout");
  t.mock.timers.tick(60_001);
  await rejected;
  t.mock.timers.reset();
  assert.deepEqual(await readdir(directory), []);
});

test("parallel same-name downloads remain distinct, unsafe suffixes stay generic, and failed writes clean only their directory", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  const bytes = Buffer.from("persistent BODY");
  const media = { encrypt_query_param: capability, aes_key: key.toString("base64") };
  const saved = await Promise.all(Array.from({ length: 3 }, () => download(item(4, media, { file_name: "same.constructor" }), options(directory, async () => new Response(encrypt(bytes, key))))));
  assert.equal(new Set(saved.map((attachment) => attachment.path)).size, 3);
  assert.ok(saved.every((attachment) => attachment.mimeType === "application/octet-stream"));
  await assert.rejects(download(item(4, media, { file_name: "x".repeat(300) }), options(directory, async () => new Response(encrypt(bytes, key)))), safeFailure);
  assert.equal((await readdir(join(directory, bot.id))).length, 3);
  for (const attachment of saved) assert.deepEqual(await readFile(attachment.path), bytes);
});

test("an exactly 10 MiB image is allowed including the additional encrypted padding block", async (t) => {
  const directory = await fixture(t);
  const key = randomBytes(16);
  const bytes = Buffer.alloc(IMAGE_LIMIT);
  png.copy(bytes);
  const encrypted = encrypt(bytes, key);
  assert.equal(encrypted.length, IMAGE_LIMIT + 16);
  const saved = await download(item(2, { encrypt_query_param: capability, aes_key: key.toString("base64") }), options(directory, async () => new Response(encrypted)));
  assert.equal((await stat(saved.path)).size, IMAGE_LIMIT);
});

function events(envelopes) {
  return envelopes.flatMap(([, items]) => items.flatMap(([header, payload]) => header.type === "event" ? [payload] : []));
}

test("native Sentry suppression isolates CDN capability URLs, AES keys and API tokens; ordinary HTTP stays visible", { timeout: 15_000 }, async (t) => {
  t.after(() => Sentry.close(1000));
  let metadata;
  const uploadTicket = `upload-${randomBytes(16).toString("hex")}`;
  const downloadTicket = `download-${randomBytes(16).toString("hex")}`;
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url.includes("getuploadurl")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      metadata = JSON.parse(Buffer.concat(chunks));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ upload_full_url: `${cdn}/upload?${uploadTicket}`, upload_param: capability }));
    } else if (request.url.startsWith("/c2c/upload")) {
      request.resume();
      response.setHeader("x-encrypted-param", downloadTicket);
      response.end();
    } else { response.end(png); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const localFetch = (input, init) => { const url = new URL(String(input)); return fetch(`${base}${url.pathname}${url.search}`, init); };
  await (await fetch(`${base}/control?private-negative-control`)).text();
  Sentry.captureMessage("negative-control");
  await Sentry.flush(1000);
  assert.match(JSON.stringify(events(envelopes).find((event) => event.message === "negative-control")?.breadcrumbs), /private-negative-control/);
  Sentry.getIsolationScope().clearBreadcrumbs();
  envelopes.length = 0;

  const attachment = await localAttachment(t, "image", png);
  await upload(attachment, message, options(undefined, localFetch));
  await download(item(2, { full_url: `${cdn}/download?${downloadTicket}` }), options(await fixture(t), localFetch));
  await (await fetch(`${base}/ordinary-request`)).text();
  Sentry.captureMessage("after-media");
  await Sentry.flush(1000);
  const delivered = JSON.stringify(envelopes);
  assert.match(delivered, /ordinary-request/);
  for (const secret of [bot.credentials.token, capability, metadata.aeskey, uploadTicket, downloadTicket]) assert.ok(!delivered.includes(secret), "credential leaked into envelope");
  assert.ok(requests.some(({ url }) => url.includes(uploadTicket)));
  assert.ok(requests.some(({ url }) => url.includes(downloadTicket)));
  assert.ok(requests.filter(({ url }) => url.startsWith("/c2c/")).every(({ authorization }) => authorization === undefined));
});
