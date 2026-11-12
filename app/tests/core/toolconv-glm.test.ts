import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseGlmToolCalls } from "../../src/core/providers/toolconv/glm";
import { wrapGlmToolProvider } from "../../src/core/providers/toolconv/wrap-glm";

const TOOLS: ToolSpec[] = [
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } },
];

describe("glm toolconv", () => {
  test("parses name-on-open-tag with arg_key/arg_value", () => {
    const text = `<tool_call>get_weather
<arg_key>city</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>`;
    const { calls, errors } = parseGlmToolCalls(text, new Set(["get_weather"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "get_weather", args: { city: "Beijing", unit: "celsius" } }]);
  });

  test("parses JSON literal arg values", () => {
    const text = `<tool_call>get_weather
<arg_key>count</arg_key>
<arg_value>3</arg_value>
<arg_key>ok</arg_key>
<arg_value>true</arg_value>
</tool_call>`;
    const { calls } = parseGlmToolCalls(text, new Set(["get_weather"]));
    expect(calls[0]?.args).toEqual({ count: 3, ok: true });
  });

  test("zero-arg call", () => {
    const text = `<tool_call>get_weather
</tool_call>`;
    const { calls, errors } = parseGlmToolCalls(text, new Set(["get_weather"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "get_weather", args: {} }]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block = `<tool_call>get_weather
<arg_key>city</arg_key>
<arg_value>Beijing</arg_value>
</tool_call>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapGlmToolProvider(inner).stream({
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
    expect(tools[0]).toMatchObject({ name: "get_weather", arguments: '{"city":"Beijing"}' });
  });
});
