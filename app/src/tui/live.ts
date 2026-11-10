/**
 * live.ts — the animated bottom of the chat: a status bar, a working spinner,
 * the shaded user block and the turn footer.
 *
 * Everything here is TTY-only and colour-only: when stdout is a pipe, NO_COLOR
 * is set or TERM=dumb, `liveEnabled()` is false and the transcript is byte for
 * byte what it always was. The pure pieces (formatting, composition, verb and
 * frame selection) are exported so they can be tested without a terminal.
 *
 * The live region is never part of the scrollback: it is erased before any
 * transcript line is written and redrawn afterwards, one string per frame.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { bold, colorEnabled, cyan, dim, strip, terminalWidth, truncate, visibleWidth, wrapText, yellow } from "./style";

/* ------------------------------ capability ------------------------------ */

/** True when animation and the shaded blocks may be drawn. */
export function liveEnabled(stream: { isTTY?: boolean } | undefined = process.stdout): boolean {
  try {
    if (!stream || !stream.isTTY) return false;
    const env = process.env;
    if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
    if (env.TERM === "dumb" || env.TERM === "unknown") return false;
    return colorEnabled();
  } catch {
    return false;
  }
}

/** True when the locale advertises UTF-8 (braille spinner is safe). */
export function unicodeLocale(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(value);
}

/* ------------------------------ formatting ------------------------------ */

/** `4s`, `1m51s`, `1h02m`: the spinner's elapsed time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (total < 3600) return `${m}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h${String(m % 60).padStart(2, "0")}m`;
}

/** `850ms`, `12.4s`, `1m51s`: the turn footer's duration. */
export function formatDuration(ms: number): string {
  const v = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return formatElapsed(v);
}

/** `950`, `1.2k`, `31k`, `1.5M`. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  if (v < 1000) return String(v);
  if (v < 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** Local `HH:MM`. */
export function clockTime(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ------------------------------- spinner ------------------------------- */

export const SPINNER_UNICODE = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
export const SPINNER_ASCII = ["|", "/", "-", "\\"];
/** Frame period: one timer, ~11 fps. */
export const FRAME_MS = 90;

export function spinnerFrame(tick: number, unicode = true): string {
  const frames = unicode ? SPINNER_UNICODE : SPINNER_ASCII;
  const i = Math.floor(Number.isFinite(tick) ? tick : 0);
  return frames[((i % frames.length) + frames.length) % frames.length];
}

const ARG_KEYS = ["path", "file_path", "file", "pattern", "query", "command", "cmd", "url"];

function argSummary(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/** What the spinner says while a tool runs ("Reading math.js"); "Thinking" when none. */
export function toolVerb(name: string | undefined, args?: unknown): string {
  if (!name) return "Thinking";
  const arg = argSummary(args).replace(/\s+/g, " ");
  const file = arg ? path.basename(arg) || arg : "";
  const withFile = (verb: string): string => (file ? `${verb} ${truncate(file, 40)}` : verb);
  switch (name) {
    case "read":
      return withFile("Reading");
    case "write":
    case "edit":
    case "ast_edit":
    case "apply_patch":
      return withFile("Editing");
    case "grep":
    case "ast_search":
      return arg ? `Searching ${truncate(arg, 40)}` : "Searching";
    case "glob":
      return arg ? `Globbing ${truncate(arg, 40)}` : "Globbing";
    case "shell":
    case "shell_session":
      return "Running shell";
    case "agent":
      return "Running subagent";
    case "repo_map":
      return "Mapping repo";
    case "lsp":
      return "Asking language server";
    case "todo":
      return "Updating todos";
    default:
      return `Running ${name}`;
  }
}

export interface SpinnerLineInput {
  tick: number;
  verb?: string;
  elapsedMs: number;
  /** true when Esc cancels, false when only Ctrl+C does */
  esc: boolean;
  unicode?: boolean;
}

/** `⠋ Thinking… 4s · esc to cancel` (styled when colour is on). */
export function spinnerLine(input: SpinnerLineInput): string {
  const verb = input.verb && input.verb !== "" ? input.verb : "Thinking";
  const hint = input.esc ? "esc to cancel" : "ctrl+c to cancel";
  return (
    cyan(spinnerFrame(input.tick, input.unicode ?? true)) +
    " " +
    verb +
    "\u2026 " +
    dim(`${formatElapsed(input.elapsedMs)} \u00b7 ${hint}`)
  );
}

/* ------------------------------ status bar ------------------------------ */

export interface StatusInfo {
  /** mode badge ("PLAN", "ACCEPT-EDITS", "READ-ONLY") or "" for default */
  badge: string;
  model: string;
  provider: string;
  /** 0-100, or undefined before the first context.usage event */
  contextPercent?: number;
  /** already shortened (~) workspace path */
  path: string;
  branch?: string;
}

const SEP = " \u00b7 ";

/**
 * `PLAN · model · provider · ◑ 12% · ~/proj · ⑂ main`, cut to `width`: the path
 * goes first, then the provider, then the branch; what is left is truncated.
 */
export function composeStatusBar(info: StatusInfo, width: number): string {
  const limit = Math.max(10, Math.floor(width));
  const mode = info.badge !== "" ? bold(yellow(info.badge)) : dim("default");
  const parts: Record<string, string> = {
    mode,
    model: info.model,
    provider: dim(info.provider),
    ctx: info.contextPercent === undefined ? "" : dim("\u25d1 ") + `${Math.max(0, Math.min(999, Math.round(info.contextPercent)))}%`,
    path: dim(info.path),
    branch: info.branch ? dim("\u2442 ") + info.branch : "",
  };
  const dropOrder = ["path", "provider", "branch", "ctx"];
  const order = ["mode", "model", "provider", "ctx", "path", "branch"];
  const dropped = new Set<string>();
  const build = (): string =>
    order
      .filter((k) => parts[k] !== "" && !dropped.has(k))
      .map((k) => parts[k])
      .join(dim(SEP));
  let line = build();
  for (const key of dropOrder) {
    if (visibleWidth(line) <= limit) break;
    dropped.add(key);
    line = build();
  }
  if (visibleWidth(line) > limit) {
    // Last resort: plain text cut to width (never leaves an unterminated escape).
    line = dim(truncate(strip(line), limit));
  }
  return line;
}

/** Branch name from `.git/HEAD` (no subprocess); undefined outside a repo. */
export function readGitBranch(dir: string): string | undefined {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    try {
      const head = readFileSync(path.join(cur, ".git", "HEAD"), "utf8").trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (m) return m[1];
      return head ? head.slice(0, 7) : undefined;
    } catch {
      /* not here: look at the parent (a worktree's .git is a file, which also lands here) */
    }
    try {
      const gitFile = readFileSync(path.join(cur, ".git"), "utf8").trim();
      const m = /^gitdir:\s*(.+)$/.exec(gitFile);
      if (m) {
        const gitDir = path.resolve(cur, m[1]);
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const r = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (r) return r[1];
        return head ? head.slice(0, 7) : undefined;
      }
    } catch {
      /* no .git file either */
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

/* --------------------------- blocks and footer --------------------------- */

const BLOCK_BG = "\u001b[48;5;236m";
const RESET = "\u001b[0m";

/**
 * The human's message as a shaded full-width block with a right-aligned
 * timestamp. Returns the lines (no trailing newline). Plain `❯ text` lines
 * without colour.
 */
export function userBlock(text: string, width: number, time: string, color = colorEnabled()): string[] {
  const w = Math.max(20, Math.floor(width));
  const body = wrapText(text, w - 4);
  if (!color) return body.map((l, i) => (i === 0 ? "\u276f " : "  ") + l);
  const fill = (inner: string): string => BLOCK_BG + inner + " ".repeat(Math.max(0, w - visibleWidth(inner))) + RESET;
  const lines = [fill("")];
  body.forEach((l, i) => {
    const lead = i === 0 ? " \u276f " : "   ";
    const stamp = i === 0 ? time : "";
    const gap = Math.max(1, w - visibleWidth(lead + l) - visibleWidth(stamp) - 1);
    const inner =
      lead + l + (stamp ? " ".repeat(gap) + "\u001b[2m" + stamp + "\u001b[22m" + " " : "");
    lines.push(fill(inner));
  });
  lines.push(fill(""));
  return lines;
}

/** `· 12.4s · 3 tools · ↑1.2k tok` with a right-aligned dim timestamp. */
export function turnFooter(input: { ms: number; tools: number; inputTokens?: number; time?: string; width?: number }): string {
  const bits = [formatDuration(input.ms)];
  if (input.tools > 0) bits.push(`${input.tools} tool${input.tools === 1 ? "" : "s"}`);
  if (input.inputTokens !== undefined && input.inputTokens > 0) bits.push(`\u2191${formatTokens(input.inputTokens)} tok`);
  const left = "\u00b7 " + bits.join(" \u00b7 ");
  if (!input.time) return dim(left);
  const width = input.width ?? terminalWidth();
  const gap = width - visibleWidth(left) - visibleWidth(input.time) - 1;
  return dim(left + (gap >= 2 ? " ".repeat(gap) : "  ") + input.time);
}

/* --------------------------------- tips --------------------------------- */

/** Only things that exist; shown one at a time under the banner. */
export const TIPS: readonly string[] = [
  "/plan stages edits for review before anything is written",
  "/mode accept-edits auto-approves workspace edits",
  "/memory shows the loaded AGENTS.md / CLAUDE.md files",
  "/fork branches this conversation into a new session",
  "/rewind lists checkpoints and restores files changed since one",
  "/init drafts an AGENTS.md for this repo (staged for review)",
  "/context shows what the next request will carry",
  "agent profile explore maps a repo with read-only tools",
  "Esc or Ctrl+C cancels the running turn",
];

export function pickTip(seed: number = Date.now()): string {
  const i = Math.abs(Math.floor(seed)) % TIPS.length;
  return TIPS[i];
}

/* ------------------------------ live region ------------------------------ */

export interface LiveOptions {
  enabled: boolean;
  write: (s: string) => void;
  status: () => StatusInfo;
  /** the transcript cursor sits at the start of a line */
  atLineStart: () => boolean;
  /** the human has typed something into the bar */
  typed: () => boolean;
  /** zero-based column of the readline cursor */
  cursorCol: () => number;
  /** Esc cancels (raw keypress handling is wired) */
  esc: boolean;
  /** pause drawing (an approval question owns the line) */
  paused?: () => boolean;
  now?: () => number;
}

export interface Live {
  readonly enabled: boolean;
  /** erase whatever is drawn; call before every transcript write */
  erase(): void;
  /** draw the idle status bar under the prompt */
  showIdle(): void;
  /** the human submitted a line: drop the idle bar (cursor is on its row) */
  submitted(): void;
  beginTurn(): void;
  toolStart(name: string, args: unknown): void;
  toolEnd(): void;
  noteUsage(inputTokens: number): void;
  /** stats for the footer; stops the spinner */
  endTurn(): { ms: number; tools: number; inputTokens?: number };
  dispose(): void;
}

export function createLive(opts: LiveOptions): Live {
  const now = opts.now ?? Date.now;
  const unicode = unicodeLocale();
  let drawn: "none" | "idle" | "busy" = "none";
  let idleCol = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tick = 0;
  let startedAt = 0;
  let verb = "Thinking";
  let tools = 0;
  let running = 0;
  let inputTokens: number | undefined;
  let busy = false;

  const barLine = (): string => composeStatusBar(opts.status(), terminalWidth() - 1);

  const erase = (): void => {
    if (!opts.enabled || drawn === "none") return;
    const was = drawn;
    drawn = "none";
    if (was === "busy") opts.write("\r\u001b[J");
    else opts.write(`\u001b[1B\r\u001b[2K\u001b[1A\u001b[${idleCol + 1}G`);
  };

  const drawBusy = (): void => {
    const elapsed = now() - startedAt;
    const spin = spinnerLine({ tick, verb, elapsedMs: elapsed, esc: opts.esc, unicode });
    const w = terminalWidth() - 1;
    const first = visibleWidth(spin) > w ? truncate(strip(spin), w) : spin;
    drawn = "busy";
    opts.write("\r\u001b[2K" + first + "\n\u001b[2K" + barLine() + "\u001b[1A\r");
  };

  const frame = (): void => {
    if (!busy) return;
    tick++;
    if (opts.paused?.() || !opts.atLineStart() || opts.typed()) {
      // Text is streaming (or the human is typing): the spinner steps aside.
      if (drawn === "busy") erase();
      return;
    }
    drawBusy();
  };

  const onResize = (): void => {
    if (busy && drawn === "busy") erase();
  };
  if (opts.enabled) {
    try {
      process.stdout.on("resize", onResize);
    } catch {
      /* no resize events */
    }
  }

  return {
    enabled: opts.enabled,
    erase,
    showIdle() {
      if (!opts.enabled || busy) return;
      idleCol = Math.max(0, opts.cursorCol());
      drawn = "idle";
      opts.write("\n\r\u001b[2K" + barLine() + `\u001b[1A\u001b[${idleCol + 1}G`);
    },
    submitted() {
      if (!opts.enabled || drawn !== "idle") return;
      drawn = "none";
      // readline's newline already moved the cursor onto the bar's row.
      opts.write("\r\u001b[2K");
    },
    beginTurn() {
      tools = 0;
      running = 0;
      inputTokens = undefined;
      verb = "Thinking";
      startedAt = now();
      tick = 0;
      busy = true;
      if (!opts.enabled) return;
      if (timer === undefined) {
        timer = setInterval(frame, FRAME_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      frame();
    },
    toolStart(name, args) {
      tools++;
      running++;
      verb = toolVerb(name, args);
    },
    toolEnd() {
      running = Math.max(0, running - 1);
      if (running === 0) verb = "Thinking";
    },
    noteUsage(n) {
      if (Number.isFinite(n) && n > 0) inputTokens = n;
    },
    endTurn() {
      busy = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      erase();
      return { ms: now() - startedAt, tools, inputTokens };
    },
    dispose() {
      busy = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      erase();
      if (opts.enabled) {
        try {
          process.stdout.off("resize", onResize);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
