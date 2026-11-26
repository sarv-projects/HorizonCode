/**
 * call-graph.ts — Incremental Semantic Call Graph
 *
 * Engineering Brain (ruling 640 / 727 extension):
 * Extracts caller-to-callee edges using parenthesis-aware structural call scanning
 * (comment-, string-, and declaration-safe). Maintains an incremental in-memory
 * graph allowing per-file updates in O(1) files and querying blast radius for
 * mutated symbols.
 */

import { countStructuralCallSites } from "./structural-call-impact";

export interface CallGraphEdge {
  fromFile: string;
  toSymbol: string;
  callSites: number;
}

export interface CallGraph {
  version: 1;
  edges: readonly CallGraphEdge[];
}

export function createCallGraph(edges: CallGraphEdge[] = []): CallGraph {
  return {
    version: 1,
    edges: Object.freeze([...edges]),
  };
}

/**
 * Extracts call-site edges from file content for known target symbols.
 */
export function buildFileCallEdges(
  fileRelPath: string,
  content: string,
  targetSymbols: ReadonlySet<string>,
): CallGraphEdge[] {
  const result: CallGraphEdge[] = [];
  for (const symbol of targetSymbols) {
    if (symbol.length === 0) continue;
    const count = countStructuralCallSites(content, symbol);
    if (count > 0) {
      result.push({
        fromFile: fileRelPath,
        toSymbol: symbol,
        callSites: count,
      });
    }
  }
  return result;
}

/**
 * Updates the graph incrementally when a file's content changes.
 * Removes existing edges from `fileRelPath` and adds fresh ones.
 */
export function updateCallGraphIncremental(
  existing: CallGraph,
  fileRelPath: string,
  newContent: string,
  targetSymbols: ReadonlySet<string>,
): CallGraph {
  // Retain all edges from other files
  const retained = existing.edges.filter((e) => e.fromFile !== fileRelPath);
  // Compute fresh edges for the updated file
  const newEdges = buildFileCallEdges(fileRelPath, newContent, targetSymbols);

  return {
    version: 1,
    edges: Object.freeze([...retained, ...newEdges]),
  };
}

export interface CallerInfo {
  fromFile: string;
  callSites: number;
}

/**
 * Queries all files that call a given symbol.
 */
export function queryCallers(graph: CallGraph, calleeSymbol: string): CallerInfo[] {
  const matching = graph.edges.filter((e) => e.toSymbol === calleeSymbol);
  return matching.map((e) => ({
    fromFile: e.fromFile,
    callSites: e.callSites,
  }));
}

export interface BlastRadiusResult {
  affectedFiles: string[];
  totalCallSites: number;
}

/**
 * Computes blast radius across a list of changed symbols.
 */
export function computeCallGraphBlastRadius(
  graph: CallGraph,
  changedSymbols: readonly string[],
): BlastRadiusResult {
  const symbolSet = new Set(changedSymbols);
  const affectedFilesSet = new Set<string>();
  let totalCallSites = 0;

  for (const edge of graph.edges) {
    if (symbolSet.has(edge.toSymbol)) {
      affectedFilesSet.add(edge.fromFile);
      totalCallSites += edge.callSites;
    }
  }

  return {
    affectedFiles: [...affectedFilesSet].sort(),
    totalCallSites,
  };
}
