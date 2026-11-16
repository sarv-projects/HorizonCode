/**
 * G-7: ASCII “learning graph” of curator proposals (Hermes growth surface).
 * Read-only view of `<stateDir>/proposals.jsonl`; does not apply anything.
 *
 * Two views are exposed:
 *  - `renderLearningGraphAscii` keeps the original single-chain view (the
 *    default `/graph` output) byte-compatible with the reduced slice.
 *  - `renderLearningGraphExpandedAscii` renders a BOUNDED graph (nodes + labelled
 *    edges, shared-reference edges can form cycles so the walk is cycle-safe)
 *    derived only from existing curator/proposal data (`reads`, `evidence` and
 *    store order). No inference, no clock, no randomness — deterministic for a
 *    given store. `/graph expanded` selects it without changing the default.
 */

import { loadProposals, type StoredProposalRow } from "./curator";
import { workspaceStateDir } from "./paths";

const KIND_ABBR: Record<string, string> = {
  memory: "mem",
  skill: "sk",
  prompt: "pr",
  hook: "hk",
  policy: "po",
};

function abbrev(kind: string): string {
  return KIND_ABBR[kind] ?? kind.slice(0, 3);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** One node per proposal, edges by chronological order (not causal inference). */
export function renderLearningGraphAscii(proposals: readonly StoredProposalRow[]): string {
  if (proposals.length === 0) return "learning graph: (no curator proposals yet)\n  proposals.jsonl is empty — run `bun run grow` after post-mortems.";
  const lines: string[] = ["learning graph (curator proposals, oldest → newest)", ""];
  for (let i = 0; i < proposals.length; i += 1) {
    const row = proposals[i]!;
    const tag = abbrev(row.kind);
    const title = clip(row.title, 48);
    const digest = row.digest.slice(0, 8);
    if (i === 0) {
      lines.push(`  [${tag}] ${title}  (${digest})`);
    } else {
      lines.push(`    |`);
      lines.push(`    v`);
      lines.push(`  [${tag}] ${title}  (${digest})`);
    }
  }
  lines.push("", `  ${proposals.length} proposal(s) in store — none applied (ADR-010).`);
  return lines.join("\n");
}

/* ------------------------- bounded graph (G-7 fuller) ------------------------- */

/** Hard display caps; the model still reports the uncapped totals. */
export const GRAPH_MAX_NODES = 40;
export const GRAPH_MAX_EDGES = 80;
export const GRAPH_LABEL_MAX = 48;

export interface LearningGraphNode {
  /** Stable id `n<index>` assigned in store order. */
  id: string;
  /** 0-based position in the store. */
  index: number;
  kind: string;
  title: string;
  digest: string;
  label: string;
}

export type LearningGraphEdgeKind = "next" | "reads" | "evidence";

export interface LearningGraphEdge {
  from: string;
  to: string;
  kind: LearningGraphEdgeKind;
  /** Short, human-readable edge caption (no newline). */
  label: string;
  /** The shared reference token, when `kind` is `reads` or `evidence`. */
  ref?: string;
}

export interface LearningGraphModel {
  nodes: LearningGraphNode[];
  edges: LearningGraphEdge[];
  /** Totals before display capping (honesty about truncation). */
  totalNodes: number;
  totalEdges: number;
}

export interface BuildLearningGraphOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxLabel?: number;
  /** Add chronological `next` edges between adjacent stored proposals. Default true. */
  includeChronological?: boolean;
}

function edgeLabel(kind: LearningGraphEdgeKind, ref: string, maxLabel: number): string {
  return `${kind}:${clip(ref, maxLabel)}`;
}

/**
 * Build a bounded graph from existing proposal data only.
 *
 * Edges:
 *  - `next`      — chronological adjacency in the store (the old chain, now an
 *                  edge type inside the graph);
 *  - `reads`     — two proposals that cite the same `reads` path are neighbours
 *                  in BOTH directions;
 *  - `evidence`  — same for a shared `evidence` token (transcript id or path).
 *
 * Bidirectional reference edges make cycles real (e.g. A↔B via `reads` and
 * A↔B again via `evidence`), so callers MUST walk with a visited set; the
 * renderer below does. Deterministic: input order + lexicographic sort only.
 */
export function buildLearningGraphModel(
  proposals: readonly StoredProposalRow[],
  opts: BuildLearningGraphOptions = {},
): LearningGraphModel {
  const maxNodes = opts.maxNodes ?? GRAPH_MAX_NODES;
  const maxEdges = opts.maxEdges ?? GRAPH_MAX_EDGES;
  const maxLabel = opts.maxLabel ?? GRAPH_LABEL_MAX;
  const includeChronological = opts.includeChronological ?? true;

  const nodes: LearningGraphNode[] = proposals.slice(0, maxNodes).map((row, index) => ({
    id: `n${index}`,
    index,
    kind: row.kind,
    title: row.title,
    digest: row.digest,
    label: `[${abbrev(row.kind)}] ${clip(row.title, maxLabel)} (${row.digest.slice(0, 8)})`,
  }));
  const visible = new Set(nodes.map((n) => n.id));

  const refSources: Array<{ kind: LearningGraphEdgeKind; ref: string; index: number }> = [];
  proposals.slice(0, maxNodes).forEach((row, index) => {
    for (const ref of row.reads) refSources.push({ kind: "reads", ref: ref.trim(), index });
    for (const ref of row.evidence) refSources.push({ kind: "evidence", ref: ref.trim(), index });
  });
  const grouped = new Map<string, { kind: LearningGraphEdgeKind; ref: string; indices: number[] }>();
  for (const source of refSources) {
    if (source.ref === "") continue;
    const key = `${source.kind}\u0000${source.ref}`;
    let entry = grouped.get(key);
    if (entry === undefined) {
      entry = { kind: source.kind, ref: source.ref, indices: [] };
      grouped.set(key, entry);
    }
    if (!entry.indices.includes(source.index)) entry.indices.push(source.index);
  }

  const edgeMap = new Map<string, LearningGraphEdge>();
  for (const entry of grouped.values()) {
    const sorted = [...entry.indices].sort((a, b) => a - b);
    const caption = edgeLabel(entry.kind, entry.ref, maxLabel);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const a = `n${sorted[i]!}`;
      const b = `n${sorted[i + 1]!}`;
      if (!visible.has(a) || !visible.has(b)) continue;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const key = `${from}\u0000${to}\u0000${caption}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { from, to, kind: entry.kind, label: caption, ref: entry.ref });
        }
      }
    }
  }
  if (includeChronological) {
    for (let i = 0; i + 1 < nodes.length; i += 1) {
      const from = nodes[i]!.id;
      const to = nodes[i + 1]!.id;
      const label = "next";
      const key = `${from}\u0000${to}\u0000${label}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { from, to, kind: "next", label });
    }
  }

  const num = (id: string): number => Number(id.slice(1));
  const allEdges = [...edgeMap.values()].sort(
    (a, b) =>
      num(a.from) - num(b.from) ||
      num(a.to) - num(b.to) ||
      a.label.localeCompare(b.label) ||
      a.kind.localeCompare(b.kind),
  );
  return {
    nodes,
    edges: allEdges.slice(0, maxEdges),
    totalNodes: proposals.length,
    totalEdges: allEdges.length,
  };
}

/** Cycle-safe, bounded adjacency walk: each node is expanded at most once. */
function renderGraphWalk(model: LearningGraphModel, maxEdges: number): string[] {
  const lines: string[] = [];
  const adjacency = new Map<string, LearningGraphEdge[]>();
  for (const edge of model.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const visited = new Set<string>();
  const queue = model.nodes.map((n) => n.id);
  let shown = 0;
  while (queue.length > 0 && shown < maxEdges) {
    const id = queue.shift()!;
    const node = model.nodes.find((n) => n.id === id);
    lines.push(`  ${id}${node === undefined ? "" : ` · ${node.label}`}`);
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of adjacency.get(id) ?? []) {
      if (shown >= maxEdges) break;
      shown += 1;
      const suffix = visited.has(edge.to) || queue.includes(edge.to) ? " (cycle/seen)" : "";
      lines.push(`    -[${edge.label}]-> ${edge.to}${suffix}`);
      if (!visited.has(edge.to) && !queue.includes(edge.to)) queue.push(edge.to);
    }
  }
  if (shown >= maxEdges && model.edges.length > shown) {
    lines.push(`  … walk truncated at ${maxEdges} edge(s)`);
  }
  return lines;
}

/** Expanded, bounded graph view (deterministic; shared-reference edges can cycle). */
export function renderLearningGraphExpandedAscii(
  proposals: readonly StoredProposalRow[],
  opts: BuildLearningGraphOptions = {},
): string {
  if (proposals.length === 0) return renderLearningGraphAscii([]);
  const model = buildLearningGraphModel(proposals, opts);
  const lines: string[] = [
    "learning graph (expanded, bounded: shared reads/evidence + chronological edges)",
    "",
    `  nodes (${model.nodes.length}):`,
  ];
  for (const node of model.nodes) lines.push(`    ${node.id}  ${node.label}`);
  lines.push("", `  edges (${model.edges.length}):`);
  for (const edge of model.edges) {
    lines.push(`    ${edge.from} --${edge.label}--> ${edge.to}`);
  }
  if (model.edges.length === 0) lines.push("    (no shared references between proposals)");
  lines.push("", "  walk (cycle-safe, each node expanded once):");
  lines.push(...renderGraphWalk(model, opts.maxEdges ?? GRAPH_MAX_EDGES));
  lines.push("");
  const hiddenNodes = model.totalNodes - model.nodes.length;
  const hiddenEdges = model.totalEdges - model.edges.length;
  if (hiddenNodes > 0 || hiddenEdges > 0) {
    lines.push(`  bounded: +${hiddenNodes} node(s), +${hiddenEdges} edge(s) omitted`);
  }
  lines.push(`  ${model.totalNodes} proposal(s) in store — none applied (ADR-010).`);
  return lines.join("\n");
}

export interface WorkspaceGraphOptions extends BuildLearningGraphOptions {
  /** Select the expanded bounded graph instead of the default chain. Default false. */
  expanded?: boolean;
}

export function renderWorkspaceLearningGraph(workspace: string, opts: WorkspaceGraphOptions = {}): string {
  const stateDir = workspaceStateDir(workspace);
  const load = loadProposals(stateDir);
  const proposals = load.missing ? [] : load.proposals;
  if (opts.expanded === true) return renderLearningGraphExpandedAscii(proposals, opts);
  return renderLearningGraphAscii(proposals);
}
