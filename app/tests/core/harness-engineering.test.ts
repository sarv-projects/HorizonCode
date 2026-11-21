import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { checkWorkspaceWip } from "../../src/core/wip-enforcer";
import { scanCleanState } from "../../src/core/clean-state-scanner";

describe("WIP = 1 Scope Enforcer (Lecture 07 & 08)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-wip-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("passes when no feature_list.json is present", () => {
    const res = checkWorkspaceWip(workspace);
    expect(res.allowed).toBe(true);
    expect(res.activeCount).toBe(0);
  });

  test("passes when exactly one feature is in progress with proper evidence", () => {
    const features = [
      { id: "F-1", name: "Search", status: "in_progress" },
      { id: "F-2", name: "Auth", status: "pending" },
      { id: "F-3", name: "Billing", status: "done", verification: ["tests/billing.test.ts"] },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const res = checkWorkspaceWip(workspace);
    expect(res.allowed).toBe(true);
    expect(res.activeCount).toBe(1);
    expect(res.violations).toHaveLength(0);
  });

  test("refuses when WIP > 1 (multiple active features)", () => {
    const features = [
      { id: "F-1", name: "Search", status: "in_progress" },
      { id: "F-2", name: "Auth", status: "active" },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const res = checkWorkspaceWip(workspace);
    expect(res.allowed).toBe(false);
    expect(res.activeCount).toBe(2);
    expect(res.violations[0]).toContain("WIP = 1 violation");
  });

  test("refuses when feature is marked done without verification evidence", () => {
    const features = [
      { id: "F-1", name: "Search", status: "in_progress" },
      { id: "F-2", name: "Auth", status: "done", verification: [] },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const res = checkWorkspaceWip(workspace);
    expect(res.allowed).toBe(false);
    expect(res.violations[0]).toContain("without verification evidence");
  });
});

describe("Clean State Exit Checklist (Lecture 12)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-clean-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("reports clean on clean workspace", () => {
    writeFileSync(path.join(workspace, "index.ts"), "console.log('clean');");
    const res = scanCleanState(workspace);
    expect(res.clean).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  test("detects temporary, backup, and scratch files", () => {
    writeFileSync(path.join(workspace, "file.ts.bak"), "old code");
    writeFileSync(path.join(workspace, "scratch.ts"), "throwaway test");
    const res = scanCleanState(workspace);
    expect(res.clean).toBe(false);
    expect(res.findings.length).toBeGreaterThanOrEqual(2);
    expect(res.findings.some((f) => f.category === "temporary_file")).toBe(true);
    expect(res.findings.some((f) => f.category === "scratch_file")).toBe(true);
  });
});
