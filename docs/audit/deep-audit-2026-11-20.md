# Deep code ↔ docs audit — 2026-11-20

> **Goal: NOT COMPLETE.** Nothing **RELEASED**. Never claim shell-net egress **`enforced`**.
>
> Companion rulings: **`docs/28` §3 736–739**. Living inventory: [`../STOP-OF-DAY-2026-11-20.md`](../STOP-OF-DAY-2026-11-20.md).

## Scope

Two passes on the same day:

1. **Code audit (rulings 720–735)** — tree vs ruling claims (modules/tests/cite honesty).
2. **Docs-consistency pass** — living spine (`AGENTS`, `CURRENT_RUN`, `00`, `28`, `GOAL`, `FULL`, `33`, `STOP`, `MASTER`, steal-list, LICENSE) vs HEAD/WT ceilings and OPEN/PARTIAL honesty.

## Method

1. Ruling-number integrity on `docs/28` §3 (headers, duplicates, inversions, missing ids).
2. Ceiling grep for stale “through N” claims across living docs.
3. File/symbol greps for claimed modules/tests (720–735).
4. Steal ↔ FULL OPEN/done fork check; spend-grant residual wording.
5. Relative-link spot-check on the audited set (0 broken).

---

## 1. Critical mismatches (ruling-ID honesty)

| Issue | Wrong → correct | Fixed in |
|---|---|---|
| Shell require-wrap in `effect_host.rs`, `kernel-shell-exec-doctor.ts`, `doctor.ts`, `effect-host-posture.ts` | **730** → **732** | **738** |
| `PARENT_CONTROL_PRINCIPAL` / parent-mint test | **719** → **720** | **738** |
| Ruling **665** `web_search` cross-ref | **721** → **723** | **738** |
| Ruling **736** claimed spot-checks “ACCURATE” while those mis-cites existed | Overclaim | Softened in **736** text; cites closed **738** |

### Partials (feature OK; honesty sharpened)

| Item | Notes |
|---|---|
| **734** workspace-binding | Feature OK; unit tests cover capture/drift refuse — **not** live remount/rename-swap simulation (**739**) |
| **732** / **720** | Features OK; labels were stale (**738**) |
| **736** | Doc repairs were uncommitted at first audit time |
| **702** | Logic under MCP client/posture — no dedicated `effect-host-mcp-spawn.ts` (**739**) |

### Feature claims that matched the tree (720–735)

MCP mutate refuse, `fs.edit`/`fs.delete` observe-settle, `web_search`, Windows LockFileEx, receipt issuer, `ask_user`, structural critic, best-of-n worktrees, token-fit, speculation, multimodal, spend grant **735** (docs-only RECORDED).

### Targeted answers

- `workspace-binding.ts` ≈ **734** — yes
- `fs.delete` observe-settle ≈ **733** — yes
- **735** spend grant — docs-only RECORDED — OK
- No new product modules without a ruling after **734**
- P0 still OPEN / never shell-net **`enforced`** — honest

---

## 2. Docs-consistency pass — living spine vs HEAD/WT

### P0 honesty bugs (fixed)

| # | Finding | Fix |
|---|---|---|
| 1 | `GOAL-PROGRESS.md` duplicated (~2×) — second `## Rulings 538–669` + duplicated Release blockers | Dedupe — **738** |
| 2 | `docs/28` banner still said authoritative through **668** (frontier was **735+**) | Banner → frontier; OOO note — **736**/**739** |
| 3 | Steal-list B-4/C-9/§5 still said “needs keys” while spend grant **735** says run | Aligned to **735** — **738** |
| 4 | FULL-BACKLOG §C titled “OPEN only” but mixed DONE; §R **F-4** CLOSED vs §C PARTIAL | §C retitle; **F-4** PARTIAL — **738** |

### Ceiling mismatches (fixed)

HEAD ~**735** / STOP said **734** / `28` body **668** → WT moved through **739** (ceilings synced across AGENTS / CURRENT_RUN / 00 / 28 / GOAL / FULL / 33 / STOP / MASTER).

### `docs/28` §3 structure (addressed / deferred)

| Finding | Disposition |
|---|---|
| Duplicate ruling **9** (system prompt vs code mode) | Code-mode retitled **9b** — **739** |
| Live 670+ append out of order | Reader note at §3 top — **736**/**739**; full chronological rewrite deferred |
| Missing long-standing numbers **175**, **237**, **241**, **245**, **248**, **265** | Named as never-assigned in §3 note — **739** |

### Links / COMPLETE / spend

- Broken relative links in audited set: **0**
- Live banners: NOT COMPLETE / never enforced / nothing RELEASED — OK
- STOP ↔ GOAL spend grant aligned after WT

### Steal vs FULL

- No OPEN↔done fork for classic OPEN rows
- Stale evidence on B-4, C-9, C-7, C-12, H-7 → catch-up **738**/**739**
- H-6: §2 SKIP vs §7 “partial” → §7 SKIP matching §2 — **738**

### Priority fix list → closure map

| Priority | Item | Ruling |
|---|---|---|
| P0 | Dedupe GOAL · finish **736** · steal B-4/C-9 · §C/F-4 | **736**/**738** |
| P1 | OOO note / duplicate **9** · H-6 §7 · summary counts · sandbox row history · C-12/**704** · H-7/**549+** | **739** |
| P2 | LICENSE NOTICE §5.11→§6 · steal cite catch-up | **738**/**739** |

---

## 3. Critical findings fixed in ruling 736 (doc placement / ceilings)

| # | Finding | Fix |
|---|---|---|
| 1 | `docs/28` figures banner still said §3 authoritative through **668** while frontier was **735** | Banner → frontier; note that 670+ append is not strictly numeric-sorted |
| 2 | Rulings **717–721** were orphaned *after* **735** (before historical **482**) | Moved to sit immediately before **722** |
| 3 | `STOP-OF-DAY` session outcome still said inventory through **734** after spend grant **735** | Corrected to **735** + audit chain |
| 4 | `MASTER-BACKLOG-ALL` footer claimed rulings through **537** @ `ddc8ef8` | Footer redirects to live `28` / FULL-BACKLOG / GOAL |
| 5 | `docs/11` named human principal / G1 reductions but not H-31 Bun capture (**734**) or observe-settle | Added reduced shipped bullets under Guard |

---

## 4. Code spot-checks (720–735)

| Ruling | Evidence |
|---|---|
| **720** | `kernel/src/human_principal.rs`, `PARENT_CONTROL_PRINCIPAL` in `app/src/contracts.ts` (cite was wrongly **719** — fixed **738**), honesty tests |
| **721** | `app/src/core/effect-host-mcp-invoke.ts` + `effect-host-mcp-invoke.test.ts` |
| **722** / **733** | `observe_intended_fs_edit_settlement` / `observe_intended_fs_delete_settlement` in `effect_host.rs`; integration `owner_executed_unknown_observe_settle_fs_*` |
| **732** | `kernel-shell-exec-doctor.ts` + require-wrap (comments/doctor wrongly said **730** — fixed **738**) |
| **734** | `app/src/core/workspace-binding.ts` + `workspace-binding.test.ts` (no remount race sim) |
| **735** | Docs-only operational grant (RECORDED) — full text in `28` / stop-of-day §3.1 |

No overclaim that a product done-bar was closed for P0-1…4, R172, G1 frozen-`allow` removal, crypto human principal, or shell-net **`enforced`**.

---

## 5. Remaining honesty residuals (not closed by this audit)

- Older §3 inversions below ~670 — search by number; full chronological rewrite deferred.
- `CURRENT_RUN.md` historical body still carries 2026-11-10 suite counts (banner points at stop-of-day / `28`).
- `docs/08-runtime.md` / `docs/09-tools.md` remain design-superset; they do not enumerate every 670+ reduction — trust `28` §3.
- P0 spine / Wave-0 / §7 live PARTIAL residuals unchanged — see stop-of-day §2.

## Non-claims

- This audit does **not** re-run full `ops/gates.sh` (last recorded **8/8** after **648** on 2026-11-19).
- This audit does **not** close any P0 done-bar or mark anything **RELEASED**.
- Competitive viability is a separate record: [`competitive-viability-audit-2026-11-20.md`](competitive-viability-audit-2026-11-20.md) (ruling **737**).
