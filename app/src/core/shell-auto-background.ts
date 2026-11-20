/**
 * C-7 reduced (docs/30): auto-background long shell commands after a threshold
 * (default 45s, was 60s in omp). ADAPT oh-my-pi bash backgrounding notice.
 *
 * Ruling **490**: the observation-only registry below links an auto-backgrounded
 * command to a mid-stream steer. A steer arriving while a command is
 * backgrounded stays buffered and is admitted at the next step boundary with a
 * clear notice; the backgrounded process is never killed by this module.
 *
 * The capture map (below) records spill paths and rolling output for the
 * `shell_bg` tool after the shell tool returns; it does not signal processes.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = 45_000;
/** Rolling in-memory cap for background capture (bytes). */
export const BACKGROUND_CAPTURE_MAX_BYTES = 512_000;

export function shellAutoBackgroundMs(env: Record<string, string | undefined> = process.env): number | undefined {
  if (env.HZ_SHELL_AUTO_BACKGROUND === "0") return undefined;
  const raw = env.HZ_SHELL_AUTO_BACKGROUND_MS ?? String(DEFAULT_SHELL_AUTO_BACKGROUND_MS);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

export function shellAutoBackgroundNotice(pid: number, elapsedMs: number): string {
  return (
    `[shell: command still running in the background after ${(elapsedMs / 1000).toFixed(1)}s (pid ${pid}); ` +
    "output below is partial — send a steer message, it will be admitted at the next step boundary and this " +
    "background process keeps running (use shell_bg poll|output|kill, preview, or shell_session for servers)]"
  );
}

/** One command auto-backgrounded by the shell tool (observation only). */
export interface BackgroundedCommand {
  pid: number;
  backgroundedAtMs: number;
  notice: string;
}

// Process-local registry of live auto-backgrounded commands. This module NEVER
// signals/kills a pid — it only records facts so the loop can word its steer
// admission notice honestly. Cleanup is driven by the child's `exited` event.
const activeBackgrounds = new Map<number, BackgroundedCommand>();

/** Record a command the shell tool just auto-backgrounded. */
export function noteAutoBackground(cmd: BackgroundedCommand): void {
  activeBackgrounds.set(cmd.pid, cmd);
}

/** Forget a backgrounded command (called on its `exited` event). */
export function clearAutoBackground(pid: number): void {
  activeBackgrounds.delete(pid);
}

/** Test/host reset of the registry (does not signal any process). */
export function clearAllAutoBackgrounds(): void {
  activeBackgrounds.clear();
  captureByPid.clear();
}

/** Extended capture metadata for `shell_bg` (poll/output/kill). */
export interface BackgroundCapture {
  readonly pid: number;
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string;
  readonly startedAtMs: number;
  buffer: string;
  /** `undefined` while the process is still running. */
  exitCode: number | null | undefined;
  signalCode: string | null | undefined;
}

const captureByPid = new Map<number, BackgroundCapture>();

/** Start spill + in-memory capture when the shell tool auto-backgrounds. */
export function beginBackgroundCapture(entry: {
  pid: number;
  sessionId: string;
  command: string;
  cwd: string;
  logPath: string;
  initialOutput: string;
  startedAtMs: number;
}): void {
  const cap: BackgroundCapture = {
    pid: entry.pid,
    sessionId: entry.sessionId,
    command: entry.command,
    cwd: entry.cwd,
    logPath: entry.logPath,
    startedAtMs: entry.startedAtMs,
    buffer: entry.initialOutput.slice(0, BACKGROUND_CAPTURE_MAX_BYTES),
    exitCode: undefined,
    signalCode: undefined,
  };
  captureByPid.set(entry.pid, cap);
  try {
    writeFileSync(entry.logPath, entry.initialOutput, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* spill best-effort */
  }
}

/** Append streamed stdout/stderr while a background job is live. */
export function appendBackgroundCapture(pid: number, chunk: string): void {
  const row = captureByPid.get(pid);
  if (row === undefined || chunk === "") return;
  if (row.buffer.length < BACKGROUND_CAPTURE_MAX_BYTES) {
    const room = BACKGROUND_CAPTURE_MAX_BYTES - row.buffer.length;
    row.buffer += chunk.slice(0, room);
  }
  try {
    appendFileSync(row.logPath, chunk, { encoding: "utf8" });
  } catch {
    /* spill best-effort */
  }
}

/** Record the child's exit status; the row stays until test reset or process exit cleanup. */
export function completeBackgroundCapture(
  pid: number,
  exitCode: number | null | undefined,
  signalCode: string | null | undefined,
): void {
  const row = captureByPid.get(pid);
  if (row === undefined) return;
  row.exitCode = exitCode ?? null;
  row.signalCode = signalCode ?? null;
}

export function backgroundCapture(pid: number): BackgroundCapture | undefined {
  return captureByPid.get(pid);
}

export function backgroundCapturesForSession(sessionId: string): readonly BackgroundCapture[] {
  return [...captureByPid.values()].filter((c) => c.sessionId === sessionId);
}

export function allBackgroundCaptures(): readonly BackgroundCapture[] {
  return [...captureByPid.values()];
}

export function removeBackgroundCapture(pid: number): void {
  captureByPid.delete(pid);
}

/**
 * Tail the last `maxLines` of captured output (buffer first, then spill file).
 */
export function tailBackgroundOutput(pid: number, maxLines: number): string {
  const row = captureByPid.get(pid);
  const n = Math.min(Math.max(1, Math.floor(maxLines)), 500);
  let text = row?.buffer ?? "";
  if (row !== undefined) {
    try {
      const fromDisk = readFileSync(row.logPath, "utf8");
      if (fromDisk.length > text.length) text = fromDisk;
    } catch {
      /* buffer only */
    }
  }
  if (text === "") return "(no captured output)";
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const slice = lines.slice(-n);
  return slice.join("\n");
}

/** Snapshot of commands still auto-backgrounded. */
export function activeAutoBackgrounds(): readonly BackgroundedCommand[] {
  return [...activeBackgrounds.values()];
}

/**
 * A clear notice when a pending steer is admitted while commands are still
 * auto-backgrounded. `undefined` when none are backgrounded (the ordinary
 * step-boundary notice remains). No process is signalled.
 */
export function backgroundSteerNotice(): string | undefined {
  const bg = activeAutoBackgrounds();
  if (bg.length === 0) return undefined;
  const pids = bg.map((c) => c.pid).join(", ");
  return (
    `mid-turn steer admitted at a step boundary while ${bg.length} auto-backgrounded command` +
    `${bg.length === 1 ? "" : "s"} (pid ${pids}) still running; left running — ` +
    "use preview/shell_session to inspect or stop them explicitly"
  );
}
