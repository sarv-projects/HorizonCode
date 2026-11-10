
---

## 4. Entry points

**CLI launcher (Node).** `packages/cli/package.json` declares `bin.opencode` → `./bin/opencode.cjs` (and `opencode2` → `./bin/opencode2.cjs`). The `.cjs` is a tiny Node shim that spawns the real Bun binary and forwards signals ([`opencode/packages/cli/bin/opencode.cjs`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/bin/opencode.cjs#L10-L24)):

```js
function run(target) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  child.on("error", (error) => { console.error(error.message); process.exit(1) })
  const forwarders = {}
  for (const signal of forwardedSignals) {
    forwarders[signal] = () => { try { child.kill(signal) } catch {} }
    process.on(signal, forwarders[signal])
  }
```

**Real program.** `packages/cli/src/index.ts` - an Effect program wiring the command tree, signal handling, heap/CPU profiling, plugin runtime, and `NodeRuntime.runMain` teardown ([`opencode/packages/cli/src/index.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/index.ts#L44-L99)):

```ts
const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  upgrade: () => import("./commands/handlers/upgrade"),
  uninstall: ..., acp: ..., api: ...,
  auth: { list: ..., login: ..., logout: ..., export: ..., import: ..., switch: ... },
  debug: { agents, config, "heap-dump": ..., paths: ... },
  mcp: { list, add, auth, logout },
  plugin: { list, add, check, update, remove },
  models: ..., stats: ..., mini: ..., run: ..., pair: ..., reload: ...,
  session: { list, delete, export, import },
  service: { start, restart, status, stop, get, set, unset },
  serve: ...,
})
```

`package.json` `dev` = `bun run --cwd packages/cli src/index.ts`; `dev:live` connects a dev TUI to the elected background server; `dev:desktop`/`dev:web`/`dev:console`/`dev:site` target other surfaces.

**TUI launch.** `packages/cli/src/commands/handlers/default.ts` resolves or starts the background server via `ServerConnection.resolve`, then calls `run(...)` from `@opencode/tui` ([`opencode/packages/cli/src/commands/handlers/default.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/default.ts#L96-L120)):

```ts
yield* run({
  app: { name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT, version: OPENCODE_VERSION, channel: ..., highlights: ... },
  server: { endpoint: server.endpoint, local: requestedServer === undefined,
    service: service ? { reconnect, restart } : undefined },
  args: { continue: input.continue, sessionID: sessionExists ? session : undefined,
    newSessionID: sessionExists ? undefined : session, prompt: ..., auto: input.auto || input.yolo || ... },
  config: { path: config.path, get: () => runPromise(config.get()), update: ... },
  updater: { remote, subscribe, check, apply }, packages: { prepare },
  environment: requestedServer === undefined ? Env.session() : undefined, ...
})
```

**Server entry.** `packages/cli/src/commands/handlers/serve.ts` → `ServerProcess.run({ mode: service|stdio|default, hostname, port, cors })` ([`opencode/packages/cli/src/commands/handlers/serve.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/commands/handlers/serve.ts#L6-L16)).

**Other surface entries:** `packages/tui/src/index.tsx` (TUI root; dev entry `packages/cli/dev/entry.ts` wraps it for Vite HMR), `packages/desktop/src/main/index.ts` + `renderer/index.tsx` (Electron), `packages/sdk/src/index.ts`, `packages/app/src` (web), `sdks/vscode/src/extension.ts`, `services/*` Workers, `packages/console/app`, `packages/stats/*`, `packages/web`.

---

## 5. Core subsystems (file paths)

### 5.1 Agent system
Agents are **runtime data**, not Markdown files. `packages/core/src/agent.ts` is a Location-scoped `State`-backed service with `get/resolve/select/list` plus a mutable `Editor` for plugins ([`opencode/packages/core/src/agent.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/agent.ts#L40-L47)):

```ts
export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID) => Effect.Effect<Selection>
  readonly list: () => Effect.Effect<Info[]>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}
```

Built-ins are declared by the internal `AgentPlugin` at `packages/core/src/plugin/agent.ts`: **build** (`Agent.defaultID`, default), **general** (subagent), **explore** (subagent; read-only search specialist with `PROMPT_EXPLORE`), **compaction** (hidden), **title** (hidden, `PROMPT_TITLE`), **summary** (hidden, `PROMPT_SUMMARY`) - registered through `ctx.agent.transform(editor => editor.update(...))` ([`opencode/packages/core/src/plugin/agent.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/agent.ts#L52-L117)):

```ts
export const Plugin = define({
  id: "opencode.agent",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      editor.update(Agent.defaultID, (item) => { item.name = Agent.Name.make("Build"); item.mode = "primary"; item.permissions.push({ action: "question", resource: "*", effect: "allow" }) })
      editor.update(Agent.ID.make("general"), (item) => { item.mode = "subagent"; item.permissions.push({ action: "question", ... "deny" }, { action: "subagent", ... "deny" }) })
      editor.update(Agent.ID.make("explore"), (item) => { item.system = PROMPT_EXPLORE; item.mode = "subagent"; item.permissions.push(...) })
      editor.update(Agent.ID.make("compaction"), (item) => { item.hidden = true })
      editor.update(Agent.ID.make("title"), (item) => { item.hidden = true; item.system = PROMPT_TITLE; item.permissions.push({ action: "*", resource: "*", effect: "deny" }) })
      editor.update(Agent.ID.make("summary"), (item) => { item.hidden = true; item.system = PROMPT_SUMMARY; ... })
    })
  }),
})
```

`PlanPlugin` (`packages/core/src/plugin/plan.ts`) adds **plan**: `mode: "primary"`, denies `edit` except in `~/.opencode/plan`, and maintains an enter/leave `<system-reminder>` via `session.context` + `session.created`/`agent.selected` hooks ([`opencode/packages/core/src/plugin/plan.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/plan.ts#L27-L53)).

```ts
export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const directory = path.join(global.home, ".opencode", "plan")
    yield* ctx.agent.transform((editor) => editor.update(plan, (item) => {
      item.mode = "primary"
      item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
      item.permissions.push({ action: "edit", resource: path.join(directory, "*"), effect: "allow" })
    }))
    yield* ctx.tool.hook("execute.after", (event) => { /* remap BlockedError for edit/write/patch */ })
    yield* ctx.session.hook("context", (event) => { /* re-assert / remove reminder */ })
  }),
})
```

Runtime agent and command `.md` files exist only for this repo's own config under `.opencode/agent/translator.md` and `.opencode/command/*.md`; user agents/commands are discovered from config via `packages/core/src/config/plugin/{agent,command}.ts` and `packages/core/src/config/markdown.ts`. Model prompts render from `packages/core/src/session/runner/prompt/system.txt`.

### 5.2 Session loop / run
The core is a durable, event-sourced, step-based loop:

- `packages/core/src/session/runner/llm.ts` - the **drain loop** (`SessionRunner.drain`). It promotes inbox input, handles `compaction`/`move` controls, then loops `advanceToStep` → `runStep`. Each `runStep` reloads context, estimates/compacts, builds the transcript, and calls `steps.attempt` ([`opencode/packages/core/src/session/runner/llm.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/llm.ts#L233-L315)).
- `packages/core/src/session/runner/step.ts` - **one logical step = one `llm.stream` call**. Streams provider events, spawns local tool fibers eagerly, classifies tool exits, and publishes durable `Step.Ended`/failure ([`opencode/packages/core/src/session/runner/step.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/runner/step.ts#L64-L135)).
- `packages/core/src/session/runner/{model,retry,to-llm-message,publish-llm-event,max-steps}.ts` — model resolution, retry policy, transcript conversion, event publishing, step-limit prompt.

```ts
// llm.ts — drain loop skeleton
const drain = Effect.fn("SessionRunner.drain", { root: true })(function* (input) {
  ...
  const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() => Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      while (true) {
        if (lifecycle.isClosed()) { yield* restore(modelTransport.close(sessionID)); return DrainResult.Reloaded({...}) }
        const pending = yield* SessionInbox.serialized(sessionID, ...)
        if (pending?.type === "move") return DrainResult.Moved({...})
        if (pending?.type === "compaction") { ... yield* compaction.compact({...}); continue }
        if (!force && !continuing && (!pending || ...)) { /* idle boundary; may admit input */ }
        const ready = yield* restore(Effect.gen(function* () {
          const selected = yield* prepareContext(sessionID)
          const promoted = yield* SessionInbox.promote(db, bus, sessionID, ...)
          ...
          return { _tag: "Ready", context: yield* context.load(selected) }
        }))
        if (ready) return ready
      }
    })))
  while (true) {
    const next = yield* advanceToStep()
    if (next._tag !== "Ready") return next
    continuing = yield* runStep(next.context, step)
    stepped = true; step++; force = false; entering = false
  }
})
```

```ts
// step.ts — one llm.stream call, eager tool fibers
const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
  Stream.runForEach((event) => Effect.gen(function* () {
    if (publisher.record().providerFailed) return
    if (!publisher.hasStarted()) yield* Fiber.join(pendingStartSnapshot)
    yield* publisher.publish(event)
    if (event.type !== "tool-call" || event.providerExecuted) return
    toolRuns.push({ call: event, fiber: yield* Effect.uninterruptibleMask((restore) =>
      restore(executeTool(event)).pipe(
        Effect.flatMap(toolOutput.truncate),
        Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome)),
        Effect.catchTag("Tool.Error", (error) => publisher.failTool(event.id, toSessionError(error), error.metadata)),
      )).pipe(Effect.forkScoped) })
  })),
  Effect.ensuring(publisher.flush()),
)
```

`packages/core/src/session/runner/index.ts` defines the `Service`/`DrainResult`/`RunError`; `packages/core/src/session/model-request.ts` builds the provider request; `packages/core/src/session/model-transport.ts` owns WebSocket/continuation transport.

### 5.3 Execution ownership & coordination
- `packages/core/src/session/execution.ts` - process-global, Session-ID keyed `SessionExecution`. Commits a **write-ahead execution claim** at busy-period start, releases it on success/failure/user-interrupt, and *preserves it on shutdown* so the next start resumes work ([`opencode/packages/core/src/session/execution.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/execution.ts#L73-L83)):

```ts
// Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
// transaction as the started event. Terminals release it — except shutdown interruption, which
// preserves the claim so the next server start resumes the turn. A claim that survives with no
// terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
// recovery is a property of the database, never of a shutdown hook that may not run.
const claimOnCommit = (sessionID) => ({ commit: () => store.claim(sessionID) })
const releaseOnCommit = (sessionID) => ({ commit: () => store.release(sessionID) })
```

- `packages/core/src/session/run-coordinator.ts` - `SessionRunCoordinator`: joins same-Session resumes, coalesces prompt wakeups ("doorbell"), lets different Sessions run concurrently, implements interrupt/`awaitIdle` ([`opencode/packages/core/src/session/run-coordinator.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/session/run-coordinator.ts#L27-L54)):

```ts
/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell ...
 */
//      idle ──wake|run──▶ execution (one fiber)
//                 drain ⟲ doorbell rung mid-drain
//      doorbell quiet ◀─────┴───────▶ doorbell rung
```

- `packages/core/src/session/execution/restart.ts` — startup recovery of claimed sessions (`SessionRestart`). `packages/core/src/session/run-coordinator.ts` + `execution.ts` + `restart.ts` together implement the AGENTS.md 