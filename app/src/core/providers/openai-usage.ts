/**
 * openai-usage.ts — pure, additive OpenAI-compatible usage decoder.
 *
 * ADAPT of opencode's `packages/ai/src/protocols/openai-chat.ts` `mapUsage`
 * plus its `ProviderShared` token helpers (sum/subtract/total). No runtime
 * dependencies, no I/O, no dynamic import: given a raw `usage` object from a
 * chat-completions frame it returns HorizonCode's `Usage` contract.
 *
 * OpenAI-compatible hosts disagree on where they put the cache/reasoning
 * breakdown. Every known dialect is read here, in precedence order:
 *   cached read:  prompt_tokens_details.cached_tokens (OpenAI),
 *                 prompt_cache_hit_tokens (DeepSeek), cached_tokens (Zai),
 *                 cache_read_input_tokens (DigitalOcean / Anthropic-style)
 *   cache write:  prompt_tokens_details.cache_write_tokens,
 *                 cache_created_input_tokens,
 *                 cache_creation_input_tokens (kept for backwards compat)
 *   reasoning:    completion_tokens_details.reasoning_tokens,
 *                 reasoning_tokens
 *
 * `inputTokens` / `outputTokens` stay the provider's INCLUSIVE totals (matching
 * the AI.Usage contract and opencode's mapUsage). `nonCachedInputTokens` is the
 * derived non-overlapping breakdown. `totalTokens` prefers the provider's own
 * `total_tokens` and otherwise falls back to input + output.
 *
 * Two special cases are handled explicitly:
 *   - Moonshot (and kin) put usage on `choice.usage` instead of top-level
 *     `usage`; the caller applies that precedence (see openai.ts).
 *   - Copilot's Gemini wrapper counts reasoning BESIDE `completion_tokens`
 *     rather than inside it. When `total_tokens === input + completion +
 *     reasoning`, the true output is completion + reasoning.
 */

import type { Usage } from "../../contracts";

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First defined (not first truthy) number — a reported `0` is meaningful. */
function firstNum(...values: Array<number | undefined>): number | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/**
 * Decode one OpenAI-compatible `usage` object into the additive `Usage` shape.
 * Returns `undefined` when the frame carries no numeric token counts at all, so
 * callers never publish a fabricated `0`.
 */
export function mapOpenAiUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;

  const promptDetails = asRecord(u.prompt_tokens_details);
  const completionDetails = asRecord(u.completion_tokens_details);

  const input = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const cached = firstNum(
    promptDetails && num(promptDetails.cached_tokens),
    num(u.prompt_cache_hit_tokens),
    num(u.cached_tokens),
    num(u.cache_read_input_tokens),
    promptDetails && num(promptDetails.cache_read_input_tokens),
  );
  const cacheWrite = firstNum(
    promptDetails && num(promptDetails.cache_write_tokens),
    num(u.cache_created_input_tokens),
    num(u.cache_creation_input_tokens),
    num(u.cache_write_input_tokens),
  );
  const reasoning = firstNum(
    completionDetails && num(completionDetails.reasoning_tokens),
    num(u.reasoning_tokens),
    completionDetails && num(completionDetails.reasoning),
  );
  const reportedTotal = num(u.total_tokens);

  // Copilot's Gemini counts reasoning beside completion, not inside it; the
  // reported total disambiguates the two conventions.
  const reasoningIsBesideOutput =
    input !== undefined &&
    completion !== undefined &&
    reasoning !== undefined &&
    reportedTotal !== undefined &&
    reportedTotal === input + completion + reasoning;
  const output = reasoningIsBesideOutput ? completion + reasoning : completion;

  // Keep the plain { prompt_tokens, completion_tokens } frame byte-for-byte
  // compatible with the historical usage event: only publish the derived
  // breakdown fields when the frame actually carries a breakdown signal.
  const hasBreakdown =
    cached !== undefined ||
    cacheWrite !== undefined ||
    reasoning !== undefined ||
    reportedTotal !== undefined;

  const out: Usage = {};
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cached !== undefined) out.cacheReadInputTokens = cached;
  if (cacheWrite !== undefined) {
    out.cacheWriteInputTokens = cacheWrite;
    // Backwards-compatible alias: the old openai.ts mapped
    // `cache_creation_input_tokens` to this field.
    out.cacheCreationInputTokens = cacheWrite;
  }
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  if (input !== undefined && hasBreakdown) {
    out.nonCachedInputTokens = Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0));
  }
  if (hasBreakdown) {
    const total = reportedTotal ?? (input !== undefined && output !== undefined ? input + output : undefined);
    if (total !== undefined) out.totalTokens = total;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
