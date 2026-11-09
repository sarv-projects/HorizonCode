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
 * Provider credentials: `Credential` (Providers section) is the additive v0.1
 * shape for how a provider is authenticated. v1 implements `apiKey` and `none`
 * fully (the existing env/config key resolution feeds `apiKey`; `ollama` is
 * `none`). The `oauth` arm is RESERVED, not yet used by any code path — it is
 * declared now so later additive OAuth work (PKCE loopback + token refresh,
 * following opencode `plugin/provider/chatgpt.ts`) extends an existing contract
 * rather than making a second breaking change to this LAW file.
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
 * Fail-closed per-call SandboxMode ladder (FEAT-004) — mirrors
 * kernel/src/sandbox.rs byte-for-byte in semantics. Modeled on dsh's
 * escalation.ts (research/compare-ohmypi-deepseek.md §2.4). The kernel reports
 * the enforcement posture of a requested mode against the LIVE host
 * capabilities over the additive "sandbox.report" method and FAILS CLOSED: a
 * mode that requires FS confinement unavailable on the host returns a typed
 * SANDBOX_UNAVAILABLE (HZ_PRECONDITION_FAILED class), NEVER a silent "enforced",
 * NEVER silently unconfined (docs/11 S1/S4). No GuardDecision wire field was
 * added — the decision still carries only {decision, reason, leaseId?}; this
 * contract is the sandbox report shape only. DEFAULT_POLICY is unchanged.
 */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
/**
 * The strictly-WIDER modes a one-shot escalation may target FROM a mode (dsh
 * WIDER_MODES). read-only is the floor (nothing escalates TO it);
 * danger-full-access is the ceiling (nothing is wider).
 */
export const SANDBOX_WIDER_MODES: Record<SandboxMode, SandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
  "danger-full-access": [],
};
/**
 * The schema-enum escalation targets (dsh ESCALATION_TARGETS): the modes a
 * caller may ask to escalate to. read-only is the floor and is deliberately
 * absent — nothing escalates to it.
 */
export const SANDBOX_ESCALATION_TARGETS: SandboxMode[] = ["workspace-write", "danger-full-access"];
/**
 * The model-facing denial marker (dsh sandboxDenialMarker(mode)), byte-for-byte
 * from escalation.ts: `[sandbox: file access denied under ${mode} mode]`.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`;
}
/**
 * The model-facing escalation-hint marker (dsh escalationHintMarker(subject)),
 * byte-for-byte from escalation.ts. The source separates "available" from
 * "retry" with an EM DASH (U+2014) — preserved exactly, as this is model-facing
 * text. Matches kernel/src/sandbox.rs::escalation_hint_marker byte-for-byte.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available \u2014 retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}
/**
 * The paired escalation arguments that widen a single call (dsh
 * sandbox_permissions + justification). They travel TOGETHER and the
 * justification is non-empty (validateEscalationArgs). sandbox_permissions is a
 * strictly-wider mode per SANDBOX_WIDER_MODES.
 */
export interface SandboxEscalationArgs {
  sandbox_permissions: SandboxMode;
  justification: string; // non-empty
}
/**
 * Per-call enforcement completeness (dsh full|partial). A consumer needing the
 * absolute boundary can reject "partial".
 */
export type EnforcementCompleteness = "full" | "partial";
/**
 * The guarantee level for a single sandbox dimension (docs/11 S2/S3 guarantee
 * vector). Below "enforced" the DimensionReport.residual is non-empty.
 */
export type SandboxGuarantee = "enforced" | "best_effort" | "unsupported";
/**
 * One dimension of the guarantee vector. `residual` is NON-EMPTY whenever the
 * guarantee is below "enforced" (docs/11 S2/S3); `backend` is an explicit
 * mechanism name or "none" (docs/11 S5: no silent fallback).
 */
export interface SandboxDimensionReport {
  dimension: string; // e.g. "filesystem" | "network" | "process" | "resources"
  guarantee: SandboxGuarantee;
  backend: string; // explicit mechanism name or "none"
  residual: string; // non-empty when guarantee !== "enforced"
  /**
   * Whether the HOST offers the mechanism for this dimension (capability
   * detection). Informational only: available NEVER implies "enforced". The
   * kernel applies no OS confinement mechanism today (docs/28 ruling 44).
   */
  available?: boolean;
}
/**
 * What the host OFFERS (detection only, not enforcement). Additive field on
 * both sandbox.report outcomes; mirrors kernel Capabilities::to_json.
 */
export interface SandboxHostCapabilities {
  landlockFs: boolean;
  bwrapPresent: boolean;
  userns: boolean;
  seccomp: boolean;
  rlimits: boolean;
  netns: boolean;
}
/**
 * A per-call enforcement report for a requested mode (status "report"). backend
 * is the primary confinement backend name or "none" (S5). unavailableReason is
 * present when a required mechanism was absent but a partial boundary was
 * tolerated (so completeness is "partial" rather than SANDBOX_UNAVAILABLE).
 * danger-full-access reports NO dimension as "enforced" (S4).
 */
export interface EnforcementReport {
  status: "report";
  mode: SandboxMode;
  completeness: EnforcementCompleteness;
  backend: string;
  dimensions: SandboxDimensionReport[];
  unavailableReason?: string;
  hostCapabilities?: SandboxHostCapabilities;
}
/**
 * The typed SANDBOX_UNAVAILABLE outcome (status "sandbox_unavailable"): a mode
 * requires a dimension the host cannot enforce, so the kernel FAILS CLOSED
 * rather than running unconfined (HZ_PRECONDITION_FAILED class, docs/11 S1/S4).
 */
export interface SandboxUnavailable {
  status: "sandbox_unavailable";
  mode: SandboxMode;
  reason: string; // typed SANDBOX_UNAVAILABLE reason
  hostCapabilities?: SandboxHostCapabilities;
}
/** The sandbox.report outcome: either a report (possibly partial) or unavailable. */
export type EnforcementOutcome = EnforcementReport | SandboxUnavailable;

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
 * `profile` (additive, docs/15 §3.6) names a narrowing preset for the child.
 */
export type DelegateRunner = (task: string, maxSteps?: number, profile?: string) => Promise<ToolResult>;

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

/**
 * How a provider is authenticated (additive v0.1 shape; see the file header).
 * v1 implements `apiKey` and `none`; `oauth` is RESERVED for later additive
 * OAuth work (PKCE loopback + token refresh) and is not yet consumed by any
 * code path.
 */
export type Credential =
  | { kind: "apiKey"; value: string }
  | { kind: "oauth"; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { kind: "none" };

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
  // ADDITIVE (S1 P2): a bounded child-run event wrapped for the parent stream.
  // Like `turn.diff` it is a harness-side facade event, NOT a kernel event
  // (the 44-name catalogue is unchanged). `agentId` is the child session id,
  // `name` the delegating tool, `depth` the nesting level (always 1: a
  // subagent cannot spawn subagents). The runtime forwards only tool.card,
  // notice, error and the child's final assistant.done, truncates text, and
  // caps the number of events per child; the TUI renders them nested under
  // the agent card and the server relays them as ordinary `session.event`s.
  | { type: "subagent.event"; agentId: string; name: string; depth: number; event: RuntimeEvent; profile?: string }
  | { type: "turn.done" };

export interface RuntimeCallbacks {
  onEvent(ev: RuntimeEvent): void;
}

export interface RuntimeOptions {
  workspace: string;
  model?: string;
  continueSession?: boolean;
  /**
   * Resume a SPECIFIC existing session by id (ADDITIVE, server-mode resume-by-id).
   * When set, createRuntime opens exactly that session instead of the
   * most-recently-touched one (`continueSession`); a missing id fails closed.
   * This is what lets `session.list`'s `hz://session/<id>` addressing be honest:
   * any listed session — not just the latest — can be prompted/subscribed.
   * `sessionId` takes precedence over `continueSession` when both are present.
   */
  sessionId?: string;
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
    // SAFETY-RAILS: the loop-detection guard's hard stop at >= 5 consecutive
    // identical tool calls (app/src/core/guards/loop-detection.ts). Terminal
    // `failed`, so exitCodeFor's default arm already returns 1 — no change there.
    | "tool_loop"
    // SAFETY-RAILS: the mistake-tracker stop at the consecutive-mistake limit
    // (app/src/core/guards/mistake-tracker.ts), a SEPARATE axis from the
    // `format_errors` cap. Terminal `failed`, so exitCodeFor returns 1 by default.
    | "consecutive_mistakes"
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
  // FEAT-004 (additive): report the fail-closed enforcement posture of a
  // requested SandboxMode against the LIVE host capabilities. Validates the
  // optional escalation args (sandbox_permissions + justification travel
  // together, justification non-empty) BEFORE anything, and FAILS CLOSED — a
  // mode that requires FS confinement unavailable on the host yields a typed
  // SANDBOX_UNAVAILABLE outcome, NEVER a silent "enforced". allowPartial lets a
  // tolerant caller receive a completeness="partial" report instead. The NDJSON
  // envelope is unchanged. Mirrors kernel/src/protocol.rs "sandbox.report"
  // byte-for-byte in semantics.
  "sandbox.report": {
    params: {
      mode: SandboxMode;
      sandboxPermissions?: SandboxMode;
      justification?: string;
      allowPartial?: boolean;
    };
    result: EnforcementOutcome;
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
  "sandbox.report",
];

/* --------------------------- Server protocol --------------------------- */

/**
 * The server surface (`hzcode serve`) of docs/14 §3.2, in a REDUCED v1 form.
 *
 * ADDITIVE and SEPARATE: these types never touch `KernelRequestMap` /
 * `KERNEL_METHODS` above — that table is the kernel's internal NDJSON protocol
 * and stays frozen. This block is the *client-facing* server protocol: a
 * long-lived leader exposes the agent over NDJSON JSON-RPC (the same framing
 * style the kernel header documents — one request per line, one response line
 * per request, plus `session.event` notifications that carry a `RuntimeEvent`).
 *
 * v1 implements exactly the subset `SERVER_METHODS` names below:
 *   server.hello, session.create, session.list, session.prompt,
 *   session.rewind, session.subscribe.
 * Every session is opened through `createRuntime`, so attach/resume runs BOTH
 * crash recoveries (repairDanglingToolCalls + recoverInterrupted) before the
 * next turn — the server's rollout-reconstruction seam.
 *
 * DESIGNED extension points NOT in v1 (so this is honestly a reduced surface):
 *   - transports beyond stdio (UDS/named-pipe, TCP loopback, HTTP/SSE/WS) — S32;
 *   - auth (S38) and discovery/registration-file (S34);
 *   - multi-client coordination: roles (S41), per-client cursors/lanes,
 *     driver-lease claim/release (S42–S44);
 *   - the ACP bridge (S89) and the remaining method families of §3.2
 *     (auth/transcript/diff/approval/receipts/artifacts/memory/terminal/…).
 * The single-attach rule (last subscriber for a session wins) is the reduced
 * stand-in for the multi-client coordination above.
 */

/** Protocol revision a client and the server must agree on (docs/14 S3). */
export const HZ_PROTO = 1 as const;

/** One NDJSON JSON-RPC request line: `{id, method, params?}`. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

/**
 * One response line: the request's `id` plus either a result or a typed error.
 * `id` is `null` ONLY for a frame that could not be correlated to a request id
 * (malformed JSON, or a missing/non-scalar `id`) — the JSON-RPC unmatchable id,
 * which can never collide with a real `number | string` correlation id. Added
 * ADDITIVELY: the shape of every *correlated* response (a real request's id +
 * result/error) is unchanged.
 */
export type ServerResponse = { id: number | string | null } & (
  | { result: unknown }
  | { error: { code?: number; message: string } }
);

/**
 * A server-initiated notification (no `id`, never answered). The streamed
 * turn events use method `session.event` with a `RuntimeEvent` payload tagged
 * with the owning `sessionId`.
 */
export interface ServerNotification {
  method: string;
  params: unknown;
}

/** The method name every streamed `RuntimeEvent` notification carries. */
export const SESSION_EVENT_METHOD = "session.event" as const;

/** The reduced v1 server method set (subset of docs/14 §3.2). */
export type ServerMethod =
  | "server.hello"
  | "session.create"
  | "session.list"
  | "session.prompt"
  | "session.rewind"
  | "session.subscribe";

export const SERVER_METHODS: ServerMethod[] = [
  "server.hello",
  "session.create",
  "session.list",
  "session.prompt",
  "session.rewind",
  "session.subscribe",
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
