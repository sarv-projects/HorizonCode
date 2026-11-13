import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SECTION_SOFT_CAP_CHARS,
  collectSectionWarnings,
  createHandoff,
  normalizeHandoffSections,
  resetHandoffsForTests,
  handoffDbPath,
  resolveHandoffBranch,
  resumeHandoff,
  searchHandoffs,
} from "../../src/core/memory/handoff";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

function initGitRepo(dir: string, branch = "feat/handoff-test"): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git checkout -b main", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "handoff test\n");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync('git -c user.email=t@t.com -c user.name=t commit -m init', { cwd: dir, stdio: "ignore" });
  if (branch !== "main") execSync(`git checkout -b ${branch}`, { cwd: dir, stdio: "ignore" });
}

describe("handoff core", () => {
  test("refuses todos section", () => {
    const r = normalizeHandoffSections({ summary: "ok", todos: ["x"] });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("todos");
  });

  test("create → resume continues_from chain oldest→newest (max 5)", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hndchain-"));
    initGitRepo(workspace);
    resetHandoffsForTests(workspace);
    const a = createHandoff(workspace, { summary: "session A", tried: ["ran tests"] }, { continues_from: null });
    const b = createHandoff(workspace, { summary: "session B", blockers: ["flake"] });
    const c = createHandoff(workspace, { summary: "session C" });
    expect(b.continues_from).toBe(a.id);
    expect(c.continues_from).toBe(b.id);
    const resumed = resumeHandoff(workspace);
    expect(resumed.latest_handoff_id).toBe(c.id);
    expect(resumed.chain).toEqual([a.id, b.id, c.id]);
    expect(resumed.open_blockers).toEqual([]);
    const resumedB = resumeHandoff(workspace, { handoff_id: b.id });
    expect(resumedB.chain).toEqual([a.id, b.id]);
  });

  test("BM25 search finds section text", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hndsearch-"));
    resetHandoffsForTests(workspace);
    createHandoff(workspace, {
      summary: "deploy pipeline",
      tried: ["landlock egress proxy tuning"],
      decisions: ["stay with BM25 only"],
    });
    const { matches } = searchHandoffs(workspace, "landlock egress");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.section_text.toLowerCase()).toContain("landlock");
  });

  test("non-git workspace uses detached scope", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hnddet-"));
    mkdirSync(path.join(workspace, ".hz", "state"), { recursive: true });
    const { branch, detached } = resolveHandoffBranch(workspace);
    expect(detached).toBe(true);
    expect(branch.startsWith("detached:")).toBe(true);
    const created = createHandoff(workspace, { summary: "no git here" }, { continues_from: null });
    expect(created.branch).toBe(branch);
    const resumed = resumeHandoff(workspace);
    expect(resumed.latest_handoff_id).toBe(created.id);
    expect(resumed.message).toContain("detached");
  });

  test("oversized section yields warning but stores", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hndwarn-"));
    const big = "x".repeat(SECTION_SOFT_CAP_CHARS + 10);
    const warnings = collectSectionWarnings({ summary: big });
    expect(warnings.some((w) => w.includes("summary"))).toBe(true);
    const created = createHandoff(workspace, { summary: big }, { continues_from: null });
    expect(created.warnings.length).toBeGreaterThan(0);
    expect(existsSync(handoffDbPath(workspace))).toBe(true);
  });

  test("resume query ranks matching sections", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hndq-"));
    resetHandoffsForTests(workspace);
    createHandoff(workspace, { summary: "alpha", tried: ["benchmark sqlite fts"] });
    createHandoff(workspace, { summary: "beta", context: "unrelated cooking notes" });
    const resumed = resumeHandoff(workspace, { query: "sqlite fts benchmark" });
    expect(resumed.top_sections.length).toBeGreaterThan(0);
    expect(resumed.top_sections[0]!.section_text.toLowerCase()).toMatch(/sqlite|fts|benchmark/);
  });
});
