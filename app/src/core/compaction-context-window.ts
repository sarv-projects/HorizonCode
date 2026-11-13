/**
 * Emergency history shrink when the provider returns CONTEXT_WINDOW_EXCEEDED.
 * Route-on-code (docs/30 §8 #12); one forced compaction pass per run before fail.
 */

import type { ProviderFailureCode } from "../contracts";

export function isContextWindowExceededCode(code: ProviderFailureCode | undefined): boolean {
  return code === "CONTEXT_WINDOW_EXCEEDED";
}

/**
 * Next provider-view message cap after a context-window failure, or null when
 * history is already minimal (caller should fail the turn).
 */
export function emergencyHistoryLimit(currentLimit: number, messageCount: number): number | null {
  const cur = Math.max(1, Math.floor(currentLimit));
  const n = Math.max(0, Math.floor(messageCount));
  if (n <= 1) return null;
  const shrunk = Math.max(1, Math.floor(cur * 0.65));
  const next = Math.min(n - 1, shrunk);
  return next >= 1 && next < n ? next : null;
}

export const CONTEXT_WINDOW_COMPACTION_NOTICE =
  "provider context window exceeded — forcing one emergency compaction before ending the turn";
