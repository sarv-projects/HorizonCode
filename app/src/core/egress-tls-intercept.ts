/**
 * TLS intercept stub honesty (docs/33 §5.2 — never claim enforced).
 *
 * Hermetic test CA + `HZ_EGRESS_TLS_TERMINATE=1` arms terminate precursor (**283**).
 * Without terminate, loadable CA refuses CONNECT forward fail-closed (**281**).
 */

import { egressTlsInterceptCaLoadable } from "./egress-tls-intercept-ca";

export function egressTlsInterceptEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_EGRESS_TLS_INTERCEPT;
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

export function egressTlsInterceptCaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return egressTlsInterceptCaLoadable(env.HZ_EGRESS_TLS_INTERCEPT_CA);
}

export type TlsInterceptStubPosture = "off" | "unavailable" | "advisory-stub";

export function tlsInterceptStubPosture(env: Record<string, string | undefined>): {
  posture: TlsInterceptStubPosture;
  detail: string;
} {
  if (!egressTlsInterceptEnabled(env)) {
    return {
      posture: "off",
      detail: "HZ_EGRESS_TLS_INTERCEPT unset: no terminate/re-encrypt stub",
    };
  }
  if (!egressTlsInterceptCaConfigured(env)) {
    return {
      posture: "unavailable",
      detail:
        "HZ_EGRESS_TLS_INTERCEPT=1 without HZ_EGRESS_TLS_INTERCEPT_CA: true intercept unavailable (no CA material); peek/passthrough only",
    };
  }
  const terminateRaw = env.HZ_EGRESS_TLS_TERMINATE?.trim();
  const terminate = terminateRaw === "1" || terminateRaw?.toLowerCase() === "true";
  return {
    posture: "advisory-stub",
    detail: terminate
      ? "HZ_EGRESS_TLS_TERMINATE=1: CONNECT terminate + optional upstream TLS pipe when forward is on"
      : "HZ_EGRESS_TLS_INTERCEPT_CA loadable: CONNECT refuses fail-closed until HZ_EGRESS_TLS_TERMINATE=1; still advisory",
  };
}
