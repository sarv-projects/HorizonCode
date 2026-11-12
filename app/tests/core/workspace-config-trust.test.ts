import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  augmentConfigWithTrustedWorkspace,
  loadConfig,
  mergeMcpConfigs,
  mergeProviderRegistries,
  readWorkspaceMcpConfig,
} from "../../src/core/config";
import { startMcpManager } from "../../src/core/mcp";
import { bindWorkspaceTrustRecord, collectWorkspaceTrustDigests, workspaceMcpConfigFile } from "../../src/core/trust";

let workspace: string;
let home: string;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("trusted workspace mcp.json load", () => {
  test("mergeMcpConfigs appends workspace servers", () => {
    const user = { servers: [{ id: "a", command: "echo", args: ["u"] }] };
    const ws = { servers: [{ id: "b", command: "echo", args: ["w"] }] };
    const merged = mergeMcpConfigs(user, ws);
    expect(merged?.servers.map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("startMcpManager connects workspace server when trusted", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-ws-mcp-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-ws-home-"));
    const mcpFile = workspaceMcpConfigFile(workspace);
    mkdirSync(path.dirname(mcpFile), { recursive: true });
    writeFileSync(
      mcpFile,
      JSON.stringify({ servers: [{ id: "ws-srv", command: "true", args: [] }] }),
    );
    bindWorkspaceTrustRecord(home, workspace, collectWorkspaceTrustDigests(workspace));

    const base = loadConfig({ HOME: home } as NodeJS.ProcessEnv, path.join(home, "missing.json"));
    const config = augmentConfigWithTrustedWorkspace(
      { ...base, trustedWorkspaceHooks: [path.resolve(workspace)] },
      workspace,
      { HOME: home } as NodeJS.ProcessEnv,
      home,
    );
    expect(config.mcp?.servers.some((s) => s.id === "ws-srv")).toBe(true);

    const admits: string[] = [];
    await startMcpManager(config.mcp, {
      workspace,
      sessionId: "s",
      trustedWorkspaceHooks: config.trustedWorkspaceHooks,
      home,
      guard: async (a) => {
        admits.push(a.target);
        return { decision: "allow" };
      },
      approve: async () => true,
      onNotice: () => undefined,
    }, {
      clientFactory: () =>
        ({
          start: async () => undefined,
          stop: async () => undefined,
          listTools: async () => [],
          callTool: async () => ({ ok: true, output: "" }),
          state: () => "connected" as const,
        }) as never,
    });
    expect(admits.some((t) => t.includes("ws-srv"))).toBe(true);
  });
});

describe("trusted workspace providers.json merge", () => {
  test("mergeProviderRegistries appends workspace providers", () => {
    const user = {
      providers: [{ id: "a", baseUrl: "https://a.example", protocol: "openai", models: ["m1"] }],
    };
    const ws = {
      providers: [{ id: "b", baseUrl: "https://b.example", protocol: "openai", models: ["m2"] }],
    };
    const merged = mergeProviderRegistries(user, ws);
    expect(merged?.providers.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
