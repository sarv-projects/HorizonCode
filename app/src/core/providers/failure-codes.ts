/**
 * failure-codes.ts — classify provider HTTP failures (docs/30 §8 #12 ADAPT).
 *
 * Regex message routes are ported in reduced form from deepseek-harness error
 * helpers and codex retry routing: one closed code union in contracts.ts.
 */

import type { ProviderFailureCode } from "../../contracts";

/** Closed union cardinality for doctor / status (docs/30 §8 #12). */
export const PROVIDER_FAILURE_CODE_NAMES: readonly ProviderFailureCode[] = [
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "AUTH",
  "RATE_LIMIT",
  "OVERLOADED",
  "TRANSIENT",
  "CONTEXT_WINDOW_EXCEEDED",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "EMPTY_RESPONSE",
  "IMAGE_OFFLOAD_REQUIRED",
  "UNKNOWN",
];

/** Prefix for stderr/TUI when a provider error carries a classified code. */
export function formatProviderFailureMessage(message: string, code?: ProviderFailureCode): string {
  if (code === undefined) return message;
  return `[${code}] ${message}`;
}

export function summarizeProviderFailureCodes(): string {
  return `${PROVIDER_FAILURE_CODE_NAMES.length} closed codes; classifyProviderFailure + retryAttemptsForFailureCode (openai-compat + anthropic + ollama + google HTTP/SSE)`;
}

/** Broader context-overflow phrases (ADAPT opencode `provider-error.ts` patterns). */
const CTX_WINDOW =
  /context.?window|maximum.?context|prompt(?: is)? too.?long|input.?too.?long|too.?many.?tokens|max(?:imum)?_?(?:prompt|context)_?tokens|exceeds (?:the )?(?:model'?s )?maximum context length|input token count.*exceeds the maximum|number of input tokens exceeds maximum length|tokens in request more than max tokens allowed|maximum context length is \d+ tokens|reduce the length of the messages|context_length_exceeded|model_context_window_exceeded/i;
/** Explicit provider error codes that mean context overflow regardless of phrasing. */
const CTX_CODES = /context_length_exceeded|model_context_window_exceeded|request_too_large|request entity too large/i;
/**
 * Throttle / account-cap phrasing must never be read as context overflow. A
 * 429 body saying "too many tokens processed" is a rate limit, not something
 * compaction can fix (opencode classifier exclusions).
 */
const CTX_EXCLUSIONS =
  /rate.?limit|too.?many.?requests|throttl|too.?many.?tokens(?: per day)?,? please wait|max[_ ]tokens must be less than/i;
const QUOTA = /quota.?exceeded|insufficient.?quota|billing|credit.?balance|usage.?limit/i;
const ACCOUNT_QUOTA = /account.?(?:quota|limit)|organization.?(?:quota|limit)/i;
const OVERLOAD = /overloaded|capacity|temporarily.?unavailable|high.?demand/i;

function scanMessage(body: string): ProviderFailureCode | undefined {
  const t = body.length > 4000 ? body.slice(0, 4000) : body;
  if (ACCOUNT_QUOTA.test(t)) return "ACCOUNT_QUOTA";
  if (!CTX_EXCLUSIONS.test(t) && (CTX_WINDOW.test(t) || CTX_CODES.test(t))) return "CONTEXT_WINDOW_EXCEEDED";
  if (QUOTA.test(t)) return "QUOTA";
  if (OVERLOAD.test(t)) return "OVERLOADED";
  return undefined;
}

/** Map an HTTP status and optional response body to a stable failure code. */
export function classifyProviderFailure(status: number, body?: string): ProviderFailureCode {
  const text = typeof body === "string" ? body : "";
  // 429 is first: throttles and account caps share the status, and their bodies
  // frequently contain overflow-looking phrases ("too many tokens processed").
  // Compaction cannot help, and the retry policy must still see a rate limit.
  if (status === 429) {
    if (ACCOUNT_QUOTA.test(text)) return "ACCOUNT_QUOTA";
    if (QUOTA.test(text)) return "QUOTA";
    return "RATE_LIMIT";
  }
  const fromMsg = text !== "" ? scanMessage(text) : undefined;
  if (fromMsg !== undefined) return fromMsg;
  if (status === 401) return "AUTH";
  if (status === 403) return "AUTH";
  if (status === 404) return "NO_ADAPTER";
  if (status === 408 || status === 425) return "TRANSIENT";
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
