# OpenCode Repository Tour — `dev` branch ([`sst/opencode`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0))

A deep, exhaustive code-organization tour. Read-only research: nothing in the repo was modified.

Worktrees:
- `dev` branch: [`sst/opencode`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0)
- `2.0` branch ("2.0 exploration", single commit `7a6ce05`, worktree branch `v2branch`): `opencode-v2` (repo not cloned, path not verified)

---

## 1. Identity

| Field | Value |
|---|---|
| Repo / org | `anomalyco/opencode` (formerly `sst/opencode`) — "The open source coding agent" |
| Checked-out branch | `dev` (the `v2branch` worktree also checked out at the v2 path) |
| Version | **2.2.5** (`package.json`); `CHANGELOG.md` titled "Release notes for OpenCode V2" |
| Package manager / runtime | `bun@1.4.4`; TypeScript 6.0.2 (catalog) + `@typescript/native` (TS 7.1 beta) for CI/publish |
| Orchestrator | Turborepo 2.10.2 (`turbo.json`), bun workspaces |
| License | MIT |
| Default branch | `dev` |

`README.md` markets the CLI (`@opencode/cli`, installed to `$HOME/.opencode/bin`), a **Desktop App (BETA)** (Electron: `.dmg` / `.exe` / `.deb`), two built-in agents — `build` (default) and `plan` (read-only) — and a `general` subagent. The repo is not the classic single-package layout: it is a **~40-package Bun workspace** organized around an **Effect-based, event-sourced core**, split so contracts flow one direction. `AGENTS.md` states the rule ([`opencode/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/AGENTS.md#L1-L4)):

```md
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit generated client files directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk` composes Client, Core, and Server.
- This repository does not use Changesets. Do not add `.changeset` files; follow the existing release workflow instead.
- The default branch is `dev`.
```

The repo enforces a strong engineering doctrine (`AGENTS.md`, 216 lines): a **"Session Core"** section that reads like a spec, an **experimental-API** convention, **feature flags** in `packages/schema/src/config/flag.ts`, and a style guide (no `else`, no aliased/star imports, `const` over `let`, snake_case Drizzle columns). See the closing section [`opencode/AGENTS.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/AGENTS.md#L205-L216):

```md
## Session Core
- Keep durable events minimal: record irreducible new facts ...
- Keep durable prompt admission separate from model execution. `Session.prompt(...)` publishes `session.inbox.enqueued` ...
- Keep `SessionExecution` process-global and Session-ID based.
- Each step is one explicit `llm.stream` call that continues from reloaded history. Do not add an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes ...
- One step is one logical LLM call ... "turn" is reserved for the future assistant-turn unit ...
```

---

## 2. Top-level map

```
[`sst/opencode`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0)
├── packages/            ~40 workspaces (the product)
├── services/            site, files, update, changelog (Cloudflare Workers)
├── sdks/vscode          VS Code extension (the only SDK dir on dev)
├── specs/v2             design contracts & decision records
├── infra/               sst infra as code: app, console, share, stage, stats, webapp
├── script/              release.ts, generate.ts, pack.ts, lint/ast-grep, sdk-docs
├── .opencode/           this project's own opencode config: agent, command, skills, themes, tool
├── .github/workflows/   release.yml, check-test.yml, deploy-*, triage-*, nightly-beta
├── install              installer script
├── nix/ flake.nix sst.config.ts sst-env.d.ts
└── AGENTS.md README*.md CONTRIBUTING.md CHANGELOG.md package.json turbo.json bunfig.toml
```

Root `package.json` workspace globs ([`opencode/package.json`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/package.json#L38-L45)):

```json
"workspaces": {
  "packages": [
    "packages/*", "packages/plugins/*", "services/*", "packages/console/*", "packages/stats/*"
  ],
  "catalog": { ... }
}
```

`bunfig.toml` pins `minimumReleaseAge = 259200` (3 days) with a long `minimumReleaseAgeExcludes` allowlist, and guards root tests ([`opencode/bunfig.toml`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/bunfig.toml#L1-L8)):

```toml
[install]
exact = true
# Only install newly resolved package versions published at least 3 days ago.
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = [ ... ]

[test]
root = "./do-not-run-tests-from-root"
```

`turbo.json` defines a `transit` task whose only job is to fold every workspace dependency into the cache hash, so `typecheck`/`test` re-run when a dependency changes ([`opencode/turbo.json`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/turbo.json#L49-L59)):

```json
// Workspace packages export their sources, so tests never wait for a dependency's build...
"transit": { "dependsOn": ["^transit"] },
"test": { "dependsOn": ["transit"], "outputs": [] }
```

`script/` contains `release.ts`, `generate.ts`, `pack.ts`, `lint-changed.ts`, `sdk-docs.ts`, `profile-typecheck*.ts`, `upgrade-opentui.ts`, plus `ast-grep/` rule sets (`sgconfig.yml`, `effect-simplifications/`) and `github/`, `hooks/`, `oxlint/`, `native-arch.ts`, `format.ts`.

`.github/workflows/` includes `release.yml`, `release-dry-run.yml`, `release-process-daemon.yml`, `check-test.yml`, `check.yml`, `check-nix.yml`, `check-process-daemon.yml`, `nightly-beta.yml`, `deploy-{changelog,files,site,update}.yml`, `deploy.yml`, `bot-*.yml`, and `triage-*.yml`.

`specs/v2/` holds `README.md`, `session.md`, `tools.md` (current contracts), decision records `event-stream-architecture.md`, `provider-policy.md`, `claude-agent-provider.md`, and historical `catalog-config-plugin-lifecycle.md`. `specs/v2/README.md` fixes the authority order ([`opencode/specs/v2/README.md`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/specs/v2/README.md#L9-L14)):

```md
| Concern | Owner |
| HTTP operations and transport errors | Protocol endpoint definitions assembled by Server `HttpApi` |
| Public domain shapes and durable event payloads | Schema |
| Runtime behavior and persistence | Core |
| Contributor-critical regression guardrails | Root AGENTS.md |
```

`infra/` files (`app.ts`, `console.ts`, `share.ts`, `stage.ts`, `stats.ts`, `webapp.ts`) are orchestrated by `sst.config.ts`, deploying Cloudflare + AWS + Stripe + PlanetScale across stages `beta`/`dev`/`production` ([`opencode/sst.config.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/sst.config.ts#L33-L49)):

```ts
async run() {
  if ($app.stage === "beta") { const { createWebApp } = await import("./infra/webapp.js"); return { WebAppUrl: createWebApp("beta.opencode.ai").url } }
  const stage = await import("./infra/stage.js")
  await import("./infra/app.js")
  const stats = stage.deployStats ? await import("./infra/stats.js") : undefined
  await import("./infra/console.js")
  await import("./infra/share.js")
  return { ...(stats ? { StatsUrl: stats.publicUrl } : {}), AwsStage: stage.awsStage }
}
```

The repo's own config lives at `.opencode/opencode.jsonc`, `agent/translator.md`, `command/*.md`, `skills/*/SKILL.md` (unit-tests, tui-tests, app-e2e-tests, component-tests, effect, opencode-dev, rtl-aware-development, sample-skill), `themes/`, `tool/github-pr-search.ts`, `tui.json`.

---

## 3. Package graph + responsibilities (all packages)

`ls packages/` = `ai app cli client codemode console core desktop effect-drizzle-sqlite function gui-plugins http-recorder httpapi-codegen identity latex merman patchmark plugin plugin-browser plugins process-daemon protocol schema script sdk server session-ui simulation stats stories theme tui ui util web`. Plus `packages/console/{app,resource}`, `packages/stats/{app,core,server}`, `packages/plugins/figma`, `services/*`, `sdks/vscode`. All shipped npm packages are versioned **2.2.5** in lockstep (except tooling-only `@opencode/script`, `@opencode/stories`, `@opencode/console-resource`).

| Path | npm name | Responsibility |
|---|---|---|
| `packages/schema` | `@opencode/schema` | **Public domain shapes + durable event payloads.** Config schema, session/message/provider/tool/event schemas. Lowest layer. |
| `packages/core` | `@opencode/core` | **Domain behavior + persistence.** Agents, sessions, tools, providers, MCP, permissions, plugins, DB, event bus. The engine. |
| `packages/protocol` | `@opencode/protocol` | **Public API definitions** — Effect `HttpApi` groups + middleware + OpenAPI. |
| `packages/server` | `@opencode/server` | **HTTP server + runtime composition.** Handlers, routing, auth, CORS, middleware, workerd variant. |
| `packages/client` | `@opencode/client` | **Generated TS clients** (promise/effect/solid) generated from the `HttpApi`. |
| `packages/cli` | `@opencode/cli` | **CLI entrypoint + service lifecycle.** TUI/server bootstrap, ACP server, background service. |
| `packages/tui` | `@opencode/tui` | **Terminal interface** — TypeScript + OpenTUI + SolidJS (`@opentui/core|keymap|solid`). |
| `packages/app` | `@opencode/app` | **Shared web interface** (SolidJS/SolidStart); dev server + Playwright e2e (`packages/app/e2e`). |
| `packages/desktop` | `@opencode/desktop` | **Electron desktop app** (`src/main`, `src/preload`, `src/renderer`, `src/shared`). |
| `packages/plugin` | `@opencode/plugin` | **Plugin API** — `promise`, `effect`, `tui`, `gui`, host, runtime, source loaders. |
| `packages/plugin-browser` | `@opencode/plugin-browser` | "OpenCode's desktop browser plugin." |
| `packages/ai` | `@opencode/ai` | Unified AI client + native `providers/*` (73 entries) and `protocols/*` wire codecs; `LLMClient`, image/speech/transcription/video/decision clients. |
| `packages/ui` | `@opencode/ui` | Shared SolidJS component library (Kobalte, motion, diffs, katex, fuzzysort). |
| `packages/session-ui` | `@opencode/session-ui` | Session rendering components (timeline, tools, pierre diffs, message, storybook). |
| `packages/theme` | `@opencode/theme` | TUI theme tokens/resolution. |
| `packages/util` | `@opencode/util` | Cross-cutting utilities: `effect/*`, `global`, `process`, `npm`, `fs-util`, `observability/*`, `runtime/*`. |
| `packages/codemode` | `@opencode/codemode` | "Effect-native confined code execution over schema-described tools" (the `execute` tool engine; depends only on `acorn` + `effect`). |
| `packages/simulation` | `@opencode/simulation` | Deterministic backend/frontend harness (`backend`, `frontend`, `protocol`, `recording`, `control-server`). |
| `packages/sdk` | `@opencode/sdk` | Composes Client + Core + Server into an embeddable SDK (also `workerd`). |
| `packages/httpapi-codegen` | `@opencode/httpapi-codegen` | Codegen from Effect `HttpApi`. |
| `packages/http-recorder` | `@opencode/http-recorder` | "Record and replay Effect HTTP and WebSocket traffic with deterministic cassettes." |
| `packages/gui-plugins` | `@opencode/gui-plugins` | Built-in GUI plugins (office docs `@betteroffice/*`, `@pierre/trees`, `ghostty-web`, tanstack query/virtual). |
| `packages/latex` | `@opencode/latex` | TUI LaTeX renderer (opentui). |
| `packages/merman` | `@opencode/merman` | TUI Mermaid renderer (opentui). |
| `packages/patchmark` | `@opencode/patchmark` | Patch/diff markup renderer. |
| `packages/stories` | `@opencode/stories` | Playwright component-story harness (`index.html`, `playwright/`, `vite.config.ts`). |
| `packages/script` | `@opencode/script` | Shared build/release scripting. |
| `packages/web` | `@opencode/web` | Marketing/docs site (Astro + Starlight; `content/`, `pages/`, `components/`). |
| `packages/console/app` | `@opencode/console-app` | Billing/console web app (SolidStart; `routes/`, `api/`, `changelog/`, `docs/`). |
| `packages/console/resource` | `@opencode/console-resource` | Cloudflare resource bindings. |
| `packages/stats/core` | `@opencode/stats-core` | Stats drizzle core + migrations. |
| `packages/stats/app` | `@opencode/stats-app` | Stats web app. |
| `packages/stats/server` | `@opencode/stats-server` | Stats worker (`cron.ts`, `sync.ts`, `workflow.ts`). |
| `packages/function` | `@opencode/function` | Cloud functions (Octokit, Hono, jose). |
| `packages/plugins/figma` | `@opencode/plugin-figma` | "Figma MCP integration and official Figma skills for OpenCode." |
| `packages/identity` | *(no package.json)* | Brand assets (marks/logo PNG+SVG). |
| `packages/effect-drizzle-sqlite` | *(no package.json)* | Examples-only helper dir for Effect + Drizzle + SQLite. |
| `packages/process-daemon` | *(no package.json, Rust)* | "opencode-pty" — threaded PTY service core in Rust (`portable-pty` + `libghostty-vt`), auth'd local socket, protocol 8. |

`services/`: `@opencode/site` (Astro/Vite docs+marketing), `@opencode/files`, `@opencode/update`, `@opencode/changelog` (Wrangler Workers). `sdks/vscode` = `opencode` VS Code extension (esbuild, eslint, vscode-test).

**Dependency direction (enforced):** `schema` is the root; `core` and `protocol` depend on `schema`; `server` depends on `core` + `protocol`; `client` may depend on `schema` + `protocol` but never `core`/`server`; `sdk` is the only package that composes `client` + `core` + `server`. `packages/server/src/routes.ts` and `packages/core/src/plugin/internal.ts` are the composition roots that assemble the Core service graph.
