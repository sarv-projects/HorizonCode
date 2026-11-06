# Repository Deep-Dive: can1357/oh-my-pi (product name `omp`)

> "Coding agent with the IDE wired in. Built by Stencil Labs."

Read-only research report. All paths are absolute under /data/home/forge/repo-tour/oh-my-pi. Nothing was modified during this tour.

---

## 1. Identity

| Field | Value | Source |
|---|---|---|
| Product / CLI name | `omp` | file:///data/home/forge/repo-tour/oh-my-pi/package.json#L2 |
| Tagline | "A coding agent with the IDE wired in." | file:///data/home/forge/repo-tour/oh-my-pi/README.md#L6 |
| Author / org | Stencil Labs, Inc. (stencil.so); upstream fork of Pi by Mario Zechner | file:///data/home/forge/repo-tour/oh-my-pi/package.json#L5-L6 |
| Homepage | https://omp.sh | file:///data/home/forge/repo-tour/oh-my-pi/package.json#L4 |
| License | MIT (vendored/third-party code keeps its own license) | file:///data/home/forge/repo-tour/oh-my-pi/LICENSE |
| Workspace version | `18.17.0` (matches Cargo workspace version) | file:///data/home/forge/repo-tour/oh-my-pi/Cargo.toml#L27 |
| Primary language | TypeScript on Bun `>= 1.4.4`; also Rust (`crates/`), Python, Go/Rust SDKs, Bazel | file:///data/home/forge/repo-tour/oh-my-pi/README.md#L31, file:///data/home/forge/repo-tour/oh-my-pi/README.md#L458-L474 |
| Scale claims | 60+ providers, 31 built-in tools, 14 LSP ops, 28 DAP ops, ~80k LoC Rust | file:///data/home/forge/repo-tour/oh-my-pi/README.md#L31 |
| License-audit config | `cargo-about` accepted-license list | file:///data/home/forge/repo-tour/oh-my-pi/about.toml |

The repo is self-hosting: its own agent config (commands, skills, tools, tests) lives under file:///data/home/forge/repo-tour/oh-my-pi/.omp.

```json
// package.json (root, abridged)
{ "name": "omp", "private": true, "version": "18.17.0", "workspaces": ["packages/*", "python/robomp/web"] }
```
Source: file:///data/home/forge/repo-tour/oh-my-pi/package.json#L2-L8

---

## 2. Top-level map

```text
/data/home/forge/repo-tour/oh-my-pi
|-- assets/           hero + doc images (webp/png/svg)
|-- bazel/            hermetic native-addon cross-build
|-- crates/           Rust workspace (13 first-party + 4 vendored crates)
|-- docs/             authoritative subsystem docs (77 files + tools/ + skills/)
|-- infra/            vmon CI-runner docs + omp_ci_template.py
|-- nix/              flake packaging (package.nix, home-manager, nixos-module, bun.nix)
|-- packages/         17 Bun-workspace TypeScript packages (the app surface)
|-- patches/          bun patchedDependencies (@ark/schema, puppeteer-core)
|-- python/robomp/    GitHub triage/fix bot driving `omp --mode rpc` (+ web dashboard)
|-- sdk/              out-of-process RPC clients: Go, Python, Rust
|-- scripts/          build/release/CI/test tooling (TS + Python)
|-- types/assets/     ambient *.webp asset-module typings
|-- .omp/             this repo's own agent config (commands, skills, tools, tests)
|-- BUILD.bazel / MODULE.bazel / .bazelrc / .bazelversion
|-- Cargo.toml / Cargo.lock / rust-toolchain.toml / rustfmt.toml / deny.toml / about.toml
|-- package.json / bun.lock / bunfig.toml
|-- tsconfig.base.json / tsconfig.json / tsconfig.tools.json
|-- Dockerfile / Dockerfile.robomp / flake.nix
\-- README.md / README.zh-CN.md / AGENTS.md / CONTRIBUTING.md
```

Notes:
- `tsconfig.base.json` targets `ES2024`, `moduleDetection: force`, `verbatimModuleSyntax`, `types: ["bun","assets"]`. Source: file:///data/home/forge/repo-tour/oh-my-pi/tsconfig.base.json#L2-L20.
- Bun workspaces glob `packages/*` plus `python/robomp/web`. Patched deps under `patches/`: `@ark/schema@0.56.2`, `puppeteer-core@25.3.0`.
- Bazel builds only the native side: `//:natives-<target>` yields canonically named `.node` addons, one per (platform, arch, ISA-variant). Source: file:///data/home/forge/repo-tour/oh-my-pi/BUILD.bazel#L16-L36. The cargo workspace stays authoritative for local iteration; Bazel is the artifact/CI pipeline.
- `infra/` documents the vmon CI runners (file:///data/home/forge/repo-tour/oh-my-pi/infra/docs/01-vmon-runners.md, file:///data/home/forge/repo-tour/oh-my-pi/infra/docs/02-omp-ci-template.md, file:///data/home/forge/repo-tour/oh-my-pi/infra/docs/03-caching.md) plus a CI template at file:///data/home/forge/repo-tour/oh-my-pi/infra/omp_ci_template.py.
- `.github/workflows/`: `ci.yml`, `nix.yml`, `bun-cache-warm.yml`.
---

## 3. Package + crate graph + responsibilities

### 3.1 TypeScript packages (packages/, 16 total)

| Dir | Package name | Responsibility (package.json description) |
|---|---|---|
| agent | @oh-my-pi/pi-agent-core | General-purpose agent with transport abstraction, state management, attachment support |
| ai | @oh-my-pi/pi-ai | Unified LLM API with automatic model discovery and provider configuration |
| browser-relay | @oh-my-pi/browser-relay | Chrome extension letting the omp browser tool drive your existing tabs (relay server lives in the CLI: `omp browser-relay`) |
| catalog | @oh-my-pi/pi-catalog | Model catalog: bundled model DB, provider discovery descriptors, identity/classification/equivalence |
| coding-agent | @oh-my-pi/pi-coding-agent | Coding agent CLI with read/bash/edit/write tools and session management (the `omp` app + SDK) |
| collab-web | @oh-my-pi/collab-web | Browser guest client + local relay tools for omp collab live sessions |
| metaharness | @oh-my-pi/pi-metaharness | Benchmark runners + Harbor run storage, REST/SSE APIs, live web dashboard |
| mnemopi | @oh-my-pi/pi-mnemopi | Local SQLite memory engine for omp agents |
| natives | @oh-my-pi/pi-natives | Native Rust bindings (PDF, audio, WebRTC, grep, clipboard, image, syntax highlight, PTY, shell) via N-API |
| omptype | @oh-my-pi/omptype | ArkType-compatible runtime schema validation with lazy JIT compilation |
| snapcompact | @oh-my-pi/snapcompact | Bitmap-frame context compression for vision-capable LLMs |
| stats | @oh-my-pi/omp-stats | Local observability dashboard for omp AI usage statistics |
| tui | @oh-my-pi/pi-tui | Terminal UI library with differential rendering |
| typescript-edit-benchmark | @oh-my-pi/typescript-edit-benchmark | Edit benchmark suite using TypeScript source mutations |
| utils | @oh-my-pi/pi-utils | Shared utilities for pi packages |
| wire | @oh-my-pi/pi-wire | Shared wire protocol types for omp packages |

Layer picture:
- Foundation: utils, wire, omptype, tui, catalog.
- Engine: agent (pi-agent-core) + ai (pi-ai) + natives (Rust bridge).
- Application: coding-agent (CLI `omp` + SDK).
- Siblings/peripherals: browser-relay, collab-web, mnemopi, snapcompact, stats, metaharness, typescript-edit-benchmark.

Coding-agent is the hub: it depends on agent, ai, catalog, tui, natives, utils, wire; and (optionally/soft) mnemopi, snapcompact, stats, omptype, browser-relay, collab-web.

### 3.2 Rust crates (crates/, 12 first-party + 4 vendored)

| Crate | Responsibility (Cargo.toml / lib.rs doc) |
|---|---|
| pi-natives | N-API addon surface: clipboard, grep, fd, glob, ANSI text measurement, syntax highlighting, HTML/PDF-to-Markdown, SIXEL, SVG, clipboard, pty, shell, oauth callback, live voice, predict, snapcompact, task, crash handler |
| pi-shell | pi's embedded bash: bash 5.3 engine (+zsh dialect), VM over virtual processes, pi-vfs host, persistent sessions, `obash` binary |
| pi-ast | AST primitives + tree-sitter language grammars (block, language) |
| pi-builtins | In-process CLI utilities and process builtins for the embedded shell |
| pi-diff | jsdiff-compatible diff primitives (Myers O(ND), line/word/structured patch) without FFI |
| pi-edit | Edit engine: parsing, matching, in-memory apply, diff gen + streaming session for progressive previews |
| pi-iso | Cross-platform isolation PAL: writable merged view over read-only lower tree (sandboxing/overlayfs) |
| pi-vcs | In-process VCS: git (gitoxide) + Jujutsu collapsed into one Rust interface |
| pi-vfs | Injectable async filesystem shared by embedded shell and coreutils |
| pi-voice | Native voice engine: mic capture, speaker playback, WebRTC live peer, Opus |
| pi-walker | Parallel filesystem walking, globbing, content search (backs glob/grep/fd/find/ast-grep) |
| pi-predict | In-house word-completion engines for the prompt composer (ngram, SmolLM2, Apple NSSpellChecker) |
| vendor/ | Vendored: cfg_aliases, grep-searcher, napi, tree-sitter-go |

Crate -> JS bridge: pi-natives is the single N-API addon; `packages/natives` is the typed JS loader. pi-shell/pi-vfs/pi-walker/pi-edit/pi-diff/pi-vcs/pi-ast/pi-builtins are napi-free rlibs consumed by pi-natives (so their heavy deps compile once and rebuild only on their own changes).

### 3.3 Python

- python/robomp/ — a GitHub triage/fix bot. pyproject.toml describes an app driving `omp --mode rpc`; ships a `robomp` package and a web dashboard (Bun workspace member python/robomp/web).
- sdk/python/omp-rpc — typed Python bindings for the `omp --mode rpc` protocol, generated from the wire schema (omp_rpc/_wire.py).
- sdk/rust/omp-rpc — Rust client (src/wire.rs generated from packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json; regenerate with `bun run gen:rpc`).
- sdk/go/omp-rpc — Go client, module github.com/can1357/oh-my-pi/sdk/go/omp-rpc.

---
---

## 4. Entry points / binaries

- CLI binary `omp` -> `src/cli.ts`. Source: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/package.json#L27-L29 (`"bin": { "omp": "src/cli.ts" }`).
- Package main / SDK barrel: `src/index.ts`. Source: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/package.json#L47-L50.
- `src/cli.ts` — top-level arg parse + mode dispatch (interactive / print / rpc / acp).
- `src/cli-commands.ts` — registers all subcommands (the ~60 files under src/commands).
- `src/main.ts` — main-mode bootstrap (session wiring before a mode takes over).
- `src/sdk.ts` — the embeddable SDK: `createAgentSession(...)`, `buildSystemPrompt(...)`, discovery helpers (`discoverSkills`, `discoverContextFiles`, `discoverMCPServers`, `discoverExtensions`). ~6k lines. Source: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts#L577-L1019, #L1944-L1950.
- Mode entry points under `src/modes/`: `interactive-mode.ts`, `print-mode.ts`, `rpc/` (JSON-lines RPC), `acp/` (Agent Client Protocol).
- Subcommand entry points: `src/commands/*.ts` (e.g. acp.ts, auth.ts, login.ts, launch.ts, plugin.ts, browser-relay.ts, worktree.ts, bench.ts, stats.ts, usage.ts).
- Rust binaries: pi-shell ships `src/bin/obash` (the embedded bash engine as a standalone shell for differential tests); the engine is also exposed as `omp zsh|bash|sh` via pi-natives. Source: file:///data/home/forge/repo-tour/oh-my-pi/crates/pi-shell/src/lib.rs#L14-L20.
- Native addon binary: `//:natives-<target>` `.node` files (loaded by packages/natives). Source: file:///data/home/forge/repo-tour/oh-my-pi/BUILD.bazel#L16-L36.

---

## 5. Core subsystems (by real file/dir)

### 5.1 Agent run loop
- Core loop: file:///data/home/forge/repo-tour/oh-my-pi/packages/agent/src/agent-loop.ts and file:///data/home/forge/repo-tour/oh-my-pi/packages/agent/src/agent.ts (`@oh-my-pi/pi-agent-core`). Handles tool-calling turns, streaming, state, telemetry spans, steering/pause, speculative execution.
- Session orchestrator that drives the loop for the CLI: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/agent-session.ts (the `AgentSession` class: prompt(), handle, cost gate, retry fallback, compaction triggers, tool session).
- Loop policy helpers: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/loop-condition.ts, loop-limit.ts, turn-budget.ts.

### 5.2 Tool system
- Registry + factory: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/index.ts (`BUILTIN_TOOLS`, `HIDDEN_TOOLS`, `createTools`).
- Canonical names: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts.

Built-in tools (30), from BUILTIN_TOOL_NAMES (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts#L1-L31):
read, bash, edit, ast_grep, ast_edit, ask, debug, ida, eval, github, glob, grep, find, lsp, checkpoint, rewind, context_notes, new_context, security_scan, task, wait, todo, web_search, write, memory_edit, retain, recall, reflect, learn, manage_skill.

Hidden tools (3), from HIDDEN_TOOL_NAMES: yield, goal, think (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts#L33).

Additional selectable capabilities exposed through `eval` preludes rather than the registry (per README tool table): browser, computer, generate_image, tts. Source: file:///data/home/forge/repo-tour/oh-my-pi/README.md#L80-L100 (tool table).

Beyond the built-ins, the tool set composes:
- MCP tools: `mcp__<server>_<tool>` (isMCPToolName) — file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts#L65-L67.
- Extension-contributed tools and ambient custom tools (extensibility/custom-tools).
- Session-managed builtins: manage_skill, learn, context_notes, new_context (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts#L1487).
- Devices mounted as `xd://` for forks (mountedToolNames).

Tool-related infrastructure: approval.ts, approval-cache.ts, approval-targets.ts, acp-bridge.ts, browser.ts, and per-tool files under file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/.

### 5.3 Model / provider integration
- Unified LLM client: `@oh-my-pi/pi-ai` — file:///data/home/forge/repo-tour/oh-my-pi/packages/ai/src/index.ts, streaming via providers.
- Custom API registry (built-in API ids): file:///data/home/forge/repo-tour/oh-my-pi/packages/ai/src/api-registry.ts#L20-L36 (openai-completions, openai-responses, openrouter, openai-codex-responses, azure-openai-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-gemini-cli, google-vertex, ollama-chat, cursor-agent, factory-droid-agent, gitlab-duo-agent, devin-agent, apple-foundation-models).
- Cursor provider + external-tool handoff: file:///data/home/forge/repo-tour/oh-my-pi/packages/ai/src/providers/cursor.ts and file:///data/home/forge/repo-tour/oh-my-pi/packages/ai/src/providers/cursor-external-tool-handoff.md.
- Model catalog / discovery / identity: `@oh-my-pi/pi-catalog` and file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/model-registry.ts, model-resolver.ts, model-discovery.ts, model-provider-discovery.ts, model-roles.ts, model-presets.ts, custom-models.ts, model-patch.ts.

### 5.4 Prompt / context
- System prompt builder: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/system-prompt.ts + `buildSystemPrompt` in sdk.ts (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts#L1411-L1457). Stable harness prompt and dynamic project context are returned as separate blocks (for prompt caching).
- Prompt assets: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/prompts/system/ and prompts/tools/ (Handlebars templates, tool descriptions).
- Context discovery / AGENTS.md: session/session-context.ts, workspace-tree.ts (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/workspace-tree.ts), config/prompt-templates.ts.
- Prompt templates + append/custom modes: config/prompt-templates.ts, config/append-only-context-mode.ts, config/inline-tool-descriptors-mode.ts.

### 5.5 Session / state
- Session manager + persistence: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/session-manager.ts, agent-storage.ts, indexed-session-storage.ts, redis-session-storage.ts, history-storage.ts, blob-store.ts, artifacts.ts.
- Compaction: session/compaction-methods.ts, compact-modes.ts, model-compaction-threshold.ts (plus `snapcompact` package = bitmap-frame compression for vision LLMs).
- Checkpoint/rewind: session/checkpoint-entries.ts, plus tools checkpoint/rewind.
- Retry/fallback + cost gating: session/retry-fallback-chains.ts, retry-fallback-reason.ts, cost-gate.ts.
- Multi-agent / IRC routing: session/irc-bridge.ts, registry/agent-registry.ts (MAIN_AGENT_ID, AgentRegistry.global()).

### 5.6 TUI
- Library: `@oh-my-pi/pi-tui` (file:///data/home/forge/repo-tour/oh-my-pi/packages/tui/src) — differential rendering, tool renderers, overlays, composer.
- App usage: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/interactive-mode.ts plus modes/components/, modes/controllers/.

### 5.7 Config
- Layered settings store: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/settings.ts (global config, project, --config overlay, runtime overrides; typed registry handles like `cfgCompactionEnabled.get(settings)`).
- Setting registry: config/all-settings.ts + config/registry.ts. Global dir default `~/.omp/agent`.
- Model config: config/model-settings.ts, models-config.ts, models-config-schema.ts, account-pools.ts, service-tier.ts.

### 5.8 Plugin / extensibility
- Extensions core: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/extensibility/ (extensions, skills, custom-tools, custom-commands, slash-commands, settings).
- Extension API surface: `ExtensionFactory`, `registerTool`, `api.on(event, handler)` with session_start/switch/branch/tree/shutdown, auto_compaction_*, auto_retry_*, ttsr_triggered, todo_reminder (see sdk.ts#L1560-L1648).
- Extension CLI: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/commands/plugin.ts.
- Discovery: `discoverSessionExtensionPaths`, `loadSessionExtensions`, `preloadedPreparedExtensions` (sdk.ts).

### 5.9 MCP (Model Context Protocol)
- Manager + config + client: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/mcp/ (manager.ts, loader.ts, config.ts, client.ts, json-rpc.ts, tool-bridge.ts, tool-cache.ts).
- Transports: mcp/transports/stdio.ts, http.ts, sse.ts.
- OAuth + Smithery registry: mcp/oauth-*.ts, smithery-registry.ts, smithery-connect.ts.
- Discovery from `.mcp.json`: `discoverMCPServers` (sdk.ts#L1402-L1405). MCP prompts become slash commands (`buildMCPPromptCommands`, sdk.ts#L1657-L1700).

### 5.10 Permissions / approval
- file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/approval.ts — approval modes: `always-ask`, `always-ask-cached`, `write`, `yolo`; per-tool policies allow|deny|prompt.
- Cache/targets: tools/approval-cache.ts, tools/approval-targets.ts.
- ACP permission gate: session/acp-permission-gate.ts; approval prompts via prompts/tools/approval-folder.md.
- CLI flag `--auto-approve` -> options.autoApprove (sdk.ts#L1017-L1018).

### 5.11 Sandboxing / execution
- Isolation PAL (overlayfs/hardlink backends): crate pi-iso (file:///data/home/forge/repo-tour/oh-my-pi/crates/pi-iso/src/lib.rs).
- Embedded shell: crate pi-shell (bash 5.3 engine, persistent session, pi-vfs host) + pi-vfs async FS + pi-builtins coreutils.
- Security subsystem: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/security/ + tools security_scan + security:// resource (sdk.ts BuildSystemPromptOptions.securityEnabled).
- Eval / Python kernel execution: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/eval/ and session/eval-runner.ts; subprocess-kernel preflight (skipPythonPreflight option).
- SSH execution: commands/ssh.ts + internal-url ssh-protocol.ts.

### 5.12 Auth
- Credential store (SQLite `agent.db`): session/auth-storage.ts, ai `AuthStorage` + `SqliteAuthCredentialStore` (see commands/auth.ts).
- Auth broker (remote, `OMP_AUTH_BROKER_URL`): session/auth-broker-config.ts, commands/auth-broker.ts, commands/auth-gateway.ts.
- Login / OAuth: commands/login.ts; ACP terminal-auth.ts; mcp OAuth flows.
- Account pools / sticky credentials: config/account-pools.ts, session/credential-pin.ts, SessionAccountPoolScope (sdk.ts#L2154-L2160).

### 5.13 IDE / LSP integration (the "IDE wired in" axis)
- LSP client + tool: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/lsp/ (client.ts, servers.ts, defaults.json, diagnostics.ts, edits.ts, format-options.ts, tool.ts, lspmux.ts, mux/, writethrough.ts).
- ACP (Agent Client Protocol) — editor/IDE bridge: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/acp/ (acp-agent.ts, acp-client-bridge.ts, acp-event-mapper.ts, acp-mode.ts, terminal-auth.ts).
- ACP subcommand + tool bridge: commands/acp.ts, tools/acp-bridge.ts.
- Cursor integration: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/cursor.ts + ai provider cursor.ts (cursor-agent API) + cursor-external-tool-handoff.md.
- "The IDE wired in" works two ways: (a) omp runs as an ACP **agent** that an editor (Zed/ACP-capable) drives; (b) omp drives Cursor/VS Code-family editors as a **client** via the cursor-agent provider + external tool handoff. LSP provides navigation/diagnostics/formatting.
- DAP (Debug Adapter Protocol): the `debug` built-in tool (28 ops per README).

### 5.14 Telemetry
- Export bootstrap: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/telemetry-export.ts (resolves OTEL_* contract; loads OTLP module only when needed) + telemetry-export-otlp.
- Agent loop spans (GenAI semantic conventions): AgentTelemetryConfig passed via CreateAgentSessionOptions.telemetry (sdk.ts#L996-L1005).
- Local usage dashboard: `@oh-my-pi/omp-stats` + commands/stats.ts, commands/usage.ts.

### 5.15 Browser
- Tool: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/browser.ts.
- Chrome extension relay: `@oh-my-pi/browser-relay` + commands/browser-relay.ts (relay server in the CLI) + commands/play.ts.

### 5.16 Internal URL schemes (resource addressing)
- Router + protocols: file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/internal-urls/ (router.ts, parse.ts) covering schemes such as agent, artifact, attachment, cfg, conflict, docs, history, issue-pr, local, mcp, memory, mr, omp, out, proc, rule, security, skill, ssh, vault, xd.

---
---

## 6. End-to-end request lifecycle

Trace: user runs `omp` -> model turn -> tool execution -> streamed reply.

1. **CLI dispatch.** `bin: omp -> src/cli.ts` (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/package.json#L27-L29). cli.ts parses argv, and `src/cli-commands.ts` registers the subcommand tree under `src/commands/`. A normal interactive launch selects `src/modes/interactive-mode.ts`.

2. **Session construction.** Whatever the mode, it calls `createAgentSession(options)` (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts#L1944-L1950). Startup fans out many discoveries in parallel and races slow scans against a 5s deadline:
   - `Settings.init` (layered config, file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/settings.ts),
   - `discoverAuthStorage` + `new ModelRegistry` (models.yml + model DB cache),
   - `discoverContextFiles` (AGENTS.md walk-up), `buildWorkspaceTree`,
   - `discoverSkills`, `discoverPromptTemplates`, `discoverSlashCommands`, custom commands,
   - `discoverTtsrRules`, `discoverAdvisorConfigs`, `discoverWatchdogFiles`, active repo context.
   See file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts#L1952-L2469 (the `STARTUP_SCAN_DEADLINE_MS` race at #L2044 and `raceWithDeadline` at #L2438).

3. **Model resolution.** `resolveAllowedModels` / `resolveModelRoleValue` pick the starting model; an existing session's models are restored in fallback order (`getRestorableSessionModels` / `resolveSessionModelSelector`, sdk.ts#L2265-L2294). Auth probes use the synchronous, side-effect-free `hasConfiguredAuth` to avoid blocking startup on OAuth/broker refreshes; the real key is resolved lazily per request (`modelRegistry.resolver`, sdk.ts#L2186-L2194, #L2473-L2474).

4. **Tool registry build.** `createTools` composes built-ins + hidden tools + session-managed builtins, then MCP tools, extension tools, and custom tools. A `ToolSession` object exposes cwd, exec, UI, pending actions (sdk.ts#L2566-L2576).

5. **System prompt build.** `buildSystemPrompt` renders the stable harness prompt (with tool descriptors, security:// inventory when enabled) and dynamic project context separately, so providers can cache the prefix (sdk.ts#L1411-L1457).

6. **Loop dispatch.** The mode calls `AgentSession.prompt(...)` (file:///data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/agent-session.ts), which drives the core loop in file:///data/home/forge/repo-tour/oh-my-pi/packages/agent/src/agent-loop.ts. On the first dispatch the `onFirstChatDispatch` hook fires (sdk.ts#L1007-L1015).

7. **Provider call.** The loop calls the model through the `@oh-my-pi/pi-ai` transport, selected by the model's `Api` (api-registry.ts BUILTIN_API_IDS). Streaming events are converted to agent events; thinking levels, service tiers, retry fallback chains, and prompt-cache keys are applied per request.

8. **Tool execution.** Assistant tool calls resolve through the ToolSession against the approval resolver (tools/approval.ts): policy `allow|deny|prompt` per tool, mode `always-ask|always-ask-cached|write|yolo`. Approved reads/searches go through the native walker (pi-walker) and embedded shell (pi-shell/pi-vfs); edits go through pi-edit; LSP diagnostics/formatting run through the lsp/ client; MCP tool calls go through mcp/manager.ts + the chosen transport.

9. **Approval round-trip.** Interactive/ACP sessions surface approval dialogs through the mode; ACP uses session/acp-permission-gate.ts; grants can be cached (approval-cache.ts).

10. **Reply + persistence.** Assistant messages stream to the TUI (or print/rpc/acp output), tool results return into the transcript, and the `SessionManager` persists entries (session-manager.ts / agent-storage.ts). Usage is recorded (`appendModelUsage`), cost gating and retries are evaluated, auto-compaction may trigger, and auto-title/autolearn capture can run in the background.

11. **Observability.** GenAI-semantic-convention spans are emitted through `@opentelemetry/api` when telemetry is enabled (telemetry-export.ts).

---

## 7. Notable / unique design choices (esp. IDE integration)

### IDE integration — two directions
- **omp as an ACP agent (editor drives omp).** `src/modes/acp/` implements the Agent Client Protocol: acp-agent.ts, acp-client-bridge.ts, acp-event-mapper.ts, acp-mode.ts, terminal-auth.ts. ACP-capable editors (e.g. Zed) launch `omp --mode acp` (commands/acp.ts) and exchange JSON-RPC frames; the `ask` tool works headlessly because `interactivePrompts` lets an ACP client render elicitation forms (sdk.ts#L957-L963). This is the literal "IDE wired in": the editor owns the UI and omp owns the agent.
- **omp driving editors as a client.** The `cursor-agent` API id (api-registry.ts#L20-L36) plus packages/ai/src/providers/cursor.ts and cursor-external-tool-handoff.md let omp talk to Cursor's model endpoints and hand tools out to the host editor. `src/cursor.ts` holds the bridge glue.
- **LSP/DAP depth.** lsp/ provides navigation (14 ops per README) + inline/writethrough diagnostics (writethrough.ts, workspace-diagnostics.ts, deferred-diagnostics.ts) + formatting; the `debug` tool spans 28 DAP ops.

### Other distinctive choices
- **Embedded bash, not child processes.** pi-shell is a real bash 5.3 engine (with a zsh dialect) compiled into Rust and exposed via pi-natives; `bash`, and `omp zsh|bash|sh` / `obash`, run on it, over an injectable pi-vfs filesystem. This gives deterministic, sandboxable shell execution and lets the same walker serve glob/grep/fd/find.
- **Capability-plane sandboxing.** pi-iso gives a writable merged view over a read-only lower tree (overlayfs / CoW clones) so edits can be isolated from the host checkout.
- **Prompt-block separation for cacheability.** The system prompt is returned as separate stable+dynamic blocks so providers cache the prefix; per-request `promptCacheKey`/`providerSessionId`/`taskPromptCacheKey` are threaded through (sdk.ts#L715-L723).
- **Credential affinity + account pools.** Sessions pin which account served a conversation so the provider-side prompt cache is not cold-missed; `oauthAccountPools` restrict a session to listed accounts (sdk.ts#L600-L617, #L2139-L2160).
- **Retry fallback chains.** Per-turn fallback across providers/models with usage-aware reserve, validatable offline (`deferRetryFallbackValidation`, session/retry-fallback-chains.ts).
- **Prewalk.** Automatically switch from the starting model to a fast/cheap target after the first edit once a todo list exists (`prewalk`, sdk.ts#L682-L689).
- **Autolearn capture.** A detached, cache-prefix-preserving clone of the primary agent runs learning nudges without disturbing the run (sdk.ts#L1779-L1912).
- **Multi-agent via IRC.** Sessions register in an AgentRegistry and route messages over an IRC bridge (registry/agent-registry.ts, session/irc-bridge.ts); child `task` subagents inherit buses/registry.
- **Devices via `xd://`.** Forks mount inherited tools as `xd://` devices rather than top-level tools (sdk.ts#L855-L858).
- **Rich internal URL space.** omp://, agent://, skill://, memory://, history://, issue-pr://, security://, mcp://, ssh://, vault://, etc. make resources addressable in prompts and tools (internal-urls/).
- **Deferred startup work.** Heavy or dependent startup (workspace tree, skill-description compression, extension loading, background model discovery) is deferred past the first frame with explicit deadlines (sdk.ts#L2438-L2461, #L985-L989, #L1043-L1044).
- **Self-hosting config.** The repo carries its own .omp/ agent config (commands, skills, tools, tests).

---

## 8. Features UNIQUE to oh-my-pi vs COMMON with other agents

### UNIQUE / distinctive to oh-my-pi
- **ACP both directions + Cursor provider + deep LSP/DAP**: editor-as-host (ACP agent mode) and editor-as-tool (cursor-agent API + external tool handoff).
- **Embedded Rust bash (pi-shell) with an injectable VFS (pi-vfs)** and coreutils (pi-builtins) — not a shell-out to the system.
- **Native capability stack compiled once** (pi-natives addon; ~80k LoC Rust) covering walker/grep/fd, edit engine, diff, VCS (gitoxide + Jujutsu), sandbox (pi-iso), voice (pi-voice), word prediction (pi-predict), PDF/HTML→Markdown, SIXEL/SVG, PTY.
- **Autolearn capture agent** that keeps the primary prompt-cache prefix while running a refused-tool clone.
- **Prewalk** model downgrade at first edit / todo creation.
- **Credential-affinity prompt-cache pinning + OAuth account pools** as first-class controls.
- **Snapcompact** (bitmap-frame context compression) for vision LLMs.
- **IRC-based multi-agent routing** with an AgentRegistry.
- **Rich omp URL scheme space** (agent://, skill://, memory://, security://, xd:// devices…).
- **Cost gate across the whole session tree** with per-root async job manager and generated job widgets/captions.
- **Self-hosting** agent config in .omp/.
- **JSdiff-compatible diff without FFI** (pi-diff) and a **streaming edit session** producing progressive previews (pi-edit).

### COMMON with other coding agents (opencode, codex, grok-build, forgecode, HorizonCode, Reasonix…)
- Multi-provider model layer with streaming and tool calling (60+ providers here).
- The core tool set: read, write, edit, bash/shell, glob, grep, todo/plan, task/subagent, web search/fetch, ask.
- MCP client support (stdio/http/sse transports) and .mcp.json discovery.
- ACP / editor integration in some form.
- Session persistence, resume/fork, context compaction, checkpoints/rewind, retries.
- LSP integration for diagnostics/formatting.
- Subagents/task delegation, skills, custom commands/slash commands, extensions/plugins.
- TUI with differential rendering; print/headless and RPC modes.
- Permissions/approval modes (auto-approve/yolo, per-tool policies).
- OpenTelemetry-style telemetry; usage/cost dashboards.
- Sandboxing effort (overlayfs/seatbelt/etc.).
- Bench harnesses (here: metaharness + typescript-edit-benchmark).

---

## 9. Absolute paths of the most important files

Root & config
- /data/home/forge/repo-tour/oh-my-pi/README.md
- /data/home/forge/repo-tour/oh-my-pi/AGENTS.md
- /data/home/forge/repo-tour/oh-my-pi/CONTRIBUTING.md
- /data/home/forge/repo-tour/oh-my-pi/package.json
- /data/home/forge/repo-tour/oh-my-pi/Cargo.toml
- /data/home/forge/repo-tour/oh-my-pi/BUILD.bazel
- /data/home/forge/repo-tour/oh-my-pi/MODULE.bazel
- /data/home/forge/repo-tour/oh-my-pi/tsconfig.base.json
- /data/home/forge/repo-tour/oh-my-pi/about.toml

Entry points / SDK (coding-agent)
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/cli.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/cli-commands.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/main.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/index.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/system-prompt.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/telemetry-export.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/cursor.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/workspace-tree.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/DEVELOPMENT.md

Agent loop
- /data/home/forge/repo-tour/oh-my-pi/packages/agent/src/agent-loop.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/agent/src/agent.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/agent-session.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/session-manager.ts

Tools
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/index.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/approval.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/acp-bridge.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/browser.ts

Providers / models
- /data/home/forge/repo-tour/oh-my-pi/packages/ai/src/index.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/ai/src/api-registry.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/ai/src/providers/cursor.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/model-registry.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/model-roles.ts

IDE / LSP / ACP
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/acp/acp-agent.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/acp/acp-mode.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/commands/acp.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/lsp/tool.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/lsp/client.ts

MCP / config / session
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/mcp/manager.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/settings.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/config/all-settings.ts
- /data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/internal-urls/router.ts

Rust crates
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-natives/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-shell/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-vfs/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-walker/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-edit/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-diff/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-vcs/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-iso/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-voice/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-predict/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-ast/src/lib.rs
- /data/home/forge/repo-tour/oh-my-pi/crates/pi-builtins/src/lib.rs

---

_End of report._
