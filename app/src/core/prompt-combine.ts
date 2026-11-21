/**
 * prompt-combine.ts — Multi-Prompt Queue Combiner
 *
 * Stolen & adapted from:
 *   - repo_take/grok-build/crates/codegen/xai-prompt-queue/src/combine.rs
 *
 * When a user types follow-up prompts into the chat bar while the assistant
 * is streaming or busy executing tools, instead of running separate turns
 * (which burns round-trips, triggers multiple system prompt re-evaluations,
 * and thrashes context), this module combines compatible sequential prompts
 * into a single unified prompt joined with double-newlines.
 */

export const TEXT_SEPARATOR = "\n\n";

export interface CombineGate {
  text: string;
  isPlainPrompt: boolean;
  isSlashCommand: boolean;
}

/** Check if text is eligible to lead a combined prompt batch. */
export function canMergeFront(gate: CombineGate): boolean {
  return gate.isPlainPrompt && !gate.isSlashCommand && gate.text.trim().length > 0;
}

/** Check if subsequent queued prompt can merge into the leading prompt. */
export function canMergeFollower(gate: CombineGate): boolean {
  return canMergeFront(gate);
}

/**
 * Calculates how many queued prompt items from the front can be merged.
 * Returns the count (e.g. 1 means take front only; 0 if empty).
 */
export function combinePrefixLength(items: readonly CombineGate[]): number {
  if (items.length === 0) return 0;
  const front = items[0]!;
  if (!canMergeFront(front)) return 1;

  let count = 1;
  for (let i = 1; i < items.length; i += 1) {
    if (!canMergeFollower(items[i]!)) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Joins multiple text messages with double-newline separation.
 */
export function joinTexts(texts: readonly string[]): string {
  return texts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(TEXT_SEPARATOR);
}

/**
 * Inspects a queue of pending messages and combines any eligible leading batch.
 */
export function combineQueuedMessages(queue: readonly string[]): {
  head: string;
  remaining: string[];
  combinedCount: number;
} {
  if (queue.length <= 1) {
    return {
      head: queue[0] ?? "",
      remaining: [],
      combinedCount: queue.length,
    };
  }

  const gates: CombineGate[] = queue.map((text) => ({
    text,
    isPlainPrompt: !text.trim().startsWith("/"),
    isSlashCommand: text.trim().startsWith("/"),
  }));

  const prefixLen = combinePrefixLength(gates);
  if (prefixLen <= 1) {
    return {
      head: queue[0]!,
      remaining: queue.slice(1),
      combinedCount: 1,
    };
  }

  const batch = queue.slice(0, prefixLen);
  const combinedText = joinTexts(batch);

  return {
    head: combinedText,
    remaining: queue.slice(prefixLen),
    combinedCount: prefixLen,
  };
}
