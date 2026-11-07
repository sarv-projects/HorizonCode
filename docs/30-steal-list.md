# 30 — Adoption shortlist: the steal list and the action queue

> **Class: working queue (non-normative).** This document consolidates the four pass-3 deep dives — `audit/aider` (35 steal items), `audit/mini-swe-agent` (41), `audit/hermes-agent` (38), `audit/oh-my-pi` (28) — into one traceable shortlist, and ends with the ordered action queue. Every row cites its source report (§4 item numbers) where the full evidence path lives. Nothing here is a status claim; register candidates at the end are **proposed** for the next catalog revision.

---

## 0. Sources and the synthesis rule

| Repo | Clone | Report | Steal items | Core character |
|---|---|---|---|---|
| aider | `repo-tour/aider` @ `5dc9490` (714 files) | `docs/audit/pass3/audit-aider-report.md` | 35 | Git-native CLI; repo map + edit-format engineering |
| mini-swe-agent | `repo-tour/mini-swe-agent` @ `04d809c` (250 files, read exhaustively) | `docs/audit/pass3/audit-mini-swe-report.md` | 41 | The SOTA benchmark bash loop; ~190-line core |
| hermes-agent | `repo-tour/hermes-agent` @ `d4e7c343` (22,782 files) | `docs/audit/pass3/audit-hermes-report.md` | 38 | Managed persistent loop; growth machinery |
| oh-my-pi | `repo-tour/oh-my-pi` (10,321 files) | `docs/audit/pass3/audit-omp-deep-report.md` | 28 | Lean loop, claim-verified |

**Synthesis rule.** Consolidate by *mechanism family* (many items overlap across repos); keep every entry traceable to its report §4 number; mark each entry's disposition against the existing corpus (NF-### / doc / new candidate). The register stays closed until the candidates in §3 pass the normal revision.

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
| B-9 | Truncation with head/tail + `elided_chars` + remediation advice; 10 K guard in the observation template | mini 20 | extends R-tools-56 |

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

## 3. Register candidates (proposed for the next catalog revision)

Ready-to-paste titles; **not** yet Section B rows. Each passed the merge test (≥2 sources or uniquely user-noticeable) in the four reports.

| Proposed | Feature | Primary source | Notes |
|---|---|---|---|
| **NF-071** | Managed persistent runtime: owner/worker turn frames, durable admission FIFO with `unknown`, process ownership (spawn_owned + supervisor + lint) | hermes (C-12, D-1…D-3, D-6) | The "Managed VPS Loop" as a design; adopt contracts, not the 25-platform adapter matrix |
| **NF-072** | Per-tool concurrency classes and parallel batch execution (default shared, `exclusive` opt-out, last-exclusive barrier) | omp (C-6, claim-verified) | The one benchmark claim that is structurally confirmed; one optional field on the tool interface |
| **NF-073** | Loop safety rails: sentinel exit protocol, budget countdown in the prompt, consecutive format-error cap with its own exit status, charged failed turns, non-liftable wall clock | mini (C-2, C-4, C-5, B-8) | The industrialised form of our RC-7 + doc 08 loop rules |
| **NF-074** | Context-cost contracts: usage-anchored output-budget fit, framing tokens, spill-to-artifact defaults, shell-output minimisation and command interception | omp (B-6, B-7, C-7) | Direct per-turn token savings; pairs with NF-061 |
| **NF-075** | Growth loop v2: post-turn review fork on the warm cache, editorial standard for captured lessons, curator with archive-not-delete | hermes (G-1…G-4) | Extends NF-010/033; the editorial standard is the safety half |

Extend-only notes (no new row): repo-map ranking algorithm → doc 09; edit ladder detail → NF-052/069; cache addendum → NF-005; metric contract → doc 16; hostile read fixtures → doc 16.

New Section-A sources: **aider, mini-swe-agent and hermes-agent are sources 9–11** for the parity matrix; their rows are queued with the same per-row disposition requirement as the twelve-repo audit's queue (docs/29 §B.1(c)).

---

## 4. What to do — the action queue

Ordered by value ÷ effort. Items 1–5 are cheap, mostly local, and directly strengthen the existing v0.1; items 6–8 are the next capability wave; items 9–11 are process.

1. **Wire the loop safety rails (NF-073).** Charge failed turns, cap consecutive format errors with their own exit status, render the budget countdown, keep the sentinel exit protocol. Small diff to `loop.ts`/contracts; immediately improves long-run behaviour.
2. **Adopt per-tool concurrency classes + parallel batch (NF-072).** One optional field on the Tool interface; `shared` default, `exclusive` for edit/write/ask; barrier semantics. The confirmed oh-my-pi win.
3. **Upgrade the edit path (NF-069/052 extensions, A-1…A-5).** Escalating ladder (exact → indent-normalised → 3-way → line-patch), diff-shaped failure feedback with did-you-mean, bounded reflection slot, parity fixtures with byte-identical errors.
4. **Adopt the context-cost contracts (NF-074).** Output-budget fit with usage anchoring and framing charge; 3000-line/50 KiB caps with spill; shell minimiser + command interception (on by default).
5. **Adopt the repo-map algorithm (B-1)** — PageRank ranking + tuned weight table + binary-search budget; replaces guesswork in the existing `repo_map` tool.
6. **Build the managed runtime (NF-071).** Owner/worker frames + durable admission FIFO + `spawn_owned`/supervisor/lint. Adopt the contracts; skip the adapter matrix.
7. **Build the growth loop (NF-075).** Background-review fork with cache parity + editorial standard + curator; the safety half (editorial standard, read-before-write, description budget) lands *with* the fork, never after.
8. **Verification wave:** hostile read fixtures, evals-from-post-mortems, metric contract (H-7) on every published number, answer-isolation precondition on eval runs, test-model-in-library.
9. **Fold the register:** propose NF-071…075 through the next catalog revision (this document is the queue); add Section-A rows for aider/mini-swe-agent/hermes-agent as sources 9–11.
10. **Fold the extend-notes into their owners:** cache addendum (NF-005), edit-ladder detail (NF-052/069), metric contract (doc 16), git hygiene (E-1…E-4 → doc 09/05), observability (I-1…I-9 → doc 14).
11. **Record the four repos' defects** as reference-repo observations, not ours: aider's duplicated repo-map capture (~1.41× weight inflation), DeepSeek/Anthropic cache-cost arithmetic, `cur_tokens` double count; mini-swe-agent's three v1-leftover doc/fixture breaks; hermes' shallow-clone limitation; oh-my-pi's unstated metric contract and unasserted answer isolation.

### What *not* to copy (deliberate refusals)

- mini-swe-agent's "no compaction, no tools but bash" — deliberate for a benchmark, wrong for a product (its own report §5.4 says so).
- hermes' 25-platform gateway, full four-layer Windows identity, and profile multiplexing — take the contracts, not the adapters (its §5.3).
- aider's per-call-site `--dry-run` guards — the I/O-layer guard (its own item 32) is the correct form.
- omp's 15,853-line `agent-session.ts` monolith — steal the mechanisms, not the sprawl (its §5.2).

---

## Related documents

- `audit/pass3/` — the four reports this shortlist consolidates (historical class)
- `29-final-audit.md` — the twelve-repo audit and its own queue
- `24-feature-catalog.md` — Section B, where NF-071… candidates will land
- `27-implementation-plan.md` — current build plan
