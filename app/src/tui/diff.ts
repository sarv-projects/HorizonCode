/**
 * diff.ts : the rich diff view: a line-number gutter and coloured +/- rows.
 *
 * Pure: unified-diff text in, display lines out. Used only in rich (TTY) mode;
 * the plain `diffBlock` in render.ts stays byte-identical for pipes and tests.
 *
 *   ▎ src/app.ts
 *     ⋯ lines 40-52
 *     40 │  const a = 1;
 *     41 │- const b = 2;
 *     41 │+ const b = 3;
 *     ⋯ 14 unchanged lines
 *   … 12 more lines
 */

import { bold, colorLevel, dim, onBg, paint, sanitizeText, truncate, type ColorLevel } from "./style";

/** Most diff rows shown before the `N more lines` footer. */
export const RICH_DIFF_LINE_CAP = 40;
/** Minimum diff lines before switching to virtual chunking (OpenCode parity). */
export const VIRTUAL_MIN_LINES = 3000;
/** Lines per virtualized diff chunk (OpenCode parity). */
export const VIRTUAL_CHUNK_LINES = 128;
/** A run of unchanged context longer than this folds to `⋯ N unchanged lines`. */
const CONTEXT_FOLD = 6;

export interface RichDiffOptions {
  width?: number;
  cap?: number;
  level?: ColorLevel;
  unicode?: boolean;
  /** When true, long unchanged context runs are not collapsed (docs/13 D9). */
  expandContext?: boolean;
  /** When true, skip the `N more lines` cap footer (still honours row paint cap if set). */
  expandCap?: boolean;
}

export interface DiffRow {
  kind: "file" | "hunk" | "add" | "del" | "ctx" | "fold";
  text: string;
  num?: number;
}

export interface VirtualDiffChunk {
  /** 0-based chunk index. */
  readonly index: number;
  /** 0-based start row index in the full virtualized diff. */
  readonly startRow: number;
  /** 0-based exclusive end row index in the full virtualized diff. */
  readonly endRow: number;
  /** Number of rows in this chunk (`<= chunkSize`). */
  readonly rowCount: number;
  /** First numbered line in this chunk's gutter, if present. */
  readonly firstLineNumber?: number;
  /** Last numbered line in this chunk's gutter, if present. */
  readonly lastLineNumber?: number;
  /** Parsed rows belonging to this chunk (rendered lazily on viewport visibility). */
  readonly rows: readonly DiffRow[];
}

export interface VirtualDiffPlan {
  /** True when totalRows >= minLines and chunking is active. */
  readonly virtualized: boolean;
  /** Total rows across all chunks. */
  readonly totalRows: number;
  /** Chunk size used (default VIRTUAL_CHUNK_LINES = 128). */
  readonly chunkSize: number;
  /** Shared line-number gutter width across all chunks so gutters align. */
  readonly gutterWidth: number;
  /** Ordered list of chunks covering `[0, totalRows)`. */
  readonly chunks: readonly VirtualDiffChunk[];
}

export interface VisibleChunkRange {
  /** First materialized chunk index (inclusive, includes `-overscan`). */
  readonly startChunk: number;
  /** Last materialized chunk index (inclusive, includes `+overscan`). */
  readonly endChunk: number;
  /** First chunk overlapping the viewport (without overscan). */
  readonly viewportStartChunk: number;
  /** Last chunk overlapping the viewport (without overscan). */
  readonly viewportEndChunk: number;
}

export interface VirtualDiffWindowOptions extends RichDiffOptions {
  /** 0-based scroll offset in diff rows. */
  scrollTop: number;
  /** Visible viewport height in rows. */
  viewportHeight: number;
  /** Overscan chunks on each side (default 1 => ±1 chunk window). */
  overscan?: number;
  /** Minimum lines before enabling virtualization (default VIRTUAL_MIN_LINES = 3000). */
  minLines?: number;
  /** Rows per chunk (default VIRTUAL_CHUNK_LINES = 128). */
  chunkSize?: number;
}

export interface VirtualDiffWindowResult {
  readonly virtualized: boolean;
  readonly totalRows: number;
  readonly chunkCount: number;
  readonly range: VisibleChunkRange;
  /** Unrendered placeholder rows above `lines`. */
  readonly leadingPlaceholderRows: number;
  /** Unrendered placeholder rows below `lines`. */
  readonly trailingPlaceholderRows: number;
  /** Materialized rendered lines for `[range.startChunk .. range.endChunk]` with exact gutter offsets. */
  readonly lines: string[];
}

function parse(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let minusFile = "";
  let sawPlus = false;
  const lines = sanitizeText(diff.replace(/\r\n?/g, "\n")).split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("\\ ")) continue;
    if (line.startsWith("--- ")) {
      minusFile = line.slice(4).replace(/^a\//, "");
      sawPlus = false;
      continue;
    }
    if (line.startsWith("+++ ") && !sawPlus) {
      sawPlus = true;
      const plus = line.slice(4).replace(/^b\//, "");
      rows.push({ kind: "file", text: plus === "/dev/null" ? minusFile : plus });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      const count = Number(hunk[4] ?? 1);
      rows.push({ kind: "hunk", text: count > 1 ? `lines ${newNo}-${newNo + count - 1}` : `line ${newNo}` });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), num: newNo++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), num: oldNo++ });
    else if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "ctx", text: line.slice(1), num: newNo });
      oldNo++;
      newNo++;
    } else rows.push({ kind: "ctx", text: line });
  }
  return rows;
}

function foldContextRows(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== "ctx") {
      out.push(rows[i++]!);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === "ctx") j++;
    const run = rows.slice(i, j);
    if (run.length > CONTEXT_FOLD) {
      out.push(run[0]!, run[1]!, { kind: "fold", text: `${run.length - 4} unchanged lines` }, run[run.length - 2]!, run[run.length - 1]!);
    } else out.push(...run);
    i = j;
  }
  return out;
}

function applyContextFold(rows: DiffRow[], expand: boolean): DiffRow[] {
  return expand ? rows : foldContextRows(rows);
}

function computeGutterWidth(rows: readonly DiffRow[]): number {
  let maxNo = 0;
  for (const r of rows) {
    if (r.num !== undefined && r.num > maxNo) maxNo = r.num;
  }
  return Math.max(3, String(maxNo).length);
}

function renderDiffRows(
  rows: readonly DiffRow[],
  opts: { width: number; level: ColorLevel; unicode: boolean; numW: number },
): string[] {
  const { width, level, unicode: u, numW } = opts;
  const bar = u ? "\u2502" : "|";
  const textW = Math.max(8, width - 2 - numW - 3);
  const out: string[] = [];
  for (const row of rows) {
    if (row.kind === "file") {
      out.push("  " + paint("accent", u ? "\u258e " : "| ", level) + bold(truncate(row.text, width - 4)));
      continue;
    }
    if (row.kind === "hunk") {
      out.push("  " + dim(`${" ".repeat(numW)} ${u ? "\u22ef" : "..."} ${row.text}`));
      continue;
    }
    if (row.kind === "fold") {
      out.push("  " + dim(`${" ".repeat(numW)} ${u ? "\u22ef" : "..."} ${row.text}`));
      continue;
    }
    const num = row.num === undefined ? " ".repeat(numW) : String(row.num).padStart(numW);
    const gutter = dim(`${num} ${bar}`);
    const body = truncate(row.text, textW);
    if (row.kind === "add") {
      const sign = paint("ok", "+", level);
      const line = gutter + sign + " " + paint("ok", body, level);
      out.push("  " + (level >= 2 ? onBg("bgAdd", line, width - 2, level) : line));
    } else if (row.kind === "del") {
      const sign = paint("err", "-", level);
      const line = gutter + sign + " " + paint("err", body, level);
      out.push("  " + (level >= 2 ? onBg("bgDel", line, width - 2, level) : line));
    } else {
      out.push("  " + gutter + "  " + body);
    }
  }
  return out;
}

/**
 * Partition a diff into `chunkSize`-line (default 128) virtual chunks when its
 * row count reaches `minLines` (default 3000), computing a shared gutter width
 * once so all chunks keep exact line-number alignment.
 */
export function createVirtualDiffChunks(
  diff: string,
  opts: { minLines?: number; chunkSize?: number; expandContext?: boolean } = {},
): VirtualDiffPlan {
  const minLines = Math.max(1, Math.floor(opts.minLines ?? VIRTUAL_MIN_LINES));
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? VIRTUAL_CHUNK_LINES));
  if (typeof diff !== "string" || diff.trim() === "") {
    return { virtualized: false, totalRows: 0, chunkSize, gutterWidth: 3, chunks: [] };
  }
  const rows = applyContextFold(parse(diff), opts.expandContext === true);
  const totalRows = rows.length;
  const gutterWidth = computeGutterWidth(rows);
  if (totalRows === 0) {
    return { virtualized: false, totalRows: 0, chunkSize, gutterWidth, chunks: [] };
  }

  const makeChunk = (index: number, startRow: number, slice: DiffRow[]): VirtualDiffChunk => {
    let firstLineNumber: number | undefined;
    let lastLineNumber: number | undefined;
    for (const r of slice) {
      if (r.num !== undefined) {
        if (firstLineNumber === undefined) firstLineNumber = r.num;
        lastLineNumber = r.num;
      }
    }
    return {
      index,
      startRow,
      endRow: startRow + slice.length,
      rowCount: slice.length,
      firstLineNumber,
      lastLineNumber,
      rows: slice,
    };
  };

  if (totalRows < minLines) {
    return {
      virtualized: false,
      totalRows,
      chunkSize,
      gutterWidth,
      chunks: [makeChunk(0, 0, rows)],
    };
  }

  const chunks: VirtualDiffChunk[] = [];
  for (let start = 0, idx = 0; start < totalRows; start += chunkSize, idx += 1) {
    chunks.push(makeChunk(idx, start, rows.slice(start, start + chunkSize)));
  }
  return {
    virtualized: true,
    totalRows,
    chunkSize,
    gutterWidth,
    chunks,
  };
}

/**
 * Compute the inclusive `[startChunk, endChunk]` range overlapping the viewport
 * plus `±overscan` (default `±1`) neighbor chunks, mirroring OpenCode's
 * `VirtualAddedPatch` lifecycle pass.
 */
export function visibleDiffChunkRange(
  chunkCount: number,
  scrollTop: number,
  viewportHeight: number,
  chunkSize: number = VIRTUAL_CHUNK_LINES,
  overscan: number = 1,
): VisibleChunkRange {
  const total = Math.max(0, Math.floor(chunkCount));
  if (total === 0) {
    return { startChunk: 0, endChunk: -1, viewportStartChunk: 0, viewportEndChunk: -1 };
  }
  const size = Math.max(1, Math.floor(chunkSize));
  const top = Math.max(0, Math.floor(scrollTop));
  const height = Math.max(1, Math.floor(viewportHeight));
  const pad = Math.max(0, Math.floor(overscan));
  const viewportStartChunk = Math.min(total - 1, Math.floor(top / size));
  const viewportEndChunk = Math.min(total - 1, Math.floor((top + height - 1) / size));
  return {
    startChunk: Math.max(0, viewportStartChunk - pad),
    endChunk: Math.min(total - 1, viewportEndChunk + pad),
    viewportStartChunk,
    viewportEndChunk,
  };
}

/**
 * Materialize and render only the visible viewport chunks `±1` for a massive diff,
 * preserving exact line-number gutter offsets and placeholder row counts above/below.
 */
export function renderVirtualDiffWindow(
  diffOrPlan: string | VirtualDiffPlan,
  opts: VirtualDiffWindowOptions,
): VirtualDiffWindowResult {
  const plan =
    typeof diffOrPlan === "string"
      ? createVirtualDiffChunks(diffOrPlan, {
          minLines: opts.minLines,
          chunkSize: opts.chunkSize,
          expandContext: opts.expandContext,
        })
      : diffOrPlan;
  if (plan.chunks.length === 0) {
    return {
      virtualized: plan.virtualized,
      totalRows: 0,
      chunkCount: 0,
      range: { startChunk: 0, endChunk: -1, viewportStartChunk: 0, viewportEndChunk: -1 },
      leadingPlaceholderRows: 0,
      trailingPlaceholderRows: 0,
      lines: [],
    };
  }

  const level = opts.level ?? colorLevel();
  const width = Math.max(24, Math.floor(opts.width ?? 80));
  const unicode = opts.unicode !== false;

  if (!plan.virtualized) {
    const allRows = plan.chunks[0]!.rows;
    return {
      virtualized: false,
      totalRows: plan.totalRows,
      chunkCount: plan.chunks.length,
      range: { startChunk: 0, endChunk: 0, viewportStartChunk: 0, viewportEndChunk: 0 },
      leadingPlaceholderRows: 0,
      trailingPlaceholderRows: 0,
      lines: renderDiffRows(allRows, { width, level, unicode, numW: plan.gutterWidth }),
    };
  }

  const range = visibleDiffChunkRange(
    plan.chunks.length,
    opts.scrollTop,
    opts.viewportHeight,
    plan.chunkSize,
    opts.overscan ?? 1,
  );
  const lines: string[] = [];
  for (let i = range.startChunk; i <= range.endChunk; i += 1) {
    const chunk = plan.chunks[i]!;
    lines.push(...renderDiffRows(chunk.rows, { width, level, unicode, numW: plan.gutterWidth }));
  }
  const firstChunk = plan.chunks[range.startChunk]!;
  const lastChunk = plan.chunks[range.endChunk]!;
  return {
    virtualized: true,
    totalRows: plan.totalRows,
    chunkCount: plan.chunks.length,
    range,
    leadingPlaceholderRows: firstChunk.startRow,
    trailingPlaceholderRows: plan.totalRows - lastChunk.endRow,
    lines,
  };
}

/** Rendered rows (without the cap footer) for tests and callers that page themselves. */
export function richDiffLines(diff: string, opts: RichDiffOptions = {}): string[] {
  if (typeof diff !== "string" || diff.trim() === "") return [];
  const level = opts.level ?? colorLevel();
  const width = Math.max(24, Math.floor(opts.width ?? 80));
  const unicode = opts.unicode !== false;
  const rows = applyContextFold(parse(diff), opts.expandContext === true);
  const numW = computeGutterWidth(rows);
  return renderDiffRows(rows, { width, level, unicode, numW });
}

/** The capped view: at most `cap` rows then a dim `… N more lines` footer. */
export function richDiff(diff: string, opts: RichDiffOptions = {}): string[] {
  const all = richDiffLines(diff, opts);
  if (opts.expandCap === true) return all;
  const cap = opts.cap ?? RICH_DIFF_LINE_CAP;
  if (all.length <= cap) return all;
  const u = opts.unicode !== false;
  return [...all.slice(0, cap), "  " + dim(`${u ? "\u2026" : "..."} ${all.length - cap} more lines`)];
}
