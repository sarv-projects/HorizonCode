# Strict comparison: oh-my-pi and DeepSeek harness vs HorizonCode

> **Phase 1, read-only.** No file in HorizonCode or either external tree was modified. This is a follow-up STRICT deep-read after the first steal wave (`docs/30-steal-list.md` §5, merged via PR #1). It reads actual source, not just package READMEs, and classifies every capability per subsystem as **COMMON** (same mechanism in two or more sources - merge once), **UNIQUE** (absorb - only this source has it), **ALREADY-IN-HORIZONCODE** (HorizonCode ships an equivalent), or **MISSING** (neither the source nor HorizonCode has it, or HorizonCode's is a reduced stand-in).
>
> **Scope of this agent:** oh-my-pi (EXCEPT its provider/catalog surface - `packages/catalog` and the `pi-ai` provider wire are owned by another agent) and the DeepSeek harness. The provider/model-registry comparison (models.dev, opencode provider lifecycle, "100s of providers") is deliberately left to the provider-owning agent; this report notes the seam only where oh-my-pi's compat-as-data or dsh's `LlmConfigurableProvider` touches a subsystem in scope.
>
> **Grounding.** HorizonCode source read for this pass: `app/src/contracts.ts` (LAW), `app/src/core/loop.ts`, `app/src/core/output-budget.ts`, plus the baseline in `research/horizoncode-baseline.md` and docs 08/09/10/11/12/15/28. External source read: the files enumerated in §1 and §2 below, each cited with its path.

---

## 0. Executive summary - the strict verdict

The first wave (NF-071…NF-075) already absorbed the *loop-shaped* mechanisms oh-my-pi and dsh share with the other references: per-tool concurrency (NF-072), loop rails (NF-073), output-budget/spill/interception (NF-074), growth fork (NF-075), managed runtime (NF-071). Reading the actual source this pass confirms those landed in reduced form and surfaces the capabilities the READMEs under-described. The highest-value absorptions that remain, in strict value-over-effort order:

1. **The LSP writethrough + diagnostics-ledger loop** (oh-my-pi, UNIQUE). HorizonCode has *no* LSP loop; this is the single biggest capability gap in scope. The ledger (`diagnostics-ledger.ts`, 40 lines) is portable *today* even without a language-server client, because it de-charges repeated diagnostics by location-independent identity.
2. **The fail-closed sandbox escalation ladder** (dsh `escalation.ts`, CONVERGENT with codex's OS layers). HorizonCode's kernel is advisory (`docs/28` §2.3); dsh's per-call `SandboxMode` ladder with verbatim denial/hint markers and a one-shot wider-mode retry is the contract to adopt into `kernel/src/guard.rs` + `contracts.ts`.
3. **The repeat-tool reminder guard** (dsh, CONVERGENT with cline's loop-detection). `[3,5,8]` deep-canonical repeat counts, advisory, counted in post-execute so denied calls count too. ~180 lines, drops straight onto HorizonCode's post-tool hook.
4. **Stable provider failure codes + regex classifiers** (dsh [`llm/src/error.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/error.ts), CONVERGENT with codex). Richer than the prior report captured: adds `EMPTY_RESPONSE`, `INVALID_CREDENTIAL`, `IMAGE_OFFLOAD_REQUIRED`, `ACCOUNT_QUOTA`, plus battle-tested context-overflow/quota regex detectors.
5. **The four-stage tool pipeline with fail-closed approval degrade** (dsh [`tools/src/pipeline.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/pipeline.ts), UNIQUE). HorizonCode's `loop.ts`/`hooks.ts` already approximate pre/post hooks (Hooks v1), but dsh's monotonic `guard()` + around-dispatch + `ToolCallRecovery` pairing repair is a sharper contract.
6. **Edit-ladder constants + Unicode-fold + 10-strategy sequence ladder** (oh-my-pi [`pi-edit/src/fuzzy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/fuzzy.rs), CONVERGENT with codex/opencode). HorizonCode landed NF-069's ladder but not these named thresholds or the `CommentPrefix`/`Unicode` passes.

The things NOT to copy: oh-my-pi's 16k-line `agent-session.ts` monolith (already flagged), its full memory/autolearn/hindsight/mnemopi suite (out of scope - NF-075 owns the reduced form), and dsh's full 50-package microkernel adapter matrix (take the seam contracts, not the SSH/terminal/computer-use/browser-use adapter breadth).

---

## 1. oh-my-pi - exhaustive architecture and per-subsystem findings

### 1.1 Overall architecture

TS monorepo under `packages/` (`agent` = reusable loop, `coding-agent` = product, `ai` = provider wire [out of scope], `catalog` = compat data [out of scope], `tui`, `natives`, `utils`, `omptype`, `stats`) plus Rust crates under `crates/` (`pi-edit`, `pi-shell`, `pi-iso`, `pi-walker`, `pi-ast`, `pi-diff`, `pi-vcs`, `pi-predict`, `pi-natives`, `pi-builtins`, `pi-vfs`, `pi-voice`). The reusable loop ([`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/agent-loop.ts)) is deliberately split from the product session (`packages/coding-agent/src/…/agent-session.ts`, the 16k-line monolith). HorizonCode's `app/src/core/loop.ts` (≈1.9k lines) already mirrors the lean-loop split.

The `agent` package sidecar modules (all read this pass or confirmed present): `append-only-context.ts`, `output-budget.ts`, `live-steering.ts`, `speculative-execution.ts`, `thinking.ts`, `pause.ts`, `replay-policy.ts`, `run-collector.ts`, `sent-tool-definitions.ts`, `tool-arguments.ts`, `tool-context.ts`, `image-tokens.ts`, `tokenizer.ts`, `proxy.ts`, `compaction/` (dir), `prompts/` (dir).

### 1.2 Output budget - [`packages/agent/src/output-budget.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/output-budget.ts) (read in full)

The real constants, verbatim from source:

- `MIN_FITTED_OUTPUT_TOKENS = 1024` (floor).
- `PROMPT_ESTIMATE_MARGIN_DIVISOR = 10` - local counts padded by `ceil(n/10)` for tokenizer disagreement (`withMargin`).
- `MESSAGE_FRAMING_TOKENS = 16` - per locally counted message (role markers, tool-response wrappers).
- `OUTPUT_FIT_HEADWAY_TOKENS = 64` - absolute per-request headway, measured against a 262,144-token host where fitted caps landed +11..+42 over and 400'd.

`fitOutputTokensToContextWindow(model, context, maxTokens, tokenizer)`:
- Returns `maxTokens` unchanged (skip-fit) when: `maxTokens===undefined && omitsDefaultOutputCap(compat)` (OpenRouter host w/o `alwaysSendMaxTokens`); no `requested`/`contextWindow`; or `stopsOutputAtContextWindow(model)` (Claude 4.5+ on the Claude API).
- Otherwise `room = contextWindow - countPromptTokens(context) - OUTPUT_FIT_HEADWAY_TOKENS`; returns `maxTokens` if `room >= requested`, else `max(MIN_FITTED_OUTPUT_TOKENS, room)`.
- Prompt size = `findRequestUsageAnchor(messages)` (newest trustworthy assistant usage) + locally counted tail since the anchor; whole-context local count only when nothing anchors.
- `countFraming` memoizes system-prompt and tool-spec token counts in a `WeakMap` keyed by array identity+length, so side turns don't re-tokenize.
- Documented non-fix: Anthropic budget-thinking transports raise `max_tokens` back downstream (`ensureMaxTokensForThinking`).

### 1.3 Append-only context / prefix cache - [`packages/agent/src/append-only-context.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/append-only-context.ts) (read in full)

Two mechanisms, both source-confirmed:

- **`StablePrefix`**: system prompt + tool specs frozen on first `build()`; `#fastPathHit` compares recorded prompt *segments* (not just array reference - the live array is caller-owned and mutable in place) and per-tool wire-identity keys (`toolKeyForPrefix` = name/description/strict/customWireName/intent-mode + `objectId` of resolved params/customFormat/examples via a `WeakMap` id allocator). Fingerprint recomputed only on a fast-path miss. `invalidate()` on MCP reconnect.
- **`AppendOnlyLog`**: messages only grow; the only mutation is `replaceTail()` (compaction). `AppendOnlyContextManager.syncMessages()` handles three cases: append, compaction (array shrank → clear+replay), and in-place rewrite - it computes `#longestStablePrefix` via per-message `#messageDigest` (a cheap 32-bit hash over role/content/providerPayload/toolCalls/toolCallId/toolName/isError/id, memoized by object identity validated against `messageEstimateVersion`), truncates the log to that prefix, and re-appends the diverged tail. This keeps the provider KV cache warm up to the divergence point on llama.cpp/local backends (issue #3406: a single rewritten message used to force a ~40k-token re-prefill every turn).

### 1.4 Speculative execution - [`packages/agent/src/speculative-execution.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/speculative-execution.ts) (read in full)

A `SpeculativeOperationCoordinator` per streamed assistant message (`coordinatorByMessage` WeakMap). `SpeculativeToolCandidate` carries `dependencies`/`dependents`, `state: queued|running|completed|failed|discarded`, `source: direct|eval_shadow`, a `fingerprint` (`createExecutionFingerprint` = canonical JSON of `{name, args, effect}`), and a `committed` flag separate from physical completion. Effects are a closed union: `{kind:'pure'}` or `{kind:'local_read', resources:[{scheme:'file', path, access:'read'}]}` (`normalizeSpeculationEffect` rejects anything else). `DEFAULT_MAX_IN_FLIGHT = 2`. The coordinator admits candidates serially behind a `#admission` promise chain, discards on fingerprint mismatch (`reconcileFinalCalls` compares against an immutable `admittedArgumentsJson` snapshot because `prepareToolCallDispatch()` mutates the aliased message block in place), runs host `validate`/`commit` on claim, and cascades discards to dependents on a veto. This is a strict generalization of within-batch parallelism (NF-072) to run side-effect-free calls *ahead of commit across the stream*.

### 1.5 LSP subsystem - `packages/coding-agent/src/lsp/` (writethrough.ts + diagnostics-ledger.ts read in full; others surveyed)

Files: `client.ts`, `lspmux.ts` + `mux/`, `servers.ts`, `diagnostics.ts`, `diagnostics-ledger.ts`, `deferred-diagnostics.ts`, `workspace-diagnostics.ts`, `writethrough.ts`, `edits.ts`, `format-options.ts`, `batch.ts`, `startup-events.ts`, `settings.ts`, `defaults.json`, `tool.ts`, `clients/`.

**Writethrough loop (`writethrough.ts`):** `createLspWritethrough(cwd, {enableFormat, enableDiagnostics, requestTimeoutSec})` returns a callback the edit/write tools call. The flow: capture pre-edit `minVersions` (bounded at 5s so a hung server can't add its 30s init to every edit), reconcile other open files from disk, optionally format in-memory via LSP, sync content to servers, commit to disk with `writeFileWithFallback`, notify `didSave`. For a *created* file it calls `reloadTypeScriptProjectsAfterCreate` - forcing `typescript.tsserverRequest`/`reloadProjects` *before* the first `didOpen`, because opening immediately after a create pins tsserver's cached missing-module resolution (notably on macOS FSEvents). Diagnostics are fetched with a dual budget: `fetchDiagnosticsWithDeferral` blocks inline only briefly (`INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS`) then hands a slow fetch to a deferred channel (`onDeferredDiagnostics`) and returns `undefined` so the tool result lands immediately; direct/CI callers with no deferred channel block for the full budget. Freshness is enforced by exact document-version matching against the pre-edit baseline. `beginPendingDiskWrite`/`endPendingDiskWrite` bar disk reconciliation for the target so a concurrent query can't revert the overlay. `mergeDiagnostics` coalesces multi-server results (formatter priority FAILED > FORMATTED > UNCHANGED > UNSUPPORTED).

**Diagnostics ledger (`diagnostics-ledger.ts`):** `diagnosticIdentity(message)` strips `^.*?:\d+:\d+\s+` (the `file:line:col` prefix) to a location-independent identity. `DiagnosticsLedger.reduce(absPath, result)` keeps a per-file `Set` of seen identities and returns only *fresh* messages - so after each edit the model is not re-charged for diagnostics it already saw. Portable to HorizonCode *today* with no LSP client (apply to any typecheck/lint output).

### 1.6 Bash interceptor + PTY selection - [`packages/coding-agent/src/tools/bash-interceptor.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/bash-interceptor.ts) + `bash-pty-selection.ts` (both read in full)

**Interceptor:** `checkBashInterception(command, availableTools, rules=DEFAULT_BASH_INTERCEPTOR_RULES)` compiles a regex rule table (`BashInterceptorRule {pattern, flags, tool, message}` from `../exec/settings`), derives candidate strings via `interceptionCandidates` (the whole command, each flat shell segment from `extractFlatShellCommandSegments`, and each segment with leading `NAME=value` env assignments stripped), and blocks only when the suggested `rule.tool` is actually available. The tokenizer (`skipShellWord`) is quote/escape-aware and returns `null` on incomplete syntax. Crucially, a segment that reads piped stdin (`pipedStdin`) is *not* an interception candidate - no path-based tool can replace a `| grep`. This generalizes HorizonCode's hard-coded `cat`→read interception to a configurable grep/find/sed/cat table.

**PTY selection:** `canUseInteractiveBashPty(pty, ctx)` - trivially small: returns false unless `pty && $env.PI_NO_PTY !== "1" && ctx.hasUI && ctx.ui !== undefined`. The *interesting* machinery is in `bash-interactive.ts` (not fully read; the decision is "run under a PTY overlay vs piped" per command). HorizonCode's `shell.ts` is one-shot piped with no PTY path.

### 1.7 Fuzzy edit engine - [`crates/pi-edit/src/fuzzy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/fuzzy.rs) (read in full)

Named thresholds (verbatim consts): `DEFAULT_FUZZY_THRESHOLD = 0.95`, `SEQUENCE_FUZZY_THRESHOLD = 0.92`, `FALLBACK_THRESHOLD = 0.8`, `CONTEXT_FUZZY_THRESHOLD = 0.8`, `CHARACTER_MATCH_THRESHOLD = 0.92`, `DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97`, `DOMINANT_FUZZY_DELTA = 0.08`, `PARTIAL_MATCH_MIN_LENGTH = 6`, `PARTIAL_MATCH_MIN_RATIO = 0.3`, `OCCURRENCE_PREVIEW_CONTEXT = 5`, `OCCURRENCE_PREVIEW_MAX_LEN = 80`, `MAX_RECORDED_MATCHES = 5`.

The sequence ladder (`run_sequence_passes` + `seek_sequence`) is a **10-strategy** `SequenceMatchStrategy` enum, in order with per-strategy confidence: `Exact` (1.0) → `TrimTrailing` (0.99) → `Trim` (0.98) → `CommentPrefix` (0.975, strips `/* */ // * # ; / `) → `Unicode` (0.97, `normalize_unicode` folds smart quotes/dashes) → `Prefix` (0.965) → `Substring` (0.94) → `Fuzzy`/`FuzzyDominant` (Levenshtein, dominant-hit rule 0.97 + Δ0.08) → `Character` (0.92 char-level fallback). `MatchOutcome` returns `closest`, `occurrences`, `occurrence_lines`, `occurrence_previews` (≤5 lines × 80 chars, up to `MAX_RECORDED_MATCHES=5`) - the concrete did-you-mean. Also carries bit-parallel Myers distance (`PatternDistance`) and banded Levenshtein (`levenshtein_within`). `eof`-anchored search tries end-of-file first. `normalize_lines` computes relative-indent depths so a block that only differs by indentation unit still matches.

### 1.8 Mutation queue + conflict detection - `file-mutation-queue.ts` + `conflict-detect.ts` (both read in full)

**Mutation queue (`file-mutation-queue.ts`, 60 lines):** `withFileMutationQueue(filePath, fn)` serializes mutations to the same realpath (`fs.realpathSync.native`, falling back to a longest-existing-ancestor join for not-yet-created files) via a per-key `Promise` chain in a module `Map`. Different files run in parallel. Note from source: oh-my-pi's *built-in* edit/write do NOT use this queue - it serializes custom tools/extensions against each other. This is an in-process lock, not cross-process; the prior report overstated it as closing HorizonCode's "cross-process locking" gap.

**Conflict detection (`conflict-detect.ts`):** `scanConflictLines` finds well-formed `<<<<<<< / ||||||| / ======= / >>>>>>>` blocks in already-read lines (no extra I/O), a `ConflictHistory` assigns stable ids and reconciles across line shifts (`reconcilePath`/`findRegisteredBlocks` with bounded memory), and `write({path:"conflict://<id>"})` splices the region with boundary-echo repair (`trimBoundaryEcho` drops replacement lines that duplicate adjacent context, using delimiter-balance to justify a single-line trim). `@ours`/`@theirs`/`@base`/`@both` content shorthands. This is a distinctive read-path capability HorizonCode has nothing like.

### 1.9 Live steering / thinking / replay (surveyed)

- `live-steering.ts`: `LiveSteeringChannel` injects user input into an in-flight provider stream (OpenAI Responses `response.steer`) with `accepted`/`deferred` queues preserving user-message ordering (once something defers, later input follows at the boundary). HorizonCode's loop has steer-batch between turns, not into the stream.
- `thinking.ts`: thinking ladder `off/minimal/low/medium/high/xhigh/max + inherit`, judge-routed effort with an auto ceiling one tier below max and explicit `ultrathink`.
- `replay-policy.ts` / `sent-tool-definitions.ts`: track which tool definitions were sent so a re-send is a cache-stable decision; replay policy governs resuming an interrupted stream.

### 1.10 DAP (debugger) - `packages/coding-agent/src/dap/` (surveyed)

`client.ts`, `session.ts`, `config.ts`, `defaults.json`, `types.ts`. Full debug-adapter driver: launch/attach, breakpoints (line/function/data/instruction), continue/pause, `evaluate`, `readMemory`, `disassemble`, modules, loaded sources. Nothing comparable in HorizonCode or codex. Tier-3 / strategic.

### 1.11 AST tools - `ast-edit.ts`, `ast-grep.ts`, `crates/pi-ast` (surveyed)

Structural edit and structural search as first-class tools above textual edit/grep. Tier-3.

### 1.12 Provider/catalog (OUT OF SCOPE - noted only)

`packages/catalog` compiles KDL rule trees to `rules.json`/`models.json` via `bun run gen:compat`/`gen:models`, with a strict "model/provider policy lives in KDL, never in TS" rule (the repo's own AGENTS.md). Output-budget reads `model.compat` flags (`isOpenRouterHost`, `alwaysSendMaxTokens`, `stopsOutputAtContextWindow`) as capability facts, not provider branches. The full provider roster / models.dev comparison is the other agent's deliverable.

---

## 2. DeepSeek harness (`dsh`) - exhaustive architecture and per-subsystem findings

### 2.1 Overall architecture - Cordis microkernel, "everything is a plugin"

~50 package groups under `packages/<group>/<pkg>/` (`core`, `llm`, `shell`, `subprocess`, `ssh`, `terminal`, `ptc-runtime`, `sandbox`, `fs`, `lsp`, `skill`, `web`, `computer-use`, `browser-use`, `compaction`, `context`, `subagent`, `team`, `jobs`, `workflow`, `todo`, `plan`, `goal`, `schedule`, `preset`, `guard`, `extensions`, `session`/`session-query`, `spill`, `deliverables`, `mcp`, `acp`, `sdk`, `host`/`client`, …). The microkernel is Cordis (`vendor/`): every capability - model adapter, tool registry, session log, *and the agent loop itself* - is a plugin mounted into a shared `Context`. Composition is declarative via **Profiles** stacking ordered **Bundles**; `dsh-base` is the shared first layer. A **capability seam** = Service Definition + Service Provider + Consumer (three roles, always complete; repo rule). Registrations are effects: `ctx.effect()`/`ctx.on()` return disposers.

### 2.2 Agent loop - [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts) (read in full)

A precise turn/step state machine (`ReactLoopAgent`). Key source-confirmed mechanisms:

- **Phase union**: `idle | maintenance | running`, each with `lastTurn`/`abort`/`wakeRequested`. Status transitions emit `agent/status`.
- **Inbox with three admission targets** (`send(message, target, wakeup)`): `followup` → `next-turn`+wake, `steer` → `next-step`+wake, `inject` → `next-step` non-waking. A wake sent after an abort is reclassified to start the next turn (`wakingAfterAbort`, captured before insertion so a reentrant cancel can't reclassify it).
- **Turn/step durable events**: `turn/start`, `step/start`, `request/header`, `system/message`, `user/message`, `assistant/message | assistant/attempt`, `tool/result`, `step/end`, `turn/end`. Every model request is derived from the log (`deriveMessages`), never held as mutable state.
- **`request/header` reasons**: `initial | resume | change | series`; `startsSeries` set when surface generation changed or tools changed. On a tool-set change mid-session it appends a `developer/message` with typed `tool-addition`/`tool-removal` blocks instead of rewriting the prefix.
- **`systemPromptUpdate: 'in-history'`**: `this.systemPrompt.project(renderedPrompt, {inHistory: preparedCall?.systemPromptUpdate === 'in-history', startsSeries})` - a changed system prompt is appended *after* cached history rather than rewriting the leading message, preserving the KV-cache prefix.
- **`max-tokens` is sticky**: once any step hits the ceiling, later completed steps don't downgrade the turn outcome (enforced in `turn()`).
- **`turn/end.reason`** closed union: `completed | max-tokens | blocked | aborted{reason} | error{message,code}`. Failures flatten to `errorChain` text under code `UNKNOWN` unless `LlmError` (keeps `failure`) or `ToolActivationError` (keeps code).
- **`ToolCallRecovery`**: a `session/event` observer appends missing `tool/result` events if the step throws, so the pairing invariant is never broken; an `AggregateError` is raised if even recovery fails. (HorizonCode has the same *problem* - external audit finding 2, `recoverInterrupted` exists but is called from nowhere - and this is the clean fix.)
- **Retry is a plugin** (`dsh-llm-retry` at the `agent/request-error` waterfall); the loop issues exactly one provider attempt per step.

### 2.3 Tool pipeline - [`packages/core/tools/src/pipeline.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/pipeline.ts) (read in full)

`ToolExecutionPipeline` with a four-stage waterfall and fail-closed everything:

- **`executionMode(exec)`**: only an exact `true` from `tool.isConcurrencySafe(args)` is `parallel`; unknown/hidden/throwing classifiers are `exclusive` (fail-closed concurrency - identical philosophy to HorizonCode's `concurrencyClassOf`).
- **`prepare`**: snapshot+freeze args (`snapshotJsonValue`, lossless-JSON or throw) → `tools/pre-execute` waterfall (`allow|deny|ask|cancel`) → `serviceAsk` for `ask` → `checkGuards` (monotonic) → `dispatch` or a `post-result`. Caller cancellation skips a body that hasn't started.
- **`serviceAsk`**: consumes the approval seam opportunistically via `ctx.get('approval')`; **degrades to deny** when no approval service is composed, or the execution has no agent (no session to audit, no UI to route). The four outcomes map one-to-one: `allowed-once`→allow; `rejected`/`cancelled`/`unavailable`→deny with *distinct* reasons so the model can tell a human "no" from an absent channel.
- **`dispatch`**: `tools/execute` around-wrapper over `dispatchToolBody`, which fuses the caller signal back into any wrapper-replaced signal and never abandons a started body (drains to quiescence before marking `ABORTED`).
- **`postExecute`**: `tools/post-execute` waterfall → `accept` (optionally replace `content` or `value`, attach `additionalContexts`) or `block` (turn into `isError` with corrective `feedback`). Deferred context survives accept, discarded on block.
- `createSuccessResult` validates the body value against the tool's output JSON schema (`validateJsonSchemaValue`), renders content, snapshots projections, and `deepFreeze`s - "nothing is a blind string exec."

### 2.4 Sandbox - [`packages/sandbox/sandbox/src/escalation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/src/escalation.ts) (read in full) + `sandbox-policy/`, `roots.ts`, `diagnostics.ts` (surveyed)

Fail-closed, per-call `SandboxMode = read-only | workspace-write | danger-full-access`. The escalation vocabulary, verbatim from source:

- `WIDER_MODES`: `read-only → [workspace-write, danger-full-access]`, `workspace-write → [danger-full-access]`. The strictly-wider table is checked at **execution**, never in the tool schema enum (schemas are registry-global; effective mode is per-call truth).
- `ESCALATION_TARGETS = [workspace-write, danger-full-access]` (the schema enum; `read-only` is the floor, nothing escalates to it).
- `sandboxDenialMarker(mode)` → ``[sandbox: file access denied under ${mode} mode]`` - one vocabulary both the bash kernel path and the fs provider teach.
- `escalationHintMarker(subject)` → the hint line ``[sandbox: escalation available ... retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`` (the source separates "available" from "retry" with an em dash; reproduce it byte-for-byte from `escalation.ts` when porting, since it is model-facing text).
- `approveEscalation(request, approval)`: repeating the effective mode needs no approval; a strictly-wider mode requires approval and applies to that one call only; narrower/unsupported targets, missing approver/agent, or a non-grant outcome throw *before* execution. `validateEscalationArgs` enforces `sandbox_permissions` + `justification` travel together, justification non-empty.

The actual OS backends (bubblewrap+Landlock, Seatbelt, Windows ACL) live in `sandbox-local`/`sandbox-windows-acl` (not read). Enforcement-completeness (`full`/`partial`) is reported per call (README; a consumer needing the absolute boundary can reject `partial`). HorizonCode's kernel is advisory (`docs/28` §2.3) and has no documented one-call escalation flow.

### 2.5 Repeat-tool guard - [`packages/guard/repeat-tool-reminder/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/guard/repeat-tool-reminder/src/index.ts) (read in full)

Advisory, never a veto. `Config.thresholds` default `[3, 5, 8]` (validated fail-loud: non-empty, integer ≥2, no duplicates, sorted ascending). The chain key = `JSON.stringify([name, canonicalize(args)])` where `canonicalize` deep key-sorts the parsed-JSON args. A per-`Agent` `WeakMap<Agent, {key, count}>` tracks the consecutive run. Counting happens in `tools/post-execute` **because denied calls also flow through that waterfall** - a model hammering a denied call is exactly the loop worth breaking. At `thresholds[0]` it injects the `GENTLE_REMINDER`; at later thresholds the `detailedReminder` (names tool, count, and head-truncated canonical args, cap `argumentsPreviewChars` default 500 - bounds the *reminder*, never the detection). Reminders are injected as source-attributed `{kind:'repeat-tool-reminder', form:'notice'}` user messages (the label is load-bearing; an unlabeled context would render as a user prompt). `agent/pre-step` clears the chain when any message is `source.kind === 'user'` (an interjection changes context). `include`/`exclude` are `*`-wildcard predicates; untracked tools are transparent (neither count nor reset - bookkeeping tools like `todo_write` don't launder a loop).

### 2.6 LLM failure codes - [`packages/llm/llm/src/error.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/error.ts) (read in full)

`HarnessError` carries a stable `code` distinct from `message`; "route on this, never by parsing message." Canonical codes found in source (richer than the prior report): `NO_ADAPTER`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` (malformed vs absent - deliberately non-retryable), `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`, `EMPTY_RESPONSE` (degenerate zero-content completion, safe to retry), `IMAGE_OFFLOAD_REQUIRED` (carries `offloadImages` count). Plus battle-tested classifiers: `isContextWindowExceededError(detail)` (five anchored regexes over joined provider code+type+message) and `isQuotaExceededError(detail)` (five regexes distinguishing terminal quota/balance/credit from transient rate limit). `errorChain(value)` renders the full `cause` chain + AggregateError members with cycle guarding, for diagnostics only. One terminal `finish` chunk per stream (`{kind:'error'|'aborted', failure}`).

### 2.7 Subagents - `packages/subagent/` (surveyed; README + source file list)

Providers: `spawn-in-process`, `fork-in-process`, `acp`, `dsh-sdk`, `codex`, `claude-code`. Local children keep durable sessions and accept follow-ups; external children execute once and return only a final answer (reasoning/tool-traffic/stderr kept out of the parent). `maxActiveSubagents` default 8 (per tree; root consumes no slot), `maxDepth` default 1; at capacity → `ACTIVATION_LIMIT_REACHED` (no queuing - a parent must not wait on its own slot). Sibling-unique names `agent-N` or `[a-z][a-z0-9-]{0,31}`; root is `lead`; descendant full name is the slash-path. A delegation-scope statement ("your permission scope was fixed… do not retry the denied operation; state the limitation") and return guidance are injected into every child. Source files present: `activation.ts`, `depth.ts`, `names.ts`, `child-agent.ts`, `continuation-messages.ts`, `control.ts`, `manager.ts`, `out-of-process.ts`, `projection.ts`, `structured.ts`.

### 2.8 PTC runtime / compaction / deliverables (surveyed via README + file list)

- **`tool-executor-ptc`**: the model writes an async `run_code` body; tools become `await tools.name(args)` SDK bindings. Call allowance = `floor(timeoutMs/60000 × maxSubCallsPerMinute)` (default 2048 for 2 min); exhaustion terminates with a message naming the limit. Read-only concurrency taught in the SDK instructions. Sub-call ids `<parent>:ptc:<n>`; `run_code` exclusive+serial at root. The direct analogue of HorizonCode `code_mode`, which has no per-program call ceiling.
- **`compaction`** split into `compaction-basic`, `compaction-tool-result-pruner` (trim oversized outputs *before* condensing), `compaction-image-offload` (replace over-budget images, logged `image/offload`, retried), `command-compact` (`/compact`, serialized against running turns). Token measurement in a separate `token-meter`.
- **`deliverables`**: a `present` tool declares final files; a per-turn changed-file recorder with line counts from git snapshots, rendered client-only (not model-visible).

---

## 3. Strict per-subsystem comparison table vs HorizonCode

Classification: **COMMON** (≥2 sources - merge once), **UNIQUE** (absorb, single source), **ALREADY-IN** (HorizonCode ships equivalent), **MISSING** (HorizonCode lacks it or ships a reduced stand-in).

| # | Subsystem | oh-my-pi | dsh | HorizonCode today | Strict verdict |
|---|---|---|---|---|---|
| 1 | **LSP writethrough loop** | [`lsp/writethrough.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/writethrough.ts) (tsserver reload-before-didOpen, inline+deferred diagnostics, version-freshness) | `packages/lsp` (seam; not read, behind fs/subprocess providers) | none | **UNIQUE to oh-my-pi** (the writethrough choreography); the LSP *capability* is COMMON (both have `lsp`). **MISSING** in HorizonCode. Top absorption. |
| 2 | **Diagnostics ledger (fresh-only)** | [`lsp/diagnostics-ledger.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/diagnostics-ledger.ts) (`diagnosticIdentity` strips `file:line:col`, per-file seen-set) | not present as a named unit | none | **UNIQUE to oh-my-pi**, **MISSING** in HorizonCode. Portable today (40 lines, no LSP client needed). |
| 3 | **DAP debugger** | `dap/` full client | none | none | **UNIQUE to oh-my-pi**, **MISSING**. Tier-3. |
| 4 | **Speculative execution** | `speculative-execution.ts` (dep-graph, pure/local_read effects, commit/discard) | not present (loop issues one attempt/step) | NF-072 within-batch parallel only | **UNIQUE to oh-my-pi**, extends NF-072. **MISSING** (the cross-stream speculation). Tier-3, gate behind concurrency classes. |
| 5 | **Append-only context / prefix cache** | `append-only-context.ts` (StablePrefix fast-path, longest-stable-prefix syncMessages) | agent.ts (`deriveMessages`, `startsSeries`, in-history prompt) | NF-005 cache-guard (CI contract); `pinnedTaskStatement` rail | **COMMON** (both engineer prefix stability). HorizonCode **ALREADY-IN** the contract form; **MISSING** the longest-byte-stable-prefix truncation on in-place rewrite and the in-history prompt update. |
| 6 | **`systemPromptUpdate:'in-history'`** | - | agent.ts (append changed prompt after cached history) | leading system message rewritten each turn | **UNIQUE to dsh**, **MISSING** in HorizonCode. Needs a per-model capability flag in `contracts.ts`. |
| 7 | **Output-budget fit** | `output-budget.ts` (anchor+tail, framing 16, headway 64, floor 1024, margin /10) | `token-meter` + compaction reserve | `output-budget.ts`: framing 16 ✓, but headway **4096** (vs 64), floor **256**, cap 8192, window table by name | **ALREADY-IN** (NF-074 landed). Strict drift: HorizonCode's `HEADWAY_TOKENS=4096` is a conservative reserve vs oh-my-pi's measured 64; HorizonCode has no usage-anchor+tail (it has `estimatePromptTokens` whole-prompt + an anchor param to `fitMaxOutputTokens`, but no `findRequestUsageAnchor`), no skip-fit cases (`stopsOutputAtContextWindow`/OpenRouter self-cap). **MISSING**: the skip-fit cases and the anchor-from-newest-assistant-usage. |
| 8 | **Tool-result caps + spill** | structural read summaries + caps + spill-to-artifact | `spill` package (seam) + tool-result-pruner | `planToolOutputCap` (16 KiB/4000 tok, sha256 spill, lossless-resumable `nextOffset`, O_NOFOLLOW safe write) | **ALREADY-IN** (NF-074). HorizonCode's spill-safety (`writeSpillSafely` O_CREAT\|O_EXCL\|O_NOFOLLOW) is arguably *stronger* than either source here. |
| 9 | **Bash interceptor (command→tool)** | `bash-interceptor.ts` (regex rule table, quote-aware, piped-stdin exempt) | - (prompt-level `rg` steering in codex, not dsh) | hard-coded `cat`→read interception (NF-074) | **ALREADY-IN** reduced (`cat` only); oh-my-pi's rule-table generalization is **MISSING**. Absorb the rule table + `skipShellWord` + piped-stdin exemption. |
| 10 | **Bash PTY / interactive** | `bash-pty-selection.ts` + `bash-interactive.ts` | `terminal` package (persistent terminals, seam) | one-shot piped `shell.ts` | **COMMON** (both have interactive terminals). **MISSING** in HorizonCode. |
| 11 | **AST edit/grep** | `ast-edit.ts`, `ast-grep.ts`, `pi-ast` | - | none | **UNIQUE to oh-my-pi**, **MISSING**. Tier-3. |
| 12 | **Fuzzy edit ladder + thresholds** | `pi-edit/fuzzy.rs` (10 strategies, named thresholds, Unicode fold, did-you-mean previews) | - | NF-069 ladder (exact→indent→3-way→line-patch, diff-shaped failures) | **ALREADY-IN** the ladder shape; **MISSING** the named threshold priors, the `CommentPrefix`+`Unicode` passes, and the ≤5×80 occurrence previews. CONVERGENT with codex/opencode (merge once). |
| 13 | **Mutation queue** | `file-mutation-queue.ts` (in-process, per-realpath, NOT used by built-in edit/write) | per-tool exclusive scheduling | NF-072 exclusive barrier for edit/write | **ALREADY-IN** effectively (NF-072 serializes mutating tools). oh-my-pi's queue is in-process-only; the prior report's "closes cross-process locking" claim is **overstated** - cross-process locking is **MISSING** in all three. |
| 14 | **Conflict detection (`conflict://`)** | `conflict-detect.ts` (scan, stable ids, splice, `@ours`/`@theirs`) | - | none | **UNIQUE to oh-my-pi**, **MISSING**. Tier-2/3. |
| 15 | **Microkernel plugin seams** | package split (agent vs coding-agent), not a formal seam | Cordis Service Definition/Provider/Consumer, Profiles+Bundles, `ctx.effect` disposers | monolithic `app/src/core` + tools registry; Hooks v1; MCP v1 | **UNIQUE to dsh** (the formal 3-role seam + declarative composition). HorizonCode **MISSING** the seam discipline (doc 03/15 design it; not built). Strategic. |
| 16 | **Four-stage tool pipeline** | agent-loop dispatch (less formal) | `tools/pipeline.ts` (pre-execute/guard/execute/post-execute + ToolCallRecovery) | `loop.ts` dispatch + Hooks v1 (tool.pre/tool.post) + GuardGate | **ALREADY-IN** reduced (Hooks v1 ≈ pre/post; GuardGate ≈ guard). **MISSING**: monotonic guard contract, `ToolCallRecovery` pairing repair, fail-closed approval-degrade with distinct reasons, output-schema validation of body values. |
| 17 | **Fail-closed sandbox ladder** | `pi-iso` + approval-scope/cache | `sandbox/escalation.ts` (per-call mode, strictly-wider table, verbatim markers, one-shot retry) | kernel is advisory; `DEFAULT_POLICY` deny>lease>ask>allow | **UNIQUE to dsh** (the escalation choreography), CONVERGENT with codex OS layers for the *enforcement* half. HorizonCode **MISSING** (kernel advisory; no `partial`/`full` surface; no one-call escalation). Top-2 absorption. |
| 18 | **Repeat-tool guard** | - | `guard/repeat-tool-reminder` (`[3,5,8]`, post-execute count, advisory) | none (only NF-073 format-error cap) | **UNIQUE to dsh**, CONVERGENT with cline loop-detection (merge once). **MISSING** in HorizonCode. Cheap, high-value. |
| 19 | **Stable provider failure codes** | compat-as-data (out of scope) | `llm/error.ts` (8+ codes, regex classifiers, one finish shape) | provider `done{stopReason}` + string-ish errors; `HZ_PROVIDER=groq`→mock silently | **UNIQUE to dsh** in scope, CONVERGENT with codex. **MISSING** - HorizonCode routes retry/compaction on string/stopReason, not a code union. Needs the union in `contracts.ts`. |
| 20 | **Subagent scoping** | ACP bridge surfaces | `subagent/` (delegation-scope statement, return-guidance, capacity≠depth, external agents) | NF-071 subagent via `agent` tool + `DelegateRunner`; one-primitive funnel (ADR-016) | **ALREADY-IN** the funnel; **MISSING** the injected scope statement, capacity/depth split, `ACTIVATION_LIMIT_REACHED`, and external-agent providers. |
| 21 | **Tool-result recovery (pairing)** | re-execute unpaired tail (prior C-8) | agent.ts `ToolCallRecovery` observer | `recoverInterrupted` exists, **called from nowhere** (external audit finding 2) | **COMMON** (both repair pairing). HorizonCode has the hook but it's **MISSING** from the live path - a confirmed crash-resume bug. dsh's observer is the clean wiring. |
| 22 | **Live steering into stream** | `live-steering.ts` (`response.steer`, ordered queues) | inbox `steer`→next-step (between steps, not mid-stream) | steer batch between turns | **UNIQUE to oh-my-pi** (mid-stream). dsh/HorizonCode steer at step boundaries. **MISSING** (mid-stream) in HorizonCode. |
| 23 | **Deliverables / present** | file recorder | `deliverables` (`present` tool + changed-file list) | durable change journal + undo (ruling 36) | **COMMON**, HorizonCode **ALREADY-IN** reduced (change journal). The `present` final-files declaration is **MISSING**. |

---

## 4. Concrete superset absorption plan (mapped to HorizonCode files)

Ordered by value ÷ effort, dependencies first. Each item names the target file(s) and any `contracts.ts` addition. "Merge once" items are CONVERGENT across sources - record one row, cite both.

### Tier 1 - cheap, local, high value

1. **Diagnostics ledger (fresh-only), applied to any verification output.** Port `diagnosticIdentity` (strip `^.*?:\d+:\d+\s+`) + a per-session `Map<path, Set<identity>>` into a new `app/src/core/diagnostics-ledger.ts`, called from `app/src/core/loop.ts` after any tool that surfaces typecheck/lint/test output, so repeated diagnostics are not re-charged to context. Source: oh-my-pi [`lsp/diagnostics-ledger.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/diagnostics-ledger.ts). No `contracts.ts` change. UNIQUE, MISSING.

2. **Repeat-tool reminder guard.** New `app/src/core/guards/repeat-tool.ts`: per-session `Map<sessionId,{key,count}>`, key = canonical-JSON-sorted `[name,args]`, thresholds `[3,5,8]`, gentle-then-detailed text, injected as a notice after tool results in `loop.ts` (reuse the existing additional-context injection path), counted after execution so denied calls count, cleared on a new user turn. CONVERGENT (dsh `repeat-tool-reminder` + cline loop-detection) - merge once. No `contracts.ts` change (advisory). MISSING.

3. **Stable provider failure codes + route-on-code.** Add a closed `ProviderFailureCode` union to `app/src/contracts.ts` (`NO_ADAPTER | MISSING_CREDENTIAL | INVALID_CREDENTIAL | AUTH | RATE_LIMIT | CONTEXT_WINDOW_EXCEEDED | QUOTA | ACCOUNT_QUOTA | EMPTY_RESPONSE | IMAGE_OFFLOAD_REQUIRED`), extend `ProviderEvent`'s `error` variant to carry `code`, and port dsh's `isContextWindowExceededError`/`isQuotaExceededError` regexes into `app/src/core/providers/`. Make `HZ_PROVIDER=groq`→mock a loud error (fixes CURRENT_RUN §5 item 11). CONVERGENT (dsh `llm/error.ts` + codex) - merge once. Owner: `contracts.ts`. MISSING.

4. **Bash interceptor rule table.** Generalize HorizonCode's `cat`→read interception in `app/src/tools/shell.ts` to a configurable `{pattern, flags, tool, message}[]` table with a quote-aware `skipShellWord` tokenizer and the piped-stdin exemption. Source: oh-my-pi `bash-interceptor.ts`. No `contracts.ts` change (tool-internal). Extends NF-074; MISSING (general form).

5. **Edit-ladder sharpening.** In `app/src/tools/edit.ts`: add the named threshold priors (`0.95/0.92/0.8/0.8/0.92`, dominant 0.97+Δ0.08), a `CommentPrefix` pass, a `Unicode`-fold pass (smart quotes/dashes → ASCII so ASCII patches apply to smart-quoted files), and up-to-5 closest-match previews (≤5 lines × 80 chars). CONVERGENT (oh-my-pi `pi-edit/fuzzy.rs` + codex `seek_sequence.rs` + opencode) - merge once, extends NF-069. MISSING (the priors + Unicode pass).

6. **Tool-call pairing recovery on the live path.** Wire the existing `core/admission.ts::recoverInterrupted` into `loop.ts` resume (it's defined but never called - external audit finding 2), modeled on dsh's `ToolCallRecovery` observer: append a synthetic `tool.result` for any unpaired `tool.call` before the next provider call. COMMON (dsh + oh-my-pi C-8). Fixes a confirmed crash-resume bug. MISSING (from the live path).

### Tier 2 - next capability wave

7. **Fail-closed sandbox escalation ladder.** Add `SandboxMode` + the strictly-wider table + the verbatim denial/hint markers + `approveEscalation` (one-shot wider mode, `sandbox_permissions`+`justification` pairing) to `kernel/src/guard.rs` and `app/src/core/kernel.ts`; report enforcement completeness `full|partial` per call. Owner: `contracts.ts` (the `SandboxMode` union + markers are wire/policy). Source: dsh `sandbox/escalation.ts`; CONVERGENT with codex OS layers for the enforcement half. MISSING; aligns with doc 11 sandbox matrix. Note the environment constraint (`docs/audit/landlock-spike-2026-11-08.md`): no bwrap, Landlock ENOSYS on `4.19.0-gvisor` - so the *enforcement* backend is probe-gated, but the *contract/markers/ladder* land regardless.

8. **LSP writethrough + inline diagnostics.** New `app/src/core/lsp/` (client + mux + writethrough) + an `lsp` tool, integrated into `app/src/tools/edit.ts`/`write.ts` so every edit returns fresh diagnostics (via the Tier-1 ledger). Port the tsserver reload-before-`didOpen` guard and the inline/deferred dual budget. Source: oh-my-pi `lsp/{client,writethrough,diagnostics,workspace-diagnostics,lspmux}.ts`, `defaults.json`. Owner: possibly a new tool schema in `contracts.ts`. UNIQUE, MISSING, highest capability value.

9. **`systemPromptUpdate:'in-history'`.** Add a per-model capability flag to the provider/model info in `contracts.ts`; in `loop.ts` request assembly, when set, append a changed system rail *after* the cached history instead of rewriting the leading message. Extends NF-005 (cache-guard). Source: dsh agent.ts. UNIQUE, MISSING.

10. **Output-budget alignment.** In `app/src/core/output-budget.ts`: add the skip-fit cases (model declares no window; `stopsOutputAtContextWindow`; OpenRouter self-cap), and a `findRequestUsageAnchor`-style newest-assistant-usage anchor instead of the whole-prompt estimate. Consider whether `HEADWAY_TOKENS=4096` can drop toward oh-my-pi's measured 64 once a real usage anchor exists (HorizonCode's 4096 compensates for the byte/4 estimate; a provider-anchored count removes most of that need). Extends NF-074. Source: oh-my-pi `output-budget.ts`. ALREADY-IN with drift.

11. **Subagent scope statement + capacity/depth.** In `app/src/core/subagent.ts`/`app/src/tools/agent.ts`: inject a delegation-scope statement and return-guidance into every child, split `maxActiveSubagents` (default 8, root free) from `maxDepth` (default 1), and surface an `ACTIVATION_LIMIT_REACHED` terminal. Source: dsh `subagent/`. Extends NF-071. MISSING.

### Tier 3 - strategic

12. **Microkernel seam discipline** (dsh Service Definition/Provider/Consumer) applied to HorizonCode's fs/shell/sandbox so a remote-sandbox swap moves all execution tools at once. Architectural; touches `app/src/core/kernel.ts`, the tools registry, doc 03/15. UNIQUE to dsh. Strategic, not a quick win.

13. **Speculative execution across turns** (oh-my-pi) - extends NF-072 in `loop.ts`; gate behind the concurrency classes already shipped. UNIQUE, MISSING, high complexity.

14. **DAP debug tool** (oh-my-pi `dap/`) and **AST edit/grep** (`ast-edit.ts`/`ast-grep.ts`/`pi-ast`) - new tools; large effort; only if debugging/structural-refactor workflows are in scope. UNIQUE, MISSING.

15. **Conflict-resolution surface** (`conflict://` scheme, oh-my-pi `conflict-detect.ts`) - a read-path capability for merge-conflict resolution; pairs with the change journal. UNIQUE, MISSING.

### `contracts.ts` additions implied by this plan

- `ProviderFailureCode` closed union + `code` on the `error` ProviderEvent variant (item 3).
- `SandboxMode` union + escalation markers + `sandbox_permissions`/`justification` fields (item 7).
- A per-model `systemPromptUpdate` capability flag on provider/model info (item 9).
- An `lsp` tool schema if the LSP tool is exposed to the model (item 8).
- Subagent capacity/depth + `ACTIVATION_LIMIT_REACHED` terminal (item 11; the terminal vocabulary already lives in `TerminalState` - add `activation_limit` or reuse `denied`).

### Deliberate refusals (do NOT absorb)

- oh-my-pi's 16k-line `agent-session.ts` monolith (already a standing refusal) and its full memory/autolearn/hindsight/mnemopi suite (NF-075 owns the reduced growth loop).
- dsh's full 50-package adapter breadth (`ssh`, `terminal`, `computer-use`, `browser-use`, `team`, `jobs`, `workflow`, `goal`, `schedule` adapters) - take the *seam contracts* (item 12), not the adapters.
- The provider roster / models.dev / opencode provider lifecycle - explicitly the other agent's deliverable; this report touches it only as the capability-fact seam (item 3, item 10's `compat` flags).

---

## 5. Notes, caveats, and corrections to the prior reports

- **The marketing numbers remain NOT VERIFIABLE.** oh-my-pi's 72% / −61% claims have no benchmark artifact in the tree (confirmed again this pass; consistent with `docs/30` §1). Steal mechanisms, not rankings - keep the H-7 metric contract.
- **Mutation-queue claim corrected.** `file-mutation-queue.ts` is in-process only and is explicitly NOT used by oh-my-pi's built-in edit/write (source comment). It does not close HorizonCode's cross-process locking gap; that gap is MISSING in all three repos.
- **dsh error codes are richer than the first wave recorded.** The prior §5.7 listed 7 codes; source adds `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`, `IMAGE_OFFLOAD_REQUIRED`, and the two regex classifiers - worth pulling verbatim.
- **HorizonCode's output-budget framing constant already matches** (`FRAMING_CHARGE_TOKENS = 16` = oh-my-pi's `MESSAGE_FRAMING_TOKENS`), but its headway (4096) and floor (256) diverge from oh-my-pi's measured 64 / 1024 because HorizonCode lacks a provider-usage anchor and compensates with a larger reserve. The alignment is only safe *after* an anchor lands (item 10).
- **HorizonCode's spill safety is stronger** than either source's: `writeSpillSafely`/`writeSpillFile` use `O_CREAT|O_EXCL|O_NOFOLLOW` + 0600 to defeat the symlink-plant attack. Keep it; do not regress to a plain write when porting LSP writethrough's `writeFileWithFallback`.
- **The crash-resume pairing bug is confirmed on both sides:** HorizonCode's `recoverInterrupted` is dead code (external audit finding 2); dsh's `ToolCallRecovery` is the reference wiring (item 6).
- **Provider/catalog surface deliberately excluded** per scope; the `pi-ai` wire and `packages/catalog` KDL tree were not read beyond the `compat`-flag seam that `output-budget.ts` consumes.
