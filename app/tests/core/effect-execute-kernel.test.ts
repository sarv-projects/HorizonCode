/**
 * effect-execute-kernel.test.ts — kernel effect.execute stub (ruling 243, **267** fs.read, **275** fs.write, **277** fs.edit, **278** shell.exec).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KernelClient } from "../../src/core/kernel";
import { hasRustKernel, restoreEnv, rustKernelPath, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-eff-exec-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("kernel effect.execute", () => {
  test("hermetic pure settles over trusted kernel", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-pure-1",
        dispatch: { kind: "pure" },
      });
      expect(result.verdict).toBe("settled");
      expect(result.phases).toEqual(["allow", "execute", "observe"]);
    } finally {
      await kernel.close();
    }
  });

  test("fs.read under sandboxRoot returns contentDigest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-"));
    writeFileSync(path.join(sandbox, "note.txt"), "kernel-read", "utf8");
    const expected = createHash("sha256").update("kernel-read").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-read-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.read", spec: { path: "note.txt" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
      expect(result.readPath).toContain("note.txt");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.read escape outside sandboxRoot fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-esc-"));
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-read-esc",
          sandboxRoot: sandbox,
          dispatch: { kind: "fs.read", spec: { path: "../outside" } },
        }),
      ).rejects.toThrow(/sandboxRoot/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel fs.read returns contentDigest", async () => {
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-trusted-"));
    writeFileSync(path.join(sandbox, "note.txt"), "rust-read", "utf8");
    const expected = createHash("sha256").update("rust-read").digest("hex");
    try {
      await kernel.start();
      expect(kernel.mode).toBe("trusted");
      const result = await kernel.executeEffect({
        effectId: "eff-read-trusted",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.read", spec: { path: "note.txt" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(envBackup);
    }
  });

  test("mutating fs.write without sandboxRoot fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-mut",
          dispatch: { kind: "fs.write", spec: { path: "x", text: "y" } },
        }),
      ).rejects.toThrow(/HZ_PRECONDITION_FAILED/);
    } finally {
      await kernel.close();
    }
  });

  test("fs.write under sandboxRoot returns postimage contentDigest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-write-"));
    const expected = createHash("sha256").update("kernel-write").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-write-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.write", spec: { path: "out.txt", text: "kernel-write" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
      expect(result.postimageObservationStable).toBe(true);
      expect(result.resultDigestStable).toBe(true);
      expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(path.join(sandbox, "out.txt"), "utf8")).toBe("kernel-write");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.write escape outside sandboxRoot fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-write-esc-"));
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-write-esc",
          sandboxRoot: sandbox,
          dispatch: { kind: "fs.write", spec: { path: "../outside", text: "x" } },
        }),
      ).rejects.toThrow(/sandboxRoot/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.rename under sandboxRoot moves file with postimage digest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-ren-"));
    writeFileSync(path.join(sandbox, "src.txt"), "payload", "utf8");
    const expected = createHash("sha256").update("payload", "utf8").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-ren-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.rename", spec: { from: "src.txt", to: "dest.txt" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
      expect(result.postimageObservationStable).toBe(true);
      expect(result.resultDigestStable).toBe(true);
      expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(() => readFileSync(path.join(sandbox, "src.txt"))).toThrow();
      expect(readFileSync(path.join(sandbox, "dest.txt"), "utf8")).toBe("payload");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.delete under sandboxRoot removes file with empty digest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-del-"));
    writeFileSync(path.join(sandbox, "gone.txt"), "bye", "utf8");
    const empty = createHash("sha256").update("").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-del-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.delete", spec: { path: "gone.txt" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(empty);
      expect(result.postimageObservationStable).toBe(true);
      expect(result.resultDigestStable).toBe(true);
      expect(result.resultDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(() => readFileSync(path.join(sandbox, "gone.txt"))).toThrow();
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.edit under sandboxRoot returns postimage contentDigest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-edit-"));
    writeFileSync(path.join(sandbox, "src.txt"), "hello-world", "utf8");
    const expected = createHash("sha256").update("hello-horizon", "utf8").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-edit-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.edit", spec: { path: "src.txt", oldString: "world", newString: "horizon" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
      expect(result.postimageObservationStable).toBe(true);
      expect(readFileSync(path.join(sandbox, "src.txt"), "utf8")).toBe("hello-horizon");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("fs.edit trim repair behind HZ_EFFECT_HOST_EDIT_REPAIR", async () => {
    const snap = snapshotEnv();
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-edit-trim-"));
    writeFileSync(path.join(sandbox, "src.txt"), "  hello  ", "utf8");
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const result = await kernel.executeEffect({
        effectId: "eff-edit-trim",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.edit", spec: { path: "src.txt", oldString: "  hello  ", newString: "bye" } },
      });
      expect(result.verdict).toBe("settled");
      expect(readFileSync(path.join(sandbox, "src.txt"), "utf8")).toBe("bye");
    } finally {
      restoreEnv(snap);
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel fs.edit rebases a uniquely indented block (ruling 345)", async () => {
    const snap = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    const kernel = new KernelClient({
      workspace, stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-indent-trusted-"));
    const before = "fn main() {\n    if ready {\n        emit();\n    }\n}\n";
    const after = "fn main() {\n    if ready {\n        send();\n    }\n}\n";
    writeFileSync(path.join(sandbox, "src.rs"), before);
    try {
      await kernel.start();
      expect(kernel.mode).toBe("trusted");
      const result = await kernel.executeEffect({
        effectId: "eff-edit-indent",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.edit", spec: {
          path: "src.rs",
          oldString: "if ready {\n    emit();\n}",
          newString: "if ready {\n    send();\n}",
        } },
      });
      expect(result.verdict).toBe("settled");
      expect(readFileSync(path.join(sandbox, "src.rs"), "utf8")).toBe(after);
      expect(result.contentDigest).toBe(createHash("sha256").update(after).digest("hex"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(snap);
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel fs.edit applies one anchored line-patch with independently observed digest", async () => {
    const snap = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-line-patch-"));
    const before = "top\n  begin\n    unexpected();\n  end\nbottom\n";
    const after = "top\n  begin\n      replacement();\n  end\nbottom\n";
    writeFileSync(path.join(sandbox, "source.ts"), before);
    try {
      await kernel.start();
      expect(kernel.mode).toBe("trusted");
      const result = await kernel.executeEffect({
        effectId: "eff-edit-anchored",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.edit", spec: {
          path: "source.ts", oldString: "begin\n    expected();\nend",
          newString: "begin\n    replacement();\nend",
        } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.postimageObservationStable).toBe(true);
      expect(result.resultDigestStable).toBe(true);
      expect(readFileSync(path.join(sandbox, "source.ts"), "utf8")).toBe(after);
      expect(result.contentDigest).toBe(createHash("sha256").update(after).digest("hex"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(snap);
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel fs.edit refuses ambiguous anchors without touching disk", async () => {
    const snap = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-line-ambiguous-"));
    const before = "  begin\n  first();\n  end\n  begin\n  second();\n  end\n";
    writeFileSync(path.join(sandbox, "source.ts"), before);
    try {
      await kernel.start();
      await expect(kernel.executeEffect({
        effectId: "eff-edit-ambiguous", sandboxRoot: sandbox,
        dispatch: { kind: "fs.edit", spec: {
          path: "source.ts", oldString: "begin\nunknown();\nend", newString: "overwrite",
        } },
      })).rejects.toThrow(/exactly once/);
      expect(readFileSync(path.join(sandbox, "source.ts"), "utf8")).toBe(before);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(snap);
    }
  });

  test("fs.edit fails closed when oldString is missing", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-edit-miss-"));
    writeFileSync(path.join(sandbox, "src.txt"), "hello", "utf8");
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-edit-miss",
          sandboxRoot: sandbox,
          dispatch: { kind: "fs.edit", spec: { path: "src.txt", oldString: "missing", newString: "x" } },
        }),
      ).rejects.toThrow(/oldString not found/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("mutating fs.edit without sandboxRoot fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-edit-open",
          dispatch: { kind: "fs.edit", spec: { path: "x", oldString: "a", newString: "b" } },
        }),
      ).rejects.toThrow(/HZ_PRECONDITION_FAILED/);
    } finally {
      await kernel.close();
    }
  });

  test("shell.exec without sandboxRoot fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-shell-open",
          dispatch: { kind: "shell.exec", spec: { argv: ["true"] } },
        }),
      ).rejects.toThrow(/shell\.exec/);
    } finally {
      await kernel.close();
    }
  });

  test("shell.exec under sandboxRoot returns exitCode and stdoutDigest", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-shell-"));
    const expected = createHash("sha256").update("hello\n").digest("hex");
    try {
      const result = await kernel.executeEffect({
        effectId: "eff-shell-1",
        sandboxRoot: sandbox,
        dispatch: { kind: "shell.exec", spec: { argv: ["echo", "hello"] } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.exitCode).toBe(0);
      expect(result.stdoutDigest).toBe(expected);
      expect(result.resultDigestStable).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test("shell.exec cwd escape fails closed", async () => {
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-shell-esc-"));
    try {
      await expect(
        kernel.executeEffect({
          effectId: "eff-shell-esc",
          sandboxRoot: sandbox,
          dispatch: { kind: "shell.exec", spec: { argv: ["pwd"], cwd: "../" } },
        }),
      ).rejects.toThrow(/sandboxRoot/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel shell.exec returns stdoutDigest", async () => {
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-shell-trusted-"));
    const expected = createHash("sha256").update("rust-shell\n").digest("hex");
    try {
      await kernel.start();
      expect(kernel.mode).toBe("trusted");
      const result = await kernel.executeEffect({
        effectId: "eff-shell-trusted",
        sandboxRoot: sandbox,
        dispatch: { kind: "shell.exec", spec: { argv: ["echo", "rust-shell"] } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.resultDigestStable).toBe(true);
      expect(result.stdoutDigest).toBe(expected);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(envBackup);
    }
  });

  test.skipIf(!hasRustKernel)("trusted kernel fs.write returns contentDigest", async () => {
    const envBackup: EnvSnapshot = snapshotEnv();
    setEnv({ HZ_KERNEL_BIN: rustKernelPath });
    const kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspace, ".hzcode", "kernel"),
    });
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-sandbox-write-trusted-"));
    const expected = createHash("sha256").update("rust-write").digest("hex");
    try {
      await kernel.start();
      expect(kernel.mode).toBe("trusted");
      const result = await kernel.executeEffect({
        effectId: "eff-write-trusted",
        sandboxRoot: sandbox,
        dispatch: { kind: "fs.write", spec: { path: "note.txt", text: "rust-write" } },
      });
      expect(result.verdict).toBe("settled");
      expect(result.contentDigest).toBe(expected);
      expect(result.resultDigestStable).toBe(true);
      expect(readFileSync(path.join(sandbox, "note.txt"), "utf8")).toBe("rust-write");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      await kernel.close();
      restoreEnv(envBackup);
    }
  });
});
