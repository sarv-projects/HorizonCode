/**
 * Sandboxed atomic rename for EffectHost local kernel fallback (ruling **297**).
 */

import { rename } from "node:fs/promises";
import path from "node:path";
import { existsSync, statSync } from "node:fs";

function pathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(rootPrefix);
}

async function sameDevice(a: string, b: string): Promise<boolean> {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return true;
  }
}

/** Rename an existing regular file inside `sandboxRoot` (atomic when same device). */
export async function renameFileInSandbox(
  sandboxRoot: string,
  fromResolved: string,
  toResolved: string,
): Promise<void> {
  if (!pathInsideRoot(sandboxRoot, fromResolved) || !pathInsideRoot(sandboxRoot, toResolved)) {
    throw new Error("HZ_PRECONDITION_FAILED: fs.rename paths must resolve inside sandboxRoot");
  }
  const parent = path.dirname(toResolved);
  if (!pathInsideRoot(sandboxRoot, parent)) {
    throw new Error("HZ_PRECONDITION_FAILED: fs.rename destination parent must resolve inside sandboxRoot");
  }
  if (!existsSync(fromResolved) || !statSync(fromResolved).isFile()) {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.rename requires an existing source file");
  }
  if (!(await sameDevice(fromResolved, parent))) {
    throw new Error(
      "HZ_PRECONDITION_FAILED: fs.rename refused: source and destination parent on different devices (cross-device rename)",
    );
  }
  await rename(fromResolved, toResolved);
}
