import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { rewriteHistoryForTextToolconv } from "../../src/core/providers/toolconv/history-rewrite";
import { prepareInnerTextToolRequest } from "../../src/core/providers/toolconv/wrap-shared";
import { renderHermesToolInstructions } from "../../src/core/providers/toolconv/hermes";

describe("toolconv history rewrite", () => {
  test("folds assistant tool_calls and paired tool results (hermes)", () => {
    const messages: ChatMsg[] = [
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"a.txt"}' }],
      },
      { role: "tool", toolCallId: "c1", toolName: "read", content: "hello" },
    ];
    const out = rewriteHistoryForTextToolconv(messages, "hermes");
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out.some((m) => m.toolCalls !== undefined)).toBe(false);
    const assistant = out.find((m) => m.role === "assistant");
    const user = out.filter((m) => m.role === "user");
    expect(assistant?.content).toContain("<tool_call>");
    expect(user[user.length - 1]?.content).toContain("<tool_response>");
    expect(user[user.length - 1]?.content).toContain("hello");
  });

  test("prepareInnerTextToolRequest strips native tools from wire", () => {
    const req = prepareInnerTextToolRequest(
      {
        model: "m",
        system: "base",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read", description: "r", parameters: { type: "object", properties: {} } }],
        signal: new AbortController().signal,
      },
      "hermes",
      renderHermesToolInstructions,
    );
    expect(req.tools).toEqual([]);
    expect(req.system).toContain("<tools>");
    expect(req.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
