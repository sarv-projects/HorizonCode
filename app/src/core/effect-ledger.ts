/**
 * effect-ledger.ts — durable EffectHost snapshots (docs/28 ruling 224).
 *
 * Appends full effect records to `<kernelState>/effects.jsonl` via jsonl-append.
 * Latest row per effectId wins on load.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { EffectPhase, EffectReconcileVerdict, EffectRecord, EffectStep } from "./effect-host";
import { appendJsonlSync } from "./jsonl-append";
import { kernelStateDir } from "./paths";

export const EFFECTS_LEDGER_FILE = "effects.jsonl";

export interface EffectLedgerLine {
  v: 1;
  effectId: string;
  tool: string;
  callId: string;
  phases: EffectPhase[];
  steps: EffectStep[];
  receiptId?: string;
  receiptSeq?: number;
  postimageDigest?: string;
  verdict?: EffectReconcileVerdict;
  at: string;
}

export function effectsLedgerPath(workspace: string): string {
  return path.join(kernelStateDir(workspace), EFFECTS_LEDGER_FILE);
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* torn line — skip */
    }
  }
  return rows;
}

function lineToRecord(line: EffectLedgerLine): EffectRecord {
  return {
    effectId: line.effectId,
    tool: line.tool,
    callId: line.callId,
    steps: [...line.steps],
  };
}

function observeFromSteps(steps: EffectStep[]): Pick<EffectLedgerLine, "receiptId" | "receiptSeq" | "postimageDigest"> {
  const observe = steps.find((s) => s.phase === "observe");
  return {
    receiptId: observe?.receiptId,
    receiptSeq: observe?.receiptSeq,
    postimageDigest: observe?.postimageDigest,
  };
}

export function recordToLedgerLine(record: EffectRecord, at: string, verdict?: EffectReconcileVerdict): EffectLedgerLine {
  const phases = [...new Set(record.steps.map((s) => s.phase))];
  return {
    v: 1,
    effectId: record.effectId,
    tool: record.tool,
    callId: record.callId,
    phases,
    steps: record.steps.map((s) => ({ ...s })),
    ...observeFromSteps(record.steps),
    ...(verdict !== undefined ? { verdict } : {}),
    at,
  };
}

/** Latest snapshot per effectId from the durable ledger. */
export function loadEffectLedger(workspace: string): {
  records: EffectRecord[];
  verdicts: Map<string, EffectReconcileVerdict | undefined>;
} {
  const file = effectsLedgerPath(workspace);
  const raw = readJsonl(file);
  const byId = new Map<string, { record: EffectRecord; verdict?: EffectReconcileVerdict }>();
  for (const row of raw) {
    if (row.v !== 1 || typeof row.effectId !== "string") continue;
    const line = row as unknown as EffectLedgerLine;
    if (!Array.isArray(line.steps)) continue;
    byId.set(line.effectId, {
      record: lineToRecord(line),
      verdict: line.verdict === "settled" || line.verdict === "unknown" ? line.verdict : undefined,
    });
  }
  const records: EffectRecord[] = [];
  const verdicts = new Map<string, EffectReconcileVerdict | undefined>();
  for (const [id, entry] of byId) {
    records.push(entry.record);
    verdicts.set(id, entry.verdict);
  }
  return { records, verdicts };
}

export interface EffectHostLedger {
  appendSnapshot(record: EffectRecord, verdict?: EffectReconcileVerdict): void;
}

export class WorkspaceEffectLedger implements EffectHostLedger {
  constructor(private readonly workspace: string) {}

  appendSnapshot(record: EffectRecord, verdict?: EffectReconcileVerdict): void {
    const file = effectsLedgerPath(this.workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    const line = recordToLedgerLine(record, new Date().toISOString(), verdict);
    appendJsonlSync(file, `${JSON.stringify(line)}\n`);
  }
}

export function lastPersistedVerdict(workspace: string, effectId: string): EffectReconcileVerdict | undefined {
  const { verdicts } = loadEffectLedger(workspace);
  return verdicts.get(effectId);
}
