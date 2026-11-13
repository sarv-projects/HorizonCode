import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveSandboxExecBinary } from "../../src/core/kernel";
import {
  assessNetnsParentProxyReachability,
  assessNetnsSpawnRoutedProxyWiring,
  deriveNetnsBridgeProxyUrl,
  mergeNetnsEgressProxySpawnEnv,
  netnsEgressNetnsProxyOptIn,
  netnsRoutedProxySpawnOptIn,
  proxyUrlTargetsParentLoopback,
} from "../../src/core/sandbox-netns-proxy";
import { VETH_HERMETIC_BRIDGE_HOST } from "../../src/core/sandbox-netns-veth";
import { runDoctor, type DoctorEnv, type SpawnResult } from "../../src/core/doctor";
import { mergeEgressProxyEnv } from "../../src/core/egress-env";

const OKRUN = (cmd: string): SpawnResult => ({ ok: true, status: 0, stdout: `${cmd} ok\n`, stderr: "" });

function doctorFakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    home: "/tmp",
    workspace: "/tmp/ws",
    env: { ...(over.env ?? process.env) },
    run: (cmd, _args) => OKRUN(cmd),
    ...over,
  };
}

function doctorById(checks: ReturnType<typeof runDoctor>, id: string) {
  const line = checks.find((c) => c.id === id);
  if (line === undefined) throw new Error(`missing doctor line ${id}`);
  return line;
}

describe("netns parent proxy reachability (ruling 289)", () => {
  test("loopback proxy URLs are detected", () => {
    expect(proxyUrlTargetsParentLoopback("http://127.0.0.1:3128")).toBe(true);
    expect(proxyUrlTargetsParentLoopback("http://10.0.0.2:3128")).toBe(false);
  });

  test("assess flags parent-loopback blocked under netns", () => {
    const bin = resolveSandboxExecBinary(process.env);
    const base: Record<string, string | undefined> = { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" };
    if (bin !== undefined) base.HZ_SANDBOX_EXEC_BIN = bin;
    const reach = assessNetnsParentProxyReachability({
      ...base,
      HZ_EGRESS_PROXY: "http://127.0.0.1:9",
    });
    if (bin === undefined) {
      expect(reach.kind).toBe("not-applicable");
      return;
    }
    expect(reach.kind).toBe("parent-loopback-blocked");
    expect(reach.detail.toLowerCase()).toContain("proxy_blocked");
  });

  test("HZ_EGRESS_NETNS_PROXY maps non-loopback endpoint into proxy env", () => {
    const merged = mergeEgressProxyEnv(
      mergeNetnsEgressProxySpawnEnv(
        {
          HZ_SANDBOX_EXEC: "1",
          HZ_SANDBOX_NETNS: "1",
          HZ_EGRESS_NETNS_PROXY: "1",
          HZ_EGRESS_NETNS_PROXY_ENDPOINT: "http://10.0.0.2:3128",
        },
        { sandboxWrapped: true },
      ),
    );
    expect(netnsEgressNetnsProxyOptIn({ HZ_EGRESS_NETNS_PROXY: "1" })).toBe(true);
    expect(merged.HZ_EGRESS_PROXY).toBe("http://10.0.0.2:3128");
    expect(merged.HTTP_PROXY).toBe("http://10.0.0.2:3128");
  });

  test("HZ_EGRESS_NETNS_PROXY_ROUTED derives bridge proxy for wrapped netns spawns (317)", () => {
    expect(
      deriveNetnsBridgeProxyUrl({
        HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
        HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
      }),
    ).toBe(`http://${VETH_HERMETIC_BRIDGE_HOST}:4317`);
    const merged = mergeEgressProxyEnv(
      mergeNetnsEgressProxySpawnEnv(
        {
          HZ_SANDBOX_EXEC: "1",
          HZ_SANDBOX_NETNS: "1",
          HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
          HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
          HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
        },
        { sandboxWrapped: true },
      ),
    );
    expect(netnsRoutedProxySpawnOptIn({ HZ_EGRESS_NETNS_PROXY_ROUTED: "1" })).toBe(true);
    expect(merged.HTTP_PROXY).toBe(`http://${VETH_HERMETIC_BRIDGE_HOST}:4317`);
    const wiring = assessNetnsSpawnRoutedProxyWiring({
      HZ_SANDBOX_EXEC: "1",
      HZ_SANDBOX_NETNS: "1",
      HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
      HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
      HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
    });
    expect(wiring.wired).toBe(true);
    expect(wiring.detail.toLowerCase()).toContain("not enforced");
  });

  test("routed proxy merge skipped when spawn is not sandbox-wrapped", () => {
    const merged = mergeNetnsEgressProxySpawnEnv(
      {
        HZ_SANDBOX_EXEC: "1",
        HZ_SANDBOX_NETNS: "1",
        HZ_EGRESS_NETNS_PROXY_ROUTED: "1",
        HZ_EGRESS_NETNS_BRIDGE_HOST: VETH_HERMETIC_BRIDGE_HOST,
        HZ_EGRESS_PROXY: "http://127.0.0.1:4317",
      },
      { sandboxWrapped: false },
    );
    expect(merged.HZ_EGRESS_PROXY).toBe("http://127.0.0.1:4317");
  });

  test("doctor egress.netns.proxy names parent-loopback blocked", () => {
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined) return;
    const line = doctorById(
      runDoctor(
        doctorFakeEnv({
          env: {
            ...doctorFakeEnv().env,
            HZ_SANDBOX_EXEC: "1",
            HZ_SANDBOX_EXEC_BIN: bin,
            HZ_SANDBOX_NETNS: "1",
            HZ_EGRESS_PROXY: "http://127.0.0.1:9",
          },
        }),
      ),
      "egress.netns.proxy",
    );
    expect(line.status).toBe("warn");
    expect(line.detail.toLowerCase()).toContain("parent-loopback blocked");
    expect(line.detail.toLowerCase()).toContain("never claim");
  });

  test("hermetic: netns child still blocks parent-loopback proxy TCP", () => {
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;
    const proxyProbe = `
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("127.0.0.1", 9))
    print("PROXY_REACHABLE")
except OSError:
    print("PROXY_BLOCKED")
`;
    const inNetns = spawnSync(bin, ["--", "python3", "-c", proxyProbe], {
      encoding: "utf8",
      env: { ...process.env, HZ_SANDBOX_CHILD_NET: "off" },
    });
    expect(inNetns.stdout).toContain("PROXY_BLOCKED");
    const reach = assessNetnsParentProxyReachability({
      HZ_SANDBOX_EXEC: "1",
      HZ_SANDBOX_EXEC_BIN: bin,
      HZ_SANDBOX_NETNS: "1",
      HZ_EGRESS_PROXY: "http://127.0.0.1:9",
    });
    expect(reach.kind).toBe("parent-loopback-blocked");
  });
});
