# 30 — Adoption shortlist: the steal list and the action queue

> **Class: working queue (non-normative).** This document consolidates the four pass-3 deep dives — `audit/aider` (35 steal items), `audit/mini-swe-agent` (41), `audit/hermes-agent` (38), `audit/oh-my-pi` (28) — into one traceable shortlist, and ends with the ordered action queue. Every row cites its source report (§4 item numbers) where the full evidence path lives. Nothing here is a status claim; register candidates at the end were **adopted** as `NF-071` … `NF-075` (RC-15, 2026-11-07); items 1–8 and 11 below remain the live work plan.

---

## 0. Sources and the synthesis rule

| Repo | Clone | Report | Steal items | Core character |
|---|---|---|---|---|
| aider | `repo-tour/aider` @ `5dc9490` (714 files) | `docs/audit/pass3/audit-aider-report.md` | 35 | Git-native CLI; repo map + edit-format engineering |
| mini-swe-agent | `repo-tour/mini-swe-agent` @ `04d809c` (250 files, read exhaustively) | `docs/audit/pass3/audit-mini-swe-report.md` | 41 | The SOTA benchmark bash loop; ~190-line core |
| hermes-agent | `repo-tour/hermes-agent` @ `d4e7c343` (22,782 files) | `docs/audit/pass3/audit-hermes-report.md` | 38 | Managed persistent loop; growth machinery |
| oh-my-pi | `repo-tour/oh-my-pi` (10,321 files) | `docs/audit/pass3/audit-omp-deep-report.md` | 28 | Lean loop, claim-verified |

**Synthesis rule.** Consolidate by *mechanism family* (many items overlap across repos); keep every entry traceable to its report §4 number; mark each entry's disposition against the existing corpus (NF-### / doc / new candidate). The register stays closed until the candidates in §3 pass the normal revision; they did — adopted 2026-11-07 (RC-15).

---

## 1. The oh-my-pi claim check (asked explicitly)

External coverage calls oh-my-pi "the Highly Optimized Lean Loop — the speed king." Verdicts from `audit-omp-deep-report.md` §1:

| Claim | Verdict | Evidence |
|---|---|---|
| Batches commands, bypassing multi-turn thinking loops | **CONFIRMED** | `agent-loop.ts#L3906-L3940`: batches dispatch together; `shared` tools run concurrently behind a last-exclusive barrier via `Promise.allSettled`; only 6 of 30 tools declare `exclusive` |
| Fastest median runtime across agent benchmarks | **NOT VERIFIABLE** | No benchmark result artifact anywhere in the tree; the manager reports a *mean* (`meanTrialMs`); `omp bench` medians are of model TTFT/decode, not agent runtime |
| Fewest tokens and tool calls | **PARTIAL** | Mechanisms are real and thorough (append-only context contract, output-budget fit, 3000-line/50 KiB caps, shell minimiser default-on, judge-routed thinking effort, prewalk) — but no comparative measurements are committed |
| 72 % pass rate / reasoning-for-velocity trade | **NOT VERIFIABLE** | Only README marketing rows (68.3 % edit success, −61 % tokens, 2.1×) with no metric/anchor/population/excludes; the repo's own design points *away* from a reasoning-for-velocity trade |

Reading: the *mechanisms* are worth stealing; the *ranking* is unverifiable and should not be quoted as fact. This is exactly why the metric contract (H-7 below) is on the list.

---

## 2. The consolidated steal list

Each row: mechanism → best source (report §4 item) → disposition. "Extends" means an existing NF/doc owns the topic and this sharpens it.

**Candidate resolution (RC-15, 2026-11-07).** The pre-adoption `N-*` candidates named in the disposition column resolve as: `N-1` → folded as an extend-note into `docs/09` (`repo_map` ranking); `N-2` → **NF-073**; `N-3` → **NF-072**; `N-4` → **NF-071**; `N-5` → **NF-075**. The `N-*` ids are historical and resolve nowhere else.

> Reconciled 2026-11-07 (reaudit stage 2, RC-15).

### A. Edit and patch engineering (aider's strongest suit)

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| A-1 | Escalating edit-application ladder: literal → 3-way-merge → line-level patch, each retried under ~4 preprocessing variants | aider 1 | extends NF-069 (repair ladder) |
| A-2 | Relative-indent normalisation before matching edit blocks | aider 2 | extends NF-069 |
| A-3 | Structured, diff-shaped failure feedback: failing block + "did you mean these actual lines?" + "REPLACE already present" | aider 3 | extends NF-052/069 (repair hints) |
| A-4 | Bounded reflection loop: one `reflected_message` slot + `max_reflections` hard stop | aider 4 | extends doc 10 (verify-then-fix) |
| A-5 | Edit engine shipped with cross-implementation parity fixtures and byte-identical error strings | omp 17 | extends NF-069 (error text is a contract) |

### B. Repo map and context selection

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| B-1 | Repo map: tree-sitter def/ref graph + personalised PageRank + token-budget binary search; empirically tuned weight table; no embeddings | aider 5 (+12,29,30) | extends doc 09 `repo_map` (algorithm upgrade; proposes NF candidate N-1) |
| B-2 | Per-message relevance budget that expands when no files are in context + 3-step map fallback ladder | aider 12 | extends doc 09/10 |
| B-3 | Synthetic "assistant ack" turns after context slabs to mark injected context settled | aider 18 | extends doc 10 |
| B-4 | Cache layout as an explicit invariant (stable slabs first, 3 breakpoints, `cacheable_messages()` largest-prefix computation) + keep-alive pings during idle (`AIDER_CACHE_KEEPALIVE_DELAY`) | aider 6,7 | extends NF-005 / Part D §10 (cache addendum) |
| B-5 | Frozen fingerprinted prefix + append-only log; `syncMessages` truncates to longest byte-stable prefix on rewrite; per-provider gate from data (`auto`) | omp 2,3 | extends NF-005 (the contract form of what we already require) |
| B-6 | Fit output cap to remaining window per request: usage-anchored prompt-size estimate, framing tokens (16/msg), measured headway (64) | omp 4,5,6 | extends NF-061 |
| B-7 | Structural read summaries + line/byte caps with spill-to-artifact; shell minimiser default-on | omp 7,8 | extends NF-052 (rendering) |
| B-8 | Budget countdown rendered into the prompt via template vars (steps left, seconds left) | mini 19 | extends doc 08/10 |
| B-9 | Truncation with head/tail + `elided_chars` + remediation advice; 10 K guard in the observation template | mini 20 | extends R-tools-57 (rendering) |

### C. Loop mechanics and velocity

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| C-1 | Hard simplicity floor on the core loop (~200 LOC); policy in config and prompts, not code | mini 1 | design principle; extends doc 08 |
| C-2 | Terminate on a single sentinel (`role == "exit"`); exceptions carry their messages; new exit reasons require zero loop changes | mini 2,3 | extends RC-7 (terminal vocabulary) |
| C-3 | Persist the trajectory inside the loop on every step (`finally: save()`); trajectory format versioned | mini 4 | extends doc 12 (crash-resilient state) |
| C-4 | Format-error continuation: corrective message in-context; **consecutive**-error cap (reset on clean step) with its own exit status; charge failed turns | mini 5,6,7 | extends doc 08 (loop rails; proposes NF candidate N-2) |
| C-5 | Check budgets **before** the call; `0 = unlimited` uniformly; separate non-liftable wall-clock limit; global lock-guarded spend ceiling for batch runs | mini 8,9,10 | extends NF-025 |
| C-6 | Per-tool concurrency declaration (default shared, `exclusive` opt-out) + parallel batch with last-exclusive barrier | omp 1 (claim-verified) | **new capability** (proposes NF candidate N-3) |
| C-7 | Auto-background long commands (default on, 60 s threshold) racing a steering signal | omp 10 | extends doc 08/09 shell |
| C-8 | Re-execute an unpaired tool-call tail before the next model call (pairing invariant preserved) | omp 11 | extends Part D §05 (pairing) |
| C-9 | Live steering into the in-flight stream; refusal path for image-bearing messages | omp 12 | extends doc 08 steer batch |
| C-10 | Loop guards as one prompt file per failure class, emitted in a `<system-interrupt reason>` wrapper | omp 13 | extends NF-066 (stop guards) |
| C-11 | Thinking effort routed by cheap difficulty judgment; auto ceiling one tier below max; explicit `ultrathink` to reach the top | omp 14,15 | extends doc 07/10 |
| C-12 | Owner/worker split: per-turn worker over a framed pipe with identity handshake before any work is reserved; closed versioned bootstrap frame | hermes 13,14 | **new capability** (proposes NF candidate N-4) |
| C-13 | Durable per-session admission FIFO with `unknown` as a first-class state that halts followers | hermes 12 | extends NF-001/RC-7 |

### D. Process ownership and runtime safety

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| D-1 | `spawn_owned` as the single sanctioned spawn path, enforced by an AST lint with reason-required opt-outs and an empty baseline | hermes 15,34 | new infra detail (fold into NF candidate N-4) |
| D-2 | Owner-death supervisor in POSIX `sh` (~0.5 MB, EOF-driven, killpg on SIGKILL/OOM) | hermes 16 | fold into N-4 |
| D-3 | Boot-relative process births surviving NTP steps and VM resume; spawn ledger with quarantine-on-corruption | hermes 17,18 | fold into N-4 |
| D-4 | At-most-once scheduling: advance `next_run_at` before dispatch, stamp the slot in the same save; idle-time (not wall-clock) watchdogs; pre-run data as FILE not command line | hermes 22,23,24 | extends NF-028/053 (scheduling) |
| D-5 | Stateless per-action subprocess execution (fresh process per step); kill the whole process group on timeout keeping partial output; uniform 4-key observation contract across environments | mini 11,12,13 | extends doc 08 sandbox/lane rules |
| D-6 | Turn frames (`delta`/`tool.start`/`approval`/`clarify`/`result`/`finished`), not filesystem diffs — the structural source of near-zero lag | hermes (findings) | fold into N-4 / doc 07 stream framing |

### E. Git and change control

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| E-1 | Dirty-commit-before-edit, then a separate commit for lint fixes (independently revertible units) | aider 8 | extends doc 09 shell/git rules |
| E-2 | Commit attribution as a configurable, documented truth table (`--attribute-*`); env-scoped implementation | aider 23 | extends doc 05 (provenance) |
| E-3 | LLM commit messages from diff **plus conversation context**, Conventional Commits, weak-model-first with token-limit fallback | aider 24 | extends doc 09 |
| E-4 | Continuous Markdown chat transcript + parser (resume, post-mortem, support at ~zero cost) | aider 25 | extends NF-062/doc 14 |

### F. Lint, verification and reflection

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| F-1 | Narrow the lint signal to compiler-grade errors; render failures as marked tree-sitter excerpts | aider 9 | extends doc 09 `lint` |
| F-2 | Tell the model what the harness already does for it (pre-commit lint list) | aider 10 | extends doc 10 prompts |
| F-3 | User-supplied per-language lint command with catch-all fallback and `filename:line` parsing | aider 21 | extends doc 09 |
| F-4 | Evals built from post-mortems; evals that measure cost/latency, not just pass/fail | hermes 29 | extends doc 16/NF-056 |
| F-5 | Hostile-input fixtures for the read path (lockfile tarpit, 600 KB line, FIFO, lying extension, Unicode names) | hermes 30 | extends doc 16 test corpus |

### G. Growth, memory and skills (hermes' core; the biggest capability family)

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| G-1 | Post-turn background-review fork inheriting the parent's cached prefix byte-for-byte (~26 % measured cost cut), persistence-isolated (`_persist_disabled`, `_session_db = None`) | hermes 3,4 | **new capability** (proposes NF candidate N-5); extends NF-010/033 |
| G-2 | Editorial standard for what may be written down (forbids capturing unresolved failures and negative tool claims hardening into refusals) | hermes 5 | part of N-5 |
| G-3 | Read-before-write enforcement on self-edits; 60-char test-enforced description budget tied to what the prompt renders | hermes 6,7 | part of N-5 |
| G-4 | Curator: archive-as-maximum (never delete) + pre-run snapshots + pins | hermes 8 | part of N-5 |
| G-5 | `/learn` as a prompt, not an engine; knowledge-base layout (lean index + per-chapter references), read one unit at a time | hermes 9,10 | extends doc 15 skills |
| G-6 | Untrusted-source hygiene: strip zero-width/bidi characters before distilling (Trojan-Source vector) | hermes 11 | extends NF-070 |
| G-7 | Visible growth surface (learning graph render) | hermes 36 | extends doc 14 |
| G-8 | Eval hillclimb gates in the host (approval freshness by content hash, frozen split, held-out-leakage check) | omp 23 | extends NF-034 |
| G-9 | Benchmark ground truth computed locally; stimuli encode so paraphrase cannot help; every trial derived from an index | omp 24 | extends doc 16 |

### H. Model/provider layer

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| H-1 | Model capability/settings as declarative YAML with user overrides + `accepts_settings` negotiation (unsupported param = warning, not 400) | aider 11 | extends NF-044 |
| H-2 | Cost accounting distinguishing cache-write/cache-hit with provider multipliers | aider 27 | extends NF-050 |
| H-3 | Config keys naming the class (short name or import path); `UNSET` sentinel merge for layered config | mini 16,17 | extends doc 07 config |
| H-4 | Model class owns `format_message`/`format_observation_messages` (dialect switch = config change) | mini 15 | extends NF-044 |
| H-5 | Provider-shape repair in tiny single-purpose utils; never in the loop | mini 40 | extends doc 07 |
| H-6 | Provider compat as compiled data (KDL cascade, ranked resolver, ambiguity = CI failure) | omp 16 | extends NF-044 (data-not-code) |
| H-7 | Metric contract (Metric / Anchor / Population / Excludes) attached to every published number | omp (verdicts §5.13); Reasonix precedent | extends doc 16 (binding for future claims) |

### I. UX, observability and developer surface

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| I-1 | `--show-prompts`: dump the exact rendered message list and exit, no API call | aider 13 | extends doc 14 |
| I-2 | `/tokens`-style per-chunk context cost table with `$` and a remediation hint per row | aider 28 | extends doc 14 |
| I-3 | Cache versioned by extractor provenance; rebuild-then-fallback on corruption; two-API shim | aider 29,30 | engineering note (doc 09) |
| I-4 | Observability flags externalising internal state (`--show-repo-map`, `/settings`, local-only analytics log) | aider 34 | extends doc 14 |
| I-5 | Batch "is it broken or just slow?": per-status histogram + ETA + running cost; Ctrl-C drains in-flight work; Ctrl-C in interactive = user input | mini 30,31,32 | extends doc 14/16 |
| I-6 | Never prompt without a tty; unattended runs degrade to a saved `LimitsExceeded` trajectory, not a crash | mini 33 | extends doc 08 headless rules |
| I-7 | Configuration errors self-documenting: fix + doc link + escape hatch inside the exception text | mini 41 | extends doc 16 |
| I-8 | Onboarding: OAuth-style setup, fuzzy `--list-models`, did-you-mean for unknown models | aider 35 | extends doc 14 |
| I-9 | Deterministic test model inside the library (with scriptable pseudo-actions `/sleep`, `/warning`, `{"raise": …}`) | mini 34,39 | extends doc 16 test kit |

### J. Benchmarks and batch operations

| # | Mechanism | Source | Disposition |
|---|---|---|---|
| J-1 | Standardised prediction schema (`preds.json`) with zero runtime dependency on the benchmark harness | mini 27 | extends doc 16 |
| J-2 | Resumable batch runs purging stale entries; `--shuffle`/`--slice`/`--filter`; resumable long runs from runner-config snapshot | mini 28,29; omp 27 | extends doc 16 |
| J-3 | Default-deny network in the agent container — and prove it with a test against a real container | mini 38 | extends NF-016/NF-023 |
| J-4 | Own the benchmark manager: typed metric definitions, arms grouped by job prefix, resume without re-specifying | omp 27 | extends doc 16 |
| J-5 | Analyse your own session corpus to tune your own tools (read optimiser scripts over real transcripts) | omp 28 | extends NF-035 |

---

## 3. Register candidates (adopted by RC-15)

Adopted as Section B rows (`NF-071` … `NF-075`, doc 24 §5; RC-15). Each passed the merge test (≥2 sources or uniquely user-noticeable) in the four reports.

| Proposed | Feature | Primary source | Notes |
|---|---|---|---|
| **NF-071** | Managed persistent runtime: owner/worker turn frames, durable admission FIFO with `unknown`, process ownership (spawn_owned + supervisor + lint) | hermes (C-12, D-1…D-3, D-6) | The "Managed VPS Loop" as a design; adopt contracts, not the 25-platform adapter matrix |
| **NF-072** | Per-tool concurrency classes and parallel batch execution (default shared, `exclusive` opt-out, last-exclusive barrier) | omp (C-6, claim-verified) | The one benchmark claim that is structurally confirmed; one optional field on the tool interface |
| **NF-073** | Loop safety rails: sentinel exit protocol, budget countdown in the prompt, consecutive format-error cap with its own exit status, charged failed turns, non-liftable wall clock | mini (C-2, C-4, C-5, B-8) | The industrialised form of our RC-7 + doc 08 loop rules |
| **NF-074** | Context-cost contracts: usage-anchored output-budget fit, framing tokens, spill-to-artifact defaults, shell-output minimisation and command interception | omp (B-6, B-7, C-7) | Direct per-turn token savings; pairs with NF-061 |
| **NF-075** | Growth loop v2: post-turn review fork on the warm cache, editorial standard for captured lessons, curator with archive-not-delete | hermes (G-1…G-4) | Extends NF-010/033; the editorial standard is the safety half |

Extend-only notes (no new row): repo-map ranking algorithm → doc 09; edit ladder detail → NF-052/069; cache addendum → NF-005; metric contract → doc 16; hostile read fixtures → doc 16 — folded into the owner documents in the adoption revision (RC-15).

New Section-A sources: the six second-wave sources are recorded in the **A.9 addendum** (doc 24 §4.9; RC-15) — SWE-agent, OpenHands, wshobson/agents, aider, mini-swe-agent, hermes-agent; per-capability rows keep the same per-row disposition requirement as the twelve-repo audit's queue (docs/29 §B.1(c)).

---

## 4. What to do — the action queue

Ordered by value ÷ effort. Items 1–5 are cheap, mostly local, and directly strengthen the existing v0.1; items 6–8 are the next capability wave; items 9–11 are process.

**Precedence (RC-16(h)):** this queue is the execution order; `docs/27-implementation-plan.md`'s V0–V7 ladder is the coarse map. Where they appear to conflict, this queue — the newest ratified one — wins.

1. **Wire the loop safety rails (NF-073).** Charge failed turns, cap consecutive format errors with their own exit status, render the budget countdown, keep the sentinel exit protocol. Small diff to `loop.ts`/contracts; immediately improves long-run behaviour. **Landed 2026-11-07** — `docs/28` §1 (ruling 15): sentinel budget check (steps/tokens/wall clock, `0` = unlimited), charged failed turns, live countdown, corrective rail with a 3-strike cap and its own exit status; acceptance `docs/24` §12.2 #65 pinned by `app/tests/core/rails.test.ts` (11 tests).
2. **Adopt per-tool concurrency classes + parallel batch (NF-072).** One optional field on the Tool interface; `shared` default, `exclusive` for edit/write/ask; barrier semantics. The confirmed oh-my-pi win. **Landed 2026-11-07** — `docs/28` §1 (ruling 14).
3. **Upgrade the edit path (NF-069/052 extensions, A-1…A-5).** Escalating ladder (exact → indent-normalised → 3-way → line-patch), diff-shaped failure feedback with did-you-mean, bounded reflection slot, parity fixtures with byte-identical errors. **Landed 2026-11-07** — `docs/28` §1 (ruling 16): unique-only rungs with rung-named successes, diff-shaped failures (`-`/`+` closest lines + similarity %, REPLACE-already-present), `max_reflections=1` per session+file, byte-identical fixtures in `app/tests/tools/edit-ladder.test.ts` (12 tests).
4. **Adopt the context-cost contracts (NF-074).** Output-budget fit with usage anchoring and framing charge; the `docs/09-tools.md` §10 R-tools-42 caps (≤ 16 KiB / ≤ 4,000 tokens per result) with spill; shell minimiser + command interception (on by default). **Landed 2026-11-07** — output cap fitted from the usage anchor on every provider request; line-aware lossless-resumable truncation with full-text spill to `<state-root>/spills/<sha256>.txt` (canonical `<ws>/.hz/state/spills`, legacy `.hzcode/spills` in place — RC-17; receipts digest the full output); shell minimiser with visible flag and byte-identical no-op; `cat <file>` interception to the read tool; interactive blocklist with `HZ_ALLOW_INTERACTIVE=1` override; env taming. 24 new tests; suite 351 pass / 0 fail at that wave; `ops/gates.sh` 6/6.
5. **Adopt the repo-map algorithm (B-1)** — PageRank ranking + tuned weight table + binary-search budget; replaces guesswork in the existing `repo_map` tool. **Landed 2026-11-07** — the `repo_map` tool ships the ranking in its reduced lexical form (personalised PageRank damping 0.85; focus multipliers 50× on idents defined in focus files / 10× on focus-file out-edges — the aider weight table as prior; binary-search token budget 4k default / 16k hard; exported-first defs; test paths excluded by default; byte-stable output; one `fs.read` admission). `docs/28` §1 (ruling 19); 13 tests; suite 364 pass / 0 fail at that wave.</｜DSML｜ parameter><parameter name=
6. **Build the managed runtime (NF-071).** Owner/worker frames + durable admission FIFO + `spawn_owned`/supervisor/lint. Adopt the contracts; skip the adapter matrix. **Landed 2026-11-07 (wave 8; docs/28 §1, ruling 22).** One `spawnOwned` path (ledger + corruption quarantine), worker identity (pid + /proc startTicks), owner-death supervisor (live SIGKILL → worker tree gone; builder observed ~130 ms, test asserts ≤5 s), durable admission FIFO (`unknown` halts followers), spawn lint (one `Bun.spawn` site, required reason). Not in this slice: the framed owner/worker control pipe; the FIFO is not yet wired into `loop.ts` dispatch.
7. **Build the growth loop (NF-075).** Background-review fork with cache parity + editorial standard + curator; the safety half (editorial standard, read-before-write, description budget) lands *with* the fork, never after. **Landed 2026-11-07 (wave 11; docs/28 §1, ruling 27), reduced form** — the review-fork SPEC (byte-identical prefix or refused, closed read-only tool subset, `origin: review-fork`), the editorial standard as one function (title/body budgets, authority-widening and do-not-capture refusals, evidence, read-before-write) and an append-only, deduplicating curator at `<stateDir>/proposals.jsonl` that applies nothing. Not in this slice: scheduling, loop wiring, provider calls, application.
8. **Verification wave:** hostile read fixtures, evals-from-post-mortems, metric contract (H-7) on every published number, answer-isolation precondition on eval runs, test-model-in-library. **Partly landed 2026-11-07:** hostile-read fixtures (wave 6a), the H-7 metric contract helper with the canonical-number contract (waves 6b/7 — routing every published number is open), evals-from-post-mortems with the enforced answer-isolation precondition (wave 11; docs/28 ruling 28). Remaining: same-model head-to-head benchmarks (needs keys). Closed since waves 13–14: the eval runner (cases are data today no longer — `bun run eval` with the scripted test model in-library, verified) and post-mortem recording from the loop (non-succeeded runs record one).
9. **Fold the register — done 2026-11-07 (RC-15):** `NF-071`…`NF-075` adopted; the six second-wave sources recorded as the A.9 addendum; the build sequence below stands.
10. **Fold the extend-notes into their owners — done in the adoption revision (RC-15):** cache addendum (NF-005), edit-ladder detail (NF-052/069), metric contract (doc 16), git hygiene (E-1…E-4 → doc 09/05), observability (I-1…I-9 → doc 14).
11. **Record the four repos' defects** as reference-repo observations, not ours: aider's duplicated repo-map capture (~1.41× weight inflation), DeepSeek/Anthropic cache-cost arithmetic, `cur_tokens` double count; mini-swe-agent's three v1-leftover doc/fixture breaks; hermes' shallow-clone limitation; oh-my-pi's unstated metric contract and unasserted answer isolation. **Landed 2026-11-07** — `docs/audit/observations-reference-defects-2026-11-07.md` (88 rows, each cited to a source line; 10 queue-named; §0 resolves “four repos” → five named sources; §6.2 states the no-re-verification limit).

### What *not* to copy (deliberate refusals)

- mini-swe-agent's "no compaction, no tools but bash" — deliberate for a benchmark, wrong for a product (its own report §5.4 says so).
- hermes' 25-platform gateway, full four-layer Windows identity, and profile multiplexing — take the contracts, not the adapters (its §5.3).
- aider's per-call-site `--dry-run` guards — the I/O-layer guard (its own item 32) is the correct form.
- omp's 15,853-line `agent-session.ts` monolith — steal the mechanisms, not the sprawl (its §5.2).

---

## 5. Second steal wave - seven external sources (opencode, cline, codex, oh-my-pi re-verified, grok-build, Claude Code, DeepSeek harness)

> **Append-only extension (second wave).** This section consolidates three new research reports covering seven additional sources. It does **not** restate the pass-3 taxonomy: §0-§4 above (sources table, oh-my-pi claim check, families A-1..J-5, register `NF-071`..`NF-075`, the 11-item queue) stay intact and are referenced by id. New entries are organised **by source** (§5.1-§5.7), then **cross-cut by value-over-effort tier** in a consolidated table (§5.8). Nothing here is a status claim. Per status discipline, **no new NF numbers are assigned** (the register stays closed until a future revision adopts them) and **no level above DESIGNED is claimed**. Where a steal touches a wire/durable schema or a tool/provider interface, `app/src/contracts.ts` is named as the owner (contracts.ts is law). Dispositions reuse the existing vocabulary: `extends NF-###` / `extends doc NN` / `extends A-#..J-#` / `new candidate`.

### 5.0 Sources and provenance (second wave)

| Source | Clone path (under `/projects/sandbox/externals/`) | Report | Character |
|---|---|---|---|
| opencode | `externals/opencode` | `research/steal-opencode-cline.md` (Part A, Part C queue) | TS/Bun monorepo; data-driven providers, cache-breakpoint engine, line-ending-safe edit engine, background compaction |
| cline | `externals/cline` | `research/steal-opencode-cline.md` (Part B, Part C queue) | Extracted agent SDK (`sdk/packages/core`); command-guard, loop/mistake trackers, user provider registry, GPT-5 apply_patch |
| codex (OpenAI) | `externals/codex` | `research/steal-ohmypi-codex.md` (Part 1, Part 3 tiers) | Rust `codex-rs/` (~128 crates); OS sandbox layers, execpolicy allowlist, apply-patch grammar, per-model prompt files |
| oh-my-pi (re-verified) | `externals/oh-my-pi` | `research/steal-ohmypi-codex.md` (Part 2, Part 3 tiers) | NEW findings only: LSP/DAP subsystem, speculative execution, bash PTY selection, fuzzy edit thresholds |
| grok-build (xai-org) | `externals/grok-build` | `research/steal-grok-claude-deepseek.md` (Part 2, Part 4 tiers) | Rust; per-origin egress proxy, hashline edit anchors, multi-dialect tools, dream-consolidation memory |
| Claude Code (anthropics) | `externals/claude-code` | `research/steal-grok-claude-deepseek.md` (Part 3, Part 4 tiers) | SDK/docs + `mods/` + `examples/` only (see provenance note); hook lifecycle, permission modes, subagent presets |
| DeepSeek harness (`dsh`) | `externals/deepseek-harness` | `research/steal-grok-claude-deepseek.md` (Part 1, Part 4 tiers) | TS Cordis microkernel; capability seams, in-history prompt update, fail-closed sandbox ladder, PTC runtime |

**Provenance notes (recorded verbatim).**

- **Claude Code clone ships docs/SDK/mods only - there is NO agent source.** `externals/claude-code` (`0ed9469`) contains the CHANGELOG, the `mods/` function-hook packs (`agents-md`, `sec-default`, `privacy`, `diff`, `telemetry`), enterprise `examples/` (settings, MDM, gateway, hooks), and the plugin marketplace manifest. The architecture referenced in §5.6 is drawn from those published docs + `mods/` + `examples/`, not from a private agent implementation.
- **DeepSeek harness was located and cloned THIS session.** The org publishes many model repos (`DeepSeek-V3`, `-R1`, `DeepSeek-V3.2-Exp`); only `deepseek-ai/deepseek-harness` is an actual agent/coding harness. It was cloned this session to `externals/deepseek-harness` (20,665 files; v0.2.2-rc.1, "Everything is a Plugin").
- **oh-my-pi appears in BOTH passes.** oh-my-pi was already consolidated in the pass-3 set (see §0 and the A/B/C/G/H/I/J rows and `NF-072`/`NF-074`). The second wave **re-verifies** those against current source and adds ONLY what the prior pass missed: the LSP/DAP subsystem, speculative execution across turns, bash PTY selection, and the named fuzzy edit thresholds. Mechanisms already captured in §2/§3 are not re-listed here.

### 5.1 opencode (`externals/opencode`)

TS/Bun monorepo with a clean `packages/ai` (provider/transport) vs `packages/core` (sessions/tools/permissions/compaction) split. Entries below are new relative to §2/§3; overlaps with landed NFs are framed as extend/sharpen.

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Fail loud on an unknown provider: the `default` arm of `makeProvider` silently returns the mock today; make it an `error` event naming known providers; keep mock behind the explicit `--mock`/`HZ_PROVIDER=mock` flag | `externals/opencode/packages/core/src/v1/config/provider.ts` (declarative provider schema) | `app/src/core/providers/index.ts` (the closed `switch` with silent mock fallback, ~line 62) | new candidate |
| LF-view edit matching with byte-accurate CRLF mapping + per-region ending preservation (`matchView`/`withRegionEndings`/`alignLines`); three-tier in-pass ladder (exact -> Unicode-normalised -> trailing-whitespace-insensitive) | `externals/opencode/packages/core/src/tool/plugin/edit.ts` | `app/src/tools/edit.ts` | extends NF-069 (extends A-1..A-5) |
| Vote-based "closest numbered lines" miss hint + "newString already present, edit may already be applied" branch, gated on read permission | `externals/opencode/packages/core/src/tool/plugin/edit.ts` (`missHint`) | `app/src/tools/edit.ts` | extends NF-069 (extends A-3) |
| Interpolate concrete OS/shell into the shell tool description at request time rather than a static string | `externals/opencode/packages/core/src/tool/plugin/shell.ts` (`description(shell)`) | `app/src/tools/shell.ts` | extends doc 09 |
| Invalid-tool-JSON replay: synthesise a paired tool result carrying the byte-for-byte raw input + "not valid JSON" message instead of failing the turn | `externals/opencode/packages/ai/src/loop.ts` (`invalidCall`/`withInvalidCalls`) | `app/src/core/loop.ts` | extends NF-073 (extends C-4) |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| `openai-compatible` protocol adapter keyed by `{ baseURL, apiKey, modelId }` so DeepSeek/Groq/Together/OpenRouter/xAI/vLLM are config, not one file per vendor | `externals/opencode/packages/ai/src/protocols/` (~50 adapters grouped by wire format) | `app/src/core/providers/`; interface owner `app/src/contracts.ts` (provider/model info) | new candidate |
| Cache-breakpoint planner: up to 4 breakpoints (`BREAKPOINT_CAP`), tail advances per tool result, per-route table skips OpenAI/Gemini implicit caching | `externals/opencode/packages/ai/src/cache-policy.ts` | `app/src/core/providers/` request builder | extends NF-005 (extends B-4) |
| Hold-then-swap background compaction keyed to remaining cache TTL: summarise the just-cached prefix, HOLD it, swap only when compaction is due | `externals/opencode/packages/core/src/session/compaction.ts` | `app/src/core/compaction.ts` | extends NF-075 (extends NF-005) |
| Debounced MCP reconcile on a tools-changed event (100 ms) + binary-resource spill-to-artifact + schema-gated JSON parse of text results | `externals/opencode/packages/core/src/tool/plugin/mcp.ts` | `app/src/core/mcp/` | extends NF-074 (MCP) |
| Typed decision helper (`predicate`/`choice`/`score` with calibrated probabilities) for effort/difficulty routing instead of free-text judgments | `externals/opencode/packages/ai/src/decision.ts` | `app/src/core/evals.ts`, `app/src/core/metrics.ts` | extends C-11 (doc 07/10) |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Rope / order-statistic indexing for large-file paging + negative-offset tail read so `read(path, offset=-100)` is cheap on huge files | `externals/opencode/packages/core/src/tool/read-filesystem.ts` | `app/src/tools/read.ts` | extends NF-074 (extends B-9) |
| Per-parsed-command shell permission + durable resource-scoped grants (`{action, resource}` saved rows) so `a && rm -rf b` is evaluated on `rm` specifically | `externals/opencode/packages/core/src/permission/saved.ts`, `permission/sql.ts`, `shell/parse.ts` | `app/src/tools/shell.ts`, `kernel/src/permm.rs` | extends kernel perms |

### 5.2 cline (`externals/cline`)

Reusable agent core extracted into `sdk/packages/core/src`. Strengths are a pragmatic tool set, a shell command-guard, per-model tool routing, safety trackers, and a user-extensible provider registry.

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Identical-tool-call loop detection keyed on a sorted-key JSON signature: soft nudge @3, hard stop @5 (catches semantic repetition the format-error cap does not) | `externals/cline/sdk/packages/core/src/runtime/safety/loop-detection.ts` | `app/src/core/loop.ts`, `app/src/core/hooks.ts` | extends NF-073 |
| Mistake taxonomy (`api_error`/`invalid_tool_call`/`tool_execution_failed`) separate from the format cap + "stopped, state preserved, resume with a new prompt" message so a capped run is resumable | `externals/cline/sdk/packages/core/src/runtime/safety/mistake-tracker.ts` | `app/src/core/loop.ts` | extends NF-073 |
| Batch-tolerant `read` with a union input schema + per-item result/error array (never fail the whole call on one bad path) | `externals/cline/sdk/packages/core/src/extensions/tools/definitions.ts` | `app/src/tools/read.ts` | extends NF-074 |
| Harden clarify/terminal tools: refuse to fabricate a dismissed answer; evidence-demanding run-completion guidance ("run the tests", "re-read the task") | `externals/cline/sdk/packages/core/src/extensions/tools/definitions.ts` (`ask_question`, `submit_and_exit`) | `app/src/tools/agent.ts`, `app/src/tools/plan.ts` | extends doc 10 |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Command-guard for a read-only/plan lane: data-masking (heredocs/quotes/comments) + wrapper skipping (`sudo env xargs timeout`) + in-place-edit flag detection (`sed -i`, `curl -o`) + redirect-target allowlist, pure TS, zero deps | `externals/cline/sdk/packages/core/src/extensions/tools/command-guard.ts` | `app/src/tools/shell.ts`, `app/src/tools/plan.ts`, `kernel/src/guard.rs` | new candidate |
| `apply_patch` tool with the GPT-5 freeform grammar (`*** Begin Patch`/`Add|Update|Delete File`/`Move to:`/`@@`), fuzz-factor reporting, cwd confinement | `externals/cline/sdk/packages/core/src/extensions/tools/executors/apply-patch.ts`, `apply-patch-parser.ts` | `app/src/tools/` (new patch tool); schema owner `app/src/contracts.ts` | new candidate |
| Declarative model->tool routing table (`{modelIdIncludes, providerIdIncludes, enable[], disable[]}`) routing GPT/Codex to `apply_patch` and Claude/Gemini to find/replace | `externals/cline/sdk/packages/core/src/extensions/tools/model-tool-routing.ts` | `app/src/tools/index.ts`; tool-exposure schema owner `app/src/contracts.ts` | new candidate |
| Shared `line-endings` helper across edit/write/patch: detect native EOL, chunk math in LF space, restore on write (a conclusion opencode reached independently) | `externals/cline/sdk/packages/core/src/extensions/tools/executors/line-endings.ts` | `app/src/tools/edit.ts`, `app/src/tools/write.ts` | extends NF-069 |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| User provider registry: register `{ name, baseURL, apiKey, protocol, models[] | modelsSourceUrl }` at runtime; model discovery that FAILS LOUD (unreachable host/bad key reaches the caller, never an empty list) | `externals/cline/sdk/packages/core/src/services/providers/local-provider-service.ts`, `local-provider-registry.ts` | `app/src/core/config.ts`, `app/src/core/providers/`; schema owner `app/src/contracts.ts` | new candidate |
| Typed hook taxonomy (`beforeRun`/`afterRun`/`beforeModel`/`afterModel`/`beforeTool`/`afterTool`/`onEvent`) so rails/loop-detection/budgets are hooks, not inlined branches | `externals/cline/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts` | `app/src/core/hooks.ts`, `app/src/core/loop.ts` | extends doc 08 |
| Uniform `restrictToCwd` / `..`-escape rejection across every write-capable tool; idle-timeout respawn + compiled-runtime launcher (`BUN_BE_BUN=1`) for JS helpers | `externals/cline/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts` | `app/src/tools/write.ts`, `app/src/tools/edit.ts` | extends NF-071 |

### 5.3 codex (`externals/codex`)

OpenAI Codex, Rust `codex-rs/`. codex independently confirms NF-072 (per-tool parallel flag at `tools/router.rs::tool_supports_parallel`). New relative to §2/§3:

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Self-documenting provider-removal errors: `WireApi` deserialization rejects removed values with an embedded "How to fix: ... More info: <url>" message; built-in defaults + user `model_providers` config that override at runtime | `externals/codex/codex-rs/model-provider-info/src/lib.rs` | `app/src/core/providers/index.ts`; config/schema owner `app/src/contracts.ts` | new candidate |
| Graduated fuzzy context ladder for patch hunks: exact -> trailing-whitespace -> trim -> Unicode-fold (dashes/quotes/odd-spaces to ASCII), eof-anchored search; lenient-by-default parse (`PARSE_IN_STRICT_MODE=false`) | `externals/codex/codex-rs/apply-patch/src/seek_sequence.rs`, `parser.rs` | `app/src/tools/edit.ts` | extends NF-069 (extends A-1..A-3) |
| Per-model prompt templates selected from model metadata, fail-soft (missing template -> warn + empty, never crash) | `externals/codex/codex-rs/prompts/src/model_instructions.rs`, `core/gpt-5.2-codex_prompt.md` | `app/src/core/instructions.ts` | extends doc 10 (extends H-4) |
| Model-visible exec output format: `Exit code`, `Wall time` (0.1s), `Total output lines` only when truncated, then `Output:` | `externals/codex/codex-rs/core/src/tools/mod.rs` (`format_exec_output_for_model`) | `app/src/tools/shell.ts` | extends NF-074 |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| OS-level sandbox layering for shell/codemode: `no_new_privs` + seccomp network isolation + bubblewrap FS isolation + bundled-binary digest verify (exit 8 on mismatch); declarative `execpolicy` allowlist (`PrefixRule`/`NetworkRule`, sorted `fingerprint()` equality, `amend` at runtime) | `externals/codex/codex-rs/linux-sandbox/src/{seccomp.rs,bwrap.rs,bundled_bwrap.rs}`, `execpolicy/src/policy.rs` | `kernel/src/guard.rs`, `kernel/src/permm.rs`; `DEFAULT_POLICY` owner `app/src/contracts.ts` | extends NF-016/NF-023 (extends J-3) |
| Unified interactive exec: one stateful terminal tool pair (`exec_command` + `write_stdin`), PTY-backed, with a cached-approval auto-retry at `SandboxType::None` on sandbox denial (no re-prompt) | `externals/codex/codex-rs/core/src/unified_exec/mod.rs` | `app/src/tools/shell.ts` | new candidate |
| Streaming retry with server-advised backoff that cannot extend configured limits (`INITIAL_CONNECTION_RETRY_DELAY=5s`, `MAX_CONNECTION_RETRY_DELAY=60s`; `Retry-After` controls timing, never the retry count) | `externals/codex/codex-rs/core/src/responses_retry.rs` | `app/src/core/providers/` (retry) | extends NF-073 (extends C-5) |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Server mode + rollout/daemon recovery: a long-lived process TUI/ACP clients attach to, with the event log as the rollout for crash recovery | `externals/codex/codex-rs/core/src/rollout.rs`, `session/daemon_recovery.rs`, `app-server-daemon` | `app/src/main.ts`, `kernel/src/eventlog.rs`; protocol owner `app/src/contracts.ts` | new candidate |
| Tool exposure classes (`Direct`/`Deferred`/`CodeModeOnly`/`Hidden`) + a `tool_search` meta-tool so rare/large tools cost no spec tokens until discovered | `externals/codex/codex-rs/core/src/tools/registry.rs` (`ToolExposure`) | `app/src/tools/index.ts`, `app/src/core/loop.ts`; schema owner `app/src/contracts.ts` | extends NF-072 |
| Turn diff tracker as a first-class surface: accumulate one unified diff per turn and emit a `TurnDiffEvent` independent of per-tool output | `externals/codex/codex-rs/core/src/turn_diff_tracker.rs` | `app/src/core/loop.ts`, TUI | new candidate |
| Guardian-style action classifier reviewing proposed actions against instructions | `externals/codex/codex-rs/core/src/guardian/`, `prompts/templates/guardian/classifier_instructions.md` | `app/src/core/review.ts` | extends doc 10 |

### 5.4 oh-my-pi (re-verified, NEW findings only) (`externals/oh-my-pi`)

Only mechanisms the pass-3 audit did not capture. The marketing numbers remain NOT VERIFIABLE (see §1); keep the H-7 metric contract.

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Fuzzy edit thresholds as a tuned prior: `DEFAULT_FUZZY_THRESHOLD=0.95`, `SEQUENCE_FUZZY_THRESHOLD=0.92`, `FALLBACK_THRESHOLD=0.8`, `CONTEXT_FUZZY_THRESHOLD=0.8`, `CHARACTER_MATCH_THRESHOLD=0.92`, `DOMINANT_FUZZY_MIN_CONFIDENCE=0.97` with `DOMINANT_FUZZY_DELTA=0.08`; diff-shaped failure previews up to `MAX_RECORDED_MATCHES=5` (5 lines x 80 chars) | `externals/oh-my-pi/crates/pi-edit/src/fuzzy.rs` | `app/src/tools/edit.ts` | extends NF-069 (extends A-3) |
| Diagnostics-ledger / fresh-only error reporting: strip `file:line:col` to a location-independent `diagnosticIdentity`, return only unseen messages so repeated diagnostics are not re-charged to context | `externals/oh-my-pi/packages/coding-agent/src/lsp/diagnostics-ledger.ts` | `app/src/core/loop.ts`, `app/src/tools/edit.ts` | extends NF-074 |
| Cross-check and align output-budget constants against the verified source: `MIN_FITTED_OUTPUT_TOKENS=1024`, `MESSAGE_FRAMING_TOKENS=16`, `OUTPUT_FIT_HEADWAY_TOKENS=64`, margin divisor 10; usage anchor from the newest assistant turn; skip-fit cases (`stopsOutputAtContextWindow`, OpenRouter self-cap, no window) | `externals/oh-my-pi/packages/agent/src/output-budget.ts` | `app/src/core/output-budget.ts` | extends NF-074 (extends B-6) |
| Bash interceptor as a configurable regex rule table (`DEFAULT_BASH_INTERCEPTOR_RULES`) with a quote-aware tokenizer (`skipShellWord`), generalising the `cat`->read interception to grep/find/sed | `externals/oh-my-pi/packages/coding-agent/src/tools/bash-interceptor.ts` | `app/src/tools/shell.ts` | extends NF-074 |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| LSP loop: writethrough (sync content to servers, force tsserver to observe new paths pre-`didOpen`, grace-window wait) + inline diagnostics returned with the edit result + multi-server mux | `externals/oh-my-pi/packages/coding-agent/src/lsp/{client.ts,writethrough.ts,diagnostics.ts,workspace-diagnostics.ts,lspmux.ts}` | new `app/src/core/lsp/` + `app/src/tools/edit.ts`, `app/src/tools/write.ts` | new candidate |
| Bash PTY selection + interactive bash: decide per command whether to run under a PTY vs piped so interactive programs work | `externals/oh-my-pi/packages/coding-agent/src/tools/{bash-pty-selection.ts,bash-interactive.ts}` | `app/src/tools/shell.ts` | new candidate |
| Cross-process locking + mutation queue + concurrent-edit conflict detection | `externals/oh-my-pi/packages/coding-agent/src/tools/{file-mutation-queue.ts,conflict-detect.ts,bash-worktree-rewrite.ts}` | `kernel/` (lock owner), `app/src/tools/write.ts` | new candidate |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Speculative execution across turns: a dependency-graphed candidate scheduler running side-effect-free calls ahead of commit, then commit/discard on host validation (generalises NF-072's within-batch parallelism) | `externals/oh-my-pi/packages/agent/src/speculative-execution.ts` | `app/src/core/loop.ts` | extends NF-072 |
| DAP (debugger) tool: full launch/attach, breakpoints (line/function/data/instruction), `evaluate`, `readMemory`, `disassemble` | `externals/oh-my-pi/packages/coding-agent/src/dap/{client.ts,session.ts}` | new `app/src/tools/` debug tool | new candidate |
| AST-structural edit + search tools above the textual edit/grep for safer large refactors | `externals/oh-my-pi/packages/coding-agent/src/tools/{ast-edit.ts,ast-grep.ts}`, `crates/pi-ast` | `app/src/tools/edit.ts`, `app/src/tools/index.ts` | new candidate |

### 5.5 grok-build (xai-org) (`externals/grok-build`)

Rust; strongest on network egress, edit anchoring, and multi-dialect tools.

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Bash command splitting + per-sub-command risk scoring: split a compound shell line and risk-score each segment instead of approving the whole string | `externals/grok-build/crates/codegen/xai-grok-permission-rules/src/{bash_command_splitting.rs,exec_risk.rs}` | `app/src/core/loop.ts` (`admissionFor`/guard), `app/src/tools/shell.ts` | extends NF-073 (extends D-5) |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Hashline edit anchors (`LINE:localhash[:chunkfp]`): three schemes (ContentOnly / ChunkFingerprint over 16-line chunks / CheckpointChain from 32-line checkpoints); `validate() -> Valid|Stale|OutOfRange`; `find_shifted()` searches +-15 lines; truncated anchors rejected as `Stale` (cannot silently degrade) | `externals/grok-build/crates/codegen/xai-grok-tools/src/implementations/grok_build_hashline/scheme.rs` | `app/src/tools/read.ts`, `app/src/tools/edit.ts` + a new `anchor.ts` | extends NF-069/052 |
| Multi-dialect tool compatibility: optional `codex`/`opencode`/`claude` tool-name aliases over one canonical `ToolKind`/`ToolNamespace` taxonomy with a versioned `_meta` envelope, so a model runs with the dialect it was trained on | `externals/grok-build/crates/codegen/xai-grok-tools/src/implementations/` (`codex/`, `opencode/`, `claude_alias.rs`, `tool_taxonomy.rs`) | `app/src/tools/index.ts` + a taxonomy module; schema owner `app/src/contracts.ts` | new candidate |
| Folder-trust + source-identity gating: a program named by a workspace stays off until the folder is trusted | `externals/grok-build/crates/codegen/xai-grok-permission-rules/src/{folder_trust.rs,source_identity.rs,trust.rs}` | `app/src/core/config.ts`, `kernel/src/permm.rs` | extends doc 11 |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Egress proxy with per-origin `Allow|AllowAndRecord|Deny|Ask`: `Ask` parks the connection; two-level hold budgets (`DEFAULT_MAX_HELD=16`, `DEFAULT_MAX_HELD_PER_CALL=8`, `DEFAULT_HOLD_TIMEOUT=600s` then auto-403); observe mode (`AllowAndRecord{would}`) for safe rollout | `externals/grok-build/crates/codegen/xai-grok-egress-proxy/src/decider.rs` | new `kernel/` egress capability + `app/src/core/` proxy client; wire/policy owner `app/src/contracts.ts` | new candidate |
| Memory retrieval + background "dream" consolidation: embeddings + BM25 + MMR + query expansion; read-before-write self-edits; protected `MEMORY.md` manifest | `externals/grok-build/crates/codegen/xai-grok-memory/src/{storage_v2.rs,v2_consolidation.rs,mmr.rs,batch_dream*.rs}` | `app/src/core/curator.ts`, `app/src/core/review.ts` | extends NF-075 |
| Server-side hosted tools (web search executed by the provider) ANDed with per-model capability | `externals/grok-build/crates/.../xai-grok-agent/src/agent.rs` (`hosted_tools`) | `app/src/core/providers/`, `app/src/tools/index.ts`; capability owner `app/src/contracts.ts` | new candidate |

### 5.6 Claude Code SDK/docs (`externals/claude-code`)

The extensibility, permission, and lifecycle-hook reference. Agent source is closed; see the provenance note in §5.0 (docs/SDK/`mods/`/`examples/` only).

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Subagent description token budget: warn when non-built-in subagent descriptions exceed 15000 tokens of combined context; lean read-only "explore" preset that starts without the instructions file + git status (`omitClaudeMd`) | `externals/claude-code` published subagents docs (`code.claude.com/docs/en/sub-agents`) | `app/src/tools/agent.ts`, `app/src/core/subagent.ts`, `app/src/core/instructions.ts` | extends doc 10 |
| Exit-code hook contract: exit 2 blocks the tool and shows stderr to the model, exit 1 shows stderr to the user only, exit 0 proceeds; worked `grep`->`rg` `PreToolUse` validator | `externals/claude-code/examples/hooks/bash_command_validator_example.py` | `app/src/core/hooks.ts` | extends doc 10 |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Richer hook lifecycle: add `SessionStart/End`, `PreCompact/PostCompact`, `SubagentStart/Stop`, `PermissionRequest/Denied`, `PreToolBatch/PostToolBatch`, plus HTTP / MCP-tool / LLM-prompt / subagent hook transports | `externals/claude-code/mods/` (hook packs, e.g. `mods/agents-md`) + published hooks docs (`code.claude.com/docs/en/hooks`) | `app/src/core/hooks.ts`, `app/src/core/loop.ts` emit points; event schema owner `app/src/contracts.ts` | extends doc 10 |
| Permission modes (`default`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`) with `allow`/`ask`/`deny` rule lists keyed by tool, plus a managed-settings override hierarchy (`allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode`) | `externals/claude-code/examples/settings/` (`settings-strict.json`), `examples/mdm/` | `app/src/core/config.ts`, `kernel/src/permm.rs`; policy owner `app/src/contracts.ts` | extends doc 11 |
| Bash network allowlist shape: `sandbox.network` with `allowedDomains`, `allowUnixSockets`, `allowLocalBinding`, `httpProxyPort` (adopt the allowlist shape, not the Bash-only coverage) + the CI egress-firewall `enforce` pattern | `externals/claude-code/examples/settings/settings-bash-sandbox.json`, `examples/` CI hardening (`egress-firewall.yaml`, `workflow-hardening.yml`) | `kernel/src/guard.rs` + egress client; policy owner `app/src/contracts.ts` | new candidate |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Agent SDK / headless `-p --output-format json` surface so non-TS callers drive the same loop (the "protocol is the API / SDKs" roadmap item) | `externals/claude-code` published SDK overview (`code.claude.com/docs/en/agent-sdk/overview`) | `app/src/main.ts` (headless mode exists); JSON-RPC/stdio protocol owner `app/src/contracts.ts` | new candidate |

### 5.7 DeepSeek harness (`dsh`) (`externals/deepseek-harness`)

The deepest and most directly transferable TS source; a Cordis microkernel where every capability is a plugin behind a Service Definition / Provider / Consumer seam.

**Tier 1 - cheap, local, high value.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| `systemPromptUpdate: 'in-history'`: when the model reads the latest `system` message at any position, append a changed system prompt AFTER cached history instead of rewriting the leading message, so the KV-cache prefix survives a prompt change | `externals/deepseek-harness/packages/core/system-prompt/README.md`, `packages/llm/llm-deepseek/README.md` | `app/src/core/loop.ts` request assembly, `app/src/core/providers/anthropic.ts`/`openai.ts`; per-model capability flag owner `app/src/contracts.ts` | extends NF-005 |
| Repeat-tool reminder guard at `[3,5,8]` exact-repeat counts (deep key-sorted canonical args), advisory never a veto, injected as a source-attributed synthetic user message, counted in post-execute (denied calls count too), cleared by a new user prompt | `externals/deepseek-harness/packages/guard/repeat-tool-reminder/README.md` | new `app/src/core/guards/repeat-tool.ts` hooked after tool results in `app/src/core/loop.ts` | extends NF-073 |
| Stable provider failure codes + route-on-code (`NO_ADAPTER`, `MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `ACCOUNT_QUOTA`) with one terminal `finish` shape per stream, so retry/compaction triggers route on code not message text | `externals/deepseek-harness/packages/llm/llm/README.md` | `app/src/core/providers/index.ts`; code union owner `app/src/contracts.ts` | extends NF-073 (extends H-5) |
| Subagent delegation-scope statement + return guidance injected into every child ("scope fixed, do not retry the denied op, state the limitation"; "parent gets only your final answer") | `externals/deepseek-harness/packages/subagent/subagent/README.md` | `app/src/core/subagent.ts`, `app/src/tools/agent.ts` | extends NF-071 |
| PTC tool-call allowance tied to timeout (`floor(timeoutMs/60000 x maxSubCallsPerMinute)`, default 2048 for a 2-min run) + infinite-loop termination message naming the limit; teach read-only concurrency in the SDK instructions | `externals/deepseek-harness/packages/core/tool-executor-ptc/README.md` | `app/src/tools/codemode.ts`, `app/src/tools/codemode-child.ts` | extends doc 09 (codemode) |

**Tier 2 - next capability wave.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| Fail-closed sandbox with a per-call escalation ladder: `SandboxPolicy` rides each call (`read-only`/`workspace-write`/`danger-full-access`); cannot-enforce -> `SANDBOX_UNAVAILABLE` (never unconfined); enforcement completeness reported per call (`full`/`partial`); denied call may retry the exact call once with `sandbox_permissions` + `justification`, a wider mode needs approval and applies to that one call only | `externals/deepseek-harness/packages/sandbox/sandbox/README.md` | `kernel/src/guard.rs`, `app/src/core/kernel.ts`; policy/wire owner `app/src/contracts.ts` | extends NF-016/NF-023 |
| Four-stage tool pipeline (`tools/pre-execute` allow/deny/ask -> monotonic `guard()` -> around-dispatch `execute` -> `post-execute` replace/attach-context -> observe `tools/result`) with conditional tools (`register(def,{when})`) and per-agent `restrict(filter)` masks | `externals/deepseek-harness/packages/core/tools/README.md` | `app/src/tools/index.ts`, `app/src/core/loop.ts` dispatch, `app/src/core/hooks.ts` | extends doc 09 |
| Compaction split: a tool-result pruner that trims oversized outputs BEFORE summarizing + image-offload logged as one event and retried when a route rejects images | `externals/deepseek-harness/packages/compaction/README.md` | `app/src/core/compaction.ts`, `app/src/core/output-budget.ts` | extends NF-074 |
| Deliverables recorder: a `present` tool declaring final files + a per-turn changed-file list with line counts from git snapshots, rendered at end of turn (client-only, not model-visible) | `externals/deepseek-harness/packages/deliverables/README.md` | new `app/src/core/deliverables.ts`, reuse `app/src/tools/change-journal.ts` | new candidate |

**Tier 3 - richer / strategic.**

| Steal | External evidence | HorizonCode target | Disposition |
|---|---|---|---|
| External agents as subagents: run Claude Code / Codex / an ACP agent as a one-shot child returning only a final answer (reasoning/tool-traffic/stderr kept out of the parent session) | `externals/deepseek-harness/packages/subagent/subagent-claude-code/README.md`, `packages/subagent/subagent/README.md` | new providers behind `app/src/core/subagent.ts`; protocol owner `app/src/contracts.ts` | extends NF-071 |
| Capability-seam discipline (Service Definition / Provider / Consumer) applied to fs/subprocess/shell/sandbox so a remote-sandbox swap moves all execution tools at once, no per-tool forks | `externals/deepseek-harness/packages/core/README.md`, `docs/architecture.md` (Profiles and bundles) | architectural: `app/src/core/kernel.ts`, `app/src/core/providers/`; seam contracts owner `app/src/contracts.ts` | extends doc 03 (HLD) |
| Configurable providers activated from config without restart (`LlmConfigurableProvider` with `defaultBaseURL`/`nativeAuth`/`baseURLEnv`; new model ids pass through with no re-registration); capability negotiation validated before any I/O | `externals/deepseek-harness/packages/llm/llm/README.md` | `app/src/core/providers/index.ts`, `app/src/core/config.ts`; schema owner `app/src/contracts.ts` | new candidate |

### 5.8 Consolidated tiers across the second wave

Cross-cutting the per-source subsections. Items flagged **CONVERGENT** appear in two or more independent sources (the merge test's ">=2 sources" half) and are the highest-confidence bets; the rest are uniquely user-noticeable within a single source.

**Tier 1 (cheap, local).**

| Item | Sources | HorizonCode target | Convergence |
|---|---|---|---|
| Fail-loud / self-documenting provider errors (stop defaulting to mock) | opencode §5.1, cline §5.2, codex §5.3, dsh §5.7 | `app/src/core/providers/index.ts` | CONVERGENT (4 sources) |
| Edit ladder sharpening: Unicode-fold pass + fuzzy threshold priors + up-to-5 closest-line previews | opencode §5.1, codex §5.3, oh-my-pi §5.4 | `app/src/tools/edit.ts` (extends NF-069) | CONVERGENT (3 sources) |
| Semantic repeat-call guard (soft/hard or `[3,5,8]` advisory) | cline §5.2, dsh §5.7 | `app/src/core/loop.ts` (extends NF-073) | CONVERGENT (2 sources) |
| Stable provider failure codes, route-on-code | codex §5.3, dsh §5.7 | `app/src/core/providers/index.ts`, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| Bash interceptor / command->tool redirection as a rule table | oh-my-pi §5.4, codex §5.3 (prompt-level) | `app/src/tools/shell.ts` (extends NF-074) | CONVERGENT (2 sources) |
| Per-request OS/shell in the shell tool description | opencode §5.1 | `app/src/tools/shell.ts` | single-source |

**Tier 2 (next wave).**

| Item | Sources | HorizonCode target | Convergence |
|---|---|---|---|
| Fail-closed sandbox + per-call escalation ladder + enforcement-completeness (`full`/`partial`) | dsh §5.7, Claude Code §5.6 (permission `auto`), codex §5.3 (OS layers) | `kernel/src/guard.rs`, `app/src/core/kernel.ts`, `app/src/contracts.ts` | CONVERGENT (3 sources) |
| `openai-compatible` adapter + user/data-driven provider registry | opencode §5.1, cline §5.2, dsh §5.7, codex §5.3 | `app/src/core/providers/`, `app/src/core/config.ts`, `app/src/contracts.ts` | CONVERGENT (4 sources) |
| Richer typed hook / tool-pipeline lifecycle (pre/post, allow/ask/deny) | dsh §5.7, Claude Code §5.6, cline §5.2 | `app/src/core/hooks.ts`, `app/src/tools/index.ts`, `app/src/core/loop.ts` | CONVERGENT (3 sources) |
| KV-cache-preserving prompt/tool updates (append, do not rewrite the prefix) | dsh §5.7 (`in-history`), opencode §5.1 (cache planner), codex §5.3 (retained-tool-output) | `app/src/core/loop.ts`, `app/src/core/providers/`, `app/src/contracts.ts` | CONVERGENT (3 sources) |
| `apply_patch` tool + model->tool routing for GPT/Codex models | cline §5.2, codex §5.3 | `app/src/tools/`, `app/src/tools/index.ts`, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| LSP post-edit diagnostics loop (writethrough + fresh-only ledger) | oh-my-pi §5.4 | new `app/src/core/lsp/`, `app/src/tools/edit.ts` | single-source (and a build-not-steal differentiator, see §5.10) |

**Tier 3 (strategic).**

| Item | Sources | HorizonCode target | Convergence |
|---|---|---|---|
| Per-call network egress authority (ask/allow/deny, parked connections, observe mode) | grok §5.5 (proxy), Claude Code §5.6 (bash allowlist + CI egress firewall) | new `kernel/` egress capability + `app/src/core/` client, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| Multi-dialect / provider-neutral tool + model layer | grok §5.5 (tool dialects), dsh §5.7 (provider-neutral seam) | `app/src/tools/index.ts`, `app/src/core/providers/`, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| External agents as one-shot subagents | dsh §5.7, Claude Code §5.6 (subagent model) | `app/src/core/subagent.ts`, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| Hashline edit anchors (address-level staleness + bounded shift recovery) | grok §5.5 | `app/src/tools/read.ts`, `app/src/tools/edit.ts` | single-source |
| Server mode + daemon recovery / Agent SDK surface | codex §5.3, Claude Code §5.6 | `app/src/main.ts`, `kernel/src/eventlog.rs`, `app/src/contracts.ts` | CONVERGENT (2 sources) |
| Memory retrieval + background consolidation | grok §5.5 | `app/src/core/curator.ts`, `app/src/core/review.ts` (extends NF-075) | single-source |

### 5.9 Register-candidate note (proposals only)

Following the §3 pattern, the items below MEET the merge test (>=2 independent sources OR uniquely user-noticeable) and are therefore the strongest candidates to propose as NEW register rows in a future revision. **These are PROPOSALS only.** Per status discipline they claim NO status (nothing above DESIGNED), and NO new NF numbers (NF-076+) are assigned here; the register stays closed until a revision adopts them. Where a candidate touches a wire/durable schema or a tool/provider interface, `app/src/contracts.ts` is the owner and must land the schema first.

- **Per-call network egress authority** - ask/allow/deny per origin, parked connections, observe-mode rollout (grok §5.5 + Claude Code §5.6). contracts.ts owns the egress wire/policy shape. Convergent.
- **Fail-closed sandbox + per-call escalation ladder** - `SANDBOX_UNAVAILABLE` never runs unconfined; one-call widen with justification; `full`/`partial` enforcement report (dsh §5.7 + Claude Code §5.6 + codex §5.3). Extends NF-016/NF-023. Convergent.
- **Open / data-driven provider list** - fail-loud unknown provider + `openai-compatible` adapter + user provider registry (opencode §5.1 + cline §5.2 + codex §5.3 + dsh §5.7). contracts.ts owns the provider/model schema. Convergent; directly closes the named closed-provider-list weakness.
- **Richer typed hook / tool-pipeline lifecycle** - named pre/post stages with allow/ask/deny and per-agent restriction (dsh §5.7 + Claude Code §5.6 + cline §5.2). contracts.ts owns the hook-event schema. Convergent.
- **Hashline edit anchors** - address-level staleness detection with bounded +-15-line shift recovery (grok §5.5). Uniquely user-noticeable; extends NF-069/052.
- **LSP post-edit diagnostics loop** - writethrough + fresh-only diagnostics ledger returned inline with the edit (oh-my-pi §5.4). Uniquely user-noticeable; see §5.10 (build-not-steal).

### 5.10 What not to copy (second wave)

Deliberate non-steals, consolidated from the three reports:

- **oh-my-pi's 16,207-line `agent-session.ts` monolith** and its unverifiable marketing metrics (72% pass, -61% tokens) - steal the mechanisms, not the sprawl; keep the H-7 metric contract (§1 already ruled the numbers NOT VERIFIABLE).
- **codex's full 128-crate breadth** (Bedrock/GCP/Windows-sandbox/realtime-voice/cloud-tasks) and its Responses-only `WireApi` lock-in - take the contracts (sandbox layering, execpolicy, exposure classes, self-documenting errors), keep HorizonCode's multi-wire support; do not adopt the single-wire constraint or the enterprise adapter matrix.
- **grok's generated monorepo `Cargo.toml`** and ~80-crate sprawl - take the mechanisms (egress, hashline, memory), not the crate explosion.
- **dsh's full Cordis framework dependency** - adopt the capability-seam contract and the loop/tool/guard mechanisms as native TS, not the Cordis runtime itself.
- **Claude Code's Bash-only sandbox scope** (the sandbox does not cover Read/Write/WebSearch/WebFetch/MCP) - adopt its network-allowlist shape, not its coverage gap; HorizonCode's kernel-enforced all-tool model is the stronger posture.
- **opencode's effect-TS + drizzle/SQLite rewrite and ~15k-line session monolith** - take the cache policy, decision API, edit engine, and compaction discipline, not the framework or the sprawl.
- **cline's VS Code host layer** (webview/hostbridge) - HorizonCode is a TUI; take the SDK-core patterns only.

**Build-not-steal differentiators.** Two of HorizonCode's weaknesses are things the competitors also lack, so they are opportunities to build a lead rather than copy: an OS-level sandbox (absent from opencode/cline/codex agent cores - opencode's `edit.ts` even carries a `// TODO: Add LSP ...` note; HorizonCode's Landlock direction per `docs/audit/landlock-spike-2026-11-08.md` is the differentiator) and a live post-edit LSP diagnostics loop (only oh-my-pi ships one among these seven; building HorizonCode's own closes a gap the others share).

---

## Related documents

- `audit/pass3/` — the four reports this shortlist consolidates (historical class)
- `29-final-audit.md` — the twelve-repo audit and its own queue
- `24-feature-catalog.md` — Section B rows `NF-071`…`NF-075` (adopted; RC-15(b)) and the `A.9` addendum these sources are recorded in
- `27-implementation-plan.md` — current build plan
- `research/steal-opencode-cline.md`, `research/steal-ohmypi-codex.md`, `research/steal-grok-claude-deepseek.md` - the three second-wave reports consolidated in §5 (opencode, cline, codex, oh-my-pi re-verified, grok-build, Claude Code SDK/docs, DeepSeek harness)
- `externals/{opencode,cline,codex,oh-my-pi,grok-build,claude-code,deepseek-harness}` - the seven clones cited as second-wave evidence paths
