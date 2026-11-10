# HorizonCode — Current Run State

> **Read me first.** This is the state-of-repo document: what is implemented, how it was verified, and what remains. Snapshot: **2026-11-09, integration branch `integration/superset`** (twelve feature branches merged on top of `main` @ `cda913b`, PRs #1-#6 merged, #4-#6 only into `fix/typecheck-and-gate`; #7-#15 open). Repo: `github.com/sarv-projects/HorizonCode`. Status ladder used throughout: DESIGNED, CODE_PRESENT, WIRED, TESTED, VERIFIED. Nothing is RELEASED.
>
> **TL;DR (2026-11-09).** The twelve open feature branches (provider superset, safety rails, apply_patch routing, edit-engine superset, server mode + rewind, OS-sandbox seams, PTY exec, LSP loop, hooks lifecycle, tool exposure + turn diff, speculative execution + guardian, AST tools) are merged into one integration branch. Measured on that branch: **`bun run typecheck` 0 errors; `bun test` 1334 tests across 113 files: 1334 pass / 0 fail as a non-root user (uid 1000), 1326 pass / 8 skip / 0 fail as root** (the 8 chmod-based tests skip where permission bits do not bind; rulings 39, 51); **`cargo test --locked` 49 + 50 pass, 0 fail, as root and as uid 1000; `hz-kernel --selftest` `SELFTEST OK (25 checks)`**; **`bash ops/gates.sh` 7/7 as root and as uid 1000** (measured with `setpriv --reuid=1000`, see §4). The first hosted CI run failed 4 host-dependent sandbox tests; they exposed a real overclaim in `sandbox.report`, now fixed (§5.0, `docs/28` ruling 44 correction and ruling 51). One interaction bug was found and fixed during integration (`33e8e29`). The `docs/28` rulings are renumbered 39-49 into one ascending run. Open work is named in §5, including the done / partial / not-started table.
>
> *Previous snapshot (2026-11-08), kept for history:* **TL;DR — the v0.1 vertical slice is complete and green; V2 adoption is underway; the design corpus is not frozen; per `docs/25` no roadmap phase has formally exited (M1 exit requirements remain open work — recorded, not papered over).** The v0.1 product, the deep test suite and all four V1 features (skills, subagents, Code Mode, preview servers) are implemented, tested and pushed; the design corpus (docs 00–30) is ratified through RC-17. Landed 2026-11-07, in order: the trust-hardening pass + docs pass-5 + RC-16; **V2 waves 1–5** (NF-072 batches, NF-073 rails, NF-069/052 edit ladder, NF-074 context-cost contracts, B-1 repo_map); **waves 6–7** (hostile-read hardening, H-7 metric contract, docs/05 D40 canonical numbers + internal capability IDs); **wave 8** (NF-071 managed runtime); **wave 9** (R1 guard precedence + keyed anchors); **wave 10 — the audit-response wave** (protected kernel state, an admission for every tool, no parent leases in subagents, full-intent approvals, shell exclusivity, WAL+FULL pragmas, keyed Code Mode frames); **wave 11** (canonical `.hz/` state paths with `.hzcode/` legacy in place — RC-17; NF-075 growth-loop v1; evals-from-post-mortems with answer isolation); and **wave 12 — the distrust-reaudit response**: four independent adversarial audits (trust/authority, docs-honesty, hostile robustness, performance/Rust-rewrite) plus a competitive viability audit were run by fresh agents on 2026-11-08, every confirmed finding is closed or recorded, and the release-blocking set is empty. Authority hardenings: symlink-lexical state protection, effect-time descriptor verification (write/edit), owner-scoped leases, exact-command `always` grants, fail-closed policy loading, unknown-kind refusal, caller-lease provenance. Runtime/store hardenings: CRLF/bidi-safe minimiser with raw spills, quote-correct `cat` interception, wrapper-aware blocklist, frame-glue-free bounded Code Mode buffers, edit stale-preimage, preview confinement + process-global lifecycle, DB quarantine, 0600/0700 everywhere, torn-ledger reporting, descendant tree-kill — and the kernel append tail cache (**p50 0.53–0.6 ms flat at 2.2 k and 20 k records**, was ~8 ms at 2.2 k; truncation/tamper semantics bit-exact). Audit-trail integrity: event/receipt/transcript write failures now force a run off `succeeded`. Latest green run (integrator, frozen tree): **`bun test` 709 pass / 0 fail (60 files)**, **`cargo test` 43 tests (9 unit + 34 integration)**, **`hz-kernel --selftest` OK (18 checks, hermetic scratch — bare runs repeat)**, **`ops/gates.sh` 6/6**. Open items are named, not implied — `docs/audit/triage-external-review-2026-11-07.md` §6 with closure postscripts §7–§8 (one-use lease consumption and kernel-issued tokens CLOSED there — rulings 32 and 29): receipt postimage / the durable transcript-kernel bridge; the kernel-absent fail-closed posture (ruling needed); the TUI workstream. `docs/audit/reaudit-2026-11-08.md` §6: OS-level sandbox for Code Mode/shell (NF-016) is the top open authority item (no `bwrap`; unprivileged userns blocked; Landlock is the candidate); `setsid` kills, the non-policy hardlink class, legacy owner-less leases, the stdio-transport child check. `docs/audit/competitive-viability-audit-2026-11-08.md` §7: the parity roadmap (compaction + usage meter, memory files, MCP/hooks/LSP, rewind, provider breadth, benchmarks, repo_map cache, server mode). The `docs/30` §4 queue continues with the **item 8 remainder** (test-model-in-library) and the item 7 reduced-form leftovers. **Wave 13** added project memory (the AGENTS.md/ZH.md hierarchy), the eval runner (`bun run eval`, scripted test model in-library), and closed the last half of the external review's finding 4 — one-use leases + session grants (ruling 32); 709 tests / 0 fail (60 files), gates 6/6.

---

## 1. What HorizonCode is (30-second primer)

A **chat-first AI coding agent** for the terminal: a human runs `hzcode`, types natural language into a chat bar, and the agent works in their repo. Eighteen registered tools (`app/src/tools/index.ts`): `read write edit grep glob shell todo` (the base seven) + `undo`, `repo_map`, `agent`, `code_mode`, `preview` + (integration branch) `apply_patch`, `shell_session` (interactive PTY), `lsp`, `tool_search`, `ast_search`, `ast_edit`. Some are Deferred or model-routed (see `docs/09` §2.4.1 and the routing table), so a given model sees fewer.

Two-language trust stack:

```
   terminal                 the human
      |  chat
   app/src/tui  ----------> app/src/core (Bun/TS runtime)
      |                         |  agent loop: provider -> guard -> tools -> receipts
      |                         v
      |                      app/src/tools  (18 tools, guard-aware)
      |                         |
      |                         v
      +-- bin/hzcode       kernel/  (Rust `hz-kernel`)
                               hash-chained event log + receipt chain + guard policy
```

- **`app/src/contracts.ts` is LAW** — canonical-JSON + sha256 rules, event envelope, the 8-method NDJSON kernel protocol, every interface. Rust and TS interop byte-for-byte; wave 12 added no contract changes (all hardening is internal to `guard.rs`/`kernel.ts`/`loop.ts`/tools/stores).
- **Kernel** (Rust): append-only chained event logs per stream, chained receipts, guard decisions (precedence `deny > lease > ask > allow` per `docs/11` R1 — shipped wave 9; leases owner-scoped since wave 12; structural kernel-state protection wave 10, symlink-lexical + fail-closed policy since wave 12; optional keyed anchors via `HZ_ANCHOR_KEY`; warm tail cache on append).
- **Runtime** (Bun): byte-identical TS fallback when the Rust binary is missing — `kernelMode: trusted | untrusted`.
- **TUI**: chat-first charter — no subcommand menus; every capability reachable by conversation; headless mode for scripts/tests.

---

## 2. What is implemented and verified

Every row below is backed by commands the integrator ran in this workspace (methodology in `docs/28-implementation-status.md`, which matches this table).

| Area | Status | Evidence |
|---|---|---|
| Rust trust kernel + protocol | **VERIFIED** | `cd kernel && cargo test` (49 + 50 green on the integration branch, root and non-root; 43 at the previous snapshot) + `--selftest` → `SELFTEST OK (25 checks on the integration branch; 18 at the previous snapshot)`, hermetic scratch; wave-12 kernel work: symlink-lexical state-dir walk, lease owner scoping, unknown-kind refusal, fail-closed policy loading (malformed rules; `nlink > 1` refusal), warm append tail cache; wave 13: one-use lease consumption + `guard.grant` session grants (ruling 32) |
| Contracts / Rust<->TS hash interop | **VERIFIED** | both directions verify each other's files (`log.verify`/`receipt.verify` → ok) |
| Runtime core (loop, guard gate, sessions, providers, budget rails, output budget) | **VERIFIED** | `bun test tests/core` (23 files, incl. NF-073 rails, NF-074 output budget, the wave-10 audit-response suite, the wave-11 suites, and the wave-12 kernel-hardening / logging-hardening / durability-perms suites); live e2e `printf 'list files' \| ./bin/hzcode` → tool card + receipt; `kernelMode=trusted` |
| Providers (Anthropic/OpenAI SSE + mock) | **VERIFIED** | `bun test tests/providers` → 72 pass; two fixes (empty `arguments`) |
| Tools (base 7 + repo_map/agent/code_mode/preview = 11) | **VERIFIED** | `bun test tests/tools` (13 files); `shell.ts` detached process-group + drain fix; `shell` is an `exclusive` batch class since wave 10; wave-12 tools-hardening suite (minimiser CRLF/bidi, cat quoting, wrappers, Code Mode frames, edit preimage, preview confinement, TOCTOU write/edit, the code_mode approval e2e) |
| **Tool batch scheduling** (NF-072 + wave 10) | **VERIFIED** | `bun test tests/core/batch.test.ts`; two shared reads overlap; two `sleep 0.4` shell calls serialize (marker order, 1353.63 ms); `docs/28` §1 + rulings 14, 24 |
| **Loop safety rails** (NF-073) | **VERIFIED** | `bun test tests/core/rails.test.ts` → 11 pass; live: `HZ_MAX_STEPS=1` → budget notice + **exit 5**; `--max-steps 0` → exit 0; `--max-steps nope` → exit 2; `docs/28` §1 + ruling 15; acceptance `docs/24` §12.2 #65 |
| **Edit-application ladder** (NF-069/052, A-1…A-5) | **VERIFIED** | `bun test tests/tools/edit-ladder.test.ts` → 12 pass incl. byte-identical error fixtures; wave 12 adds the stale-preimage refusal before any write; `docs/28` §1 + ruling 16 |
| **Context-cost contracts** (NF-074) | **VERIFIED** | 24 tests (`tests/core/output-budget.test.ts` + `tests/tools/shell-minimiser.test.ts`); live: capped output for the model, full text spilled to `<state-root>/spills/<sha256>.txt` (RC-17), receipt digests the **full** output; `docs/28` §1 + ruling 18; acceptance `docs/24` §12.2 #66 |
| **CI gate runner** (`ops/gates.sh`) | **VERIFIED** | `bash ops/gates.sh` → 6/6 green, exit 0; catalogue honest (all 18 `docs/24` §3.5 gates `declared-gap`); hosted wiring: `bash ops/install-ci.sh` (needs a token with `workflow` scope) |
| **Repo-map tool** (`repo_map`, B-1) | **VERIFIED** | `bun test tests/tools/repo-map.test.ts` → 13 pass (personalised PageRank, binary-search budget, byte-stability); `docs/28` §1 + ruling 19 |
| **Managed runtime v1** (NF-071, wave 8) | **VERIFIED** | `bun test tests/core/managed-runtime.test.ts tests/core/spawn-lint.test.ts tests/core/session.test.ts` → 20 pass; live: owner SIGKILL → worker tree gone (test asserts ≤5 s); wave 12: torn-tail ledger reporting + descendant tree-kill on ledger failure; `docs/28` §1 + ruling 22 |
| **Audit-response wave** (wave 10) | **VERIFIED** | protected kernel state, admissions for every tool, intent-bound approvals, subagent lease removal, shell exclusivity, WAL+FULL pragmas, keyed Code Mode frames; `bun test tests/core/authority-response.test.ts`; `docs/28` §1 + rulings 24–25; triage §6 |
| **Wave 11** (canonical state paths · NF-075 growth loop · item-8 evals) | **VERIFIED** | `bun test tests/core/state-paths.test.ts tests/core/growth-loop.test.ts tests/core/postmortems-evals.test.ts` → 8 + 29 + 15 pass; fresh-workspace smoke via the trusted Rust kernel wrote `<ws>/.hz/state/kernel`; `docs/28` §1 + rulings 26–28, RC-17 |
| **Wave 12** (the distrust-reaudit response) | **VERIFIED** | authority (symlink-lexical walk, effect-time descriptor verification, owner-scoped leases, exact-command grants, fail-closed policy, provenance), runtime/stores (minimiser, Code Mode frames + bounds, edit preimage, preview confinement + global close, DB quarantine, 0600/0700, torn ledger, admission collisions, tree-kill), audit-trail integrity (failures force non-succeeded exits), kernel tail cache; `bun test` 607/0/48; `cargo test` 9+31; selftest 18; gates 6/6; records: `docs/audit/reaudit-2026-11-08.md`, `docs/audit/competitive-viability-audit-2026-11-08.md`; `docs/28` §1 + rulings 29–31 |
| **Wave 13** (project memory, eval runner, one-use leases) | **VERIFIED** | the AGENTS.md/ZH.md instruction hierarchy (caps, symlink refusal, no-authority framing, system rail); `bun run eval` with the scripted test model; **one-use leases + session grants** (a held lease admits one effect; `guard.grant` pre-authorises and mints a fresh bound one-use lease per covered effect — ruling 32); gate fix: kernel-selftest always rebuilds the release binary; `bun test` 709/0/60; `cargo test` 9+34; gates 6/6; `docs/28` §1 + ruling 32 |
| Chat TUI (interactive + headless) | **VERIFIED** | `bun test tests/tui` → 48 pass incl. real PTY scenarios |
| **Skills** (discovery, /activation, prompt injection) | **VERIFIED** | `bun test tests/core/skills-agents.test.ts` → 11 pass; live chat `/demo …` → `skill active: demo` |
| **Subagents** (`agent` tool, child session, no recursion) | **VERIFIED** | same suite: nested run through the real kernel, receipts + child stream verify; children carry no parent leases (wave 10; kernel-layer owner scoping since wave 12) |
| **Code Mode** (Bun JS subprocess, tool bridge, keyed control frames) | **VERIFIED** | `bun test tests/core/codemode-preview.test.ts tests/core/codemode-frames.test.ts` → 26 pass (deny/ask, receipts, timeout, abort; forged `done` is output, env key scrubbed before the program, per-run key; wave 12: frame glue, bounded buffer, truncation markers, the forged-frame battery); `docs/28` §1 + ruling 25 |
| **Preview servers** (start/stop/status) | **VERIFIED** | same suite + wave-12 tools-hardening: live URL capture, process-group kill (pid gone), env scrubbed; cwd confined to the workspace with the approval naming cwd + resolved command; **process-global registry — `close()` stops every live preview** |
| Everything else in docs 00–30 (the tool catalog in `docs/09-tools.md` §4 — authoritative — memory tiers, compaction, sandbox matrix, surfaces, governance, self-improvement, the RC-15/16/17 adoption wave) | **DESIGNED ONLY** | sequenced in docs/27 (V0–V7); adoption recorded in `docs/24` §13; queue in `docs/30` §4; roadmap priorities in the competitive audit §7 |

### Integration branch `integration/superset` (2026-11-09)

Twelve branches merged in this order with `git merge --no-edit`; every row is TESTED on the merged tree (typecheck 0 errors, the suites below green, zero new failures in the full suite).

| # | Branch (PR) | What it adds | Conflicts resolved |
|---|---|---|---|
| 1 | `feat/provider-superset` (#4, merged into `fix/typecheck-and-gate`) | fail-loud unknown provider, `Credential` contract, generic openai-compatible adapter, user provider registry, models.dev catalog seam | none |
| 2 | `feat/safety-rails` (#5, same) | loop detection (soft 3 / hard 5), mistake tracker, repeat-tool reminder, configurable bash interceptor table | none |
| 3 | `feat/apply-patch-routing` (#6, same) | `apply_patch` (GPT-5/Codex grammar), model-to-tool routing, per-model prompts | none |
| 4 | `feat/edit-engine-superset` (#7) | CRLF-safe matching, unicode-fold rung, named thresholds, richer miss feedback | `docs/28` (status row, ruling number) |
| 5 | `work/wt-server-rewind` (#8) | single-attach NDJSON JSON-RPC server mode, conversational rewind, admission recovery on open/resume | `docs/28` (rewind row) |
| 6 | `work/wt-sandbox` (#9) | kernel command allowlist, per-origin egress decider, fail-closed `SandboxMode` ladder | `docs/28` (§4 items 11/12) |
| 7 | `work/wt-pty` (#10) | `shell_session` interactive PTY tool | `tools/index.ts`, `authority-response.test.ts` |
| 8 | `work/wt-lsp` (#11) | LSP loop (guarded client, mux, write-through), `lsp` tool, fresh-only diagnostics ledger | `config.ts` (providers + lsp), `loop.ts`, `tools/index.ts`, test, `docs/28` |
| 9 | `work/wt-diag-hooks` (#12) | hook lifecycle points (H1) + H9 attributed context channel | `loop.ts` (`runToolCall` signature now carries both `ToolCallOutcome` and `hookFragments`) |
| 10 | `work/wt-tier3-tools` (#13) | tool exposure classes + `tool_search`, per-turn `turn.diff` event | `loop.ts` (`SESSION_STATE_TOOLS` union, loop detection + journal boundary), `tools/index.ts`, test, `docs/28` |
| 11 | `work/wt-tier3-exec` (#14) | speculative execution coordinator (off, not wired), advisory guardian classifier (not wired) | `loop.ts` imports, `docs/28` |
| 12 | `work/wt-tier3-ast` (#15) | `ast_search` / `ast_edit` (zero-dependency matcher) | `loop.ts` (`guardActionFor` case, a lost closing brace restored), `tools/index.ts`, test, `docs/28` |

**Interaction bug found and fixed (`33e8e29`).** Branch 3's per-model prompt resolver warns through `console.warn` on every miss; the mock model (and most models) has no template, so every headless run wrote a line to stderr and broke the "stderr is clean" contract of `tests/tui/headless.test.ts` (3 failures). The loop now passes a `warn` that drops the plain miss and surfaces a real resolution failure as a runtime notice.

**Ruling renumber map (`docs/28` §3).** Each branch numbered its rulings from 40. On the integration branch: safety rails 40 (unchanged), edit-engine superset 41 (branch: 40), command allowlist 42 (branch: 40), egress decider 43 (41), `SandboxMode` ladder 44 (42), tool exposure + `tool_search` 45 (40), turn diff 46 (41), speculative execution 47 (40), guardian 48 (41), AST tools admission 49 (40). Cross-references are fixed in `docs/28` §1 and §4, `docs/09`, `kernel/src/{egress,guard,sandbox}.rs`, and `app/src/core/{loop,speculation,guardian}.ts` plus their tests.

**Integration invariants checked.** `app/bun.lock` restored with `git checkout` after `bun install`; `.github/workflows/ci.yml` is byte-identical to `ops/ci/github-actions.yml`; `kernel/src/canon.rs` is unchanged since `cda913b`; `app/package.json` still declares no runtime `dependencies` (dev-only TypeScript tooling).

---

## 3. Git timeline (newest first)

| Commit | What |
|---|---|
| `697a193` | **docs/28 rulings renumbered 39-49** into one ascending run; cross-references fixed in docs, kernel and app comments |
| `33e8e29` | **fix:** per-model instruction miss no longer writes to stderr (headless clean channel) |
| `cb758ad`..`1fd35b1` | **Integration merges** of the twelve feature branches (§2 integration table), in order |
| `cda913b` | Merge PR #3 (kernel warm tail cache fix); `b37828f` PR #2 (typecheck + gate); `72d4815` PR #1 (steal-list second wave) |
| `b7c4646` | **V2 wave 12: the distrust-reaudit response** (49 files, +6928; authority + runtime/store hardening, audit-trail integrity, kernel tail cache; reaudit + competitive-viability records; `docs/28` rulings 29–31, gaps 10–12) |
| `0a723dd` | CURRENT_RUN refresh — wave 11 handoff |
| `6e631b9` | **V2 wave 11: canonical state paths (RC-17) + NF-075 growth loop v1 + evals from post-mortems** (28 files, +3050; docs/28 rulings 26–28) |
| `ff22b2f` | CURRENT_RUN refresh — wave 10 handoff |
| `46d30a4` | **V2 wave 10: the audit-response wave** (19 files, +1698; protected kernel state, admissions for every tool, intent-bound approvals, shell exclusivity, WAL+FULL, keyed Code Mode frames; `docs/28` rulings 24–25) |
| `2321454` | Status rectification — RC-16 references, designed-vs-shipped markers on README, docs/11 §10 over-claims downgraded (triage docs-status items) |
| `1c17308` | External-review triage record — every claim adjudicated from the tree; wave-8/9 postscript |
| `f9c3e44` | **V2 waves 8–9: NF-071 managed runtime + R1 guard precedence + keyed anchors** (27 files, +2840; rulings 12 amendment, 22–23) |
| `93da5f6` | **V2 wave 7: docs/05 D40 canonical numbers + internal capability IDs** (pass-5 C.1/C.2 closed; rulings 20–21) |
| `2200566` | Gate-catalogue count fix (wave 6b) |
| `bd4d6e0` | **V2 wave 6b: the H-7 metric-contract helper** (`app/src/core/metrics.ts`, 9 tests) |
| `c82e402` | **V2 wave 6a: hostile-read hardening** (symlink-resolved read, FIFO/socket/device refusal, 32 MiB cap; 8 fixtures) |
| `0616584` | **V2 wave 5: B-1 `repo_map` tool** (8 files, +617; 13 tests; `docs/28` ruling 19) |
| `1fd05fa` | CURRENT_RUN refresh — NF-074 wave handoff |
| `3088223` | CI payload: workflow shipped as `ops/ci/github-actions.yml` + `ops/install-ci.sh` (automation token has no `workflow` scope) |
| `5cbb4f3` | **V2 wave 4: NF-074 context-cost contracts** (10 files, +683; 24 tests; `docs/28` ruling 18) |
| `d6fbb69` | Reference-repo defect observations — 88 cited rows; closes `docs/30` §4 item 11 |
| `b2e5595` | **CI gate runner + ops tree** (pass-5 C.3): `ops/gates.sh`, honest catalogue, 6 real gates |
| `b8e7f81` | **V2 wave 3: NF-069/052 edit-application ladder** (12 tests; `docs/28` ruling 16) |
| `033b878` | CURRENT_RUN refresh — NF-073 wave handoff |
| `da48282` | **V2 wave 2: NF-073 loop safety rails** (13 files, +721; 12 tests; `docs/28` ruling 15) |
| `e35a2f0` | RC-16 ruling wave: the eight cross-document contradictions resolved across docs 03–30 |
| `0bb177a` | CURRENT_RUN refresh — NF-072 wave handoff |
| `660cf01` | Docs pass-5 record + corpus-wide repo-root path sweep (32 files) |
| `91192f3` | Docs defects: the six live audit findings fixed (11 files) |
| `7c528db` | Trust hardening: chain anchors, final kernel refusals, symlink scopes, canon parity (20 files, +843; 12 tests) |
| `f182894` | Reaudit stage-2 fix wave: 222 findings applied across docs 00–30 |
| `4d7eb89` | **V1: code mode + preview tools** (7 files, +1073; 12 tests) |
| `8005e5f` | **V1: skills + subagent delegation** (8 files, +701; 10 tests) |
| `6b86de0` | Parity: fallback `sanitizeStream` + guard `scope` default byte-identical to the Rust kernel |
| `72c12cf` / `9698361` | Core interop suites (fallback, both-direction interop, config, session); `log.read limit:0` fix |
| `ddfb261` | README status + `docs/28` status map |
| `fed0811` / `569c48a` | Handoff doc + core-suite green fixes |
| `821e8e0` | Repo hygiene: 1.5 GB `repo-tour/` moved back out; gitignore guard |
| `b11cb76` / `060eef3` | TUI suite (48) / provider suite (72) |
| `dce5287` | **v0.1 vertical slice** — kernel + runtime + tools + TUI (known-green reference) |
| `aff1352` / `10aed5c` | Design corpus 01–27 + learning synthesis |

---

## 4. Verify it yourself (copy-paste)

```bash
cd HorizonCode            # the repo root

# TypeScript: typecheck (0 errors) + full suite (1334 tests / 113 files)
cd app && bun install && bun run typecheck && bun test && cd ..
git checkout app/bun.lock # bun install may rewrite the lockfile; keep it unchanged

# Rust kernel: build, suite (49 + 50), hermetic selftest (25 checks)
cd kernel && cargo build --release --locked && cargo test --locked \
  && ./target/release/hz-kernel --selftest && cd ..

# The CI gates, one entry point (Rust, selftest, typecheck, TS suite, 3 e2e)
bash ops/gates.sh

# Budget rails: a hard stop at 1 model step, canonical exit code 5
printf 'list files\n' | HZ_MAX_STEPS=1 ./bin/hzcode; echo "exit: $?"
printf 'list files\n' | ./bin/hzcode --max-steps 0   # 0 = unlimited, exit 0

# Human path: chat works zero-config (mock provider)
printf 'hello\n' | ./bin/hzcode
```

Root-sandbox notes (measured 2026-11-09): as root, 8 permission tests are skipped (an unreadable file is readable to uid 0, so their precondition cannot be built; a behavioural probe decides, rulings 39 and 51) and `ops/gates.sh` passes 7/7. To see what a non-root CI runner sees, copy the tree to a scratch dir, `chown -R 1000:1000` it, and run the suites with `setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=<writable> CARGO_HOME=<writable> RUSTUP_HOME=<toolchain> PATH=<bun and cargo dirs> ...` (bun needs a `bunx` symlink next to it if only the bare binary is copied). If `$HOME` is read-only, `hz-kernel --selftest` cannot create its state dir: run it with a writable `HOME` (for example `HOME=$(mktemp -d)`). If `~/.cargo` is read-only, set `CARGO_HOME` to a writable path.

**Skills smoke (30 seconds):**
```bash
WS=$(mktemp -d); mkdir -p "$WS/.hz/state/skills"
printf -- '---\nname: demo\ndescription: demo skill\n---\nSay hi warmly.\n' > "$WS/.hz/state/skills/demo.md"
printf '/demo please greet me\n' | ./bin/hzcode --workspace "$WS"
# → · skill active: demo  / reply / exit 0
```

**Real providers** (the only untested-in-anger path):
```bash
export HZ_PROVIDER=anthropic HZ_API_KEY=...   # or OPENAI_API_KEY; or ~/.config/horizon/config.json
./bin/hzcode
```

---

## 5. What remains

### 5.0 Status after integration (2026-11-09), honest

Ladder: DESIGNED (in docs only), CODE_PRESENT (code exists, not called by the product path), WIRED (on the product path), TESTED (automated tests exercise it), VERIFIED (the integrator ran it end to end and saw the result). Nothing is RELEASED.

| Capability | State | Notes |
|---|---|---|
| Kernel, guard, receipts, hash-chained logs | VERIFIED | `cargo test` 49 + 50 (root and uid 1000); selftest 25 checks; e2e receipts present |
| Agent loop, budgets, format rail, batches | VERIFIED | e2e budget exit 5, usage exit 2 |
| Safety rails: loop detection, mistake tracker, repeat-tool | TESTED, WIRED | ruling 40 |
| Edit ladder superset (CRLF, unicode fold) | TESTED, WIRED | ruling 41 |
| `apply_patch` + model-to-tool routing + per-model prompts | TESTED, WIRED | fixed stderr leak `33e8e29` |
| Providers: fail-loud, openai-compatible, user registry, models.dev seam | TESTED, WIRED | live run only against NVIDIA NIM (2026-11-09); Anthropic/OpenAI own endpoints not live-tested |
| Server mode (single-attach NDJSON JSON-RPC v1) | TESTED, WIRED | single client; no UDS/TCP/HTTP, no SDKs |
| Conversational rewind + file checkpoints | TESTED, WIRED | |
| OS sandbox | PARTIAL: TESTED seams | allowlist, egress decider, `SandboxMode` ladder (rulings 42-44, 51). Capability detection exists; enforcement does not. No Landlock ruleset, seccomp filter, netns or rlimit is applied to any spawned process, so `sandbox.report` reports no dimension `enforced`, `read-only`/`workspace-write` return `SANDBOX_UNAVAILABLE` on every host, and a Landlock-capable host is reported the same fail-closed way (detection shows up as `available` / `hostCapabilities`). Before 2026-11-09 the report claimed `enforced` for detected mechanisms; fixed. No MITM/egress proxy |
| MITM / egress proxy | NOT STARTED | egress decisions are recorded, nothing intercepts traffic |
| Interactive PTY exec (`shell_session`) | TESTED, WIRED | every `write` is admitted per complete input line as `shell.exec`, CR/CRLF normalized to LF, control characters and invisible/bidi Unicode refused, writes capped at 64 lines and 64 KiB, lines capped at 4000 bytes (tty limit), and the line shown verbatim in the prompt (ruling 55; the one-shot `shell` also refuses invisible Unicode); text an approved interpreter acts on later is not inspected |
| LSP loop + diagnostics ledger | TESTED, WIRED | default off; needs a user-configured server |
| DAP (debugger) | NOT STARTED | `docs/09` lists `debug`; no code |
| Hooks lifecycle (H1) + H9 context channel | TESTED, WIRED | trust gate H7 still open |
| Tool exposure + `tool_search`, `turn.diff` | TESTED, WIRED | rulings 45, 46 |
| Speculative execution coordinator | CODE_PRESENT, TESTED | off and deliberately not wired; flag pinned inert by test (rulings 47, 65) |
| Guardian classifier | TESTED, WIRED (advisory) | `· guardian: flag - reason` line in approval prompts; `HORIZON_GUARDIAN=enforce` makes a deny refuse (ruling 60) |
| `ast_search` / `ast_edit` | TESTED, WIRED | in-tree matcher; ruling 49 |
| Multi-dialect tool sets (per-model tool shapes beyond `apply_patch`) | PARTIAL | routing table exists; only the `apply_patch` dialect ships |
| Hashline (line-hash anchored edits) | TESTED, WIRED (opt-in) | `tools/hashline.ts` (ruling 64): `read anchors:true` prints `LINE:abc:def`; `edit start_anchor/end_anchor` validates Valid/Stale/OutOfRange, recovers a unique shift within +-15 lines, rejects truncated, malformed and ambiguous anchors; default read output byte-identical; not default |
| Runtime residuals (shell pre-admission refusal, guardian fail-closed, wider accept-edits list, lazy dedup refresh) | TESTED, WIRED | ruling 66; `tests/core/runtime-residuals.test.ts` |
| Cross-process locking (sessions, checkpoints, journal) | TESTED, WIRED | `core/file-lock.ts` (ruling 63): O_EXCL lockfile + pid-liveness stale reclaim around session migration, checkpoints, journal, TS-kernel appends and per-file write/edit/apply_patch/ast_edit; two-process tests; Rust kernel appends untouched |
| Permission modes (plan / accept-edits / bypass presets) | TESTED, WIRED (no bypass, by decision) | `--permission-mode`, `/mode`, user-config `permissionMode`: default / plan / accept-edits / read-only as a layer above the kernel guard (a kernel deny always wins); prompt badge; a bypass/yolo mode is deliberately not built; rulings 58, 61 (accept-edits skips CI/hook/manifest/rc files and runs the guardian first; read-only also refuses mcp.invoke) |
| Headless `-p` with JSON output | TESTED, WIRED | `hzcode -p [text] --output-format text\|json\|stream-json`; prompt from stdin when `-p` has no text; exit via `exitCodeFor`; approvals fail closed; the line-per-message mode is unchanged; ruling 57 |
| Session fork (`/fork`, `session.fork`) | TESTED, WIRED | new session with a boundary-safe transcript copy (whole or up to a checkpoint/message index), `forkedFrom` lineage in `/sessions` and `session.list`, new kernel stream starting with a `session.fork` event (parent stream+seq); original untouched; resume works on forks. `bun test tests/core/session-fork.test.ts tests/tui/fork.test.ts`. Not done: S-46 posture narrowing, CLI verb (`docs/28` ruling 59) |
| Tool-argument JSON repair + schema coercion | TESTED, WIRED | `core/json-repair.ts` (ruling 67): syntax-only repairs counted, truncated tails refused for every side-effecting tool, receipt hashes the repaired args; `tool.card`/`tool.call` carry `repaired` |
| Tool-schema snapshot test | TESTED, WIRED | `tests/tools/tool-schema-snapshot.test.ts` vs `tests/fixtures/tool-schemas.json` (ruling 68); update with `HZ_UPDATE_TOOL_SCHEMAS=1`, never auto-accepted |
| Pending-todos re-check (one bounded re-entry) | TESTED, WIRED | ruling 69; once per run, budget and abort re-checked; `unknown` stays the terminal |
| Attempts-remaining note on failed tool results | TESTED, WIRED | ruling 70; model-facing text only, derived from the mistake tracker and format cap |
| `hzcode doctor [--json]` | TESTED, WIRED | ruling 71; diagnose-only OK/WARN/FAIL table, fix hint per problem, exit 1 on FAIL, key never printed |
| Subagent presets (planner, coder, reviewer, explorer) | TESTED, WIRED (reduced form) | `agent` takes `profile`: built-in explore/plan/code/review plus user `.md` presets, bounded by the parent's tools (`profile_ceiling_widens`); rulings 56, 61. `AgentProfileV1` schema pinning, result schemas and kernel validation stay DESIGNED (`docs/15` §2.6, §3.6). See 5.0.1 |
| Memory tiers / background "dream" consolidation | NOT STARTED | project memory files (AGENTS.md hierarchy) ship; episodic/semantic tiers and dream are DESIGNED |
| Fullscreen TUI renderer | NOT STARTED | readline chat loop ships |
| Same-model head-to-head benchmarks | NOT STARTED | eval runner ships; needs provider keys |
| Hosted CI | WIRED | runs on PR #16; the run on `72ad830` passed install + typecheck and failed 4 host-dependent sandbox tests, fixed here (ruling 51); next run not yet observed |

Flake (ruling 52): `guard_denies_writes_inside_the_state_dir_even_when_policy_allows` failed once on hosted CI for main `606f981`. Root cause is a harness race (test wrote policy.json while the freshly spawned kernel was still doing its startup policy validation, and `fs::write` is briefly an empty file). Fixed by a readiness ping in `Kernel::start_with_env` plus exit status and stderr in the early-close panic. TESTED locally only; hosted CI on main has not been seen green.

### 5.0.0 Stage 1 fixes (2026-11-09)

Also fixed: a delegated subagent's tool cards now reach the parent stream as a bounded `subagent.event` and render nested under the agent card (server mode relays them as `session.event`), and `turn.diff` is rendered at the end of a direct-edit turn (`· changed N file(s)` plus a capped diff; headless prints only the summary on stderr). `docs/28` ruling 54.

Fixed on `fix/tui-serve-subagent-and-session-gate`: `hzcode serve` now answers each request line while stdin stays open (Bun batches pipe stdin until EOF; a Worker with blocking reads feeds the server), `server.hello` reports the real kernel mode before any session, `/files` accounts for all 18 registered tools (available, deferred, hidden by routing), and every turn, plan mode included, returns an exit that the chat bar names when it is not a clean end. See `docs/28` ruling 53.

### 5.0.1 Specialised agents (planner, coder, reviewer): analysis

Kiro CLI and Freebuff/Codebuff both route work through specialised agents rather than one prompt: Freebuff's README describes file-finding agents that map the project before editing, implementation and review agents, and a cheap model (a Flash Lite tier) for specialist tasks such as file finding. HorizonCode today has one generic `agent` tool (`app/src/tools/agent.ts`: a task string and a step cap, no tool allow-list, same model, same prompt). The pieces a preset layer needs already exist: `LoopDeps.toolFilter` (per-run tool allow-list), the model-to-tool routing table, per-model prompts, the shared `BudgetLedger` per run tree, and the designed `AgentProfileV1` contract.

Recommendation: worth doing, as a small reduced form of `docs/15` §2.6 and not a new framework. (1) An optional `profile` argument on `agent` with built-in presets: `explore` (read-only tools: read, grep, glob, repo_map, ast_search, lsp; cheap model if configured), `plan` (read-only, returns a structured plan, no writes), `code` (the full tool set), `review` (read-only, returns findings with file:line). (2) Each preset is data: tool allow-list, prompt block, optional model override, step cap. It can only narrow authority, never widen it (`profile_ceiling_widens` refusal already designed). (3) User presets from `.hz/agents/*.md` front-matter later, behind the same user-config-only rule as MCP and LSP. The expected wins are a cheaper context-gathering phase, fewer unsafe writes during planning, and an explicit reviewer pass. The cost is about one tool plus a profile table and tests. Status: NOT STARTED, recorded here and in `docs/30`.

Implemented (stage 3, ruling 56): the reduced form above shipped as `app/src/core/agent-profiles.ts`. The `agent` tool takes an optional `profile` (explore, plan, code, review, or a user preset from `<user config>/agents/*.md` or `<workspace>/.hz/agents/*.md`). A preset is a tool allow-list, a prompt block, an optional model string and a step cap, and its tools must be within the parent's (not the generic child's: `code` holds more); a user preset outside that is refused with `profile_ceiling_widens`. The profile name shows under the agent card, the catalog is appended to the `agent` tool description, and the base prompt has one delegation line. Evidence: `app/tests/core/agent-profiles.test.ts`.

### 5.0.2 History


> **Wave 13 status at this handoff (2026-11-08, ~11:05 UTC): started, interrupted, and committed as a partial wave — one half green, one half unproven.** Two sub-agents were dispatched for the two smallest roadmap items and both died mid-work on provider credit exhaustion (`DeepSeek API error 402: insufficient credits`). What they left was then verified and committed: **the `repo_map` memoisation cache is complete and green** — bounded (path, size, mtime)-stamped per-file cache with 5 new tests, byte-identical output proven, and the integrator re-ran the suites on the committed tree (**612 pass / 0 fail / 48 files**). **The eval runner (`runEvalCase`/`runEvalSet` in `app/src/core/evals.ts`) is committed UNTESTED** — the agent died before writing its tests, so no test exercises the runner yet; the tree compiles and is green, but the runner is unproven. Finishing its tests to the spec (a passing case; terminal mismatch with expected/observed; a no_answer_leak violation naming the text; precondition refusals *before* the executor runs; executor failure graded not thrown; runEvalSet aggregate metric-contract-shaped; determinism) is the first task of the next session. Full task spec: `conversation://33674060-2b68-4c85-a9b3-d4407f31d0d5`. Everything below (items 1–6) is the queue after that. **(Postscript 2026-11-08, wave 14: the resume finished the eval-runner tests and closed item 8's runner half — see item 5 and `docs/28` §4; the process-memo cache described here is superseded by the persistent per-workspace `repo_map` index, in flight at the wave-14a cut.)**

1. **Real-provider last mile** — ~~first live run done (2026-11-09): NVIDIA NIM (OpenAI-compatible endpoint), headless AND interactive, both exit 0 — see item 9~~. Still open: Anthropic and OpenAI's own endpoints (the same keys gate the head-to-head benchmarks).
2. **The open authority item: OS-level confinement (NF-016).** Code Mode and shell run with the user's ambient authority (bridge-policed only); `setsid` descendants escape group kills; non-policy hardlinks rely on chain detection; non-Linux fallbacks are weaker. Environment facts (measured 2026-11-08; spike `docs/audit/landlock-spike-2026-11-08.md`, probe `ops/landlock-probe.sh`): no `bwrap`; **Landlock is not available on this deployment kernel** (`4.19.0-gvisor` — raw syscall ENOSYS, no LSM list); **correction: unprivileged user namespaces are NOT blocked here** (`unshare -U/-Ur/-Urm/-Uprf` succeed; bare `unshare -p` EPERMs). Direction (ruling 38): design the seccomp + `no_new_privs` + rlimits + netns reduced form first; the outer sandbox is the confinement of record on gVisor-class deployments; Landlock stays probe-gated. Full list: `docs/audit/reaudit-2026-11-08.md` §6.
3. **The parity roadmap** (competitive audit §7): 30d — compaction v1 + context meter ~~✓~~, eval runner + internal benchmarks ~~✓~~ (head-to-head still needs keys), project-memory files ~~✓~~, repo_map cache ~~✓ wave 14b (persistent index; 840 / 0 / 71 files; gates 6/6)~~, MCP client v1 ~~✓ wave 14~~, diff-review + plan-mode in the TUI ~~✓ wave 14~~, Landlock spike ~~✓ wave 14 (not available on this kernel; ruling 38)~~; 90d — fullscreen renderer slice, checkpoints/rewind ~~✓ wave 14c~~, LSP loop, hooks ~~✓ wave 14~~, +google/+ollama ~~✓ wave 14c~~; **provider breadth beyond the curated five (the models.dev registry) — OPEN (dispatch failed on infra credits, no files touched; item 11)**; sandbox GA; first same-model head-to-head suite; 180d — kernel-executed effects, server mode/SDK, plugins, the governance pack. Also landed early: durable change journal + crash-safe undo (wave 14, ruling 36) and the growth-loop CLI (wave 14).
4. **The external review's still-open items** (`docs/audit/triage-external-review-2026-11-07.md` §6; closure postscripts §7–§8): receipt postimage / durable transcript-kernel bridge; ~~the kernel-absent fail-closed posture (ruling needed)~~ **RULED (wave 14, ruling 33 — mode-honest, not fail-closed: the mode is first-class in `session.start` + one startup notice)**; and the fullscreen/inline TUI as a first-class workstream (`docs/13` is designed, the shipped TUI is the readline chat loop — wave 14 landed plan mode + diff review in it). CLOSED since the first writing of this list: one-use lease consumption (ruling 32, wave 13), kernel-issued tokens + owner scoping (ruling 29, wave 12), and the kernel-absent posture (ruling 33, wave 14).
5. **`docs/30` §4 queue:** item 8 closed (eval runner wave 13; test model verified in-library; non-succeeded runs record post-mortems from the loop, wave 14) except same-model head-to-head benchmarks (needs keys); item 7 closed by the `grow` CLI (wave 14: `--list`, idempotent `--from-postmortems`, guarded `--apply`; scheduling = the documented cron entry) except library consumption (applied proposals are write-only).
6. **Hosted CI needs one manual step** — `.github/workflows/ci.yml` cannot be committed by the automation identity (no `workflow` token scope). `bash ops/install-ci.sh` installs the tracked payload; commit + push it from a token that has the scope.
7. **Wave 14 is fully integrated as of wave 14c — no writers are in flight.** providers +google/+ollama and rewind/checkpoints both landed as wave 14c, including the rewind runtime seam in `core/index.ts` (every completed turn records a checkpoint; `rewindTo(n)` restores through undo's route) and the integrator test `tests/core/rewind-runtime.test.ts` (4 pass). The repo_map cache landed as wave 14b; wave 14a had excluded it while its owner was mid-work. Everything named in the wave-14a/14b/14c commits is landed and tested.
8. **Wave-14 evidence (integrator-run, 2026-11-08):** wave 14a: `cargo test` 9 + 35 green; loop-level integrations `tests/core/{hooks-loop,plan-loop,plan-apply,postmortem-loop}.test.ts` → 11 pass; the `codemode-preview` flood RSS assertion stabilized (forced GC; it had tripped an intermediate gates run). Wave 14b: repo_map persistent cache (`tests/tools/repo-map.test.ts` 25; `tests/tools/` 229; the touch-one-file test keeps byte length identical so only mtimeMs can invalidate). Wave-14 close: full suite **840 pass / 0 fail (71 files)**; `ops/gates.sh` **6/6** (rust suite, kernel selftest, ts suite, e2e headless smoke, budget rail, usage error). Rulings 33–38 written into `docs/28`; stale doc lines corrected across `docs/28`, `docs/30`, this file. **Wave 14c:** `tests/core/providers-expansion.test.ts` 19 pass (+ config/fallback 45); rewind/checkpoints 29 pass + integrator `tests/core/rewind-runtime.test.ts` 4 pass; `ops/gates.sh`'s e2e env now scrubs `GEMINI_API_KEY`/`GOOGLE_API_KEY` (a set Google key could otherwise flip the mock e2e); the junk `app<` directory (malformed tool-call parameters) removed from the repo root. **Final wave-14 close (integrator-run, 2026-11-08):** full suite **892 pass / 0 fail (75 files)**; `ops/gates.sh` **6/6** (rust-kernel-suite 17s, kernel-selftest, ts-suite 45s, e2e headless smoke, budget rail, usage error).
9. **2026-11-09 live-provider session (NVIDIA NIM) — evidence.** Provider: the OpenAI-compatible adapter against `https://integrate.api.nvidia.com` (`HZ_PROVIDER=openai HZ_BASE_URL=… HZ_MODEL=mistralai/mistral-large-4-1t-a52b`), key kept in a 0600 temp file OUTSIDE the repo (never in config, never committed). Two runs, both exit 0: (a) headless 2-turn task — `write` + `read` through the full guard/receipt path; (b) interactive pty session driven through `/model <id>` → a real task → `/context` → `/exit`. Verified artifacts in the throwaway workspaces: exact file contents; **4 hash-chained receipts** (`prevHash`/`seq` intact); **2 checkpoints** (turn 1 `changes` carries the journal entry id; turn 2 zero-change); the undo journal entry (`afterSha256`, `before: null` for a created file); the **denied `shell.exec`** (ask, nobody attached → DECLINED — and the model reported the refusal honestly instead of claiming success); the completion-evidence rail fired ("unverified completion — the model's claim, not a measured one"); `/context` → `window 131072 tok · estimated input 1913 tok (1%) · 1/80 messages`. Entitlement reality on this key: `moonshotai/kimi-k2.6` and the llama-nemotron models → HTTP 404 "not found for account"; `mistralai/mistral-large-4-1t-a52b` and `minimaxai/minimax-m3.1-flash` → 200 with `tool_calls` (probed stream and non-stream).
10. **Critical finding the live run produced (fixed in `820dcdc`): compaction destroyed context on every dispatch.** `loop.ts` called `compactHistory(history)` without its REQUIRED `{ limit }`; `compaction.ts` falls back to `limit = 1`, so every dispatch with more than one message elided the transcript down to a one-message window — both live runs printed `6 of 7 message(s) elided … window kept at 1` on a 131k-token window. Fix: `{ limit: HISTORY_LIMIT }`; full suite after the fix **892 pass / 0 fail (75 files)**. **Why it shipped: there was no typecheck anywhere** — `bun run check` is bundle-only and no tsconfig existed; the missing argument is a plain tsc error. Typecheck scaffolding is now committed (user commit `820dcdc`: `app/tsconfig.json`, `typecheck` script, dev-only typescript/@types) and is **RED: 51 errors — the next session's first fix list**, then wire a `ts-typecheck` gate. Besides the fixed bug they include real findings: `AtomicWriteOutcome.refusal` accessed on the ok branch ×6 (narrowing), `Lease.owner` ×3, `write.ts:79` arity, unchecked union properties in `loop.ts`/`grow.ts`/`curator.ts`, dead `false === true` comparisons in `providers/retry.ts` + `google.ts`, `PostmortemDetail === ""`, `Stats` imported from `node:fs/promises` ×2, and `getReader` on `number | ReadableStream` ×5 (Bun.spawn stdio typing).
11. **Provider-breadth dispatch failed on infra, not design** — the models.dev registry task died before writing anything (`DeepSeek API error 402: insufficient credits`; no files touched). The closed enum is still the live state: `HZ_PROVIDER=groq` etc. still silently falls back to mock — the top correctness item after the typecheck errors. The registry must include `nvidia` (env `NVAPI_KEY`/`NVIDIA_API_KEY`, base `integrate.api.nvidia.com`, no default model — entitlements are per-account, proven above).
12. **Deferred items — re-verified still OPEN on 2026-11-09 (greps, not memory):** conversational rewind (SessionStore has no truncation API), hooks trust gate (H7/D31 admitted in the hooks header), fullscreen renderer (no code), LSP loop (no code), server mode/SDK (no code), same-model head-to-head benchmarks (docs only), grow proposal-library consumption (the library is write-only), checkpoint compaction/cross-process locking (none), repo_map durable CAS (mtime/size equality only).
13. **Tier-3 speculative execution coordinator: primitives LANDED, NOT WIRED (`docs/28` ruling 47; branch `work/wt-tier3-exec`).** `app/src/core/speculation.ts` is a self-contained, host-injected coordinator that may run ONLY provably side-effect-free tool calls (`read`/`grep`/`glob`/`repo_map`) ahead of commit, bounded by `DEFAULT_MAX_IN_FLIGHT=2`, with sha256 fingerprints, fingerprint-mismatch discard and transitive cascade. The CLOSED effect union (`pure | local_read`) with `normalizeSpeculationEffect` is what guarantees a side-effecting tool is never speculated; the host `run` goes through the same guarded `executeTool` (with hooks skipped and `ask` declined). **NOT WIRED (primitives only).** `LoopDeps.speculativeExecution?` is declared but NOTHING in the turn path reads it: the loop never constructs a coordinator, `buildSpeculationHost` and `speculativeCandidatesFor` have no caller outside tests, and no code makes a kept speculative result replace the real `runToolCall`, so enabling the flag today changes nothing. Ruling 65 (runtime-depth FEAT-004) records why it stays unwired: no pre-commit window (the batch runs after the stream is done), a read run ahead of an earlier write in a later segment would be stale, a kept result would skip the user's `tool.pre` hook and the approval prompt, and `runToolCall` owns the exactly-once events/receipt/transcript so substitution would change the shared path. `tests/core/speculation-unwired.test.ts` pins that the flag changes nothing. The speculative host is already hardened for that: user pre/post hooks are skipped and an `ask` decision is declined without prompting (an approval request/decision event is still logged); the guard check is never skipped. Coordinator hardening: a discard issued while `run` is in flight is final (not resurrected), a throwing `run`/`validate` records `failed`, a candidate with an unknown or discarded dependency is discarded without running, and duplicate ids are rejected. No `contracts.ts` change. Evidence: `cd app && bun run typecheck` → 0 errors; `bun test tests/core/speculation.test.ts` → 22 pass; full `bun test` → 873 pass / 36 skip / 13 fail (same 13 known root-sandbox failures, zero new).
14. **Tier-3 guardian action classifier: LANDED, advisory by default; surfaced in approval prompts since ruling 60 (`docs/28` rulings 48, 60).** `app/src/core/guardian.ts`: `reviewAction` returns allow/flag/deny; `blocked` is true only with explicit `mode: 'enforce'` and a `deny` (a classifier error degrades to `flag`, i.e. fails open). `deterministicClassifier` is a rule-based advisory fallback with easily evaded patterns (not protection); `createGuardianClassifier` is model-backed only when a `GuardianModelCapability` is supplied. Host-invoked only; `guardianModeFromEnv` has no caller. review.ts and `contracts.ts` unchanged. Evidence: `bun test tests/core/guardian.test.ts` → 8 pass.
15. **Clean-runner typecheck install (found by hosted CI on PR #16).** The original PR #2 typecheck step and `gate_ts_typecheck` ran `bun run typecheck` without installing `app/` devDependencies, so on a clean runner `tsconfig.json`'s `bun`/`node` type libraries were missing (TS2688). Both CI files now run `bun install` in `app/` before the typecheck (plain, not `--frozen-lockfile`: bun 1.2.14 cannot parse the committed `bun.lock`, and a rewritten lockfile is never committed), and `gate_ts_typecheck` installs when `@types/bun`/`@types/node` is absent. Reproduced locally with `rm -rf app/node_modules`. A hosted CI run has NOT yet confirmed this green.

---

## 6. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **This sandbox (2026-11-09)** | bun 1.2.14 and cargo 1.92.0 on PATH; running as root; `$HOME` and `~/.cargo` read-only, so use `CARGO_HOME=/tmp/cargo-home` and a temp `HOME` for selftest/gates. The older `/home/forge` rows below describe the previous host. |
| **bun is NOT on PATH** | Always `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` handles it. |
| cargo | On PATH (1.99.1); crates.io works. Kernel binary: `kernel/target/release/hz-kernel` (rebuild: `cd kernel && cargo build --release`). |
| git push | Works (https, credential helper). Identity is set automatically — **never** override author/committer or git config. No force-push. The token has **no `workflow` scope**: never commit anything under `.github/workflows/` (push is rejected); ship workflows as payloads + installers instead (`ops/install-ci.sh` is the pattern). |
| Spills | Capped tool output spills its full text (pre-minimisation, raw bytes) to `<workspace>/.hz/state/spills/<sha256>.txt` (a legacy `.hzcode/` workspace keeps `.hzcode/spills`; RC-17) (NF-074; raw-spill fix wave 12); the model sees a truncation marker with the path, receipts digest the full output. |
| Runtime state | `<workspace>/.hz/state/` = `hzcode.db`, kernel log/receipts, history, skills; a legacy `.hzcode/` workspace keeps its tree in place (RC-17). All state files are 0600 / dirs 0700 since wave 12. Gitignored; deleting resets the workspace's session/trust state. The kernel state dir is structurally protected (kernel deny + TS refusal; wave-12 lexical symlink walk + effect-time verification in write/edit; residual: raw shell redirects — NF-016). |
| Keyed anchors | `HZ_ANCHOR_KEY` (hex ≥32 chars) makes every `*.head` an HMAC; `HZ_ACCEPT_LEGACY_ANCHORS=1` migrates legacy chains on the next append. Default (no key) is byte-identical legacy behaviour. |
| Sandbox environment | No `bwrap` installed; **correction (measured 2026-11-08): unprivileged user namespaces are NOT blocked here — `unshare -U/-Ur/-Urm/-Uprf` succeed; only bare `unshare -p` EPERMs (no CAP_SYS_ADMIN)**. Landlock is NOT available on this deployment kernel (`4.19.0-gvisor`, raw syscall ENOSYS — ruling 38). |
| Typecheck (2026-11-09) | `bun run typecheck` (`bunx tsc --noEmit -p app`) exists since `820dcdc` (dev-only typescript/@types in `app/package.json`; runtime stays dependency-free). **RED — 51 errors**, not yet in `ops/gates.sh`; `bun run check` remains bundle-only. The shipped `compactHistory` arity bug (item 10) is what exposed the missing step. |
| Mock provider quirks | Emits exactly ONE `glob` tool call for /list files\|what.*here\|ls\|-type messages; it does not call other tools (use the scratch suites for those). |
| Guard defaults | fs.read/write **inside workspace = allow**; outside = ask; shell.exec/net.fetch/spawn = ask; precedence `deny > held lease > grant > ask > allow` (R1, wave 9; grant tier wave 13); headless approvals auto-deny with a notice; `always` names the exact target/command (wave 12) and is a session GRANT that mints a fresh one-use lease per covered effect — a lease itself admits exactly one effect (ruling 32, wave 13). |
| `repo-tour/` | Reference clones of studied projects live at **/data/home/forge/repo-tour — OUTSIDE this repo** (a 1.5 GB copy once appeared inside; `.gitignore` now blocks it). |
| Sub-agent infra | Agents can still die mid-run (provider JWT / empty-response infra errors). If you dispatch sub-agents: clean single-escape JSON prompts, one task list per call; treat deaths as normal and resume or redo. Waves 8–12 were built by sub-agents; two report messages were lost to empty responses and the work was verified from the tree + transcripts. |

---

## 7. Rules of engagement (non-negotiable)

1. **`app/src/contracts.ts` is law.** Changes are design decisions — document them (docs + `_conventions.md`) before code. The last contract additions were additive: `Tool.concurrencyClass` (NF-072) and `RunBudget`/`RunExit` + `RuntimeOptions.budget` + `send().exit?` (NF-073); NF-074 added none, and wave 12 added exactly one additive wire field — `sessionId` on lease-mint/guard-check requests (`protocol.rs`/`kernel.ts`; an older client mints owner-less leases, documented in code); wave 13 adds exactly one additive wire method — `guard.grant` (params shape identical to `guard.lease`; an older kernel answers `unknown method`, which routes the client to the documented fallback with a notice) — everything else (admission mappings, protected-path refusal, frame-key protocol, state-path resolver, and all wave-12 hardening) is internal to `loop.ts`/`kernel.ts`/`guard.rs`/tools/stores).
2. **"Verified" means you ran it and saw the result.** Agent reports are evidence candidates, never proof. The 2026-11-08 reaudits exist because that rule is enforced, not decorative.
3. **Parallel work: one writer per file**; fence `tools/index.ts` and `core/loop.ts` to the integrator.
4. **Commit style:** concise imperative subject; body = what/why; never force-push; never touch git identity; never commit `.hz/`, `.hzcode/`, `node_modules/`, `kernel/target/`.
5. **Chat-first is the product charter:** no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.
6. **Update `docs/28` in the same commit** as any code that changes a status or count.

7. **System prompt (stage 2):** base prompt is data under `app/src/core/prompt/`; environment block rendered per request from the real tool registry; child prompt inherits instruction files. See `docs/28` item 9; the rendered static prompt is in `docs/10-cognition.md` §2.J.1.

8. **Instruction files (stage 2):** AGENTS.md, CLAUDE.md, CLAUDE.local.md, GEMINI.md, CONVENTIONS.md, copilot-instructions.md, .cursorrules, alwaysApply .mdc rules and .windsurfrules load as peers (position-major precedence, dedup, caps, symlink refusal); nested AGENTS.md/CLAUDE.md inject lazily on the system rail when a tool touches a path below them; `/memory` (`/instructions`) and `/init` added to the TUI (`/init` stages the draft in plan mode; `/changes` then `/apply`). See `docs/28` item 9a and `docs/10` R121-R123, `docs/13` §2.5.

---

*End of state document. If you are starting the next phase: begin at docs/27 (V2+) and `docs/28` §4 (gaps 10–12 carry the live queue) — or the competitive audit §7 roadmap. If you are auditing: everything claimed VERIFIED above has a copy-pasteable command in section 4 or in `docs/28`, and the 2026-11-08 reaudits are the template for how to try to break it.*

## TUI polish part 1 (feat/tui-polish)
Status line printed once above the prompt, single in-place spinner line during a turn (erased before every transcript write), shaded user block, turn footer, rich banner with tip. Verified in a real PTY (replayed through an emulator: no duplicated status lines, input not glued).

## TUI polish part 2 (feat/tui-polish)
Built (P0 + P1 of `research/grok-tui-deep.md`): colour level ladder + role table + display-width fix (`style.ts`); DEC 2026 synchronized single-write frames, pulsing glyph slower than the frame clock, narrow footer ladder, hidden cursor restored on exit (`live.ts`); pure card formatters (`cards.ts`): per-tool cards with durations, shell panel (first 2 / `… +N` / last 3), folded read-only runs, subagent start/end lines and the live `▾ Subagents N` group; zero-dep streaming markdown with code blocks, tables and a highlighter (`markdown.ts`). One additive contract field: `tool.card.detail` (durationMs, shell output/exitCode, read/grep/glob count). Non-rich output is byte-identical (golden fixture from the pre-redesign renderer). Verified: `bun run typecheck` 0 errors, full `bun test` green, real-PTY capture of read/glob/grep fold, long shell output, edit, approval, subagent and markdown answer at 100 and 60 columns, LANG=C and NO_COLOR (`.scratch/p2/`). Deferred: P2/P3 (status-line rework, completion, paste, approval card, diff gutters, thinking display, C2 subagent events, `/verbose`). Details in `docs/13-tui.md` "Part 2 polish".
