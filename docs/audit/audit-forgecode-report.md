# Forge (forgecode) — Deep Audit Report

**Audit target:** [`tailcallhq/forgecode`](https://github.com/tailcallhq/forgecode/tree/a22b49288856d5b3f3ca57e8532683d54a662c8c) (reference clone, shallow: 1 commit `a22b492` "fix(deps): update dependency @types/node to v26 (#4095)", dated 2026-10-31; `git log --oneline -30` returns exactly one commit because the clone is shallow — noted as a coverage caveat, not a repo property).
**Mode:** read-only. Nothing in the repo was modified. Scratch files were written to `/tmp/audit-scratch/` only. `HorizonCode` was not touched.
**Report written incrementally** to `/tmp/audit-forgecode-report.md`.

---

## 0. What this repo is + coverage stats

### 0.1 What it is

`forgecode` is **Forge**, a production-grade, open-source (Apache-2.0, Tailcall Inc.) AI coding agent distributed as a Rust CLI/TUI binary plus a ZSH plugin. Upstream: `https://github.com/tailcallhq/forgecode`; install via `curl -fsSL https://forgecode.dev/cli | sh`.

One-line identity: **a multi-provider terminal coding agent whose differentiators are a compiled-in agent/command/skill subsystem, a configurable policy engine over every operation, a ZSH shell-integration layer, and a background "workspace" semantic-index/embedding service.**

Key facts established from source and docs:

- **Rust workspace, 25 crates** under `crates/` (`forge_main`, `forge_app`, `forge_domain`, `forge_repo`, `forge_services`, `forge_infra`, …), ≈174k lines of Rust excluding snapshots/tests data.
- **Three usage modes** documented in [`forgecode/README.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/README.md#L180-L227): interactive TUI (`forge`), one-shot CLI (`-p`), and the ZSH plugin `:`-prefix mode (`forge setup` installs it).
- **Agents** are first-class, defined as Markdown + YAML front-matter; three built-ins ship in-binary: `forge` (implementer), `sage` (read-only research), `muse` (planner) — [`forgecode/crates/forge_repo/src/agents/forge.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_repo/src/agents/forge.md), `sage.md`, `muse.md`.
- **Skills** are also first-class: three built-ins (`create-skill`, `execute-plan`, `github-pr-description`) plus project (`./.forge/skills`) and global (`~/forge/skills`) precedence layers.
- **Providers**: OpenAI-compatible, OpenAI Responses API, Anthropic, Google Vertex/Gemini, Amazon Bedrock, GitHub Copilot, plus a large set of OpenAI-compatible third parties (z.ai, Cerebras, Meta, OpenRouter, Requesty, x-ai, IO Intelligence, Neuralwatt, OrcaRouter, Minimax, Copilot…), and OAuth-based login flows (`forge_infra/src/auth`, `forge_main/src/oauth_callback.rs`).
- **Config**: TOML (`~/.forge/.forge.toml`) + per-project YAML (`forge.yaml`) + a published JSON Schema `forge.schema.json` (31 KB) describing the YAML surface.
- **Persistence**: conversations in a SQLite database managed with Diesel migrations (`crates/forge_repo/src/database/migrations/`), plus a workspace/indexing service (server-side, `FORGE_WORKSPACE_SERVER_URL`) for semantic search.
- **Notable engineering**: every tool description is a Handlebars template rendered with runtime context (`crates/forge_domain/src/tools/descriptions/*.md`, `templates/`), and the repo keeps an in-tree `plans/` directory with its own design plans — the product is literally used to develop itself (`.forge/skills/*` are the project's own workflows).

### 0.2 Headline findings

1. **Forge is an agent *platform*, not just an agent.** Agents, skills, commands, providers, policies, tool descriptions and prompts are all plain files, and the binary compiles them in or loads them from four precedence layers. That is what makes its behaviours configurable without code changes.
2. **The tool contract is the most heavily engineered surface.** Compile-time markdown descriptions rendered as templates, JSON repair + schema coercion for malformed arguments, three-stage patch fallbacks, remote syntax validation after writes, snapshot-based undo, and conservative output truncation with temp-file spillover.
3. **Guardrails are structural, not prompt-only.** Six lifecycle events drive hooks (doom-loop detection, pending-todo enforcement that re-opens the loop after the model tries to stop, compaction, title generation, telemetry), plus per-tool failure budgets and a declarative permission policy engine over read/write/execute/fetch.
4. **Its safety story is layered**: policy engine (`allow`/`deny`/`confirm` with `all`/`any`/`not`), MCP trust gating keyed by config hash, git-worktree sandboxes, snapshot undo, path/absolute-path assertions, binary-download refusal, tool timeouts.
5. **Compaction is deterministic and cheap** — it folds tool history into structured summaries rather than paying for an LLM summarisation pass, and it deliberately preserves the last extended-thinking block.
6. **Agent behaviour is regression-tested against real models** by a TypeScript eval harness that can assert on the *outgoing request payload* (e.g. "never emit `cd` when `cwd` is set"), across multiple models.
7. **Shared DNA with other agents is broad** (section 2), so the report focuses on 16 genuinely distinctive items (section 3) — chief among them the policy DSL, patch fallback ladder, hook-based stop guards, agent-as-tool sessions, skills with bundled resources + validators, and the ZSH-first UX.
8. **Weak spots / caveats observed**: semantic search and syntax validation depend on a *hosted* service (`FORGE_WORKSPACE_SERVER_URL`, the validation gRPC endpoint) that is not in this repo, so those features cannot be self-hosted from this codebase alone; shell integration is ZSH-only; the `conversations` table still requires `workspace_id` (now derived from a `WorkspaceHash` of the workspace path rather than a workspace row) long after the `workspace` table itself was dropped in the 2026-02-16 migration; conversation `metrics` are persisted **without** todos (`MetricsRecord` has `started_at`, `files_changed`, `files_accessed`; reloading sets `todos: Vec::new()`), so in-flight todo lists appear to be session-scoped — worth verifying against the UI layer; and the clone under audit is shallow (single commit), so commit-history archaeology (release cadence, refactor history) was impossible.

### 0.3 Coverage stats

| Metric | Value |
|---|---|
| Directories walked | 191 (excluding `.git`) |
| Files in tree | 936 (excluding `.git`) |
| Files opened and read/skimmed | ~85 (each cited in this report) |
| Rust `*.rs` | 474 (≈60 read or grep-inspected in detail) |
| Insta snapshots `*.snap` | 170 (generated; sampled for assertions) |
| Markdown `*.md` | 106 total — 45 read in full (README, AGENTS.md, docs, all `templates/*`, all `tools/descriptions/*`, agents, skills, one plan); the rest listed and skimmed |
| Rust crates | 25 in workspace |
| Approx. Rust LOC (all crates, incl. tests in-file) | ≈174,000 |
| Python/npm toolchains | none beyond the `benchmarks/` TS harness and `.github/scripts/bounty` TS bot |

### 0.4 NOT READ (explicit list)

The following were deliberately not read line-by-line. Everything else in the tree was opened, read, or grepped with context:

- **170 Insta snapshots** (`crates/**/snapshots/*.snap`, `*.snap.html`) — machine-generated assertion artefacts. Sampled (e.g. the 57 KB OpenAI-Responses tool-catalog snapshot and the 40 KB tool-usage snapshot) only to confirm what is asserted; not reviewed in full.
- **`Cargo.lock` (241 KB), `package-lock.json` (68 KB)** — lockfiles.
- **`forge.schema.json` (31 KB)** — machine-generated JSON Schema for `forge.yaml`/`forge.toml`; inspected structurally (top-level keys) but not read end-to-end.
- **Generated Diesel schema** (`crates/forge_repo/src/database/schema.rs`) and generated `*.sql` migrations beyond the conversations/init migrations actually discussed.
- **`crates/forge_markdown_stream`** (45 files, 3.8k LOC, ANSI markdown rendering) — skimmed; behaviour inferred from its call sites in the TUI.
- **`crates/forge_walker`, `forge_fs`, `forge_spans`/`forge_snaps`, `forge_snaps`** — internals skimmed; behaviour confirmed through call sites (`Walker::unlimited()`, `insert_snapshot`), not fully read.
- **Binary/visual assets**: `crates/forge_main/src/banner` (ASCII art), `.css`/`.html` fixtures, `package.json`-driven TS harness internals (`benchmarks/*.ts` read via README only), `.github/scripts/bounty/` TypeScript bot.
- **`.devcontainer/`, `flake.nix`/`flake.lock`, `Cross.toml`, `_config.yml`, `.config/`** — packaging/devcontainer configs, inspected by name only.
- **`tests/fixtures/*.csv`, `*.jsonl`, `*.json` fixture corpora** — used as data, not read.

Search-by-grep (not full read) was used for: `.github/workflows/*.yml` bodies (verified generation source instead), `git log` history (clone is shallow: one commit), and the ~9k lines of test modules inside otherwise-read crate files.

### 0.5 Method

1. `git log --oneline -30` (returned 1 commit; clone is shallow — recorded as a caveat).
2. Full tree inventory (`find`, per-extension counts, per-crate LOC), directory walk of all 191 dirs.
3. Read the README (1,159 lines), `AGENTS.md`, `docs/tool-guidelines.md`, `shell-plugin/README.md`, `benchmarks/README.md`, all `templates/*.md`, all `crates/forge_domain/src/tools/descriptions/*.md`, the three built-in agent definitions, the built-in skill repository code plus `execute-plan`/`github-pr-description` metadata, the project's own `.forge/skills/create-plan/SKILL.md`, the `.forge/commands/*` names and front matter, and the titles of all 23 `plans/*.md` with one plan read in full (`plans/2025-04-16-model-selection-command.md`). Not read: `.github/contribution.md`, `.github/ISSUE_TEMPLATE/*`, `shell-plugin/*.zsh` sources (behaviour taken from its README and `crates/forge_main/src/zsh/*`).
4. Read the core source: `orch.rs`, `app.rs`, `system_prompt.rs`, `tool_registry.rs`, `compact.rs`, `hook.rs`, `hooks/*`, `policies/*`, `catalog.rs`, `fs_patch.rs`, `skill.rs`, `instructions.rs`, `mcp/manager.rs`, `context_engine.rs`, `sandbox.rs`, `cli.rs`, `config.rs`, plus targeted greps across `forge_repo/src/provider/*`, `forge_main/src/*`, `forge_json_repair`, `forge_ci`, `forge_tracker`, `forge_infra/src/auth`.
5. Report written incrementally to `/tmp/audit-forgecode-report.md` (this file), section by section.

---

## 1. Complete feature inventory by area

*(Subsections below are ordered as: CLI/TUI → agent loop → tools → providers → prompts/skills → memory/context → sandbox/policy → sessions → UX → engineering.)*


### 1.1 CLI surface (`crates/forge_main/src/cli.rs`, 1900 LOC)

Top-level commands: `agent`, `zsh` (alias `extension`), `list`, `banner`, `info`, `config`, `conversation` (alias `session`), `commit`, `mcp`, `suggest`, `provider`, `cmd` (aliases `command`/`commands`), `workspace`, `data`, `vscode`, `update`, `setup`, `doctor`, `logs`, `select`. Global flags: `-p/--prompt`, `--conversation <file>`, `--conversation-id/--cid`, `-C/--directory`, `--sandbox <name>`, `--verbose`, `--agent/--aid`, `-e/--event`, piped stdin as a *droppable* prompt.

Engineered details worth copying:

- **`forge select <model|agent|provider|reasoning-effort|command|conversation|file>`** — purpose-built fuzzy pickers that print a machine-readable value on stdout for the ZSH plugin to consume (pickers live in `crates/forge_select` with a preview pane, `crates/forge_select/src/preview.rs`).
- **Porcelain mode everywhere** (`--porcelain`) giving stable machine-readable output for shell integration.
- **`forge data`** — batch JSONL → schema-constrained LLM processing with `--concurrency` (a non-interactive "data labeling" mode, `crates/forge_domain/src/data_gen.rs`).
- **`forge logs`** live-tails the newest log file; **`forge config migrate`** migrates legacy `~/forge` → `~/.forge` (see `forge_config/src/legacy.rs`).
- Comment at the top of `cli.rs` explicitly warns that ZSH-plugin compatibility must be verified with every CLI change — CLI-as-API discipline.

### 1.2 TUI / interactive layer (`crates/forge_main/src/ui.rs` ~4.9k LOC, `model.rs`, `stream_renderer.rs`, `input.rs`, `completer/`, `highlighter.rs`, `editor.rs`, `conversation_selector.rs`, `sandbox.rs`, `vscode.rs`)

- Interactive REPL with streaming markdown rendering (`crates/forge_markdown_stream`), syntax highlighting, `$EDITOR` compose (`:edit`), @-file fuzzy completion (`crates/forge_main/src/completer`), slash-ish `:` commands and history.
- Session-only vs persistent settings are explicitly separated (`:model` vs `:config-model`) — a deliberate UX split documented in the README.
- `:dump` exports a conversation as JSON **or a styled HTML page** (`crates/forge_domain/src/conversation_html.rs` + `conversation_style.css`), auto-opened in a browser when `FORGE_DUMP_AUTO_OPEN` is set.
- Sandbox mode (`--sandbox name`) creates an isolated **git worktree + branch** before starting (`crates/forge_main/src/sandbox.rs`).
- VS Code integration: `forge vscode install-extension`.

### 1.3 Agent loop (`crates/forge_app/src/orch.rs`, `agent.rs`, `hooks/*`)

`Orchestrator::run()` is the turn loop. Per iteration it: updates the conversation, fires `Request` hooks, performs the chat turn **through a retry wrapper** (`crate::retry::retry_with_config` with configurable backoff/attempts/status codes), fires `Response` hooks, decides completion (`FinishReason::Stop` with no tool calls, or a tool whose catalog entry says `should_yield`), executes tool calls, appends results, adjusts the per-tool error budget, applies `SetModel`, persists, and finally fires the `End` hook — which may inject messages and **re-open the loop** (this is how "pending todos", "doom loop" and compaction reminders keep the agent working).

Notable mechanics:

- Parallelism policy: `task` tool calls run **in parallel** via `join_all`, all other tools run **sequentially**, and each system-tool execution is gated by a `tokio::sync::Notify` handshake with the UI so the tool header is rendered before output arrives (`orch.rs` lines ~99-119).
- Per-tool failure budget: `ToolErrorTracker` counts failures per tool name and appends a rendered "attempts left" reminder (`templates/forge-tool-retry-message.md`) to each error; when the limit is reached the loop emits `ChatResponse::Interrupt{MaxToolFailurePerTurnLimitReached}` and forces completion.
- `max_requests_per_turn` per agent; on hitting it the user is asked whether to continue (README) and an `Interrupt{MaxRequestPerTurnLimitReached}` is emitted.
- Transformer pipeline before each provider call: `SortTools` → `NormalizeToolCallArguments` → `TransformToolCalls` (only when the model doesn't support tools) → `ImageHandling` → `DropReasoningDetails` (when unsupported) → `ReasoningNormalizer` (strips signatures when the model changed) → `ModelSpecificReasoning` (Claude knobs) → `DropReasoningOnlyMessages` (Claude/Bedrock constraint).
- Lifecycle hook system (`crates/forge_domain/src/hook.rs`): `Start`, `Request`, `Response`, `ToolcallStart`, `ToolcallEnd`, `End`, with `Hook::zip()` composition and closure-to-handler coercions — the extension point for the built-in behaviors in `crates/forge_app/src/hooks/`:
  - `compaction.rs` — runs on `Response`, compacts when `agent.compact.should_compact(...)`.
  - `doom_loop.rs` — runs on `Request`; detects `[A,A,A]` and repeating `[A,B,C][A,B,C]` tool-call sequences in history (threshold 3) and injects `forge-doom-loop-reminder.md`.
  - `pending_todos.rs` — runs on `End`; if unfinished todos remain, injects a reminder listing them (deduplicating against the previous reminder) so the agent cannot stop mid-plan.
  - `title_generation.rs` — runs on `Start`; spawns a one-per-conversation title-generation task (`title_generator.rs`) stored in a `DashMap`.
  - `tracing.rs` — telemetry enrichment.

### 1.4 Tool inventory (`crates/forge_domain/src/tools/catalog.rs`, descriptions in `tools/descriptions/*.md`, implementations in `crates/forge_services/src/tool_services/`)

| Tool | Notes |
|---|---|
| `read` | file read with `start_line`/`end_line`, line-numbered output; reads **images and PDFs as visual content** when the model supports image input (`image_read.rs`); Jupyter notebooks as JSON; truncates long lines |
| `write` | overwrite-safe writes; requires prior read + `overwrite: true` for existing files |
| `patch` | exact-string replace with `replace_all`; **errors if the file was not read first**; on no-match falls back to a fuzzy-search line-range service, or a text-patch gRPC service (`use_text_patch_fallback`) |
| `multi_patch` | atomic multiple edits to one file, applied in sequence; all-or-nothing |
| `undo` | reverts the most recent operation on a file, backed by `SnapshotRepository::insert_snapshot` taken before every mutating write |
| `remove` | file deletion (also snapshot-protected) |
| `fs_search` | ripgrep-backed search with glob/type filters, `content`/`files_with_matches`/`count` modes, multiline regex, and truncation to temp files |
| `sem_search` | semantic (embedding) search over the indexed workspace, natural-language queries with reranking, gated on workspace being indexed **and** the user being authenticated |
| `shell` | command execution with explicit `cwd` (the tool contract forbids `cd`), description field, prefix/suffix output truncation to temp files, and a per-config timeout |
| `fetch` | URL → markdown/text with robots.txt awareness, binary rejection, and 40 KB temp-file spillover |
| `followup` | asks the user a clarifying question and yields the turn |
| `plan` | writes implementation plans into `plans/` |
| `skill` | loads a `SKILL.md` skill's instructions on demand |
| `todo_write` / `todo_read` | structured, content-keyed task list (add/update/cancel semantics; IDs hidden from the model) |
| `task` | delegates to a sub-agent: takes `tasks[]` (parallel), `agent_id`, and an optional `session_id` to resume a previous sub-agent session with full context |
| `mcp_*` | every MCP server tool is namespaced and merged into the catalog |

Design details: tool descriptions are **Handlebars templates** rendered per agent/model at request time (they interpolate `{{tool_names.x}}`, `{{config.maxReadSize}}`, `{{env.cwd}}`, and conditional blocks such as image support), and each agent's `tools:` list is a whitelist supporting wildcards (`mcp_*`). Agent tools appear in the catalog as `AgentInput{tasks[]}` — i.e. *agents are tools*.

### 1.5 Providers (`crates/forge_repo/src/provider/`)

- **48 provider entries** in `provider.json` (ids: forge, deepseek, github_copilot, open_router, requesty, vivgrid, xai, openai, openai_compatible, kimi_coding, moonshot, openai_responses_compatible, anthropic, claude_code, anthropic_compatible, cerebras, neuralwatt, zai, zai_coding, big_model, vertex_ai, azure, llama_cpp, vllm, jan_ai, ollama, lm_studio, forge_services, io_intelligence, bedrock, vertex_ai_anthropic, google_ai_studio, minimax, codex, opencode_zen, opencode_go, alibaba_coding, alibaba_token_plan, novita, fireworks-ai, fireworks-ai-firepass, modal, adal, xiaomi_mimo, nvidia, ambient, orca_router, meta). Providers are declared as data with **Handlebars URL templates** (`{{OPENAI_URL}}`, `{{#if VLLM_PORT}}…`) and can be extended/overridden by the user's `forge.toml` (`ProviderEntry`, merged field-by-field by `id`).
- Wire protocols: `OpenAI`, `OpenAIResponses`, `Anthropic`, `Bedrock`, `Google`, `OpenCode` (`ProviderResponseType`).
- Per-provider request/response transformers compensate for vendor quirks: `set_cache` (prompt caching), `reasoning_transform`, `sanitize_tool_ids`, `capitalize_tool_names`, `enforce_schema`, `drop_invalid_toolcalls`, plus OpenAI-side `make_cerebras_compat`, `make_xai_compat`, `minimax`, `zai_reasoning`, `github_copilot_reasoning`, `trim_tool_call_ids`, `ensure_system_first`, `normalize_tool_schema`, `tool_choice` adapters.
- Auth: `forge_infra/src/auth/strategy.rs` implements API-key, Google ADC, and OAuth device/code flows; `forge_main/src/oauth_callback.rs` runs the localhost callback; credentials are stored by the provider repo (see `forge_repo/src/provider/provider_repo.rs`) rather than only in env vars (README marks env-var config as deprecated).
- Resilience: `retry.rs` (status codes, backoff, attempts), `bedrock_cache.rs` (prompt-cache point management), streaming via `forge_eventsource*` for SSE.

### 1.6 Prompts, agents, skills, commands

- **System prompt assembly** (`crates/forge_app/src/system_prompt.rs`): the agent's `system_prompt` template is rendered with a `SystemContext` containing env info (OS, cwd, shell, home), the file list, **workspace extension statistics computed by parsing `git ls-files`** (top-N extensions with percentages, remainder rolled up), the skill list, `custom_rules` (agent rules + `AGENTS.md`-style instructions + `forge.yaml custom_rules`), tool-name map filtered to the agent's tools, and parallel-tool-call support. It renders two system messages: a static one and `forge-custom-agent-template.md` (shared behavioral rules: no unsolicited docs, cite code as `filepath:startLine-endLine`, unlimited context via auto-summarization…).
- **User prompt wrapping** (`agent.md` front-matter `user_prompt`): each user message is wrapped in `<event.name>…</event.name>`, gets a `<system_date>`, and, when present, a `<command_trace>` of recent shell commands executed in the terminal (captured by the ZSH plugin, `crates/forge_main/src/zsh/`).
- **Agents**: markdown + YAML front matter (`id`, `title`, `description`, `reasoning`, `tools`, `user_prompt`, `custom_rules`, model/provider overrides, `compact`, `max_requests_per_turn`). Loaded from built-ins (embedded), `~/.forge/agents`, `./.forge/agents` (`crates/forge_repo/src/agent_definition.rs` + `agents/*.md`).
- **Skills**: `SKILL.md` with `name`/`description` front matter plus **bundled resource files** exposed as paths (`Skill::resources`), rendered with `{{global_skills_path}}` / `{{agents_skills_path}}` / `{{local_skills_path}}` substitutions. Precedence: project-local `./.forge/skills` > `~/.agents/skills` (cross-agent convention) > global `~/forge/skills` > embedded built-ins (`crates/forge_repo/src/skill.rs`). Built-ins: `create-skill`, `execute-plan`, `github-pr-description`.
- **In-repo workflows**: 11 project skills under `.forge/skills/` (create-agent, create-command, create-github-issue, create-plan, debug-cli, github-pr-comments, post-forge-feature, resolve-conflicts, resolve-fixme, test-reasoning, write-release-notes) and 2 commands (`.forge/commands/check.md`, `fixme.md`) — evidence that the team dogfoods its own skill format.
- **Other prompt assets**: `templates/forge-commit-message-prompt.md` (conventional-commit generator with style matching against recent commits), `forge-command-generator-prompt.md` (`suggest` NL→shell with explicit dangerous-command refusals and gibberish handling), `forge-system-prompt-title-generation.md`, `forge-partial-*` partials, `forge-doom-loop-reminder.md`, `forge-pending-todos-reminder.md`, `forge-tool-retry-message.md`.

### 1.7 Memory, context & compaction

- **Context model** (`crates/forge_domain/src/context.rs`, `compact/*`): messages are typed (`ContextMessage`), each entry can be *droppable* (attachments), and the context tracks token counts and image tool calls. `MessagePattern` builds synthetic contexts from a compact string like `"uau"` — used throughout tests.
- **Compaction is deterministic, not LLM-summarized** (`crates/forge_app/src/compact.rs` + `crates/forge_domain/src/compact/{summary,strategy}.rs`): a window of assistant/tool messages is folded into a `ContextSummary` (files read/updated/removed, searches, tool success flags), reduced by transformers (drop system messages, dedupe consecutive user messages, keep only the last op per file, dedupe assistant blocks, strip cwd prefixes), then rendered through `templates/forge-partial-summary-frame.md`. It explicitly **preserves the last reasoning block by re-injecting it into the first remaining assistant message** to keep extended-thinking chains valid.
- **Compaction triggers** (`Compact` config): `token_threshold`, `token_threshold_percentage` (of the model window), `turn_threshold`, `message_threshold`, `on_turn_end` (compact when the last message is a user message), plus `eviction_window` (fraction of context summarizable), `retention_window` (recent messages never compacted), `max_tokens` after compaction, and a dedicated `model` for compaction (defaults are set from the model list via `set_compact_model_if_none`).
- **Compaction points**: an automatic `CompactionHandler` on every `Response`, a manual `forge conversation compact <id>` / `:compact`, and `compact_conversation()` returning before/after token and message counts.
- **Doom-loop and todo reminders** act as short-term corrective memory (see 1.3), and `ChangedFiles` (`crates/forge_app/src/changed_files.rs`) informs the model when files changed outside its own edits.

### 1.8 Sandbox, policy & security

- **Policy engine** (`crates/forge_domain/src/policies/`): permissions are `Allow | Deny | Confirm`; operations are `Read{path}`, `Write{path}`, `Execute{command}`, `Fetch{url}` — each also carrying `cwd`. Rules are glob patterns (`read`, `write`, `command`, `url`, optional `dir`) and policies compose with `all` / `any` / `not` (see `Policy`, `Rule`, `PolicyEngine`). Evaluation semantics: first `Deny`/`Confirm` wins, the last `Allow` is kept, and the default when no policy matches is `Confirm`. `forge_services/src/permissions.default.yaml` ships an allow-all default set.
- **Runtime enforcement**: `ToolRegistry::check_tool_permission` converts each tool call into a policy operation when `restricted` mode is on, asks the user (or the policy store) before executing, prints a "Permission Denied" result into the conversation on refusal, and emits a "Permissions Update" title when a policy file was created.
- **Sandbox mode** (`--sandbox <name>`): creates a git worktree + branch in the repo's parent directory (reusing an existing worktree when present) so experiments never touch the user's branch (`crates/forge_main/src/sandbox.rs`).
- **MCP trust gate** (`crates/forge_services/src/mcp/manager.rs`): project-local `.mcp.json` must be explicitly trusted; the decision is persisted **per content hash**, and previously rejected configs are silently skipped, while user-scope config is implicitly trusted.
- Other hard boundaries: `assert_absolute_path` on file tools, binary-download refusal in `fetch`, size/line truncation, tool timeouts (`tool_timeout_secs`), and `FORGE_HTTP_ACCEPT_INVALID_CERTS` flagged with a security warning in the README.

### 1.9 Sessions, persistence & exports

- Conversations live in SQLite via Diesel (`crates/forge_repo/src/database/`, migrations for the conversations table, indexes, metrics column, plus created-then-dropped workspace/indexing tables). Rows store `conversation_id`, `title`, `workspace_id`, JSON `context`, `created_at/updated_at`, and JSON `metrics`.
- `ConversationRepository` + `ForgeConversationService` provide `get/upsert/get_all/delete/last`, and the CLI exposes `list / new / dump [--html] / compact / retry / resume / show [--md] / info / stats [--porcelain] / clone / delete / rename`.
- UX-level session features: `--cid` to pin a conversation, `:conversation -` to toggle back like `cd -`, `:clone` to branch a conversation, `conversation clone` in CLI, per-conversation metrics (tokens, cost, todos) displayed in the ZSH rprompt, and `forge conversation stats`.
- Exports: JSON and a standalone styled HTML transcript (`conversation_html.rs` + `conversation_style.css`), auto-openable via `FORGE_DUMP_AUTO_OPEN`; `auto_dump` config can dump automatically after a task.

### 1.10 Shell integration, UX & peripheral surfaces

- **ZSH plugin** (`shell-plugin/`, generated/installed by `forge setup`): `:` prefix interception, `:agent` switching, `@[file]` tagging with fuzzy selection (delegating path detection to Rust via `forge zsh format`), syntax highlighting, conversation continuity across shell invocations, `:commit`/`:commit-preview` that writes into the buffer for review, `:suggest`, `:edit` (writes `.forge/FORGE_EDITMSG.md`), `:dump`, `:copy`, `:retry`, `:compact`, `:sync`, `:doctor`, `:keyboard-shortcuts`, and a right-prompt showing model + session cost in a configurable currency. `FORGE_CURRENCY_SYMBOL`, `FORGE_CURRENCY_CONVERSION_RATE`, `NERD_FONT` control its look.
- **Bash/other shells**: `scripts/test-zsh-utils.sh`, `shell-plugin/lib/actions/*` hold the action implementations; the plugin is the only shell integration shipped.
- **Telemetry & observability** (`crates/forge_tracker`): events `start`, `prompt`, `error`, `tool_call`, `trace`, `login` with OS/cores/version/client-id metadata; disabled with `FORGE_TRACKER=false`; `forge logs` tails structured logs (`FORGE_LOG`, tracing filter).
- **Self-update** (`crates/forge_main/src/update.rs` + `forge_config/src/auto_dump.rs`/`Update`): `forge update [--no-confirm]` checks/installs the newest release, with `updates` config knobs.
- **Editor/IDE**: `forge vscode install-extension` and auto-install when running inside VS Code (`auto_install_vscode_extension`, default true per test).
- **Data mode**: `forge data --input file.jsonl --schema schema.json --concurrency N` for schema-constrained batch generation (`crates/forge_domain/src/data_gen.rs`, `crates/forge_app/src/data_gen.rs`).

### 1.11 Engineering, CI & test strategy (part of the product's identity)

- **Workspace**: 25 crates with a strict dependency direction (`forge_main` → `forge_app`/`forge_repo`/`forge_services` → `forge_domain` ← `forge_infra`), snapshots via `insta`, `pretty_assertions`, `derive_setters`, `fake::Dummy` fixtures.
- **CI is generated from Rust** (`crates/forge_ci/`, using the `gh_workflow` crate): `generate_ci_workflow()` builds jobs with a typed DSL and writes `.github/workflows/ci.yml`, alongside `autofix`, `bounty`, `labels`, `release_drafter`, `release_publish`, `stale` generators. CI runs `cargo llvm-cov` for coverage with `RUSTFLAGS=deny(warnings)` and includes a **zsh-rprompt performance gate** (`./scripts/benchmark.sh --threshold 60 zsh rprompt`).
- **Agent behavior evals** (`benchmarks/`, TypeScript): a `task.yml` + CSV harness with parallelism, timeouts, regex/shell validations and timestamped debug logs; 14 evals target agent *behaviour*, e.g. `read_over_cat`, `search_over_find`, `redundant_cd_with_cwd`, `patch_exact_match`, `multi_file_patch`, `refactoring_uses_patch`, `todo_write_usage`, `parallel_tool_calls`, `commit_no_markdown`, `create_skill`, `sem_search`, `semantic_search_quality`, `suggest`, `echo`. Notably `redundant_cd_with_cwd/task.yml` sets `FORGE_DEBUG_REQUESTS` to dump the outgoing request JSON and then asserts with `jq` that no `shell` call contains `cd` when `cwd` is set.
- **Crate-level specs**: `crates/forge_app/src/orch_spec/` runs the orchestrator through a test runner with snapshot assertions on the assembled system prompt; `forge_test_kit` provides `fixture!` macros; `crates/forge_json_repair/tests/` has 11 suites (quotes, unicode, truncation, punctuation, numbers, ...).
- **Dependency-isolation policy**: `forge_select` wraps `dialoguer` so no other crate depends on it; `forge_template`/`forge_embed` centralise Handlebars rendering and embedded assets; `forge_tool_macros` is the compile-time description injector.
- **In-repo design process**: `plans/` (23 plans) with a naming convention `YYYY-MM-DD-task-vN.md` produced by the project's own `create-plan` skill and validated by a skill-provided shell script; `AGENTS.md` prescribes error-handling, test-structure, docs and service-architecture conventions (no service-to-service dependencies, no `Box<dyn>`, one infra type parameter).

---

## 2. Common patterns shared with typical coding agents

These are the conventions Forge shares with the rest of the field (Claude Code, Codex, OpenCode, Cursor-style agents). They are listed so the genuinely novel parts in section 3 stand out, and so a reader can see which parts of Forge are "standard equipment".

| Pattern | Forge evidence |
|---|---|
| ReAct-style loop: model → tool calls → tool results → repeat until stop | `crates/forge_app/src/orch.rs` |
| Standard tool vocabulary (read/write/edit/search/shell/todo/subagent/web-fetch) | `crates/forge_domain/src/tools/catalog.rs` |
| Lazy "skill"/prompt-pack loading through a fetch tool (progressive disclosure) | `skill` tool + `SKILL.md` files |
| Agents/subagents delegating work, with parallel fan-out and resumable sessions | `task` tool (`tasks[]`, `agent_id`, `session_id`) |
| Project instruction files loaded automatically | `AGENTS.md` discovery in `crates/forge_services/src/instructions.rs` |
| Markdown + YAML front-matter definitions for behaviours | `agents/*.md`, `SKILL.md`, `.forge/commands/*.md` |
| MCP client support with local/global config merge | `crates/forge_services/src/mcp/`, `.mcp.json` |
| Multi-provider abstraction with streaming, retries/backoff, prompt caching, reasoning/thinking handling, and per-vendor quirks | `crates/forge_repo/src/provider/*`, `crates/forge_app/src/dto/*` |
| Session persistence with list/resume/rename/delete and token+cost metrics | SQLite conversation store + `forge conversation *` |
| Automatic context compaction with thresholds | `Compact` config + `CompactionHandler` |
| Human-in-the-loop permission prompts and allow-lists | restricted mode + policy engine |
| Todo list to structure multi-step work, with reminders when unfinished | `todo_write`/`todo_read` + `PendingTodosHandler` |
| Conventional-commit generation from the staged diff, shell-command suggestion, PR-description skill | `forge commit`, `forge suggest`, built-in `github-pr-description` skill |
| One-shot (`-p`) and headless/piped modes, machine-readable output (`--porcelain`) | `crates/forge_main/src/cli.rs` |
| Image/PDF reading for vision models, truncated large outputs spilled to temp files | `tool_services/fs_read.rs`, `truncation/*` |
| Enforced "read before edit", exact-string patching with `replace_all` | `fs_patch`/`fs_write` descriptions and guards |
| Git-worktree sandboxing for safe experiments | `--sandbox` (`crates/forge_main/src/sandbox.rs`) |
| Undo/rewind of applied edits | `undo` tool + `SnapshotRepository` |
| Telemetry with an opt-out flag, structured logs, auto-update | `forge_tracker`, `FORGE_TRACKER`, `forge update` |
| Repo-committed prompt/description assets | `templates/`, `tools/descriptions/*.md` |

## 3. UNIQUE capabilities (with evidence and why they matter)

1. **Compile-time tool descriptions that are runtime Handlebars templates.**
   `crates/forge_tool_macros/src/lib.rs` (`#[tool_description_file = "..."]` reads markdown at compile time), `crates/forge_domain/src/tools/descriptions/*.md`, rendered by `TemplateEngine` with `{{tool_names.*}}`, `{{config.*}}`, `{{env.cwd}}`, model-capability conditionals.
   *Why it matters:* tool documentation can branch on agent tool-set, model modality and config limits without duplicating text, and remains a reviewable markdown file under version control.

2. **Deterministic (non-LLM) compaction with extended-thinking preservation.**
   `crates/forge_app/src/compact.rs` + `crates/forge_domain/src/compact/{summary,strategy}.rs`; the last reasoning block is re-injected into the first surviving assistant message.
   *Why it matters:* compaction is fast, free, reproducible and reviewable, and does not break Anthropic/Google signature-validated thinking chains.

3. **A real policy engine over four operation classes with boolean composition.**
   `crates/forge_domain/src/policies/{policy,rule,engine,operation}.rs` (`Allow|Deny|Confirm` × `read|write|command|url` globs, composed with `all`/`any`/`not`), enforced pre-execution in `ToolRegistry::check_tool_permission`.
   *Why it matters:* safety policy becomes declarative configuration ("allow `cargo *` in this dir, confirm everything else") instead of hard-coded prompts or blanket yolo/dangerous modes.

4. **Patch self-healing: exact match → fuzzy line-range fallback → text-patch gRPC fallback, then remote syntax validation.**
   `crates/forge_services/src/tool_services/fs_patch.rs` (`apply_replace_operation`, `use_text_patch_fallback`, `validate_file`).
   *Why it matters:* small model/whitespace/CRLF mistakes no longer waste a full turn — and post-edit syntax errors are fed straight back to the model as tool output.

5. **Snapshot-based file undo exposed as a tool.**
   `SnapshotRepository::insert_snapshot` is called before every mutating write (`fs_patch.rs`, `fs_write.rs`, `fs_remove.rs`), and `fs_undo` reverts the latest operation per file.
   *Why it matters:* the agent can recover from its own bad change mid-task without asking the user to run git commands — a cheap, high-value safety net.

6. **Agents are first-class tools, gated by config, and resumable.**
   `TaskInput{tasks, agent_id, session_id}` in `catalog.rs`; `AgentExecutor` runs them in parallel; `config.subagents` toggles the `task` tool (with `sage` available instead of it when off) and `config.research_subagent` gates Sage, with `tool_registry.rs` filtering research agents out of the `task` description when disabled.
   *Why it matters:* orchestration patterns (research → plan → implement) are expressed in configuration and prompts, not hard-coded pipeline stages.

7. **A lifecycle-hook architecture where an `End` hook can re-open the loop.**
   `crates/forge_domain/src/hook.rs` + `crates/forge_app/src/hooks/` (`doom_loop`, `pending_todos`, `compaction`, `title_generation`, `tracing`); `Orchestrator::run` re-enters the loop when the End hook appends messages.
   *Why it matters:* guardrails such as "do not stop with unfinished todos" and "stop repeating the same tool call" are composable policies rather than prompt-only hope.

8. **Doom-loop detection over tool-call signature repetition (consecutive and cyclic).**
   `crates/forge_app/src/hooks/doom_loop.rs` (threshold 3, suffix-based pattern matching) injecting `templates/forge-doom-loop-reminder.md` at `Request` time.
   *Why it matters:* catches the most common token-burning failure mode (A,A,A and A,B,C,A,B,C) and nudges the model instead of aborting the session.

9. **Behavioural evaluation harness that asserts on the outgoing provider request.**
   `benchmarks/` (`task.yml`, CSV sources, `parallelism`, `timeout`, regex/shell validations) and e.g. `benchmarks/evals/redundant_cd_with_cwd/task.yml` which dumps `FORGE_DEBUG_REQUESTS` context JSON and validates it with `jq`.
   *Why it matters:* prompt/tool-contract regressions are caught automatically — the agent's *tool-use hygiene* becomes a testable property across models.

10. **CI, release and bot workflows generated from a typed Rust DSL.**
    `crates/forge_ci/src/workflows/*.rs` using `gh_workflow` (`Generate::new(workflow).name("ci.yml").generate()`), covering CI, autofix, bounty, labels, release-drafter, release-publish, stale.
    *Why it matters:* workflow logic is type-checked, refactorable and reviewable in the same language as the product, with generated YAML checked in.

11. **Shell-integration-first UX: ZSH `:`-prefix agent, `@[file]` tagging, and `forge select` porcelain pickers driving it.**
    `shell-plugin/` + `crates/forge_main/src/zsh/` + `SelectCommand` in `cli.rs`; buffer path formatting is delegated to Rust (`forge zsh format --buffer`) "where the logic is well-tested across all terminal environments".
    *Why it matters:* the agent is usable without leaving the shell, and the Rust side owns the fiddly terminal logic rather than shell scripts.

12. **Skills as folders with bundled resources, mandatory validator scripts, and four precedence layers including `~/.agents/skills`.**
    `crates/forge_repo/src/skill.rs` (resources walked recursively, `{{local_skills_path}}` substitution); `.forge/skills/create-plan/SKILL.md` mandates running `validate-plan.sh`.
    *Why it matters:* skills carry executable verification, and the `~/.agents/skills` layer makes the same skill directory work across different agent products.

13. **Robust tool-call JSON handling as its own crate.**
    `crates/forge_json_repair/` (`json_repair`, `coerce_to_schema`) with 11 test suites (`truncation.rs`, `special_quotes.rs`, `numbers.rs`, ...), used by `tools/call/args.rs`.
    *Why it matters:* models emit malformed/truncated JSON frequently; repairing and schema-coercing it converts a failed turn into a successful one.

14. **MCP trust gate keyed by config content hash with persisted accept *and* reject decisions.**
    `crates/forge_services/src/mcp/manager.rs` (`apply_trust_gate`, `McpTrustStore`).
    *Why it matters:* cloning an untrusted repository cannot silently spawn MCP servers, and a rejection is remembered instead of re-prompting on every start.

15. **Terminal command trace and external-change awareness fed into the prompt.**
    `user_prompt` templates inject `<command_trace>` of shell commands the user ran (via the ZSH plugin), and `ChangedFiles` detects files modified outside the agent.
    *Why it matters:* the agent understands what the user just did in their shell, and stops operating on stale assumptions after external edits.

16. **Workspace semantic index as a first-class, gated capability.**
    `crates/forge_services/src/context_engine.rs` (ancestor-workspace resolution, `is_indexed`, `is_authenticated`), and `sem_search` only appears in the tool list when indexed *and* authenticated (`tool_registry.rs`).
    *Why it matters:* tools are advertised only when actually usable, avoiding a whole class of "tool cannot run" turns; and semantic search is scoped to the nearest indexed ancestor directory.

## 4. Docs-worthy items (with proposed one-line names)

1. **Agent loop and lifecycle hooks** — "Turn loop, transformers and the six lifecycle events" (`orch.rs`, `hook.rs`).
2. **Hook guardrails** — "Doom-loop, pending-todos, compaction and title hooks" (`hooks/`).
3. **Tool description engineering** — "Handlebars tool descriptions with compile-time markdown and a 1024-char limit" (`forge_tool_macros`, `docs/tool-guidelines.md`).
4. **Policy engine reference** — "`allow`/`deny`/`confirm` policies with `all`/`any`/`not` over read/write/command/url globs".
5. **Patch resilience** — "Exact → fuzzy → text-patch fallbacks and post-write validation" (`fs_patch.rs`).
6. **Snapshot & undo model** — "How `undo` restores files" (`SnapshotRepository`, `fs_undo.rs`).
7. **Compaction internals** — "Deterministic summaries, eviction/retention windows and reasoning preservation" (`compact.rs`, `compact_config.rs`).
8. **Agents, subagents and `task`** — "Defining agents and delegating with resumable sessions" (`agent_definition.rs`, `catalog.rs`).
9. **Skills format & precedence** — "`SKILL.md`, bundled resources and the four lookup layers" (`skill.rs`).
10. **Provider catalogue extension** — "Adding a provider via `forge.toml` `[[providers]]` with Handlebars URL templates" (`forge_config/src/config.rs`).
11. **MCP trust and OAuth** — "Trust gating, scopes and `forge mcp login`" (`mcp/manager.rs`).
12. **Behavioural evals** — "Writing `task.yml` evals that assert on request payloads" (`benchmarks/README.md`).
13. **Generated CI** — "Editing CI as Rust in `forge_ci` instead of YAML" (`forge_ci/src/workflows/`).
14. **JSON repair contract** — "How malformed tool-call JSON is repaired and coerced" (`forge_json_repair`).
15. **Sessions & metrics** — "Conversation storage, token/cost metrics and HTML/JSON dumps".

## 5. Optimisation ideas worth adopting into another agent

**Accuracy / robustness**
1. **Repair-then-retry tool args** — run every tool-call argument blob through a JSON repair + JSON-Schema coercion pass (Forge's `forge_json_repair`) before rejecting a turn; measure with a truncation suite like theirs.
2. **Post-write validation feedback loop** — validate syntax after each write and append the diagnostics to the tool result (Forge calls a validation service; a local parser/LSP would do).
3. **Fuzzy/structural edit fallback ladder** — exact match, then line-range fuzzy match, then patch-synthesis, with a clear "file may have changed externally, re-read" error (Forge's `fs_patch` messages are exemplary).
4. **Deterministic compaction instead of summarisation LLM calls** — fold tool history into structured summaries (files touched, searches run) and keep the last reasoning block for signature validity; cheaper and non-lossy for tool facts.
5. **Doom-loop detection over tool-call signatures** — a ~150-line suffix-pattern matcher plus an injected reminder catches the most expensive failure mode without user intervention.
6. **Per-tool failure budgets with "attempts left" in the error text** — Forge appends a rendered retry reminder to each failed tool result and forces completion after N failures, which stops infinite retry storms.
7. **External-change awareness** — diff the tracked file state before each turn and tell the model which files changed on disk.

**Capabilities**
8. **Snapshot-based `undo` tool** — capture pre-write content and expose revert as a tool; it removes the need for destructive git operations and makes agent self-correction cheap.
9. **Agents-as-tools with parallel `tasks[]` and a resumable `session_id`** — a small schema that unlocks research/plan/implement fan-out without bespoke orchestration code.
10. **Hook-driven "cannot stop early" guard** — an end-of-turn hook that re-opens the loop when todos remain unfinished is far more reliable than prompt instructions alone.
11. **Shell integration (`:` prefix, `@[file]` tagging, buffer hand-off for `:commit-preview`)** — the single biggest UX differentiator for terminal users; delegating buffer formatting to the compiled binary avoids shell-quoting bugs.
12. **Skill format with bundled resources + mandatory validator scripts** — makes skills executable procedures rather than prose, and the `~/.agents/skills` layer gives cross-product reuse.
13. **Policy DSL for permissions** — expressible allow/deny/confirm rules with boolean composition and directory scoping give enterprise-grade control with a tiny implementation.
14. **MCP trust gate keyed by content hash** — cheap protection against untrusted-repo tool execution; remember rejections to avoid prompt fatigue.
15. **Behavioural evals that assert on the outgoing request** — treat "did the agent use `read` rather than `cat`? did it pass `cwd`?" as CI-checked properties, per model.

**Speed / cost**
16. **Advertise tools conditionally** — omit `sem_search` when no index/auth, omit `task` when subagents are off, and filter tool docs by agent allow-list; smaller tool schemas measurably cut prompt tokens and improve selection accuracy.
17. **Model-aware transformer chains** — drop reasoning details and reasoning-only messages for non-reasoning models, normalise signatures on model switch, and adapt per vendor (Forge's `dto/*/transformers`) to avoid wasted prompt tokens and hard API errors.
18. **Aggressive output truncation with temp-file spillover** — truncate shell output by prefix/suffix lines and long lines, spilling the full text to a file the agent can grep/read on demand.
19. **Prompt-cache-aware request shaping** — stable ordering (`SortTools`), cache markers (`set_cache`) and system-message merging options for providers that reject mid-conversation system messages.
20. **Config-driven concurrency and batching** — `max_parallel_file_reads`, `max_file_read_batch_size`, batch workspace sync, and `forge data --concurrency` show how to turn sequential loops into bounded-concurrency pipelines.

---

### Coverage appendix: NOT READ (and why)

The full list is in section 0.4. In short: the 170 Insta `*.snap` snapshots (generated artefacts, used as evidence of *what is asserted*, not read end-to-end), `Cargo.lock`, `package-lock.json`, `forge.schema.json` (31 KB machine-generated schema, inspected structurally), image/binary assets (`crates/forge_main/src/banner`, `.html`/`.css` fixtures), `crates/forge_markdown_stream` (skimmed: ANSI markdown streaming library), `crates/forge_walker`/`forge_fs` internals (behaviour confirmed via call sites), and the `crates/forge_repo/src/database/schema.rs` Diesel-generated file.

