/**
 * fullscreen-completion.ts — Tab completion overlay stub for alt-screen (docs/13 D6; ruling 284).
 *
 * Pure layout + state; mirrors scrollback `formatCompletionDropdown` in cellbuffer form.
 */

import { bufferFromLines, type CellBuffer } from "./cellbuffer";
import { candidates, type CompletionContext } from "./completion";
import { visibleWidth } from "./style";

export interface FullscreenCompletionState {
  token: string;
  hits: readonly string[];
  selectedIndex: number;
}

export type FullscreenCompletionKey =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "confirm" }
  | { kind: "dismiss" };

export type FullscreenCompletionOutcome =
  | { kind: "pending" }
  | { kind: "apply"; completedLine: string }
  | { kind: "cancel" };

const DEFAULT_HEADER = "Completion · ↑↓ move · Tab apply · Esc cancel";

export function shouldShowFullscreenCompletion(line: string): boolean {
  const t = line.trimStart();
  if (t.startsWith("/") && !/\s/.test(t)) return t.length > 0;
  return /(?:^|\s)@[^\s]*$/.test(line);
}

export function initialFullscreenCompletionState(line: string, ctx: CompletionContext): FullscreenCompletionState | undefined {
  const { hits, token } = candidates(line, ctx);
  if (hits.length === 0) return undefined;
  return { token, hits, selectedIndex: 0 };
}

export function applyFullscreenCompletionKey(
  line: string,
  state: FullscreenCompletionState,
  key: FullscreenCompletionKey,
): { state: FullscreenCompletionState; outcome: FullscreenCompletionOutcome } {
  if (key.kind === "dismiss") return { state, outcome: { kind: "cancel" } };
  if (key.kind === "confirm") {
    const pick = state.hits[state.selectedIndex] ?? state.hits[0];
    if (pick === undefined) return { state, outcome: { kind: "cancel" } };
    const idx = line.lastIndexOf(state.token);
    const completedLine = idx >= 0 ? line.slice(0, idx) + pick : line + pick.slice(state.token.length);
    return { state, outcome: { kind: "apply", completedLine } };
  }
  let selectedIndex = state.selectedIndex;
  if (key.kind === "up") selectedIndex = selectedIndex <= 0 ? state.hits.length - 1 : selectedIndex - 1;
  if (key.kind === "down") selectedIndex = selectedIndex >= state.hits.length - 1 ? 0 : selectedIndex + 1;
  return { state: { ...state, selectedIndex }, outcome: { kind: "pending" } };
}

export function formatFullscreenCompletionRow(hit: string, selected: boolean, width: number): string {
  const w = Math.max(8, Math.floor(width));
  const mark = selected ? ">" : " ";
  const label = visibleWidth(hit) > w - 2 ? hit.slice(0, Math.max(1, w - 3)) + "…" : hit;
  return `${mark} ${label}`.padEnd(w, " ").slice(0, w);
}

export function buildFullscreenCompletionFrame(opts: {
  width: number;
  height: number;
  state: FullscreenCompletionState;
  header?: string;
}): CellBuffer {
  const w = Math.max(20, Math.floor(opts.width));
  const h = Math.max(5, Math.floor(opts.height));
  const header = (opts.header ?? DEFAULT_HEADER).slice(0, w);
  const listStart = 1;
  const listEnd = h - 1;
  const listRows = Math.max(1, listEnd - listStart);
  const grid: string[] = new Array(h).fill("".padEnd(w, " "));
  grid[0] = header.padEnd(w, " ").slice(0, w);
  const footer = `${opts.state.hits.length} hit(s)`.slice(0, w);
  grid[h - 1] = footer.padEnd(w, " ").slice(0, w);
  const cap = Math.min(opts.state.hits.length, listRows);
  for (let r = 0; r < cap; r += 1) {
    const hit = opts.state.hits[r]!;
    grid[listStart + r] = formatFullscreenCompletionRow(hit, r === opts.state.selectedIndex, w);
  }
  return bufferFromLines(grid, w, h);
}
