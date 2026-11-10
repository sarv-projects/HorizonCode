# HorizonCode: hand-off to the next coding agent

> **Document class:** operational hand-off (not a design spec). **Written:** 2026-11-10, branch `docs/handoff` (cut from `feat/tui-part3`). **Audience:** the next coding agent (or engineer) who takes over this repository with no memory of earlier sessions.
>
> **How to use this file.** Read sections 1 to 3 before touching anything: they tell you where things are, how to build and test, and which rules you must not break. Section 4 is the pull request history. Section 5 is the full deferred backlog, one self-contained entry per item. Section 6 lists known gaps that are not features. Section 7 says where the research evidence lives. Section 8 is a checklist for your first hour.
>
> **What this file does NOT own.** The status ladder (DESIGNED, CODE_PRESENT, WIRED, TESTED, VERIFIED, RELEASED) lives only in [`28-implementation-status.md`](28-implementation-status.md). Nothing in this file raises or lowers a level; where a level is mentioned it is quoted from docs/28. Nothing in the repository is RELEASED.
>
> **Upstream links.** Every upstream URL below is a GitHub blob URL at the full 40 character commit that was read (pins in [`research/upstream-pins.md`](research/upstream-pins.md)). Each path was checked against `git ls-files` of the pinned clone. Where a repository was not cloned (aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix, opencode-v2) no path can be verified and the text says `path not verified`. "Adopt as is" means the upstream code could be copied (with attribution); "adapt" means re-implement the idea in HorizonCode's own style. As of this writing NOTHING was copied verbatim from any upstream except the small constants and fixture strings listed in section 6 item 1.

---

## 1. Repository map

Repository: `github.com/sarv-projects/HorizonCode`. A terminal coding agent: TypeScript on Bun in `app/` (zero runtime dependencies; only `devDependencies` for types), plus a Rust trust kernel in `kernel/` (std plus serde only). The kernel decides (`deny > lease > ask > allow`) and records (hash-chained event log and receipts); it does not execute effects and it does not confine processes.

### 1.1 Top-level entries

| Path | What it is |
|---|---|
| `README.md` | Product README: what runs today, how to build and use it, limits. Links this file in its Documentation section |
| `CURRENT_RUN.md` | State-of-repo snapshot (what is implemented, how verified, what remains, section 5.0 done/partial/not-started table). Links this file at the top |
| `AUDIT.md` | The 2026-11-06 re-audit of the specification set (historical; the final audit synthesis is `docs/29-final-audit.md`, raw reports are in `docs/audit/`) |
| `app/` | The TypeScript runtime, tools, TUI, providers, tests. See 1.2 |
| `kernel/` | The Rust trust kernel (`hz-kernel`). See 1.3 |
| `ops/` | Gate runner, gate catalogue, CI payload, installer for CI, the Landlock probe. See 1.4 |
| `bin/hzcode` | The launcher script (`./bin/hzcode`): `exec bun run app/src/main.ts "$@"` (the app locates the kernel binary itself) |
| `docs/` | The specification corpus, status, steal list, audit evidence, research. See 1.5 |
| `.github/workflows/ci.yml` | The installed CI workflow (copied from `ops/ci/github-actions.yml`). Edit only via a pull request, see section 3 |
| `.agents/`, `.hz/`, `.kiro/` | Agent tooling state. Not product code. `.hz/` is HorizonCode's own runtime state directory when you run the agent inside this repo (event logs, `hzcode.db`, spills). Never commit state |
| `.scratch/` | Scratch space used by earlier sessions (clones of toolchain caches, demo drivers, generator scripts). Safe to ignore; use it instead of `/tmp` (see section 2.4) |

### 1.2 `app/` (TypeScript runtime)

`app/package.json` has scripts `start`, `eval`, `grow`, `typecheck` (`bunx tsc --noEmit -p .`) and `check`; only `devDependencies` (`@types/bun`, `@types/node`, `typescript`). `app/tsconfig.json` has `strict:false` (ruling 39 kept it as is). `app/bun.lock` is tracked and must never be committed again (section 2.3).

Entry points:

| File | Role |
|---|---|
| `app/src/main.ts` | CLI entry. Dispatches subcommands before the chat arg parse (`commit`, `config`, `doctor`, `serve`; `hzcode run <name> [args]` runs a `.hz/commands` file as a print-mode turn), then parses flags such as `-p/--print`, `--output-format`, `--permission-mode`, `--mock`, `--workspace`, `--model`, `--max-steps`, `--max-tokens`, `--max-wall-ms`, `--continue/--resume`, `--version`, `--help`. Wires the TUI, headless, print and server surfaces to the runtime facade |
| `app/src/contracts.ts` | The frozen interface contracts, v0.1 (types for tools, providers, runtime events, credentials, kernel protocol). ADDITIVE ONLY (section 3) |
| `app/src/eval-run.ts` | Eval runner (docs/30 section 4 item 8) |
| `app/src/grow.ts` | Manual growth-loop runner (NF-075) |

`app/src/core/` (runtime; one-line role each):

| File or dir | Role |
|---|---|
| `index.ts` | Runtime facade: opens sessions, runs turns, `rewindTo`, `recordCheckpoint`, `runGuardedShell` |
| `loop.ts` | One turn of the conversation: provider stream, `guardActionFor`, `GuardGate`, `executeTool`/`runToolCall`, approvals, receipts, batches (NF-072), budgets (NF-073), pending-todos re-check, JSON repair call site |
| `kernel.ts` | The trust boundary client (`KernelClient`) and its in-process TypeScript stand-in (`LocalKernel`); decision-identical with the Rust kernel (pinned by `app/tests/core/interop.test.ts`) |
| `session.ts` | SQLite sessions (`synchronous=FULL`), messages, per-session event streams |
| `config.ts` | Settings resolved once at startup; `checkConfigFile` (`hzcode config check`) |
| `paths.ts` | Canonical state paths (`.hz/`) with in-place legacy `.hzcode/` |
| `canon.ts` | Canonical JSON and SHA-256 (twin of `kernel/src/canon.rs`) |
| `admission.ts` | Durable per-session admission FIFO (NF-071); only `recoverInterrupted` is wired |
| `owned-spawn.ts`, `supervisor.ts`, `worker-identity.ts` | Managed runtime: the single child-spawn path with a ledger (`spawns.jsonl`), owner-death supervisor, worker identity handshake |
| `file-lock.ts` | Cross-process advisory lock files (ruling 63) |
| `checkpoints.ts` | Per-turn checkpoints and the rewind plan (module header is stale, section 6) |
| `compaction.ts` | Constraint-preserving windowed compaction and the structured summary (T-7) |
| `output-budget.ts` | NF-074 context-cost contracts (output cap fitting, spill) |
| `hooks.ts` | Lifecycle hook engine (`hooks.json`), deny-only |
| `guards/` | `loop-detection.ts`, `mistake-tracker.ts`, `repeat-tool.ts` (NF-073 rails) |
| `guardian.ts` | Advisory deterministic action classifier (rulings 48, 60) |
| `speculation.ts` | Speculative-execution coordinator; deliberately UNWIRED (ruling 65) |
| `permission-mode.ts` | `default`, `plan`, `accept-edits`, `read-only` (no bypass mode exists) |
| `plan.ts` | Plan-mode staged changes and review diff |
| `subagent.ts`, `agent-profiles.ts` | Nested delegation (`runNested`) and the built-in presets `explore`, `plan`, `review` |
| `server.ts`, `stdin-worker.ts`, `stdin-live.ts` | `hzcode serve` single-attach server and the blocking-stdin worker |
| `skills.ts`, `commands.ts`, `instructions.ts` | Skills (flat and folder, built-in `execute-plan`), custom slash commands as files, AGENTS.md/CLAUDE.md hierarchy |
| `convo.ts`, `commit.ts`, `doctor.ts`, `json-repair.ts`, `turn-diff.ts`, `diagnostics-ledger.ts`, `metrics.ts` | Conversation verbs (T-12), `hzcode commit` (T-16), `hzcode doctor` (T-10), tolerant tool-argument decoding (T-1), per-turn diff, LSP diagnostics de-charging, metric contract |
| `review.ts`, `curator.ts`, `postmortem.ts`, `evals.ts`, `eval-executor.ts` | Growth loop v1 (review-fork spec, append-only curator), post-mortems, evals from post-mortems |
| `prompt/` | The base system prompt as data (`sections.ts`, `environment.ts`, `index.ts`); prompt golden is read by a test, see section 2.5 |
| `providers/` | `anthropic.ts`, `openai.ts`, `google.ts`, `ollama.ts`, `openai-compatible.ts`, `mock.ts`, `scripted.ts`, `sse.ts`, `retry.ts`, `index.ts` (factory; fails loud on an unknown provider) |
| `catalog/` | `catalog.ts` and `models-dev.curated.json` (five providers, about 2.8 KB) |
| `mcp/`, `lsp/` | MCP stdio client v1 and registry; LSP client, framing, mux, workspace diagnostics |

`app/src/tools/` (the model-facing tools; 18 registered in `index.ts`): `read`, `write`, `edit` (repair ladder, CRLF-safe, hashline mode), `grep`, `glob`, `shell` (`shell.ts`), `todo`, `undo`, `repo_map`, `agent`, `code_mode` (`codemode.ts`, `codemode-child.ts`), `preview`, `apply_patch` (`apply-patch.ts`, `apply-patch-parser.ts`), `shell_session` (`interactive-exec.ts`, PTY), `lsp`, `tool_search`, `ast_search`, `ast_edit` (`ast-match.ts`). Supporting modules: `hashline.ts`, `line-endings.ts`, `atomic-write.ts`, `verified-open.ts`, `change-journal.ts`, `read-ledger.ts`, `repo-map-cache.ts`, `model-tool-routing.ts`, `ignore.ts`, `helpers.ts`.

`app/src/tui/` (the terminal UI, scrollback-native, rich on a TTY, plain otherwise): `index.ts` (chat surface), `interactive.ts` (chat loop, slash commands), `headless.ts`, `print.ts` (`-p`), `render.ts` (events to terminal output, `sanitizeText`), `live.ts` (status bar, spinner, live region), `style.ts` (ANSI and colour ladder, `/theme`), `markdown.ts` (streaming markdown), `cards.ts` (tool cards), `diff.ts` (diff gutters), `approval.ts` (line prompt), `approval-card.ts` (single-key card), `paste.ts` (bracketed paste), `completion.ts` (Tab and ghost text), `banner.ts`.

`app/tests/` (about 148 files; layout mirrors `src`): `tests/core/` (84 files), `tests/tools/`, `tests/tui/` (includes `fixtures/plain-events.expected.txt`, `pty.test.ts`, `harness.ts`), `tests/providers/`, `tests/fixtures/` (`tool-schemas.json` is the committed tool-schema snapshot; fake LSP and MCP servers; hook fixtures).

### 1.3 `kernel/` (Rust)

`kernel/Cargo.toml`, `kernel/Cargo.lock` (build with `--locked`), `kernel/tests/integration.rs`, and `kernel/src/`:

| File | Role |
|---|---|
| `main.rs` | NDJSON stdio server; also `--selftest` (25 checks) |
| `protocol.rs` | Request dispatch (11 methods in `protocol.rs`; the TS `KERNEL_METHODS` also has 11) |
| `guard.rs` | Authority evaluation `deny > lease > ask > allow`, in-memory leases, structural deny on the kernel state directory (symlink-lexical), consults `egress.rs` for `net.fetch` and `execpolicy.rs` for `shell.exec` |
| `egress.rs` | Pure per-origin decider for `net.fetch` (admission only; no traffic is intercepted) |
| `execpolicy.rs` | Declarative command allowlist (`Deny > Ask > Allow`) |
| `sandbox.rs` | Fail-closed `SandboxMode` ladder and `sandbox.report`; `kernel_applied_mechanisms()` returns all false |
| `eventlog.rs`, `receipts.rs` | Append-only hash-chained `events/<stream>.jsonl` and `receipts.jsonl` with `.head` anchors, optional HMAC anchor (`HZ_ANCHOR_KEY`) |
| `canon.rs` | Canonical JSON and SHA-256. FROZEN: do not change (section 3) |
| `permm.rs` | Owner-only permissions for state directories and files |
| `time.rs` | UTC helpers without a dependency |

### 1.4 `ops/`

| File | Role |
|---|---|
| `ops/gates.sh` | The CI gate runner (8 gates, fail fast), section 2.6 |
| `ops/gate-catalogue.md` | Maps the 18 docs/24 section 3.5 gates to runnable or declared-gap; READ BY A TEST, edit with care |
| `ops/ci/github-actions.yml` | Tracked payload of the CI workflow |
| `ops/install-ci.sh` | Copies the payload to `.github/workflows/ci.yml` (needed because the automation token lacks the `workflow` scope) |
| `ops/landlock-probe.sh` | POSIX sh probe: is Landlock usable on this host? exit 0 usable, 3 not usable. See `docs/audit/landlock-spike-2026-11-08.md` |

### 1.5 `docs/` (what each document owns)

| Doc | Owns |
|---|---|
| `00-index.md` | Reading order and the one-line purpose of each document |
| `_conventions.md` | Document classes, status vocabulary, event-name catalogue (section 6 of it), internal capability IDs, citation rules |
| `01-vision-and-superset.md` | Why HorizonCode exists, the references, inherited/superseded/new |
| `02-decisions.md` | ADR-001 to ADR-016 (binding architectural decisions, incl. terminal-first) |
| `03-hld.md`, `04-lld.md`, `05-domain-and-schemas.md` | Planes and trust boundaries; packages, modules, signatures; every `*V1` schema and canonical numbers (D40) |
| `06-events-and-flows.md` | Event catalogue and 24 flows; Provenance with emitted-versus-catalogue mapping; deferral notes J1 to J7 |
| `07-apis-and-contracts.md` | Controller protocol, kernel ABI, HTTP/SSE, ACP, MCP, SDKs; Provenance; deferral notes K1 to K11 (models.dev, OAuth, T-8, T-18) |
| `08-runtime.md` | Agent loop, subagents, budgets, self-improvement; Provenance and deferred table |
| `09-tools.md` | The 94-tool catalogue (section 4 authoritative), tool system, `tool_search`; Provenance and deferred table (`debug`, `multi_edit`, dialects) |
| `10-cognition.md` | Providers, context compiler, cache contract, memory, retrieval, compaction; Provenance; deferred table (memory tiers, account pools, cost gate) |
| `11-authority-safety.md` | Threat model, guard, leases, receipts, sandbox matrix, policy; deferral notes E1 to E10 |
| `12-sessions-state.md` | Event log, projections, claims, snapshots, durability; deferral notes F1 to F11 |
| `13-tui.md` | The terminal UI: design rules R1 to R201, shipped Parts 1 to 3, Provenance, deferral notes D1 to D18 |
| `14-surfaces.md` | Headless, server, web, desktop, ACP, MCP server, SDKs; deferral notes G1 to G13 |
| `15-extensibility.md` | Plugins, skills, commands, hooks, workflows, MCP/ACP depth; deferral notes H1 to H11 |
| `16-operations.md` | Install and release integrity, CI gates, observability, doctor; deferral notes I1 to I13 |
| `24-feature-catalog.md` | Feature catalogue and the 18 gates (section 3.5) |
| `25-roadmap-and-glossary.md` | Roadmap phases and glossary |
| `26-learning-synthesis-2.md`, `27-implementation-plan.md` | Learning synthesis; the staged implementation plan |
| `28-implementation-status.md` | THE ONLY home of the status ladder; per-feature levels; rulings 1 to 91 |
| `29-final-audit.md` | The final audit synthesis (parts A to C) |
| `30-steal-list.md` | The steal list: every upstream idea, Upstream URL and Status columns, section 0.2 PR map, section 6 forgecode T-1 to T-20, section 7 open-work register |
| `31-design-summary.md` | The designed capability list (the former long README) |
| `32-plan-files.md` | The `.hz/plans/` plan-file convention and the `execute-plan` skill |
| `33-handoff.md` | This file |
| `audit/` | Historical evidence: six delta audits (`audit-*.md`), `competitive-viability-audit-2026-11-08.md`, `external-audit-2026-11-08.md`, `reaudit-2026-11-08.md`, `triage-external-review-2026-11-07.md`, `observations-reference-defects-2026-11-07.md`, `landlock-spike-2026-11-08.md`, and `pass2/` to `pass5/` raw reports; `audit/README.md` explains the use |
| `research/` | Imported research notes and upstream pins, section 7 |

---

## 2. Build, test and gate commands, and environment gotchas

### 2.1 Build

```bash
# Kernel (Rust). Build BEFORE running app tests: several tests spawn the release binary.
cd kernel && cargo build --release --locked
# If ~/.cargo is read-only (the sandbox case), point CARGO_HOME at a writable cache:
cd kernel && CARGO_HOME=/projects/sandbox/.scratch/cargo-home cargo build --release --locked

# App (TypeScript). Needs bun. Install dev types once:
cd app && bun install && git checkout -- bun.lock   # NEVER commit app/bun.lock
```

The app finds the kernel via `HZ_KERNEL_BIN`, else `kernel/target/release/hz-kernel`, else the debug build. With no kernel binary the runtime falls back to the in-process `LocalKernel` with identical decisions (ruling 33).

### 2.2 Test and verify

```bash
cd app && bun run typecheck      # tsc --noEmit; expect 0 errors
cd app && bun test               # expect 1792 pass / 8 skip / 0 fail (148 files) as root
cd kernel && cargo test --locked # expect 49 + 50 passing (unit + integration)
./kernel/target/release/hz-kernel --selftest --state-dir <fresh dir>   # SELFTEST OK (25 checks)
bash ops/gates.sh                # 8 gates, see 2.6
```

Baseline measured on `docs/handoff` before this file was added: typecheck clean; `bun test` **1792 pass / 8 skip / 0 fail across 148 files** when run as root. The 8 skips are the chmod-based tests that skip where permission bits do not bind (root); as a non-root user (uid 1000) they run and pass (rulings 39, 51). Do not treat the 8 skips as failures and do not delete the tests.

### 2.3 Environment gotchas (each one cost a session once)

1. **Root skips 8 chmod tests.** Expected: see above. Use `setpriv --reuid=1000 ...` to run as non-root when you need the full count.
2. **Build the kernel before app tests.** `cd kernel && cargo build --release --locked`. Tests that need `hz-kernel` will fail or fall back otherwise.
3. **`CARGO_HOME`.** If `~/.cargo` is read-only, set `CARGO_HOME=/projects/sandbox/.scratch/cargo-home` (already populated) for every cargo command.
4. **Never commit `app/bun.lock`.** `bun install` rewrites it. After any `bun install`, run `git checkout -- app/bun.lock`. Before every commit, check `git status` for it and stage files by name (never `git add -A` or `git add .`).
5. **Background cargo builds die between tool calls.** In the agent sandbox a `cargo build &` is killed when the call returns. Run cargo in the foreground in one call (give it a long timeout).
6. **`/tmp` is wiped between calls** in the agent sandbox. Put scratch files, caches and generated artefacts under `/projects/sandbox/.scratch/` (or any path inside the workspace). `ops/gates.sh` itself uses `${TMPDIR:-/tmp}` for a throwaway directory and removes it on exit; that is fine because it lives within one call.
7. **No network in some sandboxes.** `bun install` and `cargo` need registries unless already cached. The caches in `.scratch/` exist for this reason. Keyed provider runs need real API keys and were never possible there (this is why several quality items are deferred).
8. **Run the gates in one call.** `bash ops/gates.sh` takes roughly 15 seconds locally; it is fail-fast and prints a summary table.
9. **Do not run `bun test` while another bun process holds the same state directory.** Tests create temp dirs, but file-lock tests are timing sensitive on a loaded machine.
10. **`gh` may not work** (GraphQL-backed subcommands fail in the sandbox, and a gateway remote may be unreachable). Use `gh api` REST calls where available, and do not assume you can list or merge pull requests.

### 2.4 Scratch and generated files

`.scratch/` holds: toolchain caches (`cargo-home`, `home-b`, `doc-home`), demo drivers (`demo/`, `e2e/`, `fc-e2e/` with PTY drivers `drive.py`, `drive_tui.py`), docs generator scripts (`prov`, `prov2`, `prov3`, `prov4`, `prov5` directories) and logs. None of it is product. Do not commit it.

### 2.5 Files that tests read (edit carefully, rerun `bun test`)

- `docs/10-cognition.md`: the prompt golden (section 2.J.1) is compared to the base prompt by a test. Do not edit that section by hand.
- `ops/gate-catalogue.md`: read by `app/tests/core/gate-startup-latency.test.ts` and related checks.
- `app/tests/fixtures/tool-schemas.json`: the tool-schema snapshot. A tool description or schema change must update it deliberately (T-2, ruling 68). Never auto-accept.
- `app/tests/tui/fixtures/plain-events.expected.txt`: pins plain (non-TTY) output byte for byte.

### 2.6 The gate runner (`ops/gates.sh`)

Run `bash ops/gates.sh` from anywhere (it derives the repo root from its own location; it takes no arguments). Fail-fast order and meaning:

| # | Gate | What it runs |
|---|---|---|
| 1 | `rust-kernel-suite` | `cargo test --locked` in `kernel/` |
| 2 | `kernel-selftest` | `kernel/target/release/hz-kernel --selftest --state-dir <fresh tmpdir>` (release-builds first when absent) |
| 3 | `ts-typecheck` | `bun run typecheck` in `app/` (runs `bun install` first if `@types/bun` or `@types/node` is missing) |
| 4 | `ts-suite` | `bun test` in `app/` |
| 5 | `e2e-headless-smoke` | `printf 'list files' | ./bin/hzcode --workspace <fresh>`: exit 0, tool exchange in output, non-empty receipt chain |
| 6 | `e2e-budget-rail` | same with `HZ_MAX_STEPS=1`: exit 5 plus the budget notice |
| 7 | `e2e-usage-error` | `./bin/hzcode --max-steps nope`: exit 2 plus the diagnostic |
| 8 | `startup-latency` | median of 5 runs of `hzcode --version` (ceiling 500 ms) and of one headless mock turn (ceiling 1000 ms); override with `HZ_LATENCY_VERSION_MS` and `HZ_LATENCY_TURN_MS` (ruling 72) |

Exit 0 means all passed. These 8 are runner steps, not the docs/24 section 3.5 rows. All 18 distinct docs/24 gate rows (`gate:parity-ratchet`, `cache-guard`, `layering`, `frontend-parity`, `file-size`, `function-size`, `wire-parity`, `sensitive-path-coverage`, `boundary-test`, `tool-declaration`, `receipt-coverage`, `no-unknown-retry`, `kernel-pin`, `cross-plane-abi`, `doc-status`, `dead-lane-fail-closed`, `provenance`, `repolint-debt`) are `declared-gap` in `ops/gate-catalogue.md`: the runner never pretends to run them, and the catalogue gives the reason for each. Implementing one means adding it to `gates.sh`, flipping its row to `runnable`, and a docs/28 ruling in the same commit.

Useful environment variables read by the app: `HZ_PROVIDER`, `HZ_MODEL`, `HZ_API_KEY`, `HZ_BASE_URL`, `HZ_MAX_STEPS`, `HZ_MAX_TOKENS`, `HZ_MAX_WALL_MS`, `HZ_KERNEL_BIN`, `HZ_ANCHOR_KEY`, `HZ_MODELS_SNAPSHOT`, `HZ_THEME`, `HZ_HYPERLINKS`, `HZ_NO_PTY`, `HZ_ALLOW_INTERACTIVE`, `HZ_LOCK_TIMEOUT`, `HZ_CODEMODE_FRAME_KEY`, `HZ_ACCEPT_LEGACY_ANCHORS`. `NO_COLOR` always wins over theme choices. The zero-config default provider is `mock`, so chat works with no keys.

---

## 3. Invariants (do not break these)

1. **Zero runtime dependencies in `app/`.** `package.json` may only carry `devDependencies` (types, compiler). No parser-combinator, no TUI framework, no HTTP client. The Rust kernel uses std plus serde; adding the first async runtime or TLS crate is an owner decision (see section 5.2).
2. **`app/src/contracts.ts` is ADDITIVE ONLY.** New optional fields and new union variants are allowed with an in-comment justification and a docs/28 note in the same commit. Never rename, remove or retype an existing member. Existing additive examples: `Tool.exposure`, `Tool.searchInfo` (ruling 45), `subagent.event` (ruling 54), `assistant.thinking` (C3, ruling 87), `subagent.start` and `subagent.end` (C2, ruling 88), `ApprovalRequest.guardian` (ruling 60).
3. **`kernel/src/canon.rs` is unchanged.** Canonical JSON and hashing are frozen and mirrored by `app/src/core/canon.ts`; a change would invalidate every existing log. Docs/05 D40 fixes the number rules.
4. **Docs are updated in the same commit as the code.** A behaviour change must land with its docs/28 ruling or level update, its docs/30 Status cell, and the affected design-doc Provenance or deferral note. A feature without a doc update is not done.
5. **No em dashes (the long dash character) in new prose.** Use a hyphen, a comma, a colon or parentheses. The research notes were cleaned the same way.
6. **CI workflow edits only through a pull request.** The automation token lacks the `workflow` scope. Edit `ops/ci/github-actions.yml`, run `bash ops/install-ci.sh`, and have a human with the scope push `.github/workflows/ci.yml` via a PR.
7. **No direct pushes to `main`.** Work on a branch, open a pull request. Never force-push.
8. **Honest sandbox reporting.** `kernel_applied_mechanisms()` returns `AppliedMechanisms::none()` (all four fields false) and `sandbox.report` must never say a dimension is `enforced` unless the same change really applies the mechanism and tests the denial (ruling 44 correction, ruling 51). `hostCapabilities.available` must never be converted into `enforced`. A git worktree is not a sandbox. The egress decider governs the `net.fetch` guard kind only, not the traffic of a shell child.
9. **No yolo or bypass permission mode.** The modes are `default`, `plan`, `accept-edits`, `read-only` (ruling 58). Hooks are deny-only. A model verdict (guardian) never grants. Unattended runs never auto-approve.
10. **The status ladder lives only in `docs/28`.** Other documents say DESIGNED or DESIGN ONLY or quote docs/28; they never invent a level. Do not mark anything VERIFIED without a measured run recorded in docs/28; nothing is RELEASED.
11. **Every executed tool call is guarded, approved if asked, and receipted.** This includes calls parsed from text (a future T-18) and calls from code mode. The loop refuses an unmapped registered tool fail-closed (`guardActionFor`, ruling 49).
12. **Prompt text from files cannot carry authority.** Instruction files, skills, commands and plan files are text only; the readers refuse symlinks (ruling 79). Terminal output from model text goes through `sanitizeText`.
13. **Secrets are masked** (`maskSecrets`) in every export, dump or summary. Request dumps (T-9) must follow the same rule.
14. **Do not weaken a test to pass.** If a test fails, find the cause; if you must change an assertion, say why in the commit and in docs/28.

---

## 4. Pull request history, #1 to #28

Numbers come from the hand-off recorded by earlier sessions and from `git log` merge commits. PR #26 and PR #27 merge commits are NOT in this branch's history (the branch was cut from `feat/tui-part3`, which sits on top of the #25 merge); their numbers, titles and commit ids come from the hand-off and from `docs/30` section 0.2. Verify them on GitHub before quoting them. The same table, with ruling numbers, is in [`30-steal-list.md`](30-steal-list.md) section 0.2; the rulings themselves are in [`28-implementation-status.md`](28-implementation-status.md).

| PR | Branch | What it did | Rulings and notes |
|---|---|---|---|
| #1 | docs/steal-list-second-wave | Added the second-wave steal list (docs/30 section 5): opencode, cline, codex, oh-my-pi re-verified, grok-build, Claude Code, DeepSeek harness | Docs only |
| #2 | fix/typecheck-and-gate | Made `bun run typecheck` green (30 errors fixed without loosening `strict:false`) and made it a gate | Ruling 39 |
| #3 | fix/kernel-warm-tail-cache | Kernel fix for the warm tail cache of the event log | Kernel only |
| #4 | feat/provider-superset | Fail-loud unknown provider (no silent mock fallback), the `Credential` contract (`apiKey`, `none`, reserved `oauth` arm), the `openai-compatible` adapter, user provider registry, models.dev catalogue seam (`catalog.ts`, curated 5-provider JSON, `HZ_MODELS_SNAPSHOT`) | Merged only into `fix/typecheck-and-gate` at first; integrated by #16. Reference: `research/compare-providers.md` |
| #5 | feat/safety-rails | Loop detection, mistake tracker (limit 3), repeat-tool reminder, bash interceptor table | Ruling 40; modules in `app/src/core/guards/` |
| #6 | feat/apply-patch-routing | `apply_patch` tool (GPT/Codex grammar), declarative model-to-tool routing, per-model prompts | Rulings in docs/28 section 1 (apply_patch row) |
| #7 | feat/edit-engine-superset | CRLF-safe matching, unicode-fold rung, named thresholds, richer miss feedback in `edit` | Ruling 41 |
| #8 | work/wt-server-rewind | `hzcode serve` single-attach server, conversational rewind (`rewindTo`, boundary-safe truncation), `AdmissionQueue.recoverInterrupted` on open/resume | Commit 74b227b for recovery; ruling 53 later fixed live stdin |
| #9 | work/wt-sandbox | Command allowlist (`execpolicy.rs`), per-origin egress decider (`egress.rs`), `SandboxMode` ladder and `sandbox.report` (`sandbox.rs`) | Rulings 42, 43, 44; OS enforcement still absent |
| #10 | work/wt-pty | `shell_session` interactive PTY tool | Ruling 55 later made input admitted per line |
| #11 | work/wt-lsp | LSP client, `lsp` tool, diagnostics ledger, LSP loop | Default off |
| #12 | work/wt-diag-hooks | Hook lifecycle points (H1 taxonomy subset) and the H9 context channel | Ruling 35 lifecycle superset |
| #13 | work/wt-tier3-tools | Tool exposure classes (`direct`, `deferred`, `code_mode_only`, `hidden`), `tool_search`, per-turn `turn.diff` | Rulings 45, 46 |
| #14 | work/wt-tier3-exec | Speculative execution coordinator (off), guardian classifier (advisory) | Rulings 47, 48; speculation later left unwired by 65 |
| #15 | work/wt-tier3-ast | `ast_search` and `ast_edit` | Ruling 49 |
| #16 | integration/superset | Integrated PRs #4 to #15 into one tree; one interaction bug fixed (commit 33e8e29); review fixes | Rulings 39 to 50 (ruling 50 is the integration seam fixes); merge commit `606f981` |
| #17 | fix/flaky-state-dir-guard-test | Fixed a test-harness race in the state-dir guard test | Ruling 52 |
| #18 | chore/merge-remaining-and-key-note | Merged the remaining branch (PR #4 to #6 merge commits) into main; added a key note | Merge `5ed20a0` |
| #19 | fix/tui-serve-subagent-and-session-gate | Live serve stdin worker, real hello `kernelMode`, honest `/files`, an exit on every turn; nested subagent events; `shell_session` input admitted per line | Rulings 53, 54, 55 |
| #20 | feat/system-prompt-and-instructions | The base system prompt as data (about 700 tokens) and AGENTS.md/CLAUDE.md/GEMINI.md peer instruction files with one precedence | Rulings 9 and 9a (base prompt as data, instruction files as peers); docs/30 section 0.2 groups #16 to #20 under rulings 50 to 55 |
| #21 | feat/agents-headless-modes-fork | Agent presets (`explore`, `plan`, `review`), headless `-p/--print`, named permission modes, `/fork`, guardian surfacing on approvals | Rulings 56 to 62 |
| #22 | feat/runtime-depth | Cross-process file locking, hashline anchors, speculation deliberately left unwired, runtime residuals (shell pre-admission refusal, guardian fail-closed, wider accept-edits list) | Rulings 63 to 66 |
| #23 | feat/tui-polish | TUI part 2: colour ladder, synchronized frames, status bar and spinner (T-6), tool cards, streaming markdown (T-5) | Commits f6402fd, 5b782dc, d1838f8; docs/13 Part 2 |
| #24 | docs/product-readme | The product README; the designed capability list moved to docs/31 | Docs only |
| #25 | feat/forgecode-takes | forgecode T-1 (JSON repair), T-2 (tool-schema snapshot), T-3 (pending-todos re-check), T-4 (attempts remaining), T-10 (`hzcode doctor`), T-11 (startup-latency gate) | Rulings 67 to 75; merge `51961de` |
| #26 | forgecode takes, second batch | T-7 (structured compaction summary), T-13 (custom commands as files), T-14 (skill folders) | Rulings 76 to 79. Number from the hand-off; merge commit not in this history |
| #27 | forgecode takes, third batch | T-12 (conversation verbs), T-16 commit half (`hzcode commit`), T-19 (plan files and `execute-plan`), T-20 config check half | Rulings 80 to 83. Same caveat as #26 |
| #28 | feat/tui-part3 | TUI part 3 from Grok Build minimal mode: bracketed paste collapse (`paste.ts`, ruling 84), single-key approval card (`approval-card.ts`, 85), diff gutters (`diff.ts`, 86), thinking display with additive contract C3 `assistant.thinking` (87), subagent cells with additive contract C2 `subagent.start`/`subagent.end` (88), Tab completion and ghost text (`completion.ts`, 89), `/theme dark\|light\|auto\|mono` (`style.ts`, 90), and a pre-publish review hardening pass (91: paste cannot answer the approval card, `@path` completion never offers control or bidi names) | Rulings 84 to 91. docs/30 shows this row as "no PR number recorded"; the hand-off calls it #28. Verify on GitHub |

Summary of what is merged on `main` versus open is in `CURRENT_RUN.md`; the pull requests were not re-listed from GitHub in this pass (the `gh` CLI could not reach the remote). **Open verification item:** docs/28 mentions of PR #26 and PR #27 should be checked against GitHub (titles, merge commits) and corrected if they differ.

---

## 5. Deferred backlog (one entry per item)

Format of every entry: **What** (and what exists today), **Why deferred**, **Upstream reference** (pinned GitHub URLs; adopt-as-is or adapt), **Suggested design**, **Files to touch** (paths that exist today are plain; new files are marked "new"), **Priority** (P0 do first, P1 important, P2 useful, P3 optional or conditional), **Acceptance / test idea**. Each entry also names the design-doc deferral note that holds the longer form; the note is the detailed source and this entry must not contradict it.

Priority overview (details in each entry): P0 hook trust gate (section 6 item 2, not a feature but the largest authority gap); P1 OS confinement backend (5.3), request dump and hygiene evals (5.11); P2 OAuth (5.6), models.dev snapshot (5.7), quirk table (5.10), `--worktree` (5.12), generated config schema (5.15), TUI part 3 gaps (5.18), MITM proxy (5.2, after 5.3); P3 everything else.

Already LANDED (not deferred, do not redo): forgecode T-5 (streaming markdown, `app/src/tui/markdown.ts`) and T-6 (spinner with elapsed time and `esc to cancel` hint, `app/src/tui/live.ts`), T-1 to T-4, T-7, T-10 to T-14, T-19, and the `hzcode commit` half of T-16 and the `config check` half of T-20.

### 5.1 DAP debugger (`debug` tool)

- **What.** A `debug` tool that launches and drives a Debug Adapter Protocol adapter (breakpoints, stepping, stack, variables). Today: not implemented. `docs/09` names the tool; 18 tools are registered and `debug` is not one.
- **Why deferred.** Launching a program under a debugger is arbitrary code execution (same authority as `shell.exec`) plus an adapter process (`spawn`). Without OS confinement (5.3) it is only an ask-gated tool. Low demand next to LSP diagnostics.
- **Upstream reference (adapt; oh-my-pi is TypeScript and MIT, so porting with attribution is possible, a clean re-implementation is preferred).** [`packages/coding-agent/src/dap/client.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/client.ts), [`session.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/session.ts), [`config.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/config.ts), [`defaults.json`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/defaults.json), [`types.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/dap/types.ts). Detail note: `docs/11-authority-safety.md` E10; catalogue entry in `docs/09-tools.md`.
- **Suggested design.** Admit `debug.launch` as BOTH `spawn` and `shell.exec` (ask by default, never auto-approved by `accept-edits`, refused by `read-only`). Spawn the adapter only through `spawnOwned` (ledger row). Speak DAP over the adapter's stdio with `Content-Length` framing (the LSP client in `app/src/core/lsp/framing.ts` and the MCP client already frame similarly; reuse the framing helper). Ship a read-only subset first (`debug.stack`, `debug.variables`) against an already-running adapter, then launch/step. Bound output with the output-budget spill. Register as `deferred` exposure so it appears only through `tool_search`.
- **Files to touch.** New `app/src/tools/debug.ts`, new `app/src/core/dap/` (client, session, config), `app/src/tools/index.ts`, `app/src/core/loop.ts` (`guardActionFor`), `app/src/core/permission-mode.ts`, `app/tests/tools/tool-schema-snapshot.test.ts` plus `app/tests/fixtures/tool-schemas.json` (deliberate update), `docs/09-tools.md`, `docs/28-implementation-status.md`.
- **Priority.** P3.
- **Acceptance.** A fake DAP adapter fixture (like `app/tests/fixtures/fake-lsp-server.ts`) answers `initialize`, `setBreakpoints`, `stackTrace`, `variables`; tests show the launch is admitted as both `spawn` and `shell.exec`, refused in `read-only`, ledgered, and a protocol error never hangs (timeout).

### 5.2 MITM egress proxy

- **What.** A real proxy that parks a connection while the decider asks, pins resolved IPs, re-checks after redirect or DNS rebind, optionally intercepts TLS with a local CA, and injects credentials so the child never holds them. Today: only the pure decider and policy in `kernel/src/egress.rs`, consulted by `guard.rs` for `net.fetch` BEFORE the policy rules. A shell child running `curl` is admitted as `shell.exec` and then reaches any host.
- **Why deferred.** A proxy only constrains a child that cannot bypass it, which needs network confinement (5.3: a network namespace whose only route is the proxy). Without that, reporting it as enforced would be false. TLS interception needs a CA lifecycle and a user-visible trust step. It also needs the first Rust dependency beyond std/serde (an async runtime), an owner decision.
- **Upstream reference (adapt; Rust, could be studied for the Rust kernel; copying code needs attribution).** Grok: [`xai-grok-egress-proxy/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/lib.rs), [`server.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/server.rs), [`connect.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/connect.rs), [`tls.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/tls.rs), [`http.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/http.rs), [`ip.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/ip.rs), [`credential.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/credential.rs), [`decider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-egress-proxy/src/decider.rs). Codex: [`codex-rs/network-proxy/src/http_proxy.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/http_proxy.rs), [`certs.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/certs.rs), [`connect_policy.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/connect_policy.rs), [`domain_matcher.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/domain_matcher.rs), [`credential_broker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/credential_broker.rs), [`body_budget.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/network-proxy/src/body_budget.rs). Claude Code (cheap container pattern): [`.devcontainer/init-firewall.sh`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/.devcontainer/init-firewall.sh), [`.github/egress-firewall.yaml`](https://github.com/anthropics/claude-code/blob/0ed94698aa0aeee471465fc9c867c2e8434c4d68/.github/egress-firewall.yaml). Detail note: `docs/11-authority-safety.md` E2.
- **Suggested design.** Staged. Stage 0 (no new enforcement claim): a documented container recipe from the devcontainer firewall pattern and a `hzcode doctor` line that reports whether an outer egress firewall exists, labelled "outer, unverifiable from inside". Stage 1: a CONNECT-only forward proxy in the Rust kernel on loopback whose decider is `egress::Decider`; children get `HTTPS_PROXY`, and with 5.3 a netns whose only route is the proxy; `hold()` as a real parked connection using the modelled `HoldBudget` (ceilings 16 and 8, 600 s). Stage 2: resolve once in the proxy, connect by IP, refuse private, loopback and link-local ranges unless a rule allows (rebind re-check, as Grok's `ip.rs`). Stage 3 only if needed: per-session CA (0600 under the state dir) and credential injection, with `SecretUseLeaseV1` as the authority. Record every blocked request with the content-free `BlockedRequest` shape.
- **Files to touch.** `kernel/src/egress.rs` (add a `proxy` submodule, keep `Decider` pure), `kernel/src/main.rs` (listener lifecycle), `kernel/src/protocol.rs` (additive `egress.report`), `kernel/Cargo.toml` (owner decision on an async runtime), `app/src/core/owned-spawn.ts` (proxy env), `app/src/core/doctor.ts`, `docs/11-authority-safety.md` section 7.13, `docs/28-implementation-status.md`.
- **Priority.** P2 (stage 0 is P1 and cheap; stages 1 to 3 wait for 5.3).
- **Acceptance.** Stage 0: doctor output names the outer-firewall state. Stage 1: with the child in a netns whose only route is the proxy, `curl` to a denied origin fails and a blocked-request record exists; a direct connect attempt fails at the network layer. Never report `enforced` for egress unless that test passes.

### 5.3 OS confinement backend (Landlock, seccomp, network namespace, rlimits)

- **What.** Actually applying a confinement mechanism to a spawned child. Today `kernel_applied_mechanisms()` returns `AppliedMechanisms::none()` (all four fields false), so `sandbox.report` can only say the mode is admitted, the host OFFERS some mechanisms, and nothing is `enforced`. `read-only` and `workspace-write` with `demand_full` return the typed `SANDBOX_UNAVAILABLE`; `danger-full-access` reports nothing enforced. Nothing applies a Landlock ruleset, seccomp filter, netns or rlimit to any process.
- **Why deferred.** Landlock is absent on the build host (kernel `4.19.0-gvisor`; `landlock_create_ruleset` returns ENOSYS; no bwrap; see [`audit/landlock-spike-2026-11-08.md`](audit/landlock-spike-2026-11-08.md)). On the hosted CI runner Landlock is active but the kernel still applies nothing, which ruling 51 made the report say honestly. Enforcement needs a spawn path that applies the mechanism between fork and exec (a helper binary or `pre_exec`), which `Bun.spawn` cannot do.
- **Upstream reference (adapt per platform; the mechanisms are syscalls, so no code copy is needed; licences: codex Apache-2.0, deepseek-harness MIT, grok-build its own LICENSE).** Codex: [`codex-rs/sandboxing/src/landlock.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/sandboxing/src/landlock.rs), [`bwrap.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/sandboxing/src/bwrap.rs), [`seatbelt.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/sandboxing/src/seatbelt.rs), [`codex-rs/linux-sandbox/src/seccomp.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/linux-sandbox/src/seccomp.rs), [`linux-sandbox/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/linux-sandbox/src/lib.rs), [`codex-rs/process-hardening/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/process-hardening/src/lib.rs), [`codex-rs/windows-sandbox-rs/src/lib.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/windows-sandbox-rs/src/lib.rs). DeepSeek harness (TypeScript, same rung chain with a functional probe and fail-closed behaviour): [`packages/sandbox/sandbox-local/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox-local/src/index.ts), [`profiles.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox-local/src/profiles.ts), [`packages/sandbox/sandbox/src/diagnostics.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/src/diagnostics.ts), [`roots.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox/src/roots.ts), [`packages/sandbox/sandbox-windows-acl/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/sandbox-windows-acl/src/index.ts). Grok: [`xai-grok-sandbox/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/lib.rs), [`profiles.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/profiles.rs), [`command/backend.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/command/backend.rs), [`command/backend/seatbelt.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/command/backend/seatbelt.rs), [`command/detect.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/command/detect.rs), [`network_policy.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sandbox/src/network_policy.rs). Cline: [`sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts). Detail note: `docs/11-authority-safety.md` E1 (and E8 for Windows and macOS).
- **Suggested design (ruling 38 direction, unchanged).** (1) First the portable reduced form for `code_mode` and shell children: `no_new_privs`, a seccomp deny-list (ptrace, mount, bpf, kexec), rlimits (CPU, address space, file size, processes, open files) and network-off through an unshared netns, typed `best_effort` with named residuals (no per-path rules). Implement as a small Rust helper `hz-sandbox-exec` built as a second binary; the TS side spawns `hz-sandbox-exec -- <argv>` through `spawnOwned`. (2) On gVisor and container deployments record the outer sandbox as the confinement of record. (3) Landlock stays a probe-gated upgrade on a kernel of 5.13 or newer using the checklist in section 6 of the spike document (ABI versioning, per-path rules, exec restrictions); `ops/landlock-probe.sh` is the deployment gate. (4) Only in the change that really applies a mechanism, flip the matching field of `kernel_applied_mechanisms()` and add a test that spawns a child and shows the denial (a write outside the root fails; a socket connect fails). (5) macOS and Windows backends are separate items and stay `unsupported`.
- **Files to touch.** `kernel/src/sandbox.rs` (`AppliedMechanisms`, `kernel_applied_mechanisms`, `enforce`), new `kernel/src/bin/hz_sandbox_exec.rs` or `kernel/src/confine.rs`, `kernel/Cargo.toml`, `kernel/tests/integration.rs`, `app/src/core/owned-spawn.ts`, `app/src/tools/shell.ts` (route through the helper only when a report says a dimension is enforced), `app/src/contracts.ts` (additive only), `ops/landlock-probe.sh`, `docs/28-implementation-status.md`, `docs/11-authority-safety.md` section 7.12.
- **Priority.** P1 (it unlocks 5.2, 5.1 and an honest "sandboxed" claim).
- **Acceptance.** On a Landlock-capable Linux host: a child spawned through the helper cannot write outside the allowed root and cannot open a socket; the report lists `enforced` for exactly those dimensions with the backend name; on the gVisor build host the report still says nothing is enforced; a test fails if any code path turns `hostCapabilities.available` into `enforced`.

### 5.4 Memory tiers and "dream" consolidation

- **What.** The designed memory plane (tiers, extraction, reflection, consolidation, conflict handling, privacy, retention, recall tool; docs/10 R74 to R94) and Grok-style background "dream" consolidation. Today: no `memory/` directory, no store, no recall tool. The only memory-adjacent code is the NF-075 reduced growth loop: `app/src/core/review.ts` (review-fork spec), `app/src/core/curator.ts` (editorial gate and append-only proposal log that applies nothing), `app/src/grow.ts` (manual runner). The usage-origin label `dream` is reserved in docs/10 R53.
- **Why deferred.** Needs a retrieval engine (embeddings, BM25, MMR) and a store, a background scheduler (none exists), a privacy and retention policy, and live embedding providers that were not available offline. The reduced curator is deliberately safe: it writes nothing automatically.
- **Upstream reference (adapt; Rust, so ideas only).** Grok memory crate: [`storage_v2.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/storage_v2.rs), [`v2_consolidation.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/v2_consolidation.rs), [`mmr.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/mmr.rs), [`batch_dream.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/batch_dream.rs), [`batch_dream_plan.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/batch_dream_plan.rs), [`batch_dream_commit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/batch_dream_commit.rs), [`batch_dream_recovery.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-memory/src/batch_dream_recovery.rs). hermes-agent (growth family G-1 to G-7 in docs/30) and aider are NOT cloned: `path not verified`; evidence is `audit/pass3/audit-hermes-report.md`. Research: [`research/compare-codex-grok.md`](research/compare-codex-grok.md) section 2.4, [`research/steal-grok-claude-deepseek.md`](research/steal-grok-claude-deepseek.md) section 2.5. Detail: `docs/10-cognition.md` deferred table and Provenance row 11; `docs/30-steal-list.md` section 5.5 and section 7.
- **Suggested design.** Start with the smallest honest slice: a `MEMORY.md` manifest per workspace under `.hz/` that is protected like the kernel state (the agent can propose, only the user or an approved `write` changes it), loaded as an instruction-file peer. Then a SQLite FTS5 store (SQLite is already used) with BM25 recall exposed as a read-only `memory_search` tool (deferred exposure). Embeddings and MMR only after a provider with an embeddings endpoint is configured. Dream consolidation last: a manual `hzcode grow dream` runner (not a daemon) that reads the curator log, produces a plan, and applies nothing without approval; every apply is a guarded write with a receipt; use `usage` origin `dream`.
- **Files to touch.** New `app/src/core/memory/` (store, recall, manifest), `app/src/core/curator.ts`, `app/src/core/review.ts`, `app/src/grow.ts`, `app/src/core/instructions.ts` (manifest as a peer), `app/src/tools/index.ts` (new tool), `app/src/core/session.ts` (schema migration if needed), tests under `app/tests/core/`, `docs/10-cognition.md`, `docs/28-implementation-status.md`.
- **Priority.** P3.
- **Acceptance.** A fixture workspace with three remembered facts: `memory_search` returns the right one by BM25; a proposal that widens authority is refused by the editorial gate; consolidation produces a plan file and changes nothing until approved; the manifest cannot be overwritten by a model `write` without approval.

### 5.5 Multi-dialect tool conversion (models without native tool calling)

- **What.** Parsing each model family's own tool-call text format back into normalised calls: Harmony, Hermes, Qwen3, Kimi K2, GLM 4.5, DeepSeek, Gemma, MiniMax, Anthropic and Gemini text formats, an XML format. Today: not started. `app/src/core/providers/ollama.ts` uses Ollama's native tool-call field and the model must support it. (T-18, the forgecode text protocol, is the narrow case of this; its own entry is 5.14.)
- **Why deferred.** Low priority unless local models become a product pillar. The safety rule is non-negotiable: a parsed call is exactly a model-proposed call, so it goes through `parseToolArguments`, the guard, approval and the receipt; the parser must be strict (a malformed block is a format error, never a best-effort guess that invents arguments).
- **Upstream reference (adapt; oh-my-pi's `toolconv` documents are format specifications and the best map of the problem).** [`docs/toolconv/xml.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/xml.md), [`hermes.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/hermes.md), [`harmony.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/harmony.md), [`qwen3.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/qwen3.md), [`kimi-k2.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/kimi-k2.md), [`glm-4.5.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/glm-4.5.md), [`deepseek.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/deepseek.md), [`gemma.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/gemma.md), [`minimax.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/minimax.md), [`anthropic.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/anthropic.md), [`gemini.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/gemini.md), [`pi-native.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/toolconv/pi-native.md). Forge's concrete XML dialect: [`crates/forge_domain/src/tools/call/parser.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/call/parser.rs), [`crates/forge_domain/src/xml.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/xml.rs). Detail note: `docs/07-apis-and-contracts.md` K5.
- **Suggested design.** `app/src/core/providers/toolconv/<dialect>.ts`, each exporting `parse(text): {calls, rest, errors}` and `render(specs): string` (for the system prompt), selected by a catalogue `capabilities.toolFormat` field or a provider registry key `toolFormat`. A wrapper provider turns a text stream into `tool_call` ProviderEvents ONLY after a complete block closes (never from a partial stream); anything unparsable stays assistant text and increments the format-error rail (NF-073 cap of 3). Hand-written scanners, no parser-combinator dependency.
- **Files to touch.** New `app/src/core/providers/toolconv/*.ts`, `app/src/core/providers/ollama.ts`, `app/src/core/providers/openai-compatible.ts`, `app/src/core/config.ts` (registry key), `app/tests/core/toolconv-*.test.ts` (new).
- **Priority.** P3.
- **Acceptance.** Golden tests per dialect from the toolconv specs; a fuzz test proving no input string yields a call whose name is not in the offered `ToolSpec`s; a partial stream yields no call; every parsed call produces a receipt in an end-to-end scripted run.

### 5.6 OAuth acquisition flows (the `oauth` credential arm)

- **What.** Everything needed to OBTAIN and keep an OAuth credential: PKCE with a loopback redirect server, device-code flow, token storage (0600, never in workspace files), refresh on expiry and on 401, logout and revoke, per-provider endpoints. Today: the `Credential` type has an `oauth` arm and the adapters map it to a Bearer header (`authorizationHeader`), but NOTHING produces it; only `apiKey` and `none` exist.
- **Why deferred.** Each flow is provider-specific, depends on third-party endpoints that cannot be exercised offline, and stores a long-lived secret. Two references use client ids that belong to other products; HorizonCode would need its own registration or must not impersonate another client (forgecode's spoofed-header entries are explicitly rejected, docs/30 section 6.2).
- **Upstream reference (adapt one provider at a time; do NOT copy client ids or endpoints without confirming the provider permits third-party clients).** opencode: [`packages/core/src/plugin/provider/chatgpt.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/plugin/provider/chatgpt.ts) (named in the `contracts.ts` header as the pattern), [`packages/core/src/mcp/oauth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/mcp/oauth.ts), [`packages/core/src/oauth/page.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/oauth/page.ts). oh-my-pi (TypeScript, closest in language): [`packages/ai/src/registry/oauth/callback-server.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/callback-server.ts), [`device-code.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/device-code.ts), [`anthropic.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/ai/src/registry/oauth/anthropic.ts), [`docs/auth-broker-gateway.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/auth-broker-gateway.md). Codex (storage and refresh rules): [`codex-rs/login/src/auth/manager.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/login/src/auth/manager.rs), [`storage.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/login/src/auth/storage.rs). Grok: [`xai-grok-auth/src/auth_provider.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-auth/src/auth_provider.rs), [`xai-grok-login/src/api_key_probe.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/api_key_probe.rs). Cline: [`apps/cli/src/wizards/mcp/oauth.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/apps/cli/src/wizards/mcp/oauth.ts). Detail note: `docs/07-apis-and-contracts.md` K3 (MCP OAuth: `docs/15-extensibility.md` H7).
- **Suggested design.** (1) `TokenStore` in `app/src/core/auth/store.ts` (user config dir, mode 0600, atomic write, never logged, masked by `maskSecrets`). (2) `pkce.ts`: `node:crypto` verifier and challenge, a one-shot `Bun.serve` loopback server on `127.0.0.1:<random>` accepting exactly one callback with a matching `state`, 5 minute timeout, static success page. (3) `device-code.ts` for headless boxes. (4) `resolveRegistryCredential` returns `{kind:'oauth', accessToken, refreshToken, expiresAt}` when a token is stored. (5) Refresh once on a 401 before failing. (6) `hzcode login <provider>` and `hzcode logout <provider>` dispatched before arg parsing like `doctor`; `doctor` reports presence and expiry, never the value.
- **Files to touch.** New `app/src/core/auth/*.ts`, `app/src/core/config.ts`, `app/src/main.ts`, `app/src/core/doctor.ts`, `app/src/core/providers/index.ts`, `app/tests/core/auth-*.test.ts` (new), `app/src/contracts.ts` (no change: the arm exists), `docs/11` (storage rule), `docs/28`.
- **Priority.** P2.
- **Acceptance.** State mismatch is rejected; token file mode is 0600; refresh path works with an injected fetch; a revoked token produces a typed error not a crash; `doctor` output never contains a token.

### 5.7 Full models.dev snapshot

- **What.** Bundle the real models.dev provider catalogue (opencode ships about 8 MB, 230 providers, 8787 models, validated at build with `MINIMUM_PROVIDERS = 100`). Today the committed `app/src/core/catalog/models-dev.curated.json` has five providers (about 2.8 KB); `HZ_MODELS_SNAPSHOT` can point at a full snapshot and is floor-validated, but none is shipped. Unknown models get conservative defaults.
- **Why deferred.** Too heavy for review and unavailable under the no-network sandbox where the seam was written; also a repository-size decision (an 8 MB JSON in a zero-dependency repo).
- **Upstream reference (adapt the build-time script idea; the data is third-party, check its licence and record it in a NOTICE).** [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts), [`packages/core/script/models-snapshot.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/script/models-snapshot.ts); source of truth [models.dev](https://models.dev). Research: [`research/compare-providers.md`](research/compare-providers.md) section 5.4. Detail note: `docs/07-apis-and-contracts.md` K1.
- **Suggested design.** `app/scripts/refresh-models-snapshot.ts` (run by a human with network access, never by a test or gate): download the models.dev API JSON, run the same decoder as `catalog.ts` (review `rejected`), enforce `MINIMUM_PROVIDERS`, strip unread fields (target under 1 MB), write `app/src/core/catalog/models-dev.snapshot.json`. Keep the curated file as the offline floor. Add the snapshot to the precedence order after `HZ_MODELS_SNAPSHOT`. Cost fields feed an ESTIMATE in `/stats`, never a bill; a missing rate yields `unknown`, never 0.
- **Files to touch.** `app/src/core/catalog/catalog.ts`, new `app/scripts/refresh-models-snapshot.ts`, new snapshot JSON, `app/tests/core/catalog.test.ts`, `README.md`, `docs/28`, a NOTICE file (licence).
- **Priority.** P2.
- **Acceptance.** Floor validation rejects a snapshot with fewer providers; precedence order test (env, then snapshot, then curated); `/model` listing shows snapshot models; file under 1 MB.

### 5.8 models.dev live refresh

- **What.** `fetchLiveCatalog` (conditional fetch by ETag or digest, atomic cache file; opencode polls every 5 minutes). Today a documented extension point only; the function is disabled.
- **Why deferred.** A background network call from a coding agent is an egress decision: it must go through the egress policy and be off by default. Not testable offline.
- **Upstream reference (adapt the conditional-request and atomic-cache behaviour, not the polling loop).** [`packages/core/src/models-dev.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/core/src/models-dev.ts). Detail note: `docs/07-apis-and-contracts.md` K2.
- **Suggested design.** `hzcode models refresh` (explicit command, no timer): GET with `If-None-Match`, write `<user config dir>/models-dev.cache.json` via atomic rename, mode 0600, validate with the floor, print a diff summary. `loadCatalog` reads the cache after the env override and before the committed snapshot. The fetch runs through the guard as `net.fetch`.
- **Files to touch.** `app/src/core/catalog/catalog.ts` (`fetchLiveCatalog`), `app/src/main.ts`, `app/tests/core/catalog.test.ts` (injected fetch).
- **Priority.** P3 (after 5.7).
- **Acceptance.** 304 leaves the cache untouched; a corrupt response never replaces a good cache; the fetch is admitted as `net.fetch` and denied when the egress policy denies it.

### 5.9 Wiring speculative execution and the guardian model path (ruling 65)

- **What.** (a) Guardian: a model-backed classifier. Today only the deterministic advisory classifier ships (`app/src/core/guardian.ts`), surfaced on approvals (`ApprovalRequest.guardian`, ruling 60) and fail-closed in enforce mode (ruling 66). (b) Speculation: running side-effect-free reads ahead of commit. Today `app/src/core/speculation.ts` exists and `LoopDeps.speculativeExecution` is off and inert; ruling 65 is explicit.
- **Why deferred.** (a) A model reviewing actions adds latency, cost and a new injection surface. (b) The loop has no commit window; ordering across segments is unsound; user pre/post hooks and approval would be bypassed by a kept result; `runToolCall` owns exactly-once effects.
- **Upstream reference (adapt both).** Codex guardian: [`codex-rs/core/src/guardian/mod.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/guardian/mod.rs), [`decision.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/guardian/decision.rs), [`input_budget.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/core/src/guardian/input_budget.rs), [`codex-rs/prompts/templates/guardian/classifier_instructions.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/prompts/templates/guardian/classifier_instructions.md). oh-my-pi speculation: [`packages/agent/src/speculative-execution.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/agent/src/speculative-execution.ts). Detail note: `docs/11-authority-safety.md` E9.
- **Suggested design.** (a) Pass the action and task instructions in `<data>` delimiters (the deterministic path already does), use the review fork's closed read-only tool set, set a hard input budget, fail CLOSED in enforce mode, never let a model verdict grant. (b) Revisit only with a design that runs `tool.pre` hooks and approval BEFORE any kept result is used; the safe slice is prefetching file contents into a cache that the real, fully guarded `read` consults, so the guarded call is still made exactly once.
- **Files to touch.** `app/src/core/guardian.ts`, `app/src/core/loop.ts`, `app/src/core/speculation.ts`, `app/tests/core/speculation-unwired.test.ts` (keep passing or replace deliberately), `app/tests/core/guardian.test.ts`, `docs/28` (new ruling that supersedes 65 if changed).
- **Priority.** P3.
- **Acceptance.** (a) A classifier that errors or times out yields `deny` in enforce mode and a notice in advisory mode; an injected instruction in the action text cannot flip the verdict (fixture). (b) A test proves a prefetched read is still guarded and receipted exactly once, and `tool.pre` hooks still run.

### 5.10 forgecode T-8: provider quirk table

- **What.** A data table of per-host and per-model request transformations applied as small pure functions and recorded in the event: Cerebras without `parallel_tool_calls`, tool-call id trimming, system message first, schema normalisation, dropping reasoning-only messages for Claude, stripping thought signatures on model switch. Not started.
- **Why deferred.** It should be driven by real failures. Only one real OpenAI-compatible endpoint (NVIDIA NIM) was exercised; building 20 transformers speculatively is the "volume" the research warns against.
- **Upstream reference (adapt the mechanism, not the volume).** Forge: [`crates/forge_app/src/dto/openai/transformers/mod.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/mod.rs), [`pipeline.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/pipeline.rs), [`when_model.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/when_model.rs), [`make_cerebras_compat.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/make_cerebras_compat.rs), [`trim_tool_call_ids.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/trim_tool_call_ids.rs), [`ensure_system_first.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/ensure_system_first.rs), [`normalize_tool_schema.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/normalize_tool_schema.rs), [`strip_thought_signature.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/dto/openai/transformers/strip_thought_signature.rs). oh-my-pi quirk catalogue: [`docs/provider-quirks.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-quirks.md), [`docs/provider-compat-reference.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-compat-reference.md), [`docs/provider-endpoint-constraints.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/provider-endpoint-constraints.md), [`docs/ai-schema-normalize.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/ai-schema-normalize.md). Detail: `docs/07-apis-and-contracts.md` K4; `docs/10-cognition.md` deferred table; `docs/30-steal-list.md` section 6.1 T-8.
- **Suggested design.** `app/src/core/providers/quirks.ts`: `type Quirk = { id, applies(ctx:{host,model,protocol}): boolean, request?(body): body, messages?(msgs): msgs }`, a `QUIRKS` array, `applyQuirks(ctx, body)` returning `{body, applied: string[]}`; unknown hosts apply none. `openai-compatible.ts` calls it just before `fetch`; applied ids go into a once-per-session `notice` and into the `message.start` payload (additive field `quirks`). Start with exactly the quirks a real endpoint has demanded.
- **Files to touch.** New `app/src/core/providers/quirks.ts`, `app/src/core/providers/openai-compatible.ts`, `app/src/core/providers/openai.ts`, `app/src/core/loop.ts` (event payload), new `app/tests/core/providers-quirks.test.ts`.
- **Priority.** P2 (trigger: a second real endpoint rejects a request).
- **Acceptance.** Recorded request bodies per quirk: before and after; an unknown host's body is byte-identical to today; the applied ids appear in the event.

### 5.11 forgecode T-9: `HZ_DEBUG_REQUESTS` and the tool-hygiene eval pack

- **What.** (a) Env var `HZ_DEBUG_REQUESTS=<path>` dumping each outgoing provider request body; (b) a key-free eval pack of about eight scenarios run with the scripted provider that asserts on outgoing requests and receipts (used `read` not `cat`; no `cd` when `cwd` exists; patch had no "Could not find match"; at least two tool calls in one message; every admitted shell call has a receipt). Today `grep HZ_DEBUG_REQUESTS app/src` is empty; `core/evals.ts`, `eval-run.ts`, `eval-executor.ts` and `providers/scripted.ts` exist but ship no pack.
- **Why deferred.** Dumps can contain secrets and file contents, so they need redaction and a 0600 file; a measured quality table needs keyed runs that were not possible in the sandbox.
- **Upstream reference (adapt; write them as TypeScript tests over the scripted provider).** [`benchmarks/README.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/README.md), [`benchmarks/cli.ts`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/cli.ts), [`benchmarks/evals/read_over_cat/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/read_over_cat/task.yml), [`redundant_cd_with_cwd/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/redundant_cd_with_cwd/task.yml), [`parallel_tool_calls/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/parallel_tool_calls/task.yml), [`patch_exact_match/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/patch_exact_match/task.yml), [`multi_file_patch/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/multi_file_patch/task.yml), [`todo_write_usage/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/todo_write_usage/task.yml). Detail: `docs/16-operations.md` I6; `research/forgecode-deep.md` sections 2.2 and 3.
- **Suggested design.** In `providers/index.ts` wrap the selected provider in `withRequestDump(provider, path)` when the env var is set; append JSONL, run bodies through `maskSecrets`, open with mode 0600, print one notice naming the file; never enabled by workspace config. Add `app/tests/core/hygiene-evals.test.ts` driving `scripted.ts` with canned turns and asserting on recorded `ProviderRequest`s and `receipts.jsonl`. Add a `hygiene` row to the README quality table only when run against a real provider and recorded with model id and date.
- **Files to touch.** `app/src/core/providers/index.ts`, new `app/src/core/providers/request-dump.ts`, new `app/tests/core/hygiene-evals.test.ts`, `app/tests/providers/*.test.ts`, `README.md`.
- **Priority.** P1 (cheap, key-free, and it guards prompt regressions).
- **Acceptance.** The dump file has mode 0600 and no unmasked secret from a fixture containing `sk-` style strings; the eight scenarios pass in `bun test` with no keys and fail when the relevant prompt line is removed.

### 5.12 forgecode T-15: `hzcode --worktree`

- **What.** `hzcode --worktree <name>`: create a git worktree and branch beside the repo and start there. Today `grep worktree app/src/main.ts` is empty.
- **Why deferred.** It is an effect (git writes) that must go through the guard with a receipt; not urgent.
- **Upstream reference (adapt; name it honestly as a worktree, never a sandbox).** [`crates/forge_main/src/sandbox.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_main/src/sandbox.rs). Detail: `docs/16-operations.md` I9; also `docs/12-sessions-state.md` F11 (worktree pool).
- **Suggested design.** `git worktree add ../<repo>-<name> -b hz/<name>` through `runtime.runGuardedShell` (a `shell.exec` admission with a receipt), then re-exec with `--workspace` set; refuse names with path separators or leading dashes; print where it went. `sandbox.report` must keep meaning OS confinement.
- **Files to touch.** `app/src/main.ts`, `app/src/core/index.ts` (`runGuardedShell`), `app/src/core/doctor.ts` (git check), `app/tests/tui/cli.test.ts`.
- **Priority.** P2.
- **Acceptance.** Test in a temp git repo: worktree and branch exist, a receipt exists, a hostile name (`../x`, `-b`, spaces) is refused with exit 2, and the report is unchanged.

### 5.13 forgecode T-17: status-line script contract

- **What.** A user-config script that receives session JSON on stdin and prints up to five lines for the status row. Today the built-in status bar is `app/src/tui/live.ts`; no script support.
- **Why deferred.** Low value next to the built-in bar; runs a user program on every redraw, so it needs a timeout and an output bound; must be user-config only, never repo-settable (a cloned repo must not pick a program that runs on every redraw).
- **Upstream reference (adapt).** Grok: [`xai-grok-pager/src/app/status_line.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/status_line.rs), [`status_line/command.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/status_line/command.rs), [`docs/user-guide/25-status-line.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md). Detail: `docs/16-operations.md` I9; `docs/30-steal-list.md` section 5.12 ("status line `used / window`").
- **Suggested design.** User config key only; spawn through `spawnOwned` with a 200 ms timeout, 5 lines and 200 characters per line, strip control characters with `sanitizeText`, ignore output on timeout, cache the last good output between redraws.
- **Files to touch.** `app/src/tui/live.ts`, `app/src/core/config.ts`, `app/src/core/owned-spawn.ts` (reuse), `app/tests/tui/live.test.ts`.
- **Priority.** P3.
- **Acceptance.** A slow script never stalls a frame; a workspace config naming a script is ignored with a notice; output with escape sequences is neutralised.

### 5.14 forgecode T-18: text tool protocol for models without native tools

- **What.** When a model is served without native tool calling, switch to a text protocol (forge uses an XML `<forge_tool_call>` block) parsed by a dedicated parser. Not started; the general multi-dialect work is 5.5.
- **Why deferred.** Report priority LOW; only if local-model support becomes a product pillar. Parsed calls must still go through the guard and receipts.
- **Upstream reference (adapt).** [`crates/forge_domain/src/tools/call/parser.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/tools/call/parser.rs), [`crates/forge_app/src/orch.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_app/src/orch.rs). Detail: `docs/07-apis-and-contracts.md` K5; `docs/08-runtime.md` deferred table.
- **Suggested design.** One dialect first (XML), inside the wrapper-provider design of 5.5; gated by a `toolFormat: "xml"` key in the provider registry entry or by catalogue capability `tools:false`.
- **Files to touch.** As in 5.5, starting with `app/src/core/providers/ollama.ts`.
- **Priority.** P3.
- **Acceptance.** As in 5.5, plus: a model that never emits a valid block ends in the format-error rail (3 strikes), not a loop.

### 5.15 forgecode T-20 second half: generated JSON schema for the config

- **What.** A `hzcode.schema.json` generated from the validators in `app/src/core/config.ts` so editors can complete the config file. The first half (`hzcode config check`, ruling 81) is done.
- **Why deferred.** The validators are hand-written functions (`parseMcpServer`, `parseLspServer`, `parseProviderEntry`, scalar checks in `loadConfig`), not a declarative table, so there is nothing to generate from yet.
- **Upstream reference (adapt the idea: a checked-in schema plus a test that fails on drift).** [`forge.schema.json`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/forge.schema.json), [`crates/forge_config/tests/schema.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_config/tests/schema.rs), [`crates/forge_config/src/config.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_config/src/config.rs); Grok: [`docs/user-guide/26-config-reference.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md). Detail: `docs/16-operations.md` I8.
- **Suggested design.** Introduce `CONFIG_KEYS: Record<string, {type, enum?, description}>` in `config.ts`; make `checkConfigFile` read it (its output must not change; the existing tests guard that); generate `app/schema/hzcode.schema.json` with a script; commit it; add a snapshot test.
- **Files to touch.** `app/src/core/config.ts`, new `app/scripts/gen-config-schema.ts`, new `app/schema/hzcode.schema.json`, `app/tests/core/config-check.test.ts`.
- **Priority.** P2.
- **Acceptance.** Editing a key in `CONFIG_KEYS` without regenerating the schema fails the snapshot test; `config check` output is byte-identical on the existing fixtures.

### 5.16 `suggest` (forgecode T-16 second half)

- **What.** `hzcode suggest "<natural language>"`: turn a request into a shell command, print it, never run it. `hzcode commit` (first half) is done (ruling 83). `suggest` is not started.
- **Why deferred.** A convenience over `-p`; low priority.
- **Upstream reference (adapt).** [`crates/forge_domain/src/suggestion.rs`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/crates/forge_domain/src/suggestion.rs), [`benchmarks/evals/suggest/task.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/benchmarks/evals/suggest/task.yml), [`templates/forge-commit-message-prompt.md`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/templates/forge-commit-message-prompt.md) (for the fixed-prompt shape). Detail: `docs/16-operations.md` I9.
- **Suggested design.** Reuse the `commit.ts` pattern: a fixed prompt, one ordinary model turn with no tool access, print the cleaned command. Never execute. Strip control characters from the reply.
- **Files to touch.** `app/src/main.ts`, `app/src/core/commit.ts` or new `app/src/core/suggest.ts`, `app/tests/core/commit.test.ts` (pattern) or new `suggest.test.ts`.
- **Priority.** P3.
- **Acceptance.** With the scripted provider the command is printed; no process is spawned (assert on the spawn ledger); a reply containing escape sequences is printed neutralised.

### 5.17 Grok fullscreen mode (docs/13 R1 to R12) versus the shipped scrollback-only TUI

- **What.** A second screen mode: alternate screen, in-app scrollback pane, differential cell renderer, layout engine, hit-testing. Shipped today: scrollback-only chat on Node readline with a live footer (Parts 1 to 3). `grep` finds no `HZ_TUI_MODE`, `alt_screen`, `--fullscreen` or `--minimal` in `app/src`. R1 to R12 are DESIGN ONLY; docs/13 has a per-rule status table (read it first: it lists which rules are met, partial or not implemented, and two design rules, R40 and R45, that CONTRADICT shipped behaviour and need a ruling before anyone "fixes" either side).
- **Why deferred.** It is a rewrite of `interactive.ts`, not polish: its own line editor, a layout engine, hit-testing, a VT-emulator test harness. `research/grok-tui-deep.md` section 11 prices the nearest rewrite at 2.5k to 4k lines of TypeScript and recommended NOT doing it until the readline path is exhausted. Its recommended successor is Grok's MINIMAL-mode architecture (pinned viewport, commit frontier, print-once scrollback), not the fullscreen pane.
- **Upstream reference (adapt; Rust on ratatui cannot be reused; oh-my-pi's `packages/tui` is TypeScript and MIT, so its design is the closest model).** [`crates/codegen/xai-ratatui-inline/README.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-ratatui-inline/README.md), [`xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs), [`app/terminal_restore.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/terminal_restore.rs), [`app/app_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/app_view.rs), [`codex-rs/tui/src/custom_terminal.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/custom_terminal.rs), [`codex-rs/tui/src/tui.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/tui.rs), [`docs/tui-core-renderer.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/tui-core-renderer.md). Mode switch: [`xai-grok-pager-minimal/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/lib.rs). Detail notes: `docs/13-tui.md` D1 (renderer) and D2 (relaunch); research [`research/grok-tui-deep.md`](research/grok-tui-deep.md).
- **Suggested design.** Recommended order: first the scrollback-native inline-viewport rewrite (own stdin and line editor, pinned live region, commit frontier; it removes the readline limits behind the popup dropdown, composer features and the D18(h) echo bug and keeps native selection), and only then a true alternate-screen mode. Steps for fullscreen: `ScreenMode` resolved once in `main.ts` (flag, `HZ_TUI_MODE`, config, TTY); a pure `cellbuffer.ts` with `diff(prev,next)` golden-tested without a terminal (this is also the R12 render probe); a single `EscapeWriter` queue with idempotent terminal restore on SIGINT, SIGTERM, SIGHUP, exceptions and exit; reuse `cards.ts`, `markdown.ts`, `diff.ts`, `style.ts` as cell producers; keyboard only first, behind `HZ_TUI_MODE=fullscreen`; scrollback stays the default until the PTY harness (docs/13 D12) can drive both. Mode switch by relaunch (D2).
- **Files to touch.** New `app/src/tui/screen.ts`, `cellbuffer.ts`, `escape-writer.ts`; `app/src/main.ts`; `app/src/tui/interactive.ts` (split chat loop from readline front); `app/src/tui/live.ts`; tests under `app/tests/tui/`; `docs/13-tui.md`; `docs/28`.
- **Priority.** P3 (large; a product decision).
- **Acceptance.** Cell-diff goldens without a terminal; a PTY test that enters and leaves the alternate screen on every exit path (including SIGHUP and a thrown error) and restores the cursor, paste mode and raw mode; non-TTY output unchanged (`plain-events.expected.txt`).

### 5.18 TUI part 3 known gaps (docs/13)

Each is small; the full list with the fix for each is `docs/13-tui.md` deferral note D18 (and D6, D10).

| Gap | Detail and suggested fix | Files |
|---|---|---|
| Readline echoes the pressed `y` inside the approval card before the line is wiped | Cosmetic; safety unaffected. Fix: pause the readline output stream while the card owns the cursor (`rl.pause()`, write the card, `rl.resume()`), test with the PTY harness. Adapt from Grok [`views/permission_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/permission_view.rs) (behaviour only) | `app/src/tui/approval-card.ts`, `app/src/tui/interactive.ts` |
| Ghost text and its room check use string length, not display width | Wide (CJK, emoji) paths can mis-place the suppress threshold. Fix: use a `visibleWidth` helper in `completion.ts` | `app/src/tui/completion.ts` |
| C1 control bytes (0x80 to 0x9f) are not stripped by `sanitizeText` | Pre-existing; 8-bit terminals might interpret them. Fix: drop U+0080 to U+009F | `app/src/tui/render.ts` |
| Bracketed paste of a single line without a trailing newline leaves the collector armed until the next Enter | The paste is then submitted together with later typing. Fix: arm a 50 ms timer on `paste-start` that flushes a newline-free collector | `app/src/tui/paste.ts` |
| `/theme` is session-scope only | `HZ_THEME` remains the startup knob. Fix: persist the choice under the user config dir (docs/13 D10) | `app/src/tui/style.ts`, `app/src/core/config.ts` |
| No popup completion dropdown; Tab lists matches via readline | Needs a redraw region above the prompt and a measured resize story. Adapt Grok [`views/slash_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs) and [`views/completion_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs) (docs/13 D6) | `app/src/tui/completion.ts`, `app/src/tui/live.ts` |
| Thinking display not tested against a real reasoning provider | Needs a key. Record a real session once and add it as a fixture | `app/tests/tui/thinking.test.ts` |
| `Worked for` turn footer wording, `/verbose` toggle for nested subagent lines, `callId` on `subagent.start\|end` | Optional polish (D18 a, b, c). Grok [`views/turn_status.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/turn_status.rs). `callId` is an additive contract field | `app/src/tui/render.ts`, `app/src/contracts.ts` (additive) |
| Status line `used / window` with a contextual hint segment | docs/13 D14; docs/30 section 5.12 | `app/src/tui/live.ts` |

- **Priority.** P2 for the safety-adjacent rows (paste timer, C1 strip), P3 for the rest.
- **Acceptance.** Each fix has a unit test in `app/tests/tui/` (paste, completion, render, approval-card); the non-TTY golden is unchanged.

### 5.19 Design-only fullscreen keymap, command palette and mouse rules

- **What.** Everything in docs/13 sections 2.3 to 2.5 that is marked DESIGN ONLY: mouse capture and hit-testing (R23 to R36), keymap registry with a precedence stack, presets and a keybindings file (R37 to R52), slash registry and command palette (R53 to R62). Shipped: a static `/help` table and Tab completion; three raw key listeners in `interactive.ts`.
- **Why deferred.** These only make sense with a fullscreen pane (5.17). In scrollback mode the terminal owns the wheel, selection and copy, which is the feature scrollback users want; enabling mouse capture would break native selection (R5).
- **Upstream reference (adapt the algorithms and the SHAPE of the schema, do not copy Rust).** Mouse: Grok [`app/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/mouse.rs), [`app/x10_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/x10_filter.rs), [`app/csi_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/csi_filter.rs), [`xai-grok-pager-render/src/input/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/mouse.rs), [`render/scrollbar.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/scrollbar.rs). Keymap: opencode [`packages/tui/src/config/keybind.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/config/keybind.ts); codex [`codex-rs/config/src/tui_keymap.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap.rs), [`tui_keymap_chord_tests.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap_chord_tests.rs); Grok [`actions/defaults.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/actions/defaults.rs), [`actions/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/actions/mod.rs), [`app/agent_view/key_owner.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs). Palette: Grok [`slash/registry.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/registry.rs), [`app/command_catalog.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/command_catalog.rs), [`slash/commands/help.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/help.rs); opencode [`packages/tui/src/component/command-palette.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/command-palette.tsx); codex [`codex-rs/tui/src/bottom_pane/slash_commands.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/slash_commands.rs). Detail notes: `docs/13-tui.md` D3 (mouse), D4 (keymap), D5 (slash registry and palette).
- **Suggested design.** Do the cheap, mode-independent piece first: a `slash-registry.ts` table (`SlashCommand { name, aliases, description, args, availability }`) that `completion.ts`, `/help` and custom commands all read (removes the duplicated list in `interactive.ts`). Then `keymap.ts` with `ActionDef { id, description, default, contexts }` and chord parsing, porting the three raw listeners to registered actions; a workspace keybindings file may only NARROW and may not shadow `Ctrl+C` or approval keys (R47). Mouse (pure SGR/X10 parser with a fuzz test, hit-test over cached rects, wheel, scrollbar, selection, OSC 52 copy) only inside fullscreen. Decide R40 (Esc cancels a turn today) and R45 (two-step Ctrl+C today) in a docs/28 ruling when the keymap lands.
- **Files to touch.** New `app/src/tui/slash-registry.ts`, `fuzzy.ts`, `keymap.ts`, `keymap-presets.ts`, `mouse-parse.ts`, `hit-test.ts`, `selection.ts`; `app/src/tui/interactive.ts`, `completion.ts`; `app/src/core/commands.ts`; `app/src/main.ts` (`keybind` subcommand); `ops/gate-catalogue.md` (a gate row when a keymap spec exists); tests under `app/tests/tui/`.
- **Priority.** P3 (the slash-registry piece alone is P2).
- **Acceptance.** `/help`, Tab completion and the palette list exactly the same commands (one test); a fuzz test that a non-mouse byte stream is never swallowed; a duplicate or unknown keybinding fails `hzcode keybind check`.

---

## 6. Known gaps and open items (not features)

1. **No `LICENSE` or `NOTICE` file in the tree.** The README licence section says "Not yet chosen". Some rows were written as verbatim or near-verbatim ports of small upstream constants and strings, which may carry attribution duty (Apache-2.0 for codex, MIT for cline, oh-my-pi, opencode, deepseek-harness; grok-build has its own LICENSE): codex code points, the oh-my-pi fuzzy-matching constants and `skipShellWord`, the deepseek-harness repeat-tool reminder text and sandbox marker strings, the cline `apply_patch` fuzz costs. The owner must choose a licence, add `LICENSE`, and add a `NOTICE` that lists these rows (docs/08 to docs/10 Provenance tables mark each as `adapted` or `verbatim`). Any future snapshot of third-party data (5.7) also needs a NOTICE line.
2. **Hook trust gate is open (docs/15 H1, design rule H7/D31).** A cloned repository can name a hook program in a workspace `hooks.json` and it runs with the user's authority; the only mitigation is the spawn ledger row, which records but does not prevent. This is the most important open authority gap. Interim fix is cheap (ignore the workspace hooks file unless the user config lists the workspace path in `trustedWorkspaceHooks`, print one notice); full form is a `trust.json` binding the file digest to a user decision (adapt Grok [`xai-grok-hooks/src/trust.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-hooks/src/trust.rs), [`discovery.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-hooks/src/discovery.rs)). Files: `app/src/core/hooks.ts` (`loadHooks`), new `app/src/core/trust.ts`, `app/src/core/config.ts`, new `app/tests/core/hooks-trust.test.ts`. Priority P0. The same trust store is needed for workspace skills with scripts, workspace MCP servers and workspace providers.
3. **Event type names versus the `hz.*` catalogue (docs/06 J4).** The code emits 20 dotted names (`session.start`, `session.end`, `session.fork`, `message.start`, `message.end`, `tool.call`, `tool.result`, `approval.request`, `approval.decision`, `receipt.issued`, `error`, `session.compaction`, `hook.decision`, `hook.failure`, `run.pending_todos_reminder`, `run.unverified_completion`, `rewind.plan`, `rewind.apply`, `rewind.conversation`, `plan.apply`); the document specifies 44 `hz.*` names; the kernel accepts any non-empty type. `message.delta` is defined but never emitted. Recommended: keep the shipped names, record the mapping in `docs/_conventions.md` as a ratified RC, and add a test that every emitted type is in the catalogue (`app/tests/core/event-catalogue.test.ts`, new). That is a ruling for the human owner.
4. **Stale module header in `app/src/core/checkpoints.ts`.** It still says conversational rewind does not exist, but the runtime wires `truncateMessages` into `rewindTo` (docs/12 F2). A code-only comment fix; update the residuals paragraph to match `app/src/core/index.ts`. Also: a checkpoint whose append failed is memory-only for this process (retry once and surface a notice).
5. **JSONL appends are not fsynced.** SQLite commits are durable (`synchronous=FULL`) and file replacements use temp file, fsync and rename (`atomic-write.ts`), but kernel and TypeScript JSONL appends (events, receipts, spawn ledger, change journal, checkpoints) are single `O_APPEND` writes with no fsync: safe against a process crash, not against power loss; a torn final line is skipped and reported by readers. See docs/12 F10 (durability measurement) before claiming otherwise.
6. **Docs/28 PR #26 and PR #27 verification.** The merge commits are not in this branch's history. Check the PR numbers, titles and commit ids of the second and third forgecode batches (and PR #28's number) against GitHub and fix `docs/28`, `docs/30` section 0.2 and section 4 of this file if they differ.
7. **The `gh` CLI could not reach the remote** in the session that wrote this file, so open pull requests were not listed or merged. A human (or an agent with a working remote) must create the pull request for `docs/handoff` and, if asked, merge the stack. Do not push to `main` directly.
8. **Prompt golden, tool-schema snapshot and plain-output golden are tests that read docs and fixtures** (section 2.5). A "docs only" change to those places can fail `bun test`.
9. **Event log and receipts are tamper-evident, not tamper-proof.** Without `HZ_ANCHOR_KEY`, anyone who can write the files can rewrite the whole chain (README and docs/11 say so). Keep that wording.
10. **Subagents.** Delegation depth is 1; the generic child holds only the base seven tools; the delegation-scope wording from the DeepSeek harness is not verified in the child prompt (docs/08 Provenance).
11. **Markdown tables in docs:** a pipe inside a cell must be written `\|` (GFM), or the row breaks. Several rows in docs/30 use it.
12. **Two repositories' evidence is second-hand.** aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 were not cloned in the sandbox; their findings come from `docs/audit/pass2` and `pass3` and no file path can be verified. The claude-code pin holds docs, examples and plugins, not the agent source (`research/upstream-pins.md`). Treat unverified claims as leads.

---

## 7. Where the research lives

All research notes are in `docs/research/` (imported from earlier read-only studies of the upstream repositories). Every verified upstream path inside them is a blob link at the pinned commit. [`research/README.md`](research/README.md) explains the link conventions and lists the files.

| File | Use it for |
|---|---|
| [`research/README.md`](research/README.md) | How to read the links; table of the files; where the findings landed |
| [`research/upstream-pins.md`](research/upstream-pins.md) | THE pin table: clone name, GitHub repo, full SHA, URL base for the 8 cloned repos (claude-code, cline, codex, deepseek-harness, forgecode, grok-build, oh-my-pi, opencode); URL patterns; the list of repos that were not cloned and their unconfirmed owners. Use it for every new upstream link |
| [`research/horizoncode-baseline.md`](research/horizoncode-baseline.md) | What HorizonCode claimed before the steal waves; the status ladder; the first steal list; rules of engagement |
| [`research/steal-opencode-cline.md`](research/steal-opencode-cline.md) | Wave 1: opencode edit tool and provider handling; cline hooks, trackers, command guard, apply_patch; ~20 numbered actions |
| [`research/steal-ohmypi-codex.md`](research/steal-ohmypi-codex.md) | Wave 1: codex and oh-my-pi (compaction prompts, apply_patch seek, guardian, LSP, edit ladder thresholds); what NOT to copy |
| [`research/steal-grok-claude-deepseek.md`](research/steal-grok-claude-deepseek.md) | Wave 1: DeepSeek harness, grok-build (egress, hashline, multi-dialect tools, dream memory), Claude Code (hooks, permissions) |
| [`research/compare-cline-claude.md`](research/compare-cline-claude.md) | Strict comparison of cline and Claude Code with a superset absorption plan |
| [`research/compare-codex-grok.md`](research/compare-codex-grok.md) | Strict comparison of codex and grok-build: sandbox and approval policy, unicode-fold rung, memory section 2.4 |
| [`research/compare-ohmypi-deepseek.md`](research/compare-ohmypi-deepseek.md) | Strict comparison of oh-my-pi and the DeepSeek harness: edit ladder thresholds, LSP writethrough, hooks and plugins |
| [`research/compare-providers.md`](research/compare-providers.md) | The provider superset spec: opencode lifecycle, oh-my-pi catalogue and compat rules, models.dev, auth and OAuth shapes, evidence index (section 5.4 is the models.dev snapshot) |
| [`research/forgecode-deep.md`](research/forgecode-deep.md) | forgecode deep dive: takes T-1 to T-20 (section 2.2), not-worth list (2.3), quality practices (3), README analysis, what HorizonCode must NOT claim |
| [`research/grok-tui-deep.md`](research/grok-tui-deep.md) | Grok Build TUI analysis: transcript cell formats, minimal mode, PTY harness; the source for TUI parts 2 and 3; section 11 prices the fullscreen rewrite |

Other evidence: `docs/30-steal-list.md` (ranked list, every row with an Upstream URL and Status; section 7 is the generated open-work register of 123 deferred or partial rows), `docs/29-final-audit.md` and `docs/audit/` (historical, file-cited audit reports; the repos listed as not cloned live only here), and the Provenance sections at the end of docs 06 to 16 (shipped file, upstream URL, relation: adapted, verbatim, idea only or original).

---

## 8. First-hour checklist for the next agent

1. `git status` and `git log --oneline -10`; confirm the branch and that `app/bun.lock` is clean.
2. Read `CURRENT_RUN.md` section 5.0, `docs/28-implementation-status.md` (rulings 38 to 91 at least), and this file's sections 3 and 5.
3. Build the kernel in the foreground (`cd kernel && CARGO_HOME=... cargo build --release --locked`), then `cd app && bun run typecheck && bun test`; expect 1792 pass / 8 skip as root.
4. Run `bash ops/gates.sh`; expect 8 of 8.
5. Pick from the backlog by priority: P0 hook trust gate (section 6 item 2), then 5.11 (request dump and hygiene evals), 5.3 (confinement helper), then the P2 items.
6. For each change: code, tests, docs/28 ruling or level, docs/30 Status cell, the design-doc deferral note, and this file's entry, in one commit. No em dashes. Stage files by name. Open a pull request; do not push to `main`.
