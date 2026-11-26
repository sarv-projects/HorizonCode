/**
 * clock-in-out.test.ts — Group A clock-in/out initializer-first phase
 * (learn-harness-engineering ADAPT). Pure deterministic checklist tracker.
 */
import { describe, expect, test } from "bun:test";
import {
  CLOCK_IN_STEPS,
  CLOCK_OUT_STEPS,
  createClockState,
  stepClock,
  clockReport,
} from "../../src/core/clock-in-out";

describe("clock-in/out checklist (harness engineering port)", () => {
  test("startup and exit phases are fixed and ordered", () => {
    expect(CLOCK_IN_STEPS).toEqual(["pwd", "progress", "featureList", "gitLog", "initScript", "baselineSmoke"]);
    expect(CLOCK_OUT_STEPS[0]).toBe("cleanupScan");
  });

  test("steps advance only when performed in order; duplicates are rejected", () => {
    let s = createClockState("in");
    s = stepClock(s, "pwd");
    expect(s.done).toEqual(["pwd"]);
    expect(stepClock(s, "featureList").done).toEqual(["pwd"]); // out of order
    expect(stepClock(s, "pwd").done).toEqual(["pwd"]); // duplicate
  });

  test("a phase completes when all steps are done; report is honest", () => {
    let s = createClockState("in");
    for (const step of CLOCK_IN_STEPS) s = stepClock(s, step);
    expect(clockReport(s).complete).toBe(true);
    expect(clockReport(s).remaining).toEqual([]);
    expect(clockReport(s).phase).toBe("in");
  });

  test("a partial phase reports remaining steps", () => {
    const s = stepClock(createClockState("out"), "cleanupScan");
    const r = clockReport(s);
    expect(r.complete).toBe(false);
    expect(r.remaining).toContain("finalVerify");
  });
});
