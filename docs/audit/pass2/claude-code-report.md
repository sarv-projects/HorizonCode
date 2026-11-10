# Claude Code (leaked source) — Deep Code-Organization & Design Tour

Tour target: [`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68) (org `codeaashu`, TypeScript, described as *"Claude Code is an agentic coding tool that lives in your terminal…"*).
Read-only: no repo file was modified. All paths below are absolute under [`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68).

---

## 1. Identity

**What this repository is.** An archive of the leaked source of Anthropic's `@anthropic-ai/claude-code` CLI, plus house-written documentation, an exploration MCP server, a build/packaging tooling layer, a Next.js web client, and a set of "build-out" prompts for getting the leaked tree to actually run. The README ([`claude-code/README.md`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/README.md)) states the source was recovered on 2026-03-31 from a `.map` file shipped in the published npm package (found by @Fried_rice) and that the original unmodified tree is kept in a `backup` branch.

**Package metadata** (`claude-code/package.json` (path not found in the pinned clone, not verified)):

```json
{
  "name": "@anthropic-ai/claude-code",
  "version": "0.0.0-leaked",
  "main": "src/entrypoints/cli.tsx",
  "bin": { "claude": "src/entrypoints/cli.tsx" },
  "engines": { "bun": ">=1.1.0" },
  "packageManager": "bun@1.1.0"
}
```

**Scale actually measured in this checkout** (not the advertised numbers):

| Metric | Measured | README claim |
|---|---|---|
| Files under `src/` | 1,940 | ~1,900 |
| `.ts` / `.tsx` files | 1,916 | — |
| Lines of TS/TSX under `src/` | 519,426 | 512,000+ |
| Top-level entries in `src/` | 37 | — |

**Important fidelity caveat found while scanning.** The archive is not uniformly "original TypeScript". 554 files under `src/` embed an inline base64 `//# sourceMappingURL=data:application/json;base64,…` trailer, and 395 files contain the React Compiler runtime call `_c(`. Some of those files are transpiled build output rather than hand-written source (e.g. `claude-code/src/replLauncher.tsx` (path not found in the pinned clone, not verified) is a 23-line transpiled stub with an inlined original-source map, while `claude-code/src/Tool.ts` (path not found in the pinned clone, not verified), `claude-code/src/query.ts` (path not found in the pinned clone, not verified) and `claude-code/src/tools.ts` (path not found in the pinned clone, not verified) are pristine hand-written TypeScript). Anybody reading this repo must expect a *mixture* of original sources and post-React-Compiler output, and must not assume every file is the author's literal source.

**Also partial.** Feature-gated modules that are required at runtime do not all exist in the archive. Verified missing: `src/proactive/`, `src/jobs/`, `src/tools/TungstenTool/`, `src/tools/DiscoverSkillsTool/`, `src/tools/WorkflowTool/`, `src/tools/SuggestBackgroundPRTool/`, `src/tools/SendUserFileTool/`, `src/tools/MonitorTool/`, `src/tools/SnipTool/`, `src/tools/ListPeersTool/`, `src/tools/CtxInspectTool/`, `src/tools/OverflowTestTool/`, `src/tools/TerminalCaptureTool/`, `src/tools/WebBrowserTool/`, `src/tools/PushNotificationTool/`, `src/tools/SubscribePRTool/`, `src/tools/VerifyPlanExecutionTool/`, `src/tools/REPLTool/`, `src/tools/SleepTool/SleepTool.ts` (only `prompt.ts` survives), `src/services/skillSearch/`, `src/coordinator/workerAgent.ts`. In the real build those are deleted by `bun:bundle` feature flags; in this archive they are simply absent.

**Stack** (`package.json` dependencies): Bun runtime; `@anthropic-ai/sdk@^0.39`; `@commander-js/extra-typings`; `@growthbook/growthbook`; `@modelcontextprotocol/sdk@^1.12`; OpenTelemetry SDK packages; `@xterm/*`; `react@19` + `react-reconciler@0.31` (Ink-style renderer, vendored in `src/ink`); `zod@^3.24` in `package.json` though the code imports the v4 API path `zod/v4` (stale manifest vs. code); `lodash-es`; `chalk`; `fuse.js`; `highlight.js`; `marked`; `diff`; `execa`; `picomatch`; `proper-lockfile`; `node-pty`; `ws`; `undici`; `chokidar`; `qrcode`; `yaml`.

**Repo-published artifacts riding along.**

| Path | What it is |
|---|---|
| `claude-code/mcp-server` (path not found in the pinned clone, not verified) | npm package `warrioraashuu-codemaster@1.1.0` — MCP server that lets any MCP client explore the leaked `src/` |
| `claude-code/web` (path not found in the pinned clone, not verified) | `claude-code-web@0.1.0` — Next.js 14 chat UI for a Claude backend |
| `claude-code/server.json` (path not found in the pinned clone, not verified) | MCP registry metadata for that package (stdio transport) |
| `claude-code/vercel.json` (path not found in the pinned clone, not verified) | Hosts `mcp-server/api/index.ts` on Vercel with `/mcp`, `/sse`, `/messages`, `/health` routes |
| `claude-code/Dockerfile` (path not found in the pinned clone, not verified), `claude-code/docker` (path not found in the pinned clone, not verified) | Container build of the CLI (root) and of a PTY web terminal (docker/) |
| `claude-code/gitpretty-apply.sh` (path not found in the pinned clone, not verified) | Applies per-file emoji commit history from a third-party `gitpretty` repo |

---

## 2. Top-level map

```
`claude-code/` (path not found in the pinned clone, not verified)
├── agent.md                 # repo agent operating guide (rules/workflow/validation)
├── Skill.md                 # repo "skill": architecture, conventions, key files
├── README.md                # leak story, docs index, architecture summary, MCP setup
├── CONTRIBUTING.md          # docs/tooling/MCP only — src/ must not be modified
├── LICENSE, .DS_Store, .github/FUNDING.yml
├── package.json             # @anthropic-ai/claude-code, bin: claude
├── package-lock.json, bun.lock, bunfig.toml, biome.json, tsconfig.json
├── Dockerfile               # 2-stage bun build → dist/cli.mjs runtime
├── docker/                  # PTY web-terminal container (node-pty)
├── gitpretty-apply.sh       # emoji per-file commit beautifier
├── server.json, vercel.json # MCP registry + Vercel hosting for mcp-server
├── docs/                    # architecture, tools, commands, subsystems, bridge, exploration-guide
├── prompts/                 # 17 numbered build-out prompts (00–16)
├── scripts/                 # esbuild bundler, web bundler, dev/CI scripts, smoke tests
├── mcp-server/              # standalone exploration MCP server (npm package)
├── web/                     # Next.js chat/terminal web UI
└── src/                     # ← the leaked Claude Code CLI (1,940 files)
```

**Docs (`claude-code/docs` (path not found in the pinned clone, not verified)).** Six markdown guides, useful as a map but not authoritative — several numbers in them are off versus the source (e.g. `docs/tools.md` claims ~40 tools and a `buildTool({... inputSchema: z.object(...)})` shape with `checkPermissions()` returning `{granted…}`; the real `Tool` type returns a `PermissionResult` discriminated union `allow | ask | deny`). Files: `architecture.md`, `tools.md`, `commands.md`, `subsystems.md` (Bridge, MCP, permissions, plugins, skills, tasks, memory, coordinator, voice, services), `bridge.md`, `exploration-guide.md`.

**Prompts (`claude-code/prompts` (path not found in the pinned clone, not verified)).** This directory is *not* the agent's prompt library; it is a 17-file, ordered rebuild plan for making the leaked tree runnable again: `00-overview.md` (index), `01-install-bun-and-deps.md`, `02-runtime-shims.md` (create a `bun:bundle` shim + `MACRO` globals), `03-build-config.md` (esbuild single-file bundle), `04-fix-mcp-server.md`, `05-env-and-auth.md`, `06-ink-react-terminal-ui.md`, `07-tool-system.md`, `08-command-system.md`, `09-query-engine.md`, `10-context-and-prompts.md`, `11-mcp-integration.md`, `12-services-layer.md`, `13-bridge-ide.md`, `14-dev-runner.md`, `15-production-bundle.md`, `16-testing.md`. The real system prompt lives in TypeScript, in `claude-code/src/constants/prompts.ts` (path not found in the pinned clone, not verified) and per-tool `prompt.ts` modules.

**Scripts ([`claude-code/scripts/`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68/scripts)).** `build-bundle.ts` (esbuild, entry `src/entrypoints/cli.tsx`, plugins: `src-resolver` for tsconfig `baseUrl: "."` bare-`src/` imports, `bun:bundle` shim, `MACRO` define, output `dist/cli.mjs`), `build-web.ts`, `build.sh`, `ci-build.sh`, `dev.ts`, `package-npm.ts`, `bun-plugin-shims.ts` (Bun preload plugin mapping `bun:bundle` → `src/shims/bun-bundle.ts`, referenced by `bunfig.toml`), `test-auth.ts`, `test-commands.ts`, `test-mcp.ts`, `test-services.ts`, `tsconfig.json`, `types.d.ts`.

---

## 3. Module graph + responsibilities (`src/`)

Measured size per top-level module (`.ts`/`.tsx` files -> lines). This is the real shape of the codebase: a very fat `utils/` + `components/` + `services/` layered under a small top-level core.

| Module | Files | Lines | Responsibility |
|---|---:|---:|---|
| `claude-code/src/utils` (path not found in the pinned clone, not verified) | 564 | 181,036 | Everything shared: shell exec, permissions, settings, model, tokens, git, hooks, teleport, sandbox, telemetry, attachments, session storage, worktrees, cron, etc. (329 top-level entries) |
| `claude-code/src/components` (path not found in the pinned clone, not verified) | 389 | 81,963 | Ink/React terminal UI: `messages/`, `permissions/`, `PromptInput/`, `design-system/`, dialogs, diff viewers, MCP UI |
| `claude-code/src/services` (path not found in the pinned clone, not verified) | 136 | 54,843 | `api/` (Anthropic client, retries, streaming, prompt-cache), `mcp/`, `oauth/`, `lsp/`, `analytics/` (GrowthBook + events), `compact/` (context compression), `plugins/`, `policyLimits/`, `remoteManagedSettings/`, `extractMemories/`, `teamMemorySync/`, `SessionMemory/`, `tools/` (tool orchestration) |
| `claude-code/src/tools` (path not found in the pinned clone, not verified) | 184 | 51,049 | The agent's tool implementations - one directory per tool (`<Tool>.ts|tsx`, `UI.tsx`, `prompt.ts`, `constants.ts`, helpers) |
| `claude-code/src/commands` (path not found in the pinned clone, not verified) | 191 | 27,035 | Slash commands (one dir or file per command), plus command loading/memoization helpers |
| `claude-code/src/ink` (path not found in the pinned clone, not verified) | 96 | 19,938 | Vendored Ink renderer: reconciler, host config, `Box`/`Text`, hooks (`use-input`, `use-stdin`, ...), terminal handling |
| `claude-code/src/hooks` (path not found in the pinned clone, not verified) | 104 | 19,308 | React hooks: `useCanUseTool`, `useMergedTools`, `useQueueProcessor`, `toolPermission/handlers/*`, IDE integration, input handling, notifs |
| `claude-code/src/bridge` (path not found in the pinned clone, not verified) | 32 | 12,741 | IDE/remote bridge: JWT auth, messaging protocol, permission callbacks, REPL bridge, session runner |
| `claude-code/src/cli` (path not found in the pinned clone, not verified) | 19 | 12,391 | Non-REPL front-ends: `print.ts` (headless/SDK turn loop), `structuredIO.ts`, `remoteIO.ts`, transports (WebSocket/SSE/CCR), `handlers/` |
| `claude-code/src/screens` (path not found in the pinned clone, not verified) | 3 | 5,980 | Full-screen UIs: `REPL.tsx` (~5,006 lines), `Doctor.tsx`, `ResumeConversation.tsx` |
| `claude-code/src/skills` (path not found in the pinned clone, not verified) | 20 | 4,086 | Skill loader (`loadSkillsDir.ts`), bundled skills (`bundled/*.ts`), MCP skill builders |
| `claude-code/src/native-ts` (path not found in the pinned clone, not verified) | 4 | 4,085 | Native TypeScript ports of native helpers |
| `claude-code/src/entrypoints` (path not found in the pinned clone, not verified) | 8 | 4,059 | `cli.tsx` (bootstrap fast-paths), `init.ts`, `mcp.ts` (Claude Code *as* an MCP server), `sdk/` schemas, `sandboxTypes.ts`, `agentSdkTypes.ts` |
| `claude-code/src/types` (path not found in the pinned clone, not verified) | 15 | 3,897 | Shared types, incl. `permissions.ts` and `command.ts` extracted to break import cycles |
| `claude-code/src/tasks` (path not found in the pinned clone, not verified) | 12 | 3,298 | Background task types: `LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `InProcessTeammateTask`, `LocalWorkflowTask`, `MonitorMcpTask`, `DreamTask`, `stopTask` |
| `claude-code/src/keybindings` (path not found in the pinned clone, not verified) | 14 | 3,173 | Keybinding schema, defaults, resolver, matching |
| `claude-code/src/server` (path not found in the pinned clone, not verified) | 17 | 3,009 | Server mode + `claude-code/src/server/web/pty-server.ts` (path not found in the pinned clone, not verified) (PTY WebSocket terminal), admin/auth/session stores |
| `claude-code/src/constants` (path not found in the pinned clone, not verified) | 22 | 2,691 | Product constants: `prompts.ts` (system prompt), `systemPromptSections.ts`, `tools.ts` (allow/deny sets), `betas.ts`, `figures.ts`, `oauth.ts`, `xml.ts`, `spinnerVerbs.ts` |
| `claude-code/src/bootstrap` (path not found in the pinned clone, not verified) | 1 | 1,760 | `state.ts`: process-global mutable state (session id, cwd, token counters, caches) |
| `claude-code/src/memdir` (path not found in the pinned clone, not verified) | 8 | 1,744 | Memory directory: `MEMORY.md` entrypoint, relevant-memory selection, memory ageing, team-memory paths/prompts |
| `claude-code/src/vim` (path not found in the pinned clone, not verified) | 5 | 1,518 | Vim mode: motions, operators, text objects, transitions |
| `claude-code/src/buddy` (path not found in the pinned clone, not verified) | 6 | 1,310 | Companion sprite easter egg (observer + reactions rendered in the REPL footer) |
| `claude-code/src/state` (path not found in the pinned clone, not verified) | 6 | 1,196 | `AppStateStore.ts` (`AppState` shape + defaults), `store.ts`, `selectors.ts`, `onChangeAppState.ts`, `AppState.tsx` |
| `claude-code/src/remote` (path not found in the pinned clone, not verified) | 4 | 1,131 | Remote sessions: `RemoteSessionManager`, `SessionsWebSocket`, SDK message adapter, permission bridge |
| `claude-code/src/context` (path not found in the pinned clone, not verified) | 9 | 1,013 | React context providers (notifications, stats, FPS, overlay) + `context.ts` system/user context collectors |
| `claude-code/src/upstreamproxy` (path not found in the pinned clone, not verified) | 2 | 742 | Upstream proxy configuration |
| `claude-code/src/query` (path not found in the pinned clone, not verified) | 5 | 693 | Query-loop support: `config.ts`, `deps.ts` (injectable model/compact deps), `stopHooks.ts`, `tokenBudget.ts`, `transitions.ts` |
| `claude-code/src/migrations` (path not found in the pinned clone, not verified) | 11 | 614 | Settings/config migrations |
| `claude-code/src/coordinator` (path not found in the pinned clone, not verified) | 1 | 370 | `coordinatorMode.ts` - multi-agent supervisor mode (worker tool allowlists, session-mode sync) |
| `claude-code/src/schemas` (path not found in the pinned clone, not verified) | 1 | 223 | Zod schemas for config |
| `claude-code/src/plugins` (path not found in the pinned clone, not verified) | 2 | 184 | Built-in plugin registry (`builtinPlugins.ts` + `bundled/`) |
| `claude-code/src/outputStyles` (path not found in the pinned clone, not verified) | 1 | 99 | Output-style presets (default/explanatory/learning) |
| `claude-code/src/shims` (path not found in the pinned clone, not verified) | 3 | 73 | `bun:bundle` shim, `MACRO` globals, preload |
| `claude-code/src/voice` (path not found in the pinned clone, not verified) | 1 | 55 | Voice-mode plumbing (STT lives in `services/voice*`) |
| `claude-code/src/moreright` (path not found in the pinned clone, not verified) | 1 | 26 | Small UI helper hook (`useMoreRight`) |

**Key top-level files** (all under `claude-code/src` (path not found in the pinned clone, not verified)):

| File | Lines | Role |
|---|---:|---|
| `main.tsx` | 4,684 | CLI entry: Commander program, ~150 flags, prefetch side-effects, REPL/print/remote dispatch |
| `query.ts` | 1,730 | `query()` - the streaming agent loop (compaction, tool execution, recovery, budgets) |
| `QueryEngine.ts` | 1,297 | `QueryEngine` class + `ask()` - headless/SDK turn engine over `query()` |
| `Tool.ts` | 794 | `Tool`/`ToolDef`/`ToolUseContext` types, `buildTool()`, `TOOL_DEFAULTS`, `findToolByName` |
| `commands.ts` | 758 | Command registry (`COMMANDS()`, `INTERNAL_ONLY_COMMANDS`), skill/plugin/workflow loading, remote/bridge allowlists |
| `setup.ts` | 478 | First-run setup (theme, trust, onboarding, terminal checks) |
| `history.ts` | 465 | Shell/prompt history persistence |
| `tools.ts` | 390 | Tool registry: `getAllBaseTools()`, `getTools()`, `assembleToolPool()`, deny-rule filtering |
| `interactiveHelpers.tsx` | 366 | REPL helper components/utilities |
| `cost-tracker.ts` | 336 | Token usage + USD cost accounting |
| `context.ts` | 190 | `getSystemContext()` (git status) and `getUserContext()` (CLAUDE.md, dirs) |
| `Task.ts` / `tasks.ts` | 127 / 40 | Task abstraction + todo-v2 gating |

---

## 4. Entry points

**Published entry (`bin`)** - `claude-code/src/entrypoints/cli.tsx` (path not found in the pinned clone, not verified) (303 lines). A deliberately tiny bootstrap whose every import is dynamic, so cheap paths load nothing:

```ts
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  // Fast-path for --version/-v: zero module loading needed
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`${MACRO.VERSION} (Claude Code)`)
    return
  }
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')
```

It also sets `COREPACK_ENABLE_AUTO_PIN=0`, bumps `--max-old-space-size=8192` when `CLAUDE_CODE_REMOTE=true`, applies an *ablation baseline* env preset for harness experiments, and hosts `--dump-system-prompt` (feature-gated) so prompt-sensitivity evals can extract the rendered system prompt. Everything else is `await import('../main.js')`.

**Real CLI (`claude-code/src/main.tsx` (path not found in the pinned clone, not verified), 4,684 lines).** Top-of-file side-effects fire *before* the heavy imports below them, on purpose:

```ts
profileCheckpoint('main_tsx_entry')
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js'
startMdmRawRead()                       // plutil/reg query subprocesses
import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js'
startKeychainPrefetch()                 // macOS keychain reads (OAuth + legacy key)
```

Then a Commander program (`@commander-js/extra-typings`, sorted help, positional options enabled) is defined at line 902 and given ~150 options/flags, including the classic surface: `-p/--print`, `--output-format text|json|stream-json`, `--input-format`, `--json-schema`, `--allowedTools/--disallowedTools/--tools`, `--mcp-config`, `--permission-mode` (`PERMISSION_MODES`), `--system-prompt`, `--append-system-prompt`, `--settings`, `--add-dir`, `--agents`, `--model`, `--effort`, `--fallback-model`, `--worktree`, `--tmux`, `--resume/-r`, `--continue/-c`, `--fork-session`, `--session-id`, `--agent`, and hidden experiment flags (`--bare`, `--agent-teams`, `--tasks`, `--proactive`, `--brief`, `--sdk-url`, `--teleport`, `--remote`, `--teammate-mode`).

**Other front doors**

| Entry | Path | Purpose |
|---|---|---|
| Interactive REPL | `claude-code/src/main.tsx` (path not found in the pinned clone, not verified) -> `claude-code/src/replLauncher.tsx` (path not found in the pinned clone, not verified) -> `claude-code/src/screens/REPL.tsx` (path not found in the pinned clone, not verified) | Renders `<App><REPL/></App>` into the vendored Ink root |
| Headless / SDK | `claude-code/src/cli/print.ts` (path not found in the pinned clone, not verified) | `-p` and `--output-format` turn loop; drives `QueryEngine` and `query()`; `structuredIO.ts`, `remoteIO.ts`, transports in `src/cli/transports/` |
| Claude Code as MCP server | `claude-code/src/entrypoints/mcp.ts` (path not found in the pinned clone, not verified) | `startMCPServer(cwd, debug, verbose)` exposes Claude Code's *own tools* over stdio MCP (`server name: 'claude/tengu'`), exposing `review` as a command |
| CLI subcommands | `claude-code/src/main.tsx` (path not found in the pinned clone, not verified) + `claude-code/src/cli/handlers` (path not found in the pinned clone, not verified) | `claude mcp ...`, `claude auth ...`, `claude plugin ...`, `claude server`, `claude ssh <host>`, `claude open <cc-url>`, `claude agents`, `claude doctor`, `claude update/install`, `claude setup-token`, ants-only `log/error/export/task/rollback/up` |
| Agent SDK schemas | ``claude-code/src/entrypoints/sdk/{coreSchemas` (path not found in the pinned clone, not verified),coreTypes,controlSchemas}.ts`, `claude-code/src/entrypoints/agentSdkTypes.ts` (path not found in the pinned clone, not verified) | Typed surface for embedding |
| Web PTY terminal | `claude-code/src/server/web/pty-server.ts` (path not found in the pinned clone, not verified) (+ `session-manager.ts`, `auth.ts`, `admin.ts`) | Browser terminal that execs the bundled CLI as a subprocess under `node-pty` |

**Startup sequence (interactive).** `cli.tsx` -> `main.tsx` (MDM/keychain prefetch in parallel with imports) -> Commander parse -> trust dialog / config `enableConfigs()` -> `init()` (`claude-code/src/entrypoints/init.ts` (path not found in the pinned clone, not verified): config, telemetry-after-trust, OAuth, policy limits, remote managed settings) -> MCP server bootstrap (project `.mcp.json`, user config, `--mcp-config`, plugin MCP servers) -> `getUserContext()`/`getSystemContext()` prefetch -> command+tool pool assembly -> `launchRepl()` -> `<App><REPL/></App>` render. Startup probing is pervasive: `utils/startupProfiler.ts` checkpoints (`main_tsx_entry`, `cli_entry`, `query_fn_entry`, `query_api_streaming_start`, ...) and `utils/headlessProfiler.ts` for print mode.

---

## 5. Core subsystems

### 5.1 The agent loop - `query()` (`claude-code/src/query.ts` (path not found in the pinned clone, not verified), 1,730 lines)

`query(params)` is an `AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal>`; `queryLoop()` is the real body. `QueryParams` (line 181) takes `messages`, `systemPrompt`, `userContext`, `systemContext`, `canUseTool`, `toolUseContext`, `fallbackModel`, `querySource`, `maxOutputTokensOverride`, `maxTurns`, `skipCacheWrite`, `taskBudget`, `deps` (injectable `QueryDeps` for tests). State carried across iterations is a single `State` object that continue-sites replace wholesale:

```ts
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

Ordered pipeline inside one iteration (each step is visible as a `queryCheckpoint`):

1. **Prefetches**: `startRelevantMemoryPrefetch()` (declared with `using` so it disposes on every generator exit path) and `startSkillDiscoveryPrefetch()`.
2. **Query-chain tracking**: `{chainId, depth}` in `toolUseContext.queryTracking` - used as analytics dims (`queryChainId`, `queryDepth`) and handed to subagents.
3. **Context shaping before the API call**: `applyToolResultBudget` (aggregate tool-result cap, with per-tool opt-out via `Number.isFinite(tool.maxResultSizeChars)`), `snipCompactIfNeeded` (`HISTORY_SNIP`), `deps.microcompact(...)` (cache-editing microcompaction), `contextCollapse.applyCollapsesIfNeeded(...)` (`CONTEXT_COLLAPSE`, a read-time projection over the REPL's full history), then `deps.autocompact(...)` (full summarisation) with a consecutive-failure circuit breaker. Compaction emits `compactionResult` -> `buildPostCompactMessages()` and re-drives the loop.
4. **Hard blocking limit guard** -> yields a synthetic prompt-too-long assistant error and returns `{reason: 'blocking_limit'}`.
5. **Model call**: `deps.callModel({messages: prependUserContext(...), systemPrompt: appendSystemContext(...), thinkingConfig, tools, signal, options: {getToolPermissionContext, model, fastMode, isNonInteractiveSession, fallbackModel, querySource, agents, allowedAgentTypes, maxOutputTokensOverride, fetchOverride: dumpPromptsFetch, mcpTools, hasPendingMcpServers, queryTracking, effortValue, advisorModel, skipCacheWrite, agentId, taskBudget}})`.
6. **Stream consumption**: yields messages (cloning only when `tool.backfillObservableInput` *adds* fields so the API-bound bytes stay identical for prompt caching), tombstones orphans after a streaming fallback, and feeds each `tool_use` block to a `StreamingToolExecutor` when the gate is on.
7. **Withholding + recovery**: prompt-too-long, media-size, and max-output-token errors are withheld from SDK consumers until recovery is attempted - collapse drain (`collapse_drain_retry`) -> reactive compact (`reactive_compact_retry`) -> capped-output escalation (`max_output_tokens_escalate`, retry at `ESCALATED_MAX_TOKENS`) -> up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` meta-message retries.
8. **Tool execution**: `streamingToolExecutor.getRemainingResults()` or `runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)`; results are normalized with `normalizeMessagesForAPI` and any `contextModifier` replaces `toolUseContext`.
9. **Post-batch work**: Haiku-generated `ToolUseSummaryMessage` for the previous batch (fired non-blocking, awaited next iteration), `getAttachmentMessages(...)` for queued commands/task notifications/skill discovery/memory, queue draining filtered by agent id (main thread drains `agentId === undefined`), `refreshTools()` to pick up mid-session MCP servers, `maxTurns` check, then `state = next` and loop.
10. **Stop hooks**: `handleStopHooks(...)` from `claude-code/src/query/stopHooks.ts` (path not found in the pinned clone, not verified) can `preventContinuation` or inject blocking errors that re-drive the loop (with a preserved reactive-compact guard to avoid an infinite compact->error->hook->compact spiral).

Terminal return reasons observed: `completed`, `blocking_limit`, `prompt_too_long`, `image_error`, `model_error`, `aborted_streaming`, `aborted_tools`, `hook_stopped`, `stop_hook_prevented`, `max_turns`.

### 5.2 Headless/SDK engine - `QueryEngine` (`claude-code/src/QueryEngine.ts` (path not found in the pinned clone, not verified), 1,297 lines)

`QueryEngine` owns one conversation: `submitMessage(prompt, {uuid, isMeta})` is an async generator of `SDKMessage`, and the module also exports `ask(...)`. `QueryEngineConfig` carries `cwd`, `tools`, `commands`, `mcpClients`, `agents`, `canUseTool`, `getAppState`, `setAppState`, `initialMessages`, `readFileCache`, `customSystemPrompt`, `appendSystemPrompt`, `userSpecifiedModel`, `fallbackModel`, `thinkingConfig`, `maxTurns`, `maxBudgetUsd`, `taskBudget`, `jsonSchema`, `handleElicitation`, `includePartialMessages`, `setSDKStatus`, `abortController`, `orphanedPermission`, `snipReplay`. It keeps `mutableMessages`, `totalUsage`, `permissionDenials`, and rebuilds a `processUserInputContext` twice per turn. Consumers: `claude-code/src/cli/print.ts` (path not found in the pinned clone, not verified) (print/SDK), `claude-code/src/utils/queryContext.ts` (path not found in the pinned clone, not verified), `claude-code/src/hooks/useReplBridge.tsx` (path not found in the pinned clone, not verified); the REPL itself calls `query()` directly, as do `AgentTool/runAgent.ts`, `utils/forkedAgent.ts` and `tasks/LocalMainSessionTask.ts`.

### 5.3 Model/provider layer (`claude-code/src/services/api` (path not found in the pinned clone, not verified))

`claude.ts` is the client: `queryModelWithoutStreaming`, `queryWithModel`, `queryHaiku` (side-queries: summaries, classifiers, memory extraction), `getMaxOutputTokensForModel`, `MAX_NON_STREAMING_TOKENS = 64_000`, `buildSystemPromptBlocks` (splits the system prompt array at the cache boundary and emits blocks with `cache_control` scopes), `addCacheBreakpoints`, `getPromptCachingEnabled`, `configureTaskBudgetParams`, `updateUsage`/`accumulateUsage`, `verifyApiKey`. Retries live in `withRetry.ts`: `withRetry` (async generator, `BASE_DELAY_MS = 500`, `getDefaultMaxRetries`), `CannotRetryError`, `FallbackTriggeredError` (drives the model-fallback path in `query.ts`), `is529Error`, `parseMaxTokensContextOverflowError`. Supporting modules: `client.ts`, `bootstrap.ts`, `filesApi.ts` (session file upload/download), `dumpPrompts.ts` (ant-only request dumping wrapper used as `fetchOverride`), `promptCacheBreakDetection.ts`, `usage.ts`, `metricsOptOut.ts`, `errors.ts`, `adminRequests.ts`, `grove.ts`, `referral.ts`, `sessionIngress.ts`, `overageCreditGrant.ts`, `firstTokenDate.ts`. Model metadata/aliases and per-agent model resolution live in `claude-code/src/utils/model` (path not found in the pinned clone, not verified) (`getRuntimeMainLoopModel`, `renderModelName`, `getAgentModel`).

### 5.4 Tool system (`claude-code/src/Tool.ts` (path not found in the pinned clone, not verified) + `claude-code/src/tools.ts` (path not found in the pinned clone, not verified) + `claude-code/src/tools` (path not found in the pinned clone, not verified))

Every capability is a `Tool` object. The type (line 362) carries: `name`, `aliases[]`, `searchHint`, `call(args, context, canUseTool, parentMessage, onProgress)`, `description(input, opts)`, `inputSchema` (Zod), optional `inputJSONSchema` (raw JSON Schema for MCP tools), `outputSchema`, `inputsEquivalent`, `isConcurrencySafe(input)`, `isEnabled()`, `isReadOnly(input)`, `isDestructive?`, `interruptBehavior?()`, `isSearchOrReadCommand?`, `isOpenWorld?`, `requiresUserInteraction?`, `isMcp`/`isLsp`, `shouldDefer`/`alwaysLoad` (tool-search), `mcpInfo`, `maxResultSizeChars`, `strict`, `backfillObservableInput`, `validateInput`, `checkPermissions`, `getPath`, `preparePermissionMatcher`, `prompt({getToolPermissionContext, tools, agents, allowedAgentTypes})`, `userFacingName`, `getToolUseSummary`, `getActivityDescription`, `toAutoClassifierInput`, `mapToolResultToToolResultBlockParam`, plus the whole render family: `renderToolUseMessage`, `renderToolUseProgressMessage`, `renderToolResultMessage`, `renderToolUseRejectedMessage`, `renderToolUseErrorMessage`, `renderGroupedToolUse`, `extractSearchText`, `isResultTruncated`.

`buildTool(def)` (`claude-code/src/Tool.ts:783` (path not found in the pinned clone, not verified)) spreads `TOOL_DEFAULTS` - fail-closed where it matters:

```ts
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input, _ctx?) => Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}
```

`ToolUseContext` (line 158) is the dependency-injection surface a tool gets: `options` (commands, tools, mainLoopModel, thinkingConfig, mcpClients/mcpResources, agentDefinitions, `refreshTools`, custom/append system prompts), `abortController`, `readFileState` (LRU), `getAppState`/`setAppState`, `setAppStateForTasks`, `handleElicitation`, `setToolJSX`, `addNotification`, `appendSystemMessage`, `messages`, `updateFileHistoryState`, `updateAttributionState`, `agentId`/`agentType`, `contentReplacementState`, `renderedSystemPrompt` (frozen at turn start so forked subagents share the parent's prompt-cache prefix), `localDenialTracking`, `toolDecisions`, `queryTracking`.

Registry (`claude-code/src/tools.ts` (path not found in the pinned clone, not verified)): `getAllBaseTools()` is the exhaustive list (and carries the comment that it *must stay in sync with the server-side `claude_code_global_system_caching` dynamic config so the system prompt caches across users*); `getTools(permissionContext)` filters deny rules, drops REPL-only primitives when REPL mode is on, honours `CLAUDE_CODE_SIMPLE` (Bash+Read+Edit only, plus Agent/TaskStop/SendMessage under coordinator mode) and `isEnabled()`; `filterToolsByDenyRules` uses the same matcher as runtime permission checks so a blanket `mcp__server` deny removes tools *before the model ever sees them*; `assembleToolPool(permissionContext, mcpTools)` and `getMergedTools` are the two assembly paths, with `assembleToolPool` deliberately keeping built-ins as a sorted contiguous prefix and appending sorted MCP tools so the server's global cache breakpoint isn't invalidated by MCP interleaving. `TOOL_PRESETS = ['default']` backs `--tools`.

### 5.5 Permissions (`claude-code/src/utils/permissions` (path not found in the pinned clone, not verified), `claude-code/src/hooks/toolPermission` (path not found in the pinned clone, not verified), `claude-code/src/tools/BashTool/bashPermissions.ts` (path not found in the pinned clone, not verified))

Modes (`claude-code/src/types/permissions.ts` (path not found in the pinned clone, not verified)): external set `acceptEdits | bypassPermissions | default | dontAsk | plan`; internal adds `auto` (classifier-driven; feature `TRANSCRIPT_CLASSIFIER`) and `bubble` (swarm worker delegating to leader). `getNextPermissionMode()` cycles modes for Shift+Tab (ants skip `acceptEdits`/`plan` in favour of `auto`).

Rules are `{toolName, ruleContent?}` with behaviour `allow | deny | ask`, sourced from `userSettings | projectSettings | localSettings | flagSettings | policySettings | cliArg | command | session`; wildcards look like `Bash(git *)`, `FileEdit(/src/*)`, `mcp__server__*`. `PermissionUpdate` operations (`addRules`/`replaceRules`/`removeRules`/`setMode`/`addDirectories`/`removeDirectories`) with destinations `userSettings | projectSettings | localSettings | session | cliArg` are what the UI writes when the user picks "don't ask again".

The decision function `hasPermissionsToUseTool()` in `claude-code/src/utils/permissions/permissions.ts` (path not found in the pinned clone, not verified) (1,487 lines) is an explicitly numbered ladder: 1a blanket deny -> 1b blanket ask -> 1c tool-specific `checkPermissions()` -> 1d tool-level deny -> 1f content-specific ask rules (these override `bypassPermissions`) -> 1g *safety checks* on `.git/`, `.claude/`, `.vscode/`, shell configs (bypass-immune, even against an allowing PreToolUse hook) -> 2a mode check (default/plan/acceptEdits/bypassPermissions/auto/dontAsk) -> 2b pre-approved tool -> 3 passthrough->ask. `dontAsk` is applied last so it cannot be bypassed by an early return. Denial tracking feeds a fallback-to-prompting threshold for classifier modes.

`claude-code/src/hooks/useCanUseTool.tsx` (path not found in the pinned clone, not verified) (204 lines) wraps that into the `CanUseToolFn` the loop calls, resolving races between local UI, IDE/bridge callbacks, channel callbacks (Telegram/iMessage), hooks and the auto-mode classifier via `claim()` in `interactiveHandler.ts`; handlers live in ``claude-code/src/hooks/toolPermission/handlers/{interactiveHandler` (path not found in the pinned clone, not verified),coordinatorHandler,swarmWorkerHandler}.ts` with shared `PermissionContext.ts` and `permissionLogging.ts`. The user-facing dialog labels are the canonical Claude Code ones (`src/components/permissions/FallbackPermissionRequest.tsx`, `shellPermissionHelpers.tsx`): "Yes" - "Yes, and don't ask again for `npm test` commands in /repo" - "No, and tell Claude what to do differently (esc)".

Bash is a permission subsystem of its own: `claude-code/src/tools/BashTool/bashPermissions.ts` (path not found in the pinned clone, not verified) (2,622 lines) plus `bashSecurity.ts`, `readOnlyValidation.ts`, `pathValidation.ts`, `modeValidation.ts`, `destructiveCommandWarning.ts`, `commandSemantics.ts`, `sedEditParser.ts`/`sedValidation.ts` (sed edits are rewritten into a synthetic `_simulatedSedEdit` field applied only after approval), `shouldUseSandbox.ts`, and `startSpeculativeClassifierCheck`/`consumeSpeculativeClassifierCheck` (classifier starts speculatively while pre-tool hooks run).

### 5.6 Tool execution pipeline (`claude-code/src/services/tools` (path not found in the pinned clone, not verified))

`toolOrchestration.ts` exposes `runTools()` -> serially or concurrently, partitioning on `tool.isConcurrencySafe(input)`; `StreamingToolExecutor.ts` (`class StreamingToolExecutor`) starts tools while the model is still streaming and can `discard()` a batch after a streaming fallback; `toolExecution.ts` (1,746 lines) is the per-tool saga:

1. `tool.inputSchema.safeParse(input)` -> on failure, a model-facing `<tool_use_error>InputValidationError: ...</tool_use_error>` **plus** `buildSchemaNotSentHint()` when the tool was deferred (tool-search) and its schema was never sent. 2. `tool.validateInput()` -> `<tool_use_error>` on refusal. 3. Speculative bash classifier check started early. 4. Defense-in-depth strip of internal-only `_simulatedSedEdit` from model-supplied Bash input. 5. `runPreToolUseHooks(...)` (can emit messages, `hookPermissionResult`, `hookUpdatedInput`, `preventContinuation`, `additionalContext`, or `stop`). 6. `resolveHookPermissionDecision(hookPermissionResult, tool, processedInput, context, canUseTool, ...)`. 7. On deny/ask -> emit a rejected tool_result (plus images/feedback blocks) and, for auto-mode classifier denials, run `PermissionDenied` hooks which may grant a retry. 8. `tool.call(input, {...context, toolUseId, userModified}, canUseTool, assistantMessage, onProgress)` - `call()` failures are converted into error tool_results, never thrown at the loop. 9. `mapToolResultToToolResultBlockParam` (cached and reused), `processPreMappedToolResultBlock`/`processToolResultBlock` enforcing `maxResultSizeChars` (oversized results are persisted to disk and replaced by a preview + path). 10. `runPostToolUseHooks(...)` (can rewrite MCP output), then `runPostToolUseFailureHooks(...)` on error. 11. OTel/analytics: `tool_decision`, `tool_result`, `tool.output` span events, git commit-id extraction from `git commit` output, code-edit counters.

### 5.7 Prompting, context, memory

* **System prompt builder** - `claude-code/src/constants/prompts.ts` (path not found in the pinned clone, not verified) (915 lines): `getSystemPrompt(tools, model, additionalWorkingDirectories?, mcpClients?)` returns `string[]`, i.e. an *array of sections* rather than one blob. Static sections (intro, system, doing-tasks, executing-actions-with-care, using-your-tools, tone-and-style, output-efficiency) are literal strings pushed before the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker; dynamic sections are registered as memoized `systemPromptSection(name, compute)` entries resolved by `claude-code/src/constants/systemPromptSections.ts` (path not found in the pinned clone, not verified) (`resolveSystemPromptSections`), with `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` for the section that *must* break cache (MCP instructions). `CLAUDE_CODE_SIMPLE` collapses the whole prompt to `You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ...\nDate: ...`.
* **Prompt-selection precedence** - `claude-code/src/utils/systemPrompt.ts` (path not found in the pinned clone, not verified): override prompt (loop mode) > coordinator prompt > agent definition prompt (replaces default; *appended* in proactive mode) > `--system-prompt` > default, with `--append-system-prompt` always last and `enhanceSystemPromptWithEnvDetails()` adding subagent `Notes:` + env block.
* **Sub-agent system prompt** - `DEFAULT_AGENT_PROMPT` in the same constants file: `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully-don't gold-plate, but don't leave it half-done. ...`
* **Per-tool prompt injection** - every tool's `prompt.ts` returns the long model-facing guidance that becomes the API tool `description` (`toolToAPISchema` in `claude-code/src/utils/api.ts` (path not found in the pinned clone, not verified) calls `await tool.prompt({...})` for `description`, separate from the short `description()` used in permission dialogs). Tool schemas are cached per session (`toolSchemaCache.ts`) to stop GrowthBook flips or prompt drift from churning tool-array bytes.
* **User/system context** - `claude-code/src/context.ts` (path not found in the pinned clone, not verified): `getSystemContext()` (memoized `gitStatus`, optional cache-breaker injection) and `getUserContext()` (CLAUDE.md chain via `getMemoryFiles`/`getClaudeMds`, `--add-dir` dirs, current date), both memoized and attached to requests through `prependUserContext`/`appendSystemContext` (`src/utils/api.ts`).
* **Memory** - `claude-code/src/memdir` (path not found in the pinned clone, not verified) (`MEMORY.md` entrypoint, 200-line / 25 KB caps, `findRelevantMemories.ts`, `memoryScan.ts`, `memoryAge.ts`, `memoryTypes.ts` with `TYPES_SECTION_*`/`WHEN_TO_ACCESS_SECTION` prompt fragments, team-memory paths/prompts) plus `claude-code/src/services/extractMemories` (path not found in the pinned clone, not verified), `claude-code/src/services/SessionMemory` (path not found in the pinned clone, not verified), `claude-code/src/services/teamMemorySync` (path not found in the pinned clone, not verified), and `src/utils/attachments.ts` (`memoryFilesToAttachments`, `startRelevantMemoryPrefetch`, `collectSurfacedMemories`).
* **Attachments** - `src/utils/attachments.ts` is a large, registry-like module that produces `AttachmentMessage`s for every out-of-band signal: todo/plan-mode reminders, relevant memories, edited-file notices, queued commands, MCP instruction deltas, agent listing deltas, deferred-tool deltas, date changes, skill discovery, surfaced memories.
* **Output styles** - `claude-code/src/constants/outputStyles.ts` (path not found in the pinned clone, not verified) + `src/outputStyles/`, injected as an `# Output Style: ...` section and able to suppress the coding instructions (`keepCodingInstructions`).

### 5.8 State and session

* **`AppState`** - `claude-code/src/state/AppStateStore.ts` (path not found in the pinned clone, not verified) (~570 lines). A `DeepImmutable<{...}>` plus a non-immutable tail for function-bearing fields. Contains settings, `mainLoopModel`, `toolPermissionContext`, `mcp.{clients,tools,commands,resources,pluginReconnectKey}`, `plugins.{enabled,disabled,commands,errors,installationStatus,needsRefresh}`, `agentDefinitions`, `fileHistory`, `attribution`, `todos` (per-agent), `notifications`, `elicitation`, `sessionHooks`, `tasks`, `agentNameRegistry`, `teamContext`, `inbox`, `workerSandboxPermissions`, `promptSuggestion`, `speculation`, `initialMessage`, `denialTracking`, `activeOverlays`, `fastMode`, `effortValue`, bridge/remote fields, `ultraplan*` fields, `replContext` (the REPL tool's persistent `vm.Context`), `computerUseMcpState`. `getDefaultAppState()` seeds it (permission mode `plan` when a teammate was spawned with plan-mode-required).
* **Store + selectors** - `src/state/store.ts` (custom store with subscribers), `selectors.ts`, `onChangeAppState.ts` (side effects), `AppState.tsx` (React glue). Tools get `getAppState`/`setAppState`; subagents get a *no-op* `setAppState` plus `setAppStateForTasks` for session-scoped infrastructure.
* **Process-global state** - `claude-code/src/bootstrap/state.ts` (path not found in the pinned clone, not verified) (1,760 lines): cwd/originalCwd, session id, token counters (`getCurrentTurnTokenBudget`, `getTurnOutputTokens`), cached CLAUDE.md content, worktree session, allowed channels, GrowthBook latches, system-prompt section cache.
* **Persistence** - `src/utils/sessionStorage.ts`, `src/utils/conversationRecovery.ts`, `src/history.ts`, `src/utils/fileHistory.ts` (+ `useFileHistorySnapshotInit`, `/rewind` command), `src/utils/crossProjectResume.ts`, `src/utils/agenticSessionSearch.ts` and markdown-based transcripts.

### 5.9 Commands (`claude-code/src/commands.ts` (path not found in the pinned clone, not verified) + `src/commands/`)

`Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)` (`claude-code/src/types/command.ts` (path not found in the pinned clone, not verified), plus `getCommandName`/`isCommandEnabled`). `COMMANDS()` is a `memoize`d array mixing eager imports with feature-gated ones (`webCmd`, `forkCmd`, `buddy`, `proactive`, `briefCommand`, `assistantCommand`, `bridge`, `remoteControlServerCommand`, `voiceCommand`, `peersCmd`, `workflowsCmd`, `torch`), and `INTERNAL_ONLY_COMMANDS` (commit, commit-push-pr, share, summary, teleport, onboarding, bughunter, ctx_viz, issue, mockLimits, backfillSessions, breakCache, env, perfIssue, antTrace, debugToolCall, autofixPr, ...) is only included when `USER_TYPE === 'ant' && !IS_DEMO`. `getCommands(cwd)` merges bundled skills, built-in plugin skills, skill-dir skills, workflow commands, plugin commands and plugin skills with the builtins, then re-filters by `meetsAvailabilityRequirement()` (`claude-ai` vs `console` auth) and `isEnabled()` on every call so `/login` takes effect immediately; dynamic skills discovered mid-session are spliced in between plugin skills and builtins. `REMOTE_SAFE_COMMANDS` and `BRIDGE_SAFE_COMMANDS` gate which commands may be triggered from a remote/mobile client.

### 5.10 MCP (Model Context Protocol)

Client side: `claude-code/src/services/mcp` (path not found in the pinned clone, not verified) - `MCPConnectionManager.tsx` + `useManageMCPConnections.ts` (connect/disconnect lifecycle, tool & resource discovery, `pending`/`connected`/`needs-auth`/`failed` states), `client.ts`, `config.ts`, `types.ts`, `normalization.ts`, `mcpStringUtils.ts`, `oauthPort.ts`/`auth.ts`, `xaa.ts`/`xaaIdpLogin.ts` (cross-app auth), `headersHelper.ts`, `elicitationHandler.ts`, `channelNotification.ts`/`channelPermissions.ts`/`channelAllowlist.ts` (MCP channels that can push inbound notifications and answer permission prompts), `officialRegistry.ts` (prefetch of Anthropic-run servers), `InProcessTransport.ts`, `SdkControlTransport.ts`, `vscodeSdkMcp.ts`. Tools from servers are named `mcp__<server>__<tool>` (or unprefixed under `CLAUDE_AGENT_SDK_MCP_NO_PREFIX`), carry `mcpInfo`, are wrapped by `MCPTool`, and appear in `ToolSearchTool` when deferred. Server side: `claude-code/src/entrypoints/mcp.ts` (path not found in the pinned clone, not verified) runs Claude Code *as* an MCP server exposing its own `getTools()` over stdio.

### 5.11 Subagents, teams, coordinator

`claude-code/src/tools/AgentTool` (path not found in the pinned clone, not verified) (6,802 lines) is a mini-framework: `AgentTool.tsx` (the `Agent` tool, alias `Task`), `runAgent.ts` (subagent loop, calling `query()` with a child `ToolUseContext` and its own agentId), `loadAgentsDir.ts` (`.claude/agents/*.md` frontmatter - `name`, `description`, `tools`, `disallowedTools`, `model`, `prompt`), `builtInAgents.ts` + `built-in/` (`general-purpose` [tools `*`], `statusline-setup` [Read, Edit; model sonnet], `Explore` [model `haiku` externally, `inherit` for ants], `Plan`, `claude-code-guide` [haiku; answers questions about Claude Code/SDK/API], `verification` [ant-only adversarial verifier]), `forkSubagent.ts` (fork-of-parent subagent that shares the parent's frozen `renderedSystemPrompt` for cache parity), `resumeAgent.ts`, `agentMemory.ts`/`agentMemorySnapshot.ts`, `agentColorManager.ts`, `agentToolUtils.ts` (result schema, handoff classification, progress emission). The Agent tool input schema: `description`, `prompt`, `subagent_type?`, `model?` (`sonnet|opus|haiku`), `run_in_background?`, plus `name?`, `team_name?`, `mode?`, `isolation?` (`worktree`), `cwd?`.

Swarm/multi-agent: `claude-code/src/tools/shared/spawnMultiAgent.ts` (path not found in the pinned clone, not verified), `TeamCreateTool`/`TeamDeleteTool`/`SendMessageTool` (addressable agents, `--teammate-mode tmux|in-process|auto`), `claude-code/src/coordinator/coordinatorMode.ts` (path not found in the pinned clone, not verified) `isCoordinatorMode()` (env `CLAUDE_CODE_COORDINATOR_MODE` + feature `COORDINATOR_MODE`) with worker tool allowlists (`ASYNC_AGENT_ALLOWED_TOOLS`, `COORDINATOR_MODE_ALLOWED_TOOLS`, `ALL_AGENT_DISALLOWED_TOOLS` in `claude-code/src/constants/tools.ts` (path not found in the pinned clone, not verified)), and `src/utils/swarm/` (in-process runners, mailbox bridges, permission sync) with `src/tasks/InProcessTeammateTask/`.

### 5.12 Tasks, hooks, skills, plugins

* **Tasks** - `claude-code/src/tasks` (path not found in the pinned clone, not verified) types union (`LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `InProcessTeammateTask`, `LocalWorkflowTask`, `MonitorMcpTask`, `DreamTask`), `stopTask.ts`, `pillLabel.ts`; background bash tasks are created by BashTool's `run_in_background`, agent tasks by `AgentTool`'s `run_in_background`, and are surfaced through footer pills and `/tasks`.
* **Hooks** - user-configurable shell hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Stop`, `SessionStart`, `Setup`, prompt hooks, agent hooks) implemented in `claude-code/src/utils/hooks.ts` (path not found in the pinned clone, not verified) + `src/utils/hooks/{execAgentHook,execPromptHook,apiQueryHookHelper,postSamplingHooks,skillImprovement,sessionHooks}.ts`. Hooks can allow/deny/rewrite tool input, inject context, block continuation, and `retry: true` a classifier denial. Hook `if` conditions reuse permission-rule patterns through `tool.preparePermissionMatcher()`.
* **Skills** - `claude-code/src/skills/loadSkillsDir.ts` (path not found in the pinned clone, not verified) (loads skill directories whose frontmatter becomes a `PromptCommand`), `bundledSkills.ts` + `bundled/` (batch, loop, simplify, remember, verify, verifyContent, debug, stuck, skillify, updateConfig, claudeApi, claudeApiContent, claudeInChrome, keybindings, scheduleRemoteAgents, loremIpsum), `mcpSkillBuilders.ts`. Skills are invoked by the user as `/skill-name` and by the model via the `Skill` tool; `SkillTool` supports inline and forked (subagent) execution with `allowedTools` and `model` overrides from frontmatter.
* **Plugins** - `claude-code/src/plugins` (path not found in the pinned clone, not verified) (built-in plugin registry) + `src/services/plugins/` (marketplace, install/reconcile, `refreshPluginState`), `/plugin`, `/reload-plugins`, `pluginInfo` metadata on commands, and plugin-provided MCP servers keyed by `mcp.pluginReconnectKey`.

### 5.13 Terminal UI (Ink) and screens

* Vendored Ink in `claude-code/src/ink` (path not found in the pinned clone, not verified) (96 files) with `ink.ts` exporting `Box`, `Text`, `useInput`, `useStdin`, `useTheme`, `useTerminalFocus`, `useTerminalTitle`, `useTabStatus`, plus `ink/hooks/` and a reconciler/host config. Components are React functions over these primitives and Chalk colours, compiled with the React Compiler (`react/compiler-runtime` appears in 395 files).
* `claude-code/src/screens/REPL.tsx` (path not found in the pinned clone, not verified) (~5,006 lines) is the interactive heart: virtualised message list, prompt input with `!` bash mode and `#` memory mode, vim input, keybinding handling, permission dialogs, MCP elicitation dialogs, queue processor, remote/bridge wiring, speculation (predictive background work shown as a ghost message), todo/teammate panels, footer pills, transcript search, and AppState plumbing. `/doctor` and `/resume` are separate screens.
* Message components live in `claude-code/src/components/messages` (path not found in the pinned clone, not verified) (`UserBashInputMessage`, `UserBashOutputMessage`, `PlanApprovalMessage`, `TaskAssignmentMessage`, `SystemAPIErrorMessage`, `HookProgressMessage`, `UserImageMessage`, ...); permission UI in `src/components/permissions/`; design-system primitives in `src/components/design-system/`.

### 5.14 IDE/remote bridge, remote sessions, daemon

`claude-code/src/bridge` (path not found in the pinned clone, not verified) (32 files): `bridgeMain.ts` (main loop), `bridgeMessaging.ts` (protocol), `bridgePermissionCallbacks.ts`, `bridgeApi.ts`, `bridgeConfig.ts`, `bridgeEnabled.ts`, `replBridge.ts` + `initReplBridge.ts` + `replBridgeTransport.ts`, `jwtUtils.ts`, `sessionRunner.ts`, `createSession.ts`, `codeSessionApi.ts`, `pollConfig.ts`, `capacityWake.ts`, `flushGate.ts`, `inboundMessages.ts`/`inboundAttachments.ts`, `trustedDevice.ts`, `workSecret.ts`, `remoteBridgeCore.ts`, `stub.ts`. Remote sessions/mobile: `src/remote/` (`RemoteSessionManager`, `SessionsWebSocket`, `sdkMessageAdapter`, `remotePermissionBridge`), `/desktop`, `/mobile`, `/teleport`, `/remote-control` (always-on bridge to claude.ai), `src/utils/teleport.tsx`. Server/daemon: `src/server/` + `claude server` (HTTP + unix socket, `--idle-timeout`, `--max-sessions`), `src/cli/transports/` (`WebSocketTransport`, `SSETransport`, `HybridTransport`, `ccrClient`, `SerialBatchEventUploader`), and `/sandbox-toggle`.

### 5.15 Services and cross-cutting infrastructure

`claude-code/src/services` (path not found in the pinned clone, not verified) beyond api/mcp/oauth (OAuth flows, keychain, Azure/Vertex/Bedrock auth): `analytics/` (GrowthBook gates + `logEvent`, events all prefixed `tengu_`), `compact/` (`autoCompact.ts`, `compact.ts`, `reactiveCompact.ts`, `microcompact.ts`, `snipCompact.ts`, `cachedMCConfig.ts`), `tools/`, `lsp/`, `plugins/`, `policyLimits/`, `remoteManagedSettings/`, `settingsSync/`, `extractMemories/`, `SessionMemory/`, `teamMemorySync/`, `PromptSuggestion/`, `AgentSummary/`, `MagicDocs/`, `toolUseSummary/`, `tokenEstimation.ts`, `tips/`, `notifier.ts`, `preventSleep.ts`, `rateLimitMessages.ts`/`mockRateLimits.ts`/`rateLimitMocking.ts`, `claudeAiLimits.ts`, `diagnosticTracking.ts`, `internalLogging.ts`, `vcr.ts` (record/replay fixtures), `voice.ts`/`voiceKeyterms.ts`/`voiceStreamSTT.ts`, `x402/`, `autoDream/`, `mcpServerApproval.tsx`, `awaySummary.ts`. Shared infrastructure under `src/utils/`: shell execution (`Shell.ts`, `ShellCommand.ts`, `shell/` prefix matching), `sandbox/`, `permissions/`, `settings/` (layered settings, MDM, managed policies), `secureStorage/` (keychain), `swarm/`, `telemetry/`, `task/` (disk output), `computerUse/`, `hooks/`, `messages.ts`, `tokens.ts`, `model/`, `git.ts`, `cron*.ts`, `fileHistory.ts`, `toolResultStorage.ts`, `sessionStorage.ts`, `attachments.ts`, `worktree.ts`, `teleport.tsx`, `undercover.ts` (ant-only "don't leak codenames/model IDs" mode that also strips model names from the system prompt and commit attribution), `betas.ts`, `debug.ts`, `errors.ts`, `log.ts`.

### 5.16 Other subsystems

`src/vim/` (motions/operators/text objects for Vim input mode), `src/keybindings/` (schema, defaults, resolver - `/keybindings`), `src/voice/` + services voice STT (`/voice`), `src/buddy/` (companion sprite easter egg), `src/native-ts/` (native helper ports), `src/upstreamproxy/`, `src/moreright/`, `src/outputStyles/`, `src/migrations/`, `src/schemas/`, `src/projectOnboardingState.ts`, `src/costHook.ts`, `src/dialogLaunchers.tsx`, `src/history.ts`.

---

## 6. Built-in tools (full list) and slash commands

### 6.1 Tool catalog with input schemas

Names are the exact API-facing `tool.name` values taken from the `*_TOOL_NAME` constants; every tool lives in its own directory `claude-code/src/tools/<Name>` (path not found in the pinned clone, not verified) with `<Name>.ts|tsx`, `UI.tsx`, `prompt.ts`, `constants.ts` and helpers. "Gated" = only present when a feature flag / env / provider check passes (`getAllBaseTools()` in `claude-code/src/tools.ts` (path not found in the pinned clone, not verified)).

**File / search tools (always on unless noted)**

| Tool | Input schema (Zod, from source) | Notes |
|---|---|---|
| `Read` | `file_path: string` (absolute), `offset?: number` (≥0), `limit?: number` (>0), `pages?: string` (PDF ranges, e.g. `"1-5"`, max pages per read) | Reads text, images (jpeg/png/gif/webp), PDFs, notebooks; `maxResultSizeChars: Infinity` so results are never persisted (avoids Read→file→Read loops) |
| `Edit` | `file_path: string`, `old_string: string`, `new_string: string`, `replace_all?: boolean` (default false) | String-replacement edit; output carries `structuredPatch`, `originalFile`, optional `gitDiff`; ~1 GiB input-size guard for the runtime string limit |
| `Write` | `file_path: string` (must be absolute), `content: string` | Output: `type: 'create'|'update'`, `filePath`, `content`, `structuredPatch`, `originalFile`, `gitDiff?` |
| `NotebookEdit` | `notebook_path: string` (absolute), `cell_id?: string`, `new_source: string`, `cell_type?: 'code'|'markdown'`, `edit_mode?: 'insert'|'replace'|'delete'` (insert places after `cell_id`, or at the start) | Jupyter `.ipynb` editing |
| `Glob` | `pattern: string`, `path?: string` (omit for cwd) | Output: `durationMs`, `numFiles`, `filenames`, `truncated` (100-file cap) |
| `Grep` | `pattern: string`, `path?: string`, `glob?: string`, `output_mode?: 'content'|'files_with_matches'|'count'`, `-B?: number`, `-A?: number`, `-C?: number`, `context?: number`, `-n?: boolean`, `-i?: boolean`, `type?: string`, `head_limit?: number` (default 250), `offset?: number`, `multiline?: boolean` | ripgrep-backed; excludes VCS dirs (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`) |

**Execution tools**

| Tool | Input schema | Notes |
|---|---|---|
| `Bash` | `command: string`, `timeout?: number` (max from `getMaxTimeoutMs()`), `description?: string` (active-voice, examples given for `ls`, `git status`, `npm install`, piped commands), `run_in_background?: boolean`, `dangerouslyDisableSandbox?: boolean`, plus internal-only `_simulatedSedEdit: {filePath, newContent}` | Sandbox-aware (`SandboxManager`, `shouldUseSandbox`), background tasks, destructive-command warnings, read-only validation, sed-edit interception |
| `PowerShell` | `command: string`, `timeout?: number`, `description?: string`, `run_in_background?: boolean`, `dangerouslyDisableSandbox?: boolean` (`run_in_background` omitted when background tasks are disabled) | Windows shell; gated by `isPowerShellToolEnabled()`; 8,973 lines of its own permission/security logic |
| `REPL` | (module absent from this archive) | Feature/ant/mode gated; when enabled, hides Read/Write/Edit/Glob/Grep/Bash from direct use (`REPL_ONLY_TOOLS`) and runs them inside a persistent Node `vm` context |

**Web tools**

| Tool | Input schema | Notes |
|---|---|---|
| `WebFetch` | `url: string` (`.url()`), `prompt: string` | Output: `bytes`, `code`, `codeText`, `result`, `durationMs`, `url`; `preapproved.ts` hosts an allowlist |
| `WebSearch` | `query: string` (min 2), `allowed_domains?: string[]`, `blocked_domains?: string[]` | Returns `{tool_use_id, content: [{title, url}]}` |

**Task/plan tools**

| Tool | Input schema | Notes |
|---|---|---|
| `TodoWrite` | `todos: Array<{content: string (min 1), status: 'pending'|'in_progress'|'completed', activeForm: string (min 1)}>` | Superseded by the Task v2 tools (`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`/`TaskOutput`/`TaskStop`) when `isTodoV2Enabled()` is true, i.e. in interactive sessions; output records `oldTodos`, `newTodos`, optional `verificationNudgeNeeded` |
| `TaskCreate` | `subject`, `description`, `activeForm?`, `metadata?: Record<string, unknown>` | Output `{task: {id, subject}}` |
| `TaskGet` | `taskId: string` | Returns `{task: {id, subject, description, status, blocks[], blockedBy[]} | null}` |
| `TaskList` | `{}` | Returns tasks with `id`, `subject`, `status`, `owner?`, `blockedBy[]` |
| `TaskUpdate` | `taskId`, `subject?`, `description?`, `activeForm?`, `status?` (task statuses plus `'deleted'`), plus dependency/ownership fields | Output `{success, taskId, ...}` |
| `TaskOutput` | `task_id: string`, `block?: boolean` (default true), `timeout?: number` (0–600,000 ms, default 30,000) | Unified output for shell/agent/teammate/workflow tasks |
| `TaskStop` | `task_id?: string`, `shell_id?: string` (deprecated) | Alias `KillShell`; stops a background task |
| `EnterPlanMode` | `{}` (no parameters) | Output `{message}`; switches to plan mode (read-only planning) |
| `ExitPlanMode` | `allowedPrompts?: Array<{tool: 'Bash', prompt: string}>` (`passthrough()` for injected fields) | Asks the user to approve the plan; `allowedPrompts` grants session-scoped Bash permissions described semantically (e.g. "run tests") |
| `EnterWorktree` | `name?: string` (slug-validated: letters/digits/dots/underscores/dashes, ≤64 chars, `/`-separated) | Creates a git worktree, cwd switches into it |
| `ExitWorktree` | `action: 'keep'|'remove'`, `discard_changes?: boolean` (required `true` when removing a dirty worktree) | Refuses and lists changes otherwise |


**Agent / orchestration tools**

| Tool | Input schema | Notes |
|---|---|---|
| `Agent` | `description: string` (3-5 words), `prompt: string`, `subagent_type?: string`, `model?: 'sonnet'|'opus'|'haiku'`, `run_in_background?: boolean`; extended with `name?` (addressable via SendMessage), `team_name?`, `mode?` (permission mode for a spawned teammate), `isolation?: 'worktree'` (plus `'remote'` in ant/external variants), `cwd?` | Alias `Task`. Spawns a subagent (own context + tool pool) or a teammate; supports forks that share the parent's prompt cache |
| `SendMessage` | `to: string` (teammate name, `"*"` broadcast, `uds:<socket-path>`, `bridge:<session-id>`), `summary?: string` (5-10 words, required for plain-string messages), `message: string | StructuredMessage` | Inter-agent messaging; enables resume of running agents by name |
| `TeamCreate` | `team_name: string`, `description?: string`, `agent_type?: string` (lead role, e.g. `researcher`, `test-runner`) | Gated by `isAgentSwarmsEnabled()` |
| `TeamDelete` | `{}` | Disbands the team / cleans up |
| `Skill` | `skill: string` (e.g. `"commit"`, `"review-pr"`, `"pdf"`), `args?: string` | Executes a registered skill; output distinguishes `status: 'inline'` vs `'forked'` (with `agentId`) and echoes `allowedTools` and `model` overrides |
| `ToolSearch` | `query: string` (`"select:<tool_name>"` for direct selection, else keywords), `max_results?: number` (default 5) | Discovers *deferred* tools (MCP/tool-search mode); output `{matches: string[], query}` |
| `RemoteTrigger` | `action: 'list'|'get'|'create'|'update'|'run'`, `trigger_id?: string` (`/^[\w-]+$/`, required for get/update/run), `body?: Record<string, unknown>` | Feature `AGENT_TRIGGERS_REMOTE` |
| `CronCreate` | `cron: string` (5-field local-time expression), `prompt: string` (enqueued at each fire), `recurring?: boolean` (default true; one-shot auto-deletes), `durable?: boolean` (persist to `.claude/scheduled_tasks.json`) | Feature `AGENT_TRIGGERS`; siblings `CronDelete`, `CronList` |
| `Sleep` | (module absent; only `prompt.ts` remains) | Proactive/Kairos pacing - the model is required to call it rather than emit "still waiting" text |

**MCP tools**

| Tool | Input schema | Notes |
|---|---|---|
| `mcp` (`MCPTool`) | `{}` `.passthrough()` - the real schema is the server's JSON Schema, surfaced as `inputJSONSchema` | Converts an MCP server tool call into a `Tool`; carries `mcpInfo`, `isMcp: true` |
| `ListMcpResourcesTool` | `server?: string` | Returns `[{uri, name, mimeType?, description?, server}]` |
| `ReadMcpResourceTool` | `server: string`, `uri: string` | Returns `contents[{uri, mimeType?, text?, blobSavedTo?}]` (binary blobs written to disk) |
| `McpAuthTool` | directory present in the tree | MCP server authentication ($-32042 elicitation / OAuth) |

**Utility / mode tools**

| Tool | Input schema | Notes |
|---|---|---|
| `AskUserQuestion` | `questions: Array<{question: string, header: string` (chip label, width-limited)`, options: Array<{label, description, preview?}> (min 2, max 4), multiSelect?: boolean (default false)}>` plus `answers?`, `annotations?`, `metadata?` | `refine` rejects duplicate questions and duplicate labels; no "Other" option (added automatically). This is the tool the system prompt tells the model to use when it doesn't understand a denial |
| `Config` | `setting: string` (e.g. `"theme"`, `"model"`, `"permissions.defaultMode"`), `value?: string|boolean|number` (omit to read) | Registered only for `USER_TYPE === 'ant'` |
| `StructuredOutput` (`SyntheticOutputTool`) | `{}` `.passthrough()` | Enabled only for non-interactive sessions; used by `--json-schema` to force a structured final answer |
| `LSP` | discriminated union on `operation` (`goToDefinition` shown: `filePath: string`, `line: number` (1-based), `character: number` (1-based)), plus the other LSP operations | Registered only when `ENABLE_LSP_TOOL` is truthy; backed by `services/lsp/` |
| `SendUserMessage` (`BriefTool`) | `message: string` (markdown), `attachments?: string[]` (absolute or cwd-relative paths), `status: 'normal'|'proactive'` | Alias `Brief`; the agent-to-user channel for Kairos/brief mode |
| `TestingPermissionTool` | test-only | Registered only when `NODE_ENV === 'test'` |

**Tools referenced by the registry but absent from this archive** (feature-gated in production builds): `TungstenTool`, `SuggestBackgroundPRTool`, `MonitorTool` (`MONITOR_TOOL`), `SendUserFileTool`, `PushNotificationTool`, `SubscribePRTool`, `WorkflowTool`, `SnipTool` (`HISTORY_SNIP`), `ListPeersTool` (`UDS_INBOX`), `CtxInspectTool` (`CONTEXT_COLLAPSE`), `OverflowTestTool`, `TerminalCaptureTool` (`TERMINAL_PANEL`), `WebBrowserTool` (`WEB_BROWSER_TOOL`, codename "bagel"), `VerifyPlanExecutionTool` (`CLAUDE_CODE_VERIFY_PLAN=true`), `REPLTool`, `SleepTool`, `DiscoverSkillsTool` (`EXPERIMENTAL_SKILL_SEARCH`).


### 6.2 Slash commands (full list)

Commands live in `claude-code/src/commands` (path not found in the pinned clone, not verified) (one directory or file each) and are registered in `COMMANDS()` / `INTERNAL_ONLY_COMMANDS` in `claude-code/src/commands.ts` (path not found in the pinned clone, not verified). Names below are user-facing; `[gated]` = only registered when a feature/env/provider check passes, `[ant]` = only for `USER_TYPE === 'ant'` (and not in demo mode). Roughly 85 commands are reachable in a normal build.

**Session & context**: `/clear`, `/compact`, `/context` (and its non-interactive variant), `/resume`, `/session`, `/rename`, `/tag`, `/export`, `/copy`, `/summary` [ant], `/share` [ant], `/rewind`.

**Git & review**: `/commit` [ant], `/commit-push-pr` [ant], `/branch`, `/diff`, `/pr_comments`, `/review`, `/ultrareview`, `/security-review`, `/autofix-pr` [ant], `/bughunter` [ant], `/issue` [ant].

**Configuration & UX**: `/config`, `/permissions`, `/model`, `/effort`, `/fast`, `/brief` [gated], `/theme`, `/color`, `/output-style`, `/statusline`, `/keybindings`, `/vim`, `/privacy-settings`, `/sandbox-toggle`, `/hooks`, `/env` [ant], `/terminal-setup`, `/release-notes`, `/feedback`, `/help`, `/exit`, `/stickers`, `/good-claude` [ant] (easter eggs).

**Memory & files**: `/memory`, `/add-dir`, `/files`, `/init` (create CLAUDE.md), `/init-verifiers` [ant].

**MCP, plugins & skills**: `/mcp`, `/plugin`, `/reload-plugins`, `/skills`, `/agents`, `/agents-platform` [ant], `/advisor`, `/install-github-app`, `/install-slack-app`.

**Auth & billing**: `/login`, `/logout`, `/oauth-refresh` [ant], `/upgrade`, `/install`, `/cost`, `/usage`, `/usage-report`, `/extra-usage` (+ non-interactive variant), `/rate-limit-options`, `/passes`, `/x402`, `/mock-limits` [ant], `/reset-limits` [ant], `/reset-limits-non-interactive` [ant].

**Tasks, plans & agents**: `/tasks`, `/plan`, `/ultraplan` [ant], `/thinkback`, `/thinkback-play`, `/passes`, `/peers` [gated, `UDS_INBOX`], `/workflows` [gated, `WORKFLOW_SCRIPTS`], `/force-snip` [gated, `HISTORY_SNIP`], `/subscribe-pr` [gated, `KAIROS_GITHUB_WEBHOOKS`].

**Environment & remote**: `/desktop`, `/mobile`, `/ide`, `/chrome`, `/bridge` [gated], `/bridge-kick`, `/remote-env`, `/remote-control` [gated], `/teleport` [ant], `/sandbox-toggle`, `/web-setup` [gated], `/voice` [gated], `/fork` [gated], `/buddy` [gated], `/proactive` [gated], `/assistant` [gated], `/torch` [gated].

**Diagnostics & maintenance**: `/doctor`, `/status`, `/stats`, `/version` [ant], `/heapdump`, `/insights`, `/ctx_viz` [ant], `/debug-tool-call` [ant], `/perf-issue` [ant], `/ant-trace` [ant], `/break-cache` [ant], `/backfill-sessions` [ant], `/onboarding` [ant].

Commands are typed `prompt | local | local-jsx` (see `claude-code/src/types/command.ts` (path not found in the pinned clone, not verified)). `prompt` commands expose `allowedTools`, `progressMessage`, `getPromptForCommand(args, context)` and can define `argNames`, `whenToUse`, `disableModelInvocation`, `effort`, `model`, `kind: 'workflow'`; they are also exactly what the `Skill` tool and `/<skill-name>` invocation consume (`getSkillToolCommands` in `commands.ts` filters `type === 'prompt' && !disableModelInvocation && source !== 'builtin'`).


---

## 7. Prompt / system-prompt architecture

This is one of the most instructive parts of the codebase: the system prompt is **not a string**, it is an ordered array of independently-cached sections with an explicit cache boundary.

**The builder** - `claude-code/src/constants/prompts.ts:444-577` (path not found in the pinned clone, not verified). `getSystemPrompt(tools, model, additionalWorkingDirectories?, mcpClients?)` returns `Promise<string[]>`. `CLAUDE_CODE_SIMPLE` short-circuits to a single string: `You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ...\nDate: ...`. Otherwise it builds:

* static sections (cacheable): intro (`getSimpleIntroSection`, L179), `# System` (`getSimpleSystemSection`, L186), `# Doing tasks` (`getSimpleDoingTasksSection`, L199), `# Executing actions with care` (`getActionsSection`, L255), `# Using your tools` (`getUsingYourToolsSection`, L269), `# Tone and style` (`getSimpleToneAndStyleSection`, L430), `# Output efficiency` (`getOutputEfficiencySection`, L403);
* the boundary marker `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (L114) when `shouldUseGlobalCacheScope()`;
* dynamic sections resolved through the registry.

The boundary is consumed by `splitSysPromptPrefix` (`src/utils/api.ts`) and `buildSystemPromptBlocks` (`src/services/api/claude.ts`): content before it may be sent with `cache_control: {scope: 'global'}`, i.e. shared across users (which is exactly why `getAllBaseTools()` in `src/tools.ts` carries the comment that it must stay in sync with the server-side `claude_code_global_system_caching` config).

**Section registry** - `claude-code/src/constants/systemPromptSections.ts` (path not found in the pinned clone, not verified): `systemPromptSection(name, compute)` returns a memoized section ("computed once, cached until /clear or /compact"), while `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` recomputes every turn and *requires a written reason* because a changing section busts the prompt cache. `resolveSystemPromptSections(sections)` reads/writes the cache in `src/bootstrap/state.ts`.

**Dynamic sections registered** (prompts.ts L491-L555): `session_guidance` (tool/skill/agent-aware bullets), `memory` (`loadMemoryPrompt()`), `ant_model_override`, `env_info_simple`, `language`, `output_style`, `mcp_instructions` (the one `DANGEROUS_uncached` section - "MCP servers connect/disconnect between turns"), `scratchpad`, `frc` (function-result clearing), `summarize_tool_results`, ant-only `numeric_length_anchors` ("keep text between tool calls to <=25 words..."), `[TOKEN_BUDGET]` token_budget, `[KAIROS]` brief.

**What the sections actually say** (verbatim anchors from `src/constants/prompts.ts`):

* Intro (L179): "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user." plus `CYBER_RISK_INSTRUCTION` and "IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming."
* `# System` (L186): text is user-visible and rendered as GitHub-flavored markdown; tools run in a user-selected permission mode and denials are prompts to rethink; `<system-reminder>` tags come from the system; tool results may contain prompt injection and must be flagged; hooks come from the user; "The system will automatically compress prior messages... your conversation with the user is not limited by the context window."
* `# Doing tasks` (L199): the anti-over-engineering block - "Don't add features, refactor code, or make \"improvements\" beyond what was asked...", "Don't add error handling, fallbacks, or validation for scenarios that can't happen...", "Don't create helpers, utilities, or abstractions for one-time operations... Three similar lines of code is better than a premature abstraction.", "In general, do not propose changes to code you haven't read.", "Do not create files unless they're absolutely necessary", "Avoid giving time estimates", and use of the AskUserQuestion tool "only when you're genuinely stuck after investigation".
* `# Executing actions with care` (L255): reversibility/blast-radius doctrine - freely do local reversible things; confirm before destructive, hard-to-reverse, or shared-state actions; "A user approving an action (like a git push) once does NOT mean that they approve it in all contexts"; don't use destructive shortcuts to clear obstacles (no `--no-verify`); investigate lock files/unknown state rather than deleting.
* `# Using your tools` (L269): "Do NOT use the Bash tool to run commands when a relevant dedicated tool is provided" - read with Read not cat/head/tail/sed, edit with Edit not sed/awk, create with Write not heredoc, search with Glob/Grep not find/grep; plus parallel-call guidance.
* `# Tone and style` (L430): no emojis unless asked; `file_path:line_number` citations; `owner/repo#123` for issues; "Do not use a colon before tool calls."
* `# Output efficiency` (L403): external builds get the blunt version ("Go straight to the point... Be extra concise."), ant builds get a much longer "Communicating with the user" essay about writing for a human reader.
* `# Environment` (`computeSimpleEnvInfo`, L651): working directory, is-a-git-repo, additional working dirs, platform, shell (with the Windows note to use Unix shell syntax), OS version via `uname -sr` semantics, model marketing name + exact model ID, knowledge-cutoff date per model, and marketing lines about the Claude family and where Claude Code is available.

**Session-variant guidance** (`getSessionSpecificGuidanceSection`, L352) is deliberately placed *after* the boundary because every conditional there is a runtime bit that would otherwise multiply the global-cache prefix hash variants (the comment cites "2^N variants" and two prior bug PRs). It injects: AskUserQuestion-on-denial advice, the `! <command>` hint, the Agent-tool paragraph (or the fork-subagent variant), Explore-agent guidance with `EXPLORE_AGENT_MIN_QUERIES`, the `/<skill-name>` explanation, DiscoverSkills guidance, and the ant-only adversarial "verification agent" contract.

**Tool prompts.** Each tool's `prompt.ts` supplies the *model-facing* description (the API tool `description`), separate from `description()` used in the permission UI. `toolToAPISchema()` in `claude-code/src/utils/api.ts:119` (path not found in the pinned clone, not verified) builds the API schema: `description: await tool.prompt({getToolPermissionContext, tools, agents, allowedAgentTypes})`, `input_schema`, optional `strict` (only for `strict: true` tools on models that support structured output), plus per-tool API fields; the base schema is cached for the session (`toolSchemaCache.ts`) to avoid mid-session GrowthBook flips or prompt drift churning tool-array bytes.

**Subagent prompts.** `DEFAULT_AGENT_PROMPT` (prompts.ts L758) is the standard subagent identity; `enhanceSystemPromptWithEnvDetails()` (L760) appends the `Notes:` block (absolute paths only, share relevant absolute paths, no emojis, no colon before tool calls) plus env info, and re-adds DiscoverSkills framing for subagents. Built-in agents carry their own prompts (`claude-code/src/tools/AgentTool/built-in/*.ts` (path not found in the pinned clone, not verified)), and `AgentTool/prompt.ts` renders the agent listing (with a switch to inject the list as an attachment instead of the tool description, because the dynamic list was "~10.2% of fleet cache_creation tokens").

**Working example of a tool prompt** (`claude-code/src/tools/TodoWriteTool/prompt.ts` (path not found in the pinned clone, not verified)) - the TodoWrite prompt is the canonical todo-list specification: "Use this tool to create and manage a structured task list for your current coding session...", "## When to Use This Tool ... 3 or more distinct steps", "## When NOT to Use This Tool ... only a single, straightforward task", "NOTE that you should not use this tool if there is only one trivial task", plus worked `<example>` blocks including the dark-mode-toggle example and the rename `getCwd` → `getCurrentWorkingDirectory` example.

**Context and memory injection.** `claude-code/src/context.ts` (path not found in the pinned clone, not verified) supplies `getSystemContext()` (a memoized `gitStatus` snapshot, skipped in remote mode when git instructions are disabled) and `getUserContext()` (the CLAUDE.md chain + additional directories + date), both attached to requests via `prependUserContext()`/`appendSystemContext()` in `src/utils/api.ts`. `src/utils/attachments.ts` then injects everything time-varying as `AttachmentMessage`s (memories, edited files, queued commands, MCP instruction deltas, agent listing deltas, date changes, skill discovery), which is what keeps the system prompt itself stable.


---

## 8. Web UI (`web/`) and the exploration MCP server (`mcp-server/`)

### 8.1 `web/` - Next.js 14 chat client (`claude-code-web@0.1.0`)

Not part of the leaked product; a separate app added by the repo owner that talks to *some* Claude backend. Framework: Next.js 14 App Router + React 18 + Tailwind + Radix UI + `zustand` (state, `persist`) + `swr` + `framer-motion` + `@tanstack/react-virtual` + `shiki`/`react-markdown`/`remark-gfm`. `next.config.ts` enables typed routes, package-import optimisation, compression, cache headers, a `worker-loader` rule for `*.worker.ts`, and browser fallbacks for `fs`/`path`/`os`.

**What it renders.** `app/page.tsx` -> `components/chat/ChatLayout.tsx` (`ChatInput`, `ChatWindow`, `MessageBubble`, `MarkdownContent`, `VirtualMessageList`). Component groups: `a11y`, `adapted`, `chat`, `collaboration`, `command-palette`, `export`, `file-viewer`, `layout`, `mobile`, `notifications`, `settings`, `shortcuts`, `tools`, `ui`. Notably `lib/ink-compat/` re-implements Ink's `Box`/`Text` (with colour and prop mapping) so terminal-style components render in the browser, and `lib/ansi-to-html.ts` + `lib/terminal-compat.ts` render ANSI output.

**How it talks to the backend.** Two channels:

1. **HTTP + SSE proxy**: the browser calls `POST /api/chat`; the Next route handler (`web/app/api/chat/route.ts`) forwards the body to `${NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/api/chat`, attaching `Authorization: Bearer ${ANTHROPIC_API_KEY}` when the env var is set, and streams the upstream body straight back. Client-side, `lib/api.ts#streamChat` reads that body and `lib/api/stream.ts#parseStream` parses SSE frames (`data: ` lines, `[DONE]` terminator, burst-buffered, tracks tokens/sec).
2. **WebSocket** for collaboration: `lib/collaboration/socket.ts` (a reconnecting `WebSocket` client) plus `presence.ts`, `permissions.ts`, `types.ts`, and the `hooks/useCollaboration.ts` / `usePresence.ts` consumers, mirroring the terminal-mode sharing/permission concepts in a browser.

Other routes: `/api/files/read`, `/api/files/write` (file viewer/editor), `/api/export`, `/api/share` and `/api/share/[shareId]` (share links, backed by `lib/share-store.ts`).

**Auth.** The web app itself has no login: it is a local/dev UI that proxies credentials. `.env.example` declares `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `ANTHROPIC_API_KEY`. Settings store (`lib/store.ts`) exposes `apiUrl`, `apiKey`, streaming toggle, model/maxTokens/temperature/systemPrompt, a permissions block (`autoApprove.file_read|file_write|bash|web_search`, `restrictedDirs`), `mcpServers`, keybindings and privacy flags. Contrast this with the *CLI's* own web server, `claude-code/src/server/web` (path not found in the pinned clone, not verified), which does have auth: `auth.ts`, `user-store.ts`, `admin.ts`, `session-manager.ts`, `session-store.ts`, `scrollback-buffer.ts`, `terminal.ts`, `pty-server.ts` (serves `public/` and xterm.js; `AUTH_TOKEN`, `MAX_SESSIONS`, `ALLOWED_ORIGINS`, `CLAUDE_BIN` env vars per `docker/entrypoint.sh`).

### 8.2 `mcp-server/` - the exploration MCP server (`warrioraashuu-codemaster@1.1.0`)

A self-contained TypeScript MCP server (its own `package.json`, `tsconfig.json`, `Dockerfile`, `railway.json`, `.npmignore`, `server.json`) exposing the leaked tree to any MCP client. Three transports: **STDIO** (`src/index.ts`, `node dist/index.js`), **Streamable HTTP** (`src/http.ts`, Express, `POST/GET /mcp`), **legacy SSE** (`GET /sse` + `POST /messages`). `src/server.ts` holds the transport-agnostic definition; the source root is configurable via `CLAUDE_CODE_SRC_ROOT` (defaults to `../../src` relative to the build). `api/index.ts` + `api/vercelApp.ts` publish the same app as a Vercel serverless function (with a caveat in the header comment that Streamable HTTP sessions do not survive serverless invocation); `vercel.json` at repo root routes `/mcp`, `/sse`, `/messages`, `/health` to it.

**Tools (8)**: `list_tools`, `list_commands`, `get_tool_source`, `get_command_source`, `read_source_file`, `search_source`, `list_directory`, `get_architecture`. **Resources (3 + template)**: `claude-code://architecture` (Architecture Overview), `claude-code://tools` (Tool Registry), `claude-code://commands` (Command Registry), template `claude-code://source/{path}` ("Source file"). **Prompts (5)**: `explain_tool(toolName)`, `explain_command(commandName)`, `architecture_overview`, `how_does_it_work(feature)`, `compare_tools(tool1, tool2)`. Server identity announced as `claude-code-explorer` v1.1.0. `server.json` registers it with the MCP registry (`io.github.warrioraashuu/warrioraashuu-codemaster`, stdio, npm identifier).

### 8.3 Packaging / container / tooling

* `claude-code/Dockerfile` (path not found in the pinned clone, not verified) - `oven/bun:1-alpine` builder runs `bun run build:prod` (esbuild bundle -> `dist/cli.mjs`); runtime image installs `git` + `ripgrep` and `ENTRYPOINT ["bun", "/app/cli.mjs"]`.
* `claude-code/docker/Dockerfile` (path not found in the pinned clone, not verified) - the *web terminal* image: installs `python3 make g++` to compile `node-pty`, copies `node_modules`, `dist`, `src/server` and `tsconfig.json`, creates a non-root `claude` user, writes a `/usr/local/bin/claude` shim that execs the bundle, and entrypoints into `bun /app/src/server/web/pty-server.ts` with a healthcheck on `/health`; `docker-compose.yml` adds a `claude-data` volume for `/home/claude/.claude` and a tmpfs `/tmp`.
* `claude-code/scripts/build-bundle.ts` (path not found in the pinned clone, not verified) - esbuild config with three custom concerns: resolving bare `src/...` imports (tsconfig `baseUrl`), injecting `MACRO` values (version from `package.json`), and shimming `bun:bundle` so the code runs outside Bun's bundler; `claude-code/scripts/bun-plugin-shims.ts` (path not found in the pinned clone, not verified) + `claude-code/bunfig.toml` (path not found in the pinned clone, not verified) do the same for `bun run` development via `preload`.
* `claude-code/gitpretty-apply.sh` (path not found in the pinned clone, not verified) clones `codeaashu/gitpretty` into `~/.gitpretty` and replays per-file beautified (emoji) commits so GitHub's file history reads nicely; `--hooks` installs the hook variant.


---

## 9. End-to-end request lifecycle (REPL, interactive)

1. **Launch.** `src/entrypoints/cli.tsx` handles fast paths, then imports `src/main.tsx`. `main.tsx` fires `startMdmRawRead()` and `startKeychainPrefetch()` as side effects *interleaved with* imports (parallelism by import ordering), then builds the Commander program and parses argv (prompt text, `--resume`, `--model`, `--permission-mode`, `--add-dir`, `--mcp-config`, ...).
2. **Init.** `enableConfigs()` + `init()` (`src/entrypoints/init.ts`) apply settings files, MDM/managed policy, remote managed settings and policy limits; telemetry starts after trust; GrowthBook initialises; OAuth/api-key resolution happens lazily. MCP servers are registered from project/user config + flags + plugins.
3. **Context prefetch.** `getUserContext()` reads the CLAUDE.md/memory chain and additional directories; `getSystemContext()` snapshots git status (both memoized, both fire-and-forget while the REPL renders).
4. **Pools.** `getTools(permissionContext)` (or `getMergedTools`/`assembleToolPool` with MCP tools), `getCommands(cwd)` (builtins + skills + plugin commands + workflows), agent definitions from `loadAgentsDir.ts` + built-ins, and the initial `AppState` from `getDefaultAppState()`.
5. **Render.** `launchRepl()` dynamically imports `components/App.tsx` and `screens/REPL.tsx` and renders into the vendored Ink root. REPL subscribes to the AppState store, starts hooks (queue processor, MCP connection manager, IDE/bridge, prompt suggestions), and shows the prompt input.
6. **User submits.** The REPL handles the input: slash command? -> `processSlashCommand` (local / local-jsx / prompt commands); `!cmd` -> bash mode; `#note` -> memory mode; otherwise a normal `UserMessage`. A prompt command expands to text plus `allowedTools`, then behaves like a user turn.
7. **Turn starts.** REPL builds `QueryParams` (messages, systemPrompt from `getSystemPrompt(...)` -> `buildEffectiveSystemPrompt(...)`, user/system context, `toolUseContext`, `canUseTool = useCanUseTool(...)`, `querySource: 'repl_main_thread'`) and iterates `query(params)`.
8. **Loop iteration.** `queryLoop()` snapshots config (`buildQueryConfig()`), starts memory/skill prefetches, applies context shaping (tool-result budget -> snip -> microcompact -> context collapse -> autocompact), then calls `deps.callModel(...)` -> `services/api/claude.ts` -> `@anthropic-ai/sdk` streaming with `withRetry` (backoff, 429/5xx/529 handling, `FallbackTriggeredError` for a configured fallback model).
9. **Streaming.** `stream_request_start` and message events are yielded to the REPL, which renders text deltas, thinking blocks, and tool-use headers incrementally. A `StreamingToolExecutor` may already be running concurrency-safe tools whose inputs have fully arrived.
10. **Tool call.** For each `tool_use` block: `runToolUse()` -> find tool by name/alias -> `checkPermissionsAndCallTool()`:
    * Zod parse (`inputSchema`) -> error tool_result on failure (with a "schema wasn't sent" hint if the tool was deferred);
    * `validateInput()` (path checks, worktree checks, background-task availability, ...);
    * `PreToolUse` hooks (may auto-decide, rewrite input, inject context, or stop the turn);
    * `resolveHookPermissionDecision()` -> `canUseTool()` -> `hasPermissionsToUseTool()` ladder -> maybe prompt the user with the permission dialog (Yes / Yes-and-don't-ask-again / No-and-tell-Claude-what-to-do-differently), or the auto-mode classifier, or the IDE/bridge/channel claimants;
    * on allow: `tool.call()` runs (Bash spawns the shell with sandboxing, Read/Edit/Write touch the filesystem and update `readFileState`/file history, Agent spawns a child `query()` loop with its own context); progress streams back through `onProgress`;
    * result mapping (`mapToolResultToToolResultBlockParam`), size capping/persistence, `PostToolUse` hooks, OTel/analytics logging;
    * `contextModifier` (if any) replaces the tool context for subsequent tools in the batch.
11. **Feeding back.** All tool results plus any attachments (edited files, queued user messages, task notifications, memory hits) are appended to the message list; the loop iterates with `state = next` (`transition: {reason: 'next_turn'}`) until the model stops requesting tools, a stop hook blocks/prevent, budget/maxTurns limits hit, or the user aborts.
12. **Turn end.** Stop hooks run; token/cost accounting updates (`cost-tracker.ts`); the ReplBridge/remote mirrors events if attached; transcripts and session files are persisted (`src/utils/sessionStorage.ts`); the REPL returns to idle (with prompt suggestions/speculation possibly kicking off in the background).

**Headless/SDK variant.** Same loop, different skin: `src/cli/print.ts` (or an SDK consumer) creates a `QueryEngine` with `submitMessage()`, consumes `SDKMessage`s, and `--output-format json|stream-json` serialises them; no Ink rendering, `canUseTool` is either a pre-set decision, the `--permission-prompt-tool` MCP bridge, or immediate deny.

---

## 10. Notable / unique design choices and Claude-Code-specific idioms worth stealing

1. **The system prompt as a cached array with an explicit boundary.** `string[]` sections + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` + `cache_control: {scope:'global'}` turns prompt engineering into a *cache-key* discipline. The comments read like a post-mortem of every bug they hit: variant multiplication (2^N prefix hashes), a dynamic agent list costing 10.2% of fleet cache-creation tokens, "was DANGEROUS_uncached (toggled on getCurrentTurnTokenBudget()), busting ~20K tokens per budget flip". Lesson: name sections, memoize them, forbid volatile content above the boundary, and require a written justification for any section that must break cache (`DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`).
2. **Withholding recoverable errors instead of surfacing them.** Prompt-too-long, media-size and max-output-token errors are pushed into `assistantMessages` but *not yielded* until recovery (context-collapse drain, reactive compact, output escalation, retry with a nudge) has been exhausted, with an explicit rationale: yielding early "leaks an intermediate error to SDK callers (e.g. cowork/desktop) that terminate the session on any `error` field".
3. **Yes/no permission prompts are only one claimant.** `useCanUseTool` builds a `PermissionContext` and lets several sources *race* for the decision (`claim()`): local Ink dialog, IDE/bridge callbacks, MCP "channel" callbacks (Telegram/iMessage), hook-provided decisions, and the auto-mode classifier. First valid claim wins and later ones are discarded - a clean way to keep one decision pipeline across surfaces.
4. **Permission ladder with bypass-immune safety checks.** Content-specific `ask` rules and `checkPathSafetyForAutoEdit` (`.git/`, `.claude/`, `.vscode/`, shell rc files) deliberately outrank `bypassPermissions` *and* an allowing PreToolUse hook; `dontAsk` is applied last so it cannot be short-circuited. This is a good template for "safety > convenience" ordering in any agent permission system.
5. **Fail-closed tool defaults.** `TOOL_DEFAULTS` assumes `isConcurrencySafe: false`, `isReadOnly: false`, `toAutoClassifierInput: ''` (i.e. skip the security classifier unless the tool opts in), so a new tool is safe-by-default rather than unsafe-by-omission.
6. **Deny rules prune the tool list before the model sees it.** `filterToolsByDenyRules` is applied to the *prompt* tool pool, not just at call time (including `mcp__server` server-prefix rules), so denied capabilities cannot be "discovered" or attempted at all.
7. **Tool results have a budget and a disk overflow.** `applyToolResultBudget` caps aggregate tool-result size per conversation, `maxResultSizeChars` per tool decides when a single result is persisted to a file and replaced by a preview + path, and Read opts out (`Infinity`) to avoid Read->file->Read loops. Old results are then clearable (`CACHED_MICROCOMPACT`, with the model told "old tool results will be automatically cleared").
8. **Backfilling observable inputs without mutating cache bytes.** `tool.backfillObservableInput(input)` runs on *clones* so hooks/SDK/transcript see expanded absolute paths and derived fields, while the API-bound input stays byte-identical for prompt caching and VCR fixture hashes.
9. **Prompt-cache-friendly ordering and caching of tool schemas.** Built-ins stay a contiguously sorted prefix, MCP tools are appended sorted (`assembleToolPool`), and base tool schemas are memoized per session so a mid-session GrowthBook flip cannot churn the tool array.
10. **Everything is an async generator.** `query()` yields `StreamEvent | Message | TombstoneMessage` and returns a terminal reason; subagents re-enter the same generator; `ToolUseSummaryMessage` is a Haiku call fired *before* it is needed and awaited a turn later. This makes the whole agent loop composable with a UI that just renders a stream.
11. **Explicit recovery/circuit-breaker state.** `maxOutputTokensRecoveryCount`, `hasAttemptedReactiveCompact` (deliberately *not* reset across stop-hook retries to avoid an infinite compact loop), `consecutiveFailures` for autocompact, and `transition.reason` strings used by tests to assert which path fired.
12. **Perf instrumentation as first-class code.** `profileCheckpoint`/`queryCheckpoint`/`headlessProfilerCheckpoint` are sprinkled through hot paths and comments quantify wins ("~65ms on every macOS startup", "parallel with the remaining ~135ms of imports").
13. **Dead-code elimination as an architecture tool.** `import { feature } from 'bun:bundle'` plus `require()` inside the gated branch means entire tools/commands/UI ship only in builds that need them; `process.env.USER_TYPE === 'ant'` is used as a *build-time define* that must be inlined at each call site to be foldable (documented in `computeEnvInfo`).
14. **`undercover.ts`.** An ant-only mode that strips model names/IDs from the system prompt, commit messages and attribution so internal codenames cannot leak into public repos - with "defense-in-depth" instructions that survive even when the user disables git instructions.
15. **Worktree/agent isolation.** `EnterWorktree`/`ExitWorktree` tools plus `AgentTool`'s `isolation: 'worktree'` give the model a first-class way to work on a copy of the repo; `ExitWorktree(remove)` refuses to delete a dirty tree unless `discard_changes: true`.
16. **Model-fallback with thinking-signature hygiene.** On overload, the loop swaps models, strips signature-bound thinking blocks (`stripSignatureBlocks`, because thinking signatures are model-bound), tombstones the orphaned partial messages, and tells the user why in a system message.
17. **Ripgrep-class tool ergonomics.** The `Grep` tool exposes actual rg flags (`-A/-B/-C/-n/-i/type/glob/multiline`) plus a `head_limit` defaulting to 250 with an explicit comment about context bloat - a good model of "don't wrap a CLI badly".
18. **Skill/plugin/command unification.** Skills, plugin commands, workflow scripts and built-ins are all `Command` objects; `SkillTool` explains that `/<skill-name>` is shorthand that expands to a prompt. One registry, many sources, one invocation path.


---

## 11. UNIQUE vs COMMON vs generic coding agent

### 11.1 Genuinely UNIQUE (rare in the wild; this is what makes the repo worth reading)

| # | Thing | Why it is unusual |
|---|---|---|
| U1 | System prompt as a cache-conscious section array with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and a global cache scope | Almost nobody designs prompts around cross-user cache-key stability, let alone with a `DANGEROUS_uncached...` API that forces the author to justify a cache break |
| U2 | An internal-vs-external prompt split (ant builds get "Communicating with the user" essays, `numeric_length_anchors`, adversarial `verification` agent) selected at build time via `USER_TYPE` | Product-tiered prompting as a build dimension |
| U3 | Withholding recoverable errors from SDK consumers until recovery is exhausted, with a `snipReplay`-style escape hatch | Error-handling policy encoded in an agent loop, not the client |
| U4 | Permission decisions as a multi-claimant race (UI / IDE bridge / MCP channel / hooks / classifier) with `claim()` semantics | Unifies one permission pipeline across terminal, IDE, mobile and chat channels |
| U5 | `StructuredOutput` as a passthrough tool for `--json-schema` | Structured outputs modelled as a *tool* so the loop can stay generic |
| U6 | Speculation + prompt suggestions + `ToolUseSummary` prefetch | Speculative and pre-computed work driven by the user-event stream (`useTypeahead`, `usePromptSuggestion`, `useStartSpeculation`) |
| U7 | Context collapse as a read-time projection with `CtxInspectTool` and `applyCollapsesIfNeeded`, layered with snip -> microcompact -> autocompact | A 4-tier context strategy where only the last tier rewrites history |
| U8 | `ChatCompletions`/Bedrock/Vertex+Azure provider layer with `PROMPT_CACHING_ENABLED` and per-provider cache-control plumbing | Looks like a hard fork of the Anthropic client that has to satisfy four providers |
| U9 | Persisted-share session links (`/share`), `dates`/`url`-keyed share storage, and a `/resume` picker over cross-project session search (`agenticSessionSearch`) | Session portability as a feature (and a serious privacy surface) |
| U10 | A two-stage tool model: `deferred` tools discovered via `ToolSearch`, with "schema not sent" hints and tool-use summary prefill to keep search dead-weight Optional | Tool-search as an alternative to dumping 100+ tools into every request |
| U11 | `undercover.ts` (codenames stripped from prompt/commit/attribution) and `mockAll`/`mockRateLimits`/`vcr.ts` | Internal-deployment concerns elevated to first-class modules |
| U12 | Diagnose-as-product: `startupProfiler` checkpoints, `dumpPrompts`, `/doctor`, `ctx_viz`, `heapdump`, `logEvent` taxonomy | Running the agent is measured like a web service |
| U13 | Codebase concentration: 564 files / ~181K lines in `utils/`, a 4.7K-line `main.tsx`, a 5K-line `REPL.tsx` with vendored Ink, no monorepo packages | Extreme flat-module layout (an anti-pattern to copy structurally) |

### 11.2 Common in mature agent products but notable here

* Tool result size caps + disk persistence; truncation previews.
* Subagents with per-agent tool allowlists, model overrides and background execution.
* Permission modes (`default | plan | acceptEdits | bypassPermissions | dontAsk`) and rule syntax `Tool(specifier)` with allow/deny/ask.
* Plan mode with an explicit approval tool (`ExitPlanMode`) and **edit-and-re-approve** plan review with an inline diff.
* MCP client with OAuth, resources, prompts, elicitation and tool-name namespacing (`mcp__server__tool`).
* Hooks (`PreToolUse`/`PostToolUse`/`Stop`/`SessionStart`/...) configured in settings, able to allow/deny/rewrite.
* Session persistence, resume/continue/fork, transcript export, cost accounting.
* Skills as prompt packages with `allowed-tools` frontmatter and progressive disclosure.
* Sandboxing (`Bash(sandboxed)` / `dangerouslyDisableSandbox`) and read-only validation of shell commands.
* Todo tracking for long tasks (here: both `TodoWrite` and a v2 `Task*` family gated by `isTodoV2Enabled()`).
* Slash-command registry with `local` vs `prompt` vs `local-jsx` command kinds.

### 11.3 Where this is *not* a generic coding agent at all

* **Multiple product surfaces share one loop**: terminal REPL, print/SDK, IDE (VS Code/JetBrains), desktop app, mobile, browser (claude.ai), Telegram/iMessage channels, PTY-over-WebSocket, and a coordinator/teammate swarm mode. Almost all of the code exists to make those shares safe (claim-based permissions, bridge JWTs, remote session managers, `pty-server`).
* **Ant-internal concerns are baked in**: `USER_TYPE === 'ant'` branches, telemetry prefixes (`tengu_*`), GrowthBook gates, policy limits, MDM/managed settings, `mockLimits`, `/break-cache`, `/backfill-sessions`, `--dump-system-prompt`.
* **It is a business surface as much as a dev tool**: `/upgrade`, `/usage`, `/extra-usage`, `/rate-limit-options`, OAuth flows with Azure/Google, x402 stablecoin payments, referral/overage credit grants, `services/claudeAiLimits.ts`.
* **The web/ and mcp-server/ trees are repo-owner additions** not present in the upstream product: a Next.js chat UI and an MCP server that exposes *this* codebase for exploration. Treat them as separate projects that happen to live in the same repo.

---

## 12. Most important absolute file paths

### Must-read core (the equivalent of ~4% of the code that explains ~90% of the design)

* [`claude-code/README.md`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/README.md) - the repo's own map.
* `claude-code/agent.md` (path not found in the pinned clone, not verified) - agent/team/coordinator design notes (the authoritative doc for subsystem layering in this tree).
* `claude-code/Skill.md` (path not found in the pinned clone, not verified) - the skill spec, including the `SKILL.md` frontmatter contract, the progressive-disclosure budget, and the "why `<name>` in command tokens disables `/skill`" rule.
* `claude-code/CONTRIBUTING.md` (path not found in the pinned clone, not verified) - tool/command contribution rules.
* `claude-code/src/main.tsx` (path not found in the pinned clone, not verified) - CLI entry + flags + startup graph.
* `claude-code/src/query.ts` (path not found in the pinned clone, not verified) - the agent loop.
* `claude-code/src/Tool.ts` (path not found in the pinned clone, not verified) - tool contract + `buildTool` defaults.
* `claude-code/src/constants/prompts.ts` (path not found in the pinned clone, not verified) - the system prompt.
* `claude-code/src/constants/systemPromptSections.ts` (path not found in the pinned clone, not verified) - section registry + cache discipline.
* `claude-code/src/utils/api.ts` (path not found in the pinned clone, not verified) - `toolToAPISchema`, tool schema cache, system-prompt rendering.
* `claude-code/src/services/tools/toolExecution.ts` (path not found in the pinned clone, not verified) - per-tool saga (permissions -> call -> hooks -> telemetry).
* `claude-code/src/utils/permissions/permissions.ts` (path not found in the pinned clone, not verified) - the permission ladder.
* `claude-code/src/screens/REPL.tsx` (path not found in the pinned clone, not verified) - interactive UI.
* `claude-code/src/state/AppStateStore.ts` (path not found in the pinned clone, not verified) - the single source of runtime truth.

### Also load-bearing

* `claude-code/src/tools.ts` (path not found in the pinned clone, not verified), `claude-code/src/commands.ts` (path not found in the pinned clone, not verified) - pool assembly and deny filtering.
* `claude-code/src/services/api/claude.ts` (path not found in the pinned clone, not verified), `claude-code/src/services/api/withRetry.ts` (path not found in the pinned clone, not verified) - model I/O and retries.
* `claude-code/src/services/mcp/useManageMCPConnections.ts` (path not found in the pinned clone, not verified) - MCP lifecycle.
* `claude-code/src/tools/AgentTool/runAgent.ts` (path not found in the pinned clone, not verified) - subagent execution.
* `claude-code/src/cli/print.ts` (path not found in the pinned clone, not verified) - headless/SDK surface.
* `claude-code/src/bridge/bridgeMessaging.ts` (path not found in the pinned clone, not verified) - IDE/remote protocol.
* ``claude-code/docs/{architecture` (path not found in the pinned clone, not verified),subsystems,tools,commands}.md` - the repo's own generated docs.


---

## Appendix - evidence and confidence

**Verified directly from source in this pass** (quoted or line-cited above): repo metadata and scale counts; `src/` per-module file/line counts; the `Tool`/`buildTool`/`TOOL_DEFAULTS` contract; the tool registry and deny-rule pruning in `src/tools.ts`; `QueryEngine`/`query()` structure and terminal reasons; the permission ladder, modes, rule syntax and dialog labels; tool input schemas for Read/Edit/Write/NotebookEdit/Glob/Grep/Bash/PowerShell/WebFetch/WebSearch/TodoWrite/Task*/Agent/SendMessage/Team*/Skill/ToolSearch/RemoteTrigger/CronCreate/Sleep/MCP/AskUserQuestion/Config/StructuredOutput/LSP/Brief; the slash-command names; the system-prompt section registry, the boundary constant and the section line numbers; the `web/` framework, store, SSE proxy and collaboration WebSocket; the `mcp-server/` tool/resource/prompt inventory and transports; `Dockerfile`/`docker/`/esbuild/bunfig shim mechanics.

**Inferred or reported, not proven here:** runtime behaviour of feature-gated paths whose modules are absent from the archive (REPL tool, Sleep, Tungsten, Monitor, Workflow, WebBrowser, Snip, CtxInspect, ...); the exact upstream product version these files were cut from; anything about how the `web/` app's external backend (`NEXT_PUBLIC_API_URL`) is implemented, since that service is not in this repo.

**Known caveats:** (1) the tree is a *mixture* of hand-written TypeScript and React-Compiler output with inline source maps, so some files are not the author's literal text; (2) the shipped `docs/*.md` are secondary sources with inaccuracies (tool count, `checkPermissions` shape) - prefer the TypeScript; (3) line numbers cited here were re-checked against this checkout and may shift in other revisions.
