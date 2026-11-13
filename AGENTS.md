# AGENTS.md — instructions for coding agents

> **Goal: NOT COMPLETE** (2026-11-13). LICENSE deferred. Never claim shell-net egress **`enforced`**.

---

## Docs are living; the tree is authoritative

- **Do not assume** the design corpus (`docs/01`–`25`, HLD, LLD, schemas, APIs) is complete, current, or fully implemented. Much is **DESIGNED** ahead of code; `docs/31-design-summary.md` and parts of `03`/`04` describe targets, not guaranteed reality.
- **Docs lag the repo.** Rulings and slices land in the working tree (often before every narrative doc is refreshed). When behavior disagrees with a markdown file, trust **code + tests + `docs/28-implementation-status.md` §3 rulings** first, then fix the docs in the **same change** as the implementation.
- **Pay primary attention to the backlog** — [`docs/FULL-BACKLOG-2026-11-13.md`](docs/FULL-BACKLOG-2026-11-13.md) (§Z = what to do first, §C = OPEN work). Implemented backlog items should drive doc updates: add or extend a **§3 ruling** in `28`, adjust **`GOAL-PROGRESS`** / **FULL-BACKLOG** row status, and update any affected spec (`09-tools`, `11-authority-safety`, `33-handoff` §5, etc.) when you ship a slice.

---

## Onboarding — what to read (not only the backlog)

| Order | Document | Purpose |
|:---:|---|---|
| 1 | [`docs/FULL-BACKLOG-2026-11-13.md`](docs/FULL-BACKLOG-2026-11-13.md) | **Work queue**, §0 tree state, §Z implementation order |
| 2 | [`docs/33-handoff.md`](docs/33-handoff.md) §1 | **Repository map** — `app/`, `kernel/`, main modules |
| 3 | [`docs/33-handoff.md`](docs/33-handoff.md) §2 | **Build, test, gates**, env gotchas |
| 4 | [`app/src/contracts.ts`](app/src/contracts.ts) | Frozen wire/protocol types (additive only) |
| 5 | [`docs/03-hld.md`](docs/03-hld.md) + [`docs/11-authority-safety.md`](docs/11-authority-safety.md) | Planes, trust, guard, egress honesty |
| 6 | [`docs/28-implementation-status.md`](docs/28-implementation-status.md) §3 | **What is actually shipped** (rulings through **349**) |
| 7 | [`docs/GOAL-PROGRESS.md`](docs/GOAL-PROGRESS.md) | P0 residuals, waves, SKIP list |
| As needed | [`docs/09-tools.md`](docs/09-tools.md), [`docs/08-runtime.md`](docs/08-runtime.md) | Loop and tools (design; verify in code) |
| As needed | [`docs/AGENT-DOC-NAVIGATION.md`](docs/AGENT-DOC-NAVIGATION.md) | When to open **`repo_take/`**; code landmarks |
| As needed | [`docs/research/upstream-pins.md`](docs/research/upstream-pins.md) | Upstream SHAs; `repo_take/aider`, `repo_take/little-coder` |

**Index:** [`docs/00-index.md`](docs/00-index.md). **Steal evidence:** [`docs/30-steal-list.md`](docs/30-steal-list.md).

---

## Before you claim “done”

1. Run checks from `33-handoff` §2 (`typecheck`, targeted tests, `ops/gates.sh` when appropriate).
2. Add a **numbered ruling** in `docs/28-implementation-status.md` §3 if you shipped a product slice.
3. Update **`GOAL-PROGRESS`** and **FULL-BACKLOG** (§C / §R) if steal status changed.
4. Do not invent root **`LICENSE`** (`docs/LICENSE-STATUS.md`).

---

## Commit preference (owner, 2026-11-13)

When the owner says **commit**: one commit with **docs + implementation** together (not docs-only).

---

## P0 spine (honest — not closed)

EffectHost / kernel route, postimage, full R170, product routed egress — see FULL-BACKLOG §A and §Z.
