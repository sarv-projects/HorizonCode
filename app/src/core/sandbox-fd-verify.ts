/**
 * H-31 reduced TOCTOU — prove an opened fd names a path inside the workspace
 * before bytes land. Linux uses `/proc/self/fd`; elsewhere compares dev/ino.
 */

import { lstat, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveSymlinkChain, resolvedInside } from "./kernel";

/** Fail-closed workspace containment (lexical symlink walk). */
export function workspaceContains(workspace: string, target: string): boolean | undefined {
  return resolvedInside(target, path.resolve(workspace));
}

export interface FdWorkspaceVerify {
  ok: true;
  openedAs: string;
}

export interface FdWorkspaceRefusal {
  refusal: string;
}

/**
 * After open, verify the descriptor is inside `workspace` and (when given)
 * still matches the guard-approved `expectedReal` spelling.
 */
export async function verifyFdInWorkspace(
  handle: FileHandle,
  workspace: string,
  requestedPath: string,
  expectedReal?: string,
): Promise<FdWorkspaceVerify | FdWorkspaceRefusal> {
  const ws = path.resolve(workspace);
  const byFd = await fdTarget(handle.fd);
  let openedAs: string;
  if (byFd !== undefined) {
    openedAs = byFd;
  } else {
    const viaPath = await lstat(requestedPath).catch(() => undefined);
    const viaFd = await handle.stat();
    if (viaPath === undefined || viaPath.dev !== viaFd.dev || viaPath.ino !== viaFd.ino) {
      return {
        refusal:
          `HZ_PRECONDITION_FAILED: write refused: ${requestedPath} changed while being opened; nothing was written`,
      };
    }
    const chained = resolveSymlinkChain(requestedPath);
    openedAs = chained ?? requestedPath;
  }
  const inside = workspaceContains(ws, openedAs);
  if (inside === undefined || !inside) {
    return {
      refusal:
        `HZ_PRECONDITION_FAILED: write refused at effect time: opened fd ${openedAs} ` +
        `is outside the workspace (${ws}); nothing was written`,
    };
  }
  if (expectedReal !== undefined) {
    const chained = resolveSymlinkChain(requestedPath) ?? requestedPath;
    if (chained !== expectedReal && openedAs !== expectedReal) {
      return {
        refusal:
          `HZ_PRECONDITION_FAILED: write refused: ${requestedPath} now resolves to ${openedAs} ` +
          `(the approved target was ${expectedReal}); nothing was written`,
      };
    }
  }
  return { ok: true, openedAs };
}

async function fdTarget(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await readlink(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** Re-resolve `candidate` inside `workspace` before an effect (TOCTOU recheck). */
export function recheckPathInWorkspace(
  workspace: string,
  candidate: string,
  expectedResolved?: string,
): string | { refusal: string } {
  const ws = path.resolve(workspace);
  const abs = path.resolve(candidate);
  const inside = workspaceContains(ws, abs);
  if (inside === undefined) {
    return { refusal: `HZ_PRECONDITION_FAILED: cannot re-resolve ${candidate} inside workspace` };
  }
  if (!inside) {
    return { refusal: `HZ_PRECONDITION_FAILED: mutation path outside workspace: ${candidate}` };
  }
  const resolved = resolveSymlinkChain(abs);
  if (resolved === undefined) {
    return { refusal: `HZ_PRECONDITION_FAILED: mutation path could not be re-resolved: ${candidate}` };
  }
  const resolvedInsideWs = workspaceContains(ws, resolved);
  if (resolvedInsideWs === undefined || !resolvedInsideWs) {
    return { refusal: `HZ_PRECONDITION_FAILED: re-resolved path outside workspace: ${resolved}` };
  }
  if (expectedResolved !== undefined && resolved !== expectedResolved) {
    return {
      refusal:
        `HZ_PRECONDITION_FAILED: path resolution moved (approved ${expectedResolved}, now ${resolved})`,
    };
  }
  return resolved;
}