import assert from "node:assert/strict";
import { densitySeed, familySeed, sideSeed } from "./e2e-fixtures.mjs";

// Invoked by e2e.mjs inside the SAME API/CAT guard and browser context.
// No fabricated DOM, summary, clocks or observer samples are installed here.
export async function gridChecks(h) {
  const { test, page, load, until, visible, shot, sampled, resources, resourceRow, resourceScroll, desktopGeometry, mobileGeometry, metric, detail, copyJson, results, requests, getStage } = h;
  const family = id => resources().locator(`[data-family-id="${id}"]`);
  async function measureGrid() {
    return resources().evaluate(region => {
      const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const blocks = [...region.querySelectorAll('[data-family-id]')];
      const parent = blocks[0]?.parentElement;
      return {
        columns: parent ? getComputedStyle(parent).gridTemplateColumns : null,
        families: blocks.map(e => ({ id: e.dataset.familyId, ...box(e), titleFont: parseFloat(getComputedStyle(e.querySelector('header h3')).fontSize), sessions: [...e.querySelectorAll('article[data-session-id]')].map(row => row.dataset.sessionId) })),
        clippedText: blocks.flatMap(block => [...block.querySelectorAll('strong, span, p, h3')].filter(e => e.textContent.trim() && !e.children.length).filter(e => { const r = e.getBoundingClientRect(), b = block.getBoundingClientRect(); return r.left < b.left - 1 || r.right > b.right + 1 || e.scrollWidth > e.clientWidth + 1; }).map(e => ({ family: block.dataset.familyId, text: e.textContent, ...box(e), clientWidth: e.clientWidth, scrollWidth: e.scrollWidth }))),
        text: [...region.querySelectorAll('article[data-session-id]')].flatMap(row => [...row.querySelectorAll('strong, span, p, h3')].filter(e => e.textContent.trim() && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())).map(e => ({ id: row.dataset.sessionId, text: e.textContent.trim(), font: parseFloat(getComputedStyle(e).fontSize), ...box(e) }))),
        innerScrollers: blocks.flatMap(block => [block, ...block.querySelectorAll('*')].filter(e => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).map(e => ({ family: block.dataset.familyId, tag: e.tagName, class: e.className, height: e.clientHeight, total: e.scrollHeight }))),
      };
    });
  }
  for (const [width, height, columns] of [[1000, 900, 1], [1366, 768, 2], [1440, 900, 2], [1920, 1080, 3]]) await test(`family-grid-responsive-columns-width-font-and-shared-scroll-${width}`, async () => {
    const seed = densitySeed(4); await load(seed, "en", false);
    await until(async () => assert.equal(await family("main-04").count(), 1));
    await sampled("main-04");
    {
      const frame = await desktopGeometry(width, height);
      await resourceScroll().evaluate(e => { e.scrollTop = 0; });
      const evidence = await measureGrid(), firstY = evidence.families[0].y;
      const firstRow = evidence.families.filter(r => Math.abs(r.y - firstY) <= 1);
      assert.equal(evidence.families.length, 4, "four independent resident roots, not project-level families");
      results.push({ name: `grid-${width}x${height}`, evidence: { frame, ...evidence } }); await shot(`grid-${width}x${height}`);
      assert.equal(firstRow.length, columns, `actual family columns at ${width}: ` + JSON.stringify(evidence));
      assert.ok(evidence.families.every(f => f.width >= 360), "family columns remain readable, never narrow slivers");
      for (const f of firstRow) assert.equal(f.y, firstY);
      for (let i = 1; i < firstRow.length; i++) assert.ok(firstRow[i].x >= firstRow[i - 1].right, "families do not overlap horizontally");
      assert.deepEqual(evidence.innerScrollers, [], "main resource surface owns ALL scrolling; no family/card/body inner scrollers");
      assert.ok(evidence.families.every(f => f.titleFont >= 12), "root names remain >=12px in familyHead h3");
      assert.ok(evidence.text.length > 0 && evidence.text.every(t => t.font >= 11), "body text retains the original >=11px baseline: " + JSON.stringify(evidence.text.filter(t => t.font < 11)));
      assert.deepEqual(evidence.clippedText, [], "no resource text clipped or overflowing its family");
    }
  });
  await test("family-grid-mobile-minimal-geometry", async () => {
    await load(densitySeed(4), "en", false);
    await until(async () => assert.equal(await family("main-04").count(), 1));
    await page.setViewportSize({ width: 390, height: 844 }); await mobileGeometry();
    const evidence = await measureGrid();
    assert.ok(evidence.families.every(f => Math.abs(f.x - evidence.families[0].x) <= 1), "mobile family grid is one column");
    assert.ok(evidence.families.slice(1).every((f, i) => f.y >= evidence.families[i].bottom - 1), "mobile families never overlap");
    results.push({ name: "grid-mobile-one-column", evidence }); await shot("grid-mobile-one-column");
  });
  await test("odd-third-family-fills-final-row-without-extra-scroll", async () => {
    await load(densitySeed(3), "en", false);
    await until(async () => assert.equal(await family("main-03").count(), 1));
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      await desktopGeometry(width, height);
      const evidence = await measureGrid(), [a, b, c] = evidence.families;
      assert.ok(Math.abs(a.y - b.y) <= 1 && b.x >= a.right, "first two roots are side by side");
      assert.ok(c.y >= Math.max(a.bottom, b.bottom) - 1 && Math.abs(c.x - a.x) <= 1 && Math.abs(c.right - b.right) <= 1, "third family spans the free final row: " + JSON.stringify(evidence));
      results.push({ name: "odd-third-family-" + width, evidence }); await shot("odd-third-family-" + width);
    }
  });
  await test("family-children-cannot-create-extra-grid-columns", async () => {
    const seed = familySeed(); await load(seed, "en", false);
    await until(async () => assert.equal(await resources().locator('[data-family-id]').count(), 2));
    await sampled("beta-child-2");
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      await desktopGeometry(width, height);
      const evidence = await measureGrid(), [a, b] = evidence.families;
      assert.deepEqual(evidence.families.map(f => f.id), ["alpha", "beta"]);
      assert.ok(Math.abs(a.y - b.y) <= 1 && b.x >= a.right, "two parent families occupy two columns");
      for (const f of evidence.families) {
        assert.deepEqual(f.sessions, [f.id, f.id + "-child-1", f.id + "-child-2"]);
        for (const id of f.sessions) {
          const box = await resourceRow(id).boundingBox();
          assert.ok(box.x >= f.x && box.x + box.width <= f.right + 1, "parent and child stay within their own family column");
        }
      }
      results.push({ name: "family-column-membership-" + width, evidence }); await shot("family-column-membership-" + width);
    }
  });
  for (const scenario of ["resident", "nonresident", "missing"]) await test("v14-side-identity-and-real-delegation-" + scenario, async () => {
    const seed = sideSeed({ sourceResident: scenario === "resident", sourceMissing: scenario === "missing" });
    await load(seed, "en", false); await sampled("side-live"); await sampled("delegated-live");
    const side = resourceRow("side-live"), child = resourceRow("delegated-live");
    await visible(side.locator("header").getByText("Side chat", { exact: true }));
    await visible(detail("side-live").getByText("Side chat", { exact: true }));
    assert.equal(await side.getByText("Subagent", { exact: true }).count(), 0, "wire subagent:true cannot turn a side chat into a delegated child");
    await visible(child.locator("header").getByText("Subagent", { exact: true }));
    await visible(detail("delegated-live").getByText("subagent", { exact: true }));
    assert.equal(await child.getByText("Side chat", { exact: true }).count(), 0);
    await metric("Runtime sessions", seed.runtime.length); await metric("Ordinary sessions", scenario === "resident" ? 2 : 1); await metric("Runtime subagents", 1);
    assert.equal(await family("side-live").count(), 1, "side chat is its own family root");
    assert.deepEqual(await family("side-live").locator('article[data-session-id]').evaluateAll(nodes => nodes.map(n => n.dataset.sessionId)), ["side-live"]);
    assert.equal(await family("side-source").locator('#resource-side-live').count(), 0, "side relation never joins the source delegation family");
    await visible(side.getByText(new RegExp("Side chat from: " + (scenario === "missing" ? "side-sou" : "Side source"))));
    assert.equal(await resourceRow("side-history").count(), 0, "historical side chat never becomes a resource");
    if (scenario !== "resident") {
      const context = resourceRow("side-source");
      // Host groupDebugSessions.rootOf stops at an absent catalog parent.
      // Known nonresident parents supply context; missing metadata must not be invented.
      assert.equal(await context.count(), scenario === "missing" ? 0 : 1, "only a known catalog parent supplies nonresident context");
      if (scenario === "missing") assert.equal(await family("delegated-live").count(), 1, "orphan remains its own real resident family");
      assert.equal(await context.locator('[class*="modelLine"], [data-kind], [class*="unread"], [class*="age"]').count(), 0);
      assert.equal(await detail("side-source").count(), 0);
    }
    const copied = await copyJson();
    assert.equal(copied.resources["side-live"].reply.session.wrapper.subagent, true, "fixture reproduces the real v0.14.1 flag, not a corrected backend");
    assert.ok(requests.filter(r => r.stage === getStage() && r.targetId).every(r => seed.runtime.includes(r.targetId)), "no cold source or history sampling");
    results.push({ name: "side-identity-" + scenario, evidence: { runtime: seed.runtime, families: await resources().locator('[data-family-id]').evaluateAll(nodes => nodes.map(n => n.dataset.familyId)), row: await side.innerText(), wrapper: await detail("side-live").innerText() } });
    await shot("side-identity-" + scenario);
  });
  await test("side-only-nonresident-origin-never-creates-parent-context", async () => {
    const seed = sideSeed({ sourceResident: false }); seed.runtime = ["side-live"];
    await load(seed, "en", false); await sampled("side-live");
    assert.equal(await resources().locator('[data-family-id]').count(), 1);
    assert.equal(await family("side-live").count(), 1);
    assert.equal(await resourceRow("side-source").count(), 0, "side provenance is not delegation and cannot create a parent placeholder");
    await metric("Ordinary sessions", 1); await metric("Runtime subagents", 0);
    await shot("side-only-no-parent-context");
  });
  await test("mobile-twelfth-main-and-full-family-details-reachable", async () => {
    const seed = densitySeed(12); await load(seed, "en", false);
    await until(async () => assert.equal(await resources().locator('[data-family-id]').count(), 12));
    await page.setViewportSize({ width: 390, height: 844 }); await mobileGeometry();
    const last = resourceRow("main-12"); await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox(), surface = await page.locator('section[class*="page"]').evaluate(e => ({ top: e.scrollTop, total: e.scrollHeight, height: e.clientHeight }));
    assert.ok(box.y >= 0 && box.y + box.height <= 845 && surface.top > 0, "12th resource really intersects mobile viewport: " + JSON.stringify({ box, surface }));
    results.push({ name: "mobile-twelfth-main", evidence: { box, surface } }); await shot("mobile-twelfth-main");
    const familyFixture = familySeed(); await load(familyFixture, "en", false); await sampled("alpha-child-2");
    await page.setViewportSize({ width: 390, height: 844 });
    const child = resourceRow("alpha-child-2");
    await child.locator('[data-kind="mcp"]').scrollIntoViewIfNeeded();
    await visible(child.getByText("Assignment alpha-child-2", { exact: true }));
    await visible(child.getByText("Parent: Parent alpha", { exact: true }));
    await mobileGeometry(); await shot("mobile-family-child-resources");
  });
}
