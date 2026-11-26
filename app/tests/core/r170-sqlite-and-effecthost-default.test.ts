import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PROJECT_BANK } from "../../src/core/memory/banks";
import { memoryRememberTool, memoryForgetTool } from "../../src/tools/memory-write";
import { handoffCreateTool } from "../../src/tools/handoff";
import { mockToolContext } from "../tools/helpers";
import {
  applyEffectHostKernelTrustedDefault,
  applyEffectHostKernelTrustedRequire,
} from "../../src/core/effect-host-runtime";
import { effectHostKernelMode } from "../../src/core/effect-kernel-mutation-route";

describe("R170 SQLite & EffectHost Trusted Default (Ruling 887)", () => {
  let workspace = "";

  afterEach(() => {
    if (workspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on Windows
      }
    }
    workspace = "";
    delete process.env.HZ_EFFECT_R170_BUN;
    delete process.env.HZ_EFFECT_HOST_KERNEL;
  });

  test("memory_remember and memory_forget acquire R170 workspace fence", async () => {
    process.env.HZ_EFFECT_R170_BUN = "1";
    process.env.HZ_EFFECT_HOST_KERNEL = "default";

    workspace = mkdtempSync(path.join(tmpdir(), "hz-r170-mem-"));
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });

    // 1. Remember fact under R170 fence
    const remResult = await memoryRememberTool.execute(
      { content: "r170 sqlite fence verification fact", bank: "project" },
      ctx,
    );
    expect(remResult.ok).toBe(true);
    expect(remResult.output).toContain("remembered in bank project");

    // 2. Forget fact under R170 fence
    const forResult = await memoryForgetTool.execute(
      { content: "r170 sqlite fence verification fact", bank: "project" },
      ctx,
    );
    expect(forResult.ok).toBe(true);
    expect(forResult.output).toContain("forgot ");
    expect(forResult.output).toContain("fact(s) in bank project");
  });

  test("handoff_create serializes under R170 workspace fence", async () => {
    process.env.HZ_EFFECT_R170_BUN = "1";
    process.env.HZ_EFFECT_HOST_KERNEL = "default";

    workspace = mkdtempSync(path.join(tmpdir(), "hz-r170-hnd-"));
    const ctx = mockToolContext({ workspace, cwd: workspace, decision: "allow" });

    const result = await handoffCreateTool.execute(
      {
        summary: "verified R170 handoff create",
        next: ["run tests", "verify ceiling"],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("id:");
    expect(result.output).toContain("branch:");
  });

  test("applyEffectHostKernelTrustedDefault sets default when kernel trusted and env unset", () => {
    const env: Record<string, string | undefined> = {};
    const res = applyEffectHostKernelTrustedDefault(env, true);
    expect(res.applied).toBe("trusted-default");
    expect(env.HZ_EFFECT_HOST_KERNEL).toBe("default");
    expect(effectHostKernelMode(env)).toBe("default");
    expect(res.notice).toContain("trusted Rust kernel active");

    // Preserves explicit env
    const explicitEnv = { HZ_EFFECT_HOST_KERNEL: "require" };
    expect(applyEffectHostKernelTrustedDefault(explicitEnv, true).applied).toBeUndefined();
    expect(explicitEnv.HZ_EFFECT_HOST_KERNEL).toBe("require");
  });
});
