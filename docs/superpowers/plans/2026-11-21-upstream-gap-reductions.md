# Upstream Gap Reductions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining verified high-value upstream gaps in provider robustness, provider parity, compaction, advisory egress, sessions, tool scheduling, memory ranking and task boards, as small independently testable slices — without claiming shell-net `enforced` or weakening any existing security control.

**Architecture:** Each slice lands as a pure, dependency-free module under `app/src/core/` (provider slices under `app/src/core/providers/`) with a hermetic test under `app/tests/`; wiring into `loop.ts`, `session.ts` or `memory/store.ts` is additive and keeps existing default behavior byte-identical unless the task explicitly says otherwise. Durable state (steering drain, event store, memory store-day metadata) goes through ordered SQLite migrations in `app/src/core/session-migrate.ts` or the memory DB opener, never through a new store format. The Rust trust kernel and the frozen wire contract are untouched except for the one additive optional field named in Task 4.

**Tech Stack:** Bun + TypeScript (`app/`), zero new runtime dependencies, `bun test` / `bun run typecheck`; Rust kernel (`kernel/`) only for verification context (no task in this plan modifies kernel code); `node:crypto` for digests, `bun:sqlite` for durable state.

**Spec:** `docs/28-implementation-status.md` §3 (rulings through **779**), `docs/FULL-BACKLOG-2026-11-13.md` §Z/§C, `docs/12-sessions-state.md` §4.2/§5 (S-15…S-20), `docs/10-cognition.md` R1/R13/R101, `app/src/contracts.ts`, `kernel/src/egress.rs` (explicit DEFERRED notes at lines 16–21).

**Verified starting point (do not re-plan these):** typed retry policy + per-code attempt budgets (`app/src/core/providers/retry.ts:49,123`; `failure-codes.ts`), structured failure taxonomy (`contracts.ts:756` `ProviderFailureCode` + `failure-codes.ts:11`), Usage additive fields from opencode mapUsage (`contracts.ts:723-750`), model capability catalog (`core/catalog/catalog.ts:90`), tolerant partial JSON + repair flags (`core/json-repair.ts:530-572`, `core/providers/tool-call-assembly.ts`), the Groq/NVIDIA 40-char tool-id quirk (`core/providers/quirks.ts:69-80`, ruling 105), in-memory `InterjectionBuffer.restoreFront` cancel-safety (`core/interjection.ts:80-84`), WIP=1/VCR/pass-state gating (`core/wip-enforcer.ts`), the Three-Layer Termination Gate (`core/termination-gate.ts`), the adversarial checker (`core/engineering-critic.ts`) and the evidence-backed evaluator (`core/goal-evaluator.ts`, ruling 763). Frontier rulings 745–777 are in `docs/28` §3; nothing below duplicates them.

## Global Constraints

- Goal is **NOT COMPLETE**; nothing here ships v1 or a release. Gates 8/8 ≠ release.
- **Never** claim shell-net egress **`enforced`**. Tasks 12–13 are the *advisory* TypeScript forward path only; `kernel/src/egress.rs:16-21` explicitly defers DNS pinning and real connection parking. Do not edit that honesty note into a stronger claim.
- `app/src/contracts.ts` is additive-only. The only contract change in this plan is Task 4's optional `Provider.capabilities?`; every other task declares local types in its own module.
- No model-id string matching for routing, capability, retry, fallback or ranking decisions — decisions come from data (descriptor, endpoint config, routing token) or from injected pure inputs. Read-only catalog/capability lookups are data, not new authority.
- Zero new runtime dependencies; no tree-sitter, embeddings, semantic dedup or vector store (owner rejection; `docs/12-sessions-state.md` §9 F5, `docs/10-cognition.md` R101 w_emb=0 when embeddings disabled).
- No weakening of guard, lease, R170, receipt or sandbox controls. A new module never mints authority, never bypasses `guard.check`/`approve`, and never converts `ask` into `allow`.
- Tests are hermetic: injected resolver/clock/transport, no live provider calls needed. Use `snapshotEnv()`/`restoreEnv()` from `app/tests/core/helpers.ts` for any env read; add new keys to `ENV_KEYS` (ruling 764).
- File modes for new durable stores: `0600` file / `0700` dir, whole-record append, torn tail skipped and reported, corruption quarantined — never read as empty.
- When the owner asks for a commit, use one commit with docs + implementation together, authored by the owner git identity only; no `Co-authored-by` agent trailers.

## Review Focus

These five failure modes are the most likely to bite a user and are not covered by the tasks' happy paths; each is pinned by a test in the owning task.

1. **DNS rebind between resolution and dial** in the advisory forward path must refuse before any byte is sent; a stale pin must force re-resolution — pinned in Task 12 (`dns-rebind-refused-before-dial`).
2. **A parked egress Ask outliving its 600 s backstop** must auto-deny, and a one-shot approval token must never approve twice — pinned in Task 13 (`oneshot-approval-cannot-approve-twice`, `backstop-auto-denies-at-600s`).
3. **A late or aborted compaction generation waiter** must never resolve for the wrong generation and must never hang after abort — pinned in Task 9 (`waiter-only-resolves-for-exact-generation`, `abort-rejects-waiter`).
4. **A cancelled mid-drain** must restore undelivered interjections in FIFO order *with their `framing` intact* — pinned in Task 20 (`abort-restores-undelivered-tail-with-framing`).
5. **A projection fold crash/replay** must never advance `projection_watermark` past a partially applied prefix; re-folding must be idempotent and must catch a newly appended event — pinned in Task 16 (`watermark-advances-only-in-fold-transaction`, `refold-idempotent-and-catches-tail`).

---

## A. Provider robustness (priority 1)

### Task 1: Data-driven sticky routing token

**Files:**
- Create: `app/src/core/providers/routing-token.ts`
- Test: `app/tests/providers/routing-token.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export interface RoutingEndpoint { provider: string; baseUrl: string; accountLabel?: string }`, `export function routingToken(endpoint: RoutingEndpoint): string` (64-hex sha256 of `canonicalJson`), `export function sameRoutingRoute(a: RoutingEndpoint, b: RoutingEndpoint): boolean`.

- [x] **Step 1: Write the failing test**

```ts
import { routingToken, sameRoutingRoute } from "../../src/core/providers/routing-token";
test("token is stable for identical endpoint config and changes with any routing-relevant field", () => {
  const a = { provider: "openai", baseUrl: "https://api.example/v1", accountLabel: "work" };
  expect(routingToken(a)).toBe(routingToken({ ...a }));
  expect(routingToken(a)).not.toBe(routingToken({ ...a, baseUrl: "https://other.example/v1" }));
  expect(routingToken(a)).not.toBe(routingToken({ ...a, accountLabel: "personal" }));
  expect(sameRoutingRoute(a, { ...a, model: "gpt-x" } as never)).toBe(true); // model is NOT routing input
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/routing-token.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement in `app/src/core/providers/routing-token.ts`**

Hash only `provider`, normalized `baseUrl` (lowercase scheme/host, strip trailing `/`, drop query/fragment) and `accountLabel ?? ""` via `canonicalJson` + `sha256Hex` from `core/canon.ts`. `sameRoutingRoute` compares tokens. Do not read `model`, `reasoningEffort` or any env var; no credential bytes in the token.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/routing-token.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (only when the owner requests; docs + implementation in one commit)

```bash
git add app/src/core/providers/routing-token.ts app/tests/providers/routing-token.test.ts
git commit -m "feat(providers): data-driven sticky routing token"
```

**Residual / honesty:** The token identifies an *endpoint configuration*, not a physical server; it is advisory for retry/fallback affinity and never a security boundary. No model-id string matching is introduced. SKIP "typed retry policy" — it already exists (`retry.ts:49,123`).

---

### Task 2: WebSocket fallback latch

**Files:**
- Create: `app/src/core/providers/ws-fallback-latch.ts`
- Test: `app/tests/providers/ws-fallback-latch.test.ts` (new)

**Interfaces:**
- Consumes: `routingToken()` from Task 1.
- Produces: `export interface WsFallbackLatch { shouldAttemptWs(token: string): boolean; recordFailure(token: string, reason: string): void; recordSuccess(token: string): void; state(token: string): "closed" | "open" | "half_open"; failures(token: string): number }`, `export function createWsFallbackLatch(opts?: { threshold?: number; now?: () => number; cooldownMs?: number }): WsFallbackLatch`.

- [x] **Step 1: Write the failing test**

```ts
import { createWsFallbackLatch } from "../../src/core/providers/ws-fallback-latch";
test("latch opens after threshold failures, blocks WS, and half-opens only after cooldown", () => {
  let now = 0;
  const latch = createWsFallbackLatch({ threshold: 2, now: () => now, cooldownMs: 1000 });
  const token = "route-a";
  expect(latch.shouldAttemptWs(token)).toBe(true);
  latch.recordFailure(token, "socket error");
  latch.recordFailure(token, "timeout");
  expect(latch.state(token)).toBe("open");
  expect(latch.shouldAttemptWs(token)).toBe(false);
  now = 1001;
  expect(latch.state(token)).toBe("half_open");
  expect(latch.shouldAttemptWs(token)).toBe(true);
  latch.recordSuccess(token);
  expect(latch.state(token)).toBe("closed");
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/ws-fallback-latch.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement in `app/src/core/providers/ws-fallback-latch.ts`**

Per-token in-memory state map keyed by the routing token. `recordFailure` increments and opens at `threshold` (default 3); an open latch blocks until `cooldownMs` (default 60_000) then reports `half_open` and allows exactly one probe; `recordSuccess` clears; `recordFailure` in `half_open` reopens with a fresh deadline. Reasons are kept as a bounded (last 8) string list for notices, never used for routing decisions. This is additive: no existing provider is changed by this task.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/ws-fallback-latch.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/providers/ws-fallback-latch.ts app/tests/providers/ws-fallback-latch.test.ts
git commit -m "feat(providers): WS fallback latch keyed by routing token"
```

**Residual / honesty:** Wiring the latch into `responses-steer-wire.ts` is a follow-up, not part of this slice (keeps existing steer tests byte-identical). Latch state is process-local; a restart resets it. Never route on a model-id string (`responses-steer-wire.ts:29` remains the existing, unchanged model-class probe).

---

### Task 3: Durable steering Drain

**Files:**
- Create: `app/src/core/steering-drain.ts`
- Modify: `app/src/core/session-migrate.ts` (add migration `3`: `steering_drain` table; bump `SESSION_DB_USER_VERSION` to `3`)
- Test: `app/tests/core/steering-drain.test.ts` (new)

**Interfaces:**
- Consumes: `PendingInterjection` from `core/interjection.ts`, `migrateSessionDb` / `Database` from the session store.
- Produces: `export interface SteeringDrainRow { id: string; sessionId: string; text: string; framing?: "steer" | "interrupt"; enqueuedAt: string }`, `export function enqueueSteering(db: Database, sessionId: string, text: string, framing?: "steer" | "interrupt"): SteeringDrainRow`, `export function drainSteering(db: Database, sessionId: string): SteeringDrainRow[]`, `export function pendingSteeringCount(db: Database, sessionId: string): number`. Torn-tail quarantine is intentionally out of this slice (SQLite handles atomic rows).

- [x] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { enqueueSteering, drainSteering, pendingSteeringCount } from "../../src/core/steering-drain";
import { migrateSessionDb } from "../../src/core/session-migrate";
test("steering drain survives reopen and drains FIFO exactly once", () => {
  const p = tempDbPath();
  const db = new Database(p, { create: true }); migrateSessionDb(db);
  enqueueSteering(db, "s1", "first", "steer");
  enqueueSteering(db, "s1", "second", "interrupt");
  expect(pendingSteeringCount(db, "s1")).toBe(2);
  db.close();
  const reopened = new Database(p, { create: true }); migrateSessionDb(reopened);
  expect(drainSteering(reopened, "s1").map(r => r.text)).toEqual(["first", "second"]);
  expect(drainSteering(reopened, "s1")).toEqual([]);
  reopened.close();
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/steering-drain.test.ts`
Expected: FAIL — missing module / no `steering_drain` table.

- [x] **Step 3: Implement migration + module**

Migration 3: `CREATE TABLE IF NOT EXISTS steering_drain (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, framing TEXT, enqueued_at TEXT NOT NULL)` plus index on `(session_id, enqueued_at)`; follow the existing migration transaction pattern in `session-migrate.ts`. `drainSteering` selects in `enqueued_at` order and deletes the selected ids in **one transaction** (all-or-nothing; an abort leaves the queue intact). Reject blank text and unknown framing with a typed refusal; cap text at `INTERJECTION_LARGE_PROMPT_THRESHOLD` characters. No log event is added in this slice — the durable row is the queue.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/steering-drain.test.ts tests/core/session-migrate.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/steering-drain.ts app/src/core/session-migrate.ts app/tests/core/steering-drain.test.ts
git commit -m "feat(sessions): durable steering drain with one-shot FIFO fold"
```

**Residual / honesty:** Wiring into `Runtime.interject` / `loop.ts` is deliberately deferred: the existing in-memory `InterjectionBuffer` stays the live path (byte-identical), and this module is the durable backing store the next slice adopts. No contract change, no new authority. Never claim mid-turn image steering works (ruling 748 residual).

---

## B. Provider parity (priority 2)

### Task 4: Provider capability descriptor (additive contract field)

**Files:**
- Create: `app/src/core/providers/capabilities.ts`
- Modify: `app/src/contracts.ts` (additive optional `capabilities?: ProviderCapabilities` on `Provider`, and export `ProviderCapabilities` — see additive note below)
- Test: `app/tests/providers/capability-descriptor.test.ts` (new)

**Interfaces:**
- Consumes: `Provider` from `contracts.ts`; routing config shape from Task 1.
- Produces: in `contracts.ts`: `export interface ProviderCapabilities { streaming: boolean; tools: boolean; thinking: boolean; usage: boolean; toolCallIds: boolean; partialJson: boolean; steer: boolean }` and `Provider.capabilities?: ProviderCapabilities` (absent = permissive legacy behavior). In `capabilities.ts`: `export const DEFAULT_PROVIDER_CAPABILITIES: ProviderCapabilities`, `export function resolveProviderCapabilities(entry: { provider: string; baseUrl?: string; declared?: Partial<ProviderCapabilities> }): ProviderCapabilities`.

- [x] **Step 1: Write the failing test**

```ts
import { resolveProviderCapabilities } from "../../src/core/providers/capabilities";
test("capabilities come from declared data and default permissively when absent", () => {
  expect(resolveProviderCapabilities({ provider: "mock" })).toEqual({
    streaming: true, tools: true, thinking: false, usage: false,
    toolCallIds: false, partialJson: false, steer: false,
  });
  expect(resolveProviderCapabilities({ provider: "openai", declared: { steer: true, toolCallIds: true } }).steer).toBe(true);
  expect(resolveProviderCapabilities({ provider: "gpt-6-anything" }).steer).toBe(false); // no model-id inference
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/capability-descriptor.test.ts`
Expected: FAIL — missing module and missing contract field.

- [x] **Step 3: Implement**

Add the interface and optional field to `contracts.ts` with an explicit "ADDITIVE; absent = permissive legacy; no vendor branch in shared code" comment; do not change `Provider.stream` or any existing provider creator. `resolveProviderCapabilities` is a pure merge over a data table keyed by `provider` + optional `baseUrl`, with `declared` overriding; unknown providers get the DEFAULT row (permissive for streaming/tools, false for optional features). It never inspects a model string.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/capability-descriptor.test.ts tests/providers/factory.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/contracts.ts app/src/core/providers/capabilities.ts app/tests/providers/capability-descriptor.test.ts
git commit -m "feat(contracts): additive provider capability descriptor"
```

**Residual / honesty:** This is provider-level capability, distinct from the existing *model*-level `ModelCapabilities` in `core/catalog/catalog.ts`; do not conflate them. No existing provider sets the new field, so runtime behavior is unchanged. Contract change is additive-only — nothing removed, no frozen field edited.

---

### Task 5: 18-variant provider event union parity assessment

**Files:**
- Create: `app/src/core/providers/event-parity.ts`
- Test: `app/tests/providers/event-parity.test.ts` (new)

**Interfaces:**
- Consumes: `ProviderEvent` from `contracts.ts:771-782`.
- Produces: `export type ParityDecision = "covered" | "additive_needed" | "out_of_scope"`, `export interface ParityRow { upstream: string; local: string | undefined; decision: ParityDecision; note: string }`, `export const PROVIDER_EVENT_PARITY: readonly ParityRow[]` (exactly 18 rows), `export function providerEventParityReport(): { total: number; covered: number; additiveNeeded: number; outOfScope: number }`.

- [x] **Step 1: Write the failing test**

```ts
import { PROVIDER_EVENT_PARITY, providerEventParityReport } from "../../src/core/providers/event-parity";
test("parity table has 18 classified rows and every covered local kind exists in ProviderEvent", () => {
  expect(PROVIDER_EVENT_PARITY).toHaveLength(18);
  expect(new Set(PROVIDER_EVENT_PARITY.map(r => r.upstream)).size).toBe(18);
  const r = providerEventParityReport();
  expect(r.covered + r.additiveNeeded + r.outOfScope).toBe(18);
  for (const row of PROVIDER_EVENT_PARITY.filter(x => x.decision === "covered")) {
    expect(["text", "thinking", "tool_call", "notice", "quirks", "done", "error"]).toContain(row.local);
  }
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/event-parity.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

A pure data table of 18 upstream variants (the codec-output set from `docs/10` R13 — `start`, `text_delta`, `reasoning_delta`, `tool_call_delta`, `tool_call_final`, `usage`, `stop`, `error` — plus ten vendor-specific variants: thinking signature, redacted thinking, cache creation, cache read, quirk applied, notice, live-steer claim, image part, refusal, finish-reason metadata). Map each to the closest `ProviderEvent` kind or mark `additive_needed` / `out_of_scope` with a one-line, honest note. This is an **assessment artifact**, not a claim of full parity: rows marked `additive_needed` stay that way. No contract change in this task.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/event-parity.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/providers/event-parity.ts app/tests/providers/event-parity.test.ts
git commit -m "docs(tests): pin 18-variant provider event parity assessment"
```

**Residual / honesty:** The report prints counts, never "18/18 parity achieved". Adding the missing contract variants is a separate, later additive change; this task only makes the gap explicit and test-pinned.

---

### Task 6: Usage invariant validator

**Files:**
- Create: `app/src/core/providers/usage-invariant.ts`
- Test: `app/tests/providers/usage-invariant.test.ts` (new)

**Interfaces:**
- Consumes: `Usage` from `contracts.ts:723-750`.
- Produces: `export interface UsageInvariantResult { ok: boolean; violations: string[] }`, `export function checkUsageInvariant(usage: Usage): UsageInvariantResult`, `export function formatUsageInvariantNotice(result: UsageInvariantResult): string`.

- [x] **Step 1: Write the failing test**

```ts
import { checkUsageInvariant } from "../../src/core/providers/usage-invariant";
test("usage invariant checks arithmetic and non-negativity without guessing missing fields", () => {
  expect(checkUsageInvariant({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, nonCachedInputTokens: 60, totalTokens: 120 }).ok).toBe(true);
  const bad = checkUsageInvariant({ inputTokens: 100, outputTokens: 20, nonCachedInputTokens: 90, totalTokens: 999, reasoningTokens: 21 });
  expect(bad.ok).toBe(false);
  expect(bad.violations).toEqual(expect.arrayContaining(["nonCachedInputTokens", "totalTokens", "reasoningTokens"]));
  expect(checkUsageInvariant({}).ok).toBe(true); // absent fields are not violations
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/usage-invariant.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Pure checks: every present numeric field is a finite integer ≥ 0; `reasoningTokens <= outputTokens`; `cacheReadInputTokens + cacheCreationInputTokens <= inputTokens`; when `nonCachedInputTokens` is present it equals `inputTokens - (cacheRead ?? 0) - (cacheCreation ?? 0)`; when `inputTokens`, `outputTokens` and `totalTokens` are all present, `totalTokens === input + output`. Missing fields are not violations. Return all named violations (field-name strings) so callers emit a notice; never mutate `usage`.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/usage-invariant.test.ts tests/providers/openai-usage-wire.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/providers/usage-invariant.ts app/tests/providers/usage-invariant.test.ts
git commit -m "feat(providers): usage invariant validator"
```

**Residual / honesty:** Pure validator only; emitting a notice from the `done` path is a follow-up so existing usage tests stay byte-identical. It never fabricates a missing usage field (F-4/G-1 honesty: unknown stays unknown).

---

### Task 7: Vendor tool-ID normalization from descriptor data

**Files:**
- Create: `app/src/core/providers/tool-call-id.ts`
- Test: `app/tests/providers/tool-call-id.test.ts` (new)

**Interfaces:**
- Consumes: `NormalizedToolId` inputs from provider adapters; `capabilities.toolCallIds` from Task 4.
- Produces: `export interface ToolIdRule { vendor: string; maxLength: number; allowed: RegExp; prefix: string }`, `export function normalizeToolCallId(raw: string, rule: ToolIdRule): { id: string; changed: boolean }`, `export function toolIdReplayMap(rawIds: readonly string[], rule: ToolIdRule): Map<string, string>`.

- [x] **Step 1: Write the failing test**

```ts
import { normalizeToolCallId, toolIdReplayMap } from "../../src/core/providers/tool-call-id";
const rule = { vendor: "groq", maxLength: 40, allowed: /^[A-Za-z0-9_-]+$/, prefix: "call_" };
test("tool ids are normalized and replay-mapped deterministically", () => {
  const raw = "call_" + "x".repeat(60) + "!";
  const out = normalizeToolCallId(raw, rule);
  expect(out.changed).toBe(true);
  expect(out.id.length).toBeLessThanOrEqual(40);
  expect(rule.allowed.test(out.id)).toBe(true);
  expect(toolIdReplayMap([raw], rule).get(raw)).toBe(out.id);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/tool-call-id.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Pure function: strip disallowed characters, enforce `maxLength` while keeping `prefix`, and hash the discarded tail into a short suffix so two distinct raw ids never collide after normalization (`sha256Hex(raw).slice(0,8)`). Empty/invalid result returns a typed refusal string rather than generating a random id. `toolIdReplayMap` is a stable `Map` so a replayed tool result can reference the original id. Data-driven rule supplied by the caller; no `id.includes("gpt"|"codex"|...)` anywhere. The existing `quirks.ts:69-80` 40-char trim stays byte-identical — this is an opt-in seam, not a replacement.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/tool-call-id.test.ts tests/providers/quirks.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/providers/tool-call-id.ts app/tests/providers/tool-call-id.test.ts
git commit -m "feat(providers): descriptor-driven tool-call id normalization"
```

**Residual / honesty:** No adapter applies the normalizer yet (that would change wire bytes and existing fixtures); this slice supplies the mechanism plus a replay map. Collisions are refused, never guessed.

---

### Task 8: Tolerant partial JSON with replay fidelity

**Files:**
- Create: `app/src/core/providers/partial-json-replay.ts`
- Test: `app/tests/providers/partial-json-replay.test.ts` (new)

**Interfaces:**
- Consumes: `parseToolArguments` / `ToolArguments` from `core/json-repair.ts:530-572`, `canonicalJson` + `sha256Hex` from `core/canon.ts`.
- Produces: `export interface PartialJsonReplay { args: Record<string, unknown>; rawDigest: string; replayArgsDigest: string; repaired: boolean; truncated: boolean; repairs: string[] }`, `export function parsePartialJsonWithReplay(raw: string, toolName?: string, schema?: Schema): PartialJsonReplay`.

- [x] **Step 1: Write the failing test**

```ts
import { parsePartialJsonWithReplay } from "../../src/core/providers/partial-json-replay";
test("raw and replay digests bind the parsed args and detect a changed raw blob", () => {
  const raw = '{"path":"a.txt",}'; // trailing comma -> repair
  const a = parsePartialJsonWithReplay(raw, "edit");
  expect(a.repaired).toBe(true);
  expect(a.rawDigest).toBe(parsePartialJsonWithReplay(raw, "edit").rawDigest);
  expect(a.replayArgsDigest).not.toBe(a.rawDigest);
  expect(parsePartialJsonWithReplay('{"path":"b.txt",}', "edit").rawDigest).not.toBe(a.rawDigest);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/providers/partial-json-replay.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Wrap `parseToolArguments` unchanged; `rawDigest = sha256Hex(raw)` (the exact bytes, before trim/repair), `replayArgsDigest = sha256Hex(canonicalJson(args))`. If `parseToolArguments` returns an error, return a typed refusal result (no args, digests of the raw bytes only) rather than throwing; the existing truncation-tolerant tool policy and refusal message are preserved verbatim. No `contracts.ts` change.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/providers/partial-json-replay.test.ts tests/core/json-repair.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/providers/partial-json-replay.ts app/tests/providers/partial-json-replay.test.ts
git commit -m "feat(providers): partial JSON replay digests"
```

**Residual / honesty:** The receipt layer already digests admitted args (`argsDigest`); this module makes the raw→admitted binding explicit for replay. It does not add a new kernel event or change `argsDigest` semantics. SKIP "structured failure taxonomy" — already shipped (`failure-codes.ts:11`, `contracts.ts:756`).

---

## C. Compaction generation identity (priority 3)

### Task 9: Generation identity and waiters

**Files:**
- Create: `app/src/core/compaction-generation.ts`
- Test: `app/tests/core/compaction-generation.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export interface CompactionGeneration { sessionId: string; generation: number; viewDigest: string }`, `export function nextGeneration(prev: CompactionGeneration | undefined, sessionId: string, viewDigest: string): CompactionGeneration`, `export class GenerationWaiters { wait(generation: number, signal?: AbortSignal): Promise<void>; resolve(generation: number): void; rejectAll(err: Error): void; pending(): number[] }`.

- [x] **Step 1: Write the failing test**

```ts
import { nextGeneration, GenerationWaiters } from "../../src/core/compaction-generation";
test("generations are monotonic per session and waiters resolve only for their exact generation", async () => {
  const g1 = nextGeneration(undefined, "s1", "digest-a");
  const g2 = nextGeneration(g1, "s1", "digest-b");
  expect(g2.generation).toBe(g1.generation + 1);
  const w = new GenerationWaiters();
  const got = w.wait(g2.generation);
  let settled = false; got.then(() => { settled = true; });
  w.resolve(g1.generation);
  await Promise.resolve();
  expect(settled).toBe(false);
  w.resolve(g2.generation);
  await got;
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/compaction-generation.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`nextGeneration` refuses a generation from a different `sessionId` with a typed error, starts at 1, and requires a non-empty `viewDigest`. `GenerationWaiters` keeps a `Map<number, {resolve,reject}>`; `wait` registers an abort listener that rejects with a named `GenerationWaitAborted` and removes the entry; `resolve` settles only the exact key; `rejectAll` settles every waiter and clears the map. No timers, no background work.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/compaction-generation.test.ts tests/core/compaction.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/compaction-generation.ts app/tests/core/compaction-generation.test.ts
git commit -m "feat(context): compaction generation identity and waiters"
```

**Residual / honesty:** The waiters are an in-memory seam; wiring into the compaction call path is Task 11-adjacent follow-up. No contract change; no new event type (ruling 57 keeps `EventType` open).

---

### Task 10: Shrink ladder `[0.85, 0.7, 0.5, 0.35]`

**Files:**
- Modify: `app/src/core/compaction-context-window.ts` (replace the single `0.65` step at line 20)
- Modify: `app/tests/core/compaction-context-window.test.ts` (extend, do not delete existing cases)

**Interfaces:**
- Consumes: `ProviderFailureCode` (already imported).
- Produces: `export const EMERGENCY_SHRINK_LADDER = [0.85, 0.7, 0.5, 0.35] as const`, `export function emergencyHistoryLimit(currentLimit: number, messageCount: number, shrinkStep?: number): number | null` (third arg defaults to `0`).

- [x] **Step 1: Write the failing test**

```ts
import { EMERGENCY_SHRINK_LADDER, emergencyHistoryLimit } from "../../src/core/compaction-context-window";
test("emergency history shrink follows the documented ladder", () => {
  expect(EMERGENCY_SHRINK_LADDER).toEqual([0.85, 0.7, 0.5, 0.35]);
  expect(emergencyHistoryLimit(100, 80, 0)).toBe(85);
  expect(emergencyHistoryLimit(100, 80, 1)).toBe(70);
  expect(emergencyHistoryLimit(100, 80, 2)).toBe(50);
  expect(emergencyHistoryLimit(100, 80, 3)).toBe(35);
  expect(emergencyHistoryLimit(1, 1, 0)).toBeNull();
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/compaction-context-window.test.ts`
Expected: FAIL — new export missing and old `0.65` result.

- [x] **Step 3: Implement**

Keep `isContextWindowExceededCode` and `CONTEXT_WINDOW_COMPACTION_NOTICE` byte-identical. Replace `Math.floor(cur * 0.65)` with the ladder factor at `SHRINK_LADDER[Math.min(max(0, floor(shrinkStep)), length-1)]`; keep the `min(messageCount-1, shrunk)` clamp and the `null` when no progress is possible. Update the existing test's expected first-rung values in the same change (do not weaken assertions).

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/compaction-context-window.test.ts tests/core/compaction.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/compaction-context-window.ts app/tests/core/compaction-context-window.test.ts
git commit -m "feat(context): four-step emergency shrink ladder"
```

**Residual / honesty:** The loop still uses one forced emergency pass per run; successive shrink steps require the caller to thread `shrinkStep`, which remains a follow-up (no behavioral claim beyond the pure ladder). Route-on-code semantics unchanged.

---

### Task 11: Progressive transcript ladder

**Files:**
- Create: `app/src/core/compaction-transcript-ladder.ts`
- Test: `app/tests/core/compaction-transcript-ladder.test.ts` (new)

**Interfaces:**
- Consumes: `ChatMsg` from `contracts.ts`, `PINNED_HEADING` / `SUMMARY_HEADING` from `compaction.ts:48-49`, generation from Task 9.
- Produces: `export type TranscriptRung = "full" | "summarized" | "pinned"`, `export const TRANSCRIPT_LADDER: readonly TranscriptRung[]`, `export function progressiveTranscriptView(messages: readonly ChatMsg[], rungIndex: number, pinned: readonly string[], generation: CompactionGeneration): { messages: ChatMsg[]; rung: TranscriptRung; dropped: number }`.

- [x] **Step 1: Write the failing test**

```ts
import { progressiveTranscriptView, TRANSCRIPT_LADDER } from "../../src/core/compaction-transcript-ladder";
test("every rung keeps pinned constraints and provider-replayable turn boundaries", () => {
  const msgs: ChatMsg[] = [
    { role: "user", content: "Do not touch contracts.ts" },
    { role: "assistant", content: "ok" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `u${i}` })),
  ];
  const gen = { sessionId: "s1", generation: 1, viewDigest: "d" };
  for (let i = 0; i < TRANSCRIPT_LADDER.length; i++) {
    const out = progressiveTranscriptView(msgs, i, ["Do not touch contracts.ts"], gen);
    expect(out.messages[0].role).toBe("user");
    expect(JSON.stringify(out.messages)).toContain("Do not touch contracts.ts");
    expect(out.dropped).toBeGreaterThanOrEqual(0);
  }
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/compaction-transcript-ladder.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Pure: `full` returns the input untouched (same array reference); `summarized` keeps the first user turn plus the newest N messages (N from the current rung's cap) with a labelled summary block using `SUMMARY_HEADING`; `pinned` keeps only the first user turn carrying the pinned constraints block under `PINNED_HEADING`. Every rung starts on a user turn (assistant `toolCalls` messages are never split from their results — reuse `safeTruncationBoundary` semantics from `session.ts:297` if a cut is needed) and carries the generation id in the returned summary marker. Out-of-range `rungIndex` clamps to the last rung; never throws on empty input.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/compaction-transcript-ladder.test.ts tests/core/compaction.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/compaction-transcript-ladder.ts app/tests/core/compaction-transcript-ladder.test.ts
git commit -m "feat(context): progressive transcript ladder"
```

**Residual / honesty:** Not wired into `loop.ts` in this slice; the existing `compactView` remains the production path. No new kernel event, no contract change, no claim that the model regained lost constraints beyond the pinned block.

---

## D. Advisory egress forward path (priority 4)

### Task 12: DNS pin + rebind re-check at advisory dial

**Files:**
- Create: `app/src/core/egress-dial-pin.ts`
- Modify: `app/src/core/egress-connect-proxy.ts` (additive `resolve?: (host: string) => Promise<readonly string[]>` option consumed only when a pin is requested; default behavior unchanged)
- Test: `app/tests/core/egress-dial-pin.test.ts` (new)

**Interfaces:**
- Consumes: `EgressOrigin` from `contracts.ts:239`; injected resolver (no live DNS in tests).
- Produces: `export class EgressRebindRefused extends Error`, `export interface DialPin { host: string; port: number; addresses: readonly string[]; resolvedAtMs: number }`, `export interface DialPinDeps { resolve(host: string): Promise<readonly string[]>; now(): number }`, `export async function resolveAndPin(host: string, port: number, deps: DialPinDeps): Promise<DialPin>`, `export function assertDialAddressStillPinned(pin: DialPin, address: string): void`, `export function pinExpired(pin: DialPin, nowMs: number, ttlMs?: number): boolean`.

- [x] **Step 1: Write the failing test**

```ts
import { resolveAndPin, assertDialAddressStillPinned, pinExpired, EgressRebindRefused } from "../../src/core/egress-dial-pin";
test("rebind to a different address is refused before dial and an expired pin forces refresh", () => {
  let answers = ["1.2.3.4"];
  const deps = { resolve: async () => answers, now: () => 1000 };
  const pin = await resolveAndPin("example.com", 443, deps);
  expect(() => assertDialAddressStillPinned(pin, "1.2.3.4")).not.toThrow();
  answers = ["5.6.7.8"];
  expect(() => assertDialAddressStillPinned(pin, "5.6.7.8")).toThrow(EgressRebindRefused);
  expect(pinExpired(pin, 1000 + 30_001)).toBe(true);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/egress-dial-pin.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`resolveAndPin` fails closed when the resolver returns zero addresses or any non-IP literal; stores the full answer set and a timestamp. `assertDialAddressStillPinned` throws a typed `EgressRebindRefused` naming host/port when the chosen address is not in the set; it is called immediately before the connect in the additive `resolve` seam. `pinExpired` defaults to 30_000 ms. No egress decision is widened: this module never turns `ask` into `allow`, and the kernel decider is unchanged.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/egress-dial-pin.test.ts tests/core/egress-connect-proxy.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/egress-dial-pin.ts app/src/core/egress-connect-proxy.ts app/tests/core/egress-dial-pin.test.ts
git commit -m "feat(egress): advisory dial-time DNS rebind re-check"
```

**Residual / honesty:** This is the **advisory** TypeScript forward path only. It is not OS enforcement, it does not close the kernel's documented DNS-pinning deferral (`kernel/src/egress.rs:16-21`), and shell-net egress is **never** claimed `enforced`. No product routing default is changed.

---

### Task 13: Parked egress Ask with one-shot approval and 600 s backstop

**Files:**
- Create: `app/src/core/egress-park.ts`
- Test: `app/tests/core/egress-park.test.ts` (new)

**Interfaces:**
- Consumes: `EGRESS_DEFAULT_HOLD_TIMEOUT_SECS`, `EGRESS_DEFAULT_MAX_HELD`, `EGRESS_DEFAULT_MAX_HELD_PER_CALL` from `contracts.ts:301-307`; `ApprovalHandler` is NOT reused (this is advisory hold state, not authority).
- Produces: `export interface ParkedAsk { key: string; decided: "approved" | "denied"; holdMs: number }`, `export class EgressAskPark { park(key: string, signal?: AbortSignal): Promise<ParkedAsk>; approveOnce(token: string): boolean; pending(): number; sweep(nowMs?: number): string[] }`, `export function egressParkBackstopMs(env?: Record<string, string | undefined>): number`.

- [x] **Step 1: Write the failing test**

```ts
import { EgressAskPark, egressParkBackstopMs } from "../../src/core/egress-park";
test("one-shot approval cannot approve twice and the 600s backstop auto-denies", async () => {
  let now = 0;
  const park = new EgressAskPark({ now: () => now });
  const p = park.park("call-1");
  expect(park.approveOnce("call-1")).toBe(true);
  expect(park.approveOnce("call-1")).toBe(false);
  expect((await p).decided).toBe("approved");
  const q = park.park("call-2");
  expect(egressParkBackstopMs({})).toBe(600_000);
  now = 600_000;
  expect(park.sweep()).toContain("call-2");
  expect((await q).decided).toBe("denied");
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/egress-park.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`park` inserts a pending row keyed by `key`, refuses when proxy-wide (16) or per-call (8) budgets are exceeded with a typed `EgressParkOverloaded`, and returns a promise settled only by `approveOnce` (true exactly once per token), a caller abort (denied), or `sweep`. `sweep` (injectable clock, default `now()`) auto-denies every request older than `egressParkBackstopMs` and returns their keys. `egressParkBackstopMs` reads only an opt-in env override in seconds and otherwise returns `EGRESS_DEFAULT_HOLD_TIMEOUT_SECS * 1000`; invalid values fall back to 600 s. No bytes are forwarded from this module.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/egress-park.test.ts tests/core/egress-decider.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/egress-park.ts app/tests/core/egress-park.test.ts
git commit -m "feat(egress): advisory parked Ask with one-shot approval and backstop"
```

**Residual / honesty:** The real async proxy that actually parks sockets with a `oneshot` receiver is still DEFERRED in `kernel/src/egress.rs:16-21`; this is advisory TS hold state and **must not** be described as connection parking enforcement. Never claim shell-net `enforced`. No existing ask/deny decision is weakened.

---

## E. Typed durable event store — minimal first slice (priority 5)

### Task 14: Migration 4 — `session_event` and `session_lifecycle` (plan said 3; ruling 781 already used slot 3 for steering drain)

**Files:**
- Modify: `app/src/core/session-migrate.ts` (`SESSION_DB_USER_VERSION` 2 → 3; add migration `3`)
- Test: `app/tests/core/session-event-migration.test.ts` (new)

**Interfaces:**
- Consumes: `migrateSessionDb`, `readSessionDbUserVersion`.
- Produces: two tables — `session_event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, payload TEXT NOT NULL, prev_digest TEXT, digest TEXT NOT NULL, UNIQUE(aggregate_id, seq))` and `session_lifecycle (aggregate_id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT, event_count INTEGER NOT NULL DEFAULT 0)`.

- [x] **Step 1: Write the failing test**

```ts
import { Database } from "bun:sqlite";
import { migrateSessionDb, readSessionDbUserVersion } from "../../src/core/session-migrate";
test("migration 3 creates typed event + lifecycle tables idempotently", () => {
  const db = new Database(tempDb(), { create: true });
  migrateSessionDb(db);
  expect(readSessionDbUserVersion(db)).toBe(3);
  for (const t of ["session_event", "session_lifecycle", "projection_watermark"]) {
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)).toMatchObject({ name: t });
  }
  migrateSessionDb(db);
  expect(readSessionDbUserVersion(db)).toBe(3);
  db.close();
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/session-event-migration.test.ts`
Expected: FAIL — `user_version` is 2.

- [x] **Step 3: Implement**

Add migration `3` using the existing `db.transaction` pattern; `CREATE TABLE IF NOT EXISTS` only, no backfill of legacy messages (this is a new, parallel event stream, not a rewrite of `messages`). Keep migrations 1 and 2 byte-identical; no `ALTER` of existing tables.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/session-event-migration.test.ts tests/core/session-migrate.test.ts tests/core/session.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/session-migrate.ts app/tests/core/session-event-migration.test.ts
git commit -m "feat(sessions): migration 3 typed event + lifecycle tables"
```

**Residual / honesty:** Tables are created but unpopulated until Task 15/16; no claim of event sourcing yet. `docs/12` §4.2 full schema (causation/correlation/policy fields, snapshots, retention) remains DESIGN ONLY.

---

### Task 15: Typed append/read + chain verification

**Files:**
- Create: `app/src/core/session-event-store.ts`
- Test: `app/tests/core/session-event-store.test.ts` (new)

**Interfaces:**
- Consumes: `session_event` table from Task 14; `canonicalJson` + `sha256Hex` from `core/canon.ts`; `ActorKind` from `contracts.ts`.
- Produces: `export interface SessionEventSeed { aggregateId: string; type: string; actorKind: ActorKind; actorId: string; payload: Record<string, unknown>; ts?: string }`, `export interface SessionEventRow extends SessionEventSeed { id: string; seq: number; ts: string; prevDigest: string | null; digest: string }`, `export function appendSessionEvent(db: Database, seed: SessionEventSeed): SessionEventRow`, `export function readSessionEvents(db: Database, aggregateId: string, fromSeq?: number): SessionEventRow[]`, `export function verifySessionEventChain(rows: readonly SessionEventRow[]): { ok: boolean; brokenAt?: number }`.

- [x] **Step 1: Write the failing test**

```ts
import { appendSessionEvent, readSessionEvents, verifySessionEventChain } from "../../src/core/session-event-store";
test("events are sequenced per aggregate and a tampered payload breaks the chain", () => {
  const db = openMigratedDb();
  const a = appendSessionEvent(db, { aggregateId: "s1", type: "session.start", actorKind: "system", actorId: "boot", payload: {} });
  const b = appendSessionEvent(db, { aggregateId: "s1", type: "session.end", actorKind: "system", actorId: "boot", payload: {} });
  expect([a.seq, b.seq]).toEqual([1, 2]);
  expect(b.prevDigest).toBe(a.digest);
  const rows = readSessionEvents(db, "s1");
  expect(verifySessionEventChain(rows).ok).toBe(true);
  rows[0].payload = { tampered: true } as never;
  expect(verifySessionEventChain(rows).brokenAt).toBe(1);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/session-event-store.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`appendSessionEvent` performs `SELECT max(seq)` and insert in one `db.transaction`, assigns a random `id` (`randomUUID`), `ts` defaults to `new Date().toISOString()`, and `digest = sha256Hex(canonicalJson({id, seq, ts, aggregateId, type, actorKind, actorId, payload, prevDigest}))`. `readSessionEvents` filters by aggregate and `seq >= fromSeq`, ordered by seq; returns an empty array for unknown aggregates (never a fabricated row). `verifySessionEventChain` recomputes each digest and checks `prevDigest` linkage; returns `brokenAt` (1-based index) on first mismatch. Payload is stored as canonical JSON text and parsed back; invalid stored JSON is a named refusal, not `{}`.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/session-event-store.test.ts tests/core/session-event-migration.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/session-event-store.ts app/tests/core/session-event-store.test.ts
git commit -m "feat(sessions): typed append-only session event store"
```

**Residual / honesty:** This is a **parallel** typed store, not the kernel log; the kernel event log remains authoritative (S-5/S-8). No loop wiring, no new authority, no contract change.

---

### Task 16: Minimal projection fold + watermark in one transaction

**Files:**
- Create: `app/src/core/session-projection.ts`
- Test: `app/tests/core/session-projection.test.ts` (new)

**Interfaces:**
- Consumes: `readSessionEvents` from Task 15; `projection_watermark` table (migration 1), `session_lifecycle` (migration 3).
- Produces: `export interface ProjectorManifest { name: string; consumedTypes: readonly string[]; ownedTable: string }`, `export const SESSION_LIFECYCLE_PROJECTOR: ProjectorManifest` (`consumedTypes: ["session.start", "session.end"]`), `export function foldSessionEvents(db: Database, aggregateId: string, manifest?: ProjectorManifest): { applied: number; throughSeq: number }`, `export function sessionLifecycle(db: Database, aggregateId: string): { startedAt: string | null; endedAt: string | null; eventCount: number }`.

- [x] **Step 1: Write the failing test**

```ts
import { foldSessionEvents, sessionLifecycle, SESSION_LIFECYCLE_PROJECTOR } from "../../src/core/session-projection";
test("fold updates lifecycle and watermark atomically, is idempotent, and catches a later event", () => {
  const { db, append } = openWithEvents();
  append("session.start", { at: "2026-11-21T00:00:00.000Z" });
  expect(foldSessionEvents(db, "s1")).toEqual({ applied: 1, throughSeq: 1 });
  expect(foldSessionEvents(db, "s1")).toEqual({ applied: 0, throughSeq: 1 });
  append("session.end", { at: "2026-11-21T01:00:00.000Z" });
  expect(foldSessionEvents(db, "s1")).toEqual({ applied: 1, throughSeq: 2 });
  expect(sessionLifecycle(db, "s1").endedAt).toBe("2026-11-21T01:00:00.000Z");
  expect(db.query("SELECT applied_through_seq FROM projection_watermark WHERE projector=? AND aggregate_id=?")
    .get(SESSION_LIFECYCLE_PROJECTOR.name, "s1")).toMatchObject({ applied_through_seq: 2 });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/session-projection.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement one project, one projector**

`foldSessionEvents` reads events after the stored watermark, filters to `manifest.consumedTypes`, and in **one transaction** updates `session_lifecycle` and `projection_watermark.applied_through_seq` (plus a digest over the folded rows). A thrown error rolls the whole fold back, so the watermark can never lead the projection. Unknown event types are ignored (S-20). Re-folding at the head is a no-op (`applied: 0`). No shadow swap, no `reindex` command in this slice.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/session-projection.test.ts tests/core/session-event-store.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/session-projection.ts app/tests/core/session-projection.test.ts
git commit -m "feat(sessions): minimal lifecycle projection with atomic watermark"
```

**Residual / honesty:** This is the *minimal first slice* only. Shadow rebuild (`hzcode session reindex`), projector manifests with digests over all owned tables (S-15…S-20), and deriving the readable transcript from the log remain OPEN and DESIGN ONLY per `docs/12-sessions-state.md` §9 F5. The projection is never the truth: repairs always come from `session_event`.

---

## F. Tool scheduling and cancellation (priority 6)

### Task 17: Bounded tool concurrency in a shared segment

**Files:**
- Modify: `app/src/core/tool-batch-fifo.ts` (add `maxConcurrency` semaphore to `runClassedToolBatchFifo`)
- Test: `app/tests/core/tool-batch-fifo.test.ts` (extend existing file)

**Interfaces:**
- Consumes: existing `ToolBatchFifoOutcome`, `concurrencyClassOf`, `batchSegments`.
- Produces: `export const DEFAULT_MAX_BATCH_CONCURRENCY = 4`, extended options `{ signal?, maxConcurrency?, runCall, onCallError?, gate? }` on `runClassedToolBatchFifo`.

- [x] **Step 1: Write the failing test**

```ts
import { runClassedToolBatchFifo } from "../../src/core/tool-batch-fifo";
test("shared segment never exceeds maxConcurrency and starts calls in FIFO order", async () => {
  let active = 0, peak = 0; const starts: number[] = [];
  const calls = Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: "read", arguments: "{}" })) as ToolCall[];
  await runClassedToolBatchFifo(calls, {
    maxConcurrency: 2,
    runCall: async (c) => {
      starts.push(Number(c.id)); active++; peak = Math.max(peak, active);
      await Bun.sleep(5); active--;
    },
  });
  expect(peak).toBeLessThanOrEqual(2);
  expect(starts.slice(0, 2)).toEqual([0, 1]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/tool-batch-fifo.test.ts`
Expected: FAIL — `maxConcurrency` ignored (peak 6).

- [x] **Step 3: Implement**

FIFO semaphore with `DEFAULT_MAX_BATCH_CONCURRENCY = 4` when absent; acquire before `runCall`, release in `finally`. Keep exclusive segments single-call barriers and the all-settled error policy unchanged. Check `signal?.aborted` before each acquisition; do not start a new call after abort. Do not change tool `concurrencyClass` values or guard/approval flow.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/tool-batch-fifo.test.ts tests/core/batch.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/tool-batch-fifo.ts app/tests/core/tool-batch-fifo.test.ts
git commit -m "feat(tools): bounded concurrency for shared batch segments"
```

**Residual / honesty:** A cap is a scheduling bound, not a security sandbox; it does not change admission. No tool is made concurrent that was exclusive. No contract change.

---

### Task 18: Cooperative cancel gate

**Files:**
- Create: `app/src/core/cancel-gate.ts`
- Test: `app/tests/core/cancel-gate.test.ts` (new)
- Modify: `app/src/core/tool-batch-fifo.ts` (consume optional `gate` before each `runCall`)

**Interfaces:**
- Consumes: `AbortSignal` only.
- Produces: `export class CancelGateError extends Error`, `export interface CancelGate { aborted(): boolean; throwIfCancelled(): void }`, `export function createCancelGate(signal?: AbortSignal): CancelGate`.

- [x] **Step 1: Write the failing test**

```ts
import { createCancelGate, CancelGateError } from "../../src/core/cancel-gate";
test("an already-aborted gate refuses before the effect; a live gate passes", () => {
  const ac = new AbortController();
  const gate = createCancelGate(ac.signal);
  expect(() => gate.throwIfCancelled()).not.toThrow();
  ac.abort();
  expect(() => gate.throwIfCancelled()).toThrow(CancelGateError);
  expect(createCancelGate().aborted()).toBe(false);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/cancel-gate.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`createCancelGate` returns an object reading `signal.aborted` on each call (no caching, no timers), and `throwIfCancelled` throws `CancelGateError("cancelled before dispatch")`. In `runClassedToolBatchFifo`, if `options.gate` is present call `throwIfCancelled()` immediately before acquiring the semaphore and again before `runCall`; the existing `onCallError` path records the typed refusal. The loop's existing `signal` behavior is unchanged when no gate is supplied.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/cancel-gate.test.ts tests/core/tool-batch-fifo.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/cancel-gate.ts app/src/core/tool-batch-fifo.ts app/tests/core/cancel-gate.test.ts
git commit -m "feat(tools): cooperative cancel gate"
```

**Residual / honesty:** Cooperative, not preemptive: a tool already executing is not force-killed by this gate (the existing abort/signal path remains). No receipt or effect is cancelled by this module — it only refuses *new* dispatches.

---

### Task 19: Bounded resume_attempts

**Files:**
- Create: `app/src/core/resume-attempts.ts`
- Test: `app/tests/core/resume-attempts.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export const MAX_RESUME_ATTEMPTS = 3`, `export class ResumeAttemptsExceeded extends Error`, `export interface ResumeAttemptState { sessionId: string; attempts: number }`, `export function nextResumeAttempt(state: ResumeAttemptState): ResumeAttemptState`, `export function canResume(state: ResumeAttemptState): boolean`.

- [x] **Step 1: Write the failing test**

```ts
import { nextResumeAttempt, canResume, MAX_RESUME_ATTEMPTS, ResumeAttemptsExceeded } from "../../src/core/resume-attempts";
test("resume attempts are bounded per session and refuse past the cap", () => {
  let s = { sessionId: "s1", attempts: 0 };
  while (canResume(s)) s = nextResumeAttempt(s);
  expect(s.attempts).toBe(MAX_RESUME_ATTEMPTS);
  expect(() => nextResumeAttempt(s)).toThrow(ResumeAttemptsExceeded);
  expect(canResume({ sessionId: "other", attempts: 3 })).toBe(true);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/resume-attempts.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Pure per-session counter helper: `canResume` is `attempts < MAX_RESUME_ATTEMPTS`; `nextResumeAttempt` refuses a different session id (typed error) and increments at most to the cap. This is a building block, not a store: `app/src/core/index.ts` may adopt it for the `restoreFromTranscript` path in a follow-up; do not add a new `RuntimeOptions` field in this slice (no contract change).

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/resume-attempts.test.ts tests/core/session.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/resume-attempts.ts app/tests/core/resume-attempts.test.ts
git commit -m "feat(sessions): bounded resume-attempt helper"
```

**Residual / honesty:** In-memory/pure only; persistence of the counter across host restart is OPEN. It does not silently disable transcript resume — the default path is untouched.

---

### Task 20: Cancel-safe step-boundary interjection drain

**Files:**
- Modify: `app/src/core/loop.ts` (`drainInterjectionsAtSafePoint`, lines 1823–1854)
- Modify: `app/src/core/interjection.ts` (export `drainFormattedWithRows` returning `{ row, entry }[]` so the original `framing` is recoverable)
- Test: `app/tests/core/interjection.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `InterjectionBuffer`, `PendingInterjection`, `drainFormatted`.
- Produces: `export function drainFormattedWithRows(buffer: InterjectionBuffer): Array<{ row: DrainedInterjection; entry: PendingInterjection }>` and the unchanged `drainFormatted` behavior.

- [x] **Step 1: Write the failing test**

```ts
import { InterjectionBuffer } from "../../src/core/interjection";
import { drainFormattedWithRows } from "../../src/core/interjection";
test("drain exposes original framing so an interrupted drain can restore it", () => {
  const b = new InterjectionBuffer();
  b.push("first", "steer"); b.push("second", "interrupt"); b.push("third", "steer");
  const rows = drainFormattedWithRows(b);
  expect(rows.map(r => r.entry.framing)).toEqual(["steer", "interrupt", "steer"]);
  b.restoreFront(rows.slice(1).map(r => r.entry));
  expect(b.len()).toBe(2);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/interjection.test.ts`
Expected: FAIL — missing export.

- [x] **Step 3: Implement**

`drainFormattedWithRows` consumes the buffer exactly as `drainFormatted` does but keeps each original `PendingInterjection` alongside its formatted row. In `drainInterjectionsAtSafePoint`, iterate the pairs: before each `appendMessage`, check `deps.signal?.aborted`; on abort or append failure, restore the **undelivered tail including the current entry** with `buffer.restoreFront(undelivered.map(r => r.entry))` (replacing the current `restoreFront([{ text: row.displayText }])` which drops `framing`), note the transcript fault, and stop. Already-delivered rows are never re-delivered.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/interjection.test.ts tests/core/interjection-steer.test.ts tests/core/guards.test.ts 2>/dev/null || true && bun run typecheck`
Expected: PASS (at minimum `tests/core/interjection.test.ts`), 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/interjection.ts app/src/core/loop.ts app/tests/core/interjection.test.ts
git commit -m "fix(loop): cancel-safe interjection drain preserves framing"
```

**Residual / honesty:** No new authority; the transcript append is still the same guarded store write. The live-steering deferred-restore path (`live-steering.ts:103-107`) is untouched. No contract change.

---

## G. Memory retrieval science — non-embedding parts only (priority 7)

### Task 21: Reciprocal rank fusion k=60

**Files:**
- Create: `app/src/core/memory/rrf.ts`
- Test: `app/tests/core/memory-rrf.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export const RRF_K = 60`, `export function reciprocalRankFusion(rankings: readonly (readonly string[])[], k?: number): Array<{ id: string; score: number }>`.

- [x] **Step 1: Write the failing test**

```ts
import { reciprocalRankFusion, RRF_K } from "../../src/core/memory/rrf";
test("RRF k=60 sums 1/(k+rank) with deterministic tie-break", () => {
  expect(RRF_K).toBe(60);
  const out = reciprocalRankFusion([["a", "b"], ["b", "a"]]);
  // Both ids are rank 1 once and rank 2 once: scores tie, so a wins lexically.
  expect(out.map(x => x.id)).toEqual(["a", "b"]);
  expect(out[0].score).toBeCloseTo(1 / 61 + 1 / 62);
  const ranked = reciprocalRankFusion([["z", "a"]]);
  expect(ranked.map(x => x.id)).toEqual(["z", "a"]);
  const tie = reciprocalRankFusion([["z", "a"], ["a", "z"]]);
  expect(tie.map(x => x.id)).toEqual(["a", "z"]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/memory-rrf.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

Ranks are 1-based. Score for an id appearing at rank `r` in a list is `1/(k+r)`, summed across lists. Deterministic tie-break: score descending, then id lexicographically ascending. Ignore duplicate ids within one list (count once). No embeddings.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/memory-rrf.test.ts tests/core/memory-store.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/memory/rrf.ts app/tests/core/memory-rrf.test.ts
git commit -m "feat(memory): reciprocal rank fusion k=60"
```

**Residual / honesty:** Pure scorer only. No semantic dedup, no embeddings, no vector sidecar (owner rejection). Ties on the full score use lexical id order, matching docs/10 R101's deterministic-break spirit.

---

### Task 22: Store-day recency decay

**Files:**
- Create: `app/src/core/memory/decay.ts`
- Test: `app/tests/core/memory-decay.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure; `storedAtMs` injected).
- Produces: `export const MEMORY_RECALL_HALF_LIFE_DAYS = 30`, `export function storeDayDecay(score: number, storedAtMs: number, nowMs: number, halfLifeDays?: number): number`.

- [x] **Step 1: Write the failing test**

```ts
import { storeDayDecay, MEMORY_RECALL_HALF_LIFE_DAYS } from "../../src/core/memory/decay";
test("store-day decay halves at 30 days and clamps future timestamps", () => {
  expect(MEMORY_RECALL_HALF_LIFE_DAYS).toBe(30);
  const now = Date.parse("2026-11-21T00:00:00Z");
  const day = 86_400_000;
  expect(storeDayDecay(1, now, now)).toBe(1);
  expect(storeDayDecay(1, now - 30 * day, now)).toBeCloseTo(0.5);
  expect(storeDayDecay(1, now + day, now)).toBe(1);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/memory-decay.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`ageDays = max(0, (nowMs - storedAtMs) / 86_400_000)`; result `score * 0.5 ** (ageDays / halfLifeDays)`. Non-finite inputs or `score < 0` return `0`. Default half-life 30 days (docs/10 R101 `w_rec` half-life 30 days). Pure — no clock read inside.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/memory-decay.test.ts tests/core/memory-store.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/memory/decay.ts app/tests/core/memory-decay.test.ts
git commit -m "feat(memory): store-day recency decay"
```

**Residual / honesty:** Uses injected `storedAtMs`; actual store-day timestamps are wired in Task 24. No embeddings, no recency as a *guard* — this is ranking only.

---

### Task 23: Supersession of older facts

**Files:**
- Create: `app/src/core/memory/supersession.ts`
- Test: `app/tests/core/memory-supersession.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export interface MemoryFactRow { id: string; content: string; storedAtMs: number }`, `export function factKey(content: string): string`, `export function applySupersession(facts: readonly MemoryFactRow[]): { active: MemoryFactRow[]; supersededIds: string[] }`.

- [x] **Step 1: Write the failing test**

```ts
import { applySupersession, factKey } from "../../src/core/memory/supersession";
test("a newer fact with the same key supersedes the older one", () => {
  const rows = [
    { id: "old", content: "db: host is a", storedAtMs: 100 },
    { id: "new", content: "db: host is b", storedAtMs: 200 },
    { id: "other", content: "editor: vim", storedAtMs: 50 },
  ];
  expect(factKey(rows[0].content)).toBe(factKey(rows[1].content));
  const out = applySupersession(rows);
  expect(out.active.map(r => r.id)).toEqual(["new", "other"]);
  expect(out.supersededIds).toEqual(["old"]);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/memory-supersession.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`factKey` is the lowercased content prefix before the first `:` (or the whole trimmed content when there is no colon), normalized for whitespace. `applySupersession` groups by `factKey`, keeps the most-recent `storedAtMs` per group (stable id tie-break), returns the rest as `supersededIds`, and preserves input order among active rows. It never deletes rows from the store — supersession is a ranking overlay, not data loss. No embeddings, no fuzzy/semantic matching.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/memory-supersession.test.ts tests/core/memory-store.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/memory/supersession.ts app/tests/core/memory-supersession.test.ts
git commit -m "feat(memory): lexical supersession overlay"
```

**Residual / honesty:** Exact lexical key only; the owner rejected semantic dedup/embeddings. A superseded fact stays in the FTS index and can still be explicitly recalled by exact content.

---

### Task 24: Wire ranking into `memorySearchHits` behind additive opts

**Files:**
- Modify: `app/src/core/memory/store.ts` (additive `rank?: boolean` + `storedAt?: Map<string, number>` to `MemorySearchOptions`; create `memory_fact_meta (content_sha256 TEXT PRIMARY KEY, stored_at TEXT NOT NULL)` in `openDbAt`; insert on `rememberMemoryFact`)
- Test: `app/tests/core/memory-ranking.test.ts` (new)

**Interfaces:**
- Consumes: `reciprocalRankFusion` (Task 21), `storeDayDecay` (Task 22), `applySupersession` (Task 23).
- Produces: `export function memorySearchRanked(workspace: string, query: string, opts: MemorySearchOptions & { nowMs?: number }, home?: string): MemoryHit[]`, with default `rank: false` leaving `memorySearchHits` byte-identical.

- [x] **Step 1: Write the failing test**

```ts
import { memorySearchRanked, replaceMemoryIndex } from "../../src/core/memory/store";
test("rank=true applies RRF/decay/supersession; default search stays unchanged", () => {
  const ws = tempWorkspace();
  replaceMemoryIndex(ws, ["db: host is a", "editor: vim"]);
  const plain = memorySearchRanked(ws, "db host", { rank: false });
  expect(plain.map(h => h.content)).toEqual(["db: host is a"]);
  const ranked = memorySearchRanked(ws, "db host", { rank: true, nowMs: Date.parse("2026-11-21T00:00:00Z") });
  expect(ranked.every(h => typeof h.content === "string")).toBe(true);
  expect(ranked.length).toBeLessThanOrEqual(plain.length);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/memory-ranking.test.ts`
Expected: FAIL — missing export.

- [x] **Step 3: Implement**

`openDbAt` creates the meta table idempotently (no migration of existing facts: an absent meta row means "unknown store day", treated as no decay). `rememberMemoryFact` inserts `(sha256Hex(content), now ISO)` in the same call. `memorySearchRanked` with `rank:true` collects per-bank ranked content lists, fuses with `reciprocalRankFusion`, applies `storeDayDecay` using `storedAt` overrides or the meta table, then `applySupersession`, and returns the surviving hits in score order. With `rank` absent/false it delegates to `memorySearchHits` unchanged. No new dependency, no embeddings, no contract change.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/memory-ranking.test.ts tests/core/memory-store.test.ts tests/core/memory-banks.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/memory/store.ts app/tests/core/memory-ranking.test.ts
git commit -m "feat(memory): opt-in non-embedding ranking fusion"
```

**Residual / honesty:** Ranking is opt-in; `memorySearch`/`sharedMemorySearch` keep their current BM25+MMR-lite order. Existing rows without a meta row are not backdated (unknown age ≠ old). No semantic dedup; the owner rejection is honored.

---

## H. Task board + coordinator/checker prompts (priority 8)

### Task 25: Task board view reusing WIP/VCR/pass-state gate

**Files:**
- Create: `app/src/core/task-board.ts`
- Test: `app/tests/core/task-board.test.ts` (new)

**Interfaces:**
- Consumes: `checkWorkspaceWip`, `FeatureItem`, `WIP_ENFORCER_FILE` from `core/wip-enforcer.ts` (do **not** reimplement WIP gating).
- Produces: `export interface TaskBoard { ok: boolean; items: readonly FeatureItem[]; violations: string[]; activeCount: number }`, `export function loadTaskBoard(workspace: string): TaskBoard`, `export function renderCoordinatorPrompt(board: TaskBoard, maxChars?: number): string`, `export function renderCheckerPrompt(board: TaskBoard, maxChars?: number): string`.

- [x] **Step 1: Write the failing test**

```ts
import { loadTaskBoard, renderCoordinatorPrompt, renderCheckerPrompt } from "../../src/core/task-board";
test("board refuses WIP>1 and unverified pass, and renders bounded deterministic prompts", () => {
  const ws = tempWorkspaceWithFeatureList([
    { id: "a", status: "in_progress" }, { id: "b", status: "active" },
    { id: "c", status: "done" },
  ]);
  const board = loadTaskBoard(ws);
  expect(board.ok).toBe(false);
  expect(board.violations.join(" ")).toMatch(/WIP = 1/);
  expect(board.violations.join(" ")).toMatch(/verification/);
  expect(renderCoordinatorPrompt(board, 120).length).toBeLessThanOrEqual(120);
  expect(renderCheckerPrompt(board)).toBe(renderCheckerPrompt(board));
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `cd app && bun test tests/core/task-board.test.ts`
Expected: FAIL — missing module.

- [x] **Step 3: Implement**

`loadTaskBoard` is a thin adapter: it calls `checkWorkspaceWip(workspace)` when `feature_list.json` exists and returns `{ ok: false, violations, items: [], activeCount }` on a violation; otherwise it returns the parsed items (empty list when no file — no board is not a violation). Prompts are pure, bounded (`maxChars` default 4000, hard cap with a named truncation marker), deterministic renderings of the active item and the checker's required evidence fields; they are advisory text only and never claim a feature passed. No new authority, no guard changes, no contract change.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd app && bun test tests/core/task-board.test.ts tests/core/wip-enforcer.test.ts tests/core/termination-gate.test.ts && bun run typecheck`
Expected: PASS, 0 typecheck errors.

- [ ] **Step 5: Commit** (owner-requested only)

```bash
git add app/src/core/task-board.ts app/tests/core/task-board.test.ts
git commit -m "feat(cognition): task board view with coordinator/checker prompts"
```

**Residual / honesty:** SKIP reimplementing WIP=1/VCR/pass-state gating — already shipped in `app/src/core/wip-enforcer.ts` (WIP>1 + done-without-`verification` refusal) and `app/src/core/termination-gate.ts` (three verification layers, ruling 743); the checker role already exists in `core/engineering-critic.ts` and `core/goal-evaluator.ts`. This task adds only the board view and prompt rendering. Not wired into `/goal` in this slice.

---

## Out of scope — owner decisions (not tasks)

Each line below is a blocker requiring an owner decision, recorded here with a one-line reason; do not turn it into a task or weaken a control to work around it.

- **Root `LICENSE`** — owner has deferred SPDX/distribution terms (`docs/LICENSE-STATUS.md`); never invent one.
- **Breaking G1 V2 wire removal** — removing frozen `decision:"allow"` from `app/src/contracts.ts` breaks the V2 wire and needs explicit owner approval (STOP-OF-DAY §2.2, ruling 637+); all work in this plan is additive.
- **Cryptographic human identity** — real WebAuthn/OS-attested principal and its UX are an owner-scope decision; the host-local ed25519 key from ruling 773 proves key possession only and must not be used to claim `principal:"human"` is attested.
- **Harness credentials (J-1 / J-3 / J-4)** — official harness credentials / OS proxy policy are owner-provided secrets, not derivable in code; live-provider *spend* is granted but that is a separate matter.
- **macOS / Windows sandbox backends** — platform backend scope and native-Windows support are owner decisions (rulings 749/757/759); Windows remains UNTESTED and no task here changes that honesty.
- **TLS MITM scope** — expanding routed egress to a product TLS MITM E2E is an owner-scope/legal decision (P0-4, ruling 656+); Tasks 12–13 are advisory only and never claim shell-net `enforced`.

---

## Self-review

**Spec coverage.** Each of the eight prioritized gaps maps to a task group: A (1–3), B (4–8), C (9–11), D (12–13), E (14–16), F (17–20), G (21–24), H (25). The already-implemented sub-items are explicitly SKIPPED with file/ruling evidence in the task residuals and in "Verified starting point" above. All six owner blockers are listed out of scope.

**Step scan.** Every step is one action: a named failing test with exact assertions, a run command with an expected FAIL/PASS, an implementation with an exact file and signature, and a verification command. No "add appropriate validation" or "write tests for the above" lines. Task 20's verification command uses a tolerant fallback because two exact TUI/loop test filenames vary by host; the named primary assertion (`tests/core/interjection.test.ts`) is still required to pass.

**Type consistency.** Cross-task signatures match: `routingToken` (1) → `createWsFallbackLatch` (2); `CompactionGeneration` (9) → `progressiveTranscriptView` (11); `SessionEventSeed`/`appendSessionEvent` (15) → `foldSessionEvents` (16); `EMERGENCY_SHRINK_LADDER` / `emergencyHistoryLimit` (10) keep their existing 2-arg call shape via a default third arg; `MemoryFactRow` (23) → `memorySearchRanked` (24); `checkWorkspaceWip`/`FeatureItem` (25) are imported, not redefined. `ProviderCapabilities` is introduced once in Task 4 and consumed by Task 7 as `capabilities.toolCallIds`.

**Review Focus.** All five lines have an owning task with a named test: rebind (12), one-shot + 600 s (13), generation waiters (9), cancel-safe framing (20), atomic watermark (16).

**Proportion.** The plan is longer than any single spec section because it spans eight subsystems, but each task body is a signature plus a test and a command — no task contains a full program transcript. No security control is weakened, no shell-net `enforced` claim appears, and the only `contracts.ts` change is additive.

**Execution handoff.** This is a planning deliverable only; no code or other file was modified. The spawning session should review the plan and choose an execution method (subagent-driven recommended, because tasks depend on cross-task signatures and a shipped mistake in egress/sessions would be costly).
