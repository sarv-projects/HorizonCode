import { describe, expect, test } from "bun:test";
import { anthropicToolArguments, anthropicToolInput } from "../../src/core/providers/anthropic-tool-args";

describe("anthropicToolInput", () => {
  test("parses a plain object JSON string", () => {
    expect(anthropicToolInput('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  test("trims surrounding whitespace before parse", () => {
    expect(anthropicToolInput('  {"n":1}  ')).toEqual({ n: 1 });
  });

  test("empty or non-string raw yields {}", () => {
    expect(anthropicToolInput("")).toEqual({});
    expect(anthropicToolInput("   ")).toEqual({});
    expect(anthropicToolInput(null)).toEqual({});
    expect(anthropicToolInput(undefined)).toEqual({});
    expect(anthropicToolInput({ path: "x" })).toEqual({});
  });

  test("invalid JSON fails closed to {}", () => {
    expect(anthropicToolInput("not json")).toEqual({});
    expect(anthropicToolInput("{")).toEqual({});
  });

  test("preserves parsed non-object JSON (arrays / primitives)", () => {
    expect(anthropicToolInput("[1,2]")).toEqual([1, 2]);
    expect(anthropicToolInput('"just a string"')).toBe("just a string");
    expect(anthropicToolInput("42")).toBe(42);
  });
});

describe("anthropicToolArguments", () => {
  test("prefers non-empty streamed raw over declared", () => {
    expect(anthropicToolArguments('{"q":"streamed"}', { q: "declared" })).toBe('{"q":"streamed"}');
  });

  test("falls back to declared object when stream is empty / whitespace", () => {
    expect(anthropicToolArguments("", { path: "a.ts" })).toBe('{"path":"a.ts"}');
    expect(anthropicToolArguments("   ", { n: 1 })).toBe('{"n":1}');
  });

  test("empty stream with empty / non-object declared yields {}", () => {
    expect(anthropicToolArguments("", {})).toBe("{}");
    expect(anthropicToolArguments("", null)).toBe("{}");
    expect(anthropicToolArguments("", undefined)).toBe("{}");
    expect(anthropicToolArguments("", "nope")).toBe("{}");
    expect(anthropicToolArguments("", 42)).toBe("{}");
  });

  test("whitespace-only stream with empty declared still yields {}", () => {
    expect(anthropicToolArguments("  \t  ", {})).toBe("{}");
  });
});
