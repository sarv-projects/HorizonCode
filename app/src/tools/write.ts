/** `write` — create or overwrite a file. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../contracts";
import { relPath, resolvePath } from "./helpers";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Lines in `content`, not counting the trailing newline of the final line. */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

export const writeTool: Tool = {
  name: "write",
  description: "Create or overwrite a file, creating parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.content !== "string") return fail("content is required");

      const content = args.content;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);
      const lines = countLines(content);
      const bytes = Buffer.byteLength(content, "utf8");

      const decision = await ctx.guard({ kind: "fs.write", target: resolved });
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve({
          title: `Write ${rel}`,
          detail: `${lines} lines, ${bytes} bytes`,
          kind: "fs.write",
        });
        if (!approved) return fail("declined by user");
      }

      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");

      return { ok: true, output: `Wrote ${lines} lines (${bytes} bytes) to ${rel}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
