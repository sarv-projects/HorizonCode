import { describe, expect, test } from "bun:test";
import {
  formatCriticInterrupt,
  runAdversarialCritic,
} from "../../src/core/engineering-critic";

describe("engineering-critic (ruling 640)", () => {
  test("clean mutation with verification PASSes", () => {
    const r = runAdversarialCritic({
      goal: "fix the flaky unit test",
      changedPaths: ["app/src/core/loop.ts"],
      verifiedCommand: "bun test ./tests/core/loop.test.ts",
    });
    expect(r.verdict).toBe("PASS");
    expect(r.findings).toEqual([]);
  });

  test("mutation without verification is PASS_WITH_NOTES", () => {
    const r = runAdversarialCritic({
      goal: "tweak a comment",
      changedPaths: ["app/src/core/loop.ts"],
    });
    expect(r.verdict).toBe("PASS_WITH_NOTES");
    expect(r.findings.some((f) => f.code === "mutation_without_verification")).toBe(true);
  });

  test("secret path mutation FAILs P0", () => {
    const r = runAdversarialCritic({
      goal: "update config",
      changedPaths: ["app/.env.production"],
      verifiedCommand: "true",
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.findings.some((f) => f.code === "secret_path_mutation")).toBe(true);
    expect(formatCriticInterrupt(r)).toContain("engineering_critic");
  });

  test("enforced egress claim in added diff lines FAILs P0", () => {
    const r = runAdversarialCritic({
      goal: "document sandbox",
      changedPaths: ["docs/11-authority-safety.md"],
      verifiedCommand: "true",
      evidenceText: "--- a/docs/11\n+++ b/docs/11\n@@\n-partial\n+shell-net egress is now enforced on WSL2\n",
    });
    expect(r.verdict).toBe("FAIL");
    expect(r.findings.some((f) => f.code === "enforced_egress_claim")).toBe(true);
  });

  test("goal negation about enforced egress does not P0-fail (ruling 645)", () => {
    const r = runAdversarialCritic({
      goal: "Ensure docs never claim shell-net egress enforced",
      changedPaths: ["docs/11-authority-safety.md"],
      verifiedCommand: "true",
      evidenceText: "--- a/x\n+++ b/x\n@@\n+Never claim shell-net egress enforced.\n",
    });
    expect(r.findings.some((f) => f.code === "enforced_egress_claim")).toBe(false);
    expect(r.verdict).not.toBe("FAIL");
  });

  test("unannounced package.json change is P1", () => {
    const r = runAdversarialCritic({
      goal: "refactor the loop",
      changedPaths: ["app/package.json"],
      verifiedCommand: "bun test",
    });
    expect(r.verdict).toBe("PASS_WITH_NOTES");
    expect(r.findings.some((f) => f.code === "deps_mutation_unannounced")).toBe(true);
  });

  test("wide exported lexical reach is P1 (ruling 685)", () => {
    const r = runAdversarialCritic({
      goal: "refactor exports",
      changedPaths: ["app/src/core/loop.ts"],
      verifiedCommand: "bun test",
      symbolHighBlastRadius: true,
      symbolImpactSummary: "reach: runTurn → 14 other file(s) (lexical)",
    });
    expect(r.verdict).toBe("PASS_WITH_NOTES");
    expect(r.findings.some((f) => f.code === "exported_surface_wide_reach")).toBe(true);
  });

  test("formatCriticInterrupt includes symbol impact block (ruling 685)", () => {
    const r = runAdversarialCritic({
      goal: "x",
      changedPaths: [".env"],
      verifiedCommand: "true",
    });
    const interrupt = formatCriticInterrupt(
      r,
      "[eng-brain symbol impact — lexical refs + structural call-sites; not tree-sitter AST call-graph]\napp/x.ts: exported foo",
    );
    expect(interrupt).toContain("symbol impact");
    expect(interrupt).toContain("exported foo");
  });
});
