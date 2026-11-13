import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applySandboxChildNetFromConfig,
  mergeSandboxChildNetSpawnEnv,
  parseSandboxChildNet,
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
});
