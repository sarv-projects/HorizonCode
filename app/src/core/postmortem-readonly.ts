/**
 * postmortem-readonly.ts — bounded, side-effect-free post-mortem loading for
 * the J-5 full-corpus reader (ruling 515 residual).
 *
 * `core/postmortem.ts#loadPostmortems` is QUARANTINE-shaped: a file that cannot
 * be parsed is RENAMED `<file>.corrupt-<epochMillis>` (a filesystem mutation).
 * A read-only analysis pass must not do that. This loader is the read-only
 * twin: files are opened read-only, and malformed/unreadable/oversized files
 * are SKIPPED AND COUNTED — nothing is written, renamed, chmod'd or deleted.
 *
 * Determinism / output parity: for a healthy corpus the returned records are
 * identical in content and order to `loadPostmortems` (same directory, same
 * `*.json`/dotfile filter, same name sort, same ts-then-id record sort); for a
 * corrupt corpus the skipped count equals the number of files
 * `loadPostmortems` would have quarantined, but the file stays where it is.
 * Bounds mirror the other corpus readers so a pathological corpus cannot
 * exhaust memory. No network, no session mutation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { isPostmortemRecord, postmortemsDir, type PostmortemRecord } from "./postmortem";

/** Bounds so a pathological corpus cannot exhaust memory (read-only). */
export const MAX_READONLY_POSTMORTEMS = 500;
export const MAX_READONLY_POSTMORTEM_BYTES = 2 * 1024 * 1024;

export interface ReadonlyPostmortemCorpus {
  /** Parsed records, sorted by `ts` (ties broken by `id`) — same as loadPostmortems. */
  postmortems: PostmortemRecord[];
  /** Files unreadable, over the byte cap, not JSON, or not a record (never renamed). */
  skipped: number;
  /** True when the directory held more than `maxFiles` candidate files. */
  truncated: boolean;
}

export function emptyReadonlyPostmortemCorpus(): ReadonlyPostmortemCorpus {
  return { postmortems: [], skipped: 0, truncated: false };
}

/**
 * Read post-mortems from `<stateDir>/postmortems` read-only and bounded.
 *
 * A missing directory is a healthy empty result. An unreadable directory is an
 * error (never posed as "no post-mortems") — exactly like `loadPostmortems`.
 * Every per-file failure is counted in `skipped`; the file itself is left
 * untouched. No transition in this function writes to the filesystem.
 */
export function readPostmortemsReadonly(
  stateDir: string,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): ReadonlyPostmortemCorpus {
  if (typeof stateDir !== "string" || stateDir.trim() === "") {
    throw new Error("readPostmortemsReadonly: stateDir is required");
  }
  const maxFiles =
    Number.isFinite(opts.maxFiles) ? Math.max(1, Math.floor(opts.maxFiles as number)) : MAX_READONLY_POSTMORTEMS;
  const maxBytes =
    Number.isFinite(opts.maxBytes) ? Math.max(1, Math.floor(opts.maxBytes as number)) : MAX_READONLY_POSTMORTEM_BYTES;
  const dir = postmortemsDir(stateDir);
  let names: string[];
  if (!existsSync(dir)) return emptyReadonlyPostmortemCorpus();
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort();
  } catch (err) {
    throw new Error(
      `readPostmortemsReadonly: post-mortems directory is unreadable: ${dir} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const truncated = names.length > maxFiles;
  const postmortems: PostmortemRecord[] = [];
  let skipped = 0;
  for (const name of names.slice(0, maxFiles)) {
    const file = path.join(dir, name);
    try {
      if (statSync(file).size > maxBytes) {
        skipped += 1;
        continue;
      }
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isPostmortemRecord(parsed)) {
        skipped += 1;
        continue;
      }
      postmortems.push(parsed);
    } catch {
      // Unreadable / not JSON / vanished mid-read: skip and count, never rewrite.
      skipped += 1;
    }
  }

  postmortems.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
  return { postmortems, skipped, truncated };
}
