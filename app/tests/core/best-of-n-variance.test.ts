import { describe, expect, test } from "bun:test";
import {
  calculateBestOfNVariance,
  formatBestOfNRaceOutput,
  runBestOfNRace,
  type BestOfNAttempt,
} from "../../src/core/best-of-n";
import { prepareBestOfNWorktreeSlots, type BestOfNWorktreeShell } from "../../src/core/best-of-n-worktree";
import { worktreeResetCommand } from "../../src/core/worktree";

describe("best-of-n variance and reset-before-reuse", () => {
  test("variance calculation handles empty, single, and multiple attempts", () => {
    expect(calculateBestOfNVariance([])).toBeUndefined();

    const mkAttempt = (slot: number, exitClass: "succeeded" | "failed" | "unknown", ok: boolean, verified?: string): BestOfNAttempt => ({
      slot,
      worktreeName: `bon-test-${slot}`,
      worktreePath: `/tmp/worktree-${slot}`,
      decision: { kind: "reuse", dest: `/tmp/worktree-${slot}`, branch: "main", name: `slot-${slot}` },
      result: { ok, output: "test output" },
      exitClass,
      verifiedCommand: verified,
    });

    const single = [mkAttempt(0, "succeeded", true, "bun test")];
    const stats1 = calculateBestOfNVariance(single);
    expect(stats1).toBeDefined();
    expect(stats1?.min).toBe(stats1?.max);
    expect(stats1?.variance).toBe(0);
    expect(stats1?.spread).toBe(0);

    const multi = [
      mkAttempt(0, "succeeded", true, "bun test"), // score: 3000 + 100 + 10 = 3110
      mkAttempt(1, "failed", false), // score: 1000 + 0 + 0 = 1000
    ];
    const stats2 = calculateBestOfNVariance(multi);
    expect(stats2).toBeDefined();
    expect(stats2?.scores).toEqual([3110, 1000]);
    expect(stats2?.min).toBe(1000);
    expect(stats2?.max).toBe(3110);
    expect(stats2?.spread).toBe(2110);
    expect(stats2?.mean).toBe(2055);
    expect(stats2?.stdDev).toBeGreaterThan(1000);
  });

  test("formatBestOfNRaceOutput includes score distribution when attempts > 1", () => {
    const race = {
      winner: {
        slot: 0,
        worktreeName: "bon-test-0",
        worktreePath: "/tmp/worktree-0",
        decision: { kind: "reuse" as const, dest: "/tmp/0", branch: "main", name: "0" },
        result: { ok: true, output: "winner done" },
        exitClass: "succeeded" as const,
      },
      attempts: [
        {
          slot: 0,
          worktreeName: "bon-test-0",
          worktreePath: "/tmp/worktree-0",
          decision: { kind: "reuse" as const, dest: "/tmp/0", branch: "main", name: "0" },
          result: { ok: true, output: "winner done" },
          exitClass: "succeeded" as const,
        },
        {
          slot: 1,
          worktreeName: "bon-test-1",
          worktreePath: "/tmp/worktree-1",
          decision: { kind: "reuse" as const, dest: "/tmp/1", branch: "main", name: "1" },
          result: { ok: false, output: "failed" },
          exitClass: "failed" as const,
        },
      ],
      n: 2,
      parallel: true,
      variance: {
        scores: [3010, 1000],
        min: 1000,
        max: 3010,
        mean: 2005,
        variance: 1010025,
        stdDev: 1005,
        spread: 2010,
      },
    };
    const formatted = formatBestOfNRaceOutput(race);
    expect(formatted).toContain("score distribution: min=1000 max=3010 mean=2005 stdDev=1005 spread=2010");
  });

  test("prepareBestOfNWorktreeSlots executes reset before reuse on existing slot", async () => {
    const executedCmds: string[] = [];
    const shell: BestOfNWorktreeShell = async (cmd) => {
      executedCmds.push(cmd);
      return { ok: true, output: "HEAD is now at 1234567" };
    };

    const slots = [
      {
        slot: 0,
        name: "slot-0",
        path: "/tmp/repo-slot-0",
        decision: { kind: "reuse" as const, dest: "/tmp/repo-slot-0", branch: "hz/slot-0", name: "slot-0" },
      },
    ];

    const prepared = await prepareBestOfNWorktreeSlots("/tmp/repo", slots, { shell, resetOnReuse: true });
    expect(prepared.length).toBe(1);
    expect(prepared[0]?.provision).toBe("reuse");
    expect(executedCmds.length).toBe(1);
    expect(executedCmds[0]).toBe(worktreeResetCommand("/tmp/repo-slot-0"));
  });

  test("prepareBestOfNWorktreeSlots refuses slot if reset command fails", async () => {
    const shell: BestOfNWorktreeShell = async () => ({
      ok: false,
      output: "fatal: not a git repository",
    });

    const slots = [
      {
        slot: 0,
        name: "slot-0",
        path: "/tmp/repo-slot-0",
        decision: { kind: "reuse" as const, dest: "/tmp/repo-slot-0", branch: "hz/slot-0", name: "slot-0" },
      },
    ];

    const prepared = await prepareBestOfNWorktreeSlots("/tmp/repo", slots, { shell, resetOnReuse: true });
    expect(prepared.length).toBe(1);
    expect(prepared[0]?.decision.kind).toBe("refuse");
    expect(prepared[0]?.provision).toBeUndefined();
  });
});
