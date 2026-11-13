# Goal progress — HorizonCode prototype honesty

> **Overall goal: NOT COMPLETE** (2026-11-13). The vertical slice is real and was gates-green in the historical 2026-11-10 build; on the current WSL host, sandbox-exec gates are blocked by EPERM and the full Bun suite has additional failures. The prototype trust spine and several steal-wave targets remain open.
>
> **Next agent:** [`../AGENTS.md`](../AGENTS.md) → [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md). **LICENSE deferred** — [`LICENSE-STATUS.md`](LICENSE-STATUS.md).
>
> Authoritative levels: `docs/28-implementation-status.md` §3 (through ruling **347**). Wave matrix: `docs/MASTER-BACKLOG-ALL.md`. Build/run: `docs/33-handoff.md`.

## Wave summary (honest)

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **0** | Honesty + spine precursors | **PARTIAL — TESTED** (rulings **174b**, **224**, **235**, **243**, **251**, **256**, **257**, **260**, **261**, **264**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **289**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **305**, **306**, **307**, **308**, **309**, **310**, **311**, **312**, **313**, **314**, **315**, **316**, **317**, **318**, **319**, **320**, **322**, **324**, **325**, **326**, **327**, **328**, **329**, **330**, **331**, **332**, **333**, **334**, **335**, **336**, **337**, **338**, **339**, **340**, **341**, **342**, **343**, **344**, **345**) | RC-18 event map (23 shipped), JSONL fsync + kernel/TS parent-dir parity (**251**), receipt postimage + independent double-read stability (**256** TS + **279** kernel execute) + observe evidence gate (**257**), kernel `effect.reconcile` evidence flags (**260**) + live loop/attach wire (**261**), `session-kernel-reconcile` + effectId pairing + live turn/batch notice, durable `effects.jsonl` + attach reconcile + `hz.effect.reconciled`, TUI UNKNOWN chip + `/unknown` inspect/reconcile/export (**235**, **264**, **282**), R172 structured receipt panes + fullscreen inspect overlay (**284** reduced), kernel `effect.execute` stub + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` under caller `sandboxRoot` (**243**, **267**, **275**, **277**, **278**; argv-only shell, not netns/Landlock), `HZ_EFFECT_HOST_KERNEL=1` write/edit/shell/ eligible apply_patch/ast_edit kernel route + loop receipt postimage (**280**, **287**) + change-journal record after kernel write/edit (**281**); reduced kernel fs.edit repair opt-in (**287**); TLS upstream pipe (**285**) + `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host`. Residual: unrestricted Bun `shell` by default + full EffectHost; full R172 (RC-7, verify chain, all entry points). |
| **A–D** | Trust, sandbox, steal §8 #11–#15, provider failure codes | **PARTIAL** | Linux `hz-sandbox-exec` TESTED; OAuth hermetic e2e + credentials SQLite (**239**); `symbolCursor` + `outputOffset` paging (**239**); MCP `tools/list` + `resources/list` cursor passthrough (**263**, **264**); speculation **UNWIRED** (ruling **65**). |
| **E** | TUI scrollback + alt-screen slices | **PARTIAL — TESTED** | Scrollback polish (**177**, **236** D9/D11/D15/D17); reduced fullscreen (**193**, **221**); mouse opt-in (**225**); fullscreen palette (**232**); in-loop slash dispatch (**240**); composer ↑/↓ history (**240** D18); fullscreen `/copy` (**236**); fullscreen bracketed paste + shared idle status (**247**); tool-card + approval-card effect linkage + `/theme` persist/load (**250**, **254** D8/D10); plan multi-file hunk labels/apply + screen-reader effect/approval lines (**255** D7/D11); fullscreen rich approval card (**258**); UNKNOWN R169 actions reduced (**282**: inspect/reconcile/export); R172 pane inspector + fullscreen Tab completion stub + inset scrollback hit region (**284**); scrollback Ctrl+I + `hz://receipt/<id>` + palette rank (**290**); inset pane buffer paint + `encodeFullscreenFrameDiff` stub (**299** reduced); live inset pane wire (**300**: Ctrl+B, UNKNOWN/buried transcript); inset wheel scroll independence (**305** reduced); inset keyboard scroll (**306** reduced: Alt+↑/↓, PgUp/PgDn); live main-loop differential R8 paint (**308** reduced: consecutive frames); reconcile-block inset banner when latched (**309** reduced); overlay same-kind differential paint + scrollback BLOCK notice/paths (**310** reduced); main↔overlay soft-transition paint (**316** reduced); overlay↔overlay soft-transition paint (**317** reduced); live modal overlay mouse hit-test when picker/palette/inspector/completion open (**312** reduced); modal backdrop click dismiss (**313** reduced). Grok R1–R12 parity **open** (R2/R4/R9–R12). |
| **G–J** | docs/30 §7 + docs/12 §11 backlog reductions | **PARTIAL — TESTED** (rulings **266**, **268**–**271**, **273**) | §12: F11 worktree pool + F9 mount (**266**); F4 `.hzs` export (**268**); F5 migration stub + F6 admission/FIFO (**269**); F1 snapshot refuse (**270**); F7 blob CAS (**271**); F8 session FTS recency tie-break (**273**); F3 `permission_mode` row + fork meet reduced (**273**). docs/30 §7: many rows reduced; Wave F **SKIP** only (**252**). |
| **I/J** | B-4 cache | **PARTIAL — TESTED** (rulings **200**, **222**, **223**, **246**, **276**, **277**, **282**) | System marker + breakpoint planner + Anthropic wire (default largest-prefix when breakpoints on) + `cacheableMessagesPrefix` + keep-alive stub with **local** prefix byte/message measure on tick (**282**); doctor `provider.cache`. Residual: live Anthropic cache-hit measure (API keys). |

## P0 Batch 4 partials + end-to-end baseline audit (ruling **347**)

- **Kernel edit parity reduced:** opt-in `fs.edit` now reindents replacement for uniquely matching per-line trim/three-way-style windows, and falls back to unique first/last nonblank equal-length line-patch anchors. Both Rust and TypeScript refuse ambiguous anchors. Trusted Rust kernel E2E checks disk bytes, stable receipt/postimage evidence and refusal without mutation. **Still OPEN:** general merge/patch parity, exact pre-read guarantees for kernel edits, first-hit fuzz and universal EffectHost ownership.
- **Tool entrypoint security:** `lint` now has a loop `fs.read` admission; `present` is session-state with its own per-file read admission. Configured lint shell commands require explicit `shell.exec` guard and approval before spawning. Tests cover denial with no side effects. This closes a specific bypass, **not** every tool entrypoint or process effect.
- **Traceability:** generated `BACKLOG-TRACEABILITY-2026-11-13.md` from the authoritative register and upstream TAKE rows (47 main OPEN, 16 repo-take partial, 44 source-specific partial, 15 checklist items; overlap acknowledged). This is an index of claimed/code-linked coverage, **not** proof of universal verification.
- **Baseline audit (before this local admission/schema repair):** complete Bun suite **2,723 pass / 49 fail / 3 skip** across 390 files; TypeScript typecheck PASS; Rust kernel 114 unit PASS with one long test filtered; Rust integration 58 PASS after ruling 347; full cargo fmt FAIL from broad drift; `timeout 120 bash ops/gates.sh` exit 124 in slow `rust-kernel-suite` before later gates. Final targeted bundle **287 pass / 0 fail** across 37 files. Isolated registry/config/tool-fixture failures are fixed and retested; multiple skill, TUI, PTY and other failures remain. `unshare -n` EPERM and Docker daemon unavailable on this WSL host; routed shell-net E2E **not proven**. Details: [P0 audit](audit/p0-effecthost-baseline-2026-11-13.md).
- **Overall:** P0-1 to P0-4, R170, R172, RC-18 and patch/session consistency are **NOT COMPLETE**. No shell-net `enforced` claim.

## Batch 3 delivered (rulings **345–346**, opt-in edit parity + J-2 selectors)

- **P0 kernel `fs.edit` parity:** Rust `effect_host_edit_repair.rs` and TypeScript LocalKernel resolve uniquely matching relative-indent blocks when `HZ_EFFECT_HOST_EDIT_REPAIR=1`; new text reindents against the matched file block while preserving CRLF. Exact/off-mode and ambiguity refusals remain. The Rust newline-span offset mapper also no longer panics when its scan crosses a multibyte UTF-8 codepoint; trusted-kernel fs.edit E2E verifies disk bytes and postimage digest.
- **J-2 batch subset controls:** `--filter text`, `--shuffle [seed]`, `--slice start:end` now work for batch status/dry-run. Selection is deterministic over all rows before resume omits done/failed; invalid ranges fail loudly and an empty selection does not masquerade as a completed batch.
- **Still open (after ruling 347's reduced unique trim/anchor repair):** full/general Rust kernel merge and line patch parity, first-hit fuzz and read-before-edit proof; all mutation classes executing/observing in the kernel; J-2 per-row execution, runner-config snapshot and cancellation/drain. No change to overall prototype **NOT COMPLETE** status.

## Batch 2 delivered (ruling **344**, opt-in R170 continuity only)

- New `reconcile-latches.jsonl` under kernel state preserves session/resource latch transitions across runtime restarts. End-of-turn clean assessments no longer silently release a latch; only explicit clean reconciliation does. Unscoped latches cannot be narrowed by later path-scoped evidence.
- First mutator admission assesses unpaired/UNKNOWN evidence and latches immediately. Read-only tools still work under a latch; unclassified built-in/MCP effects fail closed in opt-in gate modes.
- Arbitrary shell is refused while observe is pending or a resource latch is active, even with an apparently disjoint cwd (shell path hints are not proof). Resource latches refuse unknown targets. Multi-file `apply_patch` checks every projected mutation target, including rename source and destination, in the latch, observe-pending, and in-run UNKNOWN gates.
- Existing symlink aliases now resolve against blocked paths before overlap checks. **Still open:** hardlink/dangling-symlink races, default-on enforcement, Rust-owned tamper-evident latch OwnerLog, atomic cross-process admit/observe fencing, and universal execution/receipt independence. Full R170 remains **PARTIAL**, not shipped or enforced globally.

## Batch 1 delivered (ruling **343**, still a partial P0 slice)

- Cross-session attach hydrates newly persisted unknown effects and preserves locally unsafe observations. Explicit foreign effect IDs no longer pair through a reused call ID.
- The direct commit-shell, staged apply, and file rewind entry points now refuse unproven mutations in strict kernel mode and honor applicable reconcile barriers. Unknown tools and MCP effect paths default to refusal in strict mode rather than ambient execution.
- `doctor effect.host` reflects user-configured mode and environment precedence, with Linux sandbox auto-default marked as provisional. The test helper now restores EffectHost flags to prevent cross-suite environment leakage.
- **Still open:** universal Rust-owned effect execution and independent observation, full R170 latch semantics, kernel editing parity, and routed network enforcement. No claim of full completion or release.

## P0 residuals (prototype honesty — still open)

1. **EffectHost durable ledger** — **PARTIAL — TESTED** (**220**, **224**, **235**, **243**, **261**, **264**, **267**, **275**, **277**, **278**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **304**, **306**, **307**, **309**, **308**, **311**, **312**, **313**, **314**, **320**, **322**, **327** `HZ_EFFECT_HOST_KERNEL=default`, same-file multi-chunk apply_patch, apply_patch trimEnd/trim (3-way)/unicode-fold/line-patch/dominant-score/unique Levenshtein rungs, EOF exact unique kernel route, ambient shell honesty, `doctor --fix effect.host`): in-run TS + kernel reconcile mirror + `hz.effect.settled`/`unknown`; durable `effects.jsonl` + attach observe-only reconcile + `hz.effect.reconciled`; scrollback/fullscreen UNKNOWN chip + `/unknown` inspect/reconcile/export (**282** reduced R169); R172 structured panes + fullscreen inspect overlay (**284** reduced); kernel `effect.execute` fail-closed for unrestricted mutating kinds except hermetic `pure`/`echo` + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` (caller `sandboxRoot`; shell argv-only, advisory not netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` routes eligible write/edit/shell + reduced sequential Add/exact-Update/Delete/exact-Move `apply_patch`/metavar `ast_edit` (incl. unique-projection variadic `$$$`, **320**) via kernel (**293** multi-op; **296** delete; **297** rename/Move; **302** multi-metavar when unique); `HZ_EFFECT_HOST_KERNEL=require` refuses Bun-owned mutations that cannot kernel-route (**285**, **287** deepen); doctor `effect.host` (**285**); change-journal after kernel write/edit/delete/rename (**281**, **296**, **297**); optional kernel `fs.edit` trim/newline repair (`HZ_EFFECT_HOST_EDIT_REPAIR=1`, **287** reduced vs `edit.ts` ladder). Bun still owns ambient `shell` and default write/edit when unset (doctor); **340** `createRuntime` may apply `=default` on Linux when sandbox wrap active or from config `effectHostKernel` — not full EffectHost. R170 same-path write/edit block in-run. `HZ_EFFECT_RECONCILE_BLOCK=1` session gate + `=resource` path-filtered precursor (**303** reduced vs R170 per-resource). `HZ_EFFECT_HOST_KERNEL=default` prototype routes like `=1` (**299**); `=require` honesty gate. **Still open:** full EffectHost + kernel owns all mutations; cross-file/ambiguous/tied-subthreshold apply_patch fuzz (unique Levenshtein ≥0.66 on kernel **306** reduced; Bun first-hit score fuzz intentionally Bun-only per **313**) + multi-match variadic `ast_edit` on Bun — under `=require` named refusal when projection miss (**322**); full edit repair ladder on kernel path; per-effect docs/06 terminal argv re-probe (**292** workspace allow-list + doctor `terminal.state` only); full R172 (RC-7 **run** terminal; **292** shell **process** pane; **322** `agent.spawn` + child session JSONL summary; nested stream verify open).
2. **Independent receipt postimage** — **PARTIAL — TESTED** (**174b**, **256**, **257**, **260**, **261**, **272**, **279**, **280**, **297**, **301**, **314**, **320**, **327**, **328**): additive write/edit postimage + independent double-read stability (mismatch → effect `unknown` + notice; unstable digest omitted from receipt); observe-time `resultDigest` vs tool-output digest + missing postimage → `unknown` (**257**); kernel `effect.reconcile` accepts the same evidence bools (**260**) + `postimageObservationStable` (**279**); kernel `effect.execute` fs.write/fs.edit double-read (**279**) + kernel-route write/edit/delete/rename `resultDigestStable` (**327**/**328**; **314** shell); multi-op `apply_patch` aggregated kernel-route `resultDigest` loop gate (**328**); local `verifyReceipts` strips `effectId`/`postimage*` before hash recompute (**272**); loop receipt issuance uses kernel postimage when `HZ_EFFECT_HOST_KERNEL=1` (**280**); opt-in `HZ_VERIFY_POSTIMAGE_REPLAY=1` independent digest replay at session verify / effect reconcile (**297**); doctor `effect.postimage.replay` + require-auto replay (**301**) + explicit `ast_edit`/`$$$` kernel-route replay scope honesty (**320**). Residual: full Rust EffectHost owns observe for all tools; replay off by default without require.
3. **Session ↔ kernel reconciliation** — **PARTIAL** — unpaired report + effectId pairing (**174b**, **224**); live batch/turn notice (**235**); opt-in session block gate + `=resource` path filter (**293**, **303**); reconcile-block status chip + `/unknown status` (**304**); list blocked paths + `/unknown release` (**307** reduced); per-resource dependency lines on status/release (**316** reduced); in-run same-path gate `ast_edit` + driving effect hint (**318** reduced); `HZ_EFFECT_RECONCILE_BLOCK` observe-pending refusal for `apply_patch`/`ast_edit` (**333** reduced) + `write`/`edit` (**334** reduced) + `shell` explicit path/cwd overlap (**336** reduced); cross-session observe-pending `resourceKey` restore from durable ledger on attach (**338** reduced); fullscreen inset BLOCK banner + paths (**309** reduced); scrollback latch notice + status chip parity (**310** reduced); observe-pending per-resource inspector barrier + `BLOCK observe` chip (**342** reduced); full R170 blocking protocol **still open**.
4. **MITM / routed shell egress** — CONNECT proxy + decider + forward (**178**, **195**, **208**); netns honesty (**218**); route doctor **288** (`egress.netns.route`); parent-loopback reach probe **289** (`egress.netns.proxy`, `HZ_EGRESS_NETNS_PROXY` + endpoint); veth capability probe + doctor `egress.netns.veth` + hermetic TCP when CAP_NET_ADMIN (**299**); bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` + `ops/netns-veth-connect-probe.sh` (**315**); spawnOwned child `HTTP(S)_PROXY` remap for wrapped netns when `HZ_EGRESS_NETNS_PROXY`/`HZ_EGRESS_NETNS_PROXY_ROUTED` + bridge endpoint (**317** reduced — env wire only); spawn ROUTED + veth stack doctor `egress.netns.spawn.routed` + hermetic `attemptNetnsSpawnVethRoutedStackEgress` + `ops/netns-spawn-routed-veth-probe.sh` (**319** reduced — alongside hz-sandbox-exec, not in-wrapper); spawnOwned-wrapped CONNECT doctor `egress.netns.spawn.wrapped` + hermetic product `spawnOwned`/`hz-sandbox-exec` bridge path (**321**/**326** reduced — production `child_net=off` after parent veth join); in-wrapper CREATE+ADDR+default-route CONNECT without parent plumb doctor `egress.netns.spawn.wrapped.exec_create` + `attemptNetnsSpawnWrappedExecCreateConnectEgress` + `ops/netns-spawn-wrapped-exec-create-connect-probe.sh` (**332** reduced — hermetic when CAP/`nsenter`); hz-sandbox-exec `HZ_SANDBOX_VETH_JOIN` prepared-netns setns + doctor `egress.netns.exec.veth_join` + `ops/netns-exec-veth-join-probe.sh` (**324** reduced); spawnOwned `HZ_SANDBOX_VETH_*` wire (**325**); hz-sandbox-exec opt-in `HZ_SANDBOX_VETH_CREATE` veth pair + peer move + doctor `egress.netns.exec.veth_create` (**329** reduced); ADDR/route after CREATE (**331**); spawnOwned `HZ_SANDBOX_VETH_CREATE` + HOST/PEER/ADDR wire (**330**); TLS honesty doctor + passthrough test (**231**); optional ClientHello SNI peek on forward (**253**, **279** kernel parser + peek pipe); intercept + loadable CA → fail-closed CONNECT refuse (**281**); hermetic terminate + upstream TLS pipe when intercept/CA/terminate/forward (**283**, **285** reduced); Rust kernel loopback CONNECT listener (**234**); spawnOwned product-default ROUTED+JOIN/CREATE wire + doctor `egress.netns.spawn.product` + `doctor --fix` (**341** reduced — auto when `HZ_SANDBOX_NETNS=1`); production routed netns-only egress **still open**; never claim shell-net `enforced`.
5. **Owner LICENSE** — **DEFERRED** (owner decision; not queued for next agent). `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` (**233**); no root `LICENSE` until owner adds one.

## Explicit non-wired / SKIP (unchanged claims; ruling **252**)

- **Speculation** — UNWIRED per ruling **65** (wave D honesty).
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
| **338** | Cross-session observe-pending hydrate — durable `effects.jsonl` execute `resourceKey` + `tool.call` backfill on attach so `HZ_EFFECT_RECONCILE_BLOCK` gates survive reload without false settle |
| **336** | R170 reconcile-block observe-pending — `shell`/`bash` blocked when explicit `path`/`file`/`file_path` or `cwd` overlaps observe-pending resource under `HZ_EFFECT_RECONCILE_BLOCK` (no default cwd) |
| **334** | R170 reconcile-block observe-pending — `write`/`edit`/`multi_edit` blocked until observe on overlapping path; `shell` only when postimage path resolves (**333** slice for patch tools) |
| **342** | R170 observe-pending per-resource inspector barrier — latch view drivers, `BLOCK observe` chip, scrollback + fullscreen inset, `/unknown status`/`list` lines |
| **333** | R170 `HZ_EFFECT_RECONCILE_BLOCK` observe-pending gate — `apply_patch`/`ast_edit` blocked until receipt observe on same path; execute-step `resourceKey` on EffectHost |
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
