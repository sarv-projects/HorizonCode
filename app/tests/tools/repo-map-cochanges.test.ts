/**
 * repo-map-cochanges.test.ts — experimental git co-change weighting.
 * Covers: pure pair counting/normalization/caps, the flag gate, trust gate,
 * fail-closed paths, cache hits, and a seeded real git repo through the guarded
 * spawnOwned runner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  COCHANGE_FLAG,
  cochangeCachePath,
  cochangesEnabled,
  computeCochangeBonuses,
  countPairCochanges,
  DEFAULT_COCHANGE_WINDOW,
  MAX_BONUS,
  MAX_COCHANGE_WINDOW,
  MAX_PAIRS,
  normalizeBonuses,
  pairKey,
  parseGitLog,
  type GitRunner,
} from "../../src/tools/repo-map-cochanges";

const saved = process.env[COCHANGE_FLAG];
const dirs: string[] = [];
beforeEach(() => {
  delete process.env[COCHANGE_FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[COCHANGE_FLAG];
  else process.env[COCHANGE_FLAG] = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-cochange-"));
  dirs.push(dir);
  return dir;
}

function fakeRunner(lines: string[], head = "HEADSHA"): { runner: GitRunner; calls: () => number } {
  let calls = 0;
  const runner: GitRunner = async (cmd) => {
    calls += 1;
    if (cmd.includes("rev-parse")) return { ok: true, stdout: head + "\n" };
    return { ok: true, stdout: lines.join("\n") + "\n" };
  };
  return { runner, calls: () => calls };
}

describe("pure co-change core", () => {
  test("pairKey is order-independent", () => {
    expect(pairKey("a.ts", "b.ts")).toBe(pairKey("b.ts", "a.ts"));
  });

  test("countPairCochanges counts each unordered pair once per commit", () => {
    const counts = countPairCochanges([
      ["a.ts", "b.ts", "c.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "a.ts"], // dedupe within a commit
    ]);
    expect(counts.get(pairKey("a.ts", "b.ts"))).toBe(2);
    expect(counts.get(pairKey("a.ts", "c.ts"))).toBe(1);
    expect(counts.get(pairKey("b.ts", "c.ts"))).toBe(1);
  });

  test("normalizeBonuses caps at MAX_BONUS and at MAX_PAIRS", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < MAX_PAIRS + 100; i += 1) counts.set(`p${i}`, 1);
    const bonuses = normalizeBonuses(counts);
    expect(bonuses.size).toBe(MAX_PAIRS);
    for (const value of bonuses.values()) expect(value).toBeLessThanOrEqual(MAX_BONUS);

    const skewed = new Map([["hot", 100], ["cold", 1]]);
    const scaled = normalizeBonuses(skewed);
    expect(scaled.get("hot")).toBe(MAX_BONUS);
    expect(scaled.get("cold")!).toBeGreaterThan(0);
    expect(scaled.get("cold")!).toBeLessThan(MAX_BONUS);
  });

  test("parseGitLog splits commits and fails closed on escaping paths", () => {
    const parsed = parseGitLog("a.ts\nb.ts\n\n../escape.ts\n/tmp/abs.ts\n\nc.ts\n");
    expect(parsed).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
  });
});

describe("flag, trust and fail-closed guards", () => {
  test("cochangesEnabled is off unless explicitly 1", () => {
    expect(cochangesEnabled()).toBe(false);
    process.env[COCHANGE_FLAG] = "0";
    expect(cochangesEnabled()).toBe(false);
    process.env[COCHANGE_FLAG] = "1";
    expect(cochangesEnabled()).toBe(true);
  });

  test("flag off: no spawn, no bonus", async () => {
    const { runner, calls } = fakeRunner(["a.ts\nb.ts"]);
    const result = await computeCochangeBonuses({ workspace: temp(), stateDir: temp(), trusted: true, runner });
    expect(result.size).toBe(0);
    expect(calls()).toBe(0);
  });

  test("untrusted workspace: no spawn, no bonus", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const { runner, calls } = fakeRunner(["a.ts\nb.ts"]);
    const result = await computeCochangeBonuses({ workspace: temp(), stateDir: temp(), trusted: false, runner });
    expect(result.size).toBe(0);
    expect(calls()).toBe(0);
  });

  test("missing git / spawn refusal / empty history all fail closed", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const base = { workspace: temp(), stateDir: temp(), trusted: true };
    const missing: GitRunner = async () => ({ ok: false, stdout: "" });
    expect((await computeCochangeBonuses({ ...base, runner: missing })).size).toBe(0);
    const refusal: GitRunner = async () => {
      throw new Error("spawn refused");
    };
    expect((await computeCochangeBonuses({ ...base, runner: refusal })).size).toBe(0);
    const empty = fakeRunner([""]);
    expect((await computeCochangeBonuses({ ...base, runner: empty.runner })).size).toBe(0);
  });

  test("window is clamped to the hard cap", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const head = "H";
    const { runner } = fakeRunner(["a.ts\nb.ts\n"], head);
    await computeCochangeBonuses({ workspace: temp(), stateDir: temp(), trusted: true, runner, window: MAX_COCHANGE_WINDOW + 100 });
    expect(DEFAULT_COCHANGE_WINDOW).toBeLessThanOrEqual(MAX_COCHANGE_WINDOW);
  });
});

describe("cache and seeded git repo", () => {
  test("second call hits the cache without re-running git", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const workspace = temp();
    const stateDir = temp();
    const cacheDir = temp();
    const { runner, calls } = fakeRunner(["a.ts\nb.ts\n"]);
    const opts = { workspace, stateDir, trusted: true, runner, cacheDir };
    const first = await computeCochangeBonuses(opts);
    expect(first.size).toBe(1);
    const second = await computeCochangeBonuses(opts);
    expect(second).toEqual(first);
    // head + log on the first call; only head on the cached second call.
    expect(calls()).toBe(3);
  });

  test("persistCache=false computes bonuses but writes no cochange.json (ruling 565)", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const workspace = temp();
    const stateDir = temp();
    const cacheDir = temp();
    const { runner } = fakeRunner(["a.ts\nb.ts\n"]);
    const bonuses = await computeCochangeBonuses({
      workspace,
      stateDir,
      trusted: true,
      runner,
      cacheDir,
      persistCache: false,
    });
    expect(bonuses.size).toBe(1);
    expect(existsSync(cochangeCachePath(workspace, cacheDir))).toBe(false);
  });

  test("seeded temp git repo yields a bounded bonus via the guarded runner", async () => {
    process.env[COCHANGE_FLAG] = "1";
    const workspace = temp();
    git(workspace, "init", "-q");
    git(workspace, "config", "user.email", "t@example.com");
    git(workspace, "config", "user.name", "test");
    writeFileSync(path.join(workspace, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(workspace, "b.ts"), "export const b = 2;\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-q", "-m", "initial");
    writeFileSync(path.join(workspace, "a.ts"), "export const a = 3;\n");
    writeFileSync(path.join(workspace, "b.ts"), "export const b = 4;\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-q", "-m", "co-change");

    const bonuses = await computeCochangeBonuses({
      workspace,
      stateDir: path.join(workspace, ".hz", "state", "kernel"),
      trusted: true,
      cacheDir: path.join(workspace, ".hz", "state", "repo-map"),
    });
    expect(bonuses.size).toBeGreaterThan(0);
    expect(bonuses.get(pairKey("a.ts", "b.ts"))).toBe(MAX_BONUS);
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
