/**
 * frame-emit-gate.ts — TUI surface: zero-byte frame suppression + dedup
 * (grok terminal writer ADAPT).
 *
 * Pure gate over rendered frames: an empty frame is never written (a zero-byte
 * write can advance the terminal cursor or trigger a repaint), and an unchanged
 * frame is suppressed unless `force` is set (cursor-blink / animation ticks).
 * No ANSI, no TTY access, no authority — the caller owns the actual write.
 */

export interface FrameEmitOptions {
  /** Re-send even when the frame is unchanged (e.g. a cursor-blink tick). */
  force?: boolean;
}

export interface FrameEmitGate {
  /** Returns true when the frame SHOULD be written. */
  emit(frame: string, opts?: FrameEmitOptions): boolean;
  readonly lastEmitted: string | undefined;
  readonly emittedCount: number;
  reset(): void;
}

export function createFrameEmitGate(): FrameEmitGate {
  let last: string | undefined;
  let count = 0;
  return {
    emit(frame: string, opts: FrameEmitOptions = {}): boolean {
      if (frame.length === 0) return false; // zero-byte suppression
      if (!opts.force && frame === last) return false; // unchanged dedup
      last = frame;
      count += 1;
      return true;
    },
    get lastEmitted(): string | undefined {
      return last;
    },
    get emittedCount(): number {
      return count;
    },
    reset(): void {
      last = undefined;
      // count is a lifetime diagnostic; reset clears only the dedup memory.
    },
  };
}
