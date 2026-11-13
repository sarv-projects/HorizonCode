/**
 * fullscreen-palette.ts — fuzzy slash palette overlay for alt-screen chat (docs/13 D5/D6 reduced).
 *
 * Pure layout + state machine; terminal I/O lives in fullscreen-chat.ts.
 */

import type { SlashCommandRow } from "../core/slash-registry";
import { bufferFromLines, type CellBuffer } from "./cellbuffer";
import { rankFullscreenPaletteCommands } from "./receipt-palette";

export interface FullscreenPaletteState {
  query: string;
  selectedIndex: number;
  scrollOffset: number;
  items: readonly SlashCommandRow[];
}

export type FullscreenPaletteKey =
  | { kind: "filter"; ch: string }
  | { kind: "backspace" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "confirm" }
  | { kind: "dismiss" };

export type FullscreenPaletteOutcome =
  | { kind: "pending" }
  | { kind: "run"; commandName: string }
  | { kind: "cancel" };

export interface FullscreenPaletteStepOpts {
  listRows: number;
  customNames: readonly string[];
  limit?: number;
}

const DEFAULT_HEADER = "Command palette · type to filter · ↑↓ move · Enter run or insert · Esc cancel";

export function initialFullscreenPaletteState(customNames: readonly string[], limit = 40): FullscreenPaletteState {
  const items = rankFullscreenPaletteCommands("", customNames, limit);
  return { query: "", selectedIndex: items.length > 0 ? 0 : -1, scrollOffset: 0, items };
}

export function fullscreenPaletteStateWithQuery(
  customNames: readonly string[],
  query: string,
  limit = 40,
): FullscreenPaletteState {
  const items = rankFullscreenPaletteCommands(query, customNames, limit);
  const selectedIndex = items.length > 0 ? 0 : -1;
  return { query, selectedIndex, scrollOffset: 0, items };
}

function clampScroll(state: FullscreenPaletteState, listRows: number): FullscreenPaletteState {
  const count = state.items.length;
  if (count === 0 || listRows <= 0) return { ...state, scrollOffset: 0, selectedIndex: -1 };
  let { selectedIndex, scrollOffset } = state;
  if (selectedIndex < 0) selectedIndex = 0;
  if (selectedIndex >= count) selectedIndex = count - 1;
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
  if (selectedIndex >= scrollOffset + listRows) scrollOffset = selectedIndex - listRows + 1;
  if (scrollOffset < 0) scrollOffset = 0;
  const maxOffset = Math.max(0, count - listRows);
  if (scrollOffset > maxOffset) scrollOffset = maxOffset;
  return { ...state, selectedIndex, scrollOffset };
}

export function applyFullscreenPaletteKey(
  state: FullscreenPaletteState,
  key: FullscreenPaletteKey,
  opts: FullscreenPaletteStepOpts,
): { state: FullscreenPaletteState; outcome: FullscreenPaletteOutcome } {
  const limit = opts.limit ?? 40;
  if (key.kind === "dismiss") return { state, outcome: { kind: "cancel" } };
  if (key.kind === "confirm") {
    const pick = state.items[state.selectedIndex];
    if (pick === undefined) return { state, outcome: { kind: "cancel" } };
    return { state, outcome: { kind: "run", commandName: pick.name } };
  }

  let next = state;
  if (key.kind === "filter") {
    const query = state.query + key.ch;
    next = fullscreenPaletteStateWithQuery(opts.customNames, query, limit);
  } else if (key.kind === "backspace") {
    const query = state.query.slice(0, Math.max(0, state.query.length - 1));
    next = fullscreenPaletteStateWithQuery(opts.customNames, query, limit);
  } else if (key.kind === "up") {
    if (state.items.length === 0) return { state, outcome: { kind: "pending" } };
    const selectedIndex = state.selectedIndex <= 0 ? state.items.length - 1 : state.selectedIndex - 1;
    next = clampScroll({ ...state, selectedIndex }, opts.listRows);
  } else if (key.kind === "down") {
    if (state.items.length === 0) return { state, outcome: { kind: "pending" } };
    const selectedIndex =
      state.selectedIndex < 0 || state.selectedIndex >= state.items.length - 1 ? 0 : state.selectedIndex + 1;
    next = clampScroll({ ...state, selectedIndex }, opts.listRows);
  }

  return { state: next, outcome: { kind: "pending" } };
}

export function formatFullscreenPaletteRow(row: SlashCommandRow, selected: boolean, width: number): string {
  const w = Math.max(10, Math.floor(width));
  const labelW = Math.min(28, Math.floor(w * 0.4));
  const name = `/${row.name}`.padEnd(labelW).slice(0, labelW);
  const descMax = Math.max(4, w - labelW - 4);
  let desc = row.description;
  if (desc.length > descMax) desc = desc.slice(0, Math.max(0, descMax - 3)) + "...";
  const caret = selected ? ">" : " ";
  const line = `${caret} ${name}  ${desc}`;
  return line.slice(0, w).padEnd(w, " ");
}

export interface FullscreenPaletteFrameInput {
  width: number;
  height: number;
  state: FullscreenPaletteState;
  header?: string;
}

export function buildFullscreenPaletteFrame(opts: FullscreenPaletteFrameInput): CellBuffer {
  const w = Math.max(24, Math.floor(opts.width));
  const h = Math.max(5, Math.floor(opts.height));
  const header = (opts.header ?? DEFAULT_HEADER).slice(0, w);
  const filterLabel = "Filter: ";
  const filterLine = (filterLabel + opts.state.query).slice(0, w).padEnd(w, " ");
  const footer =
    (opts.state.items.length === 0
      ? "No matching commands · Esc closes"
      : `${opts.state.items.length} command(s) · row ${Math.max(0, opts.state.selectedIndex) + 1}/${opts.state.items.length}`
    ).slice(0, w);

  const listStart = 2;
  const listEnd = h - 2;
  const listRows = Math.max(1, listEnd - listStart);
  const grid: string[] = new Array(h).fill("".padEnd(w, " "));
  grid[0] = header.padEnd(w, " ").slice(0, w);
  grid[1] = filterLine;
  grid[h - 1] = footer.padEnd(w, " ").slice(0, w);

  const { items, scrollOffset, selectedIndex } = opts.state;
  for (let r = 0; r < listRows; r += 1) {
    const row = listStart + r;
    const item = items[scrollOffset + r];
    if (item === undefined) {
      grid[row] = "".padEnd(w, " ");
      continue;
    }
    const selected = scrollOffset + r === selectedIndex;
    grid[row] = formatFullscreenPaletteRow(item, selected, w);
  }

  return bufferFromLines(grid, w, h);
}

export function fullscreenPaletteFilterCursorColumn(query: string): number {
  return Math.max(1, "Filter: ".length + query.length + 1);
}

/** Parse `/palette [query]` or `/commands [query]` from the composer line. */
export function paletteSlashSeed(text: string): string | null {
  const raw = text.trim();
  if (raw === "") return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith("/palette")) return raw.slice("/palette".length).trim();
  if (lower.startsWith("/commands")) return raw.slice("/commands".length).trim();
  return null;
}

export function isPaletteSlashLine(text: string): boolean {
  return paletteSlashSeed(text) !== null;
}
