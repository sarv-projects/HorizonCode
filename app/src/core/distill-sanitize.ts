/**
 * distill-sanitize.ts — conservative hygiene for untrusted text entering the
 * growth loop's "distill" path (backlog G-6, the Trojan-Source vector).
 *
 * WHY. A zero-width character between letters (`a\u200Bllow`) hides a token from
 * a word scan; a bidi override (U+202E) makes displayed text read differently
 * from its bytes. Both let untrusted text smuggle an instruction past the
 * editorial standard in curator.ts or past the model-facing transcript context
 * in review.ts, while a human reviewing the rendered text sees something else.
 * Stripping these controls BEFORE distillation closes that gap.
 *
 * SCOPE — deliberately narrow and documented:
 *   - ONLY invisible/bidi FORMAT controls are removed (the set below).
 *   - Meaningful whitespace is NEVER removed: U+0020 space, TAB, CR, LF and the
 *     Unicode line/paragraph separators U+2028/U+2029 all pass through
 *     byte-for-byte. So do the visible-space characters U+2000..U+200A.
 *   - No visible/script character is touched (CJK, emoji, combining marks,
 *     Arabic/Hebrew letters are preserved). No normalization, no folding,
 *     no execution — this is a plain regex replace, not a parser.
 *   - Zero dependencies. Pure: the input is never mutated, and nothing is
 *     written to disk or workspace (ADR-010).
 *
 * The removed set (Unicode category Cf, plus the bidi controls):
 *   U+00AD  SOFT HYPHEN
 *   U+061C  ARABIC LETTER MARK
 *   U+200B..U+200D  ZERO WIDTH SPACE / NON-JOINER / JOINER
 *   U+200E..U+200F  LEFT-TO-RIGHT / RIGHT-TO-LEFT MARK
 *   U+202A..U+202E  LRE/RLE/PDF/LRO/RLO (bidi embedding/override)
 *   U+2060..U+2064  WORD JOINER + invisible function operators
 *   U+2066..U+2069  LRI/RLI/FSI/PDI (bidi isolates)
 *   U+FEFF  BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE
 * Notably NOT in the set: U+2028/U+2029 (line/paragraph separators are text
 * layout, not format controls) and U+2000..U+200A (visible spaces).
 */

/** The exact invisible/bidi code points removed. Change only with a test. */
export const INVISIBLE_BIDI_RE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export interface SanitizedText {
  /** The text with invisible/bidi controls removed. */
  text: string;
  /** How many control characters were removed. */
  stripped: number;
  /** True when at least one character was removed. */
  changed: boolean;
}

/**
 * Strip invisible/bidi controls from `input`. Non-strings become "". Returns
 * the cleaned text plus a count so callers can report (or refuse) a rewrite
 * rather than silently changing bytes.
 */
export function stripInvisibleControls(input: unknown): SanitizedText {
  const text = typeof input === "string" ? input : "";
  let stripped = 0;
  const cleaned = text.replace(INVISIBLE_BIDI_RE, () => {
    stripped += 1;
    return "";
  });
  return { text: cleaned, stripped, changed: stripped > 0 };
}

/** Convenience: just the cleaned text, for paths that do not need the count. */
export function sanitizeForDistill(input: unknown): string {
  return stripInvisibleControls(input).text;
}
