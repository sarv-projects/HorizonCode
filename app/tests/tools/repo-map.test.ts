/** repo-map.test.ts — B-1: the repo_map tool (docs/09 §4.2 contract).
 *
 * The map is deterministic (byte-stable), budget-bounded with a truncation
 * marker, focus-personalised, test-excluding by default, and admits one
 * `fs.read` per call.
 */

import { describe, expect, test } from "bun:test";
import { rmSync, utimesSync } from "node:fs";
import path from "node:path";
import {
  buildRepoMap,
  countIdents,
  extractDefs,
  isTestPath,
  pickByBudget,
  rankFiles,
  renderMap,
  RepoFileScanCache,
  repoMapCacheStats,
  resetRepoMapCache,
  repoMapTool,
} from "../../src/tools/repo-map";
import { makeWorkspace, mockToolContext, writeFixture } from "./helpers";

const FIXTURE = {
  "src/a.ts": "export function alpha() {\n  return beta();\n}\n",
  "src/b.ts": "export function beta() {\n  return alpha() + 1;\n}\n",
  "src/c.ts": "export const gamma = 1;\n",
  "tests/a.test.ts": "export function testAlpha() {\n  return alpha();\n}\n",
};

function manyFiles(n: number): Record<string, string> {
  const ws: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(2, "0");
    const next = String((i + 1) % n).padStart(2, "0");
    ws[`src/f${id}.ts`] =
      `export function fn${id}() {\n  return fn${next}();\n}\nexport const v${id} = 1;\nexport const w${id} = 2;\n`;
  }
  return ws;
}

/* --------------------------------- parts --------------------------------- */

describe("the building blocks", () => {
  test("defs: exported surface first, then locals; per-language patterns capture names", () => {
    expect(extractDefs("function helper() {}\nexport function foo() {}\nexport const bar = 1;\nfunction foo() {}", ".ts")).toEqual([
      "foo",
      "bar",
      "helper",
    ]);
    expect(extractDefs("fn helper() {}\npub fn run() {}\nstruct Job {}\npub struct S {}", ".rs")).toEqual(["run", "S", "helper", "Job"]);
    expect(extractDefs("class A:\n    def method(self):\n        pass\n", ".py")).toEqual(["method", "A"]);
    expect(extractDefs("func main() {}\ntype T struct{}", ".go")).toEqual(["main", "T"]);
  });

  test("isTestPath: test-looking paths, and only those", () => {
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("src/test_widget.py")).toBe(true);
    expect(isTestPath("src/widget_test.go")).toBe(true);
    expect(isTestPath("src/a.ts")).toBe(false);
    expect(isTestPath("contest.md")).toBe(false);
  });

  test("pagerank: a node with in-edges outranks an isolated node; focus lifts its target", () => {
    const files = ["A", "B", "C"];
    const edges = new Map([
      ["A", new Map([["B", 1]])],
      ["C", new Map([["B", 1]])],
    ]);
    const plain = rankFiles(files, edges);
    expect(plain.get("B") ?? 0).toBeGreaterThan(plain.get("A") ?? 0);

    const focused = rankFiles(files, edges, new Map([["A", 1]]));
    expect(focused.get("A") ?? 0).toBeGreaterThan(focused.get("C") ?? 0);

    // Deterministic: same inputs, same ranks.
    const again = rankFiles(files, edges, new Map([["A", 1]]));
    expect(again.get("A")).toBe(focused.get("A"));
  });

  test("pickByBudget: binary search is monotonic and exact at the edges", () => {
    const ranked = Array.from({ length: 10 }, (_, i) => ({
      rel: `src/f${String(i).padStart(2, "0")}.ts`,
      defs: ["a", "b", "c", "d", "e"],
      rank: 10 - i,
    }));
    expect(pickByBudget(ranked, 0).count).toBe(0);
    const all = pickByBudget(ranked, 10_000);
    expect(all.count).toBe(10);
    expect(all.tokens).toBe(Math.ceil(Buffer.byteLength(renderMap(ranked, 10), "utf8") / 4));
    const half = pickByBudget(ranked, Math.floor(all.tokens / 2));
    expect(half.count).toBeGreaterThan(0);
    expect(half.count).toBeLessThan(10);
  });
});

/* ------------------------------- buildRepoMap ------------------------------- */

describe("buildRepoMap", () => {
  test("ranks focus-relevant files up, excludes tests by default, renders defs", () => {
    const ws = makeWorkspace(FIXTURE);
    const result = buildRepoMap({ root: ws, cwd: ws, focus: ["src/a.ts"] });
    if ("empty" in result) throw new Error("unexpected empty");
    expect(result.map).toContain("src/a.ts:");
    expect(result.map).toContain("\u22ee alpha");
    expect(result.map).not.toContain("tests/");
    // a's focus lifts b (a references beta) above c (referenced by nobody).
    expect(result.map.indexOf("src/b.ts:")).toBeLessThan(result.map.indexOf("src/c.ts:"));
    expect(result.filesIncluded).toBe(3);
    expect(result.filesOmitted).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.map).toMatch(/\[repo_map: 3 files, ~\d+ tokens\]$/);
  });

  test("includeTests brings the test files in", () => {
    const ws = makeWorkspace(FIXTURE);
    const result = buildRepoMap({ root: ws, cwd: ws, includeTests: true });
    if ("empty" in result) throw new Error("unexpected empty");
    expect(result.map).toContain("tests/a.test.ts:");
    expect(result.filesIncluded).toBe(4);
  });

  test("a small budget truncates with the marker; a large one includes everything; the hard cap clamps", () => {
    const ws = makeWorkspace(manyFiles(30));
    const tiny = buildRepoMap({ root: ws, cwd: ws, maxTokens: 64 });
    if ("empty" in tiny) throw new Error("unexpected empty");
    expect(tiny.truncated).toBe(true);
    expect(tiny.filesIncluded).toBeLessThan(30);
    expect(tiny.map).toContain("[truncated: showing");
    expect(tiny.map).toContain("omitted");

    const full = buildRepoMap({ root: ws, cwd: ws, maxTokens: 16_000 });
    if ("empty" in full) throw new Error("unexpected empty");
    expect(full.filesIncluded).toBe(30);
    expect(full.truncated).toBe(false);

    const clamped = buildRepoMap({ root: ws, cwd: ws, maxTokens: 999_999 });
    if ("empty" in clamped) throw new Error("unexpected empty");
    expect(clamped.map).toBe(full.map);
  });

  test("byte-stable: two builds of the same tree are identical", () => {
    const ws = makeWorkspace(FIXTURE);
    const one = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    const two = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in one || "empty" in two) throw new Error("unexpected empty");
    expect(one.map).toBe(two.map);
  });

  test("an empty workspace reports empty", () => {
    const ws = makeWorkspace({});
    const result = buildRepoMap({ root: ws, cwd: ws });
    expect("empty" in result).toBe(true);
  });

  test("countIdents counts whole identifiers", () => {
    const counts = countIdents("alpha beta alpha alphabeta");
    expect(counts.get("alpha")).toBe(2);
    expect(counts.get("alphabeta")).toBe(1);
  });
});

/* ---------------------------------- tool ---------------------------------- */

describe("the tool", () => {
  test("execute admits one fs.read, renders the map, and is byte-stable across calls", async () => {
    const ws = makeWorkspace(FIXTURE);
    const ctx = mockToolContext({ cwd: ws });
    const r1 = await repoMapTool.execute({ focus: ["src/a.ts"] }, ctx);
    const r2 = await repoMapTool.execute({ focus: ["src/a.ts"] }, ctx);
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain("src/a.ts:");
    expect(r1.output).toContain("[repo_map: 3 files");
    expect(r1.output).toBe(r2.output);
    expect(ctx.guardCalls.length).toBe(2);
    expect(ctx.guardCalls[0]?.kind).toBe("fs.read");
  }, 20000);

  test("execute refuses an empty workspace with the spec's error name", async () => {
    const ws = makeWorkspace({});
    const r = await repoMapTool.execute({}, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty workspace");
  });

  test("execute honours a subdirectory path", async () => {
    const ws = makeWorkspace(FIXTURE);
    const r = await repoMapTool.execute({ path: "src" }, mockToolContext({ cwd: ws }));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("src/a.ts:");
    expect(r.output).not.toContain("tests/");
  });
});

/* ---------------------------- per-file scan cache ---------------------------- */

describe("the per-file scan cache", () => {
  test("cold vs warm: rendered map and stats line are byte-identical, and the warm call is served from cache", () => {
    const ws = makeWorkspace(FIXTURE);
    resetRepoMapCache();
    const cold = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in cold) throw new Error("unexpected empty");
    const afterCold = repoMapCacheStats();
    expect(afterCold.misses).toBe(3); // src/a.ts, src/b.ts, src/c.ts — tests/ is excluded
    expect(afterCold.hits).toBe(0);

    const warm = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in warm) throw new Error("unexpected empty");
    expect(warm.map).toBe(cold.map); // full bytes, the [repo_map: ...] stats line included
    const statsLine = /\[repo_map: [^\]]*\]/.exec(cold.map)?.[0];
    expect(statsLine).toBeDefined();
    expect(warm.map).toContain(statsLine as string);

    const afterWarm = repoMapCacheStats();
    expect(afterWarm.hits - afterCold.hits).toBe(3); // every file came from the cache
    expect(afterWarm.misses).toBe(afterCold.misses); // and none was re-scanned
  });

  test("a file whose stamp changed is re-scanned, even when its size is unchanged", () => {
    const ws = makeWorkspace({ "src/a.ts": "export function alpha() {}\n" });
    resetRepoMapCache();
    const before = buildRepoMap({ root: ws, cwd: ws });
    if ("empty" in before) throw new Error("unexpected empty");
    expect(before.map).toContain("alpha");

    // Same byte length ("alpha" -> "alphb"), so only mtimeMs can invalidate the entry.
    const abs = writeFixture(ws, "src/a.ts", "export function alphb() {}\n");
    utimesSync(abs, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    const missesBefore = repoMapCacheStats().misses;

    const after = buildRepoMap({ root: ws, cwd: ws });
    if ("empty" in after) throw new Error("unexpected empty");
    expect(after.map).toContain("alphb");
    expect(after.map).not.toContain("alpha");
    expect(repoMapCacheStats().misses).toBe(missesBefore + 1);
  });

  test("a deleted file's entry is dropped and it never reaches the map", () => {
    const ws = makeWorkspace({
      "src/a.ts": "export function alpha() {}\n",
      "src/b.ts": "export function beta() {}\n",
    });
    resetRepoMapCache();
    const first = buildRepoMap({ root: ws, cwd: ws });
    if ("empty" in first) throw new Error("unexpected empty");
    expect(first.map).toContain("alpha");
    expect(repoMapCacheStats().size).toBe(2);

    rmSync(path.join(ws, "src/a.ts"));
    const second = buildRepoMap({ root: ws, cwd: ws });
    if ("empty" in second) throw new Error("unexpected empty");
    expect(second.map).not.toContain("alpha");
    expect(second.map).toContain("beta");
    expect(repoMapCacheStats().size).toBe(1); // the deleted file's facts were pruned
  });

  test("two workspaces never share an entry, even at the same relative path", () => {
    resetRepoMapCache();
    const wsOne = makeWorkspace({ "src/f.ts": "export function one() {}\n" });
    const wsTwo = makeWorkspace({ "src/f.ts": "export function two() {}\n" });
    const r1 = buildRepoMap({ root: wsOne, cwd: wsOne });
    const r2 = buildRepoMap({ root: wsTwo, cwd: wsTwo });
    const r3 = buildRepoMap({ root: wsOne, cwd: wsOne });
    if ("empty" in r1 || "empty" in r2 || "empty" in r3) throw new Error("unexpected empty");
    expect(r1.map).toContain("one");
    expect(r2.map).toContain("two");
    expect(r2.map).not.toContain("one");
    expect(r3.map).toBe(r1.map); // wsOne's entry was not overwritten by wsTwo's
    expect(repoMapCacheStats().size).toBe(2); // both absolute paths live side by side
  });

  test("the cache is bounded and evicts the least recently used entry", () => {
    const cache = new RepoFileScanCache(2);
    const facts = (def: string) => ({ defs: [def], tokenCounts: new Map<string, number>() });
    cache.set("/w/a.ts", "10:1", facts("a"));
    cache.set("/w/b.ts", "10:1", facts("b"));

    expect(cache.get("/w/a.ts", "10:1")?.defs).toEqual(["a"]); // a is now most recent
    cache.set("/w/c.ts", "10:1", facts("c")); // over the bound: b is evicted
    expect(cache.size).toBe(2);
    expect(cache.get("/w/b.ts", "10:1")).toBeUndefined();
    expect(cache.get("/w/a.ts", "10:1")?.defs).toEqual(["a"]);

    // A changed stamp is never served, and the stale entry is forgotten.
    expect(cache.get("/w/a.ts", "11:2")).toBeUndefined();
    expect(cache.size).toBe(1);

    // The process-wide cache honours its own bound.
    const stats = repoMapCacheStats();
    expect(stats.max).toBe(4096);
    expect(stats.size).toBeLessThanOrEqual(stats.max);
  });
});
