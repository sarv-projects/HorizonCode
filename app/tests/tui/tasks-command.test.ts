/**
 * tasks-command.test.ts — /tasks interactive slash command and task board viewer.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BUILTIN_SLASH_REGISTRY } from "../../src/core/slash-registry";
import { loadTaskBoard } from "../../src/core/task-board";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-tasks-test-"));
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore on Windows */
  }
});

describe("/tasks slash command and task board (Ruling 867)", () => {
  test("/tasks is registered in BUILTIN_SLASH_REGISTRY", () => {
    const entry = BUILTIN_SLASH_REGISTRY.find((r) => r.name === "tasks");
    expect(entry).toBeDefined();
    expect(entry?.usage).toBe("/tasks");
    expect(entry?.description).toContain("WIP=1");
  });

  test("loadTaskBoard returns empty board when no features.json exists", () => {
    const board = loadTaskBoard(workspace);
    expect(board.ok).toBe(true);
    expect(board.items.length).toBe(0);
    expect(board.violations.length).toBe(0);
    expect(board.activeCount).toBe(0);
  });

  test("loadTaskBoard detects items and enforces WIP=1 violation when multiple items are active", () => {
    const features = [
      { id: "feat-1", name: "Task 1", status: "in_progress" },
      { id: "feat-2", name: "Task 2", status: "active" },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const board = loadTaskBoard(workspace);
    expect(board.ok).toBe(false);
    expect(board.violations.length).toBeGreaterThan(0);
    expect(board.violations[0]).toContain("WIP = 1 violation");
  });

  test("loadTaskBoard surfaces single active task cleanly", () => {
    const features = [
      { id: "feat-1", name: "Task 1", status: "passed", verification: ["bun test passed"] },
      { id: "feat-2", name: "Task 2", status: "in_progress" },
      { id: "feat-3", name: "Task 3", status: "pending" },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const board = loadTaskBoard(workspace);
    expect(board.ok).toBe(true);
    expect(board.items.length).toBe(3);
    expect(board.activeCount).toBe(1);
    expect(board.violations.length).toBe(0);
  });

  test("hzcode tasks CLI command outputs task board and status", () => {
    const features = [
      { id: "feat-1", name: "Task 1", status: "passed", verification: ["bun test passed"] },
      { id: "feat-2", name: "Task 2", status: "in_progress" },
    ];
    writeFileSync(path.join(workspace, "feature_list.json"), JSON.stringify(features));

    const { spawnSync } = require("node:child_process");
    const proc = spawnSync(
      process.execPath,
      [path.join(__dirname, "../../src/main.ts"), "tasks", "--workspace", workspace],
      { encoding: "utf8" }
    );
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain("Task Board (WIP=1, Active: 1)");
    expect(proc.stdout).toContain("[x] feat-1");
    expect(proc.stdout).toContain("[*] feat-2");
  });
});
