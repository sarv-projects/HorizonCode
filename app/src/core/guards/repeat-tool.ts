/**
 * repeat-tool.ts — advisory repeat-tool reminder (NF-safety rail 3).
 *
 * A self-contained port of the deepseek-harness repeat-tool-reminder guard
 * (packages/guard/repeat-tool-reminder/src/index.ts), reduced to a plain class
 * (no cordis/schemastery/dsh imports). It tracks a single consecutive chain of
 * identical tool calls and returns reminder TEXT when the run length hits a
 * configured threshold. The reminder is ADVISORY: it is injected into the
 * transcript as a user message by the loop and never vetoes a call. The loop
 * owns the instance; nothing here imports the loop.
 *
 * Counting happens in POST-execute (the loop calls `observe` after each tool
 * call resolves) so a DENIED or failed call still advances the chain: a model
 * hammering a denied call is exactly the loop worth nudging. A new user prompt
 * clears the chain (the loop calls `clear()` at the start of each turn).
 */

/** Guard construction options; every field has a documented default. */
export interface RepeatToolGuardOptions {
  /** Consecutive-repeat counts that trigger a reminder (default `[3, 5, 8]`). */
  thresholds?: number[];
  /** Tool-name `*`-wildcard patterns to track; empty means track every tool. */
  include?: string[];
  /** Tool-name `*`-wildcard patterns transparent to the chain (never count nor reset). */
  exclude?: string[];
  /** Maximum chars of canonical arguments quoted in the detailed reminder (default 500). */
  argumentsPreviewChars?: number;
}

/** The gentle first-threshold reminder (keyed to `thresholds[0]`, not a literal count). */
export const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. "
  + "Carefully analyze the previous result before calling again: if the task is "
  + "not complete, try a different approach or different arguments instead of "
  + "repeating the call.";

/** The detailed later-threshold reminder naming the tool, the run length and the canonical arguments. */
export function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return "Repeated tool call detected:\n"
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + "The repeated calls are not making progress. Do not call this tool with "
    + "these exact arguments again. Inspect the latest result and choose a "
    + "different action, different arguments, or finish the task if enough "
    + "evidence has been gathered.";
}

/**
 * Deep key-sort a parsed-JSON value so two argument objects that differ only in
 * property order canonicalize identically. Arrays keep their order; keys sort
 * with the JavaScript default (`Array.prototype.sort()`).
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/**
 * Compile one `*`-wildcard pattern to an anchored RegExp. Every other regex
 * metacharacter is escaped and matched literally; `*` becomes `.*`.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/**
 * Head-truncate the canonical arguments for quoting in the detailed reminder,
 * marking how much was omitted. Bounds only the model-visible text — the chain
 * key always uses the full canonical string.
 */
export function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}\u2026 (+${canonical.length - cap} more chars)`;
}

/**
 * Validate `thresholds` fail-loud and return them sorted ascending. Throws on
 * an empty list, any non-integer or value below 2, or a duplicate. The gentle
 * tier reads `thresholds[0]`, so ordering is normalized here, once.
 */
export function validateThresholds(values: number[]): number[] {
  if (values.length === 0) {
    throw new Error("repeat-tool-reminder: `thresholds` must not be empty");
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) {
      throw new Error(
        `repeat-tool-reminder: invalid threshold ${value} - every threshold must be an integer >= 2`,
      );
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error("repeat-tool-reminder: `thresholds` must not contain duplicates");
  }
  return [...values].sort((a, b) => a - b);
}

/** One consecutive-repeat chain: the last tracked call's identity key and its run length. */
interface Chain {
  key: string;
  count: number;
}

/**
 * Per-run advisory repeat-tool detector. The loop constructs one instance per
 * run, clears it at the start of each turn (a new user prompt), and calls
 * `observe` once per tool call in deterministic order after the batch settles.
 */
export class RepeatToolGuard {
  private readonly thresholds: number[];
  private readonly thresholdSet: Set<number>;
  private readonly includePatterns: RegExp[];
  private readonly excludePatterns: RegExp[];
  private readonly argumentsPreviewChars: number;
  private chain: Chain | undefined;

  constructor(options: RepeatToolGuardOptions = {}) {
    this.thresholds = validateThresholds(options.thresholds ?? [3, 5, 8]);
    this.thresholdSet = new Set(this.thresholds);
    this.includePatterns = (options.include ?? []).map(wildcardToRegExp);
    this.excludePatterns = (options.exclude ?? []).map(wildcardToRegExp);
    const previewChars = options.argumentsPreviewChars ?? 500;
    if (!Number.isInteger(previewChars) || previewChars < 1) {
      throw new Error(
        `repeat-tool-reminder: invalid argumentsPreviewChars ${previewChars} - must be an integer >= 1`,
      );
    }
    this.argumentsPreviewChars = previewChars;
  }

  /** Whether a tool participates in the chain (untracked calls are transparent). */
  private tracked(toolName: string): boolean {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(toolName))) {
      return false;
    }
    return !this.excludePatterns.some((pattern) => pattern.test(toolName));
  }

  /**
   * Advance the chain for one call and return the reminder text when this
   * call's run length hits a configured threshold; undefined otherwise. An
   * untracked tool is transparent: it neither counts nor resets the chain.
   */
  observe(name: string, args: unknown): string | undefined {
    if (!this.tracked(name)) return undefined;
    const canonical = canonicalize(args);
    const key = JSON.stringify([name, canonical]);
    const count = this.chain !== undefined && this.chain.key === key ? this.chain.count + 1 : 1;
    this.chain = { key, count };
    if (!this.thresholdSet.has(count)) return undefined;
    return count === this.thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(name, count, previewArguments(canonical, this.argumentsPreviewChars));
  }

  /** Reset the chain (a new user prompt arrived; repetition across it is not a loop). */
  clear(): void {
    this.chain = undefined;
  }
}
