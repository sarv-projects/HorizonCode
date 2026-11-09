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
import { isRefused, writeAtomic } from "./atomic-write";
import { recordChange } from "./change-journal";
import { isBinary, relPath, resolvePath } from "./helpers";
import { detectLineEnding } from "./line-endings";
import { noteRead, wasRead } from "./read-ledger";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
function spliceWithEndings(model: FuzzyModel, start: number, end: number, replacement: string[]): string {
  // Detect over the matched region's break bytes (joined with a non-break filler
  // so detectLineEnding only sees the endings themselves).
  const regionEnding = detectLineEnding(model.endings.slice(start, end).join("x"));
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

/* ------------------------- NF-069 / A-1…A-5 ladder ------------------------- */

/** The escalation order, as reported in results and errors (byte-stable). */
export const EDIT_LADDER = ["exact", "indent-normalised", "3-way merge", "line-patch"] as const;
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

/** Rung 3: three-way merge — every line equal after trimming. */
function candidatesMerge(fileLines: string[], oldLines: string[]): number[] {
  const oldTrim = oldLines.map((l) => l.trim());
  return windowsMatching(fileLines, oldLines.length, (w) => w.map((l) => l.trim()), oldTrim);
}

/** Rung 4: line-level patch — first/last non-blank lines as anchors, unique pair. */
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

/** The full diff-shaped failure text; byte-stable from here (A-5). */
function locateFailed(
  rel: string,
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
  fuzzyDisabled: boolean,
  attempts: number,
): string {
  const lines = [`old string not found in ${rel}`, fuzzyDisabled ? FAILED_SEARCH_EXACT_ONLY : FAILED_SEARCH_FUZZY];
  const closest = closestBlock(fileLines, oldLines);
  lines.push(closest === null ? "no similar lines found" : closest.text);
  const present = replaceAlreadyPresent(fileLines, newLines);
  if (present !== null) lines.push(present);
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

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace a string in a file: exact match, then relative-indent, three-way-merge and line-patch repair rungs (each only when unambiguous). All occurrences or the first only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old: { type: "string", description: "String to replace (must not be empty)." },
      new: { type: "string", description: "Replacement string." },
      all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old", "new"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
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
          return fail(locateFailed(rel, fileLines, oldLines, newLines, fuzzyDisabled, attempts));
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

      // The session has now read this file (twice: the preimage and the
      // post-write check), so later fuzzy rungs on it are legitimate.
      noteRead(ctx, resolved);

      reflections.delete(reflectionKey(ctx, resolved));
      const suffix = rung === "exact" ? "" : ` (matched via ${rung})`;
      return { ok: true, output: `Replaced ${replacements} occurrence(s) in ${rel}${suffix}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
