import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import { runDoctor, type DoctorEnv } from "../../src/core/doctor";
import type { DoctorRunFn } from "../../src/core/sandbox-netns-veth";
import { VETH_HERMETIC_BRIDGE_HOST, probeCapNetAdminForVeth } from "../../src/core/sandbox-netns-veth";
import {
  assessNetnsSpawnVethRoutedStackPosture,
  attemptNetnsSpawnVethRoutedStackEgress,
  mergedSpawnRoutedChildProxyEnv,
  postureFromHermeticSpawnVethStack,
  spawnRoutedChildProxyUrl,
  type SandboxExecStackProbe,
} from "../../src/core/sandbox-netns-spawn-veth";

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

const sandboxExecStackProbe: SandboxExecStackProbe = (bin, childEnv, expectedProxy) => {
  const envEchoPy = ['import os', 'print("HTTP_PROXY="+(os.environ.get("HTTP_PROXY") or ""))'].join("\n");
  const echo = spawnSync(bin, ["--", "python3", "-c", envEchoPy], {
    encoding: "utf8",
    env: { ...process.env, ...childEnv, HZ_SANDBOX_CHILD_NET: "off" },
  });
  const echoOut = `${echo.stdout}\n${echo.stderr}`;
  const proxyMatches = echoOut.includes(`HTTP_PROXY=${expectedProxy}`);
  const directPy = [
    "import socket",
    "try:",
    " s=socket.socket(); s.settimeout(2); s.connect(('93.184.216.34',443)); print('DIRECT_443_UNEXPECTED')",
    "except OSError: print('DIRECT_443_BLOCKED')",
  ].join("\n");
  const direct = spawnSync(bin, ["--", "python3", "-c", directPy], {
    encoding: "utf8",
    env: { ...process.env, ...childEnv, HZ_SANDBOX_CHILD_NET: "off" },
  });
  const directOut = `${direct.stdout}\n${direct.stderr}`;
  const directBlocked =
    directOut.includes("DIRECT_443_BLOCKED") && !directOut.includes("DIRECT_443_UNEXPECTED");
  return { directBlocked, proxyMatches };
};

describe("spawn ROUTED + veth stack (ruling 319)", () => {
  test("merged child proxy targets bridge host", () => {
    const url = spawnRoutedChildProxyUrl(spawnStackBase());
    expect(url).toBe(`http://${VETH_HERMETIC_BRIDGE_HOST}:4317`);
    const merged = mergedSpawnRoutedChildProxyEnv(spawnStackBase());
    expect(merged.HTTP_PROXY).toBe(url);
  });

  test("doctor egress.netns.spawn.routed never claims enforced", () => {
    const line = runDoctor(doctorFakeEnv({ env: spawnStackBase() })).find(
      (c) => c.id === "egress.netns.spawn.routed",
    );
    expect(line).toBeDefined();
    expect(line!.status).toBe("warn");
    expect(`${line!.detail} ${line!.hint ?? ""}`.toLowerCase()).toContain("never");
  });

  test("assess names stack-unwired without ROUTED opt-in", () => {
    const posture = assessNetnsSpawnVethRoutedStackPosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" },
      realRun,
    );
    expect(posture.kind).toBe("stack-unwired");
  });

  test("hermetic spawn+veth stack when CAP_NET_ADMIN available", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
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
    const bin = resolveSandboxExecBinary(process.env);
    try {
      const stack = await attemptNetnsSpawnVethRoutedStackEgress(spawnStackBase(), authority, realRun, startProxy, {
        sandboxExecBin: bin !== undefined && existsSync(bin) ? bin : undefined,
        sandboxExecProbe: sandboxExecStackProbe,
      });
      if (stack.ok) {
        expect(stack.connectViaSpawnProxyInVeth).toBe(true);
        expect(stack.direct443BlockedInVeth).toBe(true);
        const posture = postureFromHermeticSpawnVethStack(spawnStackBase(), realRun, stack);
        expect(posture.kind).toBe("hermetic-stack-ok");
        expect(posture.detail.toLowerCase()).not.toContain("enforced");
        if (bin !== undefined && existsSync(bin)) {
          expect(stack.sandboxExecChildProxyMatches).toBe(true);
          expect(stack.sandboxExecDirectBlocked).toBe(true);
        }
      } else if (!stack.skipped) {
        expect(stack.reason.length).toBeGreaterThan(0);
      }
    } finally {
      echo.close();
    }
  });
});
