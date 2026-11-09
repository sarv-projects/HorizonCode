/**
 * turn-diff.ts -- the per-turn aggregated file diff (FEAT-003).
 *
 * Reference: codex `turn_diff_tracker.rs` (research §1.11/§3). Where a per-tool
 * card shows one write at a time, this surface aggregates EVERY file change a
 * single model turn made into ONE unified diff -- independent of per-tool
 * output -- so the human sees the net effect of the turn, not a stream of
 * individual edits.
 *
 * The source of truth is the change journal (../tools/change-journal.ts): each
 * successful write/edit appends one { path, rel, before, afterSha256, tool }
 * record. The loop captures a boundary (the set of live entry ids) just before
 * a turn's tool batch runs, then hands us the entries recorded DURING the turn.
 * For each file:
 *   - `before` is the EARLIEST entry's recorded `before` in the turn (null = the
 *     file did not exist at the turn's start -- a new file);
 *   - `after` is the CURRENT on-disk content, read once at turn end, so several
 *     edits to the same file collapse into ONE net diff.
 * Each file's hunks come from `unifiedDiff` in ./plan (byte-stable, line-based,
 * 3 lines of context, "" when unchanged) -- we do NOT reimplement a diff.
 *
 * Entries the journal could not keep a preimage for (nonRestorable /
 * beforeUnreadable) are noted inline rather than crashing the aggregate, and a
 * disk read that fails (e.g. the file was deleted after the edit) is handled
 * safely. The output is byte-stable: files are emitted in the order they first
 * changed in the turn, and a single total line cap bounds the string.
 */

import { readFileSync } from "node:fs";
import type { ChangeEntry } from "../tools/change-journal";
import { unifiedDiff } from "./plan";

/** The aggregated result for one model turn. */
export interface TurnDiff {
  /** The concatenated unified diff across every file changed in the turn. */
  diff: string;
  /** How many files changed in the turn (one net diff each). */
  files: number;
  /** True when the total line cap clipped the aggregate. */
  truncated: boolean;
}

/** Default cap on the TOTAL lines of the aggregated diff across all files. */
export const TURN_DIFF_MAX_LINES = 400;
/** Per-file cap handed to `unifiedDiff` so one huge file cannot dominate. */
const PER_FILE_MAX_LINES = 200;

/** The net view of one file across the turn: earliest preimage, newest path/rel. */
interface FileChange {
  resolved: string;
  rel: string;
  before: string | null;
  /** Set when the earliest entry's preimage was not kept by the journal. */
  preimageLost: boolean;
}

/** Read the current on-disk content of a file, or null when it cannot be read. */
function readAfter(resolved: string): string | null {
  try {
    return readFileSync(resolved).toString("utf8");
  } catch {
    // Deleted after the edit, or otherwise unreadable: treated as an empty
    // "after" so the diff shows the removal rather than crashing.
    return null;
  }
}

/**
 * Collapse the turn's entries into one net change per file, preserving the
 * order in which each file FIRST changed (byte-stable output). The earliest
 * entry supplies `before`; later entries only update rel (the newest label).
 */
function netChanges(entries: readonly ChangeEntry[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const order: string[] = [];
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    const lost = entry.nonRestorable === true || entry.beforeUnreadable === true;
    if (existing === undefined) {
      byPath.set(entry.path, {
        resolved: entry.path,
        rel: entry.rel,
        before: lost ? null : entry.before,
        preimageLost: lost,
      });
      order.push(entry.path);
    } else {
      // Keep the earliest `before`; refresh the label to the latest rel.
      existing.rel = entry.rel;
    }
  }
  return order.map((p) => byPath.get(p) as FileChange);
}

/**
 * Aggregate the change-journal entries recorded during one model turn into a
 * single unified diff. `entries` is the turn's slice of the journal (the loop
 * computes it from the boundary it captured before the tool batch). Returns the
 * net diff, the number of files that actually changed, and whether the total
 * line cap clipped the output.
 */
export function computeTurnDiff(entries: readonly ChangeEntry[], maxLines = TURN_DIFF_MAX_LINES): TurnDiff {
  const changes = netChanges(entries);
  const sections: string[] = [];
  let files = 0;
  for (const change of changes) {
    const after = readAfter(change.resolved) ?? "";
    const note = change.preimageLost
      ? `# ${change.rel}: original content was not restorable; showing diff from empty\n`
      : "";
    const body = unifiedDiff(change.before, after, change.rel, PER_FILE_MAX_LINES);
    if (body === "" && note === "") continue; // no net change for this file
    files += 1;
    sections.push(note + body);
  }

  let diff = sections.join("");
  let truncated = false;
  const cap = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : TURN_DIFF_MAX_LINES;
  const lines = diff === "" ? [] : diff.replace(/\n$/, "").split("\n");
  if (lines.length > cap) {
    const kept = Math.max(0, cap - 1);
    const dropped = lines.length - kept;
    diff = lines.slice(0, kept).join("\n") + (kept > 0 ? "\n" : "") + `... ${dropped} more lines\n`;
    truncated = true;
  }

  return { diff, files, truncated };
}
