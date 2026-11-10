/** `read` — read a text file (optionally a line range) with line numbers. */

import { readFile, realpath, stat } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { isBinary, relPath, resolvePath } from "./helpers";
import { anchorAt } from "./hashline";
import { noteRead } from "./read-ledger";

const MAX_LINES = 2000;
const MAX_BYTES = 200 * 1024;
/** Refuse to load files bigger than this whole; the output cap is far smaller. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Guard + (when policy says `ask`) approve a read of `resolved`. Returns an error string, or null. */
async function checkAccess(ctx: ToolContext, resolved: string, rel: string): Promise<string | null> {
  const action: GuardAction = { kind: "fs.read", target: resolved };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `Read ${rel}`, detail: resolved, kind: "fs.read" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

export const readTool: Tool = {
  name: "read",
  description: "Read a text file with line numbers, optionally a line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read." },
      offset: { type: "number", description: "1-based line number to start at (default 1)." },
      limit: { type: "number", description: `Maximum lines to return (default and cap ${MAX_LINES}).` },
      anchors: {
        type: "boolean",
        description: "Prefix each line with a LINE:abc:def anchor usable by edit start_anchor/end_anchor (default false).",
      },
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      // Resolve symlinks BEFORE Guard: the guard must see the path whose bytes
      // will actually be read. Guarding the lexical path while `readFile`
      // follows a symlink is an escape (workspace/link -> /etc/...).
      let resolved = resolvePath(ctx.cwd, args.path);
      try {
        resolved = await realpath(resolved);
      } catch {
        /* nonexistent: keep the lexical path so the not-found message stays informative */
      }
      const rel = relPath(ctx.cwd, resolved);

      const denied = await checkAccess(ctx, resolved, rel);
      if (denied) return fail(denied);

      let st;
      try {
        st = await stat(resolved);
      } catch {
        return fail(`file not found: ${rel}`);
      }
      if (st.isDirectory()) return fail(`is a directory: ${rel}`);
      // FIFOs block forever, devices are unbounded (e.g. /dev/zero) and sockets
      // are not files: only regular files are read.
      if (!st.isFile()) return fail(`not a regular file: ${rel}`);
      if (st.size > MAX_FILE_BYTES) {
        return fail(`file too large to read safely: ${rel} (${st.size} bytes)`);
      }

      const buf = await readFile(resolved);
      if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);

      const text = buf.toString("utf8");
      if (text === "") {
        noteRead(ctx, resolved); // an empty file is a fact worth remembering too
        return { ok: true, output: `(empty file) ${rel}` };
      }

      const all = text.split("\n");
      if (all.length > 1 && all[all.length - 1] === "") all.pop(); // trailing newline

      const start = Math.max(1, Math.floor(Number(args.offset) || 1)) - 1;
      const wanted = Math.max(1, Math.floor(Number(args.limit) || MAX_LINES));
      const limit = Math.min(wanted, MAX_LINES);

      if (start >= all.length) {
        noteRead(ctx, resolved);
        return { ok: true, output: `(no lines at offset ${start + 1}; file has ${all.length} lines) ${rel}` };
      }

      // Opt-in hashline anchors (ruling 64). Off by default: the default rendering
      // below is byte-identical to before so the prompt cache is unchanged.
      const withAnchors = args.anchors === true;
      const anchorLines = withAnchors ? all.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)) : null;
      const out: string[] = [];
      let bytes = 0;
      let cutMid = false;
      let byteLimited = false;
      for (let i = start; i < all.length && out.length < limit; i++) {
        const line = all[i].endsWith("\r") ? all[i].slice(0, -1) : all[i];
        const rendered = withAnchors
          ? `${anchorAt(anchorLines as string[], i)}| ${line}`
          : `${String(i + 1).padStart(6, " ")}| ${line}`;
        const size = Buffer.byteLength(rendered, "utf8") + 1;
        const remaining = MAX_BYTES - bytes;
        if (size > remaining) {
          // the byte budget ran out; emit part of this line when there is room
          const cut = Buffer.from(rendered, "utf8").subarray(0, Math.max(0, remaining - 1)).toString("utf8");
          if (cut !== "") {
            out.push(cut);
            bytes += remaining;
            cutMid = true;
          }
          byteLimited = true;
          break;
        }
        out.push(rendered);
        bytes += size;
      }

      const shown = start + out.length;
      let body = out.join("\n");
      if (cutMid) {
        body += `\n[truncated: reached the ${MAX_BYTES} byte limit mid-line]`;
      } else if (byteLimited) {
        body += `\n[truncated: reached the ${MAX_BYTES} byte limit at line ${shown}]`;
      } else if (shown < all.length) {
        body += `\n[truncated: lines ${start + 1}-${shown} of ${all.length}; use offset/limit to continue]`;
      }
      // Only the read tool writes the ledger: whatever the model does next with
      // this file (`write` over it, `edit` with a fuzzy rung), it has now seen it.
      noteRead(ctx, resolved);
      return { ok: true, output: body };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
