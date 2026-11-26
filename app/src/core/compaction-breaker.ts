/**
 * compaction-breaker.ts — repeated-compaction failure breaker
 * (Claude Code 3-failure compaction breaker ADAPT).
 *
 * Pure state machine: after `threshold` consecutive failed compactions, further
 * attempts are refused with a typed reason (prevents compaction thrash that
 * burns context/tokens). A success or reset clears the streak. No IO, no
 * authority — the loop decides how to surface the refusal.
 */

export interface CompactionBreakerOptions {
  threshold?: number;
  reasonLimit?: number;
}

export interface AllowResult {
  allowed: boolean;
  reason?: string;
}

export class CompactionBreaker {
  private failures = 0;
  private reasonsList: string[] = [];
  private tripped = false;
  private readonly threshold: number;
  private readonly reasonLimit: number;

  constructor(opts: CompactionBreakerOptions = {}) {
    this.threshold = Math.max(1, Math.floor(opts.threshold ?? 3));
    this.reasonLimit = Math.max(1, Math.floor(opts.reasonLimit ?? 8));
  }

  allowAttempt(): AllowResult {
    if (this.tripped) {
      return { allowed: false, reason: `compaction breaker tripped after ${this.failures} consecutive failures` };
    }
    return { allowed: true };
  }

  recordFailure(reason: string): void {
    this.failures += 1;
    this.reasonsList.push(reason);
    if (this.reasonsList.length > this.reasonLimit) {
      this.reasonsList = this.reasonsList.slice(-this.reasonLimit);
    }
    if (this.failures >= this.threshold) this.tripped = true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.tripped = false;
  }

  reset(): void {
    this.failures = 0;
    this.tripped = false;
    this.reasonsList = [];
  }

  reasons(): readonly string[] {
    return this.reasonsList.slice();
  }

  failureCount(): number {
    return this.failures;
  }
}
