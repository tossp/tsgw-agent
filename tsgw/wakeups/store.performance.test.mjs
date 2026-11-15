import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { WakeupStore } = await createJiti(import.meta.url).import("./store.ts");

function percentile(samples, fraction) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
}

function tasksAtSize(count, bytes) {
  const base = {
    wakeupId: "000000", sourceSessionId: "source", targetSessionId: "target",
    createdAt: "2026-11-16T00:00:00.000Z", scheduledAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z", message: "", status: "pending",
  };
  const overhead = Buffer.byteLength(JSON.stringify(base)) + 1;
  const message = "x".repeat(Math.floor((bytes - 24) / count) - overhead);
  return Array.from({ length: count }, (_, i) => ({ ...base, wakeupId: String(i).padStart(6, "0"), message }));
}

// Explicit measurement only; disk/CPU timings are not stable CI assertions.
// WAKEUP_STORE_BENCHMARK=1 node --experimental-strip-types --test tsgw/wakeups/store.performance.test.mjs
test("measure atomic saves and event-loop stalls at daily and stress sizes", {
  skip: process.env.WAKEUP_STORE_BENCHMARK !== "1",
}, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "wakeup-store-benchmark-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WakeupStore(join(root, "wakeups", "state.json"));
  for (const [count, targetBytes, iterations, warmups] of [
    [1_000, 8 * 1024 * 1024, 30, 3],
    [10_000, 64 * 1024 * 1024, 6, 1],
  ]) {
    const tasks = tasksAtSize(count, targetBytes);
    for (let i = 0; i < warmups; i++) store.save(tasks);
    const saves = [];
    const stalls = [];
    for (let i = 0; i < iterations; i++) {
      const queuedAt = performance.now();
      const immediate = new Promise((resolve) => setImmediate(() => resolve(performance.now() - queuedAt)));
      const started = performance.now();
      store.save(tasks);
      saves.push(performance.now() - started);
      stalls.push(await immediate);
    }
    const started = performance.now();
    assert.equal(store.read().length, count);
    const readMs = performance.now() - started;
    const fileBytes = fs.statSync(join(root, "wakeups", "state.json")).size;
    t.diagnostic(JSON.stringify({
      count, fileBytes, MiB: +(fileBytes / 1024 / 1024).toFixed(3), iterations, warmups,
      saveMs: {
        p50: +percentile(saves, 0.50).toFixed(2), p95: +percentile(saves, 0.95).toFixed(2),
        max: +Math.max(...saves).toFixed(2),
      },
      eventLoopStallMs: {
        p50: +percentile(stalls, 0.50).toFixed(2), p95: +percentile(stalls, 0.95).toFixed(2),
        max: +Math.max(...stalls).toFixed(2),
      },
      readMs: +readMs.toFixed(2),
    }));
  }
});
