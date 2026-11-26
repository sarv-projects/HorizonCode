/**
 * typed-retry-policy.test.ts — port of codex RetryPolicy enum (Tier 1 #1).
 * Faithful to error.rs:84-89,460-522. Test-first: fails on missing module.
 */
import { describe, expect, test } from "bun:test";
import {
  retryDelayFor,
  retryPolicyForCode,
  type RetryPolicy,
} from "../../src/core/providers/typed-retry-policy";

describe("typed retry policy (codex port)", () => {
  test("terminal codes never retry; rate/overload are server-directed; transient is backoff", () => {
    expect(retryPolicyForCode("AUTH")).toBe("never");
    expect(retryPolicyForCode("QUOTA")).toBe("never");
    expect(retryPolicyForCode("CONTEXT_WINDOW_EXCEEDED")).toBe("never");
    expect(retryPolicyForCode("RATE_LIMIT")).toBe("server_directed");
    expect(retryPolicyForCode("OVERLOADED")).toBe("server_directed");
    expect(retryPolicyForCode("TRANSIENT")).toBe("backoff");
    expect(retryPolicyForCode("UNKNOWN")).toBe("backoff");
  });

  test("retryDelay: never=null; server_directed only uses server advice; backoff falls back", () => {
    expect(retryDelayFor("never", 1, 5000)).toBeNull();
    expect(retryDelayFor("server_directed", 1, 5000)).toBe(5000);
    expect(retryDelayFor("server_directed", 1, undefined)).toBeNull();
    expect(retryDelayFor("backoff", 2, undefined)).toBeGreaterThan(0);
    expect(retryDelayFor("fall_back_to_http", 1, 3000)).toBe(3000);
  });

  test("backoff is monotonically increasing and capped", () => {
    const d1 = retryDelayFor("backoff", 1, undefined)!;
    const d2 = retryDelayFor("backoff", 2, undefined)!;
    const d10 = retryDelayFor("backoff", 10, undefined)!;
    expect(d2).toBeGreaterThan(d1);
    expect(d10).toBeLessThanOrEqual(20_000);
  });

  test("all four variants are representable", () => {
    const variants: RetryPolicy[] = ["never", "server_directed", "backoff", "fall_back_to_http"];
    expect(variants).toHaveLength(4);
  });
});
