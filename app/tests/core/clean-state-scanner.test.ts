import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { scanCleanState } from "../../src/core/clean-state-scanner";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

describe("clean-state-scanner", () => {
  test("reports clean when workspace has only normal source files", () => {
    const dir = tempDir("hz-clean-ok-");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.ts"), "export const ok = true;\n");
    writeFileSync(path.join(dir, "README.md"), "# ok\n");

    const report = scanCleanState(dir);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain("Clean state verified");
  });

  test("detects temporary files, scratch files, and debug logs in source directories", () => {
    const dir = tempDir("hz-clean-dirty-");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "app"), { recursive: true });
    writeFileSync(path.join(dir, "notes.tmp"), "tmp");
    writeFileSync(path.join(dir, "file.bak"), "bak");
    writeFileSync(path.join(dir, "edit.swp"), "swp");
    writeFileSync(path.join(dir, "README.md~"), "tilde");
    writeFileSync(path.join(dir, "src", "debug.log"), "log");
    writeFileSync(path.join(dir, "app", "trace.log"), "log");
    writeFileSync(path.join(dir, "src", "scratch.ts"), "console.log(1);");
    writeFileSync(path.join(dir, "test-manual.ts"), "console.log(2);");

    const report = scanCleanState(dir);
    expect(report.clean).toBe(false);
    expect(report.findings.filter((f) => f.category === "temporary_file").length).toBe(4);
    expect(report.findings.filter((f) => f.category === "debug_log").length).toBe(2);
    expect(report.findings.filter((f) => f.category === "scratch_file").length).toBe(2);
    expect(report.summary).toContain("8 artifact(s)");
  });

  test("skips ignored directories (.git, node_modules, dist, .hz, target)", () => {
    const dir = tempDir("hz-clean-ignore-");
    for (const ignored of [".git", "node_modules", "dist", "target", ".hz", ".hzcode"]) {
      mkdirSync(path.join(dir, ignored), { recursive: true });
      writeFileSync(path.join(dir, ignored, "scratch.ts"), "ignored");
      writeFileSync(path.join(dir, ignored, "stale.tmp"), "ignored");
    }

    const report = scanCleanState(dir);
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test("wired into SessionStore.scanWorkspaceCleanState", () => {
    const dir = tempDir("hz-clean-session-");
    const store = new SessionStore(dir);
    try {
      expect(store.scanWorkspaceCleanState().clean).toBe(true);
      writeFileSync(path.join(dir, "scratch.ts"), "leftover");
      const dirty = store.scanWorkspaceCleanState();
      expect(dirty.clean).toBe(false);
      expect(dirty.findings.some((f) => f.category === "scratch_file")).toBe(true);
    } finally {
      store.close();
    }
  });
});
