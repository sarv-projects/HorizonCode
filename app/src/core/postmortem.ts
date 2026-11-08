/**
 * postmortem.ts — the post-mortem record (docs/30 §4 item 8, reduced form).
 *
 * One post-mortem is one JSON file: `<stateDir>/postmortems/<epochMillis>-<shortid>.json`.
 * It never carries the transcript: it carries the transcript's *range*
 * (`firstSeq`/`lastSeq`/`count`), digests of the transcript text and of the
 * failure signature, a name→count summary of the tool calls exercised, and the
 * one line an eval case needs to state a task. That reduction is the point —
 * a post-mortem is small enough to keep in a state directory and precise
 * enough to rebuild an eval case from (see `evals.ts`).
 *
 * Definitions pinned here (and recomputable from `../contracts.ts` alone):
 *  - `transcript.textDigest` = `sha256Hex` of the transcript text. The text is
 *    the events' `text` fields joined with `\n` in the order given; a caller
 *    that passes one opaque string digests that string verbatim.
 *  - `failureDigest` = `digestOf({terminal, detail, failureClass})` — the
 *    canonical-JSON sha256 of the failure signature, so two failures of the
 *    same shape carry the same digest. `failureSignatureDigest()` recomputes
 *    it from the three fields.
 *  - `task` = the first non-blank line of the first `user`-role event, capped
 *    at `TASK_LINE_MAX_CHARS` (a paste is not a task line). Absent → `null`;
 *    `evals.ts` refuses to build a case from a post-mortem with no task rather
 *    than inventing one.
 *
 * Reading is quarantine-shaped exactly like the spawn ledger
 * (`core/owned-spawn.ts`): a missing directory is empty and healthy, a file
 * that cannot be parsed is renamed `<file>.corrupt-<epochMillis>` and reported
 * `corrupt: true`, and "the record is unreadable" is never reported as "no
 * post-mortems". An unreadable *directory* is an error, never an empty history.
 *
 * Records are owner-only (docs/03 D12): the directory is chmod 0700 and each
 * written file 0600 (Unix, umask-proof, best-effort post-create chmod).
 *
 * Not wired: nothing in the loop calls `recordPostmortem` yet — no loop path
 * writes a post-mortem on a failed run; the proposed wiring text lives in the
 * docs/28 ruling draft for this slice (the `docs/30` §4 item 8 remainder).
 * No eval RUNNER exists anywhere: this module is data plumbing.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { RunExit, TerminalState } from "../contracts";
import { digestOf, sha256Hex } from "./canon";

/** The directory (under the state directory) that holds the records. */
export const POSTMORTEM_DIR = "postmortems";

/** The fail-closed task-line cap; longer first lines are cut with a `…`. */
export const TASK_LINE_MAX_CHARS = 300;

/** The explicit failure-class enum (small, closed; `unknown` is a real value). */
export const FAILURE_CLASSES = ["provider_error", "tool_error", "budget", "format", "refusal", "unknown"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** The `RunExit.detail` vocabulary of `../contracts.ts` (closed set). */
export type PostmortemDetail = NonNullable<RunExit["detail"]>;

/**
 * The RC-7 terminal vocabulary as data. The Record is exhaustive by
 * construction: adding a value to `TerminalState` in `../contracts.ts` makes
 * this declaration fail to compile instead of silently missing a value here.
 */
const RC7: Record<TerminalState, true> = {
  succeeded: true,
  failed: true,
  denied: true,
  cancelled: true,
  unknown: true,
  budget_exhausted: true,
  timeout: true,
  interrupted: true,
};
const TERMINALS: readonly string[] = Object.keys(RC7);

/** One transcript event, as much as the range and the task line need. */
export interface TranscriptEvent {
  /** 1-based position in the session log (the `Seq` convention of docs/05). */
  seq: number;
  /** Who produced it; only `user` can own the task line. */
  role?: string;
  /** The event text, when it has one. */
  text?: string;
}

/** A transcript is an event list, or one opaque text (range fields stay null). */
export type TranscriptInput = string | readonly TranscriptEvent[];

/** Tool calls as a name→count map, or as the bare list of names to count. */
export type ToolCallsInput = Readonly<Record<string, number>> | readonly string[];

export interface RecordPostmortemInput {
  /** State directory; the record lands in `<stateDir>/postmortems/` (mkdir -p). */
  stateDir: string;
  sessionId: string;
  /** The RC-7 outcome (a `succeeded` post-mortem is legal: noteworthy ≠ failed). */
  terminal: TerminalState;
  /** The `RunExit.detail` that came with the terminal state, when there was one. */
  detail?: PostmortemDetail;
  transcript: TranscriptInput;
  toolCalls?: ToolCallsInput;
  failureClass: FailureClass;
  /** Clock seam (tests, replay): the filename stamp and `ts` come from here. */
  now?: number;
}

/** The transcript RANGE, plus the digest of the text it was taken from. */
export interface PostmortemTranscript {
  /** First event seq seen, or null when the transcript was opaque text. */
  firstSeq: number | null;
  /** Last event seq seen, or null when the transcript was opaque text. */
  lastSeq: number | null;
  /** Event count; an opaque text counts as one unit. */
  count: number;
  /** `sha256Hex` of the transcript text (definition in this file's header). */
  textDigest: string;
}

/** One post-mortem file's contents (the on-disk shape, exactly). */
export interface PostmortemRecord {
  /** The file stem: `<epochMillis>-<shortid>` (`<id>.json` in the directory). */
  id: string;
  sessionId: string;
  /** ISO-8601, derived from the same clock as the filename stamp. */
  ts: string;
  terminal: TerminalState;
  detail: string | null;
  failureClass: FailureClass;
  /** The first user-visible task line, or null when none was found. */
  task: string | null;
  transcript: PostmortemTranscript;
  /** Name → count; keys sorted. */
  toolCalls: Record<string, number>;
  /** `digestOf({terminal, detail, failureClass})` — the failure signature. */
  failureDigest: string;
}

/** One quarantined file: renamed aside, reported `corrupt: true`. */
export interface PostmortemQuarantine {
  /** The file name inside the post-mortems directory. */
  file: string;
  corrupt: true;
  /** Where it was moved (`<file>.corrupt-<epochMillis>`), when the rename ran. */
  quarantinedTo?: string;
  reason: string;
}

export interface PostmortemLoad {
  /** Parsed records, sorted by `ts` (ties broken by `id`). */
  postmortems: PostmortemRecord[];
  /** One entry per quarantined file; empty means every file parsed. */
  quarantine: PostmortemQuarantine[];
  /**
   * True when at least one file was quarantined. Callers MUST treat this as a
   * refusal state and surface it — never as `postmortems: []` meaning "no
   * post-mortems".
   */
  corrupt: boolean;
}

/** `<stateDir>/postmortems` — where the records live. */
export function postmortemsDir(stateDir: string): string {
  return path.join(stateDir, POSTMORTEM_DIR);
}

/** The absolute path of one record (`id` comes from `recordPostmortem`). */
export function postmortemPath(stateDir: string, id: string): string {
  return path.join(postmortemsDir(stateDir), `${id}.json`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isUnix = process.platform !== "win32";

/**
 * Post-create chmod so the mode is exact regardless of umask. Best-effort: a
 * target that vanished between the write and the chmod is not an error, and on
 * non-Unix the call is a no-op (POSIX modes do not exist there).
 */
async function setOwnerOnly(target: string, mode: number): Promise<void> {
  if (!isUnix) return;
  try {
    await chmod(target, mode);
  } catch {
    /* best effort */
  }
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`recordPostmortem: ${what} is required`);
  }
  return value;
}

function isTerminal(value: unknown): value is TerminalState {
  return typeof value === "string" && TERMINALS.includes(value);
}

function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value);
}

function randomShortId(): string {
  return randomBytes(4).toString("hex");
}

/** The failure signature whose canonical-JSON sha256 is `failureDigest`. */
export function failureSignatureDigest(signature: {
  terminal: TerminalState;
  detail: string | null;
  failureClass: FailureClass;
}): string {
  return digestOf({ terminal: signature.terminal, detail: signature.detail, failureClass: signature.failureClass });
}

interface NormalizedTranscript {
  text: string;
  firstSeq: number | null;
  lastSeq: number | null;
  count: number;
  task: string | null;
}

/**
 * Extract the first user-visible task line, conservatively: the first
 * non-blank line of the first event whose role is exactly `user`. Anything
 * else (a system rail, an assistant message, an opaque text) yields null — a
 * caller that wants a task states one as a user event.
 */
export function firstUserTaskLine(transcript: TranscriptInput): string | null {
  if (typeof transcript === "string" || !Array.isArray(transcript)) return null;
  for (const event of transcript) {
    const role = typeof event?.role === "string" ? event.role.toLowerCase() : "";
    if (role !== "user") continue;
    const text = typeof event?.text === "string" ? event.text : "";
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "") continue;
      return line.length > TASK_LINE_MAX_CHARS ? `${line.slice(0, TASK_LINE_MAX_CHARS)}…` : line;
    }
  }
  return null;
}

function normalizeTranscript(input: unknown): NormalizedTranscript {
  if (typeof input === "string") {
    return { text: input, firstSeq: null, lastSeq: null, count: 1, task: null };
  }
  if (!Array.isArray(input)) {
    throw new Error("recordPostmortem: transcript must be a string or an array of {seq, role?, text?} events");
  }
  let firstSeq: number | null = null;
  let lastSeq: number | null = null;
  const texts: string[] = [];
  input.forEach((event, index) => {
    const seq = (event as TranscriptEvent | null)?.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
      throw new Error(`recordPostmortem: transcript[${index}].seq must be a positive integer`);
    }
    firstSeq = firstSeq === null ? seq : Math.min(firstSeq, seq);
    lastSeq = lastSeq === null ? seq : Math.max(lastSeq, seq);
    const text = (event as TranscriptEvent).text;
    texts.push(typeof text === "string" ? text : "");
  });
  return {
    text: texts.join("\n"),
    firstSeq,
    lastSeq,
    count: input.length,
    task: firstUserTaskLine(input as readonly TranscriptEvent[]),
  };
}

function normalizeToolCalls(input: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (input === undefined || input === null) return counts;
  if (Array.isArray(input)) {
    for (const name of input) {
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("recordPostmortem: toolCalls entries must be non-empty tool names");
      }
      counts[name] = (counts[name] ?? 0) + 1;
    }
  } else if (typeof input === "object") {
    for (const [name, count] of Object.entries(input as Record<string, unknown>)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new Error(`recordPostmortem: toolCalls["${name}"] must be a non-negative integer`);
      }
      if (name.trim() === "") throw new Error("recordPostmortem: toolCalls names must not be blank");
      counts[name] = count;
    }
  } else {
    throw new Error("recordPostmortem: toolCalls must be a name→count map or an array of names");
  }
  const sorted: Record<string, number> = {};
  for (const name of Object.keys(counts).sort()) sorted[name] = counts[name] as number;
  return sorted;
}

/**
 * Write one post-mortem. The directory is created if absent; the file name is
 * `<epochMillis>-<shortid>.json` and the id is that stem, so the record and the
 * file always agree. The write is create-exclusive (`wx`): an existing file is
 * never overwritten, and an astronomically unlikely id collision retries with a
 * fresh shortid before failing.
 */
export async function recordPostmortem(input: RecordPostmortemInput): Promise<PostmortemRecord> {
  const stateDir = requireNonEmpty(input?.stateDir, "stateDir");
  const sessionId = requireNonEmpty(input?.sessionId, "sessionId");
  if (!isTerminal(input?.terminal)) {
    throw new Error(`recordPostmortem: terminal must be an RC-7 value (${TERMINALS.join(", ")})`);
  }
  if (!isFailureClass(input?.failureClass)) {
    throw new Error(`recordPostmortem: failureClass must be one of (${FAILURE_CLASSES.join(", ")})`);
  }
  const transcript = normalizeTranscript(input.transcript);
  const toolCalls = normalizeToolCalls(input.toolCalls);
  const detail = typeof input.detail === "string" && input.detail !== "" ? input.detail : null;
  const now =
    typeof input.now === "number" && Number.isSafeInteger(Math.floor(input.now)) ? Math.floor(input.now) : Date.now();

  await mkdir(postmortemsDir(stateDir), { recursive: true });
  // Docs/03 D12: the records live owner-only — dir 0700, files 0600.
  await setOwnerOnly(postmortemsDir(stateDir), 0o700);

  const base = {
    sessionId,
    ts: new Date(now).toISOString(),
    terminal: input.terminal,
    detail,
    failureClass: input.failureClass,
    task: transcript.task,
    transcript: {
      firstSeq: transcript.firstSeq,
      lastSeq: transcript.lastSeq,
      count: transcript.count,
      textDigest: sha256Hex(transcript.text),
    },
    toolCalls,
    failureDigest: failureSignatureDigest({ terminal: input.terminal, detail, failureClass: input.failureClass }),
  } satisfies Omit<PostmortemRecord, "id">;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = `${now}-${randomShortId()}`;
    const record: PostmortemRecord = { id, ...base };
    const file = postmortemPath(stateDir, id);
    try {
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Applied after the create: umask-proof, and a loose file cannot be
      // overwritten here anyway (the write is create-exclusive).
      await setOwnerOnly(file, 0o600);
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "EEXIST") continue;
      throw new Error(`recordPostmortem: cannot write ${file} (${errorMessage(err)})`);
    }
  }
  throw new Error("recordPostmortem: could not allocate a unique id after 4 attempts");
}

const HEX64 = /^[0-9a-f]{64}$/;

function isNullishOrInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function isPostmortemRecord(value: unknown): value is PostmortemRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<PostmortemRecord>;
  const transcript = row.transcript as Partial<PostmortemTranscript> | undefined;
  const toolCalls: unknown = (row as Record<string, unknown>).toolCalls;
  if (
    typeof row.id !== "string" ||
    row.id === "" ||
    typeof row.sessionId !== "string" ||
    typeof row.ts !== "string" ||
    !isTerminal(row.terminal) ||
    !(row.detail === null || typeof row.detail === "string") ||
    !isFailureClass(row.failureClass) ||
    !(row.task === null || typeof row.task === "string") ||
    typeof row.failureDigest !== "string" ||
    !HEX64.test(row.failureDigest)
  ) {
    return false;
  }
  if (
    transcript === undefined ||
    !isNullishOrInteger(transcript.firstSeq) ||
    !isNullishOrInteger(transcript.lastSeq) ||
    typeof transcript.count !== "number" ||
    !Number.isInteger(transcript.count) ||
    typeof transcript.textDigest !== "string" ||
    !HEX64.test(transcript.textDigest)
  ) {
    return false;
  }
  if (toolCalls === undefined || toolCalls === null || typeof toolCalls !== "object" || Array.isArray(toolCalls)) {
    return false;
  }
  for (const count of Object.values(toolCalls)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return false;
  }
  return true;
}

async function quarantineFile(dir: string, file: string, reason: string): Promise<PostmortemQuarantine> {
  const source = path.join(dir, file);
  const dest = `${source}.corrupt-${Date.now()}`;
  try {
    await rename(source, dest);
    return { file, corrupt: true, quarantinedTo: dest, reason };
  } catch (err) {
    // The file stays where it is; the refusal still holds — never read as empty.
    return { file, corrupt: true, reason: `${reason}; quarantine rename failed (${errorMessage(err)})` };
  }
}

/**
 * Read every post-mortem in `<stateDir>/postmortems`.
 *
 * A missing directory is empty and healthy (`corrupt: false`, no quarantine).
 * Each `*.json` file that cannot be read, parsed, or recognised as a record is
 * renamed `<file>.corrupt-<epochMillis>` and reported in `quarantine` with
 * `corrupt: true`; the files that did parse are still returned, and the load
 * result carries the refusal. Quarantine-named files (and anything that is not
 * `*.json`) are left alone. An unreadable directory throws rather than posing
 * as an empty history.
 */
export async function loadPostmortems(stateDir: string): Promise<PostmortemLoad> {
  const dir = postmortemsDir(requireNonEmpty(stateDir, "stateDir"));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { postmortems: [], quarantine: [], corrupt: false };
    }
    throw new Error(`loadPostmortems: post-mortems directory is unreadable: ${dir} (${errorMessage(err)})`);
  }

  const postmortems: PostmortemRecord[] = [];
  const quarantine: PostmortemQuarantine[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    let text: string;
    try {
      text = await readFile(path.join(dir, name), "utf8");
    } catch (err) {
      quarantine.push(await quarantineFile(dir, name, `unreadable (${errorMessage(err)})`));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      quarantine.push(await quarantineFile(dir, name, `not JSON (${errorMessage(err)})`));
      continue;
    }
    if (!isPostmortemRecord(parsed)) {
      quarantine.push(await quarantineFile(dir, name, "not a postmortem record"));
      continue;
    }
    postmortems.push(parsed);
  }

  postmortems.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1));
  return { postmortems, quarantine, corrupt: quarantine.length > 0 };
}
