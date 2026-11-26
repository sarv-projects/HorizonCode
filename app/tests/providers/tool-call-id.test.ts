/**
 * tool-call-id.test.ts -- descriptor-driven tool-call id normalization
 * (plan Task 7). Pure opt-in seam; existing adapter wire bytes unchanged.
 */
import { describe, expect, test } from "bun:test";
import { normalizeToolCallId, toolIdReplayMap } from "../../src/core/providers/tool-call-id";

const RULE = { vendor: "groq", maxLength: 40, allowed: /^[A-Za-z0-9_-]+$/, prefix: "call_" };

describe("tool-call id normalization", () => {
  test("normalizes deterministically with a stable replay map", () => {
    const raw = `call_${"x".repeat(60)}!`;
    const out = normalizeToolCallId(raw, RULE);
    expect(out.changed).toBe(true);
    expect(out.id.length).toBeLessThanOrEqual(RULE.maxLength);
    expect(RULE.allowed.test(out.id)).toBe(true);
    expect(toolIdReplayMap([raw], RULE).get(raw)).toBe(out.id);
    expect(normalizeToolCallId(raw, RULE).id).toBe(out.id);
  });

  test("distinct long ids do not collide after truncation", () => {
    const a = normalizeToolCallId(`call_${"a".repeat(60)}`, RULE).id;
    const b = normalizeToolCallId(`call_${"b".repeat(60)}`, RULE).id;
    expect(a).not.toBe(b);
  });

  test("an already-valid id is unchanged", () => {
    expect(normalizeToolCallId("call_abc123", RULE)).toEqual({ id: "call_abc123", changed: false });
  });

  test("no usable characters is a typed refusal, never a generated id", () => {
    const refused = normalizeToolCallId("!!!!", RULE);
    expect(refused.id).toBe("");
    expect(refused.refusal).toMatch(/tool id/i);
  });
});

// V-15 wiring helper: normalize emitted tool-call ids without touching text.
test("normalizeToolCallEvents maps ids and refuses unusable ones as notices", async () => {
  const { normalizeToolCallEvents } = await import("../../src/core/providers/tool-call-id");
  const events = [
    { type: "text", text: "hello" },
    { type: "tool_call", id: "call_" + "a".repeat(60), name: "read", arguments: "{}" },
    { type: "tool_call", id: "!!!!", name: "read", arguments: "{}" },
    { type: "done", stopReason: "tool_use" },
  ];
  const out = normalizeToolCallEvents(events, RULE);
  const calls = out.filter((e) => e.type === "tool_call");
  expect(calls).toHaveLength(1);
  expect(calls[0].id.length).toBeLessThanOrEqual(RULE.maxLength);
  expect(out.some((e) => e.type === "notice" && /tool id/.test(e.message))).toBe(true);
  expect(out.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "hello" }]);
});
