/**
 * fuzzy.ts — subsequence fuzzy match for slash palette (docs/13 D5 reduced).
 */

/** Higher is better. Prefix-aligned query chars score more. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 1;
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      qi += 1;
      run += 1;
      score += 10 + run;
      if (i === 0 || t[i - 1] === "/" || t[i - 1] === " ") score += 5;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return -1;
  if (t.startsWith(q)) score += 20;
  return score;
}

export interface FuzzyRow {
  text: string;
  score: number;
}

export function rankFuzzy<T>(query: string, rows: readonly T[], label: (row: T) => string, limit = 12): FuzzyRow[] {
  const out: FuzzyRow[] = [];
  for (const row of rows) {
    const text = label(row);
    const score = fuzzyScore(query, text);
    if (score < 0) continue;
    out.push({ text, score });
  }
  out.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return out.slice(0, limit);
}
