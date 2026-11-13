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
import { blend, bold, colorEnabled, paint, colorLevel, cyan, dim, pulse, rgbFg, strip, terminalWidth, truncate, visibleWidth, wrapText, yellow, type RGB } from "./style";
import { runStatusLineScript, type StatusLineScript, type StatusLineSpawnContext } from "./status-line";
import { formatUnknownStatusChip } from "./unknown-chip";
import type { EffectReconcileBlockLatchView } from "../core/effect-reconcile-block";
import { formatReconcileBlockStatusChip } from "./reconcile-block-chip";
import { formatBusyStatusAnnouncement, formatIdleStatusAnnouncement, reduceMotion, screenReaderMode, spinnerIntervalMs } from "./a11y";

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
/** Frame period of the one timer (25 fps): smooth enough for the colour pulse. */
export const FRAME_MS = 40;
/** The glyph advances every 100 ms (10 fps), deliberately slower than the frame clock. */
export const SPINNER_MS = 100;
/** One tick of the pulse clock (30 Hz of wall time). */
export const PULSE_MS = 33;

/** DEC 2026 synchronized output: not under tmux, which syncs its own output. */
export function syncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !env.TMUX;
}

export const SYNC_BEGIN = "\u001b[?2026h";
export const SYNC_END = "\u001b[?2026l";
export const CURSOR_HIDE = "\u001b[?25l";
export const CURSOR_SHOW = "\u001b[?25h";

/** Wrap one live redraw so the terminal presents it atomically. */
export function syncFrame(body: string, sync = syncEnabled()): string {
  return sync ? SYNC_BEGIN + body + SYNC_END : body;
}

const PULSE_BASE: RGB = [0x14, 0x14, 0x14];
const PULSE_ACCENT: RGB = [0xbb, 0x9a, 0xf7];

/**
 * The spinner glyph in the accent colour. At truecolor the brightness pulses
 * (sin^2 blend, period ~1.3 s); at 256/16 colours it is the static accent.
 */
export function pulseGlyph(frame: string, pulseTick: number, level = colorLevel()): string {
  if (level === 0) return frame;
  if (level < 3) return paint("accent", frame, level);
  const rgb = blend(PULSE_BASE, PULSE_ACCENT, 0.5 + 0.5 * pulse(pulseTick, 0.08));
  return rgbFg(rgb, 3) + frame + "\u001b[0m";
}

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
  /** colours the glyph (default: cyan) */
  glyph?: (frame: string) => string;
}

/** `⠋ Thinking… 4s · esc to cancel` (styled when colour is on). */
export function spinnerLine(input: SpinnerLineInput): string {
  const verb = input.verb && input.verb !== "" ? input.verb : "Thinking";
  const hint = input.esc ? "esc to cancel" : "ctrl+c to cancel";
  return (
    (input.glyph ?? cyan)(spinnerFrame(input.tick, input.unicode ?? true)) +
    " " +
    verb +
    "\u2026 " +
    dim(`${formatElapsed(input.elapsedMs)} \u00b7 ${hint}`)
  );
}

export interface FooterInput {
  tick: number;
  /** pulse clock tick (30 Hz of wall time) */
  pulseTick?: number;
  verb?: string;
  /** extra parallel tools beyond the one named by `verb` */
  more?: number;
  phaseMs: number;
  turnMs: number;
  inputTokens?: number;
  esc: boolean;
  unicode?: boolean;
  /** columns available (already minus the last column) */
  width: number;
}

/**
 * The busy footer with the narrow ladder. Wide: `⠹ Reading x… 12s · esc to cancel`
 * plus, right-aligned, the turn clock and `⇣31k` when they add information.
 * <80 the hint shrinks, <60 the phase timer goes (turn clock stays), <40 only the
 * truncated label and clock, <24 the spinner alone. Only the label is ever cut.
 */
export function footerLine(input: FooterInput): string {
  if (screenReaderMode() || reduceMotion()) return formatBusyStatusAnnouncement(input);
  const unicode = input.unicode ?? true;
  const w = Math.max(1, Math.floor(input.width));
  // The ladder is in terminal columns; `width` already leaves the last one free.
  const cols = w + 1;
  const glyph = pulseGlyph(spinnerFrame(input.tick, unicode), input.pulseTick ?? 0);
  if (cols < 24) return glyph;
  const base = input.verb && input.verb !== "" ? input.verb : "Thinking";
  const label = (text: string): string => text + (input.more && input.more > 0 ? ` + ${input.more} more` : "") + (text.endsWith("\u2026") ? "" : "\u2026");
  const phase = formatElapsed(input.phaseMs);
  const turn = formatElapsed(input.turnMs);
  const hintFull = input.esc ? "esc to cancel" : "ctrl+c to cancel";
  const hintShort = input.esc ? "esc" : "ctrl+c";
  let tail = "";
  let right = "";
  if (cols >= 80) tail = " " + dim(`${phase} \u00b7 ${hintFull}`);
  else if (cols >= 60) tail = " " + dim(`${phase} \u00b7 ${hintShort}`);
  {
    const tok = input.inputTokens !== undefined && input.inputTokens > 0 && cols >= 60 ? ` ${unicode ? "\u21e3" : "v"}${formatTokens(input.inputTokens)}` : "";
    // Wide: the turn clock shows only when it adds information over the phase timer.
    if (cols < 60 || turn !== phase || tok !== "") right = dim(turn) + (tok ? dim(tok) : "");
  }
  let text = base;
  const build = (t: string): string => {
    const left = glyph + " " + label(t) + tail;
    if (right === "") return left;
    const gap = w - visibleWidth(left) - visibleWidth(right);
    return left + " ".repeat(Math.max(2, gap)) + right;
  };
  let line = build(text);
  let guard = 0;
  while (visibleWidth(line) > w && visibleWidth(text) > 1 && guard++ < 200) {
    text = truncate(strip(text), Math.max(1, visibleWidth(text) - Math.max(1, visibleWidth(line) - w)));
    line = build(text);
  }
  if (visibleWidth(line) > w && tail !== "") {
    tail = "";
    line = build(text);
  }
  return line;
}

/* ------------------------------ status bar ------------------------------ */

export interface StatusInfo {
  /** mode badge ("PLAN", "ACCEPT-EDITS", "READ-ONLY") or "" for default */
  badge: string;
  model: string;
  provider: string;
  /** 0-100, or undefined before the first context.usage event */
  contextPercent?: number;
  /** Token estimate and window from `context.usage` (docs/30 §5.12). */
  contextUsed?: number;
  contextWindow?: number;
  /** already shortened (~) workspace path */
  path: string;
  branch?: string;
  /** Unreconciled `hz.effect.unknown` count for the live session (docs/13 R169). */
  unknownCount?: number;
  /** Receipt id on the latest unknown, when count === 1. */
  unknownReceiptId?: string;
  /** `HZ_EFFECT_RECONCILE_BLOCK` latch for this session (ruling **304**). */
  reconcileBlock?: EffectReconcileBlockLatchView;
}

/**
 * Built-in `used/window` segment (docs/33 §5.13). Compact k-suffix counts;
 * when usage exceeds 85% of the window, append `high` so the bar signals
 * pressure without needing a separate gauge.
 */
export function formatTokenHint(used?: number, window?: number): string {
  if (used === undefined || window === undefined || window <= 0) return "";
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(Math.round(n));
  };
  const base = `${fmt(used)}/${fmt(window)}`;
  return used / window >= 0.85 ? `${base} high` : base;
}

const SEP = " \u00b7 ";

/**
 * `PLAN · model · provider · ◑ 12% · ~/proj · ⑂ main`, cut to `width`: the path
 * goes first, then the provider, then the branch; what is left is truncated.
 */
export interface IdleStatusLineOptions {
  /** Strip ANSI (fullscreen status row). */
  plain?: boolean;
  /** Append a busy segment after the bar. */
  busy?: boolean;
  /** Plain suffix segments (approval hint, etc.). */
  extras?: readonly string[];
}

/**
 * One idle status formatter for scrollback (`createLive.showIdle`) and fullscreen
 * (`fullscreen-chat.ts`). Optional plain/busy/extras for the alt-screen row.
 */
export function formatIdleStatusLine(info: StatusInfo, width: number, opts: IdleStatusLineOptions = {}): string {
  const limit = Math.max(10, Math.floor(width));
  let line = opts.plain ? strip(composeStatusBar(info, limit)) : composeStatusBar(info, limit);
  const tail: string[] = [];
  if (opts.busy) tail.push("busy");
  for (const bit of opts.extras ?? []) {
    if (bit !== "") tail.push(bit);
  }
  if (tail.length > 0) {
    const suffix = ` · ${tail.join(" · ")}`;
    const room = limit - visibleWidth(line);
    line += room >= visibleWidth(suffix) ? suffix : ` · ${truncate(tail.join(" · "), Math.max(4, room - 3))}`;
  }
  if (visibleWidth(line) > limit) line = opts.plain ? truncate(line, limit) : dim(truncate(strip(line), limit));
  return line;
}

export function composeStatusBar(info: StatusInfo, width: number): string {
  const limit = Math.max(10, Math.floor(width));
  const mode = info.badge !== "" ? bold(yellow(info.badge)) : dim("default");
  const usageHint = formatTokenHint(info.contextUsed, info.contextWindow);
  const unknown =
    info.unknownCount !== undefined && info.unknownCount > 0
      ? formatUnknownStatusChip(info.unknownCount, info.unknownReceiptId)
      : "";
  const reconcileBlock =
    info.reconcileBlock !== undefined ? formatReconcileBlockStatusChip(info.reconcileBlock) : "";
  const parts: Record<string, string> = {
    mode,
    unknown,
    reconcileBlock,
    model: info.model,
    provider: dim(info.provider),
    ctx: info.contextPercent === undefined ? "" : dim("\u25d1 ") + `${Math.max(0, Math.min(999, Math.round(info.contextPercent)))}%`,
    usage: usageHint !== "" ? dim(usageHint) : "",
    path: dim(info.path),
    branch: info.branch ? dim("\u2442 ") + info.branch : "",
  };
  const dropOrder = ["path", "provider", "branch", "usage", "ctx"];
  const order = ["mode", "unknown", "reconcileBlock", "model", "provider", "ctx", "usage", "path", "branch"];
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
  /** Esc cancels (raw keypress handling is wired) */
  esc: boolean;
  /** pause drawing (an approval question owns the line) */
  paused?: () => boolean;
  now?: () => number;
  /** extra live lines drawn above the spinner (the subagent group) */
  group?: (tick: number, width: number) => string[];
  /** optional user-config script row (docs/33 §5.13) */
  statusScript?: StatusLineScript;
  /** When set, status scripts spawn through `spawnOwned` instead of `spawnSync`. */
  statusSpawn?: StatusLineSpawnContext;
  /** DEC 2026 around each redraw (default: not under tmux) */
  sync?: boolean;
}

export interface Live {
  readonly enabled: boolean;
  /** erase the live region; call before every transcript write */
  erase(): void;
  /**
   * Print the dim status line ONCE as a normal transcript line, just before the
   * prompt. Skipped when nothing was written since the last copy and it has not
   * changed. The cursor must be at the start of a line.
   */
  showIdle(): void;
  beginTurn(): void;
  toolStart(name: string, args: unknown, callId?: string): void;
  toolEnd(callId?: string): void;
  noteUsage(inputTokens: number): void;
  /** stats for the footer; stops the spinner */
  endTurn(): { ms: number; tools: number; inputTokens?: number };
  dispose(): void;
}

/** Escape that clears an `n`-line live region ending at the cursor. */
export function eraseRegion(n: number): string {
  if (n <= 1) return "\r\u001b[2K";
  return `\r\u001b[${n - 1}A\u001b[J`;
}

/**
 * Design: readline owns the prompt line, so nothing is ever drawn below it. While
 * idle the status is a plain transcript line above the prompt. While a turn runs
 * the live region (an optional subagent group plus the spinner footer) sits at
 * the cursor, redrawn as ONE synchronized-output frame and erased before any
 * transcript write. One timer; identical consecutive frames write nothing.
 */
export function createLive(opts: LiveOptions): Live {
  const now = opts.now ?? Date.now;
  const unicode = unicodeLocale();
  const sync = opts.sync ?? syncEnabled();
  const frameMs = reduceMotion() ? 1000 : FRAME_MS;
  const spinMs = spinnerIntervalMs();
  let drawnLines = 0;
  let cursorHidden = false;
  let lastFrame = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let phaseAt = 0;
  let tools = 0;
  // Running tools in start order: the footer names the oldest and counts the rest.
  const runningTools = new Map<string, string>();
  let anonymous = 0;
  let inputTokens: number | undefined;
  let busy = false;
  let dirty = true;
  let lastBar = "";

  const restoreCursor = (): void => {
    if (!cursorHidden) return;
    cursorHidden = false;
    opts.write(CURSOR_SHOW);
  };

  const erase = (): void => {
    if (!opts.enabled) return;
    dirty = true;
    if (drawnLines === 0) return;
    const n = drawnLines;
    drawnLines = 0;
    lastFrame = "";
    restoreCursor();
    opts.write(eraseRegion(n));
  };

  const draw = (): void => {
    const t = now();
    const w = terminalWidth() - 1;
    const verb = runningTools.size > 0 ? (runningTools.values().next().value as string) : "Thinking";
    const foot = footerLine({
      tick: Math.floor((t - startedAt) / spinMs),
      pulseTick: reduceMotion() ? 0 : Math.floor((t - startedAt) / PULSE_MS),
      verb,
      more: Math.max(0, runningTools.size - 1),
      phaseMs: t - phaseAt,
      turnMs: t - startedAt,
      inputTokens,
      esc: opts.esc,
      unicode,
      width: w,
    });
    const lines = [...(opts.group?.(Math.floor((t - startedAt) / spinMs), w) ?? []), foot].map((l) =>
      visibleWidth(l) > w ? truncate(strip(l), w) : l,
    );
    const frame = lines.join("\n");
    if (frame === lastFrame && drawnLines === lines.length) return;
    const body = (drawnLines > 0 ? eraseRegion(drawnLines) : "\r\u001b[2K") + (cursorHidden ? "" : CURSOR_HIDE) + frame;
    cursorHidden = true;
    drawnLines = lines.length;
    lastFrame = frame;
    opts.write(syncFrame(body, sync));
  };

  const frame = (): void => {
    if (!busy) return;
    if (opts.paused?.() || !opts.atLineStart() || opts.typed()) {
      // Text is streaming, a question is open or the human is typing: step aside.
      if (drawnLines > 0) erase();
      return;
    }
    draw();
  };

  const onResize = (): void => {
    if (drawnLines > 0) erase();
  };
  const onExit = (): void => {
    if (cursorHidden) {
      cursorHidden = false;
      try {
        process.stdout.write(CURSOR_SHOW);
      } catch {
        /* terminal went away */
      }
    }
  };
  if (opts.enabled) {
    try {
      process.stdout.on("resize", onResize);
      process.on("exit", onExit);
    } catch {
      /* no resize events */
    }
  }

  const stop = (): void => {
    busy = false;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const scriptLines = (info: StatusInfo): string[] => {
    if (!opts.statusScript) return [];
    return runStatusLineScript(opts.statusScript, { ...info }, JSON.stringify(info), opts.statusSpawn);
  };

  return {
    enabled: opts.enabled,
    erase,
    showIdle() {
      if (!opts.enabled || busy) return;
      const info = opts.status();
      const bar = screenReaderMode()
        ? formatIdleStatusAnnouncement(info)
        : formatIdleStatusLine(info, terminalWidth() - 1);
      const extra = scriptLines(info)
        .map((l) => dim(truncate(l, Math.max(10, terminalWidth() - 1))))
        .join("\n");
      const block = extra !== "" ? `${bar}\n${extra}` : bar;
      if (!dirty && block === lastBar) return;
      dirty = false;
      lastBar = block;
      opts.write(block + "\n");
    },
    beginTurn() {
      tools = 0;
      runningTools.clear();
      inputTokens = undefined;
      startedAt = now();
      phaseAt = startedAt;
      busy = true;
      if (!opts.enabled) return;
      if (timer === undefined) {
        timer = setInterval(frame, frameMs);
        (timer as { unref?: () => void }).unref?.();
      }
      frame();
    },
    toolStart(name, args, callId) {
      tools++;
      if (runningTools.size === 0) phaseAt = now();
      runningTools.set(callId ?? `#${anonymous++}`, toolVerb(name, args));
    },
    toolEnd(callId) {
      if (callId !== undefined && runningTools.has(callId)) runningTools.delete(callId);
      else if (runningTools.size > 0) runningTools.delete(runningTools.keys().next().value as string);
      phaseAt = now();
    },
    noteUsage(n) {
      if (Number.isFinite(n) && n > 0) inputTokens = n;
    },
    endTurn() {
      stop();
      erase();
      return { ms: now() - startedAt, tools, inputTokens };
    },
    dispose() {
      stop();
      erase();
      restoreCursor();
      if (opts.enabled) {
        try {
          process.stdout.off("resize", onResize);
          process.off("exit", onExit);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
