/**
 * C-7 reduced (docs/30): auto-background long shell commands after a threshold
 * (default 45s, was 60s in omp). ADAPT oh-my-pi bash backgrounding notice.
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
    "output below is partial — steer with a new message or use preview/shell_session for servers]"
  );
}
