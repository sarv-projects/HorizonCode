import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  admitSavedAllowsWrite,
  appendSavedAllow,
  loadSavedAllows,
  savedAllowsPath,
  savedAllowsPublication,
  summarizeSavedAllows,
} from "../../src/core/saved-allows";
import { sessionDbPath, stateRoot } from "../../src/core/paths";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("saved allows", () => {
  test("append dedupes kind+target", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-"));
    await appendSavedAllow(workspace, "shell.exec", "npm test");
    await appendSavedAllow(workspace, "shell.exec", "npm test");
    const rows = loadSavedAllows(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe("npm test");
    expect(rows[0]?.action).toBe("shell");
    expect(readFileSync(savedAllowsPath(workspace), "utf8")).toContain("npm test");
    expect(readFileSync(savedAllowsPath(workspace), "utf8")).toContain('"action"');
  }, 30_000);

  test("summarizeSavedAllows counts rows", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-sum-"));
    expect(summarizeSavedAllows(workspace)).toMatch(/no saved allows/i);
    await appendSavedAllow(workspace, "shell.exec", "npm test");
    expect(summarizeSavedAllows(workspace)).toContain("1 exact-target");
    expect(summarizeSavedAllows(workspace)).toContain("hzcode.db");
  });

  test("savedAllowsPublication contracts row counts (H-7)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-pub-"));
    await appendSavedAllow(workspace, "shell.exec", "npm test");
    const human = summarizeSavedAllows(workspace);
    const blocks = savedAllowsPublication(workspace);
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      expect(block).toContain("metric:");
      expect(block).toContain("anchor:");
      expect(block).toContain("population:");
      expect(block).toContain("excludes:");
      expect(block).toContain("value:");
    }
    expect(blocks[0]).toContain("value: 1");
    expect(blocks.some((b) => b.includes("saved allows store") && b.includes("hzcode.db"))).toBe(true);
    // Human detail stays free of contract slots.
    expect(human).not.toContain("metric:");
    expect(human).toContain("1 exact-target");
  });

  test("persists rows in hzcode.db saved_allows", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-sql-"));
    await appendSavedAllow(workspace, "fs.read", "/proj/README.md");
    const db = new Database(sessionDbPath(workspace), { readonly: true });
  try {
    const n = (db.query("SELECT COUNT(*) AS c FROM saved_allows").get() as { c: number }).c;
    expect(n).toBe(1);
  } finally {
    db.close();
  }
  });

  test("imports legacy JSON when SQL table is empty", async () => {
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
  }, 20_000);

  test("admitSavedAllowsWrite refuses deny before persist (ruling 585)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-saved" }]),
        "utf8",
      );
      const refused = await admitSavedAllowsWrite(workspace);
      expect(refused).toMatch(/denied|test-deny-saved|saved-allows/i);
      const appendRefused = await appendSavedAllow(workspace, "shell.exec", "npm test");
      expect(appendRefused).toMatch(/denied|test-deny-saved|saved-allows/i);
      expect(loadSavedAllows(workspace)).toHaveLength(0);
      expect(existsSync(savedAllowsPath(workspace))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);

  test("compound shell expands to per-segment rows on append", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-cmp-"));
    await appendSavedAllow(workspace, "shell.exec", "echo ok && rm -rf build");
    const rows = loadSavedAllows(workspace);
    expect(rows.map((r) => r.target).sort()).toEqual(["echo ok", "rm -rf build"]);
  });

  test("refuses wildcard targets", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-wc-"));
    await appendSavedAllow(workspace, "shell.exec", "echo *");
    expect(loadSavedAllows(workspace)).toHaveLength(0);
    expect(existsSync(savedAllowsPath(workspace))).toBe(false);
  });
});