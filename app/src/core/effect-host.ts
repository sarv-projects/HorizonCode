/**
 * effect-host.ts — Bun-side EffectHost precursor (allow → execute → observe).
 *
 * Records per tool.execute effect lifecycle steps keyed by `effectId` (UUID).
 * Links receipt seq/id and optional postimageDigest on observe. Does not run
 * effects in Rust; settlement is reconcile-only (`settled` | `unknown`).
 */

import { randomUUID } from "node:crypto";
import { nowIso } from "../contracts";
import type { EffectHostLedger } from "./effect-ledger";

export type EffectPhase = "allow" | "execute" | "observe";
export type EffectReconcileVerdict = "settled" | "unknown";

export interface EffectStep {
  phase: EffectPhase;
  at: string;
  callId?: string;
  tool?: string;
  leaseId?: string;
  ok?: boolean;
  receiptId?: string;
  receiptSeq?: number;
  postimageDigest?: string;
  /** False when independent postimage re-read disagreed (docs/28 **256**). */
  postimageObservationStable?: boolean;
  /** False when receipt resultDigest disagreed with tool output at observe (**257**). */
  resultDigestEvidenceStable?: boolean;
  /** True when mutating tool ok:true but expected postimage file absent (**257**). */
  postimageMissingAtObserve?: boolean;
  /** Resolved workspace path when observe recorded a postimage (R170 gate). */
  resourceKey?: string;
  /** Spawn/subagent child effects linked from this step (R172; additive). */
  childEffectIds?: string[];
}

export interface EffectRecord {
  effectId: string;
  tool: string;
  callId: string;
  steps: EffectStep[];
}

export function createEffectId(): string {
  return randomUUID();
}

export class EffectHost {
  private readonly records = new Map<string, EffectRecord>();

  constructor(private readonly ledger?: EffectHostLedger) {}

  /** Restore durable rows (latest per effectId) without throwing on duplicates. */
  hydrate(records: Iterable<EffectRecord>): void {
    for (const rec of records) {
      if (!this.records.has(rec.effectId)) {
        this.records.set(rec.effectId, {
          effectId: rec.effectId,
          tool: rec.tool,
          callId: rec.callId,
          steps: rec.steps.map((s) => ({ ...s })),
        });
      }
    }
  }

  listEffectIds(): string[] {
    return [...this.records.keys()];
  }

  replaceRecord(record: EffectRecord): void {
    this.records.set(record.effectId, {
      effectId: record.effectId,
      tool: record.tool,
      callId: record.callId,
      steps: record.steps.map((s) => ({ ...s })),
    });
  }

  persistRecord(effectId: string, verdict?: EffectReconcileVerdict): void {
    const rec = this.getRecord(effectId);
    if (rec && this.ledger) this.ledger.appendSnapshot(rec, verdict);
  }

  private snap(effectId: string, verdict?: EffectReconcileVerdict): void {
    this.persistRecord(effectId, verdict);
  }

  begin(effectId: string, tool: string, callId: string): void {
    if (this.records.has(effectId)) {
      throw new Error(`EffectHost: duplicate effectId ${effectId}`);
    }
    this.records.set(effectId, { effectId, tool, callId, steps: [] });
    this.snap(effectId);
  }

  recordAllow(effectId: string, detail?: { leaseId?: string }): void {
    const rec = this.require(effectId);
    rec.steps.push({
      phase: "allow",
      at: nowIso(),
      tool: rec.tool,
      callId: rec.callId,
      leaseId: detail?.leaseId,
    });
    this.snap(effectId);
  }

  recordExecute(
    effectId: string,
    detail?: { ok?: boolean; childEffectIds?: readonly string[]; resourceKey?: string },
  ): void {
    const rec = this.require(effectId);
    rec.steps.push({
      phase: "execute",
      at: nowIso(),
      tool: rec.tool,
      callId: rec.callId,
      ok: detail?.ok,
      resourceKey: detail?.resourceKey,
      ...(detail?.childEffectIds?.length ? { childEffectIds: [...detail.childEffectIds] } : {}),
    });
    this.snap(effectId);
  }

  recordObserve(
    effectId: string,
    detail: {
      receiptId: string;
      receiptSeq: number;
      postimageDigest?: string;
      postimageObservationStable?: boolean;
      resultDigestEvidenceStable?: boolean;
      postimageMissingAtObserve?: boolean;
      resourceKey?: string;
    },
  ): void {
    const rec = this.require(effectId);
    rec.steps.push({
      phase: "observe",
      at: nowIso(),
      tool: rec.tool,
      callId: rec.callId,
      receiptId: detail.receiptId,
      receiptSeq: detail.receiptSeq,
      postimageDigest: detail.postimageDigest,
      postimageObservationStable: detail.postimageObservationStable,
      resultDigestEvidenceStable: detail.resultDigestEvidenceStable,
      postimageMissingAtObserve: detail.postimageMissingAtObserve,
      resourceKey: detail.resourceKey,
    });
    this.snap(effectId);
  }

  /** Settled when allow, execute, and observe (with receipt seq) are all recorded. */
  reconcileEffect(effectId: string): EffectReconcileVerdict {
    const rec = this.records.get(effectId);
    if (!rec) return "unknown";
    const phases = new Set(rec.steps.map((s) => s.phase));
    if (!phases.has("allow") || !phases.has("execute") || !phases.has("observe")) return "unknown";
    const observe = rec.steps.find((s) => s.phase === "observe");
    if (observe?.receiptSeq === undefined || observe.receiptId === undefined) return "unknown";
    if (observe.postimageObservationStable === false) return "unknown";
    if (observe.resultDigestEvidenceStable === false) return "unknown";
    if (observe.postimageMissingAtObserve === true) return "unknown";
    return "settled";
  }

  getRecord(effectId: string): EffectRecord | undefined {
    const rec = this.records.get(effectId);
    if (rec === undefined) return undefined;
    return { ...rec, steps: [...rec.steps] };
  }

  private require(effectId: string): EffectRecord {
    const rec = this.records.get(effectId);
    if (!rec) throw new Error(`EffectHost: unknown effectId ${effectId}`);
    return rec;
  }
}
