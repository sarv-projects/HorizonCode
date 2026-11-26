/**
 * turn-queue.ts — Explicit Steer (Enter) vs FIFO Queue (Tab) with boolean commit
 * guard, plus Esc+Esc double-tap detection for empty-composer rewind/reconcile.
 */

export type BusySubmitMode = "steer" | "queue";

export interface TurnQueueController {
  /** True while a submit/commit transition is in progress (prevents double-commit). */
  readonly committing: boolean;
  /** Current number of FIFO-queued prompts waiting for the active turn to end. */
  readonly length: number;
  /** Run `fn` under the boolean commit guard; returns false if already committing. */
  withCommitGuard(fn: () => Promise<void> | void): Promise<boolean>;
  /** Enqueue a prompt into the FIFO queue and return the new queue length. */
  enqueue(text: string): number;
  /** Pop the oldest queued prompt (FIFO) or undefined when empty. */
  dequeue(): string | undefined;
  /** Snapshot of queued items (read-only). */
  items(): readonly string[];
  /** Clear all queued items. */
  clear(): void;
}

export function createTurnQueueController(): TurnQueueController {
  const queue: string[] = [];
  let committing = false;

  return {
    get committing() {
      return committing;
    },
    get length() {
      return queue.length;
    },
    async withCommitGuard(fn) {
      if (committing) return false;
      committing = true;
      try {
        await fn();
      } finally {
        committing = false;
      }
      return true;
    },
    enqueue(text: string): number {
      const trimmed = text.trim();
      if (trimmed === "") return queue.length;
      queue.push(trimmed);
      return queue.length;
    },
    dequeue(): string | undefined {
      return queue.shift();
    },
    items(): readonly string[] {
      return [...queue];
    },
    clear(): void {
      queue.length = 0;
    },
  };
}

/**
 * Detect a double-tap Escape (`Esc+Esc`) within `windowMs` (default 500ms).
 * Call `reset()` on any non-Escape key so stale presses never trigger later.
 */
export function createDoubleEscDetector(windowMs = 500): {
  onEscape(nowMs?: number): boolean;
  reset(): void;
} {
  let lastEscAt = 0;
  return {
    onEscape(nowMs = Date.now()): boolean {
      if (lastEscAt > 0 && nowMs - lastEscAt <= windowMs) {
        lastEscAt = 0;
        return true;
      }
      lastEscAt = nowMs;
      return false;
    },
    reset(): void {
      lastEscAt = 0;
    },
  };
}
