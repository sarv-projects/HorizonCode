# 15 — Extensibility

> Plugins, skills, commands, hooks, workflows, agent profiles, MCP, ACP and the IDE bridge — every way a user, a team or a third party adds behaviour to `hzcode`, and the authority arithmetic that keeps all of them inside the same constitution.

---

## 1. Purpose

This document decides how HorizonCode is extended:

1. **Plugins** — the manifest, the signature, the capability declaration, the sandboxed host, the lifecycle, versioning, failure isolation, permission prompts, marketplace rules, and how a plugin's tools become declarable `ToolDeclarationV1`s.
2. **Skills** — `SKILL.md`, front-matter, discovery and precedence, `run-as` semantics, tool allow-lists, lock and update, verification by evals, the bundled set, and the `skillify` synthesis flow.
3. **Commands** — prompt/local/rich variants, arguments, namespacing, discovery, and the built-in set.
4. **Hooks** — lifecycle points, ordering, failure semantics, and how a hook is sandboxed.
5. **The workflow engine (Rhai)** — script shape, host channel, cancellation, determinism, examples.
6. **Agent profiles** — the profile *contract* (capability presets, partition/owns rules, result schemas, tier policy) over the `kind` enum owned by `05-domain-and-schemas.md` §4.9, tool allow-lists, prompt files, registration.
7. **MCP** — client (transports, OAuth, discovery, deferred tool loading, sampling) and server (authority rules only; the exposure catalogue is `14-surfaces.md` §3.5).
8. **ACP and the IDE bridge** — methods, capability negotiation, session lifecycle, permission proxying, editor feature mapping, JWT auth, trusted device, attachments, diffs, and replay after a crash.
9. **Self-hosting config** — `.hz/` in a repository.
10. **The extension security model** — what a plugin can never do, how capability narrowing applies, and the boundary tests that keep it true.

Everything here is **DESIGNED** (§10) except the two v0.1 slices `28-implementation-status.md` records as VERIFIED — the skills loader and the subagent primitive — and that file owns every implementation level (RC-13). Nothing else here is a claim of working code.

### 1.1 The five extension surfaces and who owns them

| Surface | Contributes | Declared by | Authority mechanism |
|---|---|---|---|
| **Plugin** | tools, commands, hooks, skills, agents, providers, MCP servers, UI panels | `plugin.json` (signed) | capability declaration + `plugins.invoke` + sandboxed host |
| **Skill** | a workflow prompt, optionally a subagent run | `SKILL.md` front-matter | tool allow-list ∩ posture ∩ capability set |
| **Command** | a prompt, a local action, a rich panel | `commands/*.md` or a plugin | the effects it triggers, each through Guard |
| **Hook** | a lifecycle observation or a narrowing decision | `hooks/hooks.json` or settings | it may deny, never allow; sandboxed, receipted |
| **Workflow** | orchestration of already-authorised agents and tools | a Rhai script | no authority of its own — the effects it triggers are the effects of the sessions it drives |

Two invariants cut across all five:

> **An extension may add behaviour. It may never add authority.**
>
> **An extension's effects are the effects of the session that hosts it.** A plugin, skill, command, hook or workflow does not get its own principal; its effects carry its provenance and the hosting session's origins.

### 1.2 Where extensibility connects to the constitution

| Extension action | Capability ID | Origin | Receipt |
|---|---|---|---|
| plugin tool invocation | `plugins.invoke` (outer) + the inner canonical capability | `SessionBatch` + plugin provenance tag | `effect_receipt` naming plugin id, manifest digest, declared capability |
| skill invocation (inline) | `hz.skill.invoked` event; the skill's own tool calls carry their own capabilities | `SessionBatch` | one receipt per effect; the skill invocation is an event |
| skill invocation (`run-as: subagent`) | `agent.spawn` | `SessionBatch` | receipt + child session linkage |
| command execution | depends on the variant (prompt → no effect; local → named capability; rich → `ui.present` + whatever it triggers) | `UserAction` for the local mutation part | receipt per effect; `host_decision` for a denied command |
| hook execution | `terminal.run` under a hook profile | `SessionBatch` (host-initiated) | receipt per hook run |
| hook **denial** | `host_decision` record | — | `DENIED` receipt with `reason_code = hook_denied` |
| workflow host call | the underlying tool's capability | `SessionBatch` of the driving session | receipt per effect; workflow journal per step |
| MCP tool call | `mcp.invoke` | `SessionBatch` | receipt naming server identity, tool, argument digest, declared version |
| MCP server request (sampling/roots/elicitation) | `providers.infer` / `files.read` / `ui.present` | `ManagedRun` minted per server scope | receipt with the managed scope digest |
| ACP permission request | no effect of its own; it resolves a Guard challenge | — | approval recorded on the resulting receipt |
| IDE bridge diff accept | `files.patch` | `UserAction` | receipt |

### 1.3 Sources

```
source: /data/home/forge/hzcode/README.md
source: /data/home/forge/hzcode/docs/01-vision-and-superset.md
source: /data/home/forge/hzcode/docs/02-decisions.md
source: /data/home/forge/hzcode/docs/_conventions.md
source: /data/home/forge/hzcode/docs/11-authority-safety.md
source: /data/home/forge/repo-tour/claude-code/src/utils/plugins/schemas.ts
source: /data/home/forge/repo-tour/claude-code/src/types/plugin.ts
source: /data/home/forge/repo-tour/claude-code/src/types/command.ts
source: /data/home/forge/repo-tour/claude-code/src/types/hooks.ts
source: /data/home/forge/repo-tour/claude-code/src/schemas/hooks.ts
source: /data/home/forge/repo-tour/claude-code/src/skills/bundledSkills.ts
source: /data/home/forge/repo-tour/claude-code/src/skills/bundled/
source: /data/home/forge/repo-tour/claude-code/src/skills/loadSkillsDir.ts
source: /data/home/forge/repo-tour/claude-code/src/skills/mcpSkillBuilders.ts
source: /data/home/forge/repo-tour/claude-code/src/services/mcp/types.ts
source: /data/home/forge/repo-tour/claude-code/src/bridge/bridgeApi.ts
source: /data/home/forge/repo-tour/claude-code/src/bridge/trustedDevice.ts
source: /data/home/forge/repo-tour/claude-code/src/bridge/codeSessionApi.ts
source: /data/home/forge/repo-tour/claude-code/src/bridge/bridgeMain.ts
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-workflow/src/lib.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-hooks/src/
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-plugin-marketplace/src/
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-mcp/src/lib.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-acp-lib/src/lib.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/src/extensions/mod.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/src/agent/config.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/src/extensions/plugins.rs
source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-external-agent-migration/src/lib.rs
source: /data/home/forge/repo-tour/horizoncode/kernel/src/agent_profile.rs
source: /data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/acp/handshake.go
source: /data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/acp/clientio.go
source: /data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/acp/session.go
source: /data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/acp/dispatch.go
source: /data/home/forge/repo-tour/oh-my-pi/docs
source: /data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/tool_search.rs
source: /data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/request_permissions.rs
```

---

## 2. Rules

Numbered, individually testable. `MUST` = a violation is a defect; `SHOULD` = a violation needs a recorded waiver; `MAY` = permitted option. Each rule names the test that proves it (§9).

### 2.1 Plugins (X)

- **X1** A plugin **MUST** be identified by `id@marketplace` and **MUST** ship a manifest named `plugin.json` at its root (or be declared entirely by a marketplace entry with `strict = false`). *(T-X1)*
- **X2** The manifest **MUST** declare `manifestVersion`, `name`, `version`, `capabilities`, and `hz.minAbi`/`hz.minProtocol`; a missing field **MUST** refuse the load. *(T-X2)*
- **X3** The manifest **MUST** be signed with Ed25519 over a canonical encoding that includes a digest map of every file the plugin can load; a plugin whose files drift from that map **MUST** refuse to load. *(T-X3)*
- **X4** A plugin's `capabilities` **MUST** be the maximum set it can ever request; a runtime request for an undeclared capability **MUST** deny with `plugin_capability_undeclared`. *(T-X4)*
- **X5** The granted set **MUST** be `declared ∩ marketplace policy ∩ user policy ∩ workspace narrowing ∩ session posture`; a workspace layer **MUST NOT** widen it. *(T-X5)*
- **X6** Each plugin **MUST** run in its own host process (or a WASM module); a plugin **MUST NOT** load native code into the agent process. *(T-X6)*
- **X7** Every plugin effect **MUST** be admitted by Guard with `plugins.invoke` as the outer capability and the inner canonical capability recorded separately. *(T-X7)*
- **X8** A plugin host crash **MUST** isolate: the agent survives, in-flight calls settle as `FAILED` or `UNKNOWN`, and the plugin is quarantined after N restarts in a session. *(T-X8)*
- **X9** An update that changes `version`, `capabilities` or the signed file map **MUST** re-consent before the new version becomes active. *(T-X9)*
- **X10** An uninstalled plugin's version directory **MUST** be removed, its host stopped, and its installation tombstoned; installation state is never rewritten in place. *(T-X10)*
- **X11** Plugin contributions **MUST** be validated at load time into canonical declarations; a contribution that cannot be converted (e.g. a tool whose `capabilityId` is not in the granted set) **MUST** refuse the load rather than fail at call time. *(T-X11)*
- **X12** A plugin **MUST NOT** be able to observe or invoke another plugin's host, capabilities or state. *(T-X12)*

### 2.2 Skills (S)

- **S1** A skill **MUST** be a directory containing `SKILL.md` with YAML front-matter carrying at least `name` and `description`. *(T-S1)*
- **S2** A skill's front-matter **MUST** be parsed strictly; an unknown key in the *authority-relevant* set (`capabilities`, `allowed-tools`, `run-as`, `agent`) **MUST** refuse the skill. Presentation keys MAY be ignored with a warning. *(T-S2)*
- **S3** A skill's `capabilities` and `allowed-tools` **MUST** be treated as a request; the effective set is their intersection with the session's posture and grant. *(T-S3)*
- **S4** A skill **MUST NOT** widen the tool set of the turn; it may only narrow it for the duration of its run. *(T-S4)*
- **S5** `run-as: subagent` **MUST** construct the child through the single subagent primitive (ADR-016) with a capability grant that is the intersection of the parent's grant and the skill's request, an inherited budget, and a depth limit. *(T-S5)*
- **S6** A skill **MUST NOT** be able to escalate by declaring `run-as: subagent`, a larger budget, or a wider capability set; children are never wider than parents. *(T-S6)*
- **S7** Workspace skills **MUST** be namespaced (`project:<name>`) and **MUST NOT** shadow a user skill by bare name; a bare-name collision **MUST** be a typed error (`skill_name_ambiguous`). *(T-S7)*
- **S8** A workspace skill **MUST** require a trust record for its directory before it is offered to the model. *(T-S8)*
- **S9** `hzcode skill lock` **MUST** record name, version, source, and the digest of `SKILL.md` plus every bundled file; `hzcode skill update` **MUST** show a diff (including a prompt diff) and stage the change. *(T-S9)*
- **S10** A skill shared through a marketplace **MUST** be content-addressed and **MUST PASS** its own eval suite before it is offered; a synthesized skill **MUST** pass evals before it is offered at all. *(T-S10)*
- **S11** A skill's evals **MUST** run in a sandboxed worktree and **MUST** be receipted; an eval that mutates the real workspace is a defect. *(T-S11)*
- **S12** A skill **MUST NOT** be able to disable the evidence gate, the plan gate or the posture; a skill's instructions are content, not policy. *(T-S12)*

### 2.3 Commands (C)

- **C1** Three command variants **MUST** exist and **MUST** be distinguishable in the declaration: `prompt`, `local`, `rich`. *(T-C1)*
- **C2** A `prompt` command **MUST** produce prompt content and **MUST NOT** perform an effect directly. *(T-C2)*
- **C3** A `local` command **MUST** declare the capabilities it uses; each use is a normal Guarded effect. *(T-C3)*
- **C4** A `rich` command **MUST** declare a text/action projection so every front-end can render it; a rich command that exists only in the TUI **MUST** fail the parity ratchet. *(T-C4)*
- **C5** Argument interpolation (`$1..$9`, `$ARGUMENTS`, `${name}`) **MUST** be escaping-safe and **MUST NOT** re-enter a shell. *(T-C5)*
- **C6** A command that needs command substitution **MUST** declare `terminal.run` and perform the substitution as a receipted effect; implicit shell interpolation **MUST** be refused. *(T-C6)*
- **C7** A command name **MUST** be namespaced by source: `/<plugin>:<name>`, `/<project>:<name>`, `/<user>:<name>`, `/mcp:<server>:<prompt>`, and built-ins bare. A collision **MUST** be a typed error, never a silent preference. *(T-C7)*
- **C8** Command discovery **MUST** be deterministic and **MUST** be reported by `hzcode commands --sources`. *(T-C8)*
- **C9** A command's declared capabilities **MUST** be checked at load; a `local` command needing a capability the posture denies **MUST** be listed but refuse to run with a typed error. *(T-C9)*

### 2.4 Hooks (H)

- **H1** The hook points **MUST** be exactly: `session.start`, `session.end`, `prompt.submitted`, `step.start`, `step.end`, `tool.pre`, `tool.post`, `tool.error`, `effect.settled`, `commit.pre`, `commit.post`, `compact.pre`, `compact.post`, `error`, `checkpoint.created`, `session.rewound`. *(T-H1)*
- **H2** A hook **MUST NOT** be able to allow an effect; it may only deny, annotate, or observe. *(T-H2)*
- **H3** A hook that fails, crashes, times out, or returns an unclassified status at a deciding point (`tool.pre`, `commit.pre`) **MUST** be treated as a denial. *(T-H3)*
- **H4** At an observation-only point, a failed hook **MUST** be recorded as failed and **MUST NOT** block the step. *(T-H4)*
- **H5** Hook ordering **MUST** be deterministic: by declared priority, then declaration order, then name; all hooks for a point run within one shared deadline. *(T-H5)*
- **H6** A hook **MUST** run as a receipted `terminal.run` effect under a hook profile: cleared environment, workspace root as cwd, no network unless declared, read-only unless `files.write` was declared, bounded stdout/stderr, its own timeout. *(T-H6)*
- **H7** A workspace hook **MUST** require a trust record (path + digest) before it can run at all. *(T-H7)*
- **H8** A `tool.post` hook **MUST NOT** be able to undo or rewrite the effect it observed; it may raise a repair task. *(T-H8)*
- **H9** Hook output injected into the model context **MUST** be bounded, marked as untrusted content, and carried as a declared context fragment. *(T-H9)*
- **H10** An `async` hook **MUST NOT** be awaited on the critical path; its result attaches as a note and is receipted separately. *(T-H10)*

### 2.5 Workflows (W)

- **W1** A workflow **MUST** be a Rhai script with declared metadata (`id`, `version`, `params`) and a single entry point. *(T-W1)*
- **W2** A workflow **MUST NOT** be able to read or write the environment, the filesystem or the network directly; the host channel is the only ambient interface. *(T-W2)*
- **W3** Every host call that can vary (time, randomness, spawn result, tool result, human answer) **MUST** be recorded in a workflow journal and **MUST** be replayed from the journal on resume. *(T-W3)*
- **W4** A workflow **MUST** run with the capability ceiling of the run that started it; a workflow **MUST NOT** be able to exceed it. *(T-W4)*
- **W5** Cancellation **MUST** propagate: a cancelled run cancels in-flight children through the subagent primitive, settles the workflow as `FAILED(cancelled)`, and records which steps completed. *(T-W5)*
- **W6** A workflow that swallows a cancellation **MUST** be refused at run end (`workflow_swallowed_cancellation`). *(T-W6)*
- **W7** Workflow scripts **MUST** be deterministic given the journal: map iteration order **MUST** be explicit, and branching on floats **MUST** be refused. *(T-W7)*
- **W8** Every workflow step **MUST** be receipted; the workflow's own digest chain links the steps. *(T-W8)*

### 2.6 Agent profiles (A)

- **A1** The profile `kind` enum is owned by `05-domain-and-schemas.md` §4.9 and **MUST** be exactly `act`, `plan`, `research`, `verify`, `team_lead`, `custom`. This document adds no mode of its own; the four-mode list (`act`, `plan`, `research`, `custom`) is stale. *(T-A1)*
- **A2** A profile **MUST** declare a prompt source, a tool allow-list, `capabilityCeiling`, budgets and a subagent policy; the field names are `05-domain-and-schemas.md` §4.9's (`systemPrompt`, `toolAllowlist`/`toolDenylist`, `capabilityCeiling`, `budgetDefaults`, `canSpawn`/`spawnCeiling`). *(T-A2)*
- **A3** A profile's `capabilityCeiling` **MUST** only narrow relative to the session's grant; a profile **MUST NOT** widen. *(T-A3)*
- **A4** A `plan` profile **MUST** be read-only by construction: no `workspace-write`, no `process`, no `network` capability is granted. *(T-A4)*
- **A5** A `research` profile **MUST** be read-only plus `net.search` (and `net.fetch` only where policy permits). *(T-A5)*
- **A6** A custom profile **MUST** declare its owner binding; a user-owned profile is registered with an authenticated principal and the executor **MUST** match that principal. *(T-A6)*
- **A7** A task **MUST** pin an exact profile revision and definition digest; a profile edited after acceptance **MUST NOT** change a running task. *(T-A7)*
- **A8** A `requiresHumanApprovalFor` list **MUST** enforce a per-use challenge even under a posture that would otherwise allow the capability. *(T-A8)*
- **A9** Profile prompt files **MUST** be plain content: no embedded shell, no dynamic includes, no network fetch at load. *(T-A9)*

### 2.7 MCP (M)

- **M1** The client **MUST** support `stdio`, `sse`, and streamable `http` transports, plus a socket variant for IDE-class servers. *(T-M1)*
- **M2** An OAuth-protected server **MUST** use OAuth 2.1 with PKCE against its published protected-resource and authorization-server metadata; `authServerMetadataUrl` **MUST** be `https`. *(T-M2)*
- **M3** Tokens **MUST** be stored in the vault keyed by (server id, authorization server) and **MUST NOT** be written into config files. *(T-M3)*
- **M4** Exactly one refresh **MUST** be in flight per (server, auth server) at a time; a `401` **MUST** trigger at most one re-auth per session before failing with `mcp_auth_failed`. *(T-M4)*
- **M5** Tool, resource and prompt discovery **MUST** follow the server's advertised capabilities; the client **MUST NOT** call a method the server did not advertise. *(T-M5)*
- **M6** `notifications/tools/list_changed` **MUST** invalidate the cached catalog for that server. *(T-M6)*
- **M7** MCP tools **MUST NOT** be loaded into the prompt by default; they **MUST** be discoverable through `tool_search` and loaded only when selected. *(T-M7)*
- **M8** At most K (default 8) MCP tool declarations **MUST** be resident at once; exceeding K **MUST** evict LRU with an event and keep the prompt prefix byte-stable. *(T-M8)*
- **M9** An MCP tool call **MUST** be a `mcp.invoke` effect receipted with server identity, tool name, argument digest and the server's declared version. *(T-M9)*
- **M10** Server-initiated requests **MUST** require a host-minted managed run scope; `roots/list` **MUST** be answered only from a pinned read-only projection, and `elicitation/create` **MUST** be routed to a human, never auto-answered. *(T-M10)*
- **M11** Sampling **MUST** be off unless the server is declared as a managed component with an explicit budget; each sample is a `providers.infer` effect with the managed scope digest. *(T-M11)*
- **M12** Server-returned text **MUST** be framed as untrusted content: no instruction in it has authority. *(T-M12)*
- **M13** HorizonCode as an MCP server **MUST** default to a read-only posture plus explicitly granted tools (ADR-006). *(T-M13)*
- **M14** The MCP server **MUST** authenticate remote clients with audience-bound OAuth tokens and **MUST** receipt every call with the client identity. *(T-M14)*

### 2.8 ACP, the IDE bridge, and self-hosting (I, R)

- **I1** The ACP agent **MUST** implement `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`, and the client-side `fs/*` and `terminal/*` methods of the negotiated spec revision. *(T-I1)*
- **I2** The agent **MUST NOT** call a client method the client did not advertise; it **MUST** fall back to the kernel's own confined path and **MUST** record which path served it (`servedBy: client_fs | kernel_fs`). *(T-I2)*
- **I3** `session/request_permission` **MUST** be a projection of a Guard challenge; the response **MUST** be an *input* to the decision, never a token that bypasses the lease. *(T-I3)*
- **I4** `allow_always` from a client **MUST** create a bounded `DirectSessionGrant` (workspace-scoped, expiring, revocable) that still traverses Guard, lease and receipt for every covered effect. *(T-I4)*
- **I5** Posture **MUST** map to ACP modes (`read-only` ⇄ read-only mode, `workspace-write` ⇄ normal, `plan` ⇄ plan mode) and a mode change requested by the client **MUST** be subject to the same posture rules as a local change. *(T-I5)*
- **I6** The IDE bridge **MUST** authenticate with a short-lived JWT presented by a previously trusted device; the token **MUST** carry `session_id`, `workspace_root_digest`, `aud` and `jti`, and a token for one session **MUST NOT** act on another. *(T-I6)*
- **I7** Editor-supplied content (attachments, selections, diagnostics) **MUST** be bounded (default ≤ 4 MB per item, ≤ 8 items per prompt), hashed into the receipt, and framed as untrusted. *(T-I7)*
- **I8** A diff shown in an editor **MUST** be applied by a `files.patch` effect from a host-computed base digest; accepting a diff **MUST NOT** be an editor-side file write. *(T-I8)*
- **I9** After a bridge or leader crash, the bridge **MUST** replay `initialize` and each cached `session/load`/`session/new`, forwarding notifications and swallowing only the responses to the replayed requests, then emit the ACP extension notification `hz/reconnected` (the single name, declared in `14-surfaces.md` S97). *(T-I9)*
- **I10** An editor that has been disconnected longer than the replay window **MUST** be told to do a full `session/load`, never silently shown a partial history. *(T-I10)*
- **R1** `.hz/` **MUST** be able to declare agents, commands, skills, hooks, plugins, workflows, MCP servers and repo tests; the layout **MUST** be documented and stable. *(T-R1)*
- **R2** `.hz/` **MUST** be content, not authority: it may narrow policy and name programs, and nothing more (ADR-008, `11-authority-safety.md` §7.6). *(T-R2)*
- **R3** `.hz/` **MUST** be a protected sandbox subpath under `workspace-write`, so a running agent cannot rewrite its own configuration. *(T-R3)*
- **R4** Every program or server named by `.hz/` **MUST** be trust-on-first-use gated. *(T-R4)*
- **R5** Repo-defined tests in `.hz/tests/` **MUST** be usable as evidence by the evidence gate, and **MUST NOT** be able to override host-defined verification requirements. *(T-R5)*

### 2.9 Extension security model (Y)

- **Y1** A plugin, skill, command, hook, workflow or MCP server **MUST NOT** be able to obtain a kernel socket, a vault value, a raw `full-access` profile, an origin kind, or a policy write. *(T-Y1)*
- **Y2** Capability narrowing **MUST** be enforced twice: by the extension host before the request leaves it, and by Guard when the request arrives. *(T-Y2)*
- **Y3** Grants **MUST** be bounded by scope, use count and/or expiry, and **MUST** be invalidated by any relevant digest change. *(T-Y3)*
- **Y4** A boundary test **MUST** fail the build when a new caller of a single-construction primitive appears: subagent construction, effect submission, kernel request encoding, origin construction. *(T-Y4)*
- **Y5** A boundary test **MUST** assert that the set of origin kinds is exactly four and that no extension can construct one. *(T-Y5)*
- **Y6** An extension's declaration surface **MUST** be validated entirely at load; there **MUST NOT** be a runtime-only entitlement check. *(T-Y6)*
- **Y7** Self-improvement **MUST NOT** widen an extension's authority or the posture; a synthesized skill is verified through evals and remains subject to every rule here. *(T-Y7)*

---

## 3. Interfaces

### 3.1 `PluginManifestV1`

```jsonc
{
  "manifestVersion": 1,
  "id": "acme-lint@acme-registry",        // name@marketplace; both parts ^[a-z0-9][-a-z0-9._]*$
  "name": "acme-lint",
  "version": "1.4.0",                       // semver
  "publisher": { "name": "Acme", "email": "…", "url": "…", "keyId": "ed25519:…" },
  "description": "Lint rules and fixers for Acme projects",
  "homepage": "https://…", "repository": "https://…", "license": "MIT", "keywords": ["lint"],

  "hz": { "minAbi": 1, "minProtocol": 1, "minCliVersion": "0.4.0" },

  "capabilities": ["files.read", "files.patch", "terminal.run"],   // declared maximum (X4)
  "limits": { "maxProcesses": 4, "maxMemoryMb": 512, "maxWallClockMs": 30000, "maxOutputBytes": 1048576 },

  "entrypoints": { "host": "./dist/host.js", "runtime": "node20" },   // or "runtime": "wasm32-wasi"

  "contributes": {
    "tools":     [ /* ToolContributionV1 — §3.2 */ ],
    "commands":  [ /* CommandContributionV1 — §3.3 */ ],
    "hooks":     { "hooks": { "tool.pre": [ /* HookMatcherV1 */ ] } },
    "skills":    ["./skills"],
    "agents":    ["./agents/reviewer.md"],
    "providers": [ /* ProviderContributionV1: endpoint + codec id, never code */ ],
    "mcpServers": { "acme-docs": { "transport": "http", "url": "https://…" } },
    "ui":        { "panels": [ { "id": "lint-summary", "entry": "./ui/panel.js" } ] }
  },

  "config": {                                  // prompted at enable time
    "apiKey": { "type": "string", "title": "API key", "description": "…", "sensitive": true, "required": true },
    "projectRoot": { "type": "directory", "title": "Project root", "description": "…" }
  },

  "dependencies": [ { "id": "acme-core@acme-registry", "versionRange": "^2" } ],

  "files": {                                   // the signed closure (X3)
    "dist/host.js": "sha256:…",
    "ui/panel.js":  "sha256:…",
    "skills/lint/SKILL.md": "sha256:…"
  },

  "signature": { "alg": "ed25519", "keyId": "ed25519:…", "sig": "base64…" }
}
```

Signature preimage: `"hz.plugin.manifest.v1\0" || canonical_json(manifest_without_signature)`, where canonical JSON is sorted keys, NFC strings, no insignificant whitespace. Verifying the signature **and** every entry in `files` is required before any file is loaded (X3).

Config values are available to the plugin only as declared substitutions: `${config.apiKey}` inside its own MCP/LSP server config and hook commands, and as an opaque handle inside the host process. A `sensitive: true` value is never written to a settings file.

### 3.2 `ToolContributionV1` → `ToolDeclarationV1`

A plugin contributes a **declaration**, and the runtime compiles it into the same `ToolDeclarationV1` a first-party tool has (ADR-015):

```jsonc
// contribution
{
  "name": "fix_all",
  "description": "Apply every enabled fixer to the listed paths",
  "inputSchema": { "type": "object", "properties": { "paths": { "type": "array", "items": { "type": "string" } } },
                   "required": ["paths"], "additionalProperties": false },
  "outputSchema": { "type": "object", "properties": { "fixed": { "type": "integer" } } },
  "capabilityId": "files.patch",
  "effectClass": ["workspace-write"],
  "readOnly": false,
  "concurrency": "exclusive-per-path",
  "idempotency": "idempotent",
  "observation": "filesystem",
  "renderer": { "diff": true, "summary": "fixed {fixed} files" }
}

// compiled ToolDeclarationV1 (added fields marked +)
{
  "name": "plugin__acme-lint__fix_all",      // + namespaced
  "namespace": "plugin:acme-lint@acme-registry",  // +
  "provenance": { "kind": "plugin", "pluginId": "acme-lint@acme-registry",
                  "manifestDigest": "blake3:…", "publisherKeyId": "ed25519:…" },  // +
  "capabilityId": "files.patch",
  "effectClass": ["workspace-write"],
  "readOnly": false,
  "concurrency": "exclusive-per-path",
  "idempotency": "idempotent",
  "observation": "filesystem",
  "permissionRequirements": { "default": "ask", "posture": { "read-only": "deny", "workspace-write": "ask" } },  // +
  "promptFragment": "plugin:acme-lint",      // + kept out of the byte-stable prefix unless resident
  "telemetryFields": ["pluginId", "capabilityId", "phase"],  // +
  "inputSchema": { … }, "outputSchema": { … }
}
```

Load-time validation rules (X11):

| Check | Refusal code |
|---|---|
| `capabilityId` is in the canonical registry | `tool_capability_unknown` |
| `capabilityId` is inside the plugin's granted set | `tool_capability_not_granted` |
| an `effectClass` is declared for every class the capability implies | `tool_effect_class_incomplete` |
| `observation` is a known strategy for that capability | `tool_observation_unsupported` |
| the name does not shadow a first-party tool | `tool_name_reserved` |
| `inputSchema`/`outputSchema` validate and are bounded (≤ 64 KB each) | `tool_schema_invalid` |
| `readOnly: true` implies no `workspace-write`/`process`/`network` class | `tool_readonly_mismatch` |

### 3.3 `CommandV1`

```jsonc
{
  "name": "release-check",
  "namespace": "project",                    // builtin | user | project | plugin:<id> | mcp:<server>
  "kind": "prompt" | "local" | "rich",
  "description": "Verify a release candidate",
  "arguments": [ { "name": "tag", "hint": "v1.2.3", "required": true },
                 { "name": "dryRun", "type": "boolean", "default": false } ],
  "capabilities": ["terminal.run", "files.read"],   // required for local/rich (C3)
  "body": "…",                               // prompt text, or the local handler id, or the panel entry
  "projection": { "text": "Release check for ${tag}", "actions": ["run", "cancel"] },  // rich only (C4)
  "sources": [".hz/commands/release-check.md"]
}
```

Interpolation: `$ARGUMENTS` (all, raw), `$1..$9` (positional), `${name}` (declared). Values are inserted verbatim into *content* and are escaped at any boundary where they could become a command; a prompt command's interpolation never reaches a shell (C5).

### 3.4 `HookV1`

```jsonc
{
  "point": "tool.pre",
  "matcher": { "tool": "shell", "capability": "terminal.run",
               "if": "Shell(git *)" },          // permission-rule syntax (a filter, not an authority)
  "type": "command" | "http" | "plugin",
  "command": "./scripts/guard-git.sh",
  "priority": 100,
  "sync": true,
  "timeoutMs": 10000,
  "once": false,
  "asyncRewake": false,
  "capabilities": ["files.read"]              // beyond the read-only hook profile
}
```

Exit-code contract for deciding points:

| Exit | Meaning |
|---|---|
| `0` | pass-with-notes: the hook raises no objection (**it never allows anything** — H2); stdout is attached as a bounded note |
| `10` | ask: escalate to a human challenge |
| `20` | deny: refuse the tool call with `reason_code = hook_denied` |
| any other, a signal, a crash, or a timeout | **deny** at `tool.pre` and `commit.pre`; recorded-but-ignored at observation points (H3, H4) |

### 3.5 `WorkflowV1` (Rhai)

```jsonc
// header comment parsed as metadata
// @workflow id=release-fanout version=1
// @param tag string required
// @param reviewers int default=2
// @budget tokens=400000 wallClockMs=900000
```

Host channel functions (`ctx.*`) — the **only** ambient interface (W2):

| Function | Returns | Notes |
|---|---|---|
| `ctx.param(name)` | value | declared params only |
| `ctx.step(name, \|\| { … })` | step result | journaled boundary; a resume restarts from the last completed step |
| `ctx.spawn_agent(profile, opts)` | `AgentHandle` | goes through the single subagent primitive; grant narrowed |
| `ctx.send(handle, msg)` | `()` | durable message bus |
| `ctx.wait(handles)` | `Array<Outcome>` | journaled |
| `ctx.cancel(handle)` | `()` | propagates through the subagent primitive |
| `ctx.tool(name, args)` | `ToolResult` | a real Guarded effect; may deny |
| `ctx.ask_user(question, options)` | answer | journaled; in a non-interactive run it denies |
| `ctx.emit(kind, payload)` | `()` | a declared event kind only — canonical (`_conventions.md` §6) or a reserved `[planned]` name; an invented `hz.*` name is a load-time refusal |
| `ctx.budget()` / `ctx.remaining()` | `BudgetView` | read-only |
| `ctx.checkpoint(name)` | `()` | durable |
| `ctx.log(msg)` | `()` | bounded, redacted |
| `ctx.sleep(ms)` | `()` | journaled (nondeterministic in wall time) |
| `ctx.fail(msg)` | `!` | terminates the workflow as `FAILED` |
| `ctx.cancelled()` | `bool` | poll point for cooperative cancellation |

Absent by design: `time`, `rand`, filesystem, network, process, environment. A workflow that needs them asks a host function that journals the result (W3).

### 3.6 `AgentProfileV1`

**Schema fields: owner `05-domain-and-schemas.md` §4.9** — the field list, the `kind` enum, `capabilityCeiling`, `budgetDefaults`, `provenance` and the pinning invariant are declared there and MUST NOT be restated here. This section owns the *profile contract*: what a profile must mean, and what an extension may add to it.

Registration produces a `RegisteredAgentProfileProofV1` (profile id, revision, definition digest, owner-binding digest, permission-ceiling digest) so an accepted task can pin exactly what it ran under (`source: /data/home/forge/repo-tour/horizoncode/kernel/src/agent_profile.rs`).

> Reconciled 2026-11-07 (reaudit stage 2, RC-15) — the duplicate `AgentProfileV1` field set that stood here is merged into `05-domain-and-schemas.md` §4.9, which owns every `*V1` schema (`_conventions.md` §7).
>
> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

**Profile contract (wshobson P1–P10, normative):** every profile declares `resultSchema` (typed output; `kind=verify` MUST be three-valued + typed findings), `requiresInputs[]`, `refusesWhen[]` (evaluated before budget reservation; structured `precondition_unmet`), `partitionBy` (sibling nodes with one profile MUST carry distinct partition keys), `ownsPaths` (kernel refuses cross-session writes to an owned path), and a prompt skeleton (Mission / Invariants / Protocol / Inputs / Output contract / Never). Capability presets compose downward only: `observe ⊂ execute ⊂ mutate`, plus `coordinate`/`verify`/`publish`. Tier policy maps kind → model tier (verify/plan → strongest; act → mid; research → cheapest unless `requiresReasoning`). Every profile has a canonical id + revision + digest with `@provenance`, and a task pins that triple (A7). A **single-tool** profile is a `relay`: it is expressed today as `kind=act` with a one-entry tool allow-list, because doc 05 §4.9's `kind` enum has no `relay` member — adding one is an additive-gated enum change there (doc 05 §4.9, versioning rule), not a change here. **Bundling decision: 15 profiles, one per capability class** — plugins may add profiles only by narrowing; "python-expert" is a skill over `worker`, not a 20th agent.

### 3.7 MCP

**Client surface.**

| Concern | Interface |
|---|---|
| transports | `stdio` (child process), `sse`, streamable `http`, Unix-socket, `ws` (IDE-class) |
| auth | OAuth 2.1 + PKCE, protected-resource metadata, authorization-server metadata, device-code for headless, bearer-token file |
| discovery | `initialize` → capabilities → `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list` (paginated) |
| change notifications | `notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed` |
| invocation | `tools/call`, `resources/read`, `prompts/get` |
| server requests | `roots/list`, `elicitation/create`, `sampling/createMessage` (M10, M11) |
| local tool | `tool_search(query, kind?)` → ranked `ToolSearchResultV1[]` with `{name, description, schemaDigest, loadRef}`; capability `tool.discover` `[planned]` (reserved in `_conventions.md` §5, RC-11 — promoted when deferred loading is implemented) |

**Server surface (HorizonCode as an MCP server).** The exposed tool, resource and prompt catalogue is owned by `14-surfaces.md` §3.5 (*MCP exposure*) — the `hz_*` alias set, the gated mutating tools and the resources it lists — and MUST NOT be restated here. This document keeps only the client-side interface above, plus the authority rules: read-only default (M13), audience-bound OAuth tokens with a receipt per call (M14), the posture defaults of `14-surfaces.md` S112, and admission of every call as a session-scoped batch with a non-human origin (`14-surfaces.md` S116).

> Reconciled 2026-11-07 (reaudit stage 2, RC-15) — the rival `hzcode_*` catalogue that stood here is merged into `14-surfaces.md` §3.5, which owns the surface contract (`_conventions.md` §1.3).

### 3.8 ACP and the IDE bridge

**ACP methods (agent side, with capability negotiation).**

| Method | Direction | Gated by client capability | Notes |
|---|---|---|---|
| `initialize` | client→agent | — | protocol revision + client capabilities + auth methods |
| `authenticate` | client→agent | — | e.g. provider login |
| `session/new` | client→agent | — | `cwd`, `mcpServers`, `additionalDirectories` |
| `session/load` | client→agent | `loadSession` | resumes durable history |
| `session/prompt` | client→agent | — | content blocks; returns `stopReason` |
| `session/cancel` | notification | — | cancels the current turn |
| `session/update` | agent→client | — | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update` |
| `session/request_permission` | agent→client | — | a Guard challenge projection (I3) |
| `fs/read_text_file`, `fs/write_text_file` | agent→client | `fs.readTextFile`, `fs.writeTextFile` | falls back to the kernel path when unadvertised (I2) |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | agent→client | `terminal` | same fallback rule |
| `_hzcode/*` (extension namespace) | both | — | receipts, posture, worktrees, session search, subagents, cost, evidence verdicts |

**IDE bridge protocol (separate from ACP).**

| Concern | Interface |
|---|---|
| transport | HTTPS + SSE/WebSocket to a local or remote bridge endpoint |
| auth | OAuth device flow → bridge token (JWT ≤ 15 min) with `{sub, session_id, workspace_root_digest, aud, jti, worker_epoch}`; issued only to a previously trusted device (I6) |
| refresh | single-flight refresh scheduled ahead of expiry; a `401` triggers at most one re-auth |
| session management | attach / detach / resume / list; multiple editor windows may attach to one session or run separate ones |
| events | the same protocol events the TUI consumes, with a monotonic `seq` cursor per client |
| attachments | images, selections, diagnostics, file content — bounded and hashed (I7) |
| diffs | `DiffViewV1 {path, baseDigest, hunks[], applyPreview}`; accept ⇒ `files.patch` effect (I8) |
| replay | cached `initialize` + `session/load`/`session/new` replayed after a reconnect, then `hz/reconnected` (I9; the name is owned by `14-surfaces.md` S97) |
| replay window | a per-session ring buffer (default 10k events / 30 min); a client beyond it must reload (I10) |

### 3.9 Repository layout `.hz/`

```
.hz/
├── config.toml            # policy narrowing, posture ceiling, budgets (never widening)
├── AGENTS.md              # or the path declared in config; project instructions
├── agents/
│   ├── reviewer.md        # AgentProfileV1 + prompt (front-matter + body)
│   └── planner.md
├── commands/
│   ├── release-check.md
│   └── git/fixup.md       # nested → /project:git-fixup
├── skills/
│   └── orient/
│       ├── SKILL.md
│       ├── evals/         # repo-local eval catalog for this skill
│       └── reference/*.md
├── hooks/
│   └── hooks.json
├── workflow/
│   └── release-fanout.rhai
├── plugins/
│   └── plugin.lock        # ids + versions + digests (entries disabled until trusted)
├── mcp.json               # server declarations (off until trusted)
├── tests/
│   ├── catalog.yaml       # repo-defined tasks
│   └── assertions/*.yaml
└── (no trust records, ever — §7.7 of 11-authority-safety.md, trust on first use)
```

### 3.10 Types owned by this document

`PluginManifestV1` · `ToolContributionV1` · `CommandV1` · `HookV1` · `HookMatcherV1` · `SkillV1` · `WorkflowV1` · `WorkflowJournalV1` · `RegisteredAgentProfileProofV1` · `MarketplaceV1` · `PluginInstallRecordV1` · `PluginGrantV1` · `McpServerV1` · `McpToolCatalogV1` · `ToolSearchResultV1` · `AcpSessionV1` · `BridgeTokenV1` · `BridgeAttachmentV1` · `DiffViewV1` · `RepoTestCatalogV1`.

`AgentProfileV1` is **not** owned here: the schema is `05-domain-and-schemas.md` §4.9 and this document owns only its contract (§3.6).

---

## 4. Data

### 4.1 On-disk layout

```
~/.config/horizon/                    # user config (may widen relative to workspace)
├── config.toml
├── commands/**/*.md
├── skills/<name>/SKILL.md
├── agents/*.md
├── hooks/hooks.json
├── workflow/*.rhai
├── mcp.json
└── marketplaces.json                 # registered marketplaces + sources

~/.local/share/horizon/
├── plugins/<marketplace>/<name>/<version>/   # immutable, content-addressed by version dir
│   ├── plugin.json
│   ├── MANIFEST.lock                        # file → sha256, mirrors manifest.files
│   └── …
├── marketplaces/<name>/                     # cached marketplace index + signature
└── mcp/<server-id>/catalog.json             # last known tool/resource/prompt catalog

~/.local/state/horizon/
├── installed_plugins.json                   # PluginInstallRecordV1[] per scope
├── plugin_grants.json                       # PluginGrantV1[] (bounded, digest-bound)
├── trust/<workspace-root-digest>.json       # WorkspaceTrustRecordV1[] (never in a repo)
├── ths/<workspace-root-digest>.jsonl     # Trusted Host State **export/anchor** — the chain itself is the kernel table `ths_records` (`11-authority-safety.md` §4.7)
├── skill_locks/<skill-id>.json              # resolved skill digests
└── bridges/<session-id>/replay.jsonl        # bridge replay ring buffer

<repo>/.hz/                                  # workspace config (§3.9); content, never authority
```

Two placement rules that exist for safety rather than tidiness:

- **Nothing that confers authority lives under a repository.** Grants, trust records, install state and THS live in the user state directory (`R2`, `11-authority-safety.md` §7.7).
- **Plugin version directories are immutable.** An update writes a new version directory and switches a pointer; a crash mid-update leaves the previous version active (`X9`, `X10`).

### 4.2 Discovery order and precedence

| Artifact | Discovery order (first match wins per name) | Namespacing | Trust gate |
|---|---|---|---|
| Plugins | session `--plugin-dir` → workspace `.hz/plugins/plugin.lock` → user `installed_plugins.json` → managed policy | none (id is unique) | install + enable require consent |
| Skills | workspace `.hz/skills/` → user `~/.config/horizon/skills/` → plugin `skills/` → bundled → MCP-derived — first match wins **within one namespace**; across namespaces the full namespaced id decides, so a workspace skill never shadows a user skill by bare name (`S7`) | `project:`, `user:`, `plugin:<id>:`, `builtin:`, `mcp:<server>:` | workspace skills require a trust record |
| Commands | built-ins → user → plugin → workspace → MCP prompts | `builtin`(bare), `user:`, `plugin:<id>:`, `project:`, `mcp:<server>:` | workspace commands require trust for any capability they name |
| Agents | workspace `.hz/agents/` → user → plugin → built-in modes | `project:`, `user:`, `plugin:<id>:` | workspace profiles require trust |
| Hooks | managed → user → plugin → workspace (all merged, §4.6 ordering rules) | n/a | every hook program requires a trust record |
| Workflows | workspace `.hz/workflow/` → user → plugin | `project:`, `user:` | workspace workflows require trust |
| MCP servers | managed → user `mcp.json` → workspace `.hz/mcp.json` → plugin | server name; tool name `mcp__<server>__<tool>` | workspace/plugin servers off until trusted |
| Providers | managed → user → plugin contribution | provider id | plugin-provided providers are endpoints + codec ids, never code |

Precedence selects a **definition**, never an authority level (`S7`, `C7`). A bare-name collision is always a typed error, because silently preferring one of two definitions is exactly the failure mode a hostile repository would engineer.

### 4.3 `SKILL.md`

```markdown
---
name: release-check
description: Verify a release candidate against the checklist and report gaps.
when-to-use: When cutting a release, or when asked whether a version is ready to ship.
version: 1.2.0
license: MIT
author: Acme Platform Team

# --- authority-relevant keys (strict; unknown key ⇒ refuse) ---
capabilities: [files.read, terminal.run]
allowed-tools: [read, read_many, grep, glob, shell, verify]
run-as: inline                    # inline | subagent
agent: research                   # profile used when run-as: subagent

# --- presentation / behaviour keys (advisory; unknown key ⇒ warn) ---
model: inherit
arguments:
  - { name: tag, hint: "v1.2.3", required: true }
  - { name: dry-run, type: boolean, default: false }
user-invocable: true
disable-model-invocation: false
requires:
  commands: [git, jq]
---

# Release check

1. Read `CHANGELOG.md` and confirm the section for `${tag}` exists.
2. Run the repo's release check: `make release-check TAG=${tag}`.
3. Cite the receipt id of every command you ran.
4. Report gaps as an explicit list; do not summarise work you did not do.

Reference material for this skill lives in `reference/` next to this file;
read files on demand rather than loading them all.
```

Front-matter field semantics:

| Field | Meaning | Enforced where |
|---|---|---|
| `name`, `description` | identity and model-facing index line | index (≤ 1 KB total for the index) |
| `when-to-use` | model-facing trigger guidance | index + prompt fragment |
| `capabilities` | requested capability set; intersected with the grant (`S3`) | load + invocation |
| `allowed-tools` | narrows the tool set for the skill's run (`S4`) | turn setup |
| `run-as` | `inline` (expand into the current turn) or `subagent` (child session) (`S5`) | invocation |
| `agent` | profile for a `subagent` run; the profile's ceiling still applies (`A3`) | child construction |
| `arguments` | typed arguments, also exposed as command arguments when the skill is invoked as `/skill` | dispatch |
| `requires.commands` | advisory preflight; a missing binary is a typed error before the run | preflight |
| `user-invocable`, `disable-model-invocation` | who may start it | command registry + tool exposure |
| `files`/`reference/` | resources read on demand; the skill prompt is prefixed with the skill's base directory so the model can read them | prompt assembly |

### 4.4 Bundled skills

The bundled set adapts the Claude Code bundled skills observed at the tour commit and adds ones that only make sense with a kernel. The reference README counts 16 bundled skills; the pinned tree exposes 15 `bundled/*.ts` modules (`batch`, `claudeApi`, `claudeInChrome`, `debug`, `keybindings`, `loop`, `loremIpsum`, `remember`, `scheduleRemoteAgents`, `simplify`, `skillify`, `stuck`, `updateConfig`, `verify`, `verifyContent`) — we inherit the enumerated behaviour, not the number, and drop the ones tied to a specific vendor surface.

| Skill | Adapted from | What it does | Declared capabilities |
|---|---|---|---|
| `batch` | inherited | plan and apply a multi-file change set as one reviewed batch | `files.patch` |
| `debug` | inherited | reproduce → isolate → fix → prove, in that order | `files.read`, `files.patch`, `terminal.run` |
| `loop` | inherited | run-until-green repair loop with an explicit budget and a stop condition | `files.patch`, `terminal.run` |
| `remember` | inherited | write one durable memory fact with provenance | `memory.write` |
| `simplify` | inherited | reduce recently changed code without changing behaviour | `files.patch` |
| `stuck` | inherited | escalate from a repeated failure: re-plan from evidence, then ask a human | `files.read` |
| `verify` | inherited | run the evidence gate over the session's claims and receipts | `builtin.verifier` (user-initiated) |
| `update-config` | inherited | guided, narrowing-only config edits with a diff | `files.patch` |
| `schedule-remote-agents` | inherited | create a recurring remote run from a template | `schedule.manage`, `remote.exec` |
| `skillify` | inherited | synthesise a skill from a successful trajectory (§6.9) | `files.write` (skill directory), `builtin.verifier` |
| `orient` | ours | build a repo map and propose the first three edits | `files.read`, `language.symbols` |
| `receipts` | ours | explain a session from its receipts, claim by claim | `files.read` |
| `reconcile` | ours | walk a human through an `UNKNOWN` reconciliation with the probe evidence | `files.read` (host performs the probe) |
| `posture` | ours | show the effective posture, the policy digest and each layer's contribution | none (read-only host call) |
| `sandbox-doctor` | ours | probe and report this host's guarantee vector and residuals | `terminal.run` (host-owned probe) |
| `migrate-config` | ours (adapting the reference's external-agent migration crate) | import Claude Code / Codex / other-agent config as a narrowing-only proposal | `files.write` (to user config, via a reviewed diff) |
| `security-review` | ours | adversarial pass over a diff: injection, secret handling, egress, path handling | `files.read` |
| `pr-review` | ours | review a PR with evidence: receipts, tests run, claims checked | `files.read`, `vcs.read` |
| `flaky-test` | ours | triage a nondeterministic failure: re-run, isolate, report a rate | `terminal.run` |
| `cost-report` | ours | report cost, cache hits and budget consumption for the session tree | none (host call) |

Bundled skills are read-only content with the lowest precedence and no trust gate (they ship with the binary and are covered by the release signature).

### 4.5 Built-in commands

Commands that exist in the binary. `kind` is `prompt` / `local` / `rich` (`C1`).

| Command | Kind | Notes |
|---|---|---|
| `/help`, `/commands` | local | lists commands with sources (`--sources`) |
| `/init` | prompt | create or update the repo's `.hz/` scaffold and `AGENTS.md` |
| `/agents` | rich | list, inspect and switch agent profiles |
| `/mode` | local | switch act/plan/research (posture-aware; plan is read-only) |
| `/posture` | rich | show and change the session posture, with the widening warning and the pins |
| `/permissions` | rich | show effective rules by layer, the policy digest, and what each layer contributes |
| `/trust` | rich | list workspace-named programs and their trust decisions |
| `/doctor` | rich | environment, kernel/ABI, sandbox guarantee matrix, THS tip |
| `/sandbox` | rich | probe and explain confinement on this host |
| `/model`, `/models` | local | model selection and catalog |
| `/effort` | local | reasoning effort for the current model |
| `/provider` | rich | provider auth and route selection |
| `/login`, `/logout` | local | authentication flows |
| `/session` | rich | list, resume, fork, archive, delete sessions |
| `/new`, `/clear`, `/compact` | local | session and context lifecycle |
| `/undo`, `/rewind` | rich | turn-level rewind and checkpoint restore |
| `/diff` | rich | working-tree and per-turn diffs |
| `/review` | prompt | structured review of a diff or a PR |
| `/verify` | local | run the evidence gate over the current session |
| `/receipts` | rich | browse receipts; jump to the event that produced one |
| `/replay` | rich | step-by-step time-travel replay |
| `/cost`, `/usage` | rich | usage, cost and budget for the session tree |
| `/budget` | rich | set and inspect budgets and leases |
| `/skill` | rich | list, run, lock, update and verify skills |
| `/workflow` | rich | list and run workflows, inspect the journal |
| `/mcp` | rich | servers, auth state, catalogs, and a per-server tool browser |
| `/plugin` | rich | install, enable, update, disable, uninstall, inspect grants |
| `/marketplace` | rich | add, remove, sync marketplaces; show signature state |
| `/hooks` | rich | list hooks per point, with last-run status and receipts |
| `/commit`, `/branch`, `/worktree` | local / rich | VCS operations, worktree lifecycle (host-owned) |
| `/pr` | prompt | open or update a pull request with evidence |
| `/share`, `/export` | rich | session export, audit export, share links |
| `/remember`, `/memory` | local / rich | memory tiers: write, inspect, forget |
| `/schedule` | rich | recurring runs and triggers |
| `/team` | rich | teams, members, presence and the message bus |
| `/terminal` | rich | background shells, PTY sessions and job control |
| `/theme`, `/keybindings` | rich | appearance and input |
| `/feedback`, `/bug` | rich | feedback with a redacted trace archive |
| `/quit` | local | exit (with a busy-session guard) |

### 4.6 Hook points

| Point | Fired | Deciding? | Default sync? | Typical use |
|---|---|---|---|---|
| `session.start` | after the session and posture are pinned | no | yes | env bootstrap, announcing a worktree |
| `session.end` | after the final turn settles | no | yes | cleanup, summary publishing |
| `prompt.submitted` | after admission to the inbox, before the step | no (may inject context) | yes | injection guards, context augmentation |
| `step.start` / `step.end` | around a step | no | no | metrics, tracing |
| `tool.pre` | before Guard's decision is finalized | **yes** (deny/ask only) | yes | policy narrowing, secret scanning |
| `tool.post` | after settle, with the receipt | no | no | notifications, follow-up tasks |
| `tool.error` | on a tool failure or denial | no | no | alerting, repair suggestions |
| `effect.settled` | on every receipt | no | no | audit sinks, dashboards |
| `commit.pre` | before a VCS commit effect | **yes** | yes | format/lint gates, commit-message checks |
| `commit.post` | after a commit settles | no | no | tagging, notifications |
| `compact.pre` / `compact.post` | around compaction | no | no | memory extraction |
| `error` | on any unhandled error in a step | no | no | incident capture |
| `checkpoint.created` | when a checkpoint is written | no | no | snapshot bookkeeping |
| `session.rewound` | after a rewind | no | yes | re-derive derived state |

Ordering (`H5`): merged from all layers, sorted by `(declared priority, declaration order, name)`. All hooks for a point share one deadline; a hook that exceeds it is treated per `H3`/`H4`.

### 4.7 Marketplace data

```jsonc
// marketplace.json (signed by the marketplace key)
{
  "schemaVersion": 1,
  "name": "acme-registry",
  "owner": { "name": "Acme", "url": "https://…" },
  "metadata": { "pluginRoot": "./plugins", "version": "2026.11", "description": "…" },
  "plugins": [
    { "name": "acme-lint", "source": "./plugins/acme-lint", "description": "…",
      "version": "1.4.0", "strict": true, "category": "quality", "tags": ["lint"] },
    { "name": "acme-review", "source": { "source": "git-subdir",
        "url": "https://github.com/acme/tools", "path": "plugins/review",
        "sha": "0123456789abcdef0123456789abcdef01234567" } }
  ],
  "allowCrossMarketplaceDependenciesOn": ["acme-registry"],
  "forceRemoveDeletedPlugins": false
}
```

Marketplace rules:

1. The index is signed; an unsigned index is refused (X3-adjacent; `11-authority-safety.md` §7.15).
2. Names must be ASCII-printable and must not impersonate the official marketplace's reserved names; a homograph attempt is refused, not warned about.
3. `strict: true` (default) means the plugin must ship its own signed `plugin.json`; `strict: false` lets the index supply the manifest, and is refused for a settings-sourced marketplace entry.
4. Git-based sources are pinned by a full 40-hex `sha`; a branch name alone is refused for a marketplace that requires reproducibility.
5. `autoUpdate` is opt-in and defaults on only for the official marketplace.
6. Dependencies resolve against the declaring plugin's marketplace unless the *root* marketplace's `allowCrossMarketplaceDependenciesOn` names another; there is no transitive trust.
7. Removal from a marketplace never silently uninstalls: a `forceRemoveDeletedPlugins` marketplace emits an uninstall event and keeps the tombstone.
8. `sha` pinning without a signature is *not* sufficient to load: signature verification is always required for a plugin with an executable host.

### 4.8 MCP catalogs and the tool-search index

```jsonc
// ~/.local/share/horizon/mcp/<server-id>/catalog.json
{
  "serverId": "acme-docs",
  "serverVersion": "2.3.0",
  "protocolRevision": "2025-06-18",
  "capabilities": { "tools": { "listChanged": true }, "resources": { "subscribe": false }, "prompts": {} },
  "tools": [ { "name": "search", "description": "…", "schemaDigest": "blake3:…", "kind": "tool" } ],
  "resources": [ { "uri": "docs://handbook", "name": "Handbook", "mimeType": "text/markdown" } ],
  "prompts": [ { "name": "summarise-release", "arguments": [ { "name": "tag" } ] } ],
  "fetchedAtMs": 1767200000000,
  "catalogDigest": "blake3:…"
}
```

`tool_search` indexes the union of plugin, MCP and deferred first-party tools with BM25 over `(name, description, server, tags)` plus embeddings, and returns ≤ 25 ranked results, of which at most K (default 8) may be resident (`M8`). Residency is per session, LRU-evicted, and the resident set is sorted by name so the prompt prefix stays byte-stable (ADR-009). Its capability is the reserved `tool.discover` `[planned]` (`_conventions.md` §5, RC-11): a search of the discovery index, never a read of the tools it names.

### 4.9 Skill eval catalogs and repo tests

```yaml
# .hz/tests/catalog.yaml  (RepoTestCatalogV1)
version: 1
verifiers:
  - id: repo:pytest
    command: ["uv", "run", "pytest", "-q"]
    timeoutMs: 900000
    expected: { exitCode: 0 }
    observation: process

claims:
  - kind: tests_pass
    matches: { argumentContains: "pytest" }
    evidence: { verifier: repo:pytest }
  - kind: file_changed
    matches: { capability: files.patch, pathGlob: "src/**" }
    evidence: { receipt: effect_receipt }
```

A skill ships `evals/` in the same shape, so `hzcode skill verify <name>` can run the skill's own tasks in a sandboxed worktree and produce a verdict (`S10`, `S11`).

### 4.10 `WorkflowJournalV1`

```jsonc
{
  "workflowId": "release-fanout", "version": 1, "runId": "wfr_01J...",
  "sessionId": "ses_01J...",
  "paramsDigest": "blake3:…",
  "entries": [
    { "seq": 1, "kind": "step.enter", "step": "plan", "atMs": 1767200000000 },
    { "seq": 2, "kind": "host.spawn_agent", "step": "plan",
      "argsDigest": "blake3:…", "result": { "childSessionId": "ses_01K..." } },
    { "seq": 3, "kind": "host.wait", "handles": ["ses_01K..."],
      "results": [ { "status": "SUCCEEDED", "receiptId": "rcp_01J..." } ] },
    { "seq": 4, "kind": "step.exit", "step": "plan", "status": "ok" }
  ],
  "journalDigest": "blake3:…",
  "status": "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"
}
```

A resume replays entries 1..n and continues from the last completed step; every replayed host call returns the journaled result, never a fresh one (`W3`).

---

## 5. Errors & failure modes

### 5.1 Error taxonomy

| Surface | Condition | Code | Behaviour |
|---|---|---|---|
| Plugin | manifest missing a required field | `plugin_manifest_invalid` | refuse the plugin; siblings unaffected |
| Plugin | signature missing or bad | `plugin_signature_invalid` | refuse; never a warning-only path |
| Plugin | a file's digest differs from the signed map | `plugin_files_drifted` | refuse; re-install required |
| Plugin | `hz.minAbi` above the running ABI | `plugin_abi_too_new` | load in `disabled` mode with a typed diagnostic |
| Plugin | declares a capability the marketplace forbids | `plugin_capability_not_allowed` | install refused before any file is fetched |
| Plugin | requests an undeclared capability | `plugin_capability_undeclared` | deny the call; event; no kernel request is made |
| Plugin | host exits mid-call | `plugin_host_exited` | settle `FAILED`, or `UNKNOWN` if the effect was in dispatch |
| Plugin | exceeds its `limits` | `plugin_limit_exceeded` | kill the host (tree), quarantine the plugin, emit an event |
| Plugin | restart loop | `plugin_quarantined` | disable for the session; user may re-enable |
| Skill | authority-relevant unknown key | `skill_frontmatter_invalid` | refuse the skill; do not offer it to the model |
| Skill | bare-name collision | `skill_name_ambiguous` | refuse the bare name; require an explicit namespace |
| Skill | requested capability not granted | `skill_capability_not_granted` | refuse at invocation, naming the capability and the layer that denied it |
| Skill | eval suite fails | `skill_unverified` | usable locally with a warning; cannot be shared or offered as a synthesized skill |
| Skill | requests `run-as: subagent` beyond depth/child limits | `skill_subagent_denied` | refuse; the parent's limits win |
| Command | `local`/`rich` without capabilities | `command_capabilities_missing` | refuse at load |
| Command | capability denied by posture | `command_posture_denied` | listed, refuses to run with a typed error |
| Command | interpolation would reach a shell | `command_interpolation_refused` | refuse; the command must declare `terminal.run` |
| Hook | exit 20, crash, timeout, or unclassified failure at a deciding point | `hook_denied` | deny the tool call; receipt with `reason_code = hook_denied` |
| Hook | failure at an observation point | `hook_failed` | recorded; does not block |
| Hook | untrusted program | `executable_untrusted_workspace` | deny (headless) or prompt (interactive) |
| Workflow | script uses a non-host ambient | `workflow_ambient_denied` | refuse at compile time |
| Workflow | host call outside the ceiling | `workflow_ceiling_exceeded` | deny; journal the denial |
| Workflow | cancellation swallowed | `workflow_swallowed_cancellation` | `FAILED` at end of run |
| Workflow | journal replay mismatch | `workflow_journal_mismatch` | refuse to resume; escalate to the human with both digests |
| Agent profile | ceiling wider than the session | `profile_ceiling_widens` | refuse the profile |
| Agent profile | executor does not match owner binding | `profile_owner_mismatch` | deny |
| MCP | server unreachable | `mcp_unreachable` | mark the server degraded; its tools are withdrawn from residency; the run continues |
| MCP | auth failure | `mcp_auth_failed` | withdraw tools; prompt for re-auth once |
| MCP | server advertises a method then refuses it | `mcp_protocol_error` | withdraw the offending capability; keep the rest |
| MCP | call exceeds the deadline | `mcp_timeout` | settle the effect `FAILED` (or `UNKNOWN` if it was dispatched) |
| MCP | server request without a managed scope | `mcp_server_request_requires_managed_scope` | deny |
| ACP | client requests an unadvertised method | — | JSON-RPC method-not-found; never a silent no-op |
| ACP | client advertises `fs.*` but errors on use | `acp_client_fs_failed` | fall back to the kernel path; receipt records `servedBy: kernel_fs` |
| ACP | permission response malformed | `acp_permission_invalid` | treat as deny |
| Bridge | token expired mid-turn | `bridge_token_expired` | pause the turn, refresh, resume; never continue unauthenticated |
| Bridge | token for another session | `bridge_session_mismatch` | refuse; security event |
| Bridge | attachment over the cap | `bridge_attachment_too_large` | refuse that attachment; keep the prompt |
| Bridge | replay beyond the window | `bridge_replay_exhausted` | instruct a full `session/load` |
| Config | `.hz/` widening attempt | `workspace_layer_widening_refused` | refuse the field, keep running with the narrowed effective policy |

Two namespaces meet here and MUST NOT be conflated. The codes above are **load/admission error codes** (owned by the error catalogue of `07-apis-and-contracts.md`); the Guard-facing subset that can end an effect or a decision — `hook_denied`, `skill_capability_not_granted`, `workspace_layer_widening_refused`, `executable_untrusted_workspace` — MUST also be registered in the closed `reason_code` set of `11-authority-safety.md` §5.1, which is the only place a decision reason code is defined.

### 5.2 Failure isolation

| Failure | Isolation guarantee |
|---|---|
| One plugin host crashes | other plugins, the agent, the kernel and the session are unaffected (`X8`) |
| One MCP server hangs | only that server's tools block; a deadline bounds the wait |
| One hook hangs | the point's deadline expires; the deciding points deny; the run continues (`H3`) |
| One workflow child fails | the workflow sees `FAILED` for that handle and decides; siblings continue |
| One command fails | the session continues; the failure is a typed message |
| One skill eval fails | the skill is flagged unverified; nothing else changes |
| One provider contribution is broken | other providers are unaffected; the contribution is disabled with a diagnostic |
| A marketplace index is stale or unreachable | the cached index is used with a typed warning; installed plugins keep working |

---

## 6. Flows

### 6.1 Plugin lifecycle

**Discovery.** A plugin becomes known through: a marketplace entry (after `marketplace add`/`sync`), a workspace `.hz/plugins/plugin.lock`, a `--plugin-dir` session flag, or the managed policy's plugin list. Discovery produces a *candidate*, not an installed plugin.

**Install.**

1. Resolve the source (local path, git/github with `sha`, npm, pip, git-subdir) from the marketplace index.
2. Fetch into a staging directory.
3. Parse `plugin.json`; validate against `PluginManifestV1` (`X2`).
4. Verify the Ed25519 signature over the canonical manifest (`X3`).
5. Verify every entry in `files` against the on-disk bytes; a mismatch aborts (`plugin_files_drifted`).
6. Check `hz.minAbi`/`minProtocol` against the running ABI; a newer ABI aborts the install.
7. Check declared capabilities against the marketplace, user and workspace policy; a forbidden capability aborts (`plugin_capability_not_allowed`).
8. Move staging into `~/.local/share/horizon/plugins/<marketplace>/<name>/<version>/` (immutable).
9. Append a `PluginInstallRecordV1`; append a THS `trust_decision`-adjacent record; emit an event.
10. Prompt for `config` values declared by the manifest; sensitive values go to the vault.

**Load.**

1. Read install records for the session's scopes (managed, user, project, local).
2. For each enabled plugin: verify the signature again (cheap, and the file may have been replaced), then compile every contribution into a canonical declaration (`X11`).
3. Register declarations; reserve names so a later plugin cannot shadow an earlier one.
4. Start no host process yet (lazy): a host starts on first tool call, command, or hook.
5. Emit the resident prompt fragments (plugin *names* and tool *names*, not full schemas, to protect the prefix budget).

**Execute.** A plugin tool call flows: schema validation → Guard (`plugins.invoke` + inner capability, with plugin provenance) → policy/rule layers → challenge/lease → the plugin host performs the work inside its sandbox → observation → settle → receipt. The host never touches the filesystem or network directly: it calls capability-typed host functions that the agent translates into Guarded requests; an undeclared or ungranted call is refused inside the host before it leaves (`Y2`).

**Update.** Staged: fetch the new version → verify signature + files → diff the manifest (`version`, `capabilities`, `contributes`, `files`) → if anything in the authority-relevant set changed, re-consent → switch the pointer → keep the old version directory until the next successful session (`X9`). A plugin with a wider capability set is *not* enabled by an update; it is installed-but-disabled until the user agrees.

**Uninstall.** Stop the host (and its process tree) → remove the version directories → remove residency and registrations → append a tombstone to `installed_plugins.json` → emit an event. Receipts referencing the plugin remain valid and are never rewritten (`X10`).

### 6.2 Skill invocation

```
/model or user invokes:  /skill user:verify  or  the model selects the skill
        │
        ├─ resolve namespaced skill → load SKILL.md (strict front-matter — S2)
        ├─ trust gate (workspace skills only — S8)
        ├─ effective tools   = allowed-tools ∩ session tools                 (S4)
        ├─ effective caps    = capabilities ∩ grant ∩ posture                (S3)
        │     └─ empty or insufficient → refuse, name the denying layer
        ├─ run-as: inline    → expand body into the current turn; the skill's
        │                      tool calls are ordinary Guarded effects
        └─ run-as: subagent  → single subagent primitive: child session,
                               narrowed grant, inherited budget, depth+1,
                               context capsule, parent receipt link      (S5)
                                 │
                                 └─ child runs, settles, returns a summary
                                    + its receipts; the parent cannot widen
                                    the child retroactively                 (S6)
```

The skill's body is **content**. It can instruct the model to do something; it cannot make the model able to do it. That distinction is what makes a workspace-shipped skill safe to read and unsafe to obey blindly — which is why unrelated skills are trusted explicitly and why the tool allow-list is intersected rather than merged.

### 6.3 Command dispatch

| Kind | Path |
|---|---|
| `prompt` | interpolate arguments into content → admit to the inbox as a user prompt (`hz.session.prompt.admitted`) → normal step loop. No effect. (`C2`) |
| `local` | validate declared capabilities against the posture → execute through the same effect path as a tool → render `LocalCommandResult` (text, or a session mutation such as compact/skip). (`C3`) |
| `rich` | render the declared projection; user actions become declared operations, each of which is a Guarded effect. The projection must be expressible as text+actions so non-TUI front-ends work (parity ratchet). (`C4`) |

A command that wants command output in its prompt declares `terminal.run`, and the interpolation is a receipted effect (`C6`). There is no "run this shell snippet to build my prompt" path that skips the ledger.

### 6.4 Hook dispatch

```
point fires
  ├─ collect hooks for the point: managed ⊕ user ⊕ plugin ⊕ workspace
  ├─ sort by (priority, declaration order, name)                     (H5)
  ├─ trust-gate each hook program (workspace-named ⇒ TOFU)           (H7)
  ├─ start each hook as a receipted terminal.run under its hook profile (H6)
  │    · cleared env, cwd = workspace root, no network unless declared,
  │      read-only unless files.write declared, bounded output
  ├─ deciding points gather exit codes in order:
  │    20 → deny immediately (short-circuit; remaining hooks do not run)
  │    10 → escalate to ask (a later 20 still wins)
  │     0 → pass-with-notes
  │    anything else / crash / timeout → deny                          (H3)
  └─ observation points run in parallel, never block; failures are notes (H4)
```

Short-circuiting on deny matters: a hook that already refused should not spend the user's tokens running seven more hooks to agree.

### 6.5 Workflow run

```rhai
// .hz/workflow/release-fanout.rhai
// @workflow id=release-fanout version=1
// @param tag string required

fn main(ctx) {
    let tag = ctx.param("tag");

    let plan = ctx.step("plan", || {
        ctx.spawn_agent("user:planner", #{ prompt: "Plan the release for " + tag })
    });

    let audits = ctx.step("audit", || {
        let handles = [];
        for area in ["api", "cli", "docs"] {
            handles.push(ctx.spawn_agent("user:reviewer", #{
                prompt: "Audit the " + area + " changes for " + tag,
                isolation: "worktree",
            }));
        }
        handles
    });

    let outcomes = ctx.wait(audits);
    let failed = outcomes.filter(|o| o.status != "SUCCEEDED");
    if failed.len() > 0 {
        ctx.log("audit_failed: " + failed.len() + " area(s)");
        ctx.fail("audit failed for " + failed.len() + " area(s)");
    }

    ctx.checkpoint("audits_complete");
    ctx.tool("verify", #{ claims: ["tests_pass", "no_regressions"] });
}
```

```rhai
// .hz/workflow/loop-until-green.rhai
// @workflow id=loop-until-green version=1
// @budget tokens=200000 wallClockMs=1800000 steps=40

fn main(ctx) {
    let attempt = 0;
    while attempt < 8 {
        if ctx.cancelled() { return; }                 // cooperative cancel (W5)
        attempt += 1;
        let r = ctx.tool("shell", #{ command: "make test", timeoutMs: 600000 });
        if r.denied {
            ctx.fail("test command denied: " + r.reasonCode);
        }
        if r.exitCode == 0 {
            ctx.emit("hz.workflow.completed", #{ attempt: attempt });   // [planned] reserved name, _conventions.md §6
            return;
        }
        ctx.step("fix_" + attempt, || {
            ctx.spawn_agent("user:fixer", #{
                prompt: "The test suite failed. Read the receipt for the run, fix the cause, do not weaken tests.",
                receiptRef: r.receiptId,
            })
        });
    }
    ctx.fail("no green after 8 attempts");            // explicit, never an optimistic success
}
```

Cancellation semantics: `Ctrl-C`/`session/cancel` flips the run's cancellation token; `ctx.cancelled()` is the cooperative poll point; in-flight children are cancelled through the subagent primitive; already-settled steps keep their receipts; the journal is closed with `status: CANCELLED` (`W5`). A script that catches the cancellation error and returns success anyway fails at run end with `workflow_swallowed_cancellation` (`W6`).

### 6.6 MCP connect, discovery, and deferred tool loading

```
server declared (user config | workspace .hz/mcp.json | plugin | managed)
   │
   ├─ trust class: workspace/plugin declarations ⇒ OFF until trusted      (X6)
   ├─ transport: stdio (spawn under sandbox profile) | sse | http | socket
   ├─ auth: OAuth 2.1 + PKCE (metadata must be https) | device code | bearer file
   │     └─ token in the vault; single-flight refresh; one re-auth per session (M2-M4)
   ├─ initialize → server capabilities
   ├─ discover only what was advertised: tools / resources / prompts / templates (M5)
   ├─ catalog cached with a digest; list_changed invalidates                  (M6)
   │
   ├─ TOOL RESIDENCY: not loaded into the prompt by default                   (M7)
   │     model calls tool_search("create issue")            → ranked results (≤ 25)
   │     the step loads ≤ K (default 8) selected declarations → resident set
   │     resident set sorted by name; LRU eviction on overflow; event emitted (M8)
   │
   └─ CALL: tools/call → Guard(mcp.invoke, argument digest, server identity,
             declared version) → challenge/lease → dispatch → observe → receipt (M9)
```

Why deferred loading is a *safety* feature as well as a cost feature: an MCP server that dumps 300 tools into the context is (a) a prompt-prefix catastrophe and (b) a prompt-injection surface. Deferring turns 300 untrusted descriptions into a searchable index the model consults deliberately, and caps how many of them can influence a single step.

Sampling path (`M11`): `sampling/createMessage` from the server → the agent checks that a host-minted managed run exists for that server scope → Guard(`providers.infer`, `ManagedRun`, scope digest) → budget check → provider call → receipt. No managed scope ⇒ `mcp_server_request_requires_managed_scope`, and the server gets a JSON-RPC error rather than an answer it could have influenced.

### 6.7 ACP session lifecycle and permission proxying

```
initialize(protocolRevision, clientCapabilities, authMethods)
   ├─ negotiate: record what the client can serve (fs.*, terminal, loadSession)
   └─ the agent will not call an unadvertised client method                    (I2)

authenticate(...)                       (only if the client chose an auth method)

session/new(cwd, additionalDirectories, mcpServers)
   ├─ locate the workspace root; compute workspace_root_digest
   ├─ pin the session posture (kernel-built) — the client may request, not set (P4)
   └─ session/update: available_commands_update, current_mode_update

session/prompt(content blocks)
   ├─ attachments validated + hashed (≤ 4 MB × ≤ 8)                            (I7)
   ├─ admit to the durable inbox → run the normal step loop
   ├─ stream session/update: agent_message_chunk, agent_thought_chunk,
   │   tool_call / tool_call_update (with diffs), plan
   └─ return stopReason

Guard returns Ask
   └─ session/request_permission {toolCall, options}   ← the challenge projection (I3)
        ├─ "allow once"      → one-use lease for this intent digest only
        ├─ "allow always"    → bounded DirectSessionGrant (workspace-scoped,
        │                       expiring, revocable) that STILL goes through
        │                       Guard + lease + receipt on every use        (I4)
        └─ "deny"            → DENIED host_decision receipt

session/cancel → cancel the current turn, settle in-flight effects per §6.3 of
                 11-authority-safety.md, then return stopReason = cancelled

session/load(sessionId)  → replay durable history, then stream updates
```

Editor feature mapping:

| Editor feature | Protocol carrier |
|---|---|
| inline diff preview | `tool_call_update` with `diff` content derived from `hz_diff` |
| apply suggestion | a `files.patch` request; the editor never writes the file itself (`I8`) |
| plan mode | `current_mode_update` ⇄ plan; mode is posture-derived (`I5`) |
| slash commands | `available_commands_update` from the command registry (§4.5) |
| context attach | prompt content blocks (`resource_link`, `image`, embedded text) |
| terminal pane | client `terminal/*` when advertised, else the kernel's own PTY |
| diagnostics | `_hzcode/language.diagnostics` extension namespace |
| receipts and verdicts | `_hzcode/receipts`, `_hzcode/verify` extension namespace |

### 6.8 IDE bridge crash and replay

```
bridge client (editor) ──HTTPS+WS──► bridge endpoint ──► Controller (same as TUI)
        token: JWT ≤15m, trusted device, session_id claim                     (I6)

normal:  event stream with monotonic seq; client stores its cursor

crash:   connection drops
  ├─ client reconnects and presents a (possibly refreshed) token
  ├─ bridge replays: initialize, then each cached session/load | session/new
  │     · responses to REPLAYED requests are swallowed
  │     · notifications are forwarded normally
  ├─ bridge emits hz/reconnected { sessionIds, replayedAt }
  └─ events since the client's cursor are re-sent within the window; beyond
     the window the client is told to session/load                            (I10)
```

This is the client-side checkpoint pattern the strongest reference implementation uses, and it solves the actual user-visible failure: after a leader crash an editor must not show "unknown session id" and lose the conversation.

### 6.9 `skillify` — synthesising a skill from a trajectory

```
1. Selection   user picks a completed run (or a range of turns) as the source.
2. Extract     the trajectory is reduced to: the goal, the ordered tool calls,
               the receipts that settled them, the checkpoints, the failures,
               and the parts of the conversation that carried decisions.
3. Draft       a SKILL.md is written with: name, description, when-to-use,
               the minimal capability set that the trajectory actually used,
               the minimal allowed-tools set, numbered steps, and a
               'what NOT to do' section drawn from the recorded failures.
4. Narrow      the declared sets are intersected with the session's grant. A draft
               that would need more is flagged, not silently accepted.          (S3)
5. Evals       the source run's verifiable claims become eval tasks; the draft
               must pass them in a sandboxed worktree.                          (S10, S11)
6. Human gate  the draft is a PROPOSAL: diff, eval results, receipts, and the
               proposed capability set. Nothing is installed before approval.
               Self-improvement never widens authority (ADR-010; Y7).
7. Offer       on approval the skill lands in the user skills directory (or
               .hz/skills/ if the user chose project scope), locked by digest.
8. Re-verify   any later edit invalidates the lock and requires evals to pass again.
```

Step 6 is not a formality. The failure mode it prevents is a system that teaches itself a workflow that happens to work *because* it had a permission the user would not have granted knowingly.

---

## 7. Security & authority

### 7.1 What an extension can never do

**A plugin can never:**

1. obtain a kernel socket, an ABI handle, or any encoding path that talks to `hzk` without going through the agent's admission code;
2. request a capability it did not declare, or a capability outside its granted intersection (`X4`, `X5`);
3. obtain a `full-access` sandbox profile, or loosen its own profile;
4. widen the session posture, the policy, or the trust set;
5. read the vault, hold a credential value, or hold a `secrets.read` grant (the model may not either);
6. load native code into the agent process — no `.node`, no `.so`, no `dlopen` (`X6`);
7. spawn a process outside its own host's confinement, or escape the host's process group;
8. write outside its granted roots and its own state directory;
9. reach the network except through `net.fetch` with an allow-listed destination, or through a declared MCP server;
10. read, modify or forge a receipt, an event, a lease, a Trusted Host State record, or another plugin's state (`X12`);
11. disable Guard, a hook, the evidence gate, a budget, or a sandbox check;
12. construct an `EffectOriginKindV1` — origins are host-built only (`Y5`);
13. modify its own manifest, signature or file map, or write a trust record;
14. originate a `ManagedRun` or `ManagedRoot` effect, or drive a host-owned process capability (`language.start`, `builtin.verifier`, `git.worktree.*`);
15. run in the same process as another plugin, or observe its memory;
16. cause the agent to exit, hang, or OOM — its host is supervised, limited and quarantinable (`X8`).

**A skill can never:** widen the tool set, request a capability outside the grant, escalate by `run-as: subagent`, disable a gate, or shadow another skill's name (`S3`–`S7`, `S12`).

**A command can never:** run a shell to build its own prompt, execute a capability it did not declare, or exist only on one front-end (`C2`–`C6`).

**A hook can never:** allow an effect, undo a settled effect, run unsandboxed, or run untrusted (`H2`, `H6`–`H8`).

**A workflow can never:** touch an ambient, exceed the ceiling of the run that started it, swallow a cancellation, or produce two different results for one journal (`W2`–`W7`).

**An MCP server can never:** be called for a method it did not advertise, load its tools into the prompt by default, receive an answer to a server-initiated request without a host-minted managed scope, or have its text treated as instruction (`M5`, `M7`, `M10`, `M12`).

### 7.2 Capability narrowing arithmetic

```
  granted(plugin)  = declared(plugin)
                   ∩ marketplace_policy(marketplace)
                   ∩ user_policy
                   ∩ workspace_policy          (narrowing only)
                   ∩ posture(session)

  granted(skill)   = declared(skill)
                   ∩ grant(session)
                   ∩ posture(session)

  granted(child)   = grant(parent) ∩ declared(skill|profile) ∩ ceilings

  granted(workflow)= grant(run that started it)

  granted(mcp)     = declared(server) ∩ user_policy ∩ posture(session)
```

Three properties fall out and are tested:

| Property | Consequence |
|---|---|
| intersection is monotone | adding a layer can only remove permissions, never add |
| intersection is idempotent | evaluating twice changes nothing (no stateful escalation) |
| the empty set is a valid answer | a starved extension is disabled with a typed diagnostic, not silently executed with defaults |

Enforcement is **double** (`Y2`): the extension host refuses an undeclared or ungranted call before it becomes a kernel request, and Guard independently refuses it if it arrives anyway. The first is ergonomics and blast-radius control; the second is the security boundary. Neither is allowed to be the only one.

### 7.3 Permission prompts for extensions

A prompt for a plugin or MCP tool call shows, in this order:

1. **Who** — `plugin: acme-lint@acme-registry v1.4.0 (Acme, key ed25519:9f…)` or `mcp: acme-docs (v2.3.0)`.
2. **What** — the capability ID in plain language plus the effect class (`files.patch` — modifies files in the workspace).
3. **Where** — the resolved resource(s), workspace-relative.
4. **Under what** — the sandbox profile that would be used and any residual that applies.
5. **For how long** — once / for this session / always-for-this-version, and what invalidates the grant (manifest digest change, policy change, posture change, expiry).
6. **The digest** — the intent digest, shown in a form a user can compare against the audit export.

An "always" answer creates a `PluginGrantV1`:

```jsonc
{
  "pluginId": "acme-lint@acme-registry",
  "manifestDigest": "blake3:…",          // grant dies when this changes
  "capabilityId": "files.patch",
  "resourceScope": { "workspaceRootDigest": "blake3:…", "pathGlob": "src/**" },
  "maxUses": null, "expiresAtMs": 1769792000000,
  "decidedBy": "server_auth:alice",
  "digest": "blake3:…"
}
```

Grants are **not** a bypass (`L7` in `11-authority-safety.md`): every covered effect still traverses Guard, receives a one-use lease, and settles into a receipt. The grant only removes the prompt, not the admission.

### 7.4 Hook sandboxing in detail

A hook is untrusted third-party code that runs on every tool call, which makes it the highest-frequency extension surface and the one most likely to be abused.

| Aspect | Rule |
|---|---|
| Program trust | workspace/plugin hook programs require a trust record (path + content digest); a changed digest re-prompts (`H7`) |
| Profile | read-only by default; `files.write` only if declared; no network unless declared; separate write scope for the hook's own scratch dir |
| Environment | cleared, rebuilt from an allow-list; the hook receives `HZ_SESSION`, `HZ_CAPABILITY`, `HZ_TOOL_NAME`, `HZ_TOOL_INPUT_DIGEST`, `HZ_WORKSPACE_ROOT`, `HZ_POLICY_DIGEST`, plus explicitly declared variables — never the agent's full env, never a credential |
| Input | the hook input is a bounded JSON document (default ≤ 256 KB) containing the tool name, the canonical argument digest, the resolved resource, and the declared event; **not** the whole conversation |
| Output | bounded (default ≤ 64 KB); injected context fragments are marked untrusted (`H9`) |
| Time | default 10 s, hard maximum 300 s; a timeout at a deciding point denies (`H3`) |
| Receipt | every hook run is a `terminal.run` receipt; a denial is a `host_decision` receipt with `reason_code = hook_denied` |
| Blast radius | a hook cannot see another hook's output, cannot reorder itself, and cannot run at a point it did not declare (`H1`, `H5`) |
| Failure | at deciding points, anything other than 0/10/20 denies (`H3`); at observation points, failures are notes (`H4`) |

A repository therefore cannot use a hook to gain an unconfined process, a credential, or a network route: the hook is a sandboxed, receipted, bounded program that may only make the session *more* restrictive.

### 7.5 MCP, ACP and bridge authority notes

| Surface | Authority question | Answer |
|---|---|---|
| MCP client | can a server make the agent do something? | it can cause a `mcp.invoke` **request**; the request is decided like any other and can be denied |
| MCP client | can a server widen itself? | no: its granted set is fixed at declaration + policy; a `tools/list_changed` that adds a tool adds it to the catalog, not to the grant |
| MCP server (us) | can an external agent get our authority? | no: server posture defaults to read-only plus explicitly granted tools (ADR-006); every call is receipted with client identity |
| ACP | can an editor grant itself permissions? | no: `allow_always` produces a bounded grant that still traverses Guard; a malformed or hostile response is treated as deny |
| ACP | can an editor ask the agent to use the editor's own filesystem? | it may offer `fs.*`; if the agent uses it, the receipt records `servedBy: client_fs` and the workspace fence still applies |
| IDE bridge | can a stolen token act? | the token is short-lived, device-bound, audience-bound and session-bound; a mismatched session is refused with a security event |
| IDE bridge | can an attachment inject instructions? | attachments are content, framed as untrusted, hashed into the receipt; instruction text in them has no authority |
| IDE bridge | does accepting a diff bypass Guard? | no: accept produces a `files.patch` request with a host-computed base digest (`I8`) |

### 7.6 Boundary tests

The "one primitive, one boundary test" discipline (ADR-016; `/data/home/forge/hzcode/docs/01-vision-and-superset.md` §3.3) applied to extensibility:

| Boundary | What the test asserts |
|---|---|
| `boundary_plugin_host_rpc` | only one module encodes host→agent requests; a second encoder fails the build |
| `boundary_extension_declaration` | every contributed object is validated through one compiler function |
| `boundary_subagent_construction` | exactly one call site constructs a child session; skills, workflows, hooks, plugins and commands all funnel through it |
| `boundary_origin_construction` | no module outside the admission path constructs an `EffectOriginKindV1` (`Y5`) |
| `boundary_effect_submission` | exactly one call site submits an effect to the kernel |
| `boundary_trust_write` | exactly one module writes a trust record, and it refuses paths under any workspace root |
| `boundary_prompt_prefix` | extension prompt text may enter the prefix only through the declared resident set (ADR-009) |
| `boundary_receipt_write` | exactly one module mints a receipt |

### 7.7 The extension trust model in one row per surface

| Surface | Code we run? | Sandboxed? | Receipted? | Can widen? | Default state |
|---|---|---|---|---|---|
| First-party tool | yes (in-process native or TS) | per capability | yes | n/a | enabled |
| Plugin host | yes, separate process/WASM | yes, profile from its grants | yes (`plugins.invoke`) | no | disabled until installed + enabled |
| Plugin UI panel | yes, in a sandboxed webview | yes (renderer isolation) | actions receipted | no | as the plugin |
| Skill | no (content) | n/a | its tool calls are | no | available; workspace skills need trust |
| Command | prompt: no; local/rich: yes | per declared capability | yes | no | built-ins enabled |
| Hook | yes, as a child process | yes, hook profile | yes (`terminal.run`) | no (deny-only) | disabled until trusted |
| Workflow | no (interpreted by a confined engine) | n/a | its effects are | no | available; workspace workflows need trust |
| Agent profile | no (content) | n/a | pinned by digest | no | available; workspace profiles need trust |
| MCP server | yes, separate process | yes, server profile | yes (`mcp.invoke`) | no | disabled until trusted |
| ACP client (editor) | no | n/a | its decisions are inputs | no | user-initiated |
| IDE bridge | no (thin client) | n/a | its effects are | no | user-initiated, trusted device |

---

## 8. Performance budgets

Reference machine: 8-core laptop, NVMe, warm cache. A budget breach is a defect with a benchmark.

| # | Operation | p50 | p99 | Hard cap | Notes |
|---|---|---|---|---|---|
| B1 | Plugin host cold start | 120 ms | 250 ms | 1 s | per plugin, lazy on first use |
| B2 | First plugin tool call (including host start) | 200 ms | 400 ms | 1 s | B1 + admission |
| B3 | Plugin tool call overhead above the underlying effect | 2 ms | 5 ms | 25 ms | RPC + validation + admission |
| B4 | Manifest verification (Ed25519 + N=200 file digests) | 30 ms | 100 ms | 300 ms | install and load |
| B5 | Plugin install (5 MB, warm cache) | 400 ms | 2 s | 10 s | fetch + verify + materialise |
| B6 | Plugin update (staged switch) | 150 ms | 800 ms | 5 s | excludes network fetch |
| B7 | Marketplace index fetch | 300 ms | 10 s | 30 s | timeout ⇒ cached index + warning |
| B8 | Contribution compilation (10 tools, 4 commands, 2 hooks) | 8 ms | 30 ms | 150 ms | load time (`X11`) |
| B9 | Skills index in the prompt prefix (50 skills) | — | 1 KB | 4 KB | names + one line each |
| B10 | Skill load + front-matter validation | 1 ms | 5 ms | 25 ms | per invocation |
| B11 | Inline skill expansion + injection | 3 ms | 20 ms | 100 ms | excludes the model call |
| B12 | `run-as: subagent` child construction | 25 ms | 100 ms | 500 ms | excludes the child's first model call |
| B13 | Skill eval suite (10 tasks, sandboxed worktree) | 30 s | 10 min | 30 min | dominated by the tasks |
| B14 | Command registry render (500 commands) | 2 ms | 8 ms | 50 ms | `C8` |
| B15 | Command load + argument validation | 0.5 ms | 2 ms | 10 ms | per invocation |
| B16 | Hook dispatch overhead per point | 0.5 ms | 3 ms | 15 ms | excludes hook runtime |
| B17 | Hook sync budget | — | 10 s | 300 s | `H6`; timeout denies at deciding points |
| B18 | Hooks per point (default cap) | — | 8 | 32 | beyond the cap ⇒ typed error, not silent drop |
| B19 | Workflow script compile | 3 ms | 15 ms | 60 ms | cached by digest |
| B20 | Workflow host call round trip | 0.3 ms | 1 ms | 5 ms | journal append included |
| B21 | Workflow journal append | 0.2 ms | 1 ms | 5 ms | fsync amortized |
| B22 | Workflow journal replay (1,000 entries) | 5 ms | 25 ms | 150 ms | resume path |
| B23 | MCP `initialize` (local stdio) | 120 ms | 1 s | 5 s | spawn + handshake |
| B24 | MCP `initialize` (remote) | 400 ms | 3 s | 10 s | TLS + OAuth |
| B25 | MCP `tools/list` page | 30 ms | 500 ms | 5 s | paginated |
| B26 | `tool_search` over 1,000 tools | 6 ms | 25 ms | 100 ms | BM25 + embeddings |
| B27 | Resident MCP declaration set (K=8) added prefix size | — | 1.5 KB | 6 KB | sorted by name (ADR-009) |
| B28 | MCP tool call deadline (default) | — | 60 s | 600 s | configurable per server |
| B29 | ACP handshake | 60 ms | 300 ms | 2 s | `initialize` |
| B30 | ACP `session/update` batching | — | 60 Hz max, ≤ 4 KB per batch | — | coalescing is required for streaming |
| B31 | ACP permission round trip (excluding human think time) | 10 ms | 50 ms | 250 ms | `session/request_permission` |
| B32 | Bridge reconnect + replay (50 sessions) | 300 ms | 2 s | 10 s | `I9` |
| B33 | Bridge event cursor catch-up (10k events) | 80 ms | 500 ms | 3 s | within the window |
| B34 | Bridge attachment validation (4 MB) | 6 ms | 25 ms | 100 ms | hash + cap check |
| B35 | Bridge token refresh | 120 ms | 1 s | 5 s | single-flight |
| B36 | `.hz/` discovery + validation (whole tree) | 15 ms | 80 ms | 500 ms | session start, cached by tree digest |

Two rules with teeth:

- **B37 (no extension on the decision path).** No hook, plugin or workflow call may run inside `guard.authorize()`; extensions observe or narrow around a decision, never inside it.
- **B38 (degrades to deny, not to slow).** Any extension budget breach at a deciding point resolves to deny within the point's deadline; the session must not stall waiting for an extension.

---

## 9. Tests

Every guarantee in §2 maps to a test. All paths are `[planned]` except the skills/subagent suite `28-implementation-status.md` records as green (`bun test tests/core/skills-agents.test.ts`, 10 pass); where a path below conflicts with an implemented shape, `docs/28` is the truth.

### 9.1 Guarantee → test matrix

| Guarantee | Rule | Test | Kind |
|---|---|---|---|
| Manifest required fields | X2 | `packages/plugin/test/manifest.test.ts::missing_required_field_refused` | unit |
| Signature covers the file map | X3 | `packages/plugin/test/manifest.test.ts::drifted_file_refuses_load` | adversarial |
| Undeclared capability refused | X4 | `packages/plugin/test/adversarial.test.ts::undeclared_capability_refused` | adversarial |
| Grant is the intersection | X5 | `packages/plugin/test/grants.test.ts::workspace_cannot_widen_plugin_grant` | adversarial |
| No native code in-process | X6 | `packages/plugin/test/boundary.test.ts::no_dlopen_path_exists` | boundary |
| Outer and inner capability both receipted | X7 | `packages/plugin/test/receipts.test.ts::plugins_invoke_names_inner_capability` | integration |
| Host crash isolation | X8 | `packages/plugin/test/isolation.test.ts::crash_and_oom_do_not_affect_agent` | integration |
| Update re-consent | X9 | `packages/plugin/test/update.test.ts::widened_capabilities_require_reconsent` | adversarial |
| Uninstall is tombstoned | X10 | `packages/plugin/test/lifecycle.test.ts::uninstall_keeps_receipts_valid` | integration |
| Load-time declaration validation | X11 | `packages/plugin/test/manifest.test.ts::every_contribution_compiles_or_load_fails` | exhaustive |
| Plugin isolation from plugin | X12 | `packages/plugin/test/isolation.test.ts::plugins_cannot_read_each_other` | adversarial |
| Front-matter required fields | S1 | `packages/skills/test/load.test.ts::missing_name_or_description_refuses` | unit |
| Strict authority keys | S2 | `packages/skills/test/load.test.ts::unknown_capability_key_refuses` | unit |
| Capability intersection | S3 | `packages/skills/test/grants.test.ts::skill_cannot_exceed_grant` | adversarial |
| Tool set narrowed only | S4 | `packages/skills/test/grants.test.ts::skill_cannot_add_a_tool` | adversarial |
| Subagent path | S5 | `packages/skills/test/subagent.test.ts::child_constructed_through_single_primitive` | boundary |
| No escalation | S6 | `packages/skills/test/grants.test.ts::child_never_wider_than_parent` | adversarial |
| Namespacing | S7 | `packages/skills/test/discovery.test.ts::bare_name_collision_is_an_error` | adversarial |
| Workspace skill trust | S8 | `packages/skills/test/trust.test.ts::untrusted_workspace_skill_not_offered` | adversarial |
| Lock and update | S9 | `packages/skills/test/lock.test.ts::prompt_diff_shown_and_staged` | integration |
| Evals before offering | S10 | `packages/skills/test/evals.test.ts::unverified_skill_cannot_be_shared` | adversarial |
| Evals are sandboxed and receipted | S11 | `packages/skills/test/evals.test.ts::eval_runs_in_worktree_with_receipts` | integration |
| Skills are content | S12 | `packages/skills/test/adversarial.test.ts::skill_cannot_disable_a_gate` | adversarial |
| Three command variants | C1 | `packages/cli/test/commands.test.ts::variants_are_distinguishable` | unit |
| Prompt commands have no effect | C2 | `packages/cli/test/commands.test.ts::prompt_command_settles_no_effect` | boundary |
| Local commands declare capabilities | C3 | `packages/cli/test/commands.test.ts::local_command_without_capabilities_refused` | unit |
| Rich commands have a text projection | C4 | `tools/parity-ratchet` | ratchet |
| Interpolation is escape-safe | C5 | `packages/cli/test/commands.test.ts::argument_cannot_inject_a_command` | adversarial |
| Substitution is a receipted effect | C6 | `packages/cli/test/commands.test.ts::substitution_requires_terminal_run` | adversarial |
| Namespacing | C7 | `packages/cli/test/commands.test.ts::collision_is_an_error` | adversarial |
| Deterministic discovery | C8 | `packages/cli/test/commands.test.ts::sources_are_deterministic` | unit |
| Capability check at load | C9 | `packages/cli/test/commands.test.ts::denied_capability_refuses_at_run` | integration |
| Hook point set is closed | H1 | `packages/core/test/hooks.test.ts::point_set_is_exhaustive` | exhaustive |
| Hooks cannot allow | H2 | `packages/core/test/hooks.test.ts::no_allow_code_path_exists` | boundary |
| Deciding failure denies | H3 | `packages/core/test/hooks.test.ts::crash_timeout_and_unclassified_all_deny` | adversarial |
| Observation failure does not block | H4 | `packages/core/test/hooks.test.ts::observation_failure_is_a_note` | unit |
| Deterministic ordering | H5 | `packages/core/test/hooks.test.ts::order_is_priority_then_declaration_then_name` | property |
| Hook sandbox profile | H6 | `packages/core/test/hooks.test.ts::hook_runs_readonly_with_cleared_env` | integration |
| Workspace hook trust | H7 | `packages/core/test/hooks.test.ts::untrusted_hook_does_not_run` | adversarial |
| Post hooks cannot undo | H8 | `packages/core/test/hooks.test.ts::post_hook_cannot_rewrite_the_effect` | boundary |
| Injected context is bounded and untrusted | H9 | `packages/core/test/hooks.test.ts::injected_fragment_is_marked_untrusted` | unit |
| Async hooks are off the critical path | H10 | `packages/core/test/hooks.test.ts::async_hook_does_not_block_the_step` | integration |
| Workflow metadata shape | W1 | `packages/workflow/test/load.test.ts::metadata_required` | unit |
| No ambient access | W2 | `packages/workflow/test/ambient.test.ts::fs_net_env_time_rand_absent` | boundary |
| Journal replay | W3 | `packages/workflow/test/replay.test.ts::resume_replays_journal_byte_identically` | integration |
| Ceiling inherited | W4 | `packages/workflow/test/adversarial.test.ts::workflow_cannot_exceed_ceiling` | adversarial |
| Cancellation propagates | W5 | `packages/workflow/test/cancel.test.ts::children_cancelled_and_steps_recorded` | integration |
| Cancellation cannot be swallowed | W6 | `packages/workflow/test/cancel.test.ts::swallowed_cancellation_fails_the_run` | adversarial |
| Determinism | W7 | `packages/workflow/test/determinism.test.ts::two_runs_same_journal_and_result` | property |
| Steps receipted | W8 | `packages/workflow/test/receipts.test.ts::every_step_has_evidence` | integration |
| Four profile modes | A1 | `packages/agents/test/profiles.test.ts::modes_exhaustive` | exhaustive |
| Profile fields | A2 | `packages/agents/test/profiles.test.ts::required_fields_enforced` | unit |
| Ceiling narrows only | A3 | `packages/agents/test/profiles.test.ts::widening_ceiling_refused` | adversarial |
| Plan is read-only | A4 | `packages/agents/test/profiles.test.ts::plan_profile_has_no_write_capability` | adversarial |
| Research is read-only plus search | A5 | `packages/agents/test/profiles.test.ts::research_profile_vectors` | unit |
| Owner binding | A6 | `packages/agents/test/profiles.test.ts::executor_must_match_owner` | adversarial |
| Task pins the revision | A7 | `packages/agents/test/profiles.test.ts::edited_profile_does_not_change_a_running_task` | integration |
| Per-use approval list | A8 | `packages/agents/test/profiles.test.ts::requires_approval_challenges_under_full_access` | adversarial |
| Prompts are inert | A9 | `packages/agents/test/profiles.test.ts::prompt_has_no_dynamic_includes` | boundary |
| MCP transports | M1 | `packages/mcp/test/transports.test.ts::stdio_sse_http_socket` | integration |
| OAuth correctness | M2 | `packages/mcp/test/oauth.test.ts::pkce_https_metadata_required` | adversarial |
| Token storage | M3 | `packages/mcp/test/oauth.test.ts::token_never_in_config_file` | adversarial |
| Single-flight refresh | M4 | `packages/mcp/test/oauth.test.ts::one_refresh_per_server` | integration |
| Advertised methods only | M5 | `packages/mcp/test/discovery.test.ts::unadvertised_method_not_called` | adversarial |
| Catalog invalidation | M6 | `packages/mcp/test/discovery.test.ts::list_changed_invalidates_cache` | integration |
| Deferred tool loading by default | M7 | `packages/mcp/test/residency.test.ts::tools_not_in_prompt_by_default` | boundary |
| Residency cap and prefix stability | M8 | `packages/mcp/test/residency.test.ts::cap_enforced_and_prefix_byte_stable` | ratchet |
| Call receipt | M9 | `packages/mcp/test/receipts.test.ts::server_identity_and_version_recorded` | integration |
| Server requests need a managed scope | M10 | `packages/mcp/test/adversarial.test.ts::roots_and_elicitation_are_gated` | adversarial |
| Sampling is off by default | M11 | `packages/mcp/test/sampling.test.ts::denied_without_managed_scope` | adversarial |
| Server text is untrusted | M12 | `packages/mcp/test/adversarial.test.ts::tool_text_has_no_authority` | adversarial |
| Server-mode posture | M13 | `packages/mcp/test/server.test.ts::default_posture_is_read_only` | adversarial |
| Server auth | M14 | `packages/mcp/test/server.test.ts::audience_bound_tokens_only` | adversarial |
| ACP method surface | I1 | `packages/acp/test/methods.test.ts::required_methods_present` | exhaustive |
| No unadvertised client calls | I2 | `packages/acp/test/negotiation.test.ts::unadvertised_fs_and_terminal_not_called` | adversarial |
| Permission proxying | I3 | `packages/acp/test/permissions.test.ts::response_is_an_input_not_a_lease` | adversarial |
| `allow_always` is bounded | I4 | `packages/acp/test/permissions.test.ts::grant_still_receipted_and_expiring` | adversarial |
| Mode mapping | I5 | `packages/acp/test/modes.test.ts::posture_maps_to_modes_both_ways` | unit |
| Bridge token binding | I6 | `packages/acp/test/bridge.test.ts::session_bound_device_bound_audience_bound` | adversarial |
| Attachment bounds | I7 | `packages/acp/test/bridge.test.ts::oversize_and_too_many_refused` | unit |
| Diff accept is an effect | I8 | `packages/acp/test/bridge.test.ts::accept_produces_files_patch` | integration |
| Replay after crash | I9 | `packages/acp/test/replay.test.ts::initialize_and_sessions_replayed_responses_swallowed` | integration |
| Replay window | I10 | `packages/acp/test/replay.test.ts::beyond_window_requires_full_load` | integration |
| `.hz/` layout | R1 | `packages/core/test/selfhost.test.ts::layout_is_stable` | doc-claim + unit |
| `.hz/` cannot widen | R2 | `crates/hz_policy/tests/merge.rs::workspace_layer_can_only_narrow` | adversarial |
| `.hz/` is sandbox-protected | R3 | `crates/hz_sandbox/tests/profiles.rs::hz_write_denied` | integration |
| Repo programs are TOFU | R4 | `packages/core/test/selfhost.test.ts::every_repo_named_program_is_gated` | exhaustive |
| Repo tests are evidence | R5 | `crates/hz_kernel/tests/evidence_gate.rs::repo_catalog_used_and_cannot_override` | integration |
| No kernel/vault/posture access | Y1 | `packages/plugin/test/boundary.test.ts::no_forbidden_surface_reachable` | boundary |
| Double enforcement | Y2 | `packages/plugin/test/adversarial.test.ts::host_and_kernel_both_refuse` | adversarial |
| Grants are bounded and invalidated | Y3 | `crates/hz_kernel/tests/grants.rs::grant_dies_with_its_digest` | integration |
| Boundary tests exist | Y4 | `tools/repolint` `boundary-tests` rule | ratchet |
| Origin set is closed | Y5 | `crates/hz_kernel/tests/origin_typing.rs::origin_kinds_are_exactly_four` | exhaustive |
| Load-time validation only | Y6 | `packages/plugin/test/boundary.test.ts::no_runtime_entitlement_check` | boundary |
| Learning cannot widen | Y7 | `packages/learn/test/skillify.test.ts::proposal_cannot_request_more_than_the_run_used` | adversarial |

### 9.2 Adversarial suite

| # | Attack | Expected outcome | Test |
|---|---|---|---|
| X1 | plugin ships a manifest with a valid signature but one file replaced | `plugin_files_drifted`; load refused | `packages/plugin/test/adversarial.test.ts::file_swap_after_signing` |
| X2 | plugin declares `files.read` and calls `terminal.run` | refused inside the host; no kernel request | `packages/plugin/test/adversarial.test.ts::undeclared_at_runtime` |
| X3 | plugin host loops forever in a tool | limit kills the host tree; effect `FAILED`/`UNKNOWN`; agent unaffected | `packages/plugin/test/isolation.test.ts::infinite_loop_contained` |
| X4 | plugin host OOMs | memory limit kills it; the session continues | `packages/plugin/test/isolation.test.ts::oom_contained` |
| X5 | workspace `.hz/skills/verify/SKILL.md` tries to shadow `user:verify` | bare name is ambiguous; the workspace skill needs trust and is `project:verify` | `packages/skills/test/adversarial.test.ts::shadowing_attempt` |
| X6 | skill body instructs the model to `chmod 777` and read `~/.aws` | the resulting calls are decided normally: `~/.aws` is a deny mask, `terminal.run` is decided by rules | `packages/skills/test/adversarial.test.ts::skill_instructions_have_no_authority` |
| X7 | hook returns exit 0 but prints a forged JSON "deny" record | stdout is a note, never a decision; the real decision path is unchanged | `packages/core/test/hooks.test.ts::stdout_cannot_forge_a_decision` |
| X8 | hook exits with 137 (killed) at `tool.pre` | treated as deny (`H3`) | `packages/core/test/hooks.test.ts::signal_exit_denies` |
| X9 | repo hook writes to `.git/hooks/pre-commit` | the hook profile is read-only; the write fails and is recorded | `crates/hz_sandbox/tests/profiles.rs::hook_cannot_write_git` |
| X10 | workflow calls `ctx.tool("shell", …)` after the ceiling was narrowed | `workflow_ceiling_exceeded`; journal records it | `packages/workflow/test/adversarial.test.ts::narrowed_ceiling_respected` |
| X11 | workflow swallows a cancellation and returns success | `workflow_swallowed_cancellation`; run `FAILED` | `packages/workflow/test/cancel.test.ts::swallowed_cancellation` |
| X12 | workflow journal is edited to fake a completed step | `workflow_journal_mismatch`; refuse to resume; show both digests | `packages/workflow/test/replay.test.ts::edited_journal_refused` |
| X13 | MCP server returns a tool list with 300 tools and prompt-injection text | catalog updated; residency capped at K; text framed as untrusted | `packages/mcp/test/adversarial.test.ts::tool_flood_and_injection` |
| X14 | MCP server requests `sampling/createMessage` with no managed scope | denied; JSON-RPC error returned | `packages/mcp/test/sampling.test.ts::no_scope_no_answer` |
| X15 | MCP server's `roots/list` tries to enumerate the whole home directory | answered only from the pinned read-only root projection | `packages/mcp/test/adversarial.test.ts::roots_are_pinned` |
| X16 | ACP client answers `session/request_permission` with a forged allow for a different tool | digest mismatch ⇒ treat as deny | `packages/acp/test/permissions.test.ts::forged_response_denied` |
| X17 | ACP client claims `fs.writeTextFile` and writes outside the workspace | the write goes through the effect path with the workspace fence; denied and receipted | `packages/acp/test/adversarial.test.ts::client_fs_cannot_escape_the_fence` |
| X18 | IDE bridge token replayed against a different session | `bridge_session_mismatch`; security event | `packages/acp/test/bridge.test.ts::cross_session_token_refused` |
| X19 | editor sends 50 MB of "selection" as an attachment | refused above the cap; the prompt still runs | `packages/acp/test/bridge.test.ts::attachment_cap_enforced` |
| X20 | a marketplace entry points at a git repo whose `sha` is a branch name | refused by the reproducibility rule | `packages/plugin/test/marketplace.test.ts::unpinned_git_source_refused` |
| X21 | a marketplace name uses Cyrillic characters to impersonate the official one | refused (non-ASCII) | `packages/plugin/test/marketplace.test.ts::homograph_name_refused` |
| X22 | a plugin dependency pulls a plugin from another marketplace without the root allowlist | refused; no transitive trust | `packages/plugin/test/marketplace.test.ts::cross_marketplace_dependency_refused` |
| X23 | `.hz/config.toml` tries to set `sandboxMode = "danger-full-access"` | `workspace_layer_widening_refused`; posture unchanged | `crates/hz_policy/tests/adversarial.rs::repo_cannot_grant_full_access` |
| X24 | the agent is asked to edit `.hz/hooks/hooks.json` to add a hook | the write is a normal effect; `.hz` is a protected sandbox subpath and a hook still needs a trust record | `crates/hz_sandbox/tests/profiles.rs::hz_write_denied` |
| X25 | `skillify` proposes a skill whose capability set is wider than the source run used | proposal flagged and refused; nothing installed | `packages/learn/test/skillify.test.ts::wider_capability_flagged` |
| X26 | a plugin UI panel attempts to navigate to an external URL with the session token | the panel is renderer-isolated with a CSP and no token access; navigation is refused | `packages/plugin/test/ui.test.ts::panel_cannot_navigate_or_read_tokens` |

### 9.3 Gate and ratchet tests

| Gate | What it fails on |
|---|---|
| `boundary-tests` | a missing or bypassed boundary test from §7.6 |
| `parity-ratchet` | a rich command, plugin UI panel or ACP feature that exists on one front-end only (ADR-005) |
| `cache-prefix-guard` | extension text entering the prompt prefix outside the resident set (ADR-009) |
| `capability-registry-parity` | a plugin-contributed `capabilityId` the kernel does not classify |
| `no-postinstall` | a dependency requiring a lifecycle script (`11-authority-safety.md` §7.15) |
| `doc-claim-ratchet` | a doc claiming a status above its evidence (`/data/home/forge/hzcode/docs/_conventions.md` §8) |
| `skill-eval-ratchet` | a bundled or shared skill whose evals do not pass |
| `trust-gate-coverage` | a workspace-named program kind without a TOFU gate |
| `hook-point-closure` | a hook point added without updating §4.6 and the exhaustive test |

---

## 10. Status

Every capability below is **DESIGNED** except the two rows `28-implementation-status.md` records above it — that file owns implementation levels (RC-13) and is the only place a level above `DESIGNED` may be claimed. Evidence for every other row is this document. Levels per `/data/home/forge/hzcode/docs/_conventions.md` §8; nothing else here is a claim of working code.

| Capability | Level | Evidence | Next required evidence for promotion |
|---|---|---|---|
| Plugin manifest + validation | DESIGNED | §3.1, §6.1; `source: /data/home/forge/repo-tour/claude-code/src/utils/plugins/schemas.ts` | `packages/plugin/src/manifest.ts` + `manifest.test.ts` |
| Plugin signatures + file closure | DESIGNED | §3.1, `11-authority-safety.md` §7.15 | `manifest.test.ts::drifted_file_refuses_load` |
| Sandboxed plugin host | DESIGNED | §6.1, §7.1, §7.4 | `packages/plugin/src/host.ts` + isolation suite |
| Capability declarations + grants | DESIGNED | §7.2, §7.3 | `grants.test.ts` + `boundary_extension_declaration` |
| Plugin tools → `ToolDeclarationV1` | DESIGNED | §3.2; `/data/home/forge/hzcode/docs/02-decisions.md` ADR-015 | `packages/plugin/src/compile.ts` + exhaustive test |
| Lifecycle (discovery/install/load/update/uninstall) | DESIGNED | §6.1 | `lifecycle.test.ts`, `update.test.ts` |
| Marketplace model | DESIGNED | §4.7; `source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-plugin-marketplace/src/` | `marketplace.test.ts` |
| Skills (`SKILL.md`, discovery, precedence) | VERIFIED for the v0.1 flat-file slice; DESIGNED for the directory form | `28-implementation-status.md` §1 — `.hzcode/skills/*.md` discovery with workspace shadowing, prompt directory capped at 12, `/skill` activation (`bun test tests/core/skills-agents.test.ts` → 10 pass); §4.2, §4.3 for the designed form. **Shape difference, stated not hidden:** v0.1 reads flat `.hzcode/skills/*.md`, while S1 specifies a directory containing `SKILL.md` — the flat file is the compatibility form, the directory form is `[planned]` | directory discovery + `packages/skills` load suite |
| `run-as: subagent` | VERIFIED for the `agent`-tool slice; DESIGNED for the `run-as:` front-matter form | `28-implementation-status.md` §1 — `agent` tool, child session, base-seven tools only, steps 12 default / 20 cap, own receipts (same suite, 10 pass); §6.2 and ADR-016 for the skill-triggered form | `subagent.test.ts` + boundary test |
| Skill lock/update + evals | DESIGNED | §4.9, §6.9 | `packages/skills` eval harness |
| Bundled skills | DESIGNED | §4.4; `source: /data/home/forge/repo-tour/claude-code/src/skills/bundled/` | one bundled skill wired + evaluated |
| Commands (prompt/local/rich) | DESIGNED | §3.3, §4.5, §6.3; `source: /data/home/forge/repo-tour/claude-code/src/types/command.ts` | `packages/cli` command suite |
| Hooks (points, ordering, failure) | DESIGNED | §3.4, §4.6, §6.4; `source: /data/home/forge/repo-tour/claude-code/src/schemas/hooks.ts`, `source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-hooks/src/` | `packages/core` hooks suite |
| Hook sandboxing | DESIGNED | §7.4 | `hooks.test.ts::hook_runs_readonly_with_cleared_env` |
| Workflow engine (Rhai) | DESIGNED | §3.5, §6.5; `source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-workflow/src/lib.rs` | `packages/workflow` load/replay/cancel suites |
| Agent profiles | DESIGNED | §3.6; `source: /data/home/forge/repo-tour/horizoncode/kernel/src/agent_profile.rs` | `packages/agents` profile suite |
| MCP client (transports, OAuth, discovery) | DESIGNED | §3.7, §6.6; `source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-mcp/src/lib.rs` | `packages/mcp` transport + oauth suites |
| Deferred tool loading (`tool_search`) | DESIGNED | §4.8, §6.6; `source: /data/home/forge/repo-tour/codex/codex-rs/core/src/tools/handlers/tool_search.rs` | residency suite + cache-prefix guard |
| MCP server mode | DESIGNED | §3.7; ADR-006 | `server.test.ts` |
| MCP sampling under a managed scope | DESIGNED | §6.6, `11-authority-safety.md` §7.2.4 | `sampling.test.ts` |
| ACP integration | DESIGNED | §3.8, §6.7; `source: /data/home/forge/repo-tour/DeepSeek-Reasonix/internal/frontend/acp/clientio.go` | `packages/acp` method + negotiation suites |
| ACP permission proxying | DESIGNED | §6.7 | `permissions.test.ts` |
| IDE bridge (JWT, device trust, attachments, diffs) | DESIGNED | §3.8, §6.8; `source: /data/home/forge/repo-tour/claude-code/src/bridge/trustedDevice.ts` | `bridge.test.ts` |
| Bridge replay after crash | DESIGNED | §6.8; `source: /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs` (`StdioReplayState`) | `replay.test.ts` |
| Self-hosting `.hz/` | DESIGNED | §3.9, §4.2 | scaffold + `selfhost.test.ts` |
| Extension security model | DESIGNED | §7 | boundary tests + `trust-gate-coverage` ratchet |

### 10.1 Known gaps carried forward

1. **Only the v0.1 slices exist.** There is no plugin host, hook dispatcher, workflow engine, MCP client or ACP agent in this repository yet. The skills loader and the subagent primitive **do** exist and are VERIFIED (`28-implementation-status.md` §1); implementation levels are owned by `docs/28` (RC-13), including the shape difference in §4.3 noted at the §10 row.
2. **The reference implementations disagree on OAuth surface details.** The MCP auth flow here is specified to OAuth 2.1 + PKCE against published metadata; the concrete authorization-server behaviours of real servers vary, and interoperating with them is a test-time obligation, not a design assumption.
3. **The ACP extension namespace (`_hzcode/*`) is ours.** It is not part of the standard ACP surface, so an editor that does not know it sees a conformant agent with fewer features, never a broken one.
4. **Windows and macOS hook sandboxing inherits the platform residuals** of `11-authority-safety.md` §7.12.2; a hook profile on those platforms reports the same named residuals rather than claiming parity with Linux.
5. **The `skillify` eval gate depends on the evidence gate**, which is itself still `DESIGNED` (`11-authority-safety.md` §10.1). A synthesized skill cannot be promoted above `DESIGNED` before the gate is wired.
6. **Plugin UI panels are specified as renderer-isolated webviews** with a declared action surface; the concrete webview technology per platform is not decided here and MUST NOT be a path to unsandboxed code.

