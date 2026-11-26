/**
 * Sandboxed atomic rename for EffectHost local kernel fallback (ruling **297**).
 */

import { rename } from "node:fs/promises";
import path from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";

function normalizeForCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function realPathInsideRoot(realRoot: string, candidate: string): boolean {
  const nr = normalizeForCompare(realRoot);
  const nc = normalizeForCompare(candidate);
  const rootPrefix = nr.endsWith(path.sep) ? nr : `${nr}${path.sep}`;
  return nc === nr || nc.startsWith(rootPrefix);
}

async function sameDevice(a: string, b: string): Promise<boolean> {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** Rename an existing regular file inside `sandboxRoot` (atomic when same device). */
export async function renameFileInSandbox(
  sandboxRoot: string,
  fromResolved: string,
  toResolved: string,
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = realpathSync(path.resolve(sandboxRoot));
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: fs.rename sandboxRoot could not be resolved");
  }

  const absFrom = path.resolve(fromResolved);
  const absTo = path.resolve(toResolved);

  let realFromParent: string;
  let realToParent: string;
  try {
    realFromParent = realpathSync(path.dirname(absFrom));
    realToParent = realpathSync(path.dirname(absTo));
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: fs.rename parent directory could not be resolved");
  }
  if (!realPathInsideRoot(realRoot, realFromParent) || !realPathInsideRoot(realRoot, realToParent)) {
    throw new Error("HZ_PRECONDITION_FAILED: fs.rename paths must resolve inside sandboxRoot");
  }

  const safeFrom = path.join(realFromParent, path.basename(absFrom));
  const safeTo = path.join(realToParent, path.basename(absTo));

  let fromStat: ReturnType<typeof lstatSync>;
  try {
    fromStat = lstatSync(safeFrom);
  } catch {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.rename requires an existing source file");
  }
  if (fromStat.isSymbolicLink()) {
    let realLeaf: string;
    try {
      realLeaf = realpathSync(safeFrom);
    } catch {
      throw new Error("HZ_PRECONDITION_FAILED: fs.rename refuses dangling or unresolvable source symlink");
    }
    if (!realPathInsideRoot(realRoot, realLeaf)) {
      throw new Error("HZ_PRECONDITION_FAILED: fs.rename refuses source symlink pointing outside sandboxRoot");
    }
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.rename requires a regular source file");
  }
  if (!fromStat.isFile()) {
    throw new Error("HZ_PRECONDITION_FAILED: effect.execute fs.rename requires an existing source file");
  }

  try {
    const toStat = lstatSync(safeTo);
    if (toStat.isSymbolicLink()) {
      let realToLeaf: string;
      try {
        realToLeaf = realpathSync(safeTo);
      } catch {
        throw new Error("HZ_PRECONDITION_FAILED: fs.rename refuses dangling or unresolvable destination symlink");
      }
      if (!realPathInsideRoot(realRoot, realToLeaf)) {
        throw new Error("HZ_PRECONDITION_FAILED: fs.rename refuses destination symlink pointing outside sandboxRoot");
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  if (!(await sameDevice(safeFrom, realToParent))) {
    throw new Error(
      "HZ_PRECONDITION_FAILED: fs.rename refused: source and destination parent on different devices (cross-device rename)",
    );
  }
  await rename(safeFrom, safeTo);
}
