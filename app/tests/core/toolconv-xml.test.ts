import { describe, expect, test } from "bun:test";
import { parseForgeXmlToolCalls } from "../../src/core/providers/toolconv/xml";

describe("forge xml toolconv", () => {
  test("parses one block", () => {
    const text = `Here <forge_tool_call><tool_name>read</tool_name><arguments>{"path":"a.txt"}</arguments></forge_tool_call> done`;
    const { calls, errors } = parseForgeXmlToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);
  });

  test("bad JSON does not yield a call", () => {
    const text = `<forge_tool_call><tool_name>read</tool_name><arguments>{"path":</arguments></forge_tool_call>`;
    const { calls, errors } = parseForgeXmlToolCalls(text, new Set(["read"]));
    expect(calls).toEqual([]);
    expect(errors.some((e) => e.includes("not valid JSON"))).toBe(true);
  });
});
