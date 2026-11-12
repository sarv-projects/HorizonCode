import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import {
  DS_TOOL_CALL_BEGIN,
  DS_TOOL_CALL_END,
  DS_TOOL_CALLS_BEGIN,
  DS_TOOL_CALLS_END,
  DS_TOOL_SEP,
  parseDeepseekToolCalls,
} from "../../src/core/providers/toolconv/deepseek";
import { wrapDeepseekToolProvider } from "../../src/core/providers/toolconv/wrap-deepseek";

const TOOLS: ToolSpec[] = [
  { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } },
];

function oneCall(name: string, args: string): string {
  return (
    DS_TOOL_CALLS_BEGIN +
    DS_TOOL_CALL_BEGIN +
    name +
    DS_TOOL_SEP +
    args +
    DS_TOOL_CALL_END +
    DS_TOOL_CALLS_END
  );
}

describe("deepseek toolconv", () => {
  test("markers use fullwidth pipe and SentencePiece glyph (not ASCII)", () => {
    expect(DS_TOOL_CALL_BEGIN).toContain("\uFF5C");
    expect(DS_TOOL_CALL_BEGIN).toContain("\u2581");
    expect(DS_TOOL_CALL_BEGIN).not.toContain("|");
    expect(DS_TOOL_CALL_BEGIN).not.toContain("_");
  });

  test("parses V3.1 name+sep+json call", () => {
    const text = oneCall("get_weather", '{"location":"San Francisco, CA"}');
    const { calls, errors } = parseDeepseekToolCalls(text, new Set(["get_weather"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "get_weather", args: { location: "San Francisco, CA" } }]);
  });

  test("parallel chained calls", () => {
    const text =
      DS_TOOL_CALLS_BEGIN +
      DS_TOOL_CALL_BEGIN +
      "get_weather" +
      DS_TOOL_SEP +
      '{"location":"A"}' +
      DS_TOOL_CALL_END +
      DS_TOOL_CALL_BEGIN +
      "get_weather" +
      DS_TOOL_SEP +
      '{"location":"B"}' +
      DS_TOOL_CALL_END +
      DS_TOOL_CALLS_END;
    const { calls } = parseDeepseekToolCalls(text, new Set(["get_weather"]));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual({ location: "A" });
    expect(calls[1]?.args).toEqual({ location: "B" });
  });

  test("ASCII-folded markers do not parse", () => {
    const ascii = `<|tool_calls_begin|><|tool_call_begin|>get_weather<|tool_sep|>{"location":"A"}<|tool_call_end|><|tool_calls_end|>`;
    expect(parseDeepseekToolCalls(ascii, new Set(["get_weather"])).calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block = oneCall("get_weather", '{"location":"Beijing"}');
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapDeepseekToolProvider(inner).stream({
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
      arguments: '{"location":"Beijing"}',
    });
  });
});
