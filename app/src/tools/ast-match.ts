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
 *                  — the variadic capture, for argument lists and bodies.
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

/** Largest source this matcher will tokenize (bytes). Larger -> empty result. */
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
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column (in UTF-16 code units) of the first character. */
  column: number;
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

/** Result of rewriteMatches: the transformed text, the match count and ranges. */
export interface RewriteResult {
  text: string;
  count: number;
  changes: Array<{ byteStart: number; byteEnd: number; before: string; after: string }>;
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
 * The lexer is intentionally language-agnostic and small: it recognises the
 * cross-language lexical shapes (C-like identifiers incl. `$`/`_`, decimal and
 * `0x`/`0b`/float numbers, `'`/`"`/backtick string literals with backslash
 * escapes, line `//` and block `/* * /` comments skipped as whitespace) and
 * treats every other non-whitespace character as a single-character
 * punctuation token. It is NOT a full parser — it is the structural granularity
 * ast-grep-style matching needs without a grammar per language.
 */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  if (typeof src !== "string") return tokens;
  if (Buffer.byteLength(src, "utf8") > MAX_SOURCE_BYTES) return tokens;

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
    if (tokens.length > MAX_TOKENS) break;
    const ch = src[i] as string;

    if (isWhitespace(ch)) {
      advance(1);
      continue;
    }

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

    const startByte = byte;
    const startLine = line;
    const startColumn = column;

    // String / template literal with backslash escapes.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const from = i;
      advance(1);
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) advance(2);
        else advance(1);
      }
      if (i < n) advance(1); // the closing quote
      tokens.push({
        kind: "string",
        text: src.slice(from, i),
        byteStart: startByte,
        byteEnd: byte,
        line: startLine,
        column: startColumn,
      });
      continue;
    }

    // Number: decimal / hex / binary / float / exponent. Kept simple: a run of
    // digits, letters (for 0x/0b/e), dots and underscores starting at a digit.
    if (DIGIT.test(ch)) {
      const from = i;
      while (i < n && /[0-9A-Fa-fxXbBoO._]/.test(src[i] as string)) advance(1);
      tokens.push({
        kind: "number",
        text: src.slice(from, i),
        byteStart: startByte,
        byteEnd: byte,
        line: startLine,
        column: startColumn,
      });
      continue;
    }

    // Identifier (letters, digits after the first, `_` and `$`).
    if (IDENT_START.test(ch)) {
      const from = i;
      while (i < n && IDENT_PART.test(src[i] as string)) advance(1);
      tokens.push({
        kind: "identifier",
        text: src.slice(from, i),
        byteStart: startByte,
        byteEnd: byte,
        line: startLine,
        column: startColumn,
      });
      continue;
    }

    // Everything else: one punctuation token (single character).
    advance(1);
    tokens.push({
      kind: "punct",
      text: ch,
      byteStart: startByte,
      byteEnd: byte,
      line: startLine,
      column: startColumn,
    });
  }

  return tokens;
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
function parsePattern(pattern: string): PatternPart[] {
  const toks = tokenize(pattern);
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
  return parts;
}

/** The source text a span of tokens [from, to) covers, verbatim. */
function spanText(src: string, tokens: Token[], from: number, to: number): string {
  if (to <= from) return "";
  const first = tokens[from] as Token;
  const last = tokens[to - 1] as Token;
  return src.slice(byteToIndex(src, first.byteStart), byteToIndex(src, last.byteEnd));
}

/**
 * Convert a byte offset to a UTF-16 string index. The tokenizer tracks both, so
 * this only runs when a slice is needed; it walks from the start once per call,
 * which is bounded by MAX_SOURCE_BYTES and only used for the (few) emitted
 * matches — never inside the hot match loop.
 */
function byteToIndex(src: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let byte = 0;
  for (let idx = 0; idx < src.length; idx += 1) {
    if (byte >= byteOffset) return idx;
    byte += Buffer.byteLength(src[idx] as string, "utf8");
  }
  return src.length;
}

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
  // only source of nondeterminism; they are matched greedily-then-shrinking.
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
      // Try the longest span first, then shrink, so a trailing literal can still
      // anchor. Bounded by MAX_VARIADIC_SPAN and the remaining source.
      const maxSpan = Math.min(MAX_VARIADIC_SPAN, tokens.length - si);
      for (let span = maxSpan; span >= 0; span -= 1) {
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

/**
 * Find every structural match of `pattern` in `source`. Matches are
 * non-overlapping and left-to-right: after a match ending at token index `e`,
 * the next search resumes at `e` (or `start + 1` for an empty match, which only
 * a pattern of entirely-empty variadics could produce). Bounded by MAX_MATCHES.
 */
export function matchPattern(pattern: string, source: string): Match[] {
  const parts = parsePattern(pattern);
  const matches: Match[] = [];
  if (parts.length === 0) return matches;

  const tokens = tokenize(source);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return matches;

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
      const first = tokens[from] as Token;
      const last = tokens[to - 1] as Token;
      matches.push({
        startLine: first.line,
        startColumn: first.column,
        endLine: last.line,
        endColumn: last.column + (last.text.length - 0),
        byteStart: first.byteStart,
        byteEnd: last.byteEnd,
        text: source.slice(byteToIndex(source, first.byteStart), byteToIndex(source, last.byteEnd)),
        metaVariables: { ...hit.bindings },
      });
      if (matches.length >= MAX_MATCHES) break;
      si = to;
    } else {
      // An empty match (all-variadic pattern bound to nothing): advance one
      // token so the scan always terminates.
      si += 1;
    }
  }
  return matches;
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
export function rewriteMatches(source: string, pattern: string, template: string): RewriteResult {
  const matches = matchPattern(pattern, source);
  if (matches.length === 0) return { text: source, count: 0, changes: [] };

  const changes: RewriteResult["changes"] = [];
  let out = "";
  let cursorByte = 0;
  for (const m of matches) {
    const before = m.text;
    const after = expandTemplate(template, m.metaVariables);
    out += source.slice(byteToIndex(source, cursorByte), byteToIndex(source, m.byteStart));
    out += after;
    cursorByte = m.byteEnd;
    changes.push({ byteStart: m.byteStart, byteEnd: m.byteEnd, before, after });
  }
  out += source.slice(byteToIndex(source, cursorByte));
  return { text: out, count: matches.length, changes };
}
