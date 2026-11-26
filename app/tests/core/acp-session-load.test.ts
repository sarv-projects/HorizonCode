import { describe, expect, test } from "bun:test";
import { AcpAgent, type AcpSession } from "../../src/core/acp-agent";

describe("ACP session loading and client tool passthrough", () => {
  test("session/load uses custom sessionLoader to hydrate existing session", async () => {
    const persistedDb = new Map<string, AcpSession>([
      [
        "sess_persisted_123",
        {
          sessionId: "sess_persisted_123",
          cwd: "/path/to/project",
          createdAt: "2026-11-20T10:00:00.000Z",
        },
      ],
    ]);

    const agent = new AcpAgent({
      sessionLoader: async (sessionId) => persistedDb.get(sessionId),
    });

    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, capabilities: {}, info: { name: "test", version: "0" } },
    });

    const loadRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/load",
      params: { sessionId: "sess_persisted_123" },
    });

    expect(loadRes && "result" in loadRes).toBe(true);
    const session = (loadRes as { result: { session: AcpSession } }).result.session;
    expect(session.sessionId).toBe("sess_persisted_123");
    expect(session.cwd).toBe("/path/to/project");
    expect(agent.sessionIds()).toContain("sess_persisted_123");

    // Unknown session without cwd returns error
    const failRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId: "sess_nonexistent" },
    });
    expect(failRes && "error" in failRes).toBe(true);
  });

  test("session/setMcpServers and session/getMcpServers store and retrieve servers", async () => {
    const agent = new AcpAgent();
    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, capabilities: {}, info: { name: "test", version: "0" } },
    });

    const newRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/project" },
    });
    const sessionId = (newRes as any).result.sessionId;

    const setRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/setMcpServers",
      params: {
        sessionId,
        servers: [{ name: "sqlite", command: "mcp-sqlite", args: ["db.sqlite"] }],
      },
    });
    expect((setRes as any).result.ok).toBe(true);
    expect((setRes as any).result.serverCount).toBe(1);

    const getRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/getMcpServers",
      params: { sessionId },
    });
    expect((getRes as any).result.servers.length).toBe(1);
    expect((getRes as any).result.servers[0].name).toBe("sqlite");
  });

  test("session/invokeTool dispatches to toolDispatcher", async () => {
    const calls: { sessionId: string; toolName: string; args: Record<string, unknown> }[] = [];
    const agent = new AcpAgent({
      toolDispatcher: async (sessionId, toolName, args) => {
        calls.push({ sessionId, toolName, args });
        return { ok: true, output: `executed ${toolName}` };
      },
    });

    await agent.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, capabilities: {}, info: { name: "test", version: "0" } },
    });

    const newRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/project" },
    });
    const sessionId = (newRes as any).result.sessionId;

    const invokeRes = await agent.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/invokeTool",
      params: {
        sessionId,
        name: "read",
        args: { path: "src/main.ts" },
      },
    });

    expect((invokeRes as any).result).toEqual({ ok: true, output: "executed read" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.toolName).toBe("read");
    expect(calls[0]?.args).toEqual({ path: "src/main.ts" });
  });
});
