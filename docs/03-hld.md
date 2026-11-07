# 03 — High-Level Design

> **Scope.** This document decides the *shape* of HorizonCode: which planes exist, which processes run, which components own which behaviour, what the interfaces between them are, how the whole thing is deployed, and what happens when each piece dies. It does not decide schemas, function bodies or tool semantics — those live in [`04-lld.md`](./04-lld.md) and the topical documents.
>
> Nothing in this document is a claim of working code for the capabilities it designs. `/data/home/forge/HorizonCode` contains a v0.1 implementation (`app/`, `bin/`, `kernel/`) whose levels are recorded in `docs/28-implementation-status.md` — the single source of truth (RC-13). Every capability below is **`DESIGNED`** unless `docs/28` promotes it.

**Derived from** (all paths absolute; repos live under `/data/home/forge/repo-tour/`):

- `source: /data/home/forge/repo-tour/horizoncode` — the execution constitution this design inherits: kernel process, Guard, origin-typed effects, one-use leases, receipts, OwnerLog, managed domain, sandbox with typed residuals.
- `source: /data/home/forge/repo-tour/opencode` — event-sourced core, admission inbox, write-ahead claim, one `llm.stream` per step, contract-separated monorepo.
- `source: /data/home/forge/repo-tour/codex` — per-OS sandbox depth, Starlark `execpolicy`, generated JSON-RPC across CLI/app-server/SDK, rollout replay.
- `source: /data/home/forge/repo-tour/grok-build` — fullscreen mouse TUI, leader process with client-side replay, in-process startup sandbox, workspace daemon, occurrence-journaled scheduler.
- `source: /data/home/forge/repo-tour/DeepSeek-Reasonix` — one transport-agnostic Controller behind every front-end, layering law enforced by `repolint`, cache-guard in CI, content-addressed Trusted Host State, evidence adjudication that can only lower a claim.
- `source: /data/home/forge/repo-tour/oh-my-pi` — one compiled native addon exposing the whole native capability stack, bidirectional ACP, deep LSP/DAP.
- `source: /data/home/forge/repo-tour/forgecode` — clean-architecture crate stack, compile-time tool descriptions, tolerant decoding and JSON repair for truncated tool arguments.
- `source: /data/home/forge/repo-tour/claude-code` — the declarative tool contract, wildcard rule ergonomics, skills, task system, coordinator.

---

## 1. Purpose

### 1.1 What this document decides

1. The **six planes** and which process hosts each.
2. The **process topology**: which OS processes exist, who spawns whom, what survives what.
3. The **eleven top-level components**, their responsibilities, and the one allowed dependency direction between them.
4. The **end-to-end request path** from a keystroke to a settled receipt.
5. The **deployment shapes** the same architecture must serve without forking behaviour.
6. The **failure domains**: what is lost, preserved and refused when each piece dies.
7. The **trust boundaries** the design draws explicitly.
8. The **thirty interfaces (I-01…I-30)** that carry all cross-component traffic, and their versions.
9. The **performance targets** that the shape must not make unreachable.
10. What is **deliberately not** decided here (§12).

### 1.2 Relationship to the rest of the set

| Document | Relationship |
|---|---|
| [`01-vision-and-superset.md`](./01-vision-and-superset.md) | The principles (P1–P10) this shape must make *enforceable*, not aspirational. |
| [`02-decisions.md`](./02-decisions.md) | ADR-001…ADR-016 are binding. Where this document appears to contradict one, the ADR wins and this document is wrong. |
| [`_conventions.md`](./_conventions.md) | Canonical names: `hzcode`, `hzk`, `.hz/`, `~/.config/horizon/`, `hz://`, `@horizoncode/*`, `hz_*`, `HZ_ABI=1`/`HZ_PROTO=1`, plane names, capability IDs, event names, `<Name>V<major>` schemas, status levels. |
| [`04-lld.md`](./04-lld.md) | The same system at module and signature granularity. The HLD is allowed to say "the session engine"; the LLD must name `SessionEngine.admit()`. |

### 1.3 One-paragraph restatement

`hzcode` is one binary that can host any number of front-ends. Whichever front-end starts, it drives a single transport-agnostic `Controller` living in a **session supervisor** process; the supervisor owns the durable event log that is the state of record. The supervisor never mutates the world. Every mutation is submitted across a versioned ABI to **`hzk`**, a separately supervised Rust process that decides (Guard), grants a one-use lease, executes confined by an OS sandbox, observes the outcome, and settles a **receipt**. Children — shells, PTYs, language servers, MCP servers, plugin sandboxes, builds — are spawned by the kernel or the supervisor and are always under a lease, a cgroup and a receipt chain. Nothing crosses from "the model asked" to "the world changed" without a decision record the model cannot write.

---

## 2. Rules

Every rule is numbered, scoped with MUST / SHOULD / MAY, and individually testable. `§` refers to the section of this document that elaborates it; the *Proved by* column names the test family from §10.

| # | Rule | Proved by |
|---|---|---|
| H-1 | Reasoning and authority MUST be separate OS processes: the TypeScript runtime MUST NOT write to the workspace, spawn a child, or open a network socket on behalf of a model request. Every such effect MUST cross the kernel ABI. | `boundary/no-direct-effect` |
| H-2 | Every front-end MUST drive the same `Controller`. Front-end modules MUST NOT contain domain logic (no policy evaluation, no tool execution, no event-log writes). | `ratchet/parity` |
| H-3 | Every durable state change MUST be one appended event. There MUST be exactly one writer per session aggregate at a time; concurrent appends to one aggregate MUST be serialized by the owning writer. | `log/single-writer` |
| H-4 | No mutation may execute without all three of: a `GuardDecisionV1`, a live one-use lease, and an eventual `EffectReceiptV1`. A missing receipt is a defect, not a normal outcome. | `kernel/receipt-completeness` |
| H-5 | The kernel MUST fail closed. If `hzk` is absent, unreachable, older than `HZ_ABI`, or its asset digest does not match the pinned value, the runtime MUST enter **read-only mode** and MUST NOT execute effects. | `kernel/fail-closed` |
| H-6 | Every effect MUST settle into exactly one terminal state from `{SUCCEEDED, FAILED, DENIED, UNKNOWN}`; `UNKNOWN` is terminal until reconciled. | `kernel/settlement` |
| H-7 | An effect in `UNKNOWN` MUST NOT be retried automatically. It MUST be reconciled (`hz.effect.reconciled`) or resolved by a human decision. | `kernel/reconcile` |
| H-8 | `EffectOriginKindV1` MUST be derived from the canonical operation, never accepted from a request body. A `SessionBatch` MUST NOT be able to present itself as `UserAction`. | `kernel/origin-typing` |
| H-9 | One step MUST issue exactly one provider stream call. A step MUST NOT contain a hidden tool loop. | `step/one-stream` |
| H-10 | Prompt admission MUST precede execution: input becomes a durable inbox fact before any provider call, and `steer` vs `queue` MUST be a first-class distinction. | `session/admission-order` |
| H-11 | The busy period MUST acquire a write-ahead claim before the first effect of a turn and MUST hold it until a terminal outcome; an interrupted run MUST be resumable and MUST NOT be ambiguous. | `session/claim` |
| H-12 | Workspace configuration (`.hz/`) MAY only **narrow** user configuration (`~/.config/horizon/`). Merging MUST be a lattice meet, never an overwrite. | `config/lattice` |
| H-13 | The context compiler's prefix MUST be byte-stable for a given `(provider, model, declared config)` tuple. Anything volatile MUST live in the projected tail. | `context/cache-guard` |
| H-14 | Every subagent MUST be constructed through exactly one primitive. A boundary test MUST fail when a new caller appears. | `boundary/subagent-spawn` |
| H-15 | Capability grants MUST be monotone along the parent→child edge: a child's capability set MUST be a subset of its parent's, and budgets MUST be sub-budgets. | `agents/grant-monotone` |
| H-16 | Every tool MUST declare a `ToolDeclarationV1` — including a capability ID from the canonical registry, an effect class, a read-only class, a concurrency class and an observation method. An undeclared tool MUST NOT be registered or reachable. | `tools/declaration` |
| H-17 | The native addon (`hz_native`) MUST NOT link or expose the authority kernel. Runtime code and authority code MUST NOT share a link unit. | `build/link-split` |
| H-18 | Plugin, skill and MCP-served code MUST run under an explicit capability grant in a sandbox host process. Such code MUST NOT reach the kernel ABI directly. | `plugins/containment` |
| H-19 | Every kernel request MUST carry `HZ_PROTO`; requests whose revision the kernel does not declare MUST be rejected with a typed error. | `kernel/proto-negotiation` |
| H-20 | Effects MUST execute confined. When a confinement dimension is unavailable, the kernel MUST emit a typed residual and refuse the effect class that dimension protects; silent degradation is forbidden. | `sandbox/typed-residual` |
| H-21 | No component of the critical path MAY require a network service. With no connectivity, session creation, editing, testing and verification MUST still work. | `offline/critical-path` |
| H-22 | Read-only work MUST complete with the kernel absent; the kernel MUST sit on the mutation path only. A degraded start MUST be visible in the UI and in `hzcode doctor`. | `kernel/optional-reads` |
| H-23 | Secrets MUST NOT be written to the event log or the receipt chain. Logs and receipts MAY carry only opaque secret handles and use-counts. | `secrets/no-leak` |
| H-24 | A tool that cannot state how its effect is observed MUST NOT be granted mutation authority. | `tools/observability` |
| H-25 | Budget MUST be reserved before spend and released on settlement. Spend without a reservation MUST be a defect. | `budget/reserve-release` |
| H-26 | The event log MUST be sufficient to reconstruct every projection without the network and without the kernel. | `log/replay-complete` |
| H-27 | Sequence numbers MUST be monotonic per aggregate and MUST NOT be reused after compaction, fork or rewind. | `log/sequence` |
| H-28 | Capability parity across surfaces MUST be checked in CI: a capability reachable from one front-end MUST be declared for every front-end in the parity manifest. | `ratchet/parity` |
| H-29 | Process supervision MUST be hierarchical: `hzcode` supervises the session supervisor, which supervises its children; `hzk` supervises its own effect children and MUST survive the death of the agent runtime. | `topology/supervision` |
| H-30 | Kernel durability invariants MUST hold while the agent runtime is dead, mid-restart, or being upgraded. | `topology/kernel-independence` |
| H-31 | Authority MUST bind to a workspace identity, not a path string: `workspace_binding(root, device, inode)` MUST be part of the decision digest. A symlink swap or a re-mounted path MUST NOT inherit authority. | `security/workspace-binding` |
| H-32 | Two mutations of one file inside one batch MUST be serialized by the edit engine and MUST NOT be refused as contradictory. (This is inherited work: the ancestor refuses the second edit.) | `edit/same-file-batch` |
| H-33 | Self-improvement MUST NOT widen authority. Learned artifacts MAY change memory, skills, prompts and non-authority routing, and MUST land as reviewable proposals. | `learn/no-widening` |
| H-34 | Every receipt MUST be addressable as `hz://receipt/<id>`; every artifact as `hz://artifact/<sha256>`; every session as `hz://session/<id>`. | `resources/uri` |
| H-35 | The kernel asset MUST be digest-pinned and its manifest verified before it serves any request. A modified kernel is not a degraded kernel; it is no kernel. | `kernel/digest-pin` |
| H-36 | Protocol, ABI and SDK types MUST be generated by `hz_codegen` from one source. A hand-edited generated type MUST fail CI. | `codegen/single-source` |
| H-37 | A document MUST NOT claim a status level above what its evidence supports; capability status MUST be derived from evidence artifacts, not prose. | `docs/status-gate` |
| H-38 | Telemetry MUST be local-first and individually disableable, with no component of the critical path gated on it. | `observe/disableable` |
| H-39 | Warm start of `hzcode` MUST complete in <150 ms to first paint, therefore the session supervisor MUST reuse a live kernel connection when one exists rather than spawning one on the first effect. | `perf/startup` |
| H-40 | A `kill -9` at any point MUST leave a state that `hzcode session reindex` plus log replay reconstructs with no ambiguity about which effects settled. | `crash/reindex` |
| H-41 | Every degraded mode MUST be user-visible and MUST be reported by `hzcode doctor`, in the run receipt, and in the exit code where it changes the meaning of success. | `degrade/visibility` |
| H-42 | Adding a capability MUST NOT add a new process, a new protocol, or a new front-end-specific code path. New capability is new *composition* of admitted effects. | `design/adr-review` |

---

## 3. Architecture

### 3.1 The six planes

The planes are the vocabulary of `_conventions.md` §2. Each plane has exactly one *owner of authority* and a defined process home.

| Plane | Owns | Process home | Authority it holds |
|---|---|---|---|
| **1. Interaction** | Rendering, input collection, surface-specific ergonomics | `hzcode` (TUI/print), `hzcode serve`, web/desktop/IDE clients, MCP-server mode | `ui.present`, `session.manage` (scoped) |
| **2. Orchestration** | Run loop, session lifecycle, steps, claims, budgets, agents, teams, scheduler | session supervisor (`bun`) | none — it *requests* effects |
| **3. Cognition** | Providers, wire codecs, context compilation, memory, retrieval, compaction, prompt assembly | session supervisor (`bun`), `@horizoncode/provider` + `@horizoncode/context` | `providers.infer` (admitted like any effect) |
| **4. Authority** | Admission, policy, leases, confinement, execution, observation, receipts, reconciliation, OwnerLog, managed domain, verifier | `hzk` (Rust), plus effect children it spawns | everything that mutates the world |
| **5. Extensibility** | Plugins, skills, commands, hooks, workflows, MCP/ACP integrations | plugin sandbox host, external MCP/ACP peers, workflow host | only what is granted, via the same Guard path |
| **6. Data** | Event log, projections, blob/artifact store, vector index, snapshot store, OwnerLog | session supervisor (TS side) + `hzk` (authority side) | durable truth |

Two consequences worth stating plainly:

1. **Plane 6 has two owners and no third.** The event log and its projections are owned by the session supervisor; the OwnerLog, the receipt ledger and the artifact store's authority records are owned by `hzk`. No component owns "state" in general, and there is no shared mutable store.
2. **Plane 4 is the only plane that can mutate.** Planes 1–3 and 5 can *ask*. A design that lets plane 2 write a file "quickly, because we already checked" violates P1 and H-1.

### 3.2 Text architecture diagram

```
  PROCESS: hzcode ────────────────────────────────────────────────────────────────
  ┌── PLANE 1 · INTERACTION ──────────────────────────────────────────────────┐
  │  TUI (alt-screen, mouse)   print/headless   server: JSON-RPC/HTTP/SSE/WS  │
  │  web   ·   desktop(Electron)   ·   IDE bridge (ACP)   ·   MCP server      │
  │  SDKs: @horizoncode/sdk, sdk-python, sdk-go, sdk-rust                     │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │  surface protocol  HZ_PROTO=1
                                  │  (commands in, events out — no domain logic)
  PROCESS: session supervisor ────▼───────────────────────────────────────────────
  ┌── PLANE 2 · ORCHESTRATION ─────────────┐ ┌── PLANE 3 · COGNITION ──────────┐
  │ Controller        (one run loop)       │ │ ContextCompiler + cache guard   │
  │ SessionEngine     (admission, claims)  │ │ Provider codecs + models.dev    │
  │ StepEngine        (one stream / step)  │ │ Memory(4 tiers) · retrieval     │
  │ agents/ planner·executor·fleet·teams   │ │ Compaction · prompt assembly    │
  │ tools/ (catalog: 09-tools.md §4)       │ │                                 │
  └──────────────┬─────────────────────────┘ └─────────────────────────────────┘
                 │  PLANE 6 · DATA (TS side)         PLANE 5 · EXTENSIBILITY
                 │  event log (SQLite WAL) + projectors        │
                 │  blob/artifact refs · vector index          │ grant + sandbox host
                 │  snapshot store                             ▼
                 │                                  PROCESS: plugin sandbox host
                 │                                  (isolated; no kernel ABI)
                 │
                 │  HZ_ABI=1 / HZ_PROTO=1 over UDS (Windows: named pipe)
  PROCESS: hzk ──▼───────────────────────────────────────────────────────────────
  ┌── PLANE 4 · AUTHORITY ────────────────────────────────────────────────────┐
  │ Guard.authorize → GuardDecisionV1 → one-use Lease → EffectHost.execute    │
  │ → observe → EffectReceiptV1 (SUCCEEDED·FAILED·DENIED·UNKNOWN)            │
  │ policy(Starlark+wildcards) · reconciliation · OwnerLog(head authority)     │
  │ managed domain (Goal/Run/Task/Attempt/Evidence/Verification) · verifier    │
  │ resource budgets · cgroup v2 accounting · worktree pool · supervisors      │
  │ confinement: hz_sandbox (Landlock·bubblewrap·seccomp·Seatbelt·Win token)   │
  └───────────────────────────────┬───────────────────────────────────────────┘
                                  │  leased, confined, accounted
  PROCESSES: effect children ─────▼──────────────────────────────────────────────
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ shell/PTY · LSP/DAP servers · MCP stdio peers · builds/tests · worktrees   │
  │ each: cgroup v2 scope · rlimits · namespace/sandbox profile · lease ·     │
  │       streamed observation · receipt                                      │
  └───────────────────────────────────────────────────────────────────────────┘

  IN-PROCESS NATIVE PATH (read-only capability, no authority):
  session supervisor ──N-API──▶ hz_native ──▶ hz_walker·hz_index·hz_ast·hz_diff·
                                              hz_vcs·hz_shell(embedded)·hz_pty
  RULE: hz_native MUST NOT link hz_kernel (H-17).
```

### 3.3 Process topology

Seven process *roles*. One OS image may host several of them; the roles are what matters.

| # | Role | Spawned by | Lifetime | Owns | Dies with |
|---|---|---|---|---|---|
| P1 | **`hzcode` CLI / front-end host** | user, CI, IDE, shell | one foreground command | terminal state, argv, surface selection, exit code | user |
| P2 | **Session supervisor** (`bun`, TS) | P1 (or P5 for remote) | one workspace session tree, or one per `--isolate` | Controller, event log writer, projections, tool registry, budget reservations (client side) | P1, crash, idle eviction |
| P3 | **`hzk` kernel** | P1/P2, or reattached if already live | one per host+workspace binding; outlives supervisors | Guard, policy revision, leases, EffectHost, receipts, OwnerLog, managed domain, budgets, cgroups, worktree pool, supervisor leases | machine, explicit `hzcode kernel stop`, digest mismatch |
| P4 | **Effect children** (shell, PTY, LSP/DAP, MCP stdio, build/test) | `hzk` | one effect or one lease | the actual syscalls | kernel or their own exit |
| P5 | **Server process** (`hzcode serve`) | P1 (`serve` command) | until stopped; may host many clients | HTTP/SSE/WS, auth, per-client subscriptions, tunnels | operator, crash (clients reconnect) |
| P6 | **Plugin sandbox host** | P2 (one per plugin generation) | one plugin generation | plugin code, its declared tools/commands | P2, plugin fault, capability revocation |
| P7 | **Remote sandbox / workspace daemon** | operator or `remote.exec` | as configured | a kernel + supervisor pair on another machine | network, operator |

**Supervision tree.** P1 supervises P2. P2 supervises P6 and *connects to* P3 but does not supervise it — the kernel is deliberately outside the agent's control (ADR-003): killing the agent MUST NOT kill the receipt chain, and restarting the agent MUST re-attach to the same kernel instance and the same OwnerLog head. A single-supervisor lease with a monotonically increasing owner epoch prevents two supervisors from claiming one workspace (the ancestor's `supervisor_lease` discipline — `source: /data/home/forge/repo-tour/horizoncode/kernel/src/supervisor_lease.rs`).

**Why the plugin host is a role and not a library.** A plugin that runs inside P2 can patch `@horizoncode/core`, replace a tool implementation, or read the session's credentials. Running it in P6 with a capability grant and no kernel file descriptor makes the plugin's authority a *fact about the system* rather than a promise in a manifest (H-18).

### 3.4 The eleven components

Components are code units with one responsibility and one owner. "May depend on" is a whitelist; anything not listed is forbidden and is enforced by the layering ratchet (§3.5).

| # | Component | Code home | Plane | Responsibility (one sentence) | May depend on |
|---|---|---|---|---|---|
| C1 | **Front-end host** | `@horizoncode/cli` | 1 | Turn argv into a launched surface: parse flags, resolve config, spawn/attach the supervisor and kernel, own the terminal, signals and exit code. | C2, C3, C4, C9, `shared`, `observe` |
| C2 | **Surface clients** | `@horizoncode/tui`, `@horizoncode/ui`, `@horizoncode/web`, `@horizoncode/desktop`, `@horizoncode/acp`, `@horizoncode/mcp` (server mode), `@horizoncode/sdk*` | 1 | Render state and collect input over the protocol; contain **no** domain logic. | C3 (`sdk`/`protocol` only), `ui`, `shared` |
| C3 | **Protocol & transport** | `@horizoncode/protocol`, `@horizoncode/server`, `@horizoncode/kernel-client` | 1/2 boundary | Own the two wire contracts — surface⇄Controller and runtime⇄kernel — plus their codecs, versioning and error mapping. | `shared`, `observe` |
| C4 | **Controller** | `@horizoncode/core` (`controller.ts`) | 2 | Be the single transport-agnostic owner of the run loop: accept submissions, drive steps, publish events, never decide policy. | C5, C6, C7, C8, C9, C3 |
| C5 | **Session engine** | `@horizoncode/core` (`session/`, `event/`) | 2 | Own session lifecycle, the append-only log, projections, admission inbox, write-ahead claims, checkpoints and forking. | C3, `shared`, `observe` |
| C6 | **Step engine & agent runtime** | `@horizoncode/core` (`step/`), `@horizoncode/agents` | 2 | Execute exactly one provider stream per step, apply the resulting tool batch, and construct every child agent through one primitive. | C7, C8, C5, C3, C9 |
| C7 | **Cognition stack** | `@horizoncode/provider`, `@horizoncode/context` | 3 | Turn a session state into one provider request with a byte-stable prefix, and turn the stream back into typed events; own memory, retrieval and compaction. | C3, `shared` |
| C8 | **Tool plane** | `@horizoncode/tools`, `@horizoncode/skills`, `@horizoncode/workflow` | 3/5 | Declare, validate, route and settle tools; the only place tool schemas exist. | C3, C7, `shared` |
| C9 | **Authority kernel** | `hzk` = `crates/hz_kernel`, `hz_abi`, `hz_policy`, `hz_sandbox` | 4 | Decide, lease, confine, execute, observe, receipt and reconcile every effect; own the OwnerLog and the managed domain. | `hz_*` crates only |
| C10 | **Native capability stack** | `crates/hz_native` (addon) over `hz_shell`, `hz_edit`, `hz_diff`, `hz_ast`, `hz_vcs`, `hz_walker`, `hz_index`, `hz_pty`, `hz_voice` | 4/6 | Expose fast, read-mostly native capabilities to TS through **one** addon, with no authority. | `hz_*` crates, never `hz_kernel` (H-17) |
| C11 | **Extensibility, learning & operations** | `@horizoncode/plugin`, `@horizoncode/learn`, `@horizoncode/observe` | 5/6 | Load plugins/skills/workflows under grants; capture trajectories, run evals and emit proposals; emit local telemetry. | C3, C8, `shared` |

**Plane 6 within components.** The Data plane is not a twelfth component; it is a substrate with exactly two owners, and both are already listed: C5 owns the TS-side event log, projections, blob references, vector index and snapshot store; C9 owns the OwnerLog, the receipt ledger and the authority records of the artifact store. This is why "add a cache" or "add a mutable table" is not a component-level change: it either belongs to C5's log family or it does not exist.

### 3.5 Dependency direction

One law (adapted from the Reasonix layering rule, `source: /data/home/forge/repo-tour/DeepSeek-Reasonix/tools/repolint/layers.go`): **a component's directory is its rank, and a component may only import components of strictly lower rank.**

| Rank | Components / packages | Rationale |
|---|---|---|
| 0 | `@horizoncode/shared` | Leaf: ids, errors, schema helpers, result types. |
| 1 | `@horizoncode/protocol`, `@horizoncode/observe` | Contracts and telemetry; nothing above them may be referenced. |
| 2 | `@horizoncode/kernel-client`, `@horizoncode/ui` | The kernel ABI client and pure render primitives. |
| 3 | `@horizoncode/provider`, `@horizoncode/context` | Cognition reads contracts; it does not know about sessions. |
| 4 | `@horizoncode/tools`, `@horizoncode/skills`, `@horizoncode/plugin`, `@horizoncode/workflow`, `@horizoncode/mcp`, `@horizoncode/acp` | Tools and extension surfaces depend on contracts and cognition, never on the run loop. |
| 5 | `@horizoncode/agents` | Agent profiles, planner/executor, fleet: needs tools, providers, context. |
| 6 | `@horizoncode/core` | The Controller and session engine compose everything above. |
| 7 | `@horizoncode/server`, `@horizoncode/sdk` (`-python`, `-go`, `-rust` generated) | Server hosts a core; SDK is the generated client of the surface protocol. |
| 8 | `@horizoncode/tui`, `@horizoncode/web`, `@horizoncode/desktop` | Front-ends are transport clients: they see `sdk` + `protocol` + `ui`, never `core`. |
| 9 | `@horizoncode/cli` | The composition root: the one place allowed to know every component. |
| — | `@horizoncode/testing` | Test-only; may depend on anything under test, and MUST NOT be imported by production code. |

**Rust direction.** `hz_abi` (leaf, generated) ⇠ `hz_policy` ⇠ `hz_sandbox` ⇠ native capability crates ⇠ `hz_native` and `hz_kernel`. `hz_codegen` is a build-time tool. The two load-bearing edges: **`hz_kernel` may use the native crates; `hz_native` MUST NOT use `hz_kernel`** (H-17), and **no crate may depend on `@horizoncode/*`**.

Two dependency facts are worth stating because they are the ones that get violated in practice:

1. `@horizoncode/core` MUST NOT import `@horizoncode/tui`, `@horizoncode/server` or `@horizoncode/sdk`. If the Controller needs to *show* something it emits an event; if it needs to *ask* something it emits `hz.permission.asked`/`hz.agent.message.sent` and waits.
2. `@horizoncode/tools` MUST NOT import `@horizoncode/kernel-client`'s *effect submission* path directly. Tools declare an intent; the runtime submits it. This keeps every mutation on one code path (H-4, H-42) and is the boundary test that keeps it that way.

### 3.6 Deployment shapes

One architecture, four shapes. The shapes differ in *where the processes run* and *which trust boundary is a machine boundary*, never in behaviour (H-2).

| Shape | Processes | Storage | Trust note |
|---|---|---|---|
| **D1 · Single box (default)** | P1 + P2 + P3 on one machine; P4 as needed; P6 lazily | `~/.local/share/horizon/` (log, projections, artifacts), `.hz/` (workspace config), kernel state under `~/.local/state/horizon/hzk/` | Everything is one user's authority. The kernel is still a separate process and still fail-closed. |
| **D2 · Remote sandbox** | P1 local, P7 remote (its own P2 + P3), P4 remote | Log/artifacts on the remote; the local side keeps a mirror of the transcript and receipts (`hz://session/<id>` stays resolvable locally) | File bytes and effects never touch the local host; the local host holds no workspace write authority for the remote tree. |
| **D3 · Server + clients** | P5 (+ P2 + P3 co-located) and N thin clients (TUI, web, desktop, IDE) | Server-side; clients hold no durable state | Client identity is authenticated per device; the server's session has one owner but many observers; every mutation still goes through the server's P3. |
| **D4 · CI / batch** | P1 headless (`run`/`exec`) + P2 + P3, ephemeral | Ephemeral workspace + a JSONL transcript and a receipt bundle emitted as build artifacts | No interactive approver, therefore posture MUST be read-only or pre-granted; an `ask` with no answerer MUST fail closed, not hang. |

Shape rules:

- **D1→D3 is a configuration change, not a rewrite**: the TUI in D3 is the same client that runs in-process in D1 (`@horizoncode/tui` depends on `sdk`, not `core`).
- **A shape MUST NOT change a decision.** The same policy, the same Guard, the same receipts. What changes is *who can answer an `ask`* and *where the bytes live*.
- **D2 requires the mirror rule**: a remote-only receipt chain is not auditable locally, so the mirror MUST carry receipts (they are small) and MAY elide artifact bodies.

---

## 4. Interfaces

The system is carried by ~30 interfaces. Each has one owner, one direction of authority, and one version. `HZ_PROTO=1` and `HZ_ABI=1` are integers bumped on a breaking change; a request carrying an unknown revision is rejected (H-19).

| # | Interface | Direction | Kind | Transport / home | Version | Status |
|---|---|---|---|---|---|---|
| I-01 | **Surface protocol — commands** (`submit`, `cancel`, `approve`, `answer`, `setPosture`, `compact`, `fork`, `rewind`, `attach`, `detach`) | client → Controller | request/response | in-process call (D1) or JSON-RPC over UDS/TCP (D3) | `HZ_PROTO=1` | DESIGNED |
| I-02 | **Event stream** — every `hz.*` event, addressed by `hz://session/<id>` with a monotonic cursor | Controller → clients | append-only subscription, replayable | same as I-01; replay via `log({after})` | `HZ_PROTO=1` | DESIGNED |
| I-03 | **Kernel ABI envelope** — `{revision, requestId, op, body, idempotencyKey}` | runtime → `hzk` | framed RPC | UDS (POSIX) / named pipe (Windows) | `HZ_ABI=1` | DESIGNED |
| I-04 | **`KernelClient.authorize()`** → `GuardDecisionV1` (+ `intent_digest`, `reason_code`) | runtime → `hzk` | request/response | I-03 | `GuardDecisionV1` | DESIGNED |
| I-05 | **`KernelClient.execute()`** → `EffectReceiptV1` | runtime → `hzk` | request + stream | I-03 | `EffectReceiptV1` | DESIGNED |
| I-06 | **Reconciliation RPC** — list `UNKNOWN` effects, resolve or escalate them | runtime ↔ `hzk` | request/response | I-03 | `ReconcileStateV1` | DESIGNED |
| I-07 | **Effect observation stream** — stdout/stderr/deltas/progress, fenced by effect id | `hzk` → runtime | stream | I-03 | `EffectObservationV1` | DESIGNED |
| I-08 | **Lease control** — issue / renew / revoke one-use leases | kernel-internal; projected to clients as receipts | state machine | `hz_kernel::lease` + `hz.effect.lease.issued` | `LeaseV1` | DESIGNED |
| I-09 | **OwnerLog commit / replay** — committed head, segments, seals | `hzk` internal; runtime reads a projection | append-only files + index | kernel state dir | `OwnerRecordV1` | DESIGNED |
| I-10 | **Session append** — one event, one transaction, per-aggregate sequence | Controller → `SessionStore` | append | SQLite WAL | `DurableEventV1` | DESIGNED |
| I-11 | **Projection fold** — pure function `event → read model` | log → projectors | internal | SQLite tables | `ProjectionV1` | DESIGNED |
| I-12 | **`SessionEngine.admit()`** — durable inbox admission (`steer` / `queue`) | surface → session engine | request/response | in-process | `AdmitResultV1` | DESIGNED |
| I-13 | **Claim** — acquire / release the write-ahead claim of a busy period | Controller → session engine | state machine | SQLite + `hz.session.claim.*` | `ClaimV1` | DESIGNED |
| I-14 | **Step boundary** — `StepEngine.runStep()` consumes history, produces one stream | Controller → step engine | call | in-process | `StepRecordV1` | DESIGNED |
| I-15 | **Provider stream** (`llm.stream`) — one call per step, typed deltas | step engine → provider | stream | HTTPS or local socket | `ProviderChunkV1` | DESIGNED |
| I-16 | **Tool declaration** — `ToolDeclarationV1` (schema, capability ID, effect class, concurrency class, observation method) | tools → registry | static registry, build-validated | generated + checked | `ToolDeclarationV1` | DESIGNED |
| I-17 | **Tool dispatch / settlement** — `ToolRegistry.execute()` per call, `ToolRegistry.settle()` per batch | step engine → tool plane | call | in-process | `ToolCallV1` | DESIGNED |
| I-18 | **Context bundle** — `ContextCompiler.compile()` → prefix digest + projected tail | step engine → cognition | call | in-process | `ContextBundleV1` | DESIGNED |
| I-19 | **Policy evaluation** — capability ID + canonical argument map + origin kind + posture revision | `hzk` internal | call | `hz_policy` in-process | `PolicyRequestV1` | DESIGNED |
| I-20 | **Sandbox probe** — capability vector + typed residuals | `hzk` → `hz_sandbox` | call | in-process | `GuaranteeVectorV1` | DESIGNED |
| I-21 | **Managed control** — Goal / Run / Task / Attempt / Evidence / Verification commands | runtime ↔ `hzk` | request/response | I-03 | `ManagedCommandV1` | DESIGNED |
| I-22 | **Budget reservation** — reserve, consume, release, per root run and inherited | runtime ↔ `hzk` | request/response | I-03 | `BudgetReservationV1` | DESIGNED |
| I-23 | **Worktree lease** — acquire / release a worktree for an attempt | runtime ↔ `hzk` | request/response | I-03 | `WorktreeLeaseV1` | DESIGNED |
| I-24 | **Native addon ABI** — the `hz_native` export surface (walk, index, ast, diff, edit, vcs, shell, pty, voice) | runtime → addon | N-API calls | same process | `HZ_ABI=1` | DESIGNED |
| I-25 | **PTY control channel** — spawn, resize, signal, exit status, replay buffer | `hzk` ↔ child | framed duplex | kernel-owned PTY pair | `PtyControlV1` | DESIGNED |
| I-26 | **Plugin host protocol** — tool / command / hook invocation under a capability grant | sandbox host ↔ runtime | framed RPC | P6 stdin/stdout, **no kernel fd** | `HZ_PROTO=1` | DESIGNED |
| I-27 | **MCP client and server** — tools, resources, prompts, OAuth | runtime ↔ external peer | MCP | stdio / HTTP / SSE (out of process) | MCP + our server profile | DESIGNED |
| I-28 | **ACP bridge** — sessions, prompts, permission proxying, replay | editor ↔ runtime | NDJSON JSON-RPC | out of process | ACP v1 | DESIGNED |
| I-29 | **Resource URI resolution** — `hz://session|receipt|artifact|skill|tool/<id>` | any → owning component | lookup | in-process + protocol | `hz://` (conventions §1) | DESIGNED |
| I-30 | **Codegen contract** — one source → `@horizoncode/protocol` + `hz_abi` + SDKs | build → code | generated source | build step | source of truth | DESIGNED |

**Interface rules.**

1. **Every mutation crosses I-03 → I-04 → I-05, in that order.** There is no second path (H-1, H-4, H-42).
2. **Interfaces carry identity, not prose.** Errors carry a dotted code and a structured payload; a decision carries a digest; a receipt carries an observation. Judgements read structure, never wording.
3. **No interface may block indefinitely on a human** except the approval question (I-01 carrying `hz.permission.asked`) and `ask_user`. Both MUST have a timeout and a fail-closed default.
4. **I-01 and I-02 are the only interfaces a front-end may use.** A front-end that speaks I-03 has bypassed the Controller (H-2).

---

## 5. Data

### 5.1 Two durable truths and no third

| Truth | Owner | Medium | Recovery |
|---|---|---|---|
| **Session truth** — what was asked, reasoned, attempted and observed | C5 (`SessionEngine`) | append-only `DurableEventV1` rows in SQLite WAL, one transaction per fact (ADR-004) | replay the log; projections are disposable (`hzcode session reindex`) |
| **Authority truth** — what was permitted, executed, observed and settled | C9 (`hzk`) | OwnerLog: committed-head, segment-sealed, hash-chained records + the receipt ledger (see `source: /data/home/forge/repo-tour/horizoncode/kernel/src/owner_log.rs`) | replay the OwnerLog; the committed head is the sole commit authority |

The two truths join on three ids carried by both: `sessionId`, `effectId`, `receiptId`. `hzcode session verify <id>` joins them and reports whether the work is *proven* or merely *claimed*.

### 5.2 Where artifacts live

| Artifact class | Location | Notes |
|---|---|---|
| Event log + projections | `<workspace>/.hz/state/hzcode.db` (SQLite WAL) — layout owned by `12-sessions-state.md` §4 | One database per workspace; one writer per session aggregate inside it (H-3). |
| JSONL transcript | beside the log | Human- and tool-readable export; never the state of record. |
| Content-addressed blobs / artifacts | `~/.local/share/horizon/artifacts/<sha256>` | Addressed as `hz://artifact/<sha256>`; large tool output, media, evidence bundles (H-34). |
| Snapshots (rewind, revert, worktree pre-state) | `~/.local/share/horizon/snapshots/` | Time travel reads the log; the snapshot restores *bytes*. |
| Vector / lexical index | `~/.local/share/horizon/index/` | Local-first BM25 + embeddings + symbol index; rebuildable, never authoritative. |
| Workspace config | `.hz/` in the workspace | Untrusted: MAY only narrow user config (H-12). |
| User config, credentials, trust decisions | `~/.config/horizon/` | Trust decisions are keyed by path **and** digest. |
| Kernel state (OwnerLog, leases, policy revision, cgroup scopes) | `~/.local/state/horizon/hzk/` | Owned by P3; reachable from P2 only through I-03, never through the filesystem. |

### 5.3 What is deliberately not data of record

- **Tool output buffered in memory.** A tool result exists as an event; if the buffer is lost, the UI re-renders from the log.
- **Model output as evidence.** A claim is a claim; evidence is a receipt or an artifact with a digest.
- **Any mutable "current state" row.** Projections are caches; `hzcode session reindex` MUST rebuild every one of them (H-26).
- **Raw secrets.** Only handles and use-counts are stored (H-23).

---

## 6. Errors & failure modes

### 6.1 Failure domains

For each domain: what is lost, what survives, what the user sees, and what is refused.

| Domain | If it dies | Survives | User-visible effect | Refused behaviour |
|---|---|---|---|---|
| **`hzk` kernel (P3)** | Effects in flight become `UNKNOWN`; their children are reaped by the kernel's cgroup scope on restart | OwnerLog head, receipts, leases (expired), policy revision | Banner: *kernel unavailable — read-only*; `hzcode doctor` names the digest / ABI mismatch | **All mutations.** Reads, search, context, planning and diffing continue (H-22). |
| **Session supervisor (P2)** | The in-flight step aborts; the provider stream closes | Event log, kernel, receipts; effect children stay owned by the kernel | Next start resumes the session; the claim is released or replays as in-flight | New effects until restart; `UNKNOWN` effects are surfaced, never retried (H-7). |
| **`hzcode` CLI (P1)** | Terminal state lost; the supervisor is normally stopped with it | Log, kernel, receipts | `hzcode session resume <id>` continues | Interactive approvals pending at kill time. |
| **Provider** | The step fails with a typed provider error; **no** tool batch is applied | Session, context, receipts | Step-level retry with backoff; an explicit `hz.error.raised`; never a partially applied batch | A failed stream can never half-apply a batch. |
| **Effect child (P4)** — shell, build, LSP, MCP stdio | Settles `FAILED` or `UNKNOWN` depending on whether the exit was observed | The lease, the cgroup scope, the observation prefix already streamed | A failed tool result carrying the observed output and the residual reason | Retry of `UNKNOWN` without reconciliation (H-7). |
| **Plugin sandbox host (P6)** | That plugin generation's tools and commands fail; its grants are revoked | Everything else; other generations are unaffected | The specific tool reports `plugin_unavailable`; the session continues | Plugin-served capability until the host restarts. |
| **Server process (P5)** | Client connections drop | Session log, kernel, receipts; a restarted server re-attaches to the same kernel | Clients reconnect and replay from their cursor (I-02) | Nothing durable: a dropped connection is never a dropped turn. |
| **Confinement backend dimension** | The effect class that dimension protects is refused with a typed residual | Every other dimension still holds | An explicit refusal naming the missing dimension and the protected effect class | Only that effect class (H-20): e.g. no Landlock ⇒ no unconfined `terminal.run`, even in full-access posture. |
| **cgroup v2 delegation absent** | Resource accounting and hard ceilings unavailable | Effects still run, but unaccounted and unnumbered | Startup warning; budgets reported as *unknown*, never as zero | Hard resource-ceiling guarantees; profiles that REQUIRE verified limits (e.g. `codemode.execute`) hard-fail (mirrors `source: /data/home/forge/repo-tour/horizoncode/kernel/src/cgroup_v2.rs`). |
| **Native addon (`hz_native`)** | Native capability returns `native_unavailable`; the runtime MUST NOT emulate it by shelling out | Session, kernel, receipts; the CLI keeps running | Tools report the ABI mismatch by name | Anything that would need an unguarded shell to emulate the native path (H-1). |
| **Storage (volume full / log corrupt)** | Appends fail with a typed storage error; the turn stops at the last durable event | Everything already appended; the kernel still holds its own truth | `storage_full` / `log_corrupt` with recovery steps in `hzcode doctor` | New turns. An intent that cannot be recorded MUST NOT be executed (H-3, H-11). |
| **Event-log / OwnerLog divergence** | `hzcode session verify` reports a gap | Both truths are intact; only the *join* is missing | Verification reports `incomplete` with the missing ids | Claiming completion — the verdict can only be lowered (H-37, P2). |

### 6.2 The degradation ladder

Four named states. There is no fifth "probably fine".

1. **FULL** — kernel attached and digest-verified, confinements probed, budgets accounted, all needed capability IDs available.
2. **DEGRADED-READ-ONLY** — kernel absent / mismatched, or a required confinement dimension missing for the posture's effect classes. Reads, planning, search, diffs and context survive; mutations are refused with a typed reason (H-5, H-22).
3. **DEGRADED-UNACCOUNTED** — effects run but resource accounting is unavailable (no cgroup delegation). Every receipt carries `accounting: unavailable`; budget reporting is explicitly *unknown* (H-41).
4. **REFUSED** — the requested work depends on a guarantee that cannot be made (an unattended `ask` in D4; an unconfined process effect under `deny`). Fails closed with an explicit reason and a non-zero exit code.

### 6.3 Fail-closed matrix

| Condition | FULL | READ-ONLY | UNACCOUNTED | REFUSED (that work only) |
|---|---|---|---|---|
| Kernel absent, ABI mismatch, or digest mismatch | | ● | | |
| Confinement dimension missing for a requested effect class | | | | ● |
| No cgroup v2 delegation | | | ● | |
| Approval required, no answerer within timeout | | | | ● |
| Storage append fails | | ● | | |
| Provider unreachable | step retry, then step failure | | | |
| Native addon missing or older than `HZ_ABI` | | ● (native tools) | | |
| Policy set fails to compile | | | | ● (startup refuses that policy revision) |
| Secret handle unresolvable for a requested capability | | | | ● |

A system in a degraded state MUST answer `hzcode doctor` truthfully and MUST label the run receipt with the state it ran under (H-41).

---

## 7. Flows

### 7.1 End-to-end request path: keystroke → receipt

One user turn, from Enter to a settled receipt chain. Steps, not components.

**Admission**

1. The user presses Enter. The TUI has been rendering from the event stream and holds no session state of its own.
2. The TUI validates *shape only* (non-empty, attachment handles resolve locally) and sends a `submit` command over I-01 with a client-generated `idempotencyKey`. It MUST NOT resolve skills, expand prompts, evaluate policy or call a provider.
3. In D1 the call is in-process (C1 assembled C4); in D3 it is JSON-RPC to P5 which forwards to its C4. Both call the same `Controller.submit()`.
4. `Controller.submit()` normalizes the submission (parts, attachments, `@` references, delivery mode), refuses it if the session is archived or the posture revision is stale, and calls `SessionEngine.admit()`.
5. `SessionEngine.admit()` wakes the session's single writer, checks the `idempotencyKey` against the inbox projection, and appends **one** durable event: `hz.session.prompt.admitted` with `steer` or `queue` (H-10).
6. The append commits together with its projection update in one transaction. A crash before the commit means the prompt never existed; a crash after it means it will be reconciled into the run. There is no third outcome.
7. The Controller takes the busy period: `hz.session.claim.acquired`, `hz.session.busy.entered` (H-11). A second submission cannot start a second run: `steer` input joins the current busy period at the next safe step boundary, `queue` input waits.

**Context**

8. The step engine asks C7 for a context bundle: `ContextCompiler.compile(...)` (I-18).
9. The compiler produces a byte-stable **prefix** (system prompt + sorted tool schemas + declared config for the `(provider, model)` tuple) and a **projected tail** (memory, skills index, goal/plan, retrievals). The prefix digest is recorded on the step (H-13).
10. Memory recall (`memory.read`), repo indexing and skill discovery happen here. Anything that touches the network or the credential store is itself an admitted effect with a receipt.

**The step**

11. `StepEngine.runStep()` opens the step (`hz.step.started`), records the request intent (`hz.step.llm.requested`) with the prefix digest and the budget reservation id, and issues **exactly one** provider stream call (H-9).
12. Provider deltas become `hz.step.llm.delta`; the UI renders them live. Token usage accumulates against the reservation (H-25).
13. The stream completes (`hz.step.llm.completed`) with a typed outcome: text, one or more tool calls, an error, or a truncation. Truncated tool arguments are repaired at the boundary (tolerant decode + JSON repair) and the repair is recorded as a deflection, not hidden.

**Effect admission**

14. The step engine validates each tool call against its `ToolDeclarationV1` (I-16) and builds one ordered **batch**. Unknown tool, schema violation, or a capability absent from the session posture ⇒ a typed tool error; the call never reaches the kernel.
15. For each admitted call the runtime calls `KernelClient.authorize()` (I-04) with: capability ID, canonical argument map, workspace binding digest, posture revision + digest, batch id, and the **origin kind derived from the canonical operation** — never supplied by the request (H-8).
16. Inside `hzk`, `hz_policy` evaluates the effective policy: wildcard rules first, then the Starlark prefix engine for structural command decisions, with precedence `deny > ask > allow`. `Guard.authorize()` returns a `GuardDecisionV1` whose `intent_digest` binds the exact operation and arguments.
17. **`ask`**: the runtime emits `hz.permission.asked` and blocks the batch. An answer arrives as `hz.permission.answered`, is recorded, and — if allowed — re-enters at step 15 as a bounded, workspace-scoped grant that still traverses Guard, lease and receipt. No answerer within the timeout ⇒ REFUSED, never an implicit allow.
18. **`allow`**: the kernel issues **one-use** leases for the batch (per batch, not per call, so an edit set is admitted atomically). The runtime publishes `hz.effect.decision.made` and `hz.effect.lease.issued`.

**Execution**

19. `KernelClient.execute()` (I-05) submits the batch with its lease ids. The kernel re-validates the intent digest against live preimage bytes at plan time, then **normalizes the batch**: multiple mutations of one file become one ordered plan serialized by `hz_edit`, and MUST NOT be refused as contradictory (H-32). The durable intent reaches the OwnerLog before dispatch.
20. The kernel selects the confinement profile for the capability ID and effect class, probes it through `hz_sandbox`, and applies the guarantee vector. A missing dimension yields a typed residual and a refusal for that effect class (H-20).
21. The kernel spawns or performs the effect: a guarded in-kernel write off the workspace root descriptor (including parent-chain creation, which is part of the effect, not a separate step); a `terminal.run` child in a cgroup v2 scope with rlimits and, when requested, a PTY; the egress path with its allow-list for `net.fetch`/`providers.infer`; a supervised language/debug child for `language.*`/`debug.*`; and the confined JS/TS interpreter for `codemode.execute`, whose nested calls return through the ordinary batch path.
22. Observation streams back over I-07 (stdout/stderr, diffs, exit status, resource samples). Selected chunks become `hz.part.updated` events so the user watches the effect happen — the observation is durable, not a spinner.
23. On completion the kernel settles exactly one terminal state — `SUCCEEDED`, `FAILED`, `DENIED` or `UNKNOWN` — and writes `EffectReceiptV1` with capability ID, origin kind, intent digest, policy revision, lease id, workspace binding, observation digest, resource usage and settlement reason. `UNKNOWN` is reserved for effects whose observation could not be closed (kernel death mid-effect, a lost child with no exit status, an ambiguous network write).
24. The runtime records `hz.effect.settled` (or `hz.effect.unknown`) and `hz.step.tool.completed` with the receipt id, and `hz.usage.recorded` for the budget.

**Completion and verification**

25. The batch's results are applied to the log as durable facts. Tool results are events, not memory.
26. If the model requested more tool calls, the next step begins at 8 with a **fresh history reload** — there is no in-memory loop (ADR-011). Otherwise the model has produced a final answer and the turn is a candidate for completion.
27. Model claims (`complete_step`, `update_goal`, a summary asserting that tests passed) are **claims**. The verifier checks each claim against receipts and artifacts: the exact command, the exit status, the test ids that were run, the digest of the bytes written. A claim with no matching receipt is reported as unsupported.
28. The verdict can only be **lowered**. A contradicted claim becomes an explicit failure naming the receipt that contradicts it. Nothing in this path can upgrade a `FAILED` or `UNKNOWN` effect into a success.
29. `hzcode session verify <id>` joins the session log with the OwnerLog and emits the verdict plus the evidence bundle (`hz://artifact/<sha256>`) and the per-effect receipt list (`hz://receipt/<id>`).

**Release**

30. The busy period ends (`hz.session.busy.left`, `hz.session.claim.released`) with a terminal outcome; if the turn was interrupted, the claim is preserved for resume rather than cleared.
31. Budget reservations are released and reconciled; the run receipt records the degradation state (FULL / READ-ONLY / UNACCOUNTED) it ran under (H-41).
32. Telemetry spans close; the trajectory is appended for the learning loop; nothing in the loop may widen authority (H-33).

### 7.2 Secondary flows

**Parallel tool batch.** Calls with `concurrency: parallel` and `read-only` effect class run concurrently inside one batch; writer calls with an overlapping write set are serialized by the edit engine's plan; a batch settles as a unit, so the *step* never observes a half-applied batch. Partial settlement is reported per call, but the set is closed before the next step begins.

**Subagent spawn with narrowing.** The parent calls the one spawn primitive (H-14). It computes the child profile, intersects the capability set (monotone, H-15), splits the budget into a sub-reservation, builds a context capsule, creates a child session with its own aggregate and claim, and links the child to the parent's receipt. `hz.agent.spawned` and `hz.agent.completed` are the only two lifecycle events, and `hzcode session tree` reconstructs authority and cost from them.

**Compaction.** Triggered by the single automatic ratio or an explicit command; it emits `hz.session.compacted` and, when a provider-visible checkpoint is used, a rare explicit checkpoint. The prefix MUST NOT be rewritten by compaction (H-13).

**`UNKNOWN` reconciliation.** On kernel restart the kernel lists unsettled effects, probes reality (does the file digest match the intended postimage? did the child exit? is the remote resource present?), and emits `hz.effect.reconciled` with a resolution of `confirmed`, `reverted` or `requires-human`. Until reconciled, the effect is terminal `UNKNOWN` and the session's verification is `incomplete` (H-7).

**Client attach / detach (D3).** A client supplies its last cursor; the server replays from the log and then follows live. Detach never stops work: the run continues under the same supervisor and claim. Attach does not grant authority — authority comes from the client identity and the session posture, not from who is watching.

**Plugin invocation.** The runtime calls I-26 with a capability grant. The sandbox host enforces the grant locally and returns a result; the *effects* a plugin requests become ordinary submissions from the host process, which the runtime admits through the same Guard path with origin `ManagedRun` (never `UserAction`).

---

## 8. Security & authority

### 8.1 Trust boundaries

Drawn explicitly. Each row: what is on the untrusted side, what the crossing mechanism is, and what MUST NOT cross.

| # | Boundary | Untrusted side | Crossing mechanism | What MUST NOT cross |
|---|---|---|---|---|
| **TB1** | **Model ↔ agent** | Anything a model emits: text, tool arguments, file content it read | Schema validation, tolerant decode, tool declarations, canonical argument maps | Authority. Model output is data; it can never name an origin kind, a capability ID, a policy rule or a workspace binding (H-8). |
| **TB2** | **TS runtime ↔ `hzk`** | The whole agent process, including its dependencies and plugins | I-03 requests, each carrying `HZ_ABI`, workspace binding, posture revision + digest, idempotency key | Trust. The kernel trusts the *request shape*, never the caller's claim about itself; origin kind is derived kernel-side. |
| **TB3** | **`hzk` ↔ OS** | The host OS and everything running on it | Confinement profiles (`hz_sandbox`), cgroup scopes, rlimits, namespaces, a closed file-descriptor set | Ambient authority. A child inherits only its profile's rights, never the kernel's open descriptors. |
| **TB4** | **Workspace files ↔ user config** | A checked-out repository (`.hz/`, hooks, LSP servers, MCP servers, skill files) | Lattice meet: workspace config may only narrow (H-12); named programs stay off until trusted for that folder, keyed by path + digest | Widening. `git clone && hzcode` MUST NOT be able to grant itself anything (ADR-008). |
| **TB5** | **Plugin / skill / MCP-served code ↔ host** | Third-party code and remote servers | Capability grant + sandbox host process (P6) + MCP/ACP protocol peers | Direct kernel access. A plugin has no kernel socket and no session credentials; its effects are submitted for it (H-18). |
| **TB6** | **Effect children ↔ kernel** | Shells, builds, language servers, tests — anything that can be tricked by a hostile repository | Lease-scoped spawn, cgroup scope, profile, streamed observation, exit-status capture | Escalation. A child cannot submit effects, read the OwnerLog, or survive its lease. |
| **TB7** | **Remote clients ↔ session owner** | Browser, phone, IDE, another machine | Device-authenticated transport; per-client scopes; approvals carry identity | Silent authority. Watching is not approving; approving requires an authorized identity. |
| **TB8** | **Remote sandbox ↔ local host** | The remote machine and its network path | Explicit remote binding; receipts mirrored locally; no implicit file sync back | Local write authority from remote results, unless the user re-admits the effect locally. |
| **TB9** | **Untrusted content ↔ renderer** | Model text, terminal escapes from tool output, Mermaid/diagram sources, images, file contents | Escaping and sanitisation at the render boundary; out-of-process rendering for anything executable (e.g. diagram engines) | Terminal escape injection, in-process execution of model-authored diagrams, and any path where rendering implies execution. |
| **TB10** | **Learned artifacts ↔ authority** | Trajectories, distilled memory, synthesised skills, proposed prompt/policy changes | Proposal artifacts reviewed by a human; evals as evidence; no direct application in untrusted workspaces | Any widening of authority: memory, skills, prompts and routing only (H-33, ADR-010). |

### 8.2 Where authority is narrowed

Authority narrows along four axes, and every axis has exactly one enforcement point:

| Axis | Narrowed when | Enforced by |
|---|---|---|
| **Capability** | Posture, workspace config, agent profile, capability grant | `Guard.authorize()` (kernel) — the runtime's opinion is advisory only |
| **Scope** | Workspace binding, write-root list, per-directory trust | Kernel path validation against registered locations (a request path never establishes authority) |
| **Resource** | Budget reservation, cgroup limits, rlimits, depth/concurrency ceilings | Kernel budget arbiter + cgroup v2; runtime ceilings are *requests*, the kernel's are *facts* |
| **Time** | Lease expiry, one-use semantics, approval window (approved-plan execution window) | Lease arbiter: an expired or already-used lease is a `DENIED` receipt, not a retry |

### 8.3 Capability IDs at each boundary

Capability IDs are the vocabulary of authority (`_conventions.md` §5). The mapping from component to capability is: C4/C5 `session.manage`, `context.manage`; C6 `agent.spawn`, `schedule.manage`; C7 `providers.infer`, `models.list`, `memory.read`, `memory.write`; C8 the tool-declared ID per tool (`files.*`, `terminal.*`, `process.spawn`, `net.*`, `language.*`, `debug.*`, `vcs.*`, `mcp.invoke`, `plugins.invoke`, `code.execute`, `codemode.execute`, `repl.eval`, `artifact.write`, `secrets.read`, `remote.exec`, `worktree.manage`, `ui.present`); C9 all of them, as the issuer; C10 `language.symbols`, `language.diagnostics`, `language.rename`, `terminal.pty`, `vcs.read` (native transport is not authority — the capability still decides); C11 `plugins.invoke`, `mcp.invoke`, `memory.*`.

Three rules make this table mean something:

1. **Every capability ID has exactly one effect class**, and an alias never changes the effect class.
2. **A tool MAY declare exactly one capability ID.** A tool that needs two effects is two admitted calls, not one fabricated capability.
3. **The kernel, not the tool, decides the effect class** from the capability ID; a declaration that disagrees with the registry is a build failure (H-16).

---

## 9. Performance budgets

Budgets exist because four of our differentiators are *latency-sensitive*: cache-stability (prefix churn costs money), receipt completeness (every effect pays for a durable write), the one-stream-per-step law (no latency hiding), and a fullscreen TUI (which is judged by feel). Numbers below are p95 unless stated. They are *shape constraints*: an architecture that cannot meet them is the wrong architecture, not a slow implementation.

**Number ownership.** `PB-1`…`PB-15` are this document's ID space and MUST NOT be reused for a different metric by another document. Where a row is a *runtime* latency (kernel round trip, effect admission, event append, receipt settle), `08-runtime.md` §8 owns the single value and its anchor and population; the row here states the shape constraint only and cites that section rather than restating a rival number.

| # | Metric | Target | Measured at | Notes |
|---|---|---|---|---|
| PB-1 | **Warm start** `hzcode` → first painted frame | **< 150 ms** (p50 ≤ 90 ms) | harness timer, TUI first render | Requires an existing kernel connection or a pre-warmed one (H-39). |
| PB-2 | Cold start (no kernel running, first run) | < 900 ms | harness timer | Includes kernel spawn + digest verification + policy compile. |
| PB-3 | **First-token latency overhead** added by HorizonCode | **< 20 ms** | provider request dispatch vs. stream first chunk, minus provider time | Context compilation + event append + ABI round trip, measured on a warm session. |
| PB-4 | **Tool dispatch overhead** (runtime side) | **< 5 ms** | from validated call to submitted effect, excluding kernel time | Includes declaration validation, batch planning and ledger append. |
| PB-5 | Kernel round trip (I-03) | (budget owned by 08 §8) | kernel spans | Warm UDS/named pipe, same host. |
| PB-6 | Effect admission (guard + policy + lease issue) | (budget owned by 08 §8) | kernel spans | Cached policy revision; no disk read on the fast path. |
| PB-7 | Durable event append (commit + projection) | (budget owned by 08 §8) | store spans | One transaction per fact (ADR-004). |
| PB-8 | Receipt write + settle | (budget owned by 08 §8) | kernel spans | Includes the OwnerLog commit for the intent. |
| PB-9 | Keystroke → glyph | < 16 ms p95, < 8 ms p50 | TUI frame log | Fullscreen path; no round trip to the kernel. |
| PB-10 | Session resume (crash → usable) | < 250 ms for a 100k-event session | `hzcode session resume` | Projections may catch up asynchronously. |
| PB-11 | Projection catch-up | ≥ 5,000 events/s | reindex benchmark | `hzcode session reindex` on a full log. |
| PB-12 | Idle RSS, TUI + supervisor | < 180 MB / < 250 MB | process sampler | Kernel budgeted separately (< 80 MB idle). |
| PB-13 | Log overhead vs. raw transcript | ≤ 15% | size comparison | Events are structured facts, not duplicated prose. |
| PB-14 | Confinement probe | < 25 ms, once per posture change | kernel spans | Cached thereafter; never on the per-effect path. |
| PB-15 | CI gates: cache-guard / parity ratchet / layering | < 60 s / < 30 s / < 20 s | CI timings | Fast enough to be blocking, not advisory. |

**How these are kept honest.**

- Every number has a *measurement point* and a harness in `@horizoncode/testing`; a number without one is marketing (mirrors the "a metric is its definition" discipline, `source: /data/home/forge/repo-tour/DeepSeek-Reasonix/docs/DOCS_STANDARD.md`).
- PB-3 and PB-4 are the two budgets that a naive implementation destroys first, because both live inside the user-visible loop.
- **Anti-goal:** we do not budget provider latency, model throughput, or build times. Those belong to the model and the user's machine.
- A perf regression on PB-1…PB-5, PB-9 or PB-15 fails CI; the rest are nightly with alerting.

---

## 10. Tests

Tests fall into four families. The first two are *gates* — they fail the build; the last two are *evidence* for status levels.

### 10.1 Ratchets and gates (CI-blocking)

| Gate | What it proves | Rule |
|---|---|---|
| `ratchet/layering` | Directory rank = import rank; forbidden edges are absent | §3.5 |
| `ratchet/parity` | Every capability is reachable from every declared surface (TUI, print, server, web, desktop, IDE, MCP server, SDK) | H-2, H-28 |
| `ratchet/size` | File and function size ceilings, matching the reference discipline | — |
| `context/cache-guard` | Prefix bytes are identical across runs for a `(provider, model, config)` tuple | H-13 |
| `boundary/subagent-spawn` | Exactly one caller of the spawn primitive; a new caller fails | H-14 |
| `boundary/effect-submission` | Exactly one caller of `KernelClient.execute()`: the effect runtime | H-1, H-4, H-42 |
| `boundary/event-append` | Exactly one writer path appends durable events | H-3 |
| `build/link-split` | `hz_native` does not link `hz_kernel`; front-end packages do not import `core` | H-17, §3.5 |
| `codegen/single-source` | Generated protocol/ABI files are unmodified outputs of `hz_codegen` | H-36 |
| `docs/status-gate` | A documented status level has a matching evidence artifact | H-37 |
| `coverage/sensitive-paths` | Files declared sensitive are covered by a test that proves their property | — |

### 10.2 Invariant tests

| Test | Assertion |
|---|---|
| `kernel/receipt-completeness` | Every admitted effect has exactly one settled receipt; a batch with an unaccounted call fails |
| `kernel/settlement` | Terminal states are exactly `{SUCCEEDED, FAILED, DENIED, UNKNOWN}`; no effect is left non-terminal after reconciliation |
| `kernel/origin-typing` | A request body claiming `UserAction` for a model-originated batch is rejected and recorded |
| `kernel/fail-closed` | Kernel absent / ABI stale / digest mismatch ⇒ read-only mode and a refused mutation with a typed reason |
| `kernel/optional-reads` | Read-only workflows (read, search, diff, plan) complete with no kernel |
| `kernel/workspace-binding` | A replaced symlink or re-mounted path does not inherit authority |
| `session/admission-order` | No provider call exists before the inbox fact for the same input |
| `session/claim` | `kill -9` mid-turn leaves a claim that resumes, not an ambiguous run |
| `log/single-writer` | Concurrent submissions to one session produce one monotonic sequence, no interleaving |
| `log/replay-complete` | Replaying the log reproduces every projection byte-for-byte |
| `edit/same-file-batch` | Two edits to one file in one message both apply, in order (the inherited defect is fixed) |
| `sandbox/typed-residual` | Each missing dimension yields its named residual and refuses only its effect class |
| `budget/reserve-release` | No spend without a reservation; release is idempotent |
| `agents/grant-monotone` | No child capability set is a superset of its parent's |
| `plugins/containment` | A plugin cannot open a kernel connection, read the OwnerLog, or obtain an un-granted capability |
| `secrets/no-leak` | Secrets never appear in the log, receipts, transcripts, telemetry or error text |
| `offline/critical-path` | With networking disabled, session create → edit → test → verify completes |
| `degrade/visibility` | Every degraded state appears in the UI, in `hzcode doctor` and in the run receipt |
| `crash/reindex` | After `kill -9` at N injected points, reindex + replay yields a coherent state and correct verdicts |
| `learn/no-widening` | A proposal cannot change a capability, a policy rule or a grant without human acceptance |
| `resources/uri` | Every receipt, artifact, session, skill and tool resolves through its `hz://` URI |

### 10.3 Measurement tests

A harness in `@horizoncode/testing` measures PB-1…PB-15 on pinned hardware profiles and records them as artifacts so a regression is a diff, not an argument. CI-blocking: PB-1…PB-5, PB-9, PB-15. Nightly: the rest.

### 10.4 Test data and determinism

- **Record/replay** at the provider boundary makes provider tests hermetic (ADR-004 consequence); a recorded stream is a fixture, and the fixture is verified against the schema on load.
- **Fault injection** at three seams: the kernel ABI (drop, delay, duplicate, reorder), storage (fail the append after N events), and the sandbox probe (remove a dimension). Every invariant test above MUST be runnable under injection.
- **Golden OwnerLog fixtures** for codec and replay compatibility, so an OwnerLog written by an older revision still verifies.

---

## 11. Status

> **Implementation status (final audit, 2026-11-06).** The paragraph below was written when this set was design-only. It is superseded where the implementation exists: the built subset (trust kernel, runtime core, base tools, chat TUI, skills, subagents, code mode, preview) carries evidence-backed levels in `docs/28-implementation-status.md`, which is the single source of truth for implementation status. Read the sentence "Nothing in this repository is built" as historical.

Nothing in this repository is built. `/data/home/forge/HorizonCode` contains `README.md` and `docs/` only; therefore every capability below is **`DESIGNED`**, and the *Evidence* column says so. The *Ancestor* column records what the ancestor repository (`sarv-projects/horizoncode`, `source: /data/home/forge/repo-tour/horizoncode/HANDOFF.md`) measured for the corresponding capability, so the reader can see which parts are inherited work in progress and which are new and unproven. Those ancestor statuses are **not** this project's status.

| Capability | Level here | Evidence | Ancestor (measured) |
|---|---|---|---|
| Six-plane split, process topology, component boundaries | `DESIGNED` | §3 of this document | `hzk` exists as a supervised process (`source: /data/home/forge/repo-tour/horizoncode/kernel/src/host_kernel.rs`), status `code_present` |
| Kernel ABI envelope + `KernelClient` | `DESIGNED` | §4 I-03/I-04/I-05 | protocol + framing exist (`kernel/src/protocol_framing.rs`, `kernel/src/rpc_handshake.rs`), status `code_present` |
| Guard, policy, leases, EffectHost, receipts | `DESIGNED` | §7.1 steps 15–24 | `guard.rs`, `effect_host.rs` present; `files.write` parent-chain fix proven 5/5 (`kernel/tests/effect_direct_write.rs`) |
| `UNKNOWN` + reconciliation | `DESIGNED` | §7.2 | modelled kernel-side (`mark_*_unknown`, `reconcile_*`) |
| OwnerLog (committed head, seals) | `DESIGNED` | §5.1 | implemented with golden + recovery tests (`kernel/tests/owner_log_golden.rs`, `owner_log_recovery.rs`) |
| Event log, projections, admission inbox, claims | `DESIGNED` | §7.1 steps 4–7 | inherited from upstream snapshot; not re-verified in the ancestor's measured runs |
| One `llm.stream` per step | `DESIGNED` | §7.1 step 11 | e2e evidence exists (`E2E_V1_LIVE_PROVIDER=PASS … read=completed write=completed bash=completed`) |
| Origin-typed effects | `DESIGNED` | §8.1 TB1/TB2 | implemented in the ancestor's canonical operation set |
| Sandbox matrix with typed residuals | `DESIGNED` | §6.1, `sandbox/typed-residual` | Linux containment matrix `9/9` under a delegated cgroup |
| Native addon `hz_native` (single addon, no kernel link) | `DESIGNED` | C10, `build/link-split` | not present in the ancestor (it uses per-capability bindings) |
| Eleven components + layering law | `DESIGNED` | §3.4, §3.5 | ancestor does not enforce layering |
| One Controller across eight surfaces + parity ratchet | `DESIGNED` | H-2, H-28 | ancestor has one embedded surface; ratchet is new |
| Cache-first context compiler + cache-guard | `DESIGNED` | H-13, `context/cache-guard` | partial upstream behaviour; guard is new |
| Planner/executor split with deterministic routing | `DESIGNED` | §7.2 | not present |
| Subagent fleet with capability grants, one spawn primitive | `DESIGNED` | H-14, H-15 | **closed in the ancestor** (`DIRECT_CHILD_TURN_RPC_ENABLED = false`) |
| Budgets, leases, resource accounting, cgroup v2 | `DESIGNED` | H-25, I-22 | `resource_budget.rs`, `cgroup_v2.rs` present |
| Worktree pool | `DESIGNED` | I-23 | present as a process-local lease model |
| Plugin sandbox host + capability grants | `DESIGNED` | H-18, TB5 | not present |
| Verification / evidence gate with claim lowering | `DESIGNED` | §7.1 steps 27–29 | **designed but not wired** into the direct session lane |
| Time-travel replay, fork, rewind | `DESIGNED` | §7.2 | checkpoints exist (`kernel/src/checkpoint.rs`) |
| Four-tier memory, retrieval, compaction | `DESIGNED` | C7 | upstream memory only |
| Learning loop (trajectories, evals, proposals) | `DESIGNED` | H-33, TB10 | not present |
| Same-file multi-edit in one batch | `DESIGNED` | H-32 | **known defect**: refused with `stale_preimage` |
| LSP / DAP surfaces | `DESIGNED` | C10, §4 I-07 | **closed** in the ancestor (`languageServiceProcessRouteAvailable() === false`) |
| Headless `run` with mutation authority | `DESIGNED` | D4 | **broken** in the ancestor (no authenticated principal ⇒ effects fail closed) |

An `UNKNOWN` in this table is written as `UNKNOWN`, never as an implied success. No row above may be promoted without an artifact that a reviewer can open.

---

## 12. What is deliberately NOT in the high-level design

Listed so that a reader cannot mistake absence for oversight. Each item belongs to a lower-level or topical document; the HLD fixes only the *shape* that constrains it.

1. **Schemas.** No field-level definition of `GuardDecisionV1`, `EffectReceiptV1`, `DurableEventV1`, `ToolDeclarationV1` or any other `V<n>` type. Field lists live in the schema documents; this document names only the semantics each type must carry.
2. **Function bodies and signatures.** `Controller.submit()`, `SessionEngine.admit()`, `StepEngine.runStep()`, `ToolRegistry.settle()`, `ContextCompiler.compile()` and `ParityRatchet.check()` are named here because the *shape* depends on them; their exact signatures live in `04-lld.md`.
3. **The protocol method list.** I-01/I-02 are described by kind, not by method name. Transport selection, framing, pagination, backpressure and error envelopes are the protocol document's problem.
4. **The event catalogue.** Only the canonical event names from `_conventions.md` §6 are used. Payload shape, ordering guarantees per aggregate and projection columns are not decided here.
5. **Policy grammar.** Wildcard syntax and the Starlark prefix engine's rule set are described only to the extent that precedence (`deny > ask > allow`) and the single enforcement point are fixed.
6. **Sandbox profile contents.** Seatbelt `.sbpl` text, Landlock ruleset construction, seccomp filters, Windows AppContainer tokens, and per-OS default dimension sets. The HLD fixes only that guarantees are *probed*, *declared* as a vector, and *residual-typed*.
7. **Tool catalogue and semantics.** The tools catalogued in `09-tools.md` §4 are referenced here only by family; their schemas, renderers, idempotency contracts and UI behaviour are that document's problem.
8. **Provider codecs and the model catalogue.** One stream per step, typed deltas, config-not-code endpoints — no wire format, no model table, no auth flow.
9. **TUI layout, theme, keybindings, accessibility.** Only two HLD-level constraints exist: the TUI is a protocol client (H-2), and untrusted content is sanitised at the render boundary (TB9).
10. **Memory algorithms.** Four tiers, provenance and distillation are named; embedding choice, ranking, consolidation policy and storage layout are not decided.
11. **The learning loop's internals.** Trajectory format, eval harness, benchmark suites, proposal format and review UI are out of scope; only the no-widening rule (H-33) binds here.
12. **Deployment tooling.** Installers, update channels, digest pinning mechanics, packaging formats, service units and container images. D1–D4 describe where processes run, not how they are produced.
13. **Observability schema.** OTel semconv mapping, span names, metric definitions and the local dashboard.
14. **Numbers that belong to measurements, not design.** Item latencies for providers, model quality, benchmark scores, cost per task.
15. **Migration and compatibility.** Upstream pinning mechanics, event-version upgrades, projection rebuild-on-upgrade.
16. **Anything about hosts we do not support.** Windows privilege model specifics, WSL detection heuristics, macOS Seatbelt variants beyond the dimension contract.

If a decision in this document cannot be implemented without deciding an item above, that item's document MUST be written first — the HLD is not allowed to smuggle in a schema by defining behaviour that only one schema could satisfy.

---

*End of `03-hld.md`.*


