# _conventions — canonical names for the HorizonCode spec set

> Every document in `docs/` MUST use the names defined here. If a document needs a name that is not here, it MUST add it to this file in the same change.

---

## 1. Names

| Thing | Name |
|---|---|
| Product | **HorizonCode** |
| CLI binary | `hzcode` (aliases `hz`, `horizon`) |
| Authority kernel process | `hzk` (asset `hzk` / `hzk.exe`) |
| Config dir | `.hz/` in a workspace; `~/.config/horizon/` for user config |
| Resource URI space | `hz://` — path kinds: `session`, `message`, `part`, `step`, `prompt`, `plan`, `todo`, `goal`, `agent`, `team`, `receipt`, `decision`, `lease`, `reconciliation`, `artifact`, `worktree`, `snapshot`, `checkpoint`, `memory`, `skill`, `command`, `plugin`, `hook`, `mcp`, `lsp`, `provider`, `model`, `workflow`, `eval`, `proposal`, `tool`, `trusted-state` (e.g. `hz://session/<id>`, `hz://receipt/<id>`, `hz://artifact/<sha256>`) |
| TS package scope | `@horizoncode/*` |
| Rust crate prefix | `hz_*` |
| Protocol revision | `HZ_ABI=1`, `HZ_PROTO=1` (integers, bumped on breaking change) |

**The five `hz.` namespaces — never confusable.** Only namespace 1 is an event.

1. **Events** — `hz.<entity>.<past-tense-verb>`, §6 below. Durable or ephemeral facts of record. Past tense always.
2. **Protocol methods** — imperative JSON-RPC methods (`hz.session.submit`, `hz.tool.invoke`, `hz.kernel.status`), owned by `docs/07-apis-and-contracts.md` §4.1–§4.2. API surface, never history.
3. **Observability names** — OTel span/metric/attribute identifiers in `hz.*` (`hz.step.duration`, `hz.tool.name`, `hz.capability.id`), owned by `docs/16-operations.md`. Never durable.
4. **Digest domains** — BLAKE3 domain-separation tags `hz.<record>.v1` (`hz.receipt.v1`, `hz.ths.record.v1`, `hz.guard.intent.v1`, `hz.policy.revision.v1`, `hz.posture.v1`), owned by `docs/11-authority-safety.md`. Fixed strings, versioned with the record format.
5. **Storage keys & manifest fields** — `hz.db` (logical log name; the physical file is `hzcode.db`, owned by `docs/12-sessions-state.md`) and plugin-manifest keys `hz.minAbi` / `hz.minProtocol` (`docs/15-extensibility.md`).

If a name appears in §6 it is an event and MUST NOT also be used as a method, and vice versa; a collision is resolved by renaming the method.

## 2. Planes

1. **Interaction** — front-ends (TUI, print, server, web, desktop, IDE, MCP server, SDKs).
2. **Orchestration** — Controller, session engine, step engine, agent loop, planner/executor, subagents, teams, scheduler, budgets.
3. **Cognition** — providers, context compiler, memory, retrieval, compaction, prompts.
4. **Authority** — `hzk` kernel: capability registry, Guard, policy, leases, effect host, receipts, reconciliation, managed domain.
5. **Extensibility** — plugins, skills, commands, hooks, workflows, MCP/ACP integrations.
6. **Data** — event log, projections, blob/artifact store, vector index, snapshot store.

## 3. TypeScript packages (`packages/*`)

| Package | Responsibility |
|---|---|
| `@horizoncode/cli` | `hzcode` binary, command framework, front-end host |
| `@horizoncode/tui` | Terminal UI renderer + components |
| `@horizoncode/core` | Controller, session engine, step engine, event log, projections, budgets |
| `@horizoncode/protocol` | Protocol schemas + codecs (single source of truth) |
| `@horizoncode/server` | JSON-RPC / HTTP / SSE / WS server |
| `@horizoncode/sdk` | Generated TS client |
| `@horizoncode/sdk-python` / `-go` / `-rust` | Generated thin clients |
| `@horizoncode/tools` | Tool declarations + implementations registry |
| `@horizoncode/provider` | Provider layer, wire codecs, models.dev catalog |
| `@horizoncode/context` | Context compiler, cache guard, memory, retrieval, compaction |
| `@horizoncode/agents` | Agent profiles, planner/executor, subagent fleet, teams |
| `@horizoncode/kernel-client` | Typed client for the `hzk` protocol |
| `@horizoncode/mcp` | MCP client + MCP server |
| `@horizoncode/acp` | ACP agent + IDE bridge |
| `@horizoncode/plugin` | Plugin SDK + sandboxed host |
| `@horizoncode/skills` | Skill system + bundled skills |
| `@horizoncode/workflow` | Rhai workflow engine bindings |
| `@horizoncode/learn` | Trajectories, evals, distillation, skillify, proposals |
| `@horizoncode/observe` | OTel, logging, metrics, redaction |
| `@horizoncode/web` | Web app |
| `@horizoncode/desktop` | Electron desktop app |
| `@horizoncode/ui` | Shared UI primitives |
| `@horizoncode/shared` | Utility, errors, ids, schema helpers |
| `@horizoncode/testing` | Harness, record/replay, fixtures, boundary tests |

## 4. Rust crates (`crates/*`)

| Crate | Responsibility |
|---|---|
| `hz_kernel` | Authority kernel: guard, policy host, leases, effect host, receipts, owner log, managed domain, verifier, budgets, worktree pool, supervisors |
| `hz_abi` | Kernel ABI/protocol types (generated) |
| `hz_sandbox` | Confinement backends + guarantee vectors + typed residuals |
| `hz_policy` | Wildcard rule compiler + Starlark prefix engine |
| `hz_native` | The single N-API addon (facade over the native crates) |
| `hz_shell` | Embedded bash + injectable VFS |
| `hz_edit` | Conflict-aware edit engine |
| `hz_diff` | Diff engine (jsdiff-compatible) |
| `hz_ast` | tree-sitter AST query/rewrite |
| `hz_vcs` | Git (and Jujutsu) integration |
| `hz_walker` | Parallel, ignore-aware filesystem walker |
| `hz_index` | Lexical + symbol + reference index (repo intel) |
| `hz_pty` | PTY / terminal process management |
| `hz_voice` | STT/TTS native primitives |
| `hz_sdk` | Generated Rust SDK client — thin client over the protocol; generated from protocol types, never from kernel ABI types |
| `hz_codegen` | Protocol + ABI + SDK code generation |

## 5. Capability IDs (stable; aliases never change effect class)

`files.read`, `files.write`, `files.patch`, `files.delete`, `files.move`, `terminal.run`, `terminal.pty`, `process.spawn`, `net.fetch`, `net.search`, `providers.infer`, `models.list`, `code.execute`, `codemode.execute`, `language.symbols`, `language.diagnostics`, `language.rename`, `debug.session`, `repl.eval`, `vcs.read`, `vcs.write`, `memory.read`, `memory.write`, `plugins.invoke`, `schedule.manage`, `agent.spawn`, `artifact.write`, `secrets.read`, `worktree.manage`, `remote.exec`, `mcp.invoke`, `ui.present`, `session.manage`, `context.manage`.

Effect classes: `read-only` · `workspace-write` · `network` · `process` · `credential` · `remote` · `external-effect`.

**Reserved capability IDs (not yet canonical).** Coined by DESIGNED features in `docs/24-feature-catalog.md` §3.3; they MUST NOT be used by any implementation and are promoted into the list above in the change that first implements them (RC-11): `index.query`, `receipt.read`, `sandbox.probe`, `tool.discover`, `workflow.run`, `notify.emit`, `collab.manage`, `enterprise.policy.read`, `plugin.install`, `voice.io`, `media.render`, `browser.control`, `learn.run`, `learn.propose`, `debug.record`, `preview.serve`.

## 6. Event names

Format: `hz.<entity>.<past-tense-verb>`. Canonical names:

`hz.session.created` · `hz.session.prompt.admitted` · `hz.session.claim.acquired` · `hz.session.claim.released` · `hz.session.busy.entered` · `hz.session.busy.left` · `hz.step.started` · `hz.step.llm.requested` · `hz.step.llm.delta` · `hz.step.llm.completed` · `hz.step.tool.requested` · `hz.step.tool.completed` · `hz.part.created` · `hz.part.updated` · `hz.plan.updated` · `hz.todo.updated` · `hz.goal.updated` · `hz.effect.decision.made` · `hz.effect.lease.issued` · `hz.effect.settled` · `hz.effect.unknown` · `hz.effect.reconciled` · `hz.session.compacted` · `hz.session.checkpoint.created` · `hz.session.rewound` · `hz.session.forked` · `hz.session.moved` · `hz.agent.spawned` · `hz.agent.completed` · `hz.agent.message.sent` · `hz.memory.retained` · `hz.memory.recalled` · `hz.memory.expired` · `hz.skill.invoked` · `hz.skill.installed` · `hz.learn.trajectory.recorded` · `hz.learn.proposal.created` · `hz.learn.eval.completed` · `hz.permission.asked` · `hz.permission.answered` · `hz.policy.revision.changed` · `hz.provider.account.rotated` · `hz.error.raised` · `hz.usage.recorded`.

**Count: 44 canonical events** (RC-1, RC-10 included). Any document claiming a different count is stale.

**Reserved names (not yet canonical).** The following names are coined by DESIGNED features in `docs/24-feature-catalog.md` and MUST appear only with a `[planned]` marker until the owning feature's phase ratifies their admission here (RC-11): `hz.workflow.started`, `hz.workflow.completed`, `hz.notify.raised`, `hz.collab.presence.changed`, `hz.budget.exceeded`, `hz.sandbox.guarantee.assessed`, `hz.sandbox.residual.reported`, `hz.egress.denied`, `hz.bridge.attached`, `hz.learn.proposal.reviewed`, `hz.tool.discovered`, `hz.trust.record.appended`, `hz.index.updated`, `hz.session.instructions.updated`, `hz.preview.started`, `hz.preview.stopped`, `hz.debug.recording.captured`. There is no `hz.receipt.unknown` or `hz.receipt.reconciled`: the canonical names for those facts are `hz.effect.unknown` and `hz.effect.reconciled`.

## 7. Schema naming

- Every wire/durable schema is `<Name>V<major>`, e.g. `GuardDecisionV1`, `EffectReceiptV1`, `SessionPostureV1`, `AgentProfileV1`, `ToolDeclarationV1`, `StepRecordV1`.
- TypeScript types are generated from the schema; Rust types are generated into `hz_abi`.
- No schema is edited in two places: `packages/protocol` and `crates/hz_abi` are outputs of `hz_codegen`.

## 8. Status levels (mandatory on every capability)

`DESIGNED` → `CODE_PRESENT` → `WIRED` → `TESTED` → `VERIFIED` → `RELEASED`.

A document MUST NOT claim a level above what its evidence supports, and MUST say so explicitly. An unknown is written as `UNKNOWN`, never as an implied success.

## 9. Document template

Every spec document uses these sections (omit only if genuinely empty, and say why):

1. **Purpose** — what this document decides.
2. **Rules** — MUST / SHOULD / MAY statements, numbered, individually testable.
3. **Interfaces** — types, functions, endpoints, events this subsystem owns.
4. **Data** — schemas and persistence.
5. **Errors & failure modes** — including what is fail-closed.
6. **Flows** — at least the primary flow, step by step.
7. **Security & authority** — what capability IDs are involved and how they are narrowed.
8. **Performance budgets** — explicit numbers where they matter.
9. **Tests** — the tests that prove the rules, including gate/ratchet tests.
10. **Status** — per capability: level + evidence.

## 10. Writing rules

- Absolute file paths in every citation; never relative.
- Cite the artifacts this design was derived from as `source: <repo> <path>` lines (repos live under `/data/home/forge/repo-tour/`).
- Prefer tables and numbered rules over prose.
- Name real functions and real files. If a function does not exist yet, mark it `[planned]`.
- No marketing language. State what is enforced, what is designed, and what is unknown.

---

## 11. Ratified cross-document decisions

These rulings are binding on every document. They exist because parallel authors hit the same gap; the owner of this file rules once so no two documents diverge.

| # | Decision | Rationale |
|---|---|---|
| RC-1 | **`hz.session.moved` is a canonical event.** A session re-home emits it in the destination log with `movedFrom { workspaceId, directory }` and the same `sessionId`. The interim encoding (`hz.session.created` + `reattachedFrom`) is superseded and MUST NOT be used in new designs. | Event names are the historical record; `created` must not stand for a move. See `docs/06-events-and-flows.md` G-1. |
| RC-2 | **Plugin load/unload and MCP server connect/discovery are NOT events.** In-process registry transitions are not facts of record; the observable facts are tool calls (`hz.step.tool.*`). A load failure is `hz.error.raised` with `class: plugin` or `class: mcp`. | Keeps the catalogue closed; a registry is machinery, not history. See `docs/06-events-and-flows.md` G-5. |
| RC-3 | **Log snapshots, retention markers and worktree/schedule journal entries are storage/kernel metadata, not session events.** They live as `event_snapshot` / `retention_ledger` rows or kernel OwnerLog records referenced by digest; `hzcode worktree list --journal` MUST expose them for audit. | See `docs/06-events-and-flows.md` G-2/G-4. |
| RC-4 | **Usage for a cancelled attempt is recorded as `hz.usage.recorded` with `attribution.stepId` set to the cancelled step** (which carries `retryOfStepId`). No separate credit event exists. | See `docs/06-events-and-flows.md` G-3. |
| RC-5 | **Canonical exit codes are owned by `docs/14-surfaces.md` §2.2 (S16)**: `0` success · `1` error · `2` usage/config/environment · `3` unprovable/fail-closed · `4` policy denial · `5` budget · `130`/`143` signals. Every other document MUST reference, not restate, this table. | One table, one owner. |
| RC-6 | **A policy `deny` never emits `hz.permission.asked`.** Denial is decided and recorded as `hz.effect.decision.made` with the deny reason code; `asked` exists only where an answer could change the outcome. | A reader must not be able to infer that a deny is overridable. |
| RC-7 | **Effect terminal-state vocabulary is one enum in `@horizoncode/protocol`:** `succeeded | failed | denied | cancelled | unknown | budget_exhausted | timeout | interrupted`. No component invents its own terminal word; `UNKNOWN` is a terminal state, never a synonym for failure. | Cross-cutting vocabulary. |
| RC-8 | **Cache-guard prefix pins are owned by `packages/context/test/golden/prefix/<family>.sha256`.** Changing a pin requires an explicit `--update-golden` commit containing a written rationale, under gate `cacheguard`. | Pins must have a named owner and a reviewable change path. See `docs/10-cognition.md` R65. |
| RC-9 | **The feature-flag registry is owned by `docs/07-apis-and-contracts.md`** (§4.1.5), not by this file: feature flags are negotiated protocol surface (`hz.initialize`), versioned with `HZ_PROTO`, and follow the C41/C42 add/deprecate rules. This is the single documented exception to §1's "a document that needs a name MUST add it here" — it applies to *names*, and a feature flag is a protocol capability, not a name. The registry table MUST give, per flag: name, since-revision, negotiation class (required/optional), what enables it, and deprecation state. | Keeps one owner per surface: names here, protocol capabilities in 07. See `docs/07-apis-and-contracts.md` §10 item 4. |
| RC-10 | **`hz.provider.account.rotated` and `hz.memory.expired` are canonical events** (added to §6). Account rotation is a durable fact that a cost or cache regression must be attributable to (doc 10 R23/R73); memory expiry is a lifecycle fact that must not be a silent row deletion (doc 10 R93). This does not reopen RC-2: registry *internals* remain non-events, while observable account and memory lifecycle transitions are facts of record. | Two events proposed by `docs/10-cognition.md` §3.9; ratified rather than left dangling. |
| RC-11 | **`hz.receipt.unknown` / `hz.receipt.reconciled` are not names.** The canonical events for those facts are `hz.effect.unknown` / `hz.effect.reconciled` (doc 24 corrected). Additionally, the names listed under the **Reserved names** blocks in §5 and §6 are coinages of DESIGNED features: they MAY appear only with `[planned]`, MUST NOT be emitted or implemented, and are promoted into the canonical lists in the change that first implements their feature. | Closes the last dangling names from the re-audit without reopening the closed catalogue. |
| RC-12 | **The second learning pass is ratified.** Features `NF-051` … `NF-062` (`docs/24-feature-catalog.md` Section B) are adopted as DESIGNED; the reserved capability IDs `debug.record`, `preview.serve` and the reserved events `hz.session.instructions.updated`, `hz.preview.started`, `hz.preview.stopped`, `hz.debug.recording.captured` are registered per RC-11. NF-058 (policy statements) extends doc 11's merge lattice and MUST preserve its narrowing-only property; NF-053's workflow FSM and NF-059's instruction epochs are authority-neutral by construction (they can demand more verification, never fewer grants). `docs/26-learning-synthesis-2.md` is the learning record; `docs/27-implementation-plan.md` is the build plan; the queued doc updates in doc 26 §5 are tracked there, not here. | Ratifies the ten-repo deep dive and closes the names it coined. |
| RC-13 | **Implementation status has one owner: `docs/28-implementation-status.md`.** (a) Every blanket claim of the form "nothing is built / everything is DESIGNED" in documents `01`–`16`, `24`, `25` was written while the set was design-only; it is *historical* and is superseded by `docs/28`, which is the single source of truth for implementation levels and the only place a level above `DESIGNED` may be claimed. Status notes dated 2026-11-06 in those documents carry this reconciliation. The same reconciliation applies to `26` (learning record) and `27` (plan): their blanket "nothing is implemented / all DESIGNED" statements are historical, and neither may state an implementation level of its own — that is `28`'s alone. (b) The sixteen rule insertions queued by `docs/26-learning-synthesis-2.md` §5 were carried **in full** in `docs/29-final-audit.md` Part D; they were folded into their owner documents by the adoption revision of 2026-11-07 (RC-15), and Part D remains the historical verbatim copy of the queue. (c) `docs/29-final-audit.md` is the audit of record for the twelve reference clones under `/data/home/forge/repo-tour/`. | One owner per kind of truth: the spec set owns design, `docs/28` owns implementation reality, `docs/29` owns the audit record. Closes the stale-ceiling problem across the whole set. |
| RC-14 | **Document classes and authority-by-concern.** Every document declares its class — **contract** (schemas, protocol — normative), **decision record** (ADRs, rulings — binding on design), or **historical** (learning records, plans, audits, queues — no normative force). Authority by concern: names and status levels → this file; wire/durable shapes → `docs/05`/`docs/07` plus the generated protocol; authority semantics → `docs/11`; runtime semantics → `docs/08`/`docs/12`; implementation levels → `docs/28` (RC-13); audit record → `docs/29`; adoption queue → `docs/30`. Rejected options are kept with their trade-offs. | Adopted from the final audit (Part D, D-00); makes "which document is authoritative for what" answerable without reading the whole set. |
| RC-15 | **The adoption wave is ratified.** (a) *See RC-13(b)*: the sixteen Part D insertions are folded into their owner documents and Part D remains the historical copy. (b) Register candidates `NF-071` … `NF-075` are adopted as `DESIGNED` (`docs/24` Section B; authority impacts per its §6.3); `NF-075` joins the learning-loop set (declares `none`, ADR-010). (c) The six second-wave sources — SWE-agent, OpenHands, wshobson/agents, aider, mini-swe-agent, hermes-agent — are recorded in the Section A addendum `A.9`; the A.1–A.8 matrix total stays 117 and the addendum counts 6 rows separately (`30-steal-list.md` §2 is the distilled evidence). (d) `docs/30-steal-list.md` is the adoption queue; its items 1–8 and 11 remain the live work plan. | Ratifies the pass-3 deep dives and closes the Part D queue without reopening the closed register. |

> Reconciled 2026-11-07 (reaudit stage 2, RC-15): RC-15(a) states the Part D fold once, by reference to RC-13(b), and RC-13(a)'s scope now names docs `26` and `27`.

