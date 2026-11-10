# 08 — Runtime: Controller, agent loop, fleets, budgets, learning

**Document status:** DESIGNED (see §11), *as a specification of the full orchestration plane*. **Implementation status (final audit, 2026-11-06):** a v0.1 slice of the loop exists — `app/src/core/loop.ts` (stream → guard → approve → tool → receipt → events), sessions over SQLite, per-session event streams, subagent delegation through the `agent` tool (child session, nested loop, base-seven tools), and code mode / preview — with evidence in `docs/28-implementation-status.md`; the planner/executor, teams, scheduler and budgets described below remain design, and every module path below marks an artifact to be built (paths under `app/` that exist are the exception and are named in `docs/28`).

---

## 1. Purpose

This document decides the behaviour of **plane 2 (Orchestration)** in `_conventions.md` §2 - the one `Controller`, the session engine, the step engine, the agent-loop state machine, interruption / steering / queueing, retry and fallback policy, the dual-model Planner/Executor routing table, plan mode, todos and goals, the subagent fleet and teams, the scheduler, the self-improvement loop, budgets and leases, and long-horizon operation.

Out of scope, owned elsewhere:

| Concern | Owner document |
|---|---|
| Context compiler, cache guard, compaction, memory, prompts | `10-cognition.md` |
| Guard, policy DSL, kernel leases, receipts, reconciliation, sandbox | `11-authority-safety.md` |
| Session storage, event log, projections, checkpoints, fork/rewind | `12-sessions-state.md` and `06-events-and-flows.md` |
| Tool declarations, wire protocol, surfaces | `04-lld.md`, `14-surfaces.md` |
| Schema definitions | `05-domain-and-schemas.md` |

Canonical names used here (`hzcode`, `hzk`, `hz://`, `@horizoncode/*`, `hz_*`, `hz.*` events, capability IDs, status levels) are defined in `_conventions.md` and are used verbatim.

**Derivation sources** (per writing rule `source: <repo> <path>`; the exact GitHub URLs of the upstream repositories read for this plane, at their pinned commits, are in the Provenance section at the end of this document and in `research/upstream-pins.md`; the older ancestor paths recorded in `01-vision-and-superset.md` were not re-verified):

```text
source: opencode    — session/step core, one provider call per step, inbox admission
source: claude-code — subagent classes, todos/g oals, skills, background consolidation
source: codex       — approval flows and plan-then-execute
source: Reasonix    — one controller / many front-ends
source: oh-my-pi    — native capability boundaries
source: ForgeCode   — clean architecture, typed tool specs
```

---

## 2. Rules

MUST / SHOULD / MAY follow RFC 2119 usage. Every rule is individually testable; §9 names the test that falsifies it. Rules are grouped by the mechanism they constrain.

### 2.1 Step engine

The step is the single unit of provider interaction. `StepEngine.runStep` is the only function in the product that calls a provider.

| # | Rule |
|---|---|
| **R-runtime-1** | A step MUST execute these phases in order, with no phase skipped and no phase repeated: **(1)** load history from the durable event log, **(2)** compile context (`@horizoncode/context`), **(3)** issue **exactly one** `llm.stream` call, **(4)** reduce the streamed assistant output into parts + a tool-call batch, **(5)** apply the tool batch, **(6)** close the step by appending a `StepRecordV1`. |
| **R-runtime-2** | There MUST be at most one `hz.step.llm.requested` event per step. A retried request is a new *attempt* of the same step recorded inside the same `StepRecordV1`, not a new step (see R-runtime-34). |
| **R-runtime-3** | A step MUST reload all input state from durable artifacts. No in-memory state may carry from step N to step N+1 except through (a) the event log, and (b) the immutable projections folded from it. |
| **R-runtime-4** | Work MUST be admitted only under a write-ahead claim. `hz.session.claim.acquired` precedes any provider call; `hz.session.claim.released` is emitted only with a terminal outcome, using the `reason` enum of that event (`succeeded` · `failed` · `interrupted` · `superseded` · `expired`, `06-events-and-flows.md` row 4). Step outcomes (`answered` · `tool_batch` · `interrupted` · `failed` · `exhausted`) are recorded on the step, not on the claim. |
| **R-runtime-5** | Claim release and claim acquisition MUST be durable before the next step starts, so that a crash between steps leaves a recoverable, unambiguous state (see R-runtime-113). |
| **R-runtime-6** | A step MUST end in exactly one *step outcome* (`answered` · `tool_batch` · `interrupted` · `failed` · `exhausted`) and MUST emit `hz.step.started` at phase 1 and one terminal step event at phase 6. |
| **R-runtime-7** | Any state a future step depends on MUST exist as a durable event first. State that exists only in memory is a defect: the fail-closed behaviour in §5 applies. |
| **R-runtime-8** | Tool calls inside one batch MUST be scheduled on a resource-key basis: calls whose resource keys are disjoint and whose tools declare a read-only or concurrency-safe class MAY run in parallel; calls sharing a resource key MUST serialise in declared order, and calls with `effect_class != read-only` on the same resource MUST serialise on that resource. |

Phase → emission table (the contract other documents rely on):

| Phase | Reads | Writes / emits | Fail-closed if |
|---|---|---|---|
| 1 load history | event log, projections | `hz.step.started` | log unreadable / claim missing |
| 2 compile context | memory, skills index, goals, todos, retrievals, config | context digest recorded in `StepRecordV1` | cache-guard reports prefix drift |
| 3 `llm.stream` | provider config, model chain (R-runtime-39) | `hz.step.llm.requested`, `hz.step.llm.delta`, `hz.step.llm.completed` | no role-compatible model in chain |
| 4 reduce | stream deltas | `hz.part.created`, `hz.part.updated` | malformed tool-call arguments |
| 5 apply batch | tool declarations, Guard decisions | `hz.step.tool.requested`, `hz.step.tool.completed`, `hz.effect.*` | missing/expired one-use lease |
| 6 close step | — | `StepRecordV1`, `hz.usage.recorded`, claim release | terminal event not durably written |

### 2.2 Controller and front-end parity

| # | Rule |
|---|---|
| **R-runtime-9** | There MUST be exactly one `Controller` per host process, owning run loops and session lifecycle. Every front-end (TUI, print/headless, server, web, desktop, IDE/ACP bridge, MCP server, SDK) drives it through `Controller.submit`. |
| **R-runtime-10** | `Controller` MUST be transport-agnostic: it MUST NOT import terminal, socket, HTTP, React or Electron code. Its dependencies are `SubmitRequest` in, `HzEvent` out. |
| **R-runtime-11** | No front-end may implement decision logic. A CI **parity ratchet** gate fails the build if `@horizoncode/core` contains a front-end-specific branch (surface name appearing in a behavioural condition). |
| **R-runtime-12** | Every behaviour a front-end can trigger MUST be expressible as (a) a protocol request and (b) an `hz.*` event. A behaviour that cannot be expressed that way MUST NOT ship. |
| **R-runtime-13** | The Controller is the sole writer of session state. Attached front-ends are concurrent readers plus submitters; conflicting submissions MUST be serialised by the Controller, not by the client. |
| **R-runtime-14** | Detaching a front-end MUST NOT cancel a run. Only an explicit interrupt request (R-runtime-21–R-runtime-26) or a budget/lease decision ends work. |
| **R-runtime-15** | Concurrent submissions to one session MUST be ordered by admission (R-runtime-27–R-runtime-32) and MUST NOT interleave inside a step. |

### 2.3 Agent-loop state machine

The run loop is a single-writer state machine per session. States: `idle` · `busy` · `awaiting-approval` · `awaiting-user` · `compacting` · `error` · `completed`. These seven are the `LoopStateV1` schema of `05-domain-and-schemas.md` §4.6, and the durable `SessionV1.state` is their projection (`awaiting_approval`→`waiting_approval`, `awaiting_user`→`waiting_approval`, `compacting`→`busy`, `error`→`failed`; `blocked` and `archived` are durable-only and set outside the loop). Transitions are functions of *events and decisions*, never of wall-clock time alone.

| From | Trigger | Guard | To | Emitted | Side effects |
|---|---|---|---|---|---|
| `idle` | prompt admitted (steer/queue), inbox non-empty | claim acquirable | `busy` | `hz.session.prompt.admitted`, `hz.session.claim.acquired`, `hz.session.busy.entered` | start `StepEngine.runStep` |
| `idle` | goal closed and inbox empty | — | `completed` | `hz.goal.updated` | release claim (none held) |
| `busy` | step closes `answered`, goal still open, inbox non-empty | budget remaining | `busy` | `hz.step.*` | next `runStep` |
| `busy` | step closes `tool_batch` with pending asks | Guard returned `ask` | `awaiting-approval` | `hz.permission.asked` | suspend batch on the asking tool only |
| `busy` | step needs information only a human has (`ask_user`, `brief`) | — | `awaiting-user` | `hz.part.created` | no tools scheduled |
| `busy` | compaction trigger threshold reached | — | `compacting` | `hz.session.compacted` on completion | context rebuilt; step *not* retried |
| `busy` | step closes `answered`, goal open, inbox empty | unattended mode **or** non-interactive | `idle` | `hz.session.busy.left`, `hz.session.claim.released` | run parked, resumable |
| `busy` | step closes `failed` / `exhausted` | recoverable class (R-runtime-33) | `error` | `hz.error.raised` | claim retained for resume |
| `busy` | step closes `interrupted` | — | `idle` | `hz.session.busy.left`, `hz.session.claim.released` | partial parts kept, incomplete effects reconciled |
| `awaiting-approval` | `hz.permission.answered` = allow | lease issued | `busy` | `hz.effect.lease.issued` | resume suspended batch |
| `awaiting-approval` | `hz.permission.answered` = deny | — | `busy` | `hz.effect.decision.made` | tool call settled `denied`; model informs |
| `awaiting-approval` | interrupt (soft/hard) | — | `idle` | `hz.permission.answered` (`denied-by-interrupt`) | batch abandoned, not retried |
| `awaiting-approval` | ask deadline expires | policy `ask_timeout_action=deny` (default) | `busy` | `hz.effect.decision.made` | fail-closed deny |
| `awaiting-user` | user reply admitted | — | `busy` | `hz.session.prompt.admitted` | reply injected as next step input |
| `awaiting-user` | interrupt | — | `idle` | `hz.session.busy.left` | question closed unanswered |
| `compacting` | compaction completes | — | `busy` | `hz.session.compacted` | next step recompiles context |
| `compacting` | compaction fails, retry budget left | — | `compacting` | `hz.error.raised` (warning) | retry alternative strategy |
| `compacting` | compaction fails, budget spent | — | `error` | `hz.error.raised` | claim retained; resume recompiles without compaction |
| `error` | resume requested | claim present in log | `busy` | `hz.session.claim.acquired` | resume from last durable step boundary |
| `error` | terminate requested | — | `idle` | `hz.session.claim.released` | workspace left as-is; snapshot optional |
| `error` | unattended watchdog expiry | — | `idle` | `hz.session.busy.left` | parked for a human |
| `completed` | new prompt admitted | plan/goal reopened by admission | `busy` | `hz.session.prompt.admitted` | new claim |
| `any` | kernel denies session (`posture=deny`) | — | `error` | `hz.effect.decision.made` | no provider call is made |

| # | Rule |
|---|---|
| **R-runtime-16** | Exactly one state MUST be current per session; every transition MUST be appended to the log before it takes observable effect (write-ahead). |
| **R-runtime-17** | `completed` and `error` are terminal-until-input: reaching either MUST release or explicitly retain the claim, and MUST state which (R-runtime-4). |
| **R-runtime-18** | `awaiting-approval` and `awaiting-user` MUST NOT hold provider streams open; the stream is closed before entering them. |
| **R-runtime-19** | `compacting` MUST NOT run while another session in the same workspace holds a writer claim on the same worktree (worktree is single-writer). |
| **R-runtime-20** | A transition not present in the table above MUST be rejected by the state machine (fail-closed, §5) rather than coerced. |

### 2.4 Interruption and cooperative cancellation

| # | Rule |
|---|---|
| **R-runtime-21** | Cancellation MUST use a token tree: every child context (subagent, shell job, scheduled run, watcher) receives a child token of its parent; cancelling a parent MUST cancel descendants. |
| **R-runtime-22** | There MUST be two interrupt strengths. **Soft** = stop after the current phase-5 batch, before the next `llm.stream`; **hard** = abort the in-flight stream and abort abortable tools. Default keybinding = soft; a second interrupt within 2 s escalates to hard. |
| **R-runtime-23** | Every tool declaration MUST state `abortable: true|false`. A tool declaring `abortable: false` MUST also declare a bounded execution ceiling (time or output); unbounded non-abortable tools MUST NOT be registered. |
| **R-runtime-24** | A tool that ignores cancellation MUST be terminated at the process boundary by the authority plane (`hz_pty` / kernel supervisor), never by in-process hope; the runtime waits at most the tool's declared termination grace (default 2 s) before escalating. |
| **R-runtime-25** | Aborting a tool that may already have mutated state MUST settle the effect as `UNKNOWN` (`hz.effect.unknown`) unless the kernel can prove non-effect; `UNKNOWN` MUST NOT be retried automatically and MUST go to reconciliation (`hz.effect.reconciled`). |
| **R-runtime-26** | Interrupting a step MUST keep already-emitted parts, marked incomplete (`hz.part.updated` with `incomplete: true`), and MUST close the step as `interrupted`; a partial assistant message MUST NOT be presented as a complete answer. |

### 2.5 Steering versus queueing

| # | Rule |
|---|---|
| **R-runtime-27** | Prompt admission happens *before* execution. `SessionEngine.admit(sessionId, input, mode)` writes to the durable inbox with `mode = steer | queue` and a stable id, and emits `hz.session.prompt.admitted`. |
| **R-runtime-28** | `steer` MUST take effect at the next step boundary: it is folded into the next step's context compile and never mutates a running stream. `queue` MUST take effect only after the current turn reaches a terminal outcome. |
| **R-runtime-29** | Inbox entries MUST survive crash and restart; admission is durable before acknowledgement. Lost input is a defect, not a degradation. |
| **R-runtime-30** | Multiple steers admitted before the same step boundary SHOULD be coalesced into one step input preserving admission order. |
| **R-runtime-31** | A steer MUST NOT widen the tool set, posture, capability grants or model chain of the in-flight step. Steer may influence the *next* step through re-evaluated policy, never through prompt-only authority. |
| **R-runtime-32** | Admission order MUST be FIFO per session and MUST be observable by every attached front-end from the same projection. |

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

**1. Step-allowance accounting:** promoting new input resets the agent's step allowance; a steer batch resets it **once**; queued next-turn prompts reset it at turn start.

**2. Control-item delivery boundaries:** compaction and move are inbox items; a later steer **MUST NOT** cross an undelivered control item (ordering is by `enqueued_seq`, never wall clock).

### 2.6 Retries, backoff and circuit breaking

| # | Rule |
|---|---|
| **R-runtime-33** | Error handling MUST classify first, act second. Classes: **transport** (connection reset, timeout — retryable), **provider-throttle** (429 — retryable with jitter), **provider-transient** (5xx, overloaded — retryable), **provider-permanent** (4xx other than 429, invalid request, content policy — not retryable), **tool-declared** (whatever the tool declares: `retry-safe`, `not-retryable`, `requires-user`), **effect-unknown** (never retried, R-runtime-25). |
| **R-runtime-34** | Retry policy MUST be exponential backoff with full jitter: base 500 ms, factor 2, jitter uniform in `[0, delay]`, cap 30 s, at most 5 attempts per step (initial attempt plus 4 retries). Exhaustion closes the step as `exhausted`. |
| **R-runtime-35** | Retries of phase 3 MUST NOT re-emit `hz.step.started`; each attempt appends an attempt record inside the same step, and the step's `hz.usage.recorded` MUST sum all attempts — tokens spent on failed attempts are real spend. |
| **R-runtime-36** | A circuit breaker MUST exist per `(provider, model)` pair: open after 5 consecutive failures inside 60 s; while open, requests MUST fail fast without a provider call; after a 30 s cooldown exactly one probe (half-open) is allowed; the breaker closes after 2 consecutive probe successes. Breaker state changes MUST be observable (`hz.error.raised` with `class: circuit-open`). |
| **R-runtime-37** | Retries MUST NOT extend the step's wall-clock lease (R-runtime-104): a retry consumes budget, never renews it. A step whose remaining wall-clock budget is below one backoff interval MUST NOT retry. |
| **R-runtime-38** | Response stitching MUST NOT happen: a partially streamed response that failed is discarded in full before a retry. Retrying after an effect was already applied is forbidden — idempotency over optimism. |

### 2.7 Model fallback chains

| # | Rule |
|---|---|
| **R-runtime-39** | The fallback chain MUST be declared configuration (ordered model ids, optional per-class equivalence), resolved **at step start**, never selected mid-stream. |
| **R-runtime-40** | On a mid-stream failure the runtime MUST discard the partial output and try the next candidate in the chain; at most 3 candidates per step; every candidate attempt MUST be recorded in the step record with the reason for the switch. |
| **R-runtime-41** | Each chain entry MUST carry a role tag `planner | executor | any`. A `planner` step MUST NOT use an `executor` entry and vice versa (see R-runtime-45). If no role-compatible candidate remains, the step MUST fail closed with `no-compatible-model` — the runtime MUST NOT silently drop plan mode. |
| **R-runtime-42** | Switching models MUST re-run the context compile for the new model (tool-schema rendering, thinking levels, token accounting). A switch that would leave the cache-guard prefix unverifiable MUST abort the step rather than send a drifted prefix. |
| **R-runtime-43** | Fallback MUST NOT be used to route around policy: a kernel denial is final for that attempt. A different model MUST NOT be tried in the hope of a different decision. |

### 2.8 Dual-model Planner / Executor and host routing

Routing is a **deterministic host decision**. No model call, embedding, classifier or heuristic score may participate in choosing a mode. The decision is a pure function of host-readable facts:

```text
RoutingDecisionV1 route(request, sessionPosture, budgets, agentProfile, planMode)
```

Inputs (all host-readable, no provider call): explicit request mode (`--plan`, `--execute`, `plan_enter`), entry-surface intent (`run`, `exec`, `print`, `serve`, `schedule`, workflow node, skill front-matter), agent profile (`AgentProfileV1` in `@horizoncode/agents`), task-shape facts the host already knows (`files_touched_estimate`, `tool_classes_required`, `expected_effect_class`, `step_budget`, `subagent_requested`), session posture, and cached routing hints from the previous turn (plan opened/closed).

| # | Host condition (evaluated top-down, first match wins) | Mode | Planner | Executor | Approval |
|---|---|---|---|---|---|
| 1 | posture `deny`, or a read-only profile whose request needs a mutating tool class | **plan-only** | planner model, read-only prefix | not used | none until a human re-issues the request |
| 2 | explicit `plan_enter` / `--plan`, or `planMode = true` | **plan-only** | planner | not used | none |
| 3 | read-only posture/profile and the request is satisfiable read-only | **executor-only** | not used | executor, read-only tool scope | none |
| 4 | explicit `plan-for-approval` (CLI flag, skill front-matter, workflow node, `.hz/` config) | **plan-for-approval** | planner | after approval | plan-approval window |
| 5 | `expected_effect_class ∈ {workspace-write, process, network}` **and** (`files_touched_estimate > 3` **or** `tool_classes_required > 2` **or** `subagent_requested`) | **full** | planner | yes | per-effect asks per posture |
| 6 | `expected_effect_class = read-only` **or** `step_budget ≤ 8` **or** request is a single-file edit / single question | **light** | planning folded into the executor model, recorded as `light` | yes | per-effect asks per posture |
| 7 | unattended run (`schedule`, `remote_trigger`, workflow with `unattended: true`) | **full**, `asks_deferred: true` | planner | yes | deferred; default deny (R-runtime-110) |

| # | Rule |
|---|---|
| **R-runtime-44** | `route(...)` MUST be pure, table-driven and total: same inputs ⇒ same mode, always. It MUST be evaluated **before the first step of a turn** and MAY be re-evaluated only at a turn boundary or after an explicit user mode change, with the reason recorded. |
| **R-runtime-45** | Planner and executor context prefixes MUST NOT be mixed. A planner step compiles with the planner prefix; an executor step with the executor prefix; a step that would mix them MUST be refused — this is what keeps the cache guard meaningful. |
| **R-runtime-46** | No classifier is used, for four reasons that are themselves rules: (a) **determinism** — routing must be reproducible from the log; (b) **cost and latency** — a routing call would add a provider round-trip before every task; (c) **cache stability** — a per-task classifier would inject variable content into the prefix, breaking the cache guard; (d) **auditability** — an operator must be able to read the routing table and predict the mode. Ambiguity is resolved by the model *inside* a mode (the planner may ask), never by a hidden chooser. |
| **R-runtime-47** | The planner MUST be read-only with respect to the workspace: planning steps are restricted to `read-only` tool scope and the kernel posture/grants of that session — enforced by policy and capability narrowing, never by prompt text. |
| **R-runtime-48** | `plan-for-approval` MUST produce a `PlanV1` (goal, steps, expected effects, capability set required, budget slice) and emit `hz.plan.updated`, then enter `awaiting-approval`. Execution MAY start only after an explicit `hz.permission.answered` = allow. |
| **R-runtime-49** | `plan-only` MUST terminate the turn with the plan artifact and no workspace effect, and MUST leave plan mode only through an explicit, evented `plan_exit`. |
| **R-runtime-50** | Planner output that is not a valid plan (schema-invalid, no goal, self-contradictory step list) MUST NOT open an approval window; the runtime MUST ask the model again once within the step budget and then fail closed with `plan-invalid`. |
| **R-runtime-51** | Every routing decision MUST be reproducible from the log: the step record and the session projection MUST carry mode, the table row that matched, and a digest of the inputs. |

### 2.9 Plan mode and the approved-plan execution window

| # | Rule |
|---|---|
| **R-runtime-52** | Plan mode is a durable, event-visible session flag toggled by `plan_enter` / `plan_exit`; it MUST survive restart and MUST be visible in posture projections. |
| **R-runtime-53** | Approving a plan MUST open exactly one **execution window**: `{window_id, session_id, plan_id, plan_hash, granted_capability_set, mode, expires_on_turn_end, expires_after_steps, budget_slice}`. |
| **R-runtime-54** | Inside a window, tool calls MUST be checked against `granted_capability_set` ∩ the session's kernel grants. A call inside the set follows the posture path (allow/ask per policy); a call **outside** it MUST re-ask and MUST NEVER be auto-approved. |
| **R-runtime-55** | A window MUST be invalidated by: plan edit (`plan_hash` change), posture change, capability or policy revision change (`hz.policy.revision.changed`), budget exhaustion, user interrupt, turn boundary, or step ceiling reached. After invalidation every further call re-asks. |
| **R-runtime-56** | Plan approval MUST NOT widen authority. The window records a human decision; it never grants a capability the caller did not already hold, and the kernel still authorises every effect with a one-use lease. |
| **R-runtime-57** | Divergence from the approved plan — a tool call not implied by any plan step — MUST be reported as `plan_drift` and MUST itself require approval, even inside a valid window. |

### 2.10 Todos and goals as state machines

`GoalV1.status ∈ {proposed, active, blocked, achieved, abandoned}` (`05-domain-and-schemas.md` §4.8 owns the enum) · `TodoV1.status ∈ {pending, in_progress, completed, blocked, cancelled}`.

| Machine | Transition | Trigger | Guard |
|---|---|---|---|
| Goal | `proposed → active` | first execution step of the turn starts | goal is the session's top goal |
| Goal | `active → blocked` | step failed `exhausted`, or a required effect settled `UNKNOWN` | — |
| Goal | `active → achieved` | independent-evidence gate accepts the completion claim | gate may only lower claims (`11-authority-safety.md`) |
| Goal | `active → abandoned` | user abandon, or unattended watchdog expiry | explicit event |
| Goal | `blocked → active` | resume after reconciliation or human input | blocker resolved |
| Todo | `pending → in_progress` | `todo` tool or `complete_step` | session holds no other `in_progress` todo |
| Todo | `in_progress → completed` | `complete_step` with evidence | evidence required unless the todo is declared `no_evidence` |
| Todo | `in_progress → blocked` | dependency failed or blocked | dependency recorded |
| Todo | `→ cancelled` | plan revision or user action | — |

| # | Rule |
|---|---|
| **R-runtime-58** | A session MUST have at most one `active` goal and at most one `in_progress` todo at any instant. A transition that would violate this MUST be rejected, not coerced (fail-closed). |
| **R-runtime-59** | Goal and todo changes MUST be evented (`hz.goal.updated`, `hz.todo.updated`) and MUST become visible in context only at the next step boundary (R-runtime-28). |
| **R-runtime-60** | Goal `achieved` MUST NOT be settable by the model alone: the model records a **claim**, and the independent-evidence gate may only lower it. |
| **R-runtime-61** | The loop-continuation rule MUST be: continue while `goal ∈ {proposed, active, blocked}` **and** budget remains **and** no interrupt is pending; otherwise park in `idle`, fail, or complete. Nothing else may extend a run. |

### 2.11 Subagent fleet

**Kinds** (all reachable through the same primitive):

| Tool | Kind | Semantics |
|---|---|---|
| `task` | single child | one child, one capsule, one budget slice; parent blocks or continues per `async` flag |
| `parallel_tasks` | graph | several **distinct** `task` specs with `depends_on` edges, `fail_fast` policy, `adopt_ref` result inheritance (`09-tools.md` §4) |
| `fleet` | fan-out | N children of **one** prompt template with per-agent variables, a concurrency ceiling and a settlement strategy (`all` · `collect-first` · `quorum`); no dependency edges (`09-tools.md` §4) |
| `read_only_task` | restricted child | child whose capability grant is `read-only ∩ parent`; cannot mutate anything, ever |

**Construction primitive.** Every child — from any of the four tools, from skills with `runAs: subagent`, from workflows, from teams — MUST be built by exactly one function:

```text
SubagentFactory.spawn(parent: AgentContext, spec: SubagentSpecV1): Promise<AgentHandleV1>
```

`SubagentSpecV1` and `AgentHandleV1` are registered in `05-domain-and-schemas.md` §4.9; the LLD module is `packages/agents/src/fleet/subagent-factory.ts` (`04-lld.md` §3.4 names the same primitive as `agents/spawn.ts` → `spawnChild()`; the boundary test cites this signature).

| # | Rule |
|---|---|
| **R-runtime-62** | All child construction MUST funnel through `SubagentFactory.spawn`. A **boundary test** (§9) enumerates every construction path and fails if any path builds an agent context, provider call, ledger or tool scope without going through the primitive. |
| **R-runtime-63** | `spawn` MUST reject a spec that requests a capability not held by the parent, a depth beyond the limit, a budget slice larger than the parent's remaining budget, or a tool outside the parent's narrowed tool set. Rejection is total: no partial child is created. |
| **R-runtime-64** | A child's capability grant MUST be the **intersection** `parent_grant ∩ requested`. Union, inheritance-by-default and "parent approves on the child's behalf" MUST NOT exist. |
| **R-runtime-65** | A child MUST receive a **context capsule** — `{goal, constraints, curated artifacts (hz://artifact/<sha256>), memory slice, tool list, budget slice, deadline}` — and MUST NOT receive the parent's full transcript unless the spec explicitly sets `inherit: full` (capped at the capsule ceiling, §8). |
| **R-runtime-66** | Budget inheritance MUST be reserve-then-spend: the parent reserves a slice at spawn, the child draws only from its slice, unused budget returns on teardown, and a child's spend MUST NOT exceed the parent's remaining budget even transiently. |
| **R-runtime-67** | Depth limits MUST be enforced at spawn: default maximum depth 3, hard ceiling 5, and each child carries a decremented `remaining_depth`. `remaining_depth = 0` ⇒ leaf-only (no further spawning). |
| **R-runtime-68** | Concurrency ceilings MUST be enforced **globally and per session**: at most 12 live children per root run, 4 live children per session by default, 8 for read-only children, configurable downward only (never upward past the global ceiling). Excess spawns MUST queue with backpressure, not fail silently. |
| **R-runtime-69** | `parallel_tasks` graph semantics MUST be exact, and the tool semantics themselves are owned by `09-tools.md` §4: `depends_on: [ids]` ⇒ a node starts only when every dependency reached `completed`; `fail_fast: true` ⇒ the first node failure cancels all nodes not yet terminal and marks the run `failed`; `adopt_ref` ⇒ a node's output artifact MAY be injected into a dependent node's capsule, referenced by `hz://artifact/<sha256>`, never by transcript text. `fleet` is the edge-free form — identical workers from one template, joined by the declared strategy — and MUST NOT accept `depends_on`. |
| **R-runtime-70** | Failure propagation MUST be: node fails ⇒ dependents become `blocked` (never started) ⇒ the parent receives a structured failure (class, partial artifacts, spend) and decides whether to retry, re-plan or fail the run. A blocked dependent MUST NOT be silently dropped: it MUST be reported in the run result. |
| **R-runtime-71** | A child MUST NOT ask the user directly. A child's `ask` decision MUST surface to the parent as a message; if the parent cannot decide, the ask escalates to the session origin. Origin typing is preserved: a model-originated child request MUST NOT become human authority. |
| **R-runtime-72** | Child results MUST be (a) artifacts in the content-addressed store and (b) a bounded summary. A child's summary is **not** evidence: the independent-evidence gate reads receipts and artifacts, never summaries. |
| **R-runtime-73** | Teardown MUST run on every terminal path (success, failure, cancel, deadline, crash recovery) and MUST: cancel the child token tree; reap its processes and PTYs; release worktrees back to the pool; flush artifacts; settle or mark `UNKNOWN` any unfinished effects; return unused budget; release a concurrency slot; emit `hz.agent.completed` with the terminal outcome. |
| **R-runtime-74** | A child's worktree MUST be isolated (worktree pool) and MUST be writable by exactly one child at a time. Children MUST NOT share a mutable workspace except when the spec explicitly declares a shared root and the parent holds the writer claim. |

### 2.12 Team multi-agent

Teams are long-lived named groups of agents that exchange messages and share artifacts. They are the multi-agent layer above the fleet: a fleet is a call tree that dies with the turn, a team outlives turns and has an identity in `hz://session/<team_id>` terms.

**Roles:** `leader` (exactly one, owns the team's goal decomposition and admission of new members) · `member` (executes assigned work, may claim artifacts) · `observer` (read-only participant: sees the mailbox and artifacts, holds no mutating capability).

| # | Rule |
|---|---|
| **R-runtime-75** | `team_create` MUST declare roles, membership ceiling, message budget, shared-artifact scope and a team wall-clock lifetime; `team_delete` MUST tear the team down (R-runtime-84). |
| **R-runtime-76** | Team state (membership, assignments, leader term, task table) MUST have exactly one writer at a time — the current leader — and MUST be rebuilt from the event log after restart. |
| **R-runtime-77** | Messages MUST travel on a durable bus: each message has a stable id, a sender, a recipient (agent or `broadcast`), a causal parent, and is delivered **at least once**; recipients MUST be idempotent by message id (`hz.agent.message.sent`). Duplicate delivery MUST NOT cause duplicate effects. |
| **R-runtime-78** | Mailbox semantics MUST be: FIFO per recipient; explicit acknowledgement; a declared capacity (default 256 pending messages) with backpressure (sender blocks or receives `mailbox-full`, never silent drop); unacked messages are redelivered on member restart. |
| **R-runtime-79** | `send` MAY be blocking or non-blocking; `receive` MAY block. Every blocking form MUST carry a deadline (default 60 s) and MUST fail with `mailbox-timeout` rather than hang. |
| **R-runtime-80** | Deadlock avoidance MUST be structural: the wait-for graph MUST be acyclic by construction (a member MUST NOT block on a message from a member that is blocked on it); blocking waits MUST always time out; the scheduler MUST be able to run any ready member regardless of blocked members; a blocked leader MUST NOT block team admission of already-committed work. A cyclic wait detected at runtime MUST be broken by timing out the **younger** wait and raising `hz.error.raised` with `class: mailbox-cycle`. |
| **R-runtime-81** | Leader election MUST be: heartbeat-based (leader publishes a heartbeat every 10 s, lease 30 s), term-numbered, deterministic tie-break by ascending agent id, and failover MUST adopt in-flight assignments by re-issuing them from the task table (idempotent by task id). Split-brain MUST be impossible: a member MUST NOT accept two leaders in the same term. |
| **R-runtime-82** | Shared artifacts MUST be content-addressed and write-once (`hz://artifact/<sha256>`); a "revision" is a new artifact plus an edge, never an in-place write. Artifact writes require the `artifact.write` capability and are receipted like any other effect. |
| **R-runtime-83** | Team memory is a syncable tier of memory (`memory.read` / `memory.write`); entries MUST carry provenance (which member, which run, which receipt) and MUST be discardable without breaking a run. Team memory MUST NOT be a covert authority channel: it may inform reasoning, never grant capability. |
| **R-runtime-84** | Team teardown (explicit `team_delete`, team lifetime expiry, root interrupt, or crash recovery) MUST cancel every member's token tree, drain or persist unacked mailboxes, flush shared artifacts, run each child's teardown (R-runtime-73), and emit per-member `hz.agent.completed` plus one team-level terminal record. |

### 2.13 Scheduler and background jobs

| # | Rule |
|---|---|
| **R-runtime-85** | The scheduler MUST support **cron** jobs (5-field expression plus optional timezone) and **one-shot** jobs (single timestamp or delay). Declaring or altering a job requires the `schedule.manage` capability; firing a job requires the capability set of the job's own spec, never the declaring session's live grants. An occurrence is defined by **wall-clock time in the job's timezone**; a DST transition that makes a wall-clock time absent or repeated MUST be resolved by an explicit per-job policy (`on_absent: skip\|shift_forward`, `on_repeat: run_once\|run_twice`; defaults `skip`/`run_once`) recorded in `ScheduleJobV1`, never by host-local implicit behaviour. |
| **R-runtime-86** | Every firing MUST write an **occurrence journal** entry keyed `(job_id, occurrence_id)` *before* the job body runs: outcomes are `started`, `completed`, `failed`, `skipped`, `missed`. Occurrence ids MUST be derived from the schedule and the fire time, so that a duplicate fire is deduplicable. |
| **R-runtime-87** | Catch-up policy MUST be explicit per job: `skip` (default for one-shot), `coalesce` (default for cron: all missed occurrences collapse into one run), `run-all` (bounded by `max_catch_up ≤ 5` occurrences). Unbounded backfill MUST NOT exist. |
| **R-runtime-88** | Jitter MUST be deterministic per `(job_id, occurrence_id)` from a global jitter window (default 0–5 s); it exists to avoid thundering herds and MUST NOT be random-per-process. |
| **R-runtime-89** | A job's occurrences MUST NOT overlap: if the previous occurrence is still running, the new one is recorded `skipped` (or queued if the job declares `allow_queue: true`, ceiling 1). |
| **R-runtime-90** | A scheduled run MUST be a root run with its own budget ledger, origin type `ManagedRun` and its own session; it MUST NOT execute under the live grants of the session that declared it. |
| **R-runtime-91** | Missed windows across restarts MUST be recomputed from the journal at start: occurrences with no entry that fall inside the catch-up policy window are fired per R-runtime-87; occurrences older than the policy window are recorded `missed` and MUST NOT fire. |
| **R-runtime-92** | Clock handling MUST be monotonic-first: schedule arithmetic uses wall clock with a recorded UTC offset, elapsed-time decisions (`occurrence duration`, watchdog deadlines) use a monotonic clock, and a wall-clock jump greater than 60 s MUST suppress catch-up firing and raise `hz.error.raised` (`class: clock-jump`). |

### 2.14 Self-improvement loop (human-gated)

```text
LearnLoop.record(trajectory: TrajectoryV1): Promise<TrajectoryRefV1>
LearnLoop.propose(kind: 'prompt' | 'policy' | 'skill' | 'memory' | 'routing', base_rev, patch): Promise<LearnProposalV1>
```

| # | Rule |
|---|---|
| **R-runtime-93** | Every run MUST capture a trajectory: the ordered event log slice plus the receipt chain, redacted at capture time by `@horizoncode/observe` (secrets, tokens, absolute paths outside the workspace, and any field marked sensitive MUST be removed before persistence). Capture MUST NOT depend on the model choosing to call a tool. |
| **R-runtime-94** | Evals MUST be graded on **evidence**, not on model claims: an eval case passes only when the receipts and artifacts satisfy its assertions (files changed, tests run, exit codes, digest matches). A summary or a self-report MUST NOT score. |
| **R-runtime-95** | Memory distillation (episodic → semantic) MUST attach provenance (source trajectory ids) and MUST be reviewable; a distilled fact MUST be revocable without a migration. |
| **R-runtime-96** | Skill synthesis (`skillify`) MUST produce a draft skill with front-matter (name, description, allowed tools, `runAs`), MUST run it in the evals harness, and MUST NOT offer it to any run until it passes the suite it was distilled from. |
| **R-runtime-97** | Prompt, policy, routing and skill changes MUST be **proposals**: a diff against a base revision, never an in-place mutation of the live revision. A live prompt/policy revision MUST be immutable and addressable by revision id. |
| **R-runtime-98** | A/B evaluation of a proposal MUST respect the cache-guard discipline: each arm MUST have a byte-stable prefix for its own revision, arm assignment MUST be recorded per trajectory, and a proposal MUST NOT be promoted on a sample smaller than the declared minimum (default 20 trajectories or a declared statistical stopping rule). |
| **R-runtime-99** | **Hard rule — authority is never widened.** A proposal whose effect diff grants a new capability ID, raises a posture, adds a rule with `allow` where the base had `ask`/`deny`, adds a tool to an allow-list, or changes origin typing MUST be rejected by the proposal compiler. This rejection MUST NOT be overridable by a human approval, by an eval score, or by an unattended run. Self-improvement MAY narrow authority, MAY reorder work, MAY change wording and routing within a mode; it MAY NOT expand the reachable effect surface. |
| **R-runtime-100** | Proposal lifecycle MUST be the `LearnProposalV1.status` machine of `05-domain-and-schemas.md` §4.10 — `draft → proposed → under_review → approved | rejected | applied | reverted | expired` — with every transition evented (`hz.learn.proposal.created`, `hz.learn.eval.completed`). `approved` requires a human decision (`hz.permission.answered` on the proposal) except for the one narrow case in R-runtime-101. |
| **R-runtime-101** | Human gates: **(a)** memory promotion MAY proceed automatically when the promotion is derivable from receipts and does not change any capability, prompt prefix or policy rule; **(b)** skills, prompts, policy and routing always require human approval; **(c)** anything touching the effect surface is rejected outright (R-runtime-99), approval or not. |
| **R-runtime-102** | Background consolidation ("dream") MUST run as a scheduled, budgeted, non-interactive run whose only output is proposals and memory candidates. It MUST NOT run mutating tools outside its own scratch worktree and MUST NOT apply any proposal. |
| **R-runtime-103** | Trajectory retention and sharing MUST be policy-controlled: capture is local by default, upload is opt-in (`opt-in crash reports` / managed policy), and a trajectory that cannot be redacted MUST NOT be persisted (fail-closed: drop the trajectory and log a redaction failure rather than store secrets). |

### 2.15 Budgets and leases

| # | Rule |
|---|---|
| **R-runtime-104** | Budgets MUST exist in six kinds, all enforced by the runtime against a kernel-issued lease: **input tokens**, **output tokens**, **wall-clock** (per step and per run), **steps**, **cost** (in a declared currency), and **tool-specific meters** (triage, web searches, `code.execute` seconds, subagent count, artifact bytes). A step holds a wall-clock lease; the lease is a clock, not a suggestion. |
| **R-runtime-105** | There MUST be exactly one ledger per root run. Children do not get separate budgets: `spawn` reserves a slice from the parent ledger, the child spends only inside its slice, unused slice returns on teardown, and no transfer between siblings exists. Reservations MUST be double-entry (reserved + spent ≤ granted at all times). |
| **R-runtime-106** | Long-running work MUST hold an **adaptive progress lease**: `BudgetLedger.renew(leaseId, evidence)` extends the lease time/tokens only when it is given new evidence of progress. A lease that is not renewed MUST expire at its deadline. |
| **R-runtime-107** | Progress evidence MUST be one of: a new successful tool result with a receipt, a new artifact digest (`hz://artifact/<sha256>`), a completed todo/plan step, a test/build/lint result delta, a write to the workspace proven by a receipt, or a new verified fact in a subagent's capsule. Absence of any of these ⇒ **no renewal** ⇒ lease expiry ⇒ the runtime stops the work unit, releases its slot and records `no-progress`. "Still working" is not evidence. |
| **R-runtime-108** | Exhaustion behaviour MUST be explicit and predictable: at **80 %** of any budget the runtime warns and SHOULD compact/checkpoint; at **100 %** it MUST stop the unit at the next boundary (never mid-effect), release the claim, emit `hz.error.raised` with `class: budget-exhausted`, keep the run resumable, and MUST NOT attempt the pending effect "quickly anyway". Tool-specific meters exhaust per tool and MUST NOT be refilled by switching tools. |
| **R-runtime-109** | `BudgetLedger.renew` MUST reject a renewal whose `evidence` is empty, duplicated (same evidence id already counted), or not attributable to the lease's run; a rejected renewal MUST raise a runtime error (`class: invalid-renewal`) rather than being ignored, because a renewal without progress is a bug in the loop, not a runtime condition. Cost attribution MUST roll up the whole run tree (children included) into `hz.usage.recorded`. |

### 2.16 Long-horizon operation

| # | Rule |
|---|---|
| **R-runtime-110** | Unattended mode (scheduled run, `remote_trigger`, workflow node, `--unattended`) MUST NOT auto-approve anything. An ask that would require a human MUST be recorded as `deferred` and treated as **deny** for the current attempt (`ask_timeout_action = deny`, default), the agent MUST continue with an alternative allowed path if one exists, and the deferral MUST appear in the run's final report. Unattended mode MUST NOT change posture, grants or origin typing. |
| **R-runtime-111** | Watchdogs MUST exist for every run and MUST stop work on: a step exceeding its wall-clock lease, provider silence exceeding 120 s with no delta, no progress for 3 consecutive steps (R-runtime-107), an unbounded tool exceeding its declared ceiling, or a subagent exceeding its slice. Watchdog termination MUST be recorded with the triggering condition, not as a generic error. |
| **R-runtime-112** | Long runs MUST emit heartbeats (default every 15 s while `busy`): a small durable record carrying step index, current tool, elapsed time, budget consumed and progress digest. Heartbeats are how an operator (or a supervisor) distinguishes "slow" from "stuck", and MUST NOT be a substitute for progress evidence. |
| **R-runtime-113** | Crash resumption MUST be deterministic: on start, the runtime MUST scan for retained claims, rebuild the session state from the event log, and resume from the **last durably closed step boundary** — never mid-step, never by replaying a partial stream. In-flight effects without a settled receipt MUST be surfaced as `UNKNOWN` and handed to reconciliation before any new effect on the same resource. |
| **R-runtime-114** | Resume MUST verify its basis before acting: if the workspace digest (or snapshot id) does not match the digest recorded at the claim, the runtime MUST NOT silently continue; it MUST re-read the affected resources, invalidate stale plan windows (R-runtime-55), and report the divergence. If it cannot establish a consistent basis, it MUST fail closed into `error` with the run parked for a human. |
| **R-runtime-115** | Drift detection MUST run at each turn boundary: compare the active goal, the plan's step set and the recent effect classes against the run's declared intent. Drift is reported (`hz.goal.updated` with `drift: true` plus a human-readable reason) and MUST result in *asking*, re-planning, or stopping — never in silently widening scope. Drift detection MUST NOT use a hidden classifier to change mode (R-runtime-46); it may only raise a flag and request review. |
| **R-runtime-116** | Every run MUST carry a maximum lifetime (default 8 h wall-clock, configurable downward, hard ceiling 24 h) and MUST end in exactly one terminal record. A run that reaches its lifetime with an unfinished goal MUST park as `idle`-with-claim-state explicitly recorded, produce a resumable handoff note (goal, done, next, blockers, budgets spent), and MUST NOT be silently abandoned. |

### 2.17 Adopted insertions (RC-15)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

**3. `runtime_services` URL injection (NF-055):** the backend's actual bound URLs are forwarded into new sessions as a system-context suffix "so agents use correct URLs instead of guessing ports"; the injection is recorded on the session, and the URL is data, never authority.

**4. Recorder as a runtime service (NF-054):** failed verification runs may request a recorded trace; the trace is an artifact (digest-referenced), passed to the model; capture availability is a lane-health fact.

---

## 3. Interfaces

All paths are `[planned]`; package ownership follows `_conventions.md` §3. Signatures are TypeScript unless marked otherwise.

### 3.1 Functions owned by this subsystem

| Interface | Home `[planned]` | Contract |
|---|---|---|
| `Controller.submit(req: SubmitRequest, sink: EventSink): Promise<SubmitResult>` | `packages/core/src/controller/controller.ts` | The single entry point for every front-end. Validates, admits (`SessionEngine.admit`), routes (`route`), runs steps, emits `HzEvent`s to `sink`. MUST NOT be called concurrently with an un-finished submit on the same session (R-runtime-15). |
| `SessionEngine.admit(sessionId, input, mode: 'steer' \| 'queue'): Promise<AdmissionResult>` | `packages/core/src/session/session-engine.ts` | Durable inbox write + `hz.session.prompt.admitted` before acknowledgement (R-runtime-27, R-runtime-29). |
| `SessionEngine.claim(sessionId, cause): Promise<Claim>` / `release(claim, outcome)` | same | Write-ahead claim (R-runtime-4); `outcome` ∈ `succeeded · failed · interrupted · superseded · expired`, the `reason` enum of `hz.session.claim.released` (`06-events-and-flows.md` row 4). |
| `StepEngine.runStep(sessionId, cause, token: CancelToken): Promise<StepRecordV1>` | `packages/core/src/step/step-engine.ts` | The six phases (R-runtime-1). Exactly one `llm.stream` per step (R-runtime-2). |
| `AgentLoop.transition(state, trigger): State` | `packages/core/src/loop/agent-loop.ts` | Implements the §2.3 table; unknown transitions rejected (R-runtime-20). Emits `hz.session.busy.entered` / `hz.session.busy.left`. |
| `Interrupt.request(sessionId, strength: 'soft' \| 'hard', reason)` | `packages/core/src/loop/interrupt.ts` | Token-tree cancel (R-runtime-21, R-runtime-22); awaits kernel-side process termination for non-cooperative tools (R-runtime-24). |
| `ToolBatch.apply(batch, token): Promise<ToolOutcome[]>` | `packages/core/src/step/tool-batch.ts` | Resource-key scheduling and serialisation (R-runtime-8); every call goes through the kernel Guard; emits `hz.step.tool.requested` / `hz.step.tool.completed`. |
| `RetryPolicy.next(err, attempt): RetryDirective` | `packages/core/src/step/retry.ts` | Classification + backoff (R-runtime-33, R-runtime-34); `RetryDirective = {action: 'retry' \| 'fallback' \| 'fail', delay_ms, reason}`. |
| `CircuitBreaker.admit(provider, model): Admission` | `packages/core/src/provider/circuit.ts` | Open/half-open/closed state per `(provider, model)` (R-runtime-36). |
| `FallbackChain.resolve(role, chain, attempt)` | `packages/agents/src/routing/fallback.ts` | Role-compatible candidate selection (R-runtime-39, R-runtime-41). |
| `route(request, sessionPosture, budgets, agentProfile, planMode): RoutingDecisionV1` | `packages/agents/src/routing/route.ts` | The deterministic table in §2.8 (R-runtime-44, R-runtime-46). Pure; no provider access; unit-tested exhaustively. |
| `PlanWindow.open(plan: PlanV1, approval: HzPermissionAnswered): PlanWindowV1` / `PlanWindow.check(window, call): 'allow' \| 'ask' \| 'invalidate'` | `packages/core/src/plan/window.ts` | R-runtime-53 to R-runtime-57. `check` is fail-closed: anything unrecognised ⇒ `ask`. |
| `GoalMachine.apply(goal, change): GoalV1` / `TodoMachine.apply(todo, change): TodoV1` | `packages/core/src/state/goals.ts` | R-runtime-58 to R-runtime-61; rejects illegal transitions. |
| `SubagentFactory.spawn(parent: AgentContext, spec: SubagentSpecV1): Promise<AgentHandleV1>` | `packages/agents/src/fleet/subagent-factory.ts` | **The single construction primitive** (R-runtime-62, R-runtime-63). Applies narrowing, capsule, budget reserve, depth and concurrency ceilings. |
| `ParallelTasksScheduler.run(graph: ParallelTasksGraphV1, token): Promise<ParallelTasksResultV1>` / `FleetScheduler.run(spec: FleetSpecV1, token): Promise<ParallelTasksResultV1>` | `packages/agents/src/fleet/parallel-tasks-scheduler.ts` / `fleet-scheduler.ts` | `depends_on` / `fail_fast` / `adopt_ref` semantics for the graph (R-runtime-69, R-runtime-70); template fan-out with a concurrency ceiling and a settlement strategy for `fleet`. |
| `TeamBus.send(msg, opts)` / `TeamBus.receive(deadline)` | `packages/agents/src/team/bus.ts` | Durable at-least-once delivery, FIFO mailbox, ack/backpressure, mandatory deadlines (R-runtime-77 to R-runtime-79). |
| `TeamElection.heartbeat()` / `TeamElection.elect()` | `packages/agents/src/team/election.ts` | Term-based leader election and failover (R-runtime-81). |
| `Scheduler.fire(jobId, occurrenceId): Promise<OccurrenceOutcome>` | `packages/core/src/schedule/scheduler.ts` | Journal entry first, then run (R-runtime-86); honours catch-up, jitter, non-overlap (R-runtime-87 to R-runtime-89). |
| `Scheduler.recover(now): Promise<OccurrenceOutcome[]>` | same | Restart-time recomputation of missed windows (R-runtime-91, R-runtime-92). |
| `BudgetLedger.reserve(runId, slice) / spend(runId, meter, qty) / renew(leaseId, evidence) / release(runId, slice)` | `packages/core/src/budget/ledger.ts` | R-runtime-104 to R-runtime-109. `renew` requires evidence and throws `invalid-renewal` otherwise. |
| `Watchdog.arm(runId, condition) / fire(watchdogId, reason)` | `packages/core/src/longrun/watchdog.ts` | R-runtime-111; `Heartbeat.emit(runId, digest)` for R-runtime-112. |
| `LearnLoop.record(trajectory: TrajectoryV1): Promise<TrajectoryRefV1>` | `packages/learn/src/loop/record.ts` | Redacting, always-on capture (R-runtime-93, R-runtime-103). |
| `LearnLoop.propose(kind, base_rev, patch): Promise<LearnProposalV1>` | `packages/learn/src/loop/propose.ts` | Lifecycle start (R-runtime-97, R-runtime-100). |
| `ProposalCompiler.check(proposal): 'ok' \| 'rejected:authority-widening'` | `packages/learn/src/loop/compiler.ts` | The hard rule (R-runtime-99). Rejection is not overridable. |
| `EvalHarness.run(suite, rev): Promise<EvalResultV1>` | `packages/learn/src/eval/harness.ts` | Evidence-graded scoring (R-runtime-94); arms recorded for A/B (R-runtime-98). |

### 3.2 Events this subsystem owns (emitted; names per `_conventions.md` §6)

| Event | Emitted when |
|---|---|
| `hz.session.created` | root or child session record is created |
| `hz.session.prompt.admitted` | `SessionEngine.admit` commits an inbox entry |
| `hz.session.claim.acquired` / `hz.session.claim.released` | write-ahead claim taken / cleared with a terminal outcome |
| `hz.session.busy.entered` / `hz.session.busy.left` | `busy` entered / left |
| `hz.step.started` / `hz.step.llm.requested` / `hz.step.llm.delta` / `hz.step.llm.completed` | step phase boundaries (one `llm.requested` per step) |
| `hz.step.tool.requested` / `hz.step.tool.completed` | tool batch scheduling and results |
| `hz.plan.updated` / `hz.todo.updated` / `hz.goal.updated` | plan, todo and goal state machines |
| `hz.effect.lease.issued` / `hz.effect.settled` / `hz.effect.unknown` | consumed from the authority plane; the runtime records the step-level correlation |
| `hz.agent.spawned` / `hz.agent.completed` / `hz.agent.message.sent` | fleet and team lifecycle |
| `hz.session.compacted` / `hz.session.checkpoint.created` | compaction and long-run checkpoints |
| `hz.learn.trajectory.recorded` / `hz.learn.proposal.created` / `hz.learn.eval.completed` | self-improvement loop |
| `hz.permission.asked` / `hz.permission.answered` | approval interruptions (origin-typed by the kernel) |
| `hz.error.raised` | classified failures: `circuit-open`, `clock-jump`, `mailbox-cycle`, `budget-exhausted`, `no-progress`, `invalid-renewal`, `plan-invalid`, `no-compatible-model`, … |
| `hz.usage.recorded` | per-step token/cost recording, rolling up the run tree |

Every event above MUST carry `{event_id, session_id, run_id (root), parent_agent_id?, origin, at_monotonic, at_wall, payload}`. Events are the only cross-plane contract; no subsystem may call another subsystem's private function to learn runtime state.

---

## 4. Data

Schemas are defined in `05-domain-and-schemas.md` and follow the `<Name>V<major>` convention of `_conventions.md` §7. This subsystem **reads** and **writes** the following. The five names marked ✓ are already registered and defined in `05-domain-and-schemas.md`; every other name is reconciled to a registered shape in `05-domain-and-schemas.md` §4.18 - the owner of all `*V1` schemas - and a name listed in neither place MUST NOT be used normatively (reconciled 2026-11-07, reaudit stage 2, RC-15).

| Schema | R/W | Used for |
|---|---|---|
| `StepRecordV1` ✓ | W | one record per step: phases, attempts, model/role, routing row, context digest, tool batch, outcome (R-runtime-1, R-runtime-51) |
| `AgentProfileV1` ✓ | R | planner/executor profiles, tool allow-lists, `runAs` (routing table inputs) |
| `SessionPostureV1` ✓ | R | posture as an input to routing and plan windows (R-runtime-44, R-runtime-54) |
| `GuardDecisionV1` ✓ | R | per-call allow/ask/deny and lease references consumed by the agent loop |
| `SessionV1` | R/W | session identity, root/child linkage, plan mode flag, origin |
| `RunV1` (kernel OwnerLog `managed` record, RC-3) | R/W | root run, lifetime, ledger binding, unattended flag, terminal record (R-runtime-116); authority truth, not a session schema |
| `InputAdmissionV1` | R/W | inbox entry with mode `steer`/`queue`, stable id, ordering (R-runtime-27) |
| `ExecutionClaimV1` | R/W | write-ahead claim incl. workspace digest at acquisition (R-runtime-4, R-runtime-114) |
| `LoopStateV1` | W | current agent-loop state + the transition that produced it (R-runtime-16) |
| `RoutingDecisionV1` | W | mode, matched table row, inputs digest (R-runtime-44, R-runtime-51); recomputable projection |
| `PlanV1` | R/W | plan steps, expected effects, required capability set, hash |
| `PlanWindowV1` | R/W | approved-plan execution window, expiry, granted set (R-runtime-53) |
| `GoalV1` | R/W | goal state machine (R-runtime-58) |
| `TodoV1` | R/W | todo state machine (R-runtime-58) |
| `SubagentSpecV1` | R | requested kind, tools, capabilities, capsule, budget slice, depth (R-runtime-63) |
| `AgentHandleV1` | W | live child handle: agent id, token, ledger slice, worktree, session id |
| `SubagentSpecV1.contextCapsule` | R/W | the child's bounded input (R-runtime-65) |
| `FleetSpecV1` — fan-out input | R/W | one prompt template, per-agent variables, concurrency ceiling, settlement strategy (`09-tools.md` §4) |
| `ParallelTasksGraphV1` / `ParallelTasksResultV1` — graph input and result | R/W | distinct specs with dependency edges, `fail_fast`, `adopt_ref`; joined results and blocked nodes (R-runtime-69, R-runtime-70) |
| `TeamStateV1` | R/W | team identity, roles, membership, leader term (R-runtime-75 to R-runtime-81) |
| `AgentMessageV1` | R/W | bus message with id, causal parent, ack state (R-runtime-77) |
| kernel OwnerLog journal records (RC-3) — job and occurrence | R/W | cron/one-shot spec, catch-up policy, jitter window, budgets; occurrence keyed `(job_id, occurrence_id)` (R-runtime-86) |
| `BudgetV1` + `UsageV1` | R/W | per-run meters, reservations, spend (R-runtime-104, R-runtime-105) |
| `BudgetV1.renewPolicy` | R/W | adaptive lease with deadline and evidence log (R-runtime-106) |
| `HeartbeatV1` / `WatchdogV1` | W | liveness and watchdog records — projection only (R-runtime-111, R-runtime-112) |
| `TrajectoryV1` / `TrajectoryRefV1` | R/W | captured run trajectory (R-runtime-93) |
| `EvalCaseV1` result rows | W | evidence-graded suite result, arm, revision (R-runtime-94, R-runtime-98) |
| `LearnProposalV1` | R/W | kind, base revision, patch, lifecycle state, rejection reason (R-runtime-99, R-runtime-100) |
| `LearnProposalV1.status` | W | proposal lifecycle transitions and human decisions |
| `EffectReceiptV1` ✓ | R | the evidence source for progress (R-runtime-107) and for eval grading (R-runtime-94) |

Persistence: the runtime owns **no** private store. It writes events to the event log owned by `12-sessions-state.md`, schemas are serialised by `@horizoncode/protocol`, and budget/watchdog/heartbeat records are projections over the same log. No mutable side table may be the state of record for anything a rule above depends on.

## 5. Errors and failure modes

Classification is per R-runtime-33. The table states the runtime's behaviour and, where applicable, that the behaviour is **fail-closed** (the safe outcome is chosen whenever the runtime cannot prove the unsafe one is not happening).

| Failure | Detected by | Behaviour | Fail-closed? |
|---|---|---|---|
| Inbox entry lost / not durable | admission ack missing after restart | refuse the submission, surface `admission-failed`; input is never silently dropped | **yes** — no work starts without a durable admission |
| Claim missing at step start | phase 1 guard | abort the step before any provider call | **yes** |
| Context prefix drift | cache guard (cognition plane) | abort the step; no provider call with a drifted prefix | **yes** |
| No role-compatible model in chain | `FallbackChain.resolve` | step fails `no-compatible-model`; plan mode is never silently dropped | **yes** |
| Circuit open for `(provider, model)` | `CircuitBreaker.admit` | fail fast without a provider call; try the next chain candidate or fail the step | **yes** |
| Retry budget exhausted | `RetryPolicy.next` | step closes `exhausted`; session enters `error`; claim retained for resume | **yes** — no unbounded retry |
| Tool does not honour cancellation | termination grace elapsed | kernel terminates the process group; effect settles `UNKNOWN` and goes to reconciliation | **yes** — assumed-effect-unknown rather than assumed-clean |
| Effect `UNKNOWN` after interrupt/crash | receipt absent | no automatic retry on that resource until reconciliation resolves it | **yes** |
| Illegal loop transition | `AgentLoop.transition` | rejected and recorded; no coercion to a neighbouring state | **yes** |
| Illegal goal/todo transition | `GoalMachine.apply` | rejected; the projection keeps the previous state | **yes** |
| Ask with no human (unattended) | `ask_timeout_action` | deferred + treated as deny; alternative allowed path attempted; deferral reported | **yes** |
| Ask deadline expires interactively | ask timer (default 300 s) | deny | **yes** |
| Plan invalid / schema-invalid | planner output validation | one re-ask within budget, then `plan-invalid`; no approval window opens | **yes** |
| Tool call outside the approved window | `PlanWindow.check` | `ask` — never auto-allow | **yes** |
| Capability requested by a child that the parent lacks | `SubagentFactory.spawn` | total rejection; no partial child | **yes** |
| Depth / concurrency ceiling exceeded | `spawn`, `ParallelTasksScheduler`/`FleetScheduler` | depth ⇒ rejection; concurrency ⇒ queue with backpressure (never silent drop) | **yes** |
| Child fails | parallel-tasks / fleet scheduler | dependents `blocked` and reported; `fail_fast` cancels the rest; parent decides | **yes** — blocked nodes are never treated as success |
| Mailbox full | bus backpressure | sender blocks or receives `mailbox-full`; no silent drop | **yes** |
| Cyclic blocking wait | wait-for graph check | break the younger wait, `hz.error.raised(class: mailbox-cycle)` | **yes** |
| Leader silent > lease | heartbeat monitor | election; assignments re-issued idempotently from the task table | **yes** — a stale leader cannot commit team state |
| Occurrence double-fire | journal key `(job_id, occurrence_id)` | second entry deduplicated to `skipped` | **yes** — effects are not replayed |
| Wall-clock jump > 60 s | clock check | suppress catch-up, `hz.error.raised(class: clock-jump)` | **yes** |
| Budget exhausted | ledger | stop at the next boundary, release claim, park resumable | **yes** — no "just finish this one" path |
| Lease renewal without evidence | `BudgetLedger.renew` | throw `invalid-renewal`; no silent extension | **yes** |
| No progress for 3 steps | watchdog | stop the unit, record `no-progress` | **yes** |
| Workspace digest mismatch on resume | resume check | do not continue silently; invalidate plan windows; reconcile or fail into `error` | **yes** |
| Redaction failure in trajectory capture | capture pipeline | drop the trajectory, log the failure; never persist unredacted content | **yes** |
| Proposal widens authority | `ProposalCompiler.check` | rejected; not overridable by approval, eval score or unattended run | **yes** |
| Team artifact write conflict | content-addressing | produce a new artifact + edge; never in-place mutation | **yes** |
| Orchestration-plane crash | restart scan | deterministic resume at the last closed step boundary; `UNKNOWN` effects reconciled first | **yes** |

---

## 6. Flows

### F-1 Simple turn (executor-only, no tools)

1. Front-end calls `Controller.submit` with a prompt and a run spec.
2. `SessionEngine.admit` writes an `InputAdmissionV1` (`mode: queue`) and emits `hz.session.prompt.admitted`.
3. `route(...)` returns `executor-only` (row 3/6 of §2.8) and the decision is persisted as `RoutingDecisionV1`.
4. Claim taken: `hz.session.claim.acquired`, `hz.session.busy.entered`; loop state `idle → busy`.
5. `StepEngine.runStep` phase 1–3: history loaded, context compiled (digest recorded), exactly one `llm.stream`; deltas stream to the sink as `hz.step.llm.delta`.
6. Phase 4–5: the answer contains no tool calls, so the batch is empty.
7. Phase 6: `StepRecordV1` closed as `answered`, `hz.usage.recorded`, claim released, `hz.session.busy.left`.
8. Goal evaluation: goal `achieved` if the evidence gate accepts, otherwise `idle` with the inbox empty and a resumable record.

### F-2 Parallel tool batch (read-class fan-out)

1. Steps 1–4 as in F-1; the model returns 5 read-only calls (`grep`, `read` ×3, `symbols`) in one assistant message.
2. Phase 4 emits `hz.part.updated` per tool call; arguments are schema-validated — invalid arguments fail the individual call, not the step.
3. `ToolBatch.apply` computes resource keys: disjoint + `read-only` ⇒ parallel (up to the declared concurrency class, default 8-wide).
4. Every call still passes the kernel Guard; read-class calls resolve `allow` under any posture and are receipted.
5. A sixth call in the same batch is `write` on a path another call reads: it is serialised after the reads on that resource key, in declared order (R-runtime-8).
6. Results return as `hz.step.tool.completed` with receipts; the batch closes with outcome `tool_batch`.
7. The loop stays `busy` and runs the next step with the tool results in history — again exactly one `llm.stream`.

### F-3 Approval interrupt

1. Step phase 5 hits a `terminal.run` call whose Guard decision is `ask`; it emits `hz.permission.asked`.
2. The runtime suspends **only that call**; other calls in the batch that were already `allow`ed complete and settle.
3. Loop state `busy → awaiting-approval`; the provider stream is already closed (R-runtime-18).
4. The front-end renders the ask from the event; the user chooses allow (once / always in this workspace / deny).
5. `hz.permission.answered` = allow ⇒ kernel issues a one-use lease (`hz.effect.lease.issued`); state `awaiting-approval → busy`; the suspended call resumes with the same arguments (no argument drift).
6. If the answer is deny, the call settles `denied` (`hz.effect.decision.made`); the model is informed in the next step and MUST choose an allowed alternative.
7. If the user interrupts instead, the ask is answered `denied-by-interrupt`; the batch is abandoned and the step closes `interrupted` (R-runtime-26).
8. If the ask deadline (300 s) expires interactively, the decision is deny (fail-closed).

### F-4 Subagent fleet and `parallel_tasks`

1. The executor step issues a `parallel_tasks` call with a dependency graph — `A` (research), `B` and `C` (`depends_on: [A]`), `D` (`read_only_task`, `adopt_ref: B`) — or a `fleet` call with one template, per-agent variables, a concurrency ceiling and a settlement strategy (no edges; `09-tools.md` §4).
2. `ParallelTasksScheduler.run` / `FleetScheduler.run` validates the input (acyclic where edges exist, ceilings, depth) and calls `SubagentFactory.spawn` once per node.
3. Each spawn: capability grant = `parent_grant ∩ requested` (D gets `read-only ∩ parent`); context capsule built (no parent transcript); budget slice reserved from the parent ledger; worktree allocated from the pool; `hz.agent.spawned`.
4. `A` runs; `B`/`C` wait (`depends_on` satisfied only on `A.completed`); `B`'s artifact is injected into `D`'s capsule by `hz://artifact/<sha256>` reference.
5. `C` fails; `fail_fast: true` cancels `D` before it starts, marks it `blocked`; `A` and `B` results are retained.
6. `Spawn` teardown per child: token tree cancelled, processes reaped, worktrees returned, artifacts flushed, unused budget returned, slot released, `hz.agent.completed` with outcome.
7. The parent receives `ParallelTasksResultV1` (per-node status, artifacts, spend, blocked list) and decides: retry `C` once with a narrower capsule, or re-plan. The summary alone changes nothing — artifacts and receipts are the evidence.

### F-5 Crash resume

1. The host process dies mid-step; the last durable facts are the step's start, the claim, and some `hz.part.*` / `hz.effect.*` records.
2. On start the runtime scans for retained `ExecutionClaimV1` records and rebuilds session state from the event log (projections folded to the last complete event).
3. Unsettled effects from the interrupted step are surfaced as `hz.effect.unknown` and handed to reconciliation **before** any new effect on the same resource (R-runtime-113).
4. Resume basis is verified: the workspace digest is compared with the digest recorded at claim time (R-runtime-114). Mismatch ⇒ invalidate all plan windows, re-read the affected resources, report divergence; if no consistent basis can be established ⇒ `error`, parked for a human.
5. Plan windows are invalidated (turn boundary), so the next mutating call re-asks rather than reusing an old approval.
6. The loop re-enters `busy` at the last closed step boundary; the inbox is replayed in admission order (steers folded, queues after).
7. The resumed run emits one `hz.session.claim.acquired` and continues; the receipt chain shows a gap only where effects were `UNKNOWN`, which is exactly the honest state.

### F-6 Unattended scheduled run

1. `Scheduler.recover` / the tick loop computes due occurrences, writes the journal entry `started`, applies deterministic jitter, and calls `Scheduler.fire`.
2. A new root run and session are created with origin `ManagedRun`, `unattended: true`, and its own budget ledger (never the declaring session's grants, R-runtime-90).
3. `route(...)` hits row 7 ⇒ `full` with `asks_deferred: true`.
4. Any Guard `ask` is recorded `deferred` and treated as deny; the agent pursues allowed alternatives.
5. Progress leases renew only on evidence; three steps without evidence ⇒ watchdog stop, `no-progress`.
6. The run ends with a report: goal state, artifacts, `UNKNOWN` effects, deferrals, spend; the journal entry is closed `completed` or `failed`.

### F-7 Steering a running turn

1. A turn is running (`busy`), step 3 of N.
2. The user submits a correction with `mode: steer` ⇒ durable admission, `hz.session.prompt.admitted` (visible immediately to all attached front-ends).
3. The running stream is **not** mutated (R-runtime-28).
4. At the next step boundary the steer is folded into the context compile; the new step's prompt contains it.
5. Authority is unchanged: tools, posture and model chain stay as they were; if the steer needs a different tool class, that call still goes through the Guard (R-runtime-31).
6. A `queue`-mode submission instead waits until the turn reaches a terminal outcome and is then admitted in FIFO order (R-runtime-32).

---

## 7. Security and authority

Capability IDs are the ones registered in `_conventions.md` §5; enforcement lives in the authority plane (`11-authority-safety.md`). The orchestration plane **requests**; it never decides.

### 7.1 Capabilities this subsystem consumes

| Capability ID | Requested by | Notes |
|---|---|---|
| `providers.infer` | each step's `llm.stream` | the only path to a model; a step without it cannot run |
| `session.manage` | `Controller.submit`, resume, fork, team creation | origin-typed; `ManagedRun` runs cannot impersonate `UserAction` |
| `context.manage` | compaction trigger, plan-window context rebuild | compaction is an effect like any other |
| `agent.spawn` | `SubagentFactory.spawn` | additionally gated by depth and concurrency ceilings |
| `schedule.manage` | `Scheduler` job declaration/alteration | firing uses the job spec's grants, not the declarer's (R-runtime-85) |
| `artifact.write` | child results, fleet `adopt_ref`, team shared artifacts | content-addressed, write-once |
| `memory.read` / `memory.write` | team memory tier, capsule memory slices | team memory may inform, never grant (R-runtime-83) |
| `worktree.manage` | fleet/team worktree allocation and release | pool-issued, single-writer per worktree |
| any tool's declared capability (`files.read`, `files.write`, `terminal.run`, `net.fetch`, `net.search`, `code.execute`, `vcs.write`, `remote.exec`, …) | the tool calls a step issues | every call re-enters the Guard with a one-use lease |

### 7.2 Narrowing for children

`grant(child) = grant(parent) ∩ requested(spec) ∩ ceiling(kind)` — intersection only, never union, never implicit inheritance.

| Kind | Ceiling applied on top of the intersection |
|---|---|
| `task` / `parallel_tasks` / `fleet` node | parent grant as-is, minus `ui.present` |
| `read_only_task` | `∩ read-only effect class` — cannot mutate anything, ever |
| team `member` | parent grant minus `agent.spawn` unless the team spec grants it explicitly |
| team `observer` | `∩ {read-only class}` and no mailbox send rights |
| background/dream run | own root ledger; scratch worktree only; no access to the user's live session grants (R-runtime-90, R-runtime-102) |
| *none* | `secrets.read` and `ui.present` are NEVER auto-inherited; they appear in a child grant only if the spec requests them **and** the parent holds them |

Additional authority rules for this plane:

| # | Rule |
|---|---|
| **R-runtime-117** | The runtime MUST NOT present a model-originated request as human authority. Origin typing (`SessionBatch`, `UserAction`, `ManagedRun`, `ManagedRoot`) is attached at the kernel boundary and MUST NOT be rewritable by any runtime component, subagent, team message or proposal. |
| **R-runtime-118** | Posture and policy MUST be enforced by the kernel. The runtime MUST NOT implement a permission shortcut, a cached-approval fast path, or a "trusted model" bypass; on any doubt the call is `ask` (or `deny` when no human is present). |
| **R-runtime-119** | A capability that a child was denied MUST NOT be obtainable by (a) respawning a sibling under a different name, (b) asking the parent to "proxy" the call, (c) a plugin, skill, workflow node or team message, or (d) an approved plan window (R-runtime-56). |
| **R-runtime-120** | Every spawn, plan-window open, window-invalidating call and proposal rejection MUST be attributed to a session, a run and an actor, so that the audit trail can explain *who widened nothing*. |

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

**5. Override-precedence enforcement point:** the single place task overrides are applied is `SubagentFactory.spawn` (R-runtime-62), and it is the only place (boundary test).

---

## 8. Performance budgets

**Single owner.** This section is the single owner of runtime budget numbers. `03-hld.md` §9, `04-lld.md` §8, `05-domain-and-schemas.md` §8, `06-events-and-flows.md` §8 and `07-apis-and-contracts.md` §8 cite these values and MUST NOT restate a rival number (reconciled 2026-11-07, reaudit stage 2, RC-15).

Numbers are targets for a named reference machine class (`ref-linux-x64-4c8g` local SQLite, warm cache; a number measured on any other class carries that class in its label). They are budgets for tests (`packages/testing` perf harness), not marketing. Every row names its **anchor** (the event from which the clock starts) and its **population** (what is included and excluded) per `16-operations.md` R-ops-113; a row whose enforcing suite does not exist yet is `UNENFORCED` and MUST NOT be quoted as a guarantee.

| Path | Budget | Anchor (population) |
|---|---|---|
| `Controller.submit` → durable admission event (local) | ≤ 5 ms p95, ≤ 20 ms p99 | anchor: `Controller.submit` entry; population: validation, routing, inbox write and the `hz.session.prompt.admitted` commit — excluding provider and kernel work |
| Step overhead excluding provider time (phases 1, 4, 6 + scheduling) | ≤ 15 ms p95 | anchor: phase 1 begins; population: history load, batch reduction and planning, step close — excluding context compile (own row), provider time and kernel time |
| Context compile, warm prefix (cache guard hit) | ≤ 25 ms p95 at 100 k token session | anchor: `ContextCompiler.compile()` entry; population: prefix assembly + digest + tail projection; retrieval I/O excluded |
| Context compile, cold | ≤ 150 ms p95 at 100 k token session | anchor: `ContextCompiler.compile()` entry; population: as above plus retrieval and skill-index load |
| Tool batch scheduling overhead (per batch, 8 calls) | ≤ 10 ms | anchor: the batch is handed to `ToolBatch.apply`; population: resource-key planning and submission — excluding Guard decisions and the effects themselves |
| Event append (WAL, batched fsync ≤ 10 ms) | ≤ 2 ms p95 per event | anchor: the runtime calls the store's append; population: event insert + projector writes in the same transaction — excluding projection catch-up and blob writes |
| Receipt write + settle | ≤ 4 ms p99 | anchor: the EffectHost receives the terminal observation; population: OwnerLog commit for the intent + receipt ledger append — excluding effect execution |
| Guard decision (`effect.authorize`, policy revision warm) | ≤ 2 ms p99 (wildcard rules); ≤ 10 ms p99 (Starlark path) | anchor: the kernel accepts the request; population: Guard + policy evaluation + lease issue — excluding transport and effect execution |
| Kernel request round trip (non-effect, warm UDS / named pipe) | ≤ 3 ms p95 | anchor: the client writes the frame; population: transport, dispatch and encode/decode — excluding the work the method performs |
| Projection lag behind the log | ≤ 50 ms p95 | anchor: event commit; population: until the projector's row is readable |
| Soft interrupt → no new work scheduled | ≤ 50 ms | anchor: `Interrupt.request('soft')`; population: token-tree propagation to the step engine — excluding in-flight tool completion |
| Hard interrupt → in-flight stream aborted | ≤ 100 ms | anchor: `Interrupt.request('hard')`; population: through provider stream close |
| Cancel propagation to depth 3 (child tree) | ≤ 50 ms | anchor: parent token cancelled; population: descendant tokens at depth ≤ 3 — excluding process reaping (own row) |
| Non-cooperative tool termination (kernel escalation) | ≤ 250 ms | anchor: escalation begins; population: through confirmed process kill |
| `SubagentFactory.spawn` overhead excluding sandbox/worktree creation | ≤ 100 ms | anchor: `spawn` entry; population: narrowing, capsule, ledger reserve, ceilings — excluding sandbox and worktree creation |
| Worktree checkout for a child | ≤ 1.5 s (pooled), ≤ 4 s (cold) | anchor: pool acquire request; population: through a writable tree at the child's root |
| Plan window check per tool call | ≤ 1 ms | anchor: the call is presented to `PlanWindow.check`; population: comparison against the window's granted set (pure) |
| Ledger `spend` / `renew` (in-memory with batched durability) | ≤ 1 ms p95 | anchor: ledger method entry; population: meter update — excluding the batched fsync it schedules |
| Mailbox send/receive, local process | ≤ 5 ms p95 | anchor: `TeamBus.send` entry; population: through durable enqueue or delivery to a waiting receiver |
| Leader heartbeat interval / lease | 10 s / 30 s (R-runtime-81) | anchor: last heartbeat persisted; population: interval to the next heartbeat and the lease expiry window |
| Scheduler tick accuracy (local) | ±2 s; jitter ≤ 5 s; journal write ≤ 5 ms | anchor: the scheduled fire time; population: actual fire (accuracy, jitter) and the journal record write |
| Crash-recovery claim scan | ≤ 200 ms per 1 000 sessions | anchor: process start; population: claim and `UNKNOWN` scan only — no projection rebuild |
| Resume to first step after process start | ≤ 1 s | anchor: process start; population: through the first step's phase 1; projections may catch up asynchronously |
| Resident overhead per idle session | ≤ 200 KB | anchor: session at rest in `idle`; population: in-memory state — excluding projections and blob cache |
| Resident overhead per active step (excluding retained deltas) | ≤ 5 MB; streaming ring buffer 64 KiB | anchor: `busy` with one step in flight; population: step state — retained deltas excluded |
| Heartbeat write interval | 15 s (R-runtime-112) | anchor: previous heartbeat persist; population: n/a (an interval, not a latency) |

Budgets that are *safety* numbers rather than speed numbers — retry cap 5 attempts, breaker thresholds 5/60 s, ask deadline 300 s, provider silence 120 s, no-progress 3 steps, run lifetime 8 h (hard 24 h) — are normative in §2 and MUST NOT be tuned per surface.

---

## 9. Tests

Tests live in `packages/testing` `[planned]` with fixtures from `packages/testing/fixtures`. Record/replay is used for provider traffic so that every test below is deterministic and offline.

| Test | Path `[planned]` | Proves |
|---|---|---|
| **Boundary test — single construction primitive** | `packages/testing/src/boundary/subagent-construction.test.ts` | R-runtime-62: statically enumerates every construction path (the four fleet tools, `runAs: subagent` skills, workflow nodes, team members, schedule `task` actions, plugin-contributed agents) and fails if any path creates an agent context, provider client, ledger or tool scope without `SubagentFactory.spawn`. Fails on a new path appearing without an entry in the allow-list. |
| **One stream per step** | `packages/testing/src/runtime/one-stream.test.ts` | R-runtime-1, R-runtime-2: a scripted provider returns tool calls that would tempt an in-process loop; asserts exactly one `llm.stream` per step and one `hz.step.started`. |
| **Reload-not-remember** | `packages/testing/src/runtime/step-reload.test.ts` | R-runtime-3: mutate memory between steps; only evented state may influence the next prompt. |
| **Claim / crash resume** | `packages/testing/src/runtime/claim-resume.test.ts` | R-runtime-4, R-runtime-113, R-runtime-114, F-5: kill at every phase boundary; every kill resumes to exactly one terminal outcome; digest mismatch parks in `error`. |
| **State machine exhaustiveness** | `packages/testing/src/runtime/loop-states.test.ts` | R-runtime-16, R-runtime-20: property test over all state×trigger pairs; only table rows are reachable; unknown triggers are rejected. |
| **Interrupt semantics** | `packages/testing/src/runtime/interrupt.test.ts` | R-runtime-21 to R-runtime-26: soft stops before the next stream; hard aborts within 100 ms; a fake non-cooperative tool is killed by the kernel and its effect settles `UNKNOWN`; partial parts are marked incomplete. |
| **Steer vs queue** | `packages/testing/src/runtime/admission.test.ts` | R-runtime-27 to R-runtime-32: a steer never lands mid-stream; a queue lands only after the turn; kill-and-restart preserves the inbox exactly. |
| **Retry and breaker** | `packages/testing/src/runtime/retry.test.ts` | R-runtime-33 to R-runtime-38: backoff/jitter envelope (base 500 ms, cap 30 s, ≤5 attempts); breaker opens at 5/60 s, probes once after 30 s, closes after 2 successes; no stitching; attempts summed into usage. |
| **Fallback role discipline** | `packages/testing/src/runtime/fallback.test.ts` | R-runtime-39 to R-runtime-43: planner steps never select executor-only entries; `no-compatible-model` fails closed; model switch recompiles and refuses a drifted prefix. |
| **Routing table golden test** | `packages/agents/src/routing/route.golden.test.ts` | R-runtime-44, R-runtime-46, R-runtime-51: an exhaustive table of inputs → expected mode, byte-compared against a golden file; the harness asserts `route` performs no I/O and imports no provider module (no classifier). |
| **Plan window** | `packages/core/src/plan/window.test.ts` | R-runtime-53 to R-runtime-57: out-of-set call ⇒ `ask`; every invalidation trigger; an approval cannot add a capability the session lacked. |
| **Goal/todo machines** | `packages/core/src/state/goals.test.ts` | R-runtime-58 to R-runtime-61: at most one `active` goal / `in_progress` todo; illegal transitions rejected; model cannot set `achieved`. |
| **Capability narrowing** | `packages/agents/src/fleet/narrowing.test.ts` | R-runtime-63, R-runtime-64, R-runtime-117 to R-runtime-119: intersection only; a child cannot obtain a denied capability by respawn, proxy call, plan window or team message. |
| **Fleet dependency semantics** | `packages/agents/src/fleet/fleet-scheduler.test.ts` | R-runtime-69, R-runtime-70: `depends_on` ordering (`parallel_tasks`), `fail_fast` cancellation, `adopt_ref` by digest, blocked nodes reported not dropped; `fleet` fan-out has no edges. |
| **Capsule and budget inheritance** | `packages/agents/src/fleet/capsule.test.ts` | R-runtime-65, R-runtime-66, R-runtime-105: no parent transcript by default; slice reservation arithmetic (`released + spent ≤ granted`); sibling isolation. |
| **Depth and concurrency ceilings** | `packages/agents/src/fleet/ceilings.test.ts` | R-runtime-67, R-runtime-68: depth 3 default / 5 hard; 4 per session, 8 read-only, 12 global; excess queues with backpressure. |
| **Teardown completeness** | `packages/agents/src/fleet/teardown.test.ts` | R-runtime-73, R-runtime-84: after any terminal path, no live process, no held worktree, no leak in the ledger, exactly one `hz.agent.completed` per child. |
| **Team messaging and deadlock** | `packages/agents/src/team/bus.test.ts` | R-runtime-77 to R-runtime-80: at-least-once with idempotent receivers, FIFO mailbox, backpressure at capacity, a crafted cyclic wait times out (`mailbox-cycle`) instead of hanging. |
| **Leader election and failover** | `packages/agents/src/team/election.test.ts` | R-runtime-81, R-runtime-76: term monotonicity, no two leaders per term, assignments re-issued idempotently after failover. |
| **Scheduler catch-up determinism** | `packages/core/src/schedule/scheduler.test.ts` | R-runtime-86 to R-runtime-92: journal-first, idempotent occurrence ids, `skip`/`coalesce`/`run-all` bounded by 5, deterministic jitter, clock-jump suppression across a simulated restart. |
| **Budget exhaustion** | `packages/core/src/budget/ledger.test.ts` | R-runtime-104 to R-runtime-109: 80 % warn, 100 % stop at boundary, run stays resumable, no mid-effect stop; `renew` without new evidence throws `invalid-renewal`. |
| **Progress vs liveness** | `packages/core/src/longrun/watchdog.test.ts` | R-runtime-106, R-runtime-107, R-runtime-111, R-runtime-112: a busy-but-stalled run is stopped with `no-progress`; heartbeats never count as progress. |
| **Self-improvement gates** | `packages/learn/src/loop/gates.test.ts` | R-runtime-94 to R-runtime-103: evals score only on receipts; skillify does not publish before passing; **a proposal that widens authority is rejected even with a human approval** (the ratchet test); no proposal is auto-applied. |
| **Cache-guard interaction** | `packages/context/src/cache-guard.runtime.test.ts` | R-runtime-42, R-runtime-45, R-runtime-98: planner and executor prefixes never mix within a step; A/B arms have stable prefixes; a drifted prefix aborts the step. |
| **Front-end parity ratchet** | `packages/testing/src/gates/parity-ratchet.test.ts` | R-runtime-10 to R-runtime-12: fails when `@horizoncode/core` branches on a surface name, or when a front-end behaviour has no protocol request + event pair. |
| **Unattended mode** | `packages/testing/src/runtime/unattended.test.ts` | R-runtime-110: no ask is auto-approved; deferrals are reported; posture, grants and origin typing are unchanged. |
| **Long-run lifetime and handoff** | `packages/testing/src/runtime/lifetime.test.ts` | R-runtime-116: every run ends in one terminal record; an unfinished run parks with a resumable handoff note. |

---

## 10. Runtime invariants and where they are enforced

Every invariant below MUST hold at every instant of every run, in every front-end, in attended and unattended mode alike.

| # | Invariant | Enforced by | Falsified by |
|---|---|---|---|
| I-1 | One provider call per step, no hidden loop | `StepEngine.runStep` (R-runtime-1, R-runtime-2) | `one-stream.test.ts` |
| I-2 | Every step input is durable state, never memory | phase 1/2 reload (R-runtime-3, R-runtime-7) | `step-reload.test.ts` |
| I-3 | Work exists only under a write-ahead claim; claims clear only on a terminal outcome | `SessionEngine.claim`/`release` (R-runtime-4) | `claim-resume.test.ts` |
| I-4 | Exactly one loop state at a time; only table transitions | `AgentLoop.transition` (R-runtime-16, R-runtime-20) | `loop-states.test.ts` |
| I-5 | One Controller per host; front-ends hold no decision logic | `Controller` (R-runtime-9 to R-runtime-13) | `parity-ratchet.test.ts` |
| I-6 | Interrupt is cooperative and bounded: soft ≤ next boundary, hard ≤ 250 ms to process death | `Interrupt.request` + kernel supervisor (R-runtime-22, R-runtime-24) | `interrupt.test.ts` |
| I-7 | A possibly-applied effect is never assumed clean | kernel settlement (R-runtime-25) | `interrupt.test.ts`, `claim-resume.test.ts` |
| I-8 | Prompt admission is durable, ordered, and never mutates a running stream | `SessionEngine.admit` (R-runtime-27 to R-runtime-32) | `admission.test.ts` |
| I-9 | Retries are bounded and jittered; no stitching; no retry after an effect | `RetryPolicy.next` (R-runtime-33 to R-runtime-38) | `retry.test.ts` |
| I-10 | Breaker state is per `(provider, model)` | `CircuitBreaker.admit` (R-runtime-36) | `retry.test.ts` |
| I-11 | A step never mixes planner and executor prefixes | context compile + `StepRecordV1` digest (R-runtime-45) | `cache-guard.runtime.test.ts` |
| I-12 | Routing is deterministic, table-driven, classifier-free | `route` (R-runtime-44, R-runtime-46) | `route.golden.test.ts` |
| I-13 | Plan approval records a decision and grants nothing | `PlanWindow.open` (R-runtime-56) | `window.test.ts`, `narrowing.test.ts` |
| I-14 | Outside-window calls re-ask; never auto-allow | `PlanWindow.check` (R-runtime-54, R-runtime-55) | `window.test.ts` |
| I-15 | At most one `active` goal and one `in_progress` todo | `GoalMachine`/`TodoMachine` (R-runtime-58) | `goals.test.ts` |
| I-16 | `achieved` can only be lowered by evidence, never asserted by a model | evidence gate (R-runtime-60) | `goals.test.ts` |
| I-17 | Every child agent is built by exactly one primitive | `SubagentFactory.spawn` (R-runtime-62) | **`subagent-construction.test.ts` (boundary test)** |
| I-18 | Child capability grants are intersections, never unions | `spawn` narrowing (R-runtime-64) | `narrowing.test.ts` |
| I-19 | Children cannot exceed parent budget, depth, or concurrency | `spawn` + `ParallelTasksScheduler`/`FleetScheduler` (R-runtime-66 to R-runtime-68) | `capsule.test.ts`, `ceilings.test.ts` |
| I-20 | Failed dependency ⇒ blocked node reported, never counted as success | `ParallelTasksScheduler.run` (R-runtime-70) | `fleet-scheduler.test.ts` |
| I-21 | Every terminal path tears down completely | teardown (R-runtime-73, R-runtime-84) | `teardown.test.ts` |
| I-22 | Team messages are durable, at-least-once, idempotent by id | `TeamBus` (R-runtime-77) | `bus.test.ts` |
| I-23 | No unbounded blocking wait exists; cyclic waits time out | `TeamBus.receive` deadlines (R-runtime-79, R-runtime-80) | `bus.test.ts` |
| I-24 | One leader per term; failover re-issues idempotently | `TeamElection` (R-runtime-76, R-runtime-81) | `election.test.ts` |
| I-25 | Shared artifacts are write-once and content-addressed | artifact store (R-runtime-82) | `bus.test.ts`, `teardown.test.ts` |
| I-26 | Journal precedes occurrence; no duplicate fire | `Scheduler.fire` (R-runtime-86, R-runtime-89) | `scheduler.test.ts` |
| I-27 | Catch-up is bounded and deterministic | `Scheduler.recover` (R-runtime-87, R-runtime-91) | `scheduler.test.ts` |
| I-28 | Scheduled runs never inherit live session grants | root-run creation (R-runtime-90) | `unattended.test.ts` |
| I-29 | Leases renew only on evidence; renewal without evidence is an error | `BudgetLedger.renew` (R-runtime-106, R-runtime-107, R-runtime-109) | `ledger.test.ts`, `watchdog.test.ts` |
| I-30 | Budget exhaustion stops at a boundary, never mid-effect | ledger + loop guard (R-runtime-108) | `ledger.test.ts` |
| I-31 | Unattended asks are deferred and denied, and reported | unattended policy (R-runtime-110) | `unattended.test.ts` |
| I-32 | Long runs are observable: heartbeats and watchdog conditions are always armed | `Watchdog`/`Heartbeat` (R-runtime-111, R-runtime-112) | `watchdog.test.ts` |
| I-33 | Resume is deterministic and verified against a digest | restart scan (R-runtime-113, R-runtime-114) | `claim-resume.test.ts` |
| I-34 | Every run ends in exactly one terminal record | run lifetime (R-runtime-116) | `lifetime.test.ts` |
| I-35 | **Self-improvement never widens authority** | `ProposalCompiler.check` (R-runtime-99) | `gates.test.ts` (rejection holds even with human approval) |
| I-36 | Origin typing is preserved end to end | kernel boundary (R-runtime-117) | `narrowing.test.ts`, `unattended.test.ts` |
| I-37 | Trajectories are redacted or dropped; never stored raw | capture pipeline (R-runtime-103) | `gates.test.ts` |
| I-38 | Every effect has a one-use lease; the runtime never self-authorises | kernel Guard (R-runtime-118, R-runtime-120) | `narrowing.test.ts` |

An invariant is owned by **exactly one** row here. A new invariant MUST be added to this table in the same change as the rule that introduces it; a table row without a falsifying test MUST NOT be claimed as enforced.

---

## 11. Status

> **Implementation status (RC-13), refreshed to the code.** Levels above DESIGNED live only in `28-implementation-status.md`; every rule below stays a specification claim. A reduced slice of this plane is implemented in `app/src/core/`: the step loop with one provider stream per step, guard, approval, tool, receipt and event pipeline (`loop.ts`, `index.ts`); SQLite sessions and per-session event streams (`session.ts`); NF-072 parallel tool batches; NF-073 loop safety rails (step/token/wall-clock budgets, format-error cap, three guards in `guards/`); NF-071 managed runtime v1 (`owned-spawn.ts`, `supervisor.ts`, `admission.ts`); plan mode staging (`plan.ts`); subagent delegation at depth 1 with presets (`subagent.ts`, `agent-profiles.ts`); named permission modes (`permission-mode.ts`, no bypass or yolo mode); the single-attach server (`server.ts`); conversational rewind; the NF-075 growth loop in reduced form (`review.ts`, `curator.ts`, `grow.ts`, nothing scheduled or applied automatically). The kernel is still a policy and audit prototype that does not execute effects, and `kernel_applied_mechanisms` are all false (docs/28 and docs/11). NOT implemented: planner/executor routing, teams, the scheduler and background jobs, goals, durable steering inbox wiring, model fallback chains and circuit breakers, adaptive progress leases, long-horizon watchdogs. Speculative execution exists as a module but is deliberately unwired (ruling 65). The reasons and upstream references for each deferral are in the Provenance section at the end of this document.

Status levels are those of `_conventions.md` §8. Where a name or number is not yet settled it is written **UNKNOWN**, not assumed.

| Capability | Level | Evidence | What would move it up |
|---|---|---|---|
| Step engine (six phases, one stream) | DESIGNED (reduced form in `loop.ts`) | §2.1, R-runtime-1 to R-runtime-8 | `StepEngine.runStep` + `one-stream.test.ts` (CODE_PRESENT → TESTED) |
| Controller + front-end parity contract | DESIGNED (reduced: TUI, headless and server share `createRuntime`; no `Controller.submit`, no parity ratchet) | §2.2, R-runtime-9 to R-runtime-15 | `Controller.submit` + `parity-ratchet.test.ts` |
| Agent-loop state machine (7 states, transition table) | DESIGNED (exit statuses exist; no 7-state transition table) | §2.3, R-runtime-16 to R-runtime-20 | `AgentLoop.transition` + exhaustive property test |
| Interruption & cooperative cancellation | DESIGNED (reduced: `AbortSignal` threaded through loop, tools and children; no token tree) | §2.4, R-runtime-21 to R-runtime-26 | token tree + kernel escalation test |
| Steering vs queueing (durable inbox) | DESIGNED (admission FIFO exists, `loop.ts` does not dispatch through it; no live steering) | §2.5, R-runtime-27 to R-runtime-32 | `SessionEngine.admit` + kill/restart test |
| Retries, backoff, circuit breaking | DESIGNED (reduced: request-phase retry in `providers/retry.ts`; no breaker) | §2.6, R-runtime-33 to R-runtime-38 | `RetryPolicy`, `CircuitBreaker` + envelope tests |
| Model fallback chains | DESIGNED | §2.7, R-runtime-39 to R-runtime-43 | `FallbackChain.resolve` + role-discipline test |
| Dual-model Planner/Executor + routing decision table | DESIGNED | §2.8, R-runtime-44 to R-runtime-51 | `route` + golden table + no-I/O assertion |
| Plan mode & approved-plan execution window | DESIGNED (reduced: staging, `/changes`, `/apply`; no `PlanWindow` or invalidation matrix) | §2.9, R-runtime-52 to R-runtime-57 | `PlanWindow` + invalidation matrix test |
| Goals and todos as state machines | DESIGNED (todo tool only; no goals, no state machine) | §2.10, R-runtime-58 to R-runtime-61 | `GoalMachine`/`TodoMachine` + rejection tests |
| Subagent fleet (kinds, fan-out and graph forms, capsules, ceilings, teardown) | DESIGNED (reduced: single child at depth 1, presets, step cap 12 default and 20 max; no fan-out or graph forms) | §2.11, R-runtime-62 to R-runtime-74 | `SubagentFactory.spawn`, `ParallelTasksScheduler` + **boundary test** |
| Team multi-agent (roles, bus, mailbox, election, artifacts) | DESIGNED | §2.12, R-runtime-75 to R-runtime-84 | `TeamBus`, `TeamElection` + deadlock/failover tests |
| Scheduler & background jobs | DESIGNED | §2.13, R-runtime-85 to R-runtime-92 | `Scheduler.fire/recover` + catch-up determinism test |
| Self-improvement loop + proposal lifecycle + human gates | DESIGNED (reduced NF-075 slice: spec and editorial gate, nothing applied automatically) | §2.14, R-runtime-93 to R-runtime-103 | `LearnLoop`, `ProposalCompiler` + `gates.test.ts` |
| Budgets, adaptive progress leases, exhaustion behaviour | DESIGNED (reduced: `RunBudget` and `BudgetLedger`; no adaptive leases) | §2.15, R-runtime-104 to R-runtime-109 | `BudgetLedger` + stall test |
| Long-horizon operation (unattended, watchdogs, heartbeats, drift, resume) | DESIGNED | §2.16, R-runtime-110 to R-runtime-116 | watchdog/heartbeat + digest-mismatch resume test |
| Authority narrowing for children | DESIGNED (reduced: children get no parent leases and a tool subset; presets cannot exceed the parent) | §7.2, R-runtime-63, R-runtime-64, R-runtime-117 to R-runtime-120 | `narrowing.test.ts`; requires `11-authority-safety.md` enforcement points to exist |
| Runtime performance budgets | DESIGNED | §8 | perf harness measuring the listed paths |
| Invariant table (I-1 … I-38) | DESIGNED | §10 | each row's falsifying test green in CI |

### 11.1 Known unknowns (UNKNOWN, not assumed)

| Item | State |
|---|---|
| Exact schema names for the non-✓ rows of §4 | **RESOLVED 2026-11-07** — each name is reconciled to a registered shape in `05-domain-and-schemas.md` §4.18; a name listed there as an ancestor name (`PromptAdmissionV1`, `AgentSpecV1`, `TeamMessageV1`, `ProposalV1`) MUST NOT be used |
| Concrete per-model routing inputs (`files_touched_estimate`, `expected_effect_class`) | **UNKNOWN** — the *fields* are decided here; who computes them, and from which host signals, is decided in `10-cognition.md` / `04-lld.md` |
| Depth/concurrency ceilings vs. measured platform limits | **UNKNOWN** — values chosen here are design defaults pending perf validation |
| Membership ceiling and message budget defaults for teams | **UNKNOWN** — declared at `team_create`; no default is claimed |
| Whether provider-side continuation resumes are worth supporting | **UNKNOWN** — default is discard (R-runtime-38); a follow-up decision is required |

### 11.2 Related documents

`03-hld.md` (planes and process model) · `04-lld.md` (module layout) · `05-domain-and-schemas.md` (schemas) · `06-events-and-flows.md` (event semantics) · `10-cognition.md` (context, cache guard, compaction) · `11-authority-safety.md` (Guard, leases, receipts, origin typing) · `12-sessions-state.md` (log, projections, checkpoints) · `24-feature-catalog.md` (tool family inventory).

---

## Provenance (what was taken from where)

This section records, for the runtime plane, which ideas and which bytes came from other repositories, with exact GitHub URLs at the commit that was read. It is a handoff aid: a new agent can open each link and see the lines that were studied. Nothing here changes a status level; `docs/28-implementation-status.md` is the only place that may claim a level above DESIGNED.

How to read the tables:

- **Upstream exact URL(s)** link a file at the full 40 character SHA pinned in [`research/upstream-pins.md`](research/upstream-pins.md). Every path was checked against `git ls-files` of the read-only clone before it was written. A path that could not be checked is written as `path not verified`.
- **Relation** is one of: **copied verbatim** (bytes or literal text taken as is), **ported** (same logic re-implemented line for line in TypeScript or Rust, behaviour kept), **adapted** (mechanism re-implemented with deliberate differences), **idea only** (the concept informed a clean implementation, nothing copied).
- The relation was judged from the header comments of the HorizonCode files, from the docs/28 rulings, and from reading both sides. Where the code header does not cite an upstream, the row says so and calls the link a convergent reference.
- **Licences.** The upstream licences found in the clones: cline, codex and forgecode are Apache-2.0; deepseek-harness, oh-my-pi and opencode are MIT; grok-build and claude-code carry their own `LICENSE` files that were not analysed here. This repository has no `LICENSE` or `NOTICE` file in the worktree at the time of writing. Rows marked verbatim or ported may carry attribution obligations; resolving that is an OPEN item for the human owner, not something this document decides.
- Upstream summaries live in [`research/`](research/README.md); the consolidated steal list is [`30-steal-list.md`](30-steal-list.md).

| # | HorizonCode file(s) | Upstream exact URL(s) at the pinned SHA | Relation | Notes |
|---|---|---|---|---|
| 1 | `app/src/core/loop.ts`, `app/src/core/index.ts` | [`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/agent-loop.ts)<br>[`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/turn.rs) | idea only | The step loop (`runTurn`, `GuardGate`, `executeTool`) is original code. The only borrowed thing is the SPLIT between a lean reusable loop and the product session around it, which `docs/research/steal-ohmypi-codex.md` section 2.1 records as already mirrored. No upstream code or text was copied. Level: `docs/28` section 1 (runtime core TESTED + VERIFIED). |
| 2 | `app/src/core/loop.ts` | mini-swe-agent: the loop and `LimitsExceeded` ideas, `docs/audit/pass3/audit-mini-swe-report.md` items 1-10, `docs/30` C-1/C-2/C-4/C-5/B-8 (repo not cloned, path not verified) | idea only | NF-073 loop safety rails: `MAX_PROVIDER_CALLS = 25`, `MAX_CONSECUTIVE_FORMAT_ERRORS = 3`, one sentinel budget check before every dispatch (`0` = unlimited), charged failed turns, live countdown in the step prompt, `BudgetLedger` shared by a run tree (docs/28 ruling 15). The upstream is described only by the earlier audit; the numbers are HorizonCode's own. |
| 3 | `app/src/core/guards/loop-detection.ts` | [`sdk/packages/core/src/runtime/safety/loop-detection.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/loop-detection.ts) | ported | Self-contained port (no `@cline/shared` imports). Behaviour kept verbatim: consecutive identical call count keyed on name plus sorted-key signature, soft warning on exact `===` the soft threshold, hard escalation at `>=` the hard threshold. The header of the HorizonCode file says it deliberately uses UTF-16 `sort()` ordering rather than `canonicalJson` so it matches cline. Wired in `loop.ts` (docs/28 ruling 40). License: Apache-2.0. |
| 4 | `app/src/core/guards/mistake-tracker.ts` | [`sdk/packages/core/src/runtime/safety/mistake-tracker.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/safety/mistake-tracker.ts) | ported | Reduced port: three mistake reasons (`api_error`, `invalid_tool_call`, `tool_execution_failed`), consecutive limit 3, resumable stop message ('state preserved, send a new prompt'). Event, log and telemetry callbacks were dropped. Deliberately a SEPARATE axis from the format-error cap (exit detail `consecutive_mistakes` versus `format_errors`). Ruling 40. |
| 5 | `app/src/core/guards/repeat-tool.ts` | [`packages/guard/repeat-tool-reminder/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/guard/repeat-tool-reminder/src/index.ts)<br>[`packages/guard/repeat-tool-reminder/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/guard/repeat-tool-reminder/README.md) | ported (logic) and copied verbatim (reminder wording) | Thresholds `[3, 5, 8]`, advisory only, counted AFTER execution so a denied call advances the chain, cleared by a new user prompt. The gentle reminder sentence ('Carefully analyze the previous result before calling again ...') matches the upstream text; check attribution before redistributing. Plain class, no cordis, schemastery or dsh imports. License: MIT. Ruling 40. |
| 6 | `app/src/core/loop.ts` (the `[attempts remaining before this run stops: N]` suffix), `app/src/core/guards/mistake-tracker.ts` | [`templates/forge-tool-retry-message.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/templates/forge-tool-retry-message.md) | adapted | forgecode renders a retry block with the attempts left on every failed tool result. HorizonCode derives N from the mistake tracker and appends a one-line model-facing note only; receipt and event digests are computed before the note, so the audit trail is unchanged (docs/28 ruling 70, forgecode take T-4). |
| 7 | `app/src/core/loop.ts` (end-of-turn pending-todos re-entry), `app/src/tools/todo.ts` | [`crates/forge_app/src/hooks/pending_todos.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/hooks/pending_todos.rs) | adapted | forgecode re-enters the loop with a reminder when todos are pending. HorizonCode re-enters at most ONCE per run, only for a list THIS run modified (per-session `todoVersion` counter), and keeps exit status `unknown` if the model stops again so there is no silent success (rulings 69 and 75, take T-3). |
| 8 | `app/src/core/json-repair.ts`, `app/src/core/loop.ts` (`parseArguments`), `app/tests/core/json-repair.test.ts` | [`crates/forge_json_repair/src/lib.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/src/lib.rs)<br>[`crates/forge_json_repair/src/parser.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/src/parser.rs)<br>[`crates/forge_json_repair/src/schema_coercion.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/src/schema_coercion.rs)<br>[`crates/forge_json_repair/tests/truncation.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/truncation.rs)<br>[`crates/forge_json_repair/tests/special_quotes.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/special_quotes.rs)<br>[`crates/forge_json_repair/tests/quotes.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/quotes.rs)<br>[`crates/forge_json_repair/tests/punctuation.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/punctuation.rs)<br>[`crates/forge_json_repair/tests/special_values.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/special_values.rs)<br>[`crates/forge_json_repair/tests/error_cases.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_json_repair/tests/error_cases.rs) | adapted (implementation) and ported (test corpus) | Zero-dependency re-implementation, NOT a translation of the Rust crate. Differs on purpose: forge guesses (a cut value becomes null, a bare word becomes a string), HorizonCode repairs only syntactic defects, counts each repair, and fails closed; those divergent fixtures are asserted as the safer outcome. The test file header states the corpus is ported from the named forge fixture files. Truncated blobs are admitted only for a short read-only tool allowlist (rulings 67 and 74, take T-1). License: Apache-2.0. |
| 9 | `app/src/core/loop.ts` (`concurrencyClassOf`, `batchSegments`, the `Promise.all` batch run) | [`packages/agent/src/agent-loop.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/agent-loop.ts)<br>[`codex-rs/core/src/tools/parallel.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/parallel.rs)<br>[`codex-rs/core/src/tools/router.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/router.rs) | adapted | NF-072: per-tool concurrency class (shared by default, `exclusive` opt-out), parallel shared segments, last-exclusive barrier, all-settled failures, one lease and receipt per call. oh-my-pi is the claim-verified source (`docs/30` section 1); codex independently confirms the per-tool parallel flag (`tool_supports_parallel`). Implementation is original (rulings 14 and 24). |
| 10 | `app/src/core/speculation.ts`, `app/src/core/loop.ts` (`LoopDeps.speculativeExecution`, `speculationEffectForToolCall`) | [`packages/agent/src/speculative-execution.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/speculative-execution.ts) | adapted | Coordinator is pure and host-injected, closed effect union (`pure` or `local_read` only), `DEFAULT_MAX_IN_FLIGHT = 2`, fingerprint `sha256Hex(canonicalJson({name, args, effect}))`, cascade discard. omp's richer states and `eval_shadow` candidates were NOT taken. DEFERRED: ruling 65 decided to leave it UNWIRED with the flag pinned inert (`speculativeExecution` off by default and unused by the loop). Reason: a consumer that benefits has not been defined, and wiring it would add a second path to the guard. Do not enable without a new ruling. |
| 11 | `app/src/core/owned-spawn.ts`, `app/src/core/supervisor.ts`, `app/src/core/admission.ts` | hermes-agent: managed persistent runtime, `docs/30` C-12 and D-1 to D-3, D-6; `docs/audit/pass3/audit-hermes-report.md` (repo not cloned, path not verified) | idea only | NF-071 managed runtime v1 (ruling 22): one `spawnOwned` path with a JSONL spawn ledger, an owner-death supervisor written as a POSIX `sh` poll loop, a durable admission FIFO where an `unknown` row halts its followers. Original code. The framed owner/worker control pipe was excluded (DEFERRED), and the FIFO is not the dispatch path of `loop.ts` yet. |
| 12 | `app/src/core/index.ts` (`repairDanglingToolCalls` call site), `app/src/core/session.ts`, `app/src/core/server.ts` | [`packages/core/session/src/repair.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/repair.ts)<br>[`codex-rs/core/src/rollout.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/rollout.rs)<br>[`codex-rs/core/src/session/daemon_recovery.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/daemon_recovery.rs) | adapted (pairing invariant), idea only (server recovery) | The dsh pairing invariant (every assistant tool call gets exactly one result, a missing one becomes a synthetic UNKNOWN result) is applied on session open and resume. Code comments in `core/index.ts` and `core/server.ts` cite it as the dsh `ToolCallRecovery` reference. HorizonCode does not use the dsh recovery codes (`TOOL_NOT_STARTED`, `TOOL_OUTCOME_UNKNOWN` do not appear in `app/src`). Server attach recovery is described in the `server.ts` header as mapping to codex `daemon_recovery` plus `rollout_reconstruction` in reduced form. Evidence: docs/28 status rows 'Rewind/checkpoints v1' and 'Server mode' (2026-11-09 server-rewind wave). |
| 13 | `app/src/core/providers/retry.ts` | [`codex-rs/core/src/responses_retry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/responses_retry.rs)<br>[`crates/forge_app/src/retry.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/retry.rs) | idea only (convergent) | The code does not cite either source. It retries only the request phase (before headers), a fixed retryable status set, respects `Retry-After` for timing. The codex rule that server advice must never raise the retry COUNT matches HorizonCode's capped attempts but was not copied; constants (5 s initial, 60 s max) are codex's and are NOT adopted. Listed so a later reader can compare, not as a claim of derivation. |
| 14 | `app/src/tools/agent.ts`, `app/src/core/subagent.ts`, `app/src/core/prompt/index.ts` | [`packages/subagent/subagent/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md) | idea only | Child session, nested loop, no recursion, children get grants never parent leases (docs/09 R-tools-32). dsh describes a delegation-scope statement injected into every child; whether HorizonCode's child prompt carries equivalent wording was NOT verified line by line (grep for 'scope' in `core/prompt/` finds only the base prompt rule). Treat as DEFERRED until checked. Subagent nested events and rendered diff: rulings 54 and 88. |
| 15 | `app/src/core/agent-profiles.ts` | Kiro CLI and Freebuff/Codebuff: specialised agent presets, `docs/30` section 5.11 (repo not cloned, path not verified)<br>[`mods/agents-md`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68/mods/agents-md) | idea only | Built-in presets `explore`, `plan`, `review`, `code` are DATA: tool allow-list, prompt block, optional model, step cap; a preset can never exceed the parent's tools (`profile_ceiling_widens`). The Claude Code link is the closest verified artifact in the public repo (the repo holds docs, `mods/` and `examples/`, not agent source; see `research/upstream-pins.md`). Rulings 56 and 61. |
| 16 | `app/src/core/permission-mode.ts` | [`examples/settings/settings-strict.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/settings/settings-strict.json)<br>[`examples/mdm`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/mdm)<br>[`codex-rs/core/src/safety.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/safety.rs) | idea only | Modes `default \| plan \| accept-edits \| read-only`, a policy layer ABOVE the kernel guard that can only refuse or auto-answer an ASK, never turn a deny into an allow. DIVERGENCE: there is deliberately NO bypass or yolo mode; `--permission-mode yolo` is refused with an explanation (ruling 58). Names echo Claude Code (`default`, `acceptEdits`, `plan`) and codex approval modes. |
| 17 | `app/src/core/plan.ts`, `app/src/core/loop.ts` (plan-mode staging) | [`examples/settings/settings-strict.json`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/settings/settings-strict.json) | idea only | Plan mode stages `write`/`edit` into an in-memory session-scoped store (100 changes, 1 MB, reported eviction); `unifiedDiff` is reused by the turn diff. No Claude Code or cline code was copied. Ruling 37 (plan mode). Ruling 50 refuses `apply_patch`, `ast_edit` and `shell_session` in plan mode with `PLAN_MODE_REFUSED`. |
| 18 | `app/src/core/turn-diff.ts`, `app/src/core/loop.ts` (journal boundary capture) | [`codex-rs/core/src/turn_diff_tracker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/turn_diff_tracker.rs) | adapted | One net unified diff per model turn from the change journal (earliest `before`, current on-disk `after`), 400 line total cap. Rendered with gutters in rich TUI mode (ruling 86). Ruling 46. |
| 19 | `app/src/core/guardian.ts`, `app/src/core/loop.ts` (`GuardGate.approve`) | [`codex-rs/prompts/templates/guardian/classifier_instructions.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/guardian/classifier_instructions.md) | adapted | Header says it mirrors codex guardian (review session, scoring, routing, coverage, classifier instructions). HorizonCode ships only a rule-based `deterministicClassifier` plus a capability-detected model hook. ADVISORY by default; `HORIZON_GUARDIAN=enforce` lets a deny refuse an ASK and fails CLOSED on classifier error (ruling 66). It runs only after the kernel said ask, so it cannot turn a kernel deny into an allow. Wired for asks in ruling 60. DEFERRED: a model-backed classifier is not wired to a provider. |
| 20 | `app/src/core/hooks.ts` | [`examples/hooks/bash_command_validator_example.py`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/examples/hooks/bash_command_validator_example.py)<br>[`codex-rs/core/src/hook_runtime.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/hook_runtime.rs) | idea only | JSON-line hook protocol (not Claude Code's exit-code protocol). The stderr tail of a failing hook is carried to the model, which the header calls the analogue of exit-2. DEFERRED and named in the header: the `ask` verdict, argument rewriting, trust gate for workspace hooks (H7/D31), hook runs as receipted effects. |
| 21 | `app/src/core/file-lock.ts` | [`packages/coding-agent/src/tools/file-mutation-queue.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/file-mutation-queue.ts)<br>[`packages/coding-agent/src/tools/conflict-detect.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/conflict-detect.ts) | idea only (convergent) | `O_CREAT\|O_EXCL` lockfile with pid and token, stale-pid reclaim, bounded wait. The file header does not cite omp; the research gap list (`research/steal-ohmypi-codex.md`) names these omp files as the reference for 'no cross-process locking'. Ruling 63. |
| 22 | `app/src/tui/print.ts`, `app/src/main.ts` (`-p` / `--print`) | Claude Code `-p --output-format json\|stream-json` and `codex exec --json` (named in the `print.ts` header; documented behaviour, no upstream source file linked: path not verified) | idea only | Headless print mode, one turn then exit (ruling 57). Only the output SHAPE is borrowed. The Claude Code public repo has no agent source. |
| 23 | `app/src/core/review.ts`, `app/src/core/curator.ts`, `app/src/grow.ts`, `app/src/core/postmortem.ts` | hermes-agent: post-turn review fork, editorial standard, curator, `docs/30` G-1 to G-4; `docs/audit/pass3/audit-hermes-report.md` (repo not cloned, path not verified) | idea only | NF-075 growth loop v1, reduced form (rulings 27 and 28). `review.ts` is a SPEC (byte-identical prefix or `prefix-parity-mismatch`, closed read-only tool subset); `curator.ts` is the editorial gate; `grow.ts` is a manual runner. DEFERRED: no scheduling, no loop wiring, no provider calls, no application of proposals, no archive-as-maximum curator (docs/30 G-4). docs/30 records hermes' ~26 % cost cut as an upstream claim, not a HorizonCode measurement. |
| 24 | `app/src/core/evals.ts`, `app/src/eval-run.ts`, `app/src/core/eval-executor.ts`, `app/src/core/providers/scripted.ts` | DeepSeek-Reasonix: `answer_isolation.go`, named in the `evals.ts` header (repo not cloned, path not verified)<br>hermes-agent: evals-from-post-mortems, `docs/30` F-4 (repo not cloned, path not verified) | idea only | Evals from post-mortems (ruling 28). The `evals.ts` header says the string-level half of answer isolation is implemented and Reasonix's OS read sandbox half is not. DEFERRED: same-model head-to-head benchmarks (need provider keys), forgecode take T-9 (`HZ_DEBUG_REQUESTS` request dump plus a key-free tool-hygiene eval pack, upstream idea: `FORGE_DEBUG_REQUESTS`, evidence in `docs/research/forgecode-deep.md` section on T-9). |
| 25 | `app/src/core/server.ts`, `app/src/main.ts` (`serve`), `app/src/contracts.ts` (`HZ_PROTO`, `ServerRequest`) | [`codex-rs/core/src/session/daemon_recovery.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/session/daemon_recovery.rs)<br>[`codex-rs/core/src/rollout.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/rollout.rs) | adapted (reduced) | Single-attach NDJSON JSON-RPC leader for one workspace; sessions resume BY ID; all mutation goes through the runtime. codex's `app-server-daemon` is multi-client and far larger. DEFERRED: multi-client attach, ACP bridge. Evidence: docs/28 status row 'Server mode' and rulings 53 and 59. |
| 26 | `app/src/core/checkpoints.ts`, `app/src/core/index.ts` (`rewindTo`), `app/src/core/session.ts` (conversational rewind) | none: original design (docs/12 S-47 checkpoint bounds, docs/28 waves 14c and FEAT-002 rewind) | idea only | No upstream file is claimed. codex rollout truncation (`thread_rollout_truncation.rs`) and Claude Code checkpoint docs are the loose conceptual neighbours; neither was read for this feature, so no URL is given. |


### Sources that could not be linked

These were used in earlier audit passes from clones that are not available in the current sandbox, so no file path can be checked. Their entries stay as prose pointers into `docs/audit/` and `docs/30-steal-list.md`; confirm the owner and pin a SHA before adding any link. See the 'Not cloned' table in [`research/upstream-pins.md`](research/upstream-pins.md).

- mini-swe-agent: `docs/audit/pass3/audit-mini-swe-report.md` (41 items).
- hermes-agent: `docs/audit/pass3/audit-hermes-report.md` (38 items).
- aider: `docs/audit/pass3/audit-aider-report.md` (35 items); matters for docs/09 more than here.
- DeepSeek-Reasonix: `docs/audit/audit-grok-ds-ompi-delta.md`. An older audit cites a `file:///` path into a private clone; do not reuse it.
- Kiro CLI and Freebuff/Codebuff: `docs/30-steal-list.md` section 5.11 (product documentation, no repository read).


### Deferred or not started, with reasons

| Item | State and reason |
|---|---|
| Planner/Executor dual-model routing (docs/08 section 2.8, R-runtime-44 to 51) | No code. Ancestor idea: DeepSeek-Reasonix planner/executor split (repo not cloned, path not verified). Needs a routing table consumer in `loop.ts` and per-role model config. Not started. |
| Teams: roles, bus, mailbox, election (section 2.12) | No code. Subagents are depth 1 via the `agent` tool; no team bus. Not started. |
| Scheduler, background jobs, catch-up (section 2.13, R-85 DST) | No code. NF-053 / docs/30 D-4 (at-most-once scheduling, hermes, not cloned) is the reference. Not started. |
| Goals state machine (section 2.10), long-horizon watchdogs and heartbeats (2.16) | No code beyond the `todo` tool. Not started. |
| Durable steering inbox and queueing across restarts (section 2.5) | The admission FIFO exists (`core/admission.ts`, ruling 22) but `loop.ts` does not dispatch through it; live steering into an in-flight stream (omp `live-steering.ts`, codex-style) is NOT implemented. Upstream reference for later: [`packages/agent/src/live-steering.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/live-steering.ts). |
| Model fallback chains and circuit breakers (section 2.7) | Only bounded request-phase retry exists. Not started. |
| Speculation wiring (ruling 65) | Module and tests exist, flag inert, loop never consults it. A new ruling is required before wiring. |
| Guardian model-backed classifier (rulings 48, 60, 66) | Deterministic classifier only. |
| forgecode takes T-15 (`--worktree <name>`) and T-17 (status line JSON-on-stdin script contract) | T-15: [`crates/forge_main/src/sandbox.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_main/src/sandbox.rs). Name it a worktree, never a sandbox, because `sandbox.report` must keep meaning OS confinement. T-17: Grok status line script contract, user-config only (see `docs/13-tui.md` and `docs/research/grok-tui-deep.md`). Neither started. |
| forgecode take T-8 (provider quirk table) and T-18 (text tool protocol for models without native tools) | T-8 and T-18 live in docs/10 (provider layer). Recorded here because T-18 would feed the loop a text-parsed tool call, which MUST go through the same guard and receipt path. See the deferral rows in `docs/10-cognition.md` Provenance. |
| External agents as subagents (dsh `subagent-claude-code`) | [`packages/subagent/subagent-claude-code/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent-claude-code/README.md). Not started. |
| Hermes managed-runtime remainder: framed owner/worker control pipe, turn frames | Excluded from ruling 22. Not started. |
| Hook lifecycle v2 and hooks trust gate | Named residuals in the `core/hooks.ts` header and docs/28 ruling 35. |
