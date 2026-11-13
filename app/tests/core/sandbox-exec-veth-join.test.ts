import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assessSandboxExecVethJoinPosture,
  assessSandboxExecVethJoinSpawnWiring,
  mergeSandboxExecVethJoinSpawnEnv,
  resolveSandboxExecVethNetnsPath,
  sandboxExecVethJoinRequested,
} from "../../src/core/sandbox-exec-veth-join";
import type { SpawnResult } from "../../src/core/doctor";

const ROOT = path.resolve(import.meta.dir, "../../..");

function doctorRun(cmd: string, args: string[], _timeoutMs: number): SpawnResult {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 8_000 });
    return { ok: true, stdout: out, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      exitCode: e.status,
    };
  }
}

describe("sandbox-exec-veth-join posture", () => {
  test("join flag and netns path resolver", () => {
    expect(sandboxExecVethJoinRequested({ HZ_SANDBOX_VETH_JOIN: "1" })).toBe(true);
    expect(sandboxExecVethJoinRequested({ HZ_SANDBOX_VETH_JOIN: "0" })).toBe(false);
    expect(resolveSandboxExecVethNetnsPath({ HZ_SANDBOX_VETH_NETNS: "hz-child-ns" })).toBe(
      "/var/run/netns/hz-child-ns",
    );
    expect(resolveSandboxExecVethNetnsPath({ HZ_SANDBOX_VETH_NETNS: "/tmp/ns-fd" })).toBe("/tmp/ns-fd");
  });

  test("doctor posture never claims enforced", () => {
    const p = assessSandboxExecVethJoinPosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1", HZ_SANDBOX_VETH_JOIN: "1" },
      doctorRun,
    );
    expect(p.joinRequested).toBe(true);
    expect(p.kind).toBe("join-unconfigured");
    expect(p.detail.toLowerCase()).toMatch(/fail closed|fails closed/);
    expect(p.detail.toLowerCase()).not.toContain("enforced");
  });

  test("spawnOwned merge wires JOIN+NETNS for wrapped only (ruling 325)", () => {
    const base = {
      HZ_SANDBOX_VETH_JOIN: "1",
      HZ_SANDBOX_VETH_NETNS: "hz-child-ns",
      OTHER: "keep",
    };
    const wrapped = mergeSandboxExecVethJoinSpawnEnv(base, { sandboxWrapped: true });
    expect(wrapped.HZ_SANDBOX_VETH_JOIN).toBe("1");
    expect(wrapped.HZ_SANDBOX_VETH_NETNS).toBe("hz-child-ns");
    expect(wrapped.OTHER).toBe("keep");
    const unwrapped = mergeSandboxExecVethJoinSpawnEnv(base, { sandboxWrapped: false });
    expect(unwrapped.HZ_SANDBOX_VETH_JOIN).toBeUndefined();
    expect(unwrapped.HZ_SANDBOX_VETH_NETNS).toBeUndefined();
    expect(unwrapped.OTHER).toBe("keep");
    const auto = mergeSandboxExecVethJoinSpawnEnv(
      { HZ_SANDBOX_VETH_JOIN: "1", HZ_SANDBOX_VETH_NETNS_AUTO: "1" },
      { sandboxWrapped: true },
    );
    expect(auto.HZ_SANDBOX_VETH_NETNS).toBe("hz-veth-reach-ns");
    const wire = assessSandboxExecVethJoinSpawnWiring(
      { HZ_SANDBOX_VETH_JOIN: "1", HZ_SANDBOX_VETH_NETNS: "hz-child-ns" },
      { sandboxWrapped: true },
    );
    expect(wire.wired).toBe(true);
    expect(wire.detail.toLowerCase()).toContain("never claim enforced");
    const mutex = assessSandboxExecVethJoinSpawnWiring(
      { HZ_SANDBOX_VETH_JOIN: "1", HZ_SANDBOX_VETH_NETNS: "hz-child-ns", HZ_SANDBOX_VETH_CREATE: "1" },
      { sandboxWrapped: true },
    );
    expect(mutex.wired).toBe(false);
    expect(mutex.detail.toLowerCase()).toMatch(/fail closed|fails closed/);
  });

  test("hz-sandbox-exec veth join fail-closed without netns (hermetic spawn)", () => {
    const bin =
      process.env.HZ_SANDBOX_EXEC_BIN ??
      path.join(ROOT, "kernel/target/debug/hz-sandbox-exec");
    let stdout = "";
    let status = 1;
    try {
      stdout = execFileSync(bin, ["--", "python3", "-c", "print('RAN')"], {
        env: {
          ...process.env,
          HZ_SANDBOX_CHILD_NET: "off",
          HZ_SANDBOX_VETH_JOIN: "1",
        },
        encoding: "utf8",
      });
      status = 0;
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? "";
      status = e.status ?? 1;
    }
    expect(status).not.toBe(0);
    expect(stdout).not.toContain("RAN");
  });
});
