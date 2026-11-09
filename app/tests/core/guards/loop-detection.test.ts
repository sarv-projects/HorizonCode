/**
 * loop-detection.test.ts — SAFETY-RAILS rail 1 (identical-tool-call detection).
 *
 * Signature canonicalization (key-order independence, string/null/non-serializable
 * fallbacks), the soft warning at exactly 3, the hard escalation at >= 5, and a
 * reset when a different call breaks the streak. Every assertion fails if the
 * rail is reverted (no module, no thresholds, no exact messages).
 */

import { describe, expect, test } from "bun:test";
import {
  LoopDetectionTracker,
  sortKeys,
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
    // JSON.stringify would throw on the cycle; the rail must not.
    expect(toolCallSignature(cyclic)).toBe(String(cyclic));
  });

  test("sortKeys recurses into arrays and objects without reordering arrays", () => {
    expect(sortKeys([{ b: 1, a: 2 }])).toEqual([{ a: 2, b: 1 }]);
    expect(JSON.stringify(sortKeys({ z: 1, a: 2 }))).toBe('{"a":2,"z":1}');
  });
});

describe("LoopDetectionTracker thresholds", () => {
  test("the soft warning fires at exactly the 3rd identical call and not before", () => {
    const tracker = new LoopDetectionTracker();
    const call = { name: "read", input: { path: "a.txt" } };
    expect(tracker.inspect(call).kind).toBe("ok");
    expect(tracker.inspect(call).kind).toBe("ok");
    const third = tracker.inspect(call);
    expect(third.kind).toBe("soft");
    expect(third.message).toBe("Detected 3 consecutive identical calls to `read`; consider trying a different approach.");
  });

  test("the hard escalation fires at the 5th identical call with the exact message", () => {
    const tracker = new LoopDetectionTracker();
    const call = { name: "grep", input: { pattern: "x" } };
    for (let i = 0; i < 4; i += 1) tracker.inspect(call);
    const fifth = tracker.inspect(call);
    expect(fifth.kind).toBe("hard");
    expect(fifth.message).toBe("Detected 5 consecutive identical calls to `grep`; stopping to avoid a loop.");
  });

  test("a different call name or argument resets the streak", () => {
    const tracker = new LoopDetectionTracker();
    const a = { name: "read", input: { path: "a.txt" } };
    tracker.inspect(a);
    tracker.inspect(a);
    // Different arguments break the streak back to 1.
    expect(tracker.inspect({ name: "read", input: { path: "b.txt" } }).kind).toBe("ok");
    expect(tracker.inspect({ name: "read", input: { path: "b.txt" } }).kind).toBe("ok");
    // The 3rd identical call to the NEW target is the soft point, proving reset.
    expect(tracker.inspect({ name: "read", input: { path: "b.txt" } }).kind).toBe("soft");
  });

  test("reset() clears the streak", () => {
    const tracker = new LoopDetectionTracker();
    const call = { name: "read", input: { path: "a.txt" } };
    tracker.inspect(call);
    tracker.inspect(call);
    tracker.reset();
    expect(tracker.inspect(call).kind).toBe("ok");
  });
});
