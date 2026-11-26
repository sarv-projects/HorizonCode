/**
 * compaction-breaker.test.ts — repeated-compaction failure breaker
 * (Claude Code 3-failure compaction breaker ADAPT). Pure, hermetic.
 */
import { describe, expect, test } from "bun:test";
import {
  CompactionBreaker,
  type CompactionBreakerOptions,
} from "../../src/core/compaction-breaker";

describe("compaction failure breaker", () => {
  test("allows attempts up to the threshold, then refuses", () => {
    const b = new CompactionBreaker({ threshold: 3 } as CompactionBreakerOptions);
    expect(b.allowAttempt().allowed).toBe(true);
    b.recordFailure("summarizer timeout");
    expect(b.allowAttempt().allowed).toBe(true);
    b.recordFailure("token fit");
    expect(b.allowAttempt().allowed).toBe(true);
    b.recordFailure("hold swap");
    const refused = b.allowAttempt();
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toMatch(/breaker|threshold|tripp/i);
  });

  test("a success resets the failure streak", () => {
    const b = new CompactionBreaker({ threshold: 2 });
    b.recordFailure("a");
    b.recordSuccess();
    b.recordFailure("b");
    expect(b.allowAttempt().allowed).toBe(true); // streak was reset
  });

  test("reasons are bounded and counted", () => {
    const b = new CompactionBreaker({ threshold: 5, reasonLimit: 2 });
    for (let i = 0; i < 6; i += 1) b.recordFailure(`reason-${i}`);
    expect(b.reasons().length).toBeLessThanOrEqual(2);
    expect(b.failureCount()).toBe(6);
  });

  test("reset clears state", () => {
    const b = new CompactionBreaker({ threshold: 1 });
    b.recordFailure("x");
    expect(b.allowAttempt().allowed).toBe(false);
    b.reset();
    expect(b.allowAttempt().allowed).toBe(true);
    expect(b.failureCount()).toBe(0);
  });
});
