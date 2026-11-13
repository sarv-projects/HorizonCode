/**
 * mmr-lite.ts — lexical MMR over BM25 candidates (no embeddings).
 *
 * Greedy max marginal relevance using Jaccard similarity on word tokens.
 * ADAPT from Grok `mmr.rs` ideas; ranking input stays SQLite bm25().
 */

export type ScoredMemoryCandidate = {
  content: string;
  /** SQLite bm25() score (negative; more negative = better match). */
  rank: number;
  bank?: string;
};

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim();
    if (t.length >= 3) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/** Relevance from BM25 sort position (caller passes best-first candidates). */
function relevanceByRankIndex(index: number, total: number): number {
  if (total <= 1) return 1;
  return (total - index) / total;
}

/**
 * Select up to `limit` diverse hits from BM25-ordered candidates.
 * `lambda` ∈ (0,1]: higher favours relevance over diversity.
 */
export function mmrLiteSelect<T extends ScoredMemoryCandidate>(
  candidates: readonly T[],
  limit: number,
  lambda = 0.58,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  if (candidates.length <= limit) return [...candidates];

  const pool = [...candidates];
  const rankIndex = new Map<T, number>();
  for (let i = 0; i < candidates.length; i++) rankIndex.set(candidates[i], i);

  const selected: T[] = [];
  const tokenCache = new Map<T, Set<string>>();

  const tokensOf = (row: T): Set<string> => {
    let cached = tokenCache.get(row);
    if (cached === undefined) {
      cached = tokenSet(row.content);
      tokenCache.set(row, cached);
    }
    return cached;
  };

  while (selected.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const rel = relevanceByRankIndex(rankIndex.get(c) ?? i, candidates.length);
      let maxSim = 0;
      const ct = tokensOf(c);
      for (const s of selected) {
        maxSim = Math.max(maxSim, jaccard(ct, tokensOf(s)));
      }
      const score = lambda * rel - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}
