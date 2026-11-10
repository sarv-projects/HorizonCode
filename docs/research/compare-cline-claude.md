# Strict comparison: cline and Claude Code vs HorizonCode (follow-up deep-read pass)

> **Phase 1, research only.** No repo was modified, nothing built or tested. This is the strict follow-up pass to `docs/30-steal-list.md` §5 (merged via PR #1). Scope: **cline** (`cline/cline`) and **Claude Code** (`anthropics/claude-code`), EXCEPT the provider/catalog/auth surface another parallel agent owns (opencode/models.dev) - captured here only as "registry SHAPE" notes. Every claim cites an exact path. Classifications per subsystem: **COMMON** (≥2 external sources agree; merge once), **UNIQUE** (only this source; absorb), **ALREADY-IN-HORIZONCODE**, **MISSING** (neither external nor HorizonCode has it; build, don't steal).
>
> Clones (latest, this session):
> - cline `5413dc1` (2026-11-09). Reusable agent core at `sdk/packages/core/src`; the stateless loop + hook taxonomy live one layer down in `sdk/packages/agents/src`; shared contracts in `sdk/packages/shared/src`.
> - Claude Code `0ed9469` (2026-11-06). **Provenance: ships DOCS + SDK typings + `mods/` hook packs + `examples/` + plugin marketplace manifest ONLY - there is NO agent source.** Architecture is read from `mods/*/hooks/*.ts` (which import `from 'claude-code'` typings), `examples/`, [`.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/.claude-plugin/marketplace.json), and `CHANGELOG.md`.
>
> HorizonCode grounding (read this pass): `app/src/contracts.ts` (LAW, 419 lines), `app/src/core/hooks.ts` (the reduced hook engine), `app/src/core/loop.ts` (`MAX_PROVIDER_CALLS=25`, `MAX_CONSECUTIVE_FORMAT_ERRORS=3`, `concurrencyClassOf`, `batchSegments`, `admissionFor`), `app/src/core/plan.ts`, `app/src/tools/agent.ts`, `app/src/main.ts` (headless), `app/src/tui/interactive.ts` (slash commands), plus `kernel/src/guard.rs`/`permm.rs` (via contracts).

---

## 0. One-paragraph orientation

**cline** is the pragmatic, portable TS reference: a 7-callback hook bag (`beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent`), two tiny copy-whole safety trackers (loop-detection, mistake-tracker), a dependency-free shell command-guard, a full GPT-5 `apply_patch` parser with a graded fuzz ladder, declarative model→tool routing, tool presets per mode (act/plan/search/minimal/yolo), a multi-agent "team"/spawn subsystem, session forking + checkpoints, a cron scheduler, and a plugin/skill/workflow **slash-command** resolver. **Claude Code** is the extensibility/authority reference and, uniquely, exposes a far richer model than its own published docs admit: the `mods/` packs reveal a **tiered middleware hook engine** with ~40 interceptable dotted events (`tool.*`, `session.*`, `prompt.*`, `command.*`, `agent.*`, `env.*`, `fs.*`, `turn.*`, …), a capability-injection bag `$` (24 capabilities: `$.ui`, `$.session`, `$.tool`, `$.fs`, `$.settings`, `$.telemetry`, `$.http`, …), org/user tier precedence (`next.origin.tier`, `next.to(e,'append')`), fail-closed `.catch()` handlers, and a plugin **marketplace** of 12 official plugins. HorizonCode already owns the hard safety core (kernel guard, receipts, NF-073 rails, NF-072 concurrency classes, hooks engine in reduced form) but is **missing** the extensibility breadth: its hook engine is 2 points not 16+, its headless mode is plain-text-per-line not a JSON protocol, and its subagent/slash surfaces are minimal.

---

# PART A - cline (exhaustive, per-subsystem)

## A.1 Package architecture (grounded)

Four published SDK packages with a strict dependency direction ([`sdk/AGENTS.md`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/AGENTS.md)): `@cline/shared` → `@cline/llms`/`@cline/agents` → `@cline/core`. The **stateless loop + hook taxonomy** live in `@cline/agents` ([`sdk/packages/agents/src/agent-runtime.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/agents/src/agent-runtime.ts)); **stateful orchestration** (sessions, storage, config watching, default tools, plugin loading, cron, team) lives in `@cline/core` (`sdk/packages/core/src`). The VS Code extension (`apps/vscode`) is a thin host; the SDK core is the reusable brain.

Directory map of `sdk/packages/core/src` that matters here:
- [`runtime/orchestration/session-runtime-orchestrator.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts) (1702 lines) - stateful wrapper that installs hooks.
- `runtime/safety/{loop-detection.ts, mistake-tracker.ts, rules.ts}`.
- `runtime/tools/{subprocess-sandbox.ts (559), worker-sandbox.ts, tool-approval.ts (102)}`.
- [`runtime/turn-queue/pending-prompt-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts).
- `extensions/tools/{definitions.ts (1021), command-guard.ts (521), model-tool-routing.ts, presets.ts, constants.ts, schemas.ts}`.
- `extensions/tools/executors/{editor.ts, apply-patch.ts (426), apply-patch-parser.ts (520), line-endings.ts (37), bash.ts, file-read.ts, search.ts, output-limits.ts, web-fetch.ts}`.
- `extensions/tools/team/{spawn-agent-tool.ts, multi-agent.ts, delegated-agent.ts, subagent-prompts.ts, team-tools.ts, configured-agent-tool.ts}`.
- `extensions/config/{runtime-commands.ts, user-instruction-plugin.ts}`, `extensions/plugin/{plugin-registry.ts, plugin-sandbox.ts, plugin-command-origin.ts, plugin-contributions.ts}`.
- `session/{checkpoint-diff.ts, checkpoint-restore.ts, fork-metadata.ts, history-origin.ts, models/session-compaction.ts, search/session-history-search.ts, team/*}`.
- [`cron/service/schedule-command-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/service/schedule-command-service.ts), [`cron/specs/cron-spec-parser.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/specs/cron-spec-parser.ts), [`cron/store/sqlite-cron-store.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/store/sqlite-cron-store.ts).

## A.2 Hook taxonomy (the central steal) - [`sdk/packages/shared/src/agent.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/shared/src/agent.ts) L486-517, driven in [`sdk/packages/agents/src/agent-runtime.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/agents/src/agent-runtime.ts)

`AgentRuntimeHooks` is a **7-callback bag** with typed context/result shapes:

| Hook | Context type | Return type (effect) |
|---|---|---|
| `beforeRun` | `AgentRunLifecycleContext {snapshot}` | `AgentRunStartResult \| undefined` |
| `afterRun` | `… & {result: AgentRunResult}` | `void` |
| `beforeModel` | `AgentBeforeModelContext` | `AgentBeforeModelResult \| undefined` |
| `afterModel` | `AgentAfterModelContext {snapshot, assistantMessage, finishReason, requestId?}` | `AgentStopControl \| undefined` |
| `beforeTool` | `AgentBeforeToolContext {snapshot, tool, toolCall, input}` | `AgentBeforeToolResult {skip?, stop?, reason?, input?, policy?, appendContext?}` |
| `afterTool` | `AgentAfterToolContext {…, result, startedAt, endedAt, durationMs}` | `AgentAfterToolResult {stop?, reason?, result?, appendContext?}` |
| `onEvent` | `AgentRuntimeEvent` | `void` |

Two structural details the first pass did not record and that matter for HorizonCode:
1. **`beforeTool` can rewrite `input`** and attach a `policy` (`ToolPolicy`) - i.e. a hook can *narrow* a call's arguments and change its approval policy before dispatch. (HorizonCode's `hooks.ts` explicitly forbids argument rewriting - "NO ARGUMENT REWRITING".)
2. **`appendContext` injection channel**: text returned by `beforeTool`/`afterTool` is collected across hooks and appended after the iteration's tool results as a `<hook_context>` **user message** the model sees next request (comment at L440-446, L507-513). HorizonCode's reduced hook engine explicitly omits this "bounded-note / context-fragment channel (H9)".

The hooks are plugin-contributable: `AgentRuntimePlugin.setup()` returns `{tools?, hooks?}` (`agent.ts` L531-541), and `@cline/core`'s `plugin-sandbox.ts` maps a sandboxed plugin's declared `hooks?: Array<keyof AgentRuntimeHooks>` back into the bag (L163, L1054-1068). `agent-runtime.ts` L744 `registerHooks()` folds config + extension layers into a `HookBag` of arrays (L326-334).

## A.3 Safety trackers (copy-whole) - `runtime/safety/`

**Loop detection** (`loop-detection.ts`, read in full): `toolCallSignature(input)` = `JSON.stringify(sortKeys(input))` (recursive key sort; string inputs pass through; non-serializable falls back to `String`). `checkRepeatedToolCall` counts *consecutive* identical `(toolName, signature)` and returns `softWarning` at `softThreshold` (default **3**, `=== ` exact), `hardEscalation` at `hardThreshold` (default **5**, `>=`). The `LoopDetectionTracker.inspect()` returns `{kind:"ok"|"soft"|"hard", message}` with the exact messages `"Detected N consecutive identical calls to \`<tool>\`; consider trying a different approach."` (soft) / `"…; stopping to avoid a loop."` (hard). Installed as a `beforeTool` hook.

**Mistake tracker** (`mistake-tracker.ts`, read in full): per-session `consecutiveMistakes` over `MistakeReason = "api_error" | "invalid_tool_call" | "tool_execution_failed"`. `record()` increments (or jumps via `forceAtLimit`), emits a `recoverable:true` error event, and at the limit calls `onLimitReached(ctx)` → `{action:"continue", guidance?}` (resets counter, injects a recovery notice) **or** `{action:"stop", message}`. The stop message is the key resumability signal: `buildMistakeLimitStopMessage` ends with **"Session state was preserved. Send a new prompt to resume from the latest state."** Note the stop-message enum carries a 4th reason `"completion_without_submit"` beyond the 3 record reasons.

These two are distinct axes: loop-detection catches *semantic repetition* (same call 5×), mistake-tracker caps *error streaks* with a resumable stop. HorizonCode's NF-073 caps only *format* errors (`MAX_CONSECUTIVE_FORMAT_ERRORS=3`, `loop.ts` L88).

## A.4 Command-guard (plan-mode mutation detector) - [`extensions/tools/command-guard.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/command-guard.ts) (read in full, 521 lines)

A no-shell-interpreter blacklist, pure TS zero-dep. `findFileEditingCommand(command: string | StructuredCommandInput)` returns a short reason string or `undefined`. Pipeline:
- **Structured-argv path**: if input is `{command, args}` (not a string), it runs `checkTokens([command, ...args])` directly - no shell parsing, so a `">"` *argument* is literal. (First pass missed this branch.)
- **`maskNonCommandText`**: drops heredoc bodies (tracks `<<DELIM`/`<<-DELIM` with quoted/bare delimiters), blanks `$(( ))` arithmetic, backslash escapes, quoted spans (and spaces inside them so a quoted span stays one token), and `#` comments.
- **Redirect scan**: regex for `>`/`>>`/`&>` targets; `isAllowedRedirectTarget` permits `/dev/{null,stdout,stderr,tty}`, `nul:`, `/tmp/`, `/var/tmp/`, `$TMPDIR`/`${TMPDIR`, Windows `%TEMP%`/`$env:TEMP` - and **rejects any `..`** so a temp prefix can't escape.
- **Per-simple-command `checkTokens`**: skips env-assignments (`FOO=bar`), reserved words (`if then … { }`), and **wrappers** (`sudo doas env command builtin nohup time nice stdbuf timeout xargs`) with their options/numeric args. Then:
  - `BLOCKED_COMMANDS` set (POSIX `rm rmdir unlink mv cp dd touch mkdir ln chmod chown truncate shred install patch rsync mkfifo mknod` + Windows/PowerShell `del move ren md rd mklink copy xcopy robocopy new-item remove-item set-content out-file …` + PS aliases `mi ri cpi rni ac clc`).
  - `BLOCKED_SUBCOMMANDS` keyed by command: `git` (add/commit/push/reset/clean/checkout/…), node PMs (`npm pnpm yarn bun` install/add/…), `pip/pip3/pipx/uv`, `cargo`, system PMs (`apt apt-get dnf yum apk brew snap`), `gem composer go dotnet winget nuget`. With `READ_ONLY_GIT_FORMS` exceptions (`git stash list/show`, `git worktree list`, `git submodule status/summary`) and `git --help`/`-h` bypass; `git -c k=v`/`-C dir` value-skipping; classic bare `yarn` = install.
  - `python -m pip install` detection; **in-place edit flags**: `sed -i`/`gsed`, `perl -i`, `awk -i inplace`, `sort -o`, `curl -o/-O`, `wget` (unless `--spider`/`-O-`), `find -delete`, and `find -exec` which **recurses** `checkTokens` into the exec'd command (first pass missed the recursion). `tee` allowed only to tmp/`/dev/null`.
- `formatPlanModeBlockedCommandError(reason)` returns the model-facing refusal naming PLAN MODE and "put it in your plan".

## A.5 apply_patch grammar + fuzz ladder - [`executors/apply-patch-parser.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts) (read in full, 520 lines) + `apply-patch.ts`

`PATCH_MARKERS`: `*** Begin Patch` / `*** End Patch` / `*** Add File: ` / `*** Update File: ` / `*** Delete File: ` / `*** Move to: ` / `@@` / `*** End of File`. `BASH_WRAPPERS = ["%%bash","apply_patch","EOF","```"]` tolerated. `PatchParser.parse() → {patch, fuzz}`; the executor reports **"Patch applied with fuzz factor N"**.

The context matcher `findContext()` is a **graded fuzz ladder** (exact cost ranking is the steal):
1. exact canonical match → fuzz **0**
2. `trimEnd()` per line → fuzz **1**
3. `trim()` per line → fuzz **100**
4. Levenshtein similarity ≥ `0.66` → fuzz **1000** (carries the similarity back)
5. if EOF-anchored, retry from `lines.length - ctx.length`, else from `start`, adding **+10000** to the fuzz.

`canonicalize()` does `NFC` + Unicode-fold (`‐‑‒–-−`→`-`, curly/angle quotes→`"`/`'`, NBSP/narrow-NBSP→space) + unescape `\`` `\'` `\"`. Unmatched chunks become **warnings not failures** (`PatchWarning {path, chunkIndex, message: "Could not find matching context (similarity: X.XX). Chunk skipped.", context}`), with a 200-char context preview. `Add`/`Delete`/`Move` and duplicate-file detection (`Duplicate update for file`) are enforced; `Add File` requires every body line to start with `+`.

## A.6 Shared line-endings helper - [`executors/line-endings.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/line-endings.ts) (read in full, 37 lines)

`normalizeNewFileLineEndings` (CRLF for new files on Windows unless content already has `\r`), `detectLineEnding` (CRLF if `\r\n` appears *anywhere*, deliberately pulling a mixed CRLF-file-with-LF-inserts back to CRLF - cites issue #13504), `normalizeLineEndings(text, eol)`. Shared across `editor.ts`/`apply-patch.ts`. The comment ("models emit LF-only text; reads strip `\r`") is the exact conclusion opencode reached independently - strong COMMON signal.

## A.7 Model→tool routing - [`extensions/tools/model-tool-routing.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/model-tool-routing.ts) (read in full)

`ToolRoutingRule {name?, mode?: "act"|"plan"|"any", modelIdIncludes?[], providerIdIncludes?[], enableTools?[], disableTools?[]}`. `resolveToolRoutingConfig()` folds matching rules into a `Partial<DefaultToolsConfig>` of enable flags via `TOOL_NAME_TO_FLAG` (9 tools). Match is case-insensitive substring; **enable wins over disable within a rule** (disable applied first, then enable). Shipped defaults (`DEFAULT_MODEL_TOOL_ROUTING_RULES`): in `act` mode, `providerIdIncludes:["openai-native"]` and `modelIdIncludes:["codex","gpt"]` both → `enable:["apply_patch"], disable:["editor"]`. Everything else keeps `editor`.

## A.8 Tool presets per mode - [`extensions/tools/presets.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/presets.ts) (read in full) - NEW this pass

`ToolPresets` = **act / plan / search / minimal / yolo**, each a full `DefaultToolsConfig` of enable flags plus `enableSpawnAgent`/`enableAgentTeams`:
- `plan`: editor OFF, bash ON (read-only, guarded by the plan-mode command-guard hook), askQuestion ON.
- `search`: only read+search+spawn.
- `yolo`: `createToolPoliciesWithPreset("yolo")` sets `{"*":{enabled,autoApprove:true}}` for every tool (no approval).
`resolveToolPresetName({mode})` maps `plan→plan`, `yolo→yolo`, else `act`. This is a cleaner, richer version of HorizonCode's binary plan-on/off.

## A.9 Tool set + terminal/clarify tools - [`extensions/tools/definitions.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/definitions.ts) (read, 1021 lines)

Tools: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`. Key prompt-engineering surfaces (exact strings matter):
- `read_files` is **batch-first + union-tolerant** (`files`/`file_paths`/`paths`/bare/array), returns a per-path `ToolOperationResult[]` with `{query, result|error, success}` - never fails the whole call; description states the budget: `"Each read returns at most ${MAX_READ_LINES} lines / ~Nk characters; longer files report their total line count, page through them with start_line/end_line"`. `retryable:true, maxRetries:1`.
- `ask_question`: `successContext: "The user has answered the question. Continue working on their task using that answer."`; description forbids a toggle-to-Act option and says the run continues after the answer. `validateAskQuestionAnswer` rejects empty/dismissed.
- `submit_and_exit`: `lifecycle.completesRun:true`; evidence-demanding description ("submit because you have observed evidence that it does … re-read the task … run the tests … confirm from your own tool output that every required file exists").
- `search_codebase`/`run_commands`: middle-truncation budgets surfaced in the description (`MAX_SEARCH_OUTPUT_CHARS`, "narrow patterns beat broad ones").

## A.10 Subagents + teams - `extensions/tools/team/*` - NEW this pass (richer than the first-pass `agent`-only note)

cline has a full multi-agent subsystem, not a single delegate tool: `spawn-agent-tool.ts` (204), `multi-agent.ts`, `delegated-agent.ts`, `team-tools.ts`, `configured-agent-tool.ts`, `session/team/{team-child-session-manager.ts, team-session-coordinator.ts}`, [`runtime/orchestration/team-persistence-writer.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/orchestration/team-persistence-writer.ts). `subagent-prompts.ts` builds the child system prompt via `buildClineSystemPrompt` with `overridePrompt`/`rules: "# Team Teammate Role\n…"`. Presets gate it with `enableSpawnAgent`/`enableAgentTeams` per mode. This is the closest external analogue to a HorizonCode "subagent presets" capability.

## A.11 Subprocess sandbox - [`runtime/tools/subprocess-sandbox.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts) (read, 559 lines)

RPC-over-IPC child, `SANDBOX_SHUTDOWN_GRACE_MS=300` (SIGTERM→SIGKILL), idle-timeout respawn, stderr-tail capture, and the **compiled-bun launcher**: sets `BUN_BE_BUN=1` when the executable is a compiled bun binary (L309-310) so a packaged host spawns JS helpers with no node/bun install. `worker-sandbox.ts` is a worker-thread variant. Every write-capable executor enforces `restrictToCwd` (`..`-escape rejection). **No OS sandbox** (no seccomp/landlock/namespaces).

## A.12 Tool approval - [`runtime/tools/tool-approval.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/tool-approval.ts) (read in full)

`requestDesktopToolApproval` is a **file-IPC approval protocol**: writes `<sessionId>.request.<id>.json`, polls for `<sessionId>.decision.<id>.json` (200 ms, default 5-min timeout), returns `{approved, reason}`, cleans up. A portable host-agnostic approval transport.

## A.13 Session: fork + checkpoints + history search - `session/*` - NEW this pass

`fork-metadata.ts` (`forkedFromSessionId`, `forkedAt`, checkpoints), `checkpoint-diff.ts`/`checkpoint-restore.ts` (restore files to a checkpoint), `history-origin.ts`, [`search/session-history-search.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/session/search/session-history-search.ts), [`models/session-compaction.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/session/models/session-compaction.ts), atomic-file store. This is a durable session graph (fork/resume/checkpoint-restore) beyond HorizonCode's in-memory plan store + `/rewind`.

## A.14 Cron scheduler - `cron/*` - NEW this pass

[`cron/service/schedule-command-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/service/schedule-command-service.ts) + [`cron/specs/cron-spec-parser.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/specs/cron-spec-parser.ts) + [`cron/store/sqlite-cron-store.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/store/sqlite-cron-store.ts): a persisted `schedule` command surface (SQLite-backed). A scheduled-follow-up capability HorizonCode documents (NF-028/053) but does not ship.

## A.15 Slash / command surface - [`extensions/config/runtime-commands.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/config/runtime-commands.ts) (read in full) + plugin + cron

cline's slash commands are **data-driven, not a fixed table**:
- `runtime-commands.ts`: `resolveRuntimeSlashCommandFromWatcher(input, watcher, {expandSkillCommands})` parses `/<name> <args>`, normalizes the name (`normalizeRuntimeCommandName` keeps Unicode letters/numbers, collapses symbols to `-`), resolves against **skills + workflows** discovered by a config watcher, and either **textually expands** the command into the prompt (`${instructions}${remainder}`) or (when the `skills` tool is registered) passes `/skill args` through for the tool to load. Workflows are deprecated in favour of skills; a skill owns a name over a colliding workflow.
- [`extensions/plugin/plugin-command-origin.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/plugin/plugin-command-origin.ts): a `WeakSet` marks commands registered by loaded plugins (`markPluginCommand`/`isPluginCommand`), distinguishing them from built-in skill/workflow commands.
- `cron/.../schedule-command-service.ts`: the `schedule` command family.

So cline's user-facing commands = **skills + workflows + plugin commands + `schedule`**, all registered at runtime. There is no hardcoded `/compact`/`/model` list in the SDK core (that belongs to the app host).

---

# PART B - Claude Code (exhaustive, per-subsystem; docs/`mods`/`examples`/manifest only)

## B.1 The real hook model - `mods/*/hooks/*.ts` (read `agents-md/register.ts`, `sec-default/register.ts` in full)

This is the headline finding of the pass: **Claude Code's published `mods/` packs reveal a tiered middleware hook engine far richer than its own hooks docs** (which describe only the shell/exit-code `PreToolUse`/`PostToolUse` surface). The in-process API is `register(on: On, options: PluginOptions)`, and each hook is `on('<event>', [matcher], ($, e, next) => …)`:

- `$` = **capability-injection bag** (24 capabilities, by frequency in `mods/`): `$.ui $.session $.command $.tool $.telemetry $.fs $.settings $.env $.prompt $.clock $.agent $.process $.model $.config $.store $.http $.audio $.mcp $.turn $.plugin $.noun $.fn`. (e.g. `$.fs.ancestors`, `$.settings.read`, `$.telemetry.log`, `$.ui.log`, `$.http.fetch`.)
- `e` = the typed event; `next` = the middleware continuation with: `next(e)` (pass down), `next.to(e,'append')` (continue **past the user tier** into org tiers), `next.origin.tier` (`'prepend'`/`'append'` = organization tiers, `'user'` = user tier, plus `'hook-context'`/`'attachment'`/`'compaction'`/`'note'`/`'tool-message'` `door`s), `next.trace`, `next.called`, `next.error`. Returning `{deny: reason}` / `{refuse: reason}` **vetoes**.
- Hooks can be chained with a **fail-closed `.catch(($,e,next)=>…)`** handler (sec-default uses it on `tool.check`, `env.set`, `plugin.register`).
- Matchers: `on('session.append', {door:'compaction'}, …)`, `on('plugin.register', {tier:'user'}, …)`, and a wildcard `on('classic.*', …)` for legacy hooks.

**The complete interceptable event taxonomy observed in `mods/`** (count = occurrences):

| Namespace | Events |
|---|---|
| `tool.*` | `tool.call` (30), `tool.check` (17), `tool.list` (8), `tool.register` (3), `tool.describe` (3) |
| `session.*` | `session.start` (29), `session.usage`, `session.messages`, `session.append`, `session.compact`, `session.id`, `session.end`, `session.version`, `session.surfaces`, `session.root`, `session.repo`, `session.model`, `session.cwd`, `session.authorize` |
| `prompt.*` | `prompt.section`, `prompt.compose`, `prompt.context`, `prompt.submit`, `prompt.attachment` |
| `command.*` | `command.run` (25), `command.register`, `command.describe` |
| `ui.*` | `ui.log`, `ui.open`, `ui.render`, `ui.invalidate`, `ui.close`, `ui.status`, `ui.focus`, `ui.toast`, `ui.scroll` |
| `env.*` | `env.get`, `env.set` |
| `fs.*` | `fs.list`, `fs.ancestors`, `fs.stat`, `fs.read`, `fs.exists` |
| `agent.*` | `agent.spawn`, `agent.offer` |
| `turn.*` | `turn.step`, `turn.complete` |
| others | `engine.create`, `plugin.register`, `skill.prompt`, `settings.read` (97), `telemetry.log`, `telemetry.mark`, `clock.now`, `clock.after`, `attribution.text`, `http.fetch` |

The five shipped packs (each `plugin.json` + `hooks.json` read):
- **agents-md** - AGENTS.md discovery/injection via `prompt.context` + `tool.call`(Read) + `session.start`; a `userConfig.instructionFiles` enum (`claude-md`/`claude-md-or-agents-md`(default)/`claude-md-and-agents-md`/`managed-only`).
- **sec-default** - org security default, **seated outermost**: continues org-tier hooks past the user tier, refuses user-tier `tool.register`/`env.set`(pinned)/`plugin.register`(under `allowManagedModsOnly`), restores org tools in `tool.list`, holds org denies over user rewrites in `tool.check`. Fail-closed throughout.
- **privacy** - refuses a shell call carrying the signed-in email as a User-Agent.
- **diff** - the `/diff` pane as a plugin (registers the `/diff` **command**, redraws on edits/commands/turn-end).
- **telemetry** - `$.telemetry.log`/`.mark` → batched first-party rows; the `$.telemetry` noun is seated in `engine.create`.

## B.2 Exit-code hook contract (the public, shell-level surface) - [`examples/hooks/bash_command_validator_example.py`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/hooks/bash_command_validator_example.py) (read in full)

The documented shell-hook contract (distinct from B.1's in-process `mods`): a `PreToolUse` hook matched on `"Bash"` reads `{tool_name, tool_input:{command}}` on stdin and signals by **exit code**: **exit 2 blocks the tool and shows stderr to Claude**; exit 1 shows stderr to the user only; exit 0 proceeds. The worked example rewrites `grep`→`rg` and `find -name`→`rg --files`. Hook config shape: `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"…"}]}]}}`.

## B.3 Permission modes + managed/MDM settings - `examples/settings/*`, `examples/mdm/*` (read)

- **Permission modes** (CHANGELOG + docs): `default`, `acceptEdits`, `plan`, `auto` (safety-reviewed), `bypassPermissions` (a.k.a. `dangerously-skip-permissions`). Rules are `allow`/`ask`/`deny` lists keyed by tool.
- `settings-strict.json`: `permissions.disableBypassPermissionsMode:"disable"`, `ask:["Bash"]`, `deny:["WebSearch","WebFetch"]`, `allowManagedPermissionRulesOnly:true`, `allowManagedHooksOnly:true`, `strictKnownMarketplaces:[]`, and a `sandbox.network` block.
- `settings-lax.json`: just `disableBypassPermissionsMode` + `strictKnownMarketplaces`.
- **Managed hierarchy** ([`examples/mdm/managed-settings.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/mdm/managed-settings.json)): enterprise managed-settings can set `disableBypassPermissionsMode`, `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedModsOnly` (sec-default), `strictKnownMarketplaces` - overriding user/project rules. Deployed via MDM (Jamf/Kandji/Intune/Group Policy in `examples/mdm/{macos,windows}`). HIPAA presets exist (`settings-hipaa.json`, `managed-mcp-hipaa.json`).
- **Bash sandbox** (`settings-bash-sandbox.json`): `sandbox.enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `excludedCommands`, `enableWeakerNestedSandbox`, and `sandbox.network {allowedDomains, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, httpProxyPort, socksProxyPort}`. **Documented scope limit: the sandbox applies only to Bash, not Read/Write/WebSearch/WebFetch/MCP** - a cautionary contrast with HorizonCode's kernel-enforced all-tool guard.

## B.4 Subagents + Agent SDK / headless - docs + CHANGELOG

- **Subagent description token budget**: Claude warns when non-built-in subagent descriptions exceed **15,000 tokens** of combined context. Built-in **Explore**/**Plan** subagents start *without* CLAUDE.md + git-status (`omitClaudeMd`) to keep research cheap. `CLAUDE_CODE_SUBAGENT_EFFORT` sets child effort (CHANGELOG L334). `permissions.denyInsteadOfPrompting` denies-and-continues in subagents/teammates (L9). Subagents can run a cheaper model (Haiku).
- **Agent SDK / headless**: the CLI is the product library ("same tools, agent loop, context management, programmable in Python and TypeScript"); non-TS/Python callers run it headless with `-p --output-format json` - and the CHANGELOG confirms **`--output-format stream-json`** and `--input-format`/local stream-json host (L448, L457). `--permission-mode` is a CLI flag (CHANGELOG, 8 hits).

## B.5 Plugin marketplace - [`.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/.claude-plugin/marketplace.json) (read in full) - NEW this pass

A schema-versioned marketplace (`$schema: json.schemastore.org/claude-code-marketplace.json`) of **12 official plugins**, each `{name, description, author, source:{source:"git-subdir", url, path, ref}, category}`: `agent-sdk-dev`, `code-review`, `commit-commands`, `explanatory-output-style`, `feature-dev`, `frontend-design`, `hookify` (create hooks from markdown rules), `learning-output-style`, `plugin-dev` (7 skills: hooks/MCP/commands/agents), `pr-review-toolkit`, `ralph-loop` (self-referential iterate-to-completion), `security-guidance`. Plus a `renames` map. This is the extensibility distribution model (a registry SHAPE for commands/agents/hooks/skills/output-styles).

## B.6 Slash-command surface - `CHANGELOG.md` + `mods/diff` (`/diff`)

Claude Code ships a large built-in slash surface. By CHANGELOG frequency the authoritative set includes: `/model /plugin /config /mcp /ultrareview /resume /login /clear /skills /effort /usage /settings /doctor /context /status /permissions /code-review /feedback /loop /rename /rewind /compact /workflows /remote-control /btw /add-dir /copy /tasks /install-github-app /hooks /fork /docs /branch /artifacts /agents /usage-credits /terminal-setup /sandbox /reload-plugins /bug /cost /help /tui /goal`. Plugins add commands (`command.register`, e.g. `mods/diff` registers `/diff`). This is the most complete agent slash surface of the two repos.

---

# PART C - STRICT comparison tables (per subsystem)

Legend: **COMMON** = ≥2 external sources (within this pass or confirmed against the first-pass opencode/codex/dsh/grok findings); **UNIQUE** = this source only; **ALREADY-IN** = HorizonCode has it; **MISSING** = build, not steal.

## C.1 Hook taxonomy + lifecycle

| Capability | cline | Claude Code | HorizonCode today | Class |
|---|---|---|---|---|
| Typed hook callback bag `before/after Run/Model/Tool` + `onEvent` | [`shared/src/agent.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/shared/src/agent.ts) L486 (7 callbacks) | `mods` middleware (`on('turn.step'/'tool.call'/'session.start'/…)`) | `hooks.ts`: only `preTool`/`postTool` (2 of 16 ratified points; docs/15 §2.4) | **COMMON** external, **partial ALREADY-IN** (reduced) → absorb the lifecycle breadth |
| `beforeTool` may rewrite `input` + set `policy` | yes | yes (`tool.call` can replace) | **forbidden** ("NO ARGUMENT REWRITING") | external **COMMON**; HC **MISSING by design** (decide if v2 lifts it) |
| `appendContext` → `<hook_context>` injected user message | yes (`AgentBeforeToolResult.appendContext`) | yes (`prompt.context`, `session.append{door:'hook-context'}`) | **MISSING** (H9 "bounded-note channel" explicitly deferred) | **COMMON** external → absorb |
| Session/compaction/subagent/turn lifecycle points | partial (`beforeRun`/`afterRun`) | **full** (`session.*`, `prompt.*`, `turn.*`, `agent.spawn`, `session.compact`) | **MISSING** (named residual in `hooks.ts`) | CC **UNIQUE breadth** → absorb |
| Capability-injection bag `$` for hooks | plugin `setup({tools,hooks})` only | **24 capabilities** (`$.fs/$.settings/$.telemetry/$.http/…`) | n/a (hooks get a JSON line only) | CC **UNIQUE** |
| Org/user **tier precedence** (`next.origin.tier`, `next.to(e,'append')`) | n/a | yes (sec-default) | **MISSING** (managed-settings tiering absent) | CC **UNIQUE** → absorb with permission modes |

## C.2 Exit-code hook contract

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Exit-code signalling (2=block+stderr-to-model, 1=user-only, 0=pass) | n/a (returns objects) | `bash_command_validator_example.py` | **NOT adopted** - `hooks.ts` uses a one-JSON-line protocol and explicitly rejects the exit-code contract (and the exit-10 "ask" wake) | CC **UNIQUE**; HC chose a different wire → decide v2 alignment |

## C.3 Loop detection (semantic repetition)

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Consecutive-identical-call signature (sorted-key JSON) soft@3/hard@5 | `loop-detection.ts` (full) | n/a in `mods` | **MISSING** (NF-073 caps only *format* errors) | cline **UNIQUE** (confirmed COMMON vs dsh `[3,5,8]` repeat guard from first pass) → absorb into `loop.ts`/`hooks.ts` |

## C.4 Mistake tracker

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Error-reason taxonomy (`api_error`/`invalid_tool_call`/`tool_execution_failed`) + resumable stop ("state preserved, send a new prompt") | `mistake-tracker.ts` (full) | n/a | **partial** - NF-073 charges failed turns but has no reason taxonomy nor resumable-stop message | cline **UNIQUE** → absorb into `loop.ts` |

## C.5 Command-guard

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| No-interpreter mutation blacklist (masking + wrapper-skip + subcommand + in-place-flag + redirect allowlist + structured-argv + `find -exec` recursion) | `command-guard.ts` (full, 521) | shell hook can emulate (B.2) + `privacy`/`sec-default` refusals | **MISSING** (plan.ts refuses write/edit/shell wholesale by tool name - `loop.ts` L1172; no per-command parse) | cline **UNIQUE** (COMMON vs grok bash-splitting first-pass) → absorb into `tools/shell.ts` + `core/plan.ts`; kernel `guard.rs` owns the durable half |

## C.6 Model→tool routing

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Declarative `{mode,modelIdIncludes,providerIdIncludes,enable[],disable[]}` routing; GPT/Codex→apply_patch | `model-tool-routing.ts` (full) | n/a (per-subagent tool access, not per-model routing) | **MISSING** (same tool set to every model) | cline **UNIQUE** → absorb; schema owner `contracts.ts` (`ToolSpec` exposure) |

## C.7 apply_patch grammar

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| GPT-5 freeform patch (`Begin/Add/Update/Delete/Move/@@`) + graded fuzz ladder (0/1/100/1000/+10000) + Unicode canonicalize + warnings-not-failures | `apply-patch-parser.ts` (full) | n/a | **MISSING** (only find/replace `edit.ts` + NF-069 ladder) | cline **UNIQUE** (COMMON vs codex `apply-patch` + grok `codex/apply_patch` first pass) → absorb as a new tool; schema owner `contracts.ts` |

## C.8 Line-endings helper

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Shared EOL detect/restore (LF-space chunk math, CRLF-anywhere → CRLF, new-file CRLF on Windows) | `line-endings.ts` (full) | n/a | **MISSING** (no documented CRLF story in `edit.ts`) | cline **COMMON** (opencode `edit.ts` same conclusion) → absorb shared helper for `edit.ts`/`write.ts`/new patch tool |

## C.9 Subprocess sandbox

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Process-boundary isolation + idle respawn + `BUN_BE_BUN=1` launcher + `restrictToCwd` | `subprocess-sandbox.ts` (559) | Bash-only OS sandbox (`settings-bash-sandbox.json`) | **partial** - NF-071 owned-spawn/supervisor/worker-identity; no idle-respawn/compiled launcher; kernel guard is all-tool | cline respawn = **UNIQUE** detail; OS sandbox = **MISSING in both agent cores** → HC landlock is a build-not-steal differentiator |
| `restrictToCwd`/`..`-escape uniform across write tools | yes (every executor) | n/a | **partial** (kernel scope=workspace via symlink resolve, `contracts.ts` DEFAULT_POLICY) | cline UNIFORM-at-tool-layer → absorb into `tools/write.ts`/`edit.ts` |

## C.10 Permission modes + managed settings

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Named permission modes (`default/acceptEdits/plan/auto/bypassPermissions`) | presets (`act/plan/search/minimal/yolo`) + `ToolPolicy{enabled,autoApprove}` | `examples/settings/*` | **partial** - binary plan on/off (`plan.ts`); guard decision is `allow/ask/deny` (`contracts.ts`) but no mode vocabulary | **COMMON** (both have a mode notion) → absorb a mode enum; yolo≈bypass, plan≈plan |
| Managed/MDM override hierarchy (`allowManaged*Only`, `disableBypassPermissionsMode`, `strictKnownMarketplaces`) | n/a | `examples/mdm/*`, `settings-strict.json` | **MISSING** (config.ts has no trust store; `hooks.ts` notes no trust-gate) | CC **UNIQUE** → absorb into `config.ts` + kernel `permm.rs`; policy owner `contracts.ts` |
| `allow`/`ask`/`deny` rule lists keyed by tool | `ToolPolicy` per tool | yes | `DEFAULT_POLICY` keyed by `GuardKind`×scope (not per tool name) | **COMMON** → extend HC policy to per-tool-name rules |
| Bash network allowlist shape (`allowedDomains`, `allowUnixSockets`, `allowLocalBinding`, `httpProxyPort`) | n/a | `settings-bash-sandbox.json` | **MISSING** (no egress policy) | CC **UNIQUE** (COMMON vs grok egress proxy first pass) → kernel egress; policy owner `contracts.ts` |

## C.11 Subagent presets + description budget

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Lean read-only research child (`omitClaudeMd` Explore/Plan) | `search` preset (read+search only) | Explore/Plan built-ins | **MISSING** (`agent.ts` one preset) | **COMMON** → absorb a lean "explore" preset into `subagent.ts`/`instructions.ts` |
| Description token budget warning (15k) | n/a | yes | **MISSING** | CC **UNIQUE** → absorb into `tools/agent.ts` |
| Multi-agent teams / durable child sessions / coordinator | `team/*` (full) | teammates/tasks (CHANGELOG) | **MISSING** (single one-shot delegate, `agent.ts`) | **COMMON** → strategic absorb (NF-071 managed runtime is the home) |
| Scope-statement / return-guidance injected into every child | partial (`subagent-prompts.ts` rules) | denyInsteadOfPrompting + "retry narrower or tell you" (CHANGELOG L121) | **MISSING** | **COMMON** (confirmed vs dsh first pass) → absorb into `subagent.ts` |

## C.12 Agent SDK / headless JSON

| Capability | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Headless structured output (`-p --output-format json`/`stream-json`) | CLI/daemon (hub) | yes (+ stream-json, input-format) | **MISSING** - `main.ts` pipe mode is plain text, one message per stdin line; no JSON protocol | CC **UNIQUE** (COMMON vs codex app-server + dsh SDK first pass) → build headless JSON; protocol owner `contracts.ts` |
| Resume / fork sessions programmatically | [`session/fork-metadata.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/session/fork-metadata.ts) + hub | `/resume` `/fork` `/rewind` | **partial** (`--continue`, `/rewind` checkpoints) | **COMMON** → extend |

## C.13 Slash commands

| Surface | cline | Claude Code | HorizonCode | Class |
|---|---|---|---|---|
| Built-in command table | app host (SDK has none hardcoded) | ~45 (`/model /plugin /mcp /context /compact /rewind /hooks /agents /diff /resume /fork …`) | 11: `/help /new /model /files /context /plan /changes /apply /discard /rewind /exit` (`tui/interactive.ts`) | **COMMON** (both have a surface); CC breadth is **UNIQUE** |
| User/plugin-registered commands (skills/workflows/plugins) | `runtime-commands.ts` + `plugin-command-origin.ts` (full, data-driven) | plugin `command.register` (`mods/diff` `/diff`) | **MISSING** (fixed table, no skill/plugin command expansion) | **COMMON** → absorb a data-driven command resolver |
| Scheduled command (`/schedule`-like cron) | `cron/*` (SQLite) | `/workflows`, `/tasks` | **MISSING** (NF-028/053 documented only) | **COMMON** |

---

# PART D - Superset absorption plan (mapped to HorizonCode files + contracts.ts)

Ordered by value ÷ effort. "extends NF-###" reuses the first-pass vocabulary; items already queued in `docs/30-steal-list.md` §5.2/§5.6 are marked ⟲ and sharpened with the exact source detail this pass verified.

### Tier 1 - cheap, local, high value

1. **Semantic loop-detection (soft@3/hard@5)** ⟲ - port `loop-detection.ts` verbatim. Target: `app/src/core/loop.ts` (after each tool call) + register through `app/src/core/hooks.ts` once the taxonomy widens (D-item 8). Signature = canonical-JSON sorted keys; reuse `contracts.ts::canonicalJson`. *extends NF-073.*
2. **Mistake taxonomy + resumable stop** ⟲ - port `mistake-tracker.ts`. Target: `app/src/core/loop.ts`; emit the "Session state was preserved. Send a new prompt to resume." terminal and map it onto `RunExit {terminal:"failed", detail:"format_errors"}` (or a new `detail:"mistakes"` - a `contracts.ts` `RunExit.detail` union addition). *extends NF-073.*
3. **Command-guard read-only lane** ⟲ - port `command-guard.ts` (masking, wrapper-skip, subcommand table, in-place flags, redirect allowlist, structured-argv path, `find -exec` recursion). Target: `app/src/tools/shell.ts` + `app/src/core/plan.ts` (replace the wholesale by-name refusal at `loop.ts` L1172). The durable per-command decision belongs in `kernel/src/guard.rs`. **No contracts change** (pure helper). *new candidate.*
4. **Shared line-endings helper** ⟲ - port `line-endings.ts`. Target: a new `app/src/tools/line-endings.ts` used by `edit.ts`, `write.ts`, and the new patch tool. *extends NF-069.*
5. **Exit-code hook contract alignment (decision only)** - Claude Code's exit-2/1/0 + the `appendContext`/`<hook_context>` injection. Target: `app/src/core/hooks.ts`. The reduced engine already fails-closed; adding (a) an `ask` outcome (exit 10 wake) and (b) a bounded context-fragment return are the two named residuals. Requires a `contracts.ts` hook-decision union if the wire changes. *extends doc 10/15.*

### Tier 2 - next capability wave

6. **`apply_patch` tool + graded fuzz ladder** ⟲ - port `apply-patch-parser.ts` + `apply-patch.ts`. Target: new `app/src/tools/apply-patch.ts`; **`contracts.ts` additions**: register the tool (it is `concurrencyClass:"exclusive"` like `edit`), and the patch-result shape if receipts digest fuzz. Pair with #7. *new candidate.*
7. **Declarative model→tool routing** ⟲ - port `model-tool-routing.ts`. Target: `app/src/tools/index.ts`; **`contracts.ts`**: the `ToolSpec`/exposure layer needs a `{modelIdIncludes, providerIdIncludes, enable[], disable[]}` table so GPT/Codex get `apply_patch` and others keep `edit`. *new candidate.*
8. **Widen the hook lifecycle to the ratified points** - add `session.start/end`, `pre/post Compact`, `subagent start/stop`, `turn.step/complete`, `beforeModel/afterModel`, plus the `appendContext` channel. Target: `app/src/core/hooks.ts` + emit points in `app/src/core/loop.ts`; **`contracts.ts`**: a hook-event/point union. This is the single largest extensibility gap vs both externals. *extends doc 15 (H1-H10).*
9. **Named permission modes** - a mode enum (`default/acceptEdits/plan/auto/bypassPermissions`) folded into tool presets (adopt cline's `presets.ts` shape: act/plan/search/minimal/yolo). Target: `app/src/core/config.ts` + `app/src/core/plan.ts`; **`contracts.ts`**: a `PermissionMode` type and per-tool-name `allow/ask/deny` rules (extend `PolicyRule`). *extends doc 11.*
10. **Managed/MDM settings hierarchy + trust store** - org-tier precedence over user/project rules (Claude Code `allowManaged*Only`, `disableBypassPermissionsMode`; the `next.origin.tier` idea). Target: `app/src/core/config.ts` (the named-missing trust store) + `kernel/src/permm.rs`; **`contracts.ts`**: a settings-tier/policy-source field. Closes the `hooks.ts` "workspace hook is NOT trust-gated" residual. *extends doc 11.*
11. **Lean "explore" subagent preset + description budget** ⟲ - a read-only research child that starts without instructions/git-status (`omitClaudeMd`) and a 15k-token description-budget warning. Target: `app/src/core/subagent.ts`, `app/src/tools/agent.ts`, `app/src/core/instructions.ts`. *extends doc 10.*

### Tier 3 - richer / strategic

12. **Headless JSON / stream-json protocol** - a non-TTY structured mode beyond today's plain-text-per-line. Target: `app/src/main.ts` + `app/src/tui/headless.ts`; **`contracts.ts`**: a headless/JSON-RPC-over-stdio protocol surface (the kernel already speaks NDJSON - mirror that shape for the app surface). *new candidate.*
13. **Data-driven slash-command resolver (skills/workflows/plugins) + scheduled commands** - port cline's `runtime-commands.ts` resolver (name normalization, skill-vs-workflow ownership, `/skill args` passthrough) and the `plugin-command-origin.ts` marking; add a `cron/`-style scheduled command. Target: `app/src/tui/interactive.ts` (command table) + a new `app/src/core/commands.ts`; the plugin-marketplace SHAPE (Claude Code `marketplace.json`) is the distribution model for commands/agents/hooks/skills. *extends doc 14/15.*
14. **Multi-agent teams / durable child sessions** - cline `team/*` + Claude Code teammates/tasks. Target: `app/src/core/subagent.ts` + the NF-071 managed-runtime FIFO (currently not wired into `loop.ts`). Strategic; largest surface. *extends NF-071.*
15. **Session fork + checkpoint-restore as a durable graph** - cline [`session/fork-metadata.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/session/fork-metadata.ts)/`checkpoint-restore.ts`. Target: extend HorizonCode's `/rewind` + `core/checkpoints.ts` toward a forkable session graph backed by the kernel receipt chain (the `plan.ts` "durable plan artifact … does not exist yet" residual). *extends doc 12.*

### Deliberate non-steals (named)

- **OS sandbox**: neither cline (process boundary only) nor Claude Code (Bash-only) delivers it; HorizonCode's landlock direction (`docs/audit/landlock-spike-2026-11-08.md`) is a build-not-steal differentiator. Claude Code's own docs flag the Bash-only scope as a limitation.
- **cline VS Code / desktop host, gRPC/webview**: HorizonCode is a TUI - take the SDK-core patterns, skip the host.
- **Argument-rewriting hooks**: cline/Claude Code allow it; HorizonCode forbids it on purpose (`hooks.ts`). Adopt only if a v2 re-guards the rewritten call end-to-end (the full-intent digest + lease + receipt must be recomputed).
- **Claude Code `bypassPermissions` default-on**: keep it gated behind an explicit flag + `disableBypassPermissionsMode` honoured, exactly as `settings-strict.json` does.

---

# Appendix - exact evidence paths

**cline** ([`cline/cline`](https://github.com/cline/cline/tree/5413dc180c10700ce2e26547ab75991360dd0486), `5413dc1`):
- [`sdk/packages/shared/src/agent.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/shared/src/agent.ts) L486-517 (`AgentRuntimeHooks`), L436-471 (`AgentBeforeToolResult`/`AgentAfterToolResult` + `appendContext`)
- [`sdk/packages/agents/src/agent-runtime.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/agents/src/agent-runtime.ts) L326-334 (`HookBag`), L744 (`registerHooks`)
- [`sdk/packages/core/src/runtime/safety/loop-detection.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/loop-detection.ts), `mistake-tracker.ts`
- [`sdk/packages/core/src/extensions/tools/command-guard.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/command-guard.ts), `model-tool-routing.ts`, `presets.ts`, `definitions.ts`
- [`sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts), `apply-patch.ts`, `line-endings.ts`, `editor.ts`
- [`sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts) (L68 grace, L309 `BUN_BE_BUN`), `tool-approval.ts`
- `sdk/packages/core/src/extensions/tools/team/*` (spawn/multi-agent/delegated/subagent-prompts)
- [`sdk/packages/core/src/extensions/config/runtime-commands.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/config/runtime-commands.ts), [`extensions/plugin/plugin-command-origin.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/plugin/plugin-command-origin.ts)
- `sdk/packages/core/src/session/{fork-metadata.ts,checkpoint-restore.ts}`, [`cron/service/schedule-command-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/cron/service/schedule-command-service.ts)

**Claude Code** ([`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68), `0ed9469`):
- `mods/{agents-md,sec-default,privacy,diff,telemetry}/.claude-plugin/plugin.json` + `hooks/hooks.json`
- [`mods/agents-md/hooks/register.ts`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/mods/agents-md/hooks/register.ts), [`mods/sec-default/hooks/register.ts`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/mods/sec-default/hooks/register.ts) (the `on(event,($,e,next))` middleware model)
- [`examples/hooks/bash_command_validator_example.py`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/hooks/bash_command_validator_example.py) (exit-code contract)
- `examples/settings/{settings-strict.json,settings-bash-sandbox.json,settings-lax.json,settings-hipaa.json}`, [`examples/settings/managed-mcp-hipaa.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/settings/managed-mcp-hipaa.json)
- [`examples/mdm/managed-settings.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/mdm/managed-settings.json), `examples/mdm/{macos,windows}`
- [`.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/.claude-plugin/marketplace.json) (12 plugins), `CHANGELOG.md` (slash commands, permission modes, headless `--output-format json`/`stream-json`)

**HorizonCode** (this repository (HorizonCode)):
- `app/src/contracts.ts` (LAW: `Tool.concurrencyClass`, `GuardAction`/`GuardDecision` allow/ask/deny, `DEFAULT_POLICY`, `RunExit` union, no provider-registry/apply_patch/hook-event/permission-mode fields)
- `app/src/core/hooks.ts` (reduced 2-point engine; explicit residual list), `app/src/core/loop.ts` (`MAX_PROVIDER_CALLS=25`, `MAX_CONSECUTIVE_FORMAT_ERRORS=3`, `concurrencyClassOf`, `batchSegments`, plan-mode refusals L1172)
- `app/src/core/plan.ts` (in-memory staged-change store), `app/src/tools/agent.ts` (single delegate, 12/max 20 steps)
- `app/src/main.ts` (headless = plain text per stdin line; flags only), `app/src/tui/interactive.ts` (11 slash commands)
- `kernel/src/guard.rs`, `kernel/src/permm.rs` (durable guard/leases per `contracts.ts`)
