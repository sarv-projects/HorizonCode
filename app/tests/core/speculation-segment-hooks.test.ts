import { describe, expect, test } from "bun:test";
import {
  SpeculativeOperationCoordinator,
  fingerprintCandidate,
  makeCandidate,
  type SpeculativeHookCallbacks,
  type SpeculativeHost,
  type SpeculativeToolCandidate,
} from "../../src/core/speculation";

describe("Speculative execution segment ordering and hook parity", () => {
  test("invokes onCandidateAdmitted, onCandidateCommitted, and onCandidateDiscarded hooks symmetrically", async () => {
    const admitted: string[] = [];
    const committed: string[] = [];
    const discarded: { id: string; reason: string }[] = [];
    let rollbacks: string[][] = [];

    const hooks: SpeculativeHookCallbacks = {
      onCandidateAdmitted(c) {
        admitted.push(c.id);
      },
      onCandidateCommitted(c) {
        committed.push(c.id);
      },
      onCandidateDiscarded(c, reason) {
        discarded.push({ id: c.id, reason });
      },
      onRollback(nodes) {
        rollbacks.push(nodes.map((n) => n.id));
      },
    };

    const host: SpeculativeHost = {
      async run(candidate) {
        return { ok: true, output: `output for ${candidate.id}` };
      },
    };

    const coord = new SpeculativeOperationCoordinator(host, 4, hooks);

    const c1 = makeCandidate({
      id: "call-1",
      name: "read",
      args: { path: "src/a.ts" },
      effect: { kind: "local_read", resources: [{ scheme: "file", path: "/a.ts", access: "read" }] },
    });
    const c2 = makeCandidate({
      id: "call-2",
      name: "read",
      args: { path: "src/b.ts" },
      effect: { kind: "local_read", resources: [{ scheme: "file", path: "/b.ts", access: "read" }] },
    });

    await coord.admit(c1);
    await coord.admit(c2);

    expect(admitted).toEqual(["call-1", "call-2"]);

    // Reconcile keeping call-1, while call-2 has fingerprint mismatch
    const kept = coord.reconcile([
      { id: "call-1", fingerprint: c1.fingerprint },
      { id: "call-2", fingerprint: "different-fingerprint" },
    ]);

    expect(kept).toEqual(["call-1"]);
    expect(committed).toEqual(["call-1"]);
    expect(discarded.length).toBe(1);
    expect(discarded[0]?.id).toBe("call-2");
    expect(discarded[0]?.reason).toBe("fingerprint-mismatch");
    expect(rollbacks.length).toBe(1);
    expect(rollbacks[0]).toEqual(["call-2"]);
  });

  test("reconcileSegments preserves strict FIFO segment order: segment 0 failure cascades to segment 1", async () => {
    const discarded: { id: string; reason: string }[] = [];

    const hooks: SpeculativeHookCallbacks = {
      onCandidateDiscarded(c, reason) {
        discarded.push({ id: c.id, reason });
      },
    };

    const host: SpeculativeHost = {
      async run() {
        return { ok: true, output: "ok" };
      },
    };

    const coord = new SpeculativeOperationCoordinator(host, 4, hooks);

    const seg0_call1 = makeCandidate({
      id: "seg0-1",
      name: "read",
      args: { path: "src/0.ts" },
      effect: { kind: "pure" },
    });
    const seg1_call1 = makeCandidate({
      id: "seg1-1",
      name: "read",
      args: { path: "src/1.ts" },
      effect: { kind: "pure" },
    });

    await coord.admit(seg0_call1);
    await coord.admit(seg1_call1);

    // Segment 0 fails due to fingerprint mismatch. Segment 1 matches its own fingerprint,
    // but should be discarded because segment 0 failed before it!
    const segments = [
      [{ id: "seg0-1", fingerprint: "mismatched-fp" }],
      [{ id: "seg1-1", fingerprint: seg1_call1.fingerprint }],
    ];

    const result = coord.reconcileSegments(segments);
    expect(result.kept).toEqual([]);
    expect(result.discarded).toEqual(["seg0-1", "seg1-1"]);
    expect(coord.outcomeFor("seg1-1")?.state).toBe("discarded");
    expect(coord.outcomeFor("seg1-1")?.discardReason).toBe("dependency-discarded");
  });

  test("reconcileSegments commits all when all segments match in order", async () => {
    const host: SpeculativeHost = {
      async run() {
        return { ok: true, output: "ok" };
      },
    };

    const coord = new SpeculativeOperationCoordinator(host, 4);

    const s0 = makeCandidate({ id: "s0", name: "read", args: {}, effect: { kind: "pure" } });
    const s1 = makeCandidate({ id: "s1", name: "read", args: {}, effect: { kind: "pure" } });

    await coord.admit(s0);
    await coord.admit(s1);

    const segments = [
      [{ id: "s0", fingerprint: s0.fingerprint }],
      [{ id: "s1", fingerprint: s1.fingerprint }],
    ];

    const result = coord.reconcileSegments(segments);
    expect(result.kept).toEqual(["s0", "s1"]);
    expect(result.discarded).toEqual([]);
  });
});
