# Goal progress — HorizonCode prototype honesty

> **Overall goal: NOT COMPLETE** (2026-11-13). The vertical slice is real and gates-green; the prototype trust spine and several steal-wave targets remain open.
>
> Authoritative levels: `docs/28-implementation-status.md`. Handoff priorities: `docs/33-handoff.md`.

## Wave summary (honest)

| Wave | Scope | Status | Notes |
|---|---|---|---|
| **0** | Honesty + spine precursors | **PARTIAL — TESTED** (rulings **174b**, **224**, **235**, **243**, **251**, **256**, **257**, **260**, **261**, **264**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **289**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **305**, **306**, **307**, **308**, **309**, **310**, **311**, **312**, **313**, **314**, **315**, **316**, **317**, **318**, **319**, **320**, **322**) | RC-18 event map (23 shipped), JSONL fsync + kernel/TS parent-dir parity (**251**), receipt postimage + independent double-read stability (**256** TS + **279** kernel execute) + observe evidence gate (**257**), kernel `effect.reconcile` evidence flags (**260**) + live loop/attach wire (**261**), `session-kernel-reconcile` + effectId pairing + live turn/batch notice, durable `effects.jsonl` + attach reconcile + `hz.effect.reconciled`, TUI UNKNOWN chip + `/unknown` inspect/reconcile/export (**235**, **264**, **282**), R172 structured receipt panes + fullscreen inspect overlay (**284** reduced), kernel `effect.execute` stub + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` under caller `sandboxRoot` (**243**, **267**, **275**, **277**, **278**; argv-only shell, not netns/Landlock), `HZ_EFFECT_HOST_KERNEL=1` write/edit/shell/ eligible apply_patch/ast_edit kernel route + loop receipt postimage (**280**, **287**) + change-journal record after kernel write/edit (**281**); reduced kernel fs.edit repair opt-in (**287**); TLS upstream pipe (**285**) + `HZ_EFFECT_HOST_KERNEL=require` + doctor `effect.host`. Residual: unrestricted Bun `shell` by default + full EffectHost; full R172 (RC-7, verify chain, all entry points). |
| **A–D** | Trust, sandbox, steal §8 #11–#15, provider failure codes | **PARTIAL** | Linux `hz-sandbox-exec` TESTED; OAuth hermetic e2e + credentials SQLite (**239**); `symbolCursor` + `outputOffset` paging (**239**); MCP `tools/list` + `resources/list` cursor passthrough (**263**, **264**); speculation **UNWIRED** (ruling **65**). |
| **E** | TUI scrollback + alt-screen slices | **PARTIAL — TESTED** | Scrollback polish (**177**, **236** D9/D11/D15/D17); reduced fullscreen (**193**, **221**); mouse opt-in (**225**); fullscreen palette (**232**); in-loop slash dispatch (**240**); composer ↑/↓ history (**240** D18); fullscreen `/copy` (**236**); fullscreen bracketed paste + shared idle status (**247**); tool-card + approval-card effect linkage + `/theme` persist/load (**250**, **254** D8/D10); plan multi-file hunk labels/apply + screen-reader effect/approval lines (**255** D7/D11); fullscreen rich approval card (**258**); UNKNOWN R169 actions reduced (**282**: inspect/reconcile/export); R172 pane inspector + fullscreen Tab completion stub + inset scrollback hit region (**284**); scrollback Ctrl+I + `hz://receipt/<id>` + palette rank (**290**); inset pane buffer paint + `encodeFullscreenFrameDiff` stub (**299** reduced); live inset pane wire (**300**: Ctrl+B, UNKNOWN/buried transcript); inset wheel scroll independence (**305** reduced); inset keyboard scroll (**306** reduced: Alt+↑/↓, PgUp/PgDn); live main-loop differential R8 paint (**308** reduced: consecutive frames); reconcile-block inset banner when latched (**309** reduced); overlay same-kind differential paint + scrollback BLOCK notice/paths (**310** reduced); main↔overlay soft-transition paint (**316** reduced); overlay↔overlay soft-transition paint (**317** reduced); live modal overlay mouse hit-test when picker/palette/inspector/completion open (**312** reduced); modal backdrop click dismiss (**313** reduced). Grok R1–R12 parity **open** (R2/R4/R9–R12). |
| **G–J** | docs/30 §7 + docs/12 §11 backlog reductions | **PARTIAL — TESTED** (rulings **266**, **268**–**271**, **273**) | §12: F11 worktree pool + F9 mount (**266**); F4 `.hzs` export (**268**); F5 migration stub + F6 admission/FIFO (**269**); F1 snapshot refuse (**270**); F7 blob CAS (**271**); F8 session FTS recency tie-break (**273**); F3 `permission_mode` row + fork meet reduced (**273**). docs/30 §7: many rows reduced; Wave F **SKIP** only (**252**). |
| **I/J** | B-4 cache | **PARTIAL — TESTED** (rulings **200**, **222**, **223**, **246**, **276**, **277**, **282**) | System marker + breakpoint planner + Anthropic wire (default largest-prefix when breakpoints on) + `cacheableMessagesPrefix` + keep-alive stub with **local** prefix byte/message measure on tick (**282**); doctor `provider.cache`. Residual: live Anthropic cache-hit measure (API keys). |

## P0 residuals (prototype honesty — still open)

1. **EffectHost durable ledger** — **PARTIAL — TESTED** (**220**, **224**, **235**, **243**, **261**, **264**, **267**, **275**, **277**, **278**, **280**, **281**, **282**, **283**, **284**, **285**, **286**, **287**, **290**, **291**, **292**, **293**, **294**, **295**, **296**, **297**, **298**, **299**, **300**, **301**, **302**, **303**, **304**, **306**, **307**, **309**, **308**, **311**, **312**, **313**, **314**, **320**, **322** `HZ_EFFECT_HOST_KERNEL=default`, same-file multi-chunk apply_patch, apply_patch trimEnd/trim (3-way)/unicode-fold/line-patch/dominant-score/unique Levenshtein rungs, EOF exact unique kernel route, ambient shell honesty, `doctor --fix effect.host`): in-run TS + kernel reconcile mirror + `hz.effect.settled`/`unknown`; durable `effects.jsonl` + attach observe-only reconcile + `hz.effect.reconciled`; scrollback/fullscreen UNKNOWN chip + `/unknown` inspect/reconcile/export (**282** reduced R169); R172 structured panes + fullscreen inspect overlay (**284** reduced); kernel `effect.execute` fail-closed for unrestricted mutating kinds except hermetic `pure`/`echo` + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` (caller `sandboxRoot`; shell argv-only, advisory not netns/Landlock); `HZ_EFFECT_HOST_KERNEL=1` routes eligible write/edit/shell + reduced sequential Add/exact-Update/Delete/exact-Move `apply_patch`/metavar `ast_edit` (incl. unique-projection variadic `$$$`, **320**) via kernel (**293** multi-op; **296** delete; **297** rename/Move; **302** multi-metavar when unique); `HZ_EFFECT_HOST_KERNEL=require` refuses Bun-owned mutations that cannot kernel-route (**285**, **287** deepen); doctor `effect.host` (**285**); change-journal after kernel write/edit/delete/rename (**281**, **296**, **297**); optional kernel `fs.edit` trim/newline repair (`HZ_EFFECT_HOST_EDIT_REPAIR=1`, **287** reduced vs `edit.ts` ladder). Bun still owns ambient `shell` and default write/edit when unset. R170 same-path write/edit block in-run. `HZ_EFFECT_RECONCILE_BLOCK=1` session gate + `=resource` path-filtered precursor (**303** reduced vs R170 per-resource). `HZ_EFFECT_HOST_KERNEL=default` prototype routes like `=1` (**299**); `=require` honesty gate. **Still open:** full EffectHost + kernel owns all mutations; cross-file/ambiguous/tied-subthreshold apply_patch fuzz (unique Levenshtein ≥0.66 on kernel **306** reduced; Bun first-hit score fuzz intentionally Bun-only per **313**) + multi-match variadic `ast_edit` on Bun — under `=require` named refusal when projection miss (**322**); full edit repair ladder on kernel path; per-effect docs/06 terminal argv re-probe (**292** workspace allow-list + doctor `terminal.state` only); full R172 (RC-7 **run** terminal; **292** shell **process** pane; **322** `agent.spawn` + child session JSONL summary; nested stream verify open).
2. **Independent receipt postimage** — **PARTIAL — TESTED** (**174b**, **256**, **257**, **260**, **261**, **272**, **279**, **280**, **297**, **301**, **320**): additive write/edit postimage + independent double-read stability (mismatch → effect `unknown` + notice; unstable digest omitted from receipt); observe-time `resultDigest` vs tool-output digest + missing postimage → `unknown` (**257**); kernel `effect.reconcile` accepts the same evidence bools (**260**) + `postimageObservationStable` (**279**); kernel `effect.execute` fs.write/fs.edit double-read (**279**); local `verifyReceipts` strips `effectId`/`postimage*` before hash recompute (**272**); loop receipt issuance uses kernel postimage when `HZ_EFFECT_HOST_KERNEL=1` (**280**); opt-in `HZ_VERIFY_POSTIMAGE_REPLAY=1` independent digest replay at session verify / effect reconcile (**297**); doctor `effect.postimage.replay` + require-auto replay (**301**) + explicit `ast_edit`/`$$$` kernel-route replay scope honesty (**320**). Residual: full Rust EffectHost owns observe for all tools; replay off by default without require.
3. **Session ↔ kernel reconciliation** — **PARTIAL** — unpaired report + effectId pairing (**174b**, **224**); live batch/turn notice (**235**); opt-in session block gate + `=resource` path filter (**293**, **303**); reconcile-block status chip + `/unknown status` (**304**); list blocked paths + `/unknown release` (**307** reduced); per-resource dependency lines on status/release (**316** reduced); in-run same-path gate `ast_edit` + driving effect hint (**317** reduced); fullscreen inset BLOCK banner + paths (**309** reduced); scrollback latch notice + status chip parity (**310** reduced); full R170 blocking protocol **still open**.
4. **MITM / routed shell egress** — CONNECT proxy + decider + forward (**178**, **195**, **208**); netns honesty (**218**); route doctor **288** (`egress.netns.route`); parent-loopback reach probe **289** (`egress.netns.proxy`, `HZ_EGRESS_NETNS_PROXY` + endpoint); veth capability probe + doctor `egress.netns.veth` + hermetic TCP when CAP_NET_ADMIN (**299**); bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` + `ops/netns-veth-connect-probe.sh` (**315**); spawnOwned child `HTTP(S)_PROXY` remap for wrapped netns when `HZ_EGRESS_NETNS_PROXY`/`HZ_EGRESS_NETNS_PROXY_ROUTED` + bridge endpoint (**317** reduced — env wire only); spawn ROUTED + veth stack doctor `egress.netns.spawn.routed` + hermetic `attemptNetnsSpawnVethRoutedStackEgress` + `ops/netns-spawn-routed-veth-probe.sh` (**319** reduced — alongside hz-sandbox-exec, not in-wrapper); spawnOwned-wrapped CONNECT doctor `egress.netns.spawn.wrapped` + hermetic product `spawnOwned`/`hz-sandbox-exec` bridge path (**321** reduced — child_net=on probe; in-wrapper veth open); TLS honesty doctor + passthrough test (**231**); optional ClientHello SNI peek on forward (**253**, **279** kernel parser + peek pipe); intercept + loadable CA → fail-closed CONNECT refuse (**281**); hermetic terminate + upstream TLS pipe when intercept/CA/terminate/forward (**283**, **285** reduced); Rust kernel loopback CONNECT listener (**234**); production routed netns-only shell egress + in-wrapper veth **open**; never claim shell-net `enforced`.
5. **Owner LICENSE** — root `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` (**233**); no owner-chosen root `LICENSE` (§6 hygiene, **33** §5.11).

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
| **314** | Kernel sandboxed `shell.exec` stdout/stderr double-hash observe + `resultDigestStable` wired `effect.reconcile` + loop kernel-route shell observe gate |
| **315** | Veth bridge-IP CONNECT hermetic (`attemptNetnsVethRoutedConnectEgress`, `egress-connect-proxy` `listenHost`); doctor `egress.netns.veth.routed`; `ops/netns-veth-connect-probe.sh` |
| **319** | spawn ROUTED + veth stack (`sandbox-netns-spawn-veth.ts`, doctor `egress.netns.spawn.routed`, `ops/netns-spawn-routed-veth-probe.sh`) — alongside hz-sandbox-exec; never enforced |
| **321** | spawnOwned wrapped CONNECT (`sandbox-netns-spawn-wrapped-connect.ts`, doctor `egress.netns.spawn.wrapped`, `ops/netns-spawn-wrapped-connect-probe.sh`) — product-runtime hermetic; in-wrapper veth open; never enforced |
| **320** | Variadic `$$$` `ast_edit` unique-projection kernel route + doctor honesty; P0 `effect.postimage.replay` `ast_edit` scope |
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

See `docs/33-handoff.md` priority overview and `docs/MASTER-BACKLOG-ALL.md` for the full residual matrix. Do not mark the overall goal complete until P0 trust spine items above are closed or honestly deferred with an owner ruling.
