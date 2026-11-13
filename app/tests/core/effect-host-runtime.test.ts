import { afterEach, describe, expect, test } from "bun:test";
import {
  applyEffectHostKernelFromUserConfig,
  applyEffectHostKernelSandboxDefault,
  parseEffectHostKernelConfig,
  sandboxWrapActiveForEffectHost,
} from "../../src/core/effect-host-runtime";
import { effectHostKernelMode } from "../../src/core/effect-kernel-mutation-route";
import { restoreEnv, setEnv, snapshotEnv } from "./helpers";

describe("effect-host-runtime (ruling 340)", () => {
  test("parseEffectHostKernelConfig", () => {
    expect(parseEffectHostKernelConfig("default")).toBe("default");
    expect(parseEffectHostKernelConfig("require")).toBe("require");
    expect(parseEffectHostKernelConfig("1")).toBe("default");
    expect(parseEffectHostKernelConfig("nope")).toBeUndefined();
  });

  test("applyEffectHostKernelFromUserConfig only when env unset", () => {
    const env: Record<string, string | undefined> = {};
    const applied = applyEffectHostKernelFromUserConfig({ effectHostKernel: "require" }, env);
    expect(applied.applied).toBe("config");
    expect(env.HZ_EFFECT_HOST_KERNEL).toBe("require");
    expect(effectHostKernelMode(env)).toBe("require");

    env.HZ_EFFECT_HOST_KERNEL = "1";
    const skip = applyEffectHostKernelFromUserConfig({ effectHostKernel: "default" }, env);
    expect(skip.applied).toBeUndefined();
    expect(env.HZ_EFFECT_HOST_KERNEL).toBe("1");
  });

  test("sandboxWrapActiveForEffectHost on Linux when require or exec", () => {
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_SANDBOX_REQUIRE: "1" });
      if (process.platform === "linux") {
        expect(sandboxWrapActiveForEffectHost(process.env)).toBe(true);
      }
      setEnv({ HZ_SANDBOX_REQUIRE: undefined, HZ_SANDBOX_EXEC: "1" });
      if (process.platform === "linux") {
        expect(sandboxWrapActiveForEffectHost(process.env)).toBe(true);
      }
      setEnv({ HZ_SANDBOX_EXEC: "0" });
      expect(sandboxWrapActiveForEffectHost(process.env, true)).toBe(false);
    } finally {
      restoreEnv(snap);
    }
  });

  test("applyEffectHostKernelSandboxDefault sets default when wrap active", () => {
  const snap = snapshotEnv();
  try {
      setEnv({ HZ_SANDBOX_EXEC: "1" });
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.HZ_EFFECT_HOST_KERNEL;
      const res =
        process.platform === "linux"
          ? applyEffectHostKernelSandboxDefault(env, false)
          : applyEffectHostKernelSandboxDefault(env, false);
      if (process.platform === "linux") {
        expect(res.applied).toBe("sandbox-default");
        expect(env.HZ_EFFECT_HOST_KERNEL).toBe("default");
        expect(res.notice).toContain("hzcode doctor");
      } else {
        expect(res.applied).toBeUndefined();
      }
    } finally {
      restoreEnv(snap);
    }
  });
});

describe("classifyShellKernelRouteMiss (ruling 340)", () => {
  test("named require reasons for compound and unparsed shell", async () => {
    const { classifyShellKernelRouteMiss, shellKernelRouteMissRequireDetail } = await import(
      "../../src/core/effect-kernel-mutation-route"
    );
    expect(classifyShellKernelRouteMiss("echo a && echo b")?.reason).toBe("compound");
    expect(classifyShellKernelRouteMiss("VAR=1 echo hi")?.reason).toBe("inline_env");
    const subst = classifyShellKernelRouteMiss("echo $(pwd)");
    expect(subst?.reason).toBe("unparsed");
    expect(shellKernelRouteMissRequireDetail(subst!)).toContain("command substitution");
    expect(classifyShellKernelRouteMiss("echo hi", { timeoutMs: 1000 })?.reason).toBe("timeout_arg");
  });
});
