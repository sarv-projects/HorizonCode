/**
 * effect-reconcile-attach.ts — reload open effects on session attach (ruling 224).
 *
 * Observe-only enrichment from the session event log and receipts chain; when a
 * previously-unknown effect becomes settled, callers emit `hz.effect.reconciled`.
 */

import { EventTypes, nowIso } from "../contracts";
import type { EffectHost, EffectRecord } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { receiptsPath, sessionEventsPath } from "./session-kernel-reconcile";
import { existsSync, readFileSync } from "node:fs";

export interface EffectAttachReconcile {
  effectId: string;
  tool: string;
  callId: string;
  priorVerdict: "open" | "unknown" | "settled";
  verdict: "settled" | "unknown";
  /** true when prior was open/unknown and verdict is now settled */
  reconciled: boolean;
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return rows;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function enrichFromSessionEvents(record: EffectRecord, events: Record<string, unknown>[]): EffectRecord {
  const steps = [...record.steps];
  const has = (phase: string) => steps.some((s) => s.phase === phase);

  for (const ev of events) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const effectId = asString(payload.effectId);
    if (effectId !== record.effectId) continue;
    const type = ev.type;
    if (type === EventTypes.receiptIssued) {
      if (!has("observe")) {
        const postimageObservationStable =
          payload.postimageObservationUnstable === true ? false : undefined;
        const resultDigestEvidenceStable =
          payload.resultDigestEvidenceUnstable === true ? false : undefined;
        steps.push({
          phase: "observe",
          at: nowIso(),
          tool: record.tool,
          callId: record.callId,
          receiptId: asString(payload.receiptId),
          receiptSeq: typeof payload.seq === "number" ? payload.seq : undefined,
          postimageDigest: asString(payload.postimageDigest),
          postimageObservationStable,
          resultDigestEvidenceStable,
          postimageMissingAtObserve: payload.postimageMissingAtObserve === true,
          resourceKey: asString(payload.postimagePath),
        });
      }
    } else if (type === EventTypes.toolResult) {
      if (!has("execute")) {
        steps.push({
          phase: "execute",
          at: nowIso(),
          tool: record.tool,
          callId: record.callId,
          ok: payload.ok === true,
        });
      }
    }
  }

  return { ...record, steps };
}

/** Session-scoped event scan + receipt fallback for missing observe rows. */
export function enrichEffectFromLogs(workspace: string, sessionId: string, record: EffectRecord): EffectRecord {
  const events = readJsonl(sessionEventsPath(workspace, sessionId));
  let next = enrichFromSessionEvents(record, events);

  const phases = new Set(next.steps.map((s) => s.phase));
  if (!phases.has("observe")) {
    const receipts = readJsonl(receiptsPath(workspace));
    for (const row of receipts) {
      const callId = asString(row.callId);
      const effectId = asString(row.effectId);
      const tool = asString(row.tool);
      if (effectId === record.effectId || (callId === record.callId && tool === record.tool)) {
        const executeOk = next.steps.find((s) => s.phase === "execute")?.ok === true;
        const postimagePath = asString(row.postimagePath);
        const postimageMissingAtObserve =
          executeOk === true && postimagePath !== undefined && !existsSync(postimagePath);
        const observeStep = {
          phase: "observe" as const,
          at: nowIso(),
          tool: record.tool,
          callId: record.callId,
          receiptId: asString(row.id),
          receiptSeq: typeof row.seq === "number" ? row.seq : undefined,
          postimageDigest: asString(row.postimageDigest),
          postimageMissingAtObserve,
          resourceKey: postimagePath,
        };
        next = {
          ...next,
          steps: [...next.steps, observeStep],
        };
        break;
      }
    }
  }
  return next;
}

/**
 * Reload durable ledger into `host`, enrich open effects from logs, reconcile.
 * Returns rows where UNKNOWN/open effects newly settled (emit hz.effect.reconciled).
 */
export function reconcileEffectsOnAttach(
  workspace: string,
  sessionId: string,
  host: EffectHost,
): EffectAttachReconcile[] {
  const open = host.listEffectIds();
  const out: EffectAttachReconcile[] = [];
  const { verdicts: persistedVerdicts } = loadEffectLedger(workspace);

  for (const effectId of open) {
    const before = host.getRecord(effectId);
    if (!before) continue;
    const persisted = persistedVerdicts.get(effectId);
    const prior: EffectAttachReconcile["priorVerdict"] =
      persisted === "settled" ? "settled" : persisted === "unknown" ? "unknown" : "open";
    if (prior === "settled" && host.reconcileEffect(effectId) === "settled") continue;

    const enriched = enrichEffectFromLogs(workspace, sessionId, before);
    host.replaceRecord(enriched);

    const verdict = host.reconcileEffect(effectId);
    const reconciled = (prior === "open" || prior === "unknown") && verdict === "settled";
    host.persistRecord(effectId, verdict);

    if (prior !== verdict || reconciled) {
      out.push({
        effectId,
        tool: before.tool,
        callId: before.callId,
        priorVerdict: prior,
        verdict,
        reconciled,
      });
    }
  }
  return out;
}
