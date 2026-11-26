/**
 * thinking-loop-guard.ts — port of oh-my-pi semantic thinking-loop detectors
 * (must-steal #13). Source: repo_take/oh-my-pi/packages/ai/src/utils/
 * thinking-loop.ts:94-125. Calibrated thresholds reproduced exactly:
 *   SEGMENT_SIMILARITY=0.8, SEGMENT_MIN_COUNT=8, SEGMENT_MIN_CLUSTER=4,
 *   LEX_STALL_NOVELTY_FLOOR=0.2, LEX_STALL_MIN_RUN=8, concrete-anchor reset.
 * Pure detectors over already-captured thinking text; no stream mutation.
 */

const SEGMENT_SIMILARITY = 0.8;
const SEGMENT_MIN_COUNT = 8;
const SEGMENT_MIN_CLUSTER = 4;
const SEGMENT_WINDOW = 16;
const LEX_NOVELTY_WINDOW = 8;
const LEX_STALL_NOVELTY_FLOOR = 0.2;
const LEX_STALL_MIN_RUN = 8;

// global flag per the upstream contract (matchAll, never test)
const CONCRETE_ANCHOR =
  /`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g;

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "while", "while", "in", "on", "at", "to", "for",
  "of", "with", "is", "are", "was", "we", "it", "this", "that", "and", "in", "the", "with",
]);

function words(segment: string): string[] {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/** Word-trigram set (order-sensitive, whitespace-normalized). */
export function wordTrigrams(segment: string): Set<string> {
  const w = words(segment);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i += 1) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Near-duplicate segment clustering: a cluster of 4 at Jaccard ≥ 0.8 trips. */
export function detectNearDuplicateSegments(segments: readonly string[]): boolean {
  if (segments.length < SEGMENT_MIN_COUNT) return false;
  const fingerprints = segments.slice(-SEGMENT_WINDOW).map(wordTrigrams);
  for (let i = 0; i < fingerprints.length; i += 1) {
    let cluster = 1;
    for (let j = 0; j < fingerprints.length; j += 1) {
      if (i === j) continue;
      if (jaccard(fingerprints[i]!, fingerprints[j]!) >= SEGMENT_SIMILARITY) cluster += 1;
    }
    if (cluster >= SEGMENT_MIN_CLUSTER) return true;
  }
  return false;
}

function hasConcreteAnchor(segment: string): boolean {
  return [...segment.matchAll(CONCRETE_ANCHOR)].length > 0;
}

/** Progress-lexicon stall: 8 consecutive low-novelty, anchor-free segments. */
export function detectProgressLexiconStall(segments: readonly string[]): boolean {
  if (segments.length < LEX_STALL_MIN_RUN) return false;
  let run = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (hasConcreteAnchor(segment)) {
      run = 0;
      continue;
    }
    const current = new Set(words(segment));
    if (current.size === 0) {
      run = 0;
      continue;
    }
    const baseline = new Set<string>();
    const start = Math.max(0, i - LEX_NOVELTY_WINDOW);
    for (let j = start; j < i; j += 1) for (const w of words(segments[j]!)) baseline.add(w);
    let novel = 0;
    for (const w of current) if (!baseline.has(w)) novel += 1;
    const novelty = novel / current.size;
    run = novelty <= LEX_STALL_NOVELTY_FLOOR ? run + 1 : 0;
    if (run >= LEX_STALL_MIN_RUN) return true;
  }
  return false;
}
