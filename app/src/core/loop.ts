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
import { realpathSync } from "node:fs";
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
  RuntimeCallbacks,
  RuntimeEvent,
  ToolCall,
  ToolContext,
  ToolResult,
  Usage,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { getTool, toolSpecs } from "../tools";
import { canonicalJson, sha256Hex } from "./canon";
import type { KernelClient } from "./kernel";
import type { SessionStore } from "./session";

/** Hard ceiling on provider calls inside a single send(). */
export const MAX_PROVIDER_CALLS = 25;
/** Messages replayed to the provider, newest last. */
export const HISTORY_LIMIT = 80;
export const SESSION_LEASE_TTL_MS = 15 * 60 * 1000;

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

/** The system prompt is deliberately short: identity, place, day, tone. */
export function systemPrompt(workspace: string, today: Date = new Date()): string {
  const stamp = Number.isNaN(today.getTime()) ? "" : today.toISOString().slice(0, 10);
  return [
    "You are HzCode, a coding agent in the user's terminal.",
    `Working directory: ${workspace}`,
    `Today's date: ${stamp}`,
    "Be concise. Use tools for real work.",
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
 * Resolve a path to where it really lives, following symlinks for the portion
 * that exists on disk. A path that does not exist yet is resolved through its
 * deepest existing ancestor, so a symlinked parent cannot hide where a new file
 * will actually land. Falls back to the lexical path when nothing can be
 * resolved (e.g. the root itself), which is the previous behaviour.
 */
export function realpathish(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True when `target` resolves inside the workspace root. Both sides are
 * resolved through symlinks first: a link inside the workspace pointing outside
 * must be classified by where it actually lands, not by its spelling.
 */
export function pathInsideWorkspace(target: string, workspace: string): boolean {
  if (typeof target !== "string" || target === "") return false;
  const root = realpathish(workspace);
  const resolved = realpathish(path.resolve(workspace, target));
  if (resolved === root) return true;
  return !escapes(root, resolved);
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
 * The guard action a tool call implies, using the same path resolution the tools
 * themselves use. Tools that touch nothing guarded (todo) return undefined.
 */
export function guardActionFor(name: string, args: Record<string, unknown>, workspace: string): GuardAction | undefined {
  const resolved = (value: string): string => path.resolve(workspace, value);
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
    case "write":
    case "edit": {
      const file = argString(args, "path", "file_path", "file");
      return file ? { kind: "fs.write", target: resolved(file) } : undefined;
    }
    case "shell":
    case "bash": {
      const command = argString(args, "command", "cmd");
      return command ? { kind: "shell.exec", target: command } : undefined;
    }
    default:
      return undefined;
  }
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

/** What the model sees as the tool's answer. */
function toolMessageContent(result: ToolResult): string {
  const output = typeof result.output === "string" ? result.output : "";
  if (result.ok) return output === "" ? "(no output)" : output;
  const reason = typeof result.error === "string" && result.error !== "" ? result.error : output;
  return reason === "" ? "tool failed" : reason;
}

export function streamFor(sessionId: string): string {
  return `session:${sessionId}`;
}

/* ------------------------------- guard gate ------------------------------- */

/**
 * The one place approvals are decided for a turn. Guessing twice about the same
 * action is bad manners (and two prompts for one shell command is a bug), so an
 * action that was allowed stays allowed for the rest of the turn. Under NF-072
 * concurrent batch siblings share this gate, so every decision is serialized
 * and an approval names the action it answers.
 */
export class GuardGate {
  private readonly resolved = new Map<string, { leaseId?: string }>();
  private pending: GuardAction | null = null;
  /** One decision at a time: concurrent batch siblings are serialized here. */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: string,
    private readonly kernel: KernelClient,
    private readonly leases: Lease[],
    private readonly handler: () => ApprovalHandler,
  ) {}

  private static key(action: GuardAction): string {
    return `${action.kind}\u0000${action.target}`;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(task, task);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async check(action: GuardAction): Promise<GuardDecision> {
    return this.serialize(async () => {
      const key = GuardGate.key(action);
      const cached = this.resolved.get(key);
      if (cached) return { decision: "allow" as const, reason: "already allowed in this turn", leaseId: cached.leaseId };
      let decision: GuardDecision;
      try {
        decision = await this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases);
      } catch (err) {
        // Fail closed: an unreachable guard is a deny, never a silent allow.
        return { decision: "deny" as const, reason: `guard unavailable: ${errorMessage(err)}` };
      }
      if (decision.decision === "ask") this.pending = action;
      else if (decision.decision === "allow") this.resolved.set(key, { leaseId: decision.leaseId });
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
      ok = await this.handler()(req);
    } catch {
      ok = false;
    }
    if (ok && waiting) this.resolved.set(GuardGate.key(waiting), { leaseId: undefined });
    if (this.pending !== null && this.pending === waiting) this.pending = null;
    return ok;
  }

  /** The lease that covered this action, when the kernel granted one. */
  leaseFor(action: GuardAction): string | undefined {
    return this.resolved.get(GuardGate.key(action))?.leaseId;
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
  /** Nested delegation runner (the `agent` tool); absent in child runs. */
  delegate?: DelegateRunner;
}

interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "max_tokens" | "abort";
  usage?: Usage;
  error?: string;
}

async function logEvent(deps: LoopDeps, type: string, payload: unknown, actor: ActorRef = { kind: "agent", id: "hzcode" }): Promise<void> {
  try {
    const stream = streamFor(deps.sessionId);
    await deps.kernel.appendEvent(stream, { id: newId(), ts: nowIso(), stream, type, actor, payload });
  } catch {
    // SQLite holds the transcript; the hash-chained log is the audit trail. A log
    // failure is worth reporting one day, but it must never take the chat down.
  }
}

async function beginUserTurn(deps: LoopDeps, prompt: string): Promise<void> {
  if (prompt === "") return;
  const first = deps.store.messageCount(deps.sessionId) === 0;
  deps.store.appendMessage(deps.sessionId, { role: "user", content: prompt });
  await logEvent(deps, EventTypes.messageStart, { role: "user" }, { kind: "human", id: "user" });
  await logEvent(deps, EventTypes.messageEnd, { role: "user", text: prompt }, { kind: "human", id: "user" });
  if (first) deps.store.touchSession(deps.sessionId, titleFromText(prompt));
}

async function collectAssistant(deps: LoopDeps, history: ChatMsg[]): Promise<AssistantTurn> {
  const turn: AssistantTurn = { text: "", toolCalls: [], stopReason: "end" };
  const basePrompt =
    deps.systemOverride !== undefined && deps.systemOverride !== ""
      ? deps.systemOverride
      : systemPrompt(deps.workspace);
  const extra = deps.systemExtra !== undefined && deps.systemExtra !== "" ? `\n\n${deps.systemExtra}` : "";
  const specs = toolSpecs().filter((spec) => deps.toolFilter === undefined || deps.toolFilter(spec.name));
  const request: ProviderRequest = {
    model: deps.model,
    system: basePrompt + extra,
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

async function executeTool(
  deps: LoopDeps,
  gate: GuardGate,
  call: ToolCall,
  parsed: { args: Record<string, unknown>; error?: string },
): Promise<{ result: ToolResult; leaseId?: string }> {
  if (parsed.error) {
    return {
      result: { ok: false, output: `Invalid arguments for ${call.name}: ${parsed.error}`, error: `invalid arguments: ${parsed.error}` },
    };
  }
  const tool = getTool(call.name);
  if (!tool || (deps.toolFilter !== undefined && !deps.toolFilter(call.name))) {
    return { result: { ok: false, output: `Unknown tool: ${call.name}`, error: `unknown tool "${call.name}"` } };
  }

  const action = guardActionFor(call.name, parsed.args, deps.workspace);
  let leaseId: string | undefined;
  if (action) {
    const decision = await gate.check(action);
    leaseId = decision.leaseId ?? gate.leaseFor(action);
    if (decision.decision === "deny") {
      const denied = `DENIED by policy: ${decision.reason ?? action.kind}`;
      return { result: { ok: false, output: denied, error: denied } };
    }
    if (decision.decision === "ask") {
      const request = approvalRequestFor(call.name, action, deps.workspace);
      await logEvent(
        deps,
        EventTypes.approvalRequest,
        { callId: call.id, tool: call.name, kind: action.kind, target: action.target, title: request.title },
        { kind: "system", id: "hz-guard" },
      );
      const approved = await gate.approve(request, action);
      await logEvent(
        deps,
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

  const context: ToolContext = {
    cwd: deps.workspace,
    workspace: deps.workspace,
    sessionId: deps.sessionId,
    signal: deps.signal,
    guard: (a: GuardAction) => gate.check(a),
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

async function runToolCall(deps: LoopDeps, gate: GuardGate, call: ToolCall): Promise<void> {
  const parsed = parseArguments(call.arguments);
  const started = Date.now();
  emit(deps.callbacks, { type: "tool.card", callId: call.id, name: call.name, args: parsed.args, status: "running" });
  await logEvent(deps, EventTypes.toolCall, { callId: call.id, name: call.name, args: parsed.args }, { kind: "tool", id: call.name });

  const executed = await executeTool(deps, gate, call, parsed);
  const result = executed.result;
  const content = toolMessageContent(result);

  deps.store.appendMessage(deps.sessionId, { role: "tool", content, toolCallId: call.id, toolName: call.name });
  await logEvent(
    deps,
    EventTypes.toolResult,
    {
      callId: call.id,
      name: call.name,
      ok: result.ok,
      output: truncateForEvent(result.output ?? "", 4000),
      error: result.error,
      ms: Date.now() - started,
      leaseId: executed.leaseId,
    },
    { kind: "tool", id: call.name },
  );

  // The receipt is the durable proof of what ran, with what arguments, to what result.
  try {
    const receipt = await deps.kernel.issueReceipt({
      action: "tool.execute",
      tool: call.name,
      argsDigest: sha256Hex(canonicalJson(parsed.args)),
      resultDigest: sha256Hex(typeof result.output === "string" ? result.output : ""),
      leaseId: executed.leaseId,
    });
    await logEvent(
      deps,
      EventTypes.receiptIssued,
      { receiptId: receipt.id, seq: receipt.seq, tool: call.name, callId: call.id },
      { kind: "system", id: "hz-kernel" },
    );
  } catch (err) {
    emit(deps.callbacks, { type: "notice", message: `could not issue a receipt: ${errorMessage(err)}` });
  }

  emit(deps.callbacks, {
    type: "tool.card",
    callId: call.id,
    name: call.name,
    args: parsed.args,
    status: result.ok ? "ok" : "error",
    summary: result.ok ? firstLine(content) : firstLine(result.error && result.error !== "" ? result.error : content),
  });
}

/**
 * Run one conversation turn to completion. The promise never rejects: failures
 * arrive as error events and the caller gets whatever text was produced.
 */
export async function runTurn(deps: LoopDeps, userText: string): Promise<{ text: string; aborted: boolean }> {
  let text = "";
  let aborted = false;
  try {
    const prompt = typeof userText === "string" ? userText.trim() : "";
    await beginUserTurn(deps, prompt);

    const gate = new GuardGate(deps.workspace, deps.kernel, deps.sessionLeases, () => deps.approve ?? getApprovalHandler());
    let calls = 0;
    const maxCalls =
      deps.maxProviderCalls !== undefined && deps.maxProviderCalls > 0 ? deps.maxProviderCalls : MAX_PROVIDER_CALLS;

    for (;;) {
      if (deps.signal.aborted) {
        aborted = true;
        break;
      }
      if (calls >= maxCalls) {
        emit(deps.callbacks, { type: "notice", message: `stopped after ${maxCalls} model turns in one request` });
        break;
      }
      calls += 1;

      const history = trimHistory(deps.store.history(deps.sessionId));
      await logEvent(deps, EventTypes.messageStart, { role: "assistant", model: deps.model, turn: calls });
      const turn = await collectAssistant(deps, history);

      if (turn.text !== "") text = text === "" ? turn.text : `${text}\n${turn.text}`;
      if (turn.text !== "" || turn.toolCalls.length > 0) {
        deps.store.appendMessage(deps.sessionId, {
          role: "assistant",
          content: turn.text,
          toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
        });
      }
      await logEvent(deps, EventTypes.messageEnd, {
        role: "assistant",
        stopReason: deps.signal.aborted ? "abort" : turn.stopReason,
        text: turn.text,
        toolCalls: turn.toolCalls.map((call) => ({ id: call.id, name: call.name })),
        usage: turn.usage,
      });
      emit(deps.callbacks, { type: "assistant.done", text: turn.text });

      if (turn.error) {
        emit(deps.callbacks, { type: "error", message: turn.error });
        await logEvent(deps, EventTypes.error, { message: turn.error });
        break;
      }
      if (deps.signal.aborted || turn.stopReason === "abort") {
        aborted = true;
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
            runToolCall(deps, gate, call).catch((err) => {
              emit(deps.callbacks, { type: "notice", message: `tool ${call.name} failed unexpectedly: ${errorMessage(err)}` });
            }),
          ),
        );
      }
      if (aborted) break;
    }
  } catch (err) {
    emit(deps.callbacks, { type: "error", message: `runtime error: ${errorMessage(err)}` });
    await logEvent(deps, EventTypes.error, { message: errorMessage(err) });
  }
  emit(deps.callbacks, { type: "turn.done" });
  return { text, aborted: aborted || deps.signal.aborted };
}
