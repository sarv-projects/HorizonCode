/**
 * read-ledger.ts — which files this session has actually read.
 *
 * The gate against the "wrong edit" class (audit finding 2). A model can name a
 * path it never inspected; the fuzzy rungs of `edit` can then reconstruct a
 * location and splice a replacement into a region it never saw, and `write`
 * replaces a whole file with no knowledge of what was in it.
 *
 * Only `read` writes this ledger. `grep` and `repo_map` return fragments, and a
 * fragment is not evidence of having seen the file — treating it as such would
 * weaken the gate to nothing. Keyed by session and by the realpath of the
 * target, so a read of `link.txt` counts for `real.txt` (the verify-then-allow
 * symlink policy in ./verified-open.ts).
 *
 * Exact-string edits are deliberately NOT gated: the caller supplied the exact
 * preimage text, and the sha256 preimage check immediately before the write
 * still refuses a stale one. The gate bites where the guesswork is.
 *
 * The ledger is process memory, not session state: a resumed session re-reads
 * what it needs, which is the safe direction for a freshness check.
 */

import type { ToolContext } from "../contracts";
import { realpathish } from "../core/paths";

/** Insertion-ordered so the oldest entry can be evicted at the cap. */
const seen = new Map<string, number>();
/**
 * A long session can read a very large tree; the cap keeps the ledger bounded
 * without a timer. Eviction is oldest-first and only ever loses a "read"
 * fact, which fails closed (a needless re-read), never open.
 */
const MAX_ENTRIES = 20_000;

function ledgerKey(ctx: ToolContext, resolved: string): string {
  return `${ctx.sessionId}\u0000${realpathish(resolved)}`;
}

/** Record that this session read `resolved` (called by the `read` tool). */
export function noteRead(ctx: ToolContext, resolved: string): void {
  const key = ledgerKey(ctx, resolved);
  if (seen.has(key)) return;
  seen.set(key, Date.now());
  if (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next();
    if (!oldest.done) seen.delete(oldest.value);
  }
}

/** True when this session has read `resolved` (the realpath). */
export function wasRead(ctx: ToolContext, resolved: string): boolean {
  return seen.has(ledgerKey(ctx, resolved));
}

/** Entry count for one session — the observability hook, used by tests. */
export function readLedgerSize(sessionId: string): number {
  let n = 0;
  for (const key of seen.keys()) if (key.startsWith(`${sessionId}\u0000`)) n += 1;
  return n;
}

/** Drop one session's entries (`forgetReads()`, or all when no id is given). */
export function forgetReads(sessionId?: string): void {
  if (sessionId === undefined) {
    seen.clear();
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of [...seen.keys()]) if (key.startsWith(prefix)) seen.delete(key);
}
