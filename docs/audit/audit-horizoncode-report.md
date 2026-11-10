# Deep Audit — HorizonCode (`sarv-projects/horizoncode`)

Reference clone: the ancestor project (not cloned, path not verified)
Audit date: 2026-11-06
Mode: **report-only** - nothing in the repo was modified; `HorizonCode` was not touched.

> All paths below are relative to the repo root the ancestor project (not cloned, path not verified) unless stated otherwise.

---

## 0. What this repo is + coverage stats

### 0.1 Identity

HorizonCode is a **terminal coding agent** implemented as a **TypeScript/Bun agent runtime + Rust execution kernel** hybrid. It is a hard fork of **OpenCode** (pinned upstream snapshot, referenced in `arch_V1/19-OPENCODE-UPSTREAM-REUSE.md` and `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`; internal packages still carry `@opencode-ai/*` names in places, and `packages/horizoncode/bin/opencode` still exists).

The root `README.md` states the thesis explicitly:

> "Most coding agents put the model in charge of deciding what tools to call. HorizonCode separates the agent's reasoning from the authority to perform mutations."

> "A TypeScript/Bun runtime handles the agent loop and terminal interface. A Rust kernel controls execution admission, permissions, leases, effects and receipts."

Package `packages/horizoncode/package.json` is `"name": "horizoncode"`, version `1.18.35`, bins `horizoncode` and `hzcode`. Workspace root is `horizoncode-workspace`.

**Git state:** a single squashed commit — `da1f9c2 Fix-overlay-audit-snapshot-hydration` on `main`, remote `origin https://github.com/sarv-projects/horizoncode.git`. There is **no recoverable development history** from `git log`; the project's history lives in `HANDOFF.md` (a 942 KB append-only journal) and `reports/phases/LEDGER.md`.

### 0.2 Coverage stats

| Metric | Value |
|---|---|
| Files (excluding `.git`) | 7,675 |
| TypeScript `.ts` | 3,154 |
| `.tsx` | 648 |
| Rust `.rs` | 111 |
| Markdown `.md` | 362 |
| `.mdx` | 627 |
| `.svg` | 1,254 |
| `.json` | 488 |
| `.sql` | 96 |
| `.py` | 63 |
| Rust LOC under `kernel/` | ~169,500 |
| Files under `packages/` | 6,828 (89 % of repo) |

Top-level directories:

| Path | Files | Role |
|---|---|---|
| `packages/` | 6,828 | TS/Bun monorepo, 34 workspaces |
| `kernel/` | 99 | Rust execution kernel (Guard, EffectHost, OwnerLog, worker/worktree pool, terminal) |
| `arch_V1/` | 142 | Normative V1 architecture (`01`–`46` numbered docs + `contracts-v2/` + audit JSON) |
| `scripts/` | 100 | bootstrap, architecture gates, e2e, perf, eval, release, verify |
| `reports/` | 99 | harness run reports, phase ledger, acceptance verdicts, research |
| `docs/` | 92 | doc map, superpowers plans/specs, archives, performance runbook, reliability |
| `bench/` | 78 | real-harness benchmark workspaces (TS "fullstack", Python `retrykit`/`auditlog`) |
| `indexd/` | 19 | Rust lexical indexing / RepoIntel library |
| `horizoncode-sandbox/` | 11 | Rust OS-confinement backend (bubblewrap / Landlock) |
| `specs/` | 14 | legacy OpenCode specs (`project.md`, `tui-package.md`, `v2/`, `storage/`) |
| `github/` | 10 | GitHub Action (`action.yml` + `index.ts`) |
| `infra/` | 7 | SST infra (app/console/enterprise/monitoring/secret/stage/stats) |
| `patches/` | 20 | bun patches (AI-SDK providers, effect, MCP SDK, tree-sitter …) |
| `.opencode/` | 38 | repo-local agents, commands, skills, glossary (17 languages), themes, TUI smoke plugin |
| `HANDOFF.md` | 1 file, 942 KB | running implementation journal + digest block |

Largest packages by file count: `ui` 1695, `horizoncode` 1086 (the core host), `web` 692, `app` 633, `core` 598, `console` 577, `tui` 309, `desktop` 306, `llm` 156, `stats` 123, `session-ui` 119, `schema` 112.

### 0.3 Package map (what lives where)

| Package | Files | What it owns |
|---|---|---|
| `packages/horizoncode` | 1086 | The host product: session/agent loop, tools, CLI, server HTTP API, providers, config, permissions, auth, LSP/DAP/REPL/MCP, ACP server, plugins, analytics, control-plane, sync, share |
| `packages/core` | 598 | Shared services: SQLite+drizzle database & 56 migrations, session store/projection, `SessionSupervisor` RPC client, provider/model registry, ripgrep, pty, harness profiles, system context, trusted principals, references, skills, tool definitions |
| `packages/llm` | 156 | Provider protocol adapters (`openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`, `bedrock-converse`), route/transport (HTTP + WebSocket), streaming tool runtime, event/error schemas |
| `packages/tui` | 309 | opentui/SolidJS terminal UI: routes, ~45 dialogs, activity stream/cards, prompt editor, themes |
| `packages/app` | 633 | SolidStart web UI (sessions, timeline, composer, settings-v2, i18n, Playwright e2e) |
| `packages/desktop` | 306 | Electron desktop app |
| `packages/ui` | 1695 | Shared component library/assets (mostly icons) |
| `packages/session-ui` | 119 | Shared session rendering components |
| `packages/schema` | 112 | Canonical machine schemas published as JSON (context-ledger-v2, harness-profile-v1, secret-broker-v1, …) |
| `packages/protocol` | 26 | Typed API groups (session, message, permission, pty, credential, event, agent, skill, provider …) |
| `packages/server` | 34 | Server package |
| `packages/sdk` / `sdk-next` | 50 / 9 | Generated clients |
| `packages/plugin` | 42 | Plugin API v2 (promise + effect flavours) |
| `packages/codemode` | 41 | Sandboxed JS orchestration runtime + stdlib + OpenAPI bridge |
| `packages/console` | 577 | Cloud console (auth, billing, routes, i18n) |
| `packages/enterprise`, `stats`, `identity`, `function`, `containers`, `slack`, `docs`, `storybook`, `web`, `cli`, `client`, `effect-drizzle-sqlite`, `effect-sqlite-node`, `http-recorder`, `httpapi-codegen`, `script` | various | Supporting apps and libs |

### 0.4 How the build is assembled (important)

`scripts/architecture/bootstrap_source.py --apply` hydrates pinned upstream sources before building (README "Getting started"). The repo ships a hybrid: first-party Horizon code plus a hydrated OpenCode snapshot. `scripts/architecture/audit_local_reference_copies.py`, `validate_external_sources.py` and `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` track external source pins (`opencode` pin `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322` is named in `packages/horizoncode/src/provider/UPSTREAM.md`).

### 0.5 Documentation corpus (read in full for this audit)

`docs/` (28 markdown/doc files) + `docs/architecture-archive/**` + `docs/superpowers/{plans,specs}/**` + `docs/performance/**` + `docs/reliability/**` + `docs/research/**` + root README/AGENTS/CONTRIBUTING/SECURITY + every package README + every `AGENTS.md`. Key reads:

- `docs/README.md` — documentation map and reading rule
- `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` — operative P0–P9 / RC0–RC5 checklist (the live plan)
- `docs/superpowers/plans/2026-10-25-hostrun-contract.md`, `2026-10-09-horizon-p2-foundation.md`, `2026-10-10-horizon-p2-thread-cutover.md`, `2026-10-10-session-observer-supervisor.md`
- `docs/superpowers/specs/*` (kernel foundation design, Veo-inspired capability roadmap)
- `docs/agent-tool-routing.md`, `docs/CAPABILITY-LOCAL-DEV.md`, `docs/repository-root-inventory.md`, `docs/reliability/2026-10-29-reliability-program.md`, `docs/research/2026-10-21-pi-codex-harness-decisions.md`
- `docs/performance/README.md` + `docs/performance/evidence/*` (RAM measurement runbook and recorded logs)
- `docs/architecture-archive/**` (non-operative: pre-lean-consolidation `arch_V1` snapshot, superseded thread/memory schema prototypes, handoff chronology)
- `arch_V1/README.md` + `arch_V1/17-GOVERNANCE-DECISIONS.md` (referenced) + `arch_V1/46-V1-*` (audit package) + `arch_V1/contracts-v2/`

**Audit finding — documentation drift.** At least 13 tracked markdown files point at two root files that **do not exist in this clone**: `implementationtov1release.md` (called the "V1 phase tracker and scope ledger", ~719 KB per `docs/repository-root-inventory.md`) and `CURRENT_RUN.md` ("append-only work diary", ~1.1 MB). Examples: `arch_V1/README.md:67` and `:89`, `arch_V1/10-DELIVERY.md:178` and `:213`, `arch_V1/46-V1-DESIGN-AUDIT.md:24`, `arch_V1/46-V1-WIRE-TRACKER.md:216`, `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md:938`, `docs/repository-root-inventory.md`. Anyone following the documented reading order will hit missing status authority.

Also worth noting for the reading order: `docs/CAPABILITY-LOCAL-DEV.md` records the drift directly ("Prefer paths under `packages/horizoncode/` (not `packages/opencode/`). Legacy `HANDOFF.md` / wire tracker remain historical").

### 0.6 Honest product status (per the repo's own records)

The repo is unusually candid about not being finished. `README.md` "Project status":

> "HorizonCode is being implemented in public. **Interactive coding and the application foundation are present; the full managed-coding product is not yet released.**"

Known limitations listed by the README itself: the independent-evidence gate is designed but not wired into the direct session lane; subagent delegation is implemented but disabled behind a flag; two edits to the same file in one message are refused by the kernel; a few slash commands need a mediated shell and return 503; native Windows is unsupported.

`HANDOFF.md` DIGEST (2026-10-29 18:10 UTC) records measured state: `arch_V1/46-V1-WIRE-TRACKER.md` = **0 Done · 73 Partial · 12 Not done · 1 N/A**; benchmark runs on real SWE-bench Verified tasks (django-11099 VERIFIED, django-15503 VERIFIED, others partial) with NVIDIA Nemotron; retrykit API 13 calls / 0 tool errors; auditlog TUI 22/22 VERIFIED; tool-call success ~48 %; dead lanes flagged explicitly (`DIRECT_CHILD_TURN_RPC_ENABLED = false`).

---

## 1. Complete feature inventory by area

### 1.1 Agent loop / session runtime

| Feature | Where |
|---|---|
| Main agent loop (`while(true)` step loop, tool-call continuation, finish-reason handling) | `packages/horizoncode/src/session/prompt.ts` (`runLoopImpl`, lines ~1856-2374) |
| Max-steps injection (assistant prefill prompt) | `packages/horizoncode/src/session/prompt.ts` (~2113, 2237) + `packages/core/src/session/runner/max-steps.ts` |
| CLI turn cap `HORIZONCODE_CLI_MAX_TURNS` / spend cap `HORIZONCODE_CLI_MAX_COST_USD` | same file, lines 94-106, 2032-2043 |
| Per-turn `SessionReminders.apply` (system reminders) | `packages/horizoncode/src/session/reminders.ts` |
| Session title generation (forked, model-pinned, `think` stripping) | `packages/horizoncode/src/session/prompt.ts:396-459` + `packages/horizoncode/src/agent/prompt/title.txt` |
| Summarization | `packages/horizoncode/src/session/summary.ts`, `session/compaction.ts`, `session/overflow.ts` |
| Structured output (`json_schema` format → synthetic `StructuredOutput` tool) | `packages/horizoncode/src/session/prompt.ts:122-131`, `2180-2193`, `2931-2962` |
| Content-filter handling (surfaces provider refusal as error) | `packages/horizoncode/src/session/prompt.ts:2322-2343` |
| Interrupt/abort finalisation of half-written assistant messages | `packages/horizoncode/src/session/prompt.ts:2136-2144` |
| Session run state / execution ownership / busy errors | `packages/horizoncode/src/session/run-state.ts`, `packages/core/src/session/run-coordinator.ts` |
| Per-session event log + projection | `packages/core/src/session/event.ts`, `projector.ts`, `store.ts`; kernel `session_projection.rs` |
| Session input (event-sourced) | `packages/core/src/session/input.ts` (+ migration `20260604172448_event_sourced_session_input.ts`) |
| Context selection / ledger / epoch | `packages/core/src/session/context-{selection,ledger,epoch,ops,compile-policy}.ts` |
| Compaction-aware context snapshot reconcile/replace | `packages/core/src/session/context-epoch.ts` (174 lines) |
| Session revert (undo) | `packages/horizoncode/src/session/revert.ts` |
| Checkpoints (capture + Guard-admitted restore) | `packages/horizoncode/src/session/checkpoint-store.ts`, `checkpoint-control.ts`, `src/tool/…`; UI `packages/tui/src/component/dialog-checkpoint.tsx` |
| Session export/import | `packages/horizoncode/src/cli/cmd/{export,import}.ts` |
| Session move between projects/workspaces | `packages/core/src/control-plane/move-session.ts`; TUI `dialog-move-session.tsx` |
| File-read tracking (for context accounting, read-before-edit) | `packages/horizoncode/src/session/file-read-tracker.ts` |
| Message model v1/v2 migration | `packages/horizoncode/src/session/message.ts`, `message-v2.ts` |
| Retry policy for provider failures | `packages/horizoncode/src/session/retry.ts` |
| Part delta cursor (streaming part ordering) | `packages/horizoncode/src/session/part-delta-cursor.ts` |

### 1.2 Prompting and harness configuration

| Feature | Where |
|---|---|
| 15 per-model system prompts (default, anthropic, gpt, gpt-astra, codex, copilot-gpt-5, beast, gemini, kimi, meta, trinity, plan, plan-mode, plan-reminder-anthropic, build-switch) | `packages/horizoncode/src/session/prompt/*.txt` (1,834 lines total across all prompt/tool txt) |
| Model→prompt routing (id-substring dispatch incl. muse/gpt-4/o1/o3/gpt-6/codex/gemini/claude/trinity/kimi) | `packages/horizoncode/src/session/system.ts:29-52` |
| HarnessProfileV1 catalog — 3 built-ins with immutable prompt ArtifactRefs (blake3 digest + byteLength + mediaType), tool projection, codec IDs | `packages/core/src/harness-profile.ts` |
| Capability-based tool projection (`native_rich` / `minimal` / `bash_only`) | `packages/core/src/harness-profile.ts:109-124` |
| Verification discipline text injected into every harness prompt | `packages/core/src/harness-profile.ts:34-43` |
| Environment block injected per request (`<env>` with cwd, worktree, git flag, platform) | `packages/horizoncode/src/session/system.ts:70-105` |
| Project references injected as `<available_references>` | same |
| Skills metadata injected into system prompt (verbose) with tool description kept terse | `packages/horizoncode/src/session/system.ts:107-119` |
| MCP server instructions injected as `<mcp_instructions>` | `packages/horizoncode/src/session/system.ts:121-137` |
| Instruction files (AGENTS.md etc.) | `packages/horizoncode/src/session/instruction.ts`; `packages/core/src/instruction-context.ts` |
| Agent prompt templates | `packages/horizoncode/src/agent/generate.txt`, `src/agent/prompt/{compaction,explore,summary,title}.txt` |
| Slash-command templates | `packages/horizoncode/src/command/template/{initialize,review}.txt`, `src/command/index.ts` |

### 1.3 Tools

Tool implementations live in `packages/horizoncode/src/tool/` (id → file):

| Tool id | File | Notes |
|---|---|---|
| `read` | `read.ts` + `read.txt` | line/offset reads, image/document attachments, directory listing |
| `write` | `write.ts` + `write.txt` | create/overwrite via Guard (parent chain creation is a documented past defect A1) |
| `edit` | `edit.ts` + `edit.txt` | exact-match string replace with preimage validation |
| `patch` (`apply_patch`) | `apply_patch.ts` + `apply_patch.txt` | V4A-style patch; auto-selected for `gpt-*` (non-`oss`, non-`gpt-4`) models |
| `bash` / shell | `shell.ts`, `shell/id.ts`, `shell/prompt.ts`, `shell/shell.txt` | terminal.run effect; `workspace_profile` mode for configured command profiles |
| `glob` | `glob.ts` + `glob.txt` | |
| `grep` | `grep.ts` + `grep.txt` | |
| `task` | `task.ts` (2,146 lines) + `task.txt` | subagent delegation; selector must resolve an immutable AgentProfileV2 |
| `todowrite` | `todo.ts` + `todowrite.txt` | |
| `webfetch` | `webfetch.ts` + `webfetch.txt` | |
| `websearch` | `websearch.ts`, `websearch-runtime.ts`, `websearch-broker.ts`, `websearch-adapters.ts`, `websearch-inspect.ts` | multi-route cascade, Guard-admitted |
| `skill` | `skill.ts` + `skill.txt` | loads `SKILL.md` |
| `question` | `question.ts` + `question.txt` | the only control tool that may bypass effect Guard admission (`isStandaloneControlTool`, `tool-batch.ts:248-259`) |
| `plan` (enter/exit) | `plan.ts`, `plan-enter.txt`, `plan-exit.txt` | behind `experimentalPlanMode` + cli client |
| `lsp` | `lsp.ts` + `lsp.txt` | definitions/references/hover/symbols; edit ops behind `OPENCODE_EXPERIMENTAL_LSP_TOOL` |
| `debug` (DAP) | `dap.ts` | hidden until `DAP_TOOL_ACCEPTANCE_READY` |
| `repo_tree`, `repo_detect` | `repo-tools.ts` | discovery-level RepoIntel reads, gated on host feature negotiation |
| `symbols_search`, `references_find`, `definitions_find` | `repo-tools.ts` | closed (`REPO_INTEL_TOOL_ACCEPTANCE_READY = false`) |
| `artifact_search`, terminal search, terminal output range | `managed-artifact-search.ts` | managed/child Attempt artifact reads |
| `history_search`, `history_read_range` | `history.ts`, `history-projection.ts` | search over session history |
| `git_status`, `git_diff`, `git_log`, `git_show`, `git_branch_list` | `git.ts` | fixed argv, no shell, flag-injection guard, workspace-confined, 10 s deadline |
| `execute` (CodeMode) | `code-mode.ts`, `code-mode-run.ts`, `code-mode-protocol.ts`, `code-mode-helper.ts` | gated: `CODE_MODE_HELPER_RUNTIME_READY = false` |
| invalid-tool sentinel | `invalid.ts` | |
| Tool schema helpers / JSON-schema tooling | `json-schema.ts`, `schema.ts` | |
| Truncation + spill-to-disk (`truncation-dir.ts`, `truncate.ts`) | | large outputs bounded and stored |
| `verify` (parameters + prompt) | `verify/parameters.ts`, `verify.txt` | |
| Tool registry + per-model filtering + plugin hook | `registry.ts` (451 lines) | |
| Tool definition/validation/normalization/prepare contract | `tool/tool.ts`, `tool/tool-batch.ts` | `validate` / `normalize` / `prepare` / `execute` lifecycle |
| Progressive tool discovery (bounded descriptor search + toolset source refs) | `tool/discovery.ts`, `session/tools.ts` | |

**Tool visibility is negotiated, not static.** `ToolRegistry` (registry.ts:239-301) exposes tools only if: the acceptance-flag constant is true, the sandboxed host negotiates the feature (`supervisor.hostFeatureEnabled(...)`), the runtime reports a genuinely ready route (websearch), the model matches (`apply_patch` vs `edit`/`write`), the client is `cli` (plan), and the permission ruleset allows it. Project/plugin tool modules (`{tool,tools}/*.{js,ts}`) are **deliberately not imported** — a warning is logged instead, because there is no Guard-compatible executor (registry.ts:185-198).

### 1.4 Tool admission / execution authority (the core novelty)

| Feature | Where |
|---|---|
| Provider-stream gate: buffers tool calls, bounds them, denies whole batch on protocol faults | `packages/horizoncode/src/session/tool-batch.ts:631-818` (`toolBatchMiddleware`, `gateToolCallStream`) |
| Bounds: 32 calls/batch, 256 KB/argument, 512 KB/batch, 16,384 delta chunks, 10-minute stream cap | `tool-batch.ts:62-69` |
| Effect-class routing: only `terminal.run | files.write | files.patch | web.search` reach the kernel | `tool-batch.ts:1224-1243` |
| Complete-batch admission, per-call challenge/lease, wrapped-host-shape tolerance | `tool-batch.ts:1497-1563`, `wrappedBatchAdmissionCalls` 1781-1794 |
| Same-path edit chaining inside one batch (batch-scoped staged content) | `tool-batch.ts:91-137`, `1280-1304` |
| Per-call denial isolation (one bad edit no longer kills the turn) | `tool-batch.ts:1200-1210`, `1321-1331` |
| `requireToolExecution` — every tool must prove an admission outcome before executing | `tool-batch.ts:549-582` |
| Attempt authority (direct Attempt / direct Turn / managed Attempt) with scope transitions | `session/managed-control.ts`, `tool-batch.ts:292-330`, `1573-1627` |
| Managed usage accounting before effects (`beforeManagedEffects`) | `tool-batch.ts:1376-1399` |
| CodeMode wave dispatch + receipt/digest reconciliation + UNKNOWN fencing | `tool-batch.ts:820-1130` |
| Output redaction (ANSI/control chars stripped, keys/JWTs/`AKIA…`/URLs-with-credentials redacted) | `tool-batch.ts:1095-1145` |

### 1.5 Rust kernel

`kernel/src/*.rs` (~169.5 K lines; `host_kernel.rs` alone is 48,214 lines):

| Module | Lines | Role |
|---|---|---|
| `host_kernel.rs` | 48,214 | HostKernel process: service dispatch, allowlist, permission-mode projection, direct/managed session authority, ToolBatch admission, terminal effects |
| `managed_control.rs` | 21,229 | Goal/SpecVersion/Run/Task/Attempt state machine, HostRun dispatch binding, receipts |
| `effect_host.rs` | 20,509 | Effect execution: leases, receipts, quiescence proof, UNKNOWN recovery, cgroup identity |
| `worker_durable.rs` | 13,593 | Durable clone-apply-commit worker adapter with crash windows |
| `protocol.rs` | 7,842 | Wire protocol, feature negotiation, service registry |
| `terminal_process.rs` | 6,715 | Platform process backend (Linux/Windows) |
| `artifact_store.rs` | 4,147 | Immutable artifact bytes store |
| `owner_log.rs` + `owner_log_index.rs` | 3,416+ | OwnerLog V2 canonical event stream + index + recovery |
| `worker_pool.rs` | 3,352 | Bounded worker pool with capacity/lease composition |
| `resource_budget.rs` | 3,254 | Reservation/budget accounting |
| `resource_sampler.rs` | 3,067 | Ownership-scoped process-tree sampling with explicit unknown states |
| `http_execution.rs` | 2,756 | HTTPS-only DNS-pinned outbound HTTP |
| `guard.rs` | 2,727 | Canonical authorization decisions, permission-mode projection schema |
| `automation.rs` | 2,686 | Durable automation scheduling state |
| `checkpoint.rs` | 2,431 | Checkpoint journal + fail-closed restore preview |
| `terminal.rs`, `terminal_profile.rs` | 1,569 / 922 | Terminal grants, generation-scoped sequencing, configured shell profiles |
| `worktree_pool.rs`, `worktree_lifecycle.rs` | 1,515 / 1,174 | Worktree lease lifecycle |
| `task_dag.rs` | 1,239 | Bounded Task-DAG admission + typed artifact edges |
| `secret_use.rs`, `secret_mutation.rs`, `search_secret_journal.rs` | 1,109 / 960 / 439 | Credential use/mutation grants and journals |
| `managed_verifier.rs`, `verifier_journal.rs` | 837 / 621 | Managed verification + journal |
| `cgroup_v2.rs` | 813 | Linux cgroup-v2 containment identity + restart quiescence proof |
| `context_selection.rs` | 633 | ContextSelectionV1 validation |
| `session_projection.rs`, `subscription.rs` | 610 / 236 | Read-only session projection pages + subscription windows |
| `direct_message_journal.rs`, `direct_turn_journal.rs`, `subagent_delivery.rs` | 420+ | Direct child mailbox + turn cycles + cross-language delivery decoding |
| `supervisor_lease.rs`, `supervisor_session.rs` | 431 / 414 | Supervisor leases/sessions |
| `messagepack.rs` | 1,057 | Canonical MessagePack codec |
| `search_html.rs` | 585 | Panic-free HTML decoder for the keyless provider |
| `codemode_protocol.rs` | 971 | CodeMode helper RPC frames |
| `unix_peer.rs` / `windows_peer.rs` | 428 / 964 | Peer authentication (Windows adapter partial) |
| `startup.rs`, `transport.rs`, `rpc_handshake.rs`, `protocol_framing.rs`, `protocol_io_journal.rs`, `request_cancellation.rs`, `agent_profile.rs`, `workspace_command_profile.rs`, `direct_session_grant.rs` | — | Readiness gate, transport, handshake, framing, IO journal, cancellation, profile/grant schemas |

Binaries: `bin/hz-kernel.rs` (512), `bin/session_supervisor.rs` (488), `bin/session_sync_probe.rs` (147).

Test surface: 33 integration tests in `kernel/tests/`, including `tool_batch_guard_matrix.rs`, `tool_batch_multi_call.rs`, `effect_direct_write.rs`, `effect_host_principal.rs`, `effects_host_process.rs`, `managed_settlement_provenance.rs`, `owner_log_golden.rs`, `owner_log_recovery.rs`, `secret_use_grant.rs`, `secret_mutation_grant.rs`, `session_projection*.rs`, `supervisor_lease.rs`, `crash_windows.rs`, plus shared fixtures under `kernel/tests/fixtures/` (pre-admission proof, reservation wire, delegation binding, agent-profile v2, owner-log v2 records).

### 1.6 Providers, models & credentials

| Feature | Where |
|---|---|
| Provider registry over models.dev (bundled adapters, custom providers, npm plugin install) | `packages/horizoncode/src/provider/provider.ts` (2,645 lines) |
| Provider transform (options/headers/wire-shape per SDK) | `provider/transform.ts` (1,922 lines) |
| models.dev catalog + last-known-good cache + one bounded startup refresh | `packages/core/src/models-dev.ts`, `core/src/plugin/models-dev.ts` |
| Offline provider doctor (no network unless authorized) | `provider/doctor.ts` (283 lines) + `server/.../groups/provider-doctor.ts` |
| Model status/freshness projection (advisory only) | `provider/model-status.ts` |
| Provider error mapping | `provider/error.ts` |
| DigitalOcean cached catalog projection | `provider/digitalocean-catalog.ts` |
| 20+ vendored AI SDK providers (anthropic, openai, google, vertex, bedrock, groq, mistral, xai, cerebras, cohere, deepinfra, perplexity, togetherai, vercel, azure, gateway, openrouter, venice, gitlab-ai-provider, copilot, poe…) | root `package.json` + `packages/horizoncode/package.json` + `patches/` |
| GitHub Copilot plugin (chat + responses, token handling) | `packages/horizoncode/src/plugin/github-copilot/*`, `packages/core/src/github-copilot/*` |
| OpenAI Codex plugin + WebSocket pool | `src/plugin/openai/{codex.ts,ws.ts,ws-pool.ts}` |
| Additional provider plugins (azure, cerebras, cloudflare, digitalocean, modal, snowflake-cortex, xai) | `src/plugin/*.ts` |
| SecretBroker — leased/versioned/revocable credential use | `src/auth/secret-broker.ts`, `secret-service.ts`, `secret-service-store.ts` |
| Protected native credential input (no echo, no shell history) | `src/auth/secure-input.ts` |
| Credential mutation/use authorizers (Guard-mediated) | `src/auth/credential-{mutation,use}-authorizer.ts`; kernel `secret_mutation.rs`, `secret_use.rs` |
| Direct provider transport hardening (exact route match, forbidden headers rejected, bounded body, UNKNOWN on possible send, no replay) | `src/auth/provider-transport.ts` |
| Provider lifecycle commands (`providers`, `provider`, `models`, `github` auth) | `src/cli/cmd/{providers,provider,models,github*}.ts` |
| Free/anonymous eligibility gate (no hidden paid fallback) | `provider/provider.ts` + `src/analytics/model-guard.ts` |

### 1.7 Configuration

`packages/horizoncode/src/config/`: `config.ts` (1,298), `agent.ts`, `command.ts`, `managed.ts`, `markdown.ts` (frontmatter), `parse.ts`, `paths.ts`, `plugin.ts`, `variable.ts` (`{env:…}`, `{file:…}`), `entry-name.ts`, `tui.ts` (276), `tui-cwd.ts`, `tui-host-attention.ts`, `tui-migrate.ts` (legacy theme/keybinds → `tui` block), `v2-compat.ts` (481).

Notable: deep-merge with array concatenation for `instructions`; a comment records that remeda's deep conditional merge type dominated TS profiling so it is kept out of the hot path; `applyPendingFeatures()` applies queued settings only at a new root prompt boundary (never mid-Attempt); remote config via account/console with `RemoteAuthError`; `workspace-command-profile-v1` and `external-editor-profile-v1` schemas for sandboxed build/test command profiles and editor bindings.

### 1.8 Permissions & execution posture

| Feature | Where |
|---|---|
| Permission ruleset evaluation (`allow`/`ask`/`deny`, wildcard patterns, arity) | `src/permission/{index,evaluate,arity}.ts`; `packages/core/src/v1/permission.ts` |
| Three postures enforced by the kernel (Allow = `danger-full-access`/`never`, Ask = `workspace-write`/`on-request`, Deny = `read-only`) | README table; `kernel/src/guard.rs` (`DirectSandboxModeV1`, `DirectApprovalPolicyV1`, `DirectSessionPermissionModeProjectionV1`) |
| Guard approval dialog (durable challenge → user decision) | `packages/tui/src/component/dialog-guard-approval.tsx`, `src/permission/*`, HTTP group `groups/permission.ts` |
| Subagent permission derivation (child ⊆ parent) | `src/agent/subagent-permissions.ts`; managed children also force-deny `task` + `todowrite` (prompt.ts:1191-1200) |
| Origin guarding for plugins/MCP/LSP/DAP (`guarded-origin.ts`, `local-cli-origin.ts`) | `src/util/guarded-origin.ts`, `src/util/local-cli-origin.ts` |
| Plans / approval-only mode | `src/tool/plan*.txt`, `flags.experimentalPlanMode` |

### 1.9 CLI surface (`hzcode`)

`src/cli/cmd/`: `account`, `acp`, `agent`, `analytics`, `attach`, `cmd`, `db`, `debug` (agent/config/file/lsp/redact/ripgrep/scrap/skill/snapshot/startup/v2), `direct-mode`, `export`, `generate`, `github`, `import`, `mcp`, `models`, `plug`, `prompt-display`, `providers`, `provider`, `pr`, `run`, `serve`, `session`, `stats`, `tui`, `uninstall`, `update`, `upgrade`, `web`.

`run` has its own runtime: `src/cli/cmd/run/{runtime.ts,runtime.boot.ts,runtime.lifecycle.ts,runtime.queue.ts,runtime.session.ts,runtime.stdin.ts,stream.ts,stream.transport.ts,scrollback.*,footer.*,prompt.editor.ts,turn-summary.ts,splash.ts,theme.ts,tool.ts,trace.ts,variant.shared.ts,session-replay.ts,subagent-data.ts}` (plus footer sub-panels for command/menu/permission/prompt/question/subagent).

### 1.10 Server, HTTP API, SDK, protocol

- `src/server/routes/instance/httpapi/` — 28 route groups + 28 handlers (artifact, automation, checkpoint, config, control-plane, control, event, experimental, file, global, instance, mcp, metadata, permission, project-copy, project, provider-doctor, provider, pty, query, question, repo-explorer, session, sync, tui, websearch, workspace) with middleware (authorization, workspace routing, instance context, fence, proxy, compression, cors-vary, error, schema-error) and WebSocket tracker.
- OpenAPI: `packages/httpapi-codegen`, `packages/client/src/generated`, `packages/sdk`, `packages/sdk-next`.
- `packages/protocol/src/groups/*` — typed API groups.
- Server features: mDNS discovery (`src/server/mdns.ts`), TUI control endpoints (`shared/tui-control.ts`), pty tickets, public UI, fences, workspace routing, event stream.
- `hzcode attach <url>` client mode; `serve`, `web`, `acp`.

### 1.11 TUI (`packages/tui`, opentui + SolidJS)

- Routes: home, session (`routes/session/*`), plugin routes.
- ~45 dialogs: agent, automation-definition, checkpoint, console-org, debug, editor-explorer, editor-settings, features, goal-proposal, goal-review-inbox, goal-review, goal-run-plan, goal-verification, guard-approval, mcp, model, move-session, permissions, provider-doctor, provider, repo-intelligence-profile, repo-intelligence, retry-action, session-delete-failed, session-list, session-rename, skill, stash, status, subagent-message, subagents, tag, theme-list, variant, websearch-settings, workspace-create, workspace-file-changes, workspace-list, workspace-unavailable.
- Components: `activity-cards.ts`, `activity-stream.tsx`, `artifact-markdown.tsx`, `bg-pulse.tsx` + `bg-pulse-render.ts`, `svg-raster.ts` + worker entry, `terminal-graphics.ts`, `spinner`, `todo-item`, `error-component`, `plugin-route-missing`, `startup-loading`.
- Prompt editor: `component/prompt/{index.tsx,autocomplete.tsx,frecency.tsx,history.tsx,local-attachment.ts,move.tsx,stash.tsx,workspace.tsx,cwd.ts}`.
- Feature plugins: `feature-plugins/{home,sidebar,system}`; config/keybinds `config/keybind.ts`; theme system + theme assets; i18n.
- Renderer/stream plumbing: `cli/cmd/run/scrollback.*`, `stream.ts`.

### 1.12 Web / desktop / console / stats apps

- `packages/app` (SolidStart): pages home / layout / new-session / session (composer, timeline, v2), settings-v2, components (prompt-input, server, session, ui), contexts, hooks, i18n, WSL helpers, Playwright e2e (smoke, regression, user-story, performance/timeline, reproduction).
- `packages/desktop`: Electron main/preload/renderer + icons.
- `packages/console/app`: accounts, auth, billing, bench, changelog, docs, download, enterprise, go, honeycomb, legal, oauth, black/brand/data routes; SST deployment via `infra/`.
- `packages/stats`, `packages/enterprise`, `packages/identity`, `packages/slack`, `packages/docs` (MDX docs site), `packages/storybook`.

### 1.13 Subagents, skills, agents

- Agent definitions/config: `src/agent/agent.ts`, `packages/core/src/agent.ts`, `src/config/agent.ts`; AgentProfileV2 pinning (profileID/revision/digest/harness/limits) validated in `session/prompt.ts:132-167`.
- AgentProfileService records: `packages/core/src/config` (`agentProfiles()`, task selectors).
- Subagent execution: `src/tool/task.ts`, `src/session/managed-run-coordinator.ts`, `managed-subagent-inbox.ts`, `direct-subagent-inbox.ts`; kernel `subagent_delivery.rs`, `direct_message_journal.rs`, `direct_turn_journal.rs`.
- Skills: `src/skill/{index,discovery}.ts`; repo-local `.opencode/skills/*` (effect, horizon-docs, rtl-aware-development); 17 built-in skills in `packages/core/src/horizon/skills/*/SKILL.md` (browser-smoke-test, commit-pr, context-recovery, dependency-migration, horizoncode, horizon-docs, performance-profile, plan-change, plugin-audit, refactor-safely, release-readiness, repo-onboarding, review-change, security-review, test-debug, worktree-hygiene).
- Repo-local agents/commands: `.opencode/agent/{duplicate-pr,triage}.md`, `.opencode/command/{ai-deps,changelog,commit,issues,learn,rmslop,spellcheck,translate}.md`, `.opencode/tool/{github-pr-search,github-triage}.ts`.

### 1.14 MCP, LSP, DAP, REPL, plugins

- MCP: `src/mcp/{index,auth,browser,catalog,connected-layer,oauth-callback,oauth-provider,stub-layer,trust}.ts` + `@modelcontextprotocol/sdk` patch; server-side `tool/mcp-websearch.ts`.
- LSP: 20 files in `src/lsp/` incl. supervised client, launch profiles, process lifecycle/scope, guard authorizer, protocol dispatch queue, external editor, repo document reader, diagnostics, edits, host adapter; plus `packages/core` LSP glue.
- DAP: `src/dap/{session,protocol,host-adapter,host-protocol-client,supervised}.ts`.
- REPL: `src/repl/{lifecycle,protocol,supervised}.ts`.
- Plugins: `src/plugin/{index,install,loader,meta,shared}.ts`, `tui/{internal,runtime}.ts`, `pty-environment.ts`; public plugin API `packages/plugin/src/{index,shell,tool,tui}.ts` and v2 API in `packages/plugin/src/v2/{promise,effect}/` (plugin/command/agent/skill/reference/catalog/registration/context/aisdk filesystem).
- ACP (Agent Client Protocol) server: `src/acp/{agent,service,session,tool,permission,profile,directory,event,content,usage,config-option,error}.ts`.

### 1.15 Context / memory / indexing

- `packages/core/src/session/context-compile-policy.ts` (1,376) — per-request compile policy with tiers incl. `cache_anchor` vs `minimize_tokens` and `prefixCacheSupport` (rejects claiming cache anchor on a route without prefix-cache support).
- `context-selection.ts` — pinned source set per provider request (kind, sourceID, digest, bytes, inclusion reason).
- `context-ledger.ts` — canonical JSON ledger projection (`ContextLedgerV2`, 20k node / depth 24 canonicalization bounds) with digests; requires that every included selection source appears as a ledger entry.
- `context-epoch.ts` — durable per-session context baseline + snapshot, reconcile/replace driven by compaction.
- `system-context/{index,builtins,registry}.ts` — environment/instruction blocks with generation + snapshot semantics.
- `session/repo-intel-{cache-owner,overlay}.ts` — repo intelligence cache ownership and unsaved-buffer overlays.
- `packages/llm/src/cache-policy.ts` — prompt-cache policy.
- `indexd/` — generation-bound lexical index, immutable overlays (max 128 paths / 8 MiB per atomic batch), cursor pagination bound to query+base+overlay digests, explicit `PARTIAL` / `UNAVAILABLE` statuses, never `CURRENT`.
- `packages/core/src/transition` — message-history transfer/import (`session/transfer.ts`), history read (`session/history.ts`).

### 1.16 Durable automation, checkpoints, worktrees, budgets

- Automations: `src/session/automation-control.ts`, TUI `dialog-automation-definition.tsx`, kernel `automation.rs`, RPC tests `automation_checkpoint_rpc.rs`.
- Checkpoints: `session/checkpoint-store.ts` (capture via Session reads; restore **only** through Guarded ToolBatch leases), `checkpoint-control.ts`, kernel `checkpoint.rs`, TUI dialogs.
- Worktrees: `src/worktree/index.ts`, `packages/core/src/control-plane/*`, kernel `worktree_pool.rs`, `worktree_lifecycle.rs`, `worker_pool.rs`, `worker_durable.rs`.
- Resource budgets: kernel `resource_budget.rs`, `resource_sampler.rs`, `cgroup_v2.rs`; scripts `scripts/perf/{ram-usage.sh,rc0.py,admission_policy.py,baseline_evidence.py}`; runbook `docs/performance/README.md`.
- Resource/cluster containment: `scripts/dev/{cgroup-delegate.sh,with-cgroup.sh}`.

### 1.17 Sharing / sync / account

- `src/share/{session.ts,share-next.ts}` — session sharing.
- `src/sync/{schema.ts,README.md}` + DB migrations `add_sync_owner` — sync ownership.
- `src/account/{account,repo,schema,url}.ts`, `src/auth/*`, `src/cli/cmd/account.ts`, `packages/identity`.

### 1.18 Analytics, stats, exports

- `src/analytics/*` (12 files): `collect.ts`, `aggregate.ts`, `percentile.ts`, `classify.ts`, `failure-category.ts`, `model-guard.ts`, `run-records.ts`, `render.ts`, `events.ts`, `types.ts`; CLI `hzcode analytics`, `hzcode stats`.
- JSONL/JSON evidence under `reports/`, `docs/performance/evidence/`.
- `scripts/eval/{eval_harness.py,render_dashboard.ts,blake3.py,pre_admission_proof.py}` + tests.

### 1.19 Benchmarks and acceptance harnesses

- `bench/fullstack/meterbase*` (TS full-stack app, held-back tests, verified snapshot `meterbase-verified-20261029151801`), `bench/py/{auditlog,auditlog-attempt1,slash-probe}`, `bench/py-tui/{auditlog,retrykit}`, `bench/probe/*`.
- `scripts/e2e/*`: `run-horizoncode-app.sh`, `v1-smoke.sh`, `v1-live-provider.sh`, `v1-e2e-batch.sh`, `v1-cancel-restart.sh`, `v1-tui-journey.sh`, `v1-tui-pty-journey.sh`, `v1-websearch-live.sh`, `v1-routing-negative.sh`, `nemotron-bench.sh`, `fullstack-build.sh`, `py-task.sh`, `py-task-tui.sh`, `subagent-task.sh`, `probe-prompt.sh`, `slash-commands-probe.sh`.
- `scripts/verify/*`: `v1-final-verify.sh`, `v1-phase10-acceptance.sh`, `v1-rust-verify.sh`, `v1-terminal-e2e.sh`.
- `scripts/architecture/*`: bootstrap, markdown audit, convergence validator, contract tests, typecheck wrapper, push/full gates.

### 1.20 Install / update / release / packaging

- `install` (14,937 bytes, executable) + `scripts/install/horizoncode-install.sh` + tests; `scripts/update/horizoncode-update.sh` + semver tests; `src/cli/upgrade.ts`, `src/installation/index.ts`; `scripts/release/*` (prepare_build, release_gate, audit_distribution, clean_install, identity migration, notice provenance, CLEAN-MACHINE-PLAN.json).
- `nix/flake.nix` + `flake.lock` + `nix/scripts/*`.
- Docker: `.dockerignore`, `packages/containers`.
- CI: `.github/workflows/*`, `.github/actions/{setup-bun,setup-git-committer}`, `.github/ISSUE_TEMPLATE`, husky hooks, `.gitleaksignore`, `oxlint` config.

### 1.21 Operative developer documentation (not architecture authority, but load-bearing)

| Doc | What it gives implementers |
|---|---|
| `docs/CAPABILITY-LOCAL-DEV.md` | The **local-dev capability map**: exactly which capabilities `scripts/horizoncode` unlocks when `HORIZONCODE_LOCAL_CLI=1`, `HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1`, kernel built — and which stay production-gated. Central seam: `guardedOriginAvailable(process\|http\|stdio)` in `src/util/guarded-origin.ts`; principal mint in `src/util/principal-mint.ts` (HTTP `server_auth`, loopback `host_os`, CLI fallback). Also documents read-before-write via `FileReadTracker`, auto turn checkpoints on the local path, `--max-turns` / `--max-cost`, and calls out docs drift (`packages/horizoncode` vs `packages/opencode`) |
| `docs/agent-tool-routing.md` | Tool/skill **dispatch rules** for agents (MUST-use matrix for Chrome DevTools, Context7, Crawl4AI, DeepWiki, Desktop Commander, Engram, Exa, Git MCP, GitHub, Playwright, Sequential Thinking) plus the rule that a green connection badge is not proof an endpoint is mounted |
| `docs/reliability/2026-10-29-reliability-program.md` | Measured failure taxonomy: **Class A mechanical (~90 % of failures)**, Class B coverage (~5 %), Class C honesty (~5 %), with per-run tool-call/failure counts (fullstack 165 calls / 41 failures, retrykit 19/10, auditlog 31/8 and 35/6) and named defects A1/A2/A3 |
| `docs/performance/README.md` | Resource/RAM measurement runbook: pinned baseline setup, required metrics (PSS/RSS/private-dirty/USS, first-frame/input p50-p95, idle repaint, artifact bytes), "report unknown, never 0", and a 6-step comparison/gate procedure vs JCode (explicitly states no HorizonCode-vs-JCode benchmark has been run by the document) |
| `docs/repository-root-inventory.md` | Root-file roles and the 2026-10-22 purge list (20 i18n READMEs, `CURRENT_RUN.previous-full`, `HANDOFF_PROMPT.md`, `IMPLEMENTER_PROMPT.md`, `CONTEXT.md`, `STATS.md`) |
| `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md` | Accepted/rejected/deferred capability decisions from an external "VEO" concept (bounded subagents adopt, CodeMode defer, Firecracker and blind credential MITM **reject**, unverified 28 ms boot / 92 % cache claims rejected as evidence) |
| `docs/superpowers/plans/2026-10-25-hostrun-contract.md` | HostRun dispatch-binding contract: exact `host_run_dispatch_key` derivation, root-vs-child Session semantics, "UNKNOWN is never retry/replay authority", `RC0=NOT_ATTESTED` preserved |

### 1.22 CI / gates and quality tooling

- `scripts/architecture/run_push_gate.sh` and `run_full_gate.sh` (workspace gate entry points).
- `scripts/architecture/{audit_markdown_repo.py,validate_convergence.py,run_contract_tests.py,horizoncode_typecheck.sh,validate_external_sources.py,audit_local_reference_copies.py,audit_overlay_visibility.py,audit_repository.py,audit_workspace_packages.py}` + Python test counterparts.
- `scripts/verify/{v1-final-verify.sh,v1-phase10-acceptance.sh,v1-rust-verify.sh,v1-terminal-e2e.sh}` — the release gate chain (TypeScript → Rust → E2E) referenced throughout `reports/phases/LEDGER.md`.
- Per-package `bun test` targets wired in `turbo.json` (`opencode#test`, `@opencode-ai/core#test`, `@opencode-ai/function#test`, `@opencode-ai/app#test`, `@opencode-ai/ui#test`, `@opencode-ai/session-ui#test`).

---

## 2. Common patterns shared with typical coding agents

These are features HorizonCode has in common with the wider coding-agent field (Claude Code, Codex CLI, OpenCode, Cursor, Aider, Gemini CLI). They are not differentiators — they are table stakes — and are recorded so the comparison in §3 is honest.

1. **Interactive terminal UI + headless server + web UI**: `hzcode` TUI, `hzcode serve`, `hzcode web`, `hzcode attach <url>`.
2. **Client/server split with an HTTP + SSE/WebSocket API and generated SDKs** (`src/server/routes/instance/httpapi/*`, `packages/{protocol,client,sdk}`).
3. **Core tool set**: read, write, edit/patch, bash, glob, grep, webfetch, websearch, todo, task (subagent), skill load, question.
4. **Per-model system prompts and model-family special casing** (`session/system.ts` dispatch to 15 prompt files).
5. **AGENTS.md / instruction-file project context** (`session/instruction.ts`, root `AGENTS.md`).
6. **Skills with progressive disclosure** (`SKILL.md` + `skill` tool + verbose metadata in the system prompt).
7. **Subagents / delegation by task tool** with selector descriptions (`registry.ts:317-337`).
8. **Permission modes: allow / ask / deny with rulesets and per-tool patterns** (`src/permission/*`).
9. **Session persistence in SQLite with migrations and event projection** (`packages/core/src/database/*`, drizzle).
10. **Context compaction + summarisation + auto-overflow handling** (`session/compaction.ts`, `summary.ts`, `overflow.ts`).
11. **Session titles generated by the model** (`title.txt`, `prompt.ts:396-459`).
12. **Token/cost accounting and a stats command** (`stats.ts`, `session/…tokens`, `analytics`).
13. **MCP client support with OAuth and per-server trust** (`src/mcp/*`).
14. **LSP integration, diagnostics, code actions, rename** (`src/lsp/*`).
15. **ACP (Agent Client Protocol) server mode** (`src/acp/*`) — also present in several competitors.
16. **Plugin/hook API with lifecycle events** (`plugin.trigger("chat.message"|"tool.definition"|"command.execute.before"|"experimental.chat.messages.transform")`, `packages/plugin/src/v2/*`).
17. **Model catalog from a shared registry** (models.dev) with custom/base-URL providers and local servers.
18. **OAuth / device-code / API-key logins for many vendors** (`src/auth/*`, `src/cli/cmd/github*`, copilot, gitlab, poe).
19. **Git integration**: read-only git tools, PR checkout (`hzcode pr <n>`), GitHub Action + GitHub agent, worktree isolation.
20. **Checkpoint / rewind of a session** (checkpoint store + TUI dialog + CLI).
21. **Session share/export/import** and markdown transcript rendering.
22. **Automations / scheduled prompts** (definitions, run-now, inbox).
23. **Background jobs / PTY management** (`src/background/job.ts`, pty groups and tickets).
24. **Structured output / JSON-schema responses** with a synthetic tool and a retry/error path.
25. **Tool output truncation with spill-to-disk and range re-read** (`tool/truncate.ts`, `tool/truncation-dir.ts`).
26. **Large-image / document attachment normalization** (`src/image/image.ts`, MCP resource attachments).
27. **Multi-provider prompt caching awareness** (`packages/llm/src/cache-policy.ts`, provider transform cache markers).
28. **Desktop + web + docs + console monorepo around the same core** (Electron app, SolidStart web app, MDX docs site, cloud console, stats).
29. **Telemetry/usage accounting with provenance on each step** (`SessionEvent.Step.Ended.usageProvenance.requestID` per the plan doc).
30. **An agent-instruction file that doubles as a multi-agent orchestration doctrine** — the repo's root `AGENTS.md` prescribes fan-out widths, ledger format, return formats and a "continue, don't stop" rule (see §3.23 for why this instance is unusual in its explicitness).

---

## 3. UNIQUE capabilities only this repo has

Each item below has an evidence path. "Unique" is judged against the common baseline in §2 — i.e. these are either absent from typical agents or implemented here in a materially different way (usually with a Rust-owned authority and durable evidence).

### 3.1 Rust Guard mediation of every mutation, with receipts as the definition of "happened"

The model may request an effect; only the Rust kernel admits it, mints a one-use lease/challenge, and settles a receipt. `kernel/src/guard.rs` defines the canonical decision, `kernel/src/host_kernel.rs` (48,214 lines) hosts the admission services, `kernel/src/effect_host.rs` executes and settles.

```rust
// kernel/src/guard.rs — the posture projection is private to the Rust host boundary
pub(crate) enum DirectSandboxModeV1 { ReadOnly, WorkspaceWrite, DangerFullAccess }
pub(crate) enum DirectApprovalPolicyV1 { OnRequest, Always, Never }
```

Evidence: `kernel/src/guard.rs:1-120`, `kernel/tests/tool_batch_guard_matrix.rs`, `kernel/tests/effect_host_principal.rs`.

### 3.2 Whole-turn (ToolBatch) admission instead of per-call tool permission

All effect calls in one provider turn are validated, normalized and admitted as **one bounded operation set** (max 32 calls, 256 KB/call, 512 KB/batch), with per-call challenges, optional batch-wide leases, sequencing and cancellation. The TypeScript side is `packages/horizoncode/src/session/tool-batch.ts` (2,695 lines).

```ts
const MAX_TOOL_BATCH_CALLS = 32
const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024
const MAX_TOOL_BATCH_ARGUMENT_BYTES = 512 * 1024
const MAX_TOOL_STREAM_DELTA_CHUNKS = 16_384
const MAX_TOOL_STREAM_DURATION_MS = 10 * 60 * 1000
```

Evidence: `packages/horizoncode/src/session/tool-batch.ts:58-69`, `631-818`; `kernel/tests/tool_batch_multi_call.rs` (8 cases); README "bounded ToolBatch validation".

### 3.3 Same-path edit chaining inside one batch (staged preimages)

When one model message edits the same file twice, the second member must be prepared against the **first member's staged output**, not the pre-batch bytes. The batch keeps a scoped `pendingContent` index and chains publication order; the kernel revalidates every approved preimage against live bytes at admission.

```ts
// tool-batch.ts — batch-scoped, discarded with the batch, never ambient cache
function createPendingContentIndex(): ToolBatchPrepareContext["pendingContent"] {
  const staged = new Map<string, string>()
```

Evidence: `packages/horizoncode/src/session/tool-batch.ts:91-137`, `1280-1304`; README limitation note ("Two edits to the same file in one message are refused by the kernel; split them") documents the residual.

### 3.4 Acceptance flags compiled into the registry ("source presence is not integrated acceptance")

Capabilities that exist in source but are not end-to-end accepted are gated by named constants and host-feature negotiation, so they cannot be advertised to the model, and every execute path fails closed with a typed UNAVAILABLE instead of throwing.

```ts
export const REPO_INTEL_TOOL_ACCEPTANCE_READY = false
export const REPO_DISCOVERY_TOOL_ACCEPTANCE_READY = true
export const CODE_MODE_HELPER_RUNTIME_READY = false   // src/tool/code-mode.ts
// DAP_TOOL_ACCEPTANCE_READY, GUARDED_PTY_RUNTIME_READY, DIRECT_CHILD_TURN_RPC_ENABLED likewise
```

Evidence: `packages/horizoncode/src/tool/registry.ts:64-95`, `239-301`; `src/tool/code-mode.ts:17`; `src/tool/dap.ts`.

### 3.5 Tool visibility negotiated with the kernel per connection

A tool is exposed only if the host negotiates the feature: `supervisor.hostFeatureEnabled("effects.v2")`, `repo-intel.read-context-v1`, `web.search.cascade`. A route configuration alone is not authority.

```ts
const webSearchHostReady = webSearchRouteReady &&
  (yield* supervisor.hostFeatureEnabled(WEB_SEARCH_CASCADE_FEATURE).pipe(...)) &&
  (yield* supervisor.hostFeatureEnabled("effects.v2").pipe(...))
```

Evidence: `packages/horizoncode/src/tool/registry.ts:339-370`; `packages/core/src/session/supervisor.ts`.

### 3.6 HarnessProfileV1: immutable, digest-addressed system prompts with capability tool projection

Three built-in harnesses (`native-rich`, `native-minimal`, `bash-only`) each carry an ArtifactRef (`artifactId`, blake3 `digest`, `byteLength`, `mediaType`, `classification`) and project the authorized capability set into starter/deferred tools — progressive discovery that **never broadens authority**.

```ts
export function builtinHarnessSystemPromptV1(id: string): string | undefined
export function projectHarnessToolIDsV1(profile, availableCapabilityIDs)
  : { readonly starter: readonly string[]; readonly deferred: readonly string[] }
```

Evidence: `packages/core/src/harness-profile.ts:1-124`; tests `packages/core/test/agent/harness-prompt.test.ts`, `packages/core/test/harness-profile-tool-projection.test.ts`.

### 3.7 ContextLedgerV2 / ContextSelectionV1 — per-request accounting of exactly what was sent

Every provider request compiles a canonical, digest-bound selection and ledger: source kinds, IDs, revisions, content digests, byte counts, inclusion reasons, plus a compile policy (`cache_anchor` vs `minimize_tokens`, with an explicit rejection of claiming cache anchor on a route that lacks prefix-cache support). The ledger refuses to be built if an included source is missing from its entries.

```ts
if (entries.some((entry) => entry.included && !refs.has(entry.sourceRef)))
  throw new TypeError("ContextLedger entry does not match a pinned ContextSelection source")
if (selection.sources.some((source) => !represented.has(`${source.kind}:${source.sourceID}`)))
  throw new TypeError("ContextLedger omits an included ContextSelection source")
```

Evidence: `packages/core/src/session/context-ledger.ts:88-164`; `packages/core/src/session/context-compile-policy.ts` (1,376 lines); `packages/schema/*context-*`.

### 3.8 Two session lanes with different authority: Direct vs Managed (Goal/Run/Task/Attempt)

A direct session needs no Goal; a managed run is an unattended Goal→SpecVersion→Run→Task→Attempt pipeline whose authority is minted by HostKernel admission and never accepted from a client payload.

```ts
/** Internal managed-run entry. The authority must be minted by HostKernel
 * admission; request handlers never accept it from client payloads. */
readonly promptManaged: (input, authority: ManagedAttemptAuthority, followUpRunner?) => ...
```

Evidence: `packages/horizoncode/src/session/prompt.ts:203-211`, `1032-1041`; `kernel/src/managed_control.rs` (21,229 lines); `kernel/tests/managed_control*.rs`; `arch_V1/11-LIFECYCLE.md`.

### 3.9 Preflight commit of the exact provider request before dispatch

Before a managed dispatch, Core compiles the request with **no dispatch**, persists the ContextSelection into child-session metadata, and requires the recomputed selection to equal the persisted one on resume; a mismatch fails closed with `managed_conflict`.

```ts
if (persistedContextSelection && !sameManagedContextSelectionV1(persistedContextSelection, contextSelection))
  return yield* new ManagedControl.ManagedControlError({ ..., reason:
    "recompiled sequence-1 ContextSelection differs from the exact persisted pre-admission selection" })
```

Evidence: `packages/horizoncode/src/session/prompt.ts:1324-1371`, `1395-1428`; `packages/horizoncode/src/session/managed-control.ts` (8,862 lines).

### 3.10 Digest-chained direct child mailbox with one-use fresh-turn authorizations

Follow-ups to a child session are woken only from an exact committed inbox row; consumption produces a digest proof, is acknowledged by HostKernel, and a new child turn requires a HostKernel fresh-turn authorization bound to the completed turn scope.

```ts
if (!input.freshTurnAuthorization) {
  return yield* new ManagedControl.ManagedControlError({ operation: "direct_follow_up",
    code: "managed_unavailable", reason: "new child turns require a HostKernel fresh-turn authorization" })
}
```

Evidence: `packages/horizoncode/src/session/prompt.ts:1558-1837`; `src/session/direct-subagent-inbox.ts`; `kernel/src/direct_message_journal.rs`, `kernel/src/direct_turn_journal.rs`; DB migration `20261020090000_direct_subagent_inbox.ts`.

### 3.11 OwnerLog V2 — canonical, indexable, recoverable append-only event stream in Rust

Durable session/owner facts are written to a canonical stream with an index and golden/recovery tests, so a crash is replayable and a missing receipt is never invented.

Evidence: `kernel/src/owner_log.rs` (3,416), `kernel/src/owner_log_index.rs`; `kernel/tests/owner_log_golden.rs`, `kernel/tests/owner_log_recovery.rs`; fixtures `kernel/tests/fixtures/owner-log-v2/record-v2.jsonl`.

### 3.12 UNKNOWN as a first-class terminal state

Effect settlement, CodeMode waves, and recovery all model ``unknown`` explicitly, with strict shape checks that forbid an UNKNOWN row from carrying terminal evidence (no receipt digest, no result digest, no output bytes).

```ts
if (item.status === "unknown") {
  if (item.receiptKind !== null || item.receiptRef !== null || item.receiptDigest !== null ||
      item.resultDigest !== null || item.outputBytes !== null || item.errorCode !== null)
    throw new Error("UNKNOWN CodeMode result included terminal evidence")
```

Evidence: `packages/horizoncode/src/session/tool-batch.ts:958-962`, `1005-1011`; `kernel/src/effect_host.rs`; `HANDOFF.md` ("cancel / crash / UNKNOWN recovery" gate).

### 3.13 Guard-admitted checkpoint restore (and a Rust/TS split decision recorded in code)

The Rust HostKernel explicitly rejects `checkpoint.create`/`checkpoint.restore`, so the TypeScript store is the real path — and its restore **never** writes files directly: every write goes through ToolBatch leases, and an admission failure mutates nothing.

```ts
 *  - restore NEVER writes workspace files with fs directly. Every code write is
 *    admitted through the Guarded path (SessionSupervisor.prepareToolBatch ->
 *    one-use lease -> SessionSupervisor.executeWrite)
```

Evidence: `packages/horizoncode/src/session/checkpoint-store.ts:1-11`; `kernel/src/checkpoint.rs`; `kernel/tests/automation_checkpoint_rpc.rs`.

### 3.14 Worktree pool + worker pool + durable clone-apply-commit with crash-window tests

Rust owns capacity/worktree/Attempt lease composition and a durable worker adapter; crash windows are tested rather than asserted.

Evidence: `kernel/src/worker_pool.rs` (3,352), `kernel/src/worker_durable.rs` (13,593), `kernel/src/worktree_pool.rs`, `kernel/src/worktree_lifecycle.rs`; `kernel/tests/crash_windows.rs`, `kernel/tests/support/worker_durable_tests.rs`, `kernel/tests/support/worktree_pool_tests.rs`; `reports/phases/LEDGER.md` ("mirrored_p8_owner_receipt_survives_the_append_to_dispatch_crash_window").

### 3.15 Fail-closed OS-confined sandbox with a per-dimension guarantee vector

`horizoncode-sandbox` probes what the host actually provides (bubblewrap, namespaces, Landlock ABI via raw syscall), plans an execution, and returns named residuals — or a typed `Unsupported`; it never silently degrades to unconfined execution.

```rust
PreparedExecution::require(dimension, ExpectedLevel::ENFORCED) // below-level => SandboxError::GuaranteeNotMet
SandboxProfile::workspace_write(ws)  // .git/.agents/.codex/.horizoncode protected read-only, no network, private /tmp
```

Evidence: `horizoncode-sandbox/README.md`, `horizoncode-sandbox/src/{landlock,linux,unsupported}.rs`, `tests/capability_matrix.rs` (writes `$CARGO_TARGET_TMPDIR/hz-sandbox-capability-record.txt`).

### 3.16 Web-search cascade as an admitted effect with per-route attempts and credential refs

Search routes are ordered, explicitly enabled, attempt-counted per route, cooldown-tracked, and modelled as a Guard effect (`web.search`) whose argument set is frozen and hashed by Guard — including opaque SecretBroker refs rather than credentials.

```ts
export type SearchEffectArgumentsV1 = {
  query: string; limit: number; domains?: readonly string[]
  routes: readonly { routeKey: SearchRouteID; attemptCount: 2 }[]
  credentialRefsByRoute?: readonly { routeKey: SearchRouteID; secretRef: SecretBrokerV1.SecretRef }[]
}
```

Evidence: `packages/horizoncode/src/tool/websearch-runtime.ts:18-70`; `tool/websearch-broker.ts`, `tool/websearch-adapters.ts`; TUI `component/dialog-websearch-settings.tsx`; kernel `search_html.rs`, `search_secret_journal.rs`; `scripts/e2e/v1-websearch-live.sh`.

### 3.17 Indexd: generation-bound lexical index with immutable editor overlays and honest status

An index generation binds repository, workspace, revision set, read scope, policy, source receipt, parser set, paths and file bytes; cursors bind query + base + overlay digests; symbol/reference/impact answers are typed `UNAVAILABLE` rather than guessed; nothing ever reports `CURRENT`.

Evidence: `indexd/src/README.md`, `indexd/src/{generation_store,repo_intel,repo_structure,persist,watch,transport,upload,handler}.rs`; `indexd/tests/*`.

### 3.18 Read-only git tools with argv-only execution and a flag-injection guard

Git tools run fixed argv (never a shell string), reject flag-like or out-of-grammar caller values, confine paths to the workspace, disable prompts/pagers/optional locks, and cap output.

```ts
if (value.startsWith("-")) return `${label} must not start with '-' (flag-injection guard)`
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" }
```

Evidence: `packages/horizoncode/src/tool/git.ts:1-60`.

### 3.19 Credential lifecycle as Guard-mediated mutation and use (leased, versioned, revocable)

Credentials have their own authorizers and durable journals in Rust; provider-transport hardening rejects forbidden headers, bounds bodies, and reports UNKNOWN on a possible send instead of replaying.

Evidence: `packages/horizoncode/src/auth/{secret-broker,secret-service,credential-mutation-authorizer,credential-use-authorizer,provider-transport,secure-input}.ts`; `kernel/src/secret_{use,mutation}.rs`; `kernel/tests/secret_{use,mutation}_grant.rs`; `arch_V1/14-EFFECTS-EXECUTION-SECURITY.md`.

### 3.20 CodeMode: digest-fenced scripted orchestration over the authorized catalog

A bounded helper RPC (`codemode_protocol.rs`) lets a model run a script that dispatches waves of tool calls; each wave is admitted as an ordinary ToolBatch, results are redacted and byte-budgeted per authenticated request, and an executor that throws is fenced as UNKNOWN rather than guessed terminal.

Evidence: `packages/horizoncode/src/tool/code-mode{,-run,-protocol,-helper}.ts`; `kernel/src/codemode_protocol.rs`; `packages/codemode/src/*` (interpreter, stdlib, OpenAPI); tests `packages/codemode/test/*`.

### 3.21 Harness-performance analytics from recorded run records

`hzcode analytics` computes TTFT, time-to-first-action, time-to-first-patch, tool-call success, total-to-verified-success, percentiles, and failure categories from recorded telemetry (not from self-report).

Evidence: `packages/horizoncode/src/analytics/*` (12 files), `src/cli/cmd/analytics.ts`; `HANDOFF.md` 2026-10-29 11:20 entry with concrete numbers (TTFT median 715 ms, p95 10.6 s; tool-call success 48.3 %).

### 3.22 A self-auditing documentation system with machine-checked structure

The repo ships tooling that audits its own docs and architecture convergence, plus frozen manifests of what the docs said at a point in time.

Evidence: `scripts/architecture/{audit_markdown_repo.py,validate_convergence.py,audit_repository.py,audit_workspace_packages.py,audit_overlay_visibility.py,run_push_gate.sh,run_full_gate.sh}`; `docs/audit-markdown-latest.json`, `docs/audits/2026-10-15-tracked-markdown-structural-manifest.json`, `arch_V1/repo-file-line-audit-manifest.json`, `arch_V1/ownership-phrase-audit-candidates.json`.

### 3.23 An explicit multi-agent implementation doctrine as a checked-in instruction file

Root `AGENTS.md` is not a style guide — it is an operating doctrine with fan-out widths ("8 phase leads in flight"), a ledger format, a subagent return contract (`DONE`/`PARTIAL`), and a standing order to continue rather than stop. It also names precedence against the pinned upstream instruction snapshot.

Evidence: `AGENTS.md` §0-§12 ("Today's directive: finish fast…"), `reports/phases/LEDGER.md` (the ledger it mandates).

### 3.24 A 942 KB append-only implementation journal as the primary status record

`HANDOFF.md` is the project's living state: a 12-line digest block followed by dated entries that record defects, measurements, corrections and dead lanes — including self-corrections when a measurement was wrong.

Evidence: `HANDOFF.md` (digest at the top; "CORRECTION: no regressions were observed" entry); referenced as status authority by `docs/README.md` and `arch_V1/README.md`.

### 3.25 Real-harness benchmark workspaces committed with held-back tests and evidence

`bench/` contains actual target applications (a TS full-stack app, two Python libraries) with verified snapshots and run reports, and grading workspaces for Python/TS tasks, wired to `scripts/e2e/*` and `reports/*`.

Evidence: `bench/fullstack/meterbase*`, `bench/py/{auditlog,retrykit}`, `bench/py-tui/*`, `reports/fullstack/*`, `reports/py/RESULTS.md`, `scripts/e2e/{fullstack-build.sh,py-task.sh,py-task-tui.sh,nemotron-bench.sh}`.

### 3.26 Privacy/redaction as a runtime invariant of the agent surface

Tool output crossing the CodeMode/helper boundary is byte-capped, control-character-stripped and pattern-redacted (private keys, bearer tokens, `sk-`/`ghp_`/`github_pat_`/`xox*`, AWS access keys, JWTs, `key=value` secrets, credentials embedded in URLs).

Evidence: `packages/horizoncode/src/session/tool-batch.ts:1095-1145`.

### 3.27 Repo-intelligence reads gated on a negotiated host feature, with a fail-closed executor

Discovery reads (`repo_tree`, `repo_detect`) are only offered once the host negotiates `repo-intel.read-context-v1`; structural reads (symbols/references/definitions) are additionally behind `experimentalRepoTools` and remain closed because `indexd` answers them with a typed `UnsupportedOperation`.

Evidence: `packages/horizoncode/src/tool/registry.ts:64-95`, `239-301`; `indexd/src/repo_intel.rs:93-100` (cited in-code).

### 3.28 Kernel-owned resource reservation with an explicit reservation wire schema

`arch_V1/contracts-v2`, `kernel/tests/fixtures/reservation-wire-v1.json`, `pre-admission-reserved-proof-v1.json`, `kernel/src/resource_budget.rs` and `scripts/eval/pre_admission_proof.py` implement a reservable budget with a cross-language proof generator.

Evidence: `kernel/src/resource_budget.rs` (3,254), `scripts/eval/{pre_admission_proof.py,test_pre_admission_proof.py}` (17 tests), `reports/phases/LEDGER.md` (P8 admission-proof parity work).

---

## 4. Docs-worthy items with proposed one-line names

The following are candidates for the project's documentation set — each is either undocumented outside source comments/architecture docs, or buried in `HANDOFF.md`. Proposed one-line titles:

| # | Proposed name | Evidence path |
|---|---|---|
| 1 | **Guard admission model: request vs authority** — how a tool request becomes an admitted effect | `kernel/src/guard.rs`, `kernel/src/host_kernel.rs`, `packages/horizoncode/src/session/tool-batch.ts` |
| 2 | **ToolBatch contract: bounds, classes and lease shapes** — 32 calls, 256 KB, challenge vs lease vs batch-lease | `packages/horizoncode/src/session/tool-batch.ts:58-69`, `264-300` |
| 3 | **Why read-only tools never reach the kernel** — the `unsupported_capability` lesson | `tool-batch.ts:1224-1243` |
| 4 | **Same-path batch edits: staged preimages and ordering** | `tool-batch.ts:91-137`, `1280-1304` |
| 5 | **Acceptance flags vs feature flags** — source presence is not integrated acceptance | `tool/registry.ts:64-95`, `tool/code-mode.ts:17` |
| 6 | **Host feature negotiation for tool exposure** — `hostFeatureEnabled` as the visibility gate | `tool/registry.ts:339-370` |
| 7 | **HarnessProfileV1: digest-addressed prompts and capability projection** | `packages/core/src/harness-profile.ts` |
| 8 | **Progressive tool discovery without authority expansion** | `tool/discovery.ts`, `session/tools.ts`, `harness-profile.ts:109-124` |
| 9 | **ContextLedgerV2: proving what the model was sent** | `packages/core/src/session/context-ledger.ts` |
| 10 | **Context compile policy: `cache_anchor` vs `minimize_tokens`** | `packages/core/src/session/context-compile-policy.ts` |
| 11 | **Direct vs managed lanes: when a Goal is required** | `session/prompt.ts:203-263`, `arch_V1/11-LIFECYCLE.md` |
| 12 | **Managed preflight: compiling the request before dispatch** | `session/prompt.ts:1070-1393` |
| 13 | **Direct child mailbox: commit → claim → consume → acknowledge** | `session/prompt.ts:1558-1837`, `kernel/src/direct_message_journal.rs` |
| 14 | **UNKNOWN discipline: what an unproven effect must report** | `tool-batch.ts:940-1062`, `kernel/src/effect_host.rs` |
| 15 | **OwnerLog V2: canonical stream, index, recovery** | `kernel/src/owner_log.rs`, `owner_log_index.rs` |
| 16 | **Checkpoint restore is a guarded effect, not a file copy** | `session/checkpoint-store.ts:1-11` |
| 17 | **Worktree/worker pool leases and crash windows** | `kernel/src/worker_durable.rs`, `kernel/tests/crash_windows.rs` |
| 18 | **Sandbox guarantee vector: per-dimension residuals, never silent degradation** | `horizoncode-sandbox/README.md` |
| 19 | **Web-search cascade: routes, attempts, cooldowns, credential refs** | `tool/websearch-{runtime,broker,adapters}.ts` |
| 20 | **Indexd generations, overlays and cursor binding** | `indexd/src/README.md` |
| 21 | **Read-only git tools: flag-injection guard and workspace confinement** | `tool/git.ts:1-60` |
| 22 | **SecretBroker: leased, versioned, revocable credential use** | `src/auth/secret-broker.ts`, `kernel/src/secret_use.rs` |
| 23 | **CodeMode: bounded scripted orchestration over authorized tools** | `tool/code-mode*.ts`, `kernel/src/codemode_protocol.rs` |
| 24 | **CodeMode/helper output redaction rules** | `tool-batch.ts:1095-1145` |
| 25 | **Analytics metrics and how they are derived** | `src/analytics/*`, `src/cli/cmd/analytics.ts` |
| 26 | **Posture enforcement: Allow/Ask/Deny mapped to kernel sandbox modes** | `README.md` table, `kernel/src/guard.rs:14-24` |
| 27 | **AgentProfileV2 pinning: profileID/revision/digest/harness and limits** | `session/prompt.ts:132-167`, `packages/core/src/config` |
| 28 | **Multi-agent doctrine and the phase ledger** | `AGENTS.md`, `reports/phases/LEDGER.md` |
| 29 | **Benchmark protocol: held-back tests, baseline probe, missing vs failed** | `scripts/e2e/nemotron-bench.sh`, `bench/*`, `HANDOFF.md` corrections |
| 30 | **Cross-language proof parity (Python generator ↔ Rust fixture)** | `scripts/eval/pre_admission_proof.py`, `kernel/tests/fixtures/pre-admission-reserved-proof-v1.json` |
| 31 | **Provider layer hardening: exact route projection, no hidden fallback** | `src/provider/UPSTREAM.md`, `src/auth/provider-transport.ts` |
| 32 | **Workspace command profiles: bounded build/test invocations** | `kernel/src/workspace_command_profile.rs`, `packages/schema/…workspace-command-profile-v1` |
| 33 | **Known limitations as first-class docs** | `README.md` "Known limitations", `HANDOFF.md` digest "Dead lanes" |

---

## 5. Optimization ideas

### 5.1 Speed

1. **Split the two mega-modules.** `kernel/src/host_kernel.rs` is 48,214 lines in one file and `packages/horizoncode/src/session/prompt.ts` is 3,006; Rust and TS incremental compile times scale badly with this shape. `host_kernel.rs` alone is ~28 % of the kernel. Mechanical module extraction (services already have clear boundaries: `direct_session_*`, `managed_*`, `terminal_*`, `guard_*`) would cut rebuild time and review cost without behavioral change.
2. **Cache the context-compile policy per (provider, model, prefix support) rather than recomputing per request.** `context-compile-policy.ts` is 1,376 lines of pure resolution run on a hot path.
3. **Deep-merge config guard already exists for a reason**: the code comment in `config/config.ts` says remeda's conditional deep-merge type dominated TS profiling. The same analysis should be applied to `mergeConfigConcatArrays` (array de-dupe via `Set` on every load) and to `MessageV2.toModelMessagesEffect`, which is awaited for both the title path and the main path in the same step (`prompt.ts:430`, `2208`).
4. **Tool registry rebuild per model change**: `ToolRegistry.tools` re-runs `webSearchRuntime.availability()` and two `hostFeatureEnabled` RPC-ish checks on every resolution. Memoize per (session, provider, model, agent, permission-digest).
5. **Trim the read-only path in the loop**: `resolvePromptParts` performs a `stat` per `@file` mention with `concurrency: unbounded`; on a large paste-heavy prompt this can fan out aggressively. A bounded concurrency plus a per-turn path cache would flatten latency spikes.
6. **Parallelise the per-step prelude**: `Effect.all([... sys.skills, sys.environment, instruction.system(), sys.mcp, toModelMessagesEffect])` is already concurrent, but `SessionReminders.apply` runs serially before it and does file-system work for reminders (`prompt.ts:2115`). Move reminder computation into the same `Effect.all`.
7. **Avoid double history reads per step**: `MessageV2.filterCompactedEffect` runs at the top of every loop iteration and again inside `compaction.isOverflow`/`compaction.create` paths. Cache the decoded message list per (session, sequence) and invalidate on append.
8. **Rust: bounded but repeated full-row scans in projection code.** The HANDOFF entry for Case 2 describes `projection_process_rows` selecting columns from every table in `PROJECTION_PROCESS_TABLES` with a missing-column failure mode. A per-table column map (static) removes both the failure and the per-read cost.
9. **Streaming bounds are byte-wise over the whole delta text** (`Buffer.byteLength` twice per tool-call part, `tool-batch.ts:767-773`). Track byte length incrementally from the stream deltas already counted, instead of re-measuring the assembled string.
10. **`memberChainByCall` is a module-global `Map` cleared past 4,096 entries** (`tool-batch.ts:405-424`). Under concurrent sessions in one process this is shared state; a per-batch keyed structure with the batch's own lifetime removes the global lock/GC pressure.

### 5.2 Capabilities

1. **Wire the independent-evidence gate into the direct lane.** README lists this as the top known limitation: a direct turn's "done" is still a claim. The kernel already owns Evidence/Verification (`kernel/src/managed_verifier.rs`, `verifier_journal.rs`); the direct lane needs the same settlement hook that managed attempts use (`ManagedControl.completeManagedProviderTurn`).
2. **Enable the subagent lane** (`DIRECT_CHILD_TURN_RPC_ENABLED = false`) once the multi-call edit lease is settled — the mailbox, receipts, and fresh-turn proofs are already implemented and tested.
3. **Multiple edits to the same file in one message.** The README lists this as a limitation. Batch-scoped staging exists (`pendingContent`) but the kernel revalidates preimages against live bytes at plan time; a durable "expected-after" chain in the same ToolBatch would let both edits be admitted as one ordered operation set.
4. **Moderate Landlock-only sandboxes as a supported tier.** `horizoncode-sandbox` already models weaker backends with named residuals; exposing `LandlockWriteScope` as a first-class posture (with the guarantee vector surfaced in the UI) would extend the product to hosts without bubblewrap.
5. **Implement a `pytest` runner for the benchmark harness** so the Python tasks that were blocked (matplotlib, xarray) can execute.
6. **Seed web-search routes at first run.** The HANDOFF digest notes the kernel search cascade "receives no routes so nothing is dispatched"; a first-run route bootstrap (keyless providers first) would make the `websearch` tool usable out of the box without weakening the consent gate.
7. **`hzcode run` needs an authenticated principal** — HANDOFF records that in-process embed has no ServerAuth principal so effects fail closed. Wiring a local principal mint for CLI embed mode (the pieces exist: `src/util/principal-mint.ts`, `local-direct-credentials.ts`) would make `run` functional for scripting.
8. **Windows support** is explicitly unsupported (README) but `kernel/src/windows_peer.rs` (964 lines) and the Windows process backend exist. Finishing Windows peer authentication and PTY/ConPTY would unlock a large user segment; the code already lists the exact gaps in `kernel/src/lib.rs:14-17`.
9. **Expose the ContextLedger and guarantee vector in the TUI/web UI** (partial UI exists: `dialog-checkpoint`, `activity-stream`, `artifact-markdown`). "Why did the model send this much context" is a differentiating diagnostic.
10. **Tree-sitter parsing in `indexd`** would flip `symbols_search`/`references_find`/`definitions_find` from typed UNAVAILABLE to real answers — the crate explicitly names this as the missing owner.
11. **Plan-mode ergonomics**: `plan` is behind `experimentalPlanMode` and only for the `cli` client; the exit/enter prompts already exist (`tool/plan-enter.txt`, `plan-exit.txt`).

### 5.3 Accuracy / reliability

1. **Token counts are unknown.** `context-ledger.ts` records byte counts and states token counts remain unknown without a tokenizer; wiring a per-model tokenizer (or reusing provider usage on the next request) would turn the ledger into a real budget and make `remainingTokens` predictions honest.
2. **Make "missing" a first-class scoring bucket everywhere.** The HANDOFF correction documents that counting unrunnable tests as regressions invented failures; the fix exists in the harness (`verify-tests.log` scoring) but the same class of bug should be audited in `src/analytics/classify.ts` and `failure-category.ts`.
3. **Cross-language digest parity tests as a gate, not a chore.** `reports/phases/LEDGER.md` records multiple rounds where Python and Rust disagreed on an admission-proof digest. A single generated conformance vector (already partly present in `kernel/tests/fixtures/`) run on both sides in CI would catch this class immediately.
4. **Enforce the "no second authority" rule mechanically.** `arch_V1/README.md` states the rule and `scripts/architecture/validate_convergence.py` partly checks it; extending it to fail on a second registry/catalog/credential-store declaration would prevent the regression class that `arch_V1/34-DOCUMENT-LINE-AUDIT-LEDGER.md` tracks.
5. **Reduce `HANDOFF.md` to a generated artifact.** A 942 KB hand-maintained journal is a correctness risk (stale digests, duplicated claims). A script that appends the digest block from `reports/phases/LEDGER.md` + `git status` + last evidence lines would keep it honest.
6. **Recoverable measurement failures.** The "Django parallel mode aborting with `cannot pickle 'traceback'`" and "baseline probe on a single label" entries show that harness bugs dominate some benchmark readings. Making the harness self-test (`scripts/perf/rc0.py --selfcheck`, already referenced in `docs/performance/evidence/`) mandatory before scoring would prevent wasted scoring rounds.
7. **Names: `packages/horizoncode` still carries `opencode` bin and `@opencode-ai/*` imports.** `reports/release-readiness-2026-10-23-naming.txt` and `arch_V1/46-V1-SOURCE-ALIGNMENT-AUDIT.md` track this; incomplete renaming risks shipping the wrong identity (and `scripts/release/audit_distribution.py` exists to catch it — run it before any packaging claim).
8. **Login-shell noise in shell results** (316 lines across 6 benchmark runs per HANDOFF) inflates context and hurts accuracy. A shell-profile normalization step (the `terminal_profile.rs` machinery already exists) should strip interactive startup noise before results enter the transcript.
9. **`grep`/`glob` performance**: the HANDOFF records the ripgrep service being a fail-closed stub replaced by an in-process `fff` adapter, with a test timing out at 13.6 s against a 5 s budget. A persistent ripgrep daemon or streaming result cap would restore both correctness and latency.

---

## Appendix: NOT READ (and why)

These directories were only enumerated/spot-sampled, not read file-by-file. They are recorded so the coverage claim above is honest.

| Path | Files / size | Why not read |
|---|---|---|
| `packages/ui/**` | 1,695 files (mostly `src/assets/icons` SVGs, 1,254 SVG total in repo) | Icon/asset library — no agent behavior |
| `packages/app/**` | 633 (SolidStart web UI, e2e, i18n) | Enumerated; sampled `src/components`, `src/pages/session`, e2e specs by name only |
| `packages/console/app/**` | ~577 | Cloud console app; sampled routes list only |
| `packages/desktop/**` | 306 | Electron shell; sampled directory tree and README only |
| `packages/web/**` | 692 | Docs/marketing site content (627 `.mdx`) |
| `packages/stats/**` | 123 | Stats site; not read |
| `packages/storybook/**` | 28 | Storybook config/stories |
| `packages/enterprise/**`, `identity/**`, `function/**`, `containers/**`, `slack/**`, `docs/**`, `script/**`, `cli/**`, `client/**` (21), `http-recorder/**`, `effect-drizzle-sqlite/**`, `effect-sqlite-node/**`, `httpapi-codegen/**`, `server/**`, `sdk-next/**` | ~120 total | Enumerated and spot-sampled; host-relevant glue read where imported by core |
| `packages/tui/src/**` remainder | 309 total; ~90 read/listed | Dialog components were listed by name; `routes/session/*`, `app.tsx`, `component/activity-*` sampled rather than read fully |
| `packages/horizoncode/src/cli/cmd/run/**` | ~40 files | Read file list + `runtime.ts` head; not read line-by-line |
| `kernel/src/host_kernel.rs` | 48,214 lines | Sampled (head, service registries, guard integration points); cannot be read fully in one pass — treat kernel-level claims in this report as interface-level (module + test names), not line-verified internals |
| `kernel/src/managed_control.rs`, `effect_host.rs`, `worker_durable.rs`, `resource_budget.rs`, `resource_sampler.rs`, `terminal_process.rs`, `protocol.rs` | 68,000+ lines combined | Sampled; documented via module docs, test names, and the TS call sites that consume them |
| `kernel/tests/**` (33 files) | — | Enumerated by name; individual test bodies not read |
| `HANDOFF.md` (942 KB), `reports/phases/*.md` (P1–P9, SA7, LEDGER 1,765 lines) | — | Read digest + several dated entries + ledger head; not exhaustively |
| `docs/architecture-archive/**` (≈90 files) | — | Non-operative archive; enumerated only (per `docs/README.md`: "Do not load archived material during normal implementation") |
| `arch_V1/01`–`arch_V1/46` numbered docs (≈55 files) | — | Read `README.md`, `17` references, `46-V1-*` names and the audit/contracts indexes; not every normative body |
| `arch_V1/contracts-v2/**`, `arch_V1/*.json`/`*.jsonl` | ~30 | Listed by name; schemas referenced via the TS consumers that validate against them |
| `bench/**` | 78 files | Enumerated; `bench/fullstack/meterbase*` and `bench/py*/**` read as directory structures + READMEs only |
| `reports/**` (99) | — | Read `phases/LEDGER.md`, `reports/py/RESULTS.md` head, `reports/research/*` names |
| `patches/**` (20 patch files) | — | Listed; content not read |
| `packages/llm/src/protocols/**` | ~20 files | Read file list + schema index; individual protocol adapters not read |
| `.github/**` (38) | — | Enumerated; workflows not read |
| `infra/**`, `nix/**`, `patches/**`, `script/**`, `github/**` | ~45 | Enumerated only |

### Coverage summary

**Read in full (line-by-line):** root `README.md`; `AGENTS.md`; `docs/README.md`; `arch_V1/README.md`; `packages/horizoncode/src/session/prompt.ts` (3,006 lines); `packages/horizoncode/src/session/system.ts` (154); `packages/horizoncode/src/tool/registry.ts` (451); `packages/horizoncode/src/tool/discovery.ts` (197); `packages/core/src/harness-profile.ts` (124); `packages/core/src/session/context-ledger.ts` (164); `packages/core/src/session/context-epoch.ts` (174); `packages/horizoncode/src/provider/UPSTREAM.md`; `kernel/src/lib.rs`; `horizoncode-sandbox/README.md`; `reports/phases/LEDGER.md`; `indexd/src/README.md` (head, 60 lines); `turbo.json`; `.opencode/opencode.jsonc`; `docs/agent-tool-routing.md`; `docs/CAPABILITY-LOCAL-DEV.md`; `docs/repository-root-inventory.md`; `docs/performance/README.md` (head, 75 lines); `docs/reliability/2026-10-29-reliability-program.md` (head, 100 lines); `docs/research/2026-10-21-pi-codex-harness-decisions.md`; `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md` (head, 45 lines); `docs/superpowers/plans/2026-10-25-hostrun-contract.md` (head, 80 lines).

**Read substantially (partial, with the read range noted in-line above):** `packages/horizoncode/src/session/tool-batch.ts` (2,000 of 2,695 lines); `kernel/src/guard.rs` (head); `HANDOFF.md` (digest + several dated entries of a 942 KB file); `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (head); `packages/horizoncode/src/{tool/git.ts,tool/websearch-runtime.ts,tool/code-mode.ts,session/checkpoint-store.ts,config/config.ts}` (heads, 50-70 lines each).

**Enumerated + spot-sampled only:** everything listed in the "NOT READ" table above.

**NOT read at all:** `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `NOTICE` (present at root, not read); the 627 `.mdx` files under `packages/web`; `packages/console`, `packages/desktop`, `packages/stats`, `packages/storybook` app sources; `arch_V1/01`–`arch_V1/45` numbered bodies beyond what is quoted above; `HANDOFF.md` beyond the digest and sampled entries; the 33 `kernel/tests/*.rs` bodies; `docs/architecture-archive/**` bodies.

**Nothing was modified.** No file under the ancestor project (not cloned, path not verified) was written to; `HorizonCode` was never accessed.
