/**
 * Opt-in verification artifact auto-emit (ruling **708**; extends **643**).
 *
 * `HZ_VERIFY_ARTIFACT_AUTO_EMIT=1`: after a succeeded agent turn or a passing
 * `hzcode session verify`, persist `hz.verification.artifact.v1` under
 * `<workspace>/.hz/verification/`. Default-off. Does **not** bundle Chromium,
 * auto-capture CDP screenshots, or emit on failed turns / failed verify.
 */

import {
  buildVerificationArtifact,
  writeVerificationArtifact,
  type VerificationReceiptLink,
} from "./verification-artifact";
import { readVerifiedReceiptSnapshotSync } from "./receipt-chain-verify";
import type { SessionVerifyReport } from "./session-verify-cli";

const RECEIPT_TAIL_MAX = 48;

export function verificationArtifactAutoEmitEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_VERIFY_ARTIFACT_AUTO_EMIT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function summarizeChangedPaths(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const head = paths.slice(0, 24);
  const tail = paths.length > 24 ? ` (+${paths.length - 24} more)` : "";
  return `${head.join(", ")}${tail}`;
}

/** Tail of verified workspace receipts; undefined when chain is not ok (fail-closed). */
export function receiptLinksForAutoEmit(
  workspace: string,
  max = RECEIPT_TAIL_MAX,
): VerificationReceiptLink[] | undefined {
  const snap = readVerifiedReceiptSnapshotSync(workspace);
  if (!snap.ok) return undefined;
  return snap.receipts.slice(-max).map((r) => ({ receiptId: r.id, digest: r.hash }));
}

export type VerificationArtifactAutoEmitResult =
  | { emitted: true; path: string; artifactDigest: string }
  | { emitted: false; reason: string };

async function persistAutoArtifact(
  workspace: string,
  input: {
    goal: string;
    plan?: string;
    diffSummary?: string;
    testOutput?: string;
    receiptChain?: VerificationReceiptLink[];
  },
  fileNamePrefix: string,
): Promise<VerificationArtifactAutoEmitResult> {
  const artifact = buildVerificationArtifact(input);
  const fileName = `${fileNamePrefix}-${artifact.artifactDigest.slice(0, 16)}.json`;
  try {
    const path = await writeVerificationArtifact(workspace, artifact, { fileName });
    return { emitted: true, path, artifactDigest: artifact.artifactDigest };
  } catch (err) {
    return {
      emitted: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function tryAutoEmitVerificationArtifactTurn(opts: {
  workspace: string;
  sessionId: string;
  goal: string;
  exitTerminal: string;
  changedPaths: readonly string[];
  verifiedCommand?: string;
  env?: Record<string, string | undefined>;
}): Promise<VerificationArtifactAutoEmitResult | undefined> {
  const env = opts.env ?? process.env;
  if (!verificationArtifactAutoEmitEnabled(env)) return undefined;
  if (opts.exitTerminal !== "succeeded") {
    return { emitted: false, reason: `turn exit ${opts.exitTerminal} — auto-emit only on succeeded` };
  }
  const receiptChain = receiptLinksForAutoEmit(opts.workspace);
  if (receiptChain === undefined) {
    return { emitted: false, reason: "receipt chain not ok — auto-emit refused (fail-closed)" };
  }
  const diffSummary = summarizeChangedPaths(opts.changedPaths);
  const testOutput =
    opts.verifiedCommand !== undefined
      ? `verification-shaped shell: ${opts.verifiedCommand}`
      : undefined;
  const plan = [
    "auto-emit: agent turn success (HZ_VERIFY_ARTIFACT_AUTO_EMIT)",
    `session ${opts.sessionId}`,
    "browser screenshots: not included (manual hzcode verify-artifact or CDP opt-in only)",
  ].join("\n");
  return persistAutoArtifact(
    opts.workspace,
  {
      goal: opts.goal.trim() || `turn session ${opts.sessionId}`,
      plan,
      diffSummary,
      testOutput,
      receiptChain,
    },
    "artifact-turn",
  );
}

export async function tryAutoEmitVerificationArtifactSessionVerify(
  workspace: string,
  report: SessionVerifyReport,
  env: Record<string, string | undefined> = process.env,
): Promise<VerificationArtifactAutoEmitResult | undefined> {
  if (!verificationArtifactAutoEmitEnabled(env)) return undefined;
  if (!report.ok) {
    return {
      emitted: false,
      reason: "session verify not ok — auto-emit refused (fail-closed)",
    };
  }
  const receiptChain = receiptLinksForAutoEmit(workspace);
  if (receiptChain === undefined) {
    return { emitted: false, reason: "receipt chain not ok — auto-emit refused (fail-closed)" };
  }
  const plan = [
    "auto-emit: hzcode session verify success (HZ_VERIFY_ARTIFACT_AUTO_EMIT)",
    `session ${report.sessionId}`,
    `receipt chain ok (${report.chain.count} receipt(s) in workspace)`,
    `open UNKNOWN effects: ${report.openUnknownCount}`,
    "browser screenshots: not included",
  ].join("\n");
  const testOutput = `session verify ok; reconcile mismatches=${report.reconcile.mismatches.length}; evidence failures=${report.evidence.failures.length}`;
  return persistAutoArtifact(
    workspace,
    {
      goal: `verified session ${report.sessionId}`,
      plan,
      testOutput,
      receiptChain,
    },
    "artifact-session-verify",
  );
}

export function formatVerificationArtifactAutoEmitNotice(
  result: VerificationArtifactAutoEmitResult,
): string {
  if (result.emitted === true) {
    return `verification artifact auto-emit ${result.artifactDigest.slice(0, 16)}… → ${result.path}`;
  }
  return `verification artifact auto-emit skipped: ${result.reason}`;
}

/**
 * Loop hook: best-effort notice only; never throws into turn exit.
 */
export async function maybeAutoEmitVerificationArtifactAfterTurn(opts: {
  workspace: string;
  sessionId: string;
  goal: string;
  exitTerminal: string;
  changedPaths: readonly string[];
  verifiedCommand?: string;
  onNotice: (message: string) => void;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  try {
    const result = await tryAutoEmitVerificationArtifactTurn(opts);
    if (result === undefined) return;
    opts.onNotice(formatVerificationArtifactAutoEmitNotice(result));
  } catch (err) {
    opts.onNotice(
      `verification artifact auto-emit skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}