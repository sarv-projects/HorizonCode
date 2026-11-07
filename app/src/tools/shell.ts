/** `shell` — run one bash command in the workspace. */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { resolvePath, scrubEnv, truncate } from "./helpers";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** How long to keep draining output pipes after the direct child has exited. */
const DRAIN_GRACE_MS = 500;

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Wait for `p`, giving up after `ms`; returns true when `p` settled in time. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
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
          // Own process group: `kill` below then reaches the whole tree, not just bash.
          detached: true,
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
          process.kill(-proc.pid, "SIGKILL"); // the child's process group (see `detached`)
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

      const readers: Array<{ cancel(reason?: unknown): Promise<void> }> = [];
      const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        const reader = stream.getReader();
        readers.push(reader);
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

      const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(
        () => {},
        () => {},
      );
      try {
        await proc.exited;
        // The pipes normally close as the child exits. A process that outlived it — a
        // background job, or a descendant that escaped the group kill — can keep them
        // open, so the drain wait is bounded and the readers are then dropped.
        if (!(await settlesWithin(pumps, DRAIN_GRACE_MS))) {
          for (const reader of readers) {
            try {
              await reader.cancel();
            } catch {
              /* already closed */
            }
          }
        }
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
