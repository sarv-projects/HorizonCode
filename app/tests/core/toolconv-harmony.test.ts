import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseHarmonyToolCalls } from "../../src/core/providers/toolconv/harmony";
import { wrapHarmonyToolProvider } from "../../src/core/providers/toolconv/wrap-harmony";

const TOOLS: ToolSpec[] = [
  { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("harmony toolconv", () => {
  test("parses channel-section recipient form", () => {
    const text =
      `<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"a.txt"}<|call|>`;
    const { calls, errors } = parseHarmonyToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "a.txt" } }]);
  });

  test("parses role-section recipient form", () => {
    const text =
      `<|start|>assistant to=functions.read<|channel|>commentary <|constrain|>json<|message|>{"path":"b.txt"}<|call|>`;
    const { calls, errors } = parseHarmonyToolCalls(text, new Set(["read"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "read", args: { path: "b.txt" } }]);
  });

  test("partial call yields nothing", () => {
    const text = `<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":`;
    const { calls } = parseHarmonyToolCalls(text, new Set(["read"]));
    expect(calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      `<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"a.txt"}<|call|>`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapHarmonyToolProvider(inner).stream({
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
