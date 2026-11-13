/**
 * unknown-evidence.ts — reduced R169 export evidence bundle (observe-only JSON, ruling 282).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Receipt } from "../contracts";
import type { UnknownEffectRow } from "./effect-unknown-list";
import type { EffectRecord } from "./effect-host";
import { findReceiptForUnknownTarget } from "./unknown-receipt-lookup";
import { stateRoot } from "./paths";
import { maskSecrets } from "./compaction";

export interface UnknownEvidenceBundleV1 {
  version: 1;
  sessionId: string;
  exportedAt: string;
  effects: Array<{
    effectId: string;
    tool: string;
    callId: string;
    receiptId?: string;
    record?: EffectRecord;
    receipt?: Receipt;
  }>;
}

export function buildUnknownEvidenceBundle(opts: {
  workspace: string;
  sessionId: string;
  rows: readonly UnknownEffectRow[];
  getRecord: (effectId: string) => EffectRecord | undefined;
  exportedAt?: string;
}): UnknownEvidenceBundleV1 {
  const exportedAt = opts.exportedAt ?? new Date().toISOString();
  const effects = opts.rows.map((row) => {
    const record = opts.getRecord(row.effectId);
    const receipt =
      findReceiptForUnknownTarget(opts.workspace, row.receiptId ?? row.effectId) ??
      (row.receiptId ? findReceiptForUnknownTarget(opts.workspace, row.receiptId) : undefined);
    return {
      effectId: row.effectId,
      tool: row.tool,
      callId: row.callId,
      receiptId: row.receiptId,
      ...(record ? { record } : {}),
      ...(receipt ? { receipt } : {}),
    };
  });
  return { version: 1, sessionId: opts.sessionId, exportedAt, effects };
}

export function defaultUnknownEvidencePath(workspace: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(stateRoot(workspace), "exports", `unknown-evidence-${safe}-${stamp}.json`);
}

export function writeUnknownEvidenceBundle(
  workspace: string,
  bundle: UnknownEvidenceBundleV1,
  outPath?: string,
): string {
  const target = outPath ?? defaultUnknownEvidencePath(workspace, bundle.sessionId);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, maskSecrets(JSON.stringify(bundle, null, 2) + "\n"), { mode: 0o600 });
  return target;
}
