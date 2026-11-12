import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
});
