/**
 * Doctor honesty for R172 receipt issuer / keyed attestation (ruling **725**).
 */

import { existsSync, readFileSync } from "node:fs";
import type { Receipt } from "../contracts";
import { loadReceiptIssuerKeySync, verifyParentReceiptIssuerStamps } from "./receipt-issuer-verify";
import { hashReceiptVersioned } from "./receipt-schema";
import { kernelStateDir } from "./paths";
import { receiptsPath } from "./session-kernel-reconcile";

export type ReceiptIssuerDoctorPosture = {
  nestedLinkClaims: number;
  keyPresent: boolean;
  attestationOk: boolean;
  detail: string;
};

function readReceiptRows(workspace: string): Receipt[] | { refusal: string } {
  const file = receiptsPath(workspace);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { refusal: err instanceof Error ? err.message : String(err) };
  }
  const rows: Receipt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as Receipt);
    } catch {
      return { refusal: "receipts.jsonl contains malformed JSON" };
    }
  }
  return rows;
}

export function assessReceiptIssuerDoctorPosture(workspace: string): ReceiptIssuerDoctorPosture {
  const rows = readReceiptRows(workspace);
  if ("refusal" in rows) {
    return {
      nestedLinkClaims: 0,
      keyPresent: existsSync(`${kernelStateDir(workspace)}/.receipt-issuer.key`),
      attestationOk: false,
      detail: rows.refusal,
    };
  }
  const nestedLinkClaims = rows.filter(
    (r) => typeof r.parentReceiptId === "string" && r.parentReceiptId.trim() !== "",
  ).length;
  const keyPresent = loadReceiptIssuerKeySync(workspace) !== undefined;
  if (nestedLinkClaims === 0) {
    return {
      nestedLinkClaims: 0,
      keyPresent,
      attestationOk: true,
      detail: keyPresent
        ? "no parentReceiptId claims; issuer key present for future nested mint"
        : "no parentReceiptId claims; issuer key not created yet (product kernel mint only)",
    };
  }
  if (!keyPresent) {
    return {
      nestedLinkClaims,
      keyPresent: false,
      attestationOk: false,
      detail: `${nestedLinkClaims} receipt(s) declare parentReceiptId but .receipt-issuer.key is absent — cannot attest nested links`,
    };
  }
  // Light stamp check without full chain verify (doctor is advisory).
  for (const row of rows) {
    if (typeof row.parentReceiptId !== "string" || row.parentReceiptId === "") continue;
    try {
      hashReceiptVersioned(row as unknown as Record<string, unknown>);
    } catch {
      return {
        nestedLinkClaims,
        keyPresent: true,
        attestationOk: false,
        detail: "nested parentReceiptId receipt has invalid v2 shape",
      };
    }
  }
  const verdict = verifyParentReceiptIssuerStamps(rows, { workspace });
  const attestationOk = verdict.ok;
  const detail = attestationOk
    ? `${nestedLinkClaims} nested parentReceiptId claim(s); issuer stamps verify against kernel key`
    : verdict.ok === false
      ? verdict.reason
      : "issuer attestation refused";
  return { nestedLinkClaims, keyPresent: true, attestationOk, detail };
}

export function formatReceiptIssuerDoctorDetail(posture: ReceiptIssuerDoctorPosture): string {
  const residual =
    "human issuer principal + universal attestation remain OPEN (R172); never shell-net enforced";
  return `${posture.detail}; ${residual}`;
}