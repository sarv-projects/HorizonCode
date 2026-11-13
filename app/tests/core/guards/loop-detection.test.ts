/**
 * loop-detection.test.ts — SAFETY-RAILS rail 1 (tiered identical-step detection).
 */

import { describe, expect, test } from "bun:test";
import {
  LoopDetectionTracker,
  MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS,
  MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
  NUDGE_AFTER_IDENTICAL_PROBLEMATIC_TOOL_CALLS,
  NUDGE_AFTER_IDENTICAL_TOOL_CALLS,
  sortKeys,
  stepIsProblematicallyRepeating,
  stepSignature,
  toolCallSignature,
} from "../../../src/core/guards/loop-detection";

describe("toolCallSignature canonicalization", () => {
  test("key order does not change the signature", () => {
    const a = toolCallSignature({ path: "x", mode: "r", nested: { b: 1, a: 2 } });
    const b = toolCallSignature({ nested: { a: 2, b: 1 }, mode: "r", path: "x" });
    expect(a).toBe(b);
  });

  test("null, strings and non-objects fall back deterministically", () => {
    expect(toolCallSignature(null)).toBe("null");
    expect(toolCallSignature(undefined)).toBe("null");
    expect(toolCallSignature("plain")).toBe("plain");
    expect(toolCallSignature(42)).toBe("42");
    expect(toolCallSignature(true)).toBe("true");
  });

  test("a non-serializable input falls back to String(input)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toolCallSignature(cyclic)).toBe(String(cyclic));
  });

  test("sortKeys recurses into arrays and objects without reordering arrays", () => {
    expect(sortKeys([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
    expect(JSON.stringify(sortKeys({ z: 1, a: 2 }))).toBe('{"a":2,"z":1}');
  });
});

describe("step signature", () => {
  test("parallel call order does not change the step signature", () => {
    const a = [{ name: "read", input: { path: "a" } }, { name: "grep", input: { pattern: "x" } }];
    const b = [{ name: "grep", input: { pattern: "x" } }, { name: "read", input: { path: "a" } }];
    expect(stepSignature(a)).toBe(stepSignature(b));
  });

  test("mixed problematic and exec tools use the loose tier", () => {
    expect(
      stepIsProblematicallyRepeating([
        { name: "read", input: {} },
        { name: "shell", input: { command: "true" } },
      ]),
    ).toBe(false);
    expect(stepIsProblematicallyRepeating([{ name: "read", input: {} }, { name: "grep", input: {} }])).toBe(true);
  });
});

describe("LoopDetectionTracker — tight tier (read)", () => {
  test("soft nudge at the 4th identical step", () => {
    const tracker = new LoopDetectionTracker();
    const step = [{ name: "read", input: { path: "a.txt" } }];
    for (let i = 0; i < NUDGE_AFTER_IDENTICAL_PROBLEMATIC_TOOL_CALLS - 1; i += 1) {
      expect(tracker.inspectStep(step).kind).toBe("ok");
    }
    const nudge = tracker.inspectStep(step);
    expect(nudge.kind).toBe("soft");
    expect(nudge.message).toContain("4 consecutive identical");
  });

  test("hard stop at the 8th identical step", () => {
    const tracker = new LoopDetectionTracker();
    const step = [{ name: "grep", input: { pattern: "x" } }];
    for (let i = 0; i < MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS - 1; i += 1) {
      tracker.inspectStep(step);
    }
    const stop = tracker.inspectStep(step);
    expect(stop.kind).toBe("hard");
    expect(stop.message).toContain("stopping to avoid a loop");
  });
});

describe("LoopDetectionTracker — default tier (shell)", () => {
  test("soft nudge at the 8th identical step", () => {
    const tracker = new LoopDetectionTracker();
    const step = [{ name: "shell", input: { command: "true" } }];
    for (let i = 0; i < NUDGE_AFTER_IDENTICAL_TOOL_CALLS - 1; i += 1) {
      expect(tracker.inspectStep(step).kind).toBe("ok");
    }
    expect(tracker.inspectStep(step).kind).toBe("soft");
  });

  test("hard stop at the 12th identical step", () => {
    const tracker = new LoopDetectionTracker();
    const step = [{ name: "write", input: { path: "x", content: "y" } }];
    for (let i = 0; i < MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS - 1; i += 1) {
      tracker.inspectStep(step);
    }
    expect(tracker.inspectStep(step).kind).toBe("hard");
  });

  test("a different step resets the streak", () => {
    const tracker = new LoopDetectionTracker();
    const a = [{ name: "shell", input: { command: "ls" } }];
    tracker.inspectStep(a);
    tracker.inspectStep(a);
    expect(tracker.inspectStep([{ name: "shell", input: { command: "pwd" } }]).kind).toBe("ok");
  });

  test("reset() clears the streak", () => {
    const tracker = new LoopDetectionTracker();
    const step = [{ name: "read", input: { path: "a.txt" } }];
    tracker.inspectStep(step);
    tracker.inspectStep(step);
    tracker.reset();
    expect(tracker.inspectStep(step).kind).toBe("ok");
  });
});
