/**
 * compaction-generation.ts -- generation identity + exact-key waiters
 * (plan Task 9). Pure in-memory seam; no contract change, no event type.
 */

export interface CompactionGeneration {
  sessionId: string;
  generation: number;
  viewDigest: string;
}

export function nextGeneration(
  prev: CompactionGeneration | undefined,
  sessionId: string,
  viewDigest: string,
): CompactionGeneration {
  if (sessionId.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: generation requires a sessionId");
  if (viewDigest.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: generation requires a viewDigest");
  if (prev !== undefined && prev.sessionId !== sessionId) {
    throw new Error("HZ_PRECONDITION_FAILED: compaction generation belongs to a different session");
  }
  return { sessionId, generation: (prev?.generation ?? 0) + 1, viewDigest };
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class GenerationWaitAborted extends Error {
  constructor(generation: number) {
    super(`generation waiter aborted for ${generation}`);
    this.name = "GenerationWaitAborted";
  }
}

export class GenerationWaiters {
  private readonly waiters = new Map<number, Waiter>();

  wait(generation: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new GenerationWaitAborted(generation));
    return new Promise<void>((resolve, reject) => {
      const existing = this.waiters.get(generation);
      if (existing !== undefined) {
        existing.reject(new Error(`generation ${generation} waiter replaced`));
      }
      let onAbort: (() => void) | undefined;
      const entry: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
          if (this.waiters.get(generation) === entry) this.waiters.delete(generation);
        },
      };
      this.waiters.set(generation, entry);
      if (signal !== undefined) {
        onAbort = () => {
          entry.cleanup();
          reject(new GenerationWaitAborted(generation));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Settle only the exact generation; a stale generation never resolves a waiter. */
  resolve(generation: number): void {
    const waiter = this.waiters.get(generation);
    if (waiter === undefined) return;
    this.waiters.delete(generation);
    waiter.cleanup();
    waiter.resolve();
  }

  rejectAll(error: Error): void {
    const all = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of all) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  pending(): number[] {
    return [...this.waiters.keys()];
  }
}
