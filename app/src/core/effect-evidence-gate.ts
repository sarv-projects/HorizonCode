/**
 * effect-evidence-gate.ts — read-only observe evidence scan (docs/28 **295** / **257**).
 *
 * Surfaces `resultDigest` instability, missing postimage, and postimage
 * observation instability from effect steps and session `receipt.issued` events.
 */

import { EventTypes, type Receipt } from "../contracts";
import type { EffectHost, EffectRecord, EffectStep } from "./effect-host";
import { enrichEffectFromLogs } from "./effect-reconcile-attach";
import { loadEffectLedger } from "./effect-ledger";
import { sessionEventsPath, receiptsPath } from "./session-kernel-reconcile";
import { existsSync, readFileSync } from "node:fs";
import { postimageReplayActive, probePostimageReplay } from "./effect-postimage-replay";

export type EffectEvidenceFailureKind =
  | "result_digest_unstable"
  | "postimage_missing"
  | "postimage_observation_unstable"
  | "postimage_replay_mismatch"
  | "postimage_replay_missing";

export interface EffectEvidenceFailure {
  effectId: string;
  tool: string;
  kind: EffectEvidenceFailureKind;
  receiptId?: string;
  callId?: string;
  /** Durable ledger verdict when known. */
  ledgerVerdict?: "settled" | "unknown";
}

export interface EffectEvidenceGateReport {
  workspace: string;
  sessionId?: string;
  effectsScanned: number;
  failures: EffectEvidenceFailure[];
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

function failuresFromObserveStep(
  record: EffectRecord,
  step: EffectStep,
): EffectEvidenceFailure[] {
  const base = {
    effectId: record.effectId,
    tool: record.tool,
    callId: record.callId,
    receiptId: step.receiptId,
  };
  const out: EffectEvidenceFailure[] = [];
  if (step.resultDigestEvidenceStable === false) {
    out.push({ ...base, kind: "result_digest_unstable" });
  }
  if (step.postimageMissingAtObserve === true) {
    out.push({ ...base, kind: "postimage_missing" });
  }
  if (step.postimageObservationStable === false) {
    out.push({ ...base, kind: "postimage_observation_unstable" });
  }
  return out;
}

function failuresFromRecord(record: EffectRecord): EffectEvidenceFailure[] {
  const out: EffectEvidenceFailure[] = [];
  for (const step of record.steps) {
    if (step.phase !== "observe") continue;
    out.push(...failuresFromObserveStep(record, step));
  }
  return out;
}

function failureKey(f: EffectEvidenceFailure): string {
  return `${f.effectId}\0${f.kind}\0${f.receiptId ?? ""}`;
}

function failuresFromSessionReceiptEvents(
  events: readonly Record<string, unknown>[],
  toolByEffect: ReadonlyMap<string, string>,
): EffectEvidenceFailure[] {
  const out: EffectEvidenceFailure[] = [];
  for (const ev of events) {
    if (ev.type !== EventTypes.receiptIssued) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const effectId = asString(payload.effectId);
    if (!effectId) continue;
    const tool = asString(payload.tool) ?? toolByEffect.get(effectId) ?? "unknown";
    const base = {
      effectId,
      tool,
      callId: asString(payload.callId),
      receiptId: asString(payload.receiptId),
    };
    if (payload.resultDigestEvidenceUnstable === true) {
      out.push({ ...base, kind: "result_digest_unstable" });
    }
    if (payload.postimageMissingAtObserve === true) {
      out.push({ ...base, kind: "postimage_missing" });
    }
    if (payload.postimageObservationUnstable === true) {
      out.push({ ...base, kind: "postimage_observation_unstable" });
    }
  }
  return out;
}

function toolByEffectFromReceipts(workspace: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of readJsonl(receiptsPath(workspace))) {
    const effectId = asString(row.effectId);
    const tool = asString(row.tool);
    if (effectId && tool) out.set(effectId, tool);
  }
  return out;
}

export function formatEffectEvidenceGateSummary(report: EffectEvidenceGateReport): string {
  if (report.failures.length === 0) {
    const scope = report.sessionId ? `session ${report.sessionId}` : "workspace";
    return `evidence gate: ${report.effectsScanned} effect(s) in ${scope}; no observe evidence failures`;
  }
  const bits = report.failures.slice(0, 4).map((f) => `${f.tool} ${f.effectId.slice(0, 8)}… ${f.kind}`);
  const more = report.failures.length > 4 ? ` (+${report.failures.length - 4} more)` : "";
  return `evidence gate: ${report.failures.length} failure(s) — ${bits.join("; ")}${more}`;
}

/**
 * Read-only scan of durable ledger rows (+ optional in-memory host) for observe
 * evidence failures; session events add receipt.issued flags when `sessionId` set.
 */
export function probeEffectEvidence(
  workspace: string,
  opts?: { sessionId?: string; effectHost?: Pick<EffectHost, "getRecord" | "listEffectIds"> },
): EffectEvidenceGateReport {
  const { verdicts, records } = loadEffectLedger(workspace);
  const host = opts?.effectHost;
  const ids = new Set<string>();
  for (const r of records) ids.add(r.effectId);
  if (host) for (const id of host.listEffectIds()) ids.add(id);

  const sessionId = opts?.sessionId;
  const toolByEffect = toolByEffectFromReceipts(workspace);
  const merged = new Map<string, EffectEvidenceFailure>();

  for (const effectId of [...ids].sort((a, b) => a.localeCompare(b))) {
    const fromLedger = records.find((r) => r.effectId === effectId);
    const fromHost = host?.getRecord(effectId);
    let base = fromHost ?? fromLedger;
    if (!base) continue;
    if (sessionId) {
      base = enrichEffectFromLogs(workspace, sessionId, {
        ...base,
        steps: base.steps.map((s) => ({ ...s })),
      });
    }
    toolByEffect.set(base.effectId, base.tool);
    for (const f of failuresFromRecord(base)) {
      merged.set(failureKey(f), {
        ...f,
        ledgerVerdict: verdicts.get(effectId),
      });
    }
  }

  if (sessionId) {
    const events = readJsonl(sessionEventsPath(workspace, sessionId));
    for (const f of failuresFromSessionReceiptEvents(events, toolByEffect)) {
      merged.set(failureKey(f), {
        ...f,
        ledgerVerdict: verdicts.get(f.effectId),
      });
    }
  }

  if (postimageReplayActive()) {
    const replay = probePostimageReplay(workspace);
    for (const r of replay.failures) {
      const effectId = r.effectId ?? `receipt:${r.receiptId ?? "?"}`;
      const kind = r.replayDigest === undefined ? "postimage_replay_missing" : "postimage_replay_mismatch";
      merged.set(`${effectId}\0${kind}\0${r.receiptId ?? ""}`, {
        effectId,
        tool: r.tool,
        kind,
        receiptId: r.receiptId,
      });
    }
  }

  const failures = [...merged.values()].sort((a, b) =>
    a.effectId.localeCompare(b.effectId) || a.kind.localeCompare(b.kind),
  );
  return {
    workspace,
    sessionId,
    effectsScanned: ids.size,
    failures,
  };
}

/** When receipt sidecar lists child effects, surface as informational rows (R172). */
export function childEffectIdsFromReceiptRow(row: Receipt): string[] {
  const raw = (row as Receipt & { childEffectIds?: string[] }).childEffectIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id !== "");
}
