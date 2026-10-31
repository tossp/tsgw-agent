import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { DEBUG_PAGE_MESSAGES, debugPageText } = await jiti.import("./messages.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW.ts");

const locales = ["en", "zh-CN", "zh-TW"];

test("every locale carries every one of the page's own strings, none empty", () => {
  const keys = Object.keys(DEBUG_PAGE_MESSAGES.en).sort();
  assert.ok(keys.length >= 10, keys.join(", "));
  for (const locale of locales) {
    assert.deepEqual(Object.keys(DEBUG_PAGE_MESSAGES[locale]).sort(), keys, locale);
    for (const key of keys) {
      const message = DEBUG_PAGE_MESSAGES[locale][key];
      assert.equal(typeof message, "string", `${locale} ${key}`);
      assert.ok(message.trim().length > 0, `${locale} ${key}`);
    }
  }
});

test("the placeholders of a string are the same in every locale", () => {
  for (const key of Object.keys(DEBUG_PAGE_MESSAGES.en)) {
    const names = (message) => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
    const english = names(DEBUG_PAGE_MESSAGES.en[key]);
    for (const locale of locales) {
      assert.deepEqual(names(DEBUG_PAGE_MESSAGES[locale][key]), english, `${locale} ${key}`);
    }
  }
});

test("the page's strings are its own: no global key is redefined here", () => {
  for (const locale of locales) {
    const global = { en: enLocale, "zh-CN": zhCNLocale, "zh-TW": zhTWLocale }[locale].messages;
    for (const key of Object.keys(DEBUG_PAGE_MESSAGES[locale])) {
      assert.equal(global[key], undefined, `${locale} ${key} shadows a global translation`);
    }
  }
});

test("a string is looked up in its locale, interpolated, and never silently English-only", () => {
  assert.equal(debugPageText("en", "detail.history"), "Process history");
  assert.equal(debugPageText("zh-CN", "detail.history"), "进程历史");
  assert.equal(debugPageText("zh-TW", "detail.history"), "行程歷史");
  assert.equal(debugPageText("en", "page.staleCount", { count: 3 }), "3 failures in a row");
  assert.equal(debugPageText("zh-CN", "page.staleCount", { count: 3 }), "连续失败 3 次");
  // No locale falls back to English for a key it has.
  for (const key of Object.keys(DEBUG_PAGE_MESSAGES.en)) {
    if (key === "page.readOnly") continue;
    assert.notEqual(debugPageText("zh-CN", key), debugPageText("en", key), key);
  }
});
