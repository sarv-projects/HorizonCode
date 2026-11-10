/**
 * markdown.ts — zero-dependency streaming markdown for the chat (TTY only).
 *
 * `createMarkdownStream` is a pure line-oriented state machine: push model text
 * in any chunking, get back ready-to-write ANSI text. A finished line is
 * rendered once and never touched again, so cost per token is bounded and the
 * output is independent of where the chunks split (fuzz-tested). The unfinished
 * trailing line is held until its newline, or released as plain text by
 * `flushPartial()` when it cannot be a block opener or carry open inline markers.
 *
 * Supported: headings, **bold**, *italic*, ~~strike~~, `code`, links, bullet,
 * numbered and task lists, block quotes, rules, pipe tables that fit, and fenced
 * code blocks with a small per-language highlighter on a panel background.
 * Prose is not re-wrapped: the terminal soft-wraps it, which keeps copy/paste
 * clean. Callers must pass text through `sanitizeText` first; the only escape
 * sequences in the output are the ones produced here.
 */

import { bgCode, colorLevel, fgCode, onBg, visibleWidth, type ColorLevel, type Role } from "./style";

export interface MarkdownOptions {
  /** columns available (callers leave the last one free) */
  width: number;
  level?: ColorLevel;
  unicode?: boolean;
  /** emit OSC 8 hyperlinks (see `hyperlinksEnabled`) */
  hyperlinks?: boolean;
}

export interface MarkdownStream {
  /** Feed text; returns the rendered completed lines (each ends with a newline). */
  push(chunk: string): string;
  /** Plain text of the pending partial line when it is safe to show early, else "". */
  flushPartial(): string;
  /** Finish: render whatever is pending as a complete line (no trailing newline guarantee beyond `\n`). */
  end(): string;
  /** True when a partial line has been shown early and its newline has not arrived. */
  readonly midLine: boolean;
}

/** OSC 8 only where it is known to work (or when asked for with HZ_HYPERLINKS=1). */
export function hyperlinksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.HZ_HYPERLINKS === "1") return true;
  if (env.HZ_HYPERLINKS === "0") return false;
  return ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "") || Boolean(env.KITTY_WINDOW_ID);
}

const ESC = "\u001b[";

/* ------------------------------- inline ------------------------------- */

export interface MdCtx {
  level: ColorLevel;
  unicode: boolean;
  hyperlinks: boolean;
}

/** SGR run that sets bold/colour and closes with targeted resets so outer styles survive. */
function run(open: string, close: string, text: string, level: ColorLevel): string {
  if (level === 0 || text === "") return text;
  return `${ESC}${open}m${text}${ESC}${close}m`;
}

const fgRun = (role: Role, text: string, c: MdCtx, extra = ""): string => {
  if (c.level === 0) return text;
  const code = fgCode(role, c.level);
  const open = [extra, code].filter((x) => x !== "").join(";");
  return open === "" ? text : `${ESC}${open}m${text}${ESC}22;23;24;29;39m`;
};

function findClose(s: string, from: number, marker: string): number {
  let i = from;
  while (i < s.length) {
    const at = s.indexOf(marker, i);
    if (at === -1) return -1;
    if (at > from) return at;
    i = at + 1;
  }
  return -1;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Inline markdown to styled text. Unmatched markers stay literal. */
export function renderInline(s: string, c: MdCtx): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "\\" && i + 1 < s.length && /[\\`*_~\[\]()#>+\-.!|]/.test(s[i + 1] as string)) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > i + n) {
        const inner = s.slice(i + n, end).replace(/^ (.*) $/, "$1");
        out += fgRun("code", inner, c, "1");
        i = end + n;
        continue;
      }
    }
    if (ch === "*" && s[i + 1] === "*" && s[i + 2] !== " " && i + 2 < s.length) {
      const end = findClose(s, i + 2, "**");
      if (end !== -1 && s[end - 1] !== " ") {
        out += run("1", "22", renderInline(s.slice(i + 2, end), c), c.level);
        i = end + 2;
        continue;
      }
    }
    if (ch === "~" && s[i + 1] === "~" && s[i + 2] !== " ") {
      const end = findClose(s, i + 2, "~~");
      if (end !== -1) {
        out += run("9", "29", renderInline(s.slice(i + 2, end), c), c.level);
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] !== " " && s[i + 1] !== ch && i + 1 < s.length) {
      const leftOk = ch === "*" || !isWordChar(s[i - 1]);
      if (leftOk) {
        const end = findClose(s, i + 1, ch);
        if (end !== -1 && s[end - 1] !== " " && s[end + 1] !== ch && (ch === "*" || !isWordChar(s[end + 1]))) {
          out += run("3", "23", renderInline(s.slice(i + 1, end), c), c.level);
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        const label = renderInline(m[1] as string, c);
        const url = m[2] as string;
        let shown = fgRun("link", label, c, "4");
        if (c.hyperlinks && /^https?:\/\//.test(url)) shown = `\u001b]8;;${url}\u001b\\${shown}\u001b]8;;\u001b\\`;
        out += shown + (m[1] === url ? "" : run("2", "22", ` (${url})`, c.level));
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Re-open `open` after every targeted reset so an outer style survives inner runs. */
function keepStyle(text: string, open: string, level: ColorLevel): string {
  if (level === 0 || text === "") return text;
  const reopened = text.split(`${ESC}22m`).join(`${ESC}22m${ESC}${open}m`).split(`${ESC}22;23;24;29;39m`).join(`${ESC}22;23;24;29;39m${ESC}${open}m`);
  return `${ESC}${open}m${reopened}${ESC}0m`;
}

/* ------------------------------ highlighter ------------------------------ */

const KEYWORDS: Record<string, Set<string>> = {
  js: new Set("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof of in this super null undefined true false interface type enum implements public private protected readonly static as void yield".split(" ")),
  py: new Set("def class return if elif else for while in not and or is import from as with try except finally raise lambda pass break continue yield None True False async await global nonlocal assert del".split(" ")),
  sh: new Set("if then else elif fi for while do done case esac function in echo export local return exit cd set unset source".split(" ")),
  rs: new Set("fn let mut const static struct enum impl trait pub use mod crate self Self match if else for while loop return break continue as in where move async await dyn ref type unsafe true false".split(" ")),
  go: new Set("func var const type struct interface package import return if else for range switch case default break continue go defer chan map select nil true false".split(" ")),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
  toml: new Set(["true", "false"]),
  json: new Set(["true", "false", "null"]),
};

const FAMILY: Record<string, string> = {
  js: "js", jsx: "js", ts: "js", tsx: "js", javascript: "js", typescript: "js", mjs: "js", cjs: "js",
  json: "json", jsonc: "json", py: "py", python: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh",
  rs: "rs", rust: "rs", go: "go", golang: "go", yaml: "yaml", yml: "yaml", toml: "toml", diff: "diff", patch: "diff",
};

const COMMENT: Record<string, RegExp | undefined> = {
  js: /^\/\/.*/, rs: /^\/\/.*/, go: /^\/\/.*/, py: /^#.*/, sh: /^#.*/, yaml: /^#.*/, toml: /^#.*/,
};

/** Colour one code line by language family; unknown languages come back plain. */
export function highlight(lang: string, line: string, c: MdCtx): string {
  const fam = FAMILY[lang.toLowerCase()];
  if (c.level === 0 || fam === undefined) return line;
  if (fam === "diff") {
    if (line.startsWith("+++") || line.startsWith("---")) return fgRun("muted", line, c);
    if (line.startsWith("@@")) return fgRun("info", line, c);
    if (line.startsWith("+")) return fgRun("ok", line, c);
    if (line.startsWith("-")) return fgRun("err", line, c);
    return line;
  }
  const kw = KEYWORDS[fam] ?? new Set<string>();
  const comment = COMMENT[fam];
  let out = "";
  let rest = line;
  while (rest.length > 0) {
    let m: RegExpExecArray | null;
    if (comment && (m = comment.exec(rest))) {
      out += fgRun("muted", m[0], c, "3");
    } else if ((m = /^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/.exec(rest))) {
      out += fgRun("ok", m[0], c);
    } else if ((m = /^\d[\d_.xa-fA-F]*/.exec(rest))) {
      out += fgRun("warn", m[0], c);
    } else if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
      const word = m[0];
      const after = rest[word.length];
      if (kw.has(word)) out += fgRun("accent", word, c);
      else if (after === "(") out += fgRun("info", word, c);
      else if (/^[A-Z]/.test(word) && fam !== "sh") out += fgRun("info", word, c);
      else out += word;
    } else {
      m = /^[^A-Za-z_$"'`\d#/]+|^./s.exec(rest) as RegExpExecArray;
      out += m[0];
    }
    rest = rest.slice((m as RegExpExecArray)[0].length);
  }
  return out;
}

/* -------------------------------- tables -------------------------------- */

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (t[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Box table when it fits `width`; otherwise the raw rows, dim. */
export function renderTable(rows: string[], width: number, c: MdCtx): string[] {
  const sepAt = rows.findIndex((r, i) => i > 0 && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(r));
  const raw = (): string[] => rows.map((r) => run("2", "22", r, c.level));
  if (sepAt !== 1) return raw();
  const cells = rows.filter((_, i) => i !== 1).map(splitRow);
  const cols = Math.max(...cells.map((r) => r.length));
  const styled = cells.map((r, ri) =>
    Array.from({ length: cols }, (_, ci) => {
      const inner = renderInline(r[ci] ?? "", c);
      return ri === 0 ? run("1", "22", inner, c.level) : inner;
    }),
  );
  const widths = Array.from({ length: cols }, (_, ci) => Math.max(1, ...styled.map((r) => visibleWidth(r[ci] ?? ""))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * cols + 1;
  if (total > width) return raw();
  const u = c.unicode;
  const ch = u
    ? { h: "\u2500", v: "\u2502", tl: "\u250c", tm: "\u252c", tr: "\u2510", ml: "\u251c", mm: "\u253c", mr: "\u2524", bl: "\u2514", bm: "\u2534", br: "\u2518" }
    : { h: "-", v: "|", tl: "+", tm: "+", tr: "+", ml: "+", mm: "+", mr: "+", bl: "+", bm: "+", br: "+" };
  const rule = (l: string, m: string, r: string): string => run("2", "22", l + widths.map((w) => ch.h.repeat(w + 2)).join(m) + r, c.level);
  const bar = run("2", "22", ch.v, c.level);
  const fmt = (r: string[]): string =>
    bar + r.map((cell, i) => " " + cell + " ".repeat((widths[i] as number) - visibleWidth(cell)) + " ").join(bar) + bar;
  return [rule(ch.tl, ch.tm, ch.tr), fmt(styled[0] as string[]), rule(ch.ml, ch.mm, ch.mr), ...styled.slice(1).map(fmt), rule(ch.bl, ch.bm, ch.br)];
}

/* ------------------------------ the stream ------------------------------ */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|?\s*$/;

/** A pending partial that may still become a block opener or hold an open inline marker. */
const BLOCK_START = /^\s*([`#>|~]|[-*+]\s|\d+[.)]|[-*_]{2})/;
const INLINE_MARK = /[*_`~\[\\]/;

export function createMarkdownStream(opts: MarkdownOptions): MarkdownStream {
  const c: MdCtx = {
    level: opts.level ?? colorLevel(),
    unicode: opts.unicode ?? true,
    hyperlinks: opts.hyperlinks ?? hyperlinksEnabled(),
  };
  const width = Math.max(20, Math.floor(opts.width));
  let pending = "";
  /** how much of `pending` was already written by flushPartial */
  let shown = 0;
  let fence: { mark: string; lang: string } | undefined;
  let table: string[] = [];
  let lastBlank = true;

  const emitCode = (line: string, lang: string): string => {
    const g = c.unicode ? "\u258e" : "|";
    const clip = Math.max(8, width - 4);
    const text = line.replace(/\t/g, "  ");
    const pieces: string[] = [];
    for (let at = 0; at === 0 || at < text.length; at += clip) pieces.push(text.slice(at, at + clip));
    return pieces
      .map((piece) => {
        const body = highlight(lang, piece, c);
        if (bgCode("bgPanel", c.level) !== "") return onBg("bgPanel", "  " + body, width, c.level) + "\n";
        return "  " + run("2", "22", g, c.level) + " " + body + "\n";
      })
      .join("");
  };

  const flushTable = (): string => {
    if (table.length === 0) return "";
    const rows = table;
    table = [];
    lastBlank = false;
    return renderTable(rows, width, c).join("\n") + "\n";
  };

  const renderLine = (raw: string): string => {
    // Inside a fence everything is code until the closing fence.
    if (fence) {
      const close = FENCE.exec(raw);
      if (close && close[1]?.[0] === fence.mark[0] && (close[1] as string).length >= fence.mark.length && (close[2] ?? "") === "") {
        fence = undefined;
        return "";
      }
      lastBlank = false;
      return emitCode(raw, fence.lang);
    }
    if (TABLE_ROW.test(raw) && raw.includes("|") && raw.trim().length > 1) {
      table.push(raw);
      return "";
    }
    let out = flushTable();
    const open = FENCE.exec(raw);
    if (open) {
      fence = { mark: open[1] as string, lang: open[2] ?? "" };
      if (fence.lang !== "" && bgCode("bgPanel", c.level) !== "" && width >= 60) {
        out += "  " + run("2", "22", (c.unicode ? "\u256d\u2500 " : "+- ") + fence.lang, c.level) + "\n";
      }
      lastBlank = false;
      return out;
    }
    if (raw.trim() === "") {
      lastBlank = true;
      return out + "\n";
    }
    const h = HEADING.exec(raw);
    if (h) {
      const level = (h[1] as string).length;
      const role: Role = level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "muted";
      const sgr = [("1"), fgCode(role, c.level)].filter((x) => x !== "").join(";");
      const text = keepStyle(renderInline(h[2] as string, c), sgr, c.level);
      const lead = level <= 2 && !lastBlank ? "\n" : "";
      lastBlank = false;
      return out + lead + (c.level === 0 ? text : text) + "\n";
    }
    if (RULE.test(raw)) {
      lastBlank = false;
      return out + run("2", "22", (c.unicode ? "\u2500" : "-").repeat(Math.min(width, 60)), c.level) + "\n";
    }
    const q = QUOTE.exec(raw);
    if (q) {
      lastBlank = false;
      const bar = run("2", "22", c.unicode ? "\u2502 " : "| ", c.level);
      return out + bar + keepStyle(renderInline(q[1] as string, c), "2", c.level) + "\n";
    }
    const b = BULLET.exec(raw);
    if (b) {
      lastBlank = false;
      let body = b[2] as string;
      let mark = c.unicode ? "\u2022" : "*";
      const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
      if (task) {
        const done = task[1] !== " ";
        mark = c.unicode ? (done ? "\u2611" : "\u2610") : done ? "[x]" : "[ ]";
        body = task[2] as string;
        return out + (b[1] as string) + "  " + (done ? fgRun("ok", mark, c) : run("2", "22", mark, c.level)) + " " + renderInline(body, c) + "\n";
      }
      return out + (b[1] as string) + "  " + run("2", "22", mark, c.level) + " " + renderInline(body, c) + "\n";
    }
    const n = NUMBERED.exec(raw);
    if (n) {
      lastBlank = false;
      return out + (n[1] as string) + "  " + run("2", "22", `${n[2]}.`, c.level) + " " + renderInline(n[3] as string, c) + "\n";
    }
    lastBlank = false;
    return out + renderInline(raw, c) + "\n";
  };

  const takeLines = (text: string): string => {
    pending += text;
    let out = "";
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      const already = shown;
      pending = pending.slice(nl + 1);
      shown = 0;
      if (already > 0) {
        // The head of this line is already on screen as plain text: finish it the same way.
        out += renderInline(line.slice(already), c) + "\n";
        lastBlank = false;
      } else out += renderLine(line);
    }
    return out;
  };

  return {
    push(chunk) {
      return takeLines(chunk);
    },
    flushPartial() {
      if (fence || table.length > 0 || pending === "") return "";
      if (shown === 0 && BLOCK_START.test(pending)) return "";
      // Release whole words up to the first inline marker, never past it.
      const mark = pending.slice(shown).search(INLINE_MARK);
      const upto = mark === -1 ? pending.length : shown + mark;
      const at = pending.lastIndexOf(" ", upto - 1);
      if (at < shown) return "";
      const text = pending.slice(shown, at + 1);
      shown = at + 1;
      return text;
    },
    end() {
      let out = "";
      if (pending !== "" || shown > 0) {
        const line = pending.replace(/\r$/, "");
        const already = shown;
        pending = "";
        shown = 0;
        out += already > 0 ? renderInline(line.slice(already), c) + "\n" : renderLine(line);
      }
      out += flushTable();
      fence = undefined;
      lastBlank = true;
      return out;
    },
    get midLine() {
      return shown > 0;
    },
  };
}
