/**
 * effect-cli.ts — `hzcode effect reconcile` (observe-only; ruling **291**).
 *
 * Simulates attach reconcile without persisting; `--probe` adds docs/06 fs/vcs read-only probes.
 */

import type { EffectReconcileVerdict } from "./effect-host";
import { enrichEffectFromLogs } from "./effect-reconcile-attach";
import { loadEffectLedger } from "./effect-ledger";
import {
  formatEffectReconcileProbeSummary,
  probeEffectReconcile,
  sessionReconcileVerdict,
  type EffectReconcileProbeReport,
} from "./effect-reconcile-probe";
import {
  formatEffectEvidenceGateSummary,
  probeEffectEvidence,
  type EffectEvidenceGateReport,
} from "./effect-evidence-gate";
import { formatProbeIoHintLine, formatVcsProbeLine } from "./effect-reconcile-probe-io";

export const EFFECT_RECONCILE_FAIL_EXIT = 3;

export interface EffectObserveReconcileRow {
  effectId: string;
  tool: string;
  /** Durable ledger verdict when present; otherwise in-memory-only. */
  priorVerdict?: EffectReconcileVerdict | "absent";
  sessionVerdict: EffectReconcileVerdict;
  wouldReconcile: boolean;
}

export interface EffectObserveReconcileReport {
  workspace: string;
  sessionId?: string;
  rows: EffectObserveReconcileRow[];
  mismatches: number;
  wouldSettle: number;
  evidence: EffectEvidenceGateReport;
}

function buildObserveOnlyReport(workspace: string, sessionId?: string): EffectObserveReconcileReport {
  const { verdicts, records } = loadEffectLedger(workspace);
  const rows: EffectObserveReconcileRow[] = [];
  let mismatches = 0;
  let wouldSettle = 0;
  for (const base of records) {
    const enriched = sessionId ? enrichEffectFromLogs(workspace, sessionId, base) : base;
    const sessionVerdict = sessionReconcileVerdict(enriched);
    const priorVerdict = verdicts.get(base.effectId);
    const wouldReconcile =
      (priorVerdict === undefined || priorVerdict === "unknown") && sessionVerdict === "settled";
    if (priorVerdict !== undefined && priorVerdict !== sessionVerdict) mismatches += 1;
    if (wouldReconcile) wouldSettle += 1;
    rows.push({
      effectId: base.effectId,
      tool: base.tool,
      priorVerdict: priorVerdict ?? "absent",
      sessionVerdict,
      wouldReconcile,
    });
  }
  rows.sort((a, b) => a.effectId.localeCompare(b.effectId));
  const evidence = probeEffectEvidence(workspace, { sessionId });
  return { workspace, sessionId, rows, mismatches, wouldSettle, evidence };
}

function renderObserveReport(report: EffectObserveReconcileReport): string {
  const lines = [
    "hzcode effect reconcile (observe-only; no ledger writes)",
    `  workspace ${report.workspace}`,
    report.sessionId ? `  session ${report.sessionId}` : "  session (none — ledger-only simulation)",
    `  effects ${report.rows.length}`,
  ];
  for (const row of report.rows.slice(0, 24)) {
    const bits = [
      row.tool,
      row.effectId.slice(0, 13) + "…",
      `prior=${row.priorVerdict === "absent" ? "—" : row.priorVerdict}`,
      `session=${row.sessionVerdict}`,
    ];
    if (row.wouldReconcile) bits.push("would-settle");
    lines.push(`    · ${bits.join(" · ")}`);
  }
  if (report.rows.length > 24) lines.push(`    … +${report.rows.length - 24} more`);
  lines.push(
    `  summary: ${report.mismatches} ledger mismatch(es), ${report.wouldSettle} would settle (no mutations performed)`,
  );
  lines.push(`  ${formatEffectEvidenceGateSummary(report.evidence)}`);
  return lines.join("\n");
}

function renderProbeReport(
  workspace: string,
  sessionId: string | undefined,
  report: EffectReconcileProbeReport,
  evidence: EffectEvidenceGateReport,
): string {
  const lines = [
    "hzcode effect reconcile --probe (read-only; docs/06)",
    `  workspace ${workspace}`,
    report.sessionId ? `  session ${report.sessionId}` : "  session (none)",
    `  ${formatEffectReconcileProbeSummary(report)}`,
    `  ${formatEffectEvidenceGateSummary(evidence)}`,
  ];
  if (evidence.failures.length > 0) {
    lines.push("  evidence failures:");
    for (const f of evidence.failures.slice(0, 12)) {
      lines.push(`    · ${f.kind} · ${f.tool} · ${f.effectId.slice(0, 13)}…`);
    }
  }
  if (report.mismatches.length > 0) {
    lines.push("  mismatches:");
    for (const m of report.mismatches.slice(0, 16)) {
      lines.push(
        `    · ${m.kind} · ${m.tool} · ${m.effectId.slice(0, 13)}… ledger=${m.ledgerVerdict ?? "—"} session=${m.sessionVerdict} kernel=${m.kernelVerdict ?? "—"}`,
      );
    }
    if (report.vcsSnapshot) {
      const vcs = formatVcsProbeLine(report.vcsSnapshot);
      if (vcs) lines.push(`    · ${vcs}`);
    }
    if (report.ioHints) {
      for (const hint of report.ioHints.slice(0, 8)) {
        lines.push(`    · probe ${formatProbeIoHintLine(hint)}`);
      }
    }
  }
  return lines.join("\n");
}

export function renderEffectReconcile(
  workspace: string,
  opts: { sessionId?: string; probe?: boolean } = {},
): string {
  if (opts.probe) {
    const report = probeEffectReconcile(workspace, { sessionId: opts.sessionId });
    const evidence = probeEffectEvidence(workspace, { sessionId: opts.sessionId });
    return renderProbeReport(workspace, opts.sessionId, report, evidence);
  }
  return renderObserveReport(buildObserveOnlyReport(workspace, opts.sessionId));
}

export function effectReconcileExitCode(workspace: string, opts: { sessionId?: string; probe?: boolean } = {}): number {
  const evidence = probeEffectEvidence(workspace, { sessionId: opts.sessionId });
  if (opts.probe) {
    const report = probeEffectReconcile(workspace, { sessionId: opts.sessionId });
    const openUnknown = report.rows.filter(
      (r) => r.sessionVerdict === "unknown" || r.ledgerVerdict === "unknown",
    ).length;
    const ok =
      report.mismatches.length === 0 && evidence.failures.length === 0 && openUnknown === 0;
    return ok ? 0 : EFFECT_RECONCILE_FAIL_EXIT;
  }
  const report = buildObserveOnlyReport(workspace, opts.sessionId);
  const ok = report.mismatches === 0 && evidence.failures.length === 0;
  return ok ? 0 : EFFECT_RECONCILE_FAIL_EXIT;
}
