# Strict comparison: codex & grok-build vs HorizonCode (follow-up deep pass)

> Research-only. No file in HorizonCode or the external repos was modified.
> Scope (per orchestrator briefing): the two large Rust agents **codex** (openai/codex)
> and **grok-build** (xai-org/grok-build), read exhaustively, EXCEPT their
> provider/catalog/auth surface which another agent owns (noted briefly, not deep-dived).
> This is a strict follow-up to the first merged steal-list (`docs/30-steal-list.md` §5)
> and re-verifies/extends `research/steal-ohmypi-codex.md` (Part 1) and
> `research/steal-grok-claude-deepseek.md` (Part 2) against the current source.
> Every claim cites an exact path. Classifications per subsystem:
> **COMMON** (both repos have it; merge once), **UNIQUE** (only one has it; absorb),
> **ALREADY-IN-HORIZONCODE** (shipped), **MISSING** (not in HorizonCode; designed or absent).

## 0. Repos, revisions, grounding

| Repo | Path | Rev (this clone) | Shape |
|---|---|---|---|
| codex | [`openai/codex`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053) | `8703d32` ("Treat goal objectives as untrusted context", #60342) | Rust workspace `codex-rs/` (~128 crates) + `codex-cli` + `sdk/` |
| grok-build | [`xai-org/grok-build`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | `SOURCE_REV 559751f…` (synced from the SpaceXAI monorepo) | Rust; `xai-grok-*` runtime crates + ~90 `crates/codegen/` crates |

HorizonCode grounding confirmed by reading this pass:
- **LAW**: `app/src/contracts.ts` (v0.1 frozen; `DEFAULT_POLICY`, `GuardAction`/`GuardDecision`, `Tool.concurrencyClass`, `RunBudget`/`RunExit`, kernel NDJSON `KernelRequestMap`), `kernel/src/canon.rs` (canonical JSON + sha256 + HMAC anchors, byte-identical to contracts.ts).
- **Kernel**: `kernel/src/guard.rs` (deny > lease > ask > allow; structural `kernel-state-protected` fs.write deny; lexical symlink resolution `resolve_lexical`; one-use leases `take_matching_lease`; session **grants** that mint one-use bound leases `mint_bound_lease`; owner-scoped visibility; hardlinked-policy refusal), plus `permm.rs`, `eventlog.rs`, `receipts.rs`, `protocol.rs`.
- **App**: `app/src/core/loop.ts` (1894 LoC; sentinel rails, `concurrencyClassOf`, batch), `app/src/tools/edit.ts` (448 LoC; NF-069 ladder), `app/src/tools/shell.ts` (417 LoC; NF-074 interceptor + minimiser + `spawnOwned`), `core/kernel.ts` (1491 LoC).
- **Status authority**: `docs/28-implementation-status.md` (what is TESTED+VERIFIED vs DESIGNED-ONLY), `docs/11-authority-safety.md` (the sandbox matrix, S5/N1–N10 requirements, which already cite codex `execpolicy`/`seccomp.rs` and grok `egress-proxy` as reference implementations), `docs/24-feature-catalog.md` (NF registry).

The single most important framing fact: **HorizonCode's guard is an authority model (decide allow/ask/deny and mint leases), not an OS-enforcement model.** `docs/28` §4 item 11 and ruling 38 state plainly that Code Mode and shell run with the user's ambient authority (bridge-policed only); the OS sandbox (NF-016) is the top open item. Both codex and grok are strongest precisely where HorizonCode is weakest: *actual OS/kernel/network enforcement*.

---

## 1. codex (`codex-rs/`), exhaustive architecture + per-subsystem findings

### 1.1 Workspace shape (what changed since the prior report)

The tree has grown materially past the prior report's "~128 crates / `core`-centric" picture. New or expanded, directly in scope:
- `core/src/exec_policy/` + `exec_policy.rs` + `network_policy_decision.rs`, the execpolicy is now wired into the core loop as a first-class decision, not just a standalone crate.
- `core/src/sandboxing/` + `sandbox_tags.rs` + `windows_sandbox.rs` + `windows_sandbox_read_grants.rs`, per-OS sandbox selection is a core module.
- `core/src/guardian/` is now a full subsystem (23 files: `review_session*.rs`, `score_authorization.rs`, `request_budget.rs`, `input_budget.rs`, `routing.rs`, `coverage.rs`, …).
- `core/src/session/` holds the loop (`turn.rs`, `turn_context.rs`/`step_context.rs`), the whole `compact*` family, `rollout_reconstruction.rs`, `daemon_recovery.rs`, `inject.rs`/`input_queue.rs`, `multi_agents.rs`.
- `core/src/hook_runtime/` + `hook_runtime.rs` + `hook_environment_executor.rs` + `hook_mcp_executor.rs`, hooks can be shell, MCP, or environment executors.

### 1.2 execpolicy, the declarative command allowlist (`execpolicy/`)

Strongly evolved and the direct reference for HorizonCode's designed allowlist (doc 11 N2: "decided by `(scheme, host, port)` allow rules, not a boolean").

- **`policy.rs::Policy`** keys rules by first token (`rules_by_program: MultiMap<String, RuleRef>`) plus a separate case-insensitive index (`insensitive_rules`) built from `PrefixRule`s flagged `canonical_matching`. Network rules are a separate `Vec<NetworkRule>`. Host-executable path pinning lives in `host_executables_by_name: HashMap<String, Arc<[AbsolutePathBuf]>>`.
- **`RequirementsExecPolicy`** wraps a `Policy` with **order-independent equality** via `fingerprint()` (sorts `"{program}:{rule:?}"` strings), so two policies compiled in different orders compare equal. This is the "sorted fingerprint" the prior report named, now a named type.
- **`preserves_managed_requirements(&self, requirements)`** (policy.rs): a *transport/snapshot verification*, checks that a snapshot policy still enforces every managed rule, including the subtle cases that an exact path match can shadow a basename rule, a differently-cased path can shadow a managed basename, and a later network *allow* can override a managed *deny* for the same host (`compiled_network_domains()` folds allow/deny with last-writer-wins via `upsert_domain`). HorizonCode has nothing equivalent (its policy is a flat `PolicyRule[]` list with no managed/snapshot distinction).
- **`rule.rs`**: `PrefixPattern{canonical_matching, first, rest: [PatternToken]}` with `PatternToken::{Single, Alts}` (a token may be one of several allowed values). `canonical_key()` = Unicode NFD + full case-fold + NFD, a Unicode-correct caseless compare, far beyond HorizonCode's `pattern_matches` (exact-or-trailing-`*`). `NetworkRule{host, protocol: {Http,Https,Socks5Tcp,Socks5Udp}, decision, justification}` with `normalize_network_rule_host` (strips scheme/path/port, rejects wildcards and whitespace, lowercases).
- **Fallback + decision aggregation**: `matches_for_command_with_options` tries exact rules → host-executable rules (only if `resolve_host_executables`) → else a `HeuristicsRuleMatch` from a caller fallback closure. `Evaluation::from_matches` takes the **max** `Decision` across matches (deny > ask > allow precedence encoded in `Decision`'s `Ord`), i.e. most-restrictive-wins, same spirit as HorizonCode's R1.
- **`amend.rs`**: `blocking_append_allow_prefix_rule` / `blocking_append_network_rule` append rules to a Starlark-ish `.rules` file under **advisory file lock** (`file.lock()`), dedup-by-line, newline-safe. This is runtime policy growth that is crash/concurrency-safe. HorizonCode's `guard.rs` grows authority only via in-memory leases/grants (no durable allowlist file the model can extend).

### 1.3 OS sandbox, three layers on Linux (`linux-sandbox/`)

Read `seccomp.rs` in full. Confirmed and sharper than the prior report:
- **Thread-scoped application**: `apply_sandbox_policies_to_current_thread` applies `PR_SET_NO_NEW_PRIVS` + seccomp on the *child's* thread only, so the CLI process is unaffected.
- **Three network modes** (`NetworkSeccompMode::{Restricted, ProxyRouted, VmSocketRestricted}`): `Restricted` denies `connect/accept/bind/listen/sendto/...` and allows `socket`/`socketpair` only for `AF_UNIX` (a `SeccompCondition` on arg0). `ProxyRouted` allows `AF_INET`/`AF_INET6` in the isolated namespace (to reach the local TCP bridge) but denies other families. `VmSocketRestricted` denies only `AF_VSOCK` (the WSL2/host-bridge escape). `io_uring_{setup,enter,register}` is denied in *every* mode (io_uring can open AF_VSOCK without a `socket()` syscall), a subtlety worth stealing verbatim.
- **Default-allow seccomp with per-syscall EPERM**: `SeccompAction::Allow` default, `Errno(EPERM)` on match; arch-gated to x86_64/aarch64.
- **Filesystem**: bubblewrap (`bwrap.rs`, `bundled_bwrap.rs` with digest verification) is the real FS boundary; **Landlock is retained but *rejected* for FS-restricted policies** (the function returns `UnsupportedOperation` for restricted read-only). `proxy_routing.rs`/`proxy_lifecycle.rs` tie the sandbox to the network-proxy.
- Windows has its own module ([`core/src/windows_sandbox.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/windows_sandbox.rs), `windows-sandbox-rs`).

### 1.4 network-proxy, allowlisted egress at the HTTP/MITM layer (`network-proxy/`)

A large crate (50+ files) codex uses to give a network-isolated sandbox controlled egress: `domain_matcher.rs`, `host_policy_tests.rs`, `connect_policy.rs`, `mitm.rs`/`mitm_hook.rs` (TLS MITM for inspection), `credential_broker.rs` + `secret_substitution.rs` (inject secrets into allowed requests without exposing them to the model), `aws_sigv4.rs`, `socks5.rs`, `remote_config.rs`. This is codex's analogue of grok's egress proxy but positioned as a *proxy the sandboxed child is routed through* rather than a per-origin decider. Both exist; see §3 egress row.

### 1.5 apply-patch, custom grammar + graduated fuzzy matching (`apply-patch/`)

- **`parser.rs`** documents the full Lark grammar at the top (`*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` / `@@ context` / `*** End of File`), plus an `environment_id` line. `PARSE_IN_STRICT_MODE = false` with the comment that only gpt-4.1 needs lenience but threading a strictness param everywhere was not worth it. `streaming_parser.rs` validates patches as they stream.
- **`seek_sequence.rs`** (read in full) is the fuzzy-context ladder: (1) exact, (2) `trim_end` (rstrip), (3) `trim` (both sides), (4) a **Unicode-normalise** pass that folds typographic dashes (`\u{2010}`–`\u{2015}`, `\u{2212}` → `-`), smart quotes (→ `'`/`"`), and odd spaces (NBSP, en/em/thin spaces, ideographic space → ` `) to ASCII. `eof`-anchored search tries the end of file first. Defensive: empty pattern → `Some(start)`; pattern longer than input → `None` (no panic).
- **`safety.rs`** (read in full) decides `AutoApprove | AskUser | Reject{reason}` for a patch purely from the writable-roots policy and sandbox availability, independent of the edit mechanics. Key invariant comment: even a writable-path-constrained patch is still run in a sandbox because a path could be a **hardlink out of the writable root** (`is_write_patch_constrained_to_writable_paths` + the sandbox requirement). `AskForApproval::{Never, OnRequest, UnlessTrusted, Granular{sandbox_approval}}` is the approval mode vocabulary.

### 1.6 Tool exposure classes + tool search ([`tools/registry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/registry.rs), [`tools/src/tool_executor.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tools/src/tool_executor.rs))

- **`ToolExposure`** enum (tool_executor.rs:51) has six variants: `Direct`, `DirectModelOnly`, `Deferred`, `DeferredModelOnly`, `CodeModeOnly`, `Hidden`. `is_direct()`/`is_deferred()`/`is_available_in_code_mode()` gate three surfaces (initial tool list, tool-search discovery, nested code-mode). `Deferred` tools supply `search_info` so the model finds them via a `tool_search` meta-tool instead of paying context for every spec up front. This is a graduated prompt-budget control HorizonCode lacks entirely (its toolset is a fixed list in `tools/index.ts`).
- `router.rs` has `supports_parallel_tool_calls(name)` (parallel batch, the NF-072 mechanism, confirmed on a second source) and `has_terminal_controls()` (unified_exec `exec_command`/`write_stdin`). [`tools/parallel.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/parallel.rs) serializes non-parallel calls and batches parallel ones.

### 1.7 Prompts, per-model instruction files, fail-soft (`prompts/`, `core/*_prompt.md`)

- `core/` ships `gpt-5.1-codex-max_prompt.md`, `gpt-5.2-codex_prompt.md`, `gpt_5_1_prompt.md`, `gpt_5_2_prompt.md`, `gpt_5_codex_prompt.md`. `prompts/src/model_instructions.rs::render_model_instructions(model_info)` resolves `ModelInfo → instructions_template()`; **a missing template logs `tracing::warn!` and returns empty** (fail-soft, never crash), read in full and confirmed. Task-specific templates ([`prompts/src/compact.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/src/compact.rs), `guardian_instructions.rs`, `review_request.rs`, `update_plan_instructions.rs`, `permissions_instructions/`, `multi_agent_instructions.rs`) are `include_str!`-compiled. HorizonCode has one base prompt (`core/instructions.ts`) with no per-model selection.

### 1.8 Server mode + rollout + daemon recovery (`app-server*`, `session/`)

- `app-server`, `app-server-daemon`, `app-server-protocol`, `app-server-transport`, `app-server-client`, a long-lived JSON-RPC server other clients attach to. [`core/src/rollout.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/rollout.rs) + `rollout_budget.rs` + `thread_rollout_truncation.rs` persist the full event stream; [`session/daemon_recovery.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/daemon_recovery.rs) + `rollout_reconstruction.rs` rebuild a session after a crash. Directly relevant to HorizonCode's **open "server mode" gap** (`docs/28` §12).

### 1.9 Guardian, an action classifier subsystem (`core/src/guardian/`)

A full review subsystem (not just one file): `review_session*.rs` runs a classifier over proposed actions vs instructions ([`prompts/src/guardian_instructions.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/src/guardian_instructions.rs)), with its own `request_budget.rs`/`input_budget.rs` (bounded context), `score_authorization.rs`, `response_resampling.rs`, `routing.rs`, `coverage.rs`. [`session/guardian_checkpoint.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/guardian_checkpoint.rs) ties it to the turn loop. HorizonCode's `core/review.ts` is a far thinner post-turn review-fork (NF-075), with no per-action classifier gate.

### 1.10 Hooks runtime (`core/src/hook_runtime*`, `hooks/` crate)

Pre/post-tool, pre/post-compact, turn-stop, session-start hooks, with three executor backends (`hook_environment_executor.rs`, `hook_mcp_executor.rs`, shell). `registry.rs` calls `run_pre_tool_use_hooks`/`run_post_tool_use_hooks` and `record_additional_contexts` (a post-hook can attach context). Richer than HorizonCode's hooks v1 (`core/hooks.ts`: `tool.pre`/`tool.post` only, JSON-line, deny-only, `docs/28` ruling 35).

### 1.11 unified_exec + turn diff tracker + responses_retry (confirmed)

`core/src/unified_exec/` (stateful PTY terminal: `exec_command` + `write_stdin`, `async_watcher.rs`, `stdin_approval.rs`; on sandbox denial retry with `SandboxType::None` when policy allows, *without re-prompting*). `turn_diff_tracker.rs` emits one `TurnDiffEvent` per turn. `responses_retry.rs`: separate `retries`/`connection_retries`, server `Retry-After` controls timing but never raises the configured retry count.

---

## 2. grok-build, exhaustive architecture + per-subsystem findings

Layout (`crates/codegen/` is the bulk): `xai-grok-shell` (runtime + leader/stdio/headless), `xai-grok-tools` (+ `-api`), `xai-grok-workspace` (fs/VCS/exec/checkpoints + `-daemon`/`-client`), `xai-grok-permission-rules`, `xai-grok-egress-proxy`, `xai-grok-sandbox`, `xai-grok-memory`, `xai-grok-agent`, `xai-grok-pager*` (TUI), `xai-grok-hooks`, `xai-grok-mcp`, `xai-fast-worktree`, `xai-circuit-breaker`→`xai-grok-*` family, `xai-interjection`→`xai-prompt-queue`.

### 2.1 Egress proxy, per-origin network authority ([`xai-grok-egress-proxy/src/decider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/decider.rs))

Read in full; the single most distinctive grok capability, and HorizonCode has **nothing like it**.
- **`Decider` trait**: `decide(origin, call) → Decision` where `Decision = {Allow, AllowAndRecord{would: WouldBe}, Deny, Ask}`. `Ask` **parks the connection** (`hold()` returns a `oneshot::Receiver<bool>`); nothing is relayed while held. `admits_unauthenticated()` and `stopping()` round out the trait.
- **Two-level hold budgets**: `DEFAULT_MAX_HELD = 16` proxy-wide (a `Semaphore`), `DEFAULT_MAX_HELD_PER_CALL = 8` per credential (`HoldBudget` keyed by `Option<CommandTag>`), so one command's unanswered asks can't pin every slot; over-budget → `503 overloaded` *before* a card is raised. `DEFAULT_HOLD_TIMEOUT = 600s` → auto-`403`.
- **Observe mode**: `AllowAndRecord{would: WouldBe::{Allowed, Denied(DenySource::{DenyRow, WebFetchDenylist}), Asked}}` records what enforce mode *would* have done, per host, without blocking, a safe policy-rollout path. `DenySource` distinguishes a per-host deny row from the org `disallowed_web_fetch_domains`.
- **Content-free records**: `BlockedRequest{host, port, call, decided: DeciderOutcome, hold_ms, deadline_unix}` with no path/headers/body, broadcast to a `BLOCKED_REQUEST_CAPACITY = 256` channel for UI cards/logs.
- **`ProxyState::admit`** is the enforcement seam: policy (`self.policy.evaluate(origin)`) first, then the decider under a request timeout, then `hold()` with EOF detection (a client half-close while held reads as `Abandoned`), a drain path (`stopping` → deny, so a shutdown never waits out a card), and a `MAX_HELD_CLIENT_BYTES = 64 KiB` early-record cap. Paired with `xai-grok-sandbox` network-policy/child-net/runtime-sockets.

### 2.2 Hashline edit anchors (`xai-grok-tools/.../grok_build_hashline/scheme.rs`)

Read in full. A read/edit format that attaches a freshness anchor to every line (`LINE:LOCAL[:CONTEXT]`), so the harness can prove the model's view of a file is current and recover small shifts deterministically.
- **`AnchorScheme` trait** with three implementations: **`ContentOnly`** (`LINE:local`, whitespace-normalised `line_hash`, survives indentation change, weakest freshness, proven by `content_only_survives_indentation_change`), **`ChunkFingerprint`** (`LINE:local:chunkfp` over 16-line chunks via FNV-1a mix; edit anywhere in the chunk invalidates), **`CheckpointChain`** (`LINE:local:chainfp` chained from the nearest 32-line checkpoint; strongest, more churn).
- **`validate() → {Valid, Stale, OutOfRange}`**; **truncated anchors that drop the context component are rejected as `Stale`** (chunk/checkpoint schemes `return Stale` when `anchor.context` is `None`), can't silently degrade to content-only. `ParsedAnchor::parse` rejects malformed forms (line 0, uppercase hash, empty context).
- **`find_shifted(anchor, lines, radius)` → `ShiftResult::{Found{new_line}, Ambiguous{candidates}, NotFound}`**: searches `±DEFAULT_SEARCH_RADIUS = 15` lines, with a cheap local-hash prefilter before the full context check (`find_shifted_generic`). Ambiguity (>1 match) is a first-class outcome, not a silent pick.
- `validation_window_lines()` reports read-amplification per scheme (1 / chunk_size / distance-to-checkpoint) for the benchmark harness. This is materially stronger than HorizonCode's `edit.ts` ladder: staleness lives *in the address*, not in re-matching a whole block.

### 2.3 Permission rules (`xai-grok-permission-rules/`)

Read `bash_command_splitting.rs`, `exec_risk.rs`, `source_identity.rs` in full; surveyed the rest.
- **`bash_command_splitting.rs`**: parses bash with **tree-sitter-bash** (`try_parse_shell`), then `try_parse_word_only_commands_sequence` accepts a script only if every node is in a strict `ALLOWED_KINDS` allowlist (`program/list/pipeline/command/word/string/...`, env assignments, redirections, heredocs, comments) and every punctuation token is in `ALLOWED_PUNCT_TOKENS` (`&& || ; |` + quoting/redirect). `declaration_command` (`export K=V`) is **deliberately excluded** so an ask-mode segment evaluation can't miss a `PATH`/`LD_PRELOAD` hijack. `PlainCommand::spans_whole_script` guards against a dequoted word standing in for a wider script (a dropped assignment or sibling would let a wider script match a narrower grant).
- **`exec_risk.rs`**: `normalize_for_exec_risk` alternately peels canonical wrappers (`unwrap_wrappers_checked`) and transparent prefixes (`peel_transparent_prefixes`) to a fixed point under a bounded budget (`MAX_NORMALIZE_ROUNDS = MAX_WRAPPER_DEPTH + MAX_TRANSPARENT_PREFIX_DEPTH`), failing **closed** on exhaustion / a split-string / a chdir. Detects per-program risk: `sort --compress-program` (spawns a program), git config retargets (`--git-dir`/`--work-tree`/`--config-env`) via `is_accepted_long_option_prefix` (shortest-unique-stem matching, e.g. `--co` for `--config-env`). This is **per-sub-command risk scoring**, not whole-string approval.
- **`source_identity.rs`**: `normalize_git_url` / `is_same_source_identity` canonicalise git remotes (lowercase scheme+host only, never the path, lowercasing the path would widen an allowlist to other repos; `C:/mkt` stays a local path). Used by `folder_trust.rs`/`trust.rs` (a program named by a workspace stays off until the folder is trusted), the implemented form of HorizonCode's project-config-safety principle (doc 11 C2).
- Other files: `claude_settings.rs` reads [`.claude/settings.json`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/.claude/settings.json) allow/ask/deny (interop), `git_content_filters.rs` filters secrets out of git content the model sees, `managed_policy/` + `project_config.rs` + `gate_preflight.rs`.

### 2.4 Memory with "dream" consolidation (`xai-grok-memory/`)

A v2 store (`storage_v2.rs`, `v2_capture.rs`, `v2_consolidation.rs` with `DreamClaimRequest`/`ConsolidationLease`/`V2ConsolidationStore::open`, `v2_carryover.rs`, SQLite schema, `MEMORY.md` manifest). Background **batch "dream"** consolidation (`batch_dream_{catalog,plan,outline,commit,recovery,session,control,io}.rs` + `dream_lock.rs`). Retrieval: embeddings + BM25 (`search.rs`) + **MMR diversity re-rank** (`mmr.rs`: `MMR(d) = λ·rel(d) − (1−λ)·max_sim(d, selected)`, `mmr_rerank`) + query expansion (`query_expansion.rs`). Read-before-write on self-edits; protected `MEMORY.md`, writable only under `topics/` + `observations/_inbox/` (the `FakeMemoryV2Access` contract in [`grok_build_hashline/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/mod.rs)). HorizonCode's NF-075 is a review-fork + append-only curator (`core/review.ts`, `core/curator.ts`) with **no retrieval/consolidation engine**, grok's is a working reference.

### 2.5 Multi-dialect tools + hosted tools (`xai-grok-tools/src/implementations/`, [`xai-grok-agent/src/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/agent.rs))

- **Parallel tool implementations** for other harnesses: `codex/` (`apply_patch`, `grep_files`, `list_dir`, `read_file`), `opencode/` (`bash`, `edit`, `glob`, `grep`, `read`, `write`, `todowrite`, `skill`), `claude_alias.rs`, plus grok's own `grok_build`/`grok_build_concise`/`grok_build_hashline`, `lsp/`, `memory/`, `skills/`, `web_search/`. A model is driven with the tool dialect it was trained on. (`tool_taxonomy.rs` with the canonical `_meta` envelope `x.ai/tool` and `presentation_name()` was noted in the prior report; confirmed present.)
- **Hosted ("server-side") tools** (`agent.rs`): `hosted_tools: Vec<HostedTool>` sent as native Responses-API types (e.g. `WebSearch`) and executed server-side by the agentic sampler, **ANDed at request time with the per-model `supports_backend_search`** (agent.rs:37; the comment warns not to use `hosted_tools().is_empty()` as a proxy, the list also depends on web-search config). HorizonCode executes every tool locally through the guard; it has no hosted-tool concept.

### 2.6 Other grok notables (surveyed)

`xai-fast-worktree` + `xai-grok-workspace` checkpoints (fast git worktree snapshots), `xai-crash-handler`, `xai-circuit-breaker`, `xai-prompt-queue`/interjection (live steering), `xai-grok-agent/compaction.rs` + `compact_system_prompt()` (a shorter post-compaction system prompt) + `agents_md_user_reminder()` (AGENTS.md injected as an audience-aware `<system-reminder>` user message), `xai-grok-hooks` + `xai-hooks-plugins-types`, `xai-grok-plugin-marketplace`.

---

## 3. STRICT comparison matrix (per subsystem)

Legend: **AI** = ALREADY-IN-HORIZONCODE (shipped/TESTED), **D** = designed-only in HorizonCode (`docs/28` DESIGNED), **M** = MISSING (no code, not even designed), **COMMON** = codex & grok both have it, **UNIQUE(x)** = only repo x has it.

| Subsystem | codex | grok-build | COMMON / UNIQUE | HorizonCode status | Verdict |
|---|---|---|---|---|---|
| **OS sandbox (FS)** | bubblewrap + digest-verified bundled bwrap; Landlock legacy (rejected for restricted FS), `linux-sandbox/src/{bwrap,bundled_bwrap,seccomp}.rs` | `xai-grok-sandbox` (network-policy/child-net/runtime-sockets) | COMMON (both confine) | Authority-only; OS sandbox is **D/M** (NF-016 top open item; Landlock absent on `4.19.0-gvisor` per `docs/28` ruling 38) | **MISSING**, absorb codex seccomp+bwrap reduced form |
| **Network seccomp / syscall deny** | `seccomp.rs` 3 modes (Restricted/ProxyRouted/VmSocketRestricted), io_uring + AF_VSOCK denial | (via sandbox crate) | UNIQUE(codex) for the seccomp detail | **M** | **MISSING(codex)**, directly portable to the NF-016 netns+seccomp reduced form |
| **execpolicy / command allowlist** | `execpolicy/` `Policy`+`RequirementsExecPolicy.fingerprint()`+`preserves_managed_requirements`+`amend` (file-locked), Unicode caseless, `NetworkRule` | `xai-grok-permission-rules` tree-sitter bash splitting + per-segment `exec_risk` + folder-trust + source-identity | COMMON (both: data-driven, per-command), **different strengths** | HorizonCode has a flat `PolicyRule[]` + `DEFAULT_POLICY` + leases/grants in `guard.rs`; **no command allowlist, no per-segment split, no managed/snapshot** | **MISSING (merge once)**, codex owns the compiled-allowlist + fingerprint; grok owns the bash-splitting + per-segment risk |
| **Egress proxy (per-origin)** | `network-proxy/` allowlisted egress + MITM + credential-broker + secret-substitution (proxy the child is routed through) | `xai-grok-egress-proxy/decider.rs` per-origin `Allow/Deny/Ask` + hold budgets + observe mode + content-free records | COMMON (both: real egress control), grok = per-origin decider, codex = routed proxy | **D** (doc 11 N1–N10, S/N requirements; both repos already cited as reference impls) | **MISSING (merge once)**, absorb grok's `Decider`/observe-mode as the authority seam, codex's proxy as the routed enforcement |
| **Edit grammar + fuzzy** | `apply-patch` custom grammar + `seek_sequence` 4-rung ladder (exact→rstrip→trim→Unicode-fold, eof-anchored) + streaming parser | [`grok_build_hashline/scheme.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs) 3 anchor schemes + `±15` shift recovery + truncated-anchor rejection | UNIQUE each (codex = fuzzy context matching; grok = address-level staleness anchors) | **AI**, `edit.ts` has the NF-069 ladder (exact→indent→3-way→line-patch, unique-only, diff-shaped feedback, `max_reflections=1`, preimage-sha256 conflict check) | **PARTLY-AI**, ladder shipped; **MISSING**: codex's Unicode-fold rung + grok's hashline anchors |
| **Prompts / per-model** | per-model `*_prompt.md` + `render_model_instructions` (fail-soft warn-on-miss) | `compact_system_prompt()`; AGENTS.md as audience-aware reminder | UNIQUE(codex) for per-model files | **M**, one base prompt (`instructions.ts`); project-memory hierarchy is **AI** | **MISSING(codex)**, per-model instruction templates |
| **Server mode / rollout / recovery** | `app-server*` + `rollout.rs` + `daemon_recovery.rs` + `rollout_reconstruction.rs` | `xai-grok-shell` leader + `xai-grok-active-sessions`/`foreign-sessions` | COMMON (both have a server/leader) | **D/M**, "server mode open" (`docs/28` §12); event log (`eventlog.rs`) is the natural rollout; ACP designed (`docs/14` S89) | **MISSING (merge once)**, codex is the closest reference (JSON-RPC + rollout recovery) |
| **Tool exposure classes** | `ToolExposure` 6-variant (Direct/Deferred/CodeModeOnly/Hidden) + `tool_search` | multi-dialect tool impls + `tool_taxonomy` | UNIQUE(codex) for exposure classes | **M**, fixed toolset in `tools/index.ts`; `concurrencyClass` is **AI** | **MISSING(codex)**, exposure field + deferred discovery |
| **Parallel tool batch** | `router.supports_parallel_tool_calls` + `parallel.rs` | (per tool) | COMMON | **AI**, NF-072 `Tool.concurrencyClass` ("shared"/"exclusive"), `concurrencyClassOf`+batch in `loop.ts`; `edit`/`shell` `exclusive` | **ALREADY-IN** (confirmed on a 2nd+3rd source) |
| **Hooks lifecycle** | `hook_runtime/` pre/post-tool + pre/post-compact + turn-stop + session-start; shell/MCP/env executors | `xai-grok-hooks` + plugin types | COMMON | **AI (reduced)**, hooks v1 `tool.pre`/`tool.post`, JSON-line, deny-only (`docs/28` ruling 35) | **PARTLY-AI**, richer event set + executor backends **MISSING** |
| **Guardian / action classifier** | `core/src/guardian/` full subsystem (classifier + budgets + routing + coverage) | (permission actor + egress) | UNIQUE(codex) | **AI (thinner)**, `core/review.ts` post-turn fork (NF-075), no per-action classifier | **PARTLY-AI**, the per-action classifier gate is **MISSING(codex)** |
| **Memory / growth** | (relies on MCP; no retrieval engine) | `xai-grok-memory` v2 + dream consolidation + BM25+embeddings+MMR | UNIQUE(grok) | **AI (reduced)**, NF-075 review-fork + append-only curator (`core/curator.ts`), no retrieval/consolidation | **PARTLY-AI**, the retrieval/consolidation engine is **MISSING(grok)** |
| **Interactive/PTY exec** | `unified_exec/` (`exec_command`+`write_stdin`, PTY, sandbox-deny auto-retry) | `xai-grok-shell-terminal`/`ptyctl` | COMMON | **M**, `shell.ts` is one-shot; it *blocks* interactive (`INTERACTIVE_BLOCKLIST`) and intercepts `cat`→read | **MISSING (merge once)**, stateful PTY tool |
| **Turn diff tracker** | `turn_diff_tracker.rs` (one `TurnDiffEvent`/turn) | `xai-hunk-tracker` | COMMON | **M**, per-tool output only; `change-journal.ts` is per-edit | **MISSING (merge once)** |
| **Streaming retry (bounded)** | `responses_retry.rs` (server advice = timing not count) | `xai-circuit-breaker` | COMMON | **AI**, `core/providers/retry.ts` | **ALREADY-IN** (codex's "never raise the count" rule is a sharpening) |
| **Worktree / checkpoints** | `git-utils` | `xai-fast-worktree` + workspace checkpoints | COMMON | **AI**, `core/checkpoints.ts` + `/rewind` (wave 14c) | **ALREADY-IN** |
| **Canonical audit log / hash chain** | `rollout.rs` (event stream) | session events |, | **AI (stronger)**, `kernel/` chained event log + receipts + canonical JSON (`canon.rs`), HMAC anchors; this is HorizonCode's distinctive strength neither repo matches | **ALREADY-IN (HorizonCode leads)** |
| **Multi-dialect tool compat** | (single dialect) | `codex/`+`opencode/`+`claude_alias` tool impls | UNIQUE(grok) | **M** | **MISSING(grok)**, low priority (models.dev provider plan makes this less urgent) |
| **Hosted/server-side tools** | web_search crate | `hosted_tools` ANDed with `supports_backend_search` | COMMON | **M**, all tools local | **MISSING (merge once)**, lower priority |

---

## 4. Superset absorption plan (mapped to HorizonCode files)

Ordered by value ÷ effort. Each item names the exact HorizonCode file(s) to change and whether `contracts.ts` (LAW) is touched. "Merge once" = a COMMON capability both repos supply; take the stronger half from each.

### Tier 1, cheap, local, high value (no contract change or one additive field)

1. **Unicode-fold rung in the edit ladder.** Add `seek_sequence.rs`'s typographic-dash/smart-quote/odd-space → ASCII normalisation as a final rung in `app/src/tools/edit.ts` (after `line-patch`, before failure), so an ASCII-authored edit applies to smart-quoted source. Pure local change; extend `EDIT_LADDER` and the byte-stable error strings. Source: codex [`apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/seek_sequence.rs) `normalise()`.

2. **Per-model instruction templates, fail-soft.** `app/src/core/instructions.ts` + the provider layer: resolve a per-model/family instruction override from model metadata, default to the base prompt, log a notice on miss (never crash). Source: codex `prompts/src/model_instructions.rs::render_model_instructions`. No contract change.

3. **Bash command splitting + per-segment risk.** New `app/src/core/bash-split.ts` (tree-sitter-bash or a quote-aware tokenizer) feeding `shell.ts`'s guard so a compound `a && b | c` is split and each segment produces its own `GuardAction{kind:"shell.exec"}`, instead of one `ask` over the whole string. Fail-closed on parse failure / `export`/wrappers. Source: grok `bash_command_splitting.rs` + `exec_risk.rs`. Touches `loop.ts` `admissionFor` only if segments need separate admission; no `contracts.ts` change (still `shell.exec`).

4. **Tool exposure field + deferred discovery.** Add an optional `exposure?: "direct" | "deferred" | "hidden"` to the `Tool` interface in `app/src/contracts.ts` (additive, like `concurrencyClass`), a `tool_search` tool, and gating in `app/src/tools/index.ts` + `loop.ts` tool-spec assembly, so rarely-used/MCP tools cost no prompt budget until discovered. Source: codex `ToolExposure` ([`tools/src/tool_executor.rs:51`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tools/src/tool_executor.rs#L51)). **contracts.ts addition.**

5. **Repeat-tool / stale-anchor advisory already covered by NF-075 curator**; fold grok's `repeat-tool-reminder` idea as an advisory guard if not already present (check `core/loop.ts`). Low risk.

### Tier 2, next capability wave (the big safety gaps; align with NF-016)

6. **The egress authority seam (merge once).** New `app/src/core/egress/decider.ts` implementing grok's `Decider` contract: `decide(origin, call) → allow | deny | ask | observe` with proxy-wide + per-call **hold budgets** (16 / 8), a `DEFAULT_HOLD_TIMEOUT` of 600s, **observe mode** (`WouldBe`), and content-free `BlockedRequest` records on the runtime event stream. Add `net.fetch`/egress wiring in `kernel/src/guard.rs` (egress is already a `GuardKind` = `net.fetch`) so the kernel is the authority and the proxy is the enforcement. This satisfies doc 11 N1–N10 (`egress MUST default to deny`, decided by `(scheme,host,port)`). Sources: grok `egress-proxy/decider.rs` (authority), codex `network-proxy/` (routed enforcement with secret-substitution/MITM). **contracts.ts: add an egress decision shape + a `net.fetch`-scoped lease/grant note; `DEFAULT_POLICY` already has `net.fetch` = ask.**

7. **execpolicy-style compiled command allowlist with a sorted fingerprint (merge once).** Extend `kernel/src/guard.rs` with a durable, file-locked allowlist alongside the existing in-memory leases: `PrefixRule`/`NetworkRule` with Unicode-caseless matching, order-independent `fingerprint()` equality, and a `preserves_managed_requirements` check for any workspace-layer overlay (enforces doc 11 C2 "a workspace layer MUST NOT widen the allow-list"). Grow it at runtime via an `amend`-style file-locked append (codex `amend.rs`). This is the data-driven allowlist `DEFAULT_POLICY` in `contracts.ts` only gestures at. Sources: codex `execpolicy/src/{policy,rule,amend}.rs`; grok `permission-rules` for the per-segment front end (item 3). **contracts.ts + kernel/src/guard.rs + canon.rs** (fingerprint is a canonical-JSON digest, reuse `canonical_json`).

8. **OS sandbox reduced form for `shell`/`code_mode` (NF-016).** Per `docs/28` ruling 38, build the portable `seccomp + no_new_privs + rlimits + netns` child confinement first, typed `best_effort` with named residuals; Landlock stays probe-gated (`ops/landlock-probe.sh`). Directly port codex [`linux-sandbox/src/seccomp.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/linux-sandbox/src/seccomp.rs) (the 3 network modes, io_uring + AF_VSOCK denial, thread-scoped application) as the netns+seccomp layer, and codex `bwrap.rs`/`bundled_bwrap.rs` (digest-verified) where bubblewrap exists. Wire it into `app/src/tools/shell.ts` `spawnOwned` and `app/src/tools/codemode.ts`/`codemode-child.ts`, and make `kernel/src/guard.rs` refuse a profile that cannot enforce a required dimension *before* issuing a lease (doc 11 G10). Source: codex `linux-sandbox/`, [`core/src/safety.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/safety.rs) (the hardlink-out-of-writable-root rationale). **No contract change** (enforcement under the existing guard decisions).

9. **Hashline anchors on read/edit.** New `app/src/tools/anchor.ts` implementing grok's three `AnchorScheme`s (default `ChunkFingerprint`), consumed by `read.ts` (emit anchors) and `edit.ts` (validate + `find_shifted` ±15 before falling to the fuzzy ladder; reject truncated anchors as stale). Address-level staleness complements the NF-069 ladder rather than replacing it. Source: grok [`grok_build_hashline/scheme.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs). **No contract change** (an anchor is tool output text).

10. **Server mode + rollout recovery.** A long-lived leader process (TUI/ACP/MCP clients attach) using `kernel/src/eventlog.rs` as the rollout for crash recovery; implement the ACP surface already specified in `docs/14` S89–S91 over the existing NDJSON `KernelRequestMap` in `contracts.ts`. Source: codex `app-server*` + `rollout.rs` + `daemon_recovery.rs`. **contracts.ts: extend the protocol with session/attach + rollout-read methods (additive to `KernelRequestMap`).**

### Tier 3, richer, optional

11. **Interactive PTY exec** (`exec_command`+`write_stdin` with sandbox-deny auto-retry) evolving `shell.ts` into a session-managed pair, pairs with item 8. Source: codex `unified_exec/`.
12. **Turn diff tracker**, aggregate per-turn edits into one `TurnDiffEvent` on the runtime stream (`loop.ts` + TUI), independent of per-tool output and the per-edit `change-journal.ts`. Source: codex `turn_diff_tracker.rs`.
13. **Per-action guardian classifier**, an optional pre-dispatch review of proposed actions vs instructions, extending `core/review.ts`; adopt codex's bounded `request_budget`/`input_budget` so the classifier can't blow context. Source: codex `core/src/guardian/`.
14. **Memory retrieval/consolidation engine**, if NF-075 grows beyond the append-only curator, grok's `xai-grok-memory` (BM25 + embeddings + MMR + dream consolidation, read-before-write, protected manifest) is the working reference. Source: grok `xai-grok-memory/{search,mmr,v2_consolidation,batch_dream*}.rs`.
15. **Hosted/server-side tools**, a `hosted?: boolean` tool flag ANDed with a per-model capability, lower priority. Source: grok [`xai-grok-agent/src/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/agent.rs) `hosted_tools`.
16. **Multi-dialect tool aliases**, lowest priority given the models.dev provider plan; grok's `codex/`+`opencode/` tool impls show the pattern if ever needed.

### What NOT to copy (deliberate refusals, consistent with `docs/30` §4)

- grok's 25-platform adapter sprawl and the full `crates/codegen/` generated layer, take the contracts (Decider, AnchorScheme, permission-rules), not the generation machinery.
- codex's Windows sandbox (`windows-sandbox-rs`) and Bazel build, out of scope for a Bun/Rust-kernel project; Linux reduced form first.
- grok's hosted-tool server-side execution as a default, it moves a tool outside the kernel guard; keep it opt-in and clearly out-of-boundary.

---

## 5. Cross-check against the prior reports (strict delta)

- `research/steal-ohmypi-codex.md` Part 1 said execpolicy had "`PrefixRule`/`NetworkRule` with `amend` and sorted fingerprint." **Confirmed and sharpened**: the fingerprint is now the named `RequirementsExecPolicy::fingerprint()`, equality is `preserves_managed_requirements` (a transport/snapshot check with basename-shadowing and network allow-overrides-deny cases), and `amend.rs` uses advisory file locking + line-dedup. `seek_sequence.rs`'s Unicode-fold rung confirmed verbatim (the exact dash/quote/space code points).
- `research/steal-grok-claude-deepseek.md` Part 2 described the egress decider and hashline schemes. **Confirmed in full source**, adding: the per-call `HoldBudget` keyed by `CommandTag`, the `503 overloaded` path *before* a card is raised, `DenySource::{DenyRow, WebFetchDenylist}`, the EOF-as-`Abandoned` and drain-as-deny semantics, and the `MAX_HELD_CLIENT_BYTES = 64 KiB`. Hashline: truncated-anchor-rejection and the `find_shifted` local-hash prefilter confirmed by test.
- New this pass (not in prior reports): codex **`ToolExposure`** 6-variant enum + `tool_search`, the **guardian** as a full subsystem with its own input/request budgets, grok **permission-rules** tree-sitter bash splitting with the deliberate `export`/`declaration_command` exclusion and `spans_whole_script` guard, and grok **hosted_tools ANDed with `supports_backend_search`**.

## 6. One-line summary

codex and grok are, respectively, the reference implementations for **OS-level enforcement** (seccomp/bwrap, compiled command allowlist, routed egress proxy, server mode) and for **network/edit authority primitives** (per-origin egress decider with observe mode, hashline freshness anchors, tree-sitter per-segment command risk). HorizonCode already leads on the **audit chain** (canonical hashed event log + receipts + one-use leases/grants + structural state-dir protection in `kernel/src/guard.rs` + `canon.rs`) but its guard is authority-only: every MISSING row above is an *enforcement* gap the two Rust agents already close, and the superset plan in §4 maps each to a specific kernel/app file with the two `contracts.ts` additions (tool `exposure`, egress decision shape + protocol attach) called out explicitly.
