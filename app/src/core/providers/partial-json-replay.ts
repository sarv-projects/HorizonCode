/**
 * partial-json-replay.ts -- raw→admitted argument binding (plan Task 8).
 *
 * Wraps the existing fail-closed parser unchanged. The raw digest is over the
 * exact incoming bytes; the replay digest is over canonical admitted args.
 * No receipt or kernel contract semantics change here.
 */

import { canonicalJson, sha256Hex } from "../canon";
import { parseToolArguments } from "../json-repair";

export interface PartialJsonReplay {
  args: Record<string, unknown>;
  rawDigest: string;
  replayArgsDigest: string;
  repaired: boolean;
  truncated: boolean;
  repairs: string[];
  error?: string;
}

export function parsePartialJsonWithReplay(
  raw: string,
  toolName?: string,
  schema?: Record<string, unknown>,
): PartialJsonReplay {
  const parsed = parseToolArguments(raw, toolName, schema);
  return {
    args: parsed.args,
    rawDigest: sha256Hex(raw),
    replayArgsDigest: sha256Hex(canonicalJson(parsed.args)),
    repaired: parsed.repaired === true,
    truncated: parsed.truncated === true,
    repairs: parsed.repairs ?? [],
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
  };
}
