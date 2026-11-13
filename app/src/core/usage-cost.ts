/**
 * H-2 reduced (docs/30): cache-write / cache-read token fields and a rough USD
 * estimate when adapters expose usage (ADAPT aider cost accounting).
 */

import type { Usage } from "../contracts";

export interface UsageCostBreakdown {
  inputUsd?: number;
  outputUsd?: number;
  cacheWriteUsd?: number;
  cacheReadUsd?: number;
  totalUsd?: number;
}

/** Per-1M-token rates (harness estimates, not billing truth). */
export interface ModelRateTable {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM?: number;
  cacheReadPerM?: number;
}

const DEFAULT_RATES: ModelRateTable = {
  inputPerM: 3,
  outputPerM: 15,
  cacheWritePerM: 3.75,
  cacheReadPerM: 0.3,
};

export function ratesForModel(provider: string, model: string): ModelRateTable {
  const p = provider.toLowerCase();
  const m = model.toLowerCase();
  if (p === "anthropic" || m.includes("claude")) return DEFAULT_RATES;
  if (p === "openai" || m.includes("gpt")) {
    return { inputPerM: 2.5, outputPerM: 10, cacheWritePerM: 2.5, cacheReadPerM: 1.25 };
  }
  return DEFAULT_RATES;
}

export function enrichUsageCost(usage: Usage, provider: string, model: string): Usage & { cost?: UsageCostBreakdown } {
  const rates = ratesForModel(provider, model);
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const billableInput = Math.max(0, input - cacheWrite - cacheRead);

  const inputUsd = (billableInput / 1_000_000) * rates.inputPerM;
  const outputUsd = (output / 1_000_000) * rates.outputPerM;
  const cacheWriteUsd =
    cacheWrite > 0 ? (cacheWrite / 1_000_000) * (rates.cacheWritePerM ?? rates.inputPerM * 1.25) : 0;
  const cacheReadUsd = cacheRead > 0 ? (cacheRead / 1_000_000) * (rates.cacheReadPerM ?? rates.inputPerM * 0.1) : 0;
  const totalUsd = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd;

  const out: Usage & { cost?: UsageCostBreakdown } = { ...usage };
  if (totalUsd > 0 || cacheWrite > 0 || cacheRead > 0) {
    out.cost = {
      inputUsd: inputUsd || undefined,
      outputUsd: outputUsd || undefined,
      cacheWriteUsd: cacheWriteUsd || undefined,
      cacheReadUsd: cacheReadUsd || undefined,
      totalUsd: totalUsd || undefined,
    };
  }
  return out;
}
