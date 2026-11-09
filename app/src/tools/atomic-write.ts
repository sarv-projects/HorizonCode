/**
 * atomic-write.ts — replace a file's bytes with temp-file + rename.
 *
 * Why this exists: `truncate(0)` followed by `write` through the verified
 * descriptor is NOT atomic. A crash, ENOSPC, OOM-kill or Ctrl-C landing between
 * the two calls leaves the file at ZERO BYTES with the original content gone —
 * and nothing in the tool set restores it (there is no undo/rewind). A sibling
 * temp file plus `rename` is atomic within a filesystem: the target holds either
 * the old bytes or the whole new content, never a prefix of the new content.
 *
 * The verification story is unchanged (see the header of ./write.ts): the temp
 * descriptor is classified against the kernel state directory BEFORE any byte is
 * written, so a target whose directory resolves into `.hz/state/kernel` is still
 * refused, and the tool still writes through a descriptor rather than through a
 * re-resolved path.
 *
 * Named residuals, in the same spirit as the checks in ./write.ts:
 *   - a path component swapped for a symlink AFTER the directory identity check
 *     and BEFORE `rename` is the one window this module cannot observe (the
 *     general fix remains kernel-executed effects, NF-016);
 *   - the post-rename identity check turns that case into a reported failure
 *     instead of a silent success;
 *   - the rename is atomic, not durable-by-construction: the directory fsync is
 *     best-effort because some filesystems refuse to be opened for sync, and a
 *     power loss immediately after a successful rename may still lose the entry.
 */

import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { ToolContext } from "../contracts";
import { realpathish } from "../core/paths";
import { openVerifiedWrite, protectedTargetRefusal, type VerifiedWrite } from "./verified-open";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type AtomicWriteOutcome =
  | { ok: true; openedAs: string; bytes: number }
  | { ok: false; refusal: string };

/**
 * Narrow an outcome to its refusal arm. The native TS7 compiler does not
 * narrow this discriminated union on a bare `!outcome.ok`, so callers that
 * need `outcome.refusal` use this guard to reach the `{ ok: false }` member.
 */
export function isRefused(outcome: AtomicWriteOutcome): outcome is Extract<AtomicWriteOutcome, { ok: false }> {
  return !outcome.ok;
}

/** Same file, by device + inode. `undefined` when either side is missing. */
export function sameIdentity(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/** Best-effort directory fsync so a successful rename survives a crash. */
async function syncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // Some filesystems and platforms refuse this; the rename already happened.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Write `content` to `resolved` atomically: verify a sibling temp descriptor,
 * write, fsync, `rename`, then prove the path still names what we wrote.
 *
 * A file-level symlink is FOLLOWED (verify-then-allow, per ./verified-open.ts):
 * the symlink survives and its target receives the bytes, instead of the link
 * being replaced by a regular file.
 */
export async function writeAtomic(resolved: string, content: string, ctx: ToolContext): Promise<AtomicWriteOutcome> {
  // Where the effect would really land, symlinks followed. Checked here as well
  // as at the call site so that every caller inherits the guarantee.
  const target = realpathish(resolved);
  const refused = await protectedTargetRefusal(resolved, target, ctx);
  if (refused !== undefined) return { ok: false, refusal: refused };

  const dir = path.dirname(target);
  const base = path.basename(target);
  const before = await lstat(target).catch(() => undefined);
  const dirBefore = await stat(dir).catch(() => undefined);
  if (dirBefore === undefined) return { ok: false, refusal: `cannot write ${resolved}: ${dir} is not a directory` };

  const tmp = path.join(dir, `.${base}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let opened: VerifiedWrite | { refusal: string };
  try {
    // O_EXCL: never adopt a file (or symlink) someone else planted at the temp name.
    opened = await openVerifiedWrite(tmp, ctx, { exclusive: true });
  } catch (e) {
    return { ok: false, refusal: `could not create a temporary file next to ${resolved}: ${msg(e)}` };
  }
  if ("refusal" in opened) return { ok: false, refusal: opened.refusal };

  let written: Stats;
  try {
    await opened.handle.write(content, 0, "utf8");
    // Durability before the rename: a crash after rename must not expose a short file.
    await opened.handle.sync().catch(() => undefined);
    written = await opened.handle.stat();
    if (before !== undefined) {
      // Preserve the mode (an executable script must stay executable) and, when
      // permitted, the owner. Neither can fail the write: the bytes are correct.
      await opened.handle.chmod(before.mode & 0o7777).catch(() => undefined);
      await opened.handle.chown(before.uid, before.gid).catch(() => undefined);
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }

  // The directory must still be the same directory the temp file was created in,
  // or `rename` would move the file somewhere the guard never classified.
  const dirAfter = await stat(dir).catch(() => undefined);
  if (!sameIdentity(dirBefore, dirAfter)) {
    await unlink(tmp).catch(() => undefined);
    return {
      ok: false,
      refusal: `HZ_PRECONDITION_FAILED: write refused: ${dir} changed while the temporary file was open; nothing was written`,
    };
  }
  try {
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    return { ok: false, refusal: `could not replace ${resolved}: ${msg(e)}` };
  }
  await syncDir(dir);

  // Prove the name still resolves to the file we wrote: a swapped path component
  // during the window shows up here as a mismatch, reported rather than hidden.
  const after = await stat(target).catch(() => undefined);
  if (!sameIdentity(written, after)) {
    return {
      ok: false,
      refusal:
        `HZ_PRECONDITION_FAILED: write reported a moved target: ${resolved} no longer names the file just written ` +
        `(a path component changed during the write); verify the destination by hand`,
    };
  }

  const onDisk = await readFile(target).catch(() => undefined);
  if (onDisk === undefined || onDisk.toString("utf8") !== content) {
    return { ok: false, refusal: `verification failed: ${resolved} does not match the intended content` };
  }

  return { ok: true, openedAs: opened.openedAs, bytes: Buffer.byteLength(content, "utf8") };
}
