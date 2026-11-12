import { describe, expect, test } from "bun:test";
import type { Provider, ProviderEvent, ToolSpec } from "../../src/contracts";
import {
  GEMMA_CALL_CLOSE,
  GEMMA_CALL_OPEN,
  GEMMA_STR,
  decodeGemmaValue,
  parseGemmaToolCalls,
} from "../../src/core/providers/toolconv/gemma";
import { wrapGemmaToolProvider } from "../../src/core/providers/toolconv/wrap-gemma";

const TOOLS: ToolSpec[] = [
  {
    name: "get_current_temperature",
    description: "temp",
    parameters: { type: "object", properties: {} },
  },
];

describe("gemma toolconv", () => {
  test("asymmetric open/close markers", () => {
    expect(GEMMA_CALL_OPEN).toBe("<|tool_call>");
    expect(GEMMA_CALL_CLOSE).toBe("<tool_call|>");
    expect(GEMMA_STR).toBe('<|"|>');
  });

  test("decodes string token and scalars", () => {
    expect(decodeGemmaValue(`${GEMMA_STR}London${GEMMA_STR}`)).toBe("London");
    expect(decodeGemmaValue("42")).toBe(42);
    expect(decodeGemmaValue("true")).toBe(true);
    expect(decodeGemmaValue("null")).toBeNull();
  });

  test("parses call:NAME{key:string}", () => {
    const text =
      `${GEMMA_CALL_OPEN}call:get_current_temperature{location:${GEMMA_STR}London${GEMMA_STR}}${GEMMA_CALL_CLOSE}`;
    const { calls, errors } = parseGemmaToolCalls(text, new Set(["get_current_temperature"]));
    expect(errors).toEqual([]);
    expect(calls).toEqual([{ name: "get_current_temperature", args: { location: "London" } }]);
  });

  test("string may contain commas and quotes without ending the block", () => {
    const text =
      `${GEMMA_CALL_OPEN}call:get_current_temperature{location:${GEMMA_STR}The city, e.g. "SF"${GEMMA_STR}}${GEMMA_CALL_CLOSE}`;
    const { calls } = parseGemmaToolCalls(text, new Set(["get_current_temperature"]));
    expect(calls[0]?.args.location).toBe('The city, e.g. "SF"');
  });

  test("partial open yields nothing", () => {
    const text = `${GEMMA_CALL_OPEN}call:get_current_temperature{location:`;
    expect(parseGemmaToolCalls(text, new Set(["get_current_temperature"])).calls).toEqual([]);
  });

  test("wrapper emits tool_call after stream completes", async () => {
    const block =
      `${GEMMA_CALL_OPEN}call:get_current_temperature{location:${GEMMA_STR}Tokyo${GEMMA_STR}}${GEMMA_CALL_CLOSE}`;
    const inner: Provider = {
      name: "script",
      async *stream() {
        yield { type: "text", text: block };
        yield { type: "done", stopReason: "end" };
      },
    };
    const events: ProviderEvent[] = [];
    for await (const e of wrapGemmaToolProvider(inner).stream({
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
      arguments: '{"location":"Tokyo"}',
    });
  });
});
