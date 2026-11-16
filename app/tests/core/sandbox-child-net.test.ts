import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applySandboxChildNetFromConfig,
  mergeSandboxChildNetSpawnEnv,
  parseSandboxChildNet,
  resolveSandboxChildNet,
  signalsIndicateWsl,
  WSL_CHILD_NET_NOTICE,
} from "../../src/core/sandbox-child-net";

describe("sandbox child net env", () => {
  test("parseSandboxChildNet", () => {
    expect(parseSandboxChildNet("off")).toBe("off");
    expect(parseSandboxChildNet("ON")).toBe("on");
    expect(parseSandboxChildNet("maybe")).toBeUndefined();
  });

  test("applySandboxChildNetFromConfig sets env when unset", () => {
    const env: Record<string, string | undefined> = {};
    applySandboxChildNetFromConfig({ sandboxChildNet: "off" }, env);
    expect(env.HZ_SANDBOX_CHILD_NET).toBe("off");
    env.HZ_SANDBOX_CHILD_NET = "on";
    applySandboxChildNetFromConfig({ sandboxChildNet: "off" }, env);
    expect(env.HZ_SANDBOX_CHILD_NET).toBe("on");
  });

  const prev = process.env;
  afterEach(() => {
    process.env = prev;
  });

  test("mergeSandboxChildNetSpawnEnv propagates parent off", () => {
    process.env = { ...prev, HZ_SANDBOX_CHILD_NET: "off" };
    const merged = mergeSandboxChildNetSpawnEnv({});
    expect(merged.HZ_SANDBOX_CHILD_NET).toBe("off");
  });

  test("WSL is detected from either host signal, case-insensitively", () => {
    expect(signalsIndicateWsl("5.15.153.1-microsoft-standard-WSL2", undefined)).toBe(true);
    expect(signalsIndicateWsl(undefined, "Linux version ... (Microsoft@...)")).toBe(true);
    expect(signalsIndicateWsl("6.8.0-generic", "Linux version 6.8.0")).toBe(false);
    expect(signalsIndicateWsl(undefined, undefined)).toBe(false);
  });

  test("WSL defaults child net to on, visibly; an explicit value always wins", () => {
    const auto = resolveSandboxChildNet({ env: {}, wsl: true });
    expect(auto.mode).toBe("on");
    expect(auto.source).toBe("wsl-default");
    expect(auto.wslDefaultChildNet).toBe(true);
    expect(auto.notices).toEqual([WSL_CHILD_NET_NOTICE]);
    expect(auto.notices[0]).toContain("NOT confined");

    const explicitOff = resolveSandboxChildNet({ env: { HZ_SANDBOX_CHILD_NET: "off" }, wsl: true });
    expect(explicitOff.mode).toBe("off");
    expect(explicitOff.source).toBe("explicit");
    expect(explicitOff.wslDefaultChildNet).toBe(false);

    const explicitOn = resolveSandboxChildNet({ env: { HZ_SANDBOX_CHILD_NET: "on" }, wsl: false });
    expect(explicitOn.mode).toBe("on");
    expect(explicitOn.source).toBe("explicit");
    expect(explicitOn.wslDefaultChildNet).toBe(false);
  });

  test("non-WSL default is an explicit network-off", () => {
    const net = resolveSandboxChildNet({ env: {}, wsl: false });
    expect(net.mode).toBe("off");
    expect(net.source).toBe("default");
    expect(net.wslDefaultChildNet).toBe(false);
    expect(net.notices).toEqual([]);
  });

  test("an unrecognised explicit value requests isolation, never the WSL default", () => {
    const typo = resolveSandboxChildNet({ env: { HZ_SANDBOX_CHILD_NET: "of" }, wsl: true });
    expect(typo.mode).toBe("off");
    expect(typo.source).toBe("explicit");
    expect(typo.wslDefaultChildNet).toBe(false);
  });
});
