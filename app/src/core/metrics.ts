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

/* ------------------------- publication assertion ------------------------- */

/**
 * H-7 test/assertion half: reject an UNPUBLISHED NUMERIC CLAIM.
 *
 * `metricContract` refuses an incomplete contract at the point of publication;
 * this helper is the matching check at the point of CONSUMPTION. Given the text
 * a module published, it parses the contracted block back into its slots and
 * refuses anything that is not a complete contract — a bare number (`"42"`),
 * a hand-written `"p95 = 14ms"` line, or a block with a slot missing/blank.
 * The refusal names the reason and always says "unpublished numeric claim", so
 * a test asserting on a published number can prove the four slots are there.
 *
 * This is deliberately scoped (docs/16 §2.4.3 / H-7): it routes the numbers in
 * THIS slice's owned files; a repo-wide sweep of every output path is a later
 * wave and is not claimed here.
 */
function unpublished(reason: string): Error {
  return new Error(
    `unpublished numeric claim (docs/16 §2.4.3): ${reason} — a number without the four slots (Metric/Anchor/Population/Excludes) is not a result`,
  );
}

const SLOT_KEYS = ["metric", "anchor", "population", "excludes", "value", "run_id"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];
const SLOT_LINE = /^(metric|anchor|population|excludes|value|run_id):[ ]?([\s\S]*)$/;

/**
 * Parse a contracted block back into a `PublishedNumber`. Throws on anything
 * that is not a complete contract. Continuation lines (a slot whose text spans
 * several lines) are appended to the slot they follow, so a multi-line `value`
 * still round-trips through `metricContract`.
 */
export function parsePublishedNumber(block: unknown): PublishedNumber {
  if (typeof block !== "string") throw unpublished("expected a contracted block (a string)");
  const slots: Partial<Record<SlotKey, string>> = {};
  let last: SlotKey | undefined;
  for (const line of block.split("\n")) {
    const match = SLOT_LINE.exec(line);
    if (match === null) {
      if (last !== undefined) slots[last] = `${slots[last] ?? ""}\n${line}`;
      else throw unpublished(`line ${JSON.stringify(line)} is not a metric-contract slot`);
      continue;
    }
    last = match[1] as SlotKey;
    slots[last] = match[2] ?? "";
  }
  if (slots.value !== undefined && slots.value.trim() === "") throw unpublished("value is blank");
  try {
    metricContract({
      metric: slots.metric ?? "",
      anchor: slots.anchor ?? "",
      population: slots.population ?? "",
      excludes: slots.excludes ?? "",
      value: slots.value ?? "",
      ...(slots.run_id !== undefined ? { runId: slots.run_id } : {}),
    });
  } catch (err) {
    throw unpublished(err instanceof Error ? err.message : String(err));
  }
  return {
    metric: slots.metric!,
    anchor: slots.anchor!,
    population: slots.population!,
    excludes: slots.excludes!,
    value: slots.value!,
    ...(slots.run_id !== undefined ? { runId: slots.run_id } : {}),
  };
}

/**
 * Assert that `block` is a complete contracted publication. When
 * `expectedMetric` is given, also require the Metric slot to match it (so a
 * test can prove a specific number was published, not merely that *some*
 * contracted text was).
 */
export function assertPublishedNumber(block: unknown, expectedMetric?: string): void {
  const parsed = parsePublishedNumber(block);
  if (expectedMetric !== undefined && parsed.metric !== expectedMetric) {
    throw unpublished(`expected metric ${JSON.stringify(expectedMetric)}, got ${JSON.stringify(parsed.metric)}`);
  }
}
