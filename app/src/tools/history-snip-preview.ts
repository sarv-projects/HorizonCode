/**
 * history-snip-preview.ts — Group D pure deferred history_snip_preview tool.
 *
 * An HONEST reduced form of claude-code's SnipTool: given text supplied in the
 * arguments, it previews what snipping the middle would look like (keep first N
 * and last M lines, insert a `[snipped X chars / Y lines]` marker). It NEVER
 * touches conversation state — no transcript mutation, no guard, no receipt,
 * no filesystem. The vendored claude-code tree has no SnipTool source and its
 * snipProjection/snipCompact JS is absent, so this is a from-scratch reduced
 * preview, not a claim of a full port. Prompt/material only.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";

export interface SnipPreviewResult {
  preview: string;
  snippedChars: number;
  snippedLines: number;
}

/** Pure: keep the first `keepFirst` and last `keepLast` lines, mark the middle. */
export function snipPreview(text: string, keepFirst: number, keepLast: number): SnipPreviewResult {
  const lines = text.split("\n");
  const first = Math.max(0, Math.floor(keepFirst));
  const last = Math.max(0, Math.floor(keepLast));
  if (first + last >= lines.length) {
    return { preview: text, snippedChars: 0, snippedLines: 0 };
  }
  const head = lines.slice(0, first);
  const tail = lines.slice(lines.length - last);
  const middle = lines.slice(first, lines.length - last);
  const snippedChars = middle.reduce((n, line, i) => n + line.length + (i < middle.length - 1 ? 1 : 0), 0);
  const marker = `[snipped ${snippedChars} chars / ${middle.length} lines]`;
  return {
    preview: [...head, marker, ...tail].join("\n"),
    snippedChars,
    snippedLines: middle.length,
  };
}

export const historySnipPreviewTool: Tool = {
  name: "history_snip_preview",
  description:
    "Preview what snipping the middle of a long tool result would look like (keep first/last lines, insert a snip marker). Read-only: does not modify the conversation.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The tool-result text to preview snipping." },
      keepFirst: { type: "number", description: "Lines to keep at the start (default 2)." },
      keepLast: { type: "number", description: "Lines to keep at the end (default 2)." },
    },
    required: ["text"],
  },
  exposure: "deferred",
  searchInfo: { keywords: ["snip", "history", "tool result", "truncate", "preview"] },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const text = typeof args.text === "string" ? args.text : "";
    if (text === "") return { ok: false, output: "", error: "text is required" };
    const keepFirst = typeof args.keepFirst === "number" ? args.keepFirst : 2;
    const keepLast = typeof args.keepLast === "number" ? args.keepLast : 2;
    const result = snipPreview(text, keepFirst, keepLast);
    return { ok: true, output: result.preview };
  },
};
