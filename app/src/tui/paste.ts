/**
 * paste.ts : bracketed paste for the chat bar.
 *
 * With bracketed paste on (`ESC[?2004h`) a terminal wraps pasted text in
 * `ESC[200~ ... ESC[201~`. Node's readline reports those as `paste-start` and
 * `paste-end` keypresses and still delivers every pasted line as its own "line"
 * event, so a multi-line paste would otherwise submit one turn per line. The
 * collector gathers the lines between the markers and hands back ONE input.
 *
 * Pure state machine, no I/O: the interactive loop feeds it keypress names and
 * lines and decides how to echo the result.
 */

export const PASTE_ON = "\u001b[?2004h";
export const PASTE_OFF = "\u001b[?2004l";
/** After paste-end, finalize a single-line paste without waiting for Enter (docs/13 D18). */
export const PASTE_SINGLE_LINE_FLUSH_MS = 50;

export interface PasteResult {
  /** The whole paste, lines joined with "\n". */
  text: string;
  /** Number of lines in the paste. */
  lines: number;
  /** The lines exactly as echoed by the terminal (for erasing them). */
  raw: string[];
}

export interface PasteCollector {
  /** Feed a readline keypress name; returns true when it was a paste marker. */
  key(name: string | undefined): boolean;
  /** True while lines should be diverted into the collector. */
  active(): boolean;
  /** True strictly between paste-start and paste-end: the keys seen now are pasted, not typed. */
  pasting(): boolean;
  /**
   * Feed one readline "line". Returns undefined while the paste is still being
   * gathered, and the finished paste once the line after `paste-end` arrives.
   */
  line(raw: string): PasteResult | undefined;
  /** Finalize when `paste-end` arrived with buffered lines (single-line paste). */
  flushAfterEnd(): PasteResult | undefined;
}

function finalizePaste(lines: string[]): PasteResult {
  const raw = lines.slice();
  const done = lines.slice();
  while (done.length > 1 && done[done.length - 1] === "") done.pop();
  return { text: done.join("\n"), lines: done.length, raw };
}

export function createPasteCollector(): PasteCollector {
  let inside = false;
  let ended = false;
  let lines: string[] = [];
  return {
    key(name) {
      if (name === "paste-start") {
        inside = true;
        ended = false;
        lines = [];
        return true;
      }
      if (name === "paste-end") {
        if (inside) ended = true;
        return true;
      }
      return false;
    },
    active: () => inside,
    pasting: () => inside && !ended,
    line(text) {
      if (!inside) return undefined;
      lines.push(typeof text === "string" ? text : "");
      if (!ended) return undefined;
      const out = finalizePaste(lines);
      inside = false;
      ended = false;
      lines = [];
      return out;
    },
    flushAfterEnd() {
      if (!inside || !ended || lines.length === 0) return undefined;
      const out = finalizePaste(lines);
      inside = false;
      ended = false;
      lines = [];
      return out;
    },
  };
}

/** The collapsed stand-in shown for a multi-line paste. */
export function pasteLabel(lines: number): string {
  return `[pasted ${lines} line${lines === 1 ? "" : "s"}]`;
}

/**
 * Terminal rows the echoed paste occupied, so it can be erased and replaced by
 * the collapsed label. `promptWidth` is the visible width of the first row's prompt.
 */
export function echoedRows(rawLines: readonly string[], promptWidth: number, columns: number): number {
  const cols = Math.max(1, columns);
  let rows = 0;
  rawLines.forEach((l, i) => {
    const width = (i === 0 ? promptWidth : 0) + l.length;
    rows += Math.max(1, Math.ceil(width / cols));
  });
  return rows;
}

/** Collector for `emitKeypressEvents` editors (fullscreen alt-screen). */
export interface KeypressPasteCollector {
  key(name: string | undefined): boolean;
  active(): boolean;
  pasting(): boolean;
  chunk(str: string | undefined): void;
  flushAfterEnd(): PasteResult | undefined;
  finish(): PasteResult | undefined;
}

function finalizeKeypressBuffer(buf: string): PasteResult {
  const normalized = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const raw = normalized === "" ? [] : normalized.split("\n");
  return finalizePaste(raw);
}

export function createKeypressPasteCollector(): KeypressPasteCollector {
  let inside = false;
  let ended = false;
  let buf = "";
  return {
    key(name) {
      if (name === "paste-start") {
        inside = true;
        ended = false;
        buf = "";
        return true;
      }
      if (name === "paste-end") {
        if (inside) ended = true;
        return true;
      }
      return false;
    },
    active: () => inside,
    pasting: () => inside && !ended,
    chunk(str) {
      if (!inside || ended) return;
      if (typeof str === "string" && str !== "") buf += str;
    },
    flushAfterEnd() {
      if (!inside || !ended || buf === "") return undefined;
      const out = finalizeKeypressBuffer(buf);
      inside = false;
      ended = false;
      buf = "";
      return out;
    },
    finish() {
      if (!inside) return undefined;
      const out = finalizeKeypressBuffer(buf);
      inside = false;
      ended = false;
      buf = "";
      return out;
    },
  };
}

/** Collapsed label in the editor when the submit body is the full paste. */
export function editorPasteDisplay(pasted: PasteResult): { display: string; submitText: string } {
  if (pasted.lines > 1) {
    return { display: pasteLabel(pasted.lines), submitText: pasted.text };
  }
  return { display: pasted.text, submitText: pasted.text };
}
