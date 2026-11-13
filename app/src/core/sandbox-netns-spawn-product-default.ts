/**
 * spawnOwned product-default routed netns stack (ruling **341**).
 *
 * When Linux sandbox wrap is on and product spawn routing is enabled, wrapped
 * children get ROUTED bridge proxy env plus JOIN (parent netns) or in-wrapper
 * CREATE+ADDR+default-route — advisory only, never shell-net enforced.
 *
 * Enabled when `HZ_SANDBOX_NETNS_SPAWN_ROUTED=1`, or automatically when
 * `HZ_SANDBOX_NETNS=1` unless `HZ_SANDBOX_NETNS_SPAWN_ROUTED=0`.
 */

import {
  assessNetnsSpawnRoutedProxyWiring,
  netnsBridgeHostFromEnv,
  netnsRoutedProxySpawnOptIn,
  netnsSpawnRoutedProxyOptIn,
} from "./sandbox-netns-proxy";
import { netnsIsolationExpected, sandboxNetnsHonestyFlag } from "./sandbox-netns-route";
import { sandboxExecVethCreateRequested } from "./sandbox-exec-veth-create";
import { sandboxExecVethJoinRequested } from "./sandbox-exec-veth-join";
import {
  buildExecCreatePlumbEnvFragment,
  execCreateSpawnWiringReady,
  execCreateVethInterfaceNames,
} from "./sandbox-netns-spawn-wrapped-exec-create-connect";
import { assessSandboxExecVethCreateSpawnWiring } from "./sandbox-exec-veth-create";
import { assessSandboxExecVethJoinSpawnWiring } from "./sandbox-exec-veth-join";
import { mergedSpawnRoutedChildProxyEnv } from "./sandbox-netns-spawn-veth";
import { VETH_HERMETIC_BRIDGE_HOST } from "./sandbox-netns-veth";

export type SandboxNetnsProductSpawnKind =
  | "not-applicable"
  | "product-off-default"
  | "join-path-advisory"
  | "create-path-advisory"
  | "stack-partial";

export interface SandboxNetnsProductSpawnPosture {
  kind: SandboxNetnsProductSpawnKind;
  productEnabled: boolean;
  spawnRoutedWired: boolean;
  vethMode: "join" | "create" | "none";
  joinSpawnWired: boolean;
  createSpawnWired: boolean;
  childProxyUrl?: string;
  detail: string;
}

function envFlagOff(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function envFlagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Explicit opt-in or auto when `HZ_SANDBOX_NETNS=1` (disable with `HZ_SANDBOX_NETNS_SPAWN_ROUTED=0`). */
export function sandboxNetnsProductSpawnOptIn(env: Record<string, string | undefined>): boolean {
  if (envFlagOff(env.HZ_SANDBOX_NETNS_SPAWN_ROUTED)) return false;
  if (envFlagOn(env.HZ_SANDBOX_NETNS_SPAWN_ROUTED)) return true;
  return sandboxNetnsHonestyFlag(env);
}

export function productSpawnVethMode(env: Record<string, string | undefined>): "join" | "create" | "none" {
  if (sandboxExecVethJoinRequested(env)) return "join";
  if (sandboxExecVethCreateRequested(env)) return "create";
  const mode = env.HZ_SANDBOX_NETNS_SPAWN_VETH?.trim().toLowerCase();
  if (mode === "join") return "join";
  if (mode === "create") return "create";
  if (mode === "none" || mode === "off") return "none";
  return "create";
}

/**
 * Product-default env fragment for **wrapped** hz-sandbox-exec children only.
 * Does not overwrite explicit user pins.
 */
export function mergeSandboxNetnsProductDefaultSpawnEnv(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean; spawnPid?: number },
): Record<string, string | undefined> {
  if (!opts.sandboxWrapped) return env;
  if (!netnsIsolationExpected(env)) return env;
  if (!sandboxNetnsProductSpawnOptIn(env)) return env;

  let next: Record<string, string | undefined> = { ...env };

  if (!netnsSpawnRoutedProxyOptIn(next)) {
    next = { ...next, HZ_EGRESS_NETNS_PROXY_ROUTED: "1" };
  }
  if (netnsBridgeHostFromEnv(next) === undefined) {
    next = { ...next, HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST };
  }

  const mode = productSpawnVethMode(next);
  if (mode === "join" && !sandboxExecVethJoinRequested(next)) {
    next = {
      ...next,
      HZ_SANDBOX_VETH_JOIN: "1",
      HZ_SANDBOX_VETH_NETNS_AUTO: next.HZ_SANDBOX_VETH_NETNS_AUTO ?? "1",
    };
  } else if (mode === "create" && !sandboxExecVethCreateRequested(next)) {
    const suffix = String(opts.spawnPid ?? process.pid);
    const { host, peer } = execCreateVethInterfaceNames(suffix);
    next = { ...next, ...buildExecCreatePlumbEnvFragment(host, peer) };
  }

  return next;
}

export function assessSandboxNetnsProductSpawnWiring(
  env: Record<string, string | undefined>,
  opts: { sandboxWrapped: boolean },
): { wired: boolean; detail: string } {
  if (!opts.sandboxWrapped) {
    return { wired: false, detail: "product spawn routing applies to wrapped hz-sandbox-exec children only" };
  }
  if (!sandboxNetnsProductSpawnOptIn(env)) {
    return {
      wired: false,
      detail:
        "product spawn routing off — set HZ_SANDBOX_NETNS_SPAWN_ROUTED=1 or HZ_SANDBOX_NETNS=1 (disable with HZ_SANDBOX_NETNS_SPAWN_ROUTED=0)",
    };
  }
  const merged = mergeSandboxNetnsProductDefaultSpawnEnv(env, { sandboxWrapped: true });
  const spawn = assessNetnsSpawnRoutedProxyWiring(merged);
  const mode = productSpawnVethMode(merged);
  if (!spawn.wired) {
    return { wired: false, detail: `ROUTED proxy incomplete after product merge — ${spawn.detail}` };
  }
  if (mode === "join") {
    const join = assessSandboxExecVethJoinSpawnWiring(merged, { sandboxWrapped: true });
    return {
      wired: join.wired,
      detail: join.wired
        ? `product JOIN path: ${join.detail}`
        : `product JOIN path incomplete — ${join.detail}`,
    };
  }
  if (mode === "create") {
    const create = assessSandboxExecVethCreateSpawnWiring(merged, { sandboxWrapped: true });
    const ready = execCreateSpawnWiringReady(merged);
    return {
      wired: create.wired && ready,
      detail: create.wired
        ? `product CREATE+ADDR path: ${create.detail}`
        : `product CREATE path incomplete — ${create.detail}`,
    };
  }
  return {
    wired: spawn.wired,
    detail: "product ROUTED proxy only (HZ_SANDBOX_NETNS_SPAWN_VETH=none) — no veth join/create auto wire",
  };
}

export function assessSandboxNetnsProductSpawnPosture(
  env: Record<string, string | undefined>,
): SandboxNetnsProductSpawnPosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      productEnabled: false,
      spawnRoutedWired: false,
      vethMode: "none",
      joinSpawnWired: false,
      createSpawnWired: false,
      detail: "ambient shell — spawnOwned product netns routing not applicable",
    };
  }
  const productEnabled = sandboxNetnsProductSpawnOptIn(env);
  if (!productEnabled) {
    return {
      kind: "product-off-default",
      productEnabled: false,
      spawnRoutedWired: netnsRoutedProxySpawnOptIn(env),
      vethMode: productSpawnVethMode(env),
      joinSpawnWired: false,
      createSpawnWired: false,
      detail:
        "wrapped spawnOwned does not auto-wire ROUTED+JOIN/CREATE — set HZ_SANDBOX_NETNS_SPAWN_ROUTED=1 or HZ_SANDBOX_NETNS=1",
    };
  }
  const merged = mergeSandboxNetnsProductDefaultSpawnEnv(env, { sandboxWrapped: true });
  const spawn = assessNetnsSpawnRoutedProxyWiring(merged);
  const mode = productSpawnVethMode(merged);
  const joinWired = assessSandboxExecVethJoinSpawnWiring(merged, { sandboxWrapped: true }).wired;
  const createWired = assessSandboxExecVethCreateSpawnWiring(merged, { sandboxWrapped: true }).wired;
  const childProxy = mergedSpawnRoutedChildProxyEnv(merged).HZ_EGRESS_PROXY;

  if (!spawn.wired) {
    return {
      kind: "stack-partial",
      productEnabled: true,
      spawnRoutedWired: false,
      vethMode: mode,
      joinSpawnWired: joinWired,
      createSpawnWired: createWired,
      detail: `product enable set but ROUTED wiring incomplete — ${spawn.detail}; never claim enforced`,
    };
  }

  if (mode === "join") {
    return {
      kind: joinWired ? "join-path-advisory" : "stack-partial",
      productEnabled: true,
      spawnRoutedWired: true,
      vethMode: "join",
      joinSpawnWired: joinWired,
      createSpawnWired: false,
      childProxyUrl: typeof childProxy === "string" ? childProxy : undefined,
      detail: joinWired
        ? "spawnOwned may auto-wire JOIN+ROUTED for wrapped children when product spawn routing is on — parent must plumb netns; never claim enforced"
        : "product JOIN path incomplete — set HZ_SANDBOX_VETH_NETNS or parent plumb; never claim enforced",
    };
  }

  if (mode === "create") {
    const createReady = execCreateSpawnWiringReady(merged);
    return {
      kind: createWired && createReady ? "create-path-advisory" : "stack-partial",
      productEnabled: true,
      spawnRoutedWired: true,
      vethMode: "create",
      joinSpawnWired: false,
      createSpawnWired: createWired,
      childProxyUrl: typeof childProxy === "string" ? childProxy : undefined,
      detail:
        createWired && createReady
          ? "spawnOwned may auto-wire CREATE+ADDR+ROUTED proxy for wrapped children — hermetic **332**; CAP/nsenter gaps remain; never claim enforced"
          : "product CREATE path incomplete — see egress.netns.spawn.wrapped.exec_create; never claim enforced",
    };
  }

  return {
    kind: "stack-partial",
    productEnabled: true,
    spawnRoutedWired: true,
    vethMode: "none",
    joinSpawnWired: false,
    createSpawnWired: false,
    childProxyUrl: typeof childProxy === "string" ? childProxy : undefined,
    detail: "product ROUTED proxy only — veth path disabled via HZ_SANDBOX_NETNS_SPAWN_VETH=none; never claim enforced",
  };
}

/** Read-only fix lines for `hzcode doctor --fix egress.netns.spawn.product` (ruling **341**). */
export function sandboxNetnsProductSpawnDoctorFixLines(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const proxy = env.HZ_EGRESS_PROXY?.trim();
  const bridge = env.HZ_EGRESS_NETNS_BRIDGE_HOST?.trim() ?? VETH_HERMETIC_BRIDGE_HOST;
  const lines = [
    "# Product routed netns spawn (diagnose-only — export in your shell or service unit)",
    "export HZ_SANDBOX_EXEC=1",
    "export HZ_SANDBOX_NETNS=1",
    "export HZ_SANDBOX_NETNS_SPAWN_ROUTED=1",
    `export HZ_EGRESS_NETNS_BRIDGE_HOST=${bridge}`,
    "export HZ_EGRESS_NETNS_PROXY_ROUTED=1",
  ];
  if (proxy) {
    lines.push(`export HZ_EGRESS_PROXY=${proxy}`);
  } else {
    lines.push("# export HZ_EGRESS_PROXY=http://127.0.0.1:<parent-connect-port>");
  }
  lines.push(
    "# Default veth mode is in-wrapper CREATE+ADDR (parent-less); for parent join path:",
    "# export HZ_SANDBOX_NETNS_SPAWN_VETH=join",
    "# export HZ_SANDBOX_VETH_NETNS=<prepared-netns>",
    "# Disable product auto-wire: export HZ_SANDBOX_NETNS_SPAWN_ROUTED=0",
  );
  return lines;
}
