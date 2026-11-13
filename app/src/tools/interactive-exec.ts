/**
 * `shell_session` — an additive, fail-closed, guard-authorized INTERACTIVE
 * terminal the model can drive (codex `unified_exec` exec_command + write_stdin,
 * convergent with oh-my-pi bash-interactive / bash-pty-selection).
 *
 * Why a single tool with a `mode` parameter (rather than two tools): the three
 * actions (`start`, `write`, `close`) all operate on the SAME session registry
 * and share the same guard/kill/buffer discipline. One tool with a discriminated
 * `mode` is simpler to register, keeps the session map in one module, and maps
 * cleanly onto codex's exec_command (`start`) + write_stdin (`write`) pair plus
 * an explicit close. The model picks the action with `mode`.
 *
 * Relationship to `shell.ts`: shell.ts is the ONE-SHOT path and KEEPS its
 * INTERACTIVE_BLOCKLIST (vim/less/top/REPLs...). This tool is the EXPLICIT
 * opt-in for interactivity, so it does NOT apply that blocklist — a session is
 * exactly what the model asked for. shell.ts is untouched by this file.
 *
 * Guard admission (fail-closed): every command START goes through the kernel
 * guard as a `shell.exec` effect — `ctx.guard({ kind: "shell.exec", target:
 * command })`. A `deny` refuses WITHOUT spawning; an `ask` routes through
 * `ctx.approve({ title: "Run interactive command", ... }, action)` and refuses
 * on decline. No new GuardAction kind is introduced: a PTY session is still a
 * shell.exec effect (contracts.ts unchanged; additive surface: none).
 * Admission at `start` covers only the start command: a shell/REPL session
 * runs whatever is typed next. So EVERY `write` is admitted again as a
 * `shell.exec` effect whose target is the typed input line(s) (per line, the
 * unterminated tail carried across writes and admitted once completed); deny refuses, ask prompts (showing
 * session command + input), decline writes nothing. Input containing control
 * characters (other than tab/newline) is refused: a PTY's line editing would
 * let the shell run something other than the text that was admitted. An `always` answer mints
 * the usual exact-target grant, i.e. exactly that input line. `close` only
 * kills an admitted session and needs no admission.
 *
 * Concurrency: `concurrencyClass: "exclusive"` (R-tools-39) — a terminal
 * session is serial with shell and with other sessions. loop.ts needs no change
 * (concurrencyClassOf reads this field from the registry).
 *
 * PTY selection (capability-detected, env opt-out, piped fallback): when a PTY
 * backend is available AND not opted out, the command runs under util-linux
 * `script` (`["script","-qec", command, "/dev/null"]`) so the child gets a real
 * /dev/pts tty; otherwise it runs piped (`["bash","-lc", command]`). The opt-out
 * env var is `HZ_NO_PTY=1` (analogous to oh-my-pi's PI_NO_PTY). Capability
 * detection checks `Bun.which("script")`. `canUseInteractivePty` is pure and
 * injectable so tests force PTY-vs-piped deterministically on a headless host.
 * Both argv forms go through spawnOwned and the SAME guard/kill/buffer path.
 *
 * Kill ladder / lifecycle: sessions are spawnOwned foreground owned processes
 * (longLived:false, detached:true — own process group), killed exactly like
 * shell.ts: `process.kill(-pid, "SIGTERM")` → KILL_GRACE_MS → SIGKILL to the
 * group and the child. A descendant that calls setsid() can still escape the
 * group kill — the documented residual (owned-spawn.ts header / docs/11);
 * NF-016 owns the OS-level fix. Sessions are bounded (MAX_SESSIONS), have an
 * idle timeout and an overall/wall timeout, and are killed on explicit `close`.
 *
 * Output format MATCHES codex unified_exec: `Exit code: <n>` (or `Signal:
 * <sig>` when killed), `Wall time: <s>s` (0.1s rounding), `Total output lines:
 * <n>` ONLY when the buffer was truncated/capped, then `Output:` + the
 * (minimised) buffered text. A still-running session reports its id + running
 * status + newly buffered output under `Output:` with no exit code. Over-budget
 * buffers spill via planToolOutputCap/writeSpillFile (core/output-budget.ts).
 */

import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { newId } from "../contracts";
import { sha256Hex } from "../core/canon";
import { kernelStateDir, spawnOwned, type OwnedProc } from "../core/owned-spawn";
import { kernelEnforcesProcessSandbox } from "../core/sandbox-spawn";
import { planToolOutputCap, writeSpillFile } from "../core/output-budget";
import { spillDir } from "../core/paths";
import { invisibleUnicodeError, resolvePath, scrubEnv, truncate } from "./helpers";
import { wallSeconds } from "./exec-output-format";
import { minimiseShellOutput } from "./shell";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Default idle window: a session with no read/write for this long is killed. */
const DEFAULT_IDLE_MS = 120_000;
/** How long a terminated session gets on SIGTERM before SIGKILL (shell.ts shape). */
const KILL_GRACE_MS = 2000;
/** Most live sessions at once; starting one more is refused with a typed error. */
const MAX_SESSIONS = 4;
/**
 * How long `start`/`write` wait for the child to settle before reporting it as
 * still running. A command that exits within this window reports its exit code
 * synchronously; a longer-lived one reports as running and keeps draining.
 */
const SETTLE_MS = 500;
const SETTLE_SANDBOX_MS = 1500;

async function settleMsFor(ctx: ToolContext): Promise<number> {
  if (ctx.kernel !== undefined && (await kernelEnforcesProcessSandbox(ctx.kernel))) return SETTLE_SANDBOX_MS;
  return SETTLE_MS;
}
/** Opt-out env var: `HZ_NO_PTY=1` disables the PTY backend (cf. oh-my-pi PI_NO_PTY). */
export const NO_PTY_ENV = "HZ_NO_PTY";

type SessionMode = "start" | "write" | "close";

/** One live interactive session. */
interface Session {
  id: string;
  proc: OwnedProc;
  /** The command that was guard-admitted at start (for diagnostics). */
  command: string;
  /** Rolling, capped output buffer (stop buffering past MAX_OUTPUT, keep draining). */
  buffer: string;
  /** True once the buffer hit the cap: the model sees `Total output lines:`. */
  truncated: boolean;
  /**
   * Raw (uncapped) capture for THIS read window, kept only to spill the original
   * bytes on cap. Reset with `buffer` on every `takeBuffer`, so it is both
   * bounded (never accumulates across the session lifetime) and scoped to the
   * report it backs (the spilled bytes match the truncated window reported).
   */
  rawForSpill: string;
  startedAt: number;
  lastActivity: number;
  /** Absolute wall-clock budget; the session is killed when it is exceeded. */
  overallTimeoutMs: number;
  /** Idle budget; the session is killed after this long with no read/write. */
  idleTimeoutMs: number;
  exited: boolean;
  /**
   * The unterminated tail of the input admitted so far (text written with no
   * newline yet). The next write is admitted as `partial + chunk`, so splitting
   * one command across writes cannot dodge the per-line guard.
   */
  partial: string;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Per-session guard timer: fires on idle/overall timeout and kills the tree. */
  watchdog?: ReturnType<typeof setTimeout>;
}

/** The process-wide session registry (bounded by MAX_SESSIONS). */
const sessions = new Map<string, Session>();

/** Non-exited `shell_session` count for run-level terminal.run snapshots (ruling **298**). */
export function activeShellSessionCount(): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.exited) n += 1;
  }
  return n;
}

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

export interface PtyCapabilityOptions {
  /**
   * Whether a PTY backend binary is available. Injected so tests are
   * deterministic on a headless host; production passes
   * `Bun.which("script") !== null`.
   */
  backendAvailable: boolean;
  /** The opt-out env value (`process.env.HZ_NO_PTY`); "1" disables the PTY. */
  noPtyEnv?: string | undefined;
}

/**
 * Pure, injectable PTY-selection predicate, mirroring oh-my-pi's
 * `canUseInteractiveBashPty`. Returns true ONLY when a PTY backend is actually
 * available AND the HZ_NO_PTY opt-out is not set. Kept side-effect-free so the
 * tests force PTY-vs-piped without a real tty.
 */
export function canUseInteractivePty(opts: PtyCapabilityOptions): boolean {
  if (opts.noPtyEnv === "1") return false;
  return opts.backendAvailable === true;
}

/** Live capability probe: `script` present on PATH and not opted out. */
function ptyAvailableNow(): boolean {
  return canUseInteractivePty({ backendAvailable: Bun.which("script") !== null, noPtyEnv: process.env[NO_PTY_ENV] });
}

/**
 * The argv for a command, by selection. PTY: run under util-linux `script` so
 * the child sees a real /dev/pts tty. Piped: the always-works headless path.
 */
export function sessionArgv(command: string, usePty: boolean): string[] {
  return usePty ? ["script", "-qec", command, "/dev/null"] : ["bash", "-lc", command];
}

/** SIGKILL to the session's process group and to the child itself. */
function hardKill(proc: OwnedProc): void {
  try {
    process.kill(-proc.pid, "SIGKILL"); // the child's process group (detached)
  } catch {
    /* not a group leader */
  }
  try {
    proc.kill(9);
  } catch {
    /* already gone */
  }
}

/**
 * SIGTERM to the process GROUP first (so a child can flush/clean up), then
 * SIGKILL after KILL_GRACE_MS — the exact ladder shell.ts uses. The setsid
 * escape is a documented residual (owned-spawn.ts / docs/11), not bulletproof.
 */
function killSession(session: Session): void {
  try {
    process.kill(-session.proc.pid, "SIGTERM");
  } catch {
    try {
      session.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const timer = setTimeout(() => hardKill(session.proc), KILL_GRACE_MS);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  session.killTimer = timer;
}

/** Drop a session: clear its timers and remove it from the registry. */
function dropSession(session: Session): void {
  if (session.watchdog !== undefined) clearTimeout(session.watchdog);
  if (session.killTimer !== undefined) clearTimeout(session.killTimer);
  sessions.delete(session.id);
}

/** (Re)arm the idle/overall watchdog: whichever budget expires first kills it. */
function armWatchdog(session: Session): void {
  if (session.watchdog !== undefined) clearTimeout(session.watchdog);
  if (session.exited) return;
  const now = Date.now();
  const idleDeadline = session.lastActivity + session.idleTimeoutMs;
  const overallDeadline = session.startedAt + session.overallTimeoutMs;
  const fireIn = Math.max(0, Math.min(idleDeadline, overallDeadline) - now);
  const timer = setTimeout(() => {
    if (session.exited) return;
    killSession(session);
  }, fireIn);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  session.watchdog = timer;
}

/** Start draining stdout+stderr into the session buffer; capped like shell.ts. */
function startDraining(session: Session): void {
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        session.rawForSpill += chunk;
        if (session.buffer.length >= MAX_OUTPUT) {
          session.truncated = true; // keep draining, stop buffering (shell.ts)
          continue;
        }
        session.buffer += chunk;
        if (session.buffer.length >= MAX_OUTPUT) session.truncated = true;
      }
    } catch {
      /* stream closed by a kill */
    }
  };
  void Promise.all([pump(session.proc.stdout), pump(session.proc.stderr)]).catch(() => {});
  void session.proc.exited.then(
    () => {
      session.exited = true;
    },
    () => {
      session.exited = true;
    },
  );
}

/** Wait up to `ms` for `p` to settle; resolve true when it did. */
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

/**
 * The spill discipline from shell.ts: when the buffer was capped, write the
 * ORIGINAL bytes to the exact spill path/hash the loop will compute, so the
 * model-facing text stays the minimised/capped one but the spill is the raw
 * capture. Best effort; create-exclusive so the loop cannot replace it.
 */
function spillRawBeforeCap(ctx: ToolContext, modelText: string, raw: string): string {
  if (raw === "" || raw === modelText) return modelText;
  try {
    const plan = planToolOutputCap(modelText);
    if (!plan.truncated) return modelText;
    const file = path.join(spillDir(ctx.workspace), `${sha256Hex(modelText)}.txt`);
    writeSpillFile({ file, contents: raw });
  } catch {
    /* the loop's own spill remains the fallback */
  }
  return modelText;
}

/**
 * Drain + clear the buffered output for a report; minimised like shell.ts.
 * `rawForSpill` is cleared here too, in lockstep with `buffer`, so the raw
 * capture is scoped to exactly this read window: it never grows unbounded over
 * a long-lived session, and the bytes a later cap spills match the report they
 * back (not the whole session history).
 */
function takeBuffer(session: Session): { text: string; truncated: boolean; raw: string } {
  const minimised = minimiseShellOutput(session.buffer);
  const truncated = session.truncated;
  const raw = session.rawForSpill;
  session.buffer = "";
  session.truncated = false;
  session.rawForSpill = "";
  return { text: truncate(minimised.text, MAX_OUTPUT).replace(/\n+$/, ""), truncated, raw };
}

/**
 * Render a report in the codex unified_exec shape.
 *  - running: session id + "status: running", then `Output:` + buffered text.
 *  - exited: `Exit code: <n>` / `Signal: <sig>`, `Wall time: <s>s`,
 *    `Total output lines: <n>` ONLY when truncated, then `Output:` + text.
 */
function render(
  ctx: ToolContext,
  session: Session,
  phase: "running" | "exited",
  body: { text: string; truncated: boolean; raw: string },
): string {
  const lines: string[] = [];
  if (phase === "running") {
    lines.push(`Session: ${session.id}`);
    lines.push("Status: running");
  } else {
    const code = session.proc.exitCode;
    const signal = session.proc.signalCode;
    if (signal) lines.push(`Signal: ${signal}`);
    else lines.push(`Exit code: ${code === null ? "null" : code}`);
    lines.push(`Wall time: ${wallSeconds(Date.now() - session.startedAt)}s`);
  }
  if (body.truncated) {
    const count = body.text === "" ? 0 : body.text.split("\n").length;
    lines.push(`Total output lines: ${count}`);
  }
  lines.push("Output:");
  lines.push(body.text);
  const text = lines.join("\n");
  // Spill the raw bytes for THIS read window (captured by takeBuffer before it
  // cleared the buffer), not the whole session history.
  return spillRawBeforeCap(ctx, text, body.raw);
}

async function startSession(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (typeof args.command !== "string" || args.command.trim() === "") return fail("command is required");
  const command = args.command;
  const invisibleStart = invisibleUnicodeError(command, "a shell command");
  if (invisibleStart !== undefined) return fail(invisibleStart);
  if (ctx.signal.aborted) return fail("aborted");

  // Guard admission — fail-closed, BEFORE any spawn (reuses shell.exec).
  const action: GuardAction = { kind: "shell.exec", target: command };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
  }
  if (decision.decision === "ask") {
    const approved = await ctx.approve({ title: "Run interactive command", detail: command, kind: "shell.exec" }, action);
    if (!approved) return fail("declined by user");
  }
  if (ctx.signal.aborted) return fail("aborted");

  // Bound the registry: refuse (typed) the start that would exceed the cap,
  // AFTER admission so nothing is spawned.
  if (sessions.size >= MAX_SESSIONS) {
    return fail(`session limit reached (${MAX_SESSIONS} live sessions); close one before starting another`);
  }

  const dir = typeof args.cwd === "string" && args.cwd !== "" ? resolvePath(ctx.cwd, args.cwd) : ctx.cwd;
  const overallTimeoutMs = Math.min(numberOr(args.timeoutMs, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const idleTimeoutMs = Math.min(numberOr(args.idleMs, DEFAULT_IDLE_MS), MAX_TIMEOUT_MS);
  const usePty = ptyAvailableNow();
  const argv = sessionArgv(command, usePty);

  let proc: OwnedProc;
  try {
    proc = (
      await spawnOwned(argv, {
        stateDir: kernelStateDir(ctx.workspace),
        label: "shell_session",
        cwd: dir,
        env: scrubEnv(),
        // stdin must be a pipe so `write` can feed the running session — this
        // differs from shell.ts (which ignores stdin) but it is still a
        // foreground owned spawn (longLived:false), its own process group.
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        detached: true,
        longLived: false,
        sandboxWrap: "auto",
        sandboxMode: "workspace-write",
        kernel: ctx.kernel,
      })
    ).proc;
  } catch (e) {
    return fail(`failed to start session: ${msg(e)}`);
  }

  const now = Date.now();
  const session: Session = {
    id: newId(),
    proc,
    command,
    buffer: "",
    truncated: false,
    rawForSpill: "",
    startedAt: now,
    lastActivity: now,
    overallTimeoutMs,
    idleTimeoutMs,
    exited: false,
    partial: "",
  };
  sessions.set(session.id, session);
  startDraining(session);

  // Let a short-lived command report its exit synchronously (codex shape).
  // Overall timeout does not run during this window — a short budget must not
  // expire before we can return Session / Status: running.
  const settled = await settlesWithin(session.proc.exited, await settleMsFor(ctx));
  if (settled || session.exited) {
    session.exited = true;
    const body = takeBuffer(session);
    const out = render(ctx, session, "exited", body);
    dropSession(session);
    return { ok: true, output: out };
  }
  // Still running: report id + running status + buffered output so far.
  session.startedAt = Date.now();
  session.lastActivity = Date.now();
  const body = takeBuffer(session);
  armWatchdog(session);
  return { ok: true, output: render(ctx, session, "running", body) };
}

/** Split typed text into lines on any newline form (\n, \r\n, \r). */
function inputLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * C0 control characters (and DEL) other than tab/CR/LF. Under a PTY the line
 * discipline and readline act on these (Ctrl-U kill-line, Ctrl-W, backspace,
 * Ctrl-C/D, ESC sequences), so the shell can execute something other than the
 * text the guard saw. `write` input containing any of them is refused.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
/**
 * Longest input line (complete or unterminated) a session accepts; longer is
 * refused. A tty in canonical mode holds ~4095 bytes per line and drops the
 * excess (verified on a real `script` PTY with bash: 4000 intact, 4100 cut),
 * so a longer line could run truncated, differing from the admitted text.
 * Approval prompts show the whole line, so approved text equals executed text.
 */
const MAX_LINE = 4000;
/** Per-write ceilings; they bound how many approval prompts one write can raise. */
const MAX_WRITE_LINES = 64;
const MAX_WRITE_BYTES = 64 * 1024;

/** The part of `text` after its last newline: the line still being typed. */
function unterminatedTail(text: string): string {
  const lines = inputLines(text);
  return lines[lines.length - 1] ?? "";
}

/**
 * Admit the input line(s) of one write. Each non-blank line (the carried-over
 * unterminated tail joined to the new text) goes through the kernel guard as
 * `shell.exec` with the line as target, so deny rules, allowlists, the ask
 * prompt and exact-input `always` grants apply per typed command. Returns a
 * refusal result, or undefined when every line is admitted. Nothing is written
 * to stdin before this returns undefined.
 */
async function admitInput(session: Session, input: string, ctx: ToolContext): Promise<ToolResult | undefined> {
  // Only COMPLETE lines are admitted now; the unterminated tail is carried
  // (see `partial`) and admitted once a later write completes it, so a
  // fragment never prompts on its own. Nothing executes before a newline.
  const complete = inputLines(session.partial + input).slice(0, -1);
  const lines = [...new Set(complete.map((l) => l.trim()).filter((l) => l !== ""))];
  for (const line of lines) {
    const action: GuardAction = { kind: "shell.exec", target: line };
    const decision = await ctx.guard(action);
    if (decision.decision === "deny") {
      return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
    }
    if (decision.decision === "ask") {
      const approved = await ctx.approve(
        { title: "Send input to interactive session", detail: `${session.command} <- ${line}`, kind: "shell.exec" },
        action,
      );
      if (!approved) return fail("declined by user");
    }
  }
  return undefined;
}

async function writeToSession(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.signal.aborted) return fail("aborted");
  if (typeof args.sessionId !== "string" || args.sessionId === "") return fail("sessionId is required");
  const session = sessions.get(args.sessionId);
  if (session === undefined) return fail(`no such session: ${args.sessionId}`);
  if (session.exited) {
    const body = takeBuffer(session);
    const out = render(ctx, session, "exited", body);
    dropSession(session);
    return { ok: true, output: out };
  }
  const rawInput = typeof args.input === "string" ? args.input : "";
  // Normalize every newline form to "\n" BEFORE admission and the write. Admission
  // splits on \r too, but a piped bash does not: it would run "a\rb" as ONE
  // command while the guard saw "a" and "b". Writing the normalized text makes
  // the admitted lines exactly the lines the shell executes, on PTY and pipe.
  const input = rawInput.replace(/\r\n|\r/g, "\n");
  if (CONTROL_CHARS.test(input)) {
    return fail("control characters are not allowed in shell_session input (only tab and newline)");
  }
  const invisible = invisibleUnicodeError(input, "shell_session input");
  if (invisible !== undefined) return fail(invisible);
  const sentLines = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
  if (sentLines.length > MAX_WRITE_LINES || Buffer.byteLength(input, "utf8") > MAX_WRITE_BYTES) {
    return fail(`input too large for one write (max ${MAX_WRITE_LINES} lines and ${MAX_WRITE_BYTES / 1024} KiB); send it in smaller writes`);
  }
  if (inputLines(session.partial + input).some((l) => Buffer.byteLength(l, "utf8") > MAX_LINE)) {
    return fail(`input line too long (max ${MAX_LINE} bytes per line); send shorter lines`);
  }
  // Fail-closed: admission at start covers ONLY the start command. A shell or
  // REPL session executes whatever is typed next, so every write is admitted
  // as a shell.exec effect whose target is the typed input line(s).
  const admission = await admitInput(session, input, ctx);
  if (admission !== undefined) return admission;
  if (ctx.signal.aborted) return fail("aborted");
  try {
    const writer = (session.proc.stdin as unknown as { write(chunk: string): void; flush?: () => void }) ?? undefined;
    if (writer === undefined || typeof writer.write !== "function") {
      return fail("session stdin is not writable");
    }
    writer.write(input);
    if (typeof writer.flush === "function") writer.flush();
  } catch (e) {
    return fail(`failed to write to session: ${msg(e)}`);
  }
  session.partial = unterminatedTail(session.partial + input);
  session.lastActivity = Date.now();
  armWatchdog(session);

  const settled = await settlesWithin(session.proc.exited, await settleMsFor(ctx));
  if (settled || session.exited) {
    session.exited = true;
    const body = takeBuffer(session);
    const out = render(ctx, session, "exited", body);
    dropSession(session);
    return { ok: true, output: out };
  }
  const body = takeBuffer(session);
  armWatchdog(session);
  return { ok: true, output: render(ctx, session, "running", body) };
}

async function closeSession(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  if (typeof args.sessionId !== "string" || args.sessionId === "") return fail("sessionId is required");
  const session = sessions.get(args.sessionId);
  if (session === undefined) return fail(`no such session: ${args.sessionId}`);
  if (!session.exited) killSession(session);
  const wasRunning = !session.exited;
  dropSession(session);
  return { ok: true, output: `Session ${session.id} closed${wasRunning ? " (terminated)" : ""}.` };
}

export const interactiveExecTool: Tool = {
  name: "shell_session",
  description:
    "Drive an interactive terminal session: start a command in a persistent PTY-backed session (mode:start), feed it stdin (mode:write), or terminate it (mode:close). Unlike the one-shot shell tool, this is the explicit opt-in for interactive programs. Every start, and every input line written later, is authorized as its own shell.exec effect.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["start", "write", "close"],
        description: "start a new session, write stdin to a running one, or close it.",
      },
      command: { type: "string", description: "The command line to run (mode:start)." },
      input: { type: "string", description: "Text to feed to the session's stdin (mode:write). Include a trailing newline to submit a line." },
      sessionId: { type: "string", description: "The session id returned by a start (mode:write / mode:close)." },
      cwd: { type: "string", description: "Working directory relative to the workspace (mode:start; default: workspace)." },
      timeoutMs: { type: "number", description: `Overall wall-clock budget in ms (mode:start; default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
      idleMs: { type: "number", description: `Idle timeout in ms with no read/write before the session is killed (mode:start; default ${DEFAULT_IDLE_MS}).` },
    },
    required: ["mode"],
  },

  // R-tools-39: a terminal session is serial with shell and other sessions.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mode = args.mode as SessionMode | undefined;
      if (mode === "start") return await startSession(args, ctx);
      if (mode === "write") return await writeToSession(args, ctx);
      if (mode === "close") return await closeSession(args, ctx);
      return fail('mode is required (one of "start", "write", "close")');
    } catch (e) {
      return fail(msg(e));
    }
  },
};

/** Test-only: number of live sessions in the registry. */
export function liveSessionCount(): number {
  return sessions.size;
}

/**
 * Test-only: the length of a live session's raw-spill capture. Lets a test
 * prove `rawForSpill` is scoped per read window (reset in `takeBuffer`) and so
 * neither grows unbounded across the session lifetime nor spills stale bytes.
 * Returns -1 when the session is unknown.
 */
export function rawForSpillLengthForTest(sessionId: string): number {
  const session = sessions.get(sessionId);
  return session === undefined ? -1 : session.rawForSpill.length;
}

/** Test-only: force-drop every session (kills live ones). Keeps suites isolated. */
export function resetSessionsForTest(): void {
  for (const session of [...sessions.values()]) {
    if (!session.exited) killSession(session);
    dropSession(session);
  }
}
