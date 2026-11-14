/**
 * receipt-child-list.ts — child effect / receipt linkage for R172 (ruling **294** reduced).
 */

import type { Receipt } from "../contracts";
import type { EffectRecord, EffectStep } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { readVerifiedReceiptSnapshotSync } from "./receipt-chain-verify";

export type ChildReceiptChainEvidence =
  | "hash_and_anchor_valid"
  | "hash_walk_unanchored"
  | "legacy_unbound_effect_id"
  | "broken_chain"
  | "duplicate_effect_id"
  | "missing_receipt"
  | "workspace_unavailable";

export interface ChildReceiptLink {
  childEffectId: string;
  /** A link is never attributed to a child when the chain is broken or the
   * effect ID is ambiguous. Hash+head integrity is not signer authenticity. */
  chainEvidence: ChildReceiptChainEvidence;
  receiptId?: string;
  receiptSeq?: number;
  tool?: string;
  parentTool?: string;
}

function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.trim() !== ""))];
}

export function childEffectIdsFromSteps(steps: readonly EffectStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.childEffectIds?.length) out.push(...step.childEffectIds);
  }
  return uniqueIds(out);
}

export function childEffectIdsFromRecord(record?: EffectRecord): string[] {
  if (!record) return [];
  return childEffectIdsFromSteps(record.steps);
}

export function childEffectIdsFromReceipt(receipt?: Receipt & { childEffectIds?: string[] }): string[] {
  if (!receipt?.childEffectIds?.length) return [];
  return uniqueIds(receipt.childEffectIds);
}

export function mergedChildEffectIds(
  record?: EffectRecord,
  receipt?: Receipt & { childEffectIds?: string[] },
): string[] {
  return uniqueIds([...childEffectIdsFromRecord(record), ...childEffectIdsFromReceipt(receipt)]);
}

function indexVerifiedReceipts(receipts: readonly Receipt[]): { byEffect: Map<string, Receipt>; duplicates: Set<string> } {
  const byEffect = new Map<string, Receipt>();
  const duplicates = new Set<string>();
  for (const row of receipts) {
    if (typeof row.effectId === "string" && row.effectId !== "") {
      if (byEffect.has(row.effectId)) duplicates.add(row.effectId);
      else byEffect.set(row.effectId, row);
    }
  }
  return { byEffect, duplicates };
}

/** Resolve child effect ids to receipt rows when present in the workspace chain. */
export function resolveChildReceiptLinks(
  workspace: string | undefined,
  childEffectIds: readonly string[],
  parentTool?: string,
): ChildReceiptLink[] {
  const ids = uniqueIds(childEffectIds);
  if (ids.length === 0) return [];
  if (!workspace) {
    return ids.map((childEffectId) => ({
      childEffectId, parentTool, chainEvidence: "workspace_unavailable" as const,
    }));
  }
  // Validate AND index precisely one immutable JSONL snapshot. Never
  // verify one version of a receipt file then attribute a child by parsing a
  // separately read, potentially forged later version.
  const snapshot = readVerifiedReceiptSnapshotSync(workspace);
  if (!snapshot.ok) {
    return ids.map((childEffectId) => ({
      childEffectId, parentTool, chainEvidence: "broken_chain" as const,
    }));
  }
  const { byEffect, duplicates } = indexVerifiedReceipts(snapshot.receipts);
  const { records } = loadEffectLedger(workspace);
  const toolByEffect = new Map(records.map((r) => [r.effectId, r.tool]));
  return ids.map((childEffectId) => {
    const receipt = byEffect.get(childEffectId);
    const chainEvidence: ChildReceiptChainEvidence =
      duplicates.has(childEffectId) ? "duplicate_effect_id"
      : !receipt ? "missing_receipt"
      : receipt.schemaVersion !== 2 ? "legacy_unbound_effect_id"
      : snapshot.anchorAbsent ? "hash_walk_unanchored"
      : "hash_and_anchor_valid";
    const trusted = chainEvidence === "hash_walk_unanchored" ||
      chainEvidence === "hash_and_anchor_valid";
    return {
      childEffectId,
      chainEvidence,
      receiptId: trusted ? receipt?.id : undefined,
      receiptSeq: trusted ? receipt?.seq : undefined,
      tool: (trusted ? receipt?.tool : undefined) ?? toolByEffect.get(childEffectId),
      parentTool,
    };
  });
}
