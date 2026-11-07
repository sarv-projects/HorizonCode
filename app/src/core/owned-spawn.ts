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
 * are different facts and callers must surface the difference.
 */

import { appendFile, mkdir, readFile, rename } from "node:fs/promises";
import * as path from "node:path";
import { birthIdentityOf, readProcessFacts, type ProcessIdentity } from "./worker-identity";
import { startOwnerDeathSupervisor } from "./supervisor";

/** The Bun subprocess type, narrowed to what callers use (pid/stdio/kill/exited). */
export type OwnedProc = ReturnType<typeof Bun.spawn>;

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
  /** Where the corrupt file was moved (`<file>.corrupt-<epochMillis>`). */
  quarantinedTo?: string;
  /** Why it was quarantined (a parse failure or a structurally invalid row). */
  reason?: string;
}

/** `<workspace>/.hzcode/kernel` — the same default KernelClient resolves. */
export function kernelStateDir(workspace: string): string {
  return path.join(workspace, ".hzcode", "kernel");
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

async function appendLedgerRow(stateDir: string, entry: SpawnLedgerEntry): Promise<void> {
  const file = spawnLedgerPath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  // One append of one line: whole lines only, so a crash cannot interleave the
  // rows of two concurrent spawns beyond what O_APPEND already prevents.
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
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
    killTree(pid, proc);
    throw new Error(`spawnOwned(${opts.label}): cannot write the spawn ledger (${errorMessage(err)}); child killed`);
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
 * A missing file is empty and healthy (`corrupt: false`). A file that cannot be
 * read or parsed is quarantined — atomically renamed to
 * `spawns.jsonl.corrupt-<epochMillis>` — and reported `corrupt: true` with no
 * entries. The quarantine keeps the bytes for inspection and lets the next
 * spawn start a clean ledger, while the caller sees a refusal state instead of
 * an empty history.
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
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      return quarantine(file, `line ${i + 1} is not JSON (${errorMessage(err)})`);
    }
    if (!isSpawnLedgerEntry(parsed)) {
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
