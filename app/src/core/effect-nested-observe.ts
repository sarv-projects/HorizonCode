/**
 * Nested child-effect OwnerLog observe summary (P0-2 partial; ruling **698**).
 *
 * Surfaces `nestedObserve` from trusted-kernel `effect.owner.postimage.verify`.
 * Does not claim full R172 closure.
 */

import type { KernelRequestMap } from "../contracts";
import { KernelClient, resolveKernelBinary } from "./kernel";

export type NestedObserveReport = NonNullable<
  KernelRequestMap["effect.owner.postimage.verify"]["result"]["nestedObserve"]
>;

export type NestedObserveSessionSurface =
  | { kind: "kernel"; report: NestedObserveReport }
  | { kind: "skipped"; reason: string };

export function formatNestedObserveSummary(surface: NestedObserveSessionSurface | undefined): string {
  if (surface === undefined) {
    return "nested child observe: (not checked)";
  }
  if (surface.kind === "skipped") {
    return `nested child observe: skipped — ${surface.reason}`;
  }
  const r = surface.report;
  if (r.visited === 0) {
    return "nested child observe: (no childEffectIds in verified receipts)";
  }
  if (r.ok) {
    return `nested child observe: ${r.verified}/${r.visited} child effect(s) independently classified (${r.scope})`;
  }
  const bits = r.nodes
    .filter((n) => !n.ok)
    .slice(0, 3)
    .map((n) => `${n.effectId.slice(0, 10)}… ${n.classification}`);
  const more = r.refused > 3 ? ` (+${r.refused - 3} more)` : "";
  return `nested child observe: ${r.refused} refused — ${bits.join("; ")}${more}`;
}

/** Best-effort trusted-kernel probe; read-only under OwnerLog lock. */
export async function probeNestedObserveViaKernel(
  workspace: string,
): Promise<NestedObserveSessionSurface> {
  if (resolveKernelBinary() === undefined) {
    return {
      kind: "skipped",
      reason: "trusted Rust kernel not discoverable (nested observe requires OwnerLog RPC)",
    };
  }
  const client = new KernelClient({ workspace });
  try {
    const mode = await client.start();
    if (mode !== "trusted") {
      return { kind: "skipped", reason: "OwnerLog postimage verify requires trusted Rust kernel" };
    }
    const result = await client.ownerPostimageVerify();
    if (!result.nestedObserve) {
      return { kind: "skipped", reason: "kernel postimage verify returned no nestedObserve field" };
    }
    return { kind: "kernel", report: result.nestedObserve };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "skipped", reason: message };
  }
}

export function nestedObserveBlocksVerify(surface: NestedObserveSessionSurface | undefined): boolean {
  return surface?.kind === "kernel" && !surface.report.ok;
}