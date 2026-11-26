import { describe, expect, test } from "bun:test";
import {
  verifyIdentityWithMonotonicAnchor,
  type ProcessIdentity,
  type BootProcReaders,
} from "../../src/core/worker-identity";

describe("verifyIdentityWithMonotonicAnchor (ruling 881)", () => {
  test("returns ok:false when identity is absent or malformed", () => {
    const ctx = {
      recordedMonotonicNs: 1_000_000_000n,
      recordedWallMs: 1_000_000,
    };
    expect(verifyIdentityWithMonotonicAnchor(null, ctx)).toEqual({
      ok: false,
      reason: "no identity recorded",
    });
    expect(
      verifyIdentityWithMonotonicAnchor({ pid: -1, startTicks: 100 }, ctx),
    ).toEqual({
      ok: false,
      reason: "malformed identity",
    });
  });

  test("handles boot anchor mismatches fail-closed", () => {
    const identity: ProcessIdentity = {
      pid: 1234,
      startTicks: 5678,
      bootId: "boot_old",
    };
    const readers: BootProcReaders = {
      readStat: () => "btime 1700000000\n",
      readBootId: () => "boot_new",
    };
    const ctx = {
      recordedMonotonicNs: 1_000_000_000n,
      recordedWallMs: 1_000_000,
    };
    const res = verifyIdentityWithMonotonicAnchor(identity, ctx, readers);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("boot changed");
  });

  test("returns unavailable when boot anchor is expected but unreadable", () => {
    const identity: ProcessIdentity = {
      pid: 1234,
      startTicks: 5678,
      bootId: "boot_old",
    };
    const readers: BootProcReaders = {
      readStat: () => undefined,
      readBootId: () => undefined,
    };
    const ctx = {
      recordedMonotonicNs: 1_000_000_000n,
      recordedWallMs: 1_000_000,
    };
    const res = verifyIdentityWithMonotonicAnchor(identity, ctx, readers);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("boot anchor unavailable");
  });
});
