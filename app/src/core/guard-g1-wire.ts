import type { GuardDecision, GuardDecisionValue, GuardG1Decision } from "../contracts";

/** G1 Ask/Deny-only projection (ruling 637): frozen `allow` → `ask`. */
export function guardG1Decision(decision: GuardDecisionValue): GuardG1Decision {
  return decision === "deny" ? "deny" : "ask";
}

/** True when the operator has not set `HZ_GUARD_G1_WIRE` (empty/unset only). */
export function guardG1WireEnvUnset(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_GUARD_G1_WIRE;
  return raw === undefined || raw.trim() === "";
}

/** Explicit legacy wire opt-out (`HZ_GUARD_G1_WIRE=0` / false / off). */
export function guardG1WireExplicitOff(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.HZ_GUARD_G1_WIRE?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/** Opt-in protocol V2: primary `decision` wire field projects through G1 (ruling 637 residual). */
export function guardG1WireEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.HZ_GUARD_G1_WIRE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export type ApplyProductGuardG1WireResult = {
  applied?: "product-default";
  notice?: string;
};

/**
 * Trusted-kernel product path (ruling **719**): when env is unset, default
 * `HZ_GUARD_G1_WIRE=1` so primary-field decisions project ask/deny (TS layer
 * always re-stamps via `applyGuardG1Wire`). Explicit env wins; `=0` keeps legacy allow.
 */
export function applyProductGuardG1WireDefault(
  env: Record<string, string | undefined>,
  opts: { kernelTrusted: boolean },
): ApplyProductGuardG1WireResult {
  if (!opts.kernelTrusted) return {};
  if (!guardG1WireEnvUnset(env)) return {};
  env.HZ_GUARD_G1_WIRE = "1";
  return {
    applied: "product-default",
    notice:
      "[guard.g1.wire] HZ_GUARD_G1_WIRE=1 (runtime: trusted Rust kernel + env unset — G1 protocol V2 primary-field projection; " +
      "frozen `allow` removal + raw lease/grant mint still OPEN; set HZ_GUARD_G1_WIRE=0 for legacy primary allow)",
  };
}

/** Doctor projection when trusted kernel would default-on in `createRuntime`. */
export function projectProductGuardG1WireDoctorEnv(
  env: Record<string, string | undefined>,
  kernelTrusted: boolean,
): Record<string, string | undefined> {
  if (!kernelTrusted || !guardG1WireEnvUnset(env)) return env;
  return { ...env, HZ_GUARD_G1_WIRE: "1" };
}

/** Stamp additive `g1` and optionally project `decision` for HZ_GUARD_G1_WIRE=1 clients. */
export function applyGuardG1Wire(decision: GuardDecision, env: NodeJS.ProcessEnv = process.env): GuardDecision {
  const g1 = guardG1Decision(decision.decision);
  const stamped: GuardDecision = { ...decision, g1 };
  if (guardG1WireEnabled(env)) {
    return { ...stamped, decision: g1 };
  }
  return stamped;
}

/**
 * Internal admission: true when the kernel admitted the action (legacy `allow`
 * or G1 V2 wire `ask` with a minted/consumed lease citation).
 */
export function guardEffectivelyAllows(decision: GuardDecision): boolean {
  if (decision.decision === "allow") return true;
  if (decision.decision === "ask" && decision.leaseId !== undefined && decision.leaseId !== "") return true;
  return false;
}