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
import { VETH_HERMETIC_BRIDGE_HOST, probeCapNetAdminForVeth } from "../../src/core/sandbox-netns-veth";
import { buildConnectViaProxyProbePython } from "../../src/core/sandbox-netns-spawn-wrapped-connect";
import {
  VETH_EXEC_CREATE_HOST_ADDR,
  VETH_EXEC_CREATE_PEER_ADDR,
  assessNetnsSpawnWrappedExecCreateConnectPosture,
  attemptNetnsSpawnWrappedExecCreateConnectEgress,
  buildExecCreatePlumbEnvFragment,
  execCreateSpawnWiringReady,
  mergeSpawnWrappedExecCreateConnectEnv,
  postureFromHermeticSpawnWrappedExecCreate,
  probeNsenterAvailable,
} from "../../src/core/sandbox-netns-spawn-wrapped-exec-create-connect";

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
    ...buildExecCreatePlumbEnvFragment("hz-test-h", "hz-test-p"),
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

describe("spawnOwned in-wrapper CREATE CONNECT (ruling 332)", () => {
  test("plumb env uses /30 bridge host addresses", () => {
    const frag = buildExecCreatePlumbEnvFragment("h", "p");
    expect(frag.HZ_SANDBOX_VETH_PEER_ADDR).toBe(VETH_EXEC_CREATE_PEER_ADDR);
    expect(frag.HZ_SANDBOX_VETH_HOST_ADDR).toBe(VETH_EXEC_CREATE_HOST_ADDR);
    expect(frag.HZ_SANDBOX_VETH_DEFAULT_ROUTE).toBe("1");
  });

  test("execCreateSpawnWiringReady requires ROUTED + CREATE", () => {
    expect(execCreateSpawnWiringReady(spawnStackBase())).toBe(true);
    expect(
      execCreateSpawnWiringReady({
        HZ_SANDBOX_EXEC: "1",
        HZ_SANDBOX_NETNS: "1",
        HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
      }),
    ).toBe(false);
  });

  test("doctor egress.netns.spawn.wrapped.exec_create never claims enforced", () => {
    const line = runDoctor(doctorFakeEnv({ env: spawnStackBase() })).find(
      (c) => c.id === "egress.netns.spawn.wrapped.exec_create",
    );
    expect(line).toBeDefined();
    expect(line!.status).toBe("warn");
    expect(`${line!.detail} ${line!.hint ?? ""}`.toLowerCase()).toContain("never");
  });

  test("assess create-unwired without HZ_SANDBOX_VETH_CREATE", () => {
    const posture = assessNetnsSpawnWrappedExecCreateConnectPosture(
      {
        HZ_SANDBOX_EXEC: "1",
        HZ_SANDBOX_NETNS: "1",
        HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
        HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
        HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
      },
      realRun,
    );
    expect(posture.kind).toBe("create-unwired");
  });

  test("hermetic in-wrapper CREATE CONNECT when CAP_NET_ADMIN + nsenter + hz-sandbox-exec", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    if (!probeNsenterAvailable(realRun)) return;
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
      const result = await attemptNetnsSpawnWrappedExecCreateConnectEgress(
        spawnStackBase(),
        authority,
        realRun,
        startProxy,
        { sandboxExecBin: bin, vethSuffix: `t${Date.now()}` },
      );
      if (result.ok) {
        expect(result.wrappedExecCreateConnectOk).toBe(true);
        expect(result.wrappedDirect443Blocked).toBe(true);
        const posture = postureFromHermeticSpawnWrappedExecCreate(spawnStackBase(), realRun, result);
        expect(posture.kind).toBe("hermetic-exec-create-ok");
        expect(posture.detail.toLowerCase()).not.toContain("enforced");
      } else if (!result.skipped) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    } finally {
      echo.close();
    }
  });

  test("spawnOwned product path CONNECT via in-wrapper CREATE+ADDR+default-route", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    if (!probeNsenterAvailable(realRun)) return;
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
    const suffix = `p${process.pid}`;
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-wrap-332-"));
    const prev = { ...process.env };
    let proxy: { port: number; stop: () => void } | undefined;
    try {
      proxy = await startEgressConnectProxy({
        listenHost: VETH_HERMETIC_BRIDGE_HOST,
        forward: true,
        policy: [{ host: "127.0.0.1", decision: "allow" }],
      });
      const childEnv = mergeSpawnWrappedExecCreateConnectEnv(
        {
          ...spawnStackBase(),
          HZ_SANDBOX_EXEC_BIN: bin,
          HZ_EGRESS_PROXY: `http://127.0.0.1:${proxy.port}`,
          HZ_SANDBOX_CHILD_NET: "off",
        },
        { host: `hz-wrap-332-h-${suffix}`, peer: `hz-wrap-332-p-${suffix}` },
      );
      const connectPy = buildConnectViaProxyProbePython(
        `http://${VETH_HERMETIC_BRIDGE_HOST}:${proxy.port}`,
        authority,
      );
      process.env = { ...prev, ...childEnv };
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
    } finally {
      proxy?.stop();
      echo.close();
      process.env = prev;
      rmSync(workspace, { recursive: true, force: true });
      spawnSync("bash", ["-c", `ip link del hz-wrap-332-h-${suffix} 2>/dev/null; ip link del hz-wrap-332-p-${suffix} 2>/dev/null`], {
        encoding: "utf8",
      });
    }
  });
});
