import { describe, expect, test } from "bun:test";
import {
  DENY_PROBE_SCRIPT,
  proveContainerDefaultDeny,
  type ContainerDenyOptions,
} from "../../src/core/sandbox-container-deny";

function stub(opts: { runtime?: "docker" | "podman"; status?: number; stdout?: string; stderr?: string }): ContainerDenyOptions {
  return {
    run: (cmd, args) => {
      if (cmd === "sh" && args[0] === "-c") {
        const probe = args[1] ?? "";
        if (opts.runtime === "podman") return { status: probe.includes("podman") ? 0 : 1, stdout: "", stderr: "" };
        return { status: probe.includes("docker") ? 0 : 1, stdout: "", stderr: "" };
      }
      return { status: opts.status ?? 0, stdout: opts.stdout ?? "DENIED\n", stderr: opts.stderr ?? "" };
    },
  };
}

describe("J-3 real-container default-deny proof", () => {
  test("no runtime fails closed, never enforced", () => {
    const r = proveContainerDefaultDeny({
      run: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    expect(r.available).toBe(false);
    expect(r.enforced).toBe(false);
    expect(r.detail).toContain("never claim");
  });

  test("proof requires --network none and the in-container denial marker", () => {
    const r = proveContainerDefaultDeny(stub({ runtime: "docker" }));
    expect(r.enforced).toBe(true);
    expect(r.runtime).toBe("docker");
    expect(r.argv).toEqual([
      "run", "--rm", "--network", "none", "alpine:3.20", "sh", "-c", DENY_PROBE_SCRIPT,
    ]);
  });

  test("podman works too when docker is absent", () => {
    const r = proveContainerDefaultDeny(stub({ runtime: "podman" }));
    expect(r.enforced).toBe(true);
    expect(r.runtime).toBe("podman");
  });

  test("setup failure, REACHABLE and inconclusive output all fail closed", () => {
    expect(proveContainerDefaultDeny(stub({ runtime: "docker", status: 125 })).enforced).toBe(false);
    expect(proveContainerDefaultDeny(stub({ runtime: "docker", stdout: "REACHABLE\n" })).enforced).toBe(false);
    expect(proveContainerDefaultDeny(stub({ runtime: "docker", stdout: "unknown\n" })).enforced).toBe(false);
  });
});

describe.skipIf(process.env.HZ_LIVE_CONTAINER !== "1")("J-3 live container proof", () => {
  test("only passes on a host with a real container runtime", () => {
    const r = proveContainerDefaultDeny();
    if (!r.available) {
      // This host (WSL2, EPERM on unshare, no daemon) must refuse, not fake.
      expect(r.enforced).toBe(false);
      return;
    }
    expect(r.enforced).toBe(true);
  });
});
