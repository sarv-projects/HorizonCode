/**
 * F-1 / F-3 residual: marked line-context excerpts for lint failures.
 *
 * Reduced form of aider's TreeContext render (█ on offending lines + neighbour
 * context). No tree-sitter dependency: the primary key is still the `path:line`
 * from the linter/LSP. On top of the plain ±context windows, a BEST-EFFORT
 * structural heuristic widens a window to a balanced `{}` / `[]` / `()` block
 * or to indentation/dedent boundaries when the source actually has that
 * structure. This is structural only - NOT a tree-sitter ERROR-node window.
 * True grammar-aware TreeContext remains owner-blocked by the zero-runtime-
 * dependency rule (docs/FULL-BACKLOG §Z; docs/30; ast-match.ts / repo-map.ts).
 */

/** Neighbour lines above/below each error (aider default). */
export const LINT_EXCERPT_CONTEXT = 3;

/** Offending-line marker (aider TreeContext). */
export const LINT_EXCERPT_MARK = "█";

/** Cap distinct excerpt windows so a noisy linter cannot flood the prompt. */
export const LINT_EXCERPT_MAX_WINDOWS = 8;

/** Hard character budget for the excerpt block (after the diagnostic list). */
export const LINT_EXCERPT_MAX_CHARS = 4_000;

/** Max lines a structural (block-aware) window may span. */
export const LINT_EXCERPT_STRUCTURAL_MAX_SPAN = 40;

/** How far the indentation heuristic walks up/down from an indented error line. */
export const LINT_EXCERPT_STRUCTURAL_INDENT_LOOKBACK = 6;

const ERROR_LINE_RE = /:(\d+)(?::\d+)?\s+error\b/i;

/** Collect unique 1-based error line numbers from formatted diagnostic lines. */
export function lintErrorLinesFromMessages(messages: readonly string[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const message of messages) {
    const m = ERROR_LINE_RE.exec(message);
    if (m === null) continue;
    const line = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(line) || line < 1 || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** Collect unique 1-based lines from structured findings. */
export function lintErrorLinesFromFindings(
  findings: readonly { line: number }[],
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const f of findings) {
    if (!Number.isFinite(f.line) || f.line < 1 || seen.has(f.line)) continue;
    seen.add(f.line);
    out.push(f.line);
  }
  return out;
}

interface Window {
  start: number; // 1-based inclusive
  end: number; // 1-based inclusive
  marks: Set<number>;
}

type DelimChar = "{" | "[" | "(";

interface DelimSpan {
  ch: DelimChar;
  line: number; // 1-based opening line
  closeLine: number; // 1-based closing line (EOF for unclosed opens)
}

/**
 * Scan balanced delimiters with a tiny state machine that ignores delimiters
 * inside strings, template literals and comments. Best-effort only: mismatched
 * closers are skipped and unclosed opens extend to EOF (bounded later by the
 * span cap). This is NOT a parser.
 */
function scanDelimiterSpans(lines: readonly string[]): DelimSpan[] {
  const stack: { ch: DelimChar; line: number }[] = [];
  const spans: DelimSpan[] = [];
  let inBlockComment = false;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li]!;
    let state: "code" | "single" | "double" | "template" = "code";
    let escaped = false;
    for (let ci = 0; ci < text.length; ci++) {
      const ch = text[ci]!;
      if (inBlockComment) {
        if (ch === "*" && text[ci + 1] === "/") {
          inBlockComment = false;
          ci++;
        }
        continue;
      }
      if (state === "code") {
        if (ch === "/" && text[ci + 1] === "/") break; // line comment
        if (ch === "/" && text[ci + 1] === "*") {
          inBlockComment = true;
          ci++;
          continue;
        }
        if (ch === "'") {
          state = "single";
          continue;
        }
        if (ch === '"') {
          state = "double";
          continue;
        }
        if (ch === "`") {
          state = "template";
          continue;
        }
        if (ch === "{" || ch === "[" || ch === "(") {
          stack.push({ ch, line: li + 1 });
          continue;
        }
        if (ch === "}" || ch === "]" || ch === ")") {
          const want: DelimChar = ch === "}" ? "{" : ch === "]" ? "[" : "(";
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k]!.ch === want) {
              const open = stack[k]!;
              stack.splice(k, 1);
              spans.push({ ch: open.ch, line: open.line, closeLine: li + 1 });
              break;
            }
          }
        }
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (ch === quote) state = "code";
    }
    escaped = false;
  }
  for (const open of stack) {
    spans.push({ ch: open.ch, line: open.line, closeLine: lines.length });
  }
  return spans;
}

function indentWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Best-effort structural window for one error line. Starts from the plain
 * ±context window and only grows when real structure is present:
 *   1. the outermost enclosing balanced delimiter span that still fits the
 *      span cap - e.g. the whole function body;
 *   2. otherwise, for an indented error line, a same-indentation run bounded
 *      by the nearest dedent (the enclosing block opener/closer).
 *
 * Top-level, unindented lines with no braces keep the plain context window, so
 * the reduced behaviour is unchanged for flat sources.
 */
export function lintExcerptStructuralWindow(
  lines: readonly string[],
  line: number,
  opts?: {
    context?: number;
    spans?: readonly DelimSpan[];
    lookback?: number;
    maxSpan?: number;
  },
): { start: number; end: number } {
  const context = opts?.context ?? LINT_EXCERPT_CONTEXT;
  const maxSpan = opts?.maxSpan ?? LINT_EXCERPT_STRUCTURAL_MAX_SPAN;
  const lookback = opts?.lookback ?? LINT_EXCERPT_STRUCTURAL_INDENT_LOOKBACK;
  const lineCount = lines.length;
  let start = Math.max(1, line - context);
  let end = Math.min(lineCount, line + context);

  const spans = opts?.spans ?? scanDelimiterSpans(lines);
  let enclosing: DelimSpan | undefined;
  for (const span of spans) {
    if (
      span.line <= line &&
      span.closeLine >= line &&
      span.closeLine - span.line <= maxSpan
    ) {
      if (enclosing === undefined || span.line < enclosing.line) enclosing = span;
    }
  }

  if (enclosing !== undefined) {
    start = Math.min(start, enclosing.line);
    end = Math.max(end, enclosing.closeLine);
  } else {
    const base = indentWidth(lines[line - 1] ?? "");
    if (base > 0) {
      let s = line;
      for (let j = line - 1; j >= 1 && line - j < lookback; j--) {
        if ((lines[j - 1] ?? "").trim() === "") continue;
        const ij = indentWidth(lines[j - 1]!);
        s = j;
        if (ij < base) break; // include the dedented opener
      }
      start = Math.min(start, s);

      let e = line;
      for (let j = line + 1; j <= lineCount && j - line < lookback; j++) {
        if ((lines[j - 1] ?? "").trim() === "") continue;
        if (indentWidth(lines[j - 1]!) < base) break;
        e = j;
      }
      end = Math.max(end, e);
    }
  }

  if (end - start + 1 > maxSpan) {
    start = Math.max(start, line - Math.floor(maxSpan / 2));
    end = Math.min(start + maxSpan - 1, lineCount);
  }
  return { start: Math.max(1, start), end: Math.min(lineCount, end) };
}

function mergeWindows(
  errorLines: readonly number[],
  context: number,
  lineCount: number,
  lines: readonly string[],
  structural: boolean,
): Window[] {
  const sorted = [...errorLines].filter((n) => n >= 1 && n <= lineCount).sort((a, b) => a - b);
  const spans = structural ? scanDelimiterSpans(lines) : [];
  const windows: Window[] = [];
  for (const line of sorted) {
    const resolved = structural
      ? lintExcerptStructuralWindow(lines, line, { context, spans })
      : { start: Math.max(1, line - context), end: Math.min(lineCount, line + context) };
    const { start, end } = resolved;
    const last = windows[windows.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.marks.add(line);
    } else {
      windows.push({ start, end, marks: new Set([line]) });
    }
  }
  return windows.slice(0, LINT_EXCERPT_MAX_WINDOWS);
}

/**
 * Render marked source windows around error lines.
 * Returns `""` when there is nothing useful to show.
 *
 * `opts.structural` defaults to true: windows grow to enclosing blocks/dedents
 * when present. Pass `structural: false` for the original strict ±context view.
 */
export function renderMarkedLintExcerpt(
  source: string,
  errorLines: readonly number[],
  opts?: { context?: number; mark?: string; maxChars?: number; structural?: boolean },
): string {
  if (errorLines.length === 0) return "";
  const lines = source.split(/\r?\n/);
  // Trailing empty from a final newline is not a source line for numbering.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";

  const context = opts?.context ?? LINT_EXCERPT_CONTEXT;
  const mark = opts?.mark ?? LINT_EXCERPT_MARK;
  const maxChars = opts?.maxChars ?? LINT_EXCERPT_MAX_CHARS;
  const structural = opts?.structural ?? true;
  const windows = mergeWindows(errorLines, context, lines.length, lines, structural);
  if (windows.length === 0) return "";

  const width = String(lines.length).length;
  const out: string[] = ["--- lint excerpt ---"];
  let truncated = false;

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi]!;
    if (wi > 0) out.push("⋯");
    for (let n = w.start; n <= w.end; n++) {
      const body = lines[n - 1] ?? "";
      const gutter = String(n).padStart(width, " ");
      const prefix = w.marks.has(n) ? `${mark} ${gutter}|` : `  ${gutter}|`;
      const row = `${prefix}${body}`;
      const next = out.join("\n") + "\n" + row;
      if (next.length > maxChars) {
        truncated = true;
        break;
      }
      out.push(row);
    }
    if (truncated) break;
  }

  if (truncated) out.push("… [lint excerpt truncated]");
  return out.join("\n");
}

/** Append a marked excerpt block when diagnostics carry line numbers. */
export function withLintExcerpts(
  header: string,
  source: string,
  errorLines: readonly number[],
): string {
  const excerpt = renderMarkedLintExcerpt(source, errorLines);
  if (excerpt === "") return header;
  return `${header}\n\n${excerpt}`;
}
