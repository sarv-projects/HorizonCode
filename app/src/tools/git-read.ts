/**
 * Read-only git tools — fixed argv through spawnOwned (no shell string).
 * Loop admission is fs.read on the workspace root (no shell.exec prompt).
 */

import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { resolvePath, truncate } from "./helpers";

const MAX_OUTPUT = 30_000;
const DEFAULT_LOG_COUNT = 20;
const MAX_LOG_COUNT = 100;
const GIT_TIMEOUT_MS = 60_000;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function guardWorkspaceRead(ctx: ToolContext, root: string): Promise<string | null> {
  const action: GuardAction = { kind: "fs.read", target: root };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: "Git read", detail: root, kind: "fs.read" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

async function runGit(ctx: ToolContext, gitRoot: string, argv: string[]): Promise<ToolResult> {
  const denied = await guardWorkspaceRead(ctx, gitRoot);
  if (denied !== null) return fail(denied);
  const cmd = ["git", "-C", gitRoot, ...argv];
  let proc: Awaited<ReturnType<typeof spawnOwned>>["proc"];
  try {
    ({ proc } = await spawnOwned(cmd, {
      stateDir: kernelStateDir(ctx.workspace),
      label: `git:${argv[0] ?? "?"}`,
      cwd: gitRoot,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      longLived: false,
    }));
  } catch (e) {
    return fail(`git failed to start: ${msg(e)}`);
  }
  const decoder = new TextDecoder();
  let out = "";
  let err = "";
  const readStream = async (stream: ReadableStream<Uint8Array> | undefined, sink: "out" | "err"): Promise<void> => {
    if (stream === undefined) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        if (sink === "out") {
          if (out.length < MAX_OUTPUT) out += piece.slice(0, MAX_OUTPUT - out.length);
        } else if (err.length < 4000) {
          err += piece.slice(0, 4000 - err.length);
        }
      }
    } catch {
      /* closed */
    }
  };
  const pump = Promise.all([readStream(proc.stdout, "out"), readStream(proc.stderr, "err")]);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      /* ignore */
    }
  }, GIT_TIMEOUT_MS);
  await Promise.race([proc.exited, pump]).catch(() => {});
  await pump.catch(() => {});
  clearTimeout(timer);
  const code = proc.exitCode ?? (proc.signalCode ? -1 : timedOut ? -1 : 0);
  if (timedOut) return fail("git timed out");
  if (code !== 0) {
    const detail = err.trim() || out.trim() || `exit ${code}`;
    return { ok: false, output: truncate(out, MAX_OUTPUT), error: detail };
  }
  const body = out.trim() === "" ? "(no output)" : truncate(out, MAX_OUTPUT);
  return { ok: true, output: body };
}

function insideWorkspace(workspace: string, target: string): boolean {
  const root = path.resolve(workspace);
  const abs = path.resolve(target);
  return abs === root || abs.startsWith(`${root}${path.sep}`);
}

function optionalRelPath(ctx: ToolContext, raw: unknown, base: string): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const abs = resolvePath(base, raw.trim());
  if (!insideWorkspace(ctx.cwd, abs)) return undefined;
  return raw.trim();
}

const sharedGitParams = {
  type: "object" as const,
  properties: {
    cwd: { type: "string", description: "Repository path relative to workspace (default: workspace root)." },
  },
};

function gitRoot(ctx: ToolContext, args: Record<string, unknown>): string | ToolResult {
  if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
    const dir = resolvePath(ctx.cwd, args.cwd.trim());
    if (!insideWorkspace(ctx.cwd, dir)) return fail("cwd must stay inside the workspace");
    return dir;
  }
  return ctx.cwd;
}

export const gitStatusTool: Tool = {
  name: "git_status",
  description: "Read-only `git status` in the workspace (porcelain-friendly, capped output).",
  parameters: {
    ...sharedGitParams,
    properties: {
      ...sharedGitParams.properties,
      short: { type: "boolean", description: "Use --short format (default true)." },
    },
  },
  concurrencyClass: "shared",
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dir = gitRoot(ctx, args);
    if (typeof dir !== "string") return dir;
    const short = args.short !== false;
    const argv = short ? ["status", "--short", "--branch"] : ["status", "--branch"];
    return await runGit(ctx, dir, argv);
  },
};

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: "Read-only `git diff` (unstaged by default; optional --staged).",
  parameters: {
    ...sharedGitParams,
    properties: {
      ...sharedGitParams.properties,
      staged: { type: "boolean", description: "Diff the index (git diff --staged)." },
      path: { type: "string", description: "Optional path inside the repo to limit the diff." },
    },
  },
  concurrencyClass: "shared",
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dir = gitRoot(ctx, args);
    if (typeof dir !== "string") return dir;
    const argv = ["diff", "--no-ext-diff"];
    if (args.staged === true) argv.push("--staged");
    const rel = optionalRelPath(ctx, args.path, dir);
    if (rel !== undefined) argv.push("--", rel);
    return await runGit(ctx, dir, argv);
  },
};

export const gitLogTool: Tool = {
  name: "git_log",
  description: "Read-only `git log` with a bounded commit count (default 20, max 100).",
  parameters: {
    ...sharedGitParams,
    properties: {
      ...sharedGitParams.properties,
      n: { type: "number", description: `Number of commits (default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}).` },
      oneline: { type: "boolean", description: "Use --oneline (default true)." },
      path: { type: "string", description: "Optional path to limit history." },
    },
  },
  concurrencyClass: "shared",
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dir = gitRoot(ctx, args);
    if (typeof dir !== "string") return dir;
    const nRaw = typeof args.n === "number" && Number.isFinite(args.n) ? Math.floor(args.n) : DEFAULT_LOG_COUNT;
    const n = Math.min(MAX_LOG_COUNT, Math.max(1, nRaw));
    const argv =
      args.oneline !== false
        ? ["log", "--oneline", "-n", String(n), "--date=short"]
        : ["log", "-n", String(n), "--date=short", "--format=%h %ad %s"];
    const rel = optionalRelPath(ctx, args.path, dir);
    if (rel !== undefined) argv.push("--", rel);
    return await runGit(ctx, dir, argv);
  },
};

export const gitBlameTool: Tool = {
  name: "git_blame",
  description: "Read-only `git blame` for one file (line range optional).",
  parameters: {
    ...sharedGitParams,
    properties: {
      ...sharedGitParams.properties,
      path: { type: "string", description: "File path relative to the repo root." },
      startLine: { type: "number", description: "First line (1-based, optional)." },
      endLine: { type: "number", description: "Last line (1-based, optional)." },
    },
    required: ["path"],
  },
  concurrencyClass: "shared",
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dir = gitRoot(ctx, args);
    if (typeof dir !== "string") return dir;
    const rel = optionalRelPath(ctx, args.path, dir);
    if (rel === undefined) return fail("path is required and must stay inside the workspace");
    const argv = ["blame", "--", rel];
    const start = typeof args.startLine === "number" ? Math.floor(args.startLine) : undefined;
    const end = typeof args.endLine === "number" ? Math.floor(args.endLine) : undefined;
    if (start !== undefined && start > 0) {
      const last = end !== undefined && end >= start ? end : start;
      argv.splice(1, 0, `-L`, `${start},${last}`);
    }
    return await runGit(ctx, dir, argv);
  },
};