/**
 * failure-codes.ts — classify provider HTTP failures (docs/30 §8 #12 ADAPT).
 *
 * Regex message routes are ported in reduced form from deepseek-harness error
 * helpers and codex retry routing: one closed code union in contracts.ts.
 */

import type { ProviderFailureCode } from "../../contracts";

const CTX_WINDOW =
  /context.?window|maximum.?context|prompt.?too.?long|input.?too.?long|too.?many.?tokens|max(?:imum)?_?(?:prompt|context)_?tokens/i;
const QUOTA = /quota.?exceeded|insufficient.?quota|billing|credit.?balance|usage.?limit/i;
const ACCOUNT_QUOTA = /account.?(?:quota|limit)|organization.?(?:quota|limit)/i;
const OVERLOAD = /overloaded|capacity|temporarily.?unavailable|high.?demand/i;

function scanMessage(body: string): ProviderFailureCode | undefined {
  const t = body.length > 4000 ? body.slice(0, 4000) : body;
  if (ACCOUNT_QUOTA.test(t)) return "ACCOUNT_QUOTA";
  if (CTX_WINDOW.test(t)) return "CONTEXT_WINDOW_EXCEEDED";
  if (QUOTA.test(t)) return "QUOTA";
  if (OVERLOAD.test(t)) return "OVERLOADED";
  return undefined;
}

/** Map an HTTP status and optional response body to a stable failure code. */
export function classifyProviderFailure(status: number, body?: string): ProviderFailureCode {
  const text = typeof body === "string" ? body : "";
  const fromMsg = text !== "" ? scanMessage(text) : undefined;
  if (fromMsg !== undefined) return fromMsg;
  if (status === 401) return "AUTH";
  if (status === 403) return "AUTH";
  if (status === 404) return "NO_ADAPTER";
  if (status === 408 || status === 425) return "TRANSIENT";
  if (status === 429) return "RATE_LIMIT";
  if (status === 529) return "OVERLOADED";
  if (status >= 500) return "TRANSIENT";
  if (status === 413) return "CONTEXT_WINDOW_EXCEEDED";
  return "UNKNOWN";
}

/** Codes worth another attempt at the HTTP layer (request phase only). */
export function isRetryableFailureCode(code: ProviderFailureCode): boolean {
  return code === "RATE_LIMIT" || code === "OVERLOADED" || code === "TRANSIENT";
}

/** Tighter attempt budget for failures that will not clear on retry. */
export function retryAttemptsForFailureCode(
  code: ProviderFailureCode | undefined,
  defaultAttempts: number,
): number {
  const base = Math.max(1, Math.floor(defaultAttempts));
  if (code === undefined) return base;
  if (code === "RATE_LIMIT" || code === "OVERLOADED" || code === "TRANSIENT") return base;
  if (
    code === "AUTH" ||
    code === "MISSING_CREDENTIAL" ||
    code === "INVALID_CREDENTIAL" ||
    code === "CONTEXT_WINDOW_EXCEEDED" ||
    code === "QUOTA" ||
    code === "ACCOUNT_QUOTA" ||
    code === "NO_ADAPTER" ||
    code === "EMPTY_RESPONSE" ||
    code === "IMAGE_OFFLOAD_REQUIRED"
  ) {
    return 1;
  }
  return base;
}
