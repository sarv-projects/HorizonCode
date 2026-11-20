/**
 * Absent-path reconstruction summary for postimage verify (P0-2 partial; ruling **698**).
 *
 * Surfaces `absenceReconstruct` from trusted-kernel `effect.owner.postimage.verify`.
 * Does not claim byte reconstruction or full historical replay.
 */

import type { KernelRequestMap } from "../contracts";
import { KernelClient, resolveKernelBinary } from "./kernel";

export type AbsenceReconstructReport = NonNullable<
  KernelRequestMap["effect.owner.postimage.verify"]["result"]["absenceReconstruct"]
>;

export type AbsenceReconstructSessionSurface =
  | { kind: "kernel"; report: AbsenceReconstructReport; historicalChecked?: number }
  | { kind: "skipped"; reason: string };

export function formatAbsenceReconstructSummary(surface: AbsenceReconstructSessionSurface | undefined): string {
  if (surface === undefined) {
    return "absent-path reconstruct: (not checked)";
  }
  if (surface.kind === "skipped") {
    return `absent-path reconstruct: skipped — ${surface.reason}`;
  }
  const r = surface.report;
  const hist =
    surface.historicalChecked !== undefined && surface.historicalChecked > 0
      ? `; ${surface.historicalChecked} superseded signed absence fact(s) in history`
      : "";
  if (r.reconstructed === 0 && (surface.historicalChecked ?? 0) === 0 && r.uncertain.length === 0) {
    return "absent-path reconstruct: (no latest absent paths)";
  }
  if (r.ok) {
    return `absent-path reconstruct: ${r.reconstructed} latest path(s) explicitly absent${hist}`;
  }
  const bits = r.uncertain
    .slice(0, 2)
    .map((u) => `${u.path.split(/[/\\]/).pop() ?? u.path} (${u.classification})`);
  return `absent-path reconstruct: ${r.uncertain.length} uncertain — ${bits.join("; ")}${hist}`;
}

export function absenceReconstructBlocksVerify(surface: AbsenceReconstructSessionSurface | undefined): boolean {
  return surface?.kind === "kernel" && !surface.report.ok;
}

export async function probeAbsenceReconstructViaKernel(
  workspace: string,
): Promise<AbsenceReconstructSessionSurface> {
  if (resolveKernelBinary() === undefined) {
    return {
      kind: "skipped",
      reason: "trusted Rust kernel not discoverable (absent-path reconstruct requires OwnerLog RPC)",
    };
  }
  const client = new KernelClient({ workspace });
  try {
    const mode = await client.start();
    if (mode !== "trusted") {
      return { kind: "skipped", reason: "OwnerLog postimage verify requires trusted Rust kernel" };
    }
    const result = await client.ownerPostimageVerify();
    if (!result.absenceReconstruct) {
      return { kind: "skipped", reason: "kernel postimage verify returned no absenceReconstruct field" };
    }
    const historicalChecked = result.history?.absenceReplay?.checked;
    return { kind: "kernel", report: result.absenceReconstruct, historicalChecked };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "skipped", reason: message };
  }
}