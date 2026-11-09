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

/**
 * The optional preview a runtime attached to an event or approval request, or
 * "" when there is none. A preview is evidence text (a staged diff), so control
 * characters are stripped before it can reach the terminal.
 */
export function previewOf(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const raw = (value as { preview?: unknown }).preview;
  if (typeof raw !== "string" || raw === "") return "";
  return sanitizeText(raw).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/**
 * Render one staged diff for the chat: two-space indent, dim `---`/`+++`
 * headers, cyan `@@` hunk markers, green additions, red deletions, dim
 * truncation marker. A pure string function (like compactArgs) so the event
 * renderer and the approval prompt share one look; "" in, "" out, and callers
 * print nothing when there is nothing to show. Diff lines are written as they
 * are — an over-wide line soft-wraps in the terminal, because rewrapping would
 * break the one-character change column.
 */
export function diffBlock(diff: string): string {
  const text = typeof diff === "string" ? sanitizeText(diff.replace(/\r\n?/g, "\n")) : "";
  if (text === "") return "";
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map(diffLine).join("\n");
}

function diffLine(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "  " + dim(line);
  if (line.startsWith("@@")) return "  " + cyan(line);
  if (line.startsWith("+")) return "  " + green(line);
  if (line.startsWith("-")) return "  " + red(line);
  if (/^\.\.\. \d+ more lines$/.test(line)) return "  " + dim(line);
  return "  " + line;
}

function firstLine(text: unknown, limit = 1000): string {
  const s = sanitizeText(text).trim();
  const line = s.split("\n")[0] ?? "";
  return line.length > limit ? truncate(line, limit) : line;
}

/** Most nested child lines rendered per agent run; the rest collapse to a marker. */
export const NESTED_LINE_CAP = 30;
/** Most turn.diff lines rendered; the rest collapse to `\u2026 N more lines`. */
export const TURN_DIFF_LINE_CAP = 40;

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

  const nestedCount = new Map<string, number>();

  /** One child event, indented under the agent card behind a dim bar. */
  const handleNested = (agentId: string, inner: RuntimeEvent): void => {
    if (!inner || typeof inner !== "object") return;
    let line = "";
    if (inner.type === "tool.card") {
      const name = sanitizeText(inner.name) || "tool";
      if (inner.status === "running") {
        const compact = compactArgs(inner.args);
        line = cyan("\u23fa") + " " + bold(name) + (compact ? dim("(" + truncate(compact, 80) + ")") : "");
      } else {
        const summary = firstLine(inner.summary, 120);
        line =
          "  " + dim("\u2514 ") + (inner.status === "ok" ? green("ok") : red("error")) + (summary ? dim(": " + summary) : "");
      }
    } else if (inner.type === "assistant.done") {
      const text = firstLine(inner.text, 200);
      if (text === "") return;
      line = dim(text);
    } else if (inner.type === "notice") {
      line = dim("\u00b7 " + firstLine(inner.message, 200));
    } else if (inner.type === "error") {
      line = red("\u26a0 " + firstLine(inner.message, 200));
    } else {
      return;
    }
    const n = (nestedCount.get(agentId) ?? 0) + 1;
    nestedCount.set(agentId, n);
    if (n > NESTED_LINE_CAP + 1) return;
    const text = n === NESTED_LINE_CAP + 1 ? dim("\u2026 more child output hidden") : line;
    ensureLineStart();
    write("  " + dim("\u2502") + " " + text + "\n");
  };

  const handle = (ev: RuntimeEvent): void => {
    if (!ev || typeof ev !== "object") return;
    switch (ev.type) {
      case "subagent.event":
        handleNested(String(ev.agentId), ev.event);
        break;
      case "turn.diff": {
        const files = typeof ev.files === "number" ? ev.files : 0;
        if (files < 1) break;
        emit(dim(`\u00b7 changed ${files} file${files === 1 ? "" : "s"}`), dim);
        const lines = diffBlock(ev.diff).split("\n").filter((l) => l !== "");
        const shown = lines.slice(0, TURN_DIFF_LINE_CAP);
        if (shown.length > 0) {
          ensureLineStart();
          write(shown.join("\n") + "\n");
        }
        const more = lines.length - shown.length;
        if (more > 0) emit("  " + dim(`\u2026 ${more} more lines`), dim);
        else if (ev.truncated === true) emit("  " + dim("\u2026 diff truncated"), dim);
        break;
      }
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
        // The optional preview the runtime attached to this card (a staged
        // diff in plan mode): rendered under either state, absent on old cores.
        const preview = previewOf(ev);
        if (preview !== "") {
          ensureLineStart();
          write(diffBlock(preview) + "\n");
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
