/**
 * task-board.test.ts -- task board view + advisory prompts (plan Task 25).
 * Reuses the shipped WIP gate; adds no gating logic of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  loadTaskBoard,
  renderCheckerPrompt,
  renderCoordinatorPrompt,
} from "../../src/core/task-board";

let workspace = "";
afterEach(() => {
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* Windows lock */
    }
  }
  workspace = "";
});

function withFeatureList(features: unknown[]): string {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-taskboard-"));
  writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));
  return workspace;
}

describe("task board view", () => {
  test("refuses WIP>1 and unverified done; prompts are bounded and deterministic", () => {
    const ws = withFeatureList([
      { id: "a", status: "in_progress" },
      { id: "b", status: "active" },
      { id: "c", status: "done" },
    ]);
    const board = loadTaskBoard(ws);
    expect(board.ok).toBe(false);
    expect(board.activeCount).toBe(2);
    expect(board.violations.join(" ")).toMatch(/WIP = 1/);
    expect(board.violations.join(" ")).toMatch(/verification/);
    expect(board.items).toEqual([]);
    expect(renderCoordinatorPrompt(board, 120).length).toBeLessThanOrEqual(120);
    expect(renderCheckerPrompt(board)).toBe(renderCheckerPrompt(board));
  });

  test("a clean single-active board is ok and renders the active item", () => {
    const ws = withFeatureList([
      { id: "a", status: "in_progress", name: "Ship feature" },
      { id: "b", status: "pending" },
    ]);
    const board = loadTaskBoard(ws);
    expect(board.ok).toBe(true);
    expect(board.activeCount).toBe(1);
    expect(board.items).toHaveLength(2);
    expect(renderCoordinatorPrompt(board)).toContain("a");
    expect(renderCheckerPrompt(board)).toContain("verification");
  });

  test("no feature list is not a violation", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-taskboard-empty-"));
    const board = loadTaskBoard(workspace);
    expect(board.ok).toBe(true);
    expect(board.items).toEqual([]);
    expect(board.violations).toEqual([]);
  });
});
