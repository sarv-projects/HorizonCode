import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { netnsConnectDenialPosture } from "../../src/core/sandbox-netns-denial";
import { resolveSandboxExecBinary } from "../../src/core/kernel";

describe("netns CONNECT denial posture", () => {
  test("partial honesty when sandbox exec is available", () => {
    const bin = resolveSandboxExecBinary(process.env);
    const env: Record<string, string | undefined> = { HZ_SANDBOX_EXEC: "1" };
    if (bin !== undefined) env.HZ_SANDBOX_EXEC_BIN = bin;
    const p = netnsConnectDenialPosture(env);
    if (bin === undefined) {
      expect(p.honesty).toBe("off");
      return;
    }
    expect(p.honesty).toBe("partial");
    expect(p.detail.toLowerCase()).toContain("partial");
    expect(p.detail.toLowerCase()).toContain("never claim shell-net enforced");
  });

  test("off when HZ_SANDBOX_EXEC=0", () => {
    const p = netnsConnectDenialPosture({ HZ_SANDBOX_EXEC: "0" });
    expect(p.honesty).toBe("off");
    expect(p.netnsIsolationExpected).toBe(false);
  });

  test("hermetic: wrapped child cannot TCP CONNECT when binary present", () => {
    const bin = resolveSandboxExecBinary(process.env);
    if (bin === undefined || !existsSync(bin)) return;

    const probe = `
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("93.184.216.34", 80))
    print("CONNECTED")
except OSError as e:
    print("BLOCKED", getattr(e, "errno", e))
`;
    for (const childNet of ["off", undefined] as const) {
      const env: Record<string, string | undefined> = {};
      if (childNet === "off") env.HZ_SANDBOX_CHILD_NET = "off";
      const out = spawnSync(bin, ["--", "python3", "-c", probe], { encoding: "utf8", env: { ...process.env, ...env } });
      const combined = `${out.stdout}\n${out.stderr}`.toLowerCase();
      if (combined.includes("not found") || combined.includes("no such file")) return;
      expect(out.stdout).toContain("BLOCKED");
      expect(out.stdout).not.toContain("CONNECTED");
    }
  });
});
