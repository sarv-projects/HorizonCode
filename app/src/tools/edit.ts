/**
 * `edit` — exact replacement in one file, with the NF-069/A-1…A-5 repair ladder.
 *
 * Symlink policy (shared with `write`): verify-then-allow — an edit through a
 * file-level symlink to a legitimate target keeps working, and the effect goes
 * through an open descriptor re-verified against the kernel state directory
 * before the write (see the header of ./write.ts for the residual).
 */

import { readFile } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { withFileLock, targetLockPath } from "../core/file-lock";
import { realpathish } from "../core/paths";
import { isRefused, writeAtomic } from "./atomic-write";
import { checkpointDirtyPathBeforeEdit } from "../core/git-dirty-checkpoint";
import { recordChange } from "./change-journal";
import { isBinary, relPath, resolvePath } from "./helpers";
import { resolveAnchor } from "./hashline";
import { detectLineEnding } from "./line-endings";
import { noteRead, wasRead } from "./read-ledger";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dirtyCheckpointPrefix(ctx: ToolContext, rel: string): string {
  const cp = checkpointDirtyPathBeforeEdit(ctx.workspace, rel);
  if (cp.committed && cp.notice) return `${cp.notice}\n`;
  if (cp.error) return `[git checkpoint failed: ${cp.error}]\n`;
  return "";
}

/** Non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Replace every occurrence of `old` with `next` (never one — use replaceFirst for that). */
function replaceAll(hay: string, oldStr: string, next: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const i = hay.indexOf(oldStr, from);
    if (i === -1) break;
    out += hay.slice(from, i) + next;
    from = i + oldStr.length;
  }
  return out + hay.slice(from);
}

function replaceFirst(hay: string, oldStr: string, next: string): string {
  const i = hay.indexOf(oldStr);
  if (i === -1) return hay;
  return hay.slice(0, i) + next + hay.slice(i + oldStr.length);
}

/* ------------------------------ CRLF / LF view ----------------------------- */

/**
 * CRLF safety (FEAT-001). Every rung matches against an LF VIEW of the file
 * (before.replaceAll("\r\n","\n")), the same bytes `read` shows the model, so a
 * CRLF or mixed-ending file neither blocks a match nor leaks "\r" into the
 * old/new strings. On write, untouched regions keep their exact original bytes
 * and the replacement block takes the matched region's native ending, so a CRLF
 * file is NEVER rewritten to LF wholesale (per-region preservation, like
 * opencode's withRegionEndings).
 *
 * The exact path maps view offsets back to the original bytes through the list
 * of removed-"\r" positions; the fuzzy path works on a line model that carries
 * each original line's own ending alongside the LF-view lines.
 *
 * An explicit endings-only escape (old/new differ only in "\r") is intentionally
 * OUT OF SCOPE for FEAT-001: with LF-only old/new strings there is nothing to
 * request a bare ending flip, the normalisation already keeps endings stable,
 * and adding the branch would carry no test surface in this feature. FEAT-002
 * may revisit it.
 */
const CRLF = "\r\n";

/** The LF view of `source`, plus the ascending SOURCE offsets of each removed "\r". */
interface LfView {
  view: string;
  removed: number[];
}

function toLfView(source: string): LfView {
  if (!source.includes("\r")) return { view: source, removed: [] };
  let view = "";
  const removed: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\r" && source[i + 1] === "\n") {
      removed.push(i); // drop the "\r"; the "\n" is copied next iteration
      continue;
    }
    view += source[i];
  }
  return { view, removed };
}

/**
 * Map a view offset back to the original source offset. Each removed "\r" that
 * sat before the mapped point shifts the source offset by +1. `removed` holds
 * SOURCE offsets; the i-th removed "\r" sat after (removed[i] - i) view chars,
 * so count how many removed entries precede `viewOffset` view chars.
 */
function viewToSource(removed: number[], viewOffset: number): number {
  let low = 0;
  let high = removed.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((removed[mid] as number) - mid < viewOffset) low = mid + 1;
    else high = mid;
  }
  return viewOffset + low;
}

/**
 * Exact-path replacement that preserves endings: match on the LF view, map the
 * matched view offsets back to source offsets, and give the replacement the
 * ending detected over the matched source region. Untouched source bytes are
 * copied verbatim, so CRLF survives outside the edit. For a pure-LF file this
 * is byte-identical to the old slice-and-splice.
 */
function replaceExactPreserving(source: string, lf: LfView, oldLf: string, newLf: string, all: boolean): string {
  let out = "";
  let viewFrom = 0;
  let srcFrom = 0;
  for (;;) {
    const i = lf.view.indexOf(oldLf, viewFrom);
    if (i === -1) break;
    const srcStart = viewToSource(lf.removed, i);
    const srcEnd = viewToSource(lf.removed, i + oldLf.length);
    const regionEnding = detectLineEnding(source.slice(srcStart, srcEnd));
    out += source.slice(srcFrom, srcStart) + newLf.split("\n").join(regionEnding);
    viewFrom = i + oldLf.length;
    srcFrom = srcEnd;
    if (!all) break;
  }
  return out + source.slice(srcFrom);
}

/**
 * The fuzzy rungs index lines exactly as the pre-CRLF code did:
 * fileLines = lf.view.split("\n"). That array has a trailing "" when the view
 * ends in "\n", and every reported line number / candidate window stays
 * byte-identical to the A-5 fixtures. The only new thing tracked alongside it
 * is each line break's ORIGINAL ending bytes so the splice can restore them.
 *
 * endings[k] is the ending that followed fileLines[k] in the source ("\r\n",
 * "\n", or "" when there was no break after it). There is one fewer break than
 * fileLines has entries, so the final entry's ending is "".
 */
interface FuzzyModel {
  fileLines: string[];
  endings: string[];
}

function fuzzyModel(source: string, view: string): FuzzyModel {
  const fileLines = view.split("\n");
  const endings: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") endings.push(i > 0 && source[i - 1] === "\r" ? CRLF : "\n");
  }
  endings.push(""); // the final view line has no trailing break
  return { fileLines, endings };
}

/**
 * Splice `replacement` (LF-view lines) into the file between view-line indices
 * [start, end]. Untouched head/tail lines are rejoined with their ORIGINAL
 * endings, so a CRLF file stays CRLF everywhere it is not edited. The
 * replacement block takes the ending detected over the matched region's native
 * endings; the break that followed the region's last line (endings[end]) is
 * preserved on the replacement's last line (it may be "" at an unterminated
 * EOF), matching the old join-on-"\n" shape for a pure-LF file.
 */
function spliceWithEndings(model: FuzzyModel, start: number, end: number, replacement: string[], includeLastBreak = false): string {
  // Detect over the matched region's break bytes (joined with a non-break filler
  // so detectLineEnding only sees the endings themselves).
  // Anchored edits replace whole lines, so a single-line region still has a native
  // ending to inherit: includeLastBreak counts the break after the region's last line.
  const regionEnding = detectLineEnding(model.endings.slice(start, includeLastBreak ? end + 1 : end).join("x"));
  const tailBoundaryEnding = model.endings[end] as string;
  let out = "";
  for (let k = 0; k < start; k += 1) out += (model.fileLines[k] as string) + (model.endings[k] as string);
  for (let r = 0; r < replacement.length; r += 1) {
    const last = r === replacement.length - 1;
    out += (replacement[r] as string) + (last ? tailBoundaryEnding : regionEnding);
  }
  for (let k = end + 1; k < model.fileLines.length; k += 1) {
    out += (model.fileLines[k] as string) + (model.endings[k] as string);
  }
  return out;
}

/**
 * The exact-rung projection of this edit against `before`: what the file would
 * contain if the call ran right now. Pure and side-effect free — plan-mode
 * staging uses it to show the diff without touching disk. The fuzzy rungs are
 * deliberately NOT projected: they consume the session's reflection slot and
 * depend on a live read, so staging refuses them instead of guessing (the
 * model is told to use write with the full content, or exit plan mode).
 */
export function projectExactEdit(
  before: string,
  oldStr: string,
  newStr: string,
  all: boolean,
): { ok: true; after: string } | { ok: false; error: string } {
  const matches = countOccurrences(before, oldStr);
  if (matches === 0) return { ok: false, error: "no exact match for the old text" };
  if (matches > 1 && !all) {
    return { ok: false, error: `found ${matches} matches; set all:true or provide more context` };
  }
  return { ok: true, after: all ? replaceAll(before, oldStr, newStr) : replaceFirst(before, oldStr, newStr) };
}

/* ----------------------------- Unicode folding ----------------------------- */

/**
 * normalizeForMatch (FEAT-002) — fold the EXACT codex code points so an old
 * string whose only difference from the file is a smart quote, a typographic
 * dash, or a non-breaking / wide space still matches. The set is lifted verbatim
 * from codex's seek_sequence.rs (research/compare-codex-grok.md §1.5); opencode's
 * normalizeForMatch is the TS reference for the regex shape. The code points are
 * written as \u escapes per the repo's source convention for non-ASCII.
 *
 *   smart single quotes  \u2018 \u2019 \u201A \u201B            -> '
 *   smart double quotes  \u201C \u201D \u201E \u201F            -> "
 *   typographic dashes   \u2010 \u2011 \u2012 \u2013 \u2014 \u2015 \u2212 -> -
 *   space family         \u00A0 \u2002..\u200A \u202F \u205F \u3000     -> (space)
 *
 * This is a BYTE-LEVEL normalisation: it never changes line structure, so the
 * unicode-fold rung is a tight, high-confidence rung — it sits just below
 * indent-normalised and above the looser trim/anchor rungs, and (like every
 * fuzzy rung) applies only on a UNIQUE match under the read + reflection gate.
 */
function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ");
}

/* --------------------------- oh-my-pi thresholds --------------------------- */

/**
 * Named fuzzy-ladder thresholds, lifted from oh-my-pi's 10-strategy matcher
 * (research/compare-ohmypi-deepseek.md §1.7) and recorded here as a documented,
 * future-stable PRIOR. HorizonCode's ladder is deliberately STRUCTURAL rather
 * than score-based — a rung matches when its normalised windows are equal and
 * UNIQUE, never on a similarity score — so the similarity/confidence constants
 * below are not wired into a scoring path (doing so would change which matches
 * apply and break the unique-match discipline). They name the prior so a future
 * score-based rung has a tuned starting point instead of magic numbers.
 *
 * The feedback constants (MAX_RECORDED_MATCHES, OCCURRENCE_PREVIEW_CONTEXT,
 * OCCURRENCE_PREVIEW_MAX_LEN) ARE wired, into the miss-feedback previews below.
 */
export const DEFAULT_FUZZY_THRESHOLD = 0.95;
export const SEQUENCE_FUZZY_THRESHOLD = 0.92;
export const FALLBACK_THRESHOLD = 0.8;
export const CONTEXT_FUZZY_THRESHOLD = 0.8;
export const CHARACTER_MATCH_THRESHOLD = 0.92;
export const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;
export const DOMINANT_FUZZY_DELTA = 0.08;
export const PARTIAL_MATCH_MIN_LENGTH = 6;
export const PARTIAL_MATCH_MIN_RATIO = 0.3;

/** Up to this many closest-candidate previews are rendered in miss feedback. */
export const MAX_RECORDED_MATCHES = 5;
/** Lines of context shown per candidate preview. */
export const OCCURRENCE_PREVIEW_CONTEXT = 5;
/** A preview line longer than this is truncated with an ellipsis. */
export const OCCURRENCE_PREVIEW_MAX_LEN = 80;

/* ------------------------- NF-069 / A-1…A-5 ladder ------------------------- */

/**
 * The escalation order, as reported in results and errors (byte-stable).
 *
 * "unicode-fold" (FEAT-002) sits between indent-normalised and the looser
 * trim/anchor rungs: it is a tight, byte-level normalisation (smart quotes,
 * typographic dashes, exotic spaces) that preserves line structure, so it is a
 * higher-confidence rung than the trim merge or the anchor patch. An exact match
 * still wins before it (exact beats fold); fold still wins before 3-way merge
 * and line-patch (fold beats the looser rungs).
 */
export const EDIT_LADDER = ["exact", "indent-normalised", "unicode-fold", "3-way merge", "line-patch"] as const;
export type EditRung = (typeof EDIT_LADDER)[number];

/**
 * A-4: one bounded reflection slot per (session, file). After the first failed
 * repair attempt the model gets the diff-shaped feedback once; a second failure
 * on the same file disables fuzzy matching for it until an edit succeeds.
 */
export const MAX_EDIT_REFLECTIONS = 1;

/** Failed locate attempts per `session\0path`; cleared by a successful edit. */
const reflections = new Map<string, number>();

function reflectionKey(ctx: ToolContext, resolved: string): string {
  return `${ctx.sessionId}\u0000${resolved}`;
}

const LEADING_WS = /^[ \t]*/;

function leadingWhitespace(line: string): string {
  return LEADING_WS.exec(line)?.[0] ?? "";
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** The longest common leading-whitespace prefix over the non-blank lines. */
function commonIndentPrefix(lines: string[]): string {
  let prefix: string | null = null;
  for (const line of lines) {
    if (isBlank(line)) continue;
    const ws = leadingWhitespace(line);
    if (prefix === null) prefix = ws;
    else {
      let i = 0;
      const max = Math.min(prefix.length, ws.length);
      while (i < max && prefix[i] === ws[i]) i += 1;
      prefix = prefix.slice(0, i);
    }
    if (prefix === "") return "";
  }
  return prefix ?? "";
}

/** Strip `prefix` from every line that carries it; blank lines become "". */
function stripIndent(lines: string[], prefix: string): string[] {
  return lines.map((line) => (isBlank(line) ? "" : line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

/** Re-indent `lines` by `prefix`, preserving relative indentation inside the block. */
function reindent(lines: string[], prefix: string): string[] {
  if (prefix === "") return lines;
  const own = commonIndentPrefix(lines);
  return lines.map((line) => (isBlank(line) ? "" : prefix + (own === "" ? line : line.startsWith(own) ? line.slice(own.length) : line)));
}

interface Candidate {
  start: number; // 0-based first line index in the file
  end: number; // 0-based last line index (inclusive)
  rung: EditRung;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Collect every window of `len` lines whose normalised form equals `target`'s. */
function windowsMatching(fileLines: string[], len: number, normalise: (window: string[]) => string[], target: string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + len <= fileLines.length; start += 1) {
    const window = fileLines.slice(start, start + len);
    if (sameLines(normalise(window), target)) starts.push(start);
  }
  return starts;
}

/** Rung 2: relative-indent normalisation — strip each block's common prefix. */
function candidatesIndent(fileLines: string[], oldLines: string[]): number[] {
  const oldNorm = stripIndent(oldLines, commonIndentPrefix(oldLines));
  return windowsMatching(fileLines, oldLines.length, (w) => stripIndent(w, commonIndentPrefix(w)), oldNorm);
}

/**
 * Rung 3 (unicode-fold): every line equal after folding the codex code points.
 * A byte-level normalisation that preserves line count and structure, so it runs
 * under the same windowsMatching unique-match machinery as the other rungs and
 * refuses rather than guesses when more than one window folds to the target.
 */
function candidatesUnicode(fileLines: string[], oldLines: string[]): number[] {
  const oldNorm = oldLines.map(normalizeForMatch);
  return windowsMatching(fileLines, oldLines.length, (w) => w.map(normalizeForMatch), oldNorm);
}

/** Rung 4: three-way merge — every line equal after trimming. */
function candidatesMerge(fileLines: string[], oldLines: string[]): number[] {
  const oldTrim = oldLines.map((l) => l.trim());
  return windowsMatching(fileLines, oldLines.length, (w) => w.map((l) => l.trim()), oldTrim);
}

/** Rung 5: line-level patch — first/last non-blank lines as anchors, unique pair. */
function candidatesLinePatch(fileLines: string[], oldLines: string[]): number[] {
  const anchors: number[] = [];
  oldLines.forEach((line, i) => {
    if (!isBlank(line)) anchors.push(i);
  });
  if (anchors.length < 2) return [];
  const firstAt = anchors[0] as number;
  const lastAt = anchors[anchors.length - 1] as number;
  const first = (oldLines[firstAt] as string).trim();
  const last = (oldLines[lastAt] as string).trim();
  const starts: number[] = [];
  for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
    const head = fileLines[start + firstAt] as string;
    const tail = fileLines[start + lastAt] as string;
    if (head.trim() === first && tail.trim() === last) starts.push(start);
  }
  return starts;
}

function lineSpans(starts: number[], len: number): string {
  return starts.map((s) => `${s + 1}-${s + len}`).join(", ");
}

/** Diff-shaped feedback: the closest actual window, paired with the failing block. */
function closestBlock(fileLines: string[], oldLines: string[]): { text: string; start: number } | null {
  let best: { start: number; score: number } | null = null;
  for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
    let equal = 0;
    for (let i = 0; i < oldLines.length; i += 1) {
      if ((fileLines[start + i] as string).trim() === (oldLines[i] as string).trim()) equal += 1;
    }
    const score = equal / Math.max(oldLines.length, 1);
    if (best === null || score > best.score) best = { start, score };
  }
  if (best === null || best.score === 0) return null;
  const shown = Math.min(oldLines.length, 12);
  const pairs: string[] = [];
  for (let i = 0; i < shown; i += 1) {
    pairs.push(`  - ${oldLines[i] as string}`);
    pairs.push(`  + ${fileLines[best.start + i] as string}`);
  }
  if (oldLines.length > shown) pairs.push(`  \u2026 (${oldLines.length - shown} more lines)`);
  const pct = Math.round(best.score * 100);
  return {
    start: best.start,
    text: `closest actual lines (lines ${best.start + 1}-${best.start + oldLines.length}, ${pct}% similar):\n${pairs.join("\n")}`,
  };
}

/** Truncate `line` to OCCURRENCE_PREVIEW_MAX_LEN chars, ending with an ellipsis. */
function truncatePreviewLine(line: string): string {
  if (line.length <= OCCURRENCE_PREVIEW_MAX_LEN) return line;
  return line.slice(0, OCCURRENCE_PREVIEW_MAX_LEN - 1) + "\u2026";
}

/**
 * FEAT-002 miss feedback: up to MAX_RECORDED_MATCHES=5 closest candidate
 * windows, each rendered as OCCURRENCE_PREVIEW_CONTEXT=5 lines of the file with
 * every line truncated to OCCURRENCE_PREVIEW_MAX_LEN=80 chars. Scored by the
 * same trim-equal line overlap as closestBlock; windows with zero overlap are
 * dropped. Reveals file contents, so the caller only renders it after the
 * read-before-write gate (wasRead).
 */
function candidatePreviews(fileLines: string[], oldLines: string[]): string | null {
  const len = Math.max(oldLines.length, 1);
  const scored: Array<{ start: number; score: number }> = [];
  for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
    let equal = 0;
    for (let i = 0; i < oldLines.length; i += 1) {
      if ((fileLines[start + i] as string).trim() === (oldLines[i] as string).trim()) equal += 1;
    }
    const score = equal / len;
    if (score > 0) scored.push({ start, score });
  }
  if (scored.length === 0) return null;
  // Highest overlap first; ties keep file order (stable by start).
  scored.sort((a, b) => (b.score - a.score) || (a.start - b.start));
  const top = scored.slice(0, MAX_RECORDED_MATCHES);
  const blocks: string[] = [`closest candidates (up to ${MAX_RECORDED_MATCHES}, ${OCCURRENCE_PREVIEW_CONTEXT} lines each):`];
  for (const cand of top) {
    const windowEnd = Math.min(cand.start + OCCURRENCE_PREVIEW_CONTEXT, fileLines.length);
    const pct = Math.round(cand.score * 100);
    const body: string[] = [`  lines ${cand.start + 1}-${windowEnd} (${pct}% similar):`];
    for (let k = cand.start; k < windowEnd; k += 1) {
      body.push(`    ${truncatePreviewLine(fileLines[k] as string)}`);
    }
    blocks.push(body.join("\n"));
  }
  return blocks.join("\n");
}

/** Is the replacement already present? (A-3: "REPLACE lines already present") */
function replaceAlreadyPresent(fileLines: string[], newLines: string[]): string | null {
  if (newLines.length === 0) return null;
  for (let start = 0; start + newLines.length <= fileLines.length; start += 1) {
    let all = true;
    for (let i = 0; i < newLines.length; i += 1) {
      if ((fileLines[start + i] as string).trim() !== (newLines[i] as string).trim()) {
        all = false;
        break;
      }
    }
    if (all) return `the new text already appears at lines ${start + 1}-${start + newLines.length} \u2014 the file may already contain this edit`;
  }
  return null;
}

const FAILED_SEARCH_FUZZY = `searched: ${EDIT_LADDER.join(" \u2192 ")}; no unique match`;
const FAILED_SEARCH_EXACT_ONLY = `searched: exact only (fuzzy matching disabled after the reflection limit)`;

/**
 * The full diff-shaped failure text; byte-stable from here (A-5).
 *
 * `canShowContent` is the read-before-write gate (wasRead): the diff-shaped
 * closest block, the FEAT-002 multi-candidate previews, and the already-applied
 * branch all reveal file contents, so they are emitted ONLY when the session is
 * allowed to read the file (mirroring opencode's read-permission gate on
 * missHint). When it has not read the file, those lines are omitted and only the
 * header + searched + reflection lines remain.
 */
function locateFailed(
  rel: string,
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
  fuzzyDisabled: boolean,
  attempts: number,
  canShowContent: boolean,
): string {
  const lines = [`old string not found in ${rel}`, fuzzyDisabled ? FAILED_SEARCH_EXACT_ONLY : FAILED_SEARCH_FUZZY];
  if (canShowContent) {
    const closest = closestBlock(fileLines, oldLines);
    lines.push(closest === null ? "no similar lines found" : closest.text);
    const previews = candidatePreviews(fileLines, oldLines);
    if (previews !== null) lines.push(previews);
    const present = replaceAlreadyPresent(fileLines, newLines);
    if (present !== null) lines.push(present);
  }
  if (attempts > MAX_EDIT_REFLECTIONS) {
    lines.push(
      `reflection limit reached (max_reflections=${MAX_EDIT_REFLECTIONS}) \u2014 read the file again; fuzzy matching is disabled for this file until an edit succeeds`,
    );
  } else {
    lines.push(
      `reflection: ${attempts}/${MAX_EDIT_REFLECTIONS} \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file`,
    );
  }
  return lines.join("\n");
}

function ambiguousFailure(rel: string, rung: EditRung, starts: number[], len: number, attempts: number): string {
  const tail =
    attempts > MAX_EDIT_REFLECTIONS
      ? `reflection limit reached (max_reflections=${MAX_EDIT_REFLECTIONS}) \u2014 read the file again; fuzzy matching is disabled for this file until an edit succeeds`
      : `reflection: ${attempts}/${MAX_EDIT_REFLECTIONS} \u2014 fix this call using the feedback above; a second failure disables fuzzy matching for this file`;
  return `near-match is ambiguous in ${rel} after ${rung} matching: ${starts.length} candidates (lines ${lineSpans(starts, len)}); provide more context (no edit applied)\n${tail}`;
}

/** 1-based line numbers of each occurrence of `needle`. */
function occurrenceLines(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    out.push(hay.slice(0, i).split("\n").length);
  }
  return out;
}

/**
 * Anchored mode (docs/28 ruling 64): replace the line range start_anchor..end_anchor
 * (end defaults to start) with `new`. Anchors come from `read` with anchors:true; each is
 * validated Valid / Stale / OutOfRange against the current file, a small shift within
 * +-15 lines is recovered when unique, and a truncated, malformed, ambiguous or
 * unrecoverable anchor refuses with nothing written. `new` replaces whole lines; an empty
 * `new` deletes them. Same guard -> approve -> lock -> preimage sha256 -> atomic write ->
 * journal discipline as the string mode, and the anchors are resolved against the exact
 * bytes whose sha256 is later re-checked, so a concurrent change is a Conflict, not a guess.
 */
async function executeAnchored(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (typeof args.path !== "string" || args.path === "") return fail("path is required");
  if (typeof args.start_anchor !== "string") return fail("start_anchor must be a string");
  if (args.end_anchor !== undefined && typeof args.end_anchor !== "string") return fail("end_anchor must be a string");
  if (args.old !== undefined) return fail("start_anchor and old are mutually exclusive: use one addressing mode");
  if (args.all !== undefined) return fail("all does not apply to an anchored edit");
  if (typeof args.new !== "string") return fail("new is required");

  const resolved = resolvePath(ctx.cwd, args.path);
  const rel = relPath(ctx.cwd, resolved);
  const action: GuardAction = { kind: "fs.write", target: resolved };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
  }

  let before: string;
  let preimageSha256: string;
  try {
    const buf = await readFile(resolved);
    if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);
    before = buf.toString("utf8");
    preimageSha256 = sha256Hex(before);
  } catch {
    return fail(`file not found: ${rel}`);
  }
  const checkpointNote = dirtyCheckpointPrefix(ctx, rel);

  const lf = toLfView(before);
  const model = fuzzyModel(before, lf.view);
  // The same line list `read` numbers: no phantom last line from a trailing newline.
  const lines = before === "" ? [] : model.fileLines.slice();
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const first = resolveAnchor(args.start_anchor, lines);
  if (first.ok === false) return fail(`${first.error} (${rel}; no edit applied)`);
  const endText = args.end_anchor;
  const last = typeof endText === "string" ? resolveAnchor(endText, lines) : first;
  if (last.ok === false) return fail(`${last.error} (${rel}; no edit applied)`);
  if (last.line < first.line) {
    return fail(`end_anchor (line ${last.line}) is before start_anchor (line ${first.line}) in ${rel}; no edit applied`);
  }

  const newLf = args.new.replaceAll(CRLF, "\n");
  const replacement = newLf === "" ? [] : newLf.endsWith("\n") ? newLf.slice(0, -1).split("\n") : newLf.split("\n");
  const after = spliceWithEndings(model, first.line - 1, last.line - 1, replacement, true);
  const span = last.line - first.line + 1;
  const shifts = [first, last]
    .filter((r, i, a) => r.shiftedFrom !== undefined && (i === 0 || r !== a[0]))
    .map((r) => `${r.shiftedFrom} -> ${r.line}`);

  if (decision.decision === "ask") {
    const approved = await ctx.approve(
      { title: `Edit ${rel}`, detail: `lines ${first.line}-${last.line} (anchored)`, kind: "fs.write" },
      action,
    );
    if (!approved) return fail("declined by user");
  }

  const locked = await withFileLock(targetLockPath(ctx.workspace, realpathish(resolved)), async (): Promise<ToolResult | undefined> => {
    let actualSha256: string;
    try {
      actualSha256 = sha256Hex((await readFile(resolved)).toString("utf8"));
    } catch {
      actualSha256 = "unreadable";
    }
    if (actualSha256 !== preimageSha256) {
      return fail(
        `HZ_PRECONDITION_FAILED: edit refused: preimage changed: ${rel} ` +
          `(expected sha256 ${preimageSha256}; actual sha256 ${actualSha256}; changedBy unknown)`,
      );
    }
    const outcome = await writeAtomic(resolved, after, ctx);
    if (isRefused(outcome)) return fail(outcome.refusal);
    if ((await readFile(resolved)).toString("utf8") !== after) {
      return fail(`verification failed: ${rel} does not match the intended content`);
    }
    recordChange(ctx.sessionId, { path: resolved, rel, before, afterSha256: sha256Hex(after), at: Date.now(), tool: "edit" });
    return undefined;
  }).catch((e: unknown) => fail(msg(e)));
  if (locked !== undefined) return locked;

  noteRead(ctx, resolved);
  const suffix = shifts.length > 0 ? ` (anchors shifted: ${shifts.join(", ")})` : "";
  return { ok: true, output: `${checkpointNote}Replaced lines ${first.line}-${last.line} (${span} line(s)) in ${rel} via anchors${suffix}` };
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace a string in a file: exact match, then relative-indent, three-way-merge and line-patch repair rungs (each only when unambiguous). All occurrences or the first only. Alternatively, address whole lines by the anchors read returns with anchors:true (start_anchor, optional end_anchor) instead of old.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old: { type: "string", description: "String to replace (must not be empty). Omit when using start_anchor." },
      new: { type: "string", description: "Replacement string." },
      all: { type: "boolean", description: "Replace every occurrence (default false)." },
      start_anchor: {
        type: "string",
        description: "Anchored mode: first line to replace, LINE:abc:def from read anchors:true. Replaces old; the whole line range becomes new (empty new deletes).",
      },
      end_anchor: { type: "string", description: "Anchored mode: last line to replace (default start_anchor)." },
    },
    required: ["path", "new"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (args.start_anchor !== undefined) return await executeAnchored(args, ctx);
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.old !== "string") return fail("old is required");
      if (args.old === "") return fail("old must not be empty");
      if (typeof args.new !== "string") return fail("new is required");

      const oldStr = args.old;
      const newStr = args.new;
      const all = args.all === true;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);

      const action: GuardAction = { kind: "fs.write", target: resolved };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }

      let before: string;
      let preimageSha256: string;
      try {
        const buf = await readFile(resolved);
        if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);
        before = buf.toString("utf8");
        preimageSha256 = sha256Hex(before); // docs/09 §8.2: the preimage this call read
      } catch {
        return fail(`file not found: ${rel}`);
      }
      const checkpointNote = dirtyCheckpointPrefix(ctx, rel);

      // CRLF safety: match against the LF VIEW the model sees. The old/new
      // strings are normalised to LF too (models emit LF; this is defensive
      // against a stray "\r"), and every rung below works on the view.
      const lf = toLfView(before);
      const oldLf = oldStr.replaceAll(CRLF, "\n");
      const newLf = newStr.replaceAll(CRLF, "\n");

      const matches = countOccurrences(lf.view, oldLf);
      let after: string;
      let rung: EditRung = "exact";

      if (matches > 0) {
        if (matches > 1 && !all) {
          const lines = occurrenceLines(lf.view, oldLf).join(", ");
          return fail(`found ${matches} matches in ${rel} (lines ${lines}); set all:true or provide more context`);
        }
        // Splice into the ORIGINAL bytes, giving the replacement the matched
        // region's native ending; untouched regions keep their exact endings.
        after = replaceExactPreserving(before, lf, oldLf, newLf, all);
      } else {
        // Read-before-write (audit finding 2), applied where the guesswork is: an
        // exact-string edit carries its own preimage text, but a fuzzy rung
        // RECONSTRUCTS a location and can splice a replacement into a region the
        // model never inspected. That requires having read the file this session.
        if (!wasRead(ctx, resolved)) {
          return fail(
            `HZ_PRECONDITION_FAILED: edit refused: no exact match for the old text in ${rel}, and this session ` +
              `has not read the file — so the fuzzy rungs cannot be trusted; read ${rel} and edit again`,
          );
        }
        // NF-069 ladder: exact found nothing — escalate, but only while the
        // reflection slot is unspent, and only ever to a UNIQUE match.
        const key = reflectionKey(ctx, resolved);
        const attempts = (reflections.get(key) ?? 0) + 1;
        reflections.set(key, attempts);
        const fuzzyDisabled = attempts > MAX_EDIT_REFLECTIONS;

        // The fuzzy rungs match on the LF view's lines, carried by a model that
        // also tracks each original line's native ending for the splice.
        const model = fuzzyModel(before, lf.view);
        const fileLines = model.fileLines;
        const oldLines = oldLf.split("\n");
        const newLines = newLf.split("\n");

        let found: Candidate | null = null;
        if (!fuzzyDisabled) {
          const rungs: Array<{ rung: EditRung; starts: number[] }> = [
            { rung: "indent-normalised", starts: candidatesIndent(fileLines, oldLines) },
            { rung: "unicode-fold", starts: candidatesUnicode(fileLines, oldLines) },
            { rung: "3-way merge", starts: candidatesMerge(fileLines, oldLines) },
            { rung: "line-patch", starts: candidatesLinePatch(fileLines, oldLines) },
          ];
          for (const step of rungs) {
            if (step.starts.length === 1) {
              found = { start: step.starts[0] as number, end: (step.starts[0] as number) + oldLines.length - 1, rung: step.rung };
              break;
            }
            if (step.starts.length > 1) {
              return fail(ambiguousFailure(rel, step.rung, step.starts, oldLines.length, attempts));
            }
          }
        }
        if (found === null) {
          return fail(locateFailed(rel, fileLines, oldLines, newLines, fuzzyDisabled, attempts, wasRead(ctx, resolved)));
        }

        rung = found.rung;
        const window = fileLines.slice(found.start, found.end + 1);
        const replacement = reindent(newLines, commonIndentPrefix(window));
        // Splice into the original line model: head/tail lines keep their exact
        // bytes, the replacement block takes the matched region's native ending.
        after = spliceWithEndings(model, found.start, found.end, replacement);
      }

      const replacements = matches > 0 ? (all ? matches : 1) : 1;

      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          {
            title: `Edit ${rel}`,
            detail: `${replacements} occurrence(s)`,
            kind: "fs.write",
          },
          action,
        );
        if (!approved) return fail("declined by user");
      }

      // Cross-process (core/file-lock.ts): verify -> write -> journal is one critical
      // section per target file, taken AFTER approval. A second process that changed
      // the file first is caught by the sha256 check below, never clobbered.
      const locked = await withFileLock(targetLockPath(ctx.workspace, realpathish(resolved)), async (): Promise<ToolResult | undefined> => {
        // docs/09 §8.2 (R-tools-48): the preimage is checked immediately before
        // the write — a file changed during the guard/approval window is a
        // `Conflict`, and nothing is written. A stale edit may not silently
        // overwrite a human's (or a tool's) concurrent change with "success".
        let actualSha256: string;
        try {
          actualSha256 = sha256Hex((await readFile(resolved)).toString("utf8"));
        } catch {
          actualSha256 = "unreadable";
        }
        if (actualSha256 !== preimageSha256) {
          return fail(
            `HZ_PRECONDITION_FAILED: edit refused: preimage changed: ${rel} ` +
              `(expected sha256 ${preimageSha256}; actual sha256 ${actualSha256}; changedBy unknown)`,
          );
        }

        // The effect: an atomic replacement (temp file + fsync + rename, ./atomic-write.ts)
        // through a descriptor re-verified against the kernel state directory before a
        // byte is written (same check, and same symlink policy, as `write` — see the
        // header of ./verified-open.ts). Not `truncate(0)` + `write`: a crash between
        // those two calls left the file at ZERO BYTES with nothing able to restore it.
        const outcome = await writeAtomic(resolved, after, ctx);
        if (isRefused(outcome)) return fail(outcome.refusal);
        const verified = (await readFile(resolved)).toString("utf8") === after;
        if (!verified) return fail(`verification failed: ${rel} does not match the intended content`);

        recordChange(ctx.sessionId, {
          path: resolved,
          rel,
          before,
          afterSha256: sha256Hex(after),
          at: Date.now(),
          tool: "edit",
        });

        return undefined;
      }).catch((e: unknown) => fail(msg(e)));
      if (locked !== undefined) return locked;

      // The session has now read this file (twice: the preimage and the
      // post-write check), so later fuzzy rungs on it are legitimate.
      noteRead(ctx, resolved);

      reflections.delete(reflectionKey(ctx, resolved));
      const suffix = rung === "exact" ? "" : ` (matched via ${rung})`;
      return { ok: true, output: `${checkpointNote}Replaced ${replacements} occurrence(s) in ${rel}${suffix}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
