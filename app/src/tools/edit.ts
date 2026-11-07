/** `edit` — exact string replacement in one file. */

import { readFile, writeFile } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { isBinary, relPath, resolvePath } from "./helpers";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Replace every occurrence of `old` with `next` (never one — use replaceFirst for that). */
function replaceAll(hay: string, oldStr: string, next: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const i = hay.indexOf(oldStr, from);
    if (i === -1) break;
    out += hay.slice(from, i) + next;
    from = i + oldStr.length;
  }
  return out + hay.slice(from);
}

function replaceFirst(hay: string, oldStr: string, next: string): string {
  const i = hay.indexOf(oldStr);
  if (i === -1) return hay;
  return hay.slice(0, i) + next + hay.slice(i + oldStr.length);
}

export const editTool: Tool = {
  name: "edit",
  description: "Replace an exact string in a file, all occurrences or the first only.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit." },
      old: { type: "string", description: "Exact string to replace (must not be empty)." },
      new: { type: "string", description: "Replacement string." },
      all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old", "new"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.old !== "string") return fail("old is required");
      if (args.old === "") return fail("old must not be empty");
      if (typeof args.new !== "string") return fail("new is required");

      const oldStr = args.old;
      const newStr = args.new;
      const all = args.all === true;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);

      const action: GuardAction = { kind: "fs.write", target: resolved };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }

      let before: string;
      try {
        const buf = await readFile(resolved);
        if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);
        before = buf.toString("utf8");
      } catch {
        return fail(`file not found: ${rel}`);
      }

      const matches = countOccurrences(before, oldStr);
      if (matches === 0) return fail(`old string not found in ${rel}`);
      if (matches > 1 && !all) {
        return fail(`found ${matches} matches in ${rel}; set all:true or provide more context`);
      }

      const replacements = all ? matches : 1;

      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          {
            title: `Edit ${rel}`,
            detail: `${replacements} occurrence(s)`,
            kind: "fs.write",
          },
          action,
        );
        if (!approved) return fail("declined by user");
      }

      const after = all ? replaceAll(before, oldStr, newStr) : replaceFirst(before, oldStr, newStr);
      await writeFile(resolved, after, "utf8");

      const verified = (await readFile(resolved)).toString("utf8") === after;
      if (!verified) return fail(`verification failed: ${rel} does not match the intended content`);

      return { ok: true, output: `Replaced ${replacements} occurrence(s) in ${rel}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
