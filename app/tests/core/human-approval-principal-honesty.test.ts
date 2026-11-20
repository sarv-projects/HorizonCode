import { describe, expect, test } from "bun:test";
import { checkHumanApprovalPrincipalHonesty, doctorFixSuggestion, type DoctorEnv } from "../../src/core/doctor";
import {
  HUMAN_CRYPTO_PRINCIPAL_ENV,
  humanApprovalPrincipalDoctorFixLines,
  humanApprovalPrincipalHonesty,
  humanCryptoPrincipalEnvRequested,
} from "../../src/core/human-approval-principal-honesty";
import { HUMAN_PRINCIPAL_STRICT_ENV } from "../../src/core/human-approval-principal-strict";

const doctorStub = (env: Record<string, string> = {}): DoctorEnv => ({
  env,
  workspace: "/ws",
  home: "/home",
  bunVersion: "1.0.0",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
  kernelBinary: undefined,
  platform: "linux",
});

describe("humanApprovalPrincipalHonesty (ruling 712)", () => {
  test("posture names session-attested stamps and fd-3 Bun parent", () => {
    const h = humanApprovalPrincipalHonesty({});
    expect(h.stampIsSessionAttestedOnly).toBe(true);
    expect(h.cryptographicVerifierAvailable).toBe(false);
    expect(h.detail).toContain("session-attested");
    expect(h.detail).toContain("352");
    expect(h.detail).toContain("parent");
    expect(h.detail).not.toMatch(/cryptographic human identity.*proven/i);
  });

  test("humanCryptoPrincipalEnvRequested", () => {
    expect(humanCryptoPrincipalEnvRequested({})).toBe(false);
    expect(humanCryptoPrincipalEnvRequested({ [HUMAN_CRYPTO_PRINCIPAL_ENV]: "1" })).toBe(true);
    expect(humanCryptoPrincipalEnvRequested({ [HUMAN_CRYPTO_PRINCIPAL_ENV]: "true" })).toBe(true);
  });

  test("doctor warns by default", () => {
    const check = checkHumanApprovalPrincipalHonesty(doctorStub());
    expect(check.id).toBe("guard.human.principal");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("OPEN");
  });

  test("doctor fails when crypto flag set without verifier", () => {
    const check = checkHumanApprovalPrincipalHonesty(
      doctorStub({ [HUMAN_CRYPTO_PRINCIPAL_ENV]: "1" }),
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain(HUMAN_CRYPTO_PRINCIPAL_ENV);
  });

  test("doctor --fix guard.human.principal", () => {
    expect(doctorFixSuggestion("guard.human.principal", {})?.some((l) => l.includes(HUMAN_PRINCIPAL_STRICT_ENV))).toBe(
      true,
    );
    const lines = humanApprovalPrincipalDoctorFixLines({ [HUMAN_CRYPTO_PRINCIPAL_ENV]: "1" });
    expect(lines.some((l) => l.includes("unset"))).toBe(true);
  });

  test("doctor ok when strict mint gate enabled", () => {
    const check = checkHumanApprovalPrincipalHonesty(
      doctorStub({ [HUMAN_PRINCIPAL_STRICT_ENV]: "1" }),
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toContain(HUMAN_PRINCIPAL_STRICT_ENV);
  });
});