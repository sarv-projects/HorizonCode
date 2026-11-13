/**
 * spawnOwned ROUTED proxy env + veth bridge stack honesty (ruling **319**).
 *
 * Combines **317** child `HTTP(S)_PROXY` remap with **315** veth/bridge CONNECT
 * hermetic plumbing *alongside* `hz-sandbox-exec` (veth not in-wrapper yet).
 * Proves: spawn wiring → bridge proxy URL; veth-isolated child direct :443 blocked
 * and CONNECT via that URL; sandbox-exec child receives bridge proxy + blocks direct.
 * Advisory only — never claim shell-net enforced.
 */

import { mergeEgressProxyEnv } from "./egress-env";
import {
  assessNetnsSpawnRoutedProxyWiring,
  mergeNetnsEgressProxySpawnEnv,
  proxyUrlTargetsParentLoopback,
} from "./sandbox-netns-proxy";
import { netnsIsolationExpected } from "./sandbox-netns-route";
import type { DoctorRunFn } from "./sandbox-netns-veth";
import {
  assessNetnsVethRoutedConnectPosture,
  probeCapNetAdminForVeth,
  probeNetnsVethDirect443Blocked,
  setupVethHermeticPlumbing,
  teardownVethHermeticPlumbing,
  type StartBridgeConnectProxy,
  VETH_HERMETIC_BRIDGE_HOST,
  VETH_HERMETIC_NS,
} from "./sandbox-netns-veth";

export type NetnsSpawnVethRoutedKind =
  | "not-applicable"
  | "stack-unwired"
  | "cap-net-admin-missing"
  | "hermetic-stack-unproven"
  | "hermetic-stack-ok";

export interface NetnsSpawnVethRoutedPosture {
  kind: NetnsSpawnVethRoutedKind;
  spawnWired: boolean;
  childProxyUrl?: string;
  capNetAdmin: boolean;
  detail: string;
  /** Hermetic veth netns CONNECT via spawn-derived proxy URL when suite ran. */
  hermeticStackOk?: boolean;
}

export function mergedSpawnRoutedChildProxyEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return mergeEgressProxyEnv(mergeNetnsEgressProxySpawnEnv(env, { sandboxWrapped: true }));
}

export function spawnRoutedChildProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const merged = mergedSpawnRoutedChildProxyEnv(env);
  const proxy = merged.HTTP_PROXY ?? merged.HTTPS_PROXY ?? merged.HZ_EGRESS_PROXY;
  if (typeof proxy !== "string" || proxy.trim() === "") return undefined;
  return proxy;
}

export function assessNetnsSpawnVethRoutedStackPosture(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
): NetnsSpawnVethRoutedPosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      spawnWired: false,
      capNetAdmin: false,
      detail: "ambient shell — spawnOwned+veth ROUTED stack probe not applicable",
    };
  }
  const spawn = assessNetnsSpawnRoutedProxyWiring(env);
  const vethBase = assessNetnsVethRoutedConnectPosture(env, run);
  if (!spawn.wired) {
    return {
      kind: "stack-unwired",
      spawnWired: false,
      capNetAdmin: vethBase.capNetAdmin,
      detail: `spawn ROUTED wiring incomplete — ${spawn.detail}`,
    };
  }
  if (!vethBase.capNetAdmin) {
    return {
      kind: "cap-net-admin-missing",
      spawnWired: true,
      childProxyUrl: spawn.childProxyUrl,
      capNetAdmin: false,
      detail:
        "HZ_EGRESS_NETNS_PROXY_ROUTED + bridge host wired for spawnOwned but CAP_NET_ADMIN missing — veth CONNECT stack cannot be proven on this host",
    };
  }
  return {
    kind: "hermetic-stack-unproven",
    spawnWired: true,
    childProxyUrl: spawn.childProxyUrl,
    capNetAdmin: true,
    hermeticStackOk: false,
    detail: `spawn child proxy ${spawn.childProxyUrl ?? "?"} — hermetic suite may prove veth netns CONNECT via same URL while direct :443 blocked; hz-sandbox-exec veth in-wrapper still open — never claim enforced`,
  };
}

export type SpawnVethRoutedStackOk = {
  ok: true;
  bridgeHost: string;
  childProxyUrl: string;
  direct443BlockedInVeth: true;
  connectViaSpawnProxyInVeth: true;
  sandboxExecDirectBlocked: boolean;
  sandboxExecChildProxyMatches: boolean;
};
export type SpawnVethRoutedStackFail = {
  ok: false;
  reason: string;
  skipped?: boolean;
  direct443BlockedInVeth?: boolean;
  connectViaSpawnProxyInVeth?: boolean;
  sandboxExecDirectBlocked?: boolean;
  sandboxExecChildProxyMatches?: boolean;
};
export type SpawnVethRoutedStackResult = SpawnVethRoutedStackOk | SpawnVethRoutedStackFail;

function isSpawnVethRoutedStackFail(r: SpawnVethRoutedStackResult): r is SpawnVethRoutedStackFail {
  return r.ok === false;
}

function probeConnectViaProxyUrl(
  proxyUrl: string,
  connectAuthority: string,
  run: DoctorRunFn,
  vethNs: string,
): { ok: boolean; detail: string } {
  let host: string;
  let port: number;
  try {
    const u = new URL(proxyUrl);
    host = u.hostname;
    port =
      u.port !== ""
        ? Number.parseInt(u.port, 10)
        : u.protocol === "https:"
          ? 443
          : 80;
  } catch {
    return { ok: false, detail: "invalid child proxy URL" };
  }
  const connectPy = [
    "import socket",
    `bridge=${JSON.stringify(host)}`,
    `port=${port}`,
    `authority=${JSON.stringify(connectAuthority)}`,
    "s=socket.socket(); s.settimeout(5)",
    "s.connect((bridge, port))",
    'req=("CONNECT "+authority+" HTTP/1.1\\r\\nHost: "+authority+"\\r\\n\\r\\n").encode("latin1")',
    "s.sendall(req)",
    "head=b''",
    "while b'\\r\\n\\r\\n' not in head and len(head)<8192:",
    " chunk=s.recv(4096)",
    " if not chunk: break",
    " head+=chunk",
    "status=head.split(b'\\r\\n')[0].decode('latin1','replace')",
    'print("CONNECT_VIA_SPAWN_PROXY_OK" if " 200 " in status else "CONNECT_VIA_SPAWN_PROXY_FAIL:"+status[:120])',
  ].join("\n");
  const exec = run("ip", ["netns", "exec", vethNs, "python3", "-c", connectPy], 8_000);
  const out = `${exec.stdout}\n${exec.stderr}`.trim();
  return { ok: out.includes("CONNECT_VIA_SPAWN_PROXY_OK"), detail: out.slice(0, 280) };
}

export type SandboxExecStackProbe = (
  bin: string,
  childEnv: Record<string, string | undefined>,
  expectedProxy: string,
) => { directBlocked: boolean; proxyMatches: boolean };

const noopSandboxProbe: SandboxExecStackProbe = () => ({
  directBlocked: false,
  proxyMatches: false,
});

/**
 * Hermetic stack: veth plumbing + bridge CONNECT proxy + spawn ROUTED child proxy URL.
 * Optional `sandboxExecProbe` checks hz-sandbox-exec receives merged HTTP_PROXY and blocks direct.
 */
export async function attemptNetnsSpawnVethRoutedStackEgress(
  spawnEnv: Record<string, string | undefined>,
  connectAuthority: string,
  run: DoctorRunFn,
  startProxy: StartBridgeConnectProxy,
  options: {
    bridgeHost?: string;
    vethNs?: string;
    sandboxExecProbe?: SandboxExecStackProbe;
    sandboxExecBin?: string;
  } = {},
): Promise<SpawnVethRoutedStackResult> {
  const bridgeHost =
    options.bridgeHost ??
    spawnEnv.HZ_EGRESS_NETNS_BRIDGE_HOST?.trim() ??
    VETH_HERMETIC_BRIDGE_HOST;
  if (!probeCapNetAdminForVeth(run)) {
    return { ok: false, reason: "CAP_NET_ADMIN missing", skipped: true };
  }
  const wiring = assessNetnsSpawnRoutedProxyWiring({
    ...spawnEnv,
    HZ_EGRESS_NETNS_BRIDGE_HOST: bridgeHost,
  });
  if (!wiring.wired || wiring.childProxyUrl === undefined) {
    return { ok: false, reason: wiring.detail };
  }
  if (proxyUrlTargetsParentLoopback(wiring.childProxyUrl)) {
    return { ok: false, reason: "spawn child proxy still targets parent loopback" };
  }
  const childProxyUrl = wiring.childProxyUrl;
  const childEnv = mergedSpawnRoutedChildProxyEnv({
    ...spawnEnv,
    HZ_EGRESS_NETNS_BRIDGE_HOST: bridgeHost,
  });

  const plumbing = setupVethHermeticPlumbing(run, options.vethNs ?? VETH_HERMETIC_NS);
  if (plumbing.ok === false) {
    return { ok: false, reason: plumbing.reason };
  }
  const vethNs = plumbing.ns;
  let proxy: { port: number; stop: () => void } | undefined;
  try {
    proxy = await startProxy(bridgeHost);
    const direct443Blocked = probeNetnsVethDirect443Blocked(run, vethNs);
    const connectProbe = probeConnectViaProxyUrl(childProxyUrl, connectAuthority, run, vethNs);
    let sandboxExecDirectBlocked = false;
    let sandboxExecChildProxyMatches = false;
    const probeFn = options.sandboxExecProbe ?? noopSandboxProbe;
    if (options.sandboxExecBin !== undefined && options.sandboxExecBin !== "") {
      const sbx = probeFn(options.sandboxExecBin, childEnv, childProxyUrl);
      sandboxExecDirectBlocked = sbx.directBlocked;
      sandboxExecChildProxyMatches = sbx.proxyMatches;
    }
    if (direct443Blocked && connectProbe.ok) {
      return {
        ok: true,
        bridgeHost,
        childProxyUrl,
        direct443BlockedInVeth: true,
        connectViaSpawnProxyInVeth: true,
        sandboxExecDirectBlocked,
        sandboxExecChildProxyMatches,
      };
    }
    const reason = connectProbe.ok
      ? "direct :443 probe in veth netns did not fail as expected"
      : connectProbe.detail || "CONNECT via spawn-derived proxy failed in veth netns";
    return {
      ok: false,
      reason,
      direct443BlockedInVeth: direct443Blocked,
      connectViaSpawnProxyInVeth: connectProbe.ok,
      sandboxExecDirectBlocked,
      sandboxExecChildProxyMatches,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    proxy?.stop();
    teardownVethHermeticPlumbing(run, vethNs);
  }
}

export function postureFromHermeticSpawnVethStack(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
  hermetic: SpawnVethRoutedStackResult,
): NetnsSpawnVethRoutedPosture {
  const base = assessNetnsSpawnVethRoutedStackPosture(env, run);
  if (!netnsIsolationExpected(env)) return base;
  if (hermetic.ok) {
    const sbx =
      hermetic.sandboxExecChildProxyMatches && hermetic.sandboxExecDirectBlocked
        ? "; hz-sandbox-exec child HTTP_PROXY matches bridge and direct :443 blocked"
        : "; hz-sandbox-exec CONNECT reach still requires in-wrapper veth (alongside probe only)";
    return {
      kind: "hermetic-stack-ok",
      spawnWired: true,
      childProxyUrl: hermetic.childProxyUrl,
      capNetAdmin: true,
      hermeticStackOk: true,
      detail: `hermetic spawn+veth stack: veth netns direct :443 blocked; CONNECT via spawn ROUTED proxy ${hermetic.childProxyUrl}${sbx} — advisory only`,
    };
  }
  if (!isSpawnVethRoutedStackFail(hermetic)) {
    return base;
  }
  if (hermetic.skipped) {
    return { ...base, kind: "cap-net-admin-missing", capNetAdmin: false, hermeticStackOk: false };
  }
  return {
    ...base,
    kind: "hermetic-stack-unproven",
    hermeticStackOk: false,
    detail: `spawn+veth stack probe failed: ${hermetic.reason}`,
  };
}
