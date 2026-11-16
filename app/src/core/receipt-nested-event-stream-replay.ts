/**
 * receipt-nested-event-stream-replay.ts — R172 reduced nested child event-stream
 * replay (ruling **478**).
 *
 * Walks parent→child→… session JSONL streams discovered from ONE verified parent
 * event read (hash/anchor first — same honesty as rulings 357 and 456). Recurses
 * into each trusted child's own `subagent.start`/`end` boundaries within
 * depth/node budgets. Does NOT authenticate an issuer principal, bind
 * parentReceiptId contracts, or claim keyed cross-process attestation.
 */

import {
  readParentSessionEvents,
  subagentBoundariesFromParentEvents,
  type SubagentBoundaryRow,
} from "./receipt-child-session-stream";
import { verifySessionEventAnchorSync, type ChainAnchorVerdict } from "./chain-anchor-verify";

export const NESTED_EVENT_STREAM_REPLAY_DEFAULT_DEPTH = 4;
export const NESTED_EVENT_STREAM_REPLAY_MAX_NODES = 256;

export type NestedEventStreamEvidence =
  | "hash_and_anchor_valid"
  | "hash_walk_unanchored"
  | "broken_chain"
  | "missing_stream"
  | "cycle"
  | "depth_exceeded"
  | "node_budget_exceeded"
  | "workspace_unavailable";

export interface NestedEventStreamReplayNode {
  sessionId: string;
  depth: number;
  evidence: NestedEventStreamEvidence;
  eventCount?: number;
  status?: string;
  taskHead?: string;
  children: NestedEventStreamReplayNode[];
}

export interface NestedEventStreamReplayVerdict {
  ok: boolean;
  rootSessionId: string;
  /** Root stream evidence when the root itself was assessed. */
  rootEvidence?: NestedEventStreamEvidence;
  nodes: NestedEventStreamReplayNode[];
  visited: number;
  trusted: number;
  refused: number;
  maxDepth: number;
  residual: string;
}

const TRUSTED: ReadonlySet<NestedEventStreamEvidence> = new Set([
  "hash_and_anchor_valid",
  "hash_walk_unanchored",
]);

const RESIDUAL =
  "authenticated issuer + parentReceiptId terminal contracts + keyed cross-process attestation remain OPEN (R172)";

function evidenceFromVerdict(verdict: ChainAnchorVerdict): NestedEventStreamEvidence {
  if (verdict.skipped) return "missing_stream";
  if (!verdict.ok) return "broken_chain";
  if (verdict.anchorAbsent) return "hash_walk_unanchored";
  return "hash_and_anchor_valid";
}

function walkChildren(
  workspace: string,
  boundaries: readonly SubagentBoundaryRow[],
  depth: number,
  maxDepth: number,
  ancestry: ReadonlySet<string>,
  state: { visited: number; trusted: number; refused: number },
): NestedEventStreamReplayNode[] {
  if (boundaries.length === 0) return [];
  if (state.visited >= NESTED_EVENT_STREAM_REPLAY_MAX_NODES) {
    state.refused += boundaries.length;
    return boundaries.map((row) => ({
      sessionId: row.childSessionId,
      depth,
      evidence: "node_budget_exceeded" as const,
      status: row.status,
      taskHead: row.taskHead,
      children: [],
    }));
  }
  if (depth > maxDepth) {
    state.refused += boundaries.length;
    return boundaries.map((row) => ({
      sessionId: row.childSessionId,
      depth,
      evidence: "depth_exceeded" as const,
      status: row.status,
      taskHead: row.taskHead,
      children: [],
    }));
  }

  const nodes: NestedEventStreamReplayNode[] = [];
  for (const row of boundaries) {
    if (state.visited >= NESTED_EVENT_STREAM_REPLAY_MAX_NODES) {
      nodes.push({
        sessionId: row.childSessionId,
        depth,
        evidence: "node_budget_exceeded",
        status: row.status,
        taskHead: row.taskHead,
        children: [],
      });
      state.refused += 1;
      continue;
    }
    state.visited += 1;
    if (ancestry.has(row.childSessionId)) {
      state.refused += 1;
      nodes.push({
        sessionId: row.childSessionId,
        depth,
        evidence: "cycle",
        status: row.status,
        taskHead: row.taskHead,
        children: [],
      });
      continue;
    }

    const integrity = verifySessionEventAnchorSync(workspace, row.childSessionId);
    const evidence = evidenceFromVerdict(integrity);
    if (!TRUSTED.has(evidence)) {
      state.refused += 1;
      nodes.push({
        sessionId: row.childSessionId,
        depth,
        evidence,
        eventCount: integrity.skipped ? undefined : integrity.count,
        status: row.status,
        taskHead: row.taskHead,
        children: [],
      });
      continue;
    }

    state.trusted += 1;
    // Verified snapshot: only after hash/anchor trust do we read events and recurse.
    const childEvents = readParentSessionEvents(workspace, row.childSessionId);
    const nextBoundaries = subagentBoundariesFromParentEvents(childEvents);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(row.childSessionId);
    const children = walkChildren(
      workspace,
      nextBoundaries,
      depth + 1,
      maxDepth,
      nextAncestry,
      state,
    );
    nodes.push({
      sessionId: row.childSessionId,
      depth,
      evidence,
      eventCount: integrity.count,
      status: row.status,
      taskHead: row.taskHead,
      children,
    });
  }
  return nodes;
}

/**
 * Replay nested child session event streams rooted at `rootSessionId`.
 * Discovers children only from a verified parent event read.
 */
export function replayNestedEventStreams(
  workspace: string | undefined,
  rootSessionId: string,
  opts?: { maxDepth?: number },
): NestedEventStreamReplayVerdict {
  const maxDepth = Math.max(
    0,
    Math.floor(opts?.maxDepth ?? NESTED_EVENT_STREAM_REPLAY_DEFAULT_DEPTH),
  );
  const root = rootSessionId.trim();
  if (root === "") {
    return {
      ok: true,
      rootSessionId: "",
      nodes: [],
      visited: 0,
      trusted: 0,
      refused: 0,
      maxDepth,
      residual: RESIDUAL,
    };
  }
  if (!workspace) {
    return {
      ok: false,
      rootSessionId: root,
      rootEvidence: "workspace_unavailable",
      nodes: [],
      visited: 0,
      trusted: 0,
      refused: 1,
      maxDepth,
      residual: RESIDUAL,
    };
  }

  const rootIntegrity = verifySessionEventAnchorSync(workspace, root);
  const rootEvidence = evidenceFromVerdict(rootIntegrity);

  // Absent root stream: nothing to replay (session may predate events).
  if (rootIntegrity.skipped) {
    return {
      ok: true,
      rootSessionId: root,
      rootEvidence: "missing_stream",
      nodes: [],
      visited: 0,
      trusted: 0,
      refused: 0,
      maxDepth,
      residual: RESIDUAL,
    };
  }

  if (!TRUSTED.has(rootEvidence)) {
    return {
      ok: false,
      rootSessionId: root,
      rootEvidence,
      nodes: [],
      visited: 0,
      trusted: 0,
      refused: 1,
      maxDepth,
      residual: RESIDUAL,
    };
  }

  // ONE verified parent snapshot: discover child session ids only from this read.
  const parentEvents = readParentSessionEvents(workspace, root);
  const boundaries = subagentBoundariesFromParentEvents(parentEvents);
  const state = { visited: 0, trusted: 0, refused: 0 };
  const ancestry = new Set<string>([root]);
  const nodes = walkChildren(workspace, boundaries, 0, maxDepth, ancestry, state);
  return {
    ok: state.refused === 0,
    rootSessionId: root,
    rootEvidence,
    nodes,
    visited: state.visited,
    trusted: state.trusted,
    refused: state.refused,
    maxDepth,
    residual: RESIDUAL,
  };
}

function evidenceLabel(evidence: NestedEventStreamEvidence): string {
  switch (evidence) {
    case "hash_and_anchor_valid":
      return "hash/head valid";
    case "hash_walk_unanchored":
      return "hash-walk OK (unanchored)";
    case "broken_chain":
      return "INVALID chain";
    case "missing_stream":
      return "MISSING stream";
    case "cycle":
      return "CYCLE refused";
    case "depth_exceeded":
      return "depth budget exceeded";
    case "node_budget_exceeded":
      return "node budget exceeded";
    case "workspace_unavailable":
      return "workspace absent";
  }
}

function formatNode(node: NestedEventStreamReplayNode, indent: string, out: string[]): void {
  const bits = [`${indent}· depth ${node.depth} session ${node.sessionId}`];
  if (node.eventCount !== undefined) bits.push(`${node.eventCount} event(s)`);
  if (node.status) bits.push(`status ${node.status}`);
  if (node.taskHead) bits.push(`task "${node.taskHead}"`);
  bits.push(evidenceLabel(node.evidence));
  out.push(bits.join(" · "));
  for (const child of node.children) formatNode(child, `${indent}  `, out);
}

export function formatNestedEventStreamReplayLines(
  verdict: NestedEventStreamReplayVerdict,
): string[] {
  if (verdict.rootSessionId === "" && verdict.visited === 0 && verdict.refused === 0) {
    return ["nested event-stream replay: (no root session)"];
  }
  if (verdict.rootEvidence === "missing_stream" && verdict.visited === 0) {
    return [
      `nested event-stream replay: ok (root stream absent for ${verdict.rootSessionId})`,
      `  residual: ${verdict.residual}`,
    ];
  }
  const lines = [
    `nested event-stream replay: ${verdict.ok ? "ok" : "refused"} ` +
      `(visited ${verdict.visited}, trusted ${verdict.trusted}, refused ${verdict.refused}, maxDepth ${verdict.maxDepth})`,
  ];
  if (verdict.rootEvidence) {
    lines.push(`  root ${verdict.rootSessionId}: ${evidenceLabel(verdict.rootEvidence)}`);
  }
  for (const node of verdict.nodes) formatNode(node, "  ", lines);
  lines.push(`  residual: ${verdict.residual}`);
  return lines;
}
