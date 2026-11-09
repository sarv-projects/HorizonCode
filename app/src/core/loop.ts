/**
 * loop.ts — one turn of the conversation.
 *
 * The loop streams an assistant turn, executes the tool calls it produced (one at
 * a time, through the guard), feeds the results back and repeats until the model
 * stops asking for tools, the human aborts, or the 25-call ceiling is reached.
 *
 * Two rules are absolute here: nothing may escape to the caller (a turn always
 * ends with a turn.done event) and every tool that ran leaves a receipt.
 */

import * as path from "node:path";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import type {
  ActorRef,
  ApprovalHandler,
  ApprovalRequest,
  ChatMsg,
  DelegateRunner,
  GuardAction,
  GuardDecision,
  Lease,
  PolicyScope,
  Provider,
  ProviderRequest,
  ReceiptInput,
  RunBudget,
  RunExit,
  RuntimeCallbacks,
  RuntimeEvent,
  ToolCall,
  ToolContext,
  ToolResult,
  Usage,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { getTool, toolSpecs } from "../tools";
import { projectExactEdit } from "../tools/edit";
import { canonicalJson, sha256Hex } from "./canon";
// The window's compaction: one replacement for the silent slice, imported here
// and nowhere else (compaction.ts holds the pinning, the summary and the
// report; the loop only chooses the window size).
import { COMPACTION_EVENT, compactHistory } from "./compaction";
// The project-memory hierarchy (docs/10 R121-R123): discovery, caps, skip
// refusal and rendering live in instructions.ts; the loop only carries it.
import { instructionPrompt, loadInstructionBlocks } from "./instructions";
// The plan-mode staging store (session-scoped): write/edit calls are staged
// instead of applied while the user has plan mode on; the TUI reviews the
// staged diffs with /changes and applies them with /apply (each apply passes
// the ordinary guard/approval path).
import { stageWrite, unifiedDiff } from "./plan";
// The MCP tool registry (docs/09 §4.7): mcp__ tools admit as `mcp.invoke`.
import { mcpAdmissionFor } from "./mcp/registry";
// Hooks v1 (docs/15 H2–H4 reduced form): pre/post tool middleware that can
// only narrow — a pre deny sinks into the standard tool-result shape, a post
// failure is a notice (see hooks.ts for the named differences from HookV1).
import { loadHooks, runPostToolHooks, runPreToolHooks, type HooksConfig } from "./hooks";
import { recordPostmortem, type FailureClass, type TranscriptEvent } from "./postmortem";
import {
  estimatePromptTokens,
  estimateTokens,
  fitMaxOutputTokens,
  FRAMING_CHARGE_TOKENS,
  planToolOutputCap,
  windowForModel,
} from "./output-budget";
import type { KernelClient } from "./kernel";
import { resolvedInside, resolveSymlinkChain } from "./kernel";
import { realpathish, spillDir as workspaceSpillDir, workspaceStateDir } from "./paths";
import type { SessionStore } from "./session";

// The symlink-aware resolution moved to paths.ts (the single state-path
// resolver); re-exported so every existing `from "./loop"` import keeps working.
export { realpathish };

// The lexical symlink walk lives in kernel.ts, next to the protected-path rule
// that depends on it (one implementation, no import cycle through the tool
// registry); re-exported so every existing `from "./loop"` import keeps working.
export { resolvedInside, resolveSymlinkChain };

/** Hard ceiling on provider calls inside a single send(). */
export const MAX_PROVIDER_CALLS = 25;
/** Messages replayed to the provider, newest last. */
export const HISTORY_LIMIT = 80;
export const SESSION_LEASE_TTL_MS = 15 * 60 * 1000;

/** NF-073: consecutive invalid-JSON batches before the run is failed. */
export const MAX_CONSECUTIVE_FORMAT_ERRORS = 3;

/* --------------------------- approval registry --------------------------- */

/**
 * The one approval handler for this process (the TUI registers its prompt here).
 * It fails closed: until a human is attached, every ask is a no.
 */
let approvalHandler: ApprovalHandler = async () => false;

export function setApprovalHandler(fn: ApprovalHandler): void {
  approvalHandler = typeof fn === "function" ? fn : async () => false;
}

export function getApprovalHandler(): ApprovalHandler {
  return approvalHandler;
}

/* -------------------------------- helpers -------------------------------- */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Never let a UI callback break a turn. */
export function emit(cb: RuntimeCallbacks, event: RuntimeEvent): void {
  try {
    cb?.onEvent?.(event);
  } catch {
    /* the transcript is already durable; a rendering failure is not fatal */
  }
}

function firstLine(text: string, max = 80): string {
  const line = (typeof text === "string" ? text : "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  const value = line ?? "";
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 3)) + "...";
}

function truncateForEvent(text: string, max: number): string {
  const value = typeof text === "string" ? text : "";
  return value.length <= max ? value : value.slice(0, max) + "\u2026";
}

/** The session title is the first line of the first thing the human said. */
export function titleFromText(text: string): string {
  const line =
    (typeof text === "string" ? text : "")
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  if (line === "") return "New chat";
  return line.length > 60 ? line.slice(0, 57) + "..." : line;
}

/**
 * The system prompt is deliberately short: identity, place, day, tone, and the one
 * harness rule the model cannot infer from a tool description (the read-before-write
 * gate in ./tools/read-ledger.ts refuses an unread target, and an unannounced
 * refusal costs a round trip).
 */
export function systemPrompt(workspace: string, today: Date = new Date()): string {
  const stamp = Number.isNaN(today.getTime()) ? "" : today.toISOString().slice(0, 10);
  return [
    "You are HzCode, a coding agent in the user's terminal.",
    `Working directory: ${workspace}`,
    `Today's date: ${stamp}`,
    "Be concise. Use tools for real work.",
    "Before replacing or fuzzy-editing a file that already exists, read it in this session: write and edit refuse a target they have not seen.",
    "Finish with a check: before you report a task done — including marking your own last todo item done — run the repository's tests, typecheck or build in this same run. A run that changes files and runs no check is recorded as an unverified completion, never a success.",
  ].join("\n");
}

export function parseArguments(raw: string): { args: Record<string, unknown>; error?: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { args: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return { args: value as Record<string, unknown> };
    return { args: {}, error: "arguments must be a JSON object" };
  } catch (err) {
    return { args: {}, error: errorMessage(err) };
  }
}

/** True when `rel` names the root itself, an ancestor of it, or another root. */
function escapes(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/**
 * True when `target` resolves inside the workspace root. Both sides are
 * resolved through the lexical symlink walk first, so a link inside the
 * workspace pointing outside is classified by where it actually lands, not by
 * its spelling — including a dangling link, whose target need not exist. A
 * walk that cannot complete (a loop) classifies as outside, the stricter scope.
 */
export function pathInsideWorkspace(target: string, workspace: string): boolean {
  if (typeof target !== "string" || target === "") return false;
  const root = path.resolve(workspace);
  return resolvedInside(path.resolve(root, target), root) === true;
}

/**
 * Workspace scope is a path question; commands, urls and spawns are not paths, so
 * they are checked against the `*` rules (which is how DEFAULT_POLICY lists
 * shell.exec, net.fetch and spawn: ask).
 */
export function scopeFor(action: GuardAction, workspace: string): PolicyScope {
  if (action.kind === "fs.read" || action.kind === "fs.write") {
    return pathInsideWorkspace(action.target, workspace) ? "workspace" : "outside";
  }
  return "*";
}

function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * The first file path an `apply_patch` body names, for a stable coarse
 * admission target (the tool re-guards every file itself). Reads only the
 * freeform grammar's `*** Add/Update/Delete File:` headers; returns undefined
 * when none is present (a malformed patch the parser will reject downstream).
 */
function firstApplyPatchPath(input: string): string | undefined {
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    for (const marker of ["*** Add File: ", "*** Update File: ", "*** Delete File: "]) {
      if (line.startsWith(marker)) {
        const p = line.slice(marker.length).trim();
        if (p !== "") return p;
      }
    }
  }
  return undefined;
}

/**
 * The guard action a tool call implies, using the same path resolution the tools
 * themselves use. Every registered tool appears in the mapping table below or
 * in `SESSION_STATE_TOOLS`; a tool with neither is refused before execution
 * (`admissionFor`).
 */
export function guardActionFor(name: string, args: Record<string, unknown>, workspace: string): GuardAction | undefined {
  const resolved = (value: string): string => path.resolve(workspace, value);
  // MCP tools are dynamic: their admission comes from the registry that defines
  // them (`mcp.invoke`, target `<serverId>:<toolName>`), never from the static
  // table below.
  const mcp = mcpAdmissionFor(name);
  if (mcp !== undefined) return mcp;
  switch (name) {
    case "read": {
      const file = argString(args, "path", "file");
      return file ? { kind: "fs.read", target: resolved(file) } : undefined;
    }
    case "glob":
    case "grep": {
      const root = argString(args, "path", "dir", "cwd") ?? ".";
      return { kind: "fs.read", target: resolved(root) };
    }
    case "repo_map": {
      const root = argString(args, "path", "dir", "cwd") ?? ".";
      return { kind: "fs.read", target: resolved(root) };
    }
    case "write":
    case "edit": {
      const file = argString(args, "path", "file_path", "file");
      return file ? { kind: "fs.write", target: resolved(file) } : undefined;
    }
    case "apply_patch": {
      // The patch text carries one or more file operations; the tool issues a
      // per-file `fs.write` guard for every one of them. The coarse loop-level
      // admission is a single `fs.write` keyed to the first file the patch
      // names (so the approval and the cache have a stable target), falling
      // back to a digest of the patch when no path can be read out.
      const input = typeof args.input === "string" ? args.input : "";
      const first = firstApplyPatchPath(input);
      return {
        kind: "fs.write",
        target: first !== undefined ? resolved(first) : `apply_patch ${sha256Hex(input).slice(0, 16)}`,
      };
    }
    case "shell":
    case "bash": {
      const command = argString(args, "command", "cmd");
      return command ? { kind: "shell.exec", target: command } : undefined;
    }
    case "agent": {
      const task = argString(args, "task") ?? "";
      return { kind: "spawn", target: taskHead(task === "" ? "(no task)" : task) };
    }
    case "code_mode": {
      const code = typeof args.code === "string" ? args.code : "";
      return { kind: "spawn", target: `code_mode ${sha256Hex(code).slice(0, 16)}` };
    }
    case "preview": {
      // `start` runs a command: the same shell.exec admission the tool itself
      // performs (one approval, not two). A command the tool resolves from
      // package.json is guarded inside the tool at resolution time; status and
      // stop only touch the session's own preview registry.
      const previewAction = argString(args, "action");
      const command = argString(args, "command");
      if (previewAction !== "start" || command === undefined) return undefined;
      return { kind: "shell.exec", target: command };
    }
    case "undo": {
      // The effect target is the journal's recorded change, which no argument
      // names. A `path` argument admits as that file's fs.write; without one the
      // call is session-state (below) and the tool guards the resolved entry
      // itself, exactly like preview's start path.
      const file = argString(args, "path", "file");
      return file ? { kind: "fs.write", target: resolved(file) } : undefined;
    }
    default:
      return undefined;
  }
}

/** A one-line naming head of `text` (whitespace collapsed), at most `max` characters. */
export function taskHead(text: string, max = 120): string {
  const line = (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return line.slice(0, Math.max(0, max - 3)) + "...";
}

/**
 * Tools that only touch session-scoped state (docs/09 R-tools-30's in-process
 * mirror): they are mapped — never silently unguarded — but need no kernel
 * guard action. `todo` is session state; `preview`'s spawn path is guarded as
 * described in the mapping above; `undo` reads the session's own change journal
 * to find its target and guards that entry inside the tool.
 */
export const SESSION_STATE_TOOLS: readonly string[] = ["todo", "preview", "undo"] as const;

/** What one tool call's admission is: a guard action, or session-state. */
export type ToolAdmission = { kind: "guard"; action: GuardAction } | { kind: "session-state" };

/**
 * Every tool call passes one admission before it runs. A guard admission
 * carries the action to check; a session-state admission is the in-process
 * mirror. `undefined` is the fail-closed answer for a tool with no mapping:
 * executeTool refuses it rather than running it unguarded.
 */
export function admissionFor(name: string, args: Record<string, unknown>, workspace: string): ToolAdmission | undefined {
  const action = guardActionFor(name, args, workspace);
  if (action !== undefined) return { kind: "guard", action };
  if ((SESSION_STATE_TOOLS as readonly string[]).includes(name)) return { kind: "session-state" };
  return undefined;
}

/**
 * Bind an action to the full operation intent: the canonical digest of the
 * call's arguments rides in `detail.argsDigest`, so the approval cache can tell
 * one write of X (content A) from another (content B) — see GuardGate. The
 * effective cwd also rides along (`detail.cwd`): a digest-less tool-level check
 * of the same kind+target must not inherit an admission made for a different
 * working directory (`npm run dev` in a vs the same command in b).
 */
function withCallIntent(action: GuardAction, args: Record<string, unknown>, workspace: string): GuardAction {
  const explicit = typeof args.cwd === "string" && args.cwd.trim() !== "" ? path.resolve(workspace, args.cwd) : path.resolve(workspace);
  return {
    ...action,
    detail: { ...(action.detail ?? {}), argsDigest: sha256Hex(canonicalJson(args)), cwd: explicit },
  };
}

/**
 * NF-072 batch scheduling. Every tool carries a concurrency class: `shared`
 * calls in one batch run concurrently; an `exclusive` call is its own barrier
 * (`docs/24` NF-072). Unknown tools are pure error paths and share.
 */
export function concurrencyClassOf(name: string): "shared" | "exclusive" {
  return getTool(name)?.concurrencyClass === "exclusive" ? "exclusive" : "shared";
}

/** Split a batch into execution segments: a shared run, then an exclusive barrier, then the next run. */
export function batchSegments(calls: ToolCall[]): ToolCall[][] {
  const segments: ToolCall[][] = [];
  let shared: ToolCall[] = [];
  for (const call of calls) {
    if (concurrencyClassOf(call.name) === "exclusive") {
      if (shared.length > 0) segments.push(shared);
      shared = [];
      segments.push([call]);
    } else {
      shared.push(call);
    }
  }
  if (shared.length > 0) segments.push(shared);
  return segments;
}

/** Keep the newest messages, starting at a user turn so the replay stays valid. */
export function trimHistory(messages: ChatMsg[], limit = HISTORY_LIMIT): ChatMsg[] {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= limit) return list;
  const out = list.slice(-limit);
  while (out.length > 0 && out[0]?.role !== "user") out.shift();
  return out;
}

/**
 * The bound on the pinned task statement. A rail is a reminder, not a second
 * copy of the conversation: what the session was asked to do, not everything
 * said about it.
 */
export const PINNED_TASK_MAX_CHARS = 1200;

/**
 * The session's task statement, for the system rail.
 *
 * `trimHistory` keeps the NEWEST messages, so the turn that stated the task is
 * the first thing to fall out of the window: after enough turns the request no
 * longer carries the constraints it was given at all (measured on a 46-turn
 * session — the final request held 80 messages beginning mid-conversation, and
 * the task line was absent from the whole payload).
 *
 * The statement therefore rides the system rail — in context on every step,
 * never a history rewrite — the same way the budget countdown does. It is read
 * from the store rather than remembered in memory, so it survives a resume as
 * well as a trim. The FIRST user turn is the task; later user turns are
 * follow-ups and are deliberately not pinned.
 */
export function pinnedTaskStatement(messages: ChatMsg[]): string | undefined {
  const first = (Array.isArray(messages) ? messages : []).find(
    (msg) => msg.role === "user" && typeof msg.content === "string" && msg.content.trim() !== "",
  );
  if (first === undefined) return undefined;
  const text = (first.content ?? "").trim();
  const bounded = text.length <= PINNED_TASK_MAX_CHARS ? text : `${text.slice(0, PINNED_TASK_MAX_CHARS)}\u2026`;
  return `Pinned task statement — the first user turn, kept in context after older turns are trimmed:\n${bounded}`;
}

function displayTarget(target: string, workspace: string): string {
  if (typeof target !== "string" || target === "") return "";
  if (!path.isAbsolute(target)) return target;
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, target);
  return resolved !== root && !escapes(root, resolved) ? path.relative(root, resolved) : target;
}

function approvalRequestFor(name: string, action: GuardAction, workspace: string): ApprovalRequest {
  const shown = displayTarget(action.target, workspace);
  switch (action.kind) {
    case "shell.exec":
      return { title: "run this command", detail: action.target, kind: action.kind };
    case "fs.read":
      return { title: `read ${shown}`, detail: action.target, kind: action.kind };
    case "fs.write":
      return { title: `write ${shown}`, detail: action.target, kind: action.kind };
    case "net.fetch":
      return { title: `fetch ${shown}`, detail: action.target, kind: action.kind };
    case "spawn":
      return { title: `spawn ${shown}`, detail: action.target, kind: action.kind };
    case "mcp.invoke":
      return { title: `call MCP tool ${shown}`, detail: action.target, kind: action.kind };
    default:
      return { title: `${name} ${shown}`.trim(), detail: action.target, kind: "other" };
  }
}

function normalizeToolResult(result: ToolResult | undefined | null): ToolResult {
  if (!result || typeof result !== "object") {
    return { ok: false, output: "tool returned nothing", error: "tool returned nothing" };
  }
  const output = typeof result.output === "string" ? result.output : "";
  if (result.ok) return { ok: true, output };
  const error = typeof result.error === "string" && result.error !== "" ? result.error : output === "" ? "tool failed" : output;
  return { ok: false, output, error };
}

/** What the model sees as the tool's answer; `text` is the capped output. */
function toolMessageContent(result: ToolResult, text: string): string {
  if (result.ok) return text === "" ? "(no output)" : text;
  const reason = typeof result.error === "string" && result.error !== "" ? result.error : text;
  return reason === "" ? "tool failed" : reason;
}

export function streamFor(sessionId: string): string {
  return `session:${sessionId}`;
}

/** lstat that answers undefined for "nothing there", throwing on anything else. */
function lstatOrUndefined(file: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Persist a planned spill WITHOUT ever following a link. The file name is
 * `sha256(full output)` — model-chosen content, so the model can predict the
 * name and plant a dangling symlink there; a plain writeFileSync (which
 * follows links) then creates the link's target anywhere — the confirmed
 * out-of-workspace `.bashrc` write. The rules:
 *
 *  - lstat first (it sees a dangling link; existsSync does not): anything that
 *    is not a regular file is refused with a typed notice and the run goes on
 *    (spilling is best-effort);
 *  - create with O_CREAT|O_EXCL|O_NOFOLLOW, 0600: even a race that lands
 *    between the lstat and the open cannot follow a link into another path;
 *  - EEXIST re-checks with lstat: an existing regular file under the same
 *    sha256 name already holds exactly these bytes (dedupe, skip); anything
 *    else is refused.
 *
 * Returns the refusal notice, or undefined when the spill was written or
 * already present as a regular file.
 */
export function writeSpillSafely(file: string, contents: string): string | undefined {
  const refusal = `refusing to spill: ${file} is not a regular file`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    return `could not spill the full output: ${errorMessage(err)}`;
  }
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatOrUndefined(file);
  } catch (err) {
    return `could not spill the full output: ${errorMessage(err)}`;
  }
  if (existing !== undefined) {
    // A regular file under this name is the same bytes by construction: dedupe.
    return existing.isFile() ? undefined : refusal;
  }
  try {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
    try {
      writeSync(fd, contents, undefined, "utf8");
    } finally {
      closeSync(fd);
    }
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST" || code === "ELOOP") {
      // Something appeared between the lstat and the open. Re-check: a regular
      // file is the dedupe case; a link or anything else is refused.
      try {
        const raced = lstatOrUndefined(file);
        if (raced !== undefined && raced.isFile()) return undefined;
        return refusal;
      } catch (again) {
        return `could not spill the full output: ${errorMessage(again)}`;
      }
    }
    return `could not spill the full output: ${errorMessage(err)}`;
  }
}

/** The spill directory as the marker shows it: relative to the workspace. */
function displaySpillPath(workspace: string): string {
  const relative = path.relative(path.resolve(workspace), workspaceSpillDir(workspace));
  return relative === "" || relative.startsWith("..") ? workspaceSpillDir(workspace) : relative;
}

/* ------------------------------- guard gate ------------------------------- */

/**
 * The approval handler as the gate calls it: the plain ApprovalHandler plus the
 * context the human side needs to scope a grant — the action (its target), the
 * kernel client (to mint a session-scoped lease) and the session id the check
 * speaks for. Extra arguments are invisible to handlers that do not know them.
 */
type ApprovalWithContext = (
  req: ApprovalRequest,
  action?: GuardAction,
  kernel?: KernelClient,
  sessionId?: string,
) => Promise<boolean>;

/**
 * The one place approvals are decided for a turn. Guessing twice about the same
 * action is bad manners (and two prompts for one shell command is a bug), so an
 * action that was allowed stays allowed for the rest of the turn. Under NF-072
 * concurrent batch siblings share this gate, so every decision is serialized
 * and an approval names the action it answers.
 *
 * The cache key is the action's full context: kind + target + the effective cwd
 * it was admitted for (or the scope, when no cwd is attached). A digest-less
 * tool-level check never inherits an approval from a different cwd — it either
 * rides the loop decision of the call it belongs to (`check(action, parent)`)
 * or matches an entry recorded under its own context.
 */
export class GuardGate {
  /**
   * family (`kind\0target\0context`) -> intent digest -> decision. The intent
   * digest is the call's canonical arguments digest; "" is a tool-level check
   * (the tool admitting the call the loop already decided).
   */
  private readonly resolved = new Map<string, Map<string, { leaseId?: string }>>();
  private pending: GuardAction | null = null;
  /** One decision at a time: concurrent batch siblings are serialized here. */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    private readonly kernel: KernelClient,
    private readonly leases: Lease[],
    private readonly handler: () => ApprovalHandler,
    /** The session every check from this gate speaks for (owner-scoped leases). */
    private readonly sessionId?: string,
  ) {}

  private familyOf(action: GuardAction): string {
    return `${action.kind}\u0000${action.target}\u0000${this.contextOf(action)}`;
  }

  /**
   * The effective context of a check: the cwd the action is admitted for when
   * the caller attached one, else the action's scope. Two checks that differ
   * only in cwd therefore never share a cached approval.
   */
  private contextOf(action: GuardAction): string {
    const cwd = action.detail?.cwd;
    if (typeof cwd === "string" && cwd !== "") return `cwd:${cwd}`;
    return `scope:${scopeFor(action, this.workspace)}`;
  }

  /** The full-intent digest the caller attached; "" when it attached none. */
  private static intentOf(action: GuardAction): string {
    const digest = action.detail?.argsDigest;
    return typeof digest === "string" && digest !== "" ? digest : "";
  }

  /**
   * A cached decision for the action, under an EXACT (family, intent) match.
   * A digest-less check (intent "") matches only an entry recorded for a
   * digest-less check of the same kind+target+context — it never inherits an
   * admission made for different arguments. That inheritance was the finding:
   * approving a write of f.txt with content A let a digest-less write of f.txt
   * with content B run with no ask (the code_mode bridge calls ctx.guard with
   * no digest). A check that knows its arguments must carry their canonical
   * digest; a check that does not gets a fresh evaluation.
   */
  private cached(action: GuardAction): { leaseId?: string } | undefined {
    const family = this.resolved.get(this.familyOf(action));
    if (family === undefined) return undefined;
    return family.get(GuardGate.intentOf(action));
  }

  private remember(action: GuardAction, entry: { leaseId?: string }): void {
    const family = this.familyOf(action);
    let bucket = this.resolved.get(family);
    if (bucket === undefined) {
      bucket = new Map();
      this.resolved.set(family, bucket);
    }
    bucket.set(GuardGate.intentOf(action), entry);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(task, task);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Decide one action. A tool-level check passes the loop action it belongs to
   * as `parent`: the decision for that exact full-intent admission is reused
   * when the check admits the SAME kind and target, so a sibling — or a stale
   * entry from another cwd — can never answer for this call, and a different
   * action can never ride it. Without a matching parent, a check answers only
   * for its own exact intent (see cached): no digest, no reuse.
   */
  async check(action: GuardAction, parent?: GuardAction): Promise<GuardDecision> {
    return this.serialize(async () => {
      // A tool-level check rides the loop decision only for the action the loop
      // actually admitted: same kind AND same target. A check for a different
      // action is never answered by the parent's admission — that is the same
      // class of inheritance the family cache must not allow (finding 11), and
      // it is how a code_mode bridge call is decided on its own merits.
      const rides =
        parent !== undefined && parent.kind === action.kind && parent.target === action.target ? parent : undefined;
      const cached = (rides !== undefined ? this.cached(rides) : undefined) ?? this.cached(action);
      if (cached) return { decision: "allow" as const, reason: "already allowed in this turn", leaseId: cached.leaseId };
      let decision: GuardDecision;
      try {
        decision = await this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases, this.sessionId);
      } catch (err) {
        // Fail closed: an unreachable guard is a deny, never a silent allow.
        return { decision: "deny" as const, reason: `guard unavailable: ${errorMessage(err)}` };
      }
      if (decision.decision === "ask") this.pending = action;
      else if (decision.decision === "allow") this.remember(action, { leaseId: decision.leaseId });
      return decision;
    });
  }

  /**
   * Approve `req`, naming the action it answers when the caller knows it. With
   * concurrent siblings each holding a pending ask, the answer must name its
   * question; `pending` is only the fallback for callers that cannot (the
   * legacy single-slot behaviour).
   */
  async approve(req: ApprovalRequest, action?: GuardAction): Promise<boolean> {
    return this.serialize(() => this.approveNow(req, action));
  }

  private async approveNow(req: ApprovalRequest, action?: GuardAction): Promise<boolean> {
    const waiting = action ?? this.pending ?? undefined;
    let ok = false;
    try {
      // The handler sees the action so an "always" answer can be scoped to its
      // target, and the kernel client so the lease is minted for THIS session:
      // a child session's checks never inherit it (docs/09 R-tools-32).
      ok = await (this.handler() as unknown as ApprovalWithContext)(req, waiting, this.kernel, this.sessionId);
    } catch {
      ok = false;
    }
    if (ok && waiting) this.remember(waiting, { leaseId: undefined });
    if (this.pending !== null && this.pending === waiting) this.pending = null;
    return ok;
  }

  /** The lease that covered this action, when the kernel granted one. */
  leaseFor(action: GuardAction): string | undefined {
    return this.cached(action)?.leaseId;
  }
}

/* --------------------- NF-073: the budget ceiling --------------------- */

export type BudgetStop = "steps" | "tokens" | "wall_clock";

export interface BudgetCountdown {
  steps?: number; // remaining steps, omitted when unlimited
  tokens?: number; // remaining tokens, omitted when unlimited
  wallMs?: number; // remaining wall clock, omitted when unlimited
}

/**
 * The spend ceiling for one run tree (NF-073). The main turn and every subagent
 * it spawns draw from the same ledger — a child gets its own slice via child()
 * but still checks and charges its parent — so a batch of children can never
 * spend past the ceiling the human set. Every mutation is serialized on a
 * promise-chain mutex: two concurrent children cannot both pass the last slot.
 */
export class BudgetLedger {
  private stepsUsed = 0;
  private tokensUsed = 0;
  private readonly startedAt: number;
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limits: RunBudget,
    private readonly parent?: BudgetLedger,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.startedAt = this.clock();
  }

  private serialize<T>(task: () => T): Promise<T> {
    const run = this.mutex.then(task, task);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One child slice: checks the parent first, charges both. */
  child(limits: RunBudget): BudgetLedger {
    return new BudgetLedger(limits, this, this.clock);
  }

  private checkSync(): BudgetStop | undefined {
    if (this.parent) {
      const fromParent = this.parent.checkSync();
      if (fromParent) return fromParent;
    }
    const maxSteps = this.limits.maxSteps ?? 0;
    const maxTokens = this.limits.maxTokens ?? 0;
    const maxWallMs = this.limits.maxWallMs ?? 0;
    if (maxSteps > 0 && this.stepsUsed >= maxSteps) return "steps";
    if (maxTokens > 0 && this.tokensUsed >= maxTokens) return "tokens";
    if (maxWallMs > 0 && this.clock() - this.startedAt >= maxWallMs) return "wall_clock";
    return undefined;
  }

  /** The single sentinel check: consulted before every provider dispatch. */
  check(): Promise<BudgetStop | undefined> {
    return this.serialize(() => this.checkSync());
  }

  /** Charge one dispatch; a billed-but-failed turn is still charged. */
  async chargeStep(): Promise<void> {
    await this.serialize(() => {
      this.stepsUsed += 1;
    });
    if (this.parent) await this.parent.chargeStep();
  }

  /** Charge reported usage; zero/absent usage adds nothing extra. */
  async chargeTokens(n: number): Promise<void> {
    const amount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (amount === 0) return;
    await this.serialize(() => {
      this.tokensUsed += amount;
    });
    if (this.parent) await this.parent.chargeTokens(amount);
  }

  consumed(): { steps: number; tokens: number; wallMs: number } {
    return {
      steps: this.stepsUsed,
      tokens: this.tokensUsed,
      wallMs: Math.max(0, this.clock() - this.startedAt),
    };
  }

  /** What remains, limited dimensions only (rendered into the step prompt). */
  countdown(): BudgetCountdown {
    const out: BudgetCountdown = {};
    const remaining = (max: number | undefined, used: number): number | undefined =>
      max !== undefined && max > 0 ? Math.max(0, max - used) : undefined;
    const steps = remaining(this.limits.maxSteps, this.stepsUsed);
    const tokens = remaining(this.limits.maxTokens, this.tokensUsed);
    const wall = remaining(this.limits.maxWallMs, this.clock() - this.startedAt);
    if (steps !== undefined) out.steps = steps;
    if (tokens !== undefined) out.tokens = tokens;
    if (wall !== undefined) out.wallMs = wall;
    return out;
  }
}

/** "Budget remaining: 12 steps, ~8m30s." — only the limited dimensions. */
export function budgetCountdownLine(countdown: BudgetCountdown): string {
  const parts: string[] = [];
  if (countdown.steps !== undefined) parts.push(`${countdown.steps} step${countdown.steps === 1 ? "" : "s"}`);
  if (countdown.tokens !== undefined) parts.push(`${countdown.tokens.toLocaleString("en-US")} tokens`);
  if (countdown.wallMs !== undefined) {
    const seconds = Math.ceil(countdown.wallMs / 1000);
    const minutes = Math.floor(seconds / 60);
    parts.push(minutes > 0 ? `~${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `~${seconds}s`);
  }
  return parts.length === 0 ? "" : `Budget remaining: ${parts.join(", ")}.`;
}

/**
 * Canonical exit code for a run outcome (docs/14 §3.2) — the ONE table every
 * surface maps through (S16 forbids restating it, so a surface that computes
 * its own is a defect by construction).
 *
 *   0 success · 1 error · 2 usage · 3 fail-closed/UNKNOWN · 4 policy denial ·
 *   5 budget exhaustion · 130 SIGINT · 143 SIGTERM
 *
 * The signal codes are the caller's to add: this maps a run outcome, and a run
 * killed by a signal may not have produced one.
 */
export function exitCodeFor(exit: RunExit | undefined): number {
  if (!exit) return 0;
  switch (exit.terminal) {
    case "succeeded":
      return 0;
    case "budget_exhausted":
    case "timeout":
      return 5;
    case "cancelled":
    case "interrupted":
      return 130;
    case "denied":
      // Policy said no: distinct from an error, and never reported as success.
      return 4;
    case "unknown":
      // Fail-closed: the effect cannot be proven to have happened or not.
      return 3;
    default:
      // failed — provider, tool, storage or internal error.
      return 1;
  }
}

/* ------------------------------ the turn ------------------------------ */

export interface LoopDeps {
  workspace: string;
  sessionId: string;
  model: string;
  provider: Provider;
  kernel: KernelClient;
  store: SessionStore;
  signal: AbortSignal;
  callbacks: RuntimeCallbacks;
  /** Session-scoped leases (grantLease) consulted by every guard check. */
  sessionLeases: Lease[];
  /** Instance-level approval handler; falls back to the process-wide one. */
  approve?: ApprovalHandler;
  /** Extra system-prompt section for this run (skills). Appended after the base. */
  systemExtra?: string;
  /** Replaces the base system prompt entirely (the subagent's focused prompt). */
  systemOverride?: string;
  /** Restricts which tools this run may see and call (the subagent excludes itself). */
  toolFilter?: (name: string) => boolean;
  /** Provider-call ceiling for this run; defaults to MAX_PROVIDER_CALLS. */
  maxProviderCalls?: number;
  /** NF-073 run budget (0 or absent per dimension = unlimited); used when `ledger` is absent. */
  budget?: RunBudget;
  /** NF-073 shared spend ceiling for a run tree; a passed ledger wins over `budget`. */
  ledger?: BudgetLedger;
  /** Nested delegation runner (the `agent` tool); absent in child runs. */
  delegate?: DelegateRunner;
  /**
   * Plan mode (the user's toggle): `write`/`edit` calls stage a diff the user
   * reviews with /changes and applies with /apply; shell, undo, preview, agent
   * and code_mode are refused; read-only tools are unaffected.
   */
  planMode?: boolean;
  /** Loaded hooks (tests inject; absent = loaded once per run from config). */
  hooks?: HooksConfig;
}

interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "abort";
  usage?: Usage;
  error?: string;
}

/**
 * Per-run failure bookkeeping (wave-12 findings: the swallowed event-log
 * failure and the swallowed tool-result transcript failure). A run that lost
 * audit-trail events, receipts or transcript rows must never report
 * `succeeded`; each class is counted here and folded into ONE run-level failure
 * when the turn ends — the exit detail stays the machine-readable
 * `internal_error`, while the failure message names every count and its first
 * underlying error.
 */
class RunFaults {
  private eventLogCount = 0;
  private eventLogFirst = "";
  private receiptCount = 0;
  private receiptFirst = "";
  private transcriptCount = 0;
  private transcriptFirst = "";

  /** Record one failed event-log append; true exactly on the first failure. */
  noteEventLog(err: unknown): boolean {
    this.eventLogCount += 1;
    if (this.eventLogFirst === "") {
      this.eventLogFirst = errorMessage(err);
      return true;
    }
    return false;
  }

  /** Record one failed receipt issuance (its caller keeps the per-call notice). */
  noteReceipt(err: unknown): void {
    this.receiptCount += 1;
    if (this.receiptFirst === "") this.receiptFirst = errorMessage(err);
  }

  /** Record one failed tool-result transcript write; `tool` names the call. */
  noteTranscript(tool: string, err: unknown): void {
    this.transcriptCount += 1;
    if (this.transcriptFirst === "") this.transcriptFirst = `${tool}: ${errorMessage(err)}`;
  }

  /** The one run-level failure message, or undefined on a clean run. */
  failureMessage(): string | undefined {
    const parts: string[] = [];
    if (this.eventLogCount > 0) parts.push(`event log append failed ${this.eventLogCount} time(s): ${this.eventLogFirst}`);
    if (this.receiptCount > 0) parts.push(`receipt issuance failed ${this.receiptCount} time(s): ${this.receiptFirst}`);
    if (this.transcriptCount > 0)
      parts.push(`transcript write failed ${this.transcriptCount} time(s) after the effect ran: ${this.transcriptFirst}`);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
}

/**
 * Per-run completion evidence (harness-engineering lecture 09: "done" must be an
 * objective determination, not the model's own claim). Two halves:
 *
 * - Advisory: a run that changed files and never ran anything
 *   verification-shaped gets a notice and an audit-trail event.
 * - Blocking: when it ALSO marked its own declared work complete (a successful
 *   `todo done`, nothing left open), the exit becomes `unknown` — the outcome
 *   cannot be proven either way, and a completion claim with no check must not
 *   report success (exit code 3, fail-closed).
 *
 * The command test is a HEURISTIC on the command line, deliberately broad: a
 * false positive costs a missing warning, never a blocked run. Named residual: a
 * verification invoked from inside a `code_mode` program is invisible to this
 * counter, which sees only top-level tool calls.
 */
const VERIFICATION_SHAPE =
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun|deno|npx)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|check|build|tsc)|(?:^|[\s;&|(])(?:pytest|jest|vitest|mocha|cargo|go\s+test|make|tsc|eslint|ruff|mypy|flake8)\b/;

/** Audit-trail event: a run changed files and ran nothing that verifies them. */
export const UNVERIFIED_COMPLETION_EVENT = "run.unverified_completion";

/** What one run changed, whether anything checked it, and what it claimed done. */
class RunEvidence {
  private readonly changed = new Set<string>();
  private verified: string | undefined;
  private todosAdded = 0;
  private todosOpen = 0;
  private todoClaims = 0;

  /** A successful write/edit of `path`. */
  noteMutation(path: unknown): void {
    if (typeof path === "string" && path !== "") this.changed.add(path);
  }

  /**
   * A shell command that RAN (the shell tool reports ok for any completed
   * command, including a non-zero exit — a failing test run is still a check).
   */
  noteCommand(command: unknown): void {
    if (this.verified === undefined && typeof command === "string" && VERIFICATION_SHAPE.test(command)) {
      this.verified = command;
    }
  }

  /**
   * A successful `todo` call. `done` is the completion CLAIM the blocking half
   * of the gate keys on — the model marking its own declared work complete
   * (today the only claim surface that exists; `complete_step` is designed in
   * docs/09-tools.md, not implemented).
   */
  noteTodoCall(action: unknown): void {
    if (action === "add") {
      this.todosAdded += 1;
      this.todosOpen += 1;
    } else if (action === "done") {
      this.todoClaims += 1;
      this.todosOpen = Math.max(0, this.todosOpen - 1);
    }
  }

  /** The changed paths when nothing verified them, or undefined. */
  unverified(): string[] | undefined {
    return this.verified === undefined && this.changed.size > 0 ? [...this.changed] : undefined;
  }

  /**
   * The blocking half of lecture 09: the changed paths when the run ALSO
   * declared a work item complete (a successful `todo done`, with nothing left
   * open) and ran no verification. A completion claim with no check is not a
   * success; it is an outcome that cannot be proven either way — `unknown`.
   */
  claimWithoutVerification(): string[] | undefined {
    if (this.todoClaims === 0 || this.todosOpen > 0) return undefined;
    return this.unverified();
  }

  /** Declared work the run left open (the under-finished plan), for a notice. */
  openPlan(): { open: number; added: number } | undefined {
    return this.todosOpen > 0 && this.todosAdded > 0 ? { open: this.todosOpen, added: this.todosAdded } : undefined;
  }
}

/**
 * A tool result that could not be written to the transcript after the tool's
 * effect already happened. The run must stop at this boundary: replaying a
 * step whose tool results are not in the history would continue from a
 * transcript that no longer matches what ran.
 */
class TranscriptAppendError extends Error {}

async function logEvent(
  deps: LoopDeps,
  faults: RunFaults,
  type: string,
  payload: unknown,
  actor: ActorRef = { kind: "agent", id: "hzcode" },
): Promise<void> {
  try {
    const stream = streamFor(deps.sessionId);
    await deps.kernel.appendEvent(stream, { id: newId(), ts: nowIso(), stream, type, actor, payload });
  } catch (err) {
    // SQLite holds the transcript; the hash-chained log is the audit trail. A
    // log failure must never take the chat down, but it must not pass silently
    // either: the FIRST failure is named once, and the run stops reporting
    // success — the final exit carries the count and the underlying error.
    if (faults.noteEventLog(err)) {
      emit(deps.callbacks, {
        type: "notice",
        message: `event log append failed: ${errorMessage(err)} — the audit trail is incomplete; this run will not report success`,
      });
    }
  }
}

async function beginUserTurn(deps: LoopDeps, faults: RunFaults, prompt: string): Promise<void> {
  if (prompt === "") return;
  const first = deps.store.messageCount(deps.sessionId) === 0;
  deps.store.appendMessage(deps.sessionId, { role: "user", content: prompt });
  await logEvent(deps, faults, EventTypes.messageStart, { role: "user" }, { kind: "human", id: "user" });
  await logEvent(deps, faults, EventTypes.messageEnd, { role: "user", text: prompt }, { kind: "human", id: "user" });
  if (first) deps.store.touchSession(deps.sessionId, titleFromText(prompt));
}

async function collectAssistant(
  deps: LoopDeps,
  history: ChatMsg[],
  rails?: {
    /** The task statement, pinned against trimming (see `pinnedTaskStatement`). */
    pinned?: string;
    budgetLine?: string;
    corrective?: string;
    anchorBase?: number;
    appendedTokens?: number;
    /** The project-instruction section (docs/10 R121-R123); "" when none. */
    instructions?: string;
    /** The plan-mode rail line when the user has plan mode on. */
    planLine?: string;
  },
): Promise<AssistantTurn> {
  const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "end" };
  const basePrompt =
    deps.systemOverride !== undefined && deps.systemOverride !== ""
      ? deps.systemOverride
      : systemPrompt(deps.workspace) + (rails?.instructions ?? "");
  const extra = deps.systemExtra !== undefined && deps.systemExtra !== "" ? `\n\n${deps.systemExtra}` : "";
  // NF-073(b): the live budget countdown and the format corrective ride the
  // system rail — in context on every step, never a history rewrite. The task
  // statement rides it too, for the same reason: a history rewrite cannot keep
  // it, because the window only ever keeps the newest messages.
  const railParts: string[] = [];
  if (rails?.pinned !== undefined && rails.pinned !== "") railParts.push(rails.pinned);
  if (rails?.budgetLine !== undefined && rails.budgetLine !== "") railParts.push(rails.budgetLine);
  if (rails?.corrective !== undefined && rails.corrective !== "") railParts.push(rails.corrective);
  if (rails?.planLine !== undefined && rails.planLine !== "") railParts.push(rails.planLine);
  const rail = railParts.length > 0 ? `\n\n${railParts.join("\n")}` : "";
  const specs = toolSpecs().filter((spec) => deps.toolFilter === undefined || deps.toolFilter(spec.name));
  // NF-074(a): fit the output cap to the remaining window — anchored on the
  // newest provider usage, plus the tail counted locally since that turn, or
  // the whole-prompt estimate before any usage has been seen.
  const inputEstimate =
    rails?.anchorBase !== undefined
      ? rails.anchorBase + (rails.appendedTokens ?? 0)
      : estimatePromptTokens(basePrompt + extra + rail, history, JSON.stringify(specs));
  const contextWindow = windowForModel(deps.model);
  const maxTokens = fitMaxOutputTokens(inputEstimate, contextWindow);
  // What the next dispatch will carry, as the harness computed it — the
  // `/context` report (one event per dispatch; renderers that do not care
  // ignore it, see render.ts's default arm).
  emit(deps.callbacks, {
    type: "context.usage",
    model: deps.model,
    window: contextWindow,
    estimatedInput: inputEstimate,
    maxOutput: maxTokens,
    messages: history.length,
    historyLimit: HISTORY_LIMIT,
  });
  const request: ProviderRequest = {
    model: deps.model,
    system: basePrompt + extra + rail,
    maxTokens,
    messages: history,
    tools: specs,
    signal: deps.signal,
  };
  try {
    for await (const event of deps.provider.stream(request)) {
      if (event.type === "text") {
        turn.text += event.text;
        emit(deps.callbacks, { type: "assistant.delta", text: event.text });
      } else if (event.type === "tool_call") {
        turn.toolCalls.push({
          id: event.id && event.id !== "" ? event.id : `call_${turn.toolCalls.length + 1}`,
          name: event.name,
          arguments: typeof event.arguments === "string" ? event.arguments : "",
        });
      } else if (event.type === "notice") {
        // A retry on the way in, or any other provider-side fact the human should
        // know: surface it rather than swallowing it into the transcript.
        emit(deps.callbacks, { type: "notice", message: event.message });
      } else if (event.type === "done") {
        turn.stopReason = event.stopReason;
        turn.usage = event.usage;
        break;
      } else if (event.type === "error") {
        turn.error = event.message;
        break;
      }
      if (deps.signal.aborted) {
        turn.stopReason = "abort";
        break;
      }
    }
  } catch (err) {
    turn.error = `provider failed: ${errorMessage(err)}`;
  }
  return turn;
}

/* ------------------------------ plan mode ------------------------------ */

/**
 * Tools plan mode refuses outright. Staging covers `write`/`edit`; everything
 * here would take an effect the user has not reviewed, so it is refused with a
 * typed result the model can read. Read-only tools (read/glob/grep/repo_map/
 * todo) are unaffected, and an unknown name falls through to the ordinary
 * unknown-tool refusal.
 */
const PLAN_MODE_REFUSED: Record<string, string> = {
  shell: "plan mode: commands are not run while planning; the user applies the plan (or exits plan mode) to execute",
  undo: "plan mode: undo restores files and is not staged; exit plan mode to undo",
  preview: "plan mode: dev servers are not started; exit plan mode to run one",
  agent: "plan mode: subagents are not spawned while planning; exit plan mode to delegate",
  code_mode: "plan mode: code programs are not run; exit plan mode to execute",
};

/** The projection of a write/edit as it would land right now, or a refusal. */
function projectChange(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): { ok: true; resolved: string; rel: string; before: string | null; after: string } | { ok: false; error: string } {
  const file = argString(args, "path", "file_path", "file");
  if (file === undefined) return { ok: false, error: `${name} requires a path` };
  const resolved = path.resolve(workspace, file);
  let before: string | null = null;
  try {
    before = readFileSync(resolved).toString("utf8");
  } catch {
    before = null;
  }
  const rel = pathInsideWorkspace(resolved, workspace) ? path.relative(path.resolve(workspace), resolved) : resolved;
  if (name === "write") {
    if (typeof args.content !== "string") return { ok: false, error: "write requires a string content" };
    return { ok: true, resolved, rel, before, after: args.content };
  }
  if (before === null) return { ok: false, error: `edit: file not found: ${rel}` };
  if (typeof args.old !== "string" || args.old === "" || typeof args.new !== "string") {
    return { ok: false, error: "edit requires old and new strings" };
  }
  const projected = projectExactEdit(before, args.old, args.new, args.all === true);
  if (projected.ok === false) {
    return {
      ok: false,
      error: `edit: ${projected.error} in ${rel} — while staging only the exact rung is available; use write with the full intended content, or exit plan mode`,
    };
  }
  return { ok: true, resolved, rel, before, after: projected.after };
}

/** The plan-mode answer for a call, or undefined when the call proceeds. */
function planModeOutcome(
  name: string,
  args: Record<string, unknown>,
  deps: LoopDeps,
): { result: ToolResult; staged?: true; preview?: string } | undefined {
  const refusal = PLAN_MODE_REFUSED[name];
  if (refusal !== undefined) {
    return { result: { ok: false, output: refusal, error: refusal } };
  }
  if (name !== "write" && name !== "edit") return undefined;
  const projected = projectChange(name, args, deps.workspace);
  if (projected.ok === false) {
    const message = `plan mode: ${projected.error}`;
    return { result: { ok: false, output: message, error: message } };
  }
  const report = stageWrite(deps.sessionId, {
    resolved: projected.resolved,
    rel: projected.rel,
    before: projected.before,
    after: projected.after,
    tool: name === "edit" ? "edit" : "write",
  });
  if (!report.staged) {
    const message =
      "plan mode: change refused — the stage is at its cap, or this single change exceeds it; " +
      "review with /changes and free room with /discard, then re-issue the call";
    return { result: { ok: false, output: message, error: message } };
  }
  const evictedNote = report.evicted > 0 ? ` (evicted ${report.evicted} earlier staged change(s) to stay within the cap)` : "";
  const diff = unifiedDiff(projected.before, projected.after, projected.rel, 40);
  return {
    result: { ok: true, output: `staged for review (plan mode): ${projected.rel}${evictedNote}\n${diff}` },
    staged: true,
    preview: diff,
  };
}

async function executeTool(
  deps: LoopDeps,
  gate: GuardGate,
  call: ToolCall,
  parsed: { args: Record<string, unknown>; error?: string },
  faults: RunFaults,
  hooks: HooksConfig,
): Promise<{ result: ToolResult; leaseId?: string; staged?: boolean; preview?: string }> {
  if (parsed.error) {
    return {
      result: { ok: false, output: `Invalid arguments for ${call.name}: ${parsed.error}`, error: `invalid arguments: ${parsed.error}` },
    };
  }
  const tool = getTool(call.name);
  if (!tool || (deps.toolFilter !== undefined && !deps.toolFilter(call.name))) {
    return { result: { ok: false, output: `Unknown tool: ${call.name}`, error: `unknown tool "${call.name}"` } };
  }

  // Plan mode: staging/refusals happen AFTER the tool resolves (an unknown name
  // keeps its unknown-tool refusal) and BEFORE any guard check — a staged
  // change takes no effect, so there is nothing to admit yet; /apply admits
  // each staged write through the ordinary guard when it runs.
  if (deps.planMode === true) {
    const planned = planModeOutcome(call.name, parsed.args, deps);
    if (planned !== undefined) return planned;
  }

  const admission = admissionFor(call.name, parsed.args, deps.workspace);
  if (admission === undefined) {
    // Fail closed: a tool without an admission never runs. Unmapped is a bug,
    // not a permission.
    const message = `HZ_PRECONDITION_FAILED: no admission mapping for tool "${call.name}"; the call was refused before execution`;
    return { result: { ok: false, output: message, error: message } };
  }
  let leaseId: string | undefined;
  let admitted: GuardAction | undefined;
  if (admission.kind === "guard") {
    const action = withCallIntent(admission.action, parsed.args, deps.workspace);
    admitted = action;
    const decision = await gate.check(action);
    leaseId = decision.leaseId ?? gate.leaseFor(action);
    if (decision.decision === "deny") {
      const denied = `DENIED by policy: ${decision.reason ?? action.kind}`;
      return { result: { ok: false, output: denied, error: denied } };
    }
    if (decision.decision === "ask") {
      const request = approvalRequestFor(call.name, action, deps.workspace);
      // Reviewable before writing: a write/edit ask carries the projected diff
      // when it can be computed cheaply; any problem (unreadable file, no
      // exact match) silently omits it — the ask itself is unchanged.
      let approvalPreview: string | undefined;
      if (call.name === "write" || call.name === "edit") {
        const projected = projectChange(call.name, parsed.args, deps.workspace);
        if (projected.ok) approvalPreview = unifiedDiff(projected.before, projected.after, projected.rel, 60);
      }
      const asked: ApprovalRequest & { preview?: string } =
        approvalPreview !== undefined ? { ...request, preview: approvalPreview } : request;
      await logEvent(
        deps,
        faults,
        EventTypes.approvalRequest,
        { callId: call.id, tool: call.name, kind: action.kind, target: action.target, title: request.title },
        { kind: "system", id: "hz-guard" },
      );
      const approved = await gate.approve(asked, action);
      await logEvent(
        deps,
        faults,
        EventTypes.approvalDecision,
        { callId: call.id, tool: call.name, kind: action.kind, decision: approved ? "approved" : "declined" },
        { kind: "human", id: "user" },
      );
      if (!approved) {
        return { result: { ok: false, output: "DECLINED by the user", error: "DECLINED by the user" } };
      }
      leaseId = gate.leaseFor(action);
    }
  }

  // hooks v1: the admitted call, once Guard/approval allowed it. A pre hook can
  // only narrow further (H2 — it never allows what the guard asked or denied);
  // a denying or failed hook sinks into the standard tool-result shape.
  const hookDecision = await runPreToolHooks(hooks, {
    sessionId: deps.sessionId,
    workspace: deps.workspace,
    callId: call.id,
    tool: call.name,
    args: parsed.args,
    onNotice: (message) => emit(deps.callbacks, { type: "notice", message }),
    onEvent: (type, payload) => void logEvent(deps, faults, type, payload, { kind: "system", id: "hz-hook" }),
  });
  if (hookDecision.decision === "deny") {
    const denied = `DENIED by hook: ${hookDecision.reason}`;
    return { result: { ok: false, output: denied, error: denied } };
  }

  const context: ToolContext = {
    cwd: deps.workspace,
    workspace: deps.workspace,
    sessionId: deps.sessionId,
    signal: deps.signal,
    // A tool-level check rides exactly the loop decision for this call when it
    // admits the same action; it is never answered by a sibling's cache entry
    // or by a stale entry from a different cwd (see GuardGate.check).
    guard: (a: GuardAction) => gate.check(a, admitted),
    approve: (req: ApprovalRequest, action?: GuardAction) => gate.approve(req, action),
    receipt: (rec: ReceiptInput) => deps.kernel.issueReceipt(rec),
    delegate: deps.delegate,
  };

  try {
    return { result: normalizeToolResult(await tool.execute(parsed.args, context)), leaseId };
  } catch (err) {
    const message = errorMessage(err);
    return { result: { ok: false, output: `Tool ${call.name} failed: ${message}`, error: message }, leaseId };
  }
}

/**
 * Issue one tool receipt and, best-effort, log its issuance. Returns true on
 * success; on failure the per-call notice is kept and the run-level fault is
 * recorded, so a run that lost a receipt can never report success.
 */
async function issueToolReceipt(
  deps: LoopDeps,
  faults: RunFaults,
  call: ToolCall,
  parsed: { args: Record<string, unknown> },
  result: ToolResult,
  leaseId: string | undefined,
): Promise<boolean> {
  try {
    const receipt = await deps.kernel.issueReceipt({
      action: "tool.execute",
      tool: call.name,
      argsDigest: sha256Hex(canonicalJson(parsed.args)),
      resultDigest: sha256Hex(typeof result.output === "string" ? result.output : ""),
      leaseId,
    });
    await logEvent(
      deps,
      faults,
      EventTypes.receiptIssued,
      { receiptId: receipt.id, seq: receipt.seq, tool: call.name, callId: call.id },
      { kind: "system", id: "hz-kernel" },
    );
    return true;
  } catch (err) {
    faults.noteReceipt(err);
    emit(deps.callbacks, { type: "notice", message: `could not issue a receipt: ${errorMessage(err)}` });
    return false;
  }
}

async function runToolCall(
  deps: LoopDeps,
  gate: GuardGate,
  call: ToolCall,
  faults: RunFaults,
  evidence: RunEvidence,
  hooks: HooksConfig,
): Promise<number> {
  const parsed = parseArguments(call.arguments);
  const started = Date.now();
  emit(deps.callbacks, { type: "tool.card", callId: call.id, name: call.name, args: parsed.args, status: "running" });
  await logEvent(deps, faults, EventTypes.toolCall, { callId: call.id, name: call.name, args: parsed.args }, { kind: "tool", id: call.name });

  const executed = await executeTool(deps, gate, call, parsed, faults, hooks);
  const result = executed.result;
  // Completion evidence: what this run changed, and whether anything checked it.
  // A staged (plan-mode) write changed nothing on disk, so it is not evidence.
  if (result.ok && executed.staged !== true) {
    if (call.name === "write" || call.name === "edit") evidence.noteMutation(parsed.args.path ?? parsed.args.file_path ?? parsed.args.file);
    else if (call.name === "shell") evidence.noteCommand(parsed.args.command);
    else if (call.name === "todo") evidence.noteTodoCall(parsed.args.action);
  }
  // NF-074(b): cap the model-facing result and spill the full text. The
  // receipt digest below stays the digest of the FULL output — the cap is a
  // context budget, never an evidence change.
  const plan = planToolOutputCap(typeof result.output === "string" ? result.output : "", {
    spillDir: workspaceSpillDir(deps.workspace),
    displaySpillDir: displaySpillPath(deps.workspace),
  });
  if (plan.spill) {
    const refusal = writeSpillSafely(plan.spill.file, plan.spill.contents);
    if (refusal !== undefined) emit(deps.callbacks, { type: "notice", message: refusal });
  }
  const content = toolMessageContent(result, plan.text);

  // hooks v1 post point: an observation hook sees the model-facing text; a
  // failure here is a notice, never a blocked step (H4).
  await runPostToolHooks(hooks, {
    sessionId: deps.sessionId,
    workspace: deps.workspace,
    callId: call.id,
    tool: call.name,
    args: parsed.args,
    ok: result.ok,
    ms: Date.now() - started,
    outputExcerpt: content,
    onNotice: (message) => emit(deps.callbacks, { type: "notice", message }),
    onEvent: (type, payload) => void logEvent(deps, faults, type, payload, { kind: "system", id: "hz-hook" }),
  });

  try {
    deps.store.appendMessage(deps.sessionId, { role: "tool", content, toolCallId: call.id, toolName: call.name });
  } catch (err) {
    // The tool already ran through executeTool: for an effectful tool the
    // effect is real (the marker file, the command's side effect) while the
    // transcript row is missing. The card must not stay "running", the result
    // is still audited and its receipt still attempted (best-effort), and the
    // run stops from the batch with a typed error — never a bare
    // "failed unexpectedly" notice.
    faults.noteTranscript(call.name, err);
    const message = `tool ${call.name}: the effect already ran; the transcript write failed (${call.name}: ${errorMessage(err)})`;
    emit(deps.callbacks, { type: "notice", message });
    await logEvent(
      deps,
      faults,
      EventTypes.toolResult,
      {
        callId: call.id,
        name: call.name,
        ok: result.ok,
        output: truncateForEvent(plan.text, 4000),
        error: result.error,
        ms: Date.now() - started,
        leaseId: executed.leaseId,
        transcriptWriteFailed: true,
      },
      { kind: "tool", id: call.name },
    );
    await issueToolReceipt(deps, faults, call, parsed, result, executed.leaseId);
    emit(deps.callbacks, {
      type: "tool.card",
      callId: call.id,
      name: call.name,
      args: parsed.args,
      status: "error",
      summary: firstLine(message),
    });
    throw new TranscriptAppendError(message);
  }

  await logEvent(
    deps,
    faults,
    EventTypes.toolResult,
    {
      callId: call.id,
      name: call.name,
      ok: result.ok,
      output: truncateForEvent(plan.text, 4000),
      error: result.error,
      ms: Date.now() - started,
      leaseId: executed.leaseId,
    },
    { kind: "tool", id: call.name },
  );

  // The receipt is the durable proof of what ran, with what arguments, to what result.
  await issueToolReceipt(deps, faults, call, parsed, result, executed.leaseId);

  emit(deps.callbacks, {
    type: "tool.card",
    callId: call.id,
    name: call.name,
    args: parsed.args,
    status: result.ok ? "ok" : "error",
    summary: result.ok ? firstLine(content) : firstLine(result.error && result.error !== "" ? result.error : content),
    ...(executed.preview !== undefined ? { preview: executed.preview } : {}),
  });
  // The locally counted context cost of this message (NF-074(a) tail).
  return FRAMING_CHARGE_TOKENS + estimateTokens(content);
}

/**
 * The post-mortem failure class for a non-succeeded exit. Deliberately coarse:
 * the class is a sorting key for the growth loop, not a diagnosis — the
 * record's terminal + detail carry the precise outcome.
 */
function classifyFailure(exit: RunExit): FailureClass {
  switch (exit.detail) {
    case "provider_error":
      return "provider_error";
    case "format_errors":
      return "format";
    case "steps":
    case "tokens":
    case "wall_clock":
      return "budget";
    default:
      return "unknown";
  }
}

/**
 * Run one conversation turn to completion. The promise never rejects: failures
 * arrive as error events and the caller gets whatever text was produced.
 */
export async function runTurn(
  deps: LoopDeps,
  userText: string,
): Promise<{ text: string; aborted: boolean; exit: RunExit }> {
  let text = "";
  let aborted = false;
  // Wave-12: one per-run failure ledger. Audit-trail, receipt and transcript
  // failures all prevent a `succeeded` exit; the terminal outcome is decided
  // once, at the end (the exit shape itself is unchanged).
  const faults = new RunFaults();
  const evidence = new RunEvidence();
  let fatal = false;
  // NF-073: one terminal outcome per run, in the RC-7 vocabulary.
  let exit: RunExit = { terminal: "succeeded", detail: "turn_end" };
  try {
    const prompt = typeof userText === "string" ? userText.trim() : "";
    await beginUserTurn(deps, faults, prompt);
    // Read once per run, from the store: the task statement survives a trim and
    // a resume alike, and it is the FIRST user turn that is the task — not the
    // user turn this call is processing.
    const pinned = pinnedTaskStatement(deps.store.history(deps.sessionId));

    // Project memory (docs/10 R121-R123): the AGENTS.md/ZH.md hierarchy, loaded
    // once per run so every dispatch carries the same bytes. A subagent's fixed
    // prompt is deliberately not modified (`systemOverride` wins). Truncation,
    // skips and AGENTS/ZH conflicts are reported, never silent.
    const instructions = ((): string => {
      if (deps.systemOverride !== undefined && deps.systemOverride !== "") return "";
      const loaded = loadInstructionBlocks(deps.workspace);
      const { report } = loaded;
      if (report.truncated > 0 || report.totalCapped || report.skipped.length > 0 || report.conflicts > 0) {
        const parts = [`project instructions: ${report.files} file(s), ${report.totalBytes} bytes`];
        if (report.conflicts > 0) parts.push(`${report.conflicts} AGENTS/ZH conflict(s)`);
        if (report.truncated > 0) parts.push(`${report.truncated} truncated at the 32 KB cap`);
        if (report.totalCapped) parts.push("the 128 KB total cap stopped the rest");
        if (report.skipped.length > 0) parts.push(`skipped: ${report.skipped.join("; ")}`);
        emit(deps.callbacks, { type: "notice", message: parts.join(" \u2014 ") });
      }
      return instructionPrompt(loaded.blocks, report);
    })();

    const gate = new GuardGate(deps.workspace, deps.kernel, deps.sessionLeases, () => deps.approve ?? getApprovalHandler(), deps.sessionId);
    // Plan mode rides the system rail: the model is told what staging means on
    // every step, so a long planning turn cannot drift into treating a staged
    // change as applied (the rail survives trims; history does not).
    const planLine =
      deps.planMode === true
        ? "PLAN MODE is ON (the user's setting): write and edit calls are STAGED, not applied — the user reviews them with /changes and applies with /apply; shell, undo, preview, agent and code_mode calls are refused while planning."
        : undefined;
    // Hooks are config-backed and loaded ONCE per run (absent config = zero
    // cost, zero spawns). A malformed config is a fail-closed refusal state
    // carried by the loader, not an exception here.
    const hooks = deps.hooks ?? loadHooks(deps.workspace);
    // NF-073: one ledger for the run tree (the main turn and every subagent it
    // spawns); a caller that passes its own ledger shares one ceiling.
    const ledger =
      deps.ledger ??
      new BudgetLedger(
        deps.budget ??
          {
            maxSteps:
              deps.maxProviderCalls !== undefined && deps.maxProviderCalls > 0
                ? deps.maxProviderCalls
                : MAX_PROVIDER_CALLS,
          },
      );
    let calls = 0;
    let consecutiveFormatErrors = 0;
    let corrective: string | undefined;
    // One report per run, not one per dispatch: the compaction numbers describe
    // the view the run works from, and a notice per step would be a notice storm.
    let compactionAnnounced = false;
    // NF-074(a): the newest provider usage anchor and the locally counted tail.
    let anchorBase: number | undefined;
    let appendedTokens = 0;

    for (;;) {
      // The single sentinel: budgets are checked before every dispatch, under
      // one convention — 0 (or absent) is unlimited. Wall clock is never reset.
      if (deps.signal.aborted) {
        aborted = true;
        exit = { terminal: "interrupted", detail: "aborted" };
        break;
      }
      const stop = await ledger.check();
      if (stop) {
        exit = { terminal: stop === "wall_clock" ? "timeout" : "budget_exhausted", detail: stop };
        emit(deps.callbacks, {
          type: "notice",
          message: `budget: ${stop === "wall_clock" ? "wall clock" : stop} exhausted — stopping at a clean boundary`,
        });
        break;
      }
      calls += 1;
      // Charged before the call: a billed-but-failed turn still spends its step.
      await ledger.chargeStep();

      // The window is compacted, not sliced: the turn that stated the task, the
      // constraints later turns stated and a labelled summary of what left the
      // window ride with it (compaction.ts). The store is never rewritten — this
      // view is re-derived from the rows on every dispatch, so a resume after a
      // crash recomputes the same pinned block.
      // The window IS the loop's history limit: a transcript at or under it is
      // untouched. (Live-run finding, 2026-11-09: this call omitted the options
      // object, so `limit` fell back to 1 in compaction.ts and every dispatch
      // elided the whole transcript down to one message. No typecheck existed
      // to catch the missing argument; the pipeline now has one.)
      const view = compactHistory(deps.store.history(deps.sessionId), { limit: HISTORY_LIMIT });
      const history = view.history;
      if (view.compacted && !compactionAnnounced) {
        // The elision is reported, never silent: a notice for the human of this
        // run, and an audit-trail event with the counts for the log.
        compactionAnnounced = true;
        emit(deps.callbacks, { type: "notice", message: view.notice });
        await logEvent(
          deps,
          faults,
          COMPACTION_EVENT,
          {
            window: HISTORY_LIMIT,
            dropped: view.dropped,
            kept: view.kept,
            elidedTokens: view.elidedTokens,
            droppedByRole: view.droppedByRole,
            scannedMessages: view.pinned?.scannedMessages ?? 0,
            pinnedConstraints: view.pinned?.constraints.length ?? 0,
            constraintsDropped: view.pinned?.constraintsDropped ?? 0,
            taskStatementPinned: view.pinned !== null && view.pinned.taskStatement !== null,
          },
          { kind: "system", id: "hz-loop" },
        );
      }
      await logEvent(deps, faults, EventTypes.messageStart, { role: "assistant", model: deps.model, turn: calls });
      const turn = await collectAssistant(deps, history, {
        pinned,
        budgetLine: budgetCountdownLine(ledger.countdown()),
        corrective,
        anchorBase,
        appendedTokens,
        instructions,
        planLine,
      });
      if (turn.usage) {
        await ledger.chargeTokens((turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0));
        const reportedInput = turn.usage.inputTokens ?? 0;
        if (reportedInput > 0) {
          // The next request's prompt will include this turn's output and calls.
          anchorBase = reportedInput + (turn.usage.outputTokens ?? 0);
          appendedTokens = FRAMING_CHARGE_TOKENS + estimateTokens(turn.text);
          for (const call of turn.toolCalls) appendedTokens += estimateTokens(call.arguments);
        }
      }

      if (turn.text !== "") text = text === "" ? turn.text : `${text}\n${turn.text}`;
      if (turn.text !== "" || turn.toolCalls.length > 0) {
        deps.store.appendMessage(deps.sessionId, {
          role: "assistant",
          content: turn.text,
          toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        });
      }
      await logEvent(deps, faults, EventTypes.messageEnd, {
        role: "assistant",
        stopReason: deps.signal.aborted ? "abort" : turn.stopReason,
        text: turn.text,
        toolCalls: turn.toolCalls.map((call) => ({ id: call.id, name: call.name })),
        usage: turn.usage,
      });
      emit(deps.callbacks, { type: "assistant.done", text: turn.text });

      if (turn.error) {
        emit(deps.callbacks, { type: "error", message: turn.error });
        await logEvent(deps, faults, EventTypes.error, { message: turn.error });
        exit = { terminal: "failed", detail: "provider_error" };
        break;
      }
      if (deps.signal.aborted || turn.stopReason === "abort") {
        aborted = true;
        exit = { terminal: "interrupted", detail: "aborted" };
        break;
      }
      if (turn.stopReason === "max_tokens") {
        emit(deps.callbacks, { type: "notice", message: "the model hit its output limit for this turn" });
      }
      if (turn.stopReason !== "tool_use" || turn.toolCalls.length === 0) break;

      // NF-072: shared calls in a segment run concurrently; an exclusive call
      // is its own barrier. All-settled: one call's failure cancels no sibling.
      for (const segment of batchSegments(turn.toolCalls)) {
        if (deps.signal.aborted) {
          aborted = true;
          break;
        }
        await Promise.all(
          segment.map((call) =>
            runToolCall(deps, gate, call, faults, evidence, hooks)
              .then((tokens) => {
                appendedTokens += tokens;
              })
              .catch((err) => {
                if (err instanceof TranscriptAppendError) {
                  // The tool's effect already happened while its result is not
                  // in the transcript: stop at this boundary instead of
                  // replaying a history that no longer matches what ran. The
                  // fault (named for the run by faults.failureMessage at the
                  // end) is already recorded and noticed in runToolCall.
                  fatal = true;
                  return;
                }
                emit(deps.callbacks, { type: "notice", message: `tool ${call.name} failed unexpectedly: ${errorMessage(err)}` });
              }),
          ),
        );
        if (fatal) break;
      }
      if (fatal) {
        exit = { terminal: "failed", detail: "internal_error" };
        break;
      }
      if (aborted) break;

      // NF-073(c): a batch in which no call carried parseable JSON is a
      // format-error step; any clean call resets the streak. The corrective
      // note rides the next step's system rail (mid-history system roles are
      // dropped by some providers, so it cannot be a history message).
      let parseErrors = 0;
      let cleanCalls = 0;
      for (const call of turn.toolCalls) {
        if (parseArguments(call.arguments).error !== undefined) parseErrors += 1;
        else cleanCalls += 1;
      }
      if (parseErrors > 0 && cleanCalls === 0) {
        consecutiveFormatErrors += 1;
        corrective = `Runtime note: your previous tool call(s) had invalid JSON arguments. Reissue them with valid JSON only (consecutive format errors: ${consecutiveFormatErrors}/${MAX_CONSECUTIVE_FORMAT_ERRORS}).`;
        emit(deps.callbacks, {
          type: "notice",
          message: `the model sent invalid tool arguments (${consecutiveFormatErrors}/${MAX_CONSECUTIVE_FORMAT_ERRORS})`,
        });
        if (consecutiveFormatErrors >= MAX_CONSECUTIVE_FORMAT_ERRORS) {
          exit = { terminal: "failed", detail: "format_errors" };
          emit(deps.callbacks, {
            type: "error",
            message: `stopping: ${MAX_CONSECUTIVE_FORMAT_ERRORS} consecutive turns of invalid tool arguments`,
          });
          await logEvent(deps, faults, EventTypes.error, { message: "format_error_cap", count: consecutiveFormatErrors });
          break;
        }
      } else if (cleanCalls > 0) {
        consecutiveFormatErrors = 0;
        corrective = undefined;
      }
    }
  } catch (err) {
    emit(deps.callbacks, { type: "error", message: `runtime error: ${errorMessage(err)}` });
    await logEvent(deps, faults, EventTypes.error, { message: errorMessage(err) });
    exit = { terminal: "failed", detail: "internal_error" };
  }
  // Lecture 09: a run that changed files and verified nothing must not look
  // like a measured success. The blocking half: when the run ALSO marked its
  // own declared work complete (a successful `todo done`, nothing left open),
  // the outcome cannot be proven either way — it exits `unknown` (exit 3,
  // fail-closed), never `succeeded`. The audit event records the files and the
  // claim. This runs BEFORE the fault fold, so a failed event-log write still
  // downgrades the exit below.
  const unverified = exit.terminal === "succeeded" ? evidence.unverified() : undefined;
  const claimed = exit.terminal === "succeeded" ? evidence.claimWithoutVerification() : undefined;
  if (claimed !== undefined) exit = { terminal: "unknown", detail: "unverified_completion" };
  if (unverified !== undefined) {
    const shown = unverified.slice(0, 5).join(", ");
    const more = unverified.length > 5 ? ` and ${unverified.length - 5} more` : "";
    emit(deps.callbacks, {
      type: "notice",
      message:
        claimed !== undefined
          ? `unverified completion: this run changed ${unverified.length} file(s) (${shown}${more}), marked its ` +
            `declared work complete and ran nothing verification-shaped — recorded unknown (exit 3), not success`
          : `unverified completion: this run changed ${unverified.length} file(s) (${shown}${more}) and ran nothing ` +
            `verification-shaped — the result is the model's claim, not a measured one`,
    });
    await logEvent(
      deps,
      faults,
      UNVERIFIED_COMPLETION_EVENT,
      { files: unverified, claimed: claimed !== undefined },
      { kind: "system", id: "hz-loop" },
    );
  }
  // An under-finished plan is not a false success, but it must not pass
  // silently either: the run declared items and left some open.
  const open = exit.terminal === "succeeded" ? evidence.openPlan() : undefined;
  if (open !== undefined) {
    emit(deps.callbacks, {
      type: "notice",
      message: `this run left ${open.open} of ${open.added} declared todo item(s) open — the task may be unfinished`,
    });
  }
  // Wave-12: one run-level failure for every class of loss — a run that dropped
  // events, receipts or transcript rows never reports `succeeded`, and the
  // failure message names each count and its first underlying error. The exit
  // detail stays the machine-readable `internal_error` (RunExit's closed
  // vocabulary); the message is where the count and the error are named.
  const failure = faults.failureMessage();
  if (failure !== undefined) {
    if (exit.terminal === "succeeded") exit = { terminal: "failed", detail: "internal_error" };
    emit(deps.callbacks, { type: "error", message: failure });
  }
  // Post-mortems (docs/30 §4 item 8): a run that did not succeed leaves a
  // record the growth loop can learn from — the RC-7 terminal, a failure
  // class, the transcript range and its digest, tool counts, the task line.
  // Best-effort: failing to record must never take the turn down, and it is
  // noticed rather than swallowed. (A succeeded run records nothing: the
  // lesson store is for failures; "noteworthy ≠ failed" stays available by
  // calling recordPostmortem directly.)
  if (exit.terminal !== "succeeded") {
    try {
      const rows = deps.store.history(deps.sessionId);
      const events: TranscriptEvent[] = rows.map((msg, index) => ({
        seq: index + 1,
        role: msg.role,
        text: typeof msg.content === "string" ? msg.content : "",
      }));
      const toolCounts: Record<string, number> = {};
      for (const msg of rows) {
        const toolName = (msg as { toolName?: unknown }).toolName;
        if (msg.role === "tool" && typeof toolName === "string" && toolName !== "") {
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        }
      }
      await recordPostmortem({
        stateDir: workspaceStateDir(deps.workspace),
        sessionId: deps.sessionId,
        terminal: exit.terminal,
        detail: exit.detail,
        transcript: events,
        toolCalls: toolCounts,
        failureClass: classifyFailure(exit),
      });
    } catch (err) {
      emit(deps.callbacks, { type: "notice", message: `could not record a post-mortem: ${errorMessage(err)}` });
    }
  }
  emit(deps.callbacks, { type: "turn.done" });
  return { text, aborted: aborted || deps.signal.aborted, exit };
}
