import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PROJECT_BANK } from "../../src/core/memory/banks";
import { memorySearch, replaceMemoryIndex } from "../../src/core/memory/store";
import { memoryForgetTool, memoryRememberTool } from "../../src/tools/memory-write";
import { mockToolContext } from "./helpers";

let workspace = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
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