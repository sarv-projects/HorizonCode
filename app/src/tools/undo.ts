/**
 * `undo` -- revert the most recent write/edit this session made.
 *
 * The change journal (`change-journal.ts`) recorded, for every successful
 * `write`/`edit`: the path, the content before it, and the sha256 the change
 * produced. Undo targets the newest entry (all paths, or one with `path:`) and
 * refuses -- never clobbers -- when the file no longer matches what that change
 * wrote: a concurrent human or tool edit is someone else's work now, and the
 * refusal names it instead of overwriting it.
 *
 * The scope is the session: the journal does not survive a process restart
 * (see the module header of `change-journal.ts` for why, and what the durable
 * version needs).
 */

import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { writeAtomic } from "./atomic-write";
import { consumeChange, lastChange, lastChangeFor, type ChangeEntry } from "./change-journal";
import { relPath, resolvePath } from "./helpers";
import { noteRead } from "./read-ledger";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const undoTool: Tool = {
  name: "undo",
  description:
    "Revert the most recent write or edit this session made (the newest change, or the newest one to `path`). " +
    "Restores the previous content, or removes a file the session created. Refuses when the file changed since.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Undo the most recent change to this file instead of the newest change overall." },
    },
    required: [],
  },

  // Mutating: an exclusive call is its own barrier in a batch (same as write/edit).
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const scope = typeof args.path === "string" && args.path !== "" ? resolvePath(ctx.cwd, args.path) : undefined;
      const entry: ChangeEntry | undefined =
        scope !== undefined ? lastChangeFor(ctx.sessionId, scope) : lastChange(ctx.sessionId);
      if (entry === undefined) {
        return fail(
          scope !== undefined
            ? `nothing to undo for ${relPath(ctx.cwd, scope)}: this session made no recorded change to it ` +
              `(the change journal is session-scoped and does not survive a restart)`
            : `nothing to undo: this session made no recorded changes ` +
              `(the change journal is session-scoped and does not survive a restart)`,
        );
      }

      const rel = entry.rel;
      if (entry.beforeUnreadable === true) {
        return fail(
          `cannot undo the last change to ${rel}: its previous bytes were not restorable text ` +
            `(binary or non-UTF-8), so the journal cannot put them back; the file is untouched -- ` +
            `restore it from version control, or overwrite it explicitly`,
        );
      }

      // The stale-check: current bytes must still be what this session's change
      // wrote. Anything else is a concurrent edit, and undo declines it.
      let current: string;
      try {
        current = (await readFile(entry.path)).toString("utf8");
      } catch {
        return fail(
          `HZ_PRECONDITION_FAILED: undo refused: ${rel} is gone or unreadable; ` +
            `the recorded change expected sha256 ${entry.afterSha256} -- refusing to touch the path`,
        );
      }
      const actual = sha256Hex(current);
      if (actual !== entry.afterSha256) {
        return fail(
          `HZ_PRECONDITION_FAILED: undo refused: ${rel} changed since this session wrote it ` +
            `(expected sha256 ${entry.afterSha256}; actual sha256 ${actual}); ` +
            `refusing to overwrite a concurrent edit -- read it and decide`,
        );
      }

      // Same consent path as the write/edit it reverses.
      const action: GuardAction = { kind: "fs.write", target: entry.path };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const what = entry.before === null ? `remove ${rel} (created by this session)` : `restore ${rel} to its prior content`;
        const approved = await ctx.approve({ title: `Undo: ${what}`, detail: `reverts the last ${entry.tool}`, kind: "fs.write" }, action);
        if (!approved) return fail("declined by user");
      }

      if (entry.before === null) {
        // The file exists only because of this session's change -- and it still
        // matches that change (checked above), so removing it is exact reversal.
        rmSync(entry.path);
        consumeChange(ctx.sessionId, entry);
        return { ok: true, output: `Removed ${rel} (created by this session's last ${entry.tool}; undo)` };
      }

      const outcome = await writeAtomic(entry.path, entry.before, ctx);
      if (!outcome.ok) return fail(outcome.refusal);
      consumeChange(ctx.sessionId, entry);
      // The session now holds the restored bytes -- later edits are legitimate.
      noteRead(ctx, entry.path);
      return { ok: true, output: `Restored ${rel} to its content before the last ${entry.tool}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
