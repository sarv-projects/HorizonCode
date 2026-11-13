/**
 * Veth/bridge netns child → parent CONNECT proxy reachability probe (ruling **299**;
 * routed CONNECT on bridge IP — **315**).
 *
 * Hermetic tests may prove TCP from an isolated netns to a parent-facing veth address
 * and CONNECT via a proxy bound on the bridge IP (not 127.0.0.1) when CAP_NET_ADMIN
 * is available. Doctor runs the capability probe only — never claims shell-net enforced.
 */

import type { SpawnResult } from "./doctor";
import { netnsIsolationExpected } from "./sandbox-netns-route";

export type NetnsVethBridgeKind =
  | "not-applicable"
  | "cap-net-admin-missing"
  | "veth-plumbing-unavailable"
  | "hermetic-reach-unproven"
  | "hermetic-reach-ok"
  | "hermetic-routed-connect-ok"
  | "hermetic-routed-connect-unproven";

export interface NetnsVethBridgePosture {
  kind: NetnsVethBridgeKind;
  capNetAdmin: boolean;
  detail: string;
  /** Present when a live hermetic probe ran in tests. */
  hermeticReach?: boolean;
  /** CONNECT via parent bridge proxy when hermetic routed probe succeeded (**315**). */
  hermeticRoutedConnect?: boolean;
}

const VETH_PROBE_LINK = "hz-veth-doc-a";

export type DoctorRunFn = (cmd: string, args: string[], timeoutMs: number) => SpawnResult;

export function ipAvailable(run: DoctorRunFn): boolean {
  const r = run("ip", ["-V"], 2_000);
  return r.ok || r.stderr.includes("ip utility") || r.stdout.includes("ip utility");
}

/** True when the host can create a transient veth pair (needs CAP_NET_ADMIN). */
export function probeCapNetAdminForVeth(run: DoctorRunFn): boolean {
  if (!ipAvailable(run)) return false;
  const add = run("ip", ["link", "add", VETH_PROBE_LINK, "type", "veth", "peer", "name", `${VETH_PROBE_LINK}-b`], 3_000);
  if (!add.ok) return false;
  run("ip", ["link", "del", VETH_PROBE_LINK], 3_000);
  return true;
}

export function assessNetnsVethBridgePosture(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
): NetnsVethBridgePosture {
  if (!netnsIsolationExpected(env)) {
    return {
      kind: "not-applicable",
      capNetAdmin: false,
      detail: "ambient shell children — veth/bridge netns→parent CONNECT probe not applicable",
    };
  }
  const cap = probeCapNetAdminForVeth(run);
  if (!cap) {
    return {
      kind: "cap-net-admin-missing",
      capNetAdmin: false,
      detail:
        "CAP_NET_ADMIN / `ip link add type veth` unavailable — cannot plumb netns child to parent CONNECT proxy; veth/bridge egress not enforced",
    };
  }
  if (!ipAvailable(run)) {
    return {
      kind: "veth-plumbing-unavailable",
      capNetAdmin: true,
      detail: "`ip` utility missing — veth bridge probe cannot run on this host",
    };
  }
  return {
    kind: "hermetic-reach-unproven",
    capNetAdmin: true,
    detail:
      "CAP_NET_ADMIN present but doctor does not run live veth bridge; hermetic test may prove child→parent TCP — never claim enforced",
  };
}

export type VethHermeticReachOk = { ok: true; hostAddr: string };
export type VethHermeticReachFail = { ok: false; reason: string; skipped?: boolean };
export type VethHermeticReachResult = VethHermeticReachOk | VethHermeticReachFail;

function isVethHermeticReachOk(r: VethHermeticReachResult): r is VethHermeticReachOk {
  return r.ok === true;
}

/** Hermetic netns for veth bridge probes (shared with spawn stack **319**). */
export const VETH_HERMETIC_NS = "hz-veth-reach-ns";
const VETH_NS = VETH_HERMETIC_NS;
const VETH_HOST = "hz-veth-reach-h";
const VETH_CHILD = "hz-veth-reach-c";
/** Parent-side veth address used for hermetic bridge-IP CONNECT proxy tests (**315**). */
export const VETH_HERMETIC_BRIDGE_HOST = "10.199.0.1";
const VETH_SUBNET_HOST = VETH_HERMETIC_BRIDGE_HOST;
const VETH_SUBNET_CHILD = "10.199.0.2";

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function teardownVethHermeticPlumbing(run: DoctorRunFn, ns: string = VETH_NS): void {
  run("ip", ["netns", "del", ns], 3_000);
  run("ip", ["link", "del", VETH_HOST], 3_000);
}

export function setupVethHermeticPlumbing(
  run: DoctorRunFn,
  ns: string = VETH_NS,
): { ok: true; ns: string } | { ok: false; reason: string } {
  run("ip", ["netns", "del", ns], 2_000);
  run("ip", ["link", "del", VETH_HOST], 2_000);
  const script = [
    "set -e",
    `ip netns add ${ns}`,
    `ip link add ${VETH_HOST} type veth peer name ${VETH_CHILD}`,
    `ip link set ${VETH_CHILD} netns ${ns}`,
    `ip addr add ${VETH_SUBNET_HOST}/24 dev ${VETH_HOST}`,
    `ip link set ${VETH_HOST} up`,
    `ip netns exec ${ns} ip addr add ${VETH_SUBNET_CHILD}/24 dev ${VETH_CHILD}`,
    `ip netns exec ${ns} ip link set ${VETH_CHILD} up`,
    `ip netns exec ${ns} ip link set lo up`,
  ].join("\n");
  const exec = run("bash", ["-c", script], 8_000);
  if (!exec.ok) {
    teardownVethHermeticPlumbing(run, ns);
    const reason = (exec.stderr || exec.stdout || "veth plumbing failed").trim().slice(0, 200);
    return { ok: false, reason };
  }
  return { ok: true, ns };
}

export function probeNetnsVethDirect443Blocked(run: DoctorRunFn, ns: string = VETH_NS): boolean {
  const directPy = [
    "import socket",
    "try:",
    " s=socket.socket(); s.settimeout(2); s.connect(('93.184.216.34',443)); print('DIRECT_443_UNEXPECTED')",
    "except OSError: print('DIRECT_443_BLOCKED')",
  ].join("\n");
  const exec = run("ip", ["netns", "exec", ns, "python3", "-c", directPy], 6_000);
  const out = `${exec.stdout}\n${exec.stderr}`;
  return out.includes("DIRECT_443_BLOCKED") && !out.includes("DIRECT_443_UNEXPECTED");
}

function probeNetnsVethConnectViaBridgeProxy(
  proxyPort: number,
  connectAuthority: string,
  run: DoctorRunFn,
  bridgeHost: string,
  ns: string = VETH_NS,
): { ok: boolean; detail: string } {
  const connectPy = [
    "import socket",
    `bridge=${JSON.stringify(bridgeHost)}`,
    `port=${proxyPort}`,
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
    'print("CONNECT_VIA_BRIDGE_OK" if " 200 " in status else "CONNECT_VIA_BRIDGE_FAIL:"+status[:120])',
  ].join("\n");
  const exec = run("ip", ["netns", "exec", ns, "python3", "-c", connectPy], 8_000);
  const out = `${exec.stdout}\n${exec.stderr}`.trim();
  return { ok: out.includes("CONNECT_VIA_BRIDGE_OK"), detail: out.slice(0, 280) };
}

/**
 * Attempt veth plumbing + TCP connect from netns child to parent listen address.
 * Cleans up netns/links on success or failure. Requires CAP_NET_ADMIN.
 */
export async function attemptNetnsVethTcpReach(
  listenPort: number,
  run: DoctorRunFn,
): Promise<VethHermeticReachResult> {
  if (!probeCapNetAdminForVeth(run)) {
    return { ok: false, reason: "CAP_NET_ADMIN missing", skipped: true };
  }
  run("ip", ["netns", "del", VETH_NS], 2_000);
  run("ip", ["link", "del", VETH_HOST], 2_000);
  const script = [
    "set -e",
    `ip netns add ${VETH_NS}`,
    `ip link add ${VETH_HOST} type veth peer name ${VETH_CHILD}`,
    `ip link set ${VETH_CHILD} netns ${VETH_NS}`,
    `ip addr add ${VETH_SUBNET_HOST}/24 dev ${VETH_HOST}`,
    `ip link set ${VETH_HOST} up`,
    `ip netns exec ${VETH_NS} ip addr add ${VETH_SUBNET_CHILD}/24 dev ${VETH_CHILD}`,
    `ip netns exec ${VETH_NS} ip link set ${VETH_CHILD} up`,
    `ip netns exec ${VETH_NS} ip link set lo up`,
    `ip netns exec ${VETH_NS} python3 -c ${shellQuote(
      `import socket\ns=socket.socket()\ns.settimeout(3)\ns.connect(("${VETH_SUBNET_HOST}", ${listenPort}))\nprint("VETH_REACH_OK")`,
    )}`,
  ].join("\n");
  const exec = run("bash", ["-c", script], 12_000);
  run("ip", ["netns", "del", VETH_NS], 3_000);
  run("ip", ["link", "del", VETH_HOST], 3_000);
  if (exec.ok && exec.stdout.includes("VETH_REACH_OK")) {
    return { ok: true, hostAddr: VETH_SUBNET_HOST };
  }
  const reason = (exec.stderr || exec.stdout || "veth probe failed").trim().slice(0, 240);
  return { ok: false, reason };
}

export type VethHermeticRoutedConnectOk = {
  ok: true;
  bridgeHost: string;
  direct443Blocked: true;
};
export type VethHermeticRoutedConnectFail = {
  ok: false;
  reason: string;
  skipped?: boolean;
  direct443Blocked?: boolean;
  connectViaBridgeProxy?: boolean;
};
export type VethHermeticRoutedConnectResult = VethHermeticRoutedConnectOk | VethHermeticRoutedConnectFail;

function isVethHermeticRoutedConnectOk(r: VethHermeticRoutedConnectResult): r is VethHermeticRoutedConnectOk {
  return r.ok === true;
}

export type StartBridgeConnectProxy = (
  bridgeHost: string,
) => Promise<{ port: number; stop: () => void }>;

/**
 * Hermetic routed egress precursor: netns child has no upstream route (direct :443 blocked),
 * but may CONNECT through a proxy listening on the parent bridge IP (**315**).
 *
 * `startProxy` runs after veth plumbing exists so the proxy can bind the bridge address.
 */
export async function attemptNetnsVethRoutedConnectEgress(
  connectAuthority: string,
  run: DoctorRunFn,
  startProxy: StartBridgeConnectProxy,
  bridgeHost: string = VETH_HERMETIC_BRIDGE_HOST,
): Promise<VethHermeticRoutedConnectResult> {
  if (!probeCapNetAdminForVeth(run)) {
    return { ok: false, reason: "CAP_NET_ADMIN missing", skipped: true };
  }
  const plumbing = setupVethHermeticPlumbing(run);
  if (plumbing.ok === false) {
    return { ok: false, reason: plumbing.reason };
  }
  const vethNs = plumbing.ns;
  let proxy: { port: number; stop: () => void } | undefined;
  try {
    proxy = await startProxy(bridgeHost);
    const direct443Blocked = probeNetnsVethDirect443Blocked(run, vethNs);
    const connectProbe = probeNetnsVethConnectViaBridgeProxy(
      proxy.port,
      connectAuthority,
      run,
      bridgeHost,
      vethNs,
    );
    if (direct443Blocked && connectProbe.ok) {
      return { ok: true, bridgeHost, direct443Blocked: true };
    }
    const reason = connectProbe.ok
      ? "direct :443 probe did not fail as expected"
      : connectProbe.detail || "CONNECT via bridge proxy failed";
    return {
      ok: false,
      reason,
      direct443Blocked,
      connectViaBridgeProxy: connectProbe.ok,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    proxy?.stop();
    teardownVethHermeticPlumbing(run, vethNs);
  }
}

export function assessNetnsVethRoutedConnectPosture(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
): NetnsVethBridgePosture {
  const base = assessNetnsVethBridgePosture(env, run);
  if (!netnsIsolationExpected(env)) {
    return { ...base, kind: "not-applicable" };
  }
  if (!base.capNetAdmin) {
    return {
      ...base,
      kind: "hermetic-routed-connect-unproven",
      hermeticRoutedConnect: false,
      detail:
        "CAP_NET_ADMIN missing — cannot prove netns child CONNECT via parent bridge proxy; routed netns egress not enforced",
    };
  }
  return {
    ...base,
    kind: "hermetic-routed-connect-unproven",
    hermeticRoutedConnect: false,
    detail:
      "CAP_NET_ADMIN present: hermetic suite can prove child direct :443 blocked + CONNECT via proxy on bridge IP (not loopback) — production routed egress still not shipped",
  };
}

export function postureFromHermeticRoutedConnect(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
  hermetic: VethHermeticRoutedConnectResult,
): NetnsVethBridgePosture {
  const base = assessNetnsVethRoutedConnectPosture(env, run);
  if (!netnsIsolationExpected(env)) return base;
  if (isVethHermeticRoutedConnectOk(hermetic)) {
    return {
      kind: "hermetic-routed-connect-ok",
      capNetAdmin: true,
      hermeticRoutedConnect: true,
      detail: `hermetic veth: netns direct :443 blocked; CONNECT via parent bridge ${hermetic.bridgeHost} proxy OK (advisory precursor only)`,
    };
  }
  if (hermetic.skipped) {
    return {
      ...base,
      kind: "cap-net-admin-missing",
      capNetAdmin: false,
      hermeticRoutedConnect: false,
    };
  }
  return {
    kind: "hermetic-routed-connect-unproven",
    capNetAdmin: base.capNetAdmin,
    hermeticRoutedConnect: false,
    detail: `veth routed CONNECT probe failed: ${hermetic.reason}`,
  };
}

export function postureFromHermeticReach(
  env: Record<string, string | undefined>,
  run: DoctorRunFn,
  hermetic: VethHermeticReachResult,
): NetnsVethBridgePosture {
  const base = assessNetnsVethBridgePosture(env, run);
  if (!netnsIsolationExpected(env)) return base;
  if (isVethHermeticReachOk(hermetic)) {
    return {
      kind: "hermetic-reach-ok",
      capNetAdmin: true,
      hermeticReach: true,
      detail: `hermetic veth: netns child reached parent ${hermetic.hostAddr} TCP (CONNECT proxy path precursor)`,
    };
  } else {
    if (hermetic.skipped) {
      return { ...base, kind: "cap-net-admin-missing", capNetAdmin: false, hermeticReach: false };
    }
    return {
      kind: "hermetic-reach-unproven",
      capNetAdmin: base.capNetAdmin,
      hermeticReach: false,
      detail: `veth bridge reach probe failed: ${hermetic.reason}`,
    };
  }
}
