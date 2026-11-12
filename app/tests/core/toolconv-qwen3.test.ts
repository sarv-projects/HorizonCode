import { describe, expect, test } from "bun:test";
import { parseQwen3ToolCalls, renderQwen3ToolInstructions } from "../../src/core/providers/toolconv/qwen3";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { wrapQwen3ToolProvider } from "../../src/core/providers/toolconv/wrap-qwen3";

const TOOLS: ToolSpec[] = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];

describe("qwen3 toolconv", () => {
  test("parses hermes-shaped call blocks", () => {
    const text = `<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>`;
    const { calls, errors } = parseQwen3ToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);
  });

  test("prompt uses Qwen # Tools wrapper without FunctionCall schema", () => {
    const prompt = renderQwen3ToolInstructions(TOOLS);
    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("<tools>");
    expect(prompt).not.toContain("FunctionCall");
    expect(prompt).toContain('"name":"read"');
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block = `<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapQwen3ToolProvider(inner).stream({
      model: "m",
      system: "",
      messages: [],
      tools: TOOLS,
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }
    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "read", arguments: '{"path":"a.txt"}' });
  });
});
