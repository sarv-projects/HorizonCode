/**
 * unknown-receipt-lookup.ts — read-only receipt chain lookup for UNKNOWN inspector (ruling 282).
 */

import type { Receipt } from "../contracts";
import { existsSync, readFileSync } from "node:fs";
import { receiptsPath } from "./session-kernel-reconcile";

function readReceiptRows(workspace: string): Receipt[] {
  const file = receiptsPath(workspace);
  if (!existsSync(file)) return [];
  const out: Receipt[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Receipt;
      if (typeof row.id === "string" && typeof row.seq === "number") out.push(row);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

/** Match receipt id, effectId, or callId (prefix ok for long uuids). */
export function findReceiptForUnknownTarget(workspace: string, target: string): Receipt | undefined {
  const needle = target.trim().toLowerCase();
  if (needle === "") return undefined;
  const rows = readReceiptRows(workspace);
  for (const row of rows) {
    if (row.id.toLowerCase() === needle || row.id.toLowerCase().startsWith(needle)) return row;
  }
  for (const row of rows) {
    const effectId = row.effectId?.toLowerCase();
    if (effectId !== undefined && (effectId === needle || effectId.startsWith(needle))) return row;
  }
  return undefined;
}

