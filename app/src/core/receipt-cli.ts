/**
 * receipt-cli.ts — `hzcode receipt show` (R172 reduced; ruling **286**).
 */

import { findReceiptForUnknownTarget } from "./unknown-receipt-lookup";
import { loadEffectLedger } from "./effect-ledger";
import { verifyReceiptChainSync } from "./receipt-chain-verify";
import { buildReceiptInspectorModel, formatReceiptInspectorScrollbackLines } from "../tui/receipt-inspector";
import { metricContract } from "./metrics";

export function inspectReceiptShow(workspace: string, receiptId: string): {
  text: string;
  chainOk: boolean;
} {
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
  return {
    text: formatReceiptInspectorScrollbackLines(model).join("\n"),
    chainOk: chainVerify.ok,
  };
}

export function renderReceiptShow(workspace: string, receiptId: string): string {
  return inspectReceiptShow(workspace, receiptId).text;
}

/** H-7: contracted form of `hzcode receipt show` outcome (ruling 592). */
export function receiptShowPublication(input: { found: boolean; chainOk: boolean }): string[] {
  const anchor = "none — this receipt-show invocation";
  const population = "one receipt lookup plus workspace receipt-chain verify";
  const excludes = "none — scalars are lookup/verify outcomes only";
  return [
    metricContract({
      metric: "receipt show found",
      anchor,
      population,
      excludes,
      value: input.found ? 1 : 0,
    }),
    metricContract({
      metric: "receipt show chain ok",
      anchor,
      population,
      excludes,
      value: input.chainOk ? 1 : 0,
    }),
  ];
}
