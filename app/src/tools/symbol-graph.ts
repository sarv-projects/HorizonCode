/**
 * Lexical exported-symbol adjacency graph (ruling 713 slice).
 *
 * Built from the same per-file facts as `repo_map` (`defs`, `exported`, `refs`).
 * Edges are **lexical** identifier occurrences — not tree-sitter / AST call-graph.
 * Opt-in persistence at `<state>/repo-map/symbol-graph.json` when `HZ_SYMBOL_GRAPH=1`.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { RepoMapFileEntry } from "./repo-map-cache";
import { workspaceStateDir } from "../core/paths";

export const SYMBOL_GRAPH_VERSION = 1;
export const SYMBOL_GRAPH_MAX_BYTES = 2 * 1024 * 1024;
export const SYMBOL_GRAPH_MAX_SYMBOLS = 8_000;
export const SYMBOL_GRAPH_MAX_IMPORTERS_PER_SYMBOL = 300;

export type ExportedSymbolRecord = {
  definePaths: string[];
  importers: string[];
};

export type ExportedSymbolGraph = {
  version: typeof SYMBOL_GRAPH_VERSION;
  symbols: Record<string, ExportedSymbolRecord>;
};

const isUnix = process.platform !== "win32";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when durable symbol-graph build/persist is allowed (`HZ_SYMBOL_GRAPH=1`). */
export function symbolGraphEnabled(): boolean {
  return process.env.HZ_SYMBOL_GRAPH === "1";
}

/** On-disk path: `<state root>/repo-map/symbol-graph.json`. */
export function symbolGraphCachePath(workspace: string): string {
  return path.join(workspaceStateDir(workspace), "repo-map", "symbol-graph.json");
}

function validRecord(value: unknown): value is ExportedSymbolRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<ExportedSymbolRecord>;
  if (!Array.isArray(r.definePaths) || !r.definePaths.every((p) => typeof p === "string")) return false;
  if (!Array.isArray(r.importers) || !r.importers.every((p) => typeof p === "string")) return false;
  return true;
}

/** Build exported-symbol → importer-file adjacency from repo_map index entries. Pure, deterministic. */
export function buildExportedSymbolGraph(
  entries: Map<string, RepoMapFileEntry> | Iterable<[string, RepoMapFileEntry]>,
): ExportedSymbolGraph {
  const exportedDefine = new Map<string, Set<string>>();
  for (const [rel, entry] of entries) {
    for (let i = 0; i < entry.defs.length; i++) {
      if (!entry.exported[i]) continue;
      const name = entry.defs[i];
      const set = exportedDefine.get(name) ?? new Set<string>();
      set.add(rel);
      exportedDefine.set(name, set);
    }
  }

  const importers = new Map<string, Set<string>>();
  for (const [rel, entry] of entries) {
    for (const [ident, count] of Object.entries(entry.refs)) {
      if (count <= 0) continue;
      const defs = exportedDefine.get(ident);
      if (defs === undefined) continue;
      if (defs.has(rel)) continue;
      const set = importers.get(ident) ?? new Set<string>();
      set.add(rel);
      importers.set(ident, set);
    }
  }

  const symbols: Record<string, ExportedSymbolRecord> = {};
  const names = [...exportedDefine.keys()].sort().slice(0, SYMBOL_GRAPH_MAX_SYMBOLS);
  for (const name of names) {
    const definePaths = [...(exportedDefine.get(name) ?? [])].sort();
    let imp = [...(importers.get(name) ?? [])].sort();
    if (imp.length > SYMBOL_GRAPH_MAX_IMPORTERS_PER_SYMBOL) {
      imp = imp.slice(0, SYMBOL_GRAPH_MAX_IMPORTERS_PER_SYMBOL);
    }
    symbols[name] = { definePaths, importers: imp };
  }
  return { version: SYMBOL_GRAPH_VERSION, symbols };
}

/** Importers of an exported symbol, excluding defining paths (query helper). */
export function importersOfSymbol(
  graph: ExportedSymbolGraph,
  symbol: string,
  definingPaths?: ReadonlySet<string>,
): string[] {
  const rec = graph.symbols[symbol];
  if (rec === undefined) return [];
  const skip = definingPaths ?? new Set(rec.definePaths);
  return rec.importers.filter((p) => !skip.has(p));
}

/** Render a bounded symbol-graph slice for tool output. */
export function renderSymbolGraphSection(
  graph: ExportedSymbolGraph,
  opts?: { query?: string; maxSymbols?: number; maxImporters?: number },
): string {
  const maxSymbols = Math.max(1, Math.min(opts?.maxSymbols ?? 24, SYMBOL_GRAPH_MAX_SYMBOLS));
  const maxImporters = Math.max(1, Math.min(opts?.maxImporters ?? 12, SYMBOL_GRAPH_MAX_IMPORTERS_PER_SYMBOL));
  const lines = ["[symbol_graph: lexical exported adjacency, not AST call-graph]"];
  const query = opts?.query?.trim();
  const names =
    query !== undefined && query !== ""
      ? graph.symbols[query] !== undefined
        ? [query]
        : []
      : Object.keys(graph.symbols).sort().slice(0, maxSymbols);
  if (names.length === 0) {
    lines.push(query ? `(no exported symbol ${JSON.stringify(query)})` : "(empty)");
    return lines.join("\n");
  }
  for (const name of names) {
    const rec = graph.symbols[name];
    const defs = rec.definePaths.join(", ");
    const imp = rec.importers.slice(0, maxImporters);
    const impTail = rec.importers.length > imp.length ? `, …+${rec.importers.length - imp.length}` : "";
    lines.push(
      `${name} (${defs}) ← ${imp.length > 0 ? imp.join(", ") + impTail : "(no cross-file lexical refs)"}`,
    );
  }
  if (query === undefined && Object.keys(graph.symbols).length > names.length) {
    lines.push(`(capped at ${maxSymbols} symbols; pass symbolGraphQuery to narrow)`);
  }
  return lines.join("\n");
}

export type SymbolGraphLoad =
  | { kind: "valid"; graph: ExportedSymbolGraph }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

export function loadSymbolGraphFile(file: string): SymbolGraphLoad {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: `unreadable (${msg(e)})` };
  }
  if (Buffer.byteLength(raw, "utf8") > SYMBOL_GRAPH_MAX_BYTES) {
    return { kind: "invalid", reason: `over the ${SYMBOL_GRAPH_MAX_BYTES} byte cap` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { kind: "invalid", reason: `not JSON (${msg(e)})` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", reason: "not a graph object" };
  }
  const g = value as { version?: unknown; symbols?: unknown };
  if (g.version !== SYMBOL_GRAPH_VERSION) {
    return { kind: "invalid", reason: `unsupported version ${JSON.stringify(g.version ?? null)}` };
  }
  if (g.symbols === null || typeof g.symbols !== "object" || Array.isArray(g.symbols)) {
    return { kind: "invalid", reason: "symbols is not an object" };
  }
  for (const [key, rec] of Object.entries(g.symbols as Record<string, unknown>)) {
    if (!validRecord(rec)) return { kind: "invalid", reason: `symbol ${JSON.stringify(key)} malformed` };
  }
  return { kind: "valid", graph: { version: SYMBOL_GRAPH_VERSION, symbols: g.symbols as Record<string, ExportedSymbolRecord> } };
}

export function loadSymbolGraph(workspace: string): ExportedSymbolGraph | undefined {
  const loaded = loadSymbolGraphFile(symbolGraphCachePath(workspace));
  return loaded.kind === "valid" ? loaded.graph : undefined;
}

export interface SymbolGraphSave {
  ok: boolean;
  written: boolean;
  reason?: string;
}

/** Atomic save; failures are reported, never thrown. */
export function saveSymbolGraph(file: string, graph: ExportedSymbolGraph): SymbolGraphSave {
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
    if (isUnix) chmodSync(dir, 0o700);
  } catch (e) {
    return { ok: false, written: false, reason: `mkdir (${msg(e)})` };
  }
  const body = JSON.stringify(graph);
  if (Buffer.byteLength(body, "utf8") > SYMBOL_GRAPH_MAX_BYTES) {
    return { ok: false, written: false, reason: "serialized graph over byte cap" };
  }
  const tmp = path.join(dir, `.symbol-graph-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, body, "utf8");
    if (isUnix) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    if (isUnix) chmodSync(file, 0o600);
    return { ok: true, written: true };
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    return { ok: false, written: false, reason: `write (${msg(e)})` };
  }
}

/** Skip rewrite when bytes unchanged (best-effort). */
export function saveSymbolGraphIfChanged(file: string, graph: ExportedSymbolGraph): SymbolGraphSave {
  const body = JSON.stringify(graph);
  try {
    const prev = readFileSync(file, "utf8");
    if (prev === body) {
      const st = statSync(file);
      if (isUnix && (st.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
      return { ok: true, written: false };
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      /* continue to write */
    }
  }
  return saveSymbolGraph(file, graph);
}