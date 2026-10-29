import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { getLocalePlugin } = await jiti.import("../lib/i18n/registry.ts");

function renderUser(content, props = {}) {
  const message = { role: "user", content };
  const before = JSON.stringify(message);
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MessageView, { message, ...props }),
  ));
  assert.equal(JSON.stringify(message), before, "display must not mutate the message");
  return html;
}

test("keeps rendered user messages as the default and adds Source after existing actions", () => {
  const html = renderUser("**Hello**\n$x + y$", {
    entryId: "user-entry",
    onFork() {},
    onEditContent() {},
  });
  assert.match(html, /<strong>Hello<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /class="user-message-source"/);
  const titles = [...html.matchAll(/<button[^>]*title="([^"]+)"/g)].map((match) => match[1]);
  const messages = getLocalePlugin("en").messages;
  assert.deepEqual(titles, [messages["i18n.copyMessage"], messages["i18n.editFromHereTitle"], messages["i18n.newSessionTitle"], "Source"]);
  assert.match(html, /<button[^>]*type="button"[^>]*title="Source"[^>]*aria-label="Source"/);
  assert.match(html, /aria-hidden="true" focusable="false"><polyline points="7 6 1 12 7 18"/);
});

test("shows user HTML as literal text by default while keeping the Source action (#1407)", () => {
  const text = '<TableOperator v-model="columns" :tableId="TABLE_ID_CONST.BUSINESS.${basic.businessModule.toUpperCase()}.Demo" :refresh="queryData" /> 后文';
  const html = renderUser(text);
  assert.match(html, /后文/);
  assert.match(html, /&lt;TableOperator v-model=&quot;columns&quot;/);
  assert.match(html, /TABLE_ID_CONST.BUSINESS/);
  assert.doesNotMatch(html, /<TableOperator\b/);
  assert.match(html, /aria-label="Source"/);
});

test("textualizes profile and div wrappers without swallowing content or disabling other Markdown", () => {
  const html = renderUser('<user-profile>\nProfile **literal** body\n</user-profile>\n\n<div class="card">HTML body</div>\n\n## Markdown heading\n\n**Markdown bold** and `inline code`');
  assert.match(html, /&lt;user-profile&gt;<br\/>Profile \*\*literal\*\* body<br\/>&lt;\/user-profile&gt;/);
  assert.match(html, /&lt;div class=&quot;card&quot;&gt;HTML body&lt;\/div&gt;/);
  assert.match(html, /<h2>Markdown heading<\/h2>/);
  assert.match(html, /<strong>Markdown bold<\/strong>/);
  assert.match(html, /<code[^>]*>inline code<\/code>/);
  assert.doesNotMatch(html, /<user-profile|<div class="card"/);
});

test("does not offer a text display switch for empty or image-only messages", () => {
  for (const content of ["", [{ type: "image", data: "YWJj", mimeType: "image/png" }]]) {
    assert.doesNotMatch(renderUser(content), /aria-label="Source"/);
  }
});

test("keeps attachments and compact skill display with its Source action", () => {
  const skill = '<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\nReview **these files**.\n</skill>\n\nsrc/main.ts';
  const html = renderUser([
    { type: "text", text: skill },
    { type: "image", data: "YWJj", mimeType: "image/png" },
  ]);
  assert.match(html, /src="data:image\/png;base64,YWJj"/);
  assert.match(html, /\/skill:review/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Source"/);
  assert.doesNotMatch(html, /Review <strong>/);
});

test("keeps the large-message guard and offers direct access to Source", () => {
  const html = renderUser("<div>" + "x".repeat(100_001) + "</div>");
  assert.match(html, /markdown rendering is disabled/);
  assert.match(html, /aria-label="Source"/);
  assert.doesNotMatch(html, /x{100}/);
});

test("labels the target view consistently in all built-in languages", () => {
  for (const [locale, source, render] of [["en", "Source", "Render"], ["zh-CN", "原文", "渲染"], ["zh-TW", "原文", "渲染"]]) {
    const messages = getLocalePlugin(locale).messages;
    assert.equal(messages["chat.messageSource"], source);
    assert.equal(messages["chat.renderMessage"], render);
  }
});
