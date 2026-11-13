/**
 * cellbuffer.ts — fixed-grid cells and differential diff (docs/33 §5.17 partial).
 *
 * Pure: no terminal I/O. Intended as the R12 render-probe building block before
 * any alternate-screen writer ships. Width is in terminal columns (one UTF-16
 * code unit per cell for v1; wide graphemes are a known residual).
 */

export interface CellStyle {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
}

export interface Cell {
  ch: string;
  style?: CellStyle;
}

export interface CellBuffer {
  width: number;
  height: number;
  /** Row-major flat array, length width × height. */
  cells: Cell[];
}

export type DiffRun =
  | { kind: "clear" }
  | { kind: "goto"; row: number; col: number }
  | { kind: "set"; row: number; col: number; text: string; style?: CellStyle };

function emptyCell(): Cell {
  return { ch: " " };
}

function styleKey(s: CellStyle | undefined): string {
  if (s === undefined) return "";
  return JSON.stringify(s);
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && styleKey(a.style) === styleKey(b.style);
}

/** Build a buffer from plain text lines (no ANSI), padded with spaces. */
export function bufferFromLines(lines: readonly string[], width: number, height?: number): CellBuffer {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, height ?? lines.length);
  const cells: Cell[] = [];
  for (let row = 0; row < h; row += 1) {
    const line = row < lines.length ? String(lines[row] ?? "") : "";
    for (let col = 0; col < w; col += 1) {
      const ch = col < line.length ? line[col]! : " ";
      cells.push({ ch });
    }
  }
  return { width: w, height: h, cells };
}

function cellAt(buf: CellBuffer, row: number, col: number): Cell {
  if (row < 0 || col < 0 || row >= buf.height || col >= buf.width) return emptyCell();
  return buf.cells[row * buf.width + col] ?? emptyCell();
}

/**
 * Differential update runs: full clear when size changes or on first paint;
 * otherwise goto + set only for changed cells (left-to-right, top-to-bottom).
 */
export function diffBuffers(prev: CellBuffer | null, next: CellBuffer): DiffRun[] {
  if (prev === null || prev.width !== next.width || prev.height !== next.height) {
    const runs: DiffRun[] = [{ kind: "clear" }];
    for (let row = 0; row < next.height; row += 1) {
      let col = 0;
      while (col < next.width) {
        const c = cellAt(next, row, col);
        if (c.ch === " " && c.style === undefined) {
          col += 1;
          continue;
        }
        let end = col;
        let text = "";
        let style: CellStyle | undefined;
        while (end < next.width) {
          const cur = cellAt(next, row, end);
          if (cur.ch === " " && cur.style === undefined) break;
          if (style === undefined && cur.style !== undefined) style = cur.style;
          text += cur.ch;
          end += 1;
        }
        runs.push({ kind: "goto", row, col });
        runs.push({ kind: "set", row, col, text, style });
        col = end;
      }
    }
    return runs;
  }

  const runs: DiffRun[] = [];
  for (let row = 0; row < next.height; row += 1) {
    for (let col = 0; col < next.width; col += 1) {
      const a = cellAt(prev, row, col);
      const b = cellAt(next, row, col);
      if (cellsEqual(a, b)) continue;
      runs.push({ kind: "goto", row, col });
      runs.push({ kind: "set", row, col, text: b.ch, style: b.style });
    }
  }
  return runs;
}

function sgr(style: CellStyle | undefined): string {
  if (style === undefined) return "\u001b[0m";
  const parts: number[] = [];
  if (style.bold) parts.push(1);
  if (style.dim) parts.push(2);
  if (typeof style.fg === "number") parts.push(30 + (style.fg % 8));
  if (typeof style.bg === "number") parts.push(40 + (style.bg % 8));
  if (parts.length === 0) return "";
  return `\u001b[${parts.join(";")}m`;
}

/** Full-grid paint (includes spaces); for alt-screen loops where space-skipping diff is unreadable. */
export function encodeBufferFull(buf: CellBuffer): string {
  const w = buf.width;
  const h = buf.height;
  let out = "\u001b[2J\u001b[H";
  for (let row = 0; row < h; row += 1) {
    out += `\u001b[${row + 1};1H`;
    for (let col = 0; col < w; col += 1) {
      out += cellAt(buf, row, col).ch;
    }
  }
  return out;
}

/** Encode diff runs to a minimal ANSI stream (for tests and future EscapeWriter). */
export function encodeDiffRuns(runs: readonly DiffRun[]): string {
  let out = "";
  for (const run of runs) {
    if (run.kind === "clear") {
      out += "\u001b[2J\u001b[H";
      continue;
    }
    if (run.kind === "goto") {
      out += `\u001b[${run.row + 1};${run.col + 1}H`;
      continue;
    }
  const pre = sgr(run.style);
  const post = run.style !== undefined ? "\u001b[0m" : "";
    out += pre + run.text + post;
  }
  return out;
}
