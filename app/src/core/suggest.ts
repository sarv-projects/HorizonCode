/**
 * suggest.ts — `hzcode suggest` (forgecode T-16 second half, docs/33 §5.16).
 *
 * One model turn, no tools: print a shell command suggestion, never execute it.
 */

import { sanitizeText } from "../tui/style";

export function suggestPrompt(request: string): string {
  const task = sanitizeText(request).trim();
  return [
    "Suggest exactly one shell command to accomplish the task below.",
    "Reply with only the command on a single line. No code fences, no quotes, no explanation.",
    "Do not call any tool.",
    "",
    task === "" ? "(no task given)" : task,
  ].join("\n");
}

/** Strip fences and normalize a one-line command suggestion. */
export function cleanSuggestedCommand(raw: string): string {
  let text = sanitizeText(raw).trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.replace(/\s+/g, " ");
}
