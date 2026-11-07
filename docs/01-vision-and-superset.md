# 01 — Vision & Competitive Synthesis

> What we learned from grilling eight codebases, and the superset we are building from it.

---

## 1. Vision

**HorizonCode exists to make autonomous software work trustworthy at the level of the individual effect.**

Every coding agent today is a persuasion machine: it asks a model to act, performs what the model asked for, and then *tells you* it went well. The evidence is a paragraph of prose produced by the same model that did the work. That is fine for a demo and unacceptable for a repository, a production system, or a team.

HorizonCode changes the unit of trust from *the transcript* to *the receipt*:

- Reasoning is cheap and non-authoritative. It proposes.
- Execution is expensive and authoritative. It is admitted, leased, confined, observed and receipted by a kernel the model cannot reprogram.
- The result of a run is a **verdict backed by host-observed evidence**, not a claim.

On top of that constitution we place the **best available agent engineering** — merged, not re-invented — so HorizonCode is at least as capable as the strongest agent in each dimension, and strictly more capable in the dimensions that matter for long, unattended work: authority, durability, evidence, orchestration, memory and self-improvement.

### 1.1 Product principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **The model proposes; the kernel disposes** | No tool effect bypasses Guard; there is no "fast path" that skips a receipt. |
| P2 | **Evidence over assertion** | `verify` can lower a claim, never raise it. |
| P3 | **Local-first, BYO keys** | The agent runs on your machine; the model is a configured service. |
| P4 | **One Controller, many faces** | Capability is added once and inherited by every front-end. |
| P5 | **Cache is a contract** | Prompt prefix stability is tested in CI, not hoped for. |
| P6 | **Fail closed, degrade loudly** | Unknown sandbox dimension ⇒ typed residual ⇒ explicit refusal, never silent degradation. |
| P7 | **Boring where it counts** | Storage, events and protocol are simple, append-only and replayable. |
| P8 | **Self-improvement never widens authority** | Learning changes memory, skills, prompts and routing — never policy. |
| P9 | **Small crates, clean layers** | Dependency direction is linted; the compiler enforces the architecture. |
| P10 | **Observable by default** | Every run, step, tool call and effect is traced locally. |

### 1.2 What "superset" means concretely

Superset is a claim we make testable:

1. **Capability parity matrix** — for each reference agent, every user-visible capability is enumerated and mapped to a HorizonCode feature (inherited or superseded). The matrix lives in [`24-feature-catalog.md`](./24-feature-catalog.md) and is enforced by the parity ratchet.
2. **No exclusivity regressions** — a PR that removes a mapped capability fails CI.
3. **Strict additions are listed** — every strictly-new capability is listed with its design (see §4 below and the feature catalog).

---

## 2. The eight references, and what each one actually is

> **Second wave (2026-11-07).** Six further sources (SWE-agent, OpenHands, wshobson/agents, aider, mini-swe-agent, hermes-agent) are recorded in [`24-feature-catalog.md`](./24-feature-catalog.md) §4.1 A.9; the eight below remain the primary set this document reasons about.

### 2.1 `sarv-projects/horizoncode` — the execution constitution (our direct ancestor)

**What it is.** A TypeScript/Bun coding agent derived from a pinned OpenCode snapshot, plus three Rust crates that no other agent has: `kernel/` (the execution authority), `indexd/` (lexical repo index) and `horizoncode-sandbox/` (OS confinement).

**What it contributes (all of it is inherited):**

- **Guard** — `authorize()` produces a `GuardDecisionV1` (`Ask`/`Deny`) with a `reason_code`; the decision binds an intent digest.
- **Origin-typed effects** — `EffectOriginKindV1 ∈ {SessionBatch, UserAction, ManagedRun, ManagedRoot}`, fixed by the canonical operation and *never* supplied by a request body. A model batch cannot impersonate a human action.
- **One-use leases + EffectHost + receipts** — resolve → Guard → durable prepare → one-use lease → execute → observe → receipt.
- **`UNKNOWN` as a first-class terminal state** — never blindly retried; reconciled.
- **Capability-ID registry** — stable IDs (`files.write`, `files.patch`, `terminal.run`, `codemode.execute`, `providers.infer`, `language.*`, `debug.*`, `repl.*`) where aliases never change effect class.
- **Postures as data** — `DirectSessionPermissionModeProjectionV1 { sandboxMode, approvalPolicy, source, revision, digest }`.
- **DirectSessionGrant** — bounded, workspace-scoped pre-authorisation that still traverses Guard/lease/receipt.
- **Managed domain** — `Goal / SpecVersion / Run / Task / Attempt / WorkerExecution / Evidence / Verification`, OwnerLog, task DAG, verifier, worktree pool, resource budget, cgroup v2.
- **Sandbox with typed residuals** — `Sandbox::probe()` fail-closed; bubblewrap + Landlock backends; per-dimension guarantee vectors.
- **Documentation-as-authority** — numbered topic-owner docs, machine contracts (`contracts-v2/*.schema.json`), status levels `DESIGNED / CODE_PRESENT / WIRED / TESTED / VERIFIED / RELEASED`.
- **CodeMode as a composing interpreter** — nested calls go back through the ordinary tool batch; it is *not* a new executor.

**What it lacks (we add):** maturity of the upstream loop under load; a full-screen mouse TUI; planner/executor coordination; deep multi-agent; self-improvement; web/desktop collaboration; cross-platform sandbox coverage; provider breadth beyond upstream.

**Honest caveats we inherit as work items.** Its own `HANDOFF.md` records that the independent-evidence gate is designed but not yet wired into the direct session lane, subagent delegation is behind a flag, and two edits to one file in one message are refused. HorizonCode-already-existing must finish these; HorizonCode-the-new-agent must not pretend they are done.

### 2.2 `anomalyco/opencode` — the event-sourced core and Code Mode

**What it contributes:**

- **Effect-based, event-sourced core** — facts are durable events; projectors fold them; one SQLite transaction commits event + projections.
- **Admission before execution** — `Session.prompt` admits to a durable inbox (`session.inbox.enqueued`) *before* any work; `execution.wake` then drives it. Steer vs queue is a first-class distinction.
- **Write-ahead execution claim** — a busy period claims first and clears only on a terminal outcome; crash ⇒ resumable, not ambiguous.
- **One `llm.stream` per step** — `runStep` reloads history and issues exactly one stream call; there is no in-memory tool loop.
- **Code Mode** — confined execution over a namespaced tool tree.
- **Contract-separated monorepo** — `schema → {core, protocol} → server`, with `client` forbidden from depending on core/server and only `sdk` composing all three; ~40 packages; lockstep versioning.
- **`models.dev` snapshot** + native wire codecs (~50) across a huge provider list.
- **v2 branch** (older, monolithic) is the ancestor with a full in-package LSP/IDE client; useful as a design reference for LSP wiring.

### 2.3 `openai/codex` — sandbox depth, policy-as-code, three surfaces

**What it contributes:**

- **Per-OS sandbox stack with unusual depth** — Seatbelt `.sbpl` profiles on macOS; Landlock + seccomp + bubblewrap on Linux; Windows AppContainer/WFP with a service component; `network-proxy` crate for egress.
- **Starlark `execpolicy`** — command decisions are evaluated by a small prefix engine, not by regex hope.
- **Code-generated, schema-exported JSON-RPC** shared by CLI, app-server and SDKs.
- **app-server daemon** with remote control and tunnels — the IDE surface is a protocol client, not a special case.
- **Rollout + rollout-trace** — durable turn records and replay.
- **Massive crate discipline** — ~130 crates, ~40 of them small focused utils; `bazel` + `cargo`; `justfile` for tasks.
- **Extensions (`ext/*`)** including a safety-review "guardian".

### 2.4 `xai-org/grok-build` — the TUI as the product

**What it contributes:**

- **Alternate-screen fullscreen TUI with deep mouse support** — click-to-focus, scrollbars, drag-select, and capture re-assertion after ConPTY relays. This is the best terminal interaction model in the set and we adopt it wholesale.
- **Scrollback-native "minimal" mode**, switchable by process relaunch — the right answer for pipes, logs and screen-readers.
- **Leader process + client-side ACP replay** — an IDE session survives a leader crash and is reconstructed.
- **In-process OS sandbox applied at startup** (`nono`) plus per-child seccomp.
- **Computer Hub / workspace server** — remote sandboxes as a first-class concept.
- **Rhai workflow engine** — declarative orchestration with a host channel.
- **Scheduler with an occurrence journal** — recurring automations that survive restarts.
- **"Dream" memory consolidation** and a memory tool family.
- **Voice dictation** (streaming STT), out-of-process **Mermaid** rendering (untrusted model output never runs in-process), signed **managed policy**, Claude-settings import, `grok wrap/du/doctor` ergonomics, and an in-tree port of both codex and opencode tool sets with Apache §4(b) notices.

### 2.5 `esengine/DeepSeek-Reasonix` — one controller, cache discipline, ratchets

**What it contributes:**

- **One `Controller` behind four front-ends** (CLI/TUI, HTTP/SSE server, Electron Studio, ACP) with a **frontend-parity ratchet** — a bespoke linter that fails when a capability reaches one front-end but not another.
- **The layering law** — a package's directory *is* its dependency rank (`base 0 · contract 1 · safety 2 = state 2 · model 3 · platform 4 · ext 5 = tools 5 · runtime 6 · session 7 · assembly 8 · frontend 9`), enforced by `tools/repolint`.
- **Cache-first architecture as a product guarantee** with a live CI cache-guard — the prefix must stay byte-stable or the build fails.
- **Two-model coordination without shared sessions** — planner and executor prefixes never mix.
- **"Judgements read structure, never wording"** — shell ASTs, types, contracts instead of string matching.
- **Repolint ratchet** — layering, file/function size, wire-parity, doc-owner checks; debt may only decrease.
- **Sensitive-path coverage gate** — a file classified sensitive must be covered by a test that proves it.
- **Content-addressed hash-chained Trusted Host State** — the evidence substrate.
- **Extension Protocol v2** with a Go SDK and an `extension-protocol-gen` generator; skills, commands, hooks, themes, market.
- **Single static `CGO_ENABLED=0` binary**; Android `libreasonix.so`; desktop as a **nested module** so its CGO needs cannot contaminate the CLI's static-binary guarantee.
- **Append-only vendor price table + `pricecheck`**; metric-definition discipline.

### 2.6 `can1357/oh-my-pi` — native capability stack and bidirectional ACP

**What it contributes:**

- **ACP in both directions** — `omp` acts as an ACP agent *and* drives Cursor through a `cursor-agent` provider with external-tool handoff.
- **Deep LSP (14 ops) and DAP (28 ops)** — the most complete language/debug surface in the set.
- **~80k lines of Rust natives in one N-API addon**: embedded **bash 5.3** with an injectable VFS, AST (`pi-ast`), diff (`pi-diff`), edit engine (`pi-edit`), sandbox overlay (`pi-iso`), VCS with gitoxide + Jujutsu (`pi-vcs`), virtual filesystem (`pi-vfs`), voice, walker, predictor.
- **Compiled-once native capability stack** — TS calls into a single addon with typed wrappers.
- **Autolearn capture agent**, **prewalk** (model downgrade at first edit), **credential-affinity prompt-cache pinning + OAuth account pools**, **snapcompact** bitmap-frame context compression, **IRC-based multi-agent**, a rich `omp://` / `agent://` / `skill://` / `xd://` URL space, whole-session-tree cost gate, jsdiff-compatible diffs, streaming edit previews.

### 2.7 `tailcallhq/forgecode` — clean architecture and compile-time tool specs

**What it contributes:**

- **A textbook clean-architecture crate stack** — `domain → config/fs/walker/template → app (use-cases + traits) → services (impl) → repo (persistence + providers) → api (facade) → main`, with `AGENTS.md` forbidding service-to-service dependencies, a single generic infra parameter, `Arc<T>` and tuple-struct services.
- **Compile-time tool descriptions** — `forge_tool_macros::ToolDescription` + `#[tool_description_file]` read descriptions at build time.
- **Handlebars prompt templating** with typed contexts and 12 embedded partials via `include_dir!`.
- **Tolerant decoding** (`eserde`) and **`forge_json_repair`** for streamed/truncated tool arguments — a genuinely underrated reliability feature.
- **A remote semantic-search index over gRPC** for cross-repo symbol/semantic queries.
- **The zsh `:`-prefixed shell plugin** — the agent as a shell citizen.
- **Three named agents** (`forge` act, `sage` research, `muse` plan) as a first-class product concept.
- **Single-purpose rendering crates** (`forge_display`, `forge_markdown_stream`, `forge_spinner`, `forge_select`).

### 2.8 `codeaashu/claude-code` — the tool surface, skills, coordinator and bridge

**What it contributes:**

- **A ~40-tool catalog** with the cleanest tool contract in the set: input schema (Zod), permission model, execution logic and UI components per tool, registered centrally and discovered by the query engine.
- **Permission modes** — `default`, `plan`, `bypassPermissions`, `auto` (classifier), with **wildcard rule patterns** (`Bash(git *)`, `FileEdit(/src/*)`, `FileRead(*)`) and a centralized `checkPermissions(input, context)` chokepoint.
- **Three command types** — `PromptCommand`, `LocalCommand`, `LocalJSXCommand` — i.e. commands can be prompts, plain text or rich JSX.
- **Skills** — 16 bundled (`batch`, `debug`, `loop`, `remember`, `simplify`, `skillify`, `stuck`, `verify`, `updateConfig`, `scheduleRemoteAgents`, …) plus user skills and MCP-derived skills.
- **Task system** — `LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `InProcessTeammateTask`, `DreamTask`, `LocalMainSessionTask`, with create/update/get/list/output/stop tools.
- **Coordinator (multi-agent)** — teams, `SendMessageTool`, sub-agents.
- **Memory hierarchy** — project `CLAUDE.md`, user `~/.claude/CLAUDE.md`, extracted memories, team memory sync.
- **IDE bridge** — JWT-authenticated bidirectional bridge with permission proxying, session management, attachments, trusted-device verification and workspace secrets.
- **MCP both ways** plus `ToolSearchTool` for deferred tool discovery.
- **Service layer** — compact, policy limits, remote managed settings, token estimation, agent summary, prompt suggestion, session memory, magic docs, auto-dream, x402 payments, tips.
- **React/Ink UI with ~140 components, ~80 hooks and screens** — proof that a terminal UI can be a real application.

---

## 3. Cross-cutting synthesis

### 3.1 What everyone agrees on (the mandatory substrate)

These are table stakes; HorizonCode must have every one of them and they are *not* differentiators:

1. Multi-provider streaming LLM client with tool calling.
2. Core tool set: read / write / edit / shell / glob / grep / todo / task / websearch / webfetch / ask.
3. A TUI plus a non-interactive mode.
4. MCP client with OAuth.
5. Session persistence, resume, context compaction.
6. Subagents, skills, custom commands, plugins/hooks.
7. Permission/approval modes.
8. Sandboxing (bubblewrap / Seatbelt / Landlock).
9. Auth/OAuth + credential storage.
10. A config file.
11. LSP integration.
12. ACP or an equivalent editor protocol.
13. Telemetry and `AGENTS.md`-style project instructions.
14. A web/desktop surface.

### 3.2 Where they differ (our engineering opportunities)

| Dimension | Weakest in set | Strongest in set | HorizonCode's position |
|---|---|---|---|
| **Execution authority** | prompt-based permissions | HorizonCode's Guard/lease/receipt | **Kernel-enforced, universal receipts** |
| **Durability under crash** | in-memory loops | OpenCode write-ahead claim | **Claims + event sourcing + replay** |
| **Prompt-cache discipline** | ad hoc | Reasonix cache-guard | **Prefix contract tested in CI** |
| **Sandbox depth** | bwrap-only | Codex (3 OSes + policy engine) | **Full matrix + typed residuals** |
| **Front-end parity** | per-surface drift | Reasonix ratchet | **Ratchet across 8 surfaces** |
| **Terminal UX** | line TUI | grok fullscreen + mouse | **Fullscreen + inline fallback** |
| **Native performance** | pure TS | oh-my-pi Rust | **Native crate set, one addon** |
| **Multi-agent** | single task tool | Claude coordinator + teams | **Fleet + teams + message bus** |
| **Memory** | none | Claude hierarchy + team sync | **Four tiers + distillation** |
| **Self-improvement** | none | (dream/autolearn fragments) | **Full, human-gated loop** |
| **Evidence/verification** | prose claims | HorizonCode design | **Evidence gate wired end-to-end** |

### 3.3 Structural lessons we adopt

1. **Derivative hygiene.** HorizonCode is an overlay on a pinned upstream; grok-build ports tools in-tree with §4(b) notices; oh-my-pi is a fork of Pi. Derivative work is normal — **attribution and a pinned upstream are mandatory**, and overlay status is auditable.
2. **Docs as authority.** There is a real failure mode where prose describes protections that code does not enforce. We copy the *status-level* discipline (`DESIGNED → RELEASED`) and add a machine check that a doc cannot claim a level it cannot prove.
3. **Ratchets beat reviews.** Layering, file size, front-end parity, sensitive-path coverage and cache stability are all lint-enforced in the strongest reference. We make all five first-class CI gates.
4. **Compile-time beats runtime for specs.** ForgeCode's tool-description macros and codex's generated protocol show that the best contracts are generated, not hand-maintained.
5. **Confined composition beats new executors.** CodeMode composes already-authorised tools. "New capability" should mean *new composition*, not *new authority*.
6. **One primitive, one boundary test.** Reasonix's insight: if a concept can be constructed from many places, add a boundary test that fails on new callers. We use it for subagent construction, effect submission, and event append.

---

## 4. The ten things HorizonCode does that none of them do

### 4.1 Execution constitution (universal receipts)
Every mutation — file write, shell run, network fetch, provider call, plugin effect — settles into a **receipt** with an intent digest, capability ID, origin kind, lease ID, observation and terminal state. There is no "small" effect that skips the ledger. *Pain point solved:* "the agent said it ran the tests."

### 4.2 Evidence gate with claim lowering
A `verify` step checks model claims against host observations and can only **lower** confidence. Contradicted claims become explicit failures with the receipt that contradicts them. *Pain point solved:* confident summaries of work that was never done.

### 4.3 Policy that composes safely
Wildcard rules (Claude Code ergonomics) *plus* a Starlark prefix engine (Codex semantics) *plus* origin typing (HorizonCode) *plus* the rule that **workspace config may only narrow user config**. *Pain point solved:* a checked-out repo silently widening permissions.

### 4.4 Deterministic Planner/Executor routing
Routing is decided by explicit host policy, not a classifier's guess, and planner/executor prefixes are never mixed. Cheap exploration is real, and cache stability survives it. *Pain point solved:* unpredictable model switching mid-task.

### 4.5 Cache-first context compiler with a contract test
The context compiler emits a byte-stable prefix and a projected tail; CI fails if the prefix drifts. *Pain point solved:* paying full price on every turn because something reordered the prompt.

### 4.6 One Controller across eight surfaces with a parity ratchet
TUI, print, server, web, desktop, IDE bridge, MCP server and SDKs all drive the same Controller; a linter fails the build when one surface lags. *Pain point solved:* the web UI becoming a second-class citizen.

### 4.7 Subagent fleets with capability grants
Children inherit a **narrowed** capability set and a budget, communicate over a durable message bus, and are constructed through one primitive. *Pain point solved:* subagents accumulating authority and cost invisibly.

### 4.8 Four-tier memory with distillation and provenance
Working, episodic, semantic and team memory, each with provenance; distillation promotes episodic observations to semantic facts only with review. *Pain point solved:* the agent relearning your codebase every session.

### 4.9 Time-travel replay of a session
Because the log is the state of record, any session can be replayed step by step: prompt, stream events, tool calls, guard decisions, receipts. *Pain point solved:* "why did it do that?"

### 4.10 A real self-improvement loop, gated
The agent captures trajectories, runs evals, distills memory, synthesises skills, and proposes prompt/policy improvements — all as reviewable proposals. It never widens its own authority. *Pain point solved:* agents that never get better at *your* codebase.

---

## 5. Explicit non-claims

- We do not claim the reference agents are bad. Several are excellent, and HorizonCode deliberately inherits their best ideas rather than inventing replacements.
- We do not claim HorizonCode will be better at *every* task on day one. The claim is architectural: a superset capability set, plus trust, durability and learning properties the others do not enforce.
- We do not claim the design here is proven. It is a specification, with status levels, and the roadmap in [`25-roadmap.md`](./25-roadmap.md) says what must be built and proven.
