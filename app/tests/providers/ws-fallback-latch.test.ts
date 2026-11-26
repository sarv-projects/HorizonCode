/**
 * ws-fallback-latch.test.ts -- per-route WS→HTTP fallback latch (plan Task 2).
 * Process-local advisory state; never a security boundary.
 */
import { describe, expect, test } from "bun:test";
import { createWsFallbackLatch } from "../../src/core/providers/ws-fallback-latch";

describe("WS fallback latch", () => {
  test("opens after threshold, half-opens after cooldown, closes on success", () => {
    let now = 0;
    const latch = createWsFallbackLatch({ threshold: 2, now: () => now, cooldownMs: 1000 });
    const token = "route-a";
    expect(latch.shouldAttemptWs(token)).toBe(true);
    latch.recordFailure(token, "socket error");
    latch.recordFailure(token, "timeout");
    expect(latch.state(token)).toBe("open");
    expect(latch.shouldAttemptWs(token)).toBe(false);
    now = 1001;
    expect(latch.state(token)).toBe("half_open");
    expect(latch.shouldAttemptWs(token)).toBe(true);
    latch.recordSuccess(token);
    expect(latch.state(token)).toBe("closed");
    expect(latch.failures(token)).toBe(0);
  });

  test("half-open failure reopens with a fresh deadline and reasons stay bounded", () => {
    let now = 0;
    const latch = createWsFallbackLatch({ threshold: 1, now: () => now, cooldownMs: 100 });
    latch.recordFailure("r", "first");
    expect(latch.shouldAttemptWs("r")).toBe(false);
    now = 101;
    expect(latch.shouldAttemptWs("r")).toBe(true);
    latch.recordFailure("r", "again");
    expect(latch.state("r")).toBe("open");
    expect(latch.shouldAttemptWs("r")).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      now += 200;
      latch.shouldAttemptWs("r");
      latch.recordFailure("r", `reason-${i}`);
    }
    expect(latch.state("r")).toBe("open");
    expect(latch.reasons("r").length).toBeLessThanOrEqual(8);
  });

  test("routes are isolated", () => {
    const latch = createWsFallbackLatch({ threshold: 1 });
    latch.recordFailure("a", "bad");
    expect(latch.shouldAttemptWs("a")).toBe(false);
    expect(latch.shouldAttemptWs("b")).toBe(true);
  });
});
