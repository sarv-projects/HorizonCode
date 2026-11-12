import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseMinimaxToolCalls } from "../../src/core/providers/toolconv/minimax";
import { wrapMinimaxToolProvider } from "../../src/core/providers/toolconv/wrap-minimax";

const TOOLS: ToolSpec[] = [
  { name: "read", description: "read", parameters: { type: "object", properties: {} } },
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } },
];

describe("minimax toolconv", () => {
  test("parses namespaced envelope with parameters", () => {
    const text = `<minimax:tool_call>
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
</minimax:tool_call>`;
    const { calls, errors } = parseMinimaxToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "src/main.ts", count: 40 } }]);
  });

  test("parallel invokes keep order", () => {
    const text = `<minimax:tool_call>
<invoke name="get_weather"><parameter name="city">Tokyo</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter></invoke>
</minimax:tool_call>`;
    const { calls } = parseMinimaxToolCalls(text, new Set(["get_weather"]));
    expect(calls.map((c) => c.args.city)).toEqual(["Tokyo", "Oslo"]);
  });

  test("keeps amp/lt literal in string bodies", () => {
    const text =
      `<invoke name="read"><parameter name="path">a & b < c.txt</parameter></invoke>`;
    const { calls } = parseMinimaxToolCalls(text, new Set(["read"]));
    expect(calls[0]?.args.path).toBe("a & b < c.txt");
  });

  test("partial invoke yields nothing", () => {
    const text = `<minimax:tool_call><invoke name="read"><parameter name="path">x`;
    expect(parseMinimaxToolCalls(text, new Set(["read"])).calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      `<minimax:tool_call><invoke name="read"><parameter name="path">a.txt</parameter></invoke></minimax:tool_call>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapMinimaxToolProvider(inner).stream({
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
