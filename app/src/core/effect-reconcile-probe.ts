/**
 * effect-reconcile-probe.ts — read-only session ledger vs kernel reconcile probe (docs/06; ruling **286**).
 *
 * Compares durable `effects.jsonl` verdicts and in-session reconcile simulation against
 * the kernel `effect.reconcile` mirror. Does not persist, emit events, or call attach reconcile.
 */

import type { KernelRequestMap } from "../contracts";
import type { EffectRecord, EffectReconcileVerdict } from "./effect-host";
export type { EffectReconcileProbeIoHint, VcsProbeSnapshot } from "./effect-reconcile-probe-io";
export type { TerminalProbeSnapshot } from "./effect-reconcile-probe-terminal";
export {
  formatProbeIoHintLine,
  formatVcsProbeLine,
  probeGitStatusPorcelain,
  probeResourcePath,
} from "./effect-reconcile-probe-io";
export {
  formatTerminalProbeLine,
  formatTerminalProbeSummary,
  isReadOnlyProbeArgv,
  probeWorkspaceTerminalReadOnly,
  refuseReadOnlyProbeArgv,
} from "./effect-reconcile-probe-terminal";
import { EffectHost } from "./effect-host";
import { enrichEffectFromLogs } from "./effect-reconcile-attach";
import { effectReconcileParamsFromRecord } from "./effect-kernel-reconcile";
import { loadEffectLedger } from "./effect-ledger";
import {
  enrichProbeMismatchesWithIo,
  probeGitStatusPorcelain,
  type EffectReconcileProbeIoHint,
  type VcsProbeSnapshot,
} from "./effect-reconcile-probe-io";
import {
  formatTerminalProbeSummary,
  probeWorkspaceTerminalReadOnly,
  type TerminalProbeSnapshot,
} from "./effect-reconcile-probe-terminal";

export type EffectReconcileMismatchKind = "ledger_vs_session" | "session_vs_kernel";

export interface EffectReconcileProbeRow {
  effectId: string;
  tool: string;
  callId: string;
  ledgerVerdict?: EffectReconcileVerdict;
  sessionVerdict: EffectReconcileVerdict;
  kernelVerdict?: EffectReconcileVerdict;
}

export interface EffectReconcileMismatch {
  effectId: string;
  tool: string;
  kind: EffectReconcileMismatchKind;
  ledgerVerdict?: EffectReconcileVerdict;
  sessionVerdict: EffectReconcileVerdict;
  kernelVerdict?: EffectReconcileVerdict;
}

export interface EffectReconcileProbeReport {
  workspace: string;
  sessionId?: string;
  effectsScanned: number;
  rows: EffectReconcileProbeRow[];
  mismatches: EffectReconcileMismatch[];
  /** Read-only filesystem probes for mismatch rows with `resourceKey` (docs/06). */
  ioHints?: readonly EffectReconcileProbeIoHint[];
  /** Read-only `git status --porcelain` when mismatches present and git available. */
  vcsSnapshot?: VcsProbeSnapshot;
  /** Allow-listed argv-only workspace terminal probes (docs/06; not shell-net enforcement). */
  terminalSnapshot?: TerminalProbeSnapshot;
}

/** Local-kernel parity for `effect.reconcile` (no I/O). */
export function kernelReconcileVerdictFromParams(
  params: KernelRequestMap["effect.reconcile"]["params"],
): EffectReconcileVerdict {
  const phases = Array.isArray(params.phases) ? params.phases : [];
  const hasAllow = phases.includes("allow");
  const hasExecute = phases.includes("execute");
  const hasObserve = phases.includes("observe");
  if (!hasAllow || !hasExecute || !hasObserve) return "unknown";
  const receiptId = typeof params.receiptId === "string" ? params.receiptId : "";
  const receiptSeq = params.receiptSeq;
  if (!receiptId || receiptSeq === undefined) return "unknown";
  if (
    params.resultDigestStable === false ||
    params.postimageMissing === true ||
    params.postimageObservationStable === false
  ) {
    return "unknown";
  }
  return "settled";
}

export function sessionReconcileVerdict(record: EffectRecord): EffectReconcileVerdict {
  const host = new EffectHost();
  host.replaceRecord(record);
  return host.reconcileEffect(record.effectId);
}

export function kernelReconcileVerdictForRecord(record: EffectRecord): EffectReconcileVerdict | undefined {
  const params = effectReconcileParamsFromRecord(record);
  if (!params) return undefined;
  return kernelReconcileVerdictFromParams(params);
}

function collectMismatches(rows: readonly EffectReconcileProbeRow[]): EffectReconcileMismatch[] {
  const out: EffectReconcileMismatch[] = [];
  for (const row of rows) {
    if (row.ledgerVerdict !== undefined && row.ledgerVerdict !== row.sessionVerdict) {
      out.push({
        effectId: row.effectId,
        tool: row.tool,
        kind: "ledger_vs_session",
        ledgerVerdict: row.ledgerVerdict,
        sessionVerdict: row.sessionVerdict,
        kernelVerdict: row.kernelVerdict,
      });
    }
    if (row.kernelVerdict !== undefined && row.kernelVerdict !== row.sessionVerdict) {
      out.push({
        effectId: row.effectId,
        tool: row.tool,
        kind: "session_vs_kernel",
        ledgerVerdict: row.ledgerVerdict,
        sessionVerdict: row.sessionVerdict,
        kernelVerdict: row.kernelVerdict,
      });
    }
  }
  return out;
}

/**
 * Read-only probe: session effect ledger rows vs kernel reconcile list (per-effect verdict).
 * When `sessionId` is set, observe-only log enrichment is simulated before reconcile (no writes).
 */
export function probeEffectReconcile(
  workspace: string,
  opts?: { sessionId?: string; effectHost?: Pick<EffectHost, "getRecord" | "listEffectIds"> },
): EffectReconcileProbeReport {
  const { verdicts, records } = loadEffectLedger(workspace);
  const host = opts?.effectHost;
  const ids = new Set<string>();
  for (const r of records) ids.add(r.effectId);
  if (host) for (const id of host.listEffectIds()) ids.add(id);

  const rows: EffectReconcileProbeRow[] = [];
  const sessionId = opts?.sessionId;

  const recordById = new Map<string, EffectRecord>();
  for (const effectId of [...ids].sort((a, b) => a.localeCompare(b))) {
    const fromLedger = records.find((r) => r.effectId === effectId);
    const fromHost = host?.getRecord(effectId);
    const base = fromHost ?? fromLedger;
    if (!base) continue;
    recordById.set(effectId, base);
    let enriched = base;
    if (sessionId) {
      enriched = enrichEffectFromLogs(workspace, sessionId, {
        ...base,
        steps: base.steps.map((s) => ({ ...s })),
      });
    }
    const sessionVerdict = sessionReconcileVerdict(enriched);
    const kernelVerdict = kernelReconcileVerdictForRecord(enriched);
    rows.push({
      effectId,
      tool: base.tool,
      callId: base.callId,
      ledgerVerdict: verdicts.get(effectId),
      sessionVerdict,
      kernelVerdict,
    });
  }

  const mismatches = collectMismatches(rows);
  let ioHints: EffectReconcileProbeIoHint[] | undefined;
  let vcsSnapshot: VcsProbeSnapshot | undefined;
  let terminalSnapshot: TerminalProbeSnapshot | undefined;
  if (mismatches.length > 0) {
    ioHints = enrichProbeMismatchesWithIo(mismatches, (id) => {
      const row = rows.find((r) => r.effectId === id);
      if (!row) return undefined;
      const fromHost = host?.getRecord(id);
      const fromLedger = records.find((r) => r.effectId === id);
      return recordById.get(id) ?? fromHost ?? fromLedger;
    });
    if (ioHints.length === 0) ioHints = undefined;
    vcsSnapshot = probeGitStatusPorcelain(workspace);
    terminalSnapshot = probeWorkspaceTerminalReadOnly(workspace);
  }

  return {
    workspace,
    sessionId,
    effectsScanned: rows.length,
    rows,
    mismatches,
    ioHints,
    vcsSnapshot,
    terminalSnapshot,
  };
}

export function formatEffectReconcileProbeSummary(report: EffectReconcileProbeReport): string {
  if (report.effectsScanned === 0) {
    return "effect reconcile probe: no effects in durable ledger";
  }
  if (report.mismatches.length === 0) {
    const scope = report.sessionId ? `session ${report.sessionId}` : "workspace ledger";
    return `effect reconcile probe: ${report.effectsScanned} effect(s) in ${scope}; ledger, session, and kernel agree (read-only; no probe I/O needed)`;
  }
  const bits = report.mismatches.slice(0, 4).map((m) => {
    if (m.kind === "ledger_vs_session") {
      return `${m.tool} ${m.effectId.slice(0, 8)}… ledger=${m.ledgerVerdict} session=${m.sessionVerdict}`;
    }
    return `${m.tool} ${m.effectId.slice(0, 8)}… session=${m.sessionVerdict} kernel=${m.kernelVerdict}`;
  });
  const more = report.mismatches.length > 4 ? ` (+${report.mismatches.length - 4} more)` : "";
  const io =
    report.ioHints && report.ioHints.length > 0
      ? `; read-only fs probe on ${report.ioHints.length} resource(s)`
      : "";
  const term = report.terminalSnapshot
    ? `; ${formatTerminalProbeSummary(report.terminalSnapshot)}`
    : "";
  return `effect reconcile probe: ${report.mismatches.length} mismatch(es) — ${bits.join("; ")}${more}${io}${term}`;
}
