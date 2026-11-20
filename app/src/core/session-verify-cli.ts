/**
 * session-verify-cli.ts — `hzcode session verify` (R172 reduced; ruling **291**).
 *
 * Receipt hash chain + nested child-receipt graph replay (**456**) + nested
 * child event-stream replay (**478**) + read-only effect reconcile probe; no
 * mutations. Exit 3 when the chain is broken, nested replay refuses, or
 * reconcile probe reports mismatches / open UNKNOWN.
 */

import { SessionStore } from "./session";
import { metricContract } from "./metrics";
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
import {
  formatNestedReceiptReplayLines,
  replayNestedReceiptsInWorkspace,
  type NestedReceiptReplayVerdict,
} from "./receipt-nested-replay";
import {
  formatNestedEventStreamReplayLines,
  replayNestedEventStreams,
  type NestedEventStreamReplayVerdict,
} from "./receipt-nested-event-stream-replay";
import {
  formatNestedObserveSummary,
  type NestedObserveSessionSurface,
  nestedObserveBlocksVerify,
} from "./effect-nested-observe";
import {
  absenceReconstructBlocksVerify,
  formatAbsenceReconstructSummary,
  type AbsenceReconstructSessionSurface,
} from "./effect-absent-path-reconstruct";
import {
  formatLegacyClassifySummary,
  type LegacyClassifySessionSurface,
  legacyClassifyBlocksVerify,
} from "./effect-legacy-unverifiable";

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
  /** Nested child-receipt graph replay from one verified snapshot (ruling **456**). */
  nestedReceipts: NestedReceiptReplayVerdict;
  /** Nested child event-stream replay from a verified parent read (ruling **478**). */
  nestedEventStreams: NestedEventStreamReplayVerdict;
  /** Trusted-kernel childEffectIds OwnerLog observe (**697**); optional when kernel absent. */
  nestedObserve?: NestedObserveSessionSurface;
  /** Latest absent-path independent reconstruction (**698**); optional when kernel absent. */
  absenceReconstruct?: AbsenceReconstructSessionSurface;
  /** Named legacy unverifiable postimage rows (**709**); optional when kernel absent. */
  legacyClassify?: LegacyClassifySessionSurface;
  /** Effects still `unknown` after in-session reconcile simulation. */
  openUnknownCount: number;
  ok: boolean;
}

function countOpenUnknown(report: EffectReconcileProbeReport): number {
  return report.rows.filter((r) => r.sessionVerdict === "unknown" || r.ledgerVerdict === "unknown").length;
}

export function buildSessionVerifyReport(
  workspace: string,
  sessionId: string,
  opts?: {
    nestedObserve?: NestedObserveSessionSurface;
    absenceReconstruct?: AbsenceReconstructSessionSurface;
    legacyClassify?: LegacyClassifySessionSurface;
  },
): SessionVerifyReport {
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
  const nestedReceipts = replayNestedReceiptsInWorkspace(workspace);
  const nestedEventStreams = replayNestedEventStreams(workspace, sessionId);
  const openUnknownCount = countOpenUnknown(reconcile);
  const anchorsOk =
    (sessionEvents.ok || sessionEvents.skipped) && compactionChains.every((c) => c.ok || c.skipped);
  const nestedObserve = opts?.nestedObserve;
  const absenceReconstruct = opts?.absenceReconstruct;
  const legacyClassify = opts?.legacyClassify;
  const ok =
    sessionFound &&
    chain.ok &&
    anchorsOk &&
    nestedReceipts.ok &&
    nestedEventStreams.ok &&
    reconcile.mismatches.length === 0 &&
    evidence.failures.length === 0 &&
    openUnknownCount === 0 &&
    !nestedObserveBlocksVerify(nestedObserve) &&
    !absenceReconstructBlocksVerify(absenceReconstruct) &&
    !legacyClassifyBlocksVerify(legacyClassify);
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
    nestedReceipts,
    nestedEventStreams,
    nestedObserve,
    absenceReconstruct,
    legacyClassify,
    openUnknownCount,
    ok,
  };
}

/** Async wrapper: probes trusted-kernel nested observe before building the report. */
export async function buildSessionVerifyReportAsync(
  workspace: string,
  sessionId: string,
): Promise<SessionVerifyReport> {
  const [{ probeNestedObserveViaKernel }, { probeAbsenceReconstructViaKernel }, { probeLegacyClassifyViaKernel }] =
    await Promise.all([
      import("./effect-nested-observe"),
      import("./effect-absent-path-reconstruct"),
      import("./effect-legacy-unverifiable"),
    ]);
  const [nestedObserve, absenceReconstruct, legacyClassify] = await Promise.all([
    probeNestedObserveViaKernel(workspace),
    probeAbsenceReconstructViaKernel(workspace),
    probeLegacyClassifyViaKernel(workspace),
  ]);
  return buildSessionVerifyReport(workspace, sessionId, {
    nestedObserve,
    absenceReconstruct,
    legacyClassify,
  });
}


/** H-7: contracted form of `hzcode session verify` scalar outcomes (ruling 591). */
export function sessionVerifyPublication(report: SessionVerifyReport): string[] {
  const anchor = "none — this session-verify invocation";
  const population = "read-only verify of receipt chain, nested replay, reconcile, and evidence for one session";
  const excludes = "none — scalars are derived from the verify report only (no mutation)";
  return [
    metricContract({
      metric: "session verify ok",
      anchor,
      population,
      excludes,
      value: report.ok ? 1 : 0,
    }),
    metricContract({
      metric: "session verify open unknown",
      anchor,
      population,
      excludes,
      value: report.openUnknownCount,
    }),
    metricContract({
      metric: "session verify reconcile mismatches",
      anchor,
      population,
      excludes,
      value: report.reconcile.mismatches.length,
    }),
  ];
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
  lines.push(...formatNestedReceiptReplayLines(report.nestedReceipts).map((l) => (l.startsWith("  ") ? l : `  ${l}`)));
  lines.push(
    ...formatNestedEventStreamReplayLines(report.nestedEventStreams).map((l) =>
      l.startsWith("  ") ? l : `  ${l}`,
    ),
  );
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
  if (report.nestedObserve !== undefined) {
    lines.push(`  ${formatNestedObserveSummary(report.nestedObserve)}`);
  }
  if (report.absenceReconstruct !== undefined) {
    lines.push(`  ${formatAbsenceReconstructSummary(report.absenceReconstruct)}`);
  }
  if (report.legacyClassify !== undefined) {
    lines.push(`  ${formatLegacyClassifySummary(report.legacyClassify)}`);
  }
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

/** Optional auto-emit line for CLI (ruling **708**); async side effect when env opt-in. */
export async function sessionVerifyAutoEmitLine(
  report: SessionVerifyReport,
): Promise<string | undefined> {
  const {
    formatVerificationArtifactAutoEmitNotice,
    tryAutoEmitVerificationArtifactSessionVerify,
    verificationArtifactAutoEmitEnabled,
  } = await import("./verification-artifact-auto");
  if (!verificationArtifactAutoEmitEnabled()) return undefined;
  const result = await tryAutoEmitVerificationArtifactSessionVerify(report.workspace, report);
  if (result === undefined) return undefined;
  return `  ${formatVerificationArtifactAutoEmitNotice(result)}`;
}
