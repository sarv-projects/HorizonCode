import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EnforcementOutcome } from "../../src/contracts";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { runDoctor, type DoctorEnv } from "../../src/core/doctor";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import { kernelStateDir, spawnOwned } from "../../src/core/owned-spawn";
import type { DoctorRunFn } from "../../src/core/sandbox-netns-veth";
import {
  VETH_HERMETIC_BRIDGE_HOST,
  VETH_HERMETIC_NS,
  probeCapNetAdminForVeth,
  setupVethHermeticPlumbing,
  teardownVethHermeticPlumbing,
} from "../../src/core/sandbox-netns-veth";
import {
  assessNetnsSpawnWrappedConnectPosture,
  attemptNetnsSpawnWrappedProductConnectEgress,
  buildConnectViaProxyProbePython,
  postureFromHermeticSpawnWrappedConnect,
  spawnWrappedConnectWiringReady,
} from "../../src/core/sandbox-netns-spawn-wrapped-connect";

const realRun: DoctorRunFn = (cmd, args, timeoutMs) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { ok: false, status: null, stdout: "", stderr: r.error.message };
    return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err) {
    return { ok: false, status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
};

function doctorFakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    home: "/tmp",
    workspace: "/tmp/ws",
    env: { ...(over.env ?? process.env) },
    run: realRun,
    ...over,
  };
}

const spawnStackBase = (): Record<string, string | undefined> => {
  const bin = resolveSandboxExecBinary(process.env);
  const base: Record<string, string | undefined> = {
    HZ_SANDBOX_EXEC: "1",
    HZ_SANDBOX_NETNS: "1",
    HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
    HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
    HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
  };
  if (bin !== undefined) base.HZ_SANDBOX_EXEC_BIN = bin;
  return base;
};

const enforcedReport: EnforcementOutcome = {
  status: "report",
  mode: "workspace-write",
  completeness: "partial",
  backend: "hz-sandbox-exec",
  dimensions: [{ dimension: "process", guarantee: "enforced", backend: "seccomp", residual: "" }],
};

describe("spawnOwned wrapped CONNECT (ruling 321)", () => {
  test("buildConnectViaProxyProbePython embeds bridge host from spawn proxy URL", () => {
    const py = buildConnectViaProxyProbePython(`http://${VETH_HERMETIC_BRIDGE_HOST}:4317`, "127.0.0.1:9");
    expect(py).toContain(VETH_HERMETIC_BRIDGE_HOST);
    expect(py).toContain("CONNECT_VIA_SPAWN_PROXY_OK");
  });

  test("spawnWrappedConnectWiringReady requires ROUTED bridge proxy", () => {
    expect(spawnWrappedConnectWiringReady(spawnStackBase())).toBe(true);
    expect(spawnWrappedConnectWiringReady({ HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" })).toBe(false);
  });

  test("doctor egress.netns.spawn.wrapped never claims enforced", () => {
    const line = runDoctor(doctorFakeEnv({ env: spawnStackBase() })).find(
      (c) => c.id === "egress.netns.spawn.wrapped",
    );
    expect(line).toBeDefined();
    expect(line!.status).toBe("warn");
    expect(`${line!.detail} ${line!.hint ?? ""}`.toLowerCase()).toContain("never");
    expect(`${line!.detail} ${line!.hint ?? ""}`.toLowerCase()).toMatch(/in-wrapper|veth/);
  });

  test("assess names stack-unwired without ROUTED opt-in", () => {
    const posture = assessNetnsSpawnWrappedConnectPosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" },
      realRun,
    );
    expect(posture.kind).toBe("stack-unwired");
  });

  test("hermetic spawnOwned-wrapped CONNECT when CAP_NET_ADMIN and hz-sandbox-exec present", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;
    const echo = createServer((s) => {
      s.on("data", (d) => s.write(d));
    });
    await new Promise<void>((resolve, reject) => {
      echo.listen(0, "127.0.0.1", () => resolve());
      echo.on("error", reject);
    });
    const echoPort = (echo.address() as { port: number }).port;
    const authority = `127.0.0.1:${echoPort}`;
    const startProxy = async (bridgeHost: string) => {
      const p = await startEgressConnectProxy({
        listenHost: bridgeHost,
        forward: true,
        policy: [{ host: "127.0.0.1", decision: "allow" }],
      });
      return { port: p.port, stop: () => p.stop() };
    };
    try {
      const result = await attemptNetnsSpawnWrappedProductConnectEgress(
        spawnStackBase(),
        authority,
        realRun,
        startProxy,
        { sandboxExecBin: bin },
      );
      if (result.ok) {
        expect(result.wrappedConnectProductionJoinOk).toBe(true);
        expect(result.wrappedConnectProductionWithoutJoinBlocked).toBe(true);
        expect(result.plumbingVethConnectOk).toBe(true);
        const posture = postureFromHermeticSpawnWrappedConnect(spawnStackBase(), realRun, result);
        expect(posture.kind).toBe("hermetic-production-join-ok");
        expect(posture.hermeticProductionJoinConnectOk).toBe(true);
        expect(posture.detail.toLowerCase()).not.toContain("enforced");
      } else if (!result.skipped) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    } finally {
      echo.close();
    }
  });

  test("spawnOwned production child_net=off CONNECT via bridge after veth join (ruling 326)", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;
    const plumbing = setupVethHermeticPlumbing(realRun, VETH_HERMETIC_NS);
    if (plumbing.ok === false) return;
    const echo = createServer((s) => {
      s.on("data", (d) => s.write(d));
    });
    await new Promise<void>((resolve, reject) => {
      echo.listen(0, "127.0.0.1", () => resolve());
      echo.on("error", reject);
    });
    const echoPort = (echo.address() as { port: number }).port;
    const authority = `127.0.0.1:${echoPort}`;
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-wrap-326-"));
    const prev = { ...process.env };
    try {
      const proxy = await startEgressConnectProxy({
        listenHost: VETH_HERMETIC_BRIDGE_HOST,
        forward: true,
        policy: [{ host: "127.0.0.1", decision: "allow" }],
      });
      const connectPy = buildConnectViaProxyProbePython(
        `http://${VETH_HERMETIC_BRIDGE_HOST}:${proxy.port}`,
        authority,
      );
      process.env = {
        ...prev,
        ...spawnStackBase(),
        HZ_SANDBOX_EXEC_BIN: bin,
        HZ_EGRESS_PROXY: `http://127.0.0.1:${proxy.port}`,
        HZ_SANDBOX_CHILD_NET: "off",
        HZ_SANDBOX_VETH_JOIN: "1",
        HZ_SANDBOX_VETH_NETNS: VETH_HERMETIC_NS,
      };
      const { proc } = await spawnOwned(["python3", "-c", connectPy], {
        stateDir: kernelStateDir(workspace),
        label: "shell",
        sandboxWrap: true,
        kernel: { mode: "trusted", sandboxReport: async () => enforcedReport } as never,
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      const merged = `${out}\n${err}`;
      expect(merged).toContain("CONNECT_VIA_SPAWN_PROXY_OK");
      expect(merged).not.toContain("enforced");
      proxy.stop();
    } finally {
      echo.close();
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      teardownVethHermeticPlumbing(realRun, VETH_HERMETIC_NS);
    }
  });

  test("spawnOwned product path CONNECT via bridge when parent veth plumbing up", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;
    const plumbing = [
      "set -e",
      `ip netns del hz-wrap-321-ns 2>/dev/null || true`,
      `ip link del hz-wrap-321-h 2>/dev/null || true`,
      "ip netns add hz-wrap-321-ns",
      "ip link add hz-wrap-321-h type veth peer name hz-wrap-321-c",
      "ip link set hz-wrap-321-c netns hz-wrap-321-ns",
      `ip addr add ${VETH_HERMETIC_BRIDGE_HOST}/24 dev hz-wrap-321-h`,
      "ip link set hz-wrap-321-h up",
      `ip netns exec hz-wrap-321-ns ip addr add 10.199.0.2/24 dev hz-wrap-321-c`,
      "ip netns exec hz-wrap-321-ns ip link set hz-wrap-321-c up",
      "ip netns exec hz-wrap-321-ns ip link set lo up",
    ].join("\n");
    const plumb = spawnSync("bash", ["-c", plumbing], { encoding: "utf8" });
    if (plumb.status !== 0) {
      return;
    }
    const echo = createServer((s) => {
      s.on("data", (d) => s.write(d));
    });
    await new Promise<void>((resolve, reject) => {
      echo.listen(0, "127.0.0.1", () => resolve());
      echo.on("error", reject);
    });
    const echoPort = (echo.address() as { port: number }).port;
    const authority = `127.0.0.1:${echoPort}`;
    const proxy = await startEgressConnectProxy({
      listenHost: VETH_HERMETIC_BRIDGE_HOST,
      forward: true,
      policy: [{ host: "127.0.0.1", decision: "allow" }],
    });
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-wrap-321-"));
    const prev = { ...process.env };
    const connectPy = buildConnectViaProxyProbePython(
      `http://${VETH_HERMETIC_BRIDGE_HOST}:${proxy.port}`,
      authority,
    );
    process.env = {
      ...prev,
      HZ_SANDBOX_EXEC: "1",
      HZ_SANDBOX_EXEC_BIN: bin,
      HZ_SANDBOX_NETNS: "1",
      HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
      HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
      HZ_EGRESS_PROXY: `http://127.0.0.1:${proxy.port}`,
      HZ_SANDBOX_CHILD_NET: "on",
    };
    try {
      const { proc } = await spawnOwned(["python3", "-c", connectPy], {
        stateDir: kernelStateDir(workspace),
        label: "shell",
        sandboxWrap: true,
        kernel: { mode: "trusted", sandboxReport: async () => enforcedReport } as never,
        env: { HZ_SANDBOX_CHILD_NET: "on" },
        stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        longLived: false,
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      await proc.exited;
      const merged = `${out}\n${err}`;
      expect(merged).toContain("CONNECT_VIA_SPAWN_PROXY_OK");
      expect(merged).not.toContain("enforced");
    } finally {
      proxy.stop();
      echo.close();
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      spawnSync("bash", ["-c", "ip netns del hz-wrap-321-ns 2>/dev/null; ip link del hz-wrap-321-h 2>/dev/null"], {
        encoding: "utf8",
      });
    }
  });
});
