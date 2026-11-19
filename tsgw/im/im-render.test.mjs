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
const { ImBotDetail } = await jiti.import("./ImBotDetail.tsx");
const { ConfigDetailNavigationContext, ConfigSplitView } = await jiti.import("../../components/SettingsUi.tsx");
const { imCopy } = await jiti.import("./im-ui.ts");
const noop = () => {};

function renderImFixture(detailOpen, deliveryError) {
  const bot = { id: "bot", channel: "weixin", name: "Example bot", cwd: "/work/project",
    enabled: true, allowedUserIds: ["123"], allowedChatIds: [], status: { state: "connected" }, deliveryError };
  const conversation = { key: "conversation", botId: bot.id, chatId: "-100123", title: "Example conversation",
    sessionId: "associated-session", cwd: bot.cwd };
  return renderToStaticMarkup(h(ConfigDetailNavigationContext.Provider,
    { value: { detailOpen, openDetail: noop, closeDetail: noop, reportDetailTitle: noop } },
    h(ConfigSplitView, null, h(ImBotDetail, { bot, conversations: [conversation], copy: imCopy("en"), busy: false, act: async () => true, onRemoved: noop })),
  ));
}

test("bot details show an explicit current association and new-session choice without credentials", () => {
  const html = renderImFixture(true);
  assert.match(html, /value="associated-session" selected=""/);
  assert.match(html, /<option value="">/);
  assert.doesNotMatch(html, /type="password"|Bot Token|credentials/);
  assert.match(html, /data-pane="detail"/);
  assert.match(renderImFixture(false), /data-pane="list"/);
  const failedDelivery = renderImFixture(true, "Delivery failed");
  assert.match(failedDelivery, /role="alert">Delivery failed/);
  assert.ok(failedDelivery.includes(imCopy("en").connected));
});
