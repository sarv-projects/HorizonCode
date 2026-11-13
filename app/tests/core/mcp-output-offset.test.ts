import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../src/contracts";
import { clearMcpTools, getMcpTool, registerMcpTools } from "../../src/core/mcp/registry";
import type { McpToolCaller } from "../../src/core/mcp/client";
import { mockToolContext } from "../tools/helpers";

describe("MCP proxy outputOffset", () => {
  test("outputOffset is stripped before tools/call", async () => {
    clearMcpTools();
    let seenArgs: Record<string, unknown> | undefined;
    const caller: McpToolCaller = {
      callTool: async (_name, args) => {
        seenArgs = args;
        return { isError: false, text: "x".repeat(20_000), raw: {} };
      },
    };
    registerMcpTools("stub", [{ name: "echo", description: "echo", inputSchema: { type: "object" } }], caller);
    const tool = getMcpTool("mcp__stub__echo");
    expect(tool).toBeDefined();
    const ctx: ToolContext = mockToolContext({});
    const r = await tool!.execute({ message: "hi", outputOffset: 4096 }, ctx);
    expect(r.ok).toBe(true);
    expect(seenArgs).toEqual({ message: "hi" });
    clearMcpTools();
  });
});
