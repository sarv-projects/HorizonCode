import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { startEgressConnectProxy } from "../../src/core/egress-connect-proxy";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import type { DoctorRunFn } from "../../src/core/sandbox-netns-veth";
import {
  assessNetnsVethBridgePosture,
  assessNetnsVethRoutedConnectPosture,
  attemptNetnsVethRoutedConnectEgress,
  attemptNetnsVethTcpReach,
  postureFromHermeticReach,
  postureFromHermeticRoutedConnect,
  probeCapNetAdminForVeth,
  VETH_HERMETIC_BRIDGE_HOST,
} from "../../src/core/sandbox-netns-veth";
import { runDoctor, type DoctorEnv } from "../../src/core/doctor";
import { doctorFixSuggestion } from "../../src/core/doctor";

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

describe("netns veth bridge posture (ruling 299)", () => {
  test("doctor egress.netns.veth never claims enforced", () => {
    const bin = resolveSandboxExecBinary(process.env);
    const base: Record<string, string | undefined> = { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" };
    if (bin !== undefined) base.HZ_SANDBOX_EXEC_BIN = bin;
    const line = runDoctor(doctorFakeEnv({ env: base })).find((c) => c.id === "egress.netns.veth");
    expect(line).toBeDefined();
    expect(line!.status).toBe("warn");
    expect(line!.detail.toLowerCase()).toContain("enforced");
    expect(line!.hint?.toLowerCase()).toContain("never");
  });

  test("assess names cap missing when veth cannot be created", () => {
    const fakeRun: DoctorRunFn = () => ({
      ok: false,
      status: 1,
      stdout: "",
      stderr: "Operation not permitted",
    });
    const posture = assessNetnsVethBridgePosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1", HZ_SANDBOX_EXEC_BIN: "/bin/true" },
      fakeRun,
    );
    expect(posture.kind).toBe("cap-net-admin-missing");
    expect(posture.detail.toLowerCase()).toContain("cap_net_admin");
  });

  test("doctorFixSuggestion effect.host lists default and require", () => {
    const lines = doctorFixSuggestion("effect.host", {});
    expect(lines?.some((l) => l.includes("HZ_EFFECT_HOST_KERNEL=default"))).toBe(true);
    expect(lines?.some((l) => l.includes("HZ_EFFECT_HOST_KERNEL=require"))).toBe(true);
  });

  test("doctor egress.netns.veth.routed never claims enforced", () => {
    const bin = resolveSandboxExecBinary(process.env);
    const base: Record<string, string | undefined> = { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" };
    if (bin !== undefined) base.HZ_SANDBOX_EXEC_BIN = bin;
    const line = runDoctor(doctorFakeEnv({ env: base })).find((c) => c.id === "egress.netns.veth.routed");
    expect(line).toBeDefined();
    expect(line!.status).toBe("warn");
    expect(line!.hint?.toLowerCase()).toContain("never");
  });

  test("assessNetnsVethRoutedConnectPosture names CAP gap when veth cannot be created", () => {
    const fakeRun: DoctorRunFn = () => ({
      ok: false,
      status: 1,
      stdout: "",
      stderr: "Operation not permitted",
    });
    const posture = assessNetnsVethRoutedConnectPosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1", HZ_SANDBOX_EXEC_BIN: "/bin/true" },
      fakeRun,
    );
    expect(posture.kind).toBe("hermetic-routed-connect-unproven");
    expect(posture.detail.toLowerCase()).toContain("cap_net_admin");
    expect(posture.hermeticRoutedConnect).toBe(false);
  });

  test("hermetic veth TCP reach when CAP_NET_ADMIN available", async () => {
    if (!probeCapNetAdminForVeth(realRun)) return;
    const server = await new Promise<{ port: number; close: () => void }>((resolve, reject) => {
      const s = createServer((socket) => {
        socket.end("ok");
      });
      s.listen(0, "0.0.0.0", () => {
        const addr = s.address();
        if (addr === null || typeof addr === "string") {
          s.close();
          reject(new Error("no port"));
          return;
        }
        resolve({ port: addr.port, close: () => s.close() });
      });
      s.on("error", reject);
    });
    try {
      const reach = await attemptNetnsVethTcpReach(server.port, realRun);
      if (reach.ok) {
        const posture = postureFromHermeticReach(
          { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" },
          realRun,
          reach,
        );
        expect(posture.kind).toBe("hermetic-reach-ok");
        expect(posture.hermeticReach).toBe(true);
      } else {
        expect(reach.reason.length).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  test("hermetic routed CONNECT via bridge-IP proxy when CAP_NET_ADMIN available", async () => {
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
    try {
      const routed = await attemptNetnsVethRoutedConnectEgress(authority, realRun, startProxy);
      if (routed.ok) {
        const posture = postureFromHermeticRoutedConnect(
          { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" },
          realRun,
          routed,
        );
        expect(posture.kind).toBe("hermetic-routed-connect-ok");
        expect(posture.hermeticRoutedConnect).toBe(true);
        expect(posture.detail.toLowerCase()).not.toContain("enforced");
      } else if (!routed.skipped) {
        expect(routed.reason.length).toBeGreaterThan(0);
      }
    } finally {
      echo.close();
    }
  });
});
