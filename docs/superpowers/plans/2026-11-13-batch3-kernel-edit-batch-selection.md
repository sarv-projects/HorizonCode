# Batch 3 — Kernel Edit Repair and Resumable Batch Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans with test-driven-development; this plan executes inline as the user asked to continue.

**Goal:** Improve kernel-owned fs.edit parity, and deliver reproducible selected subsets for the J-2 resumable batch CLI.

**Architecture:** Keep kernel `effect.execute` and its existing `fs.edit` contract unchanged, but add one unambiguous relative-indent matching rung and new-text reindentation under the existing opt-in repair flag. Separately, add pure, deterministic batch selection before pending/resume filtering. No new runtime authority claims or job execution engine.

**Tech stack:** Rust kernel + Cargo unit/integration tests; TypeScript/Bun tests and CLI.

**Spec:** `docs/FULL-BACKLOG-2026-11-13.md` §Z and §C (J-2); `docs/28-implementation-status.md` §3, `docs/09-tools.md`.

## Global Constraints
- Preserve prior uncommitted batches on `fix/p0-effecthost-batch1`; no git commit/push.
- No kernel-owned EffectHost completion claim; no shell-net `enforced`; no root LICENSE.
- All repair rungs must refuse ambiguous candidates; default off keeps exact-only behavior.
- Batch selection only plans executions; it does not run jobs or alter JSONL status.
- Update docs through a numbered ruling with test evidence and residuals.

## Review Focus
- Relative indentation preserves nested indentation on replacement and refuses duplicate normalized windows.
- Only opt-in kernel repair may change indentation, and the bytes observed are real postimage.
- Batch shuffle is stable across process runs with the same seed and row IDs.
- Filter/slice errors fail loudly; selection cannot silently include previously done/failed rows.
- End-to-end CLI dry-run and status remain honest about lack of execution engine.

---

### Task 1: Kernel fs.edit relative-indent repair
**Files:** `kernel/src/effect_host_edit_repair.rs`, `kernel/src/effect_host.rs`, `app/tests/core/effect-execute-kernel.test.ts`.
**Interfaces:** Preserve `resolve_kernel_fs_edit_old_string(content,old)` and `effect.execute` wire; add repair-specific matched-indent metadata to resolver output.
- [x] Write failing Rust and/or kernel E2E cases for unique indented replacement, off-mode refusal, and ambiguous normalized duplicates.
- [x] Run red tests and confirm behavior gap.
- [x] Implement relative-indent candidate matching, replacement reindentation, and ambiguous refusal.
- [x] Run Rust targeted tests and Bun kernel integration tests.

### Task 2: J-2 deterministic batch selection
**Files:** `app/src/core/batch-runner.ts`, `app/src/batch-run.ts`, `app/tests/core/batch-runner.test.ts`, `app/tests/core/batch-run.test.ts`.
**Interfaces:** Selection utility `selectBatchRows(rows,opts)` and CLI `--filter <substring>`, `--slice <start:end>`, `--shuffle [seed]` with reproducible order.
- [x] Write failing pure selection and CLI tests for stable ordering, invalid args and resume.
- [x] Run red tests and confirm failures.
- [x] Implement pure deterministic selection and strict CLI parsing; no write-back from selection.
- [x] Run targeted tests and typecheck.

### Task 3: Documentation and gates
**Files:** `docs/28-implementation-status.md`, `docs/GOAL-PROGRESS.md`, `docs/FULL-BACKLOG-2026-11-13.md`, optionally `docs/09-tools.md`.
- [x] Update truthful status ruling 345; note still-open kernel parity and J-2 runner snapshot/execution work.
- [x] Run Rust kernel tests, broad Bun tests / typecheck, and git diff check.
- [x] Report exact commands, successes, failures and unresolved work; leave uncommitted.

## Verification record (2026-11-13)
- TDD red observed: missing Rust indent metadata/render, missing TypeScript edit renderer and batch selector, ignored batch flags, wrong empty-selection message, and UTF-8 panic in the Rust newline span mapper.
- Green: Rust edit-specific 8/8; trusted Rust kernel edit postimage E2E; Rust kernel unit 111/111 with expensive 20k-chain test filtered; Rust integration 58/58; TypeScript check PASS; Bun targeted suite 259/259 across 33 files.
- Formatting check: full cargo fmt --check NOT GREEN; unrelated pre-existing sandbox-exec formatting drift shown. No mass reformat; git diff --check PASS.
- User requested continued execution; no commit or push performed. Further P0 authority, R170, egress and batch execution remain OPEN.
