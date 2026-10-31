import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("./DebugPageView.module.css", import.meta.url), "utf8");
const page = css.match(/\.page\s*\{([^}]+)\}/)?.[1] ?? "";
const colors = Object.fromEntries([...page.matchAll(/(--dbg-[\w-]+):\s*(#[\da-f]{6})\b/gi)].map(([, key, value]) => [key, value]));

test("the dashboard owns its night palette without changing workspace theme selectors", () => {
  assert.match(page, /color-scheme:\s*dark/);
  assert.doesNotMatch(css, /:global\([^)]*(?:data-theme|\.dark)/);
  for (const key of ["paper", "card", "inset", "ink", "muted", "dim", "accent", "violet", "ok", "warn", "err"]) {
    assert.ok(colors[`--dbg-${key}`], `missing palette color: ${key}`);
  }
  assert.equal(new Set(["accent", "violet", "ok", "warn", "err"].map(key => colors[`--dbg-${key}`])).size, 5);
});

test("primary, secondary and status text retain 4.5:1 contrast on dashboard surfaces", () => {
  const backgrounds = [colors["--dbg-paper"], colors["--dbg-card"], colors["--dbg-inset"], "#1b3047"];
  for (const key of ["ink", "muted", "dim", "accent", "violet", "ok", "warn", "err"]) {
    for (const background of backgrounds) {
      const foregroundLight = luminance(colors[`--dbg-${key}`]);
      const backgroundLight = luminance(background);
      const ratio = (Math.max(foregroundLight, backgroundLight) + 0.05) / (Math.min(foregroundLight, backgroundLight) + 0.05);
      assert.ok(ratio >= 4.5, `${key} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(channel => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
