import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const root = fileURLToPath(new URL("../../", import.meta.url));

// Use Next's existing bundler, React and Playwright to mount the production
// MessageView, including the fork's relocated user view. No Next server, model,
// user sessions, .next output, or mocked component/hooks are involved.
async function componentPage(t) {
  const directory = await mkdtemp(join(tmpdir(), "user-message-interactions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.tsx");
  const loader = join(directory, "typescript-loader.cjs");
  await writeFile(loader, `const ts = require(${JSON.stringify(require.resolve("typescript"))});
module.exports = function(source) {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
  }, fileName: this.resourcePath }).outputText;
};`);
  await writeFile(entry, `import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MessageView } from "@/components/MessageView";
import { I18nProvider } from "@/hooks/useI18n";
const root = createRoot(document.getElementById("root"));
let version = 0;
window.forks = [];
window.edits = [];
window.mount = (message, props = {}) => {
  window.message = message;
  flushSync(() => root.render(<I18nProvider><MessageView key={++version}
    message={message} entryId="user-entry"
    onFork={(...args) => window.forks.push(args)}
    onEditContent={(...args) => window.edits.push(args)} {...props}
  /></I18nProvider>));
};`);
  const compiler = webpack({
    mode: "development", target: "web", devtool: false,
    context: root, entry,
    output: { path: directory, filename: "browser.js", publicPath: "/" },
    resolve: {
      alias: { "@": root },
      modules: [join(root, "node_modules"), "node_modules"],
      extensions: [".tsx", ".ts", ".js", ".mjs", ".json"],
    },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }] },
  });
  await new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error ?? closeError);
        if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve();
      });
    });
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://user-message.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script src="/browser.js"></script></body></html>' });
    }
    if (/^\/[\w.-]+\.js$/.test(path)) {
      return route.fulfill({ contentType: "application/javascript; charset=utf-8", body: await readFile(join(directory, path.slice(1)), "utf8") });
    }
    return route.abort();
  });
  await page.goto("https://user-message.test/");
  await page.waitForFunction(() => typeof window.mount === "function");
  return { page, errors };
}

const forkTitle = "New session — creates an independent copy from here";
const editTitle = "Edit from here — branches within this session";
const skill = '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nReview **these files**.\n</skill>\n\nsrc/main.ts';
const image = { type: "image", source: { type: "url", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" } };

async function mount(page, message, props = {}) {
  await page.evaluate(({ message, props }) => window.mount(message, props), { message, props });
  await page.getByTitle("Copy message", { exact: true }).waitFor().catch(async (error) => {
    throw new Error(`${error.message}\nRendered DOM: ${await page.locator("#root").innerHTML()}`);
  });
  await page.getByTitle("Copy message", { exact: true }).focus();
}

test("real message buttons preserve v16 fork drafts and handle refused copies", { timeout: 120_000 }, async (t) => {
  const { page, errors } = await componentPage(t);
  await t.test("New session passes the original ordinary/image-only message or restored skill command with attachments", async () => {
    for (const content of ["plain message\r\nkeeps stored text", [image], [{ type: "text", text: skill }, image]]) {
      const message = { role: "user", content, timestamp: 42 };
      await mount(page, message);
      // Source must not change the fork/edit target of an expanded skill.
      if (Array.isArray(content) && content[0]?.type === "text") {
        await page.getByTitle("Expand", { exact: true }).click();
        await page.getByRole("button", { name: "Source", exact: true }).click();
      }
      await page.getByTitle(forkTitle, { exact: true }).click();
      await page.getByTitle(editTitle, { exact: true }).click();
      const state = await page.evaluate(() => ({ fork: window.forks.at(-1), edit: window.edits.at(-1), message: window.message }));
      const expected = content[0]?.type === "text"
        ? { ...message, content: [{ type: "text", text: "/skill:review src/main.ts" }, image] }
        : message;
      assert.deepEqual(state.fork, ["user-entry", expected]);
      assert.deepEqual(state.edit, [expected, "user-entry"]);
      assert.deepEqual(state.message, message, "the stored message is not rewritten");
    }
    await mount(page, { role: "user", content: "fork in progress" }, { forking: true });
    assert.equal(await page.getByTitle("Creating new session…", { exact: true }).isDisabled(), true);
  });
  await t.test("clipboard rejection and fallback refusal stay silent; success alone says Copied", async () => {
    await mount(page, { role: "user", content: skill });
    await page.evaluate(() => {
      window.copies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: (text) => { window.copies.push(text); return Promise.reject(new Error("denied clipboard")); },
      } });
    });
    const copy = page.getByTitle("Copy message", { exact: true });
    await copy.click();
    await page.waitForTimeout(30);
    assert.equal(await copy.textContent(), "Copy");
    assert.deepEqual(await page.evaluate(() => window.copies), ["/skill:review src/main.ts"]);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      document.execCommand = () => false;
    });
    await copy.click();
    await page.waitForTimeout(30);
    assert.equal(await copy.textContent(), "Copy");
    assert.equal(await page.locator("textarea").count(), 0, "fallback copy cleans up its temporary field");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
    });
    await copy.click();
    await page.waitForFunction(() => document.querySelector('button[title="Copy message"]')?.textContent === "Copied");
  });
  await t.test("Source/Render preserves literal HTML, skill expansion and the large-content guard", async () => {
    const literal = '<div>${value} &copy;</div>\r\n**bold**';
    await mount(page, { role: "user", content: literal });
    assert.ok((await page.locator("#root").textContent()).includes('<div>${value} &copy;</div>'));
    await page.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await page.locator(".user-message-source").textContent(), literal.replace(/\r\n?/g, "\n"));
    await page.getByRole("button", { name: "Render", exact: true }).click();
    assert.equal(await page.locator(".user-message-source").count(), 0);
    await mount(page, { role: "user", content: skill });
    await page.getByTitle("Expand", { exact: true }).click();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await page.locator(".user-message-source").textContent(), skill);
    await page.getByRole("button", { name: "Render", exact: true }).click();
    assert.equal(await page.getByTitle("Collapse", { exact: true }).getAttribute("aria-expanded"), "true");
    const huge = "x".repeat(100_001);
    for (const content of [huge, skill.replace("Review **these files**.", huge)]) {
      await mount(page, { role: "user", content });
      if (content !== huge) await page.getByTitle("Expand", { exact: true }).click();
      await page.getByRole("button", { name: /markdown rendering is disabled/ }).waitFor();
      await page.getByRole("button", { name: "Source", exact: true }).click();
      assert.equal(await page.locator(".user-message-source").textContent(), content);
      await page.getByRole("button", { name: "Render", exact: true }).click();
      await page.getByRole("button", { name: /markdown rendering is disabled/ }).waitFor();
    }
  });
  assert.deepEqual(errors, [], "real clicks must not produce unhandled promise rejections or page errors");
});
