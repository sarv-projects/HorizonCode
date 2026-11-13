# R170 Reconciliation Latch Continuity — Batch 2 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and superpowers:test-driven-development. The owner requested inline backlog execution without intermediate approval prompts.

**Goal:** Keep unresolved reconciliation barriers active across turns and runtime restarts, and prevent mutations with unknown resource targets from bypassing the gate.

**Architecture:** Keep effect evidence in the existing `effects.jsonl`/kernel session logs. Add a tiny versioned, append-only latch state log under kernel state with explicit latch/release events. Reuse `effect-reconcile-block.ts` for assessment, mutator refusal and UI projection; do not reinterpret UNKNOWN as safe, auto-release on a clean turn, or change the default opt-in posture.

**Tech Stack:** Bun/TypeScript, Rust kernel's existing event protocol unchanged, existing Bun test harness.

**Spec:** `docs/13-tui.md` R170; `docs/FULL-BACKLOG-2026-11-13.md` §Z/A; `docs/28-implementation-status.md` ruling 343.

## Global Constraints
- Uncommitted Batch 1 changes must remain untouched.
- No shell-net enforcement claim; no root LICENSE invention.
- `HZ_EFFECT_RECONCILE_BLOCK` remains opt-in; do not advertise full R170 enforcement.
- Unknown/unattributed mutating target is refused under an active resource latch; a known disjoint target is allowed.
- Read-only tools unaffected; releasing a latch requires an explicit clean reconciliation check.
- Record tests and honest limits; do not commit or push without user request.

## Review Focus
1. Crash/restart after latch before explicit release: mutation remains blocked.
2. Concurrent user clears a latch: stale in-memory data must not resurrect an obsolete latch.
3. Ledger mismatch before the first turn's end-of-run callback: mutation must be refused at admission.
4. Shell with any cwd/path hint under a resource latch: fail closed because cwd is not an exhaustive resource map; known disjoint FILE mutations still allowed.
5. Normal read paths and gate-off posture: do not create latch side effects or regress behavior. Add clean-first-write and existing symlink-alias regression (hardlink/TOCTOU explicitly out of scope).

---

### Task 1 — Sticky latch and fail-closed resource overlap
**Files:** `app/src/core/effect-reconcile-block.ts`, `app/tests/core/effect-reconcile-block.test.ts`
**Interface:** preserve `latchEffectReconcileBlock(...)` and `effectReconcileBlockRefusal(...)`.
- [x] Write failing tests for clean end-of-turn assessment retaining a latch and resource-mode unscoped shell refusal.
- [x] Run `bun test tests/core/effect-reconcile-block.test.ts`; expect assertions to fail.
- [x] Implement sticky latch and unknown-target refusal; only explicit `tryReleaseEffectReconcileBlock` clears.
- [x] Run the affected tests; expect 0 failures.

### Task 2 — Durable latch and first-mutation preflight
**Files:** create `app/src/core/effect-reconcile-latch-store.ts`; modify `effect-reconcile-block.ts`, `loop.ts`, `index.ts`; tests `effect-reconcile-block.test.ts`, `effect-reconcile-block-loop.test.ts`.
**Interface:** `loadReconcileLatch(workspace,sessionId)`, `appendReconcileLatch(workspace,sessionId,latch|null)`; extend `effectReconcileBlockRefusal(workspace,sessionId,tool,args?,host?)` for admission-time assessment.
- [x] Write failing tests for restart hydration, release persistence, and preflight refusal before an explicit end-of-turn latch.
- [x] Run tests and observe failures caused by absent behavior.
- [x] Implement versioned append-only latch journal, read latest event per session, persist state changes and clean releases; no silent automatic release.
- [x] Wire admission host to loop/direct facade, add regression for unknown target/disjoint paths.
- [x] Run focused tests and typecheck.

### Task 3 — Integration, status docs, final verification
**Files:** `docs/28-implementation-status.md`, `docs/GOAL-PROGRESS.md`, `docs/FULL-BACKLOG-2026-11-13.md`.
- [x] Run targeted `bun test` including existing runtime, unknown TUI, and reconciliation tests; fix regressions.
- [x] Run `bun run typecheck` and `git -c core.whitespace=cr-at-eol diff --check`.
- [x] Reconcile documentation to actual status (still partial R170), note WSL sandbox/full-suite gate caveat.
- [x] Review diff for release safety; leave branch uncommitted.
