# External review triage — 2026-11-07

> **Document class: historical evidence** (per `_conventions.md`). No normative force. It records the integrator's
> adjudication of one external review of the shipped implementation against the design corpus. Every verdict below
> was re-derived from the tree itself; where a claim could not be re-checked first-hand it says so. Where this file
> and the code disagree, the code wins and the disagreement is a defect to report.

**Scope.** The review (delivered 2026-11-07, reproduced over the working conversation) raised five headline findings
plus a blocker list and a docs-status list. **Method.** Each claim was re-read against the tree at commit `93da5f6`
(or the working tree, where marked, while two workstreams are in flight: NF-071 managed runtime; kernel guard
precedence + keyed anchors). **Verdicts:** CONFIRMED (reproduced), STALE (already fixed or landed after the review
was written), REFUTED (not reproduced), PENDING (in a file the in-flight workstreams currently own).

## 1. Headline findings

| # | Claim | Verdict | Evidence (re-read first-hand) | Action |
|---|---|---|---|---|
| 1 | The TUI is the readline chat loop, not the `docs/13` full experience (fullscreen, composer, transcript navigation, diff review, session/modal surfaces) | **CONFIRMED** | `app/src/tui/interactive.ts` (readline single-line prompt; streamed output into scrollback) vs `docs/13` §...; the richer TUI is `DESIGNED` in `docs/28` §1 | Queue the fullscreen/inline TUI as a first-class `docs/30` §4 item in the response wave; do not mark any `docs/13` surface implemented |
| 2 | The Rust kernel is a policy/audit prototype, not the effect host (TS tools perform the effects; receipts are written after the fact) | **CONFIRMED (architecture gap)** | The kernel implements guard decisions, leases, hash-chained event logs, receipts, NDJSON protocol (`kernel/src/{guard,eventlog,receipts,protocol}.rs`); effects execute in `app/src/tools/*.ts` and are receipted afterwards (`app/src/core/loop.ts` L719-789) | Recorded as the top V2 authority gap in `docs/28` §4 (response wave); the designed effect-host architecture stands unchanged |
| 3 | Receipts prove a record was written, not that an effect happened: caller-supplied digests, no independent observation, post-execution issuance, failure swallowed to a notice while the card can still read success | **CONFIRMED** | `ReceiptInput` fields are caller-supplied (`app/src/contracts.ts` L119-125); issuance after execution and inside a catch-to-notice (`app/src/core/loop.ts` L761-777); the card reports `result.ok` regardless (L779-786); receipts are issued for read-only calls too | Gap record in the response wave (independent postimage observation is V2 authority work) |
| 4 | Leases lack durable one-use consumption; the guard accepts caller-supplied leases; `GuardGate` caches approvals per kind+target for the rest of the turn; the "always" answer widens to a wildcard session lease | **CONFIRMED** | `Lease` has no consumed state (`app/src/contracts.ts` L86-91); caller leases are consulted ($`docs/28` ruling 1 documents this deliberately — the review's point stands against `docs/11` L4's durable CAS); approval reuse: `app/src/core/loop.ts` L337-339 (key = kind+target), L350-354 (cache hit returns allow), L386 (cache set after approval) | Gap record + an RC/code decision on one-use consumption and full-intent binding (V2 authority wave) |
| 5 | Code Mode escapes its declared boundary: ambient Bun/process access, no outer guard action, forgeable completion frames via direct stdout, only the inner `tools.call` path is policed | **CONFIRMED, with mitigations noted** | Child is an ordinary Bun process (`app/src/tools/codemode.ts` L156-160; env scrub removes credential-shaped names only); no `code_mode` case in `guardActionFor` (`app/src/core/loop.ts` L206-231) and `executeTool` runs *without any Guard call* when the mapping is absent (L669-698); the parent accepts `{"done":true}` from any stdout line (`codemode.ts` L300-306) while the child header itself admits direct stdout writes bypass the tagged channel (`codemode-child.ts` L12-16); already hardened (trust-hardening pass): inner calls re-enter guard/approve/receipts (L235-279), console via tagged channel, abort propagation | Response wave: (a) add `code_mode`/`agent` guard mappings so the outer call is admitted like any effect; (b) make the child tag every `process.stdout.write` behind the shim's channel so model code cannot emit control frames through the ordinary path (raw fd writes remain a documented residual); (c) state in `docs/28` that Code Mode is bridge-policed, not OS-sandboxed, until NF-016 confinement exists. **Response (wave 10):** (a) and (b) done — `code_mode` maps to `spawn` with a program digest and unmapped tools fail closed (ruling 24); control frames are keyed end-to-end, so a forged `done` line is ordinary output (ruling 25); (c) landed in the child header and `docs/28`. |
| 6 | The model can rewrite its own policy: `<workspace>/.hzcode/kernel/policy.json` is writable by the ordinary write tool and reloaded by the kernel on every check | **CONFIRMED — release-blocking** | Path chain: `kernel/src/guard.rs` L104-118 (loads `<state-dir>/policy.json` fresh per check); `app/src/core/kernel.ts` L694 (`stateDir = <ws>/.hzcode/kernel`); `DEFAULT_POLICY` allows workspace `fs.write` (`app/src/contracts.ts` L107-115); `write` maps to `fs.write` with the resolved path (`loop.ts` L218-222); no protected-path rule exists anywhere | Response wave: TS-side `protectedPathRefusal` in `app/src/core/kernel.ts` (both transports, evaluated before policy and leases) **plus** a hard-coded kernel-side rule in `guard.rs`. **DONE in wave 10** — see §6; residual: shell redirects (`docs/28` §4 gap 10). |

## 2. Blocker-list items

| Claim | Verdict | Evidence | Action |
|---|---|---|---|
| Wildcard session lease from the "always" answer (15 min, pattern `*`) | CONFIRMED (shape) | TUI lease creation path; `GuardGate` consult order L350-366; the widening itself is the pattern the kernel accepts (`docs/28` ruling 13 keeps `*` legal for session leases) | Fold into the one-use/binding decision above |
| Subagent inherits the parent's `sessionLeases` — violates `docs/09` R-tools-32 (children get grants, never parent leases) | **CONFIRMED** | `app/src/core/subagent.ts` L52-53 and L80, whose comment states it outright ("an 'always' answer covers the child too") | Response wave: stop passing parent leases into child runs; a child re-enters the approval path for its own effects |
| The `agent` tool has no guard mapping, so spawning a child never passes `agent.spawn` | **CONFIRMED** | `guardActionFor` (`loop.ts` L206-231) has no `agent` case; `GuardKind` already contains `spawn` (`contracts.ts` L74) | Response wave: map to `spawn` with a target naming the task |
| Kernel accepts caller-supplied leases without verification | CONFIRMED | Same evidence as finding 4; `docs/28` ruling 1 records the acceptance as intentional at this scale | Decision needed (kernel-issued lease tokens) |
| `logEvent()` swallows append failures | CONFIRMED | `loop.ts` L571-579, comment included ("must never take the chat down") | Recorded; the durable-bridge work (below) owns it |
| Receipts for read-only calls; digest of caller-supplied values; no postimage | CONFIRMED | `loop.ts` L761-768 runs for every tool | Recorded with finding 3 |
| Session store not WAL/strict; no transactional bridge between transcript (SQLite) and kernel JSONL | CONFIRMED | `app/src/core/session.ts` L126-129 — `bun:sqlite` with only `busy_timeout`; RC-16 ruled `synchronous=FULL` strict as the durability default (docs/28 gap 8) — the code does not implement it yet | Response wave: set the durability pragmas (file is owned by the NF-071 workstream today); the event-sourced bridge is V2 work |
| Preview spawns without `scrubEnv`; `close()` does not stop session previews | **CONFIRMED → env half fixed (wave 8, 2026-11-07)** | NF-071 moved preview onto `spawnOwned` (supervisor + killpg), but `owned-spawn.ts` passes `env` straight through and preview passed none — the leak was still real on landing. Integrator fix in the same wave: `preview.ts` now passes `env: scrubEnv()` like every other spawn. `close()` still does not stop session previews | The `close()`-stops-previews half stays in the audit-response wave |
| Shell has no exclusive class: two shell calls in one batch run concurrently | **CONFIRMED** | `concurrencyClassOf` defaults unknown tools to `shared` (`loop.ts` L238-240); `shell.ts` carries no class; `tests/core/batch.test.ts` currently *pins* the concurrent behavior | Response wave: mark `shell` exclusive and adjust that test to assert the serialization (the R-tools-39 resolved-resource ordering) |
| Kernel absent ⇒ `callLocal()` continues with the same policy (workspace writes allowed); `untrusted` is a label, not a posture; docs/06 specifies read-only + exit 3 when the kernel is absent | CONFIRMED (divergence) | `app/src/core/kernel.ts` L959-972 (fallback keeps serving guard checks from `LocalKernel` with `DEFAULT_POLICY`); `docs/06` S6/exit table says read-only + exit 3 | Ruling needed: fail-closed read-only posture in `untrusted` mode, or an RC amending the spec — recorded, not decided here |

## 3. Docs-status items

| Claim | Verdict | Action (response wave) |
|---|---|---|
| `README.md` says RC-15 while `_conventions.md` is at RC-16 | CONFIRMED | Update to RC-16; soften "complete" to name the unassigned 17–23 slots |
| `docs/00-index.md` header and §11 list stop at RC-15 | CONFIRMED | Update both to RC-16 |
| `CURRENT_RUN.md` says the V1 mission is complete while `docs/25` records no phase formally exited; counts stale (364/34) | CONFIRMED | Rewrite the TL;DR with the roadmap-exit caveat and current counts |
| `docs/11` §9.1 claims `GuardDecisionV1` + reason codes `TESTED + VERIFIED` | CONFIRMED over-claim | Downgrade the row to name what actually exists (the shipped `GuardDecision` + policy/hashes matrix in `docs/28` §1) and mark the §4.2 struct + reason-code registry `DESIGNED` |
| `docs/30` item 5 refers to a `repo_map` tool that is not registered | **REFUTED (stale)** | `repo_map` landed in `0616584` (wave 5) and is registered in `app/src/tools/index.ts`; the review predates it |
| Docs 17–23 unassigned | Already recorded | `docs/24` §13 gap 1 owns this; only the README "complete" wording changes |
| README mixes designed and shipped ("300+ models", sandbox, surfaces) | PARTIAL | The status line separates them; soften the strongest nouns in the response wave |

## 4. What this triage does not claim

- It does not re-audit the two in-flight workstreams; their findings land with their own reports and this file's
  STALE/PENDING rows close only when those land and are re-run.
- It does not decide any of the design questions the review surfaces (effect host, one-use leases, fail-closed
  posture, Code Mode confinement); each names the ruling it needs.
- The confirmed items are statements about the shipped tree at `93da5f6`, not about the design corpus, which
  specifies the stronger behaviour in every case cited.

## 5. Postscript — both in-flight workstreams landed (2026-11-07, same day)

- **NF-071 managed runtime** landed (`docs/28` §1, ruling 22; framed owner/worker control pipe excluded, FIFO not yet wired into `loop.ts` dispatch). The one row above it changed is the preview row — the spawn path moved to `spawnOwned` but the environment was still inherited until the integrator's same-wave fix (`env: scrubEnv()`); the `close()`-stops-previews half stays open. No other review claim touches process ownership or admission, so none other moved.
- **The kernel wave** (guard precedence → R1 exactly; keyed anchors) closed `docs/28` §4 gaps 5 and 7 (forgery). Neither is a claim of this review. Finding 6 (the model-writable policy store) is untouched by it and remains the release-blocking open item.
- Integrator-run evidence on the integrated tree after both waves: `bun test` 411 pass / 0 fail / 39 files; `cargo test` 22 integration + 5 unit; `hz-kernel --selftest` → 18 checks; `ops/gates.sh` 6/6.

## 6. Response wave closure (2026-11-07, wave 10 — `docs/28` rulings 24–25)

| Row | Status after wave 10 |
|---|---|
| Finding 5 (Code Mode) | **Outer admission + framing CLOSED** — `code_mode` → `spawn` (program digest); unmapped tools refused; control frames keyed (forged `done` is output). OS sandboxing remains DESIGNED (NF-016). |
| Finding 6 / policy store | **CLOSED** — kernel structural deny + TS refusal in both transports (`docs/28` §4 gap 10); residual: shell redirects. |
| Blocker: subagent parent leases | **CLOSED** — children carry no parent leases; they re-enter approval. |
| Blocker: `agent` mapping | **CLOSED** — `agent` → `spawn`; unmapped tools fail closed. |
| Blocker: shell `shared` class | **CLOSED** — `shell` is `exclusive`; serialization pinned in `batch.test.ts`. |
| Blocker: session pragmas | **CLOSED** — WAL + `synchronous=FULL`, verified by PRAGMA read-back across reopen. |
| Finding 4 approval reuse | **PART** — approval binding CLOSED (full-intent key); one-use consumption + kernel-issued tokens remain open (needs a ruling + kernel work). |
| Finding 3 (receipts) | **OPEN** — post-hoc records with caller-supplied digests; independent postimage observation is V2 authority work. |
| `logEvent` swallow + durable bridge | **OPEN** — recorded; the durable transcript↔kernel bridge owns them. |
| Preview `close()` | **OPEN** — env half fixed (wave 8); `close()` still does not stop session previews. |
| Kernel-absent posture | **OPEN** — needs a ruling: fail-closed read-only in `untrusted`, or an RC amending `docs/06`. |

Integrator-run evidence for the closures: `bun test` 438 pass / 0 fail (41 files); `cargo test` 23 + 5; `hz-kernel --selftest` OK (18 checks, hermetic scratch — bare runs repeat); `ops/gates.sh` 6/6. Also closed in wave 10, found during integrator verification rather than in the review: the kernel selftest was non-hermetic against a default state dir (stale `selftest-*` scratch collided on repeat runs) — it now works in a unique scratch directory and removes it afterwards.

---

*Related documents: [`docs/28`](../28-implementation-status.md) §4 (gap records), [`docs/30`](../30-steal-list.md)
§4 (execution queue), [`docs/29`](../29-final-audit.md), [`docs/11`](../11-authority-safety.md) (the contracts the
confirmed divergences fall short of).*
