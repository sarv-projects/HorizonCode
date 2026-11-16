/**
 * C-11: map user intent to provider thinking effort.
 * Explicit `ultrathink` / env / config win; when effort is unset, a cheap
 * difficulty heuristic picks a rung capped one tier below max (ruling **464**).
 * `HZ_THINKING_AUTO=0` disables the default-on auto path.
 */

import { autoThinkingEffortFromText } from "./decision-helper";

/** Ordered rungs; last is max (ultrathink-only); auto ceiling is one below. */
export const THINKING_RUNGS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingRung = (typeof THINKING_RUNGS)[number];

const ULTRATHINK = /\bultrathink\b/i;

/** Auto / unset path never reaches the top rung — only explicit `ultrathink` does. */
export function autoThinkingCeiling(): ThinkingRung {
  return THINKING_RUNGS[THINKING_RUNGS.length - 2]!;
}

/** Clamp a rung so auto routing stays ≤ one tier below max. */
export function capAtAutoThinkingCeiling(rung: ThinkingRung): ThinkingRung {
  const ceiling = autoThinkingCeiling();
  const ceilIdx = THINKING_RUNGS.indexOf(ceiling);
  const rungIdx = THINKING_RUNGS.indexOf(rung);
  return rungIdx > ceilIdx ? ceiling : rung;
}

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

/**
 * Parse `HZ_THINKING_AUTO`: unset/`1`/`true` → enabled; `0`/`false`/`off` → disabled.
 * When effort is otherwise unset, enabled means run the cheap heuristic (default-on).
 */
export function parseThinkingAutoFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

export interface ResolveThinkingEffortInput {
  userText: string;
  /** Config file or env default when set. */
  configured?: string;
  envValue?: string;
  /**
   * When true (default when effort unset), run the deterministic difficulty
   * classifier capped at {@link autoThinkingCeiling}. Pass false for `HZ_THINKING_AUTO=0`.
   */
  autoDifficulty?: boolean;
}

export interface ResolvedThinkingEffort {
  effort?: ThinkingRung;
  source?: "ultrathink" | "env" | "config" | "auto";
}

/**
 * Resolve effort for one turn. Priority: ultrathink keyword > HZ_THINKING_EFFORT >
 * configured default > auto heuristic when effort unset (unless autoDifficulty === false).
 */
export function resolveThinkingEffort(input: ResolveThinkingEffortInput): ResolvedThinkingEffort {
  if (ultrathinkInText(input.userText)) return { effort: "xhigh", source: "ultrathink" };
  const fromEnv = parseThinkingRung(input.envValue);
  if (fromEnv !== undefined) return { effort: fromEnv, source: "env" };
  const fromCfg = parseThinkingRung(input.configured);
  if (fromCfg !== undefined) return { effort: fromCfg, source: "config" };
  // Default-on when effort unset (ruling 464); explicit false opts out.
  if (input.autoDifficulty !== false) {
    const choice = autoThinkingEffortFromText(input.userText);
    return { effort: capAtAutoThinkingCeiling(choice.pick), source: "auto" };
  }
  return {};
}

/** Wire value for OpenAI `reasoning_effort` (and cousins). */
export function toProviderReasoningEffort(rung: ThinkingRung): string {
  return rung;
}
