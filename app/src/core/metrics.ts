/** metrics.ts — the metric contract (docs/16 §2.4.3, H-7).
 *
 * A published number carries four slots — Metric (what is measured), Anchor
 * (the baseline it is compared against), Population (on what runs), Excludes
 * (what was discarded and why). A number without the four slots is not a
 * result. This module is the runtime shape of that rule: every number the
 * product reports through it is formatted with its contract, and an
 * incomplete contract is refused, never rendered.
 *
 * Reduced form, stated: this makes the contract *representable and
 * enforceable at the point of publication*; it does not yet route every
 * existing output path through it (that arrives with the eval/bench harness
 * of docs/27 V2). Numbers published outside this helper are, by definition,
 * not results.
 */

export interface PublishedNumber {
  /** What is measured (e.g. "p95 tool dispatch latency"). */
  metric: string;
  /** The baseline the number is compared against (or "none — first measurement"). */
  anchor: string;
  /** What runs the number was taken over (runner class, fixture set, N). */
  population: string;
  /** What was discarded and why. */
  excludes: string;
  /** The value itself, with its unit. */
  value: string | number;
  /** The run id when one exists (docs/16 §2.7/R-ops-52 discipline). */
  runId?: string;
}

const SLOTS = ["metric", "anchor", "population", "excludes"] as const;

/**
 * Validate and format a published number under the metric contract.
 * Throws (with the missing slots named) when any of the four slots is
 * missing or blank — there is no partially-contracted form.
 */
export function metricContract(input: PublishedNumber): string {
  const missing: string[] = [];
  for (const slot of SLOTS) {
    const value = input?.[slot];
    if (typeof value !== "string" || value.trim() === "") missing.push(slot);
  }
  if (input === undefined || input === null || input.value === undefined || input.value === null || input.value === "") {
    missing.push("value");
  }
  if (missing.length > 0) {
    throw new Error(
      `metric contract violation (docs/16 §2.4.3): missing ${missing.join(", ")} — a number without the four slots (Metric/Anchor/Population/Excludes) is not a result`,
    );
  }
  const lines = [
    `metric: ${input.metric}`,
    `anchor: ${input.anchor}`,
    `population: ${input.population}`,
    `excludes: ${input.excludes}`,
    `value: ${input.value}`,
  ];
  if (input.runId !== undefined && input.runId !== "") lines.push(`run_id: ${input.runId}`);
  return lines.join("\n");
}

/** True when the number may be shown to a human as a result. */
export function isPublishable(input: unknown): boolean {
  try {
    metricContract(input as PublishedNumber);
    return true;
  } catch {
    return false;
  }
}
