/**
 * Netns child → parent-loopback proxy reachability honesty (docs/33 §5.2; ruling **289**).
 *
 * Wrapped children with network-off cannot TCP to the parent's 127.0.0.1 CONNECT
 * listener without bridge/veth plumbing. This module probes that limitation and
 * optionally installs a non-loopback `HZ_EGRESS_PROXY` when configured — advisory
 * only; never claim shell-net enforced.
 */

import { egressProxyFromEnv, normalizeEgressProxyUrl } from "./egress-env";
import { netnsIsolationExpected } from "./sandbox-netns-route";

export type NetnsParentProxyReachKind =
  | "not-applicable"
  | "no-proxy-configured"
  | "parent-loopback-blocked"
  | "custom-endpoint-configured";

export interface NetnsParentProxyReachability {
  kind: NetnsParentProxyReachKind;
  netnsIsolationExpected: boolean;
  configuredProxy?: string;
  reachableProxyUrl?: string;
  detail: string;
}

function envFlagTruthy(raw: string | undefined): boolean {
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

export function netnsEgressNetnsProxyOptIn(env: Record<string, string | undefined>): boolean {
  return envFlagTruthy(env.HZ_EGRESS_NETNS_PROXY);
}

/**
 * Auto-derive child proxy URL from `HZ_EGRESS_NETNS_BRIDGE_HOST` + parent loopback
 * proxy port when explicit `HZ_EGRESS_NETNS_PROXY_ENDPOINT` is absent (ruling **317**).
 */
export function netnsRoutedProxySpawnOptIn(env: Record<string, string | undefined>): boolean {
  return envFlagTruthy(env.HZ_EGRESS_NETNS_PROXY_ROUTED);
}

export function netnsSpawnRoutedProxyOptIn(env: Record<string, string | undefined>): boolean {
  return netnsEgressNetnsProxyOptIn(env) || netnsRoutedProxySpawnOptIn(env);
}

/** Parent-facing bridge IP where CONNECT proxy may bind (not child loopback). */
export function netnsBridgeHostFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_EGRESS_NETNS_BRIDGE_HOST ?? env.HZ_EGRESS_NETNS_BRIDGE_IP;
  if (typeof raw !== "string") return undefined;
  const host = raw.trim();
  if (host === "" || host === "0") return undefined;
  return host;
}

function proxyListenPortFromEnv(env: Record<string, string | undefined>): number | undefined {
  const rawPort = env.HZ_EGRESS_CONNECT_PROXY_PORT ?? env.HZ_EGRESS_PROXY_PORT;
  if (typeof rawPort === "string" && rawPort.trim() !== "") {
    const n = Number.parseInt(rawPort.trim(), 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const configured = egressProxyFromEnv(env);
  if (configured === undefined) return undefined;
  try {
    const port = new URL(configured).port;
    if (port !== "") {
      const n = Number.parseInt(port, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const scheme = new URL(configured).protocol;
    return scheme === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

/**
 * Build `http://<bridgeHost>:<port>` for wrapped netns children when the parent CONNECT
 * proxy listens on loopback but a bridge/veth address is configured (**317**).
 */
export function deriveNetnsBridgeProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const bridgeHost = netnsBridgeHostFromEnv(env);
  if (bridgeHost === undefined || isLoopbackProxyHost(bridgeHost)) return undefined;
  const port = proxyListenPortFromEnv(env);
  if (port === undefined) return undefined;
  return normalizeEgressProxyUrl(`${bridgeHost}:${port}`);
}

export interface NetnsEgressProxySpawnContext {
  /** True when argv is wrapped via hz-sandbox-exec (spawnOwned only). */
  sandboxWrapped?: boolean;
}

export function bridgeEgressProxyEndpointAvailable(env: Record<string, string | undefined>): boolean {
  const endpoint = netnsProxyEndpointFromEnv(env);
  if (endpoint !== undefined && !proxyUrlTargetsParentLoopback(endpoint)) return true;
  return deriveNetnsBridgeProxyUrl(env) !== undefined;
}

/** Host:port or URL reachable from an isolated netns child (not parent loopback). */
export function netnsProxyEndpointFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_EGRESS_NETNS_PROXY_ENDPOINT ?? env.HZ_EGRESS_NETNS_PROXY_URL;
  if (typeof raw !== "string") return undefined;
  return normalizeEgressProxyUrl(raw);
}

function isLoopbackProxyHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function proxyUrlTargetsParentLoopback(proxyUrl: string): boolean {
  try {
    return isLoopbackProxyHost(new URL(proxyUrl).hostname);
  } catch {
    const normalized = normalizeEgressProxyUrl(proxyUrl);
    if (normalized === undefined) return false;
    try {
      return isLoopbackProxyHost(new URL(normalized).hostname);
    } catch {
      return false;
    }
  }
}

export function assessNetnsParentProxyReachability(
  env: Record<string, string | undefined>,
): NetnsParentProxyReachability {
  const netns = netnsIsolationExpected(env);
  if (!netns) {
    return {
      kind: "not-applicable",
      netnsIsolationExpected: false,
      detail: "ambient shell children — netns parent-loopback proxy reach probe not applicable",
    };
  }

  const configured = egressProxyFromEnv(env);
  const custom = netnsProxyEndpointFromEnv(env);

  if (custom !== undefined && !proxyUrlTargetsParentLoopback(custom)) {
    return {
      kind: "custom-endpoint-configured",
      netnsIsolationExpected: true,
      configuredProxy: configured,
      reachableProxyUrl: custom,
      detail:
        "HZ_EGRESS_NETNS_PROXY_ENDPOINT set — optional child proxy may target a bridge-facing host; reachability not proven — never claim enforced",
    };
  }

  if (configured === undefined) {
    return {
      kind: "no-proxy-configured",
      netnsIsolationExpected: true,
      detail:
        "netns-isolated child cannot reach parent 127.0.0.1 without veth/bridge — no HZ_EGRESS_PROXY; see doctor egress.netns.proxy",
    };
  }

  if (proxyUrlTargetsParentLoopback(configured)) {
    return {
      kind: "parent-loopback-blocked",
      netnsIsolationExpected: true,
      configuredProxy: configured,
      detail:
        "HZ_EGRESS_PROXY is parent loopback — wrapped netns child TCP to 127.0.0.1:proxy is blocked (hermetic PROXY_BLOCKED); set HZ_EGRESS_NETNS_PROXY=1 + HZ_EGRESS_NETNS_PROXY_ENDPOINT — never claim enforced",
    };
  }

  return {
    kind: "custom-endpoint-configured",
    netnsIsolationExpected: true,
    configuredProxy: configured,
    reachableProxyUrl: configured,
    detail: "HZ_EGRESS_PROXY targets a non-loopback host (advisory); child reachability not proven at runtime",
  };
}

/**
 * When `HZ_EGRESS_NETNS_PROXY=1` or `HZ_EGRESS_NETNS_PROXY_ROUTED=1`, map a
 * non-loopback bridge-facing proxy into `HZ_EGRESS_PROXY` for **sandbox-wrapped**
 * netns children so `mergeEgressProxyEnv` sets child `HTTP(S)_PROXY` (**317** reduced).
 * Advisory only — never claim shell-net enforced; veth plumbing is not done here.
 */
export function mergeNetnsEgressProxySpawnEnv(
  base: Record<string, string | undefined>,
  ctx: NetnsEgressProxySpawnContext = {},
): Record<string, string | undefined> {
  if (!netnsSpawnRoutedProxyOptIn(base)) return base;
  if (ctx.sandboxWrapped === false) return base;
  if (!netnsIsolationExpected(base)) return base;

  const explicit = netnsProxyEndpointFromEnv(base);
  if (explicit !== undefined && !proxyUrlTargetsParentLoopback(explicit)) {
    return { ...base, HZ_EGRESS_PROXY: explicit };
  }

  const parentProxy = egressProxyFromEnv(base);
  const shouldDerive =
    netnsRoutedProxySpawnOptIn(base) ||
    (netnsEgressNetnsProxyOptIn(base) && parentProxy !== undefined && proxyUrlTargetsParentLoopback(parentProxy));
  if (!shouldDerive) return base;

  const derived = deriveNetnsBridgeProxyUrl(base);
  if (derived === undefined) return base;
  return { ...base, HZ_EGRESS_PROXY: derived };
}

export function assessNetnsSpawnRoutedProxyWiring(
  env: Record<string, string | undefined>,
): { wired: boolean; childProxyUrl?: string; detail: string } {
  if (!netnsSpawnRoutedProxyOptIn(env)) {
    return {
      wired: false,
      detail: "HZ_EGRESS_NETNS_PROXY / HZ_EGRESS_NETNS_PROXY_ROUTED unset — spawnOwned does not remap child proxy",
    };
  }
  if (!netnsIsolationExpected(env)) {
    return { wired: false, detail: "netns isolation not expected — routed proxy spawn wiring not applicable" };
  }
  if (!bridgeEgressProxyEndpointAvailable(env)) {
    return {
      wired: false,
      detail:
        "no non-loopback bridge endpoint — set HZ_EGRESS_NETNS_PROXY_ENDPOINT or HZ_EGRESS_NETNS_BRIDGE_HOST + parent HZ_EGRESS_PROXY port",
    };
  }
  const merged = mergeNetnsEgressProxySpawnEnv(env, { sandboxWrapped: true });
  const childProxy = egressProxyFromEnv(merged);
  return {
    wired: childProxy !== undefined && !proxyUrlTargetsParentLoopback(childProxy),
    childProxyUrl: childProxy,
    detail:
      childProxy !== undefined && !proxyUrlTargetsParentLoopback(childProxy)
        ? `spawnOwned may install child HTTP(S)_PROXY → ${childProxy} on hz-sandbox-exec wraps — advisory only, not enforced`
        : "bridge endpoint configured but child proxy URL unresolved — never claim enforced",
  };
}
