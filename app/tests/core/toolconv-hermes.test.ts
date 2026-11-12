import { describe, expect, test } from "bun:test";
import { parseHermesToolCalls } from "../../src/core/providers/toolconv/hermes";

describe("hermes toolconv", () => {
  test("parses one nested-arguments block", () => {
    const text = `Here
<tool_call>
{"name": "read", "arguments": {"path": "a.txt"}}
</tool_call>
done`;
    const { calls, errors } = parseHermesToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);
  });

  test("tolerates stringified arguments", () => {
    const text = `<tool_call>{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}</tool_call>`;
    const { calls, errors } = parseHermesToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);
  });

  test("bad JSON does not yield a call", () => {
    const text = `<tool_call>{"name": "read", "arguments": {</tool_call>`;
    const { calls, errors } = parseHermesToolCalls(text, new Set(["read"]));
    expect(calls).toEqual([]);
    expect(errors.some((e) => e.includes("not valid JSON"))).toBe(true);
  });

  test("unknown tool is an error, not a call", () => {
    const text = `<tool_call>{"name":"evil","arguments":{}}</tool_call>`;
    const { calls, errors } = parseHermesToolCalls(text, new Set(["read"]));
    expect(calls).toEqual([]);
    expect(errors.some((e) => e.includes("unknown"))).toBe(true);
  });
});
