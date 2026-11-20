/**
 * `shell_bg` — poll, read output from, or kill a shell command the `shell` tool
 * auto-backgrounded (C-7). Uses the capture registry in shell-auto-background.ts.
 */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import {
  allBackgroundCaptures,
  backgroundCapture,
  backgroundCapturesForSession,
  tailBackgroundOutput,
} from "../core/shell-auto-background";
import { truncate } from "./helpers";

const KILL_GRACE_MS = 2000;
const MAX_OUTPUT = 30_000;
const DEFAULT_TAIL_LINES = 80;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePid(args: Record<string, unknown>): number | undefined {
  const raw = args.pid;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

async function killBackground(pid: number, ctx: ToolContext): Promise<ToolResult> {
  const action: GuardAction = { kind: "shell.exec", target: `shell_bg: kill background pid ${pid}` };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
  }
  if (decision.decision === "ask") {
    const approved = await ctx.approve({ title: "Kill background shell", detail: `pid ${pid}`, kind: "shell.exec" }, action);
    if (!approved) return fail("declined by user");
  }
  const row = backgroundCapture(pid);
  if (row === undefined && !pidAlive(pid)) {
    return { ok: true, output: `No background job with pid ${pid} (not registered and not running).` };
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  await sleep(KILL_GRACE_MS);
  if (pidAlive(pid)) {
    signal("SIGKILL");
    await sleep(100);
  }
  const alive = pidAlive(pid);
  const cap = row ?? backgroundCapture(pid);
  const exitHint =
    cap?.exitCode !== undefined && cap.exitCode !== null
      ? `exit ${cap.exitCode}`
      : cap?.signalCode
        ? `signal ${cap.signalCode}`
        : alive
          ? "still running"
          : "exited";
  return {
    ok: !alive,
    output: `Sent SIGTERM/SIGKILL to background pid ${pid} (${exitHint})`,
    ...(alive ? { error: "process still alive" } : {}),
  };
}

function pollJob(pid: number): ToolResult {
  const row = backgroundCapture(pid);
  if (row === undefined) {
    const live = pidAlive(pid);
    if (!live) return { ok: true, output: `pid ${pid}: not registered; process not running` };
    return { ok: true, output: `pid ${pid}: running (no capture registry entry — output may be unavailable)` };
  }
  const running = row.exitCode === undefined ? pidAlive(pid) : false;
  const state = running ? "running" : "exited";
  const exit =
    row.exitCode !== undefined && row.exitCode !== null
      ? `exit_code=${row.exitCode}`
      : row.signalCode
        ? `signal=${row.signalCode}`
        : running
          ? "exit_code=unknown"
          : "exit_code=unknown";
  const elapsed = Math.max(0, Math.round((Date.now() - row.startedAtMs) / 1000));
  return {
    ok: true,
    output: [
      `pid ${pid}: ${state} (${exit})`,
      `session=${row.sessionId}`,
      `elapsed=${elapsed}s`,
      `command=${row.command}`,
      `cwd=${row.cwd}`,
      row.logPath ? `log=${row.logPath}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

function outputJob(pid: number, lines: number): ToolResult {
  const row = backgroundCapture(pid);
  const tail = tailBackgroundOutput(pid, lines);
  const header = row ? `pid ${pid} (${row.command})\n---\n` : `pid ${pid}\n---\n`;
  return { ok: true, output: truncate(header + tail, MAX_OUTPUT) };
}

function listJobs(sessionId: string): ToolResult {
  const rows = backgroundCapturesForSession(sessionId);
  if (rows.length === 0) {
    const any = allBackgroundCaptures();
    if (any.length === 0) return { ok: true, output: "No auto-backgrounded shell jobs in this process." };
    const lines = any.map((r) => {
      const live = r.exitCode === undefined && pidAlive(r.pid);
      return `- pid ${r.pid} session=${r.sessionId} ${live ? "running" : "exited"} — ${r.command}`;
    });
    return { ok: true, output: `No jobs for this session; other sessions:\n${lines.join("\n")}` };
  }
  const lines = rows.map((r) => {
    const live = r.exitCode === undefined && pidAlive(r.pid);
    return `- pid ${r.pid} ${live ? "running" : "exited"} — ${r.command}`;
  });
  return { ok: true, output: lines.join("\n") };
}

export const shellBgTool: Tool = {
  name: "shell_bg",
  description:
    "Poll, read output from, or kill a long-running command the shell tool auto-backgrounded. " +
    "Use poll for running/exited status, output for the latest captured lines, kill to SIGTERM then SIGKILL.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["poll", "output", "kill", "list"],
        description: "Operation: poll status, tail output, kill the process, or list known jobs.",
      },
      pid: { type: "number", description: "Process id from the shell auto-background notice (required except for list)." },
      lines: {
        type: "number",
        description: `Lines of output to return for op=output (default ${DEFAULT_TAIL_LINES}, max 500).`,
      },
    },
    required: ["op"],
  },

  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const op = typeof args.op === "string" ? args.op.trim() : "";
      if (op === "list") return listJobs(ctx.sessionId);
      const pid = resolvePid(args);
      if (pid === undefined) return fail("pid is required");
      if (op === "poll") return pollJob(pid);
      if (op === "output") {
        const lines =
          typeof args.lines === "number" && Number.isFinite(args.lines)
            ? Math.min(500, Math.max(1, Math.floor(args.lines)))
            : DEFAULT_TAIL_LINES;
        return outputJob(pid, lines);
      }
      if (op === "kill") return await killBackground(pid, ctx);
      return fail(`unknown op: ${op || "(missing)"}`);
    } catch (e) {
      return fail(msg(e));
    }
  },
};