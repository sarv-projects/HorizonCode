/**
 * status-line.ts — user-config status script (forgecode T-17, docs/33 §5.13).
 *
 * User config only: a command receives session JSON on stdin and may print up to
 * five lines (200 chars each), control-stripped. When spawn context is provided,
 * the script runs through `spawnOwned` (non-blocking refresh + cache).
 */

import { spawnSync } from "node:child_process";
import { spawnOwned } from "../core/owned-spawn";
import { scrubEnv } from "../tools/helpers";
import { sanitizeText } from "./style";

/** User scripts should stay fast; headroom avoids flakes when many tests spawn shells. */
export const STATUS_LINE_TIMEOUT_MS = 500;
export const STATUS_LINE_MAX_LINES = 5;
export const STATUS_LINE_MAX_CHARS = 200;
/** Bounded stdout cap (64 KiB) to prevent pipe deadlock when a script writes >64 KB. */
export const STATUS_LINE_MAX_STDOUT_BYTES = 64 * 1024;

export interface StatusLineScript {
  command: string;
  args?: string[];
}

export interface StatusLineSpawnContext {
  workspace: string;
  stateDir: string;
}

export interface PromptCacheHealthPayload {
  warm: boolean;
  hit_ratio: number;
  last_miss_cause?: string;
}

export interface StatusLineTrustSpineFields {
  effectHostMode?: "off" | "opt-in" | "default" | "require";
  egressPosture?: {
    netns: boolean;
    tlsMode: "off" | "peek" | "intercept" | "terminate";
    enforced: boolean;
  };
  piiVault?: {
    active: boolean;
    tokenCount: number;
  };
  principalMode?: "ed25519" | "parent" | "unsigned";
  principalKeyFingerprint?: string;
  prompt_cache?: PromptCacheHealthPayload;
}

/** Build the stdin JSON payload passed to user status-line scripts (includes Track A4 trust-spine fields). */
export function buildStatusLinePayload(
  info: Record<string, unknown> & StatusLineTrustSpineFields,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...info };
  if (info.effectHostMode !== undefined) payload.effectHostMode = info.effectHostMode;
  if (info.egressPosture !== undefined) {
    payload.egressPosture = {
      netns: Boolean(info.egressPosture.netns),
      tlsMode: info.egressPosture.tlsMode,
      enforced: info.egressPosture.enforced === true,
    };
  }
  if (info.piiVault !== undefined) {
    payload.piiVault = {
      active: Boolean(info.piiVault.active),
      tokenCount: Math.max(0, Math.floor(Number(info.piiVault.tokenCount) || 0)),
    };
  }
  if (info.principalMode !== undefined) payload.principalMode = info.principalMode;
  if (info.principalKeyFingerprint !== undefined) {
    payload.principalKeyFingerprint = info.principalKeyFingerprint;
  }
  if (info.prompt_cache !== undefined) {
    payload.prompt_cache = {
      warm: Boolean(info.prompt_cache.warm),
      hit_ratio: Math.max(0, Math.min(1, Number(info.prompt_cache.hit_ratio) || 0)),
      ...(typeof info.prompt_cache.last_miss_cause === "string" && info.prompt_cache.last_miss_cause !== ""
        ? { last_miss_cause: sanitizeText(info.prompt_cache.last_miss_cause) }
        : {}),
    };
  }
  return payload;
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

function statusLineEnv(): Record<string, string> {
  return { ...scrubEnv(), COLUMNS: String(process.stdout.columns || 80), LINES: "1" };
}

/** Sync path (tests and no kernel state): blocks up to STATUS_LINE_TIMEOUT_MS. */
function runSync(script: StatusLineScript, input: string): string[] {
  const args = [script.command, ...(script.args ?? [])];
  const res = spawnSync(args[0], args.slice(1), {
    input,
    encoding: "utf8",
    timeout: STATUS_LINE_TIMEOUT_MS,
    maxBuffer: 4096,
    env: statusLineEnv(),
  });
  if (res.error || res.status !== 0) return [];
  return parseStdout(String(res.stdout ?? ""));
}

async function readBoundedStdout(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number = STATUS_LINE_MAX_STDOUT_BYTES,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (collected < maxBytes) {
        const remaining = maxBytes - collected;
        const slice = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        chunks.push(slice);
        collected += slice.byteLength;
      }
      // Continue draining beyond maxBytes without retaining so the child never deadlocks on a full pipe.
    }
  } catch {
    /* stream closed or cancelled */
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
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
      env: statusLineEnv(),
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
    // Drain stdout concurrently with proc.exited to prevent >64 KiB pipe deadlock.
    const [raw, code] = await Promise.all([
      readBoundedStdout(proc.stdout as ReadableStream<Uint8Array> | null, STATUS_LINE_MAX_STDOUT_BYTES),
      proc.exited,
    ]);
    clearTimeout(killer);
    if (code !== 0) return;
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
