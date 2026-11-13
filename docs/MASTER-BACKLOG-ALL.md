# Master backlog — wave summary (residuals honest)

> **Goal: NOT COMPLETE.** **Backlog:** [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md) only. **This file** = optional wave summary. **LICENSE deferred.**

## Legend

- **CLOSED / TESTED** — slice exists with named tests; may still have documented residuals.
- **PARTIAL** — reduced implementation; residuals listed.
- **OPEN** — not started or design-only.
- **SKIP** — explicitly not queued (do not re-open as greenfield).
- **DEFERRED** — owner/human or explicit defer (not incomplete by accident).

---

## P0 — prototype trust spine (none CLOSED)

### P0 completion bars (honest)

| # | Area | Shipped partial (rulings) | **Done bar** (not met) |
|---|---|---|---|
| 1 | EffectHost | **220–328**, **340**, **343**, **345**, **347–348** | Kernel owns mutations or refuses under product posture; `=require` covers fuzz/ast_edit gaps; less Bun apply_patch; doctor honesty for **effective** runtime mode |
| 2 | Postimage / Rust observe | **256–261**, **272**, **279–280**, **297**, **301**, **314**, **327–328**, **348** | Rust observes **all** mutating tools on kernel path; replay policy tested |
| 3 | R170 | **293**, **303–304**, **307–310**, **316–318**, **333–338**, **342**, **344**, **348** | docs/13 full per-resource barrier + latch-until-clean (not only opt-in block) |
| 4 | MITM / routed egress | **178**, **208**, **218**, **288–289**, **299**, **315–332**, **341**, **348** raw-shell refusal + disposable netns smoke (NOT product proof) | Default product netns-only egress E2E; JOIN parent plumb; TLS claims match capability; **never** shell-net `enforced` |
| 5 | LICENSE | **233** hygiene | **DEFERRED** — owner root `LICENSE` |

### P0 detail rows

| Item | Status | Residual / ruling |
|---|---|---|
| EffectHost five-phase settlement | **PARTIAL — TESTED** (**181**, **220**, **224**, **243**, **261**, **267**, **275**, **277**, **278**, **279**, **280**, **281**, **283**, **285**, **287**, **286**, **290**, **291**, **293**, **294**, **295**, **299**, **300**, **301**, **302**, **303**, **306**, **307**, **308**, **311**, **314**, **320**, **322**, **323**, **327**, **328**, **335**, **337**, **339**, **340**) | Durable `effects.jsonl` + attach reconcile (**224**, **338**); kernel `effect.execute` sandboxed fs/shell; `=default`/`=require` + **340** runtime spine; edit repair **335/337/339**; apply_patch require miss **323**. **Open:** full kernel ownership and default Bun ambient shell; general/full fs.edit merge and patch parity (unique relative-indent/trim/anchor reduced **345/347**); lint guarded via **347** |
| Receipt independent postimage | **PARTIAL — TESTED** (**174b**, **256–261**, **272**, **279–280**, **295**, **297**, **301**, **314**, **327–328**, **348**) | **348:** kernel issues its own receipt after observing participating direct Rust effects, and OwnerLog verifies receipt chain before later effects. **OPEN:** default postimage replay, missing effect classes and UNKNOWN recovery |
| Session ↔ kernel / R170 | **PARTIAL** (**174b**, **235**, **293**, **303–304**, **307–310**, **316–318**, **333–338**, **342**, **344**, **348**) | **348:** direct Rust effects now serialize/chain prepare→observe→receipt→settle across kernel processes; UNKNOWN blocks subsequent kernel mutations. **OPEN:** cross-process Bun/other entrypoints, verified release/recovery, full docs/13 R170 |
| MITM / shell egress | **PARTIAL** (**178**, **195**, **208**, **218**, **231**, **234**, **253**, **279**, **281**, **283**, **285**, **288**, **289**, **299**, **315**, **317**, **319**, **321**, **324**, **325**, **326**, **329**, **330**, **331**, **332**, **341**) | **Open:** production default routing; parent JOIN plumb |
| Owner **LICENSE** | **DEFERRED** | Not next-agent priority |

---

## Waves A–D (residual summary)

| Area | Status | Handoff / register |
|---|---|---|
| Speculation | **UNWIRED** (**65**) | HANDOFF §3 |
| DAP / toolconv | **PARTIAL** | HANDOFF §3 |
| Wave C grants / bash AST | **PARTIAL** | HANDOFF §3 |
| §8 #11–#15 | **PARTIAL** (#252 poll closed) | `30-steal-list.md` §8 |
| MCP cursors | **PARTIAL** (**263–264**) | GOAL wave A–D |
| Memory | **PARTIAL** (**238/242**) | HANDOFF §3 |
| §8 #17–#18 / Wave F | **SKIP** | HANDOFF §6, GOAL SKIP |

---

## Wave 0 (honesty slice)

| Item | Status | Open / residual |
|---|---|---|
| RC-18 `SHIPPED_TO_HZ_MAP` | **PARTIAL — TESTED** (**174b**) | **23 shipped** event types; not full **44-map** per design corpus |
| JSONL fsync default | **TESTED** (**174b**, **251**) | — |
| DeepSeek child prompt sections | **TESTED** (**174b**) | — |
| Full EffectHost + `hz.*` emission | **PARTIAL** (**220**, **348**) | OwnerLog internal `owner.*` transitions add genuine Rust settlement/fencing for direct effects only, **not** canonical `hz.*` additions or universal ownership |
| Full R172 | **PARTIAL** (**284**, **289**, **292**, **322**) | Verify chain; nested stream; RC-7 depth |
| apply_patch / fs.edit kernel | **PARTIAL** | Repair **335–339**, **345**, **347** relative_indent + unique trim/anchored direct fs.edit behind flag; general merge/patch, first-hit score fuzz **313**, cross-file and universal routing OPEN |
| **338** attach / switchSession | **PARTIAL** | **343** same-process switchSession ledger reload shipped; cross-process owner identity and atomic fencing OPEN |
| Topic branch review | **OPEN** | Rulings **343–347** + prior local work targeted for one docs+code commit; check git for push/PR, do not assume merged |

---

## Verification / CI (audit residuals)

| Item | Notes |
|---|---|
| `ops/gates.sh` 8/8 | Re-run for freshness — HANDOFF §8 |
| `sandbox_exec.rs` | Host-class WSL/Landlock — HANDOFF §0 |
| Live cache/provider benches | API keys — B-4 partial |

---

## Complete queue

**[`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md)** — §7 OPEN + §R full mirror + §8 + §E–§V. This file is wave summary only.

---

## Wave E — TUI

| Item | Status | Residual |
|---|---|---|
| Scrollback polish | **PARTIAL — TESTED** (**177**, **232**, **236**) | D* items; MRU palette |
| Reduced alt-screen chat | **PARTIAL — TESTED** (**193**–**317**, **300**, **342**) | Grok **R1–R12** open (**R2, R4, R9–R12**) |
| `cellbuffer` / `escape-writer` | **PARTIAL — TESTED** (**176**, **183**) | Every frame path |

---

## docs/30 §7 — open register (sample)

See **§5** of [`HANDOFF-BACKLOG-2026-11-13.md`](HANDOFF-BACKLOG-2026-11-13.md) for prioritized rows. Full register: `docs/30-steal-list.md` §7.

| ID | Status | Open |
|---|---|---|
| B-4 cache | **PARTIAL** | Live API cache-hit |
| B-5 prefix | **PARTIAL** | `syncMessages` stable prefix |
| C-7/C-8/C-9 | **PARTIAL** | steer / tail re-exec / interjection |
| E-1–E-3, **E-5** | **PARTIAL / queued** | Git slices + new watch candidate |
| little-coder TAKE pack | **OPEN** | `research/steal-little-coder-aider.md` |

---

## docs/30 §8 — steal wave (#1–#18)

| # | Status | Notes |
|---|---|---|
| 2 Egress / MITM | **PARTIAL — TESTED** | Production default still open |
| 7 Doom-loop / speculation | **PARTIAL** / **UNWIRED** **65** |
| 17–18 Foreign / collab | **SKIP** | Until spine |
| 1–16 | **PARTIAL** mix | See `docs/30` |

---

## SKIP list (ruling **252**)

Wave F + global SKIP unchanged — see `GOAL-PROGRESS.md` §Explicit non-wired.

---

## Doc hygiene (full index)

| Doc | Role |
|---|---|
| **`docs/AGENT-DOC-NAVIGATION.md`** | **Router** — mandatory read order, authority chain, `repo_take/` when/where, P0 code paths, post-slice checklist |
| `docs/HANDOFF-BACKLOG-2026-11-13.md` | Execution queue, P0 done bars, verification §8, impl order §10 |
| `docs/GOAL-PROGRESS.md` | Goal NOT COMPLETE; wave table; P0 residual prose |
| `docs/33-handoff.md` | Commands, env, invariants, §5 deferred backlog narrative |
| `docs/28-implementation-status.md` | Status ladder; §3 rulings (**342**); header counts historical |
| `docs/30-steal-list.md` | §7 register + §8 waves; §0.1.1 E-5/LC queue |
| `docs/MASTER-BACKLOG-ALL.md` | **This file** — wave residual matrix |
| `CURRENT_RUN.md` (repo root) | Historical snapshot + pointers to router |
| `docs/LICENSE-STATUS.md` | Root LICENSE owner decision (deferred) |
| `docs/research/README.md` | Research note index |
| `docs/research/upstream-pins.md` | 8 `repo-tour` pins + **gitignored `repo_take/`** (aider, little-coder) |
| `docs/research/steal-little-coder-aider.md` | TAKE/SKIP matrix before LC/aider code |
| `docs/00-index.md` | Design corpus TOC |
| `docs/13-tui.md` | TUI / Grok / R170 spec |
| `docs/06-effects.md` | EffectHost design |
| `docs/11-authority-safety.md` | Egress / MITM threat model |

**After each shipped slice:** ruling in `28` §3 → GOAL-PROGRESS → MASTER footer if needed → HANDOFF §1 only if a P0 **done bar** fully met (see router §7.6).

---

*Last refreshed: 2026-11-13 (handoff + **AGENT-DOC-NAVIGATION**). Rulings through **347**. LICENSE **DEFERRED**. Uncommitted tree **315–342** + docs. P0 done bars **not met** — goal **NOT COMPLETE**.*
