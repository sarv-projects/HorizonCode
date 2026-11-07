# Delta audit — grok-build, DeepSeek-Reasonix, oh-my-pi

_Read-only delta audit. Companion to the four prior reports (`/tmp/grok-build-report.md`, `/tmp/grok-report.md`, `/tmp/DeepSeek-Reasonix-report.md`, `/tmp/oh-my-pi-report.md`). Nothing in `/data/home/forge/repo-tour/**` was modified. All checks were performed on the trees as they exist on disk (snapshot dated 2026-11-06)._

Method: for each repo, (a) counted files by type and by directory, (b) enumerated every non-source feature-bearing artifact class (docs, prompts, configs, schemas, fixtures, CLI/tool definitions, memory/sandbox assets, packaging, CI, scripts, benchmarks), and (c) diffed that inventory against what the four prior reports actually name. Only artifacts a prior report never mentions, or mentions without the file that carries the feature, are listed as deltas.

---

## 0. Coverage stats per repo

File counts exclude `.git/`. "Prior report" = the report(s) that cover the repo.

### 0.1 grok-build — `/data/home/forge/repo-tour/grok-build`

| Measure | Value |
|---|---|
| Files total | 4,516 |
| `.rs` | 3,689 |
| `.md` | 251 |
| `.json` | 258 |
| `.toml` | 114 |
| `.yaml` | 45 |
| `.txt` | 48 |
| `.sample` | 14 |
| `.sbpl` (macOS Seatbelt profiles) | 3 |
| `.rhai` | 1 |
| `.proto` | 3 |
| `.kt` / `.swift` (generated protocol bindings) | 3 / 1 |
| Workspace members | 107 (89 `crates/codegen`, 12 `crates/common`, `crates/build`, `prod/mc`, 4 `third_party`) |

Prior-report coverage: **`/tmp/grok-build-report.md` (608 lines, 65 KB) is thorough** — crate table, entry points, request lifecycle, unique/common split, path index. **`/tmp/grok-report.md` (106 lines, 5.7 KB) is incomplete**: it stops mid-sentence inside its crate table (line 106 ends `| \`xai`), so sections 3.x–9 of that report never got written. Treat `grok-build-report.md` as the covering report and `grok-report.md` as a partial duplicate, not a second opinion.

Still missed by both (detail in §1.1): the 332-file changelog corpus, the prompt-template `.md` files and their XOR build step, the 9-chapter tutorial, the per-scenario PTY e2e corpus, the Seatbelt `.sbpl` profile files, the compaction prompt assets, the example hooks tree, the `deep_research.rhai` workflow, generated Kotlin/Swift protocol bindings, the npm distribution package, and two crates (`xai-grok-shared`, `xai-grok-test-support`).

### 0.2 DeepSeek-Reasonix — `/data/home/forge/repo-tour/DeepSeek-Reasonix`

| Measure | Value |
|---|---|
| Files total | 10,918 |
| `.go` | 6,636 |
| `.tsx` / `.ts` | 1,110 / 771 |
| `.py` | 592 (benchmark task fixtures + `scripts/official-theme-art` + `tools/trajectory` only) |
| `.md` | 522 |
| `.mjs` / `.sh` | 242 / 194 |
| `.toml` | 157 |
| Docs under `docs/` | 107 `.md` + `docs/embed.go` + theme/design assets |
| Release-notes files | 162 (67 version notes + 95 per-PR notes in `unreleased/`) |
| Go packages under `internal/` | 12 groups; `internal/session/control` alone has 217 non-test files |
| GitHub workflows | 29 |
| Benchmarks suites | 15 dirs under `benchmarks/` |

Prior-report coverage: **`/tmp/DeepSeek-Reasonix-report.md` is truncated.** The file ends mid-sentence at line 332 (`…and a documented `) inside §8.1, so §8.2 and any later sections (unique-vs-common completion, most-important-paths index, open questions) were never written. §§1–7 are good but at subsystem granularity: several whole feature families and the entire docs/prompt/asset layer are absent.

**On the "is this chiefly a model repo" question: no — and it contains no model-side tooling.** Verified absences: no tokenizer implementation/training, no tokenizer model files, no `vllm`/serving stack, no `safetensors`/weights, no Python inference client, no eval harness that calls a model for capability scoring. The only "tokenizer" strings in the tree are a BM25 catalog rebuild helper (`internal/state/historycatalog/rebuild_tokenizer_test.go`) and a benchmark task fixture (`benchmarks/verification-stress/tasks/vs-pos-invidx/.../tokenizer.py`). Client-side token accounting is `internal/base/tokencount`. Everything else is an **agent harness** (Go kernel + 4 frontends) plus **agent-behaviour evals** (`benchmarks/`) — see §1.2/§3.2.

### 0.3 oh-my-pi — `/data/home/forge/repo-tour/oh-my-pi`

| Measure | Value |
|---|---|
| Files total | 10,321 |
| `.ts` / `.tsx` | 6,613 / 135 |
| `.rs` | 1,130 |
| `.md` | 682 |
| `.kdl` | 245 (all under `packages/catalog/src/compat/rules/`) |
| `.json` | 329 |
| `.py` | 190 |
| `.txt` | 175 |
| `.proto` | 54 |
| `.sh` | 78 |
| `docs/` top-level `.md` | 81 (+ 34 in `docs/tools/`, 12 in `docs/toolconv/`, 13 files in `docs/skills/`) |
| Prompt assets under `packages/coding-agent/src/prompts/` | 107 `system/` + 88 `tools/` + 17 `internal-urls/` + 9 `memories/` + 8 `agents/` + 6 `goals/` + 6 `bench/` + 6 `advisor/` + 4 `spotlight/` + 4 `session/` + more |
| Other prompt corpora | `packages/snapcompact/research/prompts` (27), `packages/agent/src/compaction/prompts` (15), `packages/ai/src/dialect` (12), `packages/ai/src/judgment` (4), `packages/coding-agent/src/commit/{conventional,agentic}/prompts` (10), `packages/coding-agent/src/autoresearch` (4), `packages/typescript-edit-benchmark/src/prompts` (3), `crates/pi-edit/prompts` (5), `python/robomp/src/prompts` (19) |

Prior-report coverage: **`/tmp/oh-my-pi-report.md` (413 lines, 36 KB) is complete and accurate at the subsystem level**, but it names almost none of the prompt/docs/config assets, and it misses the KDL provider-compat rule corpus, the migration/compat machinery, and several packages' internals.

---

## 1. Missed features (file-cited)

### 1.1 grok-build

All of the following exist in the tree and are named nowhere in `/tmp/grok-build-report.md` or `/tmp/grok-report.md`.

**1. Release-note / changelog corpus (332 files) — the largest single miss.**
`crates/codegen/xai-grok-shell/changelogs/` holds one `.md` + one `.json` per shipped version, `0.2.0` → `1.0.45` (166 versions). The markdown is user-facing, dated, and grouped `## Features` / `## Bug Fixes` with bolded feature names, e.g. `0.2.108.md`:

```markdown
# 0.2.108 — 2026-07-21
## Features
- **Sessions** can now be resumed after moving the working directory or switching machines.
- **Ctrl+G** in minimal mode opens the current prompt draft in an external editor without sending it; fullscreen keeps the tasks pane.
- **grok doctor** checks terminal, tmux, clipboard, and keyboard setup without opening the TUI.
```

Evidence: `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/changelogs/0.2.108.md#L1-L8`, `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/changelogs/0.2.108.json`, `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/changelogs/1.0.45.md`. The in-product renderer is exercised by the `release_notes_scroll` PTY scenario (see item 5). This corpus is the best available feature ledger for the product and was completely absent from both reports.

**2. Prompt template assets, and an XOR-obfuscation build step.**
Plaintext templates live in three trees:
- `crates/codegen/xai-grok-agent/templates/{prompt.md, apply_patch_prompt.md, subagent_prompt.md}` — base, codex-apply-patch, and subagent system prompts;
- `crates/codegen/xai-grok-shell/src/session/templates/` — 14 goal/verifier/strategist prompts (`goal_planner_prompt.md`, `goal_verifier_prompt.md`, `goal_verifier_kind_lens_{analysis,code_change,research}.md`, `goal_strategist_prompt.md`, `goal_summarizer_prompt.md`, `goal_rules.md` + `_legacy`, `goal_task_discipline.md`, `goal_continuation_directive.md` + `_legacy`, `goal_plan_block.md`, `goal_verifier_resume_prompt.md`);
- `crates/codegen/xai-grok-workspace/templates/auto_mode_classifier_system_prompt.md` — the auto-approval-mode classifier prompt.

`crates/codegen/xai-grok-agent/scripts/encrypt_templates.py` compiles the first tree into `src/prompt/prompt_encrypted.rs` as byte arrays (`SEEDS` at line 10, `TEMPLATES` at line 15, `xor_encrypt` at line 27, and a `PROMPT_SEEDS: [u8; 3]` constant emitted at line 50). The generated file is 14 lines of `pub(crate) const {BASE,CODEX,SUBAGENT}_PROMPT_ENC: &[u8]` — i.e. prompts are obfuscated at rest in the binary so they cannot be `strings(1)`-scraped. Evidence: `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-agent/scripts/encrypt_templates.py#L10-L24` and `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-agent/src/prompt/prompt_encrypted.rs#L6-L12`.

**3. The PTY end-to-end scenario corpus (45 YAML scenarios).**
`crates/codegen/xai-grok-pager-pty-harness/tests/scenarios/*.yaml` is a declarative feature-inventory: `vim_modal_command_palette.yaml`, `dashboard_overlay_agents_esc.yaml`, `dashboard_model_list_click.yaml`, `mermaid-affordances.yaml`, `image_chip_preview_path_free.yaml`, `image_chip_kill_yank.yaml`, `paste_chip_repaste.yaml`, `paste_chip_double_click.yaml`, `goal_slash_presession.yaml` (+ `_disabled`), `folder_trust_prompt.yaml`, `plan_nudge_shows.yaml` + `plan_nudge_opt_out_no_show.yaml`, `undo_tip_*` (5 variants), `shortcuts_help_detail.yaml`, `auto_compact_resize.yaml`, `mid_text_skill_token_echo.yaml`, `mid_text_btw_sends_side_question.yaml`, `inline_image_memory.yaml`, `small_screen_tip_*` (4), `copy_selection.yaml`, `table_cell_selection.yaml`, `tool_header_path_selection.yaml`, `release_notes_scroll.yaml`, `input_modalities.yaml`, `path_space_hyperlink.yaml`, `html_entities*.yaml`, `minimal_*` (4), `slash_resize_storm.yaml`. Plus recorded baselines in `benches/pty_baselines/`. Both reports mention the harness crate; neither names the scenario corpus, which enumerates behaviours (undo-tip lifecycle, small-screen tip suppression, vim modal palette, image dirtiness bookkeeping) that appear nowhere else.

**4. Seatbelt profiles are three composed `.sbpl` files.**
`crates/codegen/xai-grok-sandbox/src/command/backend/sbpl/{platform_defaults,base,preferences}.sbpl` (205 / 133 / 25 lines) — the macOS sandbox profile is layered platform-defaults → base → user preferences rather than one blob. Evidence: `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-sandbox/src/command/backend/sbpl/base.sbpl`, `.../platform_defaults.sbpl`, `.../preferences.sbpl`.

**5. A concrete 584-line production Rhai workflow.**
`crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai` — not just an engine: a shipped workflow with a `meta` block (name, description, `when_to_use`, and four declared phases `Plan` → `Research` → `Verify` → `Report`), bounded parallelism (`breadth` 2–6), and `pause("verification", …)` as its error path. Exposed as `/deep-research`. Evidence: `file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai#L1-L23`.

**6. Two distinct compaction prompt sets (transcript vs code).**
`crates/common/xai-grok-compaction/src/templates/{compaction_developer_prompt.txt, compaction_user_prompt.txt, intra_compaction_system.txt, intra_compaction_user.txt}` plus a separate `src/code_compaction/templates/full_replace_summary_prompt.txt`. The report described the compaction engine's policies but never its prompt assets, and never noted the code-compaction variant.

**7. Example hooks tree (runnable).**
`crates/codegen/xai-grok-hooks/examples/README.md` + `examples/hooks/{safe-shell,no-recursive-grep,session-log,stop-verify,tool-logger}.json` + `examples/hooks/bin/{safe-shell-guard.sh,no-recursive-grep-guard.py,session-log.sh,stop-verify.sh,tool-logger.sh}` (some report examples). The README documents `PreToolUse` blocking hooks and per-project trust via `/hooks-trust`.

**8. Generated Kotlin and Swift protocol bindings (cross-language contract).**
`crates/common/xai-tool-protocol/generated/kotlin/{BotRelay.kt, BotRelayCommands.kt, BotRelaySchema.kt}` and `generated/swift/BotRelayProtocol.swift`, with fixtures in `crates/common/xai-tool-protocol/fixtures/bot_relay/` (55 `.json` + 1 `.md`). A "bot relay" frame protocol emitted as generated mobile-language types — evidence the tool protocol is consumed outside Rust. Neither report mentions Kotlin/Swift output or the bot-relay fixtures.

**9. npm distribution as a real package tree.**
`crates/codegen/xai-grok-pager/npm/grok/` — `bin/grok-bootstrap.js`, `bin/postinstall.js`, `scripts/assemble-platform-packages.js`, `scripts/test-postinstall.js`, plus six per-platform packages (`grok-{darwin,linux,win32}-{x64,arm64}`, each with its own `package.json` + README). The report only lists `npm/grok/bin` as "npm shim packaging".

**10. Install/diagnostic shell entry points.**
`crates/codegen/xai-grok-pager/scripts/install.sh`, `.../scripts/install-enterprise.sh`, `crates/codegen/xai-grok-announcements/generate.sh`.

**11. Tool metadata JSON schema + tool registry test corpus.**
`crates/codegen/xai-grok-tools/schema/tool_meta.schema.json` (2,280 bytes) is the machine-readable contract for tool metadata; `implementations/tool_feature_names_tests.rs` pins feature gating.

**12. Two crates absent from the report's tables.**
`crates/codegen/xai-grok-shared` (no description; depends on `agent-client-protocol`, `image`, `prod-mc-cli-chat-proxy-types`) and `crates/codegen/xai-grok-test-support` — the latter is a full testing harness: “mock inference server, SSE generators, ACP stdio client, headless runner, env sandbox” (`file:///data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-test-support/Cargo.toml#L5`) with a TLS mock (`axum-server` + `rcgen`/`ring`).

**13. Renderer fuzz targets and sandbox-violation fixtures (accuracy assets).**
- `crates/codegen/xai-grok-markdown/fuzz/` with seeds `render_all/{mixed,code_block,unicode,lists,inline,table,thematic_emoji}.txt`.
- `crates/codegen/xai-grok-sandbox/tests/fixtures/violations/` — `macos/*.txt` (~18 transcribed real violation transcripts: `seatbelt-deny-report.txt`, `bash-noproxy-ip.txt`, `touch-git-hooks.txt`, `chmod-setuid-copy.txt`, …), `transcribed/*.txt` (npm/node/python EPERM), and `negative/*.txt` (8 look-alikes that must *not* classify as violations: `docker-socket-eacces.txt`, `kubectl-rbac.txt`, `deno-permission-denied.txt`, `git-push-publickey.txt`, `ssh-password.txt`, `npm-403-url.txt`, `chromium-no-sandbox.txt`, `cargo-test-sandbox-word.txt`). This is a labelled precision/recall corpus for violation detection, and it is unmentioned in both reports.

**14. Documentation surfaces beyond `user-guide/`.**
- `crates/codegen/xai-grok-pager/docs/tutorial/` — a 9-chapter onboarding path (`01-coming-from-another-tool.md` … `09-where-next.md`) distinct from the 28-file `user-guide/`.
- `crates/codegen/xai-grok-pager/docs/` also has two top-level markdown files plus `xai-grok-agent/README.md`, `xai-grok-workspace/templates/`, `xai-ratatui-inline/README.md`, `xai-grok-test-support/README.md`.

**15. Presentation assets and syntax grammars.**
`xai-grok-pager-render/assets/{grok-day.tmTheme, grok-night.tmTheme, tokyo-night.tmTheme}`, `xai-grok-markdown/assets/{tokyo-night.tmTheme, Swift.sublime-syntax}` (a vendored Sublime grammar used for syntax highlighting), `xai-grok-mermaid/assets/{Roboto-Regular.ttf, Roboto-LICENSE.txt}` (the rasterizer bundles its own font), `xai-grok-pager/assets/logo/{logo05.txt, logo07.txt}` (ASCII logos).

### 1.2 DeepSeek-Reasonix

Answering the framing question first: **this repo contains no model-side tooling** — no tokenizer, no serving stack, no weights, no capability evals that call a model for scoring. It *does* contain, and the report under-catalogues: an agent harness with 4 frontends, a very large docs/prompt asset layer, a benchmark/evals tree of 15 purpose-built suites, and release-engineering tooling. Items below are all absent from `/tmp/DeepSeek-Reasonix-report.md` (which is also truncated — see §0.2).

#### 1.2.1 Docs layer (107 `.md` + an embedded corpus + a published site)

The docs are not decoration: `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/docs/embed.go#L1-L14` embeds them per build (`//go:embed *.md`, images excluded) so the agent can retrieve *focused sections* as its `productdocs` tool instead of dumping the corpus into the prompt. Doc families the report never names:

- **Isolation/write-integrity security series (10 files)**: `ISOLATION_{FIRST_FINISH,OPERATION_LEASE,PREPARATION,RESULT_REINSPECTION,RUNNER_PANIC,RUNTIME_OPTIONS,SETTLEMENT_FENCE}_SECURITY.md`, `ISOLATED_{INSPECTION,RECORD}_SECURITY.md`, `ISOLATION_NATIVE_CI.md`, plus the mutation family `MUTATION_COORDINATOR_SECURITY.md`, `MUTATION_RECORD_{MEMBERS,VALIDATION}_SECURITY.md`, `CONCURRENT_MUTATIONS_REVIEW_SERIES.md`, `OPAQUE_WRITE_ADMISSION_SECURITY.md`, `OPTIMISTIC_WRITE_ADMISSION_SECURITY.md`, `PROVISIONAL_WRITE_LEASE_SECURITY.md`, `CHECKPOINT_{CANCELLATION,WRITER_ADMISSION}_SECURITY.md`, `JOB_{PANIC_RESULT,RESOURCE_FINALIZATION}_SECURITY.md`, `HOOK_{CHECKPOINT,WORKSPACE_INVALIDATION}_SECURITY.md`, `DELEGATION_PANIC_OUTCOME_SECURITY.md`, `CHILD_FILE_VIEW_SECURITY.md`, `ROLE_FILE_VIEW_SECURITY.md`, `FILE_VIEW_PROVENANCE_SECURITY.md`, `WORKTREE_{ENTRY_IDENTITY,LITERAL_PATH,SNAPSHOT}_SECURITY.md`.
  **Note a code/doc drift:** these docs describe an `internal/runtime/isolation` package and its refusal codes (`isolation.unavailable`, `isolation.unknown_id`, `isolation.not_git`, `isolation.apply_conflict`, `isolation.unsupported_arg`), but that package does **not** exist in this checkout (verified by direct listing and by `git ls-files`). Its refusal codes are still consumed by the Studio UI test `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/desktop/frontend-next/src/i18n/isolation_refusals.test.ts#L9-L20`, and a related concept survives in the bench harness (`cmd/e2ebench/answer_isolation.go`). Treat the isolation docs as *design of record* for a subsystem missing from this snapshot, not as documentation of shipped code.
- **Root-budget series (9 files)**: `ROOT_TOKEN_BUDGET_SECURITY.md`, `ROOT_WALL_BUDGET_SECURITY.md`, `ROOT_TRIAGE_TOKEN_BUDGET.md`, `ROOT_AUXILIARY_TOKEN_BUDGET.md`, `ROOT_WEBSEARCH_TOKEN_BUDGET.md`, `BOUNDED_ROOT_TOKEN_BUDGET.md`, `REPORTED_TOTAL_TOKEN_BUDGET.md`, `BUDGET_USAGE_COMPLETENESS.md`, `GOAL_USAGE_SCOPE.md`, `GOAL_PLANNER_BUDGET_RESUME.md`, `CONTROLLER_ROUTING_ROOT_BUDGET.md`, `COORDINATOR_ROOT_BUDGET.md`, `EXPLICIT_SKILL_ROOT_BUDGET.md` — the budget model (per *root* run, inherited by children, sized per subsystem) is a first-class design axis the report reduces to “token/wall budgets”.
- **Theming as a product**: `THEME_PACK.md`, `theme-pack.schema.json`, `THEME_AUTHOR_GUIDE.md`, `THEME_ASSETS.md` and a worked example shipped as a plugin: `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/docs/themes/reasonix-plugin.json#L1-L8` contributes `themes: ["paper-dawn/theme.json"]`, and `docs/themes/paper-dawn/theme.json` defines light/dark token palettes. `docs/design/theme-palettes/` holds 12 paired phone/wide mockups.
- **Marketplace/plugin packaging**: `MARKET_AUTHOR_GUIDE.md`, `PLUGIN_PACKAGES.md`, `EXTENSION_RUNTIME_V2.md` + `EXTENSION_RUNTIME_V2_PERF.md`, `EXTENSION_PROTOCOL.generated.md` (drift-checked), `EXTENSIONS.md`.
- **Model/persona layer**: `PERSONA.md`, `REASONING_LANGUAGE.md`, `REASONING_PROVIDERS.md`, `MODEL_DISPLAY_ALIASES.md`, `MODEL_CONNECTION_HEALTH.md`, `LOCAL_COST_QUOTE.md`, `ESTIMATED_USAGE_QUOTE_SECURITY.md`, `ANTHROPIC_INTERRUPTED_USAGE.md`.
- **Studio/desktop**: `STUDIO_PARITY.md`, `STUDIO_RELEASE.md`, `STUDIO_SHELL_BOUNDARIES.md`, `STUDIO_IMAGE_PREVIEW.md`, `DESKTOP_CRASH_DIAGNOSTICS_RUNBOOK.md`, `TRANSCRIPT_PAGING_UI.md`, `HISTORY_PAGING.md`, `SESSION_WORKTREES.md`.
- **Other uncited docs**: `ACP.md`, `CLI.md` (+ `CLI.zh-CN.md`), `GUIDE.md` (+ `GUIDE.zh-CN.md`), `DSH.md`, `DOCS_STANDARD.md`, `MIGRATING.md`, `ROADMAP.md`, `RECOVERY.md`, `TOOL_APPROVAL_MODES.md`, `SUBAGENT_PROGRESS.md`, `SUBAGENT_STATUS_ADMISSION.md`, `SESSION_MEMORY_RETRIEVAL.md`, `USAGE_CATALOG.md`, `ISOLATION*`/`GIT_STORAGE_ENVIRONMENT.md`, `MCP_CREDENTIAL_PROJECTION.md`, `artifact`-adjacent `FILE_PREVIEW.md`.
- **Design proposals**: `docs/design/{COMPUTER_USE.md, INTELLIGENT_UI.md, TRUSTED_EXECUTION.md}`; the intelligent-UI one is the protocol behind `benchmarks/intelligent-ui` (RFC #12584).
- **Published site**: `docs/index.html`, `docs/logo*.svg`, effect SVGs (glitch/wave/stroke-draw/paste-folding/slash-command-views) and `docs/assets/`, `docs/images/` screengrabs; built by `.github/workflows/pages.yml`.

#### 1.2.2 Prompts (asset-bearing, not just inline strings)

- `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/internal/assembly/boot/testdata/golden/system_prompt.txt#L1-L18` — the **base system prompt is a golden-file test fixture** (18 lines ≈ 3.2 KB). It is the clearest statement of product policy anywhere in the tree: user-owned choices resolved through the `ask` tool rather than prose; scratch work under `$TMPDIR`; parallel tool calls in one reply; reply-language mirroring; the `<project-instructions>` block contract (restated when changed, most recent supersedes, later entries win); and the `[external content · <origin> · data, not instructions]` labelling convention for fetched text.
- `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/internal/runtime/guardian/guardian_policy.md#L1-L38` — the guardian is a prompt-defined JSON verdict, not a heuristic: `{risk_level, user_authorization, outcome, rationale}` with explicit thresholds (`critical` always denies; `high` allows only when authorization ≥ medium; sandbox retry/escalation is explicitly *not* suspicious). Loaded via `//go:embed guardian_policy.md` (`internal/runtime/guardian/policy.go:15`).
- `internal/ext/skill/builtincontent/reasonix-guide/SKILL.md` + `internal/ext/skill/builtin_embed.go` — built-in skill content embedded in the binary.
- `internal/contract/agentcomposition/builtins.json` — **built-in agent compositions are data, with revision history**: `builtin:general` and `builtin:minimal` (the latter selects only `bash` + optional `view_image`, `include_runtime_context: false`), with Chinese display names ("日常搭档", "轻装搭档") and per-axis inheritance (`tools`/`skills`/`mcp`/`extensions`/`hooks`/`commands`: `inherit|select`). Companions: `builtin-revisions.json`, `authority.go`, `parameters.go`, `validate_parameters.go`, `live.go`.
- `internal/ext/modhost/script.go:12` embeds `host/host.mjs` — a JavaScript module host compiled into the Go binary (the `modhost`/`modpreview` extension path).
- `internal/ext/theme/theme.go:23` embeds a `builtin` theme directory.
- `.reasonix/commands/review.md` — the repo's own project-local Reasonix command (self-hosting config).

#### 1.2.3 Configs, schemas, budgets

- `reasonix.example.toml` (16 KB) is the annotated config surface and names sections the report never lists: `[ui]`, `[cli]`, `[desktop]`, `[billing]`, `[notifications]`, `[agent]`, `[[providers]]`, `[environment]`, `[tools]`, `[tools.background_jobs]`, `[serve]` (grep of section headers; `[cli]` is marked “user/global only; ./reasonix.toml cannot override”). Also `.env.example`.
- `file:///data/home/forge/repo-tour/DeepSeek-Reasonix/internal/tools/builtin/schema_budget.json#L1-L3` = `{"totalTokens": 7185}` — the tool-schema token cost is a **committed budget**, matched by the contract test that compares the documented tool surface to the canonical schema path.
- `internal/platform/computer/cua-driver.lock.json` — a pinned lock for the computer-use driver.
- `internal/platform/computer/contract.go` embeds it (`//go:embed cua-driver.lock.json`).

#### 1.2.4 CLI / frontends

- `internal/frontend/cli` is 235 files; `internal/frontend/serve` 638; `internal/frontend/tui` 116. The report treats all three as one-liners.
- **Desktop surface beyond the SPA**: `desktop/cmd/{sign, studio-manifest, update-helper}`, `desktop/internal/winuninstall/{plan.go,registry_windows.go,registry_other.go}`, `desktop/electron/{electron-builder.yml, arch.json, run-studio.ps1}`, `desktop/electron/test/` (~40 live/manual harnesses: `cua-native.mjs`, `cua-service-fixture.js`, `computer_live.js`, `livekit.js`, `ime_live.js`, `freeze_live.js`, `focus_live.js`, `sleep_live.js`, `browser_fit_pages.js`, `elementpick_live.js`, `document_preview_live.js`, `globalshortcut{,.test}.mjs`, `linux-package-smoke.js`, `theme_live.js` …).
- **SPA subtrees the report doesn't mention**: `desktop/frontend-next/{_fx, perf, relay, tools, public, scripts}`, and tests that pin product properties — `pwa.test.ts` (PWA), `wording.test.ts`, `orphan.test.ts`, `errsink.test.ts`, `e2e/`.
- `output/agent-workbench/`, `output/agent-workbench-v5/`, `output/agent-workbench-v6/` — three checked-in design prototypes of the Studio UI (`reasonix-studio.html`, `index.html`, `workspace.js/.css`, `motion.js`, `verify.cjs`). A design-exploration artifact class the report ignores entirely.
- **Android app internals** (`android/app/src/main/java/io/reasonix/mobile/app/`): `Kernel.kt`, `KernelService.kt` (kernel as an Android service), `BrowserShellServer.kt` (serves the SPA locally), `NativeBridge.kt`, `Downloader.kt` (kernel download), `Qr.kt` + `ScanActivity.kt` (pairing), `Dns.kt`; plus `android/gradle/verification-metadata.xml` (dependency verification) and `network_security_config.xml`.
- **npm wrapper**: `npm/reasonix/{bin/reasonix.js, package.json}`, `npm/{build.mjs, publish.mjs, publish.test.mjs}`.
- **Workers** carry more than telemetry: `workers/accounts/{migrations/0001_initial.sql, 0002_device_grants.sql, src/email/{index,resend,types}.ts, src/routes/*}` (device grants!), `workers/forum/{schema.sql, seed.sql, src/antispam.ts + .test.ts, src/identity.ts}`.

#### 1.2.5 Tools, memory, sandbox — file-level deltas

- **Builtin tool files the report never names**: `bash_delete_{interpreter,parser}.go`, `encoding_helpers.go`, `gitignore.go`, `managed_config.go`, `network_scope.go` (refuses a file-tool path that *names another machine*, on spelling, before any lookup — a Windows UNC leak guard), `pipe_status.go`, `timeout.go`, `workspace.go`, `bgjobs.go`, `peers_dispatch.go`, `session_guard.go`.
- **Memory is a 39-file subsystem**, not “REASONIX.md + saved facts”: `activation.go` (pinned = body rides the stable prefix vs relevant = retrieval-only), `auto_recall.go`, `freshness.go`, `galaxy.go` (importance tiers + a compact rendering limit), `quickadd.go`, `queue.go`, `recall_weights.go`, `remember_policy.go`, `forget.go`, `subject.go`, `usage.go`, `fact_stamp.go`, `store.go`/`store_v2.go` + `store_v2_recovery.go` + `store_v2_restore_staging.go`, `store_lock.go`, `store_snapshot_identity.go`, `store_index.go` + `store_index_rebuild.go` + `store_index_faults.go`, `migration_backup.go`, `render.go`, `index.go`, `remember.go`.
- **Sandbox is a 49-file implementation**, not three backends: `escape.go` (a one-shot, reason-carrying request to rerun a shell command *unsandboxed* after the platform sandbox failed to start — the mechanism the guardian prompt calls “sandbox retry or escalation”), `egress_bridge.go`/`egress_bridge_entry.go`, `git_metadata*.go` (projected git metadata incl. link handling per OS), `session_temp_env.go`, `shell_launch{er}.go` + `shell_proof.go`, `protects*.go`, `prepare_linux.go`, `authority*.go`, `write_roots{,_windows}.go`, and a deep Windows side: `win_grants{,_windows}.go`, `win_launch{,_windows}.go`, `win_prepare{,_windows}.go`, `win_sidowner{,_windows}.go`, `win_cache_dirs.go`, `win_faults.go`.
- **`internal/base/tokencount`** is the only token-estimation code in the repo and deliberately carries *no* tokenizer: “The split is by script because the two behave nothing alike — Latin text and code trend near four bytes per token, CJK closer to one token per character … A real tokenizer would be exact and would mean a vocabulary per model, re-run over whole transcripts every turn.” (`file:///data/home/forge/repo-tour/DeepSeek-Reasonix/internal/base/tokencount/tokencount.go#L1-L13`).

#### 1.2.6 Control-layer subsystems the report compresses into “commands + events”

`internal/session/control` has **217 non-test files**. Named now, with the file that carries each:
- **Session inbox + steering**: `inbox.go`, `inbox_dispatch.go` (bounded retry, `maxInboxDispatchRetryAttempts = 3`), `inbox_pause.go`, `inbox_cancel.go`, `inbox_steer.go`, `inbox_refs.go`, `inbox_run.go`, `inbox_sink.go`.
- **Peer mail/threads** (agent-to-agent over MCP): `peer_mail.go`, `peer_mail_send.go`, `peer_mail_slash.go`, `peer_mail_tool.go`, `peer_reply.go`, `peer_threads.go` (state read off the audit trail “never off any message's words”), `peer_open_projects.go`, `peer_settings.go`, `peer_dispatch.go`.
- **Native surfaces / intelligent UI**: `surface_actions.go`, `surface_action_replay.go`, `surface_answer.go`, `surface_history.go`, `surface_publications.go` (+ `internal/contract/surfacespec`).
- **Turn machinery**: `turn_submit.go`, `turn_gate.go`, `turn_entry.go`, `turn_cancel.go`, `turn_images.go`, `turn_in_flight.go`, `turn_projection.go`, `turn_readers.go`, `turn_orchestrator.go`, `turn_narration_settings.go`.
- **Prompt-freshness primitives**: `projection_debt.go` ("what the model has of one block that is delivered once" — owed is computed from model-visible history, never from what a turn was handed), `date_anchor.go` (date re-owed only across midnight), `scratch_anchor.go` (tells the model the single spelling of `$TMPDIR` that bash and the file tools both resolve).
- **Write/lease authority**: `session_write_authority.go` (generation-bound write authority issued from a lease and attached to the session), `workspace_lease.go`, `session_lease_keeper.go`, `admission_guard.go`, `user_gate.go`, `run_ceiling.go`, `write_lease_settings.go`.
- **Workspace scope**: `workspace_roots.go`, `workspace_preparation.go`, `workspace_preview.go`, `workspace_branch.go`, `workspace_repo.go`, `workspace_activity.go`, `external_folders.go`.
- **Model behaviour switches**: `effort_in_place.go`, `model_face.go`, `model_modes.go`, `provider_health.go`, `paid_search_approval.go`.
- **References**: `refs.go`, `refs_block.go`, `refs_range.go`, `refs_session.go`, `refimages.go`.
- **Misc**: `side_session.go` (read-only "question beside the session"), `rewind.go` + `rewind_versions.go` + `rewind_available.go`, `mcp_*` (7 files incl. `mcp_trust.go`, `mcp_signin.go`, `mcp_health.go`), `goal_*` (12 files incl. `goal_durable.go`, `goal_projection.go`, `goal_state_compat.go`), `docs_command.go`, `context_command.go`, `feedback_board_command.go`, `slash_workmode.go`, `auto_archive.go`, `discard.go`, `dropped.go`, `boundary.go`, `mods.go`, `network.go`, `egress_remember.go`, `idle.go`, `await_resume.go`, `headless_posture.go`, `permission_vocabulary.go`.

#### 1.2.7 Benchmarks/evals (15 suites; report lists names only)

The report's table matches the directory names but not their content. Each suite is a *research question with a harness*:
- `benchmarks/README.md#L1-L3` opens “Six harnesses live under `benchmarks/`” — the tree has 15 suites (stale doc, but also evidence the corpus grew without the README).
- **`e2e/`** — 82 tasks (`task.toml` + `verify.sh` + `workdir/` seed) driven by `cmd/e2ebench`, which also has SWE-bench Verified mode; `answer_isolation.go` refuses to run answer-bearing tasks on a host with no OS read sandbox (`sandbox.ConfinesByDefault()`).
- **`compaction/`** — CompactionBench: grows a session one generation at a time and folds after each, pricing repeated compaction and what it loses.
- **`context-maintenance-e2e/`** — seed → resume → continue smoke: seeds below the trigger, resumes without paying for a summary, folds exactly once past it.
- **`realrepo/`** — long tasks over a pinned snapshot of *this* repo (a real task took a flash-class model 38 requests), used to price round-trip reductions; `-suite/-task/-trials/-trajectories/-json` flags.
- **`upstream-edge/`** (2 tasks) and **`fanout-width/`** (1 task) — shape-instructed fleets pricing `depends_on` edges and simultaneous fan-out.
- **`memorybench/`** (15 tasks) — keeps seeded facts in the suite checkout; answer isolation exists because a graded child could otherwise grep the host or read Git objects.
- **`project-check/`** (8 tasks) — a semantic corpus for project-check adjudication; a companion probe test proves the legacy derivation can be bypassed.
- **`train/`** (12 tasks) — a *generated training corpus* kept out of `e2e/` on purpose, with grader-contract tests (`TestSolvableCorpusSeedsMustNotGradeClean`: `verify.sh` must fail on the pristine seed).
- **`verification-stress/`** (20 tasks) — `vs-{neg,pos}-*` defect/reachability families with `workdir/`+`solution/` pairs.
- **`catalog-detector/`** — measures three candidate detectors for “is the skills listing owed again?”, defining “owed” as what the rendered block would differ in.
- **`tool-surface-cache/`** — prices whether the provider-visible tool set may change between turns (holds the schema still vs appends/removes at the end).
- **`context-retrieval/`** — 18 tasks and modes `preflight|snippet|adversarial|run-search|run-boundary|run-index|calibrate`; Experiments R and I; `-dry` drives any mode with a scripted provider.
- **`intelligent-ui/`** — a paired-run *desktop surface* evaluation protocol (RFC #12584) that explicitly states it has no measured results yet.
- **The metric contract**: `benchmarks/README.md` requires Metric/Anchor/Population/Excludes before a number counts as a finding, and documents three historic mechanism errors that a missing contract allowed.

#### 1.2.8 Release engineering, CI, scripts, root tooling

- **29 workflows** under `.github/workflows/` including `acp-conformance.yml`, `android.yml`, `codeql.yml`, `deploy-{accounts,crash,forum,ops-events}-worker.yml`/`deploy-web-studio.yml`, `e2e-bot.yml`, `feedback-sync.yml`, `pages.yml`, `pr-author-gate.yml`, `release-studio.yml`, `spam-comment-guard.yml`, `stale-report-sweep.yml`, `studio-certum-signing-smoke.yml`, `studio-selftest-windows.yml`, `v1-maintenance-schedule.yml`, `withdraw-studio-version.yml`.
- **`scripts/` is 86 files and is a release system**: `resolve-{cli,npm,preview,stable,desktop}-release*.sh`, `validate-*release-manifest.sh`, `publish-{cli,desktop}-pointer.sh` + tests, `render-brew-cask.{sh,test.mjs}`/`brew-cask-guard.mjs`, `finalize-npm-official-release.mjs`, `windows-signing-lib.ps1`/`verify-windows-authenticode.ps1`/`install-nsis.ps1`/`sign-certum.ps1`, `verify-linux-{appimage,package}.sh`, `withdraw-version.{sh,test.mjs}`, `cache-guard.sh` (the CI cache-guard the SPEC describes as `REASONIX_RELEASE_CACHE_GUARD=1`), `credential-leak-check.mjs`, `markdown-refs.mjs`, `stale-report-sweep.mjs`, `update-{acknowledgments,contributors,star-history}.mjs` (+ tests each), `feedback-sync.mjs`, `dsh-market-index.mjs`, `release-credits.mjs`, `scripts/official-theme-art/` (theme artwork generation), `scripts/testdata/`.
- **Root-level artifacts not in the report**: `design-qa.md` (23 KB design QA log), `prod_fast_test` (fast local test entry), `.env.example`, `.gitattributes`, `.golangci-version` + `.golangci.yml`, `.goreleaser.yaml`, `.githooks/pre-push`, `.signpath/contracts/release-signing.yml` (Windows signing policy as data).
- **Release notes as a practice**: `release-notes/studio/` holds 67 version notes plus **95 per-PR notes in `release-notes/studio/unreleased/`** named by issue number (`14947-history-search-incomplete-index.md`, `14966-inbox-schema-three.md`, `13655-renderer-safe-skill-warnings.md`, …). Version notes are Chinese narrative prose with code-level detail (e.g. `2.9.0.md` explains `gitstatus.Diff` measuring against HEAD, `safeRel` rejecting three path shapes, `tokens.css` ordering in the boot sequence). This is both the best feature ledger in the repo and the reason `repolint` can enforce a `release-note` rule.

### 1.3 oh-my-pi

Items below are absent from `/tmp/oh-my-pi-report.md`. The report is accurate about what it covers (packages, the 30-tool registry, ACP/LSP/DAP, the Rust crate list) but it never enters the prompt/rule/config corpus, the model-catalog rule engine, or roughly fifteen `src/` subsystems.

#### 1.3.1 Prompt corpora (279 files in `prompts/` alone; ≈350 across the tree, all unmentioned)

`packages/coding-agent/src/prompts/` alone holds 279 files in 14 subdirectories (107 `.md` in `system/` plus a `personalities/` dir, 88 in `tools/`): `internal-urls/` 17, `memories/` 9, `agents/` 8, `judge/` 7, `goals/` 6, `bench/` 6, `advisor/` 6, `session/` 4, `spotlight/` 4, `skills/` 3, `security/` 3, `steering/` 2. Further prompt corpora live elsewhere:
- `packages/snapcompact/research/prompts/` (27) — experiment-named (`exp02-qa-image.md` … `exp21-qa-braille.md`, `exp08-archive.md`, `exp09-frame.md`) research prompts for bitmap-frame compression.
- `packages/agent/src/compaction/prompts/` (15) and `packages/coding-agent/src/commit/{conventional,agentic}/prompts/` (10) — commit-message generation has two modes.
- `crates/pi-edit/prompts/{apply_patch,hashline,patch,replace,sloppy}.md` — the edit engine ships five edit dialects, including a **hashline** mode (as grok-build does) and a `sloppy` mode.
- `packages/ai/src/dialect/*.md` (12: anthropic, deepseek, gemini, gemma, glm, harmony, hermes, kimi, minimax, qwen3, xml, prompt-template) — one spec per model family for thinking/tool-call conventions.
- `packages/ai/src/judgment/*.md` and `packages/coding-agent/src/prompts/judge/*.json` — the judge role's decision contracts (`auto-graph.json`, `auto-prewalk.json`, `auto-thinking.json`, `find.json`, `git-stage.json`, `title-drift.json`, `unexpected-stop.json`).
- `python/robomp/src/prompts/` (21) — the GitHub bot's kickoff/triage/review/release/follow-up prompts plus `host_tools.toml`, `todo_phases.toml`.
- `packages/coding-agent/src/discovery/builtin-rules/` (26) — always-on language rules injected by the rulebook pipeline: `ts-no-any.md`, `ts-import-type.md`, `ts-no-tiny-functions.md`, `rs-box-leak.md`, `rs-match-ergonomics.md`, `go-rand-v2.md`, `go-ioutil.md`, … (+ `index.ts`). Documented in `docs/rulebook-matching-pipeline.md`.

The `system/` names are themselves a feature list the report lacks: `autolearn-*` (4), `prewalk-*` (3), `snapcompact-*` (7), `plan-mode-*` (7), `ttsr-{interrupt,tool-reminder,warning}.md`, `magic-keyword`-adjacent notices (`chillax-notice.md`, `jevify-notice.md`, `omfg-user.md`), `ultrathink-notice.md`, `seance-{assignment,command,command-solution-space}.md`, `vibe-mode-active.md`, `workpool`/`job-{caption,widget}-{system,user}.md`, `title-{system,card,fork,marker-instruction}.md`, `memory-{extraction,consolidation}-system.md`, `mnemopi-instructions.md`, `snapcompact-*`, `streaming-edit-recovery.md`, `stream-stall-continue.md`, `thinking-loop-redirect.md`, `tool-call-loop-redirect.md`, `session-stop-blocked.md`, `personalities/`.

#### 1.3.2 Prompt/token engineering tooling (a capability with no counterpart in the other two repos)

- `scripts/rewrite-system-prompt.ts` + `scripts/rewrite-system-prompt.style.md` — an **LLM pipeline that rewrites prompt prose into a terse “implementation-scratchpad voice”** while keeping every structural token byte-exact. It processes files line by line, preserves blank lines/headings/XML tags/Handlebars directives/frontmatter/fences verbatim, batches prose lines as id-keyed JSON to a model (Sonnet 4.5 via OpenRouter by default), **validates that every fragile token survived**, and falls back to the original line when a rewrite drops one. Flags: `--all` (every prompt + rule), `-i/-o`, `--dry-run`.
- `scripts/tool-prompt-usage.ts` — per-template token accounting for the 88 tool prompts with `--json` and `--encoding cl100k_base`.
- `.omp/skills/tool-prompt-optimization/` (with `scripts/probe.ts`, `scripts/probe-builtin.ts`), `.omp/skills/semantic-compression/SKILL.md`, `.omp/skills/system-prompts/{SKILL.md,small-models.md}` — the repo's own skills for compressing prompts and tuning small-model system prompts.
- `scripts/{edit-benchmark.py, rate-edit-tool.py, analyze_small_edits.py, tool_io.py, bash_corpus_stats.jl, eval-bench-runs.ts}` and `scripts/session-stats/` — prompt/edit evaluation tooling outside the `packages/*` test suites.

#### 1.3.3 Model catalog: a KDL rule engine plus judgment, dialects and a tokenizer

The report describes `packages/catalog` as “bundled model DB, provider discovery descriptors, identity/classification/equivalence”. Under that:
- **245 `.kdl` rule files** in `packages/catalog/src/compat/rules/` — `providers/` (99: `openai.kdl`, `anthropic.kdl`, `deepseek.kdl`, `xai.kdl`, `gemini.kdl`, `qwen.kdl`, `kimi.kdl`, `glm.kdl`, `minimax.kdl`, `stepfun.kdl`, …), `auth/` (103), `taxonomy/` (23), `classes/` (19), `runtime/` (1). Example: `providers/openai.kdl` declares `default-model`, `env`, `image-count-budget`, `on-api "openai-responses" { supports-websockets #true }`, `kind-apis` for embedding/image/stt, tariff notes (long-context cost tier), and `seed` blocks for approval-gated models — a provider-wire contract expressed as data and “regenerated from the frozen census”.
- 36 `.ts` companions: `axes.ts`, `apply.ts`, `providers.ts`, `taxonomy.ts`, `revision.ts`, `catalog-policy.ts`, `catalog-endpoint.ts`, `request-compression.ts`, `fallback-credit.ts`, `judgment-questions.ts`, `seeds-tmp.ts` (+ `rules.json`).
- **`docs/provider-compat-reference.md`** is a four-subsystem reference (compat flags, reasoning levels, per-provider tool handling, forced tool choice) and spells out the resolution cascade: *per-API defaults → endpoint detection → the KDL cascade → sparse `spec.compat` overrides*, with a pre-built `compat.whenThinking` object that is **pointer-swapped** at request time instead of merged. Sibling docs: `provider-endpoint-constraints.md`, `provider-streaming-internals.md`, `provider-quirks.md`, `docs/toolconv/` (12 dialect docs incl. `pi-native.md`, `harmony.md`, `xml.md`).
- `packages/catalog/src/model-tokenizer.ts` — the only tokenizer in any of the three repos (model-side token counting for the catalog).
- `packages/ai/src/dialect/*.ts`, `packages/ai/src/judgment/*` (chat/native/text judges, `openai-decisions.ts`, `systemone.ts`) — per-family rendering and judging.

#### 1.3.4 `packages/coding-agent/src/` subsystems the report never names

1543 TypeScript files live under `src/`; the report covers ~15 directories. Notable additions, each with its entry file:
- **`ovnfs/`** (`daemon.ts`, `client.ts`, `search.ts`) — a daemon-served virtual filesystem (`ovnfs --json start|status`, per-command daemons with an admin socket and a mount) used for subagent checkouts.
- **`thread/`** (`protocol.ts`, `services.ts`, `executor-routing.ts`, `identity.ts`, `peer-agent-session.ts`, `remote-agent-session.ts`, `rpc.ts`) — subagents as host workers over RPC where registry/lifecycle/IRC/jobs/auth cross as remote objects.
- **`tiny/`** (`mlx-runtime.ts`, `mlx-server.py`, `local-inference-api.ts`, `device.ts`, `dtype.ts`, `models.ts`) — **local inference**: a side-installed pinned `mlx-lm` venv (via `uv`) that runs tiny models locally, plus an ONNX/`@huggingface/transformers` worker path. Documented in `docs/local-models.md`.
- **`launch/`** (`broker.ts`, `ensure.ts`, `presence.ts`, `spawn-options.ts`, `protocol.ts`) — a daemon broker owning singleton daemons (shared Chromium, browser relay, LSP mux).
- **`skillshare/`** (`installer.ts`, `pack.ts`, `tar.ts`, `manifest.ts`, `client.ts`) — a skill registry: resolve versions, verify/unpack tarballs, maintain `skills.json`/`skills.lock.json`; one implementation shared by `omp skill` and the TUI `/skills`.
- **`if-bench/`** (`index.ts`, `runner.ts`, `actions.ts`, `protocol.ts`, `prompts/`) — `omp if-bench`, an instruction-following + working-memory benchmark: N glyph actions over the model's own last-turn array while a `nya{1,N}` directive rotates through prompt start/middle/end, scoring the depth before the array or the cat sound is lost.
- **`ratchet/ratchet.ts`** — the host-side keep/revert gate for the `/ratchet` **eval hillclimb**: approval freshness by content hash, frozen split, completeness and held-out-leakage checks, round decision; state under `.omp/ratchet/<flow>/{_state.json,baseline/,v<N>/results.jsonl}`.
- **`autoresearch/`** — an extension with a dashboard and its own git branch per research run (`ensureAutoresearchBranch`), `command-resume.md` template.
- **`hindsight/`** (`backend.ts`, `bank.ts`, `mental-models.ts`, `seeds.json`, `transcript.ts`) — a memory backend with banks and mental models; `docs/mnemosyne-memory-backend.md`, `docs/memory.md`.
- **`cleanse/`** (`agent.ts`, `checkers.ts`, `loop.ts`, `parsers.ts`, `balance.ts`, `prompts/`) — an agent that consumes diagnostics and fixes them, with TUI picker/board surfaces.
- **`capability/`** (`index.ts`, `fs.ts`, `mcp.ts`, `hook.ts`, `instruction.ts`, `context-file.ts`, `extension{,-module}.ts`) — the capability registry (define capability → register providers → load across providers) that backs native-surface discovery.
- **`live/`** (`protocol.ts`, `controller.ts`, `transport.ts`, `attestation.ts`, `voices.ts`) — realtime “Frameless Bidi” sessions (`LIVE_MODEL = "gpt-live-1-codex"`, 500-byte context chunks, `speakable|commentary` channels).
- **`speculation/host.ts`** — speculative execution host (launch/operation/commit/discard contexts, `SpeculativeAuthorization`).
- **`sharpshooter/`** (`extract.ts`, `consolidate.ts`, `queue.ts`, `scheduler.ts`, `backend.ts`) — extract/consolidate pipeline with its own queue and scheduler.
- **`markit/`** (`converters/`, `registry.ts`, `NOTICE`) — document conversion registry.
- **`exa/`** (`mcp-client.ts`) — Exa search as an MCP client; `auto-graph/planner.ts` — judge-picked charts for multi-series tables (`tui.autoGraph: smart`).
- **`stencil/credential.ts`**, **`blob-broker/uploader-runtime.ts`**, **`secrets/`** (`obfuscator.ts`, `replacement.ts`, `placeholder.ts`, `patterns.ts`, `regex.ts`), **`vibe/`** (`runtime.ts` + `tools/vibe.ts` and 7 `vibe-*` prompts), **`slash-commands/seance.ts`** (+ `seance-*` prompts and 5 test files), **`workpool`** prompts, **`archive/`**, **`activity/`**, **`downloads/`**, **`export/`**, **`goals/`**, **`plan-mode/`**, **`judgment/`**, **`spotlight/`**, **`predict/`**, **`tts/`**, **`stt/`**, **`thread/services/`**, **`utils/tools-manager.ts`**, **`cli/gallery-fixtures/`**.

#### 1.3.5 Docs (81 top-level + `tools/` 34 + `toolconv/` 12 + `skills/` 13 files)

The report counts `docs/` as “77 files”. Actual: 81 top-level markdown (one per subsystem) plus `docs/tools/` (34 tool docs: `ask.md` … `wait.md`), `docs/toolconv/` (12 dialect docs), `docs/skills/` (`authoring-extensions.md`, `authoring-hooks.md`, `authoring-marketplaces.md`, `examples/`). Named-but-uncited highlights: `ERRATA-GPT5-HARMONY.md` (an errata doc for a vendor wire format), `magic-keywords.md`, `vibe-mode.md`, `prewalk.md`, `rulebook-matching-pipeline.md`, `ttsr-injection-lifecycle.md`, `handoff-generation-pipeline.md`, `session-tree-plan.md`, `collab.md`, `agent-hub.md`, `mnemosyne-memory-backend.md`, `local-models.md`, `python-repl.md`, `notebook-tool-runtime.md`, `resolve-tool-runtime.md`, `bash-tool-runtime.md`, `fs-scan-cache-architecture.md`, `blob-artifact-architecture.md`, `macos-signing-notarization.md`, `install-id.md`, `secrets.md`, `natives-*` (9: architecture, binding-contract, addon-loader-runtime, media-system-utils, shell-pty-process, text-search-pipeline, rust-task-cancellation, build-release-debugging), `tui-{core-renderer,runtime-internals}.md`, `session-operations-export-share-fork-resume.md`, `session-switching-and-recent-listing.md`, `provider-*` (4).

#### 1.3.6 Self-hosting config `.omp/` (15 files)

`.omp/commands/{fix-issues,review-prs,cleanup,triage,release}.md`, `.omp/skills/{tool-prompt-optimization,semantic-compression,system-prompts}/`, `.omp/tools/tui.ts` (+ `bun.lock`, `package.json`), `.omp/tests/tui.test.ts`. The report notes that `.omp/` exists but names none of it; the skills are the repo's own prompt-engineering kit (see §1.3.2).

#### 1.3.7 Rust side beyond the crate list

- `crates/pi-shell/` is a test-and-tooling system, not just a bash engine: `src/testkit/{conformance.rs, golden.rs, fault.rs, host.rs, memfs.rs, rng.rs, suites/}`, `src/minimizer/`, `src/suites/`, `tests/{obash_support, pty_support, comp_support}/`, `benches/workloads/`, and **53 scenario quads** under `src/testkit/fixtures/skeleton/` (212 files: `.sh`/`.out`/`.status`/`.err` per scenario), plus a failure **minimizer** corpus in `tests/fixtures/minimizer/{jvm,git,glab,npm,go,cargo}`.
- `crates/pi-edit/prompts/` (5 dialects, above), `packages/snapcompact/research/prompts/` (27), `crates/pi-builtins/src/rsync/sender/testdata/`.
- Vendored crates remain 4 (`vendor/`: cfg_aliases, grep-searcher, napi, tree-sitter-go) — the report is right, but `crates/` also carries `pi-predict`, `pi-voice`, `pi-vcs`, `pi-vfs`, `pi-iso`, `pi-ast`, `pi-builtins`, `pi-diff`, `pi-edit`, `pi-natives`, `pi-shell`, `pi-walker` (12) — the report lists 12, so this is only the fixture/testkit delta.

#### 1.3.8 Packaging, CI, infra (uncited)

- **Bazel**: `BUILD.bazel`, `MODULE.bazel`, `.bazelrc`, `.bazelversion`, `.bazelignore`, `bazel/{defs.bzl, clippy.bazelrc, patches/, platforms/, toolchains/, triples/, variants/}` — Bazel builds only the native addons (`//:natives-<target>`), per the report, but the `patches/`, `toolchains/`, `triples/`, `variants/` trees are new information; `scripts/gen-bazel-lock.ts`, `gen-clippy-bazelrc.ts`, `gen-grammars.ts`, `bazel-natives.ts`, `run-rs-task.ts` drive it.
- **Nix**: `nix/{package.nix, home-manager.nix, nixos-module.nix, bun.nix, bun-runtime.nix, dev-shell.nix, native.nix}`, `flake.nix`, `flake.lock`, `scripts/gen-nix-bun.ts` (+ test). The report mentions the `nix/` directory only as “flake packaging”.
- **Containers**: `Dockerfile` (9.6 KB), `Dockerfile.robomp` + `.dockerignore` files, `python/robomp/docker-compose.yml` and `entrypoint.sh`.
- **Installers**: `scripts/install.sh`, `scripts/install.ps1`, `scripts/install-tests/`, `scripts/link-omp.sh`, `scripts/macos-entitlements.plist`, `scripts/ci-macos-sign.sh`.
- **`infra/`**: `infra/docs/{01-vmon-runners,02-omp-ci-template,03-caching}.md` + `infra/vmon/` + `infra/omp_ci_template.py` (report mentions the docs; `vmon/` itself is not described).
- **Release/CI scripts** the report doesn't mention: `scripts/{release.ts, merge-pr.ts, rewrite-changelog.ts, fix-changelogs.ts, check-spoofed-versions.ts, cleanup-scan.ts, claude-trace.ts, host-detect.ts, stamp-native-version.ts, setup-npm-trust.ts, ci-build-upload.ts, ci-release-build-binaries.ts, ci-release-checksums.ts, ci-release-publish.ts, ci-update-brew-formula.ts, fix-dt-verdef.ts, fix-emit-extensions.ts, inline-functions.ts, setup.ts}` — most with co-located `*.test.ts`.
- **Repo-level policy files**: `AGENTS.md` (28 KB — the repo's own agent instructions), `deny.toml` (cargo-deny), `about.toml` (license audit), `.fallowrc.jsonc`, `bunfig.toml`, `tsconfig.base.json`/`tsconfig.workspace.json`/`tsconfig.tools.json`, `patches/` (patched `@ark/schema`, `puppeteer-core`), `types/assets/`.

#### 1.3.9 Benchmarks and evaluation beyond `metaharness`

- `packages/typescript-edit-benchmark/` (report: one line) ships its own `src/prompts/`, and `scripts/edit-benchmark.py` + `rate-edit-tool.py` + `analyze_small_edits.py` grade edit tooling externally.
- `omp if-bench` (§1.3.4) and `/ratchet` (§1.3.4) are in-product evaluation loops.
- `scripts/eval-bench-runs.ts`, `scripts/session-stats/`, `scripts/tool-prompt-usage.ts` complete the measurement kit. `packages/metaharness` holds the Harbor run storage + REST/SSE dashboard per the report.

#### 1.3.10 SDKs, robomp, python

`sdk/{go,python,rust}/omp-rpc` (report covers these) plus `python/robomp/` as a full application: `src/{dashboard.py, db.py, github_backend.py, github_client.py, github_events.py, git_ops.py, host_tools.py, issue_index.py, manual_triage.py, natives_cache.py, persona.py, pragmas.py, proxy.py, proxy_client.py, proxy_hmac.py, autoclose.py, cancellation.py, config.py, cli.py}`, `src/prompts/` (21 files), `web/` (Bun workspace dashboard), `docker-compose.yml`, `tests/`, `THIRD-PARTY-NOTICES.txt`, `AGENTS.md`.

---

## 2. Common patterns (across the three repos)

Each pattern below is present in at least two repos and was not called out as a shared pattern in any prior report.

1. **Prompts are versioned assets with a build/QA step, not string literals.**
   - grok-build: `templates/*.md` + `scripts/encrypt_templates.py` → `prompt_encrypted.rs` (XOR + `PROMPT_SEEDS`); two compaction prompt sets.
   - Reasonix: golden-file base prompt (`internal/assembly/boot/testdata/golden/system_prompt.txt`), `guardian_policy.md`, `builtincontent/reasonix-guide/SKILL.md`, agent compositions in `builtins.json` with a revisions file.
   - oh-my-pi: 279 files under `prompts/` + 15 compaction prompts + `crates/pi-edit/prompts` + `scripts/tool-prompt-usage.ts` for token accounting.
   Shared consequence: a prompt change is reviewable, testable and (in two repos) measurable in tokens.

2. **Cache-prefix stability is an engineered, measured property.**
   - Reasonix: byte-stable prefix + projected turn tail, `projection_debt.go`, `date_anchor.go`, `tool-surface-cache` bench, CI cache guard.
   - oh-my-pi: `buildSystemPrompt` returns stable and dynamic blocks separately; per-request `promptCacheKey`; KDL `compat.whenThinking` is pointer-swapped rather than merged so the request-time policy does not allocate a divergent object.
   - grok-build: cached system prompt on `Agent`; per-turn `prompt_build.rs`.

3. **OS sandbox with layered composition, an escape hatch, and a labelled regression corpus.**
   - grok-build: `nono` (Landlock/Seatbelt) + three-layer `sbpl` + per-child seccomp network policy + `tests/fixtures/violations/{macos,transcribed,negative}`.
   - Reasonix: Seatbelt / bwrap / Windows write-restricted token, `escape.go` for a one-shot unsandboxed rerun, `protects*.go` + `write_roots*.go`, and a guardian prompt that explicitly tolerates “sandbox retry or escalation”.
   - oh-my-pi: `pi-iso` overlay/hardlink isolation + `security/` + `security_scan` tool + `prompts/tools/isolation-{error,recovery-hint,summary}.md`.

4. **Trust-gated, project-scoped extension points (hooks/commands/skills/MCP).**
   - grok-build: hooks + `/hooks-trust`, `examples/hooks/README.md` documents blocking `PreToolUse` hooks.
   - Reasonix: hooks gated on a digest of the declaration, `HOOK_CHECKPOINT_SECURITY.md`, `MCP_CREDENTIAL_PROJECTION.md`, `docs/skills`, `pluginspec`/`pluginpkg`.
   - oh-my-pi: hooks + capabilities + `docs/skills/authoring-hooks.md`; MCP prompts become slash commands.

5. **Subagents as a boundary-policed subsystem, not a recursive call.**
   - Reasonix: 5-concept delegation split, `profile_boundary_test.go`, `spawn_boundary_test.go`, write claims + completion adjudication.
   - oh-my-pi: `task`/`thread` worker RPC with remote services, IRC/registry routing, `task-specialization-advisory.md`.
   - grok-build: `task` + `send_subagent_message` + `wait_tasks`/`kill_task` + `xai-grok-subagent-resolution` + `xai-grok-bundle` (personas/roles/agents/skills).

6. **Worktree/checkout isolation as the unit of parallel or risky work.**
   grok-build `xai-fast-worktree` (CoW clone) + `worktree` tool; Reasonix `SESSION_WORKTREES.md` + workspace leases/write claims + the (docs-only) isolation subsystem; oh-my-pi `pi-iso` + `session/session-worktree.ts` + `ovnfs` daemon FS for subagent checkouts.

7. **Budgets are committed constants with tests.**
   - Reasonix: `schema_budget.json` (`totalTokens: 7185`), the root-budget doc family, budget completeness doc.
   - grok-build: `DEFAULT_TOOL_OUTPUT_BYTES`/`CHARS` caps, output capping modules (`grep/capped_output.rs`), `xai-token-estimation`.
   - oh-my-pi: `tool-prompt-usage.ts` per-template token counts; `tool-surface-cache` experiment.

8. **Memory has separate write/read tools plus a consolidation pass.**
   - grok-build: `memory_search`/`memory_get` + `xai-grok-memory` dream/batch-dream consolidation.
   - Reasonix: `remember`/`forget` + `memory` tool (`search`/`list`/`read`), auto-recall weights, activation pinned-vs-relevant, store v2 recovery.
   - oh-my-pi: `retain`/`recall`/`reflect`/`learn`/`memory_edit` + `mnemopi` local SQLite backend + `hindsight` banks/mental models.

9. **A second model (or the same model in a different role) adjudicates.**
   grok-build `goal_verifier_*` prompts (three kind lenses) and `xai-codebase-graph`; Reasonix `guardian` (JSON verdict prompt), `goaleval`, `coordinator` planner; oh-my-pi `judge` role with per-decision JSON contracts (`auto-graph`, `auto-prewalk`, `auto-thinking`, `git-stage`, `title-drift`, `unexpected-stop`).

10. **Release notes are a maintained, per-version artifact — and in two cases machine-readable.**
    grok-build `.md` + `.json` per version (166 versions); Reasonix 67 version notes + 95 per-PR notes enforced by `repolint`; oh-my-pi `scripts/{rewrite-changelog,fix-changelogs,ci-release-notes}.ts`.

11. **Docs that ship with the binary and are retrievable at run time.**
    Reasonix `docs/embed.go` → `productdocs`; oh-my-pi internal URL schemes (`docs://` among 19 schemes); grok-build user-guide/tutorial under the pager crate (docs are shipped in-tree next to the UI they describe).

12. **Permission escalation windows after an approved plan, with an explicit “yolo” posture.**
    Reasonix `approvedPlanAutoApproveTools` window, postures `ask|auto|yolo`, `TOOL_APPROVAL_MODES.md`; oh-my-pi `always-ask|always-ask-cached|write|yolo` + `plan-yolo-handoff.md`; grok-build `--permission-mode` with per-tool allow/deny rules and `auto_mode_classifier_system_prompt.md`.

13. **Windows is treated as a distinct platform with its own mechanism.**
    Reasonix `win_grants`/`win_launch`/`win_sidowner`/`write_roots_windows.go` (write-restricted token; bash unsandboxed); grok-build `dunce::canonicalize` policy ban and ConPTY mouse-capture re-assertion; oh-my-pi `install.ps1`, `macos-entitlements.plist` (opposite platform focus).

14. **The repo is its own first user of the agent.**
    grok-build `AGENTS.md` + `clippy.toml` policy; Reasonix `REASONIX.md` (28 KB) + `.reasonix/commands/review.md`; oh-my-pi `.omp/{commands,skills,tools,tests}` + 28 KB `AGENTS.md`.

---

## 3. Unique capabilities not yet cataloged, with evidence

### 3.1 grok-build

| Capability | Evidence |
|---|---|
| Prompts obfuscated at rest in the shipped binary | `crates/codegen/xai-grok-agent/scripts/encrypt_templates.py` (`SEEDS`/`TEMPLATES`/`xor_encrypt`), generated `src/prompt/prompt_encrypted.rs` |
| Declarative PTY scenario DSL + recorded baselines (45 scenarios) | `crates/codegen/xai-grok-pager-pty-harness/tests/scenarios/*.yaml`, `benches/pty_baselines/` |
| Three-layer macOS Seatbelt profile composition | `xai-grok-sandbox/src/command/backend/sbpl/{platform_defaults,base,preferences}.sbpl` |
| Labelled sandbox-violation corpus with negatives | `xai-grok-sandbox/tests/fixtures/violations/**` |
| In-product versioned release notes, `.md` + `.json` | `xai-grok-shell/changelogs/` (332 files, 0.2.0→1.0.45) |
| Two compaction systems with separate prompts (transcript, code) | `crates/common/xai-grok-compaction/src/templates/`, `.../src/code_compaction/templates/` |
| A production workflow script (`/deep-research`) with phases and verification pauses | `xai-grok-shell/src/session/workflows/deep_research.rhai` |
| Test harness crate: TLS mock inference server, SSE generators, ACP stdio client, headless runner | `xai-grok-test-support/Cargo.toml:5` |
| Bot-relay protocol generated into Kotlin and Swift | `crates/common/xai-tool-protocol/generated/{kotlin,swift}/*` |
| Runnable hook example kit | `xai-grok-hooks/examples/README.md` + `examples/hooks/**` |
| Renderer fuzzing + vendored syntax grammar | `xai-grok-markdown/fuzz/`, `assets/Swift.sublime-syntax` |

### 3.2 DeepSeek-Reasonix

| Capability | Evidence |
|---|---|
| Prompt “freshness debt”: a block is re-delivered only when the model-visible history differs | `internal/session/control/projection_debt.go`; consumers `date_anchor.go`, `scratch_anchor.go`, `rules_projection.go` |
| Session inbox with pause/cancel/steer of queued turns | `internal/session/control/inbox*.go` (8 files), `internal/state/sessioninbox/` |
| Peer sessions: mail, threads, cross-project open, state read off the audit trail | `internal/session/control/peer_*.go`, `internal/state/peermail/` |
| Native “surface” answers (structured UI) with replay, history and publications | `internal/session/control/surface_*.go`, `internal/contract/surfacespec`, `docs/design/INTELLIGENT_UI.md`, `benchmarks/intelligent-ui/` |
| Generation-bound session write authority issued from a workspace lease | `internal/session/control/session_write_authority.go`, `workspace_lease.go`, `session_lease_keeper.go` |
| Guardian as a prompt-defined JSON verdict with thresholds | `internal/runtime/guardian/guardian_policy.md` |
| Agent compositions as revisioned data with per-axis inheritance (data + Chinese display names) | `internal/contract/agentcomposition/{builtins.json,builtin-revisions.json,validate_parameters.go}` |
| Themes distributed as plugin packs with a JSON-schema contract | `docs/themes/reasonix-plugin.json`, `docs/themes/paper-dawn/theme.json`, `docs/theme-pack.schema.json` |
| Docs embedded per build and retrieved in focused sections | `docs/embed.go`, `internal/tools/productdocs` |
| Script-aware token estimation deliberately without a tokenizer | `internal/base/tokencount/tokencount.go` |
| Committed tool-schema token budget | `internal/tools/builtin/schema_budget.json` |
| Un-sandboxed one-shot rerun path after sandbox start failure | `internal/safety/sandbox/escape.go` |
| Benchmark suite per *research question*, each with a README stating its contract | `benchmarks/{catalog-detector,tool-surface-cache,context-retrieval,project-check,train,realrepo,...}/README.md`, `benchmarks/README.md` (metric contract) |
| Bench answers guarded by requiring an OS read sandbox | `cmd/e2ebench/answer_isolation.go` |
| Per-PR release notes in the repo, enforced by a bespoke linter | `release-notes/studio/unreleased/` (95 files), `tools/repolint` rules |
| Isolated-task design of record (worktree-backed run → inspect → apply), absent from the synced code | `docs/ISOLATION_*_SECURITY.md`, `docs/ISOLATED_*_SECURITY.md`, `desktop/frontend-next/src/i18n/isolation_refusals.test.ts` |

### 3.3 oh-my-pi

| Capability | Evidence |
|---|---|
| LLM prompt-rewriting pipeline with structural-token survival validation and fallback | `scripts/rewrite-system-prompt.ts` + `scripts/rewrite-system-prompt.style.md` |
| Per-template prompt token accounting | `scripts/tool-prompt-usage.ts` (`--encoding cl100k_base`) |
| Provider-wire compatibility expressed as a KDL rule cascade over a frozen census | `packages/catalog/src/compat/rules/**` (245 `.kdl`), `compat/{apply,axes,catalog-policy,catalog-endpoint,judgment-questions}.ts`, `docs/provider-compat-reference.md` |
| Request-time policy pointer-swap instead of merge (`whenThinking`) | `docs/provider-compat-reference.md` §1 (quoted mechanism) |
| Per-model-family dialect specs (12) + per-provider tool conversion docs | `packages/ai/src/dialect/*.{ts,md}`, `docs/toolconv/*.md` |
| Local tiny-model inference via a side-installed pinned `mlx-lm` venv (and an ONNX worker path) | `packages/coding-agent/src/tiny/{mlx-runtime.ts,mlx-server.py,local-inference-api.ts}`, `docs/local-models.md` |
| In-product instruction-following + working-memory benchmark (`omp if-bench`) | `packages/coding-agent/src/if-bench/**` |
| Eval hillclimb with keep/revert gate, hash-freshness approvals and held-out leakage checks (`/ratchet`) | `packages/coding-agent/src/ratchet/ratchet.ts` |
| Daemon-served virtual filesystem for subagent checkouts (`ovnfs`) | `packages/coding-agent/src/ovnfs/{daemon.ts,client.ts,search.ts}` |
| Subagents as host workers over an RPC service protocol | `packages/coding-agent/src/thread/{protocol.ts,services.ts,rpc.ts,executor-routing.ts}` |
| Daemon broker owning singleton daemons (shared Chromium, browser relay, LSP mux) | `packages/coding-agent/src/launch/{broker.ts,ensure.ts,presence.ts}` |
| Skill registry with tarball packs and a lockfile | `packages/coding-agent/src/skillshare/{installer.ts,pack.ts,tar.ts,manifest.ts}` |
| Capability registry (define capability → providers → load) | `packages/coding-agent/src/capability/**` |
| Realtime “Frameless Bidi” sessions (`gpt-live-1-codex`) | `packages/coding-agent/src/live/{protocol.ts,controller.ts,transport.ts,attestation.ts}` |
| Speculative execution host with authorization/commit/discard contexts | `packages/coding-agent/src/speculation/host.ts` |
| Secret obfuscation with placeholders and pattern/regex compilation | `packages/coding-agent/src/secrets/**` |
| Always-on language rulebook injected from markdown | `packages/coding-agent/src/discovery/builtin-rules/` (26 files), `docs/rulebook-matching-pipeline.md` |
| Shell-engine testkit: conformance/golden/fault harness, memfs, RNG, 53 scenario quads, failure minimizer | `crates/pi-shell/src/testkit/**`, `src/minimizer/`, `tests/fixtures/minimizer/**` |
| Five edit dialects incl. `hashline` and `sloppy` | `crates/pi-edit/prompts/*.md` |
| Diagnostics-fixing agent with its own TUI surfaces (`cleanse`) | `packages/coding-agent/src/cleanse/**` |
| Judge role with per-decision JSON contracts | `packages/coding-agent/src/prompts/judge/*.json`, `packages/ai/src/judgment/**` |
| Judge-picked charts for multi-series tables | `packages/coding-agent/src/auto-graph/planner.ts` |

---

## 4. Docs-worthy items

“Docs-worthy” = an artifact here is undocumented, or documents itself in a way another team would want to copy.

**4.1 Worth documenting (gaps found).**
- grok-build: the prompt-encryption build step has no maintainer-facing doc — only the script docstring; a `docs/` note on “edit `templates/*.md`, then regenerate” would prevent hand-edits of `prompt_encrypted.rs`. The changelog corpus (`changelogs/`) is also undocumented as a maintenance obligation, and the PTY scenario DSL has no authoring guide.
- Reasonix: three self-inflicted drifts are worth fixing/noting — `docs/SPEC.md` §2 describes a package layout that no longer exists (already flagged in the prior report), `benchmarks/README.md` says “Six harnesses” while 15 suites exist, and the 10 `ISOLATION_*`/`ISOLATED_*` docs describe `internal/runtime/isolation`, which is absent in this snapshot, while the Studio frontend still ships its refusal strings.
- oh-my-pi: the 279-file prompt corpus has no index; `docs/tools/` covers 34 tools while `BUILTIN_TOOL_NAMES` lists 30 + 3 hidden; the KDL rule cascade has a *reference* (`provider-compat-reference.md`) but no “how to add a rule / regenerate the census” authoring doc; `scripts/rewrite-system-prompt.style.md` is a genuinely reusable style contract that is buried in `scripts/`.

**4.2 Worth copying into other agents.**
- grok-build: the **sandbox-violation fixture taxonomy** (macos / transcribed / negative) is the cheapest way to keep violation detection from regressing into false positives.
- grok-build: **`grok doctor`-style terminal diagnostics with fixes** plus documented `install.sh`/`install-enterprise.sh` paths.
- Reasonix: **golden-file system prompt** + the metric contract requirement (Metric/Anchor/Population/Excludes) for any published number.
- Reasonix: **per-PR release notes in-tree** with a linter rule — it makes changelog generation a by-product of the PR, not a release-week chore.
- oh-my-pi: **prompt token accounting in CI** and the **LLM prompt-rewrite pipeline with token-survival validation**.
- oh-my-pi: **`docs/toolconv/`** — one conversion spec per vendor wire dialect is what makes “60+ providers” auditable.

**4.3 Cross-repo topics that deserve a written comparison.**
- Prompt-asset pipelines (plaintext → encrypted / rewritten / templated) and what each buys.
- Cache-prefix stability techniques: projection debt (Reasonix), stable/dynamic prompt blocks + pointer-swap compat (oh-my-pi), cached system prompt (grok-build).
- Sandbox models side by side: kernel primitives at startup vs per-command launcher vs overlay filesystem, and how each measures correctness (violation corpora, escape paths, answer isolation).
- Subagent composition: 5-concept delegation + boundary tests vs worker-RPC threads + IRC vs tool-based `task` + bundle.

---

## 5. Optimization ideas

### 5.1 Speed

1. **grok-build — split the 3,793-line composition root.** `crates/codegen/xai-grok-pager-bin/src/main.rs` holds `main`, `async_main`, `run_agent_command`, the stdio replay machinery and a ~1,000-line test module. The repo already states the principle elsewhere (“extracted … so they compile in parallel”), and `Cargo.toml` sets `codegen-units=128` for dev; moving the replay bridge and the command handlers into modules/`xai-grok-shell` would cut incremental rebuild time on the hottest file.
2. **Reasonix — split the two monster packages.** `internal/session/control` (217 non-test files) and `internal/frontend/serve` (638 files) are single Go compilation units; Go tests in a package cannot run in parallel with an unrelated package, and the ratchet’s 800-line file rule is already forcing files apart without forcing *packages* apart. Grouping by concern (inbox, peer, surface, goal, workspace) would reduce rebuild and test-selection cost and make ownership visible in CODEOWNERS.
3. **oh-my-pi — keep the prompt corpus build-time only.** Templates are already imported as text (`import x from "./x.md" with { type: "text" }`), so the remaining risk is runtime templating/parsing cost per turn; precompiling the Handlebars and memoizing per (template, static-params) key, then asserting the compiled cache is hit in tests, protects both latency and the token budget.
4. **Reasonix — put benchmark *dry* modes in CI.** `context-retrieval` and `tool-surface-cache` document `-dry`/scripted-provider runs “for nothing”; running them in `make check` would catch harness rot without keys, which today can only be found manually.

### 5.2 Capabilities

5. **Cross-pollinate the PTY scenario pattern.** grok-build’s 45-scenario YAML corpus is the only TUI regression suite of the three; Reasonix (`internal/frontend/tui`, 116 files) and oh-my-pi (`packages/tui`) both have rich TUIs and no equivalent.
6. **Adopt in-product eval loops where they are missing.** oh-my-pi has `/ratchet` (keep/revert gate with leakage checks) and `omp if-bench`; Reasonix has the harnesses but no in-CLI hillclimb gate; grok-build has benches but no keep/revert gate either.
7. **Ship the changelog JSON as a product surface.** grok-build already emits `changelogs/<v>.json`; a `grok --changelog <v> --json` (or release-note diff between installed and available version) is nearly free and makes the release-notes corpus user-visible.
8. **Expose the violation-classifier corpus as a fixture kit.** grok-build’s `negative/*.txt` set is exactly what a sibling project needs to test its own sandbox-violation parsing; publishing the corpus (or its schema) costs nothing and invites contributions — noting that the repo accepts no external PRs, so it would be an internal reuse play.
9. **Add a docs index for the prompt corpora** (oh-my-pi) and a maintainer doc for prompt regeneration (grok-build), so the two largest prompt trees are navigable.

### 5.3 Accuracy

10. **Golden-system-prompt tests everywhere.** Reasonix pins its base prompt in `internal/assembly/boot/testdata/golden/system_prompt.txt`; grok-build has template files but no golden rendering test, and oh-my-pi has per-decision JSON but no golden base prompt. A golden file per audience (base, subagent, codex port, auto-mode classifier) plus a structural-token check (as the rewrite script already does) would catch prompt drift the moment it lands.
11. **Wire prompt token budgets into CI.** Reasonix commits `schema_budget.json` (`totalTokens: 7185`) and a contract test; oh-my-pi has `tool-prompt-usage.ts` but (from the tree) no committed budget. Committing the measured total per prompt group and failing on growth makes prompt bloat visible like a dependency diff.
12. **Gate docs against the tree.** Reasonix’s `repolint` already enforces doc ownership and prose rules; adding “a referenced `internal/...` package must exist” would have caught the isolation docs vs missing package, and “benchmark dir count matches README” would have caught the “six harnesses” drift.
13. **Extend the sandbox-violation corpora with cross-platform negatives.** grok-build’s negatives are macOS/Unix-centric; Reasonix ships a deep Windows grant/sidowner path and oh-my-pi has a Windows installer — each platform’s false-positive set differs (e.g. Windows ACL denials look like EPERM-class errors), and misclassifying them mislabels the user-facing reason.
14. **Benchmark reports should state their contract cross-repo.** Reasonix formalised the four-line metric contract; oh-my-pi’s `metaharness` and grok-build’s `pager-pty-harness/benches/pty_baselines` record numbers without a stated population/exclusion — adopting the four lines would make cross-version comparisons mean the same thing.
15. **Guard the answer-isolation condition generically.** Reasonix refuses to run answer-bearing benchmark tasks without an OS read sandbox (`answer_isolation.go`, `sandbox.ConfinesByDefault()`); the same precondition (grader material outside the child’s read boundary) applies to grok-build’s `xai-grok-test-support` headless runner and to oh-my-pi’s `ratchet`/`if-bench` runners.

---

## Appendix — inventory of files examined (primary sources)

grok-build: full `find` statistics; `crates/**` directory and file inventories for `xai-grok-shell/changelogs`, `src/session/templates`, `xai-grok-agent/templates` + `scripts/encrypt_templates.py` + `src/prompt/prompt_encrypted.rs`, `xai-grok-sandbox/{src/command/backend/sbpl,tests/fixtures/violations}`, `xai-grok-pager-pty-harness/tests/scenarios`, `xai-grok-hooks/examples`, `xai-grok-pager/{docs,npm,scripts,assets}`, `xai-grok-pager-render/assets`, `xai-grok-markdown/{assets,fuzz}`, `xai-grok-mermaid/assets`, `xai-grok-tools/schema`, `xai-grok-test-support/Cargo.toml`, `xai-grok-shared/Cargo.toml`, `crates/common/xai-grok-compaction/src/**/templates`, `crates/common/xai-tool-protocol/{generated,fixtures}`, `xai-grok-workspace/templates`, `xai-grok-shell/src/session/workflows/deep_research.rhai`.

DeepSeek-Reasonix: full `find` statistics; `docs/**` (107 files, incl. the design/, themes/ and assets/ subtrees); `benchmarks/{README.md,*/README.md}` and per-suite task counts; `release-notes/studio/**` (67 versions + 95 unreleased); `scripts/` (86 files); `.github/workflows` (29); `cmd/**`; `internal/**` package inventory and file listings for `session/control` (217), `tools/builtin` (non-test), `state/memory` (39), `safety/sandbox` (49); `internal/{base/tokencount,assembly/boot/testdata/golden,runtime/guardian}`; `internal/ext/{modhost/skill/builtincontent,theme}`; `internal/tools/builtin/schema_budget.json`; `internal/platform/computer/contract.go`; `desktop/**` (incl. `frontend-next/src`, `electron/test`), `android/**`, `npm/**`, `workers/**`, `integrations/**`, `examples/**`, `output/**`, root files (`.reasonix/`, `Makefile`, `reasonix.example.toml`, `design-qa.md`, `.signpath/`, `.githooks/`).

oh-my-pi: full `find` statistics; `docs/**` (81 top-level + 34 tools + 12 toolconv + 13 skills); `packages/coding-agent/src` (91 entries; 1543 `.ts`) with per-directory reads of `prompts/**`, `ovnfs`, `thread`, `tiny`, `launch`, `skillshare`, `if-bench`, `ratchet`, `autoresearch`, `hindsight`, `cleanse`, `capability`, `live`, `speculation`, `sharpshooter`, `markit`, `exa`, `auto-graph`, `secrets`, `memory-backend`, `discovery/builtin-rules`; `packages/catalog/src/compat/**` (245 `.kdl` + 36 `.ts`); `packages/ai/src/{dialect,judgment}`; `packages/snapcompact/research/prompts`; `crates/{pi-shell/{src/testkit,src/minimizer,tests},pi-edit/prompts,pi-builtins}`; `scripts/` (incl. `rewrite-system-prompt.*`, `tool-prompt-usage.ts`); `.omp/**`; `nix/`, `bazel/`, `infra/`, `Dockerfile*`, `patches/`, root config files; `python/robomp/**`; `sdk/**`.

---

_End of delta audit. Read-only: no file under `/data/home/forge/repo-tour/` was modified; `/data/home/forge/HorizonCode` was not touched._

