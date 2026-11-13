/**
 * render.ts — turns runtime events into terminal output.
 *
 * The transcript flows in normal scrollback: assistant text is written straight
 * through as it arrives, tool activity becomes one compact card, and anything the
 * runtime wants to say becomes a single dim line. Nothing here repaints the
 * screen, so the output stays scrollable, copyable and pipe-safe.
 */

import type { RuntimeEvent, ToolCardDetail } from "../contracts";
import {
  FOLD_MIN, HEADER_FIRST_TOOLS, READ_ONLY_TOOLS, foldLine, formatToolEffectLinkage, resultLine, shellFooter, shellHeader, shellOutputLines,
  subagentGroupLines, subagentLine, toolCardLines, type CardStyle, type GroupRow,
} from "./cards";
import { richDiff } from "./diff";
import { createMarkdownStream, type MarkdownStream } from "./markdown";
import { formatDuration, pulseGlyph, spinnerFrame, toolVerb, unicodeLocale } from "./live";
import { formatUnknownEffectAnnouncement, screenReaderMode } from "./a11y";
import { formatUnknownEffectNotice } from "./unknown-chip";
import {
  bold, colorLevel, cyan, dim, green, red, sanitizeText, strip, terminalWidth, truncate, visibleWidth, wrapText, type ColorLevel,
} from "./style";

export interface RenderOptions {
  /** Wrap long lines to the terminal width (interactive mode). */
  wrap?: boolean;
  out?: (chunk: string) => void;
  /**
   * Called just before every write. Returning true means the hook itself emitted
   * a newline (used by the chat loop while the human is typing mid-stream).
   */
  beforeWrite?: () => boolean;
  /**
   * Rich (TTY) cards: one-line tool cards with durations, the shell output panel,
   * folded read-only runs and the subagent group. Off by default so every pipe,
   * headless run and test keeps the plain two-line form byte for byte.
   */
  rich?: boolean;
  /** Pin the colour level / glyph set (tests); default: detected. */
  level?: ColorLevel;
  unicode?: boolean;
  now?: () => number;
  /** Unfold long diff context and lift the diff row cap (docs/13 D9). */
  unfoldDiff?: boolean;
  /** Unfold shell tool output panels (docs/13 D9). */
  unfoldOutput?: boolean;
}

function envTruthy(env: Record<string, string | undefined>, key: string): boolean {
  const v = env[key];
  return v === "1" || v === "true";
}

export interface Renderer {
  handle(ev: RuntimeEvent): void;
  write(chunk: string): void;
  ensureLineStart(): void;
  line(text: string): void;
  notice(message: string): void;
  error(message: string): void;
  atLineStart(): boolean;
  /** Live subagent group lines for the animated region (rich mode only). */
  liveLines?(tick: number, width: number): string[];
  /** The last finished reasoning block (rich mode; "" when there was none). */
  lastThinking?(): string;
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
  const env = process.env as Record<string, string | undefined>;
  const unfoldDiff = opts.unfoldDiff ?? envTruthy(env, "HZ_TUI_UNFOLD_DIFF");
  const unfoldOutput = opts.unfoldOutput ?? envTruthy(env, "HZ_TUI_UNFOLD_OUTPUT");
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

  /* ------------------------- rich cards (TTY only) ------------------------- */

  const rich = opts.rich === true;
  const now = opts.now ?? Date.now;
  const cardStyle = (): CardStyle => ({
    width: Math.max(20, terminalWidth() - 1),
    level: opts.level ?? colorLevel(),
    unicode: opts.unicode ?? unicodeLocale(),
    expandOutput: unfoldOutput,
  });
  interface Call { name: string; args: unknown; at: number }
  const calls = new Map<string, Call>();
  interface FoldCard { name: string; args: unknown; summary?: string; detail?: ToolCardDetail; ms: number; lines: string[] }
  let fold: FoldCard[] = [];
  interface Sub {
    callId: string;
    task: string;
    profile?: string;
    at: number;
    agentId?: string;
    state: "running" | "completed" | "failed";
    activity: string;
    endedAt?: number;
    /** From `subagent.end` (C2): exact child wall time, tool count, failure reason. */
    final?: { status: "completed" | "failed" | "cancelled"; ms: number; tools?: number; reason?: string };
  }
  const subs: Sub[] = [];

  /* Streaming markdown for assistant text: one stream per message, finished by any other event. */
  let md: MarkdownStream | undefined;
  let mdTimer: ReturnType<typeof setTimeout> | undefined;
  const clearMdTimer = (): void => {
    if (mdTimer !== undefined) {
      clearTimeout(mdTimer);
      mdTimer = undefined;
    }
  };
  /** Release the plain head of a slow line so prose never stalls waiting for its newline. */
  const releasePartial = (): void => {
    mdTimer = undefined;
    const text = md?.flushPartial() ?? "";
    if (text !== "") write(text);
  };
  const mdPush = (text: string): void => {
    clearMdTimer();
    if (!md) md = createMarkdownStream({ width: Math.max(20, terminalWidth() - 1), level: opts.level ?? colorLevel(), unicode: opts.unicode ?? unicodeLocale() });
    const out = md.push(text);
    if (out !== "") write(out);
    mdTimer = setTimeout(releasePartial, 150);
    (mdTimer as { unref?: () => void }).unref?.();
  };
  const mdFinish = (): void => {
    clearMdTimer();
    if (!md) return;
    const out = md.end();
    md = undefined;
    if (out !== "") write(out);
  };

  const writeLines = (lines: string[]): void => {
    if (lines.length === 0) return;
    ensureLineStart();
    write(lines.join("\n") + "\n");
  };

  /** Commit the buffered read-only run: one folded line when long, else each card. */
  const flushFold = (): void => {
    if (fold.length === 0) return;
    const items = fold;
    fold = [];
    if (items.length >= FOLD_MIN) {
      writeLines([foldLine(items.map((i) => ({ name: i.name, durationMs: i.ms })), cardStyle())]);
      return;
    }
    for (const it of items) writeLines(it.lines);
  };

  const settle = (): void => {
    mdFinish();
    flushFold();
  };

  const subLabel = (sub: Sub): string => sub.task || sub.profile || "subagent";

  const cardLinkage = (ev: Extract<RuntimeEvent, { type: "tool.card" }>) => ({
    effectId: ev.effectId,
    receiptId: ev.receiptId,
    receiptSeq: ev.receiptSeq,
  });

  const richCard = (ev: Extract<RuntimeEvent, { type: "tool.card" }>): void => {
    const name = sanitizeText(ev.name) || "tool";
    const style = cardStyle();
    const id = String(ev.callId ?? "");
    const linkage = cardLinkage(ev);
    if (ev.status === "running") {
      calls.set(id, { name, args: ev.args, at: now() });
      if (READ_ONLY_TOOLS.has(name) || !HEADER_FIRST_TOOLS.has(name)) return;
      flushFold();
      if (name === "shell" || name === "shell_session") {
        const cmd = typeof ev.args?.command === "string" ? ev.args.command : typeof ev.args?.cmd === "string" ? ev.args.cmd : name;
        writeLines([shellHeader(cmd, style)]);
      } else if (name === "agent") {
        const a = (ev.args ?? {}) as Record<string, unknown>;
        const pick = (k: string[]): string => {
          for (const key of k) if (typeof a[key] === "string" && a[key] !== "") return a[key] as string;
          return "";
        };
        const sub: Sub = {
          callId: id,
          task: pick(["description", "task", "prompt"]),
          profile: pick(["profile"]) || undefined,
          at: now(),
          state: "running",
          activity: "",
        };
        subs.push(sub);
        writeLines([subagentLine({ state: "running", task: subLabel(sub), profile: sub.profile }, style)]);
      } else {
        writeLines(toolCardLines({ name, args: ev.args, status: "running", ...linkage }, style));
      }
      return;
    }
    const call = calls.get(id) ?? { name, args: ev.args, at: now() };
    calls.delete(id);
    const status = ev.status === "ok" ? "ok" : "error";
    const ms = ev.detail?.durationMs ?? Math.max(0, now() - call.at);
    const input = { name, args: call.args, status, summary: ev.summary, detail: { ...ev.detail, durationMs: ms }, ...linkage } as const;
    if (READ_ONLY_TOOLS.has(name)) {
      const lines = toolCardLines(input, style);
      if (status === "ok") {
        fold.push({ name, args: call.args, summary: ev.summary, detail: input.detail, ms, lines });
        return;
      }
      flushFold();
      writeLines(lines);
      return;
    }
    flushFold();
    if (name === "shell" || name === "shell_session") {
      if (ev.detail?.output !== undefined) writeLines(shellOutputLines(ev.detail.output, style));
      writeLines(shellFooter({ status, exitCode: ev.detail?.exitCode, durationMs: ms, summary: ev.summary, ...linkage }, style));
    } else if (name === "agent") {
      const sub = subs.find((x) => x.callId === id) ?? subs.find((x) => x.state === "running");
      if (sub) {
        if (sub.final !== undefined) {
          // C2 gave the exact outcome: the card's completion line carries it.
          writeLines([subEndLine(sub, sub.final, style)]);
        } else {
          sub.state = status === "ok" ? "completed" : "failed";
          sub.endedAt = now();
          writeLines([
            subagentLine(
              { state: sub.state, task: subLabel(sub), ms, profile: undefined, reason: status === "error" ? firstLine(ev.summary, 40) : undefined },
              style,
            ),
          ]);
        }
      }
    } else if (HEADER_FIRST_TOOLS.has(name)) {
      writeLines(resultLine(input, style));
    } else {
      writeLines(toolCardLines(input, style));
    }
  };

  const subEndLine = (sub: Sub, f: NonNullable<Sub["final"]>, style: CardStyle): string =>
    subagentLine(
      {
        state: f.status,
        task: subLabel(sub),
        ms: f.ms,
        reason: f.reason,
        activity: f.tools !== undefined && f.tools > 0 ? `${f.tools} tool${f.tools === 1 ? "" : "s"}` : undefined,
      },
      style,
    );

  /** C2 boundaries: bind the child id to its card, or draw the cells when no card exists. */
  const richSubBoundary = (ev: Extract<RuntimeEvent, { type: "subagent.start" | "subagent.end" }>): void => {
    const style = cardStyle();
    let sub = subs.find((x) => x.agentId === ev.agentId);
    if (!sub) sub = subs.find((x) => x.agentId === undefined && x.callId !== "" && x.state === "running");
    if (ev.type === "subagent.start") {
      if (sub) {
        sub.agentId = ev.agentId;
        if (sub.task === "") sub.task = sanitizeText(ev.task);
        if (!sub.profile && ev.profile) sub.profile = ev.profile;
        return;
      }
      sub = { callId: "", task: sanitizeText(ev.task), profile: ev.profile, at: now(), agentId: ev.agentId, state: "running", activity: "" };
      subs.push(sub);
      flushFold();
      writeLines([subagentLine({ state: "running", task: subLabel(sub), profile: sub.profile }, style)]);
      return;
    }
    if (!sub) return;
    const final = { status: ev.status, ms: ev.durationMs, tools: ev.tools, reason: ev.reason };
    sub.state = ev.status === "completed" ? "completed" : "failed";
    sub.endedAt = now();
    if (sub.callId === "") {
      // No tool card to carry the completion: this event draws it.
      flushFold();
      writeLines([subEndLine(sub, final, style)]);
    } else {
      sub.final = final;
    }
  };

  const richSubEvent = (agentId: string, inner: RuntimeEvent, profile?: string): void => {
    let sub = subs.find((x) => x.agentId === agentId);
    if (!sub) {
      sub = subs.find((x) => x.agentId === undefined && x.state === "running");
      if (sub) sub.agentId = agentId;
      else {
        sub = { callId: "", task: "", profile, at: now(), agentId, state: "running", activity: "" };
        subs.push(sub);
      }
    }
    if (profile && !sub.profile) sub.profile = profile;
    if (!inner || typeof inner !== "object") return;
    if (inner.type === "tool.card" && inner.status === "running") sub.activity = toolVerb(sanitizeText(inner.name), inner.args);
    else if (inner.type === "assistant.done") sub.activity = "Responding";
    else if (inner.type === "error") sub.activity = "error";
  };

  const liveLines = (tick: number, width: number): string[] => {
    if (!rich || subs.length === 0) return [];
    const t = now();
    for (let i = subs.length - 1; i >= 0; i--) {
      const e = subs[i]?.endedAt;
      if (e !== undefined && t - e > 2000) subs.splice(i, 1);
    }
    const style = { ...cardStyle(), width };
    const rows: GroupRow[] = subs.map((x) => ({
      state: x.state,
      label: subLabel(x),
      activity: x.state === "running" ? x.activity : undefined,
      ms: (x.endedAt ?? t) - x.at,
    }));
    const spin = pulseGlyph(spinnerFrame(tick, style.unicode), tick * 3, style.level);
    return subagentGroupLines(rows, style, spin);
  };

  const nestedCount = new Map<string, number>();
  const profileShown = new Set<string>();

  /** One child event, indented under the agent card behind a dim bar. */
  const handleNested = (agentId: string, inner: RuntimeEvent, profile?: string): void => {
    if (!inner || typeof inner !== "object") return;
    // The profile name rides the card: one header line before a profiled child's first line.
    if (typeof profile === "string" && profile !== "" && !profileShown.has(agentId)) {
      profileShown.add(agentId);
      ensureLineStart();
      write("  " + dim("\u2502") + " " + dim("profile: ") + bold(sanitizeText(profile)) + "\n");
    }
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

  // Reasoning (assistant.thinking) is buffered and committed as ONE dim
  // collapsed line when the next real event arrives; `/think` shows the text.
  let thinkBuf = "";
  let thinkStart = 0;
  let thinkLast = "";
  const flushThinking = (): void => {
    if (thinkBuf === "") return;
    const text = thinkBuf;
    const ms = Math.max(0, Date.now() - thinkStart);
    thinkBuf = "";
    thinkStart = 0;
    thinkLast = text;
    const n = text.split("\n").filter((l) => l.trim() !== "").length;
    emit(dim(`\u25c6 Thought for ${formatDuration(ms)} \u00b7 ${n} line${n === 1 ? "" : "s"} \u00b7 /think to expand`), dim);
  };

  const handle = (ev: RuntimeEvent): void => {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "assistant.thinking") {
      // Additive event: ignored outside rich mode so the plain transcript is unchanged.
      if (rich && typeof ev.text === "string" && ev.text !== "") {
        if (thinkBuf === "") thinkStart = Date.now();
        if (thinkBuf.length < 64_000) thinkBuf += sanitizeText(ev.text);
      }
      return;
    }
    if (rich && ev.type !== "context.usage") flushThinking();
    if (rich && ev.type !== "assistant.delta" && ev.type !== "context.usage") mdFinish();
    if (rich && ev.type !== "tool.card" && ev.type !== "subagent.event" && ev.type !== "subagent.start" && ev.type !== "subagent.end" && ev.type !== "context.usage") flushFold();
    switch (ev.type) {
      case "subagent.start":
      case "subagent.end":
        // Additive C2 events: drawn in rich mode only, ignored in the plain transcript.
        if (rich) richSubBoundary(ev);
        break;
      case "subagent.event":
        if (rich) richSubEvent(String(ev.agentId), ev.event, ev.profile);
        else handleNested(String(ev.agentId), ev.event, ev.profile);
        break;
      case "turn.diff": {
        const files = typeof ev.files === "number" ? ev.files : 0;
        if (files < 1) break;
        emit(dim(`\u00b7 changed ${files} file${files === 1 ? "" : "s"}`), dim);
        if (rich) {
          const view = richDiff(typeof ev.diff === "string" ? ev.diff : "", {
            width: terminalWidth(),
            cap: TURN_DIFF_LINE_CAP,
            unicode: unicodeLocale(),
            expandContext: unfoldDiff,
            expandCap: unfoldDiff,
          });
          if (view.length > 0) {
            ensureLineStart();
            write(view.join("\n") + "\n");
          }
          if (ev.truncated === true) emit("  " + dim("\u2026 diff truncated"), dim);
          break;
        }
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
        if (rich) mdPush(sanitizeText(ev.text));
        else write(sanitizeText(ev.text));
        break;
      }
      case "assistant.done": {
        // Some runtimes only emit the finished text: never swallow it.
        if (!sawDelta && typeof ev.text === "string" && ev.text.trim() !== "") {
          if (rich) {
            mdPush(sanitizeText(ev.text));
            mdFinish();
          } else write(sanitizeText(ev.text));
        }
        sawDelta = false;
        ensureLineStart();
        break;
      }
      case "tool.card": {
        if (rich) {
          richCard(ev);
          const richPreview = previewOf(ev);
          if (richPreview !== "") {
            flushFold();
            ensureLineStart();
            write(
              richDiff(richPreview, {
                width: terminalWidth(),
                unicode: unicodeLocale(),
                expandContext: unfoldDiff,
              }).join("\n") + "\n",
            );
          }
          break;
        }
        const name = sanitizeText(ev.name) || "tool";
        if (ev.status === "running") {
          emitArgs(name, ev.args);
        } else {
          const ok = ev.status === "ok";
          const summary = firstLine(ev.summary);
          emit("  " + dim("\u2514 ") + (ok ? green("ok") : red("error")) + (summary ? dim(": " + summary) : ""), dim);
          const link = formatToolEffectLinkage(ev);
          if (link !== "") emit("  " + dim(link), dim);
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
      case "effect.unknown":
        if (screenReaderMode()) {
          ensureLineStart();
          write(sanitizeText(formatUnknownEffectAnnouncement(ev)) + "\n");
        }
        emit(
          dim("\u00b7 " + sanitizeText(formatUnknownEffectNotice(ev))),
          dim,
        );
        break;
      case "effect.reconciled":
        emit(dim(`\u00b7 effect reconciled (${sanitizeText(ev.effectId).slice(0, 8)})`), dim);
        break;
      case "error":
        emit(red("\u26a0 " + sanitizeText(ev.message)), red);
        break;
      case "turn.done":
        ensureLineStart();
        subs.length = 0;
        calls.clear();
        break;
      default:
        break;
    }
  };

  return {
    handle,
    write: (chunk: string) => {
      settle();
      write(chunk);
    },
    ensureLineStart: () => {
      settle();
      ensureLineStart();
    },
    line: (text: string) => {
      settle();
      emit(text);
    },
    notice: (message: string) => {
      settle();
      emit(dim("\u00b7 " + sanitizeText(message)), dim);
    },
    error: (message: string) => {
      settle();
      emit(red("\u26a0 " + sanitizeText(message)), red);
    },
    atLineStart: () => atStart,
    ...(rich ? { liveLines, lastThinking: () => thinkLast } : {}),
  };
}
