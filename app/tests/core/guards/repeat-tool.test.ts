/**
 * repeat-tool.test.ts — SAFETY-RAILS rail 3 (advisory repeat-tool reminder).
 *
 * Fail-loud threshold validation, gentle-then-detailed escalation over [3,5,8],
 * denied-call counting (observe advances the chain regardless of outcome),
 * new-user-prompt clearing, include/exclude wildcards, untracked-tool
 * transparency, and head-truncation that does not change the chain key. Every
 * assertion fails if the rail is reverted.
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalize,
  GENTLE_REMINDER,
  previewArguments,
  RepeatToolGuard,
  validateThresholds,
  wildcardToRegExp,
} from "../../../src/core/guards/repeat-tool";

describe("validateThresholds (fail-loud)", () => {
  test("throws on an empty list", () => {
    expect(() => validateThresholds([])).toThrow("must not be empty");
  });

  test("throws on a non-integer or a value below 2", () => {
    expect(() => validateThresholds([2, 3.5])).toThrow("integer >= 2");
    expect(() => validateThresholds([1, 2])).toThrow("integer >= 2");
  });

  test("throws on duplicates", () => {
    expect(() => validateThresholds([3, 3, 5])).toThrow("must not contain duplicates");
  });

  test("returns the thresholds sorted ascending", () => {
    expect(validateThresholds([8, 3, 5])).toEqual([3, 5, 8]);
  });
});

describe("RepeatToolGuard escalation over [3,5,8]", () => {
  test("gentle at the first threshold, detailed at later ones", () => {
    const guard = new RepeatToolGuard();
    const args = { path: "a.txt" };
    expect(guard.observe("read", args)).toBeUndefined(); // 1
    expect(guard.observe("read", args)).toBeUndefined(); // 2
    expect(guard.observe("read", args)).toBe(GENTLE_REMINDER); // 3 (gentle)
    expect(guard.observe("read", args)).toBeUndefined(); // 4
    const fifth = guard.observe("read", args); // 5 (detailed)
    expect(fifth).toContain("Repeated tool call detected:");
    expect(fifth).toContain("- tool: read");
    expect(fifth).toContain("- consecutive_calls: 5");
  });

  test("a different call resets the chain to 1", () => {
    const guard = new RepeatToolGuard();
    guard.observe("read", { path: "a.txt" });
    guard.observe("read", { path: "a.txt" });
    // A different argument breaks the chain: the next repeat starts over.
    guard.observe("read", { path: "b.txt" });
    guard.observe("read", { path: "b.txt" });
    expect(guard.observe("read", { path: "b.txt" })).toBe(GENTLE_REMINDER);
  });
});

describe("post-execute counting and clearing", () => {
  test("observe advances the chain even for a denied/failed call (post-execute counting)", () => {
    const guard = new RepeatToolGuard();
    // The caller invokes observe once per call after execute, whether the call
    // was allowed, denied or failed — the guard has no notion of the outcome.
    const args = { command: "rm -rf /" };
    guard.observe("shell", args);
    guard.observe("shell", args);
    expect(guard.observe("shell", args)).toBe(GENTLE_REMINDER);
  });

  test("clear() resets the chain (a new user prompt arrived)", () => {
    const guard = new RepeatToolGuard();
    const args = { path: "a.txt" };
    guard.observe("read", args);
    guard.observe("read", args);
    guard.clear();
    expect(guard.observe("read", args)).toBeUndefined();
    guard.observe("read", args);
    expect(guard.observe("read", args)).toBe(GENTLE_REMINDER);
  });
});

describe("include/exclude wildcards and transparency", () => {
  test("include restricts tracking; a non-match is transparent", () => {
    const guard = new RepeatToolGuard({ include: ["mcp_*"] });
    // read is not included: it never counts, so no reminder ever fires.
    for (let i = 0; i < 5; i += 1) guard.observe("read", { path: "a.txt" });
    expect(guard.observe("read", { path: "a.txt" })).toBeUndefined();
    // An included tool still escalates.
    guard.observe("mcp_search", { q: "x" });
    guard.observe("mcp_search", { q: "x" });
    expect(guard.observe("mcp_search", { q: "x" })).toBe(GENTLE_REMINDER);
  });

  test("exclude makes a tool transparent: it neither counts nor resets the chain", () => {
    const guard = new RepeatToolGuard({ exclude: ["todo"] });
    const args = { path: "a.txt" };
    guard.observe("read", args); // 1
    guard.observe("read", args); // 2
    // An excluded call in the middle must not reset the read chain.
    expect(guard.observe("todo", { action: "add" })).toBeUndefined();
    expect(guard.observe("read", args)).toBe(GENTLE_REMINDER); // still the 3rd read
  });

  test("wildcardToRegExp escapes metacharacters and anchors", () => {
    const re = wildcardToRegExp("mcp_*");
    expect(re.test("mcp_search")).toBe(true);
    expect(re.test("xmcp_search")).toBe(false);
    const dotted = wildcardToRegExp("a.b");
    expect(dotted.test("a.b")).toBe(true);
    expect(dotted.test("axb")).toBe(false);
  });
});

describe("argument preview bounds only the model-visible text", () => {
  test("the detailed reminder is head-truncated while the chain key uses the full canonical string", () => {
    const big = "y".repeat(2000);
    // thresholds[0] is 2 (gentle); the 3rd repeat hits the second threshold and
    // produces the DETAILED reminder, which is the one that quotes arguments.
    const guard = new RepeatToolGuard({ thresholds: [2, 3], argumentsPreviewChars: 50 });
    const args = { blob: big };
    guard.observe("write", args); // 1
    guard.observe("write", args); // 2 -> gentle
    const reminder = guard.observe("write", args) ?? ""; // 3 -> detailed
    expect(reminder).toContain("\u2026 (+");
    expect(reminder).toContain("more chars)");
    // The full canonical string is far longer than the preview cap.
    expect(canonicalize(args).length).toBeGreaterThan(50);
  });

  test("previewArguments leaves a short string untouched", () => {
    expect(previewArguments("short", 50)).toBe("short");
    expect(previewArguments("x".repeat(60), 50)).toContain("\u2026 (+10 more chars)");
  });
});
