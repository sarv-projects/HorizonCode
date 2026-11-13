# 07 — APIs & Contracts

> **Implementation reality (read first, refreshed 2026-11-12).** Three contracts exist, all in `app/src/contracts.ts`, which is additive-only: the 11-method NDJSON **kernel protocol** (matched by `kernel/src/protocol.rs`), the 7-method NDJSON **server protocol** (`hzcode serve`, `HZ_PROTO = 1`) and the in-process **runtime facade** (`Runtime`, `RuntimeEvent`, `Provider`, `Tool`). **DESIGN ONLY:** `hz.*` Controller catalogue, `hzk` frame ABI, REST/SSE, ACP, MCP **server**, plugin API, SDKs, feature flags, `HZ_ABI` negotiation, `TypedErrorV1`, CT1–CT50. **PARTIAL:** provider `oauth` arm via PKCE/device/refresh (`app/src/core/auth/*`); committed `models-dev.snapshot.json`; explicit `hzcode models refresh` (no background poll). MCP OAuth still DESIGNED. Provenance + K1–K11 at end.

> Every surface HorizonCode exposes, the exact call shapes on each, the versioning rules that keep them compatible, and the contract tests that prove the contracts. `packages/protocol` and `crates/hz_abi` are generated from one schema; this document is the human authority for that schema and for the behaviour behind it.

- **Status:** `DESIGNED` for every surface in this document. Three slices exist and are recorded in `docs/28-implementation-status.md` (RC-13): the 11-method NDJSON kernel protocol, the 7-method NDJSON server protocol of `hzcode serve` and the provider adapters; all three are *narrower and different in framing* from §4.1/§4.2/§4.9 below. Primitives that exist in the pinned ancestor are marked `CODE_PRESENT (ancestor)` with the file that carries them; everything else is `[planned]`.
- **Sources** (read for this document):
  - `source: ../README.md`
  - `source: 01-vision-and-superset.md`
  - `source: 02-decisions.md`
  - `source: _conventions.md`
  - `source: 05-domain-and-schemas.md`
  - source: `kernel/src/protocol.rs` of the ancestor project (not cloned, path not verified) (`HzKernelRpcV1`, `RpcRequestV1`, `RpcResponseV1`, `RpcEventV1`, `RpcControlV1`, `KernelHelloV1`, `TypedErrorV1`, `ErrorCategoryV1`, `RetryClassV1`)
  - source: `kernel/src/rpc_handshake.rs` of the ancestor project (not cloned, path not verified)
  - source: `kernel/src/host_kernel.rs` of the ancestor project (not cloned, path not verified) (dotted operation dispatch: `artifacts.read_range`, `host_run.bind`, `managed_provider.settle`, `managed_message.claim_wake`, `automations.create`, …)
  - source: `kernel/src/effect_host.rs` of the ancestor project (not cloned, path not verified)
  - source: `specs/v2/session.md` of the ancestor project (not cloned, path not verified)
  - `source: audit/pass2/codex-report.md` (code-generated, schema-exported JSON-RPC shared by CLI, app-server and SDKs)
  - `source: audit/pass2/opencode-report.part1.md` and `source: audit/pass2/opencode-report.part3.md` (contract-separated monorepo, ACP server files, plugin surface)
- **Related documents:** `05-domain-and-schemas.md` owns every payload shape named here; `06-events-and-flows.md` owns the event catalog and projector semantics; `12-sessions-state.md` owns the concrete storage layout. On a shape conflict, 05 wins; on a framing conflict, this document wins; on physical layout, 12 wins.

---

## 1. Purpose

This document decides:

1. The **Controller protocol** — the transport-agnostic JSON-RPC surface that every front-end uses, method by method, with params and results (a).
2. The **kernel ABI (`hzk`)** — the request/response contract between the TypeScript runtime and the Rust authority kernel (b).
3. The **HTTP/SSE REST surface** for the server, including paths, status codes and auth modes (c).
4. The **event subscription stream** and its framing (d).
5. The **ACP surface** (agent and client directions) and its capabilities (e).
6. The **MCP server surface** — the tools, resources and prompts HorizonCode exposes to other agents (f).
7. The **plugin API** in both directions, with capability declarations (g).
8. The **SDK surface** for TypeScript, Python, Go and Rust, all generated (h).
9. **Versioning and compatibility** rules for `HZ_PROTO`, `HZ_ABI`, deprecation and generated code (i).
10. The **error model** — codes, retryability and fail-closed classes (j).

Out of scope: the field-level definitions of payload objects, which live in `05-domain-and-schemas.md`; the event type catalogue, which lives in `06-events-and-flows.md`; the on-disk layout, which lives in `12-sessions-state.md`; and CLI exit codes, which are owned by `14-surfaces.md` §2.2 (RC-5) and are referenced, never restated, here. This document names those objects and constrains how they travel; it does not restate their fields.

---

## 2. Rules

Numbered, individually testable. `MUST` violations are contract-test failures (§9).

### 2.1 Transport and framing (all surfaces)

| ID | Rule |
|---|---|
| **C1** | The Controller protocol MUST be JSON-RPC 2.0. Canonical method names MUST be `hz.<noun>.<verb>`. Short aliases (for example `session.create`) MAY exist in CLI and SDK ergonomics and MUST NOT be accepted on the wire. |
| **C2** | Every connection MUST begin with `hz.initialize`, exchanging `{hzProto, hzAbi, features: {required: [], optional: []}, client: {name, version, surface}}`. A peer that requires a feature the other side does not support MUST be rejected with `HZ_UNSUPPORTED_FEATURE` (fail closed); unknown *optional* features MUST be ignored. |
| **C3** | Integers above 2^53 MUST travel as canonical decimal strings, matching `05-domain-and-schemas.md` §4.1. A JSON number in a `u64`/`i64` position MUST be rejected (`Validation`). Canonical-JSON number form - including the refusal of `NaN`, `±Infinity` and unsafe decimal integers - is owned by `docs/05` D40. |
| **C4** | One request per frame. JSON-RPC batch arrays MUST NOT be accepted: per-session ordering and per-request deadlines are contractual, and batching defeats both. |
| **C5** | Every mutating call MUST accept an idempotency key (`idempotencyKey` in params, or the `Idempotency-Key` header on REST). An exact replay MUST return the original result with `replayed: true` and MUST NOT perform the mutation twice. |
| **C6** | Ordering is contractual per session: events carry a gap-free `seq` (doc 05 §2.2 D10) and a transport MUST NOT reorder events of one session. Cross-session ordering MUST NOT be assumed. |
| **C7** | Every request MUST carry a deadline (`deadlineMs`). On expiry the server MUST refuse with `HZ_DEADLINE_EXCEEDED` (`Deadline`, `Never`) rather than continue silently; an effect already admitted MUST still settle and be reported. |
| **C8** | Cancellation is a request, not a completion. `hz.run.cancel` and `hz.session.interrupt` acknowledge intent; the run is complete only when `hz.session.claim.released` is observed. A client MUST NOT treat an acknowledgement as a terminal state. |

> **Additive harness-side contract notes (TUI part 3).** `ProviderEvent` gained `{ type: "thinking"; text }` and `RuntimeEvent` gained `assistant.thinking`, `subagent.start` and `subagent.end` (`app/src/contracts.ts`). All are optional variants: a consumer that does not know them ignores them, a provider without reasoning never emits `thinking`, and an older runtime never emits the subagent boundaries (the TUI falls back to the `agent` tool card). They are facade events, not kernel events: the 44-name kernel catalogue and `canon.rs` are unchanged, and the server relays them as ordinary `session.event`s. See docs/28 rulings 87 and 88 and docs/13 Part 3.

### 2.2 Streaming and subscription

| ID | Rule |
|---|---|
| **C9** | Streamed model deltas (`hz.step.llm.delta`) MUST be treated as ephemeral transport. Durability comes only from `hz.part.updated` at a part's terminal state (doc 05 `PartV1` freeze rule). A client that missed every delta MUST still be able to render the final message from the log. |
| **C10** | The event stream is **at-least-once** with client acknowledgement. A client whose cursor is no longer retained MUST be told `resnapshot_required`; a silent gap MUST NOT happen. |
| **C11** | Backpressure MUST be explicit: a bounded per-subscriber queue plus `page_end` (a page boundary) and `resnapshot_required` (cursor lost). Unbounded buffering MUST NOT be used to absorb a slow subscriber. |
| **C12** | All three framings (JSON-RPC notification, SSE, NDJSON) MUST carry the same event envelope: `{sessionId, seq, tsMs, type, actor, payload, cursor, traceparent?}`. A front-end MUST NOT need framing-specific parsing to obtain an event's identity. |

#### 2.2.1 Adopted insertions (RC-15)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

**1. Stream framing (NF-060):** one session stream carries three frame classes — `sync` (declares `from_seq`/`through_seq` **before** replay), `durable {seq, …}` (seq = log index; persisted), `transient` (no seq; never persisted; liveness only). Unknown frame types MUST be ignored (the envelope is allowed to grow).

**2. Strict pagination:** a paginated read MUST surface "unsupported" as unsupported — never degrade to an empty page; a partial history must never be mistakable for exhaustion.

**3. Feed laws (NF-060):** encode-once, per-connection dropping queues (capacity 4,096), overflow terminates only that connection (`SubscriberOverflow`), encoding failure fails connected queues but keeps the feed available for later connections; **transport errors are not session errors**.

### 2.3 Kernel ABI

| ID | Rule |
|---|---|
| **C13** | `hzk` MUST speak framed canonical MessagePack (`HzKernelRpcV1`) only. A JSON mode MUST NOT exist: the kernel's framing is part of its tamper surface. The v0.1 kernel ships a derived NDJSON encoding with 8 methods (`docs/28`); it is a bootstrap subset, MUST NOT grow, and MUST be replaced by the MessagePack framing before any capability claims `WIRED` on the ABI. |
| **C14** | The first frame on any kernel channel MUST be `hello`; any other first frame MUST close the channel. Application requests MUST be refused until the kernel reports `READY` (the ancestor separates the handshake from startup readiness; HorizonCode keeps that separation). |
| **C15** | Every kernel request MUST carry `ownerEpoch`, `processIncarnation`, `requestId`, `deadlineUnixMs` and `traceId`. A request with a stale `ownerEpoch` or a foreign `processIncarnation` MUST be refused with `HZ_CONFLICT` and MUST NOT be honoured. |
| **C16** | The kernel MUST authenticate the peer at the OS level (Unix peer credentials; Windows named-pipe owner SID/ACL) **before** processing `hello`. A reachable-but-unauthenticated channel MUST be closed, not degraded. |
| **C17** | A kernel response MUST correlate by `requestId` and MUST be idempotent for the same `(serviceId, operation, requestId)`: a retry of the same request MUST NOT execute twice. |
| **C18** | Effect operations MUST form the sequence `effect.authorize → effect.lease_issue → effect.execute → effect.observe → effect.settle`. No step MAY be skipped. `effect.execute` MUST be refused without a live one-use lease whose binding matches the request (doc 05 D21). |
| **C19** | `effect.settle` MUST be terminal per `effectId`. A second settlement with a different terminal value MUST be refused with `HZ_CONFLICT` / category `Corruption` and MUST raise `hz.error.raised`. |
| **C20** | `effect.reconcile` MUST be the only operation that resolves an `UNKNOWN` effect. No other kernel operation MAY set a terminal state for an effect whose terminal state is already `UNKNOWN`. |
| **C21** | `policy.reload` MUST be atomic: either the whole new policy set is active, or none of it is. In-flight leases MUST remain valid for their remaining lifetime. A reload whose incoming digest does not match the expected digest MUST be refused and the previous policy MUST stay in force (fail closed). |
| **C22** | `budget.query` MUST be read-only and MUST NOT consume, reserve or renew budget. A query that changes accounting is a contract violation. |
| **C23** | Every kernel failure MUST be a `TypedErrorV1` carrying `code`, `category` (`ErrorCategoryV1`), `message`, `retryClass` (`RetryClassV1`) and, where useful, `retryAfterMs`, `ownerCursor`, `subjectIds[]`, `details`. A bare string error MUST NOT be returned. |

### 2.4 REST surface

| ID | Rule |
|---|---|
| **C24** | The REST surface MUST be a projection of the Controller protocol: every capability MUST be reachable over both. A capability present on one and missing on the other MUST fail the parity ratchet. |
| **C25** | REST auth modes MUST be exactly `none`, `bearer`, `mtls`, `oidc`, `proxy-trust`, `bridge-jwt`. A listener created with no explicit auth mode MUST default to `bearer` with a token minted at start, stored `0600`, and never written to logs or transcripts. |
| **C26** | A TCP listener MUST bind `127.0.0.1`/`::1` by default. A non-loopback bind MUST require an explicit flag **and** an auth mode other than `none` (fail closed). |
| **C27** | Mutating POSTs MUST require `Idempotency-Key`; a missing key MUST fail with `400 HZ_VALIDATION`. A posture or configuration update MUST require `If-Match` with the current `digest`/`revision`: missing ⇒ `428`, mismatched ⇒ `412` after which the client MUST re-read. |
| **C28** | A lost event cursor MUST produce `410 Gone` with `HZ_CURSOR_RESET` and the latest cursor, after which the client MUST re-snapshot. Serving a gap MUST NOT happen. |
| **C29** | Error bodies MUST be `{error: {code, hzCode, category, retryClass, message, subjectIds, retryAfterMs?, details?}}` and the HTTP status MUST be a deterministic function of `category` (§4.10.3). The same failure MUST NOT map to different statuses on different runs. |

### 2.5 ACP and MCP server

| ID | Rule |
|---|---|
| **C30** | ACP MUST be a first-class surface, not a shim: `session/update` notifications MUST be derived from the same session events, and an ACP permission request MUST map onto a Guard `Ask` decision. ACP MUST NOT introduce a second permission system. |
| **C31** | ACP `session/load` MUST replay from the log and step records only; it MUST NOT re-execute tools, re-call providers, or re-run hooks. |
| **C32** | The MCP server MUST default to a read-only posture and MUST expose a bounded, explicitly enumerated tool set. Every mutating exposed tool MUST require a per-tool grant; a grant for one tool MUST NOT imply another. |
| **C33** | An MCP sampling request (`sampling/createMessage`) MUST be admitted as a `providers.infer` effect against the *caller's* budget and MUST be receipted like any other inference. It MUST NOT borrow the host session's budget silently. |
| **C34** | MCP resource reads MUST honour the artifact's `access` scope and redaction state. A redacted artifact MUST be served redacted or refused (`HZ_FORBIDDEN`), never raw. |

### 2.6 Plugin API

| ID | Rule |
|---|---|
| **C35** | Host↔plugin messages MUST be JSON-RPC 2.0 on a dedicated channel negotiated with the plugin's `apiVersion`. The host MUST be the authority for every effect: a plugin MUST NOT hold a kernel connection of its own. |
| **C36** | A plugin's effective capability grant MUST be the intersection `capabilitiesRequested ∩ session capability ceiling ∩ trust decision`. An effect using an undeclared or ungranted capability MUST be refused with `HZ_CAPABILITY_NOT_GRANTED` and MUST be recorded as a refusal (not silently dropped). |
| **C37** | Hosts MUST validate contributed declarations (tools, commands, agents, skills, providers, hooks) at registration. A manifest with any invalid contribution MUST fail to load as a whole, and the failure MUST name the offending contribution. |
| **C38** | Plugin code MUST run in a sandbox (`worker`, `process` or `wasm`). `mode: none` MUST be permitted only for a signed first-party plugin that the user has explicitly trusted; an unsigned or workspace-provided plugin MUST NOT be granted `mode: none`. |

### 2.7 SDK and code generation

| ID | Rule |
|---|---|
| **C39** | Every SDK method MUST be generated from the protocol schema. A hand-written transport method MUST NOT exist in any SDK: ergonomic helpers MUST live in a clearly named layer above generated code (`sdk/ergonomics/**`) and MUST be listed in the generated-code manifest so the parity ratchet can see them. |
| **C40** | Generated files MUST carry a `DO NOT EDIT` header plus the generation digest of the protocol schema they were produced from. At `hz.initialize`, an SDK whose protocol digest does not match the server's `HZ_PROTO` revision MUST fail closed with `HZ_PROTO_TOO_OLD` or `HZ_UNSUPPORTED_FEATURE` as appropriate. |

### 2.8 Versioning, deprecation, errors

| ID | Rule |
|---|---|
| **C41** | `HZ_PROTO` and `HZ_ABI` MUST be bumped only on a breaking change: removing or renaming a method, an operation or a required field; changing a field's meaning or type; changing a closed authority enum; changing an error code's meaning. Additive changes MUST NOT bump either revision; they MUST be gated by a negotiated feature flag. |
| **C42** | Deprecation MUST be visible for at least one protocol cycle **and** 90 days before removal: the item MUST appear in `deprecated` in the schema, in `hz.initialize`'s advertised features, in the SDK's generated docs, and (where it travels on the wire) as a `deprecated: true` marker plus a `HZ-Deprecated` response header on REST. |
| **C43** | An error code's meaning MUST NOT change without a `HZ_PROTO` bump. New codes MUST be additive and MUST be published in §4.10 before any implementation returns them. |
| **C44** | Unknown optional fields MUST be ignored; unknown fields in a required position MUST fail closed (`Validation`, `Never`); unknown notification types MUST be ignored and MUST NOT be treated as errors. |

---

## 3. Interfaces

One Controller, eight surfaces (ADR-005). The table below is the surface registry; §4 defines each.

| Surface | Transport | Entry point | Protocol id | Owner package | Owner crate | § |
|---|---|---|---|---|---|---|
| Controller protocol | JSON-RPC 2.0 over stdio / UDS / TCP / WebSocket | in-process `Controller` service | `HZ_PROTO=1` | `@horizoncode/core` (+ `@horizoncode/protocol` schemas) | — | §4.1 |
| Kernel ABI | framed canonical MessagePack over UDS (named pipe on Windows) | `hzk` process | `HZ_ABI=1` | `@horizoncode/kernel-client` | `hz_kernel`, `hz_abi` | §4.2 |
| REST + SSE | HTTP/1.1 (+ HTTP/2 when TLS) | `hzcode serve` `[planned]` | `HZ_PROTO=1` | `@horizoncode/server` | — | §4.3, §4.4 |
| Event subscription | JSON-RPC notifications / SSE / NDJSON | any Controller connection | `HZ_PROTO=1` | `@horizoncode/core` | — | §4.4 |
| ACP (agent and client) | JSON-RPC 2.0 over stdio | `hzcode acp` `[planned]` | ACP + `HZ_PROTO=1` | `@horizoncode/acp` | — | §4.5 |
| MCP server | JSON-RPC 2.0 over stdio / HTTP (streamable) | `hzcode mcp serve` `[planned]` | MCP `2025-06-18`+ | `@horizoncode/mcp` | — | §4.6 |
| MCP client | JSON-RPC 2.0 over stdio / HTTP / SSE / WS | configured servers | MCP + per-server capabilities | `@horizoncode/mcp` | — | §4.6.5 |
| Plugin API | JSON-RPC 2.0 over a dedicated IPC channel | plugin host | `hzplugin/1` | `@horizoncode/plugin` | — | §4.7 |
| SDKs | generated clients | `@horizoncode/sdk`, `-python`, `-go`, `-rust` | `HZ_PROTO=1` | `@horizoncode/sdk*` | `hz_sdk` (name registered; code `[planned]`) | §4.8 |

Cross-cutting interfaces used by every surface: `hz.initialize` (§4.1.2), `hz.subscribe` (§4.4.1), the typed error carrier (§4.10), and the `hz://` resource resolver (`05-domain-and-schemas.md` §4.2).

---

## 4. Data

### 4.1 (a) The Controller protocol

> **DESIGN ONLY: NOT IMPLEMENTED.** The shipped server protocol has 7 methods (`server.hello`, `session.create`, `session.list`, `session.subscribe`, `session.prompt`, `session.rewind`, `session.fork`) and none of the `hz.*` names below. See the Provenance section and deferral note K7.

#### 4.1.1 Envelope

Every request and notification is JSON-RPC 2.0 with one HorizonCode extension: an optional `hz` metadata object. `params` carries the method's typed payload; `result` carries the typed result.

```json
{ "jsonrpc": "2.0", "id": "c-1", "method": "hz.session.submit",
  "params": { "sessionId": "sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1", "prompt": { "text": "fix the flaky test" },
              "delivery": "steer", "idempotencyKey": "u-7f2c", "deadlineMs": 30000 },
  "hz": { "hzProto": 1, "features": ["session.verify", "subscribe.replay"], "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" } }
```

Rules carried by the envelope: `deadlineMs` (C7), `idempotencyKey` (C5), `features` (C2), `traceId` (W3C traceparent propagation into effects and receipts).

#### 4.1.2 Method catalogue

**Bootstrap and control**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.initialize` | `{hzProto, hzAbi, features{required[],optional[]}, client{name,version,surface}, workspaceRoot?}` | `{hzProto, hzAbi, features{enabled[],unavailable[],deprecated[]}, server{version,buildDigest}, kernel{state, buildDigest, ownerEpoch, sandboxProbe}, modes[]}` | MUST be first (C2); feature names are the closed registry in §4.1.5; `kernel.state ∈ full\|degraded_read_only\|degraded_unaccounted\|refused` — the four states of `03-hld.md` §6.2 |
| `hz.ping` | `{nonce}` | `{nonce, nowMs, ownerEpoch}` | liveness only; MUST NOT be used as a health check for the kernel |
| `hz.shutdown` | `{drain: bool, mode: OneOf{graceful,immediate}}` | `{drained: bool, activeSessions[]}` | graceful waits for claims to release |
| `hz.subscribe` | see §4.4.1 | `{subscriptionId, cursor, replaying: bool}` | |
| `hz.unsubscribe` | `{subscriptionId}` | `{removed: bool}` | |
| `hz.ack` | `{subscriptionId, through: cursor}` | `{acked: bool}` | at-least-once delivery (C10) |

**Session lifecycle**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.session.create` | `{kind?, title?, cwd?, agentProfileId?, parentSessionId?, posture{preset?,sandboxMode?,approvalPolicy?}?, configOverrides?, workspacesMode?, idempotencyKey}` | `{session: SessionV1, posture: SessionPostureV1}` | posture widening requires an interactive confirmation token |
| `hz.session.get` | `{sessionId, include?[]}` | `{session, posture?, config?, claim?}` | |
| `hz.session.list` | `{filter{state?,kind?,rootId?,tag?,updatedAfterMs?}, cursor?, limit?}` | `{sessions[], nextCursor?}` | paginated; `limit` ≤ 200 |
| `hz.session.update` | `{sessionId, title?, tags?, visibility?, ifMatch: digest}` | `{session}` | `ifMatch` mandatory (C27 analog over the protocol: `HZ_PRECONDITION_FAILED` when mismatched) |
| `hz.session.archive` | `{sessionId, reason?}` | `{session}` | refuses while a claim is held |
| `hz.session.delete` | `{sessionId, mode: OneOf{soft,hard}, confirmToken?}` | `{deleted: bool, tombstoneId}` | `hard` requires a token and leaves a tombstone (doc 05 D13) |
| `hz.session.move` | `{sessionId, target: {workspaceId: string, directory: Path}, confirmToken?}` | `{session, movedFrom: {workspaceId: string, directory: Path}}` | re-homes a session; emits `hz.session.moved` in the **destination** log with the same `sessionId` (RC-1); refuses while a claim is held and requires a token when the destination directory differs |
| `hz.session.fork` | `{sessionId, atSeq?, checkpointId?, title?, copyWorktree?}` | `{session: SessionV1}` | emits `hz.session.forked`; history up to the fork point is copied, never rewritten |
| `hz.session.tree` | `{sessionId, includeCosts?}` | `{nodes[]{sessionId,parentId,kind,state,usage,cost}, rollup{usage,cost}, budgets[]}` | the authority and cost rollup for a whole tree (ADR-016 consequence) |
| `hz.session.export` | `{sessionId, format: OneOf{jsonl,markdown,bundle,otlp}, includeReceipts?}` | `{artifactRef?, bytes, mediaType}` | a bundle is an `evidence_bundle` artifact |
| `hz.session.verify` | `{sessionId, claims?[]{claimId,text,targetRef?}, mode: OneOf{claims,full}}` | `{verdict: OneOf{pass,pass_with_caveats,fail,unknown}, loweredClaims[]{claimId,reason,contradictingReceiptIds[]}, openUnknowns[]{effectId,receiptId,reconciliationId?}, evidenceDigest}` | the evidence gate; can only lower (P2) |
| `hz.session.posture.update` | `{sessionId, preset?, sandboxMode?, approvalPolicy?, networkPolicy?, capabilityCeilingAdd[]?, confirmToken?, justification?, ifMatch}` | `{posture: SessionPostureV1}` | a widening requires `confirmToken` from an interactive human; emits `hz.policy.revision.changed` |
| `hz.session.config.update` | `{sessionId, patch, ifMatch}` | `{config: SessionConfigV1, diagnostics[]}` | the patch is re-merged through the lattice; widening is refused with a diagnostic |
| `hz.session.compact` | `{sessionId, strategy?, keepTailTokens?, reason}` | `{compactionPartId, tokensBefore, tokensAfter, lossiness}` | explicit compaction; the automatic trigger is separate |
| `hz.session.checkpoint.create` | `{sessionId, label?, reason?, includeSnapshot?}` | `{checkpoint: CheckpointV1, snapshot?: SnapshotV1}` | |
| `hz.session.rewind` | `{sessionId, checkpointId, scope, dryRun, approvalToken?}` | `{preview?: RewindPreview, applied?: bool, receiptId?, checkpoint}` | `dryRun` MUST be available for every scope; `unknownsOpen > 0` ⇒ refused (doc 05 `CheckpointV1` invariant) |

**Input admission and run control**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.session.submit` | `{sessionId, prompt{text,attachments?,contextRefs?,flags?}, delivery?: OneOf{auto,steer,queue}, priority?, requestedResume?: bool, idempotencyKey}` | `{admission: InputAdmissionV1, receiptDigest}` | the canonical admission call; `auto` resolves by host policy |
| `hz.session.steer` | same, `delivery` MUST be `steer` | same | promoted only at a step boundary |
| `hz.session.queue` | same, `delivery` MUST be `queue` | same | drains after the current claim |
| `hz.session.inbox.list` | `{sessionId, state?, cursor?, limit?}` | `{admissions[], nextCursor?}` | |
| `hz.session.claim.list` | `{sessionId, state?, limit?}` | `{claims[]}` | |
| `hz.session.resume` | `{sessionId, fromClaimId?}` | `{claim: ExecutionClaimV1, resumedFrom?: Id, stepsPlanned?}` | resumes a claim left `held` by a dead process |
| `hz.session.interrupt` | `{sessionId, mode: OneOf{graceful,hard}}` | `{acknowledged: bool, claimId?}` | completion is the release event (C8) |
| `hz.session.cancel` | `{sessionId, scope: OneOf{turn,session,tree}, mode}` | `{acknowledged, cancelledSessionIds[]}` | cancels the whole subtree for `scope=tree` |
| `hz.run.status` | `{sessionId?\|runId?, includeTree?}` | `{state, claimId?, stepIndex?, phase?, currentToolCallId?, waitingOn?{kind,approvalId?,agentSessionId?}, budgets[]}` | |
| `hz.run.cancel` | `{runId\|sessionId, scope, mode, reason?}` | `{acknowledged, cancelledSessionIds[]}` | |
| `hz.step.list` | `{sessionId, fromIndex?, limit?}` | `{steps[]}` | |
| `hz.step.get` | `{stepId, include?[]{record,events,usage,cost}}` | `{step, record?, events?, usage?, cost?}` | `record` enables offline replay |
| `hz.session.message.list` | `{sessionId, fromSeq?, limit?, includeParts?}` | `{messages[], nextSeq?}` | |
| `hz.session.part.list` | `{sessionId, messageId?, types?, afterSeq?, limit?}` | `{parts[], nextSeq?}` | |

**Approvals**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.approval.list` | `{sessionId?, state?: OneOf{pending, answered, expired}, cursor?, limit?}` | `{approvals[]{approvalId, sessionId, toolCallId, effectId, capabilityId, prompt, previewRef?, expiresAtMs, originKind}, nextCursor?}` | |
| `hz.approval.respond` | `{approvalId, decision: OneOf{allow_once, allow_scoped, allow_session, deny}, scope?, justification?, confirmToken?}` | `{toolCallId, decision, receiptId?, scopeExpiresAtMs?}` | `allow_scoped`/`allow_session` create a `ToolPermissionV1` with `origin=runtime_approval`; `allow_once` is one-use and bound to `argumentsDigest` |
| `hz.approve` | `{approvalId, scope?}` | as `hz.approval.respond` with `decision=allow_once\|allow_scoped` | convenience alias for scripts; identical semantics |
| `hz.deny` | `{approvalId, justification?}` | as `hz.approval.respond` with `decision=deny` | convenience alias |

Two rules bound this group. (1) `hz.permission.asked` (and therefore an `hz.approval.*` entry) exists **only** where an answer could change the outcome: a policy or posture `deny` is decided and recorded as `hz.effect.decision.made` with its reason code and MUST NOT produce a pending approval (RC-6). (2) An approval answer is attributed to the answering `PrincipalRef`; only a `human` principal may answer, so an agent-, plugin- or MCP-originated caller MUST be refused with `HZ_FORBIDDEN` (doc 05 D38 analog; §7.3).

**Tools**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.tool.list` | `{sessionId?, includeDeferred?, includeSchemas?}` | `{tools[]{name, id, revision, capabilityId, effectClass, readOnlyClass, concurrencyClass, descriptionDigest, cacheKey, deferred, deprecated}, catalogDigest}` | the effective catalog for a session; `catalogDigest` feeds the context prefix |
| `hz.tool.describe` | `{name\|id, sessionId?}` | `{declaration: ToolDeclarationV1, digest}` | |
| `hz.tool.search` | `{query, sessionId?, limit?}` | `{matches[]{name, id, capabilityId, score}, catalogDigest}` | deferred discovery; not a substitute for policy |
| `hz.tool.invoke` | `{sessionId, name, args, callId?, background?, deadlineMs, idempotencyKey}` | `{toolCallId, status, resultClass, output, observations, receipts[], artifacts[]}` | a direct invocation uses origin `UserAction` (an authenticated human), never `SessionBatch` |
| `hz.tool.cancel` | `{toolCallId, mode}` | `{status}` | only for `supportsBackground` tools |

**Agents and teams**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.agent.list` | `{parentSessionId?, teamId?, state?, limit?}` | `{agents[]{sessionId, profileId, kind, state, depth, budgetRemaining, lastHeartbeatAtMs}}` | |
| `hz.agent.get` | `{sessionId}` | `{session, profile, grantGist{capabilityCount, narrowingDigest}, budget, resultContract}` | the full capability list requires `session.manage` |
| `hz.agent.spawn` | `{parentSessionId, kind, objective, agentProfileId, capabilityGrant?{capabilities[],toolAllowlist[]}, budgetLimits?, limits?, contextCapsule?{sources[],includes[],tokenBudget}, resultContract?, isolation?, joinPolicy?, failurePolicy?, idempotencyKey}` | `{session: SessionV1, spec: SubagentSpecV1, specDigest}` | a widening grant or an over-budget request MUST be rejected before the child exists (ADR-016) |
| `hz.agent.cancel` | `{sessionId, mode, cascade?}` | `{cancelledSessionIds[]}` | |
| `hz.agent.wait` | `{sessionIds[], until: OneOf{any,all}, timeoutMs}` | `{settled[]{sessionId,state,resultSummary?}, timedOut: bool}` | waiting MUST NOT consume budget |
| `hz.agent.yield` | `{sessionId, reason, resumeHint?}` | `{accepted: bool}` | a child yields to let a parent steer |
| `hz.agent.message.send` | `{fromSessionId?, teamId?, toSessionId?, kind, subject, body, payloadRef?, ackRequired?, deadlineMs?, idempotencyKey}` | `{messageId, ordering, deliveryState}` | durable kinds are persisted (doc 05 `AgentMessageV1`) |
| `hz.agent.message.list` | `{teamId?, threadId?, sessionId?, afterOrdering?, limit?}` | `{messages[], nextOrdering?}` | |
| `hz.team.create` | `{leadSessionId, memberSpecs[]{objective, agentProfileId, capabilityGrant?, budgetLimits?, role}, policy{maxMembers,maxDepth}, idempotencyKey}` | `{team: TeamStateV1, memberSessionIds[]}` | every member goes through `hz.agent.spawn` |
| `hz.team.state` | `{teamId}` | `{team: TeamStateV1}` | |
| `hz.team.list` | `{rootSessionId?, status?, limit?}` | `{teams[]}` | |
| `hz.team.delete` | `{teamId, mode: OneOf{drain,cancel}, cascade}` | `{deleted: bool, cancelledSessionIds[]}` | `drain` waits for members to finish their current step |

**Memory and learning**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.memory.recall` | `{query, sessionId?, tiers?, scope?, k?, minConfidence?, includeProvenance?}` | `{records[], scores[], ledgerEntryId}` | recall is recorded in the context ledger so injection is auditable |
| `hz.memory.retain` | `{tier, scope, subject, content, evidenceRefs?, sharing?, idempotencyKey}` | `{memoryId, reviewState, redaction}` | a record failing redaction MUST be refused |
| `hz.memory.edit` | `{memoryId, content?, lifecycle?, ifMatch}` | `{record}` | |
| `hz.memory.forget` | `{memoryIds[], mode: OneOf{tombstone,expire}}` | `{forgotten[]}` | tombstone keeps provenance for audit |
| `hz.memory.reflect` | `{scope, window{fromMs,toMs}, budgetLimits?, policy: OneOf{propose_only}}` | `{proposalIds[], distilledCount, rejectedCount}` | `propose_only` is the only policy: reflection MUST NOT write semantic memory directly (ADR-010) |
| `hz.memory.list` | `{tier?, scope?, reviewState?, cursor?, limit?}` | `{records[], nextCursor?}` | |
| `hz.memory.export` | `{scope, format: OneOf{jsonl,bundle}}` | `{artifactRef}` | exported bundles MUST preserve provenance |
| `hz.learn.trajectory.list` | `{sessionId?, suite?, sinceMs?, limit?}` | `{trajectories[]{trajectoryId, sessionId, steps, receipts, bytes, recordedAtMs}}` | |
| `hz.learn.trajectory.get` | `{trajectoryId, includeEventDigests?}` | `{trajectory, manifest, integrity{verified, firstSeq, lastSeq}}` | |
| `hz.learn.eval.run` | `{evalCaseIds[]\|suite, budgetLimits?, modelOverride?, networkPolicy?, record: bool}` | `{runId, status, results[]{evalCaseId, passed, metrics[], trajectoryId?}, verdict}` | an eval runs in an isolated worktree with its own budget |
| `hz.learn.eval.list` | `{suite?, status?, sinceMs?, limit?}` | `{runs[]}` | |
| `hz.learn.proposal.list` | `{kind?, status?, scope?, cursor?, limit?}` | `{proposals[], nextCursor?}` | |
| `hz.learn.proposal.review` | `{proposalId, decision: OneOf{approve,reject,request_changes}, comment?, ifMatch}` | `{proposal, approvalsRemaining}` | approvals MUST come from `human` principals (doc 05 D38) |
| `hz.learn.proposal.apply` | `{proposalId, approvalToken, canary?, ifMatch}` | `{applied: true, revision, rollbackRef?}` | refuses when an evidence eval is quarantined or failing |

**Kernel-facing (authority observability)**

| Method | Params | Result | Notes |
|---|---|---|---|
| `hz.kernel.status` | `{}` | `{state, abi, proto, buildDigest, ownerEpoch, sandboxProbe[]{dimension,strength,residual}, policy{revision,digest,loadedAtMs}, degradations[]{kind,detail,since}}` | the single place a front-end learns why something is refused |
| `hz.kernel.policy.explain` | `{action, args, originKind, sessionId, resource?}` | `{decision, reasonCode, matchedRules[], guarantees{requested,granted,residuals}, wouldAsk: bool, narrowingDiagnostics[]}` | dry run: MUST NOT create a decision, lease or receipt |
| `hz.kernel.policy.reload` | `{expectedDigest?, source?}` | `{policyRevision, digest, loadedAtMs, changedRuleCount}` | atomic; mismatch ⇒ refused, old policy stays (C21) |
| `hz.kernel.receipt.get` | `{receiptId\|effectId}` | `{receipt: EffectReceiptV1, chain{prevReceiptDigest, verified}}` | |
| `hz.kernel.receipt.list` | `{sessionId?, capabilityId?, terminal?, cursor?, limit?}` | `{receipts[], nextCursor?}` | |
| `hz.kernel.receipt.verify` | `{fromSequence?, toSequence?, sessionId?}` | `{verified: bool, brokenAt?: Id, checked: u32, headDigest}` | verifies the hash chain; a broken chain ⇒ `verified: false` plus a raised error |
| `hz.kernel.reconcile` | `{effectId, method, budgetLimits?, dryRun}` | `{record: ReconciliationRecordV1, resultingAction, newReceiptId?}` | the only path that resolves `UNKNOWN` (C20) |
| `hz.kernel.budget.query` | `{scopeRef, includeChildren?}` | `{budget: BudgetV1, report?: BudgetReportV1}` | read-only (C22) |
| `hz.kernel.trusted_state.list` | `{kind?, scope?, includeRevoked?}` | `{states[]{stateId, kind, subject, verification, createdAtMs, revoked}}` | |
| `hz.kernel.sandbox.probe` | `{dimensions?}` | `{probeId, results[]{dimension, strength, residual, evidenceDigest}}` | probing is a read effect and MUST be receipted when it spawns a process |
| `hz.worktree.list` | `{state?, ownerSessionId?, poolId?}` | `{worktrees[]}` | |
| `hz.worktree.acquire` | `{kind, baseRevision?, exclusive?, cleanupPolicy?, ownerSessionId, idempotencyKey}` | `{worktree: WorktreeV1, receiptId}` | acquisition is a receipted effect |
| `hz.worktree.release` | `{worktreeId, discardChanges?, mode: OneOf{keep,discard,reclaim}}` | `{worktree, receiptId?}` | `discard` requires an approval |
| `hz.worktree.reclaim` | `{worktreeId, force?}` | `{worktree, receiptId}` | refuses a dirty worktree without an explicit force + approval |

#### 4.1.3 Method-level invariants

1. Every method that mutates MUST be idempotent under `idempotencyKey` (C5).
2. Every method that can fail with an authority reason MUST return the typed error carrier rather than a generic message (§4.10).
3. `hz.*.list` methods MUST be cursored and MUST NOT scan unbounded sets.
4. `hz.tool.invoke` MUST be the only way a non-model client runs a tool, and its origin is `UserAction` — it is the one path that can legitimately present human authority, and only for an authenticated principal.
5. A method that can be answered only after an effect settles MUST NOT return before the settlement; if the settlement is `UNKNOWN`, the result MUST carry `reconciliationRequired: true` (never a fabricated success).
6. Every method in this catalogue MUST have a REST projection (C24) and a generated SDK method (C39); the parity ratchet compares the three lists.

#### 4.1.4 Worked exchanges (Controller protocol)

All examples use the ids and digests from `05-domain-and-schemas.md` §4.2/D3. Digests are shortened with `…` **for readability only**; on the wire a partial digest MUST be rejected (doc 05 D3).

**Example 1 — `hz.initialize` (capability and feature negotiation, C2/C40)**

```json
--> {"jsonrpc":"2.0","id":"i-1","method":"hz.initialize","params":{
      "hzProto":1,"hzAbi":1,
      "features":{"required":["subscribe.replay"],"optional":["acp.sessionModes","mcp.server"]},
      "client":{"name":"hzcode-tui","version":"0.1.0","surface":"tui"},
      "workspaceRoot":"/home/dev/project"}}
<-- {"jsonrpc":"2.0","id":"i-1","result":{
      "hzProto":1,"hzAbi":1,
      "features":{"enabled":["subscribe.replay","mcp.server","learn.proposals"],
                  "unavailable":["acp.sessionModes"],
                  "deprecated":[{"item":"hz.memory.retain","since":"0.1.0","removalProto":2,"replacement":"hz.memory.retain@2"}]},
      "server":{"version":"0.1.0","buildDigest":"blake3:9f2a…"},
      "kernel":{"state":"full","buildDigest":"blake3:5c71…","ownerEpoch":"42",
                "sandboxProbe":[{"dimension":"fs.isolation","strength":"enforced"},
                                 {"dimension":"net.deny","strength":"partial","residual":"udp-egress-unverified"}]},
      "modes":["agent","degraded_read_only"]}}
```

Note: `acp.sessionModes` is requested as *optional* and reported unavailable, so the connection proceeds. Had it been in `required`, the server would have answered with error `-32010 HZ_UNSUPPORTED_FEATURE` and closed (fail closed).

**Example 2 — `hz.session.create` (posture is asked for, not granted)**

```json
--> {"jsonrpc":"2.0","id":"s-1","method":"hz.session.create","params":{
      "kind":"root","title":"fix flaky retry test","cwd":"/home/dev/project",
      "agentProfileId":"prf_act","posture":{"preset":"ask-for-approval"},
      "idempotencyKey":"create-1"}}
<-- {"jsonrpc":"2.0","id":"s-1","result":{
      "session":{"id":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","kind":"root","rootId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
                 "state":"idle","workspaceRootDigest":"blake3:1b90…","cwd":"/home/dev/project",
                 "agentProfileRef":{"id":"prf_act","revision":"3","digest":"blake3:77ab…"},
                 "postureRef":{"revision":"1","digest":"blake3:e0d4…"},
                 "configRef":{"revision":"1","effectiveConfigDigest":"blake3:c41f…"},
                 "openUnknownEffectCount":"0","createdAtMs":"1762439400123","lastSeq":"0"},
      "posture":{"revision":"1","sandboxMode":"workspace-write","approvalPolicy":"on-request",
                 "preset":"ask-for-approval","capabilityCeiling":["files.read","files.write","files.patch","terminal.run","providers.infer","memory.read","language.symbols"],
                 "networkPolicy":"none","origin":"user-config","digest":"blake3:e0d4…","ownerEpoch":"42"}}}
```

**Example 3 — `hz.session.submit` (durable admission, then execution)**

```json
--> {"jsonrpc":"2.0","id":"p-1","method":"hz.session.submit","params":{
      "sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "prompt":{"text":"make the retry test deterministic","flags":{"planMode":false}},
      "delivery":"auto","priority":100,"requestedResume":true,"idempotencyKey":"u-7f2c"}}
<-- {"jsonrpc":"2.0","id":"p-1","result":{
      "admission":{"id":"adm_01J9Z8R0AA…","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
                   "promptId":"prm_01J9Z8R0AB…","delivery":"steer","state":"admitted",
                   "requestedResume":true,"admittedAtMs":"1762439401450","admittedSeq":"1",
                   "dedupeKey":"u-7f2c"},
      "receiptDigest":"blake3:aa10…","replayed":false}}
```

Replaying the identical call (`idempotencyKey` and prompt digest unchanged) returns the same `receiptDigest` with `"replayed": true` and creates no second row. Changing the text with the same key returns:

```json
<-- {"jsonrpc":"2.0","id":"p-1","error":{"code":-32004,"message":"idempotency key reused with different payload",
      "data":{"hzCode":"HZ_CONFLICT","category":"Conflict","retryClass":"RetryWithNewId",
              "subjectIds":["prm_01J9Z8R0AB…"],"details":{"dedupeKey":"u-7f2c","expectedDigest":"blake3:aa10…","actualDigest":"blake3:bb73…"}}}}
```

**Example 4 — approval round trip (Guard `Ask` → human → lease)**

```json
<-- {"jsonrpc":"2.0","method":"hz.event","params":{"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","seq":"14",
      "tsMs":"1762439410210","type":"hz.permission.asked","actor":{"kind":"agent","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1"},
      "payload":{"approvalId":"apr_01J9Z8T2Q0…","toolCallId":"tcl_01J9Z8T2P9…","capabilityId":"terminal.run",
                 "effectClass":"process","reasonCode":"asked_by_policy","expiresAtMs":"1762439470210",
                 "prompt":"Run tests? `bun test test/retry.test.ts` (writes 0 files outside the worktree)",
                 "previewRef":"sha256:1f0c…","originKind":"SessionBatch"},
      "cursor":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:14"}}

--> {"jsonrpc":"2.0","id":"a-1","method":"hz.approval.respond","params":{
      "approvalId":"apr_01J9Z8T2Q0…","decision":"allow_once","justification":"expected"}}
<-- {"jsonrpc":"2.0","id":"a-1","result":{"toolCallId":"tcl_01J9Z8T2P9…","decision":"allow_once",
      "receiptId":"rcp_01J9Z8T4M1…"}}
```

The subsequent receipt carries the decision that actually let it run:

```json
{"receiptId":"rcp_01J9Z8T4M1…","effectId":"eff_01J9Z8T2Q1…","decisionId":"dsc_01J9Z8T2Q2…","leaseId":"lse_01J9Z8T3A7…",
 "capabilityId":"terminal.run","origin":{"kind":"SessionBatch","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1"},
 "terminal":"SUCCEEDED","observation":{"kind":"exit_code","value":"0","digest":"blake3:6d21…","source":"host_process"},
 "exitCode":0,"durationMs":"8421","policyDigest":"blake3:b7c0…","postureDigest":"blake3:e0d4…",
 "hashChain":{"prevReceiptDigest":"blake3:0d55…","chainDigest":"blake3:9e12…","sequence":"41"},"reconciliationRequired":false}
```

**Example 5 — a denied tool invocation (typed error, not a failure message)**

```json
--> {"jsonrpc":"2.0","id":"t-1","method":"hz.tool.invoke","params":{
      "sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","name":"write",
      "args":{"path":"/etc/hosts","content":"127.0.0.1 example.com"},"idempotencyKey":"t-9"}}
<-- {"jsonrpc":"2.0","id":"t-1","error":{"code":-32013,"message":"effect denied by policy",
      "data":{"hzCode":"HZ_POLICY_DENIED","category":"Authorization","retryClass":"Never",
              "subjectIds":["eff_01J9Z8U0R2…","dsc_01J9Z8U0R3…"],
              "details":{"reasonCode":"denied_by_resource","capabilityId":"files.write",
                         "normalizedAction":"files.write","resourceTarget":"/etc/hosts",
                         "receiptId":"rcp_01J9Z8U0R4…"}}}}
```

The denial still settled into a receipt with `terminal: "DENIED"`, because a denial is an outcome worth auditing.

**Example 6 — `hz.kernel.policy.explain` (dry run: no decision, no lease, no receipt)**

```json
--> {"jsonrpc":"2.0","id":"x-1","method":"hz.kernel.policy.explain","params":{
      "action":"terminal.run","originKind":"SessionBatch","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "args":{"argv":["rm","-rf","build"]},"resource":{"target":"./build"}}}
<-- {"jsonrpc":"2.0","id":"x-1","result":{
      "decision":"Ask","reasonCode":"asked_by_policy","wouldAsk":true,
      "matchedRules":[{"ruleId":"rul_01J8…","layer":"user","decision":"ask","note":"Shell(rm *)"},
                      {"ruleId":"rul_01J7…","layer":"workspace","decision":"allow","note":"workspace tried to allow; capped at ask by ceiling"}],
      "guarantees":{"requested":["fs.isolation"],"granted":["fs.isolation"],"residuals":[]},
      "narrowingDiagnostics":[{"path":"/home/dev/project/.hz/config.jsonc","scope":"workspace","key":"permissions[3].decision",
                               "requested":"allow","effective":"ask","reason":"narrowed_by_user","atMs":"1762439415000"}]}}
```

**Example 7 — `hz.kernel.reconcile` (the only path out of `UNKNOWN`)**

```json
--> {"jsonrpc":"2.0","id":"r-1","method":"hz.kernel.reconcile","params":{
      "effectId":"eff_01J9Z9A1X0…","method":"filesystem_probe","dryRun":false,"budgetLimits":{"maxSteps":3}}}
<-- {"jsonrpc":"2.0","id":"r-1","result":{
      "record":{"recordId":"rcn_01J9Z9A5C2…","effectId":"eff_01J9Z9A1X0…","receiptId":"rcp_01J9Z9A1Y9…",
                "attempt":"1","method":"filesystem_probe","conclusion":"confirmed_success",
                "findings":{"observedState":"fully_applied",
                            "evidence":[{"kind":"file_digest","ref":"src/http/retry.ts","digest":"blake3:41ae…"}],"residuals":[]},
                "resultingAction":"mark_succeeded","decidedBy":"orchestrator","decidedAtMs":"1762439422880"},
      "resultingAction":"mark_succeeded"}}
```

`mark_succeeded` records a new reconciliation outcome; it MUST NOT rewrite the original `UNKNOWN` receipt (doc 05 D18/D19).

**Example 8 — `hz.agent.spawn` (capability narrowing is enforced, not advised)**

```json
--> {"jsonrpc":"2.0","id":"g-1","method":"hz.agent.spawn","params":{
      "parentSessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","kind":"read_only_task",
      "objective":"find why retry.test.ts is flaky","agentProfileId":"prf_research",
      "capabilityGrant":{"capabilities":["files.read","language.symbols"]},
      "budgetLimits":{"maxSteps":12,"maxOutputTokens":"120000","maxUsdMicros":"250000"},
      "contextCapsule":{"sources":["git:HEAD","test/retry.test.ts"],"tokenBudget":"12000"},
      "resultContract":{"expected":"report"},"isolation":"own_worktree","joinPolicy":"await","idempotencyKey":"sp-1"}}
<-- {"jsonrpc":"2.0","id":"g-1","result":{
      "session":{"id":"sess_01J9Z9B0D4…","kind":"read_only_task","parentId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
                 "state":"idle","openUnknownEffectCount":"0"},
      "spec":{"id":"sub_01J9Z9B0D3…","parentReceiptId":"rcp_01J9Z8T4M1…",
               "capabilityGrant":{"capabilities":["files.read","language.symbols"],"narrowingDigest":"blake3:2cf0…"},
               "isolation":"own_worktree","worktreeRef":"wkt_01J9Z9B0D5…"},
      "specDigest":"blake3:88d1…"}}
```

A request adding `files.write` to the same grant is rejected **before** the child session exists:

```json
<-- {"jsonrpc":"2.0","id":"g-1","error":{"code":-32014,"message":"capability grant is not a subset of the parent ceiling",
      "data":{"hzCode":"HZ_CAPABILITY_NOT_GRANTED","category":"Capability","retryClass":"Never",
              "details":{"attempted":"files.write","parentCeiling":["files.read","terminal.run","providers.infer","language.symbols"]}}}}
```

**Example 9 — `hz.session.verify` (evidence can only lower a claim)**

```json
--> {"jsonrpc":"2.0","id":"v-1","method":"hz.session.verify","params":{
      "sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","mode":"full"}}
<-- {"jsonrpc":"2.0","id":"v-1","result":{
      "verdict":"fail",
      "loweredClaims":[{"claimId":"clm_1","reason":"no_receipt_for_claimed_test_run",
                        "contradictingReceiptIds":[]},
                       {"claimId":"clm_2","reason":"receipt_contradicts_claim",
                        "contradictingReceiptIds":["rcp_01J9Z8T4M1…"]}],
      "openUnknowns":[{"effectId":"eff_01J9Z9A1X0…","receiptId":"rcp_01J9Z9A1Y9…","reconciliationId":"rcn_01J9Z9A5C2…"}],
      "evidenceDigest":"blake3:70ff…"}}
```

#### 4.1.5 Feature-flag registry (C2/C41/C42)

The canonical feature names negotiated by `hz.initialize`, published here under `_conventions.md` §11 RC-9 (which names §4.1.2 — the method catalogue that negotiates the flags — as the owning section of this document; the registry table itself is §4.1.5). A name that is not listed here MUST be rejected at negotiation — refused for a `required[]` entry, reported in `unavailable[]` and otherwise ignored for an `optional[]` entry.

RC-9 fixes the columns: name, since-revision, negotiation class (required/optional), what enables it, and deprecation state.

`Class` is `required-capable` (a peer MAY list the feature in `required[]`; the other side MUST then have it or the connection is refused — C2) or `optional-only` (a peer MUST NOT rely on it as required; absence is a normal, reported condition, and the surface that depends on it MUST NOT advertise itself — the ACP rule in §4.5.3 is the model for that posture).

**`standard` deprecation state** (the value used in the last column below): the feature is active at this revision; adding a feature name, or widening what it gates, is additive and MUST NOT bump `HZ_PROTO` (C41); removing or re-meaning one is a breaking change that MUST bump `HZ_PROTO` **and** MUST be advertised in `features.deprecated[]` as `{item, since, removalProto, replacement}` for at least one protocol cycle and 90 days before removal (C42). The column value for a feature that is itself deprecated would name its replacement and its `removalProto`.

| Feature | Since | Class | What enables | Deprecation state |
|---|---|---|---|---|
| `session.verify` | `HZ_PROTO 1` | `required-capable` | `hz.session.verify`, verdicts, the evidence gate | active; `standard` |
| `session.rewind` | `1` | `required-capable` | `hz.session.rewind` (dry-run, checkpoint semantics) | standard |
| `session.fork` | `1` | `optional-only` | `hz.session.fork` | standard |
| `session.move` | `1` | `optional-only` | `hz.session.move` / `hz.session.moved` (RC-1) | standard |
| `session.tree` | `1` | `optional-only` | `hz.session.tree` authority and cost rollup | standard |
| `subscribe.replay` | `1` | `optional-only` | `hz.subscribe` with `replay: true`; cursor replay from the log | standard |
| `subscribe.ndjson` | `1` | `optional-only` | the NDJSON framing variant (`/events.ndjson`) | standard |
| `tools.deferred` | `1` | `optional-only` | `hz.tool.search` and `deferredDiscoverable` declarations | standard |
| `tools.background` | `1` | `optional-only` | background tool invocation plus `hz.tool.cancel` | standard |
| `codemode` | `1` | `optional-only` | Code-Mode tool exposure (`codeModeEligible`) | standard |
| `worktrees.pool` | `1` | `optional-only` | pooled worktree modes in `hz.worktree.*` | standard |
| `agents.teams` | `1` | `optional-only` | `hz.team.*` (every member still goes through `hz.agent.spawn`) | standard |
| `agents.messaging` | `1` | `optional-only` | durable `AgentMessageV1` delivery (`hz.agent.message.*`) | standard |
| `memory.tiers.team` | `1` | `optional-only` | the team memory tier and its sync | standard |
| `memory.recall.vectors` | `1` | `optional-only` | vector/hybrid recall; without it recall degrades to lexical and the degradation is reported | standard |
| `learn.trajectories` | `1` | `optional-only` | `hz.learn.trajectory.*` | standard |
| `learn.proposals` | `1` | `optional-only` | `hz.learn.proposal.*` (apply still requires a human and a token) | standard |
| `evals` | `1` | `optional-only` | `hz.learn.eval.*` | standard |
| `budget.renew` | `1` | `optional-only` | progress-lease renewal (`budget.renew`, `BudgetV1.renewPolicy`) | standard |
| `reconcile.budgeted` | `1` | `optional-only` | `method=budgeted_replay` in reconciliation | standard |
| `sandbox.probe` | `1` | `required-capable` | `hz.kernel.sandbox.probe` and the `sandboxProbe` block of `hz.initialize` | standard |
| `plugins` | `1` | `optional-only` | the plugin host (§4.7); absent ⇒ no plugin loads and `plugins.invoke` is refused with a named reason | standard |
| `mcp.server` | `1` | `optional-only` | `hzcode mcp serve` (§4.6); absent ⇒ the endpoint MUST NOT start, never start degraded | standard |
| `mcp.client` | `1` | `optional-only` | consuming configured MCP servers | standard |
| `acp.sessionModes` | `1` | `optional-only` | ACP `session/set_mode` and the `sessionModes` capability | standard; MUST NOT be advertised when absent (§4.5.3) |
| `acp.usageUpdate` | `1` | `optional-only` | ACP `usage_update` notifications | standard |
| `otel.export` | `1` | `optional-only` | OpenTelemetry export; absent ⇒ local traces only, with a diagnostic that says so | standard |

Three rules bound the registry: (1) a feature flag gates the *existence of a surface*, never authority — it MUST NOT change a posture, a ceiling or a decision (doc 05 D29/D32); a build that lacks `tools.background` is a build without that surface, not a build with different policy. (2) `unavailable[]` MUST list every requested optional feature the peer lacks, and a dependent surface MUST fail closed with a named reason rather than half-work. (3) `deprecated[]` entries MUST carry `{item, since, removalProto, replacement}`, and the deprecated feature MUST remain functional for its advertised window (C42).

#### 4.1.5.1 Worked negotiation (unavailable + deprecated features)

```json
--> {"jsonrpc":"2.0","id":"i-2","method":"hz.initialize","params":{
      "hzProto":1,"hzAbi":1,
      "features":{"required":["session.verify"],"optional":["subscribe.replay","acp.sessionModes","plugins"]},
      "client":{"name":"hzcode-ci","version":"0.1.0","surface":"sdk"}}}
<-- {"jsonrpc":"2.0","id":"i-2","result":{
      "hzProto":1,"hzAbi":1,
      "features":{"enabled":["session.verify","subscribe.replay","plugins"],
                  "unavailable":["acp.sessionModes"],
                  "deprecated":[]},
      "server":{"version":"0.1.0","buildDigest":"blake3:9f2a…"},
      "kernel":{"state":"full","ownerEpoch":"42"},"modes":["agent"]}}
```

The client's `required` entry is satisfied, `acp.sessionModes` is reported unavailable without failing the connection (it was optional), and `plugins` is enabled so `plugins.invoke` may be requested later.

### 4.2 (b) The kernel ABI (`hzk`)

> **DESIGN ONLY: NOT IMPLEMENTED as written.** The shipped kernel protocol is NDJSON `{id, method, params}` with 11 methods (`ping`, `log.append`, `log.read`, `log.verify`, `receipt.issue`, `receipt.verify`, `guard.check`, `guard.lease`, `guard.grant`, `guard.allowlist.amend`, `sandbox.report`), no frame types, no `HZ_ABI`, errors as `{message}`. Deferral notes K7 and K10.

The kernel is a separate process (ADR-003) with its own versioned protocol. It is not a JSON surface (C13): frames are canonical MessagePack, shown below as JSON **for readability only**. Types are inherited from the ancestor (`HzKernelRpcV1`).

#### 4.2.1 Frame envelope

| Message | Direction | Fields |
|---|---|---|
| `hello` | client → kernel | `{minProtocol, maxProtocol, hostBuildDigest, kernelBuildDigest?, hostInstanceId, processIncarnation, supervisorNonce, requiredFeatures[], optionalFeatures[]}` |
| `hello_result` | kernel → client | `{protocol, enabledFeatures[], unavailableOptionalFeatures[], supervisorNonce, processIncarnation, ownerEpoch}` |
| `hello_rejected` | kernel → client | `{supervisorNonce, processIncarnation, error: TypedErrorV1}` |
| `startup_status` | kernel → client | `{state: OneOf{Starting, Ready, Failed}}`, `Failed` carries a `TypedErrorV1` |
| `request` | client → kernel | `{ownerEpoch, processIncarnation, requestId, serviceId, operation, deliveryId?, expectedCursor?, deadlineUnixMs, traceId, body}` |
| `authenticated_request` | client → kernel | `request` plus `principal` and optional `context` (host-derived, never caller-supplied) |
| `response` | kernel → client | `{ownerEpoch, processIncarnation, requestId, outcome: OneOf{Ok, Error}, ownerCursor?, receiptDigest?, body?, error?}` |
| `event` | kernel → client | `{ownerEpoch, processIncarnation, subscriptionId, cursor, eventType, payload}` |
| `control` | both | `Subscribe`, `Unsubscribe`, `Ack`, `PageEnd`, `ResnapshotRequired`, `CancelRequest`, `Ping` |

Handshake states: `hello` → `hello_result` → `startup_status: Starting` … `startup_status: Ready`. Application RPC MUST be refused before `Ready` (C14). `ownerEpoch` is the durable epoch of the canonical kernel owner; a client holding an older epoch MUST re-handshake (C15).

#### 4.2.2 Operation catalogue

| Operation | Body (request) | Body (response) | Notes |
|---|---|---|---|
| `effect.authorize` | `EffectRequestV1` (doc 05 §4.11) | `GuardDecisionV1` + `{intentDigest}` | pure and recomputable (doc 05 D20); MUST NOT create a lease |
| `effect.lease_issue` | `{effectId, decisionId, bindingDigest, ttlMs?}` | `LeaseV1` | refused when the decision is `Deny`, expired, or already consumed |
| `effect.execute` | `{leaseId, effectId, binding, dispatch: {kind, spec}}` | `{dispatchReceiptDigest, processRef?, startedAtMs}` | the only admission point that may start a host process or write |
| `effect.observe` | `{effectId, kind, probe: {spec}}` | `{observation{kind,value,digest,source}, evidence[]}` | probing is itself authorised; `source` MUST be a host source |
| `effect.settle` | `{effectId, terminal, observation, artifacts[], sideEffects[], filesTouched[], redactions[]}` | `EffectReceiptV1` | terminal and monotone (C19, doc 05 D18) |
| `effect.reconcile` | `{effectId, method, probes[], dryRun, budget}` | `ReconciliationRecordV1` | the only resolution path for `UNKNOWN` (C20) |
| `effect.status` | `{effectId}` | `{phase, terminal?, leaseId?, decisionId?}` | read-only |
| `guard.explain` | `EffectRequestV1` | same shape as `effect.authorize` + `matchedRules[]` | used by `hz.kernel.policy.explain`; MUST NOT persist a decision |
| `policy.load` | `{policyDocuments[], expectedDigest?}` | `{policyRevision, digest, ruleCount}` | atomic (C21) |
| `policy.reload` | `{expectedDigest?, source}` | `{policyRevision, digest, changedRuleCount, loadedAtMs}` | refusing on digest mismatch keeps the old policy |
| `policy.describe` | `{includeRules?}` | `{revision, digest, ruleCount, posturePresets[]}` | |
| `budget.query` | `{scopeRef, includeChildren?}` | `BudgetV1` (+ optional `BudgetReportV1`) | read-only, MUST NOT reserve (C22) |
| `budget.reserve` | `{scopeRef, expectedCost, leaseId?}` | `{reservationId, expiresAtMs}` | a reservation MUST be released or settled |
| `budget.settle` | `{reservationId, actualCost}` | `{consumed}` | |
| `budget.renew` | `{scopeRef, progressEvents[], graceFactor?}` | `{renewed: bool, renewalsRemaining}` | refusing to renew without real progress (doc 05 `BudgetV1`) |
| `worktree.create` | `{kind, baseRevision, ownerSessionId, limits, exclusive}` | `WorktreeV1` + `receiptId` | host-selected `ManagedRoot` origin (ancestor rule) |
| `worktree.lease` | `{worktreeId, ownerSessionId, exclusive, ttlMs}` | `WorktreeV1` | |
| `worktree.release` | `{worktreeId, mode: OneOf{keep,discard,reclaim}}` | `WorktreeV1` | `discard` needs an approval decision |
| `worktree.probe` | `{worktreeId}` | `{observed{dirtyFiles,untrackedFiles,sizeBytes}, state}` | read effect |
| `worktree.reclaim` | `{worktreeId, force}` | `WorktreeV1` + `receiptId` | refuses dirty without `force` + approval |
| `managed.run.create` | `{goalRef, specRef, tasks[], capabilityScope, budget}` | `{runId, plan}` | the managed domain (ancestor `managed_control`) |
| `managed.task.admit` | `{runId, taskId, attemptId, profileRef, budget}` | `{attemptId, permissionScopeDigest, budgetLeaseId}` | effective capabilities are an intersection computed by the kernel |
| `managed.attempt.settle` | `{attemptId, terminal, evidence[]}` | `{receiptId, verifierState}` | |
| `managed.verify.run` | `{runId, criteriaIds[], evidenceRefs[]}` | `{verdict, evidenceBundleRef, receiptId}` | `ManagedRun` origin; the reviewer principal is host-selected |
| `managed_provider.prepare` / `.begin` / `.settle` / `.unknown` | `{attemptId, route, sendAuthorization?, usage}` | `{authorizationId?, settlementId?, receiptId}` | the ancestor names these operations verbatim; HorizonCode keeps them |
| `managed_context.advance` | `{attemptId, contextDigest, sourceDigests[]}` | `{epoch, admitted}` | |
| `managed_message.prepare` / `.commit` / `.claim_wake` / `.acknowledge_consumed` | `{teamId, messageId, ordering}` | `{state, ordering}` | durable inter-agent delivery at the kernel layer |
| `host_run.bind` / `.bind_receipt` / `.inspect` | `{runId, hostProcessRef}` | `{binding, receiptDigest}` | binds a host process to a managed run |
| `artifacts.put` / `.inspect` / `.read_range` | `{sha256?, range?, principal}` | `{artifactRef, bytes, digest}` | reads are authorised per principal (doc 05 `ArtifactV1.access`) |
| `automations.create` / `.update` / `.enable` / `.disable` / `.list` / `.run_now` | automation definition | `{automationId, nextRunAtMs}` | the occurrence journal (superset §2.4) |
| `subscription.open` / `.ack` / `.close` | `{ownerKind, ownerId, after?}` | `{subscriptionId, cursor}` | kernel event stream mirroring the doc 05 `RpcControlV1` set |
| `health.status` | `{}` | `{state, buildDigest, ownerEpoch, degradations[]}` | MUST NOT be used as a readiness signal before `Ready` |

**Terminal vocabulary (RC-7) applied to the ABI.** `_conventions.md` RC-7 fixes one protocol-wide outcome enum - `succeeded | failed | denied | cancelled | budget_exhausted | timeout | interrupted | unknown` - and forbids any component from inventing its own terminal word. In this ABI: `effect.settle` carries a **receipt terminal** (`SUCCEEDED`, `FAILED`, `DENIED`, `UNKNOWN`) because a receipt answers only *did the world change and can we prove it*; the wider RC-7 outcome travels in the body as `outcomeReason` and is mapped to a terminal state by the writer using the total mapping table in `05-domain-and-schemas.md` §4.11. A settle request that supplies an `outcomeReason` without a terminal state, or a terminal state inconsistent with its reason, MUST be refused with `HZ_INVALID_PARAMS`. Kernel *event* payloads (statuses such as `budget_exhausted`, `timeout`, `cancelled`, `interrupted` on `hz.agent.completed`, `hz.session.claim.released`, `hz.session.busy.left`) use the RC-7 vocabulary verbatim, as catalogued in `06-events-and-flows.md`.

**Naming note.** The operation strings in §4.2.2 follow the ancestor's dotted `service.operation` dispatch style (`artifacts.read_range`, `host_run.bind`, `managed_provider.settle`, `automations.create`) and normalize the guard/lease/effect path to `effect.*`. That normalization is a HorizonCode naming decision, not a rename of shipped behaviour; see §10 item 2 for the compatibility consequence.

#### 4.2.3 Worked kernel exchanges

**Example 10 — `effect.authorize` then `effect.lease_issue`**

```json
--> { "ownerEpoch": "42", "processIncarnation": "inc-7f31", "requestId": "k-1", "serviceId": "effect",
      "operation": "effect.authorize", "deadlineUnixMs": "1762439418000", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "body": {
        "id": "eff_01J9Z8T2Q1…", "capabilityId": "files.write", "transport": "files",
        "origin": { "kind": "SessionBatch", "sessionId": "sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
                    "batchId": "bat_01J9Z8T2P8…", "callId": "tcl_01J9Z8T2P9…" },
        "action": "files.write", "arguments": { "path": "src/http/retry.ts", "contentSha256": "sha256:41ae…" },
        "argumentsDigest": "blake3:31c9…", "resource": { "workspaceRoot": "/home/dev/project",
          "workspaceBinding": "blake3:1b90…", "target": "src/http/retry.ts", "resourceKind": "path" },
        "targetRevision": "blake3:0ac1…", "policy": { "policyRevision": "blake3:b7c0…",
          "postureDigest": "blake3:e0d4…", "requestedGuarantees": ["fs.isolation"] },
        "deadlineMs": "30000", "idempotency": "idempotent",
        "expectedObservation": { "kind": "file_digest", "spec": { "path": "src/http/retry.ts" } } } }

<-- { "ownerEpoch": "42", "processIncarnation": "inc-7f31", "requestId": "k-1", "outcome": "Ok",
      "ownerCursor": "42:1187", "body": {
        "decision": { "decisionId": "dsc_01J9Z8T2Q2…", "decision": "Ask", "reasonCode": "asked_by_policy",
          "policyDigest": "blake3:b7c0…", "resourceDigest": "blake3:55aa…", "normalizedAction": "files.write",
          "intentDigest": "blake3:7d41…", "argumentDigest": "blake3:31c9…", "capabilityId": "files.write",
          "guarantees": { "requested": ["fs.isolation"], "granted": ["fs.isolation"], "residuals": [] },
          "approvalRequest": { "approvalId": "apr_01J9Z8T2Q3…", "oneUse": true, "expiresAtMs": "1762439478000",
                              "prompt": "Write src/http/retry.ts (1 file, +18/-4)" },
          "expiresAtMs": "1762439478000", "ownerEpoch": "42" },
        "intentDigest": "blake3:7d41…" } }
```

**Example 11 — `effect.settle`, terminal and chained**

```json
--> { "ownerEpoch": "42", "processIncarnation": "inc-7f31", "requestId": "k-2", "serviceId": "effect",
      "operation": "effect.settle", "deadlineUnixMs": "1762439420000", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
      "body": { "effectId": "eff_01J9Z8T2Q1…", "terminal": "SUCCEEDED",
        "observation": { "kind": "file_digest", "value": "blake3:0ac1…", "digest": "blake3:0ac1…", "source": "filesystem_probe" },
        "filesTouched": [ { "path": "src/http/retry.ts", "op": "modified",
                            "digestBefore": "blake3:0ac1…", "digestAfter": "blake3:9b2e…" } ],
        "sideEffects": [ { "kind": "bytes_written", "ref": "src/http/retry.ts", "count": "412" } ] } }
<-- { "ownerEpoch": "42", "processIncarnation": "inc-7f31", "requestId": "k-2", "outcome": "Ok",
      "receiptDigest": "blake3:9e12…", "body": { "receiptId": "rcp_01J9Z8T4M1…", "terminal": "SUCCEEDED",
        "hashChain": { "prevReceiptDigest": "blake3:0d55…", "chainDigest": "blake3:9e12…", "sequence": "42" },
        "reconciliationRequired": false } }
```

A second `effect.settle` for the same `eff_…` with `terminal: "FAILED"` returns `outcome: Error` with `HZ_CONFLICT` / `Corruption` / `Never` and raises `hz.error.raised` (C19).

**Example 12 — an `UNKNOWN` settlement (the honest outcome)**

```json
<-- { "ownerEpoch": "42", "processIncarnation": "inc-7f31", "requestId": "k-3", "outcome": "Ok",
      "body": { "receiptId": "rcp_01J9Z9A1Y9…", "terminal": "UNKNOWN",
        "unknownReason": "process_disappeared", "reconciliationRequired": true,
        "observation": { "kind": "exit_code", "value": "unknown", "digest": "blake3:0000…", "source": "host_process" } } }
```

No retry follows automatically (ADR-012). The orchestrator must call `effect.reconcile` (Example 7) and the session cannot reach `completed` while `openUnknownEffectCount > 0`.

### 4.3 (c) The HTTP/SSE REST surface

> **DESIGN ONLY: NOT IMPLEMENTED.** No HTTP server exists. Deferral note K8.

Base path `/v1` on the server listener `[planned]` (`hzcode serve --listen 127.0.0.1:7777`). Every REST route is a projection of a Controller method (C24); the mapping column below is normative and is checked by the parity ratchet.

#### 4.3.1 Routes

| Method | Path | Controller method | Notes |
|---|---|---|---|
| `GET` | `/v1/healthz` | — | liveness only; `200` even when the kernel is degraded; body carries `{status, kernelState}` |
| `GET` | `/v1/version` | — | `{version, buildDigest, hzProto, hzAbi, features[]}` |
| `GET` | `/v1/openapi.json` | — | generated specification; published, not hand-written |
| `POST` | `/v1/rpc` | any | escape hatch: one JSON-RPC request per call for methods without a bespoke route |
| `POST` | `/v1/sessions` | `hz.session.create` | `201` + `Location: /v1/sessions/{id}` |
| `GET` | `/v1/sessions` | `hz.session.list` | `?state=&kind=&rootId=&cursor=&limit=` |
| `GET` | `/v1/sessions/{id}` | `hz.session.get` | `?include=posture,config,claim` |
| `PATCH` | `/v1/sessions/{id}` | `hz.session.update` | requires `If-Match` |
| `DELETE` | `/v1/sessions/{id}` | `hz.session.delete` | `?mode=soft|hard` |
| `POST` | `/v1/sessions/{id}/prompts` | `hz.session.submit` | `?delivery=auto|steer|queue` |
| `POST` | `/v1/sessions/{id}/interrupt` | `hz.session.interrupt` | |
| `POST` | `/v1/sessions/{id}/cancel` | `hz.session.cancel` | `?scope=turn|session|tree` |
| `POST` | `/v1/sessions/{id}/resume` | `hz.session.resume` | |
| `POST` | `/v1/sessions/{id}/fork` | `hz.session.fork` | |
| `POST` | `/v1/sessions/{id}/rewind` | `hz.session.rewind` | `?dryRun=true` recommended first |
| `POST` | `/v1/sessions/{id}/compact` | `hz.session.compact` | |
| `POST` | `/v1/sessions/{id}/checkpoints` | `hz.session.checkpoint.create` | |
| `GET` | `/v1/sessions/{id}/verify` | `hz.session.verify` | `GET` because it is pure; the verdict is not cached across runs |
| `GET` | `/v1/sessions/{id}/export` | `hz.session.export` | `?format=jsonl|markdown|bundle|otlp` |
| `GET` | `/v1/sessions/{id}/events` | `hz.subscribe` | **SSE**, `?since=<cursor>` or `Last-Event-ID` |
| `GET` | `/v1/sessions/{id}/events.ndjson` | `hz.subscribe` | NDJSON, one frame per line; same envelope (C12) |
| `GET` | `/v1/sessions/{id}/messages` | `hz.session.message.list` | |
| `GET` | `/v1/sessions/{id}/parts` | `hz.session.part.list` | |
| `GET` | `/v1/sessions/{id}/steps` | `hz.step.list` | |
| `GET` | `/v1/sessions/{id}/receipts` | `hz.kernel.receipt.list` | |
| `GET` | `/v1/sessions/{id}/tree` | `hz.session.tree` | authority + cost rollup |
| `GET` | `/v1/sessions/{id}/posture` | `hz.session.get` | `?include=posture` |
| `PUT` | `/v1/sessions/{id}/posture` | `hz.session.posture.update` | requires `If-Match`; widening requires `confirmToken` |
| `GET`/`PUT` | `/v1/sessions/{id}/config` | `hz.session.config.update` | `PUT` re-merges through the lattice |
| `GET` | `/v1/approvals` | `hz.approval.list` | `?state=pending` |
| `POST` | `/v1/approvals/{id}/respond` | `hz.approval.respond` | body `{decision, scope?, justification?}` |
| `GET` | `/v1/tools` | `hz.tool.list` | `?sessionId=&includeDeferred=` |
| `GET` | `/v1/tools/{name}` | `hz.tool.describe` | |
| `POST` | `/v1/tools/{name}/invoke` | `hz.tool.invoke` | human-origin invocation (`origin=UserAction`) |
| `GET` | `/v1/agents` | `hz.agent.list` | `?parentSessionId=&teamId=` |
| `POST` | `/v1/agents` | `hz.agent.spawn` | |
| `GET` | `/v1/agents/{sessionId}` | `hz.agent.get` | |
| `DELETE` | `/v1/agents/{sessionId}` | `hz.agent.cancel` | `?cascade=true` |
| `POST` | `/v1/agents/{sessionId}/messages` | `hz.agent.message.send` | |
| `GET` | `/v1/teams/{teamId}` | `hz.team.state` | |
| `POST` | `/v1/teams` | `hz.team.create` | |
| `DELETE` | `/v1/teams/{teamId}` | `hz.team.delete` | `?mode=drain|cancel` |
| `GET` | `/v1/memory` | `hz.memory.list` | |
| `POST` | `/v1/memory` | `hz.memory.retain` | |
| `PATCH` | `/v1/memory/{id}` | `hz.memory.edit` | requires `If-Match` |
| `DELETE` | `/v1/memory/{id}` | `hz.memory.forget` | `?mode=tombstone|expire` |
| `GET` | `/v1/memory/recall` | `hz.memory.recall` | `GET` because it is a read; the ledger entry is recorded |
| `POST` | `/v1/memory/reflect` | `hz.memory.reflect` | `propose_only` |
| `GET` | `/v1/learn/trajectories` | `hz.learn.trajectory.list` | |
| `GET` | `/v1/learn/trajectories/{id}` | `hz.learn.trajectory.get` | |
| `POST` | `/v1/learn/evals/run` | `hz.learn.eval.run` | `202 Accepted` when queued |
| `GET` | `/v1/learn/proposals` | `hz.learn.proposal.list` | |
| `POST` | `/v1/learn/proposals/{id}/review` | `hz.learn.proposal.review` | human principal only |
| `POST` | `/v1/learn/proposals/{id}/apply` | `hz.learn.proposal.apply` | requires `approvalToken` |
| `GET` | `/v1/kernel/status` | `hz.kernel.status` | |
| `POST` | `/v1/kernel/policy/reload` | `hz.kernel.policy.reload` | |
| `POST` | `/v1/kernel/policy/explain` | `hz.kernel.policy.explain` | dry run |
| `GET` | `/v1/kernel/receipts/{id}` | `hz.kernel.receipt.get` | `{id}` accepts a receipt id or an effect id |
| `POST` | `/v1/kernel/receipts/verify` | `hz.kernel.receipt.verify` | |
| `POST` | `/v1/kernel/reconcile` | `hz.kernel.reconcile` | |
| `GET` | `/v1/kernel/budget` | `hz.kernel.budget.query` | |
| `GET` | `/v1/kernel/trusted-state` | `hz.kernel.trusted_state.list` | |
| `POST` | `/v1/kernel/sandbox/probe` | `hz.kernel.sandbox.probe` | |
| `GET` | `/v1/worktrees` | `hz.worktree.list` | |
| `POST` | `/v1/worktrees` | `hz.worktree.acquire` | receipted effect |
| `DELETE` | `/v1/worktrees/{id}` | `hz.worktree.release` | `?mode=keep|discard|reclaim` |
| `GET` | `/v1/artifacts/{sha256}` | resolver | honours `ArtifactV1.access` and redaction (C34) |

#### 4.3.2 Status codes

| Status | When | Body |
|---|---|---|
| `200` | success, or a pure read | result payload |
| `201` | a resource was created (`POST /v1/sessions`, `/v1/agents`, `/v1/teams`, `/v1/worktrees`) | created object + `Location` |
| `202` | accepted for asynchronous work (eval run, long compaction, reconcile) | `{accepted, operationId}` — the client follows the event stream |
| `204` | successful delete with no payload | — |
| `400` | malformed body, missing `Idempotency-Key`, unknown field (`Validation`) | error body, `HZ_VALIDATION` |
| `401` | missing or invalid credential (`Authorization`) | error body, `HZ_UNAUTHENTICATED`, `WWW-Authenticate` |
| `403` | authenticated but not permitted (`Authorization` / `Capability`) | error body, `HZ_POLICY_DENIED` or `HZ_CAPABILITY_NOT_GRANTED` |
| `404` | unknown resource (`NotFound`) | error body, `HZ_NOT_FOUND` |
| `409` | conflicting idempotency key, stale claim fence, duplicate ordering (`Conflict`) | error body, `HZ_CONFLICT` |
| `410` | event cursor no longer retained | error body, `HZ_CURSOR_RESET` + `HZ-Latest-Cursor` header (C28) |
| `412` | `If-Match` did not match current `digest`/`revision` (`Conflict`) | error body, `HZ_PRECONDITION_FAILED` + current value |
| `413` | payload over `maxPromptBytes`/`maxResponseBytes` | error body, `HZ_VALIDATION` |
| `422` | semantically invalid (e.g. a widening posture patch without a token) | error body, `HZ_POSTURE_CONFIRMATION_REQUIRED` |
| `423` | a claim is held by another live process for a session-scoped mutation | error body, `HZ_CLAIM_HELD` + owner incarnation |
| `428` | `If-Match` required and absent (C27) | error body, `HZ_PRECONDITION_REQUIRED` |
| `429` | rate limit or budget limiter (`Unavailable`) | error body, `HZ_RATE_LIMITED` + `Retry-After` |
| `499` | client closed the request (server-side log only; no body is sent) | — |
| `500` | internal defect (`Internal`) | error body, `HZ_GENERIC`; details MUST NOT contain secrets |
| `501` | a method exists but is unimplemented in this build | error body, `HZ_UNSUPPORTED_FEATURE` |
| `503` | kernel unavailable or ABI mismatch (`Unavailable`) | error body, `HZ_KERNEL_UNAVAILABLE` + `Retry-After`; the app is in `degraded_read_only` |
| `504` | deadline exceeded (`Deadline`) | error body, `HZ_DEADLINE_EXCEEDED` |

**Rate limits are a named shape, not an ad-hoc limiter.** The entitlement model behind `429` is `RateLimitPolicyV1`, owned by `05-domain-and-schemas.md` §4.9 (per-principal, per-provider, per-budget scopes, their meet-combination and precedence). This surface MUST NOT define its own limiter: a `429` response MUST name the effective policy in `details.rateLimitPolicyId`, carry `windowMs` and a `Retry-After` derived per the policy's `retryAfterMode`, and the choice between refusing, queueing, degrading and asking belongs to the policy's `onExceeded` value, applied by the owning layer (the provider path, the budget guard, or the server's per-principal limiter). When several policies match, the numeric limit is the meet and the *reported* policy is the most specific scope; the `retryClass` MUST match the call's idempotency rather than defaulting to `SafeQueryRetry` (doc 05 D39).

#### 4.3.3 Authentication modes

| Mode | Applies to | Credential | Rules |
|---|---|---|---|
| `none` | loopback UDS / `127.0.0.1` development only | — | a non-loopback bind with `none` MUST be refused at startup (C26); the server MUST log a warning for every start |
| `bearer` | TCP, tunnels | `Authorization: Bearer <token>` | the token is minted at start, stored `0600`, hashed at rest, redacted from logs and transcripts; rotation requires a restart or `POST /v1/kernel/policy/reload` |
| `mtls` | TCP, machine-to-machine | client certificate | the CN/SAN maps to a `PrincipalRef`; a revoked certificate MUST fail closed on the next request |
| `oidc` | enterprise deployment | OIDC-issued JWT | audience and issuer are pinned; a token with a non-matching audience MUST be rejected; group claims map to permission scopes, never to capability grants directly |
| `proxy-trust` | behind an authenticated reverse proxy | proxy header + mTLS to the proxy | only honoured when the listener was started with `--trust-proxy` and the peer address is in the trusted set; a spoofed header from an untrusted peer MUST be rejected |
| `bridge-jwt` | IDE bridge | short-lived, workspace-scoped JWT | binds `workspaceRootDigest`; a token for a different workspace MUST be rejected; each attachment is revocable individually |

Authorization is separate from authentication: an authenticated principal still travels through Guard. A human principal with `role=viewer` MUST NOT be able to widen a posture merely by being authenticated.

#### 4.3.4 Worked REST exchange

**Example 13 — create a session, submit a prompt, follow events (SSE)**

```http
POST /v1/sessions HTTP/1.1
Host: 127.0.0.1:7777
Authorization: Bearer ${HZ_TOKEN}
Idempotency-Key: create-1
Content-Type: application/json

{ "title": "fix flaky retry test", "cwd": "/home/dev/project", "posture": { "preset": "ask-for-approval" } }
```

```http
HTTP/1.1 201 Created
Location: /v1/sessions/sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1
ETag: "blake3:e0d4…"
Content-Type: application/json

{ "id": "sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1", "state": "idle",
  "posture": { "sandboxMode": "workspace-write", "approvalPolicy": "on-request", "digest": "blake3:e0d4…" } }
```

```http
POST /v1/sessions/sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1/prompts?delivery=steer HTTP/1.1
Idempotency-Key: u-7f2c
Content-Type: application/json

{ "text": "make the retry test deterministic" }
```

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "admissionId": "adm_01J9Z8R0AA…", "admittedSeq": "1", "receiptDigest": "blake3:aa10…", "replayed": false }
```

```http
GET /v1/sessions/sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1/events?since=sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:0 HTTP/1.1
Accept: text/event-stream
```

### 4.4 (d) The event subscription stream

> **DESIGN ONLY: NOT IMPLEMENTED.** The server relays `RuntimeEvent`s as `session.event` notifications with no cursor or replay. Deferral note K8.

#### 4.4.1 `hz.subscribe`

| Params | Type | Notes |
|---|---|---|
| `topics` | `[]string` | `session`, `step`, `tool`, `effect`, `agent`, `team`, `memory`, `learn`, `budget`, `kernel`, `approval`; empty = all permitted to the principal |
| `filter` | `{sessionIds?: []Id, rootId?: Id, eventTypes?: []string, agentIds?: []Id, effectIds?: []Id}` | a filter is a *view*, never an authorization |
| `since` | `cursor?` | resumes from a cursor; absent = live-only |
| `replay` | `bool` | `true` requires the `subscribe.replay` feature (C2); replay never re-executes anything |
| `framing` | `OneOf{jsonrpc, sse, ndjson}` | must match the transport's framing |
| `coalesce` | `{deltas?: bool, windowMs?: u32}` | `deltas` defaults to `true` for TUI, `false` for CI loggers; coalescing MUST NOT cross a part's terminal state (C9) |

| Result | Type | Notes |
|---|---|---|
| `subscriptionId` | `Id` | |
| `cursor` | `cursor` | the position the client is at |
| `replaying` | `bool` | `true` while historical events are being sent |
| `retentionWindow` | `{oldestSeq, newestSeq, oldestCursor}` | lets a client detect that it is about to fall off the retained window |

#### 4.4.2 Framing

**JSON-RPC notification** (stdio / UDS / WS):

```json
{"jsonrpc":"2.0","method":"hz.event","params":{
  "sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","seq":"15","tsMs":"1762439411450",
  "type":"hz.step.llm.delta","actor":{"kind":"agent","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1"},
  "payload":{"stepId":"stp_01J9Z8T0S1…","messageId":"msg_01J9Z8T0S2…","partId":"prt_01J9Z8T0S3…","deltaIndex":"7","text":"The test is flaky because"},
  "cursor":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:15","traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}}
```

**SSE** (server):

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
HZ-Proto: 1
HZ-Retention-Oldest: sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:1

retry: 2000

id: sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:16
event: hz.part.updated
data: {"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","seq":"16","tsMs":"1762439411600","type":"hz.part.updated","actor":{"kind":"agent"},"payload":{"partId":"prt_01J9Z8T0S3…","state":"complete","frozen":true,"contentDigest":"blake3:5b0e…","tokens":"84"},"cursor":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:16"}

id: sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:17
event: hz.control.page_end
data: {"through":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:16","hasMore":true}

: keep-alive

id: sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:18
event: hz.effect.settled
data: {"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1","seq":"18","tsMs":"1762439413010","type":"hz.effect.settled","payload":{"receiptId":"rcp_01J9Z8T4M1…","effectId":"eff_01J9Z8T2Q1…","terminal":"SUCCEEDED","capabilityId":"files.write","observationDigest":"blake3:0ac1…"},"cursor":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:18"}

id: sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:19
event: hz.control.resnapshot_required
data: {"requested":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:12","latest":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1:19"}

```

Rules the framing must satisfy: (1) `id` is exactly the envelope `cursor` and is resumable via `Last-Event-ID`; (2) `event` is exactly the event `type` from `_conventions.md` §6; (3) `data` is the whole envelope, so a naive consumer loses nothing; (4) control frames (`page_end`, `resnapshot_required`) use the reserved `hz.control.` prefix and MUST NOT be persisted as session events; (5) comment-only keep-alives MUST NOT advance a cursor; (6) a `resnapshot_required` frame MUST be the last frame before the stream re-snapshots.

**Cursor semantics.** A cursor is `<sessionId>:<seq>` for session-scoped streams and `owner:<ownerEpoch>:<ownerCursor>` for kernel-owner streams (the ancestor's cursor shape). A cursor from a different session MUST be rejected (`HZ_VALIDATION`) rather than silently reinterpreted.

**Delivery guarantees.** At-least-once, per-subscription ordering, client `hz.ack` to release the server-side buffer (C10). A client that never acks is throttled via bounded queue exhaustion and then told `resnapshot_required`; the server MUST NOT grow memory without bound (C11).

#### 4.4.3 Event types carried

The canonical names are fixed by `_conventions.md` §6 and are not restated here. Three rules govern what may appear on this stream: (1) only canonical names — a front-end ad-hoc event MUST NOT exist; (2) `hz.step.llm.delta` is the only ephemeral type and MUST NOT be written to the log (C9); (3) an event whose payload contains a redaction MUST carry `redactions[]`, and the redacted value MUST NOT appear anywhere in the frame.

### 4.5 (e) The ACP surface

> **DESIGN ONLY: NOT IMPLEMENTED.** Deferral note K9 (owned by G5 in docs/14).

`hzcode acp` `[planned]` runs a HorizonCode agent over ACP for editors, and the IDE bridge runs HorizonCode as an ACP *client* for other agents. Both directions matter (the oh-my-pi lesson, vision §2.6).

#### 4.5.1 Methods (agent direction)

| ACP method | Params | Result / notification | Mapping |
|---|---|---|---|
| `initialize` | `{protocolVersion, clientCapabilities{fs{readTextFile,writeTextFile}, terminal, promptCapabilities{image,audio,embeddedContext}}, clientInfo}` | `{protocolVersion, agentCapabilities{loadSession, promptCapabilities{image,audio,embeddedContext}, mcpCapabilities{http,sse}, sessionModes, authMethods}, agentInfo}` | capabilities are negotiated once; an unsupported *required* capability fails the connection |
| `authenticate` | `{methodId, ...}` | `{ok}` | maps to the server auth modes (bearer/mTLS/OIDC/bridge-JWT); ACP MUST NOT mint a second credential store |
| `session/new` | `{cwd, mcpServers[]}` | `{sessionId}` | ACP `sessionId` maps 1:1 to `hz://session/<id>`; the posture comes from the effective config, never from the editor |
| `session/load` | `{sessionId, cwd, mcpServers[]}` | `{replayed: true}` then `session/update` notifications | MUST replay from log + step records only (C31) |
| `session/prompt` | `{sessionId, prompt: ContentBlock[]}` | `{stopReason}` | maps to `hz.session.submit` with `delivery=auto`; text/image/audio blocks become `PromptV1.attachments` |
| `session/cancel` | `{sessionId}` | notification | maps to `hz.run.cancel` with `scope=turn` |
| `session/set_mode` | `{sessionId, modeId}` | `{ok}` | maps to a posture **preset**; a widening mode requires the same human confirmation as the TUI |
| `session/set_model` | `{sessionId, modelId}` | `{ok}` | maps to `SessionConfig.modelRef`; resolution failure fails closed |
| `session/update` (notification) | — | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `usage_update` | every update is derived from a session event |
| `session/request_permission` (agent → client) | `{sessionId, toolCall, options[]}` | `{outcome: selected/cancelled}` | maps onto a Guard `Ask` decision; the client's answer is the approval (C30) |
| `fs/read_text_file` | `{sessionId, path, line?, limit?}` | `{content}` | requires the `files.read` capability and is receipted as a read effect when it crosses the workspace boundary |
| `fs/write_text_file` | `{sessionId, path, content}` | `{ok}` | requires `files.write` + a Guard decision; a denial MUST be reported as a clean refusal, not as an editor error |
| `terminal/create` / `output` / `wait_for_exit` / `kill` / `release` | terminal ids | streamed output | maps to `terminal.pty`/`process.spawn`; ACP terminals are tracked as `WorktreeV1`-scoped processes |

#### 4.5.2 Worked ACP exchange

**Example 14 — prompt, streamed updates, and a permission request**

```json
--> {"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "prompt":[{"type":"text","text":"why is retry.test.ts flaky?"}]}}
<-- {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Checking the retry budget first."}}}}
<-- {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "update":{"sessionUpdate":"tool_call","toolCallId":"tcl_01J9Z8T2P9…","title":"Read test/retry.test.ts",
                "kind":"read","status":"pending","content":[{"type":"content","content":{"type":"text","text":"…"}}]}}}
<-- {"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{
      "sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
      "toolCall":{"toolCallId":"tcl_01J9Z8T2P9…","title":"Run bun test test/retry.test.ts (10x)","kind":"execute"},
      "options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},
                  {"optionId":"allow_scoped","name":"Allow `bun test*` this session","kind":"allow_always"},
                  {"optionId":"deny","name":"Deny","kind":"reject_once"}]}}
--> {"jsonrpc":"2.0","id":77,"result":{"outcome":{"outcome":"selected","optionId":"allow_scoped"}}}
<-- {"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
```

`allow_scoped` creates a `ToolPermissionV1` with `origin=runtime_approval` and `expiry.maxUses`, and the receipt cites the decision it produced. There is no ACP-only permission state (C30).

#### 4.5.3 Capabilities advertised

`{loadSession: true, promptCapabilities: {image: true, audio: true, embeddedContext: true}, mcpCapabilities: {http: true, sse: true}, sessionModes: true, sessionModels: true, terminal: true, fs: {readTextFile: true, writeTextFile: true}, elicitation: true, usageUpdate: true}`. A capability is advertised **only** when the corresponding Controller feature is enabled in this build; advertising an unavailable capability is a contract violation (it teaches clients to rely on something that fails closed).

### 4.6 (f) The MCP server surface (and the client counterpart)

> **Server: DESIGN ONLY: NOT IMPLEMENTED. Client: a reduced stdio, tools-only client ships** (`app/src/core/mcp/`, protocol revision `2024-11-05`, user config only); see docs/15 H7.

#### 4.6.1 Exposed tools

| MCP tool | Input | Output | Required grant |
|---|---|---|---|
| `hz_submit` | `{sessionId?, text, delivery?, cwd?, title?}` | `{sessionId, admissionId, receiptDigest}` | `session.manage` (session creation only when `sessionId` is absent) |
| `hz_session_status` | `{sessionId}` | `{state, stepIndex, waitingOn?, budgets[]}` | `session.manage` (read) |
| `hz_session_verify` | `{sessionId, mode?}` | `{verdict, loweredClaims[], openUnknowns[]}` | `session.manage` (read) |
| `hz_session_transcript` | `{sessionId, fromSeq?, limit?}` | `{messages[], parts[]}` | `session.manage` (read) |
| `hz_approve` | `{approvalId, decision, scope?, justification?}` | `{toolCallId, decision}` | an explicit per-tool grant **and** a human `PrincipalRef`; an MCP client with an agent principal MUST be refused |
| `hz_receipt_get` | `{receiptId?|effectId?}` | `{receipt, chain{verified}}` | `session.manage` (read) |
| `hz_memory_recall` | `{query, tiers?, k?}` | `{records[]}` | `memory.read` |
| `hz_memory_retain` | `{tier, scope, content, evidenceRefs?}` | `{memoryId, reviewState}` | `memory.write` **and** an explicit per-tool grant |
| `hz_tool_invoke` | `{sessionId, name, args}` | `{toolCallId, status, resultClass, output}` | **must be granted per tool name**; the exposed set is empty by default (C32) |
| `hz_reconcile` | `{effectId, method, dryRun?}` | `{record, resultingAction}` | `session.manage` **and** explicit per-tool grant |

Default posture for the MCP server is `read-only` (`mcp-server` profile). Every mutating tool is disabled until granted individually; a grant for `hz_reconcile` MUST NOT enable `hz_tool_invoke` (C32).

#### 4.6.2 Exposed resources

| URI template | Content | Read semantics |
|---|---|---|
| `hz://session/{id}` | session summary (state, posture gist, budgets, counters) | `resources/read`; changes notify via `resources/updated` |
| `hz://session/{id}/transcript` | messages and parts, paginated through a cursor resource | large content is paged, never dumped |
| `hz://session/{id}/plan` | current `PlanV1` rendering | reads are pure |
| `hz://receipt/{id}` | `EffectReceiptV1` plus chain verification | a broken chain is reported in the resource body, not hidden |
| `hz://artifact/{sha256}` | artifact bytes (redacted per `ArtifactV1.redaction`) | refuses when `access.scope` excludes the caller (C34) |
| `hz://tool/{name}` | `ToolDeclarationV1` | |
| `hz://skill/{name}` | `SkillManifestV1` + body | a workspace/marketplace skill MUST have a verified digest to be readable |

`resources/subscribe` is supported for session and receipt resources so a client can follow progress without polling.

#### 4.6.3 Exposed prompts

Bundled skills that are `userInvocable` are exposed as MCP prompts (for example `hz-plan-review`, `hz-implement-issue`, `hz-verify`, `hz-remember`), plus two server-specific prompts: `hz-plan-review` (review a plan against receipts) and `hz-evidence-audit` (walk a session's receipts and report `UNKNOWN` effects and lowered claims). A prompt is a *template*; invoking it produces an admitted `PromptV1`, never a privileged path.

#### 4.6.4 Worked MCP exchange

**Example 15 — `tools/call` and a refusal that is not an error**

```json
--> {"jsonrpc":"2.0","id":"m-1","method":"tools/call","params":{"name":"hz_submit",
      "arguments":{"text":"add a regression test for the retry budget","cwd":"/home/dev/project"}}}
<-- {"jsonrpc":"2.0","id":"m-1","result":{"content":[{"type":"text","text":"session created"}],
      "structuredContent":{"sessionId":"sess_01J9Z9C7H1…","admissionId":"adm_01J9Z9C7H2…","receiptDigest":"blake3:aa10…"}}}}

--> {"jsonrpc":"2.0","id":"m-2","method":"tools/call","params":{"name":"hz_tool_invoke",
      "arguments":{"sessionId":"sess_01J9Z9C7H1…","name":"write","args":{"path":"src/x.ts","content":"…"}}}}
<-- {"jsonrpc":"2.0","id":"m-2","result":{"isError":true,"content":[{"type":"text",
      "text":"hz_tool_invoke is not granted for tool `write` in this server profile (read-only). Grant it explicitly to enable."}],
      "structuredContent":{"hzCode":"HZ_CAPABILITY_NOT_GRANTED","capabilityId":"tools.invoke.write","grantRequired":true}}}
```

A capability refusal is a *successful* MCP call whose content explains the refusal (`isError: true` for client ergonomics), because it is an expected, policy-shaped outcome rather than a protocol failure.

#### 4.6.5 The MCP client counterpart

HorizonCode also consumes MCP servers (`McpServerConfigV1`, doc 05 §4.12). Client rules that belong to this contract: (1) tool discovery is bounded by `tools.allowedPatterns`/`deniedPatterns` and `maxTools`; (2) a deferred-discovery server's tools appear only through `hz.tool.search`, and a search hit MUST NOT bypass policy; (3) every MCP tool invocation is an `mcp.invoke` effect with the ordinary Guard/lease/receipt path — a server MUST NOT be trusted to self-report success; (4) OAuth tokens live in the keychain and are never written to config, logs, transcripts or receipts; (5) an `untrusted` server's tools are not listed to the model at all until a trust decision exists (doc 05 D31).

### 4.7 (g) The plugin API

> **DESIGN ONLY: NOT IMPLEMENTED.** Deferral note K9 (owned by H5 in docs/15).

A plugin runs in a sandboxed host (worker, process or wasm) and talks to the host over a dedicated JSON-RPC 2.0 channel with its own revision, `hzplugin/1`. Both directions are specified: the host calls into the plugin (invocations), and the plugin calls into the host (registrations, requests). The plugin NEVER gets a kernel connection (C35).

#### 4.7.1 Handshake

| Step | Direction | Message | Purpose |
|---|---|---|---|
| 1 | plugin → host | `initialize {apiVersion, pluginId, version, manifestDigest, capabilitiesRequested[], configValues?}` | declares identity and requests; `manifestDigest` must match the verified manifest |
| 2 | host → plugin | `initialize/result {grantedCapabilities[], deniedCapabilities[]{capabilityId, reasonCode}, sandbox{mode, limits}, sessionContext{workspaceRoot, posture{sandboxMode, approvalPolicy, networkPolicy}, sessionId?}, config}` | the effective grant is already `request ∩ ceiling ∩ trust` (C36) |
| 3 | plugin → host | `register {tools[], commands[], agents[], skills[], providers[], hooks[], ui[]}` | every declaration is validated by the host (C37) |
| 4 | host → plugin | `register/result {accepted[], rejected[]{id, reason}}` | a rejected declaration fails the load when it was declared `required` |
| 5 | either | `shutdown {reason}` | graceful teardown; the host revokes grants on receipt |

#### 4.7.2 Host → plugin (invocations)

| Method | Params | Result / notifications |
|---|---|---|
| `tool/invoke` | `{invocationId, toolId, args, context{toolCallId, sessionId, workspaceRoot, cwd, posture, grantedCapabilities[], budgetLimits}, deadlineMs}` | `{output, artifacts[]}`; progress via `tool/progress` notifications |
| `tool/cancel` | `{invocationId, mode}` | `{cancelled: bool}` |
| `command/invoke` | `{invocationId, commandId, args, context}` | `{promptText?, output?}` |
| `hook/run` | `{hookId, event, payload, mode: OneOf{blocking, advisory, async}, timeoutMs}` | `{outcome: OneOf{allow, ask, deny, noop}, reason?, output?}` — a hook may only narrow, never widen (doc 05 `HookDefV1` invariants) |
| `provider/stream` | `{requestId, model, messages, tools[], params}` | `provider/delta` notifications then `{finishReason, usage}` |
| `agent/contribute` | `{agentId, sessionId, context}` | `{systemPromptAddendum?, toolAllowlist[]?, outputSchema?}`; an addendum MUST NOT introduce capability |
| `ui/render` | `{renderId, slot, data, capabilities{unicode, mouse, width, height}}` | `{lines[]}` |
| `memory/callback` | `{event: OneOf{retained, recalled, promoted}, records[]}` | `{ack: true}` |
| `config/changed` | `{effectiveConfigDigest, changedKeys[]}` | `{ack: true}` |

#### 4.7.3 Plugin → host (requests)

| Method | Params | Result | Notes |
|---|---|---|---|
| `register` | see §4.7.1 step 3 | `{accepted[], rejected[]}` | validation is the host's job, not the plugin's |
| `unregister` | `{ids[]}` | `{removed[]}` | |
| `effects/request` | `{capabilityId, action, args, resource?, idempotency, deadlineMs}` | `{effectId, decision, terminal?, receiptId?, output?}` | the host submits an `EffectRequestV1`; a plugin tool invoked by the model keeps origin `SessionBatch`, and origin is never taken from the plugin (C36) |
| `permission/request` | `{capabilityId, action, args, rationale}` | `{decision, approvalId?, expiresAtMs?}` | may return `Ask`; a plugin MUST handle `Ask` by waiting, not by prompting the user itself |
| `memory/recall` | `{query, tiers?, k?}` | `{records[]}` | requires the granted `memory.read` |
| `memory/retain` | `{tier, scope, content, evidenceRefs?}` | `{memoryId, reviewState}` | requires the granted `memory.write`; redaction still applies |
| `artifacts/read` | `{sha256, range?}` | `{bytes, redaction}` | honours `ArtifactV1.access` (C34) |
| `artifacts/write` | `{bytes, mediaType, kind}` | `{artifactRef}` | requires the granted `artifact.write` |
| `artifacts/query` | `{scope?, kinds?, limit?}` | `{artifacts[]}` | |
| `session/info` | `{}` | `{sessionId?, posture, budgetLimits, workspaceRoot}` | never returns credentials |
| `config/get` | `{keys[]}` | `{values, effectiveConfigDigest}` | a plugin MUST NOT read config keys it did not declare in its manifest |
| `log` | `{level, message, fields?}` | `{accepted: true}` | redaction applies to log fields too |
| `progress` | `{invocationId, percent?, message?}` | `{accepted: true}` | advisory pace control; the host MUST NOT block on it |
| `ui/notify` | `{level, message, actions[]?}` | `{accepted}` | rendered by the front-end |
| `tool/declare` | `{declaration: ToolDeclarationV1}` | `{accepted, revision}` | a plugin MUST NOT register a declaration whose `capabilityId` it was not granted: the declaration is rejected |

#### 4.7.4 Capability declarations and enforcement

1. `capabilitiesRequested` in the signed manifest is a **ceiling request**, not a grant. The effective grant is `request ∩ session ceiling ∩ trust decision` (C36), computed by the host before `initialize/result` is sent.
2. A plugin MUST NOT be able to change its own manifest, its grant, or another plugin's grant. There is no `grant/update` method; re-granting requires a new host session that a user or policy must authorise.
3. Every plugin effect is receipted with `capabilityId = plugins.invoke` **plus** the inner capability ID in `details`, so an auditor can see both the envelope and the intent.
4. A plugin MAY contribute a `ToolDeclarationV1`, but the declaration still travels through Guard at call time; a declared capability the session lacks is a runtime `HZ_POLICY_DENIED`, not a load-time failure. The mismatch between declared capabilities (load time) and effective ones (call time) MUST be reported to the user at load time so the friction is visible before the first failure.
5. Hook contributions are limited to `allow`/`ask`/`deny`/`noop` outcomes, and `allow` is capped by session policy: a hook's `allow` MUST NOT override a `deny` (doc 05 `HookDefV1`).
6. A plugin process that touches a path outside its declared `fsRoots` MUST have the offending effect refused before execution wherever the host mediates it, MUST emit `hz.error.raised`, and MUST record the residual; a second attempt MUST terminate the plugin host session.

#### 4.7.5 Worked plugin exchange

**Example 16 — a plugin tool that must be denied correctly**

```json
<-- {"jsonrpc":"2.0","id":"pl-1","method":"tool/invoke","params":{
      "invocationId":"inv_01J9Z9D2K0…","toolId":"acme.jira.open_issue",
      "args":{"key":"HZ-42"},
      "context":{"toolCallId":"tcl_01J9Z9D2K1…","sessionId":"sess_01J9Z8Q7K3M4N5P6Q7R8S9T0V1",
                 "workspaceRoot":"/home/dev/project",
                 "posture":{"sandboxMode":"workspace-write","networkPolicy":"none"},
                 "grantedCapabilities":["plugins.invoke","net.fetch","memory.read"],
                 "budgetLimits":{"maxOutputTokens":"20000"}},
      "deadlineMs":15000}}

--> {"jsonrpc":"2.0","id":"pl-2","method":"effects/request","params":{
      "capabilityId":"net.fetch","action":"net.fetch",
      "args":{"url":"https://acme.atlassian.net/rest/api/3/issue/HZ-42","method":"GET"},
      "resource":{"resourceKind":"endpoint","target":"acme.atlassian.net"},
      "idempotency":"idempotent","deadlineMs":15000}}

<-- {"jsonrpc":"2.0","id":"pl-2","result":{
      "effectId":"eff_01J9Z9D3M7…","decision":"Deny","terminal":"DENIED","receiptId":"rcp_01J9Z9D3M8…",
      "error":{"hzCode":"HZ_POLICY_DENIED","category":"Authorization","retryClass":"Never",
               "details":{"reasonCode":"denied_by_policy","networkPolicy":"none"}}}}

--> {"jsonrpc":"2.0","id":"pl-1","error":{"code":-32013,"message":"network egress is disabled in this session",
      "data":{"hzCode":"HZ_POLICY_DENIED","category":"Authorization","retryClass":"Never",
              "receiptId":"rcp_01J9Z9D3M8…","subjectIds":["eff_01J9Z9D3M7…"]}}}
```

Two properties are visible here: the denial is receipted (`rcp_…`), and the refusal reaches the plugin as a typed protocol error **plus** a structured decision, so the plugin can distinguish "no" from "broken". A plugin that retries a `DENIED` effect is misbehaving, and the host MUST close the invocation after a repeated violation.

### 4.8 (h) The SDK surface

> **DESIGN ONLY: NOT IMPLEMENTED.** Nothing is generated. Deferral note K9 (owned by G7 in docs/14).

Four generated SDKs share one schema. No SDK hand-writes a transport method (C39).

| SDK | Package | Crate/folder | Style | Notes |
|---|---|---|---|---|
| TypeScript | `@horizoncode/sdk` | `packages/sdk` | `const hz = new HorizonClient({transport}); await hz.sessions.submit({...})` | the reference implementation, generated from `@horizoncode/protocol`; also usable in the browser over WS |
| Python | `@horizoncode/sdk-python` | `packages/sdk-python` | `hz = HorizonClient(transport=StdioTransport("hzcode")); hz.sessions.submit(...)` | sync and async variants; `asyncio` transport for the server |
| Go | `@horizoncode/sdk-go` | `packages/sdk-go` | `c, _ := horizon.Dial(ctx, cfg); c.SessionsSubmit(ctx, req)` | context-first signatures; no runtime reflection |
| Rust | `@horizoncode/sdk-rust` `[planned]` | crate `hz_sdk` (registered in `_conventions.md` §4) | `let c = Client::connect(transport).await?; c.sessions().submit(req).await?` | generated from the *protocol* types, not the kernel ABI types |

Every SDK exposes exactly: (1) a transport layer (stdio, UDS, TCP, WS); (2) generated request/response types and method wrappers; (3) a subscription helper that yields typed events with cursor and ack handling; (4) typed errors carrying `hzCode`, `category` and `retryClass`. Ergonomic helpers (retry on `SafeQueryRetry`, event iteration, wait-for-idle) live in a separate, non-generated namespace and are listed in a manifest so the parity ratchet can distinguish generated from hand-written surface.

**Version pinning.** Each SDK release declares `hzProto`, the protocol schema digest it was generated from, and the minimum server version it supports. At `initialize`, a digest mismatch fails closed with `HZ_PROTO_TOO_OLD`; a newer server with backward-compatible additions only warns.

### 4.9 (i) Versioning and compatibility

#### 4.9.1 `HZ_PROTO` (client ↔ agent)

| Change kind | Must bump? | Gate | Example |
|---|---|---|---|
| Add an optional field to a request or result | no | feature flag + capability negotiation | adding `coalesce.windowMs` to `hz.subscribe` |
| Add a method | no | feature advertised in `initialize` | adding `hz.session.rewind` |
| Add an optional feature (for example `subscribe.replay`) | no | required/optional feature negotiation (C2) | — |
| Add a value to a non-authority enum | no | feature flag; consumers treat unknown values as `UNKNOWN` (doc 05 D8) | a new `PartV1.type` variant |
| Remove or rename a method, operation or required field | **yes** | deprecation window (C42) | removing `hz.memory.retain@1` |
| Change a field's type or meaning | **yes** | deprecation window + migration | re-meaning `InputAdmissionV1.delivery` |
| Add a value to an authority enum (posture, decision, terminal state, capability) | **yes** | — | a fourth posture preset |
| Change an error code's meaning | **yes** | — | (C43) |

#### 4.9.2 `HZ_ABI` (agent ↔ kernel)

> **DESIGN ONLY.** `HZ_ABI` is not defined in code. `HZ_PROTO = 1` is, and `server.hello` returns it.

Same rules applied to the kernel envelope, the operation strings, and kernel-side payloads. Additional kernel-specific rules: (1) the handshake negotiates `minProtocol`/`maxProtocol` and feature lists before any application request (C14); (2) an agent that cannot meet the kernel's minimum MUST enter `degraded_read_only`, never attempt unguarded execution; (3) a kernel that cannot meet the agent's minimum MUST reject the handshake with `HZ_PROTO_TOO_OLD` and stay in a refusing state rather than serve partial authority; (4) the kernel build digest is reported in `hello_result` and copied into every receipt, so a receipt is tied to the exact kernel that produced it.

#### 4.9.3 Deprecation policy

1. A deprecation MUST be declared in the schema (`deprecated: {since, removalProto, replacement}`) before any implementation change.
2. The deprecated item MUST still work for at least 90 days **and** at least one protocol cycle (C42).
3. `hz.initialize` MUST advertise deprecated items with their replacement; REST MUST add `HZ-Deprecated: <item>; replacement=<item>`; SDKs MUST mark generated methods deprecated with the replacement in the doc comment.
4. Removal MUST land only in a `HZ_PROTO` bump, MUST be listed in the changelog together with the evidence that no first-party surface still used it, and MUST ship with an actionable error (`HZ_UNSUPPORTED_FEATURE` with `details.replacement`).
5. A deprecated item MUST NOT be removed for another reason earlier: "we replaced it internally" is not a deprecation trigger.

#### 4.9.4 Generated-code rules

1. Generated code lives only in `packages/protocol/src/generated/**`, `crates/hz_abi/src/generated/**` and the generated portions of each SDK; a CI gate (`codegen-clean`) fails when committed output differs from `hz_codegen` output (doc 05 D2).
2. Every generated file carries `DO NOT EDIT`, the generator version, and the schema digest it was produced from.
3. Generated code MUST NOT contain business logic, retries, logging or defaults beyond schema defaults; those belong to the hand-written layer.
4. Generated code MUST NOT import from a higher layer: `protocol` is the root of the dependency graph (the opencode/Reasonix lesson, vision §3.3).
5. A schema change MUST regenerate all four SDKs and the Rust ABI types in the same change; the `proto-lock.json` digest MUST be updated and reviewed in that diff.

### 4.10 (j) The error model

> **PARTIAL.** Server errors use JSON-RPC numbers (`-32601`, `-32602`, `-32603`); kernel errors are `{message}`; refusals carry stable string markers. The `TypedErrorV1` carrier, code registry and retry classes are design only. Deferral note K10.

#### 4.10.1 The carrier

One carrier is used everywhere: the kernel ABI's `TypedErrorV1` shape, exposed as the JSON-RPC `error.data` object and as the REST error body.

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | symbolic HorizonCode code, e.g. `HZ_POLICY_DENIED`; stable (C43) |
| `category` | `ErrorCategoryV1` | `Validation`, `Conflict`, `Authorization`, `Capability`, `NotFound`, `Unavailable`, `Deadline`, `Uncertain`, `Corruption`, `Internal` |
| `message` | `string` | human-readable, redacted, greppable, never containing a secret |
| `retryClass` | `RetryClassV1` | `Never`, `SafeQueryRetry`, `RetryAfterReconciliation`, `RetryAfterContextRecovery`, `UserActionRequired`, `RetryWithNewId` |
| `retryAfterMs` | `u64?` | hint for `SafeQueryRetry`/`Unavailable` paths |
| `ownerCursor` | `string?` | the position a kernel-aware client should resume from |
| `subjectIds` | `[]Id` | the objects the error is about, so a UI can deep-link |
| `details` | `JsonValue?` | a small, schema-checked map: never a stack trace, never a secret |

#### 4.10.2 Code registry

| Numeric | `code` | Category | Retry class | Meaning | Fail-closed class |
|---|---|---|---|---|---|
| `-32700` | `HZ_PARSE` | `Validation` | `Never` | malformed frame | yes |
| `-32600` | `HZ_INVALID_REQUEST` | `Validation` | `Never` | not a valid request object | yes |
| `-32601` | `HZ_METHOD_NOT_FOUND` | `NotFound` | `Never` | unknown method | yes |
| `-32602` | `HZ_INVALID_PARAMS` | `Validation` | `Never` | params failed schema validation | yes |
| `-32603` | `HZ_INTERNAL` | `Internal` | `Never` | unexpected defect | yes |
| `-32000` | `HZ_GENERIC` | `Internal` | `Never` | fallback; MUST NOT be used when a specific code exists | yes |
| `-32001` | `HZ_UNAUTHENTICATED` | `Authorization` | `UserActionRequired` | missing or invalid credential | yes |
| `-32002` | `HZ_FORBIDDEN` | `Authorization` | `Never` | authenticated but not permitted for this surface or resource | yes |
| `-32003` | `HZ_NOT_FOUND` | `NotFound` | `Never` | unknown session, receipt, artifact, … | yes |
| `-32004` | `HZ_CONFLICT` | `Conflict` | `RetryWithNewId` | idempotency mismatch, stale fence, duplicate ordering | yes |
| `-32005` | `HZ_PRECONDITION_FAILED` | `Conflict` | `UserActionRequired` | `If-Match` or binding mismatch; re-read then retry | yes |
| `-32006` | `HZ_RATE_LIMITED` | `Unavailable` | `SafeQueryRetry` | limiter or quota | no (retryable) |
| `-32007` | `HZ_BUSY` | `Unavailable` | `SafeQueryRetry` | a transiently busy subsystem | no |
| `-32008` | `HZ_BUDGET_EXHAUSTED` | `Capability` | `UserActionRequired` | budget stop applied at a step boundary | yes (mutation stops) |
| `-32009` | `HZ_KERNEL_UNAVAILABLE` | `Unavailable` | `UserActionRequired` | kernel absent, crashed or ABI-incompatible; app is `degraded_read_only` | yes (no unguarded execution) |
| `-32010` | `HZ_UNSUPPORTED_FEATURE` | `Capability` | `Never` | a required feature or method is unsupported by this build or peer | yes |
| `-32011` | `HZ_PROTO_TOO_OLD` | `Validation` | `UserActionRequired` | peer protocol or ABI below the supported minimum | yes |
| `-32012` | `HZ_POSTURE_CONFIRMATION_REQUIRED` | `Authorization` | `UserActionRequired` | widening requested without an interactive human confirmation | yes |
| `-32013` | `HZ_POLICY_DENIED` | `Authorization` | `Never` | Guard returned `Deny`; a receipt with `DENIED` exists | yes |
| `-32014` | `HZ_CAPABILITY_NOT_GRANTED` | `Capability` | `Never` | outside the ceiling, or not granted to this plugin, server or child | yes |
| `-32015` | `HZ_APPROVAL_REQUIRED` | `Authorization` | `UserActionRequired` | an `Ask` decision is pending | yes (the effect waits) |
| `-32016` | `HZ_LEASE_EXPIRED` | `Authorization` | `RetryWithNewId` | lease expired, revoked or consumed; a new decision is required | yes |
| `-32017` | `HZ_EFFECT_UNKNOWN` | `Uncertain` | `RetryAfterReconciliation` | the effect's terminal state is `UNKNOWN` | yes (no auto-retry) |
| `-32018` | `HZ_RECONCILIATION_REQUIRED` | `Uncertain` | `RetryAfterReconciliation` | completion or retry attempted with an open `UNKNOWN` | yes |
| `-32019` | `HZ_CLAIM_HELD` | `Conflict` | `SafeQueryRetry` | another live process holds the session claim | no |
| `-32020` | `HZ_DEADLINE_EXCEEDED` | `Deadline` | `UserActionRequired` | the request budget elapsed | no |
| `-32021` | `HZ_CONTEXT_RECOVERY_REQUIRED` | `Uncertain` | `RetryAfterContextRecovery` | context or epoch reconciliation needed before continuing | yes |
| `-32022` | `HZ_UNKNOWN_DIMENSION` | `Capability` | `Never` | a required sandbox guarantee is unavailable; the residual is named in `details` | yes |
| `-32023` | `HZ_TRUST_REQUIRED` | `Authorization` | `UserActionRequired` | a workspace program, plugin or server needs a trust decision | yes (inert until trusted) |
| `-32024` | `HZ_ARTIFACT_INTEGRITY` | `Corruption` | `Never` | content address did not verify, or a hash chain is broken | yes |
| `-32025` | `HZ_CURSOR_RESET` | `Conflict` | `RetryAfterContextRecovery` | the event cursor is no longer retained; re-snapshot | no |
| `-32026` | `HZ_SANDBOX_PROBE_FAILED` | `Unavailable` | `UserActionRequired` | the sandbox probe failed; effects requiring that dimension are refused | yes |
| `-32027` | `HZ_REDACTION_REQUIRED` | `Validation` | `UserActionRequired` | content carried a secret; supply a reference instead | yes |

**Wire vocabulary vs internal diagnostics.** The `HZ_*` codes above are the only codes that cross a surface — JSON-RPC `error.data`, REST bodies, CLI diagnostics, SDK errors. Other code families are internal and MUST NOT appear in a wire carrier: the log-invariant codes of `06-events-and-flows.md` §5 (`LOG_*`, `SESSION_*`) and the module-internal dotted codes of `04-lld.md` §5.2 (e.g. `session.posture_stale`, `internal.cas_inconsistent`). A surface maps an internal condition to the registered code for its category; `HZ_INTERNAL`/`HZ_GENERIC` are fallbacks only where no specific code exists, and C43 keeps the mapping stable (RC-16(b)).

#### 4.10.3 Status mapping (REST)

| Category | HTTP status |
|---|---|
| `Validation` | `400`, `413` (size), `422` (semantic) |
| `Authorization` | `401` (unauthenticated), `403` (denied), `422` (confirmation required) |
| `Capability` | `403` (not granted or exhausted), `503` (kernel-dependent refusal) |
| `NotFound` | `404` |
| `Conflict` | `409`, `412` (precondition), `410` (cursor) |
| `Unavailable` | `429`, `503` |
| `Deadline` | `504` |
| `Uncertain` | `409` for `HZ_EFFECT_UNKNOWN` and `HZ_RECONCILIATION_REQUIRED` |
| `Corruption` | `500` for `HZ_ARTIFACT_INTEGRITY` (the artifact is unreadable, not missing) |
| `Internal` | `500` |

#### 4.10.4 Fail-closed classes

| Class | Trigger | Enforced behaviour | MUST NOT happen |
|---|---|---|---|
| **Authority unavailable** | kernel absent, crashed, or ABI mismatch | `HZ_KERNEL_UNAVAILABLE`; app runs `degraded_read_only`; every mutating capability is refused with a reason | falling back to unguarded execution |
| **Guarantee unavailable** | required sandbox dimension missing (`HZ_UNKNOWN_DIMENSION`, `HZ_SANDBOX_PROBE_FAILED`) | refuse the effect and surface the typed residual | silently degrading isolation (P6) |
| **Trust absent** | a workspace program, plugin, MCP server, LSP server or workflow has no trust decision | `HZ_TRUST_REQUIRED`; the item stays inert | loading it because it was cached |
| **Decision mismatch** | recomputed decision differs from the presented one | `HZ_PRECONDITION_FAILED`; the effect aborts as `DENIED` | using a stale decision |
| **Integrity broken** | digest mismatch, broken receipt chain, corrupt step record | refuse the read or replay; raise `HZ_ARTIFACT_INTEGRITY` or `Corruption` | serving unverified content or replaying partially |
| **Unknown settlement** | `terminal: UNKNOWN` | `HZ_EFFECT_UNKNOWN`; block completion; require reconciliation | retrying automatically or reporting success |
| **Secret exposure risk** | a value-bearing secret reaches a schema field or a log | refuse with `HZ_REDACTION_REQUIRED` | writing the redacted-but-present value |
| **Protocol drift** | peer below the supported minimum, or a required feature missing | `HZ_PROTO_TOO_OLD` / `HZ_UNSUPPORTED_FEATURE`; refuse the connection | best-effort degradation of a required contract |

## 5. Errors & failure modes

§4.10 defines the codes; this section defines the behaviour behind them, per surface, including what is fail-closed.

### 5.1 Failure matrix

| # | Failure | Surface | Detection | Behaviour | Fail closed? |
|---|---|---|---|---|---|
| F1 | Kernel process absent at startup | ABI | connect/`hello` fails | `hz.initialize` reports `kernel.state=unavailable`; app enters `degraded_read_only`; every mutating call returns `HZ_KERNEL_UNAVAILABLE` | yes |
| F2 | Kernel declares an older `HZ_ABI` | ABI | handshake negotiation | refuse the handshake; agent enters `degraded_read_only`; the diagnostic names both revisions | yes |
| F3 | Kernel crashes mid-run | ABI | channel close + missing heartbeats | in-flight effects remain in their last durable phase; unfinished effects settle as `UNKNOWN` on kernel recovery; the session cannot complete until reconciliation; the client is told via `hz.kernel.status` and `hz.error.raised` | yes |
| F4 | Two writers hold a claim for one session | Controller | `fenceToken` comparison | the older writer's writes are refused with `HZ_CLAIM_HELD`; the `EXECUTION_CLAIM.fenceToken` monotonic rule decides the winner | yes |
| F5 | Client disconnects mid-turn | Controller | transport close | the claim stays held and heartbeating; on TTL expiry the claim is reclaimable and resumable (`hz.session.resume`); the transcript is already durable | no (recoverable) |
| F6 | Slow subscriber | events | bounded queue full | `page_end`, then `resnapshot_required`; the server MUST NOT buffer without bound (C11) | no |
| F7 | Client resumes from a dropped cursor | events | cursor below the retention window | `410 HZ_CURSOR_RESET` with the latest cursor (C28) | no |
| F8 | Replayed mutating request with a different payload | Controller / REST | idempotency key + digest compare | `HZ_CONFLICT` with both digests in `details` | yes |
| F9 | Approval expires before an answer | Controller | approval TTL | the pending effect is `DENIED` with `denied_by_grant_expired`; the step continues without that call | yes (that effect) |
| F10 | `If-Match` missing or stale on posture/config | REST / Controller | precondition check | `428` (missing) or `412` plus `HZ_PRECONDITION_FAILED`; the previous value remains in force | yes |
| F11 | Posture widening attempted without an interactive token | Controller | `confirmToken` absent | `HZ_POSTURE_CONFIRMATION_REQUIRED`; nothing changes | yes |
| F12 | Child spawn requests a widening grant or an over-budget envelope | Controller | subset computation | refused before the child session exists (`HZ_CAPABILITY_NOT_GRANTED` / `HZ_BUDGET_EXHAUSTED`) | yes |
| F13 | Workspace config tries to widen authority | Controller / config | lattice meet | the value is ignored, a narrowing diagnostic is emitted, and the session proceeds narrowed | yes (narrowed, not widened) |
| F14 | Workspace program is untrusted | Controller / MCP / plugin | trust store lookup | the item is inert; `HZ_TRUST_REQUIRED`; the rest of the session runs | yes (inert) |
| F15 | Plugin signature invalid or API version unsupported | plugin | manifest verification | the plugin does not load at all (C37/C38); other plugins are unaffected | yes (that plugin) |
| F16 | Plugin requests an undeclared capability | plugin | grant comparison | the effect is refused, receipted, and reported; a repeated violation terminates the host session (§4.7.4) | yes |
| F17 | MCP server disconnects mid-call | MCP client | transport close | the effect settles `FAILED` or `UNKNOWN` (never `SUCCEEDED`); reconciliation applies as with any host effect | yes |
| F18 | MCP client asks for an ungranted tool | MCP server | grant table | `isError: true` with `HZ_CAPABILITY_NOT_GRANTED` and the grant named; no effect is submitted | yes |
| F19 | ACP client requests a widening mode | ACP | preset chain | refused with the same confirmation requirement as the TUI; the mode does not change | yes |
| F20 | ACP `session/load` for a session whose step records are corrupt | ACP | replay verification | the load fails with `HZ_ARTIFACT_INTEGRITY` / `Corruption`; a partial transcript MUST NOT be presented as the session | yes |
| F21 | Artifact digest mismatch on read | any | CAS verification | refuse with `HZ_ARTIFACT_INTEGRITY`; raise an error event | yes |
| F22 | Receipt chain break detected | Controller / REST | `hz.kernel.receipt.verify` | `verified: false` with `brokenAt`; the session's completion is refused and the verdict is `unknown`/`fail` | yes |
| F23 | Eval run quarantined while a proposal cites it | learn | cross-check on apply | the apply is refused with `HZ_PRECONDITION_FAILED` and the offending run named | yes |
| F24 | Proposal apply attempted by an agent principal | learn | approver kind check | refused with `HZ_FORBIDDEN`; the approval is not recorded | yes |
| F25 | Rate limit or quota exhausted on a provider | provider path | provider response / limiter | the step fails with `HZ_RATE_LIMITED` (`SafeQueryRetry`) or `HZ_BUDGET_EXHAUSTED`; the receipt records the failed inference | no |
| F26 | Deadline exceeded on a long tool | Controller | deadline timer | the client gets `HZ_DEADLINE_EXCEEDED`; the effect continues to settlement and is reported through the event stream, never silently dropped | no |
| F27 | Secret detected in an outgoing payload | any | secret scanner | refuse with `HZ_REDACTION_REQUIRED`; the caller must pass a reference | yes |
| F28 | Sandbox probe fails for a required dimension | kernel | probe result | `HZ_SANDBOX_PROBE_FAILED` / `HZ_UNKNOWN_DIMENSION`; effects needing that dimension are refused; the residual is surfaced as a typed value | yes |

### 5.2 Invariants that carry across every failure above

1. **No failure produces a success-looking answer.** A refused effect returns a typed error *and* leaves a receipt (`DENIED`), a pending effect returns `HZ_APPROVAL_REQUIRED`, and an unresolved effect returns `HZ_EFFECT_UNKNOWN` with `reconciliationRequired: true`.
2. **No failure silently widens authority.** Every degradation moves in one direction: fewer capabilities, more prompting, less isolation.
3. **No failure loses durability.** Admission, claims, parts and receipts are durable before the response that depends on them; a crash after a response means the response is replayable, not that the work is lost.
4. **Every failure is attributable.** The error names `subjectIds` (session, call, effect, receipt) so a user can inspect the exact object and its receipt.

---

## 6. Flows

### 6.1 A full turn across four surfaces (TUI → Controller → kernel → events)

1. The TUI opens `hz.initialize` on stdio, then `hz.subscribe` with `topics:[session,step,tool,effect]`, `since` = the last cursor it stored for this session.
2. The user types a request; the TUI calls `hz.session.submit` with `delivery=steer` and an `idempotencyKey`.
3. The Controller writes `PromptV1` + `InputAdmissionV1` and returns the admission; the TUI renders a queued item from the admission event (before the model sees anything).
4. The runner claims the session and starts a step; `hz.step.started` and `hz.step.llm.requested` arrive; deltas stream as `hz.step.llm.delta` and are coalesced for rendering.
5. The model declares a tool call; `hz.step.tool.requested` arrives. The orchestrator submits `EffectRequestV1` to `hzk` over the ABI.
6. Guard returns `Ask`; `hz.permission.asked` arrives; the TUI renders the preview and the option row.
7. The user picks "allow once"; the TUI calls `hz.approval.respond`; the kernel issues a one-use lease; the effect executes; `hz.effect.settled` arrives with the receipt id.
8. The step closes its tool batch, and the next step runs — one `llm.stream` per step (ADR-011).
9. On `end_turn` the claim is released (`hz.session.claim.released`), the session goes `idle`, and the TUI marks the turn complete.
10. The user runs `hzcode session verify` (or the TUI's verify action, `hz.session.verify`): the receipt chain and the evidence gate produce a verdict, and any claim the receipts do not support is listed as lowered.

### 6.2 Crash and resume (the durability story)

1. The process dies with a claim held. The claim row remains `held` with its `lastSeq` and `fenceToken`.
2. A new process starts, re-handshakes with the kernel (possibly recovering a new `ownerEpoch`), and finds the orphaned claim.
3. `hz.session.resume` acquires a claim with `fenceToken = previous + 1` and `resumedFromClaimId` set; any part still projected as `running` is durably failed as `interrupted` (never silently replayed).
4. Effects that were executing at the moment of death are re-probed: the kernel settles them `SUCCEEDED`, `FAILED` or `UNKNOWN`; an `UNKNOWN` requires `hz.kernel.reconcile` before the session may complete.
5. Admitted-but-unpromoted input survives in the inbox and is promoted at the next safe boundary, so nothing the user typed is lost.

### 6.3 Cross-surface parity flow (why the ratchet matters)

1. A capability starts as a Controller method and a schema.
2. The generator produces: TS/Python/Go/Rust SDK methods, the REST route table candidates, the CLI verbs and the TUI action descriptors.
3. The parity ratchet compares five lists — Controller methods, REST routes, SDK methods, CLI verbs, TUI actions — and fails CI when one is missing a member that the others have, unless the missing surface declares an explicit exemption with a reason and a tracking issue.
4. The same mechanism covers the ACP surface in the other direction: an ACP capability advertised in `initialize` MUST have a Controller implementation behind it.

### 6.4 An external agent driving HorizonCode over MCP

1. An MCP client (another agent, an IDE, a CI job) connects to `hzcode mcp serve` and completes the MCP handshake.
2. `tools/list` returns the read-only set; `hz_tool_invoke` is absent until granted.
3. The client calls `hz_submit`; a session is created and its id returned.
4. The client polls `hz_session_status` or subscribes to `hz://session/{id}` resources.
5. A mutating step needs a human; the MCP server exposes the pending approval through `hz_session_status` (`waitingOn`) and refuses `hz_approve` because the client principal is an agent — the approval MUST come from a human surface.
6. The client calls `hz_session_verify` and receives the verdict with any lowered claims and open unknowns named.

---

## 7. Security & authority

### 7.1 Trust boundaries

| Boundary | Who is on each side | Authentication | Authority rule |
|---|---|---|---|
| Front-end ↔ Controller | TUI/web/desktop/IDE/SDK vs the orchestrator | transport auth (stdio ownership, bearer, mTLS, OIDC, JWT) | a front-end can request; it can never decide |
| Controller ↔ kernel | TS runtime vs `hzk` | OS peer credentials before `hello` (C16) | every mutating effect needs a decision and a one-use lease |
| Controller ↔ plugin | host vs sandboxed plugin | manifest digest + sandbox mode | the plugin requests; the host decides; the plugin never holds a kernel channel |
| Controller ↔ MCP server | host vs external process/service | transport + trust class | an MCP call is an `mcp.invoke` effect; a server's self-report is never evidence |
| User ↔ workspace content | human vs repository files | trust store (path + digest) | workspace config and programs may only narrow; they are inert until trusted |
| Client ↔ artifacts | any principal vs the CAS | `ArtifactV1.access` + redaction | a redacted artifact is never served raw (C34) |

### 7.2 Capability mapping per surface

| Surface | Capabilities it may exercise on behalf of a caller | How they are narrowed |
|---|---|---|
| TUI / print | everything in the session ceiling | posture + rules + approvals |
| Server (REST/SSE) | the caller principal's permitted subset | auth mode → `PrincipalRef` → rules; `viewer` roles cannot mutate |
| ACP (agent) | the session ceiling | ACP permissions map to Guard `Ask` (C30) |
| ACP (client) | the *target agent's* capabilities; HorizonCode contributes context only | no capability is borrowed from the editor |
| MCP server | a read-only default plus per-tool grants | `HZ_CAPABILITY_NOT_GRANTED` per tool (C32) |
| MCP client | `mcp.invoke` + whatever the server does (which is outside our control) | receipted, timeout-bounded, trust-classed |
| Plugin | `plugins.invoke` + granted subset | `request ∩ ceiling ∩ trust` (C36) |
| SDK | exactly what the connecting principal has | generated methods do not imply authority |
| Kernel ABI | the complete set, but only via decision + lease | decision is recomputable and single-use |

### 7.3 Threats this contract specifically addresses

1. **Authority spoofing.** `origin.kind` is host-assigned; a client or model cannot send `UserAction` (§4.1.3 item 4; doc 05 D15).
2. **Replay.** One-use leases bound to `argumentsDigest` + idempotency keys + `fenceToken` on claims (C5, C18, F4).
3. **Trust-the-model.** No API returns a success derived from model text; observations are host-sourced, and `hz.session.verify` can only lower claims.
4. **Silent degradation.** Every degradation is a typed residual plus an error code plus a visible `hz.kernel.status` field (F28, doc 05 §5.4).
5. **Config-facilitated RCE.** Workspace programs are inert until trusted; workspace config can only narrow (F13, F14).
6. **Secret leakage through observability.** Redaction is applied to logs, transcripts, receipts and event frames; a payload that fails the scanner is refused rather than silently rewritten (F27).
7. **Confused deputy across surfaces.** Each surface maps to a `PrincipalRef`; an MCP or ACP client with an agent principal never obtains human-only actions such as approving or widening (C32, F24).
8. **Unbounded blast radius.** Budgets, concurrency ceilings, depth limits and worktree isolation are enforced at their owning layer and reported on the wire, so a runaway child is visible and stoppable through `hz.session.tree` and `hz.run.cancel`.

---

## 8. Performance budgets

Protocol-level targets. All are **targets**, not measurements. A subset of the runtime now exists (`docs/28-implementation-status.md`: the NDJSON kernel protocol with 8 methods, the HTTP-free provider adapters, the tool contract); the HTTP/SSE/ACP/MCP/SDK surfaces in this document are still design, and none of these numbers has been measured. Measurement is a recorded work item in `docs/28` §4.

| Operation | Budget | Notes |
|---|---|---|
| `hz.initialize` round trip (local stdio) | ≤ 25 ms p95 | includes kernel status handshake, which is timeout-bounded |
| Request/response overhead (non-effect method) | ≤ 2 ms p95 server-side | excludes the work the method performs |
| `hz.session.submit` → admission durable | ≤ 10 ms p95 | one transaction: prompt + inbox + event |
| Event fan-out to 5 subscribers | ≤ 1 ms p95 per subscriber | from the committed event, in-process |
| `hz.subscribe` replay throughput | ≥ 20 000 events/s | paginated; `page_end` every ≤ 500 events or 8 KiB |
| SSE frame latency (committed event → socket write) | ≤ 15 ms p95 | local loopback |
| Kernel ABI request round trip (non-effect) | ≤ 3 ms p95 | UDS + MessagePack, no fsync |
| `effect.authorize` | (budget owned by 08 §8) | the Guard decision budget: `08-runtime.md` §8 |
| `effect.settle` incl. receipt fsync | (budget owned by 08 §8) | the receipt-settle budget: `08-runtime.md` §8 |
| `hz.kernel.policy.reload` (≤ 2 000 rules) | ≤ 25 ms p95, atomic | a failed reload costs nothing |
| `hz.kernel.receipt.verify` (1 000 receipts) | ≤ 300 ms p95 | chain walk |
| `hz.session.verify` (1 000 receipts, full mode) | ≤ 1.5 s p95 | includes evidence checks |
| Plugin `tool/invoke` overhead (excluding the tool) | ≤ 5 ms p95 | channel + validation |
| MCP `tools/list` (≤ 100 tools) | ≤ 40 ms p95 | including schema serialisation |
| Rate-limit/circuit-breaker overhead | ≤ 0.5 ms per call | must not dominate short calls |
| Backpressure threshold | queue ≤ 4 096 events or 2 MiB per subscriber | beyond that: `page_end` + `resnapshot_required` |

---

## 9. Tests

> **No test named CT1 to CT50 exists.** Related tests that do: `app/tests/core/interop.test.ts`, `canon-numbers.test.ts`, `framing.test.ts`, `server.test.ts`, `kernel-trusted.test.ts`, `kernel-hardening.test.ts`, `providers-expansion.test.ts`, `catalog.test.ts`. Deferral note K11.

Contract tests. `Gate = yes` means CI fails the build on violation. The last column names what the test proves; rule ids refer to §2.

| # | Contract test | How it is performed | Proves | Gate |
|---|---|---|---|---|
| CT1 | Envelope schema conformance | golden request/response fixtures per method, parsed against generated schemas | C1, C3, C4 | yes |
| CT2 | Canonical-name check | lint: every method on the wire matches `^hz\.[a-z]+\.[a-z]+$` and appears in the schema | C1 | yes |
| CT3 | Feature-negotiation matrix | connect a client requiring a disabled feature ⇒ `HZ_UNSUPPORTED_FEATURE` + close; optional feature unavailable ⇒ connection proceeds; an unlisted feature name ⇒ rejected | C2, §4.1.5 | yes |
| CT4 | Integer safety | send `9007199254740993` as a JSON number in a `u64` field ⇒ `HZ_INVALID_PARAMS` | C3 | yes |
| CT5 | Batch rejection | send a JSON-RPC batch array ⇒ `HZ_INVALID_REQUEST` | C4 | yes |
| CT6 | Idempotency replay | repeat every mutating call with the same key ⇒ same result, `replayed: true`, no second effect, no second event | C5 | yes |
| CT7 | Idempotency conflict | same key, different payload ⇒ `HZ_CONFLICT` with both digests | C5, F8 | yes |
| CT8 | Per-session ordering | a fuzz subscriber asserts gap-free, monotone `seq` per session under concurrent writers | C6 | yes |
| CT9 | Deadline enforcement | a method that sleeps past its deadline ⇒ `HZ_DEADLINE_EXCEEDED`, and the in-flight effect still reports settlement | C7, F26 | yes |
| CT10 | Cancellation semantics | `hz.session.interrupt` returns an ack while the claim is still held; only `hz.session.claim.released` turns the run terminal | C8 | yes |
| CT11 | Delta ephemerality | kill the transport during streaming; reconnect and read the log ⇒ the final part is present with `frozen: true` and no delta is required | C9 | yes |
| CT12 | At-least-once + resnapshot | force a slow subscriber past the queue limit ⇒ `page_end` then `resnapshot_required`, never a silent gap | C10, C11, F6 | yes |
| CT13 | Framing equivalence | the same event captured over JSON-RPC, SSE and NDJSON parses to an identical envelope | C12 | yes |
| CT14 | Kernel framing | send a JSON frame to the kernel socket ⇒ channel closed, no dispatch | C13 | yes |
| CT15 | Handshake ordering | send an application request before `hello` or before `Ready` ⇒ refused, channel closed | C14 | yes |
| CT16 | Stale epoch rejection | replay a request with an old `ownerEpoch` ⇒ `HZ_CONFLICT` | C15 | yes |
| CT17 | Peer authentication | connect to the kernel socket as a different user/group ⇒ closed before `hello` | C16 | yes |
| CT18 | Kernel idempotency | repeat an identical kernel request ⇒ one execution, identical response body | C17 | yes |
| CT19 | Effect sequence enforcement | call `effect.execute` without a lease, or with a mismatched binding ⇒ refused, no execution | C18 | yes |
| CT20 | Terminal monotonicity | second `effect.settle` with a different terminal ⇒ `HZ_CONFLICT`/`Corruption`, `hz.error.raised` emitted | C19 | yes |
| CT21 | Unknown resolution path | attempt to settle an effect already `UNKNOWN` ⇒ refused; only `effect.reconcile` changes its disposition | C20 | yes |
| CT22 | Atomic policy reload | interrupt `policy.load` mid-way (fault injection) ⇒ either the old or the new policy is fully in force, never a mix | C21 | yes |
| CT23 | Policy digest mismatch | reload with a wrong `expectedDigest` ⇒ refused, old policy still active, a diagnostic is emitted | C21 | yes |
| CT24 | Budget query purity | snapshot budget, run `budget.query` 1 000 times, snapshot again ⇒ identical consumed/reserved | C22 | yes |
| CT25 | Error carrier completeness | every failure path in a fault-injection suite returns `code`, `category`, `retryClass` | C23 | yes |
| CT26 | Parity ratchet | compare Controller methods, REST routes, SDK methods, CLI verbs, TUI actions; fail on an unexplained asymmetry | C24, C39 | yes |
| CT27 | Bind/auth safety | `--listen 0.0.0.0` without an auth mode ⇒ startup refused; loopback with `none` ⇒ starts with a warning | C25, C26 | yes |
| CT28 | Precondition handling | `PUT posture` without `If-Match` ⇒ `428`; with a stale digest ⇒ `412` and the old posture stays | C27, F10 | yes |
| CT29 | Cursor reset | restart with a pruned retention window and resume an old cursor ⇒ `410 HZ_CURSOR_RESET` + latest cursor | C28, F7 | yes |
| CT30 | Status-code determinism | every code in §4.10.2 maps to the same status across 100 repeats | C29 | yes |
| CT31 | ACP permission mapping | an ACP permission request produces a Guard `Ask` decision and its answer produces a lease-bearing receipt; no ACP-local permission state exists | C30 | yes |
| CT32 | ACP load purity | `session/load` with a recording provider and a mock tool layer ⇒ zero provider calls, zero tool executions | C31 | yes |
| CT33 | MCP default posture | a fresh MCP server exposes no mutating tool and refuses `hz_tool_invoke` per tool | C32, F18 | yes |
| CT34 | MCP sampling accounting | a sampling request charges the caller's budget and produces a `providers.infer` receipt | C33 | yes |
| CT35 | Artifact access control | read a `session`-scoped artifact as another session ⇒ `HZ_FORBIDDEN`; read a redacted artifact ⇒ redacted bytes or refusal, never raw | C34, F21 | yes |
| CT36 | Plugin grant intersection | a manifest requesting `net.fetch` in a `networkPolicy=none` session ⇒ `net.fetch` absent from `grantedCapabilities`; an effect attempt ⇒ refused + receipted | C36, F16 | yes |
| CT37 | Plugin manifest atomicity | a manifest with one invalid contributed tool ⇒ the plugin fails to load; the error names the tool | C37, F15 | yes |
| CT38 | Plugin sandbox enforcement | a plugin resolving a path outside `fsRoots` ⇒ refused before execution; a second attempt terminates the host session | C38, §4.7.4 | yes |
| CT39 | Generated-code cleanliness | `hz_codegen --check` compares committed generated files with regenerated output | C39, C40 | yes |
| CT40 | SDK protocol pinning | an SDK built from an older schema connects ⇒ `HZ_PROTO_TOO_OLD`; a newer additive server ⇒ connects with a warning | C40, §4.8 | yes |
| CT41 | Deprecation visibility | a deprecated method is advertised in `initialize`, marked in the schema, and emits the REST header | C42 | yes |
| CT42 | Unknown-field policy | unknown optional field ⇒ ignored; unknown required field ⇒ `HZ_INVALID_PARAMS`; unknown notification type ⇒ ignored | C44 | yes |
| CT43 | Fail-closed matrix | fault-inject each row of §5.1 and assert the behaviour and the code | §5, §4.10.4 | yes |
| CT44 | No-success-on-unknown | a session with an unresolved `UNKNOWN` cannot report `completed` and `hz.session.verify` returns `unknown`/`fail` naming the reconciliation record | F3, F22, §4.1.3(5) | yes |
| CT45 | Receipt-chain verification | tamper with one stored receipt ⇒ `receipt.verify` returns `verified: false` with `brokenAt` | F22 | yes |
| CT46 | Human-only actions | `hz_approve`, proposal review and posture widening all refuse an agent principal | C32, F24, §7.3 | yes |
| CT47 | Redaction end-to-end | a fixture containing a fake credential is attempted in a prompt, a tool arg, a log field and a receipt field ⇒ each is refused with `HZ_REDACTION_REQUIRED` and nothing is persisted | F27 | yes |
| CT48 | Cross-surface equivalence | the same operation performed through REST, CLI and SDK produces byte-identical results modulo ids/timestamps | C24 | yes |
| CT49 | Crash-resume integrity | kill -9 mid-effect, restart, resume; assert parts are `interrupted` (not `running`), the effect settles once, and the inbox survives | §6.2, F3, F4 | yes |
| CT50 | Record/replay of the protocol | a full session captured with the record/replay harness replays with zero outbound provider calls | §4.1.3(5), doc 05 T29 | yes |

**Additional non-gated checks** (run nightly, report only): fuzz the JSON-RPC surface and the kernel MessagePack decoder with a bounded corpus; measure the §8 budgets and publish the numbers; run the parity ratchet against the latest released SDKs to catch drift between released clients and `main`.

---

## 10. Status

| Capability | Level | Evidence |
|---|---|---|
| Controller protocol (method catalogue, envelope, admission/claim/approval shapes) | `DESIGNED`; a 7-method server protocol (`hzcode serve`) is TESTED per `28-implementation-status.md` | this document; semantic basis source: `specs/v2/session.md` of the ancestor project (not cloned, path not verified) |
| Kernel ABI envelope (`hello`, `request`, `response`, `event`, `control`, `TypedErrorV1`, `ErrorCategoryV1`, `RetryClassV1`) | `DESIGNED`; the 11-method NDJSON kernel protocol is VERIFIED per docs/28; the types named here are `CODE_PRESENT (ancestor)` only | source: `kernel/src/protocol.rs` of the ancestor project (not cloned, path not verified), source: `kernel/src/rpc_handshake.rs` of the ancestor project (not cloned, path not verified) |
| Kernel effect operations (`effect.authorize`/`lease_issue`/`execute`/`observe`/`settle`/`reconcile`) | `DESIGNED`; underlying primitives `CODE_PRESENT (ancestor)` as `guard::authorize`, `EffectHost::handle_request`, `EffectHost::reconcile_effect` | source: `kernel/src/guard.rs` of the ancestor project (not cloned, path not verified), source: `kernel/src/effect_host.rs` of the ancestor project (not cloned, path not verified), source: `kernel/src/effect_host.rs` of the ancestor project (not cloned, path not verified) |
| Managed-domain and worktree operations | `DESIGNED`; ancestor operations exist under different names | source: `kernel/src/host_kernel.rs` of the ancestor project (not cloned, path not verified) (dotted dispatch table), source: `kernel/src/worktree_lifecycle.rs` of the ancestor project (not cloned, path not verified) |
| REST + SSE surface, auth modes, status mapping | `DESIGNED` - no server exists | this document; parity approach from `source: audit/pass2/codex-report.md` |
| Event framing (SSE/NDJSON/JSON-RPC) and cursors | `DESIGNED` | this document; cursor honesty rules derived from the ancestor's owner-cursor and resnapshot semantics |
| ACP surface | `DESIGNED` - no ACP agent is implemented | this document; mapping discipline informed by `source: audit/pass2/opencode-report.part3.md` (`packages/cli/src/acp/*`) |
| MCP server surface | `DESIGNED` - no MCP server is implemented (the stdio MCP CLIENT ships, see docs/15) | this document; capability/authority discipline is ours |
| Plugin API | `DESIGNED` | this document; hook and manifest shapes from `05-domain-and-schemas.md` |
| SDKs (TS, Python, Go, Rust) | `DESIGNED`; nothing generated | §4.8; crate names registered (`hz_sdk` in `_conventions.md` §4), no generator exists |
| Versioning, deprecation, codegen rules | `DESIGNED` | §4.9 |
| Feature-flag registry | `DESIGNED` — names are specified in §4.1.5; no build toggles them yet | §4.1.5 |
| Error model and fail-closed classes | `DESIGNED`; category/retry-class sets `CODE_PRESENT (ancestor)` | source: `kernel/src/protocol.rs` of the ancestor project (not cloned, path not verified) |
| Contract tests CT1–CT50 | `DESIGNED` — no test exists; every gate is a plan | §9 |

**References owned elsewhere.** CLI exit codes are owned by `14-surfaces.md` §2.2 (RC-5). The concrete storage layout and table DDL behind `hz.db` are owned by `12-sessions-state.md`. The event catalogue referenced throughout §4.4 is owned by `06-events-and-flows.md`. Canonical hook lifecycle event names are owned by `05-domain-and-schemas.md` §4.15.3.

**Open items owned by this document**

1. **Unregistered name** — ~~needs a crate name~~ **resolved**: the generated Rust SDK crate is now registered as `hz_sdk` in `_conventions.md` §4 by the conventions owner, with the rule that it is generated from the *protocol* types and never from the kernel ABI types.
2. **Kernel operation names are normalized, not verbatim.** The ancestor dispatches dotted operations such as `artifacts.read_range`, `host_run.bind`, `managed_provider.settle` and `automations.create`. §4.2.2 adopts that style and renames the guard/lease/effect path to `effect.*`. The rename is part of the HorizonCode kernel work and MUST be accompanied by an `HZ_ABI` review: this is a *naming* change to a v1 protocol only because no external client exists yet. If any client exists by the time it lands, the rename requires an `HZ_ABI` bump and a deprecation window.
3. **§8 budgets are unmeasured targets.** They MUST be replaced with measured values (or reported as unmet) before any surface claims `VERIFIED`.
4. **Feature-flag registry** — ~~not yet enumerated~~ **resolved**: the canonical list is published in §4.1.5 (owned by this document per `_conventions.md` §11 RC-9), with the negotiation classes, the surfaces each name enables, and the C41/C42 deprecation interplay; CT3 now tests against it.
5. **Rate-limit policy shape** - ~~unspecified~~ **resolved**: the entitlement model is `RateLimitPolicyV1`, owned by `05-domain-and-schemas.md` §4.9 under rule D39 (meet across matching policies, most-specific scope reported, honest `Retry-After`, tests T33/T34); §4.3.2 references it by name and MUST NOT restate it. One shape, one owner (05), one referencing document (07).
6. **MCP revision pinning — open until the MCP server surface is implemented.** §4.6 targets MCP `2025-06-18`-or-newer; the exact revision HorizonCode pins, and the compatibility promise for older revisions, MUST be fixed in the same change that implements the server, because MCP revisions do introduce breaking changes.
7. **ACP revision pinning — open until the ACP surface is implemented.** §4.5 assumes the ACP revision that supports `session/load`, `sessionModes` and `usage_update`. The pinned revision and the fallback behaviour for clients that lack `loadSession` MUST be stated before implementation.
8. **No receipts for reads on every surface.** This contract receipts mutations universally and treats pure reads as un-receipted (except where a read crosses the workspace boundary, e.g. `sandbox.probe`, `fs/read_text_file` outside the root). If the threat model changes to require universal read receipts, the surface shapes in §4.1 and §4.3 need revision — that is a deliberate, open question, not an oversight.

---

## Provenance (APIs and contracts: what ships, what is design only, where it came from)

This section records, for the contract surfaces of this document, which designs and which bytes came from other repositories, with exact GitHub URLs at the commit that was read, which parts are design only, the additive-only evidence for `contracts.ts`, the provider and credential layer, and a detailed deferral note for every missing piece. It is a handoff aid and changes no status level; `docs/28-implementation-status.md` is the only place that may claim a level above DESIGNED.

Reading the tables:

- URLs point at a file at the full 40 character SHA from [`research/upstream-pins.md`](research/upstream-pins.md). Each path was checked with `git ls-files` in the read-only clone before it was written. Anything not checkable is written `path not verified`.
- **Relation**: **copied verbatim**, **ported**, **adapted**, or **idea only**, as defined in the Provenance section of [`08-runtime.md`](08-runtime.md). In this document nothing is copied verbatim and nothing is ported. The catalogue data file `models-dev.curated.json` is HorizonCode's own curation of public model facts (five providers), not a copy of the models.dev dataset.
- Judged from the header comments of `contracts.ts`, `catalog.ts`, `server.ts`, the docs/28 rulings and reading both sides.
- Licences: opencode MIT; codex and cline Apache-2.0; oh-my-pi MIT; grok-build carries its own `LICENSE`. The models.dev dataset has its own licence, which MUST be checked before a snapshot is committed (K1). The worktree has no `LICENSE` or `NOTICE` (OPEN item for the human owner).
- Ancestor project paths (`kernel/src/protocol.rs`, `rpc_handshake.rs`, `host_kernel.rs`, `effect_host.rs`, `specs/v2/session.md`) are in a repository that is not cloned: path not verified. aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 are not cloned (see [`research/upstream-pins.md`](research/upstream-pins.md)).
- Research: [`research/compare-providers.md`](research/compare-providers.md), [`research/steal-opencode-cline.md`](research/steal-opencode-cline.md), [`research/steal-ohmypi-codex.md`](research/steal-ohmypi-codex.md), [`research/forgecode-deep.md`](research/forgecode-deep.md) (T-8, T-18), [`30-steal-list.md`](30-steal-list.md).

### Implemented contracts versus the design (read this first)

Three contracts exist, all different in framing from this document:

1. **The kernel protocol**: NDJSON over stdio, `{id, method, params}`, 11 methods, defined in `app/src/contracts.ts` (`KernelRequestMap`, `KERNEL_METHODS`) and matched exactly by `kernel/src/protocol.rs`. Older text that says '8-method' is out of date.
2. **The server protocol** (`hzcode serve`): NDJSON, 7 methods, `HZ_PROTO = 1`, defined in `contracts.ts` and implemented in `app/src/core/server.ts`.
3. **The runtime facade**: `Runtime`, `RuntimeEvent`, `Provider`, `ProviderEvent`, `Tool`, `ToolContext` in `contracts.ts`, consumed in-process by the TUI, print mode and the server.

Everything in sections 4.1 (the `hz.*` Controller catalogue), 4.2 (`hzk` frames), 4.3 and 4.4 (REST, SSE), 4.5 (ACP), 4.6 (MCP server), 4.7 (plugin API), 4.8 (SDKs), the feature-flag registry of 4.1.5, `HZ_ABI` negotiation, `TypedErrorV1` and CT1 to CT50 is **DESIGN ONLY: NOT IMPLEMENTED**. The **providers and credentials** layer, which this document touches only in passing, is described in its own table below.

### `contracts.ts` is additive-only: the additive blocks and the evidence

The rule (never change or remove an exported name, field or constant; add optional fields or new variants consumers ignore) is stated in the file header and repeated in each block's comment. It is held by review: no test snapshots the exports (deferral K11). `kernel/src/canon.rs` is unchanged by all of the following.

| Addition | Origin | Notes |
|---|---|---|
| `EventTypes.sessionFork` and `SessionForkPayload` | session fork (ruling 59) | `session.fork` first event of a child stream; payload `{parentSessionId, parentStream, parentSeq, messageIndex}` |
| `Credential` (`apiKey`, `oauth`, `none`) | provider superset (FEAT-001) | `apiKey` and `none` are produced; `oauth` is declared but NO code path produces it |
| `KernelRequestMap['guard.allowlist.amend']` | FEAT-002 | mirrored in `kernel/src/protocol.rs` |
| `KernelRequestMap['sandbox.report']`, `SandboxMode`, `EnforcementReport`, `SandboxUnavailable`, egress policy types | FEAT-004 and the authority waves | fail-closed; a mode that needs unavailable confinement yields `SANDBOX_UNAVAILABLE`, never a silent 'enforced' |
| `Tool.exposure`, `Tool.searchInfo`, `ToolExposure` | ruling 45 | absent exposure means `direct` |
| `ToolContext.delegate` profile argument, `DelegateRunner` | ruling 56 | optional `profile` |
| `ApprovalRequest.guardian` | ruling 60 | advisory string |
| `RuntimeEvent`: `assistant.thinking`, `turn.diff`, `subagent.event`, `subagent.start`, `subagent.end`; `tool.card` fields `repaired`, `detail` | rulings 54, 87, 88, FEAT-003 | UI facade events, never written to the kernel log |
| `ProviderEvent` `{type:'thinking'}` | ruling 87 (C3) | display only |
| `RuntimeOptions.sessionId`, `RuntimeOptions.permissionMode`, `RunBudget`, `RunExit.detail` values | server resume, ruling 58, NF-073, safety rails | all optional |
| `HZ_PROTO`, `ServerRequest`, `ServerResponse`, `ServerNotification`, `SESSION_EVENT_METHOD`, `ServerMethod`, `SERVER_METHODS` | server mode (rulings 53, 54, 59) | separate from `KernelRequestMap`; `ServerResponse.id` may be `null` only for an uncorrelatable frame |


### What shipped, and where it came from

| # | HorizonCode file(s) | Upstream exact URL(s) at the pinned SHA | Relation | Notes |
|---|---|---|---|---|
| 1 | `app/src/contracts.ts`, `kernel/src/protocol.rs`, `kernel/src/canon.rs`, `app/src/core/canon.ts` | [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>ancestor `kernel/src/protocol.rs`, `rpc_handshake.rs`: not cloned, path not verified | idea only (one shared contract file as law); original | The frozen contract is the TypeScript file `contracts.ts`, hand-written, with the Rust kernel kept byte-identical in canonical JSON and hashing by `canon.rs` and the interop suites (`app/tests/core/interop.test.ts`, `canon-numbers.test.ts`). The rule is **additive only**: never change or remove an exported type, field or constant; new behaviour arrives as optional fields, new union arms that consumers ignore, or new methods. The additive blocks are listed in the table below. **There is no mechanical enforcement** (no snapshot of exported names, no schema, `gate:wire-parity` is a declared gap): the rule is held by review. `canon.rs` is unchanged by every one of these additions. |
| 2 | `app/src/core/kernel.ts`, `kernel/src/main.rs`, `kernel/src/protocol.rs` | idea only; original NDJSON | original | The kernel ABI as shipped is NDJSON over stdio: `{id, method, params}` in, `{id, result}` or `{id, error:{message}}` out, 11 methods (`KERNEL_METHODS`, which `protocol.rs` matches exactly). It is NOT the `hzk` frame envelope of section 4.2 (no `hello`/`request`/`response`/`event`/`control` frames, no `HZ_ABI` negotiation, no `TypedErrorV1`); errors are `{message}` only. The TypeScript fallback (`LocalKernel`, mode `untrusted`) implements the same methods. |
| 3 | `app/src/core/server.ts`, `app/src/contracts.ts` (server protocol block) | [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>[`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts) | idea only; original | The client-facing protocol that exists. NDJSON, request `{id, method, params?}`, response `{id, result}` or `{id, error:{code?, message}}`, notification `{method:"session.event", params}`. Codes are the JSON-RPC numbers `-32601` (method not found), `-32602` (invalid params), `-32603` (internal). There is no `jsonrpc` version field, no `deadlineMs`, no `idempotencyKey`, no `hz.initialize` (the handshake is `server.hello`), and none of the `hz.*` methods of section 4.1.2: the 7 shipped methods are `server.hello`, `session.create`, `session.list`, `session.prompt`, `session.rewind`, `session.subscribe`, `session.fork`. |
| 4 | `app/src/core/providers/index.ts`, `app/src/core/providers/anthropic.ts`, `app/src/core/providers/openai.ts`, `app/src/core/providers/google.ts`, `app/src/core/providers/ollama.ts`, `app/src/core/providers/openai-compatible.ts`, `app/src/core/providers/mock.ts`, `app/src/core/providers/scripted.ts`, `app/src/core/providers/sse.ts`, `app/src/core/providers/retry.ts` | [`packages/ai/src/providers/anthropic.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/anthropic.ts)<br>[`packages/ai/src/providers/anthropic-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/anthropic-compatible.ts)<br>[`crates/forge_app/src/dto/openai/transformers/mod.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/mod.rs)<br>[`docs/providers.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/providers.md)<br>[`docs/provider-streaming-internals.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-streaming-internals.md) | idea only (adapter per wire protocol, SSE parsing, retry with backoff); original zero-dependency implementations | Providers: Anthropic Messages, OpenAI chat, Google Gemini, Ollama, a generic OpenAI-compatible adapter fed by the user provider registry, plus `mock` and `scripted` for tests. Detailed adapter provenance is in [`10-cognition.md`](10-cognition.md). The public shape is `Provider { name, stream(req) -> AsyncIterable<ProviderEvent> }` in `contracts.ts`. These are NOT the `providers.infer` effect of docs/11 and there is no `hz.provider.*` method. |
| 5 | `app/src/core/catalog/catalog.ts`, `app/src/core/catalog/models-dev.curated.json`, `app/tests/core/catalog.test.ts` | [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts)<br>[`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts) | adapted (record shape and tolerant decoding); curated data is HorizonCode's own | The catalogue SEAM. A reduced record `{id, provider, limit{context,output?}, capabilities?, cost?}`, tolerant decoding (an unparseable model is skipped and collected in `rejected`, as opencode's `normalize()` does), three-way precedence: (1) `HZ_MODELS_SNAPSHOT` explicit file, floor-validated with `MINIMUM_PROVIDERS = 100`; (2) the committed curated snapshot `models-dev.curated.json` (2.8 KB, five providers), NOT floor-validated; (3) `fetchLiveCatalog`, a documented extension point that is disabled and never called. **The full models.dev snapshot (opencode ships about 8 MB, 230 providers, 8787 models) and the live refresh (ETag or digest, 5 minute poll) are DEFERRED** (K1, K2). Doctrine: capabilities and limits are read from catalogue data, never inferred from model-id substrings. |
| 6 | `app/src/core/config.ts` (`resolveRegistryCredential`), `app/src/core/providers/openai-compatible.ts` (`authorizationHeader`) | [`packages/core/src/plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts) | idea only (the `contracts.ts` header names it as the pattern for the future OAuth work) | **Auth kinds that exist in `app/src`:** `apiKey` (from env var or the config file; sent as `x-api-key` for Anthropic, `x-goog-api-key` for Google, `Authorization: Bearer` for OpenAI, registry providers and Ollama when a key is set) and `none` (keyless hosts such as Ollama or a local vLLM). `Credential.kind === "oauth"` is **declared but dead**: `authorizationHeader` in `openai-compatible.ts` would send its `accessToken` as a Bearer token, but nothing in the codebase constructs an `oauth` credential (`resolveRegistryCredential` returns only `apiKey` or `none`), and there is no login command, no token store, no refresh. **OAuth acquisition flows are DEFERRED** (K3). |


### Where each design family came from (all DESIGN ONLY unless marked)

| Family | Upstream exact URL(s) at the pinned SHA | Status | Notes |
|---|---|---|---|
| Controller protocol: `hz.initialize`, the ~100 method catalogue, envelope with `deadlineMs`, idempotency, worked exchanges (2.1, 4.1) | [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>ancestor `specs/v2/session.md`: not cloned, path not verified | NOT IMPLEMENTED (design only); the 7-method server protocol ships | See K7. |
| Kernel ABI `hzk`: frames, handshake, `TypedErrorV1`, `ErrorCategoryV1`, `RetryClassV1`, effect operations (2.3, 4.2) | ancestor `kernel/src/protocol.rs#L2169-L2202`, `rpc_handshake.rs`, `host_kernel.rs`, `effect_host.rs`: not cloned, path not verified | NOT IMPLEMENTED (design only); the 11-method NDJSON protocol ships | See K7 and K10. |
| REST, SSE, event subscription stream (2.2, 2.4, 4.3, 4.4) | [`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>[`packages/server/src/handlers.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/handlers.ts) | NOT IMPLEMENTED (design only) | See K8. |
| ACP surface (2.5, 4.5) | [`packages/cli/src/acp/agent.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/acp/agent.ts)<br>[`packages/cli/src/acp/capabilities.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/acp/capabilities.ts)<br>[`crates/codegen/xai-acp-lib/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/lib.rs) | NOT IMPLEMENTED (design only) | Owned by G5 in [`14-surfaces.md`](14-surfaces.md); revision pinning is open item 7 of this document. |
| MCP server surface and MCP client counterpart (2.5, 4.6) | [`codex-rs/codex-mcp`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/codex-mcp)<br>[`crates/codegen/xai-grok-mcp/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/lib.rs) | server NOT IMPLEMENTED; stdio tools-only client ships | Owned by G6 in [`14-surfaces.md`](14-surfaces.md) and H7 in [`15-extensibility.md`](15-extensibility.md); MCP revision pinning is open item 6. The shipped client announces protocol `2024-11-05`. |
| Plugin API (2.6, 4.7) | [`mods/agents-md/.claude-plugin/plugin.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/mods/agents-md/.claude-plugin/plugin.json)<br>[`packages/plugin`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/plugin) | NOT IMPLEMENTED (design only) | Owned by H5 in [`15-extensibility.md`](15-extensibility.md). |
| SDKs and code generation (2.7, 4.8, 4.9.4) | [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`packages/sdk`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/sdk)<br>[`docs/sdk.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/sdk.md) | NOT IMPLEMENTED (design only) | Owned by G7 in [`14-surfaces.md`](14-surfaces.md). |
| Versioning, deprecation, feature flags, `HZ_PROTO` / `HZ_ABI` negotiation (2.8, 4.1.5, 4.9) | idea only: no upstream reference found | PARTIAL: `HZ_PROTO = 1` exists and `server.hello` returns it; `HZ_ABI`, feature flags, deprecation windows do not exist | See K7. |
| Error model: carrier, code registry, status mapping, fail-closed classes (2.8, 4.10) | ancestor `kernel/src/protocol.rs`: not cloned, path not verified | PARTIAL: JSON-RPC numeric codes in the server; kernel errors are `{message}`; refusals use stable string prefixes such as `HZ_PRECONDITION_FAILED` and `profile_ceiling_widens` | See K10. |
| Contract tests CT1 to CT50 (section 9) | idea only | NOT IMPLEMENTED as named; related tests exist (interop, canon, server, kernel-hardening) | See K11. |


### Sources that could not be linked

The ancestor project's kernel protocol files (`protocol.rs` including the line range 2169 to 2202 for the error and retry-class sets, `rpc_handshake.rs`, `host_kernel.rs`, `effect_host.rs` lines 4790 and 5801, `guard.rs` line 1289, `worktree_lifecycle.rs`) and `specs/v2/session.md` are in an earlier private codebase that is not cloned. The `docs/audit/pass2/*-report*.md` files cited in the source list are audit notes inside this repository (they exist); they are not upstream code.


### Deferred or not started: detailed notes for the next agent

Each note gives: what is deferred, why, the upstream reference, whether to adopt as is or adapt, a suggested design, and the files to touch. 'Adapt' is the default because the references are Rust or framework-specific. No note changes a status level. Paths are from the repository root.

#### K1. models.dev: the full snapshot

- **What is deferred.** Bundle the real models.dev provider catalogue (opencode ships about 8 MB, 230 providers, 8787 models, validated at build with `MINIMUM_PROVIDERS = 100`). Today the committed curated file has five providers and about 2.8 KB; `HZ_MODELS_SNAPSHOT` can point at a full snapshot file and it is floor-validated, but no such file is shipped. Per-model `limit`, `capabilities` and `cost` are therefore known only for the curated models; unknown models fall back to conservative defaults.
- **Why.** Too heavy for review and unavailable under the no-network sandbox the seam was written in (see the `catalog.ts` header). Also a repository-size decision for the owner: an 8 MB JSON in a zero-dependency repo.
- **Upstream reference.** [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts)<br>[`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts)<br>Source of truth: [models.dev](https://models.dev) (provider catalogue; its API shape is what `CATALOG_PATH` in `catalog.ts` names). Research: [`research/compare-providers.md`](research/compare-providers.md) section 5.4.
- **Adopt as is or adapt.** ADAPT the build-time script idea (fetch, normalise, validate with a floor, write a committed JSON) and the `normalize()` tolerance. The data itself is third-party; check its licence before committing a snapshot and record it in a NOTICE.
- **Suggested design.** Write `app/scripts/refresh-models-snapshot.ts` (run by a human with network access, never by a test or a gate) that downloads the models.dev API JSON, runs the same decoder as `catalog.ts` (`rejected` must be reviewed), enforces `MINIMUM_PROVIDERS`, strips fields HorizonCode does not read (to keep the file small, target under 1 MB), and writes `app/src/core/catalog/models-dev.snapshot.json`. Keep the curated file as the offline floor. Add the file path to the precedence order after `HZ_MODELS_SNAPSHOT`. Make `/model` listing and `doctor`'s model check use it. Cost fields feed an ESTIMATE in `/stats` (see I11 in [`16-operations.md`](16-operations.md)), never a bill.
- **Files to touch.** `app/src/core/catalog/catalog.ts`, new `app/scripts/refresh-models-snapshot.ts`, new snapshot JSON, `app/tests/core/catalog.test.ts`, README and `docs/28` (ruling), NOTICE (licence).

#### K2. models.dev: live refresh

- **What is deferred.** `fetchLiveCatalog` (ETag or digest conditional fetch, a 5 minute poll in opencode, atomic cache file) is a documented extension point only.
- **Why.** A background network call from a coding agent is an egress decision: it must go through the egress policy (docs/11) and be off by default. Not testable offline.
- **Upstream reference.** [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts)
- **Adopt as is or adapt.** ADAPT; take the conditional-request and atomic-cache behaviour, not the polling loop.
- **Suggested design.** `hzcode models refresh` (explicit user command, not a poll): GET with `If-None-Match`, write `<user config dir>/models-dev.cache.json` through an atomic rename with mode 0600, validate with the floor, print a diff summary (providers added/removed). `loadCatalog` reads the cache after the env override and before the committed snapshot. The fetch itself runs through the guard as `net.fetch` so the egress policy applies. No timer.
- **Files to touch.** `app/src/core/catalog/catalog.ts` (`fetchLiveCatalog`), `app/src/main.ts`, `app/tests/core/catalog.test.ts` (use an injected fetch).

#### K3. OAuth acquisition flows for providers (the `oauth` credential arm)

- **What is deferred.** Everything needed to OBTAIN and keep an OAuth credential: PKCE with a loopback redirect server, device-code flow, token storage (0600, never in workspace files), refresh on expiry and on 401, logout and revoke, per-provider endpoints (ChatGPT/Codex-style subscription auth, Anthropic, Google, Copilot). The type arm exists; nothing produces it.
- **Why.** Each flow is provider-specific, depends on third-party endpoints that cannot be exercised offline, and stores a long-lived secret. Two of the references use client ids that belong to other products; HorizonCode would need its own registrations or must not impersonate another client.
- **Upstream reference.** [`packages/core/src/plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts)<br>[`packages/core/src/mcp/oauth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/mcp/oauth.ts)<br>[`packages/core/src/oauth/page.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/oauth/page.ts)<br>[`packages/ai/src/registry/oauth/callback-server.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/callback-server.ts)<br>[`packages/ai/src/registry/oauth/device-code.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/device-code.ts)<br>[`packages/ai/src/registry/oauth/anthropic.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/anthropic.ts)<br>[`codex-rs/login/src/auth/manager.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/login/src/auth/manager.rs)<br>[`codex-rs/login/src/auth/storage.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/login/src/auth/storage.rs)<br>[`crates/codegen/xai-grok-auth/src/auth_provider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-auth/src/auth_provider.rs)<br>[`crates/codegen/xai-grok-login/src/api_key_probe.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/api_key_probe.rs)<br>[`apps/cli/src/wizards/mcp/oauth.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/apps/cli/src/wizards/mcp/oauth.ts)<br>[`docs/auth-broker-gateway.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/auth-broker-gateway.md)
- **Adopt as is or adapt.** ADAPT, one provider at a time. opencode's `chatgpt.ts` is named in the `contracts.ts` header as the pattern (PKCE loopback plus token refresh). oh-my-pi's `registry/oauth/*` is TypeScript and the closest in language; codex `login/src/auth/*` is the reference for storage and refresh rules (Rust). Do NOT copy client ids or endpoints without confirming the provider permits third-party clients.
- **Suggested design.** (1) A `TokenStore` in `app/src/core/auth/store.ts` (file under the user config dir, mode 0600, atomic write, never logged, masked by `maskSecrets`). (2) `app/src/core/auth/pkce.ts`: `node:crypto` verifier and challenge, a one-shot `Bun.serve` loopback server on `127.0.0.1:<random>` that accepts exactly one callback with a matching `state`, times out after 5 minutes, and serves a static success page. (3) `device-code.ts` for headless boxes. (4) `resolveRegistryCredential` returns `{kind:'oauth', accessToken, refreshToken, expiresAt}` when a stored token exists for the provider id; the adapters already map it to a Bearer header (`authorizationHeader`). (5) Refresh once on a 401 before failing. (6) `hzcode login <provider>` and `hzcode logout <provider>` subcommands dispatched before arg parsing like `doctor`; `doctor` reports token presence and expiry, never the value. Tests: state mismatch rejected, token file mode, refresh path with an injected fetch.
- **Files to touch.** new `app/src/core/auth/*.ts`, `app/src/core/config.ts`, `app/src/main.ts`, `app/src/core/doctor.ts`, `app/tests/core/auth-*.test.ts`, `app/src/contracts.ts` (no change: the arm exists), `docs/11` (storage rule), `docs/28`.

#### K4. Forgecode take T-8: provider quirk table

- **What is deferred.** A data table of per-host and per-model request transformations applied as small pure functions, recorded in the event so a run is reproducible: for example Cerebras without `parallel_tool_calls`, tool-call id trimming and sanitising, ensuring the system message comes first, schema normalisation, dropping reasoning-only messages for Claude, stripping thought signatures on model switch. NOT STARTED.
- **Why.** It should be driven by real failures. Only one real OpenAI-compatible endpoint (NVIDIA NIM) has been exercised; building 20 transformers speculatively is the 'volume' the research note warns against.
- **Upstream reference.** [`crates/forge_app/src/dto/openai/transformers/mod.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/mod.rs)<br>[`crates/forge_app/src/dto/openai/transformers/pipeline.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/pipeline.rs)<br>[`crates/forge_app/src/dto/openai/transformers/when_model.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/when_model.rs)<br>[`crates/forge_app/src/dto/openai/transformers/make_cerebras_compat.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/make_cerebras_compat.rs)<br>[`crates/forge_app/src/dto/openai/transformers/trim_tool_call_ids.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/trim_tool_call_ids.rs)<br>[`crates/forge_app/src/dto/openai/transformers/ensure_system_first.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/ensure_system_first.rs)<br>[`crates/forge_app/src/dto/openai/transformers/normalize_tool_schema.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/normalize_tool_schema.rs)<br>[`crates/forge_app/src/dto/openai/transformers/strip_thought_signature.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/strip_thought_signature.rs)<br>[`crates/forge_app/src/dto/openai/transformers/make_xai_compat.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/make_xai_compat.rs)<br>[`crates/forge_app/src/dto/openai/transformers/minimax.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/minimax.rs)<br>[`docs/provider-quirks.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-quirks.md)<br>[`docs/provider-compat-reference.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-compat-reference.md)<br>[`docs/provider-endpoint-constraints.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-endpoint-constraints.md)<br>[`docs/ai-schema-normalize.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/ai-schema-normalize.md)
- **Adopt as is or adapt.** ADAPT the mechanism (a pipeline of pure transformers selected by a predicate on host and model), not the volume. oh-my-pi's quirk docs are the best catalogue of what to expect; forge's Rust transformers are the reference implementations.
- **Suggested design.** `app/src/core/providers/quirks.ts`: `type Quirk = { id, applies(ctx:{host,model,protocol}): boolean, request?(body): body, messages?(msgs): msgs }`, a `QUIRKS` array, `applyQuirks(ctx, body)` returning `{body, applied: string[]}`; unknown hosts apply none and the adapter works as today (fail loud only on a request the endpoint rejects, with the response text). `openai-compatible.ts` calls it just before `fetch`; the applied ids go into a `notice` once per session and into the `message.start` event payload (additive field `quirks`). Start with exactly the quirks a real endpoint has demanded. Tests with recorded request bodies.
- **Files to touch.** new `app/src/core/providers/quirks.ts`, `app/src/core/providers/openai-compatible.ts`, `app/src/core/providers/openai.ts`, `app/src/core/loop.ts` (event payload), `app/tests/core/providers-quirks.test.ts`.

#### K5. Forgecode take T-18 and multi-dialect tool conversion: models without native tool calling

- **What is deferred.** (a) T-18: a text tool-call protocol for models served without native tools (forge switches to an XML `<forge_tool_call>` block parsed by a dedicated parser when `tool_supported` is false), for small Ollama models. (b) Multi-dialect tool conversion: parsing each model family's own tool-call text format (Harmony, Hermes, Qwen3, Kimi K2, GLM 4.5, DeepSeek, Gemma, MiniMax, Anthropic and Gemini formats, an XML format) back into normalised calls. Neither is started; `providers/ollama.ts` uses Ollama's native tool-call field and the model must support it.
- **Why.** Low priority unless local models become a product pillar. The safety rule is non-negotiable: a parsed call is exactly a model-proposed call, so it must go through `parseToolArguments`, the guard, approval and the receipt; the parser must be strict (a malformed block is a format error, never a best-effort guess that could invent arguments).
- **Upstream reference.** [`crates/forge_domain/src/tools/call/parser.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/call/parser.rs)<br>[`crates/forge_domain/src/xml.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/xml.rs)<br>[`crates/forge_domain/src/tools/call/tool_call.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/call/tool_call.rs)<br>[`docs/toolconv/xml.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/xml.md)<br>[`docs/toolconv/hermes.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/hermes.md)<br>[`docs/toolconv/harmony.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/harmony.md)<br>[`docs/toolconv/qwen3.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/qwen3.md)<br>[`docs/toolconv/kimi-k2.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/kimi-k2.md)<br>[`docs/toolconv/glm-4.5.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/glm-4.5.md)<br>[`docs/toolconv/deepseek.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/deepseek.md)<br>[`docs/toolconv/gemma.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/gemma.md)<br>[`docs/toolconv/minimax.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/minimax.md)<br>[`docs/toolconv/anthropic.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/anthropic.md)<br>[`docs/toolconv/gemini.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/gemini.md)<br>[`docs/toolconv/pi-native.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/pi-native.md)
- **Adopt as is or adapt.** ADAPT. oh-my-pi's `toolconv` documents are format specifications per family (the best map of the problem); forge's parser is the reference for one concrete XML dialect. Do not take a parser-combinator dependency; a hand-written scanner is enough.
- **Suggested design.** `app/src/core/providers/toolconv/<dialect>.ts`, each exporting `parse(text): {calls: ToolCall[], rest: string, errors: string[]}` and `render(specs): string` (for the system prompt), selected by a catalogue `capabilities.toolFormat` field or a provider registry entry key `toolFormat`. A wrapper provider turns a text stream into `tool_call` ProviderEvents ONLY after a complete block closes (never from a partial stream); anything unparsable stays assistant text and increments the format-error rail (NF-073 cap of 3). Golden tests per dialect from the toolconv specs, plus a fuzz test that no input string produces a call whose name is not in the offered `ToolSpec`s.
- **Files to touch.** new `app/src/core/providers/toolconv/*.ts`, `app/src/core/providers/ollama.ts`, `app/src/core/providers/openai-compatible.ts`, `app/src/core/config.ts` (registry key), `app/tests/core/toolconv-*.test.ts`.

#### K6. Other codecs and providers: `anthropic-compatible`, OpenAI `responses`, Bedrock, Azure, Vertex, gateways

- **What is deferred.** The registry's `protocol` field only accepts `openai-chat`. Anthropic-compatible and OpenAI Responses codecs, and cloud-hosted variants (Bedrock, Azure OpenAI, Vertex), are deferred; the `protocol` field reserves the seam.
- **Why.** Each is a separate wire format and auth scheme (SigV4 for Bedrock needs HMAC signing without a dependency, which is doable with `node:crypto` but needs care).
- **Upstream reference.** [`packages/ai/src/providers/anthropic-compatible.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/anthropic-compatible.ts)<br>[`packages/ai/src/providers/azure.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/azure.ts)<br>[`packages/ai/src/providers/amazon-bedrock.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/amazon-bedrock.ts)<br>[`packages/ai/src/providers/cloudflare-ai-gateway.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/providers/cloudflare-ai-gateway.ts)<br>[`docs/providers.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/providers.md)<br>[`docs/adding-a-provider.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/adding-a-provider.md)
- **Adopt as is or adapt.** ADAPT per provider, driven by a real user need.
- **Suggested design.** Reuse `streamOpenAiCompatible` as the model: one function per protocol returning the same `ProviderEvent` stream; the registry's `protocol` enum grows by one value per codec; each ships with a recorded-fixture test.
- **Files to touch.** `app/src/core/providers/*`, `app/src/core/config.ts` (`parseProviderEntry`), `app/tests/core/providers-*.test.ts`.

#### K7. Controller protocol, `hz.initialize`, the full method catalogue, feature flags, `HZ_ABI` negotiation

- **What is deferred.** The ~100 `hz.*` methods, `deadlineMs`, idempotency keys, feature-flag negotiation and the kernel `hzk` frame envelope. What exists is the 7-method server protocol and the 11-method kernel protocol, neither of which negotiates anything beyond `HZ_PROTO = 1`.
- **Why.** Designing an ABI before a second client or a second kernel build exists is premature; the additive-only rule on `contracts.ts` already protects compatibility.
- **Upstream reference.** [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>ancestor `rpc_handshake.rs`, `protocol.rs`: not cloned, path not verified
- **Adopt as is or adapt.** ADAPT the idea of a handshake that returns capabilities (HorizonCode's `server.hello` already does for the server).
- **Suggested design.** Add `kernel.hello` as an additive kernel method returning `{version, proto, abi, methods[]}`; the TS client checks that every method it needs is listed and fails closed (untrusted fallback with a notice) otherwise. Mirror in `protocol.rs`. Feature flags: add an optional `features: string[]` to `server.hello` first.
- **Files to touch.** `app/src/contracts.ts` (additive), `kernel/src/protocol.rs`, `app/src/core/kernel.ts`, `app/src/core/server.ts`, interop tests.

#### K8. REST, SSE and the event subscription stream

- **What is deferred.** Sections 4.3 and 4.4: routes, status codes, authentication modes, `hz.subscribe` with cursors, resnapshot, and heartbeats.
- **Why.** No HTTP server exists; see G1 to G4 in [`14-surfaces.md`](14-surfaces.md).
- **Upstream reference.** [`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>[`packages/server/src/handlers.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/handlers.ts)<br>[`packages/server/src/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/auth.ts)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** After the UDS transport (G1) and auth (G3): `session.subscribe {sessionId, fromSeq}` replays from `log.read` then tails; the SSE adapter is a thin mapping of the same stream.
- **Files to touch.** `app/src/core/server.ts`, `app/src/contracts.ts`.

#### K9. ACP, MCP server, plugin API, SDKs

- **What is deferred.** Sections 4.5 to 4.8.
- **Why.** Owned elsewhere to avoid duplicate notes.
- **Upstream reference.** See G5, G6, G7 in [`14-surfaces.md`](14-surfaces.md) and H5, H7 in [`15-extensibility.md`](15-extensibility.md).
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** See those notes.
- **Files to touch.** See those notes.

#### K10. Typed error model

- **What is deferred.** `TypedErrorV1` with category, code, retry class and fail-closed flag. Shipped: JSON-RPC numeric codes in the server, `{message}` from the kernel, and stable string markers such as `HZ_PRECONDITION_FAILED`, `SANDBOX_UNAVAILABLE`, `profile_ceiling_widens`, `DECLINED by the user`.
- **Why.** Markers are good enough for the three consumers (TUI, print, server). A typed carrier matters when SDKs exist.
- **Upstream reference.** idea only; ancestor `protocol.rs#L2169-L2202`: not cloned, path not verified.
- **Adopt as is or adapt.** Original.
- **Suggested design.** Add an optional `code` string to kernel error responses (`{message, code?}`, additive), define the code list in `contracts.ts`, and map the existing markers. Keep `message` unchanged.
- **Files to touch.** `kernel/src/protocol.rs`, `app/src/contracts.ts`, `app/src/core/kernel.ts`.

#### K11. Contract tests and a mechanical additive-only check

- **What is deferred.** CT1 to CT50 of section 9, and a test that enforces the additive-only rule (no snapshot of the exported names and shapes of `contracts.ts` exists).
- **Why.** The rule is held by review today. A drift check is cheap and protects the one file both languages depend on.
- **Upstream reference.** idea only: codex checks in generated schema files and tests drift against them, see [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol).
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** `app/tests/contracts/exports.test.ts`: import `* as c from '../../src/contracts'`, assert the sorted list of exported runtime names equals a checked-in list (adding a name requires editing the list, removing one fails loudly), and snapshot `JSON.stringify` of `DEFAULT_POLICY`, `KERNEL_METHODS`, `SERVER_METHODS`, `EventTypes`. Extend with a type-level test using `satisfies` for the key interfaces.
- **Files to touch.** new `app/tests/contracts/exports.test.ts`, `app/tests/contracts/exports.snapshot.json`.
