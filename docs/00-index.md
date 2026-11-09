# HorizonCode — Specification Index

> **Product:** HorizonCode · **Binary:** `hzcode` · **Status:** design set ratified through RC-17 (2026-11-07) · **v0.1 slice implemented, tested and green; everything else DESIGNED** (implementation levels: `28-implementation-status.md`; audit record: `29-final-audit.md`)
>
> **Implementation note (2026-11-09, integration branch `integration/superset`).** Twelve feature branches are merged and TESTED on the integration branch (typecheck 0 errors; `bun test` 1250 pass / 11 root-only fail of 1261; `cargo test` 47 + 50; selftest 25 checks). Nothing is RELEASED. The per-feature map is `28-implementation-status.md` §1; the done / partial / not-started table is `../CURRENT_RUN.md` §5.0.
>
> Reconciled 2026-11-07 (reaudit stage 2, RC-15; corpus rulings now through RC-17).

This directory is the authoritative specification for HorizonCode, a coding agent designed as the strict superset of the state of the art, with an execution constitution: model reasoning is separated from the authority to mutate.

---

## Read in this order

| # | Document | What it decides |
|---|---|---|
| — | [`../README.md`](../README.md) | What the agent is and the complete final feature list |
| 01 | [`01-vision-and-superset.md`](./01-vision-and-superset.md) | Why it exists; the eight references grilled; what is inherited, superseded and new |
| 02 | [`02-decisions.md`](./02-decisions.md) | ADR-001…ADR-016 — every binding architectural decision, incl. **terminal-first vs web** |
| 03 | [`03-hld.md`](./03-hld.md) | High-level design: planes, processes, trust boundaries, interfaces, targets |
| 04 | [`04-lld.md`](./04-lld.md) | Low-level design: packages, crates, modules, function signatures, invariants |
| 05 | [`05-domain-and-schemas.md`](./05-domain-and-schemas.md) | Domain model and every schema (`*V1`) |
| 06 | [`06-events-and-flows.md`](./06-events-and-flows.md) | Event catalog + 24 end-to-end flows |
| 07 | [`07-apis-and-contracts.md`](./07-apis-and-contracts.md) | Controller protocol, kernel ABI, HTTP/SSE, ACP, MCP, plugin API, SDKs |
| 08 | [`08-runtime.md`](./08-runtime.md) | Agent loop, planner/executor, subagents, teams, budgets, self-improvement |
| 09 | [`09-tools.md`](./09-tools.md) | The complete tool catalog (§4 is authoritative) and the tool system |
| 10 | [`10-cognition.md`](./10-cognition.md) | Providers, context compiler, cache contract, memory, retrieval, compaction |
| 11 | [`11-authority-safety.md`](./11-authority-safety.md) | Threat model, Guard, leases, receipts, sandbox matrix, policy |
| 12 | [`12-sessions-state.md`](./12-sessions-state.md) | Event log, projections, inbox, claims, snapshots, time travel, durability |
| 13 | [`13-tui.md`](./13-tui.md) | The terminal UI in full |
| 14 | [`14-surfaces.md`](./14-surfaces.md) | Headless, server, web, desktop, IDE/ACP, MCP server, SDKs, collaboration |
| 15 | [`15-extensibility.md`](./15-extensibility.md) | Plugins, skills, commands, hooks, workflows, MCP/ACP depth |
| 16 | [`16-operations.md`](./16-operations.md) | Install & release integrity, CI gates, observability, diagnostics, security ops, runbooks |
| 24 | [`24-feature-catalog.md`](./24-feature-catalog.md) | Parity matrix vs the eight primary references (+ the six-source A.9 addendum) + every new feature (NF-001…NF-075) |
| 25 | [`25-roadmap-and-glossary.md`](./25-roadmap-and-glossary.md) | M0–M8 roadmap (Foundation → Self-improvement) with exit criteria + the full glossary |
| 26 | [`26-learning-synthesis-2.md`](./26-learning-synthesis-2.md) | Second deep-dive learning record: ten-repo distillation, adoption ledger (NF-051…NF-062), doc-update ledger |
| 27 | [`27-implementation-plan.md`](./27-implementation-plan.md) | The build plan: bootstrap, workstreams, runtime viability, subagent build-out, gates, open ADRs |
| 28 | [`28-implementation-status.md`](./28-implementation-status.md) | **Implemented-vs-designed map with evidence commands — the single source of truth for implementation status** |
| 29 | [`29-final-audit.md`](./29-final-audit.md) | Final deep audit: twelve-repo completeness pass, merged/unique findings, optimization analysis, docs-staleness ledger |
| 30 | [`30-steal-list.md`](./30-steal-list.md) | Adoption shortlist: the consolidated steal list across aider, mini-swe-agent, hermes-agent and oh-my-pi (pass-3 audits) + the action queue — adopted by RC-15 (NF-071…NF-075; A.9 sources) |
| — | [`_conventions.md`](./_conventions.md) | Canonical names, packages, crates, capability IDs, events, status levels, and §11 **ratified cross-document decisions (RC-1…RC-17)** |

---

## The seven things to remember

1. **The model proposes; the kernel disposes.** No effect bypasses Guard.
2. **Terminal-first, protocol-first.** The TUI is the product; every other surface is a client of the same Controller.
3. **Every mutation leaves a receipt**, and `UNKNOWN` is a terminal state, never a retry.
4. **One `llm.stream` per step.** No hidden in-memory tool loop.
5. **Cache prefix stability is a CI contract.**
6. **Workspace config may only narrow user config.**
7. **Self-improvement never widens authority.**

(Normative form: `01-vision-and-superset.md` §1.1 P1–P10; binding form: ADR-001…ADR-016 in `02-decisions.md`. Wording here changes only when those change.)

---

## Status levels (used everywhere)

`DESIGNED` → `CODE_PRESENT` → `WIRED` → `TESTED` → `VERIFIED` → `RELEASED`

Every capability carries a level. Levels above `DESIGNED` exist only in `docs/28-implementation-status.md` — the **single source of truth** (RC-13); every capability not listed there is `DESIGNED`.

**Document classes (RC-14).** Every document declares what kind of document it is — *contract* (normative: schemas and protocol), *decision record* (binding on design: ADRs and rulings), or *historical* (no normative force: learning records, plans, audits, queues). Which document owns which kind of truth is the authority-by-concern table in [`_conventions.md`](./_conventions.md) §11 (RC-14).

---

## Relationship to upstream work

HorizonCode inherits ideas and (where licensed) code from `anomalyco/opencode`, `openai/codex`, `xai-org/grok-build`, `esengine/DeepSeek-Reasonix`, `can1357/oh-my-pi`, `tailcallhq/forgecode`, `sarv-projects/horizoncode` and the leaked `codeaashu/claude-code` reference. Derivative work is tracked with attribution and a pinned upstream revision (ADR-014). Reference clones used for this design live under `/data/home/forge/repo-tour/`.
