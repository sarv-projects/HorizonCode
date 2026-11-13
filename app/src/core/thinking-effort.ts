/**
 * C-11: map user intent to provider thinking effort.
 * Explicit `ultrathink` / env / config win; optional auto classifier via `HZ_THINKING_AUTO=1`.
 */

import { autoThinkingEffortFromText } from "./decision-helper";

/** Ordered rungs; auto routing when `autoDifficulty` is enabled. */
export const THINKING_RUNGS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingRung = (typeof THINKING_RUNGS)[number];

const ULTRATHINK = /\bultrathink\b/i;

export function parseThinkingRung(raw: string | undefined): ThinkingRung | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "off" || v === "inherit") return undefined;
  return (THINKING_RUNGS as readonly string[]).includes(v) ? (v as ThinkingRung) : undefined;
}

/** Explicit `ultrathink` in the user text requests the top rung. */
export function ultrathinkInText(text: string): boolean {
  return ULTRATHINK.test(text);
}

export interface ResolveThinkingEffortInput {
  userText: string;
  /** Config file or env default when set. */
  configured?: string;
  envValue?: string;
  /** When true (`HZ_THINKING_AUTO=1`), run the deterministic difficulty classifier. */
  autoDifficulty?: boolean;
}

export interface ResolvedThinkingEffort {
  effort?: ThinkingRung;
  source?: "ultrathink" | "env" | "config" | "auto";
}

/**
 * Resolve effort for one turn. Priority: ultrathink keyword > HZ_THINKING_EFFORT >
 * configured default > auto classifier (when enabled).
 */
export function resolveThinkingEffort(input: ResolveThinkingEffortInput): ResolvedThinkingEffort {
  if (ultrathinkInText(input.userText)) return { effort: "xhigh", source: "ultrathink" };
  const fromEnv = parseThinkingRung(input.envValue);
  if (fromEnv !== undefined) return { effort: fromEnv, source: "env" };
  const fromCfg = parseThinkingRung(input.configured);
  if (fromCfg !== undefined) return { effort: fromCfg, source: "config" };
  if (input.autoDifficulty === true) {
    const choice = autoThinkingEffortFromText(input.userText);
    return { effort: choice.pick, source: "auto" };
  }
  return {};
}

/** Wire value for OpenAI `reasoning_effort` (and cousins). */
export function toProviderReasoningEffort(rung: ThinkingRung): string {
  return rung;
}
