/**
 * cancel-safe-line-reader.test.ts — Tier 3 grok line_reader ADAPT.
 * Pure framing: feed chunks, emit ONLY complete newline-delimited lines,
 * refuse oversized lines. The caller owns stdin/socket cancellation.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_NDJSON_LINE_BYTES,
  createLineFramer,
  type LineFramer,
} from "../../src/core/cancel-safe-line-reader";

describe("cancel-safe line framer (grok port)", () => {
  test("emits only complete lines regardless of chunk boundaries", () => {
    let f: LineFramer = createLineFramer();
    expect(f.feed("he")).toEqual([]);
    expect(f.feed("llo\nwor")).toEqual(["hello"]);
    expect(f.feed("ld\n")).toEqual(["world"]);
    expect(f.finish()).toEqual([]);
  });

  test("a trailing partial line is retained, never emitted early (cancel-safe)", () => {
    let f: LineFramer = createLineFramer();
    expect(f.feed("partial-no-newline")).toEqual([]);
    expect(f.buffered).toBe("partial-no-newline");
  });

  test("CRLF is handled", () => {
    let f: LineFramer = createLineFramer();
    expect(f.feed("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  test("oversized line is a typed refusal", () => {
    let f: LineFramer = createLineFramer();
    expect(() => f.feed("x".repeat(MAX_NDJSON_LINE_BYTES + 1))).toThrow(/line.*large|too large/i);
  });

  test("empty lines are skipped", () => {
    let f: LineFramer = createLineFramer();
    expect(f.feed("\n\na\n\n")).toEqual(["a"]);
  });
});
