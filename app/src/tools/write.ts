/**
 * `write` — create or overwrite a file.
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
 * can make this tool create an EMPTY file there. No bytes are written and an
 * existing file is never truncated — the refusal is `HZ_PRECONDITION_FAILED`,
 * naming both the requested and the resolved path.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, realpathish } from "../core/paths";
import { relPath, resolvePath } from "./helpers";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lines in `content`, not counting the trailing newline of the final line. */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

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

/**
 * Open `resolved` for writing and re-verify — before any byte is written — that
 * the descriptor does not land inside the kernel state directory. Returns the
 * descriptor, or a typed refusal; on refusal nothing was written and the
 * descriptor is closed.
 */
export async function openVerifiedWrite(resolved: string, ctx: ToolContext): Promise<VerifiedWrite | { refusal: string }> {
  const stateDir = kernelStateDir(ctx.workspace);
  const pre = await lstat(resolved).catch(() => undefined);
  // No /proc: pin the last component where the tool's semantics allow it (the
  // path is not already a symlink) and check the descriptor's identity below.
  const noFollow = process.platform !== "linux" && (pre === undefined || !pre.isSymbolicLink());
  const flags =
    (pre === undefined ? constants.O_WRONLY | constants.O_CREAT : constants.O_WRONLY) |
    (noFollow ? constants.O_NOFOLLOW : 0);

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

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file, creating parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.content !== "string") return fail("content is required");

      const content = args.content;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, "utf8");

      const action: GuardAction = { kind: "fs.write", target: resolved };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          {
            title: `Write ${rel}`,
            detail: `${lines} lines, ${bytes} bytes`,
            kind: "fs.write",
          },
          action,
        );
        if (!approved) return fail("declined by user");
      }

      await mkdir(path.dirname(resolved), { recursive: true });
      const opened = await openVerifiedWrite(resolved, ctx);
      if ("refusal" in opened) return fail(opened.refusal);
      try {
        // Truncate + write through the verified descriptor: never through the
        // requested path again (that is where the racer acts).
        await opened.handle.truncate(0);
        await opened.handle.write(content, 0, "utf8");
      } finally {
        await opened.handle.close().catch(() => undefined);
      }

      return { ok: true, output: `Wrote ${lines} lines (${bytes} bytes) to ${rel}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
