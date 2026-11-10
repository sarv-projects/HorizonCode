# Steal list: grok-build, Claude Code, DeepSeek Harness → HorizonCode

> Research-only report. No files in HorizonCode or the external repos were modified.
> Produced by deep-reading the three source trees plus Claude Code's published SDK/docs.
> Every claim cites a path. Where a source could not be located it is stated explicitly.

## 0. Sources located and confirmed

| Source | Location | Rev / nature | Language | Status |
|---|---|---|---|---|
| grok-build (xai-org) | [`xai-org/grok-build`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | `SOURCE_REV 559751f…`, synced from SpaceXAI monorepo | Rust | present, read |
| claude-code (anthropics) | [`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68) | `0ed9469`; **docs + examples + `mods/` only, not the agent source** | TS/docs | present, read + docs fetched |
| DeepSeek Harness (`dsh`) | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159) | `deepseek-ai/deepseek-harness`, "Everything is a Plugin", v0.2.2-rc.1 | TypeScript (Node ≥24.9, pnpm) | **identified and cloned this session**, read |

Finding the DeepSeek harness: the org has many repos (`DeepSeek-V3`, `-R1`, `DeepSeek-V3.2-Exp`, etc.); only `deepseek-ai/deepseek-harness` is an actual agent/coding harness (the V3.2-Exp repo is model inference code, 620 KB Python, not a harness). `deepseek-harness` was cloned via the gateway HTTPS remote into `deepseek-harness` (see [upstream-pins.md](upstream-pins.md)) (20,665 files).

Note on Claude Code: the public `anthropics/claude-code` repo is **not** the agent implementation. It ships the CHANGELOG, the `mods/` function-hook packs (`agents-md`, `sec-default`, `privacy`, `diff`, `telemetry`), enterprise `examples/` (settings, MDM, gateway, hooks), and the plugin marketplace manifest. The architecture below is drawn from those artifacts plus the published docs (SDK overview, hooks reference, subagents, IAM) fetched this session.

HorizonCode grounding (confirmed by reading): `app/src/contracts.ts` (419 lines, the frozen TS/Rust contract), `app/src/core/loop.ts` (sentinel rails `MAX_PROVIDER_CALLS=25`, `MAX_CONSECUTIVE_FORMAT_ERRORS=3`, `concurrencyClassOf`, `batchSegments`, `admissionFor`), `app/src/core/providers/` (anthropic/openai/google/ollama/mock/scripted/retry/sse), `app/src/tools/` (read/write/edit/grep/glob/shell/todo + repo-map/agent/codemode/preview/undo), `app/src/core/` (kernel, subagent, review, curator, postmortem, evals, output-budget, owned-spawn, supervisor, worker-identity, hooks, mcp). HorizonCode has already consumed an aider/mini-swe/hermes/oh-my-pi steal wave (`docs/30-steal-list.md`, NF-071…NF-075); this report deliberately targets mechanisms those four did **not** supply.

---

## 1. DeepSeek Harness (`dsh`) - the deepest and most directly transferable source

### 1.1 Overall architecture

`dsh` is a microkernel where **every part is a Cordis plugin** - the model adapter, tool registry, session log, and *the agent loop itself* are plugins mounted into a shared context (`docs/architecture.md`: "There is no privileged core to patch"). Composition is declarative:

- **Profiles** (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) stack ordered **bundles**; `dsh-base` is the shared first layer (model adapters, tools, persistence, sandbox+approval policy, settings, credentials, telemetry) (`docs/architecture.md` §Profiles and bundles).
- **Capability seams**: every swappable capability has three roles - *Service Definition* / *Service Provider* / *Consumer* (`packages/core/README.md`, `AGENTS.md` conventions). One provider swap changes the whole product: pointing the fs+subprocess providers at a remote sandbox moves Bash, PTY, and LSP with them "with no provider forks."
- **Registrations are effects**: `ctx.effect()`/`ctx.on()` return disposers; unloading a plugin unwinds its contributions.

The package list is the clearest catalog of a mature harness anywhere in these three repos (`packages/*`): `core` (agent/agent-loop/tools/system-prompt/scope/session), `llm`, `shell`, `subprocess`, `ssh`, `terminal`, `ptc-runtime`, `sandbox`, `fs`, `lsp`, `skill`, `web`, `computer-use`, `browser-use`, `compaction`, `context`, `subagent`, `team`, `jobs`, `workflow`, `todo`, `plan`, `goal`, `schedule`, `preset`, `guard`, `extensions`, `session`/`session-query`, `spill`, `deliverables`, `mcp`, `acp`, `sdk`, `host`/`client`, plus `python/` and `native/` (node-addon-system).

### 1.2 Agent loop ([`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts))

The loop is a precise state machine worth reading line by line. Key mechanisms:

- **Turn vs step**: a *step* = one model request + its tools; a *turn* = ≥0 steps, opens before first input is claimed and closes "once nothing is owed." The documented flow (`docs/architecture.md` §Turn flow) names every durable event: `turn/start`, `step/start`, `request/header`, `request/context`, `assistant/message | assistant/attempt`, `tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*`, `step/end`, `turn/end`.
- **Model-visible ⟺ logged** invariant: every model request must be reconstructable from the session log; a new model-visible input *requires* a session event (`AGENTS.md`, [`packages/llm/llm/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/README.md)). History is derived by `deriveMessages()`, never held as mutable in-memory state.
- **Inbox with three admission targets** on one queue: `followup` (`next-turn`), `steer` (`next-step`, waking), `inject` (`next-step`, non-waking) - `agent.ts` `send/followup/steer/inject`. Steering joins an in-flight turn at the next step boundary; a wake sent after an abort is reclassified to start the next turn.
- **Request series + KV-cache discipline**: `request/header` records `initial | resume | change | series`; `startsSeries` is set when the surface generation changed or tools changed. The loop appends a `developer/message` with typed `tool-addition`/`tool-removal` blocks when the tool set changes mid-session instead of rewriting the prefix.
- **`systemPromptUpdate: 'in-history'`**: when a model reads the latest `system` message *at any position*, a changed system prompt is **appended after** the cached history rather than rewriting the leading system message - so the KV-cache prefix stays reusable through a prompt change ([`packages/core/system-prompt/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/system-prompt/README.md), [`packages/llm/llm-deepseek/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-deepseek/README.md)). This is a concrete cache-preservation technique HorizonCode's cache-guard discipline does not yet have.
- **Structured, sticky turn-end**: `turn/end.reason` is a closed union `completed | max-tokens | blocked | aborted{reason} | error{message,code}`; `max-tokens` is *sticky* across later completed steps. Failures flatten to `errorChain` text under code `UNKNOWN` unless they are `LlmError` (keeps `failure`) or `ToolActivationError` (keeps code).
- **Tool-result recovery on step failure**: a `ToolCallRecovery` observer appends missing `tool/result` events if the step throws, so the pairing invariant is never broken (an `AggregateError` is raised if even recovery fails).
- **Retry is a plugin, not loop code**: `dsh-llm-retry` re-runs failed requests at the `agent/request-error` waterfall extension point; the loop itself issues exactly one provider attempt per step.

### 1.3 Tool design and pipeline ([`packages/core/tools/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/README.md))

- `defineTool` declares typed params (a schema DSL supporting `string/number/integer/boolean/null/array/object/json/oneOf`, type-preserving through 16 container levels), a canonical `output` declaration, `render`, cooperative `timeoutMs`, parallel-safety, and *optional* host presentation - "nothing is a blind string exec."
- **Four-stage waterfall + monotonic guard**: `tools/pre-execute` (reorderable allow/deny/ask) → `ctx.tools.guard()` (monotonic, a denial can never be un-denied) → `tools/execute` (around-dispatch wrapper for timeout/retry/metrics) → `tools/post-execute` (inspect/replace content or value, attach `additionalContexts`) → definition `finalizeContent` → observe-only `tools/result`.
- **Conditional tools**: `register(def, { when })` evaluated once per step with `{agent, modelSelection, signal}`; false removes the tool from the description *and* bindings; a throw fails step prep as `TOOL_ACTIVATION_FAILED`.
- **Per-agent restriction**: `ctx.tools.restrict(filter)` intersects allow/deny masks; `schemas(scope)` returns wire schemas without `execute`.
- **Failure never ends the turn**: unknown/throwing tools become `UNKNOWN_TOOL` structured errors returned as `Error: <message>`; structured detail stays log-only.
- **Two executors behind one registry**: `tool-executor-native` (schemas exposed directly) vs `tool-executor-ptc` (exposes only `run_code` + a generated SDK). Same scope, one executor.

### 1.4 PTC runtime - the direct analogue of HorizonCode `code_mode`

[`packages/core/tool-executor-ptc/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tool-executor-ptc/README.md): the model writes an async function body for `run_code`; tools become `await tools.name(args)` SDK bindings. Mechanisms HorizonCode's `code_mode` should consider:

- **Tool-call allowance tied to timeout**: `floor(timeoutMs/60000 × maxSubCallsPerMinute)` total sub-calls (default 2048 for a 2-min run); exhaustion terminates the whole program with a message that names the limit, the rejected call number, and an infinite-loop warning.
- **Concurrency via SDK**: "independent read-only calls MAY overlap under `Promise.all`; mutating calls run alone, in submission order" - the concurrency contract is taught *in the SDK instructions*, reusing the native executor's shared/exclusive classification.
- **Intermediate values stay out of context**: only what the program prints/returns reaches the conversation; a successful image sub-result is appended after the run as source-attributed context. Direct token saving.
- **`run_code` is exclusive and serial at the root; sub-calls use `<parent>:ptc:<n>` ids**; retained-environment reset (`reset(agent)`) with a queued "environment reset" notice.

### 1.5 Sandbox - fail-closed with an escalation ladder ([`packages/sandbox/sandbox/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/README.md))

- Three modes carried **per call** (`SandboxPolicy` rides the call, never fixed on the provider): `read-only`, `workspace-write`, `danger-full-access`.
- **Fail closed**: if the requested mode cannot be enforced, the call fails with `SANDBOX_UNAVAILABLE` and a message naming the missing runner - *never* runs unconfined.
- **Enforcement completeness is reported per call** (`full` vs `partial`), so a consumer that needs the absolute boundary can reject a `partial` (older Landlock ABI, Windows ACL rung).
- **Closed escalation ladder**: a denied call surfaces `[sandbox: file access denied under <mode> mode]` + a hint; the model may retry *the exact call once* with `sandbox_permissions` (narrowest wider mode) + `justification`; a wider mode needs approval and applies to that one call only. The ladder is a closed table checked at execution, never baked into the tool schema enum.
- Backends: Linux bubblewrap + Landlock, macOS Seatbelt, Windows ACL restricted-token (`packages/sandbox/sandbox-local`, `sandbox-windows-acl`).

### 1.6 Subagents - one seam, many providers incl. **external agents** ([`packages/subagent/subagent/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md))

- Providers: `spawn-in-process`, `fork-in-process`, `acp`, `dsh-sdk`, **`codex`**, **`claude-code`**. Local children keep durable sessions and accept follow-ups; external children (ACP/SDK/Codex/Claude Code) execute **once** and return a final answer, with reasoning/tool-traffic/stderr kept out of the parent session ([`subagent-claude-code/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent-claude-code/README.md)).
- **Capacity + depth as separate policies**: `maxActiveSubagents` (default 8, per subagent tree; root consumes no slot), `maxDepth` (default 1). At capacity → `ACTIVATION_LIMIT_REACHED` (no queuing, because a parent must not wait on its own slot).
- **Names**: sibling-unique `agent-N` or chosen `[a-z][a-z0-9-]{0,31}`; the root is always `lead`; a descendant's full name is the slash-path (`reviewer/checker`).
- **Delegation-scope statement injected into every child**: "your permission scope was fixed when you were started and cannot be widened… do not retry the denied operation; state the limitation in your reply." Prevents children from burning turns on denied escalations.
- **Return guidance**: the parent gets only the child's final answer ("the parent does not receive your full transcript, tool output, or reasoning").

### 1.7 Loop-hygiene guard ([`packages/guard/repeat-tool-reminder/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/guard/repeat-tool-reminder/README.md))

Advisory, never a veto: at configurable repeat counts (default `[3,5,8]`) of the *exact* same tool call (deep key-sorted canonical args), it injects a reminder as a source-attributed synthetic `user/message` after the result. Counted in `tools/post-execute` (so denied calls count too); a new user prompt clears the chain; per-agent `WeakMap`; interleaved bookkeeping tools (e.g. `todo_write`) don't launder a loop.

### 1.8 Compaction family ([`packages/compaction/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/README.md))

Split into: `compaction-basic` (auto-condense older history as token pressure builds), `compaction-tool-result-pruner` (trim oversized tool outputs *before* condensing), `compaction-image-offload` (replace over-budget images with placeholders when the route rejects, logged as one `image/offload` event and retried), and `command-compact` (`/compact`, serialized against running turns). Token measurement lives in a separate LLM-family service (`token-meter`), replay-aware.

### 1.9 LLM provider seam ([`packages/llm/llm/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/README.md))

- "The logical contract is provider-neutral, adapters own the wire." One canonical message/block/`StreamChunk` vocabulary; each stream is **one provider attempt** ending in exactly one terminal `finish` chunk (`{kind:'error'|'aborted', failure}`), with **stable failure codes** (`NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`) - "consumers route on the code, never message text."
- **Configurable providers activated from config without restart**: adapters declare `LlmConfigurableProvider` with `defaultBaseURL`, `nativeAuth`, `baseURLEnv`; config UIs read the directory without calling the adapter. New model ids pass through to the wire with no re-registration.
- **Capability negotiation up front**: a request is validated against the exact model (context window, output default, reasoning efforts, input modalities, `systemPromptUpdate`) *before* any I/O; adapter default output cap is materialized when omitted.
- **File/image projection is unconditional and deterministic**: no provider ever receives file bytes - every `FileBlock` becomes one deterministic handle line naming a saved read-only path; images become route-specific versions only for image-capable routes, else deterministic placeholders. Image offload is a logged, budget-driven event (`IMAGE_OFFLOAD_REQUIRED`).
- **Per-model tuning as data**: `llm-deepseek` config carries `reasoningEffort` (`off|low|high|max` → `output_config.effort`), `maxTokens`, `defaultContextWindow`, image budgets, Files-API reuse policy, retry policy - all re-read per operation via a thunk; only the retry policy is captured at registration (re-registered in place on change so no request sees a gap).

### 1.10 Other notable `dsh` mechanisms

- **Deliverables** (`packages/deliverables`): a `present` tool declares final files; a workspace-changes recorder captures per-turn changed files with line counts from git snapshots - rendered at end of turn. Client-only events, not model-visible.
- **Runtime self-modification** (`packages/extensions`): `tool-cordis` gives the agent two read-only runtime-API discovery tools plus a sandboxed host/client runner for dynamic plugins.
- **Spill** (`packages/spill`): output spill-to-artifact as its own capability (HorizonCode already has `<state>/spills/<sha256>.txt`; `dsh` models it as a seam).
- **Jobs / schedule / workflow / team / goal / plan** each as their own seam with their own tools (`job_*`, scheduled follow-ups, Rhai-like workflow, shared task board).
- **100% per-file coverage gate**, keyless recorded-session snapshot tests, cross-file duplication detection, and "Both SDKs project the loop" (TS+Python SDK expected outputs updated in the same PR) - a testing discipline model.

---

## 2. grok-build (xai-org) - Rust, strongest on network egress, edit anchoring, and multi-dialect tools

Repository layout (`README.md`): `xai-grok-shell` (runtime + leader/stdio/headless entry), `xai-grok-tools`, `xai-grok-workspace` (fs/VCS/exec/checkpoints), `xai-grok-pager` (TUI), plus ~80 codegen crates. The root `Cargo.toml` is generated/read-only.

### 2.1 Egress proxy - per-origin network authority ([`crates/codegen/xai-grok-egress-proxy/src/decider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/decider.rs))

This is the single most distinctive grok capability and HorizonCode has **nothing like it**.

- A `Decider` sits between request authentication and any DNS/upstream connect: `decide(origin, call) → Allow | AllowAndRecord{would} | Deny | Ask`. `Ask` **parks the connection** (nothing relayed) until answered, the hold deadline passes, or the client hangs up.
- **Two-level hold budgets**: `DEFAULT_MAX_HELD = 16` across the proxy, `DEFAULT_MAX_HELD_PER_CALL = 8` per credential (per `CommandTag`) so one command's unanswered asks can't pin every slot; over-budget asks get `503 overloaded`. `DEFAULT_HOLD_TIMEOUT = 600s` then auto-`403 denied`.
- **Observe mode**: `AllowAndRecord{would: Allowed|Denied(DenySource)|Asked}` records what enforce mode *would* have done per host without blocking - a safe rollout path for a network policy. `DenySource` distinguishes a per-host deny row from the org `disallowed_web_fetch_domains`.
- Content-free `BlockedRequest` records feed UI cards and logs (`BLOCKED_REQUEST_CAPACITY = 256`). Paired with `xai-grok-sandbox/network_policy.rs` + `child_net.rs` + `runtime_sockets.rs`.

### 2.2 Hashline edit anchors ([`crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs))

A read/edit format that attaches a freshness anchor to every line, so edits can be addressed by `LINE:LOCALHASH[:CONTEXTHASH]` and the harness can *prove the model's view of the file is current* and auto-recover small shifts.

- Three pluggable `AnchorScheme`s: **ContentOnly** (`LINE:hash`, whitespace-normalized line hash, survives indentation change, weakest freshness), **ChunkFingerprint** (`LINE:hash:chunkfp` over 16-line chunks - an edit anywhere in the chunk staleness-invalidates the anchor), **CheckpointChain** (`LINE:hash:chainfp` chained from the nearest 32-line checkpoint - strongest freshness, more churn).
- `validate() → Valid | Stale | OutOfRange`; `find_shifted()` searches `±15` lines, returning `Found{new_line} | Ambiguous{candidates} | NotFound` - a cheap local-hash prefilter before the full context check. Truncated anchors that drop the context component are rejected as `Stale` (can't silently degrade to content-only).

This is a materially stronger anchor than HorizonCode's edit ladder: it moves staleness detection into the address itself and gives deterministic, bounded shift recovery.

### 2.3 Multi-dialect tool compatibility (`xai-grok-tools/src/implementations/`)

grok ships *parallel tool implementations* for other harnesses' names/semantics: `codex/` (`apply_patch`, `grep_files`, `list_dir`, `read_file`), `opencode/` (`bash`, `edit`, `glob`, `grep`, `read`, `write`, `todowrite`, `skill`), `claude_alias.rs`, plus its own `grok_build`, `grok_build_concise`, `grok_build_hashline`. The `tool_taxonomy.rs` defines a harness-independent `ToolKind`/`ToolNamespace` vocabulary with a canonical `_meta` envelope (`x.ai/tool`, versioned) and `presentation_name()` mapping (`read_file`/`Read` → "Read"). One model can be driven with the tool dialect it was trained on.

### 2.4 Permission rules (`crates/codegen/xai-grok-permission-rules/`)

- **Bash command splitting + per-sub-command risk** (`bash_command_splitting.rs`, `bash_permission_script.rs`, `exec_risk.rs`, `env_risk.rs`) - a compound shell line is split and each segment risk-scored, rather than approving the whole string.
- **Reads Claude Code settings** (`claude_settings.rs`) - interop with [`.claude/settings.json`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/.claude/settings.json) allow/ask/deny.
- **Folder trust + source identity** (`folder_trust.rs`, `source_identity.rs`, `trust.rs`) - a program named by a workspace stays off until the folder is trusted (matches HorizonCode's project-config-safety principle, but implemented).
- **Managed policy** (`managed_policy/`) and `git_content_filters.rs` (filter secrets out of git content the model sees).

### 2.5 Memory with "dream" consolidation (`crates/codegen/xai-grok-memory/`)

A v2 memory store (`storage_v2.rs`, `v2_capture.rs`, `v2_consolidation.rs`, `v2_carryover.rs`, `MEMORY.md` manifest, SQLite state) with **batch "dream"** background consolidation (`batch_dream*.rs`: catalog, plan, outline, commit, recovery, session, with a `dream_lock.rs`). Retrieval uses embeddings + BM25 + **MMR** (`mmr.rs`) + query expansion (`query_expansion.rs`). Enforces **read-before-write on self-edits** and protected `MEMORY.md`, writable only under `topics/` and `observations/_inbox/` (see the test policy in [`grok_build_hashline/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/mod.rs) `FakeMemoryV2Access`). HorizonCode has NF-075 growth-loop v1 (review fork + curator) but no retrieval/consolidation engine; grok's is a working reference.

### 2.6 Other grok notables

- **Server-side ("hosted") tools** ([`xai-grok-agent/src/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/agent.rs)): `hosted_tools: Vec<HostedTool>` sent as native Responses-API types (e.g. `WebSearch`) executed server-side by the agentic sampler, ANDed with per-model `supports_backend_search`. HorizonCode executes all tools locally.
- **Compact system prompt for post-compaction** (`agent.rs` `compact_system_prompt()` / `COMPACT_SYSTEM_PROMPT`) and an **AGENTS.md `<system-reminder>`** injected as a user message with audience-aware compaction for subagents (`agents_md_user_reminder()`).
- **Fast worktree / checkpoints** (`xai-fast-worktree`, `xai-grok-workspace`), **crash handler**, **circuit breaker** (`xai-circuit-breaker`), **interjection** (live steering, `xai-interjection-core`), **egress-aware web-fetch**, **otel**.

---

## 3. Claude Code - the extensibility, permission, and lifecycle-hook reference

(Agent source is closed; below is from `anthropics/claude-code` artifacts + published docs.)

### 3.1 Agent SDK as the product surface (`code.claude.com/docs/en/agent-sdk/overview`)

Claude Code *is* a library ("the same tools, agent loop, and context management… programmable in Python and TypeScript"). Capabilities exposed through the SDK: built-in tools, hooks, subagents, MCP, permissions, sessions (resume/fork), skills/commands/memory (loaded from `.claude/` and `~/.claude/`), plugins. Non-Python/TS consumers run the CLI as a subprocess with `-p --output-format json` (headless). This is the model for HorizonCode's "protocol is the API / SDKs" roadmap item, which is designed but not shipped.

### 3.2 Hook lifecycle - a far richer event surface than HorizonCode (`code.claude.com/docs/en/hooks`)

Hooks can be shell commands, **HTTP endpoints**, **MCP tool calls**, **LLM prompts**, or **subagents**. Three cadences: per-session (`SessionStart`, `SessionEnd`), per-turn (`UserPromptSubmit`, `Stop`, `StopFailure`), per-tool-call (`PreToolUse`, `PostToolUse`). The full documented event set includes `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart/Stop`, `TaskCreated/TaskCompleted`, `PreCompact/PostCompact`, `PreModelSwitch/PostModelSwitch`, `Elicitation/ElicitationResult`, `WorktreeCreate/Remove`, `Notification`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`.

Hook control via exit code is a clean contract ([`examples/hooks/bash_command_validator_example.py`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/hooks/bash_command_validator_example.py)): **exit 2 blocks the tool and shows stderr to Claude**; exit 1 shows stderr to the user only; exit 0 proceeds. The example rewrites `grep`→`rg` guidance as a `PreToolUse` Bash hook.

**Mods** (`mods/`): a plugin can register hooks as in-process JS functions that can also draw UI (`mods/agents-md` is a worked example - it owns AGENTS.md discovery/insertion as a hook pack with `files/`, `frames/`, `modes/`, `switches/`, `telemetry/`). HorizonCode's `app/src/core/hooks.ts` exists but the event taxonomy is far smaller.

### 3.3 Permissions, managed settings, and sandbox (`examples/settings/`, `examples/mdm/`, `docs/en/iam`)

- **Permission modes**: `default`, `acceptEdits`, `plan`, `auto` (safety-reviewed), `bypassPermissions`. Rules are `allow`/`ask`/`deny` lists keyed by tool (`settings-strict.json`: `ask:["Bash"]`, `deny:["WebSearch","WebFetch"]`).
- **Settings hierarchy with managed override**: enterprise `managed-settings.json` can set `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `strictKnownMarketplaces`, `disableBypassPermissionsMode` - blocking user/project-defined rules/hooks entirely. Deployed via MDM (Jamf/Kandji/Intune/Group Policy templates in `examples/mdm/`).
- **Bash sandbox** (`settings-bash-sandbox.json`): `sandbox.enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, and a **network block** (`allowedDomains`, `allowUnixSockets`, `allowLocalBinding`, `httpProxyPort`, `socksProxyPort`). Note the documented scope limit: the sandbox applies only to Bash, not to Read/Write/WebSearch/WebFetch/MCP - a cautionary contrast with HorizonCode's kernel-enforced, all-tool model.
- **CI hardening pattern** (`CLAUDE.md`): egress-firewall runner + `egress-firewall.yaml` allowlist (`mode: enforce`) + `--permission-mode auto`, enforced by a `workflow-hardening.yml` check. This mirrors grok's egress proxy at the CI layer.

### 3.4 Subagents (`code.claude.com/docs/en/sub-agents`)

Each subagent has its own context window, system prompt, tool access, independent permissions, and may use a cheaper model (Haiku). Built-ins **Explore** (fast read-only) and **Plan** start *without* CLAUDE.md and git-status to keep research cheap (`omitClaudeMd` frontmatter). Delegation is description-driven; Claude warns when non-built-in subagent descriptions exceed **15,000 tokens** of combined context - a budget discipline HorizonCode's `agent` tool lacks.

---

## 4. Mapped steal list → concrete HorizonCode changes

Ordered by value ÷ effort. Each row cites the source mechanism (§ above) and the HorizonCode file/area to change. "New" = no current owner; "Extend" = sharpens an existing NF/doc/file.

### Tier 1 - cheap, local, high value

| # | Steal | Source | HorizonCode change |
|---|---|---|---|
| T1-1 | **`systemPromptUpdate: 'in-history'`** cache-preserving prompt update: append a changed system prompt after cached history instead of rewriting the leading message. | dsh §1.2/1.9 | `app/src/contracts.ts` (add a per-model capability flag to the provider model info) + `app/src/core/providers/anthropic.ts`/`openai.ts` + `loop.ts` request assembly. Directly strengthens the existing cache-guard (NF-005). |
| T1-2 | **Repeat-tool reminder guard** at `[3,5,8]` exact-repeat counts, advisory, injected as a source-attributed synthetic user message after the result, cleared by a new user prompt. | dsh §1.7 | New `app/src/core/guards/repeat-tool.ts` hooked after tool results in `loop.ts`; reuses the existing additional-context injection path. Low risk, catches stuck loops. |
| T1-3 | **Stable provider failure codes + route-on-code** (`NO_ADAPTER`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, …) with a single terminal finish shape. | dsh §1.9 | `app/src/core/providers/index.ts` + each provider; define the code union in `contracts.ts`. Makes `retry.ts` and compaction triggers deterministic instead of string-matching. |
| T1-4 | **Subagent delegation-scope statement** + **return guidance** injected into every child ("scope fixed, don't retry denied ops, state the limitation"; "parent gets only your final answer"). | dsh §1.6 | `app/src/core/subagent.ts` / `app/src/tools/agent.ts`. Stops children burning turns on denied escalations. |
| T1-5 | **Subagent description token budget** warning (>15k combined) and **`omitClaudeMd`-style** lean research children. | CC §3.4 | `app/src/tools/agent.ts` + skills/instructions loading; add a lean read-only "explore" preset. |
| T1-6 | **PTC tool-call allowance tied to timeout** + infinite-loop termination message; teach read-only concurrency in the SDK instructions. | dsh §1.4 | `app/src/tools/codemode.ts` + `codemode-child.ts`. HorizonCode's code_mode currently lacks a per-program call ceiling. |
| T1-7 | **Bash command splitting + per-segment risk scoring** instead of approving a whole compound command string. | grok §2.4 | `app/src/core/loop.ts` `guardActionFor`/`admissionFor` + a new splitter; feeds the kernel `Shell(...)` guard with per-segment actions. |

### Tier 2 - next capability wave

| # | Steal | Source | HorizonCode change |
|---|---|---|---|
| T2-1 | **Hashline edit anchors** (`LINE:localhash:chunkfp`) for read/edit: prove the model's file view is current, auto-recover ±15-line shifts, reject truncated anchors. | grok §2.2 | `app/src/tools/read.ts` + `edit.ts` + a new `anchor.ts`; extends the NF-069/052 edit ladder with address-level staleness instead of whole-block re-matching. The three-scheme trait is directly portable. |
| T2-2 | **Sandbox fail-closed + per-call escalation ladder + enforcement-completeness report** (`full`/`partial`), closed wider-mode table checked at execution. | dsh §1.5 | `kernel/` guard + `app/src/core/kernel.ts`; HorizonCode has the kernel and postures but no documented one-call escalation flow or `partial`-enforcement surface. Aligns with the designed sandbox matrix (README §3.4). |
| T2-3 | **Richer hook lifecycle** - add `PreCompact/PostCompact`, `SubagentStart/Stop`, `PermissionRequest/Denied`, `PreToolBatch/PostToolBatch`, `SessionStart/End`, plus HTTP and prompt hook transports and the **exit-2-blocks** contract. | CC §3.2 | `app/src/core/hooks.ts` + `loop.ts` emit points. HorizonCode fires few events today; this is the extensibility surface the README §3.7 promises. |
| T2-4 | **Four-stage tool pipeline** (`pre-execute` allow/deny/ask → monotonic guard → around-dispatch `execute` → `post-execute` replace/attach-context → observe `result`) with conditional tools and per-agent restriction masks. | dsh §1.3 | Refactor `app/src/tools/index.ts` + `loop.ts` dispatch into named stages; currently guard+approval are entangled in the loop. Enables T1-2, T2-3, and metrics wrappers cleanly. |
| T2-5 | **Compaction split** - a tool-result pruner that trims oversized outputs *before* summarizing, and image-offload logged as one event + retry. | dsh §1.8 | `app/src/core/compaction.ts` + `output-budget.ts`; extends NF-074. |
| T2-6 | **Deliverables recorder** - `present` tool + per-turn changed-file list with line counts from git snapshots, rendered at end of turn. | dsh §1.10 | New `app/src/core/deliverables.ts` + TUI card; uses existing change-journal (`app/src/tools/change-journal.ts`). |
| T2-7 | **Multi-dialect tool compat** - optional `codex`/`opencode`/`claude` tool-name aliases over one canonical `ToolKind` taxonomy so a model runs with the dialect it was trained on. | grok §2.3 | `app/src/tools/index.ts` + a taxonomy module; pairs with the closed-provider-list weakness (lets a new provider's native tool dialect be served). |

### Tier 3 - larger / strategic

| # | Steal | Source | HorizonCode change |
|---|---|---|---|
| T3-1 | **Egress proxy with per-origin ask/allow/deny, parked connections, two-level hold budgets, and observe mode.** HorizonCode has *no* network-egress authority today. | grok §2.1 + CC §3.3 | New `kernel/` egress capability + `app/src/core/` proxy client; the strongest single safety gap versus both competitors. Observe mode gives a safe rollout. |
| T3-2 | **External agents as subagents** - run Claude Code / Codex / an ACP agent as a one-shot child that returns only a final answer. | dsh §1.6 | New providers behind `app/src/core/subagent.ts`; realizes the README "superset" claim concretely. |
| T3-3 | **Capability-seam discipline** (Service Definition / Provider / Consumer) applied to fs/subprocess/shell/sandbox so a remote-sandbox swap moves all execution tools at once. | dsh §1.1 | Architectural: formalize the seams HorizonCode already half-has (`kernel.ts` is a provider; providers/ is a seam). Enables the designed remote-execution + container surfaces (README §3.8) without per-tool forks. |
| T3-4 | **Agent SDK / headless `-p --output-format json`** surface so non-TS callers drive the same loop. | CC §3.1 | `app/src/main.ts` headless mode already exists; add a JSON-RPC/stdio SDK per README §3.6 (designed, not shipped). |
| T3-5 | **Memory retrieval + background "dream" consolidation** (embeddings + BM25 + MMR + query expansion; read-before-write self-edits; protected manifest). | grok §2.5 | Extends NF-075 growth loop (`app/src/core/curator.ts`, `review.ts`); grok's `v2_consolidation.rs`/`mmr.rs`/`batch_dream*.rs` are a working reference for the retrieval engine HorizonCode lacks. |
| T3-6 | **Server-side hosted tools** (web search executed by the provider) ANDed with per-model capability. | grok §2.6 | `app/src/core/providers/*` + tool registry; lets web_search run without a local egress path on providers that support it. |

### What NOT to copy (deliberate refusals)
- Claude Code's **Bash-only sandbox scope** (sandbox does not cover Read/Write/MCP/hooks) - HorizonCode's kernel-enforced all-tool model is strictly better; adopt CC's *network allowlist shape*, not its coverage gap.
- grok's **generated monorepo `Cargo.toml`** and 80-crate sprawl - steal the mechanisms (egress, hashline, memory), not the crate explosion.
- dsh's **full Cordis framework dependency** - adopt the *capability-seam contract* and the loop/tool/guard mechanisms as native TS, not the Cordis runtime itself (the AGENTS.md "plugins, not loop changes" discipline is the transferable part).

---

## 5. Cross-source convergence (highest-confidence signals)

Mechanisms that appear in **two or more** independent sources are the safest bets:

1. **Structured per-call network egress control** - grok egress proxy (enforced) + Claude Code bash-sandbox network allowlist + CI egress firewall. HorizonCode gap. → T3-1.
2. **Fail-closed sandbox with a per-call escalation ladder** - dsh (full mechanism) + Claude Code permission `auto` mode with safety review. → T2-2.
3. **Rich, typed tool pipeline with pre/post hooks and allow/ask/deny** - dsh four-stage pipeline + Claude Code hook events + grok permission-rules. → T2-4 / T2-3.
4. **Subagents with own context/tools/permissions/model + lean research presets** - dsh subagent seam + Claude Code Explore/Plan built-ins. → T1-4 / T1-5.
5. **KV-cache-preserving prompt/tool updates** - dsh `in-history` + the shared "append, don't rewrite" discipline (already in HorizonCode's cache-guard, but not for prompt updates). → T1-1.
6. **Multi-dialect / provider-neutral tool + model layer** - grok tool dialects + dsh provider-neutral LLM seam with config-activated providers. Addresses HorizonCode's closed-provider-list weakness. → T2-7 / T1-3.
