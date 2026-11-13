/**
 * fullscreen-input-history.ts — ↑/↓ prior composer lines for alt-screen input (docs/13 D18 reduced).
 */

import { readFileSync } from "node:fs";

const DEFAULT_LIMIT = 500;

export interface FullscreenInputHistoryState {
  entries: string[];
  /** -1 = editing a fresh line; otherwise index into `entries`. */
  index: number;
  /** Saved draft while browsing history upward. */
  stash: string;
}

export function createFullscreenInputHistory(entries: string[] = []): FullscreenInputHistoryState {
  return { entries: entries.slice(), index: -1, stash: "" };
}

export function readHistoryFileEntries(file: string, limit = DEFAULT_LIMIT): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line !== "")
      .slice(-limit);
  } catch {
    return [];
  }
}

export function pushFullscreenHistoryEntry(state: FullscreenInputHistoryState, text: string): FullscreenInputHistoryState {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed === "") return { ...state, index: -1, stash: "" };
  const entries = state.entries.slice();
  if (entries[entries.length - 1] !== trimmed) entries.push(trimmed);
  while (entries.length > DEFAULT_LIMIT) entries.shift();
  return { entries, index: -1, stash: "" };
}

export function historyNavigateUp(
  state: FullscreenInputHistoryState,
  currentText: string,
): { state: FullscreenInputHistoryState; text: string } {
  if (state.entries.length === 0) return { state, text: currentText };
  if (state.index === -1) {
    const nextIndex = state.entries.length - 1;
    return {
      state: { ...state, index: nextIndex, stash: currentText },
      text: state.entries[nextIndex] ?? currentText,
    };
  }
  if (state.index <= 0) return { state, text: state.entries[0] ?? currentText };
  const nextIndex = state.index - 1;
  return { state: { ...state, index: nextIndex }, text: state.entries[nextIndex] ?? currentText };
}

export function historyNavigateDown(
  state: FullscreenInputHistoryState,
  currentText: string,
): { state: FullscreenInputHistoryState; text: string } {
  if (state.entries.length === 0 || state.index === -1) return { state, text: currentText };
  if (state.index >= state.entries.length - 1) {
    return { state: { ...state, index: -1, stash: "" }, text: state.stash };
  }
  const nextIndex = state.index + 1;
  return { state: { ...state, index: nextIndex }, text: state.entries[nextIndex] ?? currentText };
}
