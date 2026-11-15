import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  formatProviderFailureMessage,
  isRetryableFailureCode,
  PROVIDER_FAILURE_CODE_NAMES,
  retryAttemptsForFailureCode,
  summarizeProviderFailureCodes,
} from "../../src/core/providers/failure-codes";

describe("provider failure codes", () => {
  test("closed union has 13 names", () => {
    expect(PROVIDER_FAILURE_CODE_NAMES).toHaveLength(13);
    expect(summarizeProviderFailureCodes()).toContain("13 closed codes");
  });

  test("HTTP status and message classify to stable codes", () => {
    expect(classifyProviderFailure(401)).toBe("AUTH");
    expect(classifyProviderFailure(429)).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(529)).toBe("OVERLOADED");
    expect(classifyProviderFailure(400, "maximum context length exceeded")).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(classifyProviderFailure(402, "insufficient quota for org")).toBe("QUOTA");
    expect(classifyProviderFailure(403, "account quota exceeded")).toBe("ACCOUNT_QUOTA");
  });

  test("formatProviderFailureMessage prefixes classified code", () => {
    expect(formatProviderFailureMessage("boom")).toBe("boom");
    expect(formatProviderFailureMessage("boom", "RATE_LIMIT")).toBe("[RATE_LIMIT] boom");
  });

  test("retry routing on code", () => {
    expect(isRetryableFailureCode("RATE_LIMIT")).toBe(true);
    expect(isRetryableFailureCode("QUOTA")).toBe(false);
    expect(retryAttemptsForFailureCode("RATE_LIMIT", 4)).toBe(4);
    expect(retryAttemptsForFailureCode("CONTEXT_WINDOW_EXCEEDED", 4)).toBe(1);
  });
});
