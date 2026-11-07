# Delta audit — opencode (`dev`) vs opencode-v2 (`v2branch`)

**Scope:** everything the three existing reports do **not** cover, with file citations.

- Subject A: `/data/home/forge/repo-tour/opencode` — branch `dev`, 11,377 files / 1,116 dirs (11,336 files, 1,084 dirs excluding `.git`).
- Subject B: `/data/home/forge/repo-tour/opencode-v2` — branch `v2branch` (`7a6ce05`, "2.0 exploration"), 4,509 files / 534 dirs, no `.git` contents (linked worktree).
- Prior reading: `/tmp/deep-opencode-v2-report.md` (235 lines), `/tmp/opencode-report.part1.md` (174), `part2.md` (197), `part3.md` (187, ends mid-sentence at §5.15), `part4.md` (**2 bytes, empty**).
- Method: static reading only. Nothing in either repo was modified; `/data/home/forge/HorizonCode` was not touched. Citation convention: every file mention carries its own full `file://` URL.

> **Working note (provenance of this task).** The opencode tour report stops mid-sentence in part 3 and part 4 was never written, so the entire second half of that repo was never described: TUI, web app, Electron desktop, HTTP server, protocol, generated client, public plugin API, config **schema package**, CLI command surface beyond the handler table, the `@opencode/ai` client, the docs corpora, and all downstream services. This audit fills that hole and the equivalent holes in the v2 branch (whose report intentionally read only `specs/`, `v2/`, `sync/`, `control-plane/`, and `session/projectors.ts`).

---

## 0) Coverage stats

### 0.1 Walk totals

| Repo | Files (excl. `.git`) | Dirs (excl. `.git`) | Files listed | Files opened this pass |
|---|---|---|---|---|
| `/data/home/forge/repo-tour/opencode` (`dev`) | 11,336 | 1,084 | all | ~78 |
| `/data/home/forge/repo-tour/opencode-v2` (`v2branch`) | 4,509 | 528 | all | ~42 |
| **total** | **15,845** | **1,612** | **15,845** | **~120** |

"Files listed" means every directory in both trees was opened and its direct file count recorded (`find -type d` + per-directory `find -maxdepth 1 -type f | wc -l`), so the 1,612-directory walk is complete; "opened" counts files whose contents were read, headed or context-grepped in this pass.

**What the three prior reports cited (the true gap):** 41 repo files total (44 `file://` citations minus 3 that point outside these repos). That is **0.26%** of the 15,845 files, and 0 of the 1,272 `.mdx` docs, 0 of the 326 `.md`, and 0 of the 70 checked-in `.txt` files (prompt corpora, tool descriptions, glossaries).

### 0.2 What each repo actually contains (by type)

| Type | opencode (`dev`) | opencode-v2 |
|---|---|---|
| total files | 11,336 | 4,509 |
| `.ts` / `.tsx` | 5,668 / 1,015 | 1,098 / 382 |
| `.mdx` docs | 629 | 643 |
| `.md` docs | 228 | 98 |
| prompt/desc `.txt` | 29 | 41 |
| `.sql` (schema + migrations) | 20 | 69 |
| assets (svg/png/webp/avif/jpg/ico/aac/mp3/mp4/woff2/zip) | 2,542 | 1,675 |
| test/spec paths | 2,235 | 299 |
| Rust (`.rs`) | 36 | 14 |

### 0.3 Surfaces covered for the first time in this pass

- **opencode:** all 18 `AGENTS.md` doctrine files (root fully; others headed/extracted), the whole `services/site/src/docs/content` site corpus (73 docs incl. the `build/plugins/*` plugin sub-site and `console/*`), `packages/schema/AGENTS.md`, `packages/protocol/src/groups/*` (41 groups, 205 identifier occurrences), `packages/server/src` (58 files incl. pairing, process, workerd, event-feed, media-uri, service-status), `packages/cli/src` (all 119 files listed, ~15 read), `packages/core/src` (519 files, 69 at the root, incl. the 67 KB `git.ts`; subdir inventories for `plugin/` 117, `database/` 89, `session/` 53, `config/` 29, `tool/` 28), CLI/TUI/config/skills/permissions/policies/warming/snapshots/compaction docs, `CHANGELOG.md` highlights, `CONTRIBUTING.md`, `.opencode/**`, `script/`, `infra/`, package inventories for all 37 top-level packages.
- **opencode-v2:** `packages/opencode/src` fully enumerated (44 dirs, 611 lines of file listing) and ~25 files read (permission, LSP, prompts, tool descriptions, TUI plugin host, skill discovery, worktree, snapshot, id, question, config, server routes, share-next, ACP README), `packages/plugin/**` (the TUI + server plugin API, read in full for `tui.ts`), `github/`, `packages/docs`, `.opencode/**`, `STATS.md`, and per-package inventories for all 20 packages.

### 0.4 Not read (explicit list)

Neither repo was executed; nothing was modified. The following were enumerated but **not opened**:

1. **All captured assets** — OC 2,542 and V2 1,675 images/audio/fonts (icon sets like `packages/ui/src/assets/icons/file-types` with 1,089 files each, brand media, screenshots).
2. **Test suites** — OC 2,235 and V2 299 test path matches (only the test *doctrine* was read, via `AGENTS.md` and `.opencode/skills/*`).
3. **Most UI component sources** — `packages/ui` (1,765 files), `packages/session-ui` (256), `packages/gui-plugins` component bodies (1,034), V2 `packages/ui` (1,559), V2 `packages/app` (310) and `packages/console` (446) bodies — only their trees and AGENTS.md were read.
4. **Most i18n translation files** — 20 README translations per repo, 69 entries in the OC app runtime i18n, 63 locale files per GUI plugin across 15 plugins (635 files), and V2's 17 translated doc sets of 35 `.mdx` each plus 7 V2 packages with their own `i18n` directory.
5. **Most `packages/ai` provider/protocol implementations** — OC 776 files (73 providers, 51 protocols) were listed and their signatures sampled, not each codec read.
6. **`packages/codemode` internals** — 105 files; a separate deep report (`/tmp/deep-codemode-report.md`) already exists for this package, so only its tree was re-checked here.
7. **Most `packages/core/src/session/**` and `tool/plugin/**` implementations** — the session runner was covered by the earlier reports and only re-checked by name; individual tool leaves (`read.ts`, `edit.ts`, `shell.ts`, …) were not read.
8. **Database migrations** — OC 59 migration files under `packages/core/src/database/migration`, V2 69 `.sql` files (schema inferred from `.sql.ts` sources and `AGENTS.md` only).
9. **Electron/desktop bodies** — OC `packages/desktop/src/{main,preload,renderer,shared}` (422 files) and V2 `packages/{desktop,desktop-electron}` (438) — only their trees were read.
10. **Website/console/stats application code** — `services/site` (1,647 files), `packages/web` (653), `packages/console` (216 across `app/` and `resource/`), `packages/stats` (135), V2 equivalents — docs *content* was read, components were not.
11. **CI/infra/files** — `.github/**` (OC 59 files, 22 workflows), `infra/*.ts`, `nix/`, `flake.nix`, `patches/`, `salesforce/`, `strobe.json`, `install`, `.husky` hooks: enumerated only.
12. **V2 non-core packages** — `packages/docs` content beyond the file list, `storybook/`, `enterprise/`, `containers/`, `slack/`, `extensions/` were listed but not read.

### 0.5 Caveats

- Counts are of files present on disk excluding `.git` (V2 has no `.git` contents; its `.git` is a 71-byte worktree pointer).
- "Opened" is an honest approximation of files read for content; every quantitative claim in §1–§5 is tied to a citation that was actually read.
- Anything inferred rather than read is marked *(inference)*.


---

## 1) Missed features

### 1.A — opencode-v2 (`v2branch`, commit `7a6ce05`)

The previous v2 report read `specs/` and three probe dirs (`v2/`, `sync/`, `control-plane/`) plus `session/projectors.ts`. Everything else on the 4,509-file branch was untouched. Findings below are in ≈priority order.

**A1. A complete TUI plugin API exists and is more capable than anything else in the corpus.**
`packages/plugin` on this branch publishes `@opencode-ai/plugin` v1.4.3 with three entrypoints — `.`, `./tool`, `./tui` (`file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/package.json#L12-L16`). `./tui` is the surprise: `TuiPluginApi` gives plugins a command registry with slash names/aliases, a **route registry** (plugins navigate to their own routes), the full dialog kit (`Dialog`, `DialogAlert`, `DialogConfirm`, `DialogPrompt`, `DialogSelect`), the *host Prompt component* with refs and pre-filled parts, an extensible keybind set, a KV store, a frozen config view, live read-only state (`session.count/diff/todo/messages/status/permission/question`, `lsp()`, `mcp()`), the SDK client, an event bus, the OpenTUI renderer, a **slot registry**, a plugin manager that can list/activate/deactivate/add/install plugins at runtime, and a lifecycle with disposal (`file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/tui.ts#L450-L494`). The host declares 11 named slots (`app`, `home_logo`, `home_prompt`, `home_prompt_right`, `session_prompt`, `session_prompt_right`, `home_bottom`, `home_footer`, `sidebar_title`, `sidebar_content`, `sidebar_footer`) with typed props per slot (`file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/tui.ts#L322-L355`). Plugins carry install metadata — `source: "file" | "npm" | "internal"`, `fingerprint`, `load_count`, first/last/changed times, and an `updated | first | same` state (`file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/tui.ts#L399-L427`). The branch dogfoods it: seven sidebar/home panels are themselves shipped as internal TUI plugins (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/cli/cmd/tui/plugin/internal.ts#L15-L25`), and `system/plugins.tsx` is a plugin manager panel.
**Why it matters:** this is the *only* surface in either repo where plugins can draw into the UI, and it consumes OpenTUI solid slots (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/cli/cmd/tui/plugin/slots.tsx#L31-L58`). The dev branch later replaced this with a `@opencode/plugin` package whose `tui` export is a *client-side API over the server*, so v2's richer in-process TUI plugin host is a capability that was **removed**, not postponed.

**A2. The server plugin hook set (16 hooks) is public API here.**
`packages/plugin/src/index.ts#L222-L315` defines `Hooks`: `event`, `config`, `tool` (contribute tools), `auth`, `provider`, plus pure *mutation* hooks — `chat.message`, `chat.params` (temperature/topP/topK/maxOutputTokens/options), `chat.headers`, `permission.ask` (can flip ask→allow/deny), `command.execute.before` (rewrite the command's parts), `tool.execute.before` (rewrite args), `tool.execute.after` (rewrite title/output/metadata), `shell.env` (inject env vars per call), `tool.definition` (rewrite description/parameters sent to the model) and four experimental ones: `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting` (append context or *replace* the compaction prompt), `experimental.text.complete` (`file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/index.ts#L222-L315`).
**Why it matters:** `tool.definition` + `chat.params`/`chat.headers` let a plugin change what the model sees and how the provider is called without forking the runner; `shell.env` is a per-tool-call environment injection point. The v2 report's plugin section covered only the catalog-transform *decision*, so the API surface itself was missed.

**A3. Permission system details that a feature catalog usually gets wrong.**
`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/evaluate.ts#L9-L15` shows **last-match-wins** resolution over the flattened ruleset with a default of `ask` — not first-match, not deny-by-default. `ask` on multiple patterns asks once for all of them and only `deny` short-circuits (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L167-L202`). Two cascades exist: replying `reject` **fails every other pending request in the same session** with `RejectedError` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L216-L232`), and replying `always` writes `allow` rules for the request's `always` patterns and then auto-approves any other pending request whose patterns are now fully allowed (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L238-L259`). A rejection can carry **feedback** and becomes `PermissionCorrectedError` instead of a plain rejection — the model is told *how* to correct the call (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L89-L95`). Approvals persist per project in `PermissionTable` and are loaded into `InstanceState` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L144-L165`). Tool names are normalized for rule matching: `edit`, `write`, `apply_patch`, `multiedit` all map to the `edit` permission (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L297-L308`), and config patterns expand `~`, `~/`, `$HOME`, `$HOME/` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L271-L277`).
Separately, `permission/arity.ts` embeds a **generated arity dictionary** for shell commands — longest matching prefix wins, flags never count — used to turn `bun run dev --watch` into the human-approvable `bun run dev`; the LLM prompt that generated the table is checked in above it (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/arity.ts#L2-L24`).

**A4. LSP is a first-class tool with 9 operations and a ~30-server registry.**
`tool/lsp.txt` advertises `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, all 1-based line/character (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/lsp.txt#L3-L19`). The server registry carries per-server `id` + `extensions` + install/init metadata for Deno, TypeScript, Vue, ESLint, Oxlint, Biome, Gopls, ruby-lsp, ty, Pyright, ElixirLS, ZLS, C#, F#, SourceKit, rust-analyzer, clangd, Svelte, Astro, JDTLS and more (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/lsp/server.ts#L60-L107`), and extensions map to language ids in `lsp/language.ts`. The LSP event stream is exposed for the UI (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/lsp/index.ts#L17-L77`). The previous report *speculated* the 2.0 branch had an LSP subsystem; here is the evidence.

**A5. A 31-file model/system prompt corpus is checked in — and it is per model family.**
`session/prompt/` holds 13 system prompts selected by model: `anthropic.txt`, `beast.txt`, `codex.txt`, `copilot-gpt-5.txt`, `default.txt`, `gemini.txt`, `gpt.txt`, `kimi.txt`, `trinity.txt`, plus `plan.txt`, `build-switch.txt`, `plan-reminder-anthropic.txt` and `max-steps.txt` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/session/prompt`). Tool descriptions are separate checked-in files (`tool/*.txt`, 18 of them) and agents have their own prompts (`agent/prompt/{compaction,explore,summary,title}.txt`) plus `agent/generate.txt`, an agent-architect prompt that emits `{identifier, whenToUse, systemPrompt}` JSON with few-shot examples (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/generate.txt#L59-L64`).
Two prompt-design details worth stealing: the title prompt forbids tool names in titles and pins *exact* technical terms/numbers/filenames/HTTP codes while stripping articles (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/prompt/title.txt#L14-L31`); the summary prompt must preserve an unanswered question or a trailing imperative verbatim (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/prompt/summary.txt#L5-L10`). `session/prompt.ts` is 76 KB of prompt assembly alone.

**A6. Plan mode is implemented as two *tools*, not a mode flag.**
`plan-enter.txt` and `plan-exit.txt` are tools whose only effect is to *ask the user* whether to switch agents (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/plan-enter.txt#L1-L12`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/plan-exit.txt#L1-L13`), i.e. the model proposes the phase transition and the user consents. Combined with `build-switch.txt` this is a different decomposition from dev's `PlanPlugin` permission-deny approach.

**A7. Task tool supports resumable subagents via `task_id`, and it is stated in the tool description.**
“Each agent invocation starts with a fresh context unless you provide `task_id` to resume the same subagent session… The output includes a `task_id` you can reuse later” (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/task.txt#L17-L18`). Also explicit: launch multiple agents **in one message** for concurrency, and tell the subagent whether it may write code or only research (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/task.txt#L17-L18`).

**A8. Skill *discovery* over HTTP — remote skill indexes.**
`skill/discovery.ts` pulls `<url>/index.json`, filters entries that lack `SKILL.md`, downloads each file into `Global.Path.cache/skills/<name>/`, skipping existing files, with concurrency 4 skills / 8 files, JSON-accept and transient-read retry (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/skill/discovery.ts#L9-L11`, `#L55-L105`). Skills are therefore distributable as static file trees behind a URL, not only npm packages.

**A9. Worktrees are a full lifecycle service, and `reset` verifies cleanliness.**
Create/list/remove/**reset**; names are slugified with collision suffix, branch is `opencode/<name>`, and boot does `git reset --hard`, recursive submodule reset and then runs an optional `startCommand` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/worktree/index.ts#L208-L254`). Reset refuses the primary workspace and **fails if local changes remain after reset** (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/worktree/index.ts#L505-L579`). Exposed over HTTP as `worktree.create/list/remove/reset` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/server/instance/experimental.ts#L241-L314`).

**A10. Snapshot service: patch/revert/diff with gitignore-aware pruning.**
`Snapshot` exposes `init/track/patch/restore/revert/diff/diffFull` and `Patch`/`FileDiff` schemas (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/snapshot/index.ts#L15-L33`, `#L776-L800`). The interesting part is correctness work: files that became gitignored are filtered out of the snapshot index and removed from it, using `--no-index` pattern checks so previously-tracked files stop being restored (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/snapshot/index.ts#L180-L200`), and batching only merges adjacent files whose paths cannot affect each other (`#L397`).

**A11. REST surface is generated from Hono + OpenAPI per *instance*, and it includes a TUI namespace and PTY websockets.**
`InstanceRoutes` mounts `project, pty, config, experimental, session, permission, question, provider, file, event, mcp, tui` plus `instance.dispose` and `path.get` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/server/instance/index.ts#L28-L56`), all behind `WorkspaceRouterMiddleware` and under Effect runtime (`#L26`, `#L55`). Experimental endpoints cover console orgs, tool ids/list, worktrees, session list and resources (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/server/instance/experimental.ts#L47-L398`). `server/mdns.ts` exists — local discovery is a planned/preview capability (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/server/mdns.ts`).

**A12. Config loading has enterprise-shaped machinery.**
`config/config.ts` reads *system-managed* configuration and macOS managed preferences (`systemManagedConfigDir` at `#L60`, `parseManagedPlist` at `#L94`, `readManagedPreferences` at `#L107`), merges with array concatenation, writes config back with a JSONC-preserving `patchJsonc` (`#L1097`), resolves/dedupes plugin specs by origin (`#L288-L313`), and loads `command/`, `agent/`, `mode/`, `plugin/` directories in addition to files (`#L161-L288`). Config also carries `Layout = auto | stretch` (`#L743`) and a discriminated `Mcp` union of local/remote/oauth (`#L328-L392`).

**A13. IDs are prefixed, time-ordered and reversible.**
`id/id.ts` defines prefixes `evt ses msg per que usr prt pty tool wrk ent`, monotonic counter within a millisecond, 6-byte hex timestamp + base62 tail, total length 26, `ascending()`/`descending()` variants and a `timestamp()` extractor that works only for ascending ids; supplying an id with the wrong prefix throws (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/id/id.ts#L5-L17`, `#L29-L77`). New entity kinds (`entry`, `permission`, `question`, `workspace`, `pty`) are visible in this table — a quick way to date a branch.

**A14. Sharing was being rewritten (`share-next.ts`).**
`ShareNext` defines an API client (`create/sync/remove/data`), an env kill-switch `OPENCODE_DISABLE_SHARE`, its own `ShareNextTable` and Effect layer (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/share/share-next.ts#L20-L28`), while the legacy `share/session.ts` still exists — i.e. sharing was mid-migration at this commit.

**A15. ACP server exists with an honest limitations list.**
`acp/README.md` documents architecture (agent/client/session/server/types), Zed integration, and states plainly what is missing: no streaming `session/update`, no tool-call reporting, no session modes, stub auth/terminal, `session/load` does not restore history (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/acp/README.md#L109-L118`). The question tool is opt-in via `OPENCODE_ENABLE_QUESTION_TOOL=1` and excluded by default because many ACP clients cannot render it (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/acp/README.md#L47-L55`).

**A16. Other never-cited v2 dirs (present, substantive, uncovered):** `script/`, `installation/` (13.9 KB), `storage/json-migration.ts` (JSON→SQLite migration), `pty/` (PTY service + per-runtime adapters), `ide/`, `account/`, `auth/`, `git/`, `file/` (incl. ripgrep wrapper), `format/` (formatter service + builtins), `question/`, `bus/` (global + bus-event), `effect/` (10 files: instance-state, run-service, cross-spawn-spawner, app-runtime), `util/` (34 files incl. `flock.ts`, `keybind.ts`, `wildcard.ts`, `rpc.ts`, `queue.ts`), `command/template/`, `project/` (bootstrap/instance/state/vcs), `npm/`, `patch/`, `provider/sdk/copilot/{chat,responses}` (hand-rolled Copilot protocol codecs), `plugin/codex.ts` (19.5 KB provider plugin), `github/` (a published GitHub Action with its own package.json and publish/release scripts), `packages/docs` (Mintlify site), `packages/{app,console,desktop,desktop-electron,sdk,storybook,enterprise,containers,slack,extensions}`.

### 1.B — opencode (`dev`, v2.2.5)


---

The tour report stopped at §5.15 (ACP) mid-sentence. Parts 1–3 had covered identity, package graph, entry points, agents, the session runner, execution/coordination, prompt admission, tools, providers, MCP, permissions (surface), config (surface), plugins, LSP *absence*, auth, bus/storage and telemetry. Everything below was never described.

**B1. The HTTP surface is ~170 endpoints across 41 `HttpApi` groups — several never named by the report.** Extracted from `packages/protocol/src/groups/*.ts`: `experimental.persistentPty.{create,get,list,update,remove,connect,connectToken,read,snapshot,handoff,shutdown}`, `pty.{create,get,list,update,remove,connect,connect.token}`, `session.form.{create,get,list,reply,cancel}` + `form.list`, `session.{background,generate,context,environment,move,fork,view,wait,log,skill,stats}`, `session.instructions.entry.{list,put,remove}`, `session.revert.{stage,commit,clear}`, `session.inbox.{list,cancel,update,move}`, `vcs.{get,init,status,diff,base,branch.list}`, `worktree.{create,list,refresh,remove}`, `integration.{list,get,connect.external,connect.key,oauth.*,command.*}`, `credential.{list,create,update,remove,activate}`, `usage.limits`, `voice.{models,session}`, `websearch.{providers,query}`, `generate.{image,text,decisions,textLegacy}`, `migration.v1.status`, `media.get`, `reference.list`, `rpc.call`, `skill.list`, `shell.{create,get,list,output,remove}`, `server.{connect,info,pair}`, `debug.{heapDump,location.list,location.evict}`, `permission.{request.list,saved.list,saved.update,saved.remove}`, `config.shells`, `plugin.{check,gui,list,update}`, `fs.{read,list,find}`, `experimental.fs.{watch,unwatch,write}`, `experimental.job.list`, `experimental.mcp.*`, `experimental.session.{export,import,stats,wait}`. Group assembly, and the Location middleware applied to exactly 15 groups, is at `file:///data/home/forge/repo-tour/opencode/packages/protocol/src/api.ts#L1-L60`.

**B2, `opencode mini` and `opencode pair`.** `file:///data/home/forge/repo-tour/opencode/packages/cli/src/mini.ts` and `run/noninteractive.ts` are separate frontends over the same client; `mini` takes `--continue/--session/--fork/--model/--agent/--prompt/--replay/--replay-limit/--demo`, refuses to run without a controlling terminal (`file:///data/home/forge/repo-tour/opencode/packages/cli/src/mini-host.ts#L9`) and persists model preferences through a repository (`#L17-L22`). `pair` uses a 5-minute-TTL pairing code with `issue`/`consume` (`file:///data/home/forge/repo-tour/opencode/packages/server/src/pairing.ts#L9-L14`) and is exposed as `server.pair`.

**B3. CLI mechanics never described.** `services/site/src/docs/content/cli/commands.mdx` documents `run` (L8), `mini` (L89), `session` (L121), `auth` (L171), `models` (L222), `mcp` (L236), `plugin` (L286), `stats` (L330), `serve` (L374), `pair` (L400), `service` (L435), `reload` (L497); `cli/config.mdx` has a mini section and `cli/web.mdx` documents a standalone web mode (L105). Enabling mechanics: a git-style optional-value flag parser with `--color[=when]` semantics (`file:///data/home/forge/repo-tour/opencode/packages/cli/src/framework/flag.ts#L3-L8`), the embedded web-UI archive format (u32 length-prefixed JSON index plus brotli bodies, `file:///data/home/forge/repo-tour/opencode/packages/cli/src/app-archive.ts#L3-L8`), an `ssh-askpass` bridge run outside CLI observability so prompts never enter logs (`file:///data/home/forge/repo-tour/opencode/packages/cli/src/ssh-askpass.ts#L8-L10`), and `services/remote-tunnel.ts`, which claims a random subdomain route instead of the tunnel hostname so the service address stays unguessable (`file:///data/home/forge/repo-tour/opencode/packages/cli/src/services/remote-tunnel.ts#L6-L14`).

**B4. Operability: heap dumps and CPU/memory profiles are first-class.** `debug.heapDump` is an endpoint, and `troubleshooting.mdx` documents capturing a heap snapshot (L114) and CPU/memory profiles (L166), backed by `packages/cli/src/heap.ts` and `cpu-profile.ts`.

**B5. dev permissions are richer than the report implies.** From `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/permissions.mdx`: rules are `{action, resource, effect}` with **last match wins** (L24, L87-L89); actions are open strings so plugins may add more, and the built-ins are enumerated with exact resource semantics including `shell` (scanner-produced command string), `external_directory`, `subagent`, `skill`, `question`, `webfetch`, `websearch`, MCP `<server>_<tool>` and `execute` (L109-L126); a shell pattern ending in `` *` also matches the bare command (L79-L85); multi-resource operations resolve deny &gt; ask &gt; allow (L100-L102); the built-in **shell scanner** covers Bash/Zsh/POSIX sh/PowerShell and refuses malformed or dynamically-evaluated commands rather than executing unverified subcommands (L192-L210), and permission rules plus saved-approval patterns apply to every extracted subcommand and `cd` target; the default base policy allows everything except `.env` reads that ask, with `.env.example` allowed (L216-L223), and each shipped agent appends its own table (L227-L235); approvals are `once | always | reject` where `always` saves tool-proposed patterns (shell proposes command prefixes) that never override a configured deny (L273-L291); and **policies** run after rules and saved approvals, can only tighten (allow/ask to deny), and Console-managed policies outrank project config (L296-L308). `doom_loop` and `lsp` are explicitly "not current V2 Core permission actions" (L139).

**B6. Policies are an enterprise control plane with 8 action types.** opencode services/site/src/docs/content/policies.mdx L39-L52 defines provider.use, tool.use, integration.connect, integration.use, mcp.use, skill.use, plugin.use and websearch.use with binary allow/deny statements and wildcard resources; statements that fail validation are dropped with a warning in the server log while the rest of the list still applies; a denied provider disappears from the catalog even with valid credentials (L24-L26).

**B7. Session warming exists.** opencode services/site/src/docs/content/warming.mdx: disabled by default; enable with `warming: true` or `{prompt, interval, duration}` (defaults 4-minute idle interval, 30-minute window, with a keep-alive prompt that asks the model to do no work and reply OK). `interval: "auto"` warms at 90% of the model cache.ttl so a 5m cache is warmed every 4.5 minutes (L55-L59). Implementation: packages/core/src/plugin/warming.ts.

**B8. Undo/redo is a snapshot workflow, not a diff viewer.** opencode services/site/src/docs/content/snapshots.mdx: `/undo` stages a rollback, restores files and returns the prompt to the composer; submitting the edited prompt commits it; `/redo` cancels (L8-L35). Capture happens at model-step boundaries with changed-path recording (L36-L48); scope is the session active directory inside a Git worktree, tracked files plus non-ignored untracked files up to **2 MiB each** (L50-L67). Backed by endpoints session.revert.stage/commit/clear.

**B9. Compaction has background mode and a percentage buffer.** opencode services/site/src/docs/content/compaction.mdx headings include Start, Manual, Settings, Model, Background compaction (L121), Providers, Summaries, Objective, Next Move, Limits, Migration. opencode CHANGELOG.md L7 adds `compaction.buffer: "20%"` — a percentage of the model context window rather than a token count (also L16) — and L30-L31 record compaction prompt capping to the context window plus LiteLLM context errors now triggering compaction.

**B10. Skills have HTTP catalogs and compatibility directories.** opencode services/site/src/docs/content/skills.mdx L39-L66: global `~/.config/opencode/skills`; compatibility `~/.claude/skills` and `~/.agents/skills`; project `.opencode/skills` plus `.claude/skills` and `.agents/skills`, searched from the current directory up to the project root, stopping six directories deep, skipping hidden dirs and node_modules; a directory containing SKILL.md is one skill and is not searched further. The `skills` config array accepts relative, `~/`, absolute and **http(s) catalog** entries, combined rather than replaced across config files (L67-L93). A catalog is an index.json with `{name, version, files}` entries downloaded from `<base>/<name>/<file>`, requiring safe same-origin relative paths and a version bump to refresh the cache (L94-L119).

**B11. Autonomous goals are a real subsystem.** opencode packages/core/src/plugin/goal.ts runs a kickoff/continuation/reminder/judge prompt loop (prompts live in plugin/goal/) with `MAX_OBJECTIVE = 4_000`, `MAX_ROUNDS = 50`, `MAX_STALLS = 3` and `WAIT_LIMIT = 30 minutes` (L15-L19); a goal that sits idle on hung background work pauses (L234); a process identity marker makes a goal armed by an earlier server process come back **paused** instead of resuming on its own (L20). A TUI panel exists (packages/tui/src/feature-plugins/prompt/goal.tsx) and `goal*` tools are registered.

**B12. Per-model prompt families and verbosity are plugin logic in dev.** opencode packages/core/src/plugin/optimize.ts selects a system prompt by model id (gpt, gpt-astra, kimi, meta, trinity, anthropic) with prompts under plugin/system-prompt/*.txt; plugin/verbosity.ts distinguishes direct providers from gateways to decide verbosity support; plugin/identity.ts injects a `# Your Model` block naming model and provider id.

**B13. Tool-input repair is an enumerated behavior.** opencode packages/core/src/plugin/tool-input-repair.ts L8-L18 lists exactly which malformed inputs are repaired (stringified root/nested objects, closed-object extra keys, null or empty-object placeholders, numeric/boolean strings, nullable fields, stringified arrays, positional tuples, typed dictionaries, nested local references) with `maxDepth = 6` (L20), and repairs apply only when the schema unambiguously supports them.

**B14. Background jobs are durable and model-visible.** opencode packages/core/src/job.ts models a job with a **notification message id**, a recovery record and status lifecycle running | completed | error | cancelled plus output/error; the live list distinguishes backgrounded items (packages/core/src/job/list.ts L17-L21) and `experimental.job.list` exposes them. Related: session/background.ts, session/subagent-job.ts, session/subagent-completion.ts and the `session.background` endpoint.

**B15. Scheduling is a core service with an experimental HTTP surface.** opencode packages/core/src/schedule.ts (32 KB) persists schedules with Effect Cron, conditions, ends and outcomes and a Latch-based waiter; the surface is `experimental.schedule.*` and the tools include schedule, schedule_create, schedule_list, schedule_pause, schedule_resume, schedule_delete (packages/core/src/tool/plugin/schedule.ts).

**B16. Artifacts: agents that can publish.** opencode packages/core/src/artifact.ts (22 KB) implements create/update/delete over content with a provider abstraction (built-in local static-file provider) and session-scoped ids; four tools (artifact_create/read/update/delete) and an `experimental.artifacts.*` client namespace exist behind `experimental.artifacts` (opencode CHANGELOG.md L54, L62, L100).

**B17. Voice, usage limits, integrations, references, forms and RPC are all full services with protocol groups.** opencode packages/core/src/voice.ts negotiates realtime transports against a credential; usage-limits.ts fetches console-backed per-provider/model limits with an UnavailableError; integration.ts (36 KB) is the connection/OAuth/CLI-command hub behind integration.*; repository.ts plus repository-cache.ts implement Git **and file** references with per-remote tracking checkouts that refresh at most once a day and hard-reset under a flock (repository-cache.ts L1-L20); form.ts is a schema-driven interactive form service with a 10-minute retention behind session.form.*; and rpc.call exposes a plugin RPC channel (packages/plugin/src/effect/rpc.ts).

**B18. Git is 67 KB of domain logic.** opencode packages/core/src/git.ts is the largest non-session module (with snapshot.ts, worktree.ts, vcs.ts, vcs/patch.ts and util/git-executable.ts).

**B19. The provider layer is its own package with 73 providers and 51 wire protocols.** opencode packages/ai/src/protocols/ spans OpenAI chat/responses, Anthropic messages, Gemini, Bedrock converse and event-stream, Cohere, Mistral, Alibaba, Meta, Google images/speech/video/transcription, ElevenLabs, Deepgram, AssemblyAI, Cartesia, MiniMax and Cloudflare workers-ai/decisions plus OpenAI-compatible variants; packages/ai/src also holds cache-policy.ts, effort-updates.ts, decision-client.ts, media-* and experimental/{realtime,extraction,cloudflare-run-extraction}.ts. Dev also keeps aisdk.ts and aisdk-native.ts as AI-SDK bridges.

**B20. Model reasoning variants are modeled explicitly.** opencode packages/core/src/variant.ts defines `Support = effort | toggle | budget_tokens` derived from the models.dev v2 reasoning shape (L7-L17), alongside model-compatibility.ts and model-retry.ts.

**B21. The public plugin API is three surfaces, not one.** opencode packages/plugin/src has promise/* (client-side), effect/* (25 typed hook modules incl. rpc.ts, registration.ts, storage.ts, shell.ts, worktree.ts, integration.ts, with PLAN.md and README.md) and gui/* (23 files: reactive registries, slot declarations, host APIs, Vite/HMR, Solid and typechecks). The docs ship a whole plugin sub-site: build/plugins/{index,server,effect,rpc,cli,gui,migrate-v1}.mdx and build/plugins/effect/rpc.mdx under services/site/src/docs/content/build/plugins.

**B22. Desktop GUI plugins are shipped plugins, not built-ins.** opencode packages/gui-plugins/src contains browser, btw, context, debug, details, file, goal, microsoft-office, pairing, review, sources, ssh, terminal, updater and wsl, with per-plugin i18n in fifteen of them (63 locale files each, 635 total) and a 23 KB AGENTS.md as doctrine.

**B23. The dev TUI is a plugin host too.** opencode packages/tui/src/feature-plugins ships home, prompt (btw, footer, goal), sidebar (context, footer, limit, mcp, todo) and system plugins including a **diff viewer** (file menu, file tree, image diff), stats, notifications and a **storybook with fixtures** (system/storybook/*); also present: attention.ts plus attention-sounds.{bun,node}.ts (audio cues), editor-zed.ts plus editor-zed-sqlite.* (Zed integration through its SQLite state), mini/ (mini frontend), devtools/ and simulation/ harnesses and model-preference.ts.

**B24. The web app is a full workspace product with its own plugin runtime.** opencode packages/app/src holds composer (attachments/editor/history/suggestions), home (projects/sessions/start), new-session (location/project/workspace), providers (catalog/connect/models), runtime/plugin (78 files), runtime i18n (69 locales), servers (connect/registry), session (commands/composer/header/requests/timeline), settings (10 sections), shell (commands/errors/layout/notifications/routes/state/tabs/titlebar), usage, voice, workspaces (files/selection) and a components-lab, with a 19.8 KB AGENTS.md.

**B25. Notable smaller packages never cited:** packages/{simulation,http-recorder,httpapi-codegen,stories,latex,merman,patchmark,theme,effect-drizzle-sqlite,identity}; packages/process-daemon (Rust opencode-pty: portable-pty plus libghostty-vt, with SPEC.md, PLAN.md, AGENTS.md, Windows daemon tests and a zig-backed release script); sdks/vscode; salesforce/; patches/; strobe.json; nix plus flake.nix; infra/ (sst app, console, share, stage, stats, webapp); services/{site,files,update,changelog}; packages/console/app routes (enterprise, go, zen, sso/scim docs, budgets, members, oauth, download, stats); packages/stats/{core,app,server}.

**B26. Repo self-configuration is a teaching artifact.** opencode .opencode/skills ships eight contributor skills (unit-tests, tui-tests, app-e2e-tests, component-tests, effect, opencode-dev, rtl-aware-development, sample-skill) referenced from root AGENTS.md L196; .opencode/glossary has 18 glossary files used by the translation workflow (V2 keeps 17 but drops the contributor `.opencode/skills` directory entirely); .opencode/command/* are the project own slash commands; .opencode/tool/github-pr-search.ts is its own tool.

**B27. @opencode/schema has an explicit migration policy.** opencode packages/schema/AGENTS.md requires current contracts to be unversioned and legacy ones named *V1 under src/v1/ (L12-L19), classifies events as current | shared transitional | V1-only and forbids V1-only events such as message.updated from entering the current SDK surface (L21-L27), bans duplicated definitions and bridge aliases (L29-L35), mandates an optional(...) helper so encoded objects omit undefined (L51-L56), forbids public Schema.mutable and Schema.Any (L70-L81), and requires generated id schemas to validate the exact prefix including the underscore (L83-L90).

---

## 2) Common patterns (both checkouts)

**P1. Everything is an Effect service keyed by a scope that is not the process.** V2: `makeRuntime(Service, layer)` for every service plus `InstanceState` — a `ScopedCache` keyed by directory, so each open project gets its own copy and disposal is automatic; the doctrine explicitly forbids extra fibers/`started` flags on top (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/AGENTS.md#L34-L41`) and recommends `Effect.cached` for in-flight dedupe (`#L52-L54`) and `Instance.bind` for native callbacks (`#L56-L69`). Dev: the same idea generalized into `Location`/`LocationServiceMap` with `LayerMap` builds, a held warning after 30 seconds and job/session activity tracking per location (`file:///data/home/forge/repo-tour/opencode/packages/core/src/location-services.ts#L1-L25`, `file:///data/home/forge/repo-tour/opencode/packages/core/src/location-activity.ts#L1-L20`). Both repositories therefore treat "per-project state" as a first-class lifetime, not a global.

**P2. Single-writer event logs with a per-aggregate sequence, and no distributed clocks.** V2 states the constraint outright — one device writes, many sync — and implements `event_sequence(aggregate_id pk, seq)` plus an ordered `event` table (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/sync/README.md#L73-L97`). Dev keeps the same core in the Bus (per-aggregate monotonic sequence, transactions running projectors under a keyed mutex) and adds the public surface on top: `log({aggregateID, after, follow})` with a `log.synced` watermark (`file:///data/home/forge/repo-tour/opencode/packages/core/src/bus.ts#L767-L860`). The shared rule: ordering is a number per aggregate, and the hard part is projection, not consensus.

**P3. Registries are scope-owned transform stacks, not routers.** Dev: `Agent`, `Tool` and config domains all expose `Editor`s consumed through `State.Transformable`, where a transform is a *replayable synchronous edit* whose `dispose` invalidates the derived value (`file:///data/home/forge/repo-tour/opencode/packages/core/src/state.ts#L6-L14`); the tool spec then layers registration semantics on top ("latest active registration wins; closing reveals the next-latest") in `specs/v2/tools.md`. V2: the same shape in the TUI (`register`/`unregister` route sets keyed by symbol, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/cli/cmd/tui/plugin/api.tsx#L52-L76`) and in the plugin manager (`plugins.list/activate/deactivate/add/install`, `file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/tui.ts#L486-L492`).

**P4. Prompts and tool descriptions are checked-in files, selected per model — in both repos.** V2 ships 13 session prompts plus model-family variants and 18 tool description files (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/session/prompt`); dev does the same job through `packages/core/src/plugin/system-prompt/{gpt,gpt-astra,kimi,meta,trinity,anthropic}.txt` chosen by model id (`file:///data/home/forge/repo-tour/opencode/packages/core/src/plugin/optimize.ts#L9-L17`) and `packages/core/src/session/runner/prompt/system.txt`. Both keep tool prose next to the tool (`tool/*.txt`, `tool/plugins/*`).

**P5. Permission/approval shape is nearly identical, and both default to asking.** `{permission|action, pattern|resource, effect|action}` triples; last match wins; unmatched means ask; approving "always" persists tool-proposed patterns (dev: project-scoped saved approvals that never override a configured deny; v2: `approved` rules pushed from `request.always`); a rejection cascades to siblings in v2 and carries optional model-facing feedback (dev documents the same choice list, `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/permissions.mdx#L273-L294`). Dev adds three things the branch lacks: a shell scanner that refuses unanalyzable commands, an `external_directory` boundary action, and tightening-only policies.

**P6. ID scheme: brand + time-ordered + validated prefix.** V2 `Identifier` (prefixes `evt ses msg per que usr prt pty tool wrk ent`, 6-byte timestamp + base62, 26 chars, ascending/descending, `timestamp()` extractor that refuses descending ids). Dev's schema package enforces the same contract from the other side — generated ID schemas must validate exactly the prefix they emit including the underscore, and directional constructors survive only where ordering is part of the contract (`file:///data/home/forge/repo-tour/opencode/packages/schema/AGENTS.md#L83-L90`).

**P7. Worktree-scoped VCS is the unit of isolation in both.** V2 `Worktree.create/remove/reset` (branch `opencode/<name>`, `git reset --hard` plus submodules in boot, reset verified clean). Dev keeps worktrees, adds snapshots per step, session `move` between locations, a per-remote `repository-cache` of tracking checkouts and a `vcs.*` REST group.

**P8. Extension points are always "internal plugin + user plugin", with the internal set guarded.** Dev: `plugin/internal.ts` declares a `pre`/`post` list of ~40 built-ins and a `guarded` set that repo config cannot remove (`file:///data/home/forge/repo-tour/opencode/packages/core/src/plugin/internal.ts#L244-L283`, `#L309-L311`). V2: `INTERNAL_TUI_PLUGINS` for the sidebar/home panels (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/cli/cmd/tui/plugin/internal.ts#L15-L25`) and a plugin manager that lists internal/file/npm sources side by side.

**P9. Documentation as shipped artifact: per-package doctrine + translated READMEs + glossaries.** OC has 18 `AGENTS.md` files (the largest 23 KB in `packages/gui-plugins`), 21 translated READMEs and 18 glossary files under `.opencode/glossary`; V2 has 7 `AGENTS.md` files (including a database/Effect doctrine file, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/AGENTS.md#L1-L10`), 21 translated READMEs and 17 glossary files — but no `.opencode/skills`. Doc corpora are large in both (629/643 `.mdx`).

**P10. Generated, capability-negotiated media/terminal surfaces.** Dev negotiates `media:` refs through a capability header (`file:///data/home/forge/repo-tour/opencode/packages/server/src/media-uri.ts#L1-L9`) and routes PTY/MCP/pairing tickets through one request classifier (`file:///data/home/forge/repo-tour/opencode/packages/server/src/process.ts#L1-L14`); V2 has the same shape in miniature with connect-token endpoints for PTY and MCP clients. Both prefer a short-lived ticket over an ambient credential.

**P11. Test harnesses that ship with the product.** Dev ships `packages/simulation` (deterministic backend with a simulated provider, a protocol, a recorder and a control server) plus `packages/http-recorder` (cassette record/replay of HTTP and WebSocket) and Playwright story/component harnesses. V2 ships a test LLM server (`provideTmpdirServer`) and a fixture library with `tmpdir({git, config, init, dispose})`, an `it.effect`/`it.live` split (TestClock vs real time) and mandatory instance binding (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/test/AGENTS.md#L83-L125`).

**P12. Operability is a feature: status, dumps, traces, profiles.** Dev has `service.status` (`starting|ready|stopping|failed`, `file:///data/home/forge/repo-tour/opencode/packages/server/src/service-status.ts#L1-L11`), `debug.heapDump`, CPU profiles, request tracing, an OTLP exporter and a documented troubleshooting flow; the CLI even ships a `heap.ts`/`cpu-profile.ts` pair. V2 has `server.info`, `instance.dispose`, mdns and mDNS-adjacent discovery, but no equivalent diagnostics surface — evidence that the diagnostics layer matured on dev.

---

## 3) Unique capabilities not yet in a typical feature catalog

Each entry names the capability, the checkout that has it, and one evidence path.

**U1. A TUI plugin host with slots, route registration and runtime enable/disable.** Not a theme or a keybind file: plugins get 11 typed mount slots, their own full-screen routes, dialog primitives, the *host prompt component*, a command registry with slash names, and `plugins.activate/deactivate/add/install` at runtime, with install metadata (`source`, `fingerprint`, `load_count`, `updated|first|same`). `file:///data/home/forge/repo-tour/opencode-v2/packages/plugin/src/tui.ts#L322-L355`, `#L450-L494`.

**U2. A shell permission scanner instead of a regex allowlist.** Dev analyses Bash/Zsh/POSIX sh/PowerShell, extracts every subcommand and `cd` target, applies rules and saved approvals to each, and **refuses to execute** commands it cannot safely analyse; it also states plainly that directory inference is best-effort and that `shell` runs with the user's full authority. `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/permissions.mdx#L192-L210`.

**U3. A generated shell-arity dictionary that turns a command into the approvable prefix.** Longest matching prefix wins, flags never count, and the LLM prompt that generated the table is checked in above the table itself. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/arity.ts#L2-L24`.

**U4. Bounded autonomous goal loops.** Kickoff → continuation → judge with hard caps (4,000-char objective, 50 rounds, 3 stalls, 30-minute wait) and a process-identity rule that demotes an orphaned goal to *paused* instead of silently resuming it. `file:///data/home/forge/repo-tour/opencode/packages/core/src/plugin/goal.ts#L15-L19`.

**U5. Session warming driven by the provider's own cache TTL.** Keep-alive requests at `4m` idle for up to `30m` after the last real request, with `interval: "auto"` computed as 90% of the model's `cache.ttl`. `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/warming.mdx#L22-L59`.

**U6. Two-phase (staged) undo/redo.** `/undo` stages a rollback and returns the prompt to the composer; submitting commits it, `/redo` cancels; capture is per model step and best-effort. `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/snapshots.mdx#L8-L48`.

**U7. Gitignore-aware snapshot pruning.** Files that became ignored are dropped from the snapshot index (checked with `--no-index` so previously-tracked files stop being restored) and adjacent-file batching only merges paths that cannot affect each other. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/snapshot/index.ts#L180-L203`.

**U8. Tool-input repair as an enumerated, bounded transformation.** Nine named repair classes plus a depth cap, allowed only when the schema unambiguously supports the rewrite. `file:///data/home/forge/repo-tour/opencode/packages/core/src/plugin/tool-input-repair.ts#L8-L20`.

**U9. Per-model prompt/verbosity/identity plugins.** System prompt by model id, verbosity support gated on direct-vs-gateway connection, and an injected "# Your Model" block. `file:///data/home/forge/repo-tour/opencode/packages/core/src/plugin/optimize.ts#L9-L17`.

**U10. Skill distribution over plain HTTP catalogs.** `index.json` with `{name, version, files}`, same-origin relative path rules, version-bump cache refresh, concurrent download and compatibility scanning of `~/.claude/skills` and `~/.agents/skills`. `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/skills.mdx#L94-L119`; the branch's implementation is `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/skill/discovery.ts#L55-L105`.

**U11. Interactive forms as a session primitive.** A schema-driven form service with a 10-minute retention, four endpoints (`create/get/list/reply`) plus `cancel`, and a global `form.list` — a richer interaction than ask-a-question. `file:///data/home/forge/repo-tour/opencode/packages/core/src/form.ts#L1-L14` and the `session.form.*` identifiers in `packages/protocol/src/groups/form.ts`.

**U12. Persistent PTY sessions with snapshot and hand-off.** Beyond a live terminal: create/read/snapshot/handoff/shutdown/connect-token endpoints, so a terminal belongs to a session and can move. `experimental.persistentPty.*` in `file:///data/home/forge/repo-tour/opencode/packages/protocol/src/groups/persistent-pty.ts`.

**U13. Realtime voice as a first-class provider capability.** `voice.models`/`voice.session` negotiate WebRTC or WebSocket transports against a credential and a route executor. `file:///data/home/forge/repo-tour/opencode/packages/core/src/voice.ts#L1-L20`.

**U14. Artifacts: agents that publish served content.** create/read/update/delete plus a provider abstraction (built-in local static-file provider) behind `experimental.artifacts`. `file:///data/home/forge/repo-tour/opencode/packages/core/src/artifact.ts#L1-L20`.

**U15. Console-backed usage limits as data, not policy.** `usage.limits` returns per-model/provider limits with an `UnavailableError`, i.e. budgets enforced by the hosted console rather than by static config. `file:///data/home/forge/repo-tour/opencode/packages/core/src/usage-limits.ts#L8-L21`.

**U16. Tightening-only organization policy separate from permissions.** Eight statement actions (`provider.use`, `tool.use`, `integration.connect`, `integration.use`, `mcp.use`, `skill.use`, `plugin.use`, `websearch.use`), never prompting, invalid statements dropped with a warning, Console policy outranking project config. `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/policies.mdx#L39-L52`.

**U17. Reference worktrees for git and http/file references with a shared cache.** A reference resolves to a local path, a git ref or a URL; per-remote tracking checkouts refresh at most once a day and hard-reset under a flock, with documented storage/refresh/permission rules. `file:///data/home/forge/repo-tour/opencode/packages/core/src/repository-cache.ts#L1-L20`, `file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/references.mdx#L121-L160`.

**U18. Session affinity for provider prompt-cache routing.** One line, big effect: a child session shares its parent's routing key and a fork shares the fork source's. `file:///data/home/forge/repo-tour/opencode/packages/core/src/session/affinity.ts#L6-L9`.

**U19. Task resumption by `task_id`, stated in the tool description.** Subagents can be continued rather than restarted, and the description instructs the model to parallelize by issuing several Task calls in one message. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/task.txt#L17-L18`.

**U20. Plan mode as consent-gated tools rather than a mode bit.** Enter/exit plan are tools whose only effect is asking the user to switch agents, so the phase transition is proposed by the model and approved by the human. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/plan-enter.txt#L1-L12`.

**U21. Device pairing with a short-lived code, and tunnel routes that resist guessing.** Five-minute TTL `issue`/`consume` (`file:///data/home/forge/repo-tour/opencode/packages/server/src/pairing.ts#L9-L14`) plus a tunnel that claims a *random subdomain route* because certificate transparency logs would otherwise reveal the address (`file:///data/home/forge/repo-tour/opencode/packages/cli/src/services/remote-tunnel.ts#L6-L14`).

**U22. An honest capability-limits document inside the product.** The branch's ACP README lists what is unimplemented (no streaming updates, no tool-call reporting, no session modes, stub auth/terminal, `session/load` does not restore history) next to the architecture it does implement. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/acp/README.md#L109-L118`.

**U23. Hand-rolled provider protocol codecs when the vendor SDK is not an option.** Copilot chat and responses wire formats are implemented in-tree, including their tool-call encodings. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/provider/sdk/copilot`.

**U24. An embedded, compressed web UI shipped inside the CLI binary.** A single blob with a u32-length JSON index and brotli bodies, chosen over base64/JS-string embedding with the tradeoffs written down. `file:///data/home/forge/repo-tour/opencode/packages/cli/src/app-archive.ts#L3-L8`.

**U25. A local-discovery path (mDNS) for the desktop/host story.** Present as a service with no equivalent in dev's tunnel/pairing surfaces. `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/server/mdns.ts`.

---

## 4) Docs-worthy items (proposed one-line names)

Proposed entries for a feature/docs catalog, each a single line with its evidence. Names are the doc title I would ship.

**From `dev` (`opencode`) — product docs**

1. **Permissions: rules, actions and resources** — triples with last-match-wins, an open action set, and per-action resource semantics (`file:///data/home/forge/repo-tour/opencode/services/site/src/docs/content/permissions.mdx`).
2. **The shell scanner: what your agent is actually allowed to run** — subcommand extraction, `cd` targets, refusal on unanalyzable input, best-effort directory inference.
3. **Approvals and saved patterns** — `once | always | reject`, durable patterns, and why a saved approval cannot widen a deny.
4. **Policies: tightening-only organization controls** — eight actions, dropped-invalid statements, Console precedence.
5. **Session warming and prompt-cache TTLs** — keep-alive semantics and `interval: "auto"` = 90% of `cache.ttl`.
6. **Undo/redo: a staged snapshot workflow** — stage, edit the prompt, commit or `/redo`.
7. **Snapshot scope and pruning** — worktree-bounded, gitignore-aware, 2 MiB per-file cap.
8. **Skills: discovery, catalogs and versioned distribution** — compatibility dirs, six-level search, HTTP catalogs.
9. **References: git and file sources with a shared checkout cache** — 24-hour refresh policy, visibility and permissions.
10. **Autonomous goals: bounded loops and stall handling** — caps, drain step, orphaned-goal pause. Evidence `packages/core/src/plugin/goal.ts`.
11. **Tool-input repair: what is auto-fixed and why** — nine repair classes, depth cap, schema-disambiguation rule.
12. **Per-model prompts and verbosity** — prompt families by model id, gateway vs direct.
13. **Artifacts: agent-published content** — provider abstraction and `experimental.artifacts` namespace.
14. **Interactive forms** — schema-driven prompts with retention and cancellation.
15. **Background jobs and their notifications** — durable statuses and the `experimental.job.list` surface.
16. **Persistent PTY: terminals that belong to a session** — snapshot/handoff/connect-token.
17. **Voice sessions** — realtime transport negotiation per model.
18. **Usage limits from the Console** — budgets as fetched data with an explicit Unavailable state.
19. **Pairing codes and tunnel route privacy** — 5-minute TTL; random subdomain because CT logs are public.
20. **Diagnostics 101** — heap dumps, CPU/memory profiles, tracing, `service.status`.

**From `opencode-v2` — branch docs**

21. **TUI plugins: slots, routes, dialogs and the host prompt** — `packages/plugin/src/tui.ts`.
22. **Installing and isolating TUI plugins** — install fingerprint, relative `./` resolution inside the plugin dir, `debugger`/`install` options.
23. **Shell arity: how commands are normalized for approval** — longest-prefix rule, flags ignored, generated table.
24. **Permission evaluation order** — deny → rule → saved → config → agent (dev may adopt this as documented precedence).
25. **Skill discovery from HTTP indexes** — and, as an open item, cache refresh semantics (see O-1).
26. **Worktrees: create, reset, verify** — branch naming, `git reset --hard`, submodule handling.
27. **The ACP surface: implemented vs not** — honest limits list alongside the architecture.
28. **Session index/search and cross-session messaging** — `packages/core/src/session/search.ts`, `session/message.ts`.
29. **Local discovery with mDNS** — host/instance advertisement.
30. **Snapshot honesty** — step-boundary capture, auto-paused snapshots, `!: file` large-file skipping and why a restored file keeps content once tracked.

**Repo-level meta docs (both)**

31. **Prompt corpus discipline** — prompts and tool descriptions live as files under version control, selected per model.
32. **Current vs V1 schema contracts** — unversioned current, `*V1` legacy, no bridge aliases (`packages/schema/AGENTS.md`).
33. **Feature-flag lifecycle** — type → env → CLI → delete; rule: no unused reserved flags.
34. **Effect service doctrine** — `makeRuntime` + instance state, no ad-hoc fibers, `Instance.bind` for callbacks.
35. **Verification doctrine** — what must be tested, and the harnesses to do it (simulation/http-recorder/Playwright; tmpdir/testEffect/LLM-server).

---

## 5) Optimization ideas

Grouped by axis, each tagged with the checkout it applies to and the evidence it rests on.

### Speed

- **O-S1 (`v2`) Log-per-evaluation on the permission hot path.** `evaluate()` itself logs at info level on every invocation (`permission/index.ts#L133-L135`), and the `ask` loop logs once more per pattern (`#L169-L176`), so one tool call with several patterns writes several info lines; `BashArity.prefix` also rebuilds candidate strings per call. Move the per-pattern log to debug (keep one line per decision) and memoize the arity prefix per command. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L133-L176`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/arity.ts#L2-L10`.
- **O-S2 (`v2`) Discover-once skill pulls.** `Discovery.pull` re-walks every configured index and stats every file on each session start (concurrency 4/8). Cache the index response with an ETag and skip the whole pull when the index is unchanged. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/skill/discovery.ts#L53-L84`.
- **O-S3 (`dev`) Snapshot cleanup cadence.** Snapshots prune with `gc --prune=7.days` per cleanup pass over a repo whose step count can be large; batching GC per session end (or per N steps) would cut the dominant repo-hygiene cost. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/snapshot/index.ts#L241-L249` (same shape on dev).
- **O-S4 (`both`) Event-feed backpressure is all-or-nothing.** Dev’s subscriber capacity is 4,096 and overflow fails the subscriber (`SubscriberOverflowError`); a slow consumer loses the whole stream rather than dropping volatile events. Classify events (durable vs volatile) and drop volatile ones first. Evidence: `packages/server/src/event-feed.ts`.
- **O-S5 (`dev`) Skill scans are per-walk, not memoized.** `SkillScan.scan` walks up to six levels across the skill directories with symlink `stat` resolution, and nothing caches the result by directory mtime or generation. A per-location cached scan invalidated by mtime would remove a repeated filesystem walk from session start. Evidence: `file:///data/home/forge/repo-tour/opencode/packages/core/src/config/plugin/skill-scan.ts#L9-L40`.

### Capabilities

- **O-C1 (`v2`) Adopt staged undo/redo.** The branch has snapshots but no user-facing stage/commit revert workflow; dev’s session.revert.* endpoints and `/undo` semantics are the ready blueprint (`services/site/src/docs/content/snapshots.mdx`).
- **O-C2 (`v2`) Adopt the shell scanner and `external_directory` action.** The branch’s arity prefixing is a good normalizer but it will happily approve `git …` chains that dev’s scanner would decompose; combining both gives per-subcommand rules with a provable fallback of “refuse”. Evidence for the gap: `packages/opencode/src/permission/arity.ts` + `index.ts` vs dev `permissions.mdx`.
- **O-C3 (`dev`) Adopt arity normalization for “always” approval suggestions.** Dev documents that shell proposes command prefixes; the branch shows a generated, reviewable table for exactly that, which would reduce both over-broad saved patterns and repeated prompts. Evidence: `packages/opencode/src/permission/arity.ts`.
- **O-C4 (`both`) Port the goal loop and warming with cache-TTL awareness across checkouts.** Dev has both (`plugin/goal.ts`, `plugin/warming.ts`); the branch has neither, and its provider layer already exposes `cache.ttl` data via models.dev. Evidence: dev files above.
- **O-C5 (`both`) Unify the interaction ladder: question tool, form endpoints, permission requests.** Dev carries three interaction shapes — a question tool (`packages/core/src/tool/plugin/question.ts` plus `packages/schema/src/question.ts`), schema-driven forms with a 10-minute retention behind `session.form.{create,get,list,reply,cancel}` and `form.list` (`packages/core/src/form.ts#L8`), and permission requests behind `permission.request.list` and `permission.saved.{list,update,remove}`. The branch ships question and permission surfaces but no form endpoints. One shared protocol shape with common retention/expiry rules would remove a class of duplicated UI work. Evidence: `file:///data/home/forge/repo-tour/opencode/packages/core/src/form.ts#L8`, `file:///data/home/forge/repo-tour/opencode/packages/protocol/src/groups/form.ts`.
- **O-C6 (`v2`) Give providers the same breadth of wire codecs as dev’s `ai` package group.** Dev carries 51 protocols incl. image/speech/transcription/video; the branch’s provider codecs are narrower, which bounds what `generate.*` surfaces can do. Evidence: `packages/ai/src/protocols` (dev) vs `packages/opencode/src/provider/sdk` (branch).
- **O-C7 (`both`) Make tool-output truncation a shared service with a documented marker.** Dev owns truncation in the tool-output layer, the branch in `tool/truncate.ts`; both should keep the marker identical across checkouts so transcripts migrate. Evidence: `packages/opencode/src/tool/truncate.ts`.
- **O-C8 (`v2`) A `/plugins` management surface already exists in the TUI host — expose its metadata to the SDK.** `PluginEntry` (source/fingerprint/load_count/version) is richer than what any HTTP group returns; exposing it would let external tooling mirror plugin state. Evidence: `packages/plugin/src/tui.ts#L486-L494`.

### Accuracy

- **O-A1 (`v2`) Skill catalogs cannot update an existing skill.** The index schema ignores `version` entirely and `download()` returns early when the destination file exists, so a version bump never refreshes cached files; dev’s docs make the version bump the contract for refresh. Fix: compare `version` against a stored marker and delete/replace the tree on change. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/skill/discovery.ts#L12-L29` and `#L40-L41`.
- **O-A2 (`v2`) A synthesized `allow` can outrank a user’s broader `deny`.** Agent loading merges the user config after the defaults (`Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))`, `agent.ts#L262`), then appends a synthesized allow for the truncation glob unless the agent holds an *exact* `external_directory` deny for that same glob (`#L265-L277`). Evaluation is last-match-wins via `findLast` (`permission/index.ts#L303`), so `external_directory: { "*": "deny" }` in user config is overridden by the synthesized allow. Synthesize before the user merge, or treat any broader deny as explicit. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/agent.ts#L262-L277`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/permission/index.ts#L303`.
- **O-A3 (`v2`) The directory boundary is opt-in per tool, not centrally enforced.** Evaluation has no `directory` field; each tool passes its own `patterns` (e.g. `read` asks with `patterns: [filepath]`, `tool/read.ts#L110-L111`) and the outside-the-project check lives in a helper tools must call (`tool/external-directory.ts#L34-L35`, plus `bash.ts#L229-L231` for scanned `cd` targets). A tool that forgets the helper silently has no boundary. A central post-check on resolved paths — or a test that every path-taking tool asks — would make the guarantee structural. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/external-directory.ts#L34-L35`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/tool/read.ts#L110-L111`.
- **O-A4 (`both`) Generation temperatures are per-agent and undocumented.** The branch’s built-in title agent runs at `temperature: 0.5` (`agent.ts#L203-L209`) while the main summarization path uses `0.3` (`#L352-L356`); neither is stated in the docs, and dev’s summary path is worth the same audit because summary quality feeds compaction and therefore every later turn. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/agent.ts#L203-L209`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/agent/agent.ts#L352-L356`.
- **O-A5 (`both`) Keep prompt admission honest about remote instructions.** Dev has a dedicated instruction/attachment pipeline; the branch relies on AGENTS.md injection. A shared test — “a remote README instruction never outranks project config” — would pin the guarantee. Evidence: dev `session/instructions.ts`; branch `session/instruction.ts`.
- **O-A6 (`dev`) Best-effort directory inference should be user-visible.** The permission docs already disclose that directory checks are heuristic; surfacing “could not determine target directory” on the approval card (rather than only scanning the command) would convert a silent approximation into an informed choice. Evidence: `services/site/src/docs/content/permissions.mdx#L192-L210`.

### Robustness (fits none of the three axes cleanly, kept for completeness)

- **O-R1 (`v2`) MCP timeouts surface as tool errors.** `withTimeout` is a `Promise.race` rejecting with `Operation timed out after {ms}ms` (`util/timeout.ts#L1-L14`), applied to `listTools`, `connect` and calls (`mcp/index.ts#L163-L166`, `#L257-L264`); a call that merely took long therefore reads to the model as a failed tool, not a slow one. Returning a tool-level result that says “timed out; retry or narrow the query” keeps the session diagnosable. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/util/timeout.ts#L1-L14`, `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/mcp/index.ts#L163-L166`.
- **O-R2 (`v2`) The global bus is unbounded.** The wildcard channel and every per-type channel are `PubSub.unbounded` (`bus/index.ts#L52`, `#L77`), so a slow subscriber — an SSE client, a TUI connection, a plugin — accumulates events in memory with no lag signal; dev’s feed caps at 4,096 with an explicit `SubscriberOverflowError` (`packages/server/src/event-feed.ts#L8-L11`). A bounded option plus an “events dropped” notice would make the failure visible instead of fatal. Evidence: `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/bus/index.ts#L52-L77`, `file:///data/home/forge/repo-tour/opencode/packages/server/src/event-feed.ts#L8-L11`.

---

### Reading notes on §1–§5

- Every quantitative claim (counts of endpoints, tools, providers) was produced by enumerating the file or the definition list named in the sentence; where a number comes from a doc rather than code, the doc is cited.
- Line ranges for very large files (e.g. `config.ts`, `git.ts`, `snapshot/index.ts`) were taken from `grep -n` of the definition or comment being described, not from a full read; the surrounding text was then read.
- Items marked *(inference)* are deduced from adjacent code, not observed running.


---

### Verification pass (corrections over the first draft of §5)

After writing §5 the following claims were re-checked against the files and corrected: O-S1 re-pointed at `permission/index.ts#L133-L176` (the log is in `evaluate()` and the `ask` loop, not in `evaluate.ts`); O-S5 replaced (no `command-completion.ts` exists on dev — the real, verifiable cost is the uncached `SkillScan` walk); O-S6 removed (`Pty.write` passes the string straight to the process, no base64/decoder rework to do); O-A2/O-A3 rewritten against the actual agent merge (`agent.ts#L262-L277`) and the opt-in `external-directory` helper; O-A4 corrected to the observed temperatures (title 0.5, summarizer 0.3); O-R1 re-pointed at `util/timeout.ts` and its MCP call sites; O-R2 re-pointed at the bus (`PubSub.unbounded`) after `session/index.ts` showed no unbounded queue; O-C5 corrected because dev exposes `question` as a tool plus schema, not a `session.question` endpoint.
