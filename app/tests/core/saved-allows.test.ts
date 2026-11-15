import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  appendSavedAllow,
  loadSavedAllows,
  savedAllowsPath,
  summarizeSavedAllows,
} from "../../src/core/saved-allows";
import { sessionDbPath, stateRoot } from "../../src/core/paths";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("saved allows", () => {
  test("append dedupes kind+target", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-"));
    appendSavedAllow(workspace, "shell.exec", "npm test");
    appendSavedAllow(workspace, "shell.exec", "npm test");
    const rows = loadSavedAllows(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("npm test");
    expect(rows[0]?.action).toBe("shell");
    expect(readFileSync(savedAllowsPath(workspace), "utf8")).toContain("npm test");
    expect(readFileSync(savedAllowsPath(workspace), "utf8")).toContain('"action"');
  });

  test("summarizeSavedAllows counts rows", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-sum-"));
    expect(summarizeSavedAllows(workspace)).toMatch(/no saved allows/i);
    appendSavedAllow(workspace, "shell.exec", "npm test");
    expect(summarizeSavedAllows(workspace)).toContain("1 exact-target");
    expect(summarizeSavedAllows(workspace)).toContain("hzcode.db");
  });

  test("persists rows in hzcode.db saved_allows", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-sql-"));
    appendSavedAllow(workspace, "fs.read", "/proj/README.md");
    const db = new Database(sessionDbPath(workspace), { readonly: true });
  try {
    const n = (db.query("SELECT COUNT(*) AS c FROM saved_allows").get() as { c: number }).c;
    expect(n).toBe(1);
  } finally {
    db.close();
  }
  });

  test("imports legacy JSON when SQL table is empty", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-imp-"));
    const dest = savedAllowsPath(workspace);
    mkdirSync(stateRoot(workspace), { recursive: true });
    writeFileSync(
      dest,
      JSON.stringify({
        version: 1,
        allows: [
          {
            kind: "shell.exec",
            target: "make test",
            action: "shell",
            savedAt: new Date().toISOString(),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const rows = loadSavedAllows(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("make test");
    const db = new Database(sessionDbPath(workspace), { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS c FROM saved_allows").get() as { c: number }).c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("compound shell expands to per-segment rows on append", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-cmp-"));
    appendSavedAllow(workspace, "shell.exec", "echo ok && rm -rf build");
    const rows = loadSavedAllows(workspace);
    expect(rows.map((r) => r.target).sort()).toEqual(["echo ok", "rm -rf build"]);
  });

  test("refuses wildcard targets", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-wc-"));
    appendSavedAllow(workspace, "shell.exec", "echo *");
    expect(loadSavedAllows(workspace)).toHaveLength(0);
    expect(existsSync(savedAllowsPath(workspace))).toBe(false);
  });
});