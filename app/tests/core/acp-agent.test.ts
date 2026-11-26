import { describe, expect, test } from "bun:test";
import {
  ACP_AGENT_CAPABILITIES_HONEST,
  AcpAgent,
  type AcpSessionUpdateNotification,
  extractPromptText,
} from "../../src/core/acp-agent";

describe("acp-agent (ruling 642)", () => {
  test("initialize then session/new/list/prompt/close", async () => {
    const agent = new AcpAgent({
      promptHandler: async ({ prompt }) => ({
        stopReason: "end_turn",
        text: `echo:${prompt}`,
      }),
    });
    const init = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, capabilities: {}, info: { name: "test", version: "0" } },
    });
    expect(init && "result" in init && (init.result as { protocolVersion: number }).protocolVersion).toBe(2);
    const initResult = init as { result: { agentCapabilities: typeof ACP_AGENT_CAPABILITIES_HONEST; agentInfo: { name: string } } };
    expect(initResult.result.agentCapabilities).toEqual(ACP_AGENT_CAPABILITIES_HONEST);
    expect("loadSession" in initResult.result.agentCapabilities).toBe(false);
    expect(initResult.result.agentInfo.name).toBe("horizoncode");

    const created = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/hz-acp-ws" },
    });
    expect(created && "result" in created).toBe(true);
    const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
    expect(sessionId.startsWith("sess_")).toBe(true);

    const listed = await agent.handleMessage({ jsonrpc: "2.0", id: 2, method: "session/list" });
    expect(
      listed &&
        "result" in listed &&
        Array.isArray((listed.result as { sessions: unknown[] }).sessions) &&
        (listed.result as { sessions: unknown[] }).sessions.length,
    ).toBe(1);

    const prompted = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: "fix the bug" },
    });
    expect(prompted && "result" in prompted).toBe(true);
    const content = (prompted as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content[0]?.text).toBe("echo:fix the bug");

    const closed = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "session/close",
      params: { sessionId },
    });
    expect(closed && "result" in closed).toBe(true);
    expect(agent.sessionIds()).toEqual([]);
  });

  test("rejects methods before initialize", async () => {
    const agent = new AcpAgent();
    const res = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/x" },
    });
    expect(res && "error" in res && res.error.code).toBe(-32001);
  });

  test("session/cancel aborts in-flight session/prompt", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = new AcpAgent({
      promptHandler: async ({ signal }) => {
        await gate;
        if (signal?.aborted) {
          return { stopReason: "cancelled", text: "" };
        }
        return { stopReason: "end_turn", text: "done" };
      },
    });
    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, capabilities: {}, info: { name: "test", version: "0" } },
    });
    const created = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/hz-acp-cancel" },
    });
    const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
    const promptP = agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: "long work" },
    });
    await new Promise((r) => setTimeout(r, 20));
    const cancelled = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/cancel",
      params: { sessionId },
    });
    expect(cancelled && "result" in cancelled).toBe(true);
    release?.();
    const prompted = await promptP;
    expect(prompted && "result" in prompted).toBe(true);
    expect((prompted as { result: { stopReason: string } }).result.stopReason).toBe("cancelled");
  });

  test("session/prompt emits session/update agent_message_chunk", async () => {
    const notifications: AcpSessionUpdateNotification[] = [];
    const agent = new AcpAgent({
      onNotification: (n) => notifications.push(n),
      promptHandler: async ({ prompt, onAgentMessageChunk }) => {
        onAgentMessageChunk?.("part:");
        return { stopReason: "end_turn", text: `part:${prompt}` };
      },
    });
    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, clientCapabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    const created = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/hz-acp-stream" },
    });
    const sessionId = (created as { result: { sessionId: string } }).result.sessionId;
    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: "hi" },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(notifications[0]?.params.update.content.text).toBe("part:");
  });

  test("extractPromptText supports content blocks", () => {
    expect(
      extractPromptText({
        prompt: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
      }),
    ).toBe("hello\nworld");
  });

  test("session/load and session/setMcpServers support (ruling 863)", async () => {
    const agent = new AcpAgent();
    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2 },
    });

    const created = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/hz-acp-load" },
    });
    const sessionId = (created as { result: { sessionId: string } }).result.sessionId;

    // session/load loads the existing session
    const loaded = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId },
    });
    expect(loaded && "result" in loaded).toBe(true);
    const session = (loaded as { result: { session: { sessionId: string; cwd: string } } }).result.session;
    expect(session.sessionId).toBe(sessionId);
    expect(session.cwd).toBe("/tmp/hz-acp-load");

    // session/load with unknown id and no cwd fails
    const failLoad = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/load",
      params: { sessionId: "sess_nonexistent" },
    });
    expect(failLoad && "error" in failLoad).toBe(true);

    // session/setMcpServers sets client MCP servers
    const setMcp = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "session/setMcpServers",
      params: {
        sessionId,
        servers: [{ name: "local-mcp", command: "node", args: ["server.js"] }],
      },
    });
    expect(setMcp && "result" in setMcp).toBe(true);
    expect((setMcp as { result: { ok: boolean; serverCount: number } }).result.serverCount).toBe(1);
  });
});
