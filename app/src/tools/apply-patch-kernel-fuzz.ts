/**
 * Reduced apply_patch fuzz for kernel route (ruling **299**).
 *
 * Bun `apply-patch.ts` runs the full graded ladder; kernel projection reuses at most
 * rung (2) per-line `trimEnd`, rung (3) per-line `trim`, rung (4) relative-indent
 * normalisation (unique match, re-indent replacement like `edit.ts` rung 2), rung (5)
 * per-line unicode fold (`canonicalize`, NFC + codex quote/dash/space fold — same as
 * `apply-patch-parser`) and rung (6) unique line-patch anchors (first/last non-blank,
 * `edit.ts` rung 5) and rung (7) unique dominant block score (≥0.97, Δ0.08 vs
 * second-best) and rung (8) unique max-score Levenshtein block match (same 0.66
 * threshold as Bun `apply-patch.ts`) when `HZ_EFFECT_HOST_EDIT_REPAIR=1` (same
 * opt-in as kernel `fs.edit` repair). Bun first-hit score fuzz stays Bun-only.
 */

import { canonicalize, type PatchChunk } from "./apply-patch-parser";
import {
  APPLY_PATCH_LEVENSHTEIN_THRESHOLD,
  applyPatchBlockSimilarity,
} from "./apply-patch";
import { effectHostEditRepairEnabled } from "../core/effect-host-edit-repair";
import { DOMINANT_FUZZY_DELTA, DOMINANT_FUZZY_MIN_CONFIDENCE } from "./edit";

export function kernelApplyPatchTrimEndRungEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return effectHostEditRepairEnabled(env);
}

function trimEnd(s: string): string {
  return s.replace(/[ \t\r\f\v]+$/, "");
}

function trimLine(s: string): string {
  return s.trim();
}

function toLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").split("\n");
}

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function countLineWindows(
  fileLines: string[],
  want: string[],
  map: (lines: string[]) => string[],
): number {
  const n = want.length;
  if (n === 0 || n > fileLines.length) return 0;
  let hits = 0;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(map(window), map(want))) hits += 1;
  }
  return hits;
}

/** Unique trimEnd line-window start index, or undefined when none / ambiguous. */
/** Unique exact line-window start in file (fail-closed when ambiguous). */
export function findUniqueExactLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0) return fileLines.length;
  if (n > fileLines.length) return undefined;
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(window, wantLines)) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

export function findUniqueTrimEndLineWindow(
  fileLines: string[],
  wantLines: string[],
): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(window.map(trimEnd), wantLines.map(trimEnd))) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

/** Unique per-line trim line-window start index, or undefined when none / ambiguous. */
export function findUniqueTrimLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(window.map(trimLine), wantLines.map(trimLine))) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

function foldUnicodeLine(line: string): string {
  return canonicalize(line);
}

const LEADING_WS = /^[ \t]*/;

function leadingWhitespace(line: string): string {
  return LEADING_WS.exec(line)?.[0] ?? "";
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

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

function stripIndent(lines: string[], prefix: string): string[] {
  return lines.map((line) => (isBlank(line) ? "" : line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

function relativeIndentNorm(lines: string[]): string[] {
  return stripIndent(lines, commonIndentPrefix(lines));
}

function reindent(lines: string[], prefix: string): string[] {
  if (prefix === "") return lines;
  const own = commonIndentPrefix(lines);
  return lines.map((line) =>
    isBlank(line) ? "" : prefix + (own === "" ? line : line.startsWith(own) ? line.slice(own.length) : line),
  );
}

/** Unique relative-indent line-window start index, or undefined when none / ambiguous. */
export function findUniqueRelativeIndentLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  const wantNorm = relativeIndentNorm(wantLines);
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(relativeIndentNorm(window), wantNorm)) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

/** Unique per-line unicode-fold line-window start index, or undefined when none / ambiguous. */
export function findUniqueUnicodeFoldLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(window.map(foldUnicodeLine), wantLines.map(foldUnicodeLine))) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

/**
 * Unique max-similarity line window at or above Bun's Levenshtein threshold.
 * Ambiguous ties at the top score fail-closed (unlike Bun first-hit wins).
 */
/**
 * Unique dominant block score: top similarity ≥ `DOMINANT_FUZZY_MIN_CONFIDENCE` and
 * clearly beats second-best by `DOMINANT_FUZZY_DELTA` (fail-closed on ties at the top).
 */
export function findUniqueDominantScoreLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  const wantBlock = wantLines.join("\n");
  let bestSim = -1;
  let secondSim = -1;
  const atBest: number[] = [];
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    const sim = applyPatchBlockSimilarity(window.join("\n"), wantBlock);
    if (sim > bestSim) {
      secondSim = bestSim;
      bestSim = sim;
      atBest.length = 0;
      atBest.push(s);
    } else if (sim === bestSim) {
      atBest.push(s);
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }
  if (atBest.length !== 1) return undefined;
  if (bestSim < DOMINANT_FUZZY_MIN_CONFIDENCE) return undefined;
  if (bestSim - secondSim < DOMINANT_FUZZY_DELTA) return undefined;
  return atBest[0];
}

export function findUniqueLevenshteinLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  const wantBlock = wantLines.join("\n");
  let bestSim = -1;
  const atBest: number[] = [];
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    const sim = applyPatchBlockSimilarity(window.join("\n"), wantBlock);
    if (sim < APPLY_PATCH_LEVENSHTEIN_THRESHOLD) continue;
    if (sim > bestSim) {
      bestSim = sim;
      atBest.length = 0;
      atBest.push(s);
    } else if (sim === bestSim) {
      atBest.push(s);
    }
  }
  if (atBest.length !== 1) return undefined;
  return atBest[0];
}

/**
 * Bun `apply-patch.ts` rung (4): the first window (file order) whose block similarity
 * meets the Levenshtein threshold — position beats score (intentionally not kernel-routed).
 */
export function bunApplyPatchFirstHitLevenshteinStart(
  fileLines: string[],
  wantLines: string[],
): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  const wantBlock = wantLines.join("\n");
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    const sim = applyPatchBlockSimilarity(window.join("\n"), wantBlock);
    if (sim >= APPLY_PATCH_LEVENSHTEIN_THRESHOLD) return s;
  }
  return undefined;
}

export type ApplyPatchScoreMatchPolicy = "bun_first_hit" | "kernel_unique_dominant";

/**
 * Classifies similarity-score discipline for apply_patch (docs/tests honesty).
 * Kernel: unique dominant score (≥0.97, Δ0.08) or unique max-score Levenshtein; Bun: first qualifying start.
 */
export function classifyApplyPatchScoreMatchPolicy(
  fileLines: string[],
  wantLines: string[],
): ApplyPatchScoreMatchPolicy | "no_score_match" {
  if (findUniqueDominantScoreLineWindow(fileLines, wantLines) !== undefined) {
    return "kernel_unique_dominant";
  }
  if (findUniqueLevenshteinLineWindow(fileLines, wantLines) !== undefined) {
    return "kernel_unique_dominant";
  }
  if (bunApplyPatchFirstHitLevenshteinStart(fileLines, wantLines) !== undefined) {
    return "bun_first_hit";
  }
  return "no_score_match";
}

/** True when kernel route refuses but Bun position-ordered score fuzz would still match. */
export function applyPatchFirstHitScoreFuzzBunOwned(fileContent: string, chunk: PatchChunk): boolean {
  if (chunk.oldLines.length === 0) return false;
  const fileLines = toLines(fileContent);
  const klass = classifyApplyPatchChunkKernelFuzz(fileContent, chunk);
  if (klass !== "bun_fuzz_only") return false;
  return classifyApplyPatchScoreMatchPolicy(fileLines, chunk.oldLines) === "bun_first_hit";
}

/** Non-blank line indices in `lines` (for line-patch anchors). */
function nonBlankAnchors(lines: string[]): number[] {
  const anchors: number[] = [];
  lines.forEach((line, i) => {
    if (!isBlank(line)) anchors.push(i);
  });
  return anchors;
}

/** Unique line-patch window start index (first/last non-blank anchors), or undefined when none / ambiguous. */
export function findUniqueLinePatchLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  const anchors = nonBlankAnchors(wantLines);
  if (anchors.length < 2) return undefined;
  const firstAt = anchors[0] as number;
  const lastAt = anchors[anchors.length - 1] as number;
  const first = (wantLines[firstAt] as string).trim();
  const last = (wantLines[lastAt] as string).trim();
  let found: number | undefined;
  for (let start = 0; start + n <= fileLines.length; start += 1) {
    const head = (fileLines[start + firstAt] as string).trim();
    const tail = (fileLines[start + lastAt] as string).trim();
    if (head === first && tail === last) {
      if (found !== undefined) return undefined;
      found = start;
    }
  }
  return found;
}

function countLinePatchWindows(fileLines: string[], wantLines: string[]): number {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return 0;
  const anchors = nonBlankAnchors(wantLines);
  if (anchors.length < 2) return 0;
  const firstAt = anchors[0] as number;
  const lastAt = anchors[anchors.length - 1] as number;
  const first = (wantLines[firstAt] as string).trim();
  const last = (wantLines[lastAt] as string).trim();
  let hits = 0;
  for (let start = 0; start + n <= fileLines.length; start += 1) {
    const head = (fileLines[start + firstAt] as string).trim();
    const tail = (fileLines[start + lastAt] as string).trim();
    if (head === first && tail === last) hits += 1;
  }
  return hits;
}

export type ApplyPatchKernelFuzzClass =
  | "exact"
  | "trim_end"
  | "trim_both"
  | "relative_indent"
  | "unicode_fold"
  | "line_patch"
  | "dominant_score"
  | "levenshtein"
  | "bun_fuzz_only";

/** Classify how a single update chunk relates to on-disk bytes (no writes). */
export function classifyApplyPatchChunkKernelFuzz(
  fileContent: string,
  chunk: PatchChunk,
): ApplyPatchKernelFuzzClass {
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) return "exact";
  const fileLines = toLines(fileContent);
  const want = chunk.oldLines;
  const exactUnique = findUniqueExactLineWindow(fileLines, want);
  if (exactUnique !== undefined) return "exact";
  if (chunk.eofAnchored) return "bun_fuzz_only";
  const exactHits = countLineWindows(fileLines, want, (x) => x);
  if (exactHits === 1) return "exact";
  if (exactHits > 1) return "bun_fuzz_only";
  const trimHits = countLineWindows(fileLines, want, (x) => x.map(trimEnd));
  if (trimHits === 1) return "trim_end";
  const trimBothHits = countLineWindows(fileLines, want, (x) => x.map(trimLine));
  if (trimBothHits === 1) return "trim_both";
  const indentHits = countLineWindows(fileLines, want, relativeIndentNorm);
  if (indentHits === 1) return "relative_indent";
  const foldHits = countLineWindows(fileLines, want, (x) => x.map(foldUnicodeLine));
  if (foldHits === 1) return "unicode_fold";
  const linePatchHits = countLinePatchWindows(fileLines, want);
  if (linePatchHits === 1) return "line_patch";
  if (trimBothHits > 1 || indentHits > 1 || foldHits > 1 || linePatchHits > 1) return "bun_fuzz_only";
  if (findUniqueDominantScoreLineWindow(fileLines, want) !== undefined) return "dominant_score";
  if (findUniqueLevenshteinLineWindow(fileLines, want) !== undefined) return "levenshtein";
  return "bun_fuzz_only";
}

function dominantEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Resolve kernel `fs.edit` old/new for one chunk; undefined when Bun-only fuzz is required
 * or repair is off for the trim_end case.
 */
export function resolveKernelApplyPatchChunkEdit(
  fileContent: string,
  chunk: PatchChunk,
  env: Record<string, string | undefined> = process.env,
): { old: string; new: string } | undefined {
  const eol = dominantEol(fileContent);
  const fileLines = toLines(fileContent);
  const want = chunk.oldLines;
  const klass = classifyApplyPatchChunkKernelFuzz(fileContent, chunk);
  if (klass === "bun_fuzz_only") return undefined;

  const n = want.length;
  if (n === 0) {
    return { old: "", new: chunk.newLines.join(eol) };
  }

  let start: number | undefined;
  if (klass === "exact") {
    start = findUniqueExactLineWindow(fileLines, want);
  } else if (!kernelApplyPatchTrimEndRungEnabled(env)) {
    return undefined;
  } else if (klass === "trim_end") {
    start = findUniqueTrimEndLineWindow(fileLines, want);
  } else if (klass === "trim_both") {
    start = findUniqueTrimLineWindow(fileLines, want);
  } else if (klass === "relative_indent") {
    start = findUniqueRelativeIndentLineWindow(fileLines, want);
  } else if (klass === "unicode_fold") {
    start = findUniqueUnicodeFoldLineWindow(fileLines, want);
  } else if (klass === "line_patch") {
    start = findUniqueLinePatchLineWindow(fileLines, want);
  } else if (klass === "dominant_score") {
    start = findUniqueDominantScoreLineWindow(fileLines, want);
  } else if (klass === "levenshtein") {
    start = findUniqueLevenshteinLineWindow(fileLines, want);
  } else {
    return undefined;
  }
  if (start === undefined) return undefined;

  const oldFromFile = fileLines.slice(start, start + n).join(eol);
  const window = fileLines.slice(start, start + n);
  const newText =
    klass === "relative_indent"
      ? reindent(chunk.newLines, commonIndentPrefix(window)).join(eol)
      : chunk.newLines.join(eol);
  return { old: oldFromFile, new: newText };
}
