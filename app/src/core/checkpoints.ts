/**
 * checkpoints.ts — durable per-turn checkpoints, and the rewind plan they drive.
 *
 * The change journal (`tools/change-journal.ts`) is the workspace's durable undo
 * record: every successful write/edit appends one entry naming the content
 * before it. A checkpoint is that journal's companion: one small record per
 * turn saying "at this point in this session, these journal entry ids were the
 * turn's own changes", so a later rewind can name exactly the changes that came
 * after it.
 *
 * One checkpoint is {id, at, sessionId, messageIndex, label, changes} where
 * `changes` is the set of journal entry ids the turn created and `messageIndex`
 * is the session's message count at record time (used by `rewindTo` to truncate).
 * Records live in `<state root>/checkpoints.jsonl` (`workspaceStateDir()` from
 * `./paths`: canonical `<workspace>/.hz/state/checkpoints.jsonl`, legacy
 * `<workspace>/.hzcode/checkpoints.jsonl` honoured in place).
 *
 * On-disk scheme, and its bounds — the change-journal conventions, copied:
 *
 *   - one JSON record per line, `\n`-terminated, one whole-record O_APPEND
 *     write per checkpoint, so a crash can only leave a torn FINAL line: it is
 *     skipped and reported (`torn: true`) while the intact earlier rows are
 *     kept -- the file is NOT quarantined for that;
 *   - an unreadable or corrupt file (mid-file garbage, or a malformed line the
 *     writer did terminate with `\n`) is QUARANTINED -- atomically renamed to
 *     `checkpoints.jsonl.corrupt-<epochMillis>` with its bytes preserved -- and
 *     reported `corrupt: true`; the store restarts empty. "The record is
 *     unreadable" and "nothing was recorded" are different facts, and no
 *     reader ever sees one as the other;
 *   - the state directory is owner-only (0700) and the file is chmod 0600
 *     after every append (umask-proof), matching the spawn-ledger conventions;
 *   - the newest MAX_CHECKPOINTS records are listed; older rows stay in the
 *     file and fall out of the view (there is no compaction -- see residuals).
 *
 * The read/write mechanics are `tools/change-journal.ts`'s (itself mirroring
 * the spawn ledger, `core/owned-spawn.ts`), copied rather than imported because
 * that module exports none of its helpers; the two stores share the
 * conventions, not the code.
 *
 * `rewindPlan(workspace, checkpointId)` is PURE PLANNING: it computes, and
 * writes nothing -- no restore, no tombstone, no checkpoint record. It reads
 * the stores' current state through their read boundaries (`listCheckpoints`,
 * the journal's `reloadFromDisk`) and returns the restore list, newest first:
 * every LIVE (not tombstoned) journal entry whose id is NOT in the checkpoint's
 * `changes` and whose `at` is at or after the checkpoint's. An entry whose
 * `before` was not kept is listed with `restorable: false` and named in
 * `skipped` with its reason; so is an entry that CREATED a file (`before` null,
 * no flag): this slice restores prior content and never deletes, so the removal
 * branch stays future work (residual, named; `undo` already shows the exact
 * semantics). If the journal is corrupt, the plan REFUSES typed -- a rewind
 * into a state that cannot be verified is worse than no rewind. Identical
 * inputs produce byte-identical plans.
 *
 * Residuals, named honestly:
 *
 *   - Conversational rewind is wired through `HzRuntime.rewindTo` (core/index.ts),
 *     which calls `SessionStore.truncateMessages` at the checkpoint's
 *     `messageIndex` (group-safe boundary). `recordCheckpoint` runs after
 *     successful write/edit turns from the runtime.
 *   - The file side restores content only; a file a later turn created is
 *     reported skipped (`created`) instead of removed.
 *   - There is no cross-process lock (the journal's concurrency note applies
 *     verbatim: whole-record appends interleave safely, nothing else is
 *     guaranteed); labels are caller-supplied with no ranking; a checkpoint
 *     whose append failed is memory-only for this process.
 */

import { randomUUID } from "node:crypto";
import { withFileLockSync } from "./file-lock";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import * as path from "node:path";
import { reloadFromDisk, type JournalEntry, type JournalLoad } from "../tools/change-journal";
import { realpathish, workspaceStateDir } from "./paths";

/** One checkpoint, as persisted: the file is the contract, this is its shape. */
export interface CheckpointRecord {
  /** Unique record id; `/rewind <n>` resolves to it through the list. */
  id: string;
  /** Epoch milliseconds the checkpoint was recorded at (the rewind boundary). */
  at: number;
  /** The session that recorded the checkpoint. */
  sessionId: string;
  /** The session's message count at record time (not yet acted on; see header). */
  messageIndex: number;
  /** Human label; empty = unlabelled (the TUI prints "(no label)"). */
  label: string;
  /** The journal entry ids the turn created -- exactly what a rewind keeps. */
  changes: string[];
}

/** What one checkpoint read found. `corrupt` and `torn` are reported, never hidden. */
export interface CheckpointStatus {
  /**
   * True when the file was unreadable/corrupt and got quarantined. Callers MUST
   * surface this: it is never `checkpoints: []` meaning "no checkpoints".
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

/** The live checkpoints of one workspace, newest first, plus what the read found. */
export interface CheckpointLoad extends CheckpointStatus {
  checkpoints: CheckpointRecord[];
}

/** One numbered checkpoint, as the TUI list and the runtime seam consume it. */
export interface CheckpointView {
  /** 1-based newest-first number: what `/rewind <n>` takes. */
  n: number;
  /** Epoch milliseconds the checkpoint was recorded at. */
  at: number;
  /** Human label; empty = unlabelled. */
  label: string;
  /** The journal entry ids the checkpoint covers (the list's change count). */
  changes: string[];
  /** Transcript length at the checkpoint (what `/fork <n>` cuts at). */
  messageIndex: number;
}

/** One entry the plan would put back, newest first. */
export interface RewindRestore {
  /** Absolute resolved path (what a restore would write). */
  path: string;
  /** Workspace-relative path, for messages. */
  rel: string;
  /**
   * Content before the change, for a restorable entry; null when it cannot be
   * put back (the bytes were not kept, or the change created the file).
   */
  before: string | null;
  /** The journal entry this restore reverses. */
  entryId: string;
  /**
   * True when the entry can be put back as content (`before` is a string). An
   * executor MUST NOT touch an entry with `restorable: false`: `before` null
   * has two very different meanings (not kept / created) and both are named in
   * the plan's `skipped` instead. This slice never deletes files.
   */
  restorable: boolean;
}

/** Why one target entry cannot be put back. */
export type RewindSkipReason = "created" | "nonRestorable" | "beforeUnreadable";

/** One target entry the plan leaves alone, with the honest reason. */
export interface RewindSkip {
  /** Absolute resolved path of the entry. */
  path: string;
  /** Workspace-relative path, for messages. */
  rel: string;
  /** The journal entry that stays as it is. */
  entryId: string;
  reason: RewindSkipReason;
}

/**
 * A rewind plan: pure data, computed by `rewindPlan` and executed by the
 * caller. `refusal` set means the plan MUST NOT be executed; `restores` then
 * holds nothing.
 */
export interface RewindPlan {
  /** The named checkpoint, when it was found. */
  checkpoint?: CheckpointRecord;
  /** A typed refusal (unknown checkpoint, unreadable journal); never executed. */
  refusal?: string;
  /** Target entries to put back, newest first. */
  restores: RewindRestore[];
  /** Target entries the plan cannot put back, with the reason. */
  skipped: RewindSkip[];
  /** True when the newest journal append was torn by a crash and skipped. */
  torn?: boolean;
}

/** Caller options for `recordCheckpoint` (all optional; tests pin them). */
export interface RecordCheckpointOptions {
  /** Human label; default "" (unlabelled). */
  label?: string;
  /** Clock seam: the record's `at`; default Date.now(). */
  now?: number;
  /** Id seam: the record's id; default a fresh randomUUID(). */
  id?: string;
  /** Called when a disk append fails after one retry (memory-only for this process). */
  onAppendFailure?: (message: string) => void;
}

/** The checkpoint file's name inside the workspace state directory. */
export const CHECKPOINT_FILE = "checkpoints.jsonl";

/** The newest records the list keeps; older rows stay in the file, unlisted. */
export const MAX_CHECKPOINTS = 200;

const isUnix = process.platform !== "win32";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`recordCheckpoint: ${what} is required`);
  }
  return value;
}

/**
 * The absolute checkpoint path for a workspace (the paths.ts resolution rule;
 * the workspace is resolved first so a symlinked workspace hits one file).
 */
export function checkpointPath(workspace: string): string {
  return path.join(workspaceStateDir(realpathish(path.resolve(workspace))), CHECKPOINT_FILE);
}

/* --------------------------------- state --------------------------------- */

interface CheckpointState {
  workspace: string;
  file: string;
  /**
   * Records appended in memory but never written to disk (the append failed).
   * The running process can still rewind to them; a later restart will not see
   * them (the record is gone with the process -- see the header).
   */
  pending: CheckpointRecord[];
  /**
   * A quarantine that has not been reported to a caller yet. The next read
   * returns it once (report-once), so a loss of history is never silently
   * invisible. The control flow mirrors the journal's `reloadFromDisk`.
   */
  quarantine?: CheckpointStatus;
}

/** checkpoint file -> state, keyed by the resolved workspace. */
const STATES = new Map<string, CheckpointState>();

function stateFor(workspace: string): CheckpointState {
  const resolved = realpathish(path.resolve(workspace));
  let state = STATES.get(resolved);
  if (state === undefined) {
    state = {
      workspace: resolved,
      file: path.join(workspaceStateDir(resolved), CHECKPOINT_FILE),
      pending: [],
    };
    STATES.set(resolved, state);
  }
  return state;
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
  // Cross-process: serialized against another process's append (file-lock.ts).
  withFileLockSync(`${file}.lock`, () => {
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
    setOwnerOnly(file, 0o600);
  });
}

/** The persisted shape and key order of one checkpoint record. */
function persistedRecord(record: CheckpointRecord): Record<string, unknown> {
  return {
    id: record.id,
    at: record.at,
    sessionId: record.sessionId,
    messageIndex: record.messageIndex,
    label: record.label,
    changes: record.changes,
  };
}

function parseRecord(value: unknown): CheckpointRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const c = value as Partial<CheckpointRecord>;
  if (typeof c.id !== "string" || c.id === "") return undefined;
  if (typeof c.at !== "number" || !Number.isFinite(c.at)) return undefined;
  if (typeof c.sessionId !== "string") return undefined;
  if (typeof c.messageIndex !== "number" || !Number.isInteger(c.messageIndex) || c.messageIndex < 0) return undefined;
  if (typeof c.label !== "string") return undefined;
  if (!Array.isArray(c.changes) || c.changes.some((id) => typeof id !== "string" || id === "")) return undefined;
  return {
    id: c.id,
    at: c.at,
    sessionId: c.sessionId,
    messageIndex: c.messageIndex,
    label: c.label,
    changes: [...c.changes],
  };
}

/** Rename the corrupt file aside, keeping its bytes for inspection. */
function quarantine(file: string, reason: string): CheckpointStatus {
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
 * Read one checkpoint file. A missing file is empty and healthy. A malformed
 * FINAL line with no trailing newline is a torn append: skipped, the intact
 * rows are returned, `torn: true`. Any other parse failure quarantines the file
 * (see the header). Mirrors the journal's `parseJournalFile`.
 */
function parseCheckpointFile(file: string): { records: CheckpointRecord[]; status: CheckpointStatus } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { records: [], status: { corrupt: false } };
    return { records: [], status: quarantine(file, `checkpoints are unreadable (${msg(err)})`) };
  }

  const records: CheckpointRecord[] = [];
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
      if (i === tornIndex) return { records, status: { corrupt: false, torn: true } };
      return { records: [], status: quarantine(file, `line ${i + 1} is not JSON (${msg(err)})`) };
    }
    const record = parseRecord(parsed);
    if (record === undefined) {
      if (i === tornIndex) return { records, status: { corrupt: false, torn: true } };
      return { records: [], status: quarantine(file, `line ${i + 1} is not a checkpoint record`) };
    }
    records.push(record);
  }
  return { records, status: { corrupt: false } };
}

/** Newest first: `at` descending, ties broken by later append order. Stable. */
function newestFirst(records: readonly CheckpointRecord[]): CheckpointRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => b.record.at - a.record.at || b.index - a.index)
    .map(({ record }) => record);
}

/* ------------------------------ the store ------------------------------ */

/**
 * Append one checkpoint for a turn. `changes` are the journal entry ids the
 * turn created (duplicates fold away, order kept); invalid input throws a
 * typed error rather than recording a lie. Appending is best-effort durable,
 * like the journal: if the file cannot be written the record stays in memory
 * for this process and a later restart will not see it.
 */
export function recordCheckpoint(
  workspace: string,
  sessionId: string,
  messageIndex: number,
  changes: readonly string[],
  opts: RecordCheckpointOptions = {},
): CheckpointRecord {
  const session = requireNonEmpty(sessionId, "sessionId");
  if (typeof messageIndex !== "number" || !Number.isInteger(messageIndex) || messageIndex < 0) {
    throw new Error("recordCheckpoint: messageIndex must be a non-negative integer");
  }
  if (!Array.isArray(changes)) {
    throw new Error("recordCheckpoint: changes must be an array of journal entry ids");
  }
  const ids: string[] = [];
  for (const entryId of changes) {
    if (typeof entryId !== "string" || entryId === "") {
      throw new Error("recordCheckpoint: changes entries must be non-empty journal entry ids");
    }
    if (!ids.includes(entryId)) ids.push(entryId);
  }
  if (opts.label !== undefined && typeof opts.label !== "string") {
    throw new Error("recordCheckpoint: label must be a string");
  }
  if (opts.now !== undefined && (typeof opts.now !== "number" || !Number.isFinite(opts.now))) {
    throw new Error("recordCheckpoint: now must be a finite epoch-millisecond number");
  }
  if (opts.id !== undefined && (typeof opts.id !== "string" || opts.id === "")) {
    throw new Error("recordCheckpoint: id must be a non-empty string");
  }

  const record: CheckpointRecord = {
    id: opts.id !== undefined ? opts.id : randomUUID(),
    at: opts.now !== undefined ? Math.floor(opts.now) : Date.now(),
    sessionId: session,
    messageIndex,
    label: opts.label ?? "",
    changes: ids,
  };

  const state = stateFor(workspace);
  const line = persistedRecord(record);
  const persist = () => appendRecordToDisk(state.file, line);
  try {
    persist();
  } catch (err) {
    try {
      persist();
    } catch {
      state.pending.push(record);
      opts.onAppendFailure?.(`checkpoint not persisted to disk (${msg(err)}); kept for this process only`);
    }
  }
  return record;
}

/**
 * Re-read one workspace's checkpoints from disk, newest first. This is the
 * process-restart boundary: after `__resetCheckpointsForTests()` (or in a new
 * process) the same call sees everything a previous run appended. `torn` /
 * `corrupt` / `quarantinedTo` report what the read found; a corrupt read never
 * appears as an empty list without the refusal flag. The newest MAX_CHECKPOINTS
 * are kept; older rows stay in the file and are not listed.
 */
export function listCheckpoints(workspace: string): CheckpointLoad {
  const state = stateFor(workspace);
  const unreported = state.quarantine;
  const { records, status } = parseCheckpointFile(state.file);
  state.quarantine = status.corrupt === true ? status : undefined;
  const onDisk = new Set(records.map((record) => record.id));
  const merged = [...records, ...state.pending.filter((record) => !onDisk.has(record.id))];
  const live = newestFirst(merged).slice(0, MAX_CHECKPOINTS);
  if (status.corrupt) return { ...status, checkpoints: live };
  if (unreported !== undefined) {
    state.quarantine = undefined;
    return { ...unreported, checkpoints: live };
  }
  return { ...status, checkpoints: live };
}

/**
 * The display number of one checkpoint in a newest-first list: the newest is 1,
 * so `/rewind <n>` and the printed list always agree. A position that is not a
 * non-negative finite number has no number (0).
 */
export function checkpointNumber(position: number): number {
  return Number.isFinite(position) && position >= 0 ? Math.floor(position) + 1 : 0;
}

/** Numbered views of a newest-first list, for display and the runtime seam. */
export function checkpointViews(checkpoints: readonly CheckpointRecord[]): CheckpointView[] {
  return checkpoints.map((checkpoint, position) => ({
    n: checkpointNumber(position),
    at: checkpoint.at,
    label: checkpoint.label,
    changes: [...checkpoint.changes],
    messageIndex: checkpoint.messageIndex,
  }));
}

/**
 * The checkpoint `/rewind <n>` names in a newest-first load: n = 1 is the
 * newest. Undefined for a number the list does not contain -- a range check,
 * never an invented record.
 */
export function checkpointByNumber(load: CheckpointLoad, n: number): CheckpointRecord | undefined {
  if (!Number.isInteger(n) || n < 1 || n > load.checkpoints.length) return undefined;
  return load.checkpoints[n - 1];
}

/* ----------------------------- change views ----------------------------- */

/**
 * The live journal entries recorded at or after `sinceMs` (optionally only one
 * session's), oldest first, with the read's status riding along. The runtime
 * seam uses this at turn end to collect the ids a turn created before calling
 * `recordCheckpoint`; the `corrupt`/`torn` flags keep "the journal is
 * unreadable" from being read as "the turn changed nothing".
 */
export function changesSince(workspace: string, sinceMs: number, sessionId?: string): JournalLoad {
  const load = reloadFromDisk(workspace);
  const since = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;
  return {
    ...load,
    entries: load.entries.filter(
      (entry) => entry.at >= since && (sessionId === undefined || entry.sessionId === sessionId),
    ),
  };
}

/* ------------------------------- the plan ------------------------------- */

/** Why a target entry cannot be put back: the flag, or the file was created. */
function skipReason(entry: JournalEntry): RewindSkipReason {
  if (entry.beforeUnreadable === true) return "beforeUnreadable";
  if (entry.nonRestorable === true) return "nonRestorable";
  return "created";
}

/** The one clause a refusal adds about a checkpoint store that could not be read. */
function storeNote(load: CheckpointLoad): string {
  if (load.corrupt !== true) return "";
  return load.quarantinedTo !== undefined
    ? ` (the checkpoint file was corrupt and was moved aside to ${load.quarantinedTo}; the store restarted empty)`
    : ` (the checkpoint file was corrupt: ${load.reason ?? "unreadable"})`;
}

/**
 * Plan a rewind to one checkpoint. PURE: reads the checkpoint store and the
 * journal through their read boundaries and computes -- it writes no restore,
 * no tombstone and no checkpoint record; the caller executes the plan. The
 * restore list holds every live journal entry newer than the checkpoint that
 * the checkpoint's own `changes` does not cover, newest first; entries that
 * cannot be put back are flagged `restorable: false` and named in `skipped`. A
 * corrupt journal, an unreadable checkpoint store or an unknown checkpoint
 * yields a typed `refusal` and an empty plan. Identical inputs, identical bytes.
 */
export function rewindPlan(workspace: string, checkpointId: string): RewindPlan {
  const id = typeof checkpointId === "string" ? checkpointId.trim() : "";
  const load = listCheckpoints(workspace);
  const checkpoint = id === "" ? undefined : load.checkpoints.find((record) => record.id === id);
  if (checkpoint === undefined) {
    return {
      refusal:
        id === ""
          ? `no checkpoint id was given${storeNote(load)}`
          : `no checkpoint ${id} in this workspace's checkpoint store${storeNote(load)}`,
      restores: [],
      skipped: [],
    };
  }

  const journal = reloadFromDisk(workspace);
  if (journal.corrupt === true) {
    const where =
      journal.quarantinedTo !== undefined ? `; the journal was moved aside to ${journal.quarantinedTo}` : "";
    return {
      checkpoint,
      refusal:
        `refusing to rewind: the change journal is unreadable (${journal.reason ?? "corrupt"})${where} — ` +
        `a rewind cannot be verified against it`,
      restores: [],
      skipped: [],
    };
  }

  const own = new Set(checkpoint.changes);
  const targets = journal.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !own.has(entry.id) && entry.at >= checkpoint.at)
    .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
    .map(({ entry }) => entry);

  const restores: RewindRestore[] = [];
  const skipped: RewindSkip[] = [];
  for (const entry of targets) {
    const restorable = entry.before !== null;
    restores.push({
      path: entry.path,
      rel: entry.rel,
      before: entry.before,
      entryId: entry.id,
      restorable,
    });
    if (!restorable) skipped.push({ path: entry.path, rel: entry.rel, entryId: entry.id, reason: skipReason(entry) });
  }

  return {
    checkpoint,
    ...(journal.torn === true ? { torn: true } : {}),
    restores,
    skipped,
  };
}

/**
 * Test-only: drop every in-memory checkpoint store, so the next call re-reads
 * the files exactly as a fresh process would.
 */
export function __resetCheckpointsForTests(): void {
  STATES.clear();
}
