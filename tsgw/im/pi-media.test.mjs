import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { collectImReply, preparePiAttachments } = await jiti.import("./pi-media.ts");
const { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } = await jiti.import("../../lib/image-attachments.ts");
const { isFilePathReferencedByEntries } = await jiti.import("../../lib/session-file-references-core.ts");
const { resolveLocalFileHref } = await jiti.import("../../lib/file-links.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const signal = () => new AbortController().signal;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "im-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = { type: "image", path: join(directory, "图 片(1)#%.png"), name: "图 片(1)#%.png", mimeType: "image/png" };
  const file = { type: "file", path: join(directory, "report (1).txt"), name: "report (1).txt", mimeType: "text/plain" };
  await writeFile(image.path, png);
  await writeFile(file.path, "file content stays on disk, never embedded in prompt");
  return { directory, image, file };
}

const href = (path) => encodeURI(path).replace(/[?#()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

test("inbound original images and all file links survive Markdown and session reference authorization", async (t) => {
  const { image, file } = await fixture(t);
  const prepared = await preparePiAttachments([image, file], signal());
  assert.deepEqual(prepared.images, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  assert.ok(!prepared.links.includes("base64"));
  assert.ok(!prepared.links.includes("file content stays on disk"));
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const tree = unified().use(remarkParse).parse(prepared.links);
  const links = tree.children.flatMap((node) => node.children ?? []).filter((node) => node.type === "link");
  assert.deepEqual(links.map((node) => resolveLocalFileHref(node.url)), [image.path, file.path]);
  const entries = [{ type: "message", message: { role: "user", content: prepared.links } }];
  for (const attachment of [image, file]) assert.equal(isFilePathReferencedByEntries(attachment.path, entries), true);
  assert.deepEqual(await readFile(image.path), png);
});

test("inbound validates image count, bytes, MIME/content, absolute regular files and cancellation", async (t) => {
  const { image, directory } = await fixture(t);
  await assert.rejects(preparePiAttachments(Array(MAX_ATTACHED_IMAGES + 1).fill(image), signal()), /10/);
  const large = join(directory, "large.png");
  await writeFile(large, Buffer.alloc(MAX_ATTACHED_IMAGE_BYTES + 1));
  await assert.rejects(preparePiAttachments([{ ...image, path: large }], signal()), /10MiB/);
  await assert.rejects(preparePiAttachments([{ ...image, mimeType: "image/jpeg" }], signal()), /内容/);
  await writeFile(image.path, "this is not an image");
  await assert.rejects(preparePiAttachments([image], signal()), /内容/);
  await assert.rejects(preparePiAttachments([{ ...image, path: directory }], signal()), /普通文件/);
  await assert.rejects(preparePiAttachments([{ ...image, path: "relative.png" }], signal()), /绝对路径/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preparePiAttachments([image], controller.signal), { name: "AbortError" });
  await assert.rejects(preparePiAttachments([{ ...image, path: join(directory, "missing.png") }], signal()), { code: "ENOENT" });
});

test("outbound Markdown handles temp paths, spaces, reference links, suffixes, fragments and deduplication", async (t) => {
  const { directory, image, file } = await fixture(t);
  const text = [
    `交付 ![图](<${href(image.path)}>)`,
    `[报告](<./${href(file.name)}:12#section>)`,
    `[再次][REPORT] 与 ![同图][picture]`,
    `[report]: <${href(file.path)}>`,
    `[picture]: <${href(image.path)}>`,
    "[remote](https://example.test/report.txt)",
  ].join("\n\n");
  const result = await collectImReply(text, directory, signal());
  assert.deepEqual(result.attachments.map((attachment) => attachment.path), [image.path, file.path]);
  assert.equal(result.attachments[0].type, "image");
  assert.equal(result.attachments[1].type, "file");
  assert.ok(!result.text.includes(directory));
  assert.ok(!result.text.includes(encodeURI(directory)));
  assert.match(result.text, /图片：图 片\(1\)#%\.png/);
  assert.match(result.text, /文件：report \(1\)\.txt/);
  assert.ok(result.text.includes("[remote](https://example.test/report.txt)"));
  assert.ok(!result.text.includes("[report]:"));
});

test("bare paths, code, HTML, remote URLs and unused references are never attachment deliveries", async (t) => {
  const { directory, image } = await fixture(t);
  const example = `[example](<${href(image.path)}>)`;
  const text = [
    image.path,
    `\`${example}\``,
    `\`\`\`markdown\n${example}\n\`\`\``,
    `    ${example}`,
    `[remote](https://example.test/a.png)`,
    `![remote](https://example.test/b.png)`,
    `<img src="${image.path}">`,
    `[unused]: <${href(image.path)}>`,
  ].join("\n\n");
  const result = await collectImReply(text, directory, signal());
  assert.equal(result.attachments, undefined);
  for (const preserved of [image.path, `\`${example}\``, `\`\`\`markdown\n${example}\n\`\`\``, `    ${example}`,
    "[remote](https://example.test/a.png)", `<img src="${image.path}">`]) assert.ok(result.text.includes(preserved));
  assert.ok(!result.text.includes("[unused]:"));
});

test("missing files and directory links report unavailable without exposing destinations", async (t) => {
  const { directory } = await fixture(t);
  const folder = join(directory, "folder");
  await mkdir(folder);
  const result = await collectImReply(
    `[missing](<${href(join(directory, "missing.png"))}>) [dir][d]\n\n[d]: <${href(folder)}>`, directory, signal());
  assert.equal(result.attachments, undefined);
  assert.match(result.text, /附件不可用/);
  assert.ok(!result.text.includes(directory));
});

test("a local linked image inside a remote link is replaced without breaking the remote link", async (t) => {
  const { directory, image } = await fixture(t);
  const result = await collectImReply(`[![image](<${href(image.path)}>)](https://example.test)`, directory, signal());
  assert.equal(result.attachments.length, 1);
  assert.ok(result.text.includes("https://example.test"));
  assert.ok(!result.text.includes(directory));
});

test("outbound cancellation rejects instead of returning attachments", async (t) => {
  const { directory, file } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectImReply(`[file](<${href(file.path)}>)`, directory, controller.signal), { name: "AbortError" });
});
