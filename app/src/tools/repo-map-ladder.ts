/**
 * B-2 reduced (docs/30): per-call relevance budget expansion when no focus
 * files are named, plus a 3-step map fallback ladder (focus → whole repo →
 * max-budget unhinted). ADAPT aider `get_repo_map` / `map_mul_no_files`.
 */

import {
  buildRepoMap,
  DEFAULT_MAX_TOKENS,
  HARD_MAX_TOKENS,
  type RepoMapOptions,
  type RepoMapResult,
} from "./repo-map";

/** Default token budget multiplier when the model named no focus paths (aider `map_mul_no_files`). */
export const NO_FOCUS_BUDGET_MULTIPLIER = 2;

export type RepoMapLadderStep = "focus" | "repo" | "plain";

export function effectiveRepoMapBudget(focus: string[] | undefined, requested?: number): number {
  const base = Math.max(64, Math.min(requested ?? DEFAULT_MAX_TOKENS, HARD_MAX_TOKENS));
  if ((focus?.length ?? 0) > 0) return base;
  return Math.min(HARD_MAX_TOKENS, Math.max(base, base * NO_FOCUS_BUDGET_MULTIPLIER));
}

function annotate(map: string, step: RepoMapLadderStep): string {
  if (map.includes(", ladder: ")) return map;
  const at = map.indexOf("\n[repo_map:");
  if (at === -1) return `${map}\n[ladder: ${step}]`;
  const close = map.indexOf("]", at);
  if (close === -1) return map;
  return `${map.slice(0, close)}, ladder: ${step}${map.slice(close)}`;
}

export type RepoMapLadderResult = RepoMapResult & { ladderStep: RepoMapLadderStep };

/** Build a map, climbing the ladder when an earlier step yields nothing renderable. */
export function buildRepoMapWithLadder(opts: RepoMapOptions): RepoMapLadderResult | { empty: true } {
  const hasFocus = (opts.focus?.length ?? 0) > 0;
  const tokenBudget = effectiveRepoMapBudget(opts.focus, opts.maxTokens);

  const tryStep = (step: RepoMapLadderStep, patch: Partial<RepoMapOptions>): RepoMapResult | { empty: true } =>
    buildRepoMap({ ...opts, ...patch, maxTokens: patch.maxTokens ?? tokenBudget });

  if (hasFocus) {
    const focus = tryStep("focus", { focus: opts.focus });
    if (!("empty" in focus) && focus.filesIncluded > 0) {
      return { ...focus, map: annotate(focus.map, "focus"), ladderStep: "focus" };
    }
  }

  const repo = tryStep("repo", { focus: [] });
  if (!("empty" in repo) && repo.filesIncluded > 0) {
    return { ...repo, map: annotate(repo.map, "repo"), ladderStep: "repo" };
  }

  const plain = tryStep("plain", { focus: [], maxTokens: HARD_MAX_TOKENS });
  if ("empty" in plain) return plain;
  return { ...plain, map: annotate(plain.map, "plain"), ladderStep: "plain" };
}
