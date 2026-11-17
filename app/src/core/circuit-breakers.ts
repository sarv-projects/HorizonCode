/**
 * circuit-breakers.ts — EXPERIMENTAL edit-cycle circuit breakers.
 *
 * EVERY behaviour in this module is gated by `HZ_EXPERIMENTAL_CIRCUITS=1`
 * (default off). With the flag unset the product path is byte-identical: the
 * pure helpers are still callable (they are pure and do nothing on their own)
 * but the stateful tracker records nothing and never halts, and the entropy
 * guard never refuses a rewrite. No new runtime dependencies: hashing/canonical
 * JSON come from ./canon.ts, which is already used by the loop.
 *
 * Scope (kept deliberately small):
 *   - `cycleHash`        canonical, order-independent digest of one edit-cycle
 *                        state (edited symbols + compiler/error codes);
 *   - `CycleTracker`     a bounded, session-keyed tracker that halts after TWO
 *                        identical consecutive cycle states ("two strikes");
 *   - `diffEntropyGuard` a pure refusal of a >40% rewrite of a file unless an
 *                        explicit refactor directive is present.
 *
 * HOOKUP POINT (single, documented — deliberately NOT wired): the loop's tool
 * dispatch (`loop.ts`, the `executeTool` / batch-apply path) is the only place
 * that could supply BOTH the edited symbol set and the compiler/error codes for
 * a cycle. Today those two facts are NOT jointly available there: the edit
 * tools record whole-file changes in `tools/change-journal.ts` (no symbol set)
 * and diagnostics live behind the opt-in `lsp`/`lint` tools (no error-code list
 * on the dispatch path). Inventing either signal would change default behaviour
 * and break the byte-identical contract, so this module exposes the pure API
 * plus the bounded tracker and leaves the single hookup point documented here.
 * An integrator who adds a combined `(editedSymbols, errorCodes)` signal to tool
 * dispatch should call `tracker.trackCycle(sessionId, symbols, codes)` before
 * dispatch and, when it returns `halt: true`, refuse the cycle; separately,
 * call `diffEntropyGuard(before, after, { explicitRefactor })` before applying a
 * rewrite and honour `allowed: false`. Both calls are inert unless the flag is
 * on.
 */

import { canonicalJson, sha256Hex } from "./canon";

/** The one flag that enables every experimental circuit behaviour. */
export const CIRCUITS_FLAG = "HZ_EXPERIMENTAL_CIRCUITS";

/** True only when the experimental flag is explicitly `1`. */
export function circuitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CIRCUITS_FLAG] === "1";
}

/**
 * Stable canonical hash of one edit-cycle state. The two inputs are sorted and
 * deduplicated before hashing so that the same set in a different order (or
 * with duplicates) yields the same digest — the property the two-strike halt
 * depends on. Hashing goes through canon.ts's canonical JSON + sha256Hex.
 */
export function cycleHash(editedSymbols: readonly string[], compilerErrorCodes: readonly string[]): string {
  const symbols = [...new Set(editedSymbols)].sort();
  const errors = [...new Set(compilerErrorCodes)].sort();
  return sha256Hex(canonicalJson({ symbols, errors }));
}

export interface CycleDecision {
  /** True when two identical consecutive states were observed. */
  halt: boolean;
  /** Consecutive identical-state count for this state (1 on first sight). */
  strikes: number;
}

interface CycleState {
  lastHash: string | undefined;
  strikes: number;
  halted: boolean;
}

/** Cap on tracked sessions so an unbounded stream of session ids cannot grow memory. */
const MAX_TRACKED_SESSIONS = 4_096;

/**
 * A small, bounded, session-keyed stateful tracker. With the flag off,
 * `trackCycle` is a no-op (`{ halt: false, strikes: 0 }`) and stores nothing.
 * With the flag on, the same hash seen twice in a row returns `halt: true`.
 */
export class CycleTracker {
  private readonly bySession = new Map<string, CycleState>();

  constructor(readonly maxSessions: number = MAX_TRACKED_SESSIONS) {}

  get size(): number {
    return this.bySession.size;
  }

  /** Forget one session's cycle state (e.g. on a new user prompt). */
  reset(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Clear all cycle state. */
  clear(): void {
    this.bySession.clear();
  }

  /**
   * Record one `(editedSymbols, compilerErrorCodes)` state for `sessionId` and
   * return whether the cycle must halt. Two identical consecutive states halt.
   */
  trackCycle(
    sessionId: string,
    editedSymbols: readonly string[],
    compilerErrorCodes: readonly string[],
  ): CycleDecision {
    if (!circuitsEnabled()) return { halt: false, strikes: 0 };
    const hash = cycleHash(editedSymbols, compilerErrorCodes);
    let state = this.bySession.get(sessionId);
    if (state === undefined) {
      if (this.bySession.size >= this.maxSessions) {
        // Bounded: evict the least-recently-inserted session before adding one.
        const oldest = this.bySession.keys().next().value;
        if (oldest !== undefined) this.bySession.delete(oldest);
      }
      state = { lastHash: undefined, strikes: 0, halted: false };
      this.bySession.set(sessionId, state);
    }
    // A halted session stays halted until reset: do not let a later state clear
    // the signal by "recovering" after the breaker already fired.
    if (state.halted) return { halt: true, strikes: state.strikes };
    if (state.lastHash === hash) state.strikes += 1;
    else {
      state.strikes = 1;
      state.lastHash = hash;
    }
    if (state.strikes >= 2) {
      state.halted = true;
      return { halt: true, strikes: state.strikes };
    }
    return { halt: false, strikes: state.strikes };
  }
}

/** Convenience wrapper matching the `trackCycle(...)` call shape. */
export function trackCycle(
  tracker: CycleTracker,
  sessionId: string,
  editedSymbols: readonly string[],
  compilerErrorCodes: readonly string[],
): CycleDecision {
  return tracker.trackCycle(sessionId, editedSymbols, compilerErrorCodes);
}

/** The rewrite ratio at or below which a rewrite is allowed (40%). */
export const DIFF_ENTROPY_THRESHOLD = 0.4;

export interface DiffEntropyOptions {
  /** An explicit refactor directive bypasses the refusal. */
  explicitRefactor?: boolean;
}

export interface DiffEntropyDecision {
  /** False when a >40% rewrite was refused. */
  allowed: boolean;
  /** Fraction of lines changed, in [0, 1] (0 when the flag is off). */
  changedRatio: number;
  /** The threshold applied (0 when the flag is off). */
  threshold: number;
}

function changedLineRatio(before: string, after: string): number {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const shared = Math.min(a.length, b.length);
  let changed = Math.abs(a.length - b.length);
  for (let i = 0; i < shared; i += 1) if (a[i] !== b[i]) changed += 1;
  return changed / Math.max(1, Math.max(a.length, b.length));
}

/**
 * Pure refusal of a large rewrite. With the flag off this is a no-op
 * (`allowed: true`, ratio/threshold 0). With the flag on, a rewrite of MORE than
 * 40% of a file is refused unless `explicitRefactor` is true; exactly 40% is
 * allowed (strict `>` boundary).
 */
export function diffEntropyGuard(
  before: string,
  after: string,
  opts: DiffEntropyOptions = {},
): DiffEntropyDecision {
  if (!circuitsEnabled()) return { allowed: true, changedRatio: 0, threshold: 0 };
  const ratio = changedLineRatio(before, after);
  if (opts.explicitRefactor === true) {
    return { allowed: true, changedRatio: ratio, threshold: DIFF_ENTROPY_THRESHOLD };
  }
  return {
    allowed: ratio <= DIFF_ENTROPY_THRESHOLD,
    changedRatio: ratio,
    threshold: DIFF_ENTROPY_THRESHOLD,
  };
}
