import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const base = process.env.IM_E2E_URL || "http://127.0.0.1:30141";
const directory = process.env.IM_E2E_AGENT_DIR;
assert.ok(directory, "Provide the isolated dev server's IM_E2E_AGENT_DIR");
assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}/`), "Browser fixtures must use a temporary agent directory");
const project = join(directory, "im-source-e2e-project");
await mkdir(project, { recursive: true });
const manager = SessionManager.create(project, join(directory, "sessions", "--im-source-e2e--"));
const title = `IM source browser ${manager.getSessionId()}`;
manager.appendSessionInfo(title);
const timestamp = Date.now();
const appendReply = () => manager.appendMessage({
  role: "assistant", content: [{ type: "text", text: "Fixture response" }], timestamp,
  provider: "local", model: "fixture", api: "openai-completions", stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
manager.appendMessage({ role: "user", content: [{ type: "text", text: "Web-only fixture input" }], timestamp });
appendReply();
for (const [channel, requestId, botName] of [
  ["telegram", "10000000-0000-0000-0000-000000000001", "TG fixture bot"],
  ["weixin", "20000000-0000-0000-0000-000000000002", "WX fixture bot"],
]) {
  const id = manager.appendMessage({ role: "user", timestamp,
    content: [{ type: "text", text: `[IM request ${requestId}]\nRepeated IM fixture input` }],
  });
  manager.appendCustomEntry("pi-web:im-source", { version: 1, messageEntryId: id,
    source: { channel, requestId, botName, botId: channel, chatId: "42", senderId: "42", messageId: channel },
  });
  appendReply();
}
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await context.route(/^https?:\/\/([^/]+\.)?cat\.tossp\.com(?::\d+)?\//i,
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const mounted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/sessions" && !url.searchParams.has("summary");
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await mounted;
  await page.getByText(title, { exact: true }).click();
  const check = async () => {
    await page.getByText("Web-only fixture input", { exact: true }).waitFor();
    await page.getByText("Telegram", { exact: true }).waitFor();
    await page.getByText("WeChat", { exact: true }).waitFor();
    assert.equal(await page.getByText("Repeated IM fixture input", { exact: true }).count(), 2);
    assert.equal(await page.locator('span[title="TG fixture bot"]').count(), 1);
    assert.equal(await page.locator('span[title="WX fixture bot"]').count(), 1);
    assert.ok(!(await page.locator("body").innerText()).includes("[IM request "));
  };
  await check();
  await page.screenshot({ path: "/tmp/pi-im-source-desktop.png" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await check();
  assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "/tmp/pi-im-source-mobile.png" });
  assert.deepEqual(errors, []);
  console.log("IM source browser checks passed: Web/Telegram/WeChat, hidden request markers, refresh, mobile layout.");
} finally {
  await browser.close();
}
