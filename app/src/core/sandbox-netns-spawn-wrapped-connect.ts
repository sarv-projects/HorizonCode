import { spawnSync } from "node:child_process";

/**
 * spawnOwned + hz-sandbox-exec product-runtime CONNECT via bridge proxy (ruling **321**).
 *
 * In-wrapper veth/bridge inside `hz-sandbox-exec` is still open (see module header on
 * `kernel/src/bin/hz_sandbox_exec.rs`). The strongest feasible proof here is:
 * parent-side veth plumbing + spawn ROUTED child proxy env + wrapped child CONNECT
 * when the helper is allowed to use the parent routable netns (`HZ_SANDBOX_CHILD_NET=on`
 * hermetic only). Production `child_net=off` still cannot reach the bridge without
 * in-wrapper veth. Advisory only — never claim shell-net enforced.
 */

import { mergedSpawnRoutedChildProxyEnv, spawnRoutedChildProxyUrl } from "./sandbox-netns-spawn-veth";
import {
  assessNetnsSpawnRoutedProxyWiring,
  proxyUrlTargetsParentLoopback,
} from "./sandbox-netns-proxy";
import { netnsIsolationExpected } from "./sandbox-netns-route";
import type { DoctorRunFn } from "./sandbox-netns-veth";
import {
  probeCapNetAdminForVeth,
  probeNetnsVethDirect443Blocked,
  setupVethHermeticPlumbing,
  teardownVethHermeticPlumbing,
  type StartBridgeConnectProxy,
  VETH_HERMETIC_BRIDGE_HOST,
  VETH_HERMETIC_NS,
} from "./sandbox-netns-veth";

export type NetnsSpawnWrappedConnectKind =
  | "not-applicable"
  | "stack-unwired"
  | "cap-net-admin-missing"
  | "hermetic-wrapped-unproven"
  | "hermetic-wrapped-ok";

export interface NetnsSpawnWrappedConnectPosture {
  kind: NetnsSpawnWrappedConnectKind;
  spawnWired: boolean;
  childProxyUrl?: string;
  capNetAdmin: boolean;
  detail: string;
  /** CONNECT from wrapped child when parent veth plumbing + hermetic child_net=on ran. */
  hermeticWrappedConnectOk?: boolean;
}

export function buildConnectViaProxyProbePython(proxyUrl: string, connectAuthority: string): string {
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
    host = "";
    port = 0;
  }
  return [
    "import socket",
    `bridge=${JSON.stringify(host)}`,
    `port=${port}`,
    `authority=${JSON.stringify(connectAuthority)}`,
    "if not bridge or not port: print('CONNECT_VIA_PROXY_INVALID_URL'); raise SystemExit(1)",
    "s=socket.socket(); s.settimeout(5)",
    "try:",
    " s.connect((bridge, port))",
    ' req=("CONNECT "+authority+" HTTP/1.1\\r\\nHost: "+authority+"\\r\\n\\r\\n").encode("latin1")',
    " s.sendall(req)",
    " head=b''",
    " while b'\\r\\n\\r\\n' not in head and len(head)<8192:",
    "  chunk=s.recv(4096)",
    "  if not chunk: break",
    "  head+=chunk",
    " status=head.split(b'\\r\\n')[0].decode('latin1','replace')",
    ' print("CONNECT_VIA_SPAWN_PROXY_OK" if " 200 " in status else "CONNECT_VIA_SPAWN_PROXY_FAIL:"+status[:120])',
    "except OSError as e:",
    ' print("CONNECT_VIA_SPAWN_PROXY_BLOCKED:"+str(e))',
  ].join("\n");
}

export type SandboxExecConnectProbe = (
  sandboxBin: string,
  childEnv: Record<string, string | undefined>,
  proxyUrl: string,
  connectAuthority: string,
) => { ok: boolean; detail: string; blocked?: boolean };

/** Default probe: `hz-sandbox-exec -- python3` with merged spawn child env. */
export function probeSandboxExecConnectViaSpawnProxy(
  sandboxBin: string,
  childEnv: Record<string, string | undefined>,
  proxyUrl: string,
  connectAuthority: string,
  runWithEnv: DoctorRunWithEnvFn,
): { ok: boolean; detail: string; blocked?: boolean } {
  const py = buildConnectViaProxyProbePython(proxyUrl, connectAuthority);
  const exec = runWithEnv(sandboxBin, ["--", "python3", "-c", py], 12_000, childEnv);
  const out = `${exec.stdout}\n${exec.stderr}`.trim();
  if (out.includes("CONNECT_VIA_SPAWN_PROXY_OK")) {
    return { ok: true, detail: out.slice(0, 280) };
  }
  const blocked =
    out.includes("CONNECT_VIA_SPAWN_PROXY_BLOCKED") ||
    out.includes("CONNECT_VIA_SPAWN_PROXY_FAIL") ||
    out.includes("Network is unreachable");
  return { ok: false, detail: out.slice(0, 280), blocked };
}

/** DoctorRunFn with optional child env (probe wrappers only). */
export type DoctorRunWithEnvFn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  childEnv?: Record<string, string | undefined>,
) => { ok: boolean; status: number | null; stdout: string; stderr: string };

export function assessNetnsSpawnWrappedConnectPosture(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
): NetnsSpawnWrappedConnectPosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      spawnWired: false,
      capNetAdmin: false,
      detail: "ambient shell — spawnOwned wrapped CONNECT probe not applicable",
    };
  }
  const spawn = assessNetnsSpawnRoutedProxyWiring(env);
  const cap = probeCapNetAdminForVeth(run);
  if (!spawn.wired) {
    return {
      kind: "stack-unwired",
      spawnWired: false,
      capNetAdmin: cap,
      detail: `spawn ROUTED wiring incomplete — ${spawn.detail}`,
    };
  }
  if (!cap) {
    return {
      kind: "cap-net-admin-missing",
      spawnWired: true,
      childProxyUrl: spawn.childProxyUrl,
      capNetAdmin: false,
      detail:
        "parent veth plumbing unavailable — cannot prove spawnOwned wrapped CONNECT via bridge proxy on this host",
    };
  }
  return {
    kind: "hermetic-wrapped-unproven",
    spawnWired: true,
    childProxyUrl: spawn.childProxyUrl,
    capNetAdmin: true,
    hermeticWrappedConnectOk: false,
    detail:
      "hermetic suite may prove spawnOwned-wrapped CONNECT via bridge when parent veth plumbing present (child_net=on probe only); production child_net=off needs in-wrapper veth — never claim enforced",
  };
}

export type SpawnWrappedProductConnectOk = {
  ok: true;
  bridgeHost: string;
  childProxyUrl: string;
  plumbingVethConnectOk: true;
  wrappedConnectHermeticOk: true;
  wrappedConnectProductionBlocked: true;
};
export type SpawnWrappedProductConnectFail = {
  ok: false;
  reason: string;
  skipped?: boolean;
  plumbingVethConnectOk?: boolean;
  wrappedConnectHermeticOk?: boolean;
  wrappedConnectProductionBlocked?: boolean;
};
export type SpawnWrappedProductConnectResult = SpawnWrappedProductConnectOk | SpawnWrappedProductConnectFail;

function probeVethConnectViaSpawnProxyUrl(
  proxyUrl: string,
  connectAuthority: string,
  run: DoctorRunFn,
  vethNs: string,
): { ok: boolean; detail: string } {
  const py = buildConnectViaProxyProbePython(proxyUrl, connectAuthority);
  const exec = run("ip", ["netns", "exec", vethNs, "python3", "-c", py], 10_000);
  const out = `${exec.stdout}\n${exec.stderr}`.trim();
  return { ok: out.includes("CONNECT_VIA_SPAWN_PROXY_OK"), detail: out.slice(0, 280) };
}

/**
 * Parent veth + bridge CONNECT proxy + spawn ROUTED env; proves veth plumbing CONNECT,
 * wrapped hz-sandbox-exec CONNECT with hermetic child_net=on, and production child_net=off gap.
 */
export async function attemptNetnsSpawnWrappedProductConnectEgress(
  spawnEnv: Record<string, string | undefined>,
  connectAuthority: string,
  run: DoctorRunFn,
  startProxy: StartBridgeConnectProxy,
  options: {
    bridgeHost?: string;
    vethNs?: string;
    sandboxExecBin?: string;
    sandboxExecProbe?: SandboxExecConnectProbe;
    runWithEnv?: DoctorRunWithEnvFn;
  } = {},
): Promise<SpawnWrappedProductConnectResult> {
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
  const mergedChild = mergedSpawnRoutedChildProxyEnv({
    ...spawnEnv,
    HZ_EGRESS_NETNS_BRIDGE_HOST: bridgeHost,
  });
  const bin = options.sandboxExecBin?.trim();
  const plumbing = setupVethHermeticPlumbing(run, options.vethNs ?? VETH_HERMETIC_NS);
  if (plumbing.ok === false) {
    return { ok: false, reason: plumbing.reason };
  }
  const vethNs = plumbing.ns;
  let proxy: { port: number; stop: () => void } | undefined;
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
  try {
    proxy = await startProxy(bridgeHost);
    const direct443Blocked = probeNetnsVethDirect443Blocked(run, vethNs);
    const vethConnect = probeVethConnectViaSpawnProxyUrl(childProxyUrl, connectAuthority, run, vethNs);
    let wrappedHermeticOk = false;
    let wrappedProductionBlocked = false;
    if (bin !== undefined && bin !== "") {
      const hermeticEnv = { ...mergedChild, HZ_SANDBOX_CHILD_NET: "on" };
      const hermeticProbe = execProbe(bin, hermeticEnv, childProxyUrl, connectAuthority);
      wrappedHermeticOk = hermeticProbe.ok;
      const prodEnv = { ...mergedChild, HZ_SANDBOX_CHILD_NET: "off" };
      const prodProbe = execProbe(bin, prodEnv, childProxyUrl, connectAuthority);
      wrappedProductionBlocked = !prodProbe.ok && (prodProbe.blocked === true || prodProbe.detail.length > 0);
    }
    if (direct443Blocked && vethConnect.ok && wrappedHermeticOk && wrappedProductionBlocked) {
      return {
        ok: true,
        bridgeHost,
        childProxyUrl,
        plumbingVethConnectOk: true,
        wrappedConnectHermeticOk: true,
        wrappedConnectProductionBlocked: true,
      };
    }
    const reason = !vethConnect.ok
      ? vethConnect.detail || "veth netns CONNECT via spawn proxy failed"
      : !wrappedHermeticOk
        ? "wrapped hz-sandbox-exec CONNECT (hermetic child_net=on) failed — parent bridge reach or proxy URL"
        : !wrappedProductionBlocked
          ? "expected production child_net=off wrapped CONNECT to fail without in-wrapper veth"
          : "direct :443 probe in veth netns did not fail as expected";
    return {
      ok: false,
      reason,
      plumbingVethConnectOk: vethConnect.ok,
      wrappedConnectHermeticOk: wrappedHermeticOk,
      wrappedConnectProductionBlocked: wrappedProductionBlocked,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    proxy?.stop();
    teardownVethHermeticPlumbing(run, vethNs);
  }
}

function isSpawnWrappedProductConnectFail(
  r: SpawnWrappedProductConnectResult,
): r is SpawnWrappedProductConnectFail {
  return r.ok === false;
}

export function postureFromHermeticSpawnWrappedConnect(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
  hermetic: SpawnWrappedProductConnectResult,
): NetnsSpawnWrappedConnectPosture {
  const base = assessNetnsSpawnWrappedConnectPosture(env, run);
  if (!netnsIsolationExpected(env)) return base;
  if (!isSpawnWrappedProductConnectFail(hermetic)) {
    return {
      kind: "hermetic-wrapped-ok",
      spawnWired: true,
      childProxyUrl: hermetic.childProxyUrl,
      capNetAdmin: true,
      hermeticWrappedConnectOk: true,
      detail: `hermetic spawnOwned-wrapped CONNECT via ${hermetic.childProxyUrl} with parent veth plumbing (child_net=on probe); production child_net=off blocked — in-wrapper veth still open; never claim enforced`,
    };
  }
  if (hermetic.skipped) {
    return { ...base, kind: "cap-net-admin-missing", capNetAdmin: false, hermeticWrappedConnectOk: false };
  }
  return {
    ...base,
    kind: "hermetic-wrapped-unproven",
    hermeticWrappedConnectOk: false,
    detail: `spawnOwned wrapped CONNECT probe failed: ${hermetic.reason}`,
  };
}

/** True when spawn ROUTED env yields a non-loopback bridge proxy URL. */
export function spawnWrappedConnectWiringReady(env: Record<string, string | undefined>): boolean {
  if (!netnsIsolationExpected(env)) return false;
  const url = spawnRoutedChildProxyUrl(env);
  return url !== undefined && !proxyUrlTargetsParentLoopback(url);
}
