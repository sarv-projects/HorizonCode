/** dream consolidation text stub — HZ_MEMORY_DREAM (ruling 242). */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import {
  buildDreamConsolidationAppend,
  collectDreamConsolidationSnippets,
  dreamConsolidationPath,
  memoryDreamConsolidationEnabled,
  parseDreamContentHashes,
  runDreamConsolidation,
} from "../../src/core/memory/dream-consolidation";
import { createHandoff, resetHandoffsForTests } from "../../src/core/memory/handoff";
import { stateRoot } from "../../src/core/paths";

const roots: string[] = [];
const envRestore = { ...process.env };

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in envRestore)) delete process.env[key];
  }
  Object.assign(process.env, envRestore);
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-dream-consolidate-"));
  roots.push(dir);
  return dir;
}

describe("memoryDreamConsolidationEnabled", () => {
  test("off unless HZ_MEMORY_DREAM=1", () => {
    expect(memoryDreamConsolidationEnabled({})).toBe(false);
    expect(memoryDreamConsolidationEnabled({ HZ_MEMORY_DREAM: "1" })).toBe(true);
  });
});

describe("dream consolidation append", () => {
  test("hash-dedupes snippets across runs", () => {
    const snippet = "handoff: ship the thing";
    const hash = sha256Hex(snippet);
    const first = buildDreamConsolidationAppend("/tmp", null, [snippet]);
    expect(first.noop).toBe(false);
    expect(first.content).toContain(hash);
    expect(parseDreamContentHashes(first.content).has(hash)).toBe(true);
    const second = buildDreamConsolidationAppend("/tmp", first.content, [snippet]);
    expect(second.noop).toBe(true);
    expect(second.skippedDuplicate).toBe(1);
  });

  test("runDreamConsolidation dry when env off", () => {
    const workspace = ws();
    const root = stateRoot(workspace);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "MEMORY.md"), "- river fact\n", { mode: 0o600 });
    delete process.env.HZ_MEMORY_DREAM;
    const result = runDreamConsolidation(workspace);
    expect(result.dryRun).toBe(true);
    expect(existsSync(dreamConsolidationPath(workspace))).toBe(false);
  });

  test("runDreamConsolidation writes memory/dream.md when enabled", () => {
    const workspace = ws();
    resetHandoffsForTests(workspace);
    createHandoff(workspace, {
      summary: "Finished the dream stub tests",
      tried: ["run typecheck"],
      next: ["update docs"],
    });
    const root = stateRoot(workspace);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "MEMORY.md"), "- index line one\n", { mode: 0o600 });
    process.env.HZ_MEMORY_DREAM = "1";
    const snippets = collectDreamConsolidationSnippets(workspace);
    expect(snippets.length).toBeGreaterThan(0);
    const result = runDreamConsolidation(workspace, { dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(result.appended).toBeGreaterThan(0);
    const text = readFileSync(result.dreamPath, "utf8");
    expect(text).toContain("Dream consolidation");
    expect(text).toContain("dream-hash:");
    const again = runDreamConsolidation(workspace, { dryRun: false });
    expect(again.noop).toBe(true);
  });
});
