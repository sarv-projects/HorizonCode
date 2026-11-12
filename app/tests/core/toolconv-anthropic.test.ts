import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseAnthropicToolCalls } from "../../src/core/providers/toolconv/anthropic";
import { wrapAnthropicToolProvider } from "../../src/core/providers/toolconv/wrap-anthropic";

const TOOLS: ToolSpec[] = [
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } },
];

describe("anthropic toolconv", () => {
  test("parses function_calls envelope", () => {
    const text = `<function_calls>
<invoke name="get_weather">
<parameter name="location">San Francisco</parameter>
<parameter name="unit">celsius</parameter>
</invoke>
</function_calls>`;
    const { calls, errors } = parseAnthropicToolCalls(text, new Set(["get_weather"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      { name: "get_weather", args: { location: "San Francisco", unit: "celsius" } },
    ]);
  });

  test("tolerates antml: prefix", () => {
    const text =
      `<antml:function_calls><antml:invoke name="get_weather"><antml:parameter name="location">Tokyo</antml:parameter></antml:invoke></antml:function_calls>`;
    const { calls } = parseAnthropicToolCalls(text, new Set(["get_weather"]));
    expect(calls).toEqual([{ name: "get_weather", args: { location: "Tokyo" } }]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      `<function_calls><invoke name="get_weather"><parameter name="location">Oslo</parameter></invoke></function_calls>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapAnthropicToolProvider(inner).stream({
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
    expect(tools[0]).toMatchObject({
      name: "get_weather",
      arguments: '{"location":"Oslo"}',
    });
  });
});
