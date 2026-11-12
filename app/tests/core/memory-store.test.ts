import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { memorySearch, replaceMemoryIndex } from "../../src/core/memory/store";
import { MEMORY_FILE } from "../../src/core/memory/manifest";
import { stateRoot } from "../../src/core/paths";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("memory FTS store", () => {
  test("BM25 ranks the best matching fact", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memfts-"));
    replaceMemoryIndex(workspace, [
      "prefer ripgrep over grep for code search",
      "deploy only to staging on Fridays",
      "never commit API keys from .env",
    ]);
    const hits = memorySearch(workspace, "ripgrep code search");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain("ripgrep");
  });

  test("seeds index from MEMORY.md when db is empty", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memseed-"));
    const dir = stateRoot(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MEMORY_FILE), "- run gates before pushing\n- prefer typed configs\n");
    const hits = memorySearch(workspace, "gates push");
    expect(hits.some((h) => h.includes("gates"))).toBe(true);
  });
});
