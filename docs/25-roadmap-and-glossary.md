# 25 — Roadmap and Glossary

> **Status of every phase in this document: `DESIGNED` as a plan.** **Implementation status (final audit, 2026-11-06):** code now exists for slices of M0/M1/M2 territory (kernel, runtime loop, tools, chat TUI, skills/subagents, code mode, preview) without the phase protocols below having been run — levels and evidence live in `28-implementation-status.md`, the single source of truth; phase *exit criteria* in §3 are unmet and unchanged.

---

## 1. Purpose

This document decides four things and nothing else.

1. **The delivery order.** Phases `M0`–`M8`: `M0` Foundation · `M1` Loop · `M2` Authority · `M3` Surfaces · `M4` Intelligence · `M5` Scale · `M6` Ecosystem · `M7` Enterprise · `M8` Self-improvement. Each phase states its goal, its deliverables, its exit criteria (a checklist of CI gates that must be green), its risks, and what is explicitly **not** in it.
2. **The registries.** The document-ownership map for documents `03`–`23`, the new-feature index (`NF-001` … `NF-062`, defined in `/data/home/forge/hzcode/docs/24-feature-catalog.md` Section B; `NF-051`–`NF-062` indexed in §4.2a) and the ADR index.
3. **The vocabulary.** An alphabetical glossary: one meaning per term used across the spec set, each entry naming the document that owns the definition.
4. **The evidence rule.** What each status level requires, so that no document — including this one — can claim a level it has not earned.

The roadmap is a *plan*, not a promise. A phase that cannot satisfy a gate reports that gate as `UNKNOWN` and does not advance. Per `/data/home/forge/hzcode/docs/_conventions.md` §8, a document MUST NOT claim a level above what its evidence supports.

**Not in scope of this document:** the content of the phases (owned by the subsystem documents), the feature designs themselves (owned by `/data/home/forge/hzcode/docs/24-feature-catalog.md` §5), and any implementation. This document owns ordering, gates, the evidence ladder and the words.

**Phase-id reconciliation.** Earlier drafts of this set used `P0`–`P7` for the same plan and the current `/data/home/forge/hzcode/docs/00-index.md` still describes this document as a "`P0`–`P7` roadmap". The plan of record is `M0`–`M8`; the mapping and the stale index line are recorded in §8 (OQ-R4). Sibling documents that cite a `P<n>` phase identifier resolve through that mapping table.

---

## 2. The delivery model

### 2.1 The status ladder (restated from `/data/home/forge/hzcode/docs/_conventions.md` §8)

`DESIGNED` → `CODE_PRESENT` → `WIRED` → `TESTED` → `VERIFIED` → `RELEASED`

**R25.1.** No capability advances a level without *named evidence*. A level without evidence is a document bug, and `gate:doc-status` is the CI mechanism that fails on it. There is no "almost TESTED", no "effectively VERIFIED", and no implicit promotion because a neighbouring capability advanced.

**R25.2.** A *lowering* is always permitted and requires no ceremony. A *raising* requires the evidence and the recorded artifact. Unknown states are written `UNKNOWN`.

### 2.2 What counts as evidence at each level

| Level | Evidence required — named, at a path or an id | Must not be claimed because… |
|---|---|---|
| `DESIGNED` | A document section that specifies it, and the numbered rules that make it testable. | — (this is the floor) |
| `CODE_PRESENT` | A file path in the repository that contains the implementation, plus the owning package/crate. | "The design implies it" |
| `WIRED` | A call path from a real entry point (Controller, kernel ABI, tool registration, surface) to the implementation, plus the event or receipt it emits. | A unit exists but nothing calls it — a *dead lane* (`gate:dead-lane-fail-closed`) |
| `TESTED` | Green tests nameable by file and test name, run in CI, covering the rule that specifies the behaviour. | Test files that exist but are skipped or excluded |
| `VERIFIED` | A recorded evidence artifact: a receipt-chain walk (`hzcode session verify <id>`), an evidence bundle referenced by digest in Trusted Host State (NF-017), a sandbox guarantee assessment (NF-016), a gate run whose id and result are recorded. | Self-reported success, model summaries, prose claims |
| `RELEASED` | A tagged, signed release artifact; the capability reachable from every front-end that declares its edge (`gate:frontend-parity`, `gate:parity-ratchet`); NOTICE/provenance complete (`gate:provenance`). | A merged branch |

### 2.3 The evidence gate applies to this roadmap too

Each phase exits through a **set of gates**, not a review meeting. A gate is *met* only where its output is recorded; otherwise it is written `UNKNOWN` and the phase does not advance. This is the same fail-closed posture the kernel uses for effects (`/data/home/forge/hzcode/docs/11-authority-safety.md`), applied to delivery.

### 2.4 Owner roles

Risk registers below name a *role*, not a person, because this set is a specification with no assigned staff.

| Role | Owns |
|---|---|
| `spec-owner` | Documents `01`–`25`; schema/status discipline; `gate:doc-status` |
| `kernel-owner` | `crates/hz_kernel`, `hz_abi`, `hz_sandbox`, `hz_policy`; Guard, policy, leases, receipts, reconciliation, sandbox matrix |
| `runtime-owner` | `@horizoncode/core`, `@horizoncode/tools`, `@horizoncode/agents`; step engine, event log, projections, tools, fleets |
| `cognition-owner` | `@horizoncode/provider`, `@horizoncode/context`; providers, context compiler, cache contract, memory, compaction |
| `surface-owner` | `@horizoncode/tui`, `cli`, `server`, `web`, `desktop`, `acp`, `mcp`, `sdk*` |
| `learn-owner` | `@horizoncode/learn`; trajectories, evals, proposals — authority impact always `none` (ADR-010) |
| `release-owner` | Packaging, signing, gates, provenance register, `gate:kernel-pin` |

---

## 3. Phases `M0`–`M8`

### 3.0 Phase summary

| Phase | One-line goal | Entry state | Exit artifact (demo) |
|---|---|---|---|
| M0 · Foundation | Freeze the spec surface and generate the wire types | — | `hz_abi` + `@horizoncode/protocol` + SDKs generated from one source; gate registry live |
| M1 · Loop | A single agent a developer can use, on one machine | Generated types | Live TUI session (fullscreen and inline) reading, editing and running under a default posture |
| M2 · Authority | The kernel can refuse before it can act; then authority is complete | Core loop | Refused effect, leased effect, matched receipt pair, reconciled `UNKNOWN`, three sandbox backends |
| M3 · Surfaces | Every surface is a client of the same Controller | Authority complete | One session driven from TUI, server, IDE and an SDK with identical events and exit codes |
| M4 · Intelligence | Models, context and memory under the cache contract | Surfaces | Cache-guard green across the matrix; a compacted session that preserves its receipts |
| M5 · Scale | Many agents under one budget, one plan, no second authority path | Cognition | A receipted fleet with an inherited budget and a reconstructed session tree |
| M6 · Ecosystem | Extensions and integrations that declare before they act | Scale | A signed plugin running confined, a verified skill, an IDE/agent round trip |
| M7 · Enterprise | Deployable and auditable in an organisation | Ecosystem | Signed managed policy narrowing a user config; an air-gapped run; a remote host returning its guarantee vector |
| M8 · Self-improvement | Learning that never widens authority; long-horizon unattended work | All surfaces | An unattended run certified by receipts and an adversarial test pass |

**Rule R25.3.** A phase may not start work owned by a later phase. Work discovered to belong to an earlier phase is a *regression* and is fixed there (see §6.3).

### 3.1 M0 · Foundation

**Goal.** One source of truth for every wire and durable type, generated into both planes before either plane implements anything; and a repository whose structure is enforced from the first commit.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M0-D1 | Freeze of documents `01`–`16`, `24`, `25` with per-capability status lines | `/data/home/forge/hzcode/docs/_conventions.md` §8, §9 |
| M0-D2 | Schema catalogue `*V1` (`GuardDecisionV1`, `EffectReceiptV1`, `SessionPostureV1`, `AgentProfileV1`, `ToolDeclarationV1`, `StepRecordV1`, …) | `/data/home/forge/hzcode/docs/05-domain-and-schemas.md` |
| M0-D3 | `hz_codegen` generating `@horizoncode/protocol`, `crates/hz_abi` and the thin SDKs from those schemas; no schema edited twice | `/data/home/forge/hzcode/docs/04-lld.md`, `/data/home/forge/hzcode/docs/07-apis-and-contracts.md` |
| M0-D4 | Protocol revision constants `HZ_ABI=1`, `HZ_PROTO=1` | `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| M0-D5 | Capability-ID registry (§5) and event-name catalogue (§6) frozen; every proposal in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.3/§3.4 either registered here or withdrawn | `/data/home/forge/hzcode/docs/_conventions.md` §5, §6 |
| M0-D6 | CI gates registered by name and each backed by a job id, even where the job only asserts "not yet applicable" | `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| M0-D7 | Layering ranks declared for packages and crates before the first import; ratchet baseline created and set to may-only-decrease | `/data/home/forge/hzcode/docs/_conventions.md` §3, §4; NF-047, NF-048 |
| M0-D8 | Repository skeleton: Bun workspaces + Cargo workspace, reproducible build scripts, the `hz_native` build matrix, kernel asset manifest (pin), NOTICE generation from the provenance register | `/data/home/forge/hzcode/docs/04-lld.md`; NF-046, NF-048 |
| M0-D9 | `hz://` scheme registered with its path kinds and a typed (failing) resolver stub | `/data/home/forge/hzcode/docs/_conventions.md` §1; NF-011 |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:wire-parity` — every protocol type has exactly one generated owner.
- `gate:doc-status` — no document claims a level above its evidence; every `NF-###` in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §5 is indexed in §4.2 of this document.
- `gate:layering` — the dependency ranks are declared and the check runs (it may pass vacuously at M0).
- `gate:repolint-debt` — the ratchet baseline exists and may only decrease.
- `gate:kernel-pin` — a manifest exists and pins the (not yet built) kernel asset format.
- `gate:cross-plane-abi` — the TS side fails closed on a missing or unknown native ABI; at M0 the check validates the fail-closed stub.
- `gate:provenance` — the register exists, is machine-readable, and NOTICE is generated from it.

**Demonstrable artifact at exit.** A single generator run produces `@horizoncode/protocol`, `crates/hz_abi` and the SDKs from the schemas; a deliberately mismatched hand edit fails `gate:wire-parity`; a deliberately raised debt count fails `gate:repolint-debt`.

**Not in this phase.** No runtime behaviour, no kernel process, no provider calls, no TUI, no user-visible feature. M0 ships no feature; a demo that needs a running agent belongs to M1.

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Schema churn during M1 forces regenerated types mid-phase | high | medium | Freeze `*V1` at M0; new needs get `*V2`, never in-place edits (`/data/home/forge/hzcode/docs/_conventions.md` §7) | `spec-owner` |
| Codegen drift between TS and Rust | medium | high | `gate:wire-parity` + generated-only directories | `spec-owner` |
| Gate definitions exist only as prose | medium | medium | Every gate named in §3 gets a CI job id at M0 | `release-owner` |
| The capability/event proposals in `24-feature-catalog.md` §3.3/§3.4 are neither registered nor withdrawn | medium | medium | M0-D5 makes the decision part of the freeze | `spec-owner` |
| Native build matrix breaks on one platform before any feature exists | medium | medium | `gate:cross-plane-abi` fails closed from the start; no silent JS fallback | `runtime-owner` |

### 3.2 M1 · Loop

**Goal.** A session a developer can actually use: step engine, durable event log with projections, admission and claims, the baseline tool set, the native capability stack (first slice) and the TUI in both render modes.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M1-D1 | `Controller`, session engine and step engine; one provider stream per step (ADR-011) | `/data/home/forge/hzcode/docs/03-hld.md`, `/data/home/forge/hzcode/docs/08-runtime.md` |
| M1-D2 | Durable event log + projectors in one transaction, per-aggregate monotonic sequence (ADR-004) | `/data/home/forge/hzcode/docs/12-sessions-state.md`, `/data/home/forge/hzcode/docs/06-events-and-flows.md` |
| M1-D3 | Admission before execution: durable inbox, `steer` vs `queue`; admission receipt | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M1-D4 | Write-ahead execution claim, released only by a terminal state | `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M1-D5 | Tools baseline: `read`, `edit`, `write`, `patch`, `bash`/`shell`, `grep`, `glob` (+ `todo` unless deferred with M5) | `/data/home/forge/hzcode/docs/09-tools.md` |
| M1-D6 | Unified native capability stack, first slice: one N-API addon over `hz_shell`, `hz_edit`, `hz_diff`, `hz_walker` (NF-015 partial) | `/data/home/forge/hzcode/docs/04-lld.md`, `/data/home/forge/hzcode/docs/09-tools.md` |
| M1-D7 | TUI: fullscreen renderer + scrollback-native inline mode, switchable by relaunch; terminal restore on panic and signal | `/data/home/forge/hzcode/docs/13-tui.md`; NF-029 (first half) |
| M1-D8 | `hz://` resolution for sessions, parts, steps, receipts, artifacts (NF-011 partially live) | `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| M1-D9 | Rollout recording (reduced-state trace) and read-mode replay: `hzcode session verify <id>` walks the receipt chain | `/data/home/forge/hzcode/docs/12-sessions-state.md`; NF-026, NF-009 (read mode) |
| M1-D10 | Hermetic record/replay harness in front of the provider transport (NF-039), so M1's tests do not depend on a live model | `/data/home/forge/hzcode/docs/18-testing-and-gates.md` [planned]; NF-039 |
| M1-D11 | Artifact store slice: content-addressed writes for tool outputs and evidence attachments (NF-027 partial) | `/data/home/forge/hzcode/docs/05-domain-and-schemas.md`; NF-027 |
| M1-D12 | Work item carried from the ancestor: two edits to the same file in one message must not be refused with `stale_preimage` (`source: /data/home/forge/repo-tour/horizoncode/HANDOFF.md`, recorded in `/data/home/forge/hzcode/docs/24-feature-catalog.md` A.8) | `/data/home/forge/hzcode/docs/09-tools.md` |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:cache-guard` — the compiled prefix is byte-stable for the declared `(provider, model, config)` tuples (the guard must exist *before* providers multiply in M4).
- `gate:tool-declaration` — every shipped tool carries a full declaration: schema, effect class, capability ID, renderers, idempotency (ADR-015).
- `gate:parity-ratchet` — every capability edge reachable in the TUI has a Section A row.
- `gate:frontend-parity` — TUI fullscreen and inline are two render paths of one surface and may not diverge in reachability.
- `gate:boundary-test` — event append and message-part creation each have exactly one caller; subagent construction (not yet used) is guarded from day one.
- `gate:no-unknown-retry` — no code path retries an `UNKNOWN`.
- `gate:receipt-coverage` — every mutating operation in M1 scope declares its observation path (ADR-012).
- `gate:dead-lane-fail-closed` — a disabled lane reports refusal, never success.

**Demonstrable artifact at exit.** An interactive TUI session on a fresh workspace: the agent reads a file, edits it through the conflict-aware edit engine (including the M1-D12 case), runs a command under a default posture, and the session replays step by step in `hzcode session verify` with matched receipts. The same session is re-run with `--minimal` to prove the inline renderer.

**Not in this phase.** Approvals richer than a yes/no prompt; postures beyond a default; wildcard rules from the UI; the Starlark engine; macOS and Windows sandbox backends; memory tiers; retrieval; compaction; subagents; budgets; plan mode; any surface other than TUI and `print`/headless.

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| The log/state split drifts into two sources of truth | medium | high | Projections are derived and disposable; the log is the state of record (ADR-004) | `runtime-owner` |
| Tool count grows faster than tool declarations | high | medium | `gate:tool-declaration` blocks the merge, not the review | `runtime-owner` |
| TUI scope creep (a full application surface) delays the loop | high | medium | Inline mode is the fallback demo; components land per `/data/home/forge/hzcode/docs/13-tui.md` | `surface-owner` |
| Native addon build or ABI breaks on one platform | medium | high | `gate:cross-plane-abi`; TS fails closed with a typed error | `runtime-owner` |
| Prompt prefix volatility introduced by tool schemas | medium | high | `gate:cache-guard` from M1, before providers multiply | `cognition-owner` |
| Claim/inbox semantics re-litigated in code | medium | medium | `/data/home/forge/hzcode/docs/12-sessions-state.md` owns the semantics; changes go through that document first | `runtime-owner` |
| Record/replay harness drifts from the real transport | medium | medium | NF-039 keys cassettes on the request digest and is extended by the same codec tests as the transport | `runtime-owner` |

### 3.3 M2 · Authority

**Goal.** A kernel that can *refuse* before it can *act*, and then an authority plane that is complete: composed policy, one-use leases, receipts, reconciliation, approvals, postures, the sandbox matrix with typed residuals, egress control, grants and the wired evidence gate.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M2-D1 | `crates/hz_kernel` skeleton: `guard.rs`, `effect_host.rs`, `supervisor_lease.rs`, `owner_log.rs` (NF-001, NF-049 partial) | `/data/home/forge/hzcode/docs/11-authority-safety.md`; `/data/home/forge/hzcode/docs/04-lld.md` |
| M2-D2 | Effect host for `files.read/write/patch/delete/move` and `terminal.run`, then `terminal.pty`, `process.spawn`, `vcs.write` | `/data/home/forge/hzcode/docs/11-authority-safety.md`; capability registry `/data/home/forge/hzcode/docs/_conventions.md` §5 |
| M2-D3 | One-use lease protocol + `EffectReceiptV1` issuance; events `hz.effect.decision.made`, `hz.effect.lease.issued`, `hz.effect.settled`; terminal-state enum per RC-7 | `/data/home/forge/hzcode/docs/06-events-and-flows.md`; `/data/home/forge/hzcode/docs/_conventions.md` §11 |
| M2-D4 | `crates/hz_policy` wildcard rule compiler (first), then the Starlark prefix engine; `deny > ask > allow`; policy revision + digest in the posture (NF-003 complete) | `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D5 | `@horizoncode/kernel-client` typed client; the kernel protocol fails closed on ABI mismatch (ADR-002) | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md` |
| M2-D6 | Linux sandbox backend (bubblewrap + Landlock), `Sandbox::probe()` fail-closed, guarantee vectors with typed residuals; then macOS (Seatbelt) and Windows (write-restricted token/AppContainer) backends (NF-016 complete) | `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D7 | Approvals: `ask` decisions surfaced in the TUI, answered once, recorded; postures as data (`DirectSessionPermissionModeProjectionV1`); `hz.policy.revision.changed` | `/data/home/forge/hzcode/docs/13-tui.md`, `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D8 | Receipt inspector, receipt-chain walk and **dry-run replay** (re-evaluate policy against recorded intents without executing) | `/data/home/forge/hzcode/docs/12-sessions-state.md`, `/data/home/forge/hzcode/docs/13-tui.md`; NF-009 complete |
| M2-D9 | `UNKNOWN` reconciliation: `hz.effect.unknown` → `hz.effect.reconciled`, with a declared observation path per effect class; the `UNKNOWN` UX (NF-036) | `/data/home/forge/hzcode/docs/11-authority-safety.md`, `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M2-D10 | Egress control: one policy point for `net.fetch`/`net.search`, exact-origin allow-lists, local model-transport proxy, SSRF guard (NF-021) | `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D11 | Capability-granted delegation: `DirectSessionGrant`, bounded, workspace-scoped, expiring, origin-typed (NF-014) | `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D12 | Evidence gate wiring: `verify` compiles claims into obligations and can only lower them (NF-002); Trusted Host State chain with the two honesty levels (NF-017) | `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M2-D13 | `hzcode doctor` trust display: postures, grants, guarantee vectors, dead-lane health | `/data/home/forge/hzcode/docs/16-operations.md`; NF-049 partial |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:receipt-coverage` — every mutating operation at parity across all three platforms, not only Linux.
- `gate:no-unknown-retry` — the reconciliation path exists, and no retry path is added alongside it (RC-7, ADR-012).
- `gate:dead-lane-fail-closed` — a disabled lane reports refusal/`UNKNOWN`; a test asserts the refusal.
- `gate:sensitive-path-coverage` — every path declared `sensitive:` is covered by a test that proves it.
- `gate:boundary-test` — effect submission has exactly one primitive with exactly one caller per effect class.
- `gate:cross-plane-abi` — kernel-client fails closed on a missing or older ABI.
- `gate:doc-status` — `/data/home/forge/hzcode/docs/11-authority-safety.md` and `/data/home/forge/hzcode/docs/12-sessions-state.md` statuses match their evidence.
- `gate:parity-ratchet` — no disposition regression while the policy engine is replaced (wildcards → Starlark).

**Demonstrable artifact at exit.** Recorded runs on Linux, macOS and Windows where the same intent produces: a policy decision, an approval prompt, a one-use lease, a receipt, and — for a deliberately killed effect — an `UNKNOWN` that is later reconciled with the observation that decided it. The TUI receipt inspector shows the chain; a guarantee assessment reports a typed residual rather than assuming enforcement.

**Not in this phase.** Remote execution (M7); the secret vault (M4); memory, retrieval and compaction (M4); subagents and budgets (M5); the managed domain (M8). No classifier-based routing or safety judging is introduced at any point (ADR-007, `24-feature-catalog.md` D-8).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Effect host grows a second submission path under delivery pressure | medium | high | One primitive + `gate:boundary-test` from the first day | `kernel-owner` |
| Linux enforcement is weaker than assumed (kernel/user-namespace availability varies) | high | high | `Sandbox::probe()` fails closed; residuals are typed, never silently tolerated | `kernel-owner` |
| Windows confinement materiality weaker; users read the guarantee vector as "sandboxed" | high | high | Guarantee vectors are surfaced; the UI never prints "sandboxed" without the vector | `kernel-owner` |
| Policy engine rewrite changes decisions silently | medium | high | Dry-run replay (M2-D8) over recorded intents shows which decisions would differ | `kernel-owner` |
| Wildcard subset and Starlark engine diverge | medium | medium | The wildcard subset is written as a strict prefix of NF-003 semantics; the compiler is the only path | `kernel-owner` |
| Approval fatigue leads to blanket grants | high | high | Grants are bounded and workspace-scoped (NF-014); receipts record the grant used | `surface-owner` |
| `UNKNOWN` is treated as a synonym for failure in UI copy | medium | high | Terminal-state vocabulary is one enum (RC-7); copy is a rendering of the enum, never a new word | `spec-owner` |
| Evidence gate is wired to a subset of surfaces | medium | high | `gate:parity-ratchet` plus the rule that the gate can only *lower* a claim | `kernel-owner` |

### 3.4 M3 · Surfaces

**Goal.** The same `Controller` behind every declared surface, with a parity ratchet that makes a missing surface a build failure.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M3-D1 | `@horizoncode/server`: JSON-RPC over stdio/UDS/TCP plus HTTP/SSE/WS; no behaviour of its own (NF-006) | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md`, `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D2 | Web app (`@horizoncode/web`) as a client of the same Controller | `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D3 | Desktop app (`@horizoncode/desktop`), a separate module against the published protocol (NF-046 partial) | `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D4 | ACP in both directions: HorizonCode as an ACP agent *and* as a driver of external agents; IDE bridge with JWT channel, permission proxying and trusted-device rules (NF-037) | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md`, `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D5 | MCP server mode (expose the agent) alongside MCP client mode (ADR-006) | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md`, `/data/home/forge/hzcode/docs/15-extensibility.md` |
| M3-D6 | Generated SDKs: TS client plus Python/Go/Rust thin clients from one source | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md`, `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D7 | Canonical exit-code table enforced across surfaces (RC-5; owned by `/data/home/forge/hzcode/docs/14-surfaces.md` §2.2 (S16)) | `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M3-D8 | Bridge replay: session-lifecycle state cached client-side and replayed after a reconnect, bounded to lifecycle frames | `/data/home/forge/hzcode/docs/14-surfaces.md`; NF-037 |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:frontend-parity` — a capability edge that reaches one surface and not another fails the build.
- `gate:parity-ratchet` — no Section A disposition regresses; every capability edge on a declared surface has a row.
- `gate:layering` — no front-end imports a non-contract package.
- `gate:wire-parity` — the SDKs are generated, never hand-edited.
- `gate:doc-status` — `/data/home/forge/hzcode/docs/14-surfaces.md` status lines match evidence.
- `gate:receipt-coverage` — a session started in one surface and continued in another yields one continuous receipt chain.

**Demonstrable artifact at exit.** One session started in the TUI, attached to from the server, mirrored into an IDE through ACP, and read through the generated TS SDK — with the same events, the same receipts and the same exit codes.

**Not in this phase.** A surface that owns behaviour; mobile as an on-device kernel (rejected, `24-feature-catalog.md` D-6); a vendor-hosted task queue (rejected, D-4); remote execution (M7); collaboration with presence (M6); the managed domain (M8).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| A surface grows a private code path "just for this UI" | high | high | `gate:frontend-parity` + `gate:layering`; surfaces may only render and collect input | `surface-owner` |
| Generated SDKs drift from the protocol | medium | medium | Codegen-only directories; `gate:wire-parity` | `spec-owner` |
| The parity ratchet becomes noise and gets muted | medium | high | Baseline may only decrease (`gate:repolint-debt`); muting is itself a gate failure | `release-owner` |
| Bridge replay rewrites a session that changed during the gap | medium | high | Replay is bounded to lifecycle frames; a materially changed session is reported, never silently rewritten | `surface-owner` |
| A second surface implementation appears as "a thin shim" | medium | high | `gate:layering` (no front-end imports a non-contract package) plus `gate:frontend-parity` | `surface-owner` |

### 3.5 M4 · Intelligence

**Goal.** Models, context and memory: a provider matrix, a byte-stable cache-checked prefix, four memory tiers, retrieval, compaction that preserves the receipts, and the operational plumbing (vault, account pools, pricing, observability) that makes cost and secrecy visible.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M4-D1 | Provider layer, native wire codecs, `models.dev`-style catalog snapshot decoder; endpoints as configuration, not code (NF-044) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D2 | Context compiler: exactly two regions — byte-stable prefix and projected turn tail (NF-005) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D3 | Cache guard + golden prefix pins per prompt family (`packages/context/test/golden/prefix/<family>.sha256`, RC-8) | `/data/home/forge/hzcode/docs/_conventions.md` §11 (RC-8); `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D4 | Four-tier memory with provenance; tools `memory_retain`, `memory_recall`, `memory_edit`, `memory_reflect` (NF-008) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D5 | Retrieval: lexical + symbol + reference index, local-first (NF-042 partial) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D6 | Compaction preserving goal, plan, todos, open questions, the receipt *set*, unresolved `UNKNOWN`s, pending asks, active skill and remaining budgets | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D7 | Secret vault with redaction on the outbound path (NF-022) | `/data/home/forge/hzcode/docs/16-operations.md`, `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M4-D8 | Account pools with credential affinity and prompt-cache pinning (NF-024) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M4-D9 | Append-only price table + `pricecheck`; every usage record cites its rate revision (NF-050) | `/data/home/forge/hzcode/docs/16-operations.md` |
| M4-D10 | Observability plumbing: OTel with GenAI conventions, local dashboard, redacted export (NF-041 partial) | `/data/home/forge/hzcode/docs/16-operations.md` |
| M4-D11 | Record/replay harness completes the matrix (NF-039): cassettes keyed by request digest, deterministic clock/randomness/ids, used by the cache guard and later by evals | `/data/home/forge/hzcode/docs/18-testing-and-gates.md` [planned] |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:cache-guard` — green across the supported `(provider, model, config)` matrix; a deliberate prefix perturbation fails the gate with a byte diff.
- `gate:frontend-parity` — compaction and memory recall produce the same events regardless of surface.
- `gate:doc-status` — the cognition document's status lines match recorded evidence.
- `gate:sensitive-path-coverage` — credential paths are covered by proving tests.
- `gate:parity-ratchet` — provider capability edges do not regress any surface.
- `gate:no-unknown-retry` — re-checked on the retrieval and compaction paths (a retrieval miss is not an error, and never a retry of an effect).

**Demonstrable artifact at exit.** One long session that crosses the context limit: the prefix digest is unchanged across compaction, the post-compaction request still contains the receipt set, an unresolved `UNKNOWN`, the pending ask and the active skill; a `memory_recall` returns an item with provenance; two providers run the same task and both keep `gate:cache-guard` green.

**Not in this phase.** Prompt tuning as a deliverable (M8); embedding-based semantic search as an M4 claim — the local index is lexical + symbol + reference (NF-042 is explicitly partial here); account-pool fairness policy; the classifier idea in any form (ADR-007).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Provider paging/caching differences break the byte-stable prefix | high | high | Pins per `(provider, model, config)`; drift is a build failure, not a note | `cognition-owner` |
| Compaction silently drops authority context (`UNKNOWN`, pending asks) | medium | high | Preservation assertions per `/data/home/forge/hzcode/docs/10-cognition.md` | `cognition-owner` |
| Memory grows without a retention floor | high | medium | Retention floor carried in the tail; memory writes are events with provenance | `cognition-owner` |
| Vault/redaction leaks credentials into prompts, logs or telemetry | low | high | Redaction is the default on provider and observe paths; `gate:sensitive-path-coverage` | `release-owner` |
| Model catalog drift makes cost accounting wrong | medium | medium | The price table is append-only and cited by revision (NF-050) | `release-owner` |
| A retrieval index silently becomes authoritative | medium | medium | Retrieval feeds the tail only; receipts decide claims (NF-002) | `cognition-owner` |

### 3.6 M5 · Scale

**Goal.** More than one agent at a time, under one budget, with one plan, and no second authority path.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M5-D1 | Subagent construction funnel: capability narrowing, budget inheritance, depth/concurrency ceilings, context capsule, receipt linkage (NF-007) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M5-D2 | Tools `task`, `read_only_task`, `fleet` (`id`/`depends_on`, upstream results, `adopt_ref`, `fail_fast`), `parallel_tasks` | `/data/home/forge/hzcode/docs/09-tools.md` |
| M5-D3 | Teams and message bus; events `hz.agent.spawned`, `hz.agent.message.sent`, `hz.agent.completed` | `/data/home/forge/hzcode/docs/06-events-and-flows.md`, `/data/home/forge/hzcode/docs/08-runtime.md` |
| M5-D4 | Budgets inherited across the session tree: tokens, wall-clock, steps, triage, search calls, currency; enforced at admission boundaries (NF-025) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/16-operations.md` |
| M5-D5 | Scheduler with an occurrence journal that survives restarts (NF-012, NF-028 partial) | `/data/home/forge/hzcode/docs/08-runtime.md` |
| M5-D6 | Plan, Goal and Todo state machines with an approved-plan window; tools `todo`, `update_goal` (NF-045) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/09-tools.md` |
| M5-D7 | Goals, attempts and the run/attempt model; `hzcode session tree` reconstructs authority and cost | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M5-D8 | Deterministic planner/executor routing: `executor-only` / `light` / `full` / `plan-for-approval` / `plan-only` chosen from raw user text by policy (NF-004) | `/data/home/forge/hzcode/docs/08-runtime.md` |
| M5-D9 | Worktree pool primitives for child isolation (NF-019, partial — see risk register) | `/data/home/forge/hzcode/docs/12-sessions-state.md`, `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M5-D10 | Rhai workflow engine bindings; tool `workflow` (NF-012) | `/data/home/forge/hzcode/docs/15-extensibility.md` |
| M5-D11 | Notification and watchdog system: stalls, budget thresholds, held leases, unreconciled `UNKNOWN`s (NF-028) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/16-operations.md` |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:boundary-test` — the subagent-construction primitive has exactly one caller, proven by test.
- `gate:receipt-coverage` — every child effect links to the parent receipt chain.
- `gate:frontend-parity` — the child tree renders identically in fullscreen and inline.
- `gate:cache-guard` — child capsules and prewalk-style downgrades do not perturb prefixes.
- `gate:no-unknown-retry` — a child that ends `UNKNOWN` is not restarted automatically by the parent.
- `gate:parity-ratchet` — orchestration edges are present on every declared surface.
- `gate:doc-status` — the runtime document's status lines match evidence.

**Demonstrable artifact at exit.** A fleet of three children with a declared `depends_on` graph runs under one inherited budget; one child exhausts its share and stops with a typed refusal while the tree continues per policy; `hzcode session tree` prints the authority and cost of every node, and every child effect resolves to its parent receipt.

**Not in this phase.** Cross-machine fleets (M7, NF-020); the managed domain, task DAG and verifier (M8, NF-018); team memory sharing across users (M6); self-improvement (M8).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| A second subagent construction path appears (the classic escape) | high | high | One primitive + `gate:boundary-test`; the gate fails on a new caller | `runtime-owner` |
| Budget inheritance leaks: children budgeted per-child but cost rolls up per-root | medium | high | One accounting path; usage events carry `attribution.stepId` (RC-4) | `runtime-owner` |
| Worktree pool shipped against NF-018, which lands in M8 (dependency inversion) | high | medium | M5 claims only pool primitives with **no** managed-domain integration; the inversion is recorded in §8 (OQ-R2) | `kernel-owner` |
| Planner/executor routing reintroduces a classifier | medium | high | Routing is policy over raw user text (NF-004); a classifier is rejected (ADR-007, D-8) | `runtime-owner` |
| Scheduler runs unattended work before approval UX is mature | medium | high | Scheduled runs carry the same posture and approval path; no bypass exists in the design | `surface-owner` |

### 3.7 M6 · Ecosystem

**Goal.** Extensions and integrations that declare before they act: plugins and a marketplace, skills, the LSP/DAP broker, deferred tool discovery, collaboration, team memory and import from other agents.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M6-D1 | Plugin system: out-of-process host, manifest-declared capabilities, per-use admission (NF-043, NF-032 partial) | `/data/home/forge/hzcode/docs/15-extensibility.md` |
| M6-D2 | Plugin marketplace with signed manifests; install shows the declared capability set and installs disabled by default (NF-032) | `/data/home/forge/hzcode/docs/15-extensibility.md`, `/data/home/forge/hzcode/docs/16-operations.md` |
| M6-D3 | Skill system + synthesis with eval verification (`skillify`); `unverified` skills are visible as such (NF-033) | `/data/home/forge/hzcode/docs/15-extensibility.md`, `/data/home/forge/hzcode/docs/08-runtime.md` |
| M6-D4 | LSP/DAP broker: one server per language per workspace, capability-gated, mutating operations receipted (NF-042 complete) | `/data/home/forge/hzcode/docs/09-tools.md` |
| M6-D5 | Deferred tool discovery and capability-scoped tool catalogs: `tool_search`, core set plus index (NF-038) | `/data/home/forge/hzcode/docs/09-tools.md` |
| M6-D6 | Collaboration with presence: shared sessions, driver/approver roles as grants, scoped share links (NF-030) | `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M6-D7 | Team memory: the fourth tier, sync with provenance-preserving conflict resolution, local-only fallback (NF-013) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M6-D8 | Import and migration from other agents (settings, hooks, MCP servers, commands, skill directories); imported settings may only narrow (ADR-008, NF-031 partial) | `/data/home/forge/hzcode/docs/21-migration.md` [planned] |
| M6-D9 | Multimodal and voice I/O: `view_image`, attachments, `stt`/`tts`, out-of-process media rendering (NF-040) | `/data/home/forge/hzcode/docs/09-tools.md`, `/data/home/forge/hzcode/docs/04-lld.md` |
| M6-D10 | CLI shell integration: `wrap`, `du`, `doctor`, zsh `:`-prefixed plugin (the agent as a shell citizen) | `/data/home/forge/hzcode/docs/14-surfaces.md` |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:boundary-test` — a plugin cannot become an authority path; plugin calls traverse `plugins.invoke` and the kernel's Guard is unchanged.
- `gate:receipt-coverage` — plugin installs, skill invocations and LSP/DAP mutating operations have declared observation paths.
- `gate:provenance` — bundled skills, plugins and ported tool sets carry upstream pins and NOTICE entries (ADR-014).
- `gate:frontend-parity` — ecosystem features reach every surface that declares their edge.
- `gate:layering` — extensions depend on contracts, never on internals.
- `gate:doc-status` — the extensibility document's status lines match evidence.

**Demonstrable artifact at exit.** A signed plugin installs disabled, shows its declared capabilities, is enabled, and runs confined with an undeclared capability refused at runtime; a synthesised skill is promoted only after passing its evals; HorizonCode drives an external ACP agent from the IDE surface and consumes an MCP server from it.

**Not in this phase.** Ambient-authority plugins; auto-applied skills; a marketplace listing treated as a trust shortcut; the managed domain (M8); enterprise managed policy (M7).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Plugin host becomes an authority bypass | medium | high | Plugins call `plugins.invoke`; kernel decisions unchanged; install is `external-effect`; `gate:boundary-test` | `kernel-owner` |
| Marketplace supply chain: a signed malicious plugin with a wide declared set | medium | high | Capability declaration shown before enabling; installs disabled by default; undeclared capabilities refused at runtime | `release-owner` |
| Skill regression: a synthesised skill looks helpful and does the wrong thing | medium | high | Promotion requires eval pass; `unverified` skills are marked wherever offered | `learn-owner` |
| Import from other agents widens instead of narrowing | low | high | Import maps into the narrowing lattice (ADR-008); a widening import is refused and reported | `spec-owner` |
| LSP/DAP broker duplicates servers per surface | medium | medium | One broker per workspace with a bounded pool; surfaces call the broker only | `runtime-owner` |

### 3.8 M7 · Enterprise

**Goal.** Deployable and auditable in an organisation: signed managed policy, offline and air-gapped operation, remote execution on machines you own, distribution integrity and audit export.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M7-D1 | Signed, cached managed policy with a pre-sandbox policy heal; managed ≥ user ≥ workspace, narrowing only (NF-031 complete) | `/data/home/forge/hzcode/docs/16-operations.md`, `/data/home/forge/hzcode/docs/11-authority-safety.md` |
| M7-D2 | Offline and air-gapped operation end-to-end: local-first, offline, air-gapped modes with typed refusals for capabilities that cannot work degraded (NF-023) | `/data/home/forge/hzcode/docs/16-operations.md` |
| M7-D3 | Multi-machine execution under `remote.exec`: remote hosts return **their** guarantee vector and residuals; per-host grants (NF-020) | `/data/home/forge/hzcode/docs/11-authority-safety.md`, `/data/home/forge/hzcode/docs/14-surfaces.md` |
| M7-D4 | Distribution integrity: one static binary per platform, kernel asset digest pinned, digest-pinned signed updates, desktop and mobile as separate thin modules (NF-046 complete) | `/data/home/forge/hzcode/docs/16-operations.md` |
| M7-D5 | Provenance and release artifacts: pinned upstreams, NOTICE from the register, signed release artifacts (NF-048 complete) | `/data/home/forge/hzcode/docs/16-operations.md` |
| M7-D6 | Audit export: receipts + policy revisions + trust records for an auditor, offline-verifiable (NF-017, NF-041 complete) | `/data/home/forge/hzcode/docs/16-operations.md` |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:kernel-pin` — the released kernel asset digest matches the pinned manifest; a mismatch fails closed to read-only.
- `gate:provenance` — every inherited path has an upstream pin and a NOTICE entry (ADR-014).
- `gate:no-unknown-retry` — a remote effect that ends `UNKNOWN` is reconciled, never retried.
- `gate:receipt-coverage` — remote effects are receipted with the remote host's guarantee vector attached.
- `gate:dead-lane-fail-closed` — offline mode proves zero outbound connections (socket-level assertion) or the capability reports a typed refusal.
- `gate:sensitive-path-coverage` — managed-policy and vault paths are covered by proving tests.
- `gate:doc-status` — the operations document's status lines match evidence.

**Demonstrable artifact at exit.** A signed managed policy imports into a machine where the user already narrowed their config; the effective policy is the meet and the widening attempt is reported. An air-gapped machine runs a full session with zero outbound connections and a local model. A remote effect executes on a second machine and returns that host's guarantee vector and typed residuals alongside the receipt.

**Not in this phase.** A vendor-hosted control plane (D-4, D-15); an on-device mobile kernel (D-6); telemetry on by default (D-16); a payment agent (D-7); the managed domain (M8).

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Managed policy import narrows incorrectly (import widens) | low | high | Import may only narrow (ADR-008); the difference is shown at import time | `release-owner` |
| Air-gap claim contradicts reality (a feature silently needs the network) | medium | high | Socket-level zero-connection assertion; capabilities that cannot work degraded report a typed refusal | `release-owner` |
| Remote execution treated as ambient authority | medium | high | Remote re-evaluates policy for the remote context; guarantee shortfall is a typed residual | `kernel-owner` |
| Update path becomes a remote-code-execution channel | low | high | Digest-pinned, signature-verified updates; failure leaves the previous version running | `release-owner` |

### 3.9 M8 · Self-improvement

**Goal.** Learning that never widens authority, a managed domain that runs and verifies long jobs, and the certification that makes `RELEASED` honest.

**Deliverables.**

| # | Deliverable | Specified by |
|---|---|---|
| M8-D1 | Trajectories, evals, distillation, `skillify` and gated proposals; authority impact always `none` (NF-010, NF-033 complete, NF-034, NF-035) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/15-extensibility.md` |
| M8-D2 | Managed coding domain: Goal / SpecVersion / Run / Task / Attempt / WorkerExecution / Evidence / Verification, OwnerLog, task DAG, verifier, worktree pool completion, resource budget (NF-018, NF-019 complete, NF-017 complete) | `/data/home/forge/hzcode/docs/11-authority-safety.md`, `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M8-D3 | Long-horizon unattended runs: checkpoint/rewind/resume, retention, reconciled `UNKNOWN`s, no human in the loop — under unchanged postures | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/12-sessions-state.md` |
| M8-D4 | Prompt tuning under cache discipline: variants evaluated as whole prefixes with paired evals; promotion is a proposal (NF-034) | `/data/home/forge/hzcode/docs/10-cognition.md` |
| M8-D5 | Trajectory dataset export with outbound redaction and scoping (NF-035) | `/data/home/forge/hzcode/docs/08-runtime.md`, `/data/home/forge/hzcode/docs/16-operations.md` |
| M8-D6 | Adversarial certification suite: prompt injection, authority confusion, path escape, egress abuse, classifier-free routing attacks — with recorded evidence bundles | `/data/home/forge/hzcode/docs/22-threat-model-certification.md` [planned] |
| M8-D7 | `RELEASED` march: every capability raised level by level with named evidence; `gate:doc-status` green on the whole set | `/data/home/forge/hzcode/docs/_conventions.md` §8 |

**Exit criteria — gate checklist.** All of these must be green:

- `gate:provenance` — every inherited code path has an upstream pin and a NOTICE entry (ADR-014).
- `gate:kernel-pin` — the released kernel asset digest matches the pinned manifest.
- `gate:parity-ratchet` — the full Section A matrix is reachable from every declared surface.
- `gate:frontend-parity` — no surface is missing an edge, including the SDKs and MCP server.
- `gate:doc-status` — the entire spec set carries statuses supported by evidence, with no gaps.
- `gate:no-unknown-retry` — the adversarial suite injects an `UNKNOWN` and asserts no retry.
- `gate:receipt-coverage` — coverage complete, including long-horizon resumed runs.
- `gate:dead-lane-fail-closed` — every lane that is off is provably off, and says so.

**Demonstrable artifact at exit.** An unattended multi-day run on a real workspace: plan, tasks, attempts, receipts, evidence bundle, verifier verdict, every `UNKNOWN` either reconciled or explicitly still open; followed by the adversarial certification report. Both are `VERIFIED` artifacts, not prose.

**Not in this phase.** Any learning path that can widen authority (ADR-010, D-12); automatic merge without the evidence gate; a vendor-hosted control plane; a classifier for safety decisions; claims of general capability beyond the parity matrix.

**Risks.**

| Risk | Likelihood | Impact | Mitigation | Owner-role |
|---|---|---|---|---|
| Self-improvement quietly widens authority through a proposal | low | high | Authority impact `none` for the whole learning set (ADR-010); proposals are reviewed, never auto-applied | `learn-owner` |
| Managed domain becomes a second runtime | medium | high | It orchestrates the same effect host; no second effect submission path (`gate:boundary-test`) | `kernel-owner` |
| Long-horizon runs accumulate unreconciled `UNKNOWN`s | high | medium | Reconciliation is a first-class state machine; `hzcode session verify` reports leftovers | `kernel-owner` |
| Adversarial suite is written after the claims, not before | medium | high | M8-D6 is a scheduled deliverable with evidence bundles, not a review pass | `release-owner` |
| Prompt tuning improves a benchmark by breaking caching | medium | medium | Variants are evaluated as whole prefixes; a cache-breaking win is reported as such (NF-034) | `cognition-owner` |

---

## 4. Document ownership and feature index

### 4.1 Document assignments (`03`–`23`)

`24-feature-catalog.md` §1 and NF-047 refer to the ownership map in this section. Documents `00`–`16`, `24` and `25` exist at this revision; titles below are confirmed by `/data/home/forge/hzcode/docs/00-index.md`. Documents `17`–`23` are **proposals** and carry no authority until `spec-owner` ratifies them; until a document exists, its topic is owned by the closest existing document and the gap is recorded in §8.

| Doc | File | Owns |
|---|---|---|
| 03 | `/data/home/forge/hzcode/docs/03-hld.md` | Planes, processes, trust boundaries, interfaces, deployment targets |
| 04 | `/data/home/forge/hzcode/docs/04-lld.md` | Packages, crates, modules, function signatures, invariants |
| 05 | `/data/home/forge/hzcode/docs/05-domain-and-schemas.md` | Domain model, every `*V1` schema |
| 06 | `/data/home/forge/hzcode/docs/06-events-and-flows.md` | Event catalogue, end-to-end flows |
| 07 | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md` | Controller protocol, kernel ABI, HTTP/SSE, ACP, MCP, plugin API, SDKs |
| 08 | `/data/home/forge/hzcode/docs/08-runtime.md` | Agent loop, planner/executor, subagents, teams, budgets, self-improvement |
| 09 | `/data/home/forge/hzcode/docs/09-tools.md` | Tool catalogue and tool system |
| 10 | `/data/home/forge/hzcode/docs/10-cognition.md` | Providers, context compiler, cache contract, memory, retrieval, compaction |
| 11 | `/data/home/forge/hzcode/docs/11-authority-safety.md` | Threat model, Guard, leases, receipts, sandbox matrix, policy |
| 12 | `/data/home/forge/hzcode/docs/12-sessions-state.md` | Event log, projections, inbox, claims, snapshots, time travel, durability |
| 13 | `/data/home/forge/hzcode/docs/13-tui.md` | The terminal UI in full |
| 14 | `/data/home/forge/hzcode/docs/14-surfaces.md` | Headless, server, web, desktop, IDE/ACP, MCP server, SDKs, collaboration |
| 15 | `/data/home/forge/hzcode/docs/15-extensibility.md` | Plugins, skills, commands, hooks, workflows, MCP/ACP depth |
| 16 | `/data/home/forge/hzcode/docs/16-operations.md` | Install and release integrity, CI gates, observability, diagnostics, security ops, runbooks |

| Doc | Proposed file `[planned]` | Proposed ownership — **unratified** |
|---|---|---|
| 17 | `/data/home/forge/hzcode/docs/17-storage-and-persistence.md` | Event-store files and migrations, blob/CAS layout, retention ledger, reindex/backup |
| 18 | `/data/home/forge/hzcode/docs/18-testing-and-gates.md` | Test harness, record/replay, gate implementations of `24-feature-catalog.md` §3.5, evidence-bundle format |
| 19 | `/data/home/forge/hzcode/docs/19-schema-evolution.md` | `*V1`→`*V2` rules, compatibility windows, protocol revision policy |
| 20 | `/data/home/forge/hzcode/docs/20-plugin-authoring.md` | Extension protocol, plugin manifest, authoring guide, marketplace rules |
| 21 | `/data/home/forge/hzcode/docs/21-migration.md` | Import of settings, rules, MCP servers, skills and memories from other agents; narrowing-only rule |
| 22 | `/data/home/forge/hzcode/docs/22-threat-model-certification.md` | Adversarial certification suite, attack classes, evidence bundles for M8-D6 |
| 23 | `/data/home/forge/hzcode/docs/23-doc-authoring.md` | How to add a document, a capability id, an event or a gate; ratchet and status rules |

### 4.2 Feature index — `NF-001`…`NF-050`

Every id below has a definition section in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §5 (anchor `NF-<id>`); the owning document is the assignment from §4.1. Where a phase column shows two phases, the first is the partial claim and the second the completion (the partial scope must be named in the status line — see §8 OQ-R7).

| Id | Name | Owning doc | Phase |
|---|---|---|---|
| NF-001 | Execution constitution with universal receipts | 11 | M2 |
| NF-002 | Evidence gate with claim lowering | 11 | M2 |
| NF-003 | Composed policy: wildcards + Starlark + origin typing + narrowing-only workspace config | 11 | M2 |
| NF-004 | Deterministic planner/executor routing | 08 | M5 |
| NF-005 | Cache-first context compiler with a contract test | 10 | M4 |
| NF-006 | One Controller across eight surfaces with a parity ratchet | 14 | M1 (TUI, headless) → M3 |
| NF-007 | Subagent fleets with capability grants | 08 | M5 |
| NF-008 | Four-tier memory with distillation and provenance | 10 | M4 |
| NF-009 | Time-travel replay | 12 | M1 (read) → M2 (dry-run) |
| NF-010 | Gated self-improvement proposals | 08 | M8 |
| NF-011 | `hz://` resource space | 07 | M0 (scheme) → M1 (resolution) |
| NF-012 | Workflow engine | 15 | M5 |
| NF-013 | Team memory | 10 | M6 |
| NF-014 | Capability-granted delegation | 11 | M2 |
| NF-015 | Unified native capability stack | 04 | M1 (shell, edit, diff, walker) → M6 |
| NF-016 | Cross-platform sandbox matrix with typed residuals | 11 | M2 |
| NF-017 | Trusted Host State evidence chain | 11 | M2 |
| NF-018 | Managed coding domain | 11 | M8 |
| NF-019 | Worktree pool isolation | 12 | M5 (primitives) → M8 |
| NF-020 | Multi-machine and remote execution | 14 | M7 |
| NF-021 | Egress control and network policy | 11 | M2 |
| NF-022 | Secret vault with redaction | 16 | M4 |
| NF-023 | Offline and air-gapped operation | 16 | M7 (local-first mode testable in M4) |
| NF-024 | Account pools with credential affinity | 10 | M4 |
| NF-025 | Cost gate across the session tree | 08 | M5 |
| NF-026 | Replayable rollout | 12 | M1 |
| NF-027 | Artifact store | 12 | M1 |
| NF-028 | Notification and watchdog system | 08 | M5 |
| NF-029 | Accessible TUI | 13 | M1 |
| NF-030 | Collaboration with presence | 14 | M6 |
| NF-031 | Enterprise managed policy | 16 | M6 (import) → M7 |
| NF-032 | Plugin marketplace with signed manifests | 15 | M6 |
| NF-033 | Skill synthesis with eval verification | 15 | M6 (complete M8) |
| NF-034 | Prompt tuning under cache discipline | 10 | M8 |
| NF-035 | Trajectory dataset export | 08 | M8 |
| NF-036 | The `UNKNOWN` UX | 11 | M2 |
| NF-037 | Editor bridge: bidirectional ACP, trusted device and replay | 14 | M3 |
| NF-038 | Deferred tool discovery and capability-scoped tool catalogs | 09 | M6 |
| NF-039 | Hermetic provider record/replay harness | 18 [planned] | M1 (first use) → M4 |
| NF-040 | Multimodal and voice I/O | 09 | M6 |
| NF-041 | Observability: OpenTelemetry, GenAI conventions and a local dashboard | 16 | M4 (partial) → M7 |
| NF-042 | Language intelligence: one LSP/DAP host broker | 09 | M4 (index) → M6 |
| NF-043 | Extension protocol v2 and a capability-declaring plugin host | 15 | M6 |
| NF-044 | Provider breadth: catalog, wire codecs and local servers | 10 | M4 |
| NF-045 | Plan, Goal and Todo state machines with an approved-plan window | 08 | M5 |
| NF-046 | Distribution: one static binary, thin mobile, nested desktop, digest-pinned updates | 16 | M0 (skeleton) → M3 (desktop) → M7 |
| NF-047 | Documentation-as-authority with machine-checked status levels | 23 [planned] | M0 |
| NF-048 | Derivative provenance discipline | 16 | M0 (register) → M7 (release) |
| NF-049 | Run supervision, crash recovery and lane health | 12 | M2 (dead-lane rule) → M5 (supervision) |
| NF-050 | Append-only vendor price table and metric definitions | 16 | M4 |

**Counts.** 62 features defined (`NF-001` … `NF-062`); `NF-001`–`NF-050` indexed above, the second learning pass `NF-051`–`NF-062` in §4.2a. All are `DESIGNED` as specification claims; implemented v1 slices are recorded in `28-implementation-status.md` (currently: NF-051 code mode and NF-055 preview in reduced forms). The learning-loop set — `NF-008`, `NF-010`, `NF-033`, `NF-034`, `NF-035` — declares authority impact `none` in every case (ADR-010; `24-feature-catalog.md` §6.3).

### 4.2a Feature index — `NF-051`…`NF-062` (second learning pass)

Definitions in `24-feature-catalog.md` Section B; adopted by RC-12; sequenced by `27-implementation-plan.md`. Where a v1 slice is built, the level lives in `28-implementation-status.md`.

| Id | Name | Owning doc |
|---|---|---|
| NF-051 | Code Mode v2 — confined program over the tool tree (CM-1…CM-14) | 09 |
| NF-052 | ACI reading modes — windowed read, summary grep, lint gate, env taming | 09 |
| NF-053 | Pre-submit governance loop + governed plan FSM | 06 |
| NF-054 | Execution recorder and time-travel debug | 09 |
| NF-055 | Preview environments — ephemeral, sandboxed, bound URL injected | 14 |
| NF-056 | Tier-parity program — paired evals, strict-REPL variants, parity ratchet | 10 |
| NF-057 | Local inference acceleration — speculative decoding, KV reuse, micro-models | 07 |
| NF-058 | Policy statements — safety-inverted precedence, allow-never-grants, enforcement protection | 11 |
| NF-059 | Instruction epochs and content-addressed instruction blobs | 10 |
| NF-060 | Event-feed laws and stream framing — durable/transient, sync preamble | 07 |
| NF-061 | Tool-result dual output and fail-closed retention | 05 |
| NF-062 | Composer and review UX — queue edit/reorder, bulk review, attachments | 13 |

### 4.3 ADR index

Every ADR in `/data/home/forge/hzcode/docs/02-decisions.md` §1 (`ADR-001`–`ADR-016`), all **Accepted**. The one-line decision is the ADR title unless noted.

| ADR | Decision (one line) | Owner doc |
|---|---|---|
| ADR-001 | Terminal-first; the TUI is the product, the protocol is the API | 13, 14 |
| ADR-002 | Hybrid runtime: TypeScript/Bun for the agent, Rust for authority and native capability behind one N-API facade | 03, 04 |
| ADR-003 | The kernel is a separate process, not a library | 03, 11 |
| ADR-004 | Event-sourced session storage (log is the state of record) | 12 |
| ADR-005 | One Controller, many front-ends, enforced by a parity ratchet | 14 |
| ADR-006 | MCP is a client *and* a server | 07, 15 |
| ADR-007 | Policy is code: wildcard rules + Starlark prefix engine; no classifier routing | 11 |
| ADR-008 | Workspace config may only narrow user config | 11, 16 |
| ADR-009 | Cache prefix stability is a CI contract | 10 |
| ADR-010 | Self-improvement never widens authority | 08 |
| ADR-011 | No hidden in-memory tool loop: one provider stream per step | 08 |
| ADR-012 | Every mutation produces a receipt; `UNKNOWN` is a first-class state | 11, 12 |
| ADR-013 | Local-first, BYO keys, offline-capable | 16 |
| ADR-014 | Derivative work is permitted, tracked and attributed | 16, 23 |
| ADR-015 | Tools are declared, not string-matched | 09 |
| ADR-016 | Subagent construction funnels through one primitive | 08 |

---

## 5. Glossary

Alphabetical. One sentence per term, then the document that **owns** the definition. Where this glossary and an owning document disagree, the owning document wins and this entry is a bug. Naming conventions themselves are owned by `/data/home/forge/hzcode/docs/_conventions.md`; entries cite its sections where the term is registered there.

### A–B

| Term | Definition | Owning doc |
|---|---|---|
| **ABI** | The versioned binary interface between the JS agent plane and the Rust kernel/native plane, generated from schemas and bumped on breaking change (`HZ_ABI=1`). | 04; `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| **ACP** | Agent Client Protocol — the IDE/agent interoperability protocol HorizonCode both speaks as an agent and drives outward. | 07, 14 |
| **ACP agent** | HorizonCode acting in ACP server role: it exposes sessions and permission requests to an IDE or another agent. | 14 |
| **admission** | The act of accepting a user prompt into a session before any step runs, producing a durable record and a cheap receipt. | 08, 12; event `hz.session.prompt.admitted` |
| **adopt_ref** | The mechanism by which a fleet child result is adopted by its parent (or another child) as an explicit, referenceable dependency rather than an implicit copy. | 08; tool `fleet` |
| **agent profile** | A named, declared agent configuration (`AgentProfileV1`): model role, tools, permissions, prompt family, output contract. | 05, 08 |
| **approval window** | The bounded period, opened by approving a plan, during which only the approved tool set auto-approves; it closes on completion, abandonment, policy revision change or budget exhaustion. | 08; NF-045 |
| **artifact** | A durable, content-addressed output (`hz://artifact/<sha256>`) written through the `artifact.write` capability and referenced from the session rather than inlined. | 12; NF-027 |
| **ask** | A `GuardDecisionV1` outcome, distinct from `deny`: an approval could change the result, so a question is emitted (`hz.permission.asked`) and answered at most once. | 11 |
| **attribution** | The event field that ties a usage or cost record to the step and root that caused it (`attribution.stepId`), so tree rollups reconcile. | 12; RC-4 |
| **autonomy budget** | A bound on how much unattended work an agent may do before a human touchpoint, expressed in the same accounting units as the cost gate and inherited by children. | 08, 11 |
| **blob / CAS** | Content-addressed storage keyed by SHA-256 (`hz://artifact/<sha256>`); artifacts and large payloads are referenced, never inlined twice. | 05, 12 |
| **boundary test** | A test asserting that a one-primitive boundary (effect submission, subagent construction, event append) still has exactly one caller. | 04, 08; `gate:boundary-test` |
| **budget** | The declared, inherited allowance for a run or session — tokens, wall-clock, steps, triage, search calls, currency — enforced at admission boundaries. | 08, 16; NF-025 |
| **budget lease** | The kernel-side reservation that makes a budget enforceable at an admission boundary rather than reported after the fact. | 11, 16 |

### C

| Term | Definition | Owning doc |
|---|---|---|
| **cache guard** | The CI contract that recompiles the prompt prefix for every `(provider, model, config)` tuple and fails on drift (`gate:cache-guard`). | 10; `/data/home/forge/hzcode/docs/_conventions.md` §11 (RC-8) |
| **capability ID** | The stable identifier for an authority a tool needs (`files.write`, `terminal.run`, …); aliases never change its effect class. | `/data/home/forge/hzcode/docs/_conventions.md` §5 |
| **capability scope** | The declared set of capability IDs a run, child or plugin may use — stated before it starts, narrowed for children, enforced by Guard. | 08, 11; NF-014, NF-018 |
| **capsule (context capsule)** | The bounded, versioned context a subagent is constructed with — its own prefix/tail assembly derived from the parent, never a raw dump of parent history. | 08 |
| **checkpoint** | A durable marker at a well-defined point so compaction, resume and rewind have a provider-visible boundary (`hz.session.checkpoint.created`). | 12 |
| **claim (execution claim)** | The write-ahead record that a session is executing; it survives shutdown and is released only by a terminal state. | 12 |
| **classifier** | A model-based router or safety judge. **Not used in this design**: routing and policy are deterministic (NF-004, ADR-007), because a classifier is a second, unauditable decision path that can be prompt-injected. | 08, 11 |
| **code mode** | Confined program execution over a namespaced tool tree (`code_mode`); nested calls go back through the ordinary tool batch and are receipted individually. | 09, 11 |
| **compaction** | The operation that reduces a session's context while preserving the items declared mandatory (goal, plan, todos, receipt set, unresolved `UNKNOWN`s, pending asks, active skill, budgets). | 10; event `hz.session.compacted` |
| **context compiler** | The component that assembles exactly two regions — byte-stable prefix and projected turn tail — from session, memory and retrieval state. | 10 |
| **context epoch** | The monotonic marker identifying which context compilation a step was computed against, so cached and stale context is detectable. | 10 |
| **Controller** | The single transport-agnostic orchestrator that all surfaces are clients of; behaviour lives here and nowhere else. | 03, 14; ADR-005 |
| **correlation id** | The id that ties one user intent to its steps, tool calls, effects and receipts, end to end. | 05, 12 |

### D–E

| Term | Definition | Owning doc |
|---|---|---|
| **dead lane** | A feature path that is switched off; a dead lane MUST refuse or report `UNKNOWN`, never return a green result (`gate:dead-lane-fail-closed`). | 11, 12; NF-049 |
| **decision (GuardDecision)** | The typed outcome of `authorize()` — `GuardDecisionV1` carries `ask`/`deny`, a `reason_code` and the digest of the intent it binds. | 11 |
| **delegation** | The act of granting a narrowed, bounded capability set to a child or plugin, always through Guard, a lease and a receipt. | 11; NF-007, NF-014 |
| **DirectSessionGrant** | The persisted form of a bounded, workspace-scoped, expiring pre-authorisation that still traverses Guard on every use. | 11; NF-014 |
| **disposition** | In the parity matrix, how a capability relates to a reference implementation (`inherit` / `supersede` / `new` / `reject`); a disposition may not silently regress (`gate:parity-ratchet`). | `/data/home/forge/hzcode/docs/24-feature-catalog.md` §4 |
| **durable event** | An event written to the session log and therefore part of the state of record (as opposed to an ephemeral event). | 12; `/data/home/forge/hzcode/docs/_conventions.md` §6 |
| **durable inbox** | The persisted queue of admitted prompts, control items and steering messages that survives restarts. | 12 |
| **effect** | A single attempt to change state outside the agent: read as well as write, classed by effect class and always mediated by the kernel. | 11 |
| **effect class** | One of `read-only` · `workspace-write` · `network` · `process` · `credential` · `remote` · `external-effect`. | `/data/home/forge/hzcode/docs/_conventions.md` §5 |
| **effect host** | The kernel component that executes a leased effect, observes it, and issues the receipt. | 11 |
| **ephemeral event** | An event streamed for liveness (progress, deltas) that is not part of the durable log. | 12 |
| **epoch fence** | The guard that prevents work computed under an old epoch (context, policy revision, snapshot) from being applied after an epoch change. | 10, 12 |
| **evidence bundle** | The packaged proof for a claim or phase: gate report, demo trace, receipts touched, guarantee vectors, unresolved `UNKNOWN`s — referenced by digest in Trusted Host State. | 11; NF-017 |
| **evidence gate** | The mechanism that checks model claims against receipts and Trusted Host State and can only lower a claim (`NF-002`). | 11; tool `verify` |
| **execpolicy / Starlark policy** | The prefix-matching policy program that decides command and tool intents, compiled and executed rather than string-matched (NF-003, ADR-007). | 11 |
| **executor** | The model role that performs work under a plan (as opposed to the planner that proposes one); it runs in its own session with its own cache-stable prefix. | 08; NF-004 |

### F–G

| Term | Definition | Owning doc |
|---|---|---|
| **fail-closed** | The default when a guarantee cannot be proven: refuse or report `UNKNOWN` — never proceed and never report success. | 11, 16 |
| **fleet** | A set of subagents with an explicit dependency graph (`id`/`depends_on`), upstream results, `adopt_ref`, and `fail_fast`. | 08 |
| **front-end / surface** | A client of the Controller — TUI, print/headless, server, web, desktop, IDE/ACP, MCP server, SDKs; it renders and collects input only. | 14 |
| **gate / ratchet** | A CI check named in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5; a *ratchet* may only tighten — its baseline may decrease, never increase. | `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| **goal** | The durable statement of what the user is trying to achieve, updated by events (`hz.goal.updated`) and preserved across compaction. | 08; tool `update_goal` |
| **Guard** | The kernel decision point: every effect resolves to a `GuardDecisionV1` before a lease can exist. | 11 |
| **guard decision** | See *decision (GuardDecision)*. | 11 |
| **guarantee vector** | The per-dimension assessment of what confinement the host actually enforces (`Unsupported` / `BestEffort` / `Enforced`), with residuals attached. | 11; NF-016 |

### H–K

| Term | Definition | Owning doc |
|---|---|---|
| **handoff** | The explicit transfer of a task, result or continuation between agents (parent↔child, IDE↔agent, or ACP peer), carried by a named tool and recorded as events rather than prose. | 08, 14; tool `task` |
| **HZ_ABI / HZ_PROTO** | Integer protocol revisions, bumped on breaking change; a mismatch fails closed. | `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| **hz://** | The single resource URI space (`hz://session/<id>`, `hz://receipt/<id>`, `hz://artifact/<sha256>`, `hz://trusted-state/<digest>`, …), resolved with capability checks, never by string parsing. | `/data/home/forge/hzcode/docs/_conventions.md` §1; NF-011 |
| **intent digest** | The hash of the canonical intent an effect was authorised for, bound into the decision, the lease and the receipt so the executed effect can be shown to equal the approved one. | 11 |
| **kernel (`hzk`)** | The separate authority process that owns Guard, leases, the effect host, receipts, the OwnerLog and the managed domain. | 03, 11; ADR-003 |
| **kernel release** | A release of the kernel asset whose digest must be pinned; the agent must not proceed on an unpinned or older ABI (`gate:kernel-pin`, `gate:cross-plane-abi`). | 16; NF-046 |

### L–M

| Term | Definition | Owning doc |
|---|---|---|
| **lane health** | The startup declaration and truthful reporting of whether an optional lane is available; a disabled lane returns a typed refusal with a reason. | 12, 16; NF-049 |
| **lease (one-use)** | The kernel-issued, single-use permission to perform one prepared effect; using it is the only way an effect may execute. | 11 |
| **mailbox** | The addressed message channel a subagent or teammate reads from — messages are events (`hz.agent.message.sent`), not shared memory. | 08 |
| **managed domain** | The kernel-run domain for long jobs: Goal / SpecVersion / Run / Task / Attempt / WorkerExecution / Evidence / Verification, plus OwnerLog, verifier and worktree pool. | 11; NF-018 |
| **MCP** | Model Context Protocol — a client (consume external tools) and a server (expose this agent) per ADR-006. | 07, 15 |
| **memory tier** | One of the four memory scopes — working, episodic, semantic, team — each with its own retention rule and provenance requirements. | 10; NF-008 |
| **metric definition** | The four-line statement (counts what, from which anchor, over which population, excluding what) that a number must carry before it is treated as a finding. | 16; NF-050 |
| **MMR (maximal marginal relevance)** | The diversity criterion used when selecting retrieved memory items, so a recall does not return four paraphrases of one fact. | 10 |

### N–O

| Term | Definition | Owning doc |
|---|---|---|
| **N-API addon** | The single compiled facade (`hz_native`) through which the TS plane reaches walker, edit, diff, AST, VCS, shell, PTY, voice and index crates. | 04; NF-015 |
| **narrowing** | The only legal direction for configuration composition: workspace narrows user, managed narrows both, imports narrow — `deny > ask > allow` always wins. | 11, 16; ADR-008 |
| **notification** | A watchdog- or policy-triggered message to a declared sink (terminal, OS, webhook, email, file); an unreachable sink is itself an event. | 08; NF-028 |
| **occurrence journal** | The durable record of scheduler occurrences written before a run, so a restart cannot double-fire or silently skip a scheduled workflow. | 08; NF-012 |
| **origin kind** | `EffectOriginKindV1` ∈ {SessionBatch, UserAction, ManagedRun, ManagedRoot} — fixed by the canonical operation and never supplied by a request body, so a model batch cannot present itself as human authority. | 11 |
| **OTel** | OpenTelemetry: the trace/metric export path, with redaction applied before export and export off by default. | 16; NF-041 |
| **OwnerLog** | The kernel's own append-only, hash-chained record for authority-side facts (leases, receipts, grants, journal metadata), separate from the session event log. | 11, 12; RC-3 |
| **overlay provenance** | The discipline of pinning upstreams and tracking every inherited file, so HorizonCode's relationship to each reference is auditable at any time. | 16; NF-048 |

### P

| Term | Definition | Owning doc |
|---|---|---|
| **parity ratchet** | The CI rule that no capability disposition may regress and no declared surface may lose an edge (`gate:parity-ratchet`). | `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5; NF-006 |
| **part** | The addressable unit of session content (message part, tool output part, file diff part) created and updated by events. | 05; events `hz.part.created`, `hz.part.updated` |
| **personality** | **Not a term in this spec set.** No document defines a personality system; agent behaviour is configured through agent profiles. Named here only so the word is not invented later. | — |
| **plan mode** | The posture in which the agent plans without mutating: plan state is durable, and executing requires leaving plan mode or an approved-plan window. | 08; NF-045 |
| **planner** | The model role that proposes a plan; it runs in its own read-only session so the executor's prefix is never disturbed. | 08; NF-004 |
| **posture** | `SessionPostureV1` / `DirectSessionPermissionModeProjectionV1` — the data, not the code, that says what is allowed: `sandboxMode`, `approvalPolicy`, `source`, `revision`, `digest`. | 11 |
| **prediction / prewalk** | The modelling of what an action will do (prediction) and the automatic model downgrade after the first successful edit once a todo list exists (prewalk); both must leave the prompt prefix untouched. | 08; NF-004 |
| **projection** | A derived read model built from the durable log (session list, tree view, permission view); disposable and rebuildable by definition. | 12; ADR-004 |
| **prompt admission** | See *admission*: the durable acceptance of a prompt into the session before execution, receipted cheaply. | 08, 12 |
| **prompt family** | The named prompt template set (per agent profile/model role) whose compiled prefix is pinned and checked by the cache guard. | 10; RC-8 |
| **prompt prefix** | The byte-stable leading region of a compiled request (system prompt, sorted tool schemas, declared configuration); volatility here is a bug, not a tuning choice. | 10 |
| **protocol revision** | See *HZ_ABI / HZ_PROTO*. | `/data/home/forge/hzcode/docs/_conventions.md` §1 |
| **provenance register** | The machine-readable map from every inherited file to its origin, from which the human-readable NOTICE is generated (`gate:provenance`). | 16; NF-048 |

### R

| Term | Definition | Owning doc |
|---|---|---|
| **receipt** | The durable record of an executed effect (`EffectReceiptV1`): intent digest, decision, lease id, observation, terminal state. | 11; event `hz.effect.settled` |
| **reconciliation** | The explicit process that resolves an `UNKNOWN` effect by observation, emitting `hz.effect.reconciled` — never by re-running the effect. | 11, 12 |
| **repolint** | The ratchet suite that checks layering, file/function size, wire parity, frontend parity, doc ownership and orphans, with debt in a baseline that may only decrease. | 16; NF-047 |
| **reserved residual** | A shortfall in a guarantee vector recorded *before* the effect is attempted, so the capability is known to operate with a reserved exception rather than a silent tolerance. | 11; NF-016 |
| **residual (typed residual)** | A typed, reportable shortfall between a guarantee claimed and the guarantee the host can enforce (`GuaranteeAssessment.residuals`), surfaced at the point of use. | 11; NF-016 |
| **rewind** | Moving a session's working state back to a checkpoint (`hz.session.rewound`), with a fork as the alternative when history must be preserved. | 12 |
| **Rhai** | The scripting language of the workflow engine, which orchestrates agents through a host channel rather than direct authority. | 15; NF-012 |
| **run** | In the managed domain, one execution of a SpecVersion under a declared capability scope, containing tasks, attempts and verification. | 11; NF-018 |
| **runAs** | The identity an effect executes under, declared per posture/operation and never inferred from the model's request. | 11 |

### S

| Term | Definition | Owning doc |
|---|---|---|
| **sandbox guarantee vector** | See *guarantee vector*. | 11; NF-016 |
| **schema version (`V1`)** | The suffix on every wire/durable schema (`GuardDecisionV1`); a schema is never edited in place, a new major is written. | `/data/home/forge/hzcode/docs/_conventions.md` §7 |
| **sensitive-path coverage** | The gate that requires every path declared `sensitive:` to be covered by a test that proves it (`gate:sensitive-path-coverage`). | 16; NF-047 |
| **session** | The durable unit of work: admitted prompts, steps, parts, effects and receipts under one id and one posture. | 05, 12 |
| **session posture** | The effective, digest-carrying statement of a session's mode, approval policy and policy revision — the thing `hzcode doctor` displays and drift is detected against. | 11; NF-014 |
| **session tree** | The root run and all its descendants, with authority and cost rolled up so any node is attributable to its root (`hzcode session tree`). | 08, 12; NF-025 |
| **skill** | A loadable unit of instructions/assets — bundled, user, or MCP-derived — invoked as a declared tool. | 15 |
| **skillify** | Turning a repeated, verified trajectory into a candidate skill (a proposal, never an automatic authority change). | 08, 15; NF-033 |
| **snapcompact** | Bitmap-frame context compression for vision-capable models: a compacted representation shipped as an image region of the turn tail, never of the prefix. | 10; NF-008 |
| **snapshot** | The persisted compact form of a session log prefix used for fast recovery and time travel; storage metadata, not a session event. | 12; RC-3 |
| **spec version** | `SpecVersion` in the managed domain: the frozen specification a managed run is executed and verified against. | 11; NF-018 |
| **step** | The atomic unit of agent progress: one provider stream and its tool requests, with its own events and usage attribution. | 08; `/data/home/forge/hzcode/docs/_conventions.md` §6 |
| **steer/queue** | The two admission behaviours: *steering* injects new user input at the running step boundary; *queueing* defers it until after the current turn — the choice is recorded, not implicit. | 08, 12 |
| **subagent** | A child agent constructed by the single subagent primitive with narrowed capabilities, inherited budget and a receipt-linked parent. | 08; ADR-016 |
| **supervisor (lease)** | The kernel-side lease renewed only on real progress, so a stalled or wedged run is detected and reported rather than hanging. | 11; NF-049 |
| **superset (strict superset)** | The product claim that HorizonCode implements every mapped capability of the references in `/data/home/forge/hzcode/docs/24-feature-catalog.md` §4, at equal or stronger disposition; measured by `gate:parity-ratchet`. | 01; `24-feature-catalog.md` §4 |

### T

| Term | Definition | Owning doc |
|---|---|---|
| **team** | A named group of agents (and optionally humans) that share a mailbox and a presence view; teams are constructed through the same one primitive as subagents. | 08; NF-030 |
| **time travel** | Replay of a session from the durable log: read mode (inspect, step, jump) and dry-run mode (re-evaluate policy against recorded intents without executing). | 12; NF-009 |
| **THS (Trusted Host State)** | The host-owned, content-addressed, hash-chained record of contracts, evidence bundles and capability rollout decisions. | 11; NF-017 |
| **todo** | The durable, structured task list owned by the session, updated by event and preserved across compaction. | 08, 09; event `hz.todo.updated` |
| **todo lease** | The hold an attempt takes on a todo item, so two agents cannot silently work the same item and an abandoned item expires back to the pool. | 08; NF-045 |
| **tool declaration** | The complete, required metadata on every tool: name, input schema, read-only/concurrency class, effect class, capability ID, idempotency, renderers, telemetry (ADR-015). | 09 |
| **trajectory** | A recorded, replayable trace of a session or subagent run, used for evals and learning; never an authority record. | 08; NF-035 |
| **triage** | The cheap, bounded first decision about how much machinery a request deserves, counted in the budget and never a hidden model call. | 08 |
| **Trusted Host State** | See *THS*. | 11; NF-017 |
| **turn** | A user-visible cycle of work: admission, one or more steps, and their effects, closed by a terminal state. | 08 |

### U–Z

| Term | Definition | Owning doc |
|---|---|---|
| **UNKNOWN** | A terminal effect state: the outcome cannot be proven; it stays visible until reconciled and is **never** silently retried. | `/data/home/forge/hzcode/docs/_conventions.md` §11 (RC-7); 11, 12 |
| **verifier** | The managed-domain component that checks worker evidence against the Task/SpecVersion contract and can only lower a claim. | 11; NF-018 |
| **VFS** | The injectable virtual filesystem the embedded shell (and confined effects) operate against, so a shell command cannot assume ambient disk access. | 04; NF-015 |
| **wildcard rule** | A declarative policy pattern (`Bash(git *)`, `FileEdit(/src/*)`) compiled into the policy engine; a wildcard never widens a capability by itself. | 11; NF-003 |
| **worktree pool** | A bounded, lifecycle-managed set of git worktrees assigned to child attempts for isolation; pool membership is kernel-managed. | 11, 12; NF-019 |
| **zero-config** | The product promise that a first session works with no configuration file, while every implicit default is still a declared default (and can be narrowed later). | 01, 16 |

---

## 6. Test plan for this roadmap

A roadmap is testable if its gates are. This section specifies how a phase is demonstrated and how the demonstration is accepted. It is a design; nothing below exists.

### 6.1 Phase demo protocol

Each phase closes with the same five steps, in order:

| # | Step | Artifact |
|---|---|---|
| D1 | Build the phase's demonstrable artifact (§3) from a clean checkout, with no unpublished local state | build log + commit id |
| D2 | Run the phase's gate checklist in CI on that commit; record every gate result, including inapplicable gates as `UNKNOWN` | gate report, one line per gate from `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| D3 | Run the demo script on a **fresh workspace** (not the author's) and capture the terminal and network trace | recorded demo + script |
| D4 | Emit an evidence bundle: gate report, demo trace, receipts touched, guarantee vectors, unresolved `UNKNOWN`s | evidence bundle referenced by digest in Trusted Host State (NF-017) |
| D5 | Raise each capability's status to exactly what D2–D4 support, naming the evidence path | diff to the owning document's status section |

A phase that cannot run D3 on a fresh workspace is not finished. A phase that skips D4 may not raise any status above `TESTED`.

### 6.2 The acceptance harness

The harness is the `@horizoncode/testing` package plus the gate runner:

| Component | Purpose | Owner doc |
|---|---|---|
| Gate runner | Executes the named gates and emits machine-readable results | 18 [planned] |
| Record/replay fixtures | Deterministic provider streams so a demo does not depend on a live model (NF-039) | 18 [planned] |
| Boundary tests | Assert the one-caller rules (effect submission, subagent construction, event append) | 04, 08 |
| Phase gate manifest | Machine-readable declaration of the gates a phase must pass | this document, realised as a repository file |
| Evidence-bundle writer | Packages D4 output and digests it into Trusted Host State | 11 (NF-017) |
| Ratchet baseline | The debt file that may only decrease (`gate:repolint-debt`) | 16 |

### 6.3 Acceptance rules

1. A gate result is evidence only if its id, command and output are recorded in the D4 bundle.
2. A phase advances only when every gate in its checklist is *met*; `UNKNOWN` blocks the phase (fail-closed, §2.3).
3. Regressions are attributed to the phase that introduced them; the fix is a deliverable of that phase, not of the current one (R25.3).
4. The roadmap is reviewed per phase, and §8 is updated in the same change as any phase decision.
5. A capability may be demoted without ceremony when its evidence is withdrawn; raising requires the bundle.

---

## 7. Metric definitions

Any number in a status line or a demo must be defined by four lines, in this order: **counts what**, **from which anchor**, **over which population**, and **excluding what** (the discipline is inherited from NF-050).

| Metric | counts what | anchor | population | excludes |
|---|---|---|---|---|
| Gate pass | gates whose recorded result is *met* | the phase commit | all gates in the phase checklist | gates recorded `UNKNOWN` |
| Receipt coverage | mutating operations with a declared observation path | the shipped tool/operation registry | all mutating operations reachable from a surface | read-only operations |
| Prefix stability | `(provider, model, config)` tuples whose prefix digest matches its pin | the compiled request | the declared supported matrix | unsupported/trial tuples |
| Parity reach | Section A rows reachable from a declared surface | the front-end manifest | all Section A dispositions ≠ `reject` | rows marked `reject` with a Section D reason |
| `UNKNOWN` age | wall-clock from `hz.effect.unknown` to `hz.effect.reconciled` | the event log | effects that reached `UNKNOWN` | effects still open at measurement time (reported separately) |

---

## 8. Open questions register

Two kinds of entry: **inherited** (created by a sibling document) and **roadmap-created** (created here). Blocking status is relative to the phase named.

### 8.1 Inherited — sources inspected

| # | Open question | Source | Owner-role | Blocking |
|---|---|---|---|---|
| OQ-I1 | **Universal read receipts.** The set receipts mutations universally and treats pure reads as un-receipted except where a read crosses the workspace boundary. If the threat model changes to require universal read receipts, the surface shapes of the API contract need revision. | `/data/home/forge/hzcode/docs/07-apis-and-contracts.md` “Open items owned by this document” | `kernel-owner` | Non-blocking for M1–M2; **blocking for the M2 claim that the evidence gate covers all surfaces** |
| OQ-I2 | Open items owned by `/data/home/forge/hzcode/docs/05-domain-and-schemas.md` (“Open items owned by this document”). | doc 05 | `spec-owner` | Contents owned by doc 05; not enumerated here |
| OQ-I3 | Open items created by `/data/home/forge/hzcode/docs/06-events-and-flows.md` §10.1. | doc 06 | `runtime-owner` | Contents owned by doc 06; not enumerated here |
| OQ-I4 | Open items owned by `/data/home/forge/hzcode/docs/07-apis-and-contracts.md`, other than OQ-I1. | doc 07 | `spec-owner` | Contents owned by doc 07; not enumerated here |
| OQ-I5 | Open items created by `/data/home/forge/hzcode/docs/12-sessions-state.md` §10.1. | doc 12 | `runtime-owner` | Contents owned by doc 12; not enumerated here |

**Disclosure.** Only the doc-07 item above was inspected in full text during the writing of this document; the other four are sections the set itself declares as open. This register claims no completeness beyond “these documents declare open items, and here is where they live.” Enumerating them is the owning document's job.

### 8.2 Roadmap-created

| # | Open question | Raised by | Owner-role | Blocking |
|---|---|---|---|---|
| OQ-R1 | **Phase-id reconciliation.** ~~Earlier drafts used `P0`–`P7`; the plan of record is `M0`–`M8`.~~ **Resolved by the spec owner**: the plan of record is `M0`–`M8`; the historical mapping was P0→M0 · P1+P3→M2 · P2→M1 · P4→M4 · P5→M5 · P6→M3 and M6 · P7→M7 and M8. `00-index.md` has been updated to describe this document as the `M0`–`M8` roadmap. | §1, §3 | `spec-owner` | **Closed** |
| OQ-R2 | **Dependency inversion:** `NF-019` (worktree pool) is scheduled in M5 while its declared dependency `NF-018` (managed domain) is scheduled in M8. M5 claims pool primitives only. | §3.6 | `kernel-owner` | Blocking for any `NF-019` status above `CODE_PRESENT` |
| OQ-R3 | **Partial claims must be enumerated:** `NF-015`, `NF-019`, `NF-023`, `NF-026`, `NF-031`, `NF-033`, `NF-039`, `NF-041`, `NF-042`, `NF-046`, `NF-048` and `NF-049` each have a partial phase and a completion phase; the partial scope must name exactly which operations are in and which are out. | §4.2 | `runtime-owner` | Blocking for status lines on those features |
| OQ-R4 | Documents `17`–`23` have proposed titles only (§4.1); the gate implementations, evidence-bundle format and adversarial certification suite therefore have no owning document. | §4.1 | `spec-owner` | Blocking for M8-D6 (needs doc 22) and for the D4 bundle of every phase (needs doc 18) |
| OQ-R5 | The evidence-bundle format and the phase gate manifest are needed by §6 but are owned by no existing document (proposed doc 18). | §6.2 | `release-owner` | Blocking for D4 in every phase |

---

## 9. Status

**Every phase in this document: `DESIGNED` as a plan; no phase has formally exited.** **Implementation status (final audit, 2026-11-06):** code now exists for slices of M0/M1/M2 territory (kernel, runtime loop, tools, chat TUI, skills/subagents, code mode, preview — see `28-implementation-status.md`) built *outside* the phase protocol of §6.1: no gate in §3 has been run and no evidence bundle exists, so every phase deliverable, gate and artifact named here remains unmet until its checklist is executed.

| Item | Level | Evidence |
|---|---|---|
| Roadmap M0–M8 | `DESIGNED` | This document, §3 |
| Phase exit criteria / gate checklists | `DESIGNED` | §3; gate names from `/data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 |
| Feature index (`NF-001`…`NF-050`) | `DESIGNED` | §4.2; definitions owned by `24-feature-catalog.md` §5 |
| ADR index | `DESIGNED` | §4.3; decisions owned by `/data/home/forge/hzcode/docs/02-decisions.md` |
| Document ownership map (`03`–`23`) | `DESIGNED` | §4.1; `17`–`23` unratified |
| Glossary | `DESIGNED` | §5; definitions owned by the cited documents |
| Test plan / acceptance harness | `DESIGNED` | §6 |
| Metric definitions | `DESIGNED` | §7 |
| Open questions register | `DESIGNED` | §8 |
| Every capability in every sibling document | `DESIGNED` (the implemented subset carries real levels in `28-implementation-status.md`) | `/data/home/forge/hzcode/docs/28-implementation-status.md` |

A claim above `DESIGNED` in this document, without a named artifact, is a defect and `gate:doc-status` must fail on it.

---

## 10. Related documents

| Document | Relationship |
|---|---|
| `/data/home/forge/hzcode/docs/00-index.md` | Reading order and the status ladder; phase-description staleness resolved (OQ-R1 closed — the index now says `M0`–`M8`) |
| `/data/home/forge/hzcode/docs/_conventions.md` | Names, packages, crates, capability IDs, events, schemas, status levels, writing rules; §11 rulings are binding here |
| `/data/home/forge/hzcode/docs/01-vision-and-superset.md` | Why the product exists; the superset claim the parity ratchet measures |
| `/data/home/forge/hzcode/docs/02-decisions.md` | The 16 ADRs indexed in §4.3 |
| `/data/home/forge/hzcode/docs/24-feature-catalog.md` | Parity matrix (Section A), new features (Section B, `NF-001`–`NF-050`), gates (§3.5), rejections (§7) |
| `/data/home/forge/hzcode/README.md` | Product description |
| `/data/home/forge/hzcode/docs/11-authority-safety.md` | Guard, leases, receipts, sandbox, policy — the M2 core |
| `/data/home/forge/hzcode/docs/12-sessions-state.md` | Log, projections, claims, snapshots, time travel — the M1 core |
| `/data/home/forge/hzcode/docs/10-cognition.md` | Providers, context compiler, memory, compaction — the M4 core |
| `/data/home/forge/hzcode/docs/08-runtime.md` | Agent loop, subagents, teams, budgets — the M5 core |
| `/data/home/forge/hzcode/docs/14-surfaces.md` | Every surface and the canonical exit-code table (RC-5) — the M3 core |
| `/data/home/forge/hzcode/docs/16-operations.md` | Install, release integrity, observability, enterprise — the M7 core |
| `/data/home/forge/hzcode/docs/28-implementation-status.md` | Implementation levels and evidence for everything built today — the single source of truth for status |
| `/data/home/forge/hzcode/docs/29-final-audit.md` | Final deep audit: twelve-repo completeness pass, merged/unique findings, optimization analysis, docs-staleness ledger |

**Derivation.** `source: /data/home/forge/hzcode/docs/_conventions.md` (names, status ladder, RC-1…RC-8); `source: /data/home/forge/hzcode/docs/24-feature-catalog.md` §3.5 (gate names), §4 (parity rows), §5 (feature definitions); `source: /data/home/forge/hzcode/docs/02-decisions.md` §1 (ADR table); `source: /data/home/forge/hzcode/docs/00-index.md` (document order). Phase ordering and the `M0`–`M8` naming are this document's own decision, made in the same change that records it in §8 OQ-R1.


