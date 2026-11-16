/**
 * F-1 / F-3 residual: marked line-context excerpts for lint failures.
 *
 * Reduced form of aider's TreeContext render (█ on offending lines + neighbour
 * context). No tree-sitter dependency — windows are keyed by `path:line` from
 * the linter/LSP, not by AST ERROR nodes.
 */

/** Neighbour lines above/below each error (aider default). */
export const LINT_EXCERPT_CONTEXT = 3;

/** Offending-line marker (aider TreeContext). */
export const LINT_EXCERPT_MARK = "█";

/** Cap distinct excerpt windows so a noisy linter cannot flood the prompt. */
export const LINT_EXCERPT_MAX_WINDOWS = 8;

/** Hard character budget for the excerpt block (after the diagnostic list). */
export const LINT_EXCERPT_MAX_CHARS = 4_000;

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

function mergeWindows(errorLines: readonly number[], context: number, lineCount: number): Window[] {
  const sorted = [...errorLines].filter((n) => n >= 1 && n <= lineCount).sort((a, b) => a - b);
  const windows: Window[] = [];
  for (const line of sorted) {
    const start = Math.max(1, line - context);
    const end = Math.min(lineCount, line + context);
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
 */
export function renderMarkedLintExcerpt(
  source: string,
  errorLines: readonly number[],
  opts?: { context?: number; mark?: string; maxChars?: number },
): string {
  if (errorLines.length === 0) return "";
  const lines = source.split(/\r?\n/);
  // Trailing empty from a final newline is not a source line for numbering.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";

  const context = opts?.context ?? LINT_EXCERPT_CONTEXT;
  const mark = opts?.mark ?? LINT_EXCERPT_MARK;
  const maxChars = opts?.maxChars ?? LINT_EXCERPT_MAX_CHARS;
  const windows = mergeWindows(errorLines, context, lines.length);
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
