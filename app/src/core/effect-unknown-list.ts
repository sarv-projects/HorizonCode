/**
 * effect-unknown-list.ts — unreconciled EffectHost rows for TUI / doctor (ruling 264).
 */

import type { EffectHost, EffectReconcileVerdict } from "./effect-host";

export interface UnknownEffectRow {
  effectId: string;
  tool: string;
  callId: string;
  receiptId?: string;
}

/** Rows whose live or persisted verdict is still `unknown`. */
export function collectUnknownEffectRows(
  effectHost: Pick<EffectHost, "listEffectIds" | "getRecord" | "reconcileEffect">,
  persistedVerdicts?: ReadonlyMap<string, EffectReconcileVerdict | undefined>,
): UnknownEffectRow[] {
  const rows: UnknownEffectRow[] = [];
  const ids = [...effectHost.listEffectIds()].sort((a, b) => a.localeCompare(b));
  for (const effectId of ids) {
    const live = effectHost.reconcileEffect(effectId);
    const persisted = persistedVerdicts?.get(effectId);
    if (live !== "unknown" && persisted !== "unknown") continue;
    const rec = effectHost.getRecord(effectId);
    if (!rec) continue;
    const observe = rec.steps.find((s) => s.phase === "observe");
    rows.push({
      effectId,
      tool: rec.tool,
      callId: rec.callId,
      receiptId: observe?.receiptId,
    });
  }
  return rows;
}
