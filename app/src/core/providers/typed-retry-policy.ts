/**
 * typed-retry-policy.ts — port of codex RetryPolicy (Tier 1 #1).
 * Source: repo_take/codex/codex-rs/protocol/src/error.rs:84-89,460-522.
 *
 * The four semantic variants codex uses, reduced to the HorizonCode failure
 * taxonomy: `never` (terminal), `server_directed` (only a server Retry-After),
 * `backoff` (server advice or exponential backoff), `fall_back_to_http`
 * (like backoff, but marks a transport fallback to a caller). Pure decision
 * layer — no network, no authority, no contract change.
 */

import type { ProviderFailureCode } from "../../contracts";

export type RetryPolicy = "never" | "server_directed" | "backoff" | "fall_back_to_http";

const MAX_BACKOFF_MS = 20_000;

/** Map a classified HorizonCode failure code to the codex policy variant. */
export function retryPolicyForCode(code: ProviderFailureCode | undefined): RetryPolicy {
  switch (code) {
    case "AUTH":
    case "MISSING_CREDENTIAL":
    case "INVALID_CREDENTIAL":
    case "QUOTA":
    case "ACCOUNT_QUOTA":
    case "CONTEXT_WINDOW_EXCEEDED":
    case "NO_ADAPTER":
    case "EMPTY_RESPONSE":
    case "IMAGE_OFFLOAD_REQUIRED":
      return "never";
    case "RATE_LIMIT":
    case "OVERLOADED":
      return "server_directed";
    default:
      // TRANSIENT and UNKNOWN get a local backoff; UNKNOWN is conservative
      // because it is not a proven-terminal error.
      return "backoff";
  }
}

/**
 * Delay before the given (1-based) retry, or `null` for a terminal error.
 * `serverDelayMs` is the parsed `Retry-After`. Faithful to codex: `never`
 * never delays; `server_directed` refuses without server advice; `backoff`
 * and `fall_back_to_http` use server advice when present, else backoff.
 */
export function retryDelayFor(
  policy: RetryPolicy,
  retryCount: number,
  serverDelayMs: number | undefined,
): number | null {
  if (policy === "never") return null;
  const hasServerDelay = serverDelayMs !== undefined && Number.isFinite(serverDelayMs) && serverDelayMs > 0;
  if (policy === "server_directed") {
    return hasServerDelay ? serverDelayMs : null;
  }
  if (hasServerDelay) return serverDelayMs;
  const step = Number.isFinite(retryCount) ? Math.max(1, Math.floor(retryCount)) : 1;
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (step - 1));
}
