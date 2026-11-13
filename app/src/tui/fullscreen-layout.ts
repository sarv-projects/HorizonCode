/**
 * fullscreen-layout.ts — pure alt-screen frame layout (docs/33 §5.17).
 *
 * No terminal I/O: builds a CellBuffer for transcript tail, status, and input.
 */

import { bufferFromLines, diffBuffers, encodeDiffRuns, type CellBuffer, type CellStyle } from "./cellbuffer";

export const FULLSCREEN_INPUT_PROMPT = "> ";

/** Dim style for the reduced inset scrollback pane (ruling 299). */
export const INSET_SCROLLBACK_PANE_STYLE: CellStyle = { dim: true };

export interface FullscreenLayoutRows {
  statusRow: number;
  transcriptStart: number;
  transcriptRows: number;
  inputRow: number;
}

/** Reduced in-app scrollback pane slice (Grok R1–R12 residual; ruling 284). */
export interface FullscreenInsetPaneLayout extends FullscreenLayoutRows {
  insetPaneRows: number;
  insetPaneStart: number;
  mainTranscriptRows: number;
}

/** Reserve bottom transcript rows as a read-only inset pane (main transcript shortens). */
export function fullscreenLayoutWithInsetPane(totalHeight: number, insetPaneRows: number): FullscreenInsetPaneLayout {
  const base = fullscreenLayoutRows(totalHeight);
  const pane = Math.max(0, Math.min(base.transcriptRows - 1, Math.floor(insetPaneRows)));
  if (pane === 0) {
    return { ...base, insetPaneRows: 0, insetPaneStart: base.transcriptStart, mainTranscriptRows: base.transcriptRows };
  }
  const insetPaneStart = base.transcriptStart + base.transcriptRows - pane;
  const mainTranscriptRows = base.transcriptRows - pane;
  return { ...base, insetPaneRows: pane, insetPaneStart, mainTranscriptRows };
}

/** Reserve row 0 for status, the last row for input, the middle for transcript. */
export function fullscreenLayoutRows(totalHeight: number): FullscreenLayoutRows {
  const h = Math.max(3, Math.floor(totalHeight));
  const inputRow = h - 1;
  const statusRow = 0;
  const transcriptStart = 1;
  const transcriptRows = Math.max(1, h - 2);
  return { statusRow, transcriptStart, transcriptRows, inputRow };
}

/** Hard-wrap plain text into fixed-width rows (UTF-16 code units; wide glyphs residual). */
export function wrapPlainLine(line: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const text = String(line ?? "");
  if (text === "") return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += w) out.push(text.slice(i, i + w));
  return out;
}

/** Flatten logical lines, wrap, then keep only the last `maxRows` screen rows. */
export function sliceTranscriptTail(lines: readonly string[], width: number, maxRows: number): string[] {
  return sliceTranscriptViewport(lines, width, maxRows, 0);
}

/** Wrapped line count visible above the tail when `scrollBack` is at its maximum. */
export function fullscreenTranscriptScrollBackMax(
  lines: readonly string[],
  width: number,
  maxRows: number,
): number {
  const wrapped: string[] = [];
  for (const line of lines) wrapped.push(...wrapPlainLine(line, width));
  const cap = Math.max(1, Math.floor(maxRows));
  return Math.max(0, wrapped.length - cap);
}

/**
 * Transcript viewport: `scrollBack` is additional wrapped lines kept above the tail
 * (wheel-up reveals older lines in the reduced fullscreen chat).
 */
export function sliceTranscriptViewport(
  lines: readonly string[],
  width: number,
  maxRows: number,
  scrollBack: number,
): string[] {
  const wrapped: string[] = [];
  for (const line of lines) wrapped.push(...wrapPlainLine(line, width));
  const cap = Math.max(1, Math.floor(maxRows));
  const back = Math.max(0, Math.floor(scrollBack));
  if (wrapped.length <= cap) return wrapped;
  const end = back === 0 ? wrapped.length : Math.max(0, wrapped.length - back);
  const start = Math.max(0, end - cap);
  if (start >= end) return new Array(cap).fill("");
  const slice = wrapped.slice(start, end);
  while (slice.length < cap) slice.unshift("");
  return slice;
}

export interface FullscreenFrameInput {
  width: number;
  height: number;
  status: string;
  transcript: readonly string[];
  input: string;
  prompt?: string;
}

export interface FullscreenInsetFrameInput extends FullscreenFrameInput {
  insetPaneRows: number;
  /** Logical lines shown in the bottom inset scrollback slice (painted dim). */
  insetScrollback: readonly string[];
  /** Wrapped lines scrolled up within the inset pane (wheel over inset region). */
  insetScrollBack?: number;
}

/** Build a full-screen cell grid: status, wrapped transcript tail, prompt + input. */
export function buildFullscreenFrame(opts: FullscreenFrameInput): CellBuffer {
  const w = Math.max(20, Math.floor(opts.width));
  const h = Math.max(3, Math.floor(opts.height));
  const layout = fullscreenLayoutRows(h);
  const prompt = opts.prompt ?? FULLSCREEN_INPUT_PROMPT;
  const status = (opts.status ?? "").slice(0, w);
  const tail = sliceTranscriptTail(opts.transcript, w, layout.transcriptRows);
  while (tail.length < layout.transcriptRows) tail.unshift("");

  const inputLine = (prompt + opts.input).slice(0, w);
  const grid: string[] = new Array(h).fill("");
  grid[layout.statusRow] = status.padEnd(w, " ").slice(0, w);
  for (let i = 0; i < layout.transcriptRows; i += 1) {
    const row = layout.transcriptStart + i;
    const src = tail[i] ?? "";
    grid[row] = src.padEnd(w, " ").slice(0, w);
  }
  grid[layout.inputRow] = inputLine.padEnd(w, " ").slice(0, w);
  return bufferFromLines(grid, w, h);
}

function padRow(text: string, width: number): string {
  return text.padEnd(width, " ").slice(0, width);
}

function applyRowStyle(buf: CellBuffer, row: number, style: CellStyle): void {
  for (let col = 0; col < buf.width; col += 1) {
    const i = row * buf.width + col;
    const cell = buf.cells[i];
    if (cell && cell.ch !== " ") buf.cells[i] = { ...cell, style };
  }
}

/**
 * Fullscreen frame with a dim inset scrollback pane (Grok R1–R12 reduced; ruling 299).
 * Main transcript uses `transcript`; bottom `insetPaneRows` show `insetScrollback` tail.
 */
export function buildFullscreenFrameWithInsetPane(opts: FullscreenInsetFrameInput): CellBuffer {
  const w = Math.max(20, Math.floor(opts.width));
  const h = Math.max(3, Math.floor(opts.height));
  const layout = fullscreenLayoutWithInsetPane(h, opts.insetPaneRows);
  const prompt = opts.prompt ?? FULLSCREEN_INPUT_PROMPT;
  const status = (opts.status ?? "").slice(0, w);

  const mainTail = sliceTranscriptTail(opts.transcript, w, layout.mainTranscriptRows);
  while (mainTail.length < layout.mainTranscriptRows) mainTail.unshift("");

  const insetBack = Math.max(0, Math.floor(opts.insetScrollBack ?? 0));
  const insetTail = sliceTranscriptViewport(opts.insetScrollback, w, layout.insetPaneRows, insetBack);
  while (insetTail.length < layout.insetPaneRows) insetTail.unshift("");

  const inputLine = (prompt + opts.input).slice(0, w);
  const grid: string[] = new Array(h).fill("");
  grid[layout.statusRow] = padRow(status, w);
  for (let i = 0; i < layout.mainTranscriptRows; i += 1) {
    grid[layout.transcriptStart + i] = padRow(mainTail[i] ?? "", w);
  }
  for (let i = 0; i < layout.insetPaneRows; i += 1) {
    grid[layout.insetPaneStart + i] = padRow(insetTail[i] ?? "", w);
  }
  grid[layout.inputRow] = padRow(inputLine, w);

  const buf = bufferFromLines(grid, w, h);
  for (let i = 0; i < layout.insetPaneRows; i += 1) {
    applyRowStyle(buf, layout.insetPaneStart + i, INSET_SCROLLBACK_PANE_STYLE);
  }
  return buf;
}

/** Differential alt-screen paint stream between two frames (R8 reduced). */
export function encodeFullscreenFrameDiff(prev: CellBuffer | null, next: CellBuffer): string {
  return encodeDiffRuns(diffBuffers(prev, next));
}

/** Alt-screen paint surfaces tracked for overlay differential paint (ruling **310**). */
export type FullscreenPaintKind = "main" | "picker" | "palette" | "inspector" | "completion";

const FULLSCREEN_OVERLAY_PAINT_KINDS = new Set<FullscreenPaintKind>([
  "picker",
  "palette",
  "inspector",
  "completion",
]);

/** True when paint kinds can diff at unchanged terminal size (main↔overlay **316**; overlay↔overlay **317**). */
export function fullscreenPaintKindSoftTransition(
  prevKind: FullscreenPaintKind | null,
  nextKind: FullscreenPaintKind,
): boolean {
  if (prevKind === null) return false;
  if (prevKind === nextKind) return true;
  const prevOverlay = FULLSCREEN_OVERLAY_PAINT_KINDS.has(prevKind);
  const nextOverlay = FULLSCREEN_OVERLAY_PAINT_KINDS.has(nextKind);
  if (prevKind === "main" && nextOverlay) return true;
  if (nextKind === "main" && prevOverlay) return true;
  if (prevOverlay && nextOverlay) return true;
  return false;
}

/**
 * Paint stream for consecutive frames of the same kind and size (main loop or a single overlay).
 * Resize still clears via `encodeFullscreenFrameDiff(null, …)`; main↔overlay and overlay↔overlay soft-transition diff (**316**, **317**).
 */
export function encodeFullscreenConsecutiveFrameDiff(
  prev: CellBuffer | null,
  next: CellBuffer,
  prevKind: FullscreenPaintKind | null,
  nextKind: FullscreenPaintKind,
): string {
  const sameSize = prev !== null && prev.width === next.width && prev.height === next.height;
  const soft = sameSize && fullscreenPaintKindSoftTransition(prevKind, nextKind);
  const prevForDiff = soft ? prev : null;
  return encodeFullscreenFrameDiff(prevForDiff, next);
}

/** Cursor column for the input row (1-based terminal column). */
export function inputCursorColumn(prompt: string, input: string): number {
  return Math.max(1, prompt.length + input.length);
}
