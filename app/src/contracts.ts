/**
 * HorizonCode — frozen interface contracts, v0.1
 *
 * LAW: Both the Rust kernel (kernel/) and the TypeScript runtime (app/src/core)
 * implement the exact hashing / canonicalization / protocol rules defined here.
 * Implementation agents import these types; do not change signatures casually.
 *
 * Canonical JSON rules (used for every hash in the system):
 *  - objects: keys sorted lexicographically by UTF-8 bytes, compact, no whitespace
 *  - arrays: order preserved; numbers/strings/bools/null as native JSON
 *  - undefined is serialized as null (defensive; callers should omit undefined fields)
 *  - numbers are exact for integers; non-integer formatting is not part of the v0.1
 *    interop contract (the Rust kernel notes the same in kernel/src/canon.rs)
 *  - resulting string is UTF-8 encoded, SHA-256 hashed, hex lowercase
 *
 * Event hash input = canonical JSON of ALL envelope fields EXCEPT `hash`
 * (i.e. id, seq, ts, stream, type, actor, payload, prevHash).
 * Receipt hash input = canonical JSON of ALL receipt fields EXCEPT `hash`.
 *
 * NF-073 budget rails: `RunBudget` / `RunExit` are the v0.1 shape of the loop
 * safety rails (docs/24 §B NF-073; docs/28 §3 ruling 15).
 *
 * Kernel state layout (under --state-dir; default `<workspace>/.hz/state/kernel`
 * canonical, or `<workspace>/.hzcode/kernel` in a legacy workspace, honoured in
 * place — the rule lives in app/src/core/paths.ts):
 *   events/<stream-sanitized>.jsonl   append-only chained event streams
 *   receipts.jsonl                    append-only chained receipts
 *   policy.json                       optional policy override (see DEFAULT_POLICY)
 * Stream name "session:abc" -> file "session__abc.jsonl" (':' -> "__").
 *
 * Kernel protocol: NDJSON over stdio. One request per line:
 *   {"id": <number>, "method": "<name>", "params": {..}}   ->
 *   {"id": <number>, "result": {..}}  or  {"id": <number>, "error": {"message": ".."}}
 */

import { createHash, randomUUID } from "node:crypto";

export type ActorKind = "human" | "agent" | "tool" | "system";
export interface ActorRef {
  kind: ActorKind;
  id: string;
}

export interface EventEnvelope<P = unknown> {
  id: string;
  seq: number; // 1-based, monotonic per stream
  ts: string; // ISO-8601 UTC
  stream: string; // e.g. "session:<sessionId>"
  type: string; // dot-namespaced, see EventTypes
  actor: ActorRef;
  payload: P;
  prevHash: string | null;
  hash: string; // hex sha256, canonical rules above
}

/** Caller-provided part of an event; the log assigns seq, prevHash, hash. */
export type EventSeed = Pick<EventEnvelope, "id" | "ts" | "stream" | "type" | "actor" | "payload">;

export const EventTypes = {
  sessionStart: "session.start",
  sessionEnd: "session.end",
  messageStart: "message.start",
  messageDelta: "message.delta",
  messageEnd: "message.end",
  toolCall: "tool.call",
  toolResult: "tool.result",
  approvalRequest: "approval.request",
  approvalDecision: "approval.decision",
  receiptIssued: "receipt.issued",
  error: "error",
} as const;
export type EventType = (typeof EventTypes)[keyof typeof EventTypes] | string;

/* ------------------------------- Guard ------------------------------- */

export type GuardKind = "fs.read" | "fs.write" | "shell.exec" | "net.fetch" | "spawn" | "mcp.invoke";
export interface GuardAction {
  kind: GuardKind;
  target: string; // path for fs.*, command for shell.exec, url for net.fetch, <serverId>:<toolName> for mcp.invoke
  detail?: Record<string, unknown>;
}
export type GuardDecisionValue = "allow" | "ask" | "deny";
export interface GuardDecision {
  decision: GuardDecisionValue;
  reason?: string;
  leaseId?: string;
}
export interface Lease {
  leaseId: string;
  kind: GuardKind;
  pattern: string; // exact match, or a trailing "*" wildcard prefix (guard.rs rules)
  expiry: string; // ISO-8601
}

export type PolicyScope = "workspace" | "outside" | "*";
export interface PolicyRule {
  kind: GuardKind | "*";
  scope: PolicyScope;
  decision: GuardDecisionValue;
}

/**
 * Built-in policy used when <state-dir>/policy.json is absent.
 * Evaluation: deny > lease > ask > allow (docs/11 R1; docs/28 ruling 23).
 * Any matching deny wins; then an unexpired matching lease; then any matching
 * ask rule; then an allow rule; otherwise ask. "workspace" scope = the target
 * path resolves inside the workspace root, through symlinks; anything else is
 * "outside".
 */
export const DEFAULT_POLICY: PolicyRule[] = [
  { kind: "fs.read", scope: "workspace", decision: "allow" },
  { kind: "fs.write", scope: "workspace", decision: "allow" },
  { kind: "fs.read", scope: "outside", decision: "ask" },
  { kind: "fs.write", scope: "outside", decision: "ask" },
  { kind: "shell.exec", scope: "*", decision: "ask" },
  { kind: "net.fetch", scope: "*", decision: "ask" },
  { kind: "spawn", scope: "*", decision: "ask" },
  // docs/09 §4.7: `mcp.invoke` covers every MCP tool call, keyed by
  // `<serverId>:<toolName>`. Connects are admitted as `spawn`.
  { kind: "mcp.invoke", scope: "*", decision: "ask" },
];

/* ------------------------------ Receipts ------------------------------ */

export interface ReceiptInput {
  action: string; // e.g. "tool.execute"
  tool: string; // tool name
  argsDigest: string; // sha256 hex of canonical JSON of args
  resultDigest: string; // sha256 hex of result output
  leaseId?: string;
}
export interface Receipt extends ReceiptInput {
  id: string;
  seq: number;
  ts: string;
  prevHash: string | null;
  hash: string;
}

/* ------------------------------- Tools ------------------------------- */

export interface ApprovalRequest {
  title: string;
  detail?: string;
  kind: GuardKind | "other";
}
export type ApprovalHandler = (req: ApprovalRequest) => Promise<boolean>;

/**
 * A nested delegation run: the `agent` tool asks the runtime to execute `task`
 * in its own child session and return the subagent's final report. The runtime
 * supplies it on the tool context; a tool without one cannot delegate.
 */
export type DelegateRunner = (task: string, maxSteps?: number) => Promise<ToolResult>;

export interface ToolContext {
  cwd: string;
  workspace: string;
  sessionId: string;
  signal: AbortSignal;
  guard(action: GuardAction): Promise<GuardDecision>;
  approve(req: ApprovalRequest, action?: GuardAction): Promise<boolean>;
  receipt(rec: ReceiptInput): Promise<Receipt>;
  /** Present when the runtime supports delegation (the `agent` tool). */
  delegate?: DelegateRunner;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/**
 * Tool exposure class (research §1.6, codex ToolExposure reference). Controls
 * which specs the model sees in the default tool list; it never changes a
 * tool's dispatch resolution (getTool resolves any registered tool by name).
 *
 *  - "direct"         initial spec list — the model sees it from turn one.
 *  - "deferred"       absent from the default specs; discovered at runtime via
 *                     the `tool_search` meta-tool (matched over its searchInfo),
 *                     then visible+callable for the rest of that session.
 *  - "code_mode_only" only exposed inside a nested code-mode child tool list.
 *  - "hidden"         never exposed in any spec list.
 */
export type ToolExposure = "direct" | "deferred" | "code_mode_only" | "hidden";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  /**
   * NF-072 batch scheduling class. "shared" (the default when absent) lets
   * concurrent siblings in one batch run together; "exclusive" makes the call
   * its own barrier. Mutating and lifecycle tools are exclusive.
   */
  concurrencyClass?: "shared" | "exclusive";
  /**
   * Exposure class (research §1.6). ADDITIVE and optional: absent === "direct",
   * exactly as an absent `concurrencyClass` === "shared". A tool that sets no
   * exposure keeps today's behavior unchanged — it appears in the default spec
   * list and is callable. Only non-Direct tools (deferred/hidden/code_mode_only)
   * are gated out of the default specs; see tools/index.ts toolSpecs().
   */
  exposure?: ToolExposure;
  /**
   * Discovery surface for Deferred tools (research §1.6). ADDITIVE and optional.
   * `name` and `description` already live on Tool; `keywords` is the extra
   * matching surface the data-driven `tool_search` scores a query against.
   * Only meaningful for exposure === "deferred".
   */
  searchInfo?: { keywords: string[] };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/* ------------------------------ Providers ------------------------------ */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string as produced by the model
}
export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}
export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "notice"; message: string }
  | { type: "done"; stopReason: "end" | "tool_use" | "max_tokens" | "abort"; usage?: Usage }
  | { type: "error"; message: string };
export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMsg[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal: AbortSignal;
}
export interface Provider {
  name: string;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

/* -------------------------- Runtime facade (UI) -------------------------- */

export type KernelMode = "trusted" | "untrusted";

/**
 * The harness's estimate of what the next provider dispatch will carry — the
 * `/context` report. Harness-side numbers only: no provider call decides them.
 */
export interface ContextUsage {
  model: string;
  /** The model's context window in tokens. */
  window: number;
  /** Estimated prompt tokens for the dispatch (whole-prompt estimate, or the
   * newest provider usage anchor plus the locally counted tail). */
  estimatedInput: number;
  /** The output cap fitted to the remaining window for this dispatch. */
  maxOutput: number;
  /** Messages the dispatch carried (the compacted view's length). */
  messages: number;
  /** The dispatch window the history is fitted into (`HISTORY_LIMIT`). */
  historyLimit: number;
}

export type RuntimeEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.done"; text: string }
  | {
      type: "tool.card";
      callId: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "ok" | "error";
      summary?: string;
    }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | ({ type: "context.usage" } & ContextUsage)
  // ADDITIVE (FEAT-003): the per-turn aggregated file diff. This is a
  // harness-side UI/runtime facade event, exactly like `context.usage` and
  // `turn.done` above -- a computed surface the loop emits for the TUI, NOT a
  // durable kernel event. The kernel event catalogue (docs/_conventions.md §6)
  // is a CLOSED 44-name set and stays unchanged; adding a RuntimeEvent variant
  // does not touch it. One event per model turn that changed >=1 file:
  // `diff` is the aggregated unified diff across every file edited in the turn
  // (one net diff per file), `files` is how many files changed, `truncated` is
  // set when the total line cap clipped the diff.
  | { type: "turn.diff"; turn: number; files: number; diff: string; truncated?: boolean }
  | { type: "turn.done" };

export interface RuntimeCallbacks {
  onEvent(ev: RuntimeEvent): void;
}

export interface RuntimeOptions {
  workspace: string;
  model?: string;
  continueSession?: boolean;
  mock?: boolean;
  /** NF-073 run budget overrides (0 or absent per dimension = unlimited). */
  budget?: RunBudget;
}

export interface Runtime {
  readonly sessionId: string;
  readonly model: string;
  readonly providerName: string;
  readonly kernelMode: KernelMode;
  send(text: string, cb: RuntimeCallbacks): Promise<{ text: string; aborted: boolean; exit?: RunExit }>;
  abort(): void;
  close(): Promise<void>;
}

/* --------------------------- Budgets (NF-073) --------------------------- */

/**
 * Run budget for one run tree (NF-073). Every dimension is checked before a
 * provider dispatch; `0` (or absent) means unlimited — the one convention
 * budgets share everywhere (docs/05 `BudgetV1`: `0` = unlimited-but-audited).
 */
export interface RunBudget {
  /** Provider calls this run tree may make. */
  maxSteps?: number;
  /** Total tokens (input + output) charged across turns; failed turns included. */
  maxTokens?: number;
  /** Wall clock for the whole run tree; never reset, never lifted. */
  maxWallMs?: number;
}

/** The RC-7 terminal vocabulary (docs/_conventions.md RC-7), lowercase. */
export type TerminalState =
  | "succeeded"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown"
  | "budget_exhausted"
  | "timeout"
  | "interrupted";

/** Why a run stopped; `detail` is machine-readable, never prose. */
export interface RunExit {
  terminal: TerminalState;
  detail?:
    | "turn_end"
    | "aborted"
    | "provider_error"
    | "internal_error"
    | "steps"
    | "tokens"
    | "wall_clock"
    | "format_errors"
    | "unverified_completion";
}

/* --------------------------- Kernel protocol --------------------------- */

/** Request/response shapes per method; kernel and TS fallback must match. */
export interface KernelRequestMap {
  ping: { params: Record<string, never>; result: { version: string } };
  "log.append": { params: { stream: string; event: EventSeed }; result: EventEnvelope };
  "log.read": {
    params: { stream: string; fromSeq?: number; limit?: number };
    result: { events: EventEnvelope[] };
  };
  "log.verify": {
    params: { stream: string };
    result: { ok: boolean; count: number; brokenAt?: number };
  };
  "receipt.issue": { params: ReceiptInput; result: Receipt };
  "receipt.verify": { params: Record<string, never>; result: { ok: boolean; count: number; brokenAt?: number } };
  "guard.check": { params: { action: GuardAction; scope?: PolicyScope; leases?: Lease[] }; result: GuardDecision };
  "guard.lease": { params: { kind: GuardKind; pattern: string; ttlMs: number }; result: Lease };
  "guard.grant": { params: { kind: GuardKind; pattern: string; ttlMs: number }; result: Lease };
}

export type KernelMethod = keyof KernelRequestMap;
export const KERNEL_METHODS: KernelMethod[] = [
  "ping",
  "log.append",
  "log.read",
  "log.verify",
  "receipt.issue",
  "receipt.verify",
  "guard.check",
  "guard.lease",
  "guard.grant",
];

/* ------------------------------ Hashing ------------------------------ */

const textEncoder = new TextEncoder();

/**
 * Compare object keys by UTF-8 bytes, exactly as the Rust kernel sorts them.
 *
 * Array.prototype.sort() compares UTF-16 code units: an astral key (U+10000…)
 * begins with a surrogate in 0xD800–0xDBFF and would sort before U+E000–U+FFFF,
 * while byte order places it after. The interop tests pin both orders.
 */
function compareUtf8(a: string, b: string): number {
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const diff = (left[index] as number) - (right[index] as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareUtf8);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash of an envelope with every field except `hash`. */
export function hashEnvelope(ev: Omit<EventEnvelope, "hash">): string {
  return sha256Hex(canonicalJson(ev));
}

/** Hash of a receipt with every field except `hash`. */
export function hashReceipt(r: Omit<Receipt, "hash">): string {
  return sha256Hex(canonicalJson(r));
}

/* ------------------------------ Helpers ------------------------------ */

export function newId(): string {
  return randomUUID();
}
export function nowIso(): string {
  return new Date().toISOString();
}
