import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/** Pi's input excludes cache reads/writes; Sentry's input includes them. Costs are Pi's USD estimates. */
export function requestAttributes(model: Model<Api>, message: AssistantMessage): Record<string, string | number> {
  const attributes: Record<string, string | number> = { "gen_ai.response.model": message.model };
  const usage = message.usage;
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  // Pi synthesizes all-zero usage for failures with no provider usage report.
  const missingFailureUsage = (message.stopReason === "error" || message.stopReason === "aborted")
    && counts.every((value) => value === 0);
  if (!missingFailureUsage && counts.every((value) => Number.isFinite(value) && value >= 0)) {
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    attributes["gen_ai.usage.input_tokens"] = input;
    attributes["gen_ai.usage.output_tokens"] = usage.output;
    attributes["gen_ai.usage.total_tokens"] = input + usage.output;
    attributes["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
    attributes["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWrite;
  }
  // Unconfigured prices are represented by zeros in Pi. Do not display unknown cost as free.
  let price = model.cost;
  let threshold = -1;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // Match Pi calculateCost's strict threshold and highest applicable tier.
  for (const tier of model.cost?.tiers ?? []) {
    if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      price = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  const priced = price && [price.input, price.output, price.cacheRead, price.cacheWrite]
    .some((value) => Number.isFinite(value) && value > 0);
  if (priced && !missingFailureUsage && Number.isFinite(usage.cost.total) && usage.cost.total >= 0) {
    attributes["gen_ai.cost.total_tokens"] = usage.cost.total;
  }
  return attributes;
}
