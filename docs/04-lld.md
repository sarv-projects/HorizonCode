# 04 — Low-Level Design

> **Scope.** This document decides the *inside* of HorizonCode: the package and crate map, the kernel's internal modules, the TypeScript core's module layout, the exact signatures of the load-bearing functions, the concurrency model, the error taxonomy, and the invariant table. It implements the shape fixed by [`03-hld.md`](./03-hld.md) and must not contradict [`02-decisions.md`](./02-decisions.md).
>
> **Status.** `/data/home/forge/HorizonCode` contains a v0.1 implementation (`app/`, `bin/`, `kernel/`); the package/crate layout below is not that implementation, so every module path here still names an artifact to be built. Levels live in `docs/28-implementation-status.md` (RC-13). Every name with no counterpart in an ancestor or reference repository is marked `[planned]`; a `source:` line names a real counterpart where one exists.
>
> **Implementation status (final audit, 2026-11-06).** The built subset (per `28-implementation-status.md`) is far smaller than this document's scope — v0.1 implements a minimal kernel (chained event log, receipt chain, guard, NDJSON protocol) and a Bun runtime under `app/` — providers, the seven base tools plus `agent`/`code_mode`/`preview`, the chat TUI and headless mode, skills and subagents — not the package/crate layout below — so every module path in this document still names an artifact to be built. The statuses that *have* moved are recorded in `docs/28`.

**Conventions used here** (mandatory): `hzcode`, `hzk`, `.hz/`, `~/.config/horizon/`, `hz://`, `@horizoncode/*`, `hz_*`, `HZ_ABI=1`, `HZ_PROTO=1`, the six plane names, the capability IDs and effect classes of `_conventions.md` §5, the canonical `hz.<entity>.<past-tense-verb>` event names of §6, and the `<Name>V<major>` schema convention of §7. Declared status values are `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED`.

**Source repositories** (absolute paths; all under `/data/home/forge/repo-tour/`): `horizoncode` (the ancestor), `opencode`, `codex`, `grok-build`, `DeepSeek-Reasonix`, `oh-my-pi`, `forgecode`, `claude-code`.

---

## 1. Purpose

### 1.1 What this document decides

1. The **package map**: every `@horizoncode/*` package, its responsibility, its public API surface, and exactly what it may depend on.
2. The **crate map**: every `hz_*` crate, same four facts.
3. The **kernel's internal module layout**: `guard.rs`, `policy.rs`, `lease.rs`, `effect_host.rs`, `receipt.rs`, `owner_log.rs`, `managed.rs`, `verifier.rs`, `budget.rs`, `worktree.rs`, `supervisor.rs`, `cgroup/`, and the sandbox bridge.
4. The **TypeScript core module layout**: `controller.ts`, `session/`, `step/`, the event log and projectors, the inbox, the claim, budgets, `agents/`, `tools/`, `context/`.
5. The **exact signatures** of the nine load-bearing functions.
6. The **concurrency model**: single-writer log, actor-per-session, tool fibers, cancellation.
7. The **error taxonomy** and the classification every error must carry.
8. The **invariant table**: what must always hold, and where it is enforced.

### 1.2 What this document deliberately does not decide

Field-level schemas of `V1` types (schema documents), the protocol method catalogue (protocol document), policy grammar (authority/safety document), sandbox profile contents, tool catalogue semantics, provider wire formats, TUI layout, packaging. Where a signature below names a type, it names the *semantics* the type must carry and leaves the field list to the schema document.

---

## 2. Rules

Numbered, individually testable. `L-` rules are lower-level than the `H-` rules of `03-hld.md` and must be read as refinements, never as replacements.

| # | Rule | Proved by |
|---|---|---|
| L-1 | `Controller.submit()` MUST be the only entry point for user-originated work, and MUST be idempotent on `idempotencyKey`: a replay returns the original `AdmitResultV1` unchanged. | `controller/submit-idempotent` |
| L-2 | `Controller.submit()` MUST NOT call a provider, the kernel, or the filesystem on the effect path. It normalizes and admits; nothing else. | `controller/submit-purity` |
| L-3 | `SessionEngine.admit()` MUST append exactly one durable event per distinct input and MUST be the only writer of `hz.session.prompt.admitted`. | `session/admission-order` |
| L-4 | `admit()` MUST be called only from `Controller.submit()` and the scheduler tick. A boundary test fails on a new caller. | `boundary/admit-callers` |
| L-5 | The inbox MUST preserve per-session enqueue order; `steer` items MUST be promoted only at a safe step boundary, never mid-stream. | `inbox/ordering` |
| L-6 | Exactly one writer per session aggregate. The writer is the session actor and MUST hold the write-ahead claim for the whole busy period. | `log/single-writer` |
| L-7 | `StepEngine.runStep()` MUST dispatch exactly one provider stream call. A test enumerates every caller of the provider dispatch and fails on a second one. | `step/one-stream` |
| L-8 | `runStep()` MUST reload history from the log at entry. It MUST NOT carry messages in process memory across steps. | `step/history-from-log` |
| L-9 | `ToolRegistry.settle()` MUST settle every call of the batch exactly once. A batch left with an unsettled call MUST raise a defect, not a warning. | `tools/settle-complete` |
| L-10 | Tool declarations MUST be frozen when the registry is built. Runtime mutation of a declaration MUST be impossible (frozen object, no setter). | `tools/declaration-frozen` |
| L-11 | `KernelClient.authorize()` MUST NOT compute or accept an origin kind from request fields; the origin kind is a function of the canonical operation only. | `kernel/origin-typing` |
| L-12 | `KernelClient.execute()` MUST be called only from `@horizoncode/core`'s effect runtime. Tools, agents, plugins and front-ends MUST NOT call it. | `boundary/effect-submission` |
| L-13 | A lease id is a reference, never authorization: the kernel MUST re-validate the intent digest, posture revision and workspace binding at execute time. | `kernel/lease-revalidate` |
| L-14 | `ReceiptLedger.settle()` MUST reject a second settlement for the same `effectId` with `effect.duplicate_settlement`. | `kernel/settlement` |
| L-15 | `ContextCompiler.compile()` MUST be a pure function of its declared inputs; identical inputs MUST produce byte-identical output. | `context/compile-determinism` |
| L-16 | The compiled prefix MUST NOT contain timestamps, random identifiers, un-sorted tool schemas, or map iteration order. | `context/cache-guard` |
| L-17 | `ParityRatchet.check()` MUST fail when a declared capability has no projection on any surface listed in the parity manifest, and MUST fail when a surface declares a capability the Controller cannot serve. | `ratchet/parity` |
| L-18 | Every error MUST carry a dotted code and exactly one class from `{refuse, retry, degrade, defect}`. An unclassified error is a defect. | `errors/classification` |
| L-19 | A `refuse` MUST NOT be translatable into model-facing success by a blanket error mapper. Refusals tunnel through as refusals. | `errors/refusal-tunnel` |
| L-20 | Cancellation MUST be scoped: cancelling a root run cancels its sessions' steps, batches and effects, and MUST NOT touch another root run. | `cancel/scope` |
| L-21 | A cancelled in-flight effect MUST be delivered to the kernel and MUST settle (`DENIED` or `FAILED` with a cancellation reason). Nothing may vanish. | `cancel/settles` |
| L-22 | The log writer MUST NOT hold its lock across an await of an unrelated subsystem (network, provider, kernel). | `log/lock-discipline` |
| L-23 | Parallel tool fibers MUST join before the batch settles; a fiber failure MUST become a typed per-call failure, never a process crash. | `tools/fiber-failure` |
| L-24 | The native addon MUST be loaded exactly once, from `@horizoncode/shared`'s single loader; nothing else may `dlopen`/`require` it. | `native/single-loader` |
| L-25 | Each session actor MUST bound its mailbox. On overflow it MUST apply backpressure to `submit()`, never drop an item. | `session/backpressure` |
| L-26 | Every wire/durable type MUST come from the generated protocol package. A hand-written duplicate of a generated type MUST fail `codegen/single-source`. | `codegen/single-source` |
| L-27 | An effect intent MUST be durable in the OwnerLog before the effect is dispatched. | `kernel/intent-before-dispatch` |
| L-28 | A posture change MUST bump the posture revision and digest and emit `hz.policy.revision.changed`; a request carrying a stale revision MUST be rejected with `session.posture_stale`. | `session/posture-revision` |
| L-29 | A budget reservation MUST be taken before the provider call or effect dispatch, and released on every terminal path including cancellation. | `budget/reserve-release` |
| L-30 | Projectors MUST be pure functions of the event stream and MUST NOT perform I/O beyond their own tables. | `log/replay-complete` |
| L-31 | `verify()` MUST lower and never raise a claim. A claim with no supporting receipt MUST be reported `unsupported`. | `verify/monotone-lowering` |
| L-32 | `UNKNOWN` MUST be reachable only from the kernel's declared uncertainty paths. No tool, agent or projector may set it. | `kernel/settlement` |
| L-33 | A tool or plugin implementation MUST NOT import the kernel client's execute path; effects are returned to the runtime as declared intents. | `boundary/effect-submission` |
| L-34 | Every exported symbol of every package MUST appear in this document's API surface. An unlisted export MUST fail the API-surface test. | `api/surface` |
| L-35 | File and function sizes MUST stay under the configured ceilings; debt may only decrease. | `ratchet/size` |
| L-36 | Kernel modules MUST NOT depend on the TypeScript runtime: the kernel's test suite MUST pass with no supervisor running. | `topology/kernel-independence` |
| L-37 | Effect cancellation and settlement MUST be idempotent: repeating either call MUST converge to the same terminal state. | `kernel/settlement-idempotent` |
| L-38 | All identifiers MUST be sortable (UUIDv7/ULID) except content digests, which are `sha256`. | `ids/sortable` |
| L-39 | Timestamps MUST be recorded in events and receipts but MUST NOT appear in the compiled prefix. | `context/cache-guard` |
| L-40 | The batch is the admission unit: one decision, one lease set, one settlement round. A tool MUST NOT be able to acquire an independent lease mid-batch. | `kernel/batch-unit` |
| L-41 | `hz.session.prompt.admitted` MUST be the first event any input produces, and no event of a later step may exist for that input before it. | `session/admission-order` |
| L-42 | A `degrade` MUST be recorded on the run receipt and in `hzcode doctor`; a degrade that is not recorded MUST be a defect. | `degrade/visibility` |

---

## 3. Interfaces

### 3.1 TypeScript package map (`packages/*`)

Rank is the layering position from `03-hld.md` §3.5: **a package may only depend on packages of strictly lower rank** (plus, for `cli`, everything; and `testing`, which may depend on anything under test). `⊳` separates named types from named functions. Every entry is `[planned]` unless a `source:` line names an existing counterpart.

| Package | Rank | Responsibility | Public API surface (types ⊳ functions) | May depend on |
|---|---|---|---|---|
| `@horizoncode/shared` | 0 | Leaf utilities: ids, result types, error base, small schema helpers, **the single native-addon loader**. | `Id`, `Result`, `HzError`, `HzCode`, `NativeHandle` ⊳ `newId()`, `isOk()`, `classifyError()`, `loadNative()`, `native()` | third-party only |
| `@horizoncode/protocol` | 1 | Generated schemas and codecs for both wires (surface protocol and kernel ABI) — the single source of truth. | `GuardDecisionV1`, `EffectReceiptV1`, `EffectObservationV1`, `DurableEventV1`, `ToolDeclarationV1`, `SessionPostureV1`, `AgentProfileV1`, `StepRecordV1`, `KernelErrorV1`, `HzRevision` ⊳ `encode()`, `decode()`, `assertRevision()`, `applyEvent()` | `shared` |
| `@horizoncode/observe` | 1 | Local-first telemetry: spans, metrics, logs, redaction, and the disable switch. | `Span`, `Metric`, `Redactor`, `TelemetryConfig` ⊳ `initTelemetry()`, `startSpan()`, `recordMetric()`, `redact()`, `setEnabled()` | `shared` |
| `@horizoncode/kernel-client` | 2 | Typed client of the `hzk` ABI: connect, negotiate revision, authorize, execute, reconcile, read receipts. | `KernelClient`, `KernelHandle`, `ReconcileStateV1`, `LeaseV1`, `BudgetReservationV1`, `WorktreeLeaseV1` ⊳ `connect()`, `KernelClient.authorize()`, `KernelClient.execute()`, `KernelClient.reconcile()`, `KernelClient.receipts()`, `KernelClient.reserve()`, `KernelClient.attach()` | `protocol`, `shared`, `observe` |
| `@horizoncode/ui` | 2 | Render primitives shared by every surface (diff, markdown, tables, progress, prompts) with no domain knowledge. | `DiffView`, `MarkdownBlock`, `TableModel`, `PromptSpec`, `Theme` ⊳ `renderDiff()`, `renderMarkdown()`, `renderTable()`, `sanitizeUntrustedText()` | `shared` |
| `@horizoncode/provider` | 3 | Provider registry, wire codecs, model catalogue (`models.dev` snapshot), streaming, usage and cost accounting. | `ProviderDefinitionV1`, `ModelRef`, `LLMRequestV1`, `ProviderChunkV1`, `UsageV1`, `CodecId` ⊳ `resolveModel()`, `stream()`, `codecFor()`, `loadCatalog()`, `estimateTokens()` | `protocol`, `shared`, `observe` |
| `@horizoncode/context` | 3 | Context compiler (prefix + projected tail), cache guard primitives, four-tier memory, retrieval, compaction. | `ContextBundleV1`, `PrefixDigestV1`, `MemoryEntryV1`, `RetrievalHitV1`, `CompactionPlanV1` ⊳ `ContextCompiler.compile()`, `compilePrefix()`, `projectTail()`, `digestPrefix()`, `retain()`, `recall()`, `planCompaction()` | `protocol`, `shared`, `observe` |
| `@horizoncode/tools` | 4 | Tool declarations, registry, argument canonicalization, dispatch, batch settlement, and the built-in tool implementations. | `ToolDeclarationV1`, `ToolContext`, `ToolResultV1`, `ToolErrorV1`, `ToolBatchV1`, `BatchPlanV1`, `ToolRegistry` ⊳ `ToolRegistry.register()`, `ToolRegistry.effective()`, `ToolRegistry.execute()`, `ToolRegistry.settle()`, `canonicalizeArgs()`, `decodeToolArgs()`, `planBatch()` | `protocol`, `shared`, `observe` |
| `@horizoncode/skills` | 4 | Skill discovery, manifests, invocation planning, bundled skills, synthesis output (never auto-installed). | `SkillManifestV1`, `SkillInvocationV1`, `SkillIndexV1` ⊳ `discover()`, `load()`, `planInvocation()`, `synthesize()`, `indexSkills()` | `protocol`, `shared` |
| `@horizoncode/plugin` | 4 | Plugin manifests, capability grants, the sandboxed host process, and the plugin-facing SDK. | `PluginManifestV1`, `PluginCapabilityGrantV1`, `PluginHostHandle`, `PluginInvocationV1` ⊳ `loadPlugin()`, `spawnHost()`, `invoke()`, `revokeGrant()`, `verifyManifestSignature()` | `protocol`, `tools`, `shared`, `observe` |
| `@horizoncode/workflow` | 4 | Rhai workflow engine bindings and the host channel through which workflows request effects. | `WorkflowSpecV1`, `WorkflowHostChannel`, `WorkflowRunV1` ⊳ `compileWorkflow()`, `runWorkflow()`, `hostCall()` | `protocol`, `shared` |
| `@horizoncode/mcp` | 4 | MCP client (stdio/HTTP/SSE, OAuth) and MCP server mode exposing HorizonCode capabilities. | `McpServerConfig`, `McpToolBinding`, `McpServerProfile`, `McpOAuthState` ⊳ `connectClient()`, `listTools()`, `invoke()`, `serveOverMcp()`, `oauthLogin()`, `mapReadOnlyHint()` | `protocol`, `tools`, `shared`, `observe` |
| `@horizoncode/acp` | 4 | ACP agent endpoint plus the IDE bridge: session replay, permission proxying, attachment transfer. | `AcpSessionBinding`, `AcpPermissionRequest`, `AcpReplayCursor` ⊳ `serveAcp()`, `translateCommand()`, `replaySession()`, `proxyPermission()` | `protocol`, `shared`, `observe` |
| `@horizoncode/agents` | 5 | Agent profiles, deterministic planner/executor routing, the single child-construction primitive, fleet/team orchestration, the durable message bus. | `AgentProfileV1`, `CapabilityGrantV1`, `ContextCapsuleV1`, `TaskSpecV1`, `FleetSpecV1`, `RoutingDecisionV1`, `AgentMessageV1` ⊳ `spawnChild()`, `routeTask()`, `readOnlyProfile()`, `Fleet.run()`, `Team.create()`, `sendMessage()`, `narrowGrant()` | `tools`, `provider`, `context`, `protocol`, `shared` |
| `@horizoncode/core` | 6 | Controller, session engine, step engine, event log and projections, inbox, claim, budgets, posture, the effect runtime, and the verifier client. | `Controller`, `SessionEngine`, `StepEngine`, `EventLog`, `Projector`, `InboxItemV1`, `ClaimV1`, `SubmitTicketV1`, `AdmitResultV1`, `StepOutcomeV1` ⊳ `createController()`, `Controller.submit()`, `Controller.cancel()`, `Controller.answer()`, `Controller.events()`, `SessionEngine.admit()`, `SessionEngine.claim()`, `StepEngine.runStep()`, `EventLog.append()`, `projectAll()`, `effectRuntime.submitBatch()`, `verifySession()` | `agents`, `tools`, `provider`, `context`, `protocol`, `kernel-client`, `shared`, `observe` |
| `@horizoncode/server` | 7 | JSON-RPC / HTTP / SSE / WebSocket server, authentication, per-client subscriptions, tunnels. | `ServerConfig`, `ClientIdentity`, `Subscription`, `AuthPolicy` ⊳ `createServer()`, `handleRpc()`, `subscribe()`, `authenticate()`, `openTunnel()` | `core`, `protocol`, `shared`, `observe` |
| `@horizoncode/sdk` | 7 | Generated TypeScript client of the surface protocol; the only package a surface may use to reach a Controller. | `HzClient`, `HzClientOptions`, `EventCursor` ⊳ `connect()`, `submit()`, `events()`, `replay()`, `cancel()`, `approve()` | `protocol`, `shared` |
| `@horizoncode/sdk-python` / `sdk-go` / `sdk-rust` | 7 | Generated thin clients with the same surface shape (submit, events, replay, approve, cancel). | mirror of `sdk` in each language ⊳ generated | `protocol` (generated output only) |
| `@horizoncode/tui` | 8 | The fullscreen/alt-screen TUI (and inline fallback): rendering, mouse interaction, command palette, diff viewer, session picker. Contains **no** domain logic. | `TuiProps`, `KeyBinding`, `PaletteCommand`, `Renderer` ⊳ `mountFullscreen()`, `mountInline()`, `renderApp()`, `registerKeybinding()` | `sdk`, `protocol`, `ui`, `shared` |
| `@horizoncode/web` | 8 | Browser app: sessions, diffs, terminal panes, approvals, collaboration. | `WebSessionView`, `WebApprovalGate` ⊳ `mountWebApp()` | `sdk`, `protocol`, `ui`, `shared` |
| `@horizoncode/desktop` | 8 | Electron shell hosting the web app, with OS capability behind an explicit host port. | `DesktopHostPort` ⊳ `createDesktop()`, `hostCapability()` | `sdk`, `web`, `protocol`, `ui`, `shared` |
| `@horizoncode/cli` | 9 | Composition root: argv, command framework, surface selection, process supervision, terminal ownership, exit codes. | `CliContext`, `CommandSpec`, `SurfaceKind`, `SupervisorHandle`, `KernelHandle` ⊳ `main(argv)`, `runCommand()`, `resolveConfig()`, `spawnSupervisor()`, `attachKernel()`, `exitCodeFor()` | every package |
| `@horizoncode/learn` | 4 | Trajectory capture, evals, memory distillation, skill synthesis, proposal emission. Never applies a change. | `TrajectoryV1`, `ProposalV1`, `EvalResultV1`, `DistillationPlanV1` ⊳ `recordTrajectory()`, `runEval()`, `distill()`, `synthesizeSkill()`, `proposeChange()`, `assertNoWidening()` | `context`, `protocol`, `shared`, `observe` |
| `@horizoncode/testing` | T | Harness, record/replay, fixtures, fault injection, boundary tests, and the CI ratchets (`ParityRatchet`, `CacheGuard`, `LayeringRatchet`). | `RecordingV1`, `FixtureV1`, `ParityManifestV1`, `ParityReportV1`, `InjectionPoint` ⊳ `ParityRatchet.check()`, `CacheGuard.check()`, `LayeringRatchet.check()`, `record()`, `replay()`, `inject()` | anything under test |

**Package rules that make the table real.**

1. **A package's directory is its rank.** `packages/<rank>-<name>/` is generated into the workspace by `hz_codegen`; a package importing a higher rank fails `ratchet/layering`.
2. **Only `cli` composes.** No other package may import `core` *and* a surface package (e.g. `tui`): that pair is the definition of a front-end leaking into the spine.
3. **`tools` declares, `core` submits.** `tools` never imports `kernel-client`'s execute path (L-33). The one caller is `core/effect/runtime.ts` (L-12).
4. **`testing` is not importable from production code**; the ratchet enforces the direction.

### 3.2 Rust crate map (`crates/*`)

`⊳` separates named types from named functions. Crates below the dashed line are *capability* crates: they may hold performance-critical, read-mostly logic but **no authority**. `hz_kernel` is the only crate that may decide, lease, execute or settle.

| Crate | Rank | Responsibility | Public API surface (types ⊳ functions) | May depend on |
|---|---|---|---|---|
| `hz_abi` | 0 | Generated ABI/protocol types for the kernel wire and the OwnerLog records. No logic. | `GuardDecisionV1`, `EffectReceiptV1`, `EffectIntentV1`, `EffectObservationV1`, `LeaseV1`, `KernelErrorV1`, `HzRevision`, `OwnerRecordV1`, `ReconcileStateV1` ⊳ `revision()`, `encode()`, `decode()` | `serde` only |
| `hz_policy` | 1 | Wildcard rule compiler plus the Starlark prefix engine; produces a canonical, digestible policy set with precedence `deny > ask > allow`. | `RuleSet`, `CompiledPolicy`, `PolicyRevision`, `Decision`, `ReasonCode`, `PolicyRequestV1` ⊳ `compile_rules()`, `evaluate()`, `digest()`, `explain()` | `hz_abi` |
| `hz_sandbox` | 2 | Confinement backends and the guarantee vector: probe, apply, and typed residuals. | `SandboxProfile`, `GuaranteeVectorV1`, `Dimension`, `ResidualV1`, `Sandbox` ⊳ `probe()`, `apply()`, `residuals()`, `explain_missing()` | `hz_abi` |
| `hz_walker` | 2 | Parallel, ignore-aware filesystem walker with confinement to a root descriptor. | `WalkSpec`, `WalkEntry`, `WalkStats` ⊳ `walk()`, `walk_stream()` | — |
| `hz_diff` | 2 | Diff engine with jsdiff-compatible output for UI parity and patch application. | `Hunk`, `PatchV1`, `DiffOptions` ⊳ `diff()`, `apply()`, `render()` | — |
| `hz_ast` | 2 | tree-sitter parsing, query and rewrite over supported languages. | `AstQuery`, `AstMatch`, `RewritePlan` ⊳ `parse()`, `query()`, `rewrite()`, `symbols()` | — |
| `hz_vcs` | 2 | Git (and Jujutsu) integration: status, blame, history, worktree operations, conflict-aware staging. | `RepoRef`, `StatusV1`, `BlameLine`, `CommitSpec` ⊳ `status()`, `blame()`, `log()`, `worktree_add()`, `worktree_remove()`, `stage_patch()` | `hz_walker` |
| `hz_index` | 2 | Lexical (BM25) plus symbol/reference index over a workspace; rebuildable, never authoritative. | `IndexRoot`, `SymbolHit`, `TextHit`, `IndexStats` ⊳ `build()`, `search_text()`, `search_symbols()`, `references()`, `definitions()`, `persist()` | `hz_walker`, `hz_ast` |
| `hz_pty` | 2 | PTY allocation, process-group control, resize, signal, exit-status capture, replay buffer for terminal panes. | `PtyHandle`, `PtySpec`, `PtyEvent`, `ExitStatus` ⊳ `spawn()`, `resize()`, `signal()`, `read_events()`, `replay_buffer()` | — |
| `hz_voice` | 2 | Local STT/TTS primitives (streaming) with no network requirement. | `VoiceModel`, `AudioFrame`, `TranscriptDelta` ⊳ `stt_stream()`, `tts_stream()`, `load_model()` | — |
| `hz_shell` | 2 | Embedded bash with an injectable VFS, plus argv-form execution and shell parsing helpers. | `Vfs`, `ShellProfile`, `CommandPlan`, `ShellResult` ⊳ `parse()`, `classify()`, `run_argv()`, `run_shell()`, `mount_vfs()` | `hz_abi` |
| `hz_edit` | 3 | Conflict-aware edit engine: preimage validation, patch planning, multi-edit serialization, atomic apply. | `EditPlan`, `EditOp`, `Preimage`, `ApplyOutcome` ⊳ `plan()`, `apply()`, `normalize_batch()` | `hz_diff`, `hz_ast` |
| `hz_native` | 4 | The single N-API addon: one typed facade over the capability crates for the TypeScript runtime. **MUST NOT depend on `hz_kernel`.** | `WalkerHandle`, `IndexHandle`, `AstHandle`, `DiffHandle`, `EditHandle`, `VcsHandle`, `ShellHandle`, `PtyHandle`, `VoiceHandle` ⊳ `open_walker()`, `open_index()`, `open_ast()`, `diff()`, `plan_edit()`, `vcs_status()`, `shell_run()`, `pty_spawn()`, `stt_stream()` | capability crates only |
| `hz_kernel` | 5 | The authority kernel: Guard, policy host, leases, effect host, receipts, OwnerLog, managed domain, verifier, budgets, worktree pool, supervisors, cgroup containment, sandbox bridge. | see §3.3 ⊳ `startup::run()`, `host::serve()` | `hz_abi`, `hz_policy`, `hz_sandbox`, `hz_shell`, `hz_edit`, `hz_diff`, `hz_ast`, `hz_vcs`, `hz_walker`, `hz_index`, `hz_pty`, `hz_voice` |
| `hz_codegen` | build | Protocol/ABI/SDK generator: one source of truth → `@horizoncode/protocol`, `hz_abi`, generated SDKs. | `SchemaSource`, `EmitTarget` ⊳ `generate()`, `verify_fresh()` | `hz_abi` (source schema only) |
| `hz_sdk` | 7 | Generated Rust SDK client: thin client over the surface protocol (never over ABI types). Generated output, not a hand-written crate. | `HzClient`, `HzClientOptions`, `EventCursor` ⊳ `connect()`, `submit()`, `events()`, `replay()`, `cancel()`, `approve()` | `hz_abi` (generated output only) |

**Crate rules.**

1. **`hz_native` MUST NOT depend on `hz_kernel`, transitively or otherwise** (H-17). Enforced by a build test that inspects the resolved dependency graph; a violation means a plugin-reachable library could carry authority code.
2. **`hz_kernel` MUST NOT depend on `@horizoncode/*`** and MUST NOT open the session log. Its only interface to the agent is I-03.
3. **No capability crate may call back into the kernel.** Imports point inwards only.
4. **`hz_abi` is generated.** A hand edit fails `codegen/single-source` (L-26).

### 3.3 Kernel internal module layout (`crates/hz_kernel/src/`)

Each module has one job. `source:` lines name the ancestor module the design inherits from, so the reader can check the real thing.

| Module | Responsibility | Key types | Key functions | Descends from |
|---|---|---|---|---|
| `guard.rs` | Admission decision: canonical operation → capability ID → policy evaluation → `GuardDecisionV1` with `reason_code` and `intent_digest`. Owns action-ID classification and the workspace binding used in digests. | `AuthorizationRequestV1`, `GuardDecisionV1`, `ReasonCode`, `WorkspaceBinding` | `authorize()`, `approval_policy()`, `workspace_binding()`, `intent_digest()`, `argument_digest()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/guard.rs` |
| `policy.rs` | Policy host: load the effective rule set, compile it with `hz_policy`, cache the compiled revision, hot-reload on change. Never touches the filesystem per decision. | `PolicySetV1`, `PolicyRevision`, `CompiledPolicy` | `load()`, `compile()`, `evaluate()`, `revision()`, `watch()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/workspace_command_profile.rs` (policy parts) |
| `lease.rs` | One-use lease arbiter: issue one one-use lease per effect as a single set at batch admission; mark each consumed at its own effect's execute; expire by deadline, revoke on posture change or shutdown. A lease id is a reference, never authorization (L-13). | `LeaseV1`, `LeaseArbiter`, `LeaseState`, `Epoch` | `issue_batch()`, `consume()`, `expire()`, `revoke()`, `validate()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/direct_session_grant.rs` |
| `effect_host.rs` | The executor: prepare → dispatch → observe → settle for every effect class, plus HTTP egress execution and terminal execution. Owns the effect state machine and the wiring to PTY, shell, VCS, edit and egress. | `EffectHost`, `EffectRequestV1`, `EffectState`, `Observation` | `open()`, `open_live()`, `handle_request()`, `begin_dispatch()`, `mark_running()`, `mark_cancelling()`, `settle()`, `mark_unknown()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs` |
| `receipt.rs` | Receipt ledger: write exactly one terminal receipt per effect, reject duplicates (L-14), index by `sessionId`/`effectId`/`receiptId`, expose `hz://receipt/<id>`. | `EffectReceiptV1`, `ReceiptLedger`, `ReceiptIndex` | `settle()`, `get()`, `list_for_session()`, `verify_chain()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/managed_settlement_provenance.rs` (provenance parts) |
| `owner_log.rs` | Durable authority log: canonical codecs, committed-head filesystem storage, segment seals, hash chain, replay validation. The head is the sole commit authority. | `OwnerLog`, `OwnerRecordV1`, `Segment`, `CommittedHead`, `OwnerLogError` | `open()`, `append()`, `commit()`, `replay()`, `head()`, `seal_segment()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/owner_log.rs` |
| `managed.rs` | The managed domain: Goal → SpecVersion → Run → Task → Attempt → WorkerExecution → Evidence → Verification, with the task DAG and atomic-task rules. | `GoalV1`, `SpecVersionV1`, `RunV1`, `TaskV1`, `AttemptV1`, `EvidenceV1`, `VerificationV1`, `TaskDag` | `admit_goal()`, `plan_run()`, `ready_tasks()`, `record_evidence()`, `verify()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/managed_control.rs`, `.../task_dag.rs` |
| `verifier.rs` | Independent-evidence gate: checks claims against receipts and artifacts, lowers status, emits the verification verdict; never raises. | `ClaimV1`, `VerdictV1`, `EvidenceBundleV1`, `Verifier` | `check_claim()`, `lower()`, `bundle()`, `adjudicate()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/managed_verifier.rs`, `.../verifier_journal.rs` |
| `budget.rs` | Resource budgets: reserve, consume, release, per root run and inherited by children; admission inputs from pressure state; never authorizes by itself. | `ResourceBudgetV1`, `ReservationV1`, `PressureState`, `ReservationOwner` | `reserve()`, `consume()`, `release()`, `headroom()`, `evaluate_pressure()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/resource_budget.rs` |
| `worktree.rs` | Worktree pool: bounded, lease-based pool of worktrees bound to attempts, with lifecycle ownership (create, register, release, clean) delegated to guarded workspace operations. | `WorktreeRootOwnerV1`, `WorktreeLeaseV1`, `WorktreePool`, `WorktreeLifecycle` | `register()`, `acquire()`, `release()`, `sweep()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/worktree_pool.rs`, `.../worktree_lifecycle.rs` |
| `supervisor.rs` | Process supervision: the host-wide single-supervisor lease with a monotonic owner epoch, the authenticated per-connection handshake, startup gating, and reaping of effect children. | `SupervisorLease`, `OwnerEpoch`, `StartupGate`, `HelloOutcome`, `SupervisorSession` | `acquire_lease()`, `advance_epoch()`, `serve_authenticated()`, `gate_startup()`, `reap()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/supervisor_lease.rs`, `.../supervisor_session.rs`, `.../startup.rs` |
| `cgroup/` (`mod.rs`, `v2.rs`, `sampler.rs`) | cgroup v2 containment and accounting: create a scope per effect, apply CPU/memory/PID controllers, verify `RLIMIT_NOFILE`, sample usage, and refuse profiles that require limits that cannot be verified. | `CgroupScope`, `ControllerSet`, `Sample`, `ProcessIdentity` | `delegate()`, `create_scope()`, `apply_controllers()`, `sample()`, `destroy_scope()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/cgroup_v2.rs`, `.../resource_sampler.rs` |
| `sandbox.rs` (the sandbox bridge) | Bridge from a capability ID + effect class to a concrete confinement profile; probes `hz_sandbox`, caches the guarantee vector per posture revision, and converts a missing dimension into a typed residual + refusal of exactly that effect class. | `SandboxBridge`, `GuaranteeVectorV1`, `ResidualV1`, `ProfileKey` | `profile_for()`, `probe()`, `apply_to_child()`, `residuals()` | `source: /data/home/forge/repo-tour/horizoncode/horizoncode-sandbox` |
| `transport.rs`, `protocol.rs`, `framing.rs`, `peer.rs` (`unix_peer`, `windows_peer`) | The ABI surface: framing, revision negotiation, message-pack encoding, and peer authentication (SO_PEERCRED / named-pipe impersonation). | `Frame`, `HelloExchange`, `PeerPrincipal`, `RequestCancellation` | `serve()`, `read_frame()`, `write_frame()`, `authenticate_peer()`, `cancel_request()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/transport.rs`, `.../protocol_framing.rs`, `.../unix_peer.rs`, `.../windows_peer.rs` |
| `session_projection.rs` | The kernel-side view of a session: postures, granted capabilities, pending questions, live effects — the read model the runtime subscribes to. | `SessionProjectionV1`, `PostureState`, `Subscription`, `CursorV1` | `apply()`, `subscribe()`, `cursor()`, `snapshot()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/session_projection.rs` |
| `artifact.rs`, `checkpoint.rs` | Content-addressed artifact store and checkpoint records: `hz://artifact/<sha256>`, evidence bundles, pre-effect workspace states. | `ArtifactRefV1`, `ArtifactStore`, `CheckpointV1` | `put()`, `get()`, `digest()`, `create_checkpoint()`, `restore_plan()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/artifact_store.rs`, `.../checkpoint.rs` |
| `secrets.rs` (`secret_use.rs`, `secret_mutation.rs`) | Secret handles: resolve, count uses, mutate under a separate capability, and never log a value. | `SecretHandleV1`, `SecretUseGrantV1`, `SecretJournal` | `resolve()`, `use_grant()`, `mutate_grant()`, `redact()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/secret_use.rs`, `.../secret_mutation.rs` |
| `agent.rs` (`agent_profile.rs`, `subagent_delivery.rs`) | Kernel-side enforcement of agent profiles and child delivery: which capabilities a profile may ever hold, and how a child's completion returns to its parent receipt. | `AgentProfileV1`, `ChildDeliveryV1`, `CapabilityCeiling` | `validate_profile()`, `ceiling_for()`, `deliver_child_result()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/agent_profile.rs`, `.../subagent_delivery.rs` |
| `automation.rs` | Scheduled automation definitions plus their occurrence journal, so a recurring run survives restart without double-firing. | `AutomationV1`, `OccurrenceV1`, `Journal` | `define()`, `due()`, `record_occurrence()`, `replay()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/automation.rs` |
| `codemode.rs` | The `codemode.execute` host: confined JS/TS interpreter whose nested tool calls re-enter the ordinary batch path (composition, not a new executor). | `CodeModeProgram`, `NestedCallRequestV1`, `ConfinementProfile` | `admit_program()`, `dispatch_nested()`, `settle_program()` | `source: /data/home/forge/repo-tour/horizoncode/kernel/src/codemode_protocol.rs` |

**Kernel rules.**

1. **No kernel module may read the session event log.** The kernel's own truth is the OwnerLog; the join happens at verification time.
2. **No kernel module may perform a decision without a workspace binding.** A path string is not authority.
3. **`settle()` and `mark_unknown()` are the only exits from `EffectState::Running`** (L-32, L-37).
4. **Every module that writes durable state does it through `owner_log.rs`**, never through an ad-hoc file.
5. **The sandbox bridge runs once per posture revision**, not per effect (PB-14).

### 3.4 TypeScript core module layout (`packages/core/src/`)

| Module | Responsibility | Key exports |
|---|---|---|
| `controller.ts` | The single transport-agnostic owner of the run loop: accepts submissions, drives step iterations, publishes events, answers questions, manages the busy period. Decides *when*, never *whether*. | `Controller`, `createController()`, `submit()`, `cancel()`, `answer()`, `events()` |
| `session/engine.ts` | Session lifecycle: create, resume, archive, fork, rewind, and the posture state machine. Owns the session actor and its mailbox. | `SessionEngine`, `createSession()`, `resume()`, `fork()`, `setPosture()`, `snapshot()` |
| `session/admit.ts` | `SessionEngine.admit()`: normalize → reconcile idempotency → append one event → return `AdmitResultV1`. The only writer of `hz.session.prompt.admitted`. | `admit()`, `reconcileIdempotency()` |
| `session/inbox.ts` | The durable inbox projection: `steer` vs `queue`, promotion at safe step boundaries, cancellation, ordering. | `Inbox`, `enqueue()`, `nextPromotable()`, `promote()`, `cancelInboxItem()` |
| `session/claim.ts` | Write-ahead claim: acquire before the first effect, renew on progress, release on terminal outcome, preserve on interrupt for resume. | `acquireClaim()`, `renewClaim()`, `releaseClaim()`, `recoverClaim()` |
| `session/log.ts` | The append-only event log: framing, per-aggregate sequence, one-transaction commit with projections, cursor reads, and the single-writer discipline. | `EventLog`, `append()`, `readAfter()`, `appendWithProjections()` |
| `session/projector.ts` | Pure projectors: messages, inbox, claims, todos, plan, goal, usage, receipts mirror, agent tree. | `projectors`, `applyAll()`, `rebuild()` |
| `session/budget.ts` | Reservation lifecycle on the runtime side: take before spend, release on terminal paths, propagate to children with narrowing. | `reserve()`, `consume()`, `release()`, `inheritToChild()` |
| `session/posture.ts` | Effective posture: posture + capability set + policy revision + digest, with narrowing merges and staleness detection. | `PostureV1`, `narrow()`, `digestPosture()`, `assertFresh()` |
| `session/verify.ts` | Session verification client: join the log with the kernel's receipt ledger, build the verdict and the evidence bundle, emit `hz.usage.recorded` and the run receipt. | `verifySession()`, `joinReceipts()`, `buildVerdict()` |
| `step/engine.ts` | `StepEngine.runStep()`: reload history, compile context, dispatch one stream, collect tool calls, apply the batch, close the step. | `StepEngine`, `runStep()`, `closeStep()` |
| `step/stream.ts` | Provider stream handling: delta→event translation, tool-call accumulation by index, truncation and repair handling, usage accounting. | `consumeStream()`, `accumulateToolCalls()`, `repairToolArgs()` |
| `step/batch.ts` | Batch construction and planning: declaration validation, concurrency classes, write-set overlap planning, fiber group, settlement barrier. | `planBatch()`, `runBatch()`, `joinFibers()` |
| `effect/runtime.ts` | **The one place** that calls `KernelClient.authorize()` and `KernelClient.execute()`. Maps a batch plan to admitted effects and writes decision/lease/settlement events. | `submitBatch()`, `admitBatch()`, `settleBatch()`, `reconcileEffects()` |
| `effect/ledger.ts` | Runtime-side receipt mirror and reconciliation queue; surfaces `hz.effect.settled` / `hz.effect.unknown` / `hz.effect.reconciled`. | `ReceiptMirror`, `settle()`, `pendingUnknown()`, `reconcile()` |
| `agents/spawn.ts` | **The one child-construction primitive** (H-14): narrowing, budget split, capsule, child session, receipt linkage. | `spawnChild()` |
| `agents/profile.ts` | Agent profiles and capability ceilings; profile validation against the kernel's ceiling. | `AgentProfileV1`, `resolveProfile()`, `narrowGrant()` |
| `agents/planner.ts` | Deterministic host routing (no classifier): `executor-only · light · full · plan-for-approval · plan-only`, with planner/executor prefixes kept separate. | `routeTask()`, `runPlanner()`, `handoffPlan()` |
| `agents/fleet.ts` / `agents/team.ts` / `agents/message-bus.ts` | Fan-out fleets of identical workers under a concurrency ceiling, dependency-graph `parallel_tasks`, teams with a shared message bus, and the durable agent message projection. | `Fleet.run()`, `ParallelTasks.run()`, `Team.create()`, `sendMessage()`, `waitForMessage()` |
| `tools/registry.ts` | Registry construction, effective-tool computation per posture, Code-Mode namespace tree, and snapshotting for the provider request. | `ToolRegistry`, `register()`, `effective()`, `snapshot()` |
| `tools/declaration.ts` | `ToolDeclarationV1` validation: capability ID exists in the registry, effect class agrees, observation method present (H-24). | `validateDeclaration()`, `assertEffectClass()` |
| `tools/runtime.ts` | Dispatch and settlement: decode input at the untrusted boundary, execute, classify failures, return declared effect intents. | `execute()`, `settle()`, `toEffectIntent()` |
| `tools/builtin/*.ts` | The built-in tools catalogued in `09-tools.md` §4, each declaring its own schema, capability ID and renderers. | one module per tool family |
| `context/compiler.ts` | `ContextCompiler.compile()`: prefix + tail assembly, digesting, determinism. | `compile()`, `compilePrefix()`, `projectTail()`, `digestPrefix()` |
| `context/memory.ts` | Four memory tiers with provenance: retain, recall, edit, reflect, and the review path for distillation. | `retain()`, `recall()`, `reflect()`, `listProvenance()` |
| `context/retrieval.ts` | BM25 + embeddings + symbol/reference index queries, bounded by budget, all local-first. | `retrieve()`, `retrieveSymbols()`, `rerank()` |
| `context/compaction.ts` | Compaction strategies (summary, structured digest, verbatim tail, frame compression) under one automatic trigger ratio. | `planCompaction()`, `applyCompaction()`, `assertPrefixUnchanged()` |
| `events/catalog.ts` | The canonical event catalogue from `_conventions.md` §6, with payload schemas and the ordering contract per aggregate. | `EventCatalog`, `definitionOf()`, `assertCanonical()` |

**Core rules.**

1. **`effect/runtime.ts` is the only module that may import `KernelClient.execute()`** (L-12). Everything else returns *declared intents*.
2. **`session/log.ts` is the only module that appends durable events** (L-6). Projectors never write events.
3. **`step/engine.ts` holds no cross-step state.** History comes from the log every step (L-8).
4. **`agents/spawn.ts` is the only module that constructs a child session** (H-14).
5. **No module in `core/` may import `@horizoncode/tui`, `server`, `sdk` or `cli`.**

---

## 4. Data

> **NOTE — the second half of the LLD.** §1–§3 fix *who exists and who may call whom*. §4–§11 are the second half: what each module **stores** (§4), how it **fails** (§5), the exact **call chains** across modules and processes (§6), the **authority and boundary rules** that make §3 testable (§7), the **budget numbers** (§8), the **tests** (§9) and the **status** (§10). Every row below names a package, crate or module defined in §3.1–§3.4; a reader who has not read those four tables first will not be able to follow §4–§9.

### 4.1 The one-owner rule

Every durable fact has exactly one writer and one owning module. Two components writing the same fact is a defect (`internal.multi_writer`), not a merge problem.

| Durable fact | Sole writer | Store | Read by | Notes |
|---|---|---|---|---|
| Session events | `packages/core/src/session/log.ts` (`EventLog.append()`) | SQLite `events` | projectors, verifier, `sdk`, `server`, `tui` (read-only mirror) | Append-only. One commit = one event + its projection rows (L-6, L-30). Never updated or deleted outside retention. |
| Projections | `packages/core/src/session/projector.ts` (`applyAll()`) | SQLite `projections` | `controller.ts`, surfaces, `agents/` | Pure function of `events`; rebuildable at any time from offset 0 (`projectAll()`). |
| Inbox items, claims, posture | `session/inbox.ts`, `session/claim.ts`, `session/posture.ts` | SQLite `claims` + projection rows | `SessionEngine`, `agents/spawn.ts` | The claim row is the write-ahead lease that makes resume possible (§6.6). |
| Usage and cost | `session/verify.ts` (`verifySession()`) | SQLite `usage` | `session/budget.ts`, `server`, `sdk` | One row per completed attempt; RC-4 fixes attribution for cancelled attempts. |
| Attachments, tool output blobs, patch preimages (runtime side) | `context/` and `tools/runtime.ts` through the CAS writer | SQLite `blobs` + `.hz/state/blobs/<ab>/<cd>/<sha256>` | projectors, compaction, evidence bundles | Content-addressed; deduplicated by `sha256`. |
| Kernel authority records (intents, leases, receipts, settlements) | `crates/hz_kernel/src/owner_log.rs` (`OwnerLog.append()`) | OwnerLog segments + `head` under `.hz/state/kernel/ownerlog/` (`12` §4.1) | `receipt.rs`, `verifier.rs`, reconciliation | The kernel never opens the session log (§3.3 rule 1); the join happens in `session/verify.ts`. |
| Receipt index | `receipt.rs` (`ReceiptLedger.settle()`) | kernel receipts journal under `.hz/state/kernel/` | `KernelClient.receipts()`, `effect/ledger.ts` | Exactly one terminal receipt per `effectId` (L-14). |
| Authority artifacts, checkpoints | `artifact.rs`, `checkpoint.rs` | `.hz/state/artifacts/objects/<ab>/<cd>/<sha256>` CAS | `verifier.rs`, `verifySession()` | Separate CAS from the runtime-side `blobs` store; the only join is the digest. |
| Worktree leases | `worktree.rs` (`WorktreePool`) | SQLite `worktrees` in kernel state + working copies under the worktree pool root (`05` §4.5) | `agents/spawn.ts`, `hzcode worktree` | Pool is bounded; a lease references a managed worktree root, never a user directory. |
| Schedule journal | `automation.rs` (`Journal`) | Kernel OwnerLog records referenced by digest | `automation.rs`, `hzcode schedule` | RC-3: storage metadata, not a session event. |
| Config, policy, secrets key refs | `resolveConfig()` in `@horizoncode/cli`; `policy.rs` for the compiled set | `.hz/config.jsonc`, `~/.config/horizon/` | every package (read), `hz_policy` (compile) | JSONC (§4.16.1 of `05-domain-and-schemas.md` owns the document shape). Secrets are handles only; no value is ever written to a store or a log. |

### 4.2 Session store (SQLite) — tables

The session store is one SQLite database per workspace: `<workspace>/.hz/state/hzcode.db` (layout owned by `12-sessions-state.md` §4). Table names follow `12-sessions-state.md`; the field lists live in `05-domain-and-schemas.md`, so only the role is fixed here.

| Table | Owner | Role | Invariants |
|---|---|---|---|
| `events` | `session/log.ts` | The append-only event log: `seq`, `sessionId`, `name`, `payload`, `cursor`, `idempotencyKey`, `createdAt`. | Monotonic per-session `seq`; unique `(sessionId, cursor)`; insert-only; L-41 enforced by the admission path, not by a trigger. |
| `projections` | `session/projector.ts` | One row per (session, projector, key) materialized projection, written in the same transaction as its event. | L-30: a projector reads only `events` and writes only its own rows. Projectors are pure; `rebuild()` truncates and replays. |
| `blobs` | CAS writer (`context/`, `tools/runtime.ts`) | Metadata for each content-addressed blob: `digest`, `size`, `kind`, `refcount`, `firstSeen`. | Bytes live in `.hz/state/blobs/` (§4.4); a `blobs` row without a file, or a file without a row, is `internal.cas_inconsistent`. |
| `claims` | `session/claim.ts` | The write-ahead claim (`ExecutionClaimV1`): `fenceToken`, `ownerProcessIncarnation`, `ownerEpoch`, `acquiredAtMs`, `heartbeatAtMs`, `ttlMs`, `state ∈ {held, released, expired, revoked}`; recovery is recorded as `resumedFromClaimId` on the successor claim. | At most one `held` row per session (L-6). Survives process death on purpose (§6.6). |
| `usage` | `session/verify.ts` | Usage and cost per attempt, joined later with receipts: `runId`, `stepId`, `provider`, `tokensIn/Out`, `costMicros`, `attribution`. | Written once at verification; never adjusted. Unknown cost is stored as `UNKNOWN`, never as `0`. |
| `event_snapshot`, `retention_ledger` | `session/log.ts` | Log snapshots, and retention markers that make deletions auditable. | RC-3: storage metadata; surfaced by `hzcode doctor` and `hzcode worktree list --journal`, never re-emitted as events. |

**Store rules.**

1. One connection per session actor; `journal_mode = WAL`, `synchronous = FULL` (the default `strict` mode; `NORMAL` only under `--durability=fast`) for events, `FULL` for the claim row; the pragma set is owned by `12-sessions-state.md` §4.3 (S-10) and the default by `06-events-and-flows.md` E-29.
2. `appendWithProjections()` opens exactly one transaction: the `events` insert plus every projector write either commit together or not at all.
3. A second writer attempting `BEGIN IMMEDIATE` on a session already claimed MUST fail with `session.claim_conflict`, never queue (L-6, L-25).
4. `hzcode doctor` verifies: table set, WAL truncation, orphan blob rows, `UNKNOWN` usage rows, and unrecovered claims.

### 4.3 On-disk layout

```text
<workspace>/.hz/
  config.jsonc               # workspace config (rank-0 read, cli writes) — JSONC (§4.16.1 of doc 05)
  state/hzcode.db            # §4.2 session store (events, projections, blobs, claims, usage)
  state/hzcode.db-wal        # WAL; never copied without its sibling
  state/blobs/<ab>/<cd>/<sha256>            # runtime CAS: two-level shard, bytes only
  state/artifacts/objects/<ab>/<cd>/<sha256>  # kernel-owned artifact CAS (§4.5)
  state/kernel/              # kernel state: ownerlog/, effect-journal/, leases/, budget/, verifier/, worktrees/, trusted-state/
  state/snapshots/<checkpointId>/
  state/host.json            # host guard (host id, mount class, heartbeat)
  state/exports/             # default .hzs output directory
  index/                     # derived FTS/vector/symbol indices (disposable)

$XDG_CONFIG_HOME/horizon/          # default ~/.config/horizon/
  config.jsonc               # user config (JSONC)
  models.toml                 # model catalogue overrides
  policy/*.star, *.toml       # rule sources; hz_policy compiles them
  secrets/keyrefs.toml        # references only — never values
  skills/, plugins/, agents/  # user-provided manifests

$XDG_STATE_HOME/horizon/          # default ~/.local/state/horizon/
  user.db                          # trust records, model registry cache, price table
  memory/<workspace_digest>.db     # user-scope memory (+ .vec sidecar)
  worktrees/                       # worktree pool root (working copies)
  logs/hzk.log

$XDG_RUNTIME_DIR/horizon/         # default /run/user/<uid>/horizon/
  hzk.sock, hzk.pid            # supervisor lease + ABI socket (§6.1)
```

Nothing outside this list is written by HorizonCode. A path under `.hz/` is workspace data; a path under `$XDG_STATE_HOME` is machine data; the two are never mixed in one file, because one is copyable with the repository and the other is not. `12-sessions-state.md` §4.1 owns the canonical layout; this tree MUST match it.

### 4.4 Blob / CAS layout

1. **Address.** Every blob is named by the `sha256` of its bytes. The path is `<root>/<ab>/<cd>/<sha256>` — the canonical **two-level** shard (`12-sessions-state.md` §4.1), one layout for session blobs and kernel artifacts alike: a workspace accumulates blobs from every session it ever ran, and the second level keeps directory sizes sane.
2. **Write.** `create temp in the same directory → write → fsync file → rename → fsync directory → insert/refcount in the owning store`. A crash between rename and refcount insert is repaired by `hzcode doctor` (scan-and-adopt), never by trusting one side.
3. **Read.** Verified on first read per process only if the blob is an evidence artifact; ordinary tool output trusts the digest (cost of re-hash is not worth it on the hot path).
4. **Deduplication.** The same bytes are stored once. The `blobs.refcount` (runtime) and the artifact refs (kernel) are separate counters; neither store may delete a blob the other still references by digest inside a live receipt or evidence bundle.
5. **GC.** Only at `hzcode gc`, only with refcount `0`, only for blobs older than the retention marker. A blob referenced by any unreconciled effect or any `UNKNOWN` claim is never collected (§5.2).
6. **Two stores, one rule.** The runtime CAS (`.hz/state/blobs/`) and the kernel-owned artifact CAS (`.hz/state/artifacts/`) MUST NOT share a directory and MUST NOT share a database. The verifier compares them by digest (`verify_chain()` / `joinReceipts()`), which is the only permitted join.

### 4.5 Retention

Events are retained per the retention policy recorded in `retention_ledger`; a snapshot (`event_snapshot`) is taken before any compaction, and `hz.session.compacted` names the snapshot. Usage rows and receipts are never compacted — auditability beats disk. Kernel OwnerLog segments are sealed, never rewritten; deleting a sealed segment is a manual, audited operation the kernel refuses to do automatically.

---

## 5. Errors and failure modes

### 5.1 Taxonomy

One error type crosses every boundary: `HzError` from `@horizoncode/shared` / `KernelErrorV1` from `hz_abi`. Every error carries a dotted code and **exactly one** class from `{refuse, retry, degrade, defect}` (L-18). An error without a class is by definition a `defect` and is reported as `internal.unclassified`.

| Class | Meaning | Caller MUST | Exit code (RC-5) |
|---|---|---|---|
| `refuse` | The operation is not permitted, or provably cannot be performed as asked. | Not retry, not rephrase, not translate to success (L-19). Surface as-is. | `4` (policy denial) / `3` (unprovable) |
| `retry` | Transient: the same request may succeed later, unchanged. | Retry under the declared backoff, with the same idempotency key. | `1` after retries |
| `degrade` | The operation can proceed with reduced capability or fidelity. | Proceed only if the degradation is declared, and record it on the run receipt and in `hzcode doctor` (L-42). | `0` or `1` accordingly |
| `defect` | An invariant was violated. There is no correct recovery in the caller. | Stop the aggregate, preserve the evidence, raise `hz.error.raised`. | `1` |

### 5.2 Code prefixes

Codes are `<prefix>.<snake_case>`, where the prefix names the owning module. Only event names carry the `hz.` namespace (`_conventions.md` §1). The prefix identifies the module that owns the meaning, and therefore who may fix it.

| Prefix | Owner | Example codes | Default class | Fail-closed? |
|---|---|---|---|---|
| `session.*` | `core/session/*` | `session.posture_stale`, `session.claim_conflict`, `session.closed` | `refuse` | yes |
| `step.*` | `core/step/*` | `step.no_stream`, `step.truncated`, `step.history_missing` | `retry` / `defect` | no |
| `context.*` | `@horizoncode/context` | `context.budget_exceeded`, `context.nondeterministic` | `refuse` / `defect` | yes |
| `tools.*` | `core/tools/*` | `tools.unknown`, `tools.args_invalid`, `tools.settle_incomplete` | `refuse` / `defect` | yes |
| `effect.*` | `core/effect/*` | `effect.duplicate_settlement`, `effect.reconcile_required`, `effect.lease_invalid` | `refuse` / `defect` | yes |
| `guard.*` | `hz_kernel/guard.rs` | `guard.denied`, `guard.ask_required`, `guard.workspace_unbound` | `refuse` | yes |
| `policy.*` | `hz_kernel/policy.rs` + `hz_policy` | `policy.compile_failed`, `policy.revision_stale` | `refuse` | yes |
| `lease.*` | `hz_kernel/lease.rs` | `lease.expired`, `lease.consumed`, `lease.revoked` | `refuse` | yes |
| `effect_host.*` | `hz_kernel/effect_host.rs` | `effect_host.spawn_failed`, `effect_host.cancelled`, `effect_host.unknown` | `retry` / `degrade` | yes on `unknown` |
| `sandbox.*` | `hz_kernel/sandbox.rs` + `hz_sandbox` | `sandbox.missing_dimension`, `sandbox.profile_unsatisfiable` | `refuse` | yes |
| `budget.*` | `hz_kernel/budget.rs`, `core/session/budget.ts` | `budget.exhausted`, `budget.reserve_failed` | `refuse` | yes |
| `verify.*` | `hz_kernel/verifier.rs`, `core/session/verify.ts` | `verify.unsupported`, `verify.evidence_missing` | `degrade` (lowers, never raises — L-31) | yes |
| `protocol.*` | `@horizoncode/protocol` | `protocol.revision_mismatch`, `protocol.unknown_method` | `refuse` | yes |
| `native.*` | `@horizoncode/shared` loader | `native.load_failed`, `native.double_load` | `refuse` | yes |
| `provider.*` | `@horizoncode/provider` | `provider.rate_limited`, `provider.stream_reset`, `provider.model_unknown` | `retry` / `refuse` | no |
| `mcp.*` / `acp.*` / `plugin.*` | their packages | `mcp.connect_failed`, `plugin.grant_missing` | `refuse` / `retry` | yes |
| `config.*` | `@horizoncode/cli` | `config.invalid`, `config.missing_keyref` | `refuse` | yes |
| `internal.*` | anyone | `internal.unclassified`, `internal.multi_writer`, `internal.cas_inconsistent` | `defect` | yes |

**Fail-closed list.** `guard.*`, `policy.*`, `lease.*`, `sandbox.*`, `budget.*`, `protocol.revision_mismatch`, `verify.*`, `native.load_failed`, `internal.*`: when any of these is raised, the affected operation MUST NOT be attempted, and the runtime MUST prefer refusal to an unproven proceed. A `degrade` is legal only where the degradation is declared in the capability's status row (§10) and recorded (L-42).

**Internal vs wire codes.** The codes of this table are module-internal diagnostics — raised across module boundaries inside the runtime and carried in `hz.error.raised` payloads. They are **not** wire codes: a surface that returns an error to a caller maps them to the registered `HZ_*` vocabulary (`07-apis-and-contracts.md` §4.10.2), and a wire carrier MUST NOT contain a dotted internal code (RC-16(b)).

### 5.3 Crash policy per boundary

Each row states what survives a crash at that boundary, and what the process does when it comes back. "Crash" includes `SIGKILL`, OOM kill, power loss, and a panicking child — the design does not distinguish.

| # | Boundary | Durable state before the crash | After the crash | Class |
|---|---|---|---|---|
| CB-1 | CLI process dies before the kernel handshake | argv, config files only | Nothing to recover. Next start re-runs `spawnSupervisor()`; a stale `hzk.pid` is ignored unless the supervisor lease says the epoch is live. | — |
| CB-2 | CLI dies after the handshake, before any submit | No session, no claim | Next start attaches to the running `hzk`; the supervisor keeps serving other clients. | — |
| CB-3 | CLI dies mid-step, no effect dispatched | `events` up to the step start; claim `held` | Resume: `recoverClaim()` → the step is re-run from the log with the same `stepId` (L-8); the provider call is repeated under the same `idempotencyKey`. | `retry` |
| CB-4 | Runtime dies between intent and dispatch | Intent in the OwnerLog (`OwnerLog.append()`, L-27); no lease consumed | Claim recovered; `reconcile()` finds an intent with no receipt; the kernel settles it via its declared uncertainty path. | `refuse` until reconciled |
| CB-5 | Runtime dies mid-effect | Intent durable; lease consumed; no receipt | The effect MAY have run. `pendingUnknown()` → `hz.effect.unknown` → reconciliation (§6.6). Never auto-retried before reconciliation (L-32). | `degrade` until proven |
| CB-6 | Kernel (`hzk`) dies | OwnerLog `head` committed; leases in memory lost | The supervisor lease is re-acquired with `advance_epoch()`; every outstanding lease is invalid by epoch; clients get `lease.revoked`; effects settle `interrupted` or `unknown` by replay. | `refuse` on stale epoch |
| CB-7 | Crash between event insert and projection commit | One transaction: both or neither (§4.2 rule 2) | WAL rollback; `rebuild()` reproduces projections from `events`. No partial event exists. | `defect` if observed |
| CB-8 | Crash during blob write | Temp file present, no rename, maybe no row | Temp garbage is swept; a row without bytes is `internal.cas_inconsistent`; `hzcode doctor` repairs (scan-and-adopt). | `defect` |
| CB-9 | Child process (tool/subagent/plugin) crashes | Parent holds the receipt and the effect id | The exit status is the observation: the effect settles `failed` (or `interrupted` for cancellation), never `UNKNOWN` by default; `mark_unknown()` only on lost observation. | `retry` per tool |
| CB-10 | TUI dies | Nothing durable | The session continues headless if a server/client remains attached; the TUI re-attaches by `replay()` from its last cursor. | — |
| CB-11 | Machine reboot | `.hz/state/hzcode.db`, OwnerLog segments, artifacts | Startup gate: supervisor epoch advances, claims recovered, `hzcode doctor` reports anything it repaired. | — |

**Crash rules.**

1. No module MAY invent a terminal state it cannot support: after a crash the only honest states are the ones the store proves (L-32).
2. A claim is never silently dropped. It is `recovered` only through `recoverClaim()`, which records the transition in the log.
3. Reconciliation is a foreground, visible step: `effect.reconcile_required` blocks the next effect in the same batch until it resolves.
4. A crash during a batch does not orphan its other calls: unresolved calls settle `interrupted` with `reason: process_lost`, so the batch always settles exactly once (L-9, L-23).

---

## 6. Flows

Six LLD-level flows. Each names the process (`[cli]`, `[hzk]`, `[surface]`, `[core]`) and the exact function at every hop, so a reader can check the call chain against §3.1–§3.4 line by line. Event names are the canonical ones of `_conventions.md` §6.

### 6.1 F1 — cold start: `hzcode` → `hzk` handshake → first prompt

1. `[cli]` `main(argv)` → `runCommand()`; `resolveConfig()` reads `$XDG_CONFIG_HOME/horizon/config.jsonc` then `<ws>/.hz/config.jsonc` (workspace wins). No network is touched on this path.
2. `[cli]` `loadNative()` — the single native-addon loader (`@horizoncode/shared`, L-24). Failure is `native.load_failed`, `refuse`, exit `3`; the CLI MUST NOT start a degraded shell that pretends to have the engine.
3. `[cli]` `spawnSupervisor()`: if `$XDG_RUNTIME_DIR/horizon/hzk.sock` answers a hello, attach; otherwise start `hzk`.
4. `[hzk]` `startup::run()` → `gate_startup()` → `acquire_lease()` on the host-wide supervisor lease; a second live owner causes `supervisor.epoch_behind` and exit, so exactly one `hzk` owns the host (CB-6).
5. `[hzk]` `serve_authenticated()` after peer authentication in `unix_peer.rs` / `windows_peer.rs`; the peer principal is captured from the kernel side (SO_PEERCRED / pipe impersonation), never asserted by the client.
6. `[cli]` `attachKernel()` → `KernelClient.connect()` (the only connect site outside tests). Hello exchange carries `HZ_ABI=1`; `assertRevision()` fails closed with `protocol.revision_mismatch`.
7. `[surface]` The surface mounts immediately — `mountFullscreen()` paints the first frame from local config alone (PB-L04) — while the handshake proceeds in parallel; the first paint NEVER waits for the kernel or a provider.
8. `[core]` `createController()` opens the session store, runs `projectAll()` to the last cursor, then `hzcode doctor`-equivalent checks run only under `--doctor` (not on the fast path).
9. `[core]` Session selection: `resume()` of the most recent session or `createSession()`; either way the process is now *ready*. Nothing has been submitted; no claim exists yet.
10. Budget: kernel attach must complete before the first user submit, not before the first paint. Warm attach ≤ `PB-L02b`; cold kernel start ≤ `PB-L02a`.

### 6.2 F2 — read-only turn (no authority round-trip)

1. `[surface]` The user submits text; the surface speaks only to `@horizoncode/sdk` (`HzClient.submit()`) over `HZ_PROTO=1` — never to `core` directly.
2. `[core]` `server` (or the in-process sdk bridge in single-process mode) calls `Controller.submit()` with `idempotencyKey`; a replay returns the original `AdmitResultV1` (L-1). `submit()` normalizes and admits only — no provider, no kernel, no filesystem effect (L-2).
3. `[core]` `SessionEngine.admit()` → `reconcileIdempotency()` → `EventLog.appendWithProjections()` writes `hz.session.prompt.admitted` as the first event of this input (L-3, L-41), then `hz.session.busy.entered`.
4. `[core]` The scheduler tick (the other legal caller of `admit()`, L-4) promotes inbox items at a safe boundary (L-5).
5. `[core]` `StepEngine.runStep()`: reload history from `events` (L-8) → `ContextCompiler.compile()` (pure, digestable; L-15/L-16) → `hz.step.started`.
6. `[core]` `provider.stream()` is the single provider dispatch of the step (L-7); deltas become `hz.step.llm.delta`, the close becomes `hz.step.llm.completed`; `session/budget.ts` `reserve()` was taken before the call and released on every terminal path (L-29).
7. `[core]` Tool calls are accumulated by index (`step/stream.ts`), then `planBatch()` fixes the batch: one decision, one lease set, one settlement round (L-40).
8. `[core]` Read-only calls whose capability resolves `read-only` **and** whose arguments stay inside the workspace binding execute in-process through the `hz_native` facade (`hz_walker`, `hz_index`, `hz_ast`, `hz_diff`). This is the only tool path that does not reach the kernel, and it exists because L-12 governs *KernelClient*, not the native facade; a read that leaves the binding is an effect like any other (F3).
9. `[core]` `tools/runtime.ts` `execute()` decodes untrusted args, executes the call inside the confinement it was told it has, and `settle()`s every call of the batch exactly once (L-9); parallel fibers join before the barrier (L-23).
10. `[core]` `closeStep()` writes the tool results and `hz.step.tool.completed`; `verifySession()` records `hz.usage.recorded` and appends the run receipt; `hz.session.busy.left`.
11. `[surface]` The surface observes all of this by cursor (`events()` / `replay()`), not by return value; a surface that missed deltas re-reads the log.

### 6.3 F3 — mutating turn through Guard, lease and receipt

1. `[core]` Steps 1–7 of F2 up to `planBatch()`. The batch contains at least one call whose capability ID has effect class `workspace-write` (e.g. `files.write`, `files.patch`, `vcs.write`).
2. `[core]` `effect/runtime.ts` `submitBatch()` — the one module allowed to call the kernel client (L-12, L-33). It maps the plan to intents and calls `KernelClient.authorize()` **once per batch**.
3. `[hzk]` `guard.rs` `authorize()`: canonical operation → capability ID → `argument_digest()` → `workspace_binding()` → `policy.rs` `evaluate()` against the compiled revision. The origin kind is a function of the canonical operation, never of request fields the caller controls (L-11).
4. `[hzk]` Decision: `deny` → recorded as `hz.effect.decision.made` with a reason code and returned; **no** `hz.permission.asked` is ever emitted for a deny (RC-6). `ask` → F4. `allow` → continue.
5. `[hzk]` `lease.rs` `issue_batch()` mints one-use leases bound to the intent digest, posture revision and workspace binding. The lease id is a reference; authorization is re-checked at execute time (L-13).
6. `[hzk]` `OwnerLog.append()` records the intent **before** dispatch (L-27); `receipt.rs` opens a pending settlement slot; the kernel emits the decision to the client.
7. `[core]` `effect/runtime.ts` writes `hz.effect.decision.made` and `hz.effect.lease.issued` into the session log, then calls `execute()` with the lease.
8. `[hzk]` `effect_host.rs`: `consume()` the lease → `sandbox.rs` `profile_for()` for the current posture revision (probed once per revision, PB-14) → `cgroup/` `create_scope()` → spawn the child (`hz_shell` argv form, `hz_edit`/`hz_diff` for file work, PTY for terminals) → `mark_running()`.
9. `[hzk]` Observation: exit status, output blob digest, changed paths, residuals. `settle()` is the only successful exit from `Running`; `mark_unknown()` is the only uncertain one (L-32, L-37).
10. `[hzk]` `receipt.rs` `settle()` writes exactly one terminal receipt per `effectId`; a second settlement is `effect.duplicate_settlement` (L-14). The receipt is exposed as `hz://receipt/<id>`.
11. `[core]` `effect/ledger.ts` mirrors it: `hz.effect.settled`, then `hz.step.tool.completed`; the receipt digest is what `verifySession()` later joins against (L-31).
12. `[core]` `closeStep()` → `verifySession()` → budget `consume()` with the receipt's usage → `hz.usage.recorded`.

### 6.4 F4 — approval ask: surface ↔ kernel round trip

1. `[hzk]` `guard.rs` `approval_policy()` returns `ask`; the decision carries the `intent_digest`, the capability ID and the posture revision it decided under. An `ask` exists only where an answer could change the outcome (RC-6).
2. `[core]` `effect/runtime.ts` appends `hz.permission.asked` with that digest — the log, not the kernel, is the record a surface reads.
3. `[surface]` The TUI is subscribed through `@horizoncode/sdk`; it renders the prompt from the projected event and calls `HzClient.approve(approvalId, answer)` — it never talks to `hzk` and never sees a lease.
4. `[core]` `Controller.answer()` validates the question is still open, then re-enters `effect/runtime.ts`, which calls `KernelClient.execute()` with the answer bound to the same `intent_digest` and posture revision.
5. `[hzk]` Re-validation at execute time: a stale revision is `session.posture_stale`; a changed digest is `guard.denied`; both are `refuse` and neither is retried automatically (L-13, L-28).
6. `[core]` On accept: lease issued and F3 continues from step 7. On reject: `hz.permission.answered` with a negative answer, the call settles `denied`, and the step continues with a typed refusal the model may read (L-19).
7. Timeout or client EOF: the question expires; the call settles `denied` with `reason: unanswered`. Nothing hangs, and no effect is ever dispatched without an explicit answer.

### 6.5 F5 — subagent spawn: parent process, child session, narrowed budget

1. `[core]` A parent step emits a tool call for `agent.spawn` (capability `agent.spawn`). It goes through `planBatch()`/`effect/runtime.ts` like any other call.
2. `[core]` `agents/spawn.ts` `spawnChild()` — **the one child-construction primitive** (H-14). Nothing else may create a session for another agent.
3. `[core]` `narrowGrant(parentGrant)` computes the intersection with the child profile's ceiling; `agents/profile.ts` `resolveProfile()` rejects a profile whose ceiling exceeds the parent's (`guard.*` semantics on the runtime side).
4. `[core]` `session/budget.ts` `inheritToChild()` reserves from the parent's reservation and passes a strictly smaller budget (L-29); the child's `ResourceBudgetV1` can never exceed the parent's remaining headroom.
5. `[hzk]` `agent.rs` `validate_profile()` and `ceiling_for()` check the profile against the kernel's ceiling; `EffectReceiptV1` linkage is established so the child's results land under the parent's receipt chain (`deliver_child_result()`).
6. `[core]` The child is a **separate session** in the same `events` table with its own aggregate, cursor, claim and posture digest — never a second writer on the parent's aggregate (L-6). `hz.agent.spawned` is appended in the child log and mirrored to the parent projection.
7. `[core]` `ContextCapsuleV1` carries the child's inputs; the child reads nothing from the parent's memory except the capsule and the declared task.
8. `[core]` Runnable isolation: worktree-bound children run in a leased worktree (`worktree.rs` `acquire()`), so their writes cannot collide with the parent's (L-40 batch discipline applies to each process separately).
9. `[core]` On completion the child verifies itself, then `hz.agent.completed` plus `sendMessage()` on the durable bus; the parent is woken by the message projection, not by a callback in memory.
10. `[core]` The parent's reconciliation joins the child's receipts; a child that died mid-effect follows CB-5/CB-9, and its `UNKNOWN` blocks only its own attempts.

### 6.6 F6 — crash-resume: claim recovery → `UNKNOWN` → reconciliation

1. Precondition: a process died between intent and receipt (CB-4/CB-5). On disk: claim `held`, an intent in the OwnerLog, no terminal receipt, possibly a live child.
2. `[core]` Next start: `EventLog` opens, `projectAll()` catches up, then `SessionEngine.claim.recoverClaim()` takes the claim over; `ownerEpoch` is compared against the kernel's epoch and a stale-epoch claim is `lease.revoked` (CB-6).
3. `[core]` `effect/ledger.ts` `pendingUnknown()` enumerates effect ids with no mirrored terminal receipt and emits `hz.effect.unknown` for each — the honest state, never `failed` by assumption (L-32).
4. `[hzk]` `KernelClient.reconcile()` asks the kernel for the truth: `replay()` of the OwnerLog tail plus the receipt index. Three outcomes, in this order: (a) a receipt exists → mirrored as `hz.effect.reconciled`; (b) the intent exists with a live/crashed child observation → the kernel settles it `interrupted`/`failed` with evidence; (c) no observation exists → `mark_unknown()` keeps `UNKNOWN` as terminal.
5. `[hzk]` Settlement is idempotent (L-37): repeating `reconcile()` or `settle()` for the same effect converges, and a second receipt attempt is `effect.duplicate_settlement` (L-14).
6. `[core]` `verifier` side: `verifySession()` / `joinReceipts()` lowers every claim that depends on the unresolved effect to `unsupported` (L-31); nothing is raised to `verified` on hope.
7. `[core]` `hz.session.claim.released` or a renewed busy period; the inbox item that was in flight is re-promoted only after reconciliation closes (`effect.reconcile_required` blocks new effects in that batch).
8. `[core]` `hz.usage.recorded` attributes the cancelled attempt to the original `stepId` (RC-4). `hz.session.busy.entered` is not re-emitted for work that never re-started.
9. `[surface]` The surface sees the recovery as events at its cursor: no dialog, no hidden retry. `hzcode doctor` lists recovered claims, `UNKNOWN` effects and repaired stores (CB-7, CB-8).
10. Exit code for a session that ends with unresolved `UNKNOWN` work is `3` (unprovable/fail-closed, RC-5), never `0`.

---

## 7. Security and authority

### 7.1 Who may import `KernelClient` (L-12)

`@horizoncode/kernel-client` is the only door to `hzk`, and almost nothing may stand in front of it. The allow-list is closed: a new import site is a new authority surface and requires a change to this table first.

| Site | May call | Why this site and no other |
|---|---|---|
| `packages/core/src/effect/runtime.ts` | `connect()`, `authorize()`, `execute()`, `reserve()`, `reconcile()` | The effect path (L-12). Every effect in the system passes through here; one site means one place to audit, one place to test. |
| `packages/core/src/effect/ledger.ts` | `receipts()`, `reconcile()` only | Read-only mirror. It MUST NOT import `authorize()` or `execute()`; the test asserts on the imported symbol list, not just the module path. |
| `packages/cli/src/kernel.ts` `[planned]` | `connect()`, `attach()` only | The composition root spawns and attaches the kernel (F1). It MUST NOT authorize or execute — the CLI is not an effect path. |
| `packages/testing/*` | anything | Tests may simulate the kernel; production code MUST NOT import `testing` (§3.1 rule 4). |

Everything else — tools, agents, plugins, workflows, MCP, ACP, server, sdk, ui, tui, web, desktop, skills, learn — MUST NOT import `@horizoncode/kernel-client` at all. A tool that needs an effect returns a **declared effect intent** (`toEffectIntent()`), and `effect/runtime.ts` decides what to do with it (L-33).

### 7.2 Module-level authority rules

Authority is a property of the module, not of a parameter bag. These rules are absolute and are each proved by a boundary test (§9.2).

| Rule | Module | Statement |
|---|---|---|
| A-1 | `core/session/log.ts` | The only module that appends durable events. It MAY be imported by any core module; it MAY NOT import a provider, a kernel client or a surface (L-6, L-22). |
| A-2 | `core/session/admit.ts` | The only writer of `hz.session.prompt.admitted`. Callable only from `Controller.submit()` and the scheduler tick (L-3, L-4). |
| A-3 | `core/effect/runtime.ts` | The only caller of `authorize()`/`execute()`. It may not decide policy: it forwards digests and leases (L-11, L-12). |
| A-4 | `core/agents/spawn.ts` | The only constructor of a child session (H-14). It may only narrow, never widen, a grant (F5). |
| A-5 | `core/tools/runtime.ts` | Executes tool implementations and returns intents. It MAY NOT import the kernel client, and it MAY NOT invent a capability ID or effect class (`tools/declaration.ts` validates both, H-24). |
| A-6 | `core/session/projector.ts` | Pure; no I/O beyond its own tables, no network, no clock (L-30). |
| A-7 | `core/session/verify.ts` + `hz_kernel/verifier.rs` | May lower a claim, never raise it; a claim without a receipt is `unsupported` (L-31). |
| A-8 | `core/session/budget.ts`, `hz_kernel/budget.rs` | May reserve, consume, release and refuse on exhaustion. Neither may authorize an effect; a budget is not a permission. |
| A-9 | `hz_kernel/guard.rs` | The only decider. It reads the compiled policy and the workspace binding, and nothing else it was not given. |
| A-10 | `hz_kernel/owner_log.rs` | The only kernel module that writes durable authority state; every other module goes through `append()`/`commit()`. |
| A-11 | `hz_kernel/effect_host.rs` | The only executor. `settle()` and `mark_unknown()` are its only exits from `Running` (L-32). |
| A-12 | `packages/tui/*`, `packages/web/*` | Presentation only. No domain logic, no kernel client, no policy evaluation, no lease handling. A surface that needs a decision asks the Controller (F4). |
| A-13 | `@horizoncode/plugin` host | Runs out-of-process under a manifest grant; its grant is a subset of `plugins.invoke` plus the declared capabilities, never an ambient one. |
| A-14 | `hz_native` | Carries no authority code: it MUST NOT depend on `hz_kernel`, transitively (H-17, §3.2 rule 1). |

### 7.3 Narrowing

Three narrowing operations exist, and no other component may perform one:

1. **Grant narrowing** — `narrowGrant()` (`agents/profile.ts`) intersects the parent's grant with the child profile's ceiling at spawn (F5 step 3).
2. **Posture narrowing** — `posture.narrow()` (`session/posture.ts`) merges a posture with a lower-capability one and re-digests; staleness is detected by `assertFresh()` (L-28).
3. **Budget narrowing** — `budget.inheritToChild()` passes a strictly smaller reservation (L-29).

A module that needs a *wider* authority than it holds MUST fail with `guard.denied`; there is no runtime widening path, and no configuration key that grants one.

---

## 8. Performance budgets

Numbers are the plan, not a measurement: they are the thresholds the tests of §9 assert against once code exists. **Runtime** latencies (event append, guard decision, receipt settle, kernel round trip) are owned by `08-runtime.md` §8 — the single owner of runtime budget numbers — and the rows below cite that section instead of restating a rival value (reconciled 2026-11-07, reaudit stage 2, RC-15). Reference hardware is the `perf` profile of the CI runner (4 vCPU, NVMe); a budget is measured on the hot path only — no debug spans, no `--doctor`, no telemetry export.

| # | Metric | p50 | p95 | Measurement point | Owning module |
|---|---|---|---|---|---|
| PB-L01 | CLI cold start → prompt ready (`hzcode` typed, user can submit) | ≤ 120 ms | ≤ 250 ms | Process start → first input cell accepting text | `@horizoncode/cli` |
| PB-L02a | Kernel cold start → handshake accepted | ≤ 40 ms | ≤ 80 ms | `hzk` exec → hello accepted | `supervisor.rs`, `transport.rs` |
| PB-L02b | Warm attach (kernel already running) | ≤ 5 ms | ≤ 12 ms | `attachKernel()` → hello response | `@horizoncode/kernel-client` |
| PB-L03 | Module load | per package ≤ 8 ms; core spine ≤ 45 ms; native addon ≤ 15 ms | ≤ 2× | `import()` measured per package at first use | all packages |
| PB-L04 | TUI first paint | ≤ 50 ms fullscreen, ≤ 30 ms inline | ≤ 100 ms | Surface selection → first frame flushed | `@horizoncode/tui` |
| PB-L05 | Tool dispatch overhead (excludes the effect itself) | ≤ 3 ms per call | ≤ 12 ms for a batch of 8 | `planBatch()` → first admission of the batch | `core/step/batch.ts`, `tools/runtime.ts` |
| PB-L06 | Event append latency | (budget owned by 08 §8) | (budget owned by 08 §8) | `appendWithProjections()` call | `session/log.ts` |
| PB-L06b | Replay of 10 000 events into a fresh projection set | ≤ 400 ms | ≤ 1 s | `rebuild()` | `session/projector.ts` |
| PB-L07 | Projection update per event | ≤ 1 ms | ≤ 4 ms | inside the append transaction | `session/projector.ts` |
| PB-L08 | Guard decision per batch | (budget owned by 08 §8) | (budget owned by 08 §8) | `authorize()` round trip, warm policy revision | `guard.rs`, `policy.rs` |
| PB-L08b | Lease consume + validate | ≤ 0.5 ms | ≤ 2 ms | `lease.rs` `consume()` / `validate()` | `lease.rs` |
| PB-L09 | Effect dispatch overhead before the child runs | ≤ 2 ms | ≤ 5 ms | `execute()` → child spawned | `effect_host.rs`, `sandbox.rs`, `cgroup/` |
| PB-L10 | Context compile | prefix digest hit ≤ 3 ms; full compile ≤ 25 ms for a 100 k-token window | ≤ 2× | `ContextCompiler.compile()` | `context/compiler.ts` |

**Budget rules.**

1. A budget is a gate, not an aspiration: `gate/perf` fails on a > 20 % regression against the previous release baseline, and a new capability MUST add its row here before it may claim `WIRED`.
2. First paint (PB-L04) MUST NOT depend on PB-L02a: the surface renders from local config and subscribes afterwards (F1 step 7). A design that serializes them fails `perf/first-paint-independence`.
3. Kernel-side budgets (PB-L08, PB-L09) are measured with the policy revision warm; a cold policy compilation is attributed to PB-L02a instead.
4. Every budget has a named owning module. A budget with no owner is deleted, not aspirational.
5. Numbers are `UNKNOWN` until a measurement exists — never restated as achieved. The first measurements land in the perf section of `08-runtime.md`, not in this document.

---

## 9. Tests

### 9.1 Kinds of test

| Kind | What it can prove | Where it lives |
|---|---|---|
| `unit` | One function against its contract (determinism, ordering, classification). | `packages/*/test/unit`, `crates/*/src/**/tests` |
| `integration` | Two modules through their real interfaces, in one process. | `packages/*/test/integration` |
| `boundary` | That a *forbidden* call does not exist (import graphs, call sites, symbol lists). | `packages/testing/src/boundary/*` |
| `ratchet` | That debt only decreases (size, layering, parity, API surface). | `packages/testing/src/ratchets/*` |
| `fault` | Behaviour under injected crash, kill, EOF, corruption, overflow. | `packages/testing/src/inject/*` |
| `e2e` | A whole flow (F1–F6) across processes with a real `hzk`. | `e2e/*` |

### 9.2 Test matrix

Every rule of §2 and every flow of §6 has at least one row. `gate` names the CI gate that owns the row; a row with no gate is a test that does not run, and therefore does not exist.

| # | Test | Proves | Kind | Gate |
|---|---|---|---|---|
| T-01 | `controller/submit-idempotent` | L-1: replay returns the original `AdmitResultV1`. | unit | `gate/core` |
| T-02 | `controller/submit-purity` | L-2: no provider, kernel or effect call inside `submit()`. | boundary | `gate/import-boundary` |
| T-03 | `session/admission-order` | L-3, L-41: `prompt.admitted` is the first event, once per input. | integration | `gate/core` |
| T-04 | `boundary/admit-callers` | L-4: only `submit()` and the scheduler tick call `admit()`. | boundary | `gate/import-boundary` |
| T-05 | `inbox/ordering` | L-5: per-session order preserved; `steer` promoted only at a boundary. | unit | `gate/core` |
| T-06 | `log/single-writer` | L-6: exactly one writer per session aggregate; the claim is held for the busy period. | fault | `gate/single-writer` |
| T-07 | `step/one-stream` | L-7: `runStep()` dispatches exactly one provider stream; no second caller. | boundary + unit | `gate/import-boundary` |
| T-08 | `step/history-from-log` | L-8: no cross-step in-memory history. | unit | `gate/core` |
| T-09 | `tools/settle-complete` | L-9: every call settles exactly once; a missing settlement is a defect. | fault | `gate/core` |
| T-10 | `tools/declaration-frozen` | L-10: declarations are frozen at registry build. | unit | `gate/core` |
| T-11 | `kernel/origin-typing` | L-11: the origin kind is a function of the canonical operation. | unit | `gate/kernel` |
| T-12 | `boundary/effect-submission` | **L-12, L-33**: the only importer of `KernelClient.authorize()`/`execute()` is `core/effect/runtime.ts`; no tool, agent or plugin imports them. | boundary | `gate/effect-path` |
| T-13 | `kernel/lease-revalidate` | L-13: digest, posture revision and workspace binding re-checked at execute. | integration | `gate/kernel` |
| T-14 | `kernel/settlement` | L-14, L-32: duplicate settlement rejected; `UNKNOWN` only via `mark_unknown()`. | unit + fault | `gate/kernel` |
| T-15 | `context/compile-determinism` | L-15: byte-identical output for identical inputs. | unit | `gate/cacheguard` |
| T-16 | `context/cache-guard` | L-16, L-39: no timestamps, ids, unsorted schemas or map order in the prefix. | unit | `gate/cacheguard` |
| T-17 | `ratchet/parity` | L-17: declared capability ↔ surface projection bijection. | ratchet | `gate/parity` |
| T-18 | `errors/classification` | L-18: every error has a code and exactly one class. | unit + boundary | `gate/errors` |
| T-19 | `errors/refusal-tunnel` | L-19: a `refuse` cannot be mapped to success anywhere. | unit | `gate/errors` |
| T-20 | `cancel/scope`, `cancel/settles` | L-20, L-21: cancellation is scoped and always settles. | fault | `gate/core` |
| T-21 | `log/lock-discipline` | L-22: no log lock held across an unrelated await. | boundary | `gate/core` |
| T-22 | `tools/fiber-failure` | L-23: a fiber failure is a typed per-call failure, not a crash. | fault | `gate/core` |
| T-23 | `native/single-loader` | L-24: exactly one addon load site. | boundary | `gate/import-boundary` |
| T-24 | `session/backpressure` | L-25: bounded mailbox applies backpressure; no dropped item. | fault | `gate/core` |
| T-25 | `codegen/single-source` | L-26: no hand-written duplicate of a generated type. | ratchet | `gate/codegen` |
| T-26 | `kernel/intent-before-dispatch` | L-27: intent durable before dispatch. | fault | `gate/kernel` |
| T-27 | `session/posture-revision` | L-28: stale revision fails with `session.posture_stale`. | integration | `gate/core` |
| T-28 | `budget/reserve-release` | L-29: reserve before spend, release on every terminal path. | fault | `gate/core` |
| T-29 | `log/replay-complete` | L-30: projectors are pure and replay-complete. | integration | `gate/core` |
| T-30 | `verify/monotone-lowering` | L-31: verification never raises a claim. | unit | `gate/kernel` |
| T-31 | `api/surface` | L-34: every export appears in §3. | ratchet | `gate/api-surface` |
| T-32 | `ratchet/size` | L-35: file/function ceilings, debt non-increasing. | ratchet | `gate/size` |
| T-33 | `topology/kernel-independence` | L-36: the kernel's suite passes with no supervisor running. | integration | `gate/topology` |
| T-34 | `kernel/settlement-idempotent` | L-37: settle/reconcile converge. | fault | `gate/kernel` |
| T-35 | `ids/sortable` | L-38: all identifiers sortable; digests are `sha256`. | unit | `gate/core` |
| T-36 | `kernel/batch-unit` | L-40: one decision, one lease set, one settlement round per batch. | integration | `gate/kernel` |
| T-37 | `degrade/visibility` | L-42: every `degrade` is recorded and visible in `hzcode doctor`. | integration | `gate/core` |
| T-38 | `flows/e2e-f1` … `flows/e2e-f6` | §6 F1–F6, including crash points CB-3 to CB-6. | e2e + fault | `gate/flows` |
| T-39 | `perf/budgets` | §8 PB-L01…PB-L10, with the > 20 % regression rule. | e2e | `gate/perf` |

### 9.3 The three load-bearing boundary tests

1. **Import boundary — no `core` → surface imports.** `LayeringRatchet.check()` builds the import graph of `packages/*/src/**` and fails on any of: an import from a lower-ranked package (rank map of §3.1), an import from `@horizoncode/testing` outside tests, and specifically **any import from `packages/core/**` of `@horizoncode/tui`, `web`, `desktop`, `sdk`, `server` or `cli`** (§3.4 rule 5). The test is deliberately written as a *deny-list of edges plus an allow-list of rank*, so a brand-new package is rejected until it is placed in the rank table.
2. **Single writer.** `log/single-writer` starts two session actors over one store, injects a stall inside the first `appendWithProjections()`, and asserts the second writer gets `session.claim_conflict` and appends nothing; a mutation test removes the claim guard and asserts the test fails. The same test covers L-22 (the lock is not held across the stalled await) and L-25 (the mailbox applies backpressure instead of dropping).
3. **Effect path.** `boundary/effect-submission` resolves the import graph to *symbol* level and asserts the set of modules importing `KernelClient.execute`, `KernelClient.authorize` and `KernelClient.reserve` is exactly `{ packages/core/src/effect/runtime.ts }`, and that no module under `packages/tools`, `packages/agents`, `packages/plugin`, `packages/workflow`, `packages/mcp` or any surface imports `@horizoncode/kernel-client` at all. `core/effect/ledger.ts` is asserted to import only `receipts`/`reconcile` symbols (§7.1).

All three are **structural**: they fail on code that was never run, which is the point — they must fail at review time, not in production.

### 9.4 CI enforcement

| Gate (CI job) | Command | Blocks | Fail mode |
|---|---|---|---|
| `gate/import-boundary` | `pnpm gate:import-boundary` | T-02, T-04, T-07, T-23 and §9.3.1 | fail-closed, no override |
| `gate/effect-path` | `pnpm gate:effect-path` | T-12 and §9.3.3 | fail-closed, no override |
| `gate/single-writer` | `pnpm gate:single-writer` | T-06 and §9.3.2 | fail-closed |
| `gate/layering` | `pnpm gate:layering` | rank order of §3.1/§3.2 | fail-closed |
| `gate/codegen` | `pnpm gate:codegen` (`hz_codegen verify_fresh()`) | T-25, `hz_abi` and `@horizoncode/protocol` freshness | fail-closed |
| `gate/cacheguard` | `pnpm gate:cacheguard` | T-15, T-16, RC-8 golden pins | fail-closed, `--update-golden` requires rationale |
| `gate/parity` | `pnpm gate:parity` (`ParityRatchet.check()`) | T-17 | fail-closed |
| `gate/api-surface` | `pnpm gate:api-surface` | T-31 | fail-closed |
| `gate/size` | `pnpm gate:size` (`ratchet/size`) | T-32 | fail-closed, debt may only decrease |
| `gate/errors` | `pnpm gate:errors` | T-18, T-19 | fail-closed |
| `gate/kernel` | `cargo test -p hz_kernel` | T-11, T-13, T-14, T-26, T-30, T-34, T-36 | fail-closed |
| `gate/topology` | `cargo test --workspace --features no-supervisor` | T-33 (L-36) | fail-closed |
| `gate/core` | `pnpm test -w @horizoncode/core` | the remaining core rows | fail-closed |
| `gate/flows` | `pnpm e2e` | T-38 | fail-closed |
| `gate/perf` | `pnpm perf` (nightly + release branches) | T-39 | fail on > 20 % regression |

**CI rules.** Every gate runs on every PR; a gate that is skipped is reported as failed, not as skipped. There is no `--force` for `fail-closed` gates; the only way past one is a change to this document and the rule it cites. `hzcode doctor --gates` reproduces the gate set locally, so a contributor sees the same verdict before pushing.

---

## 10. Status

> **Implementation status (RC-13).** Every row below is `DESIGNED` in the package/crate layout this document fixes. The v0.1 implementation that exists is a different, smaller layout; its evidence-backed levels are in `docs/28-implementation-status.md`.

The evidence column names the rule, flow or table in this document that designs the capability, plus the ancestor module it descends from where one exists. A row may not claim `CODE_PRESENT` or above until code and its test exist in the same repository; a row whose design is incomplete says so instead of implying more.

| Capability | Level | Evidence |
|---|---|---|
| Phase separation (`cli` / `core` / `hzk`) | `DESIGNED` | §3.1–§3.2, §6.1, PB-L01/PB-L02 |
| Supervisor lease and epoch | `DESIGNED` | §3.3 `supervisor.rs`, CB-1/CB-2/CB-6 |
| ABI framing, revision negotiation, peer auth | `DESIGNED` | §3.3 `transport.rs`/`peer.rs`, `protocol.revision_mismatch` |
| Guard: canonical operation → capability ID → decision | `DESIGNED` | §3.3 `guard.rs`, L-11, F3 step 3 |
| Policy host and revisioning | `DESIGNED` | §3.3 `policy.rs`, L-28, PB-L08 |
| Leases (one-use, epoch-bound) | `DESIGNED` | §3.3 `lease.rs`, L-13, PB-L08b |
| Effect host state machine | `DESIGNED` | §3.3 `effect_host.rs`, L-32/L-37, F3 |
| Receipt ledger and duplicate rejection | `DESIGNED` | §3.3 `receipt.rs`, L-14, `hz://receipt/<id>` |
| OwnerLog (hash chain, committed head) | `DESIGNED` | §3.3 `owner_log.rs`, L-27, §4.3 |
| Verifier (monotone lowering) | `DESIGNED` | §3.3 `verifier.rs`, L-31, F6 step 6 |
| Budgets (reserve/consume/release) | `DESIGNED` | §3.3 `budget.rs`, L-29, F5 step 4 |
| Worktree pool and leases | `DESIGNED` | §3.3 `worktree.rs`, F5 step 8 |
| cgroup v2 containment and sampling | `DESIGNED` | §3.3 `cgroup/`, CB-9 |
| Sandbox bridge and guarantee vectors | `DESIGNED` | §3.3 `sandbox.rs`, `sandbox.*` fail-closed |
| Artifacts and checkpoints (authority CAS) | `DESIGNED` | §3.3 `artifact.rs`/`checkpoint.rs`, §4.4 |
| Managed domain (goal → run → task → evidence) | `DESIGNED` | §3.3 `managed.rs`, A-7 |
| Secrets as handles | `DESIGNED` | §3.3 `secrets.rs`, §4.1 last row |
| Automation journal | `DESIGNED` | §3.3 `automation.rs`, RC-3 |
| Code-Mode host | `DESIGNED` | §3.3 `codemode.rs`, L-40 |
| Event log (single writer, transactional projections) | `DESIGNED` | §3.4 `session/log.ts`, L-6/L-22, §4.2, PB-L06 |
| Admission path | `DESIGNED` | §3.4 `session/admit.ts`, L-3/L-4/L-41, F2 |
| Controller and run loop | `DESIGNED` | §3.4 `controller.ts`, L-1/L-2, F2 |
| Inbox and promotion | `DESIGNED` | §3.4 `session/inbox.ts`, L-5 |
| Write-ahead claim and recovery | `DESIGNED` | §3.4 `session/claim.ts`, §4.2 `claims`, F6 |
| Projectors and replay | `DESIGNED` | §3.4 `session/projector.ts`, L-30, PB-L06b/PB-L07 |
| Step engine (one stream, history from log) | `DESIGNED` | §3.4 `step/engine.ts`, L-7/L-8, F2 |
| Tool registry, declarations, batch settlement | `DESIGNED` | §3.4 `tools/*`, L-9/L-10/L-40, A-5 |
| Effect runtime (the single kernel path) | `DESIGNED` | §3.4 `effect/runtime.ts`, L-12, §7.1, §9.3.3 |
| Receipt mirror and reconciliation queue | `DESIGNED` | §3.4 `effect/ledger.ts`, F6 |
| Context compiler, cache guard, memory, retrieval, compaction | `DESIGNED` | §3.4 `context/*`, L-15/L-16/L-39, PB-L10 |
| Subagent spawn and narrowing | `DESIGNED` | §3.4 `agents/spawn.ts`, H-14, F5 |
| Planner/executor routing, fleet, team, message bus | `DESIGNED` | §3.4 `agents/*`, F5 steps 9–10 |
| Posture and staleness | `DESIGNED` | §3.4 `session/posture.ts`, L-28 |
| Session verification and usage | `DESIGNED` | §3.4 `session/verify.ts`, L-31, RC-4 |
| Generated surfaces (`protocol`, `hz_abi`, SDKs) | `DESIGNED` | §3.2 rule 4, L-26, `gate/codegen` |
| Import, effect-path and single-writer gates | `DESIGNED` | §9.3–§9.4 |
| Performance budgets | `DESIGNED` (no measurement) | §8; numbers are thresholds, not results |
| TUI first paint independent of the kernel | `DESIGNED` | §8, PB-L04 + §8 budget rule 2, F1 step 7 |
| Windows peer authentication | `UNKNOWN` in depth | §3.3 `windows_peer.rs` names the mechanism only; the profile contents are owned by `11-authority-safety.md` |

**Status notes.** (1) The two capability crates with the widest blast radius — `hz_native` (no kernel dependency, H-17) and `hz_kernel` (no TypeScript dependency, L-36) — are designed as *testable topology claims*, not as conventions; §9.4 makes them gates. (2) Every `UNKNOWN` above is deliberate: this document designs the boundary and leaves the profile contents to doc 11. (3) No row may be promoted past `DESIGNED` on the strength of an ancestor repository: the `source:` lines of §3.3 point at real code to read, not at evidence for this design.

---

## 11. Related documents

- [`03-hld.md`](./03-hld.md) — the high-level design this document implements: planes, phase separation, the `H-` rules and the process model that §3, §6 and §8 refine.
- [`05-domain-and-schemas.md`](./05-domain-and-schemas.md) — the `V1` field lists behind every type named in §3 and §4; this document fixes semantics and table roles, doc 05 fixes fields.
- [`06-events-and-flows.md`](./06-events-and-flows.md) — the canonical event catalogue and the user-visible narratives that §6 implements at call-chain depth (RC-1…RC-4 originate there).
- [`08-runtime.md`](./08-runtime.md) — the runtime's own contract (process model, lifecycle, doctor); §9.4's gates and §8's first measurements belong to it.
- [`11-authority-safety.md`](./11-authority-safety.md) — the policy grammar, sandbox profiles and authority rules that §7 defers to; `guard.rs`, `policy.rs` and `sandbox.rs` are designed here and specified there.
- [`12-sessions-state.md`](./12-sessions-state.md) — the session store's schema and lifecycle; §4.2 names its tables and must not contradict it.
- [`13-tui.md`](./13-tui.md) — the surface that §6 F1–F4 treats as a client of `@horizoncode/sdk`; the TUI owns layout and interaction, never a call chain into `hzk`.
