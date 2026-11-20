import { describe, expect, test } from "bun:test";
import { checkBootBirthHonesty, type DoctorEnv } from "../../src/core/doctor";
import {
  bootBirthHonesty,
  parseDarwinLstartEpoch,
  readDarwinBoottimeSec,
  readDarwinProcessFacts,
  spawnBirthLedgerNotice,
  DARWIN_START_TICKS_HZ,
} from "../../src/core/boot-birth-honesty";
import { birthIdentityOf, recordIdentity, resolveBootAnchor } from "../../src/core/worker-identity";

const doctorStub = (platform: string): DoctorEnv => ({
  env: {},
  workspace: "/ws",
  home: "/home",
  bunVersion: "1.0.0",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
  kernelBinary: undefined,
  platform,
});

describe("bootBirthHonesty (D-3 / ruling 707)", () => {
  test("linux may claim boot-id gate; darwin never claims boot-id", () => {
    const linux = bootBirthHonesty("linux");
    expect(linux.method).toBe("linux-boot-id");
    expect(linux.birthRecordingAvailable).toBe(true);

    const darwin = bootBirthHonesty("darwin");
    expect(darwin.method).toBe("darwin-lstart");
    expect(darwin.bootIdTokensAvailable).toBe(false);
    expect(darwin.detail).toContain("no boot");

    const win = bootBirthHonesty("win32");
    expect(win.method).toBe("unavailable");
    expect(win.birthRecordingAvailable).toBe(false);
  });

  test("parseDarwinLstartEpoch and boottime sysctl parse", () => {
    expect(parseDarwinLstartEpoch("Thu Nov 19 21:15:30 2025")).toBeGreaterThan(0);
    expect(readDarwinBoottimeSec(() => "{ sec = 1700000000, usec = 0 }\n")).toBe(1700000000);
  });

  test("readDarwinProcessFacts is injectable and never mints boot-id", () => {
    const bootSec = 1_700_000_000;
    const startSec = bootSec + 42;
    const lstart = new Date(startSec * 1000).toString();
    const facts = readDarwinProcessFacts(100, {
      readBoottimeSec: () => bootSec,
      readPs: () => ({ ppid: 1, pgid: 100, lstart }),
    });
    expect(facts).toEqual({ ppid: 1, pgid: 100, startTicks: 42 * DARWIN_START_TICKS_HZ });
  });

  test("recordIdentity never attaches bootId off Linux", () => {
    if (process.platform === "linux") return;
    const bootSec = 1_700_000_000;
    const startSec = bootSec + 10;
    const darwinReaders = {
      readBoottimeSec: () => bootSec,
      readPs: () => ({ ppid: 1, pgid: 100, lstart: new Date(startSec * 1000).toString() }),
    };
    const procReaders = {
      readStat: () => "btime 1700000000\n",
      readBootId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    const identity = recordIdentity(100, procReaders, darwinReaders);
    expect(identity?.bootId).toBeUndefined();
    if (process.platform === "win32") {
      expect(identity).toBeUndefined();
      return;
    }
    expect(birthIdentityOf(identity)).toBe(`100@${10 * DARWIN_START_TICKS_HZ}`);
  });

  test("spawnBirthLedgerNotice refuses boot-id wording on darwin", () => {
    expect(spawnBirthLedgerNotice("darwin", "42@99")).toContain("darwin-lstart");
    expect(spawnBirthLedgerNotice("win32", null)).toContain("unavailable");
    expect(spawnBirthLedgerNotice("linux", "boot:abc:1@2")).toContain("boot-anchored");
  });

  test("doctor warns on win32 and darwin; linux boot-id path warns monotonic residual", () => {
    expect(checkBootBirthHonesty(doctorStub("win32")).status).toBe("warn");
    expect(checkBootBirthHonesty(doctorStub("darwin")).status).toBe("warn");
    expect(checkBootBirthHonesty(doctorStub("darwin")).id).toBe("runtime.birth");
    const linux = checkBootBirthHonesty(doctorStub("linux"));
    expect(linux.status).toBe("warn");
    expect(linux.detail).toMatch(/monotonic|btime|boot-id/i);
  });

  test("live: never claim boot-id on non-Linux when /proc absent", () => {
    if (process.platform === "linux" && resolveBootAnchor() !== undefined) {
      const id = recordIdentity(process.pid);
      expect(id?.bootId).toBeDefined();
      return;
    }
    if (process.platform === "darwin") {
      const id = recordIdentity(process.pid);
      expect(id?.bootId).toBeUndefined();
      return;
    }
    if (process.platform === "win32") {
      expect(recordIdentity(process.pid)).toBeUndefined();
    }
  });
});