/**
 * Human approval principal honesty (rulings **682**, **712**, **717**, **720**).
 *
 * `principal:"human"` on held leases/grants is session-attested approval-path
 * attribution — not cryptographic human identity. fd-3 / ruling **352** proves
 * the controlling Bun parent for mint RPCs only; raw lease/grant without that
 * channel is still refused.
 *
 * Never shell-net `enforced`.
 */

import { HUMAN_APPROVAL_PRINCIPAL, PARENT_CONTROL_PRINCIPAL } from "../contracts";
import { HUMAN_PRINCIPAL_STRICT_ENV, humanPrincipalStrictEnabled } from "./human-approval-principal-strict";

/** Opt-in flag that would request cryptographic human principal verification (no verifier shipped). */
export const HUMAN_CRYPTO_PRINCIPAL_ENV = "HZ_HUMAN_CRYPTO_PRINCIPAL";

export type HumanApprovalPrincipalHonesty = {
  /** When true, a product verifier could back HZ_HUMAN_CRYPTO_PRINCIPAL (not implemented). */
  cryptographicVerifierAvailable: boolean;
  /** When true, product makeLease/makeGrant require principal:"human" (Bun layer only). */
  strictMintGateEnabled: boolean;
  /** principal:"human" stamps are session-attested attribution only. */
  stampIsSessionAttestedOnly: true;
  detail: string;
};

export function humanCryptoPrincipalEnvRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HUMAN_CRYPTO_PRINCIPAL_ENV];
  return raw === "1" || raw === "true";
}

/** Reserved for a future verifier hook — always false until one ships. */
export function humanCryptographicPrincipalVerifierAvailable(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export function humanApprovalPrincipalHonesty(env: NodeJS.ProcessEnv = process.env): HumanApprovalPrincipalHonesty {
  const verifier = humanCryptographicPrincipalVerifierAvailable(env);
  const strict = humanPrincipalStrictEnabled(env);
  const base =
    `${HUMAN_APPROVAL_PRINCIPAL} stamps are session-attested approval attribution only (owner human:<sessionId>); ` +
    "fd-3 parent credential (ruling 352) proves controlling Bun parent for mint — not a human; " +
    "raw guard.lease/grant mint without control channel still refused";
  const strictNote = strict
    ? `; ${HUMAN_PRINCIPAL_STRICT_ENV}=1 refuses raw mint without principal:"${HUMAN_APPROVAL_PRINCIPAL}" on Bun and trusted kernel (fd-3 parent mints stamp principal:"${PARENT_CONTROL_PRINCIPAL}" when not strict)`
    : `; trusted-kernel fd-3 parent mints stamp principal:"${PARENT_CONTROL_PRINCIPAL}" (not human) unless approval-path principal:"${HUMAN_APPROVAL_PRINCIPAL}"`;

  if (humanCryptoPrincipalEnvRequested(env) && !verifier) {
    return {
      cryptographicVerifierAvailable: false,
      strictMintGateEnabled: strict,
      stampIsSessionAttestedOnly: true,
      detail: `${HUMAN_CRYPTO_PRINCIPAL_ENV} is set but no cryptographic human-principal verifier is available — ${base}${strictNote}`,
    };
  }

  return {
    cryptographicVerifierAvailable: verifier,
    strictMintGateEnabled: strict,
    stampIsSessionAttestedOnly: true,
    detail: `${base}${strictNote}`,
  };
}

export function humanApprovalPrincipalDoctorFixLines(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const procEnv = env as NodeJS.ProcessEnv;
  if (humanCryptoPrincipalEnvRequested(procEnv)) {
    return [
      `# Cryptographic human principal is not implemented — unset the misleading flag:`,
      `unset ${HUMAN_CRYPTO_PRINCIPAL_ENV}`,
    ];
  }
  if (humanPrincipalStrictEnabled(procEnv)) {
    return [
      `# Strict mint gate is on — unset to allow product-layer raw mint (cryptographic human identity still OPEN):`,
      `unset ${HUMAN_PRINCIPAL_STRICT_ENV}`,
    ];
  }
  return [
    "# Opt in to refuse product-layer raw lease/grant mint without approval-path principal:",
    `export ${HUMAN_PRINCIPAL_STRICT_ENV}=1`,
    `# principal:"${HUMAN_APPROVAL_PRINCIPAL}" is attribution only — does not prove cryptographic human identity`,
  ];
}