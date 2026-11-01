import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { calculateCost } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const { requestAttributes } = await jiti.import("./usage.ts");
const model = { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const message = (stopReason, usage = zero) => ({
  model: "test-model", stopReason,
  usage: { ...usage, cost: { total: 0 } },
});

test("failed requests with SDK synthetic zero usage do not claim free or zero-token consumption", () => {
  for (const stopReason of ["error", "aborted"]) {
    assert.deepEqual(requestAttributes(model, message(stopReason)), { "gen_ai.response.model": "test-model" });
  }
});

test("partial usage on failed or cancelled requests remains visible", () => {
  for (const stopReason of ["error", "aborted"]) {
    const result = requestAttributes(model, message(stopReason, { input: 7, output: 2, cacheRead: 3, cacheWrite: 1 }));
    assert.equal(result["gen_ai.usage.input_tokens"], 11);
    assert.equal(result["gen_ai.usage.output_tokens"], 2);
    assert.equal(result["gen_ai.usage.total_tokens"], 13);
    assert.equal(result["gen_ai.cost.total_tokens"], 0);
  }
});

test("cost presence follows Pi's actually selected tier, including strict threshold and cache input", () => {
  const cases = [
    { cost: { ...zero, tiers: [{ ...model.cost, inputTokensAbove: 200 }] }, input: 200, cacheRead: 0, priced: false },
    { cost: { ...zero, tiers: [{ ...model.cost, inputTokensAbove: 200 }] }, input: 200, cacheRead: 1, priced: true },
    { cost: { ...model.cost, tiers: [{ ...zero, inputTokensAbove: 200 }] }, input: 201, cacheRead: 0, priced: false },
    { cost: { ...zero, tiers: [{ ...model.cost, inputTokensAbove: 200 }, { ...zero, inputTokensAbove: 100 }] }, input: 201, cacheRead: 0, priced: true },
    { cost: { ...zero, tiers: [{ ...model.cost, inputTokensAbove: 200 }, { ...zero, inputTokensAbove: 100 }] }, input: 200, cacheRead: 0, priced: false },
  ];
  for (const { cost, input, cacheRead, priced } of cases) {
    const configured = { cost };
    const response = message("stop", { input, output: 5, cacheRead, cacheWrite: 0 });
    calculateCost(configured, response.usage);
    const actual = requestAttributes(configured, response)["gen_ai.cost.total_tokens"];
    assert.equal(actual, priced ? response.usage.cost.total : undefined);
    if (priced) assert.ok(actual > 0);
  }
});

test("invalid upstream counts and prices never become non-finite telemetry attributes", () => {
  const result = requestAttributes(model, {
    ...message("stop", { input: NaN, output: 2, cacheRead: -1, cacheWrite: 0 }),
    usage: { input: NaN, output: 2, cacheRead: -1, cacheWrite: 0, cost: { total: Infinity } },
  });
  assert.deepEqual(result, { "gen_ai.response.model": "test-model" });
});
