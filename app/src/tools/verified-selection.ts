/**
 * verified-selection.ts — Verified Selection Edit Interface (Wave 2 / Track 2B).
 *
 * Applies one or more line-range edits with fail-closed boundary verification:
 * - Each edit specifies 1-indexed inclusive `start_line..end_line`, quoted
 *   `first_line` and `last_line`, and replacement `new_text`.
 * - Verifies boundary quotes (exact or trimmed). If shifted, searches within
 *   ±3 lines and absorbs the shift ONLY when BOTH `first_line` and `last_line`
 *   agree at a unique shifted offset (fails closed on mismatch or ambiguity).
 * - Expands `@@refA-B@@` copy markers inside `new_text` by splicing lines A..B
 *   (1-indexed inclusive) from the pre-edit snapshot (fails closed on invalid
 *   or out-of-range references).
 * - Sorts non-overlapping resolved edits bottom-up and applies them atomically,
 *   rejecting overlapping ranges fail-closed.
 */

export const VERIFIED_SELECTION_MAX_SHIFT = 3;

export interface VerifiedSelectionEdit {
  start_line: number;
  end_line: number;
  first_line: string;
  last_line: string;
  new_text: string;
}

export interface AppliedVerifiedSelectionEdit {
  originalStartLine: number;
  originalEndLine: number;
  resolvedStartLine: number;
  resolvedEndLine: number;
  shift: number;
  refExpansions: number;
}

export type VerifiedSelectionResult =
  | {
      ok: true;
      content: string;
      applied: AppliedVerifiedSelectionEdit[];
    }
  | {
      ok: false;
      error: string;
    };

export interface VerifiedSelectionOptions {
  /** Maximum line shift to absorb when both boundary quotes agree (default 3). */
  maxShift?: number;
}

const REF_MARKER_RE = /@@ref(-?\d+)-(-?\d+)@@/g;

function lineMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.trim() === expected.trim();
}

export function isVerifiedSelectionEdit(value: unknown): value is VerifiedSelectionEdit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.start_line === "number" &&
    Number.isInteger(v.start_line) &&
    typeof v.end_line === "number" &&
    Number.isInteger(v.end_line) &&
    typeof v.first_line === "string" &&
    typeof v.last_line === "string" &&
    typeof v.new_text === "string"
  );
}

interface ResolvedEdit {
  index: number;
  originalStartLine: number;
  originalEndLine: number;
  resolvedStartLine: number;
  resolvedEndLine: number;
  shift: number;
  expandedNewText: string;
  refExpansions: number;
}

function expandRefMarkers(
  newText: string,
  snapshotLines: readonly string[],
  editIndex: number,
): { ok: true; text: string; count: number } | { ok: false; error: string } {
  let count = 0;
  let failure: string | null = null;
  const expanded = newText.replace(REF_MARKER_RE, (full, aStr: string, bStr: string) => {
    if (failure !== null) return full;
    const a = Number(aStr);
    const b = Number(bStr);
    if (
      !Number.isInteger(a) ||
      !Number.isInteger(b) ||
      a < 1 ||
      b < a ||
      b > snapshotLines.length
    ) {
      failure = `edit[${editIndex}]: out-of-range copy marker ${full} (file has ${snapshotLines.length} line(s))`;
      return full;
    }
    count += 1;
    return snapshotLines.slice(a - 1, b).join("\n");
  });
  if (failure !== null) return { ok: false, error: failure };
  return { ok: true, text: expanded, count };
}

function resolveBoundaries(
  edit: VerifiedSelectionEdit,
  snapshotLines: readonly string[],
  editIndex: number,
  maxShift: number,
): { ok: true; start: number; end: number; shift: number } | { ok: false; error: string } {
  const totalLines = snapshotLines.length;
  if (totalLines === 0) {
    return {
      ok: false,
      error: `edit[${editIndex}]: cannot select lines ${edit.start_line}-${edit.end_line} in an empty file`,
    };
  }
  if (!Number.isInteger(edit.start_line) || !Number.isInteger(edit.end_line)) {
    return {
      ok: false,
      error: `edit[${editIndex}]: start_line and end_line must be integers`,
    };
  }
  if (edit.start_line < 1 || edit.end_line < edit.start_line) {
    return {
      ok: false,
      error: `edit[${editIndex}]: invalid line range ${edit.start_line}-${edit.end_line}`,
    };
  }

  // 1. Check exact position (shift = 0) first.
  if (edit.start_line >= 1 && edit.end_line <= totalLines) {
    const actualFirst = snapshotLines[edit.start_line - 1]!;
    const actualLast = snapshotLines[edit.end_line - 1]!;
    if (lineMatches(actualFirst, edit.first_line) && lineMatches(actualLast, edit.last_line)) {
      return { ok: true, start: edit.start_line, end: edit.end_line, shift: 0 };
    }
  }

  // 2. Search within ±maxShift lines; absorb ONLY when BOTH boundary quotes agree uniquely.
  const shiftMatches: number[] = [];
  for (let delta = -maxShift; delta <= maxShift; delta += 1) {
    if (delta === 0) continue;
    const s = edit.start_line + delta;
    const e = edit.end_line + delta;
    if (s < 1 || e > totalLines) continue;
    const actualFirst = snapshotLines[s - 1]!;
    const actualLast = snapshotLines[e - 1]!;
    if (lineMatches(actualFirst, edit.first_line) && lineMatches(actualLast, edit.last_line)) {
      shiftMatches.push(delta);
    }
  }

  if (shiftMatches.length === 1) {
    const shift = shiftMatches[0]!;
    return {
      ok: true,
      start: edit.start_line + shift,
      end: edit.end_line + shift,
      shift,
    };
  }

  if (shiftMatches.length > 1) {
    const offsets = shiftMatches.map((d) => (d > 0 ? `+${d}` : `${d}`)).join(", ");
    return {
      ok: false,
      error: `edit[${editIndex}]: ambiguous boundary shift for lines ${edit.start_line}-${edit.end_line} (matched offsets ${offsets})`,
    };
  }

  const actualFirstDesc =
    edit.start_line >= 1 && edit.start_line <= totalLines
      ? JSON.stringify(snapshotLines[edit.start_line - 1])
      : "<out-of-range>";
  const actualLastDesc =
    edit.end_line >= 1 && edit.end_line <= totalLines
      ? JSON.stringify(snapshotLines[edit.end_line - 1])
      : "<out-of-range>";

  return {
    ok: false,
    error:
      `edit[${editIndex}]: boundary mismatch at lines ${edit.start_line}-${edit.end_line} ` +
      `(expected first=${JSON.stringify(edit.first_line)}, last=${JSON.stringify(edit.last_line)}; ` +
      `actual first=${actualFirstDesc}, last=${actualLastDesc}; no unique match within ±${maxShift} lines)`,
  };
}

/**
 * Apply one or more verified-selection edits atomically to `content`.
 * Pure and side-effect free; fails closed on any mismatch, ambiguity, overlap,
 * or invalid `@@refA-B@@` copy marker.
 */
export function applyVerifiedSelectionEdits(
  content: string,
  edits: readonly VerifiedSelectionEdit[],
  opts: VerifiedSelectionOptions = {},
): VerifiedSelectionResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "edits must be a non-empty array" };
  }
  const maxShift =
    opts.maxShift !== undefined && Number.isInteger(opts.maxShift) && opts.maxShift >= 0
      ? opts.maxShift
      : VERIFIED_SELECTION_MAX_SHIFT;

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lf = content.replaceAll("\r\n", "\n");
  const hadTrailingNewline = lf.endsWith("\n");
  const snapshotLines =
    lf === "" ? [] : hadTrailingNewline ? lf.slice(0, -1).split("\n") : lf.split("\n");

  const resolved: ResolvedEdit[] = [];

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (!isVerifiedSelectionEdit(edit)) {
      return {
        ok: false,
        error: `edit[${i}]: must specify integer start_line, end_line and string first_line, last_line, new_text`,
      };
    }

    const bounds = resolveBoundaries(edit, snapshotLines, i, maxShift);
    if (bounds.ok === false) return { ok: false, error: bounds.error };

    const newTextLf = edit.new_text.replaceAll("\r\n", "\n");
    const expanded = expandRefMarkers(newTextLf, snapshotLines, i);
    if (expanded.ok === false) return { ok: false, error: expanded.error };

    resolved.push({
      index: i,
      originalStartLine: edit.start_line,
      originalEndLine: edit.end_line,
      resolvedStartLine: bounds.start,
      resolvedEndLine: bounds.end,
      shift: bounds.shift,
      expandedNewText: expanded.text,
      refExpansions: expanded.count,
    });
  }

  // Reject any overlapping ranges (fail closed) after shift resolution.
  const ascending = resolved.slice().sort((a, b) => a.resolvedStartLine - b.resolvedStartLine || a.resolvedEndLine - b.resolvedEndLine);
  for (let i = 1; i < ascending.length; i += 1) {
    const prev = ascending[i - 1]!;
    const curr = ascending[i]!;
    if (curr.resolvedStartLine <= prev.resolvedEndLine) {
      return {
        ok: false,
        error:
          `overlapping edit ranges: edit[${prev.index}] (lines ${prev.resolvedStartLine}-${prev.resolvedEndLine}) ` +
          `overlaps edit[${curr.index}] (lines ${curr.resolvedStartLine}-${curr.resolvedEndLine})`,
      };
    }
  }

  // Apply non-overlapping edits bottom-up (highest line range first) atomically.
  const bottomUp = ascending.slice().reverse();
  const working = snapshotLines.slice();
  for (const item of bottomUp) {
    const replacementLines =
      item.expandedNewText === ""
        ? []
        : item.expandedNewText.endsWith("\n")
          ? item.expandedNewText.slice(0, -1).split("\n")
          : item.expandedNewText.split("\n");
    const deleteCount = item.resolvedEndLine - item.resolvedStartLine + 1;
    working.splice(item.resolvedStartLine - 1, deleteCount, ...replacementLines);
  }

  const nextContent =
    working.length === 0 ? "" : working.join(eol) + (hadTrailingNewline ? eol : "");

  const applied: AppliedVerifiedSelectionEdit[] = resolved.map((r) => ({
    originalStartLine: r.originalStartLine,
    originalEndLine: r.originalEndLine,
    resolvedStartLine: r.resolvedStartLine,
    resolvedEndLine: r.resolvedEndLine,
    shift: r.shift,
    refExpansions: r.refExpansions,
  }));

  return { ok: true, content: nextContent, applied };
}
