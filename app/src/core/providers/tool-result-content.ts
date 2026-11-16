/**
 * H-5 provider-shape util (ruling **495**): normalize an empty tool result to
 * the non-empty placeholder every adapter replays. Before this util the same
 * inline expression appeared in four adapters (openai / anthropic / google /
 * ollama message builders):
 *
 *   msg.content && msg.content !== "" ? msg.content : "(no output)"
 *
 * The placeholder is a documented wire sentinel — `cacheable-messages-prefix.ts`
 * already treats "(no output)" as an empty result. Pure, no loop, no I/O; kept
 * outside adapter SSE loops (same H-5 posture as rulings 67 / 199 / 469 / 477).
 */

/** Wire sentinel used when a tool produced no text. */
export const NO_TOOL_OUTPUT = "(no output)";

/** Non-empty string → itself; empty / missing / non-string → sentinel. */
export function toolResultContent(raw: unknown): string {
  return typeof raw === "string" && raw !== "" ? raw : NO_TOOL_OUTPUT;
}
