/**
 * crash-diagnostics.ts — Group G crash diagnostic data model (grok port).
 * Source seam: kernel/src/effect_owner.rs:1662-1704 fault-injection exits
 * 86 (after prepare), 87 (after executing marker), 88 (before owner settle).
 *
 * Maps a persisted exit code to an HONEST record: 86 is recoverable (no
 * executing marker was written); 87/88 are UNKNOWN and fail closed because the
 * effect may have run. No signal handling, no symbolication claim without
 * symbols — this is durable data for a future `doctor.statusz` surface.
 */

export type CrashBoundary = "after_prepare" | "after_executing" | "before_owner_settle";
export type CrashVerdict = "RECOVERABLE" | "UNKNOWN";

export interface KernelCrashRecord {
  exitCode: number;
  boundary: CrashBoundary;
  effectId?: string;
  verdict: CrashVerdict;
  recoverable: boolean;
  /** Never true unless real symbols were resolved by a caller. */
  symbolsAvailable: boolean;
  at: string;
}

const EXIT_BOUNDARY: Readonly<Record<number, CrashBoundary>> = {
  86: "after_prepare",
  87: "after_executing",
  88: "before_owner_settle",
};

export function classifyKernelExit(
  exitCode: number,
  details: { effectId?: string; at?: string } = {},
): KernelCrashRecord | undefined {
  const boundary = EXIT_BOUNDARY[exitCode];
  if (boundary === undefined) return undefined;
  const recoverable = boundary === "after_prepare";
  return {
    exitCode,
    boundary,
    ...(details.effectId === undefined ? {} : { effectId: details.effectId }),
    verdict: recoverable ? "RECOVERABLE" : "UNKNOWN",
    recoverable,
    symbolsAvailable: false,
    at: details.at ?? new Date().toISOString(),
  };
}

export function formatCrashNotice(record: KernelCrashRecord): string {
  const parts = [
    `kernel crash: exit ${record.exitCode} (${record.boundary})`,
    `verdict=${record.verdict}`,
    record.recoverable ? "prepare-only recovery may apply" : "effect may have run — fail closed",
  ];
  if (record.effectId !== undefined) parts.push(`effect ${record.effectId}`);
  parts.push("no resolved symbols (raw addresses only)");
  return parts.join("; ");
}
