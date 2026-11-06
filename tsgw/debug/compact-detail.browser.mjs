// Browser-only companion: node --test tsgw/debug/compact-detail.browser.mjs
// Kept out of npm test so unit tests do not require an installed Chromium binary.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
import { chromium } from "playwright";
import { LOCAL, SERVER, SECOND, reply, catalog } from "./fixtures.mjs";
registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DebugSessionDetailView } = await jiti.import("./DebugSessionDetail.tsx");
const { debugServerClock } = await jiti.import("@/components/debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const css = await readFile(new URL("./detail.module.css", import.meta.url), "utf8");
const locales = { en: enLocale, "zh-CN": zhCNLocale };
function render({ detail, locale = "en" }) {
  return renderToStaticMarkup(React.createElement(DebugSessionDetailView, {
    detail, clock: debugServerClock(SERVER, LOCAL - 10 * SECOND, LOCAL),
    titleOf: id => catalog.find(entry => entry.id === id)?.name || catalog.find(entry => entry.id === id)?.firstMessage || null,
    t: (key, params) => interpolateMessage(locales[locale].messages[key], params),
    locale, id: "fixture-resource", name: "Inert resource fixture",
  }));
}

/** Real CSS geometry with inert static markup: no server, API, model or task is touched. */
function denseFixture(children = 2) {
  const detail = reply().session;
  detail.mcp.problems = 0;
  detail.mcp.servers = ["files", "gitlab", "calendar", "notes", "browser", "storage", "search"].map(name => ({ name, scope: "global", state: "connected", released: false, hasError: false }));
  detail.eventStreams = Array.from({ length: 3 }, () => ({ ...detail.eventStreams[0] }));
  detail.subagents.runs = Array.from({ length: children }, (_, i) => ({ ...detail.subagents.runs[0], sessionId: `child-${i}`, profile: i ? "review" : "explore" }));
  detail.subagents.active = children > 0;
  return detail;
}

test("800–1100px resource rows fit three families without reducing fonts or hiding facts", async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const locale of ["en", "zh-CN"]) for (const width of [800, 1100]) {
      const markup = render({ detail: denseFixture(), locale });
      await page.setViewportSize({ width: width + 40, height: 900 });
      await page.setContent(`<style>body{margin:0;font-family:Arial,sans-serif;--dbg-mono:monospace}main{width:${width}px}${css}</style><main>${markup.repeat(3)}</main>`);
      const dimensions = await page.evaluate(() => ({
        height: document.querySelector(".detail").getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        hidden: [...document.querySelectorAll(".detail *")].filter(el => ["hidden", "clip"].includes(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight).length,
        fonts: [...document.querySelectorAll(".detail *")].map(el => parseFloat(getComputedStyle(el).fontSize)),
      }));
      t.diagnostic(`${locale} ${width}px: two-subagent family ${dimensions.height}px`);
      assert.ok(dimensions.height < 210, JSON.stringify({ locale, width, ...dimensions }));
      assert.equal(dimensions.overflow, false);
      assert.equal(dimensions.hidden, 0);
      assert.ok(Math.min(...dimensions.fonts) >= 11);
      assert.equal(await page.locator(".runRow").count(), 6);
    }
    await page.setContent(`<style>body{margin:0;font-family:Arial,sans-serif;--dbg-mono:monospace}main{width:800px}${css}</style><main>${render({ detail: denseFixture(0) })}</main>`);
    const idleHeight = await page.locator(".detail").evaluate(el => el.getBoundingClientRect().height);
    t.diagnostic(`800px normal/no task family ${idleHeight}px`);
    assert.ok(idleHeight < 150, String(idleHeight));
    await page.setViewportSize({ width: 390, height: 900 });
    await page.setContent(`<style>body{margin:0;font-family:Arial,sans-serif}${css}</style>${render({ detail: denseFixture() })}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); }
});
