import { describe, expect, test } from "bun:test";
import { planBestOfNWorktrees, runBestOfNRace } from "../../src/core/best-of-n";
import {
  cleanupBestOfNLoserWorktrees,
  prepareBestOfNWorktreeSlots,
  type BestOfNWorktreeShell,
} from "../../src/core/best-of-n-worktree";
import { worktreeRemoveCommand, worktreeSiblingPath } from "../../src/core/worktree";
import type { BestOfNAttempt } from "../../src/core/best-of-n";

describe("best-of-n worktree orchestration", () => {
  test("prepare runs add commands and marks provision", async () => {
    const cmds: string[] = [];
    const shell: BestOfNWorktreeShell = async (command) => {
      cmds.push(command);
      return { ok: true, output: "" };
    };
    const slots = planBestOfNWorktrees("/tmp/repo", 2, "t", {
      max: 8,
      porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
      destExists: () => false,
    });
    const prepared = await prepareBestOfNWorktreeSlots("/tmp/repo", slots, { shell });
    expect(cmds.length).toBe(2);
    expect(prepared[0]?.provision).toBe("add");
    expect(prepared[1]?.provision).toBe("add");
  });

  test("full race provisions, delegates per path, removes losers", async () => {
    const cmds: string[] = [];
    const shell: BestOfNWorktreeShell = async (command) => {
      cmds.push(command);
      return { ok: true, output: "" };
    };
    const workspaces: string[] = [];
    const race = await runBestOfNRace({
      repoRoot: "/tmp/repo",
      task: "fix",
      n: 2,
      parallel: true,
      nameStem: "wt",
      pool: {
        max: 8,
        porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
        destExists: () => false,
      },
      worktreeHooks: { shell, cleanupLosers: true },
      runner: async ({ worktreePath, slot }) => {
        workspaces.push(worktreePath);
        return { ok: slot === 1, output: `slot-${slot}` };
      },
    });
    expect(workspaces.length).toBe(2);
    expect(workspaces[0]).toBe(worktreeSiblingPath("/tmp/repo", race.attempts[0]!.worktreeName));
    expect(race.winner?.slot).toBe(1);
    expect(cmds.filter((c) => c.includes("worktree add")).length).toBe(2);
    const loserPath = race.attempts.find((a) => a.slot !== race.winner?.slot)!.worktreePath;
    expect(cmds).toContain(worktreeRemoveCommand(loserPath));
    expect(race.cleanupNotes?.length).toBeGreaterThan(0);
  });

  test("cleanup skips reuse and winner", async () => {
    const cmds: string[] = [];
    const shell: BestOfNWorktreeShell = async (command) => {
      cmds.push(command);
      return { ok: true, output: "" };
    };
    const mkAttempt = (slot: number, path: string): BestOfNAttempt => ({
      slot,
      worktreeName: `bon-wt-${slot + 1}`,
      worktreePath: path,
      decision: { kind: "reuse", dest: path, branch: `hz/x`, name: `x` },
      result: { ok: slot === 1, output: "" },
      exitClass: slot === 1 ? "succeeded" : "failed",
    });
    const a0 = mkAttempt(0, "/tmp/loser");
    const a1 = mkAttempt(1, "/tmp/winner");
    const notes = await cleanupBestOfNLoserWorktrees(
      [a0, a1],
      a1,
      { shell },
      new Map([
        [0, "reuse"],
        [1, "add"],
      ]),
    );
    expect(cmds.length).toBe(0);
    expect(notes.length).toBe(0);
  });
});