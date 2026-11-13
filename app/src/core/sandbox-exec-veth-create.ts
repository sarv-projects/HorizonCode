/**
 * In-wrapper `hz-sandbox-exec` veth create/plumb honesty (ruling **329**;
 * address/route plumb after CREATE — **331**).
 *
 * `HZ_SANDBOX_VETH_CREATE=1` asks the wrapper to create a veth pair after
 * user+net unshare and move the peer into the parent netns when CAP_NET_ADMIN
 * is available in the user namespace. Fail-closed when unsupported.
 * Mutually exclusive with `HZ_SANDBOX_VETH_JOIN`. Optional
 * `HZ_SANDBOX_VETH_HOST_ADDR`, `HZ_SANDBOX_VETH_PEER_ADDR`, and
 * `HZ_SANDBOX_VETH_DEFAULT_ROUTE=1` apply after CREATE; those vars without
 * CREATE fail closed at pre_exec. Never shell-net enforced.
 */

import type { SpawnResult } from "./doctor";
import { netnsIsolationExpected } from "./sandbox-netns-route";
import { probeCapNetAdminForVeth } from "./sandbox-netns-veth";

export type SandboxExecVethCreateKind =
  | "not-applicable"
  | "create-off-default"
  | "addr-without-create"
  | "create-mutually-exclusive"
  | "cap-net-admin-missing"
  | "create-ready-advisory";

export interface SandboxExecVethCreatePosture {
  kind: SandboxExecVethCreateKind;
  createRequested: boolean;
  joinAlsoRequested: boolean;
  plumbEnvWithoutCreate: boolean;
  capNetAdmin: boolean;
  detail: string;
}

export function sandboxExecVethCreateRequested(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_VETH_CREATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function sandboxExecVethJoinAlsoRequested(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_VETH_JOIN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function envTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function envNonempty(raw: string | undefined): boolean {
  return (raw?.trim() ?? "").length > 0;
}

/** ADDR / default-route env without `HZ_SANDBOX_VETH_CREATE=1` — wrapper must fail closed (**331**). */
export function sandboxExecVethPlumbEnvWithoutCreate(env: Record<string, string | undefined>): boolean {
  if (sandboxExecVethCreateRequested(env)) return false;
  return (
    envNonempty(env.HZ_SANDBOX_VETH_HOST_ADDR) ||
    envNonempty(env.HZ_SANDBOX_VETH_PEER_ADDR) ||
    envTruthy(env.HZ_SANDBOX_VETH_DEFAULT_ROUTE) ||
    envNonempty(env.HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW)
  );
}

export function assessSandboxExecVethCreatePosture(
  env: Record<string, string | undefined>,
  run: (cmd: string, args: string[], timeoutMs: number) => SpawnResult,
): SandboxExecVethCreatePosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      createRequested: false,
      joinAlsoRequested: false,
      plumbEnvWithoutCreate: false,
      capNetAdmin: false,
      detail: "ambient shell children — hz-sandbox-exec in-wrapper veth create not applicable",
    };
  }
  const createRequested = sandboxExecVethCreateRequested(env);
  const joinAlsoRequested = sandboxExecVethJoinAlsoRequested(env);
  const plumbEnvWithoutCreate = sandboxExecVethPlumbEnvWithoutCreate(env);
  const cap = probeCapNetAdminForVeth(run);
  if (!createRequested) {
    if (plumbEnvWithoutCreate) {
      return {
        kind: "addr-without-create",
        createRequested: false,
        joinAlsoRequested,
        plumbEnvWithoutCreate: true,
        capNetAdmin: cap,
        detail:
          "HZ_SANDBOX_VETH_HOST_ADDR, HZ_SANDBOX_VETH_PEER_ADDR, and HZ_SANDBOX_VETH_DEFAULT_ROUTE_* require HZ_SANDBOX_VETH_CREATE=1 — wrapper fails closed at pre_exec",
      };
    }
    return {
      kind: "create-off-default",
      createRequested: false,
      joinAlsoRequested,
      plumbEnvWithoutCreate: false,
      capNetAdmin: cap,
      detail:
        "in-wrapper veth create opt-in via HZ_SANDBOX_VETH_CREATE=1 after child net isolation — parent-side plumb/join (**324**) remains default; never claim enforced",
    };
  }
  if (joinAlsoRequested) {
    return {
      kind: "create-mutually-exclusive",
      createRequested: true,
      joinAlsoRequested: true,
      plumbEnvWithoutCreate: false,
      capNetAdmin: cap,
      detail:
        "HZ_SANDBOX_VETH_CREATE=1 conflicts with HZ_SANDBOX_VETH_JOIN=1 — wrapper fails closed at pre_exec",
    };
  }
  if (!cap) {
    return {
      kind: "cap-net-admin-missing",
      createRequested: true,
      joinAlsoRequested: false,
      plumbEnvWithoutCreate: false,
      capNetAdmin: false,
      detail:
        "HZ_SANDBOX_VETH_CREATE=1 requires CAP_NET_ADMIN + `ip` in the child user namespace — fail-closed on this host; use parent-side veth plumb (**315**) or prepared netns join (**324**)",
    };
  }
  const plumbHint =
    envNonempty(env.HZ_SANDBOX_VETH_HOST_ADDR) ||
    envNonempty(env.HZ_SANDBOX_VETH_PEER_ADDR) ||
    envTruthy(env.HZ_SANDBOX_VETH_DEFAULT_ROUTE)
      ? "ADDR/default-route env will apply after CREATE when supported"
      : "opt-in HZ_SANDBOX_VETH_HOST_ADDR / HZ_SANDBOX_VETH_PEER_ADDR / HZ_SANDBOX_VETH_DEFAULT_ROUTE for /30-style plumb";
  return {
    kind: "create-ready-advisory",
    createRequested: true,
    joinAlsoRequested: false,
    plumbEnvWithoutCreate: false,
    capNetAdmin: true,
    detail: `hz-sandbox-exec may create veth + move peer to parent netns in pre_exec — ${plumbHint}; product CONNECT via CREATE+ADDR without parent plumb: egress.netns.spawn.wrapped.exec_create (**332**); never claim shell-net enforced`,
  };
}

/**
 * Pass `HZ_SANDBOX_VETH_CREATE` and optional `HZ_SANDBOX_VETH_HOST`/`PEER` to
 * **hz-sandbox-exec-wrapped** children only (ruling **330**). Strips create vars
 * from unwrapped spawns. When CREATE and JOIN are both set, passes both so the
 * wrapper fails closed (mutex honesty). Never claims shell-net enforced.
 */
export function mergeSandboxExecVethCreateSpawnEnv(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean },
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env };
  if (!opts.sandboxWrapped) {
    delete next.HZ_SANDBOX_VETH_CREATE;
    delete next.HZ_SANDBOX_VETH_HOST;
    delete next.HZ_SANDBOX_VETH_PEER;
    delete next.HZ_SANDBOX_VETH_HOST_ADDR;
    delete next.HZ_SANDBOX_VETH_PEER_ADDR;
    delete next.HZ_SANDBOX_VETH_DEFAULT_ROUTE;
    delete next.HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW;
    return next;
  }
  if (!sandboxExecVethCreateRequested(env)) {
    return next;
  }
  next.HZ_SANDBOX_VETH_CREATE = "1";
  const host = env.HZ_SANDBOX_VETH_HOST?.trim();
  const peer = env.HZ_SANDBOX_VETH_PEER?.trim();
  if (host) {
    next.HZ_SANDBOX_VETH_HOST = host;
  } else {
    delete next.HZ_SANDBOX_VETH_HOST;
  }
  if (peer) {
    next.HZ_SANDBOX_VETH_PEER = peer;
  } else {
    delete next.HZ_SANDBOX_VETH_PEER;
  }
  for (const key of [
    "HZ_SANDBOX_VETH_HOST_ADDR",
    "HZ_SANDBOX_VETH_PEER_ADDR",
    "HZ_SANDBOX_VETH_DEFAULT_ROUTE",
    "HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW",
  ] as const) {
    const v = env[key]?.trim();
    if (v) {
      next[key] = v;
    } else {
      delete next[key];
    }
  }
  return next;
}

export function assessSandboxExecVethCreateSpawnWiring(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean },
): { wired: boolean; detail: string } {
  const merged = mergeSandboxExecVethCreateSpawnEnv(env, opts);
  if (!opts.sandboxWrapped) {
    return {
      wired: false,
      detail: "veth create env stripped for non-wrapped spawn — never claim enforced",
    };
  }
  if (!sandboxExecVethCreateRequested(merged)) {
    return {
      wired: false,
      detail: "HZ_SANDBOX_VETH_CREATE unset on wrapped spawn — join or fresh netns isolation only",
    };
  }
  if (sandboxExecVethJoinAlsoRequested(merged)) {
    return {
      wired: false,
      detail:
        "HZ_SANDBOX_VETH_CREATE=1 conflicts with HZ_SANDBOX_VETH_JOIN=1 on wrapped child — wrapper fails closed at pre_exec",
    };
  }
  const host = merged.HZ_SANDBOX_VETH_HOST?.trim();
  const peer = merged.HZ_SANDBOX_VETH_PEER?.trim();
  const names =
    host || peer
      ? ` (HOST=${host ?? "hz-sbx-veth-h"}, PEER=${peer ?? "hz-sbx-veth-p"})`
      : "";
  return {
    wired: true,
    detail: `spawnOwned passes HZ_SANDBOX_VETH_CREATE=1${names} to wrapped hz-sandbox-exec — in-wrapper peer move only; never claim enforced`,
  };
}
