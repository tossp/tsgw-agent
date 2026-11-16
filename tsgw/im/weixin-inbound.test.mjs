import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { prepareWeixinInput, weixinInputText } = await createJiti(import.meta.url).import("./weixin-inbound.ts");
const message = { id: "1", chatId: "owner", senderId: "owner", text: "正文", isGroup: false };
const text = (value) => ({ type: 1, text_item: { text: value } });
const signal = () => new AbortController().signal;
const unexpected = async () => assert.fail("unexpected download");

test("voice transcripts are current input while quote text cannot become a chat command", async () => {
  const items = [text("分析附件"), { type: 3, voice_item: { text: "这是语音" } }, {
    ...text("继续"), ref_msg: { message_item: text("/stop"), title: "先前的消息" },
  }];
  const current = weixinInputText(items);
  assert.equal(current, "分析附件\n[语音转写]\n这是语音\n继续");
  const prepared = await prepareWeixinInput({ ...message, text: current }, items, unexpected, signal(), "wx");
  assert.equal(prepared.text, current);
  assert.equal(prepared.quotedText, "先前的消息\n/stop");
  assert.equal(prepared.attachments, undefined);
});

test("image and file attachments preserve platform order and permit messages with no text", async () => {
  const items = [{ type: 2, image_item: {} }, { type: 4, file_item: { file_name: "a.pdf" } }];
  const types = [];
  const prepared = await prepareWeixinInput({ ...message, text: "" }, items, async (item) => {
    types.push(item.type);
    return item.type === 2
      ? { type: "image", path: "/media/a.png", name: "a.png", mimeType: "image/png" }
      : { type: "file", path: "/media/a.pdf", name: "a.pdf", mimeType: "application/pdf" };
  }, signal(), "wx");
  assert.deepEqual(types, [2, 4]);
  assert.equal(prepared.text, "");
  assert.deepEqual(prepared.attachments.map((item) => item.type), ["image", "file"]);
  assert.equal(prepared.preparationError, undefined);
});

test("quotes retain inline text, media summaries and lossless ID-only references without inventing content", async () => {
  const items = [
    { ...text("a"), ref_msg: { message_item: text("原文"), title: "原文", partial_text: {} } },
    { ...text("b"), ref_msg: { message_item: { type: 2 } } },
    { ...text("c"), ref_msg: { message_item: { type: 4, file_item: { file_name: "旧报告.pdf" } } } },
    { ...text("d"), ref_msg: { svr_id: "9223372036854775809" } },
    { ...text("e"), ref_msg: { title: "引用摘要" } },
    { ...text("f"), ref_msg: { message_item: text("原文") } },
  ];
  const result = await prepareWeixinInput(message, items, unexpected, signal(), "wx");
  assert.equal(result.quotedText.split("\n\n").filter((value) => value === "原文").length, 1);
  assert.match(result.quotedText, /引用图片/);
  assert.match(result.quotedText, /旧报告.pdf/);
  assert.match(result.quotedText, /9223372036854775809；平台未提供原文/);
  assert.match(result.quotedText, /引用摘要/);
});

test("missing voice transcripts and unsupported videos produce an explicit notice without model input", async () => {
  for (const item of [{ type: 3, voice_item: {} }, { type: 5, video_item: {} }]) {
    const result = await prepareWeixinInput({ ...message, text: "" }, [item], unexpected, signal(), "wx");
    assert.ok(result.preparationError);
    assert.equal(result.attachments, undefined);
  }
});

test("a failed download does not submit partial attachment data or external errors", async () => {
  let downloads = 0;
  const result = await prepareWeixinInput(message, [{ type: 2 }, { type: 4 }], async () => {
    if (++downloads === 1) return { type: "image", path: "/media/a.png", name: "a.png", mimeType: "image/png" };
    throw new Error("secret-url private-aes-key");
  }, signal(), "wx");
  assert.equal(result.attachments, undefined);
  assert.match(result.preparationError, /下载或解密失败/);
  assert.doesNotMatch(JSON.stringify(result), /secret-url|private-aes-key/);
});

test("cancellation rejects preparation rather than producing a failure reply", async () => {
  const controller = new AbortController();
  await assert.rejects(prepareWeixinInput(message, [{ type: 2 }], async () => {
    controller.abort();
    throw new Error("stopped download");
  }, controller.signal, "wx"), { name: "AbortError" });
  await assert.rejects(prepareWeixinInput(message, [], unexpected, controller.signal, "wx"), { name: "AbortError" });
});
