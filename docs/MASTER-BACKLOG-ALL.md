# Master backlog — all waves (residuals honest)

> **Goal: NOT COMPLETE.** Consolidates open work from Wave 0 through Wave E/J and `docs/30-steal-list.md`. Status ladder: `docs/28-implementation-status.md` only.

## Legend

- **CLOSED / TESTED** — slice exists with named tests; may still have documented residuals.
- **PARTIAL** — reduced implementation; residuals listed.
- **OPEN** — not started or design-only.
- **SKIP** — explicitly not queued (do not re-open as greenfield).

---

## P0 — prototype trust spine

| Item | Status | Residual / ruling |
|---|---|---|
| EffectHost five-phase settlement | **PARTIAL — TESTED** (**181**, **220**, **224**, **243**, **261**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **283**, **285**, **287**, **286**, **290**, **291**, **293**, **294**, **295**, **299**, **300**, **301**, **302**, **303**, **314**) | Durable `effects.jsonl` + attach reconcile (**224**); live kernel reconcile wire (**261**); kernel `effect.execute` fail-closed + sandboxed `fs.read`/`fs.write`/`fs.edit`/`shell.exec` (**243**, **267**, **275**, **277**, **278**; argv-only shell advisory; **314** stream digest observe + `resultDigestStable`); postimage double-read on kernel write/edit (**279**); `HZ_EFFECT_HOST_KERNEL=1|default` write/edit/shell + reduced sequential/same-file multi-chunk apply_patch/ast_edit route + loop receipt postimage (**280**, **287**, **293**, **299**; **301** simple single-metavar `ast_edit`); `HZ_EFFECT_HOST_KERNEL=require` fail-closed + doctor `effect.host` + `doctor --fix effect.host` (**285**, **299**, **313** prototype-honesty recommends require under `default`); change-journal after kernel write/edit (**281**); sandbox atomic temp+rename on kernel write/edit (**283**); reduced `HZ_EFFECT_HOST_EDIT_REPAIR` kernel fs.edit/apply_patch trimEnd repair (**287**, **299**); UNKNOWN chip (**235**, **264**, **282**). Bun still owns ambient `shell` when unset. **Still open:** full EffectHost + kernel owns all mutations |
| Receipt independent postimage | **PARTIAL — TESTED** (**174b**, **256**, **257**, **260**, **261**, **272**, **279**, **280**, **295**, **297**, **301**) | Double-read stability + observe evidence gate (**256**, **257**); kernel execute + reconcile mirror (**279**, **260**, **261**); local `verifyReceipts` sidecar strip (**272**); loop receipt postimage on kernel route (**280**); CLI evidence scan at verify (**295** reduced); opt-in digest replay at verify (`HZ_VERIFY_POSTIMAGE_REPLAY=1`, **297**); doctor `effect.postimage.replay` + require-auto replay (**301**). Residual: full Rust EffectHost observe for all tools; replay off by default without require |
| Session ↔ kernel ledger reconcile | **PARTIAL** (**174b**, **235**, **293**, **303**, **304**, **307**, **309**, **310**, **316**, **317**) | Live batch/turn notice; `HZ_EFFECT_RECONCILE_BLOCK=1` session gate + `=resource` path filter (**303**); status chip + `/unknown status` (**304**); list blocked paths + `/unknown release` (**307** reduced); per-resource dependency explain lines on status/release (**316** reduced); in-run gate `ast_edit` + driving UNKNOWN hint (**317** reduced); fullscreen inset BLOCK banner (**309** reduced); scrollback latch notice + BLOCK chip (**310** reduced); full R170 blocking protocol **still open** |
| MITM / shell egress enforcement | **PARTIAL** (**178**, **195**, **208**, **218**, **231**, **234**, **253**, **279**, **281**, **283**, **285**, **288**, **289**, **299**, **315**, **317**, **319**, **321**) | CONNECT decider + forward (**208**); netns denial (**218**); route + parent-loopback reach doctor (**288**, **289**; `HZ_EGRESS_NETNS_PROXY` advisory); veth CAP probe + bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` (**299**, **315**); spawnOwned child proxy env for wrapped netns (**317** reduced); spawn ROUTED + veth stack doctor/hermetic/ops probe (**319** reduced — veth alongside, not in-wrapper); spawnOwned-wrapped CONNECT hermetic + doctor `egress.netns.spawn.wrapped` (**321** reduced — child_net=on probe; in-wrapper veth open); TLS honesty doctor + passthrough test (**231**); optional ClientHello SNI peek on forward (**253**, **279** Rust parser + peek); intercept + CA refuse (**281**) vs terminate + upstream TLS pipe (**283**, **285**); Rust kernel loopback listener (**234**); rustls handshake smoke. **Open:** production routed netns-only egress + veth inside `hz-sandbox-exec`; never `enforced` for ambient shell |
| Owner **LICENSE** | **OPEN** | `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` (**233**); no invented root LICENSE |

---

## Wave 0 (honesty slice)

| Item | Status |
|---|---|
| RC-18 `SHIPPED_TO_HZ_MAP` | **TESTED** (**174b**) |
| JSONL fsync default | **TESTED** (**174b**) |
| DeepSeek child prompt sections | **TESTED** (**174b**) |
| Full EffectHost + `hz.*` emission | **PARTIAL** (**220**); literal events ship for effect settle/unknown only |

---

## Wave E — TUI

| Item | Status | Residual |
|---|---|---|
| Scrollback polish (`/palette`, handoff, …) | **PARTIAL — TESTED** (**177**, **232**, **236**) | D9 folds, D11 a11y, D15 notify persist, D17 clipboard; scrollback `/` `@` popup (D6); MRU palette |
| Reduced alt-screen chat | **PARTIAL — TESTED** (**193**, **221**, **225**, **232**, **240**, **300**, **305**, **306**, **308**, **309**, **310**, **311**, **312**, **313**, **316**, **317**) | Mouse (**225**); palette + in-loop slash (**232**, **240**); composer history D18 (**240**); live inset pane **Ctrl+B** (**300**); independent inset wheel scroll (**305** reduced); inset keyboard scroll (**306** reduced); main-loop differential paint (**308** reduced); reconcile-block inset banner (**309** reduced); overlay same-kind differential (**310** reduced); main↔overlay soft transition (**316** reduced); overlay↔overlay soft transition (**317** reduced); hit-test resize + completion overlay region (**311** reduced); live modal overlay mouse wire (**312** reduced); modal backdrop click dismiss (**313** reduced); Grok R1–R12 parity **open** |
| `cellbuffer` / `escape-writer` | **PARTIAL — TESTED** (**176**, **183**) | Wire into every frame path |

---

## docs/30 §7 — selected open residuals

| ID | Status | Open |
|---|---|---|
| B-4 cache | **PARTIAL** (**200**, **222**, **223**, **246**, **276**, **277**, **282**) | local prefix measure on keep-alive; live API cache-hit open |
| B-5 append-only prefix | **PARTIAL** | Fingerprinted `syncMessages` on main loop |
| Speculation (§8 #7) | **UNWIRED** (**65**) | No wiring planned without owner ruling |
| D-4 scheduler | **SKIP** | Not queued |
| H-6 KDL cascade | **SKIP** | Compat host map **partial — TESTED** (**244**); ranked KDL cascade not queued |

---

## docs/30 §8 — steal wave (#1–#18)

| # | Status | Notes |
|---|---|---|
| 1 Session FTS / picker | **PARTIAL** (**167**, **196**) | Preview, tree, cost |
| 2 Egress / MITM | **PARTIAL — TESTED** (**178**, **195**, **208**, **218**, **231**, **234**, **253**) | True TLS intercept proxy; routed netns-only; never shell-net `enforced` |
| 14 AutoMode TUI | **PARTIAL — TESTED** (**230**) | Config write-back; fullscreen picker |
| 3–4 Memory handoffs / banks | **PARTIAL — TESTED** (**169**, **170**, **238**, **242**) | MMR-lite (**238**); curator apply + dream stub (**242**); embeddings/auto-commit open |
| 5–9 Wave C UX | **PARTIAL** (**173**) | Durable grant rows, bash AST |
| 7 Doom-loop / speculation | **PARTIAL** / **UNWIRED** | Templates; speculation **65** |
| 10–16 Various | **PARTIAL** mix (**171**–**182**, **239**) | OAuth hermetic e2e + symbol/output paging (**239**); live DAP e2e, toolconv stream |
| 17–18 Foreign / collab UI | **SKIP** | Until spine |
| 11–15 Wave D | **PARTIAL** (**174**, **175**, **180**, **233**, **252**) | Optional `HZ_MODELS_POLL_MS` catalog poll wired on `createRuntime` (**180**, residual closed **252**); compaction on `CONTEXT_WINDOW_EXCEEDED` **reduced — TESTED** (**233**) |

---

## SKIP list (docs/30 — do not queue; ruling **252**)

Wave F **deferred (SKIP)** only (not greenfield backlog): D-4 scheduler · provider-hosted tools · external agent subagents · §8 #17 foreign sessions · §8 #18 collab-web (H-6 **partial — TESTED** **244**; full KDL cascade **SKIP**).

Global SKIP (unchanged): Rust TUI rewrite · Effect-TS rewrite · vendoring memory MCP servers as core · Kitty graphics · forge hosted search / spoofed OAuth clients.

---

## Doc hygiene

| Doc | Role |
|---|---|
| `GOAL-PROGRESS.md` | Wave-level honest snapshot (this file's companion) |
| `33-handoff.md` | Next-agent priorities + §5 deferrals |
| `28-implementation-status.md` | Rulings and levels |
| `audit/honesty-pass-2026-11-12.md` | Point-in-time audit; live status in 28/33 |

---

*Last refreshed: 2026-11-13 (rulings through **322**; R172 child session stream summary + `ast_edit` multi-match require honesty **322**; spawnOwned wrapped CONNECT hermetic **321**; spawn ROUTED + veth stack alongside hz-sandbox-exec **319**; overlay↔overlay soft-transition + R170 in-run gate **318**; spawnOwned routed proxy env **317**; R170 per-resource dependency explain + main↔overlay paint soft transition **316**; veth bridge-IP CONNECT hermetic + doctor `egress.netns.veth.routed` **315**; kernel `shell.exec` digest observe + `resultDigestStable` **314**; Bun first-hit fuzz honesty + modal mouse dismiss **313**; modal overlay mouse + doctor EDIT_REPAIR fix **312**; dominant-score + hit-test overlay region **311**; overlay same-kind differential **310**; **308** line-patch + main differential paint; inset banner **309**; R170 list/release **307**). Overall goal remains **NOT COMPLETE** (owner **LICENSE**, full EffectHost, true TLS decrypt MITM, routed netns-only egress, Grok R1–R12 parity). Wave F **SKIP** unchanged.*
