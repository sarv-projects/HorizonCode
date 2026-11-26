/**
 * Codex incremental environment deltas (docs/28 §14).
 *
 * The first turn of a session carries the full, byte-stable environment block.
 * Later turns carry only what changed since that first turn, so a long session
 * does not resend an unchanged block on every provider dispatch. The static
 * prompt prefix is never touched by this module.
 *
 * Pure and dependency-free: no clock, no filesystem, no process state.
 */
import type { EnvironmentInfo } from "./environment";

/** Default number of turns between full environment refreshes. */
export const DEFAULT_ENVIRONMENT_REFRESH_EVERY = 20;

/**
 * Whether a long-running session should resend the full environment block
 * instead of a delta (e.g. after compaction dropped the first-turn facts).
 * `HZ_ENVIRONMENT_REFRESH_EVERY=0` disables refreshes; invalid values fall back
 * to the default interval.
 */
export function environmentRefreshDue(
  turnsSinceBaseline: number,
  env: Record<string, string | undefined> = process.env,
  defaultEvery: number = DEFAULT_ENVIRONMENT_REFRESH_EVERY,
): boolean {
  const raw = env.HZ_ENVIRONMENT_REFRESH_EVERY?.trim();
  const every = raw === undefined || raw === "" ? defaultEvery : Number(raw);
  if (!Number.isFinite(every) || every <= 0) return false;
  return turnsSinceBaseline > 0 && turnsSinceBaseline % every === 0;
}

export interface EnvironmentFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface EnvironmentDelta {
  added: EnvironmentFieldChange[];
  modified: EnvironmentFieldChange[];
  removed: EnvironmentFieldChange[];
}

/** Canonical render order, matching renderEnvironment's line order. */
export const ENVIRONMENT_FIELD_ORDER = [
  "Working directory (workspace)",
  "Date",
  "OS",
  "shell",
  "Git repository",
  "Kernel",
  "Plan mode",
  "Tools",
] as const;

function dateStamp(today: Date): string {
  return Number.isNaN(today.getTime()) ? "" : today.toISOString().slice(0, 10);
}

/** The environment as labelled scalar facts, so a diff can name each field. */
export function environmentFacts(info: EnvironmentInfo): Record<string, string> {
  return {
    "Working directory (workspace)": info.workspace,
    Date: dateStamp(info.today),
    OS: info.os,
    shell: info.shell,
    "Git repository": info.isGitRepo ? "yes" : "no",
    Kernel: info.kernelMode,
    "Plan mode": info.planMode ? "on" : "off",
    Tools: info.tools.length > 0 ? info.tools.join(", ") : "(none)",
  };
}

/**
 * Compare two environments. `added`/`removed` are future-proof for facts that
 * are introduced or dropped by a later version of EnvironmentInfo; today's
 * fixed shape produces `modified` rows only.
 */
export function diffEnvironment(baseline: EnvironmentInfo, current: EnvironmentInfo): EnvironmentDelta {
  const before = environmentFacts(baseline);
  const after = environmentFacts(current);
  const delta: EnvironmentDelta = { added: [], modified: [], removed: [] };
  const fields = new Set([...ENVIRONMENT_FIELD_ORDER, ...Object.keys(before), ...Object.keys(after)]);
  for (const field of fields) {
    const had = Object.prototype.hasOwnProperty.call(before, field);
    const has = Object.prototype.hasOwnProperty.call(after, field);
    if (had && has) {
      if (before[field] !== after[field]) delta.modified.push({ field, from: before[field], to: after[field] });
    } else if (has) {
      delta.added.push({ field, from: "", to: after[field] });
    } else if (had) {
      delta.removed.push({ field, from: before[field], to: "" });
    }
  }
  const rank = (field: string) => {
    const i = (ENVIRONMENT_FIELD_ORDER as readonly string[]).indexOf(field);
    return i < 0 ? ENVIRONMENT_FIELD_ORDER.length : i;
  };
  const byOrder = (a: EnvironmentFieldChange, b: EnvironmentFieldChange) => rank(a.field) - rank(b.field) || a.field.localeCompare(b.field);
  delta.added.sort(byOrder);
  delta.modified.sort(byOrder);
  delta.removed.sort(byOrder);
  return delta;
}

export function hasEnvironmentDelta(delta: EnvironmentDelta): boolean {
  return delta.added.length > 0 || delta.modified.length > 0 || delta.removed.length > 0;
}

/** Render the compact replacement for the environment block. */
export function renderEnvironmentDelta(delta: EnvironmentDelta): string {
  if (!hasEnvironmentDelta(delta)) return "Environment: unchanged since first turn";
  const lines = ["Environment (changes since first turn):"];
  for (const change of delta.modified) lines.push(`- ${change.field}: ${change.from} -> ${change.to}`);
  for (const change of delta.added) lines.push(`- ${change.field}: ${change.to}`);
  for (const change of delta.removed) lines.push(`- ${change.field}: removed (was ${change.from})`);
  return lines.join("\n");
}
