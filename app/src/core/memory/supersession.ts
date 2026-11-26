/**
 * supersession.ts -- lexical fact supersession overlay (plan Task 23).
 *
 * A newer fact with the same exact lexical key supersedes older ones. This is
 * a RANKING OVERLAY only: superseded rows are returned, never deleted from the
 * store. No embeddings, no fuzzy/semantic matching (owner rejection).
 */

export interface MemoryFactRow {
  id: string;
  content: string;
  storedAtMs: number;
}

export interface SupersessionResult {
  active: MemoryFactRow[];
  supersededIds: string[];
}

/** Lowercased prefix before the first `:`, whitespace-normalized. */
export function factKey(content: string): string {
  const raw = typeof content === "string" ? content : "";
  const colon = raw.indexOf(":");
  const prefix = colon >= 0 ? raw.slice(0, colon) : raw;
  return prefix.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Group by exact factKey; keep the most-recent storedAtMs per group (stable
 * id tie-break: lexicographically smaller id wins an exact timestamp tie).
 * Active rows preserve input order; the rest are reported as supersededIds.
 */
export function applySupersession(facts: readonly MemoryFactRow[]): SupersessionResult {
  const groups = new Map<string, MemoryFactRow[]>();
  for (const fact of facts) {
    const key = factKey(fact.content);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [fact]);
    else group.push(fact);
  }

  const winnerIds = new Set<string>();
  for (const group of groups.values()) {
    let winner = group[0]!;
    for (let i = 1; i < group.length; i += 1) {
      const candidate = group[i]!;
      if (
        candidate.storedAtMs > winner.storedAtMs ||
        (candidate.storedAtMs === winner.storedAtMs && candidate.id < winner.id)
      ) {
        winner = candidate;
      }
    }
    winnerIds.add(winner.id);
  }

  const active = facts.filter((fact) => winnerIds.has(fact.id));
  const supersededIds = facts.filter((fact) => !winnerIds.has(fact.id)).map((fact) => fact.id);
  return { active, supersededIds };
}
