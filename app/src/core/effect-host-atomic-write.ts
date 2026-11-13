/**
 * EffectHost sandbox atomic write (ruling **283**) — temp sibling + rename within sandbox.
 *
 * Mirrors `kernel/src/sandbox_atomic_write.rs` for LocalKernel `effect.execute`.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

function pathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(rootPrefix);
}

async function sameDevice(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  return sa.dev === sb.dev;
}

async function syncDirBestEffort(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // best-effort
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Replace `resolved` with `payload` using atomic rename; both paths must stay inside `sandboxRoot`. */
export async function writeBytesAtomicInSandbox(
  sandboxRoot: string,
  resolved: string,
  payload: Buffer,
): Promise<void> {
  if (!pathInsideRoot(sandboxRoot, resolved)) {
    throw new Error("HZ_PRECONDITION_FAILED: atomic write target must resolve inside sandboxRoot");
  }
  const parent = path.dirname(resolved);
  if (!pathInsideRoot(sandboxRoot, parent)) {
    throw new Error("HZ_PRECONDITION_FAILED: atomic write parent must resolve inside sandboxRoot");
  }
  await mkdir(parent, { recursive: true });
  const base = path.basename(resolved);
  const tmp = path.join(parent, `.${base}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  if (!pathInsideRoot(sandboxRoot, tmp)) {
    throw new Error("HZ_PRECONDITION_FAILED: atomic write temp path must resolve inside sandboxRoot");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "wx");
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!(await sameDevice(tmp, parent))) {
      await unlink(tmp).catch(() => undefined);
      throw new Error(
        "HZ_PRECONDITION_FAILED: atomic write refused: temp and parent on different devices (cross-device rename)",
      );
    }
    try {
      await stat(resolved);
      if (!(await sameDevice(tmp, resolved))) {
        await unlink(tmp).catch(() => undefined);
        throw new Error(
          "HZ_PRECONDITION_FAILED: atomic write refused: temp and target on different devices (cross-device rename)",
        );
      }
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
      if (code !== "ENOENT") throw e;
    }
    await rename(tmp, resolved);
    await syncDirBestEffort(parent);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("HZ_PRECONDITION_FAILED")) {
      throw err instanceof Error ? err : new Error(msg);
    }
    throw new Error(`HZ_PRECONDITION_FAILED: atomic write failed: ${msg}`);
  }
}
