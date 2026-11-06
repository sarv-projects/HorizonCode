# Codex — Deep Code-Organization Tour

Repo: `/data/home/forge/repo-tour/codex`  |  Org `openai`  |  Rust  |  "Lightweight coding agent that runs in your terminal"
Tour commit: `ddd1812a51f4aded35c3ec5446672474d5cb546b` (2026-11-06, "Carry targeted moderation decisions on final-answer messages (#59842)")
All paths below are ABSOLUTE under `/data/home/forge/repo-tour/codex`.

---

## 1. Identity

Codex CLI is OpenAI's open-source coding agent that runs locally in the terminal. It is a **polyglot monorepo**:

- **Rust** is the heart — a Cargo workspace of ~130 member crates under `codex-rs/` (`/data/home/forge/repo-tour/codex/codex-rs/Cargo.toml`).
- **TypeScript/Node** thin wrapper + SDK: `codex-cli/` (npm package `@openai/codex`) and `sdk/typescript/`.
- **Python** SDK + runtime: `sdk/python/`, `sdk/python-runtime/`.
- **Bazel** build alongside Cargo: root `BUILD.bazel`, `MODULE.bazel`, `defs.bzl`, `bazel/`, `.bazelrc`.
- **Nix** flake: `flake.nix`, `flake.lock`.
- **just** as the task runner: `justfile` (working dir `codex-rs`).

The README (`/data/home/forge/repo-tour/codex/README.md#L1-L8`) frames three surfaces: **Codex CLI** (local terminal), **Codex IDE** (VS Code/Cursor/Windsurf), and the **Codex app** (`codex app` desktop / cloud). The same repo backs all of them, which explains crates like `app-server*`, `cloud-tasks*`, `plugin*`.

Workspace package metadata (`/data/home/forge/repo-tour/codex/codex-rs/Cargo.toml#L174-L181`): version `0.0.0`, edition **2024**, Apache-2.0. Lints are strict: `unwrap_used`/`expect_used` denied, plus a large `clippy` deny list (`#L594-L633`).

---

## 2. Top-level map

Root entries (`/data/home/forge/repo-tour/codex`):

| Entry | Role |
|---|---|
| `README.md` | Product overview + install quickstart |
| `package.json` | pnpm monorepo root; only lint scripts + prettier devDep |
| `pnpm-workspace.yaml` | Packages: `codex-cli`, `codex-rs/responses-api-proxy/npm`, `sdk/typescript` |
| `justfile` | Primary task runner (build/test/bench/bazel/schema gen) |
| `codex-rs/` | The Cargo workspace (the core product) |
| `codex-cli/` | npm wrapper package; `bin/codex.js` resolves platform binary |
| `docs/` | User/contributor docs (config, sandbox, exec, auth, skills…) |
| `sdk/` | `typescript/`, `python/`, `python-runtime/`, `python/…` |
| `scripts/` | Build/package/format/CI helper scripts |
| `tools/` | `argument-comment-lint/`, `buildifier` |
| `third_party/` | Vendored deps |
| `bazel/`, `BUILD.bazel`, `MODULE.bazel`, `defs.bzl`, `rbe.bzl` | Bazel build/rules/RBE |
| `patches/` | Patch files applied to vendored crates |
| `.github/` | Workflows, `codex-cli-splash.png` |
| `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, `NOTICE` | Meta |
| `flake.nix`, `flake.lock` | Nix dev env |

`docs/` index (`/data/home/forge/repo-tour/codex/docs`): `getting-started.md`, `install.md`, `config.md`, `example-config.md`, `authentication.md`, `sandbox.md`, `exec.md`, `execpolicy.md`, `slash_commands.md`, `skills.md`, `agents_md.md`, `contributing.md`, `license.md`, `CLA.md`, `open-source-fund.md`.

The `justfile` (`/data/home/forge/repo-tour/codex/justfile`) is the canonical dev entry: `just codex` → `cargo run --bin codex`; `just test` (nextest), `just bench`, `just bazel-codex`, `write-config-schema`, `write-app-server-schema`, `log` (SQLite log tail), plus Bazel/E2E variants.

---

## 3. Crate graph + responsibilities

The workspace declares ~130 members (`/data/home/forge/repo-tour/codex/codex-rs/Cargo.toml#L2-L171`). Grouped by role:

### Core agent / session
- **`core`** (`codex-core`) — the agent engine: session, turn loop, context manager, client (model API), tools, sandboxing glue, compaction, realtime, MCP glue. The largest crate.
- **`core-api`** (`codex-core-api`) — public API surface types for core plug-ins.
- **`core-plugin-common`**, **`core-plugins`** — plugin infrastructure for extensibility.
- **`protocol`** (`codex-protocol`) — shared domain types (config_types, models, errors, exec output, MCP types, auth). Dependency of nearly everything.
- **`state`** (`codex-state`) — SQLite-backed runtime state (threads, logs, migrations).
- **`history`**, **`message-history`** — conversation history types/rollout items.
- **`rollout`** (`codex-rollout`) — session rollout persistence (JSONL transcripts).
- **`rollout-trace`** — reduced-state tracing/replay bundles.
- **`thread-store`**, **`thread-manager-sample`**, **`runtime-agent-instance`** — thread/agent instance management.

### Entry points / CLI / exec surfaces
- **`cli`** (`codex-cli`) — main `codex` binary, subcommand router.
- **`exec`** (`codex-exec`) — non-interactive `codex exec` engine + JSONL/human event processors.
- **`exec-server`**, **`exec-server-cli`**, **`exec-server-protocol`** — remote execution server for sandboxed command execution.
- **`tui`** (`codex-tui`) — the interactive terminal UI (ratatui/crossterm).
- **`app-server`**, **`app-server-client`**, **`app-server-daemon`**, **`app-server-protocol`**, **`app-server-transport`**, **`app-server-test-client`**, **`app-server-protocol-noop-macros`** — JSON-RPC app server for IDE/desktop/CLI.

### Model providers / API
- **`model-provider`** (`codex-model-provider`), **`model-provider-info`**, **`models-manager`** — provider abstraction, model catalogs, auth/routing.
- **`codex-api`**, **`codex-client`** — Responses API client, SSE, auth, retry, telemetry.
- **`responses-api-proxy`** — local proxy that forwards to the Responses API (see installer).
- **`ollama`**, **`lmstudio`**, **`chatgpt`** — alternate/local backends and ChatGPT integration.
- **`backend-client`**, **`cloud-client`**, **`codex-backend-openapi-models`** — OpenAI backend/cloud HTTP clients.
- **`aws-auth`**, **`workload-identity`**, **`websocket-auth`**, **`websocket-client`** — provider auth + transports (Bedrock, WS).

### Tools / patching / search
- **`apply-patch`** (`codex-apply-patch`) — patch parser/applier (also a standalone `apply_patch` bin).
- **`tools`** (`codex-tools`) — tool definitions, JSON-schema, tool output, Responses-API tool mapping, code-mode tooling.
- **`execpolicy`** — Starlark prefix-rules engine for command decisions.
- **`file-search`** — the `codex-file-search` CLI + library (fuzzy file search).
- **`shell-command`** — shell command abstraction/parse.
- **`file-system`**, **`file-watcher`** — FS abstractions + watch (`notify`).

### Sandboxing / process
- **`sandboxing`** (`codex-sandboxing`) — cross-platform sandbox orchestration: seatbelt (macOS), landlock/bwrap (Linux), Windows MXC.
- **`linux-sandbox`** — Linux sandbox launcher (bwrap, seccomp, WSLg, proxy lifecycle).
- **`windows-sandbox-rs`**, **`windows-sandbox-service`** — Windows AppContainer/WFP sandbox and its service.
- **`bwrap`** (`croo/bwrap` wrapper), **`mxc-sandbox`**, **`network-proxy`**, **`process-hardening`**, **`arg0`** — sandbox helpers.

### MCP (Model Context Protocol)
- **`codex-mcp`** — big MCP subsystem: connection manager/pool, auth, catalogs, resource client, codex-apps, rmcp client/server.
- **`rmcp-client`** — thin wrapper over the `rmcp` Rust SDK.
- **`mcp` (ext)** — `ext/mcp` extension integrating MCP into core.
- **`message-board`**, **`message-board-mcp`** — agent message board + its MCP server.

### Auth / login / secrets
- **`login`** (`codex-login`) — auth manager, API key / ChatGPT OAuth / device-code flows.
- **`keyring-store`**, **`secrets`**, **`aws-auth`** — credential storage/backends.
- **`user-verification`** — identity/user verification flows used by app-server.

### Observability / telemetry
- **`otel`**, **`otel-trace-websocket`** — OpenTelemetry tracing/metrics exporters.
- **`analytics`**, **`diagnostics`**, **`feedback`** — product analytics, health gauges, feedback.
- **`rollout-trace`**, **`direct-tool-timing`**, **`response-debug-context`** — debugging/timing.

### Config
- **`config`** (`codex-config`) — layered config loading, requirements, TOML schema, permissions, trust.
- **`config-schema`** — generates the `config.toml` JSON schema (`codex-write-config-schema` bin).
- **`codex-home`** — `~/.codex` home layout.
- **`cloud-config`**, **`features`**, **`install-context`** — cloud config bundles, feature flags, install metadata.

### Cloud tasks / agents
- **`cloud-tasks`**, **`cloud-tasks-client`**, **`cloud-tasks-mock-client`** — Codex cloud task integration.
- **`agent-graph-store`**, **`agent-identity`**, **`agent-roles`**, **`agent-message-board-client`**, **`agent-message-board-host`** — multi-agent role/identity/graph machinery.
- **`external-agent-migration`** — migrate config/state from other agents.

### Extensions (`ext/*`)
- **`ext/extension-api`** — the extension API/trait surface.
- **`ext/agent`**, **`ext/agent-message-board`**, **`ext/connectors`**, **`ext/mcp`**, **`ext/skills`**, **`ext/memories`**, **`ext/web-search`**, **`ext/goal`**, **`ext/queue`**, **`ext/items`**, **`ext/image-generation`**, **`ext/history-notes`**, **`ext/git-attribution`**, **`ext/multi-env-copy-file`**, **`ext/guardian-reviewer`**, **`ext/guardian-v2`**, **`ext/guardian-v3`** — feature extensions (guardian = safety review).
- **`plugin`**, **`plugin-host`** — plugin runtime + host binary.

### Code mode / realtime / voice
- **`code-mode`**, **`code-mode-host`**, **`code-mode-protocol`**, **`code-mode-runtime`** — JS/V8 code-mode execution (`v8-poc`).
- **`realtime-webrtc`**, **`voice-host`**, **`utils/audio`** — realtime/voice.
- **`tcp-tunnel`**, **`websocket-client`**, **`stdio-to-uds`**, **`uds`** — transports/bridges.

### Shared utils (`utils/*`)
~40 small crates: `absolute-path`, `path-utils`, `path-uri`, `string`, `fuzzy-match`, `stream-parser`, `head-tail-buffer`, `output-truncation`, `process`, `pty`, `git-discovery`, `home-dir`, `image`, `cache`, `critical-path`, `approval-presets`, `sandbox-summary`, `model-facing-id`, `rustls-provider`, `redacted-string`, `sleep-inhibitor`, `oss`, `template`, `json-to-toml`, `elapsed`, `cli`, `plugins`, `audio`, `cargo-bin`, `readiness`.
- **`git-utils`**, **`worktree`** — git/worktree helpers.
- **`ansi-escape`**, **`mermaid`**, **`terminal-detection`**, **`async-utils`**, **`http-client`**, **`context-fragments`**, **`memories/read`**, **`memories/write`**, **`skills`**, **`collaboration-mode-templates`**, **`attachment-store`**, **`guardian-context`**, **`hooks`**, **`build-info`**, **`test-binary-support`**, **`vendor`**, **`thread-*`**.

### SDK / proxies
- **`sdk/typescript`**, **`sdk/python`**, **`sdk/python-runtime`** — client SDKs.
- **`responses-api-proxy`** — Responses API proxy (+ npm packaging under `responses-api-proxy/npm`).
- **`thread-manager-sample`**, **`v8-poc`** — samples/PoCs.

---

## 4. Entry points

### The primary `codex` binary
Built by the **`cli`** crate: `/data/home/forge/repo-tour/codex/codex-rs/cli/Cargo.toml` declares `default-run = "codex"`, `[[bin]] name = "codex" path = "src/main.rs"`, and a second bin `logs_client` (`src/bin/logs_client.rs`). It also exposes `lib codex_cli` (`src/lib.rs`).

`/data/home/forge/repo-tour/codex/codex-rs/cli/src/main.rs` is the subcommand router. It uses `clap` + `codex-arg0` (`arg0_dispatch_or_else`) so one executable can masquerade as the Linux sandbox helper too. Declared `Subcommand` variants (`main.rs#L145-L246`):

- `Exec` (non-interactive run) and `Review`
- `Login` / `Logout`
- `Mcp`, `Plugin`, `AppServer`, `RemoteControl`, `App`
- `Completion`, `Doctor`, `Sandbox`, `Debug`
- `Execpolicy`, `Apply`, `Resume`, `Queue`, `Archive`, `Unarchive`, `Delete`, `Fork`
- `MigrateRollouts`, `MigrateNfsDb`
- `Cloud`, `ResponsesApiProxy`, `StdioToUds`, `ExecServer`, `Features`
- plus `Agents`, `TcpTunnel`

CLI modules under `/data/home/forge/repo-tour/codex/codex-rs/cli/src`: `app_cmd.rs`, `cloud_config.rs`, `config_override_args.rs`, `daemon_install.rs`, `daemon_telemetry.rs`, `desktop_app`, `doctor.rs`, `login.rs`, `mcp_cmd.rs`, `mcp_login.rs`, `migrate_nfs_db.rs`, `migrate_rollouts.rs`, `plugin_cmd.rs`, `queue_cmd.rs`, `remote_control_cmd.rs`, `sandbox_setup.rs`, `sandbox_uninstall.rs`, `state_db_recovery.rs`, `wsl_paths.rs`, `debug_sandbox.rs`.

macOS/Windows allocator & desktop app: `main.rs#L205-L215` selects `tikv_jemallocator` on Linux musl and `mod desktop_app` on mac/windows.

### npm wrapper
`/data/home/forge/repo-tour/codex/codex-cli/package.json` is package `@openai/codex` with `bin.codex = bin/codex.js`. `/data/home/forge/repo-tour/codex/codex-cli/bin/codex.js` detects platform/arch, maps to a `PLATFORM_PACKAGE_BY_TARGET` npm sub-package (e.g. `@openai/codex-linux-x64`), and `spawn`s the native binary.

### Other workspace binaries (`[[bin]]`)
- `codex-tui` (interactive TUI) and `md-events` — `/data/home/forge/repo-tour/codex/codex-rs/tui/Cargo.toml`
- `codex-exec` — `/data/home/forge/repo-tour/codex/codex-rs/exec/Cargo.toml`
- `codex-app-server` + `exec-server` + `codex-app-server-test-notify-capture` — `/data/home/forge/repo-tour/codex/codex-rs/app-server/Cargo.toml`
- `codex-exec-server` (exec-server-cli), `codex-file-search`, `codex-responses-api-proxy`, `codex-network-proxy`
- `apply_patch` (standalone), `codex-linux-sandbox` + `bwrap` (linux-sandbox), `codex-windows-sandbox-setup` / `codex-command-runner` / `codex-windows-managed-deny-probe`, `codex-windows-sandbox-service`
- `codex-code-mode-host`, `codex-voice-host`, `codex-message-board-mcp`, `codex-stdio-to-uds`, `codex-plugin-test-helper`, `codex-write-config-schema`

---

## 5. Core subsystems with file paths

All under `/data/home/forge/repo-tour/codex/codex-rs/core/src`.

### Agent engine (turn loop)
Dirs: `agent/`, `session/`, `tasks/`, `state/`, `thread_manager/`, `turn_timing/`.
- Session and turn drive live in `session/` — `session.rs`, `turn.rs`, `step_activation.rs`, `step_context.rs`, `step_settings.rs`, `submission.rs`, `turn_input.rs`, `turn_context.rs`, `rollout_reconstruction.rs`, `context_window.rs`. `session/mod.rs` is the module root.
- Turn task kinds in `tasks/`: `regular.rs`, `review.rs`, `user_shell.rs`, `compact.rs`, `admission.rs`, `lifecycle.rs`.
- Per-turn lifecycle state in `state/`: `session.rs`, `turn.rs`, `turn_token_usage.rs`, `auto_compact_window.rs`, `additional_context.rs`, `service.rs`.
- `thread_manager/` — `managed.rs`, `model_catalog.rs`, `shared_instructions.rs`, `shutdown.rs`.
- `turn_timing/` — `report.rs`, `review_execution.rs`.

### Model client + Responses API
- `client.rs` (docs at top: `ModelClient` lives for the session; `ModelClientSession` per turn; Responses WebSocket prewarm; sticky `x-codex-turn-state` routing) and `client_common.rs`, `client_tool_metadata.rs`.
- `model_request.rs`, `responses_headers.rs`, `responses_metadata.rs`, `responses_retry.rs`.
- Underlying client crate: `codex-api` (`api_bridge.rs`, `endpoint/`, `sse/`, `auth.rs`, `rate_limits.rs`, `requests/`, `files.rs`, `images.rs`, `safety_buffering.rs`) and `codex-client` (`provider.rs`, `retry.rs`, `sse.rs`, `telemetry.rs`).
- Provider abstraction: `codex-model-provider` (`provider.rs`, `auth.rs`, `models_endpoint.rs`, `request_preparation.rs`, `runtime_auth.rs`, `amazon_bedrock/`, `gcp/`).

(continued)

---

## 4. Entry points

### The primary `codex` binary
Built by the **`cli`** crate: `/data/home/forge/repo-tour/codex/codex-rs/cli/Cargo.toml` declares `default-run = "codex"`, `[[bin]] name = "codex" path = "src/main.rs"`, and a second bin `logs_client` (`src/bin/logs_client.rs`). It also exposes `lib codex_cli` (`src/lib.rs`).

`/data/home/forge/repo-tour/codex/codex-rs/cli/src/main.rs` is the subcommand router. It uses `clap` + `codex-arg0` (`arg0_dispatch_or_else`) so one executable can masquerade as the Linux sandbox helper too. Declared `Subcommand` variants (`main.rs#L145-L246`):

- `Exec` (non-interactive run) and `Review`
- `Login` / `Logout`
- `Mcp`, `Plugin`, `AppServer`, `RemoteControl`, `App`
- `Completion`, `Doctor`, `Sandbox`, `Debug`
- `Execpolicy`, `Apply`, `Resume`, `Queue`, `Archive`, `Unarchive`, `Delete`, `Fork`
- `MigrateRollouts`, `MigrateNfsDb`
- `Cloud`, `ResponsesApiProxy`, `StdioToUds`, `ExecServer`, `Features`
- plus `Agents`, `TcpTunnel`

CLI modules under `/data/home/forge/repo-tour/codex/codex-rs/cli/src`: `app_cmd.rs`, `cloud_config.rs`, `config_override_args.rs`, `daemon_install.rs`, `daemon_telemetry.rs`, `desktop_app`, `doctor.rs`, `login.rs`, `mcp_cmd.rs`, `mcp_login.rs`, `migrate_nfs_db.rs`, `migrate_rollouts.rs`, `plugin_cmd.rs`, `queue_cmd.rs`, `remote_control_cmd.rs`, `sandbox_setup.rs`, `sandbox_uninstall.rs`, `state_db_recovery.rs`, `wsl_paths.rs`, `debug_sandbox.rs`.

macOS/Windows allocator & desktop app: `main.rs#L205-L215` selects `tikv_jemallocator` on Linux musl and `mod desktop_app` on mac/windows.

### npm wrapper
`/data/home/forge/repo-tour/codex/codex-cli/package.json` is package `@openai/codex` with `bin.codex = bin/codex.js`. `/data/home/forge/repo-tour/codex/codex-cli/bin/codex.js` detects platform/arch, maps to a `PLATFORM_PACKAGE_BY_TARGET` npm sub-package (e.g. `@openai/codex-linux-x64`), and `spawn`s the native binary.

### Other workspace binaries (`[[bin]]`)
- `codex-tui` (interactive TUI) and `md-events` — `/data/home/forge/repo-tour/codex/codex-rs/tui/Cargo.toml`
- `codex-exec` — `/data/home/forge/repo-tour/codex/codex-rs/exec/Cargo.toml`
- `codex-app-server` + `exec-server` + `codex-app-server-test-notify-capture` — `/data/home/forge/repo-tour/codex/codex-rs/app-server/Cargo.toml`
- `codex-exec-server` (exec-server-cli), `codex-file-search`, `codex-responses-api-proxy`, `codex-network-proxy`
- `apply_patch` (standalone), `codex-linux-sandbox` + `bwrap` (linux-sandbox), `codex-windows-sandbox-setup` / `codex-command-runner` / `codex-windows-managed-deny-probe`, `codex-windows-sandbox-service`
- `codex-code-mode-host`, `codex-voice-host`, `codex-message-board-mcp`, `codex-stdio-to-uds`, `codex-plugin-test-helper`, `codex-write-config-schema`

---

## 5. Core subsystems with file paths

All under `/data/home/forge/repo-tour/codex/codex-rs/core/src`.

### Agent engine (turn loop)
Dirs: `agent/`, `session/`, `tasks/`, `state/`, `thread_manager/`, `turn_timing/`.
- Session and turn drive live in `session/` — `session.rs`, `turn.rs`, `step_activation.rs`, `step_context.rs`, `step_settings.rs`, `submission.rs`, `turn_input.rs`, `turn_context.rs`, `rollout_reconstruction.rs`, `context_window.rs`. `session/mod.rs` is the module root.
- Turn task kinds in `tasks/`: `regular.rs`, `review.rs`, `user_shell.rs`, `compact.rs`, `admission.rs`, `lifecycle.rs`.
- Per-turn lifecycle state in `state/`: `session.rs`, `turn.rs`, `turn_token_usage.rs`, `auto_compact_window.rs`, `additional_context.rs`, `service.rs`.
- `thread_manager/` — `managed.rs`, `model_catalog.rs`, `shared_instructions.rs`, `shutdown.rs`.
- `turn_timing/` — `report.rs`, `review_execution.rs`.

### Model client + Responses API
- `client.rs` (docs at top: `ModelClient` lives for the session; `ModelClientSession` per turn; Responses WebSocket prewarm; sticky `x-codex-turn-state` routing) and `client_common.rs`, `client_tool_metadata.rs`.
- `model_request.rs`, `responses_headers.rs`, `responses_metadata.rs`, `responses_retry.rs`.
- Underlying client crate: `codex-api` (`api_bridge.rs`, `endpoint/`, `sse/`, `auth.rs`, `rate_limits.rs`, `requests/`, `files.rs`, `images.rs`, `safety_buffering.rs`) and `codex-client` (`provider.rs`, `retry.rs`, `sse.rs`, `telemetry.rs`).
- Provider abstraction: `codex-model-provider` (`provider.rs`, `auth.rs`, `models_endpoint.rs`, `request_preparation.rs`, `runtime_auth.rs`, `amazon_bedrock/`, `gcp/`).

(continued)

### Tool dispatch + built-in tools
- Registry/router: `tools/mod.rs`, `tools/registry.rs`, `tools/router.rs`, `tools/orchestrator.rs`, `tools/parallel.rs`, `tools/lifecycle.rs`, `tools/hosted_spec.rs`, `tools/spec_plan.rs`, `tools/tool_namespaces_info.rs`.
- Handler implementations: `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/` — `apply_patch.rs`, `plan.rs` (update_plan), `view_image.rs`, `request_user_input.rs`, `request_permissions.rs`, `tool_search.rs`, `multi_agents.rs` / `multi_agents_v2.rs`, `mcp.rs` + `mcp_resource.rs`, `unified_exec.rs`, `sleep.rs`, `current_time.rs`, `get_context_remaining.rs`, `new_context_window.rs`, `extension_tools.rs`, `dynamic.rs`, `list_available_plugins_to_install.rs`, `request_plugin_install.rs`, `send_message_to_user_async.rs`, `wait_for_environment.rs`, `test_sync.rs`.
- Runtime executors: `tools/runtimes/apply_patch.rs`, `tools/runtimes/unified_exec.rs`.
- Tool metadata/JSON schema types live in `codex-tools` (`/data/home/forge/repo-tour/codex/codex-rs/tools/src`): `tool_definition.rs`, `tool_spec.rs`, `json_schema.rs`, `function_call_error.rs`, `tool_executor.rs`, `responses_api.rs`, `output_schema.rs`, `code_mode.rs`.

**Key built-in tools and where implemented:**
- **shell / exec** — `core/src/exec.rs` (spawning + sandboxed exec), `shell-command` crate, `tools/handlers/shell_spec.rs`.
- **apply_patch** — `core/src/apply_patch.rs`, handler `handlers/apply_patch.rs`, runtime `tools/runtimes/apply_patch.rs`; parser/applier in `codex-apply-patch`.
- **update_plan** — `handlers/plan.rs` + prompt `prompts/src/update_plan_instructions.rs`.
- **view_image** — `handlers/view_image.rs`; image prep in `core/src/image_preparation.rs`.
- **unified_exec** — `core/src/unified_exec/` (process manager, command sessions, async watcher, stdin approval, shell snapshot) + `handlers/unified_exec.rs` + `tools/runtimes/unified_exec.rs`.
- **web_search** — `ext/web-search` extension + `handlers/tool_search.rs`, remote search via `codex-api/search.rs`.
- **request_user_input / permissions / MCP tools / multi-agent tools / code-mode** — as listed above.

### Prompt construction
- Prompts crate: `/data/home/forge/repo-tour/codex/codex-rs/prompts/src` — `model_instructions.rs` (renders base instructions from model metadata), `compact.rs`, `guardian_instructions.rs`, `multi_agent_instructions.rs`, `permissions_instructions.rs`, `realtime.rs`, `review_exit.rs`, `review_request.rs`, `update_plan_instructions.rs`, `model_messages/`.
- Conversation/context assembly: `core/src/context/`, `core/src/context_manager/` (`history.rs`, `normalize.rs`, `sampling.rs`, `updates.rs`, `image_availability.rs`), `core/src/agents_md.rs` + `agents_md_manager.rs` (AGENTS.md ingestion).

### Session/state + rollout persistence
- Rollout: `codex-rollout` crate + `core/src/rollout.rs`, `core/src/rollout_budget.rs`.
- State DB: `codex-state` (`src/sqlite.rs`, `migrations.rs`, `log_db.rs`, `paths.rs`, `runtime.rs`, `telemetry.rs`).
- History: `codex-history`, `codex-message-history`, `core/src/session/rollout_reconstruction.rs`.
- Compaction: `core/src/compact.rs` + the `compact_*` family (`compact_remote_v2*.rs`, `compact_token_budget.rs`, `compact_model_fallback.rs`).

### Sandboxing + approvals
- Orchestration crate `codex-sandboxing` (`/data/home/forge/repo-tour/codex/codex-rs/sandboxing/src`): `seatbelt.rs` + `.sbpl` policy files (macOS), `landlock.rs`, `bwrap.rs`, `linux_pid_namespace.rs`, `manager.rs`, `policy_transforms.rs`, `spawn.rs`, `denial.rs`, `violation.rs`, `windows.rs`, `windows_mxc.rs`, `seatbelt_daemon.rs`.
- Linux launcher crate `codex-linux-sandbox` (`linux_run_main.rs`, `seccomp.rs`, `launcher.rs`, `proxy_lifecycle.rs`, `wslg.rs`, `fd_mount.rs`, `bundled_bwrap.rs`).
- Windows: `windows-sandbox-rs` (AppContainer ACLs, WFP, provisioning) + `windows-sandbox-service`.
- Approvals: `core/src/tools/approvals.rs`, `core/src/tools/sandboxing.rs`, `core/src/tools/network_approval.rs`, `utils/approval-presets`; policy engine `codex-execpolicy`.

### TUI
`codex-tui` (`/data/home/forge/repo-tour/codex/codex-rs/tui/src`): `app.rs`, `cli.rs`, `chatwidget.rs` + `chatwidget/`, `bottom_pane/`, `status/`, `status_indicator_widget/`, `streaming/`, `transcript_view/`, `transcript_transcript*`, `diff_render.rs`, `config_panel/`, `theme_picker.rs`, `slash_command.rs`, `custom_terminal.rs`, `terminal_hyperlinks/`, `ui_tree.rs`, `app_server_session.rs`, `app_server_connection.rs`.

### Config
`codex-config` (`/data/home/forge/repo-tour/codex/codex-rs/config/src`): `config_toml.rs`, `loader/`, `merge.rs`, `overrides.rs`, `requirements_layers/`, `permissions_toml.rs`, `project_trust.rs`, `model_provider_defaults.rs`, `mcp_ema.rs`, `skills_config.rs`, `tui_keymap.rs`, `strict_config.rs`; schema in `codex-config-schema`.

### MCP client + server
`codex-mcp` (`/data/home/forge/repo-tour/codex/codex-rs/codex-mcp/src`): `connection_manager.rs` + `connection_pool.rs`, `auth.rs`, `catalog.rs`, `resource_client.rs`, `server.rs`, `codex_apps.rs`, `rmcp_client.rs`, `proxy`/`runtime`. Server side in `message-board-mcp`, `ext/mcp`; core glue `core/src/mcp.rs`, `core/src/mcp_tool_call.rs`, `core/src/session/mcp.rs`.

### Auth / login
`codex-login` (`/data/home/forge/repo-tour/codex/codex-rs/login/src`): `AuthManager`, API-key/ChatGPT OAuth/device-code flows; `codex-keyring-store`, `codex-secrets`, `aws-auth`, `codex-websocket-auth`, `codex-workload-identity`.

### LSP / IDE / app-server
`codex-app-server` (`app-server/src`: `message_processor.rs`, `request_processors.rs`, `thread_state.rs`, `config_manager*.rs`, `mcp_refresh.rs`, `transport.rs`, `server_request_error.rs`, `code_mode_host.rs`, `fs_watch.rs`, `fuzzy_file_search.rs`). Protocol in `codex-app-server-protocol` (`rpc.rs`, `protocol/`, `export.rs`). IDE clients use the JSON-RPC surface.

### Telemetry
`codex-otel` + `codex-otel-trace-websocket`; initialization `core/src/otel_init.rs`, `core/src/analytics`, `core/src/diagnostics`, `codex-analytics`.

---

## 6. Request lifecycle (high level)

1. **Startup** — `codex` (`cli/src/main.rs`) parses subcommands, resolves config (`codex-config` loader + overrides + requirements), chooses surface: interactive TUI (`codex-tui`), non-interactive `codex exec` (`codex-exec`), or app-server (JSON-RPC) for IDE/desktop.
2. **Session/Thread creation** — `core` builds a `Session` (`session/session.rs`) with a `ThreadId`; loads transcripts/rollout, AGENTS.md, MCP prewarm, model catalog.
3. **Turn submission** — user input becomes a `Submission`/`TurnInput` (`session/submission.rs`, `session/turn_input.rs`); a turn task (`tasks/regular.rs`) is activated (`session/step_activation.rs`).
4. **Prompt assembly** — `context_manager` + `codex-prompts` render model instructions and conversation history, including tool specs from `codex-tools`.
5. **Model call** — `core/src/client.rs` `ModelClient`/`ModelClientSession` streams the Responses API (SSE or WebSocket prewarm); providers resolved via `codex-model-provider`; retries/fallbacks in `responses_retry.rs`.
6. **Tool dispatch** — `tools/router.rs` + `orchestrator.rs` + `parallel.rs` route tool calls to handlers (`tools/handlers/*`) and runtimes; sandbox/approval decisions from `sandboxing` + `execpolicy` + `tools/approvals.rs` gate execution.
7. **Execution** — `core/src/exec.rs` / `unified_exec/` spawn sandboxed processes; output normalized to `ExecToolCallOutput`.
8. **Persistence** — turns/items appended to rollout (`codex-rollout`) and state DB (`codex-state`); telemetry via `codex-otel`.
9. **Emit** — events flow to TUI (`tui`) or app-server notifications for IDE clients; loop repeats until turn completion/idle.

---

(continued)
## 7. Notable / unique subsystems

### Sandboxing (seatbelt / landlock / bwrap / Windows)
This Codex has an unusually deep, multi-platform sandbox stack, far beyond the classic single `sandboxing` crate:
- **macOS (Seatbelt)**: `codex-sandboxing` ships `.sbpl` policies (`seatbelt_base_policy.sbpl`, `seatbelt_network_policy.sbpl`, `seatbelt_read_only_platform_defaults.sbpl`, `seatbelt_preferences_policy.sbpl`) plus `seatbelt.rs`, a `seatbelt_daemon.rs` and scratch/TLS variants.
- **Linux (Landlock + bwrap + seccomp)**: `sandboxing/landlock.rs`, `bwrap.rs`, `linux_pid_namespace.rs`; dedicated launcher crate `codex-linux-sandbox` with `seccomp.rs`, `proxy_lifecycle.rs`, WSLg handling, and a bundled `bwrap` (also a standalone `bwrap` crate/bin).
- **Windows**: distinct `windows-sandbox-rs` (AppContainer ACLs, `wfp.rs` firewall, provisioning client, `deny_read_*`) plus a `windows-sandbox-service` and a `mxc-sandbox` (Microsoft Mxc) path.
- Policy transforms + violation/denial reporting (`policy_transforms.rs`, `violation.rs`, `denial.rs`) and `core/src/network_policy_decision.rs`.
- The `arg0` crate lets the same `codex` binary re-exec as the sandbox helper (`arg0_dispatch_or_else`).

### MCP (client + server + apps)
Beyond a basic MCP client, there is a full `codex-mcp` subsystem: connection manager with pooling, OAuth/EMA auth (`ema_auth.rs`), a tool catalog with caching, resource client, `codex_apps` (OpenAI-hosted apps), pagination, plus a `server.rs` for exposing Codex as an MCP server and a separate `message-board-mcp` / `ext/mcp`. Core integrates via `mcp_tool_call/`, `session/mcp.rs`, `mcp_tool_exposure.rs`.

### app-server (JSON-RPC for IDE/app/desktop)
`codex-app-server` is a first-class JSON-RPC server (not bolted on): a `message_processor.rs`, typed `request_processors/`, thread lifecycle, `config_manager` service, `code_mode_host`, filesystem watch + fuzzy search, plus a `daemon` and a `transport` (stdio/`stdio-to-uds`). The **protocol is code-generated** — `codex-app-server-protocol` exports TypeScript and JSON schema (`just write-app-server-schema`, `GenerateTs`/`GenerateJsonSchema` subcommands), and the Python SDK is derived from it.

### Extensions & plugins
A formal extension API (`ext/extension-api`) with ~18 built-in extensions (`ext/*`) and a plugin runtime (`codex-plugin`, `plugin-host`). `tools/handlers/extension_tools.rs` and `dynamic.rs` bridge them into the tool registry.

### Code mode / V8
`code-mode*` crates + `v8-poc` run an embedded V8 to support "code mode" JS tool orchestration, hosted by `codex-code-mode-host`.

### Realtime / voice / WebRTC
`realtime-webrtc`, `voice-host`, `utils/audio`, plus core `realtime_conversation/`, `realtime_history/`, `realtime_prompt.rs`, and `otel-trace-websocket`.

### Multi-agent
`core/src/agent/` (control, registry, roles, host), `multi_agents` / `multi_agents_v2` tools, and dedicated crates `agent-graph-store`, `agent-identity`, `agent-roles`, `agent-message-board-*`, `message-board`.

### Guardians (safety review)
`ext/guardian-reviewer`, `ext/guardian-v2`, `ext/guardian-v3`, `codex-guardian-context`, plus `core/src/guardian/` and `guardian_review.rs` — automated safety/review passes over model output.

---

## 8. UNIQUE vs COMMON features

### Common (typical of coding agents)
- Terminal TUI, non-interactive `exec` mode, config in TOML, sandbox + approval modes, MCP client, subagents, model provider abstraction (ChatGPT / API key / Bedrock / local Ollama & LM Studio), file search, apply_patch, AGENTS.md instructions, session resume/fork/archive/delete, telemetry.

### Unique / differentiating
- **Three-surface monorepo** (CLI + IDE app-server + desktop app) with a **code-generated, schema-exported JSON-RPC protocol** shared with SDKs.
- **App-server daemon + remote control** (`codex app-server daemon/bootstrap/proxy`, `RemoteControl`, `tcp-tunnel`, `stdio-to-uds`) — a persistent background agent server.
- **Deep, per-OS sandbox stack** with policy DSLs (Seatbelt SBPL), Landlock+seccomp+bwrap, and a full Windows AppContainer/WFP sandbox + service.
- **Starlark execpolicy** engine (`codex-execpolicy`) for prefix-based command decisions, exposed via `codex execpolicy check`.
- **Guardian** safety-review extensions (v2/v3) and separate reviewer — an automated review-of-actions layer.
- **Code mode (V8)** and **message board / agent graph** for multi-agent collaboration.
- **Rollout trace + replay bundles** (`rollout-trace`, `REDUCED_STATE_FILE_NAME`, `debug trace-reduce`).
- **Network proxy + network policy decisions** (`network-proxy`, `network_policy_decision.rs`) and `responses-api-proxy` as a local Responses API shim.
- **SQLite state + log DB with NFS migration** (`state_db_recovery`, `migrate_nfs_db`, `log_db`) and a `logs_client` binary.
- **Extensive internal util crate net** (~40 `utils/*` crates) reflecting a heavily modularized, Bazel+Cargo dual-build codebase.
- **Multi-provider runtime auth** (`runtime-agent-instance`, workload identity, AWS/WebSocket auth) for enterprise/bedrock deployments.

---

## 9. Most important absolute paths

Build/workspace:
- `/data/home/forge/repo-tour/codex/codex-rs/Cargo.toml` — workspace manifest (member list + deps)
- `/data/home/forge/repo-tour/codex/justfile` — dev task runner
- `/data/home/forge/repo-tour/codex/README.md`, `/data/home/forge/repo-tour/codex/MODULE.bazel`, `/data/home/forge/repo-tour/codex/BUILD.bazel`, `/data/home/forge/repo-tour/codex/defs.bzl`
- `/data/home/forge/repo-tour/codex/package.json`, `/data/home/forge/repo-tour/codex/pnpm-workspace.yaml`

Entry points:
- `/data/home/forge/repo-tour/codex/codex-rs/cli/src/main.rs` — CLI router
- `/data/home/forge/repo-tour/codex/codex-rs/cli/Cargo.toml` — `codex` + `logs_client` bins
- `/data/home/forge/repo-tour/codex/codex-cli/bin/codex.js` — npm launcher

Core engine:
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/client.rs` — model client / Responses API
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/session/session.rs` — session
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/session/turn.rs` — turn loop
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/router.rs` — tool dispatch
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/exec.rs` — sandboxed exec
- `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/apply_patch.rs`, `.../plan.rs`, `.../view_image.rs`, `.../unified_exec.rs`

Subsystems:
- `/data/home/forge/repo-tour/codex/codex-rs/sandboxing/src/seatbelt.rs`, `.../landlock.rs`, `.../bwrap.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/linux-sandbox/src/linux_run_main.rs`, `.../seccomp.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/windows-sandbox-rs/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/execpolicy/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/codex-mcp/src/connection_manager.rs`, `.../server.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/app-server/src/message_processor.rs`, `.../main.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/app-server-protocol/src/rpc.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/tui/src/app.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/config/src/config_toml.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/state/src/sqlite.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/rollout/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/login/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/prompts/src/model_instructions.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/model-provider/src/provider.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/otel/src/lib.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/tools/src/tool_definition.rs`
- `/data/home/forge/repo-tour/codex/codex-rs/exec/src/lib.rs`

Docs:
- `/data/home/forge/repo-tour/codex/docs/config.md`, `/data/home/forge/repo-tour/codex/docs/sandbox.md`, `/data/home/forge/repo-tour/codex/docs/exec.md`, `/data/home/forge/repo-tour/codex/docs/execpolicy.md`, `/data/home/forge/repo-tour/codex/docs/authentication.md`, `/data/home/forge/repo-tour/codex/docs/skills.md`

— End of tour —
## 7. Notable / unique subsystems

### Sandboxing (seatbelt / landlock / bwrap / Windows)
This Codex has an unusually deep, multi-platform sandbox stack, far beyond the classic single sandboxing crate:
- **macOS (Seatbelt)**: codex-sandboxing ships .sbpl policies (seatbelt_base_policy.sbpl, seatbelt_network_policy.sbpl, seatbelt_read_only_platform_defaults.sbpl, seatbelt_preferences_policy.sbpl) plus seatbelt.rs, a seatbelt_daemon.rs and scratch/TLS variants.
- **Linux (Landlock + bwrap + seccomp)**: sandboxing/landlock.rs, bwrap.rs, linux_pid_namespace.rs; dedicated launcher crate codex-linux-sandbox with seccomp.rs, proxy_lifecycle.rs, WSLg handling, and a bundled bwrap (also a standalone bwrap crate/bin).
- **Windows**: distinct windows-sandbox-rs (AppContainer ACLs, wfp.rs firewall, provisioning client, deny_read_*) plus a windows-sandbox-service and a mxc-sandbox path.
- Policy transforms + violation/denial reporting (policy_transforms.rs, violation.rs, denial.rs) and core/src/network_policy_decision.rs.
- The arg0 crate lets the same codex binary re-exec as the sandbox helper (arg0_dispatch_or_else).

### MCP (client + server + apps)
Beyond a basic MCP client, there is a full codex-mcp subsystem: connection manager with pooling, OAuth/EMA auth (ema_auth.rs), a tool catalog with caching, resource client, codex_apps (OpenAI-hosted apps), pagination, plus a server.rs for exposing Codex as an MCP server and a separate message-board-mcp / ext/mcp. Core integrates via mcp_tool_call/, session/mcp.rs, mcp_tool_exposure.rs.

### app-server (JSON-RPC for IDE/app/desktop)
codex-app-server is a first-class JSON-RPC server (not bolted on): a message_processor.rs, typed request_processors/, thread lifecycle, config_manager service, code_mode_host, filesystem watch + fuzzy search, plus a daemon and a transport (stdio/stdio-to-uds). The protocol is code-generated - codex-app-server-protocol exports TypeScript and JSON schema (just write-app-server-schema, GenerateTs/GenerateJsonSchema subcommands), and the Python SDK is derived from it.

### Extensions & plugins
A formal extension API (ext/extension-api) with ~18 built-in extensions (ext/*) and a plugin runtime (codex-plugin, plugin-host). tools/handlers/extension_tools.rs and dynamic.rs bridge them into the tool registry.

### Code mode / V8
code-mode* crates + v8-poc run an embedded V8 to support "code mode" JS tool orchestration, hosted by codex-code-mode-host.

### Realtime / voice / WebRTC
realtime-webrtc, voice-host, utils/audio, plus core realtime_conversation/, realtime_history/, realtime_prompt.rs, and otel-trace-websocket.

### Multi-agent
core/src/agent/ (control, registry, roles, host), multi_agents / multi_agents_v2 tools, and dedicated crates agent-graph-store, agent-identity, agent-roles, agent-message-board-*, message-board.

### Guardians (safety review)
ext/guardian-reviewer, ext/guardian-v2, ext/guardian-v3, codex-guardian-context, plus core/src/guardian/ and guardian_review.rs - automated safety/review passes over model output.

