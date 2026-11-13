/**
 * transcript.ts — session history export for /transcript pager (docs/13 D9 reduced).
 */

import type { ChatMsg } from "../contracts";

export function formatTranscriptPlain(messages: readonly ChatMsg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role ?? "unknown";
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    lines.push(`## ${role}`);
    lines.push(text.trimEnd());
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
