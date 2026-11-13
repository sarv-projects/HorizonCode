/**
 * In-wrapper `hz-sandbox-exec` veth netns join honesty (ruling **324**).
 *
 * `HZ_SANDBOX_VETH_JOIN=1` + `HZ_SANDBOX_VETH_NETNS` joins a parent-prepared netns
 * before user-namespace maps when `HZ_SANDBOX_CHILD_NET=off`. Does not plumb veth;
 * parent must create the netns (see `sandbox-netns-veth.ts`). Never shell-net enforced.
 */

import type { SpawnResult } from "./doctor";
import { netnsIsolationExpected } from "./sandbox-netns-route";
import { sandboxExecVethCreateRequested } from "./sandbox-exec-veth-create";
import { probeCapNetAdminForVeth } from "./sandbox-netns-veth";

export type SandboxExecVethJoinKind =
  | "not-applicable"
  | "join-off-default"
  | "join-unconfigured"
  | "cap-net-admin-missing"
  | "join-ready-advisory";

export interface SandboxExecVethJoinPosture {
  kind: SandboxExecVethJoinKind;
  joinRequested: boolean;
  netnsConfigured: boolean;
  capNetAdmin: boolean;
  detail: string;
}

export function sandboxExecVethJoinRequested(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_VETH_JOIN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function resolveSandboxExecVethNetnsPath(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_SANDBOX_VETH_NETNS?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("/")) return raw;
  return `/var/run/netns/${raw}`;
}

function sandboxExecVethNetnsAuto(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_VETH_NETNS_AUTO?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * Pass `HZ_SANDBOX_VETH_JOIN` / `HZ_SANDBOX_VETH_NETNS` to **hz-sandbox-exec-wrapped**
 * children only (ruling **325**). When `HZ_SANDBOX_VETH_NETNS_AUTO=1` and NETNS is
 * unset, defaults to hermetic parent netns name `hz-veth-reach-ns` (parent must plumb).
 * Strips join vars from unwrapped spawns. Never claims shell-net enforced.
 */
export function mergeSandboxExecVethJoinSpawnEnv(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean },
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  if (!opts.sandboxWrapped) {
    delete next.HZ_SANDBOX_VETH_JOIN;
    delete next.HZ_SANDBOX_VETH_NETNS;
    delete next.HZ_SANDBOX_VETH_NETNS_AUTO;
    return next;
  }
  if (!sandboxExecVethJoinRequested(env)) {
    return next;
  }
  next.HZ_SANDBOX_VETH_JOIN = "1";
  const configured = env.HZ_SANDBOX_VETH_NETNS?.trim();
  if (configured) {
    next.HZ_SANDBOX_VETH_NETNS = configured;
  } else if (sandboxExecVethNetnsAuto(env)) {
    // Lazy import name constant to avoid circular deps with sandbox-netns-veth.
    next.HZ_SANDBOX_VETH_NETNS = env.HZ_EGRESS_NETNS_VETH_NS?.trim() || "hz-veth-reach-ns";
  }
  return next;
}

export function assessSandboxExecVethJoinSpawnWiring(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean },
): { wired: boolean; detail: string } {
  const merged = mergeSandboxExecVethJoinSpawnEnv(env, opts);
  if (!opts.sandboxWrapped) {
    return {
      wired: false,
      detail: "veth join env stripped for non-wrapped spawn — never claim enforced",
    };
  }
  if (!sandboxExecVethJoinRequested(merged)) {
    return {
      wired: false,
      detail: "HZ_SANDBOX_VETH_JOIN unset on wrapped spawn — fresh netns isolation only",
    };
  }
  if (sandboxExecVethCreateRequested(merged)) {
    return {
      wired: false,
      detail:
        "HZ_SANDBOX_VETH_JOIN=1 conflicts with HZ_SANDBOX_VETH_CREATE=1 on wrapped child — wrapper fails closed at pre_exec",
    };
  }
  const netns = merged.HZ_SANDBOX_VETH_NETNS?.trim();
  if (!netns) {
    return {
      wired: false,
      detail:
        "HZ_SANDBOX_VETH_JOIN=1 without NETNS on wrapped child — wrapper fails closed (set HZ_SANDBOX_VETH_NETNS or HZ_SANDBOX_VETH_NETNS_AUTO=1)",
    };
  }
  return {
    wired: true,
    detail: `spawnOwned passes HZ_SANDBOX_VETH_JOIN=1 + HZ_SANDBOX_VETH_NETNS=${netns} to wrapped hz-sandbox-exec — parent must plumb veth; never claim enforced`,
  };
}

export function assessSandboxExecVethJoinPosture(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[], timeoutMs: number) => SpawnResult,
): SandboxExecVethJoinPosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      joinRequested: false,
      netnsConfigured: false,
      capNetAdmin: false,
      detail: "ambient shell children — hz-sandbox-exec in-wrapper veth join not applicable",
    };
  }
  const joinRequested = sandboxExecVethJoinRequested(env);
  const netnsPath = resolveSandboxExecVethNetnsPath(env);
  const netnsConfigured = netnsPath !== undefined && netnsPath.length > 0;
  const cap = probeCapNetAdminForVeth(run);
  if (!joinRequested) {
    return {
      kind: "join-off-default",
      joinRequested: false,
      netnsConfigured,
      capNetAdmin: cap,
      detail:
        "hz-sandbox-exec isolates fresh netns by default (child_net=off); set HZ_SANDBOX_VETH_JOIN=1 + HZ_SANDBOX_VETH_NETNS to join parent-prepared netns — never claim enforced",
    };
  }
  if (!netnsConfigured) {
    return {
      kind: "join-unconfigured",
      joinRequested: true,
      netnsConfigured: false,
      capNetAdmin: cap,
      detail:
        "HZ_SANDBOX_VETH_JOIN=1 without HZ_SANDBOX_VETH_NETNS — wrapper fails closed at pre_exec",
    };
  }
  if (!cap) {
    return {
      kind: "cap-net-admin-missing",
      joinRequested: true,
      netnsConfigured: true,
      capNetAdmin: false,
      detail:
        "parent veth/netns plumbing needs CAP_NET_ADMIN; in-wrapper join path exists but hermetic parent netns may be unavailable",
    };
  }
  return {
    kind: "join-ready-advisory",
    joinRequested: true,
    netnsConfigured: true,
    capNetAdmin: true,
    detail: `hz-sandbox-exec may join prepared netns ${netnsPath} (user ns only) — opt-in in-wrapper create via HZ_SANDBOX_VETH_CREATE (**329**); never claim shell-net enforced`,
  };
}
