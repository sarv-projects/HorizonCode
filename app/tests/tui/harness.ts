/**
 * harness.ts — start the real app the way a user or a script would.
 *
 * Everything spawned here gets its own process group and a kill timer (20s by
 * default), so a hang inside the app can never hang the suite: the timer kills
 * the whole group (app + kernel child) and the run reports `timedOut`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** app/ — the package whose entry point is src/main.ts. */
export const APP_DIR = path.resolve(import.meta.dir, "..", "..");

/** Every spawn is killed after this long unless the app has already exited. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Bun is often not on PATH (`/home/forge/.bun/bin/bun`). */
export const BUN_BIN = resolveBun();

function resolveBun(): string {
  const fallback = "/home/forge/.bun/bin/bun";
  for (const candidate of [process.env.HZ_BUN, process.execPath, fallback]) {
    if (typeof candidate !== "string" || candidate === "") continue;
    if (/bun/i.test(path.basename(candidate)) && existsSync(candidate)) return candidate;
  }
  return fallback;
}

/* ------------------------------- spawning ------------------------------- */

export interface RunResult {
  /** exit code, or null when the process was killed by a signal */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** true when the kill timer had to stop the process */
  timedOut: boolean;
  ms: number;
}

export interface AppProcess {
  child: ChildProcess;
  /** write to the child's stdin (a no-op once it is gone) */
  write(text: string): void;
  /** resolve when the process exited, or when the kill timer fired */
  done: Promise<RunResult>;
  stdout(): string;
  stderr(): string;
  timedOut(): boolean;
  kill(): void;
}

export interface SpawnSpec {
  file?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const live = new Set<AppProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      // The child leads its own group: this reaches the app and the kernel it spawned.
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a group leader: fall through to the direct kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Start one process under a kill timer. */
export function spawnProcess(spec: SpawnSpec): AppProcess {
  const child = spawn(spec.file ?? BUN_BIN, spec.args, {
    cwd: spec.cwd ?? APP_DIR,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  let out = "";
  let err = "";
  let timedOut = false;
  const started = Date.now();

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });

  const proc: AppProcess = {
    child,
    write: (text: string) => {
      try {
        child.stdin?.write(text);
      } catch {
        /* stdin already closed: the app is on its way out */
      }
    },
    done: Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, ms: 0 }),
    stdout: () => out,
    stderr: () => err,
    timedOut: () => timedOut,
    kill: () => killTree(child),
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  proc.done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", (failure: Error) => {
      clearTimeout(timer);
      live.delete(proc);
      reject(failure);
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      live.delete(proc);
      resolve({ code, signal, stdout: out, stderr: err, timedOut, ms: Date.now() - started });
    });
  });

  live.add(proc);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const running of live) killTree(running.child);
    });
  }
  return proc;
}

/** Kill every process this file started (called from afterAll). */
export function killAllProcesses(): void {
  for (const running of live) running.kill();
  live.clear();
}

/** Run a process with `input` on stdin and collect everything it printed. */
export async function runProcess(spec: SpawnSpec, input = ""): Promise<RunResult> {
  const proc = spawnProcess(spec);
  if (input !== "") proc.write(input);
  try {
    proc.child.stdin?.end();
  } catch {
    /* already gone */
  }
  return await proc.done;
}

/* ------------------------------ the app --------------------------------- */

/** `bun run src/main.ts ...` with output that never contains colour. */
export function appSpec(args: string[], env: Record<string, string | undefined> = {}): SpawnSpec {
  return {
    file: BUN_BIN,
    args: ["run", "src/main.ts", ...args],
    cwd: APP_DIR,
    env: { NO_COLOR: "1", ...env },
  };
}

/** The standard headless invocation: a fresh workspace, the offline mock. */
export function headlessSpec(workspace: string, extra: string[] = []): SpawnSpec {
  return appSpec(["--workspace", workspace, "--mock", ...extra]);
}

/** Feed `input` on stdin (a pipe means headless mode) and wait for the exit. */
export function runHeadless(workspace: string, input: string, extra: string[] = []): Promise<RunResult> {
  return runProcess(headlessSpec(workspace, extra), input);
}

/** Short alias for the call sites: start `spec` with `input` on stdin. */
export function runApp(spec: SpawnSpec, input = ""): Promise<RunResult> {
  return runProcess(spec, input);
}

/* ----------------------------- workspaces ------------------------------- */

/** A fresh temporary workspace, optionally seeded with files. */
export function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hzcode-tui-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return dir;
}

function removeWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp folder is not worth failing a test over */
  }
}

/** Hand a test file a set of temp workspaces that share one cleanup. */
export function createWorkspacePool(): { make(files?: Record<string, string>): string; cleanup(): void } {
  const dirs: string[] = [];
  return {
    make(files: Record<string, string> = {}) {
      const dir = makeWorkspace(files);
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      while (dirs.length > 0) removeWorkspace(dirs.pop() as string);
    },
  };
}

/* -------------------------------- misc ---------------------------------- */

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Single-quote a value for `sh -c` (used to build the PTY command line). */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** PTY output arrives with CRLF line endings and cursor noise: flatten it. */
export function flatten(text: string): string {
  return text.replace(/\r/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** How many times `needle` appears in `text`. */
export function occurrences(text: string, needle: string | RegExp): number {
  if (typeof needle === "string") {
    let count = 0;
    let at = text.indexOf(needle);
    while (at >= 0) {
      count += 1;
      at = text.indexOf(needle, at + needle.length);
    }
    return count;
  }
  const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
  return (text.match(new RegExp(needle.source, flags)) ?? []).length;
}

/**
 * Wait until the child has printed `needle` (at least `count` times).
 * Returns false on timeout so the caller's assertion carries the message.
 */
export async function waitFor(
  proc: AppProcess,
  needle: string | RegExp,
  opts: { count?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const wanted = opts.count ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
  for (;;) {
    if (occurrences(flatten(proc.stdout()), needle) >= wanted) return true;
    if (Date.now() > deadline) return false;
    await sleep(40);
  }
}
