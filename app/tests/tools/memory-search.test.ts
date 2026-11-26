import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PROJECT_BANK } from "../../src/core/memory/banks";
import { replaceMemoryIndex } from "../../src/core/memory/store";
import { memorySearchTool } from "../../src/tools/memory-search";
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

describe("memory_search tool", () => {
  test("returns ranked hits", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtool-"));
    replaceMemoryIndex(workspace, ["use bun test for the app suite", "lint before commit"]);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const result = await memorySearchTool.execute({ query: "bun test" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("bun test");
  });

  test("honours limit parameter", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtool-limit-"));
    replaceMemoryIndex(workspace, ["alpha bravo", "alpha charlie", "alpha delta"]);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const result = await memorySearchTool.execute({ query: "alpha", limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    const lines = (result.output ?? "").split("\n").filter((l) => /^\d+\./.test(l));
    expect(lines).toHaveLength(1);
  });

  test("shared_recall scope labels banks on hits", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtool-sh-"));
    replaceMemoryIndex(workspace, ["run gates before nightly deploy"], PROJECT_BANK);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const result = await memorySearchTool.execute({ query: "gates", scope: "shared_recall" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[project]");
    expect(result.output).toContain("gates");
  });

  test("rank:true opts into the fused ranking path (end-to-end wiring)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtool-rank-"));
    replaceMemoryIndex(workspace, ["alpha bravo charlie", "alpha delta echo"]);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const plain = await memorySearchTool.execute({ query: "alpha" }, ctx);
    const ranked = await memorySearchTool.execute({ query: "alpha", rank: true }, ctx);
    expect(plain.ok).toBe(true);
    expect(ranked.ok).toBe(true);
    // Both surfaces return the stored facts; the ranked path is exercised.
    expect(ranked.output).toContain("alpha");
  });
});
