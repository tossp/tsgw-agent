import assert from "node:assert/strict";
import { densitySeed, familySeed, thinking } from "./e2e-fixtures.mjs";

/** Real DOM/network assertions; never inject samples into the React application. */
export async function resourceChecks(h) {
  const { test, page, load, until, visible, shot, detail, copyJson, resources, resourceRow, resourceScroll, desktopGeometry, wheelOwn, results, requests, getStage, getState } = h;
  async function sampled(ids) {
    await until(async () => {
      for (const id of ids) {
        assert.equal(await detail(id).locator('[data-kind="mcp"]').count(), 1, id + " resource snapshot");
        assert.ok((await resourceRow(id).locator('[class*="modelLine"]').innerText()).includes("provider-" + id + "/model-" + id), id + " live model");
      }
    }, "all residents auto-sampled without selection", ids.length * 2200 + 6000);
  }
  for (const [width, height] of [[1366, 768], [1440, 900]]) await test(`three-main-resources-simultaneous-scan-${width}`, async () => {
    const seed = densitySeed(); await load(seed, "en", false); await sampled(seed.runtime);
    assert.equal(await page.locator('button[aria-controls^="resource-"]').count(), 0, "no task-selection controls");
    {
      const frame = await desktopGeometry(width, height);
      await resourceScroll().evaluate(e => { e.scrollTop = 0; });
      const measurement = await resources().evaluate(region => {
        const b = region.children[1].getBoundingClientRect();
        return { viewport: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }, rows: [...region.querySelectorAll('[data-family-id]')].map(e => {
          const r = e.getBoundingClientRect();
          return { id: e.dataset.familyId, left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom, height: r.height, font: getComputedStyle(e.querySelector('h3')).fontSize };
        }) };
      });
      results.push({ name: `three-main-${width}x${height}`, evidence: { frame, ...measurement } }); await shot(`three-main-${width}x${height}`);
      const fullyVisible = measurement.rows.filter(r => r.top >= measurement.viewport.top && r.bottom <= measurement.viewport.bottom + 1 && r.left >= measurement.viewport.left && r.right <= measurement.viewport.right + 1);
      assert.ok(fullyVisible.length >= 3, "at least THREE complete main-session resource rows simultaneously scan-readable, without scrolling: " + JSON.stringify(measurement));
      assert.ok(measurement.rows.every(r => parseFloat(r.font) >= 12), "never shrink names below 12px to fake density");
    }
  });
  await test("two-parents-two-children-inline-profile-second-line", async () => {
    const seed = familySeed(); await load(seed, "en", false); await sampled(seed.runtime);
    assert.deepEqual(await resources().locator('article[data-session-id]').evaluateAll(nodes => nodes.map(n => n.dataset.sessionId)), seed.runtime, "each parent and its two children are adjacent in the same resource surface");
    assert.equal(await resources().locator('[data-family-id]').count(), 2, "two family blocks, not six independent cards");
    for (const parent of ["alpha", "beta"]) assert.deepEqual(await resources().locator(`[data-family-id="${parent}"] article[data-session-id]`).evaluateAll(nodes => nodes.map(n => n.dataset.sessionId)), [parent, parent + "-child-1", parent + "-child-2"], "parent and delegated children share exactly one family block");
    assert.equal(await page.locator('[class*="rowColumns"]').getByText("Subagent", { exact: true }).count(), 0, "no independent subagent column");
    assert.equal(await resources().locator('[data-kind="subagents"]').count(), 0, "no duplicate subagent side-detail block");
    for (const width of [1366, 1440]) {
      await page.setViewportSize({ width, height: width === 1366 ? 768 : 900 });
      for (const parent of ["alpha", "beta"]) for (const n of [1, 2]) {
        const id = `${parent}-child-${n}`; const child = resourceRow(id);
        await visible(child.getByText("Parent: Parent " + parent, { exact: true }));
        await visible(child.getByText("Assignment " + id, { exact: true }));
        await visible(child.getByText(/Catalog subagent status: running/i));
        const head = child.locator("header").first(), profile = head.getByText("audit-" + n, { exact: true });
        const nameBox = await head.locator("strong").first().boundingBox(), roleBox = await head.getByText("Subagent", { exact: true }).boundingBox(), profileBox = await profile.boundingBox(), statusBox = await head.locator('[class*="status"]').boundingBox();
        const alignment = { nameTop: nameBox.y, nameBottom: nameBox.y + nameBox.height, roleTop: roleBox.y, statusTop: statusBox.y, profileTop: profileBox.y, profileBottom: profileBox.y + profileBox.height, text: await profile.innerText() };
        results.push({ name: `profile-${id}-${width}`, evidence: alignment });
        assert.equal(alignment.text, "audit-" + n); assert.ok(Math.abs(alignment.profileTop - alignment.roleTop) <= 1 && Math.abs(alignment.statusTop - alignment.roleTop) <= 1 && alignment.profileTop >= alignment.nameBottom, "resource header identity/profile SECOND line, not third: " + JSON.stringify(alignment));
        const parentBox = await resourceRow(parent).boundingBox(), childBox = await child.boundingBox();
        assert.ok(childBox.x > parentBox.x && childBox.x < parentBox.x + 40, "child is indented, not a separate column");
      }
      await shot("family-groups-" + width);
    }
  });
  await test("multi-session-model-mcp-thinking-countdown-sample-isolation", async () => {
    await load(); const ids = [...getState().runtime]; await sampled(ids);
    const samples = [], meters = [];
    for (const id of ids) {
      const item = resourceRow(id), modelLine = await item.locator('[class*="modelLine"]').innerText();
      assert.ok(modelLine.includes("provider-" + id + "/model-" + id));
      assert.ok(await item.locator('[class*="modelLine"]').getByText(thinking(id), { exact: true }).count());
      assert.equal(await detail(id).getByRole("img", { name: new RegExp("^mcp-" + id + " ") }).count(), 1);
      for (const other of ids.filter(other => other !== id)) {
        assert.ok(!modelLine.includes("provider-" + other + "/model-" + other), "models never leak across IDs");
        assert.equal(await detail(id).getByRole("img", { name: new RegExp("^mcp-" + other + " ") }).count(), 0);
      }
      const sample = await item.locator('header [class*="age"]').innerText(); assert.match(sample, /^Sample /); samples.push({ id, sample, modelLine });
      meters.push({ id, reap: await detail(id).locator('[data-kind="timing"] [class*="meterFill"]').getAttribute("style"), mcp: await detail(id).locator('[data-kind="mcp"] [class*="meterFill"]').getAttribute("style") });
    }
    assert.ok(new Set(samples.map(s => s.sample)).size >= 2, "rows expose independently aged samples rather than a shared latest time");
    assert.equal(new Set(meters.map(m => m.reap)).size, ids.length, "own reap deadlines"); assert.equal(new Set(meters.map(m => m.mcp)).size, ids.length, "own MCP release deadlines");
    results.push({ name: "session-isolation", evidence: { samples, meters } });
    assert.equal(await resources().locator('article[data-session-id]').count(), ids.length, "all resident resources remain visible without selection");
    // Exclude ONLY StrictMode's cancelled initial discovery (no session query).
    // An aborted detail read remains a regression, never discarded from cadence.
    const attempts = requests.filter(e => e.stage === getStage() && URL.parse(e.url).pathname === "/api/agent/debug");
    const bootstrapAborts = attempts.filter(e => e.abortedAt && !URL.parse(e.url).searchParams.has("session"));
    const debug = attempts.filter(e => !bootstrapAborts.includes(e));
    const details = debug.filter(e => URL.parse(e.url).searchParams.has("session"));
    assert.ok(details.every(e => !e.abortedAt), "steady rotation never aborts its detail GETs");
    assert.ok(details.slice(1).every((e, i) => e.startedAt >= details[i].startedAt + details[i].elapsedMs), "detail GETs never overlap or fan out");
    const status = requests.filter(e => e.stage === getStage() && e.kind === "status");
    assert.ok(status.length > 0 && status.length <= details.length, "at most ONE model status GET per resource rotation slot");
    assert.ok(ids.every(id => status.some(e => e.targetId === id)), "status rotation covers every resident without fanout");
    for (const id of ids) assert.ok(status.filter(e => e.targetId === id).length <= details.filter(e => e.targetId === id).length, "model reads follow this session's resource slots");
    results.push({ name: "rotation-network", evidence: { bootstrapAborts, details, status } });
    assert.ok(ids.every(id => debug.some(e => URL.parse(e.url).searchParams.get("session") === id)), "default rotation covers all parent/child IDs");
    const gaps = debug.slice(1).map((e, i) => e.startedAt - debug[i].startedAt);
    assert.ok(gaps.every(gap => gap >= 1750), "one existing debug GET per 2s slot, not fanout: " + gaps);
    const catalogs = requests.filter(e => e.stage === getStage() && !e.abortedAt && URL.parse(e.url).pathname === "/api/sessions"); assert.equal(catalogs.length, 1, "catalog stays on 30s cadence during initial rotation");
    await shot("multi-session-isolation");
  });
  await test("model-status-failure-recovery-keeps-own-cache", async () => {
    await load({ runtime: ["alpha"] }); await sampled(["alpha"]); getState().modelFailure = true;
    await until(async () => assert.ok(requests.some(e => e.stage === getStage() && e.kind === "status" && e.status === 503)), "real status GET failure");
    await visible(resourceRow("alpha").getByText(/Model.*failed/i));
    const cached = await copyJson(); assert.equal(cached.liveModels.alpha.model.id, "model-alpha"); assert.equal(cached.liveModels.alpha.thinkingLevel, thinking("alpha")); assert.equal(cached.liveModels.alpha.failed, true);
    getState().modelFailure = false;
    await until(async () => assert.equal(await resourceRow("alpha").getByText(/Model.*failed/i).count(), 0), "model status recovers on its own rotation"); await shot("model-recovered");
  });
  await test("same-holder-three-sse-distinct-timing-and-missing-holder", async () => {
    await load({ multiStreams: true }); await visible(detail("alpha").locator('[data-kind="streams"]'));
    const streams = detail("alpha").locator('[data-kind="streams"]'), groups = streams.locator('[class*="streamGroup"]');
    assert.equal(await groups.count(), 3, "three same-holder connections plus TWO separate anonymous groups");
    const grouped = streams.locator('[data-holder="fixture-browser"]'); assert.equal(await grouped.count(), 1); await visible(grouped.getByText("SSE ×3", { exact: true }));
    const records = grouped.locator('[class*="streamRecord"]'); assert.equal(await records.count(), 3);
    const evidence = await records.allTextContents();
    for (const record of await records.all()) { const content = await record.innerText(); assert.match(content, /open /); assert.match(content, /connected|starting|Connecting/i); }
    assert.match(evidence[0], /write /); assert.match(evidence[1], /3 dropped/i); assert.match(evidence[2], /2(?:\.0)?\s*(?:KB|kB)/); assert.match(evidence[2], /write /);
    assert.notEqual(evidence[0], evidence[2], "each SSE retains its own clock fields");
    assert.equal(await groups.filter({ has: page.getByText("SSE ×1", { exact: true }) }).count(), 2, "missing holders never coalesce");
    results.push({ name: "sse-records", evidence }); await shot("same-holder-three-sse");
  });
  await test("cold-status-and-no-redundant-countdown-or-boundary", async () => {
    await load({ coldStatus: ["alpha"] }); await visible(resourceRow("alpha").getByText("Not resident at status read", { exact: true }));
    const text = await resourceRow("alpha").locator('[class*="modelLine"]').innerText(); assert.ok(!text.includes("provider-alpha/model-alpha"), "cold GET running:false cannot invent a model");
    assert.ok(!/Idle reset|Next idle check|Idle timeout/i.test(await detail("alpha").innerText()));
    assert.equal(await detail("alpha").locator('[data-kind="timing"] [class*="meterFill"]').count(), 1, "reap bar retained");
    assert.equal(await page.getByText(/Observation boundar|观测边界|觀測邊界/).count(), 0, "boundary block removed in full"); await shot("cold-and-clean");
  });
  await test("resource-own-scroll-reaches-twelfth-main", async () => {
    const seed = densitySeed(12); await load(seed, "en", false);
    await until(async () => assert.equal(await resources().locator('article[data-session-id]').count(), 12), "12 resident rows");
    for (const [width, height] of [[1366, 768], [1440, 900]]) {
      await desktopGeometry(width, height); await wheelOwn(resourceScroll());
      await resourceRow("main-12").scrollIntoViewIfNeeded();
      const evidence = { scroll: await resourceScroll().evaluate(e => ({ top: e.scrollTop, height: e.clientHeight, total: e.scrollHeight, bottom: e.getBoundingClientRect().bottom })), last: await resourceRow("main-12").boundingBox() };
      assert.ok(evidence.scroll.top > 0 && evidence.last.y >= 0 && evidence.last.y + evidence.last.height <= evidence.scroll.bottom + 1, "12th main reachable inside resource scroll: " + JSON.stringify(evidence));
      results.push({ name: "twelfth-main-" + width, evidence }); await shot("twelfth-main-" + width);
    }
  });
}
