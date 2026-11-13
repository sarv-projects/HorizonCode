/**
 * notify.ts — bell on long turns (docs/13 D15 reduced).
 */

import type { NotifyConfig } from "../core/config";
import type { Renderer } from "./render";

export interface NotifyPrefs {
  bell?: boolean;
  minMs?: number;
}

const DEFAULT_MIN_MS = 30_000;

export function bellOnTurnEnd(durationMs: number, prefs: NotifyPrefs = {}, write: (c: string) => void = (c) => process.stdout.write(c)): boolean {
  if (prefs.bell === false) return false;
  const min = prefs.minMs ?? DEFAULT_MIN_MS;
  if (!Number.isFinite(durationMs) || durationMs < min) return false;
  try {
    write("\u0007");
    return true;
  } catch {
    return false;
  }
}

/** Parse user notify prefs from env (overrides file). */
export function notifyPrefsFromEnv(env: Record<string, string | undefined> = process.env): NotifyPrefs {
  const out: NotifyPrefs = {};
  if (env.HZ_NOTIFY_BELL === "0" || env.HZ_NOTIFY_BELL === "false") out.bell = false;
  else if (env.HZ_NOTIFY_BELL === "1" || env.HZ_NOTIFY_BELL === "true") out.bell = true;
  const minRaw = env.HZ_NOTIFY_MIN_MS;
  if (minRaw !== undefined && minRaw !== "") {
    const minMs = Number(minRaw);
    if (Number.isFinite(minMs)) out.minMs = minMs;
  }
  return out;
}

/** File prefs with env overrides (docs/13 D15). */
export function notifyPrefsMerged(file: NotifyConfig | undefined, env: Record<string, string | undefined> = process.env): NotifyPrefs {
  const prefs: NotifyPrefs = {
    bell: file?.bell ?? true,
    minMs: file?.minMs ?? DEFAULT_MIN_MS,
  };
  const fromEnv = notifyPrefsFromEnv(env);
  return { ...prefs, ...fromEnv };
}

export function describeNotifyPrefs(prefs: NotifyPrefs): string {
  const bell = prefs.bell === false ? "off" : "on";
  const min = prefs.minMs ?? DEFAULT_MIN_MS;
  return `bell ${bell}, min ${min}ms`;
}

/**
 * `/notify [bell on|off] [min <ms>]`: show or persist notify prefs (user config).
 */
export function runNotifyCommand(
  arg: string,
  renderer: Renderer,
  current: NotifyConfig | undefined,
  persist: (prefs: NotifyConfig) => void,
): void {
  const trimmed = arg.trim();
  if (trimmed === "") {
    renderer.notice(`notify: ${describeNotifyPrefs(notifyPrefsMerged(current))}; /notify bell on|off, /notify min <ms>`);
    return;
  }
  const lower = trimmed.toLowerCase();
  const next: NotifyConfig = { bell: current?.bell ?? true, minMs: current?.minMs ?? DEFAULT_MIN_MS };
  if (lower.startsWith("bell")) {
    const rest = lower.slice("bell".length).trim();
    if (rest === "on" || rest === "true" || rest === "1") next.bell = true;
    else if (rest === "off" || rest === "false" || rest === "0") next.bell = false;
    else {
      renderer.notice("usage: /notify bell on|off");
      return;
    }
  } else if (lower.startsWith("min")) {
    const rest = trimmed.slice("min".length).trim();
    const n = Number(rest);
    if (!Number.isFinite(n) || n < 0) {
      renderer.notice("usage: /notify min <milliseconds>");
      return;
    }
    next.minMs = Math.floor(n);
  } else {
    renderer.notice("usage: /notify [bell on|off] or /notify min <ms>");
    return;
  }
  try {
    persist(next);
  } catch {
    /* user config may be read-only */
  }
  renderer.notice(`notify saved: ${describeNotifyPrefs(notifyPrefsMerged(next))}`);
}
