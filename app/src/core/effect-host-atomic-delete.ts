/**
 * Sandboxed file delete for EffectHost local kernel fallback (ruling **296**).
 */

import { unlink } from "node:fs/promises";
import path from "node:path";
import { existsSync, statSync } from "node:fs";

function pathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(rootPrefix);
}

/** Remove an existing regular file inside `sandboxRoot`. */
export async function deleteFileInSandbox(sandboxRoot: string, resolved: string): Promise<void> {
  if (!pathInsideRoot(sandboxRoot, resolved)) {
    throw new Error("HZ_PRECONDITION_FAILED: fs.delete target must resolve inside sandboxRoot");
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.delete requires an existing file");
  }
  await unlink(resolved);
}
