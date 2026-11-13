/**
 * escape-writer.ts — terminal mode queue with idempotent restore (docs/33 §5.17).
 *
 * Pure sequencing helpers are testable without a TTY; `EscapeWriter` queues enter
 * and leave and installs signal hooks that call the same restore path once.
 */

export interface TerminalHooks {
  write: (data: string) => void;
  enterRawMode?: () => void;
  leaveRawMode?: () => void;
}

/** DEC alt-screen enter/leave (common xterm sequence). */
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
export const LEAVE_ALT_SCREEN = "\x1b[?1049l";

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

export const MOUSE_CAPTURE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_CAPTURE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";

export interface TerminalRestoreState {
  altScreen: boolean;
  rawMode: boolean;
  mouseCaptured: boolean;
  bracketedPaste: boolean;
  cursorHidden: boolean;
}

export function emptyTerminalRestoreState(): TerminalRestoreState {
  return {
    altScreen: false,
    rawMode: false,
    mouseCaptured: false,
    bracketedPaste: false,
    cursorHidden: false,
  };
}

/**
 * Emit restore bytes in docs/13 R7 order: mouse, bracketed paste, cursor, alt, raw.
 * Each step is attempted even when a prior step was skipped.
 */
export function encodeTerminalRestore(state: TerminalRestoreState, hooks: TerminalHooks): string {
  const parts: string[] = [];
  if (state.mouseCaptured) parts.push(MOUSE_CAPTURE_OFF);
  if (state.bracketedPaste) parts.push(BRACKETED_PASTE_OFF);
  if (state.cursorHidden) parts.push(SHOW_CURSOR);
  if (state.altScreen) parts.push(LEAVE_ALT_SCREEN);
  const out = parts.join("");
  if (state.rawMode) hooks.leaveRawMode?.();
  return out;
}

export interface EscapeWriterOptions {
  hooks: TerminalHooks;
}

/**
 * Single owner of fullscreen terminal transitions until interactive adopts it.
 * `restore` is idempotent — safe from signals, exceptions, and double-exit.
 */
export class EscapeWriter {
  private restored = false;
  private state = emptyTerminalRestoreState();
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly opts: EscapeWriterOptions) {}

  get restoreState(): Readonly<TerminalRestoreState> {
    return this.state;
  }

  /** Enter alternate screen + raw mode hooks (no mouse/bracketed paste until wired). */
  enterFullscreen(): void {
    if (this.restored) return;
    this.opts.hooks.write(ENTER_ALT_SCREEN);
    this.state.altScreen = true;
    this.opts.hooks.enterRawMode?.();
    this.state.rawMode = true;
  }

  /** Enable xterm SGR mouse reporting (docs/13 R23–R26 reduced slice). */
  enableMouseCapture(): void {
    if (this.restored) return;
    this.opts.hooks.write(MOUSE_CAPTURE_ON);
    this.state.mouseCaptured = true;
  }

  /** Optional: mark subsystems entered when a future renderer enables them. */
  markMouseCaptured(): void {
    this.state.mouseCaptured = true;
  }

  markBracketedPaste(): void {
    this.state.bracketedPaste = true;
  }

  markCursorHidden(): void {
    this.state.cursorHidden = true;
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    const bytes = encodeTerminalRestore(this.state, this.opts.hooks);
    if (bytes !== "") this.opts.hooks.write(bytes);
    this.state = emptyTerminalRestoreState();
    for (const off of this.unsubs.splice(0)) off();
  }

  /** Register process signal / exit hooks that call `restore` once. */
  installLifecycleHandlers(signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]): void {
    const handler = () => this.restore();
    for (const sig of signals) {
      const prior = process.listeners(sig);
      process.on(sig, handler);
      this.unsubs.push(() => {
        process.off(sig, handler);
        for (const fn of prior) process.on(sig, fn as NodeJS.SignalsListener);
      });
    }
    const onExit = () => this.restore();
    process.once("exit", onExit);
    this.unsubs.push(() => process.off("exit", onExit));
  }
}

/** Doctor / status line: fullscreen building blocks present but not the default TUI path. */
export function tuiFullscreenBlocksLabel(): string {
  return "cellbuffer+escape-writer CODE_PRESENT; HZ_TUI_MODE=fullscreen-experimental reduced alt-screen chat";
}
