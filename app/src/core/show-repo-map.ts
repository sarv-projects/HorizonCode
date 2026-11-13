/**
 * `--show-repo-map` (docs/30 I-4): render the structural repo map to stdout
 * with no provider call (same builder as the `repo_map` tool).
 */

import { buildRepoMapWithLadder, effectiveRepoMapBudget } from "../tools/repo-map-ladder";
import { repoMapCachePath } from "../tools/repo-map-cache";
import { DEFAULT_MAX_TOKENS } from "../tools/repo-map";

export interface ShowRepoMapOptions {
  workspace: string;
  maxTokens?: number;
  focus?: string[];
}

export function buildShowRepoMap(opts: ShowRepoMapOptions): string {
  const cwd = opts.workspace;
  const budget = effectiveRepoMapBudget(opts.focus, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const result = buildRepoMapWithLadder({
    root: cwd,
    cwd,
    maxTokens: budget,
    focus: opts.focus,
    indexFile: repoMapCachePath(cwd),
  });
  if ("empty" in result) return "(repo map empty)\n";
  return result.map.endsWith("\n") ? result.map : `${result.map}\n`;
}
