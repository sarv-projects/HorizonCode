/**
 * R172 / ruling 657 — mutual parentReceiptId to childEffectIds link check
 * against ONE verified receipt snapshot (same honesty as 360 / 456).
 *
 * Does not authenticate an issuer or keyed cross-process attestation.
 */

import type { Receipt } from "../contracts";

export type ParentLinkVerifyOk = { ok: true };
export type ParentLinkVerifyFail = {
  ok: false;
  reason: string;
  childReceiptId?: string;
  parentReceiptId?: string;
};

export type ParentLinkVerifyResult = ParentLinkVerifyOk | ParentLinkVerifyFail;

/**
 * When child carries parentReceiptId, require that parent to exist in the
 * same verified snapshot; if the parent is trusted v2 with childEffectIds,
 * require child.effectId in that set.
 */
export function verifyParentReceiptLink(
  child: Receipt,
  byId: ReadonlyMap<string, Receipt>,
): ParentLinkVerifyResult {
  const parentId = child.parentReceiptId;
  if (parentId === undefined || parentId === "") {
    return { ok: true };
  }
  const parent = byId.get(parentId);
  if (parent === undefined) {
    return {
      ok: false,
      reason: `parentReceiptId ${parentId} missing from verified snapshot`,
      childReceiptId: child.id,
      parentReceiptId: parentId,
    };
  }
  if (parent.schemaVersion !== 2) {
    return {
      ok: false,
      reason: `parentReceiptId ${parentId} is not a trusted v2 receipt (legacy unbound)`,
      childReceiptId: child.id,
      parentReceiptId: parentId,
    };
  }
  const childEffect = child.effectId;
  if (childEffect === undefined || childEffect === "") {
    return {
      ok: false,
      reason: `child receipt ${child.id} lacks effectId required for parent link`,
      childReceiptId: child.id,
      parentReceiptId: parentId,
    };
  }
  const listed = parent.childEffectIds;
  if (listed === undefined) {
    return {
      ok: false,
      reason: `parent ${parentId} has no childEffectIds binding for ${childEffect}`,
      childReceiptId: child.id,
      parentReceiptId: parentId,
    };
  }
  if (!listed.includes(childEffect)) {
    return {
      ok: false,
      reason: `parent ${parentId} childEffectIds does not include child effectId ${childEffect}`,
      childReceiptId: child.id,
      parentReceiptId: parentId,
    };
  }
  return { ok: true };
}

/** Verify every receipt in a verified snapshot that declares parentReceiptId. */
export function verifyParentReceiptLinksInSnapshot(
  receipts: readonly Receipt[],
): ParentLinkVerifyResult {
  const byId = new Map(receipts.map((r) => [r.id, r]));
  for (const receipt of receipts) {
    const result = verifyParentReceiptLink(receipt, byId);
    if (!result.ok) return result;
  }
  return { ok: true };
}
