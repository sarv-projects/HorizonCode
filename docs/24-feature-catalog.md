# 24 — Feature Catalog

> **THE definitive feature catalog.** Every user-visible capability of every reference agent, mapped to a HorizonCode disposition; every capability HorizonCode adds beyond the references; the counts; and the features we explicitly reject.

---

## 1. Purpose

This document decides four things, and nothing else:

1. **What parity means, per reference agent.** For each of the eight primary references (A.1–A.8), every user-visible capability is enumerated in a table with a disposition (`Inherit` / `Supersede` / `Reject`) and a HorizonCode home; the six second-wave sources are recorded in the A.9 addendum, one `CapabilityRecordV1` row per source.
2. **What is new.** Every capability HorizonCode adds that no reference has is registered here with an ID (`NF-001` …), its problem, its design, the capability IDs it needs, its authority impact, its dependencies and its status.
3. **The counts.** How many capabilities are inherited, superseded, new and rejected, so "superset" is a number and not a slogan.
4. **What is deliberately not built,** with a reason, so that a future contributor does not re-litigate a settled decision by accident.

**Why the sections are lettered.** The house template in [`_conventions.md`](./_conventions.md) mandates the section order *Purpose · Rules · Interfaces · Data · Errors · Flows · Security · Performance · Tests · Status*. A catalog is data-dominant, so the template's **Data** section is expanded into the lettered sections **A** (parity matrices), **B** (new features), **C** (counts) and **D** (non-goals), and the remaining template sections follow them. No template section is omitted.

**Status of everything here.** This directory contains a **specification**, not code. Every HorizonCode capability in this catalog is at status **`DESIGNED`**, which is the lowest level in `_conventions.md` §8. Where a disposition depends on a capability that exists upstream, the *upstream* is cited by absolute path and is not a HorizonCode evidence claim. **No row in this catalog may be upgraded above `DESIGNED` on the strength of this document.** Upgrades require code, wiring and tests, in that order. **Implementation status (final audit, 2026-11-06):** rows remain specification claims, but where a row's capability has a working, tested slice in v0.1 (kernel guard/receipts, runtime loop, ten tools, TUI, skills/subagents, code mode, preview), the real level and evidence are maintained in [`28-implementation-status.md`](./28-implementation-status.md) — the single source of truth — not in this table.

**Document ownership.** The set is documents `00`–`30`; `00`–`16` and `24`–`30` exist, `17`–`23` remain unassigned (§13 gap 1). `_conventions.md` §5 carries 34 canonical + 16 Reserved capability IDs, §6 44 canonical + 17 Reserved event names, §11 **RC-1…RC-15**. The §3.3/§3.4 lists are Registered as Reserved (RC-11) and are promoted on first implementation.

---

## 2. Rules

Each rule is individually testable. `MUST`/`MUST NOT` are hard.

1. **R1 — Completeness.** Every user-visible capability of every reference agent listed in §4 Section A MUST appear in exactly one row. A capability that is present in a reference and absent from the table is a spec defect.
2. **R2 — Disposition is closed.** The disposition cell MUST be exactly one of `Inherit`, `Supersede`, `Reject`. No "partial", no "TBD". A capability that is partly kept and partly refused is `Supersede`, and the refusal MUST be explained in §7 Section D.
3. **R3 — Reject needs a reason and a replacement.** A `Reject` row MUST state why, and MUST point at the HorizonCode capability that covers the user need, or state that the need is out of scope by decision (see §7 Section D).
4. **R4 — Home is concrete.** The home cell MUST name at least one of: a capability ID from `_conventions.md` §5 (or a §3-proposed addition), a tool name, a `@horizoncode/*` package or `hz_*` crate, or an event name from `_conventions.md` §6. "The kernel" is not a home.
5. **R5 — IDs are stable.** A new feature's `NF-###` ID is permanent. It is never reused, never renumbered and never retired; a withdrawn feature keeps its row and gains `Status: WITHDRAWN` plus the superseding ID.
6. **R6 — Authority impact is declared for every new feature.** The value MUST be one of `none`, `narrows`, `grant-bearing`, `kernel`. Any feature the learning loop touches MUST be `none` (ADR-010). A learning-loop feature with any other value fails review.
7. **R7 — Status discipline.** Every new feature is `DESIGNED` at most, until code exists. A feature whose status line is absent is a spec defect.
8. **R8 — Citations are absolute and upstream-honest.** Every "where it exists" cell MUST contain an absolute path under `/data/home/forge/repo-tour/`. Where a path or behaviour is known only from a secondary document, the row MUST say so (`source: HANDOFF.md`).
9. **R9 — The matrix is the ratchet input.** Section A is machine-consumable (see §3) and is the input to `gate:parity-ratchet`. A PR that removes a mapped capability, or that lowers a disposition, fails the gate.
10. **R10 — No capability without a catalogue entry.** A tool, plugin, or surface feature that cannot be described by an existing row MUST add a row here in the same change.
11. **R11 — Non-goals are load-bearing.** §7 Section D is normative. Re-adding a rejected feature requires a new ADR in `02-decisions.md`, not a code change.
12. **R12 — Counts are derived, never typed.** §6 Section C counts MUST be computed from the tables (mechanically where practical) and MUST agree with them; a hand-maintained number is a defect.

---

## 3. Interfaces

### 3.1 `CapabilityRecordV1` [planned]

The machine-readable unit of Section A. One record per table row.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Stable row id, `<agent>.<slug>`, e.g. `opencode.event-sourced-core`. |
| `agent` | `enum` | `horizoncode` \| `opencode` \| `codex` \| `grok_build` \| `reasonix` \| `oh_my_pi` \| `forgecode` \| `claude_code`. |
| `capability` | `string` | Human name as it appears in the table. |
| `upstream` | `string[]` | Absolute paths or module names in the reference. |
| `upstream_note` | `string?` | `source: <doc>` when the evidence is secondary. |
| `disposition` | `enum` | `inherit` \| `supersede` \| `reject`. |
| `home` | `string[]` | Capability IDs, tool names, packages/crates, event names. |
| `new_features` | `string[]` | `NF-###` ids that carry the disposition. |
| `status` | `enum` | `DESIGNED` \| `CODE_PRESENT` \| `WIRED` \| `TESTED` \| `VERIFIED` \| `RELEASED`. `DESIGNED` for every row today. |

### 3.2 New-feature record (`NF-###`)

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `NF-001` … |
| `name` | yes | Short, stable. |
| `problem` | yes | What breaks without it. |
| `design` | yes | How it works; the mechanism, not a slogan. |
| `capability_ids` | yes | From `_conventions.md` §5 or §3.3 below. |
| `authority_impact` | yes | `none` \| `narrows` \| `grant-bearing` \| `kernel`. |
| `dependencies` | yes | Other `NF-###`, packages, crates, gates, ADRs. |
| `status` | yes | `DESIGNED` today. |

### 3.3 Proposed capability-ID additions [planned] — for `_conventions.md` §5

Registered as Reserved in `_conventions.md` §5 (RC-11); each is promoted to canonical in the change that first implements its feature.

| Proposed ID | Effect class | Used by |
|---|---|---|
| `index.query` | `read-only` | NF-042 repo intelligence, `indexd` |
| `receipt.read` | `read-only` | NF-002 evidence gate, `hzcode session verify` |
| `sandbox.probe` | `read-only` | NF-016 guarantee vectors |
| `tool.discover` | `read-only` | NF-038 deferred tool discovery |
| `workflow.run` | `process` | NF-012 workflow engine |
| `notify.emit` | `external-effect` | NF-028 notifications |
| `collab.manage` | `network` | NF-030 collaboration |
| `enterprise.policy.read` | `read-only` | NF-031 managed policy |
| `plugin.install` | `external-effect` | NF-032 plugin marketplace |
| `voice.io` | `process` | NF-040 voice |
| `media.render` | `process` | NF-040 out-of-process Mermaid/chart |
| `browser.control` | `external-effect` | `browse` / `computer` tools |
| `learn.run` | `read-only` | NF-010, NF-033, NF-034, NF-035 — authority impact `none` |
| `learn.propose` | `workspace-write` | NF-010 proposals — authority impact `none` |
| `debug.record` | `process` | NF-054 execution recorder |
| `preview.serve` | `process` | NF-055 preview environments |

### 3.4 Event additions — registered as Reserved names (RC-11)

The following are **Reserved names** in [`_conventions.md`](./_conventions.md) §6: usable only with `[planned]`, promoted to canonical in the change that first implements their feature.

`hz.workflow.started` · `hz.workflow.completed` · `hz.notify.raised` · `hz.collab.presence.changed` · `hz.budget.exceeded` · `hz.sandbox.guarantee.assessed` · `hz.sandbox.residual.reported` · `hz.egress.denied` · `hz.index.updated` · `hz.bridge.attached` · `hz.learn.proposal.reviewed` · `hz.tool.discovered` · `hz.trust.record.appended` · `hz.session.instructions.updated` · `hz.preview.started` · `hz.preview.stopped` · `hz.debug.recording.captured`.

**Withdrawn:** the earlier drafts' `hz.receipt.unknown` / `hz.receipt.reconciled` are not names; the canonical events for those facts are `hz.effect.unknown` / `hz.effect.reconciled` (RC-11).

### 3.5 CI gates referenced by this catalog

Gates are named once here and used by `25-roadmap-and-glossary.md`. Each is a ratchet unless stated.

| Gate | Fails when |
|---|---|
| `gate:parity-ratchet` | A Section A row's capability is unreachable from a surface, or a disposition regresses. |
| `gate:cache-guard` | The compiled prompt prefix drifts for a `(provider, model, config)` tuple (ADR-009). |
| `gate:layering` | A package/crate imports against the layering law. |
| `gate:frontend-parity` | A capability edge reaches one front-end but not another. |
| `gate:file-size` / `gate:function-size` | Debt above the frozen baseline; baseline may only decrease. |
| `gate:wire-parity` | A wire schema is edited in two places, or a protocol type lacks one generated owner. |
| `gate:sensitive-path-coverage` | A path declared `sensitive:` is not covered by a test that proves it. |
| `gate:boundary-test` | A new caller of a one-primitive boundary appears (subagent construction, effect submission, event append). |
| `gate:tool-declaration` | A tool lacks a full declaration (schema, effect class, capability ID, renderers, idempotency). |
| `gate:receipt-coverage` | A mutating tool has no declared observation path (ADR-012). |
| `gate:no-unknown-retry` | Code retries an `UNKNOWN` automatically. |
| `gate:kernel-pin` | The kernel asset digest/manifest is not pinned or is stale. |
| `gate:cross-plane-abi` | The TS side does not fail closed on a missing or older native ABI (ADR-002). |
| `gate:doc-status` | A document claims a status level above its evidence. |
| `gate:dead-lane-fail-closed` | A disabled lane reports success instead of failing closed. |
| `gate:provenance` | Inherited code lacks an upstream pin or NOTICE entry (ADR-014). |
| `gate:repolint-debt` | Ratchet debt increases. |

---

### 3.6 Ratified rulings that bind this document

[`_conventions.md`](./_conventions.md) §11 carries fifteen cross-document rulings ratified after this catalog was first drafted. They are binding here, and each one is reflected in Section A or Section B:

| Ruling | Effect on this catalog |
|---|---|
| RC-1 — `hz.session.moved` is canonical | A.1 session rename/move cites `hz.session.moved`; a re-home emits it in the destination log with the same session id. |
| RC-2 — plugin load/unload and MCP connect/discovery are **not** events | A.5's plugin-API row and NF-043/NF-032 rely on `plugins.invoke` plus `hz.step.tool.*`/`hz.error.raised` (class `plugin`, `mcp`); they must not invent registry events. |
| RC-3 — log snapshots, retention markers and worktree/schedule journals are storage/kernel metadata | NF-017 and NF-026 record them as `OwnerLog` records referenced by digest; `hzcode worktree list --journal` exposes them for audit. |
| RC-4 — cancelled-attempt usage is `hz.usage.recorded` with `attribution.stepId` | NF-025's accounting must use it; no separate credit event. |
| RC-5 — canonical exit codes are owned by `docs/14-surfaces.md` §3.2 (S16) | §12's NF-036 exit-code test **references** that table; it does not restate it. |
| RC-6 — a policy `deny` never emits `hz.permission.asked` | §8.2's failure-mode table and NF-003/NF-014 emit `hz.effect.decision.made` for a deny; `asked` exists only where an answer could change the outcome. |
| RC-7 — one terminal-state enum for effects | NF-001 and NF-036 use it verbatim; `UNKNOWN` is a terminal state, never a synonym for failure. |
| RC-8 — cache-guard prefix pins live at `packages/context/test/golden/prefix/<family>.sha256` | NF-005 and NF-034 name that location and the `--update-golden` review path. |
| RC-9 — the feature-flag registry is owned by `docs/07-apis-and-contracts.md` §4.1.5 | NF-006's surface negotiation uses flags; none are declared here. |
| RC-10 — `hz.provider.account.rotated` and `hz.memory.expired` are canonical events | NF-024 cites `hz.provider.account.rotated`; NF-008 cites `hz.memory.expired`. Both are in §6, not Reserved. |
| RC-11 — `hz.receipt.unknown` / `hz.receipt.reconciled` are withdrawn; the §3.3/§3.4 additions are **Reserved** names | §3.3 and §3.4 now register their lists in `_conventions.md` §5/§6 as Reserved; every `[planned]` marker in Section A/B references a Reserved name, never a canonical one. |
| RC-12 — the second learning pass is ratified | Section B's `NF-051`…`NF-062` are the ratified register; the reserved coinages they use stay `[planned]` until implemented (RC-11). |
| RC-13 — implementation status is owned by `docs/28-implementation-status.md` | Every status cell in this catalog is a specification claim; implemented v1 slices carry levels only in doc 28. |
| RC-14 — document classes and authority-by-concern | This catalog is a **contract-class** document; `26`/`29`/`30` and `audit/` are historical and carry no normative force. |
| RC-15 — the adoption wave is ratified | Section A gains the A.9 addendum; Section B gains `NF-071`…`NF-075`; the Part D insertions are folded into their owner documents. |

---

## 4. Section A — Capability parity matrix

Conventions for every table below:

- **Disposition** is one of `Inherit` (same capability, re-expressed on the HorizonCode substrate), `Supersede` (the capability is kept *and* strengthened — the superseding `NF-###` is named), `Reject` (not built; reason in §7 Section D).
- **HorizonCode home** names capability IDs (`_conventions.md` §5), tools, packages (`@horizoncode/*`), crates (`hz_*`) and events (`_conventions.md` §6). Proposed additions from §3.3/§3.4 are marked `[planned]`.
- Every upstream path is absolute. Where the path is quoted from a secondary document rather than read from the tree, the row says `source: HANDOFF.md`.
- **Status:** every row is `DESIGNED`. The upstream column is evidence about the *reference*, not about HorizonCode.

### A.1 opencode — event-sourced core and Code Mode

`source: /data/home/forge/repo-tour/opencode` (dev branch, v2.2.5) and `docs/audit/pass2/opencode-report.part1.md` … `part3.md`.

| Capability | Where it exists in opencode | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| Event-sourced core: durable events + projectors in one transaction, per-aggregate monotonic sequence | `/data/home/forge/repo-tour/opencode/packages/core/src/bus.ts`; schema authority `/data/home/forge/repo-tour/opencode/packages/schema/src/durable-event-manifest.ts` | Supersede | ADR-004; `@horizoncode/core`; events `hz.session.created`, `hz.part.created`; kernel `OwnerLog` (`crates/hz_kernel`, `owner_log.rs`) for authority-side facts; NF-009 |
| Admission before execution: durable inbox, `steer` vs `queue`, control items | `/data/home/forge/repo-tour/opencode/packages/core/src/session/inbox.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/session/prompt.ts`, `/data/home/forge/repo-tour/opencode/specs/v2/session.md` | Supersede | `@horizoncode/core`; event `hz.session.prompt.admitted`; NF-001 (receipt on admission), NF-045 |
| Write-ahead execution claim; claim survives shutdown, released only by a terminal | `/data/home/forge/repo-tour/opencode/packages/core/src/session/execution.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/session/execution/restart.ts` | Supersede | events `hz.session.claim.acquired` / `hz.session.claim.released`; `crates/hz_kernel` supervisor leases; reconciliation `hz.effect.reconciled`; NF-001, NF-049 |
| One `llm.stream` per step; no hidden in-memory tool loop | `/data/home/forge/repo-tour/opencode/packages/core/src/session/runner/step.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/session/runner/llm.ts` | Inherit | ADR-011; `@horizoncode/core`; events `hz.step.started`, `hz.step.llm.requested`, `hz.step.llm.completed` |
| Code Mode: confined program execution over a namespaced tool tree | `/data/home/forge/repo-tour/opencode/packages/codemode`, `/data/home/forge/repo-tour/opencode/packages/core/src/tool.ts` | Supersede | capability `codemode.execute`; tool `code_mode`; `crates/hz_kernel` (`codemode_protocol.rs`); NF-001 |
| Contract-separated ~40-package monorepo (`schema → core/protocol → server`; `client` never imports core/server; `sdk` composes) | `/data/home/forge/repo-tour/opencode/AGENTS.md`, `/data/home/forge/repo-tour/opencode/packages/` | Supersede | `@horizoncode/*` packages; `gate:layering`; NF-047; ADR-002 |
| Worktree tools (`worktree_create` / `_list` / `_remove`) | `/data/home/forge/repo-tour/opencode/packages/core/src/tool/plugin/opencode.ts` | Supersede | capability `worktree.manage`; `crates/hz_kernel` (`worktree_pool.rs`, `worktree_lifecycle.rs`); NF-019, NF-015 |
| Plugin API with built-in registry, hooks and guarded plugins | `/data/home/forge/repo-tour/opencode/packages/core/src/plugin.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/plugin/internal.ts`, `/data/home/forge/repo-tour/opencode/packages/plugin` | Supersede | `@horizoncode/plugin`; capability `plugins.invoke`; NF-032, NF-043 |
| Generated SDK and clients from a single protocol source | `/data/home/forge/repo-tour/opencode/packages/httpapi-codegen`, `/data/home/forge/repo-tour/opencode/packages/client`, `/data/home/forge/repo-tour/opencode/packages/sdk` | Inherit | `@horizoncode/sdk`, `@horizoncode/sdk-python`, `-go`, `-rust`; `crates/hz_codegen`; `gate:wire-parity`; NF-006 |
| `models.dev` catalog (bundled snapshot + decoder) | `/data/home/forge/repo-tour/opencode/packages/core/src/models-dev.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/models-dev/snapshot.txt` | Inherit | `@horizoncode/provider`; capability `models.list`; NF-044, NF-050 |
| Image generation tool | `/data/home/forge/repo-tour/opencode/packages/core/src/tool/plugin/image-generate.ts` | Inherit | tool `generate_image`; capability `providers.infer`; `@horizoncode/provider`; NF-040 |
| Session rename / move (re-home a session) | `/data/home/forge/repo-tour/opencode/packages/core/src/session/session.ts`, `/data/home/forge/repo-tour/opencode/packages/core/src/session/move.ts` | Inherit | capability `session.manage`; `@horizoncode/core`; event `hz.session.moved` (RC-1) |
| Artifacts (`artifact_create` / `_read` / `_update` / `_delete`) | `/data/home/forge/repo-tour/opencode/packages/core/src/tool/plugin/artifact.ts` | Supersede | capability `artifact.write`; tools `artifact_*`; `hz://artifact/<sha256>`; NF-027 |
| Schedule tools (`schedule_create` / `_list` / `_pause` / `_resume` / `_delete`) | `/data/home/forge/repo-tour/opencode/packages/core/src/tool/plugin/schedule.ts` | Supersede | capability `schedule.manage`; `@horizoncode/core`; NF-012, NF-028 |

**A.1 status:** all rows `DESIGNED`.

### A.2 codex — sandbox depth, policy-as-code, three surfaces

`source: /data/home/forge/repo-tour/codex` (tour commit `ddd1812a`) and `docs/audit/pass2/codex-report.md`.

| Capability | Where it exists in codex | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| Per-OS sandbox: Seatbelt `.sbpl` profiles (macOS), Landlock + bwrap + seccomp + PID namespace (Linux), AppContainer/WFP + service (Windows); scratch/TLS variants; denial & violation reporting | `/data/home/forge/repo-tour/codex/codex-rs/sandboxing/src/seatbelt.rs`, `.../landlock.rs`, `.../bwrap.rs`, `.../linux_pid_namespace.rs`, `.../windows.rs`, `.../windows_mxc.rs`, `.../denial.rs`, `.../violation.rs`; `/data/home/forge/repo-tour/codex/codex-rs/linux-sandbox/src/seccomp.rs` | Supersede | `crates/hz_sandbox`; capability `terminal.run`; events `hz.sandbox.guarantee.assessed` `[planned]`, `hz.sandbox.residual.reported` `[planned]`; NF-016 |
| Starlark `execpolicy` prefix engine for command decisions | `/data/home/forge/repo-tour/codex/codex-rs/execpolicy/src/lib.rs`; `/data/home/forge/repo-tour/codex/docs/execpolicy.md` | Supersede | `crates/hz_policy`; ADR-007; capability `terminal.run`; NF-003 |
| Network proxy / egress control with network policy decisions | `/data/home/forge/repo-tour/codex/codex-rs/network-proxy`, `/data/home/forge/repo-tour/codex/codex-rs/core/src/network_policy_decision.rs` | Supersede | capability `net.fetch`; event `hz.egress.denied` `[planned]`; NF-021 |
| app-server JSON-RPC surface + daemon + transport bridging + tunnels | `/data/home/forge/repo-tour/codex/codex-rs/app-server/src/{message_processor.rs,transport.rs}`, `/data/home/forge/repo-tour/codex/codex-rs/app-server-daemon`, `/data/home/forge/repo-tour/codex/codex-rs/app-server-protocol/src/rpc.rs`, `/data/home/forge/repo-tour/codex/codex-rs/tcp-tunnel` | Supersede | `@horizoncode/server`, `@horizoncode/protocol`; `hz://`… via protocol revision `HZ_PROTO=1`; NF-006, NF-020 |
| Rollout persistence (JSONL transcripts) + reduced-state tracing/replay bundles | `/data/home/forge/repo-tour/codex/codex-rs/rollout/src/lib.rs`, `/data/home/forge/repo-tour/codex/codex-rs/rollout-trace` | Supersede | `@horizoncode/core`; events `hz.session.checkpoint.created`, `hz.session.rewound`; NF-026, NF-009 |
| MCP **client** (connection manager, pooling, OAuth/EMA, catalog, resources, apps, pagination) | `/data/home/forge/repo-tour/codex/codex-rs/codex-mcp/src/{connection_manager.rs,catalog.rs,auth.rs}`, `/data/home/forge/repo-tour/codex/codex-rs/rmcp-client` | Inherit | `@horizoncode/mcp`; capability `mcp.invoke`; ADR-006 |
| MCP **server** (expose the agent to other agents) | `/data/home/forge/repo-tour/codex/codex-rs/codex-mcp/src/server.rs`, `/data/home/forge/repo-tour/codex/codex-rs/message-board-mcp` | Inherit | `@horizoncode/mcp` server mode; ADR-006; NF-006; `mcp-server` posture |
| Code mode on embedded V8 (JS tool orchestration), out-of-process host | `/data/home/forge/repo-tour/codex/codex-rs/code-mode`, `.../code-mode-host`, `.../code-mode-runtime`, `.../v8-poc` | Supersede | capability `codemode.execute`; tool `code_mode`; `crates/hz_kernel`; NF-015, NF-001 |
| Guardian extensions — automated safety/review passes over model output (v2/v3) | `/data/home/forge/repo-tour/codex/codex-rs/ext/guardian-reviewer`, `.../ext/guardian-v2`, `.../ext/guardian-v3`, `/data/home/forge/repo-tour/codex/codex-rs/core/src/guardian/` | Supersede | capability `providers.infer` (advisor model path); tools `review`, `security_scan`; NF-002 (evidence gate, adjudication not prose); NF-028 |
| `unified_exec` — process manager, command sessions, async watcher, stdin approval, shell snapshot | `/data/home/forge/repo-tour/codex/codex-rs/core/src/unified_exec/`, `.../core/src/tools/handlers/unified_exec.rs` | Supersede | tool `shell` / `shell_session`; capability `terminal.run`, `terminal.pty`; `crates/hz_pty`; NF-001 |
| `view_image` (image preparation and visual input) | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/view_image.rs`, `.../core/src/image_preparation.rs` | Inherit | tool `view_image`; capability `files.read`; `crates/hz_native`; NF-040 |
| `web_search` (hosted + remote search) | `/data/home/forge/repo-tour/codex/codex-rs/ext/web-search`, `.../core/src/tools/handlers/tool_search.rs`, `/data/home/forge/repo-tour/codex/codex-rs/codex-api/src/search.rs` | Inherit | tool `web_search`; capability `net.search`; NF-021 (egress-typed) |
| `update_plan` — plan as durable tool state | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/plan.rs`, `/data/home/forge/repo-tour/codex/codex-rs/prompts/src/update_plan_instructions.rs` | Supersede | tool `todo` / `update_goal`; events `hz.plan.updated`, `hz.todo.updated`, `hz.goal.updated`; NF-045 |
| `request_user_input` — structured questions to the client | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/request_user_input.rs` | Inherit | tool `ask_user`; capability `ui.present`; event `hz.permission.asked`; NF-045 |
| `request_permissions` — the model asks for an approval | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/request_permissions.rs`, `.../core/src/tools/approvals.rs`, `.../core/src/tools/network_approval.rs` | Supersede | Guard `ask` → `GuardDecisionV1`, one-use lease; events `hz.permission.asked` / `hz.permission.answered`; NF-001, NF-003, NF-014 |
| `tool_search` — deferred tool discovery | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/tool_search.rs`, `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/tool_namespaces_info.rs` | Supersede | tool `tool_search`; capability `tool.discover` `[planned]`; event `hz.tool.discovered` `[planned]`; NF-038 |
| `multi_agents` — agent roles, graph store, message board | `/data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/multi_agents.rs`, `.../multi_agents_v2.rs`, `.../codex-rs/agent-graph-store`, `.../codex-rs/agent-message-board-host`, `.../codex-rs/utils/message-board` | Supersede | tools `task`, `fleet`, `send_message`, `wait`; capability `agent.spawn`; events `hz.agent.spawned`, `hz.agent.message.sent`; ADR-016; NF-007, NF-014, NF-030 |
| SQLite state + log DB, NFS migration, `logs_client` | `/data/home/forge/repo-tour/codex/codex-rs/state/src/{sqlite.rs,log_db.rs,migrations.rs}`, `/data/home/forge/repo-tour/codex/codex-rs/cli/src/{state_db_recovery.rs,migrate_nfs_db.rs}` | Supersede | `@horizoncode/core`; ADR-004; `hzcode session reindex`; NF-026 |
| Cloud tasks (vendor-hosted remote task queue and its client) | `/data/home/forge/repo-tour/codex/codex-rs/cloud-tasks`, `.../cloud-tasks-client` | Supersede | re-scoped: remote execution on machines *you* own — capability `remote.exec`; NF-020; the vendor-hosted queue itself is rejected (§7 D-4) |

**A.2 status:** all rows `DESIGNED`.

---

### A.3 grok-build — the TUI as the product

`source: /data/home/forge/repo-tour/grok-build` and `docs/audit/pass2/grok-build-report.md`.

| Capability | Where it exists in grok-build | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| Fullscreen alternate-screen TUI with deep mouse interaction (click-to-focus, scrollbars, drag-select, double-click select, hit-tests against cached rects, capture re-assertion after ConPTY relays) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager/src/app/event_loop.rs`, `.../src/app/mouse.rs`, `.../src/app/app_view.rs`; alt-screen policy `.../xai-grok-pager-render/src/terminal/mod.rs` | Inherit | `@horizoncode/tui`, `@horizoncode/ui`; capability `ui.present`; ADR-001; NF-029 |
| Scrollback-native "minimal" / inline mode as a first-class alternate render path, switchable by process relaunch (`--minimal` xor `--fullscreen`, `--no-alt-screen`) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager-minimal`, `.../xai-ratatui-inline`, `.../xai-grok-pager/src/app/screen_mode_relaunch.rs`, `.../src/app/cli.rs` | Inherit | `@horizoncode/tui` inline renderer; NF-029 |
| Shared leader process (single-instance, flock) + client-side ACP replay after a leader crash | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs`, `.../xai-grok-shell/src/agent/app.rs` | Supersede | `@horizoncode/acp`; `@horizoncode/server`; capability `session.manage`; event `hz.bridge.attached` `[planned]`; NF-037, NF-006, NF-049 |
| Computer Hub / workspace server — expose a workspace to remote clients; standalone `workspace_server` binary for remote sandboxes | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-workspace/src/{lib.rs,hub.rs,hub_server.rs,hub_channel.rs}`, `.../src/bin/workspace_server.rs`, `/data/home/forge/repo-tour/grok-build/crates/common/xai-computer-hub-{core,sdk,mcp-adapter}` | Supersede | capability `remote.exec`; `@horizoncode/server`; NF-020, NF-021, NF-010 |
| Rhai workflow engine — scripts orchestrate agents through a host channel | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-workflow`, `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/workflow/mod.rs` | Supersede | `@horizoncode/workflow`; capability `workflow.run` `[planned]`; tool `workflow`; event `hz.workflow.started` `[planned]`; NF-012, NF-043 |
| "Dream" memory consolidation (batch, locked, scheduled) with MMR-diverse retrieval and embeddings | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-memory/src/{dream.rs,batch_dream.rs,mmr.rs,embedding.rs,search.rs}` | Supersede | `@horizoncode/context`; capabilities `memory.read` / `memory.write`; events `hz.memory.retained`, `hz.memory.recalled`; NF-008, NF-010 |
| Scheduler with an occurrence journal (recurring automations that survive restarts) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build/scheduler/{create.rs,delete.rs,list.rs}` | Supersede | capability `schedule.manage`; tool `schedule`; `@horizoncode/core`; NF-012, NF-028 |
| Voice dictation — streaming STT in a re-exec'd capture subprocess | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-voice/src/{pipeline.rs,transcriber.rs,stt/}`, `.../xai-grok-pager-bin/src/main.rs` | Inherit | capability `voice.io` `[planned]`; tools `stt`, `tts`; `crates/hz_voice`; NF-040 |
| In-process OS sandbox via `nono` (Landlock/Seatbelt) applied once at startup + per-child seccomp network blocking + write-deny/read-deny verification | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-sandbox/src/{lib.rs,profiles.rs,child_net.rs,hook_write_deny.rs,read_deny_verify.rs}`, applied at `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs` | Supersede | `crates/hz_sandbox`; NF-016; ADR-003 (confinement belongs to the kernel, not the agent process) |
| Signed, cached managed policy with a pre-sandbox policy heal and startup requirements validation | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-config/src/{signed_policy.rs,remote_settings.rs}`, `.../managed_cache/`, `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-cloud-config` | Supersede | `@horizoncode/core`; capability `enterprise.policy.read` `[planned]`; ADR-008; NF-031 |
| Claude-settings import (permissions, hooks, MCP servers, env vars, skill and rule directories) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-external-agent-migration` | Inherit | `@horizoncode/cli` import command; NF-031 (imported settings may only narrow) |
| Out-of-process Mermaid rendering (crash isolation because shipped profiles use `panic = "abort"`) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-mermaid/src/lib.rs`, `.../third_party/mermaid-to-svg` | Inherit | capability `media.render` `[planned]`; NF-040 |
| Hashline-anchored editing variant (`hashline_read` / `hashline_grep` / `hashline_edit`) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/{anchor.rs,edit/,read_file.rs,grep.rs,mutate.rs}` | Supersede | tools `edit`, `multi_edit`, `patch`; capability `files.patch`; `crates/hz_edit`; NF-040 (native stack), `gate:receipt-coverage` |
| In-tree ports of codex and opencode tool sets with Apache §4(b) change notices | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-tools/src/implementations/codex/`, `.../implementations/opencode/`, `.../xai-grok-tools/THIRD_PARTY_NOTICES.md` | Supersede | ADR-014; NF-048; `gate:provenance` |
| `/gboom` raycaster easter egg | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-gboom` | Reject | §7 D-5 — no capability value; surface noise in a tool that must be auditable |
| Ergonomics: `wrap` (PTY forwarder with OSC 52 clipboard), `du` (home disk usage), `doctor` (terminal/clipboard/colour diagnostics with fixes) | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager/src/app/cli.rs`, `.../xai-grok-pager-bin/src/main.rs` | Inherit | `@horizoncode/cli` `wrap` / `du` / `doctor`; ADR-008 trust diagnostics |

**A.3 status:** all rows `DESIGNED`.

### A.4 DeepSeek-Reasonix — one Controller, cache discipline, ratchets

`source: /data/home/forge/repo-tour/DeepSeek-Reasonix` (commit `b1106b9`, branch `studio`) and `docs/audit/pass2/DeepSeek-Reasonix-report.md`.

| Capability | Where it exists in Reasonix | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| One transport-agnostic `Controller` behind four front-ends (CLI/TUI, HTTP+SSE serve, Electron Studio, ACP) | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/session/control/` (`controller.go`, `approval*.go`), frontends `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/{cli,tui,serve,acp}` | Supersede | `@horizoncode/core` `Controller`; ADR-005; NF-006 |
| Front-end parity ratchet — a bespoke linter counts capability edges per front-end and fails a missing one | `/data/home/forge/repo-tour/DeepSeek-Reasonix/tools/repolint` (frontend-parity) | Supersede | `gate:frontend-parity`, `gate:parity-ratchet`; NF-006 |
| Layering law: a package's directory *is* its dependency rank (`base 0 · contract 1 · safety 2 = state 2 · model 3 · platform 4 · ext 5 = tools 5 · runtime 6 · session 7 · assembly 8 · frontend 9`) | `/data/home/forge/repo-tour/DeepSeek-Reasonix/tools/repolint/layers.go` | Supersede | `gate:layering`; `_conventions.md` §3/§4 package and crate ranks; NF-047, NF-015 |
| `repolint` ratchet suite: layering, layer-order, file-size (800), function-size, complexity, wire-parity, frontend-parity, doc-owner, orphan, stray-file; debt in `baseline.json` may only decrease | `/data/home/forge/repo-tour/DeepSeek-Reasonix/tools/repolint`, `.../baseline.json` | Supersede | `gate:file-size`, `gate:function-size`, `gate:wire-parity`, `gate:repolint-debt`, `gate:doc-status`; NF-047 |
| Cache-first architecture as a product guarantee: byte-stable prefix, projected turn tail, CI cache-guard | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/assembly/boot/context_projection_test.go`, `/data/home/forge/repo-tour/DeepSeek-Reasonix/docs/SPEC.md` §3.6 | Supersede | ADR-009; `@horizoncode/context`; `gate:cache-guard`; NF-005, NF-034 |
| Two-model coordination **without shared sessions** — planner in its own read-only session, executor in another, so neither prefix is disturbed | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/runtime/coordinator/` | Inherit | `@horizoncode/agents`; NF-004; ADR-009 |
| Deterministic host routing policy: `executor-only` / `light` / `full` / `plan-for-approval` / `plan-only`, chosen from raw user text by policy, never by a classifier model | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/runtime/taskpolicy`, `internal/runtime/coordinator`, `internal/session/control` (`approvedPlanAutoApproveTools`) | Supersede | `@horizoncode/agents`; NF-004, NF-045 |
| Sensitive-path coverage gate — a file declared `sensitive:` in `REASONIX.md` must be held to its test coverage | `/data/home/forge/repo-tour/DeepSeek-Reasonix/REASONIX.md`, `/data/home/forge/repo-tour/DeepSeek-Reasonix/tools/covergate` | Inherit | `gate:sensitive-path-coverage`; NF-047 |
| Trusted Host State — host-owned, content-addressed, hash-chained records for contracts, evidence bundles and capability rollout | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/state/trustedstate`, `.../internal/runtime/contract`, `.../docs/design/TRUSTED_EXECUTION.md` | Supersede | `crates/hz_kernel` receipts + OwnerLog; event `hz.trust.record.appended` `[planned]`; NF-017, NF-002 |
| Extension Protocol v2 (out-of-process code extensions, event interception, replacement slots, contributed providers and structured UI) with a generated schema/index and a Go SDK | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/ext/extension/{protocol/schema.generated.json,sidecar,dispatch,uihub}`, `/data/home/forge/repo-tour/DeepSeek-Reasonix/sdk/go`, `/data/home/forge/repo-tour/DeepSeek-Reasonix/cmd/extension-protocol-gen` | Supersede | `@horizoncode/plugin`; capability `plugins.invoke`; NF-043, NF-032 |
| Single static `CGO_ENABLED=0` binary, cross-compiled `darwin\|linux\|windows × amd64\|arm64` | `/data/home/forge/repo-tour/DeepSeek-Reasonix/Makefile`, `.../.goreleaser.yaml` | Inherit | `@horizoncode/cli`; `crates/hz_codegen`; NF-046 |
| Android `libreasonix.so` build (kernel cross-compiled into an APK serving the same SPA) | `/data/home/forge/repo-tour/DeepSeek-Reasonix/android/build.sh`, `.../build-kernel.sh` | Supersede | re-scoped: mobile supervision as a thin client of the server/web surface; NF-006, NF-046; the on-device kernel is rejected (§7 D-6) |
| Desktop as a **nested module** so its build needs cannot contaminate the CLI's static-binary guarantee | `/data/home/forge/repo-tour/DeepSeek-Reasonix/desktop/` (`module reasonix/desktop`, `replace reasonix => ../`) | Supersede | `@horizoncode/desktop` as a separate module against the published protocol; NF-046, NF-006 |
| Append-only vendor price table + `pricecheck` | `/data/home/forge/repo-tour/DeepSeek-Reasonix/internal/contract/pricing/rates.go`, `.../tools/pricecheck` | Inherit | `@horizoncode/provider`; NF-050, NF-025 |
| Metric-definition discipline — a benchmark number requires four lines (counts what, from which anchor, over which population, excluding what); defects require a reachability contract | `/data/home/forge/repo-tour/DeepSeek-Reasonix/docs/SPEC.md`, `/data/home/forge/repo-tour/DeepSeek-Reasonix/cmd/e2ebench` | Inherit | NF-041, NF-050; `25-roadmap-and-glossary.md` (metric definition) |

**A.4 status:** all rows `DESIGNED`.

### A.5 oh-my-pi — native capability stack and bidirectional ACP

`source: /data/home/forge/repo-tour/oh-my-pi` and `docs/audit/pass2/oh-my-pi-report.md`.

| Capability | Where it exists in oh-my-pi | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| ACP in **both** directions — `omp` as an ACP agent, and `omp` driving Cursor through a `cursor-agent` provider with external-tool handoff | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/modes/acp/{acp-agent.ts,acp-mode.ts}`, `.../src/cursor.ts`, `/data/home/forge/repo-tour/oh-my-pi/packages/ai/src/providers/cursor.ts`, `.../cursor-external-tool-handoff.md` | Supersede | `@horizoncode/acp`; `@horizoncode/provider` (`cursor-agent` codec); NF-037, NF-044 |
| Embedded bash 5.3 (plus a zsh dialect) compiled into Rust, over an injectable VFS, with in-process coreutils | `/data/home/forge/repo-tour/oh-my-pi/crates/pi-shell/src/lib.rs`, `.../pi-vfs/src/lib.rs`, `.../pi-builtins/src/lib.rs` | Supersede | `crates/hz_shell`, `hz_vfs` [planned], `crates/hz_native`; tool `shell`; operation `shell-session`; NF-015 |
| Native capability stack as **one** N-API addon with typed JS wrappers (walker/grep, edit, diff, VCS, AST, VFS, voice, predict, PTY, PDF/HTML→Markdown, SIXEL/SVG) | `/data/home/forge/repo-tour/oh-my-pi/crates/pi-natives/src/lib.rs`, `/data/home/forge/repo-tour/oh-my-pi/packages/natives` | Supersede | `crates/hz_native` + `hz_walker`, `hz_edit`, `hz_diff`, `hz_ast`, `hz_vcs`, `hz_shell`, `hz_pty`, `hz_voice`; ADR-002; `gate:cross-plane-abi`; NF-015 |
| Deep LSP — 14 operations (navigate, diagnostics, pull/refresh, format, watched files, workspace open, restart) | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/lsp/{client.ts,tool.ts,diagnostics.ts,edits.ts,format-options.ts,pull.ts,refresh.ts,restart.ts,watched_files.ts,workspace_open.ts}` | Supersede | tool `lsp`; capabilities `language.symbols`, `language.diagnostics`, `language.rename`; NF-042 |
| Deep DAP — 28 debug operations behind one `debug` tool | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts` (`debug`), `/data/home/forge/repo-tour/oh-my-pi/README.md` | Supersede | tool `debug`; capability `debug.session`; NF-042 |
| Autolearn capture agent — a detached, cache-prefix-preserving clone of the primary agent runs learning nudges without disturbing the run | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts` (`sdk.ts#L1779-L1912`) | Supersede | `@horizoncode/learn`; capability `learn.run` `[planned]`; authority impact **none**; NF-010, NF-033, NF-035 |
| Prewalk — automatic model downgrade after the first edit once a todo list exists | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/sdk.ts` (`sdk.ts#L682-L689`), `.../config/model-roles.ts` | Supersede | tool `todo`; NF-004; `gate:cache-guard` |
| Credential-affinity prompt-cache pinning + OAuth account pools (`promptCacheKey`, `providerSessionId`, `oauthAccountPools`) | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/credential-pin.ts`, `.../config/account-pools.ts`, `.../sdk.ts#L600-L617`, `.../sdk.ts#L2139-L2160` | Supersede | `@horizoncode/provider`; capability `providers.infer`; ADR-009; NF-024, NF-023 |
| Snapcompact — bitmap-frame context compression for vision-capable models | `/data/home/forge/repo-tour/oh-my-pi/packages/snapcompact` | Supersede | `@horizoncode/context`; event `hz.session.compacted`; NF-008, NF-005 |
| Multi-agent over an IRC bridge with a global agent registry | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/irc-bridge.ts`, `.../registry/agent-registry.ts` | Supersede | `@horizoncode/core` message bus; events `hz.agent.message.sent`; ADR-016; NF-007, NF-030 |
| Rich internal URL space (`omp://`, `agent://`, `skill://`, `memory://`, `security://`, `xd://` devices, `mcp://`, `ssh://`, `vault://`, …) | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/internal-urls/{router.ts,parse.ts}` | Supersede | `hz://` scheme (`_conventions.md` §1); NF-011; `@horizoncode/shared` |
| Whole-session-tree cost gate with per-root async job manager | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/session/cost-gate.ts`, `.../session/agent-session.ts` | Supersede | `@horizoncode/core` budgets; event `hz.budget.exceeded` `[planned]`; `hzcode session tree`; NF-025, NF-028, NF-045 |
| jsdiff-compatible diff primitives without FFI (Myers O(ND), line/word/structured patch) | `/data/home/forge/repo-tour/oh-my-pi/crates/pi-diff/src/lib.rs` | Inherit | `crates/hz_diff`; tools `edit`, `patch`; NF-015 |
| Streaming edit session producing progressive previews (parse, match, in-memory apply, diff gen) | `/data/home/forge/repo-tour/oh-my-pi/crates/pi-edit/src/lib.rs` | Supersede | `crates/hz_edit`; capability `files.patch`; tool `edit`; NF-015, `gate:receipt-coverage` |
| Memory tools (`retain`, `recall`, `reflect`, `learn`, `manage_skill`, `context_notes`, `new_context`) | `/data/home/forge/repo-tour/oh-my-pi/packages/coding-agent/src/tools/builtin-names.ts` | Supersede | tools `memory_retain`, `memory_recall`, `memory_reflect`, `learn`, `skill_manage`, `context_notes`, `new_context`; capabilities `memory.read` / `memory.write`; events `hz.memory.retained`, `hz.memory.recalled`; NF-008, NF-010, NF-033 |

**A.5 status:** all rows `DESIGNED`.

### A.6 forgecode — clean architecture and compile-time tool specs

`source: /data/home/forge/repo-tour/forgecode`; full first-pass report `docs/audit/audit-forgecode-report.md` (`29-final-audit.md` §A.1 cluster 1).

| Capability | Where it exists in forgecode | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| Clean-architecture crate stack with hand-written traits (`domain → config/fs/walker/template → app → services → repo → api → main`), service-to-service dependencies forbidden, one generic infra parameter | `/data/home/forge/repo-tour/forgecode/AGENTS.md`, `/data/home/forge/repo-tour/forgecode/crates/{forge_domain,forge_app,forge_services,forge_repo,forge_api,forge_main,forge_infra}` | Supersede | `gate:layering`; `_conventions.md` §3/§4; NF-047, NF-015 (Rust side keeps the discipline; the TS side adds the rank law) |
| Compile-time tool descriptions — `#[tool_description_file]` and `#[derive(ToolDescription)]` read descriptions at build time | `/data/home/forge/repo-tour/forgecode/crates/forge_tool_macros/src/lib.rs`, `/data/home/forge/repo-tour/forgecode/crates/forge_domain/src/tools/` | Supersede | `crates/hz_codegen`; `gate:tool-declaration`; ADR-015; NF-015 |
| Handlebars prompt templating with typed contexts and templates embedded at build time via `include_dir!` | `/data/home/forge/repo-tour/forgecode/crates/forge_template`, `/data/home/forge/repo-tour/forgecode/crates/forge_embed/src/lib.rs` (`register_templates`), `/data/home/forge/repo-tour/forgecode/templates/*.md` | Supersede | `@horizoncode/context`; `gate:cache-guard`; NF-005 |
| Tolerant decoding (`eserde`) and `forge_json_repair` for streamed or truncated tool arguments | `/data/home/forge/repo-tour/forgecode/crates/forge_json_repair`, `eserde` in `/data/home/forge/repo-tour/forgecode/crates/forge_domain/Cargo.toml` | Supersede | `@horizoncode/tools` input repair; `gate:tool-declaration`; NF-001 (a repaired argument is still admitted and receipted) |
| Remote semantic-search index over gRPC for cross-repo symbol/semantic queries | `/data/home/forge/repo-tour/forgecode/crates/forge_infra/src/grpc.rs`, `/data/home/forge/repo-tour/forgecode/crates/forge_repo/src/context_engine.rs` | Supersede | capability `index.query` `[planned]`; `crates/hz_index` + `indexd`; local-first (ADR-013); NF-042 |
| zsh `:`-prefixed shell plugin — the agent as a shell citizen | `/data/home/forge/repo-tour/forgecode/shell-plugin/` (`forge.plugin.zsh`, `doctor.zsh`, `keyboard.zsh`, `lib/`) | Inherit | `@horizoncode/cli` shell plugin; ADR-001 |
| Three named agents as first-class product concepts — `forge` (act), `sage` (research), `muse` (plan) | `/data/home/forge/repo-tour/forgecode/crates/forge_repo/src/agents/{forge.md,sage.md,muse.md}`, `/data/home/forge/repo-tour/forgecode/crates/forge_domain/src/agent.rs` | Supersede | `@horizoncode/agents` `AgentProfileV1`; tools `task`, `read_only_task`; NF-007, NF-004 |
| Single-purpose rendering crates (`forge_display`, `forge_markdown_stream`, `forge_spinner`, `forge_select`) | `/data/home/forge/repo-tour/forgecode/crates/{forge_display,forge_markdown_stream,forge_spinner,forge_select}` | Inherit | `@horizoncode/ui` primitives; ADR-001 |
| `forge.schema.json` — a published JSON schema for the agent's own configuration | `/data/home/forge/repo-tour/forgecode/forge.schema.json` | Supersede | `@horizoncode/protocol`; `hz.schema.json` [planned]; NF-047, NF-031 |

**A.6 status:** all rows `DESIGNED`.

### A.7 codeaashu/claude-code — the tool surface, skills, coordinator and bridge

`source: /data/home/forge/repo-tour/claude-code` (paths read from the tree; feature names cross-checked against §2.8 of `/data/home/forge/hzcode/docs/01-vision-and-superset.md`).

| Capability | Where it exists in claude-code | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| ~40 first-class tools, each self-contained: input schema, permission model, execution logic and UI components, registered centrally and discovered by the query engine (`BashTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `AgentTool`, `Task{Create,Get,List,Output,Stop,Update}Tool`, `WebFetchTool`, `WebSearchTool`, `TodoWriteTool`, `NotebookEditTool`, `ToolSearchTool`, `MCPTool`, `ListMcpResourcesTool`/`ReadMcpResourceTool`, `Team{Create,Delete}Tool`, `SendMessageTool`, `SkillTool`, `EnterPlanModeTool`/`ExitPlanModeTool`, `EnterWorktreeTool`/`ExitWorktreeTool`, `AskUserQuestionTool`, `BriefTool`, `ConfigTool`, `LSPTool`, `McpAuthTool`, `PowerShellTool`, `REPLTool`, `RemoteTriggerTool`, `ScheduleCronTool`, `SleepTool`, `SyntheticOutputTool`, …) | `/data/home/forge/repo-tour/claude-code/src/tools/` (one directory per tool, plus `shared/`) | Supersede | `@horizoncode/tools` + `gate:tool-declaration`; every tool declares name, schema, read-only class, concurrency class, effect class, capability ID, idempotency, renderers, telemetry (ADR-015); NF-001, NF-038 |
| Permission modes `default` / `plan` / `bypassPermissions` / `auto` with a centralized check chokepoint | `/data/home/forge/repo-tour/claude-code/src/utils/permissions/{PermissionMode.ts,permissions.ts,permissionSetup.ts}`, `/data/home/forge/repo-tour/claude-code/src/setup.ts` | Supersede | `DirectSessionPermissionModeProjectionV1` postures (`allow` / `ask` / `deny`), kernel-enforced (ADR-007); `auto`-style classifier routing is replaced by deterministic host policy (NF-004); NF-003, NF-014 |
| Wildcard permission rule patterns (`Bash(git *)`, `FileEdit(/src/*)`, `FileRead(*)`) | `/data/home/forge/repo-tour/claude-code/src/utils/permissions/` | Supersede | `crates/hz_policy` wildcard rules; ADR-007; NF-003 |
| Three command types — prompt command, local command, rich JSX command | `/data/home/forge/repo-tour/claude-code/src/commands.ts`, `/data/home/forge/repo-tour/claude-code/src/commands/` | Inherit | `@horizoncode/cli` command framework; `@horizoncode/tui` renderers; `ui.present`; ADR-005 |
| 16 bundled skills plus user skills and MCP-derived skills | `/data/home/forge/repo-tour/claude-code/src/skills/bundled/`, `/data/home/forge/repo-tour/claude-code/src/skills/{bundledSkills.ts,loadSkillsDir.ts,mcpSkillBuilders.ts}` | Supersede | `@horizoncode/skills`; events `hz.skill.invoked`, `hz.skill.installed`; NF-033 (synthesis + eval verification), NF-032 (distribution) |
| Task system with distinct task types (`LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `InProcessTeammateTask`, `DreamTask`, `LocalMainSessionTask`) and create/update/get/list/output/stop tools | `/data/home/forge/repo-tour/claude-code/src/tasks/` (`LocalShellTask/`, `InProcessTeammateTask/`, `RemoteAgentTask/`, `types.ts`, `stopTask.ts`) | Supersede | `@horizoncode/core` run/attempt model; capability `agent.spawn`; events `hz.agent.spawned`, `hz.agent.completed`; ADR-016; NF-007, NF-018 |
| Coordinator (multi-agent): teams, `SendMessageTool`, sub-agents | `/data/home/forge/repo-tour/claude-code/src/coordinator/`, `/data/home/forge/repo-tour/claude-code/src/tools/SendMessageTool/`, `/data/home/forge/repo-tour/claude-code/src/tools/TeamCreateTool/` | Supersede | tools `team_create`, `team_delete`, `send_message`, `fleet`; capabilities `agent.spawn`; ADR-016; NF-007, NF-030 |
| Memory hierarchy — project and user instruction files, extracted memories, team memory sync | `/data/home/forge/repo-tour/claude-code/src/memdir/` (`memdir.ts`, `findRelevantMemories.ts`, `teamMemPaths.ts`, `teamMemPrompts.ts`), `/data/home/forge/repo-tour/claude-code/src/services/extractMemories`, `/data/home/forge/repo-tour/claude-code/src/services/teamMemorySync` | Supersede | four-tier memory (`memory.read` / `memory.write`); tools `memory_recall`, `memory_retain`, `memory_edit`, `memory_reflect`; NF-008, NF-013; distillation is human-reviewed and authority impact **none** |
| IDE bridge — JWT-authenticated bidirectional bridge with permission proxying, session management, attachments, trusted-device verification, workspace secrets | `/data/home/forge/repo-tour/claude-code/src/bridge/` (`bridgeApi.ts`, `bridgeMessaging.ts`, `bridgePermissionCallbacks.ts`, `jwtUtils.ts`, `remoteBridgeCore.ts`), `/data/home/forge/repo-tour/claude-code/src/utils/swarm/spawnUtils.ts` | Supersede | `@horizoncode/acp` bridge; capabilities `session.manage`, `secrets.read`; event `hz.bridge.attached` `[planned]`; NF-037 |
| MCP **both** directions | `/data/home/forge/repo-tour/claude-code/src/tools/MCPTool/`, `/data/home/forge/repo-tour/claude-code/mcp-server/`, `/data/home/forge/repo-tour/claude-code/src/services/mcp/` | Inherit | `@horizoncode/mcp`; ADR-006; capability `mcp.invoke` |
| Tool-search deferred discovery | `/data/home/forge/repo-tour/claude-code/src/tools/ToolSearchTool/` | Supersede | tool `tool_search`; capability `tool.discover` `[planned]`; event `hz.tool.discovered` `[planned]`; NF-038 |
| Service layer: compaction, policy limits, remote managed settings, token estimation, agent summary, prompt suggestion, session memory, magic docs, auto-dream, tips | `/data/home/forge/repo-tour/claude-code/src/services/{compact,policyLimits,remoteManagedSettings,tokenEstimation.ts,AgentSummary,PromptSuggestion,SessionMemory,MagicDocs,autoDream,tips}` | Supersede | `@horizoncode/context` (compaction, token estimate), `@horizoncode/core` (session memory), `@horizoncode/learn` (auto-dream); NF-005, NF-008, NF-031, NF-010 |
| x402 payments (a payment protocol in the service layer) | `/data/home/forge/repo-tour/claude-code/src/services/x402/` | Reject | §7 D-7 — an autonomous coding agent must not hold payment authority; separates authority from the task domain for no benefit |
| React/Ink UI with ~144 components and ~85 hooks and screens (proof a terminal UI can be a real application) | `/data/home/forge/repo-tour/claude-code/src/components/`, `/data/home/forge/repo-tour/claude-code/src/hooks/`, `/data/home/forge/repo-tour/claude-code/src/ink/` | Supersede | `@horizoncode/tui`, `@horizoncode/ui`; ADR-001; NF-029 (the same richness, plus accessibility and the inline fallback) |

**A.7 status:** all rows `DESIGNED`.

### A.8 `sarv-projects/horizoncode` — the execution constitution (direct ancestor)

`source: /data/home/forge/repo-tour/horizoncode` and `/data/home/forge/hzcode/docs/01-vision-and-superset.md` §2.1. Paths listed as `source: HANDOFF.md` are quoted from `/data/home/forge/repo-tour/horizoncode/HANDOFF.md` rather than asserted from a direct tree read.

| Capability | Where it exists in horizoncode | HorizonCode disposition | HorizonCode home |
|---|---|---|---|
| **Guard** — `authorize()` produces a `GuardDecisionV1` (`Ask` / `Deny`) with a `reason_code`, binding an intent digest | `/data/home/forge/repo-tour/horizoncode/kernel/src/guard.rs` | Inherit | `crates/hz_kernel`; capability IDs per `_conventions.md` §5; events `hz.effect.decision.made`, `hz.permission.asked`; NF-001, NF-003 |
| Origin-typed effects — `EffectOriginKindV1 ∈ {SessionBatch, UserAction, ManagedRun, ManagedRoot}`, fixed by the canonical operation and never supplied by a request body | `/data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs`, `/data/home/forge/repo-tour/horizoncode/kernel/src/guard.rs` | Inherit | `crates/hz_kernel`; `hz.effect.*`; NF-001, NF-003 (a model batch can never present itself as human authority) |
| One-use leases + EffectHost + receipts: resolve → Guard → durable prepare → one-use lease → execute → observe → receipt | `/data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs`, `.../kernel/src/supervisor_lease.rs` | Inherit | `crates/hz_kernel`; events `hz.effect.lease.issued`, `hz.effect.settled`; capability IDs per operation; NF-001 |
| `UNKNOWN` as a first-class terminal state, never blindly retried | `/data/home/forge/repo-tour/horizoncode/kernel/src/effect_host.rs`; event vocabulary `/data/home/forge/hzcode/docs/_conventions.md` §6 | Inherit | events `hz.effect.unknown`, `hz.effect.reconciled`; `gate:no-unknown-retry`; tool `verify`; NF-002, NF-036 |
| Capability-ID registry — stable IDs (`files.write`, `files.patch`, `terminal.run`, `codemode.execute`, `providers.infer`, `language.*`, `debug.*`, `repl.*`) where aliases never change effect class | `/data/home/forge/repo-tour/horizoncode/kernel/src/lib.rs`; registry list `/data/home/forge/hzcode/docs/_conventions.md` §5 | Inherit | `_conventions.md` §5 + §3.3 additions; `gate:tool-declaration`; NF-001 |
| Postures as data — `DirectSessionPermissionModeProjectionV1 { sandboxMode, approvalPolicy, source, revision, digest }` | `/data/home/forge/repo-tour/horizoncode/kernel/src/guard.rs`, `.../kernel/src/effect_host.rs`; schema `/data/home/forge/repo-tour/horizoncode/arch_V1/contracts-v2/direct-session-permission-mode-v1.schema.json` | Inherit | `@horizoncode/protocol`; NF-014; `hz.policy.revision.changed` |
| `DirectSessionGrant` — bounded, workspace-scoped pre-authorisation that still traverses Guard, lease and receipt | `/data/home/forge/repo-tour/horizoncode/kernel/src/direct_session_grant.rs`; schema `.../contracts-v2/direct-session-grant-v1.schema.json` | Inherit | `crates/hz_kernel`; NF-014; `hzcode doctor` trust display |
| Managed domain — `Goal / SpecVersion / Run / Task / Attempt / WorkerExecution / Evidence / Verification`, OwnerLog, task DAG, verifier, worktree pool, resource budget, cgroup v2 | `/data/home/forge/repo-tour/horizoncode/kernel/src/{managed_control.rs,owner_log.rs,owner_log_index.rs,task_dag.rs,managed_verifier.rs,worker_pool.rs,worker_durable.rs,worktree_pool.rs,resource_budget.rs,resource_sampler.rs,cgroup_v2.rs}` | Inherit | `crates/hz_kernel`; NF-018, NF-019, NF-017, NF-025 |
| Sandbox with typed residuals — `Sandbox::probe()` fail-closed, bubblewrap + Landlock backends, per-dimension guarantee vectors | `/data/home/forge/repo-tour/horizoncode/horizoncode-sandbox/src/{lib.rs,linux.rs,landlock.rs,unsupported.rs}` (`GuaranteeDimension` × 7, `GuaranteeLevel {Unsupported, BestEffort, Enforced}`, `GuaranteeAssessment.residuals`) | Supersede | `crates/hz_sandbox`; events `hz.sandbox.guarantee.assessed`, `hz.sandbox.residual.reported` `[planned]`; NF-016 |
| `indexd` — lexical repo index (generation store, watch, repo intel/structure) | `/data/home/forge/repo-tour/horizoncode/indexd/src/{lib.rs,generation_store.rs,handler.rs,repo_intel.rs,repo_structure.rs,watch.rs,persist.rs,transport.rs}` | Supersede | `crates/hz_index`; capability `index.query` `[planned]`; event `hz.index.updated` `[planned]`; NF-042 |
| CodeMode as a composing interpreter — nested calls go back through the ordinary tool batch; not a new executor | `/data/home/forge/repo-tour/horizoncode/kernel/src/codemode_protocol.rs` | Inherit | capability `codemode.execute`; tool `code_mode`; NF-001 (nested calls receipt individually) |
| Documentation-as-authority — numbered topic-owner docs, machine contracts (`arch_V1/contracts-v2/*.schema.json`), status levels `DESIGNED → RELEASED` | `/data/home/forge/repo-tour/horizoncode/docs/README.md`, `/data/home/forge/repo-tour/horizoncode/arch_V1/` (e.g. `46-V1-WIRE-TRACKER.md`), `/data/home/forge/repo-tour/horizoncode/arch_V1/contracts-v2/` | Supersede | `gate:doc-status`; ADR-014; NF-047, NF-048 |
| Overlay/upstream provenance discipline — pinned upstream, bootstrap re-hydration, provenance register | `/data/home/forge/repo-tour/horizoncode/HANDOFF.md`, `/data/home/forge/repo-tour/horizoncode/patches/`, `/data/home/forge/repo-tour/horizoncode/NOTICE` | Inherit | ADR-014; NF-048; `gate:provenance` |
| **Evidence gate — designed but not wired upstream** (the ancestor's own handoff records this gap) | `/data/home/forge/repo-tour/horizoncode/HANDOFF.md` (`source: HANDOFF.md`); design intent `/data/home/forge/hzcode/docs/01-vision-and-superset.md` §2.1 | Supersede | NF-002 is the whole point: the gate is wired into every surface and cannot be bypassed; `gate:receipt-coverage`, `gate:parity-ratchet` |
| **Subagent delegation behind a flag / dead lanes** — the ancestor records `DIRECT_CHILD_TURN_RPC_ENABLED = false`, no completion gate, LSP/DAP routes returning `false`, and a `completeDirectTurn(resultDigest)` that accepts an arbitrary string | `/data/home/forge/repo-tour/horizoncode/HANDOFF.md` (`source: HANDOFF.md`); paths as recorded there: `/data/home/forge/repo-tour/horizoncode/packages/opencode/src/session/managed-control.ts`, `/data/home/forge/repo-tour/horizoncode/packages/opencode/src/lsp/launch.ts` | Supersede | `gate:dead-lane-fail-closed`; NF-049, NF-007, NF-042, NF-002 (a lane that is off must report `UNKNOWN`/refusal, never a green result) |

**A.8 status:** all rows `DESIGNED`. The ancestor's *measured* state is recorded in `/data/home/forge/repo-tour/horizoncode/HANDOFF.md` and is explicitly **not** inherited as a claim of working capability; the residual defect it names — two edits to the same file in one message refused with `stale_preimage` — is carried as a work item in `25-roadmap-and-glossary.md` M1.

### A.9 Addendum sources — the second wave (six sources)

Sources added after A.1–A.8 were counted (the second learning pass and the pass-3 dives): **SWE-agent, OpenHands, wshobson/agents, aider, mini-swe-agent, hermes-agent**. Each is one addendum row in the `CapabilityRecordV1` shape — deliberately coarser than the per-capability tables above — and is counted as its own line in §6.1.

| Addendum row | Upstream (clone under `/data/home/forge/repo-tour/`) | Disposition | Home |
|---|---|---|---|
| A.9.1 SWE-agent — the ACI reading modes | `SWE-agent` — bounded read windows with orientation, summary search with narrowing abort, window-scoped edit with repair hints, lint-gated edit that reverts, narrated empties, recovery hints, environment-derived state line | `Supersede` | NF-052 (doc 09): R-read-window-1…4, R-edit-window-1/2, R-edit-lint-1, R-grep-summary-1, R-tools-57/58 |
| A.9.2 OpenHands — the Agent Canvas event model | `OpenHands` — durable/transient frame classes, sync preamble before replay, strict pagination, evented condensation views | `Inherit` | NF-060, NF-059; docs 07/10/12/14 |
| A.9.3 wshobson/agents — the profile corpus | `wshobson-agents` — the engineered minority of a 202-agent roster distilled into profile contracts (P1–P10); the sprawl is the rejected failure mode | `Supersede` | doc 15 (D-15); NF-058-adjacent profile contracts |
| A.9.4 aider — git-native engineering | `aider` — escalating edit-application ladder, tree-sitter + PageRank repo map, cache-layout invariant with keep-alive, compiler-grade lint/reflection loop, dirty-commit discipline | `Supersede` | NF-069, NF-052, NF-005; docs 09/10; `30-steal-list.md` §2 A/B/E/F |
| A.9.5 mini-swe-agent — the industrialised lean loop | `mini-swe-agent` — sentinel exit, charged failed turns, consecutive-error caps, stateless per-action subprocess execution, per-step trajectory saves | `Supersede` | NF-073; docs 08/16; `30-steal-list.md` §2 C/J |
| A.9.6 hermes-agent — the managed loop and the growth loop | `hermes-agent` — owner/worker turn frames with identity handshake, durable admission FIFO, process ownership, warm-cache growth fork with an editorial standard, archive-only curator | `Supersede` | NF-071, NF-075; docs 08/15; `30-steal-list.md` §2 C/D/G |

**A.9 accounting:** 6 addendum rows — `Inherit` 1, `Supersede` 5, `Reject` 0. The A.1–A.8 total (117) is unchanged; §6.1 states the addendum as its own line and the grand total, and `gate:parity-ratchet` applies to addendum rows exactly as to matrix rows.

---

## 5. Section B — New features

Every feature below is measured against one question: **does any reference agent already do this?** If yes, it is not here — it is a `Supersede` row in Section A. Only genuinely absent capabilities get an `NF-` id.

Two conventions apply to every entry:

- **Status is `DESIGNED`.** No exceptions in this document.
- **Authority impact** is one of `none` · `narrows` · `grant-bearing` · `kernel`. `grant-bearing` means the feature can cause authority to be *granted* (always through Guard, a lease and a receipt). `kernel` means it changes kernel behaviour and therefore needs a kernel release. **Any feature the learning loop touches declares `none`** (ADR-010); NF-008, NF-010, NF-033, NF-034, NF-035 and NF-075 are the learning-loop set and every one of them is `none`.

### NF-001 — Execution constitution with universal receipts

- **Problem.** "The agent said it ran the tests." A model's summary of its own work is the weakest evidence in the system, and most agents have no other kind. Small effects escape whatever ledger exists; short-lived processes leave nothing behind.
- **Design.** One path for every mutation: resolve capability → `Guard.authorize()` → `GuardDecisionV1` → durable prepare → one-use lease → execute → observe → `EffectReceiptV1` settlement. The receipt carries capability ID, origin kind, intent digest, policy revision and digest, lease ID, observation and a terminal state from the single ratified enum (RC-7): `succeeded` · `failed` · `denied` · `cancelled` · `unknown` · `budget_exhausted` · `timeout` · `interrupted`. Origin kind is fixed by the canonical operation, never by a request body. There is no fast path: a tool that cannot declare how it is observed cannot be given mutation authority. Receipts are addressable as `hz://receipt/<id>` and fold into the OwnerLog.
- **Capability IDs.** Every ID in `_conventions.md` §5 that is not `read-only` (`files.write`, `files.patch`, `files.delete`, `files.move`, `terminal.run`, `terminal.pty`, `process.spawn`, `net.fetch`, `code.execute`, `codemode.execute`, `vcs.write`, `memory.write`, `plugins.invoke`, `schedule.manage`, `agent.spawn`, `artifact.write`, `remote.exec`, `mcp.invoke`, `session.manage`, `secrets.read`).
- **Authority impact.** `kernel`.
- **Dependencies.** ADR-003, ADR-012; `crates/hz_kernel` (`guard.rs`, `effect_host.rs`, `supervisor_lease.rs`); `@horizoncode/kernel-client`; `gate:receipt-coverage`, `gate:no-unknown-retry`.
- **Status.** `DESIGNED`.

### NF-002 — Evidence gate with claim lowering

- **Problem.** Confident summaries of work that was never done. A completion report produced by the same model that did the work is not evidence.
- **Design.** `verify` compiles the model's claims into obligations, then checks each against host receipts, the trusted host state chain and workspace observations. The gate can only **lower** a claim's status, never raise it: `verified` → `unverified` → `contradicted`, each with the receipt that decided it. Contradicted claims become explicit failures naming the receipt. The gate is wired into every surface, so no front-end can display a claim it did not check. The ancestor `sarv-projects/horizoncode` has this designed but unwired; the deliverable here is the wire, guarded by `gate:parity-ratchet`.
- **Capability IDs.** `receipt.read` `[planned]`, `files.read`, `terminal.run` (to re-run checks).
- **Authority impact.** `none` — the gate never grants and never raises a claim.
- **Dependencies.** NF-001, NF-017; ADR-012; tool `verify`; `gate:receipt-coverage`.
- **Status.** `DESIGNED`.

### NF-003 — Composed policy: wildcards + Starlark + origin typing + narrowing-only workspace config

- **Problem.** Wildcards alone are unsafe (`Shell(rm -rf*)` cannot see `xargs rm`); a semantic engine alone is unusable day to day; and a checked-out repository can silently widen permissions.
- **Design.** Three layers, one decision. **Layer 1** wildcard rules (`Shell(git *)`, `Edit(src/**)`, `Read(*)`, `Web(domain:github.com)`, `Provider(model:claude-*)`). **Layer 2** a Starlark prefix engine that evaluates command decisions structurally against a shell AST, never by string matching on prose. **Layer 3** origin typing — a `SessionBatch` effect can never present itself as `UserAction`. Precedence is always `deny > ask > allow`. The effective rule set compiles to a canonical form with a digest, and that digest lands in the session posture so a run can be shown to have run under an exact policy revision. Workspace config merges as a lattice **meet**: it may narrow, never widen; programs a workspace names stay off until trusted for that folder, recorded with path + digest.
- **Capability IDs.** `terminal.run`, `files.write`, `files.patch`, `net.fetch`, `process.spawn`, `plugins.invoke`.
- **Authority impact.** `kernel` (the engine); workspace config contributes `narrows`.
- **Dependencies.** ADR-007, ADR-008; `crates/hz_policy`; `crates/hz_kernel/guard.rs`; `hz.policy.revision.changed`.
- **Status.** `DESIGNED`.

### NF-004 — Deterministic planner/executor routing

- **Problem.** Unpredictable model switching mid-task: a classifier guesses, the prefix changes, the cache misses, and cost and latency jump.
- **Design.** A host policy — explicit rules over the raw user input, task class and repo state, **not** a classifier model — selects one of `executor-only` · `light` · `full` · `plan-for-approval` · `plan-only`. Planner and executor run in separate sessions with separate, cache-stable prefixes; prefixes are never mixed. An approved plan opens a bounded execution window which the kernel records. `prewalk`-style downgrades happen only at defined boundaries (first edit with an existing todo list) and are recorded as a routing decision in the log.
- **Capability IDs.** `providers.infer`, `models.list`.
- **Authority impact.** `none` — routing chooses a model, not a permission; the posture is unaffected.
- **Dependencies.** NF-005, NF-045; `@horizoncode/agents`; ADR-009; `gate:cache-guard`.
- **Status.** `DESIGNED`.

### NF-005 — Cache-first context compiler with a contract test

- **Problem.** Paying full price on every turn because something reordered the prompt: unstable JSON key order, a timestamp in the prefix, tools re-sorted per call.
- **Design.** The compiler emits two regions and only two. The **prefix** is byte-stable for a `(provider, model, config)` tuple: system prompt, sorted tool schemas, declared configuration. The **tail** is projected per turn: memory, skills index, goal/plan, retrievals, volatile observations. Volatility in the prefix is a bug, not a tuning choice. `gate:cache-guard` recompiles the prefix for every supported tuple and fails the build on any drift; the failure prints a byte diff. Compaction preserves the prefix contract by installing behind a rare, provider-visible checkpoint.
- **Capability IDs.** `providers.infer`, `context.manage`.
- **Authority impact.** `none`.
- **Dependencies.** ADR-009; `@horizoncode/context`; NF-008, NF-034, NF-039; `gate:cache-guard`.
- **Status.** `DESIGNED`.

### NF-006 — One Controller across eight surfaces with a parity ratchet

- **Problem.** Surface drift: the web app grows a capability the TUI lacks, and the codebase forks into two agents with one name.
- **Design.** All behaviour lives in one transport-agnostic `Controller`; surfaces are clients and may only render and collect input. Eight surfaces: TUI · print/headless · server (JSON-RPC over stdio/UDS/TCP + HTTP/SSE/WS) · web · desktop · IDE bridge (ACP + bridge) · MCP server · generated SDKs. A capability is added once, with its surface projection declared in the same change. `gate:frontend-parity` counts capability edges per surface and fails a missing one; `gate:parity-ratchet` additionally fails a Section A disposition regression.
- **Capability IDs.** `ui.present`, `session.manage`, `mcp.invoke`.
- **Authority impact.** `none`.
- **Dependencies.** ADR-001, ADR-005; `@horizoncode/core`, `@horizoncode/protocol`, `@horizoncode/server`; `crates/hz_codegen`; NF-011, NF-037, NF-046; `gate:parity-ratchet`, `gate:frontend-parity`.
- **Status.** `DESIGNED`.

### NF-007 — Subagent fleets with capability grants

- **Problem.** Subagents accumulating authority and cost invisibly; one code path forgetting to narrow permissions, another forgetting the budget.
- **Design.** Child construction funnels through exactly one primitive that applies capability narrowing, budget inheritance, depth and concurrency ceilings, context capsule construction and receipt linkage. Tools: `task`, `fleet` (a small dependency graph with `id`/`depends_on`, upstream results, `adopt_ref`, `fail_fast`), `parallel_tasks`, `read_only_task`. Ceilings: concurrency, parallel writers, depth. `gate:boundary-test` fails CI when a new caller of the primitive appears. Children are always traceable to the parent receipt, and `hzcode session tree` reconstructs authority and cost for the whole tree.
- **Capability IDs.** `agent.spawn`, `providers.infer`, `files.read` (read-only children).
- **Authority impact.** `grant-bearing` — the primitive grants a *narrowed* subset, always through Guard.
- **Dependencies.** ADR-016; `@horizoncode/agents`; NF-014, NF-025, NF-018; `gate:boundary-test`.
- **Status.** `DESIGNED`.

### NF-008 — Four-tier memory with distillation and provenance

- **Problem.** The agent relearning your codebase every session; and memory that accumulates unreviewed claims with no way to tell where a fact came from.
- **Design.** Four tiers: **working** (in-session), **episodic** (retrieval over past sessions), **semantic** (curated facts), **team** (shared, syncable). Every semantic fact carries provenance: source session, event, receipt and timestamp. **Distillation** promotes an episodic observation to a semantic fact only through an explicit, reviewable step; a promotion that cannot cite provenance is refused. Retrieval is local-first (BM25 + embeddings + symbol index), and dynamic memory is projected onto the turn **tail**, never the prefix.
- **Capability IDs.** `memory.read`, `memory.write`, `context.manage`.
- **Authority impact.** `none` — memory may inform, never authorise. A memory that "remembers" a permission is ignored by Guard.
- **Dependencies.** NF-005, NF-010, NF-013, NF-042; `@horizoncode/context`; `hz.memory.retained`, `hz.memory.recalled`.
- **Status.** `DESIGNED`.

### NF-009 — Time-travel replay

- **Problem.** "Why did it do that?" Without a durable log, the answer is guesswork.
- **Design.** The log is the state of record, so any session replays step by step: prompt admission, stream events, tool calls, guard decisions, leases, receipts, settlements. Replay has two modes — **read** (inspect, step, jump to the receipt that decided an outcome) and **dry-run** (re-evaluate policy against recorded intents without executing effects, showing which decisions would differ under a new policy revision). `hzcode session verify <id>` walks the receipt chain plus the evidence gate and answers whether the work is done; it never consults the model's own summary.
- **Capability IDs.** `receipt.read` `[planned]`, `session.manage`.
- **Authority impact.** `none` — dry-run evaluates and reports; it never executes.
- **Dependencies.** NF-001, NF-002, NF-026; ADR-004.
- **Status.** `DESIGNED`.

### NF-010 — Gated self-improvement proposals

- **Problem.** Agents that never get better at *your* codebase — and agents that can widen their own permissions.
- **Design.** The agent captures trajectories, runs evals, distills memory, synthesises skills and tunes prompts, and emits **proposals**: diffs, skill bundles, memory facts with provenance, routing heuristics. Proposals are receipted, reviewable, revertible and off by default in untrusted workspaces. The learning loop may change memory, skills, prompts, retrieval weights and non-authority routing. It **must not** add, widen or pre-approve a capability, edit policy, or alter the kernel; a proposal that would do any of those is refused at the proposal boundary, not at review. A background "dream" consolidation proposes; it never applies.
- **Capability IDs.** `learn.run` `[planned]`, `learn.propose` `[planned]`, `memory.write`, `providers.infer`.
- **Authority impact.** **`none`** (ADR-010). This is the feature the rule exists for.
- **Dependencies.** NF-008, NF-033, NF-034, NF-035, NF-039; ADR-010; `@horizoncode/learn`; `hz.learn.proposal.created`, `hz.learn.proposal.reviewed` `[planned]`.
- **Status.** `DESIGNED`.

### NF-011 — `hz://` resource space

- **Problem.** Resources addressed ad hoc — a path here, an opaque id there — so nothing is linkable, and nothing can be scoped by capability cleanly.
- **Design.** One URI space with typed resolution and capability-checked reads, using the ratified path kinds from [`_conventions.md`](./_conventions.md) §1 — `hz://session/<id>`, `hz://receipt/<id>`, `hz://decision/<id>`, `hz://lease/<id>`, `hz://reconciliation/<id>`, `hz://artifact/<sha256>`, `hz://skill/<name>`, `hz://tool/<name>`, `hz://agent/<id>`, `hz://team/<id>`, `hz://memory/<id>`, `hz://worktree/<id>`, `hz://workflow/<id>`, `hz://eval/<id>`, `hz://proposal/<id>`, `hz://trusted-state/<digest>`. Resolution is a capability, not a string parse: reading a receipt needs `receipt.read`, an artifact needs the read half of `artifact.write` — so a scheme cannot be used to smuggle access. Unknown schemes resolve to an explicit failure, never a filesystem guess.
- **Capability IDs.** `receipt.read` `[planned]`, `session.manage`, `artifact.write`, `memory.read`, `worktree.manage`.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-017, NF-027; `@horizoncode/shared`; `_conventions.md` §1.
- **Status.** `DESIGNED`.

### NF-012 — Workflow engine

- **Problem.** Multi-agent orchestration written as prose in a prompt is neither repeatable nor reviewable; recurring automations die with the process.
- **Design.** Declarative workflows (Rhai) orchestrate agents through a host channel: each step names the agent profile, the capability it needs and the artefacts it produces. A workflow **declares** the capabilities it requires; approval is requested up front, and the workflow cannot obtain a capability it did not declare. Steps are journaled so a workflow resumes after a crash, and a recurring workflow uses a **scheduler with an occurrence journal** — an occurrence is recorded before it runs, so a restart cannot double-fire or silently skip it.
- **Capability IDs.** `workflow.run` `[planned]`, `schedule.manage`, `agent.spawn`, plus each step's own capability.
- **Authority impact.** `grant-bearing` — declared up front, granted through Guard, receipted per step.
- **Dependencies.** NF-007, NF-028, NF-001; `@horizoncode/workflow`; `hz.workflow.started` `[planned]`.
- **Status.** `DESIGNED`.

### NF-013 — Team memory

- **Problem.** A team repeats the same codebase lessons in every session and every person's agent.
- **Design.** The fourth memory tier: facts shared across a team, each with the provenance of the session that learned it and the person who confirmed it. Sync is optional, conflict-aware (facts merge by provenance, never by last-write-wins) and degrades to local-only when offline. Team memory can never encode authority: a shared "always allow X" is inert — only policy grants permissions, and policy is per-machine and narrowing-only.
- **Capability IDs.** `memory.read`, `memory.write`; `collab.manage` `[planned]` for sync membership.
- **Authority impact.** `none`.
- **Dependencies.** NF-008, NF-030, NF-023; `@horizoncode/context`.
- **Status.** `DESIGNED`.

### NF-014 — Capability-granted delegation

- **Problem.** "Allow once" is too small and "always allow everything" is too large. Approval that is not bounded is either useless or dangerous.
- **Design.** A grant is a **bounded, workspace-scoped, expiring pre-authorisation** that names capability IDs, path patterns and a maximum use count — and that still traverses Guard, a one-use lease and a receipt on every use. Three properties are load-bearing: grants are origin-typed (only `UserAction` or `ManagedRoot` may mint one, never `SessionBatch`); grants are re-checked against the current policy revision and fail closed if the revision changed; and a grant for `files.write` never implies `files.delete`. Grants are visible in `hzcode doctor`, revocable, and every use is receipted.
- **Capability IDs.** Every grantable ID in `_conventions.md` §5 except `read-only` ones; `session.manage` to mint.
- **Authority impact.** `grant-bearing`.
- **Dependencies.** NF-001, NF-003; `crates/hz_kernel/direct_session_grant.rs`; `arch_V1/contracts-v2/direct-session-grant-v1.schema.json`; `hz.permission.answered`.
- **Status.** `DESIGNED`.

### NF-015 — Unified native capability stack

- **Problem.** A native stack scattered across bindings is unbuildable, unauditable and slow to compile; a pure-TS stack cannot do in-process sandboxing, fast walking or AST work.
- **Design.** One N-API addon (`hz_native`) as the single facade over focused crates: `hz_shell` (embedded shell over an injectable VFS), `hz_edit` (conflict-aware edit engine), `hz_diff`, `hz_ast`, `hz_vcs`, `hz_walker`, `hz_index`, `hz_pty`, `hz_voice`. Heavy dependencies compile once; each crate rebuilds only on its own changes. Every native call still resolves to a capability ID and an effect through the kernel — the stack never bypasses Guard. `gate:cross-plane-abi` makes the TS side fail closed when the native ABI is absent or older than the pinned version.
- **Capability IDs.** `files.read`, `files.write`, `files.patch`, `terminal.run`, `vcs.read`, `index.query` `[planned]`.
- **Authority impact.** `none` — native execution is still admitted, leased and receipted.
- **Dependencies.** ADR-002; `crates/hz_native`; NF-016, NF-042; `gate:cross-plane-abi`.
- **Status.** `DESIGNED`.

### NF-016 — Cross-platform sandbox matrix with typed residuals

- **Problem.** Silent degradation: a sandbox that did not apply, reported as success. "We confined it" and "we asked it to be confined" are different claims.
- **Design.** Per-OS backends (Linux: Landlock + bubblewrap + seccomp + namespaces; macOS: Seatbelt; Windows: write-restricted token / AppContainer / job objects), each reporting a **guarantee vector** over seven dimensions — filesystem read, filesystem write, network egress, process tree, resource limits, credentials, workspace fence — at a level of `enforced` · `best_effort` · `unsupported`, with **typed residuals** naming the exact gap. A caller states the minimum level it accepts per dimension; if the host cannot meet it the operation **fails closed**, and the residual is recorded and surfaced. The probe runs before the work, not after.
- **Capability IDs.** `sandbox.probe` `[planned]`, plus the confined operation's own ID.
- **Authority impact.** `kernel`.
- **Dependencies.** ADR-003; `crates/hz_sandbox`; NF-021, NF-019; `hz.sandbox.guarantee.assessed`, `hz.sandbox.residual.reported` `[planned]`.
- **Status.** `DESIGNED`.

### NF-017 — Trusted Host State evidence chain

- **Problem.** Evidence that can be edited after the fact is not evidence, and a chain nobody can verify is theatre.
- **Design.** Host-owned, content-addressed, hash-chained records for task contracts, evidence bundles and capability rollout. Each record commits to its predecessor's hash, so a rewrite is detectable by any reader; each record is addressable using the ratified `hz://trusted-state/<digest>` path kind ([`_conventions.md`](./_conventions.md) §1). Two integrity levels are declared honestly: `host_protected` (written by the kernel outside the workspace, not writable by the agent) and `tamper_evident_only` (chain detects edits but the host does not prevent them). Consumers state which level they require; a lower level fails closed for a verification claim. Exported evidence bundles are self-verifying offline. Journal-style kernel metadata (log snapshots, retention markers, worktree and schedule journals) lives here as kernel `OwnerLog` records referenced by digest, not as session events (RC-3).
- **Capability IDs.** `receipt.read` `[planned]`, `artifact.write`; kernel-internal append.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-002, NF-027, NF-023; `crates/hz_kernel` (`owner_log.rs`, `owner_log_index.rs`); `hz.trust.record.appended` `[planned]`.
- **Status.** `DESIGNED`.

### NF-018 — Managed coding domain

- **Problem.** Long unattended work has no vocabulary for "what was asked", "what was planned", "what was attempted", "what is evidenced" — so nothing is comparable across runs.
- **Design.** A durable domain of `Goal` → `SpecVersion` → `Run` → `Task` → `Attempt` → `WorkerExecution` → `Evidence` → `Verification`, with an `OwnerLog` (append-only, hash-chained) and a task DAG. Attempts are the unit of retry and the unit of accounting; evidence attaches to an attempt; verification is a separate, adjudicating step that can only lower a claim. A managed run carries an explicit capability scope, so its blast radius is stated before it starts.
- **Capability IDs.** `agent.spawn`, `worktree.manage`, plus each task's own IDs.
- **Authority impact.** `grant-bearing` — the run's scope is granted, bounded and receipted; it never exceeds the grant.
- **Dependencies.** NF-001, NF-002, NF-019, NF-025, NF-026; `crates/hz_kernel` (`managed_control.rs`, `task_dag.rs`, `managed_verifier.rs`, `worker_pool.rs`); `arch_V1/contracts-v2/managed-capability-scope-v1.schema.json`.
- **Status.** `DESIGNED`.

### NF-019 — Worktree pool isolation

- **Problem.** Concurrent agents stepping on one checkout: lost edits, phantom test failures, unreviewable diffs.
- **Design.** A kernel-managed pool of git worktrees with checkout, lease, snapshot and reuse. Every task that will mutate the tree takes a worktree lease; the lease names the task and is released on terminal outcome (not on shutdown, which may not run). Isolation is a **workspace fence** dimension in the sandbox guarantee vector: an effect that writes outside its leased worktree fails closed. Reuse is snapshot-based, so a recycled worktree cannot leak a previous task's bytes into a new task's evidence.
- **Capability IDs.** `worktree.manage`, `files.write`, `vcs.read`, `vcs.write`.
- **Authority impact.** `narrows` — isolation reduces reach; it never widens.
- **Dependencies.** NF-016, NF-018, NF-007; `crates/hz_kernel` (`worktree_pool.rs`, `worktree_lifecycle.rs`); tools `worktree_create` / `worktree_list` / `worktree_remove`.
- **Status.** `DESIGNED`.

### NF-020 — Multi-machine and remote execution

- **Problem.** A laptop is the wrong machine for a build, a GPU job, or a Windows-only test — and a remote shell with the user's ambient credentials is a security hole.
- **Design.** Execution on machines you own (SSH/SFTP, WSL, containers, remote sandboxes) under `remote.exec`, with the same contract as local: capability ID, Guard decision, lease, receipt, and the **host's** guarantee vector returned alongside the result. Remote is never ambient authority: a remote operation re-evaluates policy for the remote context, and a guarantee shortfall on the remote host is a typed residual, not an assumption. Host key and credential prompts are explicit and never remembered implicitly. Multi-machine fleets are ordinary NF-007 fleets whose child attempts are pinned to a named host.
- **Capability IDs.** `remote.exec`, `process.spawn`, `net.fetch`, `terminal.run`.
- **Authority impact.** `grant-bearing` — remote reach is granted per host and per task.
- **Dependencies.** NF-001, NF-016, NF-007, NF-022; `@horizoncode/server`; `hzcode remote` [planned].
- **Status.** `DESIGNED`.

### NF-021 — Egress control and network policy

- **Problem.** An agent with unrestricted network access can exfiltrate a repository, and "it fetched a URL" is unreviewable after the fact.
- **Design.** All egress through one policy point: exact-origin allow-lists, a local proxy for the model transport, and per-operation decisions that are **denied by default** for anything not declared. The network policy is a first-class dimension of the sandbox guarantee vector, so "network denied" is a claim the host proves. Every fetch is receipted with origin, purpose and the capability that authorised it; a denied attempt is an event, not a silent failure. `web_fetch` additionally runs an SSRF guard and a response-size cap.
- **Capability IDs.** `net.fetch`, `net.search`, `providers.infer` (model transport), `remote.exec`.
- **Authority impact.** `kernel`.
- **Dependencies.** NF-016, NF-003, NF-001; `crates/hz_policy`, `crates/hz_sandbox`; tools `web_fetch`, `web_search`; `hz.egress.denied` `[planned]`.
- **Status.** `DESIGNED`.

### NF-022 — Secret vault with redaction

- **Problem.** Credentials leaking into transcripts, logs, diffs, prompts, telemetry and ticket bodies — the most common way an agent becomes an incident.
- **Design.** Secrets live in the OS keychain or an encrypted store, resolved at use, never in config files or the workspace. A secret is accessed only through `secrets.read`, which is receipted, and the value is injected into the child process environment without ever entering the model's context. Redaction runs on the **outbound** path: transcripts, logs, telemetry, crash reports, share links and artifacts are scanned for known secret shapes and for the resolved values themselves before they leave the process. A redaction hit is recorded as an event so the operator can see that a secret was nearly leaked.
- **Capability IDs.** `secrets.read`, `credential` effect class.
- **Authority impact.** `kernel`.
- **Dependencies.** NF-021, NF-001, NF-041; ADR-013; `@horizoncode/observe` redaction.
- **Status.** `DESIGNED`.

### NF-023 — Offline and air-gapped operation

- **Problem.** Enterprises and remote machines cannot reach a vendor service at all — and an agent that silently degrades is worse than one that refuses.
- **Design.** Three modes: **local-first** (default; only the configured model endpoint is reached), **offline** (no outbound call at all; local models only) and **air-gapped** (offline plus a signed, importable policy and artifact bundle, and an explicit refusal for any capability that would need the network). Every feature declares what it needs to work and what it does when that is unavailable; capabilities that cannot work degraded are **disabled with a reason**, and their state is visible in `hzcode doctor`. Update, sync, telemetry, collaboration and marketplace all degrade to local-only or off.
- **Capability IDs.** All; the mode narrows which IDs are admissible.
- **Authority impact.** `none` — a mode removes reach; it never adds.
- **Dependencies.** ADR-013; NF-021, NF-031, NF-017.
- **Status.** `DESIGNED`.

### NF-024 — Account pools with credential affinity

- **Problem.** Rotating credentials between turns cold-misses the provider-side prompt cache and silently changes the billing/account lineage mid-task; multi-account users get both problems at once.
- **Design.** A session **pins the account that served it** (`promptCacheKey` / `providerSessionId` carried through), so continuation does not cold-miss. An account pool may constrain a session to a listed set; when the serving account is unavailable, the fallback is explicit and recorded — never a silent switch mid-step. Commitment order, usage and failures are accounted per account, and a pinned account that is exhausted fails closed rather than quietly changing identity.
- **Capability IDs.** `providers.infer`, `models.list`, `secrets.read`.
- **Authority impact.** `none`.
- **Dependencies.** NF-005, NF-025, NF-044; `@horizoncode/provider`; ADR-009.
- **Status.** `DESIGNED`.

### NF-025 — Cost gate across the session tree

- **Problem.** A subagent fleet can spend an unbounded amount of money without anyone noticing until the invoice, and per-step accounting without tree rollup hides the cause.
- **Design.** Budgets are scoped per root run and **inherited** by children: tokens, wall-clock, steps, triage, web-search calls and currency. Usage rolls up the whole session tree, so any node can be attributed to its root and to the child that spent it. The gate is enforced at admission boundaries (before a step, before a child, before a paid fetch), not merely reported afterwards; approaching a budget warns, exceeding it stops the affected branch with a typed refusal while the rest of the tree continues or stops per policy. An append-only price table (NF-050) turns tokens into currency; every usage record cites the rate revision it used.
- **Capability IDs.** `providers.infer`, `net.search`, `agent.spawn` (budget inheritance is part of the one primitive).
- **Authority impact.** `none` — budgets only ever reduce what may happen.
- **Dependencies.** NF-007, NF-004, NF-050; ADR-016; `@horizoncode/core`; `hz.usage.recorded`, `hz.budget.exceeded` `[planned]`; `hzcode session tree`.
- **Status.** `DESIGNED`.

### NF-026 — Replayable rollout

- **Problem.** A run that cannot be reproduced cannot be debugged, compared or trusted; and a bug that only appears under a live provider stream is the hardest kind to fix.
- **Design.** Every turn is recorded as a durable rollout: the compiled request (prefix digest + tail), the stream events, the tool batch, the guard decisions, the receipts, and a **reduced-state** trace bundle that omits bulk payloads while preserving decision-relevant state. Two consumers: the time-travel UI (NF-009) and the hermetic test harness (NF-039), which can replay a rollout against a fake provider with byte-comparable decisions. A reduced trace is self-describing — replay without the original session database is possible, and a missing artefact is reported as `UNKNOWN` rather than silently substituted.
- **Capability IDs.** `session.manage`, `receipt.read` `[planned]`.
- **Authority impact.** `none`.
- **Dependencies.** NF-009, NF-039, NF-001; ADR-004; `@horizoncode/core`; events `hz.session.checkpoint.created`, `hz.session.forked`.
- **Status.** `DESIGNED`.

### NF-027 — Artifact store

- **Problem.** Build outputs, screenshots, generated images, rendered diagrams, coverage reports and evidence bundles have no durable, addressable home; they end up in the repo by accident or nowhere.
- **Design.** A content-addressed store addressed as `hz://artifact/<sha256>`, with tooling `artifact_create` / `artifact_read` / `artifact_update` / `artifact_delete` and a declared lifecycle (session-scoped, run-scoped or pinned). Writes are effects (`artifact.write`) with receipts, so an artifact's provenance is reconstructible: which run, which step, which tool. Artifacts are deduplicated by digest, verifiable offline, and excluded from transcripts by reference — a transcript that inlines a 4 MiB screenshot is a cost bug, not a feature.
- **Capability IDs.** `artifact.write`, `files.read`.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-011, NF-004 (media), NF-025; `@horizoncode/core`.
- **Status.** `DESIGNED`.

### NF-028 — Notification and watchdog system

- **Problem.** A long unattended run fails at 03:00 and nobody knows; a stall (no progress, no error) is worse than a failure because nothing is raised.
- **Design.** Watchdogs over run-tree invariants — no progress for N steps, budget threshold, repeated identical failure, a lease held past its deadline, a sandbox residual, an `UNKNOWN` awaiting reconciliation, a dead lane — each emitting `hz.notify.raised` `[planned]` to declared sinks (terminal, OS notification, webhook, email, file). Notification policy is per-run and per-sink; a sink that cannot be reached is itself an event, never a silent drop. The scheduler (NF-012) and the cost gate (NF-025) feed the same system, so "tell me if this costs more than X" and "tell me if this stalls" are one mechanism.
- **Capability IDs.** `notify.emit` `[planned]`, `schedule.manage`.
- **Authority impact.** `none` — a notification is an effect but it grants nothing.
- **Dependencies.** NF-025, NF-012, NF-049, NF-036; `@horizoncode/core`.
- **Status.** `DESIGNED`.

### NF-029 — Accessible TUI

- **Problem.** A fullscreen mouse TUI is unusable for screen-reader users, in narrow terminals, over slow links, and in scrollback-only environments; "just use the inline mode" is not an answer if the inline mode is a second-class citizen.
- **Design.** Accessibility is a **contract between two renderers, not a settings toggle**: every view must render in fullscreen (rich) and inline (linear) form, and `gate:frontend-parity` fails a view that exists in only one. Concretely: no meaning carried by colour alone; every mouse action has a keyboard equivalent (click-to-focus ↔ tab focus; drag-select ↔ keyboard selection); a screen-reader mode that emits linear text with explicit state announcements instead of ANSI redraws; remappable keys with a documented default set; a configurable contrast/theme set that also works under 16-colour terminals; and a `--no-alt-screen` path that keeps output in scrollback. Terminal restore is guaranteed on panic and signal, so a crash never leaves a raw-mode terminal.
- **Capability IDs.** `ui.present`.
- **Authority impact.** `none`.
- **Dependencies.** ADR-001; NF-006; `@horizoncode/tui`, `@horizoncode/ui`; `gate:frontend-parity`.
- **Status.** `DESIGNED`.

### NF-030 — Collaboration with presence

- **Problem.** Reviewing a long diff, approving a risky batch, or handing a task to a teammate is genuinely better with more pixels and a second person — and "here's my session id, I hope nobody else types" is not collaboration.
- **Design.** Shared live sessions with presence: who is attached, who is driving, who may approve. Approval authority follows the same origin-typing rule as everything else — a remote collaborator's approval is an explicit `UserAction` from an authenticated principal, never a `SessionBatch`. Share links are scoped, expiring and read-only unless explicitly granted the driver role; terminal panes are separate capabilities from approvals. All presence changes are events (`hz.collab.presence.changed` `[planned]`), and a session's collaboration log exports with its evidence bundle so "who approved this" is answerable offline.
- **Capability IDs.** `collab.manage` `[planned]`, `session.manage`, `ui.present`.
- **Authority impact.** `grant-bearing` — the driver/approver role is a grant, bounded and revocable.
- **Dependencies.** NF-006, NF-013, NF-022, NF-037; `@horizoncode/web`, `@horizoncode/desktop`.
- **Status.** `DESIGNED`.

### NF-031 — Enterprise managed policy

- **Problem.** An enterprise needs one enforceable policy across machines, without becoming a proxy for source code; and MDM-delivered configuration is an attack surface if unsigned.
- **Design.** A **signed**, cached managed policy (from MDM, a file, or an opt-in fetch) that can only *narrow* what the user already allows — a managed policy that tries to widen is refused and reported. Precedence is explicit and total: managed ≥ user ≥ workspace, where `≥` means "no more permissive". Policy carries a revision and digest, and it is validated **before** the sandbox is applied so a policy failure cannot be masked by confinement. MDM/managed-installer paths are first-class, SSO identity is used only to authenticate policy delivery and audit, and audit export (receipts + policy revisions + trust records) is a first-class command. Import from other agents' settings (hooks, MCP servers, commands, skill directories) is supported but maps into this lattice — imported settings can narrow, never grant.
- **Capability IDs.** `enterprise.policy.read` `[planned]`, `session.manage`, `receipt.read` `[planned]`.
- **Authority impact.** `narrows`.
- **Dependencies.** ADR-008; NF-003, NF-023, NF-017; `@horizoncode/core`; `hz.policy.revision.changed`.
- **Status.** `DESIGNED`.

### NF-032 — Plugin marketplace with signed manifests

- **Problem.** Extensions are the largest supply-chain risk in an agent: they run in the process, they see the code, and "install this plugin" is a one-click remote-code-execution decision.
- **Design.** A plugin declares a **signed manifest**: identity, version, publisher, checksums, and the exact capability IDs and effect classes it needs. Installation shows that declaration in capability terms before enabling anything, records a trust decision keyed on the manifest digest, and by default installs the plugin **disabled**. Execution runs in a sandboxed host with only the declared capabilities; an undeclared capability is refused at runtime even if the manifest was approved (defence in depth: approval is not permission). Updates re-verify the signature and re-prompt if the declared capability set grew. Uninstall removes its grants. A marketplace listing is a catalogue, never a trust shortcut — signing and verification are what count.
- **Capability IDs.** `plugin.install` `[planned]`, `plugins.invoke`.
- **Authority impact.** `grant-bearing` — installation grants a declared, bounded capability set, always through Guard.
- **Dependencies.** ADR-008, ADR-014; NF-003, NF-043, NF-014, NF-022; `@horizoncode/plugin`.
- **Status.** `DESIGNED`.

### NF-033 — Skill synthesis with eval verification

- **Problem.** A workflow the agent figured out once is thrown away; and auto-generated skills are exactly the kind of artefact that looks helpful and quietly does the wrong thing.
- **Design.** `skillify` turns a successful, receipted workflow into a candidate skill: Markdown with front-matter, declared tools, declared capability IDs, and the trajectory that motivated it. The candidate is **not offered** until it passes the evals harness (NF-039 + the eval suites): the trajectory is replayed, the skill is re-run on held-out tasks, and a regression or a capability-set growth fails the promotion. The skill then enters the library as a proposal with provenance (NF-010) and a lockfile entry, so later edits are reviewable diffs. Skills that cannot be evaluated are marked `unverified` and are visible as such wherever they are offered.
- **Capability IDs.** `learn.run` `[planned]`, `learn.propose` `[planned]`, `memory.write`; the skill's own declared capabilities at run time.
- **Authority impact.** **`none`** — a synthesised skill cannot declare a capability the promoting session does not already hold, and cannot widen it.
- **Dependencies.** NF-010, NF-034, NF-035, NF-039; `@horizoncode/skills`, `@horizoncode/learn`; `hz.learn.eval.completed`.
- **Status.** `DESIGNED`.

### NF-034 — Prompt tuning under cache discipline

- **Problem.** Prompt changes are the most common way to make an agent worse while making its benchmark better; and a naive A/B test changes the cache prefix, invalidating the comparison it is trying to make.
- **Design.** Candidate prompt variants are evaluated as **whole prefixes**: each variant is compiled, its prefix digest recorded, and only variants that keep the prefix contract (NF-005) are admissible for a production switch. Evaluation is paired on the same task set and the same model revision, with cost, latency, cache-hit rate and outcome all reported; a variant that improves outcomes by breaking caching is reported as such, not as a win. Promotion is a proposal (NF-010) with the eval evidence attached; rollback is a config revision change, not an edit, so a bad variant is revertible by digest.
- **Capability IDs.** `learn.run` `[planned]`, `learn.propose` `[planned]`, `providers.infer`, `context.manage`.
- **Authority impact.** **`none`** — prompt text never carries authority; postures remain kernel-enforced.
- **Dependencies.** NF-005, NF-010, NF-039, NF-035; `gate:cache-guard`.
- **Status.** `DESIGNED`.

### NF-035 — Trajectory dataset export

- **Problem.** Every run produces the data that would make the agent better on *this* codebase, and almost nobody can use it, because trajectories are trapped in a vendor-specific store or exported with secrets still in them.
- **Design.** A trajectory is a first-class, versioned record: task, compiled context digests, model and revision, steps, tool batch, guard decisions, receipts, evidence, budget, outcome and verdict. Export produces a portable dataset (JSONL + a manifest with a schema version) with **redaction applied on the outbound path** (NF-022) and secrets, keys and personal data removed by policy rather than by hope. Export can be scoped to a session, a run tree, a date range or a task set, and is receipted, so "this dataset came from those runs" is checkable. Import into tools (analysers, benchmarks, fine-tuning pipelines) is out of scope; the format is documented so others can consume it.
- **Capability IDs.** `learn.run` `[planned]`, `receipt.read` `[planned]`, `artifact.write`.
- **Authority impact.** **`none`** — export reads; it never changes policy or permission.
- **Dependencies.** NF-010, NF-022, NF-017, NF-026; `@horizoncode/learn`; `hz.learn.trajectory.recorded`.
- **Status.** `DESIGNED`.

### NF-036 — The `UNKNOWN` UX

- **Problem.** `UNKNOWN` is the honest answer when a process was killed mid-write, but a state machine that produces an honest `UNKNOWN` and a UI that renders it as "done" have undone each other.
- **Design.** `UNKNOWN` is surfaced as its own state everywhere — TUI, JSON output, server events, SDK types, session summary, exit code — with three properties: what was attempted (intent digest and capability), what is *not* known (the exact observation that is missing), and what the operator can do (reconcile, retry with a fresh lease, or abandon and record why). Reconciliation is an explicit action that appends `hz.effect.reconciled` with the evidence that resolved it; nothing about an `UNKNOWN` is ever auto-retried (`gate:no-unknown-retry`). A run containing unresolved `UNKNOWN`s cannot report success, and the evidence gate (NF-002) reports it as a lower verdict, naming the receipts.
- **Capability IDs.** `receipt.read` `[planned]`, `session.manage`.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-002, NF-009, NF-049; ADR-012; `hz.effect.unknown`.
- **Status.** `DESIGNED`.

### NF-037 — Editor bridge: bidirectional ACP, trusted device and replay

- **Problem.** Editors are the most-used surface for reviewing an agent's work, and the most poorly integrated: an extension that shells out to a CLI gets no session state, dies with the agent, and re-prompts for permissions it already has.
- **Design.** One bridge with three properties. **Protocol:** ACP as the stable surface, plus a JWT-authenticated channel for the vendor-specific extras (file state, terminal panes, diff review, permission callbacks). **Both directions:** HorizonCode acts as an ACP agent *and* can drive a host editor as a client (external-tool handoff), so "the IDE wired in" works whichever side owns the UI. **Replay:** the bridge caches session lifecycle state and replays it after a reconnect so a crashed leader does not produce "unknown session id"; replay is bounded to lifecycle frames, and a session that changed materially during the gap is reported rather than silently rewritten. Permission proxying preserves origin typing — an approval arriving over the bridge is attributed to the authenticated principal, never to the batch.
- **Capability IDs.** `session.manage`, `ui.present`, `secrets.read` (workspace secrets), `files.read`.
- **Authority impact.** `grant-bearing` — attaching a device grants a scoped session role; approvals remain bounded and receipted.
- **Dependencies.** NF-006, NF-030, NF-022, NF-014; `@horizoncode/acp`; `hz.bridge.attached` `[planned]`.
- **Status.** `DESIGNED`.

### NF-038 — Deferred tool discovery and capability-scoped tool catalogs

- **Problem.** A 60-tool catalogue in every prompt is expensive, hurts tool-selection accuracy, and exposes capabilities the current task cannot use.
- **Design.** The prompt carries a small **core** tool set plus a discovery tool (`tool_search`). Additional tools are described by a compact index (name, one-line purpose, capability ID) and materialised on demand; a materialised tool joins the next step's batch, and its arrival is an event (`hz.tool.discovered` `[planned]`). Catalogs are capability-scoped: a child session sees only the tools its grant permits, so discovery cannot surface a tool the session could not use anyway. A discovered tool entering the batch is still admitted through Guard like any other.
- **Capability IDs.** `tool.discover` `[planned]`, plus the discovered tool's own ID at use time.
- **Authority impact.** `none` — discovery reveals, it does not grant.
- **Dependencies.** NF-007, NF-005, NF-015; `@horizoncode/tools`; `gate:tool-declaration`.
- **Status.** `DESIGNED`.

### NF-039 — Hermetic provider record/replay harness

- **Problem.** Provider-dependent tests are slow, flaky, expensive and non-deterministic, so they get skipped — and then a regression in the loop ships.
- **Design.** A recorder/replayer in front of the provider transport: cassettes keyed on the request digest (prefix digest + tail digest + model + parameters), captured from real runs or hand-authored. Replay is byte-exact for the model's output stream, including tool-call deltas and finish reasons. Determinism extends past the provider: clock, randomness and identifiers are injected, so a replayed run produces the same decisions and the same events. The cache guard (NF-005) uses the same machinery to prove prefix stability, and the eval harness (NF-010, NF-033) uses it for regression suites that run offline in CI.
- **Capability IDs.** `providers.infer`, `learn.run` `[planned]`.
- **Authority impact.** `none`.
- **Dependencies.** NF-005, NF-026, NF-033, NF-034; `@horizoncode/testing`.
- **Status.** `DESIGNED`.

### NF-040 — Multimodal and voice I/O

- **Problem.** Real work arrives as a screenshot of a failing UI, a PDF spec, a diagram, a recording of a bug report — and agents that only read text make the human translate it by hand.
- **Design.** Input: images, PDFs, video frames and audio are ingested through declared tools (`view_image`, `attach`, `read_video`, `stt`) with size and type bounds, and the *derived* representation (resized image, extracted text, frames) is what enters context, so cost stays predictable. Output: charts, diagrams and rendered Mermaid go through a **separate process** with a wall-clock timeout — untrusted model output never executes in the agent process — and generated media lands in the artifact store (NF-027). Voice is streaming in both directions (`stt` dictation, `tts` read-back) and runs as a native primitive (`hz_voice`), never as a hosted dependency. Every ingestion and render is an effect with a receipt, and media that cannot be bounded is refused rather than truncated silently.
- **Capability IDs.** `files.read`, `media.render` `[planned]`, `voice.io` `[planned]`, `artifact.write`, `providers.infer`.
- **Authority impact.** `none`.
- **Dependencies.** NF-015, NF-027, NF-025 (media cost), NF-022 (media may contain secrets); `crates/hz_voice`, `crates/hz_native`.
- **Status.** `DESIGNED`.

### NF-041 — Observability: OpenTelemetry, GenAI conventions and a local dashboard

- **Problem.** When a run misbehaves, the evidence is spread across a terminal, a log file and a database, and the vendor's dashboard cannot be shown to a customer's security team.
- **Design.** Vendor-neutral tracing, metrics and logs using OpenTelemetry with GenAI semantic conventions, exporting to whatever the operator runs (or to nothing). Every span carries session, run, step, capability ID and receipt id, so trace and ledger join on an identifier instead of by timestamp guessing. A **local** dashboard reads the same data from the local store with no outbound call; telemetry export is opt-in, individually disableable, and redacted (NF-022). Metric definitions are stated, not implied (NF-050), and a metric without its definition is treated as a defect.
- **Capability IDs.** `ui.present`; all capabilities are observed, none are granted.
- **Authority impact.** `none`.
- **Dependencies.** NF-022, NF-025, NF-050; `@horizoncode/observe`; ADR-013.
- **Status.** `DESIGNED`.

### NF-042 — Language intelligence: one LSP/DAP host broker

- **Problem.** Language-server and debugger wiring is the most duplicated, least testable part of an agent: every surface wants diagnostics, and every one starts its own servers.
- **Design.** One broker owns language-server and debug-adapter processes per workspace: capability-gated start (`language.*`, `debug.session`), workspace-trust-gated per project, one server per language per workspace with a bounded pool, and a uniform operation set (document sync, diagnostics, symbols, definitions, references, rename, formatting, code actions, pull diagnostics, restart; and for DAP: launch/attach, breakpoints, stepping, stack, scopes, variables, evaluation, and so on). Operations may be *diagnostic* (read-only) or *mutating* (rename, format, code action), and the mutating ones are effects with receipts like any edit. Server failures degrade to a typed, visible state; a dead server is never reported as "no diagnostics".
- **Capability IDs.** `language.symbols`, `language.diagnostics`, `language.rename`, `debug.session`, `repl.eval`.
- **Authority impact.** `none` (reads); mutating operations take `files.patch`/`files.write` and are receipted.
- **Dependencies.** NF-015, NF-038, NF-016 (server processes are confined); `crates/hz_native`.
- **Status.** `DESIGNED`.

### NF-043 — Extension protocol v2 and a capability-declaring plugin host

- **Problem.** Extensions that run in-process with ambient authority; extension APIs that break every release; and no way for an extension to add a provider or a UI without forking the agent.
- **Design.** Out-of-process extension runtime with a versioned protocol, a generated machine schema (drift-checked in CI), and a first-class SDK. Extensions may intercept lifecycle events, occupy declared replacement slots, contribute providers, tools, commands, hooks, themes and structured UI — but every contribution declares the capability IDs it needs and is admitted through Guard at use time. Extensions are **full trust by declaration**: the host states that plainly, and the manifest (NF-032) is the mechanism that makes the declaration checkable. Protocol revision is negotiated at handshake; a mismatched extension fails closed with a typed error rather than partially working.
- **Capability IDs.** `plugins.invoke`, plus contributed capabilities; `ui.present` for contributed UI.
- **Authority impact.** `grant-bearing` — contributions are bounded by declared capabilities, admitted per use.
- **Dependencies.** NF-032, NF-014, NF-003; `@horizoncode/plugin`; `crates/hz_codegen`.
- **Status.** `DESIGNED`.

### NF-044 — Provider breadth: catalog, wire codecs and local servers

- **Problem.** Vendor lock-in by accident: a new model appears, and the agent needs a release to speak to it.
- **Design.** A `models.dev`-style catalog snapshot plus **native wire codecs** (chat completions, responses, messages, Gemini, Bedrock converse/event-stream, Vertex, Cohere, Mistral, and the OpenAI-compatible fallback) kept separate from *endpoint configuration*. A vendor endpoint is configuration — base URL, auth, headers, quirks — never code, so adding a provider is a data change with a conformance test. Local servers (Ollama, LM Studio, vLLM, llama.cpp) are first-class, including capability discovery and reasoning/thinking level mapping. Model metadata (context window, pricing, tool support, vision, reasoning) comes from the catalog; a model missing metadata is refused for the features that need it rather than silently assumed.
- **Capability IDs.** `providers.infer`, `models.list`.
- **Authority impact.** `none`.
- **Dependencies.** NF-005, NF-024, NF-050, NF-048 (codec provenance); `@horizoncode/provider`.
- **Status.** `DESIGNED`.

### NF-045 — Plan, Goal and Todo state machines with an approved-plan window

- **Problem.** Plans in chat text are not state: an approved plan cannot be enforced, a todo list cannot be leased, and "we agreed to do X" is unreviewable.
- **Design.** Three related but distinct machines. **Todo** items are durable with an owner and a **lease** — an item being worked on is held by an attempt, so two agents cannot silently work the same item and an abandoned item expires back to the pool. **Goal** is the user-facing objective with a completion condition, and it is the unit the evidence gate evaluates. **Plan** is a proposed sequence with an explicit approval transition; approval opens a bounded execution window during which the approved tool set auto-approves (and only those), and the window closes on plan completion, abandonment, policy revision change or budget exhaustion. Plan mode is a *posture* change, kernel-enforced, not a prompt instruction.
- **Capability IDs.** `context.manage`, `session.manage`, `agent.spawn`; the approved window narrows to the approved tool set.
- **Authority impact.** `none` for the state machines; the approved window is `grant-bearing` only through the existing grant mechanism (NF-014).
- **Dependencies.** NF-014, NF-018, NF-025, NF-004; `crates/hz_kernel`; events `hz.plan.updated`, `hz.todo.updated`, `hz.goal.updated`.
- **Status.** `DESIGNED`.

### NF-046 — Distribution: one static binary, thin mobile, nested desktop, digest-pinned updates

- **Problem.** An agent that needs a package manager, a runtime and a build toolchain to start cannot be run on the machine that has the bug; and an auto-updater is a remote-code-execution channel if it is not pinned.
- **Design.** One statically linked binary per platform as the primary artefact (`hzcode`, aliases `hz`, `horizon`), plus the kernel asset (`hzk` / `hzk.exe`) shipped alongside with a **SHA-256 pin and a manifest checked at startup** — a kernel that does not match its pin is refused, and the agent runs read-only rather than unguarded (ADR-003). Distribution channels (npm, brew, apt, scoop, nix, docker) are wrappers over the same artefacts, not alternative builds. Mobile is a **thin client** of the server surface, not a cross-compiled kernel. Desktop lives in its own module against the published protocol, so its build needs cannot contaminate the CLI's static guarantee. Auto-update is opt-in, channel-scoped, digest-pinned and signature-verified before anything is replaced; a failed verification leaves the previous version running.
- **Capability IDs.** `process.spawn` (self-update effect); `session.manage` for the client surfaces.
- **Authority impact.** `none` — but the kernel pin is an integrity control the rest of the design depends on (`gate:kernel-pin`).
- **Dependencies.** ADR-003, ADR-014; NF-006, NF-048; `@horizoncode/cli`; `gate:kernel-pin`.
- **Status.** `DESIGNED`.

### NF-047 — Documentation-as-authority with machine-checked status levels

- **Problem.** Prose that describes protections the code does not enforce is worse than no documentation: it is a false attestation, and it is the failure mode this whole spec set exists to avoid.
- **Design.** Every capability has a **status level** (`DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED`) and every claim of a level cites evidence. A machine check (`gate:doc-status`) parses the status tables and fails when a document claims a level above its cited evidence, when a claimed level names no test, when a `VERIFIED` claim cites no receipt or test artefact, or when a capability disappears between revisions without a withdrawal note. Documents have owners (the owning document is the topic's authority), the ownership map is itself checked for orphans, and the same ratchet that governs code debt governs prose debt. The rule the ancestor states, and this document repeats: **a design, an old CI success or a proposed code snippet is not executable proof**.
- **Capability IDs.** none — this is a process capability; it gates the others.
- **Authority impact.** `none`.
- **Dependencies.** ADR-014; `gate:doc-status`, `gate:repolint-debt`, `gate:wire-parity`; NF-048; `25-roadmap-and-glossary.md` §4.1.
- **Status.** `DESIGNED`.

### NF-048 — Derivative provenance discipline

- **Problem.** HorizonCode is an overlay on pinned upstreams and inherits code and ideas. Untracked inheritance is a legal liability, an unmergeable fork and an audit failure.
- **Design.** A provenance register maps every inherited file to its origin (project, path, revision); upstream pins are recorded with revision digests and re-hydration is scripted; derivative code carries its attribution, including Apache §4(b) change notices where applicable; and overlay status against each pinned upstream is auditable at any time. `gate:provenance` fails a change that adds inherited code without a register entry, or that modifies inherited code without preserving its notice. The register is machine-readable and the human-readable `NOTICE` is generated from it, so the two cannot disagree.
- **Capability IDs.** none.
- **Authority impact.** `none`.
- **Dependencies.** ADR-014; NF-047; `gate:provenance`.
- **Status.** `DESIGNED`.

### NF-049 — Run supervision, crash recovery and lane health

- **Problem.** The ancestor's measured state is the argument for this feature: lanes that are *off* while reporting green (`DIRECT_CHILD_TURN_RPC_ENABLED = false`, LSP/DAP routes returning `false`, a completion gate accepting an arbitrary digest string). A dead lane that lies is worse than a lane that is absent.
- **Design.** Three parts. **Supervision:** a supervisor lease per active session, renewed only on real progress, so a stalled or wedged run is detected and reported rather than hanging. **Recovery:** after a kill, the claim in the log says exactly which attempts were in flight; recovery resumes them with fresh leases or marks them `interrupted`, and any effect whose observation is missing becomes `UNKNOWN` for explicit reconciliation. **Lane health:** every optional lane declares its availability at startup and reports it truthfully; a disabled lane returns a typed refusal with the reason and is visible in `hzcode doctor` and in the capability matrix, so a green test run cannot be produced by a lane that did nothing. `gate:dead-lane-fail-closed` enforces the reporting side.
- **Capability IDs.** `session.manage`, `receipt.read` `[planned]`; kernel supervisor leases.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-036, NF-028, NF-026; ADR-012; `crates/hz_kernel` (`supervisor_lease.rs`, `supervisor_session.rs`); `gate:dead-lane-fail-closed`.
- **Status.** `DESIGNED`.

### NF-050 — Append-only vendor price table and metric definitions

- **Problem.** Cost accounting that silently rewrites history: a vendor changes a price, the table is edited in place, and last month's report no longer reconciles. And a number whose definition lives only in someone's head is not a metric.
- **Design.** The price table is **append-only**: a rate change adds a revision with an effective date, and historical usage keeps citing the revision it was recorded under. A price-check tool compares the table against vendor pages on demand (network access, manual run — never in CI, so a vendor outage cannot fail a build), and the diff is a review artefact. Every budget and usage record names its rate revision, so any cost figure is reproducible from the log. In the same spirit, **a metric is its definition**: every metric the system publishes states what it counts, from which anchor, over which population and excluding what, before a number is treated as a finding — and a defect report requires a reachability contract (how the defect is reached) rather than a screenshot.
- **Capability IDs.** `providers.infer`, `models.list`.
- **Authority impact.** `none`.
- **Dependencies.** NF-025, NF-041, NF-044; `@horizoncode/provider`.
- **Status.** `DESIGNED`.

---

**NF-051 … NF-062.** Added by the second learning pass (`docs/26-learning-synthesis-2.md` §4; ratified by RC-12).

### NF-051 — Code Mode v2: confined programming over the tool tree with per-nested-call authority

- **Problem.** One tool call per round-trip cannot express search-and-filter work; but a scripting surface that can mint leases, launder data into authority, or hide calls from the static subset would be a privilege grant wearing a sandbox.
- **Design.** Deepen the existing `code_mode` contract per `docs/26` §2.5: canonical `tools.<path>` projection (dots as namespace separators, one canonical spelling, namespace descriptions joining discovery); **static and total subset enforcement** via an AST scanner (dynamic access, aliasing, and passing `tools` are rejected before any effect); discovery inside the snippet lowers to the ordinary `tool_search` pipeline (admitted, counted, paginated — never a private registry read); per-call `tool.before`/`tool.after` hooks are the authority seam (a failing before denies); every nested call re-enters the ordinary pipeline and produces its own lease and receipt, reported in the audit table as `{toolId, toolCallId, leaseId, receiptId?, terminalState, ms}`; snippet state (`store`/`load`) is JSON-only, session-scoped, snapshot-per-exec, never authority; cells are first-class (`cellId?`, `action: exec|wait|terminate`, yield-by-default) and **termination never counts as settlement** (in-flight calls settle or become `UNKNOWN` for reconciliation). Confinement is declared as a guarantee vector with typed residuals, never as an engine brand: either an allowlisted-subset interpreter (no ambient I/O by construction) or an engine with JIT/codegen disabled, ambient globals deleted, and a heap cap that is actually enforced; the operation fails closed (`SandboxUnavailable`) when the caller's minimum cannot be met. Preview of the rules: CM-1…CM-14 (`docs/26` §2.5).
- **Capability IDs.** `codemode.execute`; inner calls use their own capability IDs.
- **Authority impact.** `kernel` (lease-amplification ceiling decided before the cell starts; the approval is bound to the declared subset and snippet hash, single-use).
- **Dependencies.** NF-001, NF-016, NF-015 (native engine path); tools `code_mode`, `tool_search`; `gate:receipt-coverage`, `gate:no-unknown-retry`; `crates/hz_kernel` (`codemode_protocol.rs`).
- **Status.** `DESIGNED`.

### NF-052 — ACI reading modes: windowed read, summary search, window-scoped edit, lint gate

- **Problem.** Unbounded dumps spend tokens with no orientation: the model does not know how much of a file it has not seen, a failed edit gets a blind retry, and a search returns 500 matches when the model needed the five files that matter.
- **Design.** Phase 1 (no new authority): windowed `read` (default 100-line window, 2-line overlap, `gotoLine` placing the target ~1/6 down, `cursor: open|next|prev` over a session cursor refreshed only from observed effects, `view{firstLine, lastLine, totalLines, moreAbove, moreBelow}` rendered as `(N more lines above/below)`); `grep mode:'summary'` returning per-file counts and refusing above 100 files with a narrowing hint (no list); window-scoped `edit` where a unique match elsewhere fails with `matchesOutsideWindow` + a repair hint; a postimage syntax gate that, when a syntax check exists, **reverts** any edit introducing new diagnostics (category `syntax-break`, bytes untouched, both windows shown); append-only `insert`; narrated empty results; every truncated result carries a `recoveryHint` naming a cheaper follow-up call; and an environment-derived state line (`openFile`, window, `cwd`) that is never model-authorable and never evidence for `verify`. Phase 2 (behind a preset): an `aci.open/goto/scroll/find/insert` tool group, sharing the Phase-1 rendering contract. Shell defaults are tamed (`PAGER`/`MANPAGER`/`GIT_PAGER=cat`, `LESS=-R`, `TQDM_DISABLE=1`, `PIP_PROGRESS_BAR=off`).
- **Capability IDs.** `files.read`, `files.patch` (no new IDs in Phase 1).
- **Authority impact.** `none` (Phase 1); Phase 2 group is subject to `gate:tool-declaration`.
- **Dependencies.** NF-005, NF-061; tools `read`, `grep`, `edit`, `insert`; `@horizoncode/tools`.
- **Status.** `DESIGNED`.

### NF-053 — Pre-submit governance loop and AGENTS.md workflow FSM

- **Problem.** "Done" is a claim, not a state: agents submit with the repro script still in the tree, tests edited to pass, and no verification run — or they skip a mandated test phase entirely, and nothing stops them.
- **Design.** Two halves. **Pre-submit review gate:** completion may require a configurable, ordered review loop before the final answer — re-run the reproduction, remove repro artifacts, restore test files (`git checkout --` the protected paths), then resubmit; bypass exists only as an explicit, audited force path. **Governed workflow:** an AGENTS.md `## Workflow` block (or `.hz/workflow`) declares a state machine (Plan → Propose changes → Await verification → Enforce linting) that the runtime compiles into the plan FSM; a transition that skips a required phase or breaches a declared constraint is refused, the workspace state is rolled back to the last committed plan checkpoint (itself effects with receipts), and the model must re-plan. Governance structures authority; it never adds any — the FSM can only demand *more* verification, never fewer grants.
- **Capability IDs.** `terminal.run` (the verification, test and lint commands this loop re-runs all execute through the exec-class capability — no new IDs), `files.patch` (restore); `vcs.write` is not used — restore runs through `files.patch`/`git checkout` under policy.
- **Authority impact.** `kernel` (rollback = revert effects with receipts; the force path is audited).
- **Dependencies.** NF-001, NF-002, NF-012; `update-checkpoint`/`rewind` machinery (doc 12); tools `verify`, `complete_step`.
- **Status.** `DESIGNED`.

### NF-054 — Execution recorder and time-travel debug

- **Problem.** When a run fails inside the sandbox, the model gets a print statement and guesses; root-cause debugging from static logs is the single most expensive failure loop in long-horizon work.
- **Design.** On a failed verification run (or on explicit ask), capture a **recorded execution trace** of the failing command — rr on Linux first (deterministic record/replay), WinDbg TTD/ETW on Windows, and on platforms where no recorder exists a typed residual naming the unavailability (never a silent downgrade). The trace is an artifact (`hz://artifact/<sha256>`, bounded, retention-policy-aware); the model re-runs *backwards and forwards* over it through DAP operations (`debug.*`: breakpoints, stepping, reverse-continue where supported, stack/scopes/variables) instead of adding print statements. The recorder is a runtime service under the sandbox rules (process tree, resource caps, no network by default), started and stopped via capability-gated calls.
- **Capability IDs.** `debug.record` `[planned]`, `debug.session`, `artifact.write`.
- **Authority impact.** `grant-bearing` (recording spawns and instruments a process; always through Guard, lease and receipt).
- **Dependencies.** NF-016, NF-042; tool `debug`; `crates/hz_kernel`; `hz.debug.recording.captured` `[planned]`.
- **Status.** `DESIGNED`.

### NF-055 — Preview environments with bound-URL injection

- **Problem.** UI work needs to *see* the app, not imagine it; and agents guess dev-server ports because nothing tells them the real bound URL.
- **Design.** An ephemeral, sandboxed preview runtime: `preview.serve` starts the workspace's app under the sandbox guarantee vector, the runtime injects the **actual bound URL(s)** into session context (`runtime_services` pattern — the model is never allowed to guess a port), and edits re-render the preview for a tight change→look→fix loop. Preview instances are per-session, capped in count and lifetime, torn down with the session (teardown completeness checked like any runtime service), and every start/stop is an event (`hz.preview.started`/`hz.preview.stopped` `[planned]`). Egress policy applies unchanged; a preview that needs network access declares it like any other effect. Explicitly a UI-work feature, not the default loop.
- **Capability IDs.** `preview.serve` `[planned]`, `terminal.run`, `net.fetch` (as declared).
- **Authority impact.** `grant-bearing` (spawns a listener; Guard, lease, receipt).
- **Dependencies.** NF-016, NF-026 (lane health), NF-036; `hz.preview.*` `[planned]`; doc 14 surfaces.
- **Status.** `DESIGNED`.

### NF-056 — Tier-parity program: cheap models with frontier contracts

- **Problem.** The same task on a cheap model produces hedged, under-verified output; nobody can tell whether a harness change narrowed or widened the gap, because there are no paired measurements.
- **Design.** A standing program, not a feature flag: (a) a **seed task suite** run in paired mode (cheap model vs the strongest configured) per task class — multi-file refactor, bug-fix-with-tests, architecture sketch, long-horizon plan; (b) **strict-REPL tool variants** for weak models (`bash_only`-style: lower observation caps, head/tail split templates, one command per turn, tighter schemas); (c) **anti-hedging output rules** (verdict schemas and evidence refs from NF-002, not prose confidence); (d) a **parity ratchet** in CI: a per-class regression blocks the release, and improvements ratchet like Section A dispositions. Results are recorded with model revision, harness revision, and task digest. The router (NF-004) uses the parity tables to dispatch a task class to the cheapest model that meets the bar.
- **Capability IDs.** `providers.infer`, `models.list`.
- **Authority impact.** `none`.
- **Dependencies.** NF-002, NF-004, NF-044; `gate:parity-ratchet` (extended to eval classes); doc 25 M-ladder.
- **Status.** `DESIGNED`.

### NF-057 — Local inference acceleration and micro-model orchestration

- **Problem.** Local/edge models matter for cost and privacy, but naive local serving is slow and its prompt cache is thrown away on every retry; and small mechanical steps (parse, classify, extract) are needlessly sent to the flagship model.
- **Design.** Two parts. **Acceleration:** documented, tested recipes for provider-side speculative decoding (llama.cpp/vLLM) and prompt-cache/KV reuse across retries and compaction boundaries; the provider policy engine treats local endpoints like any provider (policy applies regardless of how a provider becomes known). **Micro-orchestration:** within Code Mode (NF-051), a `models.run()`-style primitive lets a snippet call a local micro-model for mechanical work (regex extraction, classification, parsing) while the master model architects; every micro-model call is an ordinary inference effect with a receipt and counts against budgets. Both parts are declared capabilities, never ambient: no snippet or plugin reaches a model without policy.
- **Capability IDs.** `providers.infer`; micro-calls receipted under `providers.infer`/`codemode.execute`.
- **Authority impact.** `none`.
- **Dependencies.** NF-051, NF-058, NF-050 (rate revisions for local models); doc 07 provider contracts.
- **Status.** `DESIGNED`.

### NF-058 — Policy statements: allow-never-grants, safety-inverted precedence

- **Problem.** A repository can ship config that silently *widens* what runs; "allow" entries get confused with grants; and an enforcement mechanism that a workspace (or plugin) can switch off is not enforcement.
- **Design.** An OpenCode-V2-derived statement layer over the doc-11 authority model: statements `{effect: allow|deny, action, resource}` with wildcards, evaluated **last-match-wins**. Precedence is **safety-inverted**: ordinary settings read forward (workspace overrides user), but policy documents read **reversed** (user-global beats repository), with managed-org statements appended last — an organization deny cannot be lifted by a repository or user allow. **An allow never grants:** it only cancels an earlier, broader deny; a deny overrides `ask` and saved "Allow always" approvals. Denials name their decider ("Blocked by configuration policy" / "Blocked by <organization>'s policy"). Fetch failure keeps the last snapshot (dropping it would fail closed for providers but **open** for policy). **Enforcement protection:** plugins may not add, remove, or override policy, and enforcement modules (policy engine, managed-policy fetch) are immune to config removal selectors in every scope; unknown actions are skipped preserving order while malformed supported statements remain errors.
- **Capability IDs.** `enterprise.policy.read` `[planned]`; all effect classes as targets.
- **Authority impact.** `kernel` (extends doc 11's merge lattice; the lattice property *narrowing-only* is preserved).
- **Dependencies.** NF-003, NF-031; ADR-007; `crates/hz_policy`; doc 15 §7.7 (`.hz` supplies content, never authority).
- **Status.** `DESIGNED`.

### NF-059 — Instruction epochs and content-addressed instruction blobs

- **Problem.** Instruction files (AGENTS.md hierarchy, skills, rules) change mid-session; rewriting prompts into the transcript makes the log huge, leaks privileged prose to clients, and breaks prefix stability.
- **Design.** Instruction sources are stored as **content-addressed blobs**; the session observes value-delta events (`hz.session.instructions.updated` `[planned]`: `{delta: {key → digest|"removed"}, text?}`) rather than prose copies. An **instruction epoch** spans completed compactions (compaction moves the epoch start; the previous epoch's held values are re-evaluated and re-issued as deltas if changed). A fork adopts the parent's newest instruction values as its baseline and thereafter observes its own deltas. Display surfaces render *changed keys*, never privileged text. An instruction change is a context event, never a grant: it cannot widen a capability ceiling, posture or policy (ADR-010 boundary).
- **Capability IDs.** `context.manage`.
- **Authority impact.** `none`.
- **Dependencies.** NF-005, NF-008 (memory/context tiers); doc 10 AGENTS.md hierarchy; `@horizoncode/context`.
- **Status.** `DESIGNED`.

### NF-060 — Event-feed laws and stream framing

- **Problem.** Naive per-client event serialization collapses under many clients; a slow client can stall the publisher; and clients cannot distinguish a replay gap from an empty history.
- **Design.** **Feed laws:** one global subscription encodes each event **once**; the shared immutable frame is offered non-blockingly to per-connection bounded queues (capacity 4,096); a slow or stalled connection MUST NOT stall publication or any other subscriber (the isolation invariant). HorizonCode keeps its own **resumable** overflow policy from doc 07 C11 (`page_end` / `resnapshot_required`) rather than terminating the connection — the absorbed parts are the encode-once architecture and the isolation invariant. An encoding failure logs, fails connected queues with `EncodingError`, skips the malformed event, and **keeps the feed available for later connections**. **Framing:** one stream carries two durability classes — `durable` frames (carry the log `seq`) and `transient` frames (never persisted, no seq); replay is preceded by a **sync preamble** declaring the range (`from_seq`/`through_seq`) so a consumer can prove contiguity and request the missing range; pagination is strict (unsupported ≠ empty — a partial history is never mistaken for exhaustion); transport errors are never session errors (no socket drop becomes an `hz.error.raised`); unknown frame types are ignored by contract so the envelope can grow.
- **Capability IDs.** `session.manage`, `ui.present`.
- **Authority impact.** `none`.
- **Dependencies.** NF-006, NF-037; doc 07 §4.4 stream framing; `@horizoncode/server`, `@horizoncode/protocol`.
- **Status.** `DESIGNED`.

### NF-061 — Tool-result dual output with fail-closed retention

- **Problem.** One payload cannot serve three consumers: the model needs bounded durable text, Code Mode and local consumers need the schema-validated machine value, and the UI needs compact metadata — and a "lossy success" (preview substituted when retention failed) is a silently corrupted record.
- **Design.** Every tool result carries three fields: `output` (machine value, schema-validated, **ephemeral** — visible to Code Mode and local consumers, not durable history), `content` (durable, model-facing, bounded), `metadata` (compact UI JSON, independently validated, never an unbounded side-channel). A tool without machine output must provide non-empty model content. Bounding is head+tail with a middle omission marker; oversized payloads are retained in managed storage and replaced by a bounded preview — and **if complete retention fails, the execution fails operationally rather than publishing lossy success**. Domain storage is encapsulated: what is stored never changes according to model-output bounding or retention policy. Cancellation discipline rides the same contract: interruption and defects are never translated into model-visible tool failures (broad catch around execute is invalid); the terminal-state enum (RC-7) already carries `cancelled`/`interrupted`.
- **Capability IDs.** `context.manage`, `artifact.write`.
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-005; doc 05 `ToolResultV1` (queued update), doc 09 rendering rules.
- **Status.** `DESIGNED`.

### NF-062 — Composer and review UX: queue editing, bulk review, rich input

- **Problem.** The queue is read-only (you can add, not fix); review is per-hunk only (no whole-run action); fenced code arrives unlabeled; and pasted attachments lack previews — friction that pushes users back to editing prompts outside the tool.
- **Design.** **Queue:** queued messages are editable and reorderable before dispatch (edits are ordinary input mutations; ordering changes are scheduling changes, recorded), with steering semantics unchanged (no message bypasses the Safe Step Boundary). **Review:** per-hunk Keep/Undo stays, plus **Keep All / Undo All** for the whole run — both remain explicit user-authority effects (`files.patch` under the review lease) and both are receipted. **Rich input:** fenced code blocks render with language detection and highlighting (RTL/LTR supported); pasted images/files become attachment chips with previews, stored as artifacts with digests, and only sendable under `session.manage`-gated ingestion — binary content never enters the text transcript, only its artifact reference. Composer content is data, never authority.
- **Capability IDs.** `ui.present`, `session.manage`.
- **Authority impact.** `none`.
- **Dependencies.** NF-006, NF-011 (`hz://` artifacts), NF-039; docs 13/14.
- **Status.** `DESIGNED`.

---

**NF-063 … NF-070.** Added by the final audit (`29-final-audit.md` §B.1; sources: the six delta audit reports in `docs/audit/`, dated 2026-11-06). Each row merges two or more independent reference devices where they existed; the audit's Part B.1 records the full merged/appended/queued classification of all 270 delta findings.

### NF-063 — Workspace checkpoints and staged undo/redo

- **Problem.** A bad edit is recoverable only by asking the user to run git commands; "undo that" is the most common correction and the agent cannot serve it. Forgecode ships snapshot `undo`, opencode ships staged undo/redo with gitignore-aware pruning, and the ancestor's checkpoint restore exists — none of it is in this register.
- **Design.** A checkpoint is taken before every mutating write (content-addressed preimage snapshot). `undo` reverts the most recent operation on a path, and **restore is a guarded effect, never direct file writes**: every restore write goes through the ordinary ToolBatch → lease → receipt path (the ancestor's explicit rule — "restore NEVER writes workspace files with fs directly"), so a failed admission mutates nothing. Interactive undo is **two-phase**: stage the rollback, the user edits/keeps the staged prompt, commit or cancel — the staged state is recorded like any input mutation, so `/redo` is a cancel of a staged, not yet committed, rollback. Snapshots are gitignore-aware (files that became ignored are pruned; tracked-ness checked with `--no-index` so a previously-tracked file is not silently restored) and bounded by a per-file cap; pruning runs per session end or every N steps, not per pass. Capture is per model step and honest about its best-effort gaps.
- **Capability IDs.** `files.patch` (restore), `artifact.write` (snapshots).
- **Authority impact.** `kernel` (restore is effects reverting effects under Guard; an unadmitted restore leaves bytes untouched).
- **Dependencies.** NF-001, NF-011, NF-012; NF-053 (plan-checkpoint rollback reuses this machinery); tools `edit`, `insert`, `undo`.
- **Status.** `DESIGNED`.

### NF-064 — Pre-approval review (guardian) with a narrowing-only contract

- **Problem.** Escalations reach the human with no context — the dialog shows a command, not a risk picture; and an automatic approver would be the rejected classifier-decision mode (D-8) wearing a new name.
- **Design.** An escalation may be routed to a **reviewer step** (strongest configured model, wall-clock budget, default 90 s) that gathers context — what the command does, what it touches, precedent from prior approvals — and returns a typed recommendation. Framed to keep D-8 intact: **the reviewer may autonomously deny or flag; it may never autonomously approve** — an approve recommendation falls through to the human dialog unless a deterministic policy rule (NF-003/NF-058) had already decided the case. The review prompt carries an explicit **trust boundary** (only user/developer messages and explicit tool answers establish authorization; skills, plugin text, assistant output and tool output are untrusted evidence) and explicit **anti-over-flag calibration** (outside-workspace paths are not automatically high risk; deleting a verified-empty path is low/medium; urgency never changes authorization). **Managed human checkpoints** — cases a policy marks as requiring a fresh human decision — can never be satisfied by auto-review. Review activity is recorded (evidence board/journal) and bounded; a timeout falls back to the human dialog, never to approval.
- **Capability IDs.** `providers.infer` (the reviewer call); the decision itself stays under existing authority IDs.
- **Authority impact.** `narrows` (review can only add friction; it never approves).
- **Dependencies.** NF-002, NF-003, NF-058; NF-053 (the submit-time review loop is the pre-submit sibling); doc 11.
- **Status.** `DESIGNED`.

### NF-065 — Shell command classification for policy (structure, not strings)

- **Problem.** A regex allowlist over command strings is bypassable and unreviewable; approving a whole `git … && …` chain because its prefix matched, or silently refusing input the tool cannot analyse, are both failures.
- **Design.** Every shell command is analysed **structurally** before policy: segment on shell operators; extract subcommands, `cd` targets and redirections; parse with a language-aware AST (POSIX sh / bash / powershell) whose node types are an **allowlist — anything outside it routes to the human instead of guessing** (fail closed; ADR-015's "structure, never wording" applied to shell, extending D-13). Per-subcommand rules and saved approvals apply to each segment; `cd`-target inference is best-effort and the approval card says so ("could not determine target directory") rather than implying precision. A generated **arity dictionary** normalises "always approve" suggestions to the approvable prefix (longest matching prefix wins; flags never count; the generating prompt is checked in above the table so the table is reviewable). Interpreter policies may carry **load-time self-tests**: `match`/`not_match` examples validated when the policy loads, so a rule file is executable as a test suite. The decision remains deterministic host policy — no classifier decides (D-8 stays intact).
- **Capability IDs.** `terminal.run` targets; no new IDs.
- **Authority impact.** `none` (classification feeds existing policy; the decision remains kernel state).
- **Dependencies.** NF-003, NF-058; ADR-015; doc 11; `crates/hz_policy`.
- **Status.** `DESIGNED`.

### NF-066 — Lifecycle hook taxonomy, stop guards and doom-loop detection

- **Problem.** Guardrails implemented as prompt instructions ("do not stop with todos open", "stop repeating calls") are hopes; and an under-specified hook surface — HTTP hooks with no allowlist — is an exfiltration path wearing an extension API.
- **Design.** Two halves. **Hook surface:** a declared lifecycle event taxonomy (session start/end, request/response, tool-call start/end, compaction, instruction-load, file-change, worktree events, elicitation, config-change — the union of the observed sets) where every handler type has declared effects: command hooks run as ordinary effects (Guard, lease, receipt — no ambient authority); **HTTP hooks are admitted only with a URL allowlist and an env-var interpolation allowlist**; async hooks may **re-wake the model only on a blocking exit code** (`asyncRewake`-style), so a background hook cannot loop the agent; an `End`-class hook may append messages and **re-open the loop**, which is the mechanism the stop guards use. **Stop guards:** (a) doom-loop detection over tool-call signatures — consecutive `[A,A,A]` and cyclic `[A,B,C][A,B,C]` repetition at threshold 3 — injecting a corrective reminder rather than aborting the session; (b) pending-work enforcement: stopping with unfinished todos re-opens the loop with a deduplicated reminder listing them; (c) stall handling for goal loops (NF-067). Guards are composable policies, individually disableable, and never prompt-only.
- **Capability IDs.** Hook handlers operate under existing effect IDs; guard reminders are context events, not grants.
- **Authority impact.** `grant-bearing` (a hook handler performs effects; declared and admitted per use).
- **Dependencies.** NF-001, NF-032, NF-043, NF-067; doc 15; tool `todo`.
- **Status.** `DESIGNED`.

### NF-067 — Bounded autonomous goal loops

- **Problem.** "Keep working on X until done" is expressed by re-typing prompts; an unattended loop without caps is a denial-of-service against the user's machine and their invoice.
- **Design.** A first-class goal primitive: an objective (bounded, e.g. ≤ 4,000 chars) persists across compaction and carries a **round/token budget** (e.g. ≤ 50 rounds), a **stall classifier** (no-progress after N consecutive rounds; "blocked" requires three consecutive blocked turns before a goal may report blocked), a **completion audit** run before the goal closes, and capped waits (e.g. ≤ 30 min per wait state). Process identity is respected: a goal whose owning process died is **demoted to paused**, never silently resumed by a new process. All work remains under the session's existing grants — the goal primitive changes the loop's persistence, never its authority — and NF-066's guards fire inside it.
- **Capability IDs.** `session.manage`; goal work uses the ordinary tool IDs.
- **Authority impact.** `none`.
- **Dependencies.** NF-066, NF-028 (stall notifications); docs 08/10.
- **Status.** `DESIGNED`.

### NF-068 — Side-question forks with cache sharing

- **Problem.** A quick side question ("btw, what does this function do?") either derails the main transcript or costs a cache-cold context in a fresh session — so users paste it into a chat window instead, dragging context out of the tool.
- **Design.** A side-question fork: a second conversation that **reuses the parent's prompt-cache material** (cache-safe parameters captured per turn by the loop — not re-derived per command), carries **no tools** (it cannot drive the workspace), and cannot mutate or derail the main transcript. Its answer returns to the user directly and enters the main context only on explicit action. Available from the CLI and from surface clients via the same protocol.
- **Capability IDs.** `ui.present`, `providers.infer`.
- **Authority impact.** `none` (no tools; read-only context reuse).
- **Dependencies.** NF-004, NF-005; doc 14.
- **Status.** `DESIGNED`.

### NF-069 — Tool-argument repair and self-healing edit ladders

- **Problem.** Models emit malformed or truncated JSON arguments and near-miss edits; today each is a failed turn, and the model's only recovery is a blind retry.
- **Design.** Two ladders, both constrained to **unambiguous** repairs — never guessing intent. (a) **Argument repair:** every tool-call argument blob passes a bounded repair pipeline (named repair classes — quotes, unicode, truncation, punctuation, numbers, … — with a depth cap) plus schema coercion before rejection; the schema must unambiguously support the rewrite, each repair is recorded on the call, and the repaired call still passes Guard unchanged. (b) **Edit ladder:** `edit` resolves exact match first; on no-match a line-range fuzzy match may apply, then patch synthesis; and after any write a **post-write syntax/diagnostic check** runs, with its result fed back in the tool result (new diagnostics are treated as NF-052's syntax gate: fail, bytes untouched, both windows shown). An ambiguous repair fails with the structured error family of NF-052 (`matchesOutsideWindow`, `AmbiguousMatch`), never a wild guess.
- **Capability IDs.** `files.patch`; no new IDs.
- **Authority impact.** `none` (repair may not widen a request; Guard sees the repaired, not the raw, call).
- **Dependencies.** NF-052, NF-061; tools `edit`, `insert`.
- **Status.** `DESIGNED`.

### NF-070 — Tool-output secret redaction as a runtime invariant

- **Problem.** Tool output flows to the model, the log, the UI and (under NF-051) into Code Mode cells; a live secret in any path becomes an exfiltration primitive, and "the model should not print it" is not a control.
- **Design.** Output crossing the model / CodeMode / display boundaries is bounded, control-character-stripped and **pattern-redacted as a runtime invariant** — private keys, bearer tokens, known key shapes (`sk-`, `ghp_`, `github_pat_`, `xox*`), AWS access keys, JWTs, `key=value` secrets, credentials embedded in URLs — with placeholder preservation so the model still sees the shape it must use without the value. Credential *requests* use the client-tool channel (the agent asks the user; the value never enters the model's arguments or output). Redaction applies at the projection boundary: the durable machine value (NF-061) is unchanged, redaction misses are defects (canary test, NF-022's standard), and a redaction is never counted as an authorization-bearing event.
- **Capability IDs.** `context.manage`.
- **Authority impact.** `none`.
- **Dependencies.** NF-011, NF-022, NF-061; sources: horizoncode tool-batch redaction; oh-my-pi secret placeholders; OpenHands `request_secret`.
- **Status.** `DESIGNED`.

### NF-071 — Managed persistent runtime — owner/worker turn frames and process ownership

- **Problem.** A long-running managed agent needs an execution topology that degrades neither in lag nor in cost as turns accumulate, and a persistent daemon that spawns children carelessly leaks processes or re-delivers work after a crash. The corpus names neither the topology nor the ownership rules for its children.
- **Design.** An **owner** process oversees the session; one **worker** per turn runs over a framed control pipe and proves identity (pid + birth identity + ancestor chain) before any work is reserved. Turns are JSON frames (`delta`/`tool.start`/`approval`/`clarify`/`result`/`finished`) — never filesystem diffs, which is the structural source of near-zero lag. Durability lives in the log: a per-session **admission FIFO** (each input admitted once; `unknown` halts followers, never replays — the RC-7 vocabulary) plus worker executions and receipts. **Process ownership:** all long-lived children spawn through a single `spawn_owned` path, enforced by a lint with reason-required opt-outs and an empty baseline; a POSIX `sh` owner-death supervisor (EOF-driven, ~0.5 MB resident, `killpg` on any death including SIGKILL/OOM) guarantees child-tree cleanup; process births are boot-relative so NTP steps and VM resume do not make live processes look dead; a spawn ledger quarantines on corruption instead of reading as empty. Adopt the contracts — not the upstream 25-platform adapter matrix.
- **Capability IDs.** `session.manage`; child processes run under the ordinary `terminal.run` rules.
- **Authority impact.** `kernel` (worker executions and admissions become durable kernel-log semantics; unreconciled turns follow the `unknown` rules).
- **Dependencies.** NF-001, NF-036, NF-049; RC-7; source: hermes-agent (`agent/managed_worker.py`, `gateway/session_managed_worker.py`, `hermes_cli/process_identity.py`, `scripts/check_detached_spawns.py`); `30-steal-list.md` §2 C-12/D.
- **Status.** `DESIGNED`.

### NF-072 — Per-tool concurrency classes and parallel batch execution

- **Problem.** Serialising every call in a batch throws away the largest wall-clock lever available to a tool-calling loop, while unmanaged parallelism races on shared paths.
- **Design.** Every tool declaration carries one **concurrency class** — `shared` (default) with `exclusive` opt-out; the loop dispatches a batch as concurrent shared tasks behind a last-exclusive barrier with all-settled semantics (one failure cancels nothing), and every call still runs the ordinary pipeline — resolve, Guard, its own lease, settle, receipt. Edit/write/insert-style tools are `exclusive`; `shell` is conditional on PTY mode. Claim-verified upstream (`agent-loop.ts#L3906-L3940`; only 6 of 30 tools exclusive); the harness cost is one optional field on the tool interface.
- **Capability IDs.** None (schedules existing tool IDs).
- **Authority impact.** `none`.
- **Dependencies.** NF-001, NF-051; source: oh-my-pi; `30-steal-list.md` §2 C-6.
- **Status.** `DESIGNED`.

### NF-073 — Loop safety rails — sentinel exits, budget countdown, consecutive-error caps, charged failures

- **Problem.** Unattended loops fail in four classic ways: runaway turns, format-error spirals, budgets that burn silently or are invisible, and ceilings that are not real ceilings.
- **Design.** (a) Terminal outcomes use the single RC-7 vocabulary and loop exit is one sentinel check, so new exit reasons require no loop changes. (b) The step prompt renders a live budget countdown (steps and wall time remaining) from runtime state. (c) Format/parse errors inject a corrective in-context message; **consecutive** format errors are capped (reset on any clean step) with their own exit status. (d) A billed-but-failed turn is still charged — the cost ceiling is never fiction. (e) Budgets are checked **before** the call under one `0 = unlimited` convention; wall clock is a separate, non-liftable terminal condition; batch runs share a lock-guarded global spend ceiling.
- **Capability IDs.** None.
- **Authority impact.** `none`.
- **Dependencies.** RC-7, NF-025; source: mini-swe-agent (`agents/default.py`, `exceptions.py`, `models/__init__.py`); `30-steal-list.md` §2 C-2/C-4/C-5/B-8.
- **Status.** `DESIGNED`.

### NF-074 — Context-cost contracts — usage-anchored output budget, spill defaults, shell-output minimisation

- **Problem.** Output volume is the dominant token cost of a coding agent, and a fixed output cap produces hard provider 400s on large-output models.
- **Design.** Each request fits the output cap to the remaining window: prompt size is estimated from the provider's newest reported usage anchor plus a local count of the appended tail, with a per-message framing charge (16 tokens) and an absolute headway margin — constants measured, not guessed. Tool output is capped to the model-facing budget owned by `docs/09-tools.md` §10 R-tools-42 (≤ 16 KiB and ≤ 4,000 tokens per result; human pane ≤ 1 MiB; untruncated stream ≤ 64 MiB) with spill-to-artifact beyond it; a shell-output minimiser compresses verbose command output before it reaches the model (default on); dedicated-tool interception rewrites `cat`/`grep`-class shell invocations to native tools with a user-visible notice; long commands auto-background instead of blocking a turn.
- **Capability IDs.** `context.manage`; interception, minimisation and backgrounding run under the ordinary `terminal.run` admission.
- **Authority impact.** `none`.
- **Dependencies.** NF-052, NF-061; R-tools-57; source: oh-my-pi (`output-budget.ts`, `streaming-output.ts`, `exec/settings.ts`); `30-steal-list.md` §2 B-5/B-6/B-7/C-7.
- **Status.** `DESIGNED`.

### NF-075 — Growth loop v2 — warm-cache review fork, editorial standard, archive-only curator

- **Problem.** Self-improvement dies if it costs a second full-price call; it rots if it captures unresolved failures and negative tool claims as lessons; and it is dangerous if pruning can delete.
- **Design.** A post-turn **review fork** inherits the parent's cached prefix byte-for-byte (same system prompt and tool order — the same prefix cache; ~26 % measured cost cut upstream) and is **persistence-isolated** (no session-DB writes, frozen tool snapshot), so it is safe to run unconditionally. Its output passes an **editorial standard**: a fixed lesson-layer block plus a do-not-capture block that forbid capturing unresolved failures and negative tool claims, require read-before-write on self-edits, and enforce a test-backed description budget tied to what the prompt actually renders. A **curator** ages the library with archive-as-maximum (never delete), pre-run snapshots and pins. Growth remains `none`-impact: the fork may change memory, skills and prompts — nothing else (ADR-010).
- **Capability IDs.** `learn.run`, `learn.propose` [planned, RC-11].
- **Authority impact.** `none`.
- **Dependencies.** NF-010, NF-033; ADR-010; source: hermes-agent (`agent/background_review.py`, `agent/curator.py`, `skills/AGENTS.md`); `30-steal-list.md` §2 G-1…G-4.
- **Status.** `DESIGNED`.

---

## 6. Section C — Counts and coverage

**Method (R12).** Every count below is derived from the Section A tables by counting disposition cells, one row at a time. `Supersede` counts include the inherited behaviour a row strengthens, so per agent `Inherit + Supersede + Reject` equals the row count. The cross-agent totals are row counts, not a de-duplicated union; where the same capability appears in two references it stays as two rows because the two upstream implementations differ.

### 6.1 Rows per reference agent

| Agent | Rows | Inherit | Supersede | Reject |
|---|---:|---:|---:|---:|
| A.1 opencode | 14 | 5 | 9 | 0 |
| A.2 codex | 19 | 5 | 14 | 0 |
| A.3 grok-build | 16 | 6 | 9 | 1 |
| A.4 DeepSeek-Reasonix | 15 | 5 | 10 | 0 |
| A.5 oh-my-pi | 15 | 1 | 14 | 0 |
| A.6 forgecode | 9 | 2 | 7 | 0 |
| A.7 claude-code | 14 | 2 | 11 | 1 |
| A.8 horizoncode (ancestor) | 15 | 10 | 5 | 0 |
| **Total (A.1–A.8)** | **117** | **36** | **79** | **2** |
| A.9 addendum (§4.9, six sources) | 6 | 1 | 5 | 0 |
| **Grand total (A.1–A.8 + A.9)** | **123** | **37** | **84** | **2** |

### 6.2 What the dispositions mean in aggregate

| Family | Disposition profile | Reading |
|---|---|---|
| Session core: admission, claims, one stream per step | Mostly `Inherit` (opencode) | The loop is solved in the reference set; HorizonCode adopts it and adds receipts and claims on top. |
| Tools and native capability | Mostly `Supersede` | The raw tool set is commodity; the additions are typed declarations, capability IDs, receipts, and a native stack behind one addon. |
| Sandbox, policy, authority | All `Supersede` | Strictly additive: guarantee vectors, typed residuals, origin typing, composed policy, grants. |
| Surfaces and parity | `Inherit` + `Supersede` | The TUI interaction model is inherited; the ratchet and the eight-surface Controller are the addition. |
| Memory, context, compaction | `Supersede` | Tiers, provenance, distillation and the cache contract are the addition. |
| Orchestration, fleets, workflows | `Supersede` | The one-primitive boundary, capability grants and the occurrence journal are the addition. |
| Learning, evals, self-improvement | `Supersede` | Human-gated proposals, eval verification, trajectory export with redaction. |
| Packaging, provenance, docs | `Inherit` + `Supersede` | Static binary and doc-owner discipline inherited; machine-checked status and the provenance register added. |

### 6.3 New features

| Measure | Count |
|---|---:|
| New features catalogued (`NF-001` … `NF-075`) | **75** |
| Authority impact `none` | 50 |
| Authority impact `narrows` | 3 (`NF-019`, `NF-031`, `NF-064`) |
| Authority impact `grant-bearing` | 12 (`NF-007`, `NF-012`, `NF-014`, `NF-018`, `NF-020`, `NF-030`, `NF-032`, `NF-037`, `NF-043`, `NF-054`, `NF-055`, `NF-066`) |
| Authority impact `kernel` | 10 (`NF-001`, `NF-003`, `NF-016`, `NF-021`, `NF-022`, `NF-051`, `NF-053`, `NF-058`, `NF-063`, `NF-071`) |
| Learning-loop features, all required to be `none` | 6 (`NF-008`, `NF-010`, `NF-033`, `NF-034`, `NF-035`, `NF-075`) — **all six are `none`** |
| New capability IDs proposed (§3.3) | 16 |
| New events proposed (§3.4) | 17 |
| CI gate rows named (§3.5) | 17 rows, 18 distinct gates |

### 6.4 Coverage statement

- **The references are covered by construction.** Every capability named in the task brief for each of the eight primary references (A.1–A.8) and each of the six addendum sources (A.9) has a Section A row. Where no HorizonCode home is exactly equal to a reference capability, the row is `Supersede` with the strengthening named, or `Reject` with a reason in Section D.
- **Two rejects, both deliberate, both upstream features** — `/gboom` (D-5) and x402 payments (D-7). Everything else that is refused is a rejected *technique* rather than an upstream capability, and is listed in Section D for that reason.
- **The strict-addition claim is Section B, not Section A.** Section A asserts no reference is better in any dimension it covers; Section B is the whole of the claim that HorizonCode is better in authority, durability, evidence, orchestration, memory and self-improvement.
- **No row claims code (R7).** 117 matrix rows, 6 addendum rows and 75 features are `DESIGNED`; `gate:parity-ratchet` becomes a runtime-parity gate only once a first implementation exists, and until then it is a specification-quality gate over this document.

---

## 7. Section D — Non-goals and rejected features

Every entry states what is refused, why, and what covers the user need instead. Per R11, re-adding any of these requires a new ADR in [`02-decisions.md`](./02-decisions.md), not a code change.

### 7.1 Rejected upstream capabilities

| # | Refused | Where it exists upstream | Reason | Instead |
|---|---|---|---|---|
| D-5 | **`/gboom` raycaster easter egg** | `/data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-gboom` | No capability value; a hidden game loop inside an agent that must be auditable is surface area and attention with no return. | Removed. Terminals have games already. |
| D-7 | **x402 payments** | `/data/home/forge/repo-tour/claude-code/src/services/x402/` | Payment is authority outside the task domain: a repository owner cannot evaluate a receipt that says "paid". It also makes the agent a financial actor, with a threat model nobody asked for. | Out of scope. Monetisation is a human decision; the agent reports cost, never spends. |

### 7.2 Rejected techniques and approaches

| # | Refused | Reason | Instead |
|---|---|---|---|
| D-1 | **In-process kernel — Guard as a library in the agent process** | A policy check written in the same runtime as the plugin it checks is advisory: a plugin, an MCP server or a compromised dependency can monkey-patch it, and crash isolation is lost. | ADR-003: a supervised, separate `hzk` process with a SHA-256-pinned asset and a versioned protocol over a Unix socket (named pipe on Windows). |
| D-2 | **Mutable session rows as the state of record** | Recovery becomes guesswork and replay is impossible; two writers cannot be reconciled; every projection must be trusted. | ADR-004: append-only event log, disposable rebuildable projections (`hzcode session reindex`). |
| D-3 | **A hidden in-memory tool loop inside one step** | It destroys replay fidelity, blows up prompt caching, makes interruption racy and makes cost accounting a lie. | ADR-011: one provider stream per step; parallel calls are a batch applied to the log before the next step. |
| D-4 | **A vendor-hosted task queue as the default way to run work** (codex `cloud-tasks`) | Contradicts local-first (ADR-013): source code transits a third party, scheduling couples to a vendor's availability, and the vendor becomes able to observe every task. | `remote.exec` on machines you own (NF-020), with local scheduling, local receipts and per-host grants. The *capability* (dispatch work elsewhere) is inherited; the vendor queue is not. |
| D-6 | **A cross-compiled kernel inside a mobile app** (Reasonix Android `libreasonix.so`) | Multiplies the kernel's platform matrix and attack surface for a device whose only job is supervision; an Android process cannot host the cgroup/namespace authority the kernel exists to provide. | Mobile is a thin client of the server/web surface (NF-006, NF-046); the kernel stays where it can enforce. |
| D-8 | **Classifier-based permission decisions** (`auto` modes that ask a model to decide) | Non-deterministic authority: the same input gates differently on two runs, and the decision cannot be reviewed by reading a rule. It also puts the decision inside the thing being constrained. | Deterministic host policy for routing (NF-004) plus postures and rules enforced by the kernel (NF-003, NF-014). |
| D-9 | **Prompt-text permissions** ("you may edit files in src/" as an instruction) | Not enforcement. The model can be argued out of an instruction, and a jailbroken turn inherits every permission the text granted. | Every permission is kernel state; prompts describe posture, they never define it (ADR-007). |
| D-10 | **Silent sandbox degradation** ("best effort" confinement reported as success) | Turns a security property into a hope, and a downstream auditor cannot distinguish the two cases. | Guarantee vectors with typed residuals; a caller states the minimum level per dimension and the operation fails closed (NF-016, M2). |
| D-11 | **Automatic retry of `UNKNOWN` effects** | A write that may or may not have happened is the one case where a retry can produce a duplicate side effect; "probably fine" is worse than a refusal. | `UNKNOWN` is terminal and reconciled explicitly (NF-036), enforced by `gate:no-unknown-retry` (ADR-012). |
| D-12 | **Self-widening authority in any form** | An agent that can grant itself a permission is not an agent with permissions. This is the line that makes unattended operation legitimate at all. | ADR-010, enforced at the proposal boundary: learning may change memory, skills, prompts and non-authority routing, and nothing else (NF-010). |
| D-13 | **String matching on model prose to infer intent** ("looks like a dangerous command") | Judgements must read structure, never wording: phrase tables rot, are bypassed by paraphrase, and cannot be reviewed. | Shell ASTs, JSON schemas, types and capability IDs decide (ADR-015); errors carry identity (reason codes), never sentences. |
| D-14 | **Web-first or IDE-extension-first product shape** | Spends the effort budget on rendering and vendor lock-in instead of agent quality, and loses SSH/CI/remote usability. | ADR-001: terminal-first, protocol-first; web, desktop, IDE and SDKs are thin clients of the same Controller. |
| D-15 | **A hosted service as the default deployment** | Code is the most sensitive asset most organisations have; proxying it is a non-starter and a needless risk everywhere else. | ADR-013: local-first, BYO keys, optional self-hosted enterprise deployment (NF-031). |
| D-16 | **Telemetry on by default** | Sends repository-derived content off the machine without a decision, and is exactly the property enterprises audit first. | Opt-in, individually disableable, redacted export (NF-022, NF-041); the local dashboard works with export off. |
| D-17 | **Unbounded subagent depth, concurrency or budget** | A recursive fleet is a denial-of-service against the user's machine and their invoice, and it makes authority unreadable. | Depth, concurrency, parallel-writer and budget ceilings applied by the one construction primitive; `gate:boundary-test` keeps it that way (NF-007, NF-025). |
| D-18 | **A plugin model with ambient authority** (`require`-style extension code running in-process) | One-click remote code execution with the agent's full authority, and it makes the authority boundary unprovable. | Out-of-process extension host with declared capability IDs, signed manifests and per-use admission (NF-032, NF-043). |
| D-19 | **Vendor-specific prompt or protocol dialects as the internal contract** | Bakes one vendor's quirks into every layer; a second provider then requires a refactor rather than a codec. | Native wire codecs behind one internal contract, endpoints as configuration (NF-044). |
| D-20 | **Model fine-tuning as a product capability** | It changes the model's disposition, not the system's guarantees; it is unverifiable by receipt and it cannot be rolled back per-run. | The learning loop improves memory, skills, prompts and routing — all receipted, reviewable and revertible (NF-010, NF-033, NF-034). |

### 7.3 Non-goals (things HorizonCode is not)

1. **Not a chat application.** Every capability exists to change a repository and prove it (also stated in `README.md` §7).
2. **Not a model, and not model-agnostic in rhetoric only.** The harness stays vendor-neutral; provider breadth is a first-class feature (NF-044).
3. **Not a silent auto-improver.** Self-modification is proposed, reviewed and receipted (NF-010, ADR-010).
4. **Not a credential broker or a payment agent.** Secrets are used, never brokered to third parties (NF-022, D-7).
5. **Not an autonomous actor outside its grant.** Every effect is confined by a capability set that a human or a managed policy established (NF-014, NF-031).
6. **Not a promise of correctness.** The claim is auditability: receipts and the evidence gate make failures *visible*, not impossible.

---

## 8. Errors and failure modes

### 8.1 Catalog-integrity failures (fail the build, per §12)

| Failure | Detected by | Behaviour |
|---|---|---|
| A Section A row is missing for a reference capability | `gate:parity-ratchet` | Build fails; the row must be added or the capability explicitly rejected in §7. |
| A disposition cell is not one of the three legal values | schema validation of `CapabilityRecordV1` | Build fails (R2). |
| A `Reject` row has no reason or no replacement | `gate:parity-ratchet` | Build fails (R3). |
| An `NF-` id is duplicated, skipped or reused | id-registry check | Build fails (R5). |
| A learning-loop feature declares anything but `none` | id-registry check | Build fails (R6, ADR-010). |
| A status claims more than `DESIGNED` with no evidence | `gate:doc-status` | Build fails (R7, NF-047). |
| §6 counts disagree with the tables | mechanical recount in CI | Build fails (R12). |

### 8.2 Runtime failure modes this catalog must keep honest

| Failure mode | Where it surfaces | Required behaviour |
|---|---|---|
| Kernel absent, mismatched or unverifiable | `hzcode` startup | Fail closed to read-only with a diagnostic; never silent unguarded execution (ADR-003, NF-046). |
| Sandbox dimension below the required level | Effect preparation | Refuse the effect, record the typed residual, surface it (NF-016, M2). |
| Effect outcome unobservable | Effect settlement | `UNKNOWN`, never a guess; reconcile explicitly (NF-001, NF-036). |
| Policy revision changed under a grant | Grant use | Fail closed; re-ask (NF-014). |
| Workspace config attempts to widen | Config load | Refuse the widening, keep the narrowed meet, report it (ADR-008, NF-003). |
| A lane is disabled or dead | Any surface that would use it | Typed refusal naming the reason; visible in `hzcode doctor` (NF-049). |
| Cache prefix drifts at runtime | Context compilation | The drift is a defect, not a fallback: log the digest change and fail the gate in CI (NF-005). |
| Budget exhausted mid-tree | Admission boundary | Stop the affected branch with a typed refusal; do not partially settle an effect (NF-025). |
| Notification sink unreachable | Notify | Record the delivery failure as an event; never drop silently (NF-028). |

---

## 9. Flows

### 9.1 Primary flow — how a capability from this catalog reaches a user

1. **Reference capability is identified.** A Section A row exists (or is added) with an upstream citation and a disposition.
2. **Disposition is chosen.** `Inherit` (re-express on our substrate), `Supersede` (express *and* strengthen, naming the `NF-###`), or `Reject` (reason + replacement in §7).
3. **Home is assigned.** Capability ID, tool, package/crate and events; new IDs are proposed in §3.3/§3.4 and registered in `_conventions.md` in the implementing change.
4. **New feature is specified.** If the disposition is `Supersede` because of something genuinely new, the `NF-###` entry records problem, design, capability IDs, authority impact and dependencies (status `DESIGNED`).
5. **Gates are attached.** The row names the gate that will keep it true (`gate:tool-declaration`, `gate:receipt-coverage`, `gate:parity-ratchet`, …).
6. **Implementation raises the status.** `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED`, each step requiring the evidence named in `25-roadmap-and-glossary.md` M0–M8 and enforced by `gate:doc-status`.
7. **The ratchet holds it.** Removing the capability, or lowering its disposition, fails `gate:parity-ratchet`.

### 9.2 Flow — a new feature is added

1. Author checks Section A and Section B for an existing home; if one exists, the change is an implementation, not a new feature.
2. If it is new: an unused `NF-###` is allocated, `authority_impact` is declared (and must be `none` if the learning loop touches it), and dependencies are named.
3. `gate:tool-declaration` and `gate:receipt-coverage` apply if the feature introduces a tool; `gate:boundary-test` applies if it constructs agents.
4. The feature is listed in the roadmap phase where it earns its status, and in §13 it stays `DESIGNED` until then.

---

## 10. Security and authority

1. **This catalog introduces no authority of its own.** It is a specification. Every capability it maps or adds is exercised through Guard, a one-use lease and a receipt (NF-001, ADR-012).
2. **Capability IDs are the vocabulary of authority.** A row's home column names the IDs that will appear in `arch_V1`-style contracts and in `hz.effect.decision.made` events; an implementation that introduces a capability with no ID fails `gate:tool-declaration`.
3. **Narrowing is the only direction config may move.** Workspace files narrow user config; managed policy narrows both; imported settings from other agents narrow (ADR-008, NF-031). The catalog's `Supersede` rows must never be implemented as *widening* relative to the reference they supersede for a given grant.
4. **The learning loop is fenced.** The six learning-loop features (`NF-008`, `NF-010`, `NF-033`, `NF-034`, `NF-035`, `NF-075`) are `none`; a proposal that would touch policy, capability sets or the kernel is refused at the proposal boundary (ADR-010, NF-010).
5. **Extension and plugin surfaces declare before they act.** Manifest-declared capabilities, admission per use, no ambient authority (NF-032, NF-043).
6. **Residuals are security data.** A typed residual is a statement about what is *not* protected, and it is surfaced, logged and exported on purpose (NF-016, NF-021).
7. **Rejected rows are security decisions.** D-9, D-10, D-11, D-12, D-13 and D-18 are refusals of techniques that would weaken the authority boundary; they are normative (§7).

---

## 11. Performance budgets

Numbers are stated so they can be tested; a budget without a number is a preference. These apply once code exists (M0–M2 of `25-roadmap-and-glossary.md`); today they are design commitments. **ID space:** `FB-1`…`FB-12` (feature budgets) are this document's; `PB-1`…`PB-15` belong to `docs/03-hld.md` §9 and MUST NOT be reused here (`03-hld.md` §9 owns that space; this table previously collided with it).

| # | Budget | Value | Rationale |
|---|---|---|---|
| FB-1 | Guard decision (authorize → lease issue), local | p99 ≤ 2 ms | It is on the hot path of every tool call; a slow gate gets bypassed by pressure. |
| FB-2 | Receipt settlement and durability | ≤ 5 ms p99, one fsync-equivalent | Receipts must be cheap or they will be skipped. |
| FB-3 | Kernel startup (probe, pin check, policy compile) | ≤ 250 ms | Longer makes read-only fallback look attractive. |
| FB-4 | Sandbox probe | ≤ 100 ms | Runs before work; must not dominate short commands. |
| FB-5 | Context compile — prefix (cached) | ≤ 5 ms p99 | The prefix is the thing we claim is stable; it must also be cheap. |
| FB-6 | Cache-prefix stability | 0 bytes of drift per `(provider, model, config)` | Zero is the budget (ADR-009). |
| FB-7 | Step overhead outside the provider call | ≤ 15 ms p99 | The model's latency must dominate, not the harness. |
| FB-8 | TUI frame time, fullscreen | ≤ 16 ms p95 at 120×40 with an active stream | Below one frame at 60 Hz keeps typing responsive during streaming. |
| FB-9 | Inline-mode emission | No full-screen redraws; linear output only | It is the screen-reader and pipe path. |
| FB-10 | Catalog gates in CI | `gate:parity-ratchet` + `gate:doc-status` + recount ≤ 30 s | A gate that slows the loop gets disabled. |
| FB-11 | Index query (lexical) p95 | ≤ 50 ms on a 100k-file repo | Retrieval is on the turn path. |
| FB-12 | Session log append | ≤ 3 ms p99 | Every fact is an event; the log must not be the bottleneck. |

---

## 12. Tests

### 12.1 Gates that test this document

| Gate | Test |
|---|---|
| `gate:parity-ratchet` | Every Section A row round-trips through `CapabilityRecordV1`; every upstream path exists under `/data/home/forge/repo-tour/`; a removal or downgrade fails. |
| recount | §6.1 and §6.3 counts are recomputed from the tables and compared; any mismatch fails (R12). |
| `gate:doc-status` | Every capability's claimed level has evidence; no row exceeds `DESIGNED` in this revision. |
| `gate:tool-declaration` | Every tool named in a home column has a full declaration (schema, effect class, capability ID, idempotency, renderers). |
| `gate:boundary-test` | The NF-007 construction primitive has exactly the callers listed. |
| `gate:no-unknown-retry` | No code path retries an `UNKNOWN` settlement. |
| `gate:cache-guard` | NF-005 prefix stability for every supported tuple. |
| `gate:receipt-coverage` | Every mutating capability has a declared observation path. |

### 12.2 Tests that prove the new features once they exist

**Coverage note.** `NF-015`, `NF-027`, `NF-037`, `NF-041`, `NF-043`, `NF-046`, `NF-047`, `NF-048` are proven by the §12.1 gates (`gate:cross-plane-abi`, `gate:receipt-coverage`, `gate:frontend-parity`, `gate:doc-status`, `gate:provenance`, `gate:kernel-pin`) rather than by a dedicated item; every other row has one of the 67 items below.

1. **NF-001** — a mutating tool cannot execute without a receipt; a tool with no observation path cannot be granted mutation authority; an adversarial batch cannot present `UserAction` origin.
2. **NF-002** — a claim contradicted by a receipt is lowered and reported; the gate never raises a claim (negative test: a fabricated receipt cannot raise it).
3. **NF-003** — `deny > ask > allow` precedence holds across both layers; a workspace config that widens is refused; `xargs rm` is caught by the structural layer.
4. **NF-004** — the same input selects the same route (determinism); planner and executor prefixes never mix (digest test).
5. **NF-005** — prefix byte-stability across two compiles, and across a compaction event.
6. **NF-006** — every capability reachable from one surface is reachable from each of the eight (the ratchet's runtime half).
7. **NF-007** — a child cannot exceed its parent's capability set or budget; a new construction caller fails the boundary test.
8. **NF-008** — a distilled fact with no provenance is refused; memory cannot influence Guard.
9. **NF-009** — a recorded session replays to identical decisions; dry-run changes no state.
10. **NF-010** — a proposal that widens authority is refused at the boundary; approving a proposal does not change the effective policy digest unless the human edits policy.
11. **NF-011** — an unauthorised `hz://receipt/...` read is refused; an unknown scheme fails rather than resolving to a path.
12. **NF-012** — a workflow cannot obtain an undeclared capability; an occurrence is not double-fired across a restart.
13. **NF-013** — team memory sync cannot import a grant; conflict resolution never loses provenance.
14. **NF-014** — a grant fails closed when the policy revision changed; `files.write` never implies `files.delete`; every use is receipted.
15. **NF-016** — a dimension below the required level fails the operation and reports the residual; no path executes unconfined after a failed probe.
16. **NF-017** — a rewritten chain record is detected; a `tamper_evident_only` record cannot satisfy a `host_protected` verification claim.
17. **NF-018** — an attempt is the unit of retry and accounting; verification can only lower.
18. **NF-019** — a write outside the leased worktree fails closed; a recycled worktree leaks no bytes.
19. **NF-020** — a remote host's guarantee shortfall surfaces as a residual; remote policy is re-evaluated.
20. **NF-021** — an undeclared origin is denied and recorded; the SSRF guard rejects loopback and metadata endpoints.
21. **NF-022** — a resolved secret value never appears in transcript, log, telemetry or artifact output (redaction test with a canary); an access is receipted.
22. **NF-023** — offline mode makes zero outbound connections (socket-level assertion); a capability that cannot work degraded reports a typed refusal.
23. **NF-024** — an account switch mid-session is recorded, never silent; a pinned exhausted account fails closed.
24. **NF-025** — budget inheritance is enforced at admission; a child cannot spend past the root budget; a usage record cites its rate revision.
25. **NF-026** — a replayed rollout yields byte-identical decisions; a missing artefact reports `UNKNOWN`.
26. **NF-028** — a stall raises a notification; an unreachable sink is itself an event.
27. **NF-029** — every view renders in both modes (parity); no meaning is colour-only; terminal restore holds on panic and signal.
28. **NF-030** — a collaborator's approval is origin-typed to their principal; a read-only share cannot drive.
29. **NF-031** — a managed policy that widens is refused; policy is validated before sandbox application.
30. **NF-032** — an undeclared capability is refused at runtime even with an approved manifest; a grown capability set re-prompts.
31. **NF-033** — an unverified skill is not offered; a skill cannot declare a capability the promoting session lacks.
32. **NF-034** — a variant that breaks the prefix contract is reported as such, not as a win.
33. **NF-035** — an exported dataset contains no canary secret; export is receipted and scoped.
34. **NF-036** — an unresolved `UNKNOWN` prevents a success verdict and sets a non-zero exit code.
35. **NF-038** — discovery cannot surface a tool the session's grant excludes.
36. **NF-039** — replay is deterministic under injected clock, randomness and ids.
37. **NF-040** — a Mermaid render that panics does not take down the agent process; bounded media is refused rather than truncated silently.
38. **NF-042** — a dead language server reports a typed degraded state, not "no diagnostics".
39. **NF-044** — a new OpenAI-compatible endpoint requires configuration only (no code change) and passes a conformance test.
40. **NF-045** — the approved-plan window closes on policy revision change; only approved tools auto-approve inside it.
41. **NF-049** — a disabled lane reports refusal with a reason; after `kill -9` mid-attempt, recovery produces resume-or-`UNKNOWN`, never a green result.
42. **NF-050** — a price change appends a revision; a historical usage record still reconciles against its own revision.
43. **NF-051** — a snippet referencing a tool outside the declared subset fails by static scan before any host call (zero dispatches); a nested mutating call produces its own lease and receipt; killing a cell mid-call yields `UNKNOWN` + reconciliation, never a failed-safe report.
44. **NF-052** — window math holds (goto/scroll positions, clamps at both ends, overlap preserved); a unique match outside the window refuses with `matchesOutsideWindow`; a postimage that introduces a new diagnostic reverts the bytes; a 101-file summary grep returns `truncated{reason:'count'}` and no list.
45. **NF-053** — a workflow FSM cannot skip a required verification phase; a breach rolls back to the last plan checkpoint with receipts; the force path is recorded and visible.
46. **NF-054** — a failed verification run with a recorder available produces a trace artifact; a platform without a recorder returns a typed residual (never a silent pass); `debug.*` replay reads the trace, not a live process.
47. **NF-055** — preview URLs are injected by the runtime (a guessed port is never needed); teardown removes the listener and its processes; undeclared network egress is refused.
48. **NF-056** — the parity ratchet fails the release on a per-class regression; routing dispatches a task class to the cheapest model meeting the bar; a strict-REPL variant round-trips a seed task.
49. **NF-057** — micro-model calls from a snippet are receipted under `providers.infer` and counted in budgets; a local endpoint is subject to policy like any provider.
50. **NF-058** — policy documents read reversed (user beats repository); an allow never lifts an agent denial nor a saved approval; no config scope or plugin can remove the enforcement module; a failed fetch keeps the last snapshot.
51. **NF-059** — instructions arrive as deltas with digests; `"removed"` clears a key; a compaction moves the epoch without re-emitting unchanged values; a fork adopts the parent's newest values as baseline.
52. **NF-060** — one encode per event across N subscribers; a stalled subscriber cannot stall publication or other subscribers; an unknown frame is ignored; `transient` frames carry no `seq` and never appear in replay; the sync preamble matches the replay range.
53. **NF-061** — a result carries `output`/`content`/`metadata`; a retention failure fails the execution (no lossy success); an interrupted execution is not rendered as a tool failure.
54. **NF-062** — a queued message can be edited and reordered before dispatch but not during admission; Keep All / Undo All are receipted; an attachment sends as an artifact reference, never inline bytes.
55. **NF-063** — a restore is admitted as effects (a refused admission leaves bytes untouched); staged undo commits or cancels and the staged state is recorded; a file that became gitignored is pruned from snapshots.
56. **NF-064** — a reviewer can deny but never approve autonomously; a managed human checkpoint is not satisfied by auto-review; reviewer timeout falls back to the human dialog.
57. **NF-065** — an un-analyzable command routes to the human (fail closed); per-subcommand rules apply to each segment of a chain; a policy file's `not_match` example fails the load; an arity-derived approval suggestion is the longest matching prefix with flags excluded.
58. **NF-066** — an end-hook that appends messages re-opens the loop; an HTTP hook URL outside the allowlist is refused; the doom-loop reminder fires on `[A,A,A]` and cyclic `[A,B,C]` at threshold 3; stopping with pending todos re-opens with a deduplicated reminder.
59. **NF-067** — a goal stops at its round/stall/wait caps; an orphaned goal is paused, never silently resumed; blocked requires three consecutive blocked turns; the completion audit runs before closure.
60. **NF-068** — a side fork cannot call tools; it reuses the captured cache material rather than compiling cold; its output enters the main transcript only on explicit action.
61. **NF-069** — a truncated JSON argument is repaired, recorded, and still Guard-checked; an ambiguous shape is rejected with a structured error; a fuzzy edit applies only when unambiguous; post-write diagnostics are fed back.
62. **NF-070** — a canary secret in tool output never reaches the transcript, log or Code Mode boundary unredacted, while the durable machine value is unchanged.
63. **NF-071** — a worker proves identity before work is reserved; an interrupted turn's input is admitted once and `unknown` halts followers instead of replaying; a SIGKILL of the owner leaves no orphaned child tree (the supervisor fires); a corrupt spawn ledger quarantines instead of reading as empty.
64. **NF-072** — a batch's `shared` calls run concurrently while an `exclusive` call forms its own barrier; one call's failure cancels no sibling; every call in the batch still produces its own lease and receipt.
65. **NF-073** — consecutive format errors hit the cap and exit with their own status while isolated errors recover; a failed-but-billed call is charged; budgets are checked before dispatch with one `0 = unlimited` convention; wall clock terminates independently of spend.
66. **NF-074** — the output cap fits the remaining window with the measured headway (no provider 400 on a large-output model); over-cap tool output spills to an artifact with a pointer; minimised shell output is flagged as minimised; an intercepted `cat` form maps to the read tool.
67. **NF-075** — the review fork reuses the parent's cached prefix byte-for-byte and writes nothing to the session; a lesson violating the do-not-capture block is rejected; the curator archives (never deletes) and pins survive a prune.

---

## 13. Status

**Whole-document status: `DESIGNED`.** This document contains no implementation evidence and therefore cannot support a higher level. Its own evidence is: the upstream repositories read under `/data/home/forge/repo-tour/` (the primary eight, plus the second-wave six in §4.9 A.9), the deep-dive reports listed per section, and the binding decisions in [`02-decisions.md`](./02-decisions.md). **Implementation status (final audit, 2026-11-06):** where built slices exist, levels are maintained in [`28-implementation-status.md`](./28-implementation-status.md); the audit that re-verified the twelve source repositories is [`29-final-audit.md`](./29-final-audit.md), and the pass-3 four-repo dives (aider, mini-swe-agent, hermes-agent, oh-my-pi) are consolidated in [`30-steal-list.md`](./30-steal-list.md).

| Area | Level | Evidence |
|---|---|---|
| Section A parity matrix (117 rows + 6 addendum rows, A.9) | `DESIGNED` | Upstream citations per row; no HorizonCode code implements a Section A row (built slices are owned by `28-implementation-status.md`). |
| Section B new features (`NF-001` … `NF-075`) | `DESIGNED` | Problem/design/authority/dependencies recorded per entry; implemented v1 slices (NF-051 code mode, NF-055 preview — reduced forms) carry levels in `28-implementation-status.md`. NF-063…NF-070 were added by the final audit (`29-final-audit.md` §B.1; sources in `docs/audit/`); NF-071…NF-075 by the adoption wave (`30-steal-list.md`; RC-15). |
| Section C counts | `DESIGNED` | Derived from Section A tables by the method in §6; recomputed by the recount gate. |
| Section D non-goals | `DESIGNED` | Normative refusals; each names a replacement or states that the need is out of scope. |
| §3.3 capability-ID and §3.4 event proposals | `DESIGNED` (reserved) | Both lists are now registered as **Reserved** in [`_conventions.md`](./_conventions.md) §5/§6 (RC-11); they are promoted to canonical in the change that first implements each feature, per that file's §1 rule. |
| §3.5 gates | `DESIGNED` | Gate names are fixed here; implementations arrive per phase in `25-roadmap-and-glossary.md`. |
| §11 performance budgets | `DESIGNED` | Numbers are commitments to be tested, not measurements. |

**Known gaps, stated rather than implied:**

1. **Documents `17`–`23` are unassigned** — the set's earlier drafts proposed titles for them (storage and persistence, testing and gates, schema evolution, plugin authoring, migration, threat-model certification, doc authoring); until they exist, their topics are owned by the closest existing document and the gap is recorded in `25-roadmap-and-glossary.md` §4.1 and §8.
2. **The §3.3 capability-ID and §3.4 event proposals are registered as Reserved (RC-11)** — they are promoted into `_conventions.md` §5/§6 canonical lists in the change that first implements each feature. A Reserved name that outlives two revisions without being either promoted or withdrawn is a defect in this document.
3. **The ancestor's defects are inherited as work, not as claims** — the evidence gate is unwired and the subagent/LSP/DAP lanes are dead upstream (`source: /data/home/forge/repo-tour/horizoncode/HANDOFF.md`); NF-002 and NF-049 exist precisely because of them, and both are `DESIGNED` here.
4. **No upstream capability is claimed as working in HorizonCode.** Every "where it exists" cell is a statement about the reference agent.
5. **The six delta passes are queued at Section-A level, deliberately.** Their ~270 file-cited findings (all in `docs/audit/`) each want either a Section A row with disposition and recount, or an explicit non-goal; this revision appends only the eight register rows (NF-063…NF-070) whose unique residual met the merge rule. The queue is recorded in [`29-final-audit.md`](./29-final-audit.md) §B.1(c).
6. **The pass-3 adoption shortlist is adopted (RC-15).** `NF-071`…`NF-075` are Section B rows and the six second-wave sources are the A.9 addendum; `30-steal-list.md` remains the adoption queue — its items 1–8 and 11 are the live build plan.

