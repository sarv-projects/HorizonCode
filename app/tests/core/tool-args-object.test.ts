import { describe, expect, test } from "bun:test";
import { toolArgsObject } from "../../src/core/providers/tool-args-object";

describe("toolArgsObject", () => {
  test("parses a plain object JSON string", () => {
    expect(toolArgsObject('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  test("trims surrounding whitespace before parse", () => {
    expect(toolArgsObject('  {"n":1}  ')).toEqual({ n: 1 });
  });

  test("empty or non-string raw yields {}", () => {
    expect(toolArgsObject("")).toEqual({});
    expect(toolArgsObject("   ")).toEqual({});
    expect(toolArgsObject(null)).toEqual({});
    expect(toolArgsObject(undefined)).toEqual({});
    expect(toolArgsObject({ path: "x" })).toEqual({});
  });

  test("arrays, primitives, and invalid JSON fail closed to {}", () => {
    expect(toolArgsObject("[1,2]")).toEqual({});
    expect(toolArgsObject('"just a string"')).toEqual({});
    expect(toolArgsObject("42")).toEqual({});
    expect(toolArgsObject("not json")).toEqual({});
    expect(toolArgsObject("{")).toEqual({});
  });
});
