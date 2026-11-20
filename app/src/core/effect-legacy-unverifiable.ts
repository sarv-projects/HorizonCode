/**
 * Legacy unverifiable postimage classification for verify (P0-2 partial; ruling **709**).
 *
 * Surfaces `legacyClassify` from trusted-kernel `effect.owner.postimage.verify`.
 * Does not claim CAS backfill or universal historical replay.
 */

import type { KernelRequestMap } from "../contracts";
import { KernelClient, resolveKernelBinary } from "./kernel";

export type LegacyClassifyReport = NonNullable<
  KernelRequestMap["effect.owner.postimage.verify"]["result"]["legacyClassify"]
>;

export type LegacyClassifySessionSurface =
  | { kind: "kernel"; report: LegacyClassifyReport }
  | { kind: "skipped"; reason: string };

export function formatLegacyClassifySummary(surface: LegacyClassifySessionSurface | undefined): string {
  if (surface === undefined) {
    return "legacy unverifiable: (not checked)";
  }
  if (surface.kind === "skipped") {
    return `legacy unverifiable: skipped — ${surface.reason}`;
  }
  const r = surface.report;
  if (r.refused === 0) {
    return "legacy unverifiable: (none)";
  }
  const sample = r.rows
    .slice(0, 2)
    .map((row) => `${row.effectId}${row.path ? ` @ ${row.path.split(/[/\\]/).pop() ?? row.path}` : ""} (${row.reason})`);
  return `legacy unverifiable: ${r.refused} refused — ${sample.join("; ")}`;
}

export function legacyClassifyBlocksVerify(surface: LegacyClassifySessionSurface | undefined): boolean {
  return surface?.kind === "kernel" && !surface.report.ok;
}

export async function probeLegacyClassifyViaKernel(
  workspace: string,
): Promise<LegacyClassifySessionSurface> {
  if (resolveKernelBinary() === undefined) {
    return {
      kind: "skipped",
      reason: "trusted Rust kernel not discoverable (legacy classify requires OwnerLog RPC)",
    };
  }
  const client = new KernelClient({ workspace });
  try {
    const mode = await client.start();
    if (mode !== "trusted") {
      return { kind: "skipped", reason: "OwnerLog postimage verify requires trusted Rust kernel" };
    }
    const result = await client.ownerPostimageVerify();
    if (!result.legacyClassify) {
      return { kind: "skipped", reason: "kernel postimage verify returned no legacyClassify field" };
    }
    return { kind: "kernel", report: result.legacyClassify };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "skipped", reason: message };
  }
}