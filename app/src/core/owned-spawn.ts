/**
 * owned-spawn.ts — the single child-spawn path (NF-071).
 *
 * Every child process this runtime starts is owned: it is recorded in a JSONL
 * spawn ledger under the kernel state directory, and a long-lived child gets an
 * owner-death supervisor so the tree cannot outlive the owner (see
 * supervisor.ts). Callers keep their own stdio handling — spawnOwned returns
 * the Bun subprocess it started.
 *
 *   const { proc } = await spawnOwned(["bash", "-lc", cmd], {
 *     stateDir: kernelStateDir(ctx.workspace),
 *     cwd: dir, env: scrubEnv(), detached: true, longLived: false,
 *     label: "shell",
 *   });
 *
 * Ordering is deliberate and fail-closed: spawn, then record, then supervise.
 * If the ledger row cannot be written, the child is killed and the error is
 * raised — an unrecorded child is not owned. If the supervisor cannot start for
 * a long-lived child, the same happens. A ledger that cannot be parsed is
 * QUARANTINED (renamed aside) and reported `corrupt: true`; it is never read as
 * "no spawns", because "the record is unreadable" and "nothing was spawned"
 * are different facts and callers must surface the difference. A single torn
 * trailing line (a crash mid-append) is instead skipped and reported
 * `torn: true` while the intact earlier rows are kept.
 *
 * Failure kills are tree-aware, without pretending to be bulletproof. A
 * detached child leads its own process group, so the group kill reaches its
 * whole tree (unchanged). A non-detached child (`longLived: false`; today the
 * grep/rg path) shares the runtime's process group, so `kill(-pid)` cannot
 * reach it: before the child dies, its descendants are snapshotted from /proc
 * in one pass (ppid read after the last ')'), killed deepest-first, then the
 * child, and a short-grace sweep re-kills snapshot members that were reparented.
 * A descendant that forks inside the final window can still escape — a stated
 * residual; the OS-level fix is NF-016, not this best-effort sweep.
 *
 * The state directory and the ledger are owner-only (docs/03 D12): on Unix the
 * directory has its group/other bits stripped and the ledger is chmod 0600
 * after every append (umask-proof), so a ledger that already existed with a
 * loose mode is tightened on the next append — while a deliberately read-only
 * directory stays read-only instead of being silently made writable.
 */

import { readFileSync, readdirSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import * as path from "node:path";
import { kernelStateDir as resolveKernelStateDir } from "./paths";
import { birthIdentityOf, readProcessFacts, type ProcessIdentity } from "./worker-identity";
import { startOwnerDeathSupervisor } from "./supervisor";

/**
 * The Bun subprocess type, narrowed to what callers use (pid/stdio/kill/exited).
 *
 * `Bun.spawn` types stdout/stderr as `number | ReadableStream` because the
 * stdio mode is only known at runtime. spawnOwned pins `stdin:'ignore'` and
 * `stdout:'pipe'`/`stderr:'pipe'` by default (see the single Bun.spawn call
 * below), so for the owned path those two streams are always ReadableStreams.
 * We reflect that in the type so callers can consume them without re-narrowing
 * a `number` branch that this path never produces. Callers that opt into a
 * different mode (`ignore`/`inherit`) must guard themselves.
 */
export type OwnedProc = Omit<ReturnType<typeof Bun.spawn>, "stdout" | "stderr"> & {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};

export type SpawnStdio = "pipe" | "ignore" | "inherit";

export interface SpawnOwnedOptions {
  /** Kernel state directory: the ledger lives at `<stateDir>/spawns.jsonl`. */
  stateDir: string;
  /** What this spawn is ("shell", "preview:<command>", "code_mode", ...). */
  label: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Per-stream stdio; defaults: stdin ignore, stdout/stderr pipe (caller drains). */
  stdio?: { stdin?: SpawnStdio; stdout?: SpawnStdio; stderr?: SpawnStdio };
  /** Long-lived children default to their own process group (see supervisor). */
  detached?: boolean;
  /** `false` = foreground command: ledger row, no supervisor. Default true. */
  longLived?: boolean;
  /** The process whose death must take this child down (default: this process). */
  ownerPid?: number;
}

/** One line of `<stateDir>/spawns.jsonl`. */
export interface SpawnLedgerEntry {
  pid: number;
  /** Process-group id from /proc, or null when /proc could not be read. */
  pgid: number | null;
  /** `<pid>@<startTicks>` birth identity, or null when /proc could not be read. */
  birthIdentity: string | null;
  label: string;
  ts: string;
  /** argv joined with single spaces; nothing is redacted (this file is local). */
  cmd: string;
}

export interface OwnedSpawn {
  proc: OwnedProc;
  entry: SpawnLedgerEntry;
  /** The birth identity captured at spawn time (undefined when /proc is absent). */
  identity: ProcessIdentity | undefined;
}

export interface SpawnLedgerRead {
  entries: SpawnLedgerEntry[];
  /**
   * True when the ledger was unreadable and got quarantined. Callers MUST treat
   * this as a refusal state and surface it — never as `entries: []` meaning
   * "no spawns".
   */
  corrupt: boolean;
  /**
   * True when a malformed FINAL line with no trailing newline was skipped as a
   * torn append (a crash mid-write). The intact earlier rows are still in
   * `entries` and the file is NOT quarantined. Additive: absent on a clean read.
   */
  torn?: boolean;
  /** Where the corrupt file was moved (`<file>.corrupt-<epochMillis>`). */
  quarantinedTo?: string;
  /** Why it was quarantined (a parse failure or a structurally invalid row). */
  reason?: string;
}

/**
 * `<workspace>/.hz/state/kernel` (canonical) or `<workspace>/.hzcode/kernel`
 * (legacy, honoured in place) — the same default KernelClient resolves.
 * paths.ts owns the rule.
 */
export function kernelStateDir(workspace: string): string {
  return resolveKernelStateDir(workspace);
}

/** The absolute ledger path for a state directory. */
export function spawnLedgerPath(stateDir: string): string {
  return path.join(stateDir, "spawns.jsonl");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSpawnLedgerEntry(value: unknown): value is SpawnLedgerEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<SpawnLedgerEntry>;
  const numberOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v));
  return (
    typeof row.pid === "number" &&
    Number.isInteger(row.pid) &&
    row.pid > 0 &&
    numberOrNull(row.pgid) &&
    (row.birthIdentity === null || typeof row.birthIdentity === "string") &&
    typeof row.label === "string" &&
    typeof row.ts === "string" &&
    typeof row.cmd === "string"
  );
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

async function appendLedgerRow(stateDir: string, entry: SpawnLedgerEntry): Promise<void> {
  const file = spawnLedgerPath(stateDir);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  // Docs/03 D12: the state directory is owner-only. Strip group/other bits only
  // — never grant owner write to a directory that deliberately lacks it, so the
  // append below still fails honestly on a read-only state dir.
  if (isUnix) {
    try {
      const current = (await stat(dir)).mode & 0o777;
      await chmod(dir, current & 0o700);
    } catch {
      /* best effort: the append below reports anything fatal */
    }
  }
  // One append of one line: whole lines only, so a crash cannot interleave the
  // rows of two concurrent spawns beyond what O_APPEND already prevents.
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  // Applied after the append, so an existing loose-mode ledger is tightened too.
  await setOwnerOnly(file, 0o600);
}

/** Bound on the /proc ancestor-chain walk; deeper trees are left to NF-016. */
const MAX_DESCENDANT_DEPTH = 64;
/** Pause between snapshot rounds (lets a just-started child finish forking). */
const KILL_ROUND_PAUSE_MS = 10;
/** Bound on snapshot rounds before the child is killed (~100 ms worst case). */
const MAX_KILL_ROUNDS = 10;
/** Grace before the sweep re-kills reparented survivors of a failed spawn. */
const KILL_SWEEP_GRACE_MS = 30;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True while the pid exists (a zombie still counts); false when it is gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ppid of /proc/<pid>/stat. `comm` can contain spaces and parentheses, so
 * the numeric fields are everything after the LAST ')': state, then ppid.
 * Undefined when the process is gone or /proc is unavailable (non-Linux).
 */
function readPpid(pid: number): number | undefined {
  try {
    const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = statText.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = statText.slice(close + 1).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The descendants of `rootPid` as pid → depth (1 = direct child), from ONE
 * pass over /proc (every numeric entry's ppid, read after the last ')')
 * plus a BFS from the root, bounded at MAX_DESCENDANT_DEPTH. /proc absence
 * yields an empty map: this walk is best-effort, and NF-016 owns the
 * OS-level fix.
 */
function descendantDepths(rootPid: number): Map<number, number> {
  const children = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return new Map();
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    const ppid = readPpid(pid);
    if (ppid === undefined) continue;
    const siblings = children.get(ppid);
    if (siblings === undefined) children.set(ppid, [pid]);
    else siblings.push(pid);
  }
  const depths = new Map<number, number>();
  const queue: number[] = [rootPid];
  depths.set(rootPid, 0);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    const depth = depths.get(current) as number;
    if (depth >= MAX_DESCENDANT_DEPTH) continue;
    for (const child of children.get(current) ?? []) {
      if (depths.has(child)) continue;
      depths.set(child, depth + 1);
      queue.push(child);
    }
  }
  depths.delete(rootPid);
  return depths;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone, or not ours to signal */
  }
}

/** Kill a snapshot deepest-first: a dying parent must not reparent the rest. */
function killDeepestFirst(depths: Map<number, number>): void {
  const ordered = [...depths.entries()].sort((a, b) => b[1] - a[1]);
  for (const [pid] of ordered) killPid(pid);
}

/**
 * Kill a NON-detached child and its descendants. The child shares this
 * process's group, so `kill(-pid)` cannot reach its tree; instead the tree is
 * snapshotted from /proc (ONE pass per round), killed deepest-first so the
 * child cannot reparent a descendant mid-kill, and only then is the child
 * killed. A just-started shell may not have forked anything when the append
 * fails, so rounds pause briefly (bounded: MAX_KILL_ROUNDS) until no new
 * descendants appear — the child still anchors the ancestor chain while it
 * lives. After a short grace, every pid ever seen in a snapshot is re-killed if
 * still alive — reparented survivors whose ppid was the child before it died.
 * Stated residual: a descendant that forks inside the final window (last
 * snapshot → child death) can escape; NF-016 owns the OS-level fix.
 */
async function killNonDetachedTree(pid: number, proc: OwnedProc): Promise<void> {
  const seen = new Set<number>();
  let emptyRounds = 0;
  for (let round = 0; round < MAX_KILL_ROUNDS; round += 1) {
    const depths = descendantDepths(pid);
    for (const descendant of depths.keys()) seen.add(descendant);
    killDeepestFirst(depths);
    emptyRounds = depths.size === 0 ? emptyRounds + 1 : 0;
    // Two quiet rounds in a row: the tree is static (a sleeping descendant does
    // not fork), so nothing more is observable while the child anchors it.
    if (emptyRounds >= 2) break;
    if (round < MAX_KILL_ROUNDS - 1) await sleep(KILL_ROUND_PAUSE_MS);
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(KILL_SWEEP_GRACE_MS);
  for (const survivor of seen) {
    if (isAlive(survivor)) killPid(survivor);
  }
}

/**
 * The failure-path kill, by spawn shape. A detached child leads its own
 * process group, so the existing group kill reaches its whole tree. A
 * non-detached child shares the runtime's group: its descendants are walked
 * and killed individually first (see `killNonDetachedTree`).
 */
async function killOwnedTree(pid: number, proc: OwnedProc, detached: boolean): Promise<void> {
  if (detached) {
    killTree(pid, proc);
    return;
  }
  await killNonDetachedTree(pid, proc);
}

function killTree(pid: number, proc: OwnedProc): void {
  try {
    process.kill(-pid, "SIGKILL"); // the child's whole process group (detached)
  } catch {
    /* not a group leader */
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Start one owned child.
 *
 * 1. spawns it (Bun subprocess; the caller keeps its stdio semantics),
 * 2. appends its ledger row (pid, pgid, birth identity, label, ts, cmd),
 * 3. when `longLived !== false`, starts the owner-death supervisor.
 *
 * A failure in 2 or 3 kills the child tree and throws: the process is never
 * left running without the record or the supervision that owning it means.
 */
export async function spawnOwned(cmd: string[], opts: SpawnOwnedOptions): Promise<OwnedSpawn> {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((part) => typeof part !== "string")) {
    throw new Error("spawnOwned: cmd must be a non-empty array of strings");
  }
  if (cmd.some((part) => part === "")) throw new Error("spawnOwned: cmd parts must not be empty");
  if (typeof opts?.label !== "string" || opts.label.trim() === "") {
    throw new Error("spawnOwned: label is required");
  }
  if (typeof opts?.stateDir !== "string" || opts.stateDir.trim() === "") {
    throw new Error("spawnOwned: stateDir is required");
  }
  const longLived = opts.longLived !== false;
  const detached = opts.detached ?? longLived;
  if (longLived && !detached) {
    throw new Error(
      "spawnOwned: a long-lived child must be detached (it leads its own process group) " +
        "or the owner-death supervisor's killpg cannot reach its tree",
    );
  }

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdio?.stdin ?? "ignore",
    stdout: opts.stdio?.stdout ?? "pipe",
    stderr: opts.stdio?.stderr ?? "pipe",
    detached,
  });

  const pid = typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : -1;
  if (pid < 0) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* nothing to kill */
    }
    throw new Error(`spawnOwned(${opts.label}): process started without a pid`);
  }

  const facts = readProcessFacts(pid);
  const identity: ProcessIdentity | undefined = facts === undefined ? undefined : { pid, startTicks: facts.startTicks };
  const entry: SpawnLedgerEntry = {
    pid,
    pgid: facts?.pgid ?? null,
    birthIdentity: birthIdentityOf(identity),
    label: opts.label,
    ts: new Date().toISOString(),
    cmd: cmd.join(" "),
  };

  try {
    await appendLedgerRow(opts.stateDir, entry);
  } catch (err) {
    await killOwnedTree(pid, proc, detached);
    throw new Error(
      `spawnOwned(${opts.label}): cannot write the spawn ledger (${errorMessage(err)}); child killed (pid ${pid})`,
    );
  }

  if (longLived) {
    try {
      startOwnerDeathSupervisor({ ownerPid: opts.ownerPid ?? process.pid, workerPid: pid });
    } catch (err) {
      killTree(pid, proc);
      throw new Error(`spawnOwned(${opts.label}): cannot start the owner-death supervisor (${errorMessage(err)}); child killed`);
    }
  }

  return { proc, entry, identity };
}

/**
 * Read the spawn ledger.
 *
 * A missing file is empty and healthy (`corrupt: false`). A malformed FINAL
 * line with no trailing newline is a torn append (the writer emits whole
 * `row\n` lines, so a crash can only leave a partial last one): it is skipped,
 * the intact earlier rows are returned, and the result carries `torn: true` —
 * the file is NOT quarantined, because a crash mid-append must not cost the
 * whole history. Any other failure to read or parse — mid-file garbage, or a
 * malformed line the writer did terminate with `\n` — quarantines the file:
 * atomically renamed to `spawns.jsonl.corrupt-<epochMillis>` and reported
 * `corrupt: true` with no entries. The quarantine keeps the bytes for
 * inspection and lets the next spawn start a clean ledger, while the caller
 * sees a refusal state instead of an empty history.
 */
export async function readSpawnLedger(stateDir: string): Promise<SpawnLedgerRead> {
  const file = spawnLedgerPath(stateDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { entries: [], corrupt: false };
    const reason = `ledger is unreadable (${errorMessage(err)})`;
    return quarantine(file, reason);
  }

  const entries: SpawnLedgerEntry[] = [];
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
      if (i === tornIndex) return { entries, corrupt: false, torn: true };
      return quarantine(file, `line ${i + 1} is not JSON (${errorMessage(err)})`);
    }
    if (!isSpawnLedgerEntry(parsed)) {
      if (i === tornIndex) return { entries, corrupt: false, torn: true };
      return quarantine(file, `line ${i + 1} is not a spawn row`);
    }
    entries.push(parsed);
  }
  return { entries, corrupt: false };
}

async function quarantine(file: string, reason: string): Promise<SpawnLedgerRead> {
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    await rename(file, dest);
    return { entries: [], corrupt: true, quarantinedTo: dest, reason };
  } catch (err) {
    // The file stays where it is; the refusal still holds — never read as empty.
    return {
      entries: [],
      corrupt: true,
      reason: `${reason}; quarantine rename failed (${errorMessage(err)})`,
    };
  }
}
