/**
 * fullscreen-receipt-inspector.ts — read-only receipt inspector overlay (ruling 284).
 */

import { bufferFromLines, type CellBuffer } from "./cellbuffer";
import { wrapPlainLine } from "./fullscreen-layout";

export interface FullscreenReceiptInspectorState {
  lines: readonly string[];
  scrollOffset: number;
}

export type FullscreenReceiptInspectorKey = { kind: "up" } | { kind: "down" } | { kind: "dismiss" };

export type FullscreenReceiptInspectorOutcome = { kind: "pending" } | { kind: "dismiss" };

const DEFAULT_HEADER = "Receipt inspector · ↑↓ scroll · Esc close";

export function initialReceiptInspectorState(lines: readonly string[]): FullscreenReceiptInspectorState {
  return { lines, scrollOffset: 0 };
}

export function applyReceiptInspectorKey(
  state: FullscreenReceiptInspectorState,
  key: FullscreenReceiptInspectorKey,
  listRows: number,
): { state: FullscreenReceiptInspectorState; outcome: FullscreenReceiptInspectorOutcome } {
  if (key.kind === "dismiss") return { state, outcome: { kind: "dismiss" } };
  const wrappedCount = countWrappedLines(state.lines, 1);
  const maxOffset = Math.max(0, wrappedCount - Math.max(1, listRows));
  let scrollOffset = state.scrollOffset;
  if (key.kind === "up") scrollOffset = Math.max(0, scrollOffset - 1);
  if (key.kind === "down") scrollOffset = Math.min(maxOffset, scrollOffset + 1);
  return { state: { ...state, scrollOffset }, outcome: { kind: "pending" } };
}

function countWrappedLines(lines: readonly string[], width: number): number {
  let n = 0;
  for (const line of lines) n += wrapPlainLine(line, width).length;
  return n;
}

export interface FullscreenReceiptInspectorFrameInput {
  width: number;
  height: number;
  state: FullscreenReceiptInspectorState;
  header?: string;
}

export function buildFullscreenReceiptInspectorFrame(opts: FullscreenReceiptInspectorFrameInput): CellBuffer {
  const w = Math.max(24, Math.floor(opts.width));
  const h = Math.max(5, Math.floor(opts.height));
  const header = (opts.header ?? DEFAULT_HEADER).slice(0, w);
  const listStart = 1;
  const listEnd = h - 1;
  const listRows = Math.max(1, listEnd - listStart);

  const wrapped: string[] = [];
  for (const line of opts.state.lines) wrapped.push(...wrapPlainLine(line, w));

  const grid: string[] = new Array(h).fill("".padEnd(w, " "));
  grid[0] = header.padEnd(w, " ").slice(0, w);
  const footer = `${wrapped.length} line(s) · offset ${opts.state.scrollOffset}`.slice(0, w);
  grid[h - 1] = footer.padEnd(w, " ").slice(0, w);

  const start = opts.state.scrollOffset;
  for (let r = 0; r < listRows; r += 1) {
    const row = listStart + r;
    const text = wrapped[start + r] ?? "";
    grid[row] = text.padEnd(w, " ").slice(0, w);
  }

  return bufferFromLines(grid, w, h);
}
