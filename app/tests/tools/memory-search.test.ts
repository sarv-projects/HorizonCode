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
  if (workspace) rmSync(workspace, { recursive: true, force: true });
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

  test("shared_recall scope labels banks on hits", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtool-sh-"));
    replaceMemoryIndex(workspace, ["run gates before nightly deploy"], PROJECT_BANK);
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });
    const result = await memorySearchTool.execute({ query: "gates", scope: "shared_recall" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[project]");
    expect(result.output).toContain("gates");
  });
});
