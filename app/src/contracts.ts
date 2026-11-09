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
 * Command allowlist (FEAT-002) — mirrors kernel/src/execpolicy.rs byte-for-byte
 * in semantics. The kernel reads these shapes from <state-dir>/allowlist.json
 * (a bare array, or { rules, networkRules }) and the runtime amends them through
 * "guard.allowlist.amend". shell.exec consults the allowlist BEFORE the policy
 * rules: a matching deny wins (docs/11 R1), a matching allow admits, a non-match
 * or ask falls through to the policy flow unchanged. No GuardDecision wire field
 * was added — the decision still carries only {decision, reason, leaseId?}; the
 * allowlist surfaces through the existing reason string.
 */
export type AllowlistRuleKind = "prefix" | "network";
/** An argv-token pattern: a literal, or a one-of alternation. */
export type AllowlistPatternToken = string | string[];
export interface AllowlistPrefixRule {
  program: string; // the first argv token, keyed
  args?: AllowlistPatternToken[]; // trailing-arg pattern (per-token match)
  decision: GuardDecisionValue;
  canonicalMatching?: boolean; // default true: Unicode-caseless match
  match?: string[][]; // argv lines that MUST match (validated at load, codex R8)
  notMatch?: string[][]; // argv lines that MUST NOT match
}
export type AllowlistNetworkProtocol = "http" | "https" | "socks5_tcp" | "socks5_udp";
export interface AllowlistNetworkRule {
  host: string; // normalized: scheme/path/port stripped, no wildcards/whitespace, lowercased
  protocol?: AllowlistNetworkProtocol; // default "https"
  decision: GuardDecisionValue;
  justification?: string;
}

/**
 * Per-origin egress decision shape (FEAT-003) — mirrors kernel/src/egress.rs
 * byte-for-byte in semantics. The kernel reads these shapes from
 * <state-dir>/egress.json and consults the decider for net.fetch BEFORE the
 * policy rules (the FEAT-002 pattern). Composition, documented so it is
 * unambiguous: an egress policy file that is ABSENT means the decider is not
 * consulted and net.fetch keeps its policy-layer ask (DEFAULT_POLICY below is
 * unchanged — net.fetch=ask). When the file is PRESENT the decider is
 * default-deny (docs/11 N1): a Deny returns deny with its DenySource BEFORE
 * policy, an Allow admits, an Ask or an observe-mode AllowAndRecord falls
 * through to the net.fetch policy flow. No GuardDecision wire field was added —
 * the decision still carries only {decision, reason, leaseId?}; the egress
 * outcome surfaces through the existing reason string (as with FEAT-002).
 *
 * An origin is the (scheme, host, port) triple a rule is keyed on (docs/11 N2).
 */
export interface EgressOrigin {
  scheme: string; // lowercased (e.g. "https")
  host: string; // normalized bare host, lowercased
  port: number; // explicit, defaulted per scheme (443 https, 80 http)
}
/** Where a deny came from (grok DenySource): a per-host row, or the org denylist. */
export type EgressDenySource = "deny_row" | "web_fetch_denylist";
/** What enforce mode WOULD have done, recorded by observe mode (grok WouldBe). */
export type EgressWouldBe =
  | { kind: "allowed" }
  | { kind: "denied"; source: EgressDenySource }
  | { kind: "asked" };
/**
 * The four decider outcomes (grok Decision). `allow_and_record` is observe
 * mode: it ADMITS (never blocks) but records what enforce mode would have done.
 */
export type EgressDecision =
  | { kind: "allow" }
  | { kind: "deny"; source: EgressDenySource }
  | { kind: "ask" }
  | { kind: "allow_and_record"; would: EgressWouldBe };
/** The stable outcome tag that appears in an EgressBlockedRequest.decided. */
export type EgressOutcome = "allow" | "deny" | "ask" | "allow_and_record";
/** The base decision a per-origin egress rule carries (no observe variant). */
export type EgressBaseDecision = "allow" | "deny" | "ask";
/**
 * A per-origin egress rule in <state-dir>/egress.json. A null/absent scheme or
 * port matches any; a present one must match exactly. Rules default to DENY
 * (docs/11 N1): an unmatched origin is denied.
 */
export interface EgressOriginRule {
  host: string; // normalized bare host (as AllowlistNetworkRule.host)
  scheme?: string | null; // exact scheme match, or any when absent
  port?: number | null; // exact port match (0..=65535), or any when absent
  decision: EgressBaseDecision;
}
/**
 * The egress policy document. A bare array is the `rules` list (enforce mode,
 * empty denylist). The object form adds the org web-fetch denylist and the
 * observe-mode flag.
 */
export interface EgressPolicyDoc {
  rules: EgressOriginRule[];
  disallowedWebFetchDomains?: string[]; // org denylist -> DenySource "web_fetch_denylist"
  observe?: boolean; // safe-rollout: record would-be answers without blocking
}
/**
 * A CONTENT-FREE record of a decided egress request (grok BlockedRequest).
 * Carries ONLY the routing triple, the call tag, the outcome, and the hold
 * timing — deliberately NO path/headers/body, so a record can never leak a
 * secret-bearing URL query, auth header, or request body. The buffer is bounded
 * to EGRESS_BLOCKED_REQUEST_CAPACITY (256) most-recent records.
 */
export interface EgressBlockedRequest {
  host: string;
  port: number;
  call: string; // command tag / call id (NOT a URL)
  decided: EgressOutcome;
  holdMs: number;
  deadlineUnix: number;
}
/** grok DEFAULT_MAX_HELD: proxy-wide concurrent-hold ceiling. */
export const EGRESS_DEFAULT_MAX_HELD = 16;
/** grok DEFAULT_MAX_HELD_PER_CALL: per command-tag concurrent-hold ceiling. */
export const EGRESS_DEFAULT_MAX_HELD_PER_CALL = 8;
/** grok DEFAULT_HOLD_TIMEOUT (seconds): a held request auto-denies after this. */
export const EGRESS_DEFAULT_HOLD_TIMEOUT_SECS = 600;
/** grok BLOCKED_REQUEST_CAPACITY: bounded record-buffer size. */
export const EGRESS_BLOCKED_REQUEST_CAPACITY = 256;

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
  // FEAT-002 (additive): append a rule to the runtime command allowlist at
  // <state-dir>/allowlist.json, file-locked append-dedup; consulted for
  // shell.exec BEFORE the policy rules (an allowlist deny wins, docs/11 R1).
  // kind defaults to "prefix" (a command rule); "network" appends an egress
  // rule. The NDJSON envelope is unchanged. Mirrors kernel/src/protocol.rs
  // "guard.allowlist.amend" byte-for-byte in semantics.
  "guard.allowlist.amend": {
    params: { kind?: AllowlistRuleKind; rule: AllowlistPrefixRule | AllowlistNetworkRule };
    result: { changed: boolean; fingerprint: string };
  };
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
  "guard.allowlist.amend",
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
