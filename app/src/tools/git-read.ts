/**
 * Read-only git tools — fixed argv through spawnOwned (no shell string).
 * Loop admission is fs.read on the workspace root (no shell.exec prompt).
 */

import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { resolveRealTarget, scrubEnv, truncate } from "./helpers";

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

const SAFE_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "protocol.ext.allow=never",
];

async function runGit(ctx: ToolContext, gitRoot: string, argv: string[]): Promise<ToolResult> {
  if (ctx.signal.aborted) return fail("aborted");
  const denied = await guardWorkspaceRead(ctx, gitRoot);
  if (denied !== null) return fail(denied);
  if (ctx.signal.aborted) return fail("aborted");
  const cmd = ["git", ...SAFE_GIT_CONFIG, "-C", gitRoot, ...argv];
  let proc: Awaited<ReturnType<typeof spawnOwned>>["proc"];
  try {
    ({ proc } = await spawnOwned(cmd, {
      stateDir: kernelStateDir(ctx.workspace),
      label: `git:${argv[0] ?? "?"}`,
      cwd: gitRoot,
      env: { ...scrubEnv(), GIT_CONFIG_NOSYSTEM: "1" },
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      longLived: false,
      sandboxWrap: "auto",
      sandboxMode: "read-only",
      kernel: ctx.kernel,
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
  let aborted = false;
  const killProc = (): void => {
    try {
      proc.kill(9);
    } catch {
      /* ignore */
    }
  };
  const onAbort = (): void => {
    aborted = true;
    killProc();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    killProc();
  }, GIT_TIMEOUT_MS);
  try {
    if (ctx.signal.aborted) {
      aborted = true;
      killProc();
    }
    await Promise.race([proc.exited, pump]).catch(() => {});
    await pump.catch(() => {});
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
  if (aborted) return fail("aborted");
  const code = proc.exitCode ?? (proc.signalCode ? -1 : timedOut ? -1 : 0);
  if (timedOut) return fail("git timed out");
  if (code !== 0) {
    const detail = err.trim() || out.trim() || `exit ${code}`;
    return { ok: false, output: truncate(out, MAX_OUTPUT), error: detail };
  }
  const body = out.trim() === "" ? "(no output)" : truncate(out, MAX_OUTPUT);
  return { ok: true, output: body };
}

function optionalRelPath(
  ctx: ToolContext,
  raw: unknown,
  base: string,
): { ok: true; rel: string | undefined } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: true, rel: undefined };
  const target = resolveRealTarget(base, raw.trim(), ctx.workspace);
  if (!target.inside) return { ok: false, error: "path must stay inside the workspace" };
  return { ok: true, rel: raw.trim() };
}

const sharedGitParams = {
  type: "object" as const,
  properties: {
    cwd: { type: "string", description: "Repository path relative to workspace (default: workspace root)." },
  },
};

function gitRoot(ctx: ToolContext, args: Record<string, unknown>): string | ToolResult {
  if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
    const target = resolveRealTarget(ctx.cwd, args.cwd.trim(), ctx.workspace);
    if (!target.inside) return fail("cwd must stay inside the workspace");
    return target.real;
  }
  return resolveRealTarget(ctx.cwd, ".", ctx.workspace).real;
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
    const checked = optionalRelPath(ctx, args.path, dir);
    if (checked.ok === false) return fail(checked.error);
    if (checked.rel !== undefined) argv.push("--", checked.rel);
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
    const checked = optionalRelPath(ctx, args.path, dir);
    if (checked.ok === false) return fail(checked.error);
    if (checked.rel !== undefined) argv.push("--", checked.rel);
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
    const checked = optionalRelPath(ctx, args.path, dir);
    if (checked.ok === false) return fail(checked.error);
    if (checked.rel === undefined) return fail("path is required and must stay inside the workspace");
    const argv = ["blame", "--", checked.rel];
    const start = typeof args.startLine === "number" ? Math.floor(args.startLine) : undefined;
    const end = typeof args.endLine === "number" ? Math.floor(args.endLine) : undefined;
    if (start !== undefined && start > 0) {
      const last = end !== undefined && end >= start ? end : start;
      argv.splice(1, 0, `-L`, `${start},${last}`);
    }
    return await runGit(ctx, dir, argv);
  },
};