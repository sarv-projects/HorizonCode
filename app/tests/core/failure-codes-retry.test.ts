/**
 * failure-codes-retry.test.ts — 429-first classification (opencode exclusions)
 * and the x-should-retry header override seam.
 */
import { describe, expect, test } from "bun:test";
import { classifyProviderFailure } from "../../src/core/providers/failure-codes";
import {
  retryOverrideFromHeaders,
  shouldRetryResponse,
} from "../../src/core/providers/retry";

describe("context overflow vs throttle classification", () => {
  test("429 with 'too many tokens' stays RATE_LIMIT, never CONTEXT_WINDOW", () => {
    expect(classifyProviderFailure(429, "Too many tokens processed, please slow down")).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(429, "rate limit exceeded: too many tokens")).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(429, "Too many tokens per minute, please wait")).toBe("RATE_LIMIT");
  });

  test("real overflow phrases classify as CONTEXT_WINDOW_EXCEEDED", () => {
    expect(classifyProviderFailure(400, "maximum context length exceeded")).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(classifyProviderFailure(400, "prompt is too long")).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(classifyProviderFailure(400, "context_length_exceeded")).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(classifyProviderFailure(400, "This model's maximum context length is 128000 tokens")).toBe(
      "CONTEXT_WINDOW_EXCEEDED",
    );
    expect(classifyProviderFailure(413, "request entity too large")).toBe("CONTEXT_WINDOW_EXCEEDED");
  });

  test("throttle phrasing on a non-429 is excluded from overflow", () => {
    expect(classifyProviderFailure(500, "rate limit: too many tokens seen")).toBe("TRANSIENT");
  });

  test("account quota on 429 maps to QUOTA, not RATE_LIMIT", () => {
    expect(classifyProviderFailure(429, "insufficient quota for organization")).toBe("QUOTA");
  });
});

describe("x-should-retry override seam", () => {
  test("parses true/false/absent from Headers and plain records", () => {
    expect(retryOverrideFromHeaders(new Headers({ "x-should-retry": "TRUE" }))).toBe(true);
    expect(retryOverrideFromHeaders({ "X-Should-Retry": "false" })).toBe(false);
    expect(retryOverrideFromHeaders({ "x-should-retry": "maybe" })).toBeUndefined();
    expect(retryOverrideFromHeaders(undefined)).toBeUndefined();
  });

  test("override forces or forbids a retry, otherwise falls back to classification", () => {
    // 400 is not normally retryable; the header forces it.
    expect(shouldRetryResponse(400, "bad request", { "x-should-retry": "true" })).toBe(true);
    // 429 is normally retryable; the header forbids it.
    expect(shouldRetryResponse(429, "slow down", { "x-should-retry": "false" })).toBe(false);
    expect(shouldRetryResponse(429, "slow down")).toBe(true);
    expect(shouldRetryResponse(401, "unauthorized")).toBe(false);
  });
});
