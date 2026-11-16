/**
 * D-3 / ruling 473: boot-id birth tokens when `/proc/stat` btime is available.
 */

import { describe, expect, test } from "bun:test";
import {
  birthIdentityOf,
  identityFromBirth,
  readBootBtime,
  readKernelBootId,
  recordIdentity,
  resolveBootAnchor,
  verifyIdentity,
  type BootProcReaders,
  type ProcessIdentity,
} from "../../src/core/worker-identity";

const readers = (stat: string | undefined, bootId: string | undefined): BootProcReaders => ({
  readStat: () => stat,
  readBootId: () => bootId,
});

describe("boot-id birth tokens (D-3 / ruling 473)", () => {
  test("resolveBootAnchor prefers kernel boot_id when btime is present", () => {
    const anchor = resolveBootAnchor(readers("cpu 1\nbtime 1700000000\n", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    expect(anchor).toEqual({
      bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      btime: 1700000000,
    });
  });

  test("resolveBootAnchor falls back to decimal btime when boot_id is absent", () => {
    expect(resolveBootAnchor(readers("btime 1700000001\n", undefined))).toEqual({
      bootId: "1700000001",
      btime: 1700000001,
    });
  });

  test("resolveBootAnchor is undefined when btime is missing (no boot-anchored token)", () => {
    expect(resolveBootAnchor(readers("cpu 1 2 3\n", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))).toBeUndefined();
    expect(resolveBootAnchor(readers(undefined, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))).toBeUndefined();
    expect(readBootBtime(readers("intr 1\n", undefined))).toBeUndefined();
  });

  test("birthIdentityOf emits boot:<bootId>:<pid>@<startTicks>; legacy form without bootId", () => {
    const anchored: ProcessIdentity = {
      pid: 42,
      startTicks: 99,
      bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    expect(birthIdentityOf(anchored)).toBe("boot:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:42@99");
    expect(identityFromBirth(birthIdentityOf(anchored))).toEqual(anchored);

    const legacy: ProcessIdentity = { pid: 7, startTicks: 11 };
    expect(birthIdentityOf(legacy)).toBe("7@11");
    expect(identityFromBirth("7@11")).toEqual(legacy);
  });

  test("identityFromBirth refuses malformed boot tokens", () => {
    expect(identityFromBirth("boot::1@2")).toBeUndefined();
    expect(identityFromBirth("boot:has:colon:1@2")).toBeUndefined();
    expect(identityFromBirth("boot:abc:0@2")).toBeUndefined();
    expect(identityFromBirth("boot:abc:1@0")).toBeUndefined();
  });

  test("verifyIdentity refuses a boot-id mismatch; accepts matching boot", () => {
    const identity: ProcessIdentity = {
      pid: process.pid,
      startTicks: 1,
      bootId: "boot-A",
    };
    const mismatch = verifyIdentity(identity, readers("btime 100\n", "boot-B"));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toContain("boot changed");

    // Matching boot still requires a live /proc startTicks match — forge startTicks
    // from the real process so the boot check is the only new surface under test.
    const live = recordIdentity(process.pid, readers("btime 100\n", "boot-A"));
    expect(live?.bootId).toBe("boot-A");
    if (live === undefined) throw new Error("expected live identity");
    expect(verifyIdentity(live, readers("btime 100\n", "boot-A")).ok).toBe(true);
    expect(verifyIdentity({ ...live, bootId: "boot-other" }, readers("btime 100\n", "boot-A")).ok).toBe(false);
  });

  test("live Linux: btime gate yields boot-anchored birth token that round-trips", () => {
    if (process.platform === "win32") return;
    const btime = readBootBtime();
    if (btime === undefined) {
      // Non-Linux /proc hosts: no boot-anchored token is the documented residual.
      expect(resolveBootAnchor()).toBeUndefined();
      return;
    }
    const identity = recordIdentity(process.pid);
    expect(identity).toBeDefined();
    expect(identity?.bootId).toBeDefined();
    const token = birthIdentityOf(identity);
    expect(token).toMatch(/^boot:[^:]+:\d+@\d+$/);
    expect(identityFromBirth(token)).toEqual(identity);
    expect(verifyIdentity(identity).ok).toBe(true);

    const kernelId = readKernelBootId();
    if (kernelId !== undefined) {
      expect(identity?.bootId).toBe(kernelId);
    } else {
      expect(identity?.bootId).toBe(String(btime));
    }
  });
});
