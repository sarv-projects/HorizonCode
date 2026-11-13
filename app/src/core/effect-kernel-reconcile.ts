/**
 * effect-kernel-reconcile.ts — live wire to kernel `effect.reconcile` (ruling **261**).
 *
 * After Bun EffectHost reconciles on observe, mirror phases + receipt facts + evidence
 * flags to the kernel. The TS reconcile verdict stays authoritative; kernel errors are
 * ignored and never change settlement.
 */

import type { KernelRequestMap } from "../contracts";
import type { EffectRecord } from "./effect-host";
import type { KernelClient } from "./kernel";

export function effectReconcileParamsFromRecord(
  record: EffectRecord,
): KernelRequestMap["effect.reconcile"]["params"] | undefined {
  const phases = record.steps.map((s) => s.phase);
  if (phases.length === 0) return undefined;
  const observe = record.steps.find((s) => s.phase === "observe");
  const params: KernelRequestMap["effect.reconcile"]["params"] = { phases };
  if (observe?.receiptId !== undefined) params.receiptId = observe.receiptId;
  if (observe?.receiptSeq !== undefined) params.receiptSeq = observe.receiptSeq;
  if (observe?.resultDigestEvidenceStable === false) params.resultDigestStable = false;
  else if (observe?.resultDigestEvidenceStable === true) params.resultDigestStable = true;
  if (observe?.postimageMissingAtObserve === true) params.postimageMissing = true;
  else if (observe?.postimageMissingAtObserve === false) params.postimageMissing = false;
  if (observe?.postimageObservationStable === false) params.postimageObservationStable = false;
  else if (observe?.postimageObservationStable === true) params.postimageObservationStable = true;
  return params;
}

/** Fire-and-forget kernel mirror; swallows transport / refusal errors. */
export async function mirrorEffectReconcileToKernel(
  kernel: KernelClient | undefined,
  record: EffectRecord | undefined,
): Promise<KernelRequestMap["effect.reconcile"]["result"] | undefined> {
  if (!kernel || !record) return undefined;
  const params = effectReconcileParamsFromRecord(record);
  if (!params) return undefined;
  try {
    return await kernel.reconcileEffect(params);
  } catch {
    return undefined;
  }
}
