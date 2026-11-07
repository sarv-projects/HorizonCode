# Hermes Agent — Deep-Dive Audit Report

**Repo:** `/data/home/forge/repo-tour/hermes-agent` (NousResearch/hermes-agent)
**Tagline:** "The self-improving AI agent built by Nous Research" / "The agent that grows with you"
**Audit date:** 2026-11-07 · **Report-only — nothing in the repo was modified.**
**Frame:** reference implementation of a *Managed VPS Loop* agent: it runs persistently in a managed
environment instead of streaming every local filesystem diff, giving near-zero lag and excellent
cost-to-success.

---

## 0. What this repo is + coverage stats

### 0.1 Identity

Hermes Agent is a **personal AI agent with one shared agent core** (`AIAgent`) exposed through five
surfaces: a CLI/REPL + TUI (`cli.py`, `ui-tui/`, `tui_gateway/`), a long-running messaging **gateway**
(~25 chat platforms), an **Electron desktop app** (`apps/desktop/`), a **web dashboard** (`web/`), and
an **ACP stdio/JSON-RPC adapter** for VS Code / Zed / JetBrains (`acp_adapter/`). It is deliberately
designed to run *away from your laptop* — a $5 VPS, a GPU cluster, Modal/Daytona/Vercel serverless
sandboxes — and to be reachable from Telegram while it works.

Self-declared repo-wide invariants (root `AGENTS.md`):

1. **Per-conversation prompt caching is sacred.** Past context is never mutated mid-conversation;
   the *single* sanctioned exception is context compression. Anything needing to inject content
   mid-conversation rides a **user message or tool result**, never the system prompt.
2. **The core is a narrow waist; capability lives at the edges.** Every model tool is sent on every
   API call, so the bar for a new *core* tool is high; new capability arrives as CLI command + skill,
   service-gated tool, or plugin.

A third structural invariant shapes the whole tree: **facade + siblings**. Every former god-file is a
thin facade plus `<stem>_<topic>.py` siblings, one topic each, with per-unit complexity ratchets
(`scripts/code_health/config.py`: functions CC ≤ 20 / ≤ 300 lines, nesting ≤ 6; files ≤ 2,000 lines).
This is why there are 73 `hermes_state_*.py` siblings, 33 `agent/turn_*.py` phase files, 46
`gateway/run_*.py` phases and ~130 `gateway/session_*.py` modules.

### 0.2 Coverage stats

| Metric | Value |
|---|---|
| Total files (excl. `.git`) | 22,752 (22,782 incl. `.git`) |
| On-disk size | 353 MB |
| Directories (excl. `.git`) | 1,209 |
| Python files | 10,889 |
| TypeScript/TSX files | 5,500 |
| Markdown docs | 1,545 |
| Git history | **shallow clone — 1 commit** (`d4e7c343`, 2026-11-07 01:33:46 -0500) |
| Directories walked / enumerated | **all 1,209** |
| Files enumerated (full path list) | **all 22,752** |
| Files opened & read in full | 21 |
| Files read in part (head/range) | 14 |
| Largest observed sources | `plugins/platforms/telegram/adapter.py` (433 KB), `agent/auxiliary_client.py` (426 KB), `agent/context_compressor.py` (324 KB), `gateway/platforms/base.py` (270 KB), `gateway/run.py` (267 KB) |

> **Git-log caveat.** `git log --oneline -10` returns exactly one commit: the checkout is a
> `--depth=1` snapshot of `origin/main`. History-derived evidence (`git log -p -S`), authored-PR
> archaeology, and the repo's "proven red on the base" test claims are *not* verifiable here.
> Everything below is grounded in in-tree code, area `AGENTS.md` files and `website/docs/`.

### 0.3 Files read in full (evidence base)

`README.md` · `AGENTS.md` (root) · `agent/AGENTS.md` · `gateway/AGENTS.md` · `cron/AGENTS.md` ·
`skills/AGENTS.md` · `website/docs/developer-guide/agent-loop.md` ·
`website/docs/developer-guide/architecture.md` · `scripts/check_detached_spawns.py` ·
`scripts/check_detached_spawns.py` (lint) · `hermes_cli/process_identity.py` ·
`hermes_cli/process_supervisor.sh` · `agent/managed_worker.py` ·
`gateway/session_managed_worker.py` · `agent/learn_prompt.py` · `agent/background_review.py` ·
`hermes_state_detached_results.py` · `SOUL.md` · `hermes` · `docker-compose.yml` ·
`website/docs/developer-guide/session-storage.md` (L1–170 of 604).

Read in part: `agent/learning_graph.py`, `activate`, `tools/environments/file_sync.py`,
`tools/environments/remote_common.py`, `tools/bot_mode_dm.py`, `gateway/session_detached.py`,
`hermes_state_detached_results.py`, `evals/readtool/README.md`, `docker-compose.windows.yml` (via
compose dir), `agent/AGENTS.md` routing table targets, plus directory listings for ~40 directories.

### 0.4 NOT-READ list (vendored / generated / huge)

| Path | Files / size | Why skipped |
|---|---|---|
| `.git/` | — | object store, not source |
| `tests/` | 7,898 files / 70 MB | test corpus; sampled by name only (contract names, e.g. `tests/gateway/test_stream_final_contract.py`) |
| `apps/` (deep) | 4,939 files / 52 MB | Electron + TS app; enumerated at directory level, entry-point docs read |
| `ui-tui/` | 661 files | TypeScript TUI sources; enumerated only |
| `website/` (build/static) | 791 files / 29 MB | Docusaurus sources + generated output; `docs/developer-guide/` read, rest enumerated |
| `contributors/emails/` | 2,327 files / 1.3 MB | generated contributor data |
| `plugin-catalog/` | 1,066 files / 2.0 MB | third-party plugin index; README-level only |
| `optional-skills/` | 819 files / 13 MB | shipped-but-inactive skill payloads; catalog enumerated, bodies not read |
| `pnpm-lock.yaml` | 464 KB | generated lockfile |
| `uv.lock` | 1.25 MB | generated lockfile |
| `flake.lock` | 3.5 KB | generated lockfile |
| `cli-config.yaml.example` | 132 KB | generated full default config dump; key sections referenced via `hermes_cli/config_defaults.py` |
| `locales/*.yaml` | 35 files / 6.9 MB | generated translation catalogs |
| `assets/`, `*.png`, `*.woff2`, `*.svg` | 133+ binaries | images/fonts |
| Domain-named fixtures (`.com .me .net .org .io .edu .co .ai .dev .tech`, 1,845+ files) | — | test/skill fixture data, not source |
| `native/`, `nix/` internals | 31 files | build packaging; enumerated only |

**No `node_modules/` is present in this checkout** (verified: `find . -type d -name node_modules`
returns nothing), so the dependency tree is not part of the 353 MB.

---

## 1. Complete feature inventory by area

### 1.1 Entry points & CLI

| What | Where |
|---|---|
| Root `hermes` launcher | `hermes` (262 B → `hermes_cli.main:main`) |
| CLI facade: `HermesCLI` REPL + slash dispatch | `cli.py` (82 KB) |
| CLI mixins (slash, config, TUI, render, voice) | `hermes_cli/cli_*_mixin.py` (~40 files) |
| Subcommand entry | `hermes_cli/main.py` + `hermes_cli/subcommands/` (65 files) |
| Slash-command registry | `hermes_cli/commands.py` (`COMMAND_REGISTRY`) |
| Config system / defaults / migration | `hermes_cli/config.py`, `config_defaults.py`, `cli-config.yaml.example` |
| Auth / provider registry / credentials | `hermes_cli/auth.py` + `auth_*.py` |
| Runtime provider → api_mode resolution | `hermes_cli/runtime_provider.py` |
| Model catalog, `/model` switch | `hermes_cli/models.py`, `model_switch.py` |
| Setup wizard | `hermes_cli/setup.py` + `setup_*.py` |
| Themes (`skin_engine`) | `hermes_cli/skin_engine.py` |
| Skills/tools enable-disable per platform | `hermes_cli/skills_config.py`, `tools_config.py` |
| Plugin manager | `hermes_cli/plugins.py` |
| Gateway start/stop/status/service | `hermes_cli/gateway.py` (+ 48 `gateway_*.py` siblings) |
| Web dashboard backend | `hermes_cli/web_server.py` + `web_routers/` (34 files) |
| Kanban CLI | `hermes_cli/kanban.py` + 14 `kanban_*.py` |
| Curator CLI | `hermes_cli/curator.py` |
| Update / doctor / pm | `hermes_cli/update_cmd*.py`, `hermes_cli/dashboard_auth/`, `pm/` |
| Local model runtime (llama.cpp etc.) | `hermes_cli/local_runtime/` (19 files: `catalog`, `gguf`, `hardware`, `supervisor`, `recovery`, ...) |

### 1.2 Agent loop (`agent/`, 356 files)

**Shape.** `run_agent.py` (89 KB) is the public facade; `AIAgent` is assembled from mixins
(`agent/turn_facade.py`, `client_lifecycle.py`, `stream_delivery.py`, `session_persistence.py`,
`compression_facade.py`). Construction runs `agent/agent_init.py::init_agent` (118 KB, ~60 ctor
params). A turn is `agent/conversation_loop.py::run_conversation`, forwarded to by
`AIAgent.run_conversation` after taking the **session turn lease** (`agent/turn_facade_lease.py`).

**The loop** (verbatim from `agent/AGENTS.md`):

```python
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) \
        or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(model=model, messages=messages, tools=tool_schemas)
    if response.tool_calls:
        for tc in response.tool_calls:
            messages.append(tool_result_message(handle_function_call(tc.name, tc.args, task_id)))
        api_call_count += 1
    else:
        return response.content
```

Synchronous, interrupt-checked, budget-tracked, with a one-turn grace call.

**33 turn phases**, one sibling file each: `turn_preflight*`, `turn_iteration_prep`,
`turn_request_assembly`/`turn_api_request`, `turn_api_call`, `turn_api_error`,
`turn_response_intake`/`turn_response_check`, `turn_empty_response`, `turn_tool_round`/
`turn_tool_validation`, `turn_overflow`, `turn_truncation`, `turn_scripted_prelude`,
`turn_context_compaction`, `turn_recovery` (110 KB) + `turn_recovery_autorecover` (post-exhaustion
wait-and-retry ladder) + `turn_recovery_codex`, `turn_retry_state`, `turn_stop_gates`,
`turn_liveness`, `turn_usage`, `turn_final_response`, `turn_finalizer`, `turn_summary`,
`turn_author`, `turn_explainers`, `turn_failure_copy`, `turn_facade`, `turn_facade_lease`,
`turn_context` (77 KB), `turn_loop_errors`.

**Three API modes** (`chat_completions`, `codex_responses`, `anthropic_messages`) converge on one
internal OpenAI-style message format. Resolution order: explicit `api_mode` → provider detection →
base-URL heuristics → default. Adapters: `agent/anthropic_adapter.py` (50 KB),
`agent/codex_responses_adapter.py` (75 KB), `agent/chat_completion_helpers.py` (224 KB).

**Interruptibility.** `_interruptible_api_call()` runs the HTTP call on a background thread while the
main thread waits on {response ready, interrupt event, timeout}. On interrupt the API thread is
abandoned, the response discarded, and **no partial response enters history**.

**Agent-level tools** intercepted before `handle_function_call()` via `INLINE_TOOL_EXECUTORS`
(`agent/inline_tool_executors.py`): `todo`, `memory`, `session_search`, `delegate_task`.

**Budget:** `IterationBudget`, default 500 (`agent.max_turns`); subagents get independent budgets
capped at `delegation.max_iterations` (default 50).

**Message-flow invariants:**
- System prompt **byte-stable** for the life of a conversation.
- **Strict role alternation**; only exception `/steer` (`assistant(tool_calls) → tool → user`).
- Skill slash commands inject as **user messages** (`agent/skill_commands.py`); subdirectory
  `AGENTS.md` hints append to the **tool result**, head+tail truncated past
  `_MAX_HINT_CHARS = 32_000` (`agent/subdirectory_hints.py`).
- `_last_resolved_tool_names` is a process-global in `model_tools.py`; `_run_single_child()`
  saves/restores it around subagents.

### 1.3 Compression & prompt caching

Two layers: **gateway session hygiene** at 85% and the agent `ContextCompressor` at **50%**
(configurable, per-model overrides, failure cooldown after provider-proven overflow).

Algorithm: prune old tool results first (**no LLM call**) → pick boundaries → structured summary via
the `auxiliary` compression model. `compression.protect_last_n` (default 20) preserves the tail;
tool-call/result pairs never split. In-place compaction keeps one stable session id; native
Responses/Codex compaction paths are provider-specific. A stalled summary stream retries once on
`auxiliary.compression.fallback_chain`; a repeated stall ends with a deterministic fallback summary
through the same pipeline.

Files: `agent/context_compressor.py` (330 KB!), `context_compressor_{prellm,prune,summary,tail,telemetry,window,prompt_rules,retry}.py`,
`compression_facade.py`, `compression_marker.py`, `conversation_compression_manual.py` (shared
`compress_now` for CLI/gateway/TUI/ACP), `agent/prompt_caching.py` (Anthropic cache breakpoints +
metrics), plus siblings `hermes_state_compression.py`, `hermes_state_worker_compression.py`,
`trajectory_compressor.py`. Docs also cover **micro-compaction**
(`website/docs/developer-guide/micro-compaction.md`).

### 1.4 Persistent / managed runtime (`gateway/`, 306 `.py`)

| What | Where |
|---|---|
| Facade | `gateway/run.py` + **46** `run_*.py` phases |
| Session authority / admission FIFO | `gateway/session_authority.py`, `session_authorities.py`, `session_admission.py` |
| **Managed worker** execution | `gateway/session_managed_worker.py`, `session_worker*.py` (10 files), `agent/managed_worker.py` |
| Session store | `gateway/session.py`, `session_identity.py`, `session_local*.py` (~130 `session_*.py` total) |
| Delivery | `gateway/delivery.py`, `delivery_ledger` tables |
| DM pairing auth | `gateway/pairing.py` |
| Hooks/observers | `gateway/hooks.py` |
| Cross-session mirroring | `gateway/mirror.py` |
| Token locks + profile-scoped process tracking | `gateway/status.py` |
| Core ingress adapters | `gateway/platforms/` (`api_server`, `webhook`, `msgraph_webhook`) |
| Bundled platform plugins | `plugins/platforms/` — telegram, discord, slack, whatsapp(_cloud), matrix, mattermost, email, sms, dingtalk, feishu, wecom, irc, line, teams, google_chat, buzz, ntfy, photon, raft, simplex, signal, weixin, bluebubbles, qqbot (+ homeassistant, yuanbao) |
| Relay (multi-tenant fronting) | `gateway/relay/` (13 files) |
| Restart / shutdown forensics | `gateway/restart.py`, `shutdown_forensics.py` |
| Desktop control plane | `hermes serve` (dies with app) vs `gateway run` (**survives**, spawned detached) |

### 1.5 Scheduling / cron (`cron/`, 52 files)

| What | Where |
|---|---|
| Job store (JSON) | `cron/jobs.py` + `jobs_time.py`, `job_definition.py`, `jobs_invariants.py` |
| Tick loop | `cron/scheduler.py` + ~25 `scheduler_*.py` |
| Schedule formats | duration (`30m`), "every" phrase (`every monday 9am`), 5-field cron, ISO one-shot |
| Per-job fields | `skills`, `model`/`provider`, `script`, `no_agent`, `context_from`, `workdir`, `timezone`, `grace_minutes`, multi-platform delivery |
| Occurrence accounting | `cron/occurrences.py`, `executions.py`, `extra_fire.py`, `missed_runs.py` |
| Catch-up | half the period clamped 120s–2h, or `grace_minutes` (`0` = never catch up) |
| Inactivity watchdog | idle-based (`HERMES_CRON_TIMEOUT`, default 600s), *not* wall-clock |
| Multi-profile ticker | `scheduler_provider.py::_start_multiplex`, `scheduler_thread.py::SupervisedTickerThread` |
| Headless mode | `hermes cron tick` → `tick(headless=True)`; **headless refuses, never spawns** a daemon |
| Kanban (multi-agent queue) | `hermes_cli/kanban*.py`, `tools/kanban_tools.py`, `plugins/kanban/systemd/hermes-kanban-dispatcher.service` |
| Pre-run data scripts | `scheduler_script.py` — always a FILE under `HERMES_HOME/scripts/`, never a command line |

### 1.6 Memory structures

| What | Where |
|---|---|
| Memory provider ABC | `agent/memory_provider.py` |
| Orchestrator | `agent/memory_manager.py` (+`_tools.py`, `agent/memory_context.py`, `memory_caller_scope.py`) |
| Provider plugins | `plugins/memory/` |
| Markdown stores | `MEMORY.md` (environment facts) / `USER.md` (who the user is) |
| Session DB | `hermes_state.py` facade + **73** `hermes_state_*.py` siblings |
| FTS5 search | `hermes_state_fts.py` (content/trigram/cjk tokenizers), `hermes_state_search.py` (89 KB) |
| `session_search` tool | `tools/session_search_tool.py` (inline executor) |
| Honcho dialectic user modeling | `website/docs/user-guide/features/honcho.md` (external integration) |
| Pluggable context engines | `agent/context_engine.py` + `plugins/context_engine/` |
| Skill usage telemetry | `tools/skill_usage.py` → `~/.hermes/skills/.usage.json` |
| Detached (between-turn) results | `hermes_state_detached_results.py`, `agent/detached_results*` |

### 1.7 Skills & the growth loop

| What | Where |
|---|---|
| Bundled skills | `skills/` (307 files, 3.3 MB) by category (`skills/github/`, `skills/mlops/`) |
| Optional (inactive) skills | `optional-skills/` (819 files) — 14 categories |
| Skills Hub (install/search) | `tools/skills_hub*.py` (13 files), `hermes_cli/skills_hub.py` |
| Skill authoring standard (hardline, test-enforced) | `skills/AGENTS.md`, `tests/skills/test_authoring_standards.py` |
| Skill lifecycle curator | `agent/curator.py`, `curator_backup.py`, `hermes_cli/curator.py` |
| Skill management tool | `tools/skill_manager_tool.py` + `skill_manager_batch/guards.py`, `skill_lock.py`, `skill_linter.py`, `skills_guard.py`, `skills_ast_audit.py`, `skill_provenance.py` |
| `/learn` skill authoring prompt | `agent/learn_prompt.py` |
| Learning graph (desktop view of growth) | `agent/learning_graph.py`, `learning_graph_render.py`, `learning_mutations.py` |
| agentskills.io standard compatibility | `skills/` frontmatter + `skill_manage` |

### 1.8 Tools (`tools/`, 382 files; 70+ registered across ~28 toolsets)

Terminal orchestration (`terminal_tool.py` + 11 `terminal_tool_*.py`), process registry (12
`process_registry_*.py`), files (`file_tools.py`, `file_operations*.py`, `file_tools_*`), search,
web (`web_tools*.py`), browser (large family: `browser_tool.py`, `browser_supervisor*.py`,
`browser_session*.py`, `browser_launcher*.py`, `browser_use_cli.py`, `browser_vault*.py`,
`browser_cdp_tool.py`, `browser_dialog_tool.py`, `browser_lightpanda.py`),
`code_execution_tool.py` + `code_kernel.py`/`code_kernel_remote.py`,
`delegate_tool*.py` (18 files), MCP (`mcp_tool.py` + ~25 siblings: OAuth, sampling, health,
schema cache, costs, node ABI, transport), vision, image/video generation, TTS/STT (~20 files),
`clarify_tool.py` (+ batch/gateway), `todo_tool.py`, `memory_tool.py`, `session_search_tool.py`,
`cronjob_tools.py`, `kanban_tools.py` (+`_schemas`, `toolset_context`), `computer_use_tool.py`,
checkpoints/undo (`checkpoint_manager*.py`, `checkpoint_undo_hint.py`), approvals (`approval*.py`,
10 files), `bot_mode*` (12 files), `connectors/` (34), `computer_use/` (13), `bot_desktop/` (11),
desktop UI tools (`desktop_ui.py`, `focus_pane_tool.py`, `annotate_preview_tool.py`),
`tool_search.py` (deferred tool loading), `skills_tool.py`, `project_tools.py`, `tour_tool.py`,
`tip_tool.py`, `working_diff.py`.

**Terminal backends** (`tools/environments/`, 22 files): `local.py`, `docker.py`, `ssh.py`,
`modal.py`, `daytona.py`, `vercel_sandbox.py`, `managed_modal.py`, over a shared `base.py`,
`base_session_env.py`, `base_wait.py`, `streams.py`, `file_sync.py`, `remote_common.py`, plus plugin
backends (Singularity/Apptainer).

**Toolsets** (`toolsets.py`, 27 KB): `TOOLSETS`, `_HERMES_CORE_TOOLS`, ~28 toolsets, platform presets
(Telegram → `messaging`), `toolset_distributions.py` for profiles.

### 1.9 Prompts / templates

| What | Where |
|---|---|
| Tiered assembly (`stable` → `context` → `volatile`) | `agent/system_prompt.py`, `agent/prompt_builder.py` |
| Context files (AGENTS.md/CLAUDE.md) | `prompt_builder.py`, `context_file_sources.py`, `subdirectory_hints.py` |
| Context pinning | `agent/context_pin.py`, `context_default_record.py`, `context_references.py` |
| Personality / `SOUL.md` | `SOUL.md`, `/personality` |
| Ephemeral prompt layers | budget warnings, context pressure (injected per call, not cached) |
| Docs | `website/docs/developer-guide/prompt-assembly.md` |

### 1.10 Evals (`evals/`, 41 suites, 236 files)

`compaction`, `native_compaction`, `codebase_navigability`, `readtool` (full A/B harness: hostile
fixtures, accuracy/api_turns/tool_calls/tokens/wall_s metrics), `tool_search`, `core_tool_deferral`,
`token_accounting`, `provider_fallback`, `provider_wire`, `providers`, `reasoning_replay`,
`prefix_rediet`, `prompt_footprint`, `liveness`, `gateway`, `gateway_completion`,
`gateway_failure_ownership`, `gateway_status_render`, `shared_gateway`, `subagent_process_handoff`,
`delegation_group_schema`, `session_search_schema`, `update_pipeline`, `update_streaming`,
`postmortem`, `desktop_bug_campaign`, `desktop_gateway_ticket_native`, `desktop_mcp_oauth`,
`plugin_isolation`, `dashboard_auth`, `webhook_auth`, `hosted_attachment_transfer`,
`botmode-dm-delivery`, `botmode-dm-matrix`, `browser_use`, `codex_echo`, `openrouter_pkce_ab`,
`toolperf_abeval`, `desktop-pane-fixture`.

### 1.11 Apps

| What | Where |
|---|---|
| Desktop app (Electron) | `apps/desktop/` (+ `apps/desktop/src/AGENTS.md`) — `serve` backend, slash palette, Bot Mode |
| Bootstrap installer | `apps/bootstrap-installer/` |
| Shared TS packages | `apps/shared/` (`src/i18n.ts`, nanostores) |
| Web dashboard | `web/` + `hermes_cli/web_routers/` — embeds the real TUI |
| TUI | `ui-tui/` (661 files) |
| TUI JSON-RPC gateway | `tui_gateway/` (127 files + `contracts/`) |

### 1.12 Deployment

| What | Where |
|---|---|
| Main Dockerfile | `Dockerfile` (35 KB) |
| Compose (linux/mac) | `docker-compose.yml` — s6-overlay `/init` PID 1, `gateway run` + `dashboard` services, UID/GID remap |
| Compose (windows) | `docker-compose.windows.yml` |
| s6 service definitions | `docker/s6-rc.d/`: `main-hermes`, `dashboard`, `profile-gateways`, `user` |
| Entrypoint/init | `docker/cont-init.d/` (`015-supervise-perms`, `02-reconcile-profiles`), `entrypoint.sh`, `main-wrapper.sh`, `tini-shim.sh` |
| Nix flake + modules | `flake.nix`, `flake.lock`, `nix/` (26 files) |
| Activation scripts | `activate`, `activate.fish`, `activate.ps1` (+ `scripts/_activation.sh`) |
| Installers | `setup-hermes.sh`, `setup-hermes.ps1` |
| Bootstrap / watchdog | `hermes_bootstrap.py` (29 KB), `hermes_startup_watchdog.py` |
| PM (package-manager ownership) | `pm/` (63 files), `pnpm-workspace.yaml` |

### 1.13 Editor integration

| What | Where |
|---|---|
| ACP adapter (stdio JSON-RPC) | `acp_adapter/` (22 files: `server.py`, `session.py`, `tools.py`, `permissions.py`, `elicitation.py`, `edit_approval.py`, `provenance.py`, ...) |
| ACP client (Hermes driving other agents) | `agent/acp_client.py`, `agent/acp_openai_bridge.py` |
| LSP | `agent/lsp/` (14 files) |
| Docs | `website/docs/developer-guide/acp-internals.md` |

---

## 2. Common patterns shared with typical coding agents

These are table stakes — Hermes does them, but they are not what makes it interesting:

| Pattern | Hermes implementation |
|---|---|
| Single `AIAgent` core, multiple front-ends | `run_agent.py` facade used by CLI, gateway, ACP, cron, batch, API server |
| ReAct-style tool loop with a max-iteration budget | `agent/conversation_loop.py`; `IterationBudget` (500) |
| OpenAI-format internal message history | `{"role", "content", "tool_calls"}`; reasoning in `assistant_msg["reasoning"]` |
| Read/write/patch/search file tools | `tools/file_tools.py`, `file_operations*.py` |
| Shell tool with background processes | `tools/terminal_tool.py`, `process_registry*.py` |
| Approval prompts for dangerous commands | `tools/approval*.py` (10 files) |
| Subagent delegation with isolated context | `tools/delegate_tool*.py` (18 files) |
| MCP client support | `tools/mcp_tool*.py` (~25 files), `optional-mcps/` (68 dirs) |
| Context compaction / summarization | `agent/context_compressor.py` + 8 siblings |
| System prompt from project context files | `AGENTS.md` / `CLAUDE.md` loading in `prompt_builder.py` |
| Todo list tool | `tools/todo_tool.py` |
| Skills as procedural memory | `skills/`, `skill_view`, `skill_manage` |
| Session persistence + resume | SQLite `state.db`, `/resume`, `hermes chat --resume` |
| Model/provider abstraction with fallbacks | `hermes_cli/runtime_provider.py`, `fallback_providers`, credential pools |
| Streaming token delivery + callbacks | 8 callback surfaces (`tool_progress`, `reasoning`, `stream_delta`, ...) |
| Checkpoint / undo | `tools/checkpoint_manager*.py` |
| Sandboxed code execution | `tools/code_execution_tool.py`, `code_kernel.py` |
| Browser automation | `tools/browser_*.py` (20+ files) |

---

## 3. UNIQUE capabilities

Each entry: what it is, the evidence path, and one line on why it matters.

### 3.1 The managed persistent loop

**U1 — Durable session authority with a per-session input FIFO.**
`website/docs/developer-guide/session-storage.md#L122-L158` — the SQLite schema carries
`runtime_epoch` (session authority's owner epoch + instance id), `session_admissions` (durable
per-session input FIFO: `queued → started → terminal`, `unknown` on owner loss), `worker_executions`
and `worker_receipts` (ordered, digest-checked worker results), with `ON DELETE RESTRICT` and no
replay of a `started`-then-orphaned input.
*Why:* input survives process death with exactly-once-ish semantics, and "unknown" is a real state
instead of a silent duplicate or a lost message.

**U2 — The owner/worker split: turns run out-of-process as *managed workers*.**
`gateway/session_managed_worker.py` spawns `[sys.executable, '-m', 'agent.managed_worker']`
(`session_managed_worker.py#L596`), the child introduces itself with `hello()` (pid + birth +
ancestor chain, `agent/managed_worker.py#L443-L450`), and the owner **verifies that identity before
reserving** (`reserve_admission_worker`, `session_managed_worker.py#L682`). The bootstrap frame
carries a closed field set including a `scope` of `profile_id, session_id, execution_id,
generation, pid, birth, secret, epoch` (`agent/managed_worker.py#L110-L127`), and a stale epoch is a
hard error (`agent/managed_worker.py#L339`).
*Why:* a turn can crash, be killed, or be replaced without corrupting the session — and the owner
can prove which process it is talking to, defeating PID reuse and launcher trampolines.

**U3 — One turn per process, and the owner reads frames, not a filesystem.**
The gateway pushes `delta`, `tool.start`, `tool.complete`, `approval`, `clarify`, `result`,
`finished` frames over a pipe (`gateway/session_managed_worker.py#L691-L729`), publishing them into
the session's event stream. The UI sees a bounded event stream rather than a diff channel.
*Why:* this is the structural reason the loop is "near-zero lag" — the transport is a control pipe
plus an event stream, not a synced local filesystem view.

**U4 — Unknown is a first-class outcome that halts the FIFO.**
`ManagedExecutionUnknown` (`session_managed_worker.py#L36-L37`), `_settle_lost`
(`#L568-L582`), and the committed-unknown publish (`#L742-L755`). An input that was `started` when
its owner died becomes `unknown` and is **never replayed**; its later inputs wait until resolved
(`session-storage.md#L144-L148`).
*Why:* the honest failure mode — better a stall than a silently duplicated side effect.

**U5 — Workers die with their owner; orphans are reaped, not leaked.**
POSIX: one `process_supervisor.sh` per Hermes process holds the read end of a pipe whose write end
Hermes holds; EOF (death by *any* cause, incl. SIGKILL/OOM) ⇒ `killpg` every registered group
(`hermes_cli/process_identity.py#L816-L845`, `hermes_cli/process_supervisor.sh#L23-L55`). Written in
POSIX `sh` rather than Python because an idle `sh` costs ~0.5 MB USS vs ~8 MB for an interpreter
(`process_supervisor.sh#L13-L15`).
*Why:* the classic persistent-agent failure is the orphaned child holding locks forever; this makes
it structurally impossible.

**U6 — Process identity that survives clock steps, VM resume and PID reuse.**
Four layers: `HERMES_SPAWN` spawn tags, a machine-wide `spawn-ledger.json` of `(pid, create_time)`,
Windows job-object self-attach with `KILL_ON_JOB_CLOSE`, and the POSIX supervisor
(`process_identity.py#L1-L11`). Boot-relative births (`boot_start`) compare **exactly** within a boot
because epoch `create_time()` moves under NTP/sleep-wake (`#L107-L119`, `#L141-L156`); macOS psutil's
`create_time` is boot-time-relative and is replaced with `monotonic=True` (`#L69-L89`); Linux/WSL2
re-anchors `btime` after host sleep, so `worker_birth` uses monotonic too (`#L92-L104`).
*Why:* every one of these was a real, filed bug; the fix set is the most transferable part of the
repo for anyone running agents across suspend/resume laptops and VMs.

**U7 — A lint check that enforces the process-lifecycle rule.**
`scripts/check_detached_spawns.py` AST-scans the production trees and fails CI on any
`start_new_session=True`, `process_group=`, `os.setsid/setpgid/setpgrp`, or detaching helper call
outside `hermes_cli/process_identity.py`, with an opt-out marker that **requires a reason**
(`detached-spawn: ok — <why>`, `#L111-L118`) and an empty `_BASELINE` (`#L159-L162`).
*Why:* turns a hard-won invariant into a mechanical guarantee — architecture enforced by a test, not
by reviewer memory.

**U8 — Profile multiplexing: one process, many isolated identities.**
`gateway/session_identity.py::resolve_identity` answers "which bot received it / who may admit it /
where does it run" ONCE per inbound event and pins a frozen `RoutingIdentity` on the source
(`gateway/AGENTS.md#L90-L113`); `transport_profile ≠ runtime_profile` is normal. Every env read goes
through a scope that **fails closed to the default, never `os.environ`**, because under multiplex
`os.environ` holds the *launch* profile's values (`gateway/AGENTS.md#L147-L163`).
*Why:* the single most common multi-tenant agent bug is a leaked credential scope; Hermes makes the
leak a test failure (`tests/gateway/test_shared_platform_boilerplate.py`).

**U9 — Cron is an agent task system, and headless refuses to spawn.**
Schedules are natural language (`every monday 9am`), 5-field cron, duration or ISO one-shot; jobs
carry `skills`, `model`/`provider`, a pre-run `script` (always a FILE under `HERMES_HOME/scripts/`,
never a command line), `context_from` chaining, `timezone` pins, and `grace_minutes`
(`cron/AGENTS.md#L8-L18`). The **inactivity watchdog** is idle-time based, so a long-but-active job
is never cut off (`#L21-L25`). `tick(headless=True)` **refuses** agent jobs when no gateway owns the
home instead of spawning an unmanaged daemon (`#L45-L50`).
*Why:* unattended work is the whole point of a VPS agent, and "refuse rather than spawn an unmanaged
daemon" is the right answer to the ownership question.

**U10 — Every recurring occurrence is accounted for.**
`tick()` advances `next_run_at` **before** dispatch (at-most-once across a mid-run crash) and stamps
`pending_slot` in the same save; a scan finding the stamp with a dead owner restores the instant
ONCE; the executions ledger's `scheduled_instant` blocks a second fire; `cron.catch_up_missed: false`
skips past-grace misses with a logged reason — never a silently dropped slot
(`cron/AGENTS.md#L38-L42`).
*Why:* scheduling bugs hide as "the nightly job just didn't run"; this makes the drop impossible to
hide.

**U11 — Per-profile tick locks and profile-keyed in-flight state.**
`<home>/cron/.tick.lock` per store; in-flight maps keyed by `_inflight_key(job_id) = (home key, job
id)` because two profiles legitimately both own a `daily-brief`; claims released under the key they
were registered with (`cron/AGENTS.md#L43-L82`).
*Why:* a concrete, teachable pattern for "one process serves N tenants".

**U12 — Remote backends hibernate; file sync is transactional and mtime-based.**
Six-plus terminal backends (`tools/environments/`), with Daytona/Modal offering serverless
persistence — the environment hibernates when idle and wakes on demand (README.md#L29).
`file_sync.py` "tracks local file changes via mtime+size, detects deletions, and syncs to remote
environments transactionally; used by SSH, Modal, and Daytona. Docker uses bind mounts"
(`tools/environments/file_sync.py#L1-L5`).
*Why:* exactly the "managed VPS" property — the remote is authoritative and cheap while idle; you
sync deliberately rather than streaming every diff.

### 3.2 The growth loop

**U13 — Background review: a post-turn fork that writes skills/memory, on the parent's prompt cache.**
After a turn, `AIAgent.run_conversation` may spawn a daemon thread that replays the conversation
snapshot in a forked `AIAgent` and asks "should any skill/memory be saved or updated?"
(`agent/background_review.py#L1-L6`). The same-model fork inherits the parent's **cached system
prompt, `tools[]` and reasoning config byte-for-byte** to hit the same prefix cache — measured at
~26% end-to-end cost reduction (`#L1022-L1056`); a fork routed to a different model replays a
compact digest instead (`_digest_history`, `#L332-L362`).
*Why:* self-improvement that would otherwise be a second full-price agent call becomes a warm-cache
read — this is the single biggest cost-to-success idea in the repo.

**U14 — The review fork is persistence-isolated but cache-identical.**
`build_cache_parity_fork` sets `_persist_disabled`, `_session_db = None`, `_end_session_on_close =
False`, shares `session_id` for prefix warmth, freezes the tool-snapshot generation, and detaches the
compressor (`#L979-L1061`).
*Why:* a subtle and non-obvious combination — you get cache parity without the fork polluting the
real transcript, which is what makes the previous item safe to run on every turn.

**U15 — The review prompt is a real editorial standard, not "save something".**
`_LESSON_LAYER_BLOCK` (`#L398-L428`): procedure first, pitfalls as generalizable rule + WHY, no
PR/issue numbers or dates as content, the same lesson twice is ONE rule, always-on rules live in
SKILL.md whole while `references/` is for sometimes-needed depth, fix a wrong skill in place rather
than appending "UPDATE: actually...". `_DO_NOT_CAPTURE_BLOCK` (`#L431-L454`) forbids capturing
environment-dependent failures, negative tool claims ("X tool is broken" hardening into
self-imposed refusals), transient errors, one-off task narratives, and — pointedly — **unresolved
failures dressed up as a "reliable workflow"**. Preference order: patch a currently-loaded skill →
patch an umbrella → add a support file → create a class-level umbrella; names must not be PR numbers
or `fix-X-today` artifacts (`#L456-L527`).
*Why:* this is the difference between a library that compounds and one that fills with noise; the
anti-patterns enumerated are worth copying verbatim.

**U16 — Read-before-write is enforced, and the read is tracked across tools.**
`skill_manage` refuses to patch/edit an existing SKILL.md unless `skill_view` was called **during
this review**; content quoted earlier in the transcript does not count (`#L508-L515`).
`tools/skill_manager_guards.py` holds `_reset_background_review_read_marks`.
*Why:* prevents the classic "patch from memory" drift, and is cheap to implement.

**U17 — `/learn`: turn any source into a skill in one turn.**
`agent/learn_prompt.py` builds one prompt that makes the live agent gather sources with its existing
tools and author a skill via `skill_manage`. It carries the hardline authoring standards inline,
the **knowledge-base layout** (lean always-loaded SKILL.md index + per-chapter `references/`, after
`virgiliojr94/book-to-skill`) with explicit instructions to process large corpora **one unit at a
time** and reconcile the index at the end (`#L84-L120`), and a **source-hygiene block** treating
source text as DATA — dropping zero-width and bidi control characters so a Trojan-Source document
cannot steer the agent (`#L123-L133`). Explicitly "no distillation engine, no model-tool footprint,
so it works identically on local, Docker, and remote backends" (`#L1-L6`).
*Why:* zero new tool surface, works on every backend, and the prompt-engineering detail (60-char
description cap, per-chapter incremental reads, untrusted-source hygiene) is directly reusable.

**U18 — A 60-character description budget, enforced.**
Skill `description` must be ≤ 60 chars, one sentence, ending in a period; `skill_manage` **rejects** a
new or changed description over it, and the reason is stated: the system-prompt skill index
`SKILL_PROMPT_DESC_LIMIT` truncates at 60 and loads it every session, so anything past char 60 is
silently cut and never routes (`skills/AGENTS.md#L26-L33`, `agent/learn_prompt.py#L15-L25`).
*Why:* a per-skill token budget with a named enforcement point — most agents have no such bound.

**U19 — Curator: a lifecycle for machine-written knowledge.**
Background maintenance tracks usage on `created_by: "agent"` skills and auto-archives stale ones
(`agent/curator.py` + `curator_backup.py`, CLI `hermes curator status|run|pause|resume|pin|
unpin|archive|restore|prune|backup|rollback`). Invariants: touches ONLY agent-created skills
(bundled/hub installed are off-limits), **never deletes — archive is the maximum**, pinned skills are
exempt from every auto-transition, and a pre-run tar.gz snapshot enables rollback
(`skills/AGENTS.md#L64-L81`).
*Why:* autonomous knowledge growth needs a garbage collector that can't destroy user work.

**U20 — Learning made visible.**
`agent/learning_graph.py` assembles a graph of "what a user actually learns over time":
non-base learned/profile skills plus `MEMORY.md`/`USER.md` chunks as first-class nodes, skill links
from declared `related_skills`, memory→skill links from lexical overlap; rendered via
`learning_graph_render.py` for the desktop app (`agent/learning_graph.py#L1-L8`).
*Why:* makes the growth loop inspectable rather than mystical.

### 3.3 Other unusual capabilities

**U21 — A post-mortem eval suite.** `evals/postmortem/` (33 files) — every production incident
becomes an eval, alongside `evals/prefix_rediet`, `evals/prompt_footprint`, `evals/liveness`,
`evals/toolperf_abeval`, `evals/readtool`.

**U22 — Evals are real A/B agent runs with cost/latency metrics.** `evals/readtool/README.md`
measures accuracy, `api_turns`, `tool_calls`, `read_file_calls`, `total_tokens`, `wall_s` per task
against a deterministic hostile workspace (lockfile token tarpit, 600 KB minified line, FIFO that
blocks naive reads, PNG bytes behind a `.txt` name, NFD + U+202F filenames), with the note that
"efficiency aggregates are per-task means, never sums" (`evals/readtool/README.md#L1-L35`).

**U23 — Kanban: a durable multi-agent work queue.** SQLite board with `claim`,
`request-review`/`request-changes`, `block`/`unblock`, heartbeats; a dispatcher runs **inside the
gateway** by default; board is the hard isolation boundary, tenant a soft namespace; after N
consecutive non-success attempts a task auto-blocks to stop spin loops, and a terminal provider exit
(78) trips it sticky on the first attempt because no retry can heal it (`cron/AGENTS.md#L117-L169`).
Worker liveness is `(worker_pid, worker_started_at)`, never bare PID existence.

**U24 — Bot Mode: agents messaging agents.** `message_agent` lets a Bot Mode agent DM a teammate —
a profile on this install, an agent on a peer gateway, or one on another Desktop-connected machine —
fire-and-forget, with the reply arriving later via the background-process completion notification;
the schema is injected **only** into a bot's canonical "Bot Chat" session and dispatch re-checks that
gate (`tools/bot_mode_dm.py#L1-L14`).

**U25 — Detached sessions: a conversation can outlive its chat route.** When a messaging chat moves
on (`/new`, `/resume`, `/branch`), an open Desktop/Webapp view on the previous conversation keeps
working — `detach` moves the live session onto its own route key and pins it on a copy of its source
(`gateway/session_detached.py#L1-L20`).

**U26 — Between-turn results are first-class, deduplicated rows.** A detached delegation delivery or
an unviewed completion note is recorded as **one** user row keyed by its unit id (not its text) and
the match searches the *compression lineage*, so a replay after rotation doesn't duplicate it
(`hermes_state_detached_results.py#L12-L57`).

**U27 — Streaming delivery contract with named invariants.** For adapters where the draft stream *is*
the message, four invariants each derived from a live duplicate-final incident: draft frames must be
prefix-stable; the consumer declares the final; interim sends carry `_interim_send`; reconcile by
edit, never by plain send (`gateway/AGENTS.md#L29-L56`).

**U28 — Approval, secrets and profiles fail closed.** `agent/secret_scope.py::get_secret` raises
`UnscopedSecretError` once `set_multiplex_active(True)`; every new multi-home host must set it or
"every guard is silently off" (`agent/AGENTS.md#L136-L141`). Headless/cron context **refuses** rather
than guessing on approvals.

**U29 — Persona is a file, and it is disciplined.** `SOUL.md` — short, opinionated, and explicitly
against filler: "match the length of your reply to the weight of the ask... No filler ('Great
question,'), no restating the request back, no re-summarizing what you already said, no narrating
tool calls the user can see." (`SOUL.md`)

**U30 — Delegation with a real process/handoff contract.** `evals/subagent_process_handoff`+
`tools/delegate_tool*.py` (18 files); the delegated child carries
`DELEGATED_CHILD_ENV_MARKER` valued as the **fenced Kanban board root**, not a bare flag, so
`kanban_path_is_fenced(path)` denies mutations only on the dispatcher-pinned DB or under that root
(`cron/AGENTS.md#L166-L169`).

---

## 4. STEAL LIST

Numbered, adoptable-with-evidence. Each: what to adopt, where the evidence is, why.

1. **Per-conversation prompt cache as a sacred invariant, written down and enforced.**
   `AGENTS.md#L20-L23`, `agent/AGENTS.md#L55-L68`.
   *Why:* it makes every other design decision legible, and it is the cost model that makes 500-turn
   agents viable.

2. **The "inject via user message or tool result, never the system prompt" rule.**
   `agent/AGENTS.md#L60-L63` (`agent/skill_commands.py`, `agent/subdirectory_hints.py` with
   `_MAX_HINT_CHARS = 32_000`).
   *Why:* gives you mid-conversation context injection without breaking the cached prefix.

3. **Post-turn background review fork on the parent's warm cache (~26% cheaper).**
   `agent/background_review.py#L1022-L1056`, `#L979-L1061`.
   *Why:* self-improvement at near-marginal cost instead of a second full-price call.

4. **Persistence-isolated-but-cache-identical fork construction.**
   `agent/background_review.py#L1000-L1017` (`_persist_disabled`, `_session_db = None`,
   `_end_session_on_close = False`, frozen tool snapshot generation).
   *Why:* the fork can't corrupt the real transcript, so it is safe to run unconditionally.

5. **An editorial standard for what the agent is allowed to write down.**
   `agent/background_review.py#L398-L454` (`_LESSON_LAYER_BLOCK`, `_DO_NOT_CAPTURE_BLOCK`).
   *Why:* explicitly forbids the anti-patterns (negative tool claims hardening into refusals,
   unresolved failures dressed as workflows) that rot a skill library.

6. **Read-before-write enforcement on self-edits.** `agent/background_review.py#L508-L515`,
   `tools/skill_manager_guards.py`.
   *Why:* cheap guard against edits made from stale memory.

7. **A 60-char, test-enforced description budget tied to what the prompt actually renders.**
   `skills/AGENTS.md#L26-L33` (`SKILL_PROMPT_DESC_LIMIT`), `tests/skills/test_authoring_standards.py`.
   *Why:* every loaded skill costs tokens on every turn; the budget makes it explicit and mechanical.

8. **A curator with "archive is the maximum, never delete" + pre-run snapshots + pins.**
   `skills/AGENTS.md#L64-L81`, `agent/curator.py`, `agent/curator_backup.py`.
   *Why:* autonomous pruning without catastrophic loss.

9. **`/learn` as a prompt, not an engine.** `agent/learn_prompt.py#L1-L6`, `#L136-L197`.
   *Why:* zero tool-surface growth and identical behaviour across every backend.

10. **Knowledge-base skill layout (lean SKILL.md index + per-chapter `references/`), read one unit at
    a time.** `agent/learn_prompt.py#L84-L120`.
    *Why:* query cost tracks the answer, not the source size; avoids loading whole corpora.

11. **Untrusted-source hygiene: drop zero-width/bidi characters before distilling.**
    `agent/learn_prompt.py#L123-L133`.
    *Why:* a Trojan-Source document that reads one way to a human and another to the model is a real
    prompt-injection vector for any "learn from this URL" feature.

12. **Durable per-session admission FIFO with an explicit `unknown` state.**
    `website/docs/developer-guide/session-storage.md#L122-L158`.
    *Why:* never replay a possibly-side-effecting input; never silently drop it either.

13. **Owner/worker split with an identity handshake before any work is authorised.**
    `agent/managed_worker.py#L110-L127`, `#L443-L450`; `gateway/session_managed_worker.py#L676-L689`.
    *Why:* proves which process is running your turn, defeating PID reuse and launcher trampolines.

14. **Closed, versioned, validated bootstrap frame.** `agent/managed_worker.py#L27-L28`, `#L26`
    (`MAX_FRAME = 4 MiB`), `#L110-L127`.
    *Why:* an IPC boundary that refuses unknown fields is dramatically easier to reason about.

15. **`spawn_owned` as the single sanctioned way to start a long-lived child, backed by a lint check.**
    `hermes_cli/process_identity.py#L1073-L1087`, `scripts/check_detached_spawns.py#L37-L39`.
    *Why:* converts "remember to set `start_new_session` carefully" into a CI-enforced invariant.

16. **Owner-death supervisor written in POSIX `sh`, one per process, EOF-driven.**
    `hermes_cli/process_supervisor.sh#L1-L56`, `hermes_cli/process_identity.py#L816-L845`.
    *Why:* guarantees child-tree cleanup even on SIGKILL/OOM at ~0.5 MB resident cost.

17. **Boot-relative process births to survive clock steps and VM resume.**
    `hermes_cli/process_identity.py#L69-L119`, `#L141-L156`.
    *Why:* NTP steps and host sleep otherwise make live processes look dead — a bug class almost nobody
    handles.

18. **Spawn ledger with quarantining on corruption.** `hermes_cli/process_identity.py#L273-L304`.
    *Why:* "corrupt" is a distinct state, never silently read as an empty roster.

19. **Route identity resolved ONCE per inbound event and pinned on the source.**
    `gateway/AGENTS.md#L90-L113`.
    *Why:* eliminates the entire class of "which bot/tenant is this really" bugs at one seam.

20. **Scoped env reads that fail closed to the default rather than falling back to `os.environ`**,
    with a test asserting every adapter uses the shared reader.
    `gateway/AGENTS.md#L147-L163`, `tests/gateway/test_shared_platform_boilerplate.py`.
    *Why:* the leak is silent and cross-tenant; the fallback-after-miss shape is the actual bug.

21. **Approval/secrets/gates that fail closed, and headless contexts that refuse rather than spawn.**
    `cron/AGENTS.md#L45-L50`, `agent/AGENTS.md#L136-L141`.
    *Why:* unattended execution should never invent an approval.

22. **At-most-once scheduling: advance `next_run_at` before dispatch, stamp the slot in the same save.**
    `cron/AGENTS.md#L38-L42`.
    *Why:* crash-safe recurring work without duplicate side effects.

23. **Idle-time (not wall-clock) watchdog for scheduled agent runs.** `cron/AGENTS.md#L21-L25`.
    *Why:* long-but-active jobs are never killed; a stalled session can't monopolise the scheduler.

24. **Pre-run data scripts that must be a FILE under the scripts dir, never a command line.**
    `cron/AGENTS.md#L12-L14`, `cron/scheduler_script.py`.
    *Why:* "inject the agent's prompt from a script" is a huge capability and an obvious injection
    hole if spelled as an inline command.

25. **In-flight state keyed by `(home key, job id)`, with claims released under the registering key.**
    `cron/AGENTS.md#L64-L82`.
    *Why:* the concrete fix for the "one process, N tenants" bug class.

26. **A named stream-delivery contract derived from real incidents.**
    `gateway/AGENTS.md#L29-L56`, `tests/gateway/test_stream_final_contract.py`.
    *Why:* streaming UIs fail in exactly these four ways; naming them prevents re-litigating.

27. **Background-process notifications that start a new turn with an explicit admission receipt.**
    `gateway/AGENTS.md#L58-L65` (`admit_internal_event`, refusal refunds claimed siblings).
    *Why:* turns the "notify me when it finishes" feature into a durable, non-dropping contract.

28. **Between-turn results recorded once, keyed by unit id, matched across the compression lineage.**
    `hermes_state_detached_results.py#L12-L57`.
    *Why:* the exact fix for duplicate deliveries after a session rotates.

29. **Evals built from post-mortems, and evals that measure cost/latency, not just pass/fail.**
    `evals/postmortem/`, `evals/readtool/README.md#L24-L35`.
    *Why:* converts incidents into regression protection, and makes efficiency a first-class metric.

30. **Hostile-input fixtures for the read path** (lockfile tarpit, one 600 KB line, FIFO, lying
    extension, Unicode filenames, near-miss filenames).
    `evals/readtool/README.md#L10-L22`.
    *Why:* a ready-made, cheap-to-copy test corpus for any harness's file tools.

31. **Per-unit complexity ratchets instead of style guidance.**
    `AGENTS.md#L91-L107` (CC ≤ 20, ≤ 300 lines, nesting ≤ 6, files ≤ 2,000 lines; over-budget units
    may only go down), `scripts/code_health/config.py`.
    *Why:* the only reliable way to keep an agent codebase navigable at this scale.

32. **Facade + `<stem>_<topic>.py` siblings with a documented seam rule** ("patch where production
    reads"; siblings late-import the facade inside functions).
    `AGENTS.md#L91-L107`.
    *Why:* makes huge single-purpose systems greppable and patchable by an agent.

33. **A per-area `AGENTS.md` routing table with explicit "don't fix this" instructions.**
    `AGENTS.md#L142-L160`, and e.g. `gateway/AGENTS.md#L79-L88` ("Do NOT 'fix' gateway-dies-with-app by
    re-parenting... do NOT 'fix' update locks by widening the tree-kill"),
    `agent/AGENTS.md#L69-L72` ("Never load an install-tree AGENTS.md as project context (PR #64611)").
    *Why:* negative instructions are what stop a future agent from undoing a hard-won fix.

34. **Guard scripts with reason-required opt-outs and empty baselines.**
    `scripts/check_detached_spawns.py#L111-L118`, `#L159-L162`.
    *Why:* `# noqa`-style suppression without justification is how invariants die; a required reason
    after a dash fixes it (compare `# health: allow <RULE> -- <why>`, `AGENTS.md#L68-L69`).

35. **"Verify the claim AND the intent before calling it a bug."** `AGENTS.md#L48-L50`.
    *Why:* "an absence can be load-bearing" — the single most useful instruction for an agent
    operating on a large unfamiliar codebase.

36. **Learning graph / visible growth surface.** `agent/learning_graph.py#L1-L8`,
    `learning_graph_render.py`.
    *Why:* users trust and steer a self-improving system when they can see what it learned.

37. **Detached conversation sessions.** `gateway/session_detached.py#L1-L20`.
    *Why:* lets a UI survive chat-scoped commands, which is the difference between a toy and a
    workspace.

38. **Bot-to-bot messaging with a containment gate.** `tools/bot_mode_dm.py#L1-L14`.
    *Why:* a schema injected only into a bot's canonical session, with dispatch re-checking the gate,
    is the right shape for a multi-agent feature that must not leak into normal use.

---

## 5. Optimisation + what-to-do candidates

### 5.1 Things that look suboptimal (with evidence)

| # | Observation | Evidence | Why it matters |
|---|---|---|---|
| O1 | **Extreme module fragmentation.** 73 `hermes_state_*.py`, 33 `turn_*.py`, ~130 `gateway/session_*.py`, 46 `run_*.py`. The stated rule is `≤ 2,000` lines per file and CC ≤ 20, so fragmentation is *policy* — but it has crossed into discoverability cost. | `ls agent/turn_*.py`, `ls hermes_cli/gateway*.py` (48 files, `gateway.py` alone at 264 KB) | An agent (or human) cannot hold the call graph; grep-driven navigation is mandatory. A single index doc per family would pay for itself. |
| O2 | **Ratchets can make a file grow-only.** "Units already over may only go down (move a function into a sibling to offset growth)" means a 300-line function can never be split below the ratchet without ceremony. | `AGENTS.md#L102-L105` | Reviewers may prefer in-file improvement; consider allowing a floor-lowering after N clean periods. |
| O3 | **`cli-config.yaml.example` is 132 KB** — a full config dump committed as the documentation surface. | `ls -la cli-config.yaml.example` | Docs-by-dump drifts silently; a generated file with a check that it matches `DEFAULT_CONFIG` would keep it honest. |
| O4 | **Comments carry incident IDs heavily** (`#85265`, `#140580`, `KB-12`, `#149708`, `NS-658`). | `gateway/AGENTS.md`, `agent/AGENTS.md`, `hermes_state_detached_results.py#L2` | Excellent rationale retention, but unreadable to anyone outside the tracker; a short "failure class" label alongside the ID would generalise better. |
| O5 | **Test corpus is ~7× the production code** (7,898 files vs ~1,200 production modules). | `find tests -type f \| wc -l` | Suggests heavy behavioural-contract testing (good), but also high maintenance drag; the ratchet philosophy could be applied to test file counts per area. |
| O6 | **Shallow checkout makes several documented invariants unverifiable here** ("proven red on the base", `git log -p -S "<symbol>"`). | `git rev-list --count HEAD` → 1 | Any future audit should clone with `--depth` disabled. |
| O7 | **Auxiliary-path cost discipline is extensive but spread out** (`_REVIEW_MAX_INPUT_TOKENS_CAP`, context-fraction budgets, fallback chains, `reasoning_effort` no-ops that need a warning to be visible). | `agent/background_review.py#L173-L225`, `#L866-L882` | Suggests a single "aux budget" surface would reduce the number of places a cost knob must be honoured. |
| O8 | **`_last_resolved_tool_names` is a process-global** requiring save/restore around subagents. | `agent/AGENTS.md#L73-L75` | A documented foot-gun; a contextvar would remove the class. |
| O9 | **Windows is a first-class platform with hand-rolled absolute paths** (88 KB `gateway_windows.py`, job objects via ctypes, `windows-footgun` inline markers). | `hermes_cli/gateway_windows.py`, `hermes_cli/process_identity.py#L755-L813` | Enormous surface for one platform; worth quantifying whether native Windows earns the cost vs WSL2. |

### 5.2 What to do — adoption order for a "Managed VPS Loop" harness

1. **Adopt the transport model first (U2/U3).** Owner process + per-turn worker over a framed pipe,
   with `delta`/`tool.*`/`approval`/`clarify`/`result`/`finished` frames. Everything else (lag, cost,
   resumability) follows from this.
2. **Then the durable ledger (U1/U4).** `session_admissions` + `worker_executions` + `worker_receipts`,
   with `unknown` as a real state. Without it the worker model is just a process pool.
3. **Then process ownership (U5/U6/U7).** `spawn_owned` + supervisor + the lint check. This is the
   cheapest of the three to port and removes the worst operational failure mode.
4. **Then the growth loop (U13–U19), in this order:** background-review fork with cache parity →
   editorial-standard prompts → read-before-write → curator with archive-not-delete → description
   budget. Skipping the editorial standard yields a library full of negative tool claims.
5. **Then scheduling (U9–U11)** if unattended work is in scope; skip otherwise.
6. **Then evals (U29/U30).** Port `evals/readtool`'s hostile fixtures verbatim as a starting corpus.

### 5.3 What *not* to copy

- **The full 25-platform gateway.** The adapter matrix is a product decision, not a harness
  primitive; take the *contracts* (`gateway/AGENTS.md`) not the adapters.
- **The four-layer process-identity scheme in full.** Port layers 1–2 (spawn tags + ledger) and the
  POSIX supervisor; skip the Windows job-object path unless Windows is a real target.
- **Profile multiplexing (U8)** unless multi-tenancy is a requirement — the fail-closed scope rules
  are excellent but pervade every call site.
- **The per-area `AGENTS.md` count** at the current granularity; adopt the *routing table* idea with
  far fewer, larger files.

---

## Appendix A — Directory inventory (file counts)

```
tests                 7898     optional-skills        819
apps                  4939     website                791
contributors          2327     ui-tui                 661
plugin-catalog        1066     agent                  422
tools                  382     gateway                365
skills                 307     web                    261
scripts                250     evals                  236
acp_adapter             22     cron                    52
hermes_state siblings   73     hermes_cli             834
tui_gateway            127     docker                  26
nix                     26     pm                      63
locales                 35     optional-mcps           66
providers                3     native                   5
```

## Appendix B — Verification notes

- Nothing in the repository was written to, moved, or executed in a mutating way; all commands were
  read-only (`ls`, `find`, `du`, `wc`, `git log`, `git rev-list`).
- `/data/home/forge/hzcode` was not accessed at any point.
- `git log --oneline -10` and `git rev-list --count HEAD` were run; both confirm a single-commit
  shallow clone, which is recorded above as a limitation of the evidence base.
