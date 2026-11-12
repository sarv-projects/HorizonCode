import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { noticeUntrustedWorkspaceMcp, workspaceMcpConfigFile } from "../../src/core/trust";

let workspace: string;
let home: string;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("workspace mcp trust", () => {
  test("untrusted workspace mcp.json emits notice at manager start", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mcp-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-mcp-home-"));
    const mcpFile = workspaceMcpConfigFile(workspace);
    mkdirSync(path.dirname(mcpFile), { recursive: true });
    writeFileSync(mcpFile, '{"servers":[]}');
    const notes: string[] = [];
    noticeUntrustedWorkspaceMcp(workspace, [], home, (m) => notes.push(m));
    expect(notes.join("\n")).toMatch(/mcp\.json|mcp/);
  });

  test("noticeUntrustedWorkspaceMcp is silent for trusted workspace", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mcp-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-mcp-home-"));
    const mcpFile = workspaceMcpConfigFile(workspace);
    mkdirSync(path.dirname(mcpFile), { recursive: true });
    writeFileSync(mcpFile, '{"servers":[]}');
    const notes: string[] = [];
    noticeUntrustedWorkspaceMcp(workspace, [path.resolve(workspace)], home, (m) => notes.push(m));
    expect(notes.length).toBe(0);
  });
});
