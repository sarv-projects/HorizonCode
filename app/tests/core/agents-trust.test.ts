import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadPresets } from "../../src/core/agent-profiles";
import { digestWorkspaceAgents, workspaceAgentsDir } from "../../src/core/trust";

let workspace: string;
let home: string;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("workspace agent preset trust", () => {
  test("untrusted workspace with agents emits notice once presets exist", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-agents-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-agents-home-"));
    const agentsDir = workspaceAgentsDir(workspace);
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "local.md"),
      "---\nname: local\ntools: read\n---\nOnly read.\n",
    );
    expect(digestWorkspaceAgents(workspace)).not.toBeNull();
    const notes: string[] = [];
    const set = loadPresets(workspace, { trustedWorkspaceHooks: [], home, onNotice: (m) => notes.push(m) });
    expect(set.presets.has("local")).toBe(false);
    expect(notes.join("\n")).toContain("workspace agent presets ignored");
  });

  test("untrusted workspace without agents dir is silent", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-agents-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-agents-home-"));
    const notes: string[] = [];
    loadPresets(workspace, { trustedWorkspaceHooks: [], home, onNotice: (m) => notes.push(m) });
    expect(notes.length).toBe(0);
  });
});
