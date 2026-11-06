/**
 * render.ts — turns runtime events into terminal output.
 *
 * The transcript flows in normal scrollback: assistant text is written straight
 * through as it arrives, tool activity becomes one compact card, and anything the
 * runtime wants to say becomes a single dim line. Nothing here repaints the
 * screen, so the output stays scrollable, copyable and pipe-safe.
 */

import type { RuntimeEvent } from "../contracts";
import { bold, cyan, dim, green, red, sanitizeText, strip, terminalWidth, truncate, visibleWidth, wrapText } from "./style";

export interface RenderOptions {
  /** Wrap long lines to the terminal width (interactive mode). */
  wrap?: boolean;
  out?: (chunk: string) => void;
  /**
   * Called just before every write. Returning true means the hook itself emitted
   * a newline (used by the chat loop while the human is typing mid-stream).
   */
  beforeWrite?: () => boolean;
}

export interface Renderer {
  handle(ev: RuntimeEvent): void;
  write(chunk: string): void;
  ensureLineStart(): void;
  line(text: string): void;
  notice(message: string): void;
  error(message: string): void;
  atLineStart(): boolean;
}

/** Compact one-line rendering of tool arguments (never longer than 120 chars). */
export function compactArgs(args: unknown): string {
  if (args === null || args === undefined || typeof args !== "object") return "";
  const empty = Array.isArray(args) ? args.length === 0 : Object.keys(args as Record<string, unknown>).length === 0;
  if (empty) return "";
  let json = "";
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    return "[unserialisable]";
  }
  return truncate(json.replace(/\s+/g, " "), 120);
}

function firstLine(text: unknown, limit = 1000): string {
  const s = sanitizeText(text).trim();
  const line = s.split("\n")[0] ?? "";
  return line.length > limit ? truncate(line, limit) : line;
}

export function createRenderer(opts: RenderOptions = {}): Renderer {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const wrap = opts.wrap ?? Boolean((process.stdout as { isTTY?: boolean } | undefined)?.isTTY);
  let atStart = true;
  let sawDelta = false;

  const write = (chunk: string): void => {
    if (!chunk) return;
    if (opts.beforeWrite && opts.beforeWrite()) atStart = true;
    out(chunk);
    atStart = chunk.endsWith("\n");
  };

  const ensureLineStart = (): void => {
    if (!atStart) write("\n");
  };

  /** Print one logical line, wrapping it when it does not fit the terminal. */
  const emit = (styled: string, restyle: (plain: string) => string = (p) => p): void => {
    ensureLineStart();
    const width = terminalWidth();
    if (!wrap || visibleWidth(styled) <= width) {
      write(styled + "\n");
      return;
    }
    for (const part of wrapText(strip(styled), width)) write(restyle(part) + "\n");
  };

  /** Tool arguments: one line when they fit, one argument per line when they do not. */
  const emitArgs = (name: string, args: unknown): void => {
    ensureLineStart();
    const width = terminalWidth();
    const compact = compactArgs(args);
    const head = cyan("\u23fa") + " " + bold(name);
    const oneLine = head + (compact ? dim("(" + compact + ")") : "");
    if (!wrap || visibleWidth(oneLine) <= width) {
      write(oneLine + "\n");
      return;
    }
    write(head + dim("(") + "\n");
    let pretty = "";
    try {
      pretty = JSON.stringify(args, null, 2) ?? "";
    } catch {
      pretty = compact;
    }
    const prettyLines = strip(pretty).split("\n");
    if (prettyLines.length > 1) {
      const first = prettyLines[0].trim();
      const last = prettyLines[prettyLines.length - 1].trim();
      const opens = first === "{" || first === "[";
      const closes = last === "}" || last === "]";
      // The card's own parentheses already frame the arguments: drop the braces.
      if (opens) prettyLines.shift();
      if (closes) prettyLines.pop();
    }
    for (const raw of prettyLines) {
      const text = raw.startsWith("  ") ? raw.slice(2) : raw;
      for (const part of wrapText(text, width, "    ")) write(dim(part) + "\n");
    }
    write(dim("  )") + "\n");
  };

  const handle = (ev: RuntimeEvent): void => {
    if (!ev || typeof ev !== "object") return;
    switch (ev.type) {
      case "assistant.delta": {
        sawDelta = true;
        write(sanitizeText(ev.text));
        break;
      }
      case "assistant.done": {
        // Some runtimes only emit the finished text: never swallow it.
        if (!sawDelta && typeof ev.text === "string" && ev.text.trim() !== "") write(sanitizeText(ev.text));
        sawDelta = false;
        ensureLineStart();
        break;
      }
      case "tool.card": {
        const name = sanitizeText(ev.name) || "tool";
        if (ev.status === "running") {
          emitArgs(name, ev.args);
        } else {
          const ok = ev.status === "ok";
          const summary = firstLine(ev.summary);
          emit("  " + dim("\u2514 ") + (ok ? green("ok") : red("error")) + (summary ? dim(": " + summary) : ""), dim);
        }
        break;
      }
      case "notice":
        emit(dim("\u00b7 " + sanitizeText(ev.message)), dim);
        break;
      case "error":
        emit(red("\u26a0 " + sanitizeText(ev.message)), red);
        break;
      case "turn.done":
        ensureLineStart();
        break;
      default:
        break;
    }
  };

  return {
    handle,
    write,
    ensureLineStart,
    line: (text: string) => emit(text),
    notice: (message: string) => emit(dim("\u00b7 " + sanitizeText(message)), dim),
    error: (message: string) => emit(red("\u26a0 " + sanitizeText(message)), red),
    atLineStart: () => atStart,
  };
}
