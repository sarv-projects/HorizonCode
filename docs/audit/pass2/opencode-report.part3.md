 Session Core doctrine (join same-Session resumes, coalesce wakes, allow different Sessions concurrently, preserve claims on shutdown, terminal events release them).

### 5.4 Prompt admission & inbox
- `packages/core/src/session/session.ts` — the ID-bound `Session.make()` facade: `prompt`, `synthetic`, `shell`, `skill`, `compact`, `wait`, `resume`, `interrupt`, inbox mutation (`cancelInbox`/`steerInbox`/`queueInbox`), rename/archive/view, agent/model switch, revert stage/clear/commit. `prompt` reconciles, prepares, commits a staged revert, admits, then wakes execution unless `resume: false` ([`opencode/packages/core/src/session/session.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/session.ts#L155-L191)):

```ts
const prompt = Effect.fn("Session.prompt")((sessionID, input) => Effect.uninterruptibleMask((restore) =>
  Effect.gen(function* () {
    const session = yield* get(sessionID)
    const messageID = input.id ?? SessionMessage.ID.create()
    const admitted = yield* Effect.gen(function* () {
      const existing = yield* admission.reconcile({ id: messageID, sessionID: session.id, type: "user", delivery: input.delivery ?? "steer" })
      if (existing) return existing
      return yield* Effect.gen(function* () {
        const item = yield* restore(SessionPrompt.prepare({ session, messageID, input }))
        if (session.revert) yield* SessionRevert.commit(bus, session)
        return yield* admission.admit({ id: messageID, sessionID: session.id, item })
      }).pipe(instances.provide(session), Effect.provideService(Database.Service, database), Effect.provideService(FSUtil.Service, fs))
    }).pipe(Effect.catchTag("SessionInbox.LifecycleConflict", () => new PromptConflictError({ sessionID, messageID })))
    if (input.resume !== false) yield* execution.wake(sessionID)
    return admitted
  })))
```

- `packages/core/src/session/prompt.ts` — `SessionPrompt.prepare`: runs the `session.prompt` hook, materializes file/data-URL/blob attachments (20 MiB cap, image resize for png/jpeg/gif/webp/bmp), resolves skills (`Skill.prepare`), returns a `SessionInbox.Item` ([`opencode/packages/core/src/session/prompt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/prompt.ts#L34-L91)).
- `packages/core/src/session/inbox.ts` — `SessionInbox` admit/deliver/cancel/steer/queue with `Promotable`, delivery modes `steer` (default) and `queue`, control items (`compaction`, `move`), and per-aggregate serialization.
- `packages/core/src/session/compaction.ts`, `packages/core/src/session/instructions.ts`, `packages/core/src/session/instruction-state.ts`, `packages/core/src/session/history.ts`, `packages/core/src/session/context.ts`, `packages/core/src/session/title.ts`, `packages/core/src/session/usage.ts`, `packages/core/src/session/revert.ts`, `packages/core/src/session/move.ts`, `packages/core/src/session/shell.ts`, `packages/core/src/session/diff.ts`, `packages/core/src/session/background.ts`, `packages/core/src/session/subagent-job.ts`, `packages/core/src/session/subagent-completion.ts`.

Spec authority for this is `specs/v2/session.md` ([`opencode/specs/v2/session.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/specs/v2/session.md#L5-L23)):

```md
## Prompt Admission Precedes Execution
`Session.prompt(...)` publishes one durable `session.inbox.enqueued` fact whose projection inserts one `session_inbox` row before advisory execution begins ...
- `steer` is the default. Steers deliver in enqueue order at the next Safe Step Boundary ...
- `queue` remains pending while the Session can continue ...
```

### 5.5 Tool system

**Registry.** `packages/core/src/tool.ts` owns the Location-scoped Tool service: registration (`Tool.Service.transform`), effective lookup, execution, Code-Mode catalog building, image normalization ([`opencode/packages/core/src/tool.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool.ts#L44-L52)):

```ts
export interface Interface extends State.Transformable<Editor> {
  readonly list: () => Effect.Effect<ReadonlyArray<Tool.Info & { readonly id: string }>>
  readonly snapshot: (permissions?: Permission.Ruleset) => Effect.Effect<Snapshot>
  readonly check: (input: CheckInput) => Effect.Effect<CodeMode.Result>
}
```

The runtime (`packages/core/src/tool/runtime.ts`) converts tool input/output schemas to JSON Schema for the provider and decodes/validates input; it wraps foreign failures in `Tool.Error` at the untrusted boundary ([`opencode/packages/core/src/tool/runtime.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/runtime.ts#L30-L46)):

```ts
export const execute = (tool, input, context) => Effect.gen(function* () {
  const decoded = yield* decodeInput(tool, input)
  // Tool implementations declare `Tool.Error` but plugins can fail with anything at
  // runtime ... the declared contract is enforced here at the untrusted boundary.
  const result = yield* tool.execute(decoded, context).pipe(
    Effect.mapError((error) => error instanceof Tool.Error ? error : new Tool.Error({ message: error instanceof globalThis.Error ? error.message : String(error) })))
  ...
})
```

[`opencode/packages/core/src/tool/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool/AGENTS.md#L51-L61) states the split: registration has no permission dependency; filtering is catalog visibility, not authorization; leaves own resolution/permission/side-effect ordering; only expected typed errors become `ToolFailure` (never `catchCause`, because interruption and defects must survive).

**Built-in tools** live in `packages/core/src/tool/plugin/`:

| Tool name | File | Notes |
|---|---|---|
| `read` | `read.ts` | backs `packages/core/src/tool/read-filesystem.ts` |
| `edit` | `edit.ts` | shared `edit` permission action |
| `write` | `write.ts` | shared `edit` permission action |
| `patch` | `patch.ts` | shared `edit` permission action |
| `glob` | `glob.ts` | |
| `grep` | `grep.ts` | |
| `shell` | `shell.ts` | alias: calls to `bash` run as `shell` |
| `skill` | `skill.ts` | |
| `subagent` | `subagent.ts` | spawns child sessions |
| `todowrite` | `todo.ts` | |
| `webfetch` | `webfetch.ts` | |
| `websearch` | `websearch.ts` | |
| `question` | `question.ts` | asks the user |
| `experimental_image_generate` | `image-generate.ts` | |
| `session_rename`, `session_move` | `opencode.ts` | `opencode` namespace; `session_move` re-homes the session |
| `worktree_create`, `worktree_list`, `worktree_remove` | `opencode.ts` | `opencode` namespace |
| `models` | `opencode.ts` | searches available models |
| `list_mcp_resources`, `read_mcp_resource` | `mcp-resource.ts` | MCP resources |
| `artifact_create`, `artifact_read`, `artifact_update`, `artifact_delete` | `artifact.ts` | |
| `schedule`, `schedule_create`, `schedule_list`, `schedule_pause`, `schedule_resume`, `schedule_delete` | `schedule.ts` | |
| `execute` | (Code Mode) `packages/core/src/codemode` + `tool.ts` | reserved name; runs confined programs over namespaced tools |

**Code Mode.** `packages/core/src/tool.ts` builds a Code-Mode inventory and an `execute` tool (`CodeModeTool.create` / `CodeModeTool.catalog`) and exposes non-Code-Mode tools directly; `codemode: false` keeps a tool on the provider native tool list; tools default into Code Mode ([`opencode/packages/core/src/tool.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/tool.ts#L251-L298)):

```ts
snapshot: Effect.fn("Tool.snapshot")((permissions) => Effect.sync(() => {
  const direct = codeModeEnabled ? new Map(Array.from(active).filter(([, t]) => t.options?.codemode === false)) : active
  const codeModeTools = new Map(Array.from(active).filter(([, t]) => t.options?.codemode !== false))
  const codeModeTool = codeModeEnabled ? CodeModeTool.create(codeModeInventory, run, permission) : undefined
  ...
}))
```

Built-in tool plugin registration order is declared in the internal plugin list (`packages/core/src/plugin/internal.ts#L244-L283`): `ToolInputRepairPlugin`, `ConfigWorktreePlugin`, `ConfigMcpPlugin`, `McpCodeModeDefaultsPlugin`, `WellKnownPlugin`, `VcsGitPlugin`, `AgentPlugin`, `PlanPlugin`, `CommandPlugin`, `GoalPlugin`, `SkillPlugin`, `VcsHgPlugin`, `ModelsDevPlugin`, `...ProviderPlugins`, `...WebSearchPlugins`, `PatchTool.Plugin`, `...OptimizePlugin.Plugins`, `VerbosityPlugin`, `IdentityPlugin`, `EditTool.Plugin`, `GlobTool.Plugin`, `GrepTool.Plugin`, `ImageGenerateTool.Plugin`, `OpenCodeTools.Plugin`, `McpResourceTools.Plugin`, `QuestionTool.Plugin`, `ReadTool.Plugin`, `ArtifactTools.Plugin`, `ScheduleTools.Plugin`, `ShellTool.Plugin`, `SkillTool.Plugin`, `SubagentTool.Plugin`, `TodoTool.Plugin`, `WebFetchTool.Plugin`, `WebSearchTool.Plugin`, `WriteTool.Plugin`, `WarmingPlugin.Plugin`.

Spec authority: `specs/v2/tools.md` ([`opencode/specs/v2/tools.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/specs/v2/tools.md#L167-L177)) lists the laws (single execution, codec boundary, canonical representation, metadata opt-in, durable identity, scoped registration, captured execution, per-call rejection, storage encapsulation).

### 5.6 Provider / model integration
- `packages/core/src/provider.ts` — Location-scoped Provider service holding `Definition{provider, models, sourceConnection}`. `builtins` is a map of ~90 native `@opencode/ai/providers/*` entrypoints loadable by name (chat/messages/responses/images/etc. variants) ([`opencode/packages/core/src/provider.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/provider.ts#L46-L181)); npm loading shells through Arborist via `Npm.add`, with an AI-SDK package prefix concept (`aisdk:` and the legacy `@opencode-ai/ai/` scope migration).
- `packages/core/src/model.ts`, `packages/core/src/model-resolver.ts`, `packages/core/src/model-retry.ts`, `packages/core/src/variant.ts`, `packages/core/src/aisdk*.ts` (AI-SDK bridge).
- `packages/core/src/models-dev.ts` — the models.dev catalog decoder (prices/limits/capabilities), backed by a bundled snapshot and a V1→V2 upgrader ([`opencode/packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts#L1-L24)). The snapshot itself is large: `packages/core/src/models-dev/snapshot.txt` (8.0 MB) and `packages/core/src/models-dev/v1.ts`.
- Provider plugin layer: `packages/core/src/plugin/provider/` (~35 files: `openai`, `anthropic`, `google-vertex`, `amazon-bedrock`, `openrouter`, `opencode`, `github-copilot`, `gitlab`, `dynamic`, plus the `claude-agent/` tree with `agent-sdk`, `language-model`, `session`). `packages/core/src/github-copilot/` holds `chat/` and `responses/`.
- `packages/ai` (`@opencode/ai`) is the unified client: `ai-client.ts`, `llm.ts`, `loop.ts`, `tool.ts`, `route/{client,executor}`, `decision.ts`, media clients (image/speech/transcription/video), `providers/*` (73 entries), `protocols/*` (~50 wire codecs: openai-chat/responses, anthropic-messages, gemini, bedrock-converse/event-stream, cohere, mistral, xai, zai, alibaba, cloudflare, etc.), and `effect.ts` re-exporting `LLMClient`.

### 5.7 MCP support
`packages/core/src/mcp/` — `index.ts` (Service, `ServerName`, status, tools/prompts), `client.ts`, `connection.ts`, `pool.ts`, `stdio.ts`, `socket-client.ts`, `oauth.ts`, `instructions.ts`. MCP installs one stable tool transform that reads its latest discovered tools (`packages/core/src/tool/AGENTS.md#L45`), tools can be Code-Mode eligible, and prompts/resources are exposed (`packages/core/src/tool/plugin/mcp-resource.ts`). CLI has `mcp list/add/auth/logout`; per-server OAuth is handled in `mcp/oauth.ts`.

### 5.8 Permissions
`packages/core/src/permission.ts` — a Location-scoped `Permission` service evaluating `Ruleset` (wildcard action/resource) with `ask`/`allow`/`deny`, `Unattended` rules for schedule checks, saved rules per project (`packages/core/src/permission/saved.ts`), and a `permission.evaluate` plugin hook. Declines tunnel as defects (`DeclinedError`) so blanket `mapError` does not convert a user's decline into model output ([`opencode/packages/core/src/permission.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/permission.ts#L256-L288)):

```ts
const assert = Effect.fn("Permission.assert")((input) => Effect.gen(function* () {
  ...
  if (result.effect === "deny") return yield* new BlockedError({ ... })
  if (result.effect === "allow") return
  const item = yield* create(request(input, result.message), input.agent)
  return yield* restore(Deferred.await(item.deferred)).pipe(
    // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which must not
    // convert a user's decline into model-facing tool output ...
    Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
    Effect.ensuring(Effect.sync(() => pending.delete(item.request.id))))
}))
```

### 5.9 Config
- `packages/schema/src/config.ts` defines the `opencode.json` schema; fields include `shell`, `model`, `default_agent`, `update`, `share`, `enterprise`, `username`, `timezone`, `permissions`, `policies`, `agents`, `snapshots`, `watcher`, `formatter`, `lsp`, `media`, `tool_output`, `mcp`, `compaction`, `skills`, `commands`, `instructions`, `references`, `websearch`, `plugins`, `worktree`, `warming`, `providers`, `experimental`. Sub-schemas in `packages/schema/src/config/*.ts` (`agent`, `command`, `compaction`, `experimental`, `flag`, `formatter`, `lsp`, `mcp`, `media`, `model`, `plugin`, `policy`, `provider`, `reference`, `shell`, `tool-output`, `warming`, `watcher`, `websearch`, `worktree`).
- `packages/core/src/config.ts` + `packages/core/src/config/{discovery,normalize,managed,markdown,variable,watch,integration}.ts` + `packages/core/src/config/plugin/*` (one module per config domain that registers itself via the self-export pattern, e.g. `config/plugin/agent.ts`).
- Flags live in `packages/schema/src/config/flag.ts` and are read with `Flag.enabled("<key>")` from `@opencode/core/flag`; env `OPENCODE_FLAGS`, config `experimental.*` ([`opencode/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/AGENTS.md#L183-L189)).
- Repo example config [`opencode/.opencode/opencode.jsonc`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/.opencode/opencode.jsonc#L1-L22) shows `$schema: https://opencode.ai/config.json`, `references`, `mcp`, `tools`, `experimental.part_rows`.

### 5.10 Plugin system
- `packages/core/src/plugin.ts` + `packages/core/src/plugin/` — `service.ts`, `host.ts`, `supervisor.ts`, `module.ts`, `hooks.ts`, `identity.ts`, `instance.ts`, `sdk.ts`, `plan.ts`, `goal.ts`, `agent.ts`, `command.ts`, `skill.ts`, `optimize.ts`, `verbosity.ts`, `warming.ts`, `tool-input-repair.ts`, `update.ts`, `models-dev.ts`, `mcp-codemode-defaults.ts`, and the `provider/`, `websearch/`, `vcs/`, `system-prompt/`, `skill/`, `goal/`, `command/` subdirs.
- `packages/core/src/plugin/internal.ts` is the **built-in plugin registry**: it declares the Core `services`/`requirements` layer graph and the `pre`/`post` plugin lists, plus `guarded` IDs (`OpencodePlugin.id`, `ConfigPolicyPlugin.Plugin.id`) that repo config cannot remove ([`opencode/packages/core/src/plugin/internal.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/internal.ts#L306-L328)):

```ts
export const guarded: ReadonlySet<string> = new Set([OpencodePlugin.id, ConfigPolicyPlugin.Plugin.id])
export const list = Effect.fn("PluginInternal.list")(function* () {
  const context = Context.pick(...services)(yield* Effect.context<Requirements>())
  const resolve = (plugins) => plugins.map((plugin) => ({ id: plugin.id, effect: (host) => plugin.effect(host).pipe(Effect.provide(context)), revision: "internal", source: { type: "builtin" } }))
  return { pre: resolve(pre), post: resolve(post) }
})
```
- `packages/plugin` (`@opencode/plugin`) is the public API: `promise/`, `effect/` (typed hooks for agent/model/tool/session/permission/provider/mcp/...), `tui/`, `gui/`, plus host/runtime/source loaders. The `effect/plugin.ts` `define()` helper backs every built-in.

### 5.11 LSP integration
On `dev`, LSP is **config surface only**: `packages/schema/src/config/lsp.ts` and `packages/schema/src/lsp-event.ts` exist, and `lsp` appears in `packages/schema/src/config.ts`, `packages/schema/src/event-manifest.ts`, and `packages/core/src/config/normalize.ts`, but there is no Core LSP client implementation on this branch. (The older 2.0 branch *does* ship a full LSP subsystem — see §10.) File writing/editing references LSP-adjacent formatting in `packages/core/src/tool/plugin/{write,edit}.ts` and `packages/core/src/file-mutation.ts`. Formatters are implemented (`packages/core/src/formatter.ts`, `packages/core/src/formatter/builtins.ts`).

### 5.12 Auth, credentials, accounts, integrations
- `packages/core/src/credential.ts` + `packages/core/src/credential/sql.ts`; `packages/schema/src/credential.ts` (+ `credential-legacy.ts`).
- `packages/core/src/integration.ts` + `packages/core/src/integration/connection.ts`; `packages/core/src/account/sql.ts`; `packages/core/src/oauth/page.ts` (OAuth landing page).
- `packages/server/src/auth.ts` (`ServerAuth.Config` password layer), `packages/server/src/pairing.ts` (device pairing), `packages/cli/src/commands/handlers/auth/*` (list/login/logout/export/import/switch), `packages/cli/src/services/remote-tunnel.ts` (remote tunnel/pairing).
- GitHub Copilot + GitLab + Claude Agent provider auth flow through the provider plugins and `@opencode/ai` protocols.

### 5.13 Event bus & storage (event sourcing)
- `packages/core/src/bus.ts` — the durable `Bus`: per-aggregate monotonic sequence (`EventSequenceTable`), transactional event insert + projector run under a KeyedMutex, an ordered per-aggregate `log({after, follow})` with a `log.synced` watermark marker, live/typed PubSub subscriptions, `replay`, `remove`, `claim`, and `Location`-scoped routing ([`opencode/packages/core/src/bus.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/bus.ts#L150-L181)):

```ts
export interface Interface {
  readonly publish: <D>(definition: D, data: Event.Data<D>, options?: PublishOptions) => Effect.Effect<Event.Payload<D>>
  readonly publishAll: <I>(events: I) => Effect.Effect<PublishResult<I>>
  readonly subscribe: Subscribe
  readonly log: (input: { aggregateID: string; after?: number; follow?: boolean }) => Stream.Stream<LogItem>
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (event: SerializedEvent, options?: {...}) => Effect.Effect<void>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}
```

  Durable commit runs projectors and the optional `commit` local hook inside one SQLite transaction, then notifies subscribers and wakes durable log followers ([`opencode/packages/core/src/bus.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/bus.ts#L290-L449)).
- `packages/core/src/session/projector.ts` — Session projections (messages, inbox, execution claims, stats) folded from durable events; `packages/core/src/session/{message,message-updater,event,stored,projector,sql}.ts`.
- Storage: `packages/core/src/database/` — Drizzle (`drizzle.ts`, `drizzle/`), migrations (`migration/`, `migration.gen.ts`, `schema.gen.ts`), SQLite drivers `sqlite.{bun,node,workerd}.ts`, V1→V2 migration (`v1-migration*.ts`). Schema authority is `packages/schema/src/durable-event-manifest.ts` + `event-manifest.ts` + `event.ts` + `event-log.ts`.

### 5.14 Telemetry / observability
`packages/util/src/observability/{logging,otlp,shared}.ts` and `packages/util/src/observability.ts`. The CLI wires `Observability.layer({ endpoint: OTEL_EXPORTER_OTLP_ENDPOINT, headers, client, version, channel })` ([`opencode/packages/cli/src/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/index.ts#L150-L158)); spans carry `gen_ai.*` and `session.id` attributes (see `step.ts`). `packages/server/src/request-tracing.ts` handles HTTP tracing.

### 5.15 ACP (Agent Client Protocol)
`packages/cli/src/acp/` is a full ACP server: `agent.ts`, `client.ts`, `connection.ts`, `service.ts`, `capabilities.ts`, `catalog.ts`, `child.ts`, `prompt.ts`, `content.ts`, `directories.ts`, `elicitation.ts`, `permission.ts`, `replay.ts`, `sessions.ts`, `tool.ts`, `translate.ts`, `turn.ts`, `compaction.ts`, `config-option.ts`, `error.ts`. Command `opencode acp` 