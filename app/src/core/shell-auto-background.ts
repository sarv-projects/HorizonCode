/**
 * C-7 reduced (docs/30): auto-background long shell commands after a threshold
 * (default 45s, was 60s in omp). ADAPT oh-my-pi bash backgrounding notice.
 *
 * Ruling **490**: the observation-only registry below links an auto-backgrounded
 * command to a mid-stream steer. A steer arriving while a command is
 * backgrounded stays buffered and is admitted at the next step boundary with a
 * clear notice; the backgrounded process is never killed by this module.
 */

export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = 45_000;

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
    "background process keeps running (use preview/shell_session for servers)]"
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
