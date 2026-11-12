/** Manual dream consolidation plan (docs/33 §5.4). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildDreamPlanMarkdown, writeDreamPlan } from "../../src/core/memory/dream";
import { replaceMemoryIndex } from "../../src/core/memory/store";
import { stateRoot } from "../../src/core/paths";
import { runGrowCli } from "../../src/grow";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function ws(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-dream-"));
  roots.push(dir);
  return dir;
}

describe("dream plan", () => {
  test("buildDreamPlanMarkdown lists facts and never claims apply", () => {
    const md = buildDreamPlanMarkdown("/tmp/ws", ["fact-a", "fact-b"]);
    expect(md).toContain("fact-a");
    expect(md).toContain("Origin: `dream`");
    expect(md).toContain("No automatic write performed");
  });

  test("writeDreamPlan writes under .hz/dream and leaves MEMORY.md alone", () => {
    const dir = ws();
    const root = stateRoot(dir);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "MEMORY.md"), "- remember the river\n", { mode: 0o600 });
    replaceMemoryIndex(dir, ["remember the river", "second fact"]);
    const before = readFileSync(path.join(root, "MEMORY.md"), "utf8");
    const result = writeDreamPlan(dir);
    expect(result.factCount).toBeGreaterThan(0);
    expect(result.planPath.includes(`${path.sep}dream${path.sep}`)).toBe(true);
    expect(readFileSync(result.planPath, "utf8")).toContain("remember the river");
    expect(readFileSync(path.join(root, "MEMORY.md"), "utf8")).toBe(before);
  });

  test("grow --dream exits 0 and prints the plan path", async () => {
    const dir = ws();
    const lines: string[] = [];
    const code = await runGrowCli(["--dream", "--workspace", dir], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("grow --dream:") && l.includes("plan-"))).toBe(true);
  });
});
