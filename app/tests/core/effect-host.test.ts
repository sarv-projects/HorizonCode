import { describe, expect, test } from "bun:test";
import { EffectHost, createEffectId } from "../../src/core/effect-host";

describe("effect-host precursor", () => {
  test("reconcile settled after allow, execute, observe", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "write", "call-1");
    host.recordAllow(effectId, { leaseId: "lease-a" });
    host.recordExecute(effectId, { ok: true });
    host.recordObserve(effectId, { receiptId: "rcp-1", receiptSeq: 3, postimageDigest: "abc" });
    expect(host.reconcileEffect(effectId)).toBe("settled");
  });

  test("reconcile unknown when result digest evidence unstable", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "read", "call-d");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true });
    host.recordObserve(effectId, {
      receiptId: "rcp-d",
      receiptSeq: 2,
      resultDigestEvidenceStable: false,
    });
    expect(host.reconcileEffect(effectId)).toBe("unknown");
  });

  test("reconcile unknown when postimage missing at observe", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "write", "call-e");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true });
    host.recordObserve(effectId, {
      receiptId: "rcp-e",
      receiptSeq: 4,
      postimageMissingAtObserve: true,
      resourceKey: "/tmp/missing.txt",
    });
    expect(host.reconcileEffect(effectId)).toBe("unknown");
  });

  test("reconcile unknown when postimage observation unstable", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "write", "call-u");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true });
    host.recordObserve(effectId, {
      receiptId: "rcp-u",
      receiptSeq: 1,
      postimageObservationStable: false,
      resourceKey: "/tmp/x",
    });
    expect(host.reconcileEffect(effectId)).toBe("unknown");
  });

  test("reconcile unknown when observe missing", () => {
    const host = new EffectHost();
    const effectId = createEffectId();
    host.begin(effectId, "read", "call-2");
    host.recordAllow(effectId);
    host.recordExecute(effectId, { ok: true });
    expect(host.reconcileEffect(effectId)).toBe("unknown");
  });

  test("reconcile unknown for unknown effectId", () => {
    expect(new EffectHost().reconcileEffect(createEffectId())).toBe("unknown");
  });
});
