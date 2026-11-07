# 27 — Implementation Plan, Runtime Viability, and Engineering Rollout

> **Binary:** `hzcode` · **Aliases:** `hz`, `horizon` · **Product:** HorizonCode
> **This document answers:** *where do we start, in what order, on what machine, with what gates, and how do we know each step is real.*
>
> **Companion:** `docs/26-learning-synthesis-2.md` (what the deep-dive pass taught us and which of it we adopt). This plan assumes that learning; where a plan item is sourced from a specific reference or from that synthesis, it is cited.

---

## 1. Purpose

The spec set (`docs/00`–`docs/30`; the design corpus proper is `00`–`25`, and `26`–`30` are the learning, plan, status, audit and queue documents — RC-14) defines *what* HorizonCode is. This document defines **how it gets built**, concretely:

1. The **bootstrap sequence** — the exact order in which directories, packages, crates, gates and behaviours appear, so that every week ends with something runnable.
2. A **vertical-slice ladder** (V0–V7) that maps one-to-one onto the phases `M0`–`M8` of `docs/25-roadmap-and-glossary.md` but at the level of *demoable software*, not milestones.
3. The **runtime viability report** — measured, with evidence, on the build machine used for this specification (and what that machine cannot prove, which is delegated to CI).
4. The **performance, cache-stability and token-economy engineering plan** — because those are requirements from day one, not optimizations applied later.
5. The **tier-parity program** — the plan for making cheap models produce frontier-class results on multi-hour, cross-repository and architecture-scale tasks.
6. The **dogfooding plan** — how HorizonCode's own subagent system is used (and thereby hardened) while building HorizonCode.

What this document is *not*: a reduced scope. Nothing in the spec set is dropped; things are **ordered**.

### 1.1 Binding principles

| # | Principle | Consequence for the build order |
|---|---|---|
| IP-1 | **Speed is a feature, and it is regressed against from commit one.** | The budgets registry (`docs/16-operations.md` §8) and its bench harness exist in V0, before the second tool. |
| IP-2 | **Cache-hit stability is law.** A change that halves context cost is worthless if it breaks the byte-stable prefix. | The cache-guard contract test (`docs/10-cognition.md`, `docs/24-feature-catalog.md` NF row for cache-first compiler) is in CI from V1, before the tool catalogue grows past five tools. |
| IP-3 | **Authority is not built by the process it constrains** (ADR-002/003). | The kernel exists in V0 as a stub process from the very first end-to-end run — never as "we'll split it out later". |
| IP-4 | **Every effect is receipted; `UNKNOWN` is a first-class terminal state.** | The receipt ledger and reconciliation procedure are V2 exit criteria, not V3 features. |
| IP-5 | **Token economy is designed in, not squeezed out.** | Code Mode / ACI windowing / output budgeting are planned before the first MCP integration so tool outputs never become an unmanaged flood we later have to retrofit. |
| IP-6 | **The model tier is a parameter, not an assumption.** | Every prompt, loop and tool contract is written to be tier-portable from V1; the tier-parity evals run from V2 on. |
| IP-7 | **Long-horizon work is tested with hours-long scenarios in CI nightlies, not assumed.** | The long-horizon scenario harness (multi-hour sim) appears in V3, runs nightly from M3. |
| IP-8 | **Documentation is the design record and it is versioned with the code.** | `docs/` moves into the implementation repo at bootstrap; PRs that change behaviour must change the doc or cite why not (see the doc-update ledger in `docs/26-learning-synthesis-2.md` §5). |

---

## 2. Rules (numbered, testable)

**R-impl-1.** The implementation repository bootstraps as a **single Bun workspace + single Cargo workspace** in one repo (`horizoncode/`) with `packages/` (TS) and `crates/` (Rust) as siblings; `docs/` from the spec set moves in verbatim and is not rewritten during bootstrap.

**R-impl-2.** The **first commit** on the implementation repo must contain: workspace manifests, CI workflow with at minimum the import-boundary gate, the budgets registry file, and `docs/`. No source file may merge before the import-boundary gate runs in CI (it must be red until the first violation-free layout exists — proof the gate executes).

**R-impl-3.** Every vertical slice (V0+) is **demoable**: it ends with a recorded script (`scripts/demo/vN.sh`) that a fresh clone can run in a clean container and that asserts observable output. A slice without a demo script is not started until the previous slice's demo is green.

**R-impl-4.** The **kernel process (`hzk`) is spawned by the CLI from V0**, first as a stub implementing `hz.initialize` + `hz.ping` over the kernel ABI (`docs/07-apis-and-contracts.md` §4.2), so the process model, handshake, digest pinning and version negotiation are exercised from the first run — and never regress.

**R-impl-5.** **No feature work merges if it fails any gate in the CI catalogue** for its slice (`docs/16-operations.md` §2.4). Gates are added slice by slice per §3.2; a gate is never removed, only versioned (a superseding gate carries the old one's assertions).

**R-impl-6.** **Budgets are measured, not asserted.** Each performance budget in the registry has a bench that runs on every PR (fast subset) and nightly (full matrix). A regression beyond the gate threshold fails the build with the diff attached. Numbers live in one file; code reads the file.

**R-impl-7.** **The cache-guard contract test is a required status check** from V1 onward, and its strict mode cannot be disabled by workspace config (`docs/10-cognition.md` R-rules on cache discipline). The only sanctioned relaxation is the explicit, user-visible `cacheMode: 'reduced'` posture, which records the reason in the session and surfaces it in `hzcode session verify` output.

**R-impl-8.** **Authority paths are implemented exactly once.** The effect path (validate → permission → authorize → lease → execute → observe → settle → receipt) has a single implementation (`effect/runtime`) and a CI test asserting no other module constructs a `KernelClient.execute` call (`docs/04-lld.md` §7, `docs/11-authority-safety.md`). This test exists from V2 and is the last gate any refactor may break.

**R-impl-9.** **Linux sandbox is the first-class development target**; macOS and Windows landlord implementations ship in V2/V3 but are developed against CI runners from their first commit (developer boxes cannot prove them). The sandbox guarantee test matrix (`docs/11-authority-safety.md` §2) runs on all three OSes nightly from the commit that lands each backend.

**R-impl-10.** **Local model support (Ollama/LM Studio/llama.cpp-class) is a V1 provider, not a V4 nicety**, because the tier-parity program and the speculative-decoding workstream both need a controllable local endpoint on day one of evaluation.

**R-impl-11.** **The eval harness exists before the self-improvement loop** — V2 ships `hzcode eval run` with the pairwise task suite; M8's proposals consume it. Learning features never ship before the measurement they depend on.

**R-impl-12.** **Repository hygiene**: no generated file is committed unless the drift check runs in CI; every crate/package has an owner field in its manifest; `.hz/` state is never committed (`docs/15-extensibility.md` §7.7 — nothing that confers authority lives under a repository).

**R-impl-13.** **Every slice lands behind the parity ratchet** (`docs/14-surfaces.md`): when a capability exists on two surfaces, a test asserts behavioural equivalence; the ratchet may only increase.

**R-impl-14.** **CI has a `nightly-matrix` job** running: cross-platform sandbox tests, full bench suite, long-horizon scenario sim (V3+), tier-parity evals (V2+, against a small fixed task set), and adversarial tests (`docs/11-authority-safety.md` §9). Nightly failures page via the watchdog channel; they do not silently rot.

**R-impl-15.** **The 90-day rule on open questions**: every open question in `docs/25` §8 and this document's §12 has an owner and a date; unresolved-at-date items are re-decided (adopted, deferred with a new date, or rejected) in a recorded ruling (`RC-*` in `docs/_conventions.md`).

---

## 3. Start here — the vertical-slice ladder

### 3.1 Slice definitions

Each slice states: goal · the minimum that must exist · the exit demo · gates newly activated. Slices map to milestones: V0=M0, V1=M1, V2=M2, V3=M3, V4=M4, V5=M5, V6=M6+M7, V7=M8.

| Slice | Goal | Exit demo (scripted) | Gates newly active |
|---|---|---|---|
| **V0** | Walking skeleton: CLI ↔ kernel stub ↔ event log on disk | `scripts/demo/v0.sh`: `hzcode doctor` prints CLI/kernel/protocol versions; `hzcode run --fake-model hello` appends events, projects them, prints reply, exits 0 | import-boundary; functional-slot test for kernel handshake; single-writer log test |
| **V1** | First real turn: real providers, context compiler, five read tools, minimal TUI + headless | `scripts/demo/v1.sh`: against a local model endpoint, `hzcode run "what does this repo do?"` reads files and answers; JSONL headless output validated against schema; session resumes | **cache-guard v1**; tool-declaration completeness; event-catalogue parity (subset); bench (fast) |
| **V2** | Authority: Guard, effects, leases, receipts, approvals, sandbox v1 (Linux), eval harness v1 | `scripts/demo/v2.sh`: a model edit request prompts for approval, executes in bwrap+landlock, produces a receipt; `kill -9` mid-effect reconciles to `UNKNOWN` then settles; sandbox guarantee tests pass on Linux runner | effect-path uniqueness; sandbox guarantee (Linux); adversarial suite v1; tier-parity evals (small set) |
| **V3** | Surfaces & extensibility: fullscreen TUI complete, server + web minimal, MCP client, plugins v1, skills/commands/hooks; long-horizon sim v1 | `scripts/demo/v3.sh`: full TUI session recorded; web surface reviews the same hunks (parity assertions); an MCP server's tools callable; a signed plugin loaded in the sandbox host | parity ratchet; cross-platform sandbox (macOS/Windows runners); long-horizon nightly; plugin boundary tests |
| **V4** | Intelligence: memory 4 tiers + retrieval, compaction suite, **Code Mode v2**, ACI windowed terminal, plan/goals/todos, fleets v1, teams v1, preview environments v1, debug recorder v1 (NF-051 code mode and NF-055 preview have reduced v1 slices shipped per `docs/28-implementation-status.md` §1; V4 completes them) | `scripts/demo/v4.sh`: a multi-file refactor driven by Code Mode with one round-trip and a filtered result; a subagent fleet with dependency graph; a failed run investigated from a recorded debug trace; a web preview environment booted and screenshotted into the loop | context-budget gates; code-mode sandbox escapes (adversarial); compaction correctness (R112 class); token-economy budget |
| **V5** | Scale & long-horizon: worktree pool, fleet scale, scheduler, watchdogs, remote execution | `scripts/demo/v5.sh`: three concurrent sessions in one workspace under worktree pools; a scheduled nightly job fires with occurrence journal proof; a 3-hour unattended run completes with drift watchdog events and resumption after a forced restart | multi-process access; crash-resume matrix; unattended watchdog tests |
| **V6** | Ecosystem & enterprise: marketplace, SDKs (TS/Py/Go/Rust), managed policy, SSO, audit export, air-gapped mode, IDE bridge full, desktop | `scripts/demo/v6.sh`: SDK round-trip from each language; signed managed policy narrows a posture and the guard denies; audit export verifies receipt chain | SDK contract tests; policy precedence tests; export/import (session archive) round trip |
| **V7** | Self-improvement under cache discipline: trajectory capture → evals → proposals → skillify; A/B under cache-guard | `scripts/demo/v7.sh`: a proposal is produced from captured trajectories, evaluated offline, human-gated, and — only when accepted — manifests as a skill via `skillify`; authority diff is asserted to be empty | proposal lifecycle tests; authority-narrowing assertion; eval-regression gate |

### 3.2 Gate activation schedule (summary)

- **V0:** import-boundary · kernel-handshake functional · single-writer log · layering (repolint) · file/function size.
- **V1:** + cache-guard v1 · tool-declaration completeness · event-catalogue parity · bench-fast · prompt-governance (fragments registered).
- **V2:** + effect-path uniqueness · sandbox guarantee (Linux) · adversarial v1 · tier-parity eval set · receipt/reconciliation tests.
- **V3:** + parity ratchet · cross-platform sandbox matrix · plugin boundary · long-horizon nightly · MCP conformance.
- **V4:** + code-mode escape suite · compaction correctness · context-budget · token-economy bench · preview-env isolation.
- **V5:** + multi-process access · crash matrix completion · watchdog/drift tests.
- **V6:** + SDK contracts · policy precedence · archive round-trip · air-gap checks.
- **V7:** + proposal lifecycle · authority-narrowing · eval-regression.

`docs/16-operations.md` §2.4 owns the full catalogue and definitions; this table is the *ordering*, and R-impl-5 makes the ordering binding.

### 3.3 Why this order

1. **The walking skeleton first** (V0) because process topology and the log are the two things that are expensive to retrofit and cheap to stub. The fake provider keeps V0 free of provider bugs.
2. **The cache-guard before the tool catalogue** (V1) because prefix stability degrades the moment tool schemas churn; enforcing it at five tools is a contract, at sixty tools it is a rewrite.
3. **Authority before surfaces** (V2 before V3) because every surface added before the Guard is a surface with a backdoor to close.
4. **Eval harness before self-improvement** (R-impl-11) for the same reason in the other direction.
5. **Code Mode / ACI / token economy before MCP scale-up** (V4, and Code Mode's *interface* stubbed in V1) so the "10,000-tool problem" is met with a designed answer, not an emergency one.

---

## 4. Repository bootstrap and toolchain

### 4.1 Layout (target)

```
horizoncode/
├── README.md                    # product readme (from the spec repo)
├── docs/                        # the spec set, moved in verbatim (R-impl-1)
├── packages/                    # Bun workspace — TypeScript
│   ├── protocol/                # HZ_PROTO types + codegen (first to exist)
│   ├── core/                    # controller, step engine, context compiler, session
│   ├── tools/                   # tool registry + built-in tools
│   ├── provider/                # provider layer + codecs
│   ├── tui/                     # terminal UI
│   ├── server/                  # HTTP/SSE + web assets
│   ├── kernel-client/           # the ONLY package allowed to speak the kernel ABI
│   └── cli/                     # `hzcode` entry, `hz`/`horizon` aliases
├── crates/                      # Cargo workspace — Rust
│   ├── hz_kernel/               # the kernel (binary target `hzk`; starts as a stub in V0); owns
│   │                            #   receipts, THS hash chain and the effect host — one crate, not three
│   ├── hz_abi/                  # shared/generated ABI types (capability ids, receipts, decisions)
│   └── hz_sandbox/              # platform sandbox backends + guarantee vectors
├── bench/                       # benches + budgets.toml (one registry)
├── scripts/demo/vN.sh           # one demo per slice (R-impl-3)
├── tools/                       # dev tooling: repolint, gate scripts, codegen
├── Cargo.toml / package.json / bunfig.toml / rust-toolchain.toml
└── .github/workflows/           # ci.yml + nightly-matrix.yml
```

Package and crate **names** are frozen by `docs/_conventions.md` §3/§4; the list above is the *scaffolding order*, not a new naming. The full package/crate maps live there.

### 4.2 Toolchain (pinned, viability-proven — §6)

| Tool | Pin | Evidence |
|---|---|---|
| Bun | **1.4.4** | installed + smoke-tested on the build machine (`bun -e` round-trip OK) |
| Rust / cargo | **1.99.1** (stable) | installed + smoke-tested (compiled and ran a test binary) |
| SQLite | bundled via the Rust driver (no system dependency) | design decision — `docs/12` specifies WAL + single-writer |
| Node-compat | Bun's built-in runtime only; no Node separate | keeps one runtime, faster startup |

`rust-toolchain.toml` pins the exact version; `bun.lock` and `Cargo.lock` are committed; CI builds with the same pins (R-impl-5's determinism precondition).

### 4.3 First-day files

1. `docs/` moved in; `AUDIT.md` kept.
2. `tools/repolint` — the layering law checker (forbidden imports: core→tui, anything→kernel-client except effect/runtime). It fails *by design* until the first compliant skeleton exists (R-impl-2).
3. `bench/budgets.toml` — every budget from `docs/16` §8 in one file; benches read it.
4. `.github/workflows/ci.yml` — the V0 gate set (§3.2).
5. `scripts/demo/v0.sh` — the walking-skeleton demo.

### 4.4 Nothing else

No monorepo framework beyond the two workspace files; no generator; no vendored code. Dependencies are introduced per slice and each one lands with an ADR (see §12) — the spec set's avoidance of framework lock-in is a build-speed asset.

---

## 5. Workstreams and the serial spine

Six workstreams; only the first is strictly serial.

| WS | Name | Owns | Can start |
|---|---|---|---|
| **W1** | Kernel & authority | `crates/*`, Guard, leases, receipts, sandbox backends | V0 (stub), V2 (real) |
| **W2** | Runtime core | `packages/core`, protocol, provider layer, context compiler | V0 |
| **W3** | Tools & cognition | `packages/tools`, read/edit/shell, retrieval, memory, compaction, code mode | V1 |
| **W4** | Surfaces | `packages/tui`, `server`, `cli`, later `web`/`desktop`/`ide` | V0 (cli), V1 (tui) |
| **W5** | Intelligence & fleets | subagents, teams, plan/goals, preview envs, debug recorder | V4 |
| **W6** | Engineering systems | CI gates, benches, evals, releases, docs governance | V0 |

**The serial spine** is: `packages/protocol` (HZ_PROTO types + codegen) → `kernel-client` handshake → `core`+`hzk` stubs → everything else consumes the frozen protocol. This is why V0 exists: it forces the spine to be real before the fan-out.

W1 and W2 must agree on the **kernel ABI** before V2 work starts (the ABI is `docs/07` §4.2; codegen from one schema source keeps CLI/kernel/client in lockstep — `docs/16` §2.4's ABI-compatibility gate enforces it).

---

## 6. Runtime viability report (measured)

### 6.1 The build machine (as used for this specification)

| Property | Value |
|---|---|
| CPU | 4 vCPU (shared) |
| RAM | 8 GB |
| Kernel | gVisor-sandboxed container (no nested namespaces guarantees, no Docker daemon) |
| Preinstalled | Python 3.13, git; **no Bun, no Node, no Rust, no Docker** |
| Network | all toolchain hosts reachable (bun.sh, rustup, npm, crates.io) |

### 6.2 What was proven (VERIFIED, with evidence)

| Claim | Evidence |
|---|---|
| Bun toolchain installs and runs | `bun --version` → `1.4.4`; `bun -e '…'` executed a script successfully |
| Rust toolchain installs and builds | `cargo --version` → `1.99.1 (5f94df478 2026-08-27)`; `cargo run` compiled and executed a test binary that emitted output |
| Sources reachable | HTTPS reachability checks passed for bun.sh, rustup.rs, registry.npmjs.org, static.crates.io |
| Repos clonable | all fifteen reference clones completed (the eight of the first tour + OpenHands, SWE-agent, wshobson/agents, opencode-v2 + aider, mini-swe-agent, hermes-agent) |

### 6.3 What this machine can *develop* vs cannot *prove*

| Activity | Here | Notes |
|---|---|---|
| TS packages: typecheck, unit tests, protocol codegen | ✅ viable | Bun runs the full toolchain suites |
| Rust crates: build, unit tests (pure logic) | ✅ viable | compiled smoke test passed |
| Event log, projections, CLI↔kernel handshake (V0/V1) | ✅ viable | no privileged syscalls needed |
| Linux sandbox guarantee tests (bubblewrap, Landlock, seccomp, cgroups) | ❌ **not provable here** | needs a real kernel; gVisor interposes syscalls → must run on CI (`ubuntu-latest` runner) |
| macOS Seatbelt / Windows AppContainer tests | ❌ | CI matrix only |
| Performance budgets (authoritative numbers) | ❌ | gVisor adds syscall overhead; here numbers are **indicative only**; authoritative runs on dedicated benches in CI (per `docs/16` §8) |
| Multi-process/daemon integration (server surface, tunnels) | ⚠️ partially | possible but slow; keep to CI |

### 6.4 Viability verdict

**Verdict: viable to build here; authoritative verification lives in CI.** The two halves of the stack (bun/TS and cargo/Rust) are installed, pinned and smoke-proven. The design's decision to put privilege in a separate Rust process means *unprivileged development* is fully possible in a sandbox itself — which is also a nice early test of the process model: if we cannot run and test the kernel's *logic* under gVisor, we have over-coupled it to privileged facilities.

**Operational rule (added):** developer machines run V0–V1 demos + unit tests; the V2+ demos, sandbox matrix and benches run in CI from the first commit that needs them. `scripts/demo/vN.sh` detects a non-conforming host and prints which suite must run in CI (never silently skips).

---

## 7. Performance, cache-stability and token-economy engineering

### 7.1 Benches before features (R-impl-6)

The five benches land in **V0/V1**, each reading its budget from `bench/budgets.toml` (one registry, `docs/16` §8 owns the numbers):

| Bench | What it measures | First appears |
|---|---|---|
| `startup` | cold + warm CLI start to prompt-ready | V0 |
| `handshake` | CLI ↔ kernel initialize + ping | V0 |
| `log-append` / `projection-write` | the durability path (p99) | V0 |
| `context-compile` | P0–P2 + T0–T4 assembly (p99) | V1 |
| `dispatch` | tool call → kernel ack → result (per class) | V2 |

PRs run the fast subset; the full suite + cross-machine variance runs nightly (R-impl-14). A regression beyond threshold fails the PR with the delta and the offending commit range attached.

### 7.2 Cache-hit stability as a contract (IP-2, R-impl-7)

The cache-first compiler's byte-stability is asserted, not hoped:

1. **Contract test (V1, blocking):** compile the same (config, tools, memory) twice across process restarts and assert the provider-visible prefix is **byte-identical** (hash equality), and that the tail is marked ephemeral. Run against a fake provider in CI; run against one real provider nightly to catch codec drift.
2. **Cache-guard:** any turn whose prompt breaks prefix identity without a declared cause fails the guard and (in strict posture) blocks the turn. Strict cannot be silently weakened; the sanctioned relaxation is the explicit `cacheMode: 'reduced'` posture with a recorded reason (R-impl-7).
3. **Breakpoint placement policy (from SWE-agent's `cache_control last_n_messages: 2` and per-provider semantics):** the codec layer owns a declared placement policy per provider family — for explicit-breakpoint providers: one breakpoint at the stable-prefix end, one at the tail boundary; for automatic-cache providers: no markers. The policy is part of the codec contract (`docs/10`).
4. **Credential-affinity pinning** (already in `docs/10`): a session's prefix must not silently switch account/endpoint mid-session, or the cache is lost server-side.
5. **Cache-hit ratio is a first-class metric** with a per-session and fleet display, and a nightly eval that flags a drop > X% with attribution (config change / tool churn / prompt drift).

### 7.3 Token economy (IP-5)

Tool outputs are the dominant token cost of real sessions. The build order makes every cap structural:

| Device | Where | Slice |
|---|---|---|
| Bounded tool outputs with stable in-band truncation markers | tool executor | V1 |
| `read` modes `lines`/`outline`/`window` (SWE-agent filemap + 100-line window lesson) | tools | V1/V4 |
| Explicit empty-output narration (`next_step_no_output_template` lesson) | step templates | V1 |
| Shell output taming env (`PAGER=cat`, `GIT_PAGER=cat`, `LESS=-R`, `PIP_PROGRESS_BAR=off`, `TQDM_DISABLE=1`) | shell tool defaults (workspace may narrow, recorded in receipt) | V1 |
| Output budgeter + per-turn retrieval budget | context compiler | V1 |
| Code Mode v2: one round-trip instead of N, filtering in the sandbox, progressive discovery | tool group | V4 |
| Compaction ladder with `keep_first` / `minimum_progress` / bounded hard-reset retries (OpenHands lesson) | compaction | V4 |
| Deferred tool loading (`tool_search`) so the catalogue never floods context | tool registry | V4 |

**The Code Mode decision is in:** adopt with the CM-1…CM-14 rules now owned by `docs/09-tools.md` (source: `docs/26` §2.5; verbatim copy: `docs/29` Part D §09), bringing it forward to V4, with the guarantee-vector confinement (never the phrase “QuickJS-class”) and per-nested-call leases/receipts.

### 7.4 Multi-file and multi-folder edits without losing context (user goal)

The machinery that makes this true, in dependency order: parallel tool batches (V1) → edit preimage pins + stale-preimage conflicts (V2, already specified) → worktree isolation for concurrent sessions (V5) → the **edit ledger**: a per-turn, receipt-linked list of every file/hunk that changed (V2) surfacing in the TUI change-review and in the session export. The context compiler never needs to re-read a file to know its current state: the ledger plus CAS blobs give it the post-images. That is the design answer to “multi-file edits without losing context” — context is *reconstructed*, not remembered.

---

## 8. Tier-parity program (cheap models, frontier results)

**Goal.** On HorizonCode, a low-cost model (DeepSeek-V4.1-Flash class) doing multi-hour tasks, cross-repository refactors and architecture design should produce outcomes comparable to a frontier model. This is a *program with a metric*, not a prompt trick.

### 8.1 Where the advantage comes from

| Lever | Mechanism | Slice |
|---|---|---|
| **1. Scaffolding that compensates for weaker reasoning** | plan-then-execute state machine (harness-enforced: plan → propose → verify → lint — the governance blueprint), strict-REPL prompt variants with worked examples (SWE-agent `bash_only` lesson), ONE-command-per-turn mode for instruction-following-only models | V1 (variants), V4 (blueprints) |
| **2. Bounded subtasks with contracts** | subagents must declare input/output contracts (the wshobson *engineered minority* lesson): a weak model executes a bounded unit with a verdict format, not an open-ended role | V4 |
| **3. Retrieval discipline** | repo map + symbol index + outline/window reads so weak models never drown in printouts (SWE-agent 90%-class reduction, bounded) | V1/V4 |
| **4. Verification loops** | evidence gate lowers unverified claims; pre-submit review gates (repro-rerun / test-file protection) execute *without* model virtue | V2/V4 |
| **5. Amplification without a second brain** | deterministic host routing (planner/executor), not classifier magic; the weak model does macro, the harness does micro | V1/V4 |
| **6. Local acceleration** | speculative decoding (draft model + target) for local/self-hosted endpoints — ~3× speedup class; small specialist models for micro-tasks (`models.run` inside code mode, classification, formatting) | V4 |
| **7. Long-horizon durability** | checkpoints, compaction ladder, scheduler, watchdogs, resumability — the harness, not the model, carries task persistence across hours | V4/V5 |

### 8.2 The measurement that keeps it honest

- **Paired eval suite** (V2, small set; V3, full): the same tasks run on a frontier model and on the target cheap model, scoring **outcome parity per task class** (single-file bugfix, multi-file feature, cross-repo refactor, architecture plan, long-horizon unattended run).
- **Parity gap** is a tracked metric with a ratchet: it may narrow, never widen, between releases (gate: `parity-gap` in the nightly matrix).
- **Cost-per-completed-task** is the second axis: parity claims must survive the cost comparison (otherwise we have just recreated the expensive model).
- Every scaffolding feature that claims parity help must show a measurable delta on the suite or is removed (no prompt superstition survives a gate).

### 8.3 What we explicitly do NOT do

- No hidden model swapping at runtime (a cheap-model session never silently routes to a frontier model — that is a budget/billing lie).
- No task “simplification” that reduces user-visible capability (if the cheap model can't do X, that is reported, not silently worked around).
- No training-time dependencies in the critical path (distillation datasets are generated *by* the harness for optional fine-tuning, never required).

---

## 9. Subagent system build plan and dogfooding

### 9.1 What the wshobson/agents deep-dive changed

That corpus (202 agents, 92 plugins — *content*, no runtime) looks large but its design lesson is small and sharp: **about 15 of the 202 are engineered in the way that matters — a style guide with 202 examples, of which about 15 are good; the rest are the same template with nouns swapped** — and the engineered minority is what works. The public census facts (model distribution sonnet 35% / opus 27% / inherit 26% / haiku 12%; 93 % of agents declare no tool allowlist; 61 are byte-similar duplicates) justify these build rules:

**R-impl-16.** Every bundled `AgentProfileV1` MUST declare: a bounded purpose, an explicit **input contract** (what it requires to exist), an explicit **output contract** (a named verdict/artifact format), and a **tool allowlist** — a profile missing any of the four fails the profile-completeness gate (extends the tool-declaration gate to profiles).

**R-impl-17.** Fleet roles follow the tool-restriction discipline seen in the engineered minority: **orchestrators get no write tools** (lifecycle + task + messaging verbs only); **reviewers are read-only on the workspace**; **validators get no messaging**; **judges get no Bash**. These are enforced by the capability grants the spawner issues, not by prompt text (doc 08 fleet rules).

**R-impl-18.** A child's terminal result MUST carry a machine-readable verdict (pass/fail/blocked + evidence refs), not prose only — the parent merges verdicts, never vibes. `blocked[]` reporting is mandatory: a blocked dependent is never silently dropped.

**R-impl-19.** Duplicate-role protection: the **profile registry has one canonical entry per role**; the marketplace may ship *variants* (same contract, different model tier/prompt), and variants must declare which canonical contract they satisfy. (This is the direct fix for the 61-duplicate census.)

### 9.1a The bundled fifteen (roster decided by the deep dive)

Bundle exactly fifteen profiles, one per capability class — domain knowledge goes to **skills**, never to a twentieth agent (the source repo ships 185 skills alongside 202 agents and proves the split). Tier: strongest for verdicts/irreversible decisions, mid for transformations, cheapest for extraction/mechanical relay; `relay` is always cheapest.

| # | Profile | `kind` | Tier | Grant sketch (ceiling) | Result contract highlights |
|---|---|---|---|---|---|
| 1 | `worker@builtin` | act | mid | `mutate` (worktree) | `{summary, changed_paths[], tests_run[], blockers[], deviations[]}` |
| 2 | `scout@builtin` | research | cheapest | `observe` | `{findings[], locations[], confidence, open_questions[]}` |
| 3 | `architect@builtin` | plan | strongest | `observe`+`verify` | steps `{id, goal, depends_on[], owns_paths[], acceptance[], verify_cmd}` |
| 4 | `reviewer@builtin` | verify | strongest | `observe` only | `verdict ∈ {pass, pass_with_findings, fail}` + typed findings |
| 5 | `lead@builtin` | team_lead | strongest | `observe`+`coordinate`, **no write verbs** | `{plan_ref, children[], merged_findings[], blocked[], decisions[]}` |
| 6 | `security-auditor@builtin` | verify | strongest | `observe`+`security.scan` | reviewer schema + CWE/OWASP + `reachable` |
| 7 | `debugger@builtin` | custom | strongest | `observe`+narrowed execute/mutate | `{root_cause, evidence[], hypotheses_tested[], patch, regression_test, prevention}`; refuses without a failure artifact |
| 8 | `tester@builtin` | act | mid | `mutate` ∩ test globs | `{tests_added[], tests_changed[], coverage_delta, failure_paths_exercised[]}` |
| 9 | `perf-profiler@builtin` | research | mid | `observe`+narrowed execute | baseline **and** delta required; hotspots with evidence |
| 10 | `refactorer@builtin` | act | mid | `mutate` (worktree) | `behaviour_preserved_evidence` mandatory; refuses with no test command |
| 11 | `migrator@builtin` | act | strongest | `mutate`+`dependency.write` | `rollback_plan` is a **precondition**; human approval on lockfile |
| 12 | `doc-writer@builtin` | act | cheapest | `mutate` ∩ docs globs | `{files_written[], claims_verified[], unverified_claims[]}` |
| 13 | `verifier@builtin` | verify | cheapest | `verify`+declared `verify_cmd` only | `{verdict, command, exit_code, stdout_digest, duration_ms}` (one per plan step) |
| 14 | `deployer@builtin` | act | mid | `observe`+`execute`+`deploy.invoke` | requires `verifier_verdict = pass`; emits `live_matches_expected` + `rollback_command` |
| 15 | `relay@builtin` | relay | cheapest | exactly one tool at spawn time | passthrough of the tool's own output schema |

**Do not bundle** (the anti-lesson): per-language and per-framework experts (skills on `worker`); per-bundle reviewers (one `reviewer` + dimension partition); business/SEO agents (skills and commands); a context-manager agent (context composition is the runtime's job); a relay per vendor (one parameterized relay). The canonical fleet composition — `lead → scouts → architect → reviewers`, then `fleet(worker → tester/doc-writer/verifier)` with `depends_on`/`fail_fast`/`adopt_ref`, `debugger` only with a failure artifact, `security-auditor` required before publish, `deployer` requiring a passing verifier verdict — is recorded in full in the deep-dive report and lands in doc 15 §3.6 with the schema deltas (`resultSchema`, `requiresInputs`, `refusesWhen`, `partitionBy`, `ownsPaths`, presets, `policyNarrowing`, relay/passthrough).

### 9.2 The first three fleets to ship (V4)

1. **`review` fleet** (read-only reviewers per dimension: security / performance / architecture) — exercises read-only grants, verdict formats, and the merge step with zero mutation risk.
2. **`refactor` fleet** (explorer → implementer per partition → verifier) — exercises `depends_on`, adopt refs, and per-child budgets; use it on our own codebase first (dogfood).
3. **`pipeline` fleet** (the ship-mate pattern worth stealing: orchestrate → architect → implement → verify → review, with the verify step running the repro script and the review step owning verdicts) — becomes a **bundled workflow** shipped to users, because its value is the enforced order, not the prompts.

### 9.3 Dogfooding rule

**R-impl-20.** From V4 onward, every feature larger than a one-file change is built **through HorizonCode fleets run from the previous release** (or the dev build when the previous release can't do it — which is itself a finding). Each dogfood run captures a trajectory; failures become eval cases. We do not claim our own subagent system works until it has built our own features.

---

## 10. Security and authority of the build process itself

**R-impl-21.** CI credentials are scoped per-job; release signing keys never enter PR-triggered jobs; dependency installs are lockfile-only (`--frozen-lockfile` / `--locked`) with digest pinning; the nightly matrix is the only job with network egress beyond registries.

**R-impl-22.** The **learning loop is authority-neutral by construction** (doc 24 Section B rule): proposals may change prompts, skills, evals and docs — they can never change capability IDs, postures, policy statements, grants or guarded paths. The V7 demo asserts an *empty authority diff*; a non-empty diff fails the demo.

**R-impl-23.** `.hz/` supplies content, never authority: no trust records, grants, install state or policy under a repository path (doc 15 §7.7; doc 11 merge lattice). The bootstrap commit that adds `.hz/` ships with a test asserting a repo-authored grant file is **rejected** (not honoured).

**R-impl-24.** Every gate script is itself versioned, reviewed, and exercised by a mutation test (a deliberately-introduced violation must fail it — otherwise the gate is decorative). This is the gate-testing gate (doc 16 §9).

---

## 11. Tests and gates — how the plan is verified

| Level | What | When |
|---|---|---|
| Slice demos | `scripts/demo/vN.sh` on a clean container | every PR touching the slice |
| Unit / contract / property tests | per package/crate | every PR |
| Gate suite (fast) | correctness of gates themselves + fast subset of §3.2 | every PR |
| Nightly matrix | sandbox guarantee tests (3 OS), benches, adversarial suite, long-horizon sim, tier-parity evals, kernel ABI compat | nightly |
| Dogfood runs | feature built by fleets; trajectory archived | per feature (M4+) |
| Release gates | signed artifacts, SBOM, provenance, migration notes | per release |

The plan itself was verified by the five-audit pass recorded in `AUDIT.md` and by the learning passes recorded in `docs/26-learning-synthesis-2.md`; §12 open questions are the debt this plan knowingly carries.

---

## 12. Open questions and proposed ADRs (owner: product/spec owner; date: before the slice they block)

`docs/25-roadmap-and-glossary.md` §8.1 owns a separate register of inherited questions under its own id family; the questions below are plan-created (`OQ-P1`…`OQ-P7`) and do not collide with it.

| # | Question | Blocks | Proposed default |
|---|---|---|---|
| OQ-P1 | Code Mode v2 engine: allowlisted interpreter (opencode-style) vs V8 with JIT disabled (codex-style) — or both behind the guarantee vector | V4 | **Both allowed; interpreter is the default**, V8 opt-in where interactive REPL semantics are needed (ADR-017 proposed) |
| OQ-P2 | Preview environments: which runtime class (containers vs process-sandbox) and lifecycle (per-session vs per-preview) | V4 | process-sandbox first (ADR-018 proposed) |
| OQ-P3 | Debug recorder: `rr` (Linux) + WinDbg TTD (Windows) + macOS fallback (core dump + deterministic logs) — do we ship per-platform or require a devcontainer on Linux? | V4 | ship rr-first on Linux; others recorded as unavailable with a typed residual (ADR-019 proposed) |
| OQ-P4 | Governance blueprint config format: governed state machine declared in AGENTS.md vs a separate `.hz/workflows` file | V4 | AGENTS.md gains a `## Workflow` block parsed into the plan FSM (ADR-020 proposed) |
| OQ-P5 | Tier-parity target: which parity threshold per task class counts as “same level” | V2 | define with first paired run; start with outcome parity on the seed suite (ADR-021 proposed) |
| OQ-P6 | Speculative decoding: provider-side config only, or also our local server integration | V4 | provider-side config + documented llama.cpp/vLLM recipes (ADR-022 proposed) |
| OQ-P7 | Should `hzcode` own a container runtime abstraction for preview/sandbox (podman vs docker vs built-in OCI) | V4/V5 | defer; process sandbox first, container adapters as plugins |

---

## 13. Status

> Implementation levels are owned by `docs/28-implementation-status.md` (RC-13); this plan claims no level itself. §6.2's toolchain viability and §6.3's clone availability are the only items this document evidences, and both are recorded there.
>
> Reconciled 2026-11-07 (reaudit stage 2, RC-15).

| Capability | Status | Evidence |
|---|---|---|
| Runtime viability of the toolchain (Bun + Rust) on the build machine | **VERIFIED** | install log + smoke tests (§6.2) |
| Source availability of all fifteen reference repositories | **VERIFIED** | clones present under `/data/home/forge/repo-tour/` |
| Learning corpus (deep-dive reports) for this pass | **VERIFIED** | `docs/audit/pass2/deep-*-report.md` (5 reports, ~1.5k lines total; the reports were preserved in-repo after they had lived only in `/tmp`) |

### Related documents

- `docs/26-learning-synthesis-2.md` — the learning this plan is built from, with the doc-update ledger
- `docs/25-roadmap-and-glossary.md` — M0–M8 (this document's V-ladder maps onto it)
- `docs/16-operations.md` — the gate catalogue and budgets registry this plan activates incrementally
- `docs/11-authority-safety.md`, `docs/12-sessions-state.md`, `docs/09-tools.md` — the specs the first four slices implement
