/**
 * output-minimizer.ts — declarative shell-output minimizer filters
 * (oh-my-pi pi-shell minimizer defs ADAPT).
 *
 * A data-driven filter set: each filter matches a command (regex over the
 * command string), then applies ANSI stripping, per-line truncation and a row
 * cap. Pure — no shell spawn, no I/O, no authority. Unmatched commands and
 * empty output pass through byte-identically.
 */

export interface MinimizerFilter {
  id: string;
  match: RegExp;
  stripAnsi?: boolean;
  truncateLinesAt?: number;
  maxLines?: number;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function applyFilter(output: string, f: MinimizerFilter): string {
  let text = f.stripAnsi === true ? output.replace(ANSI, "") : output;
  if (f.truncateLinesAt !== undefined && f.truncateLinesAt > 0) {
    text = text
      .split("\n")
      .map((line) => (line.length > f.truncateLinesAt! ? line.slice(0, f.truncateLinesAt!) : line))
      .join("\n");
  }
  if (f.maxLines !== undefined && f.maxLines > 0) {
    const lines = text.split("\n");
    if (lines.length > f.maxLines) text = lines.slice(0, f.maxLines).join("\n");
  }
  return text;
}

/** Minimise `output` by the first matching filter; unchanged when none match. */
export function minimiseOutput(command: string, output: string, filters: readonly MinimizerFilter[]): string {
  if (output === "" || filters.length === 0) return output;
  const cmd = command.trim();
  const f = filters.find((x) => x.match.test(cmd));
  return f === undefined ? output : applyFilter(output, f);
}

export class OutputMinimizer {
  constructor(private readonly filters: readonly MinimizerFilter[]) {}
  apply(command: string, output: string): string {
    return minimiseOutput(command, output, this.filters);
  }
  applied(command: string, output: string): boolean {
    return output !== "" && this.filters.some((f) => f.match.test(command.trim()));
  }
}
