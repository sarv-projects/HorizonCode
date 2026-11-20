import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type RepoMapFileEntry } from "../../src/tools/repo-map-cache";
import { repoMapTool, resetRepoMapCache } from "../../src/tools/repo-map";
import {
  buildExportedSymbolGraph,
  importersOfSymbol,
  loadSymbolGraphFile,
  renderSymbolGraphSection,
  saveSymbolGraph,
  symbolGraphCachePath,
} from "../../src/tools/symbol-graph";
import { buildMutationSymbolImpact } from "../../src/core/engineering-critic-impact";
import { makeWorkspace, mockToolContext, writeFixture } from "./helpers";

const FIXTURE: Record<string, string> = {
  "src/a.ts": "export function alpha() {\n  return beta();\n}\n",
  "src/b.ts": "export function beta() {\n  return alpha() + 1;\n}\nconst localOnly = 1;\n",
  "src/c.ts": "const x = alpha();\nexport const gamma = x;\n",
};

function entry(defs: string[], exported: boolean[], refs: Record<string, number>): RepoMapFileEntry {
  return { mtimeMs: 1, size: 10, defs, exported, refs };
}

describe("symbol-graph (ruling 713)", () => {
  afterEach(() => {
    delete process.env.HZ_SYMBOL_GRAPH;
    resetRepoMapCache();
  });

  test("buildExportedSymbolGraph records cross-file lexical importers", () => {
    const index = new Map<string, RepoMapFileEntry>([
      ["src/a.ts", entry(["alpha"], [true], { alpha: 1, beta: 1 })],
      ["src/b.ts", entry(["beta"], [true], { beta: 1, alpha: 1 })],
      ["src/c.ts", entry(["gamma"], [true], { gamma: 1, alpha: 1 })],
    ]);
    const g = buildExportedSymbolGraph(index);
    expect(g.symbols.alpha?.definePaths).toEqual(["src/a.ts"]);
    expect(g.symbols.alpha?.importers.sort()).toEqual(["src/b.ts", "src/c.ts"]);
    expect(g.symbols.beta?.importers).toEqual(["src/a.ts"]);
    expect(g.symbols.gamma?.importers).toEqual([]);
    expect(importersOfSymbol(g, "alpha", new Set(["src/a.ts"])).sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("ignores non-exported defs for adjacency keys", () => {
    const index = new Map<string, RepoMapFileEntry>([
      ["src/x.ts", entry(["secret", "pub"], [false, true], { secret: 3, pub: 1 })],
      ["src/y.ts", entry([], [], { secret: 2, pub: 1 })],
    ]);
    const g = buildExportedSymbolGraph(index);
    expect(g.symbols.secret).toBeUndefined();
    expect(g.symbols.pub?.importers).toEqual(["src/y.ts"]);
  });

  test("renderSymbolGraphSection supports query narrowing", () => {
    const g = buildExportedSymbolGraph(
      new Map([["src/a.ts", entry(["alpha"], [true], { alpha: 1 })], ["src/b.ts", entry([], [], { alpha: 1 })]]),
    );
    const out = renderSymbolGraphSection(g, { query: "alpha", maxImporters: 4 });
    expect(out).toContain("lexical exported adjacency");
    expect(out).toContain("alpha");
    expect(out).toContain("src/b.ts");
  });

  test("save and load round-trip", () => {
    const ws = makeWorkspace({ "src/m.ts": "export function m() {}\n" });
    const file = symbolGraphCachePath(ws);
    const graph = buildExportedSymbolGraph(
      new Map([["src/m.ts", entry(["m"], [true], { m: 1 })]]),
    );
    const save = saveSymbolGraph(file, graph);
    expect(save.ok).toBe(true);
    const loaded = loadSymbolGraphFile(file);
    expect(loaded.kind).toBe("valid");
    if (loaded.kind === "valid") {
      expect(loaded.graph.symbols.m?.definePaths).toEqual(["src/m.ts"]);
    }
    rmSync(ws, { recursive: true, force: true });
  });

  test("repo_map symbolGraph arg appends adjacency slice", async () => {
    const ws = makeWorkspace(FIXTURE);
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const r = await repoMapTool.execute({ symbolGraph: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[symbol_graph:");
    expect(r.output).toContain("alpha");
    rmSync(ws, { recursive: true, force: true });
  });

  test("HZ_SYMBOL_GRAPH persists graph on map call", async () => {
    const ws = makeWorkspace(FIXTURE);
    process.env.HZ_SYMBOL_GRAPH = "1";
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    await repoMapTool.execute({}, ctx);
    const graphPath = symbolGraphCachePath(ws);
    const loaded = loadSymbolGraphFile(graphPath);
    expect(loaded.kind).toBe("valid");
    if (loaded.kind === "valid") {
      expect(loaded.graph.symbols.alpha?.importers.length).toBeGreaterThan(0);
    }
    if (process.platform !== "win32") {
      expect(statSync(graphPath).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(graphPath)).mode & 0o777).toBe(0o700);
    }
    rmSync(ws, { recursive: true, force: true });
  });

  test("eng critic uses persisted graph when HZ_SYMBOL_GRAPH=1", () => {
    const ws = makeWorkspace({});
    mkdirSync(path.join(ws, "pkg"), { recursive: true });
    writeFileSync(path.join(ws, "pkg", "hub.ts"), `export function hubSymbol() { return 1; }\n`);
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(ws, "pkg", `use${i}.ts`), `const x = hubSymbol();\n`);
    }
    const index = new Map<string, RepoMapFileEntry>();
    index.set("pkg/hub.ts", entry(["hubSymbol"], [true], { hubSymbol: 1 }));
    for (let i = 0; i < 12; i++) {
      index.set(`pkg/use${i}.ts`, entry([], [], { hubSymbol: 1 }));
    }
    const graphPath = symbolGraphCachePath(ws);
    mkdirSync(path.dirname(graphPath), { recursive: true });
    saveSymbolGraph(graphPath, buildExportedSymbolGraph(index));
    chmodSync(path.dirname(graphPath), 0o700);
    chmodSync(graphPath, 0o600);
    process.env.HZ_SYMBOL_GRAPH = "1";
    const r = buildMutationSymbolImpact(ws, ["pkg/hub.ts"]);
    expect(r?.highBlastRadius).toBe(true);
    expect(r?.exportedReach.find((e) => e.name === "hubSymbol")?.otherFileRefs).toBe(12);
    rmSync(ws, { recursive: true, force: true });
  });
});