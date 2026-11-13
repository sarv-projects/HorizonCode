import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PROJECT_BANK, SHARED_BANK, USER_BANK } from "../../src/core/memory/banks";
import { MEMORY_FILE } from "../../src/core/memory/manifest";
import {
  memorySearch,
  memorySearchHits,
  replaceMemoryIndex,
  sharedMemorySearch,
} from "../../src/core/memory/store";
import { stateRoot } from "../../src/core/paths";

let workspace = "";
let userHome = "";

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (userHome) rmSync(userHome, { recursive: true, force: true });
  workspace = "";
  userHome = "";
});

describe("memory banks", () => {
  test("project bank is isolated from user bank rows", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-membank-"));
    userHome = mkdtempSync(path.join(tmpdir(), "hz-memhome-"));
    replaceMemoryIndex(workspace, ["workspace-only ripgrep preference"], PROJECT_BANK);
    replaceMemoryIndex(workspace, ["user-wide eslint preference"], USER_BANK, userHome);
    const projectHits = memorySearchHits(workspace, "ripgrep", { banks: [PROJECT_BANK] }, userHome);
    const userHits = memorySearchHits(workspace, "eslint", { banks: [USER_BANK] }, userHome);
    expect(projectHits.every((h) => h.bank === PROJECT_BANK)).toBe(true);
    expect(userHits.every((h) => h.bank === USER_BANK)).toBe(true);
    expect(projectHits.some((h) => h.content.includes("ripgrep"))).toBe(true);
    expect(userHits.some((h) => h.content.includes("eslint"))).toBe(true);
  });

  test("sharedMemorySearch returns bank id on each hit across banks", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-membank-x-"));
    userHome = mkdtempSync(path.join(tmpdir(), "hz-memhome-x-"));
    replaceMemoryIndex(workspace, ["deploy staging on Fridays project"], PROJECT_BANK);
    replaceMemoryIndex(workspace, ["prefer concise answers user"], USER_BANK, userHome);
    replaceMemoryIndex(workspace, ["always run gates before push shared"], SHARED_BANK, userHome);
    const hits = sharedMemorySearch(workspace, "gates push", 8, userHome);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.bank === SHARED_BANK && h.content.includes("gates"))).toBe(true);
    const banks = new Set(hits.map((h) => h.bank));
    expect(banks.size).toBeGreaterThanOrEqual(1);
  });

  test("migrates legacy single-column FTS rows into project bank", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memlegacy-"));
    const dbPath = path.join(stateRoot(workspace), "memory.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(content, tokenize='porter');`);
    db.prepare(`INSERT INTO memory_fts(content) VALUES (?)`).run("legacy fact about landlock");
    db.close();
    const hits = memorySearch(workspace, "landlock");
    expect(hits.some((h) => h.includes("landlock"))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  test("seeds project bank only from MEMORY.md", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-memseed-bank-"));
    const dir = stateRoot(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MEMORY_FILE), "- run gates before pushing\n");
    const hits = memorySearchHits(workspace, "gates push");
    expect(hits.every((h) => h.bank === PROJECT_BANK)).toBe(true);
    expect(hits.some((h) => h.content.includes("gates"))).toBe(true);
  });
});
