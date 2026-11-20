import { describe, expect, test } from "bun:test";
import { checkOwnerWorkerAncestorHonesty, type DoctorEnv } from "../../src/core/doctor";
import {
  ownerWorkerAncestorHonesty,
  ownerWorkerPipeEnvRequested,
  ownerWorkerSuccessNotice,
  ownerWorkerTurnPreflight,
  readDarwinPpid,
} from "../../src/core/owner-worker-ancestor-honesty";
import { workerIsDescendantOf } from "../../src/core/owner-worker-spawn";

const doctorStub = (platform: string, env: Record<string, string> = {}): DoctorEnv => ({
  env,
  workspace: "/ws",
  home: "/home",
  bunVersion: "1.0.0",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
  kernelBinary: undefined,
  platform,
});

describe("ownerWorkerAncestorHonesty (C-12 / ruling 704)", () => {
  test("linux claims /proc walk", () => {
    const h = ownerWorkerAncestorHonesty("linux");
    expect(h.ancestorProvingAvailable).toBe(true);
    expect(h.method).toBe("linux-proc");
  });

  test("darwin claims reduced ps walk", () => {
    const h = ownerWorkerAncestorHonesty("darwin");
    expect(h.ancestorProvingAvailable).toBe(true);
    expect(h.method).toBe("darwin-ps");
    expect(h.detail).toContain("reduced");
  });

  test("win32 refuses ancestor proof", () => {
    const h = ownerWorkerAncestorHonesty("win32");
    expect(h.ancestorProvingAvailable).toBe(false);
    expect(h.method).toBe("unavailable");
  });

  test("win32 preflight refuses when pipe gate on", () => {
    expect(ownerWorkerTurnPreflight("win32", { HZ_OWNER_WORKER_PIPE: "1" }).ok).toBe(false);
    expect(ownerWorkerTurnPreflight("linux", { HZ_OWNER_WORKER_PIPE: "1" }).ok).toBe(true);
  });

  test("success notice names prove method and does not claim R170 closed", () => {
    expect(ownerWorkerSuccessNotice("linux", 42)).toContain("/proc ancestor-proved");
    expect(ownerWorkerSuccessNotice("darwin", 42)).toContain("reduced");
    expect(ownerWorkerSuccessNotice("linux", 42)).toContain("full R170 still OPEN");
  });

  test("darwin injectable ppid walk matches linux semantics", () => {
    const ppid: Record<number, number> = { 9: 8, 8: 1 };
    const verdict = workerIsDescendantOf(9, 8, {
      platform: "darwin",
      readPpid: (pid) => ppid[pid],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.chain).toEqual([9, 8]);
  });

  test("readDarwinPpid uses injectable ps", () => {
    const out = readDarwinPpid(99, () => "  100\n");
    expect(out).toBe(100);
  });

  test("doctor fails closed when win32 requests pipe", () => {
    const check = checkOwnerWorkerAncestorHonesty(
      doctorStub("win32", { HZ_OWNER_WORKER_PIPE: "1" }),
    );
    expect(check.status).toBe("fail");
    expect(check.id).toBe("owner_worker.ancestor");
  });

  test("doctor warns on darwin when pipe requested", () => {
    const check = checkOwnerWorkerAncestorHonesty(
      doctorStub("darwin", { HZ_OWNER_WORKER_PIPE: "1" }),
    );
    expect(check.status).toBe("warn");
  });

  test("ownerWorkerPipeEnvRequested", () => {
    expect(ownerWorkerPipeEnvRequested({})).toBe(false);
    expect(ownerWorkerPipeEnvRequested({ HZ_OWNER_WORKER_PIPE: "1" })).toBe(true);
  });
});