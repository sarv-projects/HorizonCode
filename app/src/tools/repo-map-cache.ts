/**
 * repo-map-cache.ts — the persistent per-file identifier index behind `repo_map`.
 *
 * `repo_map` re-extracts its lexical def/ref facts on every call, and on a real
 * repository the identifier counting dominates the build (measured 313 of 578 ms
 * on this repo). This module keeps that extraction phase's output on disk so a
 * later call — and a later process — reparses only what changed:
 *
 *   - location: `<state root>/repo-map/index.json`, where the state root is
 *     `workspaceStateDir()` from ./../core/paths — canonical
 *     `<workspace>/.hz/state/repo-map/index.json`, legacy
 *     `<workspace>/.hzcode/repo-map/index.json` honoured in place. The path is
 *     resolved by the paths.ts rule, never hand-rolled.
 *   - shape: `{ "version": 1, "entries": { "<workspace-relative path>": {
 *     "mtimeMs", "size", "defs", "exported", "refs" } } }` — everything the
 *     per-file extraction phase produces: the def names (exported/`pub` surface
 *     first, as extracted), the parallel exported-flag list, and whole-identifier
 *     occurrence counts (`refs`).
 *   - staleness (the reduced form, stated): an entry is reused only while the
 *     file's `(size, mtimeMs)` BOTH equal the stored pair — the same trust
 *     contract the in-process memo and LocalKernel's `fileStamp`/`tailOf` use.
 *     A file rewritten with identical size within the same mtime millisecond is
 *     missed and served stale; the durable compare-and-swap for that window
 *     belongs with the effect host (kernel-executed effects, NF-016), never here.
 *   - bounds: at most MAX_ENTRIES entries and MAX_BYTES serialized bytes
 *     (2 MB). Over a bound the index keeps the lexicographically first entries
 *     and drops the tail — deterministic, and a dropped file simply reparses on
 *     its next visit. This is a bound, not an LRU: it exists so a pathological
 *     tree cannot make the index unbounded.
 *   - durability: a missing, unreadable, oversized, unparsable or
 *     wrong-version file is reported TYPED (`missing` / `invalid`) and read as
 *     EMPTY, which makes the caller rebuild from source and overwrite the bad
 *     file. Writes are temp-file + rename with the directory created owner-only
 *     and the file chmod 0600 after the rename (the ./change-journal.ts store
 *     convention; docs/03 D12). A failed write is reported, never thrown: the
 *     index is best-effort, and a failed save must not fail a map call.
 *   - concurrency, named honestly: there is no cross-process lock. Two writers
 *     each rename a complete file, so a reader never sees a torn index; the
 *     last rename wins and the loser's entries are simply reparsed next call.
 *     The write is internal state bookkeeping (the change-journal convention),
 *     not a tool effect.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { workspaceStateDir } from "../core/paths";

/** Bumped whenever the persisted shape changes; an older tag means a rebuild. */
export const REPO_MAP_INDEX_VERSION = 1;
/** Serialized-byte bound; over it the lexicographically last entries are dropped. */
export const REPO_MAP_INDEX_MAX_BYTES = 2 * 1024 * 1024;
/** Entry-count bound; the lexicographically last entries beyond it are dropped. */
export const REPO_MAP_INDEX_MAX_ENTRIES = 20_000;

/** Everything the per-file extraction phase produces, as persisted. */
export interface RepoMapFileEntry {
  /** `statSync` mtime in milliseconds (the integer-adjacent float JSON keeps exactly). */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
  /** Def names, exported/`pub` surface first, then module-local, deduped. */
  defs: string[];
  /** Parallel to `defs`: true when the def matched an exported/`pub` pattern. */
  exported: boolean[];
  /** Whole-identifier occurrence counts for this file's text. */
  refs: Record<string, number>;
}

/** What one read of the index found. `missing` and `invalid` both read as empty. */
export type RepoMapIndexLoad =
  | { kind: "valid"; entries: Map<string, RepoMapFileEntry>; raw: string }
  | { kind: "missing"; entries: Map<string, RepoMapFileEntry> }
  | { kind: "invalid"; entries: Map<string, RepoMapFileEntry>; reason: string };

/** Outcome of one save. `written: false` means the bytes were already current (or the write failed: check `ok`). */
export interface RepoMapIndexSave {
  ok: boolean;
  written: boolean;
  /** Entries the capped file kept. */
  kept: number;
  /** Entries dropped to honour a cap (reparsed on their next visit). */
  pruned: number;
  reason?: string;
}

/** Test/diagnostic counters for the persistent layer (the in-process memo has its own). */
export interface RepoMapIndexStats {
  loads: number;
  valid: number;
  missing: number;
  invalid: number;
  hits: number;
  misses: number;
  written: number;
  unchanged: number;
  failed: number;
}

const stats: RepoMapIndexStats = { loads: 0, valid: 0, missing: 0, invalid: 0, hits: 0, misses: 0, written: 0, unchanged: 0, failed: 0 };

/** A snapshot of the persistent-index counters (tests: cold-start a measurement). */
export function repoMapIndexStats(): RepoMapIndexStats {
  return { ...stats };
}

/** Zero the persistent-index counters (the on-disk file is untouched). */
export function resetRepoMapIndexStats(): void {
  stats.loads = 0;
  stats.valid = 0;
  stats.missing = 0;
  stats.invalid = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.written = 0;
  stats.unchanged = 0;
  stats.failed = 0;
}

const isUnix = process.platform !== "win32";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The index directory for a workspace: `<state root>/repo-map` (the paths.ts rule). */
export function repoMapCacheDir(workspace: string): string {
  return path.join(workspaceStateDir(workspace), "repo-map");
}

/** The index file for a workspace: `<state root>/repo-map/index.json` (the paths.ts rule). */
export function repoMapCachePath(workspace: string): string {
  return path.join(repoMapCacheDir(workspace), "index.json");
}

/* --------------------------------- read ---------------------------------- */

/** One entry is well-shaped: numbers finite, defs/exported parallel, refs positive ints. */
function validEntry(value: unknown): value is RepoMapFileEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Partial<RepoMapFileEntry>;
  if (typeof e.mtimeMs !== "number" || !Number.isFinite(e.mtimeMs) || e.mtimeMs < 0) return false;
  if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) return false;
  if (!Array.isArray(e.defs) || !e.defs.every((d) => typeof d === "string")) return false;
  if (!Array.isArray(e.exported) || e.exported.length !== e.defs.length || !e.exported.every((x) => typeof x === "boolean")) return false;
  if (e.refs === null || typeof e.refs !== "object" || Array.isArray(e.refs)) return false;
  for (const v of Object.values(e.refs as Record<string, unknown>)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return false;
  }
  return true;
}

/** Parse the file body. A single malformed entry invalidates the whole file (rebuild). */
function parseIndex(raw: string): { entries: Map<string, RepoMapFileEntry> } | { reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { reason: `not JSON (${msg(e)})` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { reason: "not an index object" };
  const file = value as { version?: unknown; entries?: unknown };
  if (file.version !== REPO_MAP_INDEX_VERSION) {
    return { reason: `unsupported version ${JSON.stringify(file.version ?? null)} (expected ${REPO_MAP_INDEX_VERSION})` };
  }
  if (file.entries === null || typeof file.entries !== "object" || Array.isArray(file.entries)) {
    return { reason: "entries is not an object" };
  }
  const entries = new Map<string, RepoMapFileEntry>();
  for (const [rel, entry] of Object.entries(file.entries as Record<string, unknown>)) {
    if (!validEntry(entry)) return { reason: `entry ${JSON.stringify(rel)} is malformed` };
    entries.set(rel, entry);
  }
  return { entries };
}

/**
 * Read one index file. A missing file is empty and healthy; anything unreadable,
 * oversized, unparsable or from another version is `invalid` — a typed answer the
 * caller rebuilds from, never a crash and never a silent partial index.
 */
export function loadRepoMapIndex(file: string): RepoMapIndexLoad {
  stats.loads++;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      stats.missing++;
      return { kind: "missing", entries: new Map() };
    }
    stats.invalid++;
    return { kind: "invalid", entries: new Map(), reason: `unreadable (${msg(e)})` };
  }
  if (Buffer.byteLength(raw, "utf8") > REPO_MAP_INDEX_MAX_BYTES) {
    stats.invalid++;
    return { kind: "invalid", entries: new Map(), reason: `over the ${REPO_MAP_INDEX_MAX_BYTES} byte cap` };
  }
  const parsed = parseIndex(raw);
  if ("reason" in parsed) {
    stats.invalid++;
    return { kind: "invalid", entries: new Map(), reason: parsed.reason };
  }
  stats.valid++;
  return { kind: "valid", entries: parsed.entries, raw };
}

/**
 * The staleness test as one function: an entry is served only when both the
 * stored size and mtimeMs equal the file's CURRENT pair. Counting lives here so
 * the persistent layer's hits/misses are observable without test-only seams in
 * the walk.
 */
export function lookupRepoMapEntry(
  entries: ReadonlyMap<string, RepoMapFileEntry>,
  rel: string,
  current: { size: number; mtimeMs: number },
): RepoMapFileEntry | undefined {
  const entry = entries.get(rel);
  if (entry !== undefined && entry.size === current.size && entry.mtimeMs === current.mtimeMs) {
    stats.hits++;
    return entry;
  }
  stats.misses++;
  return undefined;
}

/* --------------------------------- write --------------------------------- */

/** Post-create chmod so the mode is exact regardless of umask (best-effort). */
function setOwnerOnly(target: string, mode: number): void {
  if (!isUnix) return;
  try {
    chmodSync(target, mode);
  } catch {
    /* best effort */
  }
}

/**
 * The index directory, owner-only: strip group/other bits — never grant the
 * owner bits a deliberately read-only directory lacks (the change-journal rule).
 */
function ensureCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!isUnix) return;
  try {
    chmodSync(dir, statSync(dir).mode & 0o700);
  } catch {
    /* best effort: the write below reports anything fatal */
  }
}

/** One entry as canonical JSON: fixed field order, refs keys sorted. */
function serializedEntry(entry: RepoMapFileEntry): string {
  const refs = Object.fromEntries(Object.keys(entry.refs).sort().map((key) => [key, entry.refs[key] as number]));
  return JSON.stringify({ mtimeMs: entry.mtimeMs, size: entry.size, defs: entry.defs, exported: entry.exported, refs });
}

/**
 * Serialize under both caps: entries in lexicographic rel order, the tail
 * dropped when the entry count or the byte bound would be exceeded.
 */
function serializeCapped(entries: ReadonlyMap<string, RepoMapFileEntry>): { body: string; kept: number; pruned: number } {
  const overhead = Buffer.byteLength(JSON.stringify({ version: REPO_MAP_INDEX_VERSION, entries: {} }), "utf8");
  const parts: string[] = [];
  let bytes = overhead;
  for (const rel of [...entries.keys()].sort()) {
    if (parts.length >= REPO_MAP_INDEX_MAX_ENTRIES) break;
    const chunk = `${JSON.stringify(rel)}:${serializedEntry(entries.get(rel) as RepoMapFileEntry)}`;
    const add = Buffer.byteLength(chunk, "utf8") + (parts.length > 0 ? 1 : 0);
    if (bytes + add > REPO_MAP_INDEX_MAX_BYTES) break;
    parts.push(chunk);
    bytes += add;
  }
  const body = `{"version":${REPO_MAP_INDEX_VERSION},"entries":{${parts.join(",")}}}`;
  return { body, kept: parts.length, pruned: entries.size - parts.length };
}

/**
 * Write `entries` to `file` atomically (sibling temp file + rename, mode 0600,
 * directory owner-only). When `opts.raw` is the exact text already on disk the
 * bytes are left untouched (the modes are still tightened). Never throws: a
 * failure is reported and the map call goes on.
 */
export function saveRepoMapIndex(
  file: string,
  entries: ReadonlyMap<string, RepoMapFileEntry>,
  opts: { raw?: string } = {},
): RepoMapIndexSave {
  const { body, kept, pruned } = serializeCapped(entries);
  const dir = path.dirname(file);
  if (opts.raw !== undefined && opts.raw === body) {
    // The bytes are current; only tighten the pair (best-effort — this path
    // must not fail a map call either).
    try {
      ensureCacheDir(dir);
      setOwnerOnly(file, 0o600);
    } catch {
      /* best effort */
    }
    stats.unchanged++;
    return { ok: true, written: false, kept, pruned };
  }
  const tmp = path.join(dir, `.${path.basename(file)}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    ensureCacheDir(dir);
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    setOwnerOnly(file, 0o600);
    stats.written++;
    return { ok: true, written: true, kept, pruned };
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    stats.failed++;
    return { ok: false, written: false, kept, pruned, reason: msg(e) };
  }
}

/**
 * The next index after one walk: every file the walk saw replaces (or adds) its
 * entry; loaded entries the walk did not see are dropped when they fall under
 * `dropPrefix` — `""` for a whole-workspace walk (everything not seen is gone),
 * a subtree prefix for a subdirectory call (outside entries are kept), and
 * `undefined` for a walk whose scope cannot be compared (kept).
 */
export function mergeRepoMapEntries(
  loaded: ReadonlyMap<string, RepoMapFileEntry>,
  walked: ReadonlyMap<string, RepoMapFileEntry>,
  opts: { dropPrefix?: string } = {},
): Map<string, RepoMapFileEntry> {
  const next = new Map<string, RepoMapFileEntry>();
  const drop = opts.dropPrefix;
  for (const [rel, entry] of loaded) {
    if (drop !== undefined && (drop === "" || rel.startsWith(drop)) && !walked.has(rel)) continue;
    next.set(rel, entry);
  }
  for (const [rel, entry] of walked) next.set(rel, entry);
  return next;
}
