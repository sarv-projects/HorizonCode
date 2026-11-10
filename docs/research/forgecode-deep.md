# forgecode deep dive, Grok Build TUI deep dive, and a product README plan for HorizonCode

Research report. Read-only: no repository was modified. Written 2026-11-09.

- Source A: [`tailcallhq/forgecode`](https://github.com/tailcallhq/forgecode/tree/a22b49288856d5b3f3ca57e8532683d54a662c8c) (tailcallhq/forgecode, commit `a22b492`, 2026-10-31). Rust 2024, toolchain 1.99, 26 crates, 134,495 Rust lines, 2,683 `#[test]`/`#[tokio::test]` functions, 170 insta `.snap` files.
- Source B (added by steering): [`crates/codegen/xai-grok-pager*`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen) (glob; see the `crates/codegen` directory) and friends (the Grok Build TUI).
- Target: this repository (HorizonCode) on `main` 79f525c (TS/Bun `app/` 35,594 lines with zero runtime dependencies; Rust `kernel/src` 7,070 lines).
- Dedup baseline: `docs/30-steal-list.md` (incl. §5), `docs/audit/audit-forgecode-report.md` (a prior full forgecode audit of the SAME commit `a22b492`, 20 "optimisation ideas"), `research/*.md`, `docs/24-feature-catalog.md` NF numbers. Items already there are only cross-referenced, not re-argued.

## 0. Method, coverage, and honesty notes

What was actually read (not summarised from the earlier audit):

- Whole of: `README.md` (1,159 lines), `AGENTS.md`, `docs/tool-guidelines.md`, `forge.schema.json` (every top-level property), [`forge_config/.forge.toml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_config/.forge.toml) (the real defaults), `insta.yaml`, `Cross.toml`, `flake.nix`, `package.json`, `.github/workflows/{ci,release}.yml`, [`scripts/benchmark.sh`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/scripts/benchmark.sh), [`benchmarks/README.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/README.md) + three eval definitions + `task-executor.ts`/`verification.ts`.
- Whole of: the three agent definitions (`forge.md`, `sage.md`, `muse.md`), all 12 `templates/*.md`, the tool description markdown (`fs_patch`, `fs_multi_patch`, `fs_read`, `fs_search`, `shell`), `permissions.default.yaml`, `provider.json` (48 providers).
- Read in full or in the load-bearing parts: [`forge_app/src/orch.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/orch.rs) (the loop), `compact.rs`, [`hooks/doom_loop.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/hooks/doom_loop.rs), [`hooks/compaction.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/hooks/compaction.rs), `tool_executor.rs` (read-before-edit), `tool_registry.rs` (policy check, timeout), `system_prompt.rs`, [`forge_domain/src/tools/catalog.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/catalog.rs), `policies/{engine,rule}.rs`, `forge_services/src/{policy,instructions}.rs`, `tool_services/{fs_patch,shell}.rs`, `file_tracking.rs`, `search_dedup.rs`, [`forge_domain/src/compact/compact_config.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/compact/compact_config.rs), [`forge_json_repair/src/lib.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/src/lib.rs) + `schema_coercion.rs` header, `forge_snaps`, `forge_spinner`, `forge_markdown_stream` (lib + Cargo), `forge_display/diff.rs`, [`forge_main/src/sandbox.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_main/src/sandbox.rs), `cli.rs` command tree, `shell-plugin/` (README, `context.zsh` in full; file sizes of the rest), the provider transformer file lists, the DB schema and migration list.
- Surveyed by file list, size and header only: the remaining ~100k lines (provider wire codecs, `ui.rs` ~4.9k lines, completer, `forge_repo` conversation records, eventsource, walker, fs, infra, tests/fixtures). Claims about those parts are limited to what their names, headers, Cargo manifests and the prior audit support. This is a deep read of every subsystem the brief names, not a literal line-by-line read of 134k lines. No line-level claim below was taken from the prior audit without checking it against source, except where marked "(prior audit)".

Measurements in this document that I took myself (2026-11-09, this sandbox: x86_64, 8 cores, Bun 1.2.14, release `hz-kernel` prebuilt, HOME redirected to a scratch dir, scratch dir deleted afterwards):

- `printf 'list files' | ./bin/hzcode` (mock model, one glob tool call, kernel spawn, receipt written), wall clock, n=10: 0.213 to 0.225 s, median 0.216 s.
- `hz-kernel --selftest`: `SELFTEST OK (25 checks)` in 0.003 s.
- Release `kernel/target/release/hz-kernel`: 1,156,816 bytes.

Everything else numeric about HorizonCode is quoted from its own README / `docs/28` and has NOT been re-run here (the full `bun test` / `cargo test` / `gates.sh` were not executed in this pass). Re-run before any number is published (see §8).

## 1. forgecode in one page

ForgeCode ("Forge") is a single-binary Rust coding agent for the terminal whose distinguishing product bets are (a) a ZSH-first workflow (`:` prefix commands at the shell prompt), (b) an unusually engineered tool contract (templated tool descriptions, exact-match edits with fallbacks, JSON repair, deterministic compaction), (c) behavioural evals that assert on the outgoing request, and (d) a very wide provider list (48 entries in `provider.json`). It is NOT a sandboxed or audited runtime: the permission engine is opt-in (`restricted = false` by default) and the default policy file allows everything.

### 1.1 Crate map (26 crates; Rust lines)

| Crate | Lines | Purpose and key types |
|---|---|---|
| `forge_app` | 34,987 | Application layer. `Orchestrator` (`orch.rs`, the loop), `Compactor`, `SystemPrompt`, `ToolRegistry`/`ToolExecutor`, hooks (`doom_loop`, `pending_todos`, `compaction`, `title_generation`, `tracing`), request DTOs and per-vendor transformers (`dto/{openai,anthropic,google}`), `file_tracking`, `search_dedup`, `retry`, `truncation/`. |
| `forge_domain` | 25,113 | Types only. `Agent`, `Conversation`, `Context`, `ToolCatalog` (15-variant enum, JSON-schema via schemars), `Compact`, `Hook`/`LifecycleEvent`, `policies/` (`Policy`, `Rule`, `PolicyEngine`), `Skill`, `Provider`, `Transformer` trait, reasoning types. |
| `forge_main` | 17,499 | CLI/TUI binary. `cli.rs` (clap tree), `ui.rs` (~4.9k, the REPL), `stream_renderer.rs`, rustyline-based editor, completer, `zsh/` (plugin generator, rprompt), `sandbox.rs` (git worktree), `update.rs`, `vscode.rs`. |
| `forge_repo` | 19,902 | Persistence + providers. Diesel/SQLite conversations, `provider/` (openai, openai_responses, anthropic, google, bedrock, opencode, `provider.json`), agent/skill loaders, gRPC clients ([`proto/forge.proto`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_repo/proto/forge.proto): fuzzy search, text patch, validation, workspace index). Embeds 3 agents and 3 skills. |
| `forge_services` | 11,149 | Service impls: `tool_services/*` (fs read/write/patch/search/remove/undo, shell, fetch, image read, skill, plan, followup), `policy.rs`, MCP manager/service, `instructions.rs` (AGENTS.md discovery), provider auth, context_engine (hosted semantic index), `permissions.default.yaml`. |
| `forge_infra` | 6,481 | IO: fs primitives, command executor, HTTP, gRPC, MCP stdio/SSE clients, OAuth (`auth/`), kv storage, console. |
| `forge_markdown_stream` | 3,839 | Streaming markdown to ANSI (built on `streamdown-*`, syntect, `terminal-colorsaurus` for theme detection), `repair_line`, tables, lists, code. |
| `forge_json_repair` | 3,709 | `json_repair` + `coerce_to_schema` (string "42" to 42 etc.) for malformed/truncated tool-call arguments. |
| `forge_select` | 2,058 | Interactive pickers (select, multi, confirm, input, preview) on nucleo + rustyline + crossterm. |
| `forge_config` | 1,775 | `ForgeConfig` (serde + schemars to `forge.schema.json`), TOML reader/writer, legacy migration, retry/http/compact/reasoning sub-configs. Defaults in `.forge.toml`. |
| `forge_display` | 1,020 | `DiffFormat` (similar crate, gutters, "No changes applied"), grep/code/markdown display. |
| `forge_ci` | 916 | The CI/release/bot workflows written as Rust (`gh-workflow`), generating `.github/workflows/*.yml`. |
| `forge_eventsource` + `_stream` | 1,454 | SSE client. |
| `forge_walker` | 784 | Gitignore-aware file walk. |
| `forge_tracker` | 853 | PostHog telemetry (`https://us.i.posthog.com/capture/`), enabled by default, `FORGE_TRACKER=false` to enrich less. |
| `forge_fs`, `forge_spinner`, `forge_snaps`, `forge_template`, `forge_tool_macros`, `forge_stream`, `forge_embed`, `forge_api`, `forge_test_kit` | 39 to 771 each | Small utilities. `forge_snaps` is the pre-write file snapshot store behind `undo`. `forge_tool_macros` reads tool description markdown at compile time. |

### 1.2 Agent loop ([`forge_app/src/orch.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/orch.rs))

Per turn: fire `Start` hook; `while !should_yield`: persist conversation; fire `Request` hook (doom-loop detector runs here); `retry_with_config(...)` around one streamed chat call with a transformer pipeline (`SortTools`, `NormalizeToolCallArguments`, `TransformToolCalls` when the model has no native tool support, `ImageHandling`, `DropReasoningDetails`, `ReasoningNormalizer` on model switch, `ModelSpecificReasoning` + `DropReasoningOnlyMessages` for Claude); fire `Response` hook (compaction runs here); execute tool calls; append results; per-tool failure tracker appends a rendered "attempts remaining" block to every failed result and forces a yield at `max_tool_failure_per_turn = 3`; stop when `finish_reason == Stop` and no tool calls, or when a `Followup` tool asks the user, or at `max_requests_per_turn` (100 by default, asks the user whether to continue).

Facts that differ from the impression the README gives:

- Only `task` (sub-agent) calls run in parallel (`join_all`); every other tool call in a response executes SEQUENTIALLY (`orch.rs`, `execute_tool_calls`), because of a UI handshake (`ToolCallStart` + `Notify`). The prompts still tell the model to batch independent calls. HorizonCode's classed batch scheduler (NF-072) is strictly more capable.
- The "ends the turn" decision is the provider's `finish_reason`, with a special case for Gemini (stop plus tool calls).
- Tool timeout default 300 s, enforced by `tokio::time::timeout`; sub-agents are exempt.

### 1.3 Tool set and schemas (`ToolCatalog`, 15 variants + MCP)

`read` (path, optional start/end line; images/PDF when the model has vision; 2,000 lines / 2,000 chars per line caps), `write` (overwrite flag), `fs_search` (ripgrep engine in-process via `grep-*` crates; output modes content / files_with_matches / count; glob and type filters; multiline), `sem_search` (hosted, only advertised when indexed AND authenticated), `remove`, `patch` (single exact `old_string`/`new_string` + `replace_all`), `multi_patch` (atomic list of edits on one file), `undo`, `shell` (`command`, `cwd`, `keep_ansi`, `silent`, `env`, `description`), `fetch`, `followup` (ask user), `plan` (writes `plans/<date>-<name>-v<N>.md`), `skill`, `todo_write` (add/update/remove with ids and status), `todo_read`, `task` (parallel `tasks[]`, `agent_id`, resumable `session_id`).

Notable contract details worth knowing:

- Tool descriptions are Handlebars templates compiled in as markdown (`{{tool_names.read}}`, `{{config.maxReadSize}}`, `{{#if (contains model.input_modalities "image")}}`), rendered per agent/model, with a test enforcing <= 1024 chars each (`docs/tool-guidelines.md`).
- The shell description FORBIDS `cd` (use `cwd`), forbids `find/grep/cat/head/tail/sed/awk/echo` in favour of dedicated tools, and tells the model NOT to pipe through `head/tail` because output is truncated head+tail (100 + 100 lines, 500 chars per line) with the full text spilled to a temp file readable via `read` ranges.
- Read-before-edit is enforced in code (`tool_executor.rs::require_prior_read` against `metrics.files_accessed`), not just in the prompt.
- `ToolCatalog::to_policy_operation` maps every tool call to one of four permission operations: read / write / execute / fetch.

### 1.4 Edit format and engine

Format: exact string replacement. `patch` = one `{old_string, new_string, replace_all}`; `multi_patch` = sequential edits applied to the in-memory result, atomic (any failure writes nothing). Engine (`fs_patch.rs`, 1,398 lines of which ~800 are tests): CRLF-aware (`detect_line_ending`, search normalised to the file's EOL), `Replace` requires uniqueness (`MultipleMatches` error), `ReplaceAll`, plus unused-by-the-tool internal operations (Prepend/Append/Swap). On a miss it falls back to a REMOTE call: `fuzzy_search` over gRPC (`use_text_patch_fallback = false`) or the newer `build_text_patch` gRPC. After the write it calls a REMOTE `validate_file` and appends syntax errors to the tool output ("graceful failure": errors are ignored if the service is down). A snapshot is inserted before every write for `undo`. Compared with HorizonCode's local ladder (exact, relative-indent, unicode-fold, 3-way, line-patch, each only when unique, CRLF-safe, sha256 preimage check) forgecode's engine is simpler locally and depends on a hosted service for resilience. Nothing to take from the matcher; the take-aways are the post-write feedback pattern (HorizonCode already has the LSP loop) and the atomic multi-edit shape (HorizonCode `edit` ladder; check whether a `multi_edit` batch exists: `docs/09` lists `multi_edit` as designed).

### 1.5 Prompts and templates (`templates/`, `forge_repo/src/agents/*.md`)

- System prompt = agent markdown body (Handlebars) + partials: `forge-partial-system-info.md` (OS, cwd, shell, home, optional `<file_list>`, `<workspace_extensions>` from `git ls-files` top 15 extensions with percentages), tool-usage block (switches to an XML `<forge_tool_call>` text protocol when `tool_supported = false`, parsed by a nom parser in [`forge_domain/src/tools/call/parser.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/call/parser.rs)), `<project_guidelines>` from `custom_rules` + AGENTS.md files (global `~/.forge/AGENTS.md`, git root, cwd; three files, no caps, no nesting), and `<non_negotiable_rules>` (no unrequested files/docs, `path:line` citation format, no emojis).
- Per-turn user prompt is also an agent-level template: `<{{event.name}}>{{event.value}}</...>`, `<system_date>`, and `<command_trace>` (the last N shell commands with exit codes captured by the zsh plugin) when terminal context is on.
- Behavioural reminders are templates: doom-loop ("You appear to be stuck in a repetitive loop, having made N similar calls..."), pending-todos ("Please complete all pending items before finishing"), tool retry ("Attempts remaining: N"), tool error reflection ("You must now deeply reflect on the error above..."), summary frame (compaction), title generation, commit-message and command-generator prompts.
- Per-agent specialisation is by markdown front-matter: `id`, `title`, `description` (which doubles as the `task` tool's routing description), `reasoning`, `tools` (list with globs such as `mcp_*`), `user_prompt`, plus optional model/provider/compact/temperature overrides. There is NO per-model prompt file selection (contrast codex); model differences are handled by request transformers, not prompt text.

### 1.6 Agents

| Agent | Tools | Role |
|---|---|---|
| `forge` | task, sem_search, fs_search, read, write, undo, remove, patch, multi_patch, shell, fetch, skill, todo_write, todo_read, `mcp_*` | Implements. Prompt pushes heavy todo use ("VERY frequently"), semantic search first, parallel calls. |
| `sage` | sem_search, search, read, fetch | Read-only deep research; exposed to `forge` as a tool when `research_subagent = true`. Output contract: Research Summary / Key Findings / Technical Details / Insights / Follow-up, citations as `file:line`. |
| `muse` | sem_search, sage, search, read, fetch, plan, `mcp_*` | Planner. Writes checkbox plans to `plans/`; the repo's own `plans/` folder (24 dated files) is dogfood output. Pairs with the built-in `execute-plan` skill. |

Custom agents: same markdown format in `.forge/agents/` (project) or `~/forge/agents/`. `:sage`/`:muse` shell commands switch the active agent.

### 1.7 Providers and routing

`provider.json` lists 48 providers over 7 wire types: OpenAI chat (most), OpenAI Responses, Anthropic, Google, Bedrock, OpenCode, plus `forge_services`. Auth methods are data: `api_key`, `oauth_code` (PKCE), `oauth_device`, `codex_device`, `google_adc`, `aws_profile`; URL templates are parameterised by `url_param_vars` (`OLLAMA_HOST`/`PORT`/`SSL_SCHEME`, `AZURE_*`, `PROJECT_ID`/`LOCATION`). Users extend via `providers` in config (merged by `id`). Routing is explicit, not automatic: a global `session` (provider+model), per-agent overrides, plus separate `commit` and `suggest` model slots; no cost/latency router. Wire-level quirks are handled by small composable `Transformer`s (`.pipe(...)`/`.when(...)`): cerebras (no `parallel_tool_calls`), xai compat, minimax, zai reasoning, github-copilot reasoning flattening, trim/sanitise tool-call IDs (Bedrock, Anthropic), capitalise tool names, drop invalid tool calls, enforce schema, ensure-system-first/merge system messages, strip thought signatures, normalise tool schemas, two-breakpoint cache markers (Bedrock/Anthropic/OpenAI `set_cache`).

Subscription-OAuth providers (`claude_code`, `codex`, `github_copilot`) reuse other vendors' first-party client IDs and spoof their headers (`originator: forge`, `GitHubCopilotChat/0.26.7`, `claude_code.md` system prefix). That is a policy and ToS risk, listed under NOT-WORTH.

### 1.8 Config (`forge.schema.json`, `.forge.toml`)

50 top-level keys in `forge.schema.json`. Real defaults (README is stale on several): retry `max_attempts = 8` (README env table says 3), `initial_backoff_ms = 200` (README 1000), statuses `[429,500,502,503,504,408,522,524,520,529]`; compaction `token_threshold = 100000`, `message_threshold = 200`, `retention_window = 6`, `eviction_window = 0.2`; `max_requests_per_turn = 100`; `max_tool_failure_per_turn = 3`; `tool_timeout_secs = 300`; `verify_todos = true`; `subagents = true`; `research_subagent = false`; `restricted = false`; `auto_update = true` daily; `use_forge_committer = true`; `terminal_context = false`. Config file layering: TOML in the base dir (`FORGE_CONFIG`, default `~/.forge`; README alternately says `~/forge/.forge.toml`), plus env overrides, plus legacy `.env` auto-migration into file-based credentials. `forge.schema.json` is generated from the Rust structs via schemars (good editor UX).

### 1.9 Permission and approval model

`PolicyEngine` over four operation classes (read/write/command/url globs, optional `dir`), results Allow / Deny / Confirm, composition `all`/`any`/`not`. Evaluation: first Deny or Confirm wins; otherwise the last Allow; no match means Confirm. Confirm prompts Accept / Reject / "Accept and Remember" (appends a policy to `permissions.yaml`). BUT: the engine runs only when `restricted = true` (`tool_registry.rs:144`), the default is false, and the embedded default policy allows `**/*` read/write, `*` command and `*` url. There is no OS sandbox. `forge --sandbox <name>` is a git worktree + branch in the parent directory (isolation of changes, not of authority). The shell tool description still mentions a `-u` flag for "unrestricted" that no longer maps to a documented option. The README line "Secure by design - Restricted shell mode limits file system access" is not what the defaults do.

### 1.10 Context compaction

Deterministic, no LLM call (the `model` field in `Compact` exists but this path does not use it). Trigger on `Response` hook: any of token threshold (min of absolute and percentage-of-window), turn threshold, message threshold, optional on-turn-end. Algorithm: choose an eviction range by `min(eviction 20%, retention window 6)`, drop droppable messages (attachments), build a `ContextSummary` (per tool call: file update/read/remove, search, skill, sem_search, shell command, MCP, todo changes), then run `SummaryTransformer`: drop system role, dedupe consecutive roles, keep only the LAST operation per file path, dedupe consecutive assistant blocks, strip the cwd prefix; render `forge-partial-summary-frame.md`; splice the summary in as ONE user message that inherits the summed usage; carry forward the LAST reasoning block into the first surviving assistant message to keep Anthropic/Google signature chains valid. System prompt claims "unlimited context through automatic summarization".

### 1.11 Conversation / session storage

SQLite via Diesel, one table `conversations(conversation_id, title, workspace_id, context TEXT json, created_at, updated_at, metrics TEXT json)`; 7 migrations (workspace/indexing tables were added then dropped). The whole `Context` is a JSON blob rewritten every loop iteration (`services.update(conversation)`); there is no event log, no per-event hashing, no checkpoints. Verbs: list, new, resume, clone (branch), rename, delete, retry, compact, dump (JSON or self-contained HTML), stats, info, show. `conversation -` toggles the previous one. `FORGE_MAX_CONVERSATIONS` caps the list. Session cost is shown in the zsh right prompt with currency conversion.

### 1.12 MCP

`.mcp.json` (project) + `~/forge/.mcp.json` (global), Claude-compatible `mcpServers` schema (command/args/env or url). Commands `forge mcp list|import|show|remove|reload|login`. MCP tools appear as `mcp_*` and are granted to agents by glob. Trust gate keyed by config content hash with persisted accept and reject (prior audit; [`mcp/manager.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_services/src/mcp/manager.rs)). Stdio and SSE/HTTP transports, OAuth.

### 1.13 Shell plugin and commands

`shell-plugin/` is 1,609 lines of zsh plus `crates/forge_main/src/zsh/` Rust helpers (the Rust side formats the buffer, paste handling, rprompt, plugin install into `.zshrc` via `forge setup`). Features: `:` prefix dispatcher, agent switch (`:sage`), `@[file]` tab-completion via fd + picker, conversation verbs, `:commit` / `:commit-preview` (AI message from the diff; preview puts `git commit -m` into the buffer), `:suggest` (NL to command into the buffer), `:edit` ($EDITOR for the prompt), model/reasoning/provider session-vs-persistent commands, `:doctor` (569-line diagnostic script), keyboard shortcut help, right-prompt theme with model/tokens/cost, and terminal context: `preexec`/`precmd` ring buffer of recent commands + exit codes + timestamps, OSC 133 emission gated on terminal detection (Kitty, WezTerm, iTerm, vscode, Warp, foot, ghostty), scrollback capture via Kitty/WezTerm/tmux. Not implemented: bash, fish, PowerShell integration. [`commands/github-pr-description.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/commands/github-pr-description.md) is a markdown command definition ("custom command" format: front-matter `name`/`description`, body with `{{parameters}}`). A [`scripts/benchmark.sh`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/scripts/benchmark.sh) + CI job gates `forge zsh rprompt` latency at a 60 ms threshold over 10 runs.

### 1.14 benchmarks/ (how forgecode "measures")

It is NOT a capability benchmark. `benchmarks/` is a TypeScript (tsx) harness: `task.yml` + CSV rows + Handlebars; each row runs `forgee -p '{{prompt}}'` (optionally with `FORGE_DEBUG_REQUESTS=context.json`) in a temp dir with `parallelism`, `timeout`, `early_exit`; validations are `regex` on output or `shell` (jq over the dumped request). 14 evals test tool-use hygiene: `read_over_cat`, `search_over_find`, `redundant_cd_with_cwd`, `refactoring_uses_patch`, `patch_exact_match` (asserts no "Could not find match for search text" tool results across three models), `parallel_tool_calls` (>= 2 tool calls in one assistant message), `todo_write_usage`, `multi_file_patch`, `sem_search`, `semantic_search_quality`, `commit_no_markdown`, `suggest`, `create_skill`, `echo`. Models are routed through OpenRouter (`anthropic/claude-sonnet-4.5`, `z-ai/glm-4.6:exacto`, `minimax/minimax-m2.1`, `openai/gpt-5.2`). Statuses: passed / validation_failed / timeout / failed. No pass-rate table is committed and the README makes NO benchmark claims (no SWE-bench, no Terminal-Bench anywhere in the repo; the only hit for those strings is a model name list in `provider.json`).

### 1.15 TUI / CLI UX

Line-oriented, not full-screen: rustyline editor with custom completer/highlighter (`@[file]` tags highlighted), streamed output through `forge_markdown_stream` (syntax-highlighted code, tables, lists, `repair_line` for half-streamed markdown), a braille spinner (10 frames at 60 ms, elapsed time, "Ctrl+C to interrupt", width-truncated using `console::measure_text_width`), coloured `DiffFormat` with line gutters, picker UIs (nucleo fuzzy, with preview), ANSI banner (`FORGE_BANNER` to override), titles via `TitleFormat` ("[12:03:44] Execute ..."). No mouse, no alternate screen, no themes beyond terminal-colorsaurus light/dark detection. A VS Code extension auto-installs when run inside VS Code.

### 1.16 Tests and snapshot testing

`AGENTS.md` is the engineering contract: three-step tests (`fixture`, `actual`, `expected`), `pretty_assertions::assert_eq` on whole objects (never per-field), `Default` + `derive_setters` fixtures (`User::default().age(12)`), tests in the same file as the code, `cargo insta test --accept`, `cargo check` for verification and never `--release` for dev loops, `anyhow` in services and `thiserror` in domain, services take at most one generic infra parameter composed with `+`, no `Box<dyn>`, `///` docs on all public items "for LLMs, not humans". `insta.yaml`: `auto_accept: true`, `auto_accept_unseen: true`, runner nextest. 170 snapshots include `tool_definition_json.snap` (the full JSON schema of every tool, so any schema change shows up as a snapshot diff) and rendered tool descriptions.

### 1.17 Release and distribution

`curl -fsSL https://forgecode.dev/cli | sh` (installer script hosted outside the repo), Nix flake (4 systems), Homebrew tap and npm package (both published by `release.yml` jobs), `forge update` plus daily auto-update default. `release.yml` builds 9 targets (linux musl and gnu x86_64/aarch64, macOS x86_64/aarch64, windows msvc x86_64/aarch64, android aarch64) using `cross` (`Cross.toml` installs protoc 28.3 in each container and swaps the Ubuntu mirror), static CRT on non-Linux. Release notes via release-drafter. CI is generated from `forge_ci` (Rust) into YAML marked DO-NOT-EDIT; jobs: build/test with `cargo llvm-cov`, a zsh rprompt performance gate, draft release, bounty and label automation (a paid-bounty workflow lives in `.github/scripts/bounty`).

### 1.18 docs/ and plans/

`docs/` holds exactly one file (`tool-guidelines.md`), yet the README's Documentation section links to the folder as "comprehensive documentation". `plans/` is 24 dated Muse-generated design docs (System-context rendering, retry config migration, large-file range reads, dynamic agent slash commands, etc.): a visible dogfooding trail and a good model for a "design history" folder.

## 2. Classification of forgecode capabilities against HorizonCode

Legend: **IN** = already in HorizonCode (cited); **TAKE** = worth taking (HorizonCode area, effort S <= 1 day, M = 2 to 4 days, L = a week or more); **SKIP** = not worth it (why). Items already enumerated in `docs/30-steal-list.md` / `docs/24` are marked "(already queued: ...)" and are not re-argued.

### 2.1 ALREADY-IN-HORIZONCODE (or strictly stronger)

| forgecode capability | HorizonCode equivalent |
|---|---|
| Doom-loop detection over `[A,A,A]` and cyclic `[A,B,C]` signatures plus injected reminder | NF-073 loop rails + NF-066 doom-loop reminder (`app/src/core/guards/`, `loop.ts`); also adds budgets and a format-error corrective capped at 3 |
| Per-tool failure budget forcing completion | `core/guards/mistake-tracker.ts`, loop rails (hard verdict on the 5th) |
| Read-before-edit enforced in code | `tools/read-ledger.ts` (keyed by realpath) plus sha256 preimage check |
| Snapshot undo as a tool | `tools/undo.ts` + `tools/change-journal.ts` (durable, crash-safe, torn-tail handling) |
| Shell output truncation with spill file | NF-074 output budget + shell minimiser spilling raw bytes (`tools/shell.ts`) |
| Exact-match edit with fallbacks | NF-069 five-rung ladder, local, CRLF-safe (`tools/edit.ts`); no hosted dependency |
| Sub-agents as a tool, bounded by parent tools | `tools/agent.ts`, `core/agent-profiles.ts` (explore/plan/code/review + `.hz/agents/*.md`), `core/subagent.ts` |
| Agents as markdown with front-matter | `.hz/agents/*.md` profiles |
| AGENTS.md discovery | `core/instructions.ts` (9 file families, nesting, caps, symlink refusal): stronger than forge's 3 uncapped paths |
| Todo tools | `tools/todo.ts` |
| Plan mode (planner writes plans) | `core/plan.ts` stages writes for `/changes` and `/apply`; stronger (nothing is written) |
| Retry with backoff on provider errors | `core/providers/retry.ts` |
| MCP client with project-config safety | `core/mcp/` (user-config-only entries so a cloned repo cannot name a program; per-server concurrency, timeouts) |
| Provider catalogue as data + user extension | provider-superset: `openai-compatible` adapter, user registry, `models.dev` seam (`core/catalog/`) |
| Skills (SKILL-style workflows) | `core/skills.ts` (flat `.md`; see TAKE for folder skills) |
| Hooks lifecycle (6 events in forge) | `core/hooks.ts` hooks lifecycle superset (broader than forge's 6) |
| Headless one-shot | `hzcode -p ... --output-format text|json|stream-json` |
| Git-aware ignore handling in search | `tools/ignore.ts` |
| Parallel file reads | NF-072 classed tool batches |
| Tool timeouts | shell/code_mode budgets, owned-spawn |
| Conversation fork | `/fork` + `session.fork` (forge `clone`) |
| Structural summary (partial): paths and tools listed | `core/compaction.ts::summariseElided` (weaker: see TAKE T-7) |
| AI-written project instructions bootstrap | `/init` (forge has none) |

### 2.2 WORTH-TAKING (new relative to docs/30 §5 and research/*.md)

Ordered by value for a product-level release. Paths are HorizonCode paths. "Guard" says how the kernel invariant is preserved.

| # | Item | What forgecode does (evidence) | HorizonCode area | Effort | Guard / notes |
|---|---|---|---|---|---|
| T-1 | **Tool-argument JSON repair + schema coercion** | `forge_json_repair` (3.7k lines, ~11 test suites: truncation, special quotes, numbers) + `coerce_to_schema` turn a failed turn into a successful one | `app/src/core/loop.ts::parseArguments` (line ~210) is strict `JSON.parse`; a malformed or truncated blob is a failed turn. New zero-dep `app/src/core/json-repair.ts`; coerce against each tool's existing JSON schema | M | Already DESIGNED (NF-069, docs/10 R15: "tolerant decoding only for whitespace/escape defects, every repair counted"). Do exactly that: repair only whitespace, quotes, trailing commas, truncated tails; record `repaired: true` in the event; the receipt hashes the REPAIRED args that were admitted; never repair for `shell`/`write` when the repair would change meaning (truncation of `command` must be refused). Port forge's truncation/quotes/numbers fixtures as the test corpus |
| T-2 | **Tool-schema snapshot test** | `tool_definition_json.snap` snapshots every tool's full JSON schema; any drift is a visible diff | `app/tests/tools/`: one `bun test` snapshot of `registry.definitions()` (name, description, parameters) and one per-model rendering | S | This is the cheap first half of the designed "cache-guard test fails on prefix drift" (docs/10). Also enforce a max description length (forge: 1024 chars, tested) |
| T-3 | **Re-open the loop when todos are pending** | `verify_todos` hook appends the pending-todos reminder and re-enters the loop instead of ending | `loop.ts` ~line 1174 already turns "open todos at exit" into exit status `unknown`. Add one bounded re-entry (max 1 or 2) with a reminder BEFORE settling on `unknown` | S | Bound it (budget rails already count steps). Keep `unknown` as the terminal if the model stops again; this keeps the "no silent success" property |
| T-4 | **Failed-tool-result enrichment ("attempts remaining" + reflection)** | Every failed tool result gets a rendered `<retry>` block with attempts left; optional "reflect on the error" partial | `core/guards/mistake-tracker.ts` counts but the model is not told how many attempts remain (no such string found) | S | Pure prompt-side text, no authority change |
| T-5 | **Streaming markdown renderer for the chat** | `forge_markdown_stream`: line-buffered, syntax-highlighted code fences, tables, lists, `repair_line` for partial lines | `app/src/tui/render.ts` (276 lines) prints assistant text raw (no markdown handling found). New zero-dep `tui/markdown.ts`: line-buffered state machine, ANSI via existing `style.ts` degradation (NO_COLOR/TERM=dumb) | M | Biggest visible product gap for screenshots. See T-G2 for the stronger Grok design (checkpoint freezing) if live re-render is wanted later |
| T-6 | **Spinner with elapsed time and interrupt hint** | `forge_spinner`: 60 ms braille ticks, `12s · Ctrl+C to interrupt`, truncates to terminal width | `tui/interactive.ts` (no spinner/elapsed found by grep) | S | TTY-only; headless/print never draws it; clear on every event write |
| T-7 | **Structured deterministic compaction summary** | Summary frame lists per-file LAST operation (Update/Read/Delete), searches, shell commands, todo changes; strips cwd prefix; carries last reasoning block | `core/compaction.ts::summariseElided` lists role counts, first/last request, tool NAMES and up to N paths, but not what was done to each path or which commands ran | S-M | Keep the pinned-constraints block (stronger than forge). Add a "files touched: path (read/edit/write/delete, last op)" and "commands run: ..." section derived from tool calls. Still a pure function of (messages, limit); view not deletion |
| T-8 | **Provider quirk table** | ~20 `Transformer`s: cerebras (no parallel_tool_calls), tool-call-ID trimming/sanitising, capitalised tool names, ensure-system-first/merge system messages, schema normalisation, drop reasoning-only messages for Claude, strip thought signatures on model switch | `core/providers/openai-compatible.ts` will meet every one of these against real endpoints. Add `providers/quirks.ts`: a data table keyed by host/model pattern, applied as small pure functions; fail-loud on unknown | M | Only after a second real endpoint beyond NVIDIA NIM (CURRENT_RUN: first live run done). Record the applied quirks in the event so a run is reproducible |
| T-9 | **Behavioural eval pack that asserts on the outgoing request** | `FORGE_DEBUG_REQUESTS` dumps the request JSON; jq assertions: used `read` not `cat`, no `cd` with `cwd`, patch had no "Could not find match", >= 2 tool calls in one message | `core/evals.ts` + `eval-run.ts` exist (runner ships, head-to-head needs keys). Add `HZ_DEBUG_REQUESTS=<path>` and a tool-hygiene pack of ~8 evals runnable with the mock/scripted provider (no keys) plus a keyed variant | S-M | Gives HorizonCode a MEASURED, key-free regression suite for the README; unlike forge, it can also assert on receipts (e.g. "every admitted shell call has a receipt") |
| T-10 | **`hzcode doctor`** | `forge doctor` (zsh env) and Grok `/doctor` (terminal, color depth, clipboard, tmux, with named fixes) | New `hzcode doctor [--json]`: kernel mode (trusted/untrusted), kernel binary found and `--selftest`, state dir modes (0700/0600), provider config resolves, `sandbox.report` capability (never claiming enforcement), color depth / NO_COLOR / TTY, Bun version | S-M | Direct expression of the "honest status" ethos; its JSON output doubles as the support-ticket attachment. No auto-fix in v1 (Grok's tmux fixes edit user config; not needed) |
| T-11 | **Startup latency gate** | CI job runs `forge zsh rprompt` 10 times and fails over 60 ms (`scripts/benchmark.sh --threshold`) | `ops/gates.sh`: new gate `startup-latency` running `printf 'list files' | hzcode` n=10, fail above a generous budget (measured today: median 0.216 s; budget e.g. 0.6 s to survive CI noise) | S | Turns the Performance section into a ratcheted claim instead of a one-off number |
| T-12 | **Conversation management verbs** | clone, rename, retry last, stats (token usage), dump JSON/HTML, copy last response, `-` toggle previous | `/sessions` and `/fork` exist; add `/rename`, `/retry`, `/stats`, `/export [json|html]`, `/copy` | S each | HTML export is a natural place to show receipt chain status ("chain verified: N events") inside the exported page: a feature forge cannot have |
| T-13 | **Custom commands as files** | `.forge/commands/*.yaml|md` with `{{parameters}}`; `:name args` | `.hz/commands/*.md` (front-matter `description`, body template) exposed as `/name` in the TUI and `hzcode run name args` | S | A command is only a prompt template: it must carry no authority (same rule as instructions: conventions, never permissions) |
| T-14 | **Skill folders (`SKILL.md` + bundled resources)** | `skills/<name>/SKILL.md` with resources, precedence project > global > built-in, including `~/.agents/skills` for cross-product reuse | `core/skills.ts` loads flat `*.md`. Add folder form and read `~/.agents/skills`, [`.claude/skills`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/.claude/skills) as read-only sources | S-M | Skills stay prompt text; any script a skill references still goes through the guard |
| T-15 | **Git worktree isolation flag** | `forge --sandbox <name>` creates a worktree + branch beside the repo and starts there | `hzcode --worktree <name>`: create worktree through the guard (git is an effect, needs a receipt) | S-M | NAME IT HONESTLY: "worktree", not "sandbox". Forge's README calls it a sandbox; HorizonCode's `sandbox.report` must keep meaning OS confinement |
| T-16 | **`hzcode commit` / `suggest`** | `forge commit [--preview]` (AI message from the staged diff; optional extra context; Co-Authored-By trailer) and `forge suggest "<nl>"` | Built on the existing `-p` print mode with a fixed prompt + `git diff --staged` capture; the commit itself runs through the guard as `shell.exec` and receives a receipt | S-M | Differentiator unique to HorizonCode: optional trailer `HZ-Receipt: <chain head>` tying a commit to the audit chain. Original idea, not in any source |
| T-17 | **Status line with a JSON-on-stdin script contract** (from Grok, see §4) | Script receives session JSON on stdin, prints up to 5 lines; user-config only, never repo-settable | `tui/` status row; config key accepted only from user config (matches HorizonCode's "workspace files may only narrow" rule) | S-M | Pairs with context meter already shipped |
| T-18 | **Request transformer for models without native tools** | `tool_supported=false` switches to an XML `<forge_tool_call>` text protocol parsed by a nom parser | For small Ollama models. `core/providers/ollama.ts` could fall back to a text protocol | M | LOW priority: parser output must be treated exactly like any other model-proposed call (guard, receipt). Only if local-model support is a product pillar |
| T-19 | **Plan-file convention + execute-plan skill** | Muse writes `plans/<date>-<slug>-vN.md` with `- [ ]` tasks and verification criteria; skill `execute-plan` consumes it | Docs-level: document the `.hz/plans/` convention; make `plan` profile write there via the normal guard; ship an `execute-plan` skill | S | Costs almost nothing; gives a visible design-history trail like `plans/` |
| T-20 | **Config diagnostics: unknown-key report and generated JSON schema** | `forge.schema.json` generated from Rust (editor completion); Grok `grok inspect` lists unknown keys | Generate `hzcode.schema.json` from `core/config.ts` validators; `hzcode config check` prints unknown/rejected keys | S-M | `config.ts` already refuses silent coercion; this makes the refusal discoverable |

### 2.3 NOT-WORTH (and why)

| forgecode capability | Why not |
|---|---|
| Hosted semantic search (`sem_search`, `forge_services` provider, `api.forgecode.dev`) | Uploads file contents to a third-party server by default (README admits it). Contradicts local-first/offline posture. HorizonCode's local retrieval (BM25 + embeddings, doc 10) is the right shape; search-result dedup (`search_dedup.rs`) is irrelevant until multi-query retrieval exists |
| Remote fuzzy edit, text-patch and syntax-validation gRPC services | Hosted dependency in the edit path; fails open ("graceful failure"). HorizonCode already has the local ladder and an LSP diagnostics loop |
| Telemetry on by default (PostHog) and auto-update on by default | Opposite of the trust posture. If HorizonCode ever ships telemetry it must be opt-in; an update path should be `hzcode update --check` with digest pinning (doc 16), not silent |
| Using other vendors' OAuth client IDs and spoofed headers (`claude_code`, `codex`, `github_copilot` entries) | ToS and account-risk exposure; fragile (client IDs and header versions rotate). HorizonCode's provider doctrine is fail-loud and honest credentials (`Credential` contract). Support API keys and documented device flows only |
| Opt-in policy engine whose default is allow-all (`restricted=false`, `permissions.default.yaml`) | HorizonCode's kernel guard is default-ask with `deny > lease > ask > allow` and structural state protection. Forge's engine adds nothing except the `all/any/not` composition, which docs/11 already covers more strictly |
| Context persisted as one JSON blob rewritten every iteration | HorizonCode's hash-chained event log + SQLite sessions + checkpoints are the point of the product |
| Sequential-except-`task` tool execution | HorizonCode's classed batch scheduler is better |
| Prompt text that tells the model to "use `{{todo_write}}` VERY frequently" and to never write docs | Fine for forge's model mix; as prompt policy for HorizonCode it should stay per-model data (`app/src/core/prompt/`), not copied wholesale |
| Rust-DSL-generated CI (`forge_ci`, gh-workflow) | HorizonCode's CI is a plain YAML installed by `ops/install-ci.sh` plus a local gate runner that works without CI; a codegen layer adds complexity for a repo of this size |
| `cargo insta` auto-accept (`auto_accept: true`) | Auto-accepting snapshots defeats review. If T-2 adopts snapshots, accept manually |
| Paid bounty automation, Discord/"Support Us" star-begging section | Community tooling, not product; README tone issue (see §5) |
| ZSH-only plugin (`:` prefix) as the primary UX | Valuable for forge's positioning, but HorizonCode's primary surface is the chat TUI (ADR-001). Take only the cheap parts later: terminal context (command ring buffer + exit codes), OSC 133 gating, `@` file picker. As a package: M-L, low priority; do not claim shell integration until built |
| Reasoning/provider-specific transformers for the whole 48-provider list | Take the quirk TABLE mechanism (T-8), not the volume |
| Embedded VS Code extension auto-install | Secondary surface; designed only |

## 3. Quality signals worth copying as practice (not features)

- AGENTS.md as the engineering contract with exact test style and "never run `--release` for verification" (a good example of an agent-readable CONTRIBUTING). HorizonCode's own `AGENTS.md` equivalent should state: `bun run typecheck && bun test`, `cargo test --locked`, `bash ops/gates.sh`.
- Dogfooding trail in `plans/`.
- Generated JSON schema checked in.
- Tests live beside the code; snapshot every externally visible string (tool schemas, rendered prompts).

## 4. Grok Build TUI deep dive (steering request)

Scale: `xai-grok-pager` alone is 551k lines / 667 files (`app/` 254k, `views/` 151k, `scrollback/` 55k, `slash/` 17k, `acp/` 12.7k, `diagnostics/` 9k, `headless/` 7.8k, `settings/` 3.5k, `notifications/` 3.3k, `tips/` 1.9k). Supporting crates: `xai-grok-pager-render` 42.8k, `xai-grok-pager-pty-harness` 42.7k (288 files), `xai-grok-markdown` 22.9k, `xai-ratatui-textarea` 15.2k, `xai-hunk-tracker` 11.4k, `xai-grok-pager-minimal` 7.3k, `xai-grok-voice` 5.6k, `xai-tty-utils` 4.3k, `xai-ratatui-inline` 4.2k, `xai-grok-pager-diff` 1.4k, `xai-grok-status-line` 1.1k, `xai-grok-mermaid` 2.0k, `xai-prompt-queue` 0.5k. The docs (27 user-guide pages + 9 tutorial pages) are part of the product. What was read: the pager README, user-guide pages on keyboard shortcuts (the Escape table, blocking cards, mid-turn behaviour in full), theming, terminal support (doctor), status line, background tasks and sessions headings; `xai-ratatui-inline` README, [`xai-grok-pager-minimal/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/lib.rs), [`xai-grok-markdown/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/lib.rs), `xai-prompt-queue`, the PTY harness `lib.rs`, `xai-hunk-tracker` and `xai-grok-pager-diff` headers; directory structure of `views/`, `app/`, `scrollback/blocks/`, `slash/commands/`. The 551k-line pager body was not read line by line.

### 4.1 Architecture

- Elm-style: input to `Action`, `dispatch/` (router plus per-domain modules) to `Effect`, state update; `AppView` (welcome, agents, config) owns one `AgentView` per session (prompt, scrollback, tool panes, modals). The agent is a separate process spoken to over ACP (agent communication protocol), so the TUI is a client of a leader/shell process (the same split HorizonCode's server mode targets).
- Two render modes from one codebase: full-screen (alt screen, mouse, scrollback pane with selection/fold/search) and `--minimal`, which prints finalized blocks ONCE into the terminal's native scrollback via `Terminal::insert_before_rows` and keeps a small pinned "live region" (running turn tail, todos, status, prompt). `xai-grok-pager-minimal` cannot be a dependency of the pager (cargo cycle), so the pager exposes function-pointer hooks that the binary installs at startup.
- `xai-ratatui-inline` forks ratatui's `Terminal` to expose viewport internals; DCS synchronized output (`?2026`) wraps each frame so the terminal presents once; resize strategy is "clear screen + clear scrollback + home, re-output full history, re-place viewport" (`resize_purge_rerender`) because on the main screen the terminal reflows BEFORE the app sees SIGWINCH; `ESC c` (RIS) is avoided because iTerm/Terminal.app do not clear scrollback with it. Zero-copy ANSI-aware wrapping (anstyle-parse), differential test against `termwiz`.
- Rendering discipline: `#![deny(clippy::indexing_slicing)]` across crates (no panicking indexing in a renderer), `xai-grok-markdown` has a fuzz target and checkpoint-based freezing (only the unstable tail is re-rendered), LaTeX math to Unicode, mermaid rendering, per-terminal color downgrade to 256/16-color, `NO_COLOR`.

### 4.2 Interaction design (the part worth studying)

- **Esc never cancels a turn.** Mid-turn Esc shows "Press Ctrl+C to cancel"; Esc Esc within 800 ms on a non-empty idle prompt clears it (draft stashed, restorable with `Ctrl+S`/`Ctrl+Z`); Esc Esc on an empty idle prompt with messages opens the rewind picker; a ~1 s grace after a mid-turn Esc prevents mashing from opening rewind. Ctrl+C: clears a non-empty draft but keeps the turn; second Ctrl+C on an empty prompt cancels; while cancelling, Ctrl+C escalates toward quit.
- **Blocking cards share one contract** (permission, `ask_user_question`, MCP elicitation, cancel-turn): Tab/Shift+Tab walk rows and wrap; Esc steps back one rung (clear pending first, then park focus in the scrollback so the user can read context while the card stays on screen); the shortcuts bar names whichever card has the keyboard. Permission prompt keys: pick 1-9, `Left/Right` widen or narrow the scope an "always" answer would remember, `e` edits the always-allow pattern by hand, `Ctrl+F` expands full arguments, `Ctrl+O` toggles always-approve.
- **Mid-turn input**: Enter queues a follow-up (policy `follow_up_behavior = queue|steer`; `steer` injects at the next safe gap); queued prompts get a queue pane (edit, send now, combine rules in `xai-prompt-queue`); "send now" is explicitly cancel-and-send, with per-terminal chords because VS Code-family terminals steal keys. `Ctrl+B` sends the running foreground command to the background; a message sent mid-command backgrounds it instead of killing it. `!` enters shell mode, `#` enters remember mode, `/btw` asks a side question without disturbing the turn.
- **Navigation**: simple (arrows) and vim modes; fold/expand per block, expand-all, raw-markdown toggle per block, copy block / copy metadata, fullscreen block viewer, turn jump (`Shift+Left/Right`), timeline, scrollback search, sticky headers, mouse selection with link map. Command palette (`Ctrl+P`/`?`), settings modal (`F2`), session picker (`Ctrl+R`), history panel with `Up`.
- **Modes**: Shift+Tab cycles Normal, Plan, Auto-review, Always-approve; plan approval is its own view with feedback; permission modes documented per page (`22-permissions-and-safety.md`), with hard limits on always-approve.
- **Terminal reality handling**: detection of ~15 terminals/IDE terminals, Kitty keyboard protocol vs `Ctrl+X` fallback, tmux `extended-keys` / `allow-passthrough` / truecolor / `set-clipboard` checks with named, one-at-a-time, backup-making config fixes (`/doctor fix tmux-clipboard`), SSH-aware appearance detection (`GROK_APPEARANCE`, `COLORFGBG`, OSC 11, `grok wrap ssh` stamping), clipboard via native + OSC 52 + tmux routes.
- **Themes**: 6 built-in (GrokNight default, GrokDay, TokyoNight, RosePineMoon, OscuraMidnight, Terminal = no backgrounds, ANSI-16 only, reverse video for selection), live preview in the `/theme` picker, `auto` follows OS appearance and polls every 5 s; minimal mode deliberately has no theming and uses only the terminal's own palette.
- **Status line**: opt-in, built-in items (`cwd`, `model`, `context`, `cost`, `turn-timer`, `session-name`) or `command` mode: JSON on stdin (documented schema with `schema_version`, `context_window.used_percentage`, `cost.total_cost_usd`, `workspace.branch`, `trigger`), up to 5 lines of stdout, 10 s timeout, 64 KiB cap, debounced 300 ms, cleaned env (no rc files, `GIT_OPTIONAL_LOCKS=0`); fields it cannot source honestly are omitted rather than faked; a repo-local config can never set it (a repo must not be able to make the tool run its script); pushed/campaign configs strip it.
- **Test infrastructure**: `xai-grok-pager-pty-harness` runs the real binary under a PTY, renders it with `alacritty_terminal` into a virtual screen ("what the user sees"), times frames by counting `?2026 h/l` markers, drives it with a mock inference SSE server, supports YAML scenarios, JSON results and baseline comparison for benchmarks. Snapshot tests sit beside the blocks.

### 4.3 Classification against HorizonCode's TUI (`app/src/tui/` 2,069 lines; inline chat bar; `docs/13-tui.md` designs fullscreen as later work)

| Grok TUI capability | Verdict | HorizonCode area / reason | Effort |
|---|---|---|---|
| Native-scrollback "minimal" architecture: commit finalized blocks once, pinned live region | IN (same model) | HorizonCode's inline chat bar is this design. Keep it as the primary mode; do not chase the 551k-line fullscreen pager | n/a |
| DCS synchronized output `?2026` around each frame | TAKE (T-G1) | `tui/render.ts`/`interactive.ts`: wrap repaint in begin/end sync when supported (gate by `TERM_PROGRAM`/DECRQM query); removes tearing during streaming | S |
| Resize: purge + re-render history, never trust reflow | TAKE (T-G1b) | Matters as soon as markdown wraps (T-5). Needs a retained block list | M |
| Checkpoint-freezing streaming markdown | TAKE later (T-G2) | After T-5 line-buffered v1; freeze completed blocks so only the tail is redrawn | M |
| Esc/Ctrl+C semantics (Esc never cancels; double-Esc clear; double-Esc rewind picker; draft stash) | TAKE (T-G3) | `interactive.ts` key handling + existing `/rewind`; the rewind picker with Esc Esc is the cheapest high-polish win | S |
| Permission prompt with scope widening and editable "always" pattern | TAKE (T-G4) | `tui/approval.ts` (225 lines, y/n/a). Map `a` to a kernel LEASE with a visible scope (this file / this dir / this command prefix, TTL) that the user can widen/narrow, instead of a boolean; shows exactly what the receipt will say | M |
| Blocking-card contract (Tab walks rows, Esc steps back, shortcut bar names the owner) | TAKE (design rule) | Write into `docs/13` as a rule; implement when more than one card type exists | S (doc) |
| Follow-up queue with `queue` vs `steer` policy and combine rules | TAKE (T-G5) | `interactive.ts` already has a `queued` list (line ~732); server mode designed `steer`/`queue` inbox. Add the policy flag and "send now" | M |
| Ctrl+B background a running command | TAKE (T-G6) | `shell_session` PTY tool exists; add user-side detach | M |
| Theme system + terminal-palette-only theme + `NO_COLOR` + color-depth downgrade + OSC 11/`COLORFGBG` auto light/dark | TAKE (T-G7) | `tui/style.ts` has `NO_COLOR` only. Add `terminal` (ANSI-16) default theme and a 256/16 quantiser; skip named themes | S-M |
| `/doctor` with tmux fixes | TAKE subset (T-10) | Diagnose-only in v1 | S-M |
| Status line JSON contract, user-config only | TAKE (T-17) | see §2.2 | S-M |
| PTY-driven virtual-screen test harness with frame timing | TAKE later (T-G8) | HorizonCode has real PTY scenarios (`tests/tui/pty.test.ts` via `/usr/bin/script`). Adding a tiny VT screen model for assertions is M-L in zero-dep TS; do after markdown | M-L |
| Hunk tracker: attribute each hunk to agent vs external editor, LOC sinks | DEFER (T-G9) | Conceptually valuable for receipts ("which lines were the agent's"), but 11k lines in Grok. Keep as a design note; HorizonCode's change journal + turn diff cover the practical need | L |
| Fullscreen alt-screen scrollback pane, mouse selection, drag, scrollbars, vim mode | SKIP for now | Largest cost, least differentiating; docs/13 already schedules it behind the inline mode | L+ |
| Mermaid, LaTeX, inline images/video (ffmpeg), voice, dashboard of sessions, marketplace modal, feedback form, announcements, tips engine, `/imagine` | SKIP | Not core; each is a separate product surface |
| `/loop` recurring prompts, scheduler | SKIP now | Scheduler is designed (docs 15/16); do not build in the TUI first |
| `unified_log.jsonl`, `grok inspect` | TAKE subset | covered by T-20/T-10 |

## 5. forgecode README analysed as a product README

### 5.1 Structure (in order)

1. Centered H1 with an emoji and a one-line tagline ("A comprehensive coding agent that integrates AI capabilities with your development environment"). Install one-liner under the title (`curl -fsSL https://forgecode.dev/cli | sh`).
2. Four badges (CI, GitHub release, Discord, CLA assistant), all `for-the-badge` style.
3. A 2x demo GIF hosted off-repo.
4. Collapsible Table of Contents (`<details>`).
5. Quickstart: one command + "first run guides you through provider login"; then `forge provider login` / `forge`; "That's it!".
6. Usage Examples: 8 collapsible chat prompts ("Code Understanding", "Debugging", "Git Operations"...) each followed by one sentence of what Forge "will" do (conditional, not demonstrated).
7. "Why Forge?": 5 bullets in the form `**Zero configuration** - sentence`.
8. "How Forge Works: Three Modes" (interactive, one-shot `-p`, ZSH plugin) with command blocks.
9. ZSH plugin reference (about 250 lines): agent table (forge / sage / muse, "Modifies files?" column), nine command groups, a quick-reference table of every `:` command with aliases.
10. Command-line options table + subcommand cheat sheet.
11. Advanced configuration: provider login, a ~300-line DEPRECATED env-var block (one collapsible per provider), `forge.yaml` options (one collapsible each), ~150 lines of environment variables, MCP.
12. Documentation (link to a folder with one file), Installation (again, late), Community (Discord badge again), Support Us (star request with emoji bullets).

### 5.2 Tone

Friendly, second-person, imperative, light emoji (title, "Support Us"), exclamation ("That's it!"), "YOLO" as a code comment for the curl installer, vague superlatives ("comprehensive", "powerful", "vibrant"). Features are stated, not evidenced. No licence section, no status/limitations section, no comparison with other agents, no screenshots beyond the GIF, no benchmark numbers (no claim in the README or repo).

### 5.3 What to copy

- Install command and first-run path inside the first screen; Quickstart is two steps.
- A demo asset directly under the badges (HorizonCode has none: record one with the mock provider so it is reproducible).
- Collapsible sections for long reference material, so the top stays scannable.
- Command tables with aliases; a "modes" section that explains interactive vs one-shot vs integration before reference material.
- An agents table with a "Modifies files?" column (a clean way to present HorizonCode's explore/plan/code/review profiles and permission modes).

### 5.4 What to avoid (observed defects)

- Drift: README says retry default 3 attempts / 1000 ms, shipped `.forge.toml` says 8 / 200 ms; config path appears as `~/forge/.forge.toml`, `~/.forge`, `forge.yaml`; an empty "forge.yaml Configuration Options" heading precedes the Environment Variables section; the shell tool text mentions a `-u` flag that is undocumented.
- Claim vs default mismatch: "Secure by design - restricted shell mode" while `restricted = false` and the default policy allows everything.
- Generic value props ("Zero configuration", "Open-source") with no measurement.
- Deprecated material occupying more space than the current path.
- Documentation link to a folder holding one file; Installation placed after reference docs; star-begging section.
- LICENSE file is Apache-2.0 while the Nix flake metadata says MIT, and the README never states a licence.

## 6. Recommended product README outline for HorizonCode

Target: ~250 to 350 lines, scannable in one screen per section, no emoji, no exclamation marks, no filler adjectives. Every sentence must be checkable on `main`. Style rules: Features list bullets are exactly `**Name**: one precise sentence.` (colon form, as in the zerostack example, instead of forge's hyphen); gated or optional features carry a trailing tag in the same bullet, `(opt-in: HORIZON_GUARDIAN=enforce)`, `(default off)`, `(not wired)`; the measured Performance section lists method + environment under each number.

| Section | Content | HorizonCode facts and numbers that fill it |
|---|---|---|
| 1. Title + positioning line | `HorizonCode (hzcode)` then one sentence: "A terminal coding agent that separates what the model proposes from what is allowed to happen, and records every admitted action in a hash-chained log with receipts." | Facts: TS/Bun runtime + Rust trust kernel (`hz-kernel`); binaries `hzcode`/`hz`/`horizon` (README table) |
| 2. Badges (max 3) | CI status (only once `ops/ci/github-actions.yml` is installed and green), version `0.1.0`, licence | Currently NOT available: CI workflow not installed (needs `workflow`-scope token), no LICENSE file (see §7) |
| 3. Demo | One recorded terminal session (mock provider, reproducible) showing a prompt, a tool card, an approval, `log.verify` | Record from `printf` driver in `.scratch/demo` style; no external hosting |
| 4. Intro (3 to 5 sentences) | Problem (agents act with ambient authority and leave no evidence), approach (kernel admission + receipts), who it is for | `docs/11-authority-safety.md` R1: `deny > lease > ask > allow`; receipts replay and verify via `log.verify`/`receipt.verify` |
| 5. Features | 10 to 14 bullets in `**Name**: sentence.` form, grouped under Safety, Agent, Tools, Operations. Candidate bullets (all verified in README/docs/28 as TESTED or VERIFIED): **Kernel-admitted actions**: every tool call is authorised by the Rust kernel before it runs and settles into a receipt. **Tamper-evident log**: events and receipts are hash-chained and verifiable from either runtime; optional keyed anchors (`HZ_ANCHOR_KEY`). **Permission modes**: `default`, `plan`, `accept-edits`, `read-only`; a kernel deny always wins; there is no bypass mode. **Plan mode with staged writes**: writes are staged and reviewed with `/changes`, applied with `/apply`. **Edit ladder**: exact, relative-indent, unicode-fold, 3-way and line-patch matching, each applied only when unique; CRLF-safe; `apply_patch` for GPT-style models. **Eighteen registered tools**: (verify count at release). **Parallel tool batches**: classed shared/exclusive scheduling with per-call leases. **Loop safety rails**: step, token and wall-clock budgets, loop detection, format-error corrective. **Checkpoints and rewind**: file and conversational rewind. **Session fork**. **Instructions**: AGENTS.md, CLAUDE.md, GEMINI.md, CONVENTIONS.md, Copilot, Cursor and Windsurf rules load as peers, capped and never treated as permissions. **MCP client** (stdio, user-config only). **Server mode** (`hzcode serve`, single-attach NDJSON JSON-RPC). **Headless**: `-p` with text, json, stream-json and canonical exit codes. **Providers**: Anthropic, OpenAI, Google, Ollama, any OpenAI-compatible endpoint; unknown provider fails loud. Tags: `(default off)` LSP loop; `(advisory)` guardian, `(opt-in: HORIZON_GUARDIAN=enforce)`; `(not wired)` speculative execution; `(admission-time only)` sandbox seams | `README.md` capability list, `docs/28` §1 rows, `CURRENT_RUN.md` §5.0 |
| 6. Performance | Short table: end-to-end headless turn with the mock model, kernel self-test, kernel binary size, source size. Each row states method and machine. Optionally the ratcheted gate from T-11. | Measured 2026-11-09 by this report: median 0.216 s (n=10; range 0.213 to 0.225 s) for `printf 'list files' \| hzcode` including kernel spawn, one tool call and receipt; `--selftest` 25 checks in 0.003 s; `hz-kernel` release binary 1,156,816 bytes; `app/src` 35,594 TS lines, `kernel/src` 7,070 Rust lines; app has zero runtime dependencies (`app/package.json` has only devDependencies). Environment line: x86_64, 8 cores, Bun 1.2.14. Re-measure at release; add a model-latency row only with a keyed run. NO head-to-head table until the same-model benchmarks exist (CURRENT_RUN: NOT STARTED) |
| 7. Install | Honest current state: from source. `git clone`, `cd HorizonCode`, `./bin/hzcode`; Rust kernel build `cd kernel && cargo build --release --locked`. Add package-manager lines only when they exist | `bin/hzcode` launcher; distribution (npm/brew/nix/static binary) is DESIGNED, do not list |
| 8. Quickstart | 3 commands: run with zero config (mock), set a real provider (`HZ_PROVIDER`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), one-shot `hzcode -p "..."`; then "verify a run": show where receipts live (`<workspace>/.hz/state/kernel/`) and how to verify | README "Run it now"; first live run was NVIDIA NIM (OpenAI-compatible), headless and interactive (CURRENT_RUN item 9) |
| 9. How it works (diagram) | One ASCII diagram: model proposes, runtime `guard`, kernel admits/denies, tool runs, receipt, event log. One paragraph on `trusted` vs `untrusted` (TS fallback) mode and what is weaker in the latter | `docs/03-hld.md`, `app/src/contracts.ts` (frozen interface, byte-identical hashing) |
| 10. Usage | Table of CLI flags/slash commands: `-p`, `--output-format`, `--permission-mode`, `--resume`, `serve`; slash: `/mode /plan /changes /apply /discard /fork /sessions /rewind /memory /init /context /model /exit` | `tui/interactive.ts` help table; `tui/print.ts` |
| 11. Configuration | `~/.config/horizon/config.json` keys (`provider`, `model`, `apiKey`), env vars, legacy `~/.hzcode/config.json` honoured, state directory resolution (`.hz/state/` vs existing `.hzcode/`), `policy.json`, `hooks.json`, user provider registry, MCP entries (user config only). Link the generated schema once T-20 lands | `docs/28` rulings on canonical state paths (RC-17), `core/paths.ts`, `core/config.ts` |
| 12. Safety model and limits | Plain bullets: what is enforced (kernel admission, receipts, structural protection of kernel state, symlink-resolved scopes, fail-closed policy loading), what is NOT (no OS sandbox confinement; `sandbox.report` never claims it; fullscreen TUI not implemented; kernel-absent mode is weaker) | `docs/28` ruling list, `kernel/src/{guard,execpolicy,egress}.rs`, Landlock spike record `docs/audit/landlock-spike-2026-11-08.md` (Landlock unavailable in the test environment) |
| 13. Status | One table: Implemented and tested / Present but not wired / Designed. Date-stamp it; link `CURRENT_RUN.md` §5.0 and `docs/28`. State "pre-release, not published" | Verbatim from `docs/28` §1; "present but not wired": speculative execution, guardian enforce path unless env set |
| 14. Testing and gates | The exact commands and last verified results with date and uid: `bun run typecheck` 0 errors; `bun test` 1334 tests / 113 files (1334 pass as uid 1000; 1326 pass + 8 skip as root); `cargo test --locked` 49 + 50 pass; `hz-kernel --selftest` 25 checks; `bash ops/gates.sh` 7/7. Re-run immediately before publishing; keep the date | Quoted from the README/docs/28, NOT re-run in this pass |
| 15. Documentation | Index to `docs/00-index.md`; table of the five docs a new reader needs (vision, authority-safety, tools, TUI, implementation-status) | `docs/` tree |
| 16. Contributing | Link to a CONTRIBUTING file (does not exist yet; create from AGENTS-style rules: typecheck, tests, gates, "claims must cite a command") | `ops/gates.sh`, `docs/_conventions.md` |
| 17. Security | How to report, scope statement (kernel bypass = in scope) | No SECURITY.md exists; create before release |
| 18. Licence | One line with the SPDX id | Blocked: no LICENSE file in the repo (see §7) |

Avoid in the README: a long designed-capabilities catalogue (the current §3 of the README lists 100+ tools and surfaces that are DESIGNED). Move it to `docs/24-feature-catalog.md` and link; keep the README to what a user can run today.

## 7. What HorizonCode must NOT claim (verify-on-main rule)

Blockers and traps found while preparing this report:

1. **Licence**: README says "MIT" but there is no `LICENSE`/`LICENSE.md` file in the repo root and `app/package.json` has no `license` field. Do not publish a licence claim until a LICENSE file with the chosen text is committed. (forgecode shows the cost of mismatch: Apache-2.0 LICENSE vs MIT in `flake.nix`.)
2. **No benchmark or ranking claims**: no SWE-bench, Terminal-Bench, "fastest", "fewest tokens", or comparisons to named agents. `CURRENT_RUN.md` marks same-model head-to-head benchmarks NOT STARTED, and `docs/30` §1 already shows how unverifiable ranking claims were handled for oh-my-pi. Only the measured rows in §6 are allowed.
3. **Sandbox**: do not say "sandboxed". OS confinement does not exist (admission-time seams only; Landlock was ENOSYS in the gVisor test kernel). Use "capability admission" and "policy". Do not call a worktree flag a sandbox (T-15).
4. **Tamper-proof**: the log is tamper-EVIDENT (hash chain, optional keyed anchors); without `HZ_ANCHOR_KEY` an attacker with write access can rewrite the whole chain. State that. Also state `untrusted` (TS fallback) mode has weaker guarantees.
5. **Independent evidence verification**: `hzcode session verify <id>` and the independent-evidence gate are DESIGNED only; claim only `log.verify`/`receipt.verify`.
6. **Surfaces**: web app, desktop, IDE bridge (ACP/VS Code/JetBrains), SDKs, plugin marketplace, collaboration, voice, full memory tiers, snapcompact, workflow engine, secret vault, enterprise/MDM are designed, not shipped. Fullscreen TUI with mouse is not implemented.
7. **Model access**: "300+ models via models.dev" is a seam with a curated committed snapshot, not a live catalogue. Real endpoints verified so far: NVIDIA NIM (OpenAI-compatible). Anthropic and OpenAI first-party live runs are still open per `CURRENT_RUN`. Say which providers have adapters and which were exercised live.
8. **Prompt caching / cache-first compiler**: designed; no `cache_control` handling was found in `app/src/core/providers/`. Do not claim cost savings from caching.
9. **Telemetry**: a grep of `app/src` for telemetry/PostHog found nothing, but "no telemetry" must be verified with a network-egress check (and include MCP/provider calls as the only egress) before it is printed.
10. **Distribution**: npm/brew/apt/scoop/nix/docker, auto-update, signed releases are designed. The product is "implemented and tested but not released".
11. **CI badge**: GitHub Actions wiring ships as `ops/ci/github-actions.yml` and needs a token with the `workflow` scope; hosted CI results exist for specific commits only. No badge until the workflow is installed on `main` and green. (`docs/28` ruling 52 records a flaky Rust test on hosted CI; mention in release checklist, not README.)
12. **Test numbers**: quote them only with date, uid and commit; the root vs non-root difference (1334 pass vs 1326 + 8 skip) must be stated, as the status line already does.
13. **Tool count**: README says eighteen registered tools; confirm with the registry at release time (and keep the designed catalogue separate).
14. **Language/tone**: avoid "superset of the state of the art", "execution constitution" as a headline claim without the one-paragraph definition; they read as marketing and invite the unverifiable-ranking problem. Keep "superset" in `docs/01`.

## 8. Recommended follow-up order

1. Product README rewrite using §6 (a later step); first resolve the LICENSE blocker and re-run the numbers in §6 row 14 on the release commit.
2. S-size trust-neutral wins with visible payoff: T-2 (schema snapshot), T-3, T-4, T-6, T-11, T-12 (`/rename /retry /stats /export`), T-10 (`doctor`), T-G3 (Esc semantics).
3. T-1 (JSON repair, already designed as NF-069 part), then T-5 (markdown renderer) and T-G1 (synchronized output), because they change what a screenshot looks like.
4. T-9 (key-free hygiene evals) to produce the first measured, reproducible quality table for the README.
5. T-7, T-8, T-G4 (lease-scoped approval prompt), T-G5, T-15, T-16, T-14, T-13, T-17, T-19, T-20 as capacity allows. T-18, T-G8, T-G9 deferred.

## 9. Appendix: evidence pointers

- Loop: [`crates/forge_app/src/orch.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/orch.rs) (`execute_tool_calls` partitions `task` calls for `join_all`; everything else sequential).
- Permission gate only when restricted: [`crates/forge_app/src/tool_registry.rs:141-145`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/tool_registry.rs#L141-L145); defaults [`crates/forge_config/.forge.toml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_config/.forge.toml) (`restricted = false`), [`crates/forge_services/src/permissions.default.yaml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_services/src/permissions.default.yaml).
- Read-before-edit: `crates/forge_app/src/tool_executor.rs::require_prior_read`.
- Edit engine and remote fallbacks: [`crates/forge_services/src/tool_services/fs_patch.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_services/src/tool_services/fs_patch.rs) (`apply_replace_operation`, `validate_file`), [`crates/forge_repo/proto/forge.proto`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_repo/proto/forge.proto).
- Compaction: [`crates/forge_app/src/compact.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/compact.rs), [`hooks/compaction.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/hooks/compaction.rs), [`crates/forge_domain/src/compact/compact_config.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/compact/compact_config.rs); defaults in `.forge.toml [compact]`.
- Doom loop and reminders: [`crates/forge_app/src/hooks/doom_loop.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/hooks/doom_loop.rs), `templates/forge-*.md`.
- Benchmarks: [`benchmarks/README.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/README.md), `benchmarks/evals/{patch_exact_match,parallel_tool_calls}/task.yml`.
- Zsh terminal context: [`shell-plugin/lib/context.zsh`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/shell-plugin/lib/context.zsh); [`crates/forge_domain/src/terminal_context.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/terminal_context.rs).
- Release: `.github/workflows/release.yml` (9-target matrix), `Cross.toml`, `flake.nix`, `package.json` (eval tooling only; no npm wrapper in this repo's package.json, the npm release job is [`forge_ci/src/jobs/release_npm.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_ci/src/jobs/release_npm.rs)).
- Grok TUI: `crates/codegen/xai-grok-pager/{README.md,docs/user-guide/03-keyboard-shortcuts.md,06-theming.md,21-terminal-support.md,25-status-line.md,20-background-tasks.md}`, [`xai-ratatui-inline/README.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-ratatui-inline/README.md), [`xai-grok-pager-minimal/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/lib.rs), [`xai-grok-markdown/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/lib.rs), [`xai-grok-pager-pty-harness/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/lib.rs), [`xai-prompt-queue/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-prompt-queue/src/lib.rs).
- HorizonCode: `app/src/core/loop.ts` (`parseArguments` ~210; open-todo exit ~1174), `app/src/core/compaction.ts` (`summariseElided`), `app/src/tools/read-ledger.ts`, `app/src/tui/{render,style,approval,interactive}.ts`, `app/package.json`, `docs/28-implementation-status.md`, `CURRENT_RUN.md`.
