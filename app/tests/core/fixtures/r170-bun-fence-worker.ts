/**
 * Child-process worker for effect-r170-bun-mutation-fence cross-process tests.
 *   hold   <workspace> <ms>   hold the workspace Bun mutation fence, then release
 *   write  <workspace> <file> <content>  write tool with HZ_EFFECT_R170_BUN=1
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireLockSync, targetLockPath } from "../../../src/core/file-lock";
import {
  BUN_MUTATION_R170_LOCK_TARGET,
  effectR170BunMutationFenceEnabled,
} from "../../../src/core/effect-r170-bun-mutation-fence";
import { writeTool } from "../../../src/tools/write";

const [mode, workspace, a, b] = process.argv.slice(2);

if (mode === "hold") {
  const ms = Number(a ?? "5000");
  const lockPath = targetLockPath(workspace!, BUN_MUTATION_R170_LOCK_TARGET);
  const release = acquireLockSync(lockPath, { timeoutMs: 5_000 });
  writeFileSync(path.join(workspace!, ".fence-held"), `${process.pid}\n`);
  Bun.sleepSync(ms);
  release();
  writeFileSync(path.join(workspace!, ".fence-released"), `${process.pid}\n`);
  console.log(JSON.stringify({ ok: true, heldMs: ms }));
} else if (mode === "write") {
  if (!effectR170BunMutationFenceEnabled()) {
    process.env.HZ_EFFECT_R170_BUN = "1";
  }
  mkdirSync(workspace!, { recursive: true });
  const filePath = path.join(workspace!, a!);
  const ctx = {
    cwd: workspace!,
    workspace: workspace!,
    sessionId: `fence-${process.pid}`,
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow" as const }),
    approve: async () => true,
    receipt: async () => ({}) as never,
  };
  const result = await writeTool.execute({ path: filePath, content: b ?? "child\n", force: true }, ctx as never);
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify({ ok: false, error: "bad mode" }));
  process.exitCode = 1;
}