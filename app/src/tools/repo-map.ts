/** `repo_map` — a token-budgeted structural map of the repository (docs/09 §4.2, B-1).
 *
 * Algorithm (the aider-derived design, docs/30 §2 B-1, docs/09-tools.md §4.2):
 * a dependency-free def/ref graph over the workspace text — definitions by
 * per-language patterns, references by whole-identifier occurrence — scored by
 * personalised PageRank (damping 0.85) where focus files carry the
 * personalisation mass and edges out of focus files and out of idents
 * defined in focus files carry the aider multipliers (10x / 50x). The render
 * is cut to the token budget by binary search over the ranked file list.
 *
 * Reduced form, stated: no tree-sitter (no dependency; patterns are lexical),
 * no persistent index (the map is rebuilt per call, so it is never `stale`),
 * and `tokens` is the runtime's bytes/4 estimate — the same estimate the
 * output-budget fit uses, never an accounting claim.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { estimateTokens } from "../core/output-budget";
import { isBinary, relPath, resolvePath } from "./helpers";

const DEFAULT_MAX_TOKENS = 4_000;
const HARD_MAX_TOKENS = 16_000;
const MAX_FILES = 3_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEFS_PER_FILE = 12;
const DAMPING = 0.85;
const ITERATIONS = 30;
const FOCUS_EDGE_MULTIPLIER = 10;
const FOCUS_IDENT_MULTIPLIER = 50;

/** Directory names never walked. `.hz` (canonical) and `.hzcode` (legacy) hold runtime state, not source. */
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

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** Definition patterns per extension family; first capture group is the name.
 * Exported/`pub` declarations come first so a file's capped def list leads
 * with its public surface, then the module-local declarations (line order
 * within each group). */
const DEF_PATTERNS: Record<string, { exported: RegExp[]; local: RegExp[] }> = {
  ts: {
    exported: [
      /(?:^|\W)export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    ],
    local: [
      /(?:^|\W)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      /(?:^|\W)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    ],
  },
  py: { exported: [], local: [/^\s*(?:async\s+)?def\s+(\w+)/gm, /^\s*class\s+(\w+)/gm] },
  rs: {
    exported: [
      /(?:^|\W)pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)/gm,
      /(?:^|\W)pub(?:\([^)]*\))?\s+(?:struct|enum|trait|type)\s+(\w+)/gm,
    ],
    local: [/(?:^|\W)(?:async\s+)?fn\s+(\w+)/gm, /(?:^|\W)(?:struct|enum|trait|type)\s+(\w+)/gm],
  },
  go: { exported: [], local: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/gm, /^\s*type\s+(\w+)/gm] },
  generic: {
    exported: [],
    local: [/\bclass\s+(\w+)/g, /\bdef\s+(\w+)/g, /\bfunction\s+(\w+)/g],
  },
};

const LANGUAGE_OF: Record<string, keyof typeof DEF_PATTERNS> = {
  ".ts": "ts", ".tsx": "ts", ".js": "ts", ".jsx": "ts", ".mjs": "ts", ".cjs": "ts",
  ".py": "py",
  ".rs": "rs",
  ".go": "go",
  ".java": "generic", ".kt": "generic", ".cs": "generic", ".rb": "generic", ".php": "generic",
  ".c": "generic", ".h": "generic", ".cc": "generic", ".cpp": "generic", ".hpp": "generic",
};

interface FileInfo {
  rel: string;
  defs: string[];
  tokenCounts: Map<string, number>;
}

interface RankedFile {
  rel: string;
  defs: string[];
  rank: number;
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Test-looking paths are excluded unless the caller asks for them. */
export function isTestPath(rel: string): boolean {
  const base = path.basename(rel);
  return (
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /^test_/.test(base) ||
    /_test\.[^.]+$/.test(base) ||
    /(^|\/)tests?\//.test(rel)
  );
}

/** Definitions of one file's text: exported/`pub` surface first, then locals
 * (line order within each group), deduped. */
export function extractDefs(text: string, ext: string): string[] {
  const patterns = DEF_PATTERNS[LANGUAGE_OF[ext] ?? "generic"] ?? { exported: [], local: [] };
  const seen = new Set<string>();
  const defs: string[] = [];
  for (const group of [patterns.exported, patterns.local]) {
    for (const pattern of group) {
      const re = new RegExp(pattern.source, pattern.flags);
      for (const match of text.matchAll(re)) {
        const name = match[1];
        if (name && !seen.has(name)) {
          seen.add(name);
          defs.push(name);
        }
      }
    }
  }
  return defs;
}

/** Whole-identifier occurrence counts for one file's text. */
export function countIdents(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(new RegExp(IDENT_RE.source, "g"))) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

/**
 * Personalised PageRank over the file graph. `edges` maps from-file to a map
 * of to-file weights; `personalization` holds non-negative weights (files not
 * present share the remainder evenly). Pure and deterministic: ties resolve
 * on the input order, so callers sort first.
 */
export function rankFiles(
  files: string[],
  edges: Map<string, Map<string, number>>,
  personalization?: Map<string, number>,
): Map<string, number> {
  const n = files.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;
  const teleport = new Map<string, number>();
  let teleportTotal = 0;
  for (const file of files) {
    const w = personalization?.get(file) ?? 0;
    teleport.set(file, w);
    teleportTotal += w;
  }
  if (teleportTotal <= 0) {
    for (const file of files) teleport.set(file, 1 / n);
  } else {
    // Files beyond the named focus share a small remaining mass so the walk
    // still escapes dangling nodes.
    for (const file of files) {
      teleport.set(file, 0.9 * (teleport.get(file) ?? 0) / teleportTotal + 0.1 / n);
    }
  }

  const outWeight = new Map<string, number>();
  for (const file of files) {
    let total = 0;
    for (const w of (edges.get(file) ?? new Map()).values()) total += w;
    outWeight.set(file, total);
  }

  for (const file of files) ranks.set(file, 1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Map<string, number>();
    for (const file of files) next.set(file, (1 - DAMPING) * (teleport.get(file) ?? 0));
    let danglingMass = 0;
    for (const file of files) {
      const out = outWeight.get(file) ?? 0;
      const rank = ranks.get(file) ?? 0;
      if (out <= 0) {
        danglingMass += rank;
        continue;
      }
      for (const [to, w] of edges.get(file) ?? []) {
        next.set(to, (next.get(to) ?? 0) + DAMPING * rank * (w / out));
      }
    }
    // Dangling mass redistributes by the teleport distribution.
    if (danglingMass > 0) {
      for (const file of files) next.set(file, (next.get(file) ?? 0) + DAMPING * danglingMass * (teleport.get(file) ?? 0));
    }
    ranks.clear();
    for (const file of files) ranks.set(file, next.get(file) ?? 0);
  }
  return ranks;
}

/** Render the top-`count` ranked files as the map body. Monotonic in count. */
export function renderMap(ranked: RankedFile[], count: number): string {
  const lines: string[] = [];
  for (const file of ranked.slice(0, count)) {
    lines.push(`${file.rel}:`);
    for (const def of file.defs.slice(0, MAX_DEFS_PER_FILE)) lines.push(`  \u22ee ${def}`);
  }
  return lines.join("\n");
}

/** Binary search the largest prefix of `ranked` whose render fits `budget`. */
export function pickByBudget(ranked: RankedFile[], budgetTokens: number): { count: number; tokens: number } {
  let lo = 0;
  let hi = ranked.length;
  let best = 0;
  let bestTokens = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = renderMap(ranked, mid);
    const tokens = estimateTokens(text);
    if (tokens <= budgetTokens || mid === 0) {
      best = mid;
      bestTokens = tokens;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { count: best, tokens: bestTokens };
}

interface RepoMapOptions {
  root: string;
  cwd: string;
  focus?: string[];
  includeTests?: boolean;
  maxTokens?: number;
}

export interface RepoMapResult {
  map: string;
  tokens: number;
  filesIncluded: number;
  filesOmitted: number;
  truncated: boolean;
}

/** Build the map. Deterministic for the same tree and params (byte-stable). */
export function buildRepoMap(opts: RepoMapOptions): RepoMapResult | { empty: true } {
  const maxTokens = Math.max(64, Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, HARD_MAX_TOKENS));
  const focusSet = new Set(
    (opts.focus ?? [])
      .map((f) => relPath(opts.cwd, resolvePath(opts.cwd, f)))
      .filter((f) => f !== "" && f !== "."),
  );

  const infos: FileInfo[] = [];
  const walk = (dir: string): void => {
    if (infos.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (infos.length >= MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relPath(opts.cwd, abs);
        if (!opts.includeTests && isTestPath(rel)) continue;
        let buf: Buffer;
        try {
          buf = readFileSync(abs);
        } catch {
          continue;
        }
        if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
        const text = buf.toString("utf8");
        const defs = extractDefs(text, path.extname(entry.name));
        if (defs.length === 0) {
          // Files without definitions still participate as reference sources.
          infos.push({ rel, defs: [], tokenCounts: countIdents(text) });
        } else {
          infos.push({ rel, defs, tokenCounts: countIdents(text) });
        }
      }
    }
  };
  walk(opts.root);

  if (infos.length === 0) return { empty: true };

  // Def file per ident (first definer wins; deterministic by walk order).
  const defFile = new Map<string, string>();
  for (const info of infos) for (const def of info.defs) if (!defFile.has(def)) defFile.set(def, info.rel);

  const focusIdents = new Set<string>();
  for (const info of infos) if (focusSet.has(info.rel)) for (const def of info.defs) focusIdents.add(def);

  const allFiles = infos.map((i) => i.rel);
  const edges = new Map<string, Map<string, number>>();
  for (const from of infos) {
    const fromMultiplier = focusSet.has(from.rel) ? FOCUS_EDGE_MULTIPLIER : 1;
    for (const [ident, count] of from.tokenCounts) {
      const to = defFile.get(ident);
      if (to === undefined || to === from.rel) continue;
      const weight = Math.sqrt(count) * (1 + (focusIdents.has(ident) ? FOCUS_IDENT_MULTIPLIER : 0)) * fromMultiplier;
      const outgoing = edges.get(from.rel) ?? new Map<string, number>();
      outgoing.set(to, (outgoing.get(to) ?? 0) + weight);
      edges.set(from.rel, outgoing);
    }
  }

  const personalization = new Map<string, number>();
  for (const file of focusSet) if (allFiles.includes(file)) personalization.set(file, 1);

  const ranks = rankFiles(allFiles, edges, personalization.size > 0 ? personalization : undefined);
  const ranked: RankedFile[] = infos
    .map((info) => ({ rel: info.rel, defs: info.defs, rank: ranks.get(info.rel) ?? 0 }))
    .sort((a, b) => (b.rank !== a.rank ? b.rank - a.rank : a.rel < b.rel ? -1 : 1));

  // Files with nothing to render (no defs) never make the map body.
  const renderable = ranked.filter((f) => f.defs.length > 0);
  const { count, tokens } = pickByBudget(renderable, maxTokens);
  const body = renderMap(renderable, count);
  const omitted = renderable.length - count;

  const stats = `[repo_map: ${count} file${count === 1 ? "" : "s"}, ~${tokens} tokens${omitted > 0 ? `, ${omitted} omitted` : ""}]`;
  const marker = omitted > 0 ? `\n[truncated: showing ${count} of ${renderable.length} files within ${maxTokens} tokens; raise maxTokens (hard ${HARD_MAX_TOKENS}) or pass focus]` : "";

  return {
    map: `${body}\n${stats}${marker}`,
    tokens,
    filesIncluded: count,
    filesOmitted: omitted,
    truncated: omitted > 0,
  };
}

export const repoMapTool: Tool = {
  name: "repo_map",
  description:
    "Produce a token-budgeted structural map of the repository (top definitions per file, ranked by relevance). For orientation without reading everything.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Subdirectory to map (default: workspace root)." },
      maxTokens: { type: "number", description: `Token budget (default ${DEFAULT_MAX_TOKENS}, hard ${HARD_MAX_TOKENS}).` },
      focus: {
        type: "array",
        items: { type: "string" },
        description: "Files to personalise the ranking toward, e.g. the files under discussion.",
      },
      includeTests: { type: "boolean", description: "Include test-looking paths (default false)." },
    },
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const rootInput = typeof args.path === "string" && args.path !== "" ? args.path : ".";
      const root = resolvePath(ctx.cwd, rootInput);
      const action: GuardAction = { kind: "fs.read", target: root };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const ok = await ctx.approve({ title: `Map ${relPath(ctx.cwd, root)}`, detail: root, kind: "fs.read" }, action);
        if (!ok) return fail("declined by user");
      }

      const focus = Array.isArray(args.focus) ? args.focus.filter((f): f is string => typeof f === "string") : undefined;
      const includeTests = args.includeTests === true;
      const maxTokens = typeof args.maxTokens === "number" && args.maxTokens > 0 ? args.maxTokens : undefined;

      const result = buildRepoMap({ root, cwd: ctx.cwd, focus, includeTests, maxTokens });
      if ("empty" in result) return fail("empty workspace");
      return { ok: true, output: result.map };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
