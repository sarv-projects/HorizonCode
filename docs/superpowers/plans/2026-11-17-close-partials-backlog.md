# Close PARTIALs + Clear Backlog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Drive every audit PARTIAL toward wired/TESTED slices, clear §C OPEN residuals, advance P0 spine; never claim shell-net `enforced`; LICENSE deferred; speculation stays UNWIRED (ruling 65).

**Architecture:** Ship in §Z order with concurrent honesty/security seams. Each slice: failing test → code → targeted bun/cargo → ruling in `docs/28` + backlog/GOAL updates in the same change set.

**Tech Stack:** Bun TypeScript (`app/`), Rust kernel (`kernel/`), existing NDJSON kernel ABI, zero new runtime deps.

**Spec:** `docs/FULL-BACKLOG-2026-11-13.md` §Z/§A/§C; `docs/GOAL-PROGRESS.md`; audit findings 2026-11-17.

## Global Constraints

- Never claim product shell-net egress `enforced`
- No root `LICENSE` until owner adds one
- Speculation remains UNWIRED (ruling 65)
- Additive contracts only in `app/src/contracts.ts`
- Docs + implementation together when owner says commit
- `HZ_EFFECT_HOST_KERNEL=require` is the honesty gate; expand coverage, do not silently ambient-execute

## Review Focus

1. Opt-in durable todo / handoff / MEMORY.md must not mutate without matching Guard admission
2. Product steer must not approve or mutate; text-only into live channel
3. Product egress path must report residual honestly (never `enforced`)
4. Universal EffectHost must refuse unsupported entrypoints under require, not Bun-fallback
5. R170 default-on must not deadlock read-only tools

---

### Task 1: Under-admission mutation seams

**Files:**
- Modify: `app/src/tools/todo.ts`, `app/src/tools/handoff.ts`, `app/src/core/memory/manifest.ts`, `app/src/core/loop.ts` (admission)
- Test: `app/tests/tools/under-admission-guard.test.ts` (new)

- [ ] RED: durable todo write without `fs.write` admit fails closed / or requires guard
- [ ] GREEN: wire `ctx.guard({kind:"fs.write", target})` before durable/MEMORY.md/handoff mutate
- [ ] Update doctor hints if needed

### Task 2: Docs honesty refresh

**Files:** `docs/FULL-BACKLOG-2026-11-13.md` §0, `docs/00-index.md`, `docs/09-tools.md`, `ops/ci/github-actions.yml` timeout, `ops/gate-catalogue.md` NOTICE line

- [ ] §0 → current `main` SHA + ruling 537
- [ ] 00-index watermark 537; Goal NOT COMPLETE first
- [ ] 09-tools: 28 registered list
- [ ] CI timeout-minutes ≥ 60

### Task 3: Wire C-9 product Responses steer

**Files:** `app/src/core/providers/openai.ts` (or responses path), `app/src/core/index.ts`, tests

- [ ] RED: with `HZ_RESPONSES_STEER=1`, provider constructs wire and pumps LiveSteeringChannel
- [ ] GREEN: hermetic fake WS; product opt-in only
- [ ] Docs/backlog C-9 residual update

### Task 4: EffectHost — refuse more ambient under require + extend routes

**Files:** effect-kernel-mutation-route, loop, MCP dispatch, hooks mutation paths

- [ ] RED: code_mode/MCP/hooks/todo-durable mutate refused under `=require` without kernel route
- [ ] GREEN: refuse or route; doctor residual honest
- [ ] Advance toward universal own-or-refuse

### Task 5: R170 — default-on session barrier for mutating tools

**Files:** effect-reconcile-block, effect-host-runtime, createRuntime

- [ ] RED: with product default, UNKNOWN/observe-pending blocks next mutator
- [ ] GREEN: read-only still works; opt-out env preserved
- [ ] Honesty: not full kernel R170 until Bun/kernel atomic

### Task 6: Product egress path (honest, not enforced)

**Files:** sandbox-spawn, egress-env, doctor

- [ ] Wire product default routed path when `HZ_SANDBOX_NETNS=1` already present
- [ ] Doctor states residual; never `enforced`
- [ ] Smoke stays advisory

### Task 7: §C residual closures (B-4, C-11, C-12, H-2, …)

Close what can be TESTED without live keys; mark external residuals explicitly.

### Task 8: Ruling + GOAL + FULL-BACKLOG sync

Numbered ruling ≥538; refresh counts; never claim P0 closed unless done bars met.
