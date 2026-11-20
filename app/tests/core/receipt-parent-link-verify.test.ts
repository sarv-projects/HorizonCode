/**
 * Ruling 657 — parentReceiptId mutual-link verify + v2 hash binding.
 */

import { describe, expect, test } from "bun:test";
import type { Receipt } from "../../src/contracts";
import {
  createReceiptForHash,
  hashReceiptVersioned,
  issueReceiptSchemaVersion,
  receiptSchemaVersion,
} from "../../src/core/receipt-schema";
import {
  verifyParentReceiptLink,
  verifyParentReceiptLinksInSnapshot,
} from "../../src/core/receipt-parent-link-verify";

function baseReceipt(partial: Partial<Receipt> & Pick<Receipt, "id" | "effectId">): Receipt {
  return {
    id: partial.id,
    seq: partial.seq ?? 1,
    ts: partial.ts ?? "2026-11-19T00:00:00Z",
    action: "tool.execute",
    tool: "write",
    argsDigest: "a",
    resultDigest: "b",
    prevHash: null,
    hash: partial.hash ?? "0".repeat(64),
    schemaVersion: 2,
    effectId: partial.effectId,
    ...(partial.childEffectIds !== undefined ? { childEffectIds: partial.childEffectIds } : {}),
    ...(partial.parentReceiptId !== undefined ? { parentReceiptId: partial.parentReceiptId } : {}),
  };
}

describe("receipt parentReceiptId (ruling 657)", () => {
  test("schema binds parentReceiptId into v2 hash", () => {
    expect(issueReceiptSchemaVersion({ action: "t", tool: "w", argsDigest: "a", resultDigest: "b", parentReceiptId: "rcp_parent" })).toBe(2);
    const base = {
      id: "r1",
      seq: 1,
      ts: "2026-11-19T00:00:00Z",
      action: "tool.execute",
      tool: "write",
      argsDigest: "a",
      resultDigest: "b",
      prevHash: null as string | null,
    };
    const withParent = createReceiptForHash(
      { action: "tool.execute", tool: "write", argsDigest: "a", resultDigest: "b", parentReceiptId: "rcp_p" },
      base,
    );
    expect(withParent.parentReceiptId).toBe("rcp_p");
    expect(withParent.schemaVersion).toBe(2);
    const h1 = hashReceiptVersioned(withParent as Record<string, unknown>);
    const forged = { ...withParent, parentReceiptId: "rcp_other" };
    expect(hashReceiptVersioned(forged as Record<string, unknown>)).not.toBe(h1);
    expect(() => receiptSchemaVersion({ ...withParent, parentReceiptId: "" })).toThrow(/parentReceiptId/);
  });

  test("mutual link ok when parent lists child effectId", () => {
    const parent = baseReceipt({ id: "rcp_p", effectId: "parent-fx", childEffectIds: ["child-fx"] });
    const child = baseReceipt({ id: "rcp_c", effectId: "child-fx", parentReceiptId: "rcp_p" });
    const byId = new Map([
      [parent.id, parent],
      [child.id, child],
    ]);
    expect(verifyParentReceiptLink(child, byId)).toEqual({ ok: true });
    expect(verifyParentReceiptLinksInSnapshot([parent, child])).toEqual({ ok: true });
  });

  test("refuses missing parent, unbound parent, and missing childEffectIds entry", () => {
    const child = baseReceipt({ id: "rcp_c", effectId: "child-fx", parentReceiptId: "rcp_missing" });
    expect(verifyParentReceiptLink(child, new Map()).ok).toBe(false);

    const v1Parent = { ...baseReceipt({ id: "rcp_p", effectId: "p" }), schemaVersion: undefined };
    delete (v1Parent as { schemaVersion?: number }).schemaVersion;
    const child2 = baseReceipt({ id: "rcp_c2", effectId: "child-fx", parentReceiptId: "rcp_p" });
    expect(verifyParentReceiptLink(child2, new Map([["rcp_p", v1Parent as Receipt]])).ok).toBe(false);

    const parentNoList = baseReceipt({ id: "rcp_p", effectId: "p" });
    expect(verifyParentReceiptLink(child2, new Map([["rcp_p", parentNoList]])).ok).toBe(false);

    const parentWrong = baseReceipt({ id: "rcp_p", effectId: "p", childEffectIds: ["other"] });
    expect(verifyParentReceiptLink(child2, new Map([["rcp_p", parentWrong]])).ok).toBe(false);
  });
});
