/**
 * ast-match.ts — a self-contained, zero-dependency, bounded, deterministic
 * structural matcher.
 *
 * This is the PRIMARY backend for the Tier-3 `ast_search` / `ast_edit` tools:
 * HorizonCode keeps app/ at ZERO runtime dependencies (no tree-sitter, no
 * ast-grep binding), so a structural matcher here must earn its keep with
 * nothing but the standard library. An external `ast-grep` binary, when it
 * exists on the host, is a capability-detected ACCELERATOR invoked through the
 * guarded spawn path (see ast-search.ts); this module is what runs otherwise,
 * and what every test exercises directly.
 *
 * The pattern language is an ast-grep-style metavariable dialect over source
 * TEXT, matched at the TOKEN level rather than as a raw substring so the match
 * is structural:
 *
 *   - `$NAME`      captures exactly ONE source token (an identifier, number,
 *                  string literal or a single punctuation token).
 *   - `$$$NAME`    captures a (possibly EMPTY) run of consecutive source tokens
 *                  — the variadic capture, for argument lists and bodies. It is
 *                  matched SHORTEST-first over bracket-balanced `() [] {}` spans,
 *                  so `foo($$$A)` ends at that call's own `)`. A trailing
 *                  `$$$A` with nothing after it therefore binds the empty run.
 *   - any other pattern token (an identifier, number, string literal or a
 *                  punctuation token) matches the SAME token verbatim.
 *   - whitespace between pattern tokens is insignificant: `foo( $A )` and
 *                  `foo($A)` are the same pattern, and either matches
 *                  `foo(bar)` and `foo ( bar )` — but never `foobar`, because
 *                  `foo` `(` `bar` `)` is four tokens and `foobar` is one.
 *
 * Same-metavariable identity: a pattern that names `$A` more than once matches
 * only when every `$A` binds to byte-equal source text (the classic
 * `$A && $A()` rule). The same holds for a repeated `$$$A`.
 *
 * Bounds (this module never walks off into superlinear territory):
 *   - MAX_SOURCE_BYTES caps the source it will tokenize.
 *   - MAX_TOKENS caps the token count of source and pattern alike.
 *   - MAX_MATCHES caps how many matches are returned.
 *   - a variadic `$$$` is bounded by MAX_VARIADIC_SPAN tokens per binding.
 *
 * NO I/O, NO guard, NO spawn: pure logic. The tools layer the guard, the read
 * ledger, the atomic write and the spawn admission on top of this.
 */

/** Largest source this matcher will tokenize (bytes). Larger -> `skipped: "too-large"`, never "no match". */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
/** Largest token count accepted for source or pattern. */
export const MAX_TOKENS = 200_000;
/** Largest number of matches returned by matchPattern / rewriteMatches. */
export const MAX_MATCHES = 1000;
/** Largest token run a single `$$$NAME` variadic capture may absorb. */
export const MAX_VARIADIC_SPAN = 4096;

/** One lexical token of the source or the pattern. */
export interface Token {
  kind: "identifier" | "number" | "string" | "punct";
  /** The raw text of the token exactly as it appeared. */
  text: string;
  /** Byte offset of the first character of the token in the source. */
  byteStart: number;
  /** Byte offset one past the last character of the token in the source. */
  byteEnd: number;
  /** UTF-16 index of the first character of the token in the source string. */
  idxStart: number;
  /** UTF-16 index one past the last character of the token. */
  idxEnd: number;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column (in UTF-16 code units) of the first character. */
  column: number;
  /** 1-based line of the position one past the last character. */
  endLine: number;
  /** 1-based column one past the last character (correct for multi-line tokens). */
  endColumn: number;
}

/** One structural match returned by matchPattern. */
export interface Match {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  byteStart: number;
  byteEnd: number;
  /** The exact source slice the whole pattern covered. */
  text: string;
  /** Captured metavariables, name -> the source text they bound to. */
  metaVariables: Record<string, string>;
}

/** Why a source could not be scanned at all (never "no match"). */
export type SkipReason = "too-large" | "too-many-tokens" | "pattern-too-large";

/** Result of rewriteMatches: the transformed text, the match count and ranges. */
export interface RewriteResult {
  text: string;
  count: number;
  changes: Array<{ byteStart: number; byteEnd: number; before: string; after: string }>;
  /** True when MAX_MATCHES was hit and more matches exist: the rewrite is PARTIAL. */
  truncated: boolean;
  /** Set when the source/pattern was too large to scan (count is then 0 but NOT "no match"). */
  skipped: SkipReason | null;
  /** Count of string tokens that ran unterminated (ambiguous lexing for this language). */
  lexIssues: number;
}

/** Lexical family: which comment / quote conventions the tokenizer applies. */
export type LangFamily = "c" | "rust" | "hash";

export interface LexOptions {
  /** Language hint or file extension (`rs`, `py`, `.ts`, ...). Unknown -> "c" family. */
  lang?: string;
}

const RUST_LANGS = new Set(["rs", "rust"]);
const HASH_LANGS = new Set(["py", "python", "rb", "ruby", "sh", "bash", "zsh", "yml", "yaml", "toml"]);

/** Map a language hint (`rust`, `.py`, `ts`, ...) to a lexical family. */
export function langFamily(lang: string | undefined): LangFamily {
  if (!lang) return "c";
  const l = lang.toLowerCase().replace(/^\./, "");
  if (RUST_LANGS.has(l)) return "rust";
  if (HASH_LANGS.has(l)) return "hash";
  return "c";
}

/** Language hint from a file path's extension (no dot), or undefined. */
export function langFromPath(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : undefined;
}

export interface LexResult {
  tokens: Token[];
  /** String tokens that hit a newline/EOF before their closing quote. */
  unterminated: number;
  skipped: SkipReason | null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/** True for a UTF-16 unit that is source whitespace (space, tab, CR, LF, FF, VT). */
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * Tokenize `src` into identifier / number / string-literal / punctuation
 * tokens. Whitespace is discarded (its only role is to separate tokens); byte
 * offsets and 1-based line/column are tracked so matches report real ranges.
 *
 * Lexical conventions follow a small language FAMILY (see `langFamily`):
 *   - "c" (default): `//` and block comments; `'` `"` strings end at a newline
 *     (an unterminated one is counted in `unterminated`); backtick strings may
 *     span lines.
 *   - "rust": as "c", but a `'` is a char literal only when it is `'x'` or
 *     `'\..'`; otherwise it is a lifetime tick (punctuation), so `<'a>` does not
 *     swallow the code after it.
 *   - "hash" (Python, Ruby, shell, YAML, TOML): `#` line comments; no `//` or
 *     block comments (Python `//` is floor division); Python triple-quoted
 *     strings may span lines.
 *
 * It is NOT a full parser: it is the structural granularity ast-grep-style
 * matching needs without a grammar per language.
 */
export function lex(src: string, opts: LexOptions = {}): LexResult {
  const tokens: Token[] = [];
  const result: LexResult = { tokens, unterminated: 0, skipped: null };
  if (typeof src !== "string") return result;
  if (Buffer.byteLength(src, "utf8") > MAX_SOURCE_BYTES) {
    result.skipped = "too-large";
    return result;
  }
  const family = langFamily(opts.lang);

  const n = src.length;
  let i = 0;
  let line = 1;
  let column = 1;
  // Byte offset tracked alongside the UTF-16 index so ranges are byte-accurate.
  let byte = 0;

  const advance = (count: number): void => {
    for (let k = 0; k < count; k += 1) {
      const ch = src[i] as string;
      byte += Buffer.byteLength(ch, "utf8");
      if (ch === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  };

  while (i < n) {
    if (tokens.length > MAX_TOKENS) {
      result.skipped = "too-many-tokens";
      return result;
    }
    const ch = src[i] as string;

    if (isWhitespace(ch)) {
      advance(1);
      continue;
    }

    if (family === "hash") {
      if (ch === "#") {
        while (i < n && src[i] !== "\n") advance(1);
        continue;
      }
    } else {
      // Line comment: skip to the newline (treated as whitespace).
      if (ch === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") advance(1);
        continue;
      }
      // Block comment: skip to the closing */ (treated as whitespace).
      if (ch === "/" && src[i + 1] === "*") {
        advance(2);
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) advance(1);
        if (i < n) advance(2);
        continue;
      }
    }

    const startByte = byte;
    const startIdx = i;
    const startLine = line;
    const startColumn = column;
    const push = (kind: Token["kind"]): void => {
      tokens.push({
        kind,
        text: src.slice(startIdx, i),
        byteStart: startByte,
        byteEnd: byte,
        idxStart: startIdx,
        idxEnd: i,
        line: startLine,
        column: startColumn,
        endLine: line,
        endColumn: column,
      });
    };

    // Rust: a `'` that is not a char literal is a lifetime tick (punctuation).
    if (family === "rust" && ch === "'") {
      const next = src[i + 1];
      let charLen = 0; // UTF-16 units of the char literal body, 0 when not a char literal
      if (next === "\\") {
        charLen = -1; // escape: scan to the closing quote below
      } else if (next !== undefined) {
        const cp = src.codePointAt(i + 1) as number;
        const w = cp > 0xffff ? 2 : 1;
        if (src[i + 1 + w] === "'") charLen = w;
      }
      if (charLen === 0) {
        advance(1);
        push("punct");
        continue;
      }
    }

    // Python triple-quoted strings may span lines.
    if (family === "hash" && (ch === '"' || ch === "'") && src[i + 1] === ch && src[i + 2] === ch) {
      advance(3);
      while (i < n && !(src[i] === ch && src[i + 1] === ch && src[i + 2] === ch)) {
        if (src[i] === "\\" && i + 1 < n) advance(2);
        else advance(1);
      }
      if (i < n) advance(3);
      else result.unterminated += 1;
      push("string");
      continue;
    }

    // String / template literal with backslash escapes. `'` and `"` end at a
    // newline (unterminated); a backtick string may span lines.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      advance(1);
      let closed = false;
      while (i < n) {
        const c = src[i] as string;
        if (c === quote) {
          closed = true;
          break;
        }
        if (c === "\n" && quote !== "`") break;
        if (c === "\\" && i + 1 < n) advance(2);
        else advance(1);
      }
      if (closed) advance(1); // the closing quote
      else result.unterminated += 1;
      push("string");
      continue;
    }

    // Number: decimal / hex / binary / float / exponent. Kept simple: a run of
    // digits, letters (for 0x/0b/e), dots and underscores starting at a digit.
    if (DIGIT.test(ch)) {
      while (i < n && /[0-9A-Fa-fxXbBoO._]/.test(src[i] as string)) advance(1);
      push("number");
      continue;
    }

    // Identifier (letters, digits after the first, `_` and `$`).
    if (IDENT_START.test(ch)) {
      while (i < n && IDENT_PART.test(src[i] as string)) advance(1);
      push("identifier");
      continue;
    }

    // Everything else: one punctuation token (single character).
    advance(1);
    push("punct");
  }

  return result;
}

/** Tokenize `src` (see `lex`); a too-large source yields no tokens. */
export function tokenize(src: string, opts: LexOptions = {}): Token[] {
  return lex(src, opts).tokens;
}

/** A pattern token: a literal source token, or a metavariable hole. */
interface PatternSingle {
  meta: "single";
  name: string;
}
interface PatternVariadic {
  meta: "variadic";
  name: string;
}
interface PatternLiteral {
  meta: "literal";
  token: Token;
}
type PatternPart = PatternSingle | PatternVariadic | PatternLiteral;

/** `$NAME` / `$$$NAME`: a metavariable name is a C-like identifier run. */
const META_SINGLE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const META_VARIADIC = /^\$\$\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Parse the pattern into parts. A metavariable is written as a single pattern
 * token; because `$` is an identifier character in the lexer, `$A` tokenizes as
 * one identifier `$A` and `$$$A` as one identifier `$$$A`, so a metavariable is
 * recognised by its text here rather than by re-lexing.
 */
function parsePattern(pattern: string, opts: LexOptions): { parts: PatternPart[]; skipped: SkipReason | null } {
  const lexed = lex(pattern, opts);
  if (lexed.skipped !== null) return { parts: [], skipped: "pattern-too-large" };
  const toks = lexed.tokens;
  const parts: PatternPart[] = [];
  for (const tok of toks) {
    if (tok.kind === "identifier") {
      const variadic = META_VARIADIC.exec(tok.text);
      if (variadic) {
        parts.push({ meta: "variadic", name: variadic[1] as string });
        continue;
      }
      const single = META_SINGLE.exec(tok.text);
      if (single) {
        parts.push({ meta: "single", name: single[1] as string });
        continue;
      }
    }
    parts.push({ meta: "literal", token: tok });
  }
  return { parts, skipped: null };
}

/** The source text a span of tokens [from, to) covers, verbatim. */
function spanText(src: string, tokens: Token[], from: number, to: number): string {
  if (to <= from) return "";
  const first = tokens[from] as Token;
  const last = tokens[to - 1] as Token;
  return src.slice(first.idxStart, last.idxEnd);
}

const OPENERS = "([{";
const CLOSERS = ")]}";

/**
 * Try to match `parts` (pattern) against `tokens` (source) starting at source
 * index `start`. Returns the end index (exclusive) and the metavariable
 * bindings on success, or null on failure. `bindings` is seeded empty per
 * attempt so the same-metavariable-identity rule is enforced within one match.
 */
function matchAt(
  src: string,
  tokens: Token[],
  parts: PatternPart[],
  start: number,
): { end: number; bindings: Record<string, string> } | null {
  const bindings: Record<string, string> = {};

  // A small backtracking matcher over the two sequences. Variadic parts are the
  // only source of nondeterminism; they are matched SHORTEST-first and only over
  // bracket-BALANCED spans, so `foo($$$A)` ends at the call's own `)` and never
  // runs across sibling calls or out of an enclosing group.
  function go(pi: number, si: number): number | null {
    if (pi === parts.length) return si;
    const part = parts[pi] as PatternPart;

    if (part.meta === "single") {
      const single = part as PatternSingle;
      if (si >= tokens.length) return null;
      const captured = (tokens[si] as Token).text;
      const prior = bindings[single.name];
      if (prior !== undefined && prior !== captured) return null;
      const hadPrior = prior !== undefined;
      bindings[single.name] = captured;
      const res = go(pi + 1, si + 1);
      if (res !== null) return res;
      if (!hadPrior) delete bindings[single.name];
      return null;
    }

    if (part.meta === "variadic") {
      const vari = part as PatternVariadic;
      const prior = bindings[vari.name];
      const hadPrior = prior !== undefined;
      // Grow the span one token at a time (shortest viable terminator wins).
      // A span is a candidate only when its () [] {} nesting is balanced, and
      // growth stops at a closer that would leave the enclosing group.
      // Bounded by MAX_VARIADIC_SPAN and the remaining source.
      const maxSpan = Math.min(MAX_VARIADIC_SPAN, tokens.length - si);
      let depth = 0;
      for (let span = 0; span <= maxSpan; span += 1) {
        if (span > 0) {
          const t = tokens[si + span - 1] as Token;
          if (t.kind === "punct") {
            if (OPENERS.includes(t.text)) depth += 1;
            else if (CLOSERS.includes(t.text)) depth -= 1;
          }
          if (depth < 0) break;
        }
        if (depth !== 0) continue;
        const captured = spanText(src, tokens, si, si + span);
        if (hadPrior && prior !== captured) continue;
        bindings[vari.name] = captured;
        const res = go(pi + 1, si + span);
        if (res !== null) return res;
      }
      if (!hadPrior) delete bindings[vari.name];
      else bindings[vari.name] = prior;
      return null;
    }

    // Literal token: same kind and same text.
    const lit = part as PatternLiteral;
    if (si >= tokens.length) return null;
    const srcTok = tokens[si] as Token;
    if (srcTok.kind !== lit.token.kind || srcTok.text !== lit.token.text) return null;
    return go(pi + 1, si + 1);
  }

  const end = go(0, start);
  if (end === null) return null;
  return { end, bindings };
}

/** Outcome of a full scan: the matches plus honest signals about what was NOT done. */
export interface ScanResult {
  matches: Match[];
  /** True when MAX_MATCHES was reached and at least one more match exists. */
  truncated: boolean;
  /** Set when the source or pattern was too large to scan (matches is empty). */
  skipped: SkipReason | null;
  /** String tokens that ran unterminated in the source (ambiguous lexing). */
  lexIssues: number;
}

/**
 * Find every structural match of `pattern` in `source`, reporting truncation
 * and skips explicitly. Matches are non-overlapping and left-to-right: after a
 * match ending at token index `e`, the next search resumes at `e` (or
 * `start + 1` for an empty match, which only a pattern of entirely-empty
 * variadics could produce). Bounded by MAX_MATCHES.
 */
export function scanPattern(pattern: string, source: string, opts: LexOptions = {}): ScanResult {
  const out: ScanResult = { matches: [], truncated: false, skipped: null, lexIssues: 0 };
  const pp = parsePattern(pattern, opts);
  if (pp.skipped !== null) {
    out.skipped = pp.skipped;
    return out;
  }
  const parts = pp.parts;
  if (parts.length === 0) return out;

  const lexed = lex(source, opts);
  out.lexIssues = lexed.unterminated;
  if (lexed.skipped !== null) {
    out.skipped = lexed.skipped;
    return out;
  }
  const tokens = lexed.tokens;
  if (tokens.length === 0) return out;

  let si = 0;
  while (si < tokens.length) {
    const hit = matchAt(source, tokens, parts, si);
    if (hit === null) {
      si += 1;
      continue;
    }
    const from = si;
    const to = hit.end;
    if (to > from) {
      if (out.matches.length >= MAX_MATCHES) {
        out.truncated = true;
        break;
      }
      const first = tokens[from] as Token;
      const last = tokens[to - 1] as Token;
      out.matches.push({
        startLine: first.line,
        startColumn: first.column,
        endLine: last.endLine,
        endColumn: last.endColumn,
        byteStart: first.byteStart,
        byteEnd: last.byteEnd,
        text: source.slice(first.idxStart, last.idxEnd),
        metaVariables: { ...hit.bindings },
      });
      si = to;
    } else {
      // An empty match (all-variadic pattern bound to nothing): advance one
      // token so the scan always terminates.
      si += 1;
    }
  }
  return out;
}

/** Matches only (see `scanPattern` for the truncation / skip signals). */
export function matchPattern(pattern: string, source: string, opts: LexOptions = {}): Match[] {
  return scanPattern(pattern, source, opts).matches;
}

/**
 * Expand `template` for one match, substituting `$NAME` and `$$$NAME` with the
 * captured text. Unknown metavariables are left verbatim (so a template can
 * contain a literal `$` that is not a capture). Longest-name-first replacement
 * avoids `$AB` being clobbered by `$A`.
 */
function expandTemplate(template: string, bindings: Record<string, string>): string {
  // Replace variadic first (its sigil is longer), then single, each by a single
  // regex pass that consults the bindings so no partial name is matched.
  const variadic = template.replace(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(bindings, name) ? (bindings[name] as string) : whole,
  );
  return variadic.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(bindings, name) ? (bindings[name] as string) : whole,
  );
}

/**
 * Rewrite every structural match of `pattern` in `source` by expanding
 * `template` with that match's captures. Returns the transformed text, the
 * number of matches replaced, and the byte ranges that changed. Zero matches
 * returns the source unchanged with count 0.
 */
export function rewriteMatches(
  source: string,
  pattern: string,
  template: string,
  opts: LexOptions = {},
): RewriteResult {
  const scan = scanPattern(pattern, source, opts);
  const matches = scan.matches;
  const signals = { truncated: scan.truncated, skipped: scan.skipped, lexIssues: scan.lexIssues };
  if (matches.length === 0) return { text: source, count: 0, changes: [], ...signals };

  // Match ranges are byte offsets; map them to string indices in ONE pass.
  const idx = byteIndexMap(source, matches);
  const changes: RewriteResult["changes"] = [];
  let out = "";
  let cursor = 0;
  matches.forEach((m, k) => {
    const [from, to] = idx[k] as [number, number];
    const before = m.text;
    const after = expandTemplate(template, m.metaVariables);
    out += source.slice(cursor, from);
    out += after;
    cursor = to;
    changes.push({ byteStart: m.byteStart, byteEnd: m.byteEnd, before, after });
  });
  out += source.slice(cursor);
  return { text: out, count: matches.length, changes, ...signals };
}

/** Byte-range -> UTF-16 index range for each (ascending, non-overlapping) match, in one pass. */
function byteIndexMap(source: string, matches: Match[]): Array<[number, number]> {
  const res: Array<[number, number]> = [];
  let byte = 0;
  let idx = 0;
  const seek = (target: number): number => {
    while (idx < source.length && byte < target) {
      const cp = source.codePointAt(idx) as number;
      const w = cp > 0xffff ? 2 : 1;
      byte += Buffer.byteLength(source.slice(idx, idx + w), "utf8");
      idx += w;
    }
    return idx;
  };
  for (const m of matches) {
    const from = seek(m.byteStart);
    const to = seek(m.byteEnd);
    res.push([from, to]);
  }
  return res;
}
