/**
 * Reduced kernel `fs.edit` repair (ruling **287**).
 *
 * Bun `edit.ts` runs NF-069/A-1…A-5 (relative indent, unicode fold, 3-way, line-patch).
 * Kernel + LocalKernel opt-in (`HZ_EFFECT_HOST_EDIT_REPAIR=1`) allow extra rungs: trim
 * `oldString`, per-line `trimEnd` line windows (**335**), per-line `trim` line windows
 * (**337**), per-line unicode-fold line windows (**339**), then newline-normalised unique
 * match — still fail-closed when ambiguous or absent.
 */

import { canonicalize } from "../tools/apply-patch-parser";

export function effectHostEditRepairEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_EFFECT_HOST_EDIT_REPAIR?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let from = 0;
  let count = 0;
  while (from <= haystack.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}

export type KernelFsEditResolve =
  | { ok: true; oldString: string; start: number; end: number; indentPrefix?: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

function uniqueSpan(haystack: string, needle: string): { start: number; end: number } | undefined {
  const n = countOccurrences(haystack, needle);
  if (n !== 1) return undefined;
  const start = haystack.indexOf(needle);
  return { start, end: start + needle.length };
}

/**
 * Map a span in newline-normalised text back to byte indices in the original string.
 */
function spanInOriginalFromNormalized(
  original: string,
  normStart: number,
  normLen: number,
): { start: number; end: number } | undefined {
  let normIdx = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (let i = 0; i <= original.length; ) {
    if (normIdx === normStart && start === undefined) start = i;
    if (normIdx === normStart + normLen) {
      end = i;
      break;
    }
    if (i < original.length && original.startsWith("\r\n", i)) {
      normIdx += 1;
      i += 2;
      continue;
    }
    if (i < original.length) {
      normIdx += 1;
      i += 1;
      continue;
    }
    if (normIdx === normStart + normLen) end = i;
    break;
  }
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function trimEndLine(s: string): string {
  return s.replace(/[ \t\r\f\v]+$/, "");
}

function trimLine(s: string): string {
  return s.trim();
}

function toFileLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (
    (text.endsWith("\n") || text.endsWith("\r\n")) &&
    lines.length > 0 &&
    lines[lines.length - 1] === ""
  ) {
    lines.pop();
  }
  return lines;
}

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function commonIndentPrefix(lines: string[]): string {
  let prefix: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (prefix === undefined) {
      prefix = indent;
    } else {
      let i = 0;
      while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i += 1;
      prefix = prefix.slice(0, i);
    }
  }
  return prefix ?? "";
}

function stripRelativeIndent(line: string, prefix: string): string {
  return line.trim() === "" ? "" : line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/** Return the unique block having the same relative indentation, not just per-line trimmed text. */
function resolveRelativeIndentWindowUnique(original: string, oldString: string): KernelFsEditResolve | undefined {
  const fileLines = toFileLines(original);
  const want = toFileLines(oldString);
  if (want.length === 0 || want.length > fileLines.length) return undefined;
  const wantPrefix = commonIndentPrefix(want);
  let found: number | undefined;
  for (let start = 0; start + want.length <= fileLines.length; start += 1) {
    const window = fileLines.slice(start, start + want.length);
    const windowPrefix = commonIndentPrefix(window);
    if (window.every((line, i) => stripRelativeIndent(line, windowPrefix) === stripRelativeIndent(want[i]!, wantPrefix))) {
      if (found !== undefined) return { ok: false, reason: "ambiguous" };
      found = start;
    }
  }
  if (found === undefined) return undefined;
  const span = spanForLineWindow(original, found, want.length);
  if (!span) return undefined;
  return { ok: true, ...span, indentPrefix: commonIndentPrefix(fileLines.slice(found, found + want.length)) };
}

/** Matched block decides the new text's indentation and native CRLF style. */
export function renderKernelFsEditReplacement(
  newString: string,
  resolved: Extract<KernelFsEditResolve, { ok: true }>,
  content: string,
): string {
  const prefix = resolved.indentPrefix;
  if (prefix === undefined) return newString;
  const lines = newString.replace(/\r\n/g, "\n").split("\n");
  const ownPrefix = commonIndentPrefix(lines);
  const reindented = lines.map((line) => line.trim() === "" ? "" : prefix + stripRelativeIndent(line, ownPrefix)).join("\n");
  return content.slice(resolved.start, resolved.end).includes("\r\n")
    ? reindented.replace(/\n/g, "\r\n")
    : reindented;
}

/** Unique per-line trimEnd window start line index, or undefined when none / ambiguous. */
function findUniqueTrimEndLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
  const n = wantLines.length;
  if (n === 0 || n > fileLines.length) return undefined;
  let found: number | undefined;
  for (let s = 0; s + n <= fileLines.length; s += 1) {
    const window = fileLines.slice(s, s + n);
    if (equalLines(window.map(trimEndLine), wantLines.map(trimEndLine))) {
      if (found !== undefined) return undefined;
      found = s;
    }
  }
  return found;
}

function foldUnicodeLine(line: string): string {
  return canonicalize(line);
}

/** Unique per-line unicode-fold line-window start line index, or undefined when none / ambiguous. */
function findUniqueUnicodeFoldLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
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

/** Unique per-line trim line-window start line index, or undefined when none / ambiguous. */
function findUniqueTrimLineWindow(fileLines: string[], wantLines: string[]): number | undefined {
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

function lineBoundaries(original: string): number[] {
  const starts: number[] = [0];
  let i = 0;
  while (i < original.length) {
    if (original.startsWith("\r\n", i)) {
      i += 2;
      starts.push(i);
      continue;
    }
    if (original[i] === "\n") {
      i += 1;
      starts.push(i);
      continue;
    }
    i += 1;
  }
  return starts;
}

function spanForLineWindow(
  original: string,
  startLine: number,
  lineCount: number,
): { start: number; end: number; oldString: string } | undefined {
  const starts = lineBoundaries(original);
  const fileLines = toFileLines(original);
  if (lineCount === 0 || startLine + lineCount > fileLines.length) return undefined;
  const start = starts[startLine];
  if (start === undefined) return undefined;
  let end = startLine + lineCount < starts.length ? starts[startLine + lineCount]! : original.length;
  if (end > start) {
    if (end >= 2 && original.startsWith("\r\n", end - 2)) end -= 2;
    else if (original[end - 1] === "\n") end -= 1;
  }
  const oldString = original.slice(start, end);
  return { start, end, oldString };
}

function resolveTrimEndLineWindowUnique(
  original: string,
  oldString: string,
): KernelFsEditResolve | undefined {
  const want = toFileLines(oldString);
  if (want.length === 0) return undefined;
  const fileLines = toFileLines(original);
  const startLine = findUniqueTrimEndLineWindow(fileLines, want);
  if (startLine === undefined) return undefined;
  const span = spanForLineWindow(original, startLine, want.length);
  if (!span) return undefined;
  return { ok: true, oldString: span.oldString, start: span.start, end: span.end };
}

function resolveTrimLineWindowUnique(
  original: string,
  oldString: string,
): KernelFsEditResolve | undefined {
  const want = toFileLines(oldString);
  if (want.length === 0) return undefined;
  const fileLines = toFileLines(original);
  const startLine = findUniqueTrimLineWindow(fileLines, want);
  if (startLine === undefined) return undefined;
  const span = spanForLineWindow(original, startLine, want.length);
  if (!span) return undefined;
  return {
    ok: true, oldString: span.oldString, start: span.start, end: span.end,
    indentPrefix: commonIndentPrefix(fileLines.slice(startLine, startLine + want.length)),
  };
}

function resolveUnicodeFoldLineWindowUnique(
  original: string,
  oldString: string,
): KernelFsEditResolve | undefined {
  const want = toFileLines(oldString);
  if (want.length === 0) return undefined;
  const fileLines = toFileLines(original);
  const startLine = findUniqueUnicodeFoldLineWindow(fileLines, want);
  if (startLine === undefined) return undefined;
  const span = spanForLineWindow(original, startLine, want.length);
  if (!span) return undefined;
  return { ok: true, oldString: span.oldString, start: span.start, end: span.end };
}

/** Last-resort, unique two-anchor line patch; this repair is opt-in and refuses ties. */
function resolveLinePatchWindowUnique(original: string, oldString: string): KernelFsEditResolve | undefined {
  const fileLines = toFileLines(original);
  const want = toFileLines(oldString);
  const anchors = want.map((line, i) => line.trim() === "" ? -1 : i).filter((i) => i >= 0);
  if (anchors.length < 2 || want.length > fileLines.length) return undefined;
  const firstAt = anchors[0]!;
  const lastAt = anchors[anchors.length - 1]!;
  const first = want[firstAt]!.trim();
  const last = want[lastAt]!.trim();
  let found: number | undefined;
  for (let start = 0; start + want.length <= fileLines.length; start += 1) {
    if (fileLines[start + firstAt]!.trim() !== first || fileLines[start + lastAt]!.trim() !== last) continue;
    if (found !== undefined) return { ok: false, reason: "ambiguous" };
    found = start;
  }
  if (found === undefined) return undefined;
  const span = spanForLineWindow(original, found, want.length);
  if (!span) return undefined;
  return {
    ok: true, oldString: span.oldString, start: span.start, end: span.end,
    indentPrefix: commonIndentPrefix(fileLines.slice(found, found + want.length)),
  };
}

function resolveNormalizedUnique(original: string, oldString: string): KernelFsEditResolve | undefined {
  const normContent = original.replace(/\r\n/g, "\n");
  const normOld = oldString.replace(/\r\n/g, "\n");
  if (normOld === "") return undefined;
  const span = uniqueSpan(normContent, normOld);
  if (!span) {
    const n = countOccurrences(normContent, normOld);
    if (n > 1) return { ok: false, reason: "ambiguous" };
    return undefined;
  }
  const mapped = spanInOriginalFromNormalized(original, span.start, normOld.length);
  if (!mapped) return undefined;
  return { ok: true, oldString: original.slice(mapped.start, mapped.end), start: mapped.start, end: mapped.end };
}

export function resolveKernelFsEditOldString(
  content: string,
  oldString: string,
  env: Record<string, string | undefined> = process.env,
): KernelFsEditResolve {
  const exact = uniqueSpan(content, oldString);
  if (exact) {
    return { ok: true, oldString, start: exact.start, end: exact.end };
  }
  const exactCount = countOccurrences(content, oldString);
  if (exactCount > 1) return { ok: false, reason: "ambiguous" };

  if (!effectHostEditRepairEnabled(env)) {
    return { ok: false, reason: "not_found" };
  }

  const trimmed = oldString.trim();
  if (trimmed !== oldString && trimmed !== "") {
    const trimSpan = uniqueSpan(content, trimmed);
    if (trimSpan) {
      return { ok: true, oldString: trimmed, start: trimSpan.start, end: trimSpan.end };
    }
    if (countOccurrences(content, trimmed) > 1) return { ok: false, reason: "ambiguous" };
  }

  const indentWindow = resolveRelativeIndentWindowUnique(content, oldString);
  if (indentWindow) return indentWindow;

  const trimEndWindow = resolveTrimEndLineWindowUnique(content, oldString);
  if (trimEndWindow) return trimEndWindow;
  const wantLines = toFileLines(oldString);
  if (wantLines.length > 0) {
    const hits = (() => {
      const fileLines = toFileLines(content);
      let n = 0;
      const len = wantLines.length;
      if (len === 0 || len > fileLines.length) return 0;
      for (let s = 0; s + len <= fileLines.length; s += 1) {
        const window = fileLines.slice(s, s + len);
        if (equalLines(window.map(trimEndLine), wantLines.map(trimEndLine))) n += 1;
      }
      return n;
    })();
    if (hits > 1) return { ok: false, reason: "ambiguous" };
  }

  const trimWindow = resolveTrimLineWindowUnique(content, oldString);
  if (trimWindow) return trimWindow;
  const wantTrim = toFileLines(oldString);
  if (wantTrim.length > 0) {
    const fileLines = toFileLines(content);
    const n = wantTrim.length;
    let trimHits = 0;
    if (n > 0 && n <= fileLines.length) {
      for (let s = 0; s + n <= fileLines.length; s += 1) {
        const window = fileLines.slice(s, s + n);
        if (equalLines(window.map(trimLine), wantTrim.map(trimLine))) trimHits += 1;
      }
    }
    if (trimHits > 1) return { ok: false, reason: "ambiguous" };
  }

  const foldWindow = resolveUnicodeFoldLineWindowUnique(content, oldString);
  if (foldWindow) return foldWindow;
  const wantFold = toFileLines(oldString);
  if (wantFold.length > 0) {
    const fileLines = toFileLines(content);
    const n = wantFold.length;
    let foldHits = 0;
    if (n > 0 && n <= fileLines.length) {
      for (let s = 0; s + n <= fileLines.length; s += 1) {
        const window = fileLines.slice(s, s + n);
        if (equalLines(window.map(foldUnicodeLine), wantFold.map(foldUnicodeLine))) foldHits += 1;
      }
    }
    if (foldHits > 1) return { ok: false, reason: "ambiguous" };
  }

  const norm = resolveNormalizedUnique(content, oldString);
  if (norm) return norm;
  const normOld = oldString.replace(/\r\n/g, "\n");
  if (countOccurrences(content.replace(/\r\n/g, "\n"), normOld) > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  const anchored = resolveLinePatchWindowUnique(content, oldString);
  if (anchored) return anchored;
  return { ok: false, reason: "not_found" };
}
