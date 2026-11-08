/**
 * `write` — create or overwrite a file.
 *
 * The effect goes through `atomic-write.ts` (temp file in the same directory,
 * fsync, rename, post-rename identity proof) and the descriptor it writes to is
 * re-verified against the kernel state directory before a byte lands — see the
 * header of ./verified-open.ts for why, and for the named residuals.
 *
 * Two guards exist because this is the most destructive tool in the set:
 *
 *   - STALENESS across the approval window: the target's identity is snapshotted
 *     before the guard/approval and re-checked immediately before the effect. A
 *     file a human (or another tool) changed while the approval prompt was up is
 *     a `HZ_PRECONDITION_FAILED` refusal, never a silent overwrite. This is the
 *     same TOCTOU that `edit` closes with a sha256 preimage; `write` has no
 *     preimage of its own (it may be creating the file), so identity + mtime +
 *     size is the evidence. Named residual: a same-second, same-size edit on a
 *     coarse-mtime filesystem is not distinguishable here.
 *   - BINARY / NON-UTF-8 refusal: overwriting a PNG, an artifact or a Latin-1
 *     source file with UTF-8 text destroys bytes nothing can restore. Both checks
 *     are bypassable with `force: true`, which is the caller taking
 *     responsibility for the replacement.
 */

import { readFile, mkdir, stat, type Stats } from "node:fs/promises";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { realpathish } from "../core/paths";
import { writeAtomic } from "./atomic-write";
import { recordChange } from "./change-journal";
import { isBinary, relPath, resolvePath } from "./helpers";
import { noteRead, wasRead } from "./read-ledger";
import { protectedTargetRefusal } from "./verified-open";

// Re-exported so existing importers keep working after the verification code was
// split into its own module (`verified-open.ts`).
export { openVerifiedWrite, type VerifiedWrite } from "./verified-open";

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

/** The staleness snapshot: what the path named before anyone was asked to approve. */
interface Snapshot {
  exists: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
}

async function snapshot(resolved: string): Promise<Snapshot> {
  const st: Stats | undefined = await stat(resolved).catch(() => undefined);
  if (st === undefined) return { exists: false };
  return { exists: true, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

/** A human-readable description of what moved, for the refusal message. */
function describeChange(before: Snapshot, after: Snapshot): string {
  if (!before.exists && after.exists) return "created by another process while awaiting approval";
  if (before.exists && !after.exists) return "deleted while awaiting approval";
  if (before.ino !== after.ino) return "replaced by another process while awaiting approval";
  return `modified while awaiting approval (${String(before.size)} -> ${String(after.size)} bytes)`;
}

/** True when the buffer is valid UTF-8: decode and re-encode must be lossless. */
function isUtf8(buf: Uint8Array): boolean {
  return Buffer.from(buf.toString("utf8"), "utf8").equals(Buffer.from(buf));
}

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file, creating parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write." },
      content: { type: "string", description: "Full file content." },
      force: {
        type: "boolean",
        description: "Overwrite a binary or non-UTF-8 file. Without it such a target is refused.",
      },
    },
    required: ["path", "content"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.content !== "string") return fail("content is required");
      const force = args.force === true;

      const content = args.content;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, "utf8");

      const action: GuardAction = { kind: "fs.write", target: resolved };
      const beforeGuard = await snapshot(resolved);
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

      // Where the effect would land, decided AFTER the approval window and before
      // anything is read or written. A racer that swapped a path component for a
      // symlink into the kernel state directory is caught here, and the refusal
      // names both the requested path and the resolved target.
      const refused = await protectedTargetRefusal(resolved, realpathish(resolved), ctx);
      if (refused !== undefined) return fail(refused);

      // Staleness across the window in which the user was deciding (docs/09 §8.2's
      // rule, extended to `write`): a concurrent change is a Conflict, not a
      // silent overwrite with "success".
      const afterApproval = await snapshot(resolved);
      if (
        beforeGuard.exists !== afterApproval.exists ||
        beforeGuard.ino !== afterApproval.ino ||
        beforeGuard.size !== afterApproval.size ||
        beforeGuard.mtimeMs !== afterApproval.mtimeMs
      ) {
        return fail(
          `HZ_PRECONDITION_FAILED: write refused: preimage changed: ${rel} ` +
            `(${describeChange(beforeGuard, afterApproval)}; re-read the file and retry)`,
        );
      }

      // Read-before-write (audit finding 2): a file that already exists is only
      // replaced when this session has read it. `write` keeps no preimage of its
      // own, so without this the model can destroy content it never saw.
      if (beforeGuard.exists && !force && !wasRead(ctx, resolved)) {
        return fail(
          `HZ_PRECONDITION_FAILED: write refused: ${rel} already exists and this session has not read it; ` +
            `read it first, or pass force:true to replace it wholesale`,
        );
      }

      // What the overwrite would destroy, and what undo would restore. Only the
      // pre-existing content matters; the create path has nothing to lose.
      let preimageText: string | null = null;
      let preimageUnreadable = false;
      if (beforeGuard.exists) {
        let preimage: Buffer | undefined;
        try {
          preimage = await readFile(resolved);
        } catch {
          preimage = undefined; // unreadable (a directory, a device, permissions)
        }
        if (preimage !== undefined) {
          const binary = isBinary(preimage);
          if (binary || !isUtf8(preimage)) {
            if (!force) {
              return fail(
                binary
                  ? `binary file (contains a NUL byte): ${rel}; pass force:true to overwrite it`
                  : `not valid UTF-8: ${rel}; overwriting would corrupt the encoding — pass force:true to proceed`,
              );
            }
            preimageUnreadable = true;
          } else {
            preimageText = preimage.toString("utf8");
          }
        } else {
          // Unreadable (a directory, a device, permissions): the checks never ran
          // here, the write proceeds, and undo records that bytes cannot come back.
          preimageUnreadable = true;
        }
      }

      await mkdir(path.dirname(resolved), { recursive: true });
      const outcome = await writeAtomic(resolved, content, ctx);
      if (!outcome.ok) return fail(outcome.refusal);

      recordChange(ctx.sessionId, {
        path: resolved,
        rel,
        before: preimageText,
        ...(preimageUnreadable ? { beforeUnreadable: true } : {}),
        afterSha256: sha256Hex(content),
        at: Date.now(),
        tool: "write",
      });

      // The session authored (and verified, by re-reading) this content, so the
      // path counts as known: overwriting your own work is not the "never saw
      // it" hazard the gate targets.
      noteRead(ctx, resolved);
      return { ok: true, output: `Wrote ${lines} lines (${bytes} bytes) to ${rel}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
