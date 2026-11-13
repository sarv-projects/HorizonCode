/**
 * receipt-child-list.ts — child effect / receipt linkage for R172 (ruling **294** reduced).
 */

import { existsSync, readFileSync } from "node:fs";
import type { Receipt } from "../contracts";
import type { EffectRecord, EffectStep } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { receiptsPath } from "./session-kernel-reconcile";

export interface ChildReceiptLink {
  childEffectId: string;
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

function readReceiptIndex(workspace: string): Map<string, Receipt> {
  const byEffect = new Map<string, Receipt>();
  const file = receiptsPath(workspace);
  if (!existsSync(file)) return byEffect;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Receipt;
      if (typeof row.effectId === "string" && row.effectId !== "") {
        byEffect.set(row.effectId, row);
      }
    } catch {
      /* skip */
    }
  }
  return byEffect;
}

/** Resolve child effect ids to receipt rows when present in the workspace chain. */
export function resolveChildReceiptLinks(
  workspace: string | undefined,
  childEffectIds: readonly string[],
  parentTool?: string,
): ChildReceiptLink[] {
  if (childEffectIds.length === 0) return [];
  if (!workspace) {
    return childEffectIds.map((childEffectId) => ({ childEffectId, parentTool }));
  }
  const receiptByEffect = readReceiptIndex(workspace);
  const { records } = loadEffectLedger(workspace);
  const toolByEffect = new Map(records.map((r) => [r.effectId, r.tool]));
  return childEffectIds.map((childEffectId) => {
    const receipt = receiptByEffect.get(childEffectId);
    return {
      childEffectId,
      receiptId: receipt?.id,
      receiptSeq: receipt?.seq,
      tool: receipt?.tool ?? toolByEffect.get(childEffectId),
      parentTool,
    };
  });
}
