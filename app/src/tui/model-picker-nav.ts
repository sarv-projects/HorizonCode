/**
 * model-picker-nav.ts -- arrow-key/filter state for the interactive /model
 * picker (docs/28 §14). Pure and injectable: no TTY, no readline, no runtime.
 */
import { fuzzyScore } from "./fuzzy";

export interface ModelNavState {
  query: string;
  index: number;
}

export type ModelNavKey = "up" | "down" | "home" | "end";

/** Fuzzy-filtered model list; registry order is preserved for equal scores. */
export function filterModelOptions<T>(options: readonly T[], query: string, label: (option: T) => string): T[] {
  if (query.trim() === "") return [...options];
  return options
    .map((option, originalIndex) => ({ option, originalIndex, score: fuzzyScore(query, label(option)) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .map((row) => row.option);
}

/** Wrap on arrows, clamp on home/end; empty lists stay at index 0. */
export function moveModelIndex(state: ModelNavState, key: ModelNavKey, count: number): number {
  if (count <= 0) return 0;
  if (key === "home") return 0;
  if (key === "end") return count - 1;
  if (key === "up") return (state.index - 1 + count) % count;
  return (state.index + 1) % count;
}

/** Apply one keystroke to the filter query; any query edit resets the cursor. */
export function updateModelQuery(state: ModelNavState, input: string): ModelNavState {
  if (input === "\x7f" || input === "\b") {
    return { query: state.query.slice(0, -1), index: 0 };
  }
  if (input.length === 1 && input.charCodeAt(0) >= 32) {
    return { query: state.query + input, index: 0 };
  }
  return state;
}
