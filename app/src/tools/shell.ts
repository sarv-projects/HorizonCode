/** `shell` — run one bash command in the workspace. */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { resolvePath, truncate } from "./helpers";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Environment names that must never reach a child process. */
const SECRET_ENV = /(key|token|secret|password)$/i;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Inherit the environment, minus anything that looks like a credential. */
function scrubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export const shellTool: Tool = {
  name: "shell",
  description: "Run a bash command in the workspace and return its combined output and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Bash command line to run." },
      cwd: { type: "string", description: "Working directory, relative to the workspace (default: workspace)." },
      timeoutMs: { type: "number", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ["command"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.command !== "string" || args.command.trim() === "") return fail("command is required");
      const command = args.command;
      if (ctx.signal.aborted) return fail("aborted");

      const dir = typeof args.cwd === "string" && args.cwd !== "" ? resolvePath(ctx.cwd, args.cwd) : ctx.cwd;
      const timeoutMs = Math.min(numberOr(args.timeoutMs, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);

      const decision = await ctx.guard({ kind: "shell.exec", target: command });
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve({ title: "Run shell command", detail: command, kind: "shell.exec" });
        if (!approved) return fail("declined by user");
      }
      if (ctx.signal.aborted) return fail("aborted");

      let proc: any;
      try {
        proc = Bun.spawn({
          cmd: ["bash", "-lc", command],
          cwd: dir,
          env: scrubEnv(),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
      } catch (e) {
        return fail(`failed to start command: ${msg(e)}`);
      }

      let out = "";
      let timedOut = false;
      let aborted = false;
      const decoder = new TextDecoder();

      const kill = (): void => {
        try {
          process.kill(-proc.pid, "SIGKILL"); // the child's process group, when it has one
        } catch {
          /* not a group leader */
        }
        try {
          proc.kill(9);
        } catch {
          /* already gone */
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (out.length >= MAX_OUTPUT) continue; // keep draining, stop buffering
            out += decoder.decode(value, { stream: true });
          }
        } catch {
          /* stream closed by a kill */
        }
      };

      try {
        await Promise.all([pump(proc.stdout), pump(proc.stderr), proc.exited]);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const body = truncate(out, MAX_OUTPUT).replace(/\n+$/, "");
      if (aborted) return { ok: false, output: body, error: "aborted" };
      if (timedOut) {
        return { ok: false, output: `${body}\n[timed out after ${timeoutMs}ms]`, error: `timed out after ${timeoutMs}ms` };
      }

      const code = proc.exitCode;
      const signal = proc.signalCode;
      const tail = `exit ${code === null ? "null" : code}${signal ? ` (signal ${signal})` : ""}`;
      return { ok: true, output: body === "" ? tail : `${body}\n${tail}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
