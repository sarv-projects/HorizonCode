/**
 * G1 Ask/Deny-only wire honesty (rulings **637**, **680**, **716**).
 *
 * Additive `g1:"ask"|"deny"` is always stamped on kernel Guard decisions; frozen
 * `decision:"allow"` on the primary wire field remains the default until
 * `HZ_GUARD_G1_WIRE=1` opts into protocol V2 projection; trusted product runtime
 * defaults it on when unset (ruling **719**). Never shell-net `enforced`.
 */

import type { GuardDecision } from "../contracts";
import { guardG1WireEnabled, guardG1WireEnvUnset } from "./guard-g1-wire";

export const GUARD_G1_WIRE_ENV = "HZ_GUARD_G1_WIRE";

export type GuardG1WireMode = "legacy-allow" | "protocol-v2";

export type GuardG1WireHonesty = {
  mode: GuardG1WireMode;
  /** When true, primary `decision` uses ask/deny (not frozen allow). */
  primaryDecisionProjects: boolean;
  detail: string;
};

export function guardG1WireHonesty(env: NodeJS.ProcessEnv = process.env): GuardG1WireHonesty {
  if (guardG1WireEnabled(env)) {
    return {
      mode: "protocol-v2",
      primaryDecisionProjects: true,
      detail: `${GUARD_G1_WIRE_ENV}=1 — primary Guard wire field projects allow→ask (G1 Ask/Deny-only); raw lease/grant mint + human principal still OPEN`,
    };
  }
  return {
    mode: "legacy-allow",
    primaryDecisionProjects: false,
    detail: guardG1WireEnvUnset(env)
      ? 'env unset — frozen decision:"allow" on the primary wire field for non-trusted/legacy paths; trusted product runtime defaults HZ_GUARD_G1_WIRE=1 (ruling 719); additive g1 always stamped'
      : 'HZ_GUARD_G1_WIRE=0 — legacy primary decision:"allow" retained (additive g1:"ask"|"deny" still stamped)',
  };
}

/** True when additive G1 vocabulary disagrees with the legacy primary field (V2 not active). */
export function guardG1LegacyWireMismatch(decision: GuardDecision): boolean {
  return decision.g1 === "ask" && decision.decision === "allow";
}

/** Once-per-turn notice when admission is G1-shaped but the wire still says allow. */
export function guardG1LegacyWireMismatchNotice(
  decision: GuardDecision,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (guardG1WireEnabled(env)) return undefined;
  if (!guardG1LegacyWireMismatch(decision)) return undefined;
  return (
    'guard G1: kernel stamped g1:"ask" but primary decision remains "allow" (protocol V2 not default-on — ' +
    `set ${GUARD_G1_WIRE_ENV}=1 to project ask on the wire; removing frozen allow is still a breaking protocol change)`
  );
}

/** Session bootstrap line naming default vs opt-in V2 (product honesty). */
export function guardG1WireStartupNotice(env: NodeJS.ProcessEnv = process.env): string {
  const h = guardG1WireHonesty(env);
  if (h.mode === "protocol-v2") {
    return `guard G1 wire: protocol V2 projection active (${GUARD_G1_WIRE_ENV}=1); frozen allow removal + raw lease/grant + human principal remain OPEN`;
  }
  return `guard G1 wire: legacy posture — ${h.detail}`;
}

export function guardG1WireDoctorFixLines(env: Record<string, string | undefined> = process.env): string[] {
  if (guardG1WireEnabled(env as NodeJS.ProcessEnv)) {
    return [
      `# Protocol V2 projection is on — unset ${GUARD_G1_WIRE_ENV} to restore frozen decision:"allow" on the primary wire field`,
    ];
  }
  return [
    "# G1 protocol V2 primary-field projection (additive g1 always stamped):",
    "# trusted product runtime defaults this on when unset (ruling 719); for untrusted/CLI-only:",
    `export ${GUARD_G1_WIRE_ENV}=1`,
    `# legacy primary allow: export ${GUARD_G1_WIRE_ENV}=0`,
  ];
}