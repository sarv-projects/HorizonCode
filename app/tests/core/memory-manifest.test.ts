import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadMemoryManifest } from "../../src/core/memory/manifest";
import { stateRoot } from "../../src/core/paths";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("MEMORY.md manifest", () => {
  test("loads from .hz/MEMORY.md", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-"));
    const dir = stateRoot(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "remember: use rg\n");
    expect(loadMemoryManifest(workspace)).toContain("use rg");
  });
});
