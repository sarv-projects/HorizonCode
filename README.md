# HorizonCode (`hzcode`)

[![ci](https://github.com/sarv-projects/HorizonCode/actions/workflows/ci.yml/badge.svg)](https://github.com/sarv-projects/HorizonCode/actions/workflows/ci.yml)

A terminal coding agent that separates what the model proposes from what is allowed to happen, and records every admitted action in a hash-chained log with receipts.

The model can request an action; a Rust trust kernel decides whether it runs (`deny > lease > ask > allow`) and settles each admitted action into a receipt in a tamper-evident event log. The runtime is TypeScript on Bun with no runtime dependencies. The terminal UI is scrollback-native: finished output goes into your terminal's own history, and only the prompt and the running turn are redrawn.

> **Status: pre-release.** Nothing is published or packaged; you build from source. The version is `0.1.0`. The kernel is primarily a decision/audit layer; Linux children can optionally be wrapped by `hz-sandbox-exec` (seccomp/rlimits/netns/Landlock when the host allows). There is no EffectHost and no MITM egress proxy. See [Status and limitations](#status-and-limitations).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install](#install)
- [Quickstart](#quickstart)
- [Providers and configuration](#providers-and-configuration)
- [Slash commands](#slash-commands)
- [Permission modes](#permission-modes)
- [Project instructions](#project-instructions)
- [Agent profiles](#agent-profiles)
- [Performance](#performance)
- [Testing and CI](#testing-and-ci)
- [Status and limitations](#status-and-limitations)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Licence](#licence)

## Features

Every item below is in this tree (pull requests #1 to #28, all merged into `main`) and covered by automated tests. Items that are partial, opt-in or off by default say so.

**Safety and evidence**

- **Kernel-admitted actions**: every file write, shell command and network request is authorised by the Rust kernel before it runs and settles into a receipt.
- **Tamper-evident log**: events and receipts are hash-chained, verifiable by `log.verify` and `receipt.verify`, and optionally anchored with an HMAC key (`HZ_ANCHOR_KEY`); without that key, someone who can write the files can rewrite the whole chain.
- **Policy file**: `policy.json` rules, one-use leases, a structural deny on the kernel's own state directory, and fail-closed loading of malformed policy.
- **Command allowlist and egress decider (admission only)**: a per-origin network decider and a command allowlist feed the same guard; nothing intercepts traffic or confines a process.
- **Permission modes**: `default`, `plan`, `accept-edits` and `read-only` sit above the guard, a kernel deny always wins, and there is deliberately no bypass mode.
- **Guardian line (advisory)**: approval prompts show a `guardian: flag` line for risky requests; it blocks only when `HORIZON_GUARDIAN=enforce` is set.
- **Per-line shell approval**: the interactive `shell_session` tool admits every complete input line as its own `shell.exec` and shows the line verbatim in the prompt.

**Agent loop**

- **Loop safety rails**: step, token and wall-clock budgets, repeated-tool and loop detection, a mistake tracker, and a corrective for malformed tool calls; each stop is a named exit code.
- **Parallel tool batches**: calls are classed shared or exclusive and scheduled with per-call leases.
- **Checkpoints and rewind**: file checkpoints after each turn, `/rewind` restores files, and server `session.rewind` rewinds the conversation.
- **Session fork**: `/fork` branches a chat into a new session with lineage, leaving the original untouched.
- **Agent profiles**: `explore`, `plan`, `code` and `review` subagent presets, plus user presets, always bounded by the parent's tools.
- **Crash recovery**: sessions live in SQLite and survive restarts; resume with `--continue` or `--resume <id>`.
- **Cross-process locking**: lockfiles with stale-owner reclaim guard sessions, checkpoints, the change journal and per-file writes.

**Tools** (18 registered; `/files` lists them)

- **Edit ladder**: exact, relative-indent, unicode-fold, three-way and line-patch matching, each applied only when the match is unique and CRLF-safe.
- **`apply_patch`**: the patch format GPT-style models emit, routed by model so each model sees one coherent edit tool set.
- **Hashline anchors (opt-in)**: `read` can print `LINE:hash` anchors and `edit` can target them, recovering a unique shift of up to 15 lines.
- **AST tools**: `ast_search` and `ast_edit` use an in-tree structural matcher.
- **Interactive PTY**: `shell_session` runs a long-lived terminal program for the model.
- **Language server loop (default off)**: the `lsp` tool and a diagnostics ledger run only for servers you configure.
- **`tool_search` and `turn.diff`**: rarely used tools are deferred until the model asks for them, and each turn reports a diff of what it changed.
- **Code mode**: a JavaScript subprocess calls tools over a bridge; each call is still admitted individually.
- **MCP client**: stdio servers declared in user config only; a workspace file cannot add one.
- **Repo map**: a ranked structural map of the repository.
- **Tolerant tool arguments**: malformed tool-call JSON is repaired when the repair is syntax-only and refused for side-effecting tools when the arguments were truncated.
- **Skills and custom commands**: `SKILL.md` folders with resources (plus read-only `~/.claude/skills` and `~/.agents/skills` sources), a built-in `execute-plan` skill for `.hz/plans/` files, and markdown prompt templates as slash commands.
- **Structured compaction**: older turns are summarised with files touched (last operation), commands run (secret-like values masked) and todo changes.

**Interfaces**

- **Scrollback-native TUI**: a chat bar with streaming output, tool cards, colour ladder, markdown rendering, a single-key bordered approval card (`y`/`n`/`a`, Enter/Esc deny; paste and type-ahead can never approve), bracketed paste, diff gutters, collapsed reasoning (`/think`), Tab completion with ghost text for `/commands` and `@paths`, and `/theme`; there is no fullscreen mode.
- **Install and config checks**: `hzcode doctor` (diagnose-only), `hzcode config check` (keys the loader ignores) and `hzcode commit` (a commit message drafted from the staged diff, committed through the guarded shell path).
- **Headless mode**: `hzcode -p` prints one turn as `text`, `json` or `stream-json` with canonical exit codes; approvals fail closed.
- **Server mode (single client)**: `hzcode serve` speaks NDJSON JSON-RPC on stdio with `session.create`, `list`, `subscribe`, `prompt`, `rewind` and `fork`.
- **Hooks**: lifecycle hooks read from `hooks.json`; a malformed file refuses to run hooks rather than silently skipping them.
- **Project instructions**: `AGENTS.md`, `CLAUDE.md` and other tools' rule files load as peers, with lazy nested loading; `/memory` and `/init` manage them.

**Providers**

- **Provider adapters**: Anthropic, OpenAI, Google, Ollama, any OpenAI-compatible endpoint, and an offline mock; an unknown provider id fails loud instead of falling back.
- **User provider registry**: endpoints are declared as data in `config.json`, not code.

## How it works

```
  user / script / client
          |
          v
  +--------------------------+   proposes tool calls
  |  TypeScript on Bun       | <---------------------- model provider
  |  agent loop, tools, TUI, |   (Anthropic, OpenAI, Google,
  |  sessions, hooks, server |    Ollama, OpenAI-compatible)
  +------------+-------------+
               |  NDJSON over stdio:  guard.check / record / verify ...
               v
  +--------------------------+
  |  hz-kernel (Rust)        |  deny > lease > ask > allow
  |  guard, leases, policy,  |  admit or refuse every effect
  |  hash-chained event log, |
  |  receipts, anchors       |
  +------------+-------------+
               |  admitted effect, then a receipt
               v
       files, processes, network        state: <workspace>/.hz/state/
```

The runtime asks the kernel to authorise each effect. If the kernel says `ask`, the TUI shows a prompt (`y`, `n`, `a`); an `always` answer becomes a time-limited lease that names the exact target. After the effect runs, a receipt is appended to the chain. The two sides share a frozen contract (`app/src/contracts.ts`), and event and receipt hashes are byte-identical between the Rust and TypeScript implementations.

The runtime reports its kernel mode on startup. In `trusted` mode the Rust kernel is running. In `untrusted` mode, used when the kernel binary is absent, a byte-compatible TypeScript fallback decides instead; the guarantees are weaker because the decider shares a process with the agent.

## Install

HorizonCode is not packaged. Build from source.

Requirements: [Bun](https://bun.sh) (developed with 1.2.14) and a Rust toolchain (developed with 1.92.0) for the kernel. Linux x86_64 is the tested platform.

```bash
git clone https://github.com/sarv-projects/HorizonCode.git
cd HorizonCode
(cd kernel && cargo build --release --locked)   # builds kernel/target/release/hz-kernel
(cd app && bun install)                          # dev type definitions only
./bin/hzcode --version
```

`bin/hzcode` is a launcher for `app/src/main.ts`. Put the `bin` directory on your `PATH` to run `hzcode` from anywhere. Without the kernel build the runtime starts in `untrusted` mode.

## Quickstart

```bash
./bin/hzcode                          # chat bar; offline mock model unless a provider is configured
./bin/hzcode --mock                   # force the offline mock model
./bin/hzcode -p "list files" --mock --output-format json
./bin/hzcode -p "summarise this repo" --permission-mode read-only
./bin/hzcode --continue               # resume the last session
./bin/hzcode serve                    # single-client NDJSON JSON-RPC on stdio
./bin/hzcode doctor                   # check this install: OK/WARN/FAIL with a fix per problem
./bin/hzcode config check             # report config keys the loader would silently ignore
./bin/hzcode commit --preview         # draft a commit message from the staged diff (no commit)
```

The mock model needs no key and exercises the whole path: tool call, guard, receipt. A JSON turn looks like this:

```json
{"type":"result","result":"...","sessionId":"...","exit":{"terminal":"succeeded","code":0,"detail":"turn_end"},"usage":{"model":"mock-1",...},"toolCalls":1,"changedFiles":[]}
```

Every run writes receipts and the event log under `<workspace>/.hz/state/kernel/` (a workspace that already has `.hzcode/` keeps using it).

Piped input without `-p` runs headless, one message per line. `hzcode serve` answers `server.hello` first:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"server.hello","params":{}}\n' | ./bin/hzcode serve
```

`hzcode doctor` is diagnose-only. It checks the Bun version, the kernel binary and its `--selftest`, trusted or untrusted kernel mode, the config file, the provider, key presence (the key itself is never printed) and model, workspace and state-directory permissions, git, and the terminal (TTY, colour level, UTF-8 locale, `NO_COLOR`). It prints one line per check with a `fix:` line under every WARN or FAIL, and exits 1 if anything FAILs. `--json` gives the same report as JSON, suitable for a support ticket. `--fix <check>` prints read-only export hints for one check (for example `hzcode doctor --fix effect.host` suggests `HZ_EFFECT_HOST_KERNEL=default` for prototype kernel-routed mutations and `=require` as the fail-closed honesty gate). Its only filesystem touch is the kernel selftest's scratch directory under the OS temp dir, removed afterwards.

Prototype EffectHost routing: `HZ_EFFECT_HOST_KERNEL=default` routes eligible `write` / `edit` / argv-only `shell` / reduced `apply_patch` / literal `ast_edit` through the kernel like `=1`, falling back to Bun when ineligible (does not silently change production defaults). `HZ_EFFECT_HOST_KERNEL=require` refuses Bun-owned mutations that cannot kernel-route.

Other flags: `--workspace <path>`, `--model <name>`, `--max-steps <n>`, `--max-tokens <n>`, `--max-wall-ms <n>` (0 means unlimited). `hzcode --help` prints the full list.

## Providers and configuration

Configuration is resolved in this order: environment variables, then `~/.config/horizon/config.json`, then detection from provider keys, then the mock. An existing `~/.hzcode/config.json` is still honoured.

| Setting | Environment | `config.json` key |
|---|---|---|
| Provider | `HZ_PROVIDER` (`anthropic`, `openai`, `google`, `ollama`, `mock`, or a registry id) | `provider` |
| Model | `HZ_MODEL` | `model` |
| API key | `HZ_API_KEY`, or `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `apiKey` |
| Base URL | `HZ_BASE_URL` | `baseUrl` |
| Budgets | `HZ_MAX_STEPS`, `HZ_MAX_TOKENS`, `HZ_MAX_WALL_MS` | none |

If `HZ_PROVIDER` and the config file name no provider, a vendor key variable selects one (checked in the order Anthropic, OpenAI, Google). Ollama needs no key.

**Any OpenAI-compatible endpoint** is declared in the user config as data. Only the user config is read for this; a workspace file cannot register a provider.

```json
{
  "provider": "my-gateway",
  "providers": [
    {
      "id": "my-gateway",
      "baseUrl": "https://llm.example.com/v1",
      "envKey": "MY_GATEWAY_KEY",
      "models": ["my-model"]
    }
  ]
}
```

An `id` must match `[a-z0-9-]` and must not collide with a built-in. An entry may carry `apiKey` or `envKey`; with neither, it is treated as keyless (a local vLLM server, for example). `protocol` is `openai-chat`, the only value in v1. A malformed entry is skipped with a notice rather than stopping startup. A registered provider with no model fails with a readable error instead of sending a placeholder id.

Other user-config files: `policy.json` (kernel rules), `hooks.json`, `agents/*.md` (profiles), and `mcp` / `lsp` sections in `config.json`. Workspace files can narrow these but not widen them.

## Slash commands

These are the commands in the chat bar, as printed by `/help`.

| Command | Description |
|---|---|
| `/help` | this list |
| `/new` | start a fresh session |
| `/model [name]` | show or switch the model |
| `/files` | tools the assistant can use |
| `/context` | what the next request will carry |
| `/plan [on\|off]` | toggle plan mode (writes are staged) |
| `/mode [name]` | show or set the permission mode: default, plan, accept-edits, read-only |
| `/changes` | review staged changes and diffs |
| `/apply` | write the staged changes |
| `/discard` | drop the staged changes |
| `/fork [n]` | branch this chat into a new session (n = checkpoint number, else everything so far) |
| `/sessions` | recent sessions with fork lineage (resume a fork with `hzcode --resume <id>`) |
| `/rename <title>` | retitle this session |
| `/retry` | drop the last reply and ask the same question again |
| `/theme [name]` | dark, light, auto or mono (`NO_COLOR` is always respected) |
| `/think` | show the last reasoning block (rich mode) |
| `/stats` | message, tool call and token counts for this chat |
| `/export [json\|html]` | write the chat to `.hz/exports` (html shows the receipt chain status; secret-like values are masked) |
| `/copy` | copy the last answer to the clipboard (terminal OSC 52) |
| `/rewind [n]` | list checkpoints; n restores the files changed since one |
| `/memory` | which instruction files (AGENTS.md, CLAUDE.md, ...) are loaded (alias `/instructions`) |
| `/init` | draft an AGENTS.md for this repo (staged; you review it, then `/apply`) |
| `/exit` | leave (Ctrl+D also works) |

Prompt templates in `<workspace>/.hz/commands/*.md` (or `~/.config/horizon/commands/`) add custom `/name args` commands; they are listed under `/help`, can also run as `hzcode run <name> [args]`, and never shadow a built-in. Tab completes `/commands` and `@paths`. Ctrl+C stops the current answer (again to leave), Ctrl+D leaves, and the up and down arrows recall earlier messages.

Plan mode stages every write instead of performing it. `/changes` shows the staged diffs, `/apply` writes them, `/discard` drops them.

## Permission modes

Set with `--permission-mode <mode>`, `/mode <mode>`, or `permissionMode` in the user config. Workspace files cannot change it.

| Mode | Behaviour |
|---|---|
| `default` | the guard decides and you answer the asks |
| `plan` | writes are staged for review with `/changes` and `/apply` |
| `accept-edits` | in-workspace write and edit asks are answered yes, except CI, hook, manifest and shell-rc files; shell and everything else still ask |
| `read-only` | every write, shell command and MCP tool call is refused before it can reach the guard |

A kernel deny always wins over a mode. There is no bypass mode: it would also answer network, spawn, MCP and shell asks, leaving only the deny list.

## Project instructions

These files load as peers: `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `CONVENTIONS.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/*.mdc` (only `alwaysApply: true`) and `.windsurfrules`.

Precedence runs from least to most specific, and later wins: user `~/.config/horizon/`, then the repository root down to the working directory, then `.hz/AGENTS.md` and local overrides. Your own messages win over every file. A nested `AGENTS.md` or `CLAUDE.md` below the working directory loads when a tool touches a file under it.

Files are capped at 32 KB each and 128 KB in total, symlink escapes are refused, and the files are treated as conventions, never as permissions. `/memory` shows what is loaded; `/init` drafts an `AGENTS.md` for review.

## Agent profiles

The `agent` tool delegates a task to a subagent. A `profile` selects a preset. A profile can only narrow the parent's tool set, and the kernel guard still decides every effect a subagent attempts.

| Profile | Modifies files | Tools | Step cap | Returns |
|---|---|---|---|---|
| `explore` | no | `read`, `grep`, `glob`, `repo_map`, `ast_search`, `lsp` | 12 | concise findings with `path:line` |
| `plan` | no | same read-only set | 12 | a structured plan with steps, files and risks |
| `code` | yes | read-only set plus `write`, `edit`, `shell`, `todo`, `apply_patch`, `ast_edit`, `undo` | 20 | the result of one scoped implementation task |
| `review` | no | same read-only set | 12 | findings with `path:line` and severity |

Add your own as Markdown files with front-matter (`name`, `description`, `tools`, `model`, `max_steps`) in `~/.config/horizon/agents/` or `<workspace>/.hz/agents/`. A preset naming a tool outside the ceiling is refused and listed.

## Performance

Source line counts and the kernel binary size were re-measured on 2026-11-10; the timing and memory rows were measured on 2026-11-09 and not repeated (the startup medians in the gate table below are from the same day). Environment: x86_64, 8 cores, Linux, Bun 1.2.14, Rust 1.92.0, running as root in a sandbox container. These are single-machine numbers, not a benchmark suite, and they exclude model latency.

| Metric | Value | How it was measured |
|---|---|---|
| Headless turn, mock model | 0.173 s median (range 0.164 to 0.182 s) | 10 runs of `printf 'list files\n' \| bin/hzcode` in a fresh `$HOME` and workspace; wall time of the whole process, including kernel spawn, one tool call and its receipt |
| Kernel self-test | 4 ms for 25 checks | `hz-kernel --selftest --state-dir <tmp>`, wall time |
| Kernel binary | 1,156,816 bytes (1.1 MiB) | `ls -l kernel/target/release/hz-kernel`, release profile |
| Idle memory of the chat bar | 85 MB RSS for the Bun process, plus 1 MB for the kernel child | `hzcode --mock` in a PTY, VmRSS from `/proc/<pid>/status` three seconds after the banner; 87 MB after running `/help`, `/files`, `/mode`, `/memory`, `/rewind` and `/sessions` |
| TypeScript source | 40,813 lines | all `*.ts` under `app/src` (tests live in `app/tests`), comments and blank lines included |
| Rust source | 4,256 lines before inline unit tests (7,070 with them) | `kernel/src/*.rs`, counting up to the first `#[cfg(test)]` in each file for the first figure; re-counted 2026-11-10 |
| Runtime dependencies | 0 | `app/package.json` has only `devDependencies` (type definitions and the TypeScript compiler) |

No comparison with other agents is made here, because none was measured on the same machine with the same model.

## Testing and CI

The eight gates run through one entry point, `bash ops/gates.sh`, which CI also calls:

| Gate | What it checks |
|---|---|
| `rust-kernel-suite` | `cargo test --locked` |
| `kernel-selftest` | `hz-kernel --selftest` |
| `ts-typecheck` | `tsc --noEmit` over the app |
| `ts-suite` | `bun test` |
| `e2e-headless-smoke` | a mock turn end to end with receipts |
| `e2e-budget-rail` | the step budget stops a run with its exit code |
| `e2e-usage-error` | a bad flag exits with the usage error |
| `startup-latency` | median of 5 runs of `hzcode --version` (500 ms ceiling) and of a mock turn (1000 ms ceiling); measured medians are 96 ms and 198 ms |

Results from a run on 2026-11-10 on this tree (as root in a sandbox container):

- `cd kernel && cargo build --release --locked && cargo test --locked`: 49 unit tests and 50 integration tests pass.
- `hz-kernel --selftest`: `SELFTEST OK (25 checks)`.
- `cd app && bun run typecheck && bun test`: typecheck 0 errors; ~1,900 tests in ~185 files; ~1,892 pass, 8 skip, 0 fail (re-measure on your tree).
- `bash ops/gates.sh`: all 8 gates pass (to be re-run at release).

The 8 skips are chmod-based tests that cannot bind when the process runs as root, so they skip by design; the run above was as root. The same suite also runs on hosted CI as a non-root user, where they execute.

The hosted workflow is [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). The e2e gates pin the provider to `mock` under a throwaway `HOME`, so CI uses no keys and no model network access.

## Status and limitations

Pre-release and single-platform. Read this before relying on it.

- **OS sandboxing (partial).** Optional `hz-sandbox-exec` can apply seccomp/rlimits/userns+netns/Landlock FS to shell/code_mode children when the helper is built and the host canary succeeds; macOS/Windows and MITM egress remain open. `hzcode doctor` / `ops/landlock-probe.sh` report host capability separately from enforcement.
- **Not released.** There is no package, installer, signed binary or auto-update. Build from source.
- **Live providers.** Live runs have been exercised only against an OpenAI-compatible endpoint (NVIDIA NIM). The Anthropic, OpenAI, Google and Ollama adapters are covered by tests against recorded and mock streams, not by live runs against those vendors.

| Quality check | Provider / model | Date | Result |
|---|---|---|---|
| Tool hygiene evals (key-free) | `scripted` | 2026-11-10 | 8/8 pass (`tests/core/hygiene-evals.test.ts`) |
| NVIDIA NIM connection smoke | `ops/nvidia-smoke.sh` | 2026-11-11 | pass models list with repo `.env` (CRLF-safe) |
| NVIDIA NIM models API | `integrate.api.nvidia.com` | 2026-11-11 | pass (`tests/providers/nvidia-live.test.ts` with `NVIDIA_API_KEY`; lists 100+ model ids) |
| NVIDIA NIM chat turn | `minimaxai/minimax-m3.1-flash` + repo `.env` key | 2026-11-11 | **pass** (`ops/nvidia-chat-probe.sh` HTTP 200; headless `hzcode -p`); default `.env` `HZ_MODEL` still **410 EOL** — point at a deployed id |
| models.dev catalog snapshot | committed `models-dev.curated.json` + optional user cache | 2026-11-12 | third-party metadata — see `NOTICE`; refresh via `hzcode models refresh`; optional poll `HZ_MODELS_POLL_MS` |
| Landlock host probe | `ops/landlock-probe.sh` | 2026-11-11 | pass exit 0\|3 (`tests/ops/landlock-probe.test.ts`; probe reports host capability — enforcement is via `hz-sandbox-exec`) |
| TUI `/model` + `/models` | mock + NVIDIA catalog ids | 2026-11-11 | pass (`pty.test.ts`, `list-models.test.ts`, `models-slash.test.ts`; live `/model <id>` on 2026-11-09 in `CURRENT_RUN` §5.0.2 item 9) |
| Memory FTS recall | deferred `memory_search` | 2026-11-11 | pass (`memory-store.test.ts`, `memory-search.test.ts`) |

- **No benchmarks.** Same-model head-to-head comparisons have not been run. No ranking or token-efficiency claim is made.
- **Platforms.** Linux x86_64 is the only tested platform. macOS and Windows are untested.
- **Not wired by default.** Speculative execution exists as code and tests but is off, and a test pins it inert. The guardian is advisory unless `HORIZON_GUARDIAN=enforce`. The language server loop is off until you configure a server. Hashline anchors are opt-in.
- **Partial.** Per-model tool dialects beyond `apply_patch` (the routing table exists, one dialect ships). The server accepts one client over stdio; there is no socket, TCP or HTTP transport and no SDK. Workspace trust loads hooks, skills, agent presets, **MCP** and **providers** when listed in `trustedWorkspaceHooks` and digests match `trust.json` (see `docs/33` §6.2).
- **Not started.** Alternate-screen fullscreen TUI renderer (cell buffer + layout); MITM or routed egress proxy (egress decisions are recorded, nothing intercepts traffic); EffectHost / independent receipt postimage; same-model benchmarks.
- **Partial.** Scrollback TUI only; `HZ_TUI_MODE=fullscreen` / `--fullscreen` fail closed (ruling **129**). Linux OS confinement via `hz-sandbox-exec` (Landlock/seccomp/netns/rlimits when host canary allows; macOS/Windows open). Deferred **`debug`** tool (DAP launch/step/attach slices; live dlv/js-debug e2e open). Deferred **`memory_search`** (FTS5 + `MEMORY.md` + dream plan; embeddings/auto-apply open).
- **Tamper-evident, not tamper-proof.** See Features. In `untrusted` mode the guarantees are weaker still.

The authoritative status table is `CURRENT_RUN.md` §5.0, and the implemented-versus-designed map is [`docs/28-implementation-status.md`](./docs/28-implementation-status.md). Many capabilities described in `docs/` (web and desktop apps, IDE bridge, SDKs, plugin marketplace, collaboration, voice) are designs, not shipped code.

## Documentation

**Coding agents:** [`AGENTS.md`](./AGENTS.md) first (onboarding + docs≠complete-tree rule). Then [`docs/FULL-BACKLOG-2026-11-13.md`](./docs/FULL-BACKLOG-2026-11-13.md) and [`docs/33-handoff.md`](./docs/33-handoff.md). Spec index: [`docs/00-index.md`](./docs/00-index.md).

| Read | For |
|---|---|
| [`docs/FULL-BACKLOG-2026-11-13.md`](./docs/FULL-BACKLOG-2026-11-13.md) | **The backlog** (queue + §Z what to do first + P0 bars) |
| [`docs/AGENT-DOC-NAVIGATION.md`](./docs/AGENT-DOC-NAVIGATION.md) | `repo_take/` + code paths (optional detail) |
| [`docs/GOAL-PROGRESS.md`](./docs/GOAL-PROGRESS.md) | honest goal status (NOT COMPLETE) and wave residuals |
| [`docs/28-implementation-status.md`](./docs/28-implementation-status.md) | what is implemented, with evidence commands |
| [`CURRENT_RUN.md`](./CURRENT_RUN.md) | current state, open work and exact continuation steps |
| [`docs/research/README.md`](./docs/research/README.md) | the upstream research notes and the pinned upstream commits ([`upstream-pins.md`](./docs/research/upstream-pins.md)) behind the steal list |
| [`docs/30-steal-list.md`](./docs/30-steal-list.md) | every borrowed idea with its upstream URL, status and what is deferred |
| [`docs/33-handoff.md`](./docs/33-handoff.md) | hand-off for a new maintainer or coding agent: repo map, commands, invariants, PR history, the full deferred backlog with upstream links |
| [`docs/11-authority-safety.md`](./docs/11-authority-safety.md) | threat model, guard, leases, receipts |
| [`docs/09-tools.md`](./docs/09-tools.md) | the tool catalogue (designed superset; `/files` shows what is registered) |
| [`docs/13-tui.md`](./docs/13-tui.md) | the terminal UI |
| [`docs/14-surfaces.md`](./docs/14-surfaces.md) | headless, server and other surfaces |
| [`docs/03-hld.md`](./docs/03-hld.md) | high-level architecture |
| [`docs/31-design-summary.md`](./docs/31-design-summary.md) | the designed capability list (the former long README) |
| [`AUDIT.md`](./AUDIT.md), [`docs/29-final-audit.md`](./docs/29-final-audit.md) | audits of the design set |

## Contributing

Run the gates before sending a change:

```bash
(cd kernel && cargo build --release --locked && cargo test --locked)
(cd app && bun install && bun test)
bash ops/gates.sh
git checkout -- app/bun.lock   # bun install may rewrite the lockfile
```

Claims in documentation should cite a command that produces them; `docs/28-implementation-status.md` shows the convention. The interface shared by both runtimes is `app/src/contracts.ts`; change it in both implementations together. There is no separate contributing guide or security policy yet.

## Licence

Not yet chosen. The repository has no `LICENSE` file, so no licence is granted until one is added. See `docs/LICENSE-STATUS.md` for the honest status ladder; third-party attribution rows live in `NOTICE` (hygiene only, not a grant of rights). `hzcode doctor` reports `repo.license`.
