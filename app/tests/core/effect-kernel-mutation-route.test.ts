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
import { sha256Hex } from "../../src/contracts";
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
  test("multi-file exact apply_patch commits via one kernel fs.batch", async () => {
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
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("fs.batch");
      expect(readFileSync(path.join(workspace, "one.txt"), "utf8")).toBe("1\n");
      expect(readFileSync(path.join(workspace, "two.txt"), "utf8")).toBe("2\n");
      expect(lastChangeFor("s-ap-m", path.join(workspace, "one.txt"))?.before).toBeNull();
      expect(lastChangeFor("s-ap-m", path.join(workspace, "two.txt"))?.before).toBeNull();
    } finally {
      await kernel.close();
    }
  });

  test("multi-file exact Update+Add apply_patch uses fs.batch with pinned preimages", async () => {
    writeFileSync(path.join(workspace, "keep.txt"), "keep\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: keep.txt
@@
-keep
+KEEP
*** Add File: fresh.txt
+new
*** End Patch`;
    try {
      const captured: Array<{ kind?: string; ops?: Array<{ kind?: string; path?: string }> }> = [];
      const executeEffect = kernel.executeEffect.bind(kernel);
      (kernel as { executeEffect: typeof kernel.executeEffect }).executeEffect = async (req) => {
        const spec = (req.dispatch as { spec?: { ops?: Array<{ kind?: string; path?: string }> } })?.spec;
        captured.push({ kind: req.dispatch?.kind, ops: spec?.ops });
        return executeEffect(req);
      };
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap-batch", "eff-ap-batch", {
        input: patch,
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("fs.batch");
      // Ruling 552: single exact Update hunk → fs.edit; Add → fs.write in the same batch.
      expect(captured[0]?.kind).toBe("fs.batch");
      expect(captured[0]?.ops?.map((o) => `${o.kind}:${o.path}`)).toEqual([
        "fs.edit:keep.txt",
        "fs.write:fresh.txt",
      ]);
      expect(readFileSync(path.join(workspace, "keep.txt"), "utf8")).toBe("KEEP\n");
      expect(readFileSync(path.join(workspace, "fresh.txt"), "utf8")).toBe("new\n");
      expect(lastChangeFor("s-ap-batch", path.join(workspace, "keep.txt"))?.before).toBe("keep\n");
    } finally {
      await kernel.close();
    }
  });

  test("multi-file Move+Add apply_patch commits via kernel fs.batch rename (ruling 630)", async () => {
    writeFileSync(path.join(workspace, "src.txt"), "x\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: src.txt
*** Move to: dst.txt
@@
-x
+y
*** Add File: extra.txt
+z
*** End Patch`;
    try {
      const captured: Array<{ kind?: string; ops?: Array<{ kind?: string; path?: string; from?: string; to?: string }> }> = [];
      const executeEffect = kernel.executeEffect.bind(kernel);
      (kernel as { executeEffect: typeof kernel.executeEffect }).executeEffect = async (req) => {
        const spec = (req.dispatch as { spec?: { ops?: Array<{ kind?: string; path?: string; from?: string; to?: string }> } })?.spec;
        captured.push({ kind: req.dispatch?.kind, ops: spec?.ops });
        return executeEffect(req);
      };
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap-mix", "eff-ap-mix", {
        input: patch,
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("fs.batch");
      expect(captured[0]?.kind).toBe("fs.batch");
      expect(captured[0]?.ops?.some((o) => o.kind === "fs.rename" && o.from === "src.txt" && o.to === "dst.txt")).toBe(true);
      expect(captured[0]?.ops?.some((o) => o.kind === "fs.write" && o.path === "extra.txt")).toBe(true);
      expect(() => readFileSync(path.join(workspace, "src.txt"), "utf8")).toThrow();
      expect(readFileSync(path.join(workspace, "dst.txt"), "utf8")).toBe("y\n");
      expect(readFileSync(path.join(workspace, "extra.txt"), "utf8")).toBe("z\n");
    } finally {
      await kernel.close();
    }
  });

  test("multi-file Delete+Update apply_patch commits via kernel fs.batch delete (ruling 631)", async () => {
    writeFileSync(path.join(workspace, "gone.txt"), "x\n", "utf8");
    writeFileSync(path.join(workspace, "keep.txt"), "y\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Delete File: gone.txt
*** Update File: keep.txt
@@
-y
+Y
*** End Patch`;
    try {
      const captured: Array<{ kind?: string; ops?: Array<{ kind?: string; path?: string }> }> = [];
      const executeEffect = kernel.executeEffect.bind(kernel);
      (kernel as { executeEffect: typeof kernel.executeEffect }).executeEffect = async (req) => {
        const spec = (req.dispatch as { spec?: { ops?: Array<{ kind?: string; path?: string }> } })?.spec;
        captured.push({ kind: req.dispatch?.kind, ops: spec?.ops });
        return executeEffect(req);
      };
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-ap-del", "eff-ap-del", {
        input: patch,
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("fs.batch");
      expect(captured[0]?.ops?.some((o) => o.kind === "fs.delete" && o.path === "gone.txt")).toBe(true);
      expect(() => readFileSync(path.join(workspace, "gone.txt"), "utf8")).toThrow();
      expect(readFileSync(path.join(workspace, "keep.txt"), "utf8")).toBe("Y\n");
    } finally {
      await kernel.close();
    }
  });

  test("multi-file multi-hunk Update projects ordered fs.edit ops in one fs.batch (ruling 553)", async () => {
    writeFileSync(path.join(workspace, "multi.txt"), "alpha\nmiddle\nbeta\n", "utf8");
    writeFileSync(path.join(workspace, "other.txt"), "x\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+ALPHA
@@
-beta
+BETA
*** Update File: other.txt
@@
-x
+y
*** End Patch`;
    try {
      const captured: Array<{ kind?: string; ops?: Array<{ kind?: string; path?: string; oldString?: string }> }> =
        [];
      const executeEffect = kernel.executeEffect.bind(kernel);
      (kernel as { executeEffect: typeof kernel.executeEffect }).executeEffect = async (req) => {
        const spec = (req.dispatch as { spec?: { ops?: Array<{ kind?: string; path?: string; oldString?: string }> } })
          ?.spec;
        captured.push({ kind: req.dispatch?.kind, ops: spec?.ops });
        return executeEffect(req);
      };
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-mh-batch", "eff-mh-batch", {
        input: patch,
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("fs.batch");
      expect(captured[0]?.kind).toBe("fs.batch");
      expect(captured[0]?.ops?.map((o) => `${o.kind}:${o.path}:${o.oldString ?? ""}`)).toEqual([
        "fs.edit:multi.txt:alpha",
        "fs.edit:multi.txt:beta",
        "fs.edit:other.txt:x",
      ]);
      expect(readFileSync(path.join(workspace, "multi.txt"), "utf8")).toBe("ALPHA\nmiddle\nBETA\n");
      expect(readFileSync(path.join(workspace, "other.txt"), "utf8")).toBe("y\n");
    } finally {
      await kernel.close();
    }
  });

  test("same-file exact multi-hunk patch is one atomic file write", async () => {
    const initial = "alpha\nmiddle\nbeta\n";
    writeFileSync(path.join(workspace, "one.txt"), initial, "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: one.txt
@@
-alpha
+ALPHA
@@
-beta
+BETA
*** End Patch`;
    try {
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-atomic", "eff-atomic", { input: patch });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("one atomic kernel fs.write");
      expect(readFileSync(path.join(workspace, "one.txt"), "utf8")).toBe("ALPHA\nmiddle\nBETA\n");
      expect(lastChangeFor("s-atomic", path.join(workspace, "one.txt"))?.before).toBe(initial);
      expect(out?.kernelObserve.resultDigestStable).toBe(true);
    } finally {
      await kernel.close();
    }
  });

  test("same-file multi-hunk trim_end repair is one atomic write when EDIT_REPAIR=1 (ruling 646)", async () => {
    // Trailing spaces on disk; patch lines are trim_end-unique under repair.
    const initial = "alpha  \nmiddle\nbeta  \n";
    writeFileSync(path.join(workspace, "trim.txt"), initial, "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: trim.txt
@@
-alpha
+ALPHA
@@
-beta
+BETA
*** End Patch`;
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "0" });
      const refused = await tryKernelApplyPatchRoute(kernel, workspace, "s-trim-off", "eff-trim-off", {
        input: patch,
      });
      expect(refused?.result.ok).toBe(false);
      expect(readFileSync(path.join(workspace, "trim.txt"), "utf8")).toBe(initial);

      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-trim", "eff-trim", { input: patch });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("one atomic kernel fs.write");
      expect(readFileSync(path.join(workspace, "trim.txt"), "utf8")).toBe("ALPHA\nmiddle\nBETA\n");
    } finally {
      await kernel.close();
    }
  });

  test("multi-file Update with relative_indent hunks batches under EDIT_REPAIR (ruling 646)", async () => {
    writeFileSync(path.join(workspace, "a.ts"), "function f() {\n    const x = 1;\n}\n", "utf8");
    writeFileSync(path.join(workspace, "b.ts"), "function g() {\n    const y = 2;\n}\n", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    // Patch uses unindented old lines; unique relative_indent match on disk.
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-const x = 1;
+const x = 9;
*** Update File: b.ts
@@
-const y = 2;
+const y = 8;
*** End Patch`;
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-indent", "eff-indent", { input: patch });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("kernel fs.batch");
      expect(readFileSync(path.join(workspace, "a.ts"), "utf8")).toContain("const x = 9;");
      expect(readFileSync(path.join(workspace, "b.ts"), "utf8")).toContain("const y = 8;");
    } finally {
      await kernel.close();
    }
  });

  test("same-file second ambiguous hunk refuses before changing the first hunk", async () => {
    const original = "alpha\nrepeat\nmiddle\nrepeat\n";
    writeFileSync(path.join(workspace, "ambiguous.txt"), original, "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const patch = `*** Begin Patch
*** Update File: ambiguous.txt
@@
-alpha
+ALPHA
@@
-repeat
+REPLACED
*** End Patch`;
    try {
      const out = await tryKernelApplyPatchRoute(kernel, workspace, "s-amb", "eff-amb", { input: patch });
      expect(out?.result.ok).toBe(false);
      expect(out?.result.error).toContain("atomic kernel batch");
      expect(readFileSync(path.join(workspace, "ambiguous.txt"), "utf8")).toBe(original);
      expect(lastChangeFor("s-amb", path.join(workspace, "ambiguous.txt"))).toBeUndefined();
    } finally {
      await kernel.close();
    }
  });

  test("planned preimage digest blocks a stale write before any effect", async () => {
    writeFileSync(path.join(workspace, "stale.txt"), "changed", "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const out = await tryKernelWriteRoute(kernel, workspace, "s-stale", "eff-stale", {
        path: "stale.txt",
        content: "overwrite",
        expectedPreimageDigest: sha256Hex("old"),
      });
      expect(out?.result.ok).toBe(false);
      expect(out?.result.error).toContain("stale or unreadable expected preimage");
      expect(readFileSync(path.join(workspace, "stale.txt"), "utf8")).toBe("changed");
      expect(lastChangeFor("s-stale", path.join(workspace, "stale.txt"))).toBeUndefined();
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

  test("ast_edit multi-match updates a single file atomically with one digest", async () => {
    const original = "const a = 0;\nconst b = 0;\n";
    writeFileSync(path.join(workspace, "many.ts"), original, "utf8");
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const out = await tryKernelAstEditRoute(kernel, workspace, "s-ast-multi", "eff-ast-multi", {
        path: "many.ts",
        pat: "const $NAME = 0;",
        out: "let $NAME = 1;",
      });
      expect(out?.result.ok).toBe(true);
      expect(out?.result.output).toContain("2 structural matches committed via one atomic kernel fs.write");
      expect(readFileSync(path.join(workspace, "many.ts"), "utf8")).toBe("let a = 1;\nlet b = 1;\n");
      expect(lastChangeFor("s-ast-multi", path.join(workspace, "many.ts"))?.before).toBe(original);
      expect(out?.kernelObserve.resultDigestStable).toBe(true);
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
