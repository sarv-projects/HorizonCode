import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PROJECT_BANK } from "../../src/core/memory/banks";
import { stateRoot } from "../../src/core/paths";
import { MEMORY_FILE } from "../../src/core/memory/manifest";
import { memorySearch, replaceMemoryIndex } from "../../src/core/memory/store";
import { memoryForgetTool, memoryRememberTool } from "../../src/tools/memory-write";
import { mockToolContext } from "./helpers";

let workspace = "";

afterEach(() => {
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows (SQLite handle cleanup)
    }
  }
  workspace = "";
});

describe("memory write tools", () => {
  test("memory_remember appends and is searchable", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memrem-"));
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const r = await memoryRememberTool.execute({ content: "always run typecheck before push" }, ctx);
    expect(r.ok).toBe(true);
    expect(memorySearch(workspace, "typecheck push").some((h) => h.includes("typecheck"))).toBe(true);
  });

  test("HZ_MEMORY_SYNC_MEMORY_MD appends MEMORY.md bullet on project remember", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memidx-"));
    const prev = process.env.HZ_MEMORY_SYNC_MEMORY_MD;
    process.env.HZ_MEMORY_SYNC_MEMORY_MD = "1";
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    try {
      const r = await memoryRememberTool.execute({ content: "deploy only after gates green" }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain("MEMORY.md index updated");
      const md = readFileSync(path.join(stateRoot(workspace), MEMORY_FILE), "utf8");
      expect(md).toContain("deploy only after gates green");
    } finally {
      if (prev === undefined) delete process.env.HZ_MEMORY_SYNC_MEMORY_MD;
      else process.env.HZ_MEMORY_SYNC_MEMORY_MD = prev;
    }
  });

  test("memory_forget removes by query", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memforg-"));
    replaceMemoryIndex(workspace, ["stale deploy note", "fresh deploy note"], PROJECT_BANK);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const r = await memoryForgetTool.execute({ query: "stale deploy" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("forgot");
    expect(memorySearch(workspace, "stale").length).toBe(0);
    expect(memorySearch(workspace, "fresh deploy").length).toBeGreaterThan(0);
  });
});