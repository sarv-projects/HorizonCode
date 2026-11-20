import { describe, expect, test } from "bun:test";
import {
  applyGuardG1Wire,
  applyProductGuardG1WireDefault,
  guardG1WireEnvUnset,
  guardG1WireExplicitOff,
  projectProductGuardG1WireDoctorEnv,
} from "../../src/core/guard-g1-wire";
import { guardG1WireStartupNotice } from "../../src/core/guard-g1-wire-honesty";

describe("G1 product default-on (ruling 719)", () => {
  test("applyProductGuardG1WireDefault: trusted + unset sets env", () => {
    const env: Record<string, string | undefined> = {};
    const r = applyProductGuardG1WireDefault(env, { kernelTrusted: true });
    expect(r.applied).toBe("product-default");
    expect(env.HZ_GUARD_G1_WIRE).toBe("1");
    expect(r.notice).toContain("HZ_GUARD_G1_WIRE=1");
  });

  test("applyProductGuardG1WireDefault: untrusted no-op", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyProductGuardG1WireDefault(env, { kernelTrusted: false }).applied).toBeUndefined();
    expect(env.HZ_GUARD_G1_WIRE).toBeUndefined();
  });

  test("applyProductGuardG1WireDefault: explicit off respected", () => {
    const env: Record<string, string | undefined> = { HZ_GUARD_G1_WIRE: "0" };
    expect(guardG1WireExplicitOff(env)).toBe(true);
    expect(guardG1WireEnvUnset(env)).toBe(false);
    applyProductGuardG1WireDefault(env, { kernelTrusted: true });
    expect(env.HZ_GUARD_G1_WIRE).toBe("0");
  });

  test("trusted default-on projects allow off the primary wire", () => {
    const env: Record<string, string | undefined> = {};
    applyProductGuardG1WireDefault(env, { kernelTrusted: true });
    const out = applyGuardG1Wire(
      { decision: "allow", leaseId: "lease-p", reason: "policy allow" },
      env as NodeJS.ProcessEnv,
    );
    expect(out.decision).toBe("ask");
    expect(out.g1).toBe("ask");
  });

  test("doctor env projection mirrors product default", () => {
    const projected = projectProductGuardG1WireDoctorEnv({}, true);
    expect(projected.HZ_GUARD_G1_WIRE).toBe("1");
    expect(projectProductGuardG1WireDoctorEnv({ HZ_GUARD_G1_WIRE: "0" }, true).HZ_GUARD_G1_WIRE).toBe("0");
  });

  test("startup notice names V2 after product default", () => {
    const env: Record<string, string | undefined> = {};
    applyProductGuardG1WireDefault(env, { kernelTrusted: true });
    expect(guardG1WireStartupNotice(env as NodeJS.ProcessEnv)).toContain("protocol V2");
  });
});