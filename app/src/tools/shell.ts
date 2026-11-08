/** `shell` — run one bash command in the workspace. */

import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { sha256Hex } from "../core/canon";
import { planToolOutputCap, writeSpillFile } from "../core/output-budget";
import { spillDir } from "../core/paths";
import { resolvePath, scrubEnv, truncate } from "./helpers";
import { readTool } from "./read";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** How long to keep draining output pipes after the direct child has exited. */
const DRAIN_GRACE_MS = 500;
/**
 * How long a terminated command gets to exit on SIGTERM before SIGKILL. Test
 * runners and build tools flush and clean up on SIGTERM; SIGKILL-only denied
 * them that chance (audit finding 10 — `preview` already did SIGTERM first).
 */
const KILL_GRACE_MS = 2000;

/** Programs that need a terminal to be usable at all (NF-074 interception). */
const INTERACTIVE_BLOCKLIST = new Set(["vim", "vi", "nano", "emacs", "pico", "less", "more", "man", "top", "htop", "watch", "tmux", "screen"]);
/** Interpreters that are REPLs when invoked bare (no script argument). */
const REPL_BLOCKLIST = new Set(["python", "python3", "ipython", "node", "irb", "ruby", "ghci", "perl", "php"]);

export type ShellPlan =
  | { action: "run" }
  | { action: "refuse"; reason: string }
  | { action: "intercept-read"; path: string };

/** `VAR=…` word, as bash prefixes a command line with. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Tokens that run another command: the real head is what follows them. */
const WRAPPER = new Set(["env", "command", "builtin", "exec", "nice", "ionice", "nohup", "stdbuf", "timeout"]);
/** `timeout`'s duration argument: `5`, `5s`, `0.5m`, … */
const TIMEOUT_DURATION = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;
/**
 * Characters that give an operand semantics beyond a literal file name — glob
 * syntax (`* ? [ {`), quoting/expansion (`$ \` " ' \\`) and every shell
 * operator. `cat` is intercepted only for a single plain literal operand.
 */
const SHELL_METACHARACTER = /[*?\[\]{}()<>;&|$`"'\\!#~]/;

/** Strip exactly one layer of matching quotes from an operand token. */
function stripOneQuoteLayer(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    if ((first === "'" || first === '"') && token[token.length - 1] === first) return token.slice(1, -1);
  }
  return token;
}

/**
 * NF-074(d): dedicated-tool interception and the interactive blocklist, applied
 * BEFORE Guard — an interception narrows (shell.exec → the read tool's own
 * fs.read admission), so there is no widened path. Byte-stable decisions.
 *
 * Wrapper tokens (`env`, `timeout`, `nice`, …) hide the real command from a
 * head-only check, so they are skipped — together with their fixed arguments —
 * before the blocklist, the REPL rules and the `cat` interception are applied
 * to the real head.
 */
export function classifyShellCommand(command: string, allowInteractive = false): ShellPlan {
  if (allowInteractive) return { action: "run" };
  const parts = (typeof command === "string" ? command : "").trim().split(/\s+/).filter((p) => p !== "");
  let i = 0;
  const skipAssignments = (): void => {
    while (i < parts.length && ASSIGNMENT.test(parts[i] as string)) i += 1;
  };
  skipAssignments();
  for (;;) {
    const base = (parts[i] ?? "").split("/").pop() ?? "";
    if (base === "env") {
      i += 1;
      skipAssignments(); // `env VAR=1 cmd`
      continue;
    }
    if (base === "nice") {
      i += 1;
      if (parts[i] === "-n" && i + 1 < parts.length) i += 2; // `nice -n 5 cmd`
      continue;
    }
    if (base === "stdbuf") {
      i += 1;
      while (i < parts.length && /^(?:-[ioeIOE]|--(?:input|output|error))/.test(parts[i] as string)) i += 1;
      continue;
    }
    if (base === "timeout") {
      i += 1;
      while (i < parts.length && (parts[i] as string).startsWith("-")) {
        const flag = parts[i] as string;
        i += 1;
        if (flag === "-s" || flag === "-k") i += 1; // the option's value
      }
      if (i < parts.length && TIMEOUT_DURATION.test(parts[i] as string)) i += 1; // the duration
      continue;
    }
    if (WRAPPER.has(base)) {
      i += 1;
      continue;
    }
    break;
  }
  const head = parts[i] ?? "";
  const base = head.split("/").pop() ?? head;
  const rest = parts.slice(i + 1);
  if (base === "cat" && rest.length === 1 && !(rest[0] as string).startsWith("-")) {
    // One layer of quotes is syntax, not part of the name; globs and other
    // metacharacters make the operand dynamic, so the shell must run it.
    const operand = stripOneQuoteLayer(rest[0] as string);
    if (operand !== "" && !SHELL_METACHARACTER.test(operand)) return { action: "intercept-read", path: operand };
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
 * Invisible reordering characters: bidi embeddings and overrides
 * (U+202A–U+202E), bidi isolate controls (U+2066–U+2069) and zero-widths
 * (U+200B–U+200D). They are not ANSI escapes, but they let command output
 * reverse or hide rendered names and paths on a terminal a human is reading
 * (the wave-13 audit finding: `printf 'cleanred\u202EdlroW olleh\u200Btail'`
 * printed cleanly while the model saw the control characters). Script
 * characters are never touched — this is the control set, no more: CJK text and
 * emoji pass through byte-for-byte.
 */
const INVISIBLE_REORDER = /[\u200B-\u200D\u202A-\u202E\u2066-\u2069]/g;

/**
 * NF-074(c): the shell-output minimiser, on by default. Strips ANSI/OSC
 * sequences and control characters, resolves carriage-return progress lines
 * to their final state, trims trailing whitespace and collapses blank runs.
 * Returns the text unchanged (and changed:false) when there is nothing to do.
 *
 * Only a BARE carriage return (`\r`, not followed by `\n`) is a progress
 * overwrite. A CRLF pair is a line ending and survives byte-for-byte: the `\r`
 * is carried through the per-line pass and re-joined as-is. Invisible reordering
 * characters (bidi embeddings/overrides, isolates, zero-widths) are stripped
 * with the other controls; Unicode script characters are kept.
 */
export function minimiseShellOutput(raw: string): { text: string; changed: boolean } {
  const input = typeof raw === "string" ? raw : "";
  const lines = input
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_ESC, "")
    .split("\n");
  const text = lines
    .map((line, index) => {
      // A trailing `\r` is the CR of a CRLF when a `\n` followed it (every
      // segment but the last); at the very end of the stream it is a bare CR.
      const crlf = index < lines.length - 1 && line.endsWith("\r");
      let body = crlf ? line.slice(0, -1) : line;
      // Trailing bare CRs only move the cursor back: the visible text stays.
      if (!crlf) body = body.replace(/\r+$/, "");
      const at = body.lastIndexOf("\r");
      const settled = at === -1 ? body : body.slice(at + 1);
      const cleaned = settled.replace(CONTROL, "").replace(INVISIBLE_REORDER, "").replace(/[ \t]+$/, "");
      return crlf ? `${cleaned}\r` : cleaned;
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

/**
 * NF-074(b): the loop caps an over-budget tool result and spills its text to
 * `<spill dir>/<sha256(text)>.txt` via `planToolOutputCap` (core/loop.ts, which
 * materialises the spill with `writeSpillFile`). When this tool minimised its
 * output, the model-facing text is the minimised one but the spill must stay
 * the ORIGINAL bytes — so the raw capture is written here first, under the
 * exact path and hash the loop will compute: the spill write is
 * create-exclusive, so the loop cannot replace it. Best effort: a failed write
 * leaves the loop's own (minimised) spill as the fallback.
 */
function spillRawBeforeCap(ctx: ToolContext, modelText: string, raw: string, minimised: boolean): string {
  if (!minimised || raw === modelText) return modelText;
  try {
    // Plan without a spill directory: planToolOutputCap materialises a spill
    // when one is given, which must not happen before the raw bytes are in
    // place. `truncated` marks the over-cap result the loop will spill for.
    const plan = planToolOutputCap(modelText);
    if (!plan.truncated) return modelText; // under the model cap: nothing spills
    const file = path.join(spillDir(ctx.workspace), `${sha256Hex(modelText)}.txt`);
    writeSpillFile({ file, contents: raw });
  } catch {
    /* the loop's own spill remains the fallback */
  }
  return modelText;
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

  // NF-072 / R-tools-39: a shell command is serial with every other shell
  // command — one exclusive barrier per call, never overlapping siblings.
  concurrencyClass: "exclusive",

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
        // NF-071: the single spawn path. A foreground command gets its ledger row
        // but no owner-death supervisor — its whole lifecycle (timeout kill,
        // abort, drain grace) is handled below, on this process's turn.
        proc = (
          await spawnOwned(["bash", "-lc", command], {
            stateDir: kernelStateDir(ctx.workspace),
            label: "shell",
            cwd: dir,
            env: scrubEnv(),
            stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
            // Own process group: `kill` below then reaches the whole tree, not just bash.
            detached: true,
            longLived: false,
          })
        ).proc;
      } catch (e) {
        return fail(`failed to start command: ${msg(e)}`);
      }

      let out = "";
      let timedOut = false;
      let aborted = false;
      const decoder = new TextDecoder();

      /** SIGKILL to the child's process group and to the child itself. */
      const hardKill = (): void => {
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

      /**
       * Terminate the tree the way `preview` does: SIGTERM to the process group
       * first so a test runner, coverage writer or package manager can flush and
       * clean up, then SIGKILL if it is still alive after the grace period.
       * SIGKILL immediately (the previous behaviour) allowed no cleanup at all.
       */
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
        graceTimer = setTimeout(hardKill, KILL_GRACE_MS);
        // A pending grace timer must never hold the process open by itself.
        if (typeof (graceTimer as { unref?: () => void }).unref === "function") (graceTimer as { unref: () => void }).unref();
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
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const minimised = minimiseShellOutput(out);
      const flag = minimised.changed
        ? `\n[output minimised: ${Buffer.byteLength(out, "utf8")} \u2192 ${Buffer.byteLength(minimised.text, "utf8")} bytes]`
        : "";
      const body = truncate(minimised.text, MAX_OUTPUT).replace(/\n+$/, "") + flag;
      const modelText = (text: string): string => spillRawBeforeCap(ctx, text, out, minimised.changed);
      if (aborted) return { ok: false, output: modelText(body), error: "aborted" };
      if (timedOut) {
        return {
          ok: false,
          output: modelText(`${body}\n[timed out after ${timeoutMs}ms]`),
          error: `timed out after ${timeoutMs}ms`,
        };
      }

      const code = proc.exitCode;
      const signal = proc.signalCode;
      const tail = `exit ${code === null ? "null" : code}${signal ? ` (signal ${signal})` : ""}`;
      return { ok: true, output: modelText(body === "" ? tail : `${body}\n${tail}`) };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
