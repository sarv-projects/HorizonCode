/**
 * status-line.ts — user-config status script (forgecode T-17, docs/33 §5.13).
 *
 * User config only: a command receives session JSON on stdin and may print up to
 * five lines (200 chars each), control-stripped. When spawn context is provided,
 * the script runs through `spawnOwned` (non-blocking refresh + cache).
 */

import { spawnSync } from "node:child_process";
import { spawnOwned } from "../core/owned-spawn";
import { sanitizeText } from "./style";

/** User scripts should stay fast; headroom avoids flakes when many tests spawn shells. */
export const STATUS_LINE_TIMEOUT_MS = 500;
export const STATUS_LINE_MAX_LINES = 5;
export const STATUS_LINE_MAX_CHARS = 200;

export interface StatusLineScript {
  command: string;
  args?: string[];
}

export interface StatusLineSpawnContext {
  workspace: string;
  stateDir: string;
}

let lastGood: { key: string; lines: string[]; at: number } | undefined;
let refreshInFlight: Promise<void> | undefined;

function truncateLine(text: string): string {
  if (text.length <= STATUS_LINE_MAX_CHARS) return text;
  return text.slice(0, STATUS_LINE_MAX_CHARS - 1) + "…";
}

function parseStdout(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .slice(0, STATUS_LINE_MAX_LINES)
    .map((l) => truncateLine(sanitizeText(l)));
}

/** Sync path (tests and no kernel state): blocks up to STATUS_LINE_TIMEOUT_MS. */
function runSync(script: StatusLineScript, input: string): string[] {
  const args = [script.command, ...(script.args ?? [])];
  const res = spawnSync(args[0], args.slice(1), {
    input,
    encoding: "utf8",
    timeout: STATUS_LINE_TIMEOUT_MS,
    maxBuffer: 4096,
    env: { ...process.env, COLUMNS: String(process.stdout.columns || 80), LINES: "1" },
  });
  if (res.error || res.status !== 0) return [];
  return parseStdout(String(res.stdout ?? ""));
}

async function refreshOwned(
  script: StatusLineScript,
  input: string,
  cacheKey: string,
  ctx: StatusLineSpawnContext,
): Promise<void> {
  const cmd = [script.command, ...(script.args ?? [])];
  try {
    const { proc } = await spawnOwned(cmd, {
      stateDir: ctx.stateDir,
      label: "status-line",
      cwd: ctx.workspace,
      longLived: false,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    });
    const sink = proc.stdin as unknown as {
      write(data: string): unknown;
      flush?: () => Promise<number> | void;
      end?: () => void;
    };
    sink.write(input);
    await sink.flush?.();
    sink.end?.();
    const killer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, STATUS_LINE_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(killer);
    if (code !== 0) return;
    const raw = await new Response(proc.stdout).text();
    const lines = parseStdout(raw);
    if (lines.length > 0) lastGood = { key: cacheKey, lines, at: Date.now() };
  } catch {
    /* ledger or spawn failure: keep prior cache */
  }
}

export function runStatusLineScript(
  script: StatusLineScript,
  payload: Record<string, unknown>,
  cacheKey: string,
  ctx?: StatusLineSpawnContext,
): string[] {
  const now = Date.now();
  if (lastGood && lastGood.key === cacheKey && now - lastGood.at < 500) return lastGood.lines;
  const input = JSON.stringify(payload);
  if (ctx) {
    if (!refreshInFlight) {
      refreshInFlight = refreshOwned(script, input, cacheKey, ctx).finally(() => {
        refreshInFlight = undefined;
      });
    }
    return lastGood?.key === cacheKey ? lastGood.lines : [];
  }
  const lines = runSync(script, input);
  if (lines.length > 0) lastGood = { key: cacheKey, lines, at: now };
  return lines;
}

/** Test hook: clear the redraw cache. */
export function resetStatusLineCache(): void {
  lastGood = undefined;
  refreshInFlight = undefined;
}
