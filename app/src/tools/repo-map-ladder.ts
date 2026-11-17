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
import { DEFAULT_WINDOW_TOKENS } from "../core/output-budget";

/** Default token budget multiplier when the model named no focus paths (aider `map_mul_no_files`, CLI default 2). */
export const NO_FOCUS_BUDGET_MULTIPLIER = 2;
/** Env override for that multiplier (aider `--map-multiplier-no-files` equivalent). */
export const MAP_MULTIPLIER_NO_FILES_ENV = "HZ_MAP_MULTIPLIER_NO_FILES";
/**
 * Aider `repomap.py`: `min(int(max_map_tokens * map_mul_no_files),
 * max_context_window - padding)` with padding 4096. HorizonCode previously had
 * NO context-window cap on the repo-map budget; this closes that gap.
 */
export const REPO_MAP_CONTEXT_PADDING = 4096;
/** Conservative default when the caller supplies no model context window. */
export const DEFAULT_REPO_MAP_CONTEXT_WINDOW = DEFAULT_WINDOW_TOKENS;

/** Parse the env multiplier; invalid/absent ⇒ the default. Aider accepts a float ≥ 0. */
export function mapMultiplierNoFiles(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAP_MULTIPLIER_NO_FILES_ENV];
  if (raw === undefined || String(raw).trim() === "") return NO_FOCUS_BUDGET_MULTIPLIER;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NO_FOCUS_BUDGET_MULTIPLIER;
}

/** Aider's context-window cap: the window minus the 4096-token padding (never negative). */
export function repoMapContextCap(contextWindowTokens: number = DEFAULT_REPO_MAP_CONTEXT_WINDOW): number {
  const window = Number.isFinite(contextWindowTokens) ? Math.floor(contextWindowTokens) : DEFAULT_REPO_MAP_CONTEXT_WINDOW;
  return Math.max(0, window - REPO_MAP_CONTEXT_PADDING);
}

export type RepoMapLadderStep = "focus" | "repo" | "plain";

export interface RepoMapBudgetSignals {
  /** Files already in the conversation (mentions / read/edit targets / attachments). */
  hasFilesInContext?: boolean;
  /** Model context window in tokens; the budget is capped at `window - 4096`. */
  contextWindowTokens?: number;
  /** Overrides the env/default multiplier (for pure callers/tests). */
  multiplier?: number;
}

export function effectiveRepoMapBudget(
  focus: string[] | undefined,
  requested?: number,
  signals: RepoMapBudgetSignals | boolean = {},
): number {
  const hasFilesInContext = typeof signals === "boolean" ? signals : signals.hasFilesInContext;
  const contextWindowTokens = typeof signals === "boolean" ? undefined : signals.contextWindowTokens;
  const multiplierOverride = typeof signals === "boolean" ? undefined : signals.multiplier;
  const base = Math.max(64, Math.min(requested ?? DEFAULT_MAX_TOKENS, HARD_MAX_TOKENS));
  // Focus wins: an explicit focus set is already maximal context. Otherwise the
  // budget is expanded ONLY when the conversation names no files (aider
  // `map-multiplier-no-files`), capped by `contextWindow - 4096`. Files already
  // in context (mentions, read/edit targets, attachments) suppress expansion.
  // A `boolean` third arg (legacy) is treated as the hasFilesInContext signal.
  if ((focus?.length ?? 0) > 0 || hasFilesInContext === true) return base;
  const multiplier = multiplierOverride ?? mapMultiplierNoFiles();
  const target = Math.min(Math.floor(base * multiplier), repoMapContextCap(contextWindowTokens));
  return Math.max(64, Math.min(HARD_MAX_TOKENS, target));
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
  const tokenBudget = effectiveRepoMapBudget(opts.focus, opts.maxTokens, {
    hasFilesInContext: opts.hasFilesInContext,
    contextWindowTokens: opts.contextWindowTokens,
  });

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
