/** `glob` — find files by pattern. */

import { statSync } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir } from "../core/owned-spawn";
import { relPath, resolvePath } from "./helpers";
import { gitIgnoredPaths } from "./ignore";

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
      // Why the walk stopped, if it did: an incomplete scan reported as a complete
      // file list is worse than a slow one (audit finding 8).
      let stoppedBy: "scanned" | "collected" | undefined;
      try {
        const scan = glob.scanSync({ cwd: root, onlyFiles: true, dot: false, followSymlinks: false });
        for (const rel of scan) {
          if (++scanned > MAX_SCANNED) {
            stoppedBy = "scanned";
            break;
          }
          if (skipPath(rel)) continue;
          found.push(rel);
          if (found.length >= MAX_COLLECT) {
            stoppedBy = "collected";
            break;
          }
        }
      } catch (e) {
        return fail(msg(e));
      }

      if (found.length === 0 && stoppedBy === undefined) return { ok: true, output: "No files matched." };

      // Git's own ignore rules, the same ones grep obeys (audit: the two tools
      // disagreed about what the repository contains). One batch call; a
      // non-repo or a missing git filters nothing.
      const absolutes = found.map((p) => path.resolve(root, p));
      const ignored = await gitIgnoredPaths(ctx.cwd, absolutes, kernelStateDir(ctx.workspace));
      const visible = found.filter((_, i) => !ignored.has(absolutes[i] as string));
      if (visible.length === 0 && stoppedBy === undefined) return { ok: true, output: "No files matched." };

      const paths = visible.map((p) => relPath(ctx.cwd, path.resolve(root, p))).sort();
      const shown = paths.slice(0, MAX_RESULTS);
      const notices: string[] = [];
      if (paths.length > MAX_RESULTS) notices.push(`[truncated: first ${MAX_RESULTS} of ${paths.length} paths shown]`);
      if (stoppedBy === "scanned") {
        notices.push(
          `[incomplete: the walk stopped after ${MAX_SCANNED} entries; this list is NOT exhaustive — narrow the pattern or the path]`,
        );
      }
      if (stoppedBy === "collected") {
        notices.push(
          `[incomplete: the walk stopped after collecting ${MAX_COLLECT} matches; this list is NOT exhaustive — narrow the pattern or the path]`,
        );
      }
      const body = shown.join("\n");
      return { ok: true, output: notices.length === 0 ? body : `${body}\n${notices.join("\n")}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
