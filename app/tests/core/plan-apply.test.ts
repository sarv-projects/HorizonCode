/**
 * plan-apply.test.ts — the /apply path through the real runtime: a staged
 * change must land through the ordinary `write` tool (guard, read-before-write
 * ledger, atomic write, change journal, receipt) and a file that moved on since
 * staging must be KEPT, not overwritten. This is the cross-module integration
 * the plan-mode slice's unit tests deliberately do not cover.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core/index";
import { stageWrite } from "../../src/core/plan";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function runtimeIn(workspace: string) {
  const runtime = await createRuntime({ workspace, mock: true });
  cleanups.push(async () => {
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const sessionId = (runtime as unknown as { sessionId: string }).sessionId;
  return { runtime, sessionId };
}

describe("applyPlan", () => {
  test("applies a staged write through the write tool and clears the stage", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-plan-apply-"));
    const { runtime, sessionId } = await runtimeIn(ws);
    const target = path.join(ws, "a.txt");
    writeFileSync(target, "old\n");
    stageWrite(sessionId, { resolved: target, rel: "a.txt", before: "old\n", after: "new\n", tool: "write" });

    const summary = await runtime.applyPlan();

    expect(summary).toContain("applied 1");
    expect(readFileSync(target, "utf8")).toBe("new\n");
    expect(runtime.stagedChanges()).toHaveLength(0);
  });

  test("creates a new file staged with no preimage", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-plan-new-"));
    const { runtime, sessionId } = await runtimeIn(ws);
    const target = path.join(ws, "fresh.txt");
    stageWrite(sessionId, { resolved: target, rel: "fresh.txt", before: null, after: "hello\n", tool: "write" });

    const summary = await runtime.applyPlan();

    expect(summary).toContain("applied 1");
    expect(readFileSync(target, "utf8")).toBe("hello\n");
  });

  test("a file that moved on since staging is kept, not overwritten", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-plan-stale-"));
    const { runtime, sessionId } = await runtimeIn(ws);
    const target = path.join(ws, "a.txt");
    writeFileSync(target, "old\n");
    stageWrite(sessionId, { resolved: target, rel: "a.txt", before: "old\n", after: "staged\n", tool: "write" });
    // The human (or another program) edits the file after staging.
    writeFileSync(target, "human edit\n");

    const summary = await runtime.applyPlan();

    expect(summary).toContain("kept 1");
    expect(summary).toContain("changed on disk");
    expect(readFileSync(target, "utf8")).toBe("human edit\n");
    expect(runtime.stagedChanges()).toHaveLength(1);
  });

  test("nothing staged is a typed answer, not a crash", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-plan-empty-"));
    const { runtime } = await runtimeIn(ws);
    const summary = await runtime.applyPlan();
    expect(summary).toContain("nothing staged");
  });
});
