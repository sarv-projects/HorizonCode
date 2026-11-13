/**
 * receipt-cli.ts — `hzcode receipt show` (R172 reduced; ruling **286**).
 */

import { findReceiptForUnknownTarget } from "./unknown-receipt-lookup";
import { loadEffectLedger } from "./effect-ledger";
import { verifyReceiptChainSync } from "./receipt-chain-verify";
import { buildReceiptInspectorModel, formatReceiptInspectorScrollbackLines } from "../tui/receipt-inspector";

export function renderReceiptShow(workspace: string, receiptId: string): string {
  const receipt = findReceiptForUnknownTarget(workspace, receiptId);
  if (!receipt) {
    throw new Error(`no receipt matched "${receiptId}"`);
  }
  const { records } = loadEffectLedger(workspace);
  const record =
    receipt.effectId !== undefined
      ? records.find((r) => r.effectId === receipt.effectId)
      : undefined;
  const chainVerify = verifyReceiptChainSync(workspace);
  const model = buildReceiptInspectorModel({ record, receipt, workspace, chainVerify });
  if (!model) {
    throw new Error("receipt inspector produced no output");
  }
  return formatReceiptInspectorScrollbackLines(model).join("\n");
}
