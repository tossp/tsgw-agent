import assert from "node:assert/strict";
import { chromium } from "playwright";

// Run against an isolated dev server. All IM writes are intercepted, never real credentials.
const base = process.env.IM_E2E_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true });
const errors = [];
const actions = [];
const cwd = "/tmp/im-browser-project";
const bot = { id: "tg-test", channel: "telegram", name: "Test Telegram", cwd, enabled: true,
  allowedUserIds: ["42"], allowedChatIds: [], username: "test_bot", status: { state: "connected" },
  deliveryError: "Reply delivery failed" };
const conversation = { key: '["tg-test","-100","7"]', botId: bot.id, chatId: "-100", threadId: "7",
  title: "Test group", sessionId: "old", cwd, updatedAt: new Date().toISOString() };
const snapshot = { bots: [bot], conversations: [conversation] };
let qrPolls = 0;
let page;
try {
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
  await page.route("**/api/cat-config", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/tsgw/im**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let result = snapshot;
    if (request.method() === "GET" && url.searchParams.has("cwd")) {
      result = { sessions: [{ id: "old", title: "Old session", cwd }, { id: "existing", title: "Existing Web session", cwd }] };
    } else if (request.method() === "POST") {
      const action = request.postDataJSON();
      actions.push(action);
      if (action.action === "bind") conversation.sessionId = action.sessionId;
      if (action.action === "update-bot") Object.assign(bot, action);
      if (action.action === "login-weixin") result = { id: "qr", state: "waiting", qrImage: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" };
      if (action.action === "poll-weixin") { qrPolls++; result = { id: "qr", state: "waiting" }; }
    }
    await route.fulfill({ json: result });
  });
  // Like e2e/directory-picker.mjs, wait for the mounted sidebar before the first click.
  const mounted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/sessions" && !url.searchParams.has("summary");
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await mounted;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Messaging", exact: true }).click();
  await page.getByRole("button", { name: /Test Telegram/ }).click();
  await page.getByRole("alert").filter({ hasText: bot.deliveryError }).waitFor();
  await page.getByRole("status").filter({ hasText: "Connected · Telegram" }).waitFor();
  await page.getByLabel("Linked Pi session").selectOption("existing");
  await page.waitForFunction(() => document.querySelector("select")?.value === "existing");
  assert.ok(actions.some((action) => action.action === "bind" && action.sessionId === "existing"));
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Start", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("New bot");
  await page.getByLabel("Project directory", { exact: true }).fill(cwd);
  await page.getByLabel("Bot Token", { exact: true }).fill("123:fake_token");
  await page.getByLabel("Allowed user IDs", { exact: true }).fill("42, 43");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[type="password"]')?.value === "");
  assert.deepEqual(actions.find((action) => action.action === "add-telegram")?.allowedUserIds, ["42", "43"]);
  await page.getByRole("radio", { name: "WeChat", exact: true }).check();
  await page.getByRole("button", { name: "Get WeChat QR code", exact: true }).click();
  await page.getByAltText("Scan this code with WeChat").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByAltText("Scan this code with WeChat").waitFor({ state: "hidden" });
  assert.ok(actions.some((action) => action.action === "cancel-weixin"));
  assert.equal(qrPolls, 0);
  assert.ok(!await page.locator("body").innerText().then((text) => text.includes("fake_token")));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("IM browser checks passed: independent delivery error, Telegram config, Topic binding, stop, WeChat QR cancellation, mobile layout.");
} catch (error) {
  if (page) {
    await page.screenshot({ path: "/tmp/pi-im-e2e-failure.png" });
    console.error((await page.locator("body").innerText()).slice(0, 3500));
  }
  throw error;
} finally {
  await browser.close();
}
