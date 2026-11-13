/**
 * loop-detection.ts — identical-tool-call loop detection (NF-safety rail 1).
 *
 * Grok-style tiered thresholds (IdenticalToolCallRun in grok-build turn.rs):
 * read/plan-style tools use a tight tier; other tools use the default tier.
 * Identity is a whole sampling step: the sorted multiset of (tool, canonical args)
 * in one provider turn (parallel calls reordering does not reset the streak).
 *
 * The loop owns the instance and calls `inspectStep()` once per tool batch BEFORE
 * dispatch; nothing here imports the loop.
 *
 * Signature canonicalization uses `Array.prototype.sort()` default (UTF-16 code-unit)
 * ordering, deliberately NOT the contracts.ts `canonicalJson` UTF-8-byte ordering.
 */

/** Grok-aligned nudge / hard-stop thresholds per tier. */
export const NUDGE_AFTER_IDENTICAL_PROBLEMATIC_TOOL_CALLS = 4;
export const NUDGE_AFTER_IDENTICAL_TOOL_CALLS = 8;
export const MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS = 8;
export const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 12;

/** Tools whose identical repeats are rarely productive (Grok Read + Plan kinds). */
export const PROBLEMATIC_LOOP_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "todo",
  "repo_map",
]);

const STEP_PART_SEP = "\u001e";
const NAME_ARGS_SEP = "\u001f";

/** Whether one tool name belongs in the tight doom-loop tier. */
export function isProblematicallyRepeatingTool(toolName: string): boolean {
  return PROBLEMATIC_LOOP_TOOLS.has(toolName);
}

/**
 * A whole provider step is tight-tier only when every call in it is problematic
 * (Grok `step_is_problematically_repeating`).
 */
export function stepIsProblematicallyRepeating(calls: LoopDetectionCall[]): boolean {
  return calls.length > 0 && calls.every((call) => isProblematicallyRepeatingTool(call.name));
}

/** The two thresholds a tracker enforces for one tier. */
export interface LoopDetectionTierThresholds {
  softThreshold: number;
  hardThreshold: number;
}

export function tierThresholds(problematic: boolean): LoopDetectionTierThresholds {
  return problematic
    ? {
        softThreshold: NUDGE_AFTER_IDENTICAL_PROBLEMATIC_TOOL_CALLS,
        hardThreshold: MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS,
      }
    : {
        softThreshold: NUDGE_AFTER_IDENTICAL_TOOL_CALLS,
        hardThreshold: MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      };
}

/** @deprecated Use tier thresholds; kept for tests that inject custom rails. */
export interface LoopDetectionConfig {
  softThreshold: number;
  hardThreshold: number;
}

/** The mutable per-run state the pure helpers advance. */
export interface LoopDetectionState {
  lastStepSignature: string;
  /** Human label in nudge/stop messages (first tool or `a+b` for parallel steps). */
  lastToolLabel: string;
  consecutiveIdenticalCount: number;
}

export function createLoopDetectionState(): LoopDetectionState {
  return {
    lastStepSignature: "",
    lastToolLabel: "",
    consecutiveIdenticalCount: 0,
  };
}

export function resetLoopDetectionState(state: LoopDetectionState): void {
  state.lastStepSignature = "";
  state.lastToolLabel = "";
  state.consecutiveIdenticalCount = 0;
}

/**
 * Recursively sort object keys with the JavaScript default string comparison
 * (`Array.prototype.sort()` — UTF-16 code units), so two argument objects that
 * differ only in key order produce the same signature. Arrays keep their order;
 * primitives pass through.
 */
export function sortKeys(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * The comparison signature of a tool call's input: `null` is "null"; a string
 * passes through; a non-object stringifies; an object is key-sorted then
 * JSON-stringified; anything that will not serialize falls back to
 * `String(input)`.
 */
export function toolCallSignature(input: unknown): string {
  if (input == null) return "null";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  try {
    return JSON.stringify(sortKeys(input));
  } catch {
    return String(input);
  }
}

/** Sorted multiset signature for one provider sampling step (Grok `step_signature`). */
export function stepSignature(calls: LoopDetectionCall[]): string {
  const parts = calls.map((call) => `${call.name}${NAME_ARGS_SEP}${toolCallSignature(call.input)}`);
  parts.sort();
  return parts.join(STEP_PART_SEP);
}

function stepToolLabel(calls: LoopDetectionCall[]): string {
  if (calls.length === 0) return "";
  if (calls.length === 1) return calls[0]?.name ?? "";
  return calls.map((call) => call.name).join("+");
}

/** The two-boolean verdict a single step check returns. */
export interface LoopCheckResult {
  softWarning: boolean;
  hardEscalation: boolean;
}

/**
 * Advance `state` for one identical step and report threshold crossings.
 * `softWarning` fires on the exact soft threshold; `hardEscalation` at or above hard.
 */
export function checkRepeatedToolStep(
  state: LoopDetectionState,
  signature: string,
  toolLabel: string,
  thresholds: LoopDetectionTierThresholds,
): LoopCheckResult {
  if (signature !== "" && signature === state.lastStepSignature) {
    state.consecutiveIdenticalCount += 1;
  } else {
    state.consecutiveIdenticalCount = 1;
  }
  state.lastStepSignature = signature;
  state.lastToolLabel = toolLabel;

  return {
    softWarning: state.consecutiveIdenticalCount === thresholds.softThreshold,
    hardEscalation: state.consecutiveIdenticalCount >= thresholds.hardThreshold,
  };
}

/**
 * The verdict `LoopDetectionTracker.inspect` / `inspectStep` returns.
 *
 *  - `"ok"`   no repeated-call threshold reached.
 *  - `"soft"` soft-warning threshold reached; the loop may nudge but must not
 *             stop the call (the message rides the next step's corrective).
 *  - `"hard"` hard-escalation threshold reached; the loop stops the run with
 *             the provided `message`.
 */
export interface LoopDetectionVerdict {
  kind: "ok" | "soft" | "hard";
  message?: string;
  toolLabel?: string;
  consecutiveCount?: number;
}

/** The minimal call shape the tracker inspects: a name and its parsed input. */
export interface LoopDetectionCall {
  name: string;
  input: unknown;
}

const LEGACY_DEFAULT_CONFIG: LoopDetectionConfig = {
  softThreshold: 3,
  hardThreshold: 5,
};

/**
 * Per-run identical-tool-call detector. The loop constructs one instance per
 * run (alongside the budget ledger) and calls `inspectStep()` once per provider
 * tool batch before dispatching it.
 */
export class LoopDetectionTracker {
  private readonly legacyConfig: LoopDetectionConfig | undefined;
  private readonly state: LoopDetectionState = createLoopDetectionState();

  /** Pass `config` only in tests that pin the legacy cline 3/5 rail. */
  constructor(config?: Partial<LoopDetectionConfig>) {
    if (config !== undefined) {
      this.legacyConfig = {
        softThreshold: config.softThreshold ?? LEGACY_DEFAULT_CONFIG.softThreshold,
        hardThreshold: config.hardThreshold ?? LEGACY_DEFAULT_CONFIG.hardThreshold,
      };
    }
  }

  inspectStep(calls: LoopDetectionCall[]): LoopDetectionVerdict {
    if (calls.length === 0) return { kind: "ok" };
    const thresholds =
      this.legacyConfig !== undefined
        ? { softThreshold: this.legacyConfig.softThreshold, hardThreshold: this.legacyConfig.hardThreshold }
        : tierThresholds(stepIsProblematicallyRepeating(calls));
    const signature = stepSignature(calls);
    const label = stepToolLabel(calls);
    const result = checkRepeatedToolStep(this.state, signature, label, thresholds);
    if (result.hardEscalation) {
      return {
        kind: "hard",
        message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${label}\`; stopping to avoid a loop.`,
        toolLabel: label,
        consecutiveCount: this.state.consecutiveIdenticalCount,
      };
    }
    if (result.softWarning) {
      return {
        kind: "soft",
        message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${label}\`; consider trying a different approach.`,
        toolLabel: label,
        consecutiveCount: this.state.consecutiveIdenticalCount,
      };
    }
    return { kind: "ok" };
  }

  /** Single-call convenience (same as a one-call `inspectStep`). */
  inspect(call: LoopDetectionCall): LoopDetectionVerdict {
    return this.inspectStep([call]);
  }

  reset(): void {
    resetLoopDetectionState(this.state);
  }
}
