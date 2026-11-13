/**
 * TLS MITM honesty (docs/33 §5.2 — never fake enforcement).
 *
 * HorizonCode does not terminate TLS in shell children. Optional CONNECT
 * forward (`HZ_EGRESS_FORWARD=1`) pipes TCP bytes without inspecting TLS.
 * Doctor line `egress.tls` must stay advisory/unavailable — never `enforced`.
 */

import { egressForwardEnabled } from "./egress-connect-proxy";
import { egressProxyFromEnv } from "./egress-env";
import { egressTlsTerminateEnabled } from "./egress-tls-intercept-ca";
import { egressTlsInterceptCaConfigured, egressTlsInterceptEnabled } from "./egress-tls-intercept";
import { egressTlsPeekEnabled } from "./egress-tls-peek";

export type TlsMitmHonesty = "unavailable" | "advisory";

export interface TlsMitmPosture {
  honesty: TlsMitmHonesty;
  /** True when loopback CONNECT may forward allowed tunnels (still no TLS terminate). */
  connectForward: boolean;
  /** True when HZ_EGRESS_TLS_PEEK=1 may log ClientHello SNI (read-only; not intercept). */
  tlsPeek: boolean;
  /** True when HZ_EGRESS_TLS_INTERCEPT=1 arms the intercept stub (never enforced). */
  tlsIntercept: boolean;
  /** True when HZ_EGRESS_TLS_INTERCEPT_CA is set (hermetic test stub only). */
  tlsInterceptCa: boolean;
  /** True when HZ_EGRESS_TLS_TERMINATE=1 with loadable intercept CA (hermetic precursor). */
  tlsTerminate: boolean;
  proxyEnvSet: boolean;
  detail: string;
}

export function tlsMitmPosture(env: Record<string, string | undefined>): TlsMitmPosture {
  const connectForward = egressForwardEnabled(env);
  const tlsPeek = connectForward && egressTlsPeekEnabled(env);
  const tlsIntercept = egressTlsInterceptEnabled(env);
  const tlsInterceptCa = tlsIntercept && egressTlsInterceptCaConfigured(env);
  const tlsTerminate = tlsInterceptCa && egressTlsTerminateEnabled(env);
  const proxyEnvSet = egressProxyFromEnv(env) !== undefined;
  if (connectForward) {
    const peekNote = tlsPeek
      ? "HZ_EGRESS_TLS_PEEK=1 may log ClientHello SNI on forward (peek only — no decrypt or MITM)"
      : "optional HZ_EGRESS_TLS_PEEK=1 logs SNI from ClientHello without decrypt (TS + kernel parser parity)";
  const interceptNote = !tlsIntercept
      ? "HZ_EGRESS_TLS_INTERCEPT unset: no terminate/re-encrypt stub"
      : tlsTerminate
        ? "HZ_EGRESS_TLS_TERMINATE=1: CONNECT terminates client TLS and may pipe to TLS upstream (HZ_EGRESS_FORWARD=1) — still advisory"
        : tlsInterceptCa
          ? "HZ_EGRESS_TLS_INTERCEPT_CA loadable: CONNECT refuses until HZ_EGRESS_TLS_TERMINATE=1 — still advisory"
          : "HZ_EGRESS_TLS_INTERCEPT=1 without CA material: intercept stub unavailable (peek/passthrough only)";
    return {
      honesty: "advisory",
      connectForward: true,
      tlsPeek,
      tlsIntercept,
      tlsInterceptCa,
      tlsTerminate,
      proxyEnvSet,
      detail:
        "HZ_EGRESS_FORWARD=1: allowed CONNECT tunnels are TCP byte-forward only (TLS not terminated); " +
        `${peekNote}; ${interceptNote}; shell-net confinement is not proven`,
    };
  }
  const proxyNote = proxyEnvSet
    ? "HZ_EGRESS_PROXY sets child proxy env only (advisory); no TLS intercept"
    : "no TLS intercept proxy in this build";
  const interceptNote = tlsIntercept
    ? tlsInterceptCa
      ? "intercept stub CA configured (tests only)"
      : "HZ_EGRESS_TLS_INTERCEPT=1 without CA — intercept unavailable"
    : "intercept stub off";
  return {
    honesty: "unavailable",
    connectForward: false,
    tlsPeek: false,
    tlsIntercept,
    tlsInterceptCa,
    tlsTerminate,
    proxyEnvSet,
    detail: `${proxyNote}; ${interceptNote}; CONNECT decider/stub are routing hints only — never claim shell TLS MITM enforced`,
  };
}
