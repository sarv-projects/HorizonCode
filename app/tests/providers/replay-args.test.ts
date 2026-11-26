/**
 * replay-args.test.ts — port of oh-my-pi replayableToolCallArguments (must-steal #12).
 * Replay carries what ACTUALLY EXECUTED, with a bounded parse-error diagnostic.
 */
import { describe, expect, test } from "bun:test";
import {
  boundRawToolArguments,
  INVALID_ARGUMENTS_RAW_LIMIT,
  invalidToolCallArguments,
  replayableToolCallArguments,
} from "../../src/core/providers/replay-args";

describe("replayable tool-call arguments (oh-my-pi port)", () => {
  test("valid raw JSON is replayed byte-for-byte", () => {
    expect(replayableToolCallArguments('{"a":1}', { a: 1 })).toBe('{"a":1}');
  });

  test("repaired JSON replays the EXECUTED args, not the diagnostic", () => {
    const raw = '{"path":"a.txt",}'; // trailing comma: repaired by the tool layer
    const executed = { path: "a.txt" };
    expect(replayableToolCallArguments(raw, executed)).toBe(JSON.stringify(executed));
    expect(replayableToolCallArguments(raw, executed)).not.toContain("__parseError");
  });

  test("an unrepairable parse returns the raw text (no fabricated replay)", () => {
    const raw = "{not json";
    const diagnostic = invalidToolCallArguments(raw, new Error("bad json"));
    expect(replayableToolCallArguments(raw, diagnostic)).toBe(raw);
  });

  test("parse-error diagnostic bounds raw text to 512 chars and is idempotent", () => {
    const diag = invalidToolCallArguments("x".repeat(1000), new Error("boom"));
    expect((diag.__rawJson as string).length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT + 40);
    expect(String(diag.__parseError)).toContain("boom");
    expect(boundRawToolArguments(diag.__rawJson as string)).toBe(diag.__rawJson);
  });
});
