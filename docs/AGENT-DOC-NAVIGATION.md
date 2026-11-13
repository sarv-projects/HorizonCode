# Agent documentation map (2026-11-13)

> **Start:** [`../AGENTS.md`](../AGENTS.md) — full onboarding + **docs lag code; backlog drives updates**.  
> **Queue:** [`FULL-BACKLOG-2026-11-13.md`](FULL-BACKLOG-2026-11-13.md). **Build:** [`33-handoff.md`](33-handoff.md). **This file:** `repo_take/`, code landmarks.

---

## 1. Read order (three files, not ten)

| # | File | When |
|:---:|---|---|
| 1 | **`FULL-BACKLOG-2026-11-13.md`** | Always — backlog + what to do first (§Z) |
| 2 | **`33-handoff.md`** | Before `bun test` / `ops/gates.sh` |
| 3 | **`AGENT-DOC-NAVIGATION.md` §3–§7** | When implementing a specific area |

Do **not** maintain parallel queues in HANDOFF or MASTER — those files redirect or summarize.

---

## 2. Authority (conflicts)

1. Git + test output  
2. `28-implementation-status.md` §3 rulings (**342**)  
3. `FULL-BACKLOG-2026-11-13.md`  
4. `GOAL-PROGRESS.md`  
5. `30-steal-list.md` (evidence; mirrored in FULL §R)

---

## 3. `repo_take/` — when to open

| Task | Clone | Doc |
|---|---|---|
| aider git steals (E-*) | `repo_take/aider` @ `5dc9490…` | `research/steal-little-coder-aider.md` |
| little-coder policies | `repo_take/little-coder` @ `89d4fa0…` | same |
| Eight upstream steals | pins in `research/upstream-pins.md` | `research/*.md` |
| Missing clone | — | audit report only; `path not verified` |

Pins: [`research/upstream-pins.md`](research/upstream-pins.md)

---

## 4. Code landmarks (P0)

| Area | Start here |
|---|---|
| EffectHost / **338** | `app/src/core/index.ts`, `effect-reconcile-attach.ts`, `effect-host-runtime.ts` |
| R170 | `effect-resource-gate.ts`, `13-tui.md` |
| Egress | `egress-*.ts`, `kernel/src/egress_*.rs` |
| Postimage | `receipt-postimage.ts`, `kernel` execute paths |

---

## 5. After each shipped slice

- [ ] Tests green  
- [ ] New ruling in `28` §3 (**343+**)  
- [ ] Update `GOAL-PROGRESS` + FULL §C/§R if §7 status changed  
- [ ] Never claim shell-net `enforced`

---

## 6. Doc index (reference)

| Doc | Role |
|---|---|
| `FULL-BACKLOG-2026-11-13.md` | **The backlog** |
| `33-handoff.md` | Commands, §5 long-form deferral specs |
| `30-steal-list.md` | Steal source text |
| `MASTER-BACKLOG-ALL.md` | Optional wave summary |
| `HANDOFF-BACKLOG-2026-11-13.md` | Redirect only |
| `BACKLOG.md` | Redirect only |

---

*Single-file policy: extend FULL-BACKLOG, do not add a fourth queue markdown.*
