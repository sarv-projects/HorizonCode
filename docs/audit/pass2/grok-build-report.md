# Grok Build (`grok`) — Deep Code-Organization Tour

Repository: [`xai-org/grok-build`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8)  
Org: `xai-org` (SpaceXAI) · Primary language: **Rust** (edition 2024) · Artifact: `xai-grok-pager` (shipped as `grok`)  
Monorepo sync commit (`SOURCE_REV`): `559751fdcec02d413e4c57c8832ab275e4f44980`  
License: Apache-2.0 (first-party) · Builds via Cargo workspace (Bazel lint aspect also referenced in comments)  
All paths below are absolute and read-only; no file in the repo was modified.

---

## 1. Identity

**Grok Build** is SpaceXAI's terminal-based AI coding agent. From `grok-build/README.md:13-17` (path not found in the pinned clone, not verified):

> "Grok Build is SpaceXAI's terminal-based AI coding agent. It runs as a full-screen TUI that understands your codebase, edits files, executes shell commands, searches the web, and manages long-running tasks — interactively, headlessly for scripting/CI, or embedded in editors via the Agent Client Protocol (ACP)."

Three delivery surfaces (README.md:13-17, 76-83):
- **Interactive** — a full-screen, mouse-interactive TUI ("the pager").
- **Headless** — `-p`/`--single`, `--prompt-json`, `--prompt-file`, `--output-format`, JSON schema structured output; runs via the `agent` subcommand modes (stdio / headless / serve / leader).
- **Embedded** — ACP over stdio for IDE clients.

Binary name: the built artifact is `xai-grok-pager` (`README.md:76-83`); released installs ship it as `grok`. Launched by `curl -fsSL https://x.ai/cli/install.sh | bash` or PowerShell equivalent (README.md:45-49).

Key repository meta-facts:
- The root `Cargo.toml` is **generated** and treated as read-only; per-crate `Cargo.toml` files are the edit surface (`Cargo.toml:1`, README.md:108-111).
- Toolchain pinned to Rust **1.94.0** with `rustfmt` + `clippy`, targets `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` (`grok-build/rust-toolchain.toml:1-8` (path not found in the pinned clone, not verified)).
- `rustfmt.toml` is a one-liner: `use_field_init_shorthand = true` (`grok-build/rustfmt.toml:1` (path not found in the pinned clone, not verified)).
- External contributions are **not** accepted (`CONTRIBUTING.md:1-8`); security via HackerOne (`SECURITY.md:1-7`).
- DotSlash is required so `bin/protoc` can resolve; proto codegen uses `bin/protoc` (`README.md:60-71`).
- Workspace uses `resolver = "2"`, `[workspace.package] edition = "2024"`, `license = "Apache-2.0"` (`Cargo.toml:6-121`).

`clippy.toml` ([`grok-build/clippy.toml`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/clippy.toml)) encodes strong cross-cutting policy discipline:
- Bans raw `std::fs::canonicalize` / `Path::canonicalize` / `tokio::fs::canonicalize` in favour of `dunce::canonicalize` (Windows `\\?\` verbatim paths) (lines 15-47).
- Bans `reqwest::Client::new` / `ClientBuilder::build` — all outbound HTTP must go through the grok TLS policy (`xai_grok_extra_ca`) (lines 40-44).
- Bans `std::env::home_dir` / `dirs::home_dir` — home resolution must go through `xai-dirs`/`xai_grok_config::grok_home` (lines 24-35, 48-51).
- Bans raw child-process spawn (`std::process::Command::spawn`, `tokio::process::Command::spawn`, `portable_pty::SlavePty::spawn_command`) — children must be enrolled via `xai_tty_utils::ProcessScope::enroll` so they die with the session (lines 20-22, 52-54).
- Per-crate `crates/codegen/**` `clippy.toml` duplicates these (clippy does not merge) (`clippy.toml:1-6`).

Production profiles in `Cargo.toml:402-466`: `release` (panic=abort, incremental), `release-dist` (thin LTO, codegen-units=1, symbols kept for .dSYM/.debug sidecars), `x-prod`, `release-dist-jemalloc`, `admin-cli-dist` (opt-level="z"), `dev` (panic=abort, codegen-units=128), `bench`. Workspace lint overrides for clippy at `Cargo.toml:468-492`.

---

## 2. Top-level map

```
`grok-build/` (path not found in the pinned clone, not verified)
├── Cargo.toml              # GENERATED workspace root (members, deps, lints, profiles)
├── Cargo.lock              # 364 KB
├── clippy.toml             # codegen-wide clippy policy (bans: canonicalize, reqwest, home_dir, spawn)
├── rustfmt.toml            # use_field_init_shorthand
├── rust-toolchain.toml     # Rust 1.94.0 + rustfmt/clippy
├── README.md / CONTRIBUTING.md / SECURITY.md / LICENSE (Apache-2.0)
├── THIRD-PARTY-NOTICES     # 763 KB generated notices
├── SOURCE_REV              # monorepo commit SHA
├── .cargo/config.toml      # per-target linker flags (RELRO, NX stack)
├── bin/protoc              # DotSlash-wrapped hermetic protoc
├── crates/
│   ├── build/              # xai-proto-build (protobuf codegen helper)
│   ├── common/             # 12 shared leaf crates (tool runtime/protocol/types, tracing, computer-hub, compaction)
│   └── codegen/            # ~89 crate CLI closure (pager, shell, tools, model clients, TUI, sandbox, …)
├── prod/mc/cli-chat-proxy-types/   # wire types shared with the server-side cli-chat-proxy
└── third_party/            # vendored upstream (Mermaid stack) + NOTICE + README
    ├── dagre_rust/         # Dagre layout (vendored, library-only)
    ├── graphlib_rust/      # Dagre graphlib (vendored)
    ├── mermaid-to-svg/     # Mermaid -> SVG via dagre port (vendored)
    └── ordered_hashmap/    # insertion-order map (vendored)
```

Stat: 3,612 `.rs` files under `crates/` (excluding `target/`). The `codegen` tree is where the shipping product lives; `common`/`build`/`prod`/`third_party` are the small leaf crates pulled in by that closure (README.md:105).

Note: `third_party/README.md:9-11` also describes vendored `nfsserve` (grove-on-NFS userspace server) and `fuser` (grove FUSE client), but those two directories are **not present** in this synced tree — only `dagre_rust`, `graphlib_rust`, `mermaid-to-svg`, `ordered_hashmap` are (they are the four `third_party/*` workspace members in `Cargo.toml:112-115`). Treat `nfsserve`/`fuser` as monorepo-only.

---

## 3. Crate graph + responsibilities

Workspace membership is enumerated in `grok-build/Cargo.toml:8-116` (path not found in the pinned clone, not verified). The crate closure is deliberately **decomposed into many small crates** ("so they compile in parallel" is stated verbatim in several descriptions, e.g. `xai-grok-shell-terminal`). Groupings below are by responsibility; all descriptions are quoted from each crate's `Cargo.toml`.

### 3.1 Composition root & TUI

| Crate | Path | Responsibility |
|---|---|---|
| `xai-grok-pager-bin` | `crates/codegen/xai-grok-pager-bin` | Composition-root package; builds the `xai-grok-pager` binary. Links the pager library and the optional `xai-grok-pager-minimal` render mode (Cargo-cycle break). `[[bin]] name = "xai-grok-pager"`. |
| `xai-grok-pager` | `crates/codegen/xai-grok-pager` | The TUI: scrollback, prompt, modals, rendering, slash commands, settings, dashboard, headless, wrap. 649 `.rs` files. |
| `xai-grok-pager-render` | `crates/codegen/xai-grok-pager-render` | Rendering engine primitives: appearance/theme, glyphs, host, input, render, search, syntax, terminal (alt-screen policy), clipboard, link opener. |
| `xai-grok-pager-diff` | `crates/codegen/xai-grok-pager-diff` | "Diff hunk construction for the Grok Build TUI". |
| `xai-grok-pager-minimal` | `crates/codegen/xai-grok-pager-minimal` | Scrollback-native (inline) render mode, wired in via an IoC fn-pointer seam (`minimal/api.rs`, `minimal/hook.rs`, `minimal/reprint.rs`). |
| `xai-grok-pager-pty-harness` | `crates/codegen/xai-grok-pager-pty-harness` | "Shared PTY harness + scenario library for xai-grok-pager e2e tests and benchmarks". |
| `xai-ratatui-inline` | `crates/codegen/xai-ratatui-inline` | Inline-mode ratatui support. |
| `xai-ratatui-textarea` | `crates/codegen/xai-ratatui-textarea` | Textarea widget for the prompt. |

### 3.2 Agent runtime, session, shell

| Crate | Responsibility |
|---|---|
| `xai-grok-agent` (codegen) | "Agent builder, definition parsing, and system prompt assembly." Builds an `Agent` = tools + prompt + reminder + compaction policy. |
| `xai-grok-shell` | Agent runtime + leader/stdio/headless entry points; owns the per-session `SessionActor`, ACP method handling, MCP wiring, persistence. |
| `xai-grok-shell-base` | "Foundation modules for the grok shell crate family: environment presets, CPU profiling, and process/filesystem utilities." |
| `xai-grok-shell-session-support` | "Session-support modules …: managed MCP gateway catalog/call caching and file-access tracking." |
| `xai-grok-shell-terminal` | "Local, ACP, and PTY terminal runners extracted from xai-grok-shell so they compile in parallel." |
| `xai-chat-state` | "Actor-based chat state management for xAI agents." |
| `xai-agent-lifecycle` | Agent lifecycle hooks/broker. |
| `xai-grok-lifecycle` | "Pre-stop lifecycle broker for the workspace server: trigger endpoint, handler registry, and exec runner." |
| `xai-grok-active-sessions` | "Registry of open TUI sessions in a lock-guarded JSON file under the grok home." |
| `xai-grok-session-events` | "Typed per-session event log written as JSON lines." |
| `xai-grok-session-search` | "SQLite FTS5 index over local grok sessions: lease-guarded bootstrap, debounced incremental upserts, and BM25 ranked query." |
| `xai-grok-foreign-sessions` | "Bounded, metadata-only discovery of foreign coding-agent sessions." |
| `xai-grok-subagent-resolution` | "Shared subagent definition, runtime, prompt, and resume resolution." |
| `xai-prompt-queue` | "Shared prompt-queue wire types for xai-grok-shell and xai-grok-pager." |
| `xai-grok-status-line` | "The status-line contract: the `[ui.status_line]` config a user writes and the payload the agent sends clients." |
| `xai-grok-workspace` | "Core host-local workspace library (FS, VCS, execution, discovery) for xai-grok-shell and remote sampler." |
| `xai-grok-workspace-types` | "Wire types for the xAI workspace API (request/chunk/event enums shared by client and server)." |
| `xai-grok-workspace-client` | "Lightweight typed client for hub-proxied workspace.* RPCs." |
| `xai-grok-workspace-daemon` | "Process lifecycle for the workspace-server daemon: self-daemonization, single-instance pidfile locking, and preview-proxy child supervision." |
| `xai-grok-compaction` (common) | "Shared, transport-agnostic compaction engine for Grok chat and Grok Build." |
| `xai-compaction-transcript` | "Markdown rendering of compacted conversation segments and the on-disk segment-store naming convention." |
| `xai-interjection-core` (common) | "Shared mid-turn interjection buffer and formatting for the client and server agent loops." |
| `xai-message-delivery-core` (common) | Message delivery primitives (client/server). |
| `xai-workflow` | "Rhai-scripted dynamic workflow engine: scripts orchestrate agents through a host channel." |
| `xai-codebase-graph` | "High-performance code graph generation using tree-sitter queries." |

### 3.3 Model / provider / inference

| Crate | Responsibility |
|---|---|
| `xai-grok-sampler` | "Actor-based sampling/inference layer for xAI grok (HTTP streaming + retry, no shell coupling)." |
| `xai-grok-sampling-types` | "Pure data types for the xAI sampling / chat-completion API layer." |
| `xai-grok-models` | "Default model IDs for the grok CLI, loaded from the embedded default_models.json." |
| `xai-grok-http` | "Shared reqwest HTTP clients and User-Agent construction for the grok CLI." |
| `xai-grok-extra-ca` | "TLS policy for the grok CLI: rustls backend pin, process crypto provider, shared root store, and opt-in GROK_EXTRA_CA_BUNDLE roots." |
| `xai-grok-egress-proxy` | "Hidden exact-origin local HTTP and CONNECT proxy for Grok." |
| `xai-grok-image` | "Image validation and transcoding shared by Grok tools and clients." |
| `xai-token-estimation` | "Pure shared token-estimation primitives." |
| `prod-mc-cli-chat-proxy-types` | `prod/mc/cli-chat-proxy-types` — lightweight request/response types for the cli-chat-proxy API. |

### 3.4 Tools & tool runtime

| Crate | Responsibility |
|---|---|
| `xai-grok-tools` | "Grok tools library" — all built-in tool implementations, registry, bridge, sandbox launch. |
| `xai-grok-tools-api` | "Protobuf API definitions for Grok tools." |
| `xai-tool-runtime` (common) | "Unified Tool trait, dispatch trait, error taxonomy, notifications, and search index for the xAI Computer Hub." |
| `xai-tool-types` (common) | "Canonical tool-description types for the xAI platform." |
| `xai-tool-protocol` (common) | "Wire-protocol types for the xAI Computer Hub." |
| `xai-computer-hub-core` (common) | "Transport, ToolRegistry, and resolver abstractions for the xAI Computer Hub." |
| `xai-computer-hub-sdk` (common) | "SDK for the xAI Computer Hub: connection pool, transparent reconnect, tool harness, and tool-server runtime." |
| `xai-computer-hub-mcp-adapter` (common) | "Bridge between MCP servers and the xAI Computer Hub, registering MCP-discovered tools as native hub tools." |

### 3.5 Integrations: MCP, hooks, plugins, LSP, ACP

| Crate | Responsibility |
|---|---|
| `xai-grok-mcp` | "MCP integration crate. Quarantines rmcp + reqwest 0.13 … and owns the MCP credential store and OAuth flow orchestrator." |
| `xai-hooks-plugins-types` | "Shared DTO types for hooks/plugins ACP extensions (wire format only)." |
| `xai-grok-hooks` | "Runtime hook system for Grok — file-based discovery, command execution, and policy enforcement." |
| `xai-grok-plugin-marketplace` | Plugin marketplace: catalog, index, git, installer, matcher, scanner. |
| `xai-acp-lib` | ACP (Agent Client Protocol) channels, gateways, JSON-RPC message types, stdin/line readers. |
| `xai-grok-external-agent-migration` | "Import Claude settings into Grok config: permissions, hooks, MCP servers, environment variables, skill directories, and rule directories." |

### 3.6 Permissions, sandbox, secrets, trust

| Crate | Responsibility |
|---|---|
| `xai-grok-permission-rules` | "Grok's permission rule engine, apart from the session and tool code that uses it." |
| `xai-grok-sandbox` | "OS-level sandboxing for Grok Build using kernel primitives (Landlock/Seatbelt) via nono." |
| `xai-grok-secrets` | "Regex sanitizer for Grok Build outbound data (Sentry / Mixpanel / product-event scrubbing)." |
| `xai-grok-file-lock` | "Bounded non-blocking advisory file locks for grok-home files…" |
| `xai-sqlite-journal` | "Filesystem-aware SQLite journal-mode selection: WAL on local disks, rollback journal on network mounts…" |

### 3.7 Auth, config, environment

| Crate | Responsibility |
|---|---|
| `xai-grok-login` | "Authentication subsystem for the grok shell crate family: login flows, token refresh, credential providers, and auth storage." |
| `xai-grok-auth` | "Auth dependency-inversion seam: HttpAuth + AuthCredentialProvider traits." |
| `xai-grok-config` | "Grok config: grok_home, effective config (requirements over user over managed), TOML merge, service endpoints, remote settings, and vendor compat." |
| `xai-grok-config-types` | "Leaf configuration value types for the grok CLI, extracted from xai-grok-shell for dependency inversion." |
| `xai-grok-cloud-config` | "Fetches Grok cloud settings, keeps them in a signed cache, and refreshes them mid-session." |
| `xai-grok-env` | "Backend environment for the Grok CLI crate family: endpoint URL presets, shared GROK_*/XAI_* readers, the credentials-path resolver…" |
| `xai-dirs` | "Home-directory resolution generally: USERPROFILE-first home_dir, plus grok-home ($GROK_HOME or <home>/.grok)." |
| `xai-grok-paths` | "Type-safe path wrappers for absolute and relative UTF-8 paths." |

### 3.8 Filesystem, VCS, execution

| Crate | Responsibility |
|---|---|
| `xai-fsnotify` | "Local-filesystem event source: single causal stream of semantic FsEvents." |
| `xai-fuzzy-file-search` | "Fuzzy file search over a directory tree: an ignore-aware walker feeding a nucleo matcher, plus a background daemon." |
| `xai-file-utils` | "Local data collection: upload queueing and blob storage." |
| `xai-fast-worktree` | "High-performance git worktree creation using CoW cloning." |
| `xai-gix-status` | "Shared gix status helpers: thread budget under RLIMIT_NPROC…" |
| `xai-hunk-tracker` | "Track file hunks (diffs) with agent/external attribution." |
| `xai-tty-utils` | "Lightweight process-spawning utilities for TTY safety — detach from controlling terminal, suppress interactive pagers, process-group lifecycle." |
| `xai-system-power` | "Cross-platform system sleep/wake (suspend) notifications — used to defer work across a suspend boundary." |
| `ptyctl` / `ptyctl-cli` | "Headless PTY controller built on alacritty_terminal" + its CLI (task terminals). |

### 3.9 Rendering of content (markdown / mermaid)

| Crate | Responsibility |
|---|---|
| `xai-grok-markdown` | "Streaming markdown renderer for terminal UIs." |
| `xai-grok-markdown-core` | "Headless markdown analysis sharing Grok Build's exact pulldown-cmark config." |
| `xai-grok-mermaid` | "Render Mermaid diagram source to a rasterized PNG behind a swappable engine trait." |
| `third_party/mermaid-to-svg`, `dagre_rust`, `graphlib_rust`, `ordered_hashmap` | Vendored Mermaid layout stack. |

### 3.10 Telemetry, diagnostics, feedback, update, misc

| Crate | Responsibility |
|---|---|
| `xai-grok-otel` | "OpenTelemetry foundation … W3C trace-context propagation, the OTLP HTTP client, and the tracing->OTLP span layer/provider." |
| `xai-grok-telemetry` | "Telemetry engine: product events + Mixpanel emission + Sentry error reporting for Grok Build sessions." |
| `xai-mixpanel` | "Lightweight Mixpanel HTTP tracking client…" |
| `xai-grok-feedback` | "Shared feedback taxonomy, durable local draft storage, and the session trace archive builder…" |
| `xai-grok-diag-server` | "In-guest diagnostics HTTP server (/ready, /statusz, /logs)…" |
| `xai-grok-crash-handler` | "Cross-platform crash handler (Unix signals + Windows SEH) with startup crash detection." |
| `xai-grok-update` | Self-update: version policy, channels, download/install, leader relaunch. |
| `xai-grok-version` | "Lockstepped grok CLI version." |
| `xai-grok-announcements` | "Shared announcement types, persistence, and formatting…" |
| `xai-grok-bundle` | "Checksum-tracked on-disk cache for the published subagent bundle (personas, roles, agents, skills)." |
| `xai-grok-memory` | Cross-session memory: index, embeddings, MMR, dream/consolidation, v2 storage. |
| `xai-grok-voice` | "Voice dictation (streaming STT) for Grok Build CLI." |
| `xai-grok-dashboard-store` | "SQLite-backed persistent dashboard workspace…" |
| `xai-grok-gboom` | "The /gboom easter-egg raycaster game for the grok CLI pager." |
| `xai-tracing` / `xai-tracing-macros` (common/codegen) | Shared tracing setup + timestamp/timing macros. |

### 3.11 `crates/common/*` (12 shared leaf crates)

`xai-circuit-breaker`, `xai-computer-hub-core`, `xai-computer-hub-mcp-adapter`, `xai-computer-hub-sdk`, `xai-grok-compaction`, `xai-interjection-core`, `xai-message-delivery-core`, `xai-test-utils`, `xai-tool-protocol`, `xai-tool-runtime`, `xai-tool-types`, `xai-tracing`. These are transport-agnostic primitives shared between the CLI and server-side code (e.g. `xai-grok-compaction` is "for Grok chat and Grok Build").

### 3.12 `crates/build/*` and `prod/*`

- `crates/build/xai-proto-build` — "Build protobuf" helper (used with `bin/protoc` DotSlash wrapper).
- `prod/mc/cli-chat-proxy-types` — the only `prod/` crate in this tree: lightweight wire types shared with the server-side cli-chat-proxy (`sandbox_types`, `client_metrics_types`, `feedback_types`, `subagent_bundle`, `team_managed_config_types`, `metadata_types`, `deployment_config_types`, `storage_types`, `session_types`).


A recurring architectural theme across the closure is **dependency inversion via small "seam" crates**: `xai-grok-config-types`, `xai-grok-auth`, `xai-status-line`, `xai-hooks-plugins-types`, and others exist specifically so that a consumer crate depends on a tiny trait/DTO crate instead of on the big implementation crate (stated explicitly in `xai-grok-config-types` and `xai-grok-auth` descriptions). Another theme is **deliberate crate splitting to parallelize compilation** (`xai-grok-shell-terminal`, `xai-grok-shell-base`, `xai-grok-shell-session-support` were all "extracted from xai-grok-shell so they compile in parallel").

---

## 4. Entry points

### 4.1 The shipping binary

[`grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs) (3,793 lines) is the single composition root. `fn main()` at `main.rs:2036`:

1. Sets version, marks process start, and dispatches **out-of-process helpers** first: `maybe_run_render_subprocess()` (Mermaid worker) and `maybe_run_capture_subprocess()` (voice) — these let the binary re-exec itself as a child worker (`main.rs:2039-2044`).
2. Parses CLI (`PagerArgs::parse_cli()`, `main.rs:2048`), handles early `--version` / `doctor` intents (`main.rs:2049`).
3. Installs `xai_grok_pager_minimal::install()` (the minimal-mode IoC hooks), jemalloc hooks, heap-profile hooks (`main.rs:2052-2063`).
4. Strips conflicting OTEL env, configures process env, starts memory trace, raises fd limit, validates managed requirements, inits Sentry + crash handler (`main.rs:2064-2108`).
5. Builds a **capped** multi-thread tokio runtime (`cli_worker_threads()`, default `min(cores, 8)` — `DEFAULT_MAX_WORKER_THREADS`, `main.rs:1788`, 2109-2116) and runs `async_main(args)` under `run_and_shutdown(..., RUNTIME_SHUTDOWN_GRACE=2s)` (`main.rs:2117`).

`async_main` (`main.rs:2133`) is the real dispatcher. It first handles `Completions` and `Wrap`, then decides interactivity and `set_client_name(GrokPager | Generic)` (`main.rs:2142-2150`), prewarms HTTP, pins the local resume target, resolves the startup **sandbox profile** (refusing a resume that would change a session's sandbox — `main.rs:2152-2164`), optionally heals managed policy, applies the sandbox (`xai_grok_shell::config::apply_sandbox`, `main.rs:2202`), then branches on `args.command` (`main.rs:2211-2427`) across: `Version`, `Agent` (→ `run_agent_command`), `Inspect`, `Setup`, `Mcp`, `Plugin`, `Models`, `Leader`, `Worktree`, `DiskUsage`, `Workspace`, `Sessions`, `Usage`, `Share`, `Export`, `Trace`, `Memory`, `Update`, `Login`, `Logout`, `Wrap`, `Completions`, `Dashboard`.

The CLI surface is defined in [`grok-build/crates/codegen/xai-grok-pager/src/app/cli.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/cli.rs):
- `enum Command` (`cli.rs:8-145`) — top-level subcommands listed above.
- `PagerArgs` (`cli.rs:416-771`) — the interactive/headless flags (`-p/--single`, `--prompt-json`, `--prompt-file`, `--output-format`, `--json-schema`, `-m/--model`, `--reasoning-effort`, `--permission-mode`, `--allow/--deny`, `--sandbox`, `-w/--worktree`, `-r/--resume`, `-c/--continue`, `--fork-session`, `--minimal`/`--fullscreen`, `--no-alt-screen`, `--max-turns`, …).
- `enum AgentCmd` (`cli.rs:330-339`) — `Stdio`, `Headless`, `Serve` (WebSocket server, default `127.0.0.1:2419`), `Leader`.

If no subcommand and no headless prompt, `async_main` ultimately calls `xai_grok_pager::app::run(args, bg_update_rx)` (`main.rs:2528`) — the interactive full-screen TUI — then flushes the sandbox and finishes any background update.

### 4.2 Agent-mode binary entry points (library `bin/` targets)

- [`grok-build/crates/codegen/xai-grok-shell/src/bin/chat-history-downgrade.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/bin/chat-history-downgrade.rs) — session-history downgrade utility.
- [`grok-build/crates/codegen/xai-grok-workspace/src/bin/workspace_server.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/bin/workspace_server.rs) — **standalone workspace ToolServer for remote sandboxes**; reads OIDC from `~/.grok/auth.json`, connects to the hub, exposes workspace tools, uses `xai_grok_diag_server` for `/ready` `/statusz` `/logs`, and `xai_grok_workspace_daemon::daemonize`. Also `workspace_server_probe.rs`.
- [`grok-build/crates/codegen/ptyctl-cli/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/ptyctl-cli/src/main.rs) — CLI for the headless PTY controller.

### 4.3 Auxiliary / test / bench binaries

- `xai-codebase-graph/src/bin/{code_graph.rs,bench_index.rs,bench_file_listing.rs}`
- `xai-fast-worktree/src/bin/{worktree_lifecycle_bench.rs,pool_perf_bench.rs,cli.rs}`
- `xai-grok-pager-pty-harness/src/bin/{pty_scenario.rs,scroll_matrix.rs,startup_tui_probe.rs,pty_orphan_holder.rs}`
- `xai-grok-voice/src/bin/voice_probe.rs`, `xai-grok-markdown/bin/{md_mermaid_test.rs,md_table_test.rs}`
- `xai-grok-pager/npm/grok/bin` (npm shim packaging).

### 4.4 The in-process agent runners

[`grok-build/crates/codegen/xai-grok-shell/src/agent/app.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/app.rs) is the shared runtime used by the pager binary and the leader: it exposes `run_leader`, `run_headless`, and the stdio path, defines `LeaderAutoUpdateConfig`, and owns the auto-update checker loop for long-running leaders (`app.rs:26-80`). `run_agent_command` in `main.rs:1227` wires the leader/stdio/headless/serve modes, including the **stdio↔leader ACP bridge with replay** (see §7).

---

## 5. Core subsystems (absolute file paths)

### 5.1 Agent definition & system-prompt assembly — `xai-grok-agent`
- [`grok-build/crates/codegen/xai-grok-agent/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/lib.rs) — module list + re-exports (`Agent`, `AgentBuilder`, `AgentDefinition`, `CompactionPolicy`, `ReminderPolicy`, presets `preset_names()`, `toolset_for_preset()`, `workspace_grok_build_toolset()`).
- [`grok-build/crates/codegen/xai-grok-agent/src/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/agent.rs) — the built `Agent` (definition + `PromptContext` + cached system prompt + `Arc<ToolBridge>` + policies + hosted tools). `should_auto_compact()` uses `xai_token_estimation::exceeds_threshold` (agent.rs:165-176).
- [`grok-build/crates/codegen/xai-grok-agent/src/builder.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/builder.rs), `config.rs` (`AgentDefinition`, `PermissionMode`, `CompletionRequirement`), `discovery.rs`, `repo.rs` (AGENTS.md), `system_reminder.rs` (`ReminderPolicy`), `compaction.rs`, `timing.rs`, and `prompt/` (context, template, user_message).

### 5.2 The agent/session run loop — `xai-grok-shell`
Each session is an **actor** with its own chat history and tool context (`session/acp_session.rs:1-12`).
- [`grok-build/crates/codegen/xai-grok-shell/src/agent/mvp_agent/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent) — the MVP ACP agent: `acp_agent.rs`, `agent_runtime.rs`, `session_lifecycle.rs`, `session_setup.rs`, `session_registry.rs`, `subagent_spawn.rs`, `turn_end.rs`, `replay.rs`, `sampler_prewarm.rs`, `code_nav.rs`.
- [`grok-build/crates/codegen/xai-grok-shell/src/agent/app.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/app.rs) — leader/headless/stdio runners (see §4.4).
- [`grok-build/crates/codegen/xai-grok-shell/src/agent/handlers/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/handlers) — `session.rs`, `models.rs`, `model_switch.rs`, `config_option.rs`, `workspaces.rs` (ACP request handlers).
- [`grok-build/crates/codegen/xai-grok-shell/src/agent/subagent/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/subagent) — `spawn.rs`, `child_runtime.rs`, `handle_request.rs`, `resume_window.rs`, `prompt_turn_receipt.rs`, `start_artifact_publication.rs`.
- [`grok-build/crates/codegen/xai-grok-shell/src/session/acp_session.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session.rs) — the `SessionActor` implementation (command/event channels).
- [`grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl) — **the turn machinery**, split into ~90 files: `run_loop.rs` (the main `run_session` loop), `turn.rs`, `turn_task.rs`, `sampler_turn.rs`, `tool_calls.rs`, `tool_dispatch.rs`, `prompt_build.rs`, `stop_gate.rs`, `turn_end.rs`, `turn_end_hooks.rs`, `cancel.rs`, `mcp.rs`, `mcp_init.rs`, `memory_*.rs`, `goal*.rs`, `side_call.rs`, `slash_exec.rs`, `status_line.rs`, `title_refresh.rs`, `updates.rs`, `workflow.rs`, `rewind.rs`, `rate_limit_waits.rs`, `auth_retry.rs`, `length_salvage.rs`, `laziness.rs`, `interjection.rs`, `parent_interject.rs`, `subagent_handoff.rs`.
- [`grok-build/crates/codegen/xai-grok-shell/src/session/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session) (top level) — `commands.rs`, `handle.rs`, `persistence.rs` (+ many focused `*_tests`), `compaction*.rs`, `goal_*.rs` (orchestrator/planner/tracker/stop-detector/strategist/summarizer), `prompt_queue.rs`, `plan_mode.rs`, `slash_commands.rs`, `signals.rs`, `worktree*.rs`, `usage_file.rs`, `summary.rs`, `two_pass.rs`.
- ``grok-build/crates/codegen/xai-grok-shell/src/session/workflow(s` (path not found in the pinned clone, not verified))/` — workflow engine wiring (Rhai via `xai-workflow`).

### 5.3 Tool system — `xai-grok-tools`
- [`grok-build/crates/codegen/xai-grok-tools/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/lib.rs) — crate root; output caps `DEFAULT_TOOL_OUTPUT_BYTES = 40_000`, `DEFAULT_TOOL_OUTPUT_CHARS = 20_000`; modules `bridge`, `computer`, `implementations`, `registry`, `types`, `util`, `sandbox_launch`, `tool_taxonomy`, `versions`.
- [`grok-build/crates/codegen/xai-grok-tools/src/registry/types.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/registry/types.rs) — `ToolRegistryBuilder`, `FinalizedToolset`, `SessionContext`, plus the **process-global tool-pack** seam `register_tool_pack()` that lets out-of-tree packs contribute registrations.
- [`grok-build/crates/codegen/xai-grok-tools/src/bridge.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/bridge.rs) — `ToolBridge`: adapts the `ToolRegistry` to a session, dispatches via `call_new_tool()`, manages definitions/enable/disable/name overrides, and translates results into model prompt text + ACP notifications.
- [`grok-build/crates/codegen/xai-grok-tools/src/implementations/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations) — all tool implementations (see §5.3.1).
- [`grok-build/crates/codegen/xai-grok-tools/src/computer/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/computer) — local task/terminal state, content search, file acceleration, task log.
- [`grok-build/crates/codegen/xai-grok-tools/src/types/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/types) — tool trait/definition/metadata/params validation/output/resources/schema/requirements.

#### 5.3.1 Built-in tools (name → implementing module)

Primary toolset ("NewTool" trait), under `crates/codegen/xai-grok-tools/src/implementations/grok_build/`. The module docstring (`implementations/grok_build/mod.rs:1-10`) states each sub-module implements `NewTool` and that `register_all()` wires the standard toolset. Tool ids are declared via `xai_tool_protocol::ToolId::new("…")`.

| Tool id (name sent to the model) | Implementing file | Notes |
|---|---|---|
| `run_terminal_cmd` | `grok_build/bash/mod.rs:1703` | shell execution (the "bash" tool) |
| `read_file` | `grok_build/read_file/mod.rs:760` | supports image/pdf/pptx variants (`read_file/{image,pdf,pptx}.rs`, `observation.rs`, versioned `versions/legacy_0_4_10.rs`) |
| `list_dir` | `grok_build/list_dir/mod.rs:503` | versioned `list_dir/versions/` |
| `grep` | `grok_build/grep/mod.rs:264` | ripgrep-backed (`grep/ripgrep.rs`, `rg_runner.rs`, `capped_output.rs`) |
| `search_replace` | `grok_build/search_replace/mod.rs` | versioned `search_replace/versions/` |
| `todo_write` | `grok_build/todo/mod.rs:279` | |
| `task` | `grok_build/task/mod.rs:323` | spawns subagents; `TASK_TOOL_NAME = "task"` (`task/mod.rs:40`); coordinator in `task/coordinator*`, quota/model-policy in `task/` |
| `send_subagent_message` | `grok_build/send_subagent_message.rs:222` | |
| `get_task_output` | `grok_build/task_output/mod.rs:885` | |
| `wait_tasks` | `grok_build/task_output/wait_tasks.rs:108` | |
| `get_terminal_command_output` | `grok_build/task_output/terminal_command.rs:64` | |
| `kill_task` | `grok_build/kill_task/mod.rs:156` | |
| `kill_terminal_command` | `grok_build/kill_task/terminal_command.rs:43` | |
| `enter_plan_mode` / `exit_plan_mode` | `grok_build/{enter_plan_mode,exit_plan_mode}/mod.rs:82` | plan mode |
| `ask_user_question` | `grok_build/ask_user_question/mod.rs:299` | structured questions to the client |
| `update_goal` | `grok_build/update_goal/mod.rs:214` | |
| `send_feedback` | `grok_build/send_feedback.rs:239` | |
| `web_search` | `grok_build/web_search/mod.rs:53` | |
| `web_fetch` | `grok_build/web_fetch/mod.rs:138` | SSRF guard (`web_fetch/ssrf.rs`), cache, overflow |
| `image_gen` | `grok_build/image_gen/mod.rs:423` | `IMAGINE_COMMAND_NAME` |
| `image_edit` | `grok_build/image_edit/mod.rs:285` | |
| `image_to_video` / `reference_to_video` | `grok_build/video_gen/mod.rs:1185,1293` | |
| `scheduler_create` / `scheduler_delete` / `scheduler_list` | `grok_build/scheduler/{create,delete,list}.rs` | recurring schedules + occurrence journal |
| `monitor` | `grok_build/monitor/tool.rs:52` | persistent monitors w/ rate limiter |
| `lsp` | `grok_build/lsp/mod.rs:60` | LSP operations |
| `workflow` | `grok_build/workflow/mod.rs:346` | runs Rhai workflows |
| `deploy_app` / `init_or_update_app` | `grok_build/{deploy_app_stub,init_or_update_app_stub}.rs` | stubs (`*_stub.rs`) |
| `memory_search` / `memory_get` | `memory/{search_tool,get_tool}.rs` (consts at `memory/mod.rs:15,18`) | |
| `search_tool` | `implementations/search_tool/mod.rs` | `SEARCH_TOOL_NAME = "search_tool"` (`implementations/mod.rs:14`) |
| `use_tool` | `implementations/use_tool/mod.rs` | `USE_TOOL_NAME = "use_tool"` (`implementations/mod.rs:15`) |
| `skill` | `implementations/skills/skill.rs` | default skill tool name `"Skill"` (`skills/mod.rs:42`) |

**Alternate/ported toolsets** (selected per mode/config; visible in `implementations/mod.rs` and `registry/types.rs:1-8`):
- `implementations/grok_build_hashline/` — a hashline-anchored editing variant: `hashline_read`, `hashline_grep`, `hashline_edit` (`ToolId::new("hashline_*")`), `read_file.rs`, `grep.rs`, `mutate.rs`, `anchor.rs`, `edit/`.
- `implementations/grok_build_concise/` — concise variants of `bash`, `read_file`, `search_replace`.
- `implementations/codex/` — **upstream openai/codex ports**: `apply_patch` (`apply_patch/{tool,parser,apply,seek_sequence}.rs`), `grep_files`, `list_dir`, `read_file` (`read_file/{slice,indentation,text_utils}.rs`).
- `implementations/opencode/` — **upstream sst/opencode ports**: `bash`, `edit`, `glob`, `grep`, `read`, `skill`, `todowrite`, `write`.

Stubs used in tests / non-streaming contexts: `streaming_stub`, `non_streaming_stub`, `no_terminal_stub`, `fake_mcp`, `unknown`, `text`.

Tool-feature gating is enforced by `ToolFeature` (e.g. `AskUserQuestion`, `ImageEdit`, `ImageGen`, `LspTools`, `VideoGen`, `WebFetch`, `WriteFile`) — see `implementations/tool_feature_names_tests.rs:6-33`.

### 5.4 Model / inference layer — `xai-grok-sampler`
- [`grok-build/crates/codegen/xai-grok-sampler/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/lib.rs) — crate root.
- [`grok-build/crates/codegen/xai-grok-sampler/src/actor/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/actor/mod.rs) — `SamplerActor`: single-threaded command actor; **each request streams in its own `tokio::spawn` task** so multiple requests run concurrently (`actor/mod.rs:1-2`, 33-47). Commands: `Submit`, `Cancel`, `UpdateConfig`, `IsActive`, `ActiveCount` (`actor/mod.rs:85-129`); it cleans up finished tasks via a `JoinSet<RequestId>`.
- [`grok-build/crates/codegen/xai-grok-sampler/src/stream/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/stream) — `chat_completions.rs`, `responses.rs`, `messages.rs`, `collect.rs` (the API shapes).
- `client.rs`, `config.rs`, `retry.rs`, `events.rs`, `handle.rs`, `commands.rs`, `metrics.rs`, `attribution.rs`, `doom_loop.rs` (+ recovery), `prewarm.rs`, `request_compression.rs`, `span_timing.rs`, `stream_classify.rs`, `shared_http/`.
- Wire types: [`grok-build/crates/codegen/xai-grok-sampling-types/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src).

### 5.5 Prompt / context
- [`grok-build/crates/codegen/xai-grok-agent/src/prompt/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/prompt) — `context.rs` (`PromptContext`, `RenderedPrompt`, `PromptAudience`), `template.rs` (`COMPACT_SYSTEM_PROMPT`), `user_message.rs` (`UserMessageTemplate`).
- AGENTS.md handling: `xai-grok-agent/src/repo.rs`, `types/agents_md_tracker.rs`, and `agents_md_section()` / `agents_md_user_reminder()` in `agent.rs:112-125`.
- [`grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_build.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_build.rs) — per-turn prompt assembly.

### 5.6 Session / state / persistence
- `xai-chat-state` (`crates/codegen/xai-chat-state`) — actor-based chat state; `CompactionMode`.
- [`grok-build/crates/codegen/xai-grok-shell/src/session/persistence.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs) (+ dozens of `persistence_*_tests.rs`) — session storage, resume resolution, sandbox-profile recovery.
- `xai-sqlite-journal` — WAL-vs-rollback choice by filesystem type.
- `xai-grok-session-search` — FTS5 BM25 session search; `xai-grok-dashboard-store` — SQLite dashboard workspace.
- `xai-grok-active-sessions` — open-TUI-session registry (JSON under grok home).

### 5.7 TUI — `xai-grok-pager` + `xai-grok-pager-render`
- [`grok-build/crates/codegen/xai-grok-pager/src/app/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app) — the app: `app_view.rs`, `agent_view/`, `event_loop.rs`, `mouse.rs`, `modals.rs`, `dispatch/`, `actions.rs`, `effects/`, `signal_handler.rs`, `terminal_restore.rs`, `screen_mode_relaunch.rs`, `status_line*.rs`, `workspace_*.rs`, `reader_thread.rs`, `session_startup.rs`.
- [`grok-build/crates/codegen/xai-grok-pager/src/views/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views) — ~150 files: `dashboard/`, `prompt_widget/`, `settings_modal/`, `block_viewer/`, overlays (btw, elicitation, permission, plan_approval, question), `scrollback`-related panes, `shortcuts_help.rs`, `timeline.rs`, `fps_hud.rs`, `scroll_debug_hud.rs`.
- [`grok-build/crates/codegen/xai-grok-pager/src/scrollback/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback) — `block.rs`, `blocks/`, `render.rs`, `scrollback_pane.rs`, `selection.rs`, `text_selection.rs`, `link_map.rs`, `sticky.rs`, `export.rs`.
- [`grok-build/crates/codegen/xai-grok-pager/src/slash/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash) — slash-command handling; `src/settings/`, `src/tips/`, `src/headless*`, `src/minimal/`, `src/acp/`.
- [`grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs) — **alt-screen policy** (`determine_alt_screen_policy`, `AltScreenMode`, `--no-alt-screen`, `[terminal] alt_screen`) at `terminal/mod.rs:936-1000`; plus `appearance/`, `render/` (`draw.rs`, `EscapeWriter`), `input/`, `syntax.rs`, `theme/`, `clipboard/`, `glyphs.rs`.
- Docs: [`grok-build/crates/codegen/xai-grok-pager/docs/user-guide/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide) — 27+ markdown chapters (getting-started … sandbox, plan-mode, dashboard, status-line, config-reference).

### 5.8 Config — `xai-grok-config`
- [`grok-build/crates/codegen/xai-grok-config/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-config/src/lib.rs) and siblings: `effective_config.rs` (requirements > user > managed), `config_layers.rs`, `config_override.rs`, `config_requirements.rs`, `loader.rs`, `validation.rs`, `endpoints.rs`, `remote_settings.rs`, `remote_fetch.rs`, `signed_policy.rs` (+ `signed_policy/`), `managed_cache/`, `managed_text/`, `macos_managed.rs`, `mcp_servers.rs`, `memory_v2.rs`, `global_hook_sources.rs`, `shell.rs`, `distribution.rs`, `paths.rs`.
- Runtime config in the shell: [`grok-build/crates/codegen/xai-grok-shell/src/agent/config.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/config.rs) (`Config as AgentConfig`, `PermissionMode`, `MemoryConfig`), `agent/config_model_override_parse.rs`, `src/config/{mod,reloader,watcher}.rs`.

### 5.9 Auth & login — `xai-grok-login` / `xai-grok-auth`
- [`grok-build/crates/codegen/xai-grok-login/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src) — `flow.rs`, `manager.rs` (+ `manager/lock`), `refresh/`, `oidc/`, `backend/`, `device_code.rs`, `auth_provider.rs`, `credential_provider.rs`, `storage.rs`, `jwt.rs`, `grok_auth_credentials.rs`, `pre_tui.rs`, `external_auth.rs`, `recovery.rs`, `side_call_bearer.rs`, `single_flight.rs`.
- [`grok-build/crates/codegen/xai-grok-auth/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-auth/src) — `auth_provider.rs`, `bearer_fragment.rs`, `retry_middleware.rs` (the DI seam).
- Shell-side glue: `xai-grok-shell/src/credential_factory.rs`, `src/agent/init.rs` (`run_cli_login`, `apply_post_login_config`, `run_cli_logout`).

### 5.10 Permissions — `xai-grok-permission-rules`
- [`grok-build/crates/codegen/xai-grok-permission-rules/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-permission-rules/src/lib.rs) + `rules.rs`, `resolution.rs`, `policy.rs`, `policy/`, `managed_policy/`, `bash_permission_script.rs`, `bash_command_splitting.rs`, `exec_risk.rs`, `env_risk.rs`, `folder_trust.rs`, `project_config.rs`, `trust.rs`, `reasons.rs`, `domain.rs`, `shell_access.rs`, `git_content_filters.rs`, `worktree.rs`.
- Session-side integration: `xai-grok-shell/src/session/acp_session_impl/tool_dispatch.rs`, `stop_gate.rs`, and `xai-grok-workspace/src/permission/`.

### 5.11 Sandboxing — `xai-grok-sandbox`
- [`grok-build/crates/codegen/xai-grok-sandbox/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/lib.rs) — `SandboxManager`, `ProfileName`, applied **once at process startup**; covers in-process `tokio::fs` and child processes; network left open at process level, child network blocked per-subprocess via seccomp (`lib.rs:8-24`). `enforce` feature (default) pulls `nono` (`nono = "=0.53.0"`, Cargo.toml:44).
- `profiles.rs` (`ProfileName`, `SandboxConfig`, `SandboxProfile`, `load_sandbox_config`), `network_policy.rs` (WebsitePolicy/Origin), `command/` (+ `backend`, `policy`, `violation`), `child_net.rs`, `deny/`, `hook_write_deny.rs`, `read_deny_verify.rs`, `runtime_sockets.rs`, `allow_path.rs`, `paths.rs`, `logging.rs`.
- Applied at startup from `xai-grok-pager-bin/src/main.rs:2202` (`xai_grok_shell::config::apply_sandbox`).

### 5.12 MCP — `xai-grok-mcp`
- [`grok-build/crates/codegen/xai-grok-mcp/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/lib.rs) + `servers.rs`, `owned_clients.rs`, `shared_mcp_state.rs`, `acp_transport.rs`, `credentials.rs`, `oauth.rs`, `oauth_config.rs`, `auth_status.rs`, `bearer_token_file.rs`, `call_result.rs`, `elicitation.rs`, `liveness.rs`, `mcp_http_client.rs`, `tool_name.rs`, `wire.rs`, `generation.rs`. (Hermetic reason: quarantines `rmcp` + reqwest 0.13 vs workspace reqwest 0.12 — `Cargo.toml` description.)
- Session-side wiring: `xai-grok-shell/src/session/mcp_servers.rs`, `mcp_dispatcher.rs`, `mcp_restart.rs`, `managed_mcp.rs`, and `session/acp_session_impl/{mcp,mcp_init,mcp_snapshot,mcp_argument_coercion,mcp_file_input}.rs`; doctor at `xai-grok-shell/src/mcp_doctor.rs` and `xai-grok-pager/src/mcp_cmd.rs`.

### 5.13 ACP — `xai-acp-lib`
- [`grok-build/crates/codegen/xai-acp-lib/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/lib.rs) — channels (`AcpAgentChannel`/`AcpClientChannel`), gateway (`acp_gateway`), typed messages (`AcpAgentMessage`, `AcpClientMessage`, `AcpMethod`, `AcpRequest`, `AcpSide`), and stdin/line readers (`spawn_stdin_line_reader`).
- The concrete ACP agent loop lives in `xai-grok-shell/src/agent/mvp_agent/` and `session/acp_session*.rs`; the extended method surface is the `x.ai/*` / `_x.ai/*` namespace under `xai-grok-shell/src/extensions/` (see §7.6).

### 5.14 LSP
- Tool: [`grok-build/crates/codegen/xai-grok-tools/src/implementations/lsp/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/lsp) — `manager.rs`, `client.rs`, `capabilities.rs`, `diagnostics.rs`, `documents.rs`, `format.rs`, `pull.rs`, `refresh.rs`, `restart.rs`, `watched_files.rs`, `workspace_open.rs`.
- Also `implementations/grok_build/lsp/mod.rs` (the tool) and `xai-grok-shell/src/agent/mvp_agent/code_nav.rs`.

### 5.15 Telemetry — `xai-grok-otel` (+ `xai-grok-telemetry`)
- [`grok-build/crates/codegen/xai-grok-otel/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-otel/src/lib.rs) — `config`, `otlp`, `provider`, `redact_common`, `timeout`, `trace_context` (W3C propagation).
- [`grok-build/crates/codegen/xai-grok-telemetry/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-telemetry/src) — product events, Mixpanel, Sentry, unified log, sampling log, span profile, debug-log firehose (wired in `main.rs:239-263`).
- `xai-mixpanel` and `xai-grok-secrets` (outbound scrubbing).

### 5.16 Memory
- [`grok-build/crates/codegen/xai-grok-memory/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src) — `index.rs`, `embedding.rs`, `search.rs`, `mmr.rs`, `chunk.rs`(er), `flush.rs`, `dream.rs` + `batch_dream*.rs` (consolidation), `storage.rs`/`storage_v2.rs`, `schema.rs`, `query_expansion.rs`, `watcher.rs`, `v2*.rs`.
- Session-side: `xai-grok-shell/src/session/{memory_state,memory_observation,memory_carryover,batch_memory_dream}.rs`, `session/acp_session_impl/memory_*.rs`; CLI at `xai-grok-pager/src/memory_cmd.rs`.

### 5.17 Web search / fetch
- [`grok-build/crates/codegen/xai-grok-tools/src/implementations/web_search/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/web_search) — `client.rs`, `tool.rs`, `types.rs`.
- [`grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/web_fetch/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build/web_fetch) — `client.rs`, `ssrf.rs`, `cache.rs`, `artifact.rs`, `overflow.rs`, `domain.rs`, `http.rs`, `config.rs`.

### 5.18 Plugins / marketplace / hooks
- [`grok-build/crates/codegen/xai-grok-plugin-marketplace/src/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-plugin-marketplace/src) — `catalog.rs`, `index.rs`, `git.rs`, `installer.rs`, `install_resolve.rs`, `matcher.rs`, `scanner.rs`, `types.rs`, `config.rs`.
- Shell: `xai-grok-shell/src/plugin/{acquire,mod,sources}.rs`, `src/extensions/{plugins,marketplace,hooks}.rs`; CLI `xai-grok-pager/src/plugin_cmd.rs`.
- Hooks: `xai-grok-hooks/src/{discovery,dispatcher,runner,matcher,event,result,trust,env_expand,config}.rs`; session-side `xai-grok-shell/src/session/acp_session_impl/{hook_dispatch,turn_end_hooks,hooks_plugins}.rs`.


### 5.19 Workspace / Computer Hub / remote sandbox
- [`grok-build/crates/codegen/xai-grok-workspace/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/lib.rs) — core host-local workspace library: FS, VCS, permissions, tool config, and subsystem wiring. Modules: `file_system/`, `worktree/`, `sandbox/`, `session/`, `hub*.rs` (`hub.rs`, `hub_server.rs`, `hub_channel.rs`, `hub_auth/`, `hub_ids.rs`), `permission/`, `mcp.rs`, `mcp_claim.rs`, `plugins.rs`, `discovery.rs`, `folder_trust.rs`, `path_virtualization.rs`, `host_kind.rs`, `git_odb.rs`, `restore_fetch.rs`, `export_github.rs`, `publish.rs`, `recovery.rs`, `envrc.rs`, `bind_env.rs`, `hooks` (`hook_inputs.rs`, `global_hook_sources` on the config side).
- `xai-grok-workspace-types`, `xai-grok-workspace-client`, `xai-grok-workspace-daemon` — the wire types, the hub-proxied RPC client, and the daemonization/pidfile/preview-proxy supervisor.
- `xai-computer-hub-core` (`crates/common`) — `Transport`, `ToolRegistry` trait, `CompoundResolver` (local-shadows-remote), `LocalTransport`, `RemoteTransport`, and `bot_tools.rs` (grok-bot tool catalog). `xai-computer-hub-sdk` — connection pool, transparent reconnect, tool harness/tool-server runtime. `xai-computer-hub-mcp-adapter` — registers MCP tools as native hub tools.
- `xai-tool-protocol` — the Computer Hub wire protocol: ids, registration, capabilities, hook events, handshake, JSON-RPC envelope, method catalog, `ToolErrorWire`/`ToolOutputWire`/`WireToolNotification`, bot-relay frames, `methods`, `session_event`, `turn_hook`.

### 5.20 Other notable subsystems
- **Voice**: `xai-grok-voice/src/{pipeline,transcriber,stt/,audio/,clip.rs,wav.rs,probe.rs,language.rs}` — streaming STT dictation; a re-exec'd capture subprocess (`main.rs:2042`).
- **Mermaid**: `xai-grok-mermaid` renders untrusted model output in a short-lived child (`mermaid_worker`), with `catch_unwind` + `render_checked` (`xai-grok-mermaid/src/lib.rs:12-20`).
- **Easter egg**: `xai-grok-gboom` — `/gboom` raycaster game (re-exported as `xai_grok_pager::gboom`).
- **Crash handling**: `xai-crash-handler` — Unix signals + Windows SEH, startup crash detection (`main.rs:2089-2108`).
- **Update**: `xai-grok-update` — channels (alpha/stable/enterprise), version policy, managed-install detection, leader relaunch signalling (`main.rs:2749-2809`).

---

## 6. Request lifecycle (end-to-end)

### 6.1 Startup (interactive `grok`)
1. **`main()`** (`xai-grok-pager-bin/src/main.rs:2036`): version/intent checks, install minimal + jemalloc + crash hooks, `configure_process_env`, `raise_fd_limit`, validate managed requirements, init Sentry/crash handler, build capped tokio runtime (`worker_threads = min(cores,8)`), run `async_main` under a 2 s shutdown grace.
2. **`async_main`** (`main.rs:2133`): pick client type; **pin the local resume target before the sandbox** (`pin_local_resume_target()`); resolve/refuse sandbox profile for resumes; heal managed policy; `apply_sandbox` (`main.rs:2202`).
3. **Interactive path**: `xai_grok_pager::app::run(args, bg_update_rx)` (`main.rs:2528`) → [`grok-build/crates/codegen/xai-grok-pager/src/app/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/mod.rs) → `event_loop.rs` + `app_view.rs`. The event loop enters raw mode; for fullscreen it emits `EnterAlternateScreen` and `EnableMouseCapture` (see §7.1).
4. The pager opens an **ACP connection** to the agent runtime — either in-process or (leader mode) to a shared leader over a Unix socket — and calls `initialize`, then `session/new` or `session/load` (`xai-grok-pager/src/acp/`, `app/session_startup.rs`).

### 6.2 Prompt → turn → tools → response (headless-equivalent, same core)
1. **Prompt ingestion** — the pager sends `session/prompt` (interactive) or the headless path builds a `HeadlessPrompt` (`xai-grok-pager/src/headless.rs`) and calls `run_single_turn` (`main.rs:2465`).
2. **Session actor** receives the prompt as a `SessionCommand` (`xai-grok-shell/src/session/commands.rs`) and runs the main loop `run_session` (`session/acp_session_impl/run_loop.rs`).
3. **Prompt build** — `prompt_build.rs` assembles conversation + system prompt (`xai-grok-agent` `PromptContext::render`, `agent.rs:190-195`); slash-command / skill parsing via `session/prompt_parser.rs` + `session/slash_commands.rs`.
4. **Sampling** — the session builds a `ConversationRequest` and submits it to the **`SamplerActor`** (`xai-grok-sampler/src/actor/mod.rs:85-116`), which spawns a per-request streaming task (`request_task.rs`, `stream/`). Events flow back as `SamplingEvent`s.
5. **Tool calls** — streamed tool-call deltas are dispatched in `session/acp_session_impl/tool_calls.rs` → `tool_dispatch.rs`, which routes through `ToolBridge::call_new_tool()` (`xai-grok-tools/src/bridge.rs`) into the `ToolRegistry`. Permission checks go through `xai-grok-permission-rules` and the stop gate; bash/terminal tool calls may run inside the OS sandbox.
6. **Observability** — the turn emits `session/update` notifications (`xai-grok-shell/src/extensions/notification.rs`, `session/updates.rs`), writes the per-session JSONL event log (`xai-grok-session-events`), and OTLP spans (`xai-grok-otel`) / product events (`xai-grok-telemetry`).
7. **Turn end** — `turn_end.rs`, `turn_end_hooks.rs`, `stop_gate.rs`, then persistence via `session/persistence.rs` (SQLite/JSON under the grok home). Compaction (`session/compaction*.rs`, `xai-grok-compaction`) may fire when `should_auto_compact()` is true.

### 6.3 Embedded / leader lifecycle
- `grok agent stdio` bridges an IDE client's ACP JSON-RPC over stdio to a leader (or runs in-process). The bridge caches `initialize` + every `session/load`/`session/new` and **replays** them on reconnect (see §7.2).
- `grok agent leader` runs as a long-lived shared backend (`agent/app.rs` `run_leader`), with flock-based single-instance guarding, an IPC server, optional grok.com relay, and a periodic auto-update checker that can relaunch onto a new binary (`main.rs:1621-1685`).

---

## 7. Notable / unique design choices

### 7.1 Fullscreen, mouse-interactive TUI (a first-class design choice)
The TUI is not a thin readline wrapper; it is a full ratatui application with an **alternate-screen mode** (`EnterAlternateScreen`) with an inline fallback, driven by an explicit policy:
- Render entry: `grok-build/crates/codegen/xai-grok-pager/src/app/mod.rs:98` (path not found in the pinned clone, not verified) imports `crossterm::terminal::{EnterAlternateScreen, Clear, ...}`.
- The app tracks whether mouse capture is active: `app/mod.rs:140` — "Tracks whether mouse capture (the five DEC modes enabled by crossterm `EnableMouseCapture`, plus bracketed paste) is currently active." (global `MOUSE_CAPTURE_ENABLED`).
- Alt-screen policy: `grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs:936-1000` (path not found in the pinned clone, not verified) `determine_alt_screen_policy(cli_no_alt_screen, mode, ctx, control)`, with `AltScreenMode = Auto | Always | Never` (config `[terminal] alt_screen`, `appearance/config.rs:35,647`). `Auto` consults the terminal control/context.
- Screen-mode flags: `--minimal` (scrollback-native) and `--fullscreen` are **mutually exclusive** (`app/cli.rs:735-744`, test `cli.rs:1161-1168`). `--no-alt-screen` disables the alternate screen (`cli.rs:734`).
- Enter/leave alt screen is done with explicit crossterm `execute!` calls around the run, and mouse capture is **conditionally** toggled (`event_loop.rs:445-471`):
  ```rust
  if mouse_captured { let _ = crossterm::execute!(stderr, crossterm::event::DisableMouseCapture); }
  ...
  if screen_mode.is_fullscreen() {
      let _ = crossterm::execute!(stderr, crossterm::terminal::EnterAlternateScreen);
  }
  ...
  if mouse_captured { let _ = crossterm::execute!(stderr, crossterm::event::EnableMouseCapture); }
  ```
- **Mouse** is deeply integrated: `grok-build/crates/codegen/xai-grok-pager/src/app/mouse.rs:1-6` (path not found in the pinned clone, not verified) — "Mouse input handling for `AgentView`: the `handle_mouse` event handler and the scrollbar click helper. `handle_mouse` covers click-to-focus, hit-testing of cached click rects, and per-pane click dispatch." Hit-tests use rects cached from the last rendered frame (mouse.rs:4-5).
- There is a **mouse-capture re-assertion on refocus** because ConPTY-backed relays can strip DEC private modes: `reassert_mouse_capture_on_focus()` (`event_loop.rs:658-663`, comment: "downloading SGR mouse reports to X10 … corrupts into typed characters").
- Fullscreen↔minimal switching relaunches the process (`app/screen_mode_relaunch.rs`), and terminal state is restored on panic/signal (`app/terminal_restore.rs`, `xai_crash_handler::install_terminal_restore_only()` at `main.rs:2089`).

The `xai-ratatui-inline` and `xai-grok-pager-minimal` crates exist purely to support the inline (scrollback-native) rendering mode as an alternative to fullscreen, wired in through a function-pointer IoC seam (`xai-grok-pager-bin/Cargo.toml` explains the cargo-cycle that forces the composition root to install the hooks).

### 7.2 Leader/stdio architecture with ACP **replay**
Multiple clients can share one backend: `grok agent leader` runs a shared process; clients connect over a Unix socket. The stdio bridge caches ACP state and replays it after a leader crash so IDE clients don't get "unknown session id" (`main.rs:842-1171`):
- `StdioReplayState` tracks every open session (`main.rs:846-877`). `cache_outgoing_acp_state()` records `initialize`/`session/load`/`session/new`/`session/resume`/`session/close` (`main.rs:905-978`).
- On reconnect, `replay_acp_state_after_reconnect()` replays `initialize` then each cached `session/load`, **swallowing only the responses to the replayed requests** while forwarding notifications, then emits `x.ai/leader_reconnected` (`main.rs:1114-1172`, and the huge test module `main.rs:2810-3792`).
- This is a genuinely unusual reliability design: a JSON-RPC-level state checkpoint carried in the client bridge.

### 7.3 Agent-as-actor, sampler-as-concurrent-actor
`SessionActor` (per session) and `SamplerActor` (inference) are both message-passing actors. The sampler's docstring (`actor/mod.rs:1-2`) is explicit: "The actor task itself is single-threaded … The actual streaming work happens in `tokio::spawn` per-request tasks, so multiple requests can be in flight concurrently."

### 7.4 Tool registry with an out-of-tree tool-pack seam
`register_tool_pack()` (`xai-grok-tools/src/registry/types.rs:30-37`) lets harness code that lives outside the crate contribute tool registrations without `xai-grok-tools` depending on it — an inversion of the usual plugin direction.

### 7.5 Upstream tool **ports** (codex + opencode)
The repo ships in-tree ports of two other agents' tools, with a crate-local third-party notice: [`grok-build/crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md) (license texts + Apache §4(b) change notice) and root `THIRD-PARTY-NOTICES` (README.md:134-139). These are `implementations/codex/` (apply_patch, grep_files, list_dir, read_file) and `implementations/opencode/` (bash, edit, glob, grep, read, skill, todowrite, write).

### 7.6 Large ACP extension namespace (`x.ai/*` / `_x.ai/*`)
Beyond standard ACP, the agent exposes a big vendor extension surface implemented under `xai-grok-shell/src/extensions/`: auth (`x.ai/auth/*`, `x.ai/getBearerToken`, `x.ai/setApiKey`), git (`x.ai/git/*`, worktrees), fs (`x.ai/fs/*`), mcp (`x.ai/mcp/*`), memory (`x.ai/memory/*`), skills, plugins, marketplace, hooks, hunk-tracker, subagent (`x.ai/subagent/*`), task, terminal (`x.ai/terminal/*`, including PTY create/load/resize), sessions (`x.ai/session/*`, fork/rename/search/repair), code-nav (`x.ai/code/find-definitions`, `find-references`), search (`x.ai/search/*`), feedback, billing, privacy, rewind, debug, and more.

### 7.7 Sandbox applied in-process + seccomp for children
`xai-grok-sandbox` applies Landlock/Seatbelt (via `nono`) **once at process startup**, covering in-process `tokio::fs` calls, while child processes get network blocked per-subprocess via seccomp (`sandbox/src/lib.rs:8-24`). A `hook_write_deny`/`read_deny_verify` verification layer fails closed when the profile requires it (`lib.rs:49-60`).

### 7.8 Managed policy / signed config
`xai-grok-config/src/signed_policy.rs` + `managed_cache/` + `managed_text/` implement a signed, cached managed configuration (`xai-grok-cloud-config`), with a pre-sandbox "policy heal" (`main.rs:2178-2200`) and a startup `validate_requirements()` gate (`main.rs:2073-2081`).

### 7.9 Hardened distribution profile
`[profile.release-dist]` (thin LTO, codegen-units=1, `debug=1`, `strip=false`) intentionally keeps symbols so CI can extract `.debug` sidecars / `.dSYM` bundles before stripping (Cargo.toml:406-421). Binary hardening also uses compile-time string/control-flow obfuscation (`obfstr`, `cryptify`) in `xai-grok-pager-bin/Cargo.toml:52-54` and `main.rs:2591-2599`.

### 7.10 Mermaid rendering is out-of-process
Because shipped profiles build with `panic = "abort"` (Cargo.toml:404), `catch_unwind` cannot contain a panicking engine; crash isolation is achieved by rendering each diagram in a short-lived child process with a wall-clock timeout (`xai-grok-mermaid/src/lib.rs:12-20`).

### 7.11 Many small dependency-inversion seam crates: `xai-grok-config-types`, `xai-grok-auth`, `xai-grok-status-line`, `xai-hooks-plugins-types`, `xai-grok-sampling-types`, `xai-grok-shell-base` — plus explicit “compile in parallel” crate splitting (`xai-grok-shell-terminal`).

---

## 8. Features UNIQUE-to-this-agent vs COMMON

### Unique / distinctive
- **Full-screen TUI with deep mouse interactivity** as the default surface (click-to-focus panes, scrollbars, drag-select, double-click text selection, mouse capture that survives ConPTY relays). Many coding agents are primarily CLI/print-mode; here the TUI is the product (`xai-grok-pager`, `xai-grok-pager-render`).
- **Inline “minimal” scrollback-native mode** as a first-class alternate render path (`xai-grok-pager-minimal`, `xai-ratatui-inline`), switchable at runtime via process relaunch.
- **Shared leader process with ACP state replay** — multi-client backend plus a client-side JSON-RPC checkpoint that restores all IDE sessions after a leader crash (`main.rs` replay machinery; `agent leader` mode).
- **In-process OS sandbox via `nono` (Landlock/Seatbelt) applied at startup**, with per-child seccomp network blocking and a hook-write/read-deny verification layer (`xai-grok-sandbox`). Agents usually shell out to an external sandbox; here it's kernel-enforced in-process.
- **Computer Hub / workspace exposure** — the CLI can expose its workspace to a “Computer Hub” via the leader, with `hub_server`/`hub_channel`/`hub_auth` and a standalone `workspace_server` binary for remote sandboxes (`xai-grok-workspace*`, `xai-computer-hub-*`).
- **In-tree ports of codex and opencode tools** with proper Apache §4(b) change notices (`implementations/codex`, `implementations/opencode`).
- **Hashline-anchored editing** variant (`grok_build_hashline`: `hashline_read`/`hashline_grep`/`hashline_edit`).
- **Rhai-scripted workflow engine** that orchestrates agents through a host channel (`xai-workflow`, `workflow` tool).
- **Batch “dream” memory consolidation** with a scheduler and lock (`xai-grok-memory/batch_dream*`, `dream*.rs`).
- **Recurring scheduler tools** with an occurrence journal (`grok_build/scheduler/*`).
- **A raycast easter-egg game** built into the TUI (`xai-grok-gboom`, `/gboom`).
- **Voice dictation (streaming STT)** with a re-exec'd capture subprocess (`xai-grok-voice`).
- **Mermaid rendering built from vendored Rust sources** (no Node/headless browser), executed in a child process for crash isolation (`xai-grok-mermaid` + `third_party/`).
- **Signed, cached managed policy** with pre-sandbox policy healing (`xai-grok-config/signed_policy`, `xai-grok-cloud-config`).
- **Claude settings import** (`xai-grok-external-agent-migration`) and vendored foreign-session discovery (`xai-grok-foreign-sessions`).
- **Vendor CLI conveniences** that are uncommon in agents: `grok wrap <cmd>` (local PTY that forwards OSC 52 clipboard for containers/SSH), `grok du` (grok-home disk usage), `grok doctor` (terminal/clipboard/color diagnostics with fixes).
- **Opsec/policy discipline encoded in clippy** (banned `canonicalize`, `reqwest`, `home_dir`, raw spawn) with rationale comments (`clippy.toml`).

### Common (industry-standard) building blocks
- Chat-completions / Responses / Messages client shapes with SSE streaming and retry (`xai-grok-sampler`, `stream/`).
- Tool-call loop, todo lists, subagents (`task` tool), plan mode (`enter_plan_mode`/`exit_plan_mode`), web search/fetch, file read/edit/grep glob, terminal/bash, LSP integration.
- MCP client support (transport, OAuth, elicitation) (`xai-grok-mcp`).
- OAuth/device-code login, token refresh, credential storage (`xai-grok-login`).
- ACP over stdio for editors (`xai-acp-lib`); headless single-turn + JSON output; session persistence/resume.
- OpenTelemetry tracing/OTLP, product analytics (Mixpanel), Sentry, self-update (`xai-grok-otel`, `xai-grok-telemetry`, `xai-grok-update`).
- Config layering (requirements > user > managed), AGENTS.md project rules, hooks, plugins/skills, slash commands, git worktree isolation.

---

## 9. Most important absolute file paths

Composition root / CLI
- [`grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs) (3,793 lines — everything) & `.../src/agent_command.rs`
- [`grok-build/crates/codegen/xai-grok-pager/src/app/cli.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/cli.rs) (CLI surface) & `.../src/app/mod.rs`, `.../src/app/event_loop.rs`, `.../src/app/app_view.rs`, `.../src/app/mouse.rs`
- [`grok-build/crates/codegen/xai-grok-pager/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/lib.rs)

Workspace root & policy
- [`grok-build/Cargo.toml`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/Cargo.toml), [`grok-build/clippy.toml`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/clippy.toml), [`grok-build/rust-toolchain.toml`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/rust-toolchain.toml), [`grok-build/SOURCE_REV`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/SOURCE_REV)

Agent / session runtime
- [`grok-build/crates/codegen/xai-grok-shell/src/agent/app.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/app.rs) (leader/headless runners)
- [`grok-build/crates/codegen/xai-grok-shell/src/session/acp_session.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session.rs) (SessionActor)
- [`grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs) (turn loop) + `sampler_turn.rs`, `tool_calls.rs`, `tool_dispatch.rs`, `prompt_build.rs`, `turn_end.rs`, `compaction.rs`
- ``grok-build/crates/codegen/xai-grok-shell/src/agent/mvp_agent/{acp_agent.rs` (path not found in the pinned clone, not verified),session_lifecycle.rs,replay.rs}`
- ``grok-build/crates/codegen/xai-grok-agent/src/{agent.rs` (path not found in the pinned clone, not verified),builder.rs,config.rs}` and `.../src/prompt/context.rs`

Tools
- [`grok-build/crates/codegen/xai-grok-tools/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/lib.rs), `.../src/bridge.rs`, `.../src/registry/types.rs`
- [`grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build/mod.rs) (tool set + `register_all`) and `.../implementations/mod.rs`
- [`grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs), `.../read_file/mod.rs`, `.../grep/mod.rs`, `.../task/mod.rs`, `.../search_replace/mod.rs`

Model / inference
- [`grok-build/crates/codegen/xai-grok-sampler/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampler/src/lib.rs) and `.../src/actor/mod.rs`, `.../src/stream/`
- [`grok-build/crates/codegen/xai-grok-sampling-types/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src/lib.rs)

TUI rendering
- [`grok-build/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/terminal/mod.rs) (alt-screen policy), `.../src/render/draw.rs`, `.../src/appearance/config.rs`
- ``grok-build/crates/codegen/xai-grok-pager/src/scrollback/{scrollback_pane.rs` (path not found in the pinned clone, not verified),render.rs,block.rs}`

Config / auth / security
- ``grok-build/crates/codegen/xai-grok-config/src/{lib.rs` (path not found in the pinned clone, not verified),effective_config.rs,signed_policy.rs,remote_settings.rs}`
- ``grok-build/crates/codegen/xai-grok-login/src/{lib.rs` (path not found in the pinned clone, not verified),flow.rs,manager.rs}` and `grok-build/crates/codegen/xai-grok-login/docs/user-guide` (path not found in the pinned clone, not verified) equivalents
- [`grok-build/crates/codegen/xai-grok-permission-rules/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-permission-rules/src/lib.rs)
- [`grok-build/crates/codegen/xai-grok-sandbox/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/lib.rs)

Integrations
- [`grok-build/crates/codegen/xai-grok-mcp/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/lib.rs)
- [`grok-build/crates/codegen/xai-acp-lib/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/lib.rs)
- [`grok-build/crates/codegen/xai-grok-shell/src/extensions/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/mod.rs) (x.ai/* method surface)
- [`grok-build/crates/codegen/xai-grok-workspace/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-workspace/src/lib.rs) and `.../src/bin/workspace_server.rs`

Telemetry / docs
- [`grok-build/crates/codegen/xai-grok-otel/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-otel/src/lib.rs), [`grok-build/crates/codegen/xai-grok-telemetry/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-telemetry/src/lib.rs)
- [`grok-build/crates/codegen/xai-grok-pager/docs/user-guide/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide) (01-getting-started.md … 27-grok-clone.md)
- [`grok-build/README.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md)

---

*End of report. Read-only tour; no repository file was modified.*
