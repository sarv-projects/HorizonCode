/**
 * failure-signals.test.ts — structured failure-signal extraction
 * (opencode provider-error.ts ADAPT). AWS x-amzn-errortype, RFC 9457 detail,
 * gateway code labels, and provider code sets — additive to failure-codes.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  extractFailureCodes,
  extractRfc9457Code,
  awsErrorType,
  GATEWAY_CODE_LABEL,
} from "../../src/core/providers/failure-signals";

describe("structured failure signals (opencode port)", () => {
  test("extracts provider codes from a JSON error body", () => {
    expect(extractFailureCodes('{"error":{"code":"context_length_exceeded"}}')).toContain("context_length_exceeded");
    expect(extractFailureCodes('{"type":"throttling_exception"}')).toContain("throttling_exception");
  });

  test("AWS x-amzn-errortype header is parsed (suffix-stripped, lowercased)", () => {
    expect(awsErrorType("ThrottlingException:xyz")).toEqual(["throttlingexception"]);
    expect(awsErrorType("ValidationException")).toEqual(["validationexception"]);
    expect(awsErrorType(undefined)).toEqual([]);
  });

  test("RFC 9457 problem+json detail code is extracted", () => {
    expect(extractRfc9457Code('{"type":"about:blank","code":"rate_limit_exceeded","detail":"slow down"}'))
      .toBe("rate_limit_exceeded");
    expect(extractRfc9457Code("not json")).toBeUndefined();
  });

  test("gateway code label from a message", () => {
    const m = "server_error (gateway code: overloaded_error)";
    const found = GATEWAY_CODE_LABEL.exec(m);
    expect(found?.[1]).toBe("overloaded_error");
  });

  test("429 throttle phrasing excluded from overflow classification signal", () => {
    const codes = extractFailureCodes('{"code":"too_many_tokens_processed"}');
    expect(codes.some((c) => c.includes("rate") || c.includes("throttle") || c.includes("too_many"))).toBe(true);
  });
});
