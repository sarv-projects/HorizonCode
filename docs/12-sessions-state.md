# 12 — Sessions, State, Persistence & Time Travel

> What is durable, where it lives, who may write it, how it is rebuilt, how it is moved between machines, and exactly what survives each kind of death.

---

## 1. Purpose

This document decides the storage and state layer of HorizonCode:

1. **Session lifecycle** — the states a session occupies, derived from the log and nothing else.
2. **The log's schema** — tables, indices, WAL settings, and the single actor allowed to write.
3. **Projections** — what they own, how they are rebuilt, and how equivalence is proven.
4. **Admission** — the inbox, its bounds, and the ordering rules for steer and queue.
5. **Claims** — write-ahead execution claims and what a crash leaves behind.
6. **Message and part storage** — the shape of a transcript on disk.
7. **Branching and time travel** — fork, checkpoint, rewind by turn, workspace snapshot and revert.
8. **Isolation** — the worktree pool.
9. **Content addressing** — blobs, artifacts, dedup, GC and pinning.
10. **Retrieval indexes** — FTS and vectors, and why they are disposable.
11. **Migration** — log-compatible only, with the failure mode stated.
12. **Movement** — backup, restore, export, import, and the session archive format.
13. **Resources** — quota and eviction.
14. **Hostile filesystems** — the NFS/network-filesystem rules.
15. **Concurrency** — multi-process access rules.
16. **The durability matrix** — what is guaranteed after clean exit, `SIGKILL`, power loss, disk full, a kernel crash and a provider failure (§4.8).

The event *meanings* live in `docs/06-events-and-flows.md`. Where the two documents could disagree, `06` owns meaning and ordering, and **this document owns bytes on disk**.

**Non-goals.** Wire formats (`docs/07-apis-and-contracts.md`), the kernel's own journal internals (`docs/11-authority-safety.md`), and UI affordances (`docs/13-tui.md`).

---

## 2. Rules

Numbered `S-*`, each individually testable (§9). MUST unless stated. `FC` marks a fail-closed rule: refusal is the correct behaviour.

### 2.1 Lifecycle and identity

| # | Rule | FC |
|---|---|---|
| S-1 | A session id is `ses_<ulid>`, immutable for the life of the session. A re-home or fork changes location and lineage, never identity. | |
| S-2 | Lifecycle state is **derived from the log**, never stored as an independent truth. The states are `CREATED`, `ADMITTED`, `BUSY`, `IDLE`, `COMPACTING`, `REVERTING`, `ARCHIVED`, `DELETED`. | FC |
| S-3 | Orthogonal flags are derived the same way and may be set in any combination: `CLAIM_ORPHANED`, `UNKNOWN_EFFECTS_PENDING`, `RETENTION_TRUNCATED`, `DEGRADED_READ`, `MOVE_PENDING`. | |
| S-4 | A session with a live claim is never deleted. Deletion is a tombstone event plus a projection cascade; blob bodies are released only through reference counting and pinning (§2.8). | FC |
| S-5 | Any projection may be dropped and rebuilt with no loss of meaning. If a fact cannot be recovered from the log, it was never a fact. | FC |
| S-6 | A session in `DEGRADED_READ` (an event type this binary does not know) is read-only for the whole session, not just for the unknown record. | FC |

### 2.2 The log's write path

| # | Rule | FC |
|---|---|---|
| S-7 | Exactly one **writer process** per database file, and exactly one writer per aggregate within it. Writers hold a lease file plus the aggregate's `owner_epoch`; both are checked on every write, not only at startup. | FC |
| S-8 | All durable writes go through `EventLog.append` (§3.2 of `06`). No component writes a projection table outside a registered projector running inside an append transaction. | FC |
| S-9 | Log tables (`event`, `event_sequence`) are append-only and protected by triggers that raise on `UPDATE` and `DELETE`. Projection tables are ordinary writable tables and are disposable. | FC |
| S-10 | Pragmas are fixed by the storage layer, not by callers: `journal_mode=WAL` (local filesystems), `synchronous=FULL` in `strict` mode and `NORMAL` in `fast` mode, `busy_timeout=5000`, `foreign_keys=ON`, `wal_autocheckpoint=1000`, `cache_size=-64000` (64 MiB), `temp_store=MEMORY`, `auto_vacuum=INCREMENTAL`. | |
| S-11 | One writer connection per process; reads use a separate connection pool. A read never upgrades to a write inside the same transaction. | |
| S-12 | Write transactions stay short (target ≤ 100 ms): rendering, hashing large files, and network work happen outside the transaction. A transaction never waits on a network call. | |
| S-13 | The database is never copied, moved, or truncated while a writer holds it open. Backup uses the online backup API (§6.5); a raw `cp` of a live database is not a backup and must be refused by tooling that detects it. | FC |
| S-14 | File mode is `0600` and the parent directory `0700`; a `.hz/state` directory with wider modes is refused with a diagnostic rather than silently used. | FC |

### 2.3 Projections and rebuild

| # | Rule | FC |
|---|---|---|
| S-15 | Every projection declares a manifest: name, owned tables, consumed event types, and a `digest()` over its tables. No table is owned by two projections. | FC |
| S-16 | `projection_watermark(projector, aggregate_id, applied_through_seq, digest)` records the applied prefix and is written in the same transaction as the projection update. | |
| S-17 | Rebuild (`hzcode session reindex`) writes to shadow tables, compares digests, and swaps atomically. A mismatch keeps the shadow and fails the command; it never silently adopts the rebuilt state. | FC |
| S-18 | Rebuild is safe while a session is live: it reads at a snapshot watermark and never acquires the session write lease. | |
| S-19 | Readers see a consistent snapshot for the duration of a read transaction (WAL gives this for free). A projection may be at most one transaction behind the log. | |
| S-20 | A rebuild that discovers watermark/seq disagreement for an event type it does not consume is not a divergence: only owned tables and consumed types are compared. | |

### 2.4 Inbox and admission

| # | Rule | FC |
|---|---|---|
| S-21 | Admission is durable before any work begins. Every admitted item is a row in `session_inbox` derived from a durable event. | FC |
| S-22 | Ordering is by `enqueued_seq`, which equals the admitting event's log `seq`. Order is never derived from wall-clock time. | |
| S-23 | Delivery modes: `steer` promotes at the next safe step boundary; `queue` promotes at the next turn boundary; control items (`compaction`, `move`) are steer-class. | |
| S-24 | The inbox is bounded (default 1 024 pending items per session, configurable). Overflow **refuses** the admission with an explicit error; input is never silently dropped. | FC |
| S-25 | Admission is idempotent by message id: a duplicate submission returns the existing item rather than enqueuing twice. | |
| S-26 | A promoted item whose durable consequence is missing (delivered flag but no part, because a crash landed between them) is re-opened to `pending` by recovery. The projection is corrected to match the log, never the reverse. | FC |
| S-27 | Cancellation is recorded. An item disappears from the pending list only through a recorded cancellation, never through a silent delete. | FC |
| S-28 | Items admitted while `ARCHIVED` are preserved and listed on resume; they do not execute while archived. | |

### 2.5 Execution claims

| # | Rule | FC |
|---|---|---|
| S-29 | A claim row is written **in the same transaction** as `hz.session.claim.acquired`: there is no window in which work exists without a durable claim. | FC |
| S-30 | A claim is cleared only by a terminal: `hz.session.claim.released`. A claim that survives with no terminal is the signature of a process that died without teardown. | |
| S-31 | A **shutdown** interrupt preserves the claim deliberately (restart continuity). A **user** interrupt releases it. Both are recorded with different reasons. | |
| S-32 | A claim carries `owner_incarnation` and `owner_epoch`. Every write is fenced by epoch: a stale writer is refused, not merely warned. | FC |
| S-33 | Heartbeat every 2 s; TTL 30 s. A claim whose owner incarnation is gone and whose heartbeat is stale is **resumable**, never assumed complete. Recovery fails open toward resumption and never toward “assume done”. | FC |
| S-34 | Recovery is idempotent: a second recovery pass over the same claim observes `resumed=true` and does not double-count attempts. | |
| S-35 | A claim confers no authority. It routes work and fences writers; authorization comes only from Guard (`hzk`). | FC |
| S-36 | A session with `UNKNOWN_EFFECTS_PENDING` may continue interactive work, but mutations whose resource set intersects an unresolved effect are refused until reconciliation (§6.2, and flow 6.8 of `06`). | FC |
| S-37 | Claim acquisition is bounded: a configurable number of automatic resume attempts per claim, after which the session is left `CLAIM_ORPHANED` and requires a human decision. | FC |

### 2.6 Messages and parts

| # | Rule | FC |
|---|---|---|
| S-38 | A message row holds the envelope; assistant content lives in part rows keyed by `(message_id, ordinal)` with strictly monotone ordinals. | |
| S-39 | A settled message is never rewritten. In-place update is permitted only for the trailing (open) part of an open message. Any other change is a new event producing a new part or a new message. | FC |
| S-40 | Streaming updates coalesce: at most 4 part updates per second per part, with a final `complete: true` update. Delta frames are ephemeral and never stored (`06` E-14). | |
| S-41 | Content of 64 KiB or more is externalised to the blob store; the row keeps a `payload_ref` (`sha256`, bytes, mime). The event remains the fact; the blob is only bytes. | |
| S-42 | Parts are ordered by `ordinal`; ties are impossible by construction. Any repair path orders by log `seq` first, `ordinal` second. | |
| S-43 | Text is stored canonically as UTF-8 with LF newlines. Binary content exists only as blobs. Invalid UTF-8 in a text part is a projection error, not something to paper over. | FC |
| S-44 | Tool parts carry `callId`; a tool part with no matching `hz.step.tool.requested` is `ORPHAN_TOOL_PART` (warn, refuse in `--strict`). | |

### 2.7 Branching, checkpoints, rewind, snapshots

| # | Rule | FC |
|---|---|---|
| S-45 | A fork copies **settled history only** and remaps ids deterministically from the fork event id. The child's aggregate starts at `seq 0` with its own chain; the parent is never rewritten. | |
| S-46 | A fork may never be wider in authority than its parent: the child's posture is a lattice meet of parent posture and current user config. | FC |
| S-47 | Checkpoints are bounded: at most 32 per session, 64 MiB per snapshot, 512 MiB per session, 2 048 paths. Exceeding a bound is a refusal, not a silent eviction. | FC |
| S-48 | Rewind moves projections and (optionally) restores the workspace. It never deletes log records and never decreases the aggregate head. | FC |
| S-49 | Rewind is a user action. A model may propose a rewind; it may not append one. | FC |
| S-50 | Snapshot capture and restore are **effects** with leases and receipts, and both ship **disabled** until a verified Guard-and-EffectHost path exists. While disabled, `--workspace` scope refuses with `SNAPSHOT_CAPTURE_UNAVAILABLE` and says so; message-scope rewind still works. | FC |
| S-51 | Snapshot fidelity is stated, not implied: captured = tracked files plus dirty set plus untracked-in-scope; excluded = ignored files and out-of-scope paths, recorded as explicit residuals. A restore never claims to restore what it did not capture. | FC |
| S-52 | A workspace restore refuses when the working tree has changes the checkpoint did not capture (`dirty_conflict`, `untracked_conflict`) unless the user forces it, and the force is recorded in the payload and the receipt. | FC |
| S-53 | Pinned checkpoints are excluded from eviction. A checkpoint whose artifact is missing degrades to message-scope rewind rather than blocking all rewind. | |

### 2.8 Content-addressed storage

| # | Rule | FC |
|---|---|---|
| S-54 | Blobs are keyed by `sha256(content)`. Identical content is stored exactly once; dedup is mandatory, not an optimisation. | |
| S-55 | Reachability is `refs ∪ pins`. `blob_ref` rows record `(session_id, message_id, seq, hash)`; pins are named by kind and id (checkpoint, receipt, proposal evidence, export). | |
| S-56 | GC sweeps only unreachable blobs, and only for sessions without a live claim or under an epoch-checked snapshot. A pinned blob is never evicted. | FC |
| S-57 | Blob writes are atomic: write to a temp file, fsync, rename, then record the ref. A blob whose hash does not match its content is discarded and the ref is never recorded. | FC |
| S-58 | The artifact store is kernel-owned (`hzk`), separate from the session blob store, with its own quotas and access classes (`Public`, `Workspace`, `Sensitive`). The session never writes into it directly. | FC |
| S-59 | A missing blob produces an explicit missing-payload marker wherever it is referenced; it never renders as empty content. `session verify` cannot return success over a missing blob. | FC |
| S-60 | Blob store and artifact store are content-addressed but not content-authoritative: deleting the bytes never changes the log, and a restored archive re-derives the bytes from its own copy. | |

### 2.9 Retrieval indexes

| # | Rule | FC |
|---|---|---|
| S-61 | The FTS index (SQLite FTS5, `unicode61` tokenizer) and the vector index are **derived** structures. They are rebuildable from the log plus the blob store and never hold a fact that the log lacks. | |
| S-62 | The vector index carries a fingerprint: embedding model id, dimensions, normalization, chunking version. A fingerprint change forces a full rebuild; a search across mixed fingerprints is refused. | FC |
| S-63 | Index staleness is allowed and visible: every recall reports its `indexWatermark`, so a caller can tell that the index lags the log. | |
| S-64 | Scope filtering happens at query time (session, workspace, user, team). Cross-scope hits are impossible by construction; team memory is opt-in per workspace. | FC |
| S-65 | Embedding generation is an effect (`providers.infer` for remote, a local model otherwise) and therefore receipted. The index stores vectors and chunk references, not a second copy of source text beyond the FTS copy. | |
| S-66 | A corrupt or unreadable index is deleted and rebuilt; it is never repaired in place or partially trusted. | FC |

### 2.10 Migration, movement, quota, portability, concurrency

| # | Rule | FC |
|---|---|---|
| S-67 | Migrations are **add-only**: new tables, new columns with defaults, new indices, new event versions. Rewriting an event payload is forbidden. | FC |
| S-68 | Every migration is validated twice: applied to a fixture-log copy, then followed by a full shadow rebuild whose digests must match. | FC |
| S-69 | A database written by a newer binary is opened read-only, with a diagnostic naming the schema version and the required binary. Neither downgrade nor best-effort decode is offered. | FC |
| S-70 | Quota is per workspace and covers log bytes, blob bytes, artifact bytes, snapshot bytes and index bytes. A breach refuses new writes of that class; it never silently evicts to make room. | FC |
| S-71 | Eviction order is fixed: ephemeral caches, then unpinned trajectories, then archived-session projections, then archived-session log prefixes — and the last step requires an exported archive whose digest is recorded in `retention_ledger`. | FC |
| S-72 | The never-evict set: `hz.effect.*` records, receipts, pinned checkpoints, pinned artifacts, policy-revision records, and any record referenced by an open proposal. | FC |
| S-73 | A 64 MiB free-space reserve is maintained (SQLite `max_page_count` plus a filesystem guard) so a terminal `hz.error.raised` can always be recorded before the run stops. | FC |
| S-74 | On a network filesystem (NFS, SMB/CIFS, 9p, AFP, WebDAV, macFUSE/OSXFUSE, or an unknown type), WAL is not used: the journal mode is rollback (`DELETE`) and each host opens its **own** database file, because WAL's shared-memory index requires coherent mmap and reliable POSIX locks that these filesystems do not provide. | FC |
| S-75 | Network-filesystem detection uses the filesystem magic from `statfs` (plus a path-name heuristic as a fallback), and the decision is recorded in `hzcode doctor` output. An undetected network mount is a bug class, and the conservative default for an unknown magic is rollback mode. | |
| S-76 | On any shared-medium mount, two hosts writing one session is refused (`MULTI_HOST_DETECTED`): a host guard file with a host id and a heartbeat is read before any write, and a foreign live host forces read-only. This is stronger than the local single-writer rule, because on NFS the local rule cannot be enforced by locks alone. | FC |
| S-77 | Staleness checks never rely on mtime. Because NFS timestamp granularity and clock skew are unreliable, change detection uses content digests. | FC |
| S-78 | Multi-process access: one writer per aggregate; unlimited WAL readers; a second writer process downgrades to observer (`SESSION_LEASE_HELD`); one kernel supervisor per session; the plugin host and MCP client processes have no database handle; SDK, server, web, desktop and IDE clients reach state only through the owner's protocol. | FC |
| S-79 | A maintenance command that must write (reindex, GC, migration) takes an explicit maintenance lease, or operates on a shadow copy, so it can never race a live session. | FC |
| S-80 | Export redacts by policy before writing: secrets, credentials and configured sensitive paths are removed or replaced, and the redaction policy revision is recorded in the archive manifest. An export that cannot redact is refused, not produced with a warning. | FC |

### 2.11 Adopted insertions (RC-15)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

1. **Provisional→durable retirement:** streaming slots live in a separate collection from durable events so a provisional id can never dedupe the real message away; the provisional `item_started` slot carries the id the durable event will have. `item_started` is a projection slot, not an event name: the durable event it becomes is not canonical yet and appears only as `[planned] hz.session.item.started` (RC-11).
2. **Forgotten-set view reconstruction:** condensation removes events from the *view* (`forgotten_event_ids`), never from the log; any view is reconstructable from the log at any time.
3. **Sync preamble:** a log subscription declares `from_seq/through_seq` **before** replay; the watermark is emitted as one sync marker; live-only deltas are intentionally absent from replay.
4. **Runtime-identity cache keys:** projection caches key on runtime identity, not path alone.
5. **Placement/fencing (first-class):** id-bound values outlive an execution site; service acquisition is lazy; movement must not pin events to the old place — "local execution remains process-owned until clustering introduces an explicit placement and fencing protocol" (explicit deferral recorded as good practice).

---

## 3. Interfaces

### 3.1 Services

| Service | Package | Owns |
|---|---|---|
| `SessionStore` | `@horizoncode/core` | Session rows, aggregate heads, claim acquisition/release, epoch fencing. |
| `Inbox` | `@horizoncode/core` | Admission, promotion, cancellation, bounds. |
| `Projection` | `@horizoncode/core` | Projector manifests, watermarks, shadow rebuild. |
| `BlobStore` | `@horizoncode/core` | Content-addressed session blobs, refs, pins, GC. |
| `ArtifactStore` (client) | `@horizoncode/kernel-client` | Requests artifact writes/reads from `hzk`; never writes the store itself. |
| `WorktreePool` (client) | `@horizoncode/kernel-client` | Acquires, renews and releases worktree leases; mirrors pool state for display. |
| `Indexer` | `@horizoncode/context` | FTS and vector indices, fingerprints, watermarks. |
| `Archive` | `@horizoncode/core` | Export, import, backup, restore, chain verification. |

### 3.2 CLI surfaces

| Command | Contract |
|---|---|
| `hzcode session list [--state <s>] [--tree]` | Reads projections only; never touches the log's head. |
| `hzcode session show <id> [--json]` | Renders state, flags, claim status, budget, `UNKNOWN` effects. |
| `hzcode session resume <id>` | Acquires the claim if free or orphaned; refuses if another live owner holds it. |
| `hzcode session fork <id> --at <message\|turn>` | Emits `hz.session.forked`; copies settled history only. |
| `hzcode session archive <id>` / `delete <id>` | Tombstone semantics; refuses delete with a live claim. |
| `hzcode session export <id> -o <file.hzs> [--with-snapshots] [--no-blobs]` | Produces the archive of §4.7, redacted by policy. |
| `hzcode session import <file.hzs> [--keep-id]` | Verifies chain and versions, then replays into a fresh aggregate. |
| `hzcode session reindex [--session <id>] [--shadow]` | Shadow rebuild with digest comparison (§6.3). |
| `hzcode backup --to <dir>` / `hzcode restore --from <dir>` | Online backup of §6.5 / restore that refuses a live target. |
| `hzcode blob gc [--dry-run]` | Reachability sweep (§6.8). |
| `hzcode index rebuild [--fts] [--vectors]` | Rebuilds derived indices (§6.10). |
| `hzcode worktree list --journal` / `prune` | Pool state and the kernel's lease journal (per RC-3: lease transitions are kernel OwnerLog records, not session events). |
| `hzcode state doctor` | Filesystem class, journal mode, WAL safety, free space, reserve, quota, schema versions, host-guard collisions. |

### 3.3 Types (abridged)

```ts
export interface SessionRowV1 {
  id: string                 // ses_<ulid>
  projectId: string
  workspaceId: string | null
  parentId: string | null    // delegated child (agent tree)
  forkOf: { parentId: string; boundaryMessageId: string; type: "before" | "after" } | null
  directory: string
  subpath: string | null
  title: string
  postureDigest: string
  policyRevision: string
  agentProfileId: string
  modelRef: { providerId: string; modelId: string; variant?: string }
  timeCreated: number
  timeBusy: number | null
  timeIdle: number | null
  idleOutcome: "succeeded" | "failed" | "interrupted" | "budget" | "denied" | null
  timeArchived: number | null
  claim: ClaimStateV1 | null
  flags: SessionFlagsV1
}

export interface ClaimStateV1 {
  claimId: string
  ownerIncarnation: string
  ownerEpoch: number
  resumed: boolean
  heartbeatAt: number
  ttlMs: number
  attempts: number
}
```

---

## 4. Data

### 4.1 File layout

| Path | Contents | Notes |
|---|---|---|
| `<workspace>/.hz/state/hzcode.db` | The event log, projections, blob refs, indices | Workspace-scoped, so two checkouts never share a log. `0600`, dir `0700`. |
| `<workspace>/.hz/state/hzcode.db-wal`, `-shm` | WAL and shared-memory files | Present only in WAL mode (never on network filesystems). |
| `<workspace>/.hz/state/blobs/<ab>/<cd>/<sha256>` | Content-addressed blob bodies | Two-level fan-out; atomic write-then-rename. |
| `<workspace>/.hz/state/artifacts/` | Kernel-owned artifact CAS (`objects/<ab>/<cd>/<sha256>`) | Two-level shard; not written by the TS side. |
| `$XDG_STATE_HOME/horizon/user.db` | Trust records, model registry cache, price table, user-scope settings projections | Rollback journal safety rules apply here too. |
| `$XDG_STATE_HOME/horizon/memory/<workspace_digest>.db` (+ a `.vec` sidecar) | Per-workspace user-scope memory store (`memory.read` / `memory.write`) | This is the path scheme `10-cognition.md` §4.2 cites; the same rollback-journal rules apply, and doc 11 §7.3.1 step 7 admits this root for `memory.*` and `artifact.write`. |
| `<workspace>/.hz/state/kernel/` | Kernel authority state: `ownerlog/`, `effect-journal/`, `leases/`, `budget/`, `verifier/`, `worktrees/`, `trusted-state/` | Owner-only permissions (D12); not written by the TS side. |
| `<workspace>/.hz/state/spills/`, `.hz/state/skills/`, `.hz/state/history` | Shipped v0.1 stores mirrored under the canonical state root: capped tool-output spills (`<sha256>.txt`), workspace skills (`*.md`), chat history | Owner-only modes; a legacy `<workspace>/.hzcode/` workspace keeps the shipped relative names in place — never split (RC-17). |
| `<workspace>/.hz/state/snapshots/<checkpointId>/` | Snapshot artifacts (when enabled) | Bounded per §2.7 S-47. |
| `<workspace>/.hz/state/host.json` | Host guard: host id, mount class, last heartbeat | Read before any write on shared-media mounts (§2.10 S-76). |
| `<workspace>/.hz/state/exports/` | Default output directory for `.hzs` archives | Excluded from quota accounting once written. |

**Ownership.** This table is the concrete layout of record: every other document that names a state path cites this section, and a divergence in a citing document is a defect there, not a second layout (RC-16(f), reconciled 2026-11-07).

A `--portable` mode moves all runtime state under the workspace directory (useful for containers and CI); it does not change any of the durability rules, only the paths.

**Naming.** The logical database is called `hz.db` in `file:///data/home/forge/HorizonCode/docs/05-domain-and-schemas.md` (for example `hz.db::receipts_index`, `hz.db::memory_vectors`). This document owns the concrete layout, and `<workspace>/.hz/state/hzcode.db` is the `hz.db` of a workspace. Where `05` names a table that does not appear in §4.2, `05` owns the schema and this document owns where its bytes live.

### 4.2 Core tables

The schema below is the design; `06` §4.1 owns the log tables' semantics, this document owns their shape and indices.

| Table | Key columns | Indices |
|---|---|---|
| `event` | `id PK`, `aggregate_kind`, `aggregate_id`, `seq`, `ts`, `type`, `type_version`, `actor_kind`, `actor_id`, `causation_id`, `correlation_id`, `session_id`, `origin_kind`, `intent_digest`, `policy_revision`, `posture_digest`, `grant_id`, `payload`, `payload_ref`, `prev_digest`, `digest` | `UNIQUE(aggregate_id, seq)`; `(session_id, ts)`; `(type, ts)`; `(correlation_id, ts)`; `(causation_id)` |
| `event_sequence` | `aggregate_id PK`, `seq`, `owner_epoch`, `updated_at` | — |
| `event_snapshot` | `snapshot_id PK`, `aggregate_id`, `through_seq`, `folded_digest`, `blob_ref`, `created_at`, `policy_revision` | `(aggregate_id, through_seq)` |
| `retention_ledger` | `row_id PK`, `aggregate_id`, `truncated_through_seq`, `snapshot_id`, `reason`, `policy_revision`, `exported_archive_digest`, `at` | `(aggregate_id, truncated_through_seq)` |
| `event_type_registry` | `type`, `type_version`, `schema_digest`, `writer_owner`, `durability`, `min_reader_version`, `introduced_at`, `upcaster_chain` | `PK(type, type_version)` |
| `projection_watermark` | `projector`, `aggregate_id`, `applied_through_seq`, `digest` | `PK(projector, aggregate_id)` |
| `session` | `id PK`, `project_id`, `workspace_id`, `parent_id`, `fork_session_id`, `fork_boundary`, `directory`, `path`, `title`, `posture_digest`, `policy_revision`, `agent`, `model`, `cost_micro_usd`, `tokens_*`, `time_created`, `time_busy`, `time_idle`, `idle_outcome`, `time_archived` | `(project_id)`; `(parent_id)`; `(workspace_id)`; partial `(time_idle)` |
| `session_message` | `id PK`, `session_id`, `type`, `seq`, `time_created`, `time_updated`, `data` (JSON envelope) | `UNIQUE(session_id, seq)`; `(session_id, type, seq)`; `(session_id, time_created, id)` |
| `session_part` | `message_id`, `session_id`, `ordinal`, `type`, `call_id`, `data`, `time_created`, `time_updated` | `PK(message_id, ordinal)`; `(session_id, message_id, ordinal)` |
| `session_inbox` | `id PK`, `session_id`, `kind`, `payload`, `delivery`, `state`, `enqueued_seq`, `time_created`, `time_delivered`, `cancelled_reason` | `(session_id, delivery, enqueued_seq)`; `UNIQUE(session_id, enqueued_seq)` |
| `session_claim` | `session_id PK`, `claim_id`, `owner_incarnation`, `owner_epoch`, `pid`, `acquired_seq`, `acquired_at`, `heartbeat_at`, `ttl_ms`, `attempts`, `reason` | `(heartbeat_at)`; `(owner_epoch)` |
| `session_usage` | `session_id`, `scope`, `model_ref`, `tokens_*`, `cost_micro_usd`, `currency`, `price_table_revision`, `attribution`, `time_created` | `(session_id, time_created)`; `(scope)` |
| `session_checkpoint` | `checkpoint_id PK`, `session_id`, `turn_index`, `at_message_id`, `at_seq`, `kind`, `workspace_revision`, `dirty_json`, `untracked_json`, `artifact_ref`, `bytes`, `retention` | `(session_id, turn_index)` |
| `session_compaction` | `compaction_id PK`, `session_id`, `step_id`, `at_seq`, `tokens_before`, `tokens_after`, `ratio`, `strategy_set`, `cache_invalidation_estimate`, `digest` | `(session_id, at_seq)` |
| `session_effect` | `effect_id PK`, `session_id`, `step_id`, `call_id`, `capability_id`, `effect_class`, `origin_kind`, `decision`, `reason_code`, `intent_digest`, `policy_revision`, `posture_digest`, `lease_id`, `fencing_epoch`, `terminal`, `observation_digest`, `receipt_id`, `receipt_digest`, `started_at`, `settled_at` | `(session_id, settled_at)`; `(terminal)`; `(lease_id)` |
| `session_goal` / `session_plan` / `session_todo` | Current state per session | `(session_id)` |
| `blob` | `hash PK`, `mime`, `bytes`, `width`, `height`, `data`, `time_created` | `(time_created)` |
| `blob_ref` | `session_id`, `message_id`, `hash`, `seq` | `PK(session_id, message_id, hash)`; `(hash)`; `(session_id, seq)` |
| `blob_pin` | `pin_id PK`, `kind`, `ref_id`, `hash`, `created_at`, `expires_at` | `(hash)`; `(kind, ref_id)` |
| `index_meta` | `index_kind PK`, `fingerprint`, `built_at`, `watermark_seq`, `chunk_count`, `dirty` | — |
| `quota` | `scope PK`, `log_bytes`, `blob_bytes`, `artifact_bytes`, `snapshot_bytes`, `index_bytes`, `updated_at` | — |

`session_compaction` is where `CompactionRecordV1` is persisted: `10-cognition.md` §3.7 writes it through `applyCompaction`, and `hzcode session verify` walks the compaction chain (doc 10 R116).

`session_message.seq` mirrors the log seq of the event that created it, which is what makes fork, rewind and rebuild exact rather than approximate. It is a projection column, not a second source of truth.

The projection shape intentionally mirrors the reference's durable message/part/inbox/blob structure (`file:///data/home/forge/repo-tour/opencode/packages/core/src/session/sql.ts#L86-L215`) because that structure has the properties this design needs: a stable message/part split, a unique `(session, seq)` index, an inbox index that preserves enqueue order, and a blob-ref table that makes garbage collection a reachability question.

### 4.3 Pragmas and WAL settings

```sql
-- applied on every writer connection, in this order, before any other statement
PRAGMA journal_mode = WAL;            -- local filesystems only (S-74)
PRAGMA synchronous = FULL;           -- strict mode; NORMAL in --durability=fast
PRAGMA busy_timeout = 5000;           -- ms; the single-writer design keeps this rare
PRAGMA foreign_keys = ON;             -- cascade is real, not decorative
PRAGMA cache_size = -64000;           -- 64 MiB page cache
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;     -- pages
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA mmap_size = 268435456;         -- 256 MiB; disabled on network mounts
```

These values are the ones the reference implementation converged on for a local-first agent database (`file:///data/home/forge/repo-tour/opencode/packages/core/src/database/database.ts#L42-L49`), with one deliberate change: `synchronous = FULL` is the default here, because this database is the state of record and not a cache. `NORMAL` is available only as an explicit, recorded choice, and §4.8 states exactly what it gives up.

Migrations that need to relax a constraint do so transactionally, with `PRAGMA foreign_keys = OFF` or `PRAGMA defer_foreign_keys = ON` and the same-transaction restore, exactly as the reference does (`file:///data/home/forge/repo-tour/opencode/packages/core/src/database/migration.ts#L130-L133`); `defer_foreign_keys` is preferred wherever it is supported because it cannot leave the connection in the dangerous state if the transaction rolls back.

### 4.4 The action log and the OwnerLog

Two durable stores exist, and they never duplicate each other's facts:

* the **session log** (this database) records what happened in a session;
* the **OwnerLog** (kernel) records authority-bearing transactions: effect preparation, dispatch, settlement, reconciliation, worktree leases, schedule occurrences, secret use.

The OwnerLog is a per-owner, hash-chained segment log with an authoritative committed prefix (`committed_seq`, `committed_event_digest`, `active_segment_id`, `committed_offset`, `head_digest`) and a durability profile per owner (`interactive_only` for a live turn, `run_durable` for a managed run) — see `file:///data/home/forge/repo-tour/horizoncode/kernel/src/owner_log.rs#L352-L380`. Segment data is fsynced before the head is updated, so a torn write is detectable from the head alone.

The session log references OwnerLog records by digest (`receipt_digest`, `journal_record_digest`). It never copies them as facts, and it never presents a receipt it did not receive from the kernel.

### 4.5 Blob and artifact stores

| | Session blob store | Kernel artifact store |
|---|---|---|
| Owner | `@horizoncode/core` | `hzk` (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/artifact_store.rs`) |
| Addressing | `sha256(content)` | `sha256(content)` with an access class |
| Access classes | none (workspace-scoped by path) | `Public`, `Workspace`, `Sensitive` |
| Default quota | 4 GiB per workspace (configurable) | 2 GiB, 4 096 artifacts, 256 MiB per artifact, 16 MiB default capture |
| Dedup | mandatory across all sessions in the workspace | mandatory |
| Pin sources | checkpoints, receipts, proposals, exports | verifier output, checkpoint bundles, approved proposals |
| GC | reachability sweep (§6.8) | kernel-owned, operator-driven with a journal record |

The reference's store is wired only for settled verifier-output capture, with general artifact routes deliberately marked unavailable until their guarded owner path is integrated — a status this design inherits as a constraint rather than a claim: HorizonCode's artifact writes are **disabled** until the same guarded path exists (§10).

### 4.6 Retrieval indexes

```sql
-- full-text: derived, rebuildable, never authoritative
CREATE VIRTUAL TABLE part_fts USING fts5(
  text, session_id UNINDEXED, message_id UNINDEXED, part_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- vectors: one row per chunk, with a fingerprint in index_meta
CREATE TABLE part_vector (
  chunk_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
  part_id TEXT NOT NULL, ordinal INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  vector BLOB NOT NULL, norm REAL NOT NULL, model_id TEXT NOT NULL, dim INTEGER NOT NULL
);
CREATE INDEX part_vector_session_idx ON part_vector(session_id, ordinal);
CREATE INDEX part_vector_fingerprint_idx ON part_vector(fingerprint);
```

Rules: the FTS row and the vector row both reference the part they came from, so a hit is always traceable to a log record; a fingerprint mismatch makes the index unusable (`INDEX_FINGERPRINT_MISMATCH`, fail-closed) rather than mixing embedding spaces; and both indices are excluded from backups by default (they are rebuildable and dominate size).

Symbol and reference indices (`hz_index`, `hz_ast`) follow the same discipline: derived, fingerprinted by analysis version, rebuildable, and never consulted for authority.

### 4.7 The session archive format (`.hzs`)

An archive is a directory or a tar of:

```
manifest.json      sessionId, schema/schemaRev, eventCount, fromSeq, toSeq,
                   headDigest, chainHeadDigest, projectionDigests{}, redactionPolicyRevision,
                   blobsIncluded, snapshotsIncluded, exporterVersion, createdAt, hostId
chain.jsonl        one line per export: {fromSeq,toSeq,digest} checkpoints of the hash chain
                   (or a single line for a whole-aggregate export)
events.jsonl.zst   durable records in seq order, payloads externalised when large,
                   each line self-describing: {seq,id,type,typeVersion,ts,actorKind,actorId,
                   causationId,correlationId,payload|payloadRef,prevDigest,digest}
blobs/<aa>/<hash>  only blobs reachable from the exported range, plus pinned refs
receipts.jsonl     kernel receipts referenced by the range, with their digests
snapshots/         optional checkpoint snapshot artifacts (--with-snapshots)
signature          detached signature over manifest.json (optional, recommended)
```

Import semantics: verify the chain, verify `headDigest`, verify every line's schema against the registry, then replay into a **fresh aggregate** (a new session id unless `--keep-id` is given and the target id is free). An import never merges into an existing session and never overwrites one. A broken chain, an unsupported `typeVersion`, or a missing blob referenced by an included record is `INGEST_REJECTED` with nothing applied. The format is versioned by `manifest.schemaRev`; a reader refuses a newer revision rather than guessing.

Export is the only sanctioned way to move a session between machines, because it is the only path that checks the chain and applies redaction (S-80). Copying a live database file is not supported and is detected (`state doctor` warns on a `-wal` file whose database is being copied to another host).

### 4.8 Durability matrix

This is the contract the rest of the system may rely on. “Guaranteed” means: after the event is observed, the following is true on restart.

| Failure | Log records committed before the failure | In-flight record | Claims | Effects | Recovery behaviour |
|---|---|---|---|---|---|
| **(a) Clean exit** | All durable, in order | None | Released, unless shutdown preserved it deliberately (S-31) | All settled before exit | Startup finds no orphan claim; nothing to reconcile. |
| **(b) `SIGKILL`** | All records committed under `strict`; under `fast`, all records up to the last checkpointed WAL transaction | Lost; the transaction either committed or it did not, and the reader sees exactly one of those | Claim survives with no terminal; resumable (S-30, S-33) | Prepared-but-unsettled effects become `UNKNOWN` by kernel recovery | Claim resumed; `hz.effect.unknown` per unresolved effect; partial parts marked incomplete; mutations blocked on the affected resource set (S-36). |
| **(c) Power loss** | Under `strict` (`synchronous=FULL`): all records committed before the note. Under `fast` (`NORMAL`): all records committed before the **last WAL checkpoint**; recent commits may be lost and **must not be assumed** | Lost | Claim survives (it is a committed row); if its own commit was among the lost, the claim is absent and recovery is a plain cold start | Effects in flight are `UNKNOWN`; a broken media state is never repaired by guessing | Same as (b), plus: the operator is told which durability mode was in force, because under `fast` a lost tail is a *documented* outcome, not corruption. |
| **(d) Disk full** | Everything already committed | Refused: the append fails, no partial record exists | The claim may be held with no terminal; the session stops | A prepared effect that cannot be settled because settlement cannot be *recorded* becomes `UNKNOWN`, and the run stops with `STOPPED_LOG_UNWRITABLE` | The 64 MiB reserve (S-73) exists so the terminal error and the `UNKNOWN` can be written before stopping. Nothing is truncated to make room; no silent eviction. |
| **(e) Kernel crash (`hzk` dies, agent survives or dies)** | Session log is unaffected (separate process, separate database) | None | The session's claim is unaffected only if the session process lives; a supervisor lease loss forces the session to stop accepting new effects | All effects owned by the dead kernel become `UNKNOWN` at the next kernel open, before it reports ready | Fail-closed: without a ready kernel the session is read-only. Never a silent fallback to unguarded execution (ADR-003). |
| **(f) Provider failure** | Everything already committed | The step ends as `incomplete` (never silently resumed); the attempt's usage is recorded | Unaffected: the claim is held while retries and fallbacks are attempted, and released on the terminal step outcome | Effects already issued are settled normally; effects that cannot be observed become `UNKNOWN` | Fallback per `06` flow 6.23; exhausted fallbacks give an `INCOMPLETE` verdict, and any `UNKNOWN` effect keeps `session verify` from returning success. |

Three clarifications that the table cannot express:

1. **“Committed” is a filesystem claim, not a hardware claim.** On a device that lies about fsync, `strict` is as good as the device. This is stated so nobody infers a guarantee the storage stack cannot make.
2. **`UNKNOWN` is a durable outcome, not a gap.** It is written, it is terminal for the attempt, and only reconciliation clears it.
3. **The log never becomes “probably fine”.** Every ambiguous case in this table maps to either “committed” or `UNKNOWN`. There is no third answer, and no path in this document that repairs a state by inference.

### 4.9 Retention, quota and the retention ledger

| Concept | Rule |
|---|---|
| Retention default | Keep durable records. Ephemeral records are never persisted at all (`06` E-5). |
| Snapshot | A row in `event_snapshot`, not a log record, produced when a prefix is folded and validated by re-deriving `folded_digest`. |
| Truncation | Legal only under the four conditions of `06` E-49, and always accompanied by a `retention_ledger` row in the same transaction. |
| Quota accounting | Log, blobs, artifacts, snapshots and indices are accounted separately so a leak in one class is visible and does not masquerade as another. |
| Eviction order | Caches, unpinned trajectories, archived projections, archived log prefixes (last, and only with a recorded export digest). |
| Never evict | `hz.effect.*` records, receipts, pinned checkpoints, pinned artifacts, policy revisions, open-proposal evidence. |

### 4.10 Network-filesystem caveats

SQLite's WAL mode keeps its index in an mmap'd `-shm` file and depends on coherent shared memory plus reliable POSIX locks — guarantees that network filesystems do not provide. A peer host truncating or rebuilding the `-shm` file during recovery or close can pull the mapping out from under the process, and the next index read dies with `SIGBUS`. This is SQLite's own documented limitation, and the reference implementation responds to it by selecting the journal mode from the filesystem and by giving each host its own database file (`file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-sqlite-journal/src/lib.rs#L1-L13`). HorizonCode adopts both.

| Mount class | Detection | Journal mode | Database path | Multi-host |
|---|---|---|---|---|
| Local (ext4, XFS, Btrfs, APFS, tmpfs, overlayfs on local) | `statfs` magic in the local set | WAL | `<workspace>/.hz/state/hzcode.db` | Forbidden by lease + epoch fencing |
| NFS | `statfs` magic `0x6969` | rollback (`DELETE`) | `…/hzcode.<hostId>.db` | Forbidden: host guard, read-only for the second host |
| SMB/CIFS/SMB2 | magics `0x517B`, `0xFE534D42`, `0xFF534D42` (and the 32-bit sign-extended form of CIFS) | rollback | per-host | Forbidden |
| 9p, AFP, WebDAV, macFUSE/OSXFUSE | magic or mount-name heuristic | rollback | per-host | Forbidden |
| Unknown magic | conservative default | rollback | per-host | Forbidden |

The magic numbers and the mount-name fallback follow the reference's detection table, including the 32-bit-kernel sign-extension case (`file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-sqlite-journal/src/lib.rs#L297-L340`).

Additional caveats that matter as much as the journal mode:

| Caveat | Rule |
|---|---|
| Locking | `flock`/`fcntl` locks are unreliable across NFS clients, so the single-writer rule is enforced by the **host guard plus the claim epoch**, not by the lock alone (S-76). |
| Timestamps | NFS mtime granularity and clock skew make mtime unusable for staleness; digests are used instead (S-77). |
| Rename atomicity | Atomic write-then-rename is required for blobs (S-57) and is the only file-creation path used; a filesystem that cannot provide it is recorded in `doctor` and blob writes then verify by re-reading. |
| `mmap` | Disabled on network mounts, because a revoked mapping is a `SIGBUS`, not an error. |
| `.nfs*` silly-rename litter | Avoided by not using delete-and-recreate patterns for state files; rollback journal avoids the per-commit create/unlink round-trips that WAL performs. |
| Quota reporting | POSIX `statvfs` on NFS may lie about free space; the reserve check therefore also verifies a real write of a sentinel file before starting a long run. |
| Recovery | Cold recovery on NFS is slower and may need a retry loop; the reader tolerates `ESTALE` by re-opening once, then fails loudly. |

### 4.11 Multi-process access rules

| Actor | Read | Write | Enforcement |
|---|---|---|---|
| Session owner (the Controller holding the claim) | yes | yes, one aggregate, and the whole database if it is the only writer | Claim epoch + lease file + `BEGIN IMMEDIATE` |
| Second session owner (another workspace session) | yes | yes, its own aggregate | Per-aggregate head and single writer connection pool |
| Second process for the **same** session | yes | no | `SESSION_LEASE_HELD`, downgrade to observer |
| Front-end (TUI, print, server, web, desktop, IDE bridge, MCP server, SDK) | via protocol only | via protocol only (commands) | No database handle |
| Plugin host | no | no | Separate process, no path to the database |
| MCP server process | no | no | Separate process, never handed a handle |
| Kernel `hzk` | its own OwnerLog | its own OwnerLog | Owner lock file, one writer per owner |
| Maintenance (`reindex`, `gc`, `backup`, migration) | yes | shadow tables or an offline copy | Maintenance lease (S-79) |
| Second host on a shared mount | yes | no | Host guard heartbeat (`MULTI_HOST_DETECTED`) |

Rationale for keeping clients off the database: the protocol is the only supported mutation path, which is what makes the parity ratchet enforceable across eight surfaces. A front-end that could write tables directly would be a ninth implementation of the agent, and it would bypass receipts.

**Leader arbitration.** Two processes that want to own the workspace arbitrate with an advisory lock file (`<workspace-hash>.lock`, `flock`/`LockFileEx`) held for the leader's lifetime, with a bounded stale check on pid liveness and age, exactly as `docs/14-surfaces.md` S37 specifies. That lock decides who *tries*; the claim epoch (S-32) decides who *may write*: a leader that outlives a stale-lock reclaim still cannot write once its epoch has been superseded. Two mechanisms, because lock-file reclamation is heuristic and fencing is not.

---

## 5. Errors & failure modes

`FC` = fail-closed: the operation is refused rather than attempted in a degraded mode. Codes appear in `hz.error.raised.payload.code` (the error class rides in `payload.class` — `06` row 40 and RC-2) and in CLI diagnostics. As in `06` §5, these codes are internal diagnostics: a surface maps them to the registered `HZ_*` vocabulary (`07` §4.10.2) before returning them to a caller (RC-16(b)).

| Code | Raised when | Behaviour | FC |
|---|---|---|---|
| `SESSION_LEASE_HELD` | A second process attempts to write an aggregate | Downgrade to read-only observer; name the holding pid and incarnation. | yes |
| `SESSION_EPOCH_STALE` | A write carries an epoch older than `session_claim.owner_epoch` | Reject the write; the writer must re-acquire. | yes |
| `CLAIM_RESUME_LIMIT` | Automatic resume attempts exceed the bound (S-37) | Leave `CLAIM_ORPHANED`; require an explicit `session resume`. | yes |
| `INBOX_FULL` | Pending items exceed the bound (S-24) | Refuse the admission; keep the item in the caller's hands. | yes |
| `PROJECTION_DIVERGENCE` | A projector fails, or a rebuild digest mismatches | Abort the transaction; keep the shadow for forensics. | yes |
| `PROJECTION_TABLE_OWNERSHIP` | Two projectors declare the same table | Refuse to start projections. | yes |
| `REINDEX_SHADOW_MISMATCH` | Shadow rebuild differs from live | Do not swap; report the first differing row and projector. | yes |
| `SNAPSHOT_CAPTURE_UNAVAILABLE` | Workspace capture requested while the guarded path is disabled (S-50) | Refuse with the reason; message-scope rewind still available. | yes |
| `SNAPSHOT_RESTORE_UNAVAILABLE` | Workspace restore requested while disabled | Refuse; never partially restore. | yes |
| `DIRTY_CONFLICT` / `UNTRACKED_CONFLICT` | Restore target has changes the checkpoint did not capture | Refuse unless forced; the force is recorded. | yes |
| `CHECKPOINT_LIMIT` | Checkpoint bounds exceeded (S-47) | Refuse the new checkpoint; never silently evict a pinned one. | yes |
| `BLOB_HASH_MISMATCH` | Stored bytes do not hash to their key | Discard the blob, never record the ref, report the device or filesystem. | yes |
| `BLOB_MISSING` | A referenced blob is absent | Render an explicit missing-payload marker; `session verify` cannot succeed. | yes |
| `GC_BUSY` | GC requested while the owning session holds a live claim | Refuse, or run under an epoch-checked snapshot. | yes |
| `ARTIFACT_QUOTA_EXCEEDED` | Artifact store quota would be exceeded | Refuse the effect; the caller learns before writing bytes. | yes |
| `INDEX_FINGERPRINT_MISMATCH` | Search across mixed embedding fingerprints | Refuse the search; require a rebuild. | yes |
| `INDEX_CORRUPT` | Index unreadable or inconsistent with `index_meta` | Delete and rebuild; never partially trust it. | yes |
| `MIGRATION_INCOMPATIBLE` | A migration would rewrite payloads or drop live data | Refuse to apply; require a new event version plus a rebuild. | yes |
| `SCHEMA_NEWER_THAN_BINARY` | The database was written by a newer binary (S-69) | Open read-only with the version named. | yes |
| `STOPPED_LOG_UNWRITABLE` | The append fails for storage reasons (disk full, I/O error) | Stop the run; settle or `UNKNOWN` outstanding effects; never continue unrecorded. | yes |
| `DISK_FULL_RESERVE_BREACH` | Free space falls below the reserve (S-73) | Stop mutations; write the terminal error; refuse new effects. | yes |
| `QUOTA_EXCEEDED` | A quota class is full (S-70) | Refuse writes of that class only; other classes continue. | yes |
| `NFS_WAL_UNSAFE` | WAL requested on a network filesystem | Force rollback journal and per-host database file (S-74). | yes |
| `MULTI_HOST_DETECTED` | A foreign live host holds the workspace | Read-only for the second host (S-76). | yes |
| `FILE_MODE_TOO_OPEN` | State directory or database has modes wider than `0700`/`0600` | Refuse to use the directory; print the `chmod` needed. | yes |
| `ARCHIVE_CHAIN_BROKEN` | Import or restore fails hash-chain verification | Apply nothing. | yes |
| `ARCHIVE_VERSION_UNSUPPORTED` | Archive `schemaRev` newer than the binary | Apply nothing; name the required version. | yes |
| `RESTORE_TARGET_LIVE` | Restore would overwrite a session with a live claim | Refuse. | yes |
| `WORKTREE_POOL_LIMIT` | Pool or active-lease ceiling reached | Refuse the lease; queued work waits rather than sharing a tree. | yes |
| `WORKTREE_QUARANTINED` | A worktree is in `Quarantined` (dirty after an `UNKNOWN` effect) | Refuse to lease until reconciliation clears it. | yes |
| `WORKTREE_BASE_REVISION_MISMATCH` | The requested base revision differs from the tree's pinned revision | Refuse; create a fresh tree from the requested base. | yes |
| `ORPHAN_TOOL_PART` | A tool part has no matching tool request | Warn; refuse under `--strict`. | no (default) |
| `COPY_OF_LIVE_DB` | Tooling detects a database file copied while a `-wal` exists | Warn loudly; the copy is not a valid backup; direct the user to `hzcode backup`. | no |

Three behaviours deserve emphasis because they are the ones a reader might assume the opposite of:

1. **Disk full never truncates.** The system stops and records why. Freeing space by deleting records is a decision for a human with an export in hand.
2. **Quarantine is not deletion.** A quarantined worktree or an `UNKNOWN` effect stays until it is explained, because an unexplained artifact on disk is exactly the thing that later causes a false “done”.
3. **A copied file is not a backup.** The only supported backup is the online backup API with blob copy (§6.5), and the only supported transfer is the archive (§4.7).

---

## 6. Flows

### 6.1 Session lifecycle

**Actors.** FE, CTL, kernel (`hzk`), storage.

1. `CREATED`: `hz.session.created` is appended with posture, policy revision and model ref. The session row appears.
2. `ADMITTED`: the first `hz.session.prompt.admitted`. The session is now allowed to run.
3. `BUSY`: `hz.session.claim.acquired` followed by `hz.session.busy.entered`. Steps run (`06` flows 6.1–6.6).
4. `COMPACTING` / `REVERTING`: transient, orthogonal to busy. Both are *in-progress* states, so they are entered by the **start** of the work — `hz.step.started` carrying the compaction/rewind prefix variant, or the rewind command's admission — and exited by `hz.session.compacted` and `hz.session.rewound`. Those two events are past-tense completion facts (doc 10 R116 carries the finished `CompactionRecordV1`), so deriving an in-progress state from them would make it unobservable.
5. `IDLE`: `hz.session.busy.left` plus `hz.session.claim.released`. The session is quiescent; the projection's `time_idle` and `idleOutcome` are set.
6. `ARCHIVED`: archived by a user action; queued items are preserved, no new execution starts, reads continue.
7. `DELETED`: a tombstone event plus cascade. Refused while a claim is live (S-4). Blob refs are released; pinned blobs survive.

**Failure branches.**
- Crash in any state ⇒ §6.2 recovery, which always resolves to a state the log supports.
- Archive requested while busy ⇒ queued as a control item; the transition happens at a boundary.
- Delete requested with `UNKNOWN_EFFECTS_PENDING` ⇒ allowed, but the pending effects are exported into the delete record's evidence reference so they are not forgotten with the session.
- Lifecycle and flags disagree in the projection ⇒ the projector is rebuilt from the log; the projection is never “patched” by hand.

### 6.2 Recovery at start

**Actors.** storage, CTL, kernel, reconciler.

1. Open the database, read `schema_version` and the registry; refuse write access on a newer schema (`SCHEMA_NEWER_THAN_BINARY`).
2. Read `host.json`; on a shared-medium mount, verify no foreign live host (`MULTI_HOST_DETECTED`).
3. Set pragmas (§4.3); perform a WAL recovery if a `-wal` file exists, then a `PASSIVE` checkpoint.
4. Scan `session_claim` for claims whose owner incarnation is gone and whose heartbeat is older than the TTL. For each: resume (`hz.session.claim.acquired{resumed:true}`) or release, within the attempt bound (S-37).
5. Ask the kernel to reconcile its OwnerLog: unresolved effect rows become `UNKNOWN` **before** the kernel reports ready.
6. Write `hz.effect.unknown` for each unresolved effect, and mark partial assistant parts incomplete (`hz.part.updated{complete:false}`).
7. Repair the inbox projection: promoted-but-partless items return to `pending` (S-26).
8. Rebuild any projection whose watermark is behind the log's head for its consumed types (bounded, incremental).
9. Report: `hzcode state doctor` prints claims resumed, effects unknown, projections rebuilt, and the durability mode in force.

**Failure branches.**
- Kernel journal unreadable (broken head digest) ⇒ read-only workspace, fatal diagnostic; effects may not be assumed.
- Claim scan finds a claim whose epoch is greater than the stored sequence head (evidence of a half-restored database) ⇒ refuse to write and require an import from an archive.
- Projection rebuild fails ⇒ session read-only until `session reindex` succeeds; the log is still intact and exportable.
- Recovery crashes mid-way ⇒ idempotent: each step is guarded by a fact it wrote, so a second run resumes rather than repeats visibly.

### 6.3 Projection rebuild (`hzcode session reindex`)

**Actors.** storage, Projection service.

1. Determine the target set (one session or all) and the floor (`max(0, retention_ledger.truncated_through_seq)`).
2. Create shadow tables with the same schema, suffixed `__shadow`.
3. Replay from the newest usable `event_snapshot` (or the floor) applying each projector into the shadow.
4. Compute `digest()` per projector over the shadow tables.
5. Compare with the live digest and with `event_snapshot.folded_digest` where a snapshot was used.
6. On equality: swap tables in one transaction, update `projection_watermark`, drop the shadow.
7. On mismatch: keep the shadow, write a divergence report (first differing row, projector, seq), and exit non-zero.

**Failure branches.**
- No snapshot and a truncated floor ⇒ the rebuild can only cover the retained prefix; it says so and marks the aggregate `RETENTION_TRUNCATED`.
- Rebuild while the session is busy ⇒ safe by design (S-18): it reads at a snapshot and writes only shadow tables. A busy session's newest events are replayed after the watermark, never skipped silently.
- Two reindex runs concurrently ⇒ serialized by a maintenance lease; the second observes the first's completion.
- A projector's code changed since the last rebuild ⇒ that is exactly the case this flow exists to catch: the digest comparison fails unless the change is intentional, in which case the projector's version is part of its manifest and the change is reviewed.

### 6.4 Log retention: snapshot, validate, ledger, truncate

**Actors.** storage, retention policy.

1. The policy chooses a candidate prefix per aggregate (age, size, or an explicit request).
2. Fold the prefix into an `event_snapshot` row with `folded_digest`.
3. Validate: run the shadow rebuild of `06` E-52 over the prefix and compare digests. Only equality permits the next step.
4. Check the never-truncate conditions: no pinned checkpoint, receipt, proposal or export reference inside the prefix (`06` E-49).
5. Write the `retention_ledger` row (aggregate, `truncated_through_seq`, snapshot id, reason, policy revision, exported archive digest, timestamp) **in the same transaction** as the truncation.
6. Truncate the `event` rows below the floor; keep `event_sequence` at its monotonic head.
7. Readers are told the new floor on their next read; a reader holding an older cursor gets `LOG_TRUNCATED` and resyncs.

**Failure branches.**
- Validation fails ⇒ nothing is truncated; the snapshot is discarded and the failure reported.
- A pinned reference is found ⇒ the candidate floor is raised above it and the run retried; the operator is told which pin constrained it.
- The exported archive digest is required but no archive exists ⇒ truncation is refused; retention may not be the only copy of history.
- Truncation is interrupted mid-way ⇒ the ledger row and the truncation are one transaction, so the state is either “before” or “after”, never half.

### 6.5 Backup

**Actors.** operator, storage.

1. `hzcode backup --to <dir>` refuses to run while a migration is pending, and takes a maintenance lease that excludes migrations but permits live sessions.
2. It calls the SQLite online backup API to produce a consistent database copy (this is the only supported way to copy a live database).
3. It copies reachable blobs that were written before the backup's snapshot point, verifying each hash on the way out.
4. It copies `host.json`, the archive manifest skeleton, and the schema/registry version table.
5. It writes `backup.json`: database digest, blob count and digest list, schema versions, durability mode, library version, and the point-in-time `seq` per aggregate.
6. It optionally produces an `.hzs` export per session (the portability path of §6.7).

**Failure branches.**
- A blob hash mismatch during copy ⇒ abort the backup; a backup that cannot be verified is not a backup.
- The target is on a network filesystem ⇒ allowed, but the copy itself is written with rollback-journal semantics and a per-host name, and the manifest records the mount class.
- The backup is interrupted ⇒ the target directory is marked incomplete (a `INCOMPLETE` marker file) and is refused by restore.
- Free space insufficient mid-copy ⇒ abort with `DISK_FULL_RESERVE_BREACH`, leaving the incomplete marker.

### 6.6 Restore and import

**Actors.** operator, storage, Archive service.

1. Verify the target: no live session with that id (`RESTORE_TARGET_LIVE`), no live claim on the workspace, no foreign host on a shared mount.
2. Verify the archive: manifest present, `schemaRev` supported, chain verified, `headDigest` recomputed from the events, every referenced blob present.
3. Verify event versions against the registry: every `typeVersion` must be decodable, or the import is refused as a whole.
4. Import: replay into a fresh aggregate (new id unless `--keep-id`), rebuilding projections as events are applied — a restore is an import plus a projection build, never a file copy into a live database.
5. Restore (`hzcode restore --from <dir>`): the database copy is put in place, WAL files are discarded, `PRAGMA integrity_check` runs, and a shadow rebuild verifies projections before the database is handed to a session.
6. Reconcile: every claim in the restored database is treated as orphaned (S-33) and every unresolved effect as `UNKNOWN`.
7. Report the restored head per aggregate and the durability mode.

**Failure branches.**
- Chain broken, version unsupported, or blob missing ⇒ refuse; nothing is applied.
- `integrity_check` fails ⇒ the restore is refused and the original database is untouched.
- Restore into a workspace with a different absolute path ⇒ allowed, but recorded: the session's `directory` is re-resolved and a re-home is emitted as `hz.session.moved` with `movedFrom` (RC-1) before the session may execute.
- Import of a session that already exists with `--keep-id` ⇒ refused (`SESSION_ID_TAKEN`); the operator picks a new id.

### 6.7 Export (session archive)

**Actors.** operator, Archive service, redaction policy.

1. Determine the range: whole aggregate, or a prefix for retention archiving (with the floor constraints of §6.4).
2. Apply the redaction policy; record its revision in the manifest. A redaction failure refuses the export (S-80).
3. Write events in `seq` order, externalising payloads above the inline limit and recording their refs.
4. Collect reachable blobs and pinned refs for the range; verify each hash as it is written.
5. Attach the receipts referenced by the range, with digests.
6. Write `manifest.json` and the chain file; optionally sign.
7. Verify the archive by reading it back and recomputing the chain head; a mismatch refuses the archive rather than shipping an unverified file.

**Failure branches.**
- Missing blob within the range ⇒ the export declares `blobsIncluded: partial` with the exact missing hashes, or is refused under `--strict-export`. A silently lossy export is forbidden.
- The range crosses a truncation floor ⇒ the export begins at the floor and says so; it cannot invent the missing prefix.
- Signing fails ⇒ the archive is still written but marked unsigned, and the reason is recorded.

### 6.8 Blob garbage collection

**Actors.** storage, GC sweeper.

1. Acquire the maintenance lease or an epoch-checked snapshot; refuse on a live claim for the owning session (`GC_BUSY`) unless sweeping under a snapshot.
2. Compute reachability: every `blob_ref` row, every `blob_pin`, every checkpoint artifact reference, every receipt observation reference, every proposal evidence reference.
3. Sweep: unreachable blobs older than a grace period (default 24 h, to protect an in-flight write whose ref is not yet committed) are deleted.
4. Never delete: pinned blobs, blobs referenced by any session in the workspace, blobs younger than the grace period.
5. Record a GC summary (bytes freed, blobs deleted, skipped by pin) in the workspace journal so a shrink is attributable.
6. `--dry-run` reports the same list without deleting.

**Failure branches.**
- The sweep crashes mid-way ⇒ the next run recomputes reachability; deletion is idempotent by hash.
- A blob is deleted that a later rebuild needs ⇒ impossible by construction: rebuilds read the log and the refs, and a pinned-by-checkpoint blob is excluded; if it happens, `BLOB_MISSING` surfaces at read time rather than silently.
- Hash mismatch discovered during the sweep ⇒ the blob is deleted (it is corrupt) and the finding is reported.

### 6.9 Worktree pool lease lifecycle

**Actors.** kernel (`hzk`), CTL, AG, VCS layer.

1. A task needs isolation: a request names the base revision, the workspace, and an idempotency key.
2. The pool either reuses a `Free` tree whose pinned base revision matches, or creates a fresh tree and registers it (`Free`).
3. Admission checks: pool ceiling, active-lease ceiling, base-revision match, and the workspace/policy pins. On success the tree becomes `Leased` with a bounded, expiring lease.
4. Every operation inside the lease still traverses Guard with its own capability and receipt: the worktree lease is a *scope*, never an authorization (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/worktree_pool.rs#L1-L29`).
5. The pool revision is an authority pin: a lease held against a stale pool revision is refused at use, which fences a tree that was registered before a policy or registration change.
6. On release: a clean tree returns to `Free`; a dirty tree is either committed/merged by the owning task or moved to `Quarantined`.
7. Quarantine is cleared only by inspection or reconciliation; a quarantined tree is never leased again (`WORKTREE_QUARANTINED`).
8. `Removed` is terminal: the directory is deleted and the registration is retained as a tombstone for audit.

**Failure branches.**
- Pool limit reached ⇒ refuse the lease; the caller waits or spawns fewer workers. Work is never silently serialized onto one tree.
- Base revision mismatch ⇒ refuse; a fresh tree is created from the requested base (never a rebase of someone else's tree).
- The task crashes with a lease held ⇒ the lease expires by TTL, the tree is inspected, and if work is `UNKNOWN` it is quarantined rather than reused.
- The tree's filesystem is a network mount ⇒ discouraged and recorded; worktree operations are the most lock-sensitive paths in the system.
- Registration journal unavailable ⇒ refuse to lease (fail-closed), because an unregistered tree cannot be fenced.

### 6.10 Index refresh (FTS and vectors)

**Actors.** Indexer, storage, provider (for embeddings).

1. Read `index_meta` for the current fingerprint and watermark.
2. If the fingerprint differs from the configured one ⇒ full rebuild, old rows deleted first (`INDEX_FINGERPRINT_MISMATCH` prevents any mixed-space query in the meantime).
3. Otherwise incremental: consume parts newer than `watermark_seq`, chunk them, write FTS rows and vector rows, update `watermark_seq` and `chunk_count`.
4. Embeddings are generated as receipted effects; a failure leaves the index at the previous watermark (staleness, not corruption).
5. Queries report `indexWatermark` so callers can see the lag (§2.9 S-63).

**Failure branches.**
- Embedding provider unavailable ⇒ the FTS half still refreshes; vector lag is reported, never hidden.
- Index file corrupt ⇒ delete and rebuild (S-66).
- Rebuild interrupted ⇒ `dirty` is set and the index is unusable until the rebuild completes; queries fail closed rather than returning partial results.
- Memory scope narrowed by policy ⇒ the index rows for now-forbidden scopes are deleted, not merely filtered at query time.

### 6.11 Disk full: the stopping sequence

**Actors.** storage, CTL, kernel, operator.

1. A write fails (SQLITE_FULL, ENOSPC). The run does **not** retry the same write in a loop.
2. Free-space check confirms `DISK_FULL_RESERVE_BREACH`; the reserve (64 MiB) is still available.
3. Outstanding effects are settled if they can be observed; those that cannot are recorded as `UNKNOWN` using the reserve.
4. The last records written are `hz.effect.unknown` entries and `hz.error.raised{class:'storage', failClosed:true, severity:'fatal'}`.
5. The run terminates with `STOPPED_LOG_UNWRITABLE`; the session's claim is left in place (shutdown semantics, S-31) so a later start resumes.
6. The CLI prints how much space is needed, what was not recorded, and which effects are unresolved.

**Failure branches.**
- The reserve is exhausted too (a fatal for the whole volume) ⇒ the process exits immediately with a diagnostic on stderr; nothing further can be guaranteed and the design says so instead of pretending.
- Partial record in the page cache lost at power loss ⇒ SQLite's own journaling guarantees the database remains a valid prefix; the operator sees the last committed seq.
- User deletes records to free space ⇒ refused by the tooling: only GC (§6.8) and retention with an exported archive (§6.4) may delete anything.

---

## 7. Security & authority

### 7.1 Capability IDs per operation

| Operation | Capability ID | Narrowing |
|---|---|---|
| Read the log, projections, archives, indices | `session.manage` (read-only) | Workspace-scoped; scope filtering for memory; exports redact by policy. |
| Write the log (append) | **no Guard capability** — the storage layer's single writer (S-7, S-8) | Only the session owner; epoch-fenced; append-only by trigger. A log append is not a model-requestable effect. |
| Fork, rewind, archive, delete, share | **UNKNOWN** — the write-scoped session capability is not named in `_conventions.md` §5 (queued; doc 11 §4.1 records the same UNKNOWN) | Controller commands; user action only (S-49 for rewind); fork narrows posture (S-46). |
| Export / import | **UNKNOWN** — same queued write-scoped capability; the redaction policy itself is read-scoped | Redaction before write (S-80); import is additive only. |
| Backup / restore | **UNKNOWN** — same queued write-scoped capability | Maintenance lease; restore refuses a live target. |
| Blob write / GC | `files.write` for the ref-recording effect; GC runs under the maintenance lease | Blobs are content-addressed and never authority; pinned blobs are outside GC's reach. |
| Artifact write (snapshots, verifier output) | `artifact.write` | Kernel-owned store, access-class checks, quota refusal before bytes are written. |
| Worktree lease | `worktree.manage` | Bounded, expiring, revision-pinned; the lease is a scope, not an authorization. |
| Index build (embeddings) | `providers.infer` (remote) or a local model | Receipted; scope-narrowed; the index is derived and disposable. |
| Memory read/write | `memory.read`, `memory.write` | Tier and scope checks at query time and at write time; team scope is opt-in. |
| Migration | **UNKNOWN** — same queued write-scoped capability | Maintenance lease; add-only (S-67); validated by rebuild (S-68). |

The `UNKNOWN` rows are deliberate. `session.manage` is `read-only` in doc 11 §4.1 (an effect class is singular and immutable), so it cannot authorise a log write, an import or a restore; and neither this document nor doc 11 may invent a capability ID (`_conventions.md` §1). The write-scoped session ID is therefore queued for `_conventions.md` §5's reserved block with an RC-11 `[planned]` marker. Until it lands, these operations are Controller commands gated by the user action and the session claim — not model-requestable capabilities.

### 7.2 What the store must never contain

Raw secrets, credentials, tokens or private keys — in the log, in projections, in blobs, in archives or in indices. Secrets exist only in the vault and appear in the log as digests and references (`secrets.read` is never inlined). Redaction runs before export (S-80) and before trajectory storage, and a redaction failure is a refusal or a quarantine, never a warning attached to a leaky artifact.

### 7.3 Authority boundaries the storage layer enforces

1. **Append-only.** The log cannot be edited, merely extended (S-9). This is what makes `session verify` meaningful.
2. **The kernel owns its ledger.** HorizonCode stores receipts by digest and never writes one (S-58, §4.4).
3. **Deletion is a decision, not a side effect.** Two mechanisms may delete history — retention with an export (S-71) and GC of unreachable bytes (S-56) — and both leave a ledger or a journal entry.
4. **The projection is not the truth.** Every repair path corrects the projection from the log; no path ever corrects the log from a projection.
5. **A copied file is not a transfer.** Archives are the portability mechanism, because they verify chains and apply policy; a database copy is neither (S-13).

---

## 8. Performance budgets

Budgets, not measurements. Measured on a developer workstation with a local SSD, 8 cores, `strict` durability, unless stated.

| Budget | Target | Notes |
|---|---|---|
| Open + pragmas + schema check (warm) | ≤ 150 ms | Cold with WAL recovery: ≤ 1.5 s. |
| Startup recovery scan (10 000 sessions) | ≤ 250 ms | Claim, `UNKNOWN` and inbox repair only. |
| Append latency (durable record, batched) | p50 ≤ 2 ms, p99 ≤ 15 ms | Inherited from `06` §8; this document does not change it. |
| Database growth per typical coding step | ≤ 8 KiB (log + parts + blob refs) | Includes externalised payload refs, excludes blob bodies. |
| Blob write throughput | ≥ 200 MiB/s local | Dedup hit path (hash exists): ≤ 1 ms. |
| Blob GC (10 000 blobs) | ≤ 2 s | Reachability set computation dominates. |
| FTS index build (1 M parts) | ≤ 180 s | Incremental refresh of 10 k parts: ≤ 4 s. |
| FTS query | p99 ≤ 30 ms at 1 M parts | Local, warm cache. |
| Vector index build (100 k chunks) | ≤ 120 s local embeddings | Remote embeddings are provider-bound and budgeted separately. |
| Vector query (100 k chunks, top-50) | p99 ≤ 50 ms | Brute-force scan below 1 M; an ANN index above it, fingerprinted. |
| Reindex (1 M-event session) | ≤ 30 s | Matches `06` §8. |
| Fork (100 k-event session) | ≤ 10 s | 500-row copy batches. |
| Backup (10 GiB incl. blobs) | ≤ 60 s | Online backup API plus verified blob copy. |
| Export (100 k records, no blobs) | ≤ 20 s | Compression included. |
| Import + projection build (100 k records) | ≤ 45 s | Chain verification plus replay. |
| Checkpoint capture (10 k files) | ≤ 5 s when enabled | Bounded by S-47; disabled by default (S-50). |
| Worktree checkout (pool hit) | ≤ 800 ms | Pool miss (fresh clone/checkout): budgeted by the VCS layer. |
| Database size per session before archival review | 250 MiB log | Truncation requires an export (S-71). |

---

## 9. Tests

Every path below is `[planned]`: the workspace today holds `kernel/tests/integration.rs` and four `app/tests/` suites (core 8 files, tools 9, providers 6, TUI 8) and no `packages/` tree. The planned package names follow `_conventions.md` §3 — `@horizoncode/core` → `packages/core`, `@horizoncode/context` → `packages/context`, `@horizoncode/testing` → `packages/testing`.

| Test | Proves | Where |
|---|---|---|
| `schema.invariants.spec` | S-9, S-10: append-only triggers raise; pragmas applied in order; file modes enforced | `[planned]` `packages/core/test` |
| `claim.crash.matrix.spec` | S-29…S-37: kill at every phase between claim and terminal; exactly one terminal; resume within the attempt bound | `[planned]` `packages/testing/test` (fault injection) |
| `claim.fencing.spec` | S-32, S-33: a stale epoch cannot write; a stale heartbeat is resumable, never “done” | `[planned]` `packages/testing/test` |
| `inbox.ordering.spec` | S-22…S-28: steer versus queue boundaries, dedup, bounds, crash between promotion and part | `[planned]` `packages/core/test` |
| `projection.rebuild.spec` | S-15…S-20: shadow rebuild equality, divergence retention, rebuild under a live session | `[planned]` `packages/core/test` |
| `message.parts.spec` | S-38…S-44: settled messages immutable, ordinal monotonicity, coalescing, externalisation threshold | `[planned]` `packages/core/test` |
| `fork.rewind.spec` | S-45…S-49: settled-only copies, deterministic id remap, monotonic head, projection rewind without log delete | `[planned]` `packages/core/test` |
| `snapshot.disabled.spec` | S-50…S-53: capture and restore refuse with the documented code while disabled; message-scope rewind still works | `[planned]` `packages/core/test` |
| `blob.cas.spec` | S-54…S-60: dedup, refs, pins, hash mismatch, missing blob rendering, atomic write | `[planned]` `packages/core/test` |
| `index.fingerprint.spec` | S-61…S-66: fingerprint gate, scope filtering, rebuild after corruption, watermark reporting | `[planned]` `packages/context/test` |
| `migration.compat.spec` | S-67…S-69: add-only migrations, fixture-log application, rebuild equivalence, newer-schema read-only | `[planned]` `packages/core/test` (gate) |
| `quota.reserve.spec` | S-70…S-73: per-class quota refusal, eviction order, reserve preserved on a small loopback filesystem | `[planned]` `packages/testing/test` (small FS fixture) |
| `nfs.detection.spec` | S-74…S-77: magic-number table including 32-bit sign extension, mount-name fallback, rollback selection, per-host path | `[planned]` `packages/core/test` (fake `statfs`) |
| `multihost.guard.spec` | S-76, S-78: second host becomes read-only; clients have no database handle | `[planned]` `packages/testing/test` (multi-process) |
| `archive.roundtrip.spec` | §4.7, S-80: export/import round-trip, chain verification, version refusal, redaction enforced, missing-blob behaviour | `[planned]` `packages/core/test` |
| `backup.restore.spec` | §6.5, §6.6: online backup under load, incomplete-marker refusal, restore integrity check, orphaned claims after restore | `[planned]` `packages/testing/test` |
| `diskfull.sequence.spec` | §6.11, S-73: writes fail, reserve is used for the terminal records, nothing is truncated | `[planned]` `packages/testing/test` (small FS fixture) |
| `durability.matrix.spec` | §4.8 rows (a)–(f): the stated guarantee for each failure, per durability mode | `[planned]` `packages/testing/test` (fault injection) |
| `worktree.lease.spec` | §6.9: pool limits, revision pinning, TTL expiry, quarantine, stale pool revision refusal | `[planned]` `packages/testing/test` |

---

## 10. Status

**Levels are owned by `docs/28-implementation-status.md`** (RC-13). The rows below record only the v0.1 slice this document's storage layer actually has — SQLite sessions with a single writer, the sessions and config suites, the kernel's 4-process concurrent-append lock test — and everything else stays `DESIGNED`. Reference repositories are design inputs, not evidence about this project. One row is deliberately marked `UNKNOWN` because the evidence required to design it is genuinely missing.

| Area | Capability ID(s) | Level | Evidence and caveats |
|---|---|---|---|
| Lifecycle, flags, derived state | `session.manage` | TESTED + VERIFIED (v0.1 subset) | §2.1, §6.1; S-1…S-6. The v0.1 store derives lifecycle and flags in `app/tests/core/session.test.ts`; the compaction/rewind states are design (`docs/28` §1). |
| Log schema, indices, pragmas, write path | `session.manage` | CODE_PRESENT | §2.2, §4.2, §4.3; S-7…S-14. A SQLite store with one writer exists (`app/tests/core/session.test.ts`, `kernel/tests/integration.rs`); the pragma set and index list are the design target. The index list mirrors a proven reference structure (`file:///data/home/forge/repo-tour/opencode/packages/core/src/session/sql.ts#L86-L215`). |
| Projections and rebuild | `session.manage` | DESIGNED | §2.3, §6.3; S-15…S-20. |
| Inbox and admission | `session.manage` | DESIGNED | §2.4, §6.2; S-21…S-28. The durable-inbox pattern is inherited from a reference implementation and its ordering semantics are adopted as a rule, not as delivered behaviour. |
| Claims and crash semantics | `session.manage` | TESTED + VERIFIED (v0.1 subset) | §2.5, §4.8; S-29…S-37. The kernel's 4-process concurrent-append lock test and the TS sessions suite cover the single-writer and resume paths (`kernel/tests/integration.rs`, `app/tests/core/session.test.ts`); epoch fencing at every rule is design. The write-ahead claim and its preserved-on-shutdown nuance come from a reference implementation (`file:///data/home/forge/repo-tour/opencode/packages/core/src/session/execution.ts#L73-L83`). |
| Message and part storage | `session.manage` | TESTED + VERIFIED (v0.1 subset) | §2.6, §4.2; S-38…S-44. Message and part rows are written and read in v0.1 (`app/tests/core/session.test.ts`); coalescing and the externalisation threshold are design. |
| Fork, checkpoint, rewind (message scope) | **UNKNOWN** (write-scoped session ID, §7.1) | DESIGNED | §2.7; S-45…S-49, S-53. |
| Workspace snapshot capture and restore | `files.write`, `artifact.write` | **UNKNOWN** | S-50, S-51. The design is written and the bounds are fixed, but the reference implementation ships capture **disabled** and restore **not implemented** (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/checkpoint.rs#L36-L58`), and no verified Guard-and-EffectHost restore path exists to design against. HorizonCode therefore refuses the workspace scope and says so; marking this higher would be a false claim. |
| Blob and artifact storage, dedup, GC, pinning | `artifact.write`, `files.write` | DESIGNED | §2.8, §4.5, §6.8; S-54…S-60. The artifact store's quotas and access classes are read from the reference implementation (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/artifact_store.rs`), whose general artifact routes are themselves still marked unavailable upstream. |
| FTS and vector retrieval indices | `memory.read`, `providers.infer` | DESIGNED | §2.9, §4.6, §6.10; S-61…S-66. |
| Migration policy | **UNKNOWN** (write-scoped session ID, §7.1) | DESIGNED | §2.10; S-67…S-69. Transactional constraint handling follows the reference (`file:///data/home/forge/repo-tour/opencode/packages/core/src/database/migration.ts#L130-L133`). |
| Backup, restore, export, import | **UNKNOWN** (write-scoped session ID, §7.1) | DESIGNED | §4.7, §6.5–§6.7; S-80. |
| Quota and eviction | `session.manage` | DESIGNED | §2.10, §4.9; S-70…S-73. |
| Network-filesystem behaviour | `session.manage` | DESIGNED | §4.10; S-74…S-77. Detection table and rationale are drawn from a working reference (`file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-sqlite-journal/src/lib.rs#L1-L13`). |
| Multi-process access | `session.manage` | DESIGNED | §4.11; S-78, S-79. |
| Worktree pool | `worktree.manage` | DESIGNED | §6.9. The reference pool is a bounded, process-local model of the lease lifecycle and is explicitly **not** backed by its OwnerLog and does not create or delete trees (`file:///data/home/forge/repo-tour/horizoncode/kernel/src/worktree_pool.rs#L1-L29`); HorizonCode specifies persistence before dispatch, and that work is not done. |
| Durability matrix | `session.manage` | DESIGNED | §4.8. The guarantees are design commitments; none is measured yet, and the `strict`-versus-`fast` distinction is stated rather than proven on real hardware. |

### 10.1 Open items this document creates

1. **Reserve mechanics**: choose whether the 64 MiB reserve is enforced by `max_page_count` on the database, a filesystem guard, or both, and prove the terminal-write path under a genuinely full filesystem.
2. **Per-host database naming on shared mounts**: settle the `<hostId>` derivation (hostname? machine-id? a random id stored in `host.json`?) and how session ids map across per-host files.
3. **Snapshot scope when enabled**: decide whether workspace capture uses the VCS layer, the artifact store, or both, and what fidelity claim is honest for each.
4. **Index portability**: decide whether vectors are included in archives (size) or always rebuilt (cost), and record the choice in §4.7's manifest fields.
5. **Claim TTL defaults**: ratify 2 s heartbeat and 30 s TTL against real crash-detection latency on laptops that suspend, where a suspended process is neither alive nor gone.
6. **`session delete` evidence reference**: define the shape of the evidence reference that carries unresolved `UNKNOWN` effects into a delete record (§6.1).
7. **Re-home upcaster**: the re-home event is `hz.session.moved` (RC-1, `06` §4.6 G-1); what remains is the upcaster for the superseded `created` + `reattachedFrom` encoding at implementation time (`06` §10 item 1).


