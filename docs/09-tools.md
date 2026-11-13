# 09 — Tools: declarations, registry, pipeline and the full catalog
> **Permission modes (`docs/28` ruling 58).** `read-only` refuses every `fs.write`, `shell.exec` and `mcp.invoke` admission (so `write`, `edit`, `apply_patch`, `undo`, `shell`, `shell_session`, `preview`); `accept-edits` answers an in-workspace `fs.write` ask. Tool code is unchanged: the mode acts in the shared guard gate. The one-shot `shell` refuses invisible Unicode in its command before admission, so no approval prompt is raised for it (ruling 66).

> **Print mode (`docs/28` ruling 57).** The print result counts distinct top-level tool calls (`toolCalls`) and lists files named by the turn diffs (`changedFiles`); no tool changes.


> **Agent presets (stage 3, `docs/28` ruling 56).** The shipped `agent` tool takes an optional `profile`. A preset picks a subset of the parent's tools (read-only for explore, plan and review; `code` holds more than the generic child; ruling 61); the child still gets no parent leases (R-tools-32) and every effect re-enters guard and approval. `SubagentSpecV1` grants, fleets and `readOnlyProfile()` stay DESIGNED.
>
> Status: **DESIGNED** (see §12) as a specification of the full catalog - **94 tools in 91 entries** (§4.1–§4.8; §4.9's 92 rows because the `artifact_*` family spans two rows), a count this document owns and §11.2's coverage test verifies. **Implementation status (refreshed to the code):** 18 tools are registered in `app/src/tools/index.ts` and are TESTED per `28-implementation-status.md`: `read write edit grep glob shell todo undo repo_map agent code_mode preview apply_patch shell_session lsp tool_search ast_search ast_edit`. Everything else named here (the rest of the catalog, the `debug` DAP tool) is still an artifact to be built; symbols without a working implementation are `[planned]`. Upstream sources and deferral reasons are in the Provenance section at the end of this document.
>
> **Implementation note (2026-11-09; refresh 2026-11-12).** The catalog below stays a specification. Shipped TESTED tools include the base seven plus `undo`, `repo_map`, `agent`, `code_mode`, `preview`, `apply_patch`, `shell_session`, `lsp` (default off), `tool_search`, `ast_search`, `ast_edit`, deferred `debug` (DAP PARTIAL), deferred `memory_search`. **PARTIAL:** multi-dialect `toolconv` (xml…anthropic) beyond `apply_patch` routing. `multi_edit` still NOT STARTED. Hashline anchors: opt-in `edit` mode (ruling 64).
>
> Templates and names follow `_conventions.md`.

---

## 1. Purpose

This document decides **what a tool is in HorizonCode**, and it is the only place where the tool surface is enumerated.

It decides:

1. The anatomy of `ToolDeclarationV1` — the single source of truth for a tool's identity, schema, class, authority and presentation.
2. How declarations are **generated** and how a build-time **completeness gate** makes a missing or invalid field a build failure rather than a runtime surprise.
3. How the **tool registry** resolves and namespaces built-in, plugin, MCP, skill and dynamic/deferred tools.
4. The rules of **deferred discovery** (`tool_search`).
5. The **execution pipeline** — `validate → permission decision → authorize → lease → execute → observe → settle → receipt` — and which stage fails closed for which input.
6. The **output rendering contract**: what the model sees, what the human sees, and how truncation and pagination are bounded.
7. **Error semantics per tool class** (read-only / mutating / network / process).
8. **The full catalog** of the 94 tools in §4 (91 entries), each with capability ID, effect class, read-only class, permission class and notable failure modes - the same set `../README.md` §3.2 names, held equal by the coverage test in §11.2.
9. The tools we **deliberately do not ship**, and why.

It does **not** decide: kernel internals (`11-authority-safety.md`), schema bodies (`05-domain-and-schemas.md`), the event vocabulary (`06-events-and-flows.md`), the context compiler and prefix discipline (`10-cognition.md`), or the session/state machine (`12-sessions-state.md`). Where this document names a schema or an event, it consumes it; the owning document defines it.

**Reader contract.** A rule in §2 is individually testable; the catalog in §4 is the enumerated surface the rules apply to; §12 states the evidence level of every claim here.

**Sources.**

- source: `horizoncode` `../README.md` §3.2 (tool list), §3.4 (authority), §3.7 (extensibility)
- source: `horizoncode` `_conventions.md` §5 (capability IDs, effect classes), §7 (schema naming), §8 (status levels)
- source: `forgecode` [`tailcallhq/forgecode`](https://github.com/tailcallhq/forgecode/tree/a22b49288856d5b3f3ca57e8532683d54a662c8c) (compile-time tool specs, typed tool specs)
- source: `opencode` [`sst/opencode`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0) (tool registry + per-tool typed definitions)
- source: `claude-code` [`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68) (tool catalog breadth, subagent fleet, skills)
- source: `codex` [`openai/codex`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053) (shell policy / approval flow)
- source: `oh-my-pi` [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296) (native capability set: shell/VFS/edit/diff/VCS/AST)
- source: `grok-build` [`xai-org/grok-build`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) (background jobs, PTY sessions)
- source: `DeepSeek-Reasonix` `DeepSeek-Reasonix` (repo not cloned, path not verified) (planner/executor split driving read-only vs mutating tools)

---

## 2. Rules

Numbering is stable: `R-tools-N` is never reused for a different statement. MUST/SHOULD/MAY per RFC 2119.

### 2.1 `ToolDeclarationV1` anatomy

**R-tools-1.** Every tool MUST be described by exactly one `ToolDeclarationV1` record. The declaration — not prose, not a prompt, not a registry-side annotation — is the only source of the tool's name, schema, class and authority. A tool with no declaration MUST NOT be callable.

> Reconciled 2026-11-07 (reaudit stage 2, RC-15). The `ToolDeclarationV1` **schema** - its field list, its types and every closed enum (`readOnlyClass`, `concurrencyClass`, `idempotency`, `effectClass`) - is owned by `05-domain-and-schemas.md` §4.7. This section states only the behaviour the tool pipeline depends on; it MUST NOT define, restate, rename or extend a field.

**R-tools-2.** A declaration MUST carry **every** field of `ToolDeclarationV1` as fixed in `05-domain-and-schemas.md` §4.7 - that section is the single source of truth for the field list, the types and each closed enum, and this document cites it rather than copying it. A declaration missing any field fails the completeness gate (R-tools-12) at build time and MUST NOT be registered at runtime.

**What this section adds, and the capability decision.** The pipeline depends on these parts of the declaration, each with its own rule below: `effectClass` as an upper bound (R-tools-3), exactly one `capabilityId` (R-tools-4), the permission defaults and their resource scope (R-tools-5), `idempotency` (R-tools-6), the timeout (R-tools-7), the two renderings (R-tools-8), telemetry (R-tools-9) and the prompt fragment (R-tools-10). There is **no `auxCapabilityIds` field and no second capability list**: a declaration names exactly **one** `capabilityId` - the capability of the effect the call is leased under (H-30 in `03-hld.md`, D22 in `05-domain-and-schemas.md`) - because a union or an inferred second grant would defeat the single-capability authorisation rule the safety model rests on. An auxiliary **read** a tool performs is declared as **read-scope** on that same capability (R-tools-5), never as a parallel grant; an extra **write** arm (e.g. `apply_patch`'s add/delete arms) takes its own one-use lease under the session's own capability for it (R-tools-32), and is refused when the session does not hold that capability.

**R-tools-3.** `effectClass` MUST be the *upper bound*: if any input can cause an effect, the declaration MUST declare that effect class, even when the common path is lighter. A declaration MUST NOT under-declare to obtain a weaker permission decision; the completeness gate cross-checks `effectClass` against `capabilityId` using the capability→effect floor table in `packages/tools/capability-effects.ts` `[planned]`.

**R-tools-4.** `capabilityId` MUST be one of the ids in `_conventions.md` §5. Introducing a capability id requires editing `_conventions.md` in the same change. Capability aliases MUST NOT map to a different effect class (a capability rename is a new id, never an alias; a tool that needs a weaker effect than its capability's floor is a design error resolved by a narrower capability, not by an override).

**R-tools-5.** The declaration's permission defaults MUST be `ToolPermissionV1` records as fixed in `05-domain-and-schemas.md` §4.7; this document requires only that they carry a **resource scope**, a decision and whether a one-use grant may escalate above it. Resource scope is expressed in the scheme of the effect: `workspace://src/**`, `cache://index/**`, `net://api.github.com` , `pty://local`, `memory://team/*`, `agent://child`. A scope of `**` MUST be rejected by the gate unless the owning capability is `session.manage` or `context.manage`.

**R-tools-6.** `idempotency` MUST be truthful, using the closed set of `05-domain-and-schemas.md` §4.7 (`idempotent` | `at_most_once` | `at_least_once` | `non_idempotent`): `idempotent` only if re-running produces no additional effect; `at_least_once` requires an `idempotencyKeyFrom: string` expression over inputs (e.g. `sha256(workspace|path|postimage)`) and the lease MUST carry the key; `at_most_once` and `non_idempotent` MUST NOT be auto-retried after `execute` has begun (R-tools-35).

**R-tools-7.** A timeout MUST be declared for every tool (`timeouts` in `05-domain-and-schemas.md` §4.7; the kernel enforces the hard limit), and it MUST NOT exceed the enclosing step budget. Long-lived tools (`shell_session`, `job`, `container`, `debug`, `wait`) declare a *session* timeout and an idle timeout; “unbounded” is not a legal declaration. A call exceeding the declared hard timeout is killed at the process/driver boundary and then settles as `UNKNOWN` if an effect may already have landed (R-tools-33).

**R-tools-8.** Two renderings exist and both MUST be declarable: the **model-facing** rendering (required — a tool with none MUST NOT register) and the **human-facing** rendering (MAY be absent). Absent `human` means the TUI renders the model rendering inside a generic frame and marks it `renderFallback: true`; it MUST NOT silently invent a second text. Renderer ids are stable strings (`files.read.v1`), and a renderer change that alters model-facing bytes is a prefix-affecting change (R-tools-13).

**R-tools-9.** `telemetry` MUST declare: span name `hz.tool.<name>`, `attributes[]` from a closed set (`tool.id`, `tool.namespace`, `capability.id`, `effect.class`, `tool.outcome`, `tool.bytes.in`, `tool.bytes.out`, `tool.truncated`, `tool.duration.ms`, `tool.retry.count`), and a `redactionProfile` naming a `RedactionV1` profile. Free-form prompt/argument text MUST NOT be a span attribute.

**R-tools-10.** The declaration's prompt fragment MUST be non-empty, ≤ 512 bytes, and describe *what the tool does and when to use it* - never how to obtain authority. Fragments are emitted into the provider tool schema block in a deterministic order (namespace then name) and are part of the byte-stable prefix governed by the cache guard in `10-cognition.md`.

### 2.2 Generation from one source of truth, and the build-time gate

**R-tools-11.** `ToolDeclarationV1` is defined once in `packages/protocol` (generated by `hz_codegen`). TypeScript types, the Rust `hz_abi` mirror, the JSON-Schema blob shipped to providers and the CLI help text MUST all be derived from it. No tool schema may be hand-maintained in a second place; the gate (R-tools-14) rejects a declaration whose generated fixture drifts from the committed fixture.

**R-tools-12.** The **completeness gate** `hzcode lint tools --gate completeness` `[planned]` MUST run during build and in CI and MUST fail (non-zero exit, no `--force` flag) when any declaration: (a) is missing any field of `ToolDeclarationV1` (R-tools-2); (b) has a value outside a declared enum; (c) is a duplicate `id` or a colliding session-level `name` under the policy of R-tools-46; (d) names a `capabilityId` absent from `_conventions.md` §5; (e) declares an `effectClass` weaker than the capability floor; (f) declares `readOnlyClass: pure_read` with an effect class other than `read-only`; (g) omits a resource scope or includes `**` where R-tools-5 forbids it; (h) omits a timeout; (i) declares no model-facing renderer; (j) declares an empty or oversized prompt fragment.

**R-tools-13.** The **prefix gate** `hzcode lint tools --gate prefix` `[planned]` MUST fail when the concatenated `promptFragment` block for the visible tool set changes bytes without a `prefixRevision` bump, mirroring the cache guard. Adding a tool or editing a fragment is therefore an explicit, reviewed event — never an accident of a refactor.

**R-tools-14.** **Golden fixtures.** Each declaration MUST render to `packages/tools/fixtures/<id>.json` `[planned]`. The gate compares generated output against the fixture and fails on any drift; the only accepted update path is `hzcode lint tools --update-fixtures`, which is a reviewed diff. Fixtures are also the input to the schema-compat ratchet: removing an input field or narrowing an output type is a breaking change that requires `HZ_PROTO` discussion.

**R-tools-15.** Validators are **compiled from the declarations at load**. A tool whose compiled validator fails to build is not registered and the registry snapshot records the omission as an explicit fact (`hz.error.raised` with `phase: register`); it MUST NOT appear in the model-visible tool list and MUST NOT be callable by name.

### 2.3 Registry, resolution, namespacing

**R-tools-16.** The registry is an index, not a dispatcher. It maps `id → declaration + implementation handle + provenance`. Every call MUST resolve to exactly one declaration; an unresolved id is `ToolNotFound` and MUST NOT fall back to shell, to a plugin, or to “closest match”.

**R-tools-17.** Namespaces are fixed: `builtin.<name>`, `plugin.<plugin-id>.<name>`, `mcp.<server-id>.<name>`, `skill.<skill-name>.<name>`, `dyn.<name>`. Tool families implemented in `@horizoncode/tools` are `builtin.` even when they drive native crates (`hz_shell`, `hz_edit`, …).

**R-tools-18.** Non-builtin tools enter the registry only through their provider: plugins via the signed `PluginManifestV1` capability declarations, MCP servers via `McpServerConfigV1` + a live `tools/list`, skills via `SkillManifestV1`, dynamic tools via the host's own declaration path. A contributed declaration MUST NOT claim a `capabilityId` its manifest did not request; the kernel compares the contributed set against the manifest and drops the tool (fail-closed) rather than narrowing it silently.

**R-tools-19.** MCP tools carry `readOnlyHint` if the server provides it; absent or `false` ⇒ treated as `mutating` with effect at least `external-effect`. A model MUST NOT be told that an MCP tool is read-only unless the hint is present.

**R-tools-20.** Name uniqueness is resolved deterministically by namespace rank: `builtin` > `plugin` > `mcp` > `skill` > `dyn`. The winner keeps the bare `name`; every loser is renamed `<name>_2`, `<name>_3`, … in rank order, and the rename is reported in the tool list. There MUST be no ambiguity at call time.

**R-tools-21.** A plugin or MCP server MUST NOT register under `builtin.`; a `skill.` tool MUST NOT be executable without the skill being loaded and the model having been told. Registration is idempotent: re-registering the same `id` with different bytes is an error, not a silent replace.

**R-tools-22.** The registry snapshot is content-addressed (`tools.snapshotSha256`) and recorded per step in `StepRecordV1`. Replay uses the *recorded* snapshot, not the current one, so a session that ran with a different tool set is reproducible.

**R-tools-23.** Workspace config may only **remove** tools or lower authority (allow-list narrowing, posture lowering). A workspace file MUST NOT add a tool, widen a scope, or raise a posture. Parsing a workspace config that attempts either MUST fail closed with `policy.denied` and a `hz.policy.revision.changed` fact.

### 2.4 Deferred discovery (`tool_search`)

**R-tools-24.** Deferred discovery is the default when the *visible* set would exceed the session's prompt budget (default threshold: 48 visible tools, or whenever the declared tool prefix would exceed 8,000 tokens). In deferred mode the model sees a core set (files, search, shell, `task`) plus `tool_search`; everything else is registered but **not** in the prompt prefix.

**R-tools-25.** `tool_search` MUST return declarations (name, description, one-line usage, input field names with types) and MUST NOT execute, sample, dry-run or probe any tool. It is read-only, has no lease, and MUST NOT touch the filesystem outside the registry index.

**R-tools-26.** Admission: a tool admitted by `tool_search` becomes part of the session's visible set for the remainder of the session (or for `ttlSteps` if the caller requests a shorter window). Admission is recorded as a session fact with `discovery: tool_search` and included in the next step's tool prefix (R-tools-13 applies: the admitted fragment joins the *projected* end of the prefix, never the stable head, so the cache guard is not broken).

**R-tools-27.** `tool_search` MUST filter against the session's **effective** tool set: it MUST NOT reveal, admit or describe a tool that policy, posture, allow-lists or the plugin trust decision has removed. Searching MUST NOT be a path to un-hiding authority.

#### 2.4.1 Implementation note — exposure classes (FEAT-002, research §1.6)

The shipped runtime realises a reduced form of R-tools-24…27 through one additive, optional field on the `Tool` interface (`app/src/contracts.ts`), `exposure`, with a companion optional `searchInfo: { keywords: string[] }`. Absent `exposure` means `"direct"` — exactly as an absent `concurrencyClass` means `"shared"` — so every shipped tool that sets nothing keeps today's behaviour (it appears in the default spec list and is callable). The four classes map to the codex `ToolExposure` reference:

| Exposure | Meaning in this runtime |
|---|---|
| `direct` | In the initial spec list the model sees from turn one (the default). |
| `deferred` | Absent from the default specs; discovered at runtime via `tool_search`, then visible + callable for the rest of that session. Carries `searchInfo.keywords` as the extra matching surface beyond its name and description. |
| `code_mode_only` | Reserved: excluded from the default specs; its nested code-mode child-list wiring is not yet implemented (only Direct/Deferred/Hidden are fully wired). |
| `hidden` | Never exposed in any spec list. |

`tool_search` (`app/src/tools/tool-search.ts`) is itself a Direct tool. Its matching is **data-driven** over each Deferred candidate's `searchInfo` (name + description + keywords): the query is tokenised and a candidate matches when any query token meets any of its fields (case-insensitive, ≥3-char substring/token match so common stop-words never match) — there is no per-tool-id logic, so a new Deferred tool needs no change to the meta-tool. On a match it records the unlocked names in a per-session discovery registry and returns the matched tools' full specs so the model can call them immediately; a no-match query unlocks nothing. Discovery makes `toolSpecs(sessionId)` include the unlocked tool and `getTool` resolve it for that session only. The `preview` tool ships Deferred (a niche dev-server tool; keywords preview/dev server/serve/localhost/http/port); every other shipped tool stays Direct. The loop refuses a Hidden, undiscovered-Deferred or CodeModeOnly tool at dispatch as defense in depth. This is runtime-only: no kernel event is added (the reserved `hz.tool.discovered` name stays reserved).

### 2.5 The execution pipeline

**R-tools-28.** Exactly one pipeline exists, and every invocation from every surface goes through it: `validate → permission decision → authorize → lease → execute → observe → settle → receipt`. The TUI, headless, server, web, desktop, IDE bridge, MCP server and SDKs drive it through the same Controller path; a front-end MUST NOT call a tool implementation directly.

| Stage | Owner | Fails closed by |
|---|---|---|
| `validate` | `@horizoncode/tools` | Invalid input ⇒ `ToolInputInvalid`, zero side effects, no lease requested |
| `permission decision` | `hzk` Guard (`hz_policy`) or the in-process policy mirror for `leaseClass: none` | Unknown/ambiguous decision ⇒ `deny` |
| `authorize` | `hzk` Guard | `ask` blocks the step and waits for a human answer; a model MUST NOT answer it |
| `lease` | `hzk` lease issuer | No lease ⇒ no execute. Leases are one-use, non-transferable, expiring |
| `execute` | effect host (native crate, sandboxed plugin host, or MCP transport) | Out-of-scope effect ⇒ confined action fails; unprovable outcome ⇒ `UNKNOWN` |
| `observe` | `@horizoncode/core` parts/streams | Unbounded output ⇒ truncated at the declared caps, spill to artifact, never block |
| `settle` | `hzk` + Controller | Harness result and host evidence must agree; disagreement ⇒ `hz.effect.unknown` |
| `receipt` | `hzk` | Mutations with no receipt MUST NOT be reported as done |

**R-tools-29.** `validate` MUST run before any effect, including before a permission prompt is shown (a human MUST NOT be asked to approve a call that cannot be parsed). Validation failure is terminal for the call and emits no lease request.

**R-tools-30.** The **permission decision** is produced by `Guard.authorize()` for every tool whose declaration requires a lease, and by the in-process mirror for tools that only touch session state (`leaseClass: session` or `none`). Precedence is `deny > ask > allow`; an `ask` that is never answered expires with the step and settles as `denied` with reason code `denied_by_grant_expired` (`GuardDecisionV1.reasonCode`; failure case F9 in `07-apis-and-contracts.md`), which is a denial for settlement purposes.

**R-tools-31.** An `ask` decision emits `hz.permission.asked` and suspends the step. Answers are accepted only from an origin of kind `UserAction`; `SessionBatch` (model-origin) answers are rejected by the kernel and recorded as an attempt.

**R-tools-32.** The **lease** is bound to `(sessionId, stepId, toolCallId, capabilityId, resourceScope, idempotencyKey?, expiry)`. It is one-use: a second invocation — including a retry, a subagent, or a resumed run — MUST present its own lease. Subagents receive capability *grants* (narrowed sets), never leases. Implementation note (stage 1): a child's tool cards are mirrored to the parent as a bounded `subagent.event` (tool.card, notice, error and final text only; text cut to 300 characters; 40 events per run); the child's receipts and session remain its own (`docs/28` ruling 54).

**R-tools-33.** **Execute** happens inside the effect host and only there. A native tool runs in its Rust crate with the lease as its confinement input; a plugin tool runs in the sandboxed plugin host with the same; an MCP tool runs remotely and is governed by `mcp.invoke` plus the server's declared scope. An effect observed outside the lease scope fails the call and is reported as a policy violation, not as a tool bug.

**R-tools-34.** **Observe** streams deltas as parts (`hz.part.updated`) under the caps of §3.7. Observation MUST NOT buffer without bound, and MUST NOT be the mechanism by which a tool reports success — that is `settle`.

**R-tools-35.** **Retry** is legal only for `read-only` tools and for `at_least_once` tools whose key is unchanged, and only when `RetryClassV1` says so. `at_most_once`/`non_idempotent` tools that already reached `execute` MUST NOT be retried automatically; the run MUST go through reconciliation (`11-authority-safety.md`).

**R-tools-36.** **Settle** requires agreement between the harness result and host evidence for every mutating call. If the process died, was killed, hit the timeout, or the backend lost the transport after the effect may have been dispatched, the outcome MUST be recorded `UNKNOWN` (`hz.effect.unknown`) and reconciled — never assumed, never silently retried, never reported as success.

**R-tools-37.** **Receipt.** Every `mutating`, `process`, `network`, `remote`, `credential` or `external-effect` call MUST settle into an `EffectReceiptV1` carrying the preimage/postimage where the resource has bytes, the `resourceScope` actually touched, the `capabilityId`, the `EffectOriginV1` (`SessionBatch`, `UserAction`, `ManagedRun`, `ManagedRoot`), and the lease id. Read-only calls MUST NOT emit an effect receipt - a pure read is un-receipted, except where a read crosses the workspace boundary, which is receipted as an effect (`07-apis-and-contracts.md` §10 item 8) - and session-state tools emit session facts, never receipts (§7.2, last row). A step that contains a mutation without a receipt MUST be reported as unfinished by `hzcode session verify`.

**R-tools-38.** **Origin typing.** A model-originated call is `EffectOriginKindV1: SessionBatch` and MUST NOT be able to present itself as `UserAction`, `ManagedRun` or `ManagedRoot`. Approving a prompt converts the *decision*, not the origin: the receipt records which human decision authorized which model request.

**R-tools-39.** **Concurrency.** `parallel_safe` calls may overlap within the per-session ceiling (§10); `serial` calls serialise on the session's execution claim; `exclusive` calls take the whole session. Two calls touching the same resource path MUST be ordered even when both are `parallel_safe`; the ordering key is the resolved scope (e.g. `workspace://src/a.ts`), not the model's arguments as written.

**R-tools-40.** **Cancellation.** A cancel (user, budget, or run teardown) takes effect at stage boundaries. Once `execute` has begun, cancellation escalates to kill, then to settle + reconcile; the step MUST still end with a terminal outcome (`completed` / `failed` / `UNKNOWN`), never with a silent disappearance.

### 2.6 Output rendering contract

**R-tools-41.** One `ToolResultV1` produces two renderings. The **model-facing** rendering is produced by `renderers.model` and MUST be byte-stable for identical inputs (so that replays and caches agree). The **human-facing** rendering is produced by `renderers.human` and MUST NOT be fed back to the model, logged into the transcript as content, or used as an evidence source for settlement.

**R-tools-42.** Default caps: model-facing text ≤ **16 KiB** and ≤ **4,000 tokens** per result; human-facing pane content ≤ **1 MiB** (the TUI virtualises, it does not page); the full untruncated stream ≤ **64 MiB** per call, above which the call fails with `OutputTooLarge` rather than spilling without limit. Structured output (`outputSchema` payload) is counted against the same budget as text.

**R-tools-43.** Truncation is **explicit and lossless-resumable**: every truncated result carries the one `truncated` shape defined by `ToolResultV1` (§3.6) — `truncated: { reason: 'bytes'|'tokens'|'lines'|'count'|'time', omittedBytes, omittedLines, nextOffset, artifactUri?, recoveryHint? }` — plus a `hz://artifact/<sha256>` pointer to the complete text whenever the call spilled. `reason: 'count'` covers a capped result set (matches, files, entries) and `reason: 'time'` a wall-clock cutoff; a budget-capped result set is never reported as complete. Silent truncation is a bug, not a budget.

**R-tools-44.** **Pagination** is by `offset`/`limit` (bytes or lines, declared per tool) and MUST be resumable: `nextOffset` returned by call *n* MUST yield the immediately following bytes on call *n+1*, with no gap and no overlap, provided the underlying resource is unchanged. A tool that cannot paginate MUST declare `pagination: none` and MUST be bounded by construction (`grep` max matches, `glob` max entries, `repo_map` token budget); the gate rejects `pagination: none` without a declared bound.

**R-tools-45.** Binary, image, audio and video payloads MUST NOT be inlined into model-facing text as base64. They are represented as `AttachmentV1` / `ArtifactV1` references (`sha256`, `mediaType`, `bytes`, dimensions/duration when known) and only rendered as pixels when a vision-capable model is active and the run's media budget allows it.

### 2.7 Error semantics per tool class

**R-tools-46.** Every failure is a `TypedErrorV1` with a `category` from `ErrorCategoryV1` and a `retryClass` from `RetryClassV1`. Human-readable text lives only in `message`; behaviour is driven by the typed fields. A tool MUST NOT convert an error into a cheerful model-facing sentence that hides its class.

**R-tools-47.** **Read-only tools.** Exit status of a read is data: “no matches”, “empty file”, “no definitions” are successful results with an empty payload, not errors. Failures (`NotFound`, `PermissionDenied`, `Binary`, `TooLarge`) are safe to retry, MUST NOT emit effect receipts, and MUST NOT be reported as completion evidence.

**R-tools-48.** **Mutating tools.** Partial application MUST NOT be reported as success. Multi-target mutations (`multi_edit`, `apply_patch`, `move`) are all-or-nothing across their target set: either every preimage matched and every postimage landed, or nothing changed and the call fails with `Conflict` (see §8.2). A mutating call that cannot prove its postimage is `UNKNOWN` and reconciled; it is never “probably fine”.

**R-tools-49.** **Network tools.** Failures are categorised `timeout | dns | tls | http_4xx | http_5xx | refused_by_policy`. `refused_by_policy` is terminal and MUST NOT be retried (retrying a denied fetch is an attempt to route around policy). Transient transport and `http_5xx` MAY be retried with jitter inside the step budget; `http_4xx` is not retried. Redirects MUST NOT cross an `net://` scope from the declaration.

**R-tools-50.** **Process tools.** Non-zero exit is a *result*: `{ exitCode, signal, stdout, stderr, durationMs }`. It is not automatically an error and MUST NOT be auto-retried. A process killed after a possible side effect is `UNKNOWN` unless the tool can prove otherwise. `shell_session` EOF, `job` termination and `pty` detach are terminal state transitions reported as results.

**R-tools-51.** A tool failure NEVER terminates the session by itself; it emits `hz.error.raised` and the step completes with the error visible to the model, subject to the run's fail policy. Budget-exhaustion errors terminate the *run*, not the session.

### 2.8 Deliberate omissions (rules, not preferences)

**R-tools-52.** No tool may accept an arbitrary program text where a typed model exists. There is no `eval`, no `exec_string`, no “run this snippet in the host process” tool. `shell` / `shell_session` / `powershell` / `container` / `ssh` are the only string-command surfaces, and each is policy-gated by `hz_policy` and confined by `hz_sandbox`.

**R-tools-53.** No tool may perform an unrequested remote write. There is no `git_push`, no `force_push`, no `publish`, no `deploy`, no `delete_remote_branch`. Where a remote write is genuinely needed it happens as a `UserAction`-origin effect after an explicit human decision, and it sites a receipt — it is not a model-callable tool (§5).

**R-tools-54.** No tool exposes a credential read. `secrets.read` exists as a capability in the registry for the *kernel's* own injection and redaction paths; no `ToolDeclarationV1` in this catalog declares it, and the gate asserts the catalog contains zero tools declaring `secrets.read` (§11).

**R-tools-55.** No unbounded recursive search. Every search-ish tool (`grep`, `glob`, `find`, `ast_grep`, `references`, `code_index`, `repo_map`) declares a bound (entries, matches, depth, tokens, time) and MUST stop with an explicit `truncated` marker when it hits it.

**R-tools-56.** No filesystem write outside the workspace without an explicit grant. The default scope for `files.*` is `workspace://**`; writing to a path outside the workspace requires a lease whose scope names that path, obtained through an `ask` that a human answered — the model cannot widen its own scope.

### 2.9 Adopted insertions (RC-15)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15); the two R-tools rules below were queued as R-tools-56/57 there and are renumbered to R-tools-57/58 at adoption to avoid collision with the existing R-tools-56.

**1. ACI reading-mode rules (NF-052) — verbatim:**

- **R-read-window-1.** `read` MUST accept `cursor: 'open' | 'next' | 'prev'` in addition to `path`/`startLine`/`endLine`. When `cursor` is present, the window is `readWindowLines` (default 100) long and the step is `readWindowLines - readOverlapLines` (default overlap 2), positioned within the file's bounds. The result MUST include `view: {path, firstLine, lastLine, totalLines, moreAbove, moreBelow}` and MUST render the top/bottom cut as `(N more lines above)` / `(N more lines below)` when non-zero.
- **R-read-window-2.** `read` MUST accept `gotoLine: number`, positioning the window so the line sits `floor(readWindowLines / 6)` lines below the window's first line; `gotoLine` on a symbol name MUST be resolved by the symbol index and reported as `resolvedVia: 'symbol'`.
- **R-read-window-3.** The session MUST retain the last window per path as session state (`view.cursor`), refreshed from observed `read`/`edit`/`insert` effects and never from model-authored text. `cursor: 'open'` re-renders that stored window; a stale cursor (path removed) MUST fail with `NotFound`, not silently re-open at line 1.
- **R-read-window-4.** A windowed `read` of a file longer than `readWindowLines` is the default when `path` is given without a range. A full-file read requires `full: true`, is capped by R-tools-42, and MUST report `truncated` with an artifact pointer.
- **R-edit-window-1.** When the session holds a window for the edited path, `edit` MUST resolve `oldString` **within that window**; a unique match elsewhere MUST NOT be applied and the call MUST fail with `detail.matchesOutsideWindow: [line…]` plus a `recoveryHint: "read the file at those lines first"`.
- **R-edit-window-2.** When `oldString` occurs more than once inside the window and `replaceAll=false`, `edit` MUST fail with `AmbiguousMatch` naming every match line in `detail.matches[]`.
- **R-edit-lint-1.** When a syntax check is available for the file's language, `edit`/`insert` MUST evaluate the postimage before writing. If the postimage introduces diagnostics absent from the preimage, the call MUST fail with `category: 'syntax-break'`, MUST leave the file byte-identical, and MUST return both the would-be postimage window and the current window in `detail`.
- **R-grep-summary-1.** `grep` MUST support `mode: 'summary'` returning `files: [{path, matchCount}]` and no match text. Above `grepSummaryMaxFiles` (default 100) it MUST return `truncated{reason: 'count'}` and a `recoveryHint` telling the model to narrow the pattern or scope, and MUST return no file list.
- **R-tools-57 (rendering).** Every model-facing result that reports an empty payload MUST render an explicit sentence (e.g. "the command succeeded and produced no output") instead of an empty block; every `truncated` result MUST carry a `recoveryHint` naming at least one cheaper follow-up call (`read` range, `grep -n`, `outline`, redirect-to-file).
- **R-tools-58 (state line).** The model-facing step tail MUST project an environment-derived state line (`openFile`, window range, `cwd`), produced by a state command and refreshed from observed effects. It MUST NOT be part of the byte-stable prefix, MUST NOT be model-authorable, and MUST NOT be counted as evidence for `verify`.

**2. Phase-2 `aci.*` group** (admitted only under a preset so the default tool prefix does not grow): `aci.open` (files.read, parallel_safe), `aci.goto` (line or symbol), `aci.scroll` (direction, pages), `aci.find` (summary|matches), `aci.insert` (files.patch, kernel lease). Cursor movement is session state (`lease: session`), never a kernel lease and never a tool argument. Prompt fragment + tests as drafted in the report §6 (cursor math, cursor persistence, outside-window refusal, lint-revert, summary cap at 101 files, recovery hints, narrated empty, state-not-model-authorable).

> **Naming note (`insert`).** The bare `insert` named in R-read-window-3 and R-edit-lint-1 is this item's `aci.insert`; §4 registers no bare `insert` tool, and the catalog↔`README.md` §3.2 coverage test (§11.2) would fail if one were added there without the README. R-edit-lint-1 therefore applies to `edit` in the v1 set and to `aci.insert` only once the preset admits it.

**3. Env-taming defaults:** the shell environment MUST default `PAGER=cat`, `MANPAGER=cat`, `GIT_PAGER=cat`, `LESS=-R`, `TQDM_DISABLE=1`, `PIP_PROGRESS_BAR=off`, and the interactive-command blocklist (`vim`, `less`, `tail -f`, bare `python`, …) applies unless explicitly overridden.

**4. Code-mode invariants (NF-051) — CM-1…CM-14, verbatim from the decision report:**

| # | Rule |
|---|---|
| CM-1 | The callable surface inside the snippet is exactly the declared subset ∩ `visibleTools(session)` ∩ the step's registry snapshot; nothing else resolves. |
| CM-2 | Subset enforcement is **static and total**: dynamic access (`tools[name]`), aliasing `tools`, and computed property calls are rejected by the scanner. |
| CM-3 | Every nested call re-enters the ordinary pipeline: resolve → Guard → durable prepare → its own one-use lease → execute → settle → receipt. The snippet never sees a lease, receipt id, or host object. |
| CM-4 | The outer `ask` shows the declared subset only, and covers exactly "run a confined program with this subset". Loops cannot widen it. |
| CM-5 | Amplification is bounded before the first inner call: `maxToolCalls` (default finite), per-inner-call budget, per-step lease ceiling, and the outer timeout. |
| CM-6 | Timing out or terminating the cell **never** reports a dispatched mutation as failed-safe: every inner call ends in a terminal state, `UNKNOWN` when the transport died after dispatch, and the step reconciles. |
| CM-7 | The result's audit table carries, per call: `toolId`, `toolCallId`, `leaseId`, `receiptId?`, terminal state, `ms`. Read-only calls emit no effect-claiming receipt. |
| CM-8 | Confinement is declared as a guarantee vector with typed residuals, and the operation fails closed when the host cannot meet the caller's minimum (`SandboxUnavailable`). |
| CM-9 | The snippet's engine has no ambient I/O: no filesystem, network, process, `WebAssembly`, shared memory, dynamic codegen of host bindings; imports resolve only to declared globals. |
| CM-10 | Discovery inside the snippet is a pipeline call (`search(...)` lowers to `tool_search`), admitted, counted, paginated, respecting `admitTools`/visibility. |
| CM-11 | Snippet state (`store`/`load`) is JSON-only, session-scoped, snapshotted per exec, and never authority. |
| CM-12 | Snippet output is untrusted data: bounded, truncated with an in-band marker, never re-parsed as tool ids/receipt ids/decisions, never a completion claim. |
| CM-13 | Default posture is one-shot with a bounded wall clock **plus** an explicit cell mode (`exec\|wait\|terminate`, `cellId`), session-scoped and receipted; no cell survives session termination. |
| CM-14 | Resource caps (heap/wall/call-count/output) are settable per session and actually enforced (no "plumbed but reset to none" gap). |

**5. Dual-output result rendering** (NF-061): the model sees `content`; the UI sees `metadata`; code mode sees `machineOutput` (ephemeral). Retention failure ⇒ operational failure (§D-05).

**6. Cancellation taxonomy:** "effect interruption is the cancellation mechanism" — tools MUST NOT translate interruption or defects into model-visible failures; broad catch-around-execute is invalid because it consumes interruption and defects. Terminal vocabulary is RC-7's single enum.

**7. Reserved tool name `execute` and name normalization:** `execute` is reserved (code-mode call surface); tool names normalize unsupported characters to `_` at declaration load.

### 2.10 Adoption-wave extensions (RC-15)

> Adopted 2026-11-07 from the adoption wave ([30-steal-list.md](./30-steal-list.md) §2; sources A.9.4 aider and A.9.5 mini-swe-agent).

- **Repo-map ranking (extends `repo_map`, §4.2):** the ranking is a tree-sitter def/ref graph scored by personalised PageRank against the task context, with a binary search over the token budget to pick the cut point — no embeddings, no index service, no extra model call. The aider weight table is the starting prior and is re-tuned only against measured benchmark evidence, never by taste.
- **Edit-application ladder (extends NF-069):** apply `oldString` exact → after relative-indent normalisation → three-way merge → line-level patch. On failure the result MUST return the failing block, the actual lines that most resemble it, and whether the REPLACE lines are already present — diff-shaped feedback the model can fix in one shot. A single bounded reflection slot caps self-repair; it is not a retry loop.
- **Tolerant argument decoding (extends NF-069, ruling 67):** `core/json-repair.ts` repairs syntactic slips in a tool-call argument blob (trailing commas, single/smart quotes, unquoted keys, code fences, raw newlines) and coerces unambiguous scalars to the tool's schema. A truncated blob is completed only for read-only tools; for `shell`, `write`, `edit`, `apply_patch` and MCP tools it is refused. Every repair is counted and the receipt hashes the repaired args.
- **Git hygiene (E-1/E-3/E-4):** commit dirty state before a multi-edit turn so the edit diff is attributable; keep lint-fix commits separate from feature commits; generate commit messages from the diff **plus** conversation context (Conventional Commits, weak-model-first with a token-limit fallback); and keep a continuous Markdown transcript for resume and post-mortem.

---

## 3. Interfaces

Everything a caller can touch is listed here. All symbols are `[planned]` (design only).

### 3.1 Types and functions this subsystem owns

| Symbol | Kind | Responsibility |
|---|---|---|
| `ToolDeclarationV1` | schema | The declaration (§2.1, owned by `05-domain-and-schemas.md`) |
| `ToolPermissionV1` | schema | Permission rule or decision - resource scope, decision, one-use grant (owned by `05-domain-and-schemas.md` §4.7) |
| `ToolCallV1` | schema | `{ toolCallId, toolId, args, origin, stepId, leaseId? }` — the only legal way to invoke |
| `ToolResultV1` | schema | `{ toolCallId, status, data?, rendered, truncated?, error?, usage, artifactRefs[], receiptId? }` |
| `ToolRegistrySnapshotV1` | schema | `{ snapshotSha256, entries[], omitted[{id, reason}] }`, recorded per step |
| `loadDeclarations(dir)` | function | Reads declaration modules, returns declarations without implementations |
| `compileValidators(decls)` | function | Compiles JSON-Schema validators once per process; throws on an uncompilable schema |
| `validateArgs(decl, args)` | function | Pure; returns `Ok | ToolInputInvalid`; never has side effects |
| `resolveTool(registry, toolId)` | function | Exact-id lookup; `ToolNotFound` on absence — no fuzzy match |
| `visibleTools(registry, session)` | function | Applies policy, posture, allow-list, trust and deferred-discovery filters |
| `searchTools(registry, query, session)` | function | `tool_search` implementation; pure over the registry |
| `admitTools(session, ids, ttlSteps?)` | function | Records the admission fact; returns the new visible set |
| `runTool(ctx, call)` | function | The pipeline of R-tools-28; the only entry point |
| `renderModel(result)` / `renderHuman(result)` | functions | The two renderings of R-tools-41 |
| `truncateModelText(text, caps)` | function | Applies R-tools-42/43, returns text + `truncated` descriptor |
| `paginate(source, offset, limit)` | function | Resumable window used by R-tools-44 |
| `hzcode lint tools --gate completeness\|prefix\|fixtures\|capabilities` | CLI | The gates of §2.2 and §11 |

### 3.2 Registry, resolution and naming

```
rank(builtin) = 0   rank(plugin) = 1   rank(mcp) = 2   rank(skill) = 3   rank(dyn) = 4
name(entry)   = bare name          if rank is lowest among claimants
              = <name>_<k>         for the k-th claimant in rank order (k >= 2)
```

Resolution algorithm (`resolveTool`) `[planned]`:

1. Exact `id` match. Miss ⇒ `ToolNotFound` (terminal, no fallback).
2. Check the entry is in `visibleTools(session)`. Miss ⇒ `ToolNotVisible` (the model was not told about it; the call is refused, and a `tool_search` is suggested in the model-facing error text only).
3. Check the entry is in the step's registry snapshot. Miss ⇒ `ToolSnapshotMismatch` (replay safety, R-tools-22).
4. Proceed to validation (R-tools-29).

Registry invariants enforced at registration, not at call time: unique `id`; no duplicate `(id, bytes)`; no `builtin.` claim by a plugin or MCP server; no entry without a compiled validator; no entry whose `capabilityId` is absent from the contributor's manifest capabilities, and no contributed call path that leases a capability its manifest did not request (R-tools-18 — the declaration carries one capability, so this check is per declaration, not per list).

### 3.3 `tool_search` contract

```jsonc
// input (ToolSearchQueryV1)
{ "query": "string, 1..256",           // free text or "capability:files.write" / "namespace:mcp" selectors
  "namespace": "builtin|plugin|mcp|skill|dyn|null",
  "limit": 1..25,                      // default 8
  "includeSchemas": false,
  "ttlSteps": 1..1000                 // null = session lifetime
}

// output
{ "matches": [ { "id": "mcp.github.create_pr", "name": "create_pr", "namespace": "mcp",
                  "description": "<=200 chars", "usage": "one line, <=200 chars",
                  "capabilityId": "mcp.invoke", "effectClass": "external-effect",
                  "readOnly": false, "inputFields": [ { "name": "repo", "type": "string", "required": true } ],
                  "schema": { /* only if includeSchemas */ } } ],
  "admitted": [ "mcp.github.create_pr" ],
  "truncated": null }
```

`usage` is generated from `promptFragment` and MUST NOT be authored separately. `tool_search` never returns a tool the session cannot call (R-tools-27) and never executes anything (R-tools-25).

### 3.4 Pipeline interfaces

| Stage | Call | Input | Output | On failure |
|---|---|---|---|---|
| `validate` | `validateArgs(decl, call.args)` | declaration + args | `Args` typed | `ToolInputInvalid`, no lease, terminal |
| `permission decision` | `Guard.authorize(EffectRequestV1)` | `{ capabilityId, scope, origin, posture, sessionId }` | `GuardDecisionV1` | unknown ⇒ `deny` |
| `authorize` | `hz.permission.asked` / `hz.permission.answered` | decision + UI | `UserAction` answer or expiry | expiry ⇒ denial |
| `lease` | `IssueLease(...)` `[planned]` | decision + `idempotencyKey` | `LeaseV1` | no lease ⇒ no execute |
| `execute` | `EffectHost.execute(...)` | lease + typed call | raw result + host evidence | out-of-scope ⇒ policy violation; unprovable ⇒ `UNKNOWN` |
| `observe` | `appendPart(...)` | stream deltas | `PartV1`s | over cap ⇒ truncate + artifact |
| `settle` | `settleEffect(...)` | harness result + evidence | `hz.effect.settled` / `hz.effect.unknown` | disagreement ⇒ `UNKNOWN` + reconcile |
| `receipt` | `EffectReceiptV1` write | settlement | receipt id | missing receipt ⇒ step incomplete |

### 3.5 Events owned or consumed

Owned (payloads defined in `06-events-and-flows.md`): `hz.step.tool.requested`, `hz.step.tool.completed`.

Consumed: `hz.effect.decision.made`, `hz.effect.lease.issued`, `hz.effect.settled`, `hz.effect.unknown`, `hz.effect.reconciled`, `hz.permission.asked`, `hz.permission.answered`, `hz.part.created`, `hz.part.updated`, `hz.error.raised`, `hz.usage.recorded`.

Every tool call emits exactly one `hz.step.tool.requested` and exactly one `hz.step.tool.completed` (including `failed` and `UNKNOWN` outcomes — an unfinished call still terminates its pair).

### 3.6 `ToolResultV1` — the shape everything renders from

```jsonc
{ "toolCallId": "01J...", "toolId": "builtin.edit", "status": "ok|error|unknown",
  "data": { /* conforms to outputSchema */ },
  "rendered": { "model": "<text, <=16KiB>", "human": "<renderer id or null>", "renderFallback": false },
  "truncated": { "reason": "bytes", "omittedBytes": 212992, "nextOffset": 16384, "artifactUri": "hz://artifact/<sha256>" },
  "error": { "category": "conflict", "retryClass": "no-retry", "message": "...", "detail": { "path": "src/a.ts", "expectedSha256": "...", "actualSha256": "..." } },
  "usage": { "durationMs": 41, "bytesIn": 2048, "bytesOut": 16384, "tokens": 3880 },
  "artifactRefs": [ "hz://artifact/<sha256>" ], "receiptId": "hz://receipt/<ulid>", "settlement": "settled|unknown|n/a" }
```

`status` and `settlement` are independent on purpose: a tool can return `ok` while the *effect* is unprovable (then `settlement: unknown`), and that is exactly the case reconciliation exists for.

Two cross-document vocabulary rules attach to this shape. **Terminal state** is RC-7's single enum in `@horizoncode/protocol` (`_conventions.md` §11: `succeeded` | `failed` | `denied` | `cancelled` | `unknown` | `budget_exhausted` | `timeout` | `interrupted`); `status` and `settlement` above are result- and settlement-level fields and MUST NOT be used as, or renamed into, terminal-state names. **`truncated`** is likewise one shape everywhere — the discriminator above, defined by R-tools-43. No tool, event, surface or other document may use a boolean or a second object for it; a catalog entry that writes `truncated: TruncationV1` means exactly this object, and `null` (or absence) means nothing was omitted.

---

## 4. Tool catalog

Every tool listed in `../README.md` §3.2 is enumerated below. Each entry states: purpose · key inputs (with types) · key outputs · capability id · effect class · read-only class · permission class · notable failure modes.

**Legend.** *eff* = declared (maximum) effect class. *RO* = read-only class in this catalog's shorthand (`yes` = `pure_read`, `cond` = `read_with_side_effects`, `no` = `mutating`; the enum itself is fixed by `05-domain-and-schemas.md` §4.7). *perm* = posture floor (`allow` = no prompt under the default `ask` posture; `ask` = prompt unless the user pre-approved; `deny` = not callable until explicitly enabled by the user). *lease* = `kernel` (one-use `hz` lease), `session` (session-state write claim, no kernel lease), `none`. *aux* = a capability the call **leases separately and one-use** in addition to the declared one (R-tools-32) — a call-time fact, never a second field on the declaration (§2.1).

### 4.1 Files

#### `read` — `builtin.read`
- **Purpose.** Read a file range as text with stable line numbering and an explicit truncation/pagination contract.
- **Input.** `path: string`, `startLine?: number`, `endLine?: number`, `maxBytes?: number` (default 16384, hard 65536), `encoding?: 'utf8'|'latin1'`.
- **Output.** `content: string` (numbered lines), `bytes: number`, `lines: number`, `sha256: string`, `truncated: TruncationV1|null`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` inside `workspace://`; `ask` for a granted path outside it · **lease** none
- **Fails.** `NotFound`; `PermissionDenied`; `BinaryFile` (returns an artifact ref instead of bytes); `TooLarge` above the hard cap; directory path ⇒ `IsDirectory` (never a recursive read).

#### `read_many` — `builtin.read_many`
- **Purpose.** Batched `read` over ≤ 32 paths so a model can look at a set of files in one call and get one budget-shared result.
- **Input.** `files: Array<{path: string, startLine?: number, endLine?: number}>`, `maxBytesTotal?: number` (default 32768), `maxBytesPerFile?: number`.
- **Output.** `entries: Array<{path, content, bytes, sha256, truncated} | {path, error: TypedErrorV1}>`, `bytesTotal: number`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` (per-path grant check applies to each entry) · **lease** none
- **Fails.** Per-entry errors do not fail the call (partial success is the contract); a call fails only if every entry fails; the shared budget truncates deterministically in argument order with `truncated.partialPaths[]`.

#### `write` — `builtin.write`
- **Purpose.** Create or overwrite a whole file (the only tool allowed to replace a file wholesale), guarded by an optional precondition hash.
- **Input.** `path: string`, `content: string` (≤ 8 MiB), `expectedSha256?: string`, `createDirs?: boolean` (default false), `mode?: number`.
- **Output.** `path`, `bytes`, `sha256`, `preimageSha256: string|null`, `created: boolean`.
- **capability** `files.write` · **eff** `workspace-write` · **RO** no · **perm** `ask` when the target is new or the diff exceeds the run's size threshold; otherwise `allow` inside the workspace · **lease** kernel
- **Fails.** `FileExists` when `createDirs`/create semantics forbid overwrite; `Conflict` when `expectedSha256` mismatches (stale preimage); `IsDirectory`; `DiskFull`; `ReadOnlyMount`. Interrupted writes leave a temp file and MUST NOT be reported as success.

#### `edit` — `builtin.edit`
- **Purpose.** Replace an exact string occurrence (or a line range) in one file with conflict detection — the default code-change tool.
- **Input.** `path: string`, `oldString: string`, `newString: string`, `replaceAll?: boolean` (default false), `expectedSha256?: string`, `lineRange?: [number, number]` (alternative addressing).
- **Output.** `path`, `replacements: number`, `preimageSha256`, `postimageSha256`, `diff: string`, `firstChangedLine: number`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` on first edit of a file per run when the run posture is `ask`; `allow` under full-access · **lease** kernel
- **Fails.** `NoMatch` (oldString absent); `AmbiguousMatch` (multiple matches and `replaceAll=false`) — the error includes the count and the candidate line numbers; `Conflict` (file changed since read, R-48/§8.2); `NoChange` (newString == oldString) is reported as a no-op error, not a success.

#### `multi_edit` — `builtin.multi_edit`
- **Purpose.** Apply an ordered list of edits across several files as one all-or-nothing transaction.
- **Input.** `edits: Array<{path, oldString, newString, replaceAll?}>` (≤ 64 entries), `expectedSha256?: Record<path, string>`.
- **Output.** `applied: number`, `files: Array<{path, replacements, preimageSha256, postimageSha256}>`, `diff`, `rolledBack: boolean`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` (a multi-file change is never silent under a workspace-write posture) · **lease** kernel
- **Fails.** Any entry failing ⇒ nothing is written (`rolledBack: true`) and the failing entry's error is returned; `AtomicityUnsupported` if the backend cannot roll back (surfaced, never downgraded to best-effort).

#### `patch` — `builtin.patch`
- **Purpose.** Apply a unified diff with fuzz control and explicit context matching.
- **Input.** `path: string`, `diff: string`, `strip?: number`, `fuzz?: 0|1|2` (default 0), `expectedSha256?: string`.
- **Output.** `path`, `hunksApplied: number`, `hunksRejected: number`, `postimageSha256`, `diff` (actual).
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` outside the session's own pending-diff set · **lease** kernel
- **Fails.** `ContextMismatch` per hunk with the offset found; partial application is never reported as success (R-tools-48) — either the patch applies cleanly under the declared fuzz or the call fails and the file is untouched.

#### `apply_patch` — `builtin.apply_patch`
- **Purpose.** Apply a multi-file, multi-hunk patch (the envelope format the model writes most often), including file creation and deletion.
- **Input.** `patch: string` (envelope with `*** Add File` / `*** Update File` / `*** Delete File` arms), `createDirs?: boolean`.
- **Output.** `files: Array<{path, action: 'add'|'update'|'delete', hunks, postimageSha256|null}>`, `diff`.
- **capability** `files.patch`, with `files.write` for add arms and **`files.delete`** for delete arms (R-tools-4) · **eff** `workspace-write` · **RO** no · **perm** `ask`; a delete arm raises the decision to `ask` even under full-access when the file is untracked · **lease** kernel
- **Fails.** Malformed envelope (parse error, no effects); delete arm without the `files.delete` capability in the lease ⇒ whole patch denied; any hunk mismatch ⇒ whole patch fails atomically.

#### `notebook_edit` — `builtin.notebook_edit`
- **Purpose.** Edit a single `.ipynb` cell (source or metadata) without hand-managing JSON.
- **Input.** `path: string`, `cellIndex: number`, `mode: 'replace'|'insert'|'delete'|'metadata'`, `source?: string`, `cellType?: 'code'|'markdown'`, `metadata?: Record<string, unknown>`.
- **Output.** `path`, `cellCount`, `postimageSha256`, `cellDiff: string` (rendered JSON patch), `executionCountPreserved: boolean`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` · **lease** kernel
- **Fails.** `NotANotebook`; `InvalidCellIndex`; `MalformedNotebook` (the whole file is refused, never partially rewritten); outputs are preserved unless the caller explicitly clears them.

#### `delete_range` — `builtin.delete_range`
- **Purpose.** Delete a line or byte range from a file, with syntax-aware trimming as an option.
- **Input.** `path: string`, `startLine: number`, `endLine: number`, `syntaxAware?: boolean` (default false), `expectedSha256?: string`.
- **Output.** `path`, `linesRemoved: number`, `postimageSha256`, `diff`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` · **lease** kernel
- **Fails.** `OutOfRange`; `SyntaxBreak` when `syntaxAware` detects an unbalanced result (advisory failure the caller may override explicitly); `Conflict` on stale preimage.

#### `delete_symbol` — `builtin.delete_symbol`
- **Purpose.** Delete a whole symbol (function/class/const) located by the AST index rather than by line numbers.
- **Input.** `path: string`, `symbol: string`, `kind?: string`, `includeDocComments?: boolean` (default true), `expectedSha256?: string`.
- **Output.** `path`, `removedRange: [number, number]`, `removedLines: number`, `postimageSha256`, `diff`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` · **lease** kernel
- **Fails.** `SymbolNotFound`; `AmbiguousSymbol` (reports all definitions and their ranges); `ParseError` (file not covered by the AST layer ⇒ suggests `edit`/`delete_range`); refuses to delete the last export of a package entry point without `force: true`.

#### `move` — `builtin.move`
- **Purpose.** Move or rename a path, optionally rewriting importers so the rename stays coherent.
- **Input.** `from: string`, `to: string`, `updateImports?: boolean` (default false), `overwrite?: boolean` (default false).
- **Output.** `from`, `to`, `moved: boolean`, `importersChanged: Array<{path, edits}>`, `postimageSha256`.
- **capability** `files.move` (plus `files.patch` when `updateImports`) · **eff** `workspace-write` · **RO** no · **perm** `ask` (a move is a history-visible event; never silent) · **lease** kernel
- **Fails.** `TargetExists` without `overwrite`; `CrossDevice` (explicit copy+delete only when the caller asks); partial importer rewrite rolls the move back; a case-only rename on a case-insensitive filesystem is reported explicitly.

#### `undo` — `builtin.undo`
- **Purpose.** Revert the last tool-made change to one path (session journal based), falling back to a VCS checkout when the path is tracked and clean.
- **Input.** `path: string`, `steps?: number` (default 1), `mode?: 'session'|'vcs'|'auto'` (default `auto`).
- **Output.** `path`, `modeUsed`, `postimageSha256`, `revertedToSha256`, `diff`.
- **capability** `files.patch` with aux `vcs.read` · **eff** `workspace-write` · **RO** no · **perm** `ask` only when the revert would touch lines changed by a human since the tool's edit (detected via `vcs.read`) · **lease** kernel
- **Fails.** `NothingToUndo`; `HumanEditsPresent` (the revert is refused unless the caller overrides explicitly — undoing a human is never automatic); `VcsUnavailable` when `mode: 'vcs'`.

#### `attach` — `builtin.attach`
- **Purpose.** Pull external content into the run as an `AttachmentV1` (local path or URL) so later steps can reference it without re-reading.
- **Input.** `source: string` (path or URL), `mediaType?: string`, `maxBytes?: number` (default 8 MiB), `store?: 'session'|'artifact'`.
- **Output.** `attachmentId`, `mediaType`, `bytes`, `sha256`, `artifactUri`, `previewText?: string` (≤ 2 KiB).
- **capability** `files.read` for paths, `net.fetch` for URLs · **eff** `read-only` (path) / `network` (URL) · **RO** cond (`read-onlyWhen: source-is-local-path`) · **perm** `allow` for paths in scope, `ask` for network · **lease** kernel for the URL variant, none for the local variant
- **Fails.** `TooLarge`; `UnsupportedMediaType`; URL variant: the R-49 network categories; content sniffing mismatch (declared `mediaType` disagrees with sniffed type ⇒ error, not silent coercion).

#### `snapshot` — `builtin.snapshot`
- **Purpose.** Take a content-addressed snapshot of the workspace (or a subtree) so a later `rewind` has a preimage.
- **Input.** `paths?: string[]` (default: workspace), `label?: string`, `includeIgnored?: boolean` (default false).
- **Output.** `snapshotId` (`hz://snapshot/<id>`), `roots: string[]`, `files: number`, `bytes`, `createdAt`.
- **capability** `worktree.manage` · **eff** `workspace-write` (writes to the snapshot store, not to workspace files) · **RO** cond (`read-onlyWhen: paths-empty-and-store-warm`) — practically `mutating` · **perm** `allow` (it does not modify user content) · **lease** kernel
- **Fails.** `StoreFull`; `TooManyFiles` above the snapshot bound; a dirty submodule is recorded as an explicit residual rather than silently flattened.

#### `rewind` — `builtin.rewind`
- **Purpose.** Restore the workspace (or a subtree) to a snapshot id, optionally keeping a safety snapshot of the current state.
- **Input.** `snapshotId: string`, `paths?: string[]`, `keepCurrent?: boolean` (default true), `confirmToken?: string`.
- **Output.** `restored: string[]`, `safetySnapshotId`, `filesChanged`, `diff`.
- **capability** `worktree.manage` with aux `files.patch`, `files.delete` · **eff** `workspace-write` · **RO** no · **perm** `ask` always (destructive by nature, even under full-access) · **lease** kernel
- **Fails.** `SnapshotNotFound`; `HumanEditsPresent` unless `confirmToken` is supplied (a rewind that would discard human work never proceeds implicitly); `PartialRestore` is impossible by construction — a failed rewind restores the safety snapshot and reports `rolledBack: true`.

### 4.2 Search & navigation

#### `glob` — `builtin.glob`
- **Purpose.** Find paths by pattern (ignore-aware, parallel walker `hz_walker`).
- **Input.** `pattern: string` (glob, `**` allowed), `path?: string` (root, default workspace), `maxResults?: number` (default 500, hard 20000), `includeIgnored?: boolean` (default false), `type?: 'file'|'dir'|'any'`, `sort?: 'path'|'mtime'`.
- **Output.** `paths: string[]`, `count: number`, `truncated: TruncationV1|null`, `walkStats: {dirs, files, ms}`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` inside `workspace://`; `ask` if the root is outside · **lease** none
- **Fails.** `InvalidPattern`; `RootNotFound`; the walk respects `.gitignore` unless overridden; a pattern whose result set exceeds `maxResults` returns `truncated` (never a silent partial list, R-tools-55).

#### `grep` — `builtin.grep`
- **Purpose.** Regex/text search over file contents with context lines, file-type filters and per-file caps.
- **Input.** `pattern: string`, `path?: string`, `glob?: string`, `caseSensitive?: boolean` (default true), `contextLines?: number` (0..10), `maxMatches?: number` (default 200, hard 5000), `maxBytesPerMatch?: number`, `filesOnly?: boolean`.
- **Output.** `matches: Array<{path, line, column, text, context?}>`, `matchCount`, `fileCount`, `truncated`, `timedOut: boolean`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `InvalidRegex`; `NoMatches` is a successful empty result (R-47); a 10 s wall-clock cap returns partial results with `truncated.reason: 'time'`; binary files are skipped and listed in `skippedFiles[]`.

#### `find` — `builtin.find`
- **Purpose.** Structured predicate search over the file tree (name/size/mtime/type/content-hash), i.e. “the filesystem query language” rather than a pattern.
- **Input.** `nameMatches?: string`, `pathPrefix?: string`, `modifiedAfter?: string` (ISO), `sizeMin?: number`, `sizeMax?: number`, `hasContent?: string`, `maxResults?: number` (default 200).
- **Output.** `files: Array<{path, size, mtimeMs, sha256?}>`, `count`, `truncated`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** No predicate supplied ⇒ `InvalidInput` (an unbounded listing is exactly what R-tools-55 forbids); `PathPrefixOutsideScope` when the prefix escapes the workspace; mtime-only predicates are disk-cache sensitive and reported with `precisionWarning`.

#### `ast_grep` — `builtin.ast_grep`
- **Purpose.** Structural (tree-sitter) query across languages: match code shapes, including metavariables, not text.
- **Input.** `query: string` (pattern or `$$$` metavars), `lang?: string`, `path?: string`, `limit?: number` (default 200), `includeRewritePreview?: boolean`.
- **Output.** `matches: Array<{path, range, snippet, captures: Record<string,string>}>`, `count`, `truncated`, `languagesSkipped: string[]`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `UnsupportedLanguage`; `QueryParseError` (with the offending token); a multi-language scan reports `languagesSkipped` rather than silently ignoring files; results are capped per file to keep one huge file from consuming the budget.

#### `ast_edit` — `builtin.ast_edit`
- **Purpose.** Structural rewrite: apply a `ast_grep` pattern/replacement across files with capture substitution.
- **Input.** `query: string`, `replacement: string`, `path?: string`, `lang?: string`, `dryRun?: boolean` (default true), `expectedSha256?: Record<path,string>`, `limit?: number`.
- **Output.** `planned: Array<{path, edits, diff}>`, `applied: number`, `dryRun: boolean`, `postimages: Record<path,string>`.
- **capability** `files.patch` · **eff** `workspace-write` · **RO** no · **perm** `ask` (a rewrite across many files always prompts under `ask` posture) · **lease** kernel
- **Fails.** `QueryParseError`; `ReplacementCaptureMissing`; `Conflict` on any stale preimage aborts the whole rewrite; `dryRun` defaults to `true` so an accidental call cannot mutate — the model must opt in explicitly.

#### `symbols` — `builtin.symbols`
- **Purpose.** List symbols in a file/directory/workspace with kinds, ranges and container nesting (`hz_index` + LSP when available).
- **Input.** `path?: string`, `query?: string` (substring), `kind?: 'function'|'class'|'method'|'const'|'interface'|'any'`, `maxResults?: number` (default 200), `depth?: number`.
- **Output.** `symbols: Array<{name, kind, path, range, container?, exported?}>`, `count`, `truncated`, `source: 'index'|'lsp'`.
- **capability** `language.symbols` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `IndexStale` is reported with a `stale: true` flag rather than silently returning old data; `NoLanguageSupport`; symbol queries never fall back to grep results in the same payload (the model must choose `grep`).

#### `references` — `builtin.references`
- **Purpose.** Find all references to a symbol (declaration + uses), index-first with LSP confirmation when a server is attached.
- **Input.** `path: string`, `line: number`, `column: number` or `symbol: string`, `includeDeclaration?: boolean` (default true), `maxResults?: number` (default 200).
- **Output.** `references: Array<{path, range, kind: 'declaration'|'use'|'import'|'unknown', snippet}>`, `count`, `truncated`, `confidence: 'exact'|'index-only'`.
- **capability** `language.symbols` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `SymbolNotFound`; `AmbiguousSymbol`; without an LSP the result carries `confidence: 'index-only'` and MUST NOT be presented as exact (dynamic dispatch and strings are missed); a rename must not be attempted from this data alone.

#### `definitions` — `builtin.definitions`
- **Purpose.** Resolve a use site to its definition(s), including cross-file and re-export chains.
- **Input.** `path: string`, `line: number`, `column: number`, `followReexports?: boolean` (default true).
- **Output.** `definitions: Array<{path, range, snippet, via?: string[]}>`, `count`, `unresolved: boolean`.
- **capability** `language.symbols` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `PositionOutOfRange`; `Unresolved` (reported as a result with `unresolved: true`, not as a crash); ambiguity above 8 candidates is truncated with a note to narrow the position.

#### `repo_map` — `builtin.repo_map`
- **Purpose.** Produce a token-budgeted map of the repository (top symbols per file/directory) for orientation without reading everything.
- **Input.** `path?: string`, `maxTokens?: number` (default 4000, hard 16000), `focus?: string[]` (paths), `includeTests?: boolean` (default false).
- **Output.** `map: string` (indented tree with symbol lines), `tokens: number`, `filesIncluded`, `filesOmitted`, `truncated`.
- **capability** `files.read` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `EmptyWorkspace`; the map is byte-stable for the same snapshot `(snapshotSha256, params)` so it can be cached and compared in tests; a stale index is marked `stale: true`.

#### `code_index` — `builtin.code_index`
- **Purpose.** Build, refresh or query the lexical + symbol + reference index (BM25 + embeddings + symbol tables) for the workspace.
- **Input.** `mode: 'status'|'build'|'refresh'|'query'`, `query?: string`, `path?: string`, `k?: number` (default 20), `force?: boolean` (default false).
- **Output.** `status: {files, symbols, refs, version, builtAt, stale}`, `results?: Array<{path, range, score, snippet}>`.
- **capability** `files.read` (queries) · **eff** `read-only` for `status`/`query`, `workspace-write` for `build`/`refresh` · **RO** cond (`readOnlyWhen: mode-in-query-status`) · **perm** `allow` (index writes are confined to the `cache://` scope, R-tools-4/§7) · **lease** kernel for `build`/`refresh`, none for `query`
- **Fails.** `IndexBuilding` (query returns `stale` results with an explicit flag rather than blocking); `IndexCorrupt` ⇒ falls back to `build` only with `force: true`; embedding models unavailable ⇒ lexical-only mode with an explicit `degraded: 'lexical-only'` field.

#### `outline` — `builtin.outline`
- **Purpose.** Show the structural outline of one file (imports, symbols, tests, TODOs) as a cheap substitute for reading it whole.
- **Input.** `path: string`, `maxDepth?: number` (default 2), `includeComments?: boolean` (default false), `maxTokens?: number` (default 1000).
- **Output.** `outline: Array<{kind, name, range, doc?}>`, `tokens`, `syntaxErrors: number`.
- **capability** `language.symbols` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `UnsupportedLanguage` (a plain text outline with line numbers is returned instead, flagged `fallback: true`); `ParseError` is reported with the count of recoverable syntax errors, not as a call failure.

### 4.3 Execution

#### `shell` — `builtin.shell`
- **Purpose.** Run one command in the workspace shell (embedded bash `hz_shell`, injectable VFS), foreground / background / (optionally) PTY-attached.
- **Input.** `command: string`, `cwd?: string`, `timeoutMs?: number` (default 120000, hard 600000), `mode?: 'fg'|'bg'|'pty'` (default `fg`), `env?: Record<string,string>` (allow-listed names only), `stdin?: string`, `maxBytesOut?: number`.
- **Output.** `exitCode: number|null`, `signal: string|null`, `stdout: string`, `stderr: string`, `durationMs`, `jobId?: string` (bg), `ptyId?: string`, `truncated`.
- **capability** `terminal.run` · **eff** `process` · **RO** no · **perm** decided by `hz_policy` (`Shell(git status)` etc.), precedence `deny > ask > allow`; unknown command shape ⇒ `ask` · **lease** kernel
- **Fails.** `CommandDenied` (policy; terminal, not retryable); `Timeout` (kill; if the command may have mutated, settlement is `UNKNOWN`); non-zero exit is a *result*, not an error (R-tools-50); output above the cap is truncated with an artifact ref; `env` keys not on the allow-list are rejected, so a tool cannot synthesize credentials.

#### `shell_session` — `builtin.shell_session`
- **Purpose.** Persistent interactive shell with a PTY: open, write, read, resize, close — the substrate for REPL-ish work and long-running dev servers.
- **Input.** `action: 'open'|'write'|'read'|'resize'|'interrupt'|'close'`, `sessionId?: string`, `data?: string`, `cols?: number`, `rows?: number`, `sinceSeq?: number`, `waitMs?: number`.
- **Output.** `sessionId`, `alive: boolean`, `exitCode?: number`, `output: string` (for `read`), `seq: number`, `truncated`, `screenHint?: string`.
- **capability** `terminal.pty` · **eff** `process` · **RO** no · **perm** `ask` on `open`; subsequent `write` decisions are evaluated per command line by policy · **lease** kernel per action
- **Fails.** `SessionNotFound`; `SessionDead` (terminal state, reported as a result); `ReadTimeout` returns partial output with `seq` so the caller can continue (never duplicates bytes); a session killed by the kernel reports the residual confinement state explicitly; sessions are capped per session (default 4) and idle sessions are reaped with a receipt.

> **Implemented v0.1 (reduced form)** — `app/src/tools/interactive-exec.ts`, registered as `shell_session`; status/evidence in `28-implementation-status.md`. This is the additive, fail-closed, guard-authorized interactive terminal the model drives (codex `unified_exec` exec_command + write_stdin, convergent with oh-my-pi bash-interactive/bash-pty-selection). It is the EXPLICIT opt-in for interactivity; the one-shot `shell` tool and its interactive blocklist are left intact.
> - **Actions (reduced from the designed set).** `mode: 'start' | 'write' | 'close'` — `start` runs a command in a new session and returns a `Session: <id>` + buffered output; `write` feeds `input` to a running session's stdin and returns the newly buffered output; `close` kills the session. `resize`/`interrupt`/explicit `read` are not in this slice (a `write` with empty input polls buffered output).
> - **Admission (fail-closed).** Every `start` is authorized as a `shell.exec` effect — both the loop's `admissionFor`/`guardActionFor` (mapping `start`→`shell.exec`, `write`/`close`→session-state) and the tool's own `ctx.guard` / `ctx.approve` ("Run interactive command"). A `deny` refuses WITHOUT spawning; an `ask` routes through approval. **Every `write` is admitted again** (ruling 55): each non-blank input line is a `shell.exec` with the line as target, so the start approval never authorises later input; an ask shows `<session command> <- <input>`, a decline or deny writes nothing, and `always` is exact-input only. No new `GuardAction` kind — a PTY session is still `shell.exec`.
> - **Input rules for `write` (ruling 55).** Before any guard call: `\r\n`/`\r` are normalized to `\n` (admitted lines equal executed lines on PTY and pipe); C0 control characters and DEL other than tab/newline are refused; invisible or direction-changing Unicode (bidi, zero-width, U+2028/2029) is refused, as it is in the one-shot `shell` `command`; a write is capped at 64 lines and 64 KiB; each line at 4000 UTF-8 bytes. The approval prompt shows the line verbatim. What an approved interpreter does with admitted text is not inspected.
> - **PTY-vs-piped (capability-detected, env opt-out).** When util-linux `script` is on `PATH` and `HZ_NO_PTY` is unset, the command runs under `script -qec <cmd> /dev/null` so the child gets a real `/dev/pts` tty; otherwise the piped `bash -lc` fallback (the always-works headless path). `canUseInteractivePty` is pure/injectable. `HZ_NO_PTY=1` is the opt-out (analogous to oh-my-pi's `PI_NO_PTY`).
> - **Lifecycle.** Spawned through `spawnOwned` (foreground owned process, own process group, `stdin:"pipe"`, `scrubEnv()` + env-taming defaults); bounded registry (`MAX_SESSIONS=4`, over-the-cap `start` refused typed); idle + overall/wall timeouts (default 120000 ms, max 600000 ms); the SIGTERM-grace-then-SIGKILL ladder to the process group. Residual: a `setsid()` descendant can escape the group kill (NF-016 owns the OS-level fix) — not claimed bulletproof.
> - **Output format (matches codex `unified_exec`).** `Exit code: <n>` or `Signal: <sig>`, `Wall time: <s>s` (0.1 s rounding), `Total output lines: <n>` ONLY when the 30000-char buffer capped, then `Output:` + the minimised text (`minimiseShellOutput` imported from `shell.ts`; `shell.ts` is untouched). Over-budget buffers spill via `planToolOutputCap`/`writeSpillFile`.
> - **Concurrency.** `concurrencyClass: "exclusive"` (R-tools-39) — serial with `shell` and other sessions; honoured automatically by `concurrencyClassOf`.

#### `powershell` — `builtin.powershell`
- **Purpose.** The Windows-native command surface (`pwsh`/`powershell.exe`) with the same policy shape as `shell`.
- **Input.** `command: string`, `cwd?: string`, `timeoutMs?: number`, `mode?: 'fg'|'bg'`, `usePwsh?: boolean` (default true).
- **Output.** `exitCode`, `stdout`, `stderr`, `durationMs`, `shell: 'pwsh'|'powershell'`.
- **capability** `terminal.run` · **eff** `process` · **RO** no · **perm** policy-evaluated; PowerShell is not exempt from the same command rules as bash · **lease** kernel
- **Fails.** `UnsupportedPlatform` on non-Windows (declared, not emulated); `ExecutionPolicyBlocked`; execution policy / profile loading is disabled by default so a user profile cannot inject commands into an agent run; same non-zero-exit-is-a-result rule.

#### `job` — `builtin.job`
- **Purpose.** Manage background processes started by `shell mode: 'bg'` (or `container`): list, poll, stream logs, wait, signal, kill.
- **Input.** `action: 'list'|'status'|'logs'|'wait'|'signal'|'kill'`, `jobId?: string`, `signal?: 'TERM'|'INT'|'KILL'`, `sinceSeq?: number`, `waitMs?: number`, `maxBytes?: number`.
- **Output.** `jobs: Array<{jobId, commandRedacted, pid, state: 'running'|'exited'|'killed'|'unknown', exitCode?, startedAt}>`, `logs?: string`, `state?`.
- **capability** `process.spawn` · **eff** `process` · **RO** no (except `list`/`status`/`logs`, classified `read_with_side_effects`) · **perm** `allow` for observation of one's own jobs; `ask` for `signal`/`kill` of a job the session did not start (which is `deny` anyway because the job id is unforgeable) · **lease** kernel for `signal`/`kill`, none for observation
- **Fails.** `JobNotFound`; `AlreadyExited` (result, not error, with the retained exit code); logs are ring-buffered (default 1 MiB) and paginated by `seq`; a job whose process group was reaped by the OS reports `state: 'unknown'` and must be reconciled.

#### `repl` — `builtin.repl`
- **Purpose.** Stateful language REPL (Python/Node/Ruby/… as configured) for quick evaluation inside a governed session.
- **Input.** `action: 'start'|'eval'|'close'`, `language?: string`, `code?: string`, `sessionId?: string`, `timeoutMs?: number` (default 30000).
- **Output.** `sessionId`, `value?: unknown`, `stdout`, `stderr`, `compileOk: boolean`, `locals?: string[]`.
- **capability** `repl.eval` · **eff** `code.execute` — declared as `process` · **RO** no · **perm** `ask` on `start` and on every `eval` whose code path can perform I/O outside the sandbox · **lease** kernel per `eval`
- **Fails.** `NotInstalled`; `CompileError` (returned as structured diagnostics, not as a crash); `SandboxResidual` when the interpreter cannot be confined (the run reports the residual instead of pretending confinement); infinite loops are killed at `timeoutMs` with `timeout: true`.

#### `run_code` — `builtin.run_code`
- **Purpose.** Execute one self-contained script (stdin/args/file) in a sandbox, with declared language and declared resource limits — the typed alternative to shelling out a heredoc.
- **Input.** `language: 'python'|'node'|'bash'|'ruby'|'go'|'rust'`, `code: string` (≤ 256 KiB), `args?: string[]`, `files?: Record<path,string>` (sandbox inputs), `timeoutMs?: number`, `network?: boolean` (default false).
- **Output.** `exitCode`, `stdout`, `stderr`, `outputFiles: Record<path, artifactUri>`, `durationMs`, `residuals: string[]`.
- **capability** `code.execute` · **eff** `process` (plus `network` when `network: true`) · **RO** no · **perm** `ask` always — arbitrary code is the most expensive thing an agent can do · **lease** kernel
- **Fails.** `UnsupportedLanguage`; `SandboxUnavailable` (fail closed — no silent unconfined execution); `NetworkDenied` when `network: false` and the script attempts egress (detected and reported as a policy violation); `OutputTooLarge`.

#### `code_mode` — `builtin.code_mode`
- **Purpose.** Run confined JS/TS (QuickJS-class isolate) that calls HorizonCode tools through a typed, namespaced bridge — programmatic control flow over tools without giving the model a shell.
- **Input.** `code: string` (≤ 128 KiB), `tools: string[]` (ids the snippet may call; MUST be a subset of the visible set), `timeoutMs?: number` (default 30000), `outputMode?: 'text'|'json'`.
- **Output.** `result: unknown`, `toolCalls: Array<{toolId, ms, ok}>` (audit table), `stdout`, `durationMs`, `limitHits: string[]`.
- **capability** `codemode.execute` · **eff** `external-effect` — the *declared maximum*: the snippet may call any capability its tool subset contains · **RO** no · **perm** `ask` (the snippet's `tools` list is shown to the human, per call) · **lease** kernel, plus **one lease per tool call the snippet makes** (the snippet is not a lease amplifier, R-tools-32)
- **Fails.** `ToolNotInSubset` (compile-time rejection of the snippet); `IterationLimit`; `MemoryLimit`; the isolate has no filesystem, no network, and no `require`/`import` of arbitrary modules — a snippet that needs them must call a tool; a snippet failing mid-way reports the completed `toolCalls` audit table so partial effects are visible and reconcilable.

#### `container` — `builtin.container`
- **Purpose.** Run a command inside a container image (local OCI runtime or a configured remote) with volume/network policy.
- **Input.** `image: string`, `command: string`, `mounts?: Array<{host: string, container: string, readOnly?: boolean}>`, `env?: Record<string,string>`, `network?: 'none'|'bridge'|'host'` (default `none`), `timeoutMs?: number`, `pull?: 'never'|'missing'|'always'` (default `never`).
- **Output.** `containerId?`, `exitCode`, `stdout`, `stderr`, `imageDigest`, `mountsApplied`, `residuals: string[]`.
- **capability** `process.spawn` (aux `net.fetch` when `pull != 'never'`) · **eff** `process` (plus `network` when pulling or `network: bridge|host`) · **RO** no · **perm** `deny` by default: containers require an explicit user enablement and then `ask` per image digest · **lease** kernel
- **Fails.** `ImageNotFound` (with `pull: 'never'`, nothing is fetched implicitly); `DigestMismatch` (a tag whose digest differs from the pinned one refuses to run); `MountOutsideGrant` (a host path outside the lease scope is denied, R-tools-56); `RuntimeUnavailable`.

#### `ssh` — `builtin.ssh`
- **Purpose.** Execute a command on a remote host over SSH (or via WSL) with the same policy and receipt treatment as a local command.
- **Input.** `host: string` (must match a configured `remote://<host>` entry), `command: string`, `cwd?: string`, `timeoutMs?: number`, `tty?: boolean` (default false), `forwardPath?: {from: string, to: string}`.
- **Output.** `exitCode`, `stdout`, `stderr`, `hostFingerprint`, `durationMs`, `bytesIn`/`bytesOut`.
- **capability** `remote.exec` (aux `files.read`/`files.patch` when `forwardPath` is used) · **eff** `remote` · **RO** no · **perm** `deny` until the host is configured by the user; then `ask` per command policy for that host · **lease** kernel, scoped to `remote://<host>`
- **Fails.** `HostNotConfigured`; `HostKeyMismatch` (terminal — never auto-accepted); `AuthFailed` (no interactive password prompt from a tool: keys/agent only); `RemoteCommandDenied`; a dropped connection after the command started settles `UNKNOWN` and is reconciled.

### 4.4 Web & media

#### `web_fetch` — `builtin.web_fetch`
- **Purpose.** Fetch one URL and return it as readable text/markdown (HTML stripped, articles extracted), with the raw bytes kept as an artifact.
- **Input.** `url: string`, `format?: 'markdown'|'text'|'html'|'json'` (default `markdown`), `maxBytes?: number` (default 2 MiB), `timeoutMs?: number` (default 30000), `headers?: Record<string,string>` (allow-listed names only), `followRedirects?: boolean` (default true, ≤ 5 hops).
- **Output.** `url`, `finalUrl`, `status: number`, `contentType`, `content: string`, `bytes`, `sha256`, `artifactUri`, `truncated`.
- **capability** `net.fetch` · **eff** `network` · **RO** yes (no host effect) · **perm** `ask` on first host per session when egress policy is on-request; `allow` for hosts on the egress allow-list · **lease** kernel, scoped `net://<host>`
- **Fails.** `EgressDenied` (R-49: terminal, never retried — it is an attempt to route around policy); `Http4xx`/`Http5xx`; `Timeout`; `TlsError`; `TooManyRedirects`; redirects that leave the granted `net://` scope fail closed; `AuthRequired` pages return the status, never a login attempt.

#### `web_search` — `builtin.web_search`
- **Purpose.** Query a search backend for ranked results (title, URL, snippet) with an optional fetched summary.
- **Input.** `query: string`, `count?: number` (default 8, hard 20), `recency?: 'day'|'week'|'month'|'year'|'any'`, `domains?: string[]`, `fetchTop?: number` (default 0).
- **Output.** `results: Array<{title, url, snippet, publishedAt?}>`, `backend`, `queriesUsed: number`, `fetched: Array<{url, sha256}>`.
- **capability** `net.search` · **eff** `network` · **RO** yes · **perm** `allow` when a search backend is configured, else `deny` (no scraping fallback); counts against the run's web-search budget · **lease** kernel
- **Fails.** `BudgetExhausted` (the web-search budget, distinct from the token budget); `BackendUnavailable`; `NoResults` is a successful empty result; a result URL is data, not authority — fetching it still requires the `web_fetch` decision.

#### `web_image` — `builtin.web_image`
- **Purpose.** Fetch an image by URL and return it as an `AttachmentV1` (for vision models) rather than as bytes.
- **Input.** `url: string`, `maxBytes?: number` (default 5 MiB), `maxDimension?: number` (default 2048), `format?: 'original'|'png'|'jpeg'`.
- **Output.** `attachmentId`, `width`, `height`, `mediaType`, `bytes`, `sha256`, `artifactUri`.
- **capability** `net.fetch` · **eff** `network` · **RO** yes · **perm** `ask` on first host per session (same egress rule as `web_fetch`) · **lease** kernel
- **Fails.** `NotAnImage` (sniffing, not the `Content-Type` header); `TooLarge`; `UnsupportedFormat`; resizing failures are explicit rather than "sent anyway"; the pixels count against the run's media budget, so an oversized image is downscaled or refused, never silently inlined.

#### `browse` — `builtin.browse`
- **Purpose.** Drive a real browser session (navigate, click, type, screenshot, read the accessibility tree) for pages that require script execution.
- **Input.** `action: 'open'|'click'|'type'|'scroll'|'screenshot'|'snapshot'|'eval_disabled'|'close'`, `url?: string`, `selector?: string`, `text?: string`, `sessionId?: string`, `timeoutMs?: number`.
- **Output.** `sessionId`, `url`, `title`, `a11ySnapshot?: string`, `screenshotUri?`, `consoleErrors: string[]`, `networkRequests: Array<{url, status}>`.
- **capability** `net.fetch` · **eff** `external-effect` (a click can submit a form, post a comment, buy something — the declared maximum, per R-tools-3) · **RO** no · **perm** `ask` always; the decision names the exact action and the target origin · **lease** kernel, scoped `net://<origin>` plus a browser-session lease
- **Fails.** `NoBrowserRuntime`; `NavigationDenied` (origin outside the granted scope); `SelectorNotFound`; the browser runs out-of-process with its own sandbox and a per-session profile that carries no user credentials — `browse` MUST NOT use the user's logged-in profile; console/network capture is bounded by the same output caps as `shell`.

#### `computer` — `builtin.computer`
- **Purpose.** Control the local desktop (screen capture, mouse, keyboard) for GUI-only tasks.
- **Input.** `action: 'screenshot'|'click'|'move'|'type'|'key'|'scroll'|'drag'`, `x?: number`, `y?: number`, `button?: 'left'|'right'|'middle'`, `text?: string`, `keys?: string[]`, `region?: [number,number,number,number]`.
- **Output.** `screenshotUri?`, `screenSize`, `cursor: [number, number]`, `applied: boolean`, `activeWindow?: string`.
- **capability** `process.spawn` · **eff** `external-effect` · **RO** no · **perm** `deny` by default; requires an explicit enablement by the user and then `ask` per action batch (never unattended) · **lease** kernel, scoped `display://primary`
- **Fails.** `CapturePermissionMissing`; `InputInjectionUnsupported`; the tool is a **stream of human-visible actions**, so each batch is logged with a receipt and a screenshot preimage; multi-monitor/HiDPI coordinate ambiguity is reported instead of guessed; it MUST NOT type into password fields (detected by heuristics and refused).

#### `view_image` — `builtin.view_image`
- **Purpose.** Present an existing local image or attachment to a vision-capable model, with optional crop/scale.
- **Input.** `path?: string`, `attachmentId?: string`, `crop?: [number,number,number,number]`, `maxDimension?: number` (default 1536), `detail?: 'low'|'high'`.
- **Output.** `attachmentId`, `width`, `height`, `bytes`, `sha256`, `downscaledTo?: [number, number]`.
- **capability** `files.read` (path) · **eff** `read-only` · **RO** yes · **perm** `allow` inside the workspace; `ask` outside · **lease** none
- **Fails.** `NotAnImage`; `TooLarge` (refused above the media budget instead of being sent anyway); `ModelNotVisionCapable` (the call fails with that category rather than silently dropping the pixels); animated formats are reduced to the first frame, explicitly flagged.

#### `read_video` — `builtin.read_video`
- **Purpose.** Extract a bounded set of frames (and optionally the audio track) from a local video for visual inspection.
- **Input.** `path: string`, `maxFrames?: number` (default 8, hard 32), `timestamps?: number[]` (seconds), `maxDimension?: number`, `extractAudio?: boolean` (default false).
- **Output.** `frames: Array<{t: number, attachmentId, sha256}>`, `durationSec`, `codec`, `audioAttachmentId?`, `framesOmitted: number`.
- **capability** `files.read` (aux `process.spawn` for the demuxer) · **eff** `read-only` · **RO** yes · **perm** `allow` inside the workspace · **lease** none
- **Fails.** `UnsupportedCodec`; `NoVideoStream`; `TooLarge` above the input cap; frames are sampled at a declared cadence and the omitted count is reported, so the model never believes it saw the whole video.

#### `generate_image` — `builtin.generate_image`
- **Purpose.** Generate or edit an image from a prompt through a configured image model; the result is an artifact, never inline bytes.
- **Input.** `prompt: string`, `size?: string` (e.g. `1024x1024`), `count?: number` (1..4), `referenceImage?: string` (attachment id, for edit/variation modes), `format?: 'png'|'jpeg'|'webp'`.
- **Output.** `images: Array<{attachmentId, artifactUri, sha256, width, height}>`, `model`, `cost` (as reported by the provider), `revisedPrompt?`.
- **capability** `providers.infer` with aux `artifact.write` · **eff** `network` · **RO** yes (no host mutation; it writes only to the artifact store) · **perm** `ask` (image generation spends real money) and `deny` in air-gapped mode · **lease** kernel
- **Fails.** `ModelUnavailable`; `ContentPolicyRefusal` (reported verbatim as a category, never paraphrased into success); `BudgetExhausted`; provider-side partial batches are reported per image.

#### `tts` — `builtin.tts`
- **Purpose.** Synthesize speech from text (streaming) for hands-free operation and for reading long results aloud.
- **Input.** `text: string` (≤ 8 KiB), `voice?: string`, `format?: 'mp3'|'opus'|'wav'`, `speed?: number` (0.5..2.0), `backend?: 'auto'|'local'|'hosted'`.
- **Output.** `audioUri` (`hz://artifact/<sha256>`), `mediaType`, `durationSec`, `bytes`, `backend`, `truncated`.
- **capability** `providers.infer` (hosted) / in-process `hz_voice` (local) · **eff** `network` (the declared maximum; R-tools-3 forbids declaring the lighter local path) · **RO** yes · **perm** `allow` for agent-initiated speech at low priority; `ask` when the text is derived from a file the session may not echo (redaction profile applies) · **lease** kernel for the hosted backend, none for the local one
- **Fails.** `VoiceNotFound`; `TextTooLong` (chunked with explicit seams instead of truncating mid-word); `BackendUnavailable`; the audio never contains unredacted secret values — the redaction pass runs before synthesis, not after.

#### `stt` — `builtin.stt`
- **Purpose.** Transcribe an audio file or a live microphone stream into text (with optional timestamps and diarization).
- **Input.** `source: 'attachment'|'microphone'|'path'`, `path?: string`, `attachmentId?: string`, `language?: string`, `timestamps?: boolean` (default false), `maxDurationSec?: number` (default 300).
- **Output.** `text: string`, `segments?: Array<{start, end, text, speaker?}>`, `language`, `durationSec`, `confidence?`.
- **capability** `providers.infer` (hosted) / in-process `hz_voice` (local) · **eff** `network` · **RO** yes · **perm** `ask` for microphone capture every time (no standing grant to listen) · **lease** kernel for the hosted backend, none for the local one
- **Fails.** `DeviceUnavailable`; `PermissionDenied`; `AudioTooLong`; `NoSpeechDetected` is a successful empty result; a microphone capture holds an explicit recording indicator for its whole duration and stops on session cancel.

#### `chart` — `builtin.chart`
- **Purpose.** Render data (from a JSON payload, a file, or a command's output) into a chart artifact — out-of-process Mermaid/vega-class rendering, no markdown into the model's mouth.
- **Input.** `kind: 'line'|'bar'|'scatter'|'pie'|'sequence'|'gantt'|'mermaid'`, `data: unknown` or `dataPath?: string`, `spec?: string` (raw Mermaid for `kind: 'mermaid'`), `title?: string`, `size?: {w, h}`, `format?: 'svg'|'png'`.
- **Output.** `artifactUri`, `mediaType`, `bytes`, `sha256`, `renderer`, `warnings: string[]`.
- **capability** `artifact.write` (aux `process.spawn` for the renderer sandbox) · **eff** `process` · **RO** yes (writes only to the artifact store) · **perm** `allow` · **lease** kernel
- **Fails.** `InvalidData`; `SpecParseError` (with the failing line); the renderer runs in a sandbox with no filesystem and no network (Mermaid is an XSS-shaped language); rendering timeouts produce an error with the source retained as an artifact for the user to inspect.

### 4.5 Memory & context

#### `memory_recall` — `builtin.memory_recall`
- **Purpose.** Retrieve from memory — working state, episodic past sessions, semantic facts, team memory — with provenance.
- **Input.** `query: string`, `tiers?: Array<'working'|'episodic'|'semantic'|'team'>` (default `['working','semantic']`), `k?: number` (default 8, hard 32), `sessionScope?: 'this'|'tree'|'all'`, `since?: string`.
- **Output.** `records: Array<{id, tier, text, score, provenance: {sessionId?, receiptId?, artifactUri?, createdAt}, confidence}>`, `degraded?`.
- **capability** `memory.read` · **eff** `read-only` · **RO** yes · **perm** `allow` for semantic/working; `ask` for `sessionScope: 'all'` across unrelated sessions (episodic recall of other work is a privacy decision, not a default) · **lease** none
- **Fails.** `NoIndex`; `EmbeddingUnavailable` ⇒ lexical-only with `degraded: 'lexical-only'`; records from other sessions are returned **only** with provenance attached — a recall that cannot name where a fact came from is not returned.

#### `memory_retain` — `builtin.memory_retain`
- **Purpose.** Write a fact to memory with provenance, deduplicating against existing records.
- **Input.** `text: string` (≤ 4 KiB), `tier: 'working'|'semantic'|'team'` (default `semantic`), `tags?: string[]`, `provenance: {sessionId, stepId, receiptIds?: string[]}`, `ttlDays?: number`.
- **Output.** `recordId`, `deduped: boolean`, `mergedInto?: string`, `tier`, `createdAt`.
- **capability** `memory.write` · **eff** `workspace-write` (writes to the memory store under `.hz/`) · **RO** no · **perm** `ask` for `tier: 'team'` (shared memory is visible to others) and for any write that is not backed by a receipt from this run; otherwise `allow` · **lease** kernel, scoped `memory://<tier>`
- **Fails.** `ProvenanceMissing` (a fact with no provenance is refused — that is the whole point of the tier system); `RedactionHit` (a value matching a secret pattern is stored redacted with an explicit marker, never verbatim); `QuotaExceeded` for the tier.

#### `memory_edit` — `builtin.memory_edit`
- **Purpose.** Correct, merge, tag or delete an existing memory record (the maintenance arm of the memory tier system).
- **Input.** `recordId: string`, `action: 'update'|'merge'|'tag'|'delete'|'lower-confidence'`, `text?: string`, `tags?: string[]`, `mergeInto?: string`, `reason: string`.
- **Output.** `recordId`, `action`, `previousText?`, `newText?`, `auditId`.
- **capability** `memory.write` · **eff** `workspace-write` · **RO** no · **perm** `ask` (memory edits change what future runs believe; they are never silent) · **lease** kernel
- **Fails.** `RecordNotFound`; `ImmutableRecord` (records written by a `UserAction` origin require human confirmation to change); every edit writes an audit fact, and the previous text is preserved in it — memory correction must be reversible.

#### `memory_reflect` — `builtin.memory_reflect`
- **Purpose.** Run a reflection pass over recent trajectory: extract candidate facts, detect contradictions, propose consolidation (proposals only, per README §3.9).
- **Input.** `scope: 'session'|'tree'|'project'`, `maxCandidates?: number` (default 20), `focus?: string`, `apply?: false` (only `false` is accepted in v1).
- **Output.** `candidates: Array<{text, tier, evidence: string[], confidence, contradicting?: string[]}>`, `contradictions: number`, `proposals: string[]`, `tokensUsed`.
- **capability** `memory.write` with aux `providers.infer` · **eff** `workspace-write` · **RO** no · **perm** `ask` (reflection spends model tokens and writes proposals) · **lease** kernel
- **Fails.** `NoTrajectory`; `BudgetExhausted`; `apply: true` is rejected by validation with `NotSupported` — reflection may never widen authority or silently rewrite memory (README §3.9 hard rule).

#### `context_notes` — `builtin.context_notes`
- **Purpose.** Maintain the run's scratchpad notes that the context compiler projects into the turn tail (not into the byte-stable prefix).
- **Input.** `action: 'add'|'update'|'remove'|'list'`, `noteId?: string`, `text?: string` (≤ 2 KiB per note), `pinned?: boolean`, `tags?: string[]`.
- **Output.** `notes: Array<{noteId, text, pinned, tags, tokens}>`, `totalTokens`, `evicted: string[]`.
- **capability** `context.manage` · **eff** `read-only` at the host (session state only) · **RO** yes · **perm** `allow` · **lease** session
- **Fails.** `NoteBudgetExceeded` (eviction is explicit and reported in `evicted[]`, never silent); notes are *never* counted as evidence for verification; a note that duplicates the plan/todo stores is rejected with a pointer to them.

#### `new_context` — `builtin.new_context`
- **Purpose.** Start a fresh context window (or fork the session) while keeping the durable event log — the deliberate reset, as opposed to automatic compaction.
- **Input.** `mode: 'reset'|'fork'|'fork-from-turn'`, `keepNotes?: boolean` (default true), `keepPlan?: boolean` (default true), `atTurn?: number`, `reason: string`.
- **Output.** `sessionId`, `parentSessionId?`, `contextVersion`, `carried: {notes, plan, goal, memoryRecords}`, `dropped: {messages: number, tokens}`.
- **capability** `context.manage` with aux `session.manage` · **eff** `workspace-write` (session state) · **RO** no · **perm** `ask` (dropping conversation history is user-visible) · **lease** kernel
- **Fails.** `InvalidTurn`; `NothingToCarry`; the durable log is never truncated by this tool — only the *projection* changes; a fork that fails to create its record leaves the parent untouched.

#### `compress` — `builtin.compress`
- **Purpose.** Compact the current context under one of the strategies (summary, structured digest, verbatim tail, snapcompact) — the explicit form of the automatic trigger.
- **Input.** `strategy: 'summary'|'digest'|'verbatim_tail'|'snapcompact'`, `targetTokens?: number`, `keepTurns?: number` (default 4), `focus?: string`, `dryRun?: boolean` (default false).
- **Output.** `before: {messages, tokens}`, `after: {messages, tokens}`, `strategy`, `summaryUri?`, `preserved: {turns, receipts, plan, goal}`, `lossy: boolean`.
- **capability** `context.manage` · **eff** `read-only` at the host, `network` when the strategy uses a model (summary/digest) · **RO** no · **perm** `ask` (compaction is irreversible for the projected view) · **lease** kernel for model-using strategies
- **Fails.** `NothingToCompress`; `TargetUnreachable` (reports what it could get to); receipts, plan, goal and todo state MUST survive compaction (asserted by test, §11); `snapcompact` without a vision-capable model fails explicitly rather than falling back to a text summary.

#### `history_search` — `builtin.history_search`
- **Purpose.** Search the raw event log / transcripts (this session or the tree) by text, tool, or receipt — audit and archaeology rather than memory.
- **Input.** `query: string`, `scope?: 'session'|'tree'|'all'`, `kinds?: Array<'message'|'tool'|'receipt'|'error'|'all'>`, `from?: string`, `to?: string`, `limit?: number` (default 50).
- **Output.** `hits: Array<{eventId, sessionId, at, kind, excerpt, receiptId?}>`, `count`, `truncated`.
- **capability** `memory.read` (aux `session.manage` for cross-session scope) · **eff** `read-only` · **RO** yes · **perm** `allow` for this session; `ask` for other sessions (same privacy rule as `memory_recall`) · **lease** none
- **Fails.** `NoHits` is a success; cross-session hits are filtered by the same visibility rules as the session picker; results are paginated by `offset` and the log is never rewritten by a search.

#### `learn` — `builtin.learn`
- **Purpose.** Run the self-improvement loop over a trajectory: record it, evaluate it, distill memory, and — optionally — propose a skill (`skillify`). Proposals only.
- **Input.** `action: 'record'|'evaluate'|'distill'|'skillify'|'propose'`, `sessionId?: string`, `evalCaseId?: string`, `target?: 'memory'|'skill'|'prompt'|'routing'`, `apply?: false` (only `false` in v1).
- **Output.** `trajectoryId?`, `evalResult?: {score, suite, regressions: string[]}`, `proposalId?`, `evidence: {receiptIds: string[], artifactUris: string[]}`.
- **capability** `memory.write` with aux `providers.infer` · **eff** `workspace-write` · **RO** no · **perm** `ask` always (learning spends budget and produces proposals that humans must review) · **lease** kernel
- **Fails.** `NoTrajectory`; `EvalRegression` is a *failure of the proposal*, reported with the failing cases; `apply: true` is rejected with `NotSupported`; a proposal that would widen authority is rejected by the kernel at proposal-creation time, not at apply time.

#### `skill_manage` — `builtin.skill_manage`
- **Purpose.** List, read, install, update, lock and remove skills (`hz://skill/<name>`), including invoking a skill's workflow.
- **Input.** `action: 'list'|'read'|'install'|'update'|'lock'|'remove'|'invoke'`, `name?: string`, `source?: string` (registry, path, URL), `version?: string`, `args?: Record<string, unknown>`.
- **Output.** `skills: Array<{name, version, source, locked, digest, runAs?}>`, `content?`, `installResult?: {digest, signature, trust: 'verified'|'unverified'}`, `invocation?: {sessionId}`.
- **capability** `plugins.invoke` (aux `net.fetch` for registry installs) · **eff** `workspace-write` · **RO** no · **perm** `ask` for `install`/`update`/`remove` (changing what the agent can be instructed to do); `allow` for `list`/`read`/`invoke` of an already-installed skill · **lease** kernel
- **Fails.** `SkillNotFound`; `SignatureInvalid` (an unverified skill may still be installed but is marked `unverified`, run with a reduced tool set and a visible banner — never silently trusted); `VersionConflict`; `SkillRequiresCapability` when the skill's declared tools exceed the session's grant.

#### `todo` — `builtin.todo`
- **Purpose.** Maintain the run's todo list (the visible working plan) — add, update status, reorder, clear.
- **Input.** `action: 'add'|'update'|'remove'|'list'|'clear'`, `id?: string`, `text?: string`, `status?: 'pending'|'in_progress'|'completed'|'blocked'`, `order?: number`, `note?: string`.
- **Output.** `todos: Array<{id, text, status, order, updatedAt}>`, `counts: {pending, in_progress, completed, blocked}`, `changed: string[]`.
- **capability** `session.manage` · **eff** `read-only` at the host (session state; emits `hz.todo.updated`) · **RO** yes · **perm** `allow` · **lease** session
- **Fails.** `TodoNotFound`; `DuplicateText` warning; at most one `in_progress` item is **advisory, not enforced** — the tool reports the conflict rather than silently rewriting the user's plan; the todo list is not evidence (completion is claimed through `complete_step` with evidence, `verify` decides).

#### `complete_step` — `builtin.complete_step`
- **Purpose.** Mark a plan step complete *with evidence* (receipts, test output, diff) — the claim that the verification gate later checks.
- **Input.** `stepId: string`, `summary: string` (≤ 1 KiB), `evidence: Array<{kind: 'receipt'|'artifact'|'test'|'diff'|'coverage'|'screenshot', ref: string}>`, `claims?: string[]`.
- **Output.** `stepId`, `state: 'completed'|'rejected'`, `acceptedEvidence: number`, `rejectedEvidence: Array<{ref, reason}>`, `claimable: boolean`.
- **capability** `session.manage` · **eff** `read-only` at the host (session state; emits `hz.plan.updated` on the plan projection — the step itself already ended with `hz.step.llm.completed`/`hz.step.tool.completed`; `hz.step.completed` and `hz.plan.step.completed` are **not** canonical events, `_conventions.md` §6) · **RO** yes · **perm** `allow` · **lease** session
- **Fails.** `StepNotFound`; `EvidenceInvalid` (a claim with no receipt from this run is rejected and *the step stays open*); a claim stronger than its evidence is lowered by the verification gate and MUST NOT be silently accepted at completion time.

#### `update_goal` — `builtin.update_goal`
- **Purpose.** Set or refine the run's goal state (objective, acceptance criteria, constraints) and the approved-plan window that gates execution.
- **Input.** `action: 'set'|'refine'|'clear'`, `objective?: string`, `acceptance?: string[]`, `constraints?: string[]`, `planApproved?: boolean` (only settable by a `UserAction` origin), `reason?: string`.
- **Output.** `goal: {objective, acceptance, constraints, updatedAt}`, `planWindow: {approved, scope, expiresAt}`, `changed: string[]`.
- **capability** `session.manage` · **eff** `read-only` at the host · **RO** yes · **perm** `allow` for `refine`; `ask` for `set` with new constraints; `planApproved` from a model origin is **rejected by the kernel** (it is a human decision) · **lease** session
- **Fails.** `GoalImmutable` while a managed run holds the session; a model-origin attempt to set `planApproved` is recorded as an attempted authority escalation and denied (R-tools-38).

### 4.6 Agent & orchestration

> Reconciled 2026-11-07 (reaudit stage 2, RC-15). **This section owns the semantics** of subagent fan-out and dependency execution, and the two forms are disjoint: **`fleet` is a fan-out of identical workers** from one prompt template (per-item variables, a concurrency ceiling, results joined by index, **no** dependency edges), while **`parallel_tasks` is a DAG of distinct task specs** (`dependsOn` edges, `failFast`, `adoptRef`). `05-domain-and-schemas.md`, `06-events-and-flows.md` and `08-runtime.md` consume this definition; none of them may invert it. Both tools are one primitive (`tools.boundary.child_construction`); only the scheduler differs. Subagent depth and concurrency **ceilings** are not set here - `08-runtime.md` R-runtime-67/68 owns them and §10.3 cites them.

#### `task` — `builtin.task`
- **Purpose.** Spawn one subagent with a prompt, an agent profile, a **capability grant** and a context capsule; return its final report plus the receipt ids it produced.
- **Input.** `prompt: string` (≤ 32 KiB), `profile?: string` (default `general`), `grant: {capabilities: string[], scope: string[], maxSteps?: number, maxTokens?: number, wallClockMs?: number}`, `capsule?: {files?: string[], memoryTiers?: string[], notes?: string}`, `model?: string`, `background?: boolean` (default false).
- **Output.** `agentId`, `status: 'completed'|'failed'|'timeout'|'cancelled'`, `report: string`, `receiptIds: string[]`, `usage: {steps, tokens, cost, wallClockMs}`, `artifacts: string[]`, `sessionId` (child session).
- **capability** `agent.spawn` · **eff** `external-effect` — the declared maximum, because the child may exercise any capability inside its grant · **RO** no · **perm** `ask` when the grant exceeds the session's read-only set; `allow` for a grant that is a strict subset of the parent's read-only capabilities · **lease** kernel for the spawn, plus **per-call leases inside the child** (a child never inherits the parent's leases, R-tools-32)
- **Fails.** `GrantExceedsParent` (denied at construction — this is the boundary tested by the child-construction primitive); `DepthExceeded` (`08-runtime.md` R-runtime-67: depth 3 default, 5 hard); `ConcurrencyExceeded` (`08-runtime.md` R-runtime-68: 4 live children per session, 8 for read-only children, 12 per root run); `BudgetExhausted`; a child that dies mid-effect leaves `UNKNOWN` receipts that the *parent* must reconcile.

#### `fleet` — `builtin.fleet`
- **Purpose.** Spawn N **identical** workers from one prompt template, each with its own per-item variables, under a concurrency ceiling — the fan-out form of `task`. There are **no dependency edges**: every worker starts as soon as the ceiling allows and the results are joined by index.
- **Input.** `template: string` with per-item `items: Array<Record<string, string>>` (≤ 64) — or the equivalent `specs: Array<{id: string, prompt: string, profile?: string, grant?: object, capsule?: object}>` grown from the same template — `concurrency?: number` (default 4, hard 16, and never above 08's global ceiling), `strategy?: 'all'|'collect-first'|'quorum'`, `quorum?: number`. A `specs[]` entry MUST NOT carry `dependsOn`: a dependency graph is `parallel_tasks`, not `fleet`.
- **Output.** `fleetId`, `results: Array<{id, agentId, status, report, receiptIds, usage}>`, `partial: boolean`, `cancelled: string[]`.
- **capability** `agent.spawn` · **eff** `external-effect` · **RO** no · **perm** `ask` (fan-out multiplies cost and blast radius; the decision shows the agent count and the union grant) · **lease** kernel per child
- **Fails.** `DuplicateSpecId`; `GrantMismatch` (heterogeneous grants are summed, and the union is what the human approves — a mismatch between the presented union and the actual per-child grants is a bug the gate must catch); `ConcurrencyExceeded`; a partially completed fleet is reported as `partial: true` with per-child status — it is never summarised as success.

#### `parallel_tasks` — `builtin.parallel_tasks`
- **Purpose.** Run a **dependency graph (DAG) of distinct task specs**, so a dependent child starts only after every predecessor reached `completed` and its report exists — the ordered form, as opposed to `fleet`'s unordered fan-out.
- **Input.** `tasks: Array<{id, prompt, profile?, grant?, capsule?, dependsOn?: string[]}>` (≤ 32), `maxConcurrency?: number` (default 4), `failFast?: boolean` (default false — the first node failure cancels every node not yet terminal), `adoptRef?: boolean` (default true — a predecessor's output artifact may be injected into a dependent's capsule by `hz://artifact/<sha256>`, never as transcript text).
- **Output.** `graphId`, `order: string[]`, `results: Record<id, {agentId, status, report, receiptIds}>`, `blocked: string[]`, `cycle: string[]|null`.
- **capability** `agent.spawn` · **eff** `external-effect` · **RO** no · **perm** `ask` (same as `fleet`, plus the DAG is shown) · **lease** kernel per child
- **Fails.** `CycleDetected` (rejected before any child spawns, with the cycle path); `UnknownDependency`; `BlockedByFailure` (dependents are `blocked`, not silently skipped-and-marked-done); wall-clock budgets are inherited from the root run, so a DAG cannot outlive its parent.

#### `read_only_task` — `builtin.read_only_task`
- **Purpose.** Spawn a subagent whose grant is structurally restricted to read-only capabilities — used by the planner and by research passes.
- **Input.** `prompt: string`, `profile?: string` (default `research`), `capsule?`, `maxSteps?: number`.
- **Output.** `agentId`, `status`, `report`, `evidence: string[]` (file paths + sha256 read), `usage`.
- **capability** `agent.spawn` · **eff** `read-only` · **RO** yes · **perm** `allow` under all postures, including read-only posture (that is its purpose) · **lease** none (no mutating capability may be granted; the kernel rejects a grant that contains one)
- **Fails.** `GrantNotReadOnly` (construction rejected); `NoEvidence` (a report with no evidence refs is returned but flagged `unsupported: true`, and the parent MUST NOT treat it as verified); the child can still *propose* changes — as text — but cannot apply them.

#### `team_create` — `builtin.team_create`
- **Purpose.** Create a named, persistent team of agents with roles, shared team memory scope and a communication policy.
- **Input.** `name: string`, `members: Array<{role: string, profile: string, grant: object}>` (≤ 16), `sharedMemory?: 'none'|'team'|'read-only'`, `coordinator?: 'lead'|'round-robin'|'none'`.
- **Output.** `teamId`, `members: Array<{agentId, role, state}>`, `membershipSha256`, `sharedMemoryScope`.
- **capability** `agent.spawn` · **eff** `external-effect` (team state is written and children are spawned) · **RO** no · **perm** `ask` (a standing team outlives the step) · **lease** kernel
- **Fails.** `TeamExists`; `InvalidRoles`; `SharedMemoryDenied` (team memory requires an explicit grant; the default is `none`); a team that cannot be fully constructed is rolled back rather than left half-formed.

#### `team_delete` — `builtin.team_delete`
- **Purpose.** Disband a team: terminate live members, flush team memory, remove the team record.
- **Input.** `teamId: string`, `flushMemory?: 'discard'|'retain'|'export'` (default `retain`), `force?: boolean` (default false).
- **Output.** `teamId`, `terminated: string[]`, `memoryDisposition: string`, `exportUri?`.
- **capability** `agent.spawn` · **eff** `external-effect` · **RO** no · **perm** `ask` always (it kills running work) · **lease** kernel
- **Fails.** `TeamNotFound`; `MembersBusy` (without `force`, refuses while a member is in a mutating step, so it cannot be used to abort a child mid-write); termination of a child that was mid-effect leaves `UNKNOWN` receipts to reconcile.

#### `send_message` — `builtin.send_message`
- **Purpose.** Deliver an asynchronous message to a live subagent or team member (steering a running child), or to a teammate session.
- **Input.** `to: string` (agentId or role), `text: string` (≤ 4 KiB), `kind?: 'steer'|'queue'|'note'` (default `queue`), `priority?: number`.
- **Output.** `messageId`, `delivered: boolean`, `queuedAtPosition?`, `agentState`.
- **capability** `agent.spawn` · **eff** `read-only` at the host (writes to session/team state only) · **RO** yes · **perm** `allow` for one's own descendants; `deny` for arbitrary sessions (no cross-session chat) · **lease** session
- **Fails.** `AgentNotFound`; `AgentTerminated` (reported, not silently dropped); `steer` is only honoured between steps — a `steer` that arrives during a tool call is `queued` with an explicit note, because interrupting mid-effect is what cancellation is for.

#### `wait` — `builtin.wait`
- **Purpose.** Block the current step until a declared condition holds — a subagent finishes, a job exits, a file changes, a lease expires — or the timeout trips.
- **Input.** `on: 'agent'|'job'|'file'|'time'|'any', id?: string, timeoutMs?: number` (default 60000, hard 3600000), `pollMs?: number` (default 250), `untilCondition?: string` (a restricted predicate: `exists(path)`, `contains(path, text)`, `exitCode(id) == n`).
- **Output.** `condition`, `satisfied: boolean`, `at`, `observed: unknown`, `waitedMs`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `Timeout` returns `satisfied: false` as a *result* (waiting out a timeout is a legitimate outcome); `PredicateRejected` for anything outside the restricted grammar — `wait` MUST NOT become a general expression evaluator; the wait loop yields to the scheduler so it never starves other steps.

#### `yield` — `builtin.yield`
- **Purpose.** Voluntarily return control to the Controller mid-run — end the current turn cleanly while leaving the session resumable (the hook for long-running background work).
- **Input.** `reason: string`, `nextSteps?: string[]`, `resumeHint?: {condition: 'agent'|'job'|'time', id?: string, afterMs?: number}`.
- **Output.** `yielded: true`, `sessionState: 'idle'|'waiting'`, `resumeHint`, `pendingWork: Array<{kind, id, state}>`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** session
- **Fails.** `PendingClaimHeld` (a yield with an open execution claim is refused until the claim is released, per the write-ahead claim rules of `12-sessions-state.md`); a yield with no resume hint leaves the session `idle`, not silently “still running”.

#### `plan_enter` — `builtin.plan_enter`
- **Purpose.** Switch the session into plan mode: read-only execution, plan artifacts instead of edits, no mutating tool may be called.
- **Input.** `goal?: string`, `scope?: string[]` (paths to consider), `maxSteps?: number`, `allowResearch?: boolean` (default true).
- **Output.** `mode: 'plan'`, `posture: 'read-only'`, `toolsAvailable: string[]`, `blockedTools: string[]`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** session
- **Fails.** `AlreadyPlanning`; the mode change is enforced by the kernel (posture `read-only`), not by prompt text — a mutating call in plan mode is denied by the Guard with `posture.denied`, and the denial is visible to the model.

#### `plan_exit` — `builtin.plan_exit`
- **Purpose.** Leave plan mode and, if a plan was approved, open the approved-plan execution window.
- **Input.** `planId?: string`, `approvedBy?: 'user'` (only a `UserAction` origin may supply this), `scope?: string[]`, `expiresInMs?: number`.
- **Output.** `mode: 'exec'`, `window: {approved, scope, expiresAt}` or `window: null` (when the plan was rejected or not yet approved), `plan: PlanV1`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` to leave plan mode; **the approval itself is not a tool decision** — `approvedBy` from a model origin is rejected (R-tools-38) and the window stays closed · **lease** session
- **Fails.** `NoPlan`; `NotApproved` (exiting without a human-approved plan leaves the session in `ask` posture with no execution window — the model cannot approve its own plan); a window that expires mid-run closes without terminating in-flight calls but blocks new mutating ones.

#### `brief` — `builtin.brief`
- **Purpose.** Generate a bounded briefing (≤ N tokens) from session state, receipts, diffs and plans — the “catch me up” primitive for a resumed or forked session.
- **Input.** `scope?: 'session'|'tree'|'plan'|'changes'` (default `session`), `maxTokens?: number` (default 1200), `focus?: string`, `audience?: 'user'|'agent'` (default `agent`).
- **Output.** `brief: string`, `tokens`, `sources: Array<{kind, ref}>`, `omitted: string[]`.
- **capability** `providers.infer` (aux `context.manage`) · **eff** `network` (model call) · **RO** yes (no host mutation) · **perm** `allow` · **lease** kernel
- **Fails.** `NothingToBrief`; `BudgetExhausted`; the brief is *not* evidence — `sources` are references, and a claim in a brief MUST be re-checked against its receipt before it is repeated as fact; an `audience: 'user'` brief is redacted (`RedactionV1`) before rendering.

#### `ask_user` — `builtin.ask_user`
- **Purpose.** Ask the human a question and block until answered — the sanctioned way to resolve ambiguity instead of guessing.
- **Input.** `question: string` (≤ 2 KiB), `options?: Array<{label: string, description?: string, recommended?: boolean}>` (2..8), `context?: string` (≤ 4 KiB), `multiple?: boolean`, `timeoutMs?: number` (default: step budget), `defaultOnTimeout?: string` (must be an offered option, or `abort`).
- **Output.** `answer: string`, `selectedLabels: string[]`, `answeredAt`, `timedOut: boolean`, `freeform: boolean`.
- **capability** `ui.present` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `NoAnswerer` (headless runs with no TTY and no protocol client): the tool fails rather than inventing an answer; a timeout returns `timedOut: true` with `defaultOnTimeout` if one was declared, else the step fails; answers are recorded with their origin (`UserAction`) so a later receipt can point at the human decision.

### 4.7 Integrations

#### `lsp` — `builtin.lsp`
- **Purpose.** Talk to language servers: diagnostics, hover, completion, signature help, go-to-definition/references/implementations, document symbols, workspace symbols, code actions, formatting, rename, call hierarchy, inlay hints, semantic tokens, plus server lifecycle (`start`/`stop`/`restart`).
- **Input.** `op: string` (one of the 14+ operation ids), `path?: string`, `position?: {line, character}`, `newName?: string`, `query?: string`, `timeoutMs?: number` (default 15000), `apply?: boolean` (default false — code actions/format/rename are preview-only unless `apply` is set).
- **Output.** per-op payload (`diagnostics: Diagnostic[]`, `locations: Location[]`, `links: LocationLink[]`, `edits: TextEdit[]`, `hover: MarkupContent`, `formatted: TextEdit[]`, `rename: WorkspaceEdit`), `server`, `truncated`.
- **capability** per-op `opCapabilityMap`: `language.diagnostics` / `language.symbols` / `language.rename`; the declared maximum is `language.rename` (aux `files.patch` for `apply: true`) · **eff** `workspace-write` (maximum) · **RO** cond (`readOnlyWhen: apply-false`) · **perm** `allow` for diagnostics/navigation; `ask` for `apply: true` (format-on-save-style bulk edits prompt) · **lease** kernel only when `apply: true`
- **Fails.** `ServerNotInstalled` (with the exact command that would be run, which the user approves once per workspace); `ServerCrash` (restart with backoff, bounded); `PositionOutOfRange`; `ApplyWithoutWorkspaceEdit`; a server that would download binaries at startup is refused unless the workspace trust decision covers it (README §3.4 “programs named by a workspace stay off until trusted”).

#### `debug` — `builtin.debug`
- **Purpose.** Debug Adapter Protocol session control: launch/attach, breakpoints, stepping, stack traces, scopes, variables, evaluate, exception info, threads, watchpoints, plus 28+ defined operations.
- **Input.** `op: string`, `sessionId?: string`, `program?: string`, `args?: string[]`, `breakpoints?: Array<{path, line, condition?}>`, `frameId?: number`, `expression?: string`, `timeoutMs?: number`.
- **Output.** per-op payload (`state: 'stopped'|'running'|'exited'`, `reason`, `stackFrames[]`, `variables[]`, `evaluateResult: unknown`, `output: string`), `sessionId`.
- **capability** `debug.session` (aux `process.spawn` for the adapter) · **eff** `process` · **RO** no (`evaluate` can call functions with side effects) · **perm** `ask` on `launch`/`attach` (debugged programs execute real code with the session's environment) · **lease** kernel per session and per `evaluate`
- **Fails.** `AdapterNotConfigured`; `ProgramNotFound`; `BreakpointPending` (reported as a result, not an error); `EvaluateDenied` when the expression is outside the configured safety pattern; the debuggee inherits a scrubbed environment — no secrets from the vault reach a debuggee by default.

#### `mcp` — `builtin.mcp`
- **Purpose.** The MCP client surface: list servers, connect/disconnect, list tools/resources/prompts, read a resource, get a prompt, and invoke an MCP tool (usually through the per-server namespaced tools rather than this dispatcher).
- **Input.** `action: 'servers'|'connect'|'disconnect'|'tools'|'resources'|'prompts'|'read_resource'|'get_prompt'|'call'|'subscribe'`, `server?: string`, `uri?: string`, `name?: string`, `tool?: string`, `args?: Record<string, unknown>`, `timeoutMs?: number`.
- **Output.** `servers: Array<{name, transport, state, toolCount, auth: 'none'|'oauth'|'token', trusted}>`, `tools`, `resources`, `prompts`, `content` (for reads), `result` (for calls), `truncated`.
- **capability** `mcp.invoke` · **eff** `external-effect` · **RO** no (reads are `read_with_side_effects`) · **perm** `ask` on `connect` (a server is a new source of tools and instructions) and on any `call` whose tool is mutating; `allow` for listing an already-connected server's tools · **lease** kernel
- **Fails.** `ServerNotConfigured`; `AuthRequired` (OAuth flow handed to the user, never auto-approved); `UntrustedServer` (a workspace-named server stays off until the user trusts it for that folder); `ToolNotFound`; MCP servers are a **prompt-injection surface**: their tool descriptions are data, are rendered inside an explicit untrusted-content fence, and MUST NOT be able to redefine the session's tools, policy or presets.

#### `tool_search` — `builtin.tool_search`
- **Purpose.** Deferred discovery over the registry (R-tools-24..27).
- **Input.** `query: string`, `namespace?: string`, `limit?: number` (default 8), `includeSchemas?: boolean` (default false), `ttlSteps?: number`.
- **Output.** `matches: Array<{id, name, namespace, description, usage, capabilityId, effectClass, readOnly, inputFields}>`, `admitted: string[]`, `truncated`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** session (admission is a session fact)
- **Fails.** `QueryTooBroad` (returns the top matches plus a hint, never the whole registry); never returns a policy-hidden tool; admission of a tool whose provider later disconnects is reported at call time as `ToolUnavailable`, not at search time.

#### `github` — `builtin.github`
- **Purpose.** GitHub operations through the API or `gh`: issues, PRs, reviews, comments, checks, actions status, gists, releases — read *and* write, all receipted.
- **Input.** `op: string` (e.g. `pr.view`, `pr.create`, `pr.comment`, `pr.merge`, `issue.create`, `checks.list`, `run.rerun`, `release.create`), `repo: string`, `number?: number`, `body?: string`, `base?: string`, `head?: string`, `draft?: boolean`, `mergeMethod?: 'merge'|'squash'|'rebase'`, `auth?: 'gh-cli'|'token-ref'`.
- **Output.** per-op payload (`pr: {number, url, state, mergeable}`, `issue`, `checks: Check[]`, `comments`, `release`), `apiCalls`, `rateLimit: {remaining, resetAt}`.
- **capability** `vcs.write` for mutations, `vcs.read` for reads (aux `net.fetch`) · **eff** `external-effect` — the declared maximum · **RO** cond (`readOnlyWhen: op-in-read-set`) · **perm** `ask` for every mutating op (a merged PR is an outward, irreversible act) and `deny` unless a credential reference is configured · **lease** kernel
- **Fails.** `NoCredential` (the tool never prompts for a token inline and never prints one); `RateLimited`; `MergeConflict`; `ProtectedBranch`; `ChecksFailed` (a merge with failing required checks is denied by the API and reported as such, not retried); every mutation returns its API response as an artifact and a receipt.

#### `gitlab` — `builtin.gitlab`
- **Purpose.** The same surface for GitLab (MRs, issues, pipelines, notes, releases), self-hosted instances included.
- **Input.** `op: string`, `project: string` (path or id), `iid?: number`, `body?: string`, `targetBranch?: string`, `sourceBranch?: string`, `mergeWhenPipelineSucceeds?: boolean`, `instance?: string`.
- **Output.** per-op payload (`mr: {iid, webUrl, state}`, `pipeline: {id, status, jobs}`, `issue`, `note`), `apiCalls`.
- **capability** `vcs.write` / `vcs.read` (aux `net.fetch`) · **eff** `external-effect` · **RO** cond (op-dependent) · **perm** `ask` for mutations; `deny` until an instance + credential reference is configured · **lease** kernel
- **Fails.** `InstanceNotConfigured`; `AuthFailed`; `PipelineBlocked`; identical no-inline-token rule as `github`.

#### `schedule` — `builtin.schedule`
- **Purpose.** Create, list, pause, resume and delete scheduled runs of an agent (cron-like and interval-based), with a budget envelope per firing.
- **Input.** `action: 'create'|'list'|'pause'|'resume'|'delete'|'trigger_now'|'runs'`, `scheduleId?: string`, `cron?: string`, `everyMs?: number`, `prompt: string` (or `workflowId`), `grant?: object`, `budget?: {maxTokens, maxWallClockMs, maxCost}`, `timezone?: string`.
- **Output.** `schedules: Array<{id, cron, nextRunAt, state: 'active'|'paused'|'quarantined', lastRun?, grant, budget}>`, `created?`, `runs?: Array<{startedAt, status, receiptIds}>`.
- **capability** `schedule.manage` · **eff** `external-effect` (it will run on its own later) · **RO** no · **perm** `ask` always — a schedule is a standing instruction that outlives the conversation; `delete`/`pause` are `allow` for schedules this session created, and `deny` for others’ schedules without human action · **lease** kernel
- **Fails.** `InvalidCron`; `GrantEscalation` (a schedule cannot request a grant wider than the creating session had; firing is `ManagedRun`-origin, never `SessionBatch`); `MissedRun` (reported, not silently skipped); a schedule whose grants are revoked is `quarantined` rather than deleted, so the user can see why it stopped.

#### `remote_trigger` — `builtin.remote_trigger`
- **Purpose.** Trigger a run on another machine or in a remote sandbox (the multi-machine fleet path) and collect its receipts.
- **Input.** `target: string` (`remote://<host>` or `sandbox://<name>`), `prompt?: string`, `workflowId?: string`, `grant: object`, `budget?: object`, `wait?: boolean` (default true), `timeoutMs?: number`.
- **Output.** `runId`, `target`, `status`, `receipts: string[]`, `artifacts: string[]`, `usage`, `sessionUri`.
- **capability** `remote.exec` (aux `agent.spawn`) · **eff** `remote` · **RO** no · **perm** `deny` until the target is configured; then `ask` per trigger (with the grant shown) · **lease** kernel, scoped `remote://<target>`
- **Fails.** `TargetUnavailable`; `GrantExceedsParent`; `AuthFailed`; a remote run that loses its transport is `UNKNOWN` until reconciled from the remote's own receipt chain — the local run MUST NOT assume the remote work stopped.

#### `workflow` — `builtin.workflow`
- **Purpose.** Run a declarative Rhai workflow (multi-agent orchestration through the host channel): list, run, resume, cancel, inspect.
- **Input.** `action: 'list'|'run'|'resume'|'cancel'|'status'|'validate'`, `workflowId?: string`, `path?: string`, `inputs?: Record<string, unknown>`, `grant?: object`, `runId?: string`.
- **Output.** `workflows: Array<{id, name, source, digest, inputs}>`, `runId?`, `status?`, `steps: Array<{name, state, agentId?, receiptIds}>`, `outputs?`.
- **capability** `plugins.invoke` (aux `agent.spawn`) · **eff** `external-effect` (maximum) · **RO** no · **perm** `ask` on `run`/`resume` with the workflow digest and the union grant displayed; `allow` for `list`/`status`/`validate` · **lease** kernel
- **Fails.** `WorkflowParseError`; `DigestMismatch` (a workflow that changed since approval does not run under the old approval); `CapabilityNotDeclared` (a workflow step requesting a capability outside the grant is rejected at run time, not silently narrowed); the Rhai host channel is intentionally minimal — no direct filesystem, process or network access from script code; every effect goes through a tool and therefore through a lease.

#### `artifact_write` / `artifact_read` / `artifact_list` (family) — `builtin.artifact_*`
- **Purpose.** The content-addressed store surface (`hz://artifact/<sha256>`): write, fetch, list/metadata, and delete by reference.
- **Input.** `artifact_write: {content: string|bytes (base64 only for programmatic callers), mediaType, label?, ttlDays?}`; `artifact_read: {uri, offset?, limit?, as: 'text'|'json'|'base64'|'file'}`; `artifact_list: {prefix?, mediaType?, since?, limit?}`; `artifact_delete: {uri, confirm: true}`.
- **Output.** `uri`, `sha256`, `bytes`, `mediaType`, `createdAt`; `content` / `data` / `path`; `artifacts: Array<{uri, sha256, bytes, mediaType, label, createdAt}>`.
- **capability** `artifact.write` (write/delete), `files.read` (read/list) · **eff** `workspace-write` for write/delete, `read-only` for read/list · **RO** cond (`readOnlyWhen: action-in-read-list`) · **perm** `allow` for read/write within the session's store quota; `ask` for `artifact_delete` and for writing above the per-session artifact quota · **lease** kernel for write/delete, none for read/list
- **Fails.** `ArtifactNotFound`; `TooLarge` above the artifact cap (64 MiB); `QuotaExceeded`; content-addressed writes are idempotent by construction (`idempotency: idempotent` on the sha256) so a retry cannot duplicate; `artifact_read` of an artifact created by another session is `ask`, not `allow`.

#### `config` — `builtin.config`
- **Purpose.** Inspect and change project/user configuration (`.hz/` workspace config, `~/.config/horizon/` user config, model/agent/policy presets) — **narrowing only**.
- **Input.** `action: 'get'|'list'|'set'|'unset'|'diff'|'validate'`, `scope: 'session'|'workspace'|'user'`, `key?: string`, `value?: unknown`, `dryRun?: boolean` (default true).
- **Output.** `config: Record<string, unknown>`, `changed: string[]`, `requiresRestart: boolean`, `effectiveDiff`, `warnings: string[]`.
- **capability** `session.manage` · **eff** `workspace-write` · **RO** no · **perm** `ask` for every write; a `session`-scope write is `allow` · **lease** kernel
- **Fails.** `WidenAttempt` — per README §3.4 and R-tools-23, a write that would widen authority, add a tool, raise a posture, or enable an untrusted program is **denied by the kernel**, not merely warned about; the denial is recorded; user-scope writes from a model origin are always `ask` and never batchable.

#### `setting` — `builtin.setting`
- **Purpose.** Change run-scoped runtime settings: model/effort/verbosity, plan mode, auto-compaction policy, telemetry verbosity, output format — the things a user changes mid-session.
- **Input.** `action: 'get'|'set'|'list'`, `key: string` (closed enum: `model`, `effort`, `thinking`, `verbosity`, `autoCompact`, `posture`, `outputFormat`, `telemetry`), `value?: unknown`.
- **Output.** `settings: Record<string, unknown>`, `applied: string[]`, `rejected: Array<{key, reason}>`, `requiresRestart`.
- **capability** `session.manage` · **eff** `read-only` at the host (session state) · **RO** yes · **perm** `ask` for `posture` (raising posture is a human decision; a model-origin `posture` raise is denied) and for `model` when the change alters cost class; `allow` for the rest · **lease** session
- **Fails.** `UnknownKey`; `ValueOutOfRange`; `PostureEscalationDenied` (model origin); a setting that only takes effect on restart is reported with `requiresRestart: true` rather than pretending it applied.

### 4.8 Verification

#### `verify` — `builtin.verify`
- **Purpose.** Run the independent-evidence gate: replay the receipt chain for a scope and decide what is actually done, lowering claims and never raising them.
- **Input.** `scope: 'step'|'plan'|'session'|'run-tree'`, `id?: string`, `claims?: string[]` (claims to check), `requireIndependent?: boolean` (default true), `reconcile?: boolean` (default false), `evidenceSha256?: string`.
- **Output.** `verdict: 'verified'|'partial'|'unverified'|'refuted'`, `lowered: Array<{claim, from, to, reason}>`, `evidence: Array<{kind, ref, sha256}>`, `unknownEffects: string[]`, `reportUri`.
- **capability** `session.manage` (aux `vcs.read`) · **eff** `read-only` (writes a verification record + report artifact) · **RO** yes · **perm** `allow` · **lease** none (the report artifact write is `artifact.write` at `allow`)
- **Fails.** `NoReceipts` (a scope with no receipts is `unverified`, never “assumed fine”); `ReceiptChainBroken` (hash-chain mismatch ⇒ `refuted` plus an alert — this is a security signal, not a tool error); `UNKNOWN` effects make a verdict `partial` at best; `requireIndependent: false` is accepted but the verdict is marked `degraded: 'self-reported'` and is not usable as completion evidence.

#### `run_tests` — `builtin.run_tests`
- **Purpose.** Run the project's test suite (or a subset) and return structured results, not raw logs, with coverage when configured.
- **Input.** `target?: string` (test path, name pattern, or package), `framework?: string` (auto-detected when omitted), `timeoutMs?: number` (default 600000), `coverage?: boolean` (default false), `retries?: number` (default 0), `env?: Record<string,string>` (allow-listed).
- **Output.** `passed`, `failed`, `skipped`, `flaky`, `cases: Array<{name, status, durationMs, message?, file?, line?}>`, `coverage?: {lines, branches, files}`, `commandDigest` (sha256 of the exact command run), `stdoutUri`, `exitCode`.
- **capability** `process.spawn` · **eff** `process` · **RO** no (tests execute project code) · **perm** `ask` on first run per repo and whenever the resolved command differs from the pinned one (`commandDigest` change) · **lease** kernel
- **Fails.** `NoTestCommand` (never guesses a framework into existence — the user is asked once); `SuiteTimeout` (partial results retained with `timedOut: true`); `EnvDenied`; a suite that mutates tracked files reports the diff in the result and the mutation is receipted like any other effect; “tests passed” is claimable by `complete_step` only with the `commandDigest` and the result artifact as evidence.

#### `lint` — `builtin.lint`
- **Purpose.** Run the configured linters and return normalised diagnostics with autofix as a separate, explicit step.
- **Input.** `paths?: string[]`, `fix?: boolean` (default false), `rules?: string[]`, `timeoutMs?: number` (default 300000), `failOnWarnings?: boolean` (default false).
- **Output.** `diagnostics: Array<{path, line, column, severity, rule, message, fixable}>`, `counts: {error, warning, info}`, `fixed?: number`, `commandDigest`.
- **capability** `process.spawn` · **eff** `process` (plus `files.patch` for `fix: true`) · **RO** no · **perm** `ask` for the run (as `run_tests`); `fix: true` is a separate `ask` that names the files it would change, and the fix is applied through the edit engine with preimage hashes — not by letting the linter rewrite files behind the engine's back · **lease** kernel
- **Fails.** `NoLinterConfigured`; `LinterCrash`; a linter whose autofix touches a file outside `paths` aborts and rolls back; diagnostics are truncated by count with an artifact holding the full set.

#### `typecheck` — `builtin.typecheck`
- **Purpose.** Run the project's type checker and return structured type errors (file, range, code, message).
- **Input.** `paths?: string[]`, `tsconfig?: string` or `project?: string`, `timeoutMs?: number` (default 300000), `incremental?: boolean` (default true).
- **Output.** `errors: Array<{path, range, code, message, related?: Array<{path, range, message}>}>`, `count`, `warnings`, `commandDigest`, `exitCode`.
- **capability** `process.spawn` · **eff** `process` · **RO** no · **perm** `ask` on first run per repo (posture-level pre-approval then applies) · **lease** kernel
- **Fails.** `NoChecker`; `ProjectConfigInvalid`; incremental cache corruption falls back to a full run with an explicit `incrementalUsed: false`; the same command-digest rule as `run_tests` applies, so “typecheck is green” is only claimable for the digest that actually ran.

#### `security_scan` — `builtin.security_scan`
- **Purpose.** Run the configured security scanners (dependency audit, secret scan, SAST) and return findings with severity, location and remediation hints.
- **Input.** `scanners?: Array<'deps'|'secrets'|'sast'|'iac'|'container'>` (default all configured), `paths?: string[]`, `severityFloor?: 'low'|'medium'|'high'|'critical'` (default `low`), `timeoutMs?: number` (default 600000).
- **Output.** `findings: Array<{id, scanner, severity, path?, line?, package?, advisory?, fixAvailable?}>`, `counts`, `scannersRun`, `scannersSkipped: Array<{scanner, reason}>`, `artifactUri`.
- **capability** `process.spawn` (aux `net.fetch` for advisory database refreshes) · **eff** `process` · **RO** no · **perm** `ask` on first run per repo; advisory updates follow egress policy · **lease** kernel
- **Fails.** `ScannerMissing` (listed in `scannersSkipped`, never silently absent); `AdjacencyStale` when the advisory DB could not refresh offline (findings marked `staleness: 'unknown'`); a scan that finds a live secret in the workspace reports the **location only, never the value**, and never writes the value into the transcript or an artifact.

#### `review` — `builtin.review`
- **Purpose.** Produce a structured review of a diff against the goal and acceptance criteria, with severity-tagged findings and citations to evidence.
- **Input.** `target: 'working-tree'|'diff'|'pr'|'paths'`, `ref?: string` (base revision or PR number), `paths?: string[]`, `focus?: Array<'correctness'|'security'|'performance'|'tests'|'style'|'api-compat'>`, `maxFindings?: number` (default 25), `model?: string`.
- **Output.** `findings: Array<{severity, category, path, range, message, evidence: string[], suggestion?}>`, `summary: string`, `tokens`, `unverifiedAreas: string[]`.
- **capability** `providers.infer` (aux `vcs.read`, `files.read`) · **eff** `network` · **RO** yes · **perm** `allow` (it is a read-only model call over content the model can already read) · **lease** kernel
- **Fails.** `EmptyDiff`; `DiffTooLarge` (the review is scoped and `unverifiedAreas` lists what was not read); `BudgetExhausted`; a review finding is a **claim, not a receipt** — it MUST cite `evidence` paths, and an unsupported finding is rendered with `evidence: []` and flagged.

#### `budget_report` — `builtin.budget_report`
- **Purpose.** Report token, cost, step, wall-clock, triage and web-search budget consumption for a run tree, with projections and the binding constraint.
- **Input.** `scope?: 'session'|'tree'|'day'|'month'`, `id?: string`, `breakdown?: Array<'model'|'tool'|'agent'|'capability'>` (default `['model','agent']`), `currency?: string`.
- **Output.** `totals: {tokensIn, tokensOut, cost, steps, wallClockMs, webSearches}`, `byModel`, `byAgent`, `byCapability`, `budget: {limit, usedPct, bindingConstraint}`, `projection: {atStep?, atWallClock?}`, `currency`.
- **capability** `session.manage` · **eff** `read-only` · **RO** yes · **perm** `allow` · **lease** none
- **Fails.** `NoUsageData`; `UsageGap` (a provider that did not report usage is shown explicitly rather than counted as zero); `CurrencyMismatch` when models report different currencies; the report is a projection over `hz.usage.recorded` events and MUST NOT be treated as billing truth.

### 4.9 Summary table — every tool at a glance

`lease: y` = a one-use kernel lease is required; `s-ob` = session/observational write claim only; `—` = none. `RO` as in the legend (`yes` / `cond` / `no`).

| Tool | Capability ID | Effect class | RO | Kernel lease |
|---|---|---|---|---|
| `read` | `files.read` | `read-only` | yes | — |
| `read_many` | `files.read` | `read-only` | yes | — |
| `write` | `files.write` | `workspace-write` | no | y |
| `edit` | `files.patch` | `workspace-write` | no | y |
| `multi_edit` | `files.patch` | `workspace-write` | no | y |
| `patch` | `files.patch` | `workspace-write` | no | y |
| `apply_patch` | `files.patch` + `files.write`/`files.delete` | `workspace-write` | no | y |
| `notebook_edit` | `files.patch` | `workspace-write` | no | y |
| `delete_range` | `files.patch` | `workspace-write` | no | y |
| `delete_symbol` | `files.patch` | `workspace-write` | no | y |
| `move` | `files.move` (+`files.patch`) | `workspace-write` | no | y |
| `undo` | `files.patch` (+`vcs.read`) | `workspace-write` | no | y |
| `attach` | `files.read` / `net.fetch` | `read-only` / `network` | cond | y (URL variant) |
| `snapshot` | `worktree.manage` | `workspace-write` | cond | y |
| `rewind` | `worktree.manage` (+`files.patch`,`files.delete`) | `workspace-write` | no | y |
| `glob` | `files.read` | `read-only` | yes | — |
| `grep` | `files.read` | `read-only` | yes | — |
| `find` | `files.read` | `read-only` | yes | — |
| `ast_grep` | `files.read` | `read-only` | yes | — |
| `ast_edit` | `files.patch` | `workspace-write` | no | y |
| `symbols` | `language.symbols` | `read-only` | yes | — |
| `references` | `language.symbols` | `read-only` | yes | — |
| `definitions` | `language.symbols` | `read-only` | yes | — |
| `repo_map` | `files.read` | `read-only` | yes | — |
| `code_index` | `files.read` | `read-only` (build: `workspace-write`, `cache://`) | cond | y (build/refresh) |
| `outline` | `language.symbols` | `read-only` | yes | — |
| `shell` | `terminal.run` | `process` | no | y |
| `shell_session` | `terminal.pty` | `process` | no | y (per action) |
| `powershell` | `terminal.run` | `process` | no | y |
| `job` | `process.spawn` | `process` | cond | y (signal/kill) |
| `repl` | `repl.eval` | `process` | no | y (per eval) |
| `run_code` | `code.execute` | `process` (+`network`) | no | y |
| `code_mode` | `codemode.execute` | `external-effect` | no | y (per inner call too) |
| `container` | `process.spawn` (+`net.fetch`) | `process` (+`network`) | no | y |
| `ssh` | `remote.exec` | `remote` | no | y |
| `web_fetch` | `net.fetch` | `network` | yes | y |
| `web_search` | `net.search` | `network` | yes | y |
| `web_image` | `net.fetch` | `network` | yes | y |
| `browse` | `net.fetch` | `external-effect` | no | y |
| `computer` | `process.spawn` | `external-effect` | no | y |
| `view_image` | `files.read` | `read-only` | yes | — |
| `read_video` | `files.read` (+`process.spawn`) | `read-only` | yes | — |
| `generate_image` | `providers.infer` (+`artifact.write`) | `network` | yes | y |
| `tts` | `providers.infer` | `network` | yes | y (hosted) |
| `stt` | `providers.infer` | `network` | yes | y (hosted) |
| `chart` | `artifact.write` (+`process.spawn`) | `process` | yes | y |
| `memory_recall` | `memory.read` | `read-only` | yes | — |
| `memory_retain` | `memory.write` | `workspace-write` | no | y |
| `memory_edit` | `memory.write` | `workspace-write` | no | y |
| `memory_reflect` | `memory.write` (+`providers.infer`) | `workspace-write` | no | y |
| `context_notes` | `context.manage` | `read-only` | yes | s-ob |
| `new_context` | `context.manage` (+`session.manage`) | `workspace-write` | no | y |
| `compress` | `context.manage` | `read-only` / `network` | no | y (model strategies) |
| `history_search` | `memory.read` (+`session.manage`) | `read-only` | yes | — |
| `learn` | `memory.write` (+`providers.infer`) | `workspace-write` | no | y |
| `skill_manage` | `plugins.invoke` (+`net.fetch`) | `workspace-write` | no | y |
| `todo` | `session.manage` | `read-only` | yes | s-ob |
| `complete_step` | `session.manage` | `read-only` | yes | s-ob |
| `update_goal` | `session.manage` | `read-only` | yes | s-ob |
| `task` | `agent.spawn` | `external-effect` | no | y (per child call) |
| `fleet` | `agent.spawn` | `external-effect` | no | y (per child) |
| `parallel_tasks` | `agent.spawn` | `external-effect` | no | y (per child) |
| `read_only_task` | `agent.spawn` | `read-only` | yes | — |
| `team_create` | `agent.spawn` | `external-effect` | no | y |
| `team_delete` | `agent.spawn` | `external-effect` | no | y |
| `send_message` | `agent.spawn` | `read-only` | yes | s-ob |
| `wait` | `session.manage` | `read-only` | yes | — |
| `yield` | `session.manage` | `read-only` | yes | s-ob |
| `plan_enter` | `session.manage` | `read-only` | yes | s-ob |
| `plan_exit` | `session.manage` | `read-only` | yes | s-ob |
| `brief` | `providers.infer` (+`context.manage`) | `network` | yes | y |
| `ask_user` | `ui.present` | `read-only` | yes | — |
| `lsp` | `language.rename` (per-op `opCapabilityMap`) | `workspace-write` (max) | cond | y (`apply` only) |
| `debug` | `debug.session` (+`process.spawn`) | `process` | no | y |
| `mcp` | `mcp.invoke` | `external-effect` | cond | y |
| `tool_search` | `session.manage` | `read-only` | yes | s-ob |
| `github` | `vcs.write` / `vcs.read` | `external-effect` | cond | y |
| `gitlab` | `vcs.write` / `vcs.read` | `external-effect` | cond | y |
| `schedule` | `schedule.manage` | `external-effect` | no | y |
| `remote_trigger` | `remote.exec` (+`agent.spawn`) | `remote` | no | y |
| `workflow` | `plugins.invoke` (+`agent.spawn`) | `external-effect` | no | y |
| `artifact_write` / `artifact_delete` | `artifact.write` | `workspace-write` | cond | y |
| `artifact_read` / `artifact_list` | `files.read` | `read-only` | yes | — |
| `config` | `session.manage` | `workspace-write` | no | y |
| `setting` | `session.manage` | `read-only` | yes | s-ob |
| `verify` | `session.manage` (+`vcs.read`) | `read-only` | yes | — |
| `run_tests` | `process.spawn` | `process` | no | y |
| `lint` | `process.spawn` (+`files.patch` for `fix`) | `process` | no | y |
| `typecheck` | `process.spawn` | `process` | no | y |
| `security_scan` | `process.spawn` (+`net.fetch`) | `process` | no | y |
| `review` | `providers.infer` (+`vcs.read`) | `network` | yes | y |
| `budget_report` | `session.manage` | `read-only` | yes | — |

**Coverage check.** **92 rows** in the table above for **91 catalog entries** and **94 tool names**: the `artifact_*` family is one entry (§4.7) covering four tools and occupying two rows here, because its read half is `read-only` and its write half is `workspace-write`. Against `../README.md` §3.2 the sets are identical (91 entries, 94 names). This equality is a test, not a promise (§11.2).

---

## 5. Tools we deliberately do NOT ship, and why

The absences below are decisions, not gaps. Each one names the rule that keeps it absent.

| Not shipped | Why | Enforced by |
|---|---|---|
| `eval` / `exec_string` / any "run this snippet in the host process" tool | Arbitrary host-process evaluation is unrecoverable: no lease can bound it, no receipt can describe it, no sandbox contains it | R-tools-52 |
| `git push`, `git push --force`, `git push --force-with-lease` | A remote write is outward and irreversible; a model must not be able to publish on its own initiative | R-tools-53 |
| `deploy`, `publish`, `release`, `npm publish`, `cargo publish`, `docker push` | Same class as above: external-effect with no undo. If a project needs it, it runs as a `UserAction`-origin command the human approved for that exact digest | R-tools-53 |
| `git reset --hard`, `git clean -fdx`, `git checkout -- .`, branch deletion | Mass destruction of uncommitted human work from a single model call. `rewind`/`undo` cover the legitimate need *with* preimages and confirmations | R-tools-48, R-tools-53 |
| Any credential read: `env_dump`, `secret_get`, `read_credentials_file`, `kubeconfig_read` as a *tool* | Credentials are injected by the kernel at the effect boundary and scrubbed from output; a tool that can read a secret can exfiltrate it. `secrets.read` exists in the registry for the kernel's own path only | R-tools-54 |
| Printing a secret value into a result, artifact, log or receipt | Redaction happens before rendering; `security_scan` reports a secret's location and never its value | §4.8, `RedactionV1` |
| Unbounded recursive search (`grep` with no cap, `find /`, `**/*` with no limit) | A single call would defeat the context budget and could read outside the workspace. Every search tool declares a bound and reports truncation | R-tools-55 |
| Writes outside the workspace without an explicit grant | The default `files.*` scope is `workspace://**`; a write elsewhere needs a lease whose scope names the path and an `ask` a human answered | R-tools-56 |
| `sudo`, privilege escalation, `chmod 777`-style shortcuts, disabling the sandbox | The kernel does not offer an API for it; a sandbox residual is reported, never negotiated away | README §3.4 |
| Self-modifying policy tools (`policy_write`, `posture_set`, `grant_self`) | Authority changes are human decisions. `config`/`setting` may only narrow; a widening write is denied by the kernel | R-tools-23, §4.7 |
| Cross-session message/socket tools ("talk to any session") | No use case justifies an agent messaging unrelated sessions; `send_message` is limited to one's own descendants | §4.6 |
| A general-purpose expression evaluator in `wait` / `config` | It would be `eval` through the back door; predicates are a closed grammar | §4.6, §4.7 |
| `http_request` with arbitrary method/headers/body against arbitrary hosts | `web_fetch` is read-shaped: allow-listed headers, GET-class semantics, redirects confined to the granted origin. Mutating HTTP is an integration's job (`github`, `gitlab`, `mcp`) where each op has a typed shape and a receipt | §4.4, §4.7 |
| Auto-installing language servers / plugins / container images on demand | A tool must not fetch and execute a binary because the model asked. Installations are user decisions; `pull: 'never'` is the container default and untrusted workspace programs stay off | §4.7, README §3.4 |
| `dangerously_skip_permissions` / `--yolo` as a tool argument | Posture is human configuration. A tool argument that widened it would make authority model-controlled | README §3.4, R-tools-38 |
| Reading the user's browser profile or OS keychain for `browse`/`computer` | Drives real accounts with real credentials; the browser runs with a per-session profile that carries none | §4.4 |
| Sending e-mail / chat messages / social posts | `external-effect` with a recipient the human never named; publishing is a `UserAction` decision, not a tool call | R-tools-53 |
| `sql_exec` against a user's production database | Unbounded, unrecoverable, and impossible to scope to a lease honestly; project-specific DB access belongs behind a plugin that declares its own capability and runs governed | R-tools-52 |

---

## 6. Data

Schemas are defined in `05-domain-and-schemas.md`; this section records **which schema each tool family reads and writes**. No schema is defined here.

| Tool family | Reads | Writes / emits |
|---|---|---|
| Declaration, registry, gates | `ToolDeclarationV1`, `ToolPermissionV1`, `PluginManifestV1`, `McpServerConfigV1`, `SkillManifestV1` | `ToolRegistrySnapshotV1` (per step, inside `StepRecordV1`) |
| Invocation and results | `ToolCallV1`, `StepRecordV1`, `SessionPostureV1` | `ToolCallV1`, `ToolResultV1`, `PartV1`, `AttachmentV1`, `ArtifactV1` |
| Files (`read`…`rewind`) | `AttachmentV1`, `SnapshotV1` | `ArtifactV1` (spills), `SnapshotV1`, `EffectReceiptV1` |
| Search & navigation | `ToolRegistrySnapshotV1` (staleness), `SnapshotV1` | index caches (`cache://`), `ArtifactV1` |
| Execution (`shell`…`ssh`) | `LeaseV1`, `SessionPostureV1` | `EffectRequestV1`, `EffectReceiptV1`, `PartV1` (stream deltas), `TypedErrorV1` |
| Web & media | `AttachmentV1` | `ArtifactV1`, `AttachmentV1`, `EffectReceiptV1`, `UsageV1` |
| Memory & context | `MemoryRecordV1`, `PartV1`, `MessageV1`, `PlanV1`, `TodoV1`, `GoalV1` | `MemoryRecordV1`, `TodoV1`, `GoalV1`, `PlanV1`, `CheckpointV1`, `TrajectoryV1` (`learn`) |
| Agent & orchestration | `AgentProfileV1`, `SubagentSpecV1`, `TeamStateV1`, `BudgetV1`, `LeaseV1` | `AgentMessageV1`, `TeamStateV1`, `SubagentSpecV1`, `UsageV1`, `EffectReceiptV1` |
| Integrations | `McpServerConfigV1`, `PluginManifestV1`, `HookDefV1`, `CommandDefV1`, `ModelRefV1`, `SessionConfigV1` | `WorkflowDefV1` (`workflow`), `TrustedHostStateV1` (workspace trust decisions), `EffectReceiptV1` |
| Verification | `EffectReceiptV1`, `ReconciliationRecordV1`, `UsageV1`, `CostV1`, `BudgetV1` | `BudgetReportV1`, verification records + report artifacts; `learn` writes `TrajectoryV1`, `EvalCaseV1`, `LearnProposalV1` |
| Errors and observation (all families) | `ErrorCategoryV1`, `RetryClassV1` | `TypedErrorV1`, `RedactionV1` (profiles), `UsageV1` |

**Persistence rules.** (a) A tool never writes durable state outside the event log, the artifact store, the snapshot store and its declared scope. (b) Everything a tool produces that the model must not carry is an artifact (`hz://artifact/<sha256>`), never an inline blob. (c) `ToolRegistrySnapshotV1` and the tool-call pair in `StepRecordV1` are the replay substrate: a replay that cannot reproduce the registry snapshot MUST fail loudly rather than re-run against today's registry.

---

## 7. Errors and failure modes

### 7.1 What is fail-closed

| Situation | Fail-closed behaviour | Never happens |
|---|---|---|
| Declaration missing a field / enum out of range / duplicate id | Build and CI fail; the tool is absent from the shipped binary | “Register it and warn” |
| Validator does not compile | Tool is not registered; not visible, not callable; the omission is an explicit fact | Silent skip of the schema check |
| Guard returns an unknown or unparseable decision | `deny` | Default-allow on parser error |
| `ask` unanswered | Step fails as `denied` with `denied_by_grant_expired`; the call is a denial for settlement | Auto-answer from the model, or “assume yes after N seconds” |
| Lease missing, expired, already used, or scope-mismatched | Execute never starts | Reissue the previous lease for convenience |
| Effect touches a resource outside the lease scope | The confined action fails; a policy-violation fact is recorded | Partial execution with a warning |
| Outcome unprovable after `execute` began (kill, timeout, transport loss, crash) | `UNKNOWN` + `hz.effect.unknown` + reconciliation | “Probably succeeded, retry it” |
| Harness result and host evidence disagree | Settlement is `UNKNOWN`; the receipt is not written as success | Trust the tool's own claim |
| Workspace config tries to widen authority | Parse fails closed with `policy.denied` and a recorded policy-revision fact | Warn and continue |
| Plugin/MCP tool claims a capability its manifest did not request | Tool is dropped | Silent narrowing that the model cannot see |
| `tool_search` query hits a policy-hidden tool | Not returned, not admitted | “Hidden but revealed on search” |
| Network egress denied by policy | Terminal error, not retried | Retry through another route |
| Sandbox cannot confine a requested execution | `SandboxUnavailable` / typed residual; the call fails | Silent unconfined execution |
| Output exceeds the hard cap | `OutputTooLarge` | Unbounded spill to disk |

### 7.2 Error categories × tool class

| Tool class | Categories used | Default `retryClass` | Notes |
|---|---|---|---|
| Read-only (`files.read`, `language.symbols`, search) | `NotFound`, `PermissionDenied`, `BinaryFile`, `TooLarge`, `InvalidInput`, `Timeout` | `retry-safe` (except `InvalidInput`, `PolicyDenied`) | Empty results are successes (R-tools-47). No receipt claims an effect |
| Mutating (`files.write/patch/move/delete`, `worktree.manage`, `memory.write`) | `Conflict`, `NoMatch`, `AmbiguousMatch`, `TargetExists`, `DiskFull`, `ReadOnlyMount`, `PartialApply`, `Unknown` | `no-retry` after `execute`; `keyed` tools retry only with the same key | All-or-nothing, preimage+postimage hashes, `UNKNOWN` ⇒ reconcile (R-tools-48) |
| Network (`net.fetch`, `net.search`, `providers.infer`, `mcp.invoke` remote) | `Timeout`, `Dns`, `Tls`, `Http4xx`, `Http5xx`, `RefusedByPolicy`, `RateLimited`, `AuthRequired` | `refused_by_policy` ⇒ terminal; `503`-class ⇒ bounded retry with jitter; `4xx` ⇒ no retry | Redirects and retries stay inside the granted `net://` scope (R-tools-49) |
| Process (`terminal.run`, `terminal.pty`, `process.spawn`, `code.execute`, `debug.session`) | `CommandDenied`, `Timeout`, `Signal`, `NonZeroExit` (a *result*), `SpawnFailed`, `SandboxUnavailable`, `OutputTooLarge` | `no-retry` by default; a retry is a new call with a new lease | A signal after a possible side effect ⇒ `UNKNOWN` (R-tools-50) |
| Session-state (RO-visible tools, `session.manage`, `context.manage`, `ui.present`) | `NotFound`, `InvalidInput`, `Conflict`, `NotSupported`, `BudgetExhausted` | `retry-safe` | Cannot produce host effects; their receipts are session facts, not effect receipts |
| Agent-spawn (`agent.spawn`) | `GrantExceedsParent`, `DepthExceeded`, `ConcurrencyExceeded`, `BudgetExhausted`, `ChildUnknown` | `no-retry` for the spawn; the *child's* UNKNOWN effects are reconciled by the parent | A child never inherits leases (R-tools-32) |

### 7.3 Error shape on the wire

Every failure is `TypedErrorV1`:

```jsonc
{ "category": "conflict", "retryClass": "keyed",
  "message": "edit refused: preimage changed",
  "detail": { "path": "src/app.ts", "expectedSha256": "…", "actualSha256": "…", "changedBy": "human|tool|unknown" },
  "docsUri": "file:///…/docs/09-tools.md#82-edit-with-stale-preimage-conflict",
  "origin": { "kind": "SessionBatch", "sessionId": "…", "stepId": "…" } }
```

`detail` is typed per category (a closed set per tool), never a free-form dump: this is what lets the model decide correctly without a human reading logs, and what lets tests assert on behaviour rather than on strings.

---

## 8. Flows

### 8.1 The generic tool execution flow

```
model emits tool call (ToolCallV1)
  │
  1. resolveTool(registry, toolId)            → miss ⇒ ToolNotFound (terminal)
  2. visibleTools(session) membership check   → miss ⇒ ToolNotVisible
  3. snapshot check (R-tools-22)              → miss ⇒ ToolSnapshotMismatch
  4. validateArgs(decl, args)                 → invalid ⇒ ToolInputInvalid, NO PROMPT SHOWN, NO LEASE
  5. Guard.authorize(EffectRequestV1)         → deny ⇒ record + return; ask ⇒ hz.permission.asked
  6. human answer (UserAction origin only)    → expiry ⇒ denial
  7. IssueLease(…, idempotencyKey)            → kernel lease (or session write claim)
  8. EffectHost.execute(lease, call)          → effect, confined to the lease scope
  9. observe: PartV1 deltas / truncation      → caps of §3.7, spills to hz://artifact/<sha256>
 10. settleEffect(result, hostEvidence)       → agree ⇒ hz.effect.settled; else hz.effect.unknown
 11. EffectReceiptV1 (mutating/network/process/remote/external) ; if unknown ⇒ reconcile
 12. ToolResultV1 → renderModel / renderHuman → hz.step.tool.completed
```

Steps 4–7 run before the effect; steps 8–12 after. Every boundary is a point where a crash leaves a *recorded*, reconcilable state: before step 7 nothing happened; after step 8 the outcome is either settled or `UNKNOWN`. There is no third state.

**Cross-process serialization (as shipped, ruling 63 in `docs/28`).** `write`, `edit`, `apply_patch` and `ast_edit` take an advisory per-target-file lock (`core/file-lock.ts`) after approval and hold it across the final preimage check, the atomic write and the journal record. A second hzcode process that changed the file first is reported as `HZ_PRECONDITION_FAILED: ... preimage changed` and nothing is written; a second process that is mid-edit makes this call wait (bounded, `HZ_LOCK_TIMEOUT`), not interleave.

### 8.2 `edit` with a stale-preimage conflict

| # | Actor | Action |
|---|---|---|
| 1 | Model | `read(src/app.ts)` → result carries `sha256: A1` |
| 2 | Model | `edit(path, oldString, newString, expectedSha256: A1)` |
| 3 | Pipeline | validate ok; Guard → `allow` (workspace-write, posture `allow`); lease `L1` scoped `workspace://src/app.ts`, key `sha256(workspace|src/app.ts|newString)` |
| 4 | Effect host | Preimage check: file hash is now `B2` (a human saved in their editor, or a linter autofix ran) ≠ `A1` |
| 5 | Effect host | **Nothing is written.** No temp file, no partial change |
| 6 | Settle | `status: error`, `category: conflict`, `retryClass: keyed`, `detail: {expectedSha256: A1, actualSha256: B2, changedBy: human}`; no effect receipt is emitted (no effect occurred) — a *decision* record is |
| 7 | Model | Re-reads (`sha256: B2`), re-plans, calls `edit` again with `expectedSha256: B2`; that is a new call with a new lease |
| 8 | Human | If the human's edit and the model's intent conflict semantically, the model MUST surface the divergence rather than “win” the write |

**Anti-patterns this forbids:** silently retrying with the new hash (that is how an agent overwrites human work); applying the edit anyway when only one of several hunks matched; reporting `Conflict` as a successful no-op.

### 8.3 `shell` with an approval

| # | Actor | Action |
|---|---|---|
| 1 | Model | `shell(command: "git commit -am 'fix'")` |
| 2 | Pipeline | validate ok |
| 3 | `hz_policy` | Compiles the command against the rule set (wildcard DSL + Starlark prefix engine). `Shell(git commit*)` matches a rule whose decision is `ask` |
| 4 | Guard | Emits `hz.effect.decision.made` (`ask`, matched rule id) and `hz.permission.asked` with: the command, the resolved `cwd`, the capability (`terminal.run`), the effect class (`process`), the reason, and the rule that matched |
| 5 | Human | Approves once, or approves-for-session for that exact command prefix, or denies |
| 6 | Pipeline | `ask` answered `allow` ⇒ lease `L2` scoped to the command, workspace and TTL; the approval is recorded with `UserAction` origin |
| 7 | Effect host | Runs the command under the sandbox with a scrubbed environment |
| 8 | Observe | stdout/stderr stream as parts, capped; long output spills to an artifact |
| 9 | Settle | `exitCode: 0` ⇒ settled; the new commit object is the effect, with `git rev-parse HEAD` captured as postimage evidence |
| 10 | Receipt | `EffectReceiptV1` with origin `SessionBatch` + the authorizing human decision, `capabilityId: terminal.run`, the command digest, preimage HEAD, postimage HEAD |

**Variants.** A `deny` rule short-circuits before step 4 and the model sees the rule id — it may not rephrase the command to dodge the rule (the compiled rule set matches the *decision*, and repeated near-miss attempts are visible in the transcript and count against the run's policy-violation budget). A timeout at step 7 after the commit was written but before the process reported ⇒ `UNKNOWN` ⇒ reconcile with `git rev-parse HEAD` before anything else is retried.

### 8.4 A subagent task

| # | Actor | Action |
|---|---|---|
| 1 | Model | `task(prompt: …, profile: 'executor', grant: {capabilities: ['files.read','files.patch'], scope: ['workspace://src/**'], maxSteps: 20, maxTokens: 60000}, capsule: {files: ['src/app.ts']})` |
| 2 | Pipeline | Guard: grant is a **subset** of the parent's capabilities and scope ⇒ `ask` (contains `files.patch`) — the decision shows the grant verbatim |
| 3 | Human | Approves the grant for this task |
| 4 | Controller | Spawns a child session: new `sessionId`, `origin: SessionBatch` with `parentAgentId`, its own execution claim, its own budgets (inherited ceilings, not inherited consumption), a context capsule instead of the parent's transcript |
| 5 | Child | Runs its own steps through the *same* pipeline; every mutating call takes its **own** lease; the parent's leases are not visible to it |
| 6 | Child | Emits its own receipts, all tagged with the child's session id and `parentReceiptId` linkage |
| 7 | Channel | `send_message(kind: 'steer')` from the parent is delivered **between** child steps; a `steer` arriving mid-tool-call is queued |
| 8 | Completion | The child returns a report + `receiptIds` + `usage`; the parent's `task` result is `completed` |
| 9 | Verification | The parent MUST NOT copy the child's claims into its own completion. `verify(scope: 'run-tree')` walks the child's receipt chain; a child `UNKNOWN` effect makes the parent's verdict `partial` until reconciled |

**Failure paths.** Grant escalation at step 1 ⇒ `GrantExceedsParent` before any spawn. Child death mid-effect ⇒ `UNKNOWN`, reconciled by the parent (the child cannot reconcile what it can no longer see). Parent cancelled ⇒ children are cancelled at their next step boundary, and their in-flight effects settle as results or `UNKNOWN` — never as silence.

---

## 9. Security and authority

### 9.1 The one-line model

A tool **requests**; the kernel **decides**; a lease **bounds**; a receipt **proves**. The model's text never carries authority, and no tool argument can widen what the session's posture and policy allow (R-tools-5, R-tools-23, R-tools-38).

### 9.2 Capability → first-line tools

The **canonical** capability IDs of `_conventions.md` §5 and the tools whose declaration names them, one capability per declaration (§2.1; a call that additionally needs a read adjunct or a second write arm leases it separately, R-tools-32):

| Capability ID | Tools |
|---|---|
| `files.read` | `read`, `read_many`, `glob`, `grep`, `find`, `ast_grep`, `repo_map`, `code_index`, `attach`, `view_image`, `read_video`, `artifact_read`, `artifact_list` |
| `files.write` | `write`, `apply_patch` (add arms) |
| `files.patch` | `edit`, `multi_edit`, `patch`, `apply_patch`, `notebook_edit`, `delete_range`, `delete_symbol`, `move`, `undo`, `ast_edit`, `rewind` (restore), `lint --fix`, `lsp --apply` |
| `files.delete` | `apply_patch` (delete arms), `rewind` |
| `files.move` | `move` |
| `terminal.run` | `shell`, `powershell` |
| `terminal.pty` | `shell_session` |
| `process.spawn` | `job`, `container`, `computer`, `chart` (renderer), `debug` (adapter), `run_tests`, `lint`, `typecheck`, `security_scan`, `read_video` (demuxer) |
| `net.fetch` | `web_fetch`, `web_image`, `browse`, `attach` (URLs), `skill_manage` (registry), `security_scan` (advisories), `github`, `gitlab` |
| `net.search` | `web_search` |
| `providers.infer` | `generate_image`, `tts`, `stt`, `brief`, `review`, `memory_reflect`, `learn` |
| `models.list` | *(no tool — CLI/API surface only, deliberately)* |
| `code.execute` | `run_code` |
| `codemode.execute` | `code_mode` |
| `language.symbols` | `symbols`, `references`, `definitions`, `outline`, `lsp` (navigation ops) |
| `language.diagnostics` | `lsp` (diagnostics/actions ops) |
| `language.rename` | `lsp` (`rename --apply`) |
| `debug.session` | `debug` |
| `repl.eval` | `repl` |
| `vcs.read` | `github`, `gitlab` (reads), `review`, `verify`, `undo` |
| `vcs.write` | `github`, `gitlab` (mutations) |
| `memory.read` | `memory_recall`, `history_search` |
| `memory.write` | `memory_retain`, `memory_edit`, `memory_reflect`, `learn` |
| `plugins.invoke` | `skill_manage`, `workflow` |
| `schedule.manage` | `schedule` |
| `agent.spawn` | `task`, `fleet`, `parallel_tasks`, `read_only_task`, `team_create`, `team_delete`, `send_message`, `workflow` (aux), `remote_trigger` (aux) |
| `artifact.write` | `artifact_write`, `artifact_delete`, `chart`, `generate_image` |
| `secrets.read` | *(no tool — kernel-internal only; asserted by test, §11)* |
| `worktree.manage` | `snapshot`, `rewind` |
| `remote.exec` | `ssh`, `remote_trigger` |
| `mcp.invoke` | `mcp` and every namespaced `mcp.<server>.<tool>` |
| `ui.present` | `ask_user` |
| `session.manage` | `todo`, `complete_step`, `update_goal`, `tool_search`, `wait`, `yield`, `plan_enter`, `plan_exit`, `config`, `setting`, `verify`, `budget_report`, `send_message` |
| `context.manage` | `context_notes`, `new_context`, `compress` |

#### 9.2.1 Reserved capability IDs this catalog deliberately does not use

`_conventions.md` §5 also registers sixteen **reserved** IDs (RC-11: "not yet canonical … MUST NOT be used by any implementation", promoted only in the change that first implements the feature). None appears in §4, and that is the correct mapping rather than a missing one — a catalog entry that named one would violate RC-11. Each reserved ID's tool keeps its canonical capability until promotion:

| Reserved ID (RC-11) | Today's canonical owner here | Promoted by |
|---|---|---|
| `browser.control` | `net.fetch` (`browse`, §4.4) | the change that implements the browser-control feature |
| `index.query` | `files.read` (`code_index`, `symbols`, §4.2) | the index feature's phase |
| `media.render` | `artifact.write` (`chart`, `generate_image`, §4.4) | the media-render phase |
| `voice.io` | `providers.infer` (`tts`, `stt`, §4.4) | the voice phase |
| `tool.discover` | `session.manage` (`tool_search`, §4.7) | the discovery phase |
| `learn.run`, `learn.propose` | `memory.write` (`learn`, `memory_reflect`, §4.5) | the self-improvement phase |
| `plugin.install` | `plugins.invoke` (`skill_manage`, §4.5) | the plugin-install phase |
| `workflow.run` | `plugins.invoke` (`workflow`, §4.7) | the workflow phase |
| `debug.record` | `debug.session` (`debug`, §4.7) | NF (debug recording) |
| `preview.serve` | — (no tool yet; this document's §5 does not ship one) | the preview feature |
| `collab.manage`, `notify.emit` | — (no tool yet; reserved for a future surface) | the collab / notification features |
| `receipt.read`, `sandbox.probe`, `enterprise.policy.read` | — (kernel-internal: `verify` reads receipts under `session.manage`, the kernel probes the sandbox and evaluates managed policy) | the features that expose them |

### 9.3 How authority is narrowed

1. **Posture** (`allow` / `ask` / `deny`) is the outer bound, set by the human and enforced by the kernel.
2. **Policy** rules (`Shell(git status)`, `Edit(src/**)`) decide per invocation; precedence `deny > ask > allow`.
3. **Lease scope** is the inner bound: the exact resource, one use, expiring.
4. **Grants** narrow what a subagent may attempt; a grant can never exceed its parent (R-tools-32, §8.4).
5. **Workspace config narrows only**; a widening attempt is denied and recorded (R-tools-23).
6. **Session allow-lists** may remove tools; nothing may add authority except a human decision.

### 9.4 Untrusted content

Everything a tool *fetches* is data, never instruction: web pages, MCP tool descriptions, skill bodies from a registry, repository files, command output. The context compiler fences it and the model is told where it came from. Specifically: MCP server descriptions are rendered inside an untrusted-content fence and cannot redefine tools, policy or presets (§4.7); a skill from a registry is `unverified` until verified and runs with a reduced tool set (§4.5); a repository file that contains “ignore previous instructions” is still a file.

### 9.5 Escalation attempts are first-class facts

A model-origin attempt to set `planApproved`, raise `posture`, widen `config`, self-grant a capability, or rephrase a denied command is recorded with its origin and counts against the run's policy-violation budget. Silent failure is not acceptable here: the attempt itself is evidence about the run.

### 9.6 Redaction and egress

Redaction is applied **before** rendering, logging and receipting (`RedactionV1`). Egress is bounded by the `net://` scope of the lease and by the egress allow-list; `refused_by_policy` is terminal. Secrets are injected by the kernel into specific effects and are not present in the model's context, in tool arguments, or in the environment a tool can `env`-dump (§5).

---

## 10. Performance budgets

These are **targets**, not measurements. Nothing has been benchmarked - this repository is design only (`../README.md` status note). They exist so that the design has testable numbers.

### 10.1 Dispatch and pipeline overhead

| Budget | Target |
|---|---|
| Declaration load + validator compile, cold start, 300 declarations | ≤ 200 ms total, ≤ 1 ms per declaration |
| Registry build + snapshot hash, warm | ≤ 20 ms |
| `resolveTool` + visibility + snapshot check | ≤ 0.2 ms p50, ≤ 1 ms p95 |
| Session-state tool end-to-end (no kernel round trip) | ≤ 0.5 ms p50, ≤ 2 ms p95 |
| Kernel round trip (UDS): decision + lease issue | ≤ 3 ms p50, ≤ 10 ms p95 |
| Full pipeline overhead for a mutating tool, excluding the effect itself | ≤ 8 ms p50, ≤ 25 ms p95 |
| `hz.telemetry` span + attributes per call | ≤ 40 µs |
| Receipt write (append + projection) | ≤ 1 ms p95 |
| `tool_search` query over 5,000 declarations | ≤ 20 ms p95 |
| Registry snapshot size for 5,000 declarations | ≤ 2 MiB in memory, ≤ 512 KiB on disk |
| Permission prompt latency added by the pipeline itself (excluding human think time) | ≤ 5 ms |

### 10.2 Truncation and output budgets

| Budget | Default | Hard cap |
|---|---|---|
| Model-facing text per tool result | 16 KiB / 4,000 tokens | 64 KiB / 16,000 tokens (config override) |
| Human-facing pane content per result | 1 MiB (virtualised) | 8 MiB |
| Full retained output per call (artifact spill) | 1 MiB inline + artifact | 64 MiB per artifact; above ⇒ `OutputTooLarge` |
| Streaming ring buffer per process/PTY stream | 1 MiB | 4 MiB |
| `grep` matches | 200 | 5,000 (then truncate); 10 s wall clock |
| `glob` entries | 500 | 20,000 |
| `find` results | 200 | 2,000 |
| `repo_map` tokens | 4,000 | 16,000 |
| `repo_map` / `outline` cold build per 1,000 files | ≤ 400 ms | 3 s (then `stale: true`) |
| Tool prompt fragments (whole visible set) | 4,000 tokens | 8,000 tokens (deferred discovery triggers at the cap, R-tools-24) |
| Single `promptFragment` | 512 bytes / ~120 tokens | — (gate) |

### 10.3 Concurrency budgets

| Budget | Default | Hard cap |
|---|---|---|
| Concurrent `parallel_safe` tool calls per session | 4 | 8 |
| Concurrent live subagents | 4 per session / 8 read-only children / 12 per root run — `08-runtime.md` R-runtime-68 owns this ceiling | as 08; `fleet` may request up to 16 **only** while the global ceiling allows, and excess spawns queue with backpressure |
| Subagent depth | 3 default — `08-runtime.md` R-runtime-67 owns it | 5 |
| Concurrent PTY sessions | 2 | 4 |
| Concurrent MCP in-flight calls per server | 2 | 8 |
| Snapshot store growth per session | 500 MiB | 2 GiB (then oldest snapshots evict, oldest-first, with a recorded eviction) |

**How the numbers are enforced.** The pipeline measures its own overhead per call and records it in `ToolResultV1.usage`; a run whose p95 pipeline overhead exceeds the budget for a sustained window raises a performance fact (it does not silently slow down). The truncation budgets are enforced in `truncateModelText` (R-tools-42/43) and asserted by tests, not by convention.

> Reconciled 2026-11-07 (reaudit stage 2, RC-15). The depth and subagent-concurrency ceilings are **owned by `08-runtime.md`** (§2.11, R-runtime-67/R-runtime-68) and are cited here, never restated: 09 sets only the tool-surface budgets (dispatch, output, `parallel_safe` fan-out width).

---

## 11. Tests

All tests below are **designed**; none is claimed to exist. Names are the intended test ids.

### 11.1 The declaration completeness gate (the central gate)

| Test id | Proves |
|---|---|
| `tools.declaration.completeness` | R-tools-2/12: for **each** mandatory field of `ToolDeclarationV1` (the fixture set is generated from the 05 §4.7 schema, so it cannot fall behind the field list), a negative fixture with that field removed makes `hzcode lint tools --gate completeness` exit non-zero, and the well-formed control passes |
| `tools.declaration.enums_closed` | R-tools-12(b): a value outside each enum is rejected (`effectClass`, `concurrencyClass`, `readOnlyClass`, `idempotency`, permission decision) |
| `tools.declaration.capability_known` | R-tools-12(d): a `capabilityId` absent from `_conventions.md` §5 fails the gate; the test parses the conventions file so the list cannot drift |
| `tools.declaration.effect_floor` | R-tools-3/12(e): a `read-only` tool declaring `workspace-write`, and a `files.write` tool declaring `read-only`, both fail |
| `tools.declaration.scope_rules` | R-tools-12(g)/R-tools-5: `**` rejected outside `session.manage`/`context.manage`; missing scope rejected |
| `tools.declaration.timeout_required` | R-tools-7/12(h): a missing timeout, `0`, and “unbounded” all fail |
| `tools.declaration.prompt_fragment` | R-tools-10/12(j): empty fragment and a fragment > 512 bytes both fail |
| `tools.declaration.unique_ids` | R-tools-12(c)/R-tools-20: duplicate ids fail; crafting a collision across namespaces produces the deterministic `_2` rename and fails if the rename is not applied |
| `tools.declaration.conditional_predicate` | R-tools-2: `readOnlyClass: read_with_side_effects` without a resolvable `readOnlyWhen` fails |
| `tools.declaration.op_capability_map` | every op of a multi-op tool (`lsp`, `debug`, `mcp`, `job`, `github`) has a capability mapping; an unmapped op fails (this is the guard against a new op silently inheriting authority) |
| `tools.fixtures.golden` | R-tools-14: generated fixture ≠ committed fixture ⇒ fail; `--update-fixtures` is the only accepted path |
| `tools.prefix.stability` | R-tools-13: editing a `promptFragment` without a `prefixRevision` bump fails; reordering namespaces does not change bytes |

### 11.2 Registry, discovery, catalog

| Test id | Proves |
|---|---|
| `tools.registry.namespace_rank` | R-tools-20: collision resolution order and the `_2` suffix |
| `tools.registry.no_builtin_claim` | R-tools-21: a plugin/MCP manifest claiming `builtin.*` is dropped |
| `tools.registry.manifest_capability_subset` | R-tools-18: a contributed tool whose capability exceeds its manifest is dropped, and the drop is a recorded fact |
| `tools.registry.validator_compile_fail` | R-tools-15: an uncompilable schema ⇒ unregistered, absent from the visible list, uncallable by name |
| `tools.registry.snapshot_replay` | R-tools-22: a replay against a different registry snapshot fails loudly |
| `tools.search.respects_policy` | R-tools-27: a tool hidden by posture/allow-list/trust is not returned, not admitted, and not describable |
| `tools.search.no_execution` | R-tools-25: `tool_search` performs no filesystem, network or tool activity (asserted by a sandbox that would flag it) |
| `tools.search.admission_visible_next_step` | R-tools-26: admission appears in the next step's projected tail, not the stable prefix |
| `tools.catalog.coverage_vs_readme` | §4.9: the catalog tools ↔ README §3.2 names are equal (with the documented `artifact_*` expansion). Adding a tool to the README without a declaration (or vice versa) fails |
| `tools.catalog.no_secrets_capability` | R-tools-54: zero declarations declare `secrets.read` |
| `tools.catalog.bounds_declared` | R-tools-55 + R-tools-44: every `pagination: none` tool declares a numeric bound; every search tool has a cap |
| `tools.catalog.lease_declared` | the §4.9 kernel-lease column matches the declarations, and every `mutating`/`external-effect` tool requires a kernel lease |

### 11.3 Pipeline, fail-closed, settlement

| Test id | Proves |
|---|---|
| `tools.pipeline.invalid_input_no_effect` | R-tools-29: an invalid call performs no effect, requests no lease, and shows no prompt |
| `tools.pipeline.guard_unknown_denies` | §7.1: an unparseable decision is `deny` |
| `tools.pipeline.ask_not_model_answerable` | R-tools-31: a `SessionBatch`-origin answer is rejected and recorded |
| `tools.pipeline.ask_expiry_is_denial` | unanswered `ask` ⇒ `denied`/`denied_by_grant_expired` ⇒ no lease |
| `tools.pipeline.lease_single_use` | R-tools-32: the same lease used twice (retry, subagent, resume) ⇒ second use denied |
| `tools.pipeline.lease_scope_confinement` | R-tools-33/R-tools-56: an effect outside the lease scope fails and is recorded as a policy violation |
| `tools.pipeline.kill_after_effect_is_unknown` | R-tools-36: kill the process after the side effect but before the result ⇒ `UNKNOWN`, reconcile, and **no** success receipt |
| `tools.pipeline.evidence_disagreement` | R-tools-36: harness says ok, host evidence disagrees ⇒ `UNKNOWN` |
| `tools.pipeline.retry_rules` | R-tools-35: `at-most-once`/`unknown` tools are never auto-retried after `execute`; `keyed` retries only with the same key |
| `tools.pipeline.cancel_settles` | R-tools-40: cancellation always ends in a terminal outcome, never silence |
| `tools.posture.plan_mode_blocks_mutation` | §4.6: in plan mode a mutating call is denied by the kernel with a model-visible reason |
| `tools.posture.workspace_narrows_only` | R-tools-23/§4.7: a workspace config that widens ⇒ parse fails closed; one that narrows ⇒ applied |

### 11.4 Rendering, output, errors

| Test id | Proves |
|---|---|
| `tools.render.byte_stable` | R-tools-41: identical inputs ⇒ byte-identical model rendering (run twice, compare hashes) |
| `tools.render.human_not_model_visible` | R-tools-41: the human rendering never appears in a later provider request |
| `tools.render.truncate_lossless_resume` | R-tools-43/44: `nextOffset` pagination reconstructs the original bytes exactly (no gap, no overlap) |
| `tools.render.no_base64_inline` | R-tools-45: image/audio/video payloads become artifact/attachment refs; a golden request dump contains no base64 blob |
| `tools.render.budget_enforced` | R-tools-42: a 1 MiB `grep` result is capped at 16 KiB model-facing with a working artifact pointer |
| `tools.errors.per_class` | §7.2: one test per tool class × category, asserting the `retryClass` and the settlement semantics (a `non-zero exit` is a result; `refused_by_policy` is terminal; `Conflict` mutates nothing) |
| `tools.errors.typed_detail` | §7.3: every category's `detail` matches its declared shape; free-form extras are rejected |

### 11.5 Authority boundaries and integration

| Test id | Proves |
|---|---|
| `tools.boundary.child_construction` | README §3.1/§4.6: all subagent creation (`task`, `fleet`, `parallel_tasks`, `read_only_task`, `team_create`, `workflow`, `remote_trigger`) funnels through one primitive; the test fails if a second path spawns a child |
| `tools.subagent.grant_subset` | §8.4: `GrantExceedsParent` before spawn; a child never sees the parent's leases |
| `tools.subagent.unknown_propagates` | a child `UNKNOWN` effect makes the parent's verification verdict `partial` |
| `tools.mcp.untrusted_fence` | §9.4: MCP tool descriptions cannot alter the tool set, posture or presets, and are rendered as fenced data |
| `tools.skill.unverified_trust` | §4.5: an unverified skill installs with `trust: 'unverified'`, a reduced tool set and a banner |
| `tools.perf.pipeline_budget` | §10.1: the recorded per-call overhead stays within the p95 budgets on a fixture workload (a perf ratchet; a regression fails) |
| `tools.gate.no_unbounded_flag` | the gate exposes no `--force`/`--skip`; the CLI surface is asserted to lack it (§7.1) |

---

## 12. Status

Levels per `_conventions.md` §8. **This document is `DESIGNED` as a specification claim.** **Implementation status (refreshed to the code):** 18 tools are registered in `app/src/tools/index.ts` and are TESTED; evidence in `28-implementation-status.md`, which is the single source of truth. The other tools of the 94-name catalog in §4 and every symbol in this document not backed by a file under `app/src/tools/` remain design.

| Capability | Level | Evidence |
|---|---|---|
| `ToolDeclarationV1` anatomy and mandatory fields | DESIGNED | §2.1, §3.1, §11.1 |
| Declaration generation from one source of truth + completeness gate | DESIGNED | §2.2, §11.1 |
| Registry, namespace ranks, resolution algorithm | DESIGNED | §2.3, §3.2, §11.2 |
| `tool_search` deferred discovery and admission | DESIGNED (reduced form TESTED — §2.4.1, FEAT-002: additive `Tool.exposure`/`searchInfo`, data-driven `tool_search`, per-session discovery; `preview` ships Deferred) | §2.4, §2.4.1, §3.3, §11.2; `docs/28` ruling 45 |
| Execution pipeline + per-stage fail-closed rules | DESIGNED | §2.5, §3.4, §7.1, §11.3 |
| Settlement, `UNKNOWN` and reconciliation hand-off | DESIGNED | §2.5 (R-tools-36/37), §7.1, §11.3 |
| Origin typing (`SessionBatch` / `UserAction` / `ManagedRun` / `ManagedRoot`) | DESIGNED | §2.5 (R-tools-38), §9.5 |
| Rendering contract, truncation, pagination, caps | DESIGNED | §2.6, §3.6, §10.2, §11.4 |
| Error semantics per tool class | DESIGNED | §2.7, §7.2, §7.3, §11.4 |
| Full catalog (92 rows / 94 tools), capability/effect/permission/lease binding | DESIGNED | §4, §4.9, §11.2 |
| Deliberate omissions | DESIGNED | §5 |
| Schema usage per family | DESIGNED | §6 |
| Flows (generic, edit-conflict, shell-approval, subagent) | DESIGNED | §8 |
| Security and authority narrowing | DESIGNED | §9 |
| Performance budgets | DESIGNED (targets, unmeasured) | §10 — explicitly **not** measured; a measurement would be `UNKNOWN` today |
| Test suite, including the completeness gate | DESIGNED | §11 — no test exists yet |
| Shipped reduced-form tools (base seven + `undo`, `repo_map`, `agent`, `code_mode`, `preview`, `apply_patch`, `shell_session`, `lsp`, `tool_search`, `ast_*`, deferred `debug`/`memory_search`) | TESTED (`docs/28` §1) | every tool has an admission; `apply_patch` model-routed; `debug` DAP PARTIAL; toolconv dialects PARTIAL |

**Known unknowns (stated, not implied).**

- Every performance number in §10 is a target. **UNKNOWN**: they have not been measured.
- The exact split of work between `@horizoncode/tools` (TS) and the native crates (`hz_shell`, `hz_edit`, `hz_vcs`, …) is described by intent here; the concrete call boundary is decided in `04-lld.md`.
- MCP `readOnlyHint` coverage across real servers is **UNKNOWN**; the design's answer is the conservative default of §2.3 (R-tools-19).
- Whether any single tool can be strictly `parallel_safe` in the presence of simultaneous human edits is **UNKNOWN**; the pipeline's per-scope ordering (R-tools-39) plus preimage hashes is the current answer, and it is a hypothesis to be tested.
- Skill/plugin contributed tools are designed to enter through the same pipeline; no upstream repo was surveyed deeply enough to claim the pattern is field-proven — see the sources in §1 for what was actually read.

---

> **Session fork (`docs/28` ruling 59).** Forking adds no tool and no admission kind: it is a user action (slash command or server method) that copies settled transcript rows. A fork's tool-call groups are never split; the copy starts at a safe boundary.

> **Guardian surfacing (`docs/28` ruling 60).** No tool or admission kind is added; the guardian only annotates the approval of an already-asked action.

---

## Provenance (what was taken from where)

This section records, for the tool plane, which designs and which bytes came from other repositories, with exact GitHub URLs at the commit that was read. It is a handoff aid. It does not change any status level; `docs/28-implementation-status.md` is the only place that may claim a level above DESIGNED, and the shipped tool count is whatever `app/src/tools/index.ts` registers (18 at the time of writing).

Reading the tables:

- URLs point at a file at the full 40 character SHA from [`research/upstream-pins.md`](research/upstream-pins.md). Each path was checked with `git ls-files` in the read-only clone before it was written. Anything not checkable is written `path not verified`.
- **Relation**: **copied verbatim** (bytes or literal values), **ported** (logic re-implemented line for line, behaviour kept), **adapted** (mechanism re-implemented with deliberate differences), **idea only** (concept informed a clean implementation).
- Judged from the header comments of the HorizonCode files, the docs/28 rulings and reading both sides. If a code header does not cite the upstream, the row says so.
- Licences found in the clones: cline, codex, forgecode Apache-2.0; deepseek-harness, oh-my-pi, opencode MIT; grok-build and claude-code have their own `LICENSE` files not analysed here. The worktree has no `LICENSE` or `NOTICE`; attribution for verbatim and ported rows is an OPEN item for the human owner.
- Wider context: [`research/`](research/README.md) and [`30-steal-list.md`](30-steal-list.md).

| # | HorizonCode file(s) | Upstream exact URL(s) at the pinned SHA | Relation | Notes |
|---|---|---|---|---|
| 1 | `app/src/tools/index.ts` (registry, `toolSpecs`, `discoverDeferredTools`), `app/src/tools/tool-search.ts`, `app/src/contracts.ts` (`Tool.exposure`, `Tool.searchInfo`, additive) | [`codex-rs/core/src/tools/registry.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/registry.rs)<br>[`codex-rs/core/src/tools/router.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/router.rs) | adapted | Exposure classes (`Direct`, `Deferred`, ...) plus a data-driven `tool_search` meta-tool that scores each Deferred tool's `searchInfo` and records the discovery per session. Only `preview` ships Deferred today. codex has six exposure classes including `CodeModeOnly` and `Hidden`; HorizonCode carries the two it needs. Docs/28 ruling 45. |
| 2 | `app/src/tools/edit.ts` (`normalizeForMatch`, unicode-fold rung) | [`codex-rs/apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/seek_sequence.rs) | copied verbatim (the folded code point set) | The set of folded code points (smart single and double quotes, typographic dashes, the space family) is lifted verbatim from codex `seek_sequence.rs`; the `edit.ts` header says so. The rung is placed between indent-normalised and the looser trim/anchor rungs and, like every fuzzy rung, applies only on a UNIQUE match under the read plus reflection gate. License: Apache-2.0. Ruling 41. |
| 3 | `app/src/tools/edit.ts` (CRLF-safe LF-view matching, per-region ending preservation, miss hint) | [`packages/core/src/tool/plugin/edit.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/plugin/edit.ts) | adapted | The `edit.ts` header cites opencode `withRegionEndings`; the vote-based 'closest numbered lines' miss hint and the 'newString already present, edit may already be applied' branch come from the opencode `missHint` (docs/30 section 5.1). Offsets map back to original bytes through removed-CR positions. The miss hint is gated on the read permission, as upstream does. License: MIT. Ruling 41. |
| 4 | `app/src/tools/edit.ts` (named thresholds `DEFAULT_FUZZY_THRESHOLD` ... `DOMINANT_FUZZY_DELTA`, `MAX_RECORDED_MATCHES`, preview constants) | [`crates/pi-edit/src/fuzzy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/fuzzy.rs) | copied verbatim (constant values only) | Values 0.95, 0.92, 0.8, 0.8, 0.92, 0.97 with delta 0.08, `PARTIAL_MATCH_MIN_LENGTH`, `PARTIAL_MATCH_MIN_RATIO`, `MAX_RECORDED_MATCHES = 5` (5 context lines, 80 chars). IMPORTANT: the similarity constants are declared but NOT wired into any scoring path, because HorizonCode's ladder is structural (windows equal and unique) and a score path would change which matches apply. They are a documented prior for a future score-based rung. Only the feedback constants ARE wired, into the miss-feedback previews. License: MIT. Ruling 41. |
| 5 | `app/src/tools/line-endings.ts`, `app/src/tools/write.ts` (line-ending normalisation) | [`sdk/packages/core/src/extensions/tools/executors/line-endings.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/line-endings.ts) | adapted | Shared LF-view contract for `edit` and `write`. DIVERGENCE recorded in the header: cline forces CRLF for new files on Windows from `os.EOL`; HorizonCode does not gate on `os.EOL`, a new file takes the ending its own content chose, default LF. opencode reached the same conclusion independently. |
| 6 | `app/src/tools/apply-patch.ts`, `app/src/tools/apply-patch-parser.ts` | [`sdk/packages/core/src/extensions/tools/executors/apply-patch.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts)<br>[`sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/executors/apply-patch-parser.ts)<br>[`codex-rs/apply-patch/src/parser.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/parser.rs)<br>[`codex-rs/apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/apply-patch/src/seek_sequence.rs) | adapted (parser, apply path), copied verbatim (grammar markers and fuzz cost numbers) | The grammar markers (`*** Begin Patch`, `*** End Patch`, `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`, `@@`) are exact, as the parser header states. The graded fuzz costs 0 / 1 / 100 / 1000 plus 10000 for the EOF-anchored retry follow cline's ladder (see the comparison in `research/compare-cline-claude.md` section A.5); the Levenshtein rung threshold 0.66 and the 'unmatched chunk is a warning' behaviour are cline's. HorizonCode re-implements it and routes EVERY file op through the guard, approval, sha256 preimage check, `protectedTarget` and `writeAtomic`. NAMED RESIDUAL: no cross-op atomicity (earlier ops stay written). Apache-2.0 on both upstreams. Docs/28 status row 'apply_patch + model to tool routing'. |
| 7 | `app/src/tools/model-tool-routing.ts`, `app/src/tools/index.ts` | [`sdk/packages/core/src/extensions/tools/model-tool-routing.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/model-tool-routing.ts) | adapted | Reduced form of cline's `ToolRoutingRule` plus `resolveToolRoutingConfig`: case-insensitive substring match on model id and provider id, ENABLE WINS OVER DISABLE. Default rule routes the GPT/Codex family to `apply_patch` and the find/replace `edit` away. TS-side visibility only, not an authority decision. DEFERRED: grok-build multi-dialect aliases (see below). |
| 8 | `app/src/core/instructions.ts` (family blocks, `gpt-codex-apply-patch`) | [`codex-rs/prompts/src/model_instructions.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/src/model_instructions.rs)<br>[`codex-rs/core/gpt-5.2-codex_prompt.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/gpt-5.2-codex_prompt.md) | idea only (selection), adapted (the apply_patch grammar block) | Per-model prompt block selected from model metadata, fail-soft. codex ships a full prompt file per model family; HorizonCode ships one block (the exact `apply_patch` grammar) for the GPT/Codex family. The prompt text itself is HorizonCode's. Base prompt wording (`core/prompt/sections.ts`) lists codex, opencode, cline, oh-my-pi, deepseek-harness and grok-build as studied references; no text was copied. |
| 9 | `app/src/tools/shell.ts` (interceptor rules, `skipShellWord`, `withoutLeadingEnvironmentAssignments`, `extractFlatShellCommandSegments`, candidates, rule matching) | [`packages/coding-agent/src/tools/bash-interceptor.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/bash-interceptor.ts)<br>[`packages/coding-agent/src/exec/settings.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/exec/settings.ts) | ported (functions marked 'ported verbatim' in the file) and adapted (default rule table) | `skipShellWord` is labelled 'Ported verbatim' in the source. `BashInterceptorRule` mirrors the omp type. The default table is scoped to dedicated tools HorizonCode ships; the `cat`/`head`/`tail` to `read` rule is intentionally not in the table because the older single-operand interception owns it. Invalid regex patterns are skipped (omp parity). License: MIT. Docs/28 hardening rows (wave 12) and `tests/tools/shell-interceptor.test.ts`. |
| 10 | `app/src/tools/shell.ts` (output minimiser, 16 KiB cap, spill), `app/src/core/output-budget.ts` (`planToolOutputCap`, `writeSpillFile`) | [`packages/agent/src/output-budget.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/output-budget.ts) | adapted | Usage-anchored output-cap fit with a 16 token per message framing charge and an absolute headway, plus R-tools-42 caps (16 KiB, 4000 estimated tokens) with a lossless-resumable prefix and `nextOffset`. DIVERGENCES: HorizonCode uses an 8192 ceiling and 256 floor where omp uses `MIN_FITTED_OUTPUT_TOKENS = 1024`; token numbers are bytes/4 estimates, never accounting. Spills are 0700 dir, 0600 file. Cross-check list from docs/30 section 5.4 (skip-fit cases such as `stopsOutputAtContextWindow`) is only partly applied: the window table is local, not catalog-driven. Ruling 18. |
| 11 | `app/src/tools/interactive-exec.ts` (`shell_session`) | [`codex-rs/core/src/unified_exec/mod.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/unified_exec/mod.rs)<br>[`codex-rs/core/src/tools/mod.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/tools/mod.rs)<br>[`packages/coding-agent/src/tools/bash-interactive.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/bash-interactive.ts)<br>[`packages/coding-agent/src/tools/bash-pty-selection.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/bash-pty-selection.ts) | adapted | One tool with `mode: start\|write\|close` maps onto codex `exec_command` plus `write_stdin`. The output shape (`Exit code` or `Signal`, `Wall time` in 0.1 s steps, `Total output lines` only when truncated, then `Output:`) intentionally matches codex `format_exec_output_for_model`. PTY selection is capability-detected through util-linux `script`, opt-out env `HZ_NO_PTY=1` (omp has `PI_NO_PTY`). DIVERGENCES: every `write` is re-admitted per input line as a `shell.exec` effect (ruling 55), control characters in input are refused, and codex's cached no-sandbox retry on sandbox denial is NOT implemented. Named residual: a `setsid()` descendant escapes the group kill. |
| 12 | `app/src/tools/hashline.ts`, `app/src/tools/read.ts` (opt-in anchors), `app/src/tools/edit.ts` (`resolveAnchor`) | [`crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs) | adapted | Anchor `LINE:LOCAL:CONTEXT`. HorizonCode uses FNV-1a (as grok's code also does for its fingerprints) but a deliberate variant: LOCAL is three letters over the line with all whitespace removed, CONTEXT hashes the neighbours' LOCAL hashes; `DEFAULT_SEARCH_RADIUS = 15`; Valid, Stale, OutOfRange, plus an explicit Ambiguous outcome; a truncated anchor is Stale. Grok's three schemes (ContentOnly, ChunkFingerprint over 16-line chunks, CheckpointChain) are NOT implemented. Anchors in `read` are off by default (ruling 64). License of grok-build: see its LICENSE (not analysed). |
| 13 | `app/src/tools/ast-match.ts`, `app/src/tools/ast-search.ts`, `app/src/tools/ast-edit.ts` | [`packages/coding-agent/src/tools/ast-grep.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/ast-grep.ts)<br>[`packages/coding-agent/src/tools/ast-edit.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/tools/ast-edit.ts) | idea only | omp wraps ast-grep over `crates/pi-ast`. HorizonCode keeps zero runtime dependencies, so the primary backend is its own token-level matcher with an ast-grep style metavariable dialect (`$NAME`, `$$$NAME`, same-metavariable identity). An external `ast-grep` binary is only a capability-detected accelerator launched through the guarded spawn path. `ast_edit` mirrors `edit` write discipline exactly (read gate, sha256 preimage, atomic write, journal). Ruling 49. |
| 14 | `app/src/tools/lsp.ts`, `app/src/core/lsp/client.ts`, `app/src/core/lsp/mux.ts`, `app/src/core/lsp/framing.ts`, `app/src/core/lsp/workspace-diagnostics.ts` | [`packages/coding-agent/src/lsp/writethrough.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/writethrough.ts)<br>[`packages/coding-agent/src/lsp/client.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/client.ts)<br>[`packages/coding-agent/src/lsp/lspmux.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/lspmux.ts)<br>[`packages/coding-agent/src/lsp/diagnostics.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/diagnostics.ts)<br>[`packages/coding-agent/src/lsp/workspace-diagnostics.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/workspace-diagnostics.ts) | adapted (reduced) | Reduced v1: one read-only op `diagnostics`. Freshness is by EXACT document version match, a server start is admitted as a `spawn` GuardAction BEFORE any process exists and goes through `spawnOwned`, a missing or failing server degrades to a no-op. omp's tsserver reload trick, grace-window constants, DAP and the other ops (`edits.ts`, `format-options.ts`, `batch.ts`) are not implemented. Docs/28 status row 'LSP loop + diagnostics ledger v1'. |
| 15 | `app/src/core/diagnostics-ledger.ts` | [`packages/coding-agent/src/lsp/diagnostics-ledger.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/lsp/diagnostics-ledger.ts) | ported (behaviour), re-implemented dependency-free | `diagnosticIdentity` strips the leading `file:line:col ` prefix; per `(instance, file)` seen-set that is REPLACED, not unioned, so a diagnostic that disappears and reappears is fresh again. Works on `string[]`, so it also serves tsc or linter output. The header does not cite omp, but the mechanism and name are the omp ledger (docs/30 section 5.4 row 'Diagnostics-ledger'). |
| 16 | `app/src/tools/repo-map.ts`, `app/src/tools/repo-map-cache.ts` | aider: repo map: def/ref graph, personalised PageRank, token-budget binary search, `docs/30` B-1, `docs/audit/pass3/audit-aider-report.md` item 5 (repo not cloned, path not verified) | adapted | Same algorithm family: damping 0.85, personalisation on focus files, aider multipliers 10x (out-edges of focus files) and 50x (idents defined in focus files), render cut by binary search on the token budget (default 4000, hard 16000). Differences: no tree-sitter, definitions by per-language lexical patterns, no embeddings. The persistent cache (`<state root>/repo-map/index.json`, `size:mtimeMs`) is HorizonCode's own and does not change the rendered map. No aider code could be compared in this sandbox. Ruling 19. |
| 17 | `app/src/tools/read.ts`, `app/src/tools/read-ledger.ts`, `app/src/tools/edit.ts` (read gate) | [`crates/pi-edit/src/path_policy.rs`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/crates/pi-edit/src/path_policy.rs) | idea only (convergent) | Read-before-write: `write` and fuzzy `edit` rungs require the session to have read the file; only `read` writes the ledger, because `grep` and `repo_map` return fragments (audit finding 2, `docs/audit/`). omp enforces read-before-write inside its edit engine. Original code. |
| 18 | `app/src/tools/codemode.ts`, `app/src/tools/codemode-child.ts` | [`codex-rs/code-mode-host`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/code-mode-host)<br>[`packages/core/tool-executor-ptc/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tool-executor-ptc/README.md) | idea only | `code_mode` runs a JS program in a Bun subprocess whose only path to tools is `tools.call`, each call re-entering the guard with the digest of the exact arguments and leaving a receipt. Keyed NDJSON control frames (ruling 25) are original. The dsh PTC call-allowance tied to timeout is DEFERRED (docs/30 section 5.7 Tier 1). |
| 19 | `app/tests/tools/tool-schema-snapshot.test.ts` | [`crates/forge_domain/src/tools/snapshots/forge_domain__tools__catalog__tests__tool_definition_json.snap`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/snapshots/forge_domain__tools__catalog__tests__tool_definition_json.snap) | adapted | forge snapshots every tool's JSON schema; HorizonCode serialises every builtin (name, description, schema with recursively sorted keys, exposure, batch class) and diffs it. Cheap first half of the designed cache-guard prefix test (docs/10 R65). Ruling 68, forgecode take T-2. |
| 20 | `app/src/core/mcp/index.ts`, `app/src/core/mcp/client.ts`, `app/src/core/mcp/registry.ts` | [`packages/core/src/tool/mcp.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/mcp.ts)<br>[`packages/core/src/mcp/client.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/mcp/client.ts) | idea only | Stdio JSON-RPC only, spawned through `spawnOwned`, admitted as `spawn` with digest `mcp <serverId> <sha256(command,args)[0..16]>`, user-config servers only (no workspace path: no trust store yet). Docs/30 section 5.1 cites `packages/core/src/tool/plugin/mcp.ts` for debounced reconcile, binary-resource spill and schema-gated JSON parse; that exact path does NOT exist at the pinned SHA, the closest are the two linked files, so those cited behaviours are UNVERIFIED and not implemented. Ruling 34. |
| 21 | `kernel/src/execpolicy.rs`, `kernel/src/guard.rs` (allowlist consult before policy rules) | [`codex-rs/execpolicy/src/policy.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/execpolicy/src/policy.rs)<br>[`codex-rs/execpolicy/src/rule.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/execpolicy/src/rule.rs)<br>[`codex-rs/execpolicy/src/amend.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/execpolicy/src/amend.rs)<br>[`codex-rs/execpolicy/src/decision.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/execpolicy/src/decision.rs) | adapted | Authority half of the `shell` tool (owned by docs/11). Pure-logic allowlist: `PrefixRule` and `NetworkRule`, order-independent `fingerprint()` (hashed through HorizonCode's own `canon` canonical JSON plus sha256, NOT a new scheme), runtime `amend` under a file lock, and codex R8 'a rule that does not pass its own examples is refused'. Differences: precedence is most-restrictive-wins (`Deny > Ask > Allow`), and with no allowlist file `shell.exec` behaves as before (ask). Ruling 42. Not an OS sandbox. |
| 22 | `kernel/src/egress.rs`, `kernel/src/guard.rs` (`net.fetch` decider), `app/src/contracts.ts` (`EGRESS_*` constants) | [`crates/codegen/xai-grok-egress-proxy/src/decider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/decider.rs) | ported (decision model and constants), adapted (everything else) | Four outcomes `Allow \| Deny \| Ask \| AllowAndRecord{would}`, observe mode, deny-by-default per origin, two-level hold budget with the grok constants (`DEFAULT_MAX_HELD = 16`, per call 8, hold timeout 600 s, `BLOCKED_REQUEST_CAPACITY` 256), content-free blocked-request records. SCOPE: the decider and its policy only. DEFERRED and recorded as residuals in docs/28 ruling 43: real connection parking, the routed MITM proxy, DNS pinning and rebind re-check. Nothing is enforced at the network layer today. |
| 23 | `kernel/src/sandbox.rs`, `app/src/contracts.ts` (`SandboxMode`) | [`packages/sandbox/sandbox/src/escalation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/src/escalation.ts)<br>[`packages/sandbox/sandbox/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/README.md) | copied verbatim (the two model-facing marker strings), adapted (the mode ladder) | `sandbox_denial_marker` and the escalation hint are reproduced byte for byte from dsh `escalation.ts` as quoted in `research/compare-ohmypi-deepseek.md` section 2.4 (the hint keeps the source's em dash on purpose: it is model-facing text). The ladder `read-only \| workspace-write \| danger-full-access` FAILS CLOSED with `SANDBOX_UNAVAILABLE`; `kernel_applied_mechanisms` are all false because no Landlock ruleset, seccomp filter, netns or rlimit is applied anywhere in the kernel. HONEST REPORTING invariant: nothing is reported as enforced. codex `linux-sandbox` (`seccomp.rs`, `bwrap.rs`) is the reference for the DEFERRED real confinement, see `docs/audit/landlock-spike-2026-11-08.md`. Ruling 44 and 51. MIT. |
| 24 | `app/src/core/commit.ts`, `app/src/main.ts` (`hzcode commit`) | [`templates/forge-commit-message-prompt.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/templates/forge-commit-message-prompt.md) | adapted | Staged diff (argv spawn, capped 24000 chars) goes to one ordinary model turn with a fixed prompt; the commit runs through the guard as `shell.exec` with a receipt; optional `HZ-Receipt` trailer is original (not in any source). Ruling 83, take T-16. |
| 25 | `app/src/core/doctor.ts`, `app/src/main.ts` (`doctor`) | [`shell-plugin/doctor.zsh`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/shell-plugin/doctor.zsh)<br>Grok `/doctor`: [`crates/codegen/xai-grok-pager/src/doctor_cmd/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/mod.rs), [`src/slash/commands/doctor.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/doctor.rs) | idea only | Diagnose-only environment report with OK / WARN / FAIL and fix hints, never prints a key, never claims sandbox enforcement. forge's doctor is a zsh environment check; the Grok `/doctor` source is linked in this row (an earlier note that it had not been located is obsolete). Ruling 71, take T-10. |
| 26 | `app/src/core/commands.ts`, `app/src/core/skills.ts`, `app/src/core/convo.ts` | [`.forge/commands/check.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/.forge/commands/check.md)<br>[`.forge/skills/create-plan/SKILL.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/.forge/skills/create-plan/SKILL.md)<br>[`mods/agents-md`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68/mods/agents-md) | idea only | Custom slash commands as markdown files with `{{args}}` or `$ARGUMENTS` (the latter named in the header as Claude Code style), skill folders `skills/<name>/SKILL.md`, foreign read-only skill sources `~/.agents/skills`, `~/.claude/skills`, `<ws>/.claude/skills`. Skills and commands are prompt text and carry NO authority. Symlinks are refused by the prompt readers (ruling 79). Rulings 77, 78, 80, takes T-12, T-13, T-14. The `/rename /retry /stats /export /copy` verbs have no specific forgecode file linked (path not verified). |
| 27 | `docs/32-plan-files.md`, `app/src/core/skills.ts` (`execute-plan` built-in skill) | [`.forge/skills/create-plan/references/plan-template.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/.forge/skills/create-plan/references/plan-template.md)<br>[`plans/2025-04-02-system-context-rendering-v1.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/plans/2025-04-02-system-context-rendering-v1.md) | idea only | `.hz/plans/<date>-<slug>-vN.md` convention with `- [ ]` tasks and a verification list. Ruling 82, take T-19. |
| 28 | `app/src/tools/todo.ts`, `app/src/tools/undo.ts`, `app/src/tools/change-journal.ts`, `app/src/tools/atomic-write.ts`, `app/src/tools/preview.ts`, `app/src/tools/glob.ts`, `app/src/tools/grep.ts`, `app/src/tools/ignore.ts` | none claimed | idea only (no specific upstream) | These are original or generic. `undo` restores from a durable change journal (ruling 36); atomic write is temp file plus rename; `preview` is a session-scoped dev-server lifecycle. No upstream file was identified as a source. The docs/09 catalog still lists 94 tool names; 18 are registered. |


### Sources that could not be linked

aider (`docs/audit/pass3/audit-aider-report.md`, 35 items), mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 were audited from clones that are not in the current sandbox. See the 'Not cloned' table in [`research/upstream-pins.md`](research/upstream-pins.md). Their items in `docs/30-steal-list.md` stay as report pointers until the owner re-clones them and pins a SHA.


### Deferred or not started, with reasons

| Item | State and reason |
|---|---|
| Most of the 94-tool catalog (docs/09 section 4) | Only 18 tools are registered: `read write edit grep glob shell todo undo repo_map agent code_mode preview apply_patch shell_session lsp tool_search ast_search ast_edit`. The rest are DESIGNED only. `app/tests` has a catalog coverage test for what exists, not for the full 94. |
| `debug` / DAP tool | PARTIAL — TESTED (`app/src/tools/debug.ts`, `core/dap/*`; launch/attach/step/stack; hermetic TCP e2e ruling **182**; live dlv/js-debug e2e open). Reference: [`packages/coding-agent/src/dap/session.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/session.ts). |
| Multi-dialect tool aliases (`codex` / `opencode` / `claude` over one taxonomy) | DEFERRED (docs/30 section 5.5). Reference: [`crates/codegen/xai-grok-tools/src/implementations/codex`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/codex) and [`crates/codegen/xai-grok-tools/src/implementations/opencode`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/implementations/opencode) are the per-dialect directories that exist at the pin; the files docs/30 names (`claude_alias.rs`, `tool_taxonomy.rs`) were NOT found by those names in the clone, path not verified. Model-to-tool routing (above) covers the one dialect that matters today. |
| Per-sub-command shell risk scoring and durable resource-scoped grants | DEFERRED. References: [`crates/codegen/xai-grok-permission-rules/src/bash_command_splitting.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-permission-rules/src/bash_command_splitting.rs), [`crates/codegen/xai-grok-permission-rules/src/exec_risk.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-permission-rules/src/exec_risk.rs), [`packages/core/src/permission/saved.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission/saved.ts). Today a compound shell line is approved as one string; the kernel allowlist (`kernel/src/execpolicy.rs`) judges by command prefix. |
| cline command-guard for a read-only lane | PARTIAL (ruling 219: `app/src/core/command-guard.ts` wired in plan-mode `loop.ts`; read-only still refuses all `shell`). Reference: [`sdk/packages/core/src/extensions/tools/command-guard.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/command-guard.ts). Residual: full subcommand table, kernel `guard.rs` parity. |
| Negative-offset tail read and rope paging | DEFERRED. `read` takes a 1-based `offset` only. Reference: [`packages/core/src/tool/read-filesystem.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/read-filesystem.ts). |
| Batch-tolerant `read` and hardened clarify/terminal tools | PARTIAL (ruling 226: `paths[]` per-item results). Reference: [`sdk/packages/core/src/extensions/tools/definitions.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/extensions/tools/definitions.ts). Residual: clarify/terminal hardening; JSON Schema oneOf. |
| Interpolating the concrete OS/shell into the shell tool description | DEFERRED. Reference: [`packages/core/src/tool/plugin/shell.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/plugin/shell.ts). |
| Invalid-tool-JSON replay (paired synthetic result carrying the raw input) | DEFERRED as written; the loop instead repairs syntactic defects (json-repair.ts) or exits via the format-error cap. Reference: [`packages/ai/src/loop.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/ai/src/loop.ts). |
| Four-stage tool pipeline with conditional tools and per-agent masks | DEFERRED. Reference: [`packages/core/tools/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/README.md). Partial overlap: hooks `tool.pre`/`tool.post`, `Tool.exposure`. |
| Deliverables recorder (`present` tool) | DEFERRED. Reference: [`packages/deliverables/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/deliverables/README.md). |
| Cross-platform and OS-level confinement of tool execution | Not a tool feature; owned by `docs/11` and NF-016. `kernel_applied_mechanisms` stays all false, `sandbox.report` never claims enforcement. |
| aider-derived edit and git items: lint narrowing (F-1, F-3), dirty-commit-before-edit (E-1), commit attribution (E-2), LLM commit messages from conversation (E-3), relative-indent parity fixtures (A-5) | DEFERRED or partly folded into the edit ladder (A-1 to A-4 landed in the edit ladder, ruling 16). aider not cloned, path not verified. |
| forgecode take T-9 request-dump eval pack, T-15 worktree flag | DEFERRED; recorded in `docs/08-runtime.md` Provenance with reasons. |
