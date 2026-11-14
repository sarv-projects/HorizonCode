/**
 * Receipt schema 2: additive authenticated sidecar bindings (ruling 361).
 *
 * v1 receipts retain their original frozen preimage and accept older unbound
 * observation fields. New receipts with any effect/postimage/child sidecar use
 * schemaVersion=2 and include every such field in the receipt hash + head
 * anchor. Keep this module separate from contracts.ts's frozen hashReceipt().
 */
import { canonicalJson, sha256Hex, type Receipt, type ReceiptInput } from "../contracts";

const V1_FIELDS = [
  "id", "seq", "ts", "action", "tool", "argsDigest", "resultDigest", "prevHash",
] as const;
const V2_BINDINGS = ["effectId", "postimageDigest", "postimagePath", "childEffectIds"] as const;
const V2_ALLOWED = new Set<string>([...V1_FIELDS, ...V2_BINDINGS, "leaseId", "schemaVersion", "hash"]);

export function issueReceiptSchemaVersion(input: ReceiptInput): 1 | 2 {
  if (input.schemaVersion === 2 || input.effectId !== undefined ||
      input.postimageDigest !== undefined || input.postimagePath !== undefined ||
      input.childEffectIds !== undefined) return 2;
  return 1;
}

export function receiptSchemaVersion(record: Record<string, unknown>): 1 | 2 {
  if (!Object.hasOwn(record, "schemaVersion")) return 1;
  if (record.schemaVersion !== 2) throw new Error("HZ_PRECONDITION_FAILED: unsupported receipt schema version");
  for (const field of Object.keys(record)) {
    if (!V2_ALLOWED.has(field)) {
      throw new Error(`HZ_PRECONDITION_FAILED: unexpected receipt v2 field ${field}`);
    }
  }
  if (record.effectId !== undefined &&
      (typeof record.effectId !== "string" || record.effectId.length === 0)) {
    throw new Error("HZ_PRECONDITION_FAILED: receipt v2 effectId invalid");
  }
  for (const key of ["postimageDigest", "postimagePath"]) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new Error(`HZ_PRECONDITION_FAILED: receipt v2 ${key} must be a string`);
    }
  }
  if (record.childEffectIds !== undefined) {
    const children = record.childEffectIds;
    if (!Array.isArray(children) || children.length > 1_000 ||
        children.some((x) => typeof x !== "string" || x.length === 0) ||
        new Set(children).size !== children.length) {
      throw new Error("HZ_PRECONDITION_FAILED: receipt v2 childEffectIds invalid or duplicate");
    }
  }
  return 2;
}

/** Version-negotiated hash input: source of truth for TS hash walks and anchors.
 * Do NOT use for v1 schema evolution: its legacy byte format is frozen. */
export function receiptPreimageVersioned(record: Record<string, unknown>): Record<string, unknown> {
  const version = receiptSchemaVersion(record);
  const preimage: Record<string, unknown> = {};
  for (const field of V1_FIELDS) preimage[field] = record[field] === undefined ? null : record[field];
  if (record.leaseId !== undefined && record.leaseId !== null) preimage.leaseId = record.leaseId;
  if (version === 2) {
    preimage.schemaVersion = 2;
    for (const key of V2_BINDINGS) {
      if (record[key] !== undefined) preimage[key] = record[key];
    }
  }
  return preimage;
}

export function hashReceiptVersioned(record: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(receiptPreimageVersioned(record)));
}

export function createReceiptForHash(input: ReceiptInput, base: Omit<Receipt, "hash">): Omit<Receipt, "hash"> {
  if (issueReceiptSchemaVersion(input) === 1) return base;
  return {
    ...base,
    schemaVersion: 2,
    ...(input.effectId !== undefined ? { effectId: input.effectId } : {}),
    ...(input.postimageDigest !== undefined ? { postimageDigest: input.postimageDigest } : {}),
    ...(input.postimagePath !== undefined ? { postimagePath: input.postimagePath } : {}),
    ...(input.childEffectIds !== undefined ? { childEffectIds: [...input.childEffectIds] } : {}),
  };
}
