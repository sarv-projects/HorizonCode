/**
 * ws-fallback-latch.ts -- per-route WS→HTTP fallback latch (plan Task 2).
 *
 * Process-local advisory state keyed by a routing token. A route that fails
 * repeatedly stops trying WebSocket until a cooldown, then gets exactly one
 * probe. Reasons are diagnostic text only and never influence routing.
 */

export type WsLatchState = "closed" | "open" | "half_open";

export interface WsFallbackLatch {
  shouldAttemptWs(token: string): boolean;
  recordFailure(token: string, reason: string): void;
  recordSuccess(token: string): void;
  state(token: string): WsLatchState;
  failures(token: string): number;
  /** Bounded last-N diagnostic reasons for notices; never used for routing. */
  reasons(token: string): readonly string[];
}

interface LatchEntry {
  failures: number;
  openedAt: number | null;
  deadline: number;
  probeUsed: boolean;
  reasons: string[];
}

export interface WsFallbackLatchOptions {
  threshold?: number;
  now?: () => number;
  cooldownMs?: number;
  reasonLimit?: number;
}

export function createWsFallbackLatch(opts: WsFallbackLatchOptions = {}): WsFallbackLatch {
  const threshold = Math.max(1, opts.threshold ?? 3);
  const cooldownMs = Math.max(0, opts.cooldownMs ?? 60_000);
  const reasonLimit = Math.max(1, opts.reasonLimit ?? 8);
  const now = opts.now ?? Date.now;
  const routes = new Map<string, LatchEntry>();

  const entryFor = (token: string): LatchEntry | undefined => routes.get(token);
  const isHalfOpen = (entry: LatchEntry): boolean =>
    entry.openedAt !== null && now() >= entry.deadline;

  return {
    shouldAttemptWs(token: string): boolean {
      const entry = entryFor(token);
      if (entry === undefined || entry.openedAt === null) return true;
      if (now() < entry.deadline) return false;
      if (!entry.probeUsed) {
        entry.probeUsed = true;
        return true;
      }
      return false;
    },
    recordFailure(token: string, reason: string): void {
      const entry = routes.get(token) ?? {
        failures: 0,
        openedAt: null,
        deadline: 0,
        probeUsed: false,
        reasons: [],
      };
      const wasHalfOpen = entry.openedAt !== null && now() >= entry.deadline;
      entry.failures += 1;
      entry.reasons.push(reason);
      if (entry.reasons.length > reasonLimit) entry.reasons.splice(0, entry.reasons.length - reasonLimit);
      if (entry.openedAt === null) {
        if (entry.failures >= threshold) {
          entry.openedAt = now();
          entry.deadline = now() + cooldownMs;
          entry.probeUsed = false;
        }
      } else if (wasHalfOpen) {
        // A failed probe reopens with a fresh deadline.
        entry.deadline = now() + cooldownMs;
        entry.probeUsed = false;
      }
      routes.set(token, entry);
    },
    recordSuccess(token: string): void {
      routes.delete(token);
    },
    state(token: string): WsLatchState {
      const entry = entryFor(token);
      if (entry === undefined || entry.openedAt === null) return "closed";
      return isHalfOpen(entry) ? "half_open" : "open";
    },
    failures(token: string): number {
      return entryFor(token)?.failures ?? 0;
    },
    reasons(token: string): readonly string[] {
      return entryFor(token)?.reasons.slice() ?? [];
    },
  };
}
