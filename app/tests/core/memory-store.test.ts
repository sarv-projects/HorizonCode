import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { memorySearch, memorySearchHits, replaceMemoryIndex } from "../../src/core/memory/store";
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

  test("memorySearchHits diversify flag is a no-op for a single hit", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memmmr-"));
    replaceMemoryIndex(workspace, ["single deploy policy for staging Fridays"]);
    const plain = memorySearchHits(workspace, "deploy staging", { limit: 3, diversify: false });
    const diverse = memorySearchHits(workspace, "deploy staging", { limit: 3, diversify: true });
    expect(diverse).toEqual(plain);
  });

  test("seeds topic file bodies into FTS when db is empty", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memtopic-"));
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, MEMORY_FILE), "- see landlock.md\n");
    writeFileSync(path.join(dir, "memory", "landlock.md"), "workspace-write Landlock fence must stay ask-gated\n");
    const hits = memorySearch(workspace, "Landlock fence");
    expect(hits.some((h) => h.toLowerCase().includes("landlock"))).toBe(true);
  });
});
