/**
 * Opt-in refusal of raw lease/grant mint without approval-path attestation (rulings **717**, **720**).
 *
 * `HZ_HUMAN_PRINCIPAL_STRICT=1` requires `principal:"human"` on product `makeLease` /
 * `makeGrant` — the same stamp TUI/runtime approval paths use via
 * `mintHumanApprovalLease` / `mintHumanApprovalGrant`. fd-3 (**352**) still proves the
 * controlling Bun parent only, not a human. When set, the trusted kernel also refuses
 * fd-3 parent-minted RPCs without principal:"human" (ruling **720**).
 *
 * Never shell-net `enforced`.
 */

import { HUMAN_APPROVAL_PRINCIPAL } from "../contracts";

export const HUMAN_PRINCIPAL_STRICT_ENV = "HZ_HUMAN_PRINCIPAL_STRICT";

export function humanPrincipalStrictEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[HUMAN_PRINCIPAL_STRICT_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Product-layer gate: refuse non-human-attested mint when strict is on. */
export function assertHumanApprovalPathAttestationForMint(
  opts: { principal?: typeof HUMAN_APPROVAL_PRINCIPAL | string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!humanPrincipalStrictEnabled(env)) return;
  if (opts?.principal === HUMAN_APPROVAL_PRINCIPAL) return;
  throw new Error(
    `${HUMAN_PRINCIPAL_STRICT_ENV}=1 refuses raw guard.lease/guard.grant mint without approval-path attestation ` +
      `(principal:"${HUMAN_APPROVAL_PRINCIPAL}"); fd-3 proves Bun parent only (ruling 352) — cryptographic human identity remains OPEN`,
  );
}