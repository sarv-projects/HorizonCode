/**
 * truncated-tool-batch.ts — Pi pattern for assistant turns truncated by max_tokens.
 *
 * When the provider stop reason is length/max_tokens, every tool call in that
 * turn may carry truncated arguments. None are safe to execute; fail them all
 * with a uniform error the model can read (Pi `failToolCallsFromTruncatedMessage`).
 */

/** Model-visible error when a tool call was skipped due to output truncation. */
export function truncatedToolCallMessage(toolName: string): string {
  return (
    `Tool call "${toolName}" was not executed: the response hit the output token limit, `
    + "so its arguments may be truncated. Re-issue the tool call with complete arguments."
  );
}
