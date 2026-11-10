# Steal list: opencode and cline → HorizonCode

> Phase 1 research report. Read-only deep dive of two cloned repos under the local `externals/` clone directory (upstream URLs and pins: [upstream-pins.md](upstream-pins.md)), mapped to concrete HorizonCode changes. Every external claim cites a file path inside the clone. HorizonCode paths are rooted at `app/src/` unless noted.

## 0. What these two repos are, in one line each

- **opencode** (`opencode` (see [upstream-pins.md](upstream-pins.md))): a TypeScript/Bun monorepo (37 packages under `packages/`). The agent brain lives in `packages/core/src` (effect-TS, SQLite/drizzle-backed sessions) and a **first-party AI SDK** in `packages/ai/src` with ~50 per-provider protocol adapters. It is the most architecturally advanced TS coding agent in this pair: data-driven providers, a prompt-cache breakpoint engine, a structured "decision" (cheap-judge) API, background compaction, and a line-ending-preserving edit engine.
- **cline** (`cline` (see [upstream-pins.md](upstream-pins.md))): historically a VS Code extension (`apps/vscode`), but the reusable agent core has been extracted into an SDK at `sdk/packages/core/src`. Its strengths are a **pragmatic tool set** (`read_files`, `search_codebase`, `run_commands`, `editor`, `apply_patch`, `skills`, `ask_question`, `submit_and_exit`), a **shell command-guard** for plan mode, **per-model tool routing**, loop/mistake safety trackers, and a **user-extensible provider registry**.

Both independently landed the same conclusions HorizonCode already documents in `docs/30-steal-list.md` (NF-071…NF-075): parallel tool batching, loop safety rails, context-cost caps, line-aware truncation. This report focuses on what is *new* relative to that doc, and sharpens a few items HorizonCode has only partially landed.

---

## PART A - opencode

### A.1 Overall architecture

- Monorepo with a clean split: `packages/ai` (provider/transport, zero knowledge of sessions), `packages/core` (sessions, tools, permissions, compaction), `packages/tui`, `packages/server`, `packages/sdk`. The agent core depends on the AI package, never the reverse.
- Sessions are **SQLite/drizzle-backed** ([`core/src/session/sql.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/sql.ts), [`core/src/permission/sql.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/sql.ts), `core/src/database/`), not JSON files. State is projected from an event store ([`core/src/session/projector.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/projector.ts), 47 KB).
- Tools are **plugins** registered through a transform API (`core/src/tool/plugin/*.ts`); each returns an effect and declares options like `{ codemode, permission }`.

**HorizonCode relevance:** HorizonCode already has the kernel/app split and an event log (`kernel/src/eventlog.rs`). The lesson worth stealing is the **AI-package / core separation**: HorizonCode's `core/providers/` is coupled to `contracts.ts` types directly, which is fine, but the *protocol-adapter-per-wire-format* idea (below) is the reusable part.

### A.2 The agent loop

- The multi-step loop is pure and small: [`packages/ai/src/loop.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/loop.ts) (214 lines) folds a stream of events into steps. `pendingCalls()` decides the step is terminal when the model calls the answer tool or hits the output-token limit. `nextRequest()` appends `[assistant message, ...tool results]` and **downgrades a forced `toolChoice` to `auto` after the first step** (keeping it only for the answer tool).
- Invalid-JSON tool input is not dropped: `loop.ts` replays an empty-input call paired with an error string `"Invalid tool arguments: the input is not valid JSON. Received: <raw>"` so the model can self-correct (`invalidCall`, `withInvalidCalls`).
- The durable per-step driver is [`core/src/session/runner/step.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/step.ts): provider stream and tool fibers run concurrently; the final tool/step events are wrapped in `Effect.uninterruptibleMask` so a cancel never leaves a half-written step. It also captures a **start snapshot while the provider request is in flight** (not before), so snapshotting never delays the request.
- Max-steps is enforced by swapping `toolChoice: "none"` and injecting a hard text-only prompt ([`runner/max-steps.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/max-steps.ts)): "MAXIMUM STEPS REACHED … Respond with text ONLY."

**→ HorizonCode changes:**
1. **Invalid-tool-JSON replay.** In `core/loop.ts`, when a tool call arrives with unparseable arguments, do not silently fail the turn; synthesize a paired tool result carrying the byte-for-byte raw input and an explicit "not valid JSON" message. This is a cheap, high-value recovery rail that complements the NF-073 format-error cap already landed.
2. **Snapshot-in-flight.** HorizonCode captures checkpoints (`core/checkpoints.ts`); confirm the pre-tool snapshot is forked concurrently with the provider request rather than awaited before it, matching `step.ts`'s `forkScoped` pattern, to avoid adding latency per step.

### A.3 Tool design and tool set

Tools in `core/src/tool/plugin/`: `read`, `write`, `edit`, `patch`, `glob`, `grep`, `shell`, `todo`, `question`, `skill`, `subagent`, `schedule`, `webfetch`, `websearch`, `image-generate`, `artifact`, `file-diff`, `mcp-resource`. Each tool declares `options: { codemode: boolean; permission: string }`.

Notable mechanics:
- **`codemode` flag per tool** (`edit.ts` sets `codemode: false`): tools opt in/out of being callable from the code-mode sandbox. HorizonCode has `tools/codemode.ts` already; adopting a per-tool opt-out field is a one-line interface addition.
- **Tool result content is multi-part** (`{ type: "text" }` / `{ type: "file" }`), and the shell tool returns `content` as an array so a background notice can be a separate part from the output.

### A.4 Edit / diff format - the strongest single steal

[`core/src/tool/plugin/edit.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/plugin/edit.ts) is a find-and-replace `oldString`/`newString` tool (same shape as HorizonCode's `tools/edit.ts`), but with materially better matching:

- **LF-view matching with byte-accurate mapping back to CRLF.** It matches against `source.replaceAll("\r\n","\n")`, records the positions of stripped `\r`, then maps match offsets back into the original bytes (`matchView`, `countBefore`). Result: CRLF and mixed-ending files match on the LF text the model saw from Read, and **untouched regions keep their exact original bytes** (`withRegionEndings`, `alignLines` - an LCS alignment that reuses each kept line's own ending).
- **Three-tier fallback ladder inside one match pass** (`matchView`): exact → Unicode-normalized (curly quotes, en/em dashes, non-breaking spaces via `normalizeForMatch`) → per-line trailing-whitespace-insensitive (`findLineOccurrences`). This is a tighter version of HorizonCode's NF-069 edit ladder.
- **Vote-based miss hint** (`missHint`): on a no-match, it either tells the model "newString is already in the file, so this edit may already be applied" (when the replacement is already present) or shows **the closest numbered lines**, chosen by a whitespace-insensitive line-vote with a ">= half the search lines must agree" quorum, bounded to 12 lines and padded-context-proof. The hint is only shown when the caller is already permitted to read the file.
- **Explicit line-ending edits:** if `oldString` and `newString` differ only in `\r`, the edit applies to exact bytes (lets a model deliberately convert endings).

**→ HorizonCode changes (extends NF-069 in `tools/edit.ts`):**
3. **Adopt LF-view matching + byte-mapping + per-region ending preservation.** HorizonCode's edit ladder (per `docs/28` ruling 16) does indent-normalised and 3-way rungs, but the briefing notes 51 typecheck errors and no CRLF story is documented. Port `matchView`/`withRegionEndings`/`alignLines` so edits never rewrite a CRLF file to LF wholesale. This is directly transplantable TS with zero deps.
4. **Adopt the vote-based "closest lines" miss hint and the "already applied" detection.** HorizonCode already emits diff-shaped failures; the "newString already present → edit may already be applied" branch is a distinct, cheap signal that stops a model from looping on an edit that already succeeded. Gate the hint on read permission exactly as opencode does.

cline's `apply-patch` (below) and opencode's `edit` are complementary: opencode's is the find/replace engine; cline's is the GPT-5 freeform-patch engine. HorizonCode has neither a patch grammar nor CRLF-safe matching today.

### A.5 Prompt strategy and per-model tuning

- The base system prompt is tiny and harness-focused ([`core/src/session/runner/prompt/system.txt`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/prompt/system.txt)): it names `<system-reminder>` blocks as harness instructions, says "Prefer parallelizing independent tool calls," and interpolates `${OPENCODE_TOOL_GUIDANCE}`.
- Per-model behavior is **data, not prompt branching**: the model's capabilities (`reasoning`, `temperature`, `tool_call`, `interleaved`, cost tiers, context limits, modalities) live in [`core/src/v1/config/provider.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/v1/config/provider.ts) schema, sourced from the models.dev catalog.
- The **shell tool description is regenerated per request** to name the actual OS and shell (`shell.ts` `description(shell)` re-run via `ctx.session.hook("context" | "compaction" | "generate")`). Same pattern as cline (A.11).

**→ HorizonCode change:**
5. **Interpolate OS/shell into the shell tool description at request time.** HorizonCode's `tools/shell.ts` should render the concrete platform and shell into its description on each request rather than a static string, so the model quotes correctly for the host.

### A.6 Provider abstraction - the model for fixing HorizonCode's closed list

- `packages/ai/src/protocols/` has ~50 adapters grouped by **wire format**: `anthropic-messages`, `openai-chat`, `openai-responses`, `openai-compatible-chat`, `gemini`, `bedrock-converse`, `cohere-chat`, `mistral-chat`, `zai-messages`, plus speech/image/video. A provider is "a route id + a protocol adapter," so adding a provider that speaks an existing wire format is config, not code.
- Provider/model metadata is fully declarative ([`v1/config/provider.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/v1/config/provider.ts)): `{ api, name, env[], npm, whitelist[], blacklist[], options{apiKey,baseURL,timeout,headerTimeout,chunkTimeout,setCacheKey}, models{ <id>: {cost, limit, modalities, reasoning, ...} } }`.

**HorizonCode weakness it fixes:** `core/providers/index.ts` is a hard-coded `switch (config.provider)` whose `default:` branch **silently returns `createMockProvider()`** - an unknown provider string becomes the offline mock with no error. Confirmed at `core/providers/index.ts` line ~62.

**→ HorizonCode changes:**
6. **Fail loud on unknown providers.** Change the `default` arm of `makeProvider` to return a provider that yields a single `error` event ("Unknown provider '<x>'. Known: anthropic, openai, google, ollama, mock.") instead of falling back to mock. Mock should require the explicit `--mock` flag / `HZ_PROVIDER=mock`, which already exists; just stop defaulting to it.
7. **Introduce an "openai-compatible" protocol path.** HorizonCode has 4 real providers plus mock. Adopt opencode's insight that most new providers (DeepSeek, Groq, Together, OpenRouter, xAI, local vLLM) speak the OpenAI chat wire format. A single `openai-compatible` adapter keyed by `{ baseURL, apiKey, modelId }` in `core/providers/` would open the provider list without one file per vendor. This pairs with cline's user-provider registry (C.5).

### A.7 Permission / sandbox model

- Permissions are **SQL-backed and project-scoped** ([`core/src/permission/saved.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/saved.ts), [`permission/sql.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/sql.ts)): rows are `{ projectID, action, resource }` with a unique index; `assert({ action, resources, save })` checks and can persist an allow. The shell tool parses the command ([`shell/parse.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/shell/parse.ts)) into per-command `{ resource, save }` entries and asserts permission **per parsed command**, not per raw string (`shell.ts` `prepare`).
- External-path mutation requires a separate `authorizeExternal` approval before the edit approval (`edit.ts`, `shell.ts`).
- There is **no OS sandbox** here either; isolation is permission + path-resolution (`FileAccess.resolvePath`, cwd confinement).

**→ HorizonCode changes:**
8. **Per-parsed-command shell permission.** HorizonCode's shell permissioning should parse the command line and check each simple command, so `a && rm -rf b` is evaluated on `rm` specifically. This also feeds cline's command-guard idea (B.4).
9. **Durable, resource-scoped permission grants.** HorizonCode's kernel has `permm.rs`; mirror opencode's `{action, resource}` save model so "always allow writes under src/" is expressible and persisted, rather than per-session yes/no.

### A.8 Prompt-cache engine - direct token savings

[`packages/ai/src/cache-policy.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/cache-policy.ts) (247 lines) is a standalone, portable breakpoint planner:
- Default `"auto"` places up to **4 cache breakpoints** (`BREAKPOINT_CAP`): last tool definition, first + last system part, and the conversation tail (advances after each tool result so recent prefixes stay reusable).
- It is **data-driven per provider/route**: `RESPECTS_INLINE_HINTS` set, a `gatewayPolicy()` for OpenRouter/Vercel aliases (`~anthropic/...`), a `QWEN` policy (tools cached with system, not separately), and skips the pass entirely for OpenAI/Gemini implicit caching.
- Manual hints count against the budget; auto only fills remaining slots.

**→ HorizonCode change (extends NF-005 cache addendum):**
10. **Port a cache-breakpoint planner.** HorizonCode documents cache layout as an invariant (NF-005) but this file is a ready-made, dependency-free implementation of "stable slabs first, 4 breakpoints, tail advances." Adopt the per-route table so Anthropic requests get breakpoints and OpenAI/Gemini requests skip them (avoiding useless markers). This is the single biggest per-turn cost lever in the two repos.

### A.9 Cheap-judge / decision routing - structured, not ad hoc

[`packages/ai/src/decision.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/decision.ts) + `decision-client.ts` expose a typed judge API: ask a model `predicate | choice | score` questions and get back **calibrated probabilities** (`PredicateAnswer.probability`, `ChoiceAnswer.confidence`, `ScoreAnswer.score` = probability-weighted level index), with `ErrorAnswer{reason:"refusal"}` for per-question failures. Questions carry explicit `criteria.true/false` for ambiguous statements.

**→ HorizonCode change (extends omp C-11 "thinking effort by cheap judgment," doc 07/10):**
11. **Adopt a typed decision helper for routing decisions.** HorizonCode's eval/metrics machinery (`core/evals.ts`, `core/metrics.ts`) and any difficulty-based effort routing should call a small `decision({questions, input})` helper returning calibrated probabilities, rather than parsing free-text judgments. The predicate/choice/score shapes are directly reusable and make "is this task hard enough for ultrathink?" a structured call.

### A.10 Compaction / context management

[`core/src/session/compaction.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/compaction.ts) (61 KB) runs summarization **in the background on the warm cache**:
- A background summary starts when context nears the ceiling (`PRECOMPUTE_LEAD`), covers everything before the latest response (the prefix the provider just cached), and is **held, not applied** - swapping it in early would rewrite the cached prefix and throw away the cache (explicit comments at lines ~339-345).
- Tiered transcript shortening (`whole → tool outputs cut → ...`), a `summaryRoom` reserve so one large step past the trigger still sends unchanged, a floor on summary output tokens, a failed-summary cap, and a cache-lifetime guard (only start a background summary while enough of the last response's cache TTL remains).
- The summary prompt forbids mentioning that compaction happened and uses a fixed section template; a corrective retry fires if the template is not filled.

**→ HorizonCode change (extends NF-075 growth-fork / NF-005):**
12. **Hold-then-swap background compaction keyed to cache TTL.** HorizonCode already has `core/compaction.ts` and a review-fork (NF-075). Steal the specific discipline: summarize the just-cached prefix in the background, **hold** the summary, and only swap it in when compaction is actually due - and gate starting it on remaining cache lifetime. This is the cache-aware refinement HorizonCode's docs gesture at but this file implements concretely.

### A.11 MCP support

`core/src/tool/plugin/mcp.ts`: discovers MCP tools, registers them under a per-server namespace, and **reconciles on a 100 ms-debounced bus event** (`McpEvent.ToolsChanged`) because servers announce tools in bursts. Per-tool `codemode` flag honored. Output handling is careful: structured output passed through; text that looks like JSON is parsed only when the server declares no output schema; media MIMEs the read tool accepts are inlined, textual resources are inlined with a header, and **binary resources are spilled to a file** with a `[Binary resource … saved to <path>]` notice. A `flush` path waits for startup then forces a reconcile if the registry is stale.

**→ HorizonCode changes (HorizonCode has `core/mcp/`):**
13. **Debounced MCP reconcile** on a tools-changed event instead of eager re-registration, to survive burst announcements.
14. **MCP result normalization rules:** parse JSON-looking text only when the server declares no output schema; inline only read-tool-compatible media; **spill binary MCP resources to an artifact file** (HorizonCode already spills tool output per NF-074 - route MCP binaries through the same spill).

### A.12 Read tool / truncation

[`core/src/tool/read-filesystem.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/read-filesystem.ts): `MAX_READ_LINES=2000`, `MAX_READ_BYTES=50 KiB`, `MAX_LINE_LENGTH=2000` (clamped with a `… (line truncated to 2000 chars)` suffix), media ingest cap 20 MB, binary detection via NUL byte, directory listing paging, and a **request-local augmented rope** (order-statistic tree over byte/newline weights) so paging to an arbitrary line never re-decodes the whole file. Negative offset reads the tail.

**→ HorizonCode change (extends NF-074/B-9):** HorizonCode's read caps and spill already exist; the reusable idea is the **rope/order-statistic indexing for large-file paging** and the **negative-offset tail read**, which make `read(path, offset=-100)` cheap on huge files.

---

## PART B - cline

### B.1 Overall architecture

- The VS Code extension (`apps/vscode/src`) is now a thin host over an extracted SDK (`sdk/packages/core/src`). The SDK has `extensions/tools` (definitions, guards, routing, executors), `runtime/` (orchestration, safety, tools sandbox, turn-queue), `session/`, `services/llms`, `services/providers`, `services/mcp`.
- `SessionRuntime` ([`runtime/orchestration/session-runtime-orchestrator.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts), 1702 lines) owns the loop and installs **composable hooks** (`beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent`) that fold across config + extension layers. Safety trackers (loop detection, mistake tracker) are installed as `beforeTool` / error hooks.

**→ HorizonCode change:** HorizonCode's loop (`core/loop.ts`, 1894 lines) and `core/hooks.ts` could adopt the **typed hook-point taxonomy** (`beforeModel/afterModel/beforeTool/afterTool/beforeRun/afterRun`) so safety rails, loop detection, and budget checks are hooks rather than inlined branches - this is how cline keeps a large loop maintainable.

### B.2 The agent loop + safety trackers

Two small, verbatim-ported safety primitives worth copying wholesale:

- **Loop detection** ([`runtime/safety/loop-detection.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/loop-detection.ts)): canonicalizes each tool call to a signature (`JSON.stringify(sortKeys(input))`), counts consecutive identical calls, and returns `soft` at threshold 3 ("consider a different approach") and `hard` at 5 ("stopping to avoid a loop"). Installed as a `beforeTool` hook that can `{skip, stop}`.
- **Mistake tracker** ([`runtime/safety/mistake-tracker.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/mistake-tracker.ts)): per-session consecutive-mistake counter over reasons `api_error | invalid_tool_call | tool_execution_failed`, with a configurable `onLimitReached` callback that can inject recovery guidance and reset, or stop with a message that says "Session state was preserved. Send a new prompt to resume." `forceAtLimit` jumps straight to the cap.

**→ HorizonCode changes (extends NF-073 rails):**
15. **Add identical-tool-call loop detection** keyed on a sorted-key JSON signature, with soft (nudge) and hard (stop) thresholds. HorizonCode's rails cap *format* errors; this caps *semantic* repetition (same grep 5×), which the format-error cap does not catch.
16. **Separate mistake taxonomy from the format-error cap.** HorizonCode charges failed turns (NF-073); adopt cline's reason taxonomy and the "stop but preserve state, resume with a new prompt" message so a capped run is resumable rather than terminal.

### B.3 Tool set and tool design

[`extensions/tools/definitions.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/definitions.ts) builds: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`. Design notes:
- **Parallelism is prompted into every description:** "call this tool in the same response as other independent tool calls," "read them together in one call." Reinforces HorizonCode's NF-072 parallel batching at the prompt layer.
- **`read_files` is batch-first and tolerant** of many input shapes (`files`/`file_paths`/`paths`/bare string/array) via a union schema, with per-file line-range paging (`start_line`/`end_line`) and per-file error objects rather than failing the whole call.
- **`ask_question`** rejects an empty/dismissed answer with "Do not assume an answer: make a reasonable choice and say so, or stop and report what you need." and has a `successContext` continuation string.
- **`submit_and_exit`** has `lifecycle.completesRun: true` and an **evidence-demanding description**: "submit because you have observed evidence that it does," "run the tests," "re-read the task." This is a strong terminal-tool prompt.

**→ HorizonCode changes:**
17. **Batch-tolerant read with per-item errors.** HorizonCode's `tools/read.ts` should accept multiple paths in one call and return a per-path result/error array (never fail the whole call on one bad path), matching cline's union-schema + `ToolOperationResult[]` shape.
18. **Harden the clarify/terminal tools.** HorizonCode's `tools/agent.ts`/`todo.ts` and any "ask the user" path should refuse to fabricate an answer when dismissed, and the run-completion tool should carry evidence-demanding guidance like `submit_and_exit`.

### B.4 Shell command-guard (plan-mode blacklist) - a standout

[`extensions/tools/command-guard.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/command-guard.ts) is a ~450-line, **no-shell-interpreter** mutation detector used to keep `run_commands` read-only in plan mode:
- **Masks data before scanning** (`maskNonCommandText`): drops heredoc bodies, blanks quoted spans / backslash escapes / comments / arithmetic `$(( ))`, so `echo "rm -rf /"` does not false-positive.
- **Skips wrappers** (`sudo env xargs timeout nice …`) and their options, env assignments, and shell reserved words to reach the real command word.
- **Blocklists by command** (`rm mv cp dd touch mkdir chmod …` plus Windows/PowerShell cmdlets) **and by subcommand** (`git add/commit/push/reset…`, `npm/pnpm/yarn/bun install`, `pip install`, `cargo add`, apt/brew/… ), with **read-only exceptions** (`git stash list`, `git switch --help`).
- **In-place-edit flag detection:** `sed -i`, `perl -i`, `awk -i inplace`, `sort -o`, `curl -o`, `wget` (unless `--spider`/`-O-`), `find -delete`/`-exec` (recurses into the exec'd command), `tee` (unless to `/dev/null` or `/tmp`).
- **Redirect-target allowlist** (`isAllowedRedirectTarget`): `>` to a file is blocked unless `/dev/null|stdout|stderr`, `/tmp`, `/var/tmp`, `$TMPDIR`, or Windows `%TEMP%`; rejects `..` so a temp prefix can't escape.

**→ HorizonCode changes:**
19. **Adopt command-guard as a read-only lane enforcement.** HorizonCode has a kernel guard (`kernel/src/guard.rs`) and plan mode (`core/plan.ts`). Port this guard so plan/read-only mode (and any "no mutations" authority level) can keep `shell` available for investigation while structurally blocking file-mutating commands - with the masking, wrapper-skipping, and redirect allowlist, which are the parts that make a naive blacklist safe. It is pure TS, zero deps, and self-contained.

### B.5 Edit formats: two engines (editor + apply_patch)

- **`editor` executor** ([`executors/editor.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/editor.ts)): `create | str_replace | insert_line`. `str_replace` requires a **unique** `old_text` match (fails on 0 or >1), uses a replacer function so `$`-sequences aren't expanded, and emits a **trimmed-prefix/suffix line diff** (` ```diff ` with `-N:`/`+N:` and a split line budget between removals/additions, truncated with a count). A `null`/omitted `old_text` on an existing file returns a verbose recovery message ending "Do not re-send this call unchanged." (an explicit anti-loop nudge for weak models).
- **`apply_patch` executor** ([`executors/apply-patch.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts) + `apply-patch-parser.ts`): the **GPT-5 freeform patch grammar** (`*** Begin Patch` / `*** Add|Update|Delete File` / `*** Move to:` / `@@` markers / context+`-`+`+` lines), with a **fuzz factor** reported back ("Patch applied with fuzz factor N"), legacy `%%bash`/heredoc wrapper tolerance, cwd confinement, and a `computePatchChanges()` preview that reads current file contents for a diff-editor preview without writing.
- **Line endings are handled identically to opencode's conclusion** ([`executors/line-endings.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/line-endings.ts)): chunk math runs in LF space, each file's native EOL is detected and restored on write, new files get normalized endings. Comment: "models emit LF-only patch text even for CRLF files."

**→ HorizonCode changes:**
20. **Add an `apply_patch` tool with the GPT-5 grammar.** HorizonCode has `tools/edit.ts` (find/replace) and `tools/write.ts` but no multi-file patch tool. GPT-5/Codex-family models are tuned for this grammar; without it, HorizonCode leaves edit-success on the table for those models. The parser + executor are self-contained and portable. Pair with routing (B.6).
21. **Report a fuzz factor and support `Move to:`.** Even for HorizonCode's existing edit path, surfacing a fuzz/confidence note and supporting rename-in-patch are concrete UX wins.
22. **Unify EOL handling across edit/write/patch** via a shared `line-endings` helper (detect native EOL, do chunk math in LF, restore on write). This is the same conclusion opencode reached independently (A.4) - strong signal it's correct.

### B.6 Per-model tool routing - directly fixes a HorizonCode gap

[`extensions/tools/model-tool-routing.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/model-tool-routing.ts): declarative rules match on `mode` + `modelIdIncludes` + `providerIdIncludes` and `enable/disable` tools. The shipped defaults route **OpenAI-native and `codex`/`gpt` models to `apply_patch` and disable `editor`**, while other models keep `editor`. Resolution produces a `Partial<DefaultToolsConfig>` of enable flags.

**→ HorizonCode change:**
23. **Add declarative model→tool-routing.** HorizonCode exposes the same tool set to every model. Adopt a small rule table (`{modelIdIncludes, providerIdIncludes, enable[], disable[]}`) so GPT/Codex models get a patch tool and Claude/Gemini get the find/replace editor. This is the companion to change #20 and is ~120 lines, data-driven.

### B.7 Permission / sandbox model

- Tool approval is a hook ([`runtime/tools/tool-approval.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/tool-approval.ts)) feeding `SessionRuntime`.
- **Process isolation** via [`runtime/tools/subprocess-sandbox.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts): an RPC-over-IPC child process with a request/response protocol, **idle-timeout lifecycle** (child shuts down after N ms idle, next call transparently respawns), SIGTERM→SIGKILL grace (`SANDBOX_SHUTDOWN_GRACE_MS=300`), stderr tail capture (4 KB), and serialization-error handling. Used for plugins and JS helpers; can run under a compiled-bun launcher so no node/bun install is required on the host (`BUN_BE_BUN=1`). There is a `worker-sandbox.ts` variant too.
- Still **no OS-level sandbox** (no seccomp/landlock/namespaces) - isolation is process boundary + approval + cwd confinement (`restrictToCwd` in every executor rejects `..` escapes).

**→ HorizonCode changes:**
- HorizonCode already has `core/owned-spawn.ts`, `core/supervisor.ts`, `core/worker-identity.ts` (NF-071). The reusable detail from cline is the **idle-timeout respawn lifecycle** and the **compiled-runtime launcher** (`BUN_BE_BUN=1`) so a packaged HorizonCode binary can spawn JS helpers without a separate runtime. Neither repo delivers the OS sandbox HorizonCode's weakness list wants - so that remains a genuine differentiator HorizonCode should build (landlock spike already exists at `docs/audit/landlock-spike-2026-11-08.md`), not steal.
24. **Adopt `restrictToCwd` path confinement in every write-capable tool**, rejecting `..` escapes and accepting absolute paths only explicitly (cline does this uniformly in `editor.ts`/`apply-patch.ts`; opencode via `authorizeExternal`).

### B.8 LSP integration

Neither clone ships a live LSP loop in the agent core. opencode's `edit.ts` has an explicit `// TODO: Add LSP notification and diagnostics after LSP runtime exists.` cline's VS Code host uses editor diagnostics (`apps/vscode/src/integrations/diagnostics/`) but the SDK core does not. **Finding: there is nothing to steal here for the LSP-loop weakness; both are at parity with HorizonCode (none).** HorizonCode building a real post-edit diagnostics loop would be a differentiator, not a copy.

### B.9 Session / context management

- `run_commands` / `search` / read outputs are **middle-truncated** (start+end preserved) with explicit character budgets surfaced in the tool description (`MAX_COMMAND_OUTPUT_CHARS`, `MAX_SEARCH_OUTPUT_CHARS`, `MAX_READ_OUTPUT_CHARS`, `MAX_READ_LINES`) and remediation advice ("pipe through grep/head/tail," "narrow patterns beat broad ones"). This matches HorizonCode NF-074; the steal is **telling the model the budget inside the description**.
- Shell descriptions and skills descriptions are **live getters** re-evaluated per request (`Object.defineProperty(tool, "description", {get})`), so available skills and the active shell are always current without rebuilding tools.

**→ HorizonCode change:**
25. **Surface output budgets in tool descriptions** (not just enforce them silently) and render the **available-skills list as a live getter** in the skills tool description, matching `createSkillsTool`.

### B.10 MCP support

`sdk/packages/core/src/extensions/mcp/` and `services/mcp/` provide MCP client + registry (and an OAuth test server under `src/dev/mcp-oauth-test-server`). Parity with opencode conceptually; opencode's debounced-reconcile and result-normalization (A.11) are the more refined implementation to prefer.

### B.11 Provider abstraction - user-extensible registry

[`services/providers/local-provider-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/services/providers/local-provider-service.ts) + `local-provider-registry.ts`: users can **add any provider at runtime** with `{ providerId, name, baseUrl, apiKey, headers, timeoutMs, models[] | modelsSourceUrl, protocol, client, capabilities }`. Models are either listed manually or **discovered from `modelsSourceUrl`** (`fetchModelIdsFromSource`). Key safety properties:
- **Endpoint-owned catalogs fail loud:** for private/custom providers a failed model refresh (unreachable host, TLS, bad key) **reaches the caller** instead of yielding an empty list (`failOnError` branch) - the opposite of HorizonCode's silent-mock fallback.
- A `configured` vs `enabled` distinction (`isProviderSettingsUsable`) separates "has a persisted entry" from "has real credentials / a usable keyless endpoint."
- `protocol` + `client` fields select the wire adapter, so a new provider reuses an existing protocol (same idea as opencode A.6).
- Mutations are serialized through a per-file queue with rollback on write failure (`withProviderMutation`, `persistProviderUpdate`).

**→ HorizonCode changes (the complete fix for the closed-provider weakness):**
26. **Add a user provider registry.** Let a HorizonCode user register `{ name, baseURL, apiKey, protocol: "openai-compatible"|"anthropic", models[] | modelsSourceUrl }` in config, resolved by `makeProvider` via protocol rather than a hard-coded switch. Combined with #6 (fail loud) and #7 (openai-compatible adapter), this turns HorizonCode's 4-provider switch into an open, data-driven list without a file per vendor.
27. **Model discovery with fail-loud semantics.** When a custom/local provider (e.g. Ollama, vLLM) can't list models, surface the error - never fall back to an empty list or mock.

---

## PART C - Consolidated action queue for HorizonCode

Ordered by value ÷ effort. Each item cites the change number above. "New" = no existing NF owns it; "extends" = sharpens a landed NF.

| # | Change | HorizonCode area | Source | Disposition |
|---|---|---|---|---|
| 1 | Fail loud on unknown provider; stop defaulting to mock | `core/providers/index.ts` | opencode A.6 + cline B.11 | **new** - fixes named weakness; ~10 lines |
| 2 | `openai-compatible` protocol adapter | `core/providers/` | opencode A.6 | **new** - unlocks DeepSeek/Groq/OpenRouter/vLLM |
| 3 | User provider registry + fail-loud model discovery | `core/config.ts`, `core/providers/` | cline B.11 | **new** - the full open-list fix (#26,#27) |
| 4 | LF-view edit matching + per-region EOL preservation + "already applied"/closest-lines miss hint | `tools/edit.ts` | opencode A.4 | extends NF-069 |
| 5 | Shared `line-endings` helper across edit/write/(patch) | `tools/` | opencode A.4 + cline B.5 | extends NF-069 |
| 6 | Identical-tool-call loop detection (soft/hard) | `core/loop.ts`, `core/hooks.ts` | cline B.2 | extends NF-073 |
| 7 | Invalid-tool-JSON replay with raw-input error message | `core/loop.ts` | opencode A.2 | extends NF-073 |
| 8 | Command-guard for read-only/plan lane (masking + wrapper skip + redirect allowlist) | `tools/shell.ts`, `core/plan.ts` | cline B.4 | **new** |
| 9 | `apply_patch` tool (GPT-5 grammar, fuzz, Move) + model→tool routing | `tools/`, new routing table | cline B.5/B.6 | **new** |
| 10 | Cache-breakpoint planner (4 breakpoints, per-route table) | `core/providers/`, request builder | opencode A.8 | extends NF-005 |
| 11 | Batch-tolerant `read` with per-item errors + negative-offset tail | `tools/read.ts` | cline B.3 + opencode A.12 | extends NF-074 |
| 12 | Hold-then-swap background compaction keyed to cache TTL | `core/compaction.ts` | opencode A.10 | extends NF-075 |
| 13 | Debounced MCP reconcile + binary-resource spill + schema-gated JSON parse | `core/mcp/` | opencode A.11 | extends existing MCP |
| 14 | Typed decision helper (predicate/choice/score) for effort/difficulty routing | `core/metrics.ts`/`core/evals.ts` | opencode A.9 | extends omp C-11 |
| 15 | Per-request OS/shell in shell tool description; output budgets + live skills getter in descriptions | `tools/shell.ts`, `core/skills.ts` | opencode A.5 + cline B.9 | extends NF-074 |
| 16 | Per-parsed-command shell permission + resource-scoped durable grants | `tools/shell.ts`, `kernel/src/permm.rs` | opencode A.7 | extends kernel perms |
| 17 | Typed hook taxonomy (beforeModel/afterModel/beforeTool/afterTool/beforeRun/afterRun) | `core/hooks.ts`, `core/loop.ts` | cline B.1 | refactor; enables #6,#8 |
| 18 | Mistake taxonomy + "stopped, state preserved, resume" message | `core/loop.ts` | cline B.2 | extends NF-073 |
| 19 | `restrictToCwd`/`..`-escape rejection uniform across write tools | `tools/write.ts`,`tools/edit.ts` | cline B.7 + opencode A.7 | hardening |

### Deliberate non-steals
- **OS-level sandbox:** neither repo has one (opencode `edit.ts` TODO; cline is process-isolation only). HorizonCode's landlock direction is a genuine differentiator to *build*, not copy.
- **Live LSP loop:** absent from both agent cores. Also a build-not-steal opportunity.
- **opencode's effect-TS + drizzle/SQLite rewrite and 15 k-line session monolith:** steal the mechanisms (cache policy, decision API, edit engine, compaction discipline), not the framework or the sprawl.
- **cline's VS Code host layer:** HorizonCode is a TUI; take the SDK-core patterns, skip the webview/hostbridge.

---

## Appendix - key evidence paths

opencode:
- [`packages/ai/src/loop.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/loop.ts), [`packages/ai/src/cache-policy.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/cache-policy.ts), [`packages/ai/src/decision.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/decision.ts)
- `packages/ai/src/protocols/` (≈50 adapters by wire format)
- [`packages/core/src/tool/plugin/edit.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/plugin/edit.ts) (line-ending + miss hint), `shell.ts`, `mcp.ts`
- [`packages/core/src/tool/read-filesystem.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/read-filesystem.ts) (rope paging, caps)
- [`packages/core/src/session/runner/step.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/step.ts), [`runner/max-steps.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/max-steps.ts), [`runner/prompt/system.txt`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/prompt/system.txt)
- [`packages/core/src/session/compaction.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/compaction.ts) (background hold-then-swap)
- [`packages/core/src/permission/saved.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/saved.ts), [`permission/sql.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/sql.ts)
- [`packages/core/src/v1/config/provider.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/v1/config/provider.ts) (declarative provider/model schema)

cline:
- [`sdk/packages/core/src/extensions/tools/definitions.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/definitions.ts) (tool set + descriptions)
- [`sdk/packages/core/src/extensions/tools/command-guard.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/command-guard.ts) (mutation detector)
- [`sdk/packages/core/src/extensions/tools/model-tool-routing.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/model-tool-routing.ts)
- [`sdk/packages/core/src/extensions/tools/executors/editor.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/editor.ts), `apply-patch.ts`, `apply-patch-parser.ts`, `line-endings.ts`
- [`sdk/packages/core/src/runtime/safety/loop-detection.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/loop-detection.ts), `mistake-tracker.ts`, `rules.ts`
- [`sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts) (hooks)
- [`sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts)
- [`sdk/packages/core/src/services/providers/local-provider-service.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/services/providers/local-provider-service.ts) (user provider registry)

HorizonCode anchor points:
- `app/src/core/providers/index.ts` (silent mock fallback - change #1)
- `app/src/tools/edit.ts`, `app/src/tools/read.ts`, `app/src/tools/shell.ts`
- `app/src/core/loop.ts`, `app/src/core/hooks.ts`, `app/src/core/compaction.ts`, `app/src/core/mcp/`
- `app/src/contracts.ts`; `kernel/src/guard.rs`, `kernel/src/permm.rs`
- `docs/30-steal-list.md` (NF-071…NF-075 already landed)
