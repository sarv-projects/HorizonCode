/**
 * effect-evidence-stream.test.ts — D-5: a stability check needs a SECOND observation.
 *
 * The old helper hashed the same buffer twice and compared the results, so
 * observationStable could never be false. That is not an observation, it is a
 * restatement of one hash. The helper now reports whether a second, independent
 * observation was actually supplied (doubleObserved) and compares against it;
 * with a single capture it says so instead of pretending to have verified it.
 */

import { describe, expect, test } from "bun:test";
import {
  observeCapturedShellStreamDigest,
  shellExecResultDigestStable,
} from "../../src/core/effect-evidence";

describe("captured shell stream observation", () => {
  test("a single capture reports one observation and a digest", () => {
    const obs = observeCapturedShellStreamDigest(Buffer.from("hello\n", "utf8"));
    expect(obs.digest).toBeDefined();
    expect(obs.doubleObserved).toBe(false);
  });

  test("a second identical capture is a genuine agreement", () => {
    const a = Buffer.from("hello\n", "utf8");
    const b = Buffer.from("hello\n", "utf8");
    const obs = observeCapturedShellStreamDigest(a, b);
    expect(obs.doubleObserved).toBe(true);
    expect(obs.observationStable).toBe(true);
    expect(obs.digest).toBeDefined();
  });

  test("a second capture that differs is refused, not averaged", () => {
    const obs = observeCapturedShellStreamDigest(
      Buffer.from("hello\n", "utf8"),
      Buffer.from("HELLO\n", "utf8"),
    );
    expect(obs.doubleObserved).toBe(true);
    expect(obs.observationStable).toBe(false);
    expect(obs.digest).toBeUndefined();
    expect(obs.confirmDigest).toBeDefined();
  });

  test("shellExecResultDigestStable requires a digest on both streams", () => {
    const ok = observeCapturedShellStreamDigest(Buffer.from("a"), Buffer.from("a"));
    const bad = observeCapturedShellStreamDigest(Buffer.from("a"), Buffer.from("b"));
    expect(shellExecResultDigestStable(ok, ok)).toBe(true);
    expect(shellExecResultDigestStable(ok, bad)).toBe(false);
  });
});
