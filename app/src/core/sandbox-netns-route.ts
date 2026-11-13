/**
 * Netns egress route honesty (docs/33 §5.2; ruling **288**).
 *
 * With `hz-sandbox-exec`, wrapped children get userns+netns (+ Landlock TCP deny)
 * unless `HZ_SANDBOX_CHILD_NET=on`. `HZ_EGRESS_PROXY` / `mergeEgressProxyEnv` set
 * child proxy env only — not shell-net enforced. `HZ_SANDBOX_NETNS=1` documents the
 * same netns posture explicitly and maps to child network-off when unset.
 */

import { egressProxyFromEnv } from "./egress-env";
import { resolveSandboxExecBinary } from "./kernel";
import { sandboxChildNetOffRequested } from "./sandbox-child-net";

export type NetnsEgressRouteKind = "ambient" | "deny-only" | "proxy-env-partial";

export interface NetnsEgressRoutePosture {
  route: NetnsEgressRouteKind;
  netnsIsolationExpected: boolean;
  proxyEnvSet: boolean;
  sandboxNetnsFlag: boolean;
  detail: string;
}

export function sandboxNetnsHonestyFlag(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_NETNS;
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

/** True when wrapped children are expected to run with userns+netns network-off. */
export function netnsIsolationExpected(env: Record<string, string | undefined>): boolean {
  if (env.HZ_SANDBOX_EXEC === "0") return false;
  if (resolveSandboxExecBinary(env) === undefined) return false;
  if (sandboxNetnsHonestyFlag(env)) return true;
  const childNet = env.HZ_SANDBOX_CHILD_NET?.trim().toLowerCase();
  if (childNet === "on") return false;
  return true;
}

/**
 * When `HZ_SANDBOX_NETNS=1`, ensure wrapped children get explicit network-off unless
 * the spawn env already pins `HZ_SANDBOX_CHILD_NET`.
 */
export function mergeSandboxNetnsHonestySpawnEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (!sandboxNetnsHonestyFlag(base)) return base;
  if (base.HZ_SANDBOX_CHILD_NET !== undefined && base.HZ_SANDBOX_CHILD_NET !== "") return base;
  return { ...base, HZ_SANDBOX_CHILD_NET: "off" };
}

export function netnsEgressRoutePosture(env: Record<string, string | undefined>): NetnsEgressRoutePosture {
  const proxyEnvSet = egressProxyFromEnv(env) !== undefined;
  const sandboxNetnsFlag = sandboxNetnsHonestyFlag(env);
  const netns = netnsIsolationExpected(env);

  if (!netns) {
    return {
      route: "ambient",
      netnsIsolationExpected: false,
      proxyEnvSet,
      sandboxNetnsFlag,
      detail:
        proxyEnvSet
          ? "ambient egress — HZ_EGRESS_PROXY sets child proxy env only (advisory); no netns TCP deny from wrapper"
          : "ambient egress — shell children unconstrained by netns; only net.fetch is decided",
    };
  }

  if (proxyEnvSet) {
    return {
      route: "proxy-env-partial",
      netnsIsolationExpected: true,
      proxyEnvSet: true,
      sandboxNetnsFlag,
      detail:
        "proxy-routed partial — wrapped child gets HTTP(S)_PROXY from HZ_EGRESS_PROXY; bare TCP outside CONNECT proxy is denied in netns (Landlock); parent-loopback proxy reach — see doctor egress.netns.proxy — never claim shell-net enforced",
    };
  }

  return {
    route: "deny-only",
    netnsIsolationExpected: true,
    proxyEnvSet: false,
    sandboxNetnsFlag,
    detail:
      "netns deny-only — bare outbound TCP denied in wrapped children; no HZ_EGRESS_PROXY — routed proxy-only egress not configured",
  };
}
