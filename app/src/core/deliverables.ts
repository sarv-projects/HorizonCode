/**
 * DeepSeek deliverables recorder reduced (docs/30 §5.7): session-scoped
 * declared final files for the `present` tool.
 */

const declaredBySession = new Map<string, Set<string>>();

export function declareDeliverables(sessionId: string, paths: readonly string[]): string[] {
  let set = declaredBySession.get(sessionId);
  if (set === undefined) {
    set = new Set<string>();
    declaredBySession.set(sessionId, set);
  }
  const added: string[] = [];
  for (const p of paths) {
    const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (norm === "" || set.has(norm)) continue;
    set.add(norm);
    added.push(norm);
  }
  return added;
}

export function declaredDeliverables(sessionId: string): string[] {
  const set = declaredBySession.get(sessionId);
  if (set === undefined) return [];
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function clearDeliverables(sessionId: string): void {
  declaredBySession.delete(sessionId);
}

/** Test-only */
export function __resetDeliverablesForTests(): void {
  declaredBySession.clear();
}
