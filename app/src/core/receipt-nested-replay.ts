/**
 * receipt-nested-replay.ts — R172 reduced nested receipt-graph replay (ruling **456**).
 *
 * Walks parent→child `childEffectIds` from ONE verified receipts.jsonl snapshot
 * (same honesty as **360**). Recurses into each trusted child's own
 * `childEffectIds` within a depth/node budget. Does NOT authenticate an issuer
 * principal or keyed attestation. Nested event-stream replay is a sibling
 * module (**478**). Mutual `parentReceiptId` checks added under **657**.
 */

import type { Receipt } from "../contracts";
import { loadEffectLedger } from "./effect-ledger";
import {
  type ChildReceiptChainEvidence,
  type ChildReceiptLink,
} from "./receipt-child-list";
import {
  readVerifiedReceiptSnapshotSync,
  type VerifiedReceiptSnapshot,
} from "./receipt-chain-verify";
import { verifyParentReceiptIssuerStamps } from "./receipt-issuer-verify";
import { verifyParentReceiptLinksInSnapshot } from "./receipt-parent-link-verify";

export const NESTED_RECEIPT_REPLAY_DEFAULT_DEPTH = 4;
export const NESTED_RECEIPT_REPLAY_MAX_NODES = 256;

export type NestedReplayNodeEvidence =
  | ChildReceiptChainEvidence
  | "cycle"
  | "depth_exceeded"
  | "node_budget_exceeded";

export interface NestedReceiptReplayNode {
  effectId: string;
  depth: number;
  evidence: NestedReplayNodeEvidence;
  receiptId?: string;
  receiptSeq?: number;
  tool?: string;
  children: NestedReceiptReplayNode[];
}

export interface NestedReceiptReplayVerdict {
  ok: boolean;
  rootEffectIds: string[];
  nodes: NestedReceiptReplayNode[];
  visited: number;
  trusted: number;
  refused: number;
  maxDepth: number;
  anchorAbsent?: boolean;
  residual: string;
}

const TRUSTED: ReadonlySet<NestedReplayNodeEvidence> = new Set([
  "hash_and_anchor_valid",
  "hash_walk_unanchored",
]);

const RESIDUAL =
  "authenticated issuer + parentReceiptId terminal contracts + keyed cross-process attestation remain OPEN (R172)";

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.trim() !== ""))];
}

function childIdsFromReceipt(receipt: Receipt | undefined): string[] {
  if (!receipt?.childEffectIds?.length) return [];
  return uniqueIds(receipt.childEffectIds);
}

function linkToNode(
  link: ChildReceiptLink,
  depth: number,
  children: NestedReceiptReplayNode[] = [],
): NestedReceiptReplayNode {
  return {
    effectId: link.childEffectId,
    depth,
    evidence: link.chainEvidence,
    receiptId: link.receiptId,
    receiptSeq: link.receiptSeq,
    tool: link.tool,
    children,
  };
}

/** Index child links from an already-verified snapshot (no second file read). */
export function resolveChildReceiptLinksFromVerified(
  snapshot: VerifiedReceiptSnapshot,
  childEffectIds: readonly string[],
  opts?: { parentTool?: string; workspace?: string },
): ChildReceiptLink[] {
  const parentTool = opts?.parentTool;
  if (!snapshot.ok) {
    return uniqueIds(childEffectIds).map((childEffectId) => ({
      childEffectId,
      parentTool,
      chainEvidence: "broken_chain" as const,
    }));
  }
  const byEffect = new Map<string, Receipt>();
  const duplicates = new Set<string>();
  for (const row of snapshot.receipts) {
    if (typeof row.effectId === "string" && row.effectId !== "") {
      if (byEffect.has(row.effectId)) duplicates.add(row.effectId);
      else byEffect.set(row.effectId, row);
    }
  }
  const toolByEffect = opts?.workspace
    ? new Map(loadEffectLedger(opts.workspace).records.map((r) => [r.effectId, r.tool]))
    : undefined;
  return uniqueIds(childEffectIds).map((childEffectId) => {
    const receipt = byEffect.get(childEffectId);
    const chainEvidence: ChildReceiptChainEvidence =
      duplicates.has(childEffectId) ? "duplicate_effect_id"
      : !receipt ? "missing_receipt"
      : receipt.schemaVersion !== 2 ? "legacy_unbound_effect_id"
      : snapshot.anchorAbsent ? "hash_walk_unanchored"
      : "hash_and_anchor_valid";
    const trusted = TRUSTED.has(chainEvidence);
    return {
      childEffectId,
      chainEvidence,
      receiptId: trusted ? receipt?.id : undefined,
      receiptSeq: trusted ? receipt?.seq : undefined,
      tool: (trusted ? receipt?.tool : undefined) ?? toolByEffect?.get(childEffectId),
      parentTool,
    };
  });
}

function walk(
  workspace: string | undefined,
  snapshot: VerifiedReceiptSnapshot,
  ids: readonly string[],
  depth: number,
  maxDepth: number,
  ancestry: ReadonlySet<string>,
  state: { visited: number; trusted: number; refused: number },
  byEffect: Map<string, Receipt>,
  parentTool?: string,
): NestedReceiptReplayNode[] {
  if (ids.length === 0) return [];
  if (state.visited >= NESTED_RECEIPT_REPLAY_MAX_NODES) {
    state.refused += uniqueIds(ids).length;
    return uniqueIds(ids).map((effectId) => ({
      effectId,
      depth,
      evidence: "node_budget_exceeded" as const,
      children: [],
    }));
  }
  if (depth > maxDepth) {
    state.refused += uniqueIds(ids).length;
    return uniqueIds(ids).map((effectId) => ({
      effectId,
      depth,
      evidence: "depth_exceeded" as const,
      children: [],
    }));
  }

  const links = resolveChildReceiptLinksFromVerified(snapshot, ids, { parentTool, workspace });
  const nodes: NestedReceiptReplayNode[] = [];
  for (const link of links) {
    if (state.visited >= NESTED_RECEIPT_REPLAY_MAX_NODES) {
      nodes.push({
        effectId: link.childEffectId,
        depth,
        evidence: "node_budget_exceeded",
        children: [],
      });
      state.refused += 1;
      continue;
    }
    state.visited += 1;
    if (ancestry.has(link.childEffectId)) {
      state.refused += 1;
      nodes.push({
        effectId: link.childEffectId,
        depth,
        evidence: "cycle",
        children: [],
      });
      continue;
    }
    if (!TRUSTED.has(link.chainEvidence)) {
      state.refused += 1;
      nodes.push(linkToNode(link, depth));
      continue;
    }
    state.trusted += 1;
    const receipt = byEffect.get(link.childEffectId);
    const nextIds = childIdsFromReceipt(receipt);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(link.childEffectId);
    const children = walk(
      workspace,
      snapshot,
      nextIds,
      depth + 1,
      maxDepth,
      nextAncestry,
      state,
      byEffect,
      link.tool,
    );
    nodes.push(linkToNode(link, depth, children));
  }
  return nodes;
}

/**
 * Replay the nested child-receipt graph rooted at `rootChildEffectIds`.
 * Uses a single verified snapshot when `workspace` is set.
 */
export function replayNestedChildReceipts(
  workspace: string | undefined,
  rootChildEffectIds: readonly string[],
  opts?: { maxDepth?: number; snapshot?: VerifiedReceiptSnapshot },
): NestedReceiptReplayVerdict {
  const roots = uniqueIds(rootChildEffectIds);
  const maxDepth = Math.max(0, Math.floor(opts?.maxDepth ?? NESTED_RECEIPT_REPLAY_DEFAULT_DEPTH));
  if (roots.length === 0) {
    return {
      ok: true,
      rootEffectIds: [],
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
      rootEffectIds: roots,
      nodes: roots.map((effectId) => ({
        effectId,
        depth: 0,
        evidence: "workspace_unavailable" as const,
        children: [],
      })),
      visited: roots.length,
      trusted: 0,
      refused: roots.length,
      maxDepth,
      residual: RESIDUAL,
    };
  }

  const snapshot = opts?.snapshot ?? readVerifiedReceiptSnapshotSync(workspace);
  if (!snapshot.ok) {
    return {
      ok: false,
      rootEffectIds: roots,
      nodes: roots.map((effectId) => ({
        effectId,
        depth: 0,
        evidence: "broken_chain" as const,
        children: [],
      })),
      visited: roots.length,
      trusted: 0,
      refused: roots.length,
      maxDepth,
      residual: RESIDUAL,
    };
  }

  // Ruling 657: parentReceiptId mutual links must hold on the same snapshot.
  const parentLinks = verifyParentReceiptLinksInSnapshot(snapshot.receipts);
  let parentLinkRefuse: string | undefined;
  if (parentLinks.ok === false) parentLinkRefuse = parentLinks.reason;
  if (parentLinkRefuse !== undefined) {
    return {
      ok: false,
      rootEffectIds: roots,
      nodes: roots.map((effectId) => ({
        effectId,
        depth: 0,
        evidence: "broken_chain" as const,
        children: [],
      })),
      visited: roots.length,
      trusted: 0,
      refused: roots.length,
      maxDepth,
      residual: `${RESIDUAL}; parentReceiptId link refused: ${parentLinkRefuse}`,
    };
  }

  const issuer = verifyParentReceiptIssuerStamps(snapshot.receipts, { workspace });
  if (issuer.ok === false) {
    return {
      ok: false,
      rootEffectIds: roots,
      nodes: roots.map((effectId) => ({
        effectId,
        depth: 0,
        evidence: "broken_chain" as const,
        children: [],
      })),
      visited: roots.length,
      trusted: 0,
      refused: roots.length,
      maxDepth,
      residual: `${RESIDUAL}; issuer attestation refused: ${issuer.reason}`,
    };
  }

  const byEffect = new Map<string, Receipt>();
  for (const row of snapshot.receipts) {
    if (typeof row.effectId === "string" && row.effectId !== "" && row.schemaVersion === 2) {
      if (!byEffect.has(row.effectId)) byEffect.set(row.effectId, row);
    }
  }

  const state = { visited: 0, trusted: 0, refused: 0 };
  const nodes = walk(workspace, snapshot, roots, 0, maxDepth, new Set(), state, byEffect);
  return {
    ok: state.refused === 0,
    rootEffectIds: roots,
    nodes,
    visited: state.visited,
    trusted: state.trusted,
    refused: state.refused,
    maxDepth,
    anchorAbsent: snapshot.anchorAbsent,
    residual: RESIDUAL,
  };
}

/**
 * Workspace-wide nested replay: every v2 receipt that declares `childEffectIds`
 * contributes those ids as roots. Used by `hzcode session verify` (reduced).
 */
export function replayNestedReceiptsInWorkspace(
  workspace: string,
  opts?: { maxDepth?: number },
): NestedReceiptReplayVerdict {
  const snapshot = readVerifiedReceiptSnapshotSync(workspace);
  if (!snapshot.ok) {
    return {
      ok: false,
      rootEffectIds: [],
      nodes: [],
      visited: 0,
      trusted: 0,
      refused: 1,
      maxDepth: opts?.maxDepth ?? NESTED_RECEIPT_REPLAY_DEFAULT_DEPTH,
      residual: `receipt snapshot refused: ${snapshot.refusal ?? `brokenAt ${snapshot.brokenAt ?? "?"}`}`,
    };
  }
  const roots: string[] = [];
  for (const row of snapshot.receipts) {
    if (row.schemaVersion === 2 && row.childEffectIds?.length) {
      roots.push(...row.childEffectIds);
    }
  }
  return replayNestedChildReceipts(workspace, roots, { ...opts, snapshot });
}

function evidenceLabel(evidence: NestedReplayNodeEvidence): string {
  switch (evidence) {
    case "hash_and_anchor_valid":
      return "hash/head valid";
    case "hash_walk_unanchored":
      return "hash-walk OK (unanchored)";
    case "legacy_unbound_effect_id":
      return "UNBOUND v1 effectId";
    case "duplicate_effect_id":
      return "AMBIGUOUS duplicate effectId";
    case "broken_chain":
      return "INVALID chain";
    case "missing_receipt":
      return "missing receipt";
    case "workspace_unavailable":
      return "workspace absent";
    case "cycle":
      return "CYCLE refused";
    case "depth_exceeded":
      return "depth budget exceeded";
    case "node_budget_exceeded":
      return "node budget exceeded";
  }
}

function formatNode(node: NestedReceiptReplayNode, indent: string, out: string[]): void {
  const bits = [`${indent}· depth ${node.depth} effect ${node.effectId}`];
  if (node.tool) bits.push(`tool ${node.tool}`);
  if (node.receiptId) bits.push(`receipt ${node.receiptId}`);
  if (node.receiptSeq !== undefined) bits.push(`r#${node.receiptSeq}`);
  bits.push(evidenceLabel(node.evidence));
  out.push(bits.join(" · "));
  for (const child of node.children) formatNode(child, `${indent}  `, out);
}

export function formatNestedReceiptReplayLines(verdict: NestedReceiptReplayVerdict): string[] {
  if (verdict.rootEffectIds.length === 0 && verdict.visited === 0 && verdict.refused === 0) {
    return ["nested receipt replay: (no childEffectIds roots)"];
  }
  const lines = [
    `nested receipt replay: ${verdict.ok ? "ok" : "refused"} ` +
      `(visited ${verdict.visited}, trusted ${verdict.trusted}, refused ${verdict.refused}, maxDepth ${verdict.maxDepth})`,
  ];
  if (verdict.anchorAbsent) lines.push("  snapshot: hash-walk OK; anchor absent (legacy/unanchored)");
  for (const node of verdict.nodes) formatNode(node, "  ", lines);
  lines.push(`  residual: ${verdict.residual}`);
  return lines;
}
