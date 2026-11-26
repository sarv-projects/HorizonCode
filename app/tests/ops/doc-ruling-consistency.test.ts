/**
 * doc-ruling-consistency.test.ts - the ruling ceiling must agree across the
 * documents an agent reads first.
 *
 * Docs lag the tree by design, but the CEILING (the highest ruling number in
 * docs/28 section 3) is a fact: every onboarding doc that cites it must cite the
 * same one. Stale ceilings are how an agent concludes the work is far behind
 * when it is not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

/** Highest numbered ruling in docs/28 section 3 ("N. **Title ..."). */
function maxRuling(): number {
  const text = read("docs/28-implementation-status.md");
  // Accept both the long form ("N. **Title**") and the consolidated form
  // ("N. note") so a recovered section still counts toward the ceiling.
  const numbers = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  return Math.max(...numbers);
}

describe("ruling ceiling consistency", () => {
  const ceiling = maxRuling();

  test("docs/28 has a sane ceiling", () => {
    expect(Number.isInteger(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThan(800);
  });


  test("FULL-BACKLOG tree state includes the current ruling ceiling", () => {
    const backlog = read("docs/FULL-BACKLOG-2026-11-13.md");
    const branch = backlog.split(/\r?\n/).find((line) => line.startsWith("| Branch |"));
    expect(branch).toBeDefined();
    expect(branch).toContain(String(ceiling));
    expect(branch).toContain("P0 spine still OPEN");
    const shipped = backlog.split(/\r?\n/).find((line) => line.startsWith("| What is **actually shipped** |"));
    expect(shipped).toBeDefined();
    expect(shipped).toContain(String(ceiling));
  });

  test("defect D-13 row reflects ruling 910 closure", () => {
    const progress = read("docs/GOAL-PROGRESS.md");
    const row = progress.split(/\r?\n/).find((line) => line.startsWith("| D-13 |"));
    expect(row).toBeDefined();
    expect(row).toContain("910");
    expect(row).toContain("hidden");
    expect(row).not.toContain("one model-facing checklist tool remains");
  });

  test("P0-2 matrix lists the current reduced shell shapes", () => {
    const status = read("docs/28-implementation-status.md");
    const row = status.split(/\r?\n/).find((line) => line.includes("| **P0-2 Postimage / Rust Observe**"));
    expect(row).toBeDefined();
    for (const shape of ["truncate", "install", "rmdir"]) {
      expect(row).toContain(shape);
    }
    for (const ruling of ["920", "921", "943"]) {
      expect(row).toContain(ruling);
    }
    const rmdirRuling = status.split(/\r?\n/).find((line) => line.startsWith("943."));
    expect(rmdirRuling).toBeDefined();
    expect(rmdirRuling).not.toContain("``");
    expect(rmdirRuling).toContain("`enforced`");
  });

  for (const doc of [
    "docs/28-implementation-status.md",
    "docs/00-index.md",
    "docs/AGENT-DOC-NAVIGATION.md",
    "AGENTS.md",
    "docs/GOAL-PROGRESS.md",
  ]) {
    test(doc + " cites the current ceiling", () => {
      // Only the HEADER is a claim about the current ceiling; ruling bodies
      // legitimately cite historical numbers (668, 736, 803, 822, ...).
      const text = read(doc).split(/\r?\n/).slice(0, 40).join("\n");
      const cited = [...text.matchAll(/through (?:ruling )?\*{0,2}(\d{3})/g)].map((m) => Number(m[1]));
      expect(cited.length).toBeGreaterThan(0);
      const rows = text.split(/\r?\n/);
      for (const n of cited) {
        const line =
          rows.find((l) => l.includes("through **" + n + "**")) ??
          rows.find((l) => l.includes("through " + n)) ??
          "";
        if (/historical|archive/i.test(line)) continue;
        expect(n).toBe(ceiling);
      }
    });
  }
});