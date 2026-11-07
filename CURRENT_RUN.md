# HorizonCode — Current Run State

> **Read me first.** This is the state-of-repo document: what is implemented, how it was verified, and what remains. Snapshot: **2026-11-07, ~23:20 UTC** (product state incl. the trust-hardening pass, docs pass-5, the NF-072/073/074 waves, the NF-069/052 edit ladder, the B-1 repo-map tool, the CI gate runner, V2 waves 6a–11 — hostile-read hardening, the H-7 metric contract, canonical numbers + internal IDs, NF-071 managed runtime, R1 guard precedence + keyed anchors, the audit-response wave, canonical state paths, the NF-075 growth-loop v1 and evals-from-post-mortems — and the external-review triage). Workspace: `/data/home/forge/HorizonCode`. Repo: `github.com/sarv-projects/HorizonCode` (branch `main`).
>
> **TL;DR — the v0.1 vertical slice is complete and green; V2 adoption is underway; the design corpus is not frozen; per `docs/25` no roadmap phase has formally exited (M1 exit requirements remain open work — recorded, not papered over).** The v0.1 product, the deep test suite and all four V1 features (skills, subagents, Code Mode, preview servers) are implemented, tested and pushed; the design corpus (docs 00–30) is ratified through RC-16. Landed on 2026-11-07, in order: the trust-hardening pass + docs pass-5 + RC-16; **V2 waves 1–5** (NF-072 batches, NF-073 rails, NF-069/052 edit ladder, NF-074 context-cost contracts, B-1 repo_map); **waves 6–7** (hostile-read hardening, H-7 metric contract, docs/05 D40 canonical numbers + internal capability IDs); **wave 8** (NF-071 managed runtime); **wave 9** (R1 guard precedence + keyed anchors); and **wave 10 — the audit-response wave**, closing the 2026-11-07 external review's release-blocking findings: protected kernel state, an admission for every tool with fail-closed unmapped tools, no parent leases in subagents, full-intent approvals, shell exclusivity, WAL+FULL session pragmas, and keyed Code Mode control frames. Wave 11 closed the workspace-state naming gap (canonical `.hz/` with `.hzcode/` legacy in place — RC-17), built the NF-075 growth-loop v1 (review fork, editorial standard, curator) and the evals-from-post-mortems slice with answer isolation. Latest green run: **`bun test` 490 pass / 0 fail (44 files)**, **`cargo test` 23 integration + 5 unit**, **`hz-kernel --selftest` OK (18 checks, hermetic scratch — bare runs repeat)**, **`ops/gates.sh` 6/6**. Open items are named, not implied — `docs/audit/triage-external-review-2026-11-07.md` §6: one-use lease consumption + kernel-issued tokens; receipt postimage / the durable transcript-kernel bridge; the kernel-absent fail-closed posture (ruling needed); preview `close()`; the TUI workstream. The `docs/30` §4 queue continues with the **item 8 remainder** (the eval runner — cases are data today — and test-model-in-library) and the item 7 reduced-form leftovers (scheduling, wiring, application). RC-13 makes `docs/28` the single source of truth for implementation status.

---

## 1. What HorizonCode is (30-second primer)

A **chat-first AI coding agent** for the terminal: a human runs `hzcode`, types natural language into a chat bar, and the agent works in their repo. Ten tools: `read write edit grep glob shell todo` + `agent` (subagent delegation) + `code_mode` (JS program chaining tool calls) + `preview` (dev-server lifecycle).

Two-language trust stack:

```
   terminal                 the human
      |  chat
   app/src/tui  ----------> app/src/core (Bun/TS runtime)
      |                         |  agent loop: provider -> guard -> tools -> receipts
      |                         v
      |                      app/src/tools  (10 tools, guard-aware)
      |                         |
      |                         v
      +-- bin/hzcode       kernel/  (Rust `hz-kernel`)
                               hash-chained event log + receipt chain + guard policy
```

- **`app/src/contracts.ts` is LAW** — canonical-JSON + sha256 rules, event envelope, the 8-method NDJSON kernel protocol, every interface. Rust and TS interop byte-for-byte.
- **Kernel** (Rust): append-only chained event logs per stream, chained receipts, guard decisions (precedence `deny > lease > ask > allow` per `docs/11-authority-safety.md` R1 — shipped wave 9; leases, `policy.json` hot reload, structural kernel-state protection from wave 10; optional keyed anchors via `HZ_ANCHOR_KEY`).
- **Runtime** (Bun): byte-identical TS fallback when the Rust binary is missing — `kernelMode: trusted | untrusted`.
- **TUI**: chat-first charter — no subcommand menus; every capability reachable by conversation; headless mode for scripts/tests.

---

## 2. What is implemented and verified

Every row below is backed by commands the integrator ran in this workspace (methodology in `docs/28-implementation-status.md`, which matches this table).

| Area | Status | Evidence |
|---|---|---|
| Rust trust kernel + protocol | **VERIFIED** | `cd kernel && cargo test` (28 green: 23 integration + 5 unit) + `--selftest` → `SELFTEST OK (18 checks)`, hermetic scratch |
| Contracts / Rust<->TS hash interop | **VERIFIED** | both directions verify each other's files (`log.verify`/`receipt.verify` → ok) |
| Runtime core (loop, guard gate, sessions, providers, budget rails, output budget) | **VERIFIED** | `bun test tests/core` (20 files, incl. NF-073 rails, NF-074 output budget, the wave-10 audit-response suite and the wave-11 suites); live e2e `printf 'list files' \| ./bin/hzcode` → tool card + receipt; `kernelMode=trusted` |
| Providers (Anthropic/OpenAI SSE + mock) | **VERIFIED** | `bun test tests/providers` → 72 pass; two fixes (empty `arguments`) |
| Tools (7 base) | **VERIFIED** | `bun test tests/tools`; `shell.ts` detached process-group + drain fix; `shell` is an `exclusive` batch class since wave 10 (R-tools-39) |
| **Tool batch scheduling** (NF-072 + wave 10) | **VERIFIED** | `bun test tests/core/batch.test.ts` → 7 pass; two shared reads overlap (~377 ms for two 300 ms reads); two `sleep 0.4` shell calls serialize (marker order `firstsecond`, 1353.63 ms); `docs/28` §1 + rulings 14, 24 |
| **Loop safety rails** (NF-073) | **VERIFIED** | `bun test tests/core/rails.test.ts` → 11 pass; live: `HZ_MAX_STEPS=1` (or `--max-steps 1`) on a mock chat → budget notice + **exit 5**; `--max-steps 0` → exit 0; `--max-steps nope` → exit 2; `docs/28` §1 + ruling 15; acceptance `docs/24` §12.2 #65 |
| **Edit-application ladder** (NF-069/052, A-1…A-5) | **VERIFIED** | `bun test tests/tools/edit-ladder.test.ts` → 12 pass incl. byte-identical error fixtures; fuzzy successes name their rung; `docs/28` §1 + ruling 16 |
| **Context-cost contracts** (NF-074) | **VERIFIED** | 24 new tests (`tests/core/output-budget.test.ts` + `tests/tools/shell-minimiser.test.ts`); live: 20 KB shell output → capped for the model, full text spilled under `.hzcode/spills/<sha256>.txt`, receipt digests the **full** output; `docs/28` §1 + ruling 18; acceptance `docs/24` §12.2 #66 |
| **CI gate runner** (`ops/gates.sh`) | **VERIFIED** | `bash ops/gates.sh` → 6/6 green, exit 0; catalogue honest (all 18 `docs/24` §3.5 gates `declared-gap`); hosted wiring: `bash ops/install-ci.sh` (needs a token with `workflow` scope) |
| **Repo-map tool** (`repo_map`, B-1) | **VERIFIED** | `bun test tests/tools/repo-map.test.ts` → 13 pass (personalised PageRank, binary-search budget, byte-stability); live run ranked `app/src/core/loop.ts` first under focus; `docs/28` §1 + ruling 19 |
| **Managed runtime v1** (NF-071, wave 8) | **VERIFIED** | `bun test tests/core/managed-runtime.test.ts tests/core/spawn-lint.test.ts tests/core/session.test.ts` → 19 pass; live: owner SIGKILL → worker tree gone (~130 ms observed; test asserts ≤5 s); `docs/28` §1 + ruling 22 |
| **Audit-response wave** (external-review closures, wave 10) | **VERIFIED** | protected kernel state (kernel structural deny + TS refusal in both transports), admissions for every tool, intent-bound approvals, subagent lease removal, shell exclusivity, WAL+FULL pragmas, keyed Code Mode frames; `bun test tests/core/authority-response.test.ts` → 12 pass; `docs/28` §1 + rulings 24–25; triage §6 |
| **Wave 11** (canonical state paths · NF-075 growth loop · item-8 evals) | **VERIFIED** | `bun test tests/core/state-paths.test.ts tests/core/growth-loop.test.ts tests/core/postmortems-evals.test.ts` → 8 + 29 + 15 pass; fresh-workspace smoke via the trusted Rust kernel wrote `<ws>/.hz/state/kernel`; `docs/28` §1 + rulings 26–28, RC-17 |
| Chat TUI (interactive + headless) | **VERIFIED** | `bun test tests/tui` → 48 pass incl. real PTY scenarios |
| **Skills** (discovery, /activation, prompt injection) | **VERIFIED** | `bun test tests/core/skills-agents.test.ts`; live chat `/demo …` → `skill active: demo` |
| **Subagents** (`agent` tool, child session, no recursion) | **VERIFIED** | same suite: nested run through the real kernel, receipts + child stream verify; children carry no parent leases (wave 10) |
| **Code Mode** (Bun JS subprocess, tool bridge, keyed control frames) | **VERIFIED** | `bun test tests/core/codemode-preview.test.ts tests/core/codemode-frames.test.ts` → 24 pass (deny/ask, receipts, timeout, abort; forged `done` is output, env key scrubbed before the program, per-run key); `docs/28` §1 + ruling 25 |
| **Preview servers** (start/stop/status) | **VERIFIED** | same suite: live URL capture, process-group kill (pid gone), env scrubbed (wave 8 fix) |
| Everything else in docs 00–30 (the tool catalog in `docs/09-tools.md` §4 — authoritative — memory tiers, compaction, sandbox matrix, surfaces, governance, self-improvement, the RC-15/16 adoption wave) | **DESIGNED ONLY** | sequenced in docs/27 (V0–V7); adoption recorded in `docs/24` §13; queue in `docs/30` §4 |

---

## 3. Git timeline (newest first)

| Commit | What |
|---|---|
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
cd /data/home/forge/HorizonCode

# TypeScript suite (490 tests / 44 files)
cd app && /home/forge/.bun/bin/bun test && cd ..

# The six CI gates, one entry point (Rust + selftest + TS + 3 e2e)
bash ops/gates.sh

# Budget rails: a hard stop at 1 model step, canonical exit code 5
printf 'list files\n' | HZ_MAX_STEPS=1 ./bin/hzcode; echo "exit: $?"
printf 'list files\n' | ./bin/hzcode --max-steps 0   # 0 = unlimited, exit 0

# Rust suite (28 tests) + kernel selftest (hermetic: safe to repeat)
cd kernel && cargo test && ./target/release/hz-kernel --selftest --state-dir /tmp/hz-k && cd ..

# Human path: chat works zero-config (mock provider)
printf 'hello\n' | ./bin/hzcode

# Tool loop through the real Rust kernel, with receipts
printf 'list files\n' | ./bin/hzcode
```

**Skills smoke (30 seconds):**
```bash
WS=$(mktemp -d); mkdir -p "$WS/.hz/state/skills"
printf -- '---\nname: demo\ndescription: demo skill\n---\nSay hi warmly.\n' > "$WS/.hz/state/skills/demo.md"
printf '/demo please greet me\n' | ./bin/hzcode --workspace "$WS"
# → · skill active: demo  / reply / exit 0
```

**Real providers** (the only untested-in-anger path):
```bash
export HZ_PROVIDER=anthropic HZ_API_KEY=...   # or OPENAI_API_KEY; or ~/.hzcode/config.json
./bin/hzcode
```

---

## 5. What remains

1. **Real-provider last mile** — one live chat through each adapter (needs API keys). The adapters are pinned by canned-server tests.
2. **V2 adoption continues from `docs/30` §4** — items 1–9 are landed 2026-11-07; waves 10–11 added the audit-response wave (rulings 24–25), canonical state paths (RC-17, ruling 26), the NF-075 growth-loop v1 (ruling 27) and evals-from-post-mortems (ruling 28). Next: the **item 8 remainder** (the eval runner, test-model-in-library) and the item 7 reduced-form leftovers (scheduling, wiring, application). The external review's still-open items are named in `docs/audit/triage-external-review-2026-11-07.md` §6: one-use lease consumption + kernel-issued tokens (needs a ruling + kernel work); receipt postimage / durable transcript-kernel bridge; the kernel-absent fail-closed posture (ruling needed: fail-closed read-only, or an RC amending `docs/06`); preview `close()`; and the fullscreen/inline TUI as a first-class workstream (`docs/13` is designed, the shipped TUI is the readline chat loop).
3. **Hosted CI needs one manual step** — `.github/workflows/ci.yml` cannot be committed by the automation identity (no `workflow` token scope). `bash ops/install-ci.sh` installs the tracked payload; commit + push it from a token that has the scope.
4. **Nothing else is in flight — do not look for unfinished agent work.**

---

## 6. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **bun is NOT on PATH** | Always `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` handles it. |
| cargo | On PATH (1.99.1); crates.io works. Kernel binary: `kernel/target/release/hz-kernel` (rebuild: `cd kernel && cargo build --release`). |
| git push | Works (https, credential helper). Identity is set automatically — **never** override author/committer or git config. No force-push. The token has **no `workflow` scope**: never commit anything under `.github/workflows/` (push is rejected); ship workflows as payloads + installers instead (`ops/install-ci.sh` is the pattern). |
| Spills | Capped tool output spills its full text to `<workspace>/.hz/state/spills/<sha256>.txt` (a legacy `.hzcode/` workspace keeps `.hzcode/spills`; RC-17) (NF-074); the model sees a truncation marker with the path, receipts digest the full output. |
| Runtime state | `<workspace>/.hz/state/` = `hzcode.db`, kernel log/receipts, history, skills; a legacy `.hzcode/` workspace keeps its tree in place (RC-17). Gitignored; deleting resets the workspace's session/trust state. The kernel state dir is structurally protected since wave 10 (kernel deny + TS refusal; residual: raw shell redirects). |
| Keyed anchors | `HZ_ANCHOR_KEY` (hex ≥32 chars) makes every `*.head` an HMAC; `HZ_ACCEPT_LEGACY_ANCHORS=1` migrates legacy chains on the next append. Default (no key) is byte-identical legacy behaviour. |
| Mock provider quirks | Emits exactly ONE `glob` tool call for /list files\|what.*here\|ls\|-type messages; it does not call other tools (use the scratch suites for those). |
| Guard defaults | fs.read/write **inside workspace = allow**; outside = ask; shell.exec/net.fetch/spawn = ask; precedence `deny > lease > ask > allow` (R1, shipped wave 9); headless approvals auto-deny with a notice. |
| `repo-tour/` | Reference clones of studied projects live at **/data/home/forge/repo-tour — OUTSIDE this repo** (a 1.5 GB copy once appeared inside; `.gitignore` now blocks it). |
| Sub-agent infra | Agents can still die mid-run (provider JWT / empty-response infra errors). If you dispatch sub-agents: clean single-escape JSON prompts, one task list per call; treat deaths as normal and resume or redo. Wave 8–10 were built by four sub-agents; one report message was lost to an empty response and its work was verified from the tree + transcript. |

---

## 7. Rules of engagement (non-negotiable)

1. **`app/src/contracts.ts` is law.** Changes are design decisions — document them (docs + `_conventions.md`) before code. The last contract additions were additive: `Tool.concurrencyClass` (NF-072) and `RunBudget`/`RunExit` + `RuntimeOptions.budget` + `send().exit?` (NF-073); NF-074 and waves 8–11 added none (the admission mappings, protected-path refusal, frame-key protocol and the state-path resolver are internal to `loop.ts`/`kernel.ts`/`codemode*.ts`/`paths.ts`).
2. **"Verified" means you ran it and saw the result.** Agent reports are evidence candidates, never proof.
3. **Parallel work: one writer per file**; fence `tools/index.ts` and `core/loop.ts` to the integrator.
4. **Commit style:** concise imperative subject; body = what/why; never force-push; never touch git identity; never commit `.hz/`, `.hzcode/`, `node_modules/`, `kernel/target/`.
5. **Chat-first is the product charter:** no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.
6. **Update `docs/28` in the same commit** as any code that changes a status or count.

---

*End of state document. If you are starting the next phase: begin at docs/27 (V2+) and `docs/28` §4. If you are auditing: everything claimed VERIFIED above has a copy-pasteable command in section 4 or in `docs/28`.*
