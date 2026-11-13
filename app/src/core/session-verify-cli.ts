/**
 * session-verify-cli.ts — `hzcode session verify` (R172 reduced; ruling **291**).
 *
 * Receipt hash chain + read-only effect reconcile probe; no mutations.
 * Exit 3 when the chain is broken or reconcile probe reports mismatches / open UNKNOWN.
 */

import { SessionStore } from "./session";
import {
  formatEffectReconcileProbeSummary,
  probeEffectReconcile,
  type EffectReconcileProbeReport,
} from "./effect-reconcile-probe";
import {
  type ChainAnchorVerdict,
  formatChainAnchorSummary,
  optionalCompactionChainPaths,
  verifyCompactionAnchorSync,
  verifySessionEventAnchorSync,
} from "./chain-anchor-verify";
import {
  formatEffectEvidenceGateSummary,
  probeEffectEvidence,
  type EffectEvidenceGateReport,
} from "./effect-evidence-gate";
import {
  formatPostimageReplaySummary,
  postimageReplayActive,
  postimageReplayDoctorPosture,
  probePostimageReplay,
} from "./effect-postimage-replay";
import {
  formatReceiptChainVerifySummary,
  verifyReceiptChainSync,
  type ReceiptChainVerifyVerdict,
} from "./receipt-chain-verify";

export const SESSION_VERIFY_FAIL_EXIT = 3;

export interface SessionVerifyReport {
  workspace: string;
  sessionId: string;
  sessionFound: boolean;
  chain: ReceiptChainVerifyVerdict;
  sessionEvents?: ChainAnchorVerdict;
  compactionChains: ChainAnchorVerdict[];
  reconcile: EffectReconcileProbeReport;
  evidence: EffectEvidenceGateReport;
  postimageReplayEnabled: boolean;
  /** Effects still `unknown` after in-session reconcile simulation. */
  openUnknownCount: number;
  ok: boolean;
}

function countOpenUnknown(report: EffectReconcileProbeReport): number {
  return report.rows.filter((r) => r.sessionVerdict === "unknown" || r.ledgerVerdict === "unknown").length;
}

export function buildSessionVerifyReport(workspace: string, sessionId: string): SessionVerifyReport {
  const store = new SessionStore(workspace);
  const sessionFound = store.getSession(sessionId) !== null;
  const chain = verifyReceiptChainSync(workspace);
  const sessionEvents = sessionFound
    ? verifySessionEventAnchorSync(workspace, sessionId)
    : { ok: true, label: `session events (${sessionId})`, count: 0, skipped: true };
  const compactionChains = optionalCompactionChainPaths(workspace).map((file) =>
    verifyCompactionAnchorSync(file),
  );
  const sessionScope = sessionFound ? sessionId : undefined;
  const reconcile = probeEffectReconcile(workspace, { sessionId: sessionScope });
  const replayOn = postimageReplayActive();
  const evidence = probeEffectEvidence(workspace, { sessionId: sessionScope });
  const openUnknownCount = countOpenUnknown(reconcile);
  const anchorsOk =
    (sessionEvents.ok || sessionEvents.skipped) && compactionChains.every((c) => c.ok || c.skipped);
  const ok =
    sessionFound &&
    chain.ok &&
    anchorsOk &&
    reconcile.mismatches.length === 0 &&
    evidence.failures.length === 0 &&
    openUnknownCount === 0;
  return {
    workspace,
    sessionId,
    sessionFound,
    chain,
    sessionEvents,
    compactionChains,
    reconcile,
    evidence,
    postimageReplayEnabled: replayOn,
    openUnknownCount,
    ok,
  };
}

export function sessionVerifyExitCode(report: SessionVerifyReport): number {
  return report.ok ? 0 : SESSION_VERIFY_FAIL_EXIT;
}

export function renderSessionVerify(report: SessionVerifyReport): string {
  const lines: string[] = [
    "hzcode session verify (read-only; evidence gate **257**/**295**; postimage replay **297**/**301** opt-in or require-auto)",
    `  session ${report.sessionId}${report.sessionFound ? "" : " (not in workspace store)"}`,
    `  workspace ${report.workspace}`,
  ];
  lines.push(...formatReceiptChainVerifySummary(report.chain).map((l) => (l.startsWith("  ") ? l : `  ${l}`)));
  if (report.sessionEvents && !report.sessionEvents.skipped) {
    lines.push(...formatChainAnchorSummary(report.sessionEvents).map((l) => (l.startsWith("  ") ? l : `  ${l}`)));
  }
  for (const compact of report.compactionChains) {
    lines.push(...formatChainAnchorSummary(compact).map((l) => (l.startsWith("  ") ? l : `  ${l}`)));
  }
  if (report.compactionChains.length === 0) {
    lines.push(
      "  compaction chain: (no compactions.jsonl — no CompactionRecordV1 rows for this workspace yet; reduced writer appends on compaction)",
    );
  }
  lines.push(`  ${formatEffectReconcileProbeSummary(report.reconcile)}`);
  lines.push(`  ${formatEffectEvidenceGateSummary(report.evidence)}`);
  if (report.postimageReplayEnabled) {
    const replayPosture = postimageReplayDoctorPosture();
    const via =
      replayPosture.requireAuto && !replayPosture.explicit
        ? " (auto: HZ_EFFECT_HOST_KERNEL=require)"
        : " (HZ_VERIFY_POSTIMAGE_REPLAY)";
    lines.push(`  ${formatPostimageReplaySummary(probePostimageReplay(report.workspace))}${via}`);
  }
  if (report.evidence.failures.length > 0) {
    lines.push("  evidence failures:");
    for (const f of report.evidence.failures.slice(0, 16)) {
      lines.push(
        `    · ${f.kind} · ${f.tool} · ${f.effectId.slice(0, 13)}…${f.receiptId ? ` receipt=${f.receiptId}` : ""}`,
      );
    }
    if (report.evidence.failures.length > 16) {
      lines.push(`    … +${report.evidence.failures.length - 16} more`);
    }
  }
  if (report.reconcile.mismatches.length > 0) {
    lines.push("  reconcile mismatches:");
    for (const m of report.reconcile.mismatches.slice(0, 16)) {
      lines.push(
        `    · ${m.kind} · ${m.tool} · ${m.effectId.slice(0, 13)}… ledger=${m.ledgerVerdict ?? "—"} session=${m.sessionVerdict} kernel=${m.kernelVerdict ?? "—"}`,
      );
    }
    if (report.reconcile.mismatches.length > 16) {
      lines.push(`    … +${report.reconcile.mismatches.length - 16} more`);
    }
  }
  if (report.openUnknownCount > 0) {
    lines.push(`  open UNKNOWN effects: ${report.openUnknownCount}`);
  }
  lines.push(report.ok ? "  verdict: verified (reduced)" : "  verdict: not verified");
  return lines.join("\n");
}
