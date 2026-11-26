/**
 * usage-invariant.ts -- pure Usage arithmetic validator (plan Task 6).
 *
 * Missing fields are unknown, not zero and never fabricated. No field is
 * mutated; the validator only returns named violations for notices.
 */

import type { Usage } from "../../contracts";

export interface UsageInvariantResult {
  ok: boolean;
  violations: string[];
}

const NUMERIC_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "nonCachedInputTokens",
  "totalTokens",
] as const;

export function checkUsageInvariant(usage: Usage): UsageInvariantResult {
  const violations: string[] = [];
  const add = (field: string): void => {
    if (!violations.includes(field)) violations.push(field);
  };
  const value = (field: (typeof NUMERIC_FIELDS)[number]): number | undefined => {
    const raw = usage[field];
    if (raw === undefined) return undefined;
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      add(field);
      return undefined;
    }
    return raw;
  };

  const numbers = new Map<string, number>();
  for (const field of NUMERIC_FIELDS) {
    const parsed = value(field);
    if (parsed !== undefined) numbers.set(field, parsed);
  }
  const get = (field: (typeof NUMERIC_FIELDS)[number]): number | undefined => numbers.get(field);

  const input = get("inputTokens");
  const output = get("outputTokens");
  const reasoning = get("reasoningTokens");
  if (reasoning !== undefined && output !== undefined && reasoning > output) add("reasoningTokens");

  const cacheRead = get("cacheReadInputTokens");
  const cacheWrite = get("cacheWriteInputTokens") ?? get("cacheCreationInputTokens");
  const anyCache = cacheRead !== undefined || cacheWrite !== undefined;
  const cacheTotal = (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (anyCache && input !== undefined && cacheTotal > input) add("cacheInputTokens");

  const nonCached = get("nonCachedInputTokens");
  if (nonCached !== undefined && input !== undefined && nonCached !== input - cacheTotal) {
    add("nonCachedInputTokens");
  }

  const total = get("totalTokens");
  if (total !== undefined && input !== undefined && output !== undefined && total !== input + output) {
    add("totalTokens");
  }

  return { ok: violations.length === 0, violations };
}

export function formatUsageInvariantNotice(result: UsageInvariantResult): string {
  if (result.ok) return "usage invariant: ok";
  return `usage invariant: suspicious fields (${result.violations.join(", ")}); values are reported as-is, never guessed`;
}
