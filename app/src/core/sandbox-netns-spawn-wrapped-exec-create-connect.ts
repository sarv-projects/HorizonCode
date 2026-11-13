import { spawnSync } from "node:child_process";

/**
 * spawnOwned + hz-sandbox-exec product-runtime CONNECT via in-wrapper
 * CREATE + ADDR + default-route (no parent veth plumb) — ruling **332**.
 *
 * Extends rulings 321/326 wrapped CONNECT and 330/331 CREATE/ADDR wire.
 * Product-default spawnOwned auto-wire: ruling **341** (`mergeSandboxNetnsProductDefaultSpawnEnv`).
 * Advisory only — never claim shell-net enforced.
 */

import {
  mergeSandboxExecVethCreateSpawnEnv,
  sandboxExecVethCreateRequested,
} from "./sandbox-exec-veth-create";
import { mergedSpawnRoutedChildProxyEnv } from "./sandbox-netns-spawn-veth";
import {
  assessNetnsSpawnRoutedProxyWiring,
  proxyUrlTargetsParentLoopback,
} from "./sandbox-netns-proxy";
import { netnsIsolationExpected } from "./sandbox-netns-route";
import {
  buildConnectViaProxyProbePython,
  probeSandboxExecConnectViaSpawnProxy,
  type DoctorRunWithEnvFn,
  type SandboxExecConnectProbe,
} from "./sandbox-netns-spawn-wrapped-connect";
import type { DoctorRunFn } from "./sandbox-netns-veth";
import {
  probeCapNetAdminForVeth,
  type StartBridgeConnectProxy,
  VETH_HERMETIC_BRIDGE_HOST,
} from "./sandbox-netns-veth";

/** Parent peer /30 on bridge host used for in-wrapper CREATE plumb (**332**). */
export const VETH_EXEC_CREATE_PEER_ADDR = `${VETH_HERMETIC_BRIDGE_HOST}/30`;
export const VETH_EXEC_CREATE_HOST_ADDR = "10.199.0.2/30";

export type NetnsSpawnWrappedExecCreateKind =
  | "not-applicable"
  | "stack-unwired"
  | "create-unwired"
  | "cap-net-admin-missing"
  | "nsenter-missing"
  | "hermetic-exec-create-unproven"
  | "hermetic-exec-create-ok";

export interface NetnsSpawnWrappedExecCreatePosture {
  kind: NetnsSpawnWrappedExecCreateKind;
  spawnWired: boolean;
  createWired: boolean;
  childProxyUrl?: string;
  capNetAdmin: boolean;
  nsenterAvailable: boolean;
  detail: string;
  hermeticExecCreateConnectOk?: boolean;
}

export function probeNsenterAvailable(run: DoctorRunFn): boolean {
  const r = run("nsenter", ["--version"], 2_000);
  return r.ok || r.stdout.length > 0 || r.stderr.toLowerCase().includes("util-linux");
}

export function execCreateVethInterfaceNames(suffix: string = String(process.pid)): {
  host: string;
  peer: string;
} {
  return {
    host: `hz-wrap-exec332-h-${suffix}`,
    peer: `hz-wrap-exec332-p-${suffix}`,
  };
}

export function buildExecCreatePlumbEnvFragment(
  host: string,
  peer: string,
): Record<string, string | undefined> {
  return {
    HZ_SANDBOX_VETH_CREATE: "1",
    HZ_SANDBOX_VETH_HOST: host,
    HZ_SANDBOX_VETH_PEER: peer,
    HZ_SANDBOX_VETH_PEER_ADDR: VETH_EXEC_CREATE_PEER_ADDR,
    HZ_SANDBOX_VETH_HOST_ADDR: VETH_EXEC_CREATE_HOST_ADDR,
    HZ_SANDBOX_VETH_DEFAULT_ROUTE: "1",
  };
}

/** Merged spawn ROUTED proxy + in-wrapper CREATE/ADDR/route for wrapped children (**332**). */
export function mergeSpawnWrappedExecCreateConnectEnv(
  env: Record<string, string | undefined>,
  plumb: { host: string; peer: string },
): Record<string, string | undefined> {
  const withPlumb = mergeSandboxExecVethCreateSpawnEnv(
    { ...env, ...buildExecCreatePlumbEnvFragment(plumb.host, plumb.peer) },
    { sandboxWrapped: true },
  );
  return mergedSpawnRoutedChildProxyEnv(withPlumb);
}

export function execCreateSpawnWiringReady(env: Record<string, string | undefined>): boolean {
  if (!netnsIsolationExpected(env)) return false;
  if (!sandboxExecVethCreateRequested(env)) return false;
  const spawn = assessNetnsSpawnRoutedProxyWiring(env);
  return spawn.wired && spawn.childProxyUrl !== undefined;
}

export function assessNetnsSpawnWrappedExecCreateConnectPosture(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
): NetnsSpawnWrappedExecCreatePosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      spawnWired: false,
      createWired: false,
      capNetAdmin: false,
      nsenterAvailable: false,
      detail: "ambient shell — in-wrapper CREATE CONNECT probe not applicable",
    };
  }
  const spawn = assessNetnsSpawnRoutedProxyWiring(env);
  const cap = probeCapNetAdminForVeth(run);
  const nsenter = probeNsenterAvailable(run);
  const createWired = sandboxExecVethCreateRequested(env);
  if (!spawn.wired) {
    return {
      kind: "stack-unwired",
      spawnWired: false,
      createWired,
      capNetAdmin: cap,
      nsenterAvailable: nsenter,
      detail: `spawn ROUTED wiring incomplete — ${spawn.detail}`,
    };
  }
  if (!createWired) {
    return {
      kind: "create-unwired",
      spawnWired: true,
      createWired: false,
      childProxyUrl: spawn.childProxyUrl,
      capNetAdmin: cap,
      nsenterAvailable: nsenter,
      detail:
        "HZ_SANDBOX_VETH_CREATE unset — parent-side veth join/plumb path only (**326**); set CREATE+ADDR+DEFAULT_ROUTE for in-wrapper slice (**332**)",
    };
  }
  if (!cap) {
    return {
      kind: "cap-net-admin-missing",
      spawnWired: true,
      createWired: true,
      childProxyUrl: spawn.childProxyUrl,
      capNetAdmin: false,
      nsenterAvailable: nsenter,
      detail:
        "CAP_NET_ADMIN missing — cannot prove in-wrapper CREATE+ADDR CONNECT on this host; never claim enforced",
    };
  }
  if (!nsenter) {
    return {
      kind: "nsenter-missing",
      spawnWired: true,
      createWired: true,
      childProxyUrl: spawn.childProxyUrl,
      capNetAdmin: true,
      nsenterAvailable: false,
      detail:
        "`nsenter` unavailable — HZ_SANDBOX_VETH_PEER_ADDR plumb may fail; hermetic CONNECT unproven on this host",
    };
  }
  return {
    kind: "hermetic-exec-create-unproven",
    spawnWired: true,
    createWired: true,
    childProxyUrl: spawn.childProxyUrl,
    capNetAdmin: true,
    nsenterAvailable: true,
    hermeticExecCreateConnectOk: false,
    detail:
      "hermetic suite may prove spawnOwned child_net=off CONNECT via CREATE+ADDR+default-route (no parent plumb) — never claim enforced",
  };
}

export function buildDirect443ChildProbePython(): string {
  return [
    "import socket",
    "try:",
    " s=socket.socket(); s.settimeout(2); s.connect(('93.184.216.34',443)); print('DIRECT_443_UNEXPECTED')",
    "except OSError: print('DIRECT_443_BLOCKED')",
  ].join("\n");
}

export function teardownExecCreateVethLinks(run: DoctorRunFn, host: string, peer: string): void {
  run("ip", ["link", "del", host], 3_000);
  run("ip", ["link", "del", peer], 3_000);
}

export type SpawnWrappedExecCreateConnectOk = {
  ok: true;
  bridgeHost: string;
  childProxyUrl: string;
  wrappedExecCreateConnectOk: true;
  wrappedDirect443Blocked: true;
  wrappedWithoutAddrPlumbBlocked: true;
};
export type SpawnWrappedExecCreateConnectFail = {
  ok: false;
  reason: string;
  skipped?: boolean;
  wrappedExecCreateConnectOk?: boolean;
  wrappedDirect443Blocked?: boolean;
  wrappedWithoutAddrPlumbBlocked?: boolean;
};
export type SpawnWrappedExecCreateConnectResult =
  | SpawnWrappedExecCreateConnectOk
  | SpawnWrappedExecCreateConnectFail;

function probeSandboxExecChildPython(
  sandboxBin: string,
  childEnv: Record<string, string | undefined>,
  py: string,
  runWithEnv: DoctorRunWithEnvFn,
  timeoutMs = 12_000,
): { ok: boolean; detail: string; blocked?: boolean } {
  const exec = runWithEnv(sandboxBin, ["--", "python3", "-c", py], timeoutMs, childEnv);
  const out = `${exec.stdout}\n${exec.stderr}`.trim();
  return { ok: exec.ok, detail: out.slice(0, 280), blocked: !exec.ok };
}

/**
 * Hermetic: bridge proxy on parent + wrapped hz-sandbox-exec CREATE/ADDR/route only
 * (no `setupVethHermeticPlumbing`).
 */
export async function attemptNetnsSpawnWrappedExecCreateConnectEgress(
  spawnEnv: Record<string, string | undefined>,
  connectAuthority: string,
  run: DoctorRunFn,
  startProxy: StartBridgeConnectProxy,
  options: {
    bridgeHost?: string;
    sandboxExecBin?: string;
    sandboxExecProbe?: SandboxExecConnectProbe;
    runWithEnv?: DoctorRunWithEnvFn;
    vethSuffix?: string;
  } = {},
): Promise<SpawnWrappedExecCreateConnectResult> {
  const bridgeHost =
    options.bridgeHost ??
    spawnEnv.HZ_EGRESS_NETNS_BRIDGE_HOST?.trim() ??
    VETH_HERMETIC_BRIDGE_HOST;
  if (!probeCapNetAdminForVeth(run)) {
    return { ok: false, reason: "CAP_NET_ADMIN missing", skipped: true };
  }
  if (!probeNsenterAvailable(run)) {
    return { ok: false, reason: "nsenter missing", skipped: true };
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
  const { host, peer } = execCreateVethInterfaceNames(options.vethSuffix);
  teardownExecCreateVethLinks(run, host, peer);
  const mergedChild = mergeSpawnWrappedExecCreateConnectEnv(
    { ...spawnEnv, HZ_EGRESS_NETNS_BRIDGE_HOST: bridgeHost, HZ_SANDBOX_CHILD_NET: "off" },
    { host, peer },
  );
  const bin = options.sandboxExecBin?.trim();
  if (bin === undefined || bin === "") {
    return { ok: false, reason: "hz-sandbox-exec binary missing" };
  }
  const runWithEnv: DoctorRunWithEnvFn =
    options.runWithEnv ??
    ((cmd, args, timeoutMs, childEnv) => {
      const r = spawnSync(cmd, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        env: childEnv !== undefined ? { ...process.env, ...childEnv } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        ok: r.status === 0,
        status: r.status,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    });
  const execProbe: SandboxExecConnectProbe =
    options.sandboxExecProbe ??
    ((sandboxBin, childEnv, proxyUrl, authority) =>
      probeSandboxExecConnectViaSpawnProxy(sandboxBin, childEnv, proxyUrl, authority, runWithEnv));
  let proxy: { port: number; stop: () => void } | undefined;
  try {
    proxy = await startProxy(bridgeHost);
    const connectProbe = execProbe(bin, mergedChild, childProxyUrl, connectAuthority);
    const directProbe = probeSandboxExecChildPython(
      bin,
      mergedChild,
      buildDirect443ChildProbePython(),
      runWithEnv,
    );
    const createOnlyEnv: Record<string, string | undefined> = { ...mergedChild };
    delete createOnlyEnv.HZ_SANDBOX_VETH_HOST_ADDR;
    delete createOnlyEnv.HZ_SANDBOX_VETH_PEER_ADDR;
    delete createOnlyEnv.HZ_SANDBOX_VETH_DEFAULT_ROUTE;
    delete createOnlyEnv.HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW;
    const noAddrProbe = execProbe(bin, createOnlyEnv, childProxyUrl, connectAuthority);
    const directBlocked =
      directProbe.detail.includes("DIRECT_443_BLOCKED") &&
      !directProbe.detail.includes("DIRECT_443_UNEXPECTED");
    const withoutAddrPlumbBlocked = !noAddrProbe.ok;
    if (connectProbe.ok && directBlocked && withoutAddrPlumbBlocked) {
      return {
        ok: true,
        bridgeHost,
        childProxyUrl,
        wrappedExecCreateConnectOk: true,
        wrappedDirect443Blocked: true,
        wrappedWithoutAddrPlumbBlocked: true,
      };
    }
    const reason = !connectProbe.ok
      ? connectProbe.detail || "in-wrapper CREATE CONNECT via bridge proxy failed"
      : !directBlocked
        ? "direct :443 probe inside wrapped child did not fail as expected"
        : !withoutAddrPlumbBlocked
          ? "expected CONNECT to fail when CREATE has no ADDR plumb"
          : "in-wrapper CREATE CONNECT probe incomplete";
    return {
      ok: false,
      reason,
      wrappedExecCreateConnectOk: connectProbe.ok,
      wrappedDirect443Blocked: directBlocked,
      wrappedWithoutAddrPlumbBlocked: withoutAddrPlumbBlocked,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    proxy?.stop();
    teardownExecCreateVethLinks(run, host, peer);
  }
}

function isSpawnWrappedExecCreateFail(
  r: SpawnWrappedExecCreateConnectResult,
): r is SpawnWrappedExecCreateConnectFail {
  return r.ok === false;
}

export function postureFromHermeticSpawnWrappedExecCreate(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
  hermetic: SpawnWrappedExecCreateConnectResult,
): NetnsSpawnWrappedExecCreatePosture {
  const base = assessNetnsSpawnWrappedExecCreateConnectPosture(env, run);
  if (!netnsIsolationExpected(env)) return base;
  if (!isSpawnWrappedExecCreateFail(hermetic)) {
    return {
      kind: "hermetic-exec-create-ok",
      spawnWired: true,
      createWired: true,
      childProxyUrl: hermetic.childProxyUrl,
      capNetAdmin: true,
      nsenterAvailable: true,
      hermeticExecCreateConnectOk: true,
      detail: `hermetic child_net=off CONNECT via ${hermetic.childProxyUrl} after in-wrapper CREATE+ADDR+default-route (no parent plumb); direct :443 blocked in child — never claim enforced`,
    };
  }
  if (hermetic.skipped) {
    return {
      ...base,
      kind: base.kind === "nsenter-missing" ? "nsenter-missing" : "cap-net-admin-missing",
      capNetAdmin: hermetic.reason.includes("CAP") ? false : base.capNetAdmin,
      hermeticExecCreateConnectOk: false,
    };
  }
  return {
    ...base,
    kind: "hermetic-exec-create-unproven",
    hermeticExecCreateConnectOk: false,
    detail: `in-wrapper CREATE CONNECT probe failed: ${hermetic.reason}`,
  };
}
