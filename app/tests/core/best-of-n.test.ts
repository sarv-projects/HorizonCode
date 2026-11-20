import { describe, expect, test } from "bun:test";
import {
  bestOfNCountFromEnv,
  bestOfNParallelFromEnv,
  bestOfNRacingEnabledFromEnv,
  clampBestOfN,
  classifyBestOfNExit,
  hermeticBestOfNSelfCheck,
  pickBestOfNAttempt,
  planBestOfNWorktrees,
  resolveBestOfNAttemptCount,
  runBestOfNRace,
  scoreBestOfNAttempt,
} from "../../src/core/best-of-n";

describe("best-of-n core", () => {
  test("clamp and env", () => {
    expect(clampBestOfN(0)).toBe(1);
    expect(clampBestOfN(9)).toBe(4);
    expect(bestOfNCountFromEnv({ HZ_BEST_OF_N: "3" })).toBe(3);
    expect(bestOfNCountFromEnv({})).toBe(0);
    expect(bestOfNRacingEnabledFromEnv({})).toBe(false);
    expect(bestOfNRacingEnabledFromEnv({ HZ_BEST_OF_N: "2" })).toBe(true);
    expect(bestOfNParallelFromEnv({})).toBe(false);
    expect(bestOfNParallelFromEnv({ HZ_BEST_OF_N_PARALLEL: "1" })).toBe(true);
    expect(resolveBestOfNAttemptCount(3, {})).toBeUndefined();
    expect(resolveBestOfNAttemptCount(undefined, { HZ_BEST_OF_N: "2" })).toBe(2);
    expect(hermeticBestOfNSelfCheck().ok).toBe(true);
  });

  test("classify exit and score prefers verified command", () => {
    expect(classifyBestOfNExit({ ok: true, output: "done" })).toBe("succeeded");
    expect(classifyBestOfNExit({ ok: false, output: "partial", error: "" })).toBe("unknown");
    const withVerify = {
      slot: 0,
      worktreeName: "a",
      worktreePath: "/w",
      decision: { kind: "reuse" as const, dest: "/w", branch: "hz/a", name: "a" },
      result: { ok: true, output: "" },
      exitClass: "succeeded" as const,
      verifiedCommand: "bun test",
    };
    const without = { ...withVerify, verifiedCommand: undefined, slot: 1 };
    expect(scoreBestOfNAttempt(withVerify)).toBeGreaterThan(scoreBestOfNAttempt(without));
  });

  test("pick first success then score tie-break", () => {
    const mk = (slot: number, exitClass: "succeeded" | "unknown" | "failed", ok: boolean) => ({
      slot,
      worktreeName: `s${slot}`,
      worktreePath: `/w/${slot}`,
      decision: { kind: "reuse" as const, dest: `/w/${slot}`, branch: `hz/s${slot}`, name: `s${slot}` },
      result: { ok, output: String(slot) },
      exitClass,
    });
    const picked = pickBestOfNAttempt([mk(2, "failed", false), mk(1, "succeeded", true), mk(0, "succeeded", true)]);
    expect(picked?.slot).toBe(0);
    const scored = pickBestOfNAttempt([mk(0, "unknown", false), mk(1, "failed", false)]);
    expect(scored?.slot).toBe(0);
  });

  test("plans distinct worktree slots", () => {
    const slots = planBestOfNWorktrees("/tmp/repo", 2, "sess-abc", {
      max: 8,
      porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
      destExists: () => false,
    });
    expect(slots.length).toBe(2);
    expect(slots[0]?.name).not.toBe(slots[1]?.name);
    expect(slots[0]?.decision.kind).toBe("add");
  });

  test("sequential stops at first success", async () => {
    let calls = 0;
    const race = await runBestOfNRace({
      repoRoot: "/tmp/repo",
      task: "fix it",
      n: 3,
      nameStem: "t",
      pool: {
        max: 8,
        porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
        destExists: () => false,
      },
      runner: async ({ slot }) => {
        calls += 1;
        if (slot === 1) return { ok: true, output: "winner-1" };
        return { ok: false, output: "", error: "nope" };
      },
    });
    expect(race.winner?.slot).toBe(1);
    expect(calls).toBe(2);
  });

  test("refused slot skips runner", async () => {
    let calls = 0;
    const race = await runBestOfNRace({
      repoRoot: "/tmp/repo",
      task: "fix it",
      n: 1,
      nameStem: "t",
      pool: {
        max: 8,
        porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
        destExists: () => false,
      },
      worktreeHooks: {
        shell: async () => ({ ok: false, output: "pool busy" }),
      },
      runner: async () => {
        calls += 1;
        return { ok: true, output: "" };
      },
    });
    expect(calls).toBe(0);
    expect(race.attempts[0]?.exitClass).toBe("failed");
  });

  test("parallel collects all and picks best score", async () => {
    let calls = 0;
    const race = await runBestOfNRace({
      repoRoot: "/tmp/repo",
      task: "fix it",
      n: 2,
      parallel: true,
      nameStem: "t",
      pool: {
        max: 8,
        porcelain: `worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n`,
        destExists: () => false,
      },
      runner: async ({ slot }) => {
        calls += 1;
        if (slot === 1) {
          return { ok: true, output: "b", verifiedCommand: "bun test" };
        }
        return { ok: false, output: "a", exitClass: "unknown" };
      },
    });
    expect(calls).toBe(2);
    expect(race.winner?.slot).toBe(1);
  });
});