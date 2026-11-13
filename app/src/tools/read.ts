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

export type ReadBatchItem = {
  path: string;
  ok: boolean;
  output?: string;
  error?: string;
};

async function readOnePath(args: Record<string, unknown>, ctx: ToolContext, pathArg: string): Promise<ToolResult> {
  try {
    if (pathArg === "") return fail("path is required");
      // Resolve symlinks BEFORE Guard: the guard must see the path whose bytes
      // will actually be read. Guarding the lexical path while `readFile`
      // follows a symlink is an escape (workspace/link -> /etc/...).
      let resolved = resolvePath(ctx.cwd, pathArg);
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

      const rawOffset = Number(args.offset);
      const line1 =
        Number.isFinite(rawOffset) && rawOffset !== 0
          ? rawOffset < 0
            ? Math.max(1, all.length + Math.floor(rawOffset) + 1)
            : Math.max(1, Math.floor(rawOffset))
          : 1;
      const start = line1 - 1;
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
}

export const readTool: Tool = {
  name: "read",
  description: "Read a text file with line numbers, optionally a line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read." },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional batch: read multiple paths; returns a JSON array of per-path ok/output/error (never fails the whole call on one bad path).",
      },
      offset: {
        type: "number",
        description: "1-based line to start at (default 1). Negative values count from the end (e.g. -100 = last 100 lines).",
      },
      limit: { type: "number", description: `Maximum lines to return (default and cap ${MAX_LINES}).` },
      anchors: {
        type: "boolean",
        description: "Prefix each line with a LINE:abc:def anchor usable by edit start_anchor/end_anchor (default false).",
      },
    },
    // Either `path` or `paths` (batch); execute fails closed if both or neither.
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const pathStr = typeof args.path === "string" ? args.path : "";
    const hasPath = pathStr !== "";
    const pathsArg = args.paths;
    const batchPaths = Array.isArray(pathsArg) ? pathsArg : undefined;
    const hasBatch = batchPaths !== undefined && batchPaths.length > 0;
    if (hasPath && hasBatch) return fail("set either path or paths, not both");
    if (hasBatch) {
      const items: ReadBatchItem[] = [];
      for (const entry of batchPaths!) {
        if (typeof entry !== "string" || entry === "") {
          items.push({ path: String(entry), ok: false, error: "invalid path entry" });
          continue;
        }
        const one = await readOnePath(args, ctx, entry);
        items.push({
          path: entry,
          ok: one.ok,
          output: one.ok ? one.output : undefined,
          error: one.ok ? undefined : one.error ?? "read failed",
        });
      }
      return { ok: true, output: JSON.stringify(items, null, 2) };
    }
    if (!hasPath) return fail("path or paths is required");
    return readOnePath(args, ctx, pathStr);
  },
};
