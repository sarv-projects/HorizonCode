# 06 — Events & Flows

> The event log is the state of record, and every flow in the product is a sequence of events. This document fixes the envelope, the sequence and writer rules, the append transaction, the projector contract, the retention policy, the complete canonical event catalogue, and twenty-four end-to-end flows.

**Reading note.** This document has two parts. **Part A** is the event system (§2–§5). **Part B** is the flow catalogue (§6). Every flow names its actors, its numbered steps, the events emitted per step, and its failure branches. Nothing in this document is implemented: `hzcode` is a specification set (`/data/home/forge/hzcode/README.md`), so §10 Status declares levels honestly.

---

## 1. Purpose

This document decides seven things:

1. **What an event is** — the envelope, its identity, its ordering, its authority provenance.
2. **Who may write one** — the single-writer rule, per aggregate, with lease and epoch fencing.
3. **How one becomes true** — the append transaction that commits an event together with its projections.
4. **How the log survives time** — versioning, upcasting, `min_reader_version`, retention, snapshots and rebuild.
5. **What every canonical event means** — payload fields, emitter, consumers, durability, client visibility (all 44 names from `file:///data/home/forge/hzcode/docs/_conventions.md#L86-L88`).
6. **How the product behaves end to end** — 24 flows, each with failure branches.
7. **What is claimed** — per capability, a status level that may not exceed its evidence.

**Non-goals.** This document does not define the wire protocol (see `docs/07-apis-and-contracts.md`), the kernel ABI (`docs/11-authority-safety.md`), or the storage layout in full (`docs/12-sessions-state.md` owns tables, indices and durability). Where the two documents could disagree, `12` owns bytes on disk and `06` owns meaning and ordering.

---

## 2. Rules

Rules are numbered `E-*` (event system) and `F-*` (flows). Each is a MUST unless the text says SHOULD/MAY. Each is individually testable; §9 names the test that proves it.

### 2.1 Envelope and identity

| # | Rule |
|---|---|
| E-1 | Every durable fact is exactly one log record with the envelope defined in §3.1. State that is not in the log is a projection and is disposable. |
| E-2 | `event.id` is an `evt_<ulid>`: globally unique, monotonic at its creation site, and never reused — including across import, fork, replay and re-index. |
| E-3 | `event.type` is one of the canonical names in `file:///data/home/forge/hzcode/docs/_conventions.md#L86-L88`. A component that needs a new name MUST add it to that file in the same change; this document lists the gaps it found in §4.6 instead of inventing names. |
| E-4 | `event.payload` validates against the schema registered for `(type, typeVersion)`. An unvalidated payload MUST NOT be appended. |
| E-5 | Durability is a property of the type, not of the call site: a `durable`-typed event MUST reach the log before its effect is observable to a caller; an `ephemeral`-typed event MUST NOT be written to the log even if a caller asks. |
| E-6 | `causationId` names the immediate cause (another event id, or an effect id for effects). `correlationId` names the run, and is inherited by every child session, subagent and background job, so one trajectory can be assembled from the log. A record with a `causationId` that is absent from the log and absent from the imported archive is `LOG_DANGLING_CAUSE` (warn; refuse in `--strict`). |

### 2.2 Sequence rules

| # | Rule |
|---|---|
| E-7 | `seq` is per aggregate (`aggregate.kind` + `aggregate.id`), 0-based, contiguous, and assigned **only** inside the append transaction (§3.4), as `head + 1`. No component computes `seq` before the transaction. |
| E-8 | Within an aggregate, `seq` strictly increases by exactly 1 per appended record. Gaps are corruption (`LOG_SEQUENCE_GAP`) unless the missing range is covered by the retention ledger (§3.7). |
| E-9 | The aggregate head is monotonic: it never decreases, not after `hz.session.rewound`, not after a projection rebuild, not after archival. Rewind moves projections; it does not renumber history. |
| E-10 | `ts` is wall-clock milliseconds at append and is advisory for display only. Ordering, replay, projections and causal reasoning MUST use `seq`, never `ts`. |
| E-11 | Cross-aggregate observations are made with a **read watermark**: a reader that has applied every record with `seq ≤ w` for the aggregates it observes is `Synced(w)`. The watermark is a protocol fact (a `ReplayComplete` frame), not a log record, so no new event name is required. |
| E-12 | A reader that starts from `0` on a truncated aggregate MUST be told the retention floor first and MUST start at `max(requested, floor)`. Silence about truncation is a bug: an untold reader that assumes contiguity from 0 fails closed with `LOG_TRUNCATED`. |
| E-13 | Two records with the same `(aggregate, seq)` MUST NOT exist. Attempting to append one is `LOG_SEQUENCE_CONFLICT` and fails closed. Replay of an already-committed record is a no-op keyed on `event.id` (idempotent read), never a second write. |
| E-14 | An ephemeral record SHALL be encoded with `seq: null`; it carries `causationId` and `correlationId` so a client can place it, but it is never replayed and never ordered against the log. |

### 2.3 Single writer

| # | Rule |
|---|---|
| E-15 | Exactly one writer exists per aggregate at a time: the process that holds that aggregate's lease for the current owner epoch. For sessions the writer is the Controller's session actor; for kernel-owned state it is the `hzk` owner thread holding the owner lock. |
| E-16 | The session log is append-only. `UPDATE` and `DELETE` on log tables are forbidden and are enforced by database triggers in addition to the boundary test. |
| E-17 | Front-ends (TUI, print, server, web, desktop, IDE bridge, MCP server, SDKs) and plugins MUST NOT write the log. They send commands to the owner and observe events. This is what makes eight surfaces one agent rather than eight (ADR-005, `file:///data/home/forge/hzcode/docs/02-decisions.md#L130-L140`). |
| E-18 | A second process that wants to write acquires the lease from `session_claim` and, on failure, MUST downgrade to a read-only observer with an explicit diagnostic (`SESSION_LEASE_HELD`). There is no “last writer wins”. |
| E-19 | Every write carries the owner epoch. The append transaction compares the epoch against `session_claim.owner_epoch` and rejects a stale writer (`SESSION_EPOCH_STALE`) — fencing, not advisory locking. |
| E-20 | Emitter authority is fixed per event type (§4.2, “emitted by”). An event emitted by a component other than its declared writer fails the boundary test (`packages/horizoncode-testing`, `EVENT_EMITTER_DRIFT`). |
| E-21 | A model-originated or plugin-originated command can never produce an event that asserts human authority. `actorKind: user` is admissible only for a session with `authority.originKind == UserAction`, and that origin kind is fixed by the canonical operation, never by a request body. |

### 2.4 The append transaction

| # | Rule |
|---|---|
| E-22 | One call to `appendEvents` commits exactly one SQLite transaction containing: (a) the new log record(s), (b) the projections owned by the registered projectors for those types, (c) the commit hook (claim acquisition, claim release, usage accrual), and (d) the aggregate head update. The `seq` is read back from the committed row. |
| E-23 | The transaction starts with `BEGIN IMMEDIATE` so the write lock is taken before the head is read; this removes the read-then-write race between two writers on the same database file. |
| E-24 | If any projector or commit hook fails, the whole transaction rolls back and no event exists. Partial application is not a state this system may occupy. |
| E-25 | Fan-out to clients happens **after** commit and is best-effort: a lost frame is recovered by the client's cursor read, never by re-appending the event. |
| E-26 | The commit hook receives the committed `seq` and MUST be deterministic and replay-safe: on rebuild it must reproduce the same projection transition without side effects outside the database. |
| E-27 | Batched appends (a tool batch, a fork copy, a team broadcast) are one transaction. A batch of N records either commits all N contiguously or commits none; a batch never splits across an aggregate boundary. |
| E-28 | Payloads are inlined up to 64 KiB. Above the limit the body goes to the content-addressed blob store and the record keeps `payloadRef { sha256, bytes, mime }`. The event is the fact; the blob is the bytes; neither is authority. |
| E-29 | Writes to the log use the configured durability mode (§4.8 of `12-sessions-state.md`): `strict` (synchronous `FULL`) is the default on local filesystems, `fast` (`NORMAL`) is opt-in and lowers the power-loss guarantee explicitly. |
| E-30 | Every append records the effective authority pins it ran under: `policyRevision`, `postureDigest`, `intentDigest`, and `grantId` when a grant applied. An event whose pins cannot be read back is `LOG_PINS_MISSING` (fail-closed for effect events). |

### 2.5 Versioning and upgrade

| # | Rule |
|---|---|
| E-31 | Durable type identity is `type` + `typeVersion`. The registry row (`event_type_registry`) is the only authority on which versions exist, who writes them, and what `min_reader_version` is. |
| E-32 | A released `(type, version)` is immutable. A change of meaning requires a new version plus an upcaster; the old version is never reinterpreted. |
| E-33 | A reader that meets a version greater than it knows MUST refuse to decode (`EVENT_VERSION_UNSUPPORTED`) and MUST NOT write to that database. Best-effort decoding of durable events is forbidden. |
| E-34 | A reader that meets a type absent from its registry is in `DEGRADED_READ`: it may render the record as opaque, it may not project it, and it may not write. |
| E-35 | Upcasters are pure, total functions `version_n → version_n+1`, applied in order, tested against fixtures recorded from real logs (never hand-written). They must not consult the clock, the network, or provider state. |
| E-36 | `min_reader_version` is enforced per type: an older binary below it refuses to open the database for writing, with a diagnostic naming the type and the required version. |
| E-37 | Logs are never rewritten in place. A migration that appears to need rewriting is re-expressed as the addition of a new version plus a rebuild (`hzcode session reindex`, §3.6). |

### 2.6 Projector contract

Every projection has a `ProjectorSpec { name, owner, consumes[], tables[], applies(event, tx), digest(tx) }` and obeys:

| # | Rule |
|---|---|
| E-38 | Deterministic: the projector output is a pure function of the applied record sequence. No clock, no randomness, no network, no model call, no filesystem read other than the schema it declares. |
| E-39 | Idempotent per `(aggregate, seq, projector)`: replaying an already-applied record is a no-op. `projection_watermark(applied_through_seq)` is the recorded proof. |
| E-40 | Ordered: records are applied in `seq` order within an aggregate. Different aggregates may be projected concurrently. |
| E-41 | Same-transaction: the projector runs inside the append transaction of §2.4 and rolls back with it. |
| E-42 | Table ownership: a projector writes only the tables declared in its spec; the manifest test fails the build if two projectors declare the same table. |
| E-43 | No external side effects: side effects (UI frames, notifications, metrics, webhooks) run in a post-commit subscriber, never inside `applies`. |
| E-44 | Fail loudly: a projector that cannot apply a record throws `PROJECTION_DIVERGENCE` and aborts the transaction. It MUST NOT skip, swallow, or “best-effort forward”. |
| E-45 | Rebuildable: every projection can be dropped and re-created from the log alone. Being rebuildable is verified in CI by a shadow rebuild with digest comparison, not asserted in prose. |
| E-46 | Digest-stable: each projector exposes `digest(tx)` — an order-independent hash over its tables — so the rebuild can prove equivalence and the retention policy can prove a snapshot is safe. |

### 2.7 Retention, compaction and rebuild

| # | Rule |
|---|---|
| E-47 | Ephemeral records are never persisted; durable records are retained by default. Retention acts **only** through the retention ledger and snapshots, never by mutating or renumbering log records. |
| E-48 | A snapshot is a row in `event_snapshot` (not a log record): `(aggregateId, throughSeq, foldedDigest, blobRef, createdAt, policyRevision)`. It is a cache of a projection, and its only proof of validity is that rebuilding from the log reproduces `foldedDigest`. |
| E-49 | Prefix truncation is legal only when all of: (a) a snapshot covers the prefix, (b) every projector's live digest equals the snapshot's `foldedDigest`, (c) no pinned checkpoint, receipt, proposal or export references a record in the prefix, and (d) the ledger row is written in the same transaction. Otherwise the prefix is kept. |
| E-50 | Truncation is recorded in `retention_ledger(aggregateId, truncatedThroughSeq, snapshotId, reason, policyRevision, exportedArchiveDigest, at)`. Readers are told the floor; unrecorded truncation is `LOG_TRUNCATED` and fails closed. |
| E-51 | Log compaction never merges, rewrites or renumbers records. “Compaction” in this system means summarising *messages for the model* (`hz.session.compacted`) and is not the same operation as truncating the *log for storage* (`retention_ledger`). The two words are not synonyms and MUST NOT be used interchangeably in code or docs. |
| E-52 | Rebuild (`hzcode session reindex`) replays the log into shadow tables, compares `digest(tx)` per projector, and swaps in one transaction. A mismatch keeps the shadow for forensics and fails the command; it never silently adopts the rebuilt state. |
| E-53 | Rebuild is safe while a session is live: it reads with a snapshot watermark and writes only to shadow tables owned by the rebuild. It never acquires the session write lease. |

### 2.8 Flow rules

| # | Rule |
|---|---|
| F-1 | Every flow in §6 is replayable: given the log of a run, `hzcode session replay` reproduces the same projections, the same Guard decisions and the same effect terminals. A flow that cannot be replayed is a design defect, not a UI gap. |
| F-2 | Every effect reaches exactly one terminal: `SUCCEEDED`, `FAILED`, `DENIED`, or `UNKNOWN` (ADR-012, `file:///data/home/forge/hzcode/docs/02-decisions.md#L203-L210`). An effect with no terminal at restart becomes `UNKNOWN` by recovery, never by assumption. |
| F-3 | `UNKNOWN` is never automatically retried. Flow 8 and flow 13 are the only flows that may clear it, and both do so by *observation*, recorded as `hz.effect.reconciled`. |
| F-4 | Approval is an authorization boundary: no flow may proceed past an `ask` decision without a recorded `hz.permission.answered` from a `UserAction` origin. Timeouts resolve to deny. |
| F-5 | Every flow that can lose a human (unattended, scheduled, CI, subagent) MUST be explicit about what happens to `ask`: the answer is deny unless a bounded `DirectSessionGrant` pre-authorised that exact intent digest. |
| F-6 | No flow may widen authority. A child session, fork, rewind, skill, plugin, MCP server or proposal inherits a posture that is a narrowing (lattice meet) of its parent's. |
| F-7 | Every flow that mutates a workspace MUST leave a receipt whose observation is independent of the model's own text. The evidence gate may lower a claim but never raise it. |
| F-8 | Every flow states at least one failure branch; a flow with no failure branch is an untested flow. |

---

## 3. Interfaces (Part A)

### 3.1 The envelope

```ts
// packages/protocol/src/event.ts — generated from the schema, not hand-edited.
export interface DurableEventV1<TPayload = unknown> {
  // The ten core fields.
  readonly id: string // evt_<ulid>, globally unique, never reused (E-2)
  readonly seq: number | null // per-aggregate, contiguous; null iff ephemeral (E-7, E-14)
  readonly sessionId: string | null // session aggregate id; null for host-scoped records
  readonly ts: number // epoch ms, display only (E-10)
  readonly type: string // hz.<entity>.<past-tense-verb> (E-3)
  readonly payload: TPayload
  readonly causationId: string | null // event id or effect id
  readonly correlationId: string // run id; inherited by children (E-6)
  readonly actorKind: ActorKindV1 // user | model | controller | kernel | tool | plugin | scheduler | agent | mcp
  readonly actorId: string

  // Required extensions (same row, same transaction).
  readonly typeVersion: number // E-31
  readonly durability: "durable" | "ephemeral" // E-5
  readonly aggregate: { readonly kind: "session" | "run" | "owner" | "workspace"; readonly id: string }
  readonly authority: AuthorityPinsV1 | null // E-30
  readonly chain: { readonly prevDigest: string; readonly digest: string }
}
```

`AuthorityPinsV1` is `{ originKind: 'SessionBatch'|'UserAction'|'ManagedRun'|'ManagedRoot'; intentDigest: string; policyRevision: string; postureDigest: string; grantId?: string }`. `originKind` is fixed by the canonical operation, never supplied by a request body (`file:///data/home/forge/hzcode/docs/01-vision-and-superset.md#L54-L56`).

`chain.digest` is `sha256(canonicalJson(envelopeWithoutChain) || prevDigest)`. It gives the log tamper evidence that is independent of the kernel's OwnerLog hash chain, which covers kernel-side records.

### 3.2 The append API

```ts
// @horizoncode/core — the only writer entry point (boundary-tested: exactly one caller).
service EventLog {
  append(batch: AppendRequest): Effect<CommittedBatch, LogError>            // 1 tx (E-22, E-27)
  appendEphemeral(record: EphemeralRecord): Effect<void>                    // never persisted (E-5)
  read(input: { aggregate: AggregateRef; after?: number; through?: number }): Stream<DurableEventV1>
  tail(input: { aggregates: AggregateRef[]; after?: number }): Stream<TailFrame>  // replay -> live with watermark (E-11)
  head(aggregate: AggregateRef): number
  floor(aggregate: AggregateRef): number                                    // retention floor (E-12)
  rebuild(input: { aggregate?: AggregateRef; shadow: boolean }): Effect<RebuildReport, RebuildError>
}
```

`AppendRequest` carries `records[]`, `commit?: (seq: number) => void` (claim acquire/release, usage accrual), and `epoch` (fencing token, E-19). `TailFrame` is either a `DurableEventV1` or a `ReplayComplete { throughSeq }` watermark marker — a protocol frame, not a log record.

### 3.3 Kernel-side journals (the second writer)

Kernel-owned facts live in the kernel's own hash-chained OwnerLog, not in the session log: effect preparation, lease issuance, dispatch, settlement, reconciliation, worktree leases, schedule occurrences and secret use. The session log references them by digest (`receiptDigest`, `journalRecordDigest`) and never duplicates them as facts of record.

| Interface | Purpose |
|---|---|
| `OwnerLogV2::append(owner, events[], DurabilityProfile)` | Append to a per-owner hash-chained segment log; profile is `interactive_only` or `run_durable` (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/owner_log.rs#L352-L364`). |
| `OwnerHeadV2 { committedSeq, committedEventDigest, activeSegmentId, committedOffset, headDigest }` | The authoritative committed prefix; the head digest excludes its own field. |
| `HostKernel::open()` → reconcile | Reconciles every unresolved `PREPARED`/`RUNNING`/`DISPATCHING` row to `UNKNOWN` before the kernel reports ready (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs#L2507-L2527`). |

Durability profiles are translated into the flow semantics of §6.8: an `interactive_only` effect that has no terminal becomes `UNKNOWN`; a `run_durable` effect is reconciled before the run is allowed to report a verdict.

### 3.4 Projector registration

```ts
// Every projection declares itself; the manifest is generated from this call.
registerProjector({
  name: "session.message",          // unique
  owner: "@horizoncode/core",      // E-20 emitter/owner check
  consumes: ["hz.part.created", "hz.part.updated", "hz.session.compacted", "hz.session.rewound"],
  tables: ["session_message", "session_part", "projection_watermark"],
  applies: (event, tx) => { /* deterministic fold (E-38) */ },
  digest: (tx) => sha256OverTables(tx, ["session_message", "session_part"]),
})
```

### 3.5 CLI surfaces

| Command | Contract |
|---|---|
| `hzcode events tail [--session <id>] [--type <t>] [--json]` | Live tail; `--from <seq>` replays first, then tails, emitting a `ReplayComplete` marker in between. |
| `hzcode session log <id> [--raw] [--through <seq>]` | Dump of durable records in `seq` order; `--raw` includes payload bodies regardless of blob externalisation. |
| `hzcode session replay <id> [--to <seq>] [--speed n]` | Time-travel replay: renders steps, Guard decisions, leases and receipts as they occurred. Read-only; never re-executes effects. |
| `hzcode session reindex [--session <id>] [--shadow] [--report <path>]` | Projection rebuild with digest comparison (E-52). |
| `hzcode session verify <id>` | Evidence gate: folds receipts, lists `UNKNOWN` effects, and returns a verdict that can only be lower than the model's claim. |

---

## 4. Data (Part A)

### 4.1 Log tables

Schema `HZ_LOG_V1`. The log lives in the workspace state database (`<workspace>/.hz/state/hzcode.db`); `12-sessions-state.md` §4.1–§4.4 owns file layout, tables, indices and pragmas.

| Table | Columns (abridged) | Notes |
|---|---|---|
| `event` | `id PK`, `aggregate_kind`, `aggregate_id`, `seq`, `ts`, `type`, `type_version`, `actor_kind`, `actor_id`, `causation_id`, `correlation_id`, `session_id`, `origin_kind`, `intent_digest`, `policy_revision`, `posture_digest`, `grant_id`, `payload` (json ≤ 64 KiB → otherwise `payload_ref`), `payload_ref`, `prev_digest`, `digest` | Append-only. `UNIQUE(aggregate_id, seq)` is the sequence invariant (E-8, E-13). |
| `event_sequence` | `aggregate_id PK`, `seq`, `owner_epoch`, `updated_at` | The head pointer; read and written inside `BEGIN IMMEDIATE` (E-23). |
| `event_snapshot` | `snapshot_id PK`, `aggregate_id`, `through_seq`, `folded_digest`, `blob_ref`, `created_at`, `policy_revision` | A projection cache, not a fact (E-48). |
| `retention_ledger` | `row_id PK`, `aggregate_id`, `truncated_through_seq`, `snapshot_id`, `reason`, `policy_revision`, `exported_archive_digest`, `at` | The only legal record of a missing prefix (E-50). |
| `event_type_registry` | `type`, `type_version`, `schema_digest`, `writer_owner`, `durability`, `min_reader_version`, `introduced_at`, `upcaster_chain` | Loaded at open; a missing row for an encountered type is `DEGRADED_READ` (E-34). |
| `projection_watermark` | `projector`, `aggregate_id`, `applied_through_seq`, `digest` | Proves idempotent replay (E-39) and rebuild equivalence (E-46). |

Triggers `event_no_update` and `event_no_delete` raise on any attempted mutation of `event` rows (E-16).

### 4.2 The canonical event catalogue

All 44 names from `file:///data/home/forge/hzcode/docs/_conventions.md#L86-L88` (41 at first writing, plus `hz.session.moved` ratified as RC-1, plus `hz.memory.expired` and `hz.provider.account.rotated` ratified as RC-10). Nothing is omitted and nothing is added.

Legend — **Durability**: `D` durable in the session log, `E` ephemeral (broadcast only, never written). **Client visibility**: `S` on the session stream for any scoped client, `A` audit scope (full log read), `I` internal (not projected to clients; consumed by projectors/telemetry only), `L` loud (must be surfaced prominently and must not be scrolled away).

| # | Event | Payload fields | Emitted by | Consumed by | Dur | Vis |
|---|---|---|---|---|---|---|
| 1 | `hz.session.created` | `sessionId, projectId, workspaceId, parentId?, forkOf?{parentId,boundary}, location{directory,workspaceId}, posture{sandboxMode,approvalPolicy,source,revision,digest}, policyRevision, agentProfileId, modelRef{providerId,modelId}, title, slug, reattachedFrom?` | Controller session actor | session projector, session list, audit, IDE attach | D | S |
| 2 | `hz.session.prompt.admitted` | `sessionId, inboxId, delivery(steer\|queue), kind(user\|synthetic\|skill\|compaction\|move), payloadDigest, attachments[{sha256,mime,bytes}], enqueuedSeq, admissionActorKind` | Controller admission (before any work) | inbox projector, drain scheduler, queue indicator | D | S |
| 3 | `hz.session.claim.acquired` | `sessionId, claimId, ownerIncarnation, ownerEpoch, resumed(bool), recoveredFromClaimId?, acquiredSeq, ttlMs, resumeAttempt` | execution coordinator | claim projector, recovery scanner, session tree, budget gate | D | S |
| 4 | `hz.session.claim.released` | `sessionId, claimId, reason(succeeded\|failed\|interrupted\|superseded\|expired\|shutdown_preserved=false), durationMs` | execution coordinator | claim projector, orphan scanner | D | S |
| 5 | `hz.session.busy.entered` | `sessionId, claimId, busyEpoch, startedSeq, trigger(inbox\|steer\|resume\|scheduler)` | execution coordinator | busy projector, presence, TUI spinner | D | S |
| 6 | `hz.session.busy.left` | `sessionId, claimId, outcome(succeeded\|failed\|interrupted\|budget\|denied), durationMs, stepsCompleted, unknownEffectCount` | execution coordinator | busy projector, notifications, verdict assembly | D | S |
| 7 | `hz.step.started` | `sessionId, stepId, turnId, stepIndex, agentId, modelRef, context{prefixDigest,tailDigest,contextDigest}, toolCatalogVersion, cacheNamespace, budgetRemaining{tokens,wallMs,steps,cost}, continuationOfStepId?` | step engine | step projector, context ledger, TUI, trajectory | D | S |
| 8 | `hz.step.llm.requested` | `sessionId, stepId, providerId, modelId, requestDigest, cacheNamespace, cachePrefixDigest, streamAttempt, maxTokens, temperature?, reasoningEffort?, toolChoice` | provider layer | usage projector, cache-guard, trajectory, OTel | D | A |
| 9 | `hz.step.llm.delta` | `sessionId, stepId, partId, channel(text\|reasoning\|toolArgs\|usage), ordinal, deltaDigest, bytes, preview(≤256 B)` | provider layer | client fan-out only (coalesced into `part.updated`) | E | S |
| 10 | `hz.step.llm.completed` | `sessionId, stepId, finishReason(stop\|length\|tool_calls\|cancelled\|incomplete), usage{input,output,reasoning,cacheRead,cacheWrite}, costMicroUsd, toolCallCount, partIds[], firstTokenMs, totalMs, retryOfStepId?` | provider layer | step projector, usage/currency projector, TUI, evals | D | S |
| 11 | `hz.step.tool.requested` | `sessionId, stepId, callId, toolName, toolVersion, declarationDigest, inputDigest, input\|inputRef, capabilityId, effectClass, originKind, batchGroup?, ordinal` | step engine (model tool call) | tool batch scheduler, Guard, TUI, parity tests | D | S |
| 12 | `hz.step.tool.completed` | `sessionId, stepId, callId, requestEventId, status(succeeded\|failed\|denied\|unknown\|cancelled), outputDigest, outputRef?, receiptDigest?, receiptId?, durationMs, retryable, errorCode?` | tool runtime | step projector, verifier, TUI, trajectory | D | S |
| 13 | `hz.part.created` | `sessionId, messageId, partId, ordinal, role(user\|assistant\|system\|tool), partType(text\|reasoning\|tool\|file\|image\|artifact\|summary), ref?{sha256,mime,bytes}, metadata{inboxId?,callId?,skillId?,memoryIds?,agentId?}, bytes` | step engine, inbox delivery, shell, skill loader | message/part projector, context compiler, TUI | D | S |
| 14 | `hz.part.updated` | `sessionId, messageId, partId, ordinal, patchKind(append\|replace\|status), contentRef?, bytesAdded, coalescedCount, complete(bool)` | step engine (coalesced ≤ 4/s per part) | part projector, TUI streaming, context compiler | D | S |
| 15 | `hz.plan.updated` | `sessionId, planId, revision, status(draft\|awaiting_approval\|approved\|executing\|completed\|abandoned), steps[{id,title,status,dependsOn[]}], planDigest, approvedBy?, window?{maxSteps,maxTokens,expiresAt}` | plan engine / `plan_enter`/`plan_exit` | plan projector, router (plan-for-approval), TUI plan view | D | S |
| 16 | `hz.todo.updated` | `sessionId, revision, todos[{id,text,status(pending\|in_progress\|completed\|cancelled),dependsOn[]}], change(added\|updated\|removed\|reordered)` | `todo` tool | todo projector, fleet/task DAG view, TUI | D | S |
| 17 | `hz.goal.updated` | `sessionId, goalId, revision, statement, status(active\|achieved\|abandoned\|blocked), acceptance[{id,text,verifyHint}], evidenceRefs[]` | goal engine / `update_goal` | goal projector, verifier, TUI | D | S |
| 18 | `hz.effect.decision.made` | `effectId, sessionId, stepId?, callId?, capabilityId, effectClass, originKind, decision(allow\|ask\|deny), reasonCode, ruleId?, policyRevision, postureDigest, intentDigest, resourceResolutionRef` | `hzk` Guard | effect projector, approval UI, audit, parity tests | D | S |
| 19 | `hz.effect.lease.issued` | `effectId, leaseId, capabilityId, scope{workspaceId,paths[],argvPrefix?,domainAllow[]}, expiresAt, oneUse(true), fencingEpoch, poolRevision?, grantId?` | `hzk` lease registry | effect projector, EffectHost, audit, budget gate | D | A |
| 20 | `hz.effect.settled` | `effectId, leaseId, terminal(succeeded\|failed\|denied\|cancelled), observation{kind,digest,bytes,exitCode?,mtimeNs?,rowsAffected?}, receiptId, receiptDigest, observationRef?, startedAt, settledAt, bytesWritten, durationMs` | `hzk` EffectHost | effect projector, step engine, verifier, audit, TUI diff | D | S |
| 21 | `hz.effect.unknown` | `effectId, leaseId, reason(no_terminal_at_restart\|observation_lost\|transport_lost\|killed\|host_unavailable), suspectedClass, evidence[], requiresReconcile(true), detectedAt` | `hzk` recovery scan | effect projector, run verdict, TUI banner, verifier | D | L |
| 22 | `hz.effect.reconciled` | `effectId, method(observe\|probe\|manual\|declared_idempotent_retry), verdict(settled_succeeded\|settled_failed\|residual_unknown), evidenceDigest, receiptId?, actor` | reconciler (`effect.reconcile` command) | effect projector, verifier, audit | D | S |
| 23 | `hz.session.compacted` | `sessionId, throughSeq, keepFromSeq, strategy(single\|structured\|verbatim_tail\|snapcompact\|staged), stages[{name,inTokens,outTokens,costMicroUsd}], summaryPartId, tokensBefore, tokensAfter, trigger(ratio\|manual\|budget), epochStart` | compaction engine | message projector, context compiler, usage projector, TUI | D | S |
| 24 | `hz.session.checkpoint.created` | `sessionId, checkpointId, turnIndex, atMessageId?, atSeq, kind(turn\|manual\|pre_effect), workspace{revision,dirty[],untracked[],artifactRef?,bytes}, retention(keep_last_n\|pinned), policyRevision` | checkpoint engine | checkpoint projector, rewind, quota/eviction | D | S |
| 25 | `hz.session.rewound` | `sessionId, toTurn, toSeq, toMessageId, checkpointId?, scope(messages\|workspace\|both), reason(user\|policy\|cascade), priorHeadSeq, actor, workspaceVerdict?` | rewind engine (**UserAction origin only**) | message/part/inbox projector truncation, blob ref release, instruction rewind, audit | D | L |
| 26 | `hz.session.forked` | `parentSessionId, sessionId, boundary{messageId,type(before\|after)}, copiedThroughSeq, messageIdMapDigest, instructionEntriesDigest, postureChildDigest, costReset(true)` | fork engine | fork projector (copies settled history, dedups blobs), session tree, audit | D | S |
| 26b | `hz.session.moved` | `sessionId, movedFrom{projectId?,workspaceId,directory}, movedTo{projectId?,workspaceId,directory}, reason(user\|import), priorHeadSeq` | session identification (UserAction/import only) | session projector (identification update, same `sessionId`), session list, audit | D | L |
| 27 | `hz.agent.spawned` | `agentId, childSessionId, parentSessionId, parentStepId, spawnKind(task\|fleet_member\|team_member\|read_only_task\|skill\|background), profileId, grant{caps[],budget{tokens,wallMs,steps,costMicroUsd},depth,maxChildren,postureDigest}, capsuleDigest, correlationId` | the one spawn primitive (`agent.spawn`) | session projector, agent-tree projector, budget gate, TUI | D | S |
| 28 | `hz.agent.completed` | `agentId, childSessionId, status(succeeded\|failed\|denied\|budget_exhausted\|timeout\|cancelled\|unknown), resultDigest, summaryPartId?, usage{costMicroUsd,tokens}, receiptsDigest, durationMs, terminalReason?` | the one spawn primitive (on child terminal) | parent step engine, budget gate, trajectory, TUI | D | S |
| 29 | `hz.agent.message.sent` | `messageId, fromAgentId, toAgentId\|toChannel, targetSessionId, mailboxId, kind(instruction\|status\|result\|question\|control), payloadDigest, bodyRef?, delivery(steer\|queue), admittedSeq, budgetCharged` | message bus (`send_message`) | target inbox projector, agent-tree projector, TUI team view | D | S |
| 30 | `hz.memory.retained` | `memoryId, tier(working\|episodic\|semantic\|team), scope(session\|workspace\|user\|team), text\|contentRef, provenance{sourceSessionId,sourceSeq,evidenceDigest}, confidence, reviewed(bool), dedupKey, expiresAt?` | memory service (`memory_retain`, distillation) | memory projector, FTS+vector index, review UI | D | S (scope-filtered) |
| 31 | `hz.memory.recalled` | `queryDigest, tiers[], scope[], hits[{memoryId,tier,score,rank}], indexWatermark, tookMs, injectedPartId?` | retrieval (`memory_recall`) | step projector, context ledger, TUI “recalled” affordance | D | S |
| 31b | `hz.memory.expired` | `memoryId, tier, scope{kind,workspaceDigest}, digest, retentionClass, expiredAt, passId, actor(host\|human)` | retention pass (host) | memory store, review surface, audit | D | S |
| 32 | `hz.skill.invoked` | `skillId, name, version, digest, runAs(inline\|subagent), argsDigest, invokedBy{agentId,stepId}, agentId?, resultStatus?` | `skill` tool / slash command | skill projector, agent-tree projector, TUI | D | S |
| 33 | `hz.skill.installed` | `skillId, name, version, digest, source(registry\|file\|synthesised\|mcp), lockEntry, signature?, status(installed\|updated\|removed\|pinned\|rejected), reason?` | skill service (`skill_manage`) | skill registry projector, code-index/parity checks | D | S |
| 34 | `hz.learn.trajectory.recorded` | `trajectoryId, rootSessionId, runId, agentTreeDigest, eventCount, fromSeq, toSeq, receiptsDigest, redaction{policy,findings,quarantined}, bytes, storageRef, schemaRev` | learn service (post-run) | trajectory index, evals, audit | D | A |
| 35 | `hz.learn.proposal.created` | `proposalId, kind(memory_fact\|skill_bundle\|prompt_variant\|routing_heuristic\|doc_patch), title, diffRef, evidenceTrajectoryIds[], evalId, expectedEffect, riskClass, authorityImpact(none\|narrowing_only), status(proposed\|rejected\|accepted\|superseded), rejectedReason?` | learn service | proposal inbox, review UI, audit | D | S |
| 36 | `hz.learn.eval.completed` | `evalId, suite, suiteVersion, caseCount, score, baseline, delta, regression(bool), gate(pass\|fail), flakeRate, durationMs, trajectoryIds[], artifactsRef?` | eval harness | eval projector, ratchet gate, proposals | D | S |
| 37 | `hz.permission.asked` | `askId, sessionId, effectId?, capabilityId, toolName?, question, options[allow_once\|allow_scoped\|allow_session\|deny], intentDigest, previewRef?, defaultOnTimeout(deny), timeoutMs, expiresAt, requesterAgentId` | Guard / policy host | approval UI (TUI/web/desktop/IDE), notifications, scheduler | D | L |
| 38 | `hz.permission.answered` | `askId, decision(allow_once\|allow_scoped\|allow_session\|deny), scope?, answerDigest, answeredBy{actorKind,actorId,deviceId?}, latencyMs, grantId?, staleIntent(bool)` | front-end (**UserAction only**) | Guard, effect projector, audit, policy suggestions | D | S |
| 39 | `hz.policy.revision.changed` | `scope(user\|workspace\|session\|managed), previousRevision, newRevision, digest, source(file\|user_action\|managed_push\|trust_decision), changes[{ruleId,effect,before,after}], effectiveAt, changedBy` | policy host | posture projector, cache-guard (posture is in the prefix), audit, `doctor` | D | S |
| 39b | `hz.provider.account.rotated` | `sessionId, providerId, fromAccountRef, toAccountRef, reason(retryable_failures\|quota_exhausted\|invalid_credentials\|user_command\|circuit_open), estimatedCacheCost{prefixTokens,cold:true}, at` | provider account pool | cache reporting (`hzcode budget --cache`), status line, audit | D | L |
| 40 | `hz.error.raised` | `errorId, sessionId?, stepId?, severity(info\|warn\|error\|fatal), class(provider\|tool\|kernel\|sandbox\|policy\|cache\|storage\|protocol\|plugin\|mcp), code, message, retryable, transient?, detailsRef?, cause{type,eventId?}, failClosed(bool)` | any owner | error projector, TUI, OTel, verdict assembly, evals | D | S (≥warn loud) |
| 41 | `hz.usage.recorded` | `sessionId, scope(session\|agent\|run\|tree), modelRef?, tokens{input,output,reasoning,cacheRead,cacheWrite}, costMicroUsd, currency, priceTableRevision, cacheHit{read,write}, budgetAfter{tokens,wallMs,steps,cost}, attribution{stepId?,agentId?,callId?}` | usage accountant | usage/currency projector, budget gate, status line, exports | D | S |

### 4.3 Events that carry a graded guarantee

The catalogue is a set of meanings; several of them carry an explicit strength. These are the ones a reader must not paraphrase.

| Event | Guarantee it carries |
|---|---|
| `hz.effect.decision.made` | A Guard decision binds an `intentDigest`. A decision whose intent digest no longer matches the request is stale and MUST be re-evaluated — it is not a reusable yes. |
| `hz.effect.lease.issued` | A one-use lease, bounded by scope and expiry. Possession of `leaseId` is never authorization by itself; the kernel re-validates it at redemption. |
| `hz.effect.settled` | Carries an observation produced by the host (hash, exit code, byte count, stat), not by the model. This is the only shape of evidence the verifier accepts as independent. |
| `hz.effect.unknown` | Terminal for the attempt and sticky: it is not cleared by time, restart or retry. Only `hz.effect.reconciled` may follow it, and only with new evidence. |
| `hz.permission.answered` | The only admissible proof of human authority. It is rejected at append if `originKind != UserAction`, regardless of what any request body claims. |
| `hz.learn.proposal.created` | `authorityImpact` MUST be `none` or `narrowing_only`. A proposal that would widen authority is refused at creation (ADR-010, `file:///data/home/forge/hzcode/docs/02-decisions.md#L183-L189`). |
| `hz.session.rewound` | Declares that projections moved. It does not delete history and it does not make the workspace match the log unless `scope` includes `workspace` and a restore receipt exists. |

**Terminal vocabulary, reconciled with the authority documents.** `EffectReceiptV1.terminal` is exactly one of `SUCCEEDED`, `FAILED`, `DENIED`, `UNKNOWN`, assigned once per effect and monotone (`file:///data/home/forge/hzcode/docs/05-domain-and-schemas.md` D18). The log represents that same set with a split: `SUCCEEDED`, `FAILED` and `DENIED` arrive as `hz.effect.settled.terminal` (`denied` is a terminal of the effect, not only of the decision), while `UNKNOWN` arrives as its own event, `hz.effect.unknown`, because it is sticky and requires reconciliation rather than being a value that happened to settle. The mapping is one-to-one and lossless; a reader that needs the receipt's spelling maps `hz.effect.unknown` to `UNKNOWN`. Step and tool statuses use the lowercase set from §4.2 (`succeeded`, `failed`, `denied`, `cancelled`, `unknown`) because they describe a step's outcome, not a receipt terminal — the two vocabularies are deliberately distinct and MUST NOT be used interchangeably in code.

### 4.4 Inbox kinds and the records they become

The inbox is a projection; the durable facts are these events. No inbox state transition lacks an event.

| Inbox kind | At admission | At delivery | At cancellation |
|---|---|---|---|
| `user` prompt | `hz.session.prompt.admitted` | user `hz.part.created` (with `metadata.inboxId`) | projection row marked cancelled; a control item is admitted to explain why |
| `synthetic` / hook output | `hz.session.prompt.admitted` | `hz.part.created` (`role: system`, metadata records the hook id) | projection row marked cancelled |
| `skill` | `hz.session.prompt.admitted` (+ `hz.skill.invoked` when the skill body is resolved) | `hz.part.created` | as above |
| `compaction` (control) | `hz.session.prompt.admitted` (`kind: compaction`) | `hz.session.compacted` | as above |
| `move` (control) | `hz.session.prompt.admitted` (`kind: move`) | see gap **G-1** in §4.6 | as above |
| `steer` vs `queue` | the `delivery` field on `prompt.admitted`; steer promotes at the next safe step boundary, queue promotes at a turn boundary | same | same |

### 4.5 Emitter authority

| Emitter | May emit | MUST NOT emit |
|---|---|---|
| Controller session actor | all `hz.session.*`, `hz.step.*`, `hz.part.*`, `hz.agent.*`, `hz.plan.*`, `hz.todo.*`, `hz.goal.*`, `hz.session.compacted`, `hz.session.checkpoint.created`, `hz.session.forked`, `hz.usage.recorded` (as reported by its accountant) | `hz.effect.*` (kernel-owned facts), `hz.permission.answered` |
| `hzk` kernel | `hz.effect.decision.made`, `hz.effect.lease.issued`, `hz.effect.settled`, `hz.effect.unknown`, `hz.effect.reconciled`, `hz.policy.revision.changed` (kernel-observed revisions) | anything asserting model intent |
| Front-end | `hz.permission.answered` (UserAction), `hz.policy.revision.changed` (UserAction), `hz.session.rewound` (UserAction), commands only | everything else |
| Provider layer | `hz.step.llm.requested`, `hz.step.llm.delta` (E), `hz.step.llm.completed` | tool facts |
| Learn service | `hz.learn.*`, `hz.memory.retained` (distillation only, `reviewed:false`) | policy, authority, receipts |
| Plugin / MCP server | nothing directly: a plugin asks through the tool path, and its results appear as `hz.step.tool.completed` | every durable event name |

### 4.6 Declared catalogue gaps

These were real gaps found while writing this document. The owner of `_conventions.md` ruled on all five (RC-1…RC-3 in §11 of that file); the rulings are recorded here in place, so nothing is left dangling.

| # | Gap | Ruling | Where |
|---|---|---|---|
| G-1 | Session **re-home** had no canonical event. | **Resolved — RC-1.** `hz.session.moved` added to the catalogue (row 26b) and to `_conventions.md` §6. A re-home emits it in the destination log with `movedFrom`; the interim `created` + `reattachedFrom` encoding is superseded. | `_conventions.md` §11 RC-1 |
| G-2 | **Log snapshot / retention markers** had no canonical event. | **Ratified — RC-3.** They remain `event_snapshot` / `retention_ledger` rows: storage metadata, deliberately not facts. | `_conventions.md` §11 RC-3 |
| G-3 | **Credit side of usage for cancelled attempts** had no separate name. | **Ratified — RC-4.** `hz.usage.recorded` with `attribution.stepId` pointing at the cancelled step (which carries `retryOfStepId`). | `_conventions.md` §11 RC-4 |
| G-4 | **Worktree lease transitions** and **schedule occurrences** were not session events. | **Ratified — RC-3.** Kernel OwnerLog records referenced by digest; `hzcode worktree list --journal` must expose them for audit. | `_conventions.md` §11 RC-3 |
| G-5 | **Plugin load/unload** and **MCP server connect/discovery** had no canonical event. | **Ratified — RC-2.** Not events; failures are `hz.error.raised` with `class: plugin` / `class: mcp`. | `_conventions.md` §11 RC-2 |

---

## 5. Errors & failure modes (Part A)

`FC` = fail-closed: the operation is refused rather than attempted in a degraded mode. Every code below is a stable identifier that appears in `hz.error.raised.payload.code` and in CLI exit diagnostics.

| Code | Raised when | Behaviour | FC |
|---|---|---|---|
| `LOG_SEQUENCE_GAP` | A reader observes a missing `seq` not covered by `retention_ledger` | Refuse to project; the aggregate enters `LOG_CORRUPT`; `hzcode doctor` offers `session reindex --shadow` | yes |
| `LOG_SEQUENCE_CONFLICT` | Two writers computed the same `seq` (E-13) | The losing append fails; the loser re-reads the head; a repeated loss within a turn aborts the turn | yes |
| `SESSION_LEASE_HELD` | A second writer process attempts to write | Downgrade to read-only observer; tell the user which pid/incarnation holds the lease | yes |
| `SESSION_EPOCH_STALE` | A write carries an epoch older than `session_claim.owner_epoch` | Reject the write; the writer MUST re-acquire (fencing, E-19) | yes |
| `LOG_TRUNCATED` | A reader starts below the retention floor without being told | Refuse; re-issue the read with `floor` | yes |
| `EVENT_VERSION_UNSUPPORTED` | A record's `typeVersion` exceeds the reader's registry | Do not decode; do not write; report the version and the required reader | yes |
| `EVENT_SCHEMA_INVALID` | Payload fails its registered schema | Refuse the append; the emitting component is the bug, not the log | yes |
| `EVENT_EMITTER_DRIFT` | A component emits a type it does not own (§4.5) | Boundary test fails at build; at runtime the append is refused | yes |
| `EVENT_AUTHORITY_FORGED` | `actorKind: user` (or `hz.permission.answered`) with a non-`UserAction` origin | Refuse the append and raise a security event in OTel; never retried | yes |
| `PROJECTION_DIVERGENCE` | A projector cannot apply a record, or a rebuild digest mismatches | Abort the transaction (append) / keep the shadow and fail the command (rebuild) | yes |
| `PROJECTION_TABLE_OWNERSHIP` | Two projectors declare the same table | Build failure; at open, refuse to start projections | yes |
| `LOG_PINS_MISSING` | An effect-class record lacks `policyRevision`/`postureDigest` | Refuse; effects may not be recorded without pins | yes |
| `LOG_DANGLING_CAUSE` | `causationId` resolves to nothing local | Warn by default; refuse in `--strict` and in `session verify` | no (default) |
| `LOG_READ_ONLY_MODE` | Kernel absent, older than `HZ_ABI`, or log opened by a newer binary | Whole session is read-only with a named diagnostic (ADR-003, `file:///data/home/forge/hzcode/docs/02-decisions.md#L103-L106`) | yes |
| `LOG_BLOB_MISSING` | An event references a blob absent from the store | Render the record with an explicit missing-payload marker; refuse `session verify` success | yes |
| `INGEST_REJECTED` | Import/restore of an archive with a broken digest chain or an unsupported version | Nothing is applied; the target aggregate is untouched | yes |

Two error classes are deliberately *not* fail-closed, because failing closed would be worse than continuing with a loud marker: an `ephemeral` delta whose fan-out dies (a client that reconnects reads the log and catches up), and an OTel export failure (observability is not authority). Both raise `hz.error.raised` with `severity: warn` and `failClosed: false`.

---

## 6. Flows (Part B)

Common actors: **FE** front-end (TUI/print/server/web/desktop/IDE/SDK) · **CTL** Controller + session actor (`@horizoncode/core`) · **STEP** step engine · **CTX** context compiler (`@horizoncode/context`) · **PROV** provider layer · **KRN** `hzk` kernel (Guard, leases, EffectHost, receipt ledger) · **TOOL** tool runtime + `hz_native` · **MCP** MCP client · **PLG** plugin host · **SKL** skills · **AG** agents/fleet/teams · **SCH** scheduler · **LRN** learn service.

Every flow is written so that F-1 to F-8 hold; the failure branches say which of them is exercised.

### 6.1 Cold start to first token

**Actors.** FE, CTL, CTX, PROV, KRN.

1. `hzcode` resolves the workspace root and the config lattice: user config at `~/.config/horizon/`, then workspace `.hz/config` **narrowed onto** it (lattice meet; workspace may only restrict — ADR-008, `file:///data/home/forge/hzcode/docs/02-decisions.md#L163-L170`). Programs named by the workspace (hooks, LSP servers, MCP servers) are unloaded until trusted (`trust_decision`).
2. Kernel handshake: `hzk` starts (or is attached), the asset digest is checked against the pinned manifest, `HZ_ABI=1` and `HZ_PROTO=1` are negotiated, and `Sandbox::probe()` runs. A missing, older or crashed kernel puts the process in `LOG_READ_ONLY_MODE`: the TUI opens, explains, and **cannot execute** (ADR-003).
3. Storage opens: schema version checked; migrations applied only if log-compatible; WAL and pragmas set (§4.3 of `12-sessions-state.md`). The recovery scan runs: orphan claims and unresolved counsel records are found *before* the first prompt is accepted.
4. Recovery decisions: each orphaned claim either resumes (`hz.session.claim.acquired{resumed:true}`) or is released (`hz.session.claim.released`); each unresolved effect becomes `hz.effect.unknown`.
5. Session creation or resume: a fresh session emits `hz.session.created` with posture, policy revision and model ref; a resumed session replays its tail from the last watermark.
6. FE attaches and reads to the watermark; the header shows posture, model, budget and any `UNKNOWN` banner. No prompt is admitted before step 3 completes.
7. The user types (or `-p` is passed) and admission happens: `hz.session.prompt.admitted` is durable **before** any work.
8. CTL acquires the claim write-ahead: `hz.session.claim.acquired`, `hz.session.busy.entered`.
9. STEP compiles context: byte-stable prefix (system prompt + sorted tool schemas + declared config + posture) and a projected tail (memory, skills index, goal/plan, retrievals). `hz.memory.recalled` records any retrieval.
10. `hz.step.started` (with `contextDigest` and `cacheNamespace`), then `hz.step.llm.requested`.
11. `hz.step.llm.delta` frames stream to FE; the first frame is the first token. Deltas are ephemeral; they are coalesced into `hz.part.created` / `hz.part.updated` (≤ 4/s per part).
12. Step completes: `hz.step.llm.completed` with usage; `hz.usage.recorded` accrues the cost.

**Events.** `hz.session.created`, `hz.session.claim.acquired`, `hz.session.busy.entered`, `hz.session.prompt.admitted`, `hz.memory.recalled`, `hz.step.started`, `hz.step.llm.requested`, `hz.step.llm.delta` (E), `hz.part.created`, `hz.part.updated`, `hz.step.llm.completed`, `hz.usage.recorded`.

**Failure branches.**
- Kernel absent/older/mismatched digest ⇒ read-only, `hz.error.raised{class:kernel, failClosed:true}`, exit code 3 in headless.
- Sandbox probe reports a residual on a required dimension ⇒ refuse mutation capabilities for the session (`posture.source = residual`) rather than silently degrading (ADR-012 spirit; P6).
- Provider credentials missing or expired ⇒ `hz.error.raised{class:provider, retryable:false}` before any token; the session stays idle, claim released.
- Log opened by a newer binary (`EVENT_VERSION_UNSUPPORTED`) ⇒ read-only; no write attempt.
- Disk full at first append ⇒ `hz.error.raised{class:storage}` and the run stops; the prompt stays in the inbox as admitted-but-undelivered (flow 8 for the recovery rule).

### 6.2 Simple prompt turn with one file read

**Actors.** FE, CTL, STEP, PROV, TOOL.

1. Step 1 streams a tool call: `hz.step.llm.completed{finishReason:tool_calls}` and `hz.step.tool.requested{toolName:'read', capabilityId:'files.read', effectClass:'read-only'}`.
2. The tool batch scheduler checks the declaration: `read-only` class, parallel-safe. No Guard ask, no lease — read-only capability with an in-workspace path (`files.read` under posture `allow`).
3. TOOL resolves the path inside the workspace boundary (symlink escapes resolved and refused), reads through `hz_native`/`hz_walker`.
4. Result is recorded: `hz.step.tool.completed{status:succeeded, outputDigest, outputRef}` and a `hz.part.created{partType:tool}` carrying the tool result part (truncated per the tool's output budget, full body in the blob store).
5. Step 2 starts (`hz.step.started`), context reloads history **from the log** (one `llm.stream` per step; no in-memory loop), and includes the tool result.
6. Model answers; `hz.step.llm.completed{finishReason:stop}`; `hz.part.updated{complete:true}`; `hz.usage.recorded`.
7. Turn ends: `hz.session.busy.left{outcome:succeeded}`, `hz.session.claim.released{reason:succeeded}`.

**Events.** `hz.step.started`, `hz.step.llm.requested`, `hz.step.llm.completed`, `hz.step.tool.requested`, `hz.step.tool.completed`, `hz.part.created`, `hz.part.updated`, `hz.usage.recorded` (×2 steps), `hz.session.busy.left`, `hz.session.claim.released`.

**Failure branches.**
- Path outside the workspace, or a symlink that escapes ⇒ fail-closed: the tool returns a refusal, `hz.step.tool.completed{status:denied}`, no filesystem access attempted.
- File too large ⇒ the tool returns a truncated window plus a byte count; the model is told it was truncated (never silently truncated).
- Binary or undecodable file ⇒ `status:failed{errorCode:'not_text'}`; the run continues.
- ENOENT ⇒ `status:failed{errorCode:'enoent'}`; not an error event by itself (tools returning “no such file” is normal), but three consecutive `enoent` on the same path in one turn raise `hz.error.raised{class:tool, severity:warn}` to break a loop.
- The read races a concurrent write ⇒ the returned hash is recorded; the next mutation of that file re-checks the digest and, if it changed, the edit refuses (conflict-aware edit engine).

### 6.3 Mutating turn with approval ask

**Actors.** FE, CTL, STEP, PROV, KRN, TOOL.

1. Model emits `write`/`edit`: `hz.step.tool.requested{capabilityId:'files.write', effectClass:'workspace-write', inputDigest}`.
2. STEP resolves the intent to a canonical operation and computes the **intent digest** (path set, byte ranges, content hash, argv where applicable).
3. KRN Guard evaluates policy under the session posture ⇒ `hz.effect.decision.made{decision:'ask', reasonCode, policyRevision, postureDigest, intentDigest}`. **Nothing** is written at this point.
4. Guard emits `hz.permission.asked{askId, capabilityId, question, options[], previewRef, intentDigest, defaultOnTimeout:'deny', expiresAt}`. FE renders the diff preview; the run is blocked on this ask (the step is open, the claim is held).
5. The user answers: FE emits `hz.permission.answered{decision:'allow_once', answeredBy{actorKind:'user'}, answerDigest}`. The append is refused if the origin is not `UserAction` (E-21).
6. Guard re-evaluates with the answer: if `intentDigest` no longer matches (the file changed while the user was reading) the ask is superseded (`staleIntent`) and a fresh ask is issued. Otherwise the lease is minted: `hz.effect.lease.issued{leaseId, oneUse:true, scope{paths}, expiresAt, fencingEpoch}`.
7. EffectHost performs a durable **prepare** (journal: effect id, intent digest, lease id, pre-image hash), then executes through the native edit engine inside the sandbox.
8. Observation: post-image hash, byte delta, mtime; the host (not the model) produces the observation digest.
9. Settle: `hz.effect.settled{terminal:'succeeded', observation, receiptId, receiptDigest}` → `hz.step.tool.completed{status:'succeeded', receiptDigest}` → `hz.part.created{tool}` with the diff summary.
10. Next step continues with the receipt in context. `hz.usage.recorded` per step; the turn ends with `hz.session.busy.left` and `hz.session.claim.released`.

**Events.** `hz.step.tool.requested`, `hz.effect.decision.made`, `hz.permission.asked`, `hz.permission.answered`, `hz.effect.lease.issued`, `hz.effect.settled`, `hz.step.tool.completed`, `hz.part.created`, `hz.step.llm.completed`, `hz.usage.recorded`.

**Failure branches.**
- User denies ⇒ `hz.permission.answered{decision:'deny'}`; no lease; `hz.step.tool.completed{status:'denied'}`; the model sees a denial as a *user decision*, and the step count is not charged against the model's retry budget (openers: a denial must never be laundered into model output — the reference implementation tunnels declines as defects to keep them out of blanket error mapping, `file:///data/home/forge/repo-tour/opencode/packages/core/src/permission.ts#L256-L288`).
- Ask times out (default `deny`) or the front-end detaches ⇒ fail-closed deny, `hz.error.raised{class:policy, code:'ASK_EXPIRED'}`.
- Lease reused ⇒ the kernel refuses redemption (`oneUse`), `hz.effect.settled{terminal:'failed', observation{kind:'refused'}}`; a second attempt is a security event.
- Observation mismatch (post-image hash ≠ the hash of the bytes the lease authorised) ⇒ `terminal:'failed'` with the mismatch recorded; the receipt is the evidence, and the verifier will lower any claim that the write succeeded.
- Process dies between prepare and settle ⇒ flow 8.

### 6.4 Parallel tool batch

**Actors.** CTL, STEP, KRN, TOOL.

1. One step returns N tool calls. STEP admits them as one **batch**: N × `hz.step.tool.requested` sharing `batchGroup` and a single `stepId`, appended in one transaction (E-27).
2. The batch scheduler partitions by declaration: `read-only` + `concurrency:parallel` members run concurrently up to a ceiling; `workspace-write` members run with a **serial** class keyed on their resource set (two writes to different files may be parallel; two writes to the same file never are); `exclusive` members run alone.
3. Mutating members each traverse Guard ⇒ `hz.effect.decision.made`; asks are raised for all of them **before** any lease is issued, so the UI can show one approval sheet for the batch.
4. One user answer may cover several asks when every ask's `intentDigest` is covered by the answer scope; each covered effect still gets its own lease and its own receipt (a batch approval is not a batch authorization).
5. Members execute; each settles independently: `hz.effect.settled` per member, then `hz.step.tool.completed` per member.
6. Results are ordered by the request ordinal in the projection, not by completion time, so the model sees a stable order on replay.
7. The batch commits its results in one transaction; the next step compiles with all N results.

**Events.** per member: `hz.step.tool.requested`, `hz.effect.decision.made`?, `hz.permission.asked`?, `hz.effect.lease.issued`?, `hz.effect.settled`?, `hz.step.tool.completed`; batch-level: `hz.part.created` ×N, `hz.step.started` (next), `hz.usage.recorded`.

**Failure branches.**
- One member denied ⇒ that member is `status:'denied'`; the others proceed; the batch terminal for the step is recorded as partial and the model is told which member failed.
- One member `UNKNOWN` ⇒ the batch stops admitting new members of the same resource set (a write whose predecessor is unknown must not be applied on top of an unknown state). Later members are `cancelled` with `errorCode:'blocked_by_unknown'`.
- Two members write the same file ⇒ the second is refused at scheduling time (`errorCode:'resource_conflict'`), not discovered at write time.
- A member exceeds its output budget ⇒ truncated output plus `hz.error.raised{class:tool, severity:warn}`; the batch continues.
- Batch transaction fails ⇒ no member result is committed, no partial history exists; the batch is retried as a whole or surfaces as `hz.error.raised{class:storage}`.

### 6.5 Denial and user override

**Actors.** FE, KRN, CTL.

1. Model requests `shell{command:'rm -rf *'}`: `hz.step.tool.requested{capabilityId:'terminal.run', effectClass:'process'}`.
2. Guard evaluates the wildcard layer (`Shell(rm -rf *)`) and the Starlark prefix engine (structural argv, not string matching — ADR-007) ⇒ `hz.effect.decision.made{decision:'deny', reasonCode:'POLICY_DENY', ruleId}`. No `permission.asked` is emitted: a deny is not an ask, and asking would invite the user to override a rule that exists to be un-overridable in the moment.
3. `hz.step.tool.completed{status:'denied', errorCode:'POLICY_DENY'}`. The model sees the denial with the reason code and cannot retry it into success (Guard re-evaluates every request; a deny does not cache as an allow).
4. The user decides the *policy* is too strict for this workspace. Override happens as an explicit user action: FE emits `hz.policy.revision.changed{scope:'workspace', source:'user_action', changes:[{ruleId, effect:'allow'}], newRevision, digest}`. The effective posture is recomputed and `posture.digest` changes — which is a **prefix** change and therefore a cache epoch change (flow 24 notices this).
5. Optionally the user narrows instead: a `DirectSessionGrant` is created, bounded to one intent digest, one workspace, an expiry, and a use count. It pre-authorises *that exact request*, and the request still traverses Guard, lease and receipt.
6. The model retries with a different command: a fresh `hz.step.tool.requested` ⇒ Guard ⇒ allow (the new rule) or ask, never a silent pass because a grant exists.

**Events.** `hz.step.tool.requested`, `hz.effect.decision.made` (deny), `hz.step.tool.completed` (denied), `hz.policy.revision.changed`, and — for the grant path — `hz.effect.decision.made{decision:'allow', grantId}` + `hz.effect.lease.issued` + `hz.effect.settled`.

**Failure branches.**
- The workspace config attempts to widen (`source:'file'` + a change that is not a narrowing) ⇒ refused; merging is a lattice meet, and the attempt raises `hz.error.raised{class:policy, failClosed:true}` (ADR-008).
- A model-originated path attempts to emit a policy change ⇒ `EVENT_AUTHORITY_FORGED`, refused at append.
- A grant is presented with a different `intentDigest` ⇒ treated as absent; Guard re-decides from scratch.
- A managed policy (`source:'managed_push'`) forbids the override ⇒ the user action is recorded but the effective revision does not change; the session stays under `deny` and says so.

### 6.6 Steering or interrupt mid-turn

**Actors.** FE, CTL, STEP, PROV, KRN.

1. While the session is busy, the user types again. Admission happens immediately and durably: `hz.session.prompt.admitted{delivery:'steer'}`. Work does not stop to receive it.
2. **Steer delivery.** The in-flight step finishes its stream (or is cancelled at a cancellation point). At the next **safe step boundary** the steer is folded in: the user part is created (`hz.part.created{metadata.inboxId}`) and the *next* step's context includes it. A steer never truncates a partially streamed assistant part.
3. **Interrupt.** The user presses the interrupt key: FE issues `session.interrupt`. CTL cancels the provider stream; the cancelled step terminates honestly — `hz.step.llm.completed{finishReason:'cancelled'}` with the usage actually incurred (a cancelled stream still costs tokens and is still recorded; G-3).
4. Outstanding work at the boundary: requested-but-not-admitted effects are cancelled (`hz.step.tool.completed{status:'cancelled'}`); effects **already executing** are never force-killed mid-write. They run to a terminal and settle (`hz.effect.settled`), or, if the process cannot observe them, they become `UNKNOWN` (flow 8).
5. Claim handling: an interrupt by the user releases the claim (`hz.session.claim.released{reason:'interrupted'}`) and the session leaves busy (`hz.session.busy.left{outcome:'interrupted'}`). A shutdown interrupt **preserves** the claim so the next start resumes (see `file:///data/home/forge/repo-tour/opencode/packages/core/src/session/execution.ts#L73-L83`, whose comment is the design rule: recovery is a property of the database, never of a shutdown hook that may not run).
6. After the interrupt the session is idle-but-claimed-continuable: pending steer input is promoted and a new drain starts. Queued next-turn prompts stay parked.

**Events.** `hz.session.prompt.admitted`, `hz.part.created`, `hz.step.llm.completed{finishReason:cancelled}`, `hz.step.tool.completed{cancelled}`, `hz.usage.recorded`, `hz.session.claim.released`, `hz.session.busy.left`.

**Failure branches.**
- Interrupt arrives while a leased effect is executing ⇒ the interrupt is *reported* immediately but the effect still settles; the UI shows “stopping after current effect”, and the receipt is written even though the turn was cancelled.
- Interrupt arrives exactly as the run settles ⇒ idempotent: the second terminal is refused (`SESSION_CLAIM_ALREADY_RELEASED`) and the log keeps one terminal.
- Steer arrives after the last step completed ⇒ promoted as a new turn instead of a steer, with the same durable admission.
- Cancellation loses the stream transport ⇒ usage is recorded as `unknown` for the missing tail with an explicit `usageIncomplete: true` flag; cost accounting never invents numbers.

### 6.7 Queueing while busy

**Actors.** FE, CTL.

1. The user sends a second instruction with `delivery:'queue'` (or the front-end defaults to queue while the session is busy): `hz.session.prompt.admitted{delivery:'queue'}`. It is durable the instant it is typed.
2. The inbox projection shows the item as `pending`, ordered by `enqueued_seq` — so the user can see exactly what will run and in what order, and can cancel an item before it runs.
3. The current turn completes: `hz.session.busy.left`, `hz.session.claim.released`.
4. The drain promotes the head of the queue at a **turn boundary** (not a step boundary — that is the difference from steer): `hz.part.created` for the queued user message; the item becomes `delivered` in the projection.
5. A new claim is acquired for the next turn (`hz.session.claim.acquired`), and the loop continues at flow 6.3/6.2.
6. If a steer is admitted while a queue is pending, the steer is delivered first (it belongs to the current turn); the queue is untouched.
7. Cancellation before promotion: a control item cancels the queued entry; the projection marks it `cancelled` and the reason is admitted as a control item (never a silent deletion).

**Events.** `hz.session.prompt.admitted` (`queue`), `hz.part.created` (at promotion), `hz.session.busy.left`, `hz.session.claim.released`, `hz.session.claim.acquired`, `hz.session.busy.entered`.

**Failure branches.**
- Inbox bound exceeded (default 1 024 pending items per session; configurable) ⇒ the admission is **refused** with a clear error rather than silently dropping input.
- Duplicate submission (same `messageId`) ⇒ reconciling admission returns the existing item instead of enqueuing twice (the reference does exactly this: reconciliation before admit, `file:///data/home/forge/repo-tour/opencode/packages/core/src/session/session.ts#L155-L191`).
- Crash between promotion and part creation ⇒ the inbox row is `delivered` but no part exists; recovery re-opens the item to `pending` because the durable fact (the part) is missing. Trust the log, not the projection.
- The session is archived while items are queued ⇒ queued items are preserved with the archive and listed on resume; they are not executed while archived.

### 6.8 Crash mid-effect, recovery, reconciliation to `UNKNOWN`, then settlement

**Actors.** KRN, CTL, FE (the human who decides), reconciler.

1. A mutating effect is prepared durably (kernel journal) and leased; the tool begins execution (`hz.effect.lease.issued` is in the log; the kernel's own row is `RUNNING`).
2. The process is killed — SIGKILL, power loss, OOM, or supervisor eviction. No shutdown hook runs. Nothing is written after the kill.
3. Next start: `hzk` opens its durable state and reconciles every unresolved row **before** reporting ready: `PREPARED`/`RUNNING`/`DISPATCHING`/`RESERVED` rows and any in-flight wave become `UNKNOWN` (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs#L2507-L2527`; the status columns are constrained to include `UNKNOWN`, e.g. `file:///data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs#L1771`).
4. The session log receives `hz.effect.unknown` per unresolved effect with `reason:'no_terminal_at_restart'` and the evidence the kernel still holds (intent digest, lease id, last observation if any). This is a **loud** record: it is rendered as a banner and it blocks `session verify` from returning success.
5. The session claim is recovered: `hz.session.claim.acquired{resumed:true, resumeAttempt}`. If the crashed turn had already streamed a partial assistant part, that part is marked incomplete (`hz.part.updated{complete:false}`) and is **not** continued by the model — a new step supersedes it (an incomplete assistant projection is never resumed).
6. Reconciliation begins with observation, not with action: for each `UNKNOWN` effect the reconciler uses only read capabilities (`files.read`, `vcs.read`, `terminal.run` with a read-only argv allow-list) to establish the post-state. Nothing is re-executed during a read-only probe.
7. Verdicts: the observed post-state matches the intent ⇒ `hz.effect.reconciled{method:'observe', verdict:'settled_succeeded', evidenceDigest, receiptId}` (a *new* receipt, produced by observation). Observed absence or contradiction ⇒ `verdict:'settled_failed'`. Observation impossible (the file is gone, the remote is unreachable, the process identity is unknown) ⇒ `verdict:'residual_unknown'` and the effect stays `UNKNOWN`.
8. Only if a tool declares itself idempotent **and** the effect class permits it may the reconciler choose `method:'declared_idempotent_retry'` — never for `external-effect`, never for a process effect, never by default.
9. The run's verdict reflects this: with any `residual_unknown`, `hzcode session verify` returns `UNKNOWN` (exit code 3 in headless), with a list of exactly which effects are unresolved and what evidence would settle them.
10. A human may settle manually: `hzcode effect reconcile <effectId> --manual --evidence <receipt|path>` ⇒ `hz.effect.reconciled{method:'manual', actor:'user'}`. The manual path is recorded as human authority and is never inferred from model text.

**Events.** (before the kill) `hz.effect.lease.issued`; (after recovery) `hz.effect.unknown` ×N, `hz.session.claim.acquired{resumed:true}`, `hz.part.updated{complete:false}`, `hz.effect.reconciled`, `hz.session.busy.left`.

**Failure branches.**
- Reconciliation itself crashes mid-way ⇒ the effects it had already reconciled keep their verdicts; the rest stay `UNKNOWN`; reconciliation is idempotent and resumable because each verdict is its own record.
- The observation contradicts the model's summary ⇒ the evidence gate lowers the claim and the final answer is rewritten as a contradiction report, with the receipt that contradicts it attached.
- A second `UNKNOWN` for the same effect is impossible: the state is terminal for the attempt, and reconciliation is the only exit.
- The kernel cannot open its journal (corrupt head digest) ⇒ fail-closed: the workspace is read-only, `hz.error.raised{class:kernel, severity:fatal}`; the user is told that effects cannot be proven and must not be assumed.
- Nobody reconciled and the user runs another turn ⇒ the session may continue, but mutation capabilities whose resource set intersects a `residual_unknown` resource are refused (`errorCode:'blocked_by_unknown'`) until reconciliation clears them. This is the fail-closed default: *unknown is contagious to its resource set, not to the whole session.*

### 6.9 Compaction triggered

**Actors.** CTX, CTL, STEP, PROV.

1. Before each step, CTX computes the projected context size. When it crosses the single automatic trigger ratio (default 0.72 of the model's usable window, with an absolute floor/ceiling per model), compaction is queued as a **control item** on the inbox: `hz.session.prompt.admitted{kind:'compaction'}`.
2. The control item is a steer-class item: it is delivered at the next safe step boundary, never in the middle of a streamed step.
3. The compaction engine runs the configured strategy chain (default: structured digest of completed steps → verbatim tail of the last N turns → summary). Snapcompact (vision-frame compression) is opt-in per model because it costs an extra model call.
4. On success: `hz.session.compacted{throughSeq, keepFromSeq, strategy, stages[], summaryPartId, tokensBefore, tokensAfter, trigger:'ratio', epochStart}`. The message projector folds the compacted range; `session_message` keeps the originals and the projection exposes the summary plus the kept tail.
5. The instruction epoch advances: instruction entries are rebuilt from `epoch_start` so a stale instruction value cannot leak across the compaction boundary.
6. The next step compiles with the same **prefix** (compaction changes the tail only). The cache-guard verifies the prefix digest is unchanged; `hz.step.started.context.prefixDigest` is identical to the previous step's.
7. Usage for the compaction call is recorded as its own `hz.usage.recorded` with `attribution.stepId` absent and a `stages[]` entry naming `compaction`.

**Events.** `hz.session.prompt.admitted{kind:compaction}`, `hz.session.compacted`, `hz.part.created{partType:'summary'}`, `hz.usage.recorded`, `hz.step.started` (next).

**Failure branches.**
- Summarisation fails (provider error, refusal, timeout) ⇒ **no** `hz.session.compacted` is appended; the run degrades to `verbatim_tail` (drop the oldest turns whole, never half a turn); `hz.error.raised{class:provider}` records the failed strategy. Compaction is all-or-nothing because a half-compacted context is unreplayable.
- Two compactions in one turn without new completed steps ⇒ refuse the second and report `no_progress`; this prevents the classic compaction loop.
- Compaction would drop a part referenced by an open goal acceptance criterion or by an unresolved receipt ⇒ the range is extended to keep it; a compaction must not destroy evidence.
- A rewind later reaches back before the compaction ⇒ the compaction is a fact in the log, so the rewind rebases the projection: the compacted range is re-expanded from the retained originals (the log kept them; only the projection folded).

### 6.10 Checkpoint and rewind

**Actors.** FE, CTL, KRN, checkpoint engine.

1. A checkpoint is created at each turn boundary when enabled (bounded: 32 per session, 64 MiB per snapshot, 512 MiB per session, 2 048 paths — the bounds are design constants, mirroring the reference `file:///data/home/forge/repo-tour/horizoncode/kernel/src/checkpoint.rs#L36-L58`): `hz.session.checkpoint.created{turnIndex, atSeq, atMessageId, workspace{revision, dirty[], untracked[], artifactRef, bytes}, kind:'turn', retention:'keep_last_n'}`.
2. Capture is an **artifact effect**: it goes through Guard with `capabilityId:'artifact.write'`, and its snapshot bytes land in the content-addressed artifact store. A capture that cannot complete is not recorded as a checkpoint.
3. Later, the user asks to go back: `hzcode rewind --turn N`. The request is a user action; rewind is never model-initiated, and the append of `hz.session.rewound` is refused for any other origin kind.
4. Guard decides `files.write` scope for the workspace restore (if `scope` includes `workspace`) and for the projection move.
5. The rewind is appended: `hz.session.rewound{toTurn, toSeq, toMessageId, checkpointId, scope, reason:'user', priorHeadSeq}`.
6. Projection effect: parts and messages after `toSeq` are removed from the *projection*; inbox items with `enqueued_seq > toSeq` are cancelled; instruction state is rewound to its state at `toSeq`; blob refs after `toSeq` are released (bodies stay while any other ref or a pin holds them). The **log keeps everything**; the head never decreases (E-9).
7. Workspace effect (when `scope` includes `workspace`): a restore effect with its own lease and receipt reverts the working tree to the checkpoint's `workspace.revision`; a partial restore is `UNKNOWN` and blocks further mutation of the affected paths (flow 8.9).
8. The next prompt starts from the rewound state; the model sees history ending at the rewound turn, and a synthetic part explains that a rewind occurred (so the agent is not confused by a discontinuity it cannot see).

**Events.** `hz.session.checkpoint.created`, `hz.effect.decision.made`/`hz.effect.lease.issued`/`hz.effect.settled` (capture; and restore when the scope includes the workspace), `hz.session.rewound`.

**Failure branches.**
- Workspace is dirty in paths that the checkpoint did not capture ⇒ refuse the workspace scope (`errorCode:'dirty_conflict'`) unless `--force`; `--force` is recorded in the payload and in the receipt. Refusing is the default because silently discarding uncommitted work is the worst outcome.
- Untracked files appeared since the checkpoint ⇒ same refusal class (`untracked_conflict`).
- The checkpoint's artifact was garbage-collected ⇒ impossible by construction: pinned checkpoints are excluded from eviction; if the artifact is nevertheless missing, the rewind proceeds for the projection scope and refuses the workspace scope (`LOG_BLOB_MISSING`).
- The rewind target predates a fork boundary the session was forked from ⇒ allowed; the fork boundary is a property of the child session, and the child's log still holds the copied records.
- A rewind is requested while the session is busy ⇒ queued as a control item and applied at a safe step boundary (never mid-step).

### 6.11 Session fork

**Actors.** FE, CTL, fork engine.

1. `hzcode session fork --at <messageId|turn>` (or the equivalent command from any front-end): `hz.session.forked{parentSessionId, sessionId(new), boundary{messageId, type:'before'|'after'}, copiedThroughSeq, postureChildDigest, costReset:true}`.
2. The fork projector copies **settled history only**: rows whose assistant/shell/compaction state is complete (mirroring the reference predicate, `file:///data/home/forge/repo-tour/opencode/packages/core/src/session/projector.ts#L206-L215`). A half-streamed assistant message never enters a fork.
3. Message and part ids are remapped deterministically from the fork event id (`<eventId>_<seq>`), and the mapping digest is recorded so an import can verify the same mapping.
4. Media referenced by the copied history is externalised into the child's own refs; the child's rows reference the **same blob hashes** (dedup), and the parent's rows are never rewritten.
5. Instruction entries and instruction state are copied at the boundary; the child starts with fresh cost counters (`costReset`) but keeps provenance: `hz.agent.spawned`-style accounting does not apply here — a fork is a sibling session, not a delegated child, and that distinction is preserved in the session tree.
6. The child's posture is a narrowing lattice meet of the parent posture and the current user config: a fork can never be *wider* than its parent.
7. The child's aggregate starts at `seq 0` with its own chain; the parent's log is untouched. Both sessions are replayable independently, and `hzcode session replay --tree` shows the branch point.

**Events.** `hz.session.forked` *is* the child aggregate's creation fact; the projector synthesizes the child's session row from it. The child never emits a second `hz.session.created` (inventing or duplicating one would violate E-2's “one fact, one record”). Every field a `created` record would carry is present on the fork record: identity, lineage (`forkOf`), posture, model ref and boundary.

**Failure branches.**
- Boundary message not found, or it is not settled ⇒ fail-closed: nothing is created (`errorCode:'fork_boundary_invalid'`).
- The parent is busy: the fork proceeds up to the last settled message; the boundary is snapped backwards and the payload records `snapped: true` so the user knows why their fork point moved.
- Blob store full ⇒ the fork refuses rather than creating a child with missing media (`errorCode:'storage_quota'`).
- Two forks of the same boundary in one session tree ⇒ allowed, and the session list distinguishes them by title suffix (`(fork #n)`), matching the ergonomics of the reference.
- A fork of a session whose log has a truncated prefix ⇒ allowed, but the child starts at the retention floor and is told so; restoring the missing history requires an exported archive (§4.7 and §6.7 of `12-sessions-state.md`).

### 6.12 Subagent spawn, await, failure

**Actors.** CTL, AG, KRN, STEP, FE.

1. The model calls `task` (or `read_only_task`): `hz.step.tool.requested{toolName:'task', capabilityId:'agent.spawn'}`.
2. The **one spawn primitive** validates and applies, in this order: depth limit, children-per-parent ceiling, global concurrency ceiling, capability narrowing (child caps ⊆ parent caps), budget derivation (child budget ⊆ remaining parent budget), context capsule construction, and correlation inheritance. Any failed check refuses the spawn; it does not “try anyway”.
3. `hz.agent.spawned{agentId, childSessionId, parentStepId, spawnKind:'task', profileId, grant{caps[], budget{}, depth, maxChildren, postureDigest}, capsuleDigest}` — a child is always traceable to a parent receipt and a budget (ADR-016, `file:///data/home/forge/hzcode/docs/02-decisions.md#L243-L249`).
4. The child session runs its own flows (6.1–6.11) under its narrowed posture. Its events carry the same `correlationId`, so a trajectory assembles across the tree.
5. The parent does not burn steps while waiting: the `task` tool result is pending, the parent step is open, and the parent's claim is held. A `wait`/`yield` on a long child is *not* a busy-loop — the parent's step is suspended, and progress is driven by the child's completion signal.
6. Child terminal: `hz.agent.completed{agentId, status, resultDigest, usage, receiptsDigest}`; then the parent's tool result lands: `hz.step.tool.completed{status:'succeeded', outputDigest}` and `hz.part.created{tool}` carrying the capsule summary (bounded size; the child's full transcript is a ref, not inlined).
7. The next parent step compiles with the summary. The parent's budget is debited by the child's recorded usage.

**Events.** `hz.step.tool.requested`, `hz.agent.spawned`, `hz.session.created` (child), child step events, `hz.agent.completed`, `hz.step.tool.completed`, `hz.part.created`, `hz.usage.recorded` (child scope and parent scope).

**Failure branches.**
- Depth/ceiling exceeded ⇒ refuse the spawn with a typed reason; the tool returns a failure the model can act on (spawn fewer children), and no child session is created.
- Child exhausts its budget ⇒ child terminal `status:'budget_exhausted'`; the parent is told, keeps its own budget, and decides whether to continue. A child can never borrow from its siblings.
- Child crashes ⇒ its claim is recovered (flow 8); the child's unresolved effects are `UNKNOWN`; the parent's wait returns `status:'unknown'` (never `succeeded`), and the parent may not treat an unknown child as done.
- Child attempts to widen its posture (e.g. requests a capability it was not granted) ⇒ Guard denies against the child's posture; there is no upward escalation path, only a fresh ask to the human — which in unattended mode resolves to deny (F-5).
- Spawn primitive called from a second call site ⇒ the boundary test fails at build (`packages/horizoncode-testing`, `SUBAGENT_SPAWN_BOUNDARY`). This is the point of ADR-016.
- Parent cancelled while a child runs ⇒ the parent releases its claim only after recording the child's disposition; children are either awaited-to-terminal, or cancelled with `hz.agent.completed{status:'cancelled'}` — never silently orphaned.

### 6.13 Fleet with dependency graph

**Actors.** CTL, AG, KRN, FE.

1. The model calls `fleet` with a task list and `dependsOn` edges: `hz.step.tool.requested{capabilityId:'agent.spawn'}`.
2. Admission validates the graph: a cycle refuses the whole fleet (`errorCode:'fleet_cycle'`); out-of-range depth/width refuses; the graph is recorded in the projection as `hz.todo.updated` nodes carrying `dependsOn`.
3. A shared budget pool is reserved for the fleet (tokens, wall-clock, steps, cost) and each node gets a **reservation** from the pool; a node may not exceed its reservation, and unused reservation returns to the pool at node settlement.
4. Ready nodes (no unmet `dependsOn`) spawn through the one primitive: `hz.agent.spawned{spawnKind:'fleet_member'}` with the fleet/node identity in the grant, up to the concurrency ceiling.
5. As each node settles: `hz.agent.completed`, its dependents become ready (DAG state advances in `hz.todo.updated`), and the scheduler launches the next wave.
6. Node failures: a failed node marks its dependents `blocked` (fail-closed) rather than skipping them; independent branches continue and the fleet reports a partial result.
7. Fleet terminal: the aggregate settles into `hz.agent.completed` for the parent with per-node statuses, `receiptsDigest` and consolidated usage. A fleet with any `UNKNOWN` descendant terminal is itself `status:'unknown'`.

**Events.** `hz.step.tool.requested`, `hz.todo.updated` (graph), `hz.agent.spawned` ×N, child step events, `hz.agent.completed` ×N, `hz.usage.recorded` (per node + fleet + root), `hz.step.tool.completed` (parent).

**Failure branches.**
- Cycle, self-edge, or unknown node reference ⇒ refuse before any spawn; nothing runs.
- A node crashes ⇒ its descendants are `blocked`; the node's claim is recovered (flow 6.8) and its `UNKNOWN` effects are listed in the fleet summary.
- The pool is exhausted ⇒ no new node launches; running nodes complete; the fleet returns `status:'budget_exhausted'` with the graph state so a human can resume it after granting more budget.
- Concurrency ceiling reached and no node can progress (all blocked on a failed node) ⇒ the fleet terminal is `failed`, not hung: the scheduler proves quiescence instead of waiting forever.
- Two nodes request the same exclusive resource ⇒ serialized by the resource-set rule (flow 6.4 step 2), never both at once.

### 6.14 Team multi-agent with message bus

**Actors.** CTL, AG, message bus, FE.

1. `team_create` names the team, its member agent profiles, and a shared budget policy. Each member is spawned by the one primitive: `hz.agent.spawned{spawnKind:'team_member'}`; the team itself is a projection record.
2. Members run concurrently, each in its own session with its own narrowed posture. They coordinate **only** through the durable message bus — never through shared in-process state.
3. A member sends: `hz.agent.message.sent{messageId, fromAgentId, toAgentId, kind, payloadDigest, bodyRef, delivery}`. Large bodies are externalised to the blob store; the record keeps the digest.
4. Delivery follows the same admission rules as human input: durable before any work; `steer` if the receiver is busy and the message is a control message, `queue` otherwise.
5. A message that carries a *request* is never authority: no message may widen a posture, grant a capability, or answer an approval. Authorization is only ever `hz.permission.answered` from a user.
6. `wait`/`yield` suspends the caller until its mailbox has an item, a timer fires, or a team-level terminal is reached. Waiting is a durable suspension driven by a mailbox signal, not a poll loop.
7. Team terminal (`team_delete` or a completed objective) settles every member: each gets a terminal record, aggregate usage is recorded, and the member sessions remain replayable.

**Events.** `hz.agent.spawned` ×N, `hz.agent.message.sent` ×N, `hz.part.created` (received messages become parts in the receiver's transcript), `hz.agent.completed` ×N, `hz.usage.recorded`.

**Failure branches.**
- Mailbox bound exceeded (per member, bounded) ⇒ the send is refused with backpressure (`errorCode:'mailbox_full'`); the sender is told rather than the message being silently dropped.
- Message sent to a member whose session was deleted ⇒ refused at send; the sender is told the member is gone.
- Deadlock: every member waiting, no mailbox non-empty, no timer armed, no external input possible ⇒ the team detects quiescence-with-no-progress and terminates as `status:'deadlock'` with the wait graph attached. Hanging is not an acceptable outcome.
- Two members write the same file concurrently ⇒ serialized by resource set (flow 6.4 step 2); the conflict is reported to both, with the receipt that proves which write landed first.
- A member attempts to bypass the bus (raw socket, plugin host, direct database access) ⇒ there is no path: the plugin host has no session-log access and no EffectHost handle (E-17, flow 6.17).

### 6.15 Plan mode: approval, then execution

**Actors.** FE, CTL, CTX, PROV, KRN.

1. The user (or a slash command) enters plan mode: `plan_enter` makes the session read-only for mutations and selects the planner role under the `plan-for-approval` routing policy. Routing is host policy, not a classifier guess.
2. The planner works on a **separate compiled context** (planner prefix); planner and executor prefixes are never mixed, so neither pollutes the other's cache.
3. The planner records the plan: `hz.plan.updated{status:'draft'}` then `{status:'awaiting_approval', planDigest}` with its steps.
4. The plan is presented through an ask: `hz.permission.asked{question:'Approve this plan?', previewRef, intentDigest}`. The payload binds `planDigest`, so an approval cannot be replayed against a *different* plan.
5. The user approves: `hz.permission.answered{decision:'allow_scoped', scope:{planDigest, maxSteps, expiresAt}}` ⇒ `hz.plan.updated{status:'approved', approvedBy, window}`.
6. Execution begins with `plan_exit`: posture returns to the execution posture (still bounded by user config), the executor role is selected, and the executor prefix is compiled fresh.
7. Each mutating plan step goes through the ordinary flows (6.3, 6.4). The approval covers the *plan*, not the individual effects: an effect the plan did not describe (a new path, a new command, a wider scope) triggers a fresh ask.
8. Progress is recorded per step: `hz.plan.updated{status:'executing', steps[]}`; completion closes the window.

**Events.** `hz.plan.updated` ×N, `hz.permission.asked`, `hz.permission.answered`, plus the ordinary step/effect events of execution.

**Failure branches.**
- Plan denied ⇒ no execution window; the session stays read-only; the plan is retained as an artifact for editing.
- Window expires (steps/tokens/time) mid-plan ⇒ execution stops at the next boundary; further work requires a new approval; effects already settled are untouched and receipted.
- The workspace changed after approval in a way the plan touches ⇒ the plan is marked stale and the affected steps re-enter approval instead of executing against a changed world.
- The executor wants a capability the plan did not declare ⇒ fresh ask; the plan window never implicitly authorises it.
- An unattended caller (schedule, CI) asks a plan-mode session to execute ⇒ the ask resolves to deny (F-5); unattended plan execution requires a window a human created.

### 6.16 MCP tool discovery and invocation

**Actors.** CTL, MCP, PROV, KRN, TOOL.

1. A configured MCP server is connected (stdio or HTTP, OAuth where required) **only** if it is trusted for this workspace (ADR-008): a repository cannot name a server and have it run.
2. Discovery is deferred: the server's full tool list is not injected into the prompt. The prompt carries a stable catalogue version plus a `tool_search` affordance.
3. A search returns candidates; their schemas are injected into the **tail**, never the prefix, so discovery cannot drift the cache prefix (flow 6.24).
4. Invocation: `hz.step.tool.requested{toolName:'mcp.<server>.<tool>', capabilityId:'mcp.invoke', effectClass:'external-effect', declarationDigest}`.
5. Guard decides under the posture (external effects default to ask), then a lease is minted scoped to server + operation + input digest. Arguments pass through; the *result* is untrusted data.
6. Results are truncated per budget, stored as artifacts when large, and rendered as data. Untrusted output is never executed in process (the out-of-process rendering rule).
7. `hz.effect.settled` records the response digest as the observation; `hz.step.tool.completed` carries the receipt. `hz.usage.recorded` charges the call.

**Events.** `hz.step.tool.requested`, `hz.effect.decision.made`, `hz.permission.asked`/`answered` when the posture asks, `hz.effect.lease.issued`, `hz.effect.settled`, `hz.step.tool.completed`, `hz.error.raised` on transport failure.

**Failure branches.**
- The tool schema changed since discovery (`declarationDigest` mismatch) ⇒ fail-closed: refuse the call and require re-discovery; a stale schema is never used to encode arguments.
- Server crash or hang mid-call ⇒ `hz.effect.unknown` (external effect, observation lost). Reconciliation probes with a read-only listing call only if the server declares the operation idempotent; otherwise the effect stays `UNKNOWN`.
- OAuth expired ⇒ the call fails into a re-auth ask; there is no silent fallback to an unauthenticated path.
- A hostile server returns instructions inside tool output ⇒ the content is data, never a directive: no tool result can cause a posture change, a policy change, or an approval answer (the append is refused on origin grounds).
- A search returns hundreds of tools ⇒ bounded result set and bounded tail injection; exceeding the tail budget is an explicit refusal, never a silent truncation of the tool set.

### 6.17 Plugin loading and a plugin tool call

**Actors.** PLG, CTL, KRN, TOOL, FE.

1. A plugin is discovered (bundled, user-installed, marketplace-installed, or named by workspace config).
2. Manifest validation: schema version, declared capabilities, host API range, signature (when signed), digest. A signature that does not verify, or a declared capability the host API cannot express, refuses the load. A workspace-named plugin stays **off until trusted for that folder** (ADR-008).
3. Load into the sandboxed plugin host: a separate process with only the declared capability surface. The plugin receives no session-log handle, no EffectHost handle and no credential store.
4. Contribution registration uses the same `ToolDeclarationV1` shape as built-ins. A contributed tool without a declaration (schema, capability ID, effect class, renderers, concurrency class) is refused at registration — it cannot be discovered, so it cannot be called.
5. A plugin tool call is an ordinary tool call: `hz.step.tool.requested{capabilityId:'plugins.invoke'}` ⇒ Guard ⇒ lease ⇒ plugin-host invocation ⇒ observation ⇒ `hz.effect.settled` ⇒ `hz.step.tool.completed`. The plugin never receives a lease; it receives an *invocation* whose authority the kernel holds.
6. Workspace effects requested by a plugin are performed by the host on the plugin's behalf, so the receipt is written by the kernel and never by the plugin.

**Events.** `hz.step.tool.requested`, `hz.effect.decision.made`, `hz.effect.lease.issued`, `hz.effect.settled`, `hz.step.tool.completed`; a failed load raises `hz.error.raised{class:'plugin'}` (gap G-5).

**Failure branches.**
- Bad signature or unknown capability ⇒ refuse to load; the plugin is listed as `rejected` with the reason.
- Plugin crashes or hangs with a call in flight ⇒ the call settles `FAILED`, or `UNKNOWN` if the host cannot observe it; the plugin host restarts in isolation and the session is unaffected. A plugin can never take the agent down.
- Plugin tries to write the log, mint a lease, or grant itself a capability ⇒ refused; the attempt raises a security event. There is no API to reach either.
- Plugin declares a capability wider than the workspace trust allows ⇒ the load is narrowed to the allowed subset or refused; it never runs with an implicit widening.
- A plugin update changes its capabilities ⇒ re-trust is required for the new digest; a silent capability gain on update is impossible by construction.

### 6.18 Skill invocation, including `runAs: subagent`

**Actors.** SKL, CTL, AG, FE, KRN.

1. Skills are indexed by name, description and digest. The index lives in the **tail**, so adding a skill cannot drift the prefix (flow 6.24). A digest mismatch against a lock file refuses the invocation.
2. Invocation via the `skill` tool or a slash command: `hz.skill.invoked{skillId, name, version, digest, runAs, argsDigest, invokedBy}`.
3. **Inline mode** (`runAs: inline`): the skill body is injected as a system-role part for the current session (`hz.part.created`), and the run proceeds under the current posture. Nothing widens — a skill is text, not authority.
4. **Subagent mode** (`runAs: subagent`): the invocation spawns through the one primitive: `hz.agent.spawned{spawnKind:'skill', grant{caps ⊆ parent caps and ⊆ the skill's declared allow-list, budget ⊆ remaining budget}}`. The skill's front matter may only narrow.
5. The subagent runs its own session, returns a bounded result, and terminates: `hz.agent.completed{status}`, then the parent's `hz.step.tool.completed` and `hz.part.created`.
6. Execution is recorded so the skill can be evaluated later: the trajectory carries `hz.skill.invoked` and the child's `hz.agent.completed` — exactly the input the self-improvement loop (flow 6.22) needs.
7. Installation and updates are their own fact: `hz.skill.installed{status:installed|updated|removed|pinned|rejected, digest, signature}`.

**Events.** `hz.skill.invoked`, `hz.part.created`, `hz.agent.spawned` (subagent mode), `hz.agent.completed`, `hz.step.tool.completed`, `hz.skill.installed` (when installing).

**Failure branches.**
- Unknown or digest-mismatched skill ⇒ refuse; never run a skill whose bytes are not the ones the lock expects.
- A skill that needs a capability the parent does not have ⇒ refuse in subagent mode (no widening); in inline mode the model may request that capability, and the request is authorised on its own merits or denied.
- A synthesised skill is unavailable for invocation until it has passed an eval and been accepted: the gate is a status on `hz.skill.installed`, not an honour system.
- A skill that instructs the agent to change policy or posture ⇒ the instruction is text; the action it describes is still Guard-decided. Prompt-level instructions are never a bypass.

### 6.19 Scheduled or background run

**Actors.** SCH, CTL, KRN, FE, LRN.

1. A schedule is created (by a human, or by a model request that a human approves): recurrence, target session or template, prompt, posture, budget, and an optional bounded pre-authorisation. All of it is recorded before the schedule can fire.
2. Each **occurrence** is durably journaled before dispatch (occurrence identity, due time, target, attempt state), so a restart neither double-fires nor silently drops a tick. The pattern is the reference's occurrence journal, `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/scheduler/occurrence_journal.rs`.
3. On fire, the prompt enters the target session's inbox (`hz.session.prompt.admitted`) — the same admission path as human input, before any work.
4. Unattended semantics: the posture is the schedule's posture, and every `ask` resolves to **deny** unless the occurrence's exact `intentDigest` is covered by a pre-authorisation (F-5). There is nobody to ask.
5. The run executes headless through the same Controller; output is captured as artifacts and summarized into a notification.
6. Trajectory capture (flow 6.22) runs on the trajectory, tagged as scheduled so evals can separate unattended from interactive behaviour.
7. Terminal: the verdict is stored with the occurrence record; a `residual_unknown` effect marks the occurrence `needs_attention` and notifies, rather than being reported as success.

**Events.** `hz.session.prompt.admitted`, the ordinary run events, `hz.learn.trajectory.recorded`, `hz.error.raised` on failure. Occurrence journal rows are kernel-owned (gap G-4).

**Failure branches.**
- The host was down at the due time ⇒ the journal reconciliation applies the misfire policy (default `skip`, recorded); `catch_up_once` is available and explicit.
- The target session is busy at fire time ⇒ the prompt queues (flow 6.7).
- An ask-required effect in unattended mode ⇒ deny, recorded with the reason code and surfaced in the notification so a human can fix the policy or grant a bounded pre-authorisation.
- Clock manipulation: recurrence uses wall-clock time (so “9am” means 9am), durations use a monotonic clock, and a backwards wall-clock jump suspends firing with an explicit warning instead of firing repeatedly.
- Budget exhausted mid-run ⇒ the run stops at a step boundary; the occurrence is recorded `budget_exhausted` with the work completed so far, receipted.
- The scheduled session was deleted ⇒ the occurrence fails with `errorCode:'target_missing'`; the schedule is paused rather than retried in a loop.

### 6.20 IDE bridge: attach and replay after a leader crash

**Actors.** FE (IDE client), bridge, CTL, KRN.

1. The IDE client connects to the bridge with a JWT-scoped device identity. The scope limits it to the sessions and capabilities the token names: a read scope cannot approve, an approval scope can.
2. Attach: the client sends its last known cursor (or `0`). The bridge subscribes on the client's behalf, emits a `ReplayComplete{throughSeq}` watermark after replaying, then streams live events.
3. The client renders the session from replayed events only. The bridge is a projection source; the client holds no hidden state that the log does not have.
4. **Leader crash.** The controller process dies. The client keeps its cursor and its subscription intent; it does not clear the session view and does not report “unknown session”.
5. A new leader starts, runs recovery (flow 6.8), acquires the session lease (`hz.session.claim.acquired{resumed:true}`), and re-registers the session.
6. The bridge reconnects and **replays the cached client state**: the original initialize/session-attach handshake is replayed, responses to the replayed requests are swallowed, and the missed events are delivered from the cursor. The client sees a `leaderReconnected` notification and a continuous transcript — the technique is the reference's `replay_acp_state_after_reconnect`, `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs#L1117`.
7. If the crashed leader held a claim, the new leader does **not** assume the turn finished: it reconciles effects (flow 6.8) and tells the client what is `UNKNOWN` before streaming anything new.

**Events.** Attach and replay are protocol frames, not log records (E-11). Recovered work produces `hz.session.claim.acquired{resumed:true}`, `hz.effect.unknown` and `hz.effect.reconciled`.

**Failure branches.**
- The session was deleted while the client was away ⇒ attach fails with an explicit `session_deleted` error; the client renders the deletion, not an empty session.
- The client's cursor exceeds the log head (it saw a record from a log that was later replaced) ⇒ fail-closed: resync from the retention floor (`LOG_TRUNCATED`), never a silently fabricated gap.
- The client's binary does not know an event type it receives (newer leader) ⇒ it renders an opaque placeholder and continues; it never drops the stream and never fabricates meaning (`DEGRADED_READ`).
- Two live leaders ⇒ the second cannot acquire the lease and attaches read-only (`SESSION_LEASE_HELD`). A split-brain writer must be impossible, so the lease is checked on *every* write, not only at startup (E-19).
- Token expired mid-session ⇒ the bridge downgrades to read-only and asks for re-auth; it never continues with an expired identity.

### 6.21 Headless CI run with JSONL output

**Actors.** FE (CI process), CTL, KRN, verdict assembly.

1. `hzcode run --output-format jsonl --verify <task>` starts with no TUI. It is the same Controller with a different front-end: no headless-only code path may exist (parity ratchet, ADR-005).
2. Posture comes from CI configuration: typically `workspace-write` with approvals disabled, so every `ask` resolves to deny unless the config carries a bounded pre-authorisation for exactly the operations the job needs.
3. The event stream is projected to JSONL: one JSON object per line carrying `seq`, `ts`, `type`, `sessionId` and `data`, written with line-atomic flushes so a killed process never emits a half line. `hz.step.llm.delta` frames are included for streaming consumers and suppressed with `--no-deltas`.
4. The final line is the verdict object: `verdict`, `exitCode`, `sessionId`, `headSeq`, `receipts[]`, `unknownEffects[]`, `budget` — produced by the evidence gate, not by the model's prose.
5. Exit codes, per the canonical table owned by `docs/14-surfaces.md` S16: `0` verified success, `1` error, `2` usage/config/environment error, `3` an outcome that cannot be proven or guaranteed (kernel absent or mismatched, an `ask` with no answerer, a residual `UNKNOWN`), `4` policy denial, `5` budget exhaustion, `130` SIGINT, `143` SIGTERM. `--require-verify` makes `0` unreachable unless the evidence gate passed; `--allow-unknown` downgrades only the `UNKNOWN` case of `3` and never a denial.
6. Receipts are exported alongside the JSONL (`--receipts receipts.json`) so a reviewer can check the work without trusting the transcript.

**Events.** The ordinary run events, plus `hz.error.raised` for CI-relevant failures. No CI-specific event exists: a CI run is a run.

**Failure branches.**
- The consumer disappears (EPIPE) ⇒ `--on-client-gone=stop` (default) stops the run at the next boundary after settling outstanding effects; `continue` is available for fire-and-forget pipelines and says so in the verdict.
- Disk full or log unwritable ⇒ the run stops immediately (`STOPPED_LOG_UNWRITABLE`); it never continues work whose effects cannot be recorded. Exit 3.
- An ask is raised with no TTY to answer it ⇒ fail-closed refusal; the JSONL records the ask and the refusal; exit `3` (not `4`: policy did not deny, no one could answer).
- Budget exceeded ⇒ stop at a boundary; exit `5`, or `3` if effects are also unknown.
- The job is cancelled by the CI runner (SIGTERM) ⇒ graceful: settle what can be settled, leave the rest to recovery, and write the verdict line with `interrupted: true`.

### 6.22 Self-improvement: trajectory capture → eval → proposal

**Actors.** LRN, evals, human reviewer, CTL.

1. Post-run, the trajectory is assembled: every durable event carrying the run's `correlationId`, across the session tree, plus the referenced receipts and effect terminals. `hz.learn.trajectory.recorded` binds the range, the digests and the storage reference.
2. Redaction runs **before** storage: secrets, credentials and configured sensitive paths are removed or replaced. A redaction failure quarantines the trajectory (encrypted at rest, or not stored, with the finding recorded) — fail-closed, because a leaked trajectory is worse than a missing one.
3. An eval replays the trajectory hermetically: recorded provider responses, a sandboxed workspace copy, the same tool results. Scoring is deterministic, and the suite version, baseline and delta are recorded in `hz.learn.eval.completed`.
4. A regression against the baseline is an automatic rejection: the ratchet forbids accepting a change that lowers a gated score.
5. Candidates (memory facts, skill bundles, prompt variants, routing heuristics, doc patches) are recorded as `hz.learn.proposal.created` with a diff reference, the evidence trajectory ids, the eval id, the expected effect and a risk class.
6. `authorityImpact` MUST be `none` or `narrowing_only`. A proposal that would add or widen a capability, edit policy, or touch the kernel is **refused at creation** (ADR-010, `file:///data/home/forge/hzcode/docs/02-decisions.md#L183-L189`). This is the hard line, enforced by the record shape rather than by review diligence.
7. A human reviews. Accept applies the change with its own receipt and a revert path; reject records `status:'rejected'` with a reason, which is itself signal for the next proposal.
8. Memory distillation is the same loop with a narrower change type: episodic observations are promoted to semantic facts only with provenance and review (`hz.memory.retained{reviewed:true}`).

**Events.** `hz.learn.trajectory.recorded`, `hz.learn.eval.completed`, `hz.learn.proposal.created`, `hz.memory.retained`, `hz.skill.installed` (when a synthesised skill is accepted), and `hz.policy.revision.changed` — **only** if a human accepts a narrowing policy proposal.

**Failure branches.**
- Redaction finds a secret ⇒ quarantine; the proposal pipeline is blocked for that trajectory and the finding is surfaced.
- The eval suite is flaky (non-deterministic replay) ⇒ the eval is rejected as invalid rather than scored; flakiness is measured and gated.
- A proposal widens authority ⇒ refused at creation, with the refusal recorded; repeated attempts raise a security event.
- The workspace is untrusted ⇒ the whole loop is off by default (ADR-010).
- A trajectory is too large ⇒ bounded storage: the middle of the range is dropped with an explicit `truncated` marker plus a digest of the omitted range. A trajectory is never silently partial.

### 6.23 Model fallback on provider error

**Actors.** PROV, CTX, CTL, KRN, FE.

1. A step's stream fails and `hz.error.raised{class:'provider'}` records a stable code mapped from the provider error: 429, 5xx, timeout, TLS, malformed stream, auth, quota, refusal.
2. A partially streamed step is never silently resumed: the step terminates honestly (`hz.step.llm.completed{finishReason:'incomplete'}`) and the discarded attempt's usage is recorded (gap G-3). Because there is one `llm.stream` per step (ADR-011), a retry is a **new step** carrying `retryOfStepId`, not a resumption inside one step.
3. Retry ladder: bounded attempts with jittered backoff for `transient` codes only. A non-transient code (auth, quota, content refusal) is terminal for that attempt and is not retried.
4. Fallback: the routing policy names a chain (same family, different endpoint/region/model). The decision is host policy, not a guess, and it may not cross from a planner role to an executor role, nor from a read-only posture to a mutating one.
5. Cache handling: a model or provider change changes the cache identity, so the step records the new `cacheNamespace` and a `cacheEpoch` bump, and the prefix is re-primed. The cost is explicit in `hz.usage.recorded` with `cacheHit: {read: 0, write: …}`, never hidden.
6. Credential affinity: within a provider the same credential is preferred so the cache namespace is preserved — a different key is a different cache — which is why credential selection is part of the fallback decision rather than an incidental choice.
7. On success the run continues. If every fallback is exhausted, the step fails terminally: the verdict is `INCOMPLETE`, outstanding effects are settled or reconciled, and the diagnosis names every provider attempted.

**Events.** `hz.error.raised`, `hz.step.llm.completed{finishReason:'incomplete'}`, `hz.step.started{retryOfStepId}`, `hz.step.llm.requested` (new `cacheNamespace`), `hz.usage.recorded` per attempt, `hz.session.busy.left{outcome:'failed'}` on exhaustion.

**Failure branches.**
- The provider returns a policy refusal ⇒ **not** a fallback trigger: a refusal is an answer, and routing around a safety refusal is not a reliability feature.
- Every provider fails ⇒ verdict `INCOMPLETE`; any effect whose lease was issued during the failed step is settled or marked `UNKNOWN` before the run reports.
- The fallback has a different context window ⇒ compaction can trigger spuriously; the compiler clamps to the intersection of the chain's windows so a fallback never overflows mid-stream.
- Fallback would violate a posture (a local-only policy forbids a cloud provider) ⇒ the step fails; policy wins over availability.
- The fallback model does not support a tool or feature the step needs ⇒ capabilities are intersected before the attempt; unsupported tools are dropped with a notice, or the fallback is skipped.

### 6.24 Cache-guard failure and remediation

**Actors.** CTX, cache-guard (CI gate and runtime check), CTL, FE.

1. At each step CTX computes a **prefix digest** over exactly the prefix sections: system prompt, sorted tool schemas, declared configuration, posture digest, and the model/provider identity. Volatile facts live in the tail, so they cannot change this digest by construction.
2. The digest is compared with the pinned expectation for the tuple `(provider, model, config revision, tool catalog version, posture digest)`.
3. **Match** ⇒ the step proceeds; `hz.step.started.context.prefixDigest` equals the previous step's for the same tuple, and cache hits are visible in `hz.step.llm.completed.usage.cacheRead`.
4. **Mismatch at runtime** ⇒ `hz.error.raised{class:'cache', code:'CACHE_PREFIX_DRIFT', severity:'warn', failClosed:false}`, or `fatal` and fail-closed under `--strict-cache`, which CI uses. The drift is recorded with the per-section digest table so the diff is attributable to a section rather than to “the prompt”.
5. **Mismatch in CI** ⇒ the build fails. The cache-guard is a gate, not a suggestion (ADR-009, `file:///data/home/forge/hzcode/docs/02-decisions.md#L173-L179`).
6. Attribution names the offending contributor: a reordered tool list, a timestamp that leaked into the prefix, unstable JSON key order, a posture change (from flow 6.5 or 6.15), or a deliberate tool catalog version bump.
7. Remediation is one of exactly three moves: (a) move the volatile content to the tail; (b) version the section so the change is intentional, and update the pin with a recorded reason; (c) fix the instability — sort the list, canonicalise the JSON. Editing the pinned digest with no recorded reason is not a remediation.
8. Two adjacent cases are **not** drift and are not failures: a **cache namespace change** (different credential or provider, flow 6.23) and a **legitimate epoch change** (a posture change the user explicitly made). Both are recorded with a reason and reset the expectation instead of failing it.

**Events.** `hz.error.raised` (drift), `hz.step.started` (with the observed `prefixDigest`), `hz.step.llm.completed` (cache read/write evidence), `hz.policy.revision.changed` (when a posture change is the cause).

**Failure branches.**
- Drift with `--strict-cache` ⇒ the step refuses to run; the run stops with exit 3 and the section table. Refusing is correct for CI, where a silent cache regression is a recurring cost.
- Drift caused by a dependency update that changed a tool schema ⇒ the catalog version is bumped deliberately and the pin update is reviewed. The guard exists so this is discovered in review rather than on the invoice.
- The pin is absent (first run on a new tuple) ⇒ the guard records the digest as the new baseline with a visible log line; it never fails on absence, only on change.
- Two concurrent sessions with different postures share a provider ⇒ the cache namespace includes the posture digest, so they do not thrash each other's prefixes; the guard reports an informational epoch split, not drift.
- The digest matches but cache misses stay high (provider-side eviction) ⇒ the guard reports `cache_ineffective` metrics. It never claims a hit it did not observe, and it never hides sections to flatter utilisation.

---

## 7. Security & authority

### 7.1 Capability IDs involved

| Capability ID | Where it appears in this document | Narrowing |
|---|---|---|
| `files.read` | flows 6.2, 6.8 | Workspace-bounded; symlink escapes refused; read-only, no lease. |
| `files.write`, `files.patch`, `files.delete`, `files.move` | flows 6.3, 6.4, 6.10, 6.13, 6.14 | One-use lease scoped to the resolved path set and the intent digest; serial class per resource set. |
| `terminal.run`, `process.spawn`, `terminal.pty` | flows 6.5, 6.13, 6.19 | Starlark prefix engine on argv; sandboxed; process class; never auto-retried after `UNKNOWN`. |
| `providers.infer` | flows 6.1, 6.9, 6.23, 6.24 | Posture decides local-only versus remote; a refusal is not a fallback trigger; budget-gated. |
| `agent.spawn` | flows 6.12, 6.13, 6.14, 6.18 | The one primitive; child capabilities ⊆ parent capabilities; depth, width and budget limits. |
| `mcp.invoke` | flow 6.16 | Server must be trusted; external-effect class; schema digest pinned. |
| `plugins.invoke` | flow 6.17 | Host-process isolation; declared capabilities only; no log or EffectHost handle. |
| `artifact.write` | flows 6.10, 6.16, 6.21 | Store quotas; writes are effects with receipts. |
| `memory.read`, `memory.write` | flows 6.1, 6.22 | Scope-filtered (session, workspace, user, team); distillation writes are `reviewed:false` until a human accepts. |
| `schedule.manage` | flow 6.19 | Unattended `ask` ⇒ deny; pre-authorisation is bounded and explicit. |
| `worktree.manage` | `12-sessions-state.md` §6.9 | Lease is bounded and expiring; the pool revision is an authority pin. |
| `session.manage` | flows 6.10, 6.11, 6.20 | Rewind, fork and archive are user actions; a model may propose, never perform. |
| `context.manage` | flow 6.15 | Plan approval is bound to the plan digest and a bounded window. |
| `secrets.read` | flow 6.22 redaction; otherwise `docs/11-authority-safety.md` | Never inlined into events; only digests and references appear in the log. |

### 7.2 Who may assert authority

| Assertion | Admissible only from |
|---|---|
| Human approval (`hz.permission.answered`) | A front-end with a `UserAction` origin and an authenticated device or session. |
| Policy change (`hz.policy.revision.changed`) | A user action, a managed-policy push, or a trust decision — never a model, a plugin or an MCP server. |
| Rewind (`hz.session.rewound`) | A user action, or a policy cascade recorded as such. |
| Effect settlement (`hz.effect.settled`) | The kernel's EffectHost, from a host-produced observation. |
| `UNKNOWN` (`hz.effect.unknown`) | The kernel's recovery scan. |
| Reconciliation (`hz.effect.reconciled`) | The reconciler, with evidence; or a human, with `method:'manual'`. |

Everything a model produces is a *request*: a tool call, a message, a plan, a proposal. Requests are recorded — so they are auditable and replayable — but they are never authority. That is the whole point of the execution constitution, and it is enforced at the append boundary (`EVENT_AUTHORITY_FORGED`) rather than by convention.

### 7.3 What the log must never contain

Raw secrets, credentials, tokens, private keys, and unredacted contents of sensitive paths. The log carries digests, references and redaction findings, and a trajectory is quarantined when redaction fails (flow 6.22). Provider request bodies are not logged; their digest plus a reconstructible context revision are (flow 6.1 steps 9–10), so replay rebuilds a request from the log and the pinned configuration rather than from a stored transcript of the user's code.

---

## 8. Performance budgets

Targets for a developer workstation (local SSD, 8 cores, SQLite in WAL on a local filesystem), single session, `strict` durability. These are budgets, not measurements: this document is a design, and §10 says so.

| Budget | Target | Notes |
|---|---|---|
| Append latency, single durable record (batched commit) | p50 ≤ 2 ms, p99 ≤ 15 ms | `BEGIN IMMEDIATE` plus one fsync under `strict`. |
| Append latency with 8 concurrent readers | p99 ≤ 25 ms | WAL readers do not block the writer. |
| Batch append (N ≤ 32 records) | ≤ 4 ms + 0.3 ms per record | One transaction (E-27). |
| Durable bytes per typical step | ≤ 1.5 KiB | Delta coalescing (E-14) is what keeps this small. |
| Ephemeral fan-out latency (append to client frame) | p99 ≤ 50 ms local, ≤ 150 ms over UDS/TCP | Best-effort; a lost frame is caught up by cursor. |
| Replay throughput (projectors only) | ≥ 50 000 events/s | Single thread, one aggregate. |
| Rebuild of a 1 M-record session | ≤ 30 s wall | Includes digest comparison (E-52). |
| Startup recovery scan | ≤ 250 ms for 10 000 session rows | Claim and `UNKNOWN` scan only; no projection rebuild. |
| Session log growth before archival review | 250 MiB | Then snapshot plus retention policy (§2.7), or archive. |
| Event payload inline limit | 64 KiB | Above it, externalise to the blob store (E-28). |
| Flow 6.8 recovery to first token | ≤ 2 s for ≤ 20 `UNKNOWN` effects | Reconciler probes are read-only and parallel. |
| Flow 6.11 fork of a 100 k-record session | ≤ 10 s | 500-row copy batches. |
| Flow 6.24 cache-guard digest | ≤ 1 ms per step | Hashed once per tuple and cached per revision. |
| `hzcode session verify` on a 20 k-record session | ≤ 3 s | Folds receipts; never re-runs effects. |

A budget breach is instrumentation output, not a failure mode: a run does not abort because the log was slow. The one exception is `STOPPED_LOG_UNWRITABLE`, where being unable to record is itself the emergency.

---

## 9. Tests

| Test | Proves | Where |
|---|---|---|
| `event-envelope.spec` | E-1…E-6: required fields, id uniqueness, payload validation, causation and correlation propagation | `packages/horizoncode-core/test` |
| `sequence.monotonic.spec` | E-7…E-14: contiguity under concurrent appends, gap detection, ephemeral `seq: null` | `packages/horizoncode-core/test` |
| `single-writer.fence.spec` | E-15…E-21: two-process write attempt, stale-epoch rejection, forged-authority refusal | `packages/horizoncode-testing/test` (multi-process) |
| `append.atomicity.spec` | E-22…E-30: a projector failure rolls back the record; the commit hook runs in-transaction; batch atomicity | `packages/horizoncode-core/test` |
| `versioning.upcast.spec` | E-31…E-37: fixture-driven upcasters, unsupported-version read-only, `min_reader_version` | `packages/horizoncode-protocol/test` |
| `projector.contract.spec` | E-38…E-46: determinism, idempotent replay, table ownership, digest stability | `packages/horizoncode-core/test` |
| `rebuild.shadow.spec` | E-47…E-53: shadow-rebuild equality, divergence retention, rebuild while live | `packages/horizoncode-core/test` |
| `event-catalogue.parity.spec` | §4.2 contains every name in the conventions catalogue and no extras; emitter authority matches §4.5 | `packages/horizoncode-testing/test` (gate) |
| `flow.replay.spec` | F-1: each of the 24 flows, assembled from fixtures, replays to identical projections, decisions and terminals | `packages/horizoncode-testing/test` |
| `flow.crash.matrix.spec` | F-2, F-3: kill at every effect phase — before prepare, after prepare, after execute, before settle ⇒ exactly one terminal, `UNKNOWN` where unobservable | `packages/horizoncode-testing/test` (fault injection) |
| `approval.binding.spec` | F-4: a decision bound to a stale intent digest is re-asked; a timeout denies; a denial is never laundered into model output | `packages/horizoncode-kernel-client/test` |
| `unattended.fail-closed.spec` | F-5: schedules and CI deny every `ask` that lacks a pre-authorisation | `packages/horizoncode-core/test` |
| `authority.narrowing.spec` | F-6: child, fork, skill and plugin postures are lattice meets; no widening path exists in the matrix | `packages/horizoncode-testing/test` |
| `evidence.gate.spec` | F-7: a claim contradicted by a receipt is lowered; a claim with no receipt cannot be raised | `packages/horizoncode-core/test` |
| `cache-guard.spec` | Flow 6.24: prefix byte-stability per tuple, drift attribution names a section, namespace change is not drift | `packages/horizoncode-context/test` (CI gate) |
| `budget.ratchet.spec` | §8: log growth per step stays inside budget across the fixture suite | `packages/horizoncode-testing/test` |

---

## 10. Status

**Every row is `DESIGNED`.** The HorizonCode repository contains no implementation (`file:///data/home/forge/hzcode/README.md#L7`); the reference repositories cited in this document are *design inputs*, and their contents are not evidence about HorizonCode. Where a reference records an unfinished lane of its own, this document says so rather than inheriting a claim.

| Artifact | Capability ID(s) | Level | Evidence |
|---|---|---|---|
| Event envelope, sequence rules, single-writer rule, append transaction | `session.manage` | DESIGNED | §2–§3; rules E-1…E-30. |
| Versioning and upcasting | `session.manage`, `context.manage` | DESIGNED | §2.5; E-31…E-37. No upcaster exists; the fixture-driven test is specified, not written. |
| Projector contract and rebuild | `session.manage` | DESIGNED | §2.6–§2.7; E-38…E-53. |
| Canonical event catalogue (44 events) | all | DESIGNED | §4.2; parity gate specified. Gaps G-1…G-5 all ruled in §4.6 (`_conventions.md` §11 RC-1…RC-4, RC-10). |
| Effect lifecycle events (`decision.made`, `lease.issued`, `settled`, `unknown`, `reconciled`) | `files.write`, `terminal.run`, `net.fetch`, `plugins.invoke`, `mcp.invoke` | DESIGNED | §4.2 rows 18–22 and flow 6.8. Inherited caveat: the reference kernel implements effect journals and restart reconciliation in Rust with tests, but the wiring from its recovery scan into session-log events is **not written** here, and the reference's own handoff records dead lanes (subagent dispatch gated off, no completion gate, interactive approval not wired end to end) — see `file:///data/home/forge/repo-tour/horizoncode/HANDOFF.md`. |
| Flow catalogue (24 flows) | all | DESIGNED | §6. Every failure branch is specified; none executes anywhere yet. |
| Cache-guard gate | `context.manage`, `providers.infer` | DESIGNED | Flow 6.24; ADR-009. A live cache-guard in a reference implementation is the design input; HorizonCode's gate test is specified, not written. |
| Evidence gate | `session.manage` | DESIGNED | Flows 6.8, 6.21, 6.22. Explicit unknown: whether the independent-evidence gate can be wired into the direct session lane is an inherited open work item. |
| Self-improvement record shapes | `memory.write`, `context.manage` | DESIGNED | Flow 6.22. Not implemented; the `authorityImpact` refusal is a design rule with no code behind it yet. |
| Attach and replay after a leader crash | `session.manage` | DESIGNED | Flow 6.20. A reference implements client-side replay with tests; HorizonCode specifies the equivalent over its own protocol and does not claim those tests. |
| Input admission, claims and busy periods | `session.manage` | DESIGNED | Flows 6.1, 6.6, 6.7, 6.8; the write-ahead claim rule in §2.4. Inheritance note: the claim-before-work pattern and its preserved-on-shutdown nuance come from a reference implementation (`file:///data/home/forge/repo-tour/opencode/packages/core/src/session/execution.ts#L73-L83`); HorizonCode has not built it. |

### 10.1 Open items this document creates

1. **G-1 amendment**: ~~add `hz.session.moved`~~ — **ruled and applied** (RC-1): the name is in `_conventions.md` §6 and row 26b of §4.2. An upcaster for the superseded `reattachedFrom` encoding is required at implementation time, not now.
2. **G-5 decision**: ~~decide whether plugin-load and MCP-connect events are required~~ — **ruled** (RC-2): they are not events; failures are `hz.error.raised`.
3. **Snapshot policy**: **ratified** (RC-3) — snapshots and truncation are storage metadata, not events; mirrored in `12-sessions-state.md`.
4. **Cache-guard pin ownership**: **ratified** (RC-8) — pins live in `packages/context/test/golden/prefix/<family>.sha256`; changes require an `--update-golden` commit with a written rationale under gate `cacheguard`.
5. **Exit-code reconciliation**: done for this document's flows — they now use the canonical table owned by `docs/14-surfaces.md` S16 (`0` success, `1` error, `2` usage/config/environment, `3` unprovable/fail-closed, `4` policy denial, `5` budget, `130`/`143` signals). If `07` or `14` later change the table, the flows here must be updated in the same change. **Ratified as RC-5: `14` owns the table permanently.**
6. **Denial semantics**: **ratified** (RC-6) — a policy `deny` never emits `hz.permission.asked` (flow 6.5 step 2 stands); denies are not presented as overridable.
7. **Terminal-state vocabulary**: **ratified** (RC-7) — one enum in `@horizoncode/protocol`: `succeeded | failed | denied | cancelled | unknown | budget_exhausted | timeout | interrupted`.

