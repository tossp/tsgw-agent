import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createJiti } from "jiti";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createElement: h } = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { MessageView } = await jiti.import("../../components/MessageView.tsx");

const source = {
  requestId: "request", channel: "weixin", botId: "bot", botName: 'Bot <script>alert("name")</script> & friends',
  chatId: "chat", senderId: "sender", messageId: "message",
};
const content = '<textarea>message & text</textarea>';
const noop = () => {};
function renderMessage(imSource) {
  return renderToStaticMarkup(h(I18nProvider, null, h(MessageView, {
    message: { role: "user", content, timestamp: 1, ...(imSource ? { imSource } : {}) },
    entryId: "entry", onFork: noop, onEditContent: noop,
  })));
}

function assertUserControls(html) {
  for (const title of ["Copy message", "Edit from here — branches within this session", "New session — creates an independent copy from here"]) {
    assert.ok(html.includes(`title="${title}"`), title);
  }
  assert.match(html, /&lt;textarea&gt;message &amp; text&lt;\/textarea&gt;/);
  assert.doesNotMatch(html, /<textarea>|<script>/);
}

test("ordinary Web user messages retain their controls without an IM badge", () => {
  const html = renderMessage();
  assert.doesNotMatch(html, /WeChat|Telegram|class="badge"/);
  assertUserControls(html);
});

for (const [channel, label] of [["weixin", "WeChat"], ["telegram", "Telegram"]]) {
  test(`${label} user messages render an icon and label with an escaped bot tooltip`, () => {
    const html = renderMessage({ ...source, channel });
    assert.match(html, /class="badge" title="Bot &lt;script&gt;alert\(&quot;name&quot;\)&lt;\/script&gt; &amp; friends"/);
    assert.ok(html.includes(`<span>${label}</span>`));
    assert.match(html, /<svg[^>]*width="13"[^>]*aria-hidden="true"/);
    assert.equal((html.match(/class="badge"/g) ?? []).length, 1);
    assertUserControls(html);
  });
}
