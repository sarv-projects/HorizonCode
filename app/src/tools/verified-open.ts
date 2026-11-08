/**
 * verified-open.ts — open a descriptor for writing and prove, before any byte is
 * written, where it really points.
 *
 * Effect-time verification (wave-13 audit finding 10). The guard classifies the
 * REQUESTED path; between that decision and the bytes landing, a racer can swap
 * a path component for a symlink into the kernel state directory
 * (`.hz/state/kernel`, where policy.json, leases and receipts live) — the guard
 * would have decided on a harmless path while the write follows the swap. So the
 * effect goes through an open file descriptor that is re-verified BEFORE any
 * byte is written: on Linux `/proc/self/fd/<fd>` names where the descriptor
 * really points, and that target is classified with the same function the guard
 * uses (`protectedPathRefusal`). A refusal closes the descriptor and writes
 * nothing.
 *
 * Symlink policy for `write` (and `edit`): VERIFY-THEN-ALLOW. Writing THROUGH a
 * file-level symlink to a legitimate target keeps working, as it did before this
 * check; the classification follows the link to where the descriptor points and
 * only the kernel state directory is refused. Off Linux there is no
 * `/proc/self/fd`, so the fallback is weaker: the last component is pinned with
 * `O_NOFOLLOW` when the path is not already a symlink, and the descriptor is
 * compared by device+inode against the path plus classified through the same
 * helper. Residual there: an intermediate path component swapped inside the
 * window between classification and the effect. The general fix is
 * kernel-executed effects (NF-016).
 *
 * One more residual, on every platform: the open itself uses `O_CREAT` when the
 * path did not exist, so a racer that points the path into the state directory
 * can make the caller create an EMPTY file there. No bytes are written and an
 * existing file is never truncated — the refusal is `HZ_PRECONDITION_FAILED`,
 * naming both the requested and the resolved path.
 *
 * This module was split out of `write.ts` when atomic replacement arrived
 * (`atomic-write.ts`), so that the verification code has exactly one home and
 * the two modules do not import each other.
 */

import { constants } from "node:fs";
import { lstat, open, readlink, stat, type FileHandle } from "node:fs/promises";
import type { GuardAction, ToolContext } from "../contracts";
import { kernelStateDir, realpathish } from "../core/paths";

/** Where an open descriptor really points, or undefined without /proc (non-Linux). */
async function fdTarget(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await readlink(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/**
 * The guard's own protected-path classifier, fetched lazily.
 *
 * `core/kernel.ts` (and `core/loop.ts` behind it) reaches back into `tools/` at
 * module scope, so a STATIC import from a tool would close a module cycle whose
 * evaluation order breaks for any entry that loads a tool first — which the test
 * suite does (`tests/tools/write.test.ts` imports this file directly). A dynamic
 * import at call time resolves to the very same exported function, so the
 * classification stays byte-identical to the guard's without the cycle.
 */
async function protectedClassifier(): Promise<(action: GuardAction, stateDir: string) => string | undefined> {
  const { protectedPathRefusal } = await import("../core/kernel");
  return protectedPathRefusal;
}

/** The typed refusal for a descriptor that lands inside the kernel state dir. */
function protectedRefusal(requested: string, openedAs: string, stateDir: string): string {
  return (
    `HZ_PRECONDITION_FAILED: write refused at effect time: requested ${requested} ` +
    `opened as ${openedAs}, inside the kernel state directory (${stateDir}); nothing was written`
  );
}

export interface VerifiedWrite {
  /** The open, verified descriptor; the caller writes through it and closes it. */
  handle: FileHandle;
  /** The path the classification ran on (where the descriptor really points). */
  openedAs: string;
}

export interface VerifiedOpenOptions {
  /** Add `O_EXCL`: never adopt an existing file (or symlink) at this path. */
  exclusive?: boolean;
}

/**
 * Effect-time classification of the path an effect would really land on, after
 * following symlinks. `undefined` means allowed. The message names BOTH the path
 * the caller asked for and the resolved target, because a racer's swap is
 * otherwise indistinguishable from a policy denial in a transcript.
 */
export async function protectedTargetRefusal(
  requested: string,
  resolvedTarget: string,
  ctx: ToolContext,
): Promise<string | undefined> {
  const stateDir = kernelStateDir(ctx.workspace);
  const refusal = (await protectedClassifier())({ kind: "fs.write", target: resolvedTarget }, stateDir);
  return refusal === undefined ? undefined : protectedRefusal(requested, resolvedTarget, stateDir);
}

/**
 * Open `resolved` for writing and re-verify — before any byte is written — that
 * the descriptor does not land inside the kernel state directory. Returns the
 * descriptor, or a typed refusal; on refusal nothing was written and the
 * descriptor is closed.
 */
export async function openVerifiedWrite(
  resolved: string,
  ctx: ToolContext,
  opts: VerifiedOpenOptions = {},
): Promise<VerifiedWrite | { refusal: string }> {
  const stateDir = kernelStateDir(ctx.workspace);
  const pre = await lstat(resolved).catch(() => undefined);
  // No /proc: pin the last component where the tool's semantics allow it (the
  // path is not already a symlink) and check the descriptor's identity below.
  const noFollow = process.platform !== "linux" && (pre === undefined || !pre.isSymbolicLink());
  const flags =
    (pre === undefined ? constants.O_WRONLY | constants.O_CREAT : constants.O_WRONLY) |
    (noFollow ? constants.O_NOFOLLOW : 0) |
    (opts.exclusive === true ? constants.O_EXCL | constants.O_CREAT : 0);

  let handle: FileHandle;
  try {
    handle = await open(resolved, flags, 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ELOOP") {
      return { refusal: `HZ_PRECONDITION_FAILED: write refused: ${resolved} became a symlink while being opened; nothing was written` };
    }
    throw err;
  }

  try {
    const byFd = await fdTarget(handle.fd);
    let classified: string;
    if (byFd !== undefined) {
      classified = byFd;
    } else {
      // Weaker fallback (non-Linux): the descriptor cannot name its own path, so
      // the evidence is the path's resolution plus "the path and the descriptor
      // are the same file". An intermediate-component swap inside the window is
      // the named residual (see the header).
      const viaPath = await stat(resolved).catch(() => undefined);
      const viaFd = await handle.stat();
      if (viaPath === undefined || viaPath.dev !== viaFd.dev || viaPath.ino !== viaFd.ino) {
        await handle.close();
        return { refusal: `HZ_PRECONDITION_FAILED: write refused: ${resolved} changed while being opened; nothing was written` };
      }
      classified = realpathish(resolved);
    }
    if ((await protectedClassifier())({ kind: "fs.write", target: classified }, stateDir) !== undefined) {
      await handle.close();
      return { refusal: protectedRefusal(resolved, classified, stateDir) };
    }
    return { handle, openedAs: classified };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
