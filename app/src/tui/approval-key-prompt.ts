/**
 * Single-key approval prompt context (rich TTY): initial card + optional live refresh.
 */

export type ApprovalKeyPromptObject = {
  lines: readonly string[];
  screenRows?: number;
  onTick?: () => readonly string[];
};

export type ApprovalKeyPrompt = readonly string[] | ApprovalKeyPromptObject;

export const APPROVAL_GRANT_TICK_MS = 1000;

export function approvalCardScreenRows(lineCount: number): number {
  return Math.max(1, lineCount) + 1;
}

export function isApprovalKeyPromptObject(
  prompt: ApprovalKeyPrompt,
): prompt is ApprovalKeyPromptObject {
  return !Array.isArray(prompt);
}

export function normalizeApprovalKeyPrompt(prompt: ApprovalKeyPrompt): {
  lines: string[];
  screenRows: number;
  onTick?: () => string[];
} {
  if (Array.isArray(prompt)) {
    const lines = [...prompt];
    return { lines, screenRows: approvalCardScreenRows(lines.length) };
  }
  const obj = prompt as ApprovalKeyPromptObject;
  const lines = [...obj.lines];
  const screenRows = obj.screenRows ?? approvalCardScreenRows(lines.length);
  const tick = obj.onTick;
  const onTick = tick ? () => [...tick()] : undefined;
  return { lines, screenRows, onTick };
}

/** Erase `screenRows` above the cursor and rewrite the approval card block. */
export function refreshApprovalCardAboveCursor(
  write: (chunk: string) => void,
  screenRows: number,
  lines: string[],
): void {
  if (screenRows <= 0 || lines.length === 0) return;
  write(`\x1b[${screenRows}A`);
  for (const line of lines) {
    write(`\x1b[2K\r${line}\n`);
  }
  write("\x1b[2K\r\n");
}