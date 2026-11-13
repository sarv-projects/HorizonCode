import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  isRetryableFailureCode,
  retryAttemptsForFailureCode,
} from "../../src/core/providers/failure-codes";

describe("provider failure codes", () => {
  test("HTTP status and message classify to stable codes", () => {
    expect(classifyProviderFailure(401)).toBe("AUTH");
    expect(classifyProviderFailure(429)).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(529)).toBe("OVERLOADED");
    expect(classifyProviderFailure(400, "maximum context length exceeded")).toBe("CONTEXT_WINDOW_EXCEEDED");
    expect(classifyProviderFailure(402, "insufficient quota for org")).toBe("QUOTA");
    expect(classifyProviderFailure(403, "account quota exceeded")).toBe("ACCOUNT_QUOTA");
  });

  test("retry routing on code", () => {
    expect(isRetryableFailureCode("RATE_LIMIT")).toBe(true);
    expect(isRetryableFailureCode("QUOTA")).toBe(false);
    expect(retryAttemptsForFailureCode("RATE_LIMIT", 4)).toBe(4);
    expect(retryAttemptsForFailureCode("CONTEXT_WINDOW_EXCEEDED", 4)).toBe(1);
  });
});
