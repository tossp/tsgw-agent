import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { preparePiAttachments } = await jiti.import("./pi-media.ts");
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
  const entries = [{ type: "custom_message", content: prepared.links }];
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
