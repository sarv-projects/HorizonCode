# Pure Seams Wiring and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the standalone upstream mechanisms (thinking budget, declarative output minimizer, subagent mailbox delivery, reverse JSONL scanner, and diagnostic server inspection) into the active runtime and tool pipelines without breaking existing contracts or adding third-party dependencies.

**Architecture:** Each task connects an existing pure component (from rulings 841–848) to its live call site in `app/src/core/loop.ts`, `app/src/tools/shell.ts`, `app/src/core/subagent.ts`, or `app/src/core/doctor.ts`. Every integration is additive, preserves frozen contracts in `app/src/contracts.ts`, and includes targeted hermetic unit tests.

**Tech Stack:** TypeScript on Bun (`app/`), zero runtime dependencies, `bun test`, `bun run typecheck`.

**Spec:** `docs/28-implementation-status.md` §3 (rulings through **854**), `docs/FULL-BACKLOG-2026-11-13.md`, `app/src/contracts.ts`.

---

## Global Constraints

- Goal is **NOT COMPLETE**; nothing here claims v1 or a release.
- **Never** claim shell-net egress **`enforced`**.
- `app/src/contracts.ts` is additive-only.
- Zero new runtime dependencies; zero external npm packages.
- All tests are hermetic and runnable via `bun test`.
- When the owner asks for a commit, use one commit with docs + implementation together, authored by the owner git identity only.

---

## Tasks

### Task 1: Wire Thinking-Token Budget into `app/src/core/loop.ts`

**Files:**
- Modify: `app/src/core/loop.ts`
- Test: `app/tests/core/thinking-budget-loop.test.ts` (new)

**Context:**
`app/src/core/thinking-budget.ts` ports the bounded thinking-token cap (bytes/4 convention). Currently `loop.ts` accumulates `turn.thinkingText` without budget enforcement.

- [ ] **Step 1: Write the failing test in `app/tests/core/thinking-budget-loop.test.ts`**
  Verify that when `thinkingBudget` is provided in `LoopDeps`, thinking events are clamped/exhausted at the cap, preventing unbounded thinking accumulation.

- [ ] **Step 2: Run test to verify failure**
  `cd app && bun test tests/core/thinking-budget-loop.test.ts`

- [ ] **Step 3: Implement wiring in `app/src/core/loop.ts`**
  Add optional `thinkingBudget?: ThinkingBudget` to `LoopDeps`. In the stream loop under `event.type === "thinking"`, pass `event.text` to `thinkingBudget.add()`. If not admitted, drop the text from `turn.thinkingText` and emit a notice.

- [ ] **Step 4: Verify test passes and typecheck is clean**
  `cd app && bun test tests/core/thinking-budget-loop.test.ts && bun run typecheck`

---

### Task 2: Wire Declarative Output Minimizer into `app/src/tools/shell.ts`

**Files:**
- Modify: `app/src/tools/shell.ts`
- Test: `app/tests/tools/shell-output-minimizer.test.ts` (new)

**Context:**
`app/src/core/output-minimizer.ts` provides `minimiseOutput(command, output, filters)`. Currently `shell.ts` only has hardcoded regex stripping.

- [ ] **Step 1: Write the failing test in `app/tests/tools/shell-output-minimizer.test.ts`**
  Verify that custom/declarative minimizer filters can match command patterns (e.g. `git status`) and apply line truncation/ANSI stripping before raw spill and model formatting.

- [ ] **Step 2: Run test to verify failure**
  `cd app && bun test tests/tools/shell-output-minimizer.test.ts`

- [ ] **Step 3: Implement wiring in `app/src/tools/shell.ts`**
  Import `minimiseOutput` and integrate optional filter application in `shell.ts` output processing.

- [ ] **Step 4: Verify test passes and typecheck is clean**
  `cd app && bun test tests/tools/shell-output-minimizer.test.ts && bun run typecheck`

---

### Task 3: Wire Subagent Mailbox into Delegation Lifecycle (`subagent.ts`)

**Files:**
- Modify: `app/src/core/subagent.ts`
- Test: `app/tests/core/subagent-inbox-delivery.test.ts` (new)

**Context:**
`app/src/core/subagent-inbox.ts` and `app/src/core/subagent-delivery.ts` provide agent identity and bounded FIFO mailboxes.

- [ ] **Step 1: Write the failing test in `app/tests/core/subagent-inbox-delivery.test.ts`**
  Prove that during a nested run, messages posted to the subagent inbox can be drained by agent identity.

- [ ] **Step 2: Run test to verify failure**
  `cd app && bun test tests/core/subagent-inbox-delivery.test.ts`

- [ ] **Step 3: Implement in `app/src/core/subagent.ts`**
  Add optional `inbox?: SubagentInbox` support to `NestedRunOptions`. Wire message posting and draining during child run lifecycle.

- [ ] **Step 4: Verify test passes and typecheck is clean**
  `cd app && bun test tests/core/subagent-inbox-delivery.test.ts && bun run typecheck`

---

### Task 4: Wire Reverse JSONL Scanner into Session Rollout Inspection

**Files:**
- Modify: `app/src/core/session.ts`
- Test: `app/tests/core/session-reverse-scan.test.ts` (new)

**Context:**
`app/src/core/reverse-jsonl-scanner.ts` scans NDJSON records from newest to oldest within byte boundaries.

- [ ] **Step 1: Write failing test in `app/tests/core/session-reverse-scan.test.ts`**
  Prove that a session event log can have its latest records scanned in reverse order using `scanReverseJsonl` without reading the entire log into memory.

- [ ] **Step 2: Run test to verify failure**
  `cd app && bun test tests/core/session-reverse-scan.test.ts`

- [ ] **Step 3: Implement helper in `app/src/core/session.ts`**
  Add `scanRecentSessionEvents(jsonlBuffer, maxRecords)` using `scanReverseJsonl`.

- [ ] **Step 4: Verify test passes and typecheck is clean**
  `cd app && bun test tests/core/session-reverse-scan.test.ts && bun run typecheck`

---

### Task 5: Wire Diag Server Model into `hzcode doctor`

**Files:**
- Modify: `app/src/core/doctor.ts`
- Test: `app/tests/core/doctor-diag-server.test.ts` (new)

**Context:**
`app/src/core/diag-server.ts` provides `/ready`, `/statusz`, and `/logs` response models.

- [ ] **Step 1: Write failing test in `app/tests/core/doctor-diag-server.test.ts`**
  Verify that `hzcode doctor` includes a diagnostic probe check `doctor.diag_model` that verifies readiness and status models.

- [ ] **Step 2: Run test to verify failure**
  `cd app && bun test tests/core/doctor-diag-server.test.ts`

- [ ] **Step 3: Implement check in `app/src/core/doctor.ts`**
  Add `checkDiagServerModel()` in `doctor.ts` registered in the doctor checks.

- [ ] **Step 4: Verify test passes and typecheck is clean**
  `cd app && bun test tests/core/doctor-diag-server.test.ts && bun run typecheck`

---

### Task 6: Documentation and Ruling Updates

**Files:**
- Modify: `docs/28-implementation-status.md`
- Modify: `docs/FULL-BACKLOG-2026-11-13.md`

- [ ] **Step 1: Add rulings 855+ in `docs/28-implementation-status.md` §3**
- [ ] **Step 2: Update status rows in `FULL-BACKLOG` and `GOAL-PROGRESS`**
- [ ] **Step 3: Final typecheck and test verification**
