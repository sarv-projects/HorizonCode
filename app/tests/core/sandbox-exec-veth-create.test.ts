import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assessSandboxExecVethCreatePosture,
  assessSandboxExecVethCreateSpawnWiring,
  mergeSandboxExecVethCreateSpawnEnv,
  sandboxExecVethCreateRequested,
  sandboxExecVethJoinAlsoRequested,
  sandboxExecVethPlumbEnvWithoutCreate,
} from "../../src/core/sandbox-exec-veth-create";
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

describe("sandbox-exec-veth-create posture", () => {
  test("create flag and mutual exclusion posture", () => {
    expect(sandboxExecVethCreateRequested({ HZ_SANDBOX_VETH_CREATE: "1" })).toBe(true);
    expect(sandboxExecVethCreateRequested({ HZ_SANDBOX_VETH_CREATE: "0" })).toBe(false);
    expect(sandboxExecVethJoinAlsoRequested({ HZ_SANDBOX_VETH_JOIN: "1" })).toBe(true);
    const p = assessSandboxExecVethCreatePosture(
      {
        HZ_SANDBOX_EXEC: "1",
        HZ_SANDBOX_NETNS: "1",
        HZ_SANDBOX_VETH_CREATE: "1",
        HZ_SANDBOX_VETH_JOIN: "1",
      },
      doctorRun,
    );
    expect(p.kind).toBe("create-mutually-exclusive");
    expect(p.detail.toLowerCase()).not.toContain("enforced");
  });

  test("spawnOwned merge wires CREATE+HOST/PEER for wrapped only (ruling 330)", () => {
    const base = {
      HZ_SANDBOX_VETH_CREATE: "1",
      HZ_SANDBOX_VETH_HOST: "hz-h",
      HZ_SANDBOX_VETH_PEER: "hz-p",
      OTHER: "keep",
    };
    const wrapped = mergeSandboxExecVethCreateSpawnEnv(base, { sandboxWrapped: true });
    expect(wrapped.HZ_SANDBOX_VETH_CREATE).toBe("1");
    expect(wrapped.HZ_SANDBOX_VETH_HOST).toBe("hz-h");
    expect(wrapped.HZ_SANDBOX_VETH_PEER).toBe("hz-p");
    expect(wrapped.OTHER).toBe("keep");
    const unwrapped = mergeSandboxExecVethCreateSpawnEnv(base, { sandboxWrapped: false });
    expect(unwrapped.HZ_SANDBOX_VETH_CREATE).toBeUndefined();
    expect(unwrapped.HZ_SANDBOX_VETH_HOST).toBeUndefined();
    expect(unwrapped.OTHER).toBe("keep");
    const wire = assessSandboxExecVethCreateSpawnWiring(
      { HZ_SANDBOX_VETH_CREATE: "1" },
      { sandboxWrapped: true },
    );
    expect(wire.wired).toBe(true);
    expect(wire.detail.toLowerCase()).toContain("never claim enforced");
    const mutex = assessSandboxExecVethCreateSpawnWiring(
      { HZ_SANDBOX_VETH_CREATE: "1", HZ_SANDBOX_VETH_JOIN: "1" },
      { sandboxWrapped: true },
    );
    expect(mutex.wired).toBe(false);
    expect(mutex.detail.toLowerCase()).toMatch(/fail closed|fails closed/);
  });

  test("addr without create is fail-closed posture", () => {
    expect(
      sandboxExecVethPlumbEnvWithoutCreate({
        HZ_SANDBOX_VETH_PEER_ADDR: "10.199.0.1/30",
      }),
    ).toBe(true);
    const p = assessSandboxExecVethCreatePosture(
      {
        HZ_SANDBOX_EXEC: "1",
        HZ_SANDBOX_NETNS: "1",
        HZ_SANDBOX_VETH_HOST_ADDR: "10.199.0.2/30",
      },
      doctorRun,
    );
    expect(p.kind).toBe("addr-without-create");
    expect(p.detail.toLowerCase()).not.toContain("enforced");
  });

  test("doctor posture never claims enforced when create off", () => {
    const p = assessSandboxExecVethCreatePosture(
      { HZ_SANDBOX_EXEC: "1", HZ_SANDBOX_NETNS: "1" },
      doctorRun,
    );
    expect(p.kind).toBe("create-off-default");
    expect(p.detail.toLowerCase()).toContain("never claim enforced");
  });

  test("hz-sandbox-exec veth create fail-closed with join+create", () => {
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
          HZ_SANDBOX_VETH_CREATE: "1",
          HZ_SANDBOX_VETH_JOIN: "1",
          HZ_SANDBOX_VETH_NETNS: "hz-mutual-exclusive",
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
