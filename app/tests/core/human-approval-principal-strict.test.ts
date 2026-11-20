import { describe, expect, test } from "bun:test";
import {
  assertHumanApprovalPathAttestationForMint,
  HUMAN_PRINCIPAL_STRICT_ENV,
  humanPrincipalStrictEnabled,
} from "../../src/core/human-approval-principal-strict";
import { HUMAN_APPROVAL_PRINCIPAL } from "../../src/contracts";

describe("humanPrincipalStrictEnabled (ruling 717)", () => {
  test("off by default", () => {
    expect(humanPrincipalStrictEnabled({})).toBe(false);
    expect(humanPrincipalStrictEnabled({ [HUMAN_PRINCIPAL_STRICT_ENV]: "0" })).toBe(false);
  });

  test("on for 1/true/yes", () => {
    expect(humanPrincipalStrictEnabled({ [HUMAN_PRINCIPAL_STRICT_ENV]: "1" })).toBe(true);
    expect(humanPrincipalStrictEnabled({ [HUMAN_PRINCIPAL_STRICT_ENV]: "true" })).toBe(true);
    expect(humanPrincipalStrictEnabled({ [HUMAN_PRINCIPAL_STRICT_ENV]: "yes" })).toBe(true);
  });
});

describe("assertHumanApprovalPathAttestationForMint", () => {
  test("strict off allows raw mint opts", () => {
    expect(() => assertHumanApprovalPathAttestationForMint(undefined, {})).not.toThrow();
  });

  test("strict on refuses without human principal", () => {
    expect(() =>
      assertHumanApprovalPathAttestationForMint(undefined, { [HUMAN_PRINCIPAL_STRICT_ENV]: "1" }),
    ).toThrow(/approval-path attestation/);
    expect(() =>
      assertHumanApprovalPathAttestationForMint({ principal: "model" }, { [HUMAN_PRINCIPAL_STRICT_ENV]: "1" }),
    ).toThrow(/352/);
  });

  test("strict on allows human principal stamp", () => {
    expect(() =>
      assertHumanApprovalPathAttestationForMint(
        { principal: HUMAN_APPROVAL_PRINCIPAL },
        { [HUMAN_PRINCIPAL_STRICT_ENV]: "1" },
      ),
    ).not.toThrow();
  });
});