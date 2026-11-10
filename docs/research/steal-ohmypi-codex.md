# Steal list: oh-my-pi and codex → HorizonCode

Research report (Phase 1, read-only). Deep-dive of two cloned agents, mapped to concrete HorizonCode changes.

- Target: this repository (HorizonCode) (TS/Bun `app/`, Rust `kernel/`, `ops/`, `docs/`).
- Sources: [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296) (OMP; TS workspace + Rust `pi-*` crates), [`openai/codex`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053) (OpenAI Codex; Rust `codex-rs/`).
- Known HorizonCode weaknesses this report targets: 51 TS typecheck errors / typecheck not in CI; closed provider list with silent mock fallback; no OS-level sandbox; missing conversational rewind, LSP loop, server mode, cross-process locking.

Note on overlap: HorizonCode already ran a prior oh-my-pi pass (`docs/30-steal-list.md`, items NF-071…NF-075). This report re-verifies those against current source, adds what that pass missed (OMP LSP/DAP, speculative execution, bash PTY selection), and treats codex as a fresh source (not in the prior steal list). Items new relative to `docs/30` are tagged **[NEW]**.

---

## Part 1 - codex (`codex-rs/`)

### 1.1 Overall architecture

- Rust workspace, ~128 crates under `codex-rs/`. Core agent is `codex-rs/core` (~276k LoC incl. tests). Separate crates for sandboxing (`linux-sandbox`, `windows-sandbox-rs`, `mxc-sandbox`, `bwrap`), command policy (`execpolicy`), edit format (`apply-patch`), app/server protocol (`app-server`, `app-server-protocol`), MCP (`codex-mcp`, `rmcp-client`), TUI (`tui`), and an **app-server daemon** (`app-server-daemon`) - a long-lived server process other clients attach to.
- Clean separation HorizonCode lacks: the exec/sandbox layer is its own set of crates (`exec-server`, `exec-server-protocol`, `linux-sandbox`) invoked by the standalone `apply_patch` and `unified_exec` paths. This is the "trust kernel out-of-process" idea HorizonCode started with `kernel/` but did not extend to shell/edit execution.
- `codex-rs/core/src/session/` is the loop home: `turn.rs` (3.8k LoC), `session.rs`, `mod.rs` (6.1k), plus `compact*.rs` (a whole family of context-compaction strategies).

### 1.2 Agent loop

- Loop lives in [`core/src/session/turn.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/turn.rs) + `stream_events_utils.rs`. It streams Responses-API events, dispatches tool calls through `ToolRouter`, and tracks a per-turn diff via `turn_diff_tracker.rs`.
- **Parallel tool calls with a per-tool capability flag.** `tools/router.rs::tool_supports_parallel()` → `registry.supports_parallel_tool_calls(name)`. Tools opt in; the loop batches those and serializes the rest ([`tools/parallel.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/parallel.rs)). Same mechanism HorizonCode already adopted as NF-072, confirmed here on a second independent source.
- **Streaming retry with server-advised backoff that cannot extend configured limits.** [`core/src/responses_retry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/responses_retry.rs): separate `retries` vs `connection_retries`, `INITIAL_CONNECTION_RETRY_DELAY = 5s`, `MAX_CONNECTION_RETRY_DELAY = 60s`; server `Retry-After` controls *timing* but never raises the retry *count*. Comment: "Server advice controls timing without extending configured retry limits."
- **Turn diff tracker.** `turn_diff_tracker.rs` accumulates a single unified diff across all edits in a turn and emits a `TurnDiffEvent` - a structural "here is everything that changed this turn" surface, independent of per-tool output.

### 1.3 Tool design and tool set

- **Tool exposure classes** ([`tools/router.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/router.rs), [`tools/registry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/registry.rs) `ToolExposure`): `Direct`, `DirectModelOnly`, `Deferred`, `DeferredModelOnly`, `CodeModeOnly`, `Hidden`. A `tool_search` meta-tool lets the model discover `Deferred` tools on demand instead of paying context for all specs up front. This is a graduated answer to "too many tools blow the prompt budget."
- **Code Mode** (`tools/code_mode/`, `code-mode` + `code-mode-runtime` crates, `ToolMode::{Direct,CodeMode,CodeModeOnly}`): the model writes code that calls tools through a generated API instead of emitting individual tool calls, with an in-process fallback to Direct when the code-mode worker is unavailable (`effective_tool_mode()` in `tools/mod.rs`). HorizonCode already has `tools/codemode.ts`; codex's exposure/fallback model is more mature.
- **Unified exec** (`core/src/unified_exec/`): one tool manages interactive processes - `exec_command` + `write_stdin` (see `router.has_terminal_controls()`). PTY-backed, output-buffered with caps, `async_watcher.rs` for long-running processes, `stdin_approval.rs` for mid-run input. Flow (from `unified_exec/mod.rs` header): build `{command, cwd}` → orchestrator does approval/sandbox select/run → on sandbox denial, retry with `SandboxType::None` when policy allows, *without re-prompting* (cached approval). HorizonCode's `shell.ts` is one-shot; this is a stateful terminal the model can drive.
- **Model-visible output formatting** (`tools/mod.rs::format_exec_output_for_model`): emits `Exit code`, `Wall time` (rounded to 0.1s), `Total output lines` only when truncation happened, then `Output:`. Truncation is policy-driven (`codex_utils_output_truncation::TruncationPolicy`).

### 1.4 Edit/diff format - `apply-patch`

- Custom patch grammar ([`apply-patch/src/parser.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/parser.rs)), not unified diff: `*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` / `@@ context` / `*** End of File`. Lark grammar is documented at the top of `parser.rs`.
- **Graduated fuzzy context matching** ([`apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/seek_sequence.rs)): to locate a hunk's context lines it tries, in order: (1) exact match, (2) ignore trailing whitespace (`trim_end`), (3) ignore leading+trailing whitespace (`trim`), (4) **Unicode-normalized** match that folds typographic dashes/quotes/odd-spaces to ASCII (so an ASCII-authored patch still applies to source with smart quotes). `eof`-anchored search tries the end of file first for patterns intended to match file endings.
- **Lenient-by-default parse mode** (`parser.rs`): `PARSE_IN_STRICT_MODE = false` with a comment that only gpt-4.1 strictly needs lenient parsing, but threading a strictness param everywhere was not worth it, so all models get lenience.
- **Streaming patch parser** ([`apply-patch/src/streaming_parser.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/streaming_parser.rs)): patches can be validated as they stream, before the full body arrives.
- Edit safety is separate from edit mechanics: `core/src/safety.rs::assess_patch_safety` decides AutoApprove / AskUser / Reject purely from writable-roots policy and sandbox availability, and notes that even a writable-path-constrained patch is still run in a sandbox because a path could be a hardlink out of the writable root.

### 1.5 Prompt strategy - explicit per-model tuning

- **One prompt file per model family**, selected from model metadata, not code branches: [`core/gpt-5.1-codex-max_prompt.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/gpt-5.1-codex-max_prompt.md), `gpt-5.2-codex_prompt.md`, `gpt_5_1_prompt.md`, `gpt_5_2_prompt.md`, `gpt_5_codex_prompt.md`. `prompts/src/model_instructions.rs::render_model_instructions(model_info)` resolves `ModelInfo → instructions_template()`; a missing template logs a warning and returns empty (fail-soft).
- Prompt content is heavily operational (from `gpt-5.2-codex_prompt.md`): prefer `rg` over `grep`; ASCII-by-default editing; "try `apply_patch` for single-file edits but fall back if it does not work well"; strong "never revert user changes in a dirty worktree / STOP and ask if you see unexpected changes" rules; a Plan-tool discipline ("skip for the easiest ~25%, no single-step plans"); a review-mindset section; and a long **final-answer formatting contract** (plain text, Title-Case headers in `**…**`, bullet rules, file-reference syntax `path:line`).
- Separate task-specific prompt templates: [`prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/compact/prompt.md) ("CONTEXT CHECKPOINT COMPACTION … handoff summary for another LLM"), guardian classifier instructions, review-exit/review-request, update-plan instructions - each in `prompts/src/*.rs` via `include_str!`.

### 1.6 Provider abstraction

- `model-provider-info` + `model-provider` crates. Providers are data: built-in defaults compiled in **plus** user-defined entries in `~/.codex/config.toml` under `model_providers` that override/extend at runtime ([`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/model-provider-info/src/lib.rs) header). Real multi-backend support: OpenAI, Amazon Bedrock, GCP Vertex, Ollama, gateway OAuth.
- **Capability negotiation + self-documenting removal errors.** `WireApi` deserialization rejects removed values with a *fix-it* message embedded in the error (`CHAT_WIRE_API_REMOVED_ERROR`, `OLLAMA_CHAT_PROVIDER_REMOVED_ERROR`: "How to fix: … More info: <url>"). `capabilities.rs` / `RemoteCompactionSupport` gate features per provider.
- Residency/governance hooks (`set_managed_residency_requirement`) and per-provider retry config (`stream_max_retries`, `request_max_retries`, hard caps at 100).

### 1.7 Permission / sandbox model (codex's strongest area vs HorizonCode)

- **Three-layer OS sandbox on Linux** (`linux-sandbox/src/`): (1) `no_new_privs` + **seccomp** filters for network isolation and VM-socket denial (`seccomp.rs`), (2) **bubblewrap** for filesystem isolation (`bwrap.rs`, `bundled_bwrap.rs` with digest verification - exit code 8 on digest mismatch), (3) legacy **Landlock** FS path retained but rejected for FS-restricted policies. Plus a **network proxy** (`network-proxy` crate, `proxy_routing.rs`) for allowlisted egress. Windows has its own `windows-sandbox-rs` / `windows-sandbox-service`.
- **Declarative command policy** (`execpolicy` crate): a Starlark-style policy of `PrefixRule`/`NetworkRule` compiled into `Policy` (`policy.rs`), matched per-program with a `Decision`, order-independent equality via a sorted `fingerprint()`, and `amend` APIs to append allow-prefix/network rules at runtime (`blocking_append_allow_prefix_rule`). This is the data-driven allowlist HorizonCode's `DEFAULT_POLICY` gestures at but does not implement as a sandbox.
- **Approval model is cached and sandbox-aware** (`unified_exec/mod.rs`, `safety.rs`): approvals are bypass/cache/prompt; a sandbox denial triggers an automatic no-sandbox retry *without re-prompting*; `AskForApproval` has `Never / OnRequest / UnlessTrusted / Granular{sandbox_approval}` modes.

### 1.8 Session/context management

- A whole compaction family under `core/src/`: `compact.rs`, `compact_remote_history.rs`, `compact_remote_v2*.rs`, `compact_token_budget.rs`, `compact_model_fallback.rs`, `compact_retained_tool_outputs.rs`, plus [`session/async_compaction.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/async_compaction.rs). Compaction can run inline or in the background, locally or **remotely** (server-side summarization), with a token-budget trigger and a model fallback if the primary cannot compact.
- `context_manager/` separates `history.rs`, `normalize.rs`, `sampling.rs`, `world_state`. `turn_context.rs` / `step_context.rs` thread per-turn vs per-step state cleanly.
- **Rollout** (`rollout.rs`, `rollout_budget.rs`, `thread_rollout_truncation.rs`) persists the full event stream; `app-server-daemon` + `daemon_recovery.rs` support crash recovery and server mode - directly relevant to HorizonCode's "missing server mode" gap.

### 1.9 LSP/DAP

- Codex has **no first-class LSP/DAP client**; it relies on MCP servers and `rg`/shell. (This is where OMP, below, is far ahead.) Worth noting so HorizonCode does not look to codex for the LSP loop.

### 1.10 Other notable

- **Guardian** (`core/src/guardian/`, `guardian_review.rs`): a classifier that reviews actions against instructions ([`prompts/templates/guardian/classifier_instructions.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/guardian/classifier_instructions.md)).
- **Hooks runtime** ([`core/src/hook_runtime.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/hook_runtime.rs), `hooks/` crate): pre/post model-request, pre/post-compact, turn-stop, session-start hooks - a richer version of HorizonCode's `core/hooks.ts`.
- **Multi-agent / collaboration** (`agent/`, `multi_agent_tool.rs`, `collaboration-mode-templates`): `spawn_agent`/`send_message`/`followup_task` with a plaintext-vs-encrypted argument distinction (`ToolCallSource::DirectPlaintextMessage` in `router.rs`).

---

## Part 2 - oh-my-pi (`packages/`, `crates/pi-*`)

Caveat carried from HorizonCode's own prior audit (`docs/30` §1): OMP's marketing numbers (72% pass rate, −61% tokens) are **not verifiable** in the tree. Steal the mechanisms, not the rankings. OMP also has an enormous `agent-session.ts` (16,207 LoC) - steal mechanisms, not the monolith.

### 2.1 Overall architecture

- TS monorepo (`packages/`: `agent` = lean reusable loop, `coding-agent` = the product, `ai` = provider layer `@oh-my-pi/pi-ai`, `catalog` = model/provider compat data, `tui`, `wire`, `utils`, `natives`) + Rust crates (`crates/pi-edit`, `pi-shell`, `pi-iso`, `pi-walker`, `pi-diff`, `pi-vcs`, `pi-ast`, `pi-predict`, `pi-voice`). SDKs in Go/Python/Rust over a framed RPC (`sdk/`).
- The loop ([`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/agent-loop.ts), 4.2k LoC) is deliberately separate from the product session. HorizonCode's `app/src/core/loop.ts` (1.9k) already mirrors this split.

### 2.2 Agent loop

- [`agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/agent-loop.ts) with sidecar modules: `append-only-context.ts`, `output-budget.ts`, `live-steering.ts`, `speculative-execution.ts`, `thinking.ts`, `pause.ts`, `replay-policy.ts`, `run-collector.ts`, `sent-tool-definitions.ts`, `tool-arguments.ts`.
- **[NEW] Speculative execution** (`speculative-execution.ts`): a dependency-graphed candidate scheduler (`SpeculativeToolCandidate` with `dependencies`/`dependents`, states `queued|running|completed|failed|discarded`) that runs read-only/side-effect-free tool calls *ahead of commit*, then commits or discards based on host validation. Includes `eval_shadow` candidates. This is a generalization of HorizonCode's NF-072 parallel batch - speculation across *turns*, not just within a batch. Not in the prior steal list.
- **Live steering** (`live-steering.ts`): user input is injected into an in-flight provider response when the provider supports it (OpenAI Responses `response.steer`), via a `LiveSteeringChannel` with `accepted`/`deferred` queues that preserve user-message ordering (once something is deferred, later input must follow it at the boundary). Prior audit's C-9; here the ordering invariant is explicit.

### 2.3 Context/cache engineering (deepened vs prior audit)

- **Append-only context + stable prefix** (`append-only-context.ts`): system prompt + tool specs computed once and frozen (`StablePrefix`); messages only grow (`AppendOnlyLog`); only the new user delta is a cache miss. Tool wire-identity is keyed cheaply via `toolKeyForPrefix` using object-identity (`WeakMap` object ids) so the hot path does not re-serialize. Invalidated explicitly (e.g. MCP reconnect).
- **Output-budget fit with exact constants** (`output-budget.ts`) - now with the real numbers HorizonCode's NF-074 should match byte-for-byte:
  - `MIN_FITTED_OUTPUT_TOKENS = 1024` (floor), `MESSAGE_FRAMING_TOKENS = 16` per locally counted message, `OUTPUT_FIT_HEADWAY_TOKENS = 64` absolute per-request headway, `PROMPT_ESTIMATE_MARGIN_DIVISOR = 10` (pad local counts by 1/10 for tokenizer disagreement).
  - Prompt size = provider's own reported usage from the newest trustworthy assistant turn (`findRequestUsageAnchor`) + local count of only the messages appended after it; whole-context local count only when nothing anchors.
  - Returns `maxTokens` unchanged when it already fits, the model declares no window, the host stops at the window instead of 400ing (`stopsOutputAtContextWindow`, e.g. Claude 4.5+), or an OpenRouter host that self-caps. Documented failure modes included (Anthropic thinking budget override).

### 2.4 Tool design and tool set

- Very large tool set under `coding-agent/src/tools/` (bash + bash-interactive + bash-pty-selection, ast-edit, ast-grep, grep, glob, fetch, gh/glab suite, browser, computer, memory-{edit,recall,reflect,retain}, learn, manage-skill, checkpoint, ida, image-gen).
- **[NEW] Bash PTY selection** (`bash-pty-selection.ts`) + **bash-interactive** (`bash-interactive.ts`): decides per-command whether to run under a PTY vs piped, enabling interactive programs; HorizonCode's `shell.ts` has no PTY path.
- **Bash interceptor** (`bash-interceptor.ts`): compiles `DEFAULT_BASH_INTERCEPTOR_RULES` (regex) and blocks `grep`/`cat`/`find`-style bash with a message redirecting the model to the specialized tool. Quote/escape-aware tokenizer (`skipShellWord`). Prior audit's "cat interception"; here it is a general rule table HorizonCode can port wholesale.
- **[NEW] AST edit / ast-grep** (`ast-edit.ts`, `ast-grep.ts`, `crates/pi-ast`): structural edits and structural search as first-class tools, above textual edit.
- **worktree-rewrite / conflict-detect** (`bash-worktree-rewrite.ts`, `conflict-detect.ts`, `file-mutation-queue.ts`): serialize mutations and detect concurrent-edit conflicts - relevant to HorizonCode's "no cross-process locking" gap.

### 2.5 Edit/diff format - `crates/pi-edit`

- Rust engine with multiple modes (`pi-edit/src/modes/`, `engine.rs`, `session.rs`, `store.rs`, `stream_json.rs`, `notebook.rs` for Jupyter).
- **Graduated fuzzy edit matching with tuned thresholds** ([`pi-edit/src/fuzzy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/fuzzy.rs)): Levenshtein similarity + whole-block search + line-sequence + context-line placement. Named thresholds: `DEFAULT_FUZZY_THRESHOLD = 0.95`, `SEQUENCE_FUZZY_THRESHOLD = 0.92`, `FALLBACK_THRESHOLD = 0.8`, `CONTEXT_FUZZY_THRESHOLD = 0.8`, `CHARACTER_MATCH_THRESHOLD = 0.92`, `DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97` with `DOMINANT_FUZZY_DELTA = 0.08` (a near-perfect hit may dominate weaker siblings), `PARTIAL_MATCH_MIN_LENGTH = 6`, `PARTIAL_MATCH_MIN_RATIO = 0.3`.
- **Diff-shaped failure feedback**: `MatchOutcome` returns `closest`, `occurrences`, `occurrence_lines`, `occurrence_previews` (5 lines of context each, truncated at 80 chars, up to `MAX_RECORDED_MATCHES = 5`) - i.e. "I could not find your block; here are the closest candidates and where they are." This is the concrete form of HorizonCode's A-3/NF-069 did-you-mean.
- `path_policy.rs` enforces read-before-write and writable-path policy inside the edit engine itself.

### 2.6 Prompt strategy

- `coding-agent/src/prompts/` + `agent/src/prompts/`. `thinking.ts` defines a thinking ladder (`off/minimal/low/medium/high/xhigh/max` + `inherit`); the prior audit documented judge-routed effort and an auto ceiling one tier below max with explicit `ultrathink`.
- Per-model/compat behavior is data-driven via `@oh-my-pi/pi-catalog` (see 2.7), not prompt files per model like codex.

### 2.7 Provider abstraction - `@oh-my-pi/pi-ai` + `pi-catalog`

- Provider compat is **compiled data** (`packages/catalog`, prior audit's KDL cascade / ranked resolver, ambiguity = CI failure). Output-budget code reads `model.compat` flags like `isOpenRouterHost`, `alwaysSendMaxTokens`, `stopsOutputAtContextWindow` - capability facts, not provider branches.
- `pi-ai` owns wire translation and a `LiveSteering` interface the loop consumes; providers negotiate unsupported params rather than hard-failing.

### 2.8 Permission/sandbox model

- `crates/pi-iso` (isolation), `pi-shell` (shell execution), `coding-agent/src/exec/` (`non-interactive-env.ts`, interceptor settings). Approval machinery under `tools/approval*.ts` (`approval-cache.ts`, `approval-scope.ts`, `approval-targets.ts`). Less OS-kernel-level than codex's bwrap/seccomp but with a real approval-scope/cache model.

### 2.9 LSP/DAP integration (OMP's standout; HorizonCode has none)

- **Full LSP subsystem** (`coding-agent/src/lsp/`): `client.ts`, multi-server mux (`lspmux.ts`, `mux/`, `servers.ts`), `diagnostics.ts`, **`diagnostics-ledger.ts`**, `deferred-diagnostics.ts`, `workspace-diagnostics.ts`, `writethrough.ts`, `edits.ts`, `format-options.ts`, `batch.ts`, `defaults.json`, and an LSP **tool** (`tool.ts`).
  - **Writethrough + diagnostics loop** (`writethrough.ts`): after an edit, it syncs file content to language servers, forces tsserver to observe new paths before `didOpen` to avoid cached missing-module resolutions (`reloadTypeScriptProjectsAfterCreate`, guarded by capability `typescript.tsserverRequest`), waits a grace window (`DIAGNOSTICS_PIPELINE_GRACE_MS`, `INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS`), and returns diagnostics inline with the edit result. This is the "LSP loop" HorizonCode lacks.
  - **Fresh-only diagnostics** (`diagnostics-ledger.ts`): `DiagnosticsLedger` strips the `file:line:col` prefix to compute a location-independent `diagnosticIdentity`, remembers what it already reported per file, and returns only *new* messages - so the model is not re-shown diagnostics it already saw after each edit.
- **Full DAP client** (`coding-agent/src/dap/`): `client.ts`, `session.ts`, `config.ts`, `defaults.json`. `session.ts` covers launch/attach, breakpoints (line, function, data, instruction), continue/pause, `evaluate`, `readMemory`, `disassemble`, modules, loaded sources. A complete debug-adapter driver - nothing comparable exists in HorizonCode or codex.

### 2.10 Other notable

- Memory/growth suite (`tools/memory-*.ts`, `autolearn/`, `hindsight/`, `mnemopi/`) - the family behind HorizonCode's NF-075.
- `auto-prewalk/`, `discovery/`, `repo` ranking (prior audit's PageRank repo map, already HorizonCode NF/doc-09).
- `cursor-bridge-tools.ts` / `acp-bridge.ts`: editor-integration surfaces (ACP) - relevant to HorizonCode "surfaces" docs.

---

## Part 3 - Mapping to concrete HorizonCode changes

Ordered roughly by value ÷ effort. Each row cites the source evidence and the HorizonCode file/area to change. **[already-landed]** marks mechanisms HorizonCode's `docs/30` says are done; listed only where the external source suggests a sharpening.

### Tier 1 - cheap, local, high value

1. **Open the provider list + self-documenting errors.**
   - Source: codex [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/model-provider-info/src/lib.rs) (built-in defaults + user `model_providers` config override; removed-value errors carry "How to fix: … More info: <url>"). OMP `pi-catalog` compat-as-data.
   - HorizonCode: `app/src/core/providers/index.ts` currently `switch (config.provider)` with silent mock fallback for unknown providers. Change: make an unknown provider a *loud* error that names valid providers and the config key (mirror codex's `unknown_variant` + fix-it text), and allow a generic OpenAI-compatible/base-URL provider entry so users can add backends without a code change. Addresses the "closed provider list / silent mock fallback" weakness directly.

2. **Diagnostics-ledger / fresh-only error reporting after edits.**
   - Source: OMP [`lsp/diagnostics-ledger.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/diagnostics-ledger.ts) (`diagnosticIdentity` strips `file:line:col`, returns only unseen messages).
   - HorizonCode: even without a full LSP, apply this to any post-edit verification output (e.g. typecheck/lint runs surfaced to the model). Add a per-session ledger in `app/src/core/loop.ts` / `tools/edit.ts` so repeated diagnostics are not re-charged to context. Pairs with NF-074 output budget.

3. **Edit engine: graduated fuzzy thresholds + diff-shaped "closest match" feedback.**
   - Source: OMP [`crates/pi-edit/src/fuzzy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/fuzzy.rs) (named thresholds 0.95/0.92/0.8…, dominant-hit rule 0.97/Δ0.08, `occurrence_previews` 5×80, `MAX_RECORDED_MATCHES=5`); codex [`apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/seek_sequence.rs) (exact → rstrip → trim → Unicode-fold ladder, eof-anchored).
   - HorizonCode: `app/src/tools/edit.ts` landed NF-069's ladder already; sharpen it with (a) the explicit threshold constants as a tuned prior, (b) the Unicode-normalization pass (dashes/quotes/odd-spaces → ASCII) so ASCII patches apply to smart-quoted files, (c) returning up to 5 closest-candidate previews on failure.

4. **Bash interceptor as a rule table + command→tool redirection.**
   - Source: OMP [`tools/bash-interceptor.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/bash-interceptor.ts) (`DEFAULT_BASH_INTERCEPTOR_RULES`, quote-aware tokenizer). codex prompt also hard-steers `rg` over `grep`.
   - HorizonCode: NF-074 already intercepts `cat`→read; generalize `app/src/tools/shell.ts` to a configurable regex rule table (grep/find/cat/sed→specialized tools) with a quote-aware tokenizer, returning a redirect message instead of executing.

5. **Per-model prompt templates selected from model metadata (fail-soft).**
   - Source: codex `core/*_prompt.md` + `prompts/src/model_instructions.rs::render_model_instructions` (missing template → warn + empty, never crash).
   - HorizonCode: `app/src/core/instructions.ts` / provider layer. Allow a per-model/family instruction override resolved from model metadata, defaulting to the base prompt when none; log a warning on miss. Low risk, enables Claude-vs-GPT-vs-Qwen tuning without code branches.

6. **Fix the output-budget constants to match the verified source.**
   - Source: OMP `output-budget.ts` (`MIN_FITTED_OUTPUT_TOKENS=1024`, `MESSAGE_FRAMING_TOKENS=16`, `OUTPUT_FIT_HEADWAY_TOKENS=64`, margin divisor 10; usage-anchor from newest assistant turn; skip-fit cases).
   - HorizonCode: `app/src/core/output-budget.ts` already exists (NF-074). Cross-check its constants and the "stops-output-at-context-window / OpenRouter self-cap / no-window" skip cases against this file and align any drift.

### Tier 2 - next capability wave

7. **An OS-level sandbox for shell/code execution (the biggest safety gap).**
   - Source: codex `linux-sandbox/src/{seccomp.rs,bwrap.rs,bundled_bwrap.rs}` (no_new_privs + seccomp network isolation + bubblewrap FS isolation + bundled-binary digest verification; Landlock legacy path), `network-proxy` for allowlisted egress; `execpolicy` crate for a declarative, fingerprinted command allowlist. HorizonCode already has `docs/audit/landlock-spike-2026-11-08.md`.
   - HorizonCode: extend the Rust `kernel/` (which owns guard/permm/receipts) to actually *enforce* execution isolation for `shell`/`codemode`, not just authorize. Start with Landlock (the spike) for FS + a seccomp/network-deny layer; model the command allowlist on `execpolicy`'s `PrefixRule`/`NetworkRule` with `amend`-at-runtime and sorted-fingerprint equality. Wire `DEFAULT_POLICY` in `contracts.ts` to this engine.

8. **LSP loop: writethrough + inline diagnostics after edits.**
   - Source: OMP `lsp/` (`client.ts`, `writethrough.ts`, `diagnostics.ts`, `workspace-diagnostics.ts`, `lspmux.ts`, `defaults.json`). Key mechanics: sync content to servers, force tsserver to observe new files pre-`didOpen`, grace-window wait, return diagnostics inline, mux multiple servers.
   - HorizonCode: new `app/src/core/lsp/` subsystem + an `lsp` tool; integrate into `tools/edit.ts`/`write.ts` so every edit returns fresh diagnostics (via the ledger from item 2). Directly closes the "missing LSP loop" weakness.

9. **Unified interactive exec (stateful terminal: exec_command + write_stdin) with sandbox-denial auto-retry.**
   - Source: codex `core/src/unified_exec/` (PTY sessions, `write_stdin`, `async_watcher`, `stdin_approval`; on sandbox denial retry without sandbox, no re-prompt). OMP `bash-interactive.ts` + `bash-pty-selection.ts`.
   - HorizonCode: evolve `app/src/tools/shell.ts` from one-shot to a session-managed PTY tool pair, with cached approvals so a sandbox-denied command can fall back once without re-asking. Pairs with the auto-background NF.

10. **Server mode + rollout/daemon recovery (addresses "no server mode" + crash resilience).**
    - Source: codex `app-server`, `app-server-daemon`, [`core/src/rollout.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/rollout.rs), [`session/daemon_recovery.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/daemon_recovery.rs).
    - HorizonCode: a long-lived process that TUI/ACP clients attach to, with the event log (`kernel/src/eventlog.rs`) as the rollout for recovery. Leverages existing `contracts.ts` NDJSON protocol.

11. **Cross-process locking + mutation queue + conflict detection.**
    - Source: OMP [`tools/file-mutation-queue.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/file-mutation-queue.ts), `conflict-detect.ts`, `bash-worktree-rewrite.ts`.
    - HorizonCode: serialize file mutations and detect concurrent edits; the `kernel/` is the natural lock owner. Closes the "no cross-process locking" weakness.

12. **Conversational rewind.**
    - Source: codex `rollout.rs` + append-only event log; OMP append-only context with explicit invalidation.
    - HorizonCode: with the kernel event log already append-only (`eventlog.rs`), add a rewind that truncates to a prior turn boundary and replays - closes the "missing conversational rewind" weakness.

### Tier 3 - richer, optional

13. **[NEW] Speculative execution across turns.**
    - Source: OMP [`agent/src/speculative-execution.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/speculative-execution.ts) (dependency-graphed read-only candidates, commit/discard on validation, `eval_shadow`).
    - HorizonCode: generalizes NF-072's within-batch parallelism in `loop.ts` to run side-effect-free tools ahead of commit. Higher complexity; gate behind the tool concurrency classes already in place.

14. **[NEW] DAP (debugger) tool.**
    - Source: OMP `coding-agent/src/dap/` (full launch/attach, breakpoints inc. data/instruction, evaluate, readMemory, disassemble).
    - HorizonCode: a new `debug` tool backed by a DAP client. Large effort; only if debugging workflows are in scope.

15. **[NEW] AST-structural edit + search tools.**
    - Source: OMP `tools/ast-edit.ts`, `ast-grep.ts`, `crates/pi-ast`.
    - HorizonCode: add structural edit/search above the textual `edit.ts`/`grep.ts` for safer large refactors.

16. **Tool exposure classes + on-demand tool search (prompt-budget control).**
    - Source: codex [`tools/registry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/registry.rs) `ToolExposure` (Direct/Deferred/CodeModeOnly/Hidden) + `tool_search` meta-tool.
    - HorizonCode: `app/src/tools/index.ts` + `loop.ts` - add an exposure field so large/rare tools (MCP, gh suite) are `deferred` and discovered via a search tool instead of always costing spec tokens. Complements NF-072's optional tool field.

17. **Turn diff tracker as a first-class surface.**
    - Source: codex [`core/src/turn_diff_tracker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/turn_diff_tracker.rs) (one unified diff per turn, `TurnDiffEvent`).
    - HorizonCode: aggregate per-turn edits into one diff event in `loop.ts`/TUI, independent of per-tool output.

18. **Guardian-style action classifier.**
    - Source: codex `core/src/guardian/` + [`prompts/templates/guardian/classifier_instructions.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/guardian/classifier_instructions.md).
    - HorizonCode: an optional review pass over proposed actions vs instructions; extends existing `core/review.ts`.

---

## Part 4 - What NOT to copy

- OMP's 16,207-line `agent-session.ts` monolith - steal mechanisms, not the sprawl (prior audit already flags this).
- OMP's unverifiable marketing metrics (72% pass, −61% tokens): `docs/30` §1 already ruled these NOT VERIFIABLE; keep H-7 metric-contract discipline.
- codex's full 128-crate breadth (Bedrock/GCP/Windows-sandbox/realtime-voice/cloud-tasks): take the *contracts* (sandbox layering, execpolicy, exposure classes), not the enterprise adapter matrix - same rule HorizonCode applied to hermes (take contracts, skip the 25-platform matrix).
- codex's Responses-only `WireApi` lock-in: HorizonCode should keep multi-wire support; adopt only the *self-documenting-error* pattern, not the single-wire constraint.

---

## Appendix - key evidence paths

codex:
- Loop/parallel: [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/turn.rs), [`tools/router.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/router.rs) (`tool_supports_parallel`), [`tools/parallel.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/parallel.rs), `turn_diff_tracker.rs`
- Edit: [`apply-patch/src/parser.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/parser.rs) (grammar, `PARSE_IN_STRICT_MODE=false`), `seek_sequence.rs` (fuzzy ladder + Unicode fold), `streaming_parser.rs`; safety [`core/src/safety.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/safety.rs)
- Sandbox: `linux-sandbox/src/{lib.rs,seccomp.rs,bwrap.rs,bundled_bwrap.rs}`; `execpolicy/src/{lib.rs,policy.rs,rule.rs,amend.rs}`; `network-proxy`
- Prompts: [`core/gpt-5.2-codex_prompt.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/gpt-5.2-codex_prompt.md) (+ other `*_prompt.md`), [`prompts/src/model_instructions.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/src/model_instructions.rs), [`prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/compact/prompt.md)
- Providers: [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/model-provider-info/src/lib.rs), `model-provider/src/`
- Exec: [`core/src/unified_exec/mod.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/unified_exec/mod.rs)
- Server/recovery: [`core/src/rollout.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/rollout.rs), [`session/daemon_recovery.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/daemon_recovery.rs), `app-server-daemon`
- Context: `core/src/compact*.rs`, `context_manager/`

oh-my-pi:
- Loop/context: `packages/agent/src/{agent-loop.ts,append-only-context.ts,output-budget.ts,live-steering.ts,speculative-execution.ts,thinking.ts}`
- Edit: `crates/pi-edit/src/{fuzzy.rs,engine.rs,path_policy.rs,modes/}`
- Tools/shell: `packages/coding-agent/src/tools/{bash-interceptor.ts,bash-pty-selection.ts,bash-interactive.ts,ast-edit.ts,file-mutation-queue.ts,conflict-detect.ts}`
- LSP: `packages/coding-agent/src/lsp/{client.ts,writethrough.ts,diagnostics.ts,diagnostics-ledger.ts,workspace-diagnostics.ts,lspmux.ts,defaults.json,tool.ts}`
- DAP: `packages/coding-agent/src/dap/{client.ts,session.ts,config.ts,defaults.json}`
- Providers/compat: `packages/ai` (`@oh-my-pi/pi-ai`), `packages/catalog` (`@oh-my-pi/pi-catalog`)

HorizonCode touch points:
- `app/src/core/providers/index.ts`, `app/src/core/instructions.ts`, `app/src/core/output-budget.ts`, `app/src/core/loop.ts`
- `app/src/tools/{edit.ts,shell.ts,write.ts,read.ts,index.ts}`
- `app/src/contracts.ts` (`DEFAULT_POLICY`), `kernel/src/{guard.rs,permm.rs,eventlog.rs}`
