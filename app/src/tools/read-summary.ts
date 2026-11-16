/**
 * read-summary.ts — zero-dependency per-language structural summaries (B-7).
 *
 * A `read` may be lossy: read.ts caps lines and bytes, and the loop caps tool
 * output again before the model sees it (spilling the full text to an artifact).
 * When that happens the model can lose the file's SHAPE — its imports, its
 * top-level declarations, its headings — even though those are the cheapest,
 * most useful bytes in the file. This module computes a small structural
 * summary from the FULL text BEFORE any truncation, so read.ts can show it
 * beside the truncation/spill marker.
 *
 * Contract:
 *  - Zero runtime dependencies (only a local helper from core). No parser, no
 *    LSP, no eval. File content is NEVER executed: candidates are found with
 *    line/regex scans and a brace counter for JSON.
 *  - Conservative and capped: at most `maxLines` entries, at most `maxBytes`
 *    rendered bytes, and each line clipped to `lineChars`. Caps are enforced
 *    while building, so a pathological file cannot inflate the summary.
 *  - Sanitized: every emitted line passes through the G-6 invisible/bidi
 *    sanitizer, so a zero-width character cannot hide a declaration.
 *  - Only for recognized structured languages (ts/js/py/md/json and their
 *    close extensions). Unknown types return `undefined` and change nothing.
 *  - Pure: no writes, no state, no workspace access (ADR-010).
 */

import { sanitizeForDistill } from "../core/distill-sanitize";

export type SummaryLanguage = "ts" | "js" | "py" | "md" | "json";

export const DEFAULT_SUMMARY_MAX_LINES = 40;
export const DEFAULT_SUMMARY_LINE_CHARS = 160;
export const DEFAULT_SUMMARY_MAX_BYTES = 4096;

export interface SummaryOptions {
  maxLines?: number;
  lineChars?: number;
  maxBytes?: number;
}

export interface SummaryCandidate {
  /** 1-based source line. */
  line: number;
  text: string;
}

export interface StructuralSummary {
  language: SummaryLanguage;
  /** Rendered, capped summary lines (`  L<n>: <text>`). */
  lines: string[];
  /** Candidates found before capping. */
  total: number;
  /** Candidates not shown because of the line/byte caps. */
  omitted: number;
}

const EXT_LANGUAGE: Readonly<Record<string, SummaryLanguage>> = Object.freeze({
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
  md: "md",
  markdown: "md",
  json: "json",
  jsonc: "json",
});

/** Recognized language for a path, or `undefined` (no summary; output unchanged). */
export function summaryLanguageForPath(filePath: unknown): SummaryLanguage | undefined {
  if (typeof filePath !== "string" || filePath === "") return undefined;
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_LANGUAGE[base.slice(dot + 1)];
}

/* ----------------------------- candidate scans ----------------------------- */

/** Top-level TS/JS imports and declarations. Indented lines are body, not head. */
const TS_JS_HEAD =
  /^(?:export\s+(?:default\s+|declare\s+|abstract\s+|async\s+)*)?(?:import\b|function\b|class\b|interface\b|type\b|enum\b|namespace\b|const\b|let\b|var\b|async\s+function\b)/;

/** Top-level Python imports, definitions and decorators. */
const PY_HEAD = /^(?:import\b|from\s+\S+\s+import\b|def\b|async\s+def\b|class\b|@)/;

/** Markdown headings (ATX form). */
const MD_HEAD = /^#{1,6}\s+\S/;

function lineCandidates(lines: readonly string[], language: SummaryLanguage): SummaryCandidate[] {
  const out: SummaryCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let match = false;
    if (language === "ts" || language === "js") match = TS_JS_HEAD.test(line);
    else if (language === "py") match = PY_HEAD.test(line);
    else if (language === "md") match = MD_HEAD.test(line);
    if (match) out.push({ line: index + 1, text: line.trim() });
  }
  // A heading-less Markdown file still has a cheap title: its first non-empty line.
  if (language === "md" && out.length === 0) {
    for (let index = 0; index < lines.length; index += 1) {
      const raw = (lines[index] as string).trim();
      if (raw !== "") {
        out.push({ line: index + 1, text: raw });
        break;
      }
    }
  }
  return out;
}

/** Track bracket depth across one line, ignoring quoted strings. */
function advanceDepth(line: string, startDepth: number): number {
  let depth = startDepth;
  let inString = false;
  let escaped = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * Top-level JSON keys. Keys of the root object live at bracket depth 1; the
 * scan never parses a value and never evaluates anything. A `"` followed by a
 * colon at depth 1 is treated as a key.
 */
function jsonCandidates(lines: readonly string[]): SummaryCandidate[] {
  const out: SummaryCandidate[] = [];
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (depth === 1 && /^\s*"(?:[^"\\]|\\.)*"\s*:/.test(line)) {
      out.push({ line: index + 1, text: line.trim() });
    }
    depth = advanceDepth(line, depth);
  }
  return out;
}

/* --------------------------------- capping --------------------------------- */

function cap(candidates: readonly SummaryCandidate[], language: SummaryLanguage, opts: SummaryOptions): StructuralSummary {
  const maxLines = Number.isFinite(opts.maxLines) ? Math.max(1, Math.floor(opts.maxLines as number)) : DEFAULT_SUMMARY_MAX_LINES;
  const lineChars = Number.isFinite(opts.lineChars) ? Math.max(1, Math.floor(opts.lineChars as number)) : DEFAULT_SUMMARY_LINE_CHARS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, Math.floor(opts.maxBytes as number)) : DEFAULT_SUMMARY_MAX_BYTES;
  const lines: string[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (lines.length >= maxLines) break;
    // Sanitize BEFORE clipping; a bidi control must not survive into a headline.
    const clean = sanitizeForDistill(candidate.text).replace(/\s+/g, " ").trim().slice(0, lineChars);
    if (clean === "") continue;
    const rendered = `  L${candidate.line}: ${clean}`;
    const size = Buffer.byteLength(rendered, "utf8") + 1;
    if (bytes + size > maxBytes) break;
    lines.push(rendered);
    bytes += size;
  }
  return { language, lines, total: candidates.length, omitted: candidates.length - lines.length };
}

/**
 * Compute the structural summary of `text` for `filePath`. Returns `undefined`
 * for unknown/blank files so read.ts can leave their output byte-identical.
 */
export function structuralSummary(text: string, filePath: string, opts: SummaryOptions = {}): StructuralSummary | undefined {
  const language = summaryLanguageForPath(filePath);
  if (language === undefined || typeof text !== "string" || text === "") return undefined;
  const lines = text.split("\n");
  const candidates = language === "json" ? jsonCandidates(lines) : lineCandidates(lines, language);
  return cap(candidates, language, opts);
}

/** Render a summary as a compact, bounded section for a read result. */
export function renderStructuralSummary(summary: StructuralSummary): string {
  const count = summary.omitted > 0 ? `${summary.lines.length} of ${summary.lines.length + summary.omitted}` : `${summary.lines.length}`;
  const header = `[structural summary: ${summary.language}; ${count} head(s) shown]`;
  return [header, ...summary.lines].join("\n");
}
