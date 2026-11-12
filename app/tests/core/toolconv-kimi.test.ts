import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseKimiToolCalls } from "../../src/core/providers/toolconv/kimi";
import { wrapKimiToolProvider } from "../../src/core/providers/toolconv/wrap-kimi";

const TOOLS: ToolSpec[] = [
  { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("kimi toolconv", () => {
  test("parses section with functions.name:idx", () => {
    const text =
      `<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a.txt"}<|tool_call_end|><|tool_calls_section_end|>`;
    const { calls, errors } = parseKimiToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" }, callId: "functions.read:0" }]);
  });

  test("parallel calls keep distinct ids", () => {
    const text =
      `<|tool_calls_section_begin|>` +
      `<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a"}<|tool_call_end|>` +
      `<|tool_call_begin|>functions.read:1<|tool_call_argument_begin|>{"path":"b"}<|tool_call_end|>` +
      `<|tool_calls_section_end|>`;
    const { calls } = parseKimiToolCalls(text, new Set(["read"]));
    expect(calls.map((c) => c.callId)).toEqual(["functions.read:0", "functions.read:1"]);
  });

  test("partial call yields nothing", () => {
    const text = `<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":`;
    expect(parseKimiToolCalls(text, new Set(["read"])).calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      `<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"a.txt"}<|tool_call_end|><|tool_calls_section_end|>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapKimiToolProvider(inner).stream({
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
      name: "read",
      id: "functions.read:0",
      arguments: '{"path":"a.txt"}',
    });
  });
});
