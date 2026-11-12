import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { decodePythonLiteral, parseGeminiToolCalls } from "../../src/core/providers/toolconv/gemini";
import { wrapGeminiToolProvider } from "../../src/core/providers/toolconv/wrap-gemini";

const TOOLS: ToolSpec[] = [
  {
    name: "get_current_temperature",
    description: "temp",
    parameters: { type: "object", properties: {} },
  },
];

describe("gemini toolconv", () => {
  test("decodes Python literals", () => {
    expect(decodePythonLiteral("True")).toBe(true);
    expect(decodePythonLiteral("None")).toBeNull();
    expect(decodePythonLiteral("'London'")).toBe("London");
    expect(decodePythonLiteral("3.14")).toBe(3.14);
  });

  test("parses print(default_api.NAME(...)) fence", () => {
    const text = "```tool_code\nprint(default_api.get_current_temperature(location=\"London\", unit=\"celsius\"))\n```";
    const { calls, errors } = parseGeminiToolCalls(text, new Set(["get_current_temperature"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      { name: "get_current_temperature", args: { location: "London", unit: "celsius" } },
    ]);
  });

  test("parses bare and single-quoted forms", () => {
    const text = "```tool_code\nget_current_temperature(location='Paris')\n```";
    const { calls } = parseGeminiToolCalls(text, new Set(["get_current_temperature"]));
    expect(calls).toEqual([{ name: "get_current_temperature", args: { location: "Paris" } }]);
  });

  test("partial fence yields nothing", () => {
    const text = "```tool_code\nprint(default_api.get_current_temperature(location=";
    expect(parseGeminiToolCalls(text, new Set(["get_current_temperature"])).calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      "```tool_code\nprint(default_api.get_current_temperature(location=\"London\"))\n```";
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapGeminiToolProvider(inner).stream({
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
      name: "get_current_temperature",
      arguments: '{"location":"London"}',
    });
  });
});
