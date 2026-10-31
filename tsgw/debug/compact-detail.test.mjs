import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";
import { SECOND, MINUTE, LOCAL, SERVER, reply, catalog } from "./fixtures.mjs";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DebugSessionDetailView, DEBUG_DETAIL_MESSAGES } = await jiti.import("./DebugSessionDetail.tsx");
const { debugServerClock, barFraction } = await jiti.import("@/components/debug-panel-state.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW.ts");
const { interpolateMessage } = await jiti.import("@/lib/i18n/format.ts");
const { DEBUG_PAGE_MESSAGES } = await jiti.import("./messages.ts");

const source = await readFile(new URL("./DebugSessionDetail.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("./detail.module.css", import.meta.url), "utf8");

const t = (key, params) => {
  assert.equal(typeof enLocale.messages[key], "string", `missing translation ${key}`);
  return interpolateMessage(enLocale.messages[key], params);
};
const decode = html => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const visibleText = html => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const titleOf = id => catalog.find(entry => entry.id === id)?.name || catalog.find(entry => entry.id === id)?.firstMessage || null;

/** The answer above arrived 10 s before `now`, as the page's own poll timestamps it. */
const clockAt = now => debugServerClock(SERVER, LOCAL - 10 * SECOND, now);

function render({ detail = reply().session, now = LOCAL, locale = "en", ...rest } = {}) {
  return decode(renderToStaticMarkup(React.createElement(DebugSessionDetailView, {
    detail, clock: clockAt(now), titleOf, t, locale, id: "debug-session-s1", name: "Current chat", ...rest,
  })));
}

const capsule = (label, tone, shape, inner, extraClass = "", pulse = false) =>
  `<span class="tag${extraClass}" role="img" aria-label="${label}" title="${label}">`
  + `<span class="lamp" data-tone="${tone}" data-shape="${shape}"${pulse ? ' data-pulse="on"' : ""} aria-hidden="true">`
  + `<span class="lampCore"></span></span>${inner}</span>`;

test("MCP servers are one capsule each: a settled one shows its lamp and name, others say why", () => {
  const html = render();
  assert.ok(html.includes(capsule("files (global) · Connected", "ok", "solid", '<span class="tagName">files</span>')), html);
  // The failing one adds the reason in words beside the lamp, not a row per field.
  assert.ok(html.includes('<span class="tagName">jira</span><span class="tagState">Did not connect</span>'), html);
  assert.ok(html.includes('aria-label="jira (project) · Did not connect · error"'), html);
  // Scope and the whole record stay in the tooltip and accessible name: not repeated as visible text.
  const text = visibleText(html);
  assert.doesNotMatch(text, /\bglobal\b|\bproject\b/);
  assert.match(text, /Host active: yes · run active: no/);
  assert.match(text, /1 problems/);
  // No per-server block: two servers, two capsules, two states at most.
  assert.ok(html.split('class="tag').length - 1 >= 2);
});

test("the lamp is a ring around a lit core, and its shape keeps released, connecting and error apart", () => {
  const detail = reply().session;
  detail.subagents = { active: false, runs: [], notifications: [] };
  detail.mcp.servers = [
    { name: "idle", scope: "global", state: "connected", hasError: false, released: true },
    { name: "dialing", scope: "project", state: "connecting", hasError: false, released: false },
    { name: "broken", scope: "project", state: "failed", hasError: true, released: false },
  ];
  const html = render({ detail });
  assert.ok(html.includes(capsule("idle (global) · Connected · released", "dim", "dotted", '<span class="tagName">idle</span><span class="tagState">released</span>', " tagDim")), html);
  assert.ok(html.includes(capsule("dialing (project) · Connecting", "warning", "dashed", '<span class="tagName">dialing</span><span class="tagState">Connecting</span>', "", true)), html);
  assert.ok(html.includes(capsule("broken (project) · Did not connect · error", "error", "solid", '<span class="tagName">broken</span><span class="tagState">Did not connect</span>')), html);
  // Only a state still on its way there breathes; the stylesheet stops even that on request.
  assert.equal(html.split('data-pulse="on"').length - 1, 1);
  assert.match(css, /\.lamp\s*\{[^}]*border:\s*1px solid currentColor/);
  assert.match(css, /\.lampCore\s*\{[^}]*box-shadow:[\s\S]*?0 0 5px 1px/);
  assert.match(css, /@keyframes lampHalo/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none !important;/);
});

test("the MCP idle release keeps its countdown and bar in view, read on the server clock", () => {
  const html = render();
  assert.match(visibleText(html), /idle release in 1m 50s/);
  const width = value => `width:${(barFraction(value, 5 * MINUTE) * 100)}%`;
  assert.ok(html.includes(`class="meterFill" style="${width(2 * MINUTE - 10 * SECOND)}"`), html);
  const later = render({ now: LOCAL + 30 * SECOND });
  assert.match(visibleText(later), /idle release in 1m 20s/);
  assert.ok(later.includes(`class="meterFill" style="${width(2 * MINUTE - 40 * SECOND)}"`), later);
  // Released and idle is not an error: the word says release, and the bar is not a countdown to a failure.
  assert.doesNotMatch(visibleText(html), /idle release in .* (error|failed)/);
});

test("the session's idle time is a reap check, said in the reader's language and counted on the server's clock", () => {
  const html = render();
  const text = visibleText(html);
  assert.match(text, /Next idle check in 8m 20s/);
  assert.match(text, /Reap check · in 8m 20s/);
  assert.match(text, /Next idle check, not a guaranteed shutdown/);
  assert.match(render({ now: LOCAL + 10 * SECOND }), /Next idle check in 8m 10s/);
  const chinese = visibleText(render({ locale: "zh-CN" }));
  assert.match(chinese, /回收检查/);
  assert.match(chinese, /下一次空闲检查/);
  // No check scheduled is said, not left as a blank.
  const noCheck = reply().session;
  noCheck.wrapper.idle.nextCheckAt = null;
  assert.match(visibleText(render({ detail: noCheck })), /No check scheduled/);
  // The wording is the page's, so a rename in the shared dictionary fails here, not silently at runtime.
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    for (const key of ["dense.reap", "dense.reapHint", "dense.noCheck"]) {
      assert.equal(typeof DEBUG_PAGE_MESSAGES[locale][key], "string", `${locale} ${key}`);
    }
  }
});

test("the long connection and run records fold away natively and keep their fields", () => {
  const html = render();
  const text = visibleText(html);
  for (const value of [
    "Stream records", "Run records", "Idle window",
    "Request opened 5m 10s ago", "last write 13s ago", "connected 5m 10s ago",
    "Parent: Current chat", "4m 10s ago", "explore",
  ]) assert.ok(text.includes(value), value);
  assert.equal(html.split('<details class="records">').length - 1, 3);
  assert.doesNotMatch(html, /<details[^>]*\sopen[\s>]/);
  assert.match(html, /<summary class="recordsTitle">Stream records<\/summary>/);
});

test("every diagnostic the detail carried before still renders", () => {
  const text = visibleText(render());
  for (const value of [
    "Started 6m 10s ago", "Last event agent_end", "Last command prompt",
    "Event listeners: 1", "Wrapper created 6m 10s ago", "Last idle reset 1m 40s ago",
    "Next idle check in 8m 20s", "timeout in 10m 00s",
    "Extensions bound", "Process history", "started 2×", "first 30m 10s ago", "last 6m 10s ago", "closed 7m 10s ago",
    "Event streams", "Liveness providers", "keepalive-ext", "active · by file",
    "Subagents", "a run is unsettled", "Running", "background",
    "MCP", "files", "jira", "Did not connect", "1 problems",
  ]) assert.ok(text.includes(value), value);
});

test("the detail's own words exist in all three locales and shadow no other dictionary", () => {
  const keys = Object.keys(DEBUG_DETAIL_MESSAGES.en).sort();
  assert.ok(keys.length >= 3, keys.join(", "));
  const globals = { en: enLocale, "zh-CN": zhCNLocale, "zh-TW": zhTWLocale };
  const names = message => [...message.matchAll(/\{([\w.-]+)\}/g)].map(match => match[1]).sort();
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    assert.deepEqual(Object.keys(DEBUG_DETAIL_MESSAGES[locale]).sort(), keys, locale);
    for (const key of keys) {
      const message = DEBUG_DETAIL_MESSAGES[locale][key];
      assert.equal(typeof message, "string", `${locale} ${key}`);
      assert.ok(message.trim().length > 0, `${locale} ${key}`);
      assert.deepEqual(names(message), names(DEBUG_DETAIL_MESSAGES.en[key]), `${locale} ${key}`);
      assert.equal(globals[locale].messages[key], undefined, `${locale} ${key} shadows a global translation`);
    }
  }
  assert.notEqual(DEBUG_DETAIL_MESSAGES["zh-CN"]["detail.streamRecords"], DEBUG_DETAIL_MESSAGES.en["detail.streamRecords"]);
});

test("the compact surface is owned by its own stylesheet and the props are unchanged", () => {
  assert.match(source, /import d from "\.\/detail\.module\.css";/);
  assert.doesNotMatch(source, /DebugPageView\.module\.css/);
  // A capsule, not a bordered card; one compact reading grid; disclosures that carry the long tail.
  assert.match(css, /\.tag\s*\{[^}]*border-radius: 999px/);
  assert.match(css, /\.grid\s*\{[^}]*grid-template-columns: repeat\(auto-fit/);
  assert.match(css, /\.recordsTitle::before/);
  const props = source.slice(source.indexOf("export interface DebugSessionDetailViewProps"), source.indexOf("}", source.indexOf("export interface DebugSessionDetailViewProps")));
  for (const field of ["detail", "clock", "titleOf", "t", "locale", "id", "name"]) assert.match(props, new RegExp(`\\b${field}:`), field);
  assert.doesNotMatch(props, /className/);
  // Still read-only: no request, no stream, no timer, no other page's state.
  assert.doesNotMatch(source, /fetch\(|EventSource|XMLHttpRequest|setInterval|setTimeout|useState|useEffect/);
});
