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
import { metricContract } from "./metrics";

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

/** H-7: contract observe-only reconcile summary counts (ruling 556); human lines unchanged. */
export function effectReconcileObservePublication(report: EffectObserveReconcileReport): string[] {
  const anchor =
    "none — first effect reconcile observe (no prior observe report of this workspace to compare against)";
  const population = `observe-only effect reconcile over workspace ${report.workspace}`;
  const excludes =
    "probe mode is separate; no ledger writes; evidence failures are counted independently of mismatch/settle";
  return [
    metricContract({
      metric: "effect reconcile observe effects",
      anchor,
      population,
      excludes,
      value: report.rows.length,
    }),
    metricContract({
      metric: "effect reconcile observe mismatches",
      anchor,
      population,
      excludes,
      value: report.mismatches,
    }),
    metricContract({
      metric: "effect reconcile observe would-settle",
      anchor,
      population,
      excludes,
      value: report.wouldSettle,
    }),
    metricContract({
      metric: "effect reconcile observe evidence failures",
      anchor,
      population,
      excludes,
      value: report.evidence.failures.length,
    }),
  ];
}

function renderObserveReport(report: EffectObserveReconcileReport): string {
  void effectReconcileObservePublication(report);
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

/** H-7: contract `--probe` reconcile summary counts (ruling 559); human lines unchanged. */
export function effectReconcileProbePublication(
  report: EffectReconcileProbeReport,
  evidence: EffectEvidenceGateReport,
): string[] {
  const openUnknown = report.rows.filter(
    (r) => r.sessionVerdict === "unknown" || r.ledgerVerdict === "unknown",
  ).length;
  const anchor =
    "none — first effect reconcile --probe (no prior probe report of this workspace to compare against)";
  const population = `read-only effect reconcile --probe over workspace ${report.workspace}`;
  const excludes =
    "observe-only mode is separate; probe performs no ledger writes; io/vcs/terminal hints are not counted here";
  return [
    metricContract({
      metric: "effect reconcile probe effects scanned",
      anchor,
      population,
      excludes,
      value: report.effectsScanned,
    }),
    metricContract({
      metric: "effect reconcile probe mismatches",
      anchor,
      population,
      excludes,
      value: report.mismatches.length,
    }),
    metricContract({
      metric: "effect reconcile probe open unknown",
      anchor,
      population,
      excludes,
      value: openUnknown,
    }),
    metricContract({
      metric: "effect reconcile probe evidence failures",
      anchor,
      population,
      excludes,
      value: evidence.failures.length,
    }),
  ];
}

function renderProbeReport(
  workspace: string,
  sessionId: string | undefined,
  report: EffectReconcileProbeReport,
  evidence: EffectEvidenceGateReport,
): string {
  void effectReconcileProbePublication(report, evidence);
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

/** H-7 CLI surface: contracted blocks for the same mode `renderEffectReconcile` used (ruling 613). */
export function effectReconcilePublication(
  workspace: string,
  opts: { sessionId?: string; probe?: boolean } = {},
): string[] {
  if (opts.probe) {
    const report = probeEffectReconcile(workspace, { sessionId: opts.sessionId });
    const evidence = probeEffectEvidence(workspace, { sessionId: opts.sessionId });
    return effectReconcileProbePublication(report, evidence);
  }
  return effectReconcileObservePublication(buildObserveOnlyReport(workspace, opts.sessionId));
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
