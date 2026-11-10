/**
 * Hashline anchors (docs/28 ruling 64), after grok-build's `grok_build_hashline/scheme.rs`
 * (research/compare-codex-grok.md section 2.2).
 *
 * An anchor is `LINE:LOCAL:CONTEXT`, e.g. `22:abc:rst`:
 *  - LINE    1-based line number in the LF view `read` shows;
 *  - LOCAL   three lowercase letters hashing the line with ALL whitespace removed
 *            (an indentation change does not stale an anchor);
 *  - CONTEXT three lowercase letters hashing the neighbouring lines' LOCAL hashes
 *            (previous and next), so an anchor also proves what surrounds it and a
 *            repeated line (`}`) is not a free pass.
 *
 * Freshness lives in the address. `validateAnchor` answers Valid / Stale / OutOfRange;
 * `findShifted` recovers a small displacement within +-DEFAULT_SEARCH_RADIUS lines and
 * treats more than one candidate as a first-class Ambiguous outcome, never a silent pick.
 * An anchor that drops its CONTEXT component (truncated) is Stale, so it cannot degrade
 * to a content-only check; a malformed anchor does not parse at all.
 *
 * Pure and dependency-free: no I/O, no clock.
 */

/** Shifted-anchor search radius (grok-build DEFAULT_SEARCH_RADIUS). */
export const DEFAULT_SEARCH_RADIUS = 15;

const HASH_LEN = 3;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Encode `h` as HASH_LEN lowercase letters (base 26). */
function encode(h: number): string {
  let out = "";
  let rest = h;
  for (let i = 0; i < HASH_LEN; i += 1) {
    out += String.fromCharCode(97 + (rest % 26));
    rest = Math.floor(rest / 26);
  }
  return out;
}

/** LOCAL hash of one line: whitespace-insensitive. */
export function lineHash(line: string): string {
  return encode(fnv1a(line.replace(/\s+/g, "")));
}

/** CONTEXT hash for the line at 0-based `idx`: the previous and next lines' LOCAL hashes. */
function contextHash(lines: readonly string[], idx: number): string {
  const prev = idx > 0 ? lineHash(lines[idx - 1] as string) : "^";
  const next = idx + 1 < lines.length ? lineHash(lines[idx + 1] as string) : "$";
  return encode(fnv1a(`${prev}|${next}`));
}

/** The rendered anchor for the line at 0-based `idx`. */
export function anchorAt(lines: readonly string[], idx: number): string {
  return `${idx + 1}:${lineHash(lines[idx] as string)}:${contextHash(lines, idx)}`;
}

export interface ParsedAnchor {
  line: number;
  local: string;
  /** null when the model dropped the context component (a truncated anchor). */
  context: string | null;
}

const ANCHOR_RE = /^([1-9][0-9]{0,8}):([a-z]{3})(?::([a-z]{3}))?$/;

/** Parse `LINE:LOCAL[:CONTEXT]`; null for anything malformed (line 0, wrong hash length, uppercase). */
export function parseAnchor(text: string): ParsedAnchor | null {
  const m = ANCHOR_RE.exec(text.trim());
  if (m === null) return null;
  return { line: Number(m[1]), local: m[2] as string, context: m[3] ?? null };
}

export type Validation = "valid" | "stale" | "out_of_range";

export function validateAnchor(anchor: ParsedAnchor, lines: readonly string[]): Validation {
  const idx = anchor.line - 1;
  if (idx < 0 || idx >= lines.length) return "out_of_range";
  if (anchor.local !== lineHash(lines[idx] as string)) return "stale";
  // A truncated anchor must not weaken to a content-only check.
  if (anchor.context === null) return "stale";
  return anchor.context === contextHash(lines, idx) ? "valid" : "stale";
}

export type Shift = { kind: "found"; line: number } | { kind: "ambiguous"; candidates: number[] } | { kind: "not_found" };

/** Search +-radius lines around the anchor's line for a unique place it validates (1-based lines). */
export function findShifted(anchor: ParsedAnchor, lines: readonly string[], radius = DEFAULT_SEARCH_RADIUS): Shift {
  if (anchor.context === null) return { kind: "not_found" };
  const orig = anchor.line - 1;
  const from = Math.max(0, orig - radius);
  const to = Math.min(lines.length - 1, orig + radius);
  const candidates: number[] = [];
  for (let idx = from; idx <= to; idx += 1) {
    if (idx === orig) continue;
    if (lineHash(lines[idx] as string) !== anchor.local) continue;
    if (contextHash(lines, idx) !== anchor.context) continue;
    candidates.push(idx + 1);
  }
  if (candidates.length === 0) return { kind: "not_found" };
  if (candidates.length === 1) return { kind: "found", line: candidates[0] as number };
  return { kind: "ambiguous", candidates };
}

export type Resolution =
  | { ok: true; line: number; shiftedFrom?: number }
  | { ok: false; error: string };

/**
 * Resolve one model-supplied anchor against the file's lines to a 1-based line.
 * Valid -> that line. Stale or OutOfRange -> a unique shifted match inside the radius, else
 * an error naming the state; an ambiguous recovery lists every candidate and applies nothing.
 */
export function resolveAnchor(text: string, lines: readonly string[]): Resolution {
  const anchor = parseAnchor(text);
  if (anchor === null) {
    return { ok: false, error: `malformed anchor "${text}" (expected LINE:abc:def as shown by read with anchors:true)` };
  }
  const state = validateAnchor(anchor, lines);
  if (state === "valid") return { ok: true, line: anchor.line };
  if (anchor.context === null) {
    return { ok: false, error: `truncated anchor "${text}": the context part is required (use the full LINE:abc:def)` };
  }
  const shift = findShifted(anchor, lines);
  if (shift.kind === "found") return { ok: true, line: shift.line, shiftedFrom: anchor.line };
  if (shift.kind === "ambiguous") {
    return {
      ok: false,
      error: `ambiguous anchor "${text}": it validates at lines ${shift.candidates.join(", ")} within +-${DEFAULT_SEARCH_RADIUS}; read the file again`,
    };
  }
  const label = state === "out_of_range" ? `out of range (file has ${lines.length} lines)` : "stale (line content changed)";
  return { ok: false, error: `anchor "${text}" is ${label} and does not recover within +-${DEFAULT_SEARCH_RADIUS} lines; read the file again` };
}
