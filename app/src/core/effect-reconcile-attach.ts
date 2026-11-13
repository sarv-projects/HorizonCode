/**
 * effect-reconcile-attach.ts — reload open effects on session attach (ruling 224).
 *
 * Observe-only enrichment from the session event log and receipts chain; when a
 * previously-unknown effect becomes settled, callers emit `hz.effect.reconciled`.
 */

import { EventTypes, nowIso } from "../contracts";
import type { EffectHost, EffectRecord, EffectStep } from "./effect-host";
import { loadEffectLedger } from "./effect-ledger";
import { postimagePathForTool } from "./receipt-postimage";
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

function toolCallArgsForRecord(
  events: Record<string, unknown>[],
  record: EffectRecord,
): Record<string, unknown> | undefined {
  for (const ev of events) {
    if (ev.type !== EventTypes.toolCall) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const effectId = asString(payload.effectId);
    if (effectId === record.effectId) {
      const args = payload.args;
      return args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    }
    const callId = asString(payload.callId) ?? asString(payload.id);
    const name = asString(payload.name);
    if (effectId === undefined && callId === record.callId && name === record.tool) {
      const args = payload.args;
      return args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    }
  }
  return undefined;
}

function plannedResourceKey(
  workspace: string,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  return postimagePathForTool(tool, args, workspace);
}

function patchExecuteResourceKey(record: EffectRecord, resourceKey: string): EffectRecord {
  const execIdx = record.steps.findIndex((s) => s.phase === "execute");
  if (execIdx < 0) return record;
  const steps = record.steps.map((s, i) => (i === execIdx ? { ...s, resourceKey } : { ...s }));
  return { ...record, steps };
}

/** Restore planned `resourceKey` on unsettled execute rows (ruling **338**). */
function restoreObservePendingExecuteResourceKey(
  workspace: string,
  record: EffectRecord,
  events: Record<string, unknown>[],
): EffectRecord {
  const phases = new Set(record.steps.map((s) => s.phase));
  if (!phases.has("execute") || phases.has("observe")) return record;
  const execute = record.steps.find((s) => s.phase === "execute");
  if (execute?.resourceKey) return record;
  const args = toolCallArgsForRecord(events, record);
  if (!args) return record;
  const resourceKey = plannedResourceKey(workspace, record.tool, args);
  return resourceKey ? patchExecuteResourceKey(record, resourceKey) : record;
}

/** Merge execute `resourceKey` from latest durable snapshot without inventing observe. */
export function restoreObservePendingFromDurableLedger(host: EffectHost, workspace: string): void {
  const { records } = loadEffectLedger(workspace);
  for (const disk of records) {
    const mem = host.getRecord(disk.effectId);
    if (!mem) continue;
    if (mem.steps.some((s) => s.phase === "observe")) continue;
    const diskExecute = disk.steps.find((s) => s.phase === "execute");
    if (!diskExecute?.resourceKey) continue;
    const execIdx = mem.steps.findIndex((s) => s.phase === "execute");
    if (execIdx < 0) continue;
    if (mem.steps[execIdx]?.resourceKey) continue;
    const steps: EffectStep[] = mem.steps.map((s, i) =>
      i === execIdx ? { ...s, resourceKey: diskExecute.resourceKey } : { ...s },
    );
    host.replaceRecord({ ...mem, steps });
  }
}

function enrichFromSessionEvents(
  workspace: string,
  record: EffectRecord,
  events: Record<string, unknown>[],
): EffectRecord {
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
        const args = toolCallArgsForRecord(events, record);
        const resourceKey = args ? plannedResourceKey(workspace, record.tool, args) : undefined;
        steps.push({
          phase: "execute",
          at: nowIso(),
          tool: record.tool,
          callId: record.callId,
          ok: payload.ok === true,
          ...(resourceKey ? { resourceKey } : {}),
        });
      }
    }
  }

  let next = { ...record, steps };
  return restoreObservePendingExecuteResourceKey(workspace, next, events);
}

/** Session-scoped event scan + receipt fallback for missing observe rows. */
export function enrichEffectFromLogs(workspace: string, sessionId: string, record: EffectRecord): EffectRecord {
  const events = readJsonl(sessionEventsPath(workspace, sessionId));
  let next = restoreObservePendingExecuteResourceKey(workspace, record, events);
  next = enrichFromSessionEvents(workspace, next, events);

  const phases = new Set(next.steps.map((s) => s.phase));
  if (!phases.has("observe")) {
    const receipts = readJsonl(receiptsPath(workspace));
    for (const row of receipts) {
      const callId = asString(row.callId);
      const effectId = asString(row.effectId);
      const tool = asString(row.tool);
      // An explicit effectId is authoritative. Never pair a different effect's
      // receipt by callId alone (call ids can be reused across sessions).
      if (effectId === record.effectId || (effectId === undefined && callId === record.callId && tool === record.tool)) {
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
 * Refresh the shared workspace ledger whenever a session is attached or switched.
 * A second runtime may have persisted effects after this host first hydrated;
 * first-time hydrate alone would hide those effects from the UNKNOWN inspector
 * and resource gate until the process restarts. Never replace newer in-memory
 * evidence with a shorter snapshot or overwrite an identity collision.
 */
export function refreshEffectHostFromDurableLedger(
  workspace: string,
  host: EffectHost,
): ReturnType<typeof loadEffectLedger> {
  const snapshot = loadEffectLedger(workspace);
  for (const disk of snapshot.records) {
    const memory = host.getRecord(disk.effectId);
    if (!memory) {
      host.hydrate([disk]);
      continue;
    }
    if (memory.tool !== disk.tool || memory.callId !== disk.callId) continue;
    // A local unstable observation is never silently replaced by disk evidence.
    const hasUnsafeObserve = memory.steps.some((step) => step.phase === "observe" && (
      step.postimageObservationStable === false ||
      step.resultDigestEvidenceStable === false ||
      step.postimageMissingAtObserve === true
    ));
    if (!hasUnsafeObserve && disk.steps.length > memory.steps.length) host.replaceRecord(disk);
  }
  return snapshot;
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
  const { verdicts: persistedVerdicts } = refreshEffectHostFromDurableLedger(workspace, host);
  restoreObservePendingFromDurableLedger(host, workspace);
  const open = host.listEffectIds();
  const out: EffectAttachReconcile[] = [];

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
