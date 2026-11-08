/**
 * hooks.ts — pre/post tool hooks (the 'hooks' half of the parity roadmap's
 * MCP/hooks/LSP open item).
 *
 * WHY. A hook is the user's own last word about a tool call: a program that
 * sees the call before it runs, or the settled result after, and may only ever
 * make the session MORE restrictive — deny, never allow, never rewrite. The
 * corpus ratifies a full design for this: docs/15 §2.4 (H1-H10), §3.4
 * (`HookV1`), §4.6 (points), §6.4 (dispatch), §7.4 (sandboxing); docs/05
 * §4.12 (`HookDefV1`/`HookBindingV1`) and §4.15.3 (the lifecycle event list —
 * `before_tool_call`/`after_tool_call` are the two points v1 ships, spelled
 * `pre_tool`/`post_tool` here); docs/24 NF-066. This module implements the
 * REDUCED FORM of that design. The invariants it DOES honour are enforced
 * where they are used:
 *
 *   H2  a hook may deny or observe, never allow: a deny from Guard is never
 *       revisited, and a hook `allow` only means "no objection here";
 *   H3  a failing hook at the DECIDING point (preTool) denies the call;
 *   H4  a failing hook at the OBSERVATION point (postTool) is recorded as a
 *       notice + `hook.failure` event and never blocks;
 *   H5/§6.4 first deny wins and later hooks do not run (short-circuit: a hook
 *       that already refused should not spend the user's tokens on seven more
 *       agreeing hooks); declaration order is the deterministic order v1 has;
 *   H8  post output can never undo or rewrite the settled effect.
 *
 * REDUCED FORM vs the ratified design — every difference is named on purpose,
 * and each is a residual until the v2 surface lands:
 *
 *   - Points: only `tool.pre`/`tool.post` of the 16-point taxonomy (H1);
 *     session/step/commit/compaction points are not wired in v1.
 *   - Config: v1 reads `hooks.json` directly — user `~/.config/horizon/` (or
 *     legacy `~/.hzcode/` IN PLACE), workspace `<ws>/.hz/` (or legacy
 *     `<ws>/.hzcode/` in place); paths.ts owns that rule. docs/15 §3.9/§4.1
 *     puts the file at `hooks/hooks.json`; the schema here is the reduced
 *     `{hooks:{preTool?,postTool?}}` shape, not `HookV1`/`HookDefV1`: no
 *     `priority`, no `capability`/`if` matcher (exact tool names or `*`), no
 *     `once`, `sync`, `asyncRewake` or declared `capabilities`.
 *   - Protocol: one JSON line in, one JSON line out (`{decision:'allow'}` or
 *     `{decision:'deny', reason}`), NOT the ratified exit-code contract
 *     (0 pass / 10 ask / 20 deny). `ask` stays out of v1: anything that is
 *     not an exact allow/deny object is an unclassified output and fails
 *     closed (H3), and so does the exit-10 wake mechanism. The bounded-note /
 *     context-fragment channel (H9) is not implemented — a clean hook's only
 *     effect is its decision.
 *   - Trust (H7/D31): a workspace hook is NOT yet trust-gated. The repo has no
 *     trust store in v1 (config.ts's MCP note makes the same admission), so a
 *     cloned repository can name a hook program; the mitigation v1 has is the
 *     owned-spawn ledger, which records every hook run. The trust record is a
 *     named residual that must land before hooks can be called `VERIFIED`.
 *   - Receipts (H6/§1.2): a hook run is not yet a receipted `terminal.run`
 *     effect; only the spawn-ledger row exists. NF-066's "ordinary effects"
 *     classification is future work.
 *   - Environment/sandbox: `scrubEnv()` (credential-scrubbed inheritance)
 *     rather than the ratified cleared allow-list with HZ_* variables; cwd is
 *     the workspace root; the child is detached so a timeout kill reaches its
 *     whole tree. stdout is bounded at 64 KiB and the stderr tail at 4 KiB.
 *   - Timeouts: per hook (default 5 s, hard maximum 300 s), not H5's one
 *     shared per-point deadline.
 *
 * FAIL-CLOSED CONFIG. A malformed `hooks.json` must never silently weaken the
 * configured posture — a deny-hook that fails to load must not look like "no
 * hooks". One bad file turns the whole config into a refusal state in which
 * EVERY tool call denies, and the reason names the file and the parse error.
 * That is the same philosophy as kernel.ts's malformed policy.json (a dropped
 * rule could drop a deny). An ABSENT config is `none` and costs nothing: two
 * failed stats, no spawn, no event.
 *
 * NO ARGUMENT REWRITING. A hook returns a decision, never new arguments.
 * Rewriting would reopen every question the original call already answered
 * (the full-intent digest, the lease, the receipt) and would need re-guarding
 * end to end, so it is explicitly deferred to a design that does that; in v1
 * a hook can only say no. `postTool` output can never rewrite or undo the
 * settled effect (H8).
 *
 * WHERE IT SITS. The integrator runs `runPreToolHooks` AFTER the guard/approve
 * decision and BEFORE `tool.execute`: a hook deny returns the standard typed
 * tool-result shape; it can never turn a guard deny back into an allow. A
 * `runPostToolHooks` call observes the settled result and never changes it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { scrubEnv } from "../tools/helpers";
import { kernelStateDir, spawnOwned, type OwnedProc } from "./owned-spawn";
import { stateRoot, userConfigDir } from "./paths";

/** Per-hook budget when `timeoutMs` is absent; the ratified default is 10 s, v1's is 5 s. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;
/** The ratified hard maximum (docs/15 §7.4, 300 s); a larger value is a config error. */
export const MAX_HOOK_TIMEOUT_MS = 300_000;
/** How much of the model-facing tool result a `post_tool` hook sees (~4 KB). */
export const HOOK_OUTPUT_EXCERPT_CAP = 4 * 1024;
/** stdout bound: a hook writes ONE line, so more than this is a flood, not a protocol. */
const MAX_STDOUT_BYTES = 64 * 1024;
/** stderr tail kept for the failure message. */
const MAX_STDERR_BYTES = 4 * 1024;
/** SIGTERM -> SIGKILL grace when a hook overruns its budget. */
const KILL_GRACE_MS = 300;
/** The stderr tail included in a failure reason. */
const STDERR_TAIL_CHARS = 1_000;

/* --------------------------------- the schema --------------------------------- */

/** `match` is a filter, never authority: a hook that does not match simply does not run. */
export interface HookMatch {
  /** Exact tool name(s), or `"*"` for every tool. Absent = every tool. */
  tool?: string | string[];
}

/** One hook definition as written in `hooks.json` (the reduced `HookDefV1`). */
export interface HookDef {
  match?: HookMatch;
  command: string;
  args?: string[];
  /** Per-hook budget in ms; default `DEFAULT_HOOK_TIMEOUT_MS`, hard max `MAX_HOOK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export type HookPoint = "preTool" | "postTool";

/** A validated hook, ready to run: defaults applied, position fixed. */
export interface LoadedHook {
  point: HookPoint;
  /** Position in the MERGED execution order for this point (user file, then workspace). */
  index: number;
  /** The config file this hook came from. */
  source: string;
  command: string;
  args: string[];
  timeoutMs: number;
  /** Absent = every tool; otherwise exact names, with `"*"` meaning every tool. */
  tools?: string[];
}

/** One malformed config file: the refusal names it and the parse error. */
export interface HookConfigRefusal {
  file: string;
  error: string;
}

/**
 * The load result. `none` = nothing configured (zero cost); `refused` = at
 * least one file is malformed and EVERY pre call denies until it is fixed;
 * `ready` = validated hooks in merged order, user file first.
 */
export type HooksConfig =
  | { state: "none" }
  | { state: "ready"; preTool: LoadedHook[]; postTool: LoadedHook[]; sources: string[] }
  | { state: "refused"; refusals: HookConfigRefusal[] };

export interface HooksOptions {
  /** Override the home directory (tests, or a caller with its own notion of home). */
  home?: string;
}

/** What `runPreToolHooks` returns; a deny names its cause. */
export type HookDecision = { decision: "allow" } | { decision: "deny"; reason: string };

/** The call context every hook run receives. */
export interface HookContext {
  sessionId: string;
  workspace: string;
  callId: string;
  tool: string;
  /** The parsed tool arguments, exactly as the tool would receive them. */
  args: Record<string, unknown>;
  /** Human-facing message hook (a failing post hook). Must not throw. */
  onNotice?: (message: string) => void;
  /** Audit hook: 'hook.decision' / 'hook.failure' payloads for the event log. Must not throw. */
  onEvent?: (type: string, payload: unknown) => void;
}

/** `postTool` adds the settled result; the excerpt is capped by this module. */
export interface PostToolHookContext extends HookContext {
  ok: boolean;
  ms: number;
  /** The model-facing tool result text; capped at `HOOK_OUTPUT_EXCERPT_CAP` before it is sent. */
  outputExcerpt: string;
}

/* ------------------------------ paths and loading ------------------------------ */

/**
 * The config files that apply, in load order: the user file first, then the
 * workspace file. The user path resolves through paths.ts's rule (an existing
 * `~/.hzcode/` is honoured IN PLACE); the workspace path is `stateRoot()`'s
 * decision (`<ws>/.hz/hooks.json` canonical, `<ws>/.hzcode/hooks.json` legacy
 * in place). An absent home contributes no file.
 */
export function hooksConfigFiles(workspace: string, opts: HooksOptions = {}): string[] {
  const files: string[] = [];
  let home = opts.home;
  if (home === undefined) {
    try {
      home = homedir();
    } catch {
      home = "";
    }
  }
  if (home !== "") files.push(path.join(userConfigDir(home), "hooks.json"));
  files.push(path.join(stateRoot(workspace), "hooks.json"));
  return files;
}

/** A genuine absence (ENOENT) is the only read error that may mean "nothing there". */
function isFileGone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate one hook entry. Returns the hook, or a readable reason string. */
function parseHookDef(source: string, point: HookPoint, index: number, value: unknown): LoadedHook | string {
  const where = `${point}[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "match" && key !== "command" && key !== "args" && key !== "timeoutMs") {
      return `${where}: unknown key ${JSON.stringify(key)} (allowed: command, args, match, timeoutMs)`;
    }
  }
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (command === "") return `${where}.command must be a non-empty string`;
  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string" || a === "")) {
      return `${where}.args must be an array of non-empty strings`;
    }
    args = [...(raw.args as string[])];
  }
  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== "number" ||
      !Number.isInteger(raw.timeoutMs) ||
      raw.timeoutMs < 1 ||
      raw.timeoutMs > MAX_HOOK_TIMEOUT_MS
    ) {
      return `${where}.timeoutMs must be an integer between 1 and ${MAX_HOOK_TIMEOUT_MS}`;
    }
    timeoutMs = raw.timeoutMs;
  }
  let tools: string[] | undefined;
  if (raw.match !== undefined) {
    if (raw.match === null || typeof raw.match !== "object" || Array.isArray(raw.match)) {
      return `${where}.match must be an object`;
    }
    const match = raw.match as Record<string, unknown>;
    for (const key of Object.keys(match)) {
      if (key !== "tool") return `${where}.match: unknown key ${JSON.stringify(key)} (allowed: tool)`;
    }
    if (match.tool !== undefined) {
      if (typeof match.tool === "string") {
        const tool = match.tool.trim();
        if (tool === "") return `${where}.match.tool must be a non-empty tool name or "*"`;
        tools = [tool];
      } else if (Array.isArray(match.tool)) {
        if (match.tool.length === 0) {
          return `${where}.match.tool is an empty list, which would silently disable the hook; name the tools, or omit match for every tool`;
        }
        if (match.tool.some((t) => typeof t !== "string" || t.trim() === "")) {
          return `${where}.match.tool must be an array of non-empty tool names or "*"`;
        }
        tools = match.tool.map((t) => (t as string).trim());
      } else {
        return `${where}.match.tool must be a tool name, an array of names, or "*"`;
      }
    }
  }
  const hook: LoadedHook = { point, index, source, command, args, timeoutMs };
  if (tools !== undefined) hook.tools = tools;
  return hook;
}

/** Parse one file's {hooks:{preTool?,postTool?}} document; the first error refuses the file. */
function parseHooksDocument(
  source: string,
  text: string,
): { preTool: LoadedHook[]; postTool: LoadedHook[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${errorMessage(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "expected a JSON object at the top level" };
  }
  const top = parsed as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== "hooks") return { error: `unknown key ${JSON.stringify(key)} (allowed: hooks)` };
  }
  const hooks = top.hooks;
  if (hooks === undefined || hooks === null) return { error: "missing the `hooks` object" };
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    return { error: "`hooks` must be an object with optional preTool/postTool arrays" };
  }
  const points = hooks as Record<string, unknown>;
  for (const key of Object.keys(points)) {
    if (key !== "preTool" && key !== "postTool") {
      return { error: `unknown key hooks.${JSON.stringify(key)} (allowed: preTool, postTool)` };
    }
  }
  const out = { preTool: [] as LoadedHook[], postTool: [] as LoadedHook[] };
  for (const point of ["preTool", "postTool"] as const) {
    const list = points[point];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return { error: `${point} must be an array of hook definitions` };
    for (let index = 0; index < list.length; index += 1) {
      const hook = parseHookDef(source, point, index, list[index]);
      if (typeof hook === "string") return { error: hook };
      out[point].push(hook);
    }
  }
  return out;
}

/**
 * Load the hooks that apply to `workspace`. Absent config = `none`; malformed
 * config = `refused` (every pre call will deny); otherwise the merged,
 * validated lists, user file first. This never throws: a bad file is a typed
 * refusal, not a crash.
 */
export function loadHooks(workspace: string, opts: HooksOptions = {}): HooksConfig {
  const refusals: HookConfigRefusal[] = [];
  const preTool: LoadedHook[] = [];
  const postTool: LoadedHook[] = [];
  const sources: string[] = [];
  for (const file of hooksConfigFiles(workspace, opts)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (isFileGone(err)) continue;
      refusals.push({ file, error: `cannot be read: ${errorMessage(err)}` });
      continue;
    }
    // An empty file is NOT "no hooks": it cannot be shown to be the file the
    // user meant, so it refuses like any other malformed document.
    const parsed = parseHooksDocument(file, text);
    if ("error" in parsed) {
      refusals.push({ file, error: parsed.error });
      continue;
    }
    sources.push(file);
    // Reassign `index` to the merged order so labels are unique across files.
    for (const hook of parsed.preTool) preTool.push({ ...hook, index: preTool.length });
    for (const hook of parsed.postTool) postTool.push({ ...hook, index: postTool.length });
  }
  if (refusals.length > 0) return { state: "refused", refusals };
  if (sources.length === 0) return { state: "none" };
  return { state: "ready", preTool, postTool, sources };
}

/** The one typed refusal text every tool call denies with while a file is bad. */
function refusalReason(refusals: readonly HookConfigRefusal[]): string {
  const parts = refusals.map((r) => `${r.file} is malformed: ${r.error}`);
  return `HZ_PRECONDITION_FAILED: hooks config ${parts.join("; ")}; every tool call is denied until it is fixed (fail-closed)`;
}

/* ------------------------------- running hooks ------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable, human-readable hook identity for events and failure reasons. */
function hookLabel(hook: LoadedHook): string {
  return `${hook.command} (${hook.point}[${hook.index}])`;
}

function matchesTool(hook: LoadedHook, tool: string): boolean {
  if (hook.tools === undefined) return true;
  return hook.tools.includes("*") || hook.tools.includes(tool);
}

/** Listener errors must not break the hook path (a notice is not worth a crash). */
function emitEvent(ctx: HookContext, type: "hook.decision" | "hook.failure", payload: Record<string, unknown>): void {
  try {
    ctx.onEvent?.(type, payload);
  } catch {
    /* the caller's listener failed; the decision still stands */
  }
}

function notice(ctx: HookContext, message: string): void {
  try {
    ctx.onNotice?.(message);
  } catch {
    /* the caller's listener failed; the hook outcome still stands */
  }
}

function preToolInput(ctx: HookContext): Record<string, unknown> {
  return { event: "pre_tool", sessionId: ctx.sessionId, callId: ctx.callId, tool: ctx.tool, args: ctx.args };
}

function postToolInput(ctx: PostToolHookContext): Record<string, unknown> {
  const ms = typeof ctx.ms === "number" && Number.isFinite(ctx.ms) ? Math.max(0, Math.floor(ctx.ms)) : 0;
  const excerpt = typeof ctx.outputExcerpt === "string" ? ctx.outputExcerpt : "";
  return {
    event: "post_tool",
    sessionId: ctx.sessionId,
    callId: ctx.callId,
    tool: ctx.tool,
    ok: ctx.ok === true,
    ms,
    outputExcerpt: excerpt.length > HOOK_OUTPUT_EXCERPT_CAP ? excerpt.slice(0, HOOK_OUTPUT_EXCERPT_CAP) : excerpt,
  };
}

/** SIGTERM, then SIGKILL, to the hook's whole process group (it is detached). */
async function killGroup(proc: OwnedProc): Promise<void> {
  try {
    (proc.stdin as unknown as { end?: () => void })?.end?.();
  } catch {
    /* stdin already closed */
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid, sig); // the hook's process group (spawned detached)
    } catch {
      try {
        proc.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  await sleep(KILL_GRACE_MS);
  let alive = true;
  try {
    process.kill(proc.pid, 0);
  } catch {
    alive = false;
  }
  if (alive) signal("SIGKILL");
}

/** Write the one input line, flush it, and close stdin (some hooks read to EOF). */
async function writeInput(proc: OwnedProc, line: string): Promise<string | undefined> {
  const sink = proc.stdin as unknown as { write(data: string): unknown; flush?: () => Promise<number> | void; end?: () => void };
  try {
    sink.write(line);
    await sink.flush?.();
    sink.end?.();
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

interface CappedText {
  text: string;
  /** True when the stream produced more than the cap; the reader was cancelled. */
  overflow: boolean;
}

/** Read a stream to its end, bounded at `cap` bytes (the reader is cancelled on overflow). */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<CappedText> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      text += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
      if (bytes > cap) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return { text, overflow: true };
      }
    }
  } catch {
    /* the stream is closed by a kill; the outcome path reports the failure */
  }
  return { text, overflow: false };
}

/** Resolve `promise` by `ms`, falling back to `fallback` — and clear the timer either way. */
function withDeadline<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const settle = (value: T): void => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(fallback));
  });
}

/** The stderr tail appended to a failure reason, when the hook wrote anything. */
function stderrSuffix(stderr: string): string {
  const text = stderr.trim();
  if (text === "") return "";
  const tail = text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text;
  return `; stderr: ${tail}`;
}

/** One JSON line -> one JSON object; anything else is a failure (H3/H4 apply it). */
function parseHookOutput(
  text: string,
): { kind: "ok"; output: Record<string, unknown> } | { kind: "failure"; error: string } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return { kind: "failure", error: "wrote no output (expected exactly one JSON line on stdout)" };
  if (lines.length > 1) return { kind: "failure", error: `wrote ${lines.length} lines to stdout (expected exactly one JSON line)` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0] as string);
  } catch (err) {
    return { kind: "failure", error: `stdout is not valid JSON: ${errorMessage(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "failure", error: "stdout is not a JSON object" };
  }
  return { kind: "ok", output: parsed as Record<string, unknown> };
}

/** The pre-tool decision, strictly: exactly `{decision:'allow'}` or `{decision:'deny',reason}`. */
function parsePreDecision(output: Record<string, unknown>): HookDecision | string {
  const keys = Object.keys(output);
  if (output.decision === "allow") {
    const extra = keys.filter((key) => key !== "decision");
    if (extra.length > 0) return `allow carries unexpected field(s): ${extra.join(", ")}`;
    return { decision: "allow" };
  }
  if (output.decision === "deny") {
    const extra = keys.filter((key) => key !== "decision" && key !== "reason");
    if (extra.length > 0) return `deny carries unexpected field(s): ${extra.join(", ")}`;
    const reason = typeof output.reason === "string" ? output.reason.trim() : "";
    if (reason === "") return "deny requires a non-empty reason";
    return { decision: "deny", reason };
  }
  return `unclassified decision ${JSON.stringify(output.decision ?? null)} (expected "allow" or "deny")`;
}

/**
 * Spawn one hook, hand it its one input line, and collect its one output line.
 * Every failure mode — spawn error, write error, timeout, non-zero exit,
 * missing/extra/garbage output — comes back as `{kind:'failure'}`; the caller
 * decides what a failure means at its point (H3 deny / H4 notice).
 */
async function runHook(
  hook: LoadedHook,
  input: Record<string, unknown>,
  workspace: string,
): Promise<{ kind: "ok"; output: Record<string, unknown> } | { kind: "failure"; error: string }> {
  let proc: OwnedProc;
  try {
    ({ proc } = await spawnOwned([hook.command, ...hook.args], {
      stateDir: kernelStateDir(workspace),
      // The ledger row is the audit trail v1 has for "this hook ran" (NF-071).
      label: `hook:${hook.point}:${hook.index}`,
      cwd: workspace,
      env: scrubEnv(),
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      // Its own process group, so the timeout kill reaches the whole tree; a
      // bounded foreground child gets no owner-death supervisor (owned-spawn).
      detached: true,
      longLived: false,
    }));
  } catch (err) {
    return { kind: "failure", error: `could not start ${hook.command}: ${errorMessage(err)}` };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killGroup(proc);
  }, hook.timeoutMs);

  try {
    const writeError = await withDeadline(
      writeInput(proc, `${JSON.stringify(input)}\n`),
      "the hook did not accept its input in time",
      hook.timeoutMs + KILL_GRACE_MS + 1_000,
    );
    if (writeError !== undefined && !timedOut) {
      void killGroup(proc);
      return { kind: "failure", error: `could not write the hook input: ${writeError}` };
    }
    const [stdout, stderr, code] = await Promise.all([
      readCapped(proc.stdout, MAX_STDOUT_BYTES),
      readCapped(proc.stderr, MAX_STDERR_BYTES),
      proc.exited.catch(() => -1),
    ]);
    // Overflow and the timeout are both reported before the exit code: a flood
    // is its own failure even though the kill that stopped it reports a signal.
    if (stdout.overflow) {
      return { kind: "failure", error: `wrote more than ${MAX_STDOUT_BYTES} bytes to stdout (expected exactly one JSON line)` };
    }
    if (timedOut) return { kind: "failure", error: `timed out after ${hook.timeoutMs}ms` };
    if (code !== 0) return { kind: "failure", error: `exited with code ${code}${stderrSuffix(stderr.text)}` };
    return parseHookOutput(stdout.text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the `preTool` hooks for one call, in declaration order (user file first).
 * Returns `{decision:'allow'}` when no hook objects, and the FIRST deny
 * otherwise: later hooks do not run (H5/§6.4 short-circuit). A refused config
 * denies every call, naming the malformed file(s) and the parse error(s); a
 * hook failure denies, naming the hook and the failure (H3). Emits
 * `hook.decision` per deciding hook and `hook.failure` per failed one.
 */
export async function runPreToolHooks(config: HooksConfig, ctx: HookContext): Promise<HookDecision> {
  if (config.state === "none") return { decision: "allow" };
  if (config.state === "refused") {
    const reason = refusalReason(config.refusals);
    emitEvent(ctx, "hook.decision", {
      tool: ctx.tool,
      hook: config.refusals.map((r) => r.file).join(", "),
      decision: "deny",
      reason,
    });
    return { decision: "deny", reason };
  }
  for (const hook of config.preTool) {
    if (!matchesTool(hook, ctx.tool)) continue;
    const result = await runHook(hook, preToolInput(ctx), ctx.workspace);
    if (result.kind === "failure") {
      const reason = `hook_denied: ${hookLabel(hook)} failed (${hook.source}): ${result.error}`;
      emitEvent(ctx, "hook.failure", { tool: ctx.tool, hook: hookLabel(hook), error: result.error });
      emitEvent(ctx, "hook.decision", { tool: ctx.tool, hook: hookLabel(hook), decision: "deny", reason });
      return { decision: "deny", reason };
    }
    const decision = parsePreDecision(result.output);
    if (typeof decision === "string") {
      // An output that parsed as JSON but is not a decision is a protocol
      // failure, exactly like garbage bytes (H3).
      const reason = `hook_denied: ${hookLabel(hook)} failed (${hook.source}): ${decision}`;
      emitEvent(ctx, "hook.failure", { tool: ctx.tool, hook: hookLabel(hook), error: decision });
      emitEvent(ctx, "hook.decision", { tool: ctx.tool, hook: hookLabel(hook), decision: "deny", reason });
      return { decision: "deny", reason };
    }
    if (decision.decision === "deny") {
      const reason = `hook_denied: ${hookLabel(hook)}: ${decision.reason}`;
      emitEvent(ctx, "hook.decision", { tool: ctx.tool, hook: hookLabel(hook), decision: "deny", reason });
      return { decision: "deny", reason };
    }
    emitEvent(ctx, "hook.decision", { tool: ctx.tool, hook: hookLabel(hook), decision: "allow" });
  }
  return { decision: "allow" };
}

/**
 * Run the `postTool` hooks for one settled call, in declaration order. This
 * function never throws and never changes the result: a failed hook becomes a
 * `hook.failure` event plus an `onNotice` message (H4/H8), and the loop
 * continues with the remaining hooks. A `none` config does nothing; a
 * `refused` config does nothing here too — its posture already denies every
 * pre call, so a post hook can only fire where the config is `ready`.
 */
export async function runPostToolHooks(config: HooksConfig, ctx: PostToolHookContext): Promise<void> {
  if (config.state !== "ready") return;
  for (const hook of config.postTool) {
    if (!matchesTool(hook, ctx.tool)) continue;
    const result = await runHook(hook, postToolInput(ctx), ctx.workspace);
    if (result.kind === "failure") {
      emitEvent(ctx, "hook.failure", { tool: ctx.tool, hook: hookLabel(hook), error: result.error });
      notice(ctx, `hook_failed: ${hookLabel(hook)} at ${hook.source}: ${result.error} — the tool result is unchanged`);
    }
    // A clean post output is observation-only: no decision, no context change.
  }
}
