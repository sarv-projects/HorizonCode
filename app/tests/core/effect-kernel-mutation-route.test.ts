/**
 * effect-kernel-mutation-route.test.ts — HZ_EFFECT_HOST_KERNEL write/edit/shell (rulings 278, 280, 281).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  editArgsEligibleForKernelRoute,
  effectHostKernelMode,
  effectHostKernelMutationEnabled,
  effectHostKernelRequireMode,
  kernelExecuteObserveFromResult,
  shellArgsEligibleForKernelRoute,
  simpleShellArgvFromCommand,
  tryKernelApplyPatchRoute,
  tryKernelAstEditRoute,
  tryKernelEditRoute,
  tryKernelShellRoute,
  tryKernelWriteRoute,
  writeArgsEligibleForKernelRoute,
} from "../../src/core/effect-kernel-mutation-route";
import { computeReceiptPostimageFromKernel, receiptPostimageFields } from "../../src/core/receipt-postimage";
import { KernelClient } from "../../src/core/kernel";
import { __resetJournalForTests, lastChangeFor } from "../../src/tools/change-journal";
import { restoreEnv, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;
let envBackup: EnvSnapshot;

beforeEach(() => {
  envBackup = snapshotEnv();
  workspace = mkdtempSync(path.join(tmpdir(), "hz-kernel-mut-"));
  __resetJournalForTests();
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  restoreEnv(envBackup);
});

describe("effectHostKernelMutationEnabled", () => {
  test("off by default", () => {
    delete process.env.HZ_EFFECT_HOST_KERNEL;
    expect(effectHostKernelMutationEnabled()).toBe(false);
  });
  test("on for 1/true/yes", () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "1" });
    expect(effectHostKernelMutationEnabled()).toBe(true);
    setEnv({ HZ_EFFECT_HOST_KERNEL: "true" });
    expect(effectHostKernelMutationEnabled()).toBe(true);
  });
  test("require is opt-in routing plus fail-closed gate", () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "require" });
    expect(effectHostKernelMode()).toBe("require");
    expect(effectHostKernelMutationEnabled()).toBe(true);
    expect(effectHostKernelRequireMode()).toBe(true);
  });
  test("default enables routing like opt-in (ruling 299)", () => {
    setEnv({ HZ_EFFECT_HOST_KERNEL: "default" });
    expect(effectHostKernelMode()).toBe("default");
    expect(effectHostKernelMutationEnabled()).toBe(true);
    expect(effectHostKernelRequireMode()).toBe(false);
  });
});

describe("kernel write/edit route", () => {
  test("write via local kernel fallback", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const sessionId = "s-kernel-write";
      const out = await tryKernelWriteRoute(kernel, workspace, sessionId, "eff-w", {
        path: "note.txt",
        content: "kernel-route",
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.journalRecordFailed).toBeFalsy();
      expect(out?.journalSkipped).toBe(false);
      expect(readFileSync(path.join(workspace, "note.txt"), "utf8")).toBe("kernel-route");
      const resolved = path.join(workspace, "note.txt");
      const entry = lastChangeFor(sessionId, resolved);
      expect(entry?.tool).toBe("write");
      expect(entry?.before).toBe(null);
      expect(entry?.afterSha256).toBe(out!.kernelObserve.contentDigest);
      expect(out?.kernelObserve.contentDigest).toBeDefined();
      expect(out?.kernelObserve.postimageObservationStable).not.toBe(false);
      expect(out?.kernelObserve.resultDigestStable).toBe(true);
      const postimage = computeReceiptPostimageFromKernel(
        "write",
        { path: "note.txt" },
        workspace,
        true,
        out!.kernelObserve,
      );
      expect(receiptPostimageFields(postimage)?.postimageDigest).toBe(out!.kernelObserve.contentDigest);
    } finally {
      await kernel.close();
    }
  });

  test("edit via local kernel fallback", async () => {
    writeFileSync(path.join(workspace, "src.txt"), "one-two", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const sessionId = "s-kernel-edit";
      const out = await tryKernelEditRoute(kernel, workspace, sessionId, "eff-e", {
        path: "src.txt",
        old: "two",
        new: "THREE",
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.journalRecordFailed).toBeFalsy();
      expect(readFileSync(path.join(workspace, "src.txt"), "utf8")).toBe("one-THREE");
      const entry = lastChangeFor(sessionId, path.join(workspace, "src.txt"));
      expect(entry?.tool).toBe("edit");
      expect(entry?.before).toBe("one-two");
    } finally {
      await kernel.close();
    }
  });

  test("edit ineligible when anchored", () => {
    expect(
      editArgsEligibleForKernelRoute({ path: "a", old: "x", new: "y", start_anchor: "LINE:1:1" }),
    ).toBe(false);
    expect(writeArgsEligibleForKernelRoute({ path: "a", content: "c" })).toBe(true);
  });
});

describe("kernel shell argv route", () => {
  test("parses simple argv-only command", () => {
    expect(simpleShellArgvFromCommand("echo hello")).toEqual(["echo", "hello"]);
    expect(simpleShellArgvFromCommand('printf "%s" hi')).toEqual(["printf", "%s", "hi"]);
    expect(simpleShellArgvFromCommand("echo a && echo b")).toBeUndefined();
    expect(simpleShellArgvFromCommand("bash -c 'echo hi'")).toBeUndefined();
  });

  test("shell eligibility refuses compound shell strings", () => {
    expect(shellArgsEligibleForKernelRoute({ command: "true" })).toBe(true);
    expect(shellArgsEligibleForKernelRoute({ command: "echo a | wc" })).toBe(false);
    expect(shellArgsEligibleForKernelRoute({ command: "echo a", timeoutMs: 1000 })).toBe(false);
  });

  test("shell via local kernel fallback", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const out = await tryKernelShellRoute(kernel, workspace, "eff-sh", { command: "pwd" });
      expect(out?.result.ok).toBe(true);
      expect(out?.kernelObserve.exitCode).toBe(0);
      expect(out?.kernelObserve.stdoutDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(out?.kernelObserve.resultDigestStable).toBe(true);
    } finally {
      await kernel.close();
    }
  });
});

describe("kernel apply_patch / ast_edit route", () => {
  test("multi-op apply_patch refuses before the first kernel write until batch is atomic", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Add File: one.txt
+1
*** Add File: two.txt
+2
*** End Patch`;
    try {
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap-m", "eff-ap-m", { input: patch });
      expect(out?.result.ok).toBe(false);
      expect(out?.result.error).toContain("atomic kernel batch");
      expect(() => readFileSync(path.join(workspace, "one.txt"), "utf8")).toThrow();
      expect(() => readFileSync(path.join(workspace, "two.txt"), "utf8")).toThrow();
      expect(lastChangeFor("s-ap-m", path.join(workspace, "two.txt"))).toBeUndefined();
    } finally {
      await kernel.close();
    }
  });

  test("multi-op apply_patch fails closed on first kernel edit miss", async () => {
    writeFileSync(path.join(workspace, "ok.txt"), "keep\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Add File: fresh.txt
+new
*** Update File: ok.txt
@@
-missing
+edit
*** End Patch`;
    try {
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap-fail", "eff-ap-fail", { input: patch });
      expect(out?.result.ok).toBe(false);
      expect(out?.result.error).toContain("atomic kernel batch");
      expect(() => readFileSync(path.join(workspace, "fresh.txt"), "utf8")).toThrow();
      expect(readFileSync(path.join(workspace, "ok.txt"), "utf8")).toBe("keep\n");
    } finally {
      await kernel.close();
    }
  });

  test("apply_patch add file via kernel write", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Add File: via-patch.txt
+kernel
*** End Patch`;
    try {
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap", "eff-ap", { input: patch });
      expect(out?.result.ok).toBe(true);
      expect(readFileSync(path.join(workspace, "via-patch.txt"), "utf8")).toBe("kernel\n");
    } finally {
      await kernel.close();
    }
  });

  test("ast_edit literal via kernel edit", async () => {
    writeFileSync(path.join(workspace, "lit.ts"), "const v = 0;\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const out = await tryKernelAstEditRoute(kernel, workspace, "s-ae", "eff-ae", {
        path: "lit.ts",
        pat: "const",
        out: "let",
      });
      expect(out?.result.ok).toBe(true);
      expect(readFileSync(path.join(workspace, "lit.ts"), "utf8")).toContain("let v");
    } finally {
      await kernel.close();
    }
  });

  test("ast_edit variadic $$$ unique match via kernel edit (ruling 320)", async () => {
    writeFileSync(path.join(workspace, "variadic.ts"), "call(a, b);\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const out = await tryKernelAstEditRoute(kernel, workspace, "s-ae-v", "eff-ae-v", {
        path: "variadic.ts",
        pat: "call($$$A)",
        out: "invoke($$$A)",
      });
      expect(out?.result.ok).toBe(true);
      expect(readFileSync(path.join(workspace, "variadic.ts"), "utf8")).toBe("invoke(a, b);\n");
    } finally {
      await kernel.close();
    }
  });
});

describe("kernelExecuteObserveFromResult", () => {
  test("maps postimage fields for receipts", () => {
    const snap = kernelExecuteObserveFromResult({
      verdict: "settled",
      effectId: "e1",
      phases: ["allow", "execute", "observe"],
      contentDigest: "abc",
      postimageObservationStable: true,
    });
    expect(snap.contentDigest).toBe("abc");
    expect(snap.postimageObservationStable).toBe(true);
  });
});
