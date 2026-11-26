/**
 * replay-args.ts — port of oh-my-pi replayableToolCallArguments (must-steal #12).
 * Source: repo_take/oh-my-pi/packages/ai/src/utils/tool-call-arguments.ts:23-49.
 *
 * The replay sent back to the model must carry what ACTUALLY EXECUTED, not the
 * diagnostic text substituted when raw args do not parse. A bounded 512-char
 * `__parseError` / `__rawJson` diagnostic is preserved for failed parses only.
 * Pure helper; the loop's replay already calls parseToolArguments — this is the
 * additive seam that makes the replayed bytes execution-faithful.
 */

import { parseToolArguments } from "../json-repair";

export const INVALID_ARGUMENTS_RAW_LIMIT = 512;
const TRUNCATED_SUFFIX = /… \[truncated \d+ chars\]$/;

/** Bound raw argument text for a diagnostic; idempotent on already-bounded text. */
export function boundRawToolArguments(raw: string): string {
  if (raw.length <= INVALID_ARGUMENTS_RAW_LIMIT) return raw;
  if (TRUNCATED_SUFFIX.exec(raw)?.index === INVALID_ARGUMENTS_RAW_LIMIT) return raw;
  return `${raw.slice(0, INVALID_ARGUMENTS_RAW_LIMIT)}… [truncated ${raw.length - INVALID_ARGUMENTS_RAW_LIMIT} chars]`;
}

/** Diagnostic for unrepairable args — never a partially recovered executable key. */
export function invalidToolCallArguments(
  raw: string,
  error: unknown,
): Record<string, unknown> {
  return {
    __parseError: error instanceof Error ? error.message : String(error),
    __rawJson: boundRawToolArguments(raw),
  };
}

/** Parse args with repair; on failure return a bounded diagnostic, not a throw. */
export function parseToolCallArguments(json: string | undefined): Record<string, unknown> {
  if (json === undefined || json.trim() === "") return {};
  const parsed = parseToolArguments(json);
  if (parsed.error !== undefined) return invalidToolCallArguments(json, parsed.error);
  return parsed.args;
}

/**
 * Replay what actually executed. Valid raw JSON replays byte-for-byte; repaired
 * JSON replays the executed args; an unrepairable parse replays the raw text
 * (carrying the bounded diagnostic) rather than fabricating a replay.
 */
export function replayableToolCallArguments(
  raw: string,
  executed: Record<string, unknown>,
): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    if (executed !== null && typeof executed === "object" && "__parseError" in executed) return raw;
    return JSON.stringify(executed);
  }
}
