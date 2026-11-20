import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMutationSymbolImpact } from "../../src/core/engineering-critic-impact";

const root = mkdtempSync(path.join(tmpdir(), "eng-critic-impact-"));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
  }
});

describe("engineering-critic-impact (ruling 685)", () => {
  test("summarizes exported defs on mutated paths", () => {
    const ws = path.join(root, "summarize");
    mkdirSync(path.join(ws, "src"), { recursive: true });
    writeFileSync(
      path.join(ws, "src", "mod.ts"),
      `export function alpha() {}\nexport const beta = 1;\nfunction gamma() {}\n`,
    );
    const r = buildMutationSymbolImpact(ws, ["src/mod.ts"]);
    expect(r).toBeDefined();
    expect(r!.summary).toContain("alpha");
    expect(r!.summary).toContain("src/mod.ts");
    expect(r!.highBlastRadius).toBe(false);
  });

  test("lexical-only mentions do not inflate structural call reach", () => {
    const ws = path.join(root, "lexical-only");
    mkdirSync(path.join(ws, "pkg"), { recursive: true });
    writeFileSync(path.join(ws, "pkg", "hub.ts"), `export function hubSymbol() { return 1; }\n`);
    writeFileSync(
      path.join(ws, "pkg", "noise.ts"),
      `// hubSymbol is documented here\nconst doc = "hubSymbol";\n`,
    );
    const r = buildMutationSymbolImpact(ws, ["pkg/hub.ts"]);
    expect(r).toBeDefined();
    const reach = r!.exportedReach.find((e) => e.name === "hubSymbol");
    expect(reach?.otherFileRefs).toBeGreaterThanOrEqual(1);
    expect(reach?.otherFileCallSites).toBe(0);
    expect(r!.highBlastRadius).toBe(false);
  });

  test("flags high blast radius when exported symbol appears in many files", () => {
    const ws = path.join(root, "blast");
    mkdirSync(path.join(ws, "pkg"), { recursive: true });
    writeFileSync(path.join(ws, "pkg", "hub.ts"), `export function hubSymbol() { return 1; }\n`);
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(ws, "pkg", `use${i}.ts`), `const x = hubSymbol();\nexport const u${i} = x;\n`);
    }
    const r = buildMutationSymbolImpact(ws, ["pkg/hub.ts"]);
    expect(r).toBeDefined();
    expect(
      r!.exportedReach.some(
        (e) => e.name === "hubSymbol" && e.otherFileRefs >= 10 && e.otherFileCallSites >= 10,
      ),
    ).toBe(true);
    expect(r!.highBlastRadius).toBe(true);
    expect(r!.summary).toContain("reach:");
  });
});