import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { chromium } from "playwright";

registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith(".module.css")) return nextLoad(url, context);
  return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
} });
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { WakeupRow } = await jiti.import("./ui.tsx");
const { mergeWakeupRows, showWakeupTrigger, wakeupCounts, wakeupStatusText, wakeupText } = await jiti.import("./ui-view.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const task = (id = "wakeup-1", patch = {}) => ({
  wakeupId: id, sourceSessionId: "source & ?", targetSessionId: "target/中文", summary: `Handoff ${id}`,
  cwd: "/fixture/project", scheduledAt: "2026-11-16T03:00:00Z", createdAt: "2026-11-16T02:00:00Z",
  updatedAt: "2026-11-16T02:00:00Z", status: "pending", armed: true, ...patch,
});
const result = (items = [], patch = {}) => ({ items, nextCursor: null, health: { state: "ready", isOwner: true }, ...patch });

test("entry is absent for an unused healthy session and present for terminal records or unhealthy storage", () => {
  assert.equal(showWakeupTrigger([], { state: "ready", isOwner: true }), false);
  for (const state of ["starting", "read_only", "paused", "storage_error"]) assert.equal(showWakeupTrigger([], { state, isOwner: false }), true);
  assert.equal(showWakeupTrigger([task("old", { status: "run_settled" })]), true);
  assert.equal(showWakeupTrigger([], undefined, true), true);
});

test("counts describe observable activity and unknown outcomes without inventing task success", () => {
  const statuses = ["pending", "dispatching", "submitted", "received", "run_settled", "run_aborted", "delivery_failed", "cancelled", "unknown"];
  assert.deepEqual(wakeupCounts(statuses.map((status, i) => task(String(i), { status }))), { active: 4, unknown: 1 });
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const labels = statuses.map(status => wakeupStatusText(locale, status));
    assert.equal(new Set(labels).size, statuses.length);
    assert.ok(labels.every(Boolean));
    assert.notEqual(wakeupStatusText(locale, "received"), wakeupStatusText(locale, "submitted"));
    assert.notEqual(wakeupStatusText(locale, "received"), wakeupStatusText(locale, "run_settled"));
    assert.ok(wakeupText(locale, "semantics"));
  }
});

test("refresh updates loaded rows in place, retains older pages and appends new records once", () => {
  const before = [task("a"), task("b"), task("older")];
  const incoming = [task("new"), task("b", { status: "received" }), task("a", { status: "run_settled" })];
  const merged = mergeWakeupRows(before, incoming);
  assert.deepEqual(merged.map(item => item.wakeupId), ["a", "b", "older", "new"]);
  assert.equal(merged[0].status, "run_settled");
  assert.equal(merged[1].status, "received");
  assert.deepEqual(mergeWakeupRows(merged, incoming), merged);
  assert.equal(before[0].status, "pending");
  assert.deepEqual(mergeWakeupRows([], [task("overlap"), task("overlap", { status: "received" })]), [task("overlap", { status: "received" })]);
});

for (const locale of ["en", "zh-CN", "zh-TW"]) test(`real React row renders safe summary, project, time, links and unsaved/armed facts (${locale})`, () => {
  const html = renderToStaticMarkup(React.createElement(WakeupRow, { locale, item: task("safe", {
    summary: '<script>alert("summary")</script>', armed: false, unsaved: true, message: "SECRET BODY NOT FOR LIST",
  }) }));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("/fixture/project"));
  assert.ok(html.includes('dateTime="2026-11-16T03:00:00Z"'));
  assert.ok(html.includes('?session=source%20%26%20%3F'));
  assert.ok(html.includes('?session=target%2F%E4%B8%AD%E6%96%87'));
  assert.ok(html.includes(wakeupText(locale, "unarmed")));
  assert.ok(html.includes(wakeupText(locale, "unsaved")));
  assert.ok(!html.includes("SECRET BODY NOT FOR LIST"));
  assert.ok(!html.includes(wakeupText(locale, "armed")));
});

/** Bundle only the actual client component and its existing dependencies, without a Next build/server. */
async function bundleFixture(directory) {
  const entry = path.join(directory, "entry.js");
  const loader = path.join(directory, "loader.cjs");
  await writeFile(loader, `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){
    if(this.resourcePath.endsWith('.css'))return 'export default new Proxy({}, {get:(_,key)=>String(key)})';
    return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  };`);
  await writeFile(entry, `import React, {useState, useCallback, useEffect} from 'react'; import {createRoot} from 'react-dom/client';
    import {I18nProvider} from ${JSON.stringify(path.join(root, "hooks/useI18n.tsx"))};
    import {WakeupPanelTrigger} from ${JSON.stringify(path.join(root, "tsgw/wakeups/ui.tsx"))};
    function Host(props) {
      const [activeTopPanel, setActiveTopPanel] = useState(null);
      const [panelHost, setPanelHost] = useState(null);
      const close = useCallback(()=>setActiveTopPanel(panel=>panel==='wakeups'?null:panel),[]);
      useEffect(()=>setActiveTopPanel(null),[props.sessionId]);
      return React.createElement(React.Fragment,null,
        React.createElement(WakeupPanelTrigger,{...props,open:activeTopPanel==='wakeups',panelHost,onClose:close,
          onToggle:()=>setActiveTopPanel(panel=>panel==='wakeups'?null:'wakeups')}),
        React.createElement('button',{id:'agents',onClick:()=>setActiveTopPanel(panel=>panel==='agents'?null:'agents')},'Agents'),
        activeTopPanel && React.createElement('div',{id:'top-panel',style:{position:'fixed',top:44,left:0,width:'100%',zIndex:500}},
          activeTopPanel==='wakeups'?React.createElement('div',{ref:setPanelHost}):React.createElement('section',{'aria-label':'Agents',role:'region'},'Agent status')));
    }
    const root=createRoot(document.getElementById('root'));
    window.renderWakeups=props=>root.render(React.createElement(I18nProvider,null,React.createElement(Host,props)));
    window.unmountWakeups=()=>root.unmount();`);
  const { webpack } = require("next/dist/compiled/webpack/webpack");
  const compiler = webpack({
    mode: "development", devtool: false, cache: false, target: "web", entry,
    output: { path: directory, filename: "client.js" },
    resolve: { extensions: [".ts", ".tsx", ".js"], alias: { "@": root }, modules: [path.join(root, "node_modules")] },
    module: { rules: [{ test: /\.(tsx?|css)$/, use: [loader] }] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(closeError => {
    if (error || closeError) reject(error || closeError);
    else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
    else resolve();
  })));
  return readFile(path.join(directory, "client.js"), "utf8");
}

async function fixture(browser, bundle, css, { locale = "en", width = 1024, first = result([task()]) } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  // No request may leave the fixture, even if an implementation regresses.
  await page.route("**/*", route => route.abort());
  await page.clock.install();
  await page.setContent(`<style>:root{--bg:white;--bg-panel:#f5f5f5;--bg-hover:#eee;--border:#ccc;--text:#222;--text-muted:#555;--accent:#245bce}body{font:14px Arial;margin:8px}button{font:inherit}${css}</style><div id="root" style="display:flex;height:44px;align-items:stretch"></div><button id="outside" style="position:fixed;bottom:8px;left:8px">Outside</button>`);
  await page.evaluate(({ locale, first }) => {
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    window.setFixtureVisibility = value => { visibility = value; document.dispatchEvent(new Event("visibilitychange")); };
    // The real provider reads localStorage; about:blank may deny it, so provide the existing storage API in memory.
    Object.defineProperty(window, "localStorage", { value: { getItem: () => locale, setItem() {} }, configurable: true });
    window.wakeupFixture = { requests: [], first, pages: {}, details: {}, fail: false, hold: false, pending: [] };
    window.EventSource = class { constructor() { throw new Error("Unexpected event stream"); } };
    window.fetch = async (input, options) => {
      const f = window.wakeupFixture;
      const url = new URL(input, "https://fixture.invalid");
      f.requests.push({ path: url.pathname, query: url.search, method: options?.method, signal: options?.signal });
      if (options?.method !== "GET" || !url.pathname.startsWith("/api/tsgw/wakeups")) throw new Error("Unexpected request");
      if (f.hold) return new Promise(resolve => f.pending.push({ resolve, signal: options.signal })); // Deliberately allows stale replies after abort.
      if (f.fail) return new Response("Unavailable", { status: 503 });
      const detailId = url.pathname.split("/")[4];
      const body = detailId ? f.details[decodeURIComponent(detailId)] : (f.pages[url.searchParams.get("cursor")] || f.first);
      return new Response(JSON.stringify(body || { items: [], nextCursor: null, health: { state: "ready", isOwner: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
  }, { locale, first });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => window.renderWakeups({ sessionId: "fixture-session" }));
  await page.waitForFunction(() => window.wakeupFixture.requests.length === 1);
  await page.waitForFunction(() => !window.wakeupFixture.requests[0].signal.aborted);
  return page;
}
const requestCount = page => page.evaluate(() => window.wakeupFixture.requests.length);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));

// Optional in npm test: environments without Chromium still run all React/projection tests above.
test("isolated browser exercises the production component with no real sessions", async t => {
  try { await access(chromium.executablePath()); } catch { t.skip("Chromium is not installed"); return; }
  const directory = await mkdtemp(path.join(tmpdir(), "wakeup-ui-"));
  let browser;
  try {
    const bundle = await bundleFixture(directory);
    const css = await readFile(new URL("./ui.module.css", import.meta.url), "utf8");
    browser = await chromium.launch({ headless: true });
    await t.test("compact entry keeps all controls inside the 320px host toolbar", async () => {
      const page = await fixture(browser, bundle, css, { width: 320 });
      try {
        await page.evaluate(() => {
          const root = document.getElementById("root");
          const toolbar = document.createElement("div");
          toolbar.style.cssText = "display:flex;align-items:center;width:100%;height:44px";
          root.replaceWith(toolbar);
          const sidebar = document.createElement("button");
          sidebar.textContent = "Sidebar";
          sidebar.style.cssText = "width:44px;flex:0 0 44px;padding:0";
          toolbar.append(sidebar, root);
          root.style.display = "contents";
          document.getElementById("agents").style.cssText = "width:44px;flex:0 0 44px;padding:0";
          const controls = document.createElement("div");
          controls.style.cssText = "display:flex;flex:1;min-width:0;height:100%";
          for (const name of ["More", "Stats", "Files"]) {
            const button = document.createElement("button");
            button.textContent = name;
            button.style.cssText = "width:44px;flex:0 0 44px;padding:0";
            controls.append(button);
          }
          toolbar.append(controls);
          window.renderWakeups({ sessionId: "fixture-session", compact: true });
        });
        const trigger = page.locator("button[data-compact=true]");
        await trigger.waitFor();
        assert.equal(await trigger.getAttribute("aria-label"), "Wakeups · 1 · 1 active");
        assert.equal(await trigger.locator(".triggerLabel").isVisible(), false);
        assert.ok(await page.getByRole("button", { name: "Files", exact: true }).evaluate(node => node.getBoundingClientRect().right <= innerWidth));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await trigger.click();
        await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
      } finally { await page.close(); }
    });
    await t.test("host panels are mutually exclusive and the quantity/status remain visible when collapsed", async () => {
      const page = await fixture(browser, bundle, css, { first: result([task("done", { status: "run_settled" }), task("unknown", { status: "unknown" })], { nextCursor: "older" }) });
      try {
        const trigger = page.locator(".trigger");
        assert.equal(await trigger.getAttribute("aria-label"), "Wakeups · 2+ · 1 to verify !");
        assert.equal(await trigger.locator(".badge").textContent(), "2+!");
        await trigger.click();
        await page.getByRole("region", { name: /^Wakeups/ }).waitFor();
        await trigger.click();
        assert.equal(await page.getByRole("region").count(), 0);
        await trigger.click();
        await page.locator("#agents").click();
        await page.getByRole("region", { name: "Agents", exact: true }).waitFor();
        assert.equal(await page.getByRole("region", { name: /^Wakeups/ }).count(), 0);
        const closed = await requestCount(page);
        await page.clock.runFor(10000);
        assert.equal(await requestCount(page), closed);
        await trigger.click();
        await page.getByRole("region", { name: /^Wakeups/ }).waitFor();
        assert.equal(await page.getByRole("region", { name: "Agents", exact: true }).count(), 0);
        assert.equal(await page.locator("dialog").count(), 0);
      } finally { await page.close(); }
    });
    await t.test("closed panel reads once; refreshKey reads once; health faults expose an otherwise empty entry", async () => {
      const page = await fixture(browser, bundle, css, { first: result() });
      try {
        await page.clock.runFor(10000);
        assert.equal(await requestCount(page), 1);
        assert.equal(await page.locator(".trigger").count(), 0);
        await page.evaluate(() => {
          window.wakeupFixture.first.health = { state: "storage_error", isOwner: true, reason: "fixture disk failure" };
          window.renderWakeups({ sessionId: "fixture-session", refreshKey: 1 });
        });
        await page.getByRole("button", { name: /Wakeups/ }).waitFor();
        assert.equal(await requestCount(page), 2);
        await page.getByRole("button", { name: /Wakeups/ }).click();
        await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
        assert.ok((await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).innerText()).includes("Storage unavailable"));
        assert.ok(!(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).innerText()).includes("fixture disk failure"));
        await page.getByText("Storage details", { exact: true }).click();
        assert.ok((await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).innerText()).includes("fixture disk failure"));
      } finally { await page.close(); }
    });
    await t.test("polls only while open and visible; Escape restores focus and outside click keeps its target", async () => {
      const page = await fixture(browser, bundle, css);
      try {
        const trigger = page.getByRole("button", { name: /Wakeups/ });
        await trigger.click();
        await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
        await page.evaluate(() => { window.hostEscapes = 0; window.addEventListener("keydown", e => { if (e.key === "Escape") window.hostEscapes++; }); });
        const opened = await requestCount(page);
        await page.clock.runFor(2500);
        await page.waitForFunction(count => window.wakeupFixture.requests.length === count + 1, opened);
        await page.evaluate(() => window.setFixtureVisibility("hidden"));
        const hidden = await requestCount(page);
        await page.clock.runFor(10000);
        assert.equal(await requestCount(page), hidden);
        await page.evaluate(() => window.setFixtureVisibility("visible"));
        await page.waitForFunction(count => window.wakeupFixture.requests.length === count + 1, hidden);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).count(), 0);
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.evaluate(() => window.hostEscapes), 0);
        const closed = await requestCount(page);
        await page.clock.runFor(10000);
        assert.equal(await requestCount(page), closed);
        await trigger.click();
        await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
        await page.locator("#outside").click();
        assert.equal(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).count(), 0);
        assert.equal(await page.locator("#outside").evaluate(node => node === document.activeElement), true);
        assert.ok((await page.evaluate(() => window.wakeupFixture.requests.map(r => r.method))).every(method => method === "GET"));
      } finally { await page.close(); }
    });
    await t.test("details are lazy, safe and abort on collapse; paging and refresh preserve reading position", async () => {
      const items = Array.from({ length: 7 }, (_, i) => task(`row-${i}`));
      const page = await fixture(browser, bundle, css, { first: result(items, { nextCursor: "page & 2" }) });
      try {
        await page.evaluate(({ next, detail }) => {
          window.wakeupFixture.pages["page & 2"] = next;
          window.wakeupFixture.details["row-0"] = detail;
        }, { next: result([task("older")]), detail: result([task("row-0", { message: '<img src=x onerror="alert(1)">\nFull handoff' })]) });
        await page.getByRole("button", { name: /Wakeups/ }).click();
        await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
        assert.equal(await page.locator(".message").count(), 0);
        assert.ok((await page.evaluate(() => window.wakeupFixture.requests)).every(r => r.path === "/api/tsgw/wakeups"));
        await page.locator(".row").first().locator("summary").click();
        await page.locator(".message").waitFor();
        assert.equal(await page.locator(".message img").count(), 0);
        assert.ok((await page.locator(".message").innerText()).includes("Full handoff"));
        await page.getByRole("button", { name: "Show more", exact: true }).click();
        await page.locator('[data-wakeup-id="older"]').waitFor();
        assert.ok(await page.evaluate(() => window.wakeupFixture.requests.some(r => new URLSearchParams(r.query).get("cursor") === "page & 2")));
        await page.locator(".body").evaluate(node => { node.scrollTop = 350; });
        const scroll = await page.locator(".body").evaluate(node => node.scrollTop);
        await page.evaluate(() => { window.wakeupFixture.first.items.reverse(); window.wakeupFixture.first.items[0].status = "received"; });
        const before = await requestCount(page);
        await page.clock.runFor(2500);
        await page.waitForFunction(count => window.wakeupFixture.requests.length >= count + 2, before);
        await settle(page);
        assert.deepEqual(await page.locator(".row").evaluateAll(rows => rows.map(row => row.dataset.wakeupId)), [...items.map(item => item.wakeupId), "older"]);
        assert.equal(await page.locator(".body").evaluate(node => node.scrollTop), scroll);
        assert.equal(await page.locator(".row").first().locator("details").getAttribute("open"), "");
        await page.locator(".row").first().locator("summary").click();
        await page.evaluate(() => { window.wakeupFixture.hold = true; });
        await page.locator(".row").first().locator("summary").click();
        await page.waitForFunction(() => window.wakeupFixture.pending.length > 0);
        await page.locator(".row").first().locator("summary").click();
        await page.waitForFunction(() => window.wakeupFixture.pending[0].signal.aborted);
      } finally { await page.close(); }
    });
    await t.test("expanded evidence follows list refresh and response links use host entry navigation", async () => {
      const page = await fixture(browser, bundle, css, { first: result([task("facts")]) });
      try {
        await page.evaluate(detail => {
          window.wakeupFixture.details.facts = detail;
          window.navigations = [];
          window.renderWakeups({ sessionId: "fixture-session", onOpenResponse(id, entryId) { window.navigations.push({ id, entryId }); return true; } });
        }, result([task("facts", { message: "Immutable handoff" })]));
        await page.getByRole("button", { name: /Wakeups/ }).click();
        await page.locator(".row summary").click();
        await page.locator(".message").waitFor();
        assert.equal(await page.locator(".detail").getByText("Received", { exact: true }).count(), 0);
        await page.evaluate(() => Object.assign(window.wakeupFixture.first.items[0], {
          status: "run_settled", receivedAt: "2026-11-16T03:00:00Z", settledAt: "2026-11-16T03:01:00Z",
          updatedAt: "2026-11-16T03:01:00Z", responseEntryIds: ["response-1"],
        }));
        await page.clock.runFor(2500);
        await page.locator(".detail").getByText("Received", { exact: true }).waitFor();
        await page.locator(".detail").getByText("Run ended", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.wakeupFixture.requests.filter(request => request.path.endsWith("/facts")).length), 1);
        await page.getByRole("link", { name: "Run response 1", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.navigations), [{ id: "target/中文", entryId: "response-1" }]);
        assert.equal(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).count(), 0);
      } finally { await page.close(); }
    });
    await t.test("aborts and ignores old session/refresh replies; failed refresh retains readable rows", async () => {
      const page = await fixture(browser, bundle, css);
      try {
        await page.getByRole("button", { name: /Wakeups/ }).waitFor();
        await page.evaluate(() => { window.wakeupFixture.hold = true; window.renderWakeups({ sessionId: "fixture-session", refreshKey: 1 }); });
        await page.waitForFunction(() => window.wakeupFixture.pending.length === 1);
        await page.evaluate(() => {
          window.wakeupFixture.hold = false;
          window.wakeupFixture.first.items[0].summary = "New refresh";
          window.renderWakeups({ sessionId: "fixture-session", refreshKey: 2 });
        });
        await page.waitForFunction(() => window.wakeupFixture.pending[0].signal.aborted);
        await page.getByRole("button", { name: /Wakeups/ }).click();
        await page.getByText("New refresh", { exact: true }).waitFor();
        await page.evaluate(old => window.wakeupFixture.pending[0].resolve(new Response(JSON.stringify(old))), result([task("stale", { summary: "STALE MUST NOT LAND" })]));
        await settle(page);
        assert.equal(await page.getByText("STALE MUST NOT LAND").count(), 0);
        await page.evaluate(() => { window.wakeupFixture.fail = true; });
        await page.clock.runFor(2500);
        await page.getByText(/Could not refresh wakeups/).waitFor();
        assert.equal(await page.getByText("New refresh", { exact: true }).count(), 1);
        await page.evaluate(() => { window.wakeupFixture.hold = true; window.wakeupFixture.fail = false; });
        await page.clock.runFor(2500);
        await page.waitForFunction(() => window.wakeupFixture.pending.length === 2);
        await page.evaluate(() => { window.wakeupFixture.hold = false; window.wakeupFixture.first = { items: [], nextCursor: null, health: { state: "ready", isOwner: true } }; window.renderWakeups({ sessionId: "new-session" }); });
        await page.waitForFunction(() => window.wakeupFixture.pending[1].signal.aborted);
        await page.evaluate(old => window.wakeupFixture.pending[1].resolve(new Response(JSON.stringify(old))), result([task("old-session")]));
        await settle(page);
        assert.equal(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).count(), 0);
        assert.equal(await page.locator(".trigger").count(), 0);
      } finally { await page.close(); }
    });
    await t.test("English and both Chinese locales fit phone/tablet panels and let keyboard focus leave", async () => {
      for (const locale of ["en", "zh-CN", "zh-TW"]) for (const width of [320, 390, 768]) {
        const page = await fixture(browser, bundle, css, { locale, width, first: result([task("long", { summary: "Long <handoff> ".repeat(10), cwd: "/" + "long-project/".repeat(20), armed: false, unsaved: true, status: "pending" })]) });
        try {
          await page.getByRole("button", { name: new RegExp(wakeupText(locale, "title")) }).click();
          await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${locale}/${width}: page overflow`);
          assert.equal(await page.locator(".body").evaluate(node => node.scrollWidth > node.clientWidth), false, `${locale}/${width}: panel overflow`);
          assert.equal(await page.getByRole("button", { name: wakeupText(locale, "close"), exact: true }).evaluate(node => node === document.activeElement), true);
          await page.keyboard.press("Shift+Tab");
          assert.equal(await page.locator(".panel").evaluate(node => node.contains(document.activeElement)), false);
          await page.getByRole("button", { name: wakeupText(locale, "close"), exact: true }).focus();
          assert.ok((await page.locator(".panel").innerText()).includes(wakeupText(locale, "unsaved")));
          assert.ok((await page.locator(".panel").innerText()).includes(wakeupText(locale, "unarmed")));
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("region", { name: /^Wakeups|^唤醒|^喚醒/ }).count(), 0);
        } finally { await page.close(); }
      }
    });
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
