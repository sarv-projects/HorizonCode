# HorizonCode — Current Run State

> **Read me first.** This is the state-of-repo document: what is implemented, how it was verified, and what remains. Snapshot: **2026-11-08, ~10:40 UTC** (product state incl. the trust-hardening pass, docs pass-5, the NF-072/073/074 waves, the NF-069/052 edit ladder, the B-1 repo-map tool, the CI gate runner, V2 waves 6a–12 — hostile-read hardening, the H-7 metric contract, canonical numbers + internal IDs, NF-071 managed runtime, R1 guard precedence + keyed anchors, the audit-response wave, canonical state paths, the NF-075 growth-loop v1, evals-from-post-mortems, and the distrust-reaudit response — plus the external-review triage and the four independent 2026-11-08 reaudits + the competitive viability audit). Workspace: `/data/home/forge/HorizonCode`. Repo: `github.com/sarv-projects/HorizonCode` (branch `main`).
>
> **TL;DR — the v0.1 vertical slice is complete and green; V2 adoption is underway; the design corpus is not frozen; per `docs/25` no roadmap phase has formally exited (M1 exit requirements remain open work — recorded, not papered over).** The v0.1 product, the deep test suite and all four V1 features (skills, subagents, Code Mode, preview servers) are implemented, tested and pushed; the design corpus (docs 00–30) is ratified through RC-17. Landed 2026-11-07, in order: the trust-hardening pass + docs pass-5 + RC-16; **V2 waves 1–5** (NF-072 batches, NF-073 rails, NF-069/052 edit ladder, NF-074 context-cost contracts, B-1 repo_map); **waves 6–7** (hostile-read hardening, H-7 metric contract, docs/05 D40 canonical numbers + internal capability IDs); **wave 8** (NF-071 managed runtime); **wave 9** (R1 guard precedence + keyed anchors); **wave 10 — the audit-response wave** (protected kernel state, an admission for every tool, no parent leases in subagents, full-intent approvals, shell exclusivity, WAL+FULL pragmas, keyed Code Mode frames); **wave 11** (canonical `.hz/` state paths with `.hzcode/` legacy in place — RC-17; NF-075 growth-loop v1; evals-from-post-mortems with answer isolation); and **wave 12 — the distrust-reaudit response**: four independent adversarial audits (trust/authority, docs-honesty, hostile robustness, performance/Rust-rewrite) plus a competitive viability audit were run by fresh agents on 2026-11-08, every confirmed finding is closed or recorded, and the release-blocking set is empty. Authority hardenings: symlink-lexical state protection, effect-time descriptor verification (write/edit), owner-scoped leases, exact-command `always` grants, fail-closed policy loading, unknown-kind refusal, caller-lease provenance. Runtime/store hardenings: CRLF/bidi-safe minimiser with raw spills, quote-correct `cat` interception, wrapper-aware blocklist, frame-glue-free bounded Code Mode buffers, edit stale-preimage, preview confinement + process-global lifecycle, DB quarantine, 0600/0700 everywhere, torn-ledger reporting, descendant tree-kill — and the kernel append tail cache (**p50 0.53–0.6 ms flat at 2.2 k and 20 k records**, was ~8 ms at 2.2 k; truncation/tamper semantics bit-exact). Audit-trail integrity: event/receipt/transcript write failures now force a run off `succeeded`. Latest green run (integrator, frozen tree): **`bun test` 709 pass / 0 fail (60 files)**, **`cargo test` 43 tests (9 unit + 34 integration)**, **`hz-kernel --selftest` OK (18 checks, hermetic scratch — bare runs repeat)**, **`ops/gates.sh` 6/6**. Open items are named, not implied — `docs/audit/triage-external-review-2026-11-07.md` §6 with closure postscripts §7–§8 (one-use lease consumption and kernel-issued tokens CLOSED there — rulings 32 and 29): receipt postimage / the durable transcript-kernel bridge; the kernel-absent fail-closed posture (ruling needed); the TUI workstream. `docs/audit/reaudit-2026-11-08.md` §6: OS-level sandbox for Code Mode/shell (NF-016) is the top open authority item (no `bwrap`; unprivileged userns blocked; Landlock is the candidate); `setsid` kills, the non-policy hardlink class, legacy owner-less leases, the stdio-transport child check. `docs/audit/competitive-viability-audit-2026-11-08.md` §7: the parity roadmap (compaction + usage meter, memory files, MCP/hooks/LSP, rewind, provider breadth, benchmarks, repo_map cache, server mode). The `docs/30` §4 queue continues with the **item 8 remainder** (test-model-in-library) and the item 7 reduced-form leftovers. **Wave 13** added project memory (the AGENTS.md/ZH.md hierarchy), the eval runner (`bun run eval`, scripted test model in-library), and closed the last half of the external review's finding 4 — one-use leases + session grants (ruling 32); 709 tests / 0 fail (60 files), gates 6/6.

---

## 1. What HorizonCode is (30-second primer)

A **chat-first AI coding agent** for the terminal: a human runs `hzcode`, types natural language into a chat bar, and the agent works in their repo. Eleven tools: `read write edit grep glob shell todo` (the base seven) + `repo_map` (ranked structural map) + `agent` (subagent delegation) + `code_mode` (JS program chaining tool calls) + `preview` (dev-server lifecycle).

Two-language trust stack:

```
   terminal                 the human
      |  chat
   app/src/tui  ----------> app/src/core (Bun/TS runtime)
      |                         |  agent loop: provider -> guard -> tools -> receipts
      |                         v
      |                      app/src/tools  (11 tools, guard-aware)
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
| Rust trust kernel + protocol | **VERIFIED** | `cd kernel && cargo test` (43 green: 34 integration + 9 unit) + `--selftest` → `SELFTEST OK (18 checks)`, hermetic scratch; wave-12 kernel work: symlink-lexical state-dir walk, lease owner scoping, unknown-kind refusal, fail-closed policy loading (malformed rules; `nlink > 1` refusal), warm append tail cache; wave 13: one-use lease consumption + `guard.grant` session grants (ruling 32) |
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

---

## 3. Git timeline (newest first)

| Commit | What |
|---|---|
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
cd /data/home/forge/HorizonCode

# TypeScript suite (607 tests / 48 files)
cd app && /home/forge/.bun/bin/bun test && cd ..

# The six CI gates, one entry point (Rust + selftest + TS + 3 e2e)
bash ops/gates.sh

# Budget rails: a hard stop at 1 model step, canonical exit code 5
printf 'list files\n' | HZ_MAX_STEPS=1 ./bin/hzcode; echo "exit: $?"
printf 'list files\n' | ./bin/hzcode --max-steps 0   # 0 = unlimited, exit 0

# Rust suite (40 tests) + kernel selftest (hermetic: safe to repeat)
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
export HZ_PROVIDER=anthropic HZ_API_KEY=...   # or OPENAI_API_KEY; or ~/.config/horizon/config.json
./bin/hzcode
```

---

## 5. What remains

> **Wave 13 status at this handoff (2026-11-08, ~11:05 UTC): started, interrupted, and committed as a partial wave — one half green, one half unproven.** Two sub-agents were dispatched for the two smallest roadmap items and both died mid-work on provider credit exhaustion (`DeepSeek API error 402: insufficient credits`). What they left was then verified and committed: **the `repo_map` memoisation cache is complete and green** — bounded (path, size, mtime)-stamped per-file cache with 5 new tests, byte-identical output proven, and the integrator re-ran the suites on the committed tree (**612 pass / 0 fail / 48 files**). **The eval runner (`runEvalCase`/`runEvalSet` in `app/src/core/evals.ts`) is committed UNTESTED** — the agent died before writing its tests, so no test exercises the runner yet; the tree compiles and is green, but the runner is unproven. Finishing its tests to the spec (a passing case; terminal mismatch with expected/observed; a no_answer_leak violation naming the text; precondition refusals *before* the executor runs; executor failure graded not thrown; runEvalSet aggregate metric-contract-shaped; determinism) is the first task of the next session. Full task spec: `conversation://33674060-2b68-4c85-a9b3-d4407f31d0d5`. Everything below (items 1–6) is the queue after that. **(Postscript 2026-11-08, wave 14: the resume finished the eval-runner tests and closed item 8's runner half — see item 5 and `docs/28` §4; the process-memo cache described here is superseded by the persistent per-workspace `repo_map` index, in flight at the wave-14a cut.)**

1. **Real-provider last mile** — one live chat through each adapter (needs API keys). The adapters are pinned by canned-server suites; the competitive audit could not run head-to-head benchmarks for the same reason.
2. **The open authority item: OS-level confinement (NF-016).** Code Mode and shell run with the user's ambient authority (bridge-policed only); `setsid` descendants escape group kills; non-policy hardlinks rely on chain detection; non-Linux fallbacks are weaker. Environment facts (measured 2026-11-08; spike `docs/audit/landlock-spike-2026-11-08.md`, probe `ops/landlock-probe.sh`): no `bwrap`; **Landlock is not available on this deployment kernel** (`4.19.0-gvisor` — raw syscall ENOSYS, no LSM list); **correction: unprivileged user namespaces are NOT blocked here** (`unshare -U/-Ur/-Urm/-Uprf` succeed; bare `unshare -p` EPERMs). Direction (ruling 38): design the seccomp + `no_new_privs` + rlimits + netns reduced form first; the outer sandbox is the confinement of record on gVisor-class deployments; Landlock stays probe-gated. Full list: `docs/audit/reaudit-2026-11-08.md` §6.
3. **The parity roadmap** (competitive audit §7): 30d — compaction v1 + context meter ~~✓~~, eval runner + internal benchmarks ~~✓~~ (head-to-head still needs keys), project-memory files ~~✓~~, repo_map cache ~~✓ wave 14b (persistent index; 840 / 0 / 71 files; gates 6/6)~~, MCP client v1 ~~✓ wave 14~~, diff-review + plan-mode in the TUI ~~✓ wave 14~~, Landlock spike ~~✓ wave 14 (not available on this kernel; ruling 38)~~; 90d — fullscreen renderer slice, checkpoints/rewind (in flight), LSP loop, hooks ~~✓ wave 14~~, +google/+ollama (in flight), sandbox GA, first same-model head-to-head suite; 180d — kernel-executed effects, server mode/SDK, plugins, the governance pack. Also landed early: durable change journal + crash-safe undo (wave 14, ruling 36) and the growth-loop CLI (wave 14).
4. **The external review's still-open items** (`docs/audit/triage-external-review-2026-11-07.md` §6; closure postscripts §7–§8): receipt postimage / durable transcript-kernel bridge; ~~the kernel-absent fail-closed posture (ruling needed)~~ **RULED (wave 14, ruling 33 — mode-honest, not fail-closed: the mode is first-class in `session.start` + one startup notice)**; and the fullscreen/inline TUI as a first-class workstream (`docs/13` is designed, the shipped TUI is the readline chat loop — wave 14 landed plan mode + diff review in it). CLOSED since the first writing of this list: one-use lease consumption (ruling 32, wave 13), kernel-issued tokens + owner scoping (ruling 29, wave 12), and the kernel-absent posture (ruling 33, wave 14).
5. **`docs/30` §4 queue:** item 8 closed (eval runner wave 13; test model verified in-library; non-succeeded runs record post-mortems from the loop, wave 14) except same-model head-to-head benchmarks (needs keys); item 7 closed by the `grow` CLI (wave 14: `--list`, idempotent `--from-postmortems`, guarded `--apply`; scheduling = the documented cron entry) except library consumption (applied proposals are write-only).
6. **Hosted CI needs one manual step** — `.github/workflows/ci.yml` cannot be committed by the automation identity (no `workflow` token scope). `bash ops/install-ci.sh` installs the tracked payload; commit + push it from a token that has the scope.
7. **In flight at the wave-14b commit — do not treat wave 14b as the complete queue:** providers +google/+ollama and rewind/checkpoints. (The repo_map cache landed as wave 14b; wave 14a had excluded it while its owner was mid-work.) The eval runner and everything named in the wave-14a/14b commits are landed and tested.
8. **Wave-14 evidence (integrator-run, 2026-11-08):** wave 14a: `cargo test` 9 + 35 green; loop-level integrations `tests/core/{hooks-loop,plan-loop,plan-apply,postmortem-loop}.test.ts` → 11 pass; the `codemode-preview` flood RSS assertion stabilized (forced GC; it had tripped an intermediate gates run). Wave 14b: repo_map persistent cache (`tests/tools/repo-map.test.ts` 25; `tests/tools/` 229; the touch-one-file test keeps byte length identical so only mtimeMs can invalidate). Wave-14 close: full suite **840 pass / 0 fail (71 files)**; `ops/gates.sh` **6/6** (rust suite, kernel selftest, ts suite, e2e headless smoke, budget rail, usage error). Rulings 33–38 written into `docs/28`; stale doc lines corrected across `docs/28`, `docs/30`, this file.

---

## 6. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **bun is NOT on PATH** | Always `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` handles it. |
| cargo | On PATH (1.99.1); crates.io works. Kernel binary: `kernel/target/release/hz-kernel` (rebuild: `cd kernel && cargo build --release`). |
| git push | Works (https, credential helper). Identity is set automatically — **never** override author/committer or git config. No force-push. The token has **no `workflow` scope**: never commit anything under `.github/workflows/` (push is rejected); ship workflows as payloads + installers instead (`ops/install-ci.sh` is the pattern). |
| Spills | Capped tool output spills its full text (pre-minimisation, raw bytes) to `<workspace>/.hz/state/spills/<sha256>.txt` (a legacy `.hzcode/` workspace keeps `.hzcode/spills`; RC-17) (NF-074; raw-spill fix wave 12); the model sees a truncation marker with the path, receipts digest the full output. |
| Runtime state | `<workspace>/.hz/state/` = `hzcode.db`, kernel log/receipts, history, skills; a legacy `.hzcode/` workspace keeps its tree in place (RC-17). All state files are 0600 / dirs 0700 since wave 12. Gitignored; deleting resets the workspace's session/trust state. The kernel state dir is structurally protected (kernel deny + TS refusal; wave-12 lexical symlink walk + effect-time verification in write/edit; residual: raw shell redirects — NF-016). |
| Keyed anchors | `HZ_ANCHOR_KEY` (hex ≥32 chars) makes every `*.head` an HMAC; `HZ_ACCEPT_LEGACY_ANCHORS=1` migrates legacy chains on the next append. Default (no key) is byte-identical legacy behaviour. |
| Sandbox environment | No `bwrap` installed; unprivileged user namespaces blocked (`unshare -p` → EPERM); Landlock (unprivileged, kernel ≥ 5.13) is the NF-016 candidate — verify on the deployment kernel before designing. |
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

---

*End of state document. If you are starting the next phase: begin at docs/27 (V2+) and `docs/28` §4 (gaps 10–12 carry the live queue) — or the competitive audit §7 roadmap. If you are auditing: everything claimed VERIFIED above has a copy-pasteable command in section 4 or in `docs/28`, and the 2026-11-08 reaudits are the template for how to try to break it.*
