/**
 * loop-detection.ts — identical-tool-call loop detection (NF-safety rail 1).
 *
 * A self-contained port of cline's loop-detection safety rail
 * (packages/core/src/runtime/safety/loop-detection.ts): it counts consecutive
 * identical tool calls (same name AND same canonicalized arguments) and raises
 * a soft warning at the soft threshold, a hard escalation at the hard one. The
 * loop (loop.ts) owns the instance and calls `inspect()` once per tool call
 * BEFORE dispatch; nothing here imports the loop.
 *
 * The signature canonicalization uses `Array.prototype.sort()` default (UTF-16
 * code-unit) ordering, deliberately NOT the contracts.ts `canonicalJson`
 * UTF-8-byte ordering: this rail only compares a call against the immediately
 * preceding call, never hashes for interop, so matching cline's behavior
 * verbatim is what matters.
 */

/** The two thresholds a tracker enforces. */
export interface LoopDetectionConfig {
  /** Consecutive identical count that raises a soft warning (exact `===`). */
  softThreshold: number;
  /** Consecutive identical count that raises a hard escalation (`>=`). */
  hardThreshold: number;
}

/** The mutable per-run state the pure helpers advance. */
export interface LoopDetectionState {
  lastToolName: string;
  lastToolSignature: string;
  consecutiveIdenticalCount: number;
}

export function createLoopDetectionState(): LoopDetectionState {
  return {
    lastToolName: "",
    lastToolSignature: "",
    consecutiveIdenticalCount: 0,
  };
}

export function resetLoopDetectionState(state: LoopDetectionState): void {
  state.lastToolName = "";
  state.lastToolSignature = "";
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

/** The two-boolean verdict a single `checkRepeatedToolCall` returns. */
export interface LoopCheckResult {
  softWarning: boolean;
  hardEscalation: boolean;
}

/**
 * Advance `state` for one call and report whether it crossed either threshold.
 * A matching name+signature increments the streak; anything else resets it to
 * 1. `softWarning` fires on the exact soft threshold; `hardEscalation` fires at
 * or above the hard one.
 */
export function checkRepeatedToolCall(
  state: LoopDetectionState,
  toolName: string,
  signature: string,
  config: LoopDetectionConfig,
): LoopCheckResult {
  if (toolName === state.lastToolName && signature === state.lastToolSignature) {
    state.consecutiveIdenticalCount += 1;
  } else {
    state.consecutiveIdenticalCount = 1;
  }
  state.lastToolName = toolName;
  state.lastToolSignature = signature;

  return {
    softWarning: state.consecutiveIdenticalCount === config.softThreshold,
    hardEscalation: state.consecutiveIdenticalCount >= config.hardThreshold,
  };
}

/**
 * The verdict `LoopDetectionTracker.inspect` returns.
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
}

/** The minimal call shape the tracker inspects: a name and its parsed input. */
export interface LoopDetectionCall {
  name: string;
  input: unknown;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
  softThreshold: 3,
  hardThreshold: 5,
};

/**
 * Per-run identical-tool-call detector. The loop constructs one instance per
 * run (alongside the budget ledger) and calls `inspect()` once per tool call
 * before dispatching the batch.
 */
export class LoopDetectionTracker {
  private readonly config: LoopDetectionConfig;
  private readonly state: LoopDetectionState = createLoopDetectionState();

  constructor(config?: Partial<LoopDetectionConfig>) {
    this.config = {
      softThreshold: config?.softThreshold ?? DEFAULT_CONFIG.softThreshold,
      hardThreshold: config?.hardThreshold ?? DEFAULT_CONFIG.hardThreshold,
    };
  }

  inspect(call: LoopDetectionCall): LoopDetectionVerdict {
    const signature = toolCallSignature(call.input);
    const result = checkRepeatedToolCall(this.state, call.name, signature, this.config);
    if (result.hardEscalation) {
      return {
        kind: "hard",
        message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; stopping to avoid a loop.`,
      };
    }
    if (result.softWarning) {
      return {
        kind: "soft",
        message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; consider trying a different approach.`,
      };
    }
    return { kind: "ok" };
  }

  reset(): void {
    resetLoopDetectionState(this.state);
  }
}
