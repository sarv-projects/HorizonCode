/** `glob` — find files by pattern. */

import { statSync } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { relPath, resolvePath } from "./helpers";

const MAX_RESULTS = 300;
const MAX_COLLECT = 5000;
const MAX_SCANNED = 50_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist"]);

/** True when any path segment is a directory we never descend into. */
function skipPath(rel: string): boolean {
  for (const segment of rel.split("/")) if (SKIP_DIRS.has(segment)) return true;
  return false;
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function checkAccess(ctx: ToolContext, resolved: string, rel: string): Promise<string | null> {
  const action: GuardAction = { kind: "fs.read", target: resolved };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `Glob ${rel}`, detail: resolved, kind: "fs.read" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern, newest-agnostic name order.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/*.md'." },
      path: { type: "string", description: "Directory to search from (default: workspace)." },
    },
    required: ["pattern"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.pattern !== "string" || args.pattern === "") return fail("pattern is required");
      let pattern = args.pattern;
      // A slash-less pattern is meant recursively: '*.ts' -> '**/*.ts'.
      if (!pattern.includes("/") && !pattern.startsWith("**")) pattern = `**/${pattern}`;

      const root = resolvePath(ctx.cwd, typeof args.path === "string" && args.path !== "" ? args.path : ".");
      const rootRel = relPath(ctx.cwd, root);

      const denied = await checkAccess(ctx, root, rootRel);
      if (denied) return fail(denied);

      try {
        statSync(root);
      } catch {
        return fail(`path not found: ${rootRel}`);
      }

      let glob: Bun.Glob;
      try {
        glob = new Bun.Glob(pattern);
      } catch {
        return fail(`invalid pattern: ${pattern}`);
      }

      const found: string[] = [];
      let scanned = 0;
      try {
        const scan = glob.scanSync({ cwd: root, onlyFiles: true, dot: false, followSymlinks: false });
        for (const rel of scan) {
          if (++scanned > MAX_SCANNED) break;
          if (skipPath(rel)) continue;
          found.push(rel);
          if (found.length >= MAX_COLLECT) break;
        }
      } catch (e) {
        return fail(msg(e));
      }

      if (found.length === 0) return { ok: true, output: "No files matched." };

      const paths = found.map((p) => relPath(ctx.cwd, path.resolve(root, p))).sort();
      const shown = paths.slice(0, MAX_RESULTS);
      const body = shown.join("\n");
      return {
        ok: true,
        output: paths.length > MAX_RESULTS ? `${body}\n[truncated: first ${MAX_RESULTS} of ${paths.length} paths shown]` : body,
      };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
