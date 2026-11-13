/**
 * cards.ts — pure string formatters for the rich (TTY) tool cards, the shell
 * output panel, folded read-only runs and the subagent lines.
 *
 * Nothing here touches the terminal or readline: every function takes the data
 * and a width/level and returns lines, so the same output can feed the readline
 * driver today and any other driver later, and so each can be unit tested at
 * several widths and colour levels. Lines never exceed `width` columns.
 */

import type { ToolCardDetail } from "../contracts";
import { foldMiddleLines, isFoldedMiddleMarker } from "./fold-lines";
import { colorLevel, onBg, paint, sanitizeText, strip, truncate, visibleWidth, wrapText, type ColorLevel, type Role } from "./style";

export interface CardStyle {
  /** columns available (the caller leaves the last column free) */
  width: number;
  level?: ColorLevel;
  /** false selects ASCII glyphs of the same width */
  unicode?: boolean;
  /** When true, shell output panels show every line (docs/13 D9). */
  expandOutput?: boolean;
}

export interface Glyphs {
  bullet: string;
  err: string;
  ok: string;
  branch: string;
  rail: string;
  ellipsis: string;
  open: string;
  closed: string;
  enter: string;
  tokens: string;
}

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode
    ? { bullet: "\u25c6", err: "\u2717", ok: "\u2713", branch: "\u2514", rail: "\u258e", ellipsis: "\u2026", open: "\u25be", closed: "\u25b8", enter: "\u23ce", tokens: "\u21e3" }
    : { bullet: "*", err: "x", ok: "+", branch: "`", rail: "|", ellipsis: "...", open: "v", closed: ">", enter: "<", tokens: "v" };
}

const ESC = "\u001b[";
const bld = (s: string, level: ColorLevel): string => (level === 0 || s === "" ? s : `${ESC}1m${s}${ESC}0m`);
const mod = (code: string, s: string, level: ColorLevel): string => (level === 0 || s === "" ? s : `${ESC}${code}m${s}${ESC}0m`);
const dimmed = (s: string, level: ColorLevel): string => mod("2", s, level);

/* ------------------------------ small helpers ------------------------------ */

/** `<10s` 3.2s, `<60s` 20s, `1m51s`, `2h5m`; under a second `0.4s`, under 50 ms `<0.1s`. */
export function cardDuration(ms: number): string {
  const v = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (v < 50) return "<0.1s";
  if (v < 10_000) return `${(v / 1000).toFixed(1)}s`;
  const total = Math.round(v / 1000);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60)}m`;
}

/** `src/tui/render.ts` stays; a long path becomes `…/tui/render.ts` (basename plus parent). */
export function shortPath(p: string, max = 40, ellipsis = "\u2026"): string {
  const s = sanitizeText(p).replace(/\s+/g, " ");
  if (visibleWidth(s) <= max) return s;
  const parts = s.split("/").filter((x) => x !== "");
  const base = parts[parts.length - 1] ?? s;
  const tail = parts.length >= 2 ? `${parts[parts.length - 2]}/${base}` : base;
  const short = `${ellipsis}/${tail}`;
  if (visibleWidth(short) <= max) return short;
  return truncate(`${ellipsis}/${base}`, max);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function firstString(args: unknown, keys: string[]): string {
  if (args === null || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** Added/removed lines of a replacement, ignoring the lines both sides share at the ends. */
export function lineDelta(oldText: string, newText: string): { add: number; del: number } {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { add: b.length - head - tail, del: a.length - head - tail };
}

/** Added/removed line totals and file count of an apply_patch style body. */
export function patchStats(patch: string): { add: number; del: number; files: number } {
  let add = 0;
  let del = 0;
  let files = 0;
  for (const line of patch.split("\n")) {
    if (/^\*\*\* (Update|Add|Delete) File:/.test(line) || /^\+\+\+ /.test(line)) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del, files };
}

/* ------------------------------ tool taxonomy ------------------------------ */

/** Tools whose card is committed once, when they finish. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "ast_search", "repo_map"]);
/** Tools whose header is printed at start (they can block on approval or run long). */
export const HEADER_FIRST_TOOLS: ReadonlySet<string> = new Set(["shell", "shell_session", "write", "edit", "ast_edit", "apply_patch", "agent"]);

export interface ToolDesc {
  verb: string;
  object: string;
  objectRole: Role | "text";
  /** plain detail after the object, e.g. `(14 matches)` */
  extra: string;
  /** `+A/-D` totals rendered coloured after the object */
  delta?: { add: number; del: number };
}

/** What a card says about a tool call: verb, object and detail. Never invents numbers. */
export function describeTool(name: string, args: unknown, detail?: ToolCardDetail): ToolDesc {
  const pathArg = firstString(args, ["path", "file_path", "file"]);
  const rec = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const count = detail?.count;
  switch (name) {
    case "read": {
      let extra = "";
      const off = typeof rec.offset === "number" ? rec.offset : undefined;
      const lim = typeof rec.limit === "number" ? rec.limit : undefined;
      if (off !== undefined || lim !== undefined) {
        const from = off ?? 1;
        extra = lim !== undefined ? `(${from}-${from + lim - 1})` : `(from ${from})`;
      } else if (count !== undefined) extra = `(${count} line${count === 1 ? "" : "s"})`;
      return { verb: "Read", object: pathArg, objectRole: "path", extra };
    }
    case "grep":
    case "ast_search": {
      const pat = firstString(args, ["pattern", "query"]);
      const where = pathArg;
      return {
        verb: "Search",
        object: `"${pat}"` + (where ? ` in ${where}` : ""),
        objectRole: "info",
        extra: count !== undefined ? `(${count} match${count === 1 ? "" : "es"})` : "",
      };
    }
    case "glob":
      return {
        verb: "Glob",
        object: firstString(args, ["pattern"]),
        objectRole: "info",
        extra: count !== undefined ? `(${count} file${count === 1 ? "" : "s"})` : "",
      };
    case "repo_map":
      return { verb: "Map", object: pathArg || "repo", objectRole: "path", extra: "" };
    case "edit": {
      return { verb: "Edit", object: pathArg, objectRole: "path", extra: "", ...(str(rec.new) !== "" || str(rec.old) !== "" ? { delta: lineDelta(str(rec.old), str(rec.new)) } : {}) };
    }
    case "write":
      return { verb: "Write", object: pathArg, objectRole: "path", extra: "", delta: { add: lineCount(str(rec.content)), del: 0 } };
    case "ast_edit":
      return { verb: "Edit", object: pathArg || firstString(args, ["pattern"]), objectRole: "path", extra: "" };
    case "apply_patch": {
      const body = firstString(args, ["patch", "input", "diff", "text"]);
      const st = patchStats(body);
      return {
        verb: "Edit",
        object: st.files > 0 ? `${st.files} file${st.files === 1 ? "" : "s"}` : "patch",
        objectRole: "text",
        extra: "",
        ...(st.add + st.del > 0 ? { delta: { add: st.add, del: st.del } } : {}),
      };
    }
    case "lsp":
      return { verb: "Lsp", object: [firstString(args, ["action", "operation"]), pathArg].filter((x) => x !== "").join(" "), objectRole: "text", extra: "" };
    case "todo":
      return { verb: "Ran", object: "todo", objectRole: "text", extra: "" };
    case "agent":
      return { verb: "Subagent", object: "", objectRole: "text", extra: "" };
    default: {
      const url = firstString(args, ["url"]);
      if (url) return { verb: "Fetch", object: url.replace(/^https?:\/\//, ""), objectRole: "info", extra: "" };
      return { verb: "Ran", object: name, objectRole: "text", extra: "" };
    }
  }
}

/* -------------------------------- card line -------------------------------- */

export interface CardInput {
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  summary?: string;
  detail?: ToolCardDetail;
  /** duration when the core did not report one */
  elapsedMs?: number;
  /** EffectHost id for this tool call (docs/28 ruling 250). */
  effectId?: string;
  receiptId?: string;
  receiptSeq?: number;
}

/** Dim linkage text: `effect abcd1234 · r#3` when receipt seq is known. */
export function formatToolEffectLinkage(input: Pick<CardInput, "effectId" | "receiptId" | "receiptSeq">): string {
  const bits: string[] = [];
  const eid = typeof input.effectId === "string" ? input.effectId.trim() : "";
  if (eid !== "") bits.push(`effect ${sanitizeText(eid).slice(0, 8)}`);
  if (typeof input.receiptSeq === "number" && Number.isFinite(input.receiptSeq)) {
    bits.push(`r#${Math.floor(input.receiptSeq)}`);
  } else {
    const rid = typeof input.receiptId === "string" ? input.receiptId.trim() : "";
    if (rid !== "") bits.push(`receipt ${sanitizeText(rid).slice(0, 8)}`);
  }
  return bits.join(" \u00b7 ");
}

type EffectLinkageFields = Pick<CardInput, "effectId" | "receiptId" | "receiptSeq">;

function linkageLine(input: EffectLinkageFields, style: CardStyle): string | undefined {
  const text = formatToolEffectLinkage(input);
  if (text === "") return undefined;
  const level = style.level ?? colorLevel();
  return "  " + dimmed(text, level);
}

function appendLinkage(lines: string[], input: EffectLinkageFields, style: CardStyle): void {
  const line = linkageLine(input, style);
  if (line !== undefined) lines.push(line);
}

function bulletFor(status: CardInput["status"], g: Glyphs, level: ColorLevel): string {
  return paint(status === "ok" ? "ok" : status === "error" ? "err" : "accent", g.bullet, level);
}

function deltaText(d: { add: number; del: number }, level: ColorLevel): string {
  const plus = paint("ok", `+${d.add}`, level);
  return d.del > 0 ? plus + dimmed("/", level) + paint("err", `-${d.del}`, level) : plus;
}

/** Left part + right-aligned duration; the object is the only thing cut. */
function withRight(build: (obj: string) => string, objectText: string, right: string, width: number, level: ColorLevel): string {
  let obj = objectText;
  const make = (o: string): string => {
    const left = build(o);
    if (right === "") return left;
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return left + (gap >= 2 && width >= 60 ? " ".repeat(gap) : " ") + dimmed(right, level);
  };
  let line = make(obj);
  let guard = 0;
  while (visibleWidth(line) > width && visibleWidth(obj) > 1 && guard++ < 400) {
    obj = truncate(strip(obj), Math.max(1, visibleWidth(obj) - Math.max(1, visibleWidth(line) - width)));
    line = make(obj);
  }
  return line;
}

/** The finished (or header-first) one-line card plus the error line. */
function toolCardLinesRaw(input: CardInput, style: CardStyle): string[] {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const d = describeTool(input.name, input.args, input.detail);
  const dur = input.status === "running" ? "" : cardDuration(input.detail?.durationMs ?? input.elapsedMs ?? -1);
  const right = input.status === "running" || (input.detail?.durationMs === undefined && input.elapsedMs === undefined) ? "" : dur;
  const objectPlain = d.objectRole === "path" ? shortPath(d.object, 40, g.ellipsis) : sanitizeText(d.object).replace(/\s+/g, " ");
  const lines: string[] = [];
  const header = withRight(
    (obj) => {
      const colored = d.objectRole === "text" || obj === "" ? obj : paint(d.objectRole, obj, level);
      return (
        bulletFor(input.status, g, level) +
        " " +
        bld(d.verb, level) +
        (obj !== "" ? " " + colored : "") +
        (d.delta && input.status !== "running" ? " " + deltaText(d.delta, level) : "") +
        (d.extra !== "" ? " " + dimmed(d.extra, level) : "")
      );
    },
    objectPlain,
    right,
    width,
    level,
  );
  lines.push(header);
  if (input.status === "error") {
    const msg = sanitizeText(input.summary ?? "").trim().split("\n")[0] ?? "";
    const text = truncate(msg === "" ? "failed" : msg, 400);
    const wrapped = wrapText(`error: ${text}`, width - 4);
    wrapped.forEach((part, i) => lines.push((i === 0 ? "  " + paint("err", g.err, level) + " " : "    ") + paint("err", part, level)));
  }
  appendLinkage(lines, input, style);
  return lines;
}

/** The result line printed under a header-first tool (edit, write, patch, agent). */
function resultLineRaw(input: CardInput, style: CardStyle): string[] {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const ms = input.detail?.durationMs ?? input.elapsedMs;
  const dur = ms === undefined ? "" : cardDuration(ms);
  if (input.status === "error") {
    const msg = sanitizeText(input.summary ?? "").trim().split("\n")[0] ?? "";
    const wrapped = wrapText(`error: ${truncate(msg === "" ? "failed" : msg, 400)}`, width - 4);
    return wrapped.map((part, i) => (i === 0 ? "  " + paint("err", g.err, level) + " " : "    ") + paint("err", part + (i === wrapped.length - 1 && dur ? ` \u00b7 ${dur}` : ""), level));
  }
  const d = describeTool(input.name, input.args, input.detail);
  const bits: string[] = [];
  if (d.delta) bits.push(deltaText(d.delta, level));
  else if (input.summary) bits.push(dimmed(truncate(sanitizeText(input.summary).split("\n")[0] ?? "", Math.max(10, width - 16)), level));
  if (dur) bits.push(dimmed(dur, level));
  const lines = ["  " + dimmed(g.branch, level) + " " + (bits.join(dimmed(" \u00b7 ", level)) || dimmed("ok", level))];
  appendLinkage(lines, input, style);
  return lines;
}

/* -------------------------------- shell card -------------------------------- */

export const SHELL_FIRST_LINES = 2;
export const SHELL_LAST_LINES = 3;

/** `$ cmd` with a faint `$` and the command word highlighted; multi-line commands are folded. */
function shellHeaderRaw(command: string, style: CardStyle): string {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const clean = sanitizeText(command).replace(/\t/g, "  ");
  const lines = clean.split("\n");
  const extra = lines.length > 1 ? ` ${g.enter} +${lines.length - 1} line${lines.length === 2 ? "" : "s"}` : "";
  const first = (lines[0] ?? "").trimEnd();
  const room = Math.max(4, width - 2 - visibleWidth(extra));
  const shown = truncate(first, room);
  const m = /^(\s*)(\S+)(.*)$/.exec(shown);
  const body = m ? m[1] + paint("info", m[2], level) + m[3] : shown;
  return dimmed("$", level) + " " + body + dimmed(extra, level);
}

/** The output panel: first 2 lines, `… +N lines`, last 3; rows clipped to the width. */
function shellOutputLinesRaw(output: string, style: CardStyle): string[] {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const text = sanitizeText(output).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/\n+$/, "");
  if (text === "") return [];
  const all = text.split("\n");
  const expanded = style.expandOutput === true;
  const displayed = expanded
    ? all
    : foldMiddleLines(all, { first: SHELL_FIRST_LINES, last: SHELL_LAST_LINES, ellipsis: g.ellipsis });
  const rows: Array<{ text: string; marker?: boolean }> = displayed.map((line) => ({
    text: line,
    marker: !expanded && isFoldedMiddleMarker(line, g.ellipsis),
  }));
  return rows.map((r) => {
    const clipped = truncate(r.text, Math.max(4, width - 4));
    const body = r.marker ? dimmed(clipped, level) : clipped;
    const row = "  " + dimmed(g.rail, level) + " " + body;
    return onBg("bgPanel", row, width, level);
  });
}

/** `  └ exit 0 · 4.2s` (faint) or `  └ exit 1 · 4.2s` (red). */
function shellFooterRaw(
  input: { status: "ok" | "error"; exitCode?: number; durationMs?: number; summary?: string } & EffectLinkageFields,
  style: CardStyle,
): string[] {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const failed = input.status === "error" || (input.exitCode !== undefined && input.exitCode !== 0);
  const bits: string[] = [];
  if (input.exitCode !== undefined && input.exitCode !== 0) bits.push(`exit ${input.exitCode}`);
  else if (input.status === "error") bits.push(truncate(sanitizeText(input.summary ?? "").split("\n")[0] || "error", 60));
  if (input.durationMs !== undefined) bits.push(cardDuration(input.durationMs));
  const text = bits.join(" \u00b7 ") || "ok";
  const lines = [failed ? "  " + paint("err", `${g.branch} ${text}`, level) : "  " + dimmed(`${g.branch} ${text}`, level)];
  appendLinkage(lines, input, style);
  return lines;
}

/* ------------------------------- folded runs ------------------------------- */

export interface FoldItem {
  name: string;
  durationMs?: number;
}

/** Minimum run length that folds into one line. */
export const FOLD_MIN = 4;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `Read 5 files, Searched 2 patterns` (past tense, order of first appearance). */
export function foldLabel(items: readonly FoldItem[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const it of items) {
    const key = it.name === "ast_search" ? "grep" : it.name;
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order
    .map((key) => {
      const n = counts.get(key) ?? 0;
      switch (key) {
        case "read":
          return `Read ${plural(n, "file", "files")}`;
        case "grep":
          return `Searched ${plural(n, "pattern", "patterns")}`;
        case "glob":
          return `Globbed ${plural(n, "pattern", "patterns")}`;
        case "repo_map":
          return n === 1 ? "Mapped repo" : `Mapped repo ${n} times`;
        default:
          return `Ran ${plural(n, "tool", "tools")}`;
      }
    })
    .join(", ");
}

/** The single line a folded run commits as, with the total time right-aligned. */
function foldLineRaw(items: readonly FoldItem[], style: CardStyle): string {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const total = items.reduce((a, b) => a + (b.durationMs ?? 0), 0);
  const known = items.some((i) => i.durationMs !== undefined);
  const label = foldLabel(items);
  return withRight(
    (obj) => paint("ok", g.bullet, level) + " " + bld(obj, level),
    label,
    known ? cardDuration(total) : "",
    width,
    level,
  );
}

/* -------------------------------- subagents -------------------------------- */

/** Curly-quoted task, clamped to `max` columns: `“Map frontend project”`. */
export function quotedTask(task: string, max: number, unicode = true): string {
  const [l, r] = unicode ? ["\u201c", "\u201d"] : ['"', '"'];
  const clean = sanitizeText(task).replace(/\s+/g, " ").trim();
  return l + truncate(clean, Math.max(1, max - 2)) + r;
}

export interface SubagentLineInput {
  state: "running" | "completed" | "failed" | "cancelled";
  task: string;
  profile?: string;
  activity?: string;
  ms?: number;
  /** short failure reason for `failed` */
  reason?: string;
}

/** `◆ Subagent running: “task” · activity` / `◆ Subagent completed in 20s: “task”`. */
function subagentLineRaw(input: SubagentLineInput, style: CardStyle): string {
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const width = Math.max(20, Math.floor(style.width));
  const role: Role = input.state === "running" ? "accent" : input.state === "completed" ? "ok" : "err";
  const dur = input.ms !== undefined ? cardDuration(input.ms).replace(/^<0\.1s$/, "0s") : "";
  const head =
    input.state === "running"
      ? "running: "
      : input.state === "completed"
        ? `completed${dur ? " in " + dur : ""}: `
        : input.state === "failed"
          ? `failed${dur ? " in " + dur : ""}${input.reason ? ` (${truncate(sanitizeText(input.reason), 24)})` : ""}: `
          : `cancelled${dur ? " in " + dur : ""}: `;
  const tail = (input.activity ? ` \u00b7 ${sanitizeText(input.activity)}` : "") + (input.profile ? ` (${sanitizeText(input.profile)})` : "");
  const fixed = visibleWidth(g.bullet + " Subagent " + head + tail);
  const task = quotedTask(input.task, Math.max(8, width - fixed), style.unicode ?? true);
  const line = paint(role, g.bullet, level) + " " + bld("Subagent", level) + " " + dimmed(head, level) + task + dimmed(tail, level);
  return visibleWidth(line) > width ? truncate(strip(line), width) : line;
}

export interface GroupRow {
  state: "running" | "completed" | "failed";
  label: string;
  activity?: string;
  ms: number;
}

/** Most rows the live group shows before collapsing the rest. */
export const GROUP_ROW_CAP = 5;

/**
 * The live subagent group above the spinner: `▾ Subagents N` and one row per
 * subagent (`⠋ label · activity   2m14s`). Empty below 40 columns.
 * `spin` is the (already coloured) running glyph.
 */
function subagentGroupLinesRaw(rows: readonly GroupRow[], style: CardStyle, spin: string): string[] {
  const width = Math.floor(style.width);
  if (rows.length === 0 || width < 39) return [];
  const level = style.level ?? colorLevel();
  const g = glyphsFor(style.unicode ?? true);
  const out = [bld(g.open + " Subagents", level) + " " + dimmed(String(rows.length), level)];
  const shown = rows.slice(0, GROUP_ROW_CAP);
  for (const r of shown) {
    const glyph = r.state === "running" ? spin : r.state === "completed" ? paint("ok", g.ok, level) : paint("err", g.err, level);
    const time = cardDuration(r.ms).replace(/^<0\.1s$/, "0s");
    const right = time;
    const lead = "  " + glyph + " ";
    const act = r.activity ? ` \u00b7 ${sanitizeText(r.activity)}` : "";
    let label = sanitizeText(r.label);
    const build = (l: string): string => {
      const left = lead + l + dimmed(act, level);
      const gap = width - visibleWidth(left) - visibleWidth(right);
      return left + " ".repeat(Math.max(1, gap)) + dimmed(right, level);
    };
    let line = build(label);
    let guard = 0;
    while (visibleWidth(line) > width && guard++ < 200) {
      if (visibleWidth(label) > 8) label = truncate(label, visibleWidth(label) - Math.max(1, visibleWidth(line) - width));
      else {
        // The activity is the next thing to go.
        const keep = Math.max(0, width - visibleWidth(lead + label + right) - 2);
        line = lead + label + (keep > 3 ? dimmed(truncate(act, keep), level) : "") + " " + dimmed(right, level);
        break;
      }
      line = build(label);
    }
    out.push(line);
  }
  if (rows.length > shown.length) out.push("  " + dimmed(`${g.closed} show ${rows.length - shown.length} more`, level));
  return out;
}

/* --------------------- ASCII fallback and hard width clip --------------------- */

/** Same-width ASCII stand-ins for the few non-ASCII separators (user text is left alone). */
function ascii(line: string): string {
  return line.replace(/\u2026/g, "~").replace(/\u00b7/g, "-").replace(/[\u201c\u201d]/g, '"');
}

/** Final pass: ASCII glyphs for non-UTF-8 locales and a guarantee that no line exceeds the width. */
function finish(lines: string[], style: CardStyle): string[] {
  const width = Math.max(20, Math.floor(style.width));
  return lines.map((l) => {
    const out = style.unicode === false ? ascii(l) : l;
    return visibleWidth(out) > width ? truncate(strip(out), width, style.unicode === false ? "~" : "\u2026") : out;
  });
}

export const toolCardLines = (input: CardInput, style: CardStyle): string[] => finish(toolCardLinesRaw(input, style), style);
/** The result line printed under a header-first tool (edit, write, patch, agent). */
export const resultLine = (input: CardInput, style: CardStyle): string[] => finish(resultLineRaw(input, style), style);
/** `$ cmd` with a faint `$` and the command word highlighted; multi-line commands are folded. */
export const shellHeader = (command: string, style: CardStyle): string => finish([shellHeaderRaw(command, style)], style)[0] ?? "";
/** The output panel: first 2 lines, `\u2026 +N lines`, last 3; rows clipped to the width. */
export const shellOutputLines = (output: string, style: CardStyle): string[] => finish(shellOutputLinesRaw(output, style), style);
/** `  \u2514 exit 0 \u00b7 4.2s` (faint) or `  \u2514 exit 1 \u00b7 4.2s` (red). */
export const shellFooter = (input: Parameters<typeof shellFooterRaw>[0], style: CardStyle): string[] =>
  finish(shellFooterRaw(input, style), style);
/** The single line a folded run commits as, with the total time right-aligned. */
export const foldLine = (items: readonly FoldItem[], style: CardStyle): string => finish([foldLineRaw(items, style)], style)[0] ?? "";
/** `\u25c6 Subagent running: \u201ctask\u201d \u00b7 activity` / `\u25c6 Subagent completed in 20s: \u201ctask\u201d`. */
export const subagentLine = (input: SubagentLineInput, style: CardStyle): string => finish([subagentLineRaw(input, style)], style)[0] ?? "";
/** The live subagent group lines; `spin` is the (already coloured) running glyph. */
export const subagentGroupLines = (rows: readonly GroupRow[], style: CardStyle, spin: string): string[] => finish(subagentGroupLinesRaw(rows, style, spin), style);
