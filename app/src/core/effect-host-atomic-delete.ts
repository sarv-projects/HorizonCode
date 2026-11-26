/**
 * Sandboxed file delete for EffectHost local kernel fallback (ruling **296**).
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";

function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function realPathInsideRoot(realRoot: string, candidate: string): boolean {
  const nr = normalizeForCompare(realRoot);
  const nc = normalizeForCompare(candidate);
  const rootPrefix = nr.endsWith(path.sep) ? nr : `${nr}${path.sep}`;
  return nc === nr || nc.startsWith(rootPrefix);
}

/** Remove an existing regular file inside `sandboxRoot`. */
export async function deleteFileInSandbox(sandboxRoot: string, resolved: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(sandboxRoot));
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: fs.delete sandboxRoot could not be resolved");
  }
  const absTarget = path.resolve(resolved);
  let realParent: string;
  try {
    realParent = realpathSync(path.dirname(absTarget));
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: fs.delete target parent could not be resolved");
  }
  if (!realPathInsideRoot(realRoot, realParent)) {
    throw new Error("HZ_PRECONDITION_FAILED: fs.delete target must resolve inside sandboxRoot");
  }
  const safeTarget = path.join(realParent, path.basename(absTarget));
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(safeTarget);
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.delete requires an existing file");
  }
  if (st.isSymbolicLink()) {
    let realLeaf: string;
    try {
      realLeaf = realpathSync(safeTarget);
    } catch {
      throw new Error("HZ_PRECONDITION_FAILED: fs.delete refuses dangling or unresolvable symlink");
    }
    if (!realPathInsideRoot(realRoot, realLeaf)) {
      throw new Error("HZ_PRECONDITION_FAILED: fs.delete refuses symlink pointing outside sandboxRoot");
    }
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.delete requires a regular file");
  }
  if (!st.isFile()) {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.delete requires an existing file");
  }
  await unlink(safeTarget);
}
