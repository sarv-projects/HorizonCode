/**
 * `undo` -- revert the most recent write/edit the workspace recorded.
 *
 * The change journal (`change-journal.ts`) records, durably, for every
 * successful `write`/`edit`: the path, the content before it, and the sha256
 * the change produced. Undo targets the newest live entry (all paths, or one
 * with `path:`) and refuses -- never clobbers -- when the file no longer
 * matches what that change wrote: a concurrent human or tool edit is someone
 * else's work now, and the refusal names it instead of overwriting it.
 *
 * The journal is WORKSPACE-scoped and survives a process restart: this tool
 * re-reads `<state root>/undo.jsonl` on every call, so the newest live entry
 * counts whichever session recorded it (a previous run included). A successful
 * undo appends a consume tombstone, so the entry cannot resurface from the
 * file. The restore path keeps `noteRead` -- the session has the restored
 * bytes, so later edits are legitimate.
 *
 * Containment: the journaled path is resolved to its real target
 * (`resolveRealTarget`) before the guard, the stale-check and the effect. A path
 * that has become a symlink out of the workspace since the change was recorded
 * therefore reaches the policy as "outside" and cannot be silently restored or
 * removed outside it.
 */

import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { realpathish } from "../core/paths";
import { guardEffectivelyAllows } from "../core/guard-g1-wire";
import { isRefused, writeAtomic } from "./atomic-write";
import {
  BEFORE_MAX_BYTES,
  bindJournalWorkspace,
  consumeChangeGuarded,
  reloadFromDisk,
  unpersistedEntries,
  type ChangeEntry,
  type JournalStatus,
} from "./change-journal";
import { relPath, resolvePath, resolveRealTarget } from "./helpers";
import { noteRead } from "./read-ledger";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * What the journal read found, in one clause. A quarantine or a torn tail is
 * the difference between "nothing recorded" and "the record was lost", so it
 * rides every message that reports the journal as empty.
 */
function journalNotes(status: JournalStatus): string {
  const notes: string[] = [];
  if (status.corrupt === true) {
    notes.push(
      status.quarantinedTo !== undefined
        ? `the journal file was corrupt and was moved aside to ${status.quarantinedTo}; the journal restarted empty`
        : `the journal file was corrupt (${status.reason ?? "unreadable"}) and could not be moved aside; the journal restarts empty`,
    );
  }
  if (status.torn === true) {
    notes.push("the newest journal append was torn by a crash mid-write and was skipped");
  }
  return notes.length > 0 ? `note: ${notes.join("; ")}` : "";
}

/** The newest entry among the candidates, by recorded time then append order. */
function newest(candidates: ChangeEntry[]): ChangeEntry | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0] as ChangeEntry;
  for (const candidate of candidates.slice(1)) {
    if (candidate.at >= best.at) best = candidate;
  }
  return best;
}

export const undoTool: Tool = {
  name: "undo",
  description:
    "Revert the most recent write or edit the workspace recorded (the newest live change, any session, or the newest one to `path`). " +
    "Restores the previous content, or removes a file the change created. Refuses when the file changed since, or when the previous content was not kept.",
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
      // The workspace this session writes for: the entry may not name it on its
      // own (a path outside the workspace), and consume must tombstone the
      // right journal.
      bindJournalWorkspace(ctx.sessionId, ctx.workspace);
      const load = reloadFromDisk(ctx.workspace);
      // The journal plus any entry this session recorded when no journal could
      // be resolved: the running process can still reverse its own last change.
      const candidates = [...load.entries, ...unpersistedEntries(ctx.sessionId)];
      const entry =
        scope !== undefined
          ? newest(candidates.filter((e) => e.path === scope))
          : newest(candidates);
      if (entry === undefined) {
        const notes = journalNotes(load);
        const suffix = notes === "" ? "" : `; ${notes}`;
        return fail(
          scope !== undefined
            ? `nothing to undo for ${relPath(ctx.cwd, scope)}: this workspace's change journal holds no live change to it${suffix}`
            : `nothing to undo: this workspace's change journal holds no live change${suffix}`,
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
      if (entry.nonRestorable === true) {
        return fail(
          `cannot undo the last change to ${rel}: its previous content was larger than the journal keeps ` +
            `(nonRestorable: over the ${BEFORE_MAX_BYTES / 1024} KB per-entry cap), so it cannot be put back; ` +
            `the file is untouched -- restore it from version control, or overwrite it explicitly`,
        );
      }

      // Resolve the journaled path to the file the restore/removal would really
      // touch. A path that has become a symlink since the change was recorded
      // must be checked on its real target: the stale-check reads through the
      // link, so an approval based on the lexical (inside) path would otherwise
      // let undo write the saved bytes outside the workspace.
      const target = resolveRealTarget(ctx.cwd, entry.path, ctx.workspace);
      const real = target.real;

      // The stale-check: current bytes must still be what the recorded change
      // wrote. Anything else is a concurrent edit, and undo declines it.
      let current: string;
      try {
        current = (await readFile(real)).toString("utf8");
      } catch {
        return fail(
          `HZ_PRECONDITION_FAILED: undo refused: ${rel} is gone or unreadable; ` +
            `the recorded change expected sha256 ${entry.afterSha256} -- refusing to touch the path`,
        );
      }
      const actual = sha256Hex(current);
      if (actual !== entry.afterSha256) {
        return fail(
          `HZ_PRECONDITION_FAILED: undo refused: ${rel} changed since the recorded change wrote it ` +
            `(expected sha256 ${entry.afterSha256}; actual sha256 ${actual}); ` +
            `refusing to overwrite a concurrent edit -- read it and decide`,
        );
      }

      // Same consent path as the write/edit it reverses, on the real target.
      const action: GuardAction = { kind: "fs.write", target: real };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask" && !guardEffectivelyAllows(decision)) {
        const what = entry.before === null ? `remove ${rel} (created by a recorded change)` : `restore ${rel} to its prior content`;
        const targetNote = real === target.requested ? "" : ` [resolves to ${real}]`;
        const approved = await ctx.approve(
          { title: `Undo: ${what}`, detail: `reverts the last recorded ${entry.tool}${targetNote}`, kind: "fs.write" },
          action,
        );
        if (!approved) return fail("declined by user");
      }

      if (entry.before === null) {
        // The file exists only because of the recorded change -- and it still
        // matches that change (checked above), so removing it is exact reversal.
        // Re-resolve immediately before the removal: a path swapped for a link
        // to another directory after the guard must not be removed there.
        const effectReal = realpathish(entry.path);
        if (effectReal !== real) {
          return fail(
            `HZ_PRECONDITION_FAILED: undo refused: ${entry.path} now resolves to ${effectReal} ` +
              `(the approved target was ${real}); nothing was removed`,
          );
        }
        rmSync(entry.path);
        await consumeChangeGuarded(ctx.sessionId, entry);
        return { ok: true, output: `Removed ${rel} (it existed only because of the last recorded ${entry.tool}; undo)` };
      }

      const outcome = await writeAtomic(real, entry.before, ctx, real);
      if (isRefused(outcome)) return fail(outcome.refusal);
      // Append the consume tombstone: a reload must not resurrect this entry.
      await consumeChangeGuarded(ctx.sessionId, entry);
      // The session now holds the restored bytes -- later edits are legitimate.
      noteRead(ctx, real);
      return { ok: true, output: `Restored ${rel} to its content before the last recorded ${entry.tool}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
