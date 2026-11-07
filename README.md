# HorizonCode (`hzcode`)

**The agent runtime with an execution constitution.**

HorizonCode is a terminal-first coding agent whose *reasoning* is separated from its *authority to act*: a fast TypeScript/Bun runtime runs the agent loop, context, tools and UI, while a supervised **Rust kernel** owns capability admission, policy, leases, sandbox confinement, effects and receipts. It is designed as the **superset of the state of the art** — deliberately merging the best capabilities of OpenCode, Claude Code, Codex, Grok Build, DeepSeek-Reasonix, oh-my-pi and ForgeCode — and then adding capabilities none of them have.

> **Status (2026-11-06, design corpus ratified through RC-15 on 2026-11-07):** the design set (`docs/`) is complete and ratified; **v0.1 of the product is implemented, verified and green** — Rust trust kernel, Bun runtime core, seven tools, chat-first TUI, and a deep test suite (303 TypeScript tests + 20 Rust tests passing; plus the 2026-11-07 trust-hardening pass and NF-072 parallel tool batches). Skills, subagents, Code Mode and preview servers are implemented, tested and green. Live handoff state: [`CURRENT_RUN.md`](./CURRENT_RUN.md) · implemented-vs-designed map: [`docs/28-implementation-status.md`](./docs/28-implementation-status.md) · audits: [`docs/29-final-audit.md`](./docs/29-final-audit.md) (2026-11-06) and [`docs/30-steal-list.md`](./docs/30-steal-list.md) (2026-11-07, adoption wave — RC-15).

## Run it now

```bash
cd /data/home/forge/HorizonCode
./bin/hzcode                          # opens the chat bar (mock model, zero config)
printf 'list files' | ./bin/hzcode    # headless: one message per stdin line
```

Real models: set `HZ_PROVIDER` + `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`), or write `~/.hzcode/config.json` with `provider`, `model` and `apiKey`. Everything is receipted: the Rust kernel hash-chains the event log and issues a receipt per admitted action (`<workspace>/.hzcode/kernel/`).

What exists today (all verified end-to-end by the integrator, not just reported):
- `kernel/` — Rust trust kernel `hz-kernel`: chained event log + receipts, guard (`deny > ask > allow` per [`docs/11-authority-safety.md`](./docs/11-authority-safety.md) R1; leases, `policy.json`; shipped divergence tracked in `docs/28` §4), NDJSON stdio protocol (8 methods); `cargo test` 17 integration + 3 unit green.
- `app/src/core/` — runtime: kernel client (`trusted`) with byte-identical TS fallback (`untrusted`), SQLite sessions, Anthropic/OpenAI/mock providers, agent loop (stream → guard → approve → tool → receipt → events).
- `app/src/tools/` — `read`, `write`, `edit`, `grep`, `glob`, `shell`, `todo` (the base seven) plus `agent` (subagent delegation), `code_mode` (JS subprocess over the NDJSON tool bridge) and `preview` (dev-server lifecycle) — all guard- and approval-aware.
- `app/src/tui/` + `app/src/main.ts` — chat-first UI: streaming chat bar, tool cards, y/n/a approvals, history, headless mode; `bin/hzcode` launcher.
- `app/tests/` — 303 passing tests across core (incl. skills, subagents, code mode, preview, tool batches), tools, providers and TUI (incl. real PTY scenarios); run `cd app && /home/forge/.bun/bin/bun test`.

Architecture note: [`app/src/contracts.ts`](./app/src/contracts.ts) is the frozen interface both implementations compile against — event and receipt hashes interop between Rust and TypeScript byte-for-byte.

---

## 1. What it is, in one page

| | |
|---|---|
| **Binary** | `hzcode` (aliases `hz`, `horizon`) |
| **Product name** | HorizonCode |
| **Primary surface** | Terminal chat-first TUI (streaming inline chat bar; fullscreen alt-screen planned) |
| **Secondary surfaces** | Headless/print · HTTP+SSE server · Web app · Desktop (Electron) · IDE bridge (ACP + VS Code/JetBrains) · MCP server · SDKs (TS, Python, Go, Rust) |
| **Runtimes** | TypeScript on **Bun** (interaction, orchestration, cognition) + **Rust** (authority kernel, native capabilities) |
| **Storage** | Event-sourced SQLite (durable log + projections) + JSONL transcripts + content-addressed blob/artifact store |
| **Model access** | 300+ models via `models.dev` + native protocol codecs + local servers (Ollama, LM Studio, vLLM, llama.cpp) |
| **License** | MIT (first-party), upstream notices preserved |

---

## 2. The one idea that makes it different

> Most agents ask the model what it wants to do, then do it.
> **HorizonCode separates the agent's reasoning from the authority to act.**

The model can *request* an action; only the kernel can *authorise* it. Every admitted effect settles into a durable **receipt**, and anything that cannot be proven settled terminates as an explicit **`UNKNOWN`** that is reconciled rather than blindly retried. A run is therefore **auditable instead of believable**: the receipt chain replays and verifies today (`log.verify` / `receipt.verify` in the kernel protocol, hash-chained in `kernel/`), and the designed `hzcode session verify <id>` adds the independent-evidence gate on top (docs 14/16; DESIGNED) — the question is what is *proven*, not what the model said.

---

## 3. Capability summary

### 3.1 Agent runtime
- **One Controller, every front-end** — one transport-agnostic `Controller` owns the run loop and session lifecycle; TUI, headless, server, web, desktop, IDE and SDKs all drive it. A CI **parity ratchet** fails any front-end-specific behaviour.
- **Event-sourced session core** — every fact is a durable event; projections (messages, inbox, claims, stats) fold from the log; sessions survive crash, restart and eviction.
- **Write-ahead execution claims** — the busy period claims before work begins and clears only on a terminal outcome, so interrupted runs are resumable, never ambiguous.
- **One `llm.stream` per step** — each step reloads history and issues exactly one provider stream call; no hidden in-memory tool loop.
- **Prompt admission precedes execution** — input is admitted to a durable inbox (`steer` / `queue`) before the model is engaged.
- **Dual-model Planner / Executor** — optionally plan in a read-only session; a deterministic host policy (no classifier guessing) routes `executor-only · light · full · plan-for-approval · plan-only`, with planner and executor prefixes never mixed.
- **Subagent fleet** — `task`, `fleet`, `parallel_tasks`, `read_only_task` with a dependency graph, concurrency ceilings, depth limits, **capability grants** and context capsules; child construction funnels through one primitive guarded by a boundary test.
- **Budgets and leases** — token, wall-clock, step, triage, web-search and cost budgets scoped per root run and inherited; adaptive progress leases renew only on real progress.
- **Goals, plans, todos** — state machines with plan-mode gating and an approved-plan execution window.
- **Self-improvement loop** — human-gated (see §3.9).

### 3.2 Tools — the catalog in [`docs/09-tools.md`](./docs/09-tools.md) §4 (authoritative), every one typed
- **Files:** `read`, `read_many`, `write`, `edit`, `multi_edit`, `patch`, `apply_patch`, `notebook_edit`, `delete_range`, `delete_symbol`, `move`, `undo`, `attach`, `snapshot`, `rewind`.
- **Search & navigation:** `glob`, `grep`, `find`, `ast_grep`, `ast_edit`, `symbols`, `references`, `definitions`, `repo_map`, `code_index`, `outline`.
- **Execution:** `shell` (foreground/background/PTY), `shell_session`, `powershell`, `job`, `repl`, `run_code`, `code_mode` (confined JS/TS over namespaced tools), `container`, `ssh`.
- **Web & media:** `web_fetch`, `web_search`, `web_image`, `browse`, `computer`, `view_image`, `read_video`, `generate_image`, `tts`, `stt`, `chart`.
- **Memory & context:** `memory_recall`, `memory_retain`, `memory_edit`, `memory_reflect`, `context_notes`, `new_context`, `compress`, `history_search`, `learn`, `skill_manage`, `todo`, `complete_step`, `update_goal`.
- **Agent & orchestration:** `task`, `fleet`, `parallel_tasks`, `read_only_task`, `team_create`, `team_delete`, `send_message`, `wait`, `yield`, `plan_enter`, `plan_exit`, `brief`, `ask_user`.
- **Integrations:** `lsp` (14+ ops), `debug` (DAP, 28+ ops), `mcp` (tools/resources/prompts), `tool_search` (deferred discovery), `github`, `gitlab`, `schedule`, `remote_trigger`, `workflow` (Rhai), `artifact_*`, `config`, `setting`.
- **Verification:** `verify`, `run_tests`, `lint`, `typecheck`, `security_scan`, `review`, `budget_report`.
- **Every tool declares:** JSON-schema input/output, read-only class, concurrency class, permission requirements, **capability ID**, effect class, UI renderers and idempotency semantics. Nothing is a blind string exec.

### 3.3 Cognition — models, context, memory
- **Providers:** `models.dev` catalog + native protocol codecs (OpenAI chat/responses, Anthropic messages, Gemini, Bedrock converse/event-stream, Vertex, Cohere, Mistral, xAI, Groq, DeepSeek, Qwen, OpenRouter, Together, Fireworks, Cloudflare, GitHub Copilot, GitLab Duo, Cursor agent, Azure, Ollama, LM Studio, vLLM, llama.cpp, Apple Foundation Models, plus an OpenAI-compatible fallback). **Vendor endpoints are config, not code.**
- **Cache-first context compiler:** byte-stable prefix (system prompt + tool schemas + declared config) and a projected turn tail (memory, skills index, goal/plan, retrievals). A CI **cache-guard** test fails on prefix drift.
- **Reasoning control:** per-model thinking levels, effort mapping, reasoning budgets, interleaved thinking.
- **Memory:** four tiers — working, episodic (retrieval over past sessions), semantic (curated facts with provenance), team (shared/syncable) — with extraction, reflection and consolidation.
- **Compaction:** multi-strategy (summary, structured digest, verbatim tail, **snapcompact** vision-frame compression) with a single automatic trigger ratio and a rare explicit provider-visible checkpoint.
- **Retrieval:** BM25 + embeddings + symbol/reference index + repo map, all local-first.
- **Media:** images, PDFs, video, audio (STT/TTS), diagrams (out-of-process Mermaid), charts.

### 3.4 Authority, safety and trust
- **Rust kernel (`hzk`)** — capability registry, `Guard.authorize()`, one-use leases, `EffectHost`, receipts, reconciliation, OwnerLog, resource budgets, cgroup v2 accounting, worktree pool, supervisor leases.
- **Origin-typed effects** — `SessionBatch`, `UserAction`, `ManagedRun`, `ManagedRoot`; a model-originated batch can never present itself as human authority.
- **Policy-as-code** — wildcard rule DSL (`Shell(git *)`, `Edit(src/**)`) plus a Starlark prefix engine for command decisions; precedence `deny > ask > allow`.
- **Postures** — `allow` / `ask` / `deny` (full-access / workspace-write + on-request / read-only), **enforced by the kernel, not by prompt text**.
- **Sandbox matrix** — Linux (Landlock + bubblewrap + seccomp + namespaces), macOS (Seatbelt), Windows (write-restricted token / AppContainer / job objects); per-dimension guarantee vectors with **typed residuals** instead of silent degradation.
- **Trusted Host State** — content-addressed, hash-chained records for contracts, evidence bundles and capability rollout.
- **Verification** — independent-evidence gate: claims are checked against host receipts and can only be **lowered**, never raised.
- **Project-config safety** — workspace files may only *narrow* user config, never widen it; programs named by a workspace stay off until explicitly trusted for that folder.

### 3.5 Sessions, state and time travel
- Event log + projections; branch / fork / resume / archive / delete.
- Checkpoints and **rewind by turn**; workspace snapshots; **rollout replay** (time-travel debugger).
- Worktree pool and per-task isolation; snapshot-based revert.
- Usage, cost and currency accounting across the whole session tree.

### 3.6 Interface surfaces
- **TUI** — fullscreen alt-screen, mouse-interactive (click-to-focus, scrollbars, drag-select), inline/scrollback fallback, command palette, slash commands, diff viewer, session picker, themeable, keybindable, accessible.
- **Headless** — `run`, `exec`, `print`, JSON/JSONL output for CI.
- **Server protocol** — versioned JSON-RPC over stdio/UDS/TCP + HTTP/SSE + WebSocket; **code-generated** clients and schemas.
- **Web app** and **Desktop** — thin clients of the same protocol (sessions, diffs, terminal panes, approvals, collaboration).
- **IDE bridge** — ACP plus a JWT-authenticated bridge with session replay; VS Code and JetBrains.
- **MCP** — client **and** server (expose HorizonCode's tools to other agents), with OAuth and deferred tool discovery.
- **Collaboration** — shared live sessions, presence, share links, team memory.
- **Voice** — streaming STT/TTS for hands-free operation.

### 3.7 Extensibility
- **Plugins** with a signed manifest, sandboxed host, capability declarations and a marketplace; can contribute tools, commands, agents, skills, providers, integrations and UI.
- **Skills** — Markdown workflows with front-matter, `runAs: subagent`, lock/update, marketplace, and synthesis (`skillify`).
- **Commands and hooks** — user-facing slash commands and lifecycle hooks (pre/post tool, prompt, session, commit).
- **Workflow engine (Rhai)** — declarative multi-agent orchestration through a host channel.
- **Custom agents** — named agent profiles (act / plan / research / custom) with tool allow-lists.
- **Self-hosting config** — the repo carries its own `.hz/` agent config.

### 3.8 Operations
- **OpenTelemetry** traces/metrics/logs, GenAI semantic conventions, local dashboard.
- **Local-first and offline-capable**; BYO keys; air-gapped mode.
- **Remote execution** — SSH/SFTP/WSL/containers; multi-machine fleets; remote sandboxes.
- **Enterprise** — managed policy, MDM, SSO, audit export, quota/rate-limit policy, bring-your-own-cloud.
- **Security** — secret vault with redaction, egress control, network proxy, opt-in crash reports, supply-chain pinning.
- **Distribution** — single static binary; npm/brew/apt/scoop/nix/docker; auto-update with digest pinning; signed releases with debug sidecars.

### 3.9 Self-improvement (human-gated)
- **Trajectory capture** of every run (events + receipts) as the evidence substrate.
- **Evals harness** with regression gates and benchmark suites (SWE-bench-style, repo-specific, task catalogs).
- **Memory distillation** — episodic → semantic, with provenance and review.
- **Skill synthesis** — turn a successful workflow into a reusable skill, then verify it in the evals harness before it is offered.
- **Policy and prompt tuning** — candidate prompt/policy variants evaluated A/B under the cache-guard discipline.
- **Background “dream” consolidation** — scheduled reflection that proposes improvements, never applies them.
- **Hard rule:** self-improvement may propose changes to memory, skills, prompts and *routing* — it may **never widen authority**; every code or policy change lands as a reviewable proposal gated by receipts and human approval.

---

## 4. The superset, explicitly

| Capability family | Inherited strength | Our addition |
|---|---|---|
| Separate execution authority + receipts | HorizonCode (kernel / Guard / effects) | Universal receipts for *every* mutation, `UNKNOWN` reconciliation, origin-typed effects, capability-ID registry |
| Event-sourced core, one stream per step | OpenCode | Write-ahead claims + admission inbox + parity ratchet |
| Deep OS sandbox + policy DSL | Codex | Guarantee vectors with typed residuals + Trusted Host State |
| Fullscreen mouse TUI + leader/replay | Grok Build | Inline fallback + front-end parity + shared leader across all surfaces |
| One controller, four front-ends, ratchet linter | Reasonix | Extended to eight surfaces incl. web, desktop, MCP server and SDKs |
| Native capability stack (shell/VFS/edit/diff/VCS/AST) | oh-my-pi | Unified native crate set + conflict-aware edit engine |
| Clean architecture + compile-time tool specs | ForgeCode | Plus schema-validated runtime tools and capability IDs |
| ~40 tools, skills, coordinator, bridge, dream | Claude Code | Superset tool catalog + planner/executor + authority kernel |
| — (new) | — | **Execution constitution, evidence gate, self-improvement proposals, `hz://` resource space, workflow engine, team memory, time-travel replay** |

---

## 5. Decisions already made

1. **Terminal-first, protocol-first.** The TUI is the product; the protocol is the API. Web, desktop and IDE clients are thin front-ends over the same Controller. Rationale and trade-offs in [`docs/02-decisions.md`](./docs/02-decisions.md).
2. **TypeScript/Bun + Rust hybrid.** Interaction/orchestration/cognition in TS for velocity and the React/Ink-style TUI; authority and native capabilities in Rust for safety and speed.
3. **Event-sourced storage.** Durable log + projections; no mutable state of record.
4. **Kernel-enforced policy.** Permissions are never prompt text.
5. **Self-improvement never widens authority.**

---

## 6. Documentation set

Start at [`docs/00-index.md`](./docs/00-index.md). The set covers vision, competitive synthesis, decisions, HLD, LLD, domain model, schemas, events, flows, APIs, contracts, runtime, tools, providers, context/memory, authority/safety, sessions/state, TUI, web/desktop/IDE, extensibility, self-improvement, observability, performance, packaging, the final feature catalog, roadmap and glossary — plus the **second learning synthesis** ([`docs/26-learning-synthesis-2.md`](./docs/26-learning-synthesis-2.md), the ten-repo deep-dive record) and the **implementation plan** ([`docs/27-implementation-plan.md`](./docs/27-implementation-plan.md), with the runtime-viability results). A post-writing audit of the set — traceability, consistency, parity and technical hole-hunt — is in [`AUDIT.md`](./AUDIT.md). Implementation state: [`docs/28-implementation-status.md`](./docs/28-implementation-status.md); live handoff and exact continuation steps: [`CURRENT_RUN.md`](./CURRENT_RUN.md).

---

## 7. Non-goals

- Not a chat app: every capability exists to change a repository and prove it.
- Not a hosted service by default: local-first, BYO keys; hosting is optional (enterprise).
- Not a model: HorizonCode is the harness, and stays model-agnostic.
- Not a silent auto-improver: self-modification is proposed, reviewed and receipted.
