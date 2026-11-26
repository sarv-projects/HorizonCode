/**
 * rrf.ts -- reciprocal rank fusion k=60 (plan Task 21).
 * Pure lexical scorer: no embeddings, no semantic dedup, no vector store.
 */

export const RRF_K = 60;

export interface RrfRow {
  id: string;
  score: number;
}

/**
 * Ranks are 1-based. An id appearing at rank r in a list contributes
 * 1/(k+r), summed across lists; duplicates in one list count once.
 * Ties break by score descending then id lexicographically ascending.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k = RRF_K,
): RrfRow[] {
  const damping = Number.isFinite(k) ? Math.max(0, k) : RRF_K;
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    for (let index = 0; index < ranking.length; index += 1) {
      const id = ranking[index]!;
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (damping + index + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
