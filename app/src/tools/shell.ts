/** `shell` — run one bash command in the workspace. */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { resolvePath, scrubEnv, truncate } from "./helpers";
import { readTool } from "./read";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** How long to keep draining output pipes after the direct child has exited. */
const DRAIN_GRACE_MS = 500;

/** Programs that need a terminal to be usable at all (NF-074 interception). */
const INTERACTIVE_BLOCKLIST = new Set(["vim", "vi", "nano", "emacs", "pico", "less", "more", "man", "top", "htop", "watch", "tmux", "screen"]);
/** Interpreters that are REPLs when invoked bare (no script argument). */
const REPL_BLOCKLIST = new Set(["python", "python3", "ipython", "node", "irb", "ruby", "ghci", "perl", "php"]);

export type ShellPlan =
  | { action: "run" }
  | { action: "refuse"; reason: string }
  | { action: "intercept-read"; path: string };

/**
 * NF-074(d): dedicated-tool interception and the interactive blocklist, applied
 * BEFORE Guard — an interception narrows (shell.exec → the read tool's own
 * fs.read admission), so there is no widened path. Byte-stable decisions.
 */
export function classifyShellCommand(command: string, allowInteractive = false): ShellPlan {
  if (allowInteractive) return { action: "run" };
  const parts = (typeof command === "string" ? command : "").trim().split(/\s+/).filter((p) => p !== "");
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i] as string)) i += 1;
  const head = parts[i] ?? "";
  const base = head.split("/").pop() ?? head;
  const rest = parts.slice(i + 1);
  if (base === "cat" && rest.length === 1 && !(rest[0] as string).startsWith("-")) {
    return { action: "intercept-read", path: rest[0] as string };
  }
  if (INTERACTIVE_BLOCKLIST.has(base)) return { action: "refuse", reason: `${base} needs a terminal` };
  if (base === "tail" && rest.some((t) => t === "-f" || t === "-F" || /^-[0-9]*[fF]$/.test(t))) {
    return { action: "refuse", reason: "tail -f streams forever" };
  }
  if (REPL_BLOCKLIST.has(base) && rest.every((t) => t.startsWith("-"))) {
    return { action: "refuse", reason: `${base} without a script is an interactive REPL` };
  }
  return { action: "run" };
}

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * NF-074(c): the shell-output minimiser, on by default. Strips ANSI/OSC
 * sequences and control characters, resolves carriage-return progress lines
 * to their final state, trims trailing whitespace and collapses blank runs.
 * Returns the text unchanged (and changed:false) when there is nothing to do.
 */
export function minimiseShellOutput(raw: string): { text: string; changed: boolean } {
  const input = typeof raw === "string" ? raw : "";
  const text = input
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_ESC, "")
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r");
      const settled = at === -1 ? line : line.slice(at + 1);
      return settled.replace(CONTROL, "").replace(/[ \t]+$/, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { text, changed: text !== input };
}

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

      // NF-074(d): interception and the interactive blocklist run before Guard.
      const plan = classifyShellCommand(command, process.env.HZ_ALLOW_INTERACTIVE === "1");
      if (plan.action === "refuse") {
        return fail(`interactive command blocked (interception): ${plan.reason}; set HZ_ALLOW_INTERACTIVE=1 to override`);
      }
      if (plan.action === "intercept-read") {
        // `cat <file>` is the read tool's job: it asks(read) for its own guard,
        // capped output, and the model sees one honest notice.
        const target = typeof args.cwd === "string" && args.cwd !== "" ? resolvePath(dir, plan.path) : plan.path;
        const readResult = await readTool.execute({ path: target }, ctx);
        const notice = `[intercepted: cat ${plan.path} \u2192 read tool]`;
        if (readResult.ok) return { ok: true, output: `${notice}\n${readResult.output}` };
        return { ok: false, output: notice, error: readResult.error ?? "read failed" };
      }

      const action: GuardAction = { kind: "shell.exec", target: command };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve({ title: "Run shell command", detail: command, kind: "shell.exec" }, action);
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

      const minimised = minimiseShellOutput(out);
      const flag = minimised.changed
        ? `\n[output minimised: ${Buffer.byteLength(out, "utf8")} \u2192 ${Buffer.byteLength(minimised.text, "utf8")} bytes]`
        : "";
      const body = truncate(minimised.text, MAX_OUTPUT).replace(/\n+$/, "") + flag;
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
