/**
 * fullscreen-line-editor.ts — minimal raw-key line editor (docs/33 §5.17).
 *
 * Printable ASCII, backspace, enter, and Ctrl+C only.
 */

export interface LineEditorState {
  text: string;
}

export type LineEditorAction =
  | { kind: "noop" }
  | { kind: "insert"; ch: string }
  | { kind: "backspace" }
  | { kind: "submit" }
  | { kind: "interrupt" };

export function lineEditorStep(state: LineEditorState, key: number): { state: LineEditorState; action: LineEditorAction } {
  if (key === 3) return { state, action: { kind: "interrupt" } };
  if (key === 13 || key === 10) return { state, action: { kind: "submit" } };
  if (key === 127 || key === 8) {
    if (state.text.length === 0) return { state, action: { kind: "noop" } };
    return { state: { text: state.text.slice(0, -1) }, action: { kind: "backspace" } };
  }
  if (key >= 0x20 && key <= 0x7e) {
    const ch = String.fromCharCode(key);
    return { state: { text: state.text + ch }, action: { kind: "insert", ch } };
  }
  return { state, action: { kind: "noop" } };
}

/** Apply one byte; convenience for tests and the event loop. */
export function applyEditorKey(text: string, key: number): { text: string; action: LineEditorAction } {
  const next = lineEditorStep({ text }, key);
  return { text: next.state.text, action: next.action };
}

export interface DeferredSubmitGuardOptions {
  /**
   * When true, execute immediately without the double `setTimeout(..., 0)` defer
   * (useful for synchronous unit tests or non-TTY pipes). Re-entrancy lock still applies.
   */
  immediate?: boolean;
  /** Optional timer scheduler override for deterministic unit testing. */
  schedule?: (fn: () => void) => ReturnType<typeof setTimeout>;
  /** Optional timer cancellation override paired with `schedule`. */
  clear?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface DeferredSubmitGuard {
  /**
   * Request a submit. By default, waits two macrotask ticks (`setTimeout(0)` -> `setTimeout(0)`)
   * so IME composition commits cleanly before submit reads editor text, while a re-entrancy lock
   * ensures rapid double-Enter never submits twice.
   * Returns `true` if scheduled/started, or `false` if blocked by an active or pending submit.
   */
  request(fn: () => void | Promise<void>): boolean;
  /** Cancel any pending (not yet started) deferred submit timer. */
  cancel(): void;
  /** True while a deferred submit timer is queued OR the submit callback is currently running. */
  isSubmitting(): boolean;
  /** True strictly while waiting on the double-defer macrotask timers. */
  isPending(): boolean;
}

/**
 * Zero-dependency IME double-defer submit guard with re-entrancy lock and `cancel()`.
 * Mirrors OpenCode's `setTimeout(..., 0)` -> `setTimeout(..., 0)` submit guard so CJK/IME
 * composition flushes its final character before submit executes.
 */
export function createDeferredSubmitGuard(opts: DeferredSubmitGuardOptions = {}): DeferredSubmitGuard {
  const immediate = opts.immediate === true;
  const schedule = opts.schedule ?? ((fn: () => void) => setTimeout(fn, 0));
  const clear = opts.clear ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let pending = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runNow = (fn: () => void | Promise<void>): void => {
    if (running) return;
    running = true;
    const release = (): void => {
      running = false;
    };
    try {
      const result = fn();
      if (result !== undefined && result !== null && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(release, release);
      } else {
        release();
      }
    } catch {
      release();
    }
  };

  return {
    request(fn) {
      if (running || pending) return false;
      if (immediate) {
        runNow(fn);
        return true;
      }
      pending = true;
      timer = schedule(() => {
        timer = undefined;
        if (!pending) return;
        timer = schedule(() => {
          timer = undefined;
          if (!pending) return;
          pending = false;
          runNow(fn);
        });
      });
      return true;
    },
    cancel() {
      if (timer !== undefined) {
        clear(timer);
        timer = undefined;
      }
      pending = false;
    },
    isSubmitting: () => running || pending,
    isPending: () => pending,
  };
}
