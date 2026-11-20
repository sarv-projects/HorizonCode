/**
 * `--show-repo-map` (docs/30 I-4): render the structural repo map to stdout
 * with no provider call (same builder as the `repo_map` tool).
 */

import { buildRepoMapWithLadder, effectiveRepoMapBudget } from "../tools/repo-map-ladder";
import { repoMapCachePath } from "../tools/repo-map-cache";
import { DEFAULT_MAX_TOKENS } from "../tools/repo-map";
import { metricContract } from "./metrics";

export interface ShowRepoMapOptions {
  workspace: string;
  maxTokens?: number;
  focus?: string[];
  contextWindowTokens?: number;
}

export interface ShowRepoMapResult {
  text: string;
  empty: boolean;
  budgetTokens: number;
  mapChars: number;
}

/** H-7: contracted facts for `--show-repo-map` (ruling 618). */
export function showRepoMapPublication(input: {
  empty: boolean;
  budgetTokens: number;
  mapChars: number;
}): string[] {
  const anchor = "none — this --show-repo-map invocation";
  const population = "structural repo_map render with no provider call";
  const excludes = "file paths and map body text are not published as metrics";
  return [
    metricContract({
      metric: "show-repo-map empty",
      anchor,
      population,
      excludes,
      value: input.empty ? 1 : 0,
    }),
    metricContract({
      metric: "show-repo-map budget tokens",
      anchor,
      population,
      excludes,
      value: input.budgetTokens,
    }),
    metricContract({
      metric: "show-repo-map map chars",
      anchor,
      population,
      excludes,
      value: input.mapChars,
    }),
  ];
}

export function buildShowRepoMapResult(opts: ShowRepoMapOptions): ShowRepoMapResult {
  const cwd = opts.workspace;
  const budget = effectiveRepoMapBudget(opts.focus, opts.maxTokens ?? DEFAULT_MAX_TOKENS, {
    contextWindowTokens: opts.contextWindowTokens,
  });
  const result = buildRepoMapWithLadder({
    root: cwd,
    cwd,
    maxTokens: budget,
    focus: opts.focus,
    contextWindowTokens: opts.contextWindowTokens,
    indexFile: repoMapCachePath(cwd),
  });
  if ("empty" in result) {
    return { text: "(repo map empty)\n", empty: true, budgetTokens: budget, mapChars: 0 };
  }
  const text = result.map.endsWith("\n") ? result.map : `${result.map}\n`;
  return { text, empty: false, budgetTokens: budget, mapChars: result.map.length };
}

export function buildShowRepoMap(opts: ShowRepoMapOptions): string {
  return buildShowRepoMapResult(opts).text;
}
