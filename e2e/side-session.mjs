import assert from "node:assert/strict";
import { join } from "node:path";

/** Real /side creation and a live panel, without sending a prompt to a model. */
export async function checkSideSession({ browser, base, artifacts, parentSessionId }) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    await context.route("https://cat.tossp.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let sideId;
    try {
      await page.goto(`${base}/?session=${parentSessionId}`, { waitUntil: "domcontentloaded" });
      const composer = page.locator("textarea").first();
      await composer.waitFor();
      await composer.fill("/side");
      const created = page.waitForResponse((response) => (
        new URL(response.url()).pathname === `/api/sessions/${parentSessionId}/fork`
        && response.request().method() === "POST"
      ));
      if (viewport.width < 600) await page.getByRole("button", { name: "Send", exact: true }).click();
      else await composer.press("Enter");
      const response = await created;
      assert.equal(response.status(), 200);
      const result = await response.json();
      sideId = result.sessionId;
      assert.deepEqual(result.session.relation, { kind: "side", parentSessionId });
      assert.equal(new URL(page.url()).searchParams.get("session"), parentSessionId);

      const panel = page.locator("#file-panel");
      await panel.waitFor({ state: "visible" });
      await panel.getByText("Side chat starts here", { exact: true }).waitFor();
      assert.equal(await panel.locator("textarea").count(), 1, "the panel is a full chat, not the old read-only viewer");
      assert.equal(await page.locator(`a[href*="session=${sideId}"]`).count(), 0, "side chats have no independent sidebar row");
      assert.equal(await page.getByRole("status").filter({ hasText: /subagent.*running/ }).count(), 0);

      const toolsResponse = await context.request.post(`${base}/api/agent/${sideId}`, { data: { type: "get_tools" } });
      assert.equal(toolsResponse.status(), 200);
      const { success, data: tools } = await toolsResponse.json();
      assert.equal(success, true);
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["bash", "read"]);
      await panel.locator("textarea").fill("An unsent side-chat draft");
      assert.equal(await composer.inputValue(), "", "the side composer does not overwrite the main draft");
      await page.reload({ waitUntil: "domcontentloaded" });
      await panel.getByText("Side chat starts here", { exact: true }).waitFor();
      assert.equal(await panel.locator("textarea").count(), 1, "the side tab restores its full chat after reload");
      assert.equal(new URL(page.url()).searchParams.get("session"), parentSessionId);
      await page.screenshot({ path: join(artifacts, `side-session-${viewport.width}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS: ${viewport.width}px /side inherits context, restores its full composer, stays hidden and keeps upstream tools`);
    } finally {
      await context.close();
      if (sideId) {
        const deleted = await fetch(`${base}/api/sessions/${sideId}`, { method: "DELETE" });
        assert.ok(deleted.ok, "remove only the side chat created by this check");
        assert.equal((await fetch(`${base}/api/sessions/${parentSessionId}`)).status, 200);
      }
    }
  }
}
