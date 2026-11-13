/**
 * unknown-inspector.ts — scrollback UNKNOWN list (docs/13 R169; docs/28 ruling 264).
 */

import type { UnknownEffectRow } from "../core/effect-unknown-list";
import type { EffectRecord } from "../core/effect-host";
import type { Receipt } from "../contracts";
import type { Renderer } from "./render";
import { verifyReceiptChainSync } from "../core/receipt-chain-verify";
import { buildReceiptInspectorModel, formatReceiptInspectorScrollbackLines } from "./receipt-inspector";
import { UNKNOWN_ACTION_HINTS } from "./unknown-slash-parse";
import { dim } from "./style";

export type { UnknownEffectRow } from "../core/effect-unknown-list";

export function formatUnknownInspectorLines(rows: readonly UnknownEffectRow[]): string[] {
  if (rows.length === 0) return ["no unreconciled UNKNOWN effects"];
  const header =
    rows.length === 1 ? "1 unreconciled UNKNOWN effect:" : `${rows.length} unreconciled UNKNOWN effects:`;
  const lines = [header];
  for (const row of rows) {
    const bits = [`effect ${row.effectId}`, `tool ${row.tool}`];
    if (row.receiptId !== undefined && row.receiptId !== "") bits.push(`receipt ${row.receiptId}`);
    lines.push(`  · ${bits.join(" · ")}`);
  }
  if (rows.length > 0) {
    lines.push("");
    lines.push(...UNKNOWN_ACTION_HINTS);
  }
  return lines;
}

export function formatReceiptChainInspectLines(opts: {
  record?: EffectRecord;
  receipt?: Receipt;
  sessionId?: string;
  workspace?: string;
}): string[] {
  const chainVerify = typeof opts.workspace === "string" ? verifyReceiptChainSync(opts.workspace) : undefined;
  const model = buildReceiptInspectorModel({
    record: opts.record,
    receipt: opts.receipt,
    sessionId: opts.sessionId,
    workspace: opts.workspace,
    chainVerify,
  });
  return model ? formatReceiptInspectorScrollbackLines(model) : [];
}

/** @deprecated Use `formatReceiptChainInspectLines` with receipt + effect together. */
export function formatEffectInspectLines(record: EffectRecord): string[] {
  return formatReceiptChainInspectLines({ record });
}

/** Print the inspector into scrollback transcript lines. */
export function printUnknownInspector(renderer: Renderer, rows: readonly UnknownEffectRow[]): void {
  for (const line of formatUnknownInspectorLines(rows)) {
    renderer.line(line.startsWith("  ·") ? dim(line) : line);
  }
}
