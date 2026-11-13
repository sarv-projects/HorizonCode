import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import {
  frozenUnknownResourceKeys,
  mutatingToolResourceKey,
  r170ResourceGateRefusal,
  unknownEffectIdsForResourceKey,
} from "../../src/core/effect-resource-gate";

describe("effect-resource-gate (R170 reduced)", () => {
  const workspace = path.resolve("/tmp/hz-r170-ws");

  test("mutatingToolResourceKey resolves write path", () => {
    const key = mutatingToolResourceKey("write", { path: "src/a.ts" }, workspace);
    expect(key).toBe(path.resolve(workspace, "src/a.ts"));
  });

  test("blocks second write on same path when prior effect unknown", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "b.txt");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, {
      receiptId: "r1",
      receiptSeq: 1,
      resourceKey: resource,
    });
    expect(host.reconcileEffect(effectId)).toBe("unknown");

    const frozen = frozenUnknownResourceKeys(host);
    expect(frozen.has(resource)).toBe(true);

    const refusal = r170ResourceGateRefusal(
      "edit",
      { path: "b.txt" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain(resource);
    expect(refusal).toContain("driving UNKNOWN effect(s)");
    expect(refusal).toContain(effectId.slice(0, 13));
    expect(unknownEffectIdsForResourceKey(host, resource)).toEqual([effectId]);
  });

  test("blocks ast_edit on same path when prior effect unknown (ruling 317)", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "struct.ts");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    const key = mutatingToolResourceKey("ast_edit", { path: "struct.ts", pat: "x", out: "y" }, workspace);
    expect(key).toBe(resource);
    const refusal = r170ResourceGateRefusal(
      "ast_edit",
      { path: "struct.ts", pat: "x", out: "y" },
      workspace,
      frozen,
      host,
    );
    expect(refusal).toContain("blocked_by_unknown");
    expect(refusal).toContain(effectId.slice(0, 13));
  });

  test("allows edit on different path", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    const resource = path.resolve(workspace, "c.txt");
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId);
    host.recordObserve(effectId, { receiptId: "r1", receiptSeq: 1, resourceKey: resource });
    const frozen = frozenUnknownResourceKeys(host);
    expect(
      r170ResourceGateRefusal("write", { path: "other.txt" }, workspace, frozen),
    ).toBeUndefined();
  });
});
