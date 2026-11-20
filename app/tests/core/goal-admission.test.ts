import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core";
import { sessionGoalPath } from "../../src/core/session-goal";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("setGoal under-admission (ruling 573)", () => {
  test("refuses before write when policy denies fs.write", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-goal-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-goal" }]),
        "utf8",
      );
      const runtime = await createRuntime({ workspace, mock: true });
      try {
        await expect(runtime.setGoal!("ship under admission")).rejects.toThrow(
          /goal update refused|denied|test-deny-goal/i,
        );
        expect(existsSync(sessionGoalPath(workspace, runtime.sessionId))).toBe(false);
        expect(runtime.goalStatement?.()).toBeUndefined();
      } finally {
        await runtime.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });
});
