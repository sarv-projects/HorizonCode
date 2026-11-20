# Goal progress — HorizonCode prototype honesty

> **Overall goal: NOT COMPLETE** (2026-11-20). Working tree through ruling **734**; `bash ops/gates.sh` **8/8** re-verified 2026-11-19 after **648**; the prototype trust spine and P0 done bars remain open. Gates-green ≠ release.
>
> **Next agent:** [`../AGENTS.md`](../AGENTS.md) → [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md). **LICENSE deferred** — [`LICENSE-STATUS.md`](LICENSE-STATUS.md).
>
> Authoritative levels: `docs/28-implementation-status.md` §3 (through ruling **734**). Wave matrix: `docs/MASTER-BACKLOG-ALL.md`. Build/run: `docs/33-handoff.md`. Critique verification: [`audit/architecture-critique-verification-2026-11-19.md`](audit/architecture-critique-verification-2026-11-19.md).
>
> **Stop-of-day inventory:** [`STOP-OF-DAY-2026-11-20.md`](STOP-OF-DAY-2026-11-20.md).
>
> **Release blockers (honest):** see [§ Release blockers](#release-blockers-honest--not-a-roadmap) below. Do not treat §7 partial steal rows as the release bar — P0-1…4 are.

## Rulings 538–669 slice (2026-11-18/19) — still NOT COMPLETE

- **538:** Under-admission Guard (durable todos / handoff merge / MEMORY.md); C-9 `HZ_RESPONSES_STEER=1` OpenAI wrap; EffectHost spine → `HZ_EFFECT_RECONCILE_BLOCK=resource`; docs honesty §0/00-index/09-tools/CI 90m.
- **539:** Reduced kernel `fs.batch` (exact multi-file `fs.write` under OwnerLog) for multi-file exact apply_patch; rename later under **630**; fuzz/delete still refuse; rollback under **627**.
- **540:** `createRuntime` prefers `HZ_EFFECT_HOST_KERNEL=require` on Linux when trusted Rust kernel is active and env unset (over sandbox `=default`); explicit env/config preserved; doctor honesty without projecting require.
- **541:** C-11 `HZ_THINKING_CALIBRATED=1` wired into `resolveThinkingEffort` → `auto-calibrated` (still ≤ auto ceiling); empirical fit still OPEN.
- **542–549:** streamEvidence + B-4 breakpoints default; I-7 schema/aliases; H-7 doctor metric contracts; batch `fs.edit` ops; `handoff_create` under-admission.
- **550:** TS OwnerLog proof settled shell → `streamChecked` (not `unsupportedEffects`); release `kernel.sha256` refreshed.
- **551:** C-11 `calibrationFeaturesFromMessages` wired on product resolve path (session tool outcomes).
- **552:** apply_patch single exact Update → batch `fs.edit`; LocalKernel batch write/edit parity.
- **553:** multi-hunk Update → ordered batch `fs.edit` with sequential same-path staging.
- **554:** `memory_remember` / `memory_forget` Guard on bank DB (under-admission).
- **555:** H-7 grow `--list` / `--from-postmortems` summary metric contracts.
- **556:** H-7 `effect reconcile` observe summary metric contracts.
- **557:** H-7 grow `--dream` plan/consolidation metric contracts.
- **558:** H-7 grow `--apply` outcome metric contracts.
- **559:** H-7 `effect reconcile --probe` summary metric contracts.
- **560:** under-admission grow `--dream` Guard before plan/dream.md write.
- **561:** under-admission grow `--from-postmortems` Guard before curator store/archive write.
- **562:** under-admission loop post-mortem Guard before `recordPostmortem` write.
- **563:** §8 #6 multi-resource permission projector (`foldPermissionEffects` deny>ask>allow + `ApprovalRequest.resources`).
- **564:** under-admission `repo_map` Guard before durable cache `index.json` write.
- **565:** under-admission `repo_map` cochange cache Guard (`persistCache:false` on deny/ask).
- **566:** C-10 honesty close — nine guard prompts pinned; steal-list C-10 **done**.
- **567:** apply_patch multi-file loop admission (`also` + multi-resource fold).
- **568:** H-7 SWE-bench submit prediction/harness metric contracts.
- **569:** under-admission `session export` Guard before `.hzs` write.
- **570:** H-7 session export message/checkpoint/event metric contracts.
- **571:** under-admission `/unknown export` Guard before evidence JSON write.
- **572:** under-admission TUI `/export` Guard before json/html/.hzs write.
- **573:** under-admission `Runtime.setGoal` Guard before goals JSON write.
- **574:** H-7 TUI `/export` + `/unknown export` metric contracts.
- **575:** under-admission Markdown transcript Guard before continuous write.
- **576:** under-admission models catalog cache `fs.write` Guard.
- **577:** §8 #6 single human decision for multi-resource ask (leases still OPEN).
- **578:** H-7 batch selection/status/dry-run metric contracts.
- **579:** under-admission eval `--preds-out` Guard before preds.json write.
- **580:** under-admission eval `--metrics-out` + `--write-approval` Guard before write.
- **581:** under-admission batch `--write-config` Guard before runner-config write.
- **582:** under-admission eval ratchet decision-log Guard before append.
- **583:** under-admission spend ledger Guard before durable `spend.json` write.
- **584:** under-admission tool-output spill / blob CAS Guard before materialise.
- **585:** under-admission saved-allows SQL/JSON Guard before persist.
- **586:** under-admission aborted composer draft Guard before persist.
- **587:** under-admission onboarding seen-once marker Guard before persist.
- **588:** under-admission TUI relaunch handoff Guard before persist.
- **589:** under-admission review-fork detached job file Guard before persist.
- **590:** H-7 session list row/limit metric contracts.
- **591:** H-7 session verify ok/open-unknown/mismatch metric contracts.
- **592:** H-7 receipt show found/chain-ok metric contracts.
- **593:** under-admission workspace trust.json Guard before persist.
- **594:** under-admission user config theme/notify Guard before persist.
- **595:** H-7 config check unknown/rejected/exists metric contracts.
- **596:** under-admission OAuth refresh.gen Guard before bump.
- **597:** under-admission OAuth credentials.db Guard before SQLite upsert.
- **598:** H-7 `hzcode models refresh` provider/unchanged metric contracts.
- **599:** under-admission durable-todo-branch.json + auto-merge Guard before persist.
- **600:** under-admission analytics.ndjson Guard before append.
- **601:** under-admission readline history Guard before persist.
- **602:** H-7 `--list-models` count metric contracts.
- **603:** under-admission batch job.jsonl upsert Guard before rewrite.
- **604:** under-admission checkpoints.jsonl Guard before turn-boundary append.
- **605:** under-admission undo.jsonl change-journal Guard before append.
- **606:** H-7 `hzcode doctor` check counts emitted on CLI (non-json).
- **607:** under-admission curator proposals/archive Guard before curate.
- **608:** H-7 `hzcode session fork` message-index metric contracts.
- **609:** under-admission undo.jsonl consume-tombstone Guard before append.
- **610:** under-admission benchmark arm job.jsonl Guard before merge/append.
- **611:** under-admission review-fork journal JSONL Guard before append (admit root = stateDir).
- **612:** under-admission HZ_DEBUG_REQUESTS provider dump Guard before append.
- **613:** H-7 `hzcode effect reconcile` metric contracts emitted on CLI (observe + probe).
- **614:** under-admission HZ_DEBUG_REQUESTS dump on Anthropic/Google/Ollama streams.
- **615:** H-7 `hzcode tui relaunch` draft-byte metric contract.
- **616:** H-7 `hzcode keybind check` override/action/error metric contracts.
- **617:** H-7 TUI `/settings` force-evaluates settingsReportPublication.
- **618:** H-7 `--show-repo-map` empty/budget/chars metric contracts.
- **619:** H-7 `--show-prompts` tools/messages/maxTokens/system-chars metric contracts.
- **620:** H-7 grow CLI emits metric contracts (list/from-postmortems/dream/apply).
- **621:** under-admission session `.hzs` archive Guard in archive module (`writeSessionArchiveGuarded`).
- **622:** envelope autonomy aliases (`pilot`/`autonomous`/`unattended`/`regulated`) + ADR-017 topology ratification; critique verification audit.
- **623:** H-31 launch-time `(root, device, inode)` workspace binding on mutating `effect.execute` (partial — Guard digest embed + H-29/H-30 still OPEN).
- **624:** H-4 lease-on-allow — policy/allowlist allow mints one-use lease citations (G1 Ask/Deny-only wire rename still OPEN).
- **625:** H-29 partial — `--socket` / `HZ_KERNEL_SOCKET` Unix NDJSON serve survives stdin EOF (`hzk.pid`/`hzk.socket` lease files); Bun reattach + full supervisor epochs still OPEN.
- **626:** H-29 product wire — `KernelClient` passes `--socket` when `HZ_KERNEL_SOCKET` / `HZ_KERNEL_DETACH=1` (stdio RPC; exit-hook kill + reattach still OPEN).
- **627:** EffectHost `fs.batch` mid-commit rollback (restore/delete prior snapshots on later op failure).
- **628:** H-29 socket RPC + detach orphan survival + client reattach (`kernel-socket.ts`; remint without control secret still refused).
- **629:** H-31 Guard `intentDigest` includes `(root, device, inode)` workspace binding on every check.
- **630:** EffectHost `fs.batch` exact `fs.rename` + TS Move projection; `autonomy=regulated` composes `HZ_EFFECT_HOST_KERNEL=require` when env unset.
- **631:** EffectHost `fs.batch` exact `fs.delete` + TS Delete projection; OwnerLog absent postimage for null digests; fuzzy/Bun ambient/MCP/codemode still OPEN.
- **632:** H-29 `hzk.control` mode-0600 seal restores control remint after detach reattach (human principal still OPEN).
- **633:** doctor EffectHost posture names batch rename/delete coverage + ambient `code_mode`/MCP refuse-under-require honesty.
- **634:** H-30 partial — monotonic `hzk.epoch` + `ping.supervisorEpoch`; Bun refuses epoch mismatch on detach reattach.
- **635:** CB-6 / H-30 partial — exclusive `hzk.supervisor.lock` flock before `--socket` bind; second live owner → `supervisor.lease_held` (Windows / cross-state-dir / binary-upgrade durability still OPEN).
- **636:** H-31 partial — held leases stamp `workspaceBinding`; consume re-stats and burns on remount/rename-swap (file-tool TOCTOU still OPEN).
- **637:** G1 partial — additive `g1:"ask"|"deny"` on Guard decisions (`allow` → `g1:"ask"` + leaseId); frozen `decision:"allow"` retained until protocol V2.
- **638:** CB-6 deepen — supervisor lease flock covers stdio **and** `--socket` (one live hz-kernel per state dir).
- **639:** Engineering Brain pre-flight viability gate (`HZ_ENGINEERING_BRAIN` / autonomy compose); NOT_VIABLE hard-stop.
- **640:** Engineering Brain adversarial critic (harness) on mutations; P0 hard-stop; opt-in cross-model pass **705** (`HZ_ENG_CRITIC_MODEL`); structural call-site impact **727**; tree-sitter AST call-graph still OPEN.
- **641:** Code Mode 2.0 partial — typed stubs with outputSchema + in-run `tools.kv` (skill crystallization / kernel route still OPEN).
- **642:** ACP v2 stdio agent (`hzcode acp`) — initialize + session/* + honest caps + `session/update` chunks (**711**); auth/load/MCP/permission proxy still OPEN.
- **643:** Verification Artifacts + CDP screenshot capture (`hzcode verify-artifact`); opt-in auto-emit **708** (`HZ_VERIFY_ARTIFACT_AUTO_EMIT`); bundled browser + default-on every turn still OPEN.
- **644:** Head-to-head bench scaffold (`hzcode h2h`); live SWE-bench Verified competitor matrix still OPEN.
- **645:** Remediation — compact Code Mode stubs from live schemas (≤1024; edit `old`/`new`); Eng Brain FP soften; H-29 thread-per-conn + sock 0600 + SO_PEERCRED; Unix cfg / unwrap hygiene.
- **696:** H-29 partial — `peer_auth.rs` + `ping.socketPeerAuth`; win32 detach env fail-closed (no peer-proven lease); doctor `kernel.detach.peer`.
- **703:** H-30 / CB-6 partial — `host_supervisor_lease.rs` cross-state-dir `hzk.host.lock` flock + `ping.hostSupervisorLease`; doctor `kernel.supervisor.host`.
- **724:** H-29/H-30 Wave-0 — `os_file_lock.rs` Windows `LockFileEx` + Unix `flock` for host/per-state supervisor lease; doctor detach fail-closed on win32 (socket peer still Unix-only).
- **646:** EffectHost — multi-hunk / multi-file batch accept kernel-unique `EDIT_REPAIR` fuzz (Bun first-hit still Bun-only).
- **647:** CB-6 — `HZ_SUPERVISOR_LEASE=0` test escape for multi-owner flock proofs; socket handle mutex; successor `drop` before restart.
- **648:** ts-suite hermetic EffectHost off + CLI opt-in Ask≡consent for metrics/preds/ratchet; analytics Ask≡consent; H-4 cache identity opt-out; batch concurrency waits.
- **649:** P0-1 — `=require` preflight refuses ambient/shape-ineligible tools before Guard/`tool.pre` hooks (eligible mutations still post-route refuse).
- **650:** P0-1 — `undo` kernel-routes via `fs.write`/`fs.delete` (`skipJournal` + consume tombstone); still ambient under `=default` fallback for other tools.
- **651:** P0-1 — user hooks suppressed (not spawned) under `=require` until kernel-routed.
- **652:** P0-1 — compound/interpreter/metachar shell refused under `=default`/`=1` (no Bun ambient fallback).
- **653:** P0-1 — never-routable tools (preview/agent/code_mode/MCP/…) refused under `=default`/`=1` before Guard.
- **654:** P0-2 — historical overwrite replay: superseded CAS present versions classified in `history.overwriteReplay` / `historicalOverwriteReplayed`.
- **655:** P0-3 — executed-UNKNOWN attested abandon clear-release (`mode=executed_unknown_abandon` + attestation); never auto-settle.
- **656:** P0-4 — product-default CREATE hermetic prove path (`attemptNetnsSpawnProductDefaultConnectEgress`); never shell-net `enforced`.
- **657:** R172 — additive `parentReceiptId` v2 hash binding + mutual-link verify (issuer/attestation still OPEN).
- **688:** R172 — kernel-held `issuerStamp` on nested `parentReceiptId` mint + verify (**456**/**session verify**); full R172 still OPEN.
- **725:** R172 — TS `verifyReceiptChainSync` / `LocalKernel.verifyReceipts` keyed stamp parity + doctor `receipt.issuer` honesty; full R172 still OPEN.
- **658:** Guard derives fs.* scope from workspace binding (caller `scope:"workspace"` cannot widen outside targets).
- **659:** Sensitive-write exact one-use lease clears OwnerLog re-check; wildcard/grant still cannot waive H6.
- **660:** Kernel shell.exec timeout (default 120s) + toolchain PATH under env_clear.
- **661:** Eng critic `evidenceText` wired from mutated-path excerpts (645 reachable).
- **685:** Eng critic lexical symbol-impact on mutated paths (`repo_map` patterns); structural call-sites **727**; tree-sitter AST call-graph still OPEN (cross-model LLM **705**).
- **713:** Exported-symbol lexical adjacency graph (`symbol-graph.ts`, `HZ_SYMBOL_GRAPH=1`, `repo_map` `symbolGraph`); structural refinement on importers via **727**; tree-sitter AST call-graph still OPEN.
- **714:** P0-3 executed-UNKNOWN observe-and-settle for fs.write (partial; not silent auto-settle).
- **722:** P0-3 executed-UNKNOWN observe-and-settle for fs.edit (partial; not silent auto-settle).
- **733:** P0-3 executed-UNKNOWN observe-and-settle for fs.delete (partial; stably absent proof; not silent auto-settle).
- **734:** H-31 Bun file-tool workspace `(device,inode)` capture + effect-time drift refuse (partial).
- **662:** Egress Allow mints one-use lease (H-4 / G1).
- **663:** Mutating memory/handoff/debug exclusive; explore/review/plan/never agent fan-out shared.
- **664:** CDP/artifact/h2h/acp/viability hardening from audit 1.7.
- **708:** Verify-artifact auto-emit on succeeded turn + passing session verify (env opt-in; no auto CDP).
- **710:** H-30/CB-6 detach hzk.binary seal + reattach refuse on upgrade mismatch (partial; native Windows detach socket OPEN — host LockFileEx **724**).
- **711:** ACP v2 honest agentCapabilities + session/update prompt streaming (partial; full ACP OPEN).
- **665:** `web_fetch`, `shell_bg`, git_status/diff/log/blame registered; **723** `web_search` env-gated (LLM compact **689** opt-in; ask_user **671**/**726**).
- **666:** P0-1 — user hooks suppressed under EffectHost `=default`/`=1` (not only require).
- **702:** P0-1 — MCP stdio server spawn/reconnect refused under EffectHost-on (invoke + hooks OwnerLog still OPEN).
- **705:** Eng Brain fresh-context cross-model LLM critic (`HZ_ENG_CRITIC_MODEL=1` or model id); fail-closed to harness; structural impact **727** in prompt; tree-sitter AST call-graph still OPEN.
- **706:** P0-2 shell argv side-effect class + likely-net history fail-closed (partial; never shell-net enforced).
- **707:** §7 D-3 non-Linux birth honesty + Darwin reduced lstart (partial).
- **726:** `ask_user` structured options + TUI/runtime handler wire (**671** tool; multi-select/timeout/editor elicitation OPEN).

## Rulings 538–669 slice (2026-11-18/19) — still NOT COMPLETE

- **538:** Under-admission Guard (durable todos / handoff merge / MEMORY.md); C-9 `HZ_RESPONSES_STEER=1` OpenAI wrap; EffectHost spine → `HZ_EFFECT_RECONCILE_BLOCK=resource`; docs honesty §0/00-index/09-tools/CI 90m.
- **539:** Reduced kernel `fs.batch` (exact multi-file `fs.write` under OwnerLog) for multi-file exact apply_patch; rename later under **630**; fuzz/delete still refuse; rollback under **627**.
- **540:** `createRuntime` prefers `HZ_EFFECT_HOST_KERNEL=require` on Linux when trusted Rust kernel is active and env unset (over sandbox `=default`); explicit env/config preserved; doctor honesty without projecting require.
- **541:** C-11 `HZ_THINKING_CALIBRATED=1` wired into `resolveThinkingEffort` → `auto-calibrated` (still ≤ auto ceiling); empirical fit still OPEN.
- **542–549:** streamEvidence + B-4 breakpoints default; I-7 schema/aliases; H-7 doctor metric contracts; batch `fs.edit` ops; `handoff_create` under-admission.
- **550:** TS OwnerLog proof settled shell → `streamChecked` (not `unsupportedEffects`); release `kernel.sha256` refreshed.
- **551:** C-11 `calibrationFeaturesFromMessages` wired on product resolve path (session tool outcomes).
- **552:** apply_patch single exact Update → batch `fs.edit`; LocalKernel batch write/edit parity.
- **553:** multi-hunk Update → ordered batch `fs.edit` with sequential same-path staging.
- **554:** `memory_remember` / `memory_forget` Guard on bank DB (under-admission).
- **555:** H-7 grow `--list` / `--from-postmortems` summary metric contracts.
- **556:** H-7 `effect reconcile` observe summary metric contracts.
- **557:** H-7 grow `--dream` plan/consolidation metric contracts.
- **558:** H-7 grow `--apply` outcome metric contracts.
- **559:** H-7 `effect reconcile --probe` summary metric contracts.
- **560:** under-admission grow `--dream` Guard before plan/dream.md write.
- **561:** under-admission grow `--from-postmortems` Guard before curator store/archive write.
- **562:** under-admission loop post-mortem Guard before `recordPostmortem` write.
- **563:** §8 #6 multi-resource permission projector (`foldPermissionEffects` deny>ask>allow + `ApprovalRequest.resources`).
- **564:** under-admission `repo_map` Guard before durable cache `index.json` write.
- **565:** under-admission `repo_map` cochange cache Guard (`persistCache:false` on deny/ask).
- **566:** C-10 honesty close — nine guard prompts pinned; steal-list C-10 **done**.
- **567:** apply_patch multi-file loop admission (`also` + multi-resource fold).
- **568:** H-7 SWE-bench submit prediction/harness metric contracts.
- **569:** under-admission `session export` Guard before `.hzs` write.
- **570:** H-7 session export message/checkpoint/event metric contracts.
- **571:** under-admission `/unknown export` Guard before evidence JSON write.
- **572:** under-admission TUI `/export` Guard before json/html/.hzs write.
- **573:** under-admission `Runtime.setGoal` Guard before goals JSON write.
- **574:** H-7 TUI `/export` + `/unknown export` metric contracts.
- **575:** under-admission Markdown transcript Guard before continuous write.
- **576:** under-admission models catalog cache `fs.write` Guard.
- **577:** §8 #6 single human decision for multi-resource ask (leases still OPEN).
- **578:** H-7 batch selection/status/dry-run metric contracts.
- **579:** under-admission eval `--preds-out` Guard before preds.json write.
- **580:** under-admission eval `--metrics-out` + `--write-approval` Guard before write.
- **581:** under-admission batch `--write-config` Guard before runner-config write.
- **582:** under-admission eval ratchet decision-log Guard before append.
- **583:** under-admission spend ledger Guard before durable `spend.json` write.
- **584:** under-admission tool-output spill / blob CAS Guard before materialise.
- **585:** under-admission saved-allows SQL/JSON Guard before persist.
- **586:** under-admission aborted composer draft Guard before persist.
- **587:** under-admission onboarding seen-once marker Guard before persist.
- **588:** under-admission TUI relaunch handoff Guard before persist.
- **589:** under-admission review-fork detached job file Guard before persist.
- **590:** H-7 session list row/limit metric contracts.
- **591:** H-7 session verify ok/open-unknown/mismatch metric contracts.
- **592:** H-7 receipt show found/chain-ok metric contracts.
- **593:** under-admission workspace trust.json Guard before persist.
- **594:** under-admission user config theme/notify Guard before persist.
- **595:** H-7 config check unknown/rejected/exists metric contracts.
- **596:** under-admission OAuth refresh.gen Guard before bump.
- **597:** under-admission OAuth credentials.db Guard before SQLite upsert.
- **598:** H-7 `hzcode models refresh` provider/unchanged metric contracts.
- **599:** under-admission durable-todo-branch.json + auto-merge Guard before persist.
- **600:** under-admission analytics.ndjson Guard before append.
- **601:** under-admission readline history Guard before persist.
- **602:** H-7 `--list-models` count metric contracts.
- **603:** under-admission batch job.jsonl upsert Guard before rewrite.
- **604:** under-admission checkpoints.jsonl Guard before turn-boundary append.
- **605:** under-admission undo.jsonl change-journal Guard before append.
- **606:** H-7 `hzcode doctor` check counts emitted on CLI (non-json).
- **607:** under-admission curator proposals/archive Guard before curate.
- **608:** H-7 `hzcode session fork` message-index metric contracts.
- **609:** under-admission undo.jsonl consume-tombstone Guard before append.
- **610:** under-admission benchmark arm job.jsonl Guard before merge/append.
- **611:** under-admission review-fork journal JSONL Guard before append (admit root = stateDir).
- **612:** under-admission HZ_DEBUG_REQUESTS provider dump Guard before append.
- **613:** H-7 `hzcode effect reconcile` metric contracts emitted on CLI (observe + probe).
- **614:** under-admission HZ_DEBUG_REQUESTS dump on Anthropic/Google/Ollama streams.
- **615:** H-7 `hzcode tui relaunch` draft-byte metric contract.
- **616:** H-7 `hzcode keybind check` override/action/error metric contracts.
- **617:** H-7 TUI `/settings` force-evaluates settingsReportPublication.
- **618:** H-7 `--show-repo-map` empty/budget/chars metric contracts.
- **619:** H-7 `--show-prompts` tools/messages/maxTokens/system-chars metric contracts.
- **620:** H-7 grow CLI emits metric contracts (list/from-postmortems/dream/apply).
- **621:** under-admission session `.hzs` archive Guard in archive module (`writeSessionArchiveGuarded`).
- **622:** envelope autonomy aliases (`pilot`/`autonomous`/`unattended`/`regulated`) + ADR-017 topology ratification; critique verification audit.
- **623:** H-31 launch-time `(root, device, inode)` workspace binding on mutating `effect.execute` (partial — Guard digest embed + H-29/H-30 still OPEN).
- **624:** H-4 lease-on-allow — policy/allowlist allow mints one-use lease citations (G1 Ask/Deny-only wire rename still OPEN).
- **625:** H-29 partial — `--socket` / `HZ_KERNEL_SOCKET` Unix NDJSON serve survives stdin EOF (`hzk.pid`/`hzk.socket` lease files); Bun reattach + full supervisor epochs still OPEN.
- **626:** H-29 product wire — `KernelClient` passes `--socket` when `HZ_KERNEL_SOCKET` / `HZ_KERNEL_DETACH=1` (stdio RPC; exit-hook kill + reattach still OPEN).
- **627:** EffectHost `fs.batch` mid-commit rollback (restore/delete prior snapshots on later op failure).
- **628:** H-29 socket RPC + detach orphan survival + client reattach (`kernel-socket.ts`; remint without control secret still refused).
- **629:** H-31 Guard `intentDigest` includes `(root, device, inode)` workspace binding on every check.
- **630:** EffectHost `fs.batch` exact `fs.rename` + TS Move projection; `autonomy=regulated` composes `HZ_EFFECT_HOST_KERNEL=require` when env unset.
- **631:** EffectHost `fs.batch` exact `fs.delete` + TS Delete projection; OwnerLog absent postimage for null digests; fuzzy/Bun ambient/MCP/codemode still OPEN.
- **632:** H-29 `hzk.control` mode-0600 seal restores control remint after detach reattach (human principal still OPEN).
- **633:** doctor EffectHost posture names batch rename/delete coverage + ambient `code_mode`/MCP refuse-under-require honesty.
- **634:** H-30 partial — monotonic `hzk.epoch` + `ping.supervisorEpoch`; Bun refuses epoch mismatch on detach reattach.
- **635:** CB-6 / H-30 partial — exclusive `hzk.supervisor.lock` flock before `--socket` bind; second live owner → `supervisor.lease_held` (Windows / cross-state-dir / binary-upgrade durability still OPEN).
- **636:** H-31 partial — held leases stamp `workspaceBinding`; consume re-stats and burns on remount/rename-swap (file-tool TOCTOU still OPEN).
- **637:** G1 partial — additive `g1:"ask"|"deny"` on Guard decisions (`allow` → `g1:"ask"` + leaseId); frozen `decision:"allow"` retained until protocol V2.
- **638:** CB-6 deepen — supervisor lease flock covers stdio **and** `--socket` (one live hz-kernel per state dir).
- **639:** Engineering Brain pre-flight viability gate (`HZ_ENGINEERING_BRAIN` / autonomy compose); NOT_VIABLE hard-stop.
- **640:** Engineering Brain adversarial critic (harness) on mutations; P0 hard-stop; opt-in cross-model pass **705** (`HZ_ENG_CRITIC_MODEL`); structural call-site impact **727**; tree-sitter AST call-graph still OPEN.
- **641:** Code Mode 2.0 partial — typed stubs with outputSchema + in-run `tools.kv` (skill crystallization / kernel route still OPEN).
- **642:** ACP v2 stdio agent (`hzcode acp`) — initialize + session/* + honest caps + `session/update` chunks (**711**); auth/load/MCP/permission proxy still OPEN.
- **643:** Verification Artifacts + CDP screenshot capture (`hzcode verify-artifact`); opt-in auto-emit **708** (`HZ_VERIFY_ARTIFACT_AUTO_EMIT`); bundled browser + default-on every turn still OPEN.
- **644:** Head-to-head bench scaffold (`hzcode h2h`); live SWE-bench Verified competitor matrix still OPEN.
- **645:** Remediation — compact Code Mode stubs from live schemas (≤1024; edit `old`/`new`); Eng Brain FP soften; H-29 thread-per-conn + sock 0600 + SO_PEERCRED; Unix cfg / unwrap hygiene.
- **696:** H-29 partial — `peer_auth.rs` + `ping.socketPeerAuth`; win32 detach env fail-closed (no peer-proven lease); doctor `kernel.detach.peer`.
- **703:** H-30 / CB-6 partial — `host_supervisor_lease.rs` cross-state-dir `hzk.host.lock` flock + `ping.hostSupervisorLease`; doctor `kernel.supervisor.host`.
- **724:** H-29/H-30 Wave-0 — `os_file_lock.rs` Windows `LockFileEx` + Unix `flock` for host/per-state supervisor lease; doctor detach fail-closed on win32 (socket peer still Unix-only).
- **646:** EffectHost — multi-hunk / multi-file batch accept kernel-unique `EDIT_REPAIR` fuzz (Bun first-hit still Bun-only).
- **647:** CB-6 — `HZ_SUPERVISOR_LEASE=0` test escape for multi-owner flock proofs; socket handle mutex; successor `drop` before restart.
- **648:** ts-suite hermetic EffectHost off + CLI opt-in Ask≡consent for metrics/preds/ratchet; analytics Ask≡consent; H-4 cache identity opt-out; batch concurrency waits.
- **649:** P0-1 — `=require` preflight refuses ambient/shape-ineligible tools before Guard/`tool.pre` hooks (eligible mutations still post-route refuse).
- **650:** P0-1 — `undo` kernel-routes via `fs.write`/`fs.delete` (`skipJournal` + consume tombstone); still ambient under `=default` fallback for other tools.
- **651:** P0-1 — user hooks suppressed (not spawned) under `=require` until kernel-routed.
- **652:** P0-1 — compound/interpreter/metachar shell refused under `=default`/`=1` (no Bun ambient fallback).
- **653:** P0-1 — never-routable tools (preview/agent/code_mode/MCP/…) refused under `=default`/`=1` before Guard.
- **654:** P0-2 — historical overwrite replay: superseded CAS present versions classified in `history.overwriteReplay` / `historicalOverwriteReplayed`.
- **655:** P0-3 — executed-UNKNOWN attested abandon clear-release (`mode=executed_unknown_abandon` + attestation); never auto-settle.
- **656:** P0-4 — product-default CREATE hermetic prove path (`attemptNetnsSpawnProductDefaultConnectEgress`); never shell-net `enforced`.
- **657:** R172 — additive `parentReceiptId` v2 hash binding + mutual-link verify (issuer/attestation still OPEN).
- **688:** R172 — kernel-held `issuerStamp` on nested `parentReceiptId` mint + verify (**456**/**session verify**); full R172 still OPEN.
- **725:** R172 — TS `verifyReceiptChainSync` / `LocalKernel.verifyReceipts` keyed stamp parity + doctor `receipt.issuer` honesty; full R172 still OPEN.
- **658:** Guard derives fs.* scope from workspace binding (caller `scope:"workspace"` cannot widen outside targets).
- **659:** Sensitive-write exact one-use lease clears OwnerLog re-check; wildcard/grant still cannot waive H6.
- **660:** Kernel shell.exec timeout (default 120s) + toolchain PATH under env_clear.
- **661:** Eng critic `evidenceText` wired from mutated-path excerpts (645 reachable).
- **685:** Eng critic lexical symbol-impact on mutated paths (`repo_map` patterns); structural call-sites **727**; tree-sitter AST call-graph still OPEN (cross-model LLM **705**).
- **713:** Exported-symbol lexical adjacency graph (`symbol-graph.ts`, `HZ_SYMBOL_GRAPH=1`, `repo_map` `symbolGraph`); structural refinement on importers via **727**; tree-sitter AST call-graph still OPEN.
- **662:** Egress Allow mints one-use lease (H-4 / G1).
- **663:** Mutating memory/handoff/debug exclusive; explore/review/plan/never agent fan-out shared.
- **664:** CDP/artifact/h2h/acp/viability hardening from audit 1.7.
- **708:** Verify-artifact auto-emit on succeeded turn + passing session verify (env opt-in; no auto CDP).
- **665:** `web_fetch`, `shell_bg`, git read tools (vision **676**, web_search **723**, ask_user **671**/**726**, token window **668**).
- **723:** `web_search` env-gated backends (`HZ_WEB_SEARCH=1`, URL template, Brave API) + doctor `tools.web_search`; kernel `net.fetch`; never shell-net enforced.
- **666–667:** P0-1 hooks suppress + shape-ineligible refuse under EffectHost-on.
- **702:** P0-1 MCP stdio spawn/reconnect refused under EffectHost-on.
- **705:** Eng Brain fresh-context cross-model LLM critic (`HZ_ENG_CRITIC_MODEL=1`); AST call-graph still OPEN.
- **668:** Token-aware history window (LLM semantic compact **689** opt-in; post-compaction token-fit **729**).
- **729:** Token-fit compaction + `/context` honesty (`historyLimit`, `defaultHistoryLimit`, `tokenFitCompaction`, `llmCompactionActive`).
- **730:** Speculation prep-discard honesty + doctor (partial; default-off).
- **731:** Multimodal product path + tool-result wire + vision doctor (partial).
- **732:** Kernel shell.exec require-wrap + doctor honesty (partial; never shell-net enforced).
- **669:** P0-2 reduced shell FS postimage (`rm -f`/`touch`/`mkdir -p`).
- **686:** P0-2 reduced shell FS postimage `cp`/`mv` single-path (+ optional `-f`/`-n`); absence facts in history `checked`.
- **698:** P0-2 nested childEffectIds OwnerLog observe on postimage verify (partial; extends **693**).
- **670–671:** Speculation opt-in wire; `ask_user` tool (**726:** structured options + TUI/runtime handler wire). **730:** speculation prep-discard + doctor honesty.
- **672:** P0-4 product netns default-on when capable (never `enforced`).
- **715:** P0-4 WSL/CAP/userns gap honesty — doctor `egress.netns.capability`, named `reason=`, runtime gap notice (never `enforced`).
- **716:** G1 doctor/startup honesty for protocol V2 opt-in (partial; default-on V2 OPEN).
- **719:** G1 trusted product default-on `HZ_GUARD_G1_WIRE=1` when env unset (partial; frozen allow + raw mint + human principal OPEN).
- **673:** P0-3 Bun R170 mutation fence (partial).
- **674:** H-31 fd re-verify in workspace (partial).
- **675:** Kernel shell.exec via hz-sandbox-exec (partial; never shell-net enforced).
- **732:** Kernel shell.exec require-wrap (`HZ_SANDBOX_REQUIRE`/`HZ_SHELL_EXEC_REQUIRE_WRAP`) + doctor `kernel.shell.exec` (partial; never shell-net enforced).
- **676–681:** Vision ChatMsg (**731** product sendMultimodal + tool-result wire + `provider.vision` doctor); **723** web_search env-gated backends + doctor; autonomy envelopes; Code Mode persistent kv + readonly extras; G1 wire opt-in; best_of_n.
- **701:** Best-of-N parallel worktree racing (`HZ_BEST_OF_N` + `HZ_BEST_OF_N_PARALLEL`; doctor `harness.best_of_n`; fail-closed default).
- **728:** Best-of-N live worktree provision + delegate-in-slot + loser `git worktree remove` (extends **701**; residual kernel leases / chooser penalty).
- **682:** Human approval principal reduced stamp (`principal:"human"` / `human:<sessionId>`).
- **712:** Human approval principal doctor honesty (`guard.human.principal`; refuses `HZ_HUMAN_CRYPTO_PRINCIPAL` without verifier).
- **717:** Human approval principal strict product mint gate (`HZ_HUMAN_PRINCIPAL_STRICT=1`; Bun layer only).
- **720:** Kernel fd-3 parent stamp `principal:"parent"` + strict refuses non-human parent mint at Rust boundary.
- **721:** P0-1 mutating `mcp.invoke` fail-closed under EffectHost-on (OwnerLog route OPEN; read-only MCP ambient under `=default`/`=1` only).
- **683:** P0-3 MCP R170 reconcile-barrier (partial).
- **684:** Atomic multi-resource sibling lease mint (all-or-nothing).
- **685:** Eng Brain lexical symbol impact for critic.
- **727:** Eng Brain structural call-site impact for critic (`structural-call-impact.ts`).
- **687:** P0-1 first-hit tied-equal kernel + mixed-score refuse under require.
- **686:** P0-2 shell FS postimage `cp`/`mv` slice.
- **687:** P0-1 first-hit tied-equal kernel + mixed refuse under require.
- **689:** LLM semantic compaction opt-in (`HZ_LLM_COMPACTION=1`; fail-closed).
- **690:** P0-3 SQLite mutator R170 fail-closed gate.
- **691:** P0-3 preTool hooks R170 reconcile-barrier (partial).
- **718:** P0-3 observation hooks (`postTool`/turn lifecycle) R170 reconcile-barrier (partial).
- **692:** §7 B-4 cache-hit probe doctor + hermetic parse/compare.
- **693:** P0-2 nested effect observe on postimage verify (partial).
- **694:** §7 C-11 opt-in live difficulty judge (`HZ_THINKING_LIVE_JUDGE=1`; empirical fit still OPEN).
- **695:** P0-3 resource-latch `(device,inode)` hardlink overlap + fail-closed lstat under `=resource` (partial).
- **699:** P0-3 dangling-symlink `resolveSymlinkChain` overlap + named fail-closed when final link target absent (partial; full alias-race TOCTOU still OPEN).
- **700:** P0-2 independent absent-path classify + signed historical absence fact replay (partial; no byte reconstruction).
- **696:** H-29 Windows detach peer-lease honesty (partial).
- **697:** §7 C-9 Responses steer doctor + hermetic wire self-check (`provider.responses.steer`; live GPT-6 still OPEN).
- **704:** §7 C-12 macOS reduced `ps` ancestor walk + Windows fail-closed honesty + doctor `owner_worker.ancestor` (full R170 / live D-6 over pipe still OPEN).
- **P0-1…4 done bars still OPEN.** Never shell-net `enforced`. LICENSE deferred.

## Release blockers (honest — not a roadmap)

Gates **8/8** prove the repository CI contract. They do **not** prove a shippable trust product. Until the items below close (or the owner explicitly lowers the bar), do **not** call the tree RELEASED.

### Hard P0 spine (done bars unmet — FULL-BACKLOG §A / §Z)

| # | Blocker | What “done” still requires | Partial today |
|---:|---|---|---|
| **P0-1** | Universal EffectHost | Kernel owns **or refuses** every mutation path (write/edit/shell/apply_patch/ast_edit **and** ambient Bun: MCP, hooks, undo, preview, agent, code_mode); no silent Bun fallback under honesty gate | Reduced `fs.batch` + `EDIT_REPAIR` (**539**–**646**); `=require` auto on trusted Linux (**540**); **649**–**653**/**702**/**721** require preflight + undo route + hooks suppress + compound shell refuse + never-routable + MCP spawn refuse + mutating `mcp.invoke` fail-closed under EffectHost-on; hooks OwnerLog OPEN; read-only MCP ambient under `=default`/`=1` only; first-hit mixed-score refuse under require (**687**); tied-equal kernel route; shape-ineligible write/edit still Bun under non-require |
| **P0-2** | Full postimage / Rust observe | Rust observes **every** effect class; complete historical replay (not only latest file postimage / shell streamEvidence) | Latest-file replay (**350**); CAS superseded (**356**); shell stdout/stderr streamChecked (**542**); **654** superseded CAS overwrite replay; **669**/**686** named shell argv FS postimages (`rm -f`/`touch`/`mkdir -p`/`cp`/`mv` reduced argv only); **698** bounded nested `childEffectIds` OwnerLog observe on postimage verify; **700** independent absence classify + signed absence-fact replay (partial); **709** named `legacyClassify` for rows without digest/CAS/stream (partial); arbitrary shell FS/net + deleted-byte reconstruction + deep universal nested observe still OPEN |
| **P0-3** | Full R170 | Kernel-owned mandatory cross-process barrier for Bun/SQLite/MCP/hooks; UNKNOWN recovery that is not prepare-only | TS latch + reduced `=resource` spine (**344**/**538**); OwnerLog flock for **direct** kernel effects (**348**+); prepare-only recover (**349**); **655** attested abandon; **714** fs.write + **722** fs.edit + **733** fs.delete observe-settle (partial); **673** Bun mutation fence (partial); **683** MCP + **690** SQLite mutator fail-closed (partial); **691** preTool + **718** observation hooks reconcile-barrier (partial); **695** hardlink `(dev,ino)` overlap + lstat fail-closed (partial); **699** dangling-symlink overlap fail-closed + named honesty (partial); full alias-race TOCTOU + hooks kernel OwnerLog / session lifecycle still OPEN |
| **P0-4** | Product routed egress | Product netns path that confines child egress without ever advertising shell-net **`enforced`** | Decider + probes + optional CONNECT (**315**–**341**, **533**); **656** CREATE prove; **672** default-on when capable; **715** WSL/CAP/userns gap honesty; never `enforced` |

### Wave-0 / trust residuals that still block a “strict” release

| Area | Still open |
|---|---|
| **R172** | Authenticated receipt issuer; keyed cross-process attestation (nested replay **456**/**478**; **657** `parentReceiptId`; **688** kernel `issuerStamp`; **725** TS chain/doctor keyed verify — human issuer + full attestation still OPEN) |
| **G1** | **719** trusted product default-on V2 projection (`HZ_GUARD_G1_WIRE=1` when unset; `=0` legacy); **637** additive `g1`; **716** doctor honesty; frozen `contracts.ts` `allow` + raw lease/grant + human principal still OPEN |
| **Human approval principal** | **720** fd-3 mints stamp `principal:"parent"`; **717**/**720** `HZ_HUMAN_PRINCIPAL_STRICT=1` refuses Bun + kernel raw mint without `principal:"human"`; doctor **712** names fd-3 (**352**) ≠ human; cryptographic human identity + policy-allow internal mint stamps remain OPEN |
| **H-29 / H-30 / CB-6** | Detach/socket/epoch/lease/host flock + **710** `hzk.binary` reattach seal + **724** Windows `LockFileEx` (**625**–**638**/**647**/**703**/**710**/**724**); Windows peer honesty (**696**); Windows `--socket`/SO_PEERCRED detach still OPEN |
| **H-31** | Workspace `(dev,ino)` bind + digest + held-lease remount + Bun capture/drift (**623**/**629**/**636**/**674**/**734**); intermediate-component TOCTOU still OPEN |
| **Speculation** | Opt-in wired (**670**) + prep-discard/doctor (**730**); default-off; segment/hook residuals OPEN |
| **LICENSE** | No root `LICENSE` — deferred ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)); distribution terms unset |

### Product / steal residuals (do not confuse with P0, but they block feature-complete release)

Partial §7 rows still carrying live residuals (FULL-BACKLOG §C): **B-4** live cache-hit measure; **C-7/C-9** live GPT-6 Responses session (doctor `provider.responses.steer` hermetic only — **697**); **C-11** empirical corpus calibration; **C-12** Windows parent-walk prove + full R170 / live D-6 over pipe (**704** — macOS reduced `ps` walk; Windows fail-closed); **C-13** kernel-owned R170 (not SQLite fence alone); **D-3** monotonic sleep-wake re-anchor + Windows births (**707** shipped non-Linux honesty + Darwin reduced lstart); **F-4/G-1/H-2/I-2** live invoice / billing truth; **G-9** full if-bench corpus; **H-7** misc CLI metric contracts; **J-1/J-3/J-4** official harness credentials + OS-enforced proxy + live omp metaharness. Plus Eng Brain tree-sitter AST call-graph (**640**/**685** residual beyond **727**), Code Mode kernel route (**641**), full ACP (**642**), verify-artifact bundled browser / default-on every turn (**643**), live H2H SWE-bench matrix (**644**).

### Process / ops (release hygiene, not P0 spine)

| Item | Note |
|---|---|
| Working tree vs `origin/main` | Stop-of-day **2026-11-20** commits rulings **538–734** to `main` ([`STOP-OF-DAY-2026-11-20.md`](STOP-OF-DAY-2026-11-20.md)); re-verify gates after push |
| docs/24 §3.5 catalogue | 18 rows remain `declared-gap` in `ops/gate-catalogue.md` — runner never pretends they run |
| NOTICE / provenance | Release-grade NOTICE rows keyed to full Provenance tables still OPEN (`33-handoff` §6) |
| Never claim | Shell-net egress **`enforced`** |

## Wave summary (honest)

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **0** | Honesty + spine precursors | **PARTIAL — TESTED** (rulings **174b**, **224**, **235**, **243**, **251**, **256**, **257**, **260**, **261**, **264**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **289**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **305**, **306**, **307**, **308**, **309**, **310**, **311**, **312**, **313**, **314**, **315**, **316**, **317**, **318**, **319**, **320**, **322**, **324**, **325**, **326**, **327**, **328**, **329**, **330**, **331**, **332**, **333**, **334**, **335**, **336**, **337**, **338**, **339**, **340**, **341**, **342**, **343**, **344**, **345**) | RC-18 event map (**454**; `event-catalogue.test.ts`): **50** shipped types; **44/44** canonical mapped; **32** literal `hz.*`; **0** unmapped, JSONL fsync + kernel/TS parent-dir parity (**251**), receipt postimage + independent double-read stability (**256** TS + **279** kernel execute) + observe evidence gate (**257**), kernel `effect.reconcile` evidence flags (**260**) + live loop/attach wire (**261**), `session-kernel-reconcile` + effectId pairing + live turn/batch notice, durable `effects.jsonl` + attach reconcile + `hz.effect.reconciled`, TUI UNKNOWN chip + `/unknown` inspect/reconcile/export (**235**, **264**, **282**), R172 structured receipt panes + fullscreen inspect overlay (**284** reduced), kernel `effect.execute` stub + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` under caller `sandboxRoot` (**243**, **267**, **275**, **277**, **278**; argv-only shell, not netns/Landlock), `HZ_EFFECT_HOST_KERNEL=1` write/edit/shell/ eligible apply_patch/ast_edit kernel route + loop receipt postimage (**280**, **287**) + change-journal record after kernel write/edit (**281**); reduced kernel fs.edit repair opt-in (**287**); TLS upstream pipe (**285**) + `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host`. Residual: unrestricted Bun `shell` by default + full EffectHost; full R172 (RC-7, verify chain, all entry points). |
| **A–D** | Trust, sandbox, steal §8 #11–#15, provider failure codes | **PARTIAL** | Linux `hz-sandbox-exec` TESTED; OAuth hermetic e2e + credentials SQLite (**239**); `symbolCursor` + `outputOffset` paging (**239**); MCP `tools/list` + `resources/list` cursor passthrough (**263**, **264**); speculation opt-in (**670**; default-off). |
| **E** | TUI scrollback + alt-screen slices | **PARTIAL — TESTED** | Scrollback polish (**177**, **236** D9/D11/D15/D17); reduced fullscreen (**193**, **221**); mouse opt-in (**225**); fullscreen palette (**232**); in-loop slash dispatch (**240**); composer ↑/↓ history (**240** D18); fullscreen `/copy` (**236**); fullscreen bracketed paste + shared idle status (**247**); tool-card + approval-card effect linkage + `/theme` persist/load (**250**, **254** D8/D10); plan multi-file hunk labels/apply + screen-reader effect/approval lines (**255** D7/D11); fullscreen rich approval card (**258**); UNKNOWN R169 actions reduced (**282**: inspect/reconcile/export); R172 pane inspector + fullscreen Tab completion stub + inset scrollback hit region (**284**); scrollback Ctrl+I + `hz://receipt/<id>` + palette rank (**290**); inset pane buffer paint + `encodeFullscreenFrameDiff` stub (**299** reduced); live inset pane wire (**300**: Ctrl+B, UNKNOWN/buried transcript); inset wheel scroll independence (**305** reduced); inset keyboard scroll (**306** reduced: Alt+↑/↓, PgUp/PgDn); live main-loop differential R8 paint (**308** reduced: consecutive frames); reconcile-block inset banner when latched (**309** reduced); overlay same-kind differential paint + scrollback BLOCK notice/paths (**310** reduced); main↔overlay soft-transition paint (**316** reduced); overlay↔overlay soft-transition paint (**317** reduced); live modal overlay mouse hit-test when picker/palette/inspector/completion open (**312** reduced); modal backdrop click dismiss (**313** reduced). Grok R1–R12 parity **open** (R2/R4/R9–R12). |
| **G–J** | docs/30 §7 + docs/12 §11 backlog reductions | **PARTIAL — TESTED** (rulings **266**, **268**–**271**, **273**) | §12: F11 worktree pool + F9 mount (**266**); F4 `.hzs` export (**268**); F5 migration stub + F6 admission/FIFO (**269**); F1 snapshot refuse (**270**); F7 blob CAS (**271**); F8 session FTS recency tie-break (**273**); F3 `permission_mode` row + fork meet reduced (**273**). docs/30 §7: many rows reduced; Wave F **SKIP** only (**252**). |
| **I/J** | B-4 cache | **PARTIAL — TESTED** (rulings **200**, **222**, **223**, **246**, **276**, **277**, **282**, **542**, **692**) | System marker + breakpoint planner + Anthropic wire (product-default breakpoints ON, opt-out `HZ_ANTHROPIC_CACHE_BREAKPOINTS=0`; largest-prefix when on) + `cacheableMessagesPrefix` + keep-alive stub with **local** prefix byte/message measure on tick (**282**); doctor `provider.cache` + `provider.cache.hit` hermetic probe (**692**); live path `HZ_LIVE_CACHE=1` test opt-in. Residual: product-loop live cache-hit measure (API keys). |

## Batch 9 — private parent authorization channel (ruling **352**, still partial P0-1)

- **Authenticated parent identity only:** Bun sends a fresh 256-bit secret through a private inherited fd 3 to the Rust kernel; the kernel requires it for `guard.lease`, `guard.grant`, `guard.allowlist.amend` and external `receipt.issue` on product-launched processes. Forged/raw mint requests, malformed pipe boot, and workspace-bound permission mint without the channel refuse. The JS key is hard-private, not in argv/env/log.
- **Strict transport behavior:** a lost trusted kernel cannot return to local permission minting; non-executable/old binaries do not raise an unhandled spawn/pipe error after correcting Bun EACCES handling. The previous OwnerLog UNKNOWN refusal remains.
- **Residual:** this proves control of the Bun parent, **not a trusted human approval principal**; public runtime mint APIs, caller-supplied sessions, unbound standalone kernels and native Windows portability remain gaps. Universal effect ownership, Rust/Bun/SQLite atomic admission, historical replay, production netns, full RC-18/R172, patch parity remain OPEN.
- **Evidence:** [ruling 352 audit](audit/p0-parent-control-auth-2026-11-14.md); Rust integration **78 PASS**, Rust kernel unit **118 PASS** (one long test excluded), focused Bun **50 PASS**, wider Bun **317 PASS** across 39 files, typecheck PASS. Full Bun was red at this batch (2,747/46/3); the final tree is gates-green 8/8 and the full suite passes (last recorded count 3,269/2/0 at ruling 488; later additions not re-counted); see audit.

## Batch 8 — direct kernel Guard authority and bound workspace (ruling **351**, partial P0-1/R170)

- **Kernel admission:** participating direct `effect.execute` mutations are now checked against the actual Rust Guard **under the same OwnerLog OS lock**, before durable prepare. File write/edit/delete and both rename endpoints use `fs.write`; output-only shell uses `shell.exec`. A Guard `ask` or `deny` is terminal before any disk mutation or owner-intent row.
- **Bound workspace:** product-launched Rust kernel captures `HZ_KERNEL_WORKSPACE_ROOT` from the trusted Bun client's selected workspace (ambient env overridden). Mutating RPCs with a different claimed `sandboxRoot` refuse before admission; standalone kernels without this setting remain unbound.
- **Receipts and tool-loop compatibility:** Guard-selected consumed leases (including both rename endpoints) are recorded in the hashed OwnerLog, cross-linked to receipt v1's last `leaseId`. The already-approved shell tool route can mint an exact-command, session-bound one-use lease for the Rust check; raw direct shell calls receive no such implicit permission.
- **Important residual:** existing `guard.lease`/`guard.grant` raw RPCs do not authenticate a human approval principal; `sessionId` remains caller-supplied, not an attested principal. Full Bun/SQLite/MCP/hook/worker ownership and product network enforcement remain open. **Verification:** Rust integration **78 PASS**, Rust unit **115 PASS** (one long test excluded), Bun targeted **296 PASS**, typecheck PASS; full Bun **2,746 PASS / 43 FAIL / 3 SKIP**, global cargo fmt FAIL from unchanged formatting drift. See [Batch 8 audit](audit/p0-direct-guard-admission-2026-11-14.md).
- **Overall:** P0-1–4, full R170, R172, RC-18, patch parity, session/kernel consistency and all release gates remain **NOT COMPLETE**.

## Batch 7 — latest-state postimage replay and RC-7 OwnerLog outcomes (ruling **350**, partial P0-2/R172)

- **P0-2:** The independent Rust `effect.owner.postimage.verify` checks **only the newest settled file postimage on each affected path**, after verifying the OwnerLog and receipt chains. New settled file effects record independently observed `postimages` (write/edit digest, delete absence, and both rename endpoints) inside the hashed owner stream. A fresh external overwrite now creates a detectable mismatch even when both chains still verify.
- **Scope is explicit:** `legacyUnverifiable` reports earlier settlements with no sidecar; `unsupportedEffects` reports shell/process effects with neither file postimages nor archived `streamEvidence` (**542** reduces kernel `shell.exec` to streamChecked when stdout/stderr CAS verifies); `unresolved` remains blocking. Shell filesystem/network side effects stay out of scope. No historical overwritten-file snapshot or universal replay is claimed. `KernelClient.ownerPostimageVerify` refuses an untrusted Bun fallback.
- **R172 reduction:** hashed OwnerLog events now carry RC-7 terminal spellings: `succeeded`, `failed` for a settled nonzero shell exit, `unknown` for unresolved execution, and `interrupted` on proven prepare-only recovery. This does **not** complete the receipt ABI, nested streams or canonical RC-18 event catalogue.
- **Evidence:** Rust integration **74 PASS**, kernel unit **115 PASS** (one long test excluded), typecheck PASS, final targeted Bun **294 PASS / 0 FAIL** across 38 files, and complete Bun **2,743 PASS / 43 FAIL / 3 SKIP** (NOT GREEN); disposable netns direct TCP denial PASS (not product enforcement). See [Batch 7 audit](audit/p0-latest-postimage-replay-2026-11-14.md). Full P0-1–4, R170, R172, RC-18, patch parity and product network enforcement remain OPEN.

## Batch 6 — versioned OwnerLog recovery and fail-closed kernel routing (ruling **349**, partial P0)

- **P0-3 v2 recoverable prepare-only window:** the kernel writes `owner.prepare` and fsynced `owner.executing` before any primitive. A separate process may call `effect.owner.recover(effectId)` **only** for a v2 preparation lacking the executing marker; it is released without execution and its ID stays reserved. Legacy v1, executing, and UNKNOWN never auto-release. `effect.owner.status` exposes `recoverableIds`. Independent-process fault injection proves both sides of the boundary.
- **P0-1 fallback and patch safety:** a trusted Rust refusal is now terminal across kernel write/edit/rename/delete/shell routes; losing the kernel during `effect.execute` refuses a local replay. Formerly trusted transport loss also denies subsequent mutations, and trusted `KernelClient.checkGuard` consults verified OwnerLog before mutating Bun guards (non-atomic preflight only). Multi-step unsupported `apply_patch` is refused **before the first write**; **539** reduced OwnerLog `fs.batch` owns multi-file exact Add/Update write-ops only — full patch/edit/fuzz atomic parity remains OPEN.
- **P0-2 preimage:** Rust independently double-reads and verifies the additive `expectedPreimageDigest` before durable prepare and again just before mutation; TS file routes provide pinned digests when preimages are readable. It reduces stale edit/patch risk, but external TOCTOU, default postimage replay, and all non-file effects remain OPEN.
- **Verification at this slice:** Rust integration **71 PASS**, Rust unit **115 PASS** with long 20k-chain test excluded, TS typecheck PASS, Rust-backed Bun **42 focused PASS**, final broader targeted Bun **292 PASS / 0 FAIL** across 38 files. Full Bun suite **2,742 PASS / 43 FAIL / 3 SKIP** (not green); global `cargo fmt --check` FAIL due unchanged formatting drift. See [Batch 6 security audit](audit/p0-ownerlog-v2-2026-11-14.md) for the exact status and remaining failures.
- **Overall:** P0-1–P0-4, full R170, R172, RC-18, generalized patch parity and session/kernel universal ownership are **NOT COMPLETE**. Do not claim product shell-net `enforced`.

## Batch 5 — kernel-owned cross-process OwnerLog (ruling **348**, partial P0/R170)

- **Default-on for participating direct Rust `effect.execute` mutations only:** `effect_owner.rs` holds a persistent POSIX flock across durable prepare, executed effect, independent postimage/output observation, kernel-issued receipt, and hash-chained settlement. An unpaired prepare, UNKNOWN result, broken chain, or duplicate effectId refuses subsequent participating mutations across independent Rust processes. `effect.owner.status` and `verify` expose auditable state; no Bun-local fake owner verification.
- **Kernel-state and raw shell hardening:** direct file mutations now refuse kernel state paths, dangling/existing symlink aliases and both rename endpoints before execution; raw unconfined shell is limited to fixed benign output-only programs and refuses interpreters, curl/git and arbitrary binaries. This is refusal, **not** product netns egress confinement.
- **Evidence:** Rust process-level multi-client mutation blocking, mixed-case-dispatch bypass regression, fail-close duplicate replay, test-only crash-after-fsynced-prepare recovery, cross-ledger receipt sidecar tamper, forged-owner-log refusal, real kernel-state aliases and unconfined shell denial; TS trusted-kernel two-client, concurrent effects and untrusted fallback refusal tests. **68 Rust integration tests PASS, 115 Rust unit PASS with slow 20k test filtered; TypeScript typecheck PASS, final 290 Bun targeted tests PASS across 38 files.** The disposable `ops/usernetns-direct-tcp-denial-smoke.sh` returns exit 0 (TCP `ENETUNREACH`) but is NOT product egress proof. Full Bun run **2,739 pass, 44 fail, 3 skip, 2 errors**; CI not green. Full rerun evidence and exact residuals: [OwnerLog P0 audit](audit/p0-ownerlog-fence-2026-11-13.md).
- **Still OPEN:** universal kernel-side Guard authorization and *all* tool entrypoints; UNKNOWN independently verified recovery/clean-release; cross-process Bun / SQLite / kernel ownership; event/receipt replay for every effect; R172, RC-18, full patch parity; real product-routed network denial tests. P0-1/2/3/4 are **not complete**.

## P0 Batch 4 partials + end-to-end baseline audit (ruling **347**)

- **Kernel edit parity reduced:** opt-in `fs.edit` now reindents replacement for uniquely matching per-line trim/three-way-style windows, and falls back to unique first/last nonblank equal-length line-patch anchors. Both Rust and TypeScript refuse ambiguous anchors. Trusted Rust kernel E2E checks disk bytes, stable receipt/postimage evidence and refusal without mutation. **Still OPEN:** general merge/patch parity, exact pre-read guarantees for kernel edits, first-hit fuzz and universal EffectHost ownership.
- **Tool entrypoint security:** `lint` now has a loop `fs.read` admission; `present` is session-state with its own per-file read admission. Configured lint shell commands require explicit `shell.exec` guard and approval before spawning. Tests cover denial with no side effects. This closes a specific bypass, **not** every tool entrypoint or process effect.
- **Traceability:** generated `BACKLOG-TRACEABILITY-2026-11-13.md` from the authoritative register and upstream TAKE rows (47 main OPEN, 16 repo-take partial, 44 source-specific partial, 15 checklist items; overlap acknowledged). This is an index of claimed/code-linked coverage, **not** proof of universal verification.
- **Baseline audit (before this local admission/schema repair):** complete Bun suite **2,723 pass / 49 fail / 3 skip** across 390 files; TypeScript typecheck PASS; Rust kernel 114 unit PASS with one long test filtered; Rust integration 58 PASS after ruling 347; full cargo fmt FAIL from broad drift; `timeout 120 bash ops/gates.sh` exit 124 in slow `rust-kernel-suite` before later gates. Final targeted bundle **287 pass / 0 fail** across 37 files. Isolated registry/config/tool-fixture failures are fixed and retested; multiple skill, TUI, PTY and other failures remain. `unshare -n` EPERM and Docker daemon unavailable on this WSL host; routed shell-net E2E **not proven**. Details: [P0 audit](audit/p0-effecthost-baseline-2026-11-13.md).
- **Overall:** P0-1 to P0-4, R170, R172, RC-18 and patch/session consistency are **NOT COMPLETE**. No shell-net `enforced` claim.

## Batch 3 delivered (rulings **345–346**, opt-in edit parity + J-2 selectors)

- **P0 kernel `fs.edit` parity:** Rust `effect_host_edit_repair.rs` and TypeScript LocalKernel resolve uniquely matching relative-indent blocks when `HZ_EFFECT_HOST_EDIT_REPAIR=1`; new text reindents against the matched file block while preserving CRLF. Exact/off-mode and ambiguity refusals remain. The Rust newline-span offset mapper also no longer panics when its scan crosses a multibyte UTF-8 codepoint; trusted-kernel fs.edit E2E verifies disk bytes and postimage digest.
- **J-2 batch subset controls:** `--filter text`, `--shuffle [seed]`, `--slice start:end` now work for batch status/dry-run. Selection is deterministic over all rows before resume omits done/failed; invalid ranges fail loudly and an empty selection does not masquerade as a completed batch.
- **Still open (after ruling 347's reduced unique trim/anchor repair):** full/general Rust kernel merge and line patch parity, first-hit fuzz and read-before-edit proof; all mutation classes executing/observing in the kernel; J-2 per-row execution and Ctrl-C drain (**466** closed runner-config snapshot). No change to overall prototype **NOT COMPLETE** status.

## Batch 2 delivered (ruling **344**, opt-in R170 continuity only)

- New `reconcile-latches.jsonl` under kernel state preserves session/resource latch transitions across runtime restarts. End-of-turn clean assessments no longer silently release a latch; only explicit clean reconciliation does. Unscoped latches cannot be narrowed by later path-scoped evidence.
- First mutator admission assesses unpaired/UNKNOWN evidence and latches immediately. Read-only tools still work under a latch; unclassified built-in/MCP effects fail closed in opt-in gate modes.
- Arbitrary shell is refused while observe is pending or a resource latch is active, even with an apparently disjoint cwd (shell path hints are not proof). Resource latches refuse unknown targets. Multi-file `apply_patch` checks every projected mutation target, including rename source and destination, in the latch, observe-pending, and in-run UNKNOWN gates.
- Existing symlink aliases resolve against blocked paths before overlap checks; **695** adds `(device,inode)` hardlink identity and fail-closed lstat when identity cannot be proven under `=resource`; **699** adds lexical `resolveSymlinkChain` overlap and fail-closed named honesty when a dangling symlink's final target is absent (not treated as non-overlap). **Still open:** full alias-race TOCTOU across admit/write, default-on enforcement, Rust-owned tamper-evident latch OwnerLog, atomic cross-process admit/observe fencing, and universal execution/receipt independence. Full R170 remains **PARTIAL**, not shipped or enforced globally.

## Batch 1 delivered (ruling **343**, still a partial P0 slice)

- Cross-session attach hydrates newly persisted unknown effects and preserves locally unsafe observations. Explicit foreign effect IDs no longer pair through a reused call ID.
- The direct commit-shell, staged apply, and file rewind entry points now refuse unproven mutations in strict kernel mode and honor applicable reconcile barriers. Unknown tools and MCP effect paths default to refusal in strict mode rather than ambient execution.
- `doctor effect.host` reflects user-configured mode and environment precedence, with Linux sandbox auto-default marked as provisional. The test helper now restores EffectHost flags to prevent cross-suite environment leakage.
- **Still open:** universal Rust-owned effect execution and independent observation, full R170 latch semantics, kernel editing parity, and routed network enforcement. No claim of full completion or release.

## P0 residuals (prototype honesty — still open)

1. **EffectHost durable ledger** — **PARTIAL — TESTED** (**220**, **224**, **235**, **243**, **261**, **264**, **267**, **275**, **277**, **278**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **304**, **306**, **307**, **309**, **308**, **311**, **312**, **313**, **314**, **320**, **322**, **327**, **540** trusted-kernel `=require` preference over sandbox `=default`, `HZ_EFFECT_HOST_KERNEL=default`, same-file multi-chunk apply_patch, apply_patch trimEnd/trim (3-way)/unicode-fold/line-patch/dominant-score/unique Levenshtein rungs, EOF exact unique kernel route, ambient shell honesty, `doctor --fix effect.host`): in-run TS + kernel reconcile mirror + `hz.effect.settled`/`unknown`; durable `effects.jsonl` + attach observe-only reconcile + `hz.effect.reconciled`; scrollback/fullscreen UNKNOWN chip + `/unknown` inspect/reconcile/export (**282** reduced R169); R172 structured panes + fullscreen inspect overlay (**284** reduced); kernel `effect.execute` fail-closed for unrestricted mutating kinds except hermetic `pure`/`echo` + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` (caller `sandboxRoot`; shell argv-only, advisory not netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` routes eligible write/edit/shell + reduced sequential Add/exact-Update/Delete/exact-Move `apply_patch`/metavar `ast_edit` (incl. unique-projection variadic `$$$`, **320**) via kernel (**293** multi-op; **296** delete; **297** rename/Move; **302** multi-metavar when unique); `HZ_EFFECT_HOST_KERNEL=require` refuses Bun-owned mutations that cannot kernel-route (**285**, **287** deepen); doctor `effect.host` (**285**); change-journal after kernel write/edit/delete/rename (**281**, **296**, **297**); optional kernel `fs.edit` trim/newline repair (`HZ_EFFECT_HOST_EDIT_REPAIR=1`, **287** reduced vs `edit.ts` ladder). Bun still owns ambient `shell` and default write/edit when unset (doctor); **340** `createRuntime` may apply `=default` on Linux when sandbox wrap active or from config `effectHostKernel` — not full EffectHost. R170 same-path write/edit block in-run. `HZ_EFFECT_RECONCILE_BLOCK=1` session gate + `=resource` path-filtered precursor (**303** reduced vs R170 per-resource). `HZ_EFFECT_HOST_KERNEL=default` prototype routes like `=1` (**299**); `=require` honesty gate. **Still open:** full EffectHost + kernel owns all mutations; cross-file/ambiguous/tied-subthreshold apply_patch fuzz (unique Levenshtein ≥0.66 on kernel **306** reduced; Bun first-hit score fuzz intentionally Bun-only per **313**); **353** routes complete, projectable one-file multi-site `ast_edit` via one atomic kernel write, while unsupported/ambiguous projections remain Bun-owned outside strict mode and refused under `=require` (**322**); full edit repair ladder on kernel path; per-effect docs/06 terminal argv re-probe (**292** workspace allow-list + doctor `terminal.state` only); full R172 (RC-7 **run** terminal; **292** shell **process** pane; **322** `agent.spawn` + child session JSONL summary; nested stream hash/anchor integrity checks (**357** reduced); nested receipt-graph replay from one verified snapshot (**456** reduced); authenticated issuer + `parentReceiptId` contracts + full nested event-stream replay still open).
2. **Independent receipt postimage** — **PARTIAL — TESTED** (**174b**, **256**, **257**, **260**, **261**, **272**, **279**, **280**, **297**, **301**, **314**, **320**, **327**, **328**): additive write/edit postimage + independent double-read stability (mismatch → effect `unknown` + notice; unstable digest omitted from receipt); observe-time `resultDigest` vs tool-output digest + missing postimage → `unknown` (**257**); kernel `effect.reconcile` accepts the same evidence bools (**260**) + `postimageObservationStable` (**279**); kernel `effect.execute` fs.write/fs.edit double-read (**279**) + kernel-route write/edit/delete/rename `resultDigestStable` (**327**/**328**; **314** shell); multi-op `apply_patch` aggregated kernel-route `resultDigest` loop gate (**328**); legacy v1 `verifyReceipts` ignores unhashed observation sidecars (**272**), while new Rust/TS receipt-v2 records bind effect/postimage/child IDs into hash and anchor (**361**); loop receipt issuance uses kernel postimage when `HZ_EFFECT_HOST_KERNEL=1` (**280**); opt-in `HZ_VERIFY_POSTIMAGE_REPLAY=1` independent digest replay at session verify / effect reconcile (**297**); doctor `effect.postimage.replay` + require-auto replay (**301**) + explicit `ast_edit`/`$$$` kernel-route replay scope honesty (**320**). **356** now archives new bounded kernel-owned direct-file postimages for superseded-version verification; legacy file bytes and all non-file observations still unavailable. **360–361** verifiably bind new receipt-v2 sidecars and reject ambiguous child IDs (legacy v1 linkage remains unbound). Residual: full Rust EffectHost must own observation for all effect classes, and postimage replay is opt-in without strict require.
3. **Session ↔ kernel reconciliation** — **PARTIAL** — unpaired report + effectId pairing (**174b**, **224**); live batch/turn notice (**235**); opt-in session block gate + `=resource` path filter (**293**, **303**); reconcile-block status chip + `/unknown status` (**304**); list blocked paths + `/unknown release` (**307** reduced); per-resource dependency lines on status/release (**316** reduced); in-run same-path gate `ast_edit` + driving effect hint (**318** reduced); `HZ_EFFECT_RECONCILE_BLOCK` observe-pending refusal for `apply_patch`/`ast_edit` (**333** reduced) + `write`/`edit` (**334** reduced) + `shell` explicit path/cwd overlap (**336** reduced); cross-session observe-pending `resourceKey` restore from durable ledger on attach (**338** reduced); fullscreen inset BLOCK banner + paths (**309** reduced); scrollback latch notice + status chip parity (**310** reduced); observe-pending per-resource inspector barrier + `BLOCK observe` chip (**342** reduced); full R170 blocking protocol **still open**.
4. **MITM / routed shell egress** — CONNECT proxy + decider + forward (**178**, **195**, **208**); netns honesty (**218**); route doctor **288** (`egress.netns.route`); parent-loopback reach probe **289** (`egress.netns.proxy`, `HZ_EGRESS_NETNS_PROXY` + endpoint); veth capability probe + doctor `egress.netns.veth` + hermetic TCP when CAP_NET_ADMIN (**299**); bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` + `ops/netns-veth-connect-probe.sh` (**315**); spawnOwned child `HTTP(S)_PROXY` remap for wrapped netns when `HZ_EGRESS_NETNS_PROXY`/`HZ_EGRESS_NETNS_PROXY_ROUTED` + bridge endpoint (**317** reduced — env wire only); spawn ROUTED + veth stack doctor `egress.netns.spawn.routed` + hermetic `attemptNetnsSpawnVethRoutedStackEgress` + `ops/netns-spawn-routed-veth-probe.sh` (**319** reduced — alongside hz-sandbox-exec, not in-wrapper); spawnOwned-wrapped CONNECT doctor `egress.netns.spawn.wrapped` + hermetic product `spawnOwned`/`hz-sandbox-exec` bridge path (**321**/**326** reduced — production `child_net=off` after parent veth join); in-wrapper CREATE+ADDR+default-route CONNECT without parent plumb doctor `egress.netns.spawn.wrapped.exec_create` + `attemptNetnsSpawnWrappedExecCreateConnectEgress` + `ops/netns-spawn-wrapped-exec-create-connect-probe.sh` (**332** reduced — hermetic when CAP/`nsenter`); hz-sandbox-exec `HZ_SANDBOX_VETH_JOIN` prepared-netns setns + doctor `egress.netns.exec.veth_join` + `ops/netns-exec-veth-join-probe.sh` (**324** reduced); spawnOwned `HZ_SANDBOX_VETH_*` wire (**325**); hz-sandbox-exec opt-in `HZ_SANDBOX_VETH_CREATE` veth pair + peer move + doctor `egress.netns.exec.veth_create` (**329** reduced); ADDR/route after CREATE (**331**); spawnOwned `HZ_SANDBOX_VETH_CREATE` + HOST/PEER/ADDR wire (**330**); TLS honesty doctor + passthrough test (**231**); optional ClientHello SNI peek on forward (**253**, **279** kernel parser + peek pipe); intercept + loadable CA → fail-closed CONNECT refuse (**281**); hermetic terminate + upstream TLS pipe when intercept/CA/terminate/forward (**283**, **285** reduced); Rust kernel loopback CONNECT listener (**234**); spawnOwned product-default ROUTED+JOIN/CREATE wire + doctor `egress.netns.spawn.product` + `doctor --fix` (**341** reduced — auto when `HZ_SANDBOX_NETNS=1`); production routed netns-only egress **still open**; never claim shell-net `enforced`.
5. **Owner LICENSE** — **DEFERRED** (owner decision; not queued for next agent). `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` (**233**); no root `LICENSE` until owner adds one.

## Explicit non-wired / SKIP (unchanged claims; ruling **252**)

- **Speculation** — opt-in wired (**670**; default-off).
- **Wave F deferred** — D-4 scheduler, provider-hosted tools, external agent subagents, §8 #17–#18 (reasons in `docs/30-steal-list.md` §7 / §8); not queued.
- **docs/30 global SKIP** — Rust TUI rewrite, Effect-TS rewrite, vendored memory MCP as core, Kitty graphics, forge hosted search / spoofed OAuth; H-6 full KDL cascade (**244** ships partial compat map only).

## Recent rulings (218–273)

| Ruling | Topic |
|---|---|
| **218** | Netns CONNECT denial honesty + doctor `egress.netns` |
| **219** | Cline `command-guard` reduced (`command-guard.ts`, plan-mode investigative shell) |
| **220** | Kernel EffectHost + literal `hz.effect.settled` / `unknown` |
| **221** | `--fullscreen` / `HZ_TUI_MODE=fullscreen` product alias (no exit 2) |
| **222** | Cache breakpoint planner (`cache-breakpoints.ts`) |
| **223** | Anthropic cache breakpoint wire |
| **224** | Durable EffectHost `effects.jsonl` + attach reconcile + `hz.effect.reconciled` |
| **225** | Fullscreen mouse hit-test + `HZ_TUI_MOUSE=1` |
| **226** | Batch-tolerant `read` via `paths[]` |
| **227** | Hold-then-swap compaction buffer (`compaction-hold.ts`, `HZ_COMPACTION_HOLD`) |
| **228** | In-history system prompt KV discipline + `appendSystemPromptUpdate` |
| **229** | `ExecutionCapability` seam (shell via `spawnOwned`) |
| **230** | §8 #14 `/autonomy` + bare `/mode` scrollback ladder |
| **231** | §5.2 `egress.tls` MITM honesty + CONNECT TLS passthrough test (advisory only) |
| **232** | Fullscreen command palette overlay (`Ctrl+P`, `/palette`) |
| **233** | `CONTEXT_WINDOW_EXCEEDED` emergency compaction + LICENSE-STATUS honesty (no root LICENSE) |
| **234** | §5.2 Rust kernel `egress.connect.listen` loopback CONNECT — advisory only |
| **235** | TUI UNKNOWN chip + live `session-kernel-reconcile` notice per batch/turn |
| **236** | Wave E D9/D11/D15/D17 scrollback folds, a11y, notify persist, clipboard + fullscreen `/copy` |
| **237** | *(reserved — Wave E peer)* |
| **238** | T-8 quirks (`drop_tool_choice`, `force_user_message`); memory MMR-lite diversify |
| **239** | Hermetic OAuth e2e; `repo_map` `symbolCursor`; tool `outputOffset` paging |
| **240** | Fullscreen `slash-dispatch` + local slash run; alt-screen composer history (D18) |
| **241** | *(reserved — Wave E peer)* |
| **242** | Memory §7 without embeddings: `HZ_CURATOR_APPLY` bank notes; `HZ_MEMORY_DREAM` `dream.md` stub |
| **243** | Kernel `effect.execute` stub + R170 in-run resource gate (TS still executes tools) |
| **247** | Fullscreen bracketed paste + `formatIdleStatusLine` + `/status` (D18 deepen) |
| **251** | Kernel `jsonl_append.rs` parent-dir fsync parity with TS `jsonl-append.ts` (F10) |
| **250** | Wave E D8 tool-card effect/receipt linkage; D10 `/theme` persist + startup load |
| **254** | Wave E D8 approval-card `effectId` / `leaseId` / `tool` linkage on guard ask |
| **252** | Wave F `deferred (SKIP)` labels in docs/30; catalog poll wire residual closed (**180**); doctor `catalog.poll` + `backlog.skip` |
| **253** | §5.2 TLS ClientHello SNI peek on CONNECT forward (`egress-tls-peek.ts`, `HZ_EGRESS_TLS_PEEK=1`) — doctor/logging only; true intercept residual |
| **256** | P0 receipt postimage double-read stability (`receipt-postimage.ts`, `loop.ts` notice + EffectHost `unknown`; fail-closed digest on receipt) |
| **257** | P0 observe evidence gate (`effect-evidence.ts`, `resultDigest` vs tool output + missing postimage → EffectHost `unknown`) |
| **260** | P0 kernel `effect.reconcile` evidence flags (`resultDigestStable`, `postimageMissing` → fail-closed `unknown`) |
| **261** | P0 live `KernelClient.reconcileEffect` after loop/attach EffectHost reconcile (TS verdict authoritative) |
| **263** | §8 #13 MCP `tools/list` cursor pagination helper + client handshake/re-list wire |
| **264** | §8 #13 MCP `resources/list` cursor pagination + `listResources`; TUI `/unknown` + status UNKNOWN list |
| **266** | §12 F11 worktree pool reduced (`worktree-pool.ts`, reuse on `--worktree`, `/worktree`, doctor); F9 mount WARN (`workspace-mount.ts`) |
| **267** | Kernel `effect.execute` sandboxed `fs.read` under caller `sandboxRoot` → `contentDigest`; mutating kinds still fail-closed |
| **275** | Kernel `effect.execute` sandboxed `fs.write` under caller `sandboxRoot` (`text`/`bytes`) → postimage `contentDigest`; unrestricted write + shell still fail-closed |
| **277** | Anthropic cache wire default `cacheableBlocksCutIndex` when `HZ_ANTHROPIC_CACHE_BREAKPOINTS=1`; kernel sandboxed `fs.edit` (single exact replace, existing file, postimage digest); unrestricted shell still fail-closed (**278** sandboxed) |
| **278** | Kernel sandboxed `shell.exec` (argv-only, cwd in root, stdout/stderr digests; NOT netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` write/edit kernel route precursor in `loop.ts` |
| **279** | Kernel fs.write/fs.edit receipt postimage double-read; TLS ClientHello SNI parse in Rust + intercept stub honesty (`HZ_EGRESS_TLS_INTERCEPT`) |
| **280** | `HZ_EFFECT_HOST_KERNEL=1` loop receipt postimage from kernel execute; argv-only `shell` kernel route; compound shell strings refused on kernel path |
| **281** | Kernel-route `recordChange` after write/edit; intercept+CA CONNECT fail-closed refuse until terminate (**283**) |
| **282** | R169 `/unknown inspect|reconcile|export` + local cache prefix measure on keep-alive + doctor `provider.cache` |
| **284** | R172 pane inspector (scrollback + fullscreen overlay) + fullscreen Tab completion stub + inset scrollback hit-test layout |
| **283** | Kernel sandbox atomic write (`sandbox_atomic_write.rs`); `HZ_EGRESS_TLS_TERMINATE=1` CONNECT terminate precursor; rustls handshake smoke in kernel |
| **285** | TLS terminate upstream re-connect pipe (`egress-tls-terminate.ts`); `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host` honesty |
| **286** | Read-only effect reconcile probe (`/unknown reconcile --probe`, doctor `effect.reconcile`); `hzcode receipt show` CLI (R172 reduced) |
| **289** | `egress.netns.proxy` reach assess + `HZ_EGRESS_NETNS_PROXY`; R172 verify pane + `verifyReceiptChainSync` (`receipt show`, `/unknown inspect`) |
| **288** | `egress.netns.route` (ambient / deny-only / proxy-env-partial) + `HZ_SANDBOX_NETNS=1`; fullscreen Ctrl+I + palette `hz://receipt/<id>` (R172 reduced) |
| **290** | docs/06 read-only fs/vcs reconcile probe enrich; scrollback Ctrl+I + `hz://receipt/<id>` + `/palette` receipt rank |
| **291** | `hzcode session verify <id>` exit 3 (chain + reconcile probe); `hzcode effect reconcile` observe-only + `--probe` CLI |
| **293** | Multi-op kernel `apply_patch` route; `HZ_EFFECT_RECONCILE_BLOCK=1` session mutating-tool gate vs full R170 |
| **302** | apply_patch `trim_both` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); ambient shell honesty under default/require |
| **303** | Multi-metavar single-match `ast_edit` kernel route; `HZ_EFFECT_RECONCILE_BLOCK=resource` path-filtered reconcile block |
| **304** | apply_patch `unicode_fold` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); R170 reconcile-block status chip + `/unknown status` |
| **294** | Session verify anchor `.head` checks + R172 child receipt pane + NOTICE provenance doctor |
| **295** | `effect-evidence-gate.ts` wired to `session verify` / `effect reconcile` exit 3; live `childEffectIds` on agent/subagent |
| **298** | RC-7 `run.complete` + `terminal.run` snapshot (cols/rows/tty, shell_session open); inspector **Terminal (run / RC-7)**; Rust `effect_evidence.rs` + fs.read observe gate |
| **327** | Kernel `fs.write`/`fs.edit` canonical success-output `resultDigest` observe + `resultDigestStable` in reconcile; loop kernel-route write/edit gate |
| **328** | Kernel `fs.delete`/`fs.rename` success-output `resultDigest` observe + apply_patch multi-op aggregated `resultDigestStable` loop gate |
| **314** | Kernel sandboxed `shell.exec` stdout/stderr double-hash observe + `resultDigestStable` wired `effect.reconcile` + loop kernel-route shell observe gate |
| **315** | Veth bridge-IP CONNECT hermetic (`attemptNetnsVethRoutedConnectEgress`, `egress-connect-proxy` `listenHost`); doctor `egress.netns.veth.routed`; `ops/netns-veth-connect-probe.sh` |
| **319** | spawn ROUTED + veth stack (`sandbox-netns-spawn-veth.ts`, doctor `egress.netns.spawn.routed`, `ops/netns-spawn-routed-veth-probe.sh`) — alongside hz-sandbox-exec; never enforced |
| **321** | spawnOwned wrapped CONNECT (`sandbox-netns-spawn-wrapped-connect.ts`, doctor `egress.netns.spawn.wrapped`, `ops/netns-spawn-wrapped-connect-probe.sh`) — product-runtime hermetic; in-wrapper veth open; never enforced |
| **323** | `classifyApplyPatchKernelProjectionMiss` + named require refusals (`bun_fuzz_only`, `shape_ineligible`, …) for `apply_patch` under `HZ_EFFECT_HOST_KERNEL=require` |
| **326** | product `child_net=off` CONNECT via bridge after parent veth join (`attemptNetnsSpawnWrappedProductConnectEgress` **326**, doctor `egress.netns.spawn.wrapped`, `ops/netns-spawn-wrapped-connect-probe.sh`) — in-wrapper veth create still open; never enforced |
| **325** | spawnOwned `mergeSandboxExecVethJoinSpawnEnv` wires `HZ_SANDBOX_VETH_JOIN`/`NETNS` (AUTO→`hz-veth-reach-ns`) for wrapped children only |
| **330** | spawnOwned `mergeSandboxExecVethCreateSpawnEnv` wires `HZ_SANDBOX_VETH_CREATE` + optional HOST/PEER for wrapped children; mutex spawn-wiring with JOIN (**325**); doctor `egress.netns.exec.veth_create` spawn hint |
| **332** | spawnOwned in-wrapper CREATE+ADDR+default-route CONNECT (`sandbox-netns-spawn-wrapped-exec-create-connect.ts`, doctor `egress.netns.spawn.wrapped.exec_create`, `ops/netns-spawn-wrapped-exec-create-connect-probe.sh`) — no parent plumb; never enforced |
| **341** | spawnOwned product-default ROUTED+JOIN/CREATE wire (`sandbox-netns-spawn-product-default.ts`, doctor `egress.netns.spawn.product`, `doctor --fix`) — auto when `HZ_SANDBOX_NETNS=1`; never enforced |
| **331** | hz-sandbox-exec ADDR/route after CREATE (`HZ_SANDBOX_VETH_HOST_ADDR`, `HZ_SANDBOX_VETH_PEER_ADDR`, `HZ_SANDBOX_VETH_DEFAULT_ROUTE_*`) — fail-closed ADDR without CREATE; spawn ADDR pass-through on **330** merge; never enforced |
| **329** | hz-sandbox-exec `HZ_SANDBOX_VETH_CREATE` (`sandbox_veth_netlink.rs`, `sandbox-exec-veth-create.ts`, doctor `egress.netns.exec.veth_create`, `ops/netns-exec-veth-create-probe.sh`) — opt-in create+peer move fail-closed; bridge/route (**331** reduced); never enforced |
| **324** | hz-sandbox-exec `HZ_SANDBOX_VETH_JOIN` + `HZ_SANDBOX_VETH_NETNS` (`hz_sandbox_exec.rs`, `sandbox-exec-veth-join.ts`, doctor `egress.netns.exec.veth_join`, `ops/netns-exec-veth-join-probe.sh`) — prepared netns join fail-closed; never enforced |
| **320** | Variadic `$$$` `ast_edit` unique-projection kernel route + doctor honesty; P0 `effect.postimage.replay` `ast_edit` scope |
| **339** | EffectHost kernel `fs.edit` per-line unicode-fold repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust `edit_unicode_fold.rs` after **337** trim; doctor residual |
| **337** | EffectHost kernel `fs.edit` per-line `trim` repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust after **335** trimEnd; doctor residual |
| **335** | EffectHost kernel `fs.edit` per-line `trimEnd` repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust; doctor `--fix effect.host` hint |
| **340** | Product spine: `createRuntime` applies `HZ_EFFECT_HOST_KERNEL=default` on Linux when sandbox wrap active (env unset); user config `effectHostKernel`; doctor still reports off; named shell require refusals under `=require` |
| **540** | Product spine: trusted Rust kernel + Linux + env unset → `HZ_EFFECT_HOST_KERNEL=require` (prefers over sandbox `=default`); explicit env/config preserved; doctor honesty without projecting require |
| **541** | C-11: `HZ_THINKING_CALIBRATED=1` wires local calibrated estimate into `resolveThinkingEffort` (`auto-calibrated`); empirical fit still OPEN |
| **694** | C-11: `HZ_THINKING_LIVE_JUDGE=1` weak-model tier + fail-closed local fallback (`auto-live-judge`) |
| **338** | Cross-session observe-pending hydrate — durable `effects.jsonl` execute `resourceKey` + `tool.call` backfill on attach so `HZ_EFFECT_RECONCILE_BLOCK` gates survive reload without false settle |
| **336** | R170 reconcile-block observe-pending — `shell`/`bash` blocked when explicit `path`/`file`/`file_path` or `cwd` overlaps observe-pending resource under `HZ_EFFECT_RECONCILE_BLOCK` (no default cwd) |
| **334** | R170 reconcile-block observe-pending — `write`/`edit`/`multi_edit` blocked until observe on overlapping path; `shell` only when postimage path resolves (**333** slice for patch tools) |
| **342** | R170 observe-pending per-resource inspector barrier — latch view drivers, `BLOCK observe` chip, scrollback + fullscreen inset, `/unknown status`/`list` lines |
| **333** | R170 `HZ_EFFECT_RECONCILE_BLOCK` observe-pending gate — `apply_patch`/`ast_edit` blocked until receipt observe on same path; execute-step `resourceKey` on EffectHost |
| **478** | R172 nested child event-stream replay from verified parent read (inspector + `session verify` exit 3) |
| **456** | R172 nested receipt-graph replay from one verified snapshot (inspector + `session verify` exit 3) |
| **322** | R172 `agent.spawn` child session stream summary on receipt inspector; `ast_edit` multi-match named refusal under `HZ_EFFECT_HOST_KERNEL=require` |
| **318** | Grok overlay↔overlay `encodeFullscreenConsecutiveFrameDiff` soft transition; R170 in-run gate `ast_edit` + UNKNOWN driver effect id on refusal |
| **316** | R170 per-resource dependency explain (`/unknown status`, `/unknown release` refusal); Grok main↔overlay `encodeFullscreenConsecutiveFrameDiff` soft transition |
| **317** | spawnOwned routed CONNECT proxy env (`HZ_EGRESS_NETNS_PROXY_ROUTED`, `HZ_EGRESS_NETNS_BRIDGE_HOST`, `mergeNetnsEgressProxySpawnEnv` + wrapped-only); doctor `egress.netns.proxy` spawn honesty |
| **313** | apply_patch first-hit score fuzz honesty (`classifyApplyPatchScoreMatchPolicy` + doctor residual); modal overlay mouse backdrop dismiss (`dismiss_modal_overlay` + live wire); prototype `effectHostPrototypeHonestyDoctorHint` (`=require` under `default`) |
| **312** | Live fullscreen modal overlay mouse path (`fullscreenModalOverlayHitOpts` + `handleMouseChunk`); `doctor --fix effect.host` `HZ_EFFECT_HOST_EDIT_REPAIR=1` (dominant score rung) |
| **311** | apply_patch `dominant_score` kernel fuzz rung (≥0.97, Δ0.08) + hit-test `hitTestCacheAfterResize` / completion overlay region (Grok R11/R6 reduced) |
| **310** | Fullscreen overlay same-kind `encodeFullscreenConsecutiveFrameDiff` (palette/picker/inspector/completion); scrollback reconcile-block notice + BLOCK chip refresh |
| **309** | Fullscreen inset reconcile-block banner (`BLOCK mutate`/`BLOCK resource`, status + blocked paths) when latch active |
| **308** | apply_patch `line_patch` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); live `fullscreen-chat` main `paint()` differential encoding |
| **307** | R170 `/unknown` list blocked resource paths + `/unknown release`; apply_patch `relative_indent` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) |
| **306** | apply_patch unique max-score Levenshtein kernel rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) + fullscreen inset Alt+↑/↓ / PgUp/PgDn keyboard scroll |
| **305** | Inset pane independent wheel scroll (`insetScrollUp` vs main `scrollUp`; `scrollback_pane` hit-test) — ruling **300** deepen |
| **300** | Fullscreen live inset pane **Ctrl+B** (`fullscreen-inset-pane.ts`, UNKNOWN/buried transcript); EOF-anchored unique exact `apply_patch` → kernel `fs.edit`; doctor `effect.host` EOF residual |
| **299** | `HZ_EFFECT_HOST_KERNEL=default` + `doctor --fix effect.host`; same-file multi-chunk exact `apply_patch` → ordered kernel `fs.edit`; apply_patch trimEnd (`HZ_EFFECT_HOST_EDIT_REPAIR`); `egress.netns.veth` CAP probe + hermetic veth TCP; Grok inset pane paint stub |
| **292** | docs/06 `terminal.run` read-only argv allow-list probes + doctor `terminal.state`; R172 shell **Terminal (process)** pane (effect process exit only) |
| **287** | Kernel-route eligible `apply_patch`/`ast_edit` projection; `HZ_EFFECT_HOST_EDIT_REPAIR=1` reduced fs.edit repair (Rust + LocalKernel) |
| **268** | §12 F4 `.hzs` export (`archive.ts`, `session export`, `/export hzs`); F2/F3 docs status honesty |
| **269** | §12 F5 `session-migrate.ts` (`user_version` 1, `projection_watermark` stub); F6 admission on `send` + `tool-batch-fifo.ts` scheduler |
| **270** | §12 F1 workspace snapshot refuse (`workspace-snapshot.ts`, doctor, `/snapshot`) |
| **271** | §12 F7 blob CAS reduced (`blobs.ts`, `HZ_BLOB_SPILL=1` spill route) |
| **272** | Local `verifyReceipts` strips `effectId`/`postimage*` before hash recompute (`kernel.ts`; parity issue + Rust) |
| **273** | Trusted `effect.execute` fs.read + `effect.reconcile` evidence on Rust; session FTS BM25+recency rank; F3 `permission_mode` + fork meet |

## Where to work next

1. [`docs/HANDOFF-BACKLOG-2026-11-13.md`](HANDOFF-BACKLOG-2026-11-13.md) — execution queue and P0 **done bars**  
2. `docs/MASTER-BACKLOG-ALL.md` — consolidated matrix  
3. `docs/research/steal-little-coder-aider.md` — local-model + git steal queue (not implemented)

**Working tree:** rulings **315–342** and research pins may exist only as **uncommitted** local changes — verify with `git status` before citing VERIFIED levels.

Do not mark the overall goal complete until P0 §1 done bars in the handoff doc are proven (LICENSE excluded this sprint).
 P0-1 — shape-ineligible write/edit/apply_patch refuse under EffectHost-on (no Bun ambient fallback).
- **P0-1…4 done bars still OPEN.** Never shell-net `enforced`. Speculation opt-in wired (**670**). LICENSE deferred.

## Release blockers (honest — not a roadmap)

Gates **8/8** prove the repository CI contract. They do **not** prove a shippable trust product. Until the items below close (or the owner explicitly lowers the bar), do **not** call the tree RELEASED.

### Hard P0 spine (done bars unmet — FULL-BACKLOG §A / §Z)

| # | Blocker | What “done” still requires | Partial today |
|---:|---|---|---|
| **P0-1** | Universal EffectHost | Kernel owns **or refuses** every mutation path (write/edit/shell/apply_patch/ast_edit **and** ambient Bun: MCP, hooks, undo, preview, agent, code_mode); no silent Bun fallback under honesty gate | Reduced `fs.batch` + `EDIT_REPAIR` (**539**–**646**); `=require` auto on trusted Linux (**540**); **649**–**653**/**702**/**721** require preflight + undo route + hooks suppress + compound shell refuse + never-routable + MCP spawn refuse + mutating `mcp.invoke` fail-closed under EffectHost-on; hooks OwnerLog OPEN; read-only MCP ambient under `=default`/`=1` only; first-hit mixed-score refuse under require (**687**); tied-equal kernel route; shape-ineligible write/edit still Bun under non-require |
| **P0-2** | Full postimage / Rust observe | Rust observes **every** effect class; complete historical replay (not only latest file postimage / shell streamEvidence) | Latest-file replay (**350**); CAS superseded (**356**); shell stdout/stderr streamChecked (**542**); **654** superseded CAS overwrite replay; **669**/**686** named shell argv FS postimages (`rm -f`/`touch`/`mkdir -p`/`cp`/`mv` reduced argv only); **698** bounded nested `childEffectIds` OwnerLog observe on postimage verify; **700** independent absence classify + signed absence-fact replay (partial); **709** named `legacyClassify` for rows without digest/CAS/stream (partial); arbitrary shell FS/net + deleted-byte reconstruction + deep universal nested observe still OPEN |
| **P0-3** | Full R170 | Kernel-owned mandatory cross-process barrier for Bun/SQLite/MCP/hooks; UNKNOWN recovery that is not prepare-only | TS latch + reduced `=resource` spine (**344**/**538**); OwnerLog flock for **direct** kernel effects (**348**+); prepare-only recover (**349**); **655** attested abandon; **714** fs.write + **722** fs.edit + **733** fs.delete observe-settle (partial); **673** Bun mutation fence (partial); **683** MCP + **690** SQLite mutator fail-closed (partial); **691** preTool + **718** observation hooks reconcile-barrier (partial); **695** hardlink `(dev,ino)` overlap + lstat fail-closed (partial); **699** dangling-symlink overlap fail-closed + named honesty (partial); full alias-race TOCTOU + hooks kernel OwnerLog / session lifecycle still OPEN |
| **P0-4** | Product routed egress | Product netns path that confines child egress without ever advertising shell-net **`enforced`** | Decider + probes + optional CONNECT (**315**–**341**, **533**); **656** CREATE prove; **672** default-on when capable; **715** WSL/CAP/userns gap honesty; never `enforced` |

### Wave-0 / trust residuals that still block a “strict” release

| Area | Still open |
|---|---|
| **R172** | Authenticated receipt issuer; keyed cross-process attestation (nested replay **456**/**478**; **657** `parentReceiptId`; **688** kernel `issuerStamp`; **725** TS chain/doctor keyed verify — human issuer + full attestation still OPEN) |
| **G1** | **719** trusted product default-on V2 projection (`HZ_GUARD_G1_WIRE=1` when unset; `=0` legacy); **637** additive `g1`; **716** doctor honesty; frozen `contracts.ts` `allow` + raw lease/grant + human principal still OPEN |
| **Human approval principal** | **720** fd-3 mints stamp `principal:"parent"`; **717**/**720** `HZ_HUMAN_PRINCIPAL_STRICT=1` refuses Bun + kernel raw mint without `principal:"human"`; doctor **712** names fd-3 (**352**) ≠ human; cryptographic human identity + policy-allow internal mint stamps remain OPEN |
| **H-29 / H-30 / CB-6** | Detach/socket/epoch/lease/host flock + **710** `hzk.binary` reattach seal + **724** Windows `LockFileEx` (**625**–**638**/**647**/**703**/**710**/**724**); Windows peer honesty (**696**); Windows `--socket`/SO_PEERCRED detach still OPEN |
| **H-31** | Workspace `(dev,ino)` bind + digest + held-lease remount + Bun capture/drift (**623**/**629**/**636**/**674**/**734**); intermediate-component TOCTOU still OPEN |
| **Speculation** | Opt-in wired (**670**) + prep-discard/doctor (**730**); default-off; segment/hook residuals OPEN |
| **LICENSE** | No root `LICENSE` — deferred ([`LICENSE-STATUS.md`](LICENSE-STATUS.md)); distribution terms unset |

### Product / steal residuals (do not confuse with P0, but they block feature-complete release)

Partial §7 rows still carrying live residuals (FULL-BACKLOG §C): **B-4** live cache-hit measure; **C-7/C-9** live GPT-6 Responses session (doctor `provider.responses.steer` hermetic only — **697**); **C-11** empirical corpus calibration; **C-12** Windows parent-walk prove + full R170 / live D-6 over pipe (**704** — macOS reduced `ps` walk; Windows fail-closed); **C-13** kernel-owned R170 (not SQLite fence alone); **D-3** monotonic sleep-wake re-anchor + Windows births (**707** shipped non-Linux honesty + Darwin reduced lstart); **F-4/G-1/H-2/I-2** live invoice / billing truth; **G-9** full if-bench corpus; **H-7** misc CLI metric contracts; **J-1/J-3/J-4** official harness credentials + OS-enforced proxy + live omp metaharness. Plus Eng Brain tree-sitter AST call-graph (**640**/**685** residual beyond **727**), Code Mode kernel route (**641**), full ACP (**642**), verify-artifact bundled browser / default-on every turn (**643**), live H2H SWE-bench matrix (**644**).

### Process / ops (release hygiene, not P0 spine)

| Item | Note |
|---|---|
| Working tree vs `origin/main` | Stop-of-day **2026-11-20** commits rulings **538–734** to `main` ([`STOP-OF-DAY-2026-11-20.md`](STOP-OF-DAY-2026-11-20.md)); re-verify gates after push |
| docs/24 §3.5 catalogue | 18 rows remain `declared-gap` in `ops/gate-catalogue.md` — runner never pretends they run |
| NOTICE / provenance | Release-grade NOTICE rows keyed to full Provenance tables still OPEN (`33-handoff` §6) |
| Never claim | Shell-net egress **`enforced`** |

## Wave summary (honest)

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **0** | Honesty + spine precursors | **PARTIAL — TESTED** (rulings **174b**, **224**, **235**, **243**, **251**, **256**, **257**, **260**, **261**, **264**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **289**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **305**, **306**, **307**, **308**, **309**, **310**, **311**, **312**, **313**, **314**, **315**, **316**, **317**, **318**, **319**, **320**, **322**, **324**, **325**, **326**, **327**, **328**, **329**, **330**, **331**, **332**, **333**, **334**, **335**, **336**, **337**, **338**, **339**, **340**, **341**, **342**, **343**, **344**, **345**) | RC-18 event map (**454**; `event-catalogue.test.ts`): **50** shipped types; **44/44** canonical mapped; **32** literal `hz.*`; **0** unmapped, JSONL fsync + kernel/TS parent-dir parity (**251**), receipt postimage + independent double-read stability (**256** TS + **279** kernel execute) + observe evidence gate (**257**), kernel `effect.reconcile` evidence flags (**260**) + live loop/attach wire (**261**), `session-kernel-reconcile` + effectId pairing + live turn/batch notice, durable `effects.jsonl` + attach reconcile + `hz.effect.reconciled`, TUI UNKNOWN chip + `/unknown` inspect/reconcile/export (**235**, **264**, **282**), R172 structured receipt panes + fullscreen inspect overlay (**284** reduced), kernel `effect.execute` stub + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` under caller `sandboxRoot` (**243**, **267**, **275**, **277**, **278**; argv-only shell, not netns/Landlock), `HZ_EFFECT_HOST_KERNEL=1` write/edit/shell/ eligible apply_patch/ast_edit kernel route + loop receipt postimage (**280**, **287**) + change-journal record after kernel write/edit (**281**); reduced kernel fs.edit repair opt-in (**287**); TLS upstream pipe (**285**) + `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host`. Residual: unrestricted Bun `shell` by default + full EffectHost; full R172 (RC-7, verify chain, all entry points). |
| **A–D** | Trust, sandbox, steal §8 #11–#15, provider failure codes | **PARTIAL** | Linux `hz-sandbox-exec` TESTED; OAuth hermetic e2e + credentials SQLite (**239**); `symbolCursor` + `outputOffset` paging (**239**); MCP `tools/list` + `resources/list` cursor passthrough (**263**, **264**); speculation opt-in (**670**; default-off). |
| **E** | TUI scrollback + alt-screen slices | **PARTIAL — TESTED** | Scrollback polish (**177**, **236** D9/D11/D15/D17); reduced fullscreen (**193**, **221**); mouse opt-in (**225**); fullscreen palette (**232**); in-loop slash dispatch (**240**); composer ↑/↓ history (**240** D18); fullscreen `/copy` (**236**); fullscreen bracketed paste + shared idle status (**247**); tool-card + approval-card effect linkage + `/theme` persist/load (**250**, **254** D8/D10); plan multi-file hunk labels/apply + screen-reader effect/approval lines (**255** D7/D11); fullscreen rich approval card (**258**); UNKNOWN R169 actions reduced (**282**: inspect/reconcile/export); R172 pane inspector + fullscreen Tab completion stub + inset scrollback hit region (**284**); scrollback Ctrl+I + `hz://receipt/<id>` + palette rank (**290**); inset pane buffer paint + `encodeFullscreenFrameDiff` stub (**299** reduced); live inset pane wire (**300**: Ctrl+B, UNKNOWN/buried transcript); inset wheel scroll independence (**305** reduced); inset keyboard scroll (**306** reduced: Alt+↑/↓, PgUp/PgDn); live main-loop differential R8 paint (**308** reduced: consecutive frames); reconcile-block inset banner when latched (**309** reduced); overlay same-kind differential paint + scrollback BLOCK notice/paths (**310** reduced); main↔overlay soft-transition paint (**316** reduced); overlay↔overlay soft-transition paint (**317** reduced); live modal overlay mouse hit-test when picker/palette/inspector/completion open (**312** reduced); modal backdrop click dismiss (**313** reduced). Grok R1–R12 parity **open** (R2/R4/R9–R12). |
| **G–J** | docs/30 §7 + docs/12 §11 backlog reductions | **PARTIAL — TESTED** (rulings **266**, **268**–**271**, **273**) | §12: F11 worktree pool + F9 mount (**266**); F4 `.hzs` export (**268**); F5 migration stub + F6 admission/FIFO (**269**); F1 snapshot refuse (**270**); F7 blob CAS (**271**); F8 session FTS recency tie-break (**273**); F3 `permission_mode` row + fork meet reduced (**273**). docs/30 §7: many rows reduced; Wave F **SKIP** only (**252**). |
| **I/J** | B-4 cache | **PARTIAL — TESTED** (rulings **200**, **222**, **223**, **246**, **276**, **277**, **282**, **542**, **692**) | System marker + breakpoint planner + Anthropic wire (product-default breakpoints ON, opt-out `HZ_ANTHROPIC_CACHE_BREAKPOINTS=0`; largest-prefix when on) + `cacheableMessagesPrefix` + keep-alive stub with **local** prefix byte/message measure on tick (**282**); doctor `provider.cache` + `provider.cache.hit` hermetic probe (**692**); live path `HZ_LIVE_CACHE=1` test opt-in. Residual: product-loop live cache-hit measure (API keys). |

## Batch 9 — private parent authorization channel (ruling **352**, still partial P0-1)

- **Authenticated parent identity only:** Bun sends a fresh 256-bit secret through a private inherited fd 3 to the Rust kernel; the kernel requires it for `guard.lease`, `guard.grant`, `guard.allowlist.amend` and external `receipt.issue` on product-launched processes. Forged/raw mint requests, malformed pipe boot, and workspace-bound permission mint without the channel refuse. The JS key is hard-private, not in argv/env/log.
- **Strict transport behavior:** a lost trusted kernel cannot return to local permission minting; non-executable/old binaries do not raise an unhandled spawn/pipe error after correcting Bun EACCES handling. The previous OwnerLog UNKNOWN refusal remains.
- **Residual:** this proves control of the Bun parent, **not a trusted human approval principal**; public runtime mint APIs, caller-supplied sessions, unbound standalone kernels and native Windows portability remain gaps. Universal effect ownership, Rust/Bun/SQLite atomic admission, historical replay, production netns, full RC-18/R172, patch parity remain OPEN.
- **Evidence:** [ruling 352 audit](audit/p0-parent-control-auth-2026-11-14.md); Rust integration **78 PASS**, Rust kernel unit **118 PASS** (one long test excluded), focused Bun **50 PASS**, wider Bun **317 PASS** across 39 files, typecheck PASS. Full Bun was red at this batch (2,747/46/3); the final tree is gates-green 8/8 and the full suite passes (last recorded count 3,269/2/0 at ruling 488; later additions not re-counted); see audit.

## Batch 8 — direct kernel Guard authority and bound workspace (ruling **351**, partial P0-1/R170)

- **Kernel admission:** participating direct `effect.execute` mutations are now checked against the actual Rust Guard **under the same OwnerLog OS lock**, before durable prepare. File write/edit/delete and both rename endpoints use `fs.write`; output-only shell uses `shell.exec`. A Guard `ask` or `deny` is terminal before any disk mutation or owner-intent row.
- **Bound workspace:** product-launched Rust kernel captures `HZ_KERNEL_WORKSPACE_ROOT` from the trusted Bun client's selected workspace (ambient env overridden). Mutating RPCs with a different claimed `sandboxRoot` refuse before admission; standalone kernels without this setting remain unbound.
- **Receipts and tool-loop compatibility:** Guard-selected consumed leases (including both rename endpoints) are recorded in the hashed OwnerLog, cross-linked to receipt v1's last `leaseId`. The already-approved shell tool route can mint an exact-command, session-bound one-use lease for the Rust check; raw direct shell calls receive no such implicit permission.
- **Important residual:** existing `guard.lease`/`guard.grant` raw RPCs do not authenticate a human approval principal; `sessionId` remains caller-supplied, not an attested principal. Full Bun/SQLite/MCP/hook/worker ownership and product network enforcement remain open. **Verification:** Rust integration **78 PASS**, Rust unit **115 PASS** (one long test excluded), Bun targeted **296 PASS**, typecheck PASS; full Bun **2,746 PASS / 43 FAIL / 3 SKIP**, global cargo fmt FAIL from unchanged formatting drift. See [Batch 8 audit](audit/p0-direct-guard-admission-2026-11-14.md).
- **Overall:** P0-1–4, full R170, R172, RC-18, patch parity, session/kernel consistency and all release gates remain **NOT COMPLETE**.

## Batch 7 — latest-state postimage replay and RC-7 OwnerLog outcomes (ruling **350**, partial P0-2/R172)

- **P0-2:** The independent Rust `effect.owner.postimage.verify` checks **only the newest settled file postimage on each affected path**, after verifying the OwnerLog and receipt chains. New settled file effects record independently observed `postimages` (write/edit digest, delete absence, and both rename endpoints) inside the hashed owner stream. A fresh external overwrite now creates a detectable mismatch even when both chains still verify.
- **Scope is explicit:** `legacyUnverifiable` reports earlier settlements with no sidecar; `unsupportedEffects` reports shell/process effects with neither file postimages nor archived `streamEvidence` (**542** reduces kernel `shell.exec` to streamChecked when stdout/stderr CAS verifies); `unresolved` remains blocking. Shell filesystem/network side effects stay out of scope. No historical overwritten-file snapshot or universal replay is claimed. `KernelClient.ownerPostimageVerify` refuses an untrusted Bun fallback.
- **R172 reduction:** hashed OwnerLog events now carry RC-7 terminal spellings: `succeeded`, `failed` for a settled nonzero shell exit, `unknown` for unresolved execution, and `interrupted` on proven prepare-only recovery. This does **not** complete the receipt ABI, nested streams or canonical RC-18 event catalogue.
- **Evidence:** Rust integration **74 PASS**, kernel unit **115 PASS** (one long test excluded), typecheck PASS, final targeted Bun **294 PASS / 0 FAIL** across 38 files, and complete Bun **2,743 PASS / 43 FAIL / 3 SKIP** (NOT GREEN); disposable netns direct TCP denial PASS (not product enforcement). See [Batch 7 audit](audit/p0-latest-postimage-replay-2026-11-14.md). Full P0-1–4, R170, R172, RC-18, patch parity and product network enforcement remain OPEN.

## Batch 6 — versioned OwnerLog recovery and fail-closed kernel routing (ruling **349**, partial P0)

- **P0-3 v2 recoverable prepare-only window:** the kernel writes `owner.prepare` and fsynced `owner.executing` before any primitive. A separate process may call `effect.owner.recover(effectId)` **only** for a v2 preparation lacking the executing marker; it is released without execution and its ID stays reserved. Legacy v1, executing, and UNKNOWN never auto-release. `effect.owner.status` exposes `recoverableIds`. Independent-process fault injection proves both sides of the boundary.
- **P0-1 fallback and patch safety:** a trusted Rust refusal is now terminal across kernel write/edit/rename/delete/shell routes; losing the kernel during `effect.execute` refuses a local replay. Formerly trusted transport loss also denies subsequent mutations, and trusted `KernelClient.checkGuard` consults verified OwnerLog before mutating Bun guards (non-atomic preflight only). Multi-step unsupported `apply_patch` is refused **before the first write**; **539** reduced OwnerLog `fs.batch` owns multi-file exact Add/Update write-ops only — full patch/edit/fuzz atomic parity remains OPEN.
- **P0-2 preimage:** Rust independently double-reads and verifies the additive `expectedPreimageDigest` before durable prepare and again just before mutation; TS file routes provide pinned digests when preimages are readable. It reduces stale edit/patch risk, but external TOCTOU, default postimage replay, and all non-file effects remain OPEN.
- **Verification at this slice:** Rust integration **71 PASS**, Rust unit **115 PASS** with long 20k-chain test excluded, TS typecheck PASS, Rust-backed Bun **42 focused PASS**, final broader targeted Bun **292 PASS / 0 FAIL** across 38 files. Full Bun suite **2,742 PASS / 43 FAIL / 3 SKIP** (not green); global `cargo fmt --check` FAIL due unchanged formatting drift. See [Batch 6 security audit](audit/p0-ownerlog-v2-2026-11-14.md) for the exact status and remaining failures.
- **Overall:** P0-1–P0-4, full R170, R172, RC-18, generalized patch parity and session/kernel universal ownership are **NOT COMPLETE**. Do not claim product shell-net `enforced`.

## Batch 5 — kernel-owned cross-process OwnerLog (ruling **348**, partial P0/R170)

- **Default-on for participating direct Rust `effect.execute` mutations only:** `effect_owner.rs` holds a persistent POSIX flock across durable prepare, executed effect, independent postimage/output observation, kernel-issued receipt, and hash-chained settlement. An unpaired prepare, UNKNOWN result, broken chain, or duplicate effectId refuses subsequent participating mutations across independent Rust processes. `effect.owner.status` and `verify` expose auditable state; no Bun-local fake owner verification.
- **Kernel-state and raw shell hardening:** direct file mutations now refuse kernel state paths, dangling/existing symlink aliases and both rename endpoints before execution; raw unconfined shell is limited to fixed benign output-only programs and refuses interpreters, curl/git and arbitrary binaries. This is refusal, **not** product netns egress confinement.
- **Evidence:** Rust process-level multi-client mutation blocking, mixed-case-dispatch bypass regression, fail-close duplicate replay, test-only crash-after-fsynced-prepare recovery, cross-ledger receipt sidecar tamper, forged-owner-log refusal, real kernel-state aliases and unconfined shell denial; TS trusted-kernel two-client, concurrent effects and untrusted fallback refusal tests. **68 Rust integration tests PASS, 115 Rust unit PASS with slow 20k test filtered; TypeScript typecheck PASS, final 290 Bun targeted tests PASS across 38 files.** The disposable `ops/usernetns-direct-tcp-denial-smoke.sh` returns exit 0 (TCP `ENETUNREACH`) but is NOT product egress proof. Full Bun run **2,739 pass, 44 fail, 3 skip, 2 errors**; CI not green. Full rerun evidence and exact residuals: [OwnerLog P0 audit](audit/p0-ownerlog-fence-2026-11-13.md).
- **Still OPEN:** universal kernel-side Guard authorization and *all* tool entrypoints; UNKNOWN independently verified recovery/clean-release; cross-process Bun / SQLite / kernel ownership; event/receipt replay for every effect; R172, RC-18, full patch parity; real product-routed network denial tests. P0-1/2/3/4 are **not complete**.

## P0 Batch 4 partials + end-to-end baseline audit (ruling **347**)

- **Kernel edit parity reduced:** opt-in `fs.edit` now reindents replacement for uniquely matching per-line trim/three-way-style windows, and falls back to unique first/last nonblank equal-length line-patch anchors. Both Rust and TypeScript refuse ambiguous anchors. Trusted Rust kernel E2E checks disk bytes, stable receipt/postimage evidence and refusal without mutation. **Still OPEN:** general merge/patch parity, exact pre-read guarantees for kernel edits, first-hit fuzz and universal EffectHost ownership.
- **Tool entrypoint security:** `lint` now has a loop `fs.read` admission; `present` is session-state with its own per-file read admission. Configured lint shell commands require explicit `shell.exec` guard and approval before spawning. Tests cover denial with no side effects. This closes a specific bypass, **not** every tool entrypoint or process effect.
- **Traceability:** generated `BACKLOG-TRACEABILITY-2026-11-13.md` from the authoritative register and upstream TAKE rows (47 main OPEN, 16 repo-take partial, 44 source-specific partial, 15 checklist items; overlap acknowledged). This is an index of claimed/code-linked coverage, **not** proof of universal verification.
- **Baseline audit (before this local admission/schema repair):** complete Bun suite **2,723 pass / 49 fail / 3 skip** across 390 files; TypeScript typecheck PASS; Rust kernel 114 unit PASS with one long test filtered; Rust integration 58 PASS after ruling 347; full cargo fmt FAIL from broad drift; `timeout 120 bash ops/gates.sh` exit 124 in slow `rust-kernel-suite` before later gates. Final targeted bundle **287 pass / 0 fail** across 37 files. Isolated registry/config/tool-fixture failures are fixed and retested; multiple skill, TUI, PTY and other failures remain. `unshare -n` EPERM and Docker daemon unavailable on this WSL host; routed shell-net E2E **not proven**. Details: [P0 audit](audit/p0-effecthost-baseline-2026-11-13.md).
- **Overall:** P0-1 to P0-4, R170, R172, RC-18 and patch/session consistency are **NOT COMPLETE**. No shell-net `enforced` claim.

## Batch 3 delivered (rulings **345–346**, opt-in edit parity + J-2 selectors)

- **P0 kernel `fs.edit` parity:** Rust `effect_host_edit_repair.rs` and TypeScript LocalKernel resolve uniquely matching relative-indent blocks when `HZ_EFFECT_HOST_EDIT_REPAIR=1`; new text reindents against the matched file block while preserving CRLF. Exact/off-mode and ambiguity refusals remain. The Rust newline-span offset mapper also no longer panics when its scan crosses a multibyte UTF-8 codepoint; trusted-kernel fs.edit E2E verifies disk bytes and postimage digest.
- **J-2 batch subset controls:** `--filter text`, `--shuffle [seed]`, `--slice start:end` now work for batch status/dry-run. Selection is deterministic over all rows before resume omits done/failed; invalid ranges fail loudly and an empty selection does not masquerade as a completed batch.
- **Still open (after ruling 347's reduced unique trim/anchor repair):** full/general Rust kernel merge and line patch parity, first-hit fuzz and read-before-edit proof; all mutation classes executing/observing in the kernel; J-2 per-row execution and Ctrl-C drain (**466** closed runner-config snapshot). No change to overall prototype **NOT COMPLETE** status.

## Batch 2 delivered (ruling **344**, opt-in R170 continuity only)

- New `reconcile-latches.jsonl` under kernel state preserves session/resource latch transitions across runtime restarts. End-of-turn clean assessments no longer silently release a latch; only explicit clean reconciliation does. Unscoped latches cannot be narrowed by later path-scoped evidence.
- First mutator admission assesses unpaired/UNKNOWN evidence and latches immediately. Read-only tools still work under a latch; unclassified built-in/MCP effects fail closed in opt-in gate modes.
- Arbitrary shell is refused while observe is pending or a resource latch is active, even with an apparently disjoint cwd (shell path hints are not proof). Resource latches refuse unknown targets. Multi-file `apply_patch` checks every projected mutation target, including rename source and destination, in the latch, observe-pending, and in-run UNKNOWN gates.
- Existing symlink aliases resolve against blocked paths before overlap checks; **695** adds `(device,inode)` hardlink identity and fail-closed lstat when identity cannot be proven under `=resource`; **699** adds lexical `resolveSymlinkChain` overlap and fail-closed named honesty when a dangling symlink's final target is absent (not treated as non-overlap). **Still open:** full alias-race TOCTOU across admit/write, default-on enforcement, Rust-owned tamper-evident latch OwnerLog, atomic cross-process admit/observe fencing, and universal execution/receipt independence. Full R170 remains **PARTIAL**, not shipped or enforced globally.

## Batch 1 delivered (ruling **343**, still a partial P0 slice)

- Cross-session attach hydrates newly persisted unknown effects and preserves locally unsafe observations. Explicit foreign effect IDs no longer pair through a reused call ID.
- The direct commit-shell, staged apply, and file rewind entry points now refuse unproven mutations in strict kernel mode and honor applicable reconcile barriers. Unknown tools and MCP effect paths default to refusal in strict mode rather than ambient execution.
- `doctor effect.host` reflects user-configured mode and environment precedence, with Linux sandbox auto-default marked as provisional. The test helper now restores EffectHost flags to prevent cross-suite environment leakage.
- **Still open:** universal Rust-owned effect execution and independent observation, full R170 latch semantics, kernel editing parity, and routed network enforcement. No claim of full completion or release.

## P0 residuals (prototype honesty — still open)

1. **EffectHost durable ledger** — **PARTIAL — TESTED** (**220**, **224**, **235**, **243**, **261**, **264**, **267**, **275**, **277**, **278**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **304**, **306**, **307**, **309**, **308**, **311**, **312**, **313**, **314**, **320**, **322**, **327**, **540** trusted-kernel `=require` preference over sandbox `=default`, `HZ_EFFECT_HOST_KERNEL=default`, same-file multi-chunk apply_patch, apply_patch trimEnd/trim (3-way)/unicode-fold/line-patch/dominant-score/unique Levenshtein rungs, EOF exact unique kernel route, ambient shell honesty, `doctor --fix effect.host`): in-run TS + kernel reconcile mirror + `hz.effect.settled`/`unknown`; durable `effects.jsonl` + attach observe-only reconcile + `hz.effect.reconciled`; scrollback/fullscreen UNKNOWN chip + `/unknown` inspect/reconcile/export (**282** reduced R169); R172 structured panes + fullscreen inspect overlay (**284** reduced); kernel `effect.execute` fail-closed for unrestricted mutating kinds except hermetic `pure`/`echo` + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` (caller `sandboxRoot`; shell argv-only, advisory not netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` routes eligible write/edit/shell + reduced sequential Add/exact-Update/Delete/exact-Move `apply_patch`/metavar `ast_edit` (incl. unique-projection variadic `$$$`, **320**) via kernel (**293** multi-op; **296** delete; **297** rename/Move; **302** multi-metavar when unique); `HZ_EFFECT_HOST_KERNEL=require` refuses Bun-owned mutations that cannot kernel-route (**285**, **287** deepen); doctor `effect.host` (**285**); change-journal after kernel write/edit/delete/rename (**281**, **296**, **297**); optional kernel `fs.edit` trim/newline repair (`HZ_EFFECT_HOST_EDIT_REPAIR=1`, **287** reduced vs `edit.ts` ladder). Bun still owns ambient `shell` and default write/edit when unset (doctor); **340** `createRuntime` may apply `=default` on Linux when sandbox wrap active or from config `effectHostKernel` — not full EffectHost. R170 same-path write/edit block in-run. `HZ_EFFECT_RECONCILE_BLOCK=1` session gate + `=resource` path-filtered precursor (**303** reduced vs R170 per-resource). `HZ_EFFECT_HOST_KERNEL=default` prototype routes like `=1` (**299**); `=require` honesty gate. **Still open:** full EffectHost + kernel owns all mutations; cross-file/ambiguous/tied-subthreshold apply_patch fuzz (unique Levenshtein ≥0.66 on kernel **306** reduced; Bun first-hit score fuzz intentionally Bun-only per **313**); **353** routes complete, projectable one-file multi-site `ast_edit` via one atomic kernel write, while unsupported/ambiguous projections remain Bun-owned outside strict mode and refused under `=require` (**322**); full edit repair ladder on kernel path; per-effect docs/06 terminal argv re-probe (**292** workspace allow-list + doctor `terminal.state` only); full R172 (RC-7 **run** terminal; **292** shell **process** pane; **322** `agent.spawn` + child session JSONL summary; nested stream hash/anchor integrity checks (**357** reduced); nested receipt-graph replay from one verified snapshot (**456** reduced); authenticated issuer + `parentReceiptId` contracts + full nested event-stream replay still open).
2. **Independent receipt postimage** — **PARTIAL — TESTED** (**174b**, **256**, **257**, **260**, **261**, **272**, **279**, **280**, **297**, **301**, **314**, **320**, **327**, **328**): additive write/edit postimage + independent double-read stability (mismatch → effect `unknown` + notice; unstable digest omitted from receipt); observe-time `resultDigest` vs tool-output digest + missing postimage → `unknown` (**257**); kernel `effect.reconcile` accepts the same evidence bools (**260**) + `postimageObservationStable` (**279**); kernel `effect.execute` fs.write/fs.edit double-read (**279**) + kernel-route write/edit/delete/rename `resultDigestStable` (**327**/**328**; **314** shell); multi-op `apply_patch` aggregated kernel-route `resultDigest` loop gate (**328**); legacy v1 `verifyReceipts` ignores unhashed observation sidecars (**272**), while new Rust/TS receipt-v2 records bind effect/postimage/child IDs into hash and anchor (**361**); loop receipt issuance uses kernel postimage when `HZ_EFFECT_HOST_KERNEL=1` (**280**); opt-in `HZ_VERIFY_POSTIMAGE_REPLAY=1` independent digest replay at session verify / effect reconcile (**297**); doctor `effect.postimage.replay` + require-auto replay (**301**) + explicit `ast_edit`/`$$$` kernel-route replay scope honesty (**320**). **356** now archives new bounded kernel-owned direct-file postimages for superseded-version verification; legacy file bytes and all non-file observations still unavailable. **360–361** verifiably bind new receipt-v2 sidecars and reject ambiguous child IDs (legacy v1 linkage remains unbound). Residual: full Rust EffectHost must own observation for all effect classes, and postimage replay is opt-in without strict require.
3. **Session ↔ kernel reconciliation** — **PARTIAL** — unpaired report + effectId pairing (**174b**, **224**); live batch/turn notice (**235**); opt-in session block gate + `=resource` path filter (**293**, **303**); reconcile-block status chip + `/unknown status` (**304**); list blocked paths + `/unknown release` (**307** reduced); per-resource dependency lines on status/release (**316** reduced); in-run same-path gate `ast_edit` + driving effect hint (**318** reduced); `HZ_EFFECT_RECONCILE_BLOCK` observe-pending refusal for `apply_patch`/`ast_edit` (**333** reduced) + `write`/`edit` (**334** reduced) + `shell` explicit path/cwd overlap (**336** reduced); cross-session observe-pending `resourceKey` restore from durable ledger on attach (**338** reduced); fullscreen inset BLOCK banner + paths (**309** reduced); scrollback latch notice + status chip parity (**310** reduced); observe-pending per-resource inspector barrier + `BLOCK observe` chip (**342** reduced); full R170 blocking protocol **still open**.
4. **MITM / routed shell egress** — CONNECT proxy + decider + forward (**178**, **195**, **208**); netns honesty (**218**); route doctor **288** (`egress.netns.route`); parent-loopback reach probe **289** (`egress.netns.proxy`, `HZ_EGRESS_NETNS_PROXY` + endpoint); veth capability probe + doctor `egress.netns.veth` + hermetic TCP when CAP_NET_ADMIN (**299**); bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` + `ops/netns-veth-connect-probe.sh` (**315**); spawnOwned child `HTTP(S)_PROXY` remap for wrapped netns when `HZ_EGRESS_NETNS_PROXY`/`HZ_EGRESS_NETNS_PROXY_ROUTED` + bridge endpoint (**317** reduced — env wire only); spawn ROUTED + veth stack doctor `egress.netns.spawn.routed` + hermetic `attemptNetnsSpawnVethRoutedStackEgress` + `ops/netns-spawn-routed-veth-probe.sh` (**319** reduced — alongside hz-sandbox-exec, not in-wrapper); spawnOwned-wrapped CONNECT doctor `egress.netns.spawn.wrapped` + hermetic product `spawnOwned`/`hz-sandbox-exec` bridge path (**321**/**326** reduced — production `child_net=off` after parent veth join); in-wrapper CREATE+ADDR+default-route CONNECT without parent plumb doctor `egress.netns.spawn.wrapped.exec_create` + `attemptNetnsSpawnWrappedExecCreateConnectEgress` + `ops/netns-spawn-wrapped-exec-create-connect-probe.sh` (**332** reduced — hermetic when CAP/`nsenter`); hz-sandbox-exec `HZ_SANDBOX_VETH_JOIN` prepared-netns setns + doctor `egress.netns.exec.veth_join` + `ops/netns-exec-veth-join-probe.sh` (**324** reduced); spawnOwned `HZ_SANDBOX_VETH_*` wire (**325**); hz-sandbox-exec opt-in `HZ_SANDBOX_VETH_CREATE` veth pair + peer move + doctor `egress.netns.exec.veth_create` (**329** reduced); ADDR/route after CREATE (**331**); spawnOwned `HZ_SANDBOX_VETH_CREATE` + HOST/PEER/ADDR wire (**330**); TLS honesty doctor + passthrough test (**231**); optional ClientHello SNI peek on forward (**253**, **279** kernel parser + peek pipe); intercept + loadable CA → fail-closed CONNECT refuse (**281**); hermetic terminate + upstream TLS pipe when intercept/CA/terminate/forward (**283**, **285** reduced); Rust kernel loopback CONNECT listener (**234**); spawnOwned product-default ROUTED+JOIN/CREATE wire + doctor `egress.netns.spawn.product` + `doctor --fix` (**341** reduced — auto when `HZ_SANDBOX_NETNS=1`); production routed netns-only egress **still open**; never claim shell-net `enforced`.
5. **Owner LICENSE** — **DEFERRED** (owner decision; not queued for next agent). `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` (**233**); no root `LICENSE` until owner adds one.

## Explicit non-wired / SKIP (unchanged claims; ruling **252**)

- **Speculation** — opt-in wired (**670**; default-off).
- **Wave F deferred** — D-4 scheduler, provider-hosted tools, external agent subagents, §8 #17–#18 (reasons in `docs/30-steal-list.md` §7 / §8); not queued.
- **docs/30 global SKIP** — Rust TUI rewrite, Effect-TS rewrite, vendored memory MCP as core, Kitty graphics, forge hosted search / spoofed OAuth; H-6 full KDL cascade (**244** ships partial compat map only).

## Recent rulings (218–273)

| Ruling | Topic |
|---|---|
| **218** | Netns CONNECT denial honesty + doctor `egress.netns` |
| **219** | Cline `command-guard` reduced (`command-guard.ts`, plan-mode investigative shell) |
| **220** | Kernel EffectHost + literal `hz.effect.settled` / `unknown` |
| **221** | `--fullscreen` / `HZ_TUI_MODE=fullscreen` product alias (no exit 2) |
| **222** | Cache breakpoint planner (`cache-breakpoints.ts`) |
| **223** | Anthropic cache breakpoint wire |
| **224** | Durable EffectHost `effects.jsonl` + attach reconcile + `hz.effect.reconciled` |
| **225** | Fullscreen mouse hit-test + `HZ_TUI_MOUSE=1` |
| **226** | Batch-tolerant `read` via `paths[]` |
| **227** | Hold-then-swap compaction buffer (`compaction-hold.ts`, `HZ_COMPACTION_HOLD`) |
| **228** | In-history system prompt KV discipline + `appendSystemPromptUpdate` |
| **229** | `ExecutionCapability` seam (shell via `spawnOwned`) |
| **230** | §8 #14 `/autonomy` + bare `/mode` scrollback ladder |
| **231** | §5.2 `egress.tls` MITM honesty + CONNECT TLS passthrough test (advisory only) |
| **232** | Fullscreen command palette overlay (`Ctrl+P`, `/palette`) |
| **233** | `CONTEXT_WINDOW_EXCEEDED` emergency compaction + LICENSE-STATUS honesty (no root LICENSE) |
| **234** | §5.2 Rust kernel `egress.connect.listen` loopback CONNECT — advisory only |
| **235** | TUI UNKNOWN chip + live `session-kernel-reconcile` notice per batch/turn |
| **236** | Wave E D9/D11/D15/D17 scrollback folds, a11y, notify persist, clipboard + fullscreen `/copy` |
| **237** | *(reserved — Wave E peer)* |
| **238** | T-8 quirks (`drop_tool_choice`, `force_user_message`); memory MMR-lite diversify |
| **239** | Hermetic OAuth e2e; `repo_map` `symbolCursor`; tool `outputOffset` paging |
| **240** | Fullscreen `slash-dispatch` + local slash run; alt-screen composer history (D18) |
| **241** | *(reserved — Wave E peer)* |
| **242** | Memory §7 without embeddings: `HZ_CURATOR_APPLY` bank notes; `HZ_MEMORY_DREAM` `dream.md` stub |
| **243** | Kernel `effect.execute` stub + R170 in-run resource gate (TS still executes tools) |
| **247** | Fullscreen bracketed paste + `formatIdleStatusLine` + `/status` (D18 deepen) |
| **251** | Kernel `jsonl_append.rs` parent-dir fsync parity with TS `jsonl-append.ts` (F10) |
| **250** | Wave E D8 tool-card effect/receipt linkage; D10 `/theme` persist + startup load |
| **254** | Wave E D8 approval-card `effectId` / `leaseId` / `tool` linkage on guard ask |
| **252** | Wave F `deferred (SKIP)` labels in docs/30; catalog poll wire residual closed (**180**); doctor `catalog.poll` + `backlog.skip` |
| **253** | §5.2 TLS ClientHello SNI peek on CONNECT forward (`egress-tls-peek.ts`, `HZ_EGRESS_TLS_PEEK=1`) — doctor/logging only; true intercept residual |
| **256** | P0 receipt postimage double-read stability (`receipt-postimage.ts`, `loop.ts` notice + EffectHost `unknown`; fail-closed digest on receipt) |
| **257** | P0 observe evidence gate (`effect-evidence.ts`, `resultDigest` vs tool output + missing postimage → EffectHost `unknown`) |
| **260** | P0 kernel `effect.reconcile` evidence flags (`resultDigestStable`, `postimageMissing` → fail-closed `unknown`) |
| **261** | P0 live `KernelClient.reconcileEffect` after loop/attach EffectHost reconcile (TS verdict authoritative) |
| **263** | §8 #13 MCP `tools/list` cursor pagination helper + client handshake/re-list wire |
| **264** | §8 #13 MCP `resources/list` cursor pagination + `listResources`; TUI `/unknown` + status UNKNOWN list |
| **266** | §12 F11 worktree pool reduced (`worktree-pool.ts`, reuse on `--worktree`, `/worktree`, doctor); F9 mount WARN (`workspace-mount.ts`) |
| **267** | Kernel `effect.execute` sandboxed `fs.read` under caller `sandboxRoot` → `contentDigest`; mutating kinds still fail-closed |
| **275** | Kernel `effect.execute` sandboxed `fs.write` under caller `sandboxRoot` (`text`/`bytes`) → postimage `contentDigest`; unrestricted write + shell still fail-closed |
| **277** | Anthropic cache wire default `cacheableBlocksCutIndex` when `HZ_ANTHROPIC_CACHE_BREAKPOINTS=1`; kernel sandboxed `fs.edit` (single exact replace, existing file, postimage digest); unrestricted shell still fail-closed (**278** sandboxed) |
| **278** | Kernel sandboxed `shell.exec` (argv-only, cwd in root, stdout/stderr digests; NOT netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` write/edit kernel route precursor in `loop.ts` |
| **279** | Kernel fs.write/fs.edit receipt postimage double-read; TLS ClientHello SNI parse in Rust + intercept stub honesty (`HZ_EGRESS_TLS_INTERCEPT`) |
| **280** | `HZ_EFFECT_HOST_KERNEL=1` loop receipt postimage from kernel execute; argv-only `shell` kernel route; compound shell strings refused on kernel path |
| **281** | Kernel-route `recordChange` after write/edit; intercept+CA CONNECT fail-closed refuse until terminate (**283**) |
| **282** | R169 `/unknown inspect|reconcile|export` + local cache prefix measure on keep-alive + doctor `provider.cache` |
| **284** | R172 pane inspector (scrollback + fullscreen overlay) + fullscreen Tab completion stub + inset scrollback hit-test layout |
| **283** | Kernel sandbox atomic write (`sandbox_atomic_write.rs`); `HZ_EGRESS_TLS_TERMINATE=1` CONNECT terminate precursor; rustls handshake smoke in kernel |
| **285** | TLS terminate upstream re-connect pipe (`egress-tls-terminate.ts`); `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host` honesty |
| **286** | Read-only effect reconcile probe (`/unknown reconcile --probe`, doctor `effect.reconcile`); `hzcode receipt show` CLI (R172 reduced) |
| **289** | `egress.netns.proxy` reach assess + `HZ_EGRESS_NETNS_PROXY`; R172 verify pane + `verifyReceiptChainSync` (`receipt show`, `/unknown inspect`) |
| **288** | `egress.netns.route` (ambient / deny-only / proxy-env-partial) + `HZ_SANDBOX_NETNS=1`; fullscreen Ctrl+I + palette `hz://receipt/<id>` (R172 reduced) |
| **290** | docs/06 read-only fs/vcs reconcile probe enrich; scrollback Ctrl+I + `hz://receipt/<id>` + `/palette` receipt rank |
| **291** | `hzcode session verify <id>` exit 3 (chain + reconcile probe); `hzcode effect reconcile` observe-only + `--probe` CLI |
| **293** | Multi-op kernel `apply_patch` route; `HZ_EFFECT_RECONCILE_BLOCK=1` session mutating-tool gate vs full R170 |
| **302** | apply_patch `trim_both` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); ambient shell honesty under default/require |
| **303** | Multi-metavar single-match `ast_edit` kernel route; `HZ_EFFECT_RECONCILE_BLOCK=resource` path-filtered reconcile block |
| **304** | apply_patch `unicode_fold` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); R170 reconcile-block status chip + `/unknown status` |
| **294** | Session verify anchor `.head` checks + R172 child receipt pane + NOTICE provenance doctor |
| **295** | `effect-evidence-gate.ts` wired to `session verify` / `effect reconcile` exit 3; live `childEffectIds` on agent/subagent |
| **298** | RC-7 `run.complete` + `terminal.run` snapshot (cols/rows/tty, shell_session open); inspector **Terminal (run / RC-7)**; Rust `effect_evidence.rs` + fs.read observe gate |
| **327** | Kernel `fs.write`/`fs.edit` canonical success-output `resultDigest` observe + `resultDigestStable` in reconcile; loop kernel-route write/edit gate |
| **328** | Kernel `fs.delete`/`fs.rename` success-output `resultDigest` observe + apply_patch multi-op aggregated `resultDigestStable` loop gate |
| **314** | Kernel sandboxed `shell.exec` stdout/stderr double-hash observe + `resultDigestStable` wired `effect.reconcile` + loop kernel-route shell observe gate |
| **315** | Veth bridge-IP CONNECT hermetic (`attemptNetnsVethRoutedConnectEgress`, `egress-connect-proxy` `listenHost`); doctor `egress.netns.veth.routed`; `ops/netns-veth-connect-probe.sh` |
| **319** | spawn ROUTED + veth stack (`sandbox-netns-spawn-veth.ts`, doctor `egress.netns.spawn.routed`, `ops/netns-spawn-routed-veth-probe.sh`) — alongside hz-sandbox-exec; never enforced |
| **321** | spawnOwned wrapped CONNECT (`sandbox-netns-spawn-wrapped-connect.ts`, doctor `egress.netns.spawn.wrapped`, `ops/netns-spawn-wrapped-connect-probe.sh`) — product-runtime hermetic; in-wrapper veth open; never enforced |
| **323** | `classifyApplyPatchKernelProjectionMiss` + named require refusals (`bun_fuzz_only`, `shape_ineligible`, …) for `apply_patch` under `HZ_EFFECT_HOST_KERNEL=require` |
| **326** | product `child_net=off` CONNECT via bridge after parent veth join (`attemptNetnsSpawnWrappedProductConnectEgress` **326**, doctor `egress.netns.spawn.wrapped`, `ops/netns-spawn-wrapped-connect-probe.sh`) — in-wrapper veth create still open; never enforced |
| **325** | spawnOwned `mergeSandboxExecVethJoinSpawnEnv` wires `HZ_SANDBOX_VETH_JOIN`/`NETNS` (AUTO→`hz-veth-reach-ns`) for wrapped children only |
| **330** | spawnOwned `mergeSandboxExecVethCreateSpawnEnv` wires `HZ_SANDBOX_VETH_CREATE` + optional HOST/PEER for wrapped children; mutex spawn-wiring with JOIN (**325**); doctor `egress.netns.exec.veth_create` spawn hint |
| **332** | spawnOwned in-wrapper CREATE+ADDR+default-route CONNECT (`sandbox-netns-spawn-wrapped-exec-create-connect.ts`, doctor `egress.netns.spawn.wrapped.exec_create`, `ops/netns-spawn-wrapped-exec-create-connect-probe.sh`) — no parent plumb; never enforced |
| **341** | spawnOwned product-default ROUTED+JOIN/CREATE wire (`sandbox-netns-spawn-product-default.ts`, doctor `egress.netns.spawn.product`, `doctor --fix`) — auto when `HZ_SANDBOX_NETNS=1`; never enforced |
| **331** | hz-sandbox-exec ADDR/route after CREATE (`HZ_SANDBOX_VETH_HOST_ADDR`, `HZ_SANDBOX_VETH_PEER_ADDR`, `HZ_SANDBOX_VETH_DEFAULT_ROUTE_*`) — fail-closed ADDR without CREATE; spawn ADDR pass-through on **330** merge; never enforced |
| **329** | hz-sandbox-exec `HZ_SANDBOX_VETH_CREATE` (`sandbox_veth_netlink.rs`, `sandbox-exec-veth-create.ts`, doctor `egress.netns.exec.veth_create`, `ops/netns-exec-veth-create-probe.sh`) — opt-in create+peer move fail-closed; bridge/route (**331** reduced); never enforced |
| **324** | hz-sandbox-exec `HZ_SANDBOX_VETH_JOIN` + `HZ_SANDBOX_VETH_NETNS` (`hz_sandbox_exec.rs`, `sandbox-exec-veth-join.ts`, doctor `egress.netns.exec.veth_join`, `ops/netns-exec-veth-join-probe.sh`) — prepared netns join fail-closed; never enforced |
| **320** | Variadic `$$$` `ast_edit` unique-projection kernel route + doctor honesty; P0 `effect.postimage.replay` `ast_edit` scope |
| **339** | EffectHost kernel `fs.edit` per-line unicode-fold repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust `edit_unicode_fold.rs` after **337** trim; doctor residual |
| **337** | EffectHost kernel `fs.edit` per-line `trim` repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust after **335** trimEnd; doctor residual |
| **335** | EffectHost kernel `fs.edit` per-line `trimEnd` repair rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) — TS + Rust; doctor `--fix effect.host` hint |
| **340** | Product spine: `createRuntime` applies `HZ_EFFECT_HOST_KERNEL=default` on Linux when sandbox wrap active (env unset); user config `effectHostKernel`; doctor still reports off; named shell require refusals under `=require` |
| **540** | Product spine: trusted Rust kernel + Linux + env unset → `HZ_EFFECT_HOST_KERNEL=require` (prefers over sandbox `=default`); explicit env/config preserved; doctor honesty without projecting require |
| **541** | C-11: `HZ_THINKING_CALIBRATED=1` wires local calibrated estimate into `resolveThinkingEffort` (`auto-calibrated`); empirical fit still OPEN |
| **694** | C-11: `HZ_THINKING_LIVE_JUDGE=1` weak-model tier + fail-closed local fallback (`auto-live-judge`) |
| **338** | Cross-session observe-pending hydrate — durable `effects.jsonl` execute `resourceKey` + `tool.call` backfill on attach so `HZ_EFFECT_RECONCILE_BLOCK` gates survive reload without false settle |
| **336** | R170 reconcile-block observe-pending — `shell`/`bash` blocked when explicit `path`/`file`/`file_path` or `cwd` overlaps observe-pending resource under `HZ_EFFECT_RECONCILE_BLOCK` (no default cwd) |
| **334** | R170 reconcile-block observe-pending — `write`/`edit`/`multi_edit` blocked until observe on overlapping path; `shell` only when postimage path resolves (**333** slice for patch tools) |
| **342** | R170 observe-pending per-resource inspector barrier — latch view drivers, `BLOCK observe` chip, scrollback + fullscreen inset, `/unknown status`/`list` lines |
| **333** | R170 `HZ_EFFECT_RECONCILE_BLOCK` observe-pending gate — `apply_patch`/`ast_edit` blocked until receipt observe on same path; execute-step `resourceKey` on EffectHost |
| **478** | R172 nested child event-stream replay from verified parent read (inspector + `session verify` exit 3) |
| **456** | R172 nested receipt-graph replay from one verified snapshot (inspector + `session verify` exit 3) |
| **322** | R172 `agent.spawn` child session stream summary on receipt inspector; `ast_edit` multi-match named refusal under `HZ_EFFECT_HOST_KERNEL=require` |
| **318** | Grok overlay↔overlay `encodeFullscreenConsecutiveFrameDiff` soft transition; R170 in-run gate `ast_edit` + UNKNOWN driver effect id on refusal |
| **316** | R170 per-resource dependency explain (`/unknown status`, `/unknown release` refusal); Grok main↔overlay `encodeFullscreenConsecutiveFrameDiff` soft transition |
| **317** | spawnOwned routed CONNECT proxy env (`HZ_EGRESS_NETNS_PROXY_ROUTED`, `HZ_EGRESS_NETNS_BRIDGE_HOST`, `mergeNetnsEgressProxySpawnEnv` + wrapped-only); doctor `egress.netns.proxy` spawn honesty |
| **313** | apply_patch first-hit score fuzz honesty (`classifyApplyPatchScoreMatchPolicy` + doctor residual); modal overlay mouse backdrop dismiss (`dismiss_modal_overlay` + live wire); prototype `effectHostPrototypeHonestyDoctorHint` (`=require` under `default`) |
| **312** | Live fullscreen modal overlay mouse path (`fullscreenModalOverlayHitOpts` + `handleMouseChunk`); `doctor --fix effect.host` `HZ_EFFECT_HOST_EDIT_REPAIR=1` (dominant score rung) |
| **311** | apply_patch `dominant_score` kernel fuzz rung (≥0.97, Δ0.08) + hit-test `hitTestCacheAfterResize` / completion overlay region (Grok R11/R6 reduced) |
| **310** | Fullscreen overlay same-kind `encodeFullscreenConsecutiveFrameDiff` (palette/picker/inspector/completion); scrollback reconcile-block notice + BLOCK chip refresh |
| **309** | Fullscreen inset reconcile-block banner (`BLOCK mutate`/`BLOCK resource`, status + blocked paths) when latch active |
| **308** | apply_patch `line_patch` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`); live `fullscreen-chat` main `paint()` differential encoding |
| **307** | R170 `/unknown` list blocked resource paths + `/unknown release`; apply_patch `relative_indent` kernel fuzz rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) |
| **306** | apply_patch unique max-score Levenshtein kernel rung (`HZ_EFFECT_HOST_EDIT_REPAIR`) + fullscreen inset Alt+↑/↓ / PgUp/PgDn keyboard scroll |
| **305** | Inset pane independent wheel scroll (`insetScrollUp` vs main `scrollUp`; `scrollback_pane` hit-test) — ruling **300** deepen |
| **300** | Fullscreen live inset pane **Ctrl+B** (`fullscreen-inset-pane.ts`, UNKNOWN/buried transcript); EOF-anchored unique exact `apply_patch` → kernel `fs.edit`; doctor `effect.host` EOF residual |
| **299** | `HZ_EFFECT_HOST_KERNEL=default` + `doctor --fix effect.host`; same-file multi-chunk exact `apply_patch` → ordered kernel `fs.edit`; apply_patch trimEnd (`HZ_EFFECT_HOST_EDIT_REPAIR`); `egress.netns.veth` CAP probe + hermetic veth TCP; Grok inset pane paint stub |
| **292** | docs/06 `terminal.run` read-only argv allow-list probes + doctor `terminal.state`; R172 shell **Terminal (process)** pane (effect process exit only) |
| **287** | Kernel-route eligible `apply_patch`/`ast_edit` projection; `HZ_EFFECT_HOST_EDIT_REPAIR=1` reduced fs.edit repair (Rust + LocalKernel) |
| **268** | §12 F4 `.hzs` export (`archive.ts`, `session export`, `/export hzs`); F2/F3 docs status honesty |
| **269** | §12 F5 `session-migrate.ts` (`user_version` 1, `projection_watermark` stub); F6 admission on `send` + `tool-batch-fifo.ts` scheduler |
| **270** | §12 F1 workspace snapshot refuse (`workspace-snapshot.ts`, doctor, `/snapshot`) |
| **271** | §12 F7 blob CAS reduced (`blobs.ts`, `HZ_BLOB_SPILL=1` spill route) |
| **272** | Local `verifyReceipts` strips `effectId`/`postimage*` before hash recompute (`kernel.ts`; parity issue + Rust) |
| **273** | Trusted `effect.execute` fs.read + `effect.reconcile` evidence on Rust; session FTS BM25+recency rank; F3 `permission_mode` + fork meet |

## Where to work next

1. [`docs/HANDOFF-BACKLOG-2026-11-13.md`](HANDOFF-BACKLOG-2026-11-13.md) — execution queue and P0 **done bars**  
2. `docs/MASTER-BACKLOG-ALL.md` — consolidated matrix  
3. `docs/research/steal-little-coder-aider.md` — local-model + git steal queue (not implemented)

**Working tree:** rulings **315–342** and research pins may exist only as **uncommitted** local changes — verify with `git status` before citing VERIFIED levels.

Do not mark the overall goal complete until P0 §1 done bars in the handoff doc are proven (LICENSE excluded this sprint).
