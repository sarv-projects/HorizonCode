# DeepSeek-Reasonix — Exhaustive Code-Organization Tour

_Read-only research report. Generated 2026-11-06 from commit `b1106b9` on branch `studio` (clean working tree). No repository file was modified._

All paths below are absolute and rooted at `/data/home/forge/repo-tour/DeepSeek-Reasonix`.

---

## 1. Identity

| Field | Value |
| --- | --- |
| Project | **Reasonix** (repo `esengine/DeepSeek-Reasonix`) |
| Description | "A reliable coding agent for complex software engineering tasks." |
| Language | **Go** (primary); TypeScript/React (desktop SPA), Kotlin/Gradle (Android), JavaScript (npm/scripts/workers) |
| Go module | `reasonix` (`go.mod`); Go **1.26.0**, toolchain `go1.26.10` |
| Default/active branch | **`studio`** = the 2.x line (Reasonix Studio). `main-v2` is the 1.x maintenance line. |
| License | MIT |
| Maintainer | Huahui Yu (@esengine) |
| Version identity | `git describe --tags` minus the `studio-` prefix, injected via `-ldflags` (`main.version`, `main.gitCommit`, `main.buildTimeUTC`) |
| What it is | An open-source AI coding agent: a thin harness driving config-selected models, with capabilities supplied by configuration and plugins. Four frontends (terminal TUI, desktop Studio, browser `serve`, editor ACP) run the **same** local Go kernel. |
| Release model | Two lines: 2.x on `studio` (features), 1.x on `main-v2` (fixes). Studio desktop releases are tagged `studio-v2.*`; CLI is cross-compiled for `darwin|linux|windows × amd64|arm64`. |

The single standing-instructions file is `REASONIX.md` (read by both Reasonix and Codex); `AGENTS.md` and `CLAUDE.md` are thin `@REASONIX.md` includes.

### Scale (measured)

| Measure | Value |
| --- | ---: |
| Go files under `internal/` | 6,077 |
| Go lines under `internal/` | **929,912** |
| Test files under `internal/` (`*_test.go`) | 3,328 (~55% of files) |
| Root-module Go lines (`cmd` + `internal` + `tools`) | **963,047** |
| `desktop/` Go files / lines | 15 / 2,965 |
| `sdk/go` Go lines | 7,236 |
| `desktop/frontend-next` `.ts`/`.tsx` files | 1,779 |
| Markdown docs under `docs/` | 107 |
| Studio release-note files | 162 |

The codebase is unusually disciplined and heavily gated: `REASONIX.md` (standing rules), `docs/SPEC.md` (engineering contract), `docs/DOCS_STANDARD.md` (doc standard), and a repo-specific linter (`tools/repolint`) that enforces layering, file/function size, comment budgets, wire parity, frontend parity and more against a ratchet baseline.

> **Staleness note:** `docs/SPEC.md` §2 ("Layout") and `CONTRIBUTING.md` still describe an older package layout (`internal/cli`, `internal/config`, `internal/provider`, `internal/tool`, `internal/permission`, `internal/agent`). The **actual** tree has been reorganized into `internal/{base,contract,runtime,state,assembly,session,model,safety,tools,platform,ext,frontend}` plus host packages. Treat this report's tree as authoritative over SPEC §2; SPEC's abstraction chapters (§3+) remain accurate and are cited throughout.

---

## 2. Top-level map

| Path | Kind | Purpose |
| --- | --- | --- |
| `cmd/` | host binaries | `reasonix` (CLI entry), `reasonix-studio-host` (desktop kernel host), `e2ebench` (benchmark harness), `extension-protocol-gen`, `reasonix-plugin-example`, `signpath-contract`, `studio-delta` |
| `internal/` | Go kernel | The entire engine: ~930k lines across the groups in §3. Nothing outside it except `cmd/` hosts and the frontends drives it. |
| `desktop/` | nested Go module + web app | **Reasonix Studio**: Electron shell, React/TS SPA (`frontend-next`), packaging, updater; `module reasonix/desktop`, `replace reasonix => ../` |
| `android/` | Gradle app | **Reasonix Mobile**: kernel cross-compiled to `libreasonix.so`, serves the same `frontend-next` page; agent reaches servers over SSH |
| `sdk/go` | nested, stdlib-only Go module | Public **Extension Protocol v2** SDK (host + sidecar sides), DTOs generated from `internal/ext/extension/protocol` |
| `npm/` | JS | `reasonix` npm wrapper (`lib/bin/reasonix.js`, `package.json`, `build.mjs`, `publish.mjs`) |
| `workers/` | JS workers | Cloudflare-style workers: `accounts`, `crash-report`, `forum` |
| `benchmarks/` | harnesses + corpus | e2ebench suite, compaction, context-maintenance-e2e, upstaged-edge, fanout-width, memorybench, realrepo, swebench, project-check, verification-stress, intelligent-ui, train… |
| `examples/` | kits | Sample plugin/skill kits (api-notes, command-notes, frontend-page, issue-fix, mcp-line-counter, release-note, repo-map, review-context, work-note) |
| `integrations/` | DSH plugin | DeepSeek Harness subagent plugin + `market-index.json` |
| `tools/` | dev tooling (separate `package main`s) | `repolint`, `covergate`, `pricecheck`, `acp-conformance`, `loopmetrics`, `relayfake`, `trajectory`, `workgroupassay`, `write_heartbeat` |
| `docs/` | documentation | Spec, guide, contracts, security analyses, design proposals, themes |
| `release-notes/studio/` | release notes | One `.md` per Studio version (written in Chinese per the doc standard) |
| `scripts/` | build/release scripts | Node `.mjs` + shell for CI, releases, signing, contributors, npm |
| `.github/` | CI/CD | 30+ workflows, CODEOWNERS, PR/issue templates, dependabot, labeler |
| `.reasonix/`, `.signpath/`, `.githooks/` | config | Project-local Reasonix state, Windows signing policy, `pre-push` hook |
| Root files | — | `REASONIX.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` (+zh-CN), `CONTRIBUTING.md`, `SECURITY.md`, `design-qa.md`, `Makefile`, `.goreleaser.yaml`, `reasonix.example.toml`, `.golangci.yml`, `.golangci-version`, `prod_fast_test` |

---

## 3. Go package graph, responsibilities and layering

### 3.1 Host binaries — `cmd/`

| Package | Responsibility |
| --- | --- |
| `cmd/reasonix` | The CLI entry (`main.go`). Blank-imports provider + builtin tool packages so their `init()` self-registration fires; installs `netdns` (a CGO-free build cannot read a system resolver file), installs crash capture, then calls `cli.RunWithBuildInfo`. |
| `cmd/reasonix-studio-host` | The desktop's kernel host: `boot.Build` → `control.Controller`, served over loopback for the Studio/Serve browser UI. Hosted in the main module (not `desktop/`) so the updater stays in the kernel's language. |
| `cmd/e2ebench` | End-to-end benchmark harness (suite/diff/swebench/compare/traj/audit modes); neutral metering proxy, fault injection, segments, anchors. |
| `cmd/extension-protocol-gen` | Generates the Extension Protocol machine-readable schema/index from `internal/ext/extension/protocol`. |
| `cmd/reasonix-plugin-example` | Runnable reference MCP stdio server (`echo`, `wordcount`). |
| `cmd/signpath-contract` | Windows SignPath signing-policy contract tooling. |
| `cmd/studio-delta` | Studio delta/update helper. |

### 3.2 `internal/base` — utility layer (imports only itself; "leaves")

Highly reusable, kernel-agnostic building blocks. Key packages:
`backgroundwork`, `diff`, `externalurl`, `filelock` (cross-process config-edit locks), `fileref`, `fileutil` (+`encoding`), `flexstr`, `frontmatter` (dependency-free YAML-ish frontmatter), `gitignore`, `hostwrite`, `i18n` (en/zh catalogs + `TestCatalogsComplete`), `netclient`, `netdns`, `neterr`, `nilutil`, `proc` (process/job ownership), `retrieval` (BM25), `rulelist`, `scratch`, `secrets`, `shellparse` (bash AST), `sysproxy`, `tempdir`, `testenv`/`testscope` (test isolation), `textutil`, `tokencount`, `workspacefile`, `workspaceid`.

### 3.3 `internal/contract` — interfaces, typed contracts, published tables (mostly leaves)

| Package | Responsibility |
| --- | --- |
| `provider` | `Provider` interface, `Request`/`Message`/`Chunk` wire types, `Register`/`New` registry, `SetClientVersion`, `ErrUnknownModel`, usage/accounting types |
| `tool` | `Tool` interface, runtime `Registry`, `RegisterBuiltin`/`Builtins` |
| `config` | TOML loading, resolution order, presets, `shippedPresets`/`preset_upgrade.go`, migrations, `ReasonixHomeDir`, `ResolveModel` |
| `event` / `eventwire` | Typed event stream (`event.Sink`) and its wire form for frontends/ACP |
| `pricing` | `officialRates`, `CurrentRate`, `SupersededRates` — the one table of vendor prices |
| `settings`, `surface(spec)`, `chartspec`, `permrule`, `planmode`, `delivery`, `ablation`, `agentgraph`, `agentpreset`, `agentcomposition`, `mcpdiag`, `observe`, `hostaudit`, `walletformat` | Typed contracts for settings display, tool surfaces, charts, permission rules, plan mode, delivery claims, ablation arms, agent graphs/presets/compositions, MCP diagnostics, host audit |

### 3.4 `internal/runtime` — the agent engine

| Package | Responsibility |
| --- | --- |
| `agent` | The core turn loop, `Session`, per-turn/window state, todo/progress lease, budget scoping, sub-agent spawning (`spawn_boundary_test.go`), keep-policy. |
| `coordinator` | Two-model collaboration (planner + executor in separate cache-stable sessions). |
| `delegation` | The five delegation concepts (profile, TaskSpec, CapabilityGrant, ContextRequest/Capsule, SchedulerPolicy); `profile_boundary_test.go` enforces the split. |
| `scheduler`, `schedrun` | Session scheduler + concurrency ceilings for fleet/parallel tasks |
| `capability`, `usecap` | Capability identity/`use_capability` proxy for MCP + root budgets |
| `completion` | Host-authored turn completion report with gaps by subtraction |
| `contract`, `taskcontract`, `plancontract` | Task contracts (THS revisions), atomic-task logic, plan contracts |
| `taskpolicy`, `taskmonitor` | Route/depth policy (planner gating) and progress monitoring |
| `guardian` | Safety review model path |
| `goaleval` | Bounded independent evaluator (advisory only) |
| `recovery` | Restart/resume repair (interrupted runs → `interrupted`) |
| `writeclaim`, `commitmsg`, `persona`, `outputstyle`, `langpref`, `promptrefine` | Write-claim enforcement, commit-message generation, persona/output-style/language preferences, prompt refinement |

### 3.5 `internal/session/control` — the transport-agnostic Controller

One package (217 non-test files, 478 total) implementing `control.Controller`: owns the agent run loop and session lifecycle, takes commands (`Send`/`Cancel`/`Approve`/`SetPlanMode`/`Compact`/`NewSession`…), and emits every event to a single `event.Sink`. **Every frontend drives this one layer.** Concerns hosted here include approvals (`approval*.go`), `ask` questions, plan/goal state machines, composition, branches/checkpoints, attachments, capabilities, extensions, MCP/plugins, skills, hooks, memory, settings edits, git push/commit, usage/currency, history, subagents, write-path enforcement, headless posture.

### 3.6 `internal/state` — persistence and canonical state

`memory` (REASONIX.md hierarchy + saved facts + `MEMORY.md` index), `instruction`, `sessionstore`, `sessionv4` (+fixtures), `history`/`historycatalog` (BM25 over JSONL + catalog), `checkpoint` (snapshot rewind), `mutation` (workspace mutation tracking), `execgraph`/`execjournal`, `trajectory`, `trustedstate` (Trusted Host State / THS), `projectiondb` (SQLite via `modernc.org/sqlite`), `storage`, `store`, `stats`, `usagecatalog`/`usagereport`, `workspacelease` (writer-claim leases), `workspacelist`, `workgroup`, `peermail` (peer MCP), `schedule`, `sessioninbox`/`sessiontemp`, `agentpreset`, `migration`.

### 3.7 `internal/assembly/boot` — the assembly root

`boot.Build` is the **one** place that turns configuration into a ready-to-drive `Controller`: load config, resolve models, build the tool registry (built-ins + plugins), wire the permission gate and sandbox, construct the executor (optionally wrapped in a `Coordinator`). 477 files (many `composition_*`, `*_tool_wiring`, `mcp_wiring`, `skills`, `delegation`, `observe`, `doctor_runtime`). Frontends pass only a sink and a few knobs. `effect_test.go` and `context_projection_test.go` assert behavior at the real provider/frontend boundary.

### 3.8 `internal/model` — providers

`openai` (OpenAI-compatible `/chat/completions`), `anthropic` (native Messages + cache control), `gemini`, `responses` (OpenAI Responses API), `laya`, `noprovider`, plus `billing`, `catalog` (model catalog), `boundedllm`, `providerbroker`, `providerhealth`, `visionimage`. Providers self-register via `init()`.

### 3.9 `internal/safety` — policy + enforcement

`permission` (per-call `Policy`/`Gate`, `allow`/`ask`/`deny` rules, Claude-style families), `sandbox` (Seatbelt/bwrap/Windows write-restricted token; `ReadOnly`/`ForbidReadRoots`/`HostAuthorities`), `shellsafe` (dynamic/killed-command classification), `evidence` (obligations, verification contracts, test criteria), `egress`, `redirectguard`, `endpointclient`, `typesafe`.

### 3.10 `internal/tools` — tool implementations

`builtin` (~90 non-test files: bash + argv variants, read/write/edit/multiedit/move, delete_range/delete_symbol, notebook_edit, ls/glob/grep, codeindex + tree-sitter, browser, computer, chart, present_files, view_image, read_video, web_fetch/web_search/web_image, todo, recall/history/memory, complete_step, update_goal, compress, peers, setting, system_one, session_guard), `websearch` (search chains + root budget), `fetchchain`, `jobs` (long-running jobs), `script`, `sessiontool`, `shellrun`, `advisor`, `productdocs` (embedded docs retrieval).

### 3.11 `internal/platform` — OS/host integration

`account`, `appidentity`, `appupdate`/`update`, `browser`, `clipimage`, `computer` (computer-use), `crashreport`, `delta` (binary delta), `diskhealth`, `editor`, `environment` (startup summary), `feedback`, `gitcmd`/`gitcommit`/`gitpush`/`gitrepos`/`gitstatus`, `installlayout`, `instanceid`, `lsp` (language servers), `notify`, `opendoc`/`openwith`, `otlp`/`telemetry`, `packagegrant`, `releaseasset`, `remote` (`attach`, `bootstrap`, `execfs`, `forward`, `sftpfs`, `wslconn`, `sshtest` — SSH/SFTP Remote-SSH module), `remotecloud`, `repair`, `worktree`, `wsl`.

### 3.12 `internal/ext` — extensions and plugins

`extension` (+ `dispatch`, `protocol`/`protocolgen`, `sidecar`, `providerconv`/`providerext`, `uihub`, `conformance`, `rpcwire`) → **Extension Protocol v2** code runtime; `extensioncontract`; `plugin` (MCP client: stdio/http/sse + OAuth), `mcplaunch`/`mcpregistry`/`mcpsetup`; `skill` (+ `builtincontent`, `builtincontent/reasonix-guide`), `skilllock`, `skillupdate`; `command` (custom slash commands), `hook`, `rules`, `theme` (+`builtin`), `market`, `modhost`/`modpreview` (module host), `pluginpkg`, `pluginspec`, `installsource`, `configbackup`.

### 3.13 `internal/frontend` — the frontends

| Package | Frontend |
| --- | --- |
| `cli` | Subcommand routing, flags, setup wizard, ~110 non-test files (doctor, mcp manager, serve broker, review, subagent, model/skill pickers, remote, hooks view, schedule) |
| `tui` | The Bubble Tea full-screen chat UI |
| `clisession`, `termrender`, `traystate` | Session driver, terminal rendering, tray state |
| `serve` | HTTP/SSE server frontend (`reasonix serve` / browser UI) — largest single concern, hundreds of route files (auth, hub, devices, browser, cloud, attachments, git, goals…) |
| `acp` | Agent Client Protocol (NDJSON JSON-RPC 2.0) for editors |
| `remotehost` | Host adapter: machines a Studio opens a workspace on (declared host adapter, not a kernel package) |
| `schedulerun` | Headless scheduled-run frontend |
| `capdiag`, `doctor` | Capability diagnostics, `reasonix doctor` |

### 3.14 Nested modules and non-Go trees

- **`desktop/`** (`module reasonix/desktop`): `electron/` (main process, preload bridge, packaging), `frontend-next/` (React+TS+Vite SPA; 1,779 TS/TSX files), `internal/winuninstall`, `cmd/{update-helper,studio-manifest,sign}`, `packaging/`.
- **`sdk/go`** (stdlib-only): Extension Protocol v2 SDK — `sdk.go`, `provider_*.go`, `tools.go`, `ui.go`, `intercept.go`, `shutdown.go`, `wire.go`, `types_generated.go`.
- **`android/`**: Gradle project; `build.sh` → `build-kernel.sh` (kernel → `libreasonix.so`), `sync-page.sh` (page → assets), then `gradlew assembleRelease`.
- **`npm/`**: npm wrapper that pulls the prebuilt native binary.
- **`workers/`**: `accounts`, `crash-report`, `forum` (Cloudflare workers + D1 migrations).

### 3.15 Layering rules (enforced by `tools/repolint/layers.go`)

- **Utility/leaf set** (`internal/base/*` plus chosen `contract`/`state`/`safety`/`platform`/`model` leaves) imports nothing under `reasonix/` except one another — a closed layer.
- **`internal/session/control`** is reachable only from declared frontends and hosts: `acp`, `assembly/boot`, `cli`, `clisession`, `schedulerun`, `serve`, `tui`; hosts are `cmd/`, `desktop/`, `benchmarks/`.
- **Nothing below a frontend may import a frontend**; `remotehost` is a host adapter assembled by hosts only.
- The rule the tour relies on: *one `control.Controller` behind every frontend; add behavior to the controller, not a frontend.*

---

## 4. Entry points

| Entry | Path | Flow |
| --- | --- | --- |
| CLI `reasonix` | `cmd/reasonix/main.go` | sets provider client version, `os.Exit(runWithCrashCapture(...))` → `cli.RunWithBuildInfo` |
| CLI routing | `internal/frontend/cli/cli.go` (+ `cli_flags.go`, `flag_parse.go`) | parse flags → subcommand dispatch (`setup`, `run`, `serve`, `acp`, `doctor`, `plugin`, `mcp`, `subagent`, `schedule`, `review`, `config`, `version`…) |
| One-turn `reasonix run` | `internal/frontend/cli/run_output.go` + `run_sink.go` | boots controller, runs one prompt, writes metrics/trajectory/verdict |
| Interactive TUI | `internal/frontend/tui` | Bubble Tea program driving `control.Controller` |
| Desktop | `cmd/reasonix-studio-host/main.go` → `boot.Build` → `internal/frontend/serve` | Electron/React talk to the shell over loopback HTTP+SSE |
| Browser | `reasonix serve` → `internal/frontend/serve` | HTTP/SSE on loopback |
| Editor | `reasonix acp` → `internal/frontend/acp` | NDJSON JSON-RPC 2.0 (ACP v1) |
| Benchmarks | `cmd/e2ebench/main.go`, `benchmarks/*/main*.go` | hosts that build a real agent and drive it |
| Plugin example | `cmd/reasonix-plugin-example` | reference MCP stdio server |

`main.go` is deliberately tiny: it blank-imports `internal/model/{anthropic,gemini,openai,responses}` and `internal/tools/builtin`, so all registries are populated by `init()` before the CLI runs. Only `cli`/`main` decide exit codes and print user-facing text (library code never calls `os.Exit` or writes stdout/stderr).

---

## 5. Core subsystems

### 5.1 Agent loop, Session and the Controller

- **`internal/runtime/agent`** — the loop: build a `provider.Request` (with tool schemas) → `provider.Stream` → print text deltas, collect complete tool calls → execute each tool (built-in or plugin) → append results → repeat, bounded by `maxSteps`/budget. `ctx` threads throughout (Ctrl-C aborts in flight). `Session` holds the message list; a `Runner` interface (`Run(ctx,input) error`) is satisfied by both `Agent` and `Coordinator`. Key files: `agent.go`, per-turn state (`agent.perTurnState` pattern), `windowState` (projection/compaction/estimation), turn loop, todo/progress lease, budget scoping.
- **`internal/session/control`** — `Controller` (package doc in `controller.go`): owns the run loop and session lifecycle, exposes commands and emits a typed `event.Sink` stream. It depends on no frontend. It is the *only* orchestration layer; all four frontends drive it identically.
- **`internal/runtime/coordinator`** — two-model mode: a planner runs in its own session with a filtered read-only tool set, produces a plan, and hands it to an executor `Agent` in a separate session. Sessions never mix, keeping each prefix cache-stable. A deterministic host policy (`taskpolicy`) picks executor-only / light / full / plan-for-approval / plan-only from the raw user text (no classifier model, no prompt sniffing).

### 5.2 Tool system (full built-in list)

`internal/contract/tool` defines `Tool` (`Name`, `Description`, `Schema`, `Execute`) + a runtime `Registry`; built-ins self-register via `tool.RegisterBuiltin` in `init()`. The agent sees only the registry (enabled built-ins filtered by config **plus** plugin tools). Schemas are canonicalized on insertion; the built-in contract is documented in `docs/TOOL_CONTRACT.md` and backed by tests comparing the documented surface to the canonical schema path (`internal/tools/builtin/schema_budget.json`).

Non-test files under `internal/tools/builtin/` reveal the built-in tool surface (grouped by concern):

- **Shell / execution:** `bash.go`, `bash_cmdline{,_windows,_other}.go`, `bash_delete*`, `bash_egress.go`, `bash_external.go`, `bash_foreground.go`, `bash_gitmeta.go`, `bash_job_exit.go`, `bash_nul.go`, `bash_shellenv.go`, `bash_writeroots.go`, `shellparse` (from `internal/base`), `sessiontemp_error.go`, plus `bgjobs.go` (background jobs).
- **File mutation:** `writefile.go`, `writefile_source.go`, `editfile.go`, `edit_read_policy.go`, `editsource.go`, `multiedit.go`, `movefile{,_windows,_other}.go`, `notebookedit.go`, `delete_range.go`, `delete_symbol.go`.
- **File read / search:** `readfile.go`, `ls.go`, `glob.go`, `grep.go`, `grep_path.go`, `codeindex.go`, `codeindex_treesitter{,_stub}.go`, `walk_confine.go`, `fileviews.go`/`fileviews_binding.go`, `host_subject.go`.
- **Web / media:** `webfetch.go`, `webfetch_page.go`, `webimage.go`, `viewimage.go`, `readvideo.go`/`readvideo_native.go`, `browser.go`, `computer.go`, `chart.go`, `present_files.go`, `preview.go`, `openedpath_*.go`.
- **Session / agent control:** `todo.go`, `completestep.go`, `updategoal.go`, `compress.go`, `recall.go`, `contextbudget.go`, `setting.go`, `systemone.go`, `peers*.go` (peer MCP dispatch), `session_guard.go`, `clientio.go`.
- **Confinement / safety:** `confine.go`, `roots.go`, `provenance.go`, `target_access.go`, `write_paths.go`, `protected_dirs_{darwin,other}.go`, `realpath_{unix,windows}.go`, `post_write_receipt.go`.
- **Other tool packages:** `internal/tools/websearch` (search chains + root websearch token budget), `internal/tools/fetchchain`, `internal/tools/jobs`, `internal/tools/script`, `internal/tools/sessiontool`, `internal/tools/shellrun`, `internal/tools/advisor`, `internal/tools/productdocs` (embedded doc retrieval).

### 5.3 LLM / provider integration

- `internal/contract/provider` — `Provider` interface, `Register(kind, factory)` registry, wire types (`Message`, `ToolCall`, `ToolSchema`, `Request`, `Chunk`), streaming tool-call accumulation by index (only complete calls emitted).
- `internal/model/openai` (OpenAI-compatible), `internal/model/anthropic` (native Messages + prompt-cache control + interrupted-usage recovery), `internal/model/gemini`, `internal/model/responses`, `internal/model/laya`, `internal/model/noprovider`; `catalog`, `billing`, `boundedllm`, `providerbroker`, `providerhealth`, `visionimage`.
- A *vendor endpoint* (`base_url` + `api_key_env`) exposes one or more models; OpenAI-compatible vendors are config instances, not code. Model references resolve via `config.ResolveModel` (provider name, bare model, or `provider/model`).

### 5.4 Prompt & context management

Cache-first, append-only canonical transcript with a rare provider-visible checkpoint (SPEC §3.6):

- Stable prefix = base system prompt + tool schemas + declared prefix configuration, byte-stable across turns (see `internal/assembly/boot` `context_projection_test.go`).
- The single automatic compaction trigger is `agent.compact_ratio` (default 0.90; presets 0.70/0.80/0.90); `triggerTokens = floor(context_window × ratio)`. Below it, history is never rewritten. At it, one summary transaction: `prefix + one digest + recent verbatim tail` (candidate ≤50% of window).
- Giant tool results bounded once on first entry (`Content` ≤32KB; `RawContent` holds the original; `ModelMessages` strips `RawContent`).
- Dynamic state (skills index, memory store) is *projected* onto the turn, not the prefix: `internal/state/projectiondb`, `internal/ext/skill`, `internal/state/memory`. Freshness is semantic (`skillSet.owedCatalog` asks the registry, not writers).
- `internal/base/retrieval` (BM25) powers the read-only `history`/`memory` tools and pre-turn bounded recall.
- Relevant docs: `docs/SESSION_MEMORY_RETRIEVAL.md`, `docs/BOUNDED_ROOT_TOKEN_BUDGET.md`, `docs/*_TOKEN_BUDGET*.md`.

### 5.5 Session & state persistence

`internal/state`: `sessionstore`/`sessionv4` (JSONL transcripts), `history`/`historycatalog`, `checkpoint` (snapshot rewind, `docs/CHECKPOINTS.md`), `mutation` + `workspacelease` (writer claims/leases), `execgraph`/`execjournal`, `trajectory`, `trustedstate` (THS content-addressed, hash-chained host state), `projectiondb` (SQLite), `usagecatalog`/`usagereport`/`stats`, `workgroup`, `peermail`, `schedule`, `instruction`, `memory`, `migration`.

### 5.6 UIs

- **TUI**: `internal/frontend/tui` (Bubble Tea v2), rendered via `internal/frontend/termrender`.
- **CLI**: `internal/frontend/cli` (subcommands, doctor, mcp manager, pickers, setup wizard).
- **Serve/browser + Desktop UI**: `internal/frontend/serve` (HTTP+SSE). Studio's SPA `desktop/frontend-next` talks only to `HostPort` for OS capability (`desktop/frontend-next/src/port/host.ts`), answered by the Electron main process over IPC.

### 5.7 Configuration (`reasonix.toml`)

`internal/contract/config` loads TOML with resolution order **flag > `./reasonix.toml` > user config > built-in defaults`** (project config also accepts `.reasonix/reasonix.toml`; the two are never merged). Providers, `[agent]`, `[tools]`, `[skills]`, `[permissions]`, `[sandbox]`, `[serve]`, `[ui]`, `[environment]`, `[[plugins]]`/`[[mcp.servers]]`, and project `.mcp.json` (Claude Code schema) are declared here. Preset upgrades flow through `shippedPresets` (`preset_upgrade.go`). Paths/migration: `docs/CONFIG_PATHS.md`.

### 5.8 Extensions, plugins, MCP

- **MCP client** — `internal/ext/plugin`: JSON-RPC 2.0 over `stdio` (default), `http`/`streamable-http` (with OAuth: PRM/AS metadata, DCR, PKCE S256, loopback callback, refresh rotation), and legacy `sse`. Remote tools adapted as `mcp__<server>__<tool>`, `readOnlyHint` → `Tool.ReadOnly()`, per-server `concurrency = parallel|serial`. Prompts/resources surface as slash commands and `@server:uri`.
- **Extension Protocol v2** — `internal/ext/extension` (+`sidecar`, `dispatch`, `protocol`/`protocolgen`, `uihub`, `providerconv`/`providerext`): out-of-process code extensions that intercept runtime events, own replacement slots, contribute providers and structured UI; machine schema in `internal/ext/extension/protocol/schema.generated.json`; index `docs/EXTENSION_PROTOCOL.generated.md` (drift-checked in CI); Go SDK in `sdk/go`. Code extensions are **full trust** (`docs/EXTENSIONS.md`).
- **Skills** — `internal/ext/skill` (Markdown discovery; `runAs: subagent` profiles), `skilllock`, `skillupdate`, `builtincontent/reasonix-guide`.
- **Commands/hooks/rules/themes/market** — `internal/ext/{command,hook,rules,theme,market,installsource,pluginpkg,pluginspec,modhost}`.

### 5.9 Permissions, approvals and sandboxing

- **`internal/safety/permission`** — `Policy` (pure) + `Gate`: `Decision ∈ {Allow, Ask, Deny}`, precedence `deny > ask > allow > fallback` (fallback `Allow` for read-only, `Mode` for writers). Rule syntax `Tool(specifier)` (`Bash(npm run build)`, `Bash(go test:*)`, `Edit(docs/**)`, exact `Bash=<literal>`). Dynamic/nested bash (substitution, eval, `-c`, parse failures) needs a human in Ask/Auto; only exact grants or YOLO bypass. `allow_dynamic_bash` opt-in.
- **Approvals** — `internal/session/control/approval*.go` (bridge, orchestration, scope, session persistence). Postures `ask`/`auto`/`yolo`; approved-plan execution window; `Ask` questions; hooks and extension `ask`.
- **`internal/safety/sandbox`** — three independent protection **dimensions**: Integrity (write roots), Confidentiality (`ForbidReadRoots`), Authority (`HostAuthorities`). Backends: macOS Seatbelt, Linux bubblewrap (both default-on when available; fail-closed otherwise), Windows write-restricted token (creation only). Windows has **no** bash sandbox (`bash = "off"`); bash runs unconfined on Windows, while the in-process file tools still enforce `workspace_root`, `allow_write` and `forbid_read`. Bash is jailed by default on macOS/Linux (`bash = "enforce"`), confined to the same write roots plus command temp/cache roots, denied reads under `forbid_read`, and allowed network only when `network = true`.
- **Trust domain** (REASONIX.md): `VerificationRelevant`, `Observable`, `HostProtected`, invariant `Writable ∩ VerificationRelevant ⊆ Observable ∪ HostProtected`. Observation (`scanWorkspace`) is `complete` only below 50k files; symlinks recorded by `Lstat`; Windows bounds file *creation* only.
- **Trusted Host State / Trusted Execution** (`internal/state/trustedstate`, `internal/runtime/contract`, `docs/design/TRUSTED_EXECUTION.md`): host-owned, content-addressed, hash-chained records for Task Contracts, Evidence Bundles and Capability Rollout; integrity levels `host_protected` vs `tamper_evident_only`.
- **Project-config safety** (`SECURITY.md`): workspace files (`reasonix.toml`, `.reasonix/settings.json`, `.mcp.json`, project `.env`) are untrusted and may only *narrow* the user's config, never widen it. Programs a workspace names (hooks, LSP, `rg_path`, `shell.path`, browser, laya python) stay off until `reasonix trust` approves them for that folder, keyed on a digest of the declaration and named files.

### 5.10 Authentication / identity

- **Serve auth** — `internal/frontend/serve/auth.go` + `internal/frontend/cli/serve_launch_token.go`: `auth_mode = token` (default, per-launch token written 0600 under `<Reasonix home>/remote/`), `password` (bcrypt via `--hash-password`), or `none` (reads open; every state-changing request still needs the launch token). Optional `behind_proxy` for trusted `X-Forwarded-*`.
- **Provider keys** — `api_key_env` names secrets; saved values live in `<Reasonix home>/.env`; OS keyring (`internal/base/secrets`, `github.com/zalando/go-keyring`); MCP OAuth client credentials/tokens stored 0600 outside the workspace.
- **Platform identity** — `internal/platform/{account,appidentity,instanceid}`; `internal/platform/remote` for SSH host-key/secret prompts via callbacks.

### 5.11 LSP / editor integration

- **`internal/platform/lsp`** — language-server process management with testdata for bash/golang/python/rust/typescript; LSP commands are trust-gated per workspace.
- **Editors** — `internal/frontend/acp` (ACP v1 NDJSON JSON-RPC 2.0) for VS Code and any ACP host; `internal/platform/editor`, `opendoc`, `openwith`; VS Code extension is external (`SivanLiu.reasonix-agent`) and starts `reasonix acp`.

### 5.12 Telemetry / observability

- `internal/platform/telemetry`, `internal/platform/otlp` (OTLP export), `internal/platform/crashreport` (fatal-dump capture installed in `main.go`), `internal/state/stats`, `internal/state/trajectory` (event stream), `internal/contract/observe`, `internal/state/usagereport`.
- Trajectories + `.run-metrics.json` are the evidence substrate for benchmarks (`reasonix run --json` / `--trajectory`).
- Workers `workers/crash-report`, `workers/accounts`, `workers/forum` receive opt-in telemetry/feedback; `internal/platform/feedback` and `internal/state/usagecatalog` feed the accounts worker.

### 5.13 Workers / subagents / delegation

- **Subagent profiles** — a Skill with `runAs: subagent` (`invocation: manual` for editor-managed profiles); explicit `/<name> <task>` and `Controller.RunSubagentProfile`. Headless: `reasonix subagent try|run`.
- **`internal/runtime/delegation`** — the five-concept split (profile / `TaskSpec` / `CapabilityGrant` / `ContextRequest`(`ContextCapsule`) / `SchedulerPolicy`); `agent.ProfileFromSkill` is the single narrowing point; `profile_boundary_test.go` fails on widening.
- **`task`/`fleet`/`parallel_tasks`/`read_only_task`** — `internal/tools/sessiontool` + `internal/runtime/scheduler`; `fleet` is a small dependency graph (`id`/`depends_on`, `<upstream-results>`, `adopt_ref`, `fail_fast`); concurrency via `agent.max_subagent_concurrency` (default 6) and `max_parallel_writers` (default 3); depth via `agent.max_subagent_depth`.
- **Child construction is one primitive** — `internal/tools/sessiontool`'s `TaskTool.RunProfileSpec`; `internal/runtime/agent/spawn_boundary_test.go` enumerates the remaining low-level callers and fails on new ones.
- **Write claims** — `internal/runtime/writeclaim` + `internal/tools/builtin/write_paths.go`: declared `write_paths` bind the child registry, are compared after symlink resolution, and are audited against recorded mutations. `internal/state/workspacelease` tracks leases/overlaps.
- **Completion adjudication** — `complete_subtask` status is a *claim*; `internal/runtime/completion` + `internal/safety/evidence` check every citation against host receipts and can only lower a status, never raise it (`internal/session/control/adjudication.go`).

---

## 6. Request lifecycle (a user turn, end to end)

1. **Input.** A frontend (`cli`/`tui`/`serve`/`acp`) hands raw text to `control.Controller.Send`. Slash commands and `@` references resolve first; MCP prompts/resources expand to text.
2. **Compose.** The controller composes the turn: stable cache prefix (system prompt + tool schemas + declared prefix config) + the turn tail (standing-instruction projection, skills index, memory projection, goal/plan blocks). Nothing mutates the prefix mid-session (`control.Compose`; `internal/assembly/boot/context_projection_test.go`).
3. **Admission & policy.** Phase opt-outs (plan mode), then the permission `Gate` and sandbox config are resolved; `ask` raises an approval event; `deny` hard-blocks.
4. **Planning (optional).** If a planner model is set, `internal/runtime/coordinator` + `taskpolicy` route executor-only / light / full / plan-for-approval / plan-only. Approval opens the `approvedPlanAutoApproveTools` window.
5. **Model call.** `provider.Stream` returns `<-chan Chunk`; text deltas stream live; tool-call deltas accumulate by index and emit complete.
6. **Tool execution.** Each call is permission-gated, sandboxed, dispatched (built-in, plugin `mcp__server__tool`, or `usecap` proxy). Results append; tool errors feed back, never fatal. Read-only calls may batch; `serial` MCP servers serialize.
7. **Progress / budgets.** An adaptive progress lease renews only on genuine progress. After 8 no-progress rounds a one-shot reassessment nudge; in Goal mode a re-plan. Token/wall/triage/websearch budgets are scoped per root run and inherited.
8. **Loop** until the model stops calling tools (or `maxSteps`/budget/Goal completion/3x repeated blocked state).
9. **Completion.** `internal/runtime/completion` builds a host-authored report; sub-agent claims are adjudicated by `internal/safety/evidence`; contract/report/receipts seal as a shadow bundle in THS (`internal/state/trustedstate`).
10. **Persistence.** Transcript appends to `internal/state/sessionstore`; a rare compaction checkpoint may install past the trigger; `internal/state/checkpoint` snapshots allow rewind by turn.

---

## 7. Notable and unusual engineering choices

- **One Controller behind every frontend.** Four UIs share one transport-agnostic orchestration layer; `frontend-parity` (repolint) counts capability edges per frontend and fails a missing one.
- **Cache-first as product behavior.** The system-prompt prefix is byte-stable; dynamic state is projected onto the turn tail. A cache-guard test runs in CI (`REASONIX_RELEASE_CACHE_GUARD=1`).
- **Two-model collaboration without shared sessions.** Planner and executor run in separate, prepend-only sessions so neither prefix is disturbed.
- **Judgements read structure, never wording.** Shell ASTs (`shellparse`), types, contracts and tool schemas; phrase tables and message sniffing are retired. Errors carry identity (sentinels, dotted codes via `refuse`), never sentences.
- **Enforced by a bespoke ratchet linter (`tools/repolint`):** `layering`, `layer-order`, `file-size` (800), `function-size`, `complexity`, `struct-state`, `window-state`, `essay`/`banner`/`marker`/`commented-code`/`narrative`, `refusal-path`, `error-text`, `claude-dialect`, `wire-parity`, `frontend-parity`, `orphan`, `codeowners`, `doc-owner`/`doc-prose`/`doc-language`, `release-note`, `css-important`/`css-size`, `stray-file`, `build-artifact`. Debt lives in `baseline.json` and may only go down.
- **Sensitive-path coverage gate.** `REASONIX.md` declares `sensitive:` paths; `tools/covergate` holds each to its existing test coverage.
- **Vendor price table is append-only** (`internal/contract/pricing/rates.go`); `tools/pricecheck` compares it to vendor pages (network; run manually).
- **A metric is its definition.** Benchmarks require four lines (counts what, from which anchor, over which population, excluding what) before a number is a finding; defects require a reachability contract.
- **Effect tests at the real boundary.** Performance features must assert what reaches the provider request, frontend sink, or trajectory through the real `boot.Build` (`internal/assembly/boot/effect_test.go`).
- **`@path` existence is the disambiguator** for chat references; `@` autocomplete descends one directory level at a time.
- **Single static CGO-free binary**; cross-compile `darwin|linux|windows × amd64|arm64` with `make cross`.
- **Doc standard with teeth.** Every doc needs an owner header; `repolint` enforces header, 320-col prose width and English (release notes are the one sanctioned Chinese exception).


---

## 8. Features: UNIQUE vs COMMON

### 8.1 Uncommon / distinctive

- **Single shared Controller for four frontends** with a repolint-enforced parity ratchet (edge counting via `go/types`).
- **Cache-first architecture elevated to a product guarantee**, with a live cache-guard test in CI and a documented 