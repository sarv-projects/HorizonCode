import { describe, expect, test } from "bun:test";
import {
  checkGuardG1WireHonesty,
  doctorFixSuggestion,
  type DoctorEnv,
} from "../../src/core/doctor";
import {
  guardG1LegacyWireMismatch,
  guardG1LegacyWireMismatchNotice,
  guardG1WireDoctorFixLines,
  guardG1WireHonesty,
  guardG1WireStartupNotice,
  GUARD_G1_WIRE_ENV,
} from "../../src/core/guard-g1-wire-honesty";

const doctorStub = (env: Record<string, string> = {}): DoctorEnv => ({
  env,
  workspace: "/ws",
  home: "/home",
  bunVersion: "1.0.0",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
  kernelBinary: undefined,
});

describe("guardG1WireHonesty (G1 / ruling 716)", () => {
  test("default legacy allow posture", () => {
    const h = guardG1WireHonesty({});
    expect(h.mode).toBe("legacy-allow");
    expect(h.primaryDecisionProjects).toBe(false);
    expect(h.detail).toContain("allow");
  });

  test("opt-in V2 posture", () => {
    const h = guardG1WireHonesty({ [GUARD_G1_WIRE_ENV]: "1" });
    expect(h.mode).toBe("protocol-v2");
    expect(h.primaryDecisionProjects).toBe(true);
  });

  test("legacy mismatch notice only when g1 ask + decision allow", () => {
    expect(
      guardG1LegacyWireMismatch({ decision: "allow", g1: "ask", leaseId: "l1" }),
    ).toBe(true);
    expect(
      guardG1LegacyWireMismatchNotice({ decision: "allow", g1: "ask", leaseId: "l1" }, {}),
    ).toContain("protocol V2 not default");
    expect(
      guardG1LegacyWireMismatchNotice({ decision: "ask", g1: "ask", leaseId: "l1" }, {}),
    ).toBeUndefined();
    expect(
      guardG1LegacyWireMismatchNotice(
        { decision: "allow", g1: "ask", leaseId: "l1" },
        { [GUARD_G1_WIRE_ENV]: "1" },
      ),
    ).toBeUndefined();
  });

  test("startup notice names legacy vs V2", () => {
    expect(guardG1WireStartupNotice({})).toContain("legacy posture");
    expect(guardG1WireStartupNotice({ [GUARD_G1_WIRE_ENV]: "1" })).toContain("protocol V2");
  });

  test("doctor: default WARN without kernel, V2 OK when pinned binary", () => {
    expect(checkGuardG1WireHonesty(doctorStub()).status).toBe("warn");
    expect(checkGuardG1WireHonesty(doctorStub()).id).toBe("guard.g1.wire");
    expect(checkGuardG1WireHonesty(doctorStub({ [GUARD_G1_WIRE_ENV]: "1" })).status).toBe("ok");
  });

  test("doctor: projects trusted product default-on (ruling 719)", () => {
    const kernelBin = process.execPath;
    const check = checkGuardG1WireHonesty({
      ...doctorStub(),
      kernelBinary: kernelBin,
      env: { HZ_KERNEL_PIN: "off" },
    } as DoctorEnv);
    expect(check.status).toBe("ok");
    expect(check.id).toBe("guard.g1.wire");
  });

  test("doctor --fix export lines", () => {
    expect(guardG1WireDoctorFixLines({})).toContain(`export ${GUARD_G1_WIRE_ENV}=1`);
    expect(doctorFixSuggestion("guard.g1.wire", {})).toEqual(guardG1WireDoctorFixLines({}));
  });
});