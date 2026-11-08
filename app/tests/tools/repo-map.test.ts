/** repo-map.test.ts — B-1: the repo_map tool (docs/09 §4.2 contract).
 *
 * The map is deterministic (byte-stable), budget-bounded with a truncation
 * marker, focus-personalised, test-excluding by default, and admits one
 * `fs.read` per call. The per-file scan facts are cached in two layers — a
 * bounded in-process memo and a persistent index at
 * `<state root>/repo-map/index.json` — and the cache never changes the rendered
 * map: it only moves the stats line's `cache: r reused, p parsed` counts, which
 * describe how the call obtained its facts (same inputs -> same counts).
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
import {
  REPO_MAP_INDEX_MAX_ENTRIES,
  REPO_MAP_INDEX_VERSION,
  repoMapCacheDir,
  repoMapCachePath,
  repoMapIndexStats,
  saveRepoMapIndex,
  type RepoMapFileEntry,
} from "../../src/tools/repo-map-cache";
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

/** The rendered map body: everything before the `[repo_map: ...]` stats line. */
function bodyOf(map: string): string {
  const at = map.indexOf("\n[repo_map:");
  return at === -1 ? map : map.slice(0, at);
}

/** This call's `cache: r reused, p parsed` counters, from the stats line. */
function cacheCountsOf(map: string): { reused: number; parsed: number } {
  const match = /cache: (\d+) reused, (\d+) parsed/.exec(map);
  if (match === null) throw new Error(`no cache counters in ${JSON.stringify(map)}`);
  return { reused: Number(match[1]), parsed: Number(match[2]) };
}

/** Parse the persistent index of a fixture workspace. */
function readIndex(ws: string): { version: number; entries: Record<string, RepoMapFileEntry> } {
  return JSON.parse(readFileSync(repoMapCachePath(ws), "utf8"));
}

/** Permission bits of a path (the tests' only way to observe a mode). */
function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

const onUnix = process.platform !== "win32";

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
    expect(result.map).toMatch(/\[repo_map: 3 files, ~\d+ tokens, cache: \d+ reused, \d+ parsed\]$/);
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
    expect(bodyOf(clamped.map)).toBe(bodyOf(full.map));
  });

  test("byte-stable: a repeat build renders the same bytes; consecutive warm calls are fully identical", () => {
    const ws = makeWorkspace(FIXTURE);
    const one = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    const two = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    const three = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in one || "empty" in two || "empty" in three) throw new Error("unexpected empty");
    expect(bodyOf(two.map)).toBe(bodyOf(one.map)); // the tree render never moves
    expect(three.map).toBe(two.map); // full bytes, the [repo_map: ...] stats line included
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
  test("execute admits one fs.read, renders the map, and wires the persistent index", async () => {
    const ws = makeWorkspace(FIXTURE);
    const ctx = mockToolContext({ cwd: ws });
    const r1 = await repoMapTool.execute({ focus: ["src/a.ts"] }, ctx);
    const r2 = await repoMapTool.execute({ focus: ["src/a.ts"] }, ctx);
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain("src/a.ts:");
    expect(r1.output).toContain("[repo_map: 3 files");
    expect(bodyOf(r2.output)).toBe(bodyOf(r1.output));
    expect(ctx.guardCalls.length).toBe(2);
    expect(ctx.guardCalls[0]?.kind).toBe("fs.read");
    // The tool resolves the index through paths.ts: <workspace>/.hz/state/repo-map/index.json.
    expect(repoMapCachePath(ws)).toBe(path.join(ws, ".hz", "state", "repo-map", "index.json"));
    expect(readIndex(ws).version).toBe(REPO_MAP_INDEX_VERSION);
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
  test("cold vs warm: the map body is byte-identical and the warm call is served from the memo", () => {
    const ws = makeWorkspace(FIXTURE);
    resetRepoMapCache();
    const cold = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in cold) throw new Error("unexpected empty");
    const afterCold = repoMapCacheStats();
    expect(afterCold.misses).toBe(3); // src/a.ts, src/b.ts, src/c.ts — tests/ is excluded
    expect(afterCold.hits).toBe(0);
    expect(cacheCountsOf(cold.map)).toEqual({ reused: 0, parsed: 3 });

    const warm = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"] });
    if ("empty" in warm) throw new Error("unexpected empty");
    expect(bodyOf(warm.map)).toBe(bodyOf(cold.map)); // the stats counters moved, the tree render did not
    expect(cacheCountsOf(warm.map)).toEqual({ reused: 3, parsed: 0 });

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
    expect(bodyOf(r3.map)).toBe(bodyOf(r1.map)); // wsOne's entry was not overwritten by wsTwo's
    expect(repoMapCacheStats().size).toBe(2); // both absolute paths live side by side
  });

  test("the cache is bounded and evicts the least recently used entry", () => {
    const cache = new RepoFileScanCache(2);
    const facts = (def: string) => ({ defs: [def], exported: [true], tokenCounts: new Map<string, number>() });
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

/* ------------------------- the persistent identifier index ------------------------- */

describe("the persistent index", () => {
  test("cold, index-cold and warm calls render identical map bytes; the counts follow the source", () => {
    const ws = makeWorkspace(FIXTURE);
    resetRepoMapCache();
    const indexFile = repoMapCachePath(ws);

    const cold = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"], indexFile });
    if ("empty" in cold) throw new Error("unexpected empty");
    expect(cold.cacheReused).toBe(0);
    expect(cold.cacheParsed).toBe(3);
    expect(cacheCountsOf(cold.map)).toEqual({ reused: 0, parsed: 3 });
    expect(readIndex(ws).version).toBe(REPO_MAP_INDEX_VERSION); // the build persisted its scan

    resetRepoMapCache(); // a new process: memo empty, the index on disk
    const hit = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"], indexFile });
    const warm = buildRepoMap({ root: ws, cwd: ws, focus: ["src/b.ts"], indexFile });
    if ("empty" in hit || "empty" in warm) throw new Error("unexpected empty");
    expect(hit.cacheReused).toBe(3);
    expect(hit.cacheParsed).toBe(0);
    expect(cacheCountsOf(hit.map)).toEqual({ reused: 3, parsed: 0 });
    expect(hit.map).toMatch(/\[repo_map: 3 files, ~\d+ tokens, cache: 3 reused, 0 parsed\]$/);

    // Cache-hit vs cold: the rendered map is byte-identical...
    expect(bodyOf(hit.map)).toBe(bodyOf(cold.map));
    // ...and once the facts are cached, consecutive calls are byte-identical
    // INCLUDING the stats line: same inputs -> same counts.
    expect(warm.map).toBe(hit.map);
  });

  test("the index stores everything the extraction phase produces", () => {
    const ws = makeWorkspace({ "src/a.ts": "export function alpha() {\n  return beta();\n}\n" });
    resetRepoMapCache();
    const result = buildRepoMap({ root: ws, cwd: ws, indexFile: repoMapCachePath(ws) });
    if ("empty" in result) throw new Error("unexpected empty");
    const entry = readIndex(ws).entries["src/a.ts"];
    const stat = statSync(path.join(ws, "src/a.ts"));
    expect(entry?.mtimeMs).toBe(stat.mtimeMs);
    expect(entry?.size).toBe(stat.size);
    expect(entry?.defs).toEqual(["alpha"]);
    expect(entry?.exported).toEqual([true]);
    expect(entry?.refs["alpha"]).toBe(1);
    expect(entry?.refs["beta"]).toBe(1);
  });

  test("touch one file -> only it reparses; the other entries are served from the index", () => {
    const ws = makeWorkspace(FIXTURE);
    const indexFile = repoMapCachePath(ws);
    resetRepoMapCache();
    const first = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in first) throw new Error("unexpected empty");
    expect(first.cacheParsed).toBe(3);

    // Same byte length (alpha -> alphb), so only mtimeMs can invalidate the entry.
    const abs = writeFixture(ws, "src/a.ts", "export function alphb() {\n  return beta();\n}\n");
    utimesSync(abs, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    resetRepoMapCache(); // memo empty: the persistent layer alone decides what to reparse
    const indexBefore = repoMapIndexStats();

    const second = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in second) throw new Error("unexpected empty");
    const indexAfter = repoMapIndexStats();
    expect(indexAfter.hits - indexBefore.hits).toBe(2); // b and c were served from the index...
    expect(indexAfter.misses - indexBefore.misses).toBe(1); // ...while a's changed stamp forced the reparse
    expect(second.cacheReused).toBe(2);
    expect(second.cacheParsed).toBe(1);
    expect(cacheCountsOf(second.map)).toEqual({ reused: 2, parsed: 1 });
    expect(second.map).toContain("alphb");
    expect(second.map).not.toContain("alpha");
    expect(readIndex(ws).entries["src/a.ts"]?.defs).toEqual(["alphb"]);
  });

  test("a deleted file is pruned from the index", () => {
    const ws = makeWorkspace(FIXTURE);
    const indexFile = repoMapCachePath(ws);
    resetRepoMapCache();
    const first = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in first) throw new Error("unexpected empty");
    expect(Object.keys(readIndex(ws).entries).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

    rmSync(path.join(ws, "src/a.ts"));
    resetRepoMapCache();
    const second = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in second) throw new Error("unexpected empty");
    expect(second.map).not.toContain("src/a.ts");
    expect(second.cacheReused).toBe(2);
    expect(second.cacheParsed).toBe(0);
    expect(Object.keys(readIndex(ws).entries).sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("a corrupt or wrong-version index is rebuilt, typed, never a crash", () => {
    const ws = makeWorkspace(FIXTURE);
    const indexFile = repoMapCachePath(ws);
    mkdirSync(repoMapCacheDir(ws), { recursive: true });
    writeFileSync(indexFile, "{ not json at all", "utf8");
    resetRepoMapCache();

    const rebuilt = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in rebuilt) throw new Error("unexpected empty");
    expect(rebuilt.cacheReused).toBe(0);
    expect(rebuilt.cacheParsed).toBe(3);
    expect(repoMapIndexStats().invalid).toBeGreaterThanOrEqual(1);
    expect(readIndex(ws).version).toBe(REPO_MAP_INDEX_VERSION); // the garbage was overwritten
    expect(Object.keys(readIndex(ws).entries).length).toBe(3);

    // A version this reader does not know is the same typed full rebuild.
    writeFileSync(indexFile, JSON.stringify({ version: REPO_MAP_INDEX_VERSION + 1, entries: {} }), "utf8");
    resetRepoMapCache();
    const again = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in again) throw new Error("unexpected empty");
    expect(again.cacheReused).toBe(0);
    expect(again.cacheParsed).toBe(3);
    expect(readIndex(ws).entries["src/b.ts"]?.defs).toEqual(["beta"]);
  });

  test("the caps prune deterministically: over the entry bound the lexicographically last entries fall", () => {
    const ws = makeWorkspace({});
    const indexFile = repoMapCachePath(ws);
    const entries = new Map<string, RepoMapFileEntry>();
    for (let i = 0; i <= REPO_MAP_INDEX_MAX_ENTRIES; i++) {
      entries.set(`src/f${String(i).padStart(6, "0")}.ts`, { mtimeMs: 1, size: 1, defs: ["d"], exported: [true], refs: {} });
    }
    const saved = saveRepoMapIndex(indexFile, entries);
    expect(saved.ok).toBe(true);
    expect(saved.written).toBe(true);
    expect(saved.kept + saved.pruned).toBe(entries.size);
    expect(saved.pruned).toBeGreaterThanOrEqual(1);
    expect(saved.kept).toBeLessThanOrEqual(REPO_MAP_INDEX_MAX_ENTRIES);
    const onDisk = JSON.parse(readFileSync(indexFile, "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(onDisk.entries).length).toBe(saved.kept);
    expect(onDisk.entries["src/f000000.ts"]).toBeDefined(); // the kept end is the lexicographic head
  });
});

describe.skipIf(!onUnix)("the persistent index permissions", () => {
  test("the index dir is 0700 and the file 0600, and a loose pair is tightened on the next call", () => {
    const ws = makeWorkspace(FIXTURE);
    const indexFile = repoMapCachePath(ws);
    resetRepoMapCache();
    const first = buildRepoMap({ root: ws, cwd: ws, indexFile });
    if ("empty" in first) throw new Error("unexpected empty");
    expect(modeOf(repoMapCacheDir(ws))).toBe(0o700);
    expect(modeOf(indexFile)).toBe(0o600);

    chmodSync(indexFile, 0o644);
    chmodSync(repoMapCacheDir(ws), 0o755);
    const second = buildRepoMap({ root: ws, cwd: ws, indexFile }); // unchanged index: still tightened
    if ("empty" in second) throw new Error("unexpected empty");
    expect(modeOf(indexFile)).toBe(0o600);
    expect(modeOf(repoMapCacheDir(ws))).toBe(0o700);
  });
});
