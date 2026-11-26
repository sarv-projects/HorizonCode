/**
 * Engineering Brain — lexical symbol impact on mutated paths (ruling 685 slice).
 * Cross-model LLM critic is ruling **705** (`HZ_ENG_CRITIC_MODEL`); persisted
 * exported-symbol graph query when `HZ_SYMBOL_GRAPH=1` (**713**); structural
 * call-site reach (**727**) via `structural-call-impact.ts` — still not
 * tree-sitter / AST call-graph.
 *
 * Reuses `repo_map` lexical extractors (`lexicalSymbolSurface`, `countIdents`);
 * bounded workspace walk estimates cross-file lexical + structural call reach
 * of exported symbols touched this turn.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileHasStructuralCall } from "./structural-call-impact";
import { countIdents, lexicalSymbolSurface } from "../tools/repo-map";
import { importersOfSymbol, loadSymbolGraph, symbolGraphEnabled } from "../tools/symbol-graph";
import { isBinary, relPath } from "../tools/helpers";
import { computeCallGraphBlastRadius, type CallGraph } from "./call-graph";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  ".hz",
  ".hzcode",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
]);

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
]);

const MUTATED_READ_BYTES = 256_000;
const WALK_MAX_FILES = 600;
const WALK_MAX_FILE_BYTES = 512_000;
const MAX_EXPORTED_TRACK = 20;
const MAX_DEFS_LISTED = 8;

/** Other workspace files (lexical id occurrence) referencing an exported symbol. */
export type ExportedSymbolReach = {
  name: string;
  definingPaths: string[];
  /** Files with any lexical identifier occurrence (repo_map `countIdents`). */
  otherFileRefs: number;
  /** Files with at least one structural `symbol(` call site (ruling **727**). */
  otherFileCallSites: number;
};

export type SymbolImpactReport = {
  summary: string;
  exportedReach: ExportedSymbolReach[];
  /** P1 advisory when exported surface likely spans many dependents. */
  highBlastRadius: boolean;
};

function normRel(p: string): string {
  return p.replace(/\\/g, "/");
}

function readTextCap(abs: string, cap: number): string | undefined {
  try {
    const buf = readFileSync(abs);
    if (buf.length > cap || isBinary(buf)) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

function collectExportedFromMutations(
  workspace: string,
  changedPaths: readonly string[],
): { symbols: Map<string, Set<string>>; perFileLines: string[] } {
  const symbols = new Map<string, Set<string>>();
  const perFileLines: string[] = [];
  for (const rel of changedPaths) {
    const norm = normRel(rel);
    const ext = path.extname(norm);
    if (!CODE_EXT.has(ext)) continue;
    const abs = norm.startsWith("/") || /^[A-Za-z]:[\\/]/.test(norm) ? norm : path.join(workspace, norm);
    const text = readTextCap(abs, MUTATED_READ_BYTES);
    if (text === undefined) continue;
    const { defs, exported } = lexicalSymbolSurface(text, ext);
    const exportedNames: string[] = [];
    const localNames: string[] = [];
    for (let i = 0; i < defs.length; i++) {
      const name = defs[i];
      if (exported[i]) {
        exportedNames.push(name);
        const set = symbols.get(name) ?? new Set<string>();
        set.add(norm);
        symbols.set(name, set);
      } else if (localNames.length < MAX_DEFS_LISTED) {
        localNames.push(name);
      }
    }
    const expShown = exportedNames.slice(0, MAX_DEFS_LISTED);
    const locShown = localNames.slice(0, MAX_DEFS_LISTED);
    const parts: string[] = [];
    if (expShown.length > 0) {
      parts.push(
        `exported ${expShown.join(", ")}${exportedNames.length > expShown.length ? ", …" : ""}`,
      );
    }
    if (locShown.length > 0) {
      parts.push(`local ${locShown.join(", ")}${localNames.length > locShown.length ? ", …" : ""}`);
    }
    if (parts.length > 0) perFileLines.push(`${norm}: ${parts.join("; ")}`);
  }
  return { symbols, perFileLines };
}

type OtherFileReach = { lexical: number; structural: number };

function countOtherFileReach(
  workspace: string,
  symbol: string,
  definingPaths: Set<string>,
): OtherFileReach {
  if (symbolGraphEnabled()) {
    const graph = loadSymbolGraph(workspace);
    if (graph !== undefined) {
      const importers = importersOfSymbol(graph, symbol, definingPaths);
      let structural = 0;
      const root = path.resolve(workspace);
      for (const rel of importers) {
        const abs = path.join(root, rel);
        const text = readTextCap(abs, WALK_MAX_FILE_BYTES);
        if (text !== undefined && fileHasStructuralCall(text, symbol)) structural++;
      }
      return { lexical: importers.length, structural };
    }
  }
  const root = path.resolve(workspace);
  let lexical = 0;
  let structural = 0;
  let files = 0;

  const walk = (dir: string): void => {
    if (files >= WALK_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (files >= WALK_MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = normRel(relPath(root, abs));
        if (definingPaths.has(rel)) continue;
        const ext = path.extname(entry.name);
        if (!CODE_EXT.has(ext)) continue;
        const text = readTextCap(abs, WALK_MAX_FILE_BYTES);
        if (text === undefined) continue;
        files++;
        const idents = countIdents(text);
        if ((idents.get(symbol) ?? 0) > 0) lexical++;
        if (fileHasStructuralCall(text, symbol)) structural++;
      }
    }
  };
  walk(root);
  return { lexical, structural };
}

export function buildMutationSymbolImpact(
  workspace: string,
  changedPaths: readonly string[],
): SymbolImpactReport | undefined {
  if (changedPaths.length === 0) return undefined;
  const { symbols, perFileLines } = collectExportedFromMutations(workspace, changedPaths);
  if (perFileLines.length === 0 && symbols.size === 0) return undefined;

  const exportedReach: ExportedSymbolReach[] = [];
  const names = [...symbols.keys()].sort().slice(0, MAX_EXPORTED_TRACK);
  for (const name of names) {
    const definingPaths = [...(symbols.get(name) ?? [])];
    const reach = countOtherFileReach(workspace, name, new Set(definingPaths));
    exportedReach.push({
      name,
      definingPaths,
      otherFileRefs: reach.lexical,
      otherFileCallSites: reach.structural,
    });
  }

  const maxLexical = exportedReach.reduce((m, r) => Math.max(m, r.otherFileRefs), 0);
  const sumLexical = exportedReach.reduce((s, r) => s + r.otherFileRefs, 0);
  const maxStructural = exportedReach.reduce((m, r) => Math.max(m, r.otherFileCallSites), 0);
  const sumStructural = exportedReach.reduce((s, r) => s + r.otherFileCallSites, 0);
  const highBlastRadius =
    maxStructural >= 8 ||
    sumStructural >= 18 ||
    maxLexical >= 10 ||
    sumLexical >= 24;

  const reachLines = exportedReach
    .filter((r) => r.otherFileRefs > 0 || r.otherFileCallSites > 0)
    .sort((a, b) => b.otherFileCallSites - a.otherFileCallSites || b.otherFileRefs - a.otherFileRefs)
    .slice(0, 6)
    .map(
      (r) =>
        `${r.name} → ${r.otherFileCallSites} call-site file(s) (structural), ${r.otherFileRefs} lexical ref file(s)`,
    );

  const lines = [
    "[eng-brain symbol impact — lexical refs + structural call-sites; not tree-sitter AST call-graph]",
  ];
  lines.push(...perFileLines.slice(0, 12));
  if (reachLines.length > 0) lines.push(`reach: ${reachLines.join("; ")}`);
  if (names.length < symbols.size) {
    lines.push(`(capped at ${MAX_EXPORTED_TRACK} exported symbols)`);
  }

  return {
    summary: lines.join("\n"),
    exportedReach,
    highBlastRadius,
  };
}

/**
 * Computes call-graph blast radius directly using an in-memory CallGraph index.
 */
export function buildMutationCallGraphImpact(
  workspace: string,
  changedPaths: readonly string[],
  graph: CallGraph,
): { affectedFiles: string[]; totalCallSites: number; summary: string } | undefined {
  if (changedPaths.length === 0) return undefined;
  const { symbols } = collectExportedFromMutations(workspace, changedPaths);
  const names = [...symbols.keys()];
  if (names.length === 0) return undefined;

  const blast = computeCallGraphBlastRadius(graph, names);
  const summary = `[eng-brain call graph — ${names.length} mutated symbols affect ${blast.affectedFiles.length} file(s) across ${blast.totalCallSites} call site(s)]`;

  return {
    affectedFiles: blast.affectedFiles,
    totalCallSites: blast.totalCallSites,
    summary,
  };
}