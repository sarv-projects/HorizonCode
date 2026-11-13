import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core";
import { stageWrite, discardStaged } from "../../src/core/plan";
import { recordCheckpoint, __resetCheckpointsForTests } from "../../src/core/checkpoints";
import { sha256Hex } from "../../src/core/canon";
import { bindJournalWorkspace, recordChange } from "../../src/tools/change-journal";
import { __latchEffectReconcileBlockForTests, __resetEffectReconcileBlockForTests } from "../../src/core/effect-reconcile-block";
import { snapshotEnv, restoreEnv, setEnv } from "./helpers";

/** Restrict process-global flags to the synchronous admission phase, never an await. */
function admittedWithFlags<T>(flags: Record<string, string | undefined>, run: () => T): T {
  const old = snapshotEnv();
  try {
    setEnv(flags);
    return run();
  } finally {
    restoreEnv(old);
  }
}

afterEach(() => {
  __resetCheckpointsForTests();
  __resetEffectReconcileBlockForTests();
});

describe("runtime facade EffectHost gates", () => {
  test("require never lets commit-shell or staged plan writes fall through to Bun", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-facade-require-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      const cmd = admittedWithFlags(
        { HZ_EFFECT_HOST_KERNEL: "require", HZ_EFFECT_RECONCILE_BLOCK: "0" },
        () => runtime.runGuardedShell("touch forbidden.txt"),
      );
      const result = await cmd;
      expect(result.ok).toBe(false);
      expect(result.output).toContain("HZ_EFFECT_HOST_KERNEL=require");
      expect(existsSync(path.join(ws, "forbidden.txt"))).toBe(false);

      const target = path.join(ws, "staged.txt");
      stageWrite(runtime.sessionId, { resolved: target, rel: "staged.txt", before: null, after: "new", tool: "write" });
      const apply = await admittedWithFlags(
        { HZ_EFFECT_HOST_KERNEL: "require", HZ_EFFECT_RECONCILE_BLOCK: "0" },
        () => runtime.applyPlan(),
      );
      expect(apply).toContain("kept 1");
      expect(apply).toContain("HZ_EFFECT_HOST_KERNEL=require");
      expect(existsSync(target)).toBe(false);
      expect(runtime.stagedChanges()).toHaveLength(1);
    } finally {
      discardStaged(runtime.sessionId);
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("strict mode refuses file rewind before touching either disk or transcript", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-facade-rewind-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      const sid = runtime.sessionId;
      recordCheckpoint(ws, sid, 0, []);
      const target = path.join(ws, "rewind.txt");
      writeFileSync(target, "after");
      bindJournalWorkspace(sid, ws);
      recordChange(sid, {
        at: Date.now() + 1000,
        path: target,
        rel: "rewind.txt",
        before: "before",
        afterSha256: sha256Hex("after"),
        tool: "write",
      });
      const store = (runtime as unknown as { store: { appendMessage: (id: string, message: { role: "user"; content: string }) => void } }).store;
      store.appendMessage(sid, { role: "user", content: "keep me" });
      const result = await admittedWithFlags(
        { HZ_EFFECT_HOST_KERNEL: "require", HZ_EFFECT_RECONCILE_BLOCK: "0" },
        () => runtime.rewindTo(1),
      );
      expect(result).toContain("workspace and transcript unchanged");
      expect(readFileSync(target, "utf8")).toBe("after");
      expect(runtime.history().map((row) => row.content)).toEqual(["keep me"]);
    } finally {
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an existing reconcile latch also blocks direct shell and apply", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-facade-latch-"));
    const runtime = await createRuntime({ workspace: ws, mock: true });
    try {
      __latchEffectReconcileBlockForTests(ws, runtime.sessionId);
      const shell = await admittedWithFlags(
        { HZ_EFFECT_HOST_KERNEL: "0", HZ_EFFECT_RECONCILE_BLOCK: "1" },
        () => runtime.runGuardedShell("touch blocked.txt"),
      );
      expect(shell.ok).toBe(false);
      expect(shell.output).toContain("HZ_EFFECT_RECONCILE_BLOCK");
      const target = path.join(ws, "apply.txt");
      stageWrite(runtime.sessionId, { resolved: target, rel: "apply.txt", before: null, after: "x", tool: "write" });
      const apply = await admittedWithFlags(
        { HZ_EFFECT_HOST_KERNEL: "0", HZ_EFFECT_RECONCILE_BLOCK: "1" },
        () => runtime.applyPlan(),
      );
      expect(apply).toContain("HZ_EFFECT_RECONCILE_BLOCK");
      expect(existsSync(target)).toBe(false);
    } finally {
      discardStaged(runtime.sessionId);
      await runtime.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
