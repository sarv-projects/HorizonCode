/**
 * Codex-shaped exec output for model-facing shell tools (docs/30 §5.3 codex row).
 * Shared by `shell` and `shell_session` so wall-time / line-count headers stay aligned.
 */

/** 0.1s-rounded wall time string, e.g. 1234ms → "1.2". */
export function wallSeconds(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

export interface ExecOutputFormatInput {
  exitCode: number | null;
  signalCode?: string | null;
  wallMs: number;
  /** Model-visible body (minimised / truncated text, without legacy `exit N` tail). */
  body: string;
  /** True when output was capped (char buffer or explicit truncate), not merely empty. */
  outputTruncated: boolean;
}

/** `Exit code` / `Signal`, `Wall time`, optional `Total output lines`, then `Output:` + body. */
export function formatExecOutputForModel(input: ExecOutputFormatInput): string {
  const lines: string[] = [];
  if (input.signalCode) lines.push(`Signal: ${input.signalCode}`);
  else lines.push(`Exit code: ${input.exitCode === null ? "null" : input.exitCode}`);
  lines.push(`Wall time: ${wallSeconds(input.wallMs)}s`);
  if (input.outputTruncated) {
    const count = input.body === "" ? 0 : input.body.split("\n").length;
    lines.push(`Total output lines: ${count}`);
  }
  lines.push("Output:");
  lines.push(input.body);
  return lines.join("\n");
}
