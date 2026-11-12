import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import { parseForgeXmlToolCalls } from "../../src/core/providers/toolconv/xml";
import { wrapXmlToolProvider } from "../../src/core/providers/toolconv/wrap-xml";

const TOOLS: ToolSpec[] = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];

function textProvider(text: string): Provider {
  return {
    name: "script",
    async *stream() {
      yield { type: "text", text };
      yield { type: "done", stopReason: "end" };
    },
  };
}

async function collectEvents(provider: Provider): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of provider.stream({
    model: "m",
    system: "",
    messages: [],
    tools: TOOLS,
    signal: new AbortController().signal,
  })) {
    out.push(e);
  }
  return out;
}

describe("xml toolconv wrapper", () => {
  test("emits tool_call only after stream completes", async () => {
    const block =
      `<forge_tool_call><tool_name>read</tool_name><arguments>{"path":"a.txt"}</arguments></forge_tool_call>`;
    const wrapped = wrapXmlToolProvider(textProvider(`ok ${block}`));
    const events = await collectEvents(wrapped);
    const tools = events.filter((e) => e.type === "tool_call");
    const done = events.filter((e) => e.type === "done");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "read", arguments: '{"path":"a.txt"}' });
    expect(done[done.length - 1]).toMatchObject({ stopReason: "tool_use" });
    const toolIdx = events.findIndex((e) => e.type === "tool_call");
    const textIdx = events.findIndex((e) => e.type === "text");
    expect(textIdx).toBeLessThan(toolIdx);
  });

  test("partial block at end yields no tool_call", async () => {
    const wrapped = wrapXmlToolProvider(textProvider("still typing <forge_tool_call><tool_name>read"));
    const events = await collectEvents(wrapped);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "done" && e.stopReason === "end")).toBe(true);
  });

  test("fuzz: parsed names stay within allowed set", () => {
    const allowed = new Set(["read", "glob"]);
    const samples = [
      "<forge_tool_call><tool_name>evil</tool_name><arguments>{}</arguments></forge_tool_call>",
      "noise " + "x".repeat(40),
      "<forge_tool_call><tool_name>read</tool_name><arguments>{}</arguments></forge_tool_call>",
    ];
    for (const text of samples) {
      const { calls } = parseForgeXmlToolCalls(text, allowed);
      for (const c of calls) expect(allowed.has(c.name)).toBe(true);
    }
  });
});
