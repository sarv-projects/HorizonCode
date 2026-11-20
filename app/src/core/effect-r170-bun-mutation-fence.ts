/**
 * Reduced P0-3 cross-process fence for ambient Bun write/edit disk mutation.
 *
 * When `HZ_EFFECT_R170_BUN=1` or the EffectHost kernel spine is active
 * (`HZ_EFFECT_HOST_KERNEL` in `1` / `default` / `require`), participating
 * tools acquire a workspace-scoped advisory lock (same `file-lock.ts` machinery
 * as SessionStore admission batch fence, ruling **529**) around open→write→close.
 *
 * Named residuals (honest):
 *   - advisory: only cooperating hzcode writers are serialized;
 *   - NOT the Rust kernel OwnerLog flock (ruling **348** direct effects only);
 *   - MCP, hooks, SQLite, and other ambient Bun paths still OPEN unless gated elsewhere;
 *   - does NOT close full R170.
 */

import { LockTimeoutError, targetLockPath, withFileLock, type LockOptions } from "./file-lock";
import { effectHostKernelMutationEnabled } from "./effect-kernel-mutation-route";

/** Stable `targetLockPath` key — OwnerLog-adjacent naming for workspace-wide Bun fence. */
export const BUN_MUTATION_R170_LOCK_TARGET = "bun-mutation-r170";

export function effectR170BunMutationFenceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_EFFECT_R170_BUN?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return effectHostKernelMutationEnabled(env);
}

export function effectR170BunMutationLockPath(workspace: string): string {
  return targetLockPath(workspace, BUN_MUTATION_R170_LOCK_TARGET);
}

function fenceTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.HZ_EFFECT_R170_BUN_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10_000;
}

export function effectR170BunFenceLockOptions(
  env: Record<string, string | undefined> = process.env,
): LockOptions {
  return { timeoutMs: fenceTimeoutMs(env) };
}

export function formatEffectR170BunFenceLockTimeout(err: LockTimeoutError): string {
  return (
    `HZ_PRECONDITION_FAILED: bun-mutation-r170 fence: could not acquire workspace Bun mutation lock ` +
    `within ${err.message.includes("within ") ? err.message.split("within ")[1] : "timeout"}` +
    (err.holderPid !== undefined ? ` (held by live pid ${err.holderPid})` : "") +
    `; reduced P0-3 — not full R170 (MCP/hooks barrier OPEN)`
  );
}

/** Workspace-wide Bun mutation fence when enabled; no-op when off. Fails closed on lock timeout. */
export async function withEffectR170BunMutationFence<T>(
  workspace: string,
  fn: () => Promise<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  if (!effectR170BunMutationFenceEnabled(env)) return fn();
  const lockPath = effectR170BunMutationLockPath(workspace);
  try {
    return await withFileLock(lockPath, fn, effectR170BunFenceLockOptions(env));
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new Error(formatEffectR170BunFenceLockTimeout(err));
    throw err;
  }
}

/**
 * Outer workspace R170 Bun fence (when on) + inner per-target file lock for
 * write/edit critical sections.
 */
export async function withBunMutationDiskCriticalSection<T>(
  workspace: string,
  targetPath: string,
  fn: () => Promise<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  return withEffectR170BunMutationFence(workspace, () => withFileLock(targetLockPath(workspace, targetPath), fn), env);
}