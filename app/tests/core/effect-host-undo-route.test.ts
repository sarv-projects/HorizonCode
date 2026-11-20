/**
 * Ruling 650 — undo kernel-routes via fs.write / fs.delete under EffectHost.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import { tryKernelUndoRoute } from "../../src/core/effect-kernel-mutation-route";
import { KernelClient } from "../../src/core/kernel";
import { workspaceStateDir } from "../../src/core/paths";
import { bindJournalWorkspace, recordChange, __resetJournalForTests } from "../../src/tools/change-journal";
import { hasRustKernel, restoreEnv, rustKernelPath, setEnv, snapshotEnv, type EnvSnapshot } from "./helpers";

const describeUndo = hasRustKernel ? describe : describe.skip;

describeUndo("tryKernelUndoRoute (ruling 650)", () => {
  let workspace = "";
  let envSnap: EnvSnapshot;
  let kernel: KernelClient | undefined;

  beforeEach(() => {
    envSnap = snapshotEnv();
    __resetJournalForTests();
    workspace = mkdtempSync(path.join(tmpdir(), "hz-undo-kr-"));
    setEnv({
      HZ_KERNEL_BIN: rustKernelPath,
      HZ_EFFECT_HOST_KERNEL: "require",
      HZ_SUPERVISOR_LEASE: "0",
    });
  });

  afterEach(async () => {
    await kernel?.close().catch(() => undefined);
    kernel = undefined;
    restoreEnv(envSnap);
    __resetJournalForTests();
    rmSync(workspace, { recursive: true, force: true });
  });

  test("restores prior bytes through kernel fs.write and consumes the journal entry", async () => {
    const target = path.join(workspace, "a.txt");
    writeFileSync(target, "new\n");
    const sessionId = "s-undo-kr";
    bindJournalWorkspace(sessionId, workspace);
    recordChange(sessionId, {
      path: target,
      rel: "a.txt",
      before: "old\n",
      afterSha256: sha256Hex("new\n"),
      at: Date.now(),
      tool: "write",
    });

    kernel = new KernelClient({
      workspace,
      stateDir: path.join(workspaceStateDir(workspace), "kernel"),
    });
    await kernel.start();
    expect(kernel.mode).toBe("trusted");

    const outcome = await tryKernelUndoRoute(kernel, workspace, sessionId, crypto.randomUUID(), {});
    expect(outcome).toBeDefined();
    expect(outcome!.result.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("old\n");
    expect(outcome!.result.output).toContain("kernel undo");

    const again = await tryKernelUndoRoute(kernel, workspace, sessionId, crypto.randomUUID(), {});
    expect(again!.result.ok).toBe(false);
    expect(again!.result.error ?? again!.result.output).toContain("nothing to undo");
  }, 60_000);
});
