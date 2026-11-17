/**
 * agent-graph.ts — G-7 residual: a bounded WHOLE-AGENT graph beyond curator
 * proposal data (aider/Hermes-style growth surface).
 *
 * Extends the G-7 learning graph (which only sees proposals) with agent-level
 * node kinds — sessions, tools, skills and proposals — and the edges between
 * them. Pure and deterministic: input order + lexicographic sort only, no
 * clock, no randomness, no inference of causality beyond an explicit
 * `session.tools` field and lexical reference matching. Bounded with hard caps
 * that report honest uncapped totals; the ASCII walk is cycle-safe because a
 * reference edge (and a `next` edge) can form cycles.
 *
 * Rendering is through the EXISTING `/graph` command (`/graph agent`); the
 * default and `expanded` views stay byte-compatible (ruling 502).
 */

import { existsSync } from "node:fs";
import { loadProposals, type StoredProposalRow } from "./curator";
import { sessionDbPath, workspaceStateDir } from "./paths";
import { SessionStore } from "./session";
import { listSkills } from "./skills";
import { metricContract } from "./metrics";

/** Hard display caps (mirrors the G-7 learning-graph caps, slightly wider for four node kinds). */
export const AGENT_GRAPH_MAX_NODES = 48;
export const AGENT_GRAPH_MAX_EDGES = 96;
export const AGENT_GRAPH_LABEL_MAX = 48;

export type AgentNodeKind = "session" | "tool" | "skill" | "proposal";

export interface AgentGraphNode {
  id: string;
  kind: AgentNodeKind;
  label: string;
  /** Stable reference (session id / tool name / skill name / proposal digest). */
  ref: string;
}

export type AgentEdgeKind = "used" | "mentions" | "derived-from" | "next";

export interface AgentGraphEdge {
  from: string;
  to: string;
  kind: AgentEdgeKind;
  label: string;
}

export interface AgentGraphModel {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  totalNodes: number;
  totalEdges: number;
}

export interface AgentGraphSession {
  id: string;
  title?: string;
  /** Tools this session used (the only non-lexical edge source). */
  tools?: readonly string[];
}

export interface AgentGraphSkill {
  name: string;
  description?: string;
}

export interface AgentGraphProposal {
  digest: string;
  title: string;
  kind: string;
  reads?: readonly string[];
  evidence?: readonly string[];
}

export interface AgentGraphInput {
  sessions?: readonly AgentGraphSession[];
  tools?: readonly string[];
  skills?: readonly AgentGraphSkill[];
  proposals?: readonly AgentGraphProposal[];
}

export interface BuildAgentGraphOptions {
  maxNodes?: number;
  maxEdges?: number;
  maxLabel?: number;
  /** Add chronological `next` edges within sessions and within proposals. Default true. */
  includeChronological?: boolean;
}

function clip(text: string, max: number): string {
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}\u2026`;
}

function nodeLabel(kind: AgentNodeKind, label: string, max: number): string {
  return `[${kind}] ${clip(label, max)}`;
}

/**
 * Build a bounded whole-agent graph. Node order is sessions → tools → skills →
 * proposals (kind grouped, input order within each group), ids are `s<n>`/`t<n>`/
 * `k<n>`/`p<n>` stable per position. Edges:
 *  - session `used`→ tool       (from session.tools, matched case-insensitively)
 *  - proposal `mentions`→ tool/skill (a tool/skill name appears in reads/evidence)
 *  - proposal `derived-from`→ session (an evidence token equals a session id)
 *  - `next` between adjacent sessions and adjacent proposals (chronological)
 */
export function buildAgentGraphModel(input: AgentGraphInput, opts: BuildAgentGraphOptions = {}): AgentGraphModel {
  const maxNodes = opts.maxNodes ?? AGENT_GRAPH_MAX_NODES;
  const maxEdges = opts.maxEdges ?? AGENT_GRAPH_MAX_EDGES;
  const maxLabel = opts.maxLabel ?? AGENT_GRAPH_LABEL_MAX;
  const includeChronological = opts.includeChronological ?? true;

  const allSessions = input.sessions ?? [];
  const allTools = input.tools ?? [];
  const allSkills = input.skills ?? [];
  const allProposals = input.proposals ?? [];

  // Build candidates in kind order, then apply ONE global node cap.
  type Candidate = { node: AgentGraphNode; source: string };
  const candidates: Candidate[] = [];
  allSessions.forEach((s, i) =>
    candidates.push({
      node: { id: `s${i}`, kind: "session", label: nodeLabel("session", s.title ?? s.id, maxLabel), ref: s.id },
      source: s.id,
    }),
  );
  allTools.forEach((name, i) =>
    candidates.push({
      node: { id: `t${i}`, kind: "tool", label: nodeLabel("tool", name, maxLabel), ref: name },
      source: name,
    }),
  );
  allSkills.forEach((s, i) =>
    candidates.push({
      node: { id: `k${i}`, kind: "skill", label: nodeLabel("skill", s.name, maxLabel), ref: s.name },
      source: s.name,
    }),
  );
  allProposals.forEach((p, i) =>
    candidates.push({
      node: { id: `p${i}`, kind: "proposal", label: nodeLabel("proposal", p.title, maxLabel), ref: p.digest },
      source: `p${i}`,
    }),
  );

  const capped = candidates.slice(0, maxNodes);
  const nodes = capped.map((c) => c.node);
  const sessionId = new Map<string, string>();
  const toolId = new Map<string, string>();
  const skillId = new Map<string, string>();
  const proposalIds = new Set<string>();
  for (const c of capped) {
    const n = c.node;
    if (n.kind === "session") sessionId.set(c.source, n.id);
    else if (n.kind === "tool") toolId.set(c.source.toLowerCase(), n.id);
    else if (n.kind === "skill") skillId.set(c.source.toLowerCase(), n.id);
    else proposalIds.add(n.id);
  }
  // Only capped slices participate in edge construction.
  const sessions = allSessions.filter((s) => sessionId.has(s.id));
  const proposals = allProposals.filter((_, i) => proposalIds.has(`p${i}`));

  const visible = new Set(nodes.map((n) => n.id));
  const edgeMap = new Map<string, AgentGraphEdge>();
  const addEdge = (from: string, to: string, kind: AgentEdgeKind, label: string): void => {
    if (!visible.has(from) || !visible.has(to) || from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}\u0000${label}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, kind, label });
  };

  // session -used-> tool
  for (const s of sessions) {
    const sid = sessionId.get(s.id);
    if (sid === undefined) continue;
    for (const t of s.tools ?? []) {
      const tid = toolId.get(String(t).toLowerCase());
      if (tid !== undefined) addEdge(sid, tid, "used", "used");
    }
  }
  // proposal -mentions-> tool/skill, -derived-from-> session
  proposals.forEach((p, i) => {
    const pid = `p${i}`;
    if (!proposalIds.has(pid)) return;
    const refs = [...(p.reads ?? []), ...(p.evidence ?? [])].filter((r) => typeof r === "string" && r.trim() !== "");
    for (const ref of refs) {
      const low = ref.toLowerCase();
      for (const [name, tid] of toolId) if (low.includes(name)) addEdge(pid, tid, "mentions", `mentions:${clip(name, maxLabel)}`);
      for (const [name, kid] of skillId) if (low.includes(name)) addEdge(pid, kid, "mentions", `mentions:${clip(name, maxLabel)}`);
      const sid = sessionId.get(ref);
      if (sid !== undefined) addEdge(pid, sid, "derived-from", "evidence");
    }
  });
  // chronological next within each kind group (in stable source order)
  if (includeChronological) {
    const sessionIds = sessions.map((s) => sessionId.get(s.id)).filter((x): x is string => x !== undefined);
    const proposalIdsInOrder = allProposals.map((_, i) => `p${i}`).filter((id) => proposalIds.has(id));
    for (let i = 0; i + 1 < sessionIds.length; i += 1) addEdge(sessionIds[i] as string, sessionIds[i + 1] as string, "next", "next");
    for (let i = 0; i + 1 < proposalIdsInOrder.length; i += 1) addEdge(proposalIdsInOrder[i] as string, proposalIdsInOrder[i + 1] as string, "next", "next");
  }

  const allEdges = [...edgeMap.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label),
  );
  return {
    nodes,
    edges: allEdges.slice(0, maxEdges),
    totalNodes: allSessions.length + allTools.length + allSkills.length + allProposals.length,
    totalEdges: allEdges.length,
  };
}

/** Cycle-safe bounded walk: each node is expanded at most once. */
function renderAgentWalk(model: AgentGraphModel, maxEdges: number): string[] {
  const lines: string[] = [];
  const adjacency = new Map<string, AgentGraphEdge[]>();
  for (const edge of model.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }
  const labelOf = new Map(model.nodes.map((n) => [n.id, n.label]));
  const visited = new Set<string>();
  const queued = new Set<string>(model.nodes.map((n) => n.id));
  const queue = model.nodes.map((n) => n.id);
  let shown = 0;
  while (queue.length > 0 && shown < maxEdges) {
    const id = queue.shift() as string;
    queued.delete(id);
    lines.push(`  ${id}${labelOf.has(id) ? ` · ${labelOf.get(id)}` : ""}`);
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of adjacency.get(id) ?? []) {
      if (shown >= maxEdges) break;
      shown += 1;
      const suffix = visited.has(edge.to) || queued.has(edge.to) ? " (cycle/seen)" : "";
      lines.push(`    -[${edge.label}]-> ${edge.to}${suffix}`);
      if (!visited.has(edge.to) && !queued.has(edge.to)) {
        queue.push(edge.to);
        queued.add(edge.to);
      }
    }
  }
  if (shown >= maxEdges && model.edges.length > shown) lines.push(`  \u2026 walk truncated at ${maxEdges} edge(s)`);
  return lines;
}

/** Render the whole-agent graph deterministically (cycle-safe, bounded). */
export function renderAgentGraphAscii(model: AgentGraphModel, opts: BuildAgentGraphOptions = {}): string {
  const lines: string[] = [
    "learning graph (whole-agent, bounded: sessions / tools / skills / proposals)",
    "",
    `  nodes (${model.nodes.length}):`,
  ];
  for (const node of model.nodes) lines.push(`    ${node.id}  ${node.label}`);
  lines.push("", `  edges (${model.edges.length}):`);
  for (const edge of model.edges) lines.push(`    ${edge.from} --${edge.label}--> ${edge.to}`);
  if (model.edges.length === 0) lines.push("    (no agent-level relationships yet)");
  lines.push("", "  walk (cycle-safe, each node expanded once):");
  lines.push(...renderAgentWalk(model, opts.maxEdges ?? AGENT_GRAPH_MAX_EDGES));
  lines.push("");
  const hiddenNodes = model.totalNodes - model.nodes.length;
  const hiddenEdges = model.totalEdges - model.edges.length;
  if (hiddenNodes > 0 || hiddenEdges > 0) lines.push(`  bounded: +${hiddenNodes} node(s), +${hiddenEdges} edge(s) omitted`);
  lines.push(`  ${model.totalNodes} agent object(s) in view — proposals are never applied (ADR-010).`);
  return lines.join("\n");
}

/**
 * Collect a workspace's agent objects from the existing stores. Best-effort:
 * an unreadable/absent store contributes nothing, never throws. `toolNames`
 * is injected by the caller (the TUI already holds `toolSpecs()`), avoiding a
 * core → tools import cycle.
 */
export function agentGraphInputFromWorkspace(workspace: string, toolNames: readonly string[] = []): AgentGraphInput {
  const stateDir = workspaceStateDir(workspace);
  const loaded = loadProposals(stateDir);
  const proposals: AgentGraphProposal[] = loaded.missing
    ? []
    : loaded.proposals.map((row: StoredProposalRow) => ({
        digest: row.digest,
        title: row.title,
        kind: row.kind,
        reads: row.reads,
        evidence: row.evidence,
      }));
  let sessions: AgentGraphSession[] = [];
  try {
    // Read-only view: never materialize a session DB just to render the graph.
    if (existsSync(sessionDbPath(workspace))) {
      const store = new SessionStore(workspace);
      sessions = store.listSessions(AGENT_GRAPH_MAX_NODES).map((s) => ({ id: s.id, title: s.title }));
    }
  } catch {
    sessions = [];
  }
  let skills: AgentGraphSkill[] = [];
  try {
    skills = listSkills(workspace).map((s) => ({ name: s.name, description: s.description }));
  } catch {
    skills = [];
  }
  return { sessions, tools: [...toolNames], skills, proposals };
}

/** Renderer for the workspace-wide graph; used by `/graph agent`. */
export function renderWorkspaceAgentGraph(workspace: string, toolNames: readonly string[] = []): string {
  const input = agentGraphInputFromWorkspace(workspace, toolNames);
  return renderAgentGraphAscii(buildAgentGraphModel(input));
}

/**
 * H-7/ruling 529 (repo-wide sweep): the node/edge/object counts the `/graph
 * agent` view prints are published statistics. This parallel surface contracts
 * them; `renderAgentGraphAscii` stays byte-identical. Totals are uncapped store
 * counts (the ASCII view may show fewer under the display caps) and the excludes
 * slot says so openly. No causality is inferred beyond explicit `session.tools`
 * and lexical reference matching (see the module header).
 */
export function agentGraphPublication(input: AgentGraphInput, opts: BuildAgentGraphOptions = {}): string[] {
  const model = buildAgentGraphModel(input, opts);
  const anchor = "none — first whole-agent graph render (no prior snapshot to compare against)";
  const population = "the sessions, tools, skills and proposals supplied to this graph render";
  const excludes = `display caps omitted ${model.totalNodes - model.nodes.length} node(s) and ${model.totalEdges - model.edges.length} edge(s) from the render; totals below are uncapped`;
  return [
    metricContract({ metric: "agent graph objects in view", anchor, population, excludes: "none — every supplied agent object is counted; proposals are never applied (ADR-010)", value: model.totalNodes }),
    metricContract({ metric: "agent graph nodes rendered", anchor, population, excludes, value: model.nodes.length }),
    metricContract({ metric: "agent graph edges rendered", anchor, population, excludes, value: model.edges.length }),
    metricContract({ metric: "agent graph total edges", anchor, population, excludes: "none — uncapped edge total from explicit tools and lexical references", value: model.totalEdges }),
  ];
}
