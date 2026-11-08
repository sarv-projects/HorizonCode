/**
 * change-journal.ts -- the workspace's durable undo record.
 *
 * Every successful `write`/`edit` appends one record to the workspace journal
 * at `<state root>/undo.jsonl` (`workspaceStateDir()` from ./paths: canonical
 * `<workspace>/.hz/state/undo.jsonl`, legacy `<workspace>/.hzcode/undo.jsonl`
 * honoured in place). A record carries the resolved path, the content before
 * the change (`null` when the file did not exist), and the sha256 the change
 * produced. An `undo` that succeeds appends a tombstone `{"consume":"<id>"}`
 * instead of rewriting the file, so the journal is append-only.
 *
 * The journal is WORKSPACE-scoped and survives a process restart: `undo` reads
 * it back from disk, and a change made by an earlier session is the next run's
 * to undo. `lastChange(sessionId)` and friends keep their per-session
 * signatures -- the id names the workspace the caller speaks for: an appended
 * record binds its session to the workspace it derived from (path + rel), and a
 * read for an unbound session falls back to the one workspace this process has
 * loaded, if there is exactly one.
 *
 * On-disk scheme, and its bounds:
 *
 *   - one JSON record per line, `\n`-terminated, one append per record, so a
 *     crash can only leave a torn FINAL line: it is skipped and reported
 *     (`torn: true`) while the intact earlier rows are kept -- the file is NOT
 *     quarantined for that (mirrors the spawn ledger, core/owned-spawn.ts);
 *   - an unreadable or corrupt file (mid-file garbage, or a malformed line the
 *     writer did terminate with `\n`) is QUARANTINED -- atomically renamed to
 *     `undo.jsonl.corrupt-<epochMillis>` -- and reported `corrupt: true`; the
 *     journal restarts empty. "The record is unreadable" and "nothing was
 *     recorded" are different facts, and no reader ever sees one as the other;
 *   - per-entry content cap BEFORE_MAX_BYTES (256 KB): a larger preimage is NOT
 *     stored (the record keeps `afterSha256` and carries `nonRestorable: true`),
 *     and `undo` refuses such an entry with a typed message;
 *   - the live set is capped at MAX_JOURNAL_ENTRIES (200): older entries are
 *     dropped from the view, and compaction never rewrites them;
 *   - when an append finds the file past JOURNAL_COMPACT_BYTES (~2 MB) it first
 *     compacts atomically (temp file + rename) to the live entries only --
 *     tombstones and evicted records fold away.
 *
 * The state directory and file are owner-only: the directory has its
 * group/other bits stripped (0700) and the file is chmod 0600 after every
 * append (umask-proof), matching the spawn-ledger conventions. A deliberately
 * read-only directory stays read-only instead of being silently made writable.
 *
 * Concurrency, named honestly: every record is one whole `record\n` write
 * through O_APPEND, so two processes interleave whole records, never the bytes
 * of one record. There is no cross-process lock: compaction is blind to a
 * concurrent append that lands between its read and its rename (that append
 * can be lost), a reader racing a writer can see a torn tail (handled above),
 * and tombstones from one process are applied when the other next reloads.
 * Last writer wins; kernel file locking is future work (the OS-level fix is
 * NF-016).
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { realpathish, workspaceStateDir } from "../core/paths";

/** One change the journal records, as callers build it. */
export interface ChangeEntry {
  /**
   * Unique record id (the tombstone key). Assigned by `recordChange` when the
   * caller does not provide one; every persisted record carries it.
   */
  id?: string;
  at: number;
  /**
   * The session that made the change; filled in by `recordChange` from the
   * sessionId it was called with when the caller does not provide one.
   */
  sessionId?: string;
  /** Absolute resolved path (what the effect landed on). */
  path: string;
  /** Workspace-relative path, for messages. */
  rel: string;
  /**
   * Content before the change; null = the file did not exist (or the content
   * was not kept -- see `nonRestorable`).
   */
  before: string | null;
  /** Existed, but its bytes are not restorable text (binary / not UTF-8). */
  beforeUnreadable?: boolean;
  /** The previous content was over BEFORE_MAX_BYTES: it was not stored. */
  nonRestorable?: boolean;
  /** sha256 of the content this change wrote -- the undo stale-check. */
  afterSha256: string;
  tool: "write" | "edit";
}

/** A change record as the journal holds it: id and sessionId are always set. */
export type JournalEntry = ChangeEntry & { id: string; sessionId: string };

/** One tombstone line: the entry `consume` was undone and must not resurface. */
export interface ConsumeTombstone {
  consume: string;
}

/** What one journal read found. `corrupt` and `torn` are reported, never hidden. */
export interface JournalStatus {
  /**
   * True when the file was unreadable/corrupt and got quarantined. Callers MUST
   * surface this: it is never `entries: []` meaning "nothing changed".
   */
  corrupt: boolean;
  /**
   * True when a malformed FINAL line with no trailing newline was skipped as a
   * torn append (a crash mid-write). Intact earlier rows are kept and the file
   * is NOT quarantined. Additive: absent on a clean read.
   */
  torn?: boolean;
  /** Where the corrupt file was moved (`<file>.corrupt-<epochMillis>`). */
  quarantinedTo?: string;
  /** Why it was quarantined (a parse failure or a structurally invalid row). */
  reason?: string;
}

/** The live entries of one workspace journal, plus what the read found. */
export interface JournalLoad extends JournalStatus {
  entries: JournalEntry[];
}

/** Bounded so a workspace journal cannot grow without limit; oldest entries drop. */
export const MAX_JOURNAL_ENTRIES = 200;

/** Per-entry cap on the stored `before` content (256 KB). See the header. */
export const BEFORE_MAX_BYTES = 256 * 1024;

/** When an append finds the file past this size, it compacts first (~2 MB). */
export const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024;

const JOURNAL_FILE = "undo.jsonl";
const isUnix = process.platform !== "win32";

/** The absolute journal path for a workspace (the paths.ts resolution rule). */
export function journalPath(workspace: string): string {
  return path.join(workspaceStateDir(workspace), JOURNAL_FILE);
}

/* --------------------------------- state --------------------------------- */

interface JournalState {
  workspace: string;
  file: string;
  /** Live entries, oldest -> newest (includes memory-only pending entries). */
  entries: JournalEntry[];
  /**
   * Entries appended in memory but never written to disk (the append failed).
   * They keep in-process undo working, and are folded into the file by the
   * next compaction that succeeds.
   */
  pending: JournalEntry[];
  /**
   * A quarantine that has not been reported to a caller yet. The next
   * `reloadFromDisk` returns it once (report-once), so a loss of history is
   * never silently invisible.
   */
  quarantine?: JournalStatus;
}

/** journal file -> state, keyed by the resolved workspace. */
const JOURNALS = new Map<string, JournalState>();
/** sessionId -> the workspace it writes for (set by recordChange / undo). */
const BINDINGS = new Map<string, string>();
/** sessionId -> entries that could not be attached to any workspace journal. */
const FLOATING = new Map<string, JournalEntry[]>();

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function capEntries(list: JournalEntry[]): JournalEntry[] {
  return list.length > MAX_JOURNAL_ENTRIES ? list.slice(-MAX_JOURNAL_ENTRIES) : list;
}

function sameEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  if (a === b) return true;
  return typeof a.id === "string" && a.id !== "" && a.id === b.id;
}

/** The canonical identity of a workspace: symlink-safe, like the layout rule. */
function stateKey(workspace: string): string {
  return realpathish(path.resolve(workspace));
}

function stateFor(workspace: string): JournalState {
  const resolved = realpathish(path.resolve(workspace));
  const key = stateKey(resolved);
  let state = JOURNALS.get(key);
  if (state === undefined) {
    state = {
      workspace: resolved,
      file: path.join(workspaceStateDir(resolved), JOURNAL_FILE),
      entries: [],
      pending: [],
    };
    JOURNALS.set(key, state);
    loadIntoState(state);
  }
  return state;
}

/**
 * Bind a session to the workspace it writes for. `undo` calls this with the
 * workspace from its ToolContext, so later records from the same session land
 * in the same journal even when the entry alone cannot name it (a path outside
 * the workspace, an absolute `rel`).
 */
export function bindJournalWorkspace(sessionId: string, workspace: string): void {
  BINDINGS.set(sessionId, realpathish(path.resolve(workspace)));
}

/**
 * The workspace an entry names: `relPath()` emits a plain relative path
 * exactly when `path` lies inside the writer's cwd (which the loop pins to the
 * run's workspace), and stripping rel's segments recovers it. Anything else
 * (an absolute or `..`-relative rel) yields undefined.
 */
function workspaceFromEntry(entry: ChangeEntry): string | undefined {
  const rel = entry.rel;
  if (!path.isAbsolute(entry.path) || rel === "" || path.isAbsolute(rel)) return undefined;
  const segments = rel.split(path.sep).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return undefined;
  let dir = path.resolve(entry.path);
  for (let i = 0; i < segments.length; i += 1) dir = path.dirname(dir);
  if (dir === path.parse(dir).root) return undefined;
  // The recovered directory must actually round-trip (a malformed pair, e.g. a
  // synthetic rel longer than the path, is refused rather than invented).
  return path.join(dir, ...segments) === path.resolve(entry.path) ? dir : undefined;
}

/** The workspace a bare sessionId speaks for (no entry to derive from). */
function workspaceFor(sessionId: string): string | undefined {
  const bound = BINDINGS.get(sessionId);
  if (bound !== undefined) return bound;
  const known = new Set<string>();
  for (const workspace of BINDINGS.values()) known.add(stateKey(workspace));
  for (const state of JOURNALS.values()) known.add(stateKey(state.workspace));
  if (known.size === 1) return known.values().next().value as string;
  return undefined;
}

function resolveWorkspace(sessionId: string, entry?: ChangeEntry): string | undefined {
  if (entry !== undefined) {
    const derived = workspaceFromEntry(entry);
    if (derived !== undefined) {
      BINDINGS.set(sessionId, derived);
      return derived;
    }
  }
  return workspaceFor(sessionId);
}

/* ------------------------------- the disk -------------------------------- */

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
 * The state directory, owner-only (docs/03 D12). Strip group/other bits only --
 * never grant owner write to a directory that deliberately lacks it, so an
 * append into a read-only state dir still fails honestly.
 */
function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!isUnix) return;
  try {
    const current = statSync(dir).mode & 0o777;
    chmodSync(dir, current & 0o700);
  } catch {
    /* best effort: the append below reports anything fatal */
  }
}

/** One whole `record\n` append; owner-only mode applied after it. */
function appendRecordToDisk(file: string, record: unknown): void {
  ensureStateDir(path.dirname(file));
  appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  setOwnerOnly(file, 0o600);
}

/** The persisted shape and key order of one change record. */
function persistedRecord(entry: JournalEntry): Record<string, unknown> {
  return {
    id: entry.id,
    at: entry.at,
    sessionId: entry.sessionId,
    path: entry.path,
    rel: entry.rel,
    before: entry.before,
    ...(entry.beforeUnreadable === true ? { beforeUnreadable: true } : {}),
    ...(entry.nonRestorable === true ? { nonRestorable: true } : {}),
    afterSha256: entry.afterSha256,
    tool: entry.tool,
  };
}

function parseEntry(value: unknown): JournalEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const e = value as Partial<JournalEntry>;
  if (typeof e.id !== "string" || e.id === "") return undefined;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return undefined;
  if (typeof e.sessionId !== "string") return undefined;
  if (typeof e.path !== "string" || e.path === "") return undefined;
  if (typeof e.rel !== "string") return undefined;
  if (e.before !== null && typeof e.before !== "string") return undefined;
  if (e.beforeUnreadable !== undefined && e.beforeUnreadable !== true) return undefined;
  if (e.nonRestorable !== undefined && e.nonRestorable !== true) return undefined;
  if (typeof e.afterSha256 !== "string") return undefined;
  if (e.tool !== "write" && e.tool !== "edit") return undefined;
  return e as JournalEntry;
}

function parseTombstone(value: unknown): ConsumeTombstone | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const t = value as Partial<ConsumeTombstone>;
  return typeof t.consume === "string" && t.consume !== "" ? { consume: t.consume } : undefined;
}

/** Rename the corrupt file aside, keeping its bytes for inspection. */
function quarantine(file: string, reason: string): JournalStatus {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, dest);
    return { corrupt: true, quarantinedTo: dest, reason };
  } catch (err) {
    // The file stays where it is; the refusal still holds -- never read as empty.
    return {
      corrupt: true,
      reason: `${reason}; quarantine rename failed (${msg(err)})`,
    };
  }
}

/**
 * Read one journal file. A missing file is empty and healthy. A malformed FINAL
 * line with no trailing newline is a torn append: skipped, the intact rows are
 * returned, `torn: true`. Any other parse failure quarantines the file (see the
 * header). Mirrors core/owned-spawn.ts's ledger read, including the message
 * shapes.
 */
function parseJournalFile(file: string): { live: JournalEntry[]; status: JournalStatus } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { live: [], status: { corrupt: false } };
    return { live: [], status: quarantine(file, `journal is unreadable (${msg(err)})`) };
  }

  const live: JournalEntry[] = [];
  const consumed = new Set<string>();
  const lines = text.split("\n");
  // Only the final line of a file whose bytes do NOT end in "\n" can be torn;
  // a clean read ends with the newline that closed the last whole line.
  const tornIndex = text !== "" && !text.endsWith("\n") ? lines.length - 1 : -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (i === tornIndex) return { live, status: { corrupt: false, torn: true } };
      return { live: [], status: quarantine(file, `line ${i + 1} is not JSON (${msg(err)})`) };
    }
    const tombstone = parseTombstone(parsed);
    if (tombstone !== undefined) {
      consumed.add(tombstone.consume);
      continue;
    }
    const entry = parseEntry(parsed);
    if (entry === undefined) {
      if (i === tornIndex) return { live, status: { corrupt: false, torn: true } };
      return { live: [], status: quarantine(file, `line ${i + 1} is not a change record`) };
    }
    live.push(entry);
  }
  return { live: capEntries(live.filter((e) => !consumed.has(e.id))), status: { corrupt: false } };
}

/** Re-read the file into the state, keeping memory-only appends. */
function loadIntoState(state: JournalState): JournalStatus {
  const { live, status } = parseJournalFile(state.file);
  state.quarantine = status.corrupt === true ? status : undefined;
  const onDisk = new Set(live.map((e) => e.id));
  state.entries = capEntries([...live, ...state.pending.filter((e) => !onDisk.has(e.id))]);
  return status;
}

/**
 * Re-read one workspace journal from disk and return its live entries. This is
 * the process-restart boundary: after `__resetJournalForTests()` (or in a new
 * process) the same call sees everything a previous run appended, minus the
 * entries consumed before it. `torn`/`corrupt`/`quarantinedTo` report what the
 * read found; a quarantine that happened since the last read is reported once.
 */
export function reloadFromDisk(workspace: string): JournalLoad {
  const state = stateFor(workspace);
  const unreported = state.quarantine;
  const found = loadIntoState(state);
  if (found.corrupt) return { ...found, entries: [...state.entries] };
  if (unreported !== undefined) {
    state.quarantine = undefined;
    return { ...unreported, entries: [...state.entries] };
  }
  return { ...found, entries: [...state.entries] };
}

/**
 * Fold the journal to its live entries, atomically (temp file + rename). The
 * rewritten file holds at most MAX_JOURNAL_ENTRIES records and no tombstones:
 * `state.entries` is already the post-tombstone live set. A failure leaves the
 * original file untouched.
 */
function compactNow(state: JournalState): void {
  const dir = path.dirname(state.file);
  const tmp = path.join(dir, `.${JOURNAL_FILE}.hz-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const body = state.entries
    .slice(-MAX_JOURNAL_ENTRIES)
    .map((e) => JSON.stringify(persistedRecord(e)) + "\n")
    .join("");
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, state.file);
    setOwnerOnly(state.file, 0o600);
    // Everything held in memory is on disk now, including memory-only appends.
    state.pending = [];
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Compact before an append that would take the file past the size bound. */
function maybeCompact(state: JournalState): void {
  let size: number;
  try {
    size = statSync(state.file).size;
  } catch {
    return; // no file yet (or unreadable): nothing to compact
  }
  if (size > JOURNAL_COMPACT_BYTES) compactNow(state);
}

/* ------------------------------ the journal ------------------------------ */

/**
 * Append one change to the workspace journal. `id` and `sessionId` are filled
 * in when absent; a `before` over BEFORE_MAX_BYTES is dropped (the record keeps
 * the hash and is marked `nonRestorable`). Appending is best-effort durable: if
 * the file cannot be written, the entry is still kept in memory for this
 * process and a later compaction folds it in.
 */
export function recordChange(sessionId: string, entry: ChangeEntry): void {
  const oversized = typeof entry.before === "string" && Buffer.byteLength(entry.before, "utf8") > BEFORE_MAX_BYTES;
  const full: JournalEntry = {
    ...entry,
    id: typeof entry.id === "string" && entry.id !== "" ? entry.id : randomUUID(),
    sessionId: typeof entry.sessionId === "string" && entry.sessionId !== "" ? entry.sessionId : sessionId,
    ...(oversized ? { before: null, nonRestorable: true } : {}),
  };

  const workspace = resolveWorkspace(sessionId, full);
  if (workspace === undefined) {
    // No journal to attach to (today: a path outside every known workspace on a
    // process that has not resolved one yet). The entry stays in memory so the
    // running process can still undo it; it is not durable.
    const list = FLOATING.get(sessionId) ?? [];
    list.push(full);
    while (list.length > MAX_JOURNAL_ENTRIES) list.shift();
    FLOATING.set(sessionId, list);
    return;
  }

  const state = stateFor(workspace);
  maybeCompact(state);
  state.entries = capEntries([...state.entries, full]);
  try {
    appendRecordToDisk(state.file, persistedRecord(full));
  } catch {
    state.pending.push(full);
  }
}

/**
 * Remove one entry from `workspace`'s journal and append its consume tombstone
 * (so a reload cannot resurrect it). Returns false when the entry was not live
 * there. A tombstone append failure leaves the entry gone in memory only --
 * named residual, the append is the durability point.
 */
export function consumeEntry(workspace: string, entry: ChangeEntry): boolean {
  const state = stateFor(workspace);
  const i = state.entries.findIndex((e) => sameEntry(e, entry));
  if (i === -1) return false;
  const removed = state.entries[i] as JournalEntry;
  state.entries.splice(i, 1);
  const p = state.pending.findIndex((e) => sameEntry(e, entry));
  if (p !== -1) state.pending.splice(p, 1);
  const tombstone: ConsumeTombstone = { consume: removed.id };
  try {
    appendRecordToDisk(state.file, tombstone);
  } catch {
    /* memory-only removal; the entry can resurface after a restart */
  }
  return true;
}

/** Entries this session recorded that could not be attached to a journal. */
export function unpersistedEntries(sessionId: string): ChangeEntry[] {
  return [...(FLOATING.get(sessionId) ?? [])];
}

/** Everything this session's reads should see: its journal plus its leftovers. */
function mergedEntries(sessionId: string): ChangeEntry[] {
  const workspace = workspaceFor(sessionId);
  const journal = workspace === undefined ? [] : stateFor(workspace).entries;
  const leftover = unpersistedEntries(sessionId);
  if (leftover.length === 0) return journal;
  const ids = new Set(journal.map((e) => e.id));
  const extra = leftover.filter((e) => !ids.has(e.id));
  return [...journal, ...extra].sort((a, b) => a.at - b.at);
}

/** The most recent live recorded change in this session's workspace, if any. */
export function lastChange(sessionId: string): ChangeEntry | undefined {
  const list = mergedEntries(sessionId);
  return list.length > 0 ? list[list.length - 1] : undefined;
}

/** The most recent live recorded change to one resolved path. */
export function lastChangeFor(sessionId: string, resolved: string): ChangeEntry | undefined {
  const list = mergedEntries(sessionId);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i] as ChangeEntry;
    if (e.path === resolved) return e;
  }
  return undefined;
}

/**
 * Remove one entry (undo consumed it), tombstoning it in the journal that
 * holds it. Returns false if it was already gone.
 */
export function consumeChange(sessionId: string, entry: ChangeEntry): boolean {
  const workspace = workspaceFor(sessionId) ?? workspaceFromEntry(entry);
  if (workspace !== undefined && consumeEntry(workspace, entry)) return true;
  const list = FLOATING.get(sessionId);
  if (list === undefined) return false;
  const i = list.findIndex((e) => sameEntry(e, entry));
  if (i === -1) return false;
  list.splice(i, 1);
  if (list.length === 0) FLOATING.delete(sessionId);
  return true;
}

/** For tests and diagnostics: live entries in this session's workspace journal. */
export function journalSize(sessionId: string): number {
  const workspace = workspaceFor(sessionId);
  const entries = workspace === undefined ? [] : stateFor(workspace).entries;
  const ids = new Set(entries.map((e) => e.id));
  const extra = unpersistedEntries(sessionId).filter((e) => !ids.has(e.id));
  return entries.length + extra.length;
}

/**
 * Test-only: drop every in-memory journal, binding and leftover, so the next
 * call re-reads the files exactly as a fresh process would.
 */
export function __resetJournalForTests(): void {
  JOURNALS.clear();
  BINDINGS.clear();
  FLOATING.clear();
}
